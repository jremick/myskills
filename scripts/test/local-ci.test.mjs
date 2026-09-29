import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

const runId = "fixture-run";
const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const releaseTag = `v${rootPackage.version}`;
const verifyJobs = ["check-node22", "check-node24", "web-e2e-node22", "web-e2e-node24", "postgres-node22", "postgres-node24", "railway-images"];
const fixtureFiles = [
  "package.json",
  ".gitignore",
  ".github/codeql/codeql-config.yml",
  "scripts/local-ci.sh",
  "scripts/local-ci.mjs",
  "scripts/lib/secret-patterns.mjs",
  "scripts/collect-browser-evidence.mjs",
  "scripts/create-release-artifacts.mjs",
  "scripts/verify-release.mjs",
];
const webBuild = "run build -w @myskills-app/core -w @myskills-app/auth -w @myskills-app/skill-package -w @myskills-app/api";
const mockedBrowser = "run test:e2e -w @myskills-app/web -- --reporter=line,json";

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
  assert.equal(result.gating, true);
  assert.deepEqual(result.gatingBlockers, []);
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
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.web") && build.includes("--build-arg VITE_API_BASE_URL=/api")));
  assert.ok(builds.some((build) => build.includes("--file Dockerfile.backup")));
  assert.equal(docker.filter(({ args }) => args[0] === "run" && args.includes("--rm") && args.includes("--network") && args.includes("none")).length, 2);
  assertNoPublication(records);

  for (const line of ["22", "24"]) {
    for (const phase of ["mocked", "fullstack"]) {
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

test("job failures are isolated, fail the gating contexts and never remove another run's container", (t) => {
  const fixture = makeFixture(t);
  const conflicting = `myskills-ci-${runId}-postgres-node22-postgres`;
  fixture.configure({
    rules: [{ tool: "npm", line: "24", prefix: "run check", exit: 1 }],
    omitMockedReport: ["22"],
    dockerConflicts: [conflicting],
  });
  const run = runLocalCi(fixture, ["verify"], { env: { LOCAL_CI_SOURCE_SHA: fixture.sha } });
  assert.equal(run.status, 1, run.output);
  const { result } = run;
  assert.equal(result.status, "failed");
  assert.equal(result.gating, true, "a pinned complete run is authoritative even when it fails");
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

test("partial or unpinned runs never report the required contexts", (t) => {
  const fixture = makeFixture(t);
  const run = runLocalCi(fixture, ["verify", "--job", "check-node22"]);
  assert.equal(run.status, 0, run.output);
  assert.equal(run.result.status, "passed");
  assert.equal(run.result.complete, false);
  assert.equal(run.result.gating, false);
  assert.deepEqual([...run.result.gatingBlockers].sort(), ["partial-job-selection", "source-sha-not-supplied"]);
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
  assert.equal(run.result.gating, true);
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
  for (const file of ["Dockerfile.api", "Dockerfile.web", "Dockerfile.backup"]) assert.ok(builds.some((build) => build.includes(`--file ${file} `)), file);
  assert.equal(docker.filter(({ args }) => args[0] === "run" && args.includes("--rm") && args.includes("none")).length, 2);
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

function makeFixture(t, { tag = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myskills-local-ci-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const file of fixtureFiles) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    copyFileSync(resolve(file), join(source, file));
  }
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

function assertExactCleanup(docker, projects, { conflicts = [] } = {}) {
  const attempted = docker.filter(({ args }) => args[0] === "run" && args.includes("-d")).map(({ args }) => args[args.indexOf("--name") + 1]);
  assert.ok(attempted.length > 0);
  for (const name of attempted) {
    const removed = docker.some(({ args }) => args[0] === "rm" && args.includes("-f") && args.includes(name));
    assert.equal(removed, !conflicts.includes(name), `container ${name}`);
  }
  const tags = docker.filter(({ args }) => args[0] === "build").map(({ args }) => args[args.indexOf("--tag") + 1]);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    assert.ok(docker.some(({ args }) => args[0] === "image" && args[1] === "rm" && args.includes(tag)), `image ${tag} must be removed`);
  }
  for (const project of projects) {
    assert.ok(docker.some(({ args }) => args[0] === "ps" && args.includes(`label=com.docker.compose.project=${project}`)), project);
    for (const service of ["api", "web"]) {
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
  for (const name of ["CI", "TEST_DATABASE_URL", "MYSKILLS_E2E_COMPOSE_PROJECT", "RELEASE_REQUIRE_TAG", "RELEASE_EXPECTED_TAG", "PLAYWRIGHT_JSON_OUTPUT_FILE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const canarySeen = Boolean(config.canary) && Object.values(process.env).some((value) => String(value).includes(config.canary));
  const head = tool === "npm" && fs.existsSync(".git")
    ? spawnTool("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()
    : undefined;
  fs.appendFileSync(path.join(root, "record.jsonl"), `${JSON.stringify({ tool, args, line, cwd: process.cwd(), pid: process.pid, env, canarySeen, head })}\n`);

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
      if (key === "run test:e2e:fullstack") {
        writeReport("apps/web/test-results/fullstack-report.json");
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
      if (args[0] === "run" && args.includes("-d")) {
        if ((config.dockerConflicts ?? []).includes(valueAfter("--name"))) {
          process.stderr.write("Conflict. The container name is already in use.\n");
          return 125;
        }
        return print("c".repeat(64));
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
