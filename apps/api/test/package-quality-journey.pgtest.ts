/**
 * Failure scenarios and acceptance written before implementation: see QUALITY_DELIVERY.md.
 * Real Postgres claims, submission/review authority, storage integrity and restart evidence.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "@myskills-app/core";
import { hashPassword } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PackageScanService } from "../src/package-quality/scan-service.js";
import { PACKAGE_SCAN_RUNNER_VERSION } from "../src/package-quality/scan-jobs.js";
import type { ArtifactObjectStorage } from "../src/artifacts/storage.js";

test("durable quality journey: held bytes, retries, restart, stale workers, correction and publication", { timeout: 90_000 }, async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  assert.match(new URL(url).pathname, /(^|[_/-])(test|ci)([_-]|$)/i);
  const pool = createPgPool(url);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);
  const auth = new PostgresAuthStore(db);
  const passwordHash = await hashPassword("correct horse battery staple");
  const author = (await auth.createUserWithPassword({ email: "quality-author@example.com", name: "Author", passwordHash })).user!;
  const maintainer = (await auth.createUserWithPassword({ email: "quality-maintainer@example.com", name: "Maintainer", passwordHash })).user!;
  await auth.updateUserStatus({ userId: author.id, status: "active", emailVerifiedAt: new Date() });
  await auth.updateUserStatus({ userId: maintainer.id, status: "active", emailVerifiedAt: new Date() });
  const actor = { id: author.id, roles: ["author" as const] };
  const reviewer = { id: maintainer.id, roles: ["maintainer" as const], mfaVerified: true };
  const store = new PostgresSubmissionStore(db, { backgroundScans: true });
  const submissions = new SubmissionService(store);
  const scans = new PackageScanService(db);
  const held = packageInput("0.1.0");
  const first = await submissions.createSubmission({ actor, ...held });
  assert.equal(first.securityStatus, "not-run");
  assert.equal(first.scan.status, "queued");
  held.files[1]!.content = "changed caller memory";
  assert.equal(first.artifact.payload.files.find((file) => file.path === "SKILL.md")!.content, "# Quality Journey\n\nCheck the supplied public fixture carefully.\n");
  const deny = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
  await assert.rejects(submissions.performReviewAction({ actor: reviewer, submissionId: first.id, action: "approve", artifactSha256: first.artifact.sha256 }), deny("PACKAGE_SCAN_NOT_PASSED"));
  await assert.rejects(submissions.createSubmission({ actor, ...packageInput("0.1.0") }), deny("PACKAGE_VERSION_EXISTS"));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM jobs WHERE type='package-scan'")).rows[0].count, 1);

  // Concurrent replicas race through real row locks. Simulate a crash after claiming.
  const claims = await Promise.all([scans.claimNext(), new PackageScanService(db).claimNext()]);
  assert.equal(claims.filter(Boolean).length, 1);
  const stale = claims.find(Boolean)!;
  assert.equal((await submissions.getUserSubmissionDetail({ actor, submissionId: first.id }))!.scanRuns[0]!.status, "running");
  await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [stale.jobId]);
  const restarted = new PackageScanService(db);
  const replacement = await restarted.claimNext();
  assert.ok(replacement);
  assert.notEqual(replacement.leaseId, stale.leaseId);
  assert.notEqual(replacement.scanRunId, stale.scanRunId);
  assert.equal(await scans.processClaim(stale), false);
  assert.equal(await restarted.processClaim(replacement), true);
  const passed = (await submissions.getReviewSubmissionDetail({ actor: reviewer, submissionId: first.id }))!;
  assert.equal(passed.securityStatus, "passed");
  assert.deepEqual(passed.scanRuns.map((run) => run.status), ["failed", "succeeded"]);
  assert.ok(passed.scanRuns.every((run) => run.artifactSha256 === first.artifact.sha256 && run.runnerVersion === PACKAGE_SCAN_RUNNER_VERSION));
  assert.equal(passed.scanRuns[0]!.failureCode, "lease_expired");
  await assert.rejects(pool.query("UPDATE scan_runs SET status='running' WHERE id=$1", [replacement.scanRunId]), /immutable/);
  await assert.rejects(pool.query("INSERT INTO scan_findings (scan_run_id, category, severity, message) VALUES ($1,'policy','warning','late finding')", [replacement.scanRunId]), /immutable/);
  await assert.rejects(pool.query("INSERT INTO scan_runs (job_id, runner_version, attempt) VALUES ($1,'package-scan-v1',4)", [replacement.jobId]), /scan_runs_binding/);
  await submissions.performReviewAction({ actor: reviewer, submissionId: first.id, action: "approve", artifactSha256: first.artifact.sha256 });
  await submissions.performReviewAction({ actor: reviewer, submissionId: first.id, action: "publish" });
  const prior = await submissions.getPublicBundle({ slug: first.skillSlug, version: first.version });
  assert.ok(prior);

  // Pause a real worker after its terminal evidence write, before COMMIT.
  // A finding writer whose statement starts before that commit must wait and
  // then reject; a snapshot taken before completion cannot admit a late finding.
  const fenced = await submissions.createSubmission({ actor, ...packageInput("0.1.9") });
  const fencedClaim = await scans.claimNext();
  assert.ok(fencedClaim);
  const gate = await pool.connect();
  const gateId = 2026100139;
  await gate.query("SELECT pg_advisory_lock($1::bigint)", [gateId]);
  await pool.query(`CREATE FUNCTION pause_scan_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${gateId}::bigint); RETURN NEW; END $$`);
  await pool.query("CREATE TRIGGER pause_scan_completion AFTER UPDATE ON scan_runs FOR EACH ROW WHEN (OLD.status='running' AND NEW.status='succeeded') EXECUTE FUNCTION pause_scan_completion()");
  const completion = scans.processClaim(fencedClaim);
  let lateFinding: Promise<unknown> | undefined;
  try {
    await waitForDatabaseLock(pool, "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [gateId]);
    const insertion = "INSERT INTO scan_findings (scan_run_id, category, severity, message) VALUES ($1,'policy','warning','concurrent late finding')";
    lateFinding = pool.query(insertion, [fencedClaim.scanRunId]).then(() => null, error => error);
    await waitForDatabaseLock(pool, "SELECT 1 FROM pg_stat_activity WHERE query=$1 AND wait_event_type='Lock'", [insertion]);
    await gate.query("SELECT pg_advisory_unlock($1::bigint)", [gateId]);
    assert.equal(await completion, true);
    assert.match(String(await lateFinding), /immutable/);
    assert.equal((await submissions.getUserSubmissionDetail({ actor, submissionId: fenced.id }))!.scanRuns[0]!.findings.length, 0);
  } finally {
    await gate.query("SELECT pg_advisory_unlock_all()");
    await completion;
    await lateFinding;
    gate.release();
    await pool.query("DROP TRIGGER pause_scan_completion ON scan_runs");
    await pool.query("DROP FUNCTION pause_scan_completion()");
  }

  // Expiry during a row-lock wait is not evaluated using transaction-start time.
  const delayed = await submissions.createSubmission({ actor, ...packageInput("0.1.1") });
  const delayedClaim = await scans.claimNext();
  assert.ok(delayedClaim);
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT s.id FROM skills s JOIN skill_versions v ON v.skill_id=s.id WHERE v.id=$1 FOR UPDATE OF s", [delayed.id]);
    await locker.query("UPDATE jobs SET lease_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1", [delayedClaim.jobId]);
    await locker.query("COMMIT");
    await locker.query("BEGIN");
    await locker.query("SELECT s.id FROM skills s JOIN skill_versions v ON v.skill_id=s.id WHERE v.id=$1 FOR UPDATE OF s", [delayed.id]);
    const pendingCompletion = scans.processClaim(delayedClaim);
    await locker.query("SELECT pg_sleep(0.3)");
    await locker.query("COMMIT");
    assert.equal(await pendingCompletion, false);
  } finally { await locker.query("ROLLBACK"); locker.release(); }
  assert.equal((await submissions.getUserSubmissionDetail({ actor, submissionId: delayed.id }))!.securityStatus, "not-run");
  assert.equal(await scans.runOnce(), 1);

  const warningInput = packageInput("0.1.2");
  warningInput.files.push({ path: "references/hooks.md", content: 'Example dependency metadata: {"postinstall":"echo example"}' });
  const warned = await submissions.createSubmission({ actor, ...warningInput });
  assert.equal(await scans.runOnce(), 1);
  const warning = (await submissions.getReviewSubmissionDetail({ actor: reviewer, submissionId: warned.id }))!;
  assert.equal(warning.securityStatus, "warning");
  assert.ok(warning.scanRuns[0]!.findings.some((finding) => finding.severity === "warning"));
  await assert.rejects(submissions.performReviewAction({ actor: reviewer, submissionId: warned.id, action: "approve", artifactSha256: warned.artifact.sha256 }), deny("PACKAGE_SCAN_NOT_PASSED"));

  // External object failure is retriable; a new process continues from durable attempts.
  const unavailable: ArtifactObjectStorage = {
    async putObject() {}, async deleteObject() {}, async checkReady() {},
    async getObject() { throw new Error("PRIVATE-CONTENT-CANARY"); },
  };
  const remoteStore = new PostgresSubmissionStore(db, { backgroundScans: true, artifactStorage: unavailable });
  const remoteSubmissions = new SubmissionService(remoteStore);
  const failing = await remoteSubmissions.createSubmission({ actor, ...packageInput("0.2.0") });
  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = new PackageScanService(db, { artifactStorage: unavailable });
    const claim = await worker.claimNext();
    assert.ok(claim);
    assert.equal(await worker.processClaim(claim), true);
    await pool.query("UPDATE jobs SET available_at=now() WHERE id=$1", [claim.jobId]);
  }
  const failed = (await submissions.getReviewSubmissionDetail({ actor: reviewer, submissionId: failing.id }))!;
  assert.equal(failed.securityStatus, "failed");
  assert.deepEqual(failed.scanRuns.map((run) => run.status), ["failed", "failed", "failed"]);
  assert.equal(await scans.claimNext(), null);
  await assert.rejects(submissions.performReviewAction({ actor: reviewer, submissionId: failing.id, action: "approve", artifactSha256: failing.artifact.sha256 }), deny("PACKAGE_SCAN_NOT_PASSED"));
  await assert.rejects(submissions.performReviewAction({ actor: reviewer, submissionId: failing.id, action: "publish" }), deny("PACKAGE_SCAN_NOT_PASSED"));

  // A stored artifact drift is terminal, never scanned under the old digest.
  const tampered = await submissions.createSubmission({ actor, ...packageInput("0.3.0") });
  await pool.query("UPDATE skill_artifacts SET payload=jsonb_set(payload, '{files,1,content}', '\"drift\"'::jsonb) WHERE skill_version_id=$1", [tampered.id]);
  assert.equal(await scans.runOnce(), 1);
  const integrity = (await submissions.getUserSubmissionDetail({ actor, submissionId: tampered.id }))!;
  assert.equal(integrity.securityStatus, "failed");
  assert.equal(integrity.scanRuns[0]!.failureCode, "artifact_integrity");

  // Withdrawn state stays withdrawn; worker records failure without reviving it.
  const withdrawn = await submissions.createSubmission({ actor, ...packageInput("0.4.0") });
  await submissions.performSubmissionOwnerAction({ actor, submissionId: withdrawn.id, action: "withdraw" });
  assert.equal(await scans.runOnce(), 1);
  assert.equal((await submissions.getUserSubmissionDetail({ actor, submissionId: withdrawn.id }))!.lifecycleStatus, "archived");

  const corrected = await submissions.createSubmission({ actor, ...packageInput("0.5.0") });
  assert.equal(await scans.runOnce(), 1);
  await submissions.performReviewAction({ actor: reviewer, submissionId: corrected.id, action: "approve", artifactSha256: corrected.artifact.sha256 });
  await submissions.performReviewAction({ actor: reviewer, submissionId: corrected.id, action: "publish" });
  assert.deepEqual(await submissions.getPublicBundle({ slug: first.skillSlug, version: first.version }), prior);
  const publicSummary = await submissions.getPublicRelease({ slug: corrected.skillSlug, version: corrected.version });
  assert.ok(publicSummary);
  assert.equal(JSON.stringify(publicSummary).includes("findings"), false);
  assert.equal(await submissions.getUserSubmissionDetail({ actor: { id: maintainer.id, roles: ["user"] }, submissionId: corrected.id }), null);
  await assert.rejects(submissions.getReviewSubmissionDetail({ actor, submissionId: corrected.id }), deny("REVIEW_ROLE_REQUIRED"));
  const audit = await pool.query("SELECT details FROM audit_events WHERE action LIKE 'package_scan.%'");
  assert.ok(audit.rows.length > 0);
  assert.equal(JSON.stringify(audit.rows).includes("PRIVATE-CONTENT-CANARY"), false);
  assert.equal(JSON.stringify(audit.rows).includes("SKILL.md"), false);
  if (process.env.QUALITY_EVIDENCE_DIR) {
    await mkdir(process.env.QUALITY_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.QUALITY_EVIDENCE_DIR, "package-quality-journey.json"), JSON.stringify({
      schemaVersion: 1, evidence: "postgres-service-journey", runnerVersion: PACKAGE_SCAN_RUNNER_VERSION,
      assertions: ["concurrent-claim", "restart-recovery", "stale-fence", "retry-exhaustion", "immutable-completed-scan", "concurrent-late-finding-denied", "artifact-drift-denied", "withdrawal-preserved", "corrected-version-published", "prior-artifact-preserved", "private-detail-denied", "public-summary-safe", "audit-safe"],
      status: "passed", providerExecution: false, deployed: false,
    }, null, 2) + "\n");
  }
});

async function waitForDatabaseLock(pool: ReturnType<typeof createPgPool>, query: string, values: unknown[]) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await pool.query(query, values)).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Expected database lock wait did not occur");
}

function packageInput(version: string) {
  const manifest = parseSkillManifest({
    name: "quality-journey", title: "Quality Journey", summary: "Public-safe quality fixture.", version,
    license: "Apache-2.0", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["quality"],
  });
  return { manifest, files: [
    { path: "skill.json", content: JSON.stringify(manifest) },
    { path: "SKILL.md", content: "# Quality Journey\n\nCheck the supplied public fixture carefully.\n" },
    { path: "references/example.md", content: "Public example with preserved newline.\n" },
  ] };
}
