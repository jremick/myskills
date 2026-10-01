import { AppError, defaultOrganizationPolicyV1, organizationPolicyDigest } from "@myskills-app/core";
/**
 * Written before AUTHOR-1 production code, 2026-10-01.
 * Independent boundary: real HTTP auth + real Postgres draft and registry writes.
 * Existing registry tests cannot detect draft isolation, stale heads or partial receipts.
 * Failure inventory: malformed intake; owner/scopes/role/MFA bypass; lost updates;
 * stale validation/submission; duplicate submit and version; save/submit race;
 * rollback after version insertion; history pruning; source access revoked mid-read;
 * byte changes in release/submission forks and feedback correction.
 * Evidence contains only statuses, IDs and digests, never credentials or package bodies.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword, hashSessionToken } from "@myskills-app/auth";
import { encodePackageArchive } from "@myskills-app/skill-package";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import type { ArtifactObjectStorage } from "../src/artifacts/storage.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { PackageScanService } from "../src/package-quality/scan-service.js";
import { DraftService } from "../src/drafts/service.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { PostgresDraftStore } from "../src/drafts/postgres-store.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";

// Route JSON is verified as an external contract, not implementation types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const password = "Draft-test-password-937!";
const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("private draft route journey preserves history, isolation and atomic submission", { timeout: 180_000 }, async (t) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  const name = new URL(databaseUrl).pathname.slice(1);
  assert.match(name, /(^|[_-])(test|ci)([_-]|$)/i, "refuse a non-disposable database");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  for (const file of readdirSync(migrationsDir).filter((entry) => entry.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
  }
  const db = createDb(pool);
  const storage = new HeldStorage();
  const submissions = new SubmissionService(new PostgresSubmissionStore(db, { artifactStorage: storage, backgroundScans: true }));
  const scans = new PackageScanService(db, { artifactStorage: storage });
  const store = new PostgresDraftStore(db);
  const service = new DraftService(store, submissions);
  const app = buildApp({
    skillRepository: new PostgresSkillRepository(db), submissionService: submissions, draftService: service,
    authService: new AuthService(new PostgresAuthStore(db), {}),
    requestLimiter: new MemoryAuthRateLimiter({ maxAttempts: 10_000, windowMs: 60_000 }),
  });
  t.after(() => app.close());
  const users = { alice: randomUUID(), bob: randomUUID(), reviewer: randomUUID(), viewer: randomUUID() };
  for (const [actor, id] of Object.entries(users)) {
    const email = `${actor}@draft.example`;
    await pool.query("INSERT INTO users (id,email,normalized_email,name,status,email_verified_at) VALUES ($1,$2,$2,$3,'active',now())", [id, email, actor]);
    await pool.query("INSERT INTO password_credentials (user_id,password_hash) VALUES ($1,$2)", [id, await hashPassword(password)]);
    await pool.query("INSERT INTO role_assignments (user_id,role) VALUES ($1,$2)", [id, actor === "reviewer" ? "maintainer" : actor === "viewer" ? "user" : "author"]);
  }
  const call = async (method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload === undefined ? {} : { payload: payload as Json }) });
    return { status: response.statusCode, body: response.json() as Json };
  };
  const ok = (response: { status: number; body: Json }, expected = 200) => {
    assert.equal(response.status, expected, JSON.stringify(response.body).slice(0, 400));
    return response.body;
  };
  const denied = (response: { status: number; body: Json }, expected: number, code: string) => {
    assert.equal(response.status, expected, JSON.stringify(response.body).slice(0, 400));
    assert.equal(response.body.error?.code, code);
  };
  const login = async (actor: string) => ok(await call("POST", "/v1/auth/login", undefined, { email: `${actor}@draft.example`, password })).token as string;
  const alice = await login("alice");
  const bob = await login("bob");
  const reviewerWithoutMfa = await login("reviewer");
  const viewer = await login("viewer");
  const enroll = ok(await call("POST", "/v1/auth/mfa/totp/enroll", reviewerWithoutMfa, { password }), 201).enrollment;
  const confirmed = ok(await call("POST", "/v1/auth/mfa/totp/confirm", reviewerWithoutMfa, { factorId: enroll.factorId, code: generateTotpCode(enroll.secret) })).mfa;
  const challenge = ok(await call("POST", "/v1/auth/login", undefined, { email: "reviewer@draft.example", password }));
  const reviewer = ok(await call("POST", "/v1/auth/mfa/verify", undefined, { challengeToken: challenge.challengeToken, recoveryCode: confirmed.recoveryCodes[0] })).token as string;
  const evidence: Json[] = [];

  await t.test("save incomplete metadata then correct multi-file content without changing history", async () => {
    const files = packageFiles("draft-workflow", "1.0.0");
    const incomplete = files.map((file) => file.path === "skill.json" ? { ...file, content: "{" } : file);
    const created = ok(await call("POST", "/v1/drafts", alice, { title: "Workflow notes", files: incomplete }), 201).draft;
    assert.equal(created.revision, 1);
    assert.equal(created.submission, null);
    assert.deepEqual(ok(await call("GET", `/v1/drafts/${created.id}`, alice)).draft.files, incomplete);
    const invalid = ok(await call("POST", `/v1/drafts/${created.id}/validate`, alice, { expectedRevision: 1 })).validation;
    assert.equal(invalid.valid, false);
    assert.equal(invalid.manifest, null);
    assert.equal(invalid.issues[0].code, "INVALID_PACKAGE_MANIFEST");
    const edited = ok(await call("PUT", `/v1/drafts/${created.id}`, alice, { expectedRevision: 1, title: "Workflow notes", files })).draft;
    assert.equal(edited.revision, 2);
    assert.deepEqual(ok(await call("GET", `/v1/drafts/${created.id}/revisions/1`, alice)).draft.files, incomplete);
    assert.deepEqual(ok(await call("GET", `/v1/drafts/${created.id}/history`, alice)).revisions.map((row: Json) => row.revision), [2, 1]);
    assert.equal(ok(await call("POST", `/v1/drafts/${created.id}/validate`, alice, { expectedRevision: 2 })).validation.valid, true);
    const summary = ok(await call("GET", "/v1/drafts", alice)).drafts[0];
    assert.equal(summary.files, undefined);
    assert.equal(summary.fileCount, files.length);
    assert.equal(summary.textBytes, files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0));

    for (const outsider of [bob, reviewer]) {
      for (const url of [`/v1/drafts/${created.id}`, `/v1/drafts/${created.id}/history`, `/v1/drafts/${created.id}/revisions/1`]) denied(await call("GET", url, outsider), 404, "DRAFT_NOT_FOUND");
      denied(await call("PUT", `/v1/drafts/${created.id}`, outsider, { expectedRevision: 2, title: "Attempt", files }), 404, "DRAFT_NOT_FOUND");
      for (const suffix of ["validate", "submit"]) denied(await call("POST", `/v1/drafts/${created.id}/${suffix}`, outsider, { expectedRevision: 2 }), 404, "DRAFT_NOT_FOUND");
    }
    denied(await call("POST", "/v1/drafts", viewer, { title: "Attempt", files }), 403, "SUBMISSION_ROLE_REQUIRED");
    denied(await call("POST", "/v1/drafts", reviewerWithoutMfa, { title: "Attempt", files }), 403, "MFA_VERIFICATION_REQUIRED");
    const readToken = ok(await call("POST", "/v1/auth/api-tokens", alice, { name: "Draft reader", scopes: ["submissions:read"] }), 201).token.token;
    ok(await call("GET", `/v1/drafts/${created.id}`, readToken));
    denied(await call("PUT", `/v1/drafts/${created.id}`, readToken, { expectedRevision: 2, title: "Attempt", files }), 403, "API_TOKEN_SCOPE_REQUIRED");

    const saves = await Promise.all(["A", "B"].map((title) => call("PUT", `/v1/drafts/${created.id}`, alice, { expectedRevision: 2, title, files })));
    assert.deepEqual(saves.map((row) => row.status).sort(), [200, 409]);
    assert.equal(saves.find((row) => row.status === 409)?.body.error.code, "DRAFT_REVISION_CONFLICT");
    for (const suffix of ["validate", "submit"]) denied(await call("POST", `/v1/drafts/${created.id}/${suffix}`, alice, { expectedRevision: 2 }), 409, "DRAFT_REVISION_CONFLICT");

    const slugLock = await pool.connect();
    await slugLock.query("BEGIN");
    await slugLock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["submission:draft-workflow"]);
    const pendingSubmits = [1, 2].map(() => call("POST", `/v1/drafts/${created.id}/submit`, alice, { expectedRevision: 3 }));
    try { await waitForLocks(pool, "pg_advisory_xact_lock", 2); }
    finally { await slugLock.query("COMMIT"); slugLock.release(); }
    const submits = await Promise.all(pendingSubmits);
    assert.deepEqual(submits.map((row) => row.status).sort(), [200, 202]);
    assert.equal(submits[0]!.body.submission.id, submits[1]!.body.submission.id);
    const submitted = submits[0]!.body.submission;
    assert.equal(submitted.artifactSha256, digest(files));
    assert.equal(submitted.securityStatus, "not-run");
    assert.equal(submitted.scan.status, "queued");
    const crashed = await scans.claimNext();
    assert.ok(crashed);
    await pool.query("UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [crashed.jobId]);
    await scans.runOnce();
    const replay = ok(await call("POST", `/v1/drafts/${created.id}/submit`, alice, { expectedRevision: 3 }));
    assert.equal(replay.submission.id, submitted.id);
    assert.equal(replay.submission.scan.status, "succeeded");
    assert.equal(replay.submission.securityStatus, "passed");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM skill_versions")).rows[0].n, 1);
    assert.equal(submits[0]!.body.draft.submission.id, submitted.id);
    await submissions.performReviewAction({ actor: { id: users.reviewer, roles: ["maintainer"], mfaVerified: true }, submissionId: submitted.id, action: "request-changes", reason: "Clarify the guide." });
    const forked = ok(await call("POST", "/v1/drafts", alice, { source: { kind: "submission", submissionId: submitted.id } }), 201).draft;
    assert.deepEqual([...forked.files].sort(byPath), [...files].sort(byPath));
    assert.equal(forked.source.artifactSha256, submitted.artifactSha256);
    denied(await call("POST", "/v1/drafts", bob, { source: { kind: "submission", submissionId: submitted.id } }), 404, "DRAFT_SOURCE_NOT_FOUND");
    const corrected = packageFiles("draft-workflow", "1.0.1");
    corrected.find((file) => file.path === "references/guide.md")!.content += "\nClarified setup.\n";
    ok(await call("PUT", `/v1/drafts/${forked.id}`, alice, { expectedRevision: 1, title: "Correction", files: corrected }));
    const correction = ok(await call("POST", `/v1/drafts/${forked.id}/submit`, alice, { expectedRevision: 2 }), 202).submission;
    assert.notEqual(correction.id, submitted.id);
    assert.equal((await submissions.getUserSubmissionDetail({ actor: { id: users.alice, roles: ["author"] }, submissionId: submitted.id }))?.changeRequestReason, "Clarify the guide.");
    const original = await submissions.getUserSubmissionBundle({ actor: { id: users.alice, roles: ["author"] }, submissionId: submitted.id });
    assert.equal(digest(original!.payload.files), submitted.artifactSha256);
    ok(await call("PUT", `/v1/drafts/${created.id}`, alice, { expectedRevision: 3, title: "New work", files: packageFiles("draft-workflow", "1.0.2") }));
    assert.equal(ok(await call("GET", `/v1/drafts/${created.id}`, alice)).draft.submission, null);
    assert.equal(ok(await call("GET", `/v1/drafts/${created.id}/revisions/3`, alice)).draft.submission.id, submitted.id);
    evidence.push({ check: "history-feedback-concurrency", draftId: created.id, submissionId: submitted.id, correctionId: correction.id, artifactSha256: submitted.artifactSha256 });
  });

  await t.test("safe intake and scanner diagnostics", async () => {
    const clean = packageFiles("intake-workflow", "1.0.0");
    const archive = encodePackageArchive(clean);
    assert.deepEqual(ok(await call("POST", "/v1/drafts/preview", alice, { archive: { filename: "held.zip", contentBase64: archive.toString("base64") } })).preview.files.sort(byPath), [...clean].sort(byPath));
    for (const files of [
      [{ path: "../escape", content: "x" }], [{ path: "a", content: "x" }, { path: "a/b", content: "y" }],
      [{ path: "NUL", content: "x" }], [{ path: "x", content: "\0" }], [{ path: "x", content: "\ud800" }],
      [{ path: "x", content: "x".repeat(1024 * 1024 + 1) }], Array.from({ length: 501 }, (_, i) => ({ path: `f${i}`, content: "x" })),
    ]) denied(await call("POST", "/v1/drafts/preview", alice, { files }), 400, "INVALID_PACKAGE_PAYLOAD");
    denied(await call("POST", "/v1/drafts/preview", alice, { files: clean, archive: { contentBase64: archive.toString("base64") } }), 400, "INVALID_DRAFT_INPUT");
    const symlink = Buffer.from(archive);
    const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    symlink.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    denied(await call("POST", "/v1/drafts/preview", alice, { archive: { contentBase64: symlink.toString("base64") } }), 400, "INVALID_PACKAGE_PAYLOAD");
    const badUtf8 = Buffer.from(archive);
    const contentOffset = 30 + badUtf8.readUInt16LE(26);
    badUtf8[contentOffset] = 0xff;
    denied(await call("POST", "/v1/drafts/preview", alice, { archive: { contentBase64: badUtf8.toString("base64") } }), 400, "INVALID_PACKAGE_PAYLOAD");
    const secret = [...clean, { path: "notes.txt", content: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\nfixture only" }];
    const created = ok(await call("POST", "/v1/drafts", alice, { title: "Unsafe draft", files: secret }), 201).draft;
    const result = ok(await call("POST", `/v1/drafts/${created.id}/validate`, alice, { expectedRevision: 1 })).validation;
    assert.equal(result.valid, false);
    assert.equal(result.findings[0].category, "secret");
    denied(await call("POST", `/v1/drafts/${created.id}/submit`, alice, { expectedRevision: 1 }), 422, "PACKAGE_SCAN_BLOCKED");
    assert.equal(ok(await call("GET", `/v1/drafts/${created.id}`, alice)).draft.submission, null);
    evidence.push({ check: "intake-scanner", draftId: created.id, rejectedUnsafe: true });
  });

  await t.test("duplicate versions and failure after insert leave no partial draft receipt", async () => {
    const files = packageFiles("rollback-workflow", "1.0.0");
    const first = ok(await call("POST", "/v1/drafts", alice, { title: "First", files }), 201).draft;
    const duplicate = ok(await call("POST", "/v1/drafts", alice, { title: "Duplicate", files }), 201).draft;
    ok(await call("POST", `/v1/drafts/${first.id}/submit`, alice, { expectedRevision: 1 }), 202);
    const deniedDuplicate = await call("POST", `/v1/drafts/${duplicate.id}/submit`, alice, { expectedRevision: 1 });
    assert.equal(deniedDuplicate.status, 409);
    assert.equal(ok(await call("GET", `/v1/drafts/${duplicate.id}`, alice)).draft.submission, null);
    const failure = ok(await call("POST", "/v1/drafts", alice, { title: "Failure", files: packageFiles("rollback-workflow", "1.0.1") }), 201).draft;
    await pool.query("CREATE FUNCTION reject_draft_bind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.submission_id IS NOT NULL THEN RAISE EXCEPTION 'disposable bind failure'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER reject_draft_bind BEFORE UPDATE ON author_draft_revisions FOR EACH ROW EXECUTE FUNCTION reject_draft_bind()");
    try {
      const response = await call("POST", `/v1/drafts/${failure.id}/submit`, alice, { expectedRevision: 1 });
      assert.equal(response.status, 500);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM skill_versions WHERE version='1.0.1' AND skill_id=(SELECT id FROM skills WHERE slug='rollback-workflow')")).rows[0].n, 0);
      assert.equal(ok(await call("GET", `/v1/drafts/${failure.id}`, alice)).draft.submission, null);
    } finally { await pool.query("DROP TRIGGER reject_draft_bind ON author_draft_revisions"); await pool.query("DROP FUNCTION reject_draft_bind()"); }
    ok(await call("POST", `/v1/drafts/${failure.id}/submit`, alice, { expectedRevision: 1 }), 202);
    evidence.push({ check: "transaction-rollback", draftId: failure.id });
  });

  await t.test("save raced with submit cannot bind changed bytes", async () => {
    const initial = packageFiles("raced-workflow", "1.0.0");
    const created = ok(await call("POST", "/v1/drafts", alice, { title: "Race", files: initial }), 201).draft;
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM author_drafts WHERE id=$1 FOR UPDATE", [created.id]);
    const submit = call("POST", `/v1/drafts/${created.id}/submit`, alice, { expectedRevision: 1 });
    const save = call("PUT", `/v1/drafts/${created.id}`, alice, { expectedRevision: 1, title: "Race edit", files: packageFiles("raced-workflow", "1.0.1") });
    try { await waitForLocks(pool, "FROM author_drafts", 2); }
    finally { await client.query("COMMIT"); client.release(); }
    const [submitted, saved] = await Promise.all([submit, save]);
    assert.equal(saved.status, 200);
    assert.ok([202, 409].includes(submitted.status));
    const head = ok(await call("GET", `/v1/drafts/${created.id}`, alice)).draft;
    assert.equal(head.revision, 2);
    assert.equal(head.submission, null);
    const historic = ok(await call("GET", `/v1/drafts/${created.id}/revisions/1`, alice)).draft;
    if (submitted.status === 202) assert.equal(historic.submission.artifactSha256, digest(initial));
    else assert.equal(historic.submission, null);
    evidence.push({ check: "save-submit-race", draftId: created.id, submitStatus: submitted.status });
  });

  await t.test("release seed preserves exact bytes and cannot survive mid-read revocation", async () => {
    const files = packageFiles("source-workflow", "1.0.0", "public");
    const submitted = await submissions.createSubmission({ actor: { id: users.alice, roles: ["author"] }, manifest: JSON.parse(files.find((file) => file.path === "skill.json")!.content), files });
    // Confirmation scan is a separate stream: establish actual scan completion in this fixture.
    await scans.runOnce();
    await submissions.performReviewAction({ actor: { id: users.reviewer, roles: ["maintainer"], mfaVerified: true }, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
    await submissions.performReviewAction({ actor: { id: users.reviewer, roles: ["maintainer"], mfaVerified: true }, submissionId: submitted.id, action: "publish" });
    const fork = ok(await call("POST", "/v1/drafts", bob, { source: { kind: "release", slug: "source-workflow", version: "1.0.0", platform: "codex" } }), 201).draft;
    assert.deepEqual(fork.files.sort(byPath), [...files].sort(byPath));
    denied(await call("POST", `/v1/drafts/${fork.id}/submit`, bob, { expectedRevision: 1 }), 409, "PACKAGE_SLUG_UNAVAILABLE");
    const before = (await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n;
    storage.beforeGet = async () => { storage.beforeGet = undefined; await pool.query("UPDATE skill_versions SET lifecycle_status='revoked' WHERE id=$1", [submitted.id]); };
    denied(await call("POST", "/v1/drafts", bob, { source: { kind: "release", slug: "source-workflow", version: "1.0.0" } }), 404, "DRAFT_SOURCE_NOT_FOUND");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n, before);
    evidence.push({ check: "source-revocation", sourceId: submitted.id, artifactSha256: submitted.artifact.sha256 });
  });


  await t.test("source membership revoked while draft allocation waits cannot persist held bytes", async () => {
    const files = packageFiles("team-source", "1.0.0", "team");
    const submitted = await submissions.createSubmission({ actor: { id: users.alice, roles: ["author"] }, manifest: JSON.parse(files.find(file => file.path === "skill.json")!.content), files });
    await scans.runOnce(25);
    const reviewerActor = { id: users.reviewer, roles: ["maintainer" as const], mfaVerified: true };
    await submissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
    await submissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "publish" });
    const teamId = randomUUID();
    await pool.query("INSERT INTO teams(id,name,slug,created_by_user_id) VALUES($1,'Fork team','fork-team',$2)", [teamId, users.alice]);
    await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'member')", [teamId, users.bob]);
    await pool.query("INSERT INTO skill_team_grants(skill_id,team_id) SELECT id,$1 FROM skills WHERE slug='team-source'", [teamId]);
    const before = (await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n;
    const locker = await pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`author-drafts:${users.bob}`]);
    const pending = call("POST", "/v1/drafts", bob, { source: { kind: "release", slug: "team-source", version: "1.0.0" } });
    try {
      await waitForLocks(pool, "pg_advisory_xact_lock", 1);
      await pool.query("DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2", [teamId, users.bob]);
    } finally { await locker.query("COMMIT"); locker.release(); }
    denied(await pending, 404, "DRAFT_SOURCE_NOT_FOUND");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n, before);
  });

  await t.test("database payload drift cannot be attributed to the original release or submission digest", async () => {
    const localSubmissions = new SubmissionService(new PostgresSubmissionStore(db, { backgroundScans: true }));
    const localDrafts = new DraftService(store, localSubmissions);
    const files = packageFiles("database-source", "1.0.0", "public");
    const submitted = await localSubmissions.createSubmission({ actor: { id: users.alice, roles: ["author"] }, manifest: JSON.parse(files.find(file => file.path === "skill.json")!.content), files });
    const corrupt = () => pool.query("UPDATE skill_artifacts SET payload=jsonb_set(payload,'{files,1,content}',to_jsonb('altered text'::text)) WHERE skill_version_id=$1", [submitted.id]);
    const before = (await pool.query("SELECT count(*)::int AS n FROM author_drafts")).rows[0].n;
    await corrupt();
    await assert.rejects(localDrafts.create({ id: users.alice, roles: ["author"] }, { source: { kind: "submission", submissionId: submitted.id } }), (error: unknown) => error instanceof AppError && error.code === "ARTIFACT_METADATA_MISMATCH");
    await pool.query("UPDATE skill_artifacts SET payload=$2::jsonb WHERE skill_version_id=$1", [submitted.id, JSON.stringify(submitted.artifact.payload)]);
    await new PackageScanService(db).runOnce(25);
    const reviewerActor = { id: users.reviewer, roles: ["maintainer" as const], mfaVerified: true };
    await localSubmissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
    await localSubmissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "publish" });
    await corrupt();
    await assert.rejects(localDrafts.create({ id: users.bob, roles: ["author"] }, { source: { kind: "release", slug: "database-source", version: "1.0.0" } }), (error: unknown) => error instanceof AppError && error.code === "ARTIFACT_METADATA_MISMATCH");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts")).rows[0].n, before);
  });

  await t.test("external team fork retains parent organization policy and status through insertion", async () => {
    const orgs = new PostgresOrganizationStore(db);
    const policy = { ...structuredClone(defaultOrganizationPolicyV1), teams: { ...defaultOrganizationPolicyV1.teams, requireOrganizationMembershipForTeamMembers: false } };
    const org = await orgs.createOrganization({ name: "External team organization", slug: "external-org", createdByUserId: users.alice,
      creatorEmail: "alice@draft.example", creatorName: "alice", policy, policySha256: organizationPolicyDigest(policy), reason: "Fixture" });
    const team = randomUUID();
    await pool.query("INSERT INTO teams(id,name,slug,created_by_user_id,organization_id) VALUES($1,'External team','external-team',$2,$3)", [team,users.alice,org.organization.id]);
    await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'member')", [team,users.bob]);
    const files = packageFiles("external-team-source", "1.0.0", "team");
    const submitted = await submissions.createSubmission({ actor: { id: users.alice, roles: ["author"] }, manifest: JSON.parse(files[0]!.content), files });
    await scans.runOnce(25);
    const reviewerActor = { id: users.reviewer, roles: ["maintainer" as const], mfaVerified: true };
    await submissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
    await submissions.performReviewAction({ actor: reviewerActor, submissionId: submitted.id, action: "publish" });
    await pool.query("INSERT INTO skill_team_grants(skill_id,team_id) SELECT id,$1 FROM skills WHERE slug='external-team-source'", [team]);
    const gate = await pool.connect();
    const gateId = 724210;
    await pool.query(`CREATE FUNCTION pause_external_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.owner_user_id='${users.bob}'::uuid THEN PERFORM pg_advisory_xact_lock(${gateId}); END IF; RETURN NEW; END; $$`);
    await pool.query("CREATE TRIGGER pause_external_draft BEFORE INSERT ON author_drafts FOR EACH ROW EXECUTE FUNCTION pause_external_draft()");
    try {
      for (const writer of ["policy", "status"] as const) {
        await gate.query("SELECT pg_advisory_lock($1)", [gateId]);
        const fork = call("POST", "/v1/drafts", bob, { source: { kind: "release", slug: "external-team-source", version: "1.0.0" } });
        await waitForLocks(pool, "INSERT INTO author_drafts", 1);
        const strict = { ...structuredClone(policy), teams: { ...policy.teams, requireOrganizationMembershipForTeamMembers: true } };
        const mutation = writer === "policy"
          ? orgs.appendPolicyRevision({ organizationId: org.organization.id, policy: strict, policySha256: organizationPolicyDigest(strict), reason: "Require organization membership", createdByUserId: users.alice })
          : orgs.archiveOrganization({ organizationId: org.organization.id, actorUserId: users.alice });
        await waitForLocks(pool, "organizations", 1);
        await gate.query("SELECT pg_advisory_unlock($1)", [gateId]);
        ok(await fork, 201); await mutation;
        const before = (await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n;
        denied(await call("POST", "/v1/drafts", bob, { source: { kind: "release", slug: "external-team-source", version: "1.0.0" } }), 404, "DRAFT_SOURCE_NOT_FOUND");
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.bob])).rows[0].n,before);
        if (writer === "policy") await orgs.activatePolicyRevision({ organizationId: org.organization.id, revisionId: org.policyRevision.id, actorUserId: users.alice });
      }
    } finally {
      await gate.query("SELECT pg_advisory_unlock_all()"); gate.release();
      await pool.query("DROP TRIGGER pause_external_draft ON author_drafts"); await pool.query("DROP FUNCTION pause_external_draft()");
    }
  });

  await t.test("blocked draft create/save retain current session and token authority", async () => {
    const authStore = new PostgresAuthStore(db);
    for (const operation of ["create", "save"] as const) for (const kind of ["session", "api_token"] as const) {
      for (const failure of ["revocation", "expiry", "valid"] as const) {
        const session = await login("alice");
        const issued = kind === "api_token" ? ok(await call("POST", "/v1/auth/api-tokens", session, { name: "Blocked writer", scopes: ["skills:submit"] }), 201).token : null;
        const credential = issued?.token ?? session;
        const files = packageFiles("blocked-draft", "1.0.0");
        const initial = operation === "save" ? ok(await call("POST", "/v1/drafts", session, { title: "Initial", files }), 201).draft : null;
        const before = (await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.alice])).rows[0].n;
        const locker = await pool.connect();
        await locker.query("BEGIN");
        if (initial) await locker.query("SELECT id FROM author_drafts WHERE id=$1 FOR UPDATE", [initial.id]);
        else await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`author-drafts:${users.alice}`]);
        const pending = initial ? call("PUT", `/v1/drafts/${initial.id}`, credential, { expectedRevision: 1, title: "Changed", files })
          : call("POST", "/v1/drafts", credential, { title: "Changed", files });
        try {
          await waitForLocks(pool, initial ? "FROM author_drafts" : "pg_advisory_xact_lock", 1);
          if (failure === "revocation") {
            if (issued) await authStore.revokeApiToken({ userId: users.alice, tokenId: issued.id });
            else await authStore.revokeSessionByTokenHash(hashSessionToken(session));
          } else if (failure === "expiry") {
            await pool.query(`UPDATE ${kind === "session" ? "auth_sessions" : "api_tokens"} SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1`, [hashSessionToken(credential)]);
          }
        } finally { await locker.query("COMMIT"); locker.release(); }
        const response = await pending;
        if (failure === "valid") ok(response, initial ? 200 : 201);
        else denied(response, 401, "AUTHENTICATION_REQUIRED");
        if (initial) assert.equal(ok(await call("GET", `/v1/drafts/${initial.id}`, alice)).draft.revision, failure === "valid" ? 2 : 1);
        else assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1", [users.alice])).rows[0].n, before + (failure === "valid" ? 1 : 0));
      }
    }
  });

  await t.test("blocked draft writes use current scopes, roles and credential MFA provenance", async () => {
    const files=packageFiles("current-authority", "1.0.0");
    for(const failure of ["scope", "role", "assurance"] as const) {
      const credential=failure==="assurance" ? reviewer : ok(await call("POST","/v1/auth/api-tokens",alice,{name:"Current writer",scopes:["skills:submit"]}),201).token.token as string;
      const ownerId=failure==="assurance" ? users.reviewer : users.alice;
      const before=(await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1",[ownerId])).rows[0].n;
      const locker=await pool.connect();await locker.query("BEGIN");await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`author-drafts:${ownerId}`]);
      const pending=call("POST","/v1/drafts",credential,{title:"Current authority",files});
      try {
        await waitForLocks(pool,"pg_advisory_xact_lock",1);
        if(failure==="scope")await pool.query("UPDATE api_tokens SET scopes='[]'::jsonb WHERE token_hash=$1",[hashSessionToken(credential)]);
        else if(failure==="role")await pool.query("DELETE FROM role_assignments WHERE user_id=$1 AND role='author'",[ownerId]);
        else await pool.query("UPDATE auth_sessions SET mfa_verified_at=NULL WHERE token_hash=$1",[hashSessionToken(credential)]);
      } finally {await locker.query("COMMIT");locker.release();}
      denied(await pending,403,failure==="scope"?"API_TOKEN_SCOPE_REQUIRED":failure==="role"?"SUBMISSION_ROLE_REQUIRED":"MFA_VERIFICATION_REQUIRED");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM author_drafts WHERE owner_user_id=$1",[ownerId])).rows[0].n,before);
      if(failure==="role")await pool.query("INSERT INTO role_assignments(user_id,role) VALUES($1,'author')",[ownerId]);
    }
  });

  await t.test("draft submit denies stale authority after both head and allocation waits without version job or receipt", async () => {
    let sequence = 0;
    const authStore = new PostgresAuthStore(db);
    for (const barrier of ["head", "allocation"] as const) for (const kind of ["session", "api_token"] as const) {
      for (const failure of ["revocation", "expiry", "scope", "role", "valid"] as const) {
        if (kind === "session" && failure === "scope") continue;
        const session = await login("alice");
        const issued = kind === "api_token" ? ok(await call("POST", "/v1/auth/api-tokens", session, { name: "Submit authority", scopes: ["skills:submit"] }), 201).token : null;
        const credential = issued?.token ?? session;
        const slug = `submit-authority-${++sequence}`;
        const files = packageFiles(slug, "1.0.0");
        const draft = ok(await call("POST", "/v1/drafts", session, { title: "Submit authority", files }), 201).draft;
        let expiry = 0;
        if (failure === "expiry") expiry = new Date((await pool.query(`UPDATE ${kind === "session" ? "auth_sessions" : "api_tokens"} SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE token_hash=$1 RETURNING expires_at`, [hashSessionToken(credential)])).rows[0].expires_at).getTime();
        const locker = await pool.connect(); await locker.query("BEGIN");
        if (barrier === "head") await locker.query("SELECT id FROM author_drafts WHERE id=$1 FOR UPDATE", [draft.id]);
        else await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`submission:${slug}`]);
        const pending = call("POST", `/v1/drafts/${draft.id}/submit`, credential, { expectedRevision: 1 });
        try {
          await waitForLocks(pool, barrier === "head" ? "FROM author_drafts" : "pg_advisory_xact_lock", 1);
          if (failure === "revocation") {
            if (issued) await authStore.revokeApiToken({ userId: users.alice, tokenId: issued.id });
            else await authStore.revokeSessionByTokenHash(hashSessionToken(session));
          } else if (failure === "expiry") await new Promise(done => setTimeout(done, Math.max(0, expiry - Date.now()) + 30));
          else if (failure === "scope") await pool.query("UPDATE api_tokens SET scopes='[]'::jsonb WHERE token_hash=$1", [hashSessionToken(credential)]);
          else if (failure === "role") await pool.query("DELETE FROM role_assignments WHERE user_id=$1 AND role='author'", [users.alice]);
        } finally { await locker.query("COMMIT"); locker.release(); }
        const response = await pending;
        if (failure === "valid") ok(response, 202);
        else denied(response, failure === "scope" || failure === "role" ? 403 : 401, failure === "scope" ? "API_TOKEN_SCOPE_REQUIRED" : failure === "role" ? "SUBMISSION_ROLE_REQUIRED" : "AUTHENTICATION_REQUIRED");
        if (failure === "role") await pool.query("INSERT INTO role_assignments(user_id,role) VALUES($1,'author')", [users.alice]);
        const versions = (await pool.query("SELECT count(*)::int AS n FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.slug=$1", [slug])).rows[0].n;
        const jobs = (await pool.query("SELECT count(*)::int AS n FROM jobs j JOIN skill_versions v ON v.id::text=j.payload->>'versionId' JOIN skills s ON s.id=v.skill_id WHERE j.type='package-scan' AND s.slug=$1", [slug])).rows[0].n;
        const scans = (await pool.query("SELECT count(*)::int AS n FROM scan_runs r JOIN skill_versions v ON v.id=r.skill_version_id JOIN skills s ON s.id=v.skill_id JOIN jobs j ON j.id=r.job_id WHERE j.type='package-scan' AND j.payload->>'versionId'=v.id::text AND j.payload->>'scanRunId'=r.id::text AND s.slug=$1", [slug])).rows[0].n;
        const receipt = (await pool.query("SELECT submission_id FROM author_draft_revisions WHERE draft_id=$1 AND revision=1", [draft.id])).rows[0].submission_id;
        assert.equal(versions, failure === "valid" ? 1 : 0); assert.equal(jobs, failure === "valid" ? 1 : 0); assert.equal(scans, failure === "valid" ? 1 : 0); assert.equal(Boolean(receipt), failure === "valid");
        evidence.push({ check: "submit-current-authority", barrier, kind, failure, versions, jobs, scans, receiptPresent: Boolean(receipt) });
      }
    }
    for (const barrier of ["head", "allocation"] as const) {
      await pool.query("UPDATE auth_sessions SET mfa_verified_at=clock_timestamp() WHERE token_hash=$1", [hashSessionToken(reviewer)]);
      const slug = `submit-assurance-${barrier}`;
      const draft = ok(await call("POST", "/v1/drafts", reviewer, { title: "Assurance", files: packageFiles(slug, "1.0.0") }), 201).draft;
      const locker = await pool.connect(); await locker.query("BEGIN");
      if (barrier === "head") await locker.query("SELECT id FROM author_drafts WHERE id=$1 FOR UPDATE", [draft.id]);
      else await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`submission:${slug}`]);
      const pending = call("POST", `/v1/drafts/${draft.id}/submit`, reviewer, { expectedRevision: 1 });
      try {
        await waitForLocks(pool, barrier === "head" ? "FROM author_drafts" : "pg_advisory_xact_lock", 1);
        await pool.query("UPDATE auth_sessions SET mfa_verified_at=NULL WHERE token_hash=$1", [hashSessionToken(reviewer)]);
      } finally { await locker.query("COMMIT"); locker.release(); }
      denied(await pending, 403, "MFA_VERIFICATION_REQUIRED");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.slug=$1", [slug])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT submission_id FROM author_draft_revisions WHERE draft_id=$1", [draft.id])).rows[0].submission_id, null);
    }
  });

  await t.test("history and author limits refuse without pruning", async () => {
    const files = packageFiles("limits-workflow", "1.0.0");
    const created = ok(await call("POST", "/v1/drafts", bob, { title: "History", files }), 201).draft;
    for (let revision = 1; revision < 100; revision += 1) ok(await call("PUT", `/v1/drafts/${created.id}`, bob, { expectedRevision: revision, title: `Revision ${revision + 1}`, files }));
    denied(await call("PUT", `/v1/drafts/${created.id}`, bob, { expectedRevision: 100, title: "Overflow", files }), 409, "DRAFT_HISTORY_LIMIT");
    assert.equal(ok(await call("GET", `/v1/drafts/${created.id}/history`, bob)).revisions.length, 100);
    let current = ok(await call("GET", "/v1/drafts", bob)).drafts.length;
    while (current < 100) { ok(await call("POST", "/v1/drafts", bob, { title: `Draft ${++current}`, files: [] }), 201); }
    denied(await call("POST", "/v1/drafts", bob, { title: "Overflow", files: [] }), 409, "DRAFT_LIMIT");
    assert.equal(ok(await call("GET", "/v1/drafts", bob)).drafts.length, 100);
    evidence.push({ check: "retention-limits", retainedDrafts: 100, retainedRevisions: 100 });
  });
  const directory = mkdtempSync(join(tmpdir(), "myskills-drafts-evidence-"));
  const evidencePath = join(directory, "receipts.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  t.diagnostic(`Sanitized draft acceptance receipts: ${evidencePath}`);
});

function packageFiles(name: string, version: string, visibility = "private") {
  return [
    { path: "skill.json", content: JSON.stringify({ name, title: "Workflow", summary: "A draft workflow with supporting files.", version, license: "MIT", visibility, platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: ["workflow"] }) },
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: A draft workflow with supporting files.\n---\n\nRead references/guide.md.\n` },
    { path: "references/guide.md", content: "# Guide\n\nUse explicit saves.\n" },
    { path: "LICENSE", content: "MIT License\nCopyright 2026 Fixture Authors\n" },
    { path: "ATTRIBUTION.md", content: "Written by fixture authors.\n" },
  ];
}
function byPath(a: { path: string }, b: { path: string }) { return a.path.localeCompare(b.path); }
function digest(files: { path: string; content: string }[]) { return createHash("sha256").update(JSON.stringify({ files: [...files].sort(byPath) })).digest("hex"); }
async function waitForLocks(pool: ReturnType<typeof createPgPool>, queryPart: string, expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${queryPart}%`]);
    if (result.rows[0].n >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Expected ${expected} overlapping writes waiting on ${queryPart}`);
}
class HeldStorage implements ArtifactObjectStorage {
  private readonly objects = new Map<string, { body: string; contentType: string; sha256: string }>();
  beforeGet?: () => Promise<void>;
  async putObject(input: { key: string; body: string; contentType: string; sha256: string }) { this.objects.set(input.key, { ...input }); }
  async getObject(key: string) { await this.beforeGet?.(); const object = this.objects.get(key); if (!object) throw new Error("missing fixture object"); return object; }
  async deleteObject(key: string) { this.objects.delete(key); }
  async checkReady() {}
}
