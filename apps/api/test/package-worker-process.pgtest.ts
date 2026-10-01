import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { readApiStartupFailure } from "../src/startup-diagnostic.js";

/** Canonical PG fixture launches the actual production API process, not reconstructed services. */
test("server worker crash recovers durable attempt and SIGTERM drains completion before pool shutdown", { timeout: 90_000, skip: process.platform === "win32" ? "POSIX signal crash/restart and graceful drain require canonical Linux/PostgreSQL." : false }, async t => {
  const stage = (name: string) => { process.stdout.write(`package_worker_process_stage=${name}\n`); };
  stage("setup");
  const url = process.env.TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /(^|[_/-])(test|ci)([_-]|$)/i);
  const pool = createPgPool(url);
  const cleanup: { gate?: PoolClient } = {};
  const processes: ChildProcess[] = [];
  t.after(async () => {
    stage("cleanup");
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (cleanup.gate) { await cleanup.gate.query("SELECT pg_advisory_unlock_all()"); cleanup.gate.release(); }
    await pool.end();
  });
  await pool.query("DROP SCHEMA public CASCADE"); await pool.query("CREATE SCHEMA public"); await runMigrations(pool);
  const db = createDb(pool);
  const auth = new PostgresAuthStore(db);
  const user = (await auth.createUserWithPassword({ email: "process@example.com", name: "Process", passwordHash: await hashPassword("Process-test-password-983!") })).user!;
  await auth.updateUserStatus({ userId: user.id, status: "active", emailVerifiedAt: new Date() });
  await pool.query("INSERT INTO role_assignments(user_id,role) VALUES($1,'author') ON CONFLICT DO NOTHING",[user.id]);
  const submissions = new SubmissionService(new PostgresSubmissionStore(db, { backgroundScans: true }));
  const manifest = parseSkillManifest({ name: "process-worker", title: "Worker", summary: "Real process fixture", version: "1.0.0", license: "MIT", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }] });
  const gate = await pool.connect(); cleanup.gate = gate;
  const gateId = 724211;
  await pool.query(`CREATE FUNCTION pause_process_scan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(${gateId}); END IF; RETURN NEW; END; $$`);
  await pool.query("CREATE TRIGGER pause_process_scan BEFORE UPDATE ON scan_runs FOR EACH ROW EXECUTE FUNCTION pause_process_scan()");
  await gate.query("SELECT pg_advisory_lock($1)", [gateId]);
  const pending = await submissions.createSubmission({ actor: { id: user.id, roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: "# Real process worker fixture" }] });
  const port = await freePort();
  const gatePid = Number((await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  const observed = new Map<ChildProcess, { name: string; stderr: string; startupError: boolean }>();
  const launch = () => {
    const name = `myskills-scan-process-${processes.length + 1}`;
    const database = new URL(url); database.searchParams.set("application_name", name);
    // test:postgres builds first. Launch the maintained production entry point,
    // without a source loader, environment-file load or unrelated source worker.
    const child = spawn(process.execPath, ["dist/server.js"], { cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, DATABASE_URL: database.href, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), AUTH_SECRET: "process-fixture-secret-at-least-32-bytes", AUTH_NOTIFICATION_MODE: "disabled", PACKAGE_SCAN_WORKER: "enabled", LIBRARY_SOURCE_WORKER: "disabled" }, stdio: ["ignore", "pipe", "pipe"] });
    const state = { name, stderr: "", startupError: false }; observed.set(child, state);
    child.stderr!.on("data", chunk => { state.stderr = (state.stderr + String(chunk)).slice(-4096); });
    child.stdout!.on("data", () => undefined);
    child.on("error", () => { state.startupError = true; });
    processes.push(child); return child;
  };
  const waitBlocked = async (child: ChildProcess) => {
    const state = observed.get(child)!;
    const fail = async () => {
      const jobs = (await pool.query("SELECT status,attempts,failure_code FROM jobs WHERE type='package-scan'")).rows;
      const scans = (await pool.query("SELECT status,attempt,failure_code FROM scan_runs WHERE skill_version_id=$1 ORDER BY attempt", [pending.id])).rows;
      const startup = readApiStartupFailure(state.stderr);
      const category = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(state.stderr) ? "module" : /Registry instance identity/.test(state.stderr) ? "registry_identity" : /EADDRINUSE/.test(state.stderr) ? "port" : state.startupError ? "spawn" : "unclassified";
      assert.fail(`Actual scan worker boundary not reached: ${JSON.stringify({ category: startup?.category ?? category, startup, exitCode: child.exitCode, signalCode: child.signalCode, jobs, scans })}`);
    };
    stage(`${processes.indexOf(child) === 0 ? "first" : "replacement"}_health`);
    await until(async () => {
      if (state.startupError || child.exitCode !== null || child.signalCode !== null) await fail();
      try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, fail);
    stage(`${processes.indexOf(child) === 0 ? "first" : "replacement"}_completion_gate`);
    let backendPid = 0;
    await until(async () => {
      if (state.startupError || child.exitCode !== null || child.signalCode !== null) await fail();
      const rows = (await pool.query("SELECT a.pid FROM pg_stat_activity a WHERE a.application_name=$1 AND a.wait_event_type='Lock' AND a.query LIKE '%UPDATE scan_runs%' AND $2=ANY(pg_blocking_pids(a.pid))", [state.name, gatePid])).rows;
      if (rows.length !== 1) return false;
      backendPid = Number(rows[0].pid); return true;
    }, fail);
    return backendPid;
  };
  const first = launch(); const firstBackend = await waitBlocked(first);
  stage("crash");
  const crashed = once(first, "exit"); first.kill("SIGKILL");
  assert.deepEqual(await crashed, [null, "SIGKILL"], "the actual API child must die before releasing the test gate");
  // PostgreSQL can detect a disconnected client only at its next socket I/O.
  // Let the abandoned statement leave the test gate, then prove its transaction
  // rolled back before touching the job row it held. No backend is cancelled.
  stage("crashed_backend_disconnect");
  await gate.query("SELECT pg_advisory_unlock($1)", [gateId]);
  await until(async () => !(await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND application_name=$2", [firstBackend, observed.get(first)!.name])).rows.length,
    async () => assert.fail("Killed API child's exact completion backend did not disconnect after test gate release"));
  assert.equal((await pool.query("SELECT status FROM jobs WHERE type='package-scan'")).rows[0].status, "running");
  assert.equal((await pool.query("SELECT status FROM scan_runs WHERE skill_version_id=$1", [pending.id])).rows[0].status, "running", "abandoned completion must roll back before lease recovery");
  await gate.query("SELECT pg_advisory_lock($1)", [gateId]);
  stage("expire_crashed_lease");
  await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE type='package-scan'");
  const second = launch(); assert.notEqual(second.pid, first.pid);
  await waitBlocked(second);
  stage("graceful_drain_held");
  const shutdown = once(second, "exit"); second.kill("SIGTERM");
  await delay(150); assert.equal(second.exitCode, null, "shutdown must wait for blocked completion");
  await gate.query("SELECT pg_advisory_unlock($1)", [gateId]);
  stage("graceful_drain_released");
  await until(async () => second.exitCode !== null || second.signalCode !== null,
    async () => assert.fail("Replacement API process did not exit after releasing its completion gate"));
  const [code] = await shutdown; assert.equal(code, 0, "actual production process must finish graceful drain");
  stage("durable_final_state");
  const detail = await submissions.getUserSubmissionDetail({ actor: { id: user.id, roles: ["author"] }, submissionId: pending.id });
  assert.deepEqual(detail!.scanRuns.map(r => r.status), ["failed", "succeeded"]);
  assert.ok(detail!.scanRuns.every(r => r.artifactSha256 === pending.artifact.sha256));
  assert.equal(detail!.scanRuns[0]!.failureCode, "lease_expired");
  assert.deepEqual(detail!.scanRuns.map(r => r.attempt), [1, 2]);
  assert.equal(detail!.securityStatus, "passed");
  assert.equal((await pool.query("SELECT status FROM jobs WHERE type='package-scan'")).rows[0].status, "succeeded");
  assert.equal(observed.get(second)!.stderr.includes("Cannot use a pool after calling end"), false);
});
async function until(check: () => Promise<boolean>, fail: () => Promise<never>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  await fail();
}
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done())); return port;
}
