import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPgPool } from "./client.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultMigrationsDir = join(appRoot, "migrations");
const MIGRATION_LOCK_NAME = "myskills-schema-migrations-v1";

export async function runMigrations(
  pool: Pick<pg.Pool, "connect">,
  options: { migrationsDir?: string } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const existing = await client.query("SELECT id FROM schema_migrations WHERE id = $1", [id]);
      if (existing.rowCount) {
        continue;
      }

      const migrationSql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        if (id === "0012_approval_artifact_hash" || id === "0013_skill_artifact_uniqueness") {
          // Refuse ambiguity before 0012 can persist an arbitrary approval
          // digest. The table lock also fences concurrent legacy writers.
          await client.query("LOCK TABLE skill_artifacts IN SHARE MODE");
          const duplicates = await client.query(`
            SELECT 1 FROM skill_artifacts
            GROUP BY skill_version_id HAVING count(*) > 1 LIMIT 1
          `);
          if (duplicates.rowCount) {
            throw new Error("Legacy artifact duplicates require operator review before migration. See docs/DEPLOYMENT.md#legacy-artifact-migration-preflight. No artifact or approval digest was selected or changed by this migration.");
          }
        }
        await client.query(migrationSql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    } finally {
      client.release();
    }
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  const pool = createPgPool();
  try {
    await runMigrations(pool);
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}
