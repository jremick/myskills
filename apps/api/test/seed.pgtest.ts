import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { seedDatabase } from "../src/db/seed.js";
import { skillVersions, skills } from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("seedDatabase publishes and repairs the demo release for public registry reads", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const db = createDb(pool);
  const seedOptions = {
    ownerEmail: "owner@example.com",
    ownerPassword: "correct horse battery staple",
  };

  await seedDatabase(db, seedOptions);
  await assertDemoReleaseVisible(db);

  const version = await selectDemoVersion(db);
  assert.equal(version.lifecycleStatus, "approved");
  assert.equal(version.reviewStatus, "approved");
  assert.equal(version.securityStatus, "passed");
  assert.ok(version.publishedAt);

  await db
    .update(skillVersions)
    .set({ lifecycleStatus: "submitted" })
    .where(eq(skillVersions.id, version.id));
  await assertDemoReleaseHidden(db);

  await seedDatabase(db, seedOptions);
  const repairedVersion = await selectDemoVersion(db);
  assert.equal(repairedVersion.id, version.id);
  assert.equal(repairedVersion.lifecycleStatus, "approved");
  assert.equal(repairedVersion.reviewStatus, "approved");
  assert.equal(repairedVersion.securityStatus, "passed");
  assert.ok(repairedVersion.publishedAt);
  await assertDemoReleaseVisible(db);
});

async function selectDemoVersion(db: ReturnType<typeof createDb>) {
  const [version] = await db
    .select({
      id: skillVersions.id,
      lifecycleStatus: skillVersions.lifecycleStatus,
      reviewStatus: skillVersions.reviewStatus,
      securityStatus: skillVersions.securityStatus,
      publishedAt: skillVersions.publishedAt,
    })
    .from(skillVersions)
    .innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(and(
      eq(skills.slug, "release-notes-helper"),
      eq(skillVersions.version, "0.1.0"),
    ))
    .limit(1);
  assert.ok(version);
  return version;
}

async function assertDemoReleaseVisible(db: ReturnType<typeof createDb>): Promise<void> {
  const app = buildApp({
    skillRepository: new PostgresSkillRepository(db),
    submissionService: new SubmissionService(new PostgresSubmissionStore(db)),
  });
  try {
    const list = await app.inject({ method: "GET", url: "/v1/skills?q=release" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().skills.map((skill: { slug: string }) => skill.slug), ["release-notes-helper"]);

    const release = await app.inject({
      method: "GET",
      url: "/v1/skills/release-notes-helper/releases/0.1.0",
    });
    assert.equal(release.statusCode, 200);
    assert.equal(release.json().release.lifecycleStatus, "approved");

    const bundle = await app.inject({
      method: "GET",
      url: "/v1/skills/release-notes-helper/releases/0.1.0/bundle?platform=codex",
    });
    assert.equal(bundle.statusCode, 200);
    assert.match(bundle.headers["content-type"] as string, /application\/vnd\.myskills-app\.package\+json/);
  } finally {
    await app.close();
  }
}

async function assertDemoReleaseHidden(db: ReturnType<typeof createDb>): Promise<void> {
  const app = buildApp({
    skillRepository: new PostgresSkillRepository(db),
    submissionService: new SubmissionService(new PostgresSubmissionStore(db)),
  });
  try {
    const list = await app.inject({ method: "GET", url: "/v1/skills?q=release" });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().skills, []);

    const release = await app.inject({
      method: "GET",
      url: "/v1/skills/release-notes-helper/releases/0.1.0",
    });
    assert.equal(release.statusCode, 404);
    assert.equal(release.json().error.code, "RELEASE_NOT_FOUND");
  } finally {
    await app.close();
  }
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}. Use TEST_DATABASE_URL with a test database.`);
  }
}

async function resetDatabase(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function applyMigrations(pool: ReturnType<typeof createPgPool>): Promise<void> {
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
