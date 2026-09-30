import assert from "node:assert/strict";
import test from "node:test";
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

/** Canonical PG fixture launches the actual production API process, not reconstructed services. */
test("server worker crash recovers durable attempt and SIGTERM drains completion before pool shutdown", { timeout: 90_000 }, async t => {
  const url = process.env.TEST_DATABASE_URL!;
  assert.match(new URL(url).pathname, /(^|[_/-])(test|ci)([_-]|$)/i);
  const pool = createPgPool(url); t.after(() => pool.end());
  await pool.query("DROP SCHEMA public CASCADE"); await pool.query("CREATE SCHEMA public"); await runMigrations(pool);
  const db = createDb(pool);
  const auth = new PostgresAuthStore(db);
  const user = (await auth.createUserWithPassword({ email: "process@example.com", name: "Process", passwordHash: await hashPassword("Process-test-password-983!") })).user!;
  const submissions = new SubmissionService(new PostgresSubmissionStore(db, { backgroundScans: true }));
  const manifest = parseSkillManifest({ name: "process-worker", title: "Worker", summary: "Real process fixture", version: "1.0.0", license: "MIT", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }] });
  const gate = await pool.connect(); t.after(() => gate.release());
  const gateId = 724211;
  await pool.query(`CREATE FUNCTION pause_process_scan() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status='succeeded' THEN PERFORM pg_advisory_xact_lock(${gateId}); END IF; RETURN NEW; END; $$`);
  await pool.query("CREATE TRIGGER pause_process_scan BEFORE UPDATE ON scan_runs FOR EACH ROW EXECUTE FUNCTION pause_process_scan()");
  await gate.query("SELECT pg_advisory_lock($1)", [gateId]);
  t.after(() => gate.query("SELECT pg_advisory_unlock_all()"));
  const pending = await submissions.createSubmission({ actor: { id: user.id, roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: "# Real process worker fixture" }] });
  const port = await freePort();
  const processes: ChildProcess[] = [];
  t.after(() => { for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const launch = () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: new URL("../", import.meta.url),
      env: { ...process.env, DATABASE_URL: url, NODE_ENV: "test", HOST: "127.0.0.1", PORT: String(port), AUTH_SECRET: "process-fixture-secret-at-least-32-bytes", PACKAGE_SCAN_WORKER: "enabled" }, stdio: ["ignore", "pipe", "pipe"] });
    processes.push(child); return child;
  };
  const waitBlocked = () => until(async () => Number((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%UPDATE scan_runs%'" )).rows[0].n) > 0);
  const first = launch(); await waitBlocked();
  const crashed = once(first, "exit"); first.kill("SIGKILL"); await crashed;
  assert.equal((await pool.query("SELECT status FROM jobs WHERE type='package-scan'")).rows[0].status, "running");
  await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE type='package-scan'");
  const second = launch(); let errors = ""; second.stderr!.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096); });
  await waitBlocked();
  const shutdown = once(second, "exit"); second.kill("SIGTERM");
  await delay(150); assert.equal(second.exitCode, null, "shutdown must wait for blocked completion");
  await gate.query("SELECT pg_advisory_unlock($1)", [gateId]);
  const [code] = await shutdown; assert.equal(code, 0, errors);
  const detail = await submissions.getUserSubmissionDetail({ actor: { id: user.id, roles: ["author"] }, submissionId: pending.id });
  assert.deepEqual(detail!.scanRuns.map(r => r.status), ["failed", "succeeded"]);
  assert.ok(detail!.scanRuns.every(r => r.artifactSha256 === pending.artifact.sha256));
  assert.equal(detail!.securityStatus, "passed");
  assert.equal(errors.includes("Cannot use a pool after calling end"), false);
});
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  assert.fail("Actual server worker did not reach the required lock boundary.");
}
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done())); return port;
}
