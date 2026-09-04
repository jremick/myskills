import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPgPool } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("upgrade policy revisions are strict, versioned, and immutable", { timeout: 60_000 }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await resetAndMigrate(pool);
  const userId = await insertUser(pool);
  const scopeId = "10000000-0000-4000-8000-000000000001";
  const valid = {
    schemaVersion: 1,
    mode: "maintenance-window",
    includePrerelease: false,
    allowedChangeKinds: ["fix", "security"],
    pins: { "release-notes-helper": "1.2.3" },
    maintenanceWindow: { timeZone: "Australia/Melbourne", daysOfWeek: [1, 3], startMinute: 120, durationMinutes: 60 },
  };
  const inserted = await pool.query(`INSERT INTO skill_upgrade_policy_revisions
    (scope_type, scope_id, revision_number, policy, policy_sha256, created_by_user_id)
    VALUES ('target', $1, 1, $2, $3, $4) RETURNING id`, [scopeId, valid, "a".repeat(64), userId]);
  assert.equal(inserted.rowCount, 1);
  await assert.rejects(pool.query("UPDATE skill_upgrade_policy_revisions SET reason = 'changed' WHERE id = $1", [inserted.rows[0].id]), /immutable/);
  await assert.rejects(pool.query(`INSERT INTO skill_upgrade_policy_revisions
    (scope_type, scope_id, revision_number, policy, policy_sha256, created_by_user_id)
    VALUES ('target', $1, 2, $2, $3, $4)`, [scopeId, { ...valid, pins: { "../unsafe": "latest" } }, "b".repeat(64), userId]), /policy_check/);
});

test("target operation rows bind claim state and sanitized terminal receipts", { timeout: 60_000 }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await resetAndMigrate(pool);
  const userId = await insertUser(pool);
  const architectureId = "20000000-0000-4000-8000-000000000001";
  const targetId = "30000000-0000-4000-8000-000000000001";
  await pool.query("INSERT INTO skill_architectures (id, owner_user_id, name, pattern_id) VALUES ($1, $2, 'Personal', 'flat')", [architectureId, userId]);
  await pool.query(`INSERT INTO skill_architecture_targets
    (id, architecture_id, owner_user_id, name, adapter_kind, adapter_contract_version, adapter_version,
     environment_id, profile_id, status, consent_status, consent_granted_at, capabilities,
     capabilities_digest, identity_digest, generation, created_by_user_id)
    VALUES ($1, $2, $3, 'Companion', 'codex-companion', 2, '1', 'personal', 'default',
      'connected', 'granted', now(), '{"inventory.read":true,"apply":true,"rollback":true,"sync.write":true}', $4, $5, 1, $3)`,
  [targetId, architectureId, userId, "c".repeat(64), "d".repeat(64)]);
  const operation = await pool.query(`INSERT INTO target_skill_operations
    (target_id, target_generation, actor_user_id, action, skill_slug, from_version, to_version, platform,
     artifact_sha256, artifact_byte_size, artifact_content_type, plan_digest, idempotency_key)
    VALUES ($1, 1, $2, 'update', 'release-notes-helper', '1.0.0', '1.1.0', 'codex', $3, 123,
      'application/json', $4, 'update-1') RETURNING id`, [targetId, userId, "e".repeat(64), "f".repeat(64)]);
  const operationId = operation.rows[0].id;
  await assert.rejects(pool.query("UPDATE target_skill_operations SET state = 'applying' WHERE id = $1", [operationId]), /claim_state_check/);
  await pool.query(`UPDATE target_skill_operations SET state = 'claimed', fencing_token = 1, holder_id = 'companion-1',
    claim_token_hash = $2, lease_expires_at = now() + interval '1 minute', updated_at = now() WHERE id = $1`, [operationId, "1".repeat(64)]);
  await pool.query(`UPDATE target_skill_operations SET state = 'succeeded', holder_id = NULL, claim_token_hash = NULL,
    lease_expires_at = NULL, result = $2, updated_at = now() WHERE id = $1`, [operationId, {
      status: "succeeded",
      code: "operation.succeeded",
      recordedAt: "2026-09-02T00:00:00.000Z",
      installedVersion: "1.1.0",
      artifactSha256: "e".repeat(64),
      contentDigest: "2".repeat(64),
    }]);
  await assert.rejects(pool.query("UPDATE target_skill_operations SET result = result || '{\"secret\":\"nope\"}'::jsonb WHERE id = $1", [operationId]), /result_check/);
});

function requiredTestDatabaseUrl(): string {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  const parsed = new URL(databaseUrl);
  assert.match(parsed.pathname.replace(/^\//, ""), /(test|ci)/i);
  return databaseUrl;
}

async function insertUser(pool: ReturnType<typeof createPgPool>): Promise<string> {
  const result = await pool.query("INSERT INTO users (email, normalized_email, name, status, email_verified_at) VALUES ('upgrade@example.com', 'upgrade@example.com', 'Upgrade', 'active', now()) RETURNING id");
  return result.rows[0].id as string;
}

async function resetAndMigrate(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
}
