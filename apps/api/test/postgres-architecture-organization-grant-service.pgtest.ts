import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { createDb, createPgPool, type Database } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  auditEvents,
  instanceSettings,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillArchitectureRevisions,
  skillArchitectures,
  skillArtifacts,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../src/db/schema.js";
import { PostgresArchitectureOrganizationGrantStore } from "../src/architectures/postgres-organization-grant-store.js";
import { MemoryArchitectureOrganizationGrantStore } from "../src/architectures/memory-organization-grant-store.js";
import type { ArchitectureOrganizationGrantPolicySnapshot } from "../src/architectures/organization-grant-policy.js";
import { ArchitectureOrganizationGrantService } from "../src/architectures/organization-grant-service.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const architectureId = "33333333-3333-4333-8333-333333333333";
const firstOrganizationId = "44444444-4444-4444-8444-444444444444";
const secondOrganizationId = "55555555-5555-4555-8555-555555555555";
const firstPolicyId = "66666666-6666-4666-8666-666666666666";
const secondPolicyId = "77777777-7777-4777-8777-777777777777";
const firstRevisionId = "88888888-8888-4888-8888-888888888888";
const secondRevisionId = "99999999-9999-4999-8999-999999999999";
const skillId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const skillVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const artifactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const teamId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const releaseDigest = "a".repeat(64);

const enabledSharing = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: true,
};

test("Postgres architecture grants replace atomically, recheck exact releases, and allow disabled-gate revocation", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  const first = grantInput(firstOrganizationId, firstPolicyId);
  const created = await fixture.service.replaceOrganizationGrants({
    actor: ownerId,
    architectureId,
    expectedCurrentRevisionId: firstRevisionId,
    organizationIds: [firstOrganizationId],
  });
  assert.equal(created.changed, true);
  assert.deepEqual(created.addedOrganizationIds, [firstOrganizationId]);
  assert.deepEqual(created.removedOrganizationIds, []);
  assert.equal(created.grants[0]?.createdByUserId, ownerId);
  assert.equal(created.grants[0]?.createdUnderPolicyRevisionId, firstPolicyId);

  const createdAt = created.grants[0]?.createdAt;
  const retry = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [{ ...first, createdByUserId: memberId, createdAt: "2000-01-01T00:00:00.000Z" }],
  });
  assert.equal(retry.changed, false);
  assert.equal(retry.grants[0]?.createdAt, createdAt);

  await fixture.db
    .update(instanceSettings)
    .set({ value: { ...enabledSharing, organizationVisibilityEnabled: false }, updatedAt: new Date() })
    .where(eq(instanceSettings.key, "sharing"));
  await fixture.db
    .update(skillArchitectures)
    .set({ currentRevisionId: null, updatedAt: new Date() })
    .where(eq(skillArchitectures.id, architectureId));
  const revoked = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: null,
    grants: [],
  });
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.removedOrganizationIds, [firstOrganizationId]);
  assert.deepEqual(await fixture.grantStore.listArchitectureOrganizationGrants(architectureId), []);
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: null,
      grants: [first],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_CURRENT_REVISION_REQUIRED"),
  );
});

test("memory and Postgres grant adapters return the same policy decisions", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  const memory = new MemoryArchitectureOrganizationGrantStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  const grant = grantInput(firstOrganizationId, firstPolicyId);
  const memorySnapshot = conformanceSnapshot();

  const memoryCreated = await memory.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grant],
    authorizationSnapshot: memorySnapshot,
  });
  const postgresCreated = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grant],
  });
  assert.equal(memoryCreated.changed, postgresCreated.changed);
  assert.deepEqual(memoryCreated.addedOrganizationIds, postgresCreated.addedOrganizationIds);

  const deniedSnapshot = conformanceSnapshot({ actorMembershipRole: null });
  const memoryDenied = captureCode(memory.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grant],
    authorizationSnapshot: deniedSnapshot,
  }));
  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, firstOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  const postgresDenied = captureCode(fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grant],
  }));
  assert.equal(await memoryDenied, await postgresDenied);

  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: null, updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, firstOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  await fixture.db
    .update(instanceSettings)
    .set({ value: { ...enabledSharing, organizationVisibilityEnabled: false }, updatedAt: new Date() })
    .where(eq(instanceSettings.key, "sharing"));
  const memoryRevoked = await memory.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [],
    authorizationSnapshot: conformanceSnapshot({
      sharing: {
        organizationVisibilityEnabled: false,
        publicVisibilityEnabled: true,
        authenticatedVisibilityEnabled: true,
      },
    }),
  });
  const postgresRevoked = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [],
  });
  assert.equal(memoryRevoked.changed, postgresRevoked.changed);
  assert.deepEqual(memoryRevoked.removedOrganizationIds, postgresRevoked.removedOrganizationIds);
});

test("Postgres architecture grants reject stale policy, removed membership, and revision tokens without changing rows", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  const first = grantInput(firstOrganizationId, firstPolicyId);
  await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [first],
  });

  await insertPolicy(fixture.db, firstOrganizationId, secondPolicyId, 2, {
    ...defaultOrganizationPolicyV1,
    limits: { ...defaultOrganizationPolicyV1.limits, organizationGrantsPerArchitecture: 24 },
  });
  await fixture.db
    .update(organizations)
    .set({ currentPolicyRevisionId: secondPolicyId, updatedAt: new Date() })
    .where(eq(organizations.id, firstOrganizationId));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [first],
    }),
    (error: unknown) => codeIs(error, "ORGANIZATION_POLICY_CONFLICT"),
  );
  assert.deepEqual(
    (await fixture.grantStore.listArchitectureOrganizationGrants(architectureId)).map((grant) => grant.createdUnderPolicyRevisionId),
    [firstPolicyId],
  );

  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, firstOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(firstOrganizationId, secondPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN"),
  );

  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: null, updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, firstOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  await fixture.db.insert(skillArchitectureRevisions).values({
    id: secondRevisionId,
    architectureId,
    revisionNumber: 2,
    message: "Second current revision",
    spec: architectureSpec(),
    createdByUserId: ownerId,
  });
  await fixture.db
    .update(skillArchitectures)
    .set({ currentRevisionId: secondRevisionId, updatedAt: new Date() })
    .where(eq(skillArchitectures.id, architectureId));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(firstOrganizationId, secondPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_REVISION_CONFLICT"),
  );
  assert.equal((await fixture.grantStore.listArchitectureOrganizationGrants(architectureId)).length, 1);
});

test("Postgres architecture grants enforce limits and organization isolation before replacing rows", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t, {
    firstPolicy: {
      ...defaultOrganizationPolicyV1,
      limits: { ...defaultOrganizationPolicyV1.limits, organizationGrantsPerArchitecture: 1 },
    },
    includeSecondOrganization: true,
  });
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [
        grantInput(firstOrganizationId, firstPolicyId),
        grantInput(secondOrganizationId, secondPolicyId),
      ],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED"),
  );
  assert.deepEqual(await fixture.grantStore.listArchitectureOrganizationGrants(architectureId), []);

  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, secondOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(secondOrganizationId, secondPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN"),
  );
  assert.deepEqual(await fixture.grantStore.listArchitectureOrganizationGrants(architectureId), []);

  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [{ ...grantInput(firstOrganizationId, secondPolicyId), accessLevel: "write" as "read" }],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_INVALID"),
  );
  assert.deepEqual(await fixture.grantStore.listArchitectureOrganizationGrants(architectureId), []);
});

test("Postgres architecture grants fail closed when an exact release is no longer published", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  await fixture.db
    .update(skillArtifacts)
    .set({ sha256: "b".repeat(64) })
    .where(eq(skillArtifacts.id, artifactId));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(firstOrganizationId, firstPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_RELEASE_NOT_VISIBLE"),
  );
  assert.deepEqual(await fixture.grantStore.listArchitectureOrganizationGrants(architectureId), []);

  await fixture.db
    .update(skillArtifacts)
    .set({ sha256: releaseDigest })
    .where(eq(skillArtifacts.id, artifactId));
  await fixture.db
    .update(skillVersions)
    .set({ lifecycleStatus: "revoked" })
    .where(eq(skillVersions.id, skillVersionId));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(firstOrganizationId, firstPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_RELEASE_NOT_VISIBLE"),
  );
});

test("Postgres architecture grant release checks preserve distinct reference ids for one release", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  const duplicateReleaseSpec = createFlatArchitecture({
    id: architectureId,
    name: "Architecture grants",
    skills: [
      {
        id: "architecture-grant-release-primary",
        slug: "architecture-grant-release",
        version: "1.0.0",
        digest: releaseDigest,
        packageVisibility: "public",
      },
      {
        id: "architecture-grant-release-alias",
        slug: "architecture-grant-release",
        version: "1.0.0",
        digest: releaseDigest,
        packageVisibility: "public",
      },
    ],
  });
  await fixture.db.insert(skillArchitectureRevisions).values({
    id: secondRevisionId,
    architectureId,
    revisionNumber: 2,
    message: "Distinct release references",
    spec: duplicateReleaseSpec,
    createdByUserId: ownerId,
  });
  await fixture.db
    .update(skillArchitectures)
    .set({ currentRevisionId: secondRevisionId, updatedAt: new Date() })
    .where(eq(skillArchitectures.id, architectureId));

  const result = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: secondRevisionId,
    grants: [grantInput(firstOrganizationId, firstPolicyId)],
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.grants.map((grant) => grant.organizationId), [firstOrganizationId]);
});

test("Postgres architecture grant updates serialize on the architecture lock", { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(t, { includeSecondOrganization: true });
  const first = fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grantInput(firstOrganizationId, firstPolicyId)],
  });
  const second = fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grantInput(secondOrganizationId, secondPolicyId)],
  });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.changed).sort(), [true, true]);
  const finalIds = (await fixture.grantStore.listArchitectureOrganizationGrants(architectureId))
    .map((grant) => grant.organizationId);
  assert.ok(
    deepEqualIds(finalIds, [firstOrganizationId])
    || deepEqualIds(finalIds, [secondOrganizationId]),
    `unexpected partial grant set: ${finalIds.join(",")}`,
  );
});

test("Postgres team-owned architecture grants recheck effective parent organization authority", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await createFixture(t);
  const parentPolicy = {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      teamOwnersCanShareArchitecturesToParentOrganization: true,
    },
  };
  await insertPolicy(fixture.db, firstOrganizationId, secondPolicyId, 2, parentPolicy);
  await fixture.db
    .update(organizations)
    .set({ currentPolicyRevisionId: secondPolicyId, updatedAt: new Date() })
    .where(eq(organizations.id, firstOrganizationId));
  await fixture.db.insert(teams).values({
    id: teamId,
    name: "Architecture grant team",
    slug: "architecture-grant-team",
    createdByUserId: ownerId,
    organizationId: firstOrganizationId,
  });
  await fixture.db.insert(teamMemberships).values({
    teamId,
    userId: ownerId,
    role: "owner",
  });
  await fixture.db
    .update(skillArchitectures)
    .set({ ownerUserId: null, ownerTeamId: teamId, updatedAt: new Date() })
    .where(eq(skillArchitectures.id, architectureId));

  const granted = await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grantInput(firstOrganizationId, secondPolicyId)],
  });
  assert.deepEqual(granted.grants.map((grant) => grant.organizationId), [firstOrganizationId]);

  await fixture.db
    .update(organizationMemberships)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(organizationMemberships.organizationId, firstOrganizationId),
      eq(organizationMemberships.userId, ownerId),
    ));
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [],
    }),
    // Losing the parent organization membership removes effective team-owner
    // management authority. The adapter intentionally reports the generic
    // manager denial instead of disclosing the hidden parent boundary state.
    (error: unknown) => codeIs(error, "ARCHITECTURE_GRANT_MANAGE_REQUIRED"),
  );
});

test("Postgres architecture grant transaction rolls back deletes and keeps audit details bounded", { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(t, { includeSecondOrganization: true });
  await fixture.grantStore.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId: ownerId,
    expectedCurrentRevisionId: firstRevisionId,
    grants: [grantInput(firstOrganizationId, firstPolicyId)],
  });

  await fixture.pool.query(`
    CREATE FUNCTION reject_architecture_grant_insert() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'test grant insert failure' USING ERRCODE = 'P0001';
    END;
    $$;
    CREATE TRIGGER reject_architecture_grant_insert
    BEFORE INSERT ON skill_architecture_organization_grants
    FOR EACH ROW EXECUTE FUNCTION reject_architecture_grant_insert();
  `);
  await assert.rejects(
    fixture.grantStore.replaceArchitectureOrganizationGrants({
      architectureId,
      actorUserId: ownerId,
      expectedCurrentRevisionId: firstRevisionId,
      grants: [grantInput(secondOrganizationId, secondPolicyId)],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_PERSISTENCE_FAILED"),
  );
  assert.deepEqual(
    (await fixture.grantStore.listArchitectureOrganizationGrants(architectureId)).map((grant) => grant.organizationId),
    [firstOrganizationId],
  );

  const events = await fixture.db
    .select({ details: auditEvents.details })
    .from(auditEvents)
    .where(eq(auditEvents.action, "architecture.organization-grants.replace"));
  assert.ok(events.length >= 1);
  const details = JSON.stringify(events[0]?.details);
  assert.equal(details.includes(releaseDigest), false);
  assert.equal(details.includes("package"), false);
  assert.equal(details.includes(firstOrganizationId), true);
});

test("Postgres allow-audit failure rolls back the grant replacement", { timeout: 60_000 }, async (t) => {
  const fixture = await createFixture(t, { includeSecondOrganization: true });
  await fixture.service.replaceOrganizationGrants({
    actor: ownerId,
    architectureId,
    expectedCurrentRevisionId: firstRevisionId,
    organizationIds: [firstOrganizationId],
  });

  await fixture.pool.query(`
    CREATE FUNCTION reject_architecture_grant_allow_audit() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'architecture.organization-grants.replace'
        AND NEW.decision = 'allow'
        AND NEW.details ? 'changed' THEN
        RAISE EXCEPTION 'test grant allow audit failure' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_architecture_grant_allow_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_architecture_grant_allow_audit();
  `);

  await assert.rejects(
    fixture.service.replaceOrganizationGrants({
      actor: ownerId,
      architectureId,
      expectedCurrentRevisionId: firstRevisionId,
      organizationIds: [secondOrganizationId],
    }),
    (error: unknown) => codeIs(error, "ARCHITECTURE_ORGANIZATION_GRANT_PERSISTENCE_FAILED"),
  );
  assert.deepEqual(
    (await fixture.grantStore.listArchitectureOrganizationGrants(architectureId))
      .map((grant) => grant.organizationId),
    [firstOrganizationId],
  );
  const denialAudit = await fixture.pool.query<{ code: string | null }>(`
    SELECT details->>'code' AS code
    FROM audit_events
    WHERE action = 'architecture.organization-grants.replace'
      AND resource_id = $1
      AND details ? 'code'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `, [architectureId]);
  assert.equal(denialAudit.rows[0]?.code, "ARCHITECTURE_ORGANIZATION_GRANT_PERSISTENCE_FAILED");
});

async function createFixture(
  t: TestContext,
  options: { firstPolicy?: OrganizationPolicyV1; includeSecondOrganization?: boolean } = {},
) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for architecture grant tests.");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);

  await insertUser(db, ownerId, "architecture-grant-owner@example.com");
  await insertUser(db, memberId, "architecture-grant-member@example.com");
  await insertOrganization(db, firstOrganizationId, "First Grant Organization", "first-grant-organization", firstPolicyId, options.firstPolicy);
  if (options.includeSecondOrganization) {
    await insertOrganization(db, secondOrganizationId, "Second Grant Organization", "second-grant-organization", secondPolicyId);
    await db.insert(organizationMemberships).values({ organizationId: secondOrganizationId, userId: ownerId, role: "owner" });
  }
  await db.insert(organizationMemberships).values({ organizationId: firstOrganizationId, userId: ownerId, role: "owner" });
  await setSharing(db, enabledSharing);
  await insertReleasedSkill(db);
  await insertArchitecture(db);

  const grantStore = new PostgresArchitectureOrganizationGrantStore(db, {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  const service = new ArchitectureOrganizationGrantService({
    architectureStore: new PostgresArchitectureStore(db),
    organizationStore: new PostgresOrganizationStore(db),
    grantStore,
    organizationVisibilityEnabled: true,
    releaseAuthorizer: async ({ release }) => ({
      allowed: true,
      release: {
        id: release.id,
        slug: release.slug,
        version: release.version,
        digest: release.digest,
        packageVisibility: release.packageVisibility,
      },
    }),
  });
  return { pool, db, grantStore, service };
}

async function insertUser(db: Database, id: string, email: string): Promise<void> {
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email,
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
}

async function insertOrganization(
  db: Database,
  id: string,
  name: string,
  slug: string,
  policyId: string,
  policy: OrganizationPolicyV1 = defaultOrganizationPolicyV1,
): Promise<void> {
  await db.insert(organizations).values({ id, name, slug, createdByUserId: ownerId });
  await insertPolicy(db, id, policyId, 1, policy);
  await db
    .update(organizations)
    .set({ status: "active", currentPolicyRevisionId: policyId, updatedAt: new Date() })
    .where(eq(organizations.id, id));
}

async function insertPolicy(
  db: Database,
  organizationId: string,
  id: string,
  revisionNumber: number,
  policy: OrganizationPolicyV1,
): Promise<void> {
  await db.insert(organizationPolicyRevisions).values({
    id,
    organizationId,
    revisionNumber,
    schemaVersion: 1,
    policy,
    policySha256: organizationPolicyDigest(policy),
    createdByUserId: ownerId,
  });
}

async function insertReleasedSkill(db: Database): Promise<void> {
  await db.insert(skills).values({
    id: skillId,
    slug: "architecture-grant-release",
    title: "Architecture grant release",
    summary: "Public release used by architecture grant tests.",
    lifecycleStatus: "approved",
    visibility: "public",
    ownerUserId: ownerId,
  });
  await db.insert(skillVersions).values({
    id: skillVersionId,
    skillId,
    version: "1.0.0",
    lifecycleStatus: "approved",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: new Date("2026-08-29T00:00:00.000Z"),
  });
  await db.insert(skillArtifacts).values({
    id: artifactId,
    skillVersionId,
    storageKey: "tests/architecture-grant-release.json",
    sha256: releaseDigest,
    byteSize: 10,
    contentType: "application/json",
    payload: { files: [] },
  });
}

async function insertArchitecture(db: Database): Promise<void> {
  await db.insert(skillArchitectures).values({
    id: architectureId,
    ownerUserId: ownerId,
    name: "Architecture grants",
    description: "Architecture grant test fixture.",
    patternId: "flat",
  });
  await db.insert(skillArchitectureRevisions).values({
    id: firstRevisionId,
    architectureId,
    revisionNumber: 1,
    message: "Initial revision",
    spec: architectureSpec(),
    createdByUserId: ownerId,
  });
  await db
    .update(skillArchitectures)
    .set({ currentRevisionId: firstRevisionId, updatedAt: new Date() })
    .where(eq(skillArchitectures.id, architectureId));
}

function architectureSpec() {
  return createFlatArchitecture({
    id: architectureId,
    name: "Architecture grants",
    skills: [{
      id: "architecture-grant-release",
      slug: "architecture-grant-release",
      version: "1.0.0",
      digest: releaseDigest,
      packageVisibility: "public",
    }],
  });
}

function grantInput(organizationId: string, policyId: string) {
  return {
    organizationId,
    accessLevel: "read" as const,
    createdUnderPolicyRevisionId: policyId,
  };
}

async function setSharing(db: Database, value: typeof enabledSharing): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: "sharing", value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

function conformanceSnapshot(
  overrides: {
    actorMembershipRole?: "owner" | "admin" | "member" | null;
    sharing?: ArchitectureOrganizationGrantPolicySnapshot["sharing"];
  } = {},
): ArchitectureOrganizationGrantPolicySnapshot {
  const policy = defaultOrganizationPolicyV1;
  const actorMembershipRole = Object.prototype.hasOwnProperty.call(overrides, "actorMembershipRole")
    ? overrides.actorMembershipRole ?? null
    : "owner";
  return {
    architectureId,
    actorUserId: ownerId,
    owner: { type: "user", id: ownerId },
    actorCanManage: true,
    currentRevisionId: firstRevisionId,
    currentRevision: {
      id: firstRevisionId,
      architectureId,
      spec: architectureSpec(),
    },
    sharing: overrides.sharing ?? enabledSharing,
    teamParent: { organizationId: null, teamExists: true },
    organizations: [{
      organizationId: firstOrganizationId,
      status: "active",
      currentPolicyRevisionId: firstPolicyId,
      currentPolicy: {
        id: firstPolicyId,
        organizationId: firstOrganizationId,
        policy,
        policySha256: organizationPolicyDigest(policy),
      },
      actorMembershipRole,
    }],
    releaseChecks: [{
      organizationId: firstOrganizationId,
      skill: {
        id: "architecture-grant-release",
        slug: "architecture-grant-release",
        version: "1.0.0",
        digest: releaseDigest,
        packageVisibility: "public",
      },
      allowed: true,
      identityMatches: true,
    }],
  };
}

async function captureCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "allowed";
  } catch (error) {
    return error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
  }
}

function codeIs(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function deepEqualIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
