import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
} from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresPatternMigrationStore } from "../src/architectures/postgres-pattern-migration-store.js";
import {
  ArchitecturePatternMigrationService,
  type ArchitecturePatternMigrationCreateInput,
} from "../src/architectures/pattern-migration-service.js";
import type { ArchitecturePatternMigrationCreateStoreInput } from "../src/architectures/pattern-migration-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const teamOwnerId = "33333333-3333-4333-8333-333333333333";
const teamMemberId = "44444444-4444-4444-8444-444444444444";
const teamId = "55555555-5555-4555-8555-555555555555";
const organizationId = "66666666-6666-4666-8666-666666666666";
const organizationPolicyId = "77777777-7777-4777-8777-777777777777";
const rotatedOrganizationPolicyId = "78888888-8888-4888-8888-888888888888";

const targetArchitectureIds = [
  "81111111-1111-4111-8111-111111111111",
  "82222222-2222-4222-8222-222222222222",
  "83333333-3333-4333-8333-333333333333",
  "84444444-4444-4444-8444-444444444444",
  "85555555-5555-4555-8555-555555555555",
  "86666666-6666-4666-8666-666666666666",
];
const targetRevisionIds = [
  "91111111-1111-4111-8111-111111111111",
  "92222222-2222-4222-8222-222222222222",
  "93333333-3333-4333-8333-333333333333",
  "94444444-4444-4444-8444-444444444444",
  "95555555-5555-4555-8555-555555555555",
  "96666666-6666-4666-8666-666666666666",
];
const lineageIds = [
  "a1111111-1111-4111-8111-111111111111",
  "a2222222-2222-4222-8222-222222222222",
  "a3333333-3333-4333-8333-333333333333",
  "a4444444-4444-4444-8444-444444444444",
  "a5555555-5555-4555-8555-555555555555",
  "a6666666-6666-4666-8666-666666666666",
];

interface Fixture {
  pool: ReturnType<typeof createPgPool>;
  db: ReturnType<typeof createDb>;
  architectureStore: PostgresArchitectureStore;
  migrationStore: PostgresPatternMigrationStore;
  service: ArchitecturePatternMigrationService;
  sourceArchitecture: Awaited<ReturnType<PostgresArchitectureStore["createArchitecture"]>>;
  sourceRevision: NonNullable<Awaited<ReturnType<PostgresArchitectureStore["createRevision"]>>>;
  ownerId: string;
}

test("Postgres pattern migration commits an owner shell and readback is visible through PostgresArchitectureStore", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.service.create(createInput(fixture));
  assert.equal(result.created, true);
  assert.equal(result.replayed, false);
  assert.ok(result.persisted);
  assert.equal(result.persisted.targetArchitecture.owner.type, "user");
  assert.equal(result.persisted.targetArchitecture.owner.id, ownerId);
  assert.equal(result.persisted.targetArchitecture.currentRevisionId, targetRevisionIds[0]);
  assert.equal(result.persisted.targetRevision.id, targetRevisionIds[0]);
  assert.equal(result.persisted.targetRevision.spec.id, targetArchitectureIds[0]);
  assert.equal(result.persisted.lineage.sourceArchitectureId, fixture.sourceArchitecture.id);
  assert.equal(result.persisted.lineage.sourceRevisionId, fixture.sourceRevision.id);

  const readArchitecture = await fixture.architectureStore.getArchitecture(ownerId, targetArchitectureIds[0]);
  const readRevision = await fixture.architectureStore.getRevision(ownerId, targetArchitectureIds[0], targetRevisionIds[0]);
  assert.equal(readArchitecture?.id, targetArchitectureIds[0]);
  assert.equal(readArchitecture?.currentRevisionId, targetRevisionIds[0]);
  assert.equal(readRevision?.id, targetRevisionIds[0]);
  assert.equal(readRevision?.spec.pattern.id, "multi-level-router");
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations", "target_architecture_id", targetArchitectureIds[0]), 1);
});

test("Postgres pattern migration uses actor-scoped idempotency, replays one concurrent request, and rejects conflicting reuse", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  const input = createInput(fixture);
  const [left, right] = await Promise.all([fixture.service.create(input), fixture.service.create(input)]);
  assert.equal([left.created, right.created].filter(Boolean).length, 1);
  assert.equal([left.replayed, right.replayed].filter(Boolean).length, 1);
  assert.equal(left.persisted?.targetArchitecture.id, targetArchitectureIds[0]);
  assert.equal(right.persisted?.targetArchitecture.id, targetArchitectureIds[0]);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 1);
  assert.equal(await count(fixture.pool, "skill_architectures", "id", targetArchitectureIds[0]), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions", "architecture_id", targetArchitectureIds[0]), 1);

  await assert.rejects(
    fixture.service.create(createInput(fixture, { name: "Conflicting reuse" })),
    (error: unknown) => errorCode(error) === "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 1);
});

test("Postgres pattern migration locks the exact current source revision and rejects an advanced source", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  await fixture.architectureStore.createRevision({
    actor: ownerId,
    architectureId: fixture.sourceArchitecture.id,
    expectedCurrentRevisionId: fixture.sourceRevision.id,
    message: "Source advanced",
    spec: fixture.sourceRevision.spec,
  });
  await assert.rejects(
    fixture.service.create(createInput(fixture)),
    (error: unknown) => errorCode(error) === "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
  );
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 0);
});

test("Postgres pattern migration rejects revoked team and parent-organization membership", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createTeamFixture(t);
  const first = await fixture.service.create(createInput(fixture, { idempotencyKey: "team-first" }));
  assert.equal(first.created, true);

  await fixture.pool.query(
    "DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    [organizationId, teamOwnerId],
  );
  await assert.rejects(
    fixture.service.create(createInput(fixture, { idempotencyKey: "team-revoked" })),
    (error: unknown) => ["ARCHITECTURE_NOT_FOUND", "ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN"].includes(errorCode(error) ?? ""),
  );

  await fixture.pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [organizationId, teamOwnerId],
  );
  await fixture.pool.query(
    "DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2",
    [teamId, teamOwnerId],
  );
  await assert.rejects(
    fixture.service.create(createInput(fixture, { idempotencyKey: "team-revoked-raw" })),
    (error: unknown) => ["ARCHITECTURE_NOT_FOUND", "ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN"].includes(errorCode(error) ?? ""),
  );
});

test("Postgres pattern migration cannot be discovered by another actor and does not copy grants, targets, observations, or sync runs", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.service.create(createInput(fixture));
  assert.ok(created.persisted);
  assert.equal(await fixture.migrationStore.getByIdempotencyKey(otherUserId, "pattern-migration-request-1"), null);
  assert.equal(await count(fixture.pool, "skill_architecture_organization_grants", "architecture_id", targetArchitectureIds[0]), 0);
  assert.equal(await count(fixture.pool, "skill_architecture_targets", "architecture_id", targetArchitectureIds[0]), 0);
  assert.equal(await count(fixture.pool, "skill_architecture_observations"), 0);
  assert.equal(await count(fixture.pool, "skill_architecture_sync_runs"), 0);
});

test("Postgres pattern migration rejects mapping or digest tampering before a partial target can commit", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  const created = await fixture.service.create(createInput(fixture));
  assert.ok(created.persisted);
  const base = storeInput(fixture, created.persisted);

  await assert.rejects(
    fixture.migrationStore.createDerivedShell({
      ...base,
      targetArchitecture: { ...base.targetArchitecture, id: targetArchitectureIds[1], currentRevisionId: targetRevisionIds[1] },
      targetRevision: { ...base.targetRevision, id: targetRevisionIds[1], architectureId: targetArchitectureIds[1], spec: { ...base.targetRevision.spec, id: targetArchitectureIds[1] } },
      lineage: { ...base.lineage, id: lineageIds[1], targetArchitectureId: targetArchitectureIds[1], targetRevisionId: targetRevisionIds[1], mapping: { unsupported: true } },
      audit: { ...base.audit, resourceId: targetArchitectureIds[1] },
      intentDigest: "a".repeat(64),
    }),
    (error: unknown) => ["ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD", "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID"].includes(errorCode(error) ?? ""),
  );

  await assert.rejects(
    fixture.migrationStore.createDerivedShell({
      ...base,
      targetArchitecture: { ...base.targetArchitecture, id: targetArchitectureIds[2], currentRevisionId: targetRevisionIds[2] },
      targetRevision: { ...base.targetRevision, id: targetRevisionIds[2], architectureId: targetArchitectureIds[2], spec: { ...base.targetRevision.spec, id: targetArchitectureIds[2] } },
      lineage: { ...base.lineage, id: lineageIds[2], targetArchitectureId: targetArchitectureIds[2], targetRevisionId: targetRevisionIds[2], targetRevisionDigest: "b".repeat(64) },
      audit: { ...base.audit, resourceId: targetArchitectureIds[2] },
      intentDigest: "a".repeat(64),
    }),
    (error: unknown) => errorCode(error) === "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT",
  );
  assert.equal(await count(fixture.pool, "skill_architectures"), 2);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions"), 2);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 1);
});

test("Postgres pattern migration rolls back shell, revision, and lineage together on a late failure", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t, { failBeforeLineage: true });
  await assert.rejects(fixture.service.create(createInput(fixture)));
  assert.equal(await count(fixture.pool, "skill_architectures"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 0);

  const retryStore = new PostgresPatternMigrationStore(fixture.db);
  const retryGenerated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0]];
  const retryService = new ArchitecturePatternMigrationService(fixture.architectureStore, retryStore, {
    idFactory: () => retryGenerated.shift() ?? targetArchitectureIds[0],
    releaseAuthorizer: { authorize: async () => true },
  });
  // The first service's id factory consumed three identities before the
  // transaction failed. A new service supplies the original target tuple.
  const retry = await retryService.create(createInput(fixture));
  assert.equal(retry.created, true);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 1);
});

test("Postgres pattern migration rolls back shell, revision, lineage, and allow audit together on audit failure", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t, { failBeforeAudit: true });
  await assert.rejects(fixture.service.create(createInput(fixture)));
  assert.equal(await count(fixture.pool, "skill_architectures"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 0);
  const failedAudit = await fixture.pool.query(
    `SELECT count(*)::int AS count
     FROM audit_events
     WHERE resource_type = 'skill_architecture_pattern_migration'
       AND action = 'architecture.pattern-migration.create'
       AND decision = 'allow'`,
  );
  assert.equal(failedAudit.rows[0]?.count, 0);

  const retryStore = new PostgresPatternMigrationStore(fixture.db);
  const retryGenerated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0]];
  const retryService = new ArchitecturePatternMigrationService(fixture.architectureStore, retryStore, {
    idFactory: () => retryGenerated.shift() ?? targetArchitectureIds[0],
    releaseAuthorizer: { authorize: async () => true },
  });
  const retry = await retryService.create(createInput(fixture));
  assert.equal(retry.created, true);
  const committedAudit = await fixture.pool.query(
    `SELECT count(*)::int AS count
     FROM audit_events
     WHERE resource_type = 'skill_architecture_pattern_migration'
       AND action = 'architecture.pattern-migration.create'
       AND decision = 'allow'`,
  );
  assert.equal(committedAudit.rows[0]?.count, 1);
});

test("Postgres pattern migration rejects a release revoked after preflight before the internal registry snapshot", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createFixture(t);
  const generated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0]];
  const service = new ArchitecturePatternMigrationService(fixture.architectureStore, fixture.migrationStore, {
    idFactory: () => generated.shift() ?? targetArchitectureIds[0],
    releaseAuthorizer: {
      authorize: async () => {
        await fixture.pool.query(
          "UPDATE skill_versions SET lifecycle_status = 'revoked' WHERE version = $1 AND skill_id = (SELECT id FROM skills WHERE slug = $2)",
          ["1.0.0", "skill-alpha"],
        );
        return true;
      },
    },
  });

  await assert.rejects(
    service.create(createInput(fixture)),
    (error: unknown) => errorCode(error) === "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_REVALIDATION_FAILED",
  );
  assert.equal(await count(fixture.pool, "skill_architectures"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions"), 1);
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 0);
});

test("Postgres pattern migration rejects an organization policy rotation after preflight", { timeout: 60_000, skip: !databaseUrl }, async (t) => {
  const fixture = await createOrganizationFixture(t);
  const generated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0]];
  const service = new ArchitecturePatternMigrationService(fixture.architectureStore, fixture.migrationStore, {
    idFactory: () => generated.shift() ?? targetArchitectureIds[0],
    releaseAuthorizer: {
      authorize: async () => {
        const rotatedPolicy = {
          ...defaultOrganizationPolicyV1,
          sharing: {
            ...defaultOrganizationPolicyV1.sharing,
            organizationSkillSharingEnabled: false,
          },
        };
        await fixture.pool.query(
          "INSERT INTO organization_policy_revisions (id, organization_id, revision_number, schema_version, policy, policy_sha256, reason, created_by_user_id) VALUES ($1, $2, 2, 1, $3::jsonb, $4, 'Rotated during migration preflight', $5)",
          [rotatedOrganizationPolicyId, organizationId, JSON.stringify(rotatedPolicy), organizationPolicyDigest(rotatedPolicy), ownerId],
        );
        await fixture.pool.query(
          "UPDATE organizations SET current_policy_revision_id = $1 WHERE id = $2",
          [rotatedOrganizationPolicyId, organizationId],
        );
        return true;
      },
    },
  });

  await assert.rejects(
    service.create(createInput(fixture)),
    (error: unknown) => errorCode(error) === "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_REVALIDATION_FAILED",
  );
  assert.equal(await count(fixture.pool, "skill_architecture_pattern_migrations"), 0);
  assert.equal(await count(fixture.pool, "skill_architectures"), 2);
  assert.equal(await count(fixture.pool, "skill_architecture_revisions"), 2);
});

async function createFixture(t: TestContext, options: { failBeforeLineage?: boolean; failBeforeAudit?: boolean } = {}): Promise<Fixture> {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres pattern migration tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0020_architecture_pattern_migrations");
  await insertUser(pool, ownerId, "pattern-owner@example.com");
  await insertUser(pool, otherUserId, "pattern-other@example.com");
  const db = createDb(pool);
  const architectureStore = new PostgresArchitectureStore(db);
  const sourceArchitecture = await architectureStore.createArchitecture({
    actor: ownerId,
    owner: { type: "user", id: ownerId },
    name: "Source architecture",
    description: "Source description",
    patternId: "flat",
  });
  const sourceSpec = createFlatArchitecture({
    id: sourceArchitecture.id,
    name: sourceArchitecture.name,
    description: sourceArchitecture.description,
    skills: [
      { id: "skill-alpha", slug: "skill-alpha", title: "Alpha", version: "1.0.0", digest: "a".repeat(64), packageVisibility: "public" },
      { id: "skill-beta", slug: "skill-beta", title: "Beta", version: "2.0.0", digest: "b".repeat(64), packageVisibility: "public" },
    ],
  });
  await insertPublishedSkill(pool, "skill-alpha", randomUUID(), "1.0.0", "a".repeat(64), ownerId);
  await insertPublishedSkill(pool, "skill-beta", randomUUID(), "2.0.0", "b".repeat(64), ownerId);
  const sourceRevision = await architectureStore.createRevision({
    actor: ownerId,
    architectureId: sourceArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial source revision",
    spec: sourceSpec,
  });
  assert.ok(sourceRevision);
  const migrationStore = new PostgresPatternMigrationStore(db, {
    ...(options.failBeforeLineage ? { beforeLineageInsert: () => { throw new Error("late failure"); } } : {}),
    ...(options.failBeforeAudit ? { beforeAuditInsert: () => { throw new Error("audit failure"); } } : {}),
  });
  const generated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0], targetArchitectureIds[1], targetRevisionIds[1], lineageIds[1]];
  const service = new ArchitecturePatternMigrationService(architectureStore, migrationStore, {
    idFactory: () => generated.shift() ?? targetArchitectureIds[5],
    releaseAuthorizer: { authorize: async () => true },
  });
  return { pool, db, architectureStore, migrationStore, service, sourceArchitecture, sourceRevision, ownerId };
}

async function createTeamFixture(t: TestContext): Promise<Fixture> {
  const fixture = await createFixture(t);
  await insertUser(fixture.pool, teamOwnerId, "pattern-team-owner@example.com");
  await insertUser(fixture.pool, teamMemberId, "pattern-team-member@example.com");
  await insertOrganization(fixture.pool);
  await fixture.pool.query(
    "INSERT INTO teams (id, name, slug, created_by_user_id, organization_id) VALUES ($1, 'Pattern team', 'pattern-team', $2, $3)",
    [teamId, teamOwnerId, organizationId],
  );
  await fixture.pool.query(
    "INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    [teamId, teamOwnerId, teamMemberId],
  );
  await fixture.pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    [organizationId, teamOwnerId, teamMemberId],
  );
  const teamArchitecture = await fixture.architectureStore.createArchitecture({
    actor: teamOwnerId,
    owner: { type: "team", id: teamId },
    name: "Team source architecture",
    description: "Team source description",
    patternId: "flat",
  });
  const sourceSpec = createFlatArchitecture({
    id: teamArchitecture.id,
    name: teamArchitecture.name,
    description: teamArchitecture.description,
    skills: [{ id: "skill-team", slug: "skill-team", title: "Team", version: "1.0.0", digest: "c".repeat(64), packageVisibility: "public" }],
  });
  await insertPublishedSkill(fixture.pool, "skill-team", randomUUID(), "1.0.0", "c".repeat(64), teamOwnerId);
  const sourceRevision = await fixture.architectureStore.createRevision({
    actor: teamOwnerId,
    architectureId: teamArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial team source revision",
    spec: sourceSpec,
  });
  assert.ok(sourceRevision);
  fixture.service = new ArchitecturePatternMigrationService(fixture.architectureStore, fixture.migrationStore, {
    idFactory: (() => {
      const generated = [targetArchitectureIds[0], targetRevisionIds[0], lineageIds[0]];
      return () => generated.shift() ?? targetArchitectureIds[5];
    })(),
    releaseAuthorizer: { authorize: async () => true },
  });
  fixture.sourceArchitecture = teamArchitecture;
  fixture.sourceRevision = sourceRevision;
  fixture.ownerId = teamOwnerId;
  return fixture;
}

async function createOrganizationFixture(t: TestContext): Promise<Fixture> {
  const fixture = await createFixture(t);
  await insertOrganization(fixture.pool, ownerId);
  await fixture.pool.query(
    "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    [organizationId, ownerId],
  );
  await fixture.pool.query(
    "INSERT INTO instance_settings (key, value) VALUES ('sharing', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    })],
  );
  await insertPublishedSkill(fixture.pool, "organization-migration-skill", randomUUID(), "1.0.0", "d".repeat(64), ownerId, "organization");

  const architecture = await fixture.architectureStore.createArchitecture({
    actor: ownerId,
    owner: { type: "user", id: ownerId },
    name: "Organization source architecture",
    description: "Organization source description",
    patternId: "flat",
  });
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    description: architecture.description,
    skills: [{
      id: "organization-migration-skill",
      slug: "organization-migration-skill",
      title: "Organization migration skill",
      version: "1.0.0",
      digest: "d".repeat(64),
      packageVisibility: "organization",
    }],
  });
  await fixture.pool.query(
    "INSERT INTO skill_architecture_organization_grants (architecture_id, organization_id, access_level, created_by_user_id, created_under_policy_revision_id) VALUES ($1, $2, 'read', $3, $4)",
    [architecture.id, organizationId, ownerId, organizationPolicyId],
  );
  await fixture.pool.query(
    "INSERT INTO skill_organization_grants (skill_id, organization_id, created_by_user_id, created_under_policy_revision_id) VALUES ((SELECT id FROM skills WHERE slug = $1), $2, $3, $4)",
    ["organization-migration-skill", organizationId, ownerId, organizationPolicyId],
  );
  const revision = await fixture.architectureStore.createRevision({
    actor: ownerId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Organization source revision",
    spec,
  });
  assert.ok(revision);
  const loaded = await fixture.architectureStore.getArchitecture(ownerId, architecture.id);
  assert.ok(loaded);
  assert.deepEqual(loaded.access.allowedOrganizationIds, [organizationId]);
  fixture.sourceArchitecture = loaded;
  fixture.sourceRevision = revision;
  return fixture;
}

function createInput(fixture: Fixture, overrides: Partial<ArchitecturePatternMigrationCreateInput> = {}): ArchitecturePatternMigrationCreateInput {
  return {
    actor: fixture.ownerId,
    architectureId: fixture.sourceArchitecture.id,
    expectedCurrentRevisionId: fixture.sourceRevision.id,
    targetPatternId: "multi-level-router",
    idempotencyKey: "pattern-migration-request-1",
    name: "Derived router architecture",
    description: "Derived description",
    message: "Derived from the source architecture",
    ...overrides,
  };
}

function storeInput(
  fixture: Fixture,
  persisted: NonNullable<Awaited<ReturnType<ArchitecturePatternMigrationService["create"]>>["persisted"]>,
): ArchitecturePatternMigrationCreateStoreInput {
  return {
    actorId: fixture.ownerId,
    expectedCurrentRevisionId: fixture.sourceRevision.id,
    sourceArchitecture: fixture.sourceArchitecture,
    sourceRevision: fixture.sourceRevision,
    targetArchitecture: persisted.targetArchitecture,
    targetRevision: persisted.targetRevision,
    lineage: persisted.lineage,
    audit: {
      actorUserId: fixture.ownerId,
      action: "architecture.pattern-migration.create",
      decision: "allow",
      resourceId: persisted.targetArchitecture.id,
      details: {
        sourceArchitectureId: fixture.sourceArchitecture.id,
        sourceRevisionId: fixture.sourceRevision.id,
        sourcePatternId: fixture.sourceRevision.spec.pattern.id,
        targetPatternId: persisted.targetArchitecture.patternId,
        targetArchitectureId: persisted.targetArchitecture.id,
        targetRevisionId: persisted.targetRevision.id,
        sourceRevisionDigest: persisted.lineage.sourceRevisionDigest,
        targetRevisionDigest: persisted.lineage.targetRevisionDigest,
        migrationDigest: persisted.lineage.migrationDigest,
        diffDigest: persisted.lineage.diffDigest,
        code: "create.committed",
      },
    },
    intentDigest: "a".repeat(64),
  };
}

async function insertUser(pool: ReturnType<typeof createPgPool>, id: string, email: string): Promise<void> {
  await pool.query(
    "INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())",
    [id, email, email.split("@")[0]],
  );
}

async function insertPublishedSkill(
  pool: ReturnType<typeof createPgPool>,
  slug: string,
  skillId: string,
  version: string,
  digest: string,
  ownerUserId: string,
  visibility: "public" | "authenticated" | "organization" | "team" | "private" | "explicit-users" = "public",
): Promise<void> {
  const versionId = randomUUID();
  const artifactId = randomUUID();
  await pool.query(
    "INSERT INTO skills (id, slug, title, summary, lifecycle_status, visibility, owner_user_id) VALUES ($1, $2, $2, $3, 'approved', $4, $5)",
    [skillId, slug, `${slug} summary`, visibility, ownerUserId],
  );
  await pool.query(
    "INSERT INTO skill_versions (id, skill_id, version, lifecycle_status, review_status, security_status, approved_artifact_sha256, published_at) VALUES ($1, $2, $3, 'approved', 'approved', 'passed', $4, now())",
    [versionId, skillId, version, digest],
  );
  await pool.query(
    "INSERT INTO skill_artifacts (id, skill_version_id, storage_key, sha256, byte_size, content_type) VALUES ($1, $2, $3, $4, 1, 'application/octet-stream')",
    [artifactId, versionId, `${slug}/${version}/artifact`, digest],
  );
}

async function insertOrganization(pool: ReturnType<typeof createPgPool>, createdByUserId = teamOwnerId): Promise<void> {
  await pool.query(
    "INSERT INTO organizations (id, name, slug, status, created_by_user_id) VALUES ($1, 'Pattern organization', 'pattern-organization', 'provisioning', $2)",
    [organizationId, createdByUserId],
  );
  await pool.query(
    "INSERT INTO organization_policy_revisions (id, organization_id, revision_number, schema_version, policy, policy_sha256, reason, created_by_user_id) VALUES ($1, $2, 1, 1, $3::jsonb, $4, 'Pattern fixture', $5)",
    [organizationPolicyId, organizationId, JSON.stringify(defaultOrganizationPolicyV1), organizationPolicyDigest(defaultOrganizationPolicyV1), createdByUserId],
  );
  await pool.query("UPDATE organizations SET status = 'active', current_policy_revision_id = $1 WHERE id = $2", [organizationPolicyId, organizationId]);
}

async function count(pool: ReturnType<typeof createPgPool>, table: string, column?: string, value?: string): Promise<number> {
  const safeTable = /^[a-z_]+$/.test(table) ? table : (() => { throw new Error("unsafe table"); })();
  if (!column) return Number((await pool.query(`SELECT count(*)::int AS count FROM ${safeTable}`)).rows[0].count);
  if (!/^[a-z_]+$/.test(column)) throw new Error("unsafe column");
  return Number((await pool.query(`SELECT count(*)::int AS count FROM ${safeTable} WHERE ${column} = $1`, [value])).rows[0].count);
}

async function applyMigrationsThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const contents = readFileSync(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(contents);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

function assertSafeTestDatabaseUrl(value: string): void {
  const database = new URL(value).pathname.replace(/^\//, "");
  assert.ok(/test|ci/i.test(database), "Postgres pattern migration tests require a disposable test or ci database.");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
