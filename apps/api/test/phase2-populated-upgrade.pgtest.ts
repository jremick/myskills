import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultOrganizationPolicyV1, organizationPolicyDigest } from "@myskills-app/core";
import { createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const teamId = "33333333-3333-4333-8333-333333333333";
const skillId = "44444444-4444-4444-8444-444444444444";
const versionId = "55555555-5555-4555-8555-555555555555";
const artifactId = "66666666-6666-4666-8666-666666666666";
const architectureId = "77777777-7777-4777-8777-777777777777";
const revisionId = "88888888-8888-4888-8888-888888888888";
const teamArchitectureId = "99999999-9999-4999-8999-999999999999";
const teamRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const organizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const policyRevisionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const observationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const runId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const stepId = "12121212-1212-4121-8121-121212121212";
const leaseId = "13131313-1313-4131-8131-131313131313";
const baselineId = "14141414-1414-4141-8141-141414141414";
const receiptId = "15151515-1515-4151-8151-151515151515";
const recoveryEvidenceId = "16161616-1616-4161-8161-161616161616";
const lineageId = "17171717-1717-4171-8171-171717171717";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);
const migrationIds = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => file.replace(/\.sql$/, ""));

test("populated legacy state upgrades through 0015-0020 and runner replay is a no-op", {
  timeout: 60_000,
  skip: !databaseUrl,
}, async (t: TestContext) => {
  const pool = await freshPool(t);
  await applyThrough(pool, "0014_artifact_write_recovery");
  await insertLegacyState(pool);

  const legacyBefore = await readLegacyState(pool);

  await applyMigration(pool, "0015_skill_architectures");
  await insertArchitecture(pool, architectureId, revisionId, ownerId, "flat", "Legacy architecture");
  await applyMigration(pool, "0016_architecture_owner_tenancy");
  await insertArchitecture(pool, teamArchitectureId, teamRevisionId, null, "domain-router", "Team architecture", teamId);

  const architectureBeforeTenancy = await readArchitectureState(pool);
  assert.deepEqual(architectureBeforeTenancy, [
    {
      id: architectureId,
      owner_user_id: ownerId,
      owner_team_id: null,
      pattern_id: "flat",
      current_revision_id: revisionId,
      access_policy_version: 1,
    },
    {
      id: teamArchitectureId,
      owner_user_id: null,
      owner_team_id: teamId,
      pattern_id: "domain-router",
      current_revision_id: teamRevisionId,
      access_policy_version: 1,
    },
  ]);

  await applyMigration(pool, "0017_organizations_and_org_sharing");
  await insertOrganizationState(pool);
  await applyMigration(pool, "0018_architecture_targets_and_observations");
  await insertTargetState(pool);

  const targetBeforeSync = await readTargetState(pool);
  assert.deepEqual(targetBeforeSync, {
    id: targetId,
    architecture_id: architectureId,
    owner_user_id: ownerId,
    owner_team_id: null,
    owner_organization_id: null,
    environment_id: "personal-mac",
    profile_id: "personal",
    generation: 1,
    status: "connected",
    consent_status: "granted",
  });

  await applyMigration(pool, "0019_architecture_sync_control");
  await insertSyncState(pool);
  const currentBeforeHardening = await readCurrentPointers(pool);

  await applyMigration(pool, "0020_architecture_pattern_migrations");
  await insertLineage(pool);

  const populatedBeforeReplay = await readPopulatedState(pool);
  await runMigrations(pool);
  await runMigrations(pool);
  const populatedAfterReplay = await readPopulatedState(pool);

  assert.deepEqual(await readLegacyState(pool), legacyBefore, "pre-0015 records must survive the cumulative upgrade");
  assert.deepEqual(await readCurrentPointers(pool), currentBeforeHardening, "current pointers must survive 0019 and replay");
  assert.deepEqual(populatedAfterReplay, populatedBeforeReplay, "replaying applied migrations must not change populated rows");

  const applied = (await pool.query(
    "SELECT id FROM schema_migrations ORDER BY id",
  )).rows.map((row) => row.id as string);
  assert.deepEqual(applied, migrationIds, "runner must record every migration exactly once");

  const counts = (await pool.query(`
    SELECT
      (SELECT count(*)::int FROM skills) AS skills,
      (SELECT count(*)::int FROM skill_versions) AS skill_versions,
      (SELECT count(*)::int FROM skill_artifacts) AS skill_artifacts,
      (SELECT count(*)::int FROM teams) AS teams,
      (SELECT count(*)::int FROM skill_architectures) AS architectures,
      (SELECT count(*)::int FROM skill_architecture_revisions) AS revisions,
      (SELECT count(*)::int FROM organizations) AS organizations,
      (SELECT count(*)::int FROM organization_policy_revisions) AS policies,
      (SELECT count(*)::int FROM skill_architecture_targets) AS targets,
      (SELECT count(*)::int FROM skill_architecture_observations) AS observations,
      (SELECT count(*)::int FROM skill_architecture_sync_runs) AS sync_runs,
      (SELECT count(*)::int FROM skill_architecture_pattern_migrations) AS pattern_migrations
  `)).rows[0];
  assert.deepEqual(counts, {
    skills: 1,
    skill_versions: 1,
    skill_artifacts: 1,
    teams: 1,
    architectures: 2,
    revisions: 2,
    organizations: 1,
    policies: 1,
    targets: 1,
    observations: 1,
    sync_runs: 1,
    pattern_migrations: 1,
  });
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for populated upgrade tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  return pool;
}

async function applyThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const id of migrationIds) {
    await applyMigration(pool, id);
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const sql = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function insertLegacyState(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, 'upgrade-owner@example.com', 'upgrade-owner@example.com', 'Upgrade owner', 'active', now()),
            ($2, 'upgrade-member@example.com', 'upgrade-member@example.com', 'Upgrade member', 'active', now())`,
    [ownerId, memberId],
  );
  await pool.query(
    `INSERT INTO skills (id, slug, title, summary, lifecycle_status, visibility, owner_user_id)
     VALUES ($1, 'legacy-upgrade-skill', 'Legacy upgrade skill', 'A populated pre-0015 skill.', 'approved', 'team', $2)`,
    [skillId, ownerId],
  );
  await pool.query(
    `INSERT INTO skill_versions (
       id, skill_id, version, release_notes, review_status, security_status,
       published_at, lifecycle_status, lifecycle_reason, lifecycle_updated_at, approved_artifact_sha256
     ) VALUES ($1, $2, '1.0.0', 'Legacy release', 'approved', 'passed', now(), 'approved', '', now(), $3)`,
    [versionId, skillId, digestA],
  );
  await pool.query(
    `INSERT INTO skill_artifacts (id, skill_version_id, storage_key, sha256, byte_size, content_type, payload)
     VALUES ($1, $2, 'legacy-upgrade-skill/1.0.0/package.json', $3, 42, 'application/json', '{"files":[]}'::jsonb)`,
    [artifactId, versionId, digestA],
  );
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id)
     VALUES ($1, 'Legacy upgrade team', 'legacy-upgrade-team', $2)`,
    [teamId, ownerId],
  );
  await pool.query(
    `INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [teamId, ownerId, memberId],
  );
  await pool.query(
    "INSERT INTO skill_team_grants (skill_id, team_id) VALUES ($1, $2)",
    [skillId, teamId],
  );
}

async function insertArchitecture(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  revisionIdForArchitecture: string,
  ownerUserId: string | null,
  patternId: string,
  name: string,
  ownerTeamId?: string,
): Promise<void> {
  if (ownerTeamId === undefined) {
    await pool.query(
      `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
       VALUES ($1, $2, $3, 'Cumulative upgrade fixture', $4)`,
      [id, ownerUserId, name, patternId],
    );
  } else {
    await pool.query(
      `INSERT INTO skill_architectures (
         id, owner_user_id, name, description, pattern_id, owner_team_id
       ) VALUES ($1, $2, $3, 'Cumulative upgrade fixture', $4, $5)`,
      [id, ownerUserId, name, patternId, ownerTeamId],
    );
  }
  await pool.query(
    `INSERT INTO skill_architecture_revisions (
       id, architecture_id, revision_number, message, spec, created_by_user_id
     ) VALUES ($1, $2, 1, 'Legacy revision', $3::jsonb, $4)`,
    [revisionIdForArchitecture, id, JSON.stringify({
      schemaVersion: 1,
      id,
      name,
      pattern: { id: patternId, version: 1 },
      skills: [],
      nodes: [],
      edges: [],
      entryNodeIds: [],
      profiles: [],
      environments: [],
    }), ownerUserId ?? ownerId],
  );
  await pool.query(
    "UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2",
    [revisionIdForArchitecture, id],
  );
}

async function insertOrganizationState(pool: ReturnType<typeof createPgPool>): Promise<void> {
  const policy = JSON.stringify(defaultOrganizationPolicyV1);
  await pool.query(
    `INSERT INTO organizations (id, name, slug, status, created_by_user_id)
     VALUES ($1, 'Upgrade organization', 'upgrade-organization', 'provisioning', $2)`,
    [organizationId, ownerId],
  );
  await pool.query(
    `INSERT INTO organization_policy_revisions (
       id, organization_id, revision_number, schema_version, policy, policy_sha256, reason, created_by_user_id
     ) VALUES ($1, $2, 1, 1, $3::jsonb, $4, 'Initial upgrade policy', $5)`,
    [policyRevisionId, organizationId, policy, organizationPolicyDigest(defaultOrganizationPolicyV1), ownerId],
  );
  await pool.query(
    `UPDATE organizations
        SET status = 'active', current_policy_revision_id = $1
      WHERE id = $2`,
    [policyRevisionId, organizationId],
  );
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [organizationId, ownerId, memberId],
  );
  await pool.query(
    "UPDATE teams SET organization_id = $1 WHERE id = $2",
    [organizationId, teamId],
  );
  await pool.query(
    `INSERT INTO skill_organization_grants (
       skill_id, organization_id, created_by_user_id, created_under_policy_revision_id
     ) VALUES ($1, $2, $3, $4)`,
    [skillId, organizationId, ownerId, policyRevisionId],
  );
  await pool.query(
    `INSERT INTO skill_architecture_organization_grants (
       architecture_id, organization_id, access_level, created_by_user_id, created_under_policy_revision_id
     ) VALUES ($1, $2, 'read', $3, $4)`,
    [architectureId, organizationId, ownerId, policyRevisionId],
  );
}

async function insertTargetState(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_targets (
       id, architecture_id, owner_user_id, name, adapter_kind, adapter_contract_version,
       adapter_version, environment_id, profile_id, status, consent_status,
       consent_granted_at, capabilities, capabilities_digest, identity_digest,
       generation, metadata, health_summary, created_by_user_id
     ) VALUES (
       $1, $2, $3, 'Legacy target', 'codex', 1, '1.0.0', 'personal-mac', 'personal',
       'connected', 'granted', now(), '{"inventory.read":true}'::jsonb, $4, $5, 1,
       '{"provider":"upgrade-fixture"}'::jsonb, '{"status":"healthy"}'::jsonb, $3
     )`,
    [targetId, architectureId, ownerId, digestA, digestB],
  );
  await pool.query(
    `INSERT INTO skill_architecture_observations (
       id, target_id, generation, adapter_kind, adapter_contract_version, adapter_version,
       adapter_digest, capabilities_digest, observed_digest, observed_state, counts, health_summary
     ) VALUES ($1, $2, 1, 'codex', 1, '1.0.0', $3, $4, $5,
       '{"nodes":0}'::jsonb, '{"nodes":0}'::jsonb, '{"status":"healthy"}'::jsonb)`,
    [observationId, targetId, digestA, digestB, digestC],
  );
}

async function insertSyncState(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_sync_runs (
       id, architecture_id, revision_id, target_id, target_generation, observed_snapshot_id,
       profile_id, environment_id, actor_user_id, run_kind, status, request_key, idempotency_key,
       desired_digest, compiled_digest, observed_digest, plan_digest
     ) VALUES ($1, $2, $3, $4, 1, $5, 'personal', 'personal-mac', $6, 'sync', 'drafted',
       'upgrade-request', 'upgrade-idempotency', $7, $8, $9, $10)`,
    [runId, architectureId, revisionId, targetId, observationId, ownerId, digestA, digestB, digestC, digestD],
  );
  await pool.query(
    `INSERT INTO skill_architecture_sync_steps (
       id, run_id, ordinal, action, node_id, target_generation, status, idempotency_key,
       desired_digest, compiled_digest, observed_digest, plan_digest, step_digest
     ) VALUES ($1, $2, 1, 'noop', 'root', 1, 'planned', 'upgrade-step', $3, $4, $5, $6, $7)`,
    [stepId, runId, digestA, digestB, digestC, digestD, digestA],
  );
  await pool.query(
    `INSERT INTO skill_architecture_sync_target_leases (
       id, target_id, run_id, target_generation, holder_id, fencing_token, status, expires_at
     ) VALUES ($1, $2, $3, 1, 'upgrade-holder', 1, 'active', now() + interval '1 hour')`,
    [leaseId, targetId, runId],
  );
  await pool.query(
    `INSERT INTO skill_architecture_sync_baselines (
       id, run_id, target_id, target_generation, observed_digest, baseline_digest, restorable
     ) VALUES ($1, $2, $3, 1, $4, $5, true)`,
    [baselineId, runId, targetId, digestC, digestD],
  );
  await pool.query(
    `INSERT INTO skill_architecture_sync_receipts (
       id, run_id, target_id, target_generation, kind, status, code, evidence_digest
     ) VALUES ($1, $2, $3, 1, 'run', 'accepted', 'upgrade-accepted', $4)`,
    [receiptId, runId, targetId, digestA],
  );
  await pool.query(
    `INSERT INTO skill_architecture_sync_recovery_evidence (
       id, run_id, target_id, target_generation, fencing_token, condition, decision,
       next_run_state, safe_to_retry, requires_manual_review, code, evidence_digest
     ) VALUES ($1, $2, $3, 1, 1, 'no-mutation', 'retry', 'queued', true, false, 'recovery.retry', $4)`,
    [recoveryEvidenceId, runId, targetId, digestB],
  );
}

async function insertLineage(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_pattern_migrations (
       id, source_architecture_id, source_revision_id, source_pattern_id, source_revision_digest,
       target_architecture_id, target_revision_id, target_pattern_id, target_revision_digest,
       mapping_status, mapping, diff, migration_digest, diff_digest, actor_user_id, idempotency_key
     ) VALUES ($1, $2, $3, 'flat', $4, $5, $6, 'domain-router', $7,
       'fallback', '{}'::jsonb, '{"addedEdgeCount":1,"removedEdgeCount":0,"rewrittenBindingCount":0}'::jsonb,
       $8, $9, $10, 'upgrade-lineage')`,
    [lineageId, architectureId, revisionId, digestA, teamArchitectureId, teamRevisionId, digestB, digestC, digestD, ownerId],
  );
}

async function readLegacyState(pool: ReturnType<typeof createPgPool>): Promise<unknown> {
  return {
    users: (await pool.query(
      "SELECT id, email, normalized_email, name, status FROM users WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[ownerId, memberId]],
    )).rows,
    skills: (await pool.query(
      "SELECT id, slug, title, summary, lifecycle_status, visibility, owner_user_id FROM skills WHERE id = $1",
      [skillId],
    )).rows,
    versions: (await pool.query(
      "SELECT id, skill_id, version, review_status, security_status, lifecycle_status, approved_artifact_sha256 FROM skill_versions WHERE id = $1",
      [versionId],
    )).rows,
    artifacts: (await pool.query(
      "SELECT id, skill_version_id, storage_key, sha256, byte_size, content_type FROM skill_artifacts WHERE id = $1",
      [artifactId],
    )).rows,
    teams: (await pool.query(
      "SELECT id, name, slug, created_by_user_id FROM teams WHERE id = $1",
      [teamId],
    )).rows,
    memberships: (await pool.query(
      "SELECT team_id, user_id, role FROM team_memberships WHERE team_id = $1 ORDER BY user_id",
      [teamId],
    )).rows,
    grants: (await pool.query(
      "SELECT skill_id, team_id FROM skill_team_grants WHERE skill_id = $1 AND team_id = $2",
      [skillId, teamId],
    )).rows,
  };
}

async function readArchitectureState(pool: ReturnType<typeof createPgPool>): Promise<unknown[]> {
  return (await pool.query(
    `SELECT id, owner_user_id, owner_team_id, pattern_id, current_revision_id, access_policy_version
       FROM skill_architectures
      WHERE id = ANY($1::uuid[])
      ORDER BY id`,
    [[architectureId, teamArchitectureId]],
  )).rows;
}

async function readTargetState(pool: ReturnType<typeof createPgPool>): Promise<unknown> {
  return (await pool.query(
    `SELECT id, architecture_id, owner_user_id, owner_team_id, owner_organization_id,
            environment_id, profile_id, generation, status, consent_status
       FROM skill_architecture_targets WHERE id = $1`,
    [targetId],
  )).rows[0];
}

async function readCurrentPointers(pool: ReturnType<typeof createPgPool>): Promise<unknown> {
  return {
    architectures: await readArchitectureState(pool),
    organization: (await pool.query(
      "SELECT id, status, current_policy_revision_id FROM organizations WHERE id = $1",
      [organizationId],
    )).rows[0],
    sync: (await pool.query(
      "SELECT architecture_id, revision_id, target_id, target_generation, observed_snapshot_id FROM skill_architecture_sync_runs WHERE id = $1",
      [runId],
    )).rows[0],
  };
}

async function readPopulatedState(pool: ReturnType<typeof createPgPool>): Promise<unknown> {
  return {
    legacy: await readLegacyState(pool),
    architectures: await readArchitectureState(pool),
    target: await readTargetState(pool),
    pointers: await readCurrentPointers(pool),
    counts: (await pool.query(`
      SELECT
        (SELECT count(*)::int FROM organization_memberships) AS organization_memberships,
        (SELECT count(*)::int FROM skill_organization_grants) AS skill_organization_grants,
        (SELECT count(*)::int FROM skill_architecture_organization_grants) AS architecture_organization_grants,
        (SELECT count(*)::int FROM skill_architecture_observations) AS observations,
        (SELECT count(*)::int FROM skill_architecture_sync_steps) AS sync_steps,
        (SELECT count(*)::int FROM skill_architecture_sync_target_leases) AS leases,
        (SELECT count(*)::int FROM skill_architecture_sync_baselines) AS baselines,
        (SELECT count(*)::int FROM skill_architecture_sync_receipts) AS receipts,
        (SELECT count(*)::int FROM skill_architecture_sync_recovery_evidence) AS recovery_evidence,
        (SELECT count(*)::int FROM skill_architecture_pattern_migrations) AS pattern_migrations
    `)).rows[0],
  };
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(
    databaseName,
    /(^|[_-])(test|ci)([_-]|$)/i,
    "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.",
  );
}
