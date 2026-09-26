/**
 * Libraries × skill improvement: one persistent HTTP journey over the server's service graph.
 *
 * Written before the production fix, 2026-09-26. Private self-review of a library import publishes
 * the release (it sets published_at), but unlike maintainer publication it does not run the
 * release-declaration publication guard. The expected contract is the one maintainer publication
 * already enforces (skill-improvement-journey.pgtest.ts G9 and G12). This journey adds no new policy.
 *
 * Wiring mirrors src/server.ts: one PostgresImprovementStore is both the ImprovementService store
 * and the PostgresSubmissionStore publicationGuard, and one SubmissionService serves LibraryService,
 * ImprovementService and TargetSkillOperationService. The library source limiter uses the server's
 * Postgres limiter and budget. Test-only substitutions: the synthetic GitHub transport
 * (FixtureGithubSource, no network), a repeatable slug suffix, AuthService without production
 * limiters or secret, and no artifact object storage. Architecture grant and pattern-migration
 * services are not wired; this journey does not reach them.
 *
 * Actors: an author who owns the import, a maintainer, and an admin who enables private
 * self-review. All three sign in with MFA.
 *
 * Failure cases, enumerated before the test (F = must fail safely, S = must succeed exactly):
 * L01 S A strictly private source import (owner only, unpublished, provenance owner = importer)
 *       accepts a pre-publication declaration: kind `declaration`, revision 1, pending. The release
 *       row and the artifact digest do not change.
 * L02 F Self-review while the latest declaration is pending is refused: 409
 *       RELEASE_DECLARATION_NOT_APPROVED, details.status `pending` for revision 1. The release stays
 *       unpublished and unreviewed with no attestation, the candidate stays `accepted`, and a durable
 *       `review.private_self_review` deny audit records `release_declaration_not_approved`.
 * L03 F After a maintainer rejects that revision, self-review is still refused (details.status
 *       `rejected`), with a second durable deny audit and no state change.
 * L04 F On a second import, a maintainer approval for other bytes is refused (422
 *       IMPROVEMENT_BINDING_MISMATCH). An approval row stored for other bytes (the G12 fixture) blocks
 *       self-review with details.status `binding-mismatch`, one deny audit and no state change.
 * L05 S A corrected revision approved for the exact release, artifact, revision and declaration
 *       digest enables self-review: published, still private, approved for that artifact, one
 *       `private-self-review` attestation by the owner, and one allow audit.
 * L06 S After publication, a declaration write is recorded as an `attestation` (revision 3), never a
 *       declaration. It gates nothing while pending (L07 runs with it pending). A maintainer then
 *       approves it for the same bytes. Compatibility projects declaration revision 2 and the
 *       attestation as approved, each bound to the exact artifact (binding recomputed by the test).
 * L07 S Instance elevation still works: the owner requests it, the maintainer queue lists only the
 *       published import, and elevation with the exact hash records `instance-elevation`. The
 *       refused import stays unpublished and out of the queue.
 *
 * Expected red before the guard: L02 fails first. The database publication trigger (migration 0032)
 * aborts the self-review update, so the API answers 500 INTERNAL_SERVER_ERROR instead of 409, and
 * no deny audit is written.
 *
 * Not covered: the lock race between a declaration write and self-review. The existing lock-wait
 * conventions (waitForReleaseRowLock in skill-improvement-journey.pgtest.ts, the pg_blocking_pids
 * poll in library-journey.pgtest.ts) sleep between polls, and this journey does not sleep.
 *
 * Evidence (written on success): MYSKILLS_JOURNEY_EVIDENCE_DIR or the OS temp dir, in a fresh
 * mkdtemp directory (0700), one exclusive-create journal file (0600), bounded in steps and bytes.
 * It holds ids, status codes, error codes and digests only. It never holds tokens or package bodies.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { LIBRARY_LIMITS, optimizationDeclarationApprovalDigest } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { ImprovementService } from "../src/improvements/service.js";
import { PostgresImprovementStore } from "../src/improvements/postgres-store.js";
import { FixtureGithubSource, LibraryService, PostgresLibraryStore, PublicGithubSourceProvider } from "../src/libraries/index.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresTargetSkillOperationStore } from "../src/target-operations/postgres-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { TeamService } from "../src/teams/service.js";
import { PostgresSkillUpgradePolicyStore } from "../src/upgrade-policies/postgres-store.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const password = "correct horse battery staple";
const REPO = "acme/improvement-skills";
const DENY_REASON = "release_declaration_not_approved";
const OTHER_BYTES = "e".repeat(64);
const MAX_JOURNAL_STEPS = 64;
const MAX_JOURNAL_BYTES = 64 * 1024;

const users = {
  owner: { id: "1e5e0000-0000-4000-8000-000000000001", email: "li-owner@example.com", roles: ["author"] },
  maintainer: { id: "1e5e0000-0000-4000-8000-000000000002", email: "li-maintainer@example.com", roles: ["maintainer"] },
  admin: { id: "1e5e0000-0000-4000-8000-000000000003", email: "li-admin@example.com", roles: ["admin"] },
};

// Same targeted declaration as the improvement journey. The corrected revision narrows its limitation.
const declaration = {
  schemaVersion: 1,
  intent: "targeted",
  targets: [{
    id: "codex-gpt-5-5",
    models: [{ provider: "openai", id: "gpt-5.5" }],
    apps: [{ id: "codex", version: "0.50.0" }],
    environment: { os: ["macos", "linux"], requiredCapabilities: ["workspace.read"], network: "optional" },
  }],
  objectives: ["task-success"],
  limitations: ["No claim for other model or app versions."],
};
const correctedDeclaration = { ...declaration, limitations: ["Tested only with Codex 0.50.0. No claim for other model or app versions."] };

// HTTP bodies are asserted field by field; the journey intentionally treats them as untyped JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Reply = { status: number; body: Json };
type Imported = { candidateId: string; digest: string; submissionId: string; slug: string; version: string };

test("library import self-review honours release declarations like maintainer publication", { timeout: 120_000 }, async (t) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => { await pool.end(); });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);
  const journal = createJournal();

  const github = new FixtureGithubSource();
  github.createRepository({
    id: 737373,
    owner: "acme",
    name: "improvement-skills",
    defaultBranch: "main",
    license: "MIT",
    files: {
      "LICENSE": "MIT License\n\nCopyright (c) 2026 Acme\n\nPermission is granted to use, copy and modify this software.\n",
      "skills/incident-brief/SKILL.md": "---\nname: incident-brief\ndescription: Summarize incidents for the on-call handover.\n---\n\n# Incident brief\n\nList the impact, the owner and the next step.\n",
      "skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Draft short release notes from merged changes.\n---\n\n# Release notes\n\nGroup changes by user impact.\n",
    },
  });

  // ---- Service graph as in src/server.ts.
  const improvementStore = new PostgresImprovementStore(db);
  // Publication rechecks the latest release declaration inside its own transaction.
  const submissionStore = new PostgresSubmissionStore(db, { publicationGuard: improvementStore });
  const teamService = new TeamService(new PostgresTeamStore(db));
  const organizationStore = new PostgresOrganizationStore(db);
  const organizationService = new OrganizationService(organizationStore, teamService);
  const architectureStore = new PostgresArchitectureStore(db);
  const skillRepository = new PostgresSkillRepository(db);
  const submissionService = new SubmissionService(submissionStore);
  const architectureTargetService = new ArchitectureTargetService(
    new PostgresArchitectureTargetStore(db),
    new ArchitectureTargetBindingAuthorizer(architectureStore, organizationStore),
  );
  const skillUpgradePolicyService = new SkillUpgradePolicyService(new PostgresSkillUpgradePolicyStore(db));
  const libraryService = new LibraryService({
    store: new PostgresLibraryStore(db),
    submissions: submissionService,
    skillRepository,
    targets: architectureTargetService,
    sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
    slugSuffix: (seed: string) => sha256(seed).slice(0, 10),
  });
  const targetSkillOperationService = new TargetSkillOperationService(
    new PostgresTargetSkillOperationStore(db),
    architectureTargetService,
    submissionService,
    { upgradePolicies: skillUpgradePolicyService, libraryAdoptions: libraryService },
  );
  const authStore = new PostgresAuthStore(db);
  const improvementService = new ImprovementService(improvementStore, { submissionService, teamService, organizationService, authStore });
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore, {}),
    submissionService,
    teamService,
    organizationService,
    architectureStore,
    architectureTargetService,
    targetSkillOperationService,
    skillUpgradePolicyService,
    improvementService,
    libraryService,
    librarySourceLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: LIBRARY_LIMITS.maxSourceOperationsPerHour, windowMs: 60 * 60 * 1000 }),
  });
  t.after(() => app.close());

  const call = async (method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown): Promise<Reply> => {
    const response = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
    let body: Json = {};
    try { body = response.body ? JSON.parse(response.body) : {}; } catch { body = { raw: response.body.slice(0, 64) }; }
    return { status: response.statusCode, body };
  };

  for (const user of Object.values(users)) await insertUser(pool, user);
  const owner = await loginWithMfa(app, users.owner.email);
  const maintainer = await loginWithMfa(app, users.maintainer.email);
  const admin = await loginWithMfa(app, users.admin.email);

  // ---- Setup: self-review enabled, two strictly private imports from one source snapshot.
  const settings = journal.check("setup", "admin enables private self-review", await call("PUT", "/v1/admin/library-settings", admin, { privateSelfReviewEnabled: true, reason: "Library improvement journey" }), 200);
  assert.equal(settings.body.settings.privateSelfReviewEnabled, true);
  const library = journal.check("setup", "personal library", await call("POST", "/v1/libraries", owner, { name: "Owner skills", owner: { type: "user" } }), 201).body.library;
  const entry = journal.check("setup", "source entry", await call("POST", `/v1/libraries/${library.id}/entries`, owner, { kind: "source", url: `https://github.com/${REPO}`, ref: { kind: "default-branch" } }), 201).body.entry;
  const discovery = journal.check("setup", "discovery", await call("POST", `/v1/library-entries/${entry.id}/discoveries`, owner), 200).body.discovery;
  const preview = journal.check("setup", "preview", await call("POST", `/v1/library-entries/${entry.id}/previews`, owner, {
    snapshotId: discovery.snapshot.id,
    paths: ["skills/incident-brief", "skills/release-notes"],
  }), 200).body.preview;
  const candidates = new Map<string, Json>(preview.candidates.map((candidate: Json) => [candidate.sourcePath, candidate]));
  const importCandidate = async (path: string, clientMutationId: string): Promise<Imported> => {
    const candidate = candidates.get(path);
    assert.ok(candidate, `no preview candidate for ${path}`);
    assert.equal(candidate.state, "ready-for-review");
    const imported = journal.check("setup", `import ${path}`, await call("POST", `/v1/library-candidates/${candidate.id}/import`, owner, {
      expectedPackageDigest: candidate.packageDigest,
      release: { classification: "unclassified" },
      clientMutationId,
    }), 202).body;
    assert.equal(imported.candidate.state, "accepted");
    return { candidateId: candidate.id, digest: candidate.packageDigest, submissionId: imported.submission.id, slug: imported.submission.slug, version: imported.submission.version };
  };
  const gated = await importCandidate("skills/incident-brief", "li-import-gated-1");
  const mismatched = await importCandidate("skills/release-notes", "li-import-mismatched-1");
  assert.notEqual(OTHER_BYTES, mismatched.digest);

  // ---- Readbacks shared by the scenarios.
  const releaseState = async (submissionId: string): Promise<Json> => {
    const result = await pool.query(`
      SELECT v.published_at, v.review_status::text AS review_status, v.lifecycle_status::text AS lifecycle_status,
        v.approved_artifact_sha256, s.visibility::text AS visibility, s.lifecycle_status::text AS skill_lifecycle_status,
        s.owner_user_id, a.sha256 AS artifact_sha256, p.owner_user_id AS provenance_owner_user_id,
        (SELECT count(*)::int FROM skill_version_review_attestations x WHERE x.skill_version_id = v.id) AS attestations
      FROM skill_versions v
      JOIN skills s ON s.id = v.skill_id
      JOIN skill_artifacts a ON a.skill_version_id = v.id
      LEFT JOIN skill_release_provenance p ON p.skill_version_id = v.id
      WHERE v.id = $1`, [submissionId]);
    assert.ok(result.rows[0], `no release row for ${submissionId}`);
    return result.rows[0];
  };
  const selfReviewAudits = async (submissionId: string) => {
    const result = await pool.query(
      "SELECT decision, details->>'reason' AS reason FROM audit_events WHERE action = 'review.private_self_review' AND resource_id = $1",
      [submissionId],
    );
    return {
      deny: result.rows.filter((row) => row.decision === "deny").map((row) => row.reason as string),
      allow: result.rows.filter((row) => row.decision === "allow").length,
    };
  };
  const assertRefusedWithoutEffect = async (release: Imported, before: Json) => {
    assert.deepEqual(await releaseState(release.submissionId), before);
    const candidate = await call("GET", `/v1/library-candidates/${release.candidateId}`, owner);
    assert.equal(candidate.status, 200);
    assert.equal(candidate.body.candidate.state, "accepted");
  };
  const declarationsUrl = (release: Imported) => `/v1/improvements/releases/${release.slug}/${release.version}/declarations`;
  const compatibilityUrl = (release: Imported) => `/v1/improvements/releases/${release.slug}/${release.version}/compatibility`;
  const reviewDeclaration = (release: Imported, revision: Json, decision: "approve" | "reject", artifactSha256: string) =>
    call("POST", `${declarationsUrl(release)}/${revision.id}/review`, maintainer, { decision, artifactSha256, declarationSha256: revision.declarationSha256 });
  const selfReview = (release: Imported) => call("POST", `/v1/library-candidates/${release.candidateId}/self-review`, owner, { artifactSha256: release.digest });
  const approvalBinding = (release: Imported, revision: Json) => optimizationDeclarationApprovalDigest({
    releaseId: release.submissionId,
    artifactSha256: release.digest,
    declarationRevisionId: revision.id,
    declarationSha256: revision.declarationSha256,
  });

  // L01: a pending pre-publication declaration on a strictly private import.
  const gatedBefore = await releaseState(gated.submissionId);
  assert.deepEqual(
    [gatedBefore.published_at, gatedBefore.review_status, gatedBefore.visibility, gatedBefore.owner_user_id, gatedBefore.provenance_owner_user_id, gatedBefore.artifact_sha256, gatedBefore.attestations],
    [null, "unreviewed", "private", users.owner.id, users.owner.id, gated.digest, 0],
  );
  const pending = journal.check("L01", "declaration append on private import", await call("POST", declarationsUrl(gated), owner, { declaration, expectedRevisionNumber: 0 }), 201).body.revision;
  assert.deepEqual([pending.kind, pending.revisionNumber, pending.review], ["declaration", 1, null]);
  const pendingCompat = journal.check("L01", "owner compatibility", await call("GET", compatibilityUrl(gated), owner), 200).body.compatibility;
  assert.deepEqual([pendingCompat.release.artifactSha256, pendingCompat.release.published, pendingCompat.declaration.status], [gated.digest, false, "unspecified"]);
  assert.deepEqual(pendingCompat.manage.pendingRevisions.map((revision: Json) => revision.id), [pending.id]);
  assert.deepEqual(await releaseState(gated.submissionId), gatedBefore);

  // L02: self-review is refused while the latest declaration is pending.
  const pendingRefusal = journal.check("L02", "self-review with pending declaration", await selfReview(gated), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.deepEqual(
    [pendingRefusal.body.error.details?.status, pendingRefusal.body.error.details?.revisionId, pendingRefusal.body.error.details?.revisionNumber],
    ["pending", pending.id, 1],
  );
  await assertRefusedWithoutEffect(gated, gatedBefore);
  assert.deepEqual(await selfReviewAudits(gated.submissionId), { deny: [DENY_REASON], allow: 0 });

  // L03: a rejected latest revision still blocks.
  journal.check("L03", "maintainer rejects declaration", await reviewDeclaration(gated, pending, "reject", gated.digest), 200);
  const rejectedRefusal = journal.check("L03", "self-review with rejected declaration", await selfReview(gated), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.deepEqual([rejectedRefusal.body.error.details?.status, rejectedRefusal.body.error.details?.revisionId], ["rejected", pending.id]);
  await assertRefusedWithoutEffect(gated, gatedBefore);
  assert.deepEqual(await selfReviewAudits(gated.submissionId), { deny: [DENY_REASON, DENY_REASON], allow: 0 });

  // L04: an approval bound to other bytes never authorizes self-review.
  const mismatchedBefore = await releaseState(mismatched.submissionId);
  const mismatchedDeclaration = journal.check("L04", "declaration append on second import", await call("POST", declarationsUrl(mismatched), owner, { declaration, expectedRevisionNumber: 0 }), 201).body.revision;
  assert.equal(mismatchedDeclaration.kind, "declaration");
  journal.check("L04", "maintainer approval for other bytes", await reviewDeclaration(mismatched, mismatchedDeclaration, "approve", OTHER_BYTES), 422, "IMPROVEMENT_BINDING_MISMATCH");
  // Same fixture as the improvement journey (G12): a stored approval row bound to other bytes.
  await pool.query(`
    INSERT INTO improvement_declaration_reviews (revision_id, decision, binding_sha256, artifact_sha256, reviewer_user_id, created_at)
    VALUES ($1, 'approve', $2, $2, $3, now())`,
  [mismatchedDeclaration.id, OTHER_BYTES, users.maintainer.id]);
  const mismatchRefusal = journal.check("L04", "self-review with approval for other bytes", await selfReview(mismatched), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.deepEqual([mismatchRefusal.body.error.details?.status, mismatchRefusal.body.error.details?.revisionId], ["binding-mismatch", mismatchedDeclaration.id]);
  await assertRefusedWithoutEffect(mismatched, mismatchedBefore);
  assert.deepEqual(await selfReviewAudits(mismatched.submissionId), { deny: [DENY_REASON], allow: 0 });

  // L05: the exact approved revision enables self-review.
  const corrected = journal.check("L05", "corrected declaration", await call("POST", declarationsUrl(gated), owner, { declaration: correctedDeclaration, expectedRevisionNumber: 1 }), 201).body.revision;
  assert.deepEqual([corrected.kind, corrected.revisionNumber], ["declaration", 2]);
  journal.check("L05", "maintainer approves exact bytes", await reviewDeclaration(gated, corrected, "approve", gated.digest), 200);
  const selfReviewed = journal.check("L05", "self-review with exact approval", await selfReview(gated), 200).body;
  assert.deepEqual(
    [selfReviewed.release.attestation, selfReviewed.release.artifactSha256, selfReviewed.release.slug, selfReviewed.release.version],
    ["private-self-reviewed", gated.digest, gated.slug, gated.version],
  );
  const gatedPublished = await releaseState(gated.submissionId);
  assert.notEqual(gatedPublished.published_at, null);
  assert.deepEqual(
    [gatedPublished.review_status, gatedPublished.approved_artifact_sha256, gatedPublished.visibility, gatedPublished.artifact_sha256],
    ["approved", gated.digest, "private", gated.digest],
  );
  const selfAttestations = await pool.query("SELECT kind, actor_user_id, artifact_sha256 FROM skill_version_review_attestations WHERE skill_version_id = $1", [gated.submissionId]);
  assert.deepEqual(selfAttestations.rows, [{ kind: "private-self-review", actor_user_id: users.owner.id, artifact_sha256: gated.digest }]);
  assert.deepEqual(await selfReviewAudits(gated.submissionId), { deny: [DENY_REASON, DENY_REASON], allow: 1 });
  journal.check("L05", "owner reads published release", await call("GET", `/v1/skills/${gated.slug}/releases/${gated.version}`, owner), 200);
  journal.note("L05", "published", { submissionId: gated.submissionId, artifactSha256: gated.digest, declarationRevision: corrected.revisionNumber });

  // L06: after publication, declaration writes are attestations and do not gate.
  const attestation = journal.check("L06", "post-publication declaration write", await call("POST", declarationsUrl(gated), owner, { declaration, expectedRevisionNumber: 2 }), 201).body.revision;
  assert.deepEqual([attestation.kind, attestation.revisionNumber, attestation.review], ["attestation", 3, null]);
  const revisionKinds = await pool.query("SELECT revision_number, kind FROM improvement_declaration_revisions WHERE release_id = $1 ORDER BY revision_number", [gated.submissionId]);
  assert.deepEqual(revisionKinds.rows.map((row) => [row.revision_number, row.kind]), [[1, "declaration"], [2, "declaration"], [3, "attestation"]]);
  const attestationPending = journal.check("L06", "owner compatibility with pending attestation", await call("GET", compatibilityUrl(gated), owner), 200).body.compatibility;
  assert.deepEqual([attestationPending.release.published, attestationPending.declaration.status, attestationPending.attestation.status], [true, "approved", "none"]);
  assert.deepEqual(attestationPending.manage.pendingRevisions.map((revision: Json) => revision.id), [attestation.id]);

  // L07: instance elevation still works while the attestation is pending.
  journal.check("L07", "owner requests instance review", await call("POST", `/v1/library-candidates/${gated.candidateId}/instance-review-requests`, owner), 200);
  const queue = journal.check("L07", "maintainer elevation queue", await call("GET", "/v1/review/self-reviewed-releases", maintainer), 200).body.releases;
  assert.deepEqual(queue.map((release: Json) => [release.submissionId, release.artifactSha256]), [[gated.submissionId, gated.digest]]);
  const elevated = journal.check("L07", "maintainer elevates exact bytes", await call("POST", `/v1/review/self-reviewed-releases/${gated.submissionId}/elevate`, maintainer, { artifactSha256: gated.digest }), 200).body.release;
  assert.deepEqual([elevated.attestation, elevated.artifactSha256], ["instance-reviewed", gated.digest]);
  const reviewAttestations = await pool.query("SELECT kind, artifact_sha256 FROM skill_version_review_attestations WHERE skill_version_id = $1 ORDER BY kind", [gated.submissionId]);
  assert.deepEqual(reviewAttestations.rows, [
    { kind: "instance-elevation", artifact_sha256: gated.digest },
    { kind: "private-self-review", artifact_sha256: gated.digest },
  ]);
  const mismatchedAfter = await releaseState(mismatched.submissionId);
  assert.equal(mismatchedAfter.published_at, null);
  assert.deepEqual(mismatchedAfter, mismatchedBefore);
  journal.note("L07", "attestations", { submissionId: gated.submissionId, kinds: reviewAttestations.rows.map((row) => row.kind), refusedImportPublished: false });

  // L06 (continued): the pending attestation is approved for the same bytes after elevation.
  journal.check("L06", "maintainer approves attestation", await reviewDeclaration(gated, attestation, "approve", gated.digest), 200);
  const finalCompat = journal.check("L06", "owner compatibility after approvals", await call("GET", compatibilityUrl(gated), owner), 200).body.compatibility;
  assert.deepEqual([finalCompat.release.published, finalCompat.release.artifactSha256], [true, gated.digest]);
  assert.deepEqual([finalCompat.declaration.status, finalCompat.declaration.revision?.id], ["approved", corrected.id]);
  assert.equal(finalCompat.declaration.revision.approvalBindingSha256, approvalBinding(gated, corrected));
  assert.deepEqual([finalCompat.attestation.status, finalCompat.attestation.revision?.id], ["approved", attestation.id]);
  assert.equal(finalCompat.attestation.revision.approvalBindingSha256, approvalBinding(gated, attestation));
  assert.deepEqual(finalCompat.manage.pendingRevisions, []);
  journal.note("L06", "bindings", { declarationRevision: 2, attestationRevision: 3, artifactSha256: gated.digest });

  assert.deepEqual(journal.ids().filter((id) => id !== "setup").sort(), ["L01", "L02", "L03", "L04", "L05", "L06", "L07"]);
  t.diagnostic(`library improvement evidence: ${journal.write()}`);
});

function createJournal() {
  const steps: Json[] = [];
  const push = (step: Json) => {
    assert.ok(steps.length < MAX_JOURNAL_STEPS, "journal step bound exceeded");
    steps.push(step);
  };
  return {
    check(id: string, step: string, response: Reply, status: number, code?: string): Reply {
      assert.equal(response.status, status, `${id} ${step}: expected ${status}${code ? ` ${code}` : ""}, got ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
      if (code) assert.equal(response.body.error?.code, code, `${id} ${step}`);
      push({ id, step, status, ...(code ? { code } : {}) });
      return response;
    },
    note(id: string, step: string, observed: Json) {
      push({ id, step, observed });
    },
    ids: () => [...new Set(steps.map((step) => step.id as string))],
    write(): string {
      const text = `${JSON.stringify({ schemaVersion: 1, journey: "library-improvement", backend: "postgres", steps }, null, 2)}\n`;
      assert.ok(Buffer.byteLength(text) <= MAX_JOURNAL_BYTES, "journal byte bound exceeded");
      const configured = process.env.MYSKILLS_JOURNEY_EVIDENCE_DIR;
      if (configured) mkdirSync(configured, { recursive: true, mode: 0o700 });
      // mkdtemp creates a fresh 0700 directory; the journal is created exclusively with 0600.
      const directory = mkdtempSync(join(configured ?? tmpdir(), "myskills-journey-evidence-"));
      const path = join(directory, "library-improvement-journey.postgres.json");
      writeFileSync(path, text, { flag: "wx", mode: 0o600 });
      return path;
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function insertUser(pool: ReturnType<typeof createPgPool>, user: { id: string; email: string; roles: string[] }): Promise<void> {
  await pool.query(
    "INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())",
    [user.id, user.email, user.email.split("@")[0]],
  );
  await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [user.id, await hashPassword(password)]);
  for (const role of user.roles) await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, $2)", [user.id, role]);
}

async function loginWithMfa(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const setup = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(setup.statusCode, 200, setup.body);
  const setupToken = setup.json().token as string;
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${setupToken}` }, payload: { password } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(challenge.json().mfaRequired, true);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token as string;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}. Use TEST_DATABASE_URL with a test database.`);
  }
}
