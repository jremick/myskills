import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createPgPool } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const sourceArchitectureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceRevisionId = "abababab-abab-4bab-8bab-abababababab";
const targetArchitectureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetRevisionId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
const secondTargetArchitectureId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondTargetRevisionId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
const thirdTargetArchitectureId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const lineageId = "12121212-1212-4121-8121-121212121212";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);

test("migration 0020 creates exact derive-shell lineage and full-chain constraints", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool);
  await insertArchitecture(pool, sourceArchitectureId, "Source architecture", "flat");
  await insertArchitecture(pool, targetArchitectureId, "Target architecture", "multi-level-router");
  await insertRevision(pool, sourceRevisionId, sourceArchitectureId, "flat");
  await insertRevision(pool, targetRevisionId, targetArchitectureId, "multi-level-router");
  await setCurrentRevision(pool, sourceArchitectureId, sourceRevisionId);
  await setCurrentRevision(pool, targetArchitectureId, targetRevisionId);

  await insertLineage(pool);
  const row = (await pool.query(
    `SELECT id, schema_version, mode,
            source_architecture_id, source_revision_id, source_pattern_id, source_revision_digest,
            target_architecture_id, target_revision_id, target_pattern_id, target_revision_digest,
            mapping_status, mapping, diff, migration_digest, diff_digest, actor_user_id, idempotency_key
       FROM skill_architecture_pattern_migrations
      WHERE id = $1`,
    [lineageId],
  )).rows[0];
  assert.deepEqual(row, {
    id: lineageId,
    schema_version: 1,
    mode: "derive-shell",
    source_architecture_id: sourceArchitectureId,
    source_revision_id: sourceRevisionId,
    source_pattern_id: "flat",
    source_revision_digest: digestA,
    target_architecture_id: targetArchitectureId,
    target_revision_id: targetRevisionId,
    target_pattern_id: "multi-level-router",
    target_revision_digest: digestB,
    mapping_status: "fallback",
    mapping: {},
    diff: { addedEdgeCount: 2, removedEdgeCount: 0, rewrittenBindingCount: 4 },
    migration_digest: digestC,
    diff_digest: digestD,
    actor_user_id: ownerId,
    idempotency_key: "pattern-migration-1",
  });

  const indexes = (await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'skill_architecture_pattern_migrations'`,
  )).rows.map((entry) => entry.indexname as string);
  for (const expected of [
    "skill_architecture_pattern_migrations_source_history_idx",
    "skill_architecture_pattern_migrations_actor_history_idx",
    "skill_architecture_pattern_migrations_actor_idempotency_unique",
    "skill_architecture_pattern_migrations_target_arch_unique",
    "skill_architecture_pattern_migrations_target_revision_unique",
  ]) {
    assert.ok(indexes.includes(expected), `missing ${expected}`);
  }

  const triggers = (await pool.query(
    `SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgrelid IN (
          'skill_architecture_revisions'::regclass,
          'skill_architecture_pattern_migrations'::regclass
        )`,
  )).rows.map((entry) => entry.tgname as string);
  assert.ok(triggers.includes("skill_architecture_revisions_append_only"));
  assert.ok(triggers.includes("skill_architecture_revisions_no_truncate"));
  assert.ok(triggers.includes("skill_architecture_pattern_migrations_append_only"));
  assert.ok(triggers.includes("skill_architecture_pattern_migrations_no_truncate"));
});

test("lineage links exact same-architecture revisions and prevents duplicate targets or idempotency", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool);
  await insertArchitecture(pool, sourceArchitectureId, "Source architecture", "domain-router");
  await insertArchitecture(pool, targetArchitectureId, "Target architecture", "flat");
  await insertArchitecture(pool, secondTargetArchitectureId, "Second target", "multi-level-router");
  await insertArchitecture(pool, thirdTargetArchitectureId, "Third target", "flat");
  await insertRevision(pool, sourceRevisionId, sourceArchitectureId, "domain-router");
  await insertRevision(pool, targetRevisionId, targetArchitectureId, "flat");
  await insertRevision(pool, secondTargetRevisionId, secondTargetArchitectureId, "multi-level-router");
  await insertLineage(pool);

  await assert.rejects(
    insertLineage(pool, { idempotencyKey: "pattern-migration-1", id: "13131313-1313-4131-8131-131313131313" }),
    (error) => isConstraintError(error, "skill_architecture_pattern_migrations_actor_idempotency_unique"),
  );
  await assert.rejects(
    insertLineage(pool, { id: "14141414-1414-4141-8141-141414141414", idempotencyKey: "pattern-migration-2" }),
    (error) => isConstraintError(error, "skill_architecture_pattern_migrations_target_arch_unique"),
  );

  await assert.rejects(
    insertLineage(pool, {
      id: "15151515-1515-4151-8151-151515151515",
      idempotencyKey: "pattern-migration-cross-revision",
      targetArchitectureId: secondTargetArchitectureId,
      targetRevisionId: secondTargetRevisionId,
      sourceRevisionId: targetRevisionId,
    }),
    (error) => isConstraintError(error, "skill_architecture_pattern_migrations_source_revision_fk"),
  );
  await assert.rejects(
    insertLineage(pool, {
      id: "16161616-1616-4161-8161-161616161616",
      idempotencyKey: "pattern-migration-cross-target-revision",
      targetArchitectureId: thirdTargetArchitectureId,
      targetRevisionId: secondTargetRevisionId,
    }),
    (error) => isConstraintError(error, "skill_architecture_pattern_migrations_target_revision_fk"),
  );
  await assert.rejects(
    insertLineage(pool, {
      id: "17171717-1717-4171-8171-171717171717",
      idempotencyKey: "pattern-migration-same-architecture",
      targetArchitectureId: sourceArchitectureId,
      targetRevisionId: sourceRevisionId,
    }),
    (error) => isConstraintError(error, "skill_architecture_pattern_migrations_distinct_arch_check"),
  );
});

test("revisions and pattern lineage remain append-only while normal inserts and current pointers continue", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool);
  await insertArchitecture(pool, sourceArchitectureId, "Source architecture", "flat");
  await insertArchitecture(pool, targetArchitectureId, "Target architecture", "domain-router");
  await insertRevision(pool, sourceRevisionId, sourceArchitectureId, "flat");
  await insertRevision(pool, targetRevisionId, targetArchitectureId, "domain-router");
  await setCurrentRevision(pool, sourceArchitectureId, sourceRevisionId);
  await setCurrentRevision(pool, targetArchitectureId, targetRevisionId);
  await insertLineage(pool);

  await assert.rejects(
    pool.query("UPDATE skill_architecture_revisions SET message = 'changed' WHERE id = $1", [sourceRevisionId]),
    isImmutableError,
  );
  await assert.rejects(
    pool.query("DELETE FROM skill_architecture_revisions WHERE id = $1", [sourceRevisionId]),
    isImmutableError,
  );
  await assert.rejects(pool.query("TRUNCATE skill_architecture_revisions CASCADE"), isImmutableError);
  await assert.rejects(
    pool.query("UPDATE skill_architecture_pattern_migrations SET mapping_status = 'provided' WHERE id = $1", [lineageId]),
    isImmutableError,
  );
  await assert.rejects(
    pool.query("DELETE FROM skill_architecture_pattern_migrations WHERE id = $1", [lineageId]),
    isImmutableError,
  );
  await assert.rejects(pool.query("TRUNCATE skill_architecture_pattern_migrations"), isImmutableError);

  const extraRevisionId = "18181818-1818-4181-8181-181818181818";
  await insertRevision(pool, extraRevisionId, sourceArchitectureId, "flat", 2);
  await setCurrentRevision(pool, sourceArchitectureId, extraRevisionId);
  const current = (await pool.query(
    "SELECT current_revision_id FROM skill_architectures WHERE id = $1",
    [sourceArchitectureId],
  )).rows[0];
  assert.equal(current?.current_revision_id, extraRevisionId);
});

test("mapping, pattern, version, and digest constraints reject unsafe lineage records", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool);
  await insertArchitecture(pool, sourceArchitectureId, "Source architecture", "flat");
  await insertArchitecture(pool, targetArchitectureId, "Target architecture", "domain-router");
  await insertRevision(pool, sourceRevisionId, sourceArchitectureId, "flat");
  await insertRevision(pool, targetRevisionId, targetArchitectureId, "domain-router");

  for (const [name, override, constraint] of [
    ["unknown mapping field", { mapping: { extra: true } }, "skill_architecture_pattern_migrations_mapping_check"],
    ["mapping path", { mapping: { rootLabel: "/Users/jarel/.codex" } }, "skill_architecture_pattern_migrations_mapping_check"],
    ["mapping URL", { mapping: { rootLabel: "https://example.invalid" } }, "skill_architecture_pattern_migrations_mapping_check"],
    ["mapping secret", { mapping: { rootLabel: "token=do-not-store" } }, "skill_architecture_pattern_migrations_mapping_check"],
    ["mapping oversized", { mapping: { rootLabel: "x".repeat(32_769) } }, "skill_architecture_pattern_migrations_mapping_check"],
    ["source pattern", { sourcePatternId: "router-tree" }, "skill_architecture_pattern_migrations_source_pattern_check"],
    ["target pattern", { targetPatternId: "router-tree" }, "skill_architecture_pattern_migrations_target_pattern_check"],
    ["schema version", { schemaVersion: 2 }, "skill_architecture_pattern_migrations_schema_version_check"],
    ["migration digest", { migrationDigest: "bad" }, "skill_architecture_pattern_migrations_migration_digest_check"],
    ["diff digest", { diffDigest: "bad" }, "skill_architecture_pattern_migrations_diff_digest_check"],
  ] as const) {
    await assert.rejects(
      insertLineage(pool, {
        id: randomUuidForTest(name),
        idempotencyKey: `invalid-${name.replaceAll(" ", "-")}`,
        ...override,
      }),
      (error) => isConstraintError(error, constraint),
    );
  }
});

type LineageOverrides = Partial<{
  id: string;
  schemaVersion: number;
  mode: string;
  sourceArchitectureId: string;
  sourceRevisionId: string;
  sourcePatternId: string;
  sourceRevisionDigest: string;
  targetArchitectureId: string;
  targetRevisionId: string;
  targetPatternId: string;
  targetRevisionDigest: string;
  mappingStatus: string;
  mapping: Record<string, unknown>;
  diff: Record<string, unknown>;
  migrationDigest: string;
  diffDigest: string;
  actorUserId: string;
  idempotencyKey: string;
}>;

async function insertLineage(
  pool: ReturnType<typeof createPgPool>,
  overrides: LineageOverrides = {},
): Promise<void> {
  const input = {
    id: lineageId,
    schemaVersion: 1,
    mode: "derive-shell",
    sourceArchitectureId,
    sourceRevisionId,
    sourcePatternId: "flat",
    sourceRevisionDigest: digestA,
    targetArchitectureId,
    targetRevisionId,
    targetPatternId: "multi-level-router",
    targetRevisionDigest: digestB,
    mappingStatus: "fallback",
    mapping: {},
    diff: { addedEdgeCount: 2, removedEdgeCount: 0, rewrittenBindingCount: 4 },
    migrationDigest: digestC,
    diffDigest: digestD,
    actorUserId: ownerId,
    idempotencyKey: "pattern-migration-1",
    ...overrides,
  };
  await pool.query(
    `INSERT INTO skill_architecture_pattern_migrations (
       id, schema_version, mode,
       source_architecture_id, source_revision_id, source_pattern_id, source_revision_digest,
       target_architecture_id, target_revision_id, target_pattern_id, target_revision_digest,
       mapping_status, mapping, diff, migration_digest, diff_digest, actor_user_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18)`,
    [
      input.id,
      input.schemaVersion,
      input.mode,
      input.sourceArchitectureId,
      input.sourceRevisionId,
      input.sourcePatternId,
      input.sourceRevisionDigest,
      input.targetArchitectureId,
      input.targetRevisionId,
      input.targetPatternId,
      input.targetRevisionDigest,
      input.mappingStatus,
      JSON.stringify(input.mapping),
      JSON.stringify(input.diff),
      input.migrationDigest,
      input.diffDigest,
      input.actorUserId,
      input.idempotencyKey,
    ],
  );
}

async function insertUser(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, 'pattern-migration-owner@example.com', 'pattern-migration-owner@example.com', 'Pattern migration owner', 'active', now())`,
    [ownerId],
  );
}

async function insertArchitecture(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  name: string,
  pattern: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, 'Pattern migration fixture', $4)`,
    [id, ownerId, name, pattern],
  );
}

async function insertRevision(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  architectureId: string,
  pattern: string,
  revisionNumber = 1,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_revisions
       (id, architecture_id, revision_number, message, spec, created_by_user_id)
     VALUES ($1, $2, $3, 'Pattern migration fixture', $4::jsonb, $5)`,
    [
      id,
      architectureId,
      revisionNumber,
      JSON.stringify({ schemaVersion: 1, pattern: { id: pattern, version: 1 }, nodes: [], edges: [], environments: [], profiles: [] }),
      ownerId,
    ],
  );
}

async function setCurrentRevision(
  pool: ReturnType<typeof createPgPool>,
  architectureId: string,
  revisionId: string,
): Promise<void> {
  await pool.query(
    "UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2",
    [revisionId, architectureId],
  );
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for architecture pattern migration tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0020_architecture_pattern_migrations");
  return pool;
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

function randomUuidForTest(seed: string): string {
  const hex = [...seed].map((character) => character.charCodeAt(0).toString(16)).join("").padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isImmutableError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55000";
}
