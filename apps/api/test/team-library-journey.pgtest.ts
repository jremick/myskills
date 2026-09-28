/**
 * Team source ownership journey. Authored before the implementation, 2026-09-29.
 * Real HTTP authentication, submission/review services and Postgres; only public
 * GitHub transport is deterministic. Existing personal and target-binding
 * journeys remain the primary proof of their unchanged workflows.
 *
 * Independent failures this journey must detect:
 * T01 A team source is still personal-only, or a member/non-author/no-MFA actor
 *     can import. API token scope checks must apply before a provider request.
 * T02 Team imports accidentally belong to the initiating person, lack their team
 *     grant, allow private self-review, or become deliverable before instance review.
 * T03 Curator removal after HTTP preflight still commits a submission. Removal,
 *     demotion and organization-parent revocation must leave every related row unchanged.
 * T04 A second curator cannot complete a held preview or continue the same lineage
 *     after the initiating curator leaves; attribution must remain immutable.
 * T05 Tracking depends on the initiating curator, duplicates candidates/inbox events,
 *     notifies members about pending candidates, or silently changes the adopted pin.
 * T06 Sharing/member revocation leaves bundles, resolution or inbox items readable.
 * T07 A team without an active curator continues fetching; restoring a curator
 *     silently resumes tracking without their deliberate action.
 * T08 Team ownership captures a personal lineage, permits deletion of owned
 *     history, or a sibling Library cannot use the shared team lineage independently.
 * T13 A populated upgrade rewrites personal ownership, slugs or immutable history,
 *     frees an orphaned slug for takeover, or allows mixed team/user ownership.
 * T14 Ordinary registry management routes let a team curator with no MFA mutate
 *     sharing, metadata, lifecycle or draft state. A later import must not restore
 *     an explicitly removed owning-team grant or insert a version without it.
 *
 * Evidence is written to a unique owner-only directory. It contains IDs, status
 * codes and digests, never credentials or package contents.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { defaultOrganizationPolicyV1, organizationPolicyDigest } from "@myskills-app/core";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { BundleService } from "../src/bundles/service.js";
import { createDb, createPgPool, type Database, type DatabaseTransaction } from "../src/db/client.js";
import { FixtureGithubSource, LibraryService, LibrarySourceWorker, PostgresLibraryStore, PublicGithubSourceProvider } from "../src/libraries/index.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";

// HTTP JSON is deliberately asserted at the boundary rather than cast to server types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const password = "correct horse battery staple";
const repository = "everyinc/compound-engineering-plugin";
const ids = {
  alice: "a11ce000-0000-4000-8000-000000000001",
  bob: "b0b00000-0000-4000-8000-000000000002",
  member: "ca401000-0000-4000-8000-000000000003",
  reviewer: "da4a0000-0000-4000-8000-000000000004",
  noAuthor: "e4140000-0000-4000-8000-000000000005",
  noMfa: "f4140000-0000-4000-8000-000000000006",
  team: "7ea30000-0000-4000-8000-000000000007",
};

test("team Library: owned imports, curator continuity, tracking and revocation", { timeout: 180_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "Only a disposable test database may be reset.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  for (const migration of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(migrationsDir, migration), "utf8"));
  }
  const db = createDb(pool);
  let nowMs = Date.now();
  const github = new FixtureGithubSource();
  github.createRepository({
    id: 424242,
    owner: "everyinc",
    name: "compound-engineering-plugin",
    defaultBranch: "main",
    license: "MIT",
    files: {
      LICENSE: "MIT License\nCopyright (c) 2026 Test Fixture\nPermission is granted to use, copy and modify this software.\n",
      "README.md": "# Deterministic engineering source fixture\n",
      "skills/ce-plan/SKILL.md": skillMd("ce-plan", "Plan engineering changes.", "Read references/guide.md before planning."),
      "skills/ce-plan/references/guide.md": "# Guide\nRecord acceptance criteria.\n",
      "skills/ce-code-review/SKILL.md": skillMd("ce-code-review", "Review engineering changes.", "Check the acceptance criteria and permission boundaries."),
    },
  });
  const submissionStore = new PostgresSubmissionStore(db);
  const submissionService = new SubmissionService(submissionStore);
  const skillRepository = new PostgresSkillRepository(db);
  const libraryStore = new PostgresLibraryStore(db);
  const bundleService = new BundleService(db);
  const service = new LibraryService({
    store: libraryStore,
    submissions: submissionService,
    skillRepository,
    bundles: bundleService,
    sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
    now: () => new Date(nowMs),
    slugSuffix: (seed) => sha256(seed).slice(0, 10),
  });
  const app = buildApp({
    authService: new AuthService(new PostgresAuthStore(db), {}),
    skillRepository,
    submissionService,
    libraryService: service,
    bundleService,
    librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1_000, windowMs: 3_600_000 }),
  });
  t.after(() => app.close());
  const workerA = new LibrarySourceWorker(service);
  const workerB = new LibrarySourceWorker(service);
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token: string, payload?: Json) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: (response.body ? response.json() : {}) as Json, headers: response.headers, bytes: response.rawPayload };
  };
  const evidence: { id: string; observed: Json }[] = [];
  const record = (id: string, observed: Json) => evidence.push({ id, observed });

  for (const [name, roles] of Object.entries({ alice: ["author"], bob: ["author"], member: ["author"], reviewer: ["maintainer"], noAuthor: ["user"], noMfa: ["author"] })) {
    const id = ids[name as keyof typeof ids];
    const email = `${name.toLowerCase()}@example.com`;
    await pool.query("INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())", [id, email, name]);
    await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [id, await hashPassword(password)]);
    for (const role of roles) await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, $2)", [id, role]);
  }
  const alice = await login(app, "alice", true);
  const bob = await login(app, "bob", true);
  const member = await login(app, "member", true);
  const reviewer = await login(app, "reviewer", true);
  const noAuthor = await login(app, "noauthor", true);
  const noMfa = await login(app, "nomfa", false);
  await pool.query("INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, 'Engineering', 'engineering', $2)", [ids.team, ids.alice]);
  for (const name of ["alice", "bob", "noAuthor", "noMfa", "member"] as const) {
    await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)", [ids.team, ids[name], name === "member" ? "member" : "owner"]);
  }
  const library = ok(await call("POST", "/v1/libraries", alice, { name: "Engineering", owner: { type: "team", id: ids.team } }), 201).library;
  const source = ok(await call("POST", `/v1/libraries/${library.id}/entries`, alice, { kind: "source", url: `https://github.com/${repository}` }), 201).entry;
  const discover = ok(await call("POST", `/v1/library-entries/${source.id}/discoveries`, alice)).discovery;
  assert.deepEqual(discover.skills.map((root: Json) => root.path).sort(), ["skills/ce-code-review", "skills/ce-plan"]);
  const preview = ok(await call("POST", `/v1/library-entries/${source.id}/previews`, alice, { snapshotId: discover.snapshot.id, paths: ["skills/ce-plan", "skills/ce-code-review"] })).preview;
  const plan = preview.candidates.find((candidate: Json) => candidate.sourcePath === "skills/ce-plan");
  const review = preview.candidates.find((candidate: Json) => candidate.sourcePath === "skills/ce-code-review");
  assert.equal(plan.state, "ready-for-review");
  assert.equal(review.state, "ready-for-review");
  assert.equal(library.access.canImport, true);
  assert.equal(ok(await call("GET", `/v1/libraries/${library.id}`, noAuthor)).library.access.canImport, false);
  const importBody = (candidate: Json) => ({ expectedPackageDigest: candidate.packageDigest, release: { classification: "unclassified" } });
  error(await call("POST", `/v1/library-candidates/${plan.id}/import`, member, importBody(plan)), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  error(await call("GET", `/v1/library-candidates/${plan.id}?includeContent=true`, member), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  error(await call("POST", `/v1/library-candidates/${plan.id}/import`, noAuthor, importBody(plan)), 403, "SUBMISSION_ROLE_REQUIRED");
  error(await call("POST", `/v1/library-candidates/${plan.id}/import`, noMfa, importBody(plan)), 403, "MFA_VERIFICATION_REQUIRED");
  error(await call("POST", `/v1/library-entries/${source.id}/previews`, noMfa, { snapshotId: discover.snapshot.id, paths: ["skills/ce-plan"] }), 403, "MFA_VERIFICATION_REQUIRED");
  const limitedToken = ok(await call("POST", "/v1/auth/api-tokens", alice, { name: "source curator without submit scope", scopes: ["libraries:read", "libraries:write"] }), 201).token.token;
  const requestsBeforeScopeDenial = github.requests.length;
  error(await call("POST", `/v1/library-candidates/${plan.id}/import`, limitedToken, importBody(plan)), 403, "API_TOKEN_SCOPE_REQUIRED");
  assert.equal(github.requests.length, requestsBeforeScopeDenial);
  const manifest = { name: "attempted-owner-injection", title: "Owner injection fixture", summary: "An ordinary submission cannot choose a team owner.", version: "1.0.0", license: "MIT", visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: [] };
  for (const ownership of [{ owner: { type: "team", id: ids.team } }, { ownerTeamId: ids.team }]) {
    error(await call("POST", "/v1/submissions", alice, {
      manifest,
      files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: skillMd(manifest.name, manifest.summary, "Check the submission boundary.") }],
      release: { releaseNotes: "Initial submission.", changeKind: "feature", requiresUserAction: false },
      ...ownership,
    }), 400, "UNSUPPORTED_SUBMISSION_FIELD");
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skills WHERE slug = $1", [manifest.name])).rows[0].count, 0);
  record("T01", { selectedRoots: 2, memberDenied: 404, noAuthorDenied: 403, noMfaDenied: 403, scopeDenied: 403 });

  // Import race: service preflight and scan have succeeded when the real store
  // method runs. Interpose that existing boundary, then execute its real transaction.
  for (const revocation of ["removed", "demoted", "organization-removed"] as const) {
    let organizationId: string | null = null;
    if (revocation === "organization-removed") {
      organizationId = (await pool.query("INSERT INTO organizations (name, slug, created_by_user_id) VALUES ('Engineering org', 'engineering-org', $1) RETURNING id", [ids.alice])).rows[0].id;
      const policy = JSON.stringify(defaultOrganizationPolicyV1);
      const revision = (await pool.query("INSERT INTO organization_policy_revisions (organization_id, revision_number, policy, policy_sha256, created_by_user_id) VALUES ($1, 1, $2, $3, $4) RETURNING id", [organizationId, policy, sha256(policy), ids.alice])).rows[0].id;
      await pool.query("UPDATE organizations SET status = 'active', current_policy_revision_id = $2 WHERE id = $1", [organizationId, revision]);
      await pool.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'owner')", [organizationId, ids.alice, ids.bob]);
      await pool.query("UPDATE teams SET organization_id = $2 WHERE id = $1", [ids.team, organizationId]);
    }
    const original = submissionStore.createSubmission.bind(submissionStore);
    let preflightPassed = false;
    submissionStore.createSubmission = async (input) => {
      preflightPassed = true;
      if (revocation === "removed") await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.alice]);
      if (revocation === "demoted") await pool.query("UPDATE team_memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2", [ids.team, ids.alice]);
      if (revocation === "organization-removed") await pool.query("UPDATE organization_memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2", [organizationId, ids.alice]);
      return original(input);
    };
    try {
      error(await call("POST", `/v1/library-candidates/${plan.id}/import`, alice, importBody(plan)), 403, "LIBRARY_WRITE_FORBIDDEN");
      assert.equal(preflightPassed, true, "denial must occur after the complete HTTP/service preflight");
      const state = (await pool.query(`SELECT c.state, c.submission_id, c.decided_by_user_id, l.revision_counter,
        (SELECT count(*)::int FROM skills WHERE slug = l.slug) AS skills,
        (SELECT count(*)::int FROM skill_release_provenance WHERE candidate_id = c.id) AS provenance,
        (SELECT count(*)::int FROM library_entries WHERE lineage_id = l.id) AS entries
        FROM library_import_candidates c JOIN library_import_lineages l ON l.id = c.lineage_id WHERE c.id = $1`, [plan.id])).rows[0];
      assert.deepEqual(state, { state: "ready-for-review", submission_id: null, decided_by_user_id: null, revision_counter: 0, skills: 0, provenance: 0, entries: 0 });
      record(`T03-${revocation}`, { preflightPassed, ...state });
    } finally {
      submissionStore.createSubmission = original;
      await pool.query("UPDATE teams SET organization_id = NULL WHERE id = $1", [ids.team]);
      await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner'", [ids.team, ids.alice]);
    }
  }

  // The auto-created imported entry must obey the same saved-entry limit.
  const quotaEntries = (await pool.query("INSERT INTO library_entries (library_id, kind, title, skill_slug, created_by_user_id) SELECT $1, 'skill', 'Capacity fixture', 'quota-fixture-' || n, $2 FROM generate_series(1,499) n RETURNING id", [library.id, ids.alice])).rows.map((row) => row.id as string);
  try {
    error(await call("POST", `/v1/library-candidates/${plan.id}/import`, alice, importBody(plan)), 422, "LIBRARY_LIMIT_EXCEEDED");
    const quotaState = (await pool.query("SELECT c.state, c.submission_id, l.revision_counter, (SELECT count(*)::int FROM skills WHERE slug = l.slug) AS skills, (SELECT count(*)::int FROM skill_release_provenance WHERE candidate_id = c.id) AS provenance FROM library_import_candidates c JOIN library_import_lineages l ON l.id = c.lineage_id WHERE c.id = $1", [plan.id])).rows[0];
    assert.deepEqual(quotaState, { state: "ready-for-review", submission_id: null, revision_counter: 0, skills: 0, provenance: 0 });
    record("T14-quota", { deniedStatus: 422, activeEntries: 500, ...quotaState });
  } finally {
    await pool.query("DELETE FROM library_entries WHERE id = ANY($1::uuid[])", [quotaEntries]);
  }
  const imported = ok(await call("POST", `/v1/library-candidates/${plan.id}/import`, alice, importBody(plan)), 202);
  const slug = imported.submission.slug;
  const entryId = imported.entry.id;
  const ownerRows = (await pool.query(`SELECT s.owner_user_id, s.owner_team_id, s.visibility,
    l.owner_team_id AS lineage_team, c.owner_team_id AS candidate_team,
    p.owner_team_id AS provenance_team, p.imported_by_user_id, c.decided_by_user_id,
    (SELECT count(*)::int FROM skill_team_grants g WHERE g.skill_id = s.id AND g.team_id = $2) AS team_grants
    FROM skills s JOIN library_import_lineages l ON l.slug = s.slug
    JOIN library_import_candidates c ON c.lineage_id = l.id
    JOIN skill_release_provenance p ON p.candidate_id = c.id WHERE c.id = $1`, [plan.id, ids.team])).rows;
  assert.deepEqual(ownerRows, [{ owner_user_id: null, owner_team_id: ids.team, visibility: "team", lineage_team: ids.team, candidate_team: ids.team, provenance_team: ids.team, imported_by_user_id: ids.alice, decided_by_user_id: ids.alice, team_grants: 1 }]);
  // These routes predate team imports. A globally ordinary author can now have
  // team authority, so the existing privileged-role MFA check alone is insufficient.
  const managementState = async () => (await pool.query("SELECT s.title, s.summary, s.visibility, s.lifecycle_status AS skill_lifecycle, v.lifecycle_status AS version_lifecycle FROM skills s JOIN skill_versions v ON v.skill_id = s.id WHERE v.id = $1", [imported.submission.id])).rows[0];
  const draftBeforeDeniedWrites = await managementState();
  for (const [method, path, payload] of [
    ["PUT", `/v1/skills/${slug}/sharing`, { visibility: "public" }],
    ["PUT", `/v1/skills/${slug}/sharing`, { visibility: "private" }],
    ["PUT", `/v1/skills/${slug}`, { title: "Unauthorized team title", summary: "A no-MFA curator must not write." }],
    ["POST", `/v1/skills/${slug}/actions`, { action: "archive" }],
    ["POST", `/v1/submissions/${imported.submission.id}/actions`, { action: "withdraw" }],
  ] as const) {
    error(await call(method, path, noMfa, payload), 403, "MFA_VERIFICATION_REQUIRED");
  }
  assert.deepEqual(await managementState(), draftBeforeDeniedWrites);
  error(await call("GET", `/v1/skills/${slug}/releases/0.0.1/bundle`, member), 404, "RELEASE_NOT_FOUND");
  error(await call("POST", `/v1/review/submissions/${imported.submission.id}/actions`, alice, { action: "approve", artifactSha256: plan.packageDigest }), 403, "REVIEW_ROLE_REQUIRED");
  await pool.query("UPDATE instance_settings SET value = '{\"privateSelfReviewEnabled\":true}'::jsonb WHERE key = 'library'");
  const selfReview = await call("POST", `/v1/library-candidates/${plan.id}/self-review`, alice, { artifactSha256: plan.packageDigest });
  error(selfReview, 409, "LIBRARY_SELF_REVIEW_UNSUPPORTED");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_version_review_attestations WHERE skill_version_id = $1", [imported.submission.id])).rows[0].count, 0);
  await publish(imported.submission.id);
  const publishedBeforeDeniedWrite = await managementState();
  error(await call("POST", `/v1/skills/${slug}/releases/0.0.1/actions`, noMfa, { action: "deprecate", reason: "No-MFA write must be refused." }), 403, "MFA_VERIFICATION_REQUIRED");
  assert.deepEqual(await managementState(), publishedBeforeDeniedWrite);
  const personalManifest = { ...manifest, name: "ordinary-personal-author", title: "Ordinary personal author" };
  const personalDraft = ok(await call("POST", "/v1/submissions", noMfa, { manifest: personalManifest, files: [{ path: "skill.json", content: JSON.stringify(personalManifest) }, { path: "SKILL.md", content: skillMd(personalManifest.name, personalManifest.summary, "Keep personal author behavior unchanged.") }], release: { releaseNotes: "Personal fixture.", changeKind: "feature", requiresUserAction: false } }), 202);
  ok(await call("PUT", `/v1/skills/${personalManifest.name}`, noMfa, { summary: "Personal authors can still edit their own drafts." }));
  ok(await call("POST", `/v1/submissions/${personalDraft.submission.id}/actions`, noMfa, { action: "withdraw" }));
  record("T14-mfa", { teamWritesDenied: 6, status: 403, personalDraftEditAndWithdrawAllowed: true });
  const adoption = ok(await call("POST", `/v1/library-entries/${entryId}/adoptions`, bob, { version: "0.0.1", artifactSha256: plan.packageDigest, expectedCurrentAdoptionId: null, reason: "Engineering baseline reviewed." }), 201).adoption;
  assert.equal(adoption.attestation, "instance-reviewed");
  assert.equal(adoption.adoptedBy.id, ids.bob);
  const bundle = await call("GET", `/v1/skills/${slug}/releases/0.0.1/bundle`, member);
  ok(bundle);
  assert.equal(sha256(bundle.bytes), plan.packageDigest);
  record("T02", { ...ownerRows[0], slug, packageDigest: plan.packageDigest, adoptionId: adoption.id });

  // Personal and team imports of identical bytes must be separate durable owners.
  const personal = ok(await call("POST", "/v1/libraries", alice, { name: "Alice personal", owner: { type: "user" } }), 201).library;
  const personalSource = ok(await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url: `https://github.com/${repository}` }), 201).entry;
  const personalDiscovery = ok(await call("POST", `/v1/library-entries/${personalSource.id}/discoveries`, alice)).discovery;
  const personalCandidate = ok(await call("POST", `/v1/library-entries/${personalSource.id}/previews`, alice, { snapshotId: personalDiscovery.snapshot.id, paths: ["skills/ce-plan"] })).preview.candidates[0];
  const personalImport = ok(await call("POST", `/v1/library-candidates/${personalCandidate.id}/import`, alice, importBody(personalCandidate)), 202);
  assert.notEqual(personalImport.submission.slug, slug);
  const personalOwner = (await pool.query("SELECT owner_user_id, owner_team_id, visibility FROM skills WHERE slug = $1", [personalImport.submission.slug])).rows[0];
  assert.deepEqual(personalOwner, { owner_user_id: ids.alice, owner_team_id: null, visibility: "private" });
  error(await call("GET", `/v1/library-candidates/${personalCandidate.id}`, bob), 404, "LIBRARY_CANDIDATE_NOT_FOUND");

  // Alice leaves with a held second-skill preview. Bob can accept it and can
  // replay Alice's earlier import without stealing or rewriting its attribution.
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.alice]);
  error(await call("GET", `/v1/library-candidates/${review.id}`, alice), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  const continued = ok(await call("POST", `/v1/library-candidates/${review.id}/import`, bob, importBody(review)), 202);
  const replay = ok(await call("POST", `/v1/library-candidates/${plan.id}/import`, bob, importBody(plan)));
  assert.equal(replay.submission.id, imported.submission.id);
  assert.equal(replay.replayed, true);
  assert.equal(ok(await call("GET", `/v1/submissions/${imported.submission.id}`, bob)).submission.id, imported.submission.id);
  error(await call("GET", `/v1/submissions/${imported.submission.id}`, alice), 404, "SUBMISSION_NOT_FOUND");
  const attribution = (await pool.query("SELECT imported_by_user_id FROM skill_release_provenance WHERE skill_version_id = $1", [imported.submission.id])).rows[0];
  assert.equal(attribution.imported_by_user_id, ids.alice);
  const successorAttribution = (await pool.query("SELECT p.imported_by_user_id, p.owner_team_id, c.decided_by_user_id FROM skill_release_provenance p JOIN library_import_candidates c ON c.id = p.candidate_id WHERE p.skill_version_id = $1", [continued.submission.id])).rows[0];
  assert.deepEqual(successorAttribution, { imported_by_user_id: ids.bob, owner_team_id: ids.team, decided_by_user_id: ids.bob });
  record("T04", { originalSubmission: imported.submission.id, originalImporter: ids.alice, successorSubmission: continued.submission.id, successorImporter: ids.bob, replayed: true });

  // Sibling Libraries share the team's lineage, but keep independent adoption pins.
  const sibling = ok(await call("POST", "/v1/libraries", bob, { name: "Engineering experiments", owner: { type: "team", id: ids.team } }), 201).library;
  const siblingSource = ok(await call("POST", `/v1/libraries/${sibling.id}/entries`, bob, { kind: "source", url: `https://github.com/${repository}` }), 201).entry;
  const siblingDiscovery = ok(await call("POST", `/v1/library-entries/${siblingSource.id}/discoveries`, bob)).discovery;
  assert.equal(siblingDiscovery.skills.find((root: Json) => root.path === "skills/ce-plan").lineage.slug, slug);
  const siblingEntry = ok(await call("POST", `/v1/libraries/${sibling.id}/entries`, bob, { kind: "skill", slug }), 201).entry;
  assert.equal(siblingEntry.skill.lineageId, plan.lineage.id);
  assert.equal(siblingEntry.skill.sourceEntryId, siblingSource.id);
  const siblingAdoption = ok(await call("POST", `/v1/library-entries/${siblingEntry.id}/adoptions`, bob, { version: "0.0.1", artifactSha256: plan.packageDigest, expectedCurrentAdoptionId: null, reason: "Separate Engineering experiment baseline." }), 201).adoption;
  await assert.rejects(pool.query("DELETE FROM teams WHERE id = $1", [ids.team]), { code: "23503" });
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_release_provenance WHERE skill_version_id = $1", [imported.submission.id])).rows[0].count, 1);
  record("T08", { personalOwner, personalSlug: personalImport.submission.slug, teamSlug: slug, siblingLineage: slug, teamDeletionDenied: true });

  for (const token of [bob, member]) ok(await call("PUT", `/v1/libraries/${library.id}/subscription`, token, {}));
  for (const token of [bob, member]) ok(await call("PUT", `/v1/libraries/${sibling.id}/subscription`, token, {}));
  const currentSource = ok(await call("GET", `/v1/library-entries/${source.id}`, bob)).entry;
  ok(await call("PATCH", `/v1/library-entries/${source.id}/tracking`, bob, { expectedRevision: currentSource.revision, mode: "daily" }));
  const currentSiblingSource = ok(await call("GET", `/v1/library-entries/${siblingSource.id}`, bob)).entry;
  ok(await call("PATCH", `/v1/library-entries/${siblingSource.id}/tracking`, bob, { expectedRevision: currentSiblingSource.revision, mode: "daily" }));
  const commit = github.commit(repository, { files: { "skills/ce-plan/references/guide.md": "# Guide\nRecord acceptance criteria and revocation failures.\n" } });
  nowMs += 25 * 3_600_000;
  await Promise.all([workerA.runOnce(), workerB.runOnce()]);
  const candidates = ok(await call("GET", `/v1/library-entries/${source.id}/candidates?state=ready-for-review`, bob)).candidates;
  assert.equal(candidates.length, 1);
  const update = candidates[0];
  assert.equal(update.lineage.id, plan.lineage.id);
  assert.equal(update.lineage.slug, slug);
  assert.equal(update.snapshot.commit, commit);
  assert.equal(update.expectedVersion, "0.0.2");
  assert.deepEqual(update.changes.changed, ["references/guide.md"]);
  const siblingCandidates = ok(await call("GET", `/v1/library-entries/${siblingSource.id}/candidates?state=ready-for-review`, bob)).candidates;
  assert.equal(siblingCandidates.length, 1);
  assert.equal(siblingCandidates[0].lineage.id, plan.lineage.id);
  assert.equal(siblingCandidates[0].lineage.slug, slug);
  const sourceEvents = (await pool.query("SELECT library_id, count(*)::int AS count FROM library_events WHERE kind = 'candidate-ready' GROUP BY library_id ORDER BY library_id")).rows;
  assert.deepEqual(sourceEvents, [{ library_id: library.id, count: 1 }, { library_id: sibling.id, count: 1 }].sort((a, b) => a.library_id.localeCompare(b.library_id)));
  assert.equal(ok(await call("GET", `/v1/library-entries/${entryId}/resolution`, member)).resolution.version, "0.0.1");
  const candidateEvents = () => pool.query("SELECT count(*)::int AS count FROM library_events WHERE candidate_id = $1 AND kind = 'candidate-ready'", [update.id]);
  assert.equal((await candidateEvents()).rows[0].count, 1);
  assert.equal(ok(await call("GET", "/v1/library-inbox", bob)).items.filter((item: Json) => item.candidateId === update.id).length, 1);
  assert.equal(ok(await call("GET", "/v1/library-inbox", bob)).items.filter((item: Json) => item.libraryId === sibling.id && item.kind === "candidate-ready").length, 1);
  assert.equal(ok(await call("GET", "/v1/library-inbox", member)).items.some((item: Json) => item.kind === "candidate-ready"), false);
  github.commit(repository, { files: { "README.md": "# Unrelated upstream edit\n" } });
  nowMs += 25 * 3_600_000;
  await workerA.runOnce();
  assert.equal((await candidateEvents()).rows[0].count, 1);
  assert.equal(ok(await call("GET", `/v1/library-entries/${source.id}/candidates?state=ready-for-review`, bob)).candidates.length, 1);
  await pool.query("DELETE FROM skill_team_grants WHERE team_id = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)", [ids.team, slug]);
  const beforeMissingGrant = (await pool.query("SELECT c.state, c.submission_id, l.revision_counter, (SELECT count(*)::int FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.slug = l.slug) AS versions FROM library_import_candidates c JOIN library_import_lineages l ON l.id = c.lineage_id WHERE c.id = $1", [update.id])).rows[0];
  error(await call("POST", `/v1/library-candidates/${update.id}/import`, bob, importBody(update)), 403, "TEAM_GRANT_REQUIRED");
  const afterMissingGrant = (await pool.query("SELECT c.state, c.submission_id, l.revision_counter, (SELECT count(*)::int FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE s.slug = l.slug) AS versions FROM library_import_candidates c JOIN library_import_lineages l ON l.id = c.lineage_id WHERE c.id = $1", [update.id])).rows[0];
  assert.deepEqual(afterMissingGrant, beforeMissingGrant);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_team_grants WHERE team_id = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)", [ids.team, slug])).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_release_provenance WHERE candidate_id = $1", [update.id])).rows[0].count, 0);
  await pool.query("INSERT INTO skill_team_grants (skill_id, team_id) SELECT id, $1 FROM skills WHERE slug = $2", [ids.team, slug]);
  record("T14-grant", { deniedStatus: 403, before: beforeMissingGrant, after: afterMissingGrant, grantRecreated: false });
  // Bundle.save locks the Library before team authority; import takes authority
  // before the Library. Pause the real save between those locks and prove import
  // is waiting on that transaction before continuing. Shared authority locks
  // must avoid a cycle while still fencing actual membership revocation.
  const bundleForRace = ok(await call("POST", "/v1/bundles", bob, { kind: "curated", name: "Engineering references", purpose: "Exercise concurrent source and reference writes.", owner: { type: "team", id: ids.team }, visibility: "team", memberSlugs: [slug] }), 201).bundle;
  const bundleHooks = bundleService as unknown as { lockTeamOwner(tx: DatabaseTransaction, teamId: string, actorId: string): Promise<void> };
  const originalTeamLock = bundleHooks.lockTeamOwner.bind(bundleService);
  const enteredSave = deferred();
  const releaseSave = deferred();
  let savePid = 0;
  bundleHooks.lockTeamOwner = async (tx, teamId, actorId) => {
    savePid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    enteredSave.resolve();
    await releaseSave.promise;
    return originalTeamLock(tx, teamId, actorId);
  };
  const originalCreate = submissionStore.createSubmission.bind(submissionStore);
  let membershipRevokeBlocked = false;
  submissionStore.createSubmission = async (input) => {
    const binding = input.importBinding;
    assert.ok(binding);
    return originalCreate({ ...input, importBinding: {
      ...binding,
      beforeVersionInsert: async (tx, context) => {
        await binding.beforeVersionInsert(tx, context);
        const revoker = await pool.connect();
        try {
          await revoker.query("BEGIN");
          await revoker.query("SET LOCAL lock_timeout = '100ms'");
          await assert.rejects(revoker.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.bob]), { code: "55P03" });
          membershipRevokeBlocked = true;
        } finally {
          await revoker.query("ROLLBACK");
          revoker.release();
        }
      },
    } });
  };
  const saving = call("POST", `/v1/bundles/${bundleForRace.id}/library-references`, bob, { libraryId: library.id, expectedRevision: bundleForRace.revision });
  let importing: ReturnType<typeof call> | null = null;
  let v2: Json;
  try {
    await bounded(enteredSave.promise);
    importing = call("POST", `/v1/library-candidates/${update.id}/import`, bob, importBody(update));
    let importWaitsForSave = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blocked = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [savePid]);
      if (blocked.rows[0].blocked) { importWaitsForSave = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(importWaitsForSave, true, "the real import must reach a lock held by the paused Bundle save");
    releaseSave.resolve();
    const [saved, importedVersion] = await bounded(Promise.all([saving, importing]));
    ok(saved, 201);
    v2 = ok(importedVersion, 202);
    assert.equal(membershipRevokeBlocked, true, "compatible authority reads must still fence membership deletion until commit");
    record("T14-locks", { importWaitedForSave: true, saveStatus: saved.status, importStatus: importedVersion.status, membershipRevokeBlocked: true });
  } finally {
    releaseSave.resolve();
    bundleHooks.lockTeamOwner = originalTeamLock;
    submissionStore.createSubmission = originalCreate;
    await Promise.allSettled([saving, ...(importing ? [importing] : [])]);
  }
  assert.equal(v2.submission.slug, slug);
  assert.equal(v2.submission.version, "0.0.2");
  await publish(v2.submission.id);
  assert.equal(ok(await call("GET", `/v1/library-entries/${entryId}/resolution`, member)).resolution.version, "0.0.1");
  const adoption2 = ok(await call("POST", `/v1/library-entries/${entryId}/adoptions`, bob, { version: "0.0.2", artifactSha256: update.packageDigest, expectedCurrentAdoptionId: adoption.id, reason: "Reviewed supporting-file change." }), 201).adoption;
  assert.equal(ok(await call("GET", `/v1/library-entries/${entryId}/resolution`, member)).resolution.version, "0.0.2");
  assert.equal(ok(await call("GET", `/v1/library-entries/${siblingEntry.id}/resolution`, bob)).resolution.version, "0.0.1");
  assert.equal(ok(await call("GET", "/v1/library-inbox", member)).items.filter((item: Json) => item.entryId === entryId && item.kind === "adoption-changed").length, 1);
  record("T05", { candidateId: update.id, commit, candidateEventsPerLibrary: sourceEvents, beforeAdoption: "0.0.1", afterAdoption: "0.0.2", siblingAdoption: "0.0.1", adoptionId: adoption2.id });

  // Sharing to a sibling team must acquire all required team rows before their
  // parent organization. A real sibling-team role mutation holds T2 first; once
  // sharing waits for T2, let the mutation reach its ordinary parent lock.
  const sharingOrg = (await pool.query("INSERT INTO organizations (name, slug, created_by_user_id) VALUES ('Sharing race organization', 'sharing-race-organization', $1) RETURNING id", [ids.bob])).rows[0].id as string;
  const sharingPolicy = (await pool.query("INSERT INTO organization_policy_revisions (organization_id, revision_number, policy, policy_sha256, created_by_user_id) VALUES ($1, 1, $2, $3, $4) RETURNING id", [sharingOrg, JSON.stringify(defaultOrganizationPolicyV1), organizationPolicyDigest(defaultOrganizationPolicyV1), ids.bob])).rows[0].id;
  await pool.query("UPDATE organizations SET status = 'active', current_policy_revision_id = $2 WHERE id = $1", [sharingOrg, sharingPolicy]);
  for (const actorId of [ids.bob, ids.member, ids.noAuthor, ids.noMfa]) {
    await pool.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)", [sharingOrg, actorId, actorId === ids.bob ? "owner" : "member"]);
  }
  await pool.query("UPDATE teams SET organization_id = $2 WHERE id = $1", [ids.team, sharingOrg]);
  const siblingTeam = (await pool.query("INSERT INTO teams (name, slug, organization_id, created_by_user_id) VALUES ('Sibling sharing team', 'sibling-sharing-team', $1, $2) RETURNING id", [sharingOrg, ids.bob])).rows[0].id as string;
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [siblingTeam, ids.bob, ids.member]);
  const enteredRoleChange = deferred();
  const releaseRoleChange = deferred();
  let rolePid = 0;
  const roleChange = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM teams WHERE id = ${siblingTeam}::uuid FOR UPDATE`);
    rolePid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    enteredRoleChange.resolve();
    await releaseRoleChange.promise;
    // Nested transaction uses the same connection, so this executes the real
    // team mutation authority checks with the team lock already held.
    return new PostgresTeamStore(tx as unknown as Database).updateMemberRole({ teamId: siblingTeam, userId: ids.member, role: "owner", actorUserId: ids.bob });
  });
  let sharing: ReturnType<typeof call> | null = null;
  try {
    await bounded(enteredRoleChange.promise);
    sharing = call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "team", teamIds: [ids.team, siblingTeam] });
    let sharingWaitsForRoleChange = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blocked = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [rolePid]);
      if (blocked.rows[0].blocked) { sharingWaitsForRoleChange = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sharingWaitsForRoleChange, true, "sharing must reach the sibling-team lock held by the real role mutation");
    releaseRoleChange.resolve();
    const [shared, changedMember] = await bounded(Promise.all([sharing, roleChange]));
    ok(shared);
    assert.equal(changedMember?.role, "owner");
    assert.deepEqual((await pool.query("SELECT g.team_id FROM skill_team_grants g JOIN skills s ON s.id = g.skill_id WHERE s.slug = $1 ORDER BY g.team_id", [slug])).rows.map((row) => row.team_id), [ids.team, siblingTeam].sort());
    record("T14-sibling-locks", { sharingWaitedForRoleMutation: true, sharingStatus: shared.status, memberRole: changedMember?.role, committedGrants: 2 });
  } finally {
    releaseRoleChange.resolve();
    await Promise.allSettled([roleChange, ...(sharing ? [sharing] : [])]);
    ok(await call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "team", teamIds: [ids.team] }));
    await pool.query("UPDATE teams SET organization_id = NULL WHERE id = $1", [ids.team]);
    await pool.query("DELETE FROM teams WHERE id = $1", [siblingTeam]);
  }

  // Target-organization grants have a separate inverse order: organization
  // membership mutations hold O2 then lock the actor user, while an early owning
  // team authorization could hold that user and wait for O2.
  const priorSharingSettings = (await pool.query("SELECT value FROM instance_settings WHERE key = 'sharing'")).rows[0].value;
  await pool.query("UPDATE instance_settings SET value = jsonb_set(value, '{organizationVisibilityEnabled}', 'true') WHERE key = 'sharing'");
  const enteredOrganizationChange = deferred();
  const releaseOrganizationChange = deferred();
  let organizationPid = 0;
  const organizationChange = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM organizations WHERE id = ${sharingOrg}::uuid FOR UPDATE`);
    organizationPid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    enteredOrganizationChange.resolve();
    await releaseOrganizationChange.promise;
    return new PostgresOrganizationStore(tx as unknown as Database).updateMembershipRole({ organizationId: sharingOrg, userId: ids.member, role: "admin", actorUserId: ids.bob });
  });
  let organizationSharing: ReturnType<typeof call> | null = null;
  try {
    await bounded(enteredOrganizationChange.promise);
    organizationSharing = call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "team", organizationIds: [sharingOrg] });
    let sharingWaitsForOrganization = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const blocked = await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [organizationPid]);
      if (blocked.rows[0].blocked) { sharingWaitsForOrganization = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sharingWaitsForOrganization, true, "sharing must reach the target-organization lock held by the real membership mutation");
    releaseOrganizationChange.resolve();
    const [shared, changedMembership] = await bounded(Promise.all([organizationSharing, organizationChange]));
    ok(shared);
    assert.equal(changedMembership?.role, "admin");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_organization_grants g JOIN skills s ON s.id = g.skill_id WHERE s.slug = $1 AND g.organization_id = $2", [slug, sharingOrg])).rows[0].count, 1);
    record("T14-org-locks", { sharingWaitedForMembershipMutation: true, sharingStatus: shared.status, memberRole: changedMembership?.role, committedOrganizationGrants: 1 });
  } finally {
    releaseOrganizationChange.resolve();
    await Promise.allSettled([organizationChange, ...(organizationSharing ? [organizationSharing] : [])]);
    ok(await call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "team", organizationIds: [] }));
    await pool.query("UPDATE instance_settings SET value = $1::jsonb WHERE key = 'sharing'", [JSON.stringify(priorSharingSettings)]);
  }

  // The team owner can deliberately change sharing. Later imports preserve it;
  // the default team grant requirement applies to team visibility, not public releases.
  ok(await call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "public" }));
  await pool.query("DELETE FROM skill_team_grants WHERE team_id = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)", [ids.team, slug]);
  github.commit(repository, { files: { "skills/ce-plan/references/guide.md": "# Guide\nRecord acceptance criteria, revocation failures and sharing decisions.\n" } });
  // A third Library explicitly previews and ignores these bytes before the
  // daily Library imports them. Advancing the shared head must not undo that decision.
  const ignoredLibrary = ok(await call("POST", "/v1/libraries", bob, { name: "Engineering held recommendations", owner: { type: "team", id: ids.team } }), 201).library;
  const ignoredSource = ok(await call("POST", `/v1/libraries/${ignoredLibrary.id}/entries`, bob, { kind: "source", url: `https://github.com/${repository}` }), 201).entry;
  const ignoredSkillEntry = ok(await call("POST", `/v1/libraries/${ignoredLibrary.id}/entries`, bob, { kind: "skill", slug }), 201).entry;
  ok(await call("POST", `/v1/library-entries/${ignoredSkillEntry.id}/adoptions`, bob, { version: "0.0.2", artifactSha256: update.packageDigest, expectedCurrentAdoptionId: null }), 201);
  ok(await call("PUT", `/v1/libraries/${ignoredLibrary.id}/subscription`, bob, {}));
  const ignoredDiscovery = ok(await call("POST", `/v1/library-entries/${ignoredSource.id}/discoveries`, bob)).discovery;
  const ignoredCandidate = ok(await call("POST", `/v1/library-entries/${ignoredSource.id}/previews`, bob, { snapshotId: ignoredDiscovery.snapshot.id, paths: ["skills/ce-plan"] })).preview.candidates[0];
  assert.equal(ignoredCandidate.expectedVersion, "0.0.3");
  ok(await call("POST", `/v1/library-candidates/${ignoredCandidate.id}/ignore`, bob));
  const publicCheck = ok(await call("POST", `/v1/library-entries/${source.id}/checks`, bob)).check;
  assert.equal(publicCheck.candidateIds.length, 1);
  const publicCandidate = ok(await call("GET", `/v1/library-candidates/${publicCheck.candidateIds[0]}`, bob)).candidate;
  assert.equal(publicCandidate.mapping.visibility, "public");
  const publicImport = ok(await call("POST", `/v1/library-candidates/${publicCandidate.id}/import`, bob, importBody(publicCandidate)), 202);
  assert.equal(publicImport.submission.slug, slug);
  assert.equal(publicImport.submission.version, "0.0.3");
  await publish(publicImport.submission.id);
  assert.equal((await pool.query("SELECT visibility FROM skills WHERE slug = $1", [slug])).rows[0].visibility, "public");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_team_grants WHERE team_id = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)", [ids.team, slug])).rows[0].count, 0);
  ok(await call("PUT", `/v1/skills/${slug}/sharing`, bob, { visibility: "team", teamIds: [ids.team] }));
  assert.equal(ok(await call("GET", `/v1/library-entries/${entryId}/resolution`, member)).resolution.version, "0.0.2");
  record("T14-sharing", { preservedVisibility: "public", sameLineage: slug, importedVersion: "0.0.3", implicitTeamGrant: false, currentAdoption: "0.0.2" });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(ok(await call("POST", `/v1/library-entries/${ignoredSource.id}/checks`, bob)).check.candidateIds, []);
  }
  assert.equal(ok(await call("GET", `/v1/library-candidates/${ignoredCandidate.id}`, bob)).candidate.state, "ignored");
  assert.equal(ok(await call("GET", "/v1/library-inbox", bob)).items.some((item: Json) => item.libraryId === ignoredLibrary.id && item.kind === "candidate-ready"), false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM library_events WHERE library_id = $1 AND kind = 'candidate-ready'", [ignoredLibrary.id])).rows[0].count, 0);
  assert.equal(ok(await call("GET", `/v1/library-entries/${ignoredSkillEntry.id}/resolution`, bob)).resolution.version, "0.0.2");
  record("T14-ignored", { candidateId: ignoredCandidate.id, state: "ignored", sharedHead: "0.0.3", localPin: "0.0.2", repeatedCheckNotices: 0 });

  // The daily Library already imported this source digest when the weekly
  // Library catches up. Its curators still need a review notice for their own pin.
  const siblingBeforeSkew = ok(await call("GET", `/v1/library-entries/${siblingSource.id}`, bob)).entry;
  ok(await call("PATCH", `/v1/library-entries/${siblingSource.id}/tracking`, bob, { expectedRevision: siblingBeforeSkew.revision, mode: "weekly" }));
  const importsBeforeSkew = (await pool.query("SELECT count(*)::int AS count FROM library_import_candidates WHERE lineage_id = $1", [plan.lineage.id])).rows[0].count;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const delayed = ok(await call("POST", `/v1/library-entries/${siblingSource.id}/checks`, bob)).check;
    assert.deepEqual(delayed.candidateIds, []);
  }
  const delayedNotice = ok(await call("GET", "/v1/library-inbox", bob)).items.filter((item: Json) => item.libraryId === sibling.id && item.entryId === siblingEntry.id && item.kind === "candidate-ready" && item.version === "0.0.3");
  assert.equal(delayedNotice.length, 1);
  assert.equal(delayedNotice[0].candidateId, null);
  assert.equal(ok(await call("GET", "/v1/library-inbox", member)).items.some((item: Json) => item.id === delayedNotice[0].id), false);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM library_import_candidates WHERE lineage_id = $1", [plan.lineage.id])).rows[0].count, importsBeforeSkew);
  assert.equal(ok(await call("GET", `/v1/library-entries/${siblingEntry.id}/resolution`, bob)).resolution.version, "0.0.1");

  // Library membership cannot replace a release grant.
  await pool.query("DELETE FROM skill_team_grants WHERE team_id = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)", [ids.team, slug]);
  error(await call("GET", `/v1/skills/${slug}/releases/0.0.2/bundle`, member), 404, "RELEASE_NOT_FOUND");
  error(await call("GET", `/v1/library-entries/${entryId}/resolution`, member), 404, "LIBRARY_ENTRY_NOT_FOUND");
  assert.equal(ok(await call("GET", "/v1/library-inbox", member)).items.some((item: Json) => item.entryId === entryId), false);
  await pool.query("INSERT INTO skill_team_grants (skill_id, team_id) SELECT id, $1 FROM skills WHERE slug = $2", [ids.team, slug]);
  ok(await call("GET", `/v1/skills/${slug}/releases/0.0.2/bundle`, member));
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.member]);
  error(await call("GET", `/v1/libraries/${library.id}`, member), 404, "LIBRARY_NOT_FOUND");
  error(await call("GET", `/v1/skills/${slug}/releases/0.0.2/bundle`, member), 404, "RELEASE_NOT_FOUND");
  assert.equal(ok(await call("GET", "/v1/library-inbox", member)).items.some((item: Json) => item.libraryId === library.id), false);
  record("T06", { grantRevocationDenied: 404, memberRevocationDenied: 404, inboxLeak: false });

  // Explicit resumption, not the return of an arbitrary former curator, restarts checks.
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1", [ids.team]);
  github.commit(repository, { files: { "skills/ce-plan/references/guide.md": "# Guide\nRecord acceptance, revocation and recovery.\n" } });
  const requestsBeforePause = github.requests.length;
  nowMs += 25 * 3_600_000;
  await workerA.runOnce();
  assert.equal(github.requests.length, requestsBeforePause);
  assert.equal((await pool.query("SELECT health FROM library_entries WHERE id = $1", [source.id])).rows[0].health, "paused");
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner')", [ids.team, ids.bob]);
  nowMs += 25 * 3_600_000;
  await workerA.runOnce();
  assert.equal(github.requests.length, requestsBeforePause);
  const paused = ok(await call("GET", `/v1/library-entries/${source.id}`, bob)).entry;
  ok(await call("PATCH", `/v1/library-entries/${source.id}/tracking`, bob, { expectedRevision: paused.revision, mode: "daily" }));
  nowMs += 25 * 3_600_000;
  await workerA.runOnce();
  assert.ok(github.requests.length > requestsBeforePause);
  assert.equal(ok(await call("GET", `/v1/library-entries/${source.id}/candidates?state=ready-for-review`, bob)).candidates.length, 1);
  record("T07", { pausedWithoutFetch: true, restoredCuratorDidNotResume: true, explicitResumptionChecked: true });

  const libraryBeforeDelete = ok(await call("GET", `/v1/libraries/${library.id}`, bob)).library;
  ok(await call("DELETE", `/v1/libraries/${library.id}?expectedRevision=${libraryBeforeDelete.revision}`, bob));
  const adoptedSharedHead = ok(await call("POST", `/v1/library-entries/${siblingEntry.id}/adoptions`, bob, { version: "0.0.3", artifactSha256: publicCandidate.packageDigest, expectedCurrentAdoptionId: siblingAdoption.id, reason: "Reviewed shared team release after original Library removal." }), 201).adoption;
  assert.equal(adoptedSharedHead.version, "0.0.3");
  record("T14-skew", { notices: 1, candidateId: null, clonedCandidates: 0, previousPin: "0.0.1", adoptedAfterOriginalLibraryRemoval: "0.0.3" });

  const target = process.env.TEAM_LIBRARY_JOURNEY_EVIDENCE_PATH;
  const directory = mkdtempSync(join(target ? dirname(target) : tmpdir(), "myskills-team-library-"));
  const path = join(directory, target ? basename(target) : "team-library-evidence.json");
  assert.deepEqual(evidence.map((item) => item.id).sort(), ["T01", "T02", "T03-demoted", "T03-organization-removed", "T03-removed", "T04", "T05", "T06", "T07", "T08", "T14-grant", "T14-ignored", "T14-locks", "T14-mfa", "T14-org-locks", "T14-quota", "T14-sharing", "T14-sibling-locks", "T14-skew"]);
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, journey: "team-library", scenarios: evidence }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  t.diagnostic(`team library journey evidence: ${path}`);

  async function publish(submissionId: string) {
    const bundle = await call("GET", `/v1/review/submissions/${submissionId}/bundle`, reviewer);
    ok(bundle);
    const digest = String(bundle.headers["x-myskills-artifact-sha256"]);
    assert.equal(sha256(bundle.bytes), digest);
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "approve", artifactSha256: digest }));
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "publish" }));
  }
});

test("team ownership migration preserves populated personal imports and orphaned slugs", { timeout: 60_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assert.match(new URL(databaseUrl).pathname.slice(1), /(^|[_-])(test|ci)([_-]|$)/i, "Only a disposable test database may be reset.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
  const upgrade = "0034_team_library_ownership.sql";
  for (const migration of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql") && name < upgrade).sort()) {
    await pool.query(readFileSync(join(migrationsDir, migration), "utf8"));
  }
  await pool.query("INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, 'legacy@example.com', 'legacy@example.com', 'Legacy importer', 'active', now())", [ids.alice]);
  await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [ids.alice, await hashPassword(password)]);
  await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, 'author')", [ids.alice]);
  await pool.query("INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, 'Engineering', 'engineering', $2)", [ids.team, ids.alice]);
  const source = (await pool.query("INSERT INTO library_sources (repository_id, provider, full_name, html_url) VALUES ('424242', 'github', 'everyinc/compound-engineering-plugin', 'https://github.com/everyinc/compound-engineering-plugin') RETURNING id")).rows[0].id;
  const library = (await pool.query("INSERT INTO libraries (owner_user_id, name, created_by_user_id) VALUES ($1, 'Legacy personal', $1) RETURNING id", [ids.alice])).rows[0].id;
  const sourceEntry = (await pool.query("INSERT INTO library_entries (library_id, kind, title, source_id, ref_kind, acknowledged_full_name, created_by_user_id) VALUES ($1, 'source', 'Legacy source', $2, 'default-branch', 'everyinc/compound-engineering-plugin', $3) RETURNING id", [library, source, ids.alice])).rows[0].id;
  const lineage = (await pool.query("INSERT INTO library_import_lineages (owner_user_id, source_id, source_path, ref_kind, slug, revision_counter) VALUES ($1, $2, 'skills/ce-plan', 'default-branch', 'legacy-personal-plan', 1) RETURNING id", [ids.alice, source])).rows[0].id;
  const snapshot = (await pool.query(`INSERT INTO library_source_snapshots
    (entry_id, source_id, sequence, ref_kind, ref_value, commit_sha, tree_sha, complete, order_status, inventory, inventory_digest, observed_at)
    VALUES ($1, $2, 1, 'default-branch', '', $3, $3, true, 'initial', '[]', $4, '2026-09-26T00:00:00Z') RETURNING id`, [sourceEntry, source, "a".repeat(40), "b".repeat(64)])).rows[0].id;
  const skill = (await pool.query("INSERT INTO skills (slug, title, summary, owner_user_id) VALUES ('legacy-personal-plan', 'Legacy plan', 'Keep existing ownership.', $1) RETURNING id", [ids.alice])).rows[0].id;
  await pool.query("INSERT INTO skills (slug, title, summary, owner_user_id) VALUES ('legacy-orphan', 'Orphan', 'Reserved historical slug.', NULL)");
  const version = (await pool.query("INSERT INTO skill_versions (skill_id, version) VALUES ($1, '0.0.1') RETURNING id", [skill])).rows[0].id;
  const candidate = (await pool.query(`INSERT INTO library_import_candidates
    (source_entry_id, lineage_id, owner_user_id, snapshot_id, snapshot_sequence, origin, state, source_path,
     profile_digest, expected_prior_revision, expected_version, order_status, source_digest, package_digest,
     mapping, submission_id, expires_at, decided_by_user_id, decided_at)
    VALUES ($1, $2, $3, $4, 1, 'preview', 'accepted', 'skills/ce-plan', $5, 0, '0.0.1', 'initial', $5, $5,
     '{}', $6, '2026-10-01T00:00:00Z', $3, '2026-09-26T00:00:00Z') RETURNING id`, [sourceEntry, lineage, ids.alice, snapshot, "b".repeat(64), version])).rows[0].id;
  await pool.query(`INSERT INTO skill_release_provenance
    (skill_version_id, lineage_id, candidate_id, owner_user_id, imported_by_user_id, provider, repository_id,
     repository_full_name, repository_url, ref_kind, ref_value, commit_sha, tree_sha, source_path,
     source_digest, package_digest, files, notices, transforms, importer_version, import_profile_digest,
     release_classification, retrieved_at)
    VALUES ($1, $2, $3, $4, $4, 'github', '424242', 'everyinc/compound-engineering-plugin',
     'https://github.com/everyinc/compound-engineering-plugin', 'default-branch', '', $5, $5,
     'skills/ce-plan', $6, $6, '[]', '[]', '[]', 'myskills-library-importer/2', $6, 'unclassified', '2026-09-26T00:00:00Z')`,
  [version, lineage, candidate, ids.alice, "a".repeat(40), "b".repeat(64)]);
  const tables = ["skills", "skill_versions", "library_import_lineages", "library_import_candidates", "skill_release_provenance", "libraries", "library_entries"];
  const rows = async (table: string) => (await pool.query(`SELECT jsonb_agg(to_jsonb(r) - 'owner_team_id' ORDER BY id) AS rows FROM ${table} r`)).rows[0].rows;
  const before = new Map<string, unknown>();
  for (const table of tables) before.set(table, await rows(table));
  await pool.query(readFileSync(join(migrationsDir, upgrade), "utf8"));
  for (const table of tables) assert.deepEqual(await rows(table), before.get(table), `${table} existing fields must survive the upgrade unchanged`);
  for (const table of ["skills", "library_import_lineages", "library_import_candidates", "skill_release_provenance"]) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE owner_team_id IS NOT NULL`)).rows[0].count, 0);
  }
  await assert.rejects(pool.query("UPDATE skills SET owner_team_id = $2 WHERE id = $1", [skill, ids.team]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE library_import_lineages SET owner_team_id = $2 WHERE id = $1", [lineage, ids.team]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE library_import_candidates SET owner_team_id = $2 WHERE id = $1", [candidate, ids.team]), { code: "23514" });
  await assert.rejects(pool.query("UPDATE skill_release_provenance SET imported_by_user_id = $2 WHERE candidate_id = $1", [candidate, ids.bob]), { code: "55000" });

  // Exercise takeover through the real submission boundary after migration;
  // a null legacy owner must remain reserved, not become a team's or user's slug.
  const db = createDb(pool);
  const app = buildApp({ authService: new AuthService(new PostgresAuthStore(db), {}), skillRepository: new PostgresSkillRepository(db), submissionService: new SubmissionService(new PostgresSubmissionStore(db)) });
  t.after(() => app.close());
  const token = await login(app, "legacy", true);
  const manifest = { name: "legacy-orphan", title: "Attempted takeover", summary: "Reserved orphaned slug.", version: "1.0.0", license: "MIT", visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: [] };
  const response = await app.inject({ method: "POST", url: "/v1/submissions", headers: { authorization: `Bearer ${token}` }, payload: { manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: skillMd(manifest.name, manifest.summary, "Preserve existing ownership.") }], release: { releaseNotes: "Attempted import.", changeKind: "feature", requiresUserAction: false } } });
  error({ status: response.statusCode, body: response.json() }, 409, "PACKAGE_SLUG_UNAVAILABLE");
  assert.deepEqual(await rows("skills"), before.get("skills"));
  assert.deepEqual(await rows("skill_versions"), before.get("skill_versions"));
  const directory = mkdtempSync(join(tmpdir(), "myskills-team-library-migration-"));
  const path = join(directory, "migration-evidence.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, scenario: "T13", migration: upgrade, preservedTables: tables, personalLineage: lineage, originalImporter: ids.alice, orphanTakeoverStatus: 409, mixedOwnershipDenied: true, immutableProvenanceDenied: true }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  t.diagnostic(`team library migration evidence: ${path}`);
});

function ok(response: { status: number; body: Json }, status = 200): Json {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${JSON.stringify(response.body).slice(0, 600)}`);
  return response.body;
}

function error(response: { status: number; body: Json }, status: number, code: string): void {
  assert.equal(response.status, status, `expected ${status} ${code}, got ${response.status}: ${JSON.stringify(response.body).slice(0, 600)}`);
  assert.equal(response.body.error?.code, code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for deterministic concurrency barrier.")), 5_000); })]);
  } finally {
    clearTimeout(timer);
  }
}

function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}\n`;
}

async function login(app: ReturnType<typeof buildApp>, name: string, mfa: boolean): Promise<string> {
  const email = `${name}@example.com`;
  const setup = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(setup.statusCode, 200, setup.body);
  const setupToken = setup.json().token as string;
  if (!mfa) return setupToken;
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${setupToken}` }, payload: { password } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${setupToken}` }, payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(challenge.json().mfaRequired, true);
  const verify = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token as string;
}
