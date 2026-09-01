import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createDb, createPgPool } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const organizationId = "44444444-4444-4444-8444-444444444444";
const architectureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userTargetId = "55555555-5555-4555-8555-555555555555";
const teamTargetId = "66666666-6666-4666-8666-666666666666";
const organizationTargetId = "77777777-7777-4777-8777-777777777777";
const observationOneId = "88888888-8888-4888-8888-888888888888";
const observationTwoId = "99999999-9999-4999-8999-999999999999";

test("migration 0018 persists connected targets with explicit exclusive owners", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-owner@example.com");
  await insertUser(pool, memberId, "target-member@example.com");
  await insertArchitecture(pool);
  await pool.query(
    "INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [teamId, "Target team", "target-team", ownerId],
  );
  await pool.query(
    "INSERT INTO organizations (id, name, slug, created_by_user_id) VALUES ($1, $2, $3, $4)",
    [organizationId, "Target organization", "target-organization", ownerId],
  );

  await insertTarget(pool, { id: userTargetId, ownerUserId: ownerId });
  await insertTarget(pool, { id: teamTargetId, ownerUserId: null, ownerTeamId: teamId });
  await insertTarget(pool, { id: organizationTargetId, ownerUserId: null, ownerOrganizationId: organizationId });

  const owners = (await pool.query(
    `SELECT id, schema_version, architecture_id, owner_user_id, owner_team_id, owner_organization_id, status, consent_status, generation
     FROM skill_architecture_targets
     ORDER BY id`,
  )).rows;
  assert.deepEqual(owners, [
    {
      id: userTargetId,
      schema_version: 1,
      architecture_id: architectureId,
      owner_user_id: ownerId,
      owner_team_id: null,
      owner_organization_id: null,
      status: "degraded",
      consent_status: "pending",
      generation: 1,
    },
    {
      id: teamTargetId,
      schema_version: 1,
      architecture_id: architectureId,
      owner_user_id: null,
      owner_team_id: teamId,
      owner_organization_id: null,
      status: "degraded",
      consent_status: "pending",
      generation: 1,
    },
    {
      id: organizationTargetId,
      schema_version: 1,
      architecture_id: architectureId,
      owner_user_id: null,
      owner_team_id: null,
      owner_organization_id: organizationId,
      status: "degraded",
      consent_status: "pending",
      generation: 1,
    },
  ]);

  await assert.rejects(
    insertTarget(pool, {
      id: "abababab-abab-4bab-8bab-abababababab",
      ownerUserId: null,
      ownerTeamId: null,
      ownerOrganizationId: null,
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_exactly_one_owner_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
      ownerTeamId: teamId,
      ownerOrganizationId: organizationId,
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_exactly_one_owner_check"),
  );

  const indexes = (await pool.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'skill_architecture_targets'`,
  )).rows.map((row) => row.indexname);
  assert.ok(indexes.includes("skill_architecture_targets_owner_user_idx"));
  assert.ok(indexes.includes("skill_architecture_targets_owner_team_idx"));
  assert.ok(indexes.includes("skill_architecture_targets_owner_organization_idx"));
  assert.ok(indexes.includes("skill_architecture_targets_architecture_binding_idx"));
});

test("target persistence rejects unsafe references and preserves logical bindings", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-safety-owner@example.com");
  await insertArchitecture(pool);

  const valid = await insertTarget(pool, {
    id: userTargetId,
    environmentId: "personal-mac",
    profileId: "personal",
    credentialReference: "keychain-target-001",
    capabilities: { "inventory.read": true, "health.read": true, apply: false, rollback: false },
    healthSummary: { status: "healthy" },
  });
  assert.equal(valid.environment_id, "personal-mac");
  assert.equal(valid.profile_id, "personal");
  assert.equal(valid.architecture_id, architectureId);
  assert.equal(valid.credential_reference, "keychain-target-001");

  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, credentialReference: "/Users/jarel/.codex" }),
    (error) => isConstraintError(error, "skill_architecture_targets_credential_reference_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, credentialReference: "https://example.invalid/secret" }),
    (error) => isConstraintError(error, "skill_architecture_targets_credential_reference_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, capabilities: { unexpected: true } }),
    (error) => isConstraintError(error, "skill_architecture_targets_capabilities_keys_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, capabilities: { "inventory.read": { enabled: true } } }),
    (error) => isConstraintError(error, "skill_architecture_targets_capabilities_boolean_values_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, capabilities: { apply: true } }),
    (error) => isConstraintError(error, "skill_architecture_targets_capabilities_mutation_disabled_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, metadata: { token: "never-store-this" } }),
    (error) => isConstraintError(error, "skill_architecture_targets_metadata_safe_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, metadata: { label: "/Users/jarel/.codex" } }),
    (error) => isConstraintError(error, "skill_architecture_targets_metadata_safe_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, healthSummary: { endpoint: "https://example.invalid" } }),
    (error) => isConstraintError(error, "skill_architecture_targets_health_summary_safe_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, healthSummary: { label: "C:\\Users\\jarel\\.codex" } }),
    (error) => isConstraintError(error, "skill_architecture_targets_health_summary_safe_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, environmentId: "/tmp/personal" }),
    (error) => isConstraintError(error, "skill_architecture_targets_environment_id_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, architectureId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    (error) => isConstraintError(error, "skill_architecture_targets_architecture_id_fkey"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, schemaVersion: 2 }),
    (error) => isConstraintError(error, "skill_architecture_targets_schema_version_check"),
  );
  await assert.rejects(
    insertTarget(pool, { id: teamTargetId, ownerTeamId: null, adapterContractVersion: 2 }),
    (error) => isConstraintError(error, "skill_architecture_targets_adapter_contract_version_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: teamTargetId,
      ownerTeamId: null,
      consentStatus: "denied",
      consentDeniedAt: null,
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_consent_denied_at_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: teamTargetId,
      ownerTeamId: null,
      consentStatus: "revoked",
      consentRevokedAt: null,
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_consent_revoked_at_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: teamTargetId,
      ownerTeamId: null,
      status: "connected",
      consentStatus: "pending",
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_connected_consent_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: teamTargetId,
      ownerTeamId: null,
      status: "revoked",
      consentStatus: "pending",
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_revoked_consent_check"),
  );
  await assert.rejects(
    insertTarget(pool, {
      id: teamTargetId,
      ownerTeamId: null,
      status: "degraded",
      consentStatus: "revoked",
      consentRevokedAt: "2026-08-30T00:00:00.000Z",
    }),
    (error) => isConstraintError(error, "skill_architecture_targets_consent_revoked_status_check"),
  );
});

test("observations are append-only and indexed for bounded latest reads", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "observation-owner@example.com");
  await insertArchitecture(pool);
  await insertTarget(pool, {
    id: userTargetId,
    status: "connected",
    consentStatus: "granted",
    consentGrantedAt: "2026-08-30T00:00:00.000Z",
    generation: 4,
  });

  await insertObservation(pool, {
    id: observationOneId,
    capturedAt: "2026-08-30T00:00:00.000Z",
    observedState: { targetId: userTargetId, environmentId: "personal-mac", nodes: [] },
  });
  await insertObservation(pool, {
    id: observationTwoId,
    capturedAt: "2026-08-30T00:01:00.000Z",
    // A bounded topology identifier is safe even when it is named "root";
    // path-like values and sensitive field names remain denied below.
    observedState: { targetId: userTargetId, environmentId: "personal-mac", nodes: [{ id: "root", kind: "router" }] },
  });

  const latest = (await pool.query(
    `SELECT id, schema_version, generation, observed_digest, captured_at
     FROM skill_architecture_observations
     WHERE target_id = $1
     ORDER BY captured_at DESC, id DESC`,
    [userTargetId],
  )).rows;
  assert.equal(latest[0]?.id, observationTwoId);
  assert.equal(latest[1]?.id, observationOneId);
  assert.equal(latest[0]?.schema_version, 1);
  assert.equal(latest[0]?.generation, 4);

  const indexes = (await pool.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'skill_architecture_observations'`,
  )).rows as Array<{ indexname: string; indexdef: string }>;
  assert.match(
    indexes.find((index) => index.indexname === "skill_architecture_observations_target_captured_idx")?.indexdef ?? "",
    /target_id.*captured_at.*id/,
  );

  await assert.rejects(
    pool.query("UPDATE skill_architecture_observations SET observed_digest = $1 WHERE id = $2", ["f".repeat(64), observationTwoId]),
    isImmutableObservationError,
  );
  await assert.rejects(
    pool.query("DELETE FROM skill_architecture_observations WHERE id = $1", [observationTwoId]),
    isImmutableObservationError,
  );
  await assert.rejects(
    pool.query("TRUNCATE skill_architecture_observations"),
    isImmutableObservationError,
  );
  await assert.rejects(
    insertObservation(pool, {
      id: "abababab-abab-4bab-8bab-abababababab",
      observedState: { targetId: userTargetId, metadata: { path: "/Users/jarel/.codex" } },
    }),
    (error) => isConstraintError(error, "skill_architecture_observations_observed_state_safe_check"),
  );
  await assert.rejects(
    insertObservation(pool, {
      id: "bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd",
      observedState: { targetId: userTargetId, metadata: { label: "ftp://example.invalid/private" } },
    }),
    (error) => isConstraintError(error, "skill_architecture_observations_observed_state_safe_check"),
  );
  await assert.rejects(
    insertObservation(pool, {
      id: "dededede-dede-4ede-8ede-dededededede",
      observedState: { targetId: userTargetId, metadata: { root: "must-not-be-retained" } },
    }),
    (error) => isConstraintError(error, "skill_architecture_observations_observed_state_safe_check"),
  );
  await assert.rejects(
    insertObservation(pool, {
      id: "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc",
      schemaVersion: 2,
    }),
    (error) => isConstraintError(error, "skill_architecture_observations_schema_version_check"),
  );
  await assert.rejects(
    insertObservation(pool, {
      id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      adapterContractVersion: 2,
    }),
    (error) => isConstraintError(error, "skill_architecture_observations_adapter_contract_version_check"),
  );
});

type TargetOverrides = Partial<{
  id: string;
  schemaVersion: number;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  ownerOrganizationId: string | null;
  architectureId: string;
  name: string;
  adapterKind: string;
  adapterContractVersion: number;
  adapterVersion: string;
  environmentId: string;
  profileId: string;
  status: "connected" | "degraded" | "revoked";
  consentStatus: "pending" | "granted" | "denied" | "revoked";
  consentRequestedAt: string | null;
  consentGrantedAt: string | null;
  consentDeniedAt: string | null;
  consentRevokedAt: string | null;
  capabilities: Record<string, unknown>;
  capabilitiesDigest: string;
  identityDigest: string;
  generation: number;
  metadata: Record<string, unknown>;
  healthSummary: Record<string, unknown>;
  credentialReference: string | null;
}>;

async function insertTarget(
  pool: ReturnType<typeof createPgPool>,
  overrides: TargetOverrides = {},
): Promise<Record<string, unknown>> {
  const input = {
    id: userTargetId,
    schemaVersion: 1,
    architectureId,
    ownerUserId: ownerId,
    ownerTeamId: null,
    ownerOrganizationId: null,
    name: "Personal Codex",
    adapterKind: "codex",
    adapterContractVersion: 1,
    adapterVersion: "1.0.0",
    environmentId: "personal",
    profileId: "profile-default",
    status: "degraded",
    consentStatus: "pending",
    consentRequestedAt: "2026-08-30T00:00:00.000Z",
    consentGrantedAt: null,
    consentDeniedAt: null,
    consentRevokedAt: null,
    capabilities: { "inventory.read": true },
    capabilitiesDigest: "a".repeat(64),
    identityDigest: "b".repeat(64),
    generation: 1,
    metadata: { provider: "test" },
    healthSummary: { status: "consent_required" },
    credentialReference: null,
    ...overrides,
  };
  const result = await pool.query(
    `INSERT INTO skill_architecture_targets (
       id, schema_version, architecture_id, owner_user_id, owner_team_id, owner_organization_id, name,
       adapter_kind, adapter_contract_version, adapter_version,
       environment_id, profile_id, status, consent_status, consent_requested_at,
       consent_granted_at, consent_denied_at, consent_revoked_at, capabilities,
       capabilities_digest, identity_digest, generation, metadata, health_summary,
       credential_reference,
       created_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19::jsonb, $20, $21, $22, $23::jsonb, $24::jsonb, $25,
       $26
     )
     RETURNING *`,
    [
      input.id,
      input.schemaVersion,
      input.architectureId,
      input.ownerUserId,
      input.ownerTeamId,
      input.ownerOrganizationId,
      input.name,
      input.adapterKind,
      input.adapterContractVersion,
      input.adapterVersion,
      input.environmentId,
      input.profileId,
      input.status,
      input.consentStatus,
      input.consentRequestedAt,
      input.consentGrantedAt,
      input.consentDeniedAt,
      input.consentRevokedAt,
      JSON.stringify(input.capabilities),
      input.capabilitiesDigest,
      input.identityDigest,
      input.generation,
      JSON.stringify(input.metadata),
      JSON.stringify(input.healthSummary),
      input.credentialReference,
      ownerId,
    ],
  );
  return result.rows[0] as Record<string, unknown>;
}

type ObservationOverrides = Partial<{
  id: string;
  schemaVersion: number;
  targetId: string;
  generation: number;
  adapterKind: string;
  adapterContractVersion: number;
  adapterVersion: string;
  adapterDigest: string;
  capabilitiesDigest: string;
  observedDigest: string;
  observedState: Record<string, unknown>;
  counts: Record<string, unknown>;
  healthSummary: Record<string, unknown>;
  capturedAt: string;
}>;

async function insertObservation(
  pool: ReturnType<typeof createPgPool>,
  overrides: ObservationOverrides = {},
): Promise<void> {
  const input = {
    id: observationOneId,
    schemaVersion: 1,
    targetId: userTargetId,
    generation: 4,
    adapterKind: "codex",
    adapterContractVersion: 1,
    adapterVersion: "1.0.0",
    adapterDigest: "d".repeat(64),
    capabilitiesDigest: "a".repeat(64),
    observedDigest: "c".repeat(64),
    observedState: { targetId: userTargetId, environmentId: "personal-mac", nodes: [] },
    counts: { nodes: 0 },
    healthSummary: { status: "healthy" },
    capturedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
  await pool.query(
    `INSERT INTO skill_architecture_observations (
       id, schema_version, target_id, generation, adapter_kind, adapter_contract_version,
       adapter_version, adapter_digest, capabilities_digest, observed_digest,
       observed_state, counts, health_summary, captured_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14)`,
    [
      input.id,
      input.schemaVersion,
      input.targetId,
      input.generation,
      input.adapterKind,
      input.adapterContractVersion,
      input.adapterVersion,
      input.adapterDigest,
      input.capabilitiesDigest,
      input.observedDigest,
      JSON.stringify(input.observedState),
      JSON.stringify(input.counts),
      JSON.stringify(input.healthSummary),
      input.capturedAt,
    ],
  );
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for architecture target migration tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0018_architecture_targets_and_observations");
  return pool;
}

async function applyMigrationsThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await applyMigration(pool, id);
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  email: string,
): Promise<void> {
  const db = createDb(pool);
  await db.insert(users).values({
    id,
    email,
    normalizedEmail: email.toLowerCase(),
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
}

async function insertArchitecture(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [architectureId, ownerId, "Target architecture", "Target migration fixture", "flat"],
  );
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isImmutableObservationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55000";
}
