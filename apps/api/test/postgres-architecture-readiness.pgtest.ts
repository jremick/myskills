import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDb, createPgPool } from "../src/db/client.js";
import {
  createPostgresArchitectureReadinessProbe,
  PHASE2_ARCHITECTURE_MIGRATION_IDS,
} from "../src/architectures/postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("Phase 2 architecture readiness rejects a partially applied migration program", { timeout: 60_000 }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await resetAndApplyThrough(pool, PHASE2_ARCHITECTURE_MIGRATION_IDS[1]);

  const probe = createPostgresArchitectureReadinessProbe(createDb(pool));
  await assert.rejects(probe, /migrations are incomplete/);
});

test("Phase 2 architecture readiness rejects a marked-complete schema with a missing contract column", { timeout: 60_000 }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await resetAndApplyThrough(pool, PHASE2_ARCHITECTURE_MIGRATION_IDS.at(-1) ?? "0020_architecture_pattern_migrations");
  await pool.query("ALTER TABLE skill_architecture_targets DROP COLUMN metadata");

  const probe = createPostgresArchitectureReadinessProbe(createDb(pool));
  await assert.rejects(probe, /schema is incomplete/);
});

test("Phase 2 architecture readiness accepts the complete migration program", { timeout: 60_000 }, async (t) => {
  const pool = createPgPool(requiredTestDatabaseUrl());
  t.after(() => pool.end());
  await resetAndApplyThrough(pool, PHASE2_ARCHITECTURE_MIGRATION_IDS.at(-1) ?? "0020_architecture_pattern_migrations");

  const probe = createPostgresArchitectureReadinessProbe(createDb(pool));
  await probe();
});

function requiredTestDatabaseUrl(): string {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres architecture readiness tests.");
  const parsed = new URL(databaseUrl);
  assert.match(parsed.pathname.replace(/^\//, ""), /(test|ci)/i);
  return databaseUrl;
}

async function resetAndApplyThrough(
  pool: ReturnType<typeof createPgPool>,
  targetMigrationId: string,
): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await applyMigration(pool, id);
    if (id === targetMigrationId) return;
  }
  throw new Error(`Migration ${targetMigrationId} was not found.`);
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
