import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

test("legacy duplicate artifacts stop before an arbitrary approval digest is committed", async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  assert.match(new URL(url).pathname, /(^|[_/-])(test|ci)([_/-]|$)/i);
  const pool = createPgPool(url);
  const directory = await mkdtemp(join(tmpdir(), "myskills-legacy-artifacts-"));
  t.after(async () => { await pool.end(); await rm(directory, { recursive: true, force: true }); });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  const source = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0012")) {
    await copyFile(join(source, file), join(directory, file));
  }
  await runMigrations(pool, { migrationsDir: directory });
  const skill = await pool.query("INSERT INTO skills (slug, title, summary) VALUES ('legacy', 'Legacy', 'Fixture') RETURNING id");
  const release = await pool.query("INSERT INTO skill_versions (skill_id, version, review_status) VALUES ($1, '1.0.0', 'approved') RETURNING id", [skill.rows[0].id]);
  const id = release.rows[0].id;
  for (const hash of ["a".repeat(64), "b".repeat(64)]) {
    await pool.query("INSERT INTO skill_artifacts (skill_version_id, storage_key, sha256, byte_size, content_type) VALUES ($1, $2, $2, 1, 'application/json')", [id, hash]);
  }
  await copyFile(join(source, "0012_approval_artifact_hash.sql"), join(directory, "0012_approval_artifact_hash.sql"));
  await assert.rejects(runMigrations(pool, { migrationsDir: directory }), /Legacy artifact duplicates require operator review/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE id = '0012_approval_artifact_hash'")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'skill_versions' AND column_name = 'approved_artifact_sha256'")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_artifacts")).rows[0].count, 2);

  // Simulate an operator resolving the fixture from independent evidence.
  await pool.query("DELETE FROM skill_artifacts WHERE sha256 = $1", ["b".repeat(64)]);
  await runMigrations(pool, { migrationsDir: directory });
  assert.equal((await pool.query("SELECT approved_artifact_sha256 FROM skill_versions WHERE id = $1", [id])).rows[0].approved_artifact_sha256, "a".repeat(64));

  // Also protect databases where 0012 ran before this preflight existed.
  await pool.query("INSERT INTO skill_artifacts (skill_version_id, storage_key, sha256, byte_size, content_type) VALUES ($1, 'duplicate', $2, 1, 'application/json')", [id, "b".repeat(64)]);
  await copyFile(join(source, "0013_skill_artifact_uniqueness.sql"), join(directory, "0013_skill_artifact_uniqueness.sql"));
  await assert.rejects(runMigrations(pool, { migrationsDir: directory }), /Legacy artifact duplicates require operator review/);
  assert.equal((await pool.query("SELECT approved_artifact_sha256 FROM skill_versions WHERE id = $1", [id])).rows[0].approved_artifact_sha256, "a".repeat(64));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_artifacts")).rows[0].count, 2);
});
