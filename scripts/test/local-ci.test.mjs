import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

// Failure cases (written before scripts/local-ci.mjs existed). The real entrypoint runs
// against a temporary git fixture; only docker, npm, npx and codeql are fakes that record
// calls and simulate tool outcomes.
// - Unsafe run IDs, evidence paths inside or around the source, stale or malformed source SHAs,
//   dirty trees, unknown modes or jobs, and reused evidence directories start work or resources.
// - A job failure hides later jobs, or a failed, partial or unpinned run reports required contexts.
// - A missing Node line or wrong npm version is silently replaced by another toolchain.
// - Web E2E exit 0 without a browser report passes, or full-stack runs after a failed step.
// - Cleanup misses a created container, Compose project or image, removes a container it did not
//   create after a name conflict, or matches by prune or name prefix.
// - Cancellation leaves containers, step processes or the per-run workspace behind.
// - Runner credentials reach job processes, or credential-shaped output reaches exported evidence.
// - release-check accepts a wrong tag, a tag not at HEAD, or a commit outside main.
// - Tampered release artifacts pass, or release-check publishes images or packages.
// - CodeQL output that ignores the repository query filters passes.
// Review follow-up (PR 120), also written before the fix:
// - A complete pinned run on a host other than Linux/amd64 reports gating Linux/amd64 evidence.
// - Runs that start together with one run ID but different work or temporary directories all reserve
//   it, so their container, Compose-project and image names collide on the Docker host; or a stale
//   or foreign reservation is taken over or removed.
// - Docker jobs run against a remote daemon that a host-local reservation cannot cover, including a
//   remote DOCKER_CONTEXT that overrides a local DOCKER_HOST.
// - A run whose cleanup failed releases its reservation, so the run ID can be reused while its
//   resources remain.
// - A populated or symlinked evidence destination is accepted, so the evidence scan can delete or the
//   manifest can export files that the run did not write.
// Four-lane integration failures, written before the scheduler:
// - Opt-in verify stays serial, exceeds four jobs, or starts a lane's next job before its predecessor
//   has finished cleanup. Shared HOME, TMPDIR or browser ports let concurrent jobs interfere.
// - A failed lane suppresses another required job or produces a passing aggregate/context.
// - Cancellation stops only one active process, starts queued jobs, or removes the workspace early.
// - Invalid concurrency or shared port overrides silently select an unsafe execution plan.
// - Private HOME hides Docker's implicit config, so preflight, job commands and cleanup select
//   different contexts or daemons. Preserve the original configuration path without copying it.
// Railway MCP delivery failures, written before the image gate:
// - CI/release omit the standalone image, bypass its default command, ignore Railway's PORT,
//   or pass despite a failed health/auth smoke. A name conflict must never remove another container.
// - Docker creates the smoke container but cancellation hides the CLI success; cleanup skips it
//   or deletes a foreign same-name container. Uncertain readback releases the name reservation.
// - A stalled Docker create/exec outlives the inner HTTP deadline and never reaches cleanup.

const runId = `fixture-run-${process.pid}`;
const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const releaseTag = `v${rootPackage.version}`;
const verifyJobs = ["check-node22", "check-node24", "web-e2e-node22", "web-e2e-node24", "postgres-node22", "postgres-node24", "railway-images"];
const fixtureFiles = [
  "package.json",
  "package-lock.json",
  ...(existsSync(resolve("scripts/create-trust-provenance.mjs")) ? ["scripts/create-trust-provenance.mjs"] : []),
  ".gitignore",
  ".github/codeql/codeql-config.yml",
  "scripts/local-ci.sh",
  "scripts/local-ci.mjs",
  "scripts/lib/secret-patterns.mjs",
  "scripts/lib/host-rehearsal-resources.mjs",
  "scripts/lib/host-backup-diagnostics.mjs",
  "scripts/collect-browser-evidence.mjs",
  "scripts/create-release-artifacts.mjs",
  "scripts/verify-release.mjs",
];
const webBuild = "run build -w @myskills-app/core -w @myskills-app/auth -w @myskills-app/skill-package -w @myskills-app/api";
const mockedBrowser = "run test:e2e -w @myskills-app/web -- --reporter=line,json";
// The gate is defined for Linux/amd64 hosts; elsewhere a complete pinned run must stay non-gating.
const hostBlockers = process.platform === "linux" && process.arch === "x64" ? [] : ["unsupported-host-platform"];
const runIdReservation = join("/var/tmp/myskills-local-ci-locks", runId);

test("HOST rehearsal remains inside railway-images and fails that canonical job when its subprocess fails", (t) => {
  const fixture = makeFixture(t); fixture.configure({ rules: [{ tool: "host-rehearsal", prefix: "", exit: 1 }] });
  const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.jobs[0].id, "railway-images"); assert.equal(run.result.jobs[0].status, "failed");
  assert.ok(run.result.jobs[0].steps.some((step) => step.name === "host-rehearsal" && step.status === "failed"));
});

test("HOST receipt must include restored TOTP, non-owner denial and revoked-session denial", (t) => {
  const fixture = makeFixture(t); fixture.configure({ omitHostAuthProof: true });
  const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.jobs[0].reason, "host-rehearsal-evidence-missing");
});

test("HOST receipt requires the real composed object-byte and denied-storage proof", (t) => {
  const fixture = makeFixture(t); fixture.configure({ omitHostComposedProof: true });
  const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.jobs[0].reason, "host-rehearsal-evidence-missing");
});

test("product-site build and browser proof run in existing browser jobs; missing site reports fail", (t) => {
  const fixture = makeFixture(t); fixture.configure({ omitSiteReport: ["22"] });
  const run = runLocalCi(fixture, ["verify", "--job", "web-e2e-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  const records = fixture.records().filter((record) => record.tool === "npm");
  assert.ok(records.some((record) => record.args.join(" ") === "run build -w @myskills-app/site"));
  const browser = records.find((record) => record.args.join(" ") === "run test:e2e -w @myskills-app/site -- --reporter=line,json");
  assert.match(browser.env.MYSKILLS_SITE_TEST_PORT, /^\d+$/);
  assert.equal(run.result.jobs[0].status, "failed");
});

test("fresh operational and improvement reports are required alongside registry evidence", t => {
  for (const phase of ["operational", "improvement"]) {
    const fixture = makeFixture(t); fixture.configure({ omitFullstackReport: phase });
    const run = runLocalCi(fixture, ["verify", "--job", "web-e2e-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
    assert.equal(run.status, 1, run.output);
    const steps = run.result.jobs[0].steps;
    assert.equal(steps.find(({ name }) => name === "fullstack-browser").status, "passed");
    assert.equal(steps.find(({ name }) => name === `collect-${phase}-evidence`).status, "failed", "registry evidence cannot stand in for the isolated lifecycle");
  }
});

test("unsafe or stale inputs are rejected before any tool, container or workspace is used", (t) => {
  const fixture = makeFixture(t);
  const secretLookingId = "$(touch pwned)";
  const rows = [
    { name: "missing run ID", env: { LOCAL_CI_RUN_ID: undefined }, stderr: /LOCAL_CI_RUN_ID/ },
    { name: "path run ID", env: { LOCAL_CI_RUN_ID: "../escape" }, stderr: /LOCAL_CI_RUN_ID/ },
    { name: "uppercase run ID", env: { LOCAL_CI_RUN_ID: "Fixture-Run" }, stderr: /LOCAL_CI_RUN_ID/ },
    { name: "shell run ID", env: { LOCAL_CI_RUN_ID: secretLookingId }, stderr: /LOCAL_CI_RUN_ID/ },
    { name: "relative evidence", evidence: "evidence", stderr: /LOCAL_CI_EVIDENCE_DIR must be absolute/ },
    { name: "evidence inside source", evidence: join(fixture.source, "evidence"), stderr: /outside the source/ },
    { name: "evidence through symlink", evidence: join(fixture.root, "source-link", "evidence"), stderr: /outside the source/ },
    { name: "evidence containing source", evidence: fixture.root, stderr: /outside the source/ },
    { name: "unknown mode", args: ["deploy"], stderr: /Usage/ },
    { name: "unknown job", args: ["verify", "--job", "nope"], stderr: /Unknown job/ },
    { name: "malformed SHA", env: { LOCAL_CI_SOURCE_SHA: "abc123" }, reason: "invalid-source-sha" },
    { name: "stale SHA", env: { LOCAL_CI_SOURCE_SHA: "0".repeat(40) }, reason: "source-sha-mismatch" },
    { name: "CodeQL without CLI", args: ["codeql"], reason: "codeql-cli-unavailable" },
    { name: "unsupported lane count", env: { LOCAL_CI_VERIFY_LANES: "3" }, reason: "invalid-verify-lanes" },
    { name: "parallel release", args: ["release-check"], env: { LOCAL_CI_VERIFY_LANES: "4" }, reason: "invalid-verify-lanes" },
    { name: "shared parallel browser port", env: { LOCAL_CI_VERIFY_LANES: "4", MYSKILLS_E2E_WEB_PORT: "43100" }, reason: "parallel-port-override" },
  ];
  symlinkSync(fixture.source, join(fixture.root, "source-link"));
  for (const row of rows) {
    const run = runLocalCi(fixture, row.args ?? ["verify"], { env: row.env, evidence: row.evidence });
    assert.equal(run.status, 2, `${row.name}: ${run.output}`);
    if (row.stderr) assert.match(run.stderr, row.stderr, row.name);
    if (row.reason) {
      assert.equal(run.result?.status, "rejected", row.name);
      assert.equal(run.result.reason, row.reason, row.name);
    } else if (row.evidence !== fixture.root) {
      assert.equal(existsSync(join(resolve(fixture.root, row.evidence ?? run.evidence), "result.json")), false, row.name);
    }
    assert.doesNotMatch(run.output, /touch pwned/, row.name);
    assert.deepEqual(fixture.records(), [], `${row.name} must not invoke tools`);
    assert.equal(existsSync(fixture.runWorkspace), false, row.name);
  }
  assert.equal(existsSync(join(fixture.source, "evidence")), false);

  const reused = join(fixture.root, "reused");
  mkdirSync(reused);
  writeFileSync(join(reused, "result.json"), "sentinel\n");
  const reuse = runLocalCi(fixture, ["verify"], { evidence: reused });
  assert.equal(reuse.status, 2);
  assert.match(reuse.stderr, /already contains result\.json/);
  assert.equal(readFileSync(join(reused, "result.json"), "utf8"), "sentinel\n");

  writeFileSync(join(fixture.source, "untracked.txt"), "dirty\n");
  const dirty = runLocalCi(fixture, ["verify"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  rmSync(join(fixture.source, "untracked.txt"));
  assert.equal(dirty.status, 2);
  assert.equal(dirty.result?.reason, "dirty-source");
  assert.deepEqual(fixture.records(), []);
});

test("verify runs every required job on both Node lines and reports gating contexts", (t) => {
  const fixture = makeFixture(t);
  const canary = `runner-credential-${createHash("sha256").update(fixture.root).digest("hex").slice(0, 16)}`;
  fixture.configure({ canary });
  const run = runLocalCi(fixture, ["verify"], {
    env: { LOCAL_CI_SOURCE_SHA: fixture.sha, GITHUB_TOKEN: canary, GH_TOKEN: canary, NPM_TOKEN: canary },
  });
  assert.equal(run.status, 0, run.output);
  const { result } = run;
  assert.equal(result.status, "passed");
  assert.equal(result.gating, hostBlockers.length === 0);
  assert.deepEqual(result.gatingBlockers, hostBlockers);
  assert.equal(result.complete, true);
  assert.equal(result.source.sha, fixture.sha);
  assert.deepEqual(result.jobs.map(({ id }) => id).sort(), [...verifyJobs].sort());
  assert.ok(result.jobs.every(({ status }) => status === "passed"));
  assert.deepEqual(result.contexts, { check: "passed", "web-e2e": "passed", "postgres-integration": "passed" });

  const records = fixture.records();
  const npm = records.filter(({ tool, args }) => tool === "npm" && args[0] !== "--version");
  for (const line of ["22", "24"]) {
    const commands = new Set(npm.filter((record) => record.line === line).map(({ args }) => args.join(" ")));
    for (const expected of ["ci", "run check", webBuild, mockedBrowser, "run test:e2e:fullstack", "run test:postgres"]) {
      assert.ok(commands.has(expected), `Node ${line} must run ${expected}`);
    }
  }
  for (const record of npm) {
    assert.equal(record.head, fixture.sha, "every job runs in a clone of the pinned commit");
    assert.equal(isInside(record.cwd, fixture.source), false, "jobs must not run in the caller's checkout");
    assert.equal(record.env.CI, "true");
  }
  for (const record of npm.filter(({ args }) => args.join(" ") === "run test:postgres")) {
    assert.match(record.env.TEST_DATABASE_URL, /^postgres:\/\/myskills_test:myskills_test@127\.0\.0\.1:55432\/myskills_test$/);
  }
  const projects = npm.filter(({ args }) => args.join(" ") === "run test:e2e:fullstack").map(({ env }) => env.MYSKILLS_E2E_COMPOSE_PROJECT);
  assert.equal(new Set(projects).size, 2);
  assert.ok(projects.every((project) => project.includes(runId)));
  assert.equal(records.some(({ canarySeen }) => canarySeen), false, "runner credentials must not reach jobs");

  const docker = records.filter(({ tool }) => tool === "docker");
  assertExactCleanup(docker, projects);
  assert.ok(docker.some(({ args }) => args[0] === "run" && args.includes("postgres:17-alpine")));
  const builds = docker.filter(({ args }) => args[0] === "build").map(({ args }) => args.join(" "));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.api")));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.mcp")));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.web") && build.includes("--build-arg VITE_API_BASE_URL=/api")));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.backup")));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.ops")));
  assert.equal(docker.filter(({ args }) => args[0] === "run" && args.includes("--rm") && args.includes("--network") && args.includes("none")).length, 5);
  assertMcpSmoke(docker, "myskills-app-mcp");
  assertNoPublication(records);

  for (const line of ["22", "24"]) {
    for (const phase of ["mocked", "fullstack", "fullstack-operational", "fullstack-improvement", "fullstack-connector"]) {
      const summary = JSON.parse(readFileSync(join(run.evidence, "browser-evidence", `web-e2e-node${line}`, phase, "summary.json"), "utf8"));
      assert.equal(summary.reportStatus, "available");
    }
  }
  assertEvidenceManifest(run.evidence, result);
  for (const job of result.jobs) {
    assert.equal(sha256(readFileSync(join(run.evidence, job.log.path))), job.log.sha256);
  }
  const resources = JSON.parse(readFileSync(join(run.evidence, "resources.json"), "utf8"));
  assert.ok(resources.resources.length > 0);
  assert.ok(resources.resources.every(({ state }) => state === "removed"), JSON.stringify(resources));
  assert.equal(existsSync(fixture.runWorkspace), false);
  assert.equal(listFiles(run.evidence).some((file) => readFileSync(join(run.evidence, file)).includes(canary)), false);
  assert.equal(run.output.includes(canary), false);
});

test("Railway MCP smoke failures fail the image job and cleanup only its created container", (t) => {
  for (const conflict of [false, true]) {
    const fixture = makeFixture(t);
    const name = `myskills-ci-${runId}-railway-images-mcp-smoke`;
    fixture.configure(conflict ? { dockerConflicts: [name] } : { rules: [{ tool: "docker", prefix: `exec ${name} `, exit: 1 }] });
    const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
    assert.equal(run.status, 1, run.output);
    assert.equal(run.result.jobs[0].status, "failed");
    const docker = fixture.records().filter(({ tool }) => tool === "docker");
    assertExactCleanup(docker, [], { conflicts: conflict ? [name] : [] });
    assert.equal(docker.some(({ args }) => args[0] === "exec" && args[1] === name), !conflict);
  }
});

// HOST-1 failure case: a broken packaged operator entrypoint must fail the
// image gate, even when the API/MCP/backup images built successfully.
test("operator image smoke failure fails the gate with exact cleanup and no publication", (t) => {
  const fixture = makeFixture(t);
  const name = `myskills-ci-${runId}-railway-images-smoke-ops-configure`;
  fixture.configure({ rules: [{ tool: "docker", prefix: `run --rm --name ${name} `, exit: 1 }] });
  const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.jobs[0].steps.find(({ name }) => name === "smoke-ops-configure").status, "failed");
  assertExactCleanup(fixture.records().filter(({ tool }) => tool === "docker"), []);
  assertNoPublication(fixture.records());
});

for (const readback of ["owned", "foreign", "unavailable", "absent", "malformed"]) test(`cancelled MCP creation reconciles ${readback} ownership before cleanup`, async (t) => {
  const fixture = makeFixture(t);
  t.after(() => rmSync(runIdReservation, { recursive: true, force: true }));
  const name = `myskills-ci-${runId}-railway-images-mcp-smoke`;
  fixture.configure({ smokeReadback: readback, rules: [{ tool: "docker", prefix: `run -d --name ${name} `, sleepMs: 30_000 }] });
  const evidence = fixture.newEvidence();
  const child = spawn("bash", [join(fixture.source, "scripts/local-ci.sh"), "verify", "--job", "railway-images"], {
    cwd: fixture.source,
    env: fixture.env({ LOCAL_CI_EVIDENCE_DIR: evidence, LOCAL_CI_SOURCE_SHA: fixture.sha }),
    stdio: "ignore",
  });
  const exited = new Promise((resolvePromise) => child.once("close", resolvePromise));
  try {
    await waitFor(() => fixture.records().some(({ tool, args }) => tool === "docker" && args[0] === "run" && args.includes(name)), 10_000);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
  assert.equal(await exited, 143);
  const docker = fixture.records().filter(({ tool }) => tool === "docker");
  assert.ok(docker.some(({ args }) => args[0] === "container" && args[1] === "inspect" && args.at(-1) === name), "read back the exact container name");
  const removed = docker.filter(({ args }) => args[0] === "rm").flatMap(({ args }) => args);
  assert.equal(removed.includes(name), false, "never remove an ambiguous name");
  assert.equal(removed.includes(sha256(name)), readback === "owned", "remove only the verified immutable ID");
  const uncertain = !["owned", "foreign"].includes(readback);
  const result = readJson(join(evidence, "result.json"));
  assert.equal(result.cleanup.status, uncertain ? "failed" : "complete");
  assert.equal(existsSync(runIdReservation), uncertain, "uncertain creation keeps its reservation");
  const resources = readJson(join(evidence, "resources.json")).resources;
  const entry = resources.find((resource) => resource.kind === "container" && resource.name === name);
  assert.equal(entry.state, readback === "owned" ? "removed" : readback === "foreign" ? "not-created" : "remove-failed");
});

for (const phase of ["start", "health"]) test(`MCP ${phase} smoke bounds a stalled Docker command and cleans the owned container`, (t) => {
  const fixture = makeFixture(t, { mcpSmokeTimeoutMs: 200 });
  const name = `myskills-ci-${runId}-railway-images-mcp-smoke`;
  fixture.configure({ rules: [{ tool: "docker", prefix: phase === "start" ? `run -d --name ${name} ` : `exec ${name} `, sleepMs: 2_000 }] });
  const run = runLocalCi(fixture, ["verify", "--job", "railway-images"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  const step = run.result.jobs[0].steps.find(({ name }) => name === `smoke-mcp-${phase}`);
  assert.equal(step.status, "timed-out");
  assert.ok(step.durationMs < 1_500, `the bounded step took ${step.durationMs} ms`);
  assert.equal(run.result.cleanup.status, "complete");
  const docker = fixture.records().filter(({ tool }) => tool === "docker");
  assert.ok(docker.some(({ args }) => args[0] === "rm" && args.includes(sha256(name))));
  assert.equal(existsSync(runIdReservation), false);
});

for (const lanes of ["1", "4"]) test(`job failures are isolated and fail contexts with ${lanes} lane(s) without removing another run's container`, (t) => {
  const fixture = makeFixture(t);
  const conflicting = `myskills-ci-${runId}-postgres-node22-postgres`;
  fixture.configure({
    rules: [{ tool: "npm", line: "24", prefix: "run check", exit: 1 }],
    omitMockedReport: ["22"],
    dockerConflicts: [conflicting],
  });
  const run = runLocalCi(fixture, ["verify"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_VERIFY_LANES: lanes } });
  assert.equal(run.status, 1, run.output);
  const { result } = run;
  assert.equal(result.status, "failed");
  assert.equal(result.gating, hostBlockers.length === 0, "a pinned complete run on a Linux/amd64 host is authoritative even when it fails");
  const job = (id) => result.jobs.find((candidate) => candidate.id === id);
  assert.equal(job("check-node22").status, "passed");
  assert.equal(job("check-node24").status, "failed");
  assert.equal(job("web-e2e-node22").status, "failed");
  assert.equal(job("web-e2e-node22").steps.find(({ name }) => name === "fullstack-browser").status, "skipped");
  assert.equal(job("web-e2e-node24").status, "passed");
  assert.equal(job("postgres-node22").status, "failed");
  assert.equal(job("postgres-node22").reason, "service-unavailable");
  assert.equal(job("postgres-node24").status, "passed");
  assert.equal(job("railway-images").status, "passed");
  assert.deepEqual(result.contexts, { check: "failed", "web-e2e": "failed", "postgres-integration": "failed" });

  const records = fixture.records();
  const npmCommands = (line) => records.filter((record) => record.tool === "npm" && record.line === line).map(({ args }) => args.join(" "));
  assert.equal(npmCommands("22").includes("run test:e2e:fullstack"), false);
  assert.equal(npmCommands("22").includes("run test:postgres"), false);
  assert.ok(npmCommands("24").includes("run test:e2e:fullstack"));
  const mocked = JSON.parse(readFileSync(join(run.evidence, "browser-evidence", "web-e2e-node22", "mocked", "summary.json"), "utf8"));
  assert.equal(mocked.reportStatus, "unavailable");
  const docker = records.filter(({ tool }) => tool === "docker");
  assert.ok(docker.some(({ args }) => args[0] === "run" && args.includes(conflicting)), "the conflicting create must have been attempted");
  const projects = records.filter(({ env }) => env.MYSKILLS_E2E_COMPOSE_PROJECT).map(({ env }) => env.MYSKILLS_E2E_COMPOSE_PROJECT);
  assertExactCleanup(docker, projects, { conflicts: [conflicting] });
  assertEvidenceManifest(run.evidence, result);
  assert.equal(existsSync(fixture.runWorkspace), false);
});

test("four verify lanes overlap, preserve job order and isolate directories and browser ports", (t) => {
  const fixture = makeFixture(t);
  fixture.configure({ rules: [{ tool: "npm", prefix: "ci", sleepMs: 500 }] });
  const run = runLocalCi(fixture, ["verify"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_VERIFY_LANES: "4" } });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.complete, true);
  assert.deepEqual(run.result.contexts, { check: "passed", "web-e2e": "passed", "postgres-integration": "passed" });
  assert.deepEqual(run.result.jobs.map(({ id }) => id).sort(), [...verifyJobs].sort());
  const times = Object.fromEntries(run.result.jobs.map((job) => [job.id, {
    start: Date.parse(job.startedAt), end: Date.parse(job.finishedAt),
  }]));
  const first = ["web-e2e-node22", "web-e2e-node24", "postgres-node22", "postgres-node24"].map((id) => times[id]);
  assert.ok(Math.max(...first.map(({ start }) => start)) < Math.min(...first.map(({ end }) => end)), "all four initial jobs must overlap");
  for (const [before, after] of [["postgres-node22", "check-node22"], ["postgres-node24", "check-node24"], ["check-node24", "railway-images"]]) {
    assert.ok(times[before].end <= times[after].start, `${after} must wait for ${before}, including cleanup`);
  }
  const events = Object.values(times).flatMap(({ start, end }) => [[start, 1], [end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  for (const [, change] of events) {
    active += change;
    assert.ok(active <= 4, "never run more than four jobs");
  }
  const calls = fixture.records().filter(({ cwd, args }) => cwd.endsWith("/source") && args[0] !== "--version" && cwd !== fixture.source);
  const environments = new Map(calls.map(({ cwd, env }) => [cwd, env]));
  assert.equal(environments.size, 7);
  for (const variable of ["HOME", "TMPDIR"]) {
    const paths = [...environments.values()].map((env) => env[variable]);
    assert.equal(new Set(paths).size, 7, `${variable} must be private to each job`);
    assert.ok(paths.every((path) => path && !existsSync(path)), `${variable} directories must be removed after the run`);
  }
  const browsers = run.result.jobs.filter(({ id }) => id.startsWith("web-e2e-"));
  for (const { ports } of browsers) {
    assert.equal(ports.MYSKILLS_E2E_WEB_PORT, "0", "Docker must allocate the fullstack web port at bind time");
    assert.equal(ports.MYSKILLS_E2E_MAILPIT_PORT, "0", "Docker must allocate the fullstack mail port at bind time");
  }
  const ports = browsers.flatMap(({ ports }) => [ports.MYSKILLS_E2E_PORT, ports.MYSKILLS_SITE_TEST_PORT]);
  assert.equal(ports.length, 4);
  assert.equal(new Set(ports).size, 4, "mocked and site browser ports must be distinct");
  assertEvidenceManifest(run.evidence, run.result);
  assert.equal(existsSync(fixture.runWorkspace), false);
  assert.equal(existsSync(runIdReservation), false);
});

test("four-lane cancellation stops every active step before cleanup and skips queued jobs", async (t) => {
  const fixture = makeFixture(t);
  fixture.configure({ rules: [{ tool: "npm", prefix: "ci", sleepMs: 60_000 }] });
  const evidence = fixture.newEvidence();
  const child = spawn("bash", [join(fixture.source, "scripts/local-ci.sh"), "verify"], {
    cwd: fixture.source,
    env: fixture.env({ LOCAL_CI_EVIDENCE_DIR: evidence, LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_VERIFY_LANES: "4" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolvePromise) => child.once("close", (code) => resolvePromise(code)));
  let steps;
  try {
    steps = await waitFor(() => {
      const installs = fixture.records().filter(({ tool, args }) => tool === "npm" && args.join(" ") === "ci");
      return installs.length === 4 && installs;
    }, 10_000);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
  assert.equal(await exited, 143, output);
  assert.ok(steps.every(({ pid }) => !isAlive(pid)), "all active process groups must stop");
  const result = readJson(join(evidence, "result.json"));
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.contexts, { check: "cancelled", "web-e2e": "cancelled", "postgres-integration": "cancelled" });
  for (const id of ["check-node22", "check-node24", "railway-images"]) {
    assert.equal(result.jobs.find((job) => job.id === id).status, "not-run", `${id} must never start`);
  }
  assert.equal(result.cleanup.status, "complete");
  const resources = readJson(join(evidence, "resources.json"));
  assert.ok(resources.resources.every(({ state }) => state === "removed"));
  for (const { env } of steps) {
    assert.equal(existsSync(env.HOME), false);
    assert.equal(existsSync(env.TMPDIR), false);
  }
  assert.equal(existsSync(fixture.runWorkspace), false);
  assert.equal(existsSync(runIdReservation), false);
});

test("parallel jobs preserve Docker context configuration from the original home through cleanup", (t) => {
  const fixture = makeFixture(t);
  const home = join(fixture.root, "caller-home");
  const dockerConfig = join(home, ".docker");
  mkdirSync(dockerConfig, { recursive: true });
  const contents = JSON.stringify({ currentContext: "fixture-local", contexts: ["fixture-local"] });
  writeFileSync(join(dockerConfig, "config.json"), contents);
  for (const env of [{}, { DOCKER_CONTEXT: "fixture-local" }, { DOCKER_CONFIG: dockerConfig }]) {
    fixture.configure({ requiredDockerContext: "fixture-local" });
    const run = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], {
      env: { HOME: home, LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_VERIFY_LANES: "4", ...env },
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.result.cleanup.status, "complete");
    assert.equal(run.result.gating, false, "the partial selection stays non-gating");
    const docker = fixture.records().filter(({ tool }) => tool === "docker");
    assert.ok(docker.some(({ args }) => args[0] === "context"));
    assert.ok(docker.some(({ args }) => args[0] === "run"));
    assert.ok(docker.some(({ args }) => args[0] === "rm"));
    assert.ok(docker.every(({ env }) => (env.DOCKER_CONFIG ?? join(env.HOME, ".docker")) === dockerConfig));
    assert.ok(docker.some(({ args, env }) => args[0] === "run" && env.HOME !== home), "job HOME remains private");
    assert.equal(readFileSync(join(dockerConfig, "config.json"), "utf8"), contents, "caller configuration is unchanged");
  }
});

test("partial or unpinned runs never report the required contexts", (t) => {
  const fixture = makeFixture(t);
  const run = runLocalCi(fixture, ["verify", "--job", "check-node22"]);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.status, "passed");
  assert.equal(run.result.complete, false);
  assert.equal(run.result.gating, false);
  assert.deepEqual([...run.result.gatingBlockers].sort(), ["partial-job-selection", "source-sha-not-supplied", ...hostBlockers].sort());
  assert.equal(run.result.contexts, null);
  const records = fixture.records();
  assert.ok(records.every(({ tool, line }) => tool === "npm" && line === "22"));
});

test("a missing or mismatched toolchain fails its jobs without substituting another version", (t) => {
  const fixture = makeFixture(t);
  fixture.configure({ npmVersion: { 24: "11.0.0" } });
  const run = runLocalCi(fixture, ["verify", "--job", "check-node22", "--job", "check-node24"], {
    env: {
      LOCAL_CI_NODE22_BIN: undefined,
      PATH: `${fixture.bin}:${join(fixture.root, "oldnode")}:${process.env.PATH}`,
    },
  });
  assert.equal(run.status, 1, run.output);
  const job = (id) => run.result.jobs.find((candidate) => candidate.id === id);
  assert.equal(job("check-node22").status, "failed");
  assert.equal(job("check-node22").reason, "toolchain-unavailable");
  assert.equal(job("check-node24").status, "failed");
  assert.equal(job("check-node24").reason, "toolchain-mismatch");
  assert.deepEqual(fixture.records().filter(({ args }) => args[0] !== "--version"), []);
});

test("cancellation stops the running step and removes exactly the run's resources", async (t) => {
  const fixture = makeFixture(t);
  fixture.configure({ rules: [{ tool: "npm", prefix: "run test:postgres", sleepMs: 60_000, exit: 0 }] });
  const evidence = fixture.newEvidence();
  const child = spawn("bash", [join(fixture.source, "scripts/local-ci.sh"), "verify", "--job", "postgres-node22"], {
    cwd: fixture.source,
    env: fixture.env({ LOCAL_CI_EVIDENCE_DIR: evidence, LOCAL_CI_SOURCE_SHA: fixture.sha }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolvePromise) => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  const step = await waitFor(() => fixture.records().find(({ args }) => args.join(" ") === "run test:postgres"));
  child.kill("SIGTERM");
  const { code } = await exited;
  assert.equal(code, 143, output);
  const result = JSON.parse(readFileSync(join(evidence, "result.json"), "utf8"));
  assert.equal(result.status, "cancelled");
  assert.equal(isAlive(step.pid), false, "the step process group must be stopped");
  const container = `myskills-ci-${runId}-postgres-node22-postgres`;
  assert.ok(fixture.records().some(({ tool, args }) => tool === "docker" && args[0] === "rm" && args.includes(container)));
  const resources = JSON.parse(readFileSync(join(evidence, "resources.json"), "utf8"));
  assert.ok(resources.resources.every(({ state }) => state === "removed"), JSON.stringify(resources));
  assert.equal(existsSync(fixture.runWorkspace), false);
  assert.equal(existsSync(runIdReservation), false, "cancellation releases the run-ID reservation");
});

test("credential-shaped output is redacted from exported evidence and fails the run and its contexts", (t) => {
  const fixture = makeFixture(t);
  const token = ["gh", "p_", "Fixture0123456789abcdefghijklmnopqrstuv"].join("");
  fixture.configure({ rules: [{ tool: "npm", line: "22", prefix: "run check", stdout: `leaked ${token}` }] });
  const run = runLocalCi(fixture, ["verify"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.status, "failed");
  assert.ok(run.result.failureReasons.some((reason) => reason.startsWith("secret-pattern-redacted")));
  // Every job exited 0; a run-level failure must still never surface as a passing context.
  assert.ok(run.result.jobs.every(({ status }) => status === "passed"));
  assert.deepEqual(run.result.contexts, { check: "failed", "web-e2e": "failed", "postgres-integration": "failed" });
  assert.equal(run.output.includes(token), false);
  for (const file of listFiles(run.evidence)) {
    assert.equal(readFileSync(join(run.evidence, file), "utf8").includes(token), false, file);
  }
  assert.match(readFileSync(join(run.evidence, "logs", "check-node22.log"), "utf8"), /\[redacted\]/);
});

test("release-check rejects wrong tags, moved tags and commits outside main before any work", (t) => {
  const fixture = makeFixture(t, { tag: true });
  const pinned = { LOCAL_CI_SOURCE_SHA: fixture.sha };
  const rows = [
    { name: "tag missing", env: pinned, reason: "release-tag-required" },
    { name: "tag differs from version", env: { ...pinned, LOCAL_CI_RELEASE_TAG: "v0.0.1" }, reason: "release-tag-version-mismatch" },
    { name: "main ref missing", env: { ...pinned, LOCAL_CI_RELEASE_TAG: releaseTag, LOCAL_CI_MAIN_REF: "refs/remotes/origin/absent" }, reason: "main-ref-unavailable" },
  ];
  for (const row of rows) {
    const run = runLocalCi(fixture, ["release-check"], { env: row.env });
    assert.equal(run.status, 2, `${row.name}: ${run.output}`);
    assert.equal(run.result.reason, row.reason, row.name);
  }

  const orphan = git(fixture.source, "commit-tree", `${fixture.sha}^{tree}`, "-m", "unrelated main");
  git(fixture.source, "update-ref", "refs/remotes/origin/main", orphan);
  const outside = runLocalCi(fixture, ["release-check"], { env: { ...pinned, LOCAL_CI_RELEASE_TAG: releaseTag } });
  assert.equal(outside.status, 2, outside.output);
  assert.equal(outside.result.reason, "not-on-main");

  git(fixture.source, "commit", "-q", "--allow-empty", "-m", "after tag");
  const moved = git(fixture.source, "rev-parse", "HEAD");
  git(fixture.source, "update-ref", "refs/remotes/origin/main", moved);
  const notAtHead = runLocalCi(fixture, ["release-check"], { env: { LOCAL_CI_SOURCE_SHA: moved, LOCAL_CI_RELEASE_TAG: releaseTag } });
  assert.equal(notAtHead.status, 2, notAtHead.output);
  assert.equal(notAtHead.result.reason, "release-tag-not-at-head");
  assert.deepEqual(fixture.records(), []);
});

test("release-check verifies tagged artifacts and release images without publishing", (t) => {
  const fixture = makeFixture(t, { tag: true });
  const run = runLocalCi(fixture, ["release-check"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_RELEASE_TAG: releaseTag } });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.status, "passed");
  assert.equal(run.result.gating, hostBlockers.length === 0);
  assert.equal(run.result.release.tag, releaseTag);
  assert.equal(run.result.release.mainSha, fixture.sha);

  const records = fixture.records();
  const verify = records.find(({ tool, args }) => tool === "npm" && args.join(" ") === "run release:verify");
  assert.equal(verify.line, "22");
  assert.equal(verify.env.RELEASE_REQUIRE_TAG, "true");
  assert.equal(verify.env.RELEASE_EXPECTED_TAG, releaseTag);
  assert.match(verify.env.TEST_DATABASE_URL, /@127\.0\.0\.1:55432\/myskills_test$/);
  const docker = records.filter(({ tool }) => tool === "docker");
  assert.ok(docker.some(({ args }) => args[0] === "run" && args.includes("postgres:17")));
  const builds = docker.filter(({ args }) => args[0] === "build").map(({ args }) => args.join(" "));
  for (const target of ["api", "mcp-http"]) assert.ok(builds.some((build) => build.includes(`--target ${target} `)), target);
  assert.ok(builds.some((build) => build.includes("--target web ") && build.includes("--build-arg VITE_API_BASE_URL=/api")));
  for (const file of ["Dockerfile.api", "Dockerfile.mcp", "Dockerfile.web", "Dockerfile.backup", "Dockerfile.ops"]) assert.ok(builds.some((build) => build.includes(`--file ${file} `)), file);
  assert.equal(docker.filter(({ args }) => args[0] === "run" && args.includes("--rm") && args.includes("none")).length, 5);
  assertMcpSmoke(docker, "myskills-app-railway-mcp");
  for (const image of ["myskills-app-railway-mcp", "myskills-registry-backup", "myskills-ops"]) assert.ok(docker.some(({ args }) => args[0] === "run" && args.some(arg => arg.startsWith(`${image}:local-ci-`))), `recorder observes downstream smoke ${image}`);
  assertExactCleanup(docker, [verify.env.MYSKILLS_E2E_COMPOSE_PROJECT]);
  assertNoPublication(records);

  const artifacts = join(run.evidence, "release", "artifacts");
  const archive = `${rootPackage.name}-${rootPackage.version}-source.tar`;
  assert.deepEqual(readdirSync(artifacts).sort(), [archive, "SHA256SUMS", "release-metadata.json"].sort());
  const sums = readFileSync(join(artifacts, "SHA256SUMS"), "utf8").trim().split("\n");
  for (const line of sums) {
    const [digest, file] = line.split(/\s+/);
    assert.equal(sha256(readFileSync(join(artifacts, file))), digest, file);
  }
  const metadata = JSON.parse(readFileSync(join(artifacts, "release-metadata.json"), "utf8"));
  assert.equal(metadata.commitSha, fixture.sha);
  assert.equal(metadata.dirty, false);
  assert.ok(metadata.tags.includes(releaseTag));
  assertEvidenceManifest(run.evidence, run.result);
  assert.equal(existsSync(fixture.runWorkspace), false);
});

test("release-check rejects tampered release artifacts", (t) => {
  const fixture = makeFixture(t, { tag: true });
  fixture.configure({ tamperReleaseArchive: true });
  const run = runLocalCi(fixture, ["release-check"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_RELEASE_TAG: releaseTag } });
  assert.equal(run.status, 1, run.output);
  const job = run.result.jobs.find(({ id }) => id === "release");
  assert.equal(job.status, "failed");
  assert.equal(job.reason, "artifact-verification-failed");
  assert.equal(existsSync(join(run.evidence, "release", "artifacts")), false);
  const resources = JSON.parse(readFileSync(join(run.evidence, "resources.json"), "utf8"));
  assert.ok(resources.resources.every(({ state }) => state === "removed"), JSON.stringify(resources));
  const downstream = fixture.records().filter(({ tool, args }) => tool === "docker" && (args[0] === "build" || args[0] === "run" && args.some(arg => /^(myskills-app-(api|web|mcp-http|railway-api|railway-mcp|railway-web)|myskills-registry-backup|myskills-ops):local-ci-/.test(arg))));
  assert.deepEqual(downstream, [], "failed artifact verification must dispatch no downstream image build or smoke");
});

test("CodeQL applies the repository query filters and fails closed when they are ignored", (t) => {
  const fixture = makeFixture(t);
  const codeql = join(fixture.bin, "codeql");
  // Two findings stand in for alerts that GitHub dismissed; local counts must not gate.
  fixture.configure({ codeqlFindings: 2 });
  const passed = runLocalCi(fixture, ["codeql"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_CODEQL_BIN: codeql } });
  assert.equal(passed.status, 0, passed.output);
  const repositoryConfig = readFileSync(join(fixture.source, ".github/codeql/codeql-config.yml"), "utf8");
  const derived = readFileSync(join(fixture.root, "codeql-config.yml"), "utf8");
  assert.ok(derived.startsWith(repositoryConfig), "repository query filters are preserved verbatim");
  assert.match(derived.slice(repositoryConfig.length), /^\s*queries:\n\s+- uses: security-extended\n$/);
  const records = fixture.records().filter(({ tool }) => tool === "codeql");
  const create = records.find(({ args }) => args[1] === "create");
  assert.ok(create.args.includes("--language=javascript-typescript") && create.args.includes("--build-mode=none"));
  const analyze = records.find(({ args }) => args[1] === "analyze");
  assert.ok(analyze.args.includes("--sarif-category=/language:javascript-typescript"));
  assert.equal(analyze.args.some((arg) => arg.endsWith(".qls")), false, "queries come from the derived config");
  assert.ok(listFiles(passed.evidence).some((file) => file.endsWith(".sarif")));
  assert.equal(passed.result.jobs[0].codeql.results, 2);

  fixture.configure({ codeqlRules: ["js/sql-injection", "js/missing-rate-limiting"] });
  const ignored = runLocalCi(fixture, ["codeql"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_CODEQL_BIN: codeql } });
  assert.equal(ignored.status, 1, ignored.output);
  assert.equal(ignored.result.jobs[0].reason, "codeql-filter-not-applied");
});

test("a complete pinned run on a host other than Linux/amd64 never reports gating evidence", (t) => {
  const fixture = makeFixture(t);
  const run = runLocalCi(fixture, ["codeql"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_CODEQL_BIN: join(fixture.bin, "codeql") } });
  assert.equal(run.status, 0, run.output);
  const environment = readJson(join(run.evidence, "environment.json"));
  const supported = environment.platform === "linux" && environment.arch === "x64";
  assert.equal(run.result.status, "passed", "the run itself still completes for development use");
  assert.equal(run.result.complete, true);
  assert.equal(run.result.gating, supported, `${environment.platform}/${environment.arch}`);
  assert.equal(run.result.gatingBlockers.includes("unsupported-host-platform"), !supported);
});

test("runs that start together with one run ID reserve it once on the host, whatever their work and temporary directories", async (t) => {
  const fixture = makeFixture(t);
  t.after(() => rmSync(runIdReservation, { recursive: true, force: true }));
  fixture.configure({ rules: [{ tool: "npm", line: "22", prefix: "ci", sleepMs: 4000 }] });
  const callers = ["a", "b", "c", "d"].map((name) => {
    const caller = { name, work: join(fixture.root, `work-${name}`), tmp: join(fixture.root, `tmp-${name}`), evidence: fixture.newEvidence() };
    mkdirSync(caller.work);
    mkdirSync(caller.tmp);
    return caller;
  });
  const exits = await Promise.all(callers.map((caller) => new Promise((resolvePromise) => {
    const child = spawn("bash", [join(fixture.source, "scripts/local-ci.sh"), "verify", "--job", "postgres-node22"], {
      cwd: fixture.source,
      env: fixture.env({ LOCAL_CI_EVIDENCE_DIR: caller.evidence, LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_WORK_DIR: caller.work, TMPDIR: caller.tmp }),
      stdio: "ignore",
    });
    child.once("close", (code) => resolvePromise(code));
  })));
  const outcomes = callers.map((caller, index) => ({ ...caller, code: exits[index], result: readJson(join(caller.evidence, "result.json")) }));
  const winners = outcomes.filter(({ code }) => code === 0);
  const refused = outcomes.filter(({ code }) => code === 2);
  assert.equal(winners.length, 1, JSON.stringify(outcomes.map(({ name, code }) => [name, code])));
  assert.equal(refused.length, callers.length - 1);
  assert.equal(winners[0].result.status, "passed");
  for (const caller of refused) {
    assert.equal(caller.result?.status, "rejected", caller.name);
    assert.equal(caller.result.reason, "run-id-in-use", caller.name);
    assert.deepEqual(readdirSync(caller.work), [], `${caller.name} must not keep a workspace`);
    const docker = fixture.records().filter(({ tool, env }) => tool === "docker" && env.TMPDIR === caller.tmp);
    assert.ok(docker.every(({ args }) => args[0] === "context"), `${caller.name} may only read its Docker endpoint: ${JSON.stringify(docker.map(({ args }) => args))}`);
  }
  assert.equal(existsSync(runIdReservation), false, "the finished run releases its reservation");
});

test("a stale or foreign run-ID reservation is never taken over or removed", (t) => {
  const fixture = makeFixture(t);
  t.after(() => rmSync(runIdReservation, { recursive: true, force: true }));
  mkdirSync(runIdReservation, { recursive: true });
  const owner = join(runIdReservation, "owner.json");
  writeFileSync(owner, JSON.stringify({ owner: "another-run", pid: 1 }));
  const before = readFileSync(owner);
  const run = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 2, run.output);
  assert.equal(run.result?.reason, "run-id-in-use");
  assert.deepEqual(readFileSync(owner), before);
  assert.equal(existsSync(fixture.runWorkspace), false);
  assert.ok(fixture.records().every(({ tool, args }) => tool === "docker" && args[0] === "context"), JSON.stringify(fixture.records()));
});

test("Docker jobs refuse a remote Docker endpoint that a host-local reservation cannot cover", (t) => {
  const fixture = makeFixture(t);
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://ci@docker.example.invalid"]) {
    const run = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, DOCKER_HOST: endpoint } });
    assert.equal(run.status, 2, `${endpoint}: ${run.output}`);
    assert.equal(run.result?.reason, "docker-endpoint-not-local", endpoint);
    assert.deepEqual(fixture.records(), [], endpoint);
    assert.equal(existsSync(runIdReservation), false, endpoint);
  }
  fixture.configure({ dockerEndpoint: "tcp://10.0.0.5:2376" });
  const context = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(context.status, 2, context.output);
  assert.equal(context.result?.reason, "docker-endpoint-not-local", "a remote current Docker context is refused too");

  // DOCKER_CONTEXT overrides DOCKER_HOST in the Docker CLI, so a local DOCKER_HOST proves nothing then.
  fixture.configure({ dockerContexts: { "remote-ci": "tcp://10.0.0.5:2376", "wsl-local": "unix:///var/run/docker.sock" } });
  const combined = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], {
    env: { LOCAL_CI_SOURCE_SHA: fixture.sha, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "remote-ci" },
  });
  assert.equal(combined.status, 2, combined.output);
  assert.equal(combined.result?.reason, "docker-endpoint-ambiguous");
  assert.equal(existsSync(runIdReservation), false);
  const namedRemote = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, DOCKER_CONTEXT: "remote-ci" } });
  assert.equal(namedRemote.status, 2, namedRemote.output);
  assert.equal(namedRemote.result?.reason, "docker-endpoint-not-local");
  const namedLocal = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha, DOCKER_CONTEXT: "wsl-local" } });
  assert.equal(namedLocal.status, 0, namedLocal.output);
  assert.ok(fixture.records().some(({ tool, args }) => tool === "docker" && args.slice(0, 3).join(" ") === "context inspect wsl-local"));
});

test("a run whose cleanup failed keeps its reservation so the run ID cannot be reused", (t) => {
  const fixture = makeFixture(t);
  t.after(() => rmSync(runIdReservation, { recursive: true, force: true }));
  fixture.configure({ rules: [{ tool: "docker", prefix: "rm -f -v", exit: 1 }] });
  const run = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  assert.equal(run.result.status, "failed");
  assert.equal(run.result.cleanup.status, "failed");
  const owner = readFileSync(join(runIdReservation, "owner.json"));
  const reservation = readJson(join(run.evidence, "resources.json")).resources.find(({ kind }) => kind === "run-id-reservation");
  assert.equal(reservation.state, "retained");
  assert.equal(reservation.owner, JSON.parse(owner).owner, "resources.json identifies the exact owner for manual recovery");

  fixture.configure({});
  const second = runLocalCi(fixture, ["verify", "--job", "postgres-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(second.status, 2, second.output);
  assert.equal(second.result?.reason, "run-id-in-use");
  assert.deepEqual(readFileSync(join(runIdReservation, "owner.json")), owner);
});

test("populated or symlinked evidence destinations are refused before anything is scanned, moved or written", (t) => {
  const fixture = makeFixture(t);
  const secret = ["gh", "p_", "Q".repeat(36)].join("");
  const populated = join(fixture.root, "populated");
  mkdirSync(join(populated, "nested"), { recursive: true });
  writeFileSync(join(populated, "notes.txt"), `keep this ${secret}\n`);
  writeFileSync(join(populated, "nested", "data.bin"), Buffer.from([0, 1, 2, 255]));
  const emptyTarget = join(fixture.root, "empty-target");
  mkdirSync(emptyTarget);
  const emptyLink = join(fixture.root, "evidence-link");
  symlinkSync(emptyTarget, emptyLink);
  const populatedLink = join(fixture.root, "populated-link");
  symlinkSync(populated, populatedLink);
  const before = snapshot(populated);
  for (const [name, evidence, message] of [
    ["populated directory", populated, /must be empty/],
    ["symlink to an empty directory", emptyLink, /symbolic link/],
    ["symlink to a populated directory", populatedLink, /symbolic link/],
  ]) {
    const run = runLocalCi(fixture, ["verify"], { evidence, env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
    assert.equal(run.status, 2, `${name}: ${run.output}`);
    assert.match(run.stderr, message, name);
    assert.deepEqual(fixture.records(), [], `${name} must not invoke tools`);
    assert.equal(existsSync(fixture.runWorkspace), false, name);
    assert.equal(existsSync(runIdReservation), false, name);
  }
  assert.deepEqual(snapshot(populated), before, "pre-existing files, including credential-shaped bytes, are preserved exactly");
  assert.deepEqual(readdirSync(emptyTarget), []);
  assert.equal(lstatSync(emptyLink).isSymbolicLink(), true);
});

// Failure cases (written before the fix): automatic and maximum-length run IDs made the Compose project
// `myskills-ci-<run>-<job>-<suffix>` longer than the 63 characters run-fullstack-e2e.mjs accepts, so every
// full-stack and release journey failed at once. IDs are PID-seeded so a real run's reservation is never touched.
const idSeed = createHash("sha256").update(`compose-name-${process.pid}`).digest("hex");
const automaticRunId = `myskills-verify-${idSeed.slice(0, 10)}-1`; // shape and length (28) of real automatic IDs
const maximumRunId = `myskills-verify-${idSeed.slice(10, 40)}-1`; // 48, the longest accepted LOCAL_CI_RUN_ID
const maximumSiblingRunId = `${maximumRunId.slice(0, -1)}2`; // shares the first 47 characters

test("long run IDs give both browser jobs valid, bounded, distinct Compose projects that cleanup owns", (t) => {
  const fixture = makeFixture(t);
  const seen = new Set();
  for (const id of [automaticRunId, maximumRunId, maximumSiblingRunId]) {
    t.after(() => rmSync(join(dirname(runIdReservation), id), { recursive: true, force: true }));
    fixture.configure({});
    const run = runLocalCi(fixture, ["verify", "--job", "web-e2e-node22", "--job", "web-e2e-node24"], {
      env: { LOCAL_CI_RUN_ID: id, LOCAL_CI_SOURCE_SHA: fixture.sha },
    });
    assert.equal(run.status, 0, run.output);
    assert.equal(run.result.runId, id, "the caller's run ID is recorded unchanged");
    assert.equal(run.result.source.sha, fixture.sha);
    const records = fixture.records();
    const used = records.filter(({ tool, args }) => tool === "npm" && args.join(" ") === "run test:e2e:fullstack");
    assert.deepEqual(used.map(({ line }) => line).sort(), ["22", "24"]);
    const projects = used.map(({ env }) => env.MYSKILLS_E2E_COMPOSE_PROJECT);
    for (const project of projects) {
      assertOwnedComposeProject(t, project, id);
      seen.add(project);
    }
    const ledger = JSON.parse(readFileSync(join(run.evidence, "resources.json"), "utf8")).resources
      .filter(({ kind }) => kind === "compose-project").map(({ name }) => name);
    assert.deepEqual(ledger.sort(), [...projects].sort(), "cleanup tracks exactly the names the jobs used");
    const docker = records.filter(({ tool }) => tool === "docker");
    for (const project of projects) {
      assert.ok(docker.some(({ args }) => args[0] === "ps" && args.includes(`label=com.docker.compose.project=${project}`)), project);
      assert.ok(docker.some(({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(`${project}-api`)), project);
    }
  }
  assert.equal(seen.size, 6, "every run ID and browser job gets its own project");

  fixture.configure({});
  const short = runLocalCi(fixture, ["verify", "--job", "web-e2e-node22"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(short.status, 0, short.output);
  const shortProject = fixture.records().find(({ args }) => args.join(" ") === "run test:e2e:fullstack").env.MYSKILLS_E2E_COMPOSE_PROJECT;
  assert.equal(shortProject, `myskills-ci-${runId}-web-e2e-node22-fullstack`, "names that already fit keep their existing form");
});

test("release-check gives its full-stack journey a valid owned Compose project for the longest run ID", (t) => {
  const fixture = makeFixture(t, { tag: true });
  t.after(() => rmSync(join(dirname(runIdReservation), maximumRunId), { recursive: true, force: true }));
  const run = runLocalCi(fixture, ["release-check"], {
    env: { LOCAL_CI_RUN_ID: maximumRunId, LOCAL_CI_SOURCE_SHA: fixture.sha, LOCAL_CI_RELEASE_TAG: releaseTag },
  });
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.runId, maximumRunId);
  const records = fixture.records();
  const project = records.find(({ tool, args }) => tool === "npm" && args.join(" ") === "run release:verify").env.MYSKILLS_E2E_COMPOSE_PROJECT;
  assertOwnedComposeProject(t, project, maximumRunId);
  assertExactCleanup(records.filter(({ tool }) => tool === "docker"), [project]);
});

// Checks a project name against the real full-stack runner (fake Docker that fails at `config`) and the
// runner's leftover rule, which matches the complete run ID as a delimited token.
function assertOwnedComposeProject(t, project, id) {
  assert.ok(project.length <= 63, `${project} has ${project.length} characters`);
  assert.match(project, new RegExp(`(?<![a-z0-9])${id}(?![a-z0-9])`), "the complete run ID stays matchable");
  const dir = mkdtempSync(join(tmpdir(), "myskills-compose-name-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = join(dir, "docker.calls");
  writeShim(join(dir, "docker"), `printf '%s\\n' "$*" >> ${shellQuote(calls)}\nexit 1`);
  const run = spawnSync(process.execPath, [resolve("scripts/run-fullstack-e2e.mjs")], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? dir, MYSKILLS_E2E_COMPOSE_PROJECT: project },
  });
  assert.doesNotMatch(run.stderr, /MYSKILLS_E2E_COMPOSE_PROJECT must be/, project);
  assert.match(existsSync(calls) ? readFileSync(calls, "utf8") : "", new RegExp(`^compose --project-name ${project} `, "m"), `real runner accepts ${project}`);
}

function snapshot(directory) {
  return Object.fromEntries(listFiles(directory).map((file) => [file, sha256(readFileSync(join(directory, file)))]));
}

function makeFixture(t, { tag = false, mcpSmokeTimeoutMs } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myskills-local-ci-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const file of fixtureFiles) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    copyFileSync(resolve(file), join(source, file));
  }
  if (mcpSmokeTimeoutMs !== undefined) {
    const runner = join(source, "scripts/local-ci.mjs");
    writeFileSync(runner, readFileSync(runner, "utf8").replace(/const mcpSmokeTimeoutMs = [\d_]+;/, `const mcpSmokeTimeoutMs = ${mcpSmokeTimeoutMs};`));
  }
  // Controller tests fake only the expensive HOST subprocess. The actual HOST
  // fixture and cleanup module have their own tests; this verifies gating/wiring.
  writeFileSync(join(source, "scripts/rehearse-self-host.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(root,"tools/fake-tool.mjs"))},'host-rehearsal'],{env:{...process.env,FAKE_TOOL_ROOT:${JSON.stringify(root)}}});if(r.status!==0)process.exit(r.status??1);const authProof=JSON.parse(readFileSync(${JSON.stringify(join(root,"fake-config.json"))})).omitHostAuthProof?undefined:{totp:'original-factor-decrypted-and-verified',recoveryCode:'verified',nonownerPrivateArtifact:'denied',revokedSession:'denied'};writeFileSync(process.argv[4],JSON.stringify({status:'passed',sourceCommit:process.argv[5],composedArtifact:JSON.parse(readFileSync(${JSON.stringify(join(root,"fake-config.json"))})).omitHostComposedProof?undefined:{status:'passed',exactObjectBytes:'passed',deniedStorageNoIntent:'passed'},composeInterruption:{cleanup:'complete',client:{actualComposeClient:'interrupted-in-health-wait'}},protectedComposeInputs:{quotedRuntimeAndBootstrapAndBackup:'exact-values'},restore:{restoredApplicationRuntime:'tested',exactPackageBytes:'passed',authProof},upgrade:{forwardMigrations:'passed',authProof}}));`);
  mkdirSync(join(source, "apps/site"), { recursive: true });
  writeFileSync(join(source, "apps/site/package.json"), JSON.stringify({ name: "@myskills-app/site", version: rootPackage.version, private: true }));
  chmodSync(join(source, "scripts/local-ci.sh"), 0o755);
  git(source, "init", "-q", "-b", "main");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "fixture");
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "update-ref", "refs/remotes/origin/main", sha);
  if (tag) git(source, "tag", releaseTag);

  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "fake-tool.mjs"), `(${fakeToolMain.toString()})();\n`);
  const bin = join(root, "bin");
  writeShim(join(bin, "docker"), fakeInvocation(root, "docker"));
  writeShim(join(bin, "codeql"), fakeInvocation(root, "codeql"));
  for (const line of ["22", "24"]) {
    writeShim(join(root, `node${line}`, "node"), nodeShim(`v${line}.99.0`));
    for (const tool of ["npm", "npx"]) writeShim(join(root, `node${line}`, tool), fakeInvocation(root, tool, line));
  }
  writeShim(join(root, "oldnode", "node"), nodeShim("v20.0.0"));
  const work = join(root, "work");
  mkdirSync(work);
  let evidenceCount = 0;
  const recordPath = join(root, "record.jsonl");
  const fixture = {
    root,
    source,
    sha,
    bin,
    runWorkspace: join(work, `myskills-local-ci-${runId}`),
    configure: (config) => {
      writeFileSync(join(root, "fake-config.json"), JSON.stringify(config));
      rmSync(recordPath, { force: true });
    },
    records: () => existsSync(recordPath)
      ? readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [],
    newEvidence: () => join(root, `evidence-${++evidenceCount}`),
    env: (overrides = {}) => {
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME ?? root,
        LOCAL_CI_RUN_ID: runId,
        LOCAL_CI_WORK_DIR: work,
        LOCAL_CI_NODE22_BIN: join(root, "node22"),
        LOCAL_CI_NODE24_BIN: join(root, "node24"),
      };
      if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
      return env;
    },
  };
  fixture.configure({});
  return fixture;
}

function runLocalCi(fixture, args, { env = {}, evidence } = {}) {
  const evidenceDir = evidence ?? fixture.newEvidence();
  const run = spawnSync("bash", [join(fixture.source, "scripts/local-ci.sh"), ...args], {
    cwd: fixture.source,
    encoding: "utf8",
    timeout: 120_000,
    env: fixture.env({ LOCAL_CI_EVIDENCE_DIR: evidenceDir, ...env }),
  });
  const result = readJson(join(resolve(fixture.root, evidenceDir), "result.json"));
  return { ...run, evidence: evidenceDir, result, output: `${run.stdout}\n${run.stderr}` };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing, or a sentinel that the entrypoint must leave untouched.
    return null;
  }
}

function assertMcpSmoke(docker, repository) {
  const run = docker.find(({ args }) => args[0] === "run" && args.at(-1).startsWith(`${repository}:`));
  assert.ok(run, "smoke must start the image's default command");
  assert.ok(run.args.includes("none") && run.args.includes("--network"));
  assert.ok(run.args.includes("PORT=43123"), "exercise Railway's injected port");
  assert.ok(run.args.includes("MYSKILLS_MCP_ALLOWED_HOSTS=127.0.0.1:43123"));
  assert.equal(run.args.some((arg) => ["-p", "--publish", "--entrypoint", "--env-file"].includes(arg)), false);
  const name = run.args[run.args.indexOf("--name") + 1];
  assert.ok(docker.some(({ args }) => args.join(" ") === `exec ${name} node scripts/smoke-mcp-http.mjs`));
}

function assertExactCleanup(docker, projects, { conflicts = [] } = {}) {
  const attempted = docker.filter(({ args }) => args[0] === "run" && args.includes("-d")).map(({ args }) => args[args.indexOf("--name") + 1]);
  assert.ok(attempted.length > 0);
  for (const name of attempted) {
    const removed = docker.some(({ args }) => args[0] === "rm" && args.includes("-f") && (args.includes(name) || args.includes(sha256(name))));
    assert.equal(removed, !conflicts.includes(name), `container ${name}`);
  }
  const tags = docker.filter(({ args }) => args[0] === "build").map(({ args }) => args[args.indexOf("--tag") + 1]);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.ok(docker.some(({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(tag)), `image ${tag} must be removed`);
  }
  for (const project of projects) {
    assert.ok(docker.some(({ args }) => args[0] === "ps" && args.includes(`label=com.docker.compose.project=${project}`)), project);
    for (const service of ["api", "web", "mcp"]) {
      assert.ok(docker.some(({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(`${project}-${service}`)), `${project}-${service}`);
    }
  }
  for (const { args } of docker) {
    assert.equal(args.some((arg) => /prune/.test(arg)), false, args.join(" "));
    assert.notEqual(args[0], "system");
    args.forEach((arg, index) => {
      if (args[index - 1] !== "--filter") return;
      assert.ok(projects.some((project) => arg === `label=com.docker.compose.project=${project}`), `filter ${arg} must be exact`);
    });
  }
}

function assertNoPublication(records) {
  for (const { tool, args } of records) {
    assert.equal(tool === "docker" && ["push", "login"].includes(args[0]), false, args.join(" "));
    assert.equal(tool === "npm" && ["publish", "login"].includes(args[0]), false, args.join(" "));
  }
}

function assertEvidenceManifest(evidence, result) {
  const files = listFiles(evidence).filter((file) => file !== "result.json");
  assert.deepEqual(result.artifacts.map(({ path }) => path).sort(), files.sort());
  for (const artifact of result.artifacts) {
    assert.equal(sha256(readFileSync(join(evidence, artifact.path))), artifact.sha256, artifact.path);
  }
}

function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(join(directory, entry.name), path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function isInside(child, parent) {
  // Clone directories are gone after the run; the fixture root is already a real path.
  const path = relative(realpathSync(parent), child);
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep) && !path.includes(`..${sep}`));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Timed out waiting for the fixture step to start.");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", [
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], { cwd, encoding: "utf8" }).trim();
}

function writeShim(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function fakeInvocation(root, tool, line = "") {
  return [
    `FAKE_TOOL_ROOT=${shellQuote(root)}`,
    `FAKE_LINE=${line}`,
    "export FAKE_TOOL_ROOT FAKE_LINE",
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(root, "tools", "fake-tool.mjs"))} ${tool} "$@"`,
  ].join("\n");
}

function nodeShim(version) {
  return `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexec ${shellQuote(process.execPath)} "$@"`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Serialized into each fixture. It records every call and simulates tool outcomes only;
// the entrypoint's decisions (ordering, statuses, cleanup, evidence) are what the tests assert.
async function fakeToolMain() {
  const { spawnSync: spawnTool } = await import("node:child_process");
  const { createHash: hash } = await import("node:crypto");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const [tool, ...args] = process.argv.slice(2);
  const root = process.env.FAKE_TOOL_ROOT;
  const line = process.env.FAKE_LINE || null;
  const config = JSON.parse(fs.readFileSync(path.join(root, "fake-config.json"), "utf8"));
  const key = args.join(" ");
  const env = {};
  for (const name of ["CI", "TEST_DATABASE_URL", "MYSKILLS_E2E_COMPOSE_PROJECT", "RELEASE_REQUIRE_TAG", "RELEASE_EXPECTED_TAG", "PLAYWRIGHT_JSON_OUTPUT_FILE", "HOME", "TMPDIR", "DOCKER_CONFIG", "DOCKER_CONTEXT", "MYSKILLS_SITE_TEST_PORT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const canarySeen = Boolean(config.canary) && Object.values(process.env).some((value) => String(value).includes(config.canary));
  const head = tool === "npm" && fs.existsSync(".git")
    ? spawnTool("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    : undefined;
  fs.appendFileSync(path.join(root, "record.jsonl"), `${JSON.stringify({ tool, args, line, cwd: process.cwd(), pid: process.pid, env, canarySeen, head })}\n`);

  if (tool === "docker" && config.requiredDockerContext) {
    let dockerConfig;
    try {
      dockerConfig = JSON.parse(fs.readFileSync(path.join(process.env.DOCKER_CONFIG ?? path.join(process.env.HOME, ".docker"), "config.json"), "utf8"));
    } catch {
      process.stderr.write("Docker context configuration unavailable in this HOME.\n");
      process.exit(125);
    }
    const selected = process.env.DOCKER_CONTEXT ?? dockerConfig.currentContext;
    if (selected !== config.requiredDockerContext || !dockerConfig.contexts.includes(selected)) {
      process.stderr.write("Docker context unavailable.\n");
      process.exit(125);
    }
  }

  const rule = (config.rules ?? []).find((candidate) => candidate.tool === tool
    && (!candidate.line || candidate.line === line) && key.startsWith(candidate.prefix));
  if (rule?.stdout) process.stdout.write(`${rule.stdout}\n`);
  if (rule?.sleepMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, rule.sleepMs));
  if (rule && rule.exit !== undefined) process.exit(rule.exit);
  process.exit(simulate());

  function simulate() {
    if (tool === "npm") {
      if (key === "--version") return print((config.npmVersion ?? {})[line] ?? "11.12.1");
      if (key === "run test:e2e -w @myskills-app/web -- --reporter=line,json") {
        if (!(config.omitMockedReport ?? []).includes(line)) writeReport("apps/web/test-results/mocked-report.json");
        return 0;
      }
      if (key === "run test:e2e -w @myskills-app/site -- --reporter=line,json") {
        if (!(config.omitSiteReport ?? []).includes(line)) writeReport("apps/site/test-results/site-report.json");
        return 0;
      }
      if (key === "run test:e2e:fullstack") {
        writeReport("apps/web/test-results/fullstack-report.json");
        if (config.omitFullstackReport !== "operational") writeReport("apps/web/test-results/fullstack-operational-report.json");
        if (config.omitFullstackReport !== "improvement") writeReport("apps/web/test-results/fullstack-improvement-report.json");
        writeReport("apps/web/test-results/fullstack-connector-report.json");
        return 0;
      }
      if (key === "run release:verify") return real(["scripts/verify-release.mjs"]);
      if (key.startsWith("run release:artifacts -- ")) {
        const status = real(["scripts/create-release-artifacts.mjs", ...args.slice(3)]);
        if (status === 0 && config.tamperReleaseArchive) {
          const output = valueAfter("--out");
          const archive = fs.readdirSync(output).find((name) => name.endsWith(".tar"));
          fs.appendFileSync(path.join(output, archive), "x");
        }
        return status;
      }
      return 0;
    }
    if (tool === "docker") {
      if (args[0] === "version") return print("28.3.0");
      if (args[0] === "context" && args[1] === "inspect") {
        const name = args[2] === "--format" ? null : args[2];
        return print((name ? config.dockerContexts?.[name] : config.dockerEndpoint) ?? "unix:///var/run/docker.sock");
      }
      if (args[0] === "run" && args.includes("-d")) {
        if ((config.dockerConflicts ?? []).includes(valueAfter("--name"))) {
          process.stderr.write("Conflict. The container name is already in use.\n");
          return 125;
        }
        return print("c".repeat(64));
      }
      if (args[0] === "container" && args[1] === "inspect") {
        const name = args.at(-1);
        if (config.smokeReadback === "unavailable") return 1;
        if (config.smokeReadback === "absent") { process.stderr.write("No such container\n"); return 1; }
        if (config.smokeReadback === "malformed") return print("invalid JSON");
        const records = fs.readFileSync(path.join(root, "record.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        const started = records.find((record) => record.tool === "docker" && record.args[0] === "run" && record.args.includes(name));
        const label = (key) => started?.args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
        return print(JSON.stringify({ id: hash("sha256").update(name).digest("hex"), runId: label("io.myskills.local-ci.run-id"), owner: config.smokeReadback === "foreign" || (config.dockerConflicts ?? []).includes(name) ? "foreign-owner" : label("io.myskills.local-ci.owner") }));
      }
      if (args[0] === "inspect") return print("healthy");
      if (args[0] === "port") return print("127.0.0.1:55432");
      if (args[0] === "image" && args[1] === "inspect") return print(`sha256:${hash("sha256").update(args.at(-1)).digest("hex")}`);
      return 0;
    }
    if (tool === "codeql") {
      if (args[0] === "version") return print(JSON.stringify({ version: "2.99.0" }));
      if (args[0] === "database" && args[1] === "create") {
        fs.copyFileSync(option("--codescanning-config"), path.join(root, "codeql-config.yml"));
        fs.mkdirSync(args[2], { recursive: true });
        return 0;
      }
      if (args[0] === "database" && args[1] === "analyze") {
        const rules = (config.codeqlRules ?? ["js/sql-injection"]).map((id) => ({ id }));
        const results = Array.from({ length: config.codeqlFindings ?? 0 }, (_, index) => ({
          ruleId: "js/insufficient-password-hash",
          locations: [{ physicalLocation: { artifactLocation: { uri: "packages/auth/src/session-token.ts" }, region: { startLine: 13 + index } } }],
        }));
        const sarif = {
          version: "2.1.0",
          runs: [{
            tool: { driver: { name: "CodeQL", rules: [] }, extensions: [{ name: "codeql/javascript-queries", rules }] },
            automationDetails: { id: `${option("--sarif-category")}/` },
            results,
          }],
        };
        fs.writeFileSync(option("--output"), JSON.stringify(sarif));
        return 0;
      }
    }
    return 0;
  }

  function print(text) {
    process.stdout.write(`${text}\n`);
    return 0;
  }

  function writeReport(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      errors: [],
      suites: [{ title: "fixture", specs: [{ title: "journey", file: "fixture.spec.ts", line: 1, column: 1, tests: [{
        projectName: "chromium", expectedStatus: "passed", status: "expected", results: [{ status: "passed", retry: 0, duration: 1 }],
      }] }] }],
    }));
  }

  function real(scriptArgs) {
    return spawnTool(process.execPath, scriptArgs, { stdio: "inherit" }).status ?? 1;
  }

  function valueAfter(flag) {
    return args[args.indexOf(flag) + 1];
  }

  function option(name) {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    return inline ? inline.slice(name.length + 1) : valueAfter(name);
  }
}
