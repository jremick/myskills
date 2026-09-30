#!/usr/bin/env node

// Portable equivalent of the GitHub Actions CI, release and CodeQL gates. Invoke it through
// scripts/local-ci.sh; docs/LOCAL_CI.md describes the inputs, jobs and result contract.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, homedir, platform, release as osRelease, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { secretPatterns } from "./lib/secret-patterns.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jobCatalog = {
  verify: ["check-node22", "postgres-node22", "web-e2e-node22", "check-node24", "postgres-node24", "web-e2e-node24", "railway-images"],
  "release-check": ["release"],
  codeql: ["codeql-javascript-typescript"],
};
const contextJobs = {
  check: jobCatalog.verify,
  "web-e2e": ["web-e2e-node22", "web-e2e-node24"],
  "postgres-integration": ["postgres-node22", "postgres-node24"],
};
// The measured four-lane verify plan. The controller still holds one global worker lock around
// the whole invocation; this does not allow separate app runs to overlap on the Docker daemon.
const verifyLanes = [
  ["web-e2e-node22"],
  ["web-e2e-node24"],
  ["postgres-node22", "check-node22"],
  ["postgres-node24", "check-node24", "railway-images"],
];
const browserPortNames = ["MYSKILLS_E2E_PORT", "MYSKILLS_E2E_WEB_PORT", "MYSKILLS_E2E_MAILPIT_PORT"];
const usage = `Usage: scripts/local-ci.sh <verify|release-check|codeql> [--job <id>]...

Jobs:
  verify         ${jobCatalog.verify.join(", ")}
  release-check  ${jobCatalog["release-check"].join(", ")}
  codeql         ${jobCatalog.codeql.join(", ")}

Required environment: LOCAL_CI_RUN_ID, LOCAL_CI_EVIDENCE_DIR. See docs/LOCAL_CI.md.`;
const runIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const composeProjectMaxLength = 63;
const webE2eTimeoutMs = 15 * 60_000;
const alwaysStepTimeoutMs = 60_000;
const mcpSmokeTimeoutMs = 30_000;
const killGraceMs = 10_000;
const maxLogBytes = 64 * 1024 * 1024;
const maxPendingLine = 1024 * 1024;
const codeqlSuiteLine = "\nqueries:\n  - uses: security-extended\n";
const defaultCodeqlCategory = "/language:javascript-typescript";
const composeServiceImages = ["api", "web", "mcp", "minio", "minio-init"];
// Run IDs are reserved here, independent of TMPDIR and LOCAL_CI_WORK_DIR: exclusive mkdir on the local
// filesystem is atomic, which Docker resource names are not. It covers only a local Docker daemon.
const runIdLockRoot = "/var/tmp/myskills-local-ci-locks";
const dockerJobPattern = /^(?:(?:postgres|web-e2e)-node2[24]|railway-images|release)$/;
// Only these variables reach job processes; runner tokens stay with the runner.
const passthroughEnv = [
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "BUILDKIT_PROGRESS",
  "PLAYWRIGHT_BROWSERS_PATH", "npm_config_cache", "NPM_CONFIG_CACHE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "MYSKILLS_E2E_BROWSER_EXECUTABLE",
];
const compiledSecretPatterns = secretPatterns.map(({ pattern }) => new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));

class Rejection extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const state = {
  cancelled: false,
  signal: null,
  activeSteps: new Set(),
};

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const runId = process.env.LOCAL_CI_RUN_ID ?? "";
  if (!runIdPattern.test(runId)) {
    console.error("LOCAL_CI_RUN_ID must be 1-48 lowercase letters, digits or hyphens, starting and ending with a letter or digit.");
    return 2;
  }
  let evidence;
  try {
    evidence = validateEvidenceDirectory(process.env.LOCAL_CI_EVIDENCE_DIR);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  mkdirSync(evidence, { recursive: true });

  const startedAt = new Date().toISOString();
  const base = { schemaVersion: 1, app: "myskills", mode: options.mode, runId, selectedJobs: options.jobs, startedAt };
  let run;
  try {
    run = prepareRun(options, runId, evidence);
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    console.error(error.message);
    writeJsonAtomic(join(evidence, "result.json"), {
      ...base, status: "rejected", reason: error.reason, message: error.message, gating: false,
      jobs: [], contexts: null, artifacts: [], finishedAt: new Date().toISOString(),
    });
    return 2;
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => cancel(signal));
  }
  return executeRun(run, base);
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (mode === "--help" || mode === "-h") return { help: true };
  if (!Object.hasOwn(jobCatalog, mode ?? "")) throw new Error(usage);
  const requested = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    let value;
    if (arg === "--job") value = rest[++index];
    else if (arg.startsWith("--job=")) value = arg.slice("--job=".length);
    else throw new Error(usage);
    if (!jobCatalog[mode].includes(value)) {
      throw new Error(`Unknown job for ${mode}. Choose from: ${jobCatalog[mode].join(", ")}.`);
    }
    requested.push(value);
  }
  const jobs = requested.length > 0 ? jobCatalog[mode].filter((id) => requested.includes(id)) : [...jobCatalog[mode]];
  return { mode, jobs, complete: jobs.length === jobCatalog[mode].length };
}

function validateEvidenceDirectory(value) {
  if (!value) throw new Error("LOCAL_CI_EVIDENCE_DIR is required and must be absolute.");
  if (!isAbsolute(value)) throw new Error("LOCAL_CI_EVIDENCE_DIR must be absolute.");
  const target = resolve(value);
  let entry = null;
  try {
    entry = lstatSync(target);
  } catch {
    // Absent: created exclusively below.
  }
  if (entry?.isSymbolicLink()) throw new Error("LOCAL_CI_EVIDENCE_DIR must not be a symbolic link; pass the real directory path.");
  const real = realPathAllowingMissing(target);
  const source = realpathSync(sourceRoot);
  if (isWithin(real, source) || isWithin(source, real)) {
    throw new Error("LOCAL_CI_EVIDENCE_DIR must be outside the source tree and must not contain it.");
  }
  if (!entry) {
    mkdirSync(dirname(real), { recursive: true });
    try {
      mkdirSync(real);
      return real;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      entry = lstatSync(real);
      if (entry.isSymbolicLink()) throw new Error("LOCAL_CI_EVIDENCE_DIR must not be a symbolic link; pass the real directory path.", { cause: error });
    }
  }
  if (!entry.isDirectory()) throw new Error("LOCAL_CI_EVIDENCE_DIR must be a directory.");
  if (existsSync(join(real, "result.json"))) {
    throw new Error("LOCAL_CI_EVIDENCE_DIR already contains result.json; use a new directory for each run.");
  }
  // Every file below the evidence directory is scanned, may be removed as quarantine, and is exported.
  if (readdirSync(real).length > 0) throw new Error("LOCAL_CI_EVIDENCE_DIR must be empty or absent; it contains files that the run did not write.");
  return real;
}

function prepareRun(options, runId, evidence) {
  const laneCount = process.env.LOCAL_CI_VERIFY_LANES ?? "1";
  if (!["1", "4"].includes(laneCount) || (laneCount === "4" && options.mode !== "verify")) {
    throw new Rejection("invalid-verify-lanes", "LOCAL_CI_VERIFY_LANES must be 1 (serial) or 4 (verify only).");
  }
  if (laneCount === "4" && options.jobs.filter((id) => id.startsWith("web-e2e-")).length > 1
    && browserPortNames.some((name) => process.env[name] !== undefined)) {
    throw new Rejection("parallel-port-override", "Parallel browser jobs need automatic distinct ports; unset MYSKILLS_E2E_PORT, MYSKILLS_E2E_WEB_PORT and MYSKILLS_E2E_MAILPIT_PORT.");
  }
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(sourceRoot)) {
    throw new Rejection("source-not-repository", "The entrypoint must run from its own git checkout.");
  }
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  const expectedSha = process.env.LOCAL_CI_SOURCE_SHA || null;
  if (expectedSha !== null) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expectedSha)) {
      throw new Rejection("invalid-source-sha", "LOCAL_CI_SOURCE_SHA must be a full lowercase commit SHA.");
    }
    if (expectedSha !== head) throw new Rejection("source-sha-mismatch", "LOCAL_CI_SOURCE_SHA does not match HEAD.");
  }
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0 || status.stdout.trim() !== "") {
    throw new Rejection("dirty-source", "The checkout has uncommitted or untracked files. Local CI tests commits only; commit the change first.");
  }
  const rootPackage = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const npmVersion = /^npm@(\d+\.\d+\.\d+)$/.exec(String(rootPackage.packageManager ?? ""))?.[1];
  if (!npmVersion) throw new Rejection("invalid-package-manager", "package.json packageManager must pin an exact npm version.");

  const run = {
    ...options,
    runId,
    evidence,
    head,
    expectedSha,
    rootPackage,
    npmVersion,
    laneCount: Number(laneCount),
    browserPorts: new Set(),
    gatingBlockers: [
      ...(options.complete ? [] : ["partial-job-selection"]),
      ...(expectedSha ? [] : ["source-sha-not-supplied"]),
      ...(platform() === "linux" && arch() === "x64" ? [] : ["unsupported-host-platform"]),
    ],
  };
  if (options.mode === "release-check") run.release = validateRelease(head, rootPackage);
  if (options.mode === "codeql") run.codeql = validateCodeql();
  if (options.jobs.some((id) => dockerJobPattern.test(id))) requireLocalDocker();
  run.runIdLock = reserveRunId(runId);
  try {
    run.workspace = reserveWorkspace(runId, evidence);
  } catch (error) {
    releaseRunId(run.runIdLock);
    throw error;
  }
  return run;
}

// The run-ID reservation is host-local, so Docker jobs must use this host's daemon. The Docker CLI lets
// DOCKER_CONTEXT override DOCKER_HOST; both together are refused rather than guessed.
function requireLocalDocker() {
  const { DOCKER_HOST: host, DOCKER_CONTEXT: context } = process.env;
  if (host && context) {
    throw new Rejection("docker-endpoint-ambiguous", "Set only one of DOCKER_HOST and DOCKER_CONTEXT for Docker jobs; DOCKER_CONTEXT would override DOCKER_HOST.");
  }
  const format = ["--format", "{{.Endpoints.docker.Host}}"];
  const endpoint = context ? docker(["context", "inspect", context, ...format]).stdout.trim()
    : host || docker(["context", "inspect", ...format]).stdout.trim();
  if (!endpoint.startsWith("unix://")) {
    throw new Rejection("docker-endpoint-not-local", "Docker jobs need a local unix:// Docker endpoint; the run-ID reservation is host-local and cannot cover a remote daemon.");
  }
}

function reserveRunId(runId) {
  try {
    mkdirSync(runIdLockRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Rejection("run-id-lock-unavailable", `Cannot create ${runIdLockRoot}: ${error.code ?? error.message}.`);
  }
  const root = lstatSync(runIdLockRoot);
  if (root.isSymbolicLink() || !root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o022) !== 0) {
    throw new Rejection("run-id-lock-unavailable", `${runIdLockRoot} must be a real directory owned by this user and not writable by group or others.`);
  }
  const path = join(runIdLockRoot, runId);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Rejection("run-id-in-use", `LOCAL_CI_RUN_ID is already reserved on this host (${path}). Use a new run ID. After a killed run, remove the resources in its resources.json and then this reservation; it is never taken over.`);
    }
    throw new Rejection("run-id-lock-unavailable", `Cannot reserve the run ID: ${error.code ?? error.message}.`);
  }
  const owner = randomBytes(16).toString("hex");
  writeFileSync(join(path, "owner.json"), `${JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
  return { path, owner };
}

// Removes the reservation only when it still carries this run's owner token.
function releaseRunId(lock) {
  try {
    if (JSON.parse(readFileSync(join(lock.path, "owner.json"), "utf8")).owner !== lock.owner) return false;
    rmSync(lock.path, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function validateRelease(head, rootPackage) {
  const tag = process.env.LOCAL_CI_RELEASE_TAG ?? "";
  if (!tag) throw new Rejection("release-tag-required", "LOCAL_CI_RELEASE_TAG is required for release-check.");
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(tag)) throw new Rejection("invalid-release-tag", "LOCAL_CI_RELEASE_TAG is not a release tag.");
  if (tag !== `v${rootPackage.version}`) {
    throw new Rejection("release-tag-version-mismatch", `LOCAL_CI_RELEASE_TAG must equal v${rootPackage.version}.`);
  }
  const tagCommit = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  if (tagCommit.status !== 0 || tagCommit.stdout.trim() !== head) {
    throw new Rejection("release-tag-not-at-head", "The release tag must exist and point at HEAD.");
  }
  const mainRef = process.env.LOCAL_CI_MAIN_REF || "refs/remotes/origin/main";
  if (!mainRef.startsWith("refs/") || git(["check-ref-format", mainRef]).status !== 0) {
    throw new Rejection("invalid-main-ref", "LOCAL_CI_MAIN_REF must be a full ref name such as refs/remotes/origin/main.");
  }
  const main = git(["rev-parse", "--verify", "--quiet", `${mainRef}^{commit}`]);
  if (main.status !== 0) throw new Rejection("main-ref-unavailable", "LOCAL_CI_MAIN_REF does not resolve to a commit in this checkout.");
  const mainSha = main.stdout.trim();
  const ancestry = git(["merge-base", "--is-ancestor", head, mainSha]);
  if (ancestry.status === 1) throw new Rejection("not-on-main", "The tagged commit is not an ancestor of the main ref.");
  if (ancestry.status !== 0) throw new Rejection("main-ancestry-unverified", "Main ancestry could not be verified; the checkout may be shallow.");
  return { tag, mainRef, mainSha };
}

function validateCodeql() {
  const bin = process.env.LOCAL_CI_CODEQL_BIN ?? "";
  if (!isAbsolute(bin) || !isExecutable(bin)) {
    throw new Rejection("codeql-cli-unavailable", "LOCAL_CI_CODEQL_BIN must be the absolute path of a CodeQL CLI bundle executable.");
  }
  const category = process.env.LOCAL_CI_CODEQL_CATEGORY || defaultCodeqlCategory;
  if (!/^[A-Za-z0-9/:._-]{1,200}$/.test(category)) throw new Rejection("invalid-codeql-category", "LOCAL_CI_CODEQL_CATEGORY contains unsupported characters.");
  const configText = readFileSync(join(sourceRoot, ".github/codeql/codeql-config.yml"), "utf8");
  if (/^queries\s*:/m.test(configText)) {
    throw new Rejection("codeql-config-unsupported", "The CodeQL config already declares queries; the security-extended suite cannot be appended safely.");
  }
  const excludedRules = [...configText.matchAll(/-\s*exclude:\s*\n\s+id:\s*([^\s#]+)/g)].map((match) => match[1]);
  return { bin, category, excludedRules };
}

function reserveWorkspace(runId, evidence) {
  const input = process.env.LOCAL_CI_WORK_DIR || tmpdir();
  if (!isAbsolute(input) || !existsSync(input) || !statSync(input).isDirectory()) {
    throw new Rejection("invalid-work-dir", "LOCAL_CI_WORK_DIR must be an existing absolute directory.");
  }
  const workRoot = realpathSync(input);
  if (isWithin(workRoot, realpathSync(sourceRoot)) || isWithin(workRoot, evidence)) {
    throw new Rejection("invalid-work-dir", "LOCAL_CI_WORK_DIR must be outside the source tree and the evidence directory.");
  }
  const workspace = join(workRoot, `myskills-local-ci-${runId}`);
  try {
    // Exclusive creation doubles as the per-host lock for this run ID.
    mkdirSync(workspace);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Rejection("run-workspace-exists", "A workspace for this LOCAL_CI_RUN_ID already exists; use a new run ID or clean up the earlier run.");
    }
    throw error;
  }
  return workspace;
}

async function executeRun(run, base) {
  const ledger = new ResourceLedger(join(run.evidence, "resources.json"), run.runId);
  const reservation = ledger.track("run-id-reservation", run.runIdLock.path, null, "created");
  reservation.owner = run.runIdLock.owner;
  ledger.track("workspace", run.workspace, null, "created");
  mkdirSync(join(run.evidence, "logs"), { recursive: true });
  const environment = collectEnvironment(run);
  const results = new Map();
  const failureReasons = [];
  const sinks = [];
  console.log(`[local-ci] ${run.mode} ${run.runId}: ${run.jobs.join(", ")}`);
  const lanes = run.laneCount === 4 ? verifyLanes.map((lane) => lane.filter((id) => run.jobs.includes(id))) : [run.jobs];
  // Wait for every lane even on an internal error. Cleanup must never race a still-running job.
  const outcomes = await Promise.allSettled(lanes.map(async (lane) => {
    for (const id of lane) {
      if (state.cancelled) {
        results.set(id, { id, status: "not-run", reason: "cancelled", steps: [] });
      } else {
        const job = new JobContext(id, run, ledger, environment);
        sinks.push({ id, sink: job.sink });
        results.set(id, await job.execute());
      }
    }
  }));
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") failureReasons.push(`internal-error: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
  }
  const jobs = run.jobs.map((id) => results.get(id) ?? { id, status: "not-run", reason: "internal-error", steps: [] });

  const cleanupFailures = ledger.cleanup(new LogSink(null));
  try {
    rmSync(run.workspace, { recursive: true, force: true });
    ledger.mark(ledger.find("workspace", run.workspace), "removed");
  } catch (error) {
    ledger.mark(ledger.find("workspace", run.workspace), "remove-failed");
    cleanupFailures.push(`workspace: ${error.code ?? error.message}`);
  }
  // Removals that failed during job cleanup count too; they are not retried here.
  for (const entry of ledger.resources) {
    const failure = `${entry.kind} ${entry.name}`;
    if (entry.state === "remove-failed" && !cleanupFailures.includes(failure) && !failure.startsWith("workspace ")) cleanupFailures.push(failure);
  }
  // While known resources remain, keep the run ID reserved so another run cannot reuse their names.
  if (cleanupFailures.length > 0) {
    ledger.mark(reservation, "retained");
  } else if (releaseRunId(run.runIdLock)) {
    ledger.mark(reservation, "removed");
  } else {
    ledger.mark(reservation, "remove-failed");
    cleanupFailures.push("run-id-reservation");
  }
  writeJsonAtomic(join(run.evidence, "environment.json"), environment);

  for (const job of jobs) {
    if (job.status !== "passed" && job.status !== "not-run") failureReasons.push(`job-${job.status}:${job.id}`);
  }
  for (const { id, sink } of sinks) {
    if (sink.redactions > 0) failureReasons.push(`secret-pattern-redacted:${id}`);
  }
  for (const path of scanEvidenceForSecrets(run.evidence)) failureReasons.push(`secret-pattern-in-evidence:${path}`);
  if (cleanupFailures.length > 0) failureReasons.push("cleanup-failed");

  const allPassed = jobs.length === run.jobs.length && jobs.every(({ status }) => status === "passed");
  const status = state.cancelled ? "cancelled" : allPassed && failureReasons.length === 0 ? "passed" : "failed";
  // Redaction, quarantine, cleanup and internal failures cannot be attributed safely, so they fail every context.
  const runLevelFailure = failureReasons.some((reason) => !reason.startsWith("job-"));
  const contexts = run.mode === "verify" && run.complete ? Object.fromEntries(Object.entries(contextJobs).map(([name, ids]) => [
    name,
    status === "cancelled" ? "cancelled"
      : !runLevelFailure && ids.every((id) => jobs.find((job) => job.id === id)?.status === "passed") ? "passed" : "failed",
  ])) : null;
  const result = {
    ...base,
    status,
    gating: run.gatingBlockers.length === 0,
    gatingBlockers: run.gatingBlockers,
    complete: run.complete,
    source: { sha: run.head, expectedSha: run.expectedSha, packageVersion: run.rootPackage.version },
    ...(run.release ? { release: run.release } : {}),
    jobs,
    contexts,
    failureReasons,
    cleanup: { status: cleanupFailures.length === 0 ? "complete" : "failed", failures: cleanupFailures },
    artifacts: manifest(run.evidence),
    finishedAt: new Date().toISOString(),
  };
  writeJsonAtomic(join(run.evidence, "result.json"), result);
  console.log(`[local-ci] ${status}: ${run.evidence}/result.json`);
  if (status === "cancelled") return 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[state.signal] ?? 15);
  return status === "passed" ? 0 : 1;
}

class JobContext {
  constructor(id, run, ledger, environment) {
    this.id = id;
    this.run = run;
    this.ledger = ledger;
    this.environment = environment;
    this.sink = new LogSink(join(run.evidence, "logs", `${id}.log`));
    this.steps = [];
    this.reason = null;
    this.timedOut = false;
    this.cancelled = false;
    this.toolchain = null;
    this.clone = null;
    this.deadline = id.startsWith("web-e2e-") ? Date.now() + webE2eTimeoutMs : null;
    this.details = {};
    this.privateEnvironment = {};
    if (run.laneCount === 4) {
      // Keep TMPDIR short enough for the Unix sockets used by test tooling. The controller supplies
      // its own short run TMPDIR; every job gets an exclusively created child recorded for cleanup.
      const directory = mkdtempSync(join(tmpdir(), "msci-"));
      ledger.track("job-directory", directory, id, "created");
      for (const name of ["h", "t", "r"]) mkdirSync(join(directory, name), { mode: 0o700 });
      this.privateEnvironment = {
        HOME: join(directory, "h"), TMPDIR: join(directory, "t"),
        // Docker contexts/plugins must come from the same config used by preflight and cleanup,
        // even when it was implicit under the caller's HOME. Preserve its path, never its contents.
        DOCKER_CONFIG: resolve(process.env.DOCKER_CONFIG || join(homedir(), ".docker")),
        XDG_CONFIG_HOME: join(directory, "h", ".config"), XDG_CACHE_HOME: join(directory, "h", ".cache"),
        XDG_RUNTIME_DIR: join(directory, "r"),
      };
    }
  }

  get stopped() {
    return this.cancelled || state.cancelled;
  }

  fail(reason) {
    this.reason ??= reason;
    return false;
  }

  async execute() {
    const startedAt = Date.now();
    this.sink.note(`job ${this.id} started`);
    try {
      await jobRunners[this.id.replace(/-node2[24]$/, "")](this, this.id.match(/node(2[24])$/)?.[1]);
    } catch (error) {
      this.sink.note(`internal error: ${error instanceof Error ? error.message : String(error)}`);
      this.fail("internal-error");
    }
    if (this.clone) {
      try {
        rmSync(dirname(this.clone), { recursive: true, force: true });
      } catch (error) {
        this.sink.note(`workspace cleanup deferred: ${error.code ?? error.message}`);
      }
    }
    const cleanupFailures = this.ledger.cleanup(this.sink, this.id);
    if (cleanupFailures.length > 0) this.fail("cleanup-failed");
    const status = this.stopped ? "cancelled" : this.timedOut ? "timed-out" : this.reason ? "failed" : "passed";
    this.sink.note(`job ${this.id} ${status}${this.reason ? ` (${this.reason})` : ""}`);
    this.sink.close();
    const logPath = `logs/${this.id}.log`;
    const logBytes = readFileSync(join(this.run.evidence, logPath));
    return {
      id: this.id,
      status,
      reason: this.stopped ? "cancelled" : this.timedOut ? "timeout" : this.reason,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      steps: this.steps,
      log: { path: logPath, sha256: sha256(logBytes), bytes: logBytes.length, truncated: this.sink.truncated },
      ...this.details,
    };
  }

  useToolchain(line) {
    const toolchain = resolveToolchain(line, this.run.npmVersion);
    this.environment.toolchains[`node${line}`] = toolchain.ok
      ? { node: toolchain.nodeVersion, npm: toolchain.npmVersion }
      : { unavailable: toolchain.reason };
    if (!toolchain.ok) {
      this.sink.note(`Node ${line} toolchain rejected: ${toolchain.detail}`);
      return this.fail(toolchain.reason);
    }
    this.toolchain = toolchain;
    return true;
  }

  async checkout() {
    const directory = join(this.run.workspace, this.id, "source");
    mkdirSync(dirname(directory), { recursive: true });
    const cloned = await this.step("checkout", "git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-checkout", "--shared", sourceRoot, directory], { cwd: this.run.workspace });
    this.clone = directory;
    if (!cloned) return false;
    if (!await this.step("checkout-commit", "git", ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", this.run.head])) return false;
    const head = git(["rev-parse", "HEAD"], directory).stdout.trim();
    if (head !== this.run.head) return this.fail("checkout-mismatch");
    return true;
  }

  env(extra = {}) {
    return jobEnvironment(this.toolchain?.dir ?? null, { ...extra, ...this.privateEnvironment });
  }

  skip(name) {
    this.steps.push({ name, status: "skipped" });
    return false;
  }

  ran(name) {
    return this.steps.some((step) => step.name === name && step.status !== "skipped");
  }

  canRun() {
    return !this.stopped && !this.timedOut && this.reason === null;
  }

  async step(name, command, args, options = {}) {
    if (this.stopped || (!options.always && (this.timedOut || this.reason !== null))) return this.skip(name);
    let timeoutMs = options.timeoutMs ?? (options.always ? alwaysStepTimeoutMs : null);
    if (!options.always && this.deadline !== null) {
      const remainingMs = this.deadline - Date.now();
      timeoutMs = timeoutMs === null ? remainingMs : Math.min(timeoutMs, remainingMs);
      if (timeoutMs <= 0) {
        this.timedOut = true;
        return this.skip(name);
      }
    }
    const startedAt = Date.now();
    this.sink.note(`step ${name}: ${[command, ...args].join(" ")}`);
    const outcome = await spawnStep(command, args, {
      cwd: options.cwd ?? this.clone ?? this.run.workspace,
      env: options.env ?? this.env(options.extraEnv),
      timeoutMs,
      sink: this.sink,
    });
    let status = outcome.exitCode === 0 ? "passed" : "failed";
    if (outcome.cancelled) {
      status = "cancelled";
      this.cancelled = true;
    } else if (outcome.timedOut) {
      status = "timed-out";
      if (!options.always) this.timedOut = true;
    }
    this.steps.push({ name, status, exitCode: outcome.exitCode, signal: outcome.signal, durationMs: Date.now() - startedAt });
    this.sink.note(`step ${name} ${status} (exit ${outcome.exitCode ?? outcome.signal ?? outcome.error})`);
    if (status === "failed" || (status === "timed-out" && options.always)) this.fail(options.reason ?? "step-failed");
    return status === "passed";
  }

  async postgres(image, health) {
    const name = containerName(this.run.runId, this.id, "postgres");
    if (!await this.step("postgres-pull", "docker", ["pull", image], { reason: "service-unavailable" })) return null;
    const entry = this.ledger.track("container", name, this.id, "creating");
    const created = await this.step("postgres-service", "docker", [
      "run", "-d", "--name", name, "--label", `io.myskills.local-ci.run-id=${this.run.runId}`,
      "-e", "POSTGRES_USER=myskills_test", "-e", "POSTGRES_PASSWORD=myskills_test", "-e", "POSTGRES_DB=myskills_test",
      "-p", "127.0.0.1::5432",
      "--health-cmd", "pg_isready -U myskills_test -d myskills_test",
      "--health-interval", health.interval, "--health-timeout", health.timeout, "--health-retries", health.retries,
      image,
    ], { reason: "service-unavailable" });
    // A failed create may mean the name belongs to someone else; never remove it.
    this.ledger.mark(entry, created ? "created" : "not-created");
    if (!created) return null;
    const deadline = Date.now() + 180_000;
    let healthStatus = "";
    while (!this.stopped && Date.now() < deadline) {
      healthStatus = docker(["inspect", "--format", "{{.State.Health.Status}}", name]).stdout.trim();
      if (healthStatus === "healthy" || healthStatus === "unhealthy") break;
      await delay(1000);
    }
    this.sink.note(`postgres service health: ${healthStatus || "unknown"}`);
    if (healthStatus !== "healthy") return this.fail("service-unavailable") || null;
    const port = /^127\.0\.0\.1:(\d+)$/m.exec(docker(["port", name, "5432/tcp"]).stdout)?.[1];
    if (!port) return this.fail("service-unavailable") || null;
    return `postgres://myskills_test:myskills_test@127.0.0.1:${port}/myskills_test`;
  }

  async build(name, args, tag) {
    const entry = this.ledger.track("image", tag, this.id, "creating");
    const built = await this.step(name, "docker", ["build", "--pull", ...args, "--tag", tag, "."]);
    this.ledger.mark(entry, this.steps.at(-1).status === "skipped" ? "not-created" : "created");
    if (built) {
      this.details.images ??= {};
      this.details.images[tag] = docker(["image", "inspect", "--format", "{{.Id}}", tag]).stdout.trim() || null;
    }
    return built;
  }

  async smokeBackup(image) {
    for (const [name, script] of [["smoke-backup-run", "run-registry-backup.mjs"], ["smoke-backup-restore", "restore-registry-backup.mjs"]]) {
      const container = containerName(this.run.runId, this.id, name);
      const entry = this.ledger.track("container", container, this.id, "creating");
      await this.step(name, "docker", [
        "run", "--rm", "--name", container, "--label", `io.myskills.local-ci.run-id=${this.run.runId}`,
        "--network", "none", image, "node", `scripts/${script}`, "--help",
      ]);
      // --rm removes the container when the CLI exits normally; only an interrupted run needs cleanup.
      const last = this.steps.at(-1);
      this.ledger.mark(entry, last.status === "passed" || last.status === "failed" ? "removed" : last.status === "skipped" ? "not-created" : "created");
    }
  }

  async smokeMcp(image) {
    const name = containerName(this.run.runId, this.id, "mcp-smoke");
    const entry = this.ledger.track("container", name, this.id, "creating");
    const created = await this.step("smoke-mcp-start", "docker", [
      "run", "-d", "--name", name, "--label", `io.myskills.local-ci.run-id=${this.run.runId}`,
      "--label", `io.myskills.local-ci.owner=${this.run.runIdLock.owner}`,
      "--network", "none", "-e", "PORT=43123", "-e", "MYSKILLS_MCP_ALLOWED_HOSTS=127.0.0.1:43123", image,
    ], { timeoutMs: mcpSmokeTimeoutMs });
    if (this.steps.at(-1).status === "skipped") {
      this.ledger.mark(entry, "not-created");
      return;
    }
    // The daemon can create a container before its CLI is cancelled or times out.
    // Inspect only this name and our ownership labels; retain uncertainty rather
    // than freeing the reservation while a delayed create could still complete.
    const format = '{"id":{{json .Id}},"runId":{{json (index .Config.Labels "io.myskills.local-ci.run-id")}},"owner":{{json (index .Config.Labels "io.myskills.local-ci.owner")}}}';
    const inspected = docker(["container", "inspect", "--format", format, name], 10_000);
    const identity = inspected.status === 0 ? safeJson(inspected.stdout.trim()) : null;
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.id ?? "")
        || !["runId", "owner"].every((key) => identity[key] === null || typeof identity[key] === "string")) {
      this.ledger.mark(entry, "remove-failed");
      this.fail("mcp-smoke-ownership-unknown");
      return;
    }
    if (identity.runId !== this.run.runId || identity.owner !== this.run.runIdLock.owner) {
      this.ledger.mark(entry, "not-created");
      this.fail("mcp-smoke-ownership-mismatch");
      return;
    }
    entry.containerId = identity.id;
    this.ledger.mark(entry, "created");
    if (!created) return;
    await this.step("smoke-mcp-health", "docker", ["exec", name, "node", "scripts/smoke-mcp-http.mjs"], { timeoutMs: mcpSmokeTimeoutMs });
  }

  trackComposeProject(suffix) {
    const project = composeProjectName(this.run.runId, this.id, suffix);
    this.ledger.track("compose-project", project, this.id, "created");
    return project;
  }
}

const jobRunners = {
  async check(job, line) {
    if (!job.useToolchain(line) || !await job.checkout()) return;
    await job.step("install", "npm", ["ci"]);
    await job.step("check", "npm", ["run", "check"]);
  },

  async postgres(job, line) {
    if (!job.useToolchain(line) || !await job.checkout()) return;
    const databaseUrl = await job.postgres("postgres:17-alpine", { interval: "5s", timeout: "5s", retries: "10" });
    await job.step("install", "npm", ["ci"]);
    await job.step("test-postgres", "npm", ["run", "test:postgres"], { extraEnv: { TEST_DATABASE_URL: databaseUrl ?? "" } });
  },

  async "web-e2e"(job, line) {
    if (!job.useToolchain(line) || !await job.checkout()) return;
    const ports = await e2ePorts(job.run);
    job.details.ports = ports;
    await job.step("install", "npm", ["ci"]);
    await job.step("playwright-browser", "npx", ["playwright", "install", "chromium"]);
    await job.step("build", "npm", ["run", "build", "-w", "@myskills-app/core", "-w", "@myskills-app/auth", "-w", "@myskills-app/skill-package", "-w", "@myskills-app/api"]);
    await job.step("mocked-browser", "npm", ["run", "test:e2e", "-w", "@myskills-app/web", "--", "--reporter=line,json"], {
      extraEnv: { ...ports, PLAYWRIGHT_JSON_OUTPUT_FILE: "test-results/mocked-report.json" },
    });
    await collectBrowserEvidence(job, "mocked-browser", "collect-mocked-evidence", "mocked-report.json", "mocked");
    const project = job.canRun() ? job.trackComposeProject("fullstack") : null;
    await job.step("fullstack-browser", "npm", ["run", "test:e2e:fullstack"], { extraEnv: { ...ports, MYSKILLS_E2E_COMPOSE_PROJECT: project ?? "" } });
    await collectBrowserEvidence(job, "fullstack-browser", "collect-fullstack-evidence", "fullstack-report.json", "fullstack");
    await collectBrowserEvidence(job, "fullstack-browser", "collect-connector-evidence", "fullstack-connector-report.json", "fullstack-connector");
    exportBrowserEvidence(job);
  },

  async "railway-images"(job) {
    if (!await job.checkout()) return;
    const tag = (repository) => `${repository}:local-ci-${job.run.runId}`;
    await job.build("build-railway-api", ["--file", "Dockerfile.api"], tag("myskills-app-api"));
    await job.build("build-railway-mcp", ["--file", "Dockerfile.mcp"], tag("myskills-app-mcp"));
    await job.smokeMcp(tag("myskills-app-mcp"));
    await job.build("build-railway-web", ["--file", "Dockerfile.web", "--build-arg", "VITE_API_BASE_URL=/api"], tag("myskills-app-web"));
    await job.build("build-backup", ["--file", "Dockerfile.backup"], tag("myskills-registry-backup"));
    await job.smokeBackup(tag("myskills-registry-backup"));
  },

  async release(job) {
    const { tag } = job.run.release;
    if (!job.useToolchain("22") || !await job.checkout()) return;
    const tags = git(["tag", "--points-at", "HEAD"], job.clone).stdout.split(/\r?\n/);
    if (!tags.includes(tag)) return job.fail("release-tag-missing-in-clone");
    const databaseUrl = await job.postgres("postgres:17", { interval: "10s", timeout: "5s", retries: "5" });
    const ports = await e2ePorts(job.run);
    job.details.ports = ports;
    await job.step("install", "npm", ["ci"]);
    await job.step("playwright-browser", "npx", ["playwright", "install", "chromium"]);
    const project = job.canRun() ? job.trackComposeProject("release") : null;
    await job.step("release-verify", "npm", ["run", "release:verify"], {
      extraEnv: {
        ...ports,
        TEST_DATABASE_URL: databaseUrl ?? "",
        RELEASE_REQUIRE_TAG: "true",
        RELEASE_EXPECTED_TAG: tag,
        MYSKILLS_E2E_COMPOSE_PROJECT: project ?? "",
      },
    });
    const image = (repository) => `${repository}:local-ci-${job.run.runId}`;
    await job.build("build-api", ["--file", "Dockerfile", "--target", "api"], image("myskills-app-api"));
    await job.build("build-mcp-http", ["--file", "Dockerfile", "--target", "mcp-http"], image("myskills-app-mcp-http"));
    await job.build("build-web", ["--file", "Dockerfile", "--target", "web", "--build-arg", "VITE_API_BASE_URL=/api"], image("myskills-app-web"));
    await job.build("build-railway-api", ["--file", "Dockerfile.api"], image("myskills-app-railway-api"));
    await job.build("build-railway-mcp", ["--file", "Dockerfile.mcp"], image("myskills-app-railway-mcp"));
    await job.smokeMcp(image("myskills-app-railway-mcp"));
    await job.build("build-railway-web", ["--file", "Dockerfile.web", "--build-arg", "VITE_API_BASE_URL=/api"], image("myskills-app-railway-web"));
    await job.build("build-backup", ["--file", "Dockerfile.backup"], image("myskills-registry-backup"));
    await job.smokeBackup(image("myskills-registry-backup"));
    if (!job.canRun()) return job.skip("verify-release-artifacts");
    const verification = verifyReleaseArtifacts(job.clone, job.run, tag);
    const target = join(job.run.evidence, "release");
    mkdirSync(target, { recursive: true });
    writeJsonAtomic(join(target, "verification.json"), verification.record);
    job.steps.push({ name: "verify-release-artifacts", status: verification.ok ? "passed" : "failed" });
    if (!verification.ok) {
      job.sink.note(`release artifact verification failed: ${verification.record.failures.join("; ")}`);
      return job.fail("artifact-verification-failed");
    }
    mkdirSync(join(target, "artifacts"));
    for (const file of verification.files) copyFileSync(join(verification.directory, file), join(target, "artifacts", file));
    job.details.releaseArtifacts = verification.record.artifacts;
  },

  async "codeql-javascript-typescript"(job) {
    const { bin, category, excludedRules } = job.run.codeql;
    if (!await job.checkout()) return;
    const work = dirname(job.clone);
    const config = join(work, "codeql-config.yml");
    // The verified external route: repository filters verbatim plus the suite the workflow requests.
    writeFileSync(config, `${readFileSync(join(job.clone, ".github/codeql/codeql-config.yml"), "utf8")}${codeqlSuiteLine}`);
    const nodeDir = codeqlNodeDirectory();
    job.toolchain = nodeDir ? { dir: nodeDir } : null;
    const version = spawnSync(bin, ["version", "--format=json"], { encoding: "utf8", env: job.env() });
    job.environment.codeql = safeJson(version.stdout)?.version ?? null;
    const output = join(job.run.evidence, "codeql", "javascript-typescript.sarif");
    mkdirSync(dirname(output), { recursive: true });
    await job.step("database-create", bin, [
      "database", "create", join(work, "database"), "--language=javascript-typescript", "--build-mode=none",
      `--source-root=${job.clone}`, `--codescanning-config=${config}`, "--threads=0",
    ]);
    await job.step("database-analyze", bin, [
      "database", "analyze", join(work, "database"), "--format=sarifv2.1.0", `--output=${output}`,
      `--sarif-category=${category}`, "--threads=0",
    ]);
    if (!job.canRun()) return;
    const summary = summarizeSarif(output, category, excludedRules);
    job.details.codeql = { version: job.environment.codeql, category, excludedRules, results: summary.results, byRule: summary.byRule };
    writeJsonAtomic(join(job.run.evidence, "codeql", "summary.json"), { ...job.details.codeql, locations: summary.locations, checks: summary.checks });
    if (summary.failure) return job.fail(summary.failure);
  },
};

async function collectBrowserEvidence(job, browserStep, name, report, phase) {
  if (!job.ran(browserStep)) return job.skip(name);
  const results = "apps/web/test-results";
  return job.step(name, "node", ["scripts/collect-browser-evidence.mjs", `${results}/${report}`, results, `dist/browser-evidence/${phase}`], { always: true });
}

function exportBrowserEvidence(job) {
  if (job.stopped) return job.skip("export-browser-evidence");
  const source = join(job.clone, "dist", "browser-evidence");
  const target = join(job.run.evidence, "browser-evidence", job.id);
  const copied = existsSync(source) ? copyRegularFiles(source, target) : 0;
  job.details.browserEvidence = `browser-evidence/${job.id}`;
  // Mirrors upload-artifact's if-no-files-found: error.
  job.steps.push({ name: "export-browser-evidence", status: copied > 0 ? "passed" : "failed", files: copied });
  if (copied === 0) job.fail("evidence-missing");
}

function verifyReleaseArtifacts(clone, run, tag) {
  const failures = [];
  const record = { tag, commitSha: run.head, failures, artifacts: [] };
  const dist = join(clone, "dist");
  const outputs = existsSync(dist) ? readdirSync(dist).filter((name) => name.startsWith("release-verify-")) : [];
  if (outputs.length !== 1) {
    failures.push(`expected one dist/release-verify-* output, found ${outputs.length}`);
    return { ok: false, record };
  }
  const directory = join(dist, outputs[0], "artifacts");
  const { name, version, packageManager, engines } = run.rootPackage;
  const archive = `${name}-${version}-source.tar`;
  const files = [archive, "release-metadata.json", "SHA256SUMS"].sort();
  const present = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
  if (present.some((entry) => !entry.isFile()) || JSON.stringify(present.map((entry) => entry.name).sort()) !== JSON.stringify(files)) {
    failures.push("artifact set must be exactly the source archive, release-metadata.json and SHA256SUMS");
    return { ok: false, record };
  }
  const digests = Object.fromEntries(files.map((file) => [file, sha256(readFileSync(join(directory, file)))]));
  const sums = new Map();
  for (const line of readFileSync(join(directory, "SHA256SUMS"), "utf8").split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) failures.push("SHA256SUMS contains a malformed line");
    else sums.set(match[2], match[1]);
  }
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify([archive, "release-metadata.json"].sort())) {
    failures.push("SHA256SUMS must list the source archive and metadata only");
  }
  for (const [file, digest] of sums) {
    if (digests[file] !== digest) failures.push(`SHA256SUMS mismatch for ${file}`);
  }
  const metadata = safeJson(readFileSync(join(directory, "release-metadata.json"), "utf8"));
  const archiveBytes = statSync(join(directory, archive)).size;
  const expectations = [
    ["name", metadata?.name === name],
    ["version", metadata?.version === version],
    ["expectedTag", metadata?.expectedTag === tag],
    ["tags", Array.isArray(metadata?.tags) && metadata.tags.includes(tag)],
    ["commitSha", metadata?.commitSha === run.head],
    ["dirty", metadata?.dirty === false],
    ["packageManager", metadata?.packageManager === packageManager],
    ["nodeEngine", metadata?.nodeEngine === engines?.node],
    ["artifacts", JSON.stringify(metadata?.artifacts) === JSON.stringify([{ file: archive, byteSize: archiveBytes, sha256: digests[archive] }])],
  ];
  for (const [field, ok] of expectations) if (!ok) failures.push(`release-metadata.json ${field} does not match the verified source`);
  // Rebuild the archive from the pinned commit; equal bytes bind the artifact to that source.
  const rebuilt = join(dirname(clone), "reproduced-source.tar");
  const archived = git(["archive", "--format=tar", `--prefix=${name}-${version}/`, "-o", rebuilt, run.head], clone);
  if (archived.status !== 0 || sha256(readFileSync(rebuilt)) !== digests[archive]) {
    failures.push("source archive does not reproduce from the pinned commit");
  }
  record.artifacts = files.map((file) => ({ file, sha256: digests[file] }));
  return { ok: failures.length === 0, record, directory, files };
}

function summarizeSarif(path, category, excludedRules) {
  const checks = {};
  let failure = null;
  const sarif = existsSync(path) ? safeJson(readFileSync(path, "utf8")) : null;
  const runs = Array.isArray(sarif?.runs) ? sarif.runs : [];
  const rules = new Set();
  const byRule = {};
  const locations = [];
  let results = 0;
  for (const sarifRun of runs) {
    for (const component of [sarifRun.tool?.driver, ...(sarifRun.tool?.extensions ?? [])]) {
      for (const rule of component?.rules ?? []) rules.add(rule.id);
    }
    for (const result of sarifRun.results ?? []) {
      results += 1;
      byRule[result.ruleId] = (byRule[result.ruleId] ?? 0) + 1;
      const location = result.locations?.[0]?.physicalLocation;
      locations.push({ ruleId: result.ruleId, uri: location?.artifactLocation?.uri ?? null, line: location?.region?.startLine ?? null });
    }
  }
  checks.sarifPresent = runs.length > 0;
  checks.queriesRan = rules.size > 0;
  checks.filtersApplied = excludedRules.every((id) => !rules.has(id));
  checks.category = runs.length > 0 && runs.every((sarifRun) => String(sarifRun.automationDetails?.id ?? "").startsWith(category));
  if (!checks.sarifPresent) failure = "codeql-sarif-missing";
  else if (!checks.queriesRan) failure = "codeql-no-queries";
  else if (!checks.filtersApplied) failure = "codeql-filter-not-applied";
  else if (!checks.category) failure = "codeql-category-mismatch";
  // Result counts are reported, not gated: GitHub alert dismissals remain the authority.
  return { checks, failure, results, byRule, locations };
}

class ResourceLedger {
  constructor(path, runId) {
    this.path = path;
    this.runId = runId;
    this.resources = [];
    this.save();
  }

  track(kind, name, job, stateName) {
    const entry = { kind, name, job, state: stateName };
    this.resources.push(entry);
    this.save();
    return entry;
  }

  find(kind, name) {
    return this.resources.find((entry) => entry.kind === kind && entry.name === name);
  }

  mark(entry, stateName) {
    entry.state = stateName;
    this.save();
  }

  save() {
    writeJsonAtomic(this.path, { runId: this.runId, resources: this.resources });
  }

  cleanup(sink, job = undefined) {
    const failures = [];
    for (const entry of [...this.resources].reverse()) {
      if ((job !== undefined && entry.job !== job) || entry.kind === "workspace" || entry.kind === "run-id-reservation") continue;
      if (!["created", "creating"].includes(entry.state)) continue;
      if (entry.kind === "container" && entry.state === "creating") continue;
      const removed = removeResource(entry, sink);
      this.mark(entry, removed ? "removed" : "remove-failed");
      if (!removed) failures.push(`${entry.kind} ${entry.name}`);
    }
    return failures;
  }
}

function removeResource(entry, sink) {
  if (entry.kind === "job-directory") {
    try {
      rmSync(entry.name, { recursive: true, force: true });
      return true;
    } catch (error) {
      sink.note(`job directory cleanup failed: ${error.code ?? error.message}`);
      return false;
    }
  }
  if (entry.kind === "container") return removeContainers([entry.containerId ?? entry.name], sink);
  if (entry.kind === "image") return removeImage(entry.name, sink);
  if (entry.kind === "compose-project") {
    // Exact Compose project label match; never name prefixes or prune.
    const filter = `label=com.docker.compose.project=${entry.name}`;
    const listed = (args) => docker(args).stdout.split(/\s+/).filter(Boolean);
    let ok = removeContainers(listed(["ps", "-aq", "--filter", filter]), sink);
    const networks = listed(["network", "ls", "-q", "--filter", filter]);
    if (networks.length > 0) ok = dockerLogged(["network", "rm", ...networks], sink) && ok;
    const volumes = listed(["volume", "ls", "-q", "--filter", filter]);
    if (volumes.length > 0) ok = dockerLogged(["volume", "rm", ...volumes], sink) && ok;
    for (const service of composeServiceImages) ok = removeImage(`${entry.name}-${service}`, sink) && ok;
    return ok;
  }
  return false;
}

function removeContainers(names, sink) {
  if (names.length === 0) return true;
  const result = docker(["rm", "-f", "-v", ...names]);
  sink.note(`docker rm -f -v ${names.join(" ")}: exit ${result.status}`);
  return result.status === 0 || /No such container/i.test(result.stderr);
}

function removeImage(reference, sink) {
  if (docker(["image", "inspect", "--format", "{{.Id}}", reference]).status !== 0) return true;
  return dockerLogged(["image", "rm", reference], sink);
}

function dockerLogged(args, sink) {
  const result = docker(args);
  sink.note(`docker ${args.join(" ")}: exit ${result.status}`);
  return result.status === 0;
}

class LogSink {
  constructor(path) {
    this.fd = path ? openSync(path, "a") : null;
    this.bytes = 0;
    this.truncated = false;
    this.redactions = 0;
    this.pending = new Map();
  }

  write(stream, text) {
    const lines = `${this.pending.get(stream) ?? ""}${text}`.split("\n");
    let rest = lines.pop();
    for (const line of lines) this.emit(`${line}\n`);
    if (rest.length > maxPendingLine) {
      this.emit(`${rest}\n`);
      rest = "";
    }
    this.pending.set(stream, rest);
  }

  flush() {
    for (const [stream, rest] of this.pending) {
      if (rest) this.emit(`${rest}\n`);
      this.pending.set(stream, "");
    }
  }

  note(message) {
    this.emit(`[local-ci] ${message}\n`);
  }

  emit(text) {
    let clean = text;
    for (const pattern of compiledSecretPatterns) {
      clean = clean.replace(pattern, () => {
        this.redactions += 1;
        return "[redacted]";
      });
    }
    process.stdout.write(clean);
    if (this.fd === null || this.truncated) return;
    const size = Buffer.byteLength(clean);
    if (this.bytes + size > maxLogBytes) {
      writeSync(this.fd, "[local-ci] log truncated at the size limit\n");
      this.truncated = true;
      return;
    }
    writeSync(this.fd, clean);
    this.bytes += size;
  }

  close() {
    this.flush();
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}

function spawnStep(command, args, { cwd, env, timeoutMs, sink }) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let closeTimer = null;
    let child;
    const handle = { stop: () => terminate(child) };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      state.activeSteps.delete(handle);
      sink.flush();
      resolvePromise({ ...outcome, timedOut, cancelled: state.cancelled });
    };
    try {
      // Each step leads its own process group so timeouts and cancellation reach every descendant.
      child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      sink.note(`could not start ${command}: ${error.code ?? error.message}`);
      finish({ exitCode: null, signal: null, error: error.code ?? "spawn-failed" });
      return;
    }
    state.activeSteps.add(handle);
    if (state.cancelled) terminate(child);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => sink.write("stdout", text));
    child.stderr.on("data", (text) => sink.write("stderr", text));
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        sink.note(`timed out after ${Math.round(timeoutMs / 1000)} s`);
        terminate(child);
      }, timeoutMs);
    }
    child.once("error", (error) => {
      sink.note(`could not start ${command}: ${error.code ?? error.message}`);
      finish({ exitCode: null, signal: null, error: error.code ?? "spawn-failed" });
    });
    child.once("exit", (code, signal) => {
      // Stop leftovers in the step's own group, then wait briefly for output to drain.
      signalGroup(child, "SIGTERM");
      closeTimer = setTimeout(() => {
        signalGroup(child, "SIGKILL");
        finish({ exitCode: code, signal });
      }, killGraceMs);
    });
    child.once("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

function terminate(child) {
  if (!child?.pid) return;
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), killGraceMs).unref();
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
}

function cancel(signal) {
  if (state.cancelled) return;
  state.cancelled = true;
  state.signal = signal;
  console.error(`[local-ci] ${signal} received; stopping active steps and cleaning up this run's resources.`);
  for (const handle of state.activeSteps) handle.stop();
}

function resolveToolchain(line, npmVersion) {
  const configured = process.env[`LOCAL_CI_NODE${line}_BIN`];
  const unavailable = (detail) => ({ ok: false, reason: "toolchain-unavailable", detail });
  let dir;
  if (configured) {
    if (!isAbsolute(configured)) return unavailable(`LOCAL_CI_NODE${line}_BIN must be absolute`);
    dir = configured;
  } else {
    const node = findOnPath("node");
    if (!node) return unavailable(`set LOCAL_CI_NODE${line}_BIN`);
    dir = dirname(node);
  }
  for (const tool of ["node", "npm", "npx"]) {
    if (!isExecutable(join(dir, tool))) return unavailable(`${tool} is missing from the Node ${line} directory`);
  }
  const nodeVersion = spawnSync(join(dir, "node"), ["--version"], { encoding: "utf8", env: jobEnvironment(dir) }).stdout.trim();
  const [major, minor] = (/^v(\d+)\.(\d+)\.\d+$/.exec(nodeVersion) ?? []).slice(1).map(Number);
  if (major !== Number(line)) {
    const detail = `found ${nodeVersion || "no version"}, need Node ${line}`;
    return configured ? { ok: false, reason: "toolchain-mismatch", detail } : unavailable(detail);
  }
  if (line === "22" && minor < 13) return { ok: false, reason: "toolchain-mismatch", detail: `${nodeVersion} is below the 22.13 engine floor` };
  const foundNpm = spawnSync(join(dir, "npm"), ["--version"], { encoding: "utf8", env: jobEnvironment(dir) }).stdout.trim();
  if (foundNpm !== npmVersion) {
    return { ok: false, reason: "toolchain-mismatch", detail: `npm ${foundNpm || "unknown"} does not match packageManager npm@${npmVersion}` };
  }
  return { ok: true, dir, nodeVersion, npmVersion: foundNpm };
}

function codeqlNodeDirectory() {
  for (const line of ["24", "22"]) {
    const dir = process.env[`LOCAL_CI_NODE${line}_BIN`];
    if (dir && isAbsolute(dir) && isExecutable(join(dir, "node"))) return dir;
  }
  return null;
}

function jobEnvironment(toolchainDir, extra = {}) {
  const env = {};
  for (const name of passthroughEnv) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.PATH = toolchainDir ? `${toolchainDir}${delimiter}${process.env.PATH ?? ""}` : process.env.PATH ?? "";
  // GitHub-hosted runners set CI=true; Playwright retries and server reuse depend on it.
  env.CI = "true";
  return { ...env, ...extra };
}

function collectEnvironment(run) {
  const environment = {
    platform: platform(),
    arch: arch(),
    osRelease: osRelease(),
    git: git(["--version"]).stdout.trim(),
    toolchains: {},
    docker: null,
    verifyLanes: run.laneCount,
  };
  if (run.jobs.some((id) => !id.startsWith("check-") && !id.startsWith("codeql-"))) {
    const version = docker(["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]);
    environment.docker = version.status === 0 ? version.stdout.trim() : "unavailable";
  }
  return environment;
}

async function e2ePorts(run) {
  const ports = {};
  for (const name of browserPortNames) {
    const supplied = process.env[name];
    let port = supplied && /^\d+$/.test(supplied) && Number(supplied) >= 1024 && Number(supplied) <= 65535
      ? supplied
      : String(await freeLoopbackPort());
    if (run.laneCount === 4) {
      while (run.browserPorts.has(port)) port = String(await freeLoopbackPort());
      run.browserPorts.add(port);
    }
    ports[name] = port;
  }
  return ports;
}

function freeLoopbackPort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

function scanEvidenceForSecrets(evidence) {
  const findings = [];
  for (const path of listEvidenceFiles(evidence)) {
    if (path === "result.json" || /\.(png|jpe?g|gif|webp|zip)$/i.test(path)) continue;
    const text = readFileSync(join(evidence, path), "latin1");
    if (compiledSecretPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    })) {
      // Quarantine by removal: the run fails and the file is never exported.
      unlinkSync(join(evidence, path));
      findings.push(path);
    }
  }
  return findings;
}

function manifest(evidence) {
  return listEvidenceFiles(evidence)
    .filter((path) => path !== "result.json")
    .map((path) => {
      const bytes = readFileSync(join(evidence, path));
      return { path, sha256: sha256(bytes), bytes: bytes.length };
    });
}

function listEvidenceFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listEvidenceFiles(join(directory, entry.name), path));
    else if (entry.isFile() && !entry.name.includes(".tmp-")) files.push(path);
  }
  return files;
}

function copyRegularFiles(source, target) {
  let copied = 0;
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const stats = lstatSync(from);
    if (stats.isDirectory()) copied += copyRegularFiles(from, join(target, entry));
    else if (stats.isFile()) {
      mkdirSync(target, { recursive: true });
      copyFileSync(from, join(target, entry));
      copied += 1;
    }
  }
  return copied;
}

function containerName(runId, jobId, suffix) {
  return `myskills-ci-${runId}-${jobId}-${suffix}`;
}

// run-fullstack-e2e.mjs accepts Compose projects of at most 63 characters. Names that fit keep their
// existing form. Longer ones keep the complete run ID (the runner's leftover check matches it as a token),
// then as much of the job ID as fits, then a hash of the complete original name so jobs stay distinct.
function composeProjectName(runId, jobId, suffix) {
  const full = containerName(runId, jobId, suffix);
  if (full.length <= composeProjectMaxLength) return full;
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
  const room = composeProjectMaxLength - runId.length - digest.length - 2;
  const job = jobId.slice(0, Math.max(0, room - 1)).replace(/-+$/, "");
  return job ? `${runId}-${job}-${digest}` : `${runId}-${digest}`;
}

function git(args, cwd = sourceRoot) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: jobEnvironment(null) });
}

function docker(args, timeout = 120_000) {
  return spawnSync("docker", args, { encoding: "utf8", env: jobEnvironment(null), timeout });
}

function findOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && isExecutable(join(directory, name))) return join(directory, name);
  }
  return null;
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realPathAllowingMissing(path) {
  const missing = [];
  let current = path;
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function isWithin(child, parent) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Invoked last so every class and job table above is initialized first.
main().then((code) => {
  // Let piped output drain; the unref'd timer only bounds a stuck handle.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5_000).unref();
}, (error) => {
  console.error(`local-ci: internal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
