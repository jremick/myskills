#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const digestRef = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const imageNames = ["api", "web", "mcp", "ops", "minio", "postgres"];
const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{16}$/;
const runtimeKeys = ["NODE_ENV", "PORT", "DATABASE_URL", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "AUTH_SECRET", "APP_BASE_URL", "VITE_API_BASE_URL", "ALLOWED_WEB_ORIGINS", "TRUST_PROXY", "AUTH_NOTIFICATION_MODE", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_REQUIRE_TLS", "SMTP_TLS_REJECT_UNAUTHORIZED", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "RESEND_API_KEY", "RESEND_FROM", "ARTIFACT_STORAGE_MODE", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE", "S3_ALLOW_INSECURE_ENDPOINT", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MYSKILLS_COMPOSE_PROJECT", "WEB_PORT", "MYSKILLS_ENABLE_MCP", "MYSKILLS_MCP_HOST", "MYSKILLS_MCP_PORT", "MYSKILLS_MCP_ALLOWED_HOSTS", "MYSKILLS_MCP_ALLOWED_ORIGINS", "MYSKILLS_API_URL", "MCP_PROXY_TARGET"];
const answerKeys = ["APP_BASE_URL", "VITE_API_BASE_URL", "TRUST_PROXY", "AUTH_NOTIFICATION_MODE", "SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "RESEND_API_KEY", "RESEND_FROM", "SEED_OWNER_EMAIL", "SEED_OWNER_PASSWORD", "MYSKILLS_COMPOSE_PROJECT", "WEB_PORT", "MYSKILLS_ENABLE_MCP", "MYSKILLS_MCP_ALLOWED_HOSTS", "MYSKILLS_MCP_ALLOWED_ORIGINS"];
const backupKeys = ["MYSKILLS_BACKUP_INSTANCE_ID", ...["ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "FORCE_PATH_STYLE"].map((key) => `MYSKILLS_RECOVERY_BACKUP_S3_${key}`), "MYSKILLS_RECOVERY_MAXIMUM_BYTES", "MYSKILLS_RECOVERY_TIMEOUT_MS"];
const destinationKeys = ["MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL", ...["ENDPOINT", "REGION", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY", "SESSION_TOKEN", "FORCE_PATH_STYLE"].map((key) => `MYSKILLS_RECOVERY_DESTINATION_S3_${key}`)];

class OperatorError extends Error {}
function fail(message) { throw new OperatorError(message); }
function options(input) {
  const [command, ...rest] = input; const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z-]+$/.test(rest[i] ?? "") || !rest[i + 1] || Object.hasOwn(values, rest[i].slice(2))) fail("invalid configuration arguments.");
    values[rest[i].slice(2)] = rest[i + 1];
  }
  const allowed = ["bundle", "config-dir", "answers-file", "platform", "target-bundle", "status", "phase", "report-file", "target-env-file", "run-id", "observations-file", "backup-state", "instance-id", "attach-upgrade-receipt"];
  if (Object.keys(values).some((key) => !allowed.includes(key))) fail("unknown configuration option.");
  return { command, ...values };
}
async function main() {
  if (process.argv[2] === "--help") {
    console.log("Container-only configuration helper. Use the checksummed release bundle's myskills.sh."); return;
  }
  const args = options(process.argv.slice(2));
  if (!["setup", "validate", "metadata", "startup-check", "startup-fence", "resume-active", "migration-barrier", "status", "bootstrap-check", "backup-config", "backup-report", "upgrade-check", "receipt", "record-active", "recovery-check", "recovery-execute"].includes(args.command)) fail("unknown configuration command.");
  if (!isAbsolute(args.bundle ?? "") || !isAbsolute(args["config-dir"] ?? "")) fail("bundle and config directory must be absolute.");
  const bundle = verifyBundle(args.bundle, args.platform); const configDir = args["config-dir"];
  protectedDirectory(configDir);
  if (args.command === "setup") return setup(configDir, bundle, args["answers-file"]);
  const runtime = readEnv(join(configDir, "runtime.env"), runtimeKeys);
  validateRuntime(runtime); const state = readJson(join(configDir, "state.json"), true);
  const barrierPath = join(configDir, "migration-barrier.json");
  const barrier = existsSync(barrierPath) ? readJson(barrierPath, true) : null;
  if (barrier && (barrier.schemaVersion !== 1 || !sameState(barrier.source, state) && !sameState(barrier.target, state))) fail("migration barrier does not match managed state; preserve it and inspect recovery guidance.");
  // A target retry can finish startup after migration while state still names the
  // source. Only the exact target's source AND immutable images can pass.
  const targetRetry = barrier && sameState(barrier.target, activeState(bundle)) && sameState(barrier.source, state);
  const sourceCoordinator = barrier && sameState(barrier.source, activeState(bundle)) && sameState(barrier.target, state)
    && ["receipt", "record-active", "backup-report"].includes(args.command) && existsSync(join(configDir, "operation.lock"));
  if (!sameState(state, activeState(bundle)) && !targetRetry && !sourceCoordinator) fail("active release differs from this bundle; use the active release helper.");
  if (args.command === "startup-check") {
    if (barrier && !sameState(barrier.target, activeState(bundle))) fail("forward migration has started; only the exact target bundle can start applications. Use the target helper or isolated recovery.");
    return;
  }
  if (args.command === "startup-fence") {
    if (barrier) {
      if (!sameState(barrier.target, activeState(bundle)) || !existsSync(join(configDir, "operation.lock"))) fail("retry migration requires the exact target and operation lock.");
      atomicJson(barrierPath, barrier);
      atomicJson(join(configDir, "state.json"), activeState(bundle));
    }
    return;
  }
  if (args.command === "resume-active") {
    if (barrier) {
      if (!sameState(barrier.target, activeState(bundle)) || !existsSync(join(configDir, "operation.lock"))) fail("startup can record only the exact migration target while holding its operation lock.");
      atomicJson(join(configDir, "state.json"), activeState(bundle));
      const receiptPath = join(configDir, "upgrade-receipt.json");
      const receipt = readJson(receiptPath, true);
      atomicJson(receiptPath, { ...receipt, status: "passed", phase: "resumed-startup", updatedAt: new Date().toISOString() });
    }
    return;
  }
  if (args.command === "metadata") { console.log(`${runtime.MYSKILLS_COMPOSE_PROJECT}\n${runtime.MYSKILLS_ENABLE_MCP}\n${bundle.source.commit}\n${bundle.source.version}`); return; }
  if (args.command === "status") {
    const observations = safeFile(args["observations-file"], true).trim().split("\n"); const images = {};
    for (const name of imageNames) images[name] = { expectedRef: bundle.images[name].ref, actualRef: null, health: name === "ops" ? "tool" : name === "mcp" && runtime.MYSKILLS_ENABLE_MCP !== "true" ? "disabled" : "unavailable" };
    for (const line of observations.filter(Boolean)) {
      const [name, ref, health, extra] = line.split(" ");
      if (!imageNames.includes(name) || name === "ops" || extra || !digestRef.test(ref) || !["healthy", "unhealthy", "unavailable"].includes(health)) fail("runtime observation format is invalid.");
      if (images[name].health !== "disabled") images[name] = { expectedRef: bundle.images[name].ref, actualRef: ref, health };
    }
    let backup = { state: args["backup-state"] === "not-configured" ? "not-configured" : "error", capturedAt: null, runId: null };
    if (args["report-file"]) {
      try {
        const report = readJson(args["report-file"], true);
        if (report.reason === "missing-completed-backup") backup.state = "missing";
        else if (["current", "stale"].includes(report.reason) && runIdPattern.test(report.runId) && validTimestamp(report.capturedAt)) backup = { state: report.reason, capturedAt: report.capturedAt, runId: report.runId };
      } catch { /* A failed provider probe remains a bounded error receipt. */ }
    }
    console.log(JSON.stringify({ schemaVersion: 1, kind: "myskills-operator-status", capturedAt: new Date().toISOString(), source: bundle.source, images, backup })); return;
  }
  if (args.command === "validate") { console.log("Configuration and bundle integrity checks passed. Publisher authenticity and running service readiness require separate proof."); return; }
  if (args.command === "bootstrap-check") { validateBootstrap(readEnv(join(configDir, "bootstrap.env"), ["SEED_OWNER_EMAIL", "SEED_OWNER_PASSWORD"])); return; }
  if (args.command === "backup-config") { const backup = validateBackup(configDir, runtime); if (args["instance-id"] && backup.MYSKILLS_BACKUP_INSTANCE_ID !== args["instance-id"]) fail("backup namespace differs from the exact migrated database instance identity."); console.log("Protected external HTTPS backup configuration passed. Run backup execute and verify its completion; configuration alone does not prove durable storage."); return; }
  if (args.command === "backup-report") {
    const report = readJson(args["report-file"], true); if (typeof report.passed !== "boolean") fail("backup result is missing a completion result.");
    if (report.runId && !runIdPattern.test(report.runId)) fail("backup result has an invalid run ID.");
    const safe = { passed: report.passed, ...(report.runId ? { runId: report.runId } : {}), ...(typeof report.fresh === "boolean" ? { fresh: report.fresh } : {}) };
    if (args["attach-upgrade-receipt"] === "true" && existsSync(join(configDir, "operation.lock")) && report.passed && report.runId) {
      const receipt = readJson(join(configDir, "upgrade-receipt.json"), true);
      if (receipt.status !== "in-progress" || receipt.phase !== "backup-current") fail("backup cannot attach to an unrelated upgrade receipt.");
      receipt.backupRunId = report.runId;
      atomicJson(join(configDir, "upgrade-receipt.json"), receipt);
    }
    console.log(JSON.stringify(safe)); if (!report.passed) process.exitCode = 1; return;
  }
  if (["recovery-check", "recovery-execute"].includes(args.command)) {
    const backup = validateBackup(configDir, runtime);
    const target = readEnv(args["target-env-file"], destinationKeys);
    if (!runIdPattern.test(args["run-id"] ?? "")) fail("restore requires a completed backup run ID.");
    const database = url(target.MYSKILLS_RECOVERY_DESTINATION_POSTGRES_URL, ["postgres:", "postgresql:"]);
    const storage = url(target.MYSKILLS_RECOVERY_DESTINATION_S3_ENDPOINT, ["http:", "https:"]);
    if (![database.hostname, storage.hostname].every(loopback) || !database.pathname.slice(1) || !target.MYSKILLS_RECOVERY_DESTINATION_S3_BUCKET
      || !target.MYSKILLS_RECOVERY_DESTINATION_S3_ACCESS_KEY_ID || !target.MYSKILLS_RECOVERY_DESTINATION_S3_SECRET_ACCESS_KEY
      || target.MYSKILLS_RECOVERY_DESTINATION_S3_BUCKET === runtime.S3_BUCKET) fail("restore requires new empty loopback database and object bucket destinations.");
    if (args.command === "recovery-check") { console.log("Restore configuration passed. The recovery tool will independently refuse non-empty destinations."); return; }
    const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/restore-registry-backup.mjs");
    const result = spawnSync(process.execPath, [script, "--execute", args["run-id"]], { env: { ...backup, ...target, PATH: process.env.PATH,
      MYSKILLS_RECOVERY_OUTPUT_PARENT: configDir,
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}) }, encoding: "utf8", timeout: 1_801_000, maxBuffer: 1024 * 1024 });
    let report; try { report = JSON.parse(result.stdout?.split("\n")[0]); } catch { /* A missing receipt remains a failure. */ }
    if (result.status !== 0 || report?.passed !== true || report.runId !== args["run-id"]) fail("guarded restore failed; preserve protected recovery evidence and inspect the recovery runbook.");
    console.log(JSON.stringify({ passed: true, runId: report.runId })); return;
  }
  if (!isAbsolute(args["target-bundle"] ?? "")) fail("an absolute target bundle path is required.");
  const target = verifyBundle(args["target-bundle"], args.platform);
  if (args.command === "upgrade-check") {
    validateBackup(configDir, runtime);
    if (compareVersions(target.source.version, bundle.source.version) <= 0 || target.source.commit === bundle.source.commit) fail("target must be a newer release with a different source commit; downgrade and same-release replacement are refused.");
    if (target.images.postgres.ref !== bundle.images.postgres.ref || target.images.minio.ref !== bundle.images.minio.ref) fail("storage image changes require a separate reviewed storage upgrade.");
    console.log("Target integrity, forward version, platform and storage compatibility checks passed."); return;
  }
  if (args.command === "migration-barrier") {
    const receipt = readJson(join(configDir, "upgrade-receipt.json"), true);
    if (!existsSync(join(configDir, "operation.lock")) || receipt.status !== "in-progress" || receipt.phase !== "migrate-target"
      || receipt.target?.commit !== target.source.commit || !runIdPattern.test(receipt.backupRunId ?? "")) fail("migration requires an operation lock and completed upgrade backup receipt.");
    // Record the barrier first so a crash between writes remains retryable,
    // including a second upgrade that replaces an earlier barrier. Then fence
    // older helpers that know only state.json before any target SQL can commit.
    atomicJson(barrierPath, { schemaVersion: 1, source: activeState(bundle), target: activeState(target), backupRunId: receipt.backupRunId, startedAt: new Date().toISOString() });
    atomicJson(join(configDir, "state.json"), activeState(target));
    return;
  }
  if (args.command === "record-active") {
    atomicJson(join(configDir, "state.json"), activeState(target)); console.log("Active bundle recorded. Continue with that bundle's helper."); return;
  }
  if (args.command === "receipt") {
    if (!["in-progress", "failed", "passed"].includes(args.status) || !/^[a-z-]{1,40}$/.test(args.phase ?? "")) fail("invalid upgrade receipt status or phase.");
    const path = join(configDir, "upgrade-receipt.json");
    const previous = existsSync(path) ? readJson(path, true) : {};
    const same = previous.target?.commit === target.source.commit && previous.status === "in-progress";
    atomicJson(path, { schemaVersion: 1, status: args.status, phase: args.phase, source: bundle.source, target: target.source,
      forwardOnly: true, recovery: "Restore a completed coordinated backup to new empty loopback destinations; no automatic downgrade.",
      ...(same && previous.backupRunId ? { backupRunId: previous.backupRunId } : {}), updatedAt: new Date().toISOString() }); return;
  }
}

function protectedDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) fail("config directory must be owned by the operator, mode 0700 and not a symlink.");
}
function safeFile(path, privateFile = false) {
  if (!path || !isAbsolute(path)) fail("file paths must be absolute.");
  // Validate and read the same opened inode. NOFOLLOW protects the final
  // component; this does not defend against hostile ancestor replacement.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const limit = 1024 * 1024;
    if (!stat.isFile() || stat.size > limit || (privateFile && ((stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())))) fail("protected files must be owned by the operator, mode 0600 and not symlinks.");
    const bytes = Buffer.alloc(limit + 1); let size = 0, count;
    while (size < bytes.length && (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += count;
    if (size > limit) fail("protected file exceeds the size limit.");
    return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}
function readJson(path, privateFile = false) { return JSON.parse(safeFile(path, privateFile)); }
function readEnv(path, keys, privateFile = true) {
  const result = {};
  for (const raw of safeFile(path, privateFile).split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    const match = raw.match(/^([A-Z][A-Z0-9_]*)=(?:'([^'\\]*)'|([^'"\\\s]*))$/);
    if (!match || !keys.includes(match[1]) || Object.hasOwn(result, match[1]) || match[3]?.includes("$")) fail("environment file has unsupported keys, duplicates or quoting; single-quote dollar-bearing values.");
    result[match[1]] = match[2] ?? match[3];
  }
  return result;
}
function verifyBundle(path, platform) {
  const checksums = new Map();
  for (const line of safeFile(join(path, "SHA256SUMS")).trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) {2}([A-Za-z0-9._/-]+)$/);
    if (!match || match[2].split("/").some((part) => ["", ".", ".."].includes(part)) || checksums.has(match[2])) fail("bundle checksum paths are invalid.");
    const file = join(path, match[2]);
    if (createHash("sha256").update(safeFile(file)).digest("hex") !== match[1]) fail("bundle checksum verification failed.");
    checksums.set(match[2], match[1]);
  }
  for (const name of ["compose.yml", "myskills.sh", ".env.example", ".env.bootstrap.example", "release.env", "release-manifest.json"]) if (!checksums.has(name)) fail("bundle checksum inventory is incomplete.");
  const publicKeys = [...imageNames.map((name) => `MYSKILLS_${name.toUpperCase()}_IMAGE`), "MYSKILLS_SOURCE_COMMIT", "MYSKILLS_VERSION"];
  const env = readEnv(join(path, "release.env"), publicKeys, false); const manifest = readJson(join(path, "release-manifest.json"));
  if (Object.keys(manifest).sort().join() !== ["schemaVersion", "source", "images"].sort().join() || Object.keys(manifest.source ?? {}).sort().join() !== "commit,version"
    || manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? "") || !versionParts(manifest.source?.version)
    || manifest.source.commit !== env.MYSKILLS_SOURCE_COMMIT || manifest.source.version !== env.MYSKILLS_VERSION
    || Object.keys(manifest.images ?? {}).sort().join() !== imageNames.toSorted().join()) fail("release manifest source, schema or image inventory is invalid.");
  for (const name of imageNames) {
    const image = manifest.images[name];
    if (!digestRef.test(image.ref ?? "") || image.ref !== env[`MYSKILLS_${name.toUpperCase()}_IMAGE`] || !Array.isArray(image.platforms)
      || image.platforms.length < 1 || image.platforms.length > 2 || new Set(image.platforms.map((item) => item.platform)).size !== image.platforms.length) fail("release image references must be matching immutable digests.");
    for (const item of image.platforms) {
      if (!["linux/amd64", "linux/arm64"].includes(item.platform) || !/^sha256:[a-f0-9]{64}$/.test(item.digest ?? "")) fail("image platform metadata is invalid.");
      for (const evidence of [item.manifestEvidence, ...(item.runtimeEvidence ? [item.runtimeEvidence] : [])]) {
        if (!evidence || checksums.get(evidence.file) !== evidence.sha256) fail("image evidence must refer to checksum-verified bundle files.");
        const proof = readJson(join(path, evidence.file));
        const kind = evidence === item.manifestEvidence ? "oci-manifest" : "container-runtime";
        if (proof.schemaVersion !== 1 || proof.status !== "passed" || proof.kind !== kind || proof.imageRef !== image.ref
          || proof.platformDigest !== item.digest || proof.platform !== item.platform) fail("image evidence identity, platform or result differs from the release.");
        if (kind === "oci-manifest") {
          if (name === "postgres" ? proof.upstreamVersion !== "17-alpine"
            : proof.labels?.["org.opencontainers.image.revision"] !== manifest.source.commit || proof.labels?.["org.opencontainers.image.version"] !== manifest.source.version) fail("image evidence source labels differ from the release.");
        } else if (!["native", "emulated"].includes(proof.executionMode) || !["linux/amd64", "linux/arm64"].includes(proof.hostPlatform)
          || (proof.executionMode === "native") !== (proof.hostPlatform === item.platform)) fail("image runtime evidence must distinguish native and emulated execution.");
      }
    }
    if (platform && !image.platforms.some((item) => item.platform === platform)) fail("release does not contain images for the operator Docker platform.");
  }
  return manifest;
}
function versionParts(value) { const match = typeof value === "string" && value.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/); return match ? match.slice(1).map((item, index) => item === undefined && index === 3 ? Number.MAX_SAFE_INTEGER : Number(item)) : null; }
function compareVersions(a, b) { const first = versionParts(a); const second = versionParts(b); if (!first || !second) fail("release version must use x.y.z or x.y.z-beta.n."); for (let index = 0; index < 4; index++) if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1; return 0; }
function url(value, protocols) { let parsed; try { parsed = new URL(value); } catch { fail("a required URL is invalid."); } if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.username && !parsed.protocol.startsWith("postgres") || parsed.hash || parsed.search) fail("a URL has unsupported protocol, credentials, query or fragment."); return parsed; }
function loopback(host) { return ["127.0.0.1", "localhost", "[::1]"].includes(host); }
function validTimestamp(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function sameState(a, b) {
  return a?.schemaVersion === 1 && b?.schemaVersion === 1 && a.source?.commit === b.source?.commit && a.source?.version === b.source?.version
    && imageNames.every((name) => a.images?.[name] === b.images?.[name]);
}
function activeState(bundle) { return { schemaVersion: 1, source: bundle.source, images: Object.fromEntries(imageNames.map((name) => [name, bundle.images[name].ref])) }; }
function envBytes(values) { return Object.entries(values).map(([key, value]) => { if (typeof value !== "string" || /['\\\r\n\0]/.test(value)) fail("values must be strings without newline, backslash or single quote."); return `${key}='${value}'\n`; }).join(""); }
function atomicJson(path, value) {
  if (existsSync(path)) safeFile(path, true);
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

async function setup(configDir, bundle, answersPath) {
  for (const file of ["runtime.env", "bootstrap.env", "state.json"]) if (existsSync(join(configDir, file))) fail("setup refuses to overwrite existing configuration; retain the existing credentials.");
  const answers = answersPath ? readJson(answersPath, true) : await interactiveAnswers();
  if (!answers || Array.isArray(answers) || Object.keys(answers).some((key) => !answerKeys.includes(key)) || Object.values(answers).some((value) => typeof value !== "string")) fail("answers JSON must contain only the documented string fields.");
  if (answers.VITE_API_BASE_URL && answers.VITE_API_BASE_URL !== "/api") fail("the immutable web image uses /api; a different web API route requires a separate image build.");
  const password = randomBytes(32).toString("hex"); const minioPassword = randomBytes(32).toString("hex");
  const runtime = { NODE_ENV: "production", PORT: "3001", POSTGRES_DB: "myskills", POSTGRES_USER: "myskills", POSTGRES_PASSWORD: password,
    DATABASE_URL: `postgres://myskills:${password}@postgres:5432/myskills`, AUTH_SECRET: randomBytes(48).toString("hex"),
    APP_BASE_URL: answers.APP_BASE_URL, VITE_API_BASE_URL: "/api", ALLOWED_WEB_ORIGINS: answers.APP_BASE_URL,
    TRUST_PROXY: answers.TRUST_PROXY, AUTH_NOTIFICATION_MODE: answers.AUTH_NOTIFICATION_MODE,
    ARTIFACT_STORAGE_MODE: "s3", S3_ENDPOINT: "http://minio:9000", S3_REGION: "local", S3_BUCKET: "myskills-artifacts",
    S3_ACCESS_KEY_ID: "myskills", S3_SECRET_ACCESS_KEY: minioPassword, MINIO_ROOT_USER: "myskills", MINIO_ROOT_PASSWORD: minioPassword,
    S3_FORCE_PATH_STYLE: "true", S3_ALLOW_INSECURE_ENDPOINT: "true", WEB_PORT: answers.WEB_PORT || "3000",
    MYSKILLS_COMPOSE_PROJECT: answers.MYSKILLS_COMPOSE_PROJECT || `myskills-${randomBytes(5).toString("hex")}`,
    MYSKILLS_ENABLE_MCP: answers.MYSKILLS_ENABLE_MCP || "false", MYSKILLS_MCP_HOST: "0.0.0.0", MYSKILLS_MCP_PORT: "3002",
    MYSKILLS_MCP_ALLOWED_HOSTS: answers.MYSKILLS_MCP_ALLOWED_HOSTS || "mcp-http:3002", MYSKILLS_MCP_ALLOWED_ORIGINS: answers.MYSKILLS_MCP_ALLOWED_ORIGINS || answers.APP_BASE_URL,
    MCP_PROXY_TARGET: answers.MYSKILLS_ENABLE_MCP === "true" ? "http://mcp-http:3002" : "http://127.0.0.1:3002",
    MYSKILLS_API_URL: "http://api:3001", SMTP_SECURE: answers.SMTP_PORT === "465" ? "true" : "false", SMTP_REQUIRE_TLS: "true", SMTP_TLS_REJECT_UNAUTHORIZED: "true" };
  for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM", "SMTP_USER", "SMTP_PASSWORD", "RESEND_API_KEY", "RESEND_FROM"]) if (answers[key]) runtime[key] = answers[key];
  const bootstrap = { SEED_OWNER_EMAIL: answers.SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD: answers.SEED_OWNER_PASSWORD };
  validateBootstrap(bootstrap);
  const runtimeBytes = envBytes(runtime); const bootstrapBytes = envBytes(bootstrap); validateRuntime(runtime);
  const created = [];
  try {
    for (const [name, bytes] of [["runtime.env", runtimeBytes], ["bootstrap.env", bootstrapBytes], ["state.json", `${JSON.stringify(activeState(bundle), null, 2)}\n`]]) {
      const path = join(configDir, name); writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); created.push(path); chmodSync(path, 0o600);
    }
  } catch (error) { for (const path of created) unlinkSync(path); throw error; }
  console.log("Created protected runtime.env and separate bootstrap.env. Configure an HTTPS reverse proxy and verify email delivery before bootstrap. No sample data or owner account was created.");
}
function validateRuntime(runtime) {
  if (!/^[a-z][a-z0-9-]{0,48}$/.test(runtime.MYSKILLS_COMPOSE_PROJECT ?? "") || !/^[0-9]+$/.test(runtime.WEB_PORT ?? "")
    || Number(runtime.WEB_PORT) < 1024 || Number(runtime.WEB_PORT) > 65535 || !["true", "false"].includes(runtime.MYSKILLS_ENABLE_MCP)) fail("project, web port or MCP opt-in is invalid.");
  if (runtime.VITE_API_BASE_URL !== "/api" || !runtime.ALLOWED_WEB_ORIGINS?.split(",").includes(runtime.APP_BASE_URL) || runtime.SMTP_REQUIRE_TLS !== "true" || runtime.SMTP_TLS_REJECT_UNAUTHORIZED !== "true"
    || runtime.DATABASE_URL !== `postgres://${runtime.POSTGRES_USER}:${runtime.POSTGRES_PASSWORD}@postgres:5432/${runtime.POSTGRES_DB}`
    || runtime.S3_ENDPOINT !== "http://minio:9000" || runtime.S3_ACCESS_KEY_ID !== runtime.MINIO_ROOT_USER || runtime.S3_SECRET_ACCESS_KEY !== runtime.MINIO_ROOT_PASSWORD
    || runtime.S3_BUCKET !== "myskills-artifacts" || !/^[a-f0-9]{64}$/.test(runtime.POSTGRES_PASSWORD ?? "") || !/^[a-f0-9]{64}$/.test(runtime.MINIO_ROOT_PASSWORD ?? "")) fail("runtime storage, database or notification invariants differ from the managed deployment.");
  if (runtime.MCP_PROXY_TARGET !== (runtime.MYSKILLS_ENABLE_MCP === "true" ? "http://mcp-http:3002" : "http://127.0.0.1:3002")
    || !runtime.MYSKILLS_MCP_ALLOWED_HOSTS?.split(",").includes("mcp-http:3002")) fail("MCP proxy target and allowed host must match the optional HTTP MCP service.");
  if (runtime.AUTH_NOTIFICATION_MODE === "smtp" && (runtime.SMTP_SECURE !== (runtime.SMTP_PORT === "465" ? "true" : "false") || runtime.SMTP_PORT && (!/^[0-9]+$/.test(runtime.SMTP_PORT) || Number(runtime.SMTP_PORT) < 1 || Number(runtime.SMTP_PORT) > 65535))) fail("SMTP port or secure TLS mode is invalid.");
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/check-production-env.mjs");
  const result = spawnSync(process.execPath, [script], { env: runtime, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) fail("production environment preflight failed; check HTTPS, trusted proxy, storage and explicit SMTP/Resend settings.");
}
function validateBootstrap(bootstrap) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bootstrap.SEED_OWNER_EMAIL ?? "") || bootstrap.SEED_OWNER_EMAIL.endsWith("@example.com")
    || (bootstrap.SEED_OWNER_PASSWORD?.length ?? 0) < 16 || /^(change-me|replace-with-)/.test(bootstrap.SEED_OWNER_PASSWORD)) fail("bootstrap requires a real owner email and password of at least 16 characters.");
}
function validateBackup(configDir, runtime) {
  const backup = readEnv(join(configDir, "backup.env"), backupKeys);
  const endpoint = url(backup.MYSKILLS_RECOVERY_BACKUP_S3_ENDPOINT, ["https:"]);
  if (loopback(endpoint.hostname) || ["minio", "api", "postgres"].includes(endpoint.hostname) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(backup.MYSKILLS_BACKUP_INSTANCE_ID ?? "")
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(backup.MYSKILLS_RECOVERY_BACKUP_S3_BUCKET ?? "") || backup.MYSKILLS_RECOVERY_BACKUP_S3_BUCKET === runtime.S3_BUCKET
    || !backup.MYSKILLS_RECOVERY_BACKUP_S3_ACCESS_KEY_ID || !backup.MYSKILLS_RECOVERY_BACKUP_S3_SECRET_ACCESS_KEY) fail("backup needs a separate protected external HTTPS bucket and credentials.");
  return backup;
}
async function interactiveAnswers() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("interactive setup requires a terminal; use a protected 0600 JSON --answers-file.");
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  output.isTTY = true; output.columns = process.stdout.columns;
  const terminal = createInterface({ input: process.stdin, output, terminal: true }); const values = {};
  try {
    for (const [key, prompt] of [["APP_BASE_URL", "Public HTTPS web origin (/api routes to API)"], ["TRUST_PROXY", "Trusted proxy IP/CIDR list (or false)"], ["AUTH_NOTIFICATION_MODE", "Notification provider (smtp/resend)"]]) values[key] = (await terminal.question(`${prompt}: `)).trim();
    const fields = values.AUTH_NOTIFICATION_MODE === "resend" ? [["RESEND_FROM", "Sender"], ["RESEND_API_KEY", "Resend API key", true]] : [["SMTP_HOST", "SMTP host"], ["SMTP_PORT", "SMTP port (587)"], ["SMTP_FROM", "Sender"], ["SMTP_USER", "SMTP user"], ["SMTP_PASSWORD", "SMTP password", true]];
    fields.push(["SEED_OWNER_EMAIL", "Owner email"], ["SEED_OWNER_PASSWORD", "Owner password (16+ characters)", true]);
    for (const [key, prompt, secret] of fields) { if (secret) { process.stdout.write(`${prompt}: `); hidden = true; } try { values[key] = await terminal.question(secret ? "" : `${prompt}: `); } finally { hidden = false; if (secret) process.stdout.write("\n"); } }
  } finally { terminal.close(); }
  return values;
}

try { await main(); } catch (error) {
  // The message is a fixed helper diagnosis. Raw provider, file, answer and child output is withheld.
  console.error(`MySkills operator: ${error instanceof OperatorError ? error.message : "operation failed; inspect protected configuration and the operator runbook."}`);
  process.exitCode = 1;
}
