import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPool } from "./client.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(appRoot, "migrations");
const pool = createPgPool();

try {
  await migrate();
  console.log("Migrations applied.");
} finally {
  await pool.end();
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [id]);
    if (existing.rowCount) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");
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
}

