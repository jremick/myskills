#!/usr/bin/env node
// Internal fixture only. Called by the canonical railway-images job, with its
// existing app images. No credentials or raw Docker/provider output are exported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { createSelfHostBundle } from "./lib/self-host-release.mjs";
import { hostBaselineCommit, resolveHostBaseline } from "./lib/self-host-baseline.mjs";
import { hostDocker, saveHostLedger } from "./lib/host-rehearsal-resources.mjs";
import { prepareHostBackupService, assertHostCommandSucceeded, observeHostPublication } from "./lib/host-backup-service.mjs";
import { captureHostDockerIdentity } from "./lib/host-backup-diagnostics.mjs";
import { inspectHostPlatformImage, pushHostPlatformImage, verifyHostPlatformManifest, fetchHostPlatformManifest } from "./lib/host-platform-receipt.mjs";
import { rehearseComposeClientInterruption, rehearseComposeInterruption } from "./lib/host-compose-interruption.mjs";

const baseline = hostBaselineCommit;
const root = process.cwd();
const [proofPath, ledgerPath, outputPath, candidate, runId] = process.argv.slice(2);
const proof = resolve(proofPath ?? ".");
const owner = `hc-${randomBytes(8).toString("hex")}`;
const resources = { schemaVersion: 1, owner, sequence: 0, resources: [] };
const receipt = { schemaVersion: 1, kind: "myskills-host-rehearsal", status: "failed", sourceCommit: candidate,
  baselineCommit: baseline, platform: "linux/amd64", executionMode: "native", publicImages: "not-established",
  arm64: "unverified", operatorUpgradeFromBaseline: "not-tested-no-baseline-operator-bundle", phases: {}, images: {} };
let phase = "preconditions";
let sequence = 0;
const executable = (spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4096 }).stdout ?? "").trim();
receipt.dockerIdentity = captureHostDockerIdentity(executable);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const privateEnv = (path, values) => {
  assert.ok(Object.values(values).every((value) => typeof value === "string" && !/['\\\n\r\0]/.test(value)));
  writeFileSync(path, Object.entries(values).map(([key, value]) => `${key}='${value}'\n`).join(""), { mode: 0o600 });
};
function call(command, args, { cwd = root, env = process.env, timeout = 600_000, maxBuffer = 4 * 1024 * 1024, killSignal = "SIGTERM", ok = true } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer, killSignal });
  if (ok) assertHostCommandSucceeded(command, args, result);
  return result;
}
function reserve(kind, name) {
  // The shim appends operator containers while this process waits for it.
  Object.assign(resources, JSON.parse(readFileSync(ledgerPath, "utf8")));
  resources.resources.push({ kind, name, state: "creating" }); saveHostLedger(ledgerPath, resources);
}
function mark(kind, name, state = "created") {
  Object.assign(resources, JSON.parse(readFileSync(ledgerPath, "utf8")));
  resources.resources.find((item) => item.kind === kind && item.name === name).state = state;
  saveHostLedger(ledgerPath, resources);
}
function docker(args, options, backupDiagnostic) {
  if (["run", "compose"].includes(args[0])) {
    const { ok = true, ...settings } = options ?? {};
    const result = hostDocker(ledgerPath, executable, args, { cwd: root, env: process.env, encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024, ...settings }, backupDiagnostic);
    if (ok) assertHostCommandSucceeded("docker", args, result);
    return result;
  }
  return call(executable, args, options);
}
function runService(suffix, args, image, tail = [], contract) {
  if (contract && suffix === "backup") receipt.backupInvocation = { category: "capture-unavailable" };
  const diagnostic = contract && suffix === "backup" ? { contract, record: value => { receipt.backupInvocation = value; } } : undefined;
  let id;
  try { id = docker(["run", "-d", "--label", `io.myskills.host-rehearsal.role=${suffix}`, ...args, image, ...tail], undefined, diagnostic).stdout.trim(); }
  catch (error) {
    const stage = { "restore-postgres": "restore-postgres-start", "restore-minio": "restore-minio-start", "restored-api": "restored-api-start" }[suffix];
    if (stage && error.hostFailure) error.hostFailure.stage = stage; throw error;
  }
  assert.match(id, /^[a-f0-9]{64}$/); return id;
}
async function measured(name, fn) {
  phase = name; const started = Date.now();
  const value = await fn(); receipt.phases[name] = { status: "passed", durationMs: Date.now() - started }; return value;
}
async function port() {
  const server = createServer(); await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const value = server.address().port; await new Promise((done) => server.close(done)); return String(value);
}
async function ready(url) {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (response.ok) return; } catch { /* bounded retry */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("readiness-deadline");
}
// Native Ubuntu must use the published loopback endpoint and this fixture CA.
async function readyBackupPublication(url, ca) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const ready = await new Promise(done => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
      const request = httpsRequest(new URL("/minio/health/ready", url), { ca, rejectUnauthorized: true, agent: false }, response => {
        response.destroy(); finish(response.statusCode === 200);
      });
      const timer = setTimeout(() => { request.destroy(); finish(false); }, Math.min(2000, until - Date.now()));
      request.once("error", () => finish(false)); request.end();
    });
    if (ready) return;
    await new Promise(done => setTimeout(done, Math.min(250, Math.max(0, until - Date.now()))));
  }
  throw new Error("backup-publication-readiness-deadline");
}
function inspect(image, role, check) {
  return inspectHostPlatformImage(docker, image, role, check);
}
function build(suffix, directory, args) {
  const tag = `${owner}/${suffix}:fixture`; reserve("image", tag);
  docker(["build", ...args, "--tag", tag, directory]); mark("image", tag); return tag;
}
async function publish(registry, name, image, source) {
  const tag = `${registry}/${owner}/${name}:fixture`; reserve("image", tag);
  docker(["tag", image, tag]); mark("image", tag); pushHostPlatformImage(docker, tag);
  const { bytes, headerDigest } = await fetchHostPlatformManifest(fetch, `http://${registry}/v2/${owner}/${name}/manifests/fixture`, name);
  const digest = `sha256:${hash(bytes)}`;
  const identity = inspect(tag, name, "inspect-before"); const ref = `${registry}/${owner}/${name}@${digest}`;
  reserve("image", ref);
  docker(["pull", "--platform", "linux/amd64", ref]); mark("image", ref);
  verifyHostPlatformManifest({ bytes, headerDigest, before: identity, after: inspect(ref, name, "inspect-after"), name, source });
  receipt.images[name] = { ref, imageId: identity.Id, platform: "linux/amd64", sourceLabels: name === "postgres" ? null : Object.fromEntries(["org.opencontainers.image.revision", "org.opencontainers.image.version"].map((key) => [key, identity.Config.Labels[key]])) };
  const file = `${name}-manifest.json`;
  const evidence = { schemaVersion: 1, kind: "oci-manifest", status: "passed", imageRef: ref, platformDigest: digest, platform: "linux/amd64",
    ...(name === "postgres" ? { upstreamVersion: "17-alpine" } : { labels: { "org.opencontainers.image.revision": source.commit, "org.opencontainers.image.version": source.version } }) };
  const evidenceBytes = `${JSON.stringify(evidence)}\n`; writeFileSync(join(proof, file), evidenceBytes);
  return { ref, platforms: [{ platform: "linux/amd64", digest, manifestEvidence: { file, sha256: hash(evidenceBytes) }, runtimeEvidence: null }] };
}
function pullPinned(tag) {
  reserve("upstream-image", tag); mark("upstream-image", tag, "retained-shared");
  docker(["pull", "--platform", "linux/amd64", tag]);
  const identity = inspect(tag, "upstream", "inspect-before"); const ref = identity.RepoDigests.find((item) => item.includes("@sha256:")); assert.ok(ref);
  // Shared upstream images are observed, not owned. A run-scoped alias is owned.
  const alias = `${owner}/upstream-${++sequence}:fixture`; reserve("image", alias);
  docker(["tag", ref, alias]); mark("image", alias);
  receipt.upstream ??= {}; receipt.upstream[tag] = { ref, imageId: identity.Id }; return ref;
}
function parsedEnv(path) {
  return Object.fromEntries(readFileSync(path, "utf8").trim().split("\n").map((line) => {
    const match = line.match(/^([^=]+)='([^']*)'$/); assert.ok(match); return [match[1], match[2]];
  }));
}
function compose(bundle, config, project, args) {
  return docker(["compose", "--project-name", project, "--file", join(bundle, "compose.yml"), "--env-file", join(bundle, "release.env"),
    "--env-file", join(config, "runtime.env"), ...args], { env: { ...process.env, MYSKILLS_CONFIG_DIR: config,
      MYSKILLS_BOOTSTRAP_ENV_FILE: join(config, "bootstrap.env"), MYSKILLS_BACKUP_ENV_FILE: join(config, "backup.env") } });
}
function operator(bundle, config, args, ok = true) {
  return call("sh", [join(bundle, "myskills.sh"), ...args, "--config-dir", config], { ok, env: { ...process.env, PATH: `${join(proof, "bin")}:${process.env.PATH}` } });
}
function operatorJson(bundle, config, args) {
  const result = operator(bundle, config, args);
  const lines = result.stdout.trim().split("\n");
  return JSON.parse(lines.findLast((line) => line.startsWith("{")));
}
function driver(image, args, config, ok = true, { network = "host", envFile } = {}) {
  const stage = { "backup-admin.json:bucket": "backup-bucket", "fresh.json:seed-nonowner": "fresh-nonowner", "fresh.json:create": "fresh-create",
    "fresh-composed.json:composed-storage": "fresh-composed-storage", "restore-network.json:host-ports": "restore-port-allocation",
    "restore-network.json:restore-ready": "restore-destinations-ready", "restored.json:api-ready": "restored-api-ready", "restored.json:verify": "restored-app-verify",
    "legacy.json:seed-nonowner": "legacy-nonowner", "legacy.json:create": "legacy-create", "upgraded.json:verify": "upgraded-app-verify" }[`${config}:${args[0]}`];
  assert.ok(stage, "fixture-driver-stage-required");
  try {
    if (network !== "host") {
      const project = network.replace(/_default$/, "");
      assert.ok(network === `${project}_default` && new RegExp(`^${owner}-(fresh|legacy)$`).test(project));
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
      assert.ok(ledger.owner === owner && ledger.resources.some(item => item.kind === "compose-project" && item.name === project && item.state === "created"));
      const rows = JSON.parse(docker(["network", "inspect", network], { maxBuffer: 128 * 1024 }).stdout);
      assert.ok(rows.length === 1 && rows[0].Name === network && /^[a-f0-9]{64}$/.test(rows[0].Id)
        && rows[0].Driver === "bridge" && rows[0].Labels?.["com.docker.compose.project"] === project && rows[0].Labels?.["com.docker.compose.network"] === "default");
    }
    const result = docker(["run", "--rm", "--label", "io.myskills.host-rehearsal.role=driver", "--network", network, ...(envFile ? ["--env-file", envFile] : []), "--user", `${process.getuid()}:${process.getgid()}`, "--mount", `type=bind,source=${proof},target=/proof`,
      image, "node", "/proof/fixture.mjs", ...args, `/proof/${config}`], { ok });
    if (ok && args[0] === "host-ports") {
      const { ports } = JSON.parse(readFileSync(join(proof, config)));
      assert.deepEqual(Object.keys(ports).sort(), ["api", "minio", "postgres"]);
      assert.ok(Object.values(ports).every(value => typeof value === "string" && /^[1-9][0-9]{3,4}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535));
      assert.equal(new Set(Object.values(ports)).size, 3);
    }
    return result;
  } catch (error) { error.hostFailure ??= { operation: "fixture.driver", reason: "bounded-check-failed" }; error.hostFailure.stage = stage; throw error; }
}
function ownedRestoreService(id, role, imageId, command, env = {}, ready = false) {
  try {
    assert.match(id, /^[a-f0-9]{64}$/);
    const rows = JSON.parse(docker(["container", "inspect", id], { maxBuffer: 128 * 1024 }).stdout); const row = rows[0];
    assert.ok(rows.length === 1 && row.Id === id && row.Image === imageId && row.Config?.Labels?.["io.myskills.host-rehearsal"] === owner
      && row.Config.Labels["io.myskills.host-rehearsal.role"] === role && row.State?.Status === "running" && row.State.Running === true
      && row.State.OOMKilled === false && row.RestartCount === 0 && row.HostConfig?.NetworkMode === "host" && row.HostConfig.PublishAllPorts === false
      && Object.keys(row.HostConfig.PortBindings ?? {}).length === 0);
    assert.deepEqual(row.Config.Cmd, command);
    for (const [key, value] of Object.entries(env)) assert.deepEqual(row.Config.Env.filter(item => item.startsWith(`${key}=`)), [`${key}=${value}`]);
    if (ready && role === "restore-postgres") docker(["exec", id, "sh", "-ec", '[ "$(cat /proc/1/comm)" = postgres ] && pg_isready -h 127.0.0.1 -p "$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null', "fixture-ready", command.at(-1)]);
  } catch (error) { error.hostFailure ??= { operation: "fixture.restore-service", reason: "bounded-check-failed" }; error.hostFailure.stage = `${role}-${ready ? "ready" : "identity"}`; throw error; }
}
function seedNonowner(image, config, project, dataFile) {
  const file = join(proof, `${project}-fixture-db.env`);
  const database = parsedEnv(join(config, "runtime.env")).DATABASE_URL;
  assert.ok(!/[\r\n$]/.test(database));
  writeFileSync(file, `DATABASE_URL=${database}\n`, { mode: 0o600 });
  driver(image, ["seed-nonowner"], dataFile, true, { network: `${project}_default`, envFile: file });
}
function composeProtectedInputs(bundle, config, project, backup = false) {
  const runtimePath = join(config, "runtime.env"), bootstrapPath = join(config, "bootstrap.env"), backupPath = join(config, "backup.env");
  const runtimeBytes = readFileSync(runtimePath, "utf8"), bootstrapBytes = readFileSync(bootstrapPath, "utf8");
  const runtime = parsedEnv(runtimePath), bootstrap = parsedEnv(bootstrapPath);
  const configuration = () => JSON.parse(compose(bundle, config, project, ["--profile", "bootstrap", "--profile", "operations", "config", "--format", "json"]).stdout);
  const model = configuration();
  // Compose config JSON doubles literal dollars for subsequent interpolation.
  assert.equal(model.services.api.environment.SMTP_PASSWORD, runtime.SMTP_PASSWORD.replaceAll("$", () => "$$"));
  assert.equal(model.services.bootstrap.environment.SEED_OWNER_PASSWORD, bootstrap.SEED_OWNER_PASSWORD.replaceAll("$", () => "$$"));
  if (backup) {
    const bytes = readFileSync(backupPath, "utf8"), values = parsedEnv(backupPath);
    assert.equal(model.services.ops.environment.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY, values.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY.replaceAll("$", () => "$$"));
    try {
      writeFileSync(backupPath, bytes.replace(/^MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY=.*$/m, () => `MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY=${values.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY}`));
      assert.notEqual(configuration().services.ops.environment.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY, values.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY.replaceAll("$", () => "$$"));
      assert.notEqual(operator(bundle, config, ["backup", "config"], false).status, 0);
    } finally { writeFileSync(backupPath, bytes); }
  } else {
    try {
      writeFileSync(runtimePath, runtimeBytes.replace(/^SMTP_PASSWORD=.*$/m, () => `SMTP_PASSWORD=${runtime.SMTP_PASSWORD}`));
      assert.notEqual(configuration().services.api.environment.SMTP_PASSWORD, runtime.SMTP_PASSWORD.replaceAll("$", () => "$$"));
      assert.notEqual(operator(bundle, config, ["preflight"], false).status, 0);
    } finally { writeFileSync(runtimePath, runtimeBytes); }
    try {
      writeFileSync(bootstrapPath, `${bootstrapBytes}NODE_OPTIONS=--inspect\n`);
      assert.notEqual(operator(bundle, config, ["bootstrap"], false).status, 0);
    } finally { writeFileSync(bootstrapPath, bootstrapBytes); }
  }
}

try {
  assert.equal(platform(), "linux"); assert.equal(arch(), "x64");
  assert.match(candidate, /^[a-f0-9]{40}$/); assert.match(runId, /^[a-z0-9-]{1,48}$/);
  assert.equal(call("git", ["rev-parse", "HEAD"]).stdout.trim(), candidate);
  assert.equal(call("git", ["status", "--porcelain"]).stdout, "");
  saveHostLedger(ledgerPath, resources);
  const baselineSource = resolveHostBaseline(root, join(proof, "baseline-source.git"));
  receipt.baselineSource = { commit: baselineSource.commit, mode: baselineSource.mode, publicSource: baselineSource.publicSource ?? null };
  mkdirSync(join(proof, "bin"));
  const shim = `#!${process.execPath}\nimport {hostDocker} from ${JSON.stringify(join(root, "scripts/lib/host-rehearsal-resources.mjs"))};\nconst r=hostDocker(${JSON.stringify(ledgerPath)},${JSON.stringify(executable)},process.argv.slice(2));process.exit(r.status??1);\n`;
  writeFileSync(join(proof, "bin/docker"), shim, { mode: 0o755 });
  copyFileSync(join(root, "scripts/lib/self-host-fixture.mjs"), join(proof, "fixture.mjs"));
  const source = { commit: candidate, version: JSON.parse(readFileSync(join(root, "package.json"))).version };
  const registryPort = await port();
  const registryRef = await measured("fixture-services", async () => {
    const registry = pullPinned("registry:3.1.2");
    runService("registry", ["-p", `127.0.0.1:${registryPort}:5000`, "--tmpfs", "/var/lib/registry", "-e", "OTEL_TRACES_EXPORTER=none"], registry);
    await ready(`http://127.0.0.1:${registryPort}/v2/`); return `127.0.0.1:${registryPort}`;
  });
  const postgresImage = pullPinned("postgres:17-alpine");
  await measured("compose-interruption", async () => {
    const project = `${owner}-interrupt`; reserve("compose-project", project);
    receipt.composeInterruption = await rehearseComposeInterruption({ directory: proof, owner, project, executable, image: postgresImage });
    // The supervised request acknowledged success and exact cleanup completed.
    mark("compose-project", project);
    const clientProject = `${owner}-interrupt-client`; reserve("compose-project", clientProject);
    receipt.composeInterruption.client = rehearseComposeClientInterruption({ directory: proof, owner, project: clientProject, executable, image: `myskills-app-api:local-ci-${runId}` });
    mark("compose-project", clientProject);
  });
  const backupUser = `fixture${randomBytes(6).toString("hex")}`;
  const backupPassword = `${randomBytes(32).toString("hex")}$HOST_INTERPOLATION_PROBE$$`;
  let minioImage;
  const backupService = await measured("backup-service", async () => {
    minioImage = build("minio", root, ["--file", join(root, "Dockerfile.minio"), "--label", `org.opencontainers.image.revision=${candidate}`,
      "--label", `org.opencontainers.image.version=${source.version}`]);
    return prepareHostBackupService({ proof, owner, image: minioImage, user: backupUser, password: backupPassword,
      reserve, mark, docker, call, runService, publicationObserver: context => observeHostPublication({ ...context, candidate, runId }) });
  });
  const { network } = backupService;
  await measured("backup-publication-tls", async () => readyBackupPublication(backupService.hostEndpoint, readFileSync(join(proof, "certs/public.crt"))));
  // Trust is scoped to this immutable fixture image; HTTPS validation remains on.
  const opsImage = await measured("backup-trust", async () => {
    writeFileSync(join(proof, "Dockerfile.trust"), `FROM myskills-ops:local-ci-${runId}\nCOPY --chmod=0444 certs/public.crt /fixture-ca.pem\nENV NODE_EXTRA_CA_CERTS=/fixture-ca.pem\n`);
    return build("ops-trust", proof, ["--file", join(proof, "Dockerfile.trust"), "--label", `org.opencontainers.image.revision=${candidate}`,
      "--label", `org.opencontainers.image.version=${source.version}`]);
  });
  receipt.fixtureTrust = "OPS image adds only a disposable CA; application images are reused unchanged.";
  const images = {};
  await measured("image-receipts-and-bundle", async () => {
    for (const [name, image] of Object.entries({ api: `myskills-app-api:local-ci-${runId}`, web: `myskills-app-web:local-ci-${runId}`,
      mcp: `myskills-app-mcp:local-ci-${runId}`, ops: opsImage, minio: minioImage, postgres: postgresImage })) images[name] = await publish(registryRef, name, image, source);
  });
  const inputFile = join(proof, "images.json"); jsonFile(inputFile, { schemaVersion: 1, source, images });
  const bundle = join(proof, "candidate"); createSelfHostBundle({ root, inputFile, outputDir: bundle });
  const bucket = `${owner}-backups`;
  // Bucket admin and recovery run with Docker host networking. Coordinated OPS
  // shares source MinIO networking, attached to this same owned backup bridge.
  // Both use its direct IP; published host loopback is a different namespace.
  const backupBase = { MYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT: backupService.endpoint, MYSKILLS_RECOVERY_BACKUP_S3_REGION: "local",
    MYSKILLS_RECOVERY_BACKUP_S3_BUCKET: bucket, MYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID: backupUser, MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY: backupPassword,
    MYSKILLS_RECOVERY_BACKUP_S3_FORCE_PATH_STYLE: "true" };
  // The fixture creates only this run's empty backup bucket, then exercises the
  // real runRegistryBackup publish/readback/completion-marker path.
  const admin = join(proof, "backup-admin.json"); jsonFile(admin, { ...backupBase });
  await measured("backup-bucket", async () => driver(opsImage, ["bucket"], "backup-admin.json"));
  await measured("fresh-install-and-recovery", async () => {
    const installStarted = Date.now();
    const config = join(proof, "fresh-config"); const project = `${owner}-fresh`; reserve("compose-project", project); mark("compose-project", project, "reserved");
    const webPort = await port(); const answers = join(proof, "answers.json");
    jsonFile(answers, { APP_BASE_URL: "https://fixture.operator.test", TRUST_PROXY: "false", AUTH_NOTIFICATION_MODE: "smtp", SMTP_HOST: "smtp.fixture.test",
      SMTP_FROM: "fixture@operator.test", SMTP_USER: "fixture", SMTP_PASSWORD: `${randomBytes(24).toString("hex")}$HOST_INTERPOLATION_PROBE$$`,
      SEED_OWNER_EMAIL: "owner@operator.test", SEED_OWNER_PASSWORD: randomBytes(32).toString("hex"), MYSKILLS_COMPOSE_PROJECT: project, WEB_PORT: webPort });
    operator(bundle, config, ["setup", "--answers-file", answers]); operator(bundle, config, ["preflight"]);
    composeProtectedInputs(bundle, config, project);
    operator(bundle, config, ["up"]);
    operator(bundle, config, ["bootstrap"]); operator(bundle, config, ["bootstrap"]); // retry must preserve the sole original owner
    const ownerCount = compose(bundle, config, project, ["exec", "-T", "postgres", "sh", "-ec", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM users"']).stdout.trim();
    assert.equal(ownerCount, "1"); receipt.ownerCount = 1;
    const bootstrap = parsedEnv(join(config, "bootstrap.env")); const runtime = parsedEnv(join(config, "runtime.env"));
    const dataFile = "fresh.json"; jsonFile(join(proof, dataFile), { api: "http://web:80/api", web: "http://web:80",
      ...bootstrap, expectedSource: source, fixtureName: "fresh", ...backupBase });
    await ready(`http://127.0.0.1:${webPort}/api/ready`);
    seedNonowner(images.api.ref, config, project, dataFile);
    driver(images.api.ref, ["create"], dataFile, true, { network: `${project}_default` });
    const data = JSON.parse(readFileSync(join(proof, dataFile)));
    const composedDatabase = runtime.DATABASE_URL;
    const composedEnv = join(proof, "fresh-composed-db.env"); assert.ok(!/[\r\n$]/.test(composedDatabase));
    writeFileSync(composedEnv, `DATABASE_URL=${composedDatabase}\n`, { mode: 0o600 });
    jsonFile(join(proof, "fresh-composed.json"), { ...data, api: "http://api:3001", web: null });
    driver(images.api.ref, ["composed-storage"], "fresh-composed.json", true, { network: `${project}_default`, envFile: composedEnv });
    const composedData = JSON.parse(readFileSync(join(proof, "fresh-composed.json")));
    receipt.composedArtifact = composedData.composedProof;
    Object.assign(data, composedData, { api: data.api, web: data.web }); jsonFile(join(proof, dataFile), data);

    receipt.freshInstallDurationMs = Date.now() - installStarted;
    receipt.freshInstall = { operatorPackage: "tested", ownerBootstrapRetries: "credential-preserving", sourceCommit: candidate,
      matchingApiWebIdentity: "passed", login: "passed", mfa: "passed", unauthorizedPackage: "denied", authProof: data.authProof, persisted: data.persistedBoundaries };
    const identity = data.instanceId; privateEnv(join(config, "backup.env"), { ...backupBase, MYSKILLS_BACKUP_INSTANCE_ID: identity });
    composeProtectedInputs(bundle, config, project, true);
    receipt.protectedComposeInputs = { quotedRuntimeAndBootstrapAndBackup: "exact-values", unquotedDollars: "rejected-before-quiescence", bootstrapExtraKey: "rejected-before-container" };
    const minio = compose(bundle, config, project, ["ps", "-q", "minio"]).stdout.trim(); docker(["network", "connect", network, minio]);
    compose(bundle, config, project, ["stop", "api", "web"]);
    const report = await measured("coordinated-backup", async () => operatorJson(bundle, config, ["backup", "execute"])); assert.equal(report.passed, true);
    receipt.backup = { runId: report.runId, instanceId: identity, coordinated: true, bucketScope: "isolated-fixture-only" };
    const networkFile = "restore-network.json"; jsonFile(join(proof, networkFile), {});
    driver(images.api.ref, ["host-ports"], networkFile);
    const { ports } = JSON.parse(readFileSync(join(proof, networkFile)));
    const pgUser = `restore_${randomBytes(8).toString("hex")}`, pgPassword = randomBytes(32).toString("hex");
    const pgCommand = ["postgres", "-c", "listen_addresses=127.0.0.1", "-p", ports.postgres];
    const minioCommand = ["server", "/data", "--address", `127.0.0.1:${ports.minio}`, "--console-address", "127.0.0.1:0"];
    const pgContainer = runService("restore-postgres", ["--network", "host", "-e", `POSTGRES_USER=${pgUser}`, "-e", `POSTGRES_PASSWORD=${pgPassword}`,
      "-e", "POSTGRES_DB=myskills_test", "--tmpfs", "/var/lib/postgresql/data"], postgresImage, pgCommand);
    const s3Container = runService("restore-minio", ["--network", "host", "--env-file", join(proof, "backup-minio.env")], minioImage, minioCommand);
    const destination = { MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL: `postgres://${pgUser}:${pgPassword}@127.0.0.1:${ports.postgres}/myskills_test`,
      MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT: `http://127.0.0.1:${ports.minio}`, MYSKILLS_RECOVERY_DESTINATION_S3_REGION: "local",
      MYSKILLS_RECOVERY_DESTINATION_S3_BUCKET: `${owner}-restore-request`, MYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID: backupUser,
      MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY: backupPassword, MYSKILLS_RECOVERY_DESTINATION_S3_FORCE_PATH_STYLE: "true" };
    const restoreFile = join(proof, "restore.env"); privateEnv(restoreFile, destination);
    const checkRestoreServices = (ready = false) => {
      ownedRestoreService(pgContainer, "restore-postgres", receipt.images.postgres.imageId, pgCommand, {}, ready);
      ownedRestoreService(s3Container, "restore-minio", receipt.images.minio.imageId, minioCommand);
    };
    checkRestoreServices();
    jsonFile(join(proof, networkFile), { ports, database: destination.MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL,
      storageEndpoint: destination.MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT, accessKeyId: backupUser, secretAccessKey: backupPassword });
    driver(images.api.ref, ["restore-ready"], networkFile);
    await measured("full-app-restore", async () => {
      checkRestoreServices(true);
      operator(bundle, config, ["recover", "execute", report.runId, "--target-env-file", restoreFile]);
      // The actual restore script picks new database/bucket names and retains a
      // protected destinations.json. Discover only within this owned config.
      const { readdirSync } = await import("node:fs");
      const dirs = readdirSync(config).filter((name) => /^myskills-recovery-/.test(name)); assert.equal(dirs.length, 1);
      const restored = JSON.parse(readFileSync(join(config, dirs[0], "destinations.json")));
      const restoredReport = JSON.parse(readFileSync(join(config, dirs[0], "report.json")));
      assert.equal(restoredReport.passed, true); assert.equal(restoredReport.restoredApplicationRuntime, "not-tested");
      const restoredEnv = { ...runtime, DATABASE_URL: `postgres://${pgUser}:${pgPassword}@127.0.0.1:${ports.postgres}/${restored.destinationDatabase}`,
        HOST: "127.0.0.1", PORT: ports.api, S3_ENDPOINT: `http://127.0.0.1:${ports.minio}`, S3_BUCKET: restored.destinationBucket,
        S3_ACCESS_KEY_ID: backupUser, S3_SECRET_ACCESS_KEY: backupPassword };
      writeFileSync(join(proof, "restored-api.env"), Object.entries(restoredEnv).map(([key, value]) => `${key}=${value}\n`).join(""), { mode: 0o600 });
      const apiCommand = ["node", "apps/api/dist/server.js"];
      const restoredApi = runService("restored-api", ["--network", "host", "--env-file", join(proof, "restored-api.env")], images.api.ref, apiCommand);
      jsonFile(join(proof, "restored.json"), { ...data, api: `http://127.0.0.1:${ports.api}`, web: null });
      driver(images.api.ref, ["api-ready"], "restored.json");
      ownedRestoreService(restoredApi, "restored-api", receipt.images.api.imageId, apiCommand, { HOST: "127.0.0.1", PORT: ports.api });
      driver(images.api.ref, ["verify"], "restored.json");
      receipt.backup.manifestSha256 = restoredReport.manifestSha256;
      const restoredData = JSON.parse(readFileSync(join(proof, "restored.json")));
      receipt.restore = { manifestSha256: restoredReport.manifestSha256, databaseDumpSha256: restoredReport.databaseDumpSha256,
        tableCount: restoredReport.tableCount, artifactCount: restoredReport.artifactCount, artifactBytes: restoredReport.artifactBytes,
        dataRestoreElapsedSeconds: restoredReport.elapsedSeconds, runId: report.runId, instanceId: identity, dataVerified: true, restoredApplicationRuntime: "tested",
        login: "passed", mfa: "passed", authProof: restoredData.authProof, unauthorizedPackage: "denied", exactPackageBytes: "passed", originalArchitecture: "passed", persisted: restoredData.persistedBoundaries };
      receipt.restore.packageSha256 = data.packageSha256; receipt.restore.packageBytes = data.packageBytes;
    });
  });
  await measured("baseline-build-and-upgrade", async () => {
    const legacy = join(proof, "baseline"); mkdirSync(legacy); const archive = join(proof, "baseline.tar");
    call("git", ["archive", "--format=tar", "--output", archive, baseline], { cwd: baselineSource.repository }); call("tar", ["-xf", archive, "-C", legacy]);
    const legacyVersion = JSON.parse(readFileSync(join(legacy, "package.json"))).version;
    const args = ["--label", `org.opencontainers.image.revision=${baseline}`, "--label", `org.opencontainers.image.version=${legacyVersion}`,
      "--build-arg", `MYSKILLS_BUILD_REVISION=${baseline}`];
    const oldApiTag = build("baseline-api", legacy, ["--file", join(legacy, "Dockerfile.api"), ...args]);
    const oldWebTag = build("baseline-web", legacy, ["--file", join(legacy, "Dockerfile.web"), "--build-arg", "VITE_API_BASE_URL=/api", ...args]);
    const oldSource = { commit: baseline, version: legacyVersion };
    const oldApi = (await publish(registryRef, "baseline-api", oldApiTag, oldSource)).ref;
    const oldWeb = (await publish(registryRef, "baseline-web", oldWebTag, oldSource)).ref;
    const bridge = join(proof, "baseline-compose"); mkdirSync(bridge);
    copyFileSync(join(bundle, "compose.yml"), join(bridge, "compose.yml"));
    writeFileSync(join(bridge, "release.env"), readFileSync(join(bundle, "release.env"), "utf8")
      .replace(images.api.ref, oldApi).replace(images.web.ref, oldWeb));
    const config = join(proof, "baseline-config"); const project = `${owner}-legacy`; reserve("compose-project", project); mark("compose-project", project, "reserved");
    const webPort = await port(); const answers = JSON.parse(readFileSync(join(proof, "answers.json")));
    jsonFile(join(proof, "legacy-answers.json"), { ...answers, MYSKILLS_COMPOSE_PROJECT: project, WEB_PORT: webPort });
    operator(bundle, config, ["setup", "--answers-file", join(proof, "legacy-answers.json")]);
    compose(bridge, config, project, ["up", "-d", "--wait", "postgres", "minio"]);
    compose(bridge, config, project, ["run", "--rm", "--no-deps", "minio-init"]);
    compose(bridge, config, project, ["run", "--rm", "--no-deps", "migrate"]);
    operator(bundle, config, ["bootstrap"]); // Explicit candidate tooling bridge; no seed data.
    compose(bridge, config, project, ["up", "-d", "--wait", "--no-deps", "api", "web"]);
    await ready(`http://127.0.0.1:${webPort}/api/ready`);
    jsonFile(join(proof, "legacy.json"), { api: "http://web:80/api", web: "http://web:80", fixtureName: "legacy",
      ...parsedEnv(join(config, "bootstrap.env")), expectedSource: { commit: baseline, version: legacyVersion } });
    seedNonowner(images.api.ref, config, project, "legacy.json");
    driver(images.api.ref, ["create"], "legacy.json", true, { network: `${project}_default` });
    const data = JSON.parse(readFileSync(join(proof, "legacy.json")));
    const minio = compose(bridge, config, project, ["ps", "-q", "minio"]).stdout.trim(); docker(["network", "connect", network, minio]);
    privateEnv(join(config, "backup.env"), { ...backupBase, MYSKILLS_BACKUP_INSTANCE_ID: data.instanceId });
    const upgradeStarted = Date.now();
    compose(bridge, config, project, ["stop", "api", "web"]);
    const before = operatorJson(bundle, config, ["backup", "execute"]); assert.equal(before.passed, true);
    // c74ecd33 predates the operator package. Use exact legacy runtime plus the
    // canonical target migrate/start sequence; do not invent old source receipts.
    operator(bundle, config, ["up"]);
    await ready(`http://127.0.0.1:${webPort}/api/ready`);
    jsonFile(join(proof, "upgraded.json"), { ...data, expectedSource: source }); driver(images.api.ref, ["verify"], "upgraded.json", true, { network: `${project}_default` });
    receipt.upgrade = { durationMs: Date.now() - upgradeStarted, baselineCommit: baseline, candidateCommit: candidate, sourceAppImages: { api: inspect(oldApi).Id, web: inspect(oldWeb).Id },
      kind: "exact-source-database-and-runtime-transition", backupRunId: before.runId, forwardMigrations: "passed", originalIdentity: "passed",
      originalLoginMfaPermissionsAndBytes: "passed", authProof: JSON.parse(readFileSync(join(proof, "upgraded.json"))).authProof,
      legacyBootstrapTooling: "candidate-fresh-only-bridge", operatorPackageUpgrade: "not-tested" };
  });
  receipt.status = "passed";
  receipt.boundaries = ["No production data, public publication, deployment, public TLS/email delivery or arm64 runtime proof.",
    "Legacy c74ecd33 predates the operator bundle. Its migration/runtime transition uses candidate setup/bootstrap tooling and exact baseline app images.",
    "A historical baseline operator bundle is required to claim the complete package-to-package upgrade command."];
} catch (error) {
  if (error.hostFailure) receipt.failure = error.hostFailure;
  else if (error.hostPlatformFailure) receipt.failure = error.hostPlatformFailure;
  else receipt.failure = { operation: "fixture.assertion", reason: "bounded-check-failed" };
  receipt.phases[phase] = { ...receipt.phases[phase], status: "failed" };
  receipt.failedPhase = phase; receipt.guidance = "Inspect canonical sanitized step status and child resource ledger; raw provider output and credentials are withheld.";
  process.exitCode = 1;
} finally {
  jsonFile(outputPath, receipt);
  console.log(JSON.stringify({ kind: receipt.kind, status: receipt.status, failedPhase: receipt.failedPhase ?? null, failure: receipt.failure ?? null }));
}
