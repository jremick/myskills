import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { hashPassword } from "@myskills-app/auth";
import {
  AppError,
  architecturePatternIds,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type ArchitecturePatternId,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { ARCHITECTURE_PATTERNS } from "../src/architectures/service.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { createDb, createPgPool, type Database } from "../src/db/client.js";
import {
  organizationMemberships,
  organizationPolicyRevisions,
  auditEvents,
  skillArchitectureRevisions,
  skillArchitectures,
  skillArtifacts,
  skills,
  teamMemberships,
  users,
} from "../src/db/schema.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { SubmissionService } from "../src/submissions/service.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const password = "correct horse battery staple";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const organizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const organizationPolicyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fixtureSkillId = "88888888-8888-4888-8888-888888888888";
const fixtureSkillVersionId = "99999999-9999-4999-8999-999999999999";
const fixtureArtifactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("migration 0016 preserves existing user-owned architecture rows", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0015(pool);

  const db = createDb(pool);
  await insertUser(db, ownerId, "migration-owner@example.com");
  const architectureId = "44444444-4444-4444-8444-444444444444";
  const revisionId = "55555555-5555-4555-8555-555555555555";
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [architectureId, ownerId, "Legacy architecture", "Preserve this row.", "flat"],
  );
  await pool.query(
    `INSERT INTO skill_architecture_revisions
       (id, architecture_id, revision_number, message, spec, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [revisionId, architectureId, 1, "Legacy revision", JSON.stringify({ schemaVersion: 1 }), ownerId],
  );
  await pool.query("UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2", [revisionId, architectureId]);

  const before = (await pool.query(
    `SELECT id, owner_user_id, name, description, pattern_id, current_revision_id
     FROM skill_architectures`,
  )).rows;
  const revisionsBefore = (await pool.query(
    "SELECT id, architecture_id, revision_number, message, created_by_user_id FROM skill_architecture_revisions",
  )).rows;

  await applyMigration(pool, "0016_architecture_owner_tenancy");

  const after = (await pool.query(
    `SELECT id, owner_user_id, owner_team_id, access_policy_version, name, description, pattern_id, current_revision_id
     FROM skill_architectures`,
  )).rows;
  assert.deepEqual(after, before.map((row) => ({
    ...row,
    owner_team_id: null,
    access_policy_version: 1,
  })));
  assert.deepEqual(
    (await pool.query(
      "SELECT id, architecture_id, revision_number, message, created_by_user_id FROM skill_architecture_revisions",
    )).rows,
    revisionsBefore,
  );

  const indexes = (await pool.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'skill_architectures'`,
  )).rows as Array<{ indexname: string; indexdef: string }>;
  assert.equal(indexes.some((index) => index.indexname === "skill_architectures_owner_idx"), false);
  assert.match(
    indexes.find((index) => index.indexname === "skill_architectures_owner_user_idx")?.indexdef ?? "",
    /WHERE \(owner_user_id IS NOT NULL\)/,
  );
  assert.match(
    indexes.find((index) => index.indexname === "skill_architectures_owner_team_idx")?.indexdef ?? "",
    /WHERE \(owner_team_id IS NOT NULL\)/,
  );
});

test("migration 0016 rejects architecture rows with zero or two owners", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  await insertUser(db, ownerId, "tenancy-owner@example.com");
  await pool.query(
    "INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [teamId, "Architecture team", "architecture-team", ownerId],
  );

  const insertArchitecture = (id: string, ownerUserId: string | null, ownerTeamId: string | null) => pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, owner_team_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, ownerUserId, ownerTeamId, "Ownership check", "", "flat"],
  );

  await assert.rejects(
    insertArchitecture("66666666-6666-4666-8666-666666666666", null, null),
    (error) => isConstraintError(error, "skill_architectures_exactly_one_owner_check"),
  );
  await assert.rejects(
    insertArchitecture("77777777-7777-4777-8777-777777777777", ownerId, teamId),
    (error) => isConstraintError(error, "skill_architectures_exactly_one_owner_check"),
  );
});

test("migration 0015 persists every advertised architecture pattern id", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "architect-owner@example.com");

  assert.deepEqual(ARCHITECTURE_PATTERNS.map((pattern) => pattern.id), [...architecturePatternIds]);

  for (const patternId of architecturePatternIds) {
    const architecture = await store.createArchitecture({
      ownerUserId: ownerId,
      name: `${patternId} architecture`,
      description: "Pattern persistence check.",
      patternId,
    });
    const revision = await store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      expectedCurrentRevisionId: null,
      message: "Initial revision",
      spec: architectureSpec(patternId, architecture.id),
    });
    assert.equal(revision?.spec.pattern.id, patternId);
  }

  const rows = await db
    .select({ patternId: skillArchitectures.patternId })
    .from(skillArchitectures)
    .orderBy(skillArchitectures.patternId);
  assert.deepEqual(rows.map((row) => row.patternId).sort(), [...architecturePatternIds].sort());

  await assert.rejects(
    pool.query(
      "insert into skill_architectures (owner_user_id, name, description, pattern_id) values ($1, $2, $3, $4)",
      [ownerId, "Unsupported", "", "router-tree"],
    ),
    (error) => isConstraintError(error, "skill_architectures_pattern_id_check"),
  );
});

test("postgres architecture revisions are sequential, immutable records with a current revision pointer", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "revision-owner@example.com");
  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Sequential revisions",
    description: "",
    patternId: "multi-level-router",
  });

  const firstSpec = architectureSpec("multi-level-router", architecture.id);
  const first = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Initial topology",
    expectedCurrentRevisionId: null,
    spec: firstSpec,
  });
  assert.equal(first?.revisionNumber, 1);

  firstSpec.name = "mutated caller copy";
  const second = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    message: "Second topology",
    expectedCurrentRevisionId: first?.id ?? null,
    spec: {
      ...architectureSpec("multi-level-router", architecture.id),
      description: "Revision two keeps revision one immutable.",
    },
  });
  assert.equal(second?.revisionNumber, 2);

  await assert.rejects(
    store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      message: "Stale topology",
      expectedCurrentRevisionId: first?.id ?? null,
      spec: architectureSpec("multi-level-router", architecture.id),
    }),
    (error) => error instanceof AppError
      && error.code === "ARCHITECTURE_REVISION_CONFLICT"
      && (error.details as { currentRevisionId?: string }).currentRevisionId === second?.id,
  );

  const current = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(current?.currentRevisionId, second?.id);
  assert.equal(current?.revisionCount, 2);

  const firstRead = await store.getRevision(ownerId, architecture.id, first?.id);
  assert.equal(firstRead?.revisionNumber, 1);
  assert.equal(firstRead?.spec.name, "multi-level-router architecture");
  assert.equal(firstRead?.spec.description, undefined);

  const latestRead = await store.getRevision(ownerId, architecture.id);
  assert.equal(latestRead?.id, second?.id);
  assert.equal(latestRead?.spec.description, "Revision two keeps revision one immutable.");

  await assert.rejects(
    pool.query(
      "insert into skill_architecture_revisions (architecture_id, revision_number, message, spec, created_by_user_id) values ($1, $2, $3, $4::jsonb, $5)",
      [architecture.id, 2, "duplicate", JSON.stringify(architectureSpec("multi-level-router", architecture.id)), ownerId],
    ),
    // PostgreSQL truncates unnamed constraint identifiers at 63 bytes, so the
    // generated name is not guaranteed to retain the full column name.
    (error) => isUniqueViolation(error),
  );
});

test("postgres architecture mutations roll back when the required allow audit fails", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  await insertUser(db, ownerId, "audit-atomicity-owner@example.com");
  let failAction: "architecture.create" | "architecture.revision.create" | null = "architecture.create";
  const store = new PostgresArchitectureStore(db, {
    beforeAuditInsert: (input) => {
      if (input.action === failAction) {
        failAction = null;
        throw new Error(`injected ${input.action} audit failure`);
      }
    },
  });
  const architectureInput = {
    ownerUserId: ownerId,
    name: "Audit atomicity",
    description: "",
    patternId: "flat" as const,
  };
  const createAudit = {
    actorUserId: ownerId,
    action: "architecture.create",
    resourceType: "skill_architecture",
  } as const;

  await assert.rejects(
    store.createArchitecture(ownerId, architectureInput, createAudit),
    /injected architecture\.create audit failure/,
  );
  assert.equal(
    (await db.select({ id: skillArchitectures.id }).from(skillArchitectures)).length,
    0,
  );
  assert.equal(
    (await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.resourceType, "skill_architecture"))).length,
    0,
  );

  const architecture = await store.createArchitecture(ownerId, architectureInput, createAudit);
  assert.equal(
    (await db.select({ id: skillArchitectures.id }).from(skillArchitectures)).length,
    1,
  );
  assert.equal(
    (await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.resourceType, "skill_architecture"))).length,
    1,
  );

  failAction = "architecture.revision.create";
  const revisionInput = {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial topology",
    spec: architectureSpec("flat", architecture.id),
  } as const;
  const revisionAudit = {
    actorUserId: ownerId,
    action: "architecture.revision.create",
    resourceType: "skill_architecture",
    resourceId: architecture.id,
  } as const;

  await assert.rejects(
    store.createRevision(ownerId, revisionInput, revisionAudit),
    /injected architecture\.revision\.create audit failure/,
  );
  assert.equal(
    (await db.select({ id: skillArchitectureRevisions.id })
      .from(skillArchitectureRevisions)
      .where(eq(skillArchitectureRevisions.architectureId, architecture.id))).length,
    0,
  );
  const afterRevisionFailure = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(afterRevisionFailure?.currentRevisionId, null);
  assert.equal(afterRevisionFailure?.revisionCount, 0);
  assert.equal(
    (await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.resourceType, "skill_architecture"))).length,
    1,
  );

  const revision = await store.createRevision(ownerId, revisionInput, revisionAudit);
  assert.equal(revision?.revisionNumber, 1);
  const afterRetry = await store.getArchitecture(ownerId, architecture.id);
  assert.equal(afterRetry?.currentRevisionId, revision?.id);
  assert.equal(afterRetry?.revisionCount, 1);
  assert.equal(
    (await db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.resourceType, "skill_architecture"))).length,
    2,
  );
});

test("postgres architecture records and revisions are isolated by owner", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "isolation-owner@example.com");
  await insertUser(db, otherUserId, "isolation-other@example.com");

  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Owner private",
    description: "",
    patternId: "domain-router",
  });
  const revision = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Private revision",
    spec: architectureSpec("domain-router", architecture.id),
  });

  assert.equal((await store.listArchitectures(ownerId)).length, 1);
  assert.deepEqual(await store.listArchitectures(otherUserId), []);
  assert.equal(await store.getArchitecture(otherUserId, architecture.id), null);
  assert.equal(await store.listRevisions(otherUserId, architecture.id), null);
  assert.equal(await store.getRevision(otherUserId, architecture.id, revision?.id), null);
  assert.equal(await store.createRevision({
    ownerUserId: otherUserId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Cross-owner write",
    spec: architectureSpec("domain-router", architecture.id),
  }), null);
});

test("postgres team architecture access follows current membership and revokes immediately", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "team-owner@example.com");
  await insertUser(db, otherUserId, "team-member@example.com");
  await pool.query(
    "INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [teamId, "Architecture team", "architecture-team", ownerId],
  );
  await pool.query(
    `INSERT INTO team_memberships (team_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [teamId, ownerId, otherUserId],
  );

  const architecture = await store.createArchitecture(ownerId, {
    owner: { type: "team", id: teamId },
    name: "Team-owned architecture",
    description: "",
    patternId: "flat",
  });
  assert.deepEqual(architecture.owner, { type: "team", id: teamId });
  assert.equal((await store.getArchitecture(otherUserId, architecture.id))?.access.canAppend, false);
  assert.equal(await store.createRevision(otherUserId, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Denied member write",
    spec: architectureSpec("flat", architecture.id),
  }), null);

  const revision = await store.createRevision(ownerId, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Owner write",
    spec: architectureSpec("flat", architecture.id),
  });
  assert.equal(revision?.createdByUserId, ownerId);
  assert.equal((await store.getRevision(otherUserId, architecture.id, revision?.id))?.id, revision?.id);

  await pool.query(
    "DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2",
    [teamId, otherUserId],
  );
  assert.deepEqual(await store.listArchitectures(otherUserId), []);
  assert.equal(await store.getArchitecture(otherUserId, architecture.id), null);
  assert.equal(await store.getRevision(otherUserId, architecture.id, revision?.id), null);
});

test("team-owned revision authority and team mutations acquire team before organization", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0017(pool);

  const db = createDb(pool);
  const architectureStore = new PostgresArchitectureStore(db);
  const teamStore = new PostgresTeamStore(db);
  await insertUser(db, ownerId, "lock-order-owner@example.com");
  await insertUser(db, otherUserId, "lock-order-member@example.com");
  await pool.query(
    `INSERT INTO organizations (id, name, slug, status, created_by_user_id)
     VALUES ($1, $2, $3, 'provisioning', $4)`,
    [organizationId, "Lock Order Organization", "lock-order-organization", ownerId],
  );
  await db.insert(organizationPolicyRevisions).values({
    id: organizationPolicyId,
    organizationId,
    revisionNumber: 1,
    schemaVersion: 1,
    policy: defaultOrganizationPolicyV1,
    policySha256: organizationPolicyDigest(defaultOrganizationPolicyV1),
    createdByUserId: ownerId,
  });
  await pool.query(
    "UPDATE organizations SET status = 'active', current_policy_revision_id = $1 WHERE id = $2",
    [organizationPolicyId, organizationId],
  );
  await db.insert(organizationMemberships).values([
    { organizationId, userId: ownerId, role: "owner" },
    { organizationId, userId: otherUserId, role: "member" },
  ]);
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id, organization_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [teamId, "Lock Order Team", "lock-order-team", ownerId, organizationId],
  );
  await db.insert(teamMemberships).values([
    { teamId, userId: ownerId, role: "owner" },
    { teamId, userId: otherUserId, role: "member" },
  ]);

  const architecture = await architectureStore.createArchitecture(ownerId, {
    owner: { type: "team", id: teamId },
    name: "Lock order architecture",
    description: "",
    patternId: "flat",
  });

  const teamBlockerPool = createPgPool(testDatabaseUrl);
  const teamBlocker = await teamBlockerPool.connect();
  const organizationBlockerPool = createPgPool(testDatabaseUrl);
  const organizationBlocker = await organizationBlockerPool.connect();
  let teamBlockerInTransaction = false;
  let organizationBlockerInTransaction = false;
  t.after(async () => {
    if (teamBlockerInTransaction) await teamBlocker.query("ROLLBACK").catch(() => undefined);
    if (organizationBlockerInTransaction) await organizationBlocker.query("ROLLBACK").catch(() => undefined);
    teamBlocker.release();
    organizationBlocker.release();
    await teamBlockerPool.end();
    await organizationBlockerPool.end();
  });

  // Hold both first rows. The team mutation queues on the team lock. The
  // revision request then queues on its first authority row. Releasing the
  // team row lets the team mutation acquire the parent organization before
  // the revision can proceed, which is safe only when both paths use the same
  // team -> organization order.
  await teamBlocker.query("BEGIN");
  teamBlockerInTransaction = true;
  await teamBlocker.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [teamId]);
  await organizationBlocker.query("BEGIN");
  organizationBlockerInTransaction = true;
  await organizationBlocker.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [organizationId]);

  const teamMutation = teamStore.updateMemberRole({
    teamId,
    userId: otherUserId,
    role: "member",
    actorUserId: ownerId,
  });
  await waitForBlockedLockQuery(pool, "teams", 1);
  const revision = architectureStore.createRevision(ownerId, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Lock order regression",
    spec: architectureSpec("flat", architecture.id),
  });
  await waitForRevisionAuthorityQuery(pool);

  const organizationWaitersBeforeTeamRelease = await blockedLockQueryCount(pool, "organizations");
  await teamBlocker.query("ROLLBACK");
  teamBlockerInTransaction = false;
  await waitForBlockedLockQuery(pool, "organizations", organizationWaitersBeforeTeamRelease + 1);
  await organizationBlocker.query("ROLLBACK");
  organizationBlockerInTransaction = false;

  const results = await Promise.allSettled([teamMutation, revision]);
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    0,
    results.map((result) => result.status === "rejected" ? String(result.reason) : result.status).join("; "),
  );
  assert.equal(results[1]?.status, "fulfilled");
  if (results[1]?.status === "fulfilled") assert.ok(results[1].value);
});

test("postgres architecture write/read paths validate spec shape, pattern, and persisted route identity", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  const store = new PostgresArchitectureStore(db);
  await insertUser(db, ownerId, "validation-owner@example.com");
  const architecture = await store.createArchitecture({
    ownerUserId: ownerId,
    name: "Validation",
    description: "",
    patternId: "multi-level-router",
  });

  await assert.rejects(
    store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      expectedCurrentRevisionId: null,
      message: "Wrong pattern",
      spec: architectureSpec("flat", architecture.id),
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_PATTERN_MISMATCH",
  );

  const invalidShape = architectureSpec("multi-level-router", architecture.id);
  invalidShape.edges = [{ from: "root", to: "release-notes", kind: "routes" }];
  await assert.rejects(
    store.createRevision({
      ownerUserId: ownerId,
      architectureId: architecture.id,
      expectedCurrentRevisionId: null,
      message: "Invalid shape",
      spec: invalidShape,
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_ORPHAN_NODE",
  );

  const valid = await store.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Valid revision",
    spec: architectureSpec("multi-level-router", architecture.id),
  });
  assert.ok(valid);

  await db
    .update(skillArchitectureRevisions)
    .set({ spec: { ...architectureSpec("multi-level-router", architecture.id), id: "wrong-route-id" } })
    .where(eq(skillArchitectureRevisions.id, valid.id));

  await assert.rejects(
    store.getRevision(ownerId, architecture.id, valid.id),
    (error) => error instanceof AppError
      && error.code === "PERSISTED_ARCHITECTURE_INVALID"
      && error.statusCode === 500,
  );
});

test("postgres-backed architecture routes normalize revision identity to the route architecture id", { timeout: 60_000 }, async (t) => {
  const testDatabaseUrl = requiredTestDatabaseUrl();
  const pool = createPgPool(testDatabaseUrl);
  t.after(() => pool.end());
  await resetAndApplyThrough0016(pool);

  const db = createDb(pool);
  await insertUser(db, ownerId, "route-owner@example.com");
  const architectureStore = new PostgresArchitectureStore(db);
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const token = await addMemoryUserAndLogin(app, authStore, {
    id: ownerId,
    email: "route-owner@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "Route identity",
      description: "Route id normalization.",
      patternId: "multi-level-router",
    },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const routeSpec = { ...architectureSpec("multi-level-router", "client-supplied-id") };
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "Route-owned identity", expectedCurrentRevisionId: null, spec: routeSpec },
  });
  assert.equal(revision.statusCode, 201);
  assert.equal(revision.json().revision.spec.id, architectureId);

  const persisted = await architectureStore.getRevision(ownerId, architectureId, revision.json().revision.id);
  assert.equal(persisted?.spec.id, architectureId);
});

function requiredTestDatabaseUrl(): string {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres architecture tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//, "");
  assert.match(databaseName, /(test|ci)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

async function resetAndApplyThrough0015(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrations(pool, { before: "0015_skill_architectures" });
  await applyMigration(pool, "0015_skill_architectures");
}

async function resetAndApplyThrough0016(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await resetAndApplyThrough0015(pool);
  await applyMigration(pool, "0016_architecture_owner_tenancy");
}

async function resetAndApplyThrough0017(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await resetAndApplyThrough0016(pool);
  await applyMigration(pool, "0017_organizations_and_org_sharing");
}

async function applyMigrations(
  pool: ReturnType<typeof createPgPool>,
  options: { before?: string } = {},
): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const id = file.replace(/\.sql$/, "");
    if (options.before && id === options.before) break;
    await applyMigration(pool, id);
  }
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertUser(db: Database, id: string, email: string): Promise<void> {
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email.toLowerCase(),
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
  await db.insert(skills).values({
    id: fixtureSkillId,
    slug: "release-notes-helper",
    title: "Release notes",
    summary: "Prepare release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    ownerUserId: id,
  }).onConflictDoNothing({ target: skills.slug });
  // These tests intentionally stop at historical architecture migrations.
  // Use the historical skill_versions shape instead of the current Drizzle
  // projection, which also contains columns introduced by migration 0021.
  await db.execute(sql`
    INSERT INTO skill_versions (
      id, skill_id, version, lifecycle_status, review_status,
      security_status, approved_artifact_sha256, published_at
    ) VALUES (
      ${fixtureSkillVersionId}, ${fixtureSkillId}, '1.0.0', 'approved',
      'approved', 'passed', ${"a".repeat(64)}, now()
    ) ON CONFLICT DO NOTHING
  `);
  await db.insert(skillArtifacts).values({
    id: fixtureArtifactId,
    skillVersionId: fixtureSkillVersionId,
    storageKey: "release-notes-helper/1.0.0/artifact",
    sha256: "a".repeat(64),
    byteSize: 1,
    contentType: "application/octet-stream",
  }).onConflictDoNothing();
}

async function addMemoryUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: { id: string; email: string; roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    name: input.email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles,
    passwordHash: await hashPassword(password),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: input.email, password },
  });
  assert.equal(login.statusCode, 200);
  return login.json().token;
}

function architectureSpec(patternId: ArchitecturePatternId, id: string): ArchitectureSpecV1 {
  if (patternId === "flat") {
    return {
      schemaVersion: 1,
      id,
      name: "flat architecture",
      pattern: { id: "flat", version: 1 },
      skills: [skillRef()],
      nodes: [{ id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" }],
      edges: [],
      entryNodeIds: ["release-notes"],
      profiles: [profile("personal", "Personal", [{ nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" }])],
      environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
    };
  }

  if (patternId === "domain-router") {
    return {
      schemaVersion: 1,
      id,
      name: "domain-router architecture",
      pattern: { id: "domain-router", version: 1 },
      skills: [skillRef()],
      nodes: [
        { id: "root", kind: "router", label: "All skills" },
        { id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" },
      ],
      edges: [{ from: "root", to: "release-notes", kind: "routes" }],
      entryNodeIds: ["root"],
      profiles: [profile("personal", "Personal", [
        { nodeId: "root", enabled: true, runtimeExposure: "router" },
        { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
      ])],
      environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
    };
  }

  return {
    schemaVersion: 1,
    id,
    name: "multi-level-router architecture",
    pattern: { id: "multi-level-router", version: 1 },
    skills: [skillRef()],
    nodes: [
      { id: "root", kind: "router", label: "All skills" },
      { id: "delivery", kind: "router", label: "Delivery" },
      { id: "release-notes", kind: "leaf", label: "Release notes", skillRefId: "release-notes" },
    ],
    edges: [
      { from: "root", to: "delivery", kind: "contains" },
      { from: "delivery", to: "release-notes", kind: "routes" },
    ],
    entryNodeIds: ["root"],
    profiles: [profile("personal", "Personal", [
      { nodeId: "root", enabled: true, runtimeExposure: "router" },
      { nodeId: "delivery", enabled: true, runtimeExposure: "router" },
      { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
    ])],
    environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
  };
}

function skillRef(): ArchitectureSpecV1["skills"][number] {
  return {
    id: "release-notes",
    slug: "release-notes-helper",
    title: "Release notes",
    version: "1.0.0",
    digest: "a".repeat(64),
    packageVisibility: "public",
  };
}

function profile(
  id: string,
  name: string,
  bindings: ArchitectureSpecV1["profiles"][number]["bindings"],
): ArchitectureSpecV1["profiles"][number] {
  return {
    id,
    name,
    subject: { type: "user", id: ownerId },
    defaultExposure: "disabled",
    bindings,
  };
}

function architectureReleaseResolver(): SubmissionService {
  return {
    async getPublicRelease(input: { slug: string; version: string }) {
      if (input.slug !== "release-notes-helper" || input.version !== "1.0.0") return null;
      return {
        slug: input.slug,
        title: "Release notes",
        summary: "Prepare release notes.",
        version: input.version,
        lifecycleStatus: "approved",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: "2026-08-30T00:00:00.000Z",
        platforms: [],
        artifact: { sha256: "a".repeat(64), byteSize: 128, contentType: "application/zip" },
      };
    },
  } as unknown as SubmissionService;
}

function architectureSkillRepository(): MemorySkillRepository {
  return new MemorySkillRepository([{
    slug: "release-notes-helper",
    title: "Release notes",
    summary: "Prepare release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: ["delivery"],
  }]);
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

async function waitForRevisionAuthorityQuery(pool: ReturnType<typeof createPgPool>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ query: string }>(`
      SELECT query
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%for update%'
        AND (query ILIKE '%teams%' OR query ILIKE '%organizations%')
    `);
    const blockedTeams = result.rows.filter((row) => row.query.toLowerCase().includes("teams")).length;
    const blockedOrganizations = result.rows.some((row) => row.query.toLowerCase().includes("organizations"));
    if (blockedOrganizations || blockedTeams >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the revision authority lock query.");
}

async function waitForBlockedLockQuery(
  pool: ReturnType<typeof createPgPool>,
  tableName: "teams" | "organizations",
  minimumCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await blockedLockQueryCount(pool, tableName) >= minimumCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a blocked ${tableName} lock query.`);
}

async function blockedLockQueryCount(
  pool: ReturnType<typeof createPgPool>,
  tableName: "teams" | "organizations",
): Promise<number> {
  const result = await pool.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_stat_activity
    WHERE pid <> pg_backend_pid()
      AND state = 'active'
      AND wait_event_type = 'Lock'
      AND query ILIKE '%for update%'
      AND query ILIKE $1
  `, [`%${tableName}%`]);
  return Number(result.rows[0]?.count ?? 0);
}
