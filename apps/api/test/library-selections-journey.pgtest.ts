/**
 * Collection/Group journey, authored before production implementation.
 * Real HTTP auth, imports, review, tracking and Postgres; only GitHub transport is a fixture.
 * Failures: missing curation/MFA/scope; invalid or foreign members; retries and concurrent
 * writes losing revisions/limits; hidden counts/positions/source IDs/candidates after
 * revocation; source checks changing membership/pins; deletion damaging shared state.
 * Existing Library journeys do not exercise organizational entities or their new routes.
 * Evidence is an owner-only, repeatable status/ID journal without credentials or content.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { FixtureGithubSource, LibraryService, PostgresLibraryStore, PublicGithubSourceProvider } from "../src/libraries/index.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";

// Assert the wire response independently of server DTOs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const password = "correct horse battery staple";

test("Library selections: multi-source tracking, overlap, isolation and concurrent curation", { timeout: 180_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assert.match(new URL(databaseUrl).pathname.slice(1), /(^|[_-])(test|ci)([_-]|$)/i);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) await pool.query(readFileSync(join(migrations, file), "utf8"));
  const db = createDb(pool);
  const github = new FixtureGithubSource();
  for (const [index, name] of ["planning", "reviewing"].entries()) github.createRepository({
    id: 70001 + index, owner: "fixture", name, defaultBranch: "main", license: "MIT",
    files: { LICENSE: "MIT License\nCopyright Test Fixture\nPermission is granted to use, copy and modify this software.\n", "skills/main/SKILL.md": skillMd(name, "Use an explicit review before making changes.") },
  });
  const store = new PostgresLibraryStore(db);
  const submissions = new SubmissionService(new PostgresSubmissionStore(db));
  const skills = new PostgresSkillRepository(db);
  const service = new LibraryService({ store, submissions, skillRepository: skills, sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }), slugSuffix: (seed) => createHash("sha256").update(seed).digest("hex").slice(0, 10) });
  const app = buildApp({ authService: new AuthService(new PostgresAuthStore(db), {}), skillRepository: skills, submissionService: submissions, libraryService: service, librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1000, windowMs: 3_600_000 }) });
  t.after(() => app.close());
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: Json) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
    return { status: response.statusCode, body: response.json() as Json, headers: response.headers };
  };
  const users: Record<string, { id: string; token: string }> = {};
  for (const name of ["alice", "bob", "reader", "outsider", "nomfa", "reviewer"]) {
    const id = randomUUID();
    await pool.query("INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())", [id, `${name}@example.com`, name]);
    await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [id, await hashPassword(password)]);
    await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, $2)", [id, name === "reviewer" ? "maintainer" : "author"]);
    users[name] = { id, token: await login(app, name, name !== "nomfa") };
  }
  const alice = users.alice!.token;
  const reader = users.reader!.token;
  const team = (await pool.query("INSERT INTO teams (name, slug, created_by_user_id) VALUES ('Selections', 'selections', $1) RETURNING id", [users.alice!.id])).rows[0].id;
  for (const name of ["alice", "bob", "reader", "nomfa"]) await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)", [team, users[name]!.id, name === "reader" ? "member" : "owner"]);
  const library = ok(await call("POST", "/v1/libraries", alice, { name: "Shared work", owner: { type: "team", id: team } }), 201).library;
  const sibling = ok(await call("POST", "/v1/libraries", alice, { name: "Independent pins", owner: { type: "team", id: team } }), 201).library;
  const sources: Json[] = [];
  const entries: Json[] = [];
  for (const name of ["planning", "reviewing"]) {
    const source = ok(await call("POST", `/v1/libraries/${library.id}/entries`, alice, { kind: "source", url: `https://github.com/fixture/${name}` }), 201).entry;
    sources.push(source);
    const discovery = ok(await call("POST", `/v1/library-entries/${source.id}/discoveries`, alice)).discovery;
    const preview = ok(await call("POST", `/v1/library-entries/${source.id}/previews`, alice, { snapshotId: discovery.snapshot.id, paths: ["skills/main"] })).preview;
    const candidate = preview.candidates[0];
    const imported = ok(await call("POST", `/v1/library-candidates/${candidate.id}/import`, alice, { expectedPackageDigest: candidate.packageDigest, release: { classification: "unclassified" } }), 202);
    await publish(imported.submission.id);
    ok(await call("POST", `/v1/library-entries/${imported.entry.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: candidate.packageDigest, expectedCurrentAdoptionId: null }), 201);
    entries.push(ok(await call("GET", `/v1/library-entries/${imported.entry.id}`, alice)).entry);
    ok(await call("PATCH", `/v1/library-entries/${source.id}/tracking`, alice, { mode: "manual", expectedRevision: source.revision }));
  }
  const siblingEntry = ok(await call("POST", `/v1/libraries/${sibling.id}/entries`, alice, { kind: "skill", slug: entries[0]!.skill.slug }), 201).entry;
  ok(await call("POST", `/v1/library-entries/${siblingEntry.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: entries[0]!.adoption.artifactSha256, expectedCurrentAdoptionId: null }), 201);
  const body = { name: "Daily engineering", description: "Two sources, explicitly selected skills", memberEntryIds: entries.map((entry) => entry.id), clientMutationId: "collection-create" };
  const collection = ok(await call("POST", `/v1/libraries/${library.id}/collections`, alice, body), 201).collection;
  const groupA = ok(await call("POST", `/v1/libraries/${library.id}/groups`, alice, { name: "Planning", memberEntryIds: [entries[0]!.id] }), 201).group;
  const groupB = ok(await call("POST", `/v1/libraries/${library.id}/groups`, alice, { name: "Review", memberEntryIds: entries.map((entry) => entry.id) }), 201).group;
  assert.equal(collection.memberCount, 2);
  assert.deepEqual([...collection.tracking.sourceEntryIds].sort(), sources.map((source) => source.id).sort());
  assert.equal(ok(await call("GET", `/v1/library-groups/${groupB.id}`, reader)).group.memberCount, 2);
  const page = ok(await call("GET", `/v1/library-collections/${collection.id}/members?limit=1`, reader));
  assert.equal(page.members[0].entry.id, entries[0]!.id);
  assert.equal(page.members[0].position, 0);
  assert.ok(page.nextCursor);
  const next = ok(await call("GET", `/v1/library-collections/${collection.id}/members?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`, reader));
  assert.equal(next.members[0].entry.id, entries[1]!.id);
  assert.equal(next.members[0].position, 1);
  assert.equal(next.nextCursor, null);
  // Shared cursor decoding accepts this character shape; selection list SQL
  // must reject it before PostgreSQL attempts a UUID cast.
  const invalidCursorId = "-".repeat(36);
  const malformedListCursor = Buffer.from(JSON.stringify(["2026-09-30T00:00:00.000000Z", invalidCursorId])).toString("base64url");
  for (const entity of [{ plural: "collections", id: collection.id }, { plural: "groups", id: groupB.id }]) {
    error(await call("GET", `/v1/libraries/${library.id}/${entity.plural}?cursor=${encodeURIComponent(malformedListCursor)}`, alice), 400, "INVALID_PAGE_CURSOR");
    const validMemberPage = ok(await call("GET", `/v1/library-${entity.plural}/${entity.id}/members?limit=1`, alice));
    const memberCursor = JSON.parse(Buffer.from(validMemberPage.nextCursor, "base64url").toString("utf8"));
    memberCursor[1] = invalidCursorId;
    const malformedMemberCursor = Buffer.from(JSON.stringify(memberCursor)).toString("base64url");
    error(await call("GET", `/v1/library-${entity.plural}/${entity.id}/members?cursor=${encodeURIComponent(malformedMemberCursor)}`, alice), 400, "INVALID_PAGE_CURSOR");
  }
  const groupsPage = ok(await call("GET", `/v1/libraries/${library.id}/groups?limit=1`, alice));
  assert.ok(groupsPage.nextCursor);
  assert.equal(ok(await call("GET", `/v1/libraries/${library.id}/groups?limit=1&cursor=${encodeURIComponent(groupsPage.nextCursor)}`, alice)).groups.length, 1);
  // A reordered membership snapshot invalidates earlier pages, rather than skipping entries.
  const groupMemberPage = ok(await call("GET", `/v1/library-groups/${groupB.id}/members?limit=1`, alice));
  ok(await call("PATCH", `/v1/library-groups/${groupB.id}`, alice, { expectedRevision: 1, memberEntryIds: [entries[1]!.id, entries[0]!.id] }));
  error(await call("GET", `/v1/library-groups/${groupB.id}/members?limit=1&cursor=${encodeURIComponent(groupMemberPage.nextCursor)}`, alice), 400, "INVALID_PAGE_CURSOR");
  // Commit a real HTTP reorder after the first selection read but before its
  // membership query. Old revision + new rows must never form a successful page.
  const racingPage = ok(await call("GET", `/v1/library-groups/${groupB.id}/members?limit=1`, alice));
  const originalMembers = store.selectionMembers.bind(store);
  let reorderedDuringRead = false;
  store.selectionMembers = async (ids) => {
    store.selectionMembers = originalMembers;
    reorderedDuringRead = true;
    ok(await call("PATCH", `/v1/library-groups/${groupB.id}`, alice, { expectedRevision: 2, memberEntryIds: [entries[0]!.id, entries[1]!.id] }));
    return originalMembers(ids);
  };
  try {
    error(await call("GET", `/v1/library-groups/${groupB.id}/members?limit=1&cursor=${encodeURIComponent(racingPage.nextCursor)}`, alice), 400, "INVALID_PAGE_CURSOR");
    assert.equal(reorderedDuringRead, true);
  } finally { store.selectionMembers = originalMembers; }
  const deletedDuringRead = ok(await call("POST", `/v1/libraries/${library.id}/groups`, alice, { name: "Concurrent removal", memberEntryIds: [entries[0]!.id] }), 201).group;
  let removedDuringRead = false;
  store.selectionMembers = async (ids) => {
    store.selectionMembers = originalMembers;
    removedDuringRead = true;
    ok(await call("DELETE", `/v1/library-groups/${deletedDuringRead.id}?expectedRevision=1`, alice));
    return originalMembers(ids);
  };
  try {
    error(await call("GET", `/v1/library-groups/${deletedDuringRead.id}/members`, alice), 404, "LIBRARY_GROUP_NOT_FOUND");
    assert.equal(removedDuringRead, true);
  } finally { store.selectionMembers = originalMembers; }
  const replay = ok(await call("POST", `/v1/libraries/${library.id}/collections`, alice, body));
  assert.equal(replay.replayed, true);
  assert.equal(replay.collection.id, collection.id);
  error(await call("POST", `/v1/libraries/${library.id}/collections`, alice, { ...body, name: "Changed" }), 409, "CLIENT_MUTATION_ID_CONFLICT");
  const concurrent = await Promise.all([1, 2].map(() => call("POST", `/v1/libraries/${library.id}/groups`, alice, { name: "Concurrent retry", memberEntryIds: [], clientMutationId: "concurrent" })));
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 201]);
  assert.equal(concurrent[0]!.body.group.id, concurrent[1]!.body.group.id);

  for (const entity of [{ plural: "collections", singular: "collection", id: collection.id }, { plural: "groups", singular: "group", id: groupA.id }]) {
    const path = `/v1/library-${entity.plural}/${entity.id}`;
    error(await call("GET", path, users.outsider!.token), 404, `LIBRARY_${entity.singular.toUpperCase()}_NOT_FOUND`);
    error(await call("GET", `${path}/members`, users.outsider!.token), 404, `LIBRARY_${entity.singular.toUpperCase()}_NOT_FOUND`);
    error(await call("PATCH", path, reader, { expectedRevision: 1, name: "Denied" }), 403, "LIBRARY_WRITE_FORBIDDEN");
    error(await call("DELETE", `${path}?expectedRevision=1`, users.nomfa!.token), 403, "MFA_VERIFICATION_REQUIRED");
    for (const revision of [undefined, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      error(await call("PATCH", path, alice, { expectedRevision: revision, name: "Malformed revision" }), 400, "INVALID_REQUEST_BODY");
    }
    for (const query of ["", "?expectedRevision=0", "?expectedRevision=1.1", "?expectedRevision=9007199254740992"]) error(await call("DELETE", `${path}${query}`, alice), 400, "INVALID_REQUEST_BODY");
  }
  const readToken = ok(await call("POST", "/v1/auth/api-tokens", alice, { name: "selection reader", scopes: ["libraries:read"] }), 201).token.token;
  const writeToken = ok(await call("POST", "/v1/auth/api-tokens", alice, { name: "selection writer", scopes: ["libraries:write"] }), 201).token.token;
  for (const entity of [{ plural: "collections", id: collection.id }, { plural: "groups", id: groupA.id }]) {
    for (const path of [`/v1/libraries/${library.id}/${entity.plural}`, `/v1/library-${entity.plural}/${entity.id}`, `/v1/library-${entity.plural}/${entity.id}/members`]) {
      error(await call("GET", path, writeToken), 403, "API_TOKEN_SCOPE_REQUIRED");
    }
  }
  ok(await call("GET", `/v1/library-collections/${collection.id}`, readToken));
  error(await call("POST", `/v1/libraries/${library.id}/groups`, readToken, { name: "Denied", memberEntryIds: [] }), 403, "API_TOKEN_SCOPE_REQUIRED");
  const bundleId = (await pool.query("INSERT INTO skill_bundles (kind, name, purpose, owner_team_id, visibility) VALUES ('curated', 'Bundle', 'Invalid organizational member', $1, 'team') RETURNING id", [team])).rows[0].id;
  const bundleEntry = (await pool.query("INSERT INTO library_entries (library_id, kind, title, bundle_id, bundle_revision_saved, created_by_user_id) VALUES ($1, 'bundle', 'Bundle', $2, 1, $3) RETURNING id", [library.id, bundleId, users.alice!.id])).rows[0].id;
  for (const invalidMembers of [[entries[0]!.id, entries[0]!.id], [sources[0]!.id], [bundleEntry], [siblingEntry.id], [randomUUID()], Array.from({ length: 201 }, () => randomUUID())]) {
    error(await call("POST", `/v1/libraries/${library.id}/groups`, alice, { name: "Invalid members", memberEntryIds: invalidMembers }), 400, "LIBRARY_SELECTION_MEMBER_INVALID");
  }
  const revisions = await Promise.all(["First editor", "Second editor"].map((name) => call("PATCH", `/v1/library-groups/${groupA.id}`, alice, { expectedRevision: 1, name, memberEntryIds: [entries[1]!.id, entries[0]!.id] })));
  assert.deepEqual(revisions.map((result) => result.status).sort(), [200, 409]);
  assert.equal(revisions.find((result) => result.status === 409)!.body.error.code, "LIBRARY_GROUP_REVISION_CONFLICT");
  error(await call("DELETE", `/v1/library-groups/${groupA.id}?expectedRevision=1`, alice), 409, "LIBRARY_GROUP_REVISION_CONFLICT");

  const invariant = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM library_entries e WHERE kind = 'skill') AS entries,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM library_adoptions a) AS adoptions,
    (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM library_target_bindings b) AS bindings`)).rows[0];
  const beforeCheck = await invariant();
  github.commit("fixture/planning", { files: { "skills/main/SKILL.md": skillMd("planning", "Review the updated planning workflow."), "skills/new/SKILL.md": skillMd("new", "This new root is not automatically selected.") } });
  ok(await call("POST", `/v1/library-entries/${sources[0]!.id}/checks`, alice));
  assert.deepEqual(await invariant(), beforeCheck, "tracking must not change skill entries, pins or bindings");
  const tracked = ok(await call("GET", `/v1/library-collections/${collection.id}`, alice)).collection;
  assert.equal(tracked.tracking.pendingCandidateCount, 1);
  assert.equal(tracked.memberCount, 2);
  assert.equal(ok(await call("GET", `/v1/library-collections/${collection.id}`, reader)).collection.tracking.pendingCandidateCount, 0);
  const pending = ok(await call("GET", `/v1/library-entries/${sources[0]!.id}/candidates?state=ready-for-review`, alice)).candidates[0];
  const update = ok(await call("POST", `/v1/library-candidates/${pending.id}/import`, alice, { expectedPackageDigest: pending.packageDigest, release: { classification: "unclassified" } }), 202);
  await publish(update.submission.id);
  ok(await call("POST", `/v1/library-entries/${entries[0]!.id}/adoptions`, alice, { version: "0.0.2", artifactSha256: pending.packageDigest, expectedCurrentAdoptionId: entries[0]!.adoption.id }), 201);
  assert.equal(ok(await call("GET", `/v1/library-entries/${siblingEntry.id}`, alice)).entry.adoption.version, "0.0.1");
  assert.equal(ok(await call("GET", `/v1/library-groups/${groupB.id}`, alice)).group.memberCount, 2);

  // Revoke one member release while retaining Library access. Private metadata must vanish.
  await pool.query("DELETE FROM skill_team_grants WHERE skill_id = (SELECT id FROM skills WHERE slug = $1)", [entries[0]!.skill.slug]);
  const hidden = ok(await call("GET", `/v1/library-collections/${collection.id}`, reader)).collection;
  assert.equal(hidden.memberCount, 1);
  assert.deepEqual(hidden.tracking.sourceEntryIds, [sources[1]!.id]);
  assert.equal(hidden.tracking.pendingCandidateCount, 0);
  const visibleMembers = ok(await call("GET", `/v1/library-collections/${collection.id}/members`, reader));
  assert.deepEqual(visibleMembers.members.map((member: Json) => [member.entry.id, member.position]), [[entries[1]!.id, 0]]);
  assert.equal(visibleMembers.nextCursor, null);
  assert.ok(!JSON.stringify({ hidden, visibleMembers }).includes(entries[0]!.id));
  assert.ok(!JSON.stringify({ hidden, visibleMembers }).includes(sources[0]!.id));
  const listedCollections = ok(await call("GET", `/v1/libraries/${library.id}/collections`, reader)).collections;
  const listedGroups = ok(await call("GET", `/v1/libraries/${library.id}/groups`, reader)).groups;
  assert.deepEqual(listedCollections.find((item: Json) => item.id === collection.id), hidden);
  assert.equal(listedGroups.find((item: Json) => item.id === groupA.id).memberCount, 1);
  assert.equal(listedGroups.find((item: Json) => item.id === groupB.id).memberCount, 1);
  for (const hiddenId of [entries[0]!.id, sources[0]!.id, pending.id]) assert.ok(!JSON.stringify({ listedCollections, listedGroups }).includes(hiddenId));
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [team, users.bob!.id]);
  error(await call("POST", `/v1/libraries/${library.id}/collections`, users.bob!.token, body), 404, "LIBRARY_NOT_FOUND");
  error(await call("GET", `/v1/library-collections/${collection.id}`, users.bob!.token), 404, "LIBRARY_COLLECTION_NOT_FOUND");

  // Revoke after service preflight: the real mutation transaction must refuse even replay.
  const original = store.createSelection.bind(store);
  let reachedStore = false;
  store.createSelection = async (input) => {
    reachedStore = true;
    await pool.query("UPDATE team_memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2", [team, users.alice!.id]);
    return original(input);
  };
  try {
    error(await call("POST", `/v1/libraries/${library.id}/collections`, alice, body), 403, "LIBRARY_WRITE_FORBIDDEN");
    assert.equal(reachedStore, true);
  } finally {
    store.createSelection = original;
    await pool.query("UPDATE team_memberships SET role = 'owner' WHERE team_id = $1 AND user_id = $2", [team, users.alice!.id]);
  }

  // Creator attribution must not become ownership of a team selection.
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner')", [team, users.bob!.id]);
  const continuity = ok(await call("POST", `/v1/libraries/${library.id}/groups`, users.bob!.token, { name: "Team continuity", memberEntryIds: [entries[1]!.id] }), 201).group;
  await pool.query("DELETE FROM users WHERE id = $1", [users.bob!.id]);
  assert.equal(ok(await call("GET", `/v1/library-groups/${continuity.id}`, alice)).group.memberCount, 1);
  const personal = ok(await call("POST", "/v1/libraries", alice, { name: "Personal" }), 201).library;
  const personalGroup = ok(await call("POST", `/v1/libraries/${personal.id}/groups`, alice, { name: "Personal notes", memberEntryIds: [] }), 201).group;
  assert.equal(ok(await call("GET", `/v1/library-groups/${personalGroup.id.toUpperCase()}`, alice)).group.id, personalGroup.id);
  assert.deepEqual(ok(await call("GET", `/v1/library-groups/${personalGroup.id.toUpperCase()}/members`, alice)).members, []);
  assert.equal(ok(await call("PATCH", `/v1/library-groups/${personalGroup.id.toUpperCase()}`, alice, { expectedRevision: 1, name: "Personal continuity" })).group.revision, 2);
  error(await call("GET", `/v1/library-groups/${personalGroup.id}`, reader), 404, "LIBRARY_GROUP_NOT_FOUND");
  assert.equal(ok(await call("GET", `/v1/libraries/${personal.id}/groups`, alice)).groups.length, 1);
  const tokenBody = { name: "Delegated curation", memberEntryIds: [], clientMutationId: "token-create" };
  const delegatedGroup = ok(await call("POST", `/v1/libraries/${personal.id}/groups`, writeToken, tokenBody), 201).group;
  assert.equal(ok(await call("POST", `/v1/libraries/${personal.id}/groups`, writeToken, tokenBody)).replayed, true);
  assert.equal(ok(await call("GET", `/v1/library-groups/${delegatedGroup.id}`, readToken)).group.id, delegatedGroup.id);
  ok(await call("DELETE", `/v1/library-groups/${delegatedGroup.id}?expectedRevision=1`, writeToken));
  // Seed only boundary setup: both final creates still go through HTTP and the real transaction.
  await pool.query(`INSERT INTO library_selections (library_id, kind, name, created_by_user_id)
    SELECT $1, 'group', 'Quota ' || n, $2 FROM generate_series(1, 98) n`, [personal.id, users.alice!.id]);
  const limits = await Promise.all(["Last slot", "Over limit"].map((name) => call("POST", `/v1/libraries/${personal.id}/groups`, alice, { name, memberEntryIds: [] })));
  assert.deepEqual(limits.map((result) => result.status).sort(), [201, 422]);
  assert.equal(limits.find((result) => result.status === 422)!.body.error.code, "LIBRARY_SELECTION_LIMIT_EXCEEDED");
  ok(await call("POST", `/v1/libraries/${personal.id}/collections`, alice, { name: "Separate quota", memberEntryIds: [] }), 201);

  ok(await call("DELETE", `/v1/library-entries/${sources[1]!.id}`, alice));
  const removedSource = ok(await call("GET", `/v1/library-collections/${collection.id}`, reader)).collection;
  assert.equal(removedSource.tracking.health, "not-tracked");
  assert.deepEqual(removedSource.tracking.sourceEntryIds, []);
  ok(await call("DELETE", `/v1/library-entries/${entries[1]!.id}`, alice));
  error(await call("PATCH", `/v1/library-groups/${groupB.id}`, alice, { expectedRevision: 3, memberEntryIds: [entries[1]!.id] }), 400, "LIBRARY_SELECTION_MEMBER_INVALID");
  assert.equal(ok(await call("GET", `/v1/library-collections/${collection.id}`, reader)).collection.memberCount, 0);
  const preserved = await invariant();
  ok(await call("DELETE", `/v1/library-collections/${collection.id}?expectedRevision=1`, alice));
  ok(await call("DELETE", `/v1/library-groups/${groupA.id}?expectedRevision=2`, alice));
  assert.deepEqual(await invariant(), preserved);
  assert.equal(ok(await call("GET", `/v1/library-groups/${groupB.id}`, alice)).group.memberCount, 1);
  error(await call("GET", `/v1/library-collections/${collection.id}`, alice), 404, "LIBRARY_COLLECTION_NOT_FOUND");
  error(await call("POST", `/v1/libraries/${library.id}/collections`, alice, body), 404, "LIBRARY_COLLECTION_NOT_FOUND");
  const audit = (await pool.query("SELECT action, count(*)::int AS count FROM audit_events WHERE action LIKE 'library.collection.%' OR action LIKE 'library.group.%' GROUP BY action")).rows;
  assert.ok(audit.some((row) => row.action === "library.collection.create" && row.count === 2));
  const directory = mkdtempSync(join(tmpdir(), "myskills-library-selections-"));
  const path = join(directory, "evidence.json");
  const receipt = { schemaVersion: 1, journey: "library-selections", collectionId: collection.id, groupIds: [groupA.id, groupB.id], multiSource: true, independentPins: ["0.0.2", "0.0.1"], hiddenPositions: [0], concurrencyStatuses: revisions.map((row) => row.status), limitStatuses: limits.map((row) => row.status), reorderedDuringRead, removedDuringRead, audit };
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  t.diagnostic(`Library selections evidence: ${path}`);
  // Canonical runners retain logs even after the disposable container is removed.
  t.diagnostic(`Library selections receipt: ${JSON.stringify(receipt)}`);

  async function publish(submissionId: string) {
    const response = await call("GET", `/v1/review/submissions/${submissionId}/bundle`, users.reviewer!.token);
    ok(response);
    const artifactSha256 = String(response.headers["x-myskills-artifact-sha256"]);
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, users.reviewer!.token, { action: "approve", artifactSha256 }));
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, users.reviewer!.token, { action: "publish" }));
  }
});

function ok(response: { status: number; body: Json }, status = 200): Json {
  assert.equal(response.status, status, JSON.stringify(response.body).slice(0, 700));
  return response.body;
}
function error(response: { status: number; body: Json }, status: number, code: string): void {
  assert.equal(response.status, status, JSON.stringify(response.body).slice(0, 700));
  assert.equal(response.body.error?.code, code);
}
function skillMd(name: string, body: string): string { return `---\nname: ${name}\ndescription: A deterministic selection journey skill.\n---\n\n# ${name}\n${body}\n`; }
async function login(app: ReturnType<typeof buildApp>, name: string, mfa: boolean): Promise<string> {
  const setup = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: `${name}@example.com`, password } });
  assert.equal(setup.statusCode, 200, setup.body);
  const token = setup.json().token as string;
  if (!mfa) return token;
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${token}` }, payload: { password } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${token}` }, payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: `${name}@example.com`, password } });
  const verified = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] } });
  assert.equal(verified.statusCode, 200, verified.body);
  return verified.json().token as string;
}
