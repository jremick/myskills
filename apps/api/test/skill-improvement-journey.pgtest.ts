/**
 * Skill improvement (OPT-1) journey against Postgres persistence.
 *
 * Failure cases enumerated before implementation (Postgres-specific in addition to the memory journeys):
 *  G1 declarations of both kinds persist, bind approval to exact digests, and never touch artifact bytes
 *  G2 concurrent policy writes with the same expected revision: exactly one succeeds
 *  G3 team resource ceilings bind the member and the skill's own manager in personal context
 *  G4 concurrent identical run events: one append, one replay; no duplicate rows
 *  G5 a team-visible release's compatibility projection stays hidden from anonymous readers
 *  G6 accepted local-report evidence projects as locally-reported-improvement, never measured
 *  G7 revision, event, and evidence rows are immutable in the database
 *  G8 audit rows exist for each mutation and contain no finding text or guidance URLs
 *  G9 a rejected latest declaration blocks publication; an approved `unspecified` revision unblocks it; each denial is audited
 *  G10 publication waiting on an in-flight declaration write to the same release row rechecks after the lock and refuses the pending revision
 *  G11 a declaration write that read the release before a concurrent publication committed waits on the release row and is refused
 *  G12 an approval bound to other bytes blocks publication; the database refuses direct publication without an approval for the approved artifact
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateTotpCode, hashPassword, type Role } from "@myskills-app/auth";
import { improvementTreeSha256, optimizationDeclarationDigest } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { ImprovementService } from "../src/improvements/service.js";
import { PostgresImprovementStore } from "../src/improvements/postgres-store.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { TeamService } from "../src/teams/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery staple";
const FINDING_TEXT = "Shorten the routing preamble for the target model.";
const GUIDANCE_URL = "https://docs.example.com/prompting/model-guidance";
const teamId = "71000000-0000-4000-8000-000000000001";

type TestUser = { id: string; email: string; name: string; roles: Role[] };
type ResponseLike = { statusCode: number; body: string; json: () => unknown };

const users = {
  author: { id: "70000000-0000-4000-8000-000000000001", email: "pg-author@example.com", name: "Author", roles: ["author"] },
  maintainer: { id: "70000000-0000-4000-8000-000000000002", email: "pg-maintainer@example.com", name: "Maintainer", roles: ["maintainer"] },
  member: { id: "70000000-0000-4000-8000-000000000003", email: "pg-member@example.com", name: "Member", roles: ["user"] },
  teamOwner: { id: "70000000-0000-4000-8000-000000000004", email: "pg-team-owner@example.com", name: "Team Owner", roles: ["user"] },
} satisfies Record<string, TestUser>;

const releaseMetadata = {
  releaseNotes: "Postgres improvement journey fixture.",
  changeKind: "feature",
  requiresUserAction: false,
  compatibility: { minimumMyskillsVersion: "0.1.0-beta.4", minimumAdapterContractVersion: 1, minimumSourceVersion: "0.0.1" },
};

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

const profileBody = {
  schemaVersion: 1,
  name: "Codex with GPT-5.5",
  target: {
    model: { provider: "openai", id: "gpt-5.5" },
    app: { id: "codex", version: "0.50.0" },
    environment: { os: ["macos"], requiredCapabilities: ["workspace.read"], network: "optional" },
  },
  settings: { reasoningEffort: "high" },
  objectives: ["task-success"],
  protectedRequirements: [],
};

const suiteBody = {
  schemaVersion: 1,
  name: "Incident summary suite",
  contentSha256: "c".repeat(64),
  rubricSha256: "d".repeat(64),
  caseCount: 10,
  protectedCaseCount: 2,
  holdoutCaseCount: 4,
  graders: ["deterministic"],
  repetitions: 2,
};

const runner = {
  adapter: "codex",
  adapterVersion: "0.50.0",
  coordinatorVersion: "0.1.0-beta.8",
  capabilities: { structuredOutput: true, workspaceIsolation: true, networkRestriction: true, tokenAccounting: false, cancellation: true, exactModelReadback: false },
};

test("postgres improvement journey persists declarations, policies, runs, evidence, and audits", { timeout: 120_000, skip: !databaseUrl }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  for (const user of Object.values(users)) {
    await pool.query(
      "INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())",
      [user.id, user.email, user.name],
    );
  }
  await pool.query("INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, 'Incident Guild', 'incident-guild', $2)", [teamId, users.teamOwner.id]);
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [teamId, users.teamOwner.id, users.member.id]);

  const db = createDb(pool);
  const authStore = new MemoryAuthStore("closed");
  const teamService = new TeamService(new PostgresTeamStore(db));
  const organizationService = new OrganizationService(new PostgresOrganizationStore(db), teamService);
  const improvementStore = new PostgresImprovementStore(db);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db, { publicationGuard: improvementStore }));
  const improvementService = new ImprovementService(improvementStore, { submissionService, teamService, organizationService });
  const app = buildApp({
    skillRepository: new PostgresSkillRepository(db),
    authService: new AuthService(authStore),
    submissionService,
    teamService,
    organizationService,
    improvementService,
  });
  t.after(() => app.close());
  for (const user of Object.values(users)) {
    authStore.addUser({ id: user.id, email: user.email, name: user.name, status: "active", emailVerifiedAt: new Date(), roles: user.roles, passwordHash: await hashPassword(PASSWORD) });
  }
  const journal = recorder("postgres-journey");
  const maintainer = await loginWithMfa(app, users.maintainer);
  const author = await loginWithMfa(app, users.author);
  const member = await loginWithMfa(app, users.member);
  const teamOwner = await loginWithMfa(app, users.teamOwner);

  const reviewArtifactSha = async (submissionId: string) => {
    const preview = await call(app, "GET", `/v1/review/submissions/${submissionId}/bundle?platform=codex`, maintainer);
    assert.equal(preview.statusCode, 200, preview.body);
    return sha256(preview.body);
  };
  const submit = async (name: string, version: string, visibility: string, readme: string) => {
    const pkg = packageFiles(name, version, visibility, readme);
    const response = await call(app, "POST", "/v1/submissions", author, { release: releaseMetadata, manifest: pkg.manifest, files: pkg.files });
    assert.equal(response.statusCode, 202, response.body);
    const submissionId = response.json().submission.id as string;
    return { submissionId, artifactSha256: await reviewArtifactSha(submissionId), files: pkg.files };
  };
  const approveBytes = async (submissionId: string) => {
    const artifactSha256 = await reviewArtifactSha(submissionId);
    assert.equal((await call(app, "POST", `/v1/review/submissions/${submissionId}/actions`, maintainer, { action: "approve", artifactSha256 })).statusCode, 200);
  };
  const publishAttempt = (submissionId: string) => call(app, "POST", `/v1/review/submissions/${submissionId}/actions`, maintainer, { action: "publish" });
  const approveAndPublish = async (submissionId: string) => {
    await approveBytes(submissionId);
    const published = await publishAttempt(submissionId);
    assert.equal(published.statusCode, 200, published.body);
  };

  const guidance = await submit("model-guidance-reviewer", "1.0.0", "public", "Review against model guidance.");
  await approveAndPublish(guidance.submissionId);
  const subject = await submit("incident-summary", "1.0.0", "team", "Summarize incidents.");
  await approveAndPublish(subject.submissionId);
  await pool.query("INSERT INTO skill_team_grants (skill_id, team_id) SELECT id, $2 FROM skills WHERE slug = $1", ["incident-summary", teamId]);
  const guidancePin = { slug: "model-guidance-reviewer", version: "1.0.0", artifactSha256: guidance.artifactSha256, roles: ["analyze", "propose"] };

  // G1: post-publication attestation on the reviewer release.
  const attest = journal.check("attestation append", await call(app, "POST", "/v1/improvements/releases/model-guidance-reviewer/1.0.0/declarations", author, {
    declaration, expectedRevisionNumber: 0,
  }), 201);
  assert.equal(body(attest).revision.kind, "attestation");
  journal.check("attestation approve", await call(app, "POST", `/v1/improvements/releases/model-guidance-reviewer/1.0.0/declarations/${body(attest).revision.id}/review`, maintainer, {
    decision: "approve", artifactSha256: guidance.artifactSha256, declarationSha256: body(attest).revision.declarationSha256,
  }), 200);
  const reviewerCompat = body(journal.check("reviewer compatibility", await call(app, "GET", "/v1/improvements/releases/model-guidance-reviewer/1.0.0/compatibility"), 200)).compatibility;
  assert.equal(reviewerCompat.attestation.status, "approved");
  assert.equal(reviewerCompat.declaration.status, "unspecified");
  const storedArtifact = await pool.query("SELECT a.sha256 FROM skill_artifacts a JOIN skill_versions v ON v.id = a.skill_version_id JOIN skills s ON s.id = v.skill_id WHERE s.slug = 'model-guidance-reviewer'");
  assert.equal(storedArtifact.rows[0].sha256, guidance.artifactSha256, "declarations must not rewrite artifact rows");

  // G2: concurrent policy writes.
  const policyUrl = `/v1/improvements/policies/team/${teamId}`;
  journal.check("team policy", await call(app, "PUT", policyUrl, teamOwner, {
    policy: { schemaVersion: 1, enabled: true, inference: { routes: ["on-device"], providers: null, models: null }, maxDisclosure: "summary" },
    expectedRevisionNumber: 0,
  }), 201);
  const racedPolicies = await Promise.all([
    call(app, "PUT", policyUrl, teamOwner, { policy: { schemaVersion: 1, enabled: true, inference: { routes: ["on-device"], providers: ["openai"], models: null }, maxDisclosure: "summary" }, expectedRevisionNumber: 1 }),
    call(app, "PUT", policyUrl, teamOwner, { policy: { schemaVersion: 1, enabled: true, inference: { routes: ["on-device"], providers: null, models: ["gpt-5.5"] }, maxDisclosure: "summary" }, expectedRevisionNumber: 1 }),
  ]);
  assert.deepEqual(racedPolicies.map((item) => item.statusCode).sort(), [201, 409]);
  journal.note("concurrent policy writes", racedPolicies.map((item) => item.statusCode).sort());
  const policyRows = await pool.query("SELECT revision_number FROM improvement_policy_revisions WHERE scope_type = 'team' AND scope_id = $1 ORDER BY revision_number", [teamId]);
  assert.deepEqual(policyRows.rows.map((row) => row.revision_number), [1, 2]);

  const profile = body(journal.check("profile", await call(app, "POST", "/v1/improvements/profiles", member, { owner: { type: "user", id: users.member.id }, profile: profileBody }), 201)).profile;
  const authorProfile = body(await call(app, "POST", "/v1/improvements/profiles", author, { owner: { type: "user", id: users.author.id }, profile: profileBody })).profile;
  const suite = body(journal.check("suite", await call(app, "POST", "/v1/improvements/suites", member, { owner: { type: "user", id: users.member.id }, suite: suiteBody }), 201)).suite;
  const candidatePackage = packageFiles("incident-summary", "1.1.0", "team", "Summarize incidents with a timeline.");
  const candidateTree = improvementTreeSha256(candidatePackage.files);
  const request = {
    schemaVersion: 1,
    context: { type: "user", id: users.member.id },
    source: { kind: "release", slug: "incident-summary", version: "1.0.0", artifactSha256: subject.artifactSha256 },
    reviewers: [guidancePin],
    profileRevisionId: profile.latest.id,
    suiteRevisionId: suite.latest.id,
    goals: { objectives: ["task-success"], protectedRequirements: [] },
    guidance: [{ publisher: "openai", url: GUIDANCE_URL, retrievedAt: "2026-09-26T00:00:00.000Z", sha256: "f".repeat(64) }],
    candidate: { maxCandidates: 1, identity: { slug: "incident-summary", version: "1.1.0", visibility: "team", derivativeOf: null } },
    budget: { maxModelCalls: 40, maxTokens: null, maxWallMinutes: 60 },
    dataRoute: { inference: "cloud", provider: "openai", model: "gpt-5.5", contextCategories: ["subject-package", "reviewer-packages", "profile", "suite"] },
    resultSharing: "summary",
    expiresInMinutes: 120,
  };

  // G3: team resource ceilings bind personal context for the member and the skill manager.
  const memberCloud = body(journal.check("member cloud preview", await call(app, "POST", "/v1/improvements/plans/preview", member, { request }), 200));
  assert.ok(memberCloud.effectivePolicy.blockers.some((item: { code: string; source: { id: string } }) => item.code === "INFERENCE_ROUTE_BLOCKED" && item.source.id === teamId));
  const managerCloud = body(await call(app, "POST", "/v1/improvements/plans/preview", author, {
    request: { ...request, context: { type: "user", id: users.author.id }, profileRevisionId: authorProfile.latest.id, suiteRevisionId: null },
  }));
  assert.ok(managerCloud.effectivePolicy.blockers.some((item: { code: string }) => item.code === "INFERENCE_ROUTE_BLOCKED"));
  const onDevice = { ...request, dataRoute: { ...request.dataRoute, inference: "on-device" } };
  const plan = body(journal.check("create plan", await call(app, "POST", "/v1/improvements/plans", member, { request: onDevice, idempotencyKey: "pg-plan-0001" }), 201)).plan;
  const planReplay = body(journal.check("replay plan", await call(app, "POST", "/v1/improvements/plans", member, { request: onDevice, idempotencyKey: "pg-plan-0001" }), 200)).plan;
  assert.equal(planReplay.id, plan.id);
  const run = body(journal.check("create run", await call(app, "POST", `/v1/improvements/plans/${plan.id}/runs`, member, { planSha256: plan.planSha256, idempotencyKey: "pg-run-0001", runner }), 201)).run;
  const send = (sequence: number, event: Record<string, unknown>) => call(app, "POST", `/v1/improvements/runs/${run.id}/events`, member, { planSha256: plan.planSha256, sequence, event });

  // G4: concurrent identical events collapse to one append and one replay.
  const raced = await Promise.all([send(1, { type: "stage.started", stage: "analyze" }), send(1, { type: "stage.started", stage: "analyze" })]);
  assert.deepEqual(raced.map((item) => item.statusCode).sort(), [200, 201]);
  journal.note("concurrent identical events", raced.map((item) => item.statusCode).sort());
  const eventRows = await pool.query("SELECT count(*)::int AS count FROM improvement_run_events WHERE run_id = $1", [run.id]);
  assert.equal(eventRows.rows[0].count, 1);

  const evaluation = {
    type: "evaluation.recorded",
    subject: "baseline",
    treeSha256: subject.artifactSha256,
    suiteSha256: suiteBody.contentSha256,
    observedModel: null,
    cases: { total: 10, passed: 6, failed: 4, errored: 0 },
    protectedCases: { total: 2, failed: 0 },
    holdoutCases: { total: 4, passed: 1 },
    repetitions: 2,
  };
  const steps: Array<[number, Record<string, unknown>]> = [
    [2, { type: "stage.completed", stage: "analyze", findingCount: 1 }],
    [3, { type: "stage.started", stage: "propose" }],
    [4, {
      type: "candidate.frozen", treeSha256: candidateTree, fileCount: candidatePackage.files.length,
      identity: { slug: "incident-summary", version: "1.1.0", visibility: "team", derivativeOf: null },
      validation: { packageValid: true, scanBlocking: false, protectedDiffClean: true },
    }],
    [5, { type: "stage.completed", stage: "propose", findingCount: 0 }],
    [6, { type: "stage.started", stage: "evaluate" }],
    [7, evaluation],
    [8, { ...evaluation, subject: "candidate", treeSha256: candidateTree, cases: { total: 10, passed: 9, failed: 1, errored: 0 }, holdoutCases: { total: 4, passed: 3 } }],
    [9, { type: "stage.completed", stage: "evaluate", findingCount: 0 }],
    [10, { type: "run.completed", report: {
      schemaVersion: 1,
      disposition: "candidate",
      findings: [{ id: "f1", reviewer: { slug: "model-guidance-reviewer", version: "1.0.0" }, severity: "medium", category: "instructions", summary: FINDING_TEXT, disposition: "addressed" }],
      configurationChanges: [],
      resources: { modelCalls: 12, tokens: null, wallMs: 120000, cost: "unknown" },
    } }],
  ];
  for (const [sequence, event] of steps) {
    journal.check(`event ${sequence} ${String(event.type)}`, await send(sequence, event), 201);
  }
  const completed = body(await call(app, "GET", `/v1/improvements/runs/${run.id}`, member));
  assert.equal(completed.run.state, "completed");
  assert.equal(completed.events.length, 10);

  // The author adopts the exact tree with a pre-publication declaration.
  const adopted = await submit("incident-summary", "1.1.0", "team", "Summarize incidents with a timeline.");
  assert.equal(adopted.artifactSha256, candidateTree);
  const declared = body(journal.check("declaration append", await call(app, "POST", "/v1/improvements/releases/incident-summary/1.1.0/declarations", author, {
    declaration, expectedRevisionNumber: 0,
  }), 201)).revision;
  assert.equal(declared.kind, "declaration");
  journal.check("declaration approve", await call(app, "POST", `/v1/improvements/releases/incident-summary/1.1.0/declarations/${declared.id}/review`, maintainer, {
    decision: "approve", artifactSha256: adopted.artifactSha256, declarationSha256: declared.declarationSha256,
  }), 200);
  await approveAndPublish(adopted.submissionId);

  const evidence = body(journal.check("share evidence", await call(app, "POST", `/v1/improvements/runs/${run.id}/evidence`, member, {
    reportSha256: completed.run.reportSha256,
    disclosure: "summary",
    proposals: [{ subject: "candidate", slug: "incident-summary", version: "1.1.0" }],
    idempotencyKey: "pg-evidence-0001",
  }), 201)).evidence;
  assert.equal(evidence.provenance, "local-report");
  journal.check("accept evidence", await call(app, "POST", `/v1/improvements/evidence/${evidence.id}/acceptances`, author, {
    subject: "candidate", slug: "incident-summary", version: "1.1.0", evidenceSha256: evidence.evidenceSha256, decision: "accept",
  }), 201);

  // G5/G6: team-visible projection and bounded claims.
  journal.check("anonymous team release hidden", await call(app, "GET", "/v1/improvements/releases/incident-summary/1.1.0/compatibility"), 404, "RELEASE_NOT_FOUND");
  const memberCompat = body(journal.check("member compatibility", await call(app, "GET", "/v1/improvements/releases/incident-summary/1.1.0/compatibility", member), 200)).compatibility;
  assert.equal(memberCompat.declaration.status, "approved");
  assert.deepEqual(memberCompat.declaration.targets.map((item: { status: string }) => item.status), ["tested"]);
  assert.equal(memberCompat.evidence.length, 1);
  assert.equal(memberCompat.evidence[0].claim, "locally-reported-improvement");
  assert.equal(memberCompat.evidence[0].provenance, "local-report");
  assert.ok(memberCompat.evidence[0].unmetConditions.includes("provenance-below-measured-floor"));
  journal.note("postgres claim", { claim: memberCompat.evidence[0].claim, unmet: [...memberCompat.evidence[0].unmetConditions].sort() });

  // G10: publication waits for an in-flight declaration write on the same release row, then refuses the pending revision.
  const gated = await submit("postmortem-writer", "1.0.0", "public", "Draft postmortems.");
  await approveBytes(gated.submissionId);
  const gatedUrl = "/v1/improvements/releases/postmortem-writer/1.0.0/declarations";
  const appender = await pool.connect();
  let appenderOpen = false;
  try {
    await appender.query("BEGIN");
    appenderOpen = true;
    // Mirrors the store: lock the release row, then insert the pending revision.
    await appender.query("SELECT id FROM skill_versions WHERE id = $1 FOR NO KEY UPDATE", [gated.submissionId]);
    await appender.query(`
      INSERT INTO improvement_declaration_revisions
        (id, release_id, skill_slug, version, revision_number, kind, declaration, declaration_sha256, created_by_user_id, created_at)
      VALUES ($1, $2, 'postmortem-writer', '1.0.0', 1, 'declaration', $3::jsonb, $4, $5, now())`,
    [randomUUID(), gated.submissionId, JSON.stringify(declaration), optimizationDeclarationDigest(declaration), users.author.id]);
    const publishing = Promise.resolve(publishAttempt(gated.submissionId));
    await waitForReleaseRowLock(pool);
    await appender.query("COMMIT");
    appenderOpen = false;
    const pendingPublish = journal.check("publish after concurrent declaration", await publishing, 409, "RELEASE_DECLARATION_NOT_APPROVED");
    assert.equal(body(pendingPublish).error.details.status, "pending");
  } finally {
    if (appenderOpen) await appender.query("ROLLBACK");
    appender.release();
  }

  // G9: a rejected latest revision still blocks; an approved unspecified revision withdraws the claim.
  const concurrentRevision = body(await call(app, "GET", "/v1/improvements/releases/postmortem-writer/1.0.0/compatibility", author)).compatibility.manage.pendingRevisions[0];
  journal.check("reject concurrent declaration", await call(app, "POST", `${gatedUrl}/${concurrentRevision.id}/review`, maintainer, {
    decision: "reject", artifactSha256: gated.artifactSha256, declarationSha256: concurrentRevision.declarationSha256,
  }), 200);
  const rejectedPublish = journal.check("publish with rejected declaration", await publishAttempt(gated.submissionId), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.equal(body(rejectedPublish).error.details.status, "rejected");
  const withdrawn = body(journal.check("append unspecified declaration", await call(app, "POST", gatedUrl, author, {
    declaration: { schemaVersion: 1, intent: "unspecified" }, expectedRevisionNumber: 1,
  }), 201)).revision;
  journal.check("approve unspecified declaration", await call(app, "POST", `${gatedUrl}/${withdrawn.id}/review`, maintainer, {
    decision: "approve", artifactSha256: gated.artifactSha256, declarationSha256: withdrawn.declarationSha256,
  }), 200);
  journal.check("publish with approved latest declaration", await publishAttempt(gated.submissionId), 200);
  const gatedRow = await pool.query("SELECT published_at FROM skill_versions WHERE id = $1", [gated.submissionId]);
  assert.notEqual(gatedRow.rows[0].published_at, null);
  const deniedPublishes = await pool.query(`
    SELECT count(*)::int AS count FROM audit_events
    WHERE action = 'release.publish' AND decision = 'deny' AND resource_id = $1 AND details->>'reason' = 'release_declaration_not_approved'`,
  [gated.submissionId]);
  assert.equal(deniedPublishes.rows[0].count, 2);

  // G11: a declaration write that read the release before a concurrent publication committed waits on the row and is refused.
  const racedRelease = await submit("postmortem-writer", "1.1.0", "public", "Draft postmortems with timelines.");
  await approveBytes(racedRelease.submissionId);
  const racedUrl = "/v1/improvements/releases/postmortem-writer/1.1.0/declarations";
  const publisher = await pool.connect();
  let publisherOpen = false;
  try {
    await publisher.query("BEGIN");
    publisherOpen = true;
    // Mirrors publication: lock the release row and set published_at inside one transaction.
    await publisher.query("SELECT id FROM skill_versions WHERE id = $1 FOR UPDATE", [racedRelease.submissionId]);
    await publisher.query("UPDATE skill_versions SET published_at = now(), lifecycle_status = 'approved' WHERE id = $1", [racedRelease.submissionId]);
    const appending = Promise.resolve(call(app, "POST", racedUrl, author, { declaration, expectedRevisionNumber: 0 }));
    await waitForReleaseRowLock(pool);
    await publisher.query("COMMIT");
    publisherOpen = false;
    journal.check("declaration after concurrent publication", await appending, 409, "IMPROVEMENT_RELEASE_STATE_CHANGED");
  } finally {
    if (publisherOpen) await publisher.query("ROLLBACK");
    publisher.release();
  }
  const retried = body(journal.check("retry as attestation", await call(app, "POST", racedUrl, author, { declaration, expectedRevisionNumber: 0 }), 201)).revision;
  assert.equal(retried.kind, "attestation");
  const racedKinds = await pool.query("SELECT kind FROM improvement_declaration_revisions WHERE release_id = $1", [racedRelease.submissionId]);
  assert.deepEqual(racedKinds.rows.map((row) => row.kind), ["attestation"]);

  // G12: an approval stored for other bytes never authorizes publication, through the API or directly in the database.
  const mismatched = await submit("postmortem-writer", "1.2.0", "public", "Draft postmortems with owners.");
  await approveBytes(mismatched.submissionId);
  const mismatchedRevisionId = randomUUID();
  await pool.query(`
    INSERT INTO improvement_declaration_revisions
      (id, release_id, skill_slug, version, revision_number, kind, declaration, declaration_sha256, created_by_user_id, created_at)
    VALUES ($1, $2, 'postmortem-writer', '1.2.0', 1, 'declaration', $3::jsonb, $4, $5, now())`,
  [mismatchedRevisionId, mismatched.submissionId, JSON.stringify(declaration), optimizationDeclarationDigest(declaration), users.author.id]);
  await pool.query(`
    INSERT INTO improvement_declaration_reviews (revision_id, decision, binding_sha256, artifact_sha256, reviewer_user_id, created_at)
    VALUES ($1, 'approve', $2, $2, $3, now())`,
  [mismatchedRevisionId, "e".repeat(64), users.maintainer.id]);
  const mismatchedPublish = journal.check("publish with approval for other bytes", await publishAttempt(mismatched.submissionId), 409, "RELEASE_DECLARATION_NOT_APPROVED");
  assert.equal(body(mismatchedPublish).error.details.status, "binding-mismatch");
  await assert.rejects(
    pool.query("UPDATE skill_versions SET published_at = now() WHERE id = $1", [mismatched.submissionId]),
    /release declaration is not approved/,
  );
  const mismatchedRow = await pool.query("SELECT published_at FROM skill_versions WHERE id = $1", [mismatched.submissionId]);
  assert.equal(mismatchedRow.rows[0].published_at, null);

  // G7: immutable rows.
  await assert.rejects(pool.query("UPDATE improvement_policy_revisions SET reason = 'changed' WHERE scope_id = $1", [teamId]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM improvement_run_events WHERE run_id = $1", [run.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE improvement_declaration_revisions SET reason = 'changed'"), /immutable/);
  await assert.rejects(pool.query("UPDATE improvement_evidence SET disclosure = 'selected-evidence' WHERE id = $1", [evidence.id]), /immutable/);

  // G8: sanitized audit rows.
  const audits = await pool.query("SELECT action, decision, details::text AS details FROM audit_events WHERE action LIKE 'improvement.%'");
  const actions = new Set(audits.rows.map((row) => row.action as string));
  for (const action of ["improvement.declaration.append", "improvement.declaration.review", "improvement.policy.append", "improvement.profile.create",
    "improvement.suite.create", "improvement.plan.create", "improvement.run.create", "improvement.run.event", "improvement.evidence.share", "improvement.evidence.accept"]) {
    assert.ok(actions.has(action), action);
  }
  const auditText = audits.rows.map((row) => row.details as string).join("\n");
  assert.equal(auditText.includes(FINDING_TEXT), false);
  assert.equal(auditText.includes(GUIDANCE_URL), false);

  journal.write("postgres");
});

/** Waits until another session blocks on a skill_versions row lock (the publication/declaration serialization point). */
async function waitForReleaseRowLock(pool: ReturnType<typeof createPgPool>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%skill_versions%'`);
    if ((result.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a request to block on the release row lock.");
}

function requiredTestDatabaseUrl(): string {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assert.match(new URL(databaseUrl).pathname.replace(/^\//, ""), /(test|ci)/i, "TEST_DATABASE_URL must name a disposable test or ci database.");
  return databaseUrl;
}

function packageFiles(name: string, version: string, visibility: string, readme: string) {
  const manifest = {
    name,
    title: name.split("-").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" "),
    summary: `${name} journey fixture skill.`,
    version,
    license: "Apache-2.0",
    visibility,
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["journey"],
  };
  return { manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "README.md", content: readme }] };
}

async function loginWithMfa(app: ReturnType<typeof buildApp>, user: TestUser): Promise<string> {
  const setup = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
  assert.equal(setup.statusCode, 200, setup.body);
  const setupToken = setup.json().token as string;
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${setupToken}` }, payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: user.email, password: PASSWORD } });
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: { challengeToken: login.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json().token as string;
}

function call(app: ReturnType<typeof buildApp>, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function body(response: ResponseLike): any {
  return response.json();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recorder(journey: string) {
  const steps: Array<Record<string, unknown>> = [];
  return {
    check<T extends ResponseLike>(step: string, response: T, status: number, code?: string): T {
      assert.equal(response.statusCode, status, `${journey}/${step}: ${response.body}`);
      if (code) assert.equal((response.json() as { error?: { code?: string } }).error?.code, code, `${journey}/${step}`);
      steps.push({ step, status, ...(code ? { code } : {}) });
      return response;
    },
    note(step: string, value: unknown) {
      steps.push({ step, value });
    },
    write(backend: "memory" | "postgres") {
      const directory = process.env.MYSKILLS_JOURNEY_EVIDENCE_DIR ?? join(tmpdir(), "myskills-journey-evidence");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `skill-improvement-${journey}.${backend}.json`), `${JSON.stringify({ schemaVersion: 1, journey, backend, steps }, null, 2)}\n`);
    },
  };
}
