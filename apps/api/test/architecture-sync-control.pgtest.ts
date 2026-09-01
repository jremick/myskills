import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createPgPool } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const architectureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherArchitectureId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherTargetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const observationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const otherObservationId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const revisionId = "12121212-1212-4121-8121-121212121212";
const otherRevisionId = "13131313-1313-4131-8131-131313131313";
const runId = "14141414-1414-4141-8141-141414141414";
const otherRunId = "15151515-1515-4151-8151-151515151515";
const stepId = "16161616-1616-4161-8161-161616161616";
const leaseId = "17171717-1717-4171-8171-171717171717";
const baselineId = "18181818-1818-4181-8181-181818181818";
const receiptId = "19191919-1919-4191-8191-191919191919";
const recoveryEvidenceId = "20202020-2020-4202-8202-202020202020";
const nextObservationId = "29292929-2929-4292-8292-292929292929";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);
const digestE = "e".repeat(64);

test("migration 0019 hardens revision pointers and preserves same-architecture rows", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "sync-owner@example.com");
  await insertUser(pool, memberId, "sync-member@example.com");
  await insertArchitecture(pool, architectureId, ownerId, "sync-architecture");
  await insertArchitecture(pool, otherArchitectureId, memberId, "other-sync-architecture");
  await insertRevision(pool, revisionId, architectureId, 1);
  await insertRevision(pool, otherRevisionId, otherArchitectureId, 1);
  await pool.query("UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2", [revisionId, architectureId]);
  await pool.query("UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2", [otherRevisionId, otherArchitectureId]);

  const before = (await pool.query(
    "SELECT id, current_revision_id FROM skill_architectures WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[architectureId, otherArchitectureId]],
  )).rows;
  assert.deepEqual(before, [
    { id: architectureId, current_revision_id: revisionId },
    { id: otherArchitectureId, current_revision_id: otherRevisionId },
  ]);

  await assert.rejects(
    pool.query("UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2", [otherRevisionId, architectureId]),
    (error) => isConstraintError(error, "skill_architectures_current_revision_fk"),
  );

  const after = (await pool.query(
    "SELECT id, current_revision_id FROM skill_architectures WHERE id = ANY($1::uuid[]) ORDER BY id",
    [[architectureId, otherArchitectureId]],
  )).rows;
  assert.deepEqual(after, before, "the failed cross-architecture pointer must not change legacy rows");

  const constraints = (await pool.query(
    `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'skill_architectures'::regclass
        AND conname = 'skill_architectures_current_revision_fk'`,
  )).rows as Array<{ conname: string; definition: string }>;
  assert.match(constraints[0]?.definition ?? "", /FOREIGN KEY \(id, current_revision_id\)/);
  assert.match(constraints[0]?.definition ?? "", /skill_architecture_revisions/);
  assert.ok((await pool.query(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = 'skill_architecture_revisions'::regclass
        AND conname = 'skill_architecture_revisions_architecture_id_id_unique'`,
  )).rowCount === 1);
});

test("sync runs bind exact revisions, targets, observations, and idempotency keys", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);

  await insertRun(pool, { id: runId, requestKey: "request-1", idempotencyKey: "idempotency-1" });
  const row = (await pool.query(
    `SELECT id, architecture_id, revision_id, target_id, target_generation,
            observed_snapshot_id, run_kind, status, desired_digest, plan_digest
       FROM skill_architecture_sync_runs WHERE id = $1`,
    [runId],
  )).rows[0];
  assert.deepEqual(row, {
    id: runId,
    architecture_id: architectureId,
    revision_id: revisionId,
    target_id: targetId,
    target_generation: 2,
    observed_snapshot_id: observationId,
    run_kind: "sync",
    status: "drafted",
    desired_digest: digestA,
    plan_digest: digestD,
  });
  const runUniqueKeys = (await pool.query(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid = 'skill_architecture_sync_runs'::regclass
        AND contype = 'u'`,
  )).rows.map((entry) => entry.conname as string);
  assert.ok(runUniqueKeys.includes("skill_architecture_sync_runs_id_generation_unique"));
  assert.ok(runUniqueKeys.includes("skill_architecture_sync_runs_id_target_generation_unique"));
  await pool.query(
    `UPDATE skill_architecture_sync_runs
        SET started_at = '2026-08-30T00:05:00Z', updated_at = '2026-08-30T00:05:00Z'
      WHERE id = $1`,
    [runId],
  );
  await assert.rejects(
    pool.query(
      `UPDATE skill_architecture_sync_runs
          SET started_at = '2026-08-30T00:04:00Z', updated_at = '2026-08-30T00:06:00Z'
        WHERE id = $1`,
      [runId],
    ),
    isImmutableEvidenceError,
  );

  await assert.rejects(
    insertRun(pool, { id: otherRunId, requestKey: "request-2", idempotencyKey: "idempotency-1" }),
    (error) => isConstraintError(error, "skill_architecture_sync_runs_target_idempotency_unique"),
  );
  await assert.rejects(
    insertRun(pool, {
      id: "21212121-2121-4121-8121-212121212121",
      architectureId: architectureId,
      revisionId: otherRevisionId,
      requestKey: "request-cross-revision",
      idempotencyKey: "idempotency-cross-revision",
    }),
    (error) => isConstraintError(error, "skill_architecture_sync_runs_architecture_revision_fk"),
  );
  await assert.rejects(
    insertRun(pool, {
      id: "22222222-2222-4222-8222-222222222222",
      architectureId: architectureId,
      targetId: otherTargetId,
      observedSnapshotId: otherObservationId,
      requestKey: "request-cross-target",
      idempotencyKey: "idempotency-cross-target",
    }),
    (error) => isConstraintError(error, "skill_architecture_sync_runs_target_architecture_fk"),
  );

  await insertStep(pool);
  await pool.query(
    `UPDATE skill_architecture_sync_steps
        SET started_at = '2026-08-30T00:05:00Z', updated_at = '2026-08-30T00:05:00Z'
      WHERE id = $1`,
    [stepId],
  );
  await assert.rejects(
    pool.query(
      `UPDATE skill_architecture_sync_steps
          SET started_at = '2026-08-30T00:04:00Z', updated_at = '2026-08-30T00:06:00Z'
        WHERE id = $1`,
      [stepId],
    ),
    isImmutableEvidenceError,
  );
  await assert.rejects(
    insertStep(pool, { id: "23232323-2323-4232-8232-232323232323", ordinal: 1, idempotencyKey: "step-duplicate" }),
    (error) => isConstraintError(error, "skill_architecture_sync_steps_run_ordinal_unique"),
  );
  await assert.rejects(
    insertStep(pool, { id: "24242424-2424-4242-8242-242424242424", ordinal: 2, idempotencyKey: "step-2", targetGeneration: 1 }),
    (error) => isConstraintError(error, "skill_architecture_sync_steps_run_generation_fk"),
  );
});

test("retained sync history survives a target generation advance", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  await insertRun(pool, { id: runId, requestKey: "request-generation-history", idempotencyKey: "idempotency-generation-history" });
  await insertLease(pool, { fencingToken: 1 });
  await insertObservation(pool, nextObservationId, targetId, 3);

  await pool.query(
    "UPDATE skill_architecture_targets SET generation = 3, updated_at = '2026-08-30T00:05:00Z' WHERE id = $1",
    [targetId],
  );

  assert.deepEqual((await pool.query(
    `SELECT generation FROM skill_architecture_targets WHERE id = $1`,
    [targetId],
  )).rows, [{ generation: 3 }]);
  assert.deepEqual((await pool.query(
    `SELECT target_id, target_generation FROM skill_architecture_sync_runs WHERE id = $1`,
    [runId],
  )).rows, [{ target_id: targetId, target_generation: 2 }]);
  assert.deepEqual((await pool.query(
    `SELECT target_id, target_generation, fencing_token FROM skill_architecture_sync_target_leases WHERE target_id = $1`,
    [targetId],
  )).rows, [{ target_id: targetId, target_generation: 2, fencing_token: "1" }]);
});

test("leases provide one current holder, monotonic fencing, and stale evidence denial", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  await insertRun(pool, { id: runId, requestKey: "request-lease", idempotencyKey: "idempotency-lease" });
  await insertLease(pool, { fencingToken: 1 });

  await assert.rejects(
    insertLease(pool, { id: "25252525-2525-4252-8252-252525252525", fencingToken: 1 }),
    (error) => isConstraintError(error, "skill_architecture_sync_target_leases_target_id_key"),
  );
  await pool.query(
    `UPDATE skill_architecture_sync_target_leases
        SET fencing_token = 2, id = $1, holder_id = 'holder-next', acquired_at = '2026-08-30T00:10:00Z',
            expires_at = '2026-08-30T01:10:00Z', updated_at = '2026-08-30T00:10:00Z'
      WHERE target_id = $2`,
    [leaseId, targetId],
  );
  await assert.rejects(
    pool.query(
      `UPDATE skill_architecture_sync_target_leases
          SET fencing_token = 1, updated_at = '2026-08-30T00:11:00Z'
        WHERE target_id = $1`,
      [targetId],
    ),
    isImmutableEvidenceError,
  );

  await assert.rejects(
    insertReceipt(pool, { id: receiptId, fencingToken: 1, code: "stale-fence" }),
    isImmutableEvidenceError,
  );
  await assert.rejects(
    insertReceipt(pool, {
      id: "21212121-2121-4121-8121-212121212121",
      kind: "apply",
      code: "apply-without-fence",
    }),
    isImmutableEvidenceError,
  );
  for (const evidence of [
    { id: "23232323-2323-4232-8232-232323232323", kind: "verify" as const, code: "verify-without-fence" },
    { id: "24242424-2424-4242-8242-242424242424", kind: "rollback" as const, code: "rollback-without-fence" },
    { id: "25252525-2525-4252-8252-252525252525", kind: "recovery" as const, code: "recovery.retry" },
    { id: "26262626-2626-4262-8262-262626262626", kind: "lease" as const, code: "lease-without-fence" },
  ]) {
    await assert.rejects(
      insertReceipt(pool, { ...evidence, fencingToken: null }),
      isImmutableEvidenceError,
    );
  }
  await assert.rejects(
    insertRecoveryEvidence(pool, {
      id: "27272727-2727-4272-8272-272727272727",
      fencingToken: null,
    }),
    isImmutableEvidenceError,
  );
  await insertReceipt(pool, { id: receiptId, fencingToken: 2, code: "current-fence" });
  const receipt = (await pool.query("SELECT fencing_token, code FROM skill_architecture_sync_receipts WHERE id = $1", [receiptId])).rows[0];
  assert.deepEqual(receipt, { fencing_token: "2", code: "current-fence" });
});

test("baselines, receipts, and recovery evidence are append-only and indexed", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  await insertRun(pool, { id: runId, requestKey: "request-evidence", idempotencyKey: "idempotency-evidence" });
  await insertLease(pool, { fencingToken: 1 });
  await insertBaseline(pool);
  await insertRun(pool, { id: otherRunId, requestKey: "request-evidence-2", idempotencyKey: "idempotency-evidence-2" });
  await assert.rejects(
    pool.query(
      `INSERT INTO skill_architecture_sync_baselines (
         id, run_id, target_id, target_generation, observed_digest, baseline_digest,
         restorable, captured_at, metadata, created_at
       ) VALUES ($1, $2, $3, 2, $4, $5, true,
         '2026-08-30T00:05:00Z', '{}'::jsonb, '2026-08-30T00:00:00Z')`,
      ["23232323-2323-4232-8232-232323232323", otherRunId, targetId, `${digestC}0`, digestE],
    ),
    (error) => isConstraintError(error, "skill_architecture_sync_baselines_digest_check"),
  );
  await insertReceipt(pool, { id: receiptId, fencingToken: 1, code: "accepted" });
  await insertRecoveryEvidence(pool);

  await assert.rejects(
    insertReceipt(pool, {
      id: "30303030-3030-4030-8030-303030303030",
      kind: "recovery",
      fencingToken: 1,
      code: "recovery.unknown",
      evidenceDigest: digestE,
    }),
    (error) => isConstraintError(error, "skill_architecture_sync_receipts_recovery_code_check"),
  );
  await assert.rejects(
    insertRecoveryEvidence(pool, {
      id: "31313131-3131-4131-8131-313131313131",
      code: "recovery.succeed",
    }),
    (error) => isConstraintError(error, "skill_architecture_sync_recovery_evidence_transition_code_check"),
  );

  await assert.rejects(
    pool.query("UPDATE skill_architecture_sync_receipts SET code = 'changed' WHERE id = $1", [receiptId]),
    isImmutableEvidenceError,
  );
  await assert.rejects(
    pool.query("DELETE FROM skill_architecture_sync_receipts WHERE id = $1", [receiptId]),
    isImmutableEvidenceError,
  );
  await assert.rejects(pool.query("TRUNCATE skill_architecture_sync_receipts"), isImmutableEvidenceError);
  await assert.rejects(
    pool.query("UPDATE skill_architecture_sync_recovery_evidence SET code = 'changed' WHERE id = $1", [recoveryEvidenceId]),
    isImmutableEvidenceError,
  );
  await assert.rejects(
    pool.query("UPDATE skill_architecture_sync_baselines SET restorable = false WHERE id = $1", [baselineId]),
    isImmutableEvidenceError,
  );

  const indexes = (await pool.query(
    `SELECT tablename, indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN (
          'skill_architecture_sync_runs',
          'skill_architecture_sync_steps',
          'skill_architecture_sync_target_leases',
          'skill_architecture_sync_baselines',
          'skill_architecture_sync_receipts',
          'skill_architecture_sync_recovery_evidence'
        )`,
  )).rows as Array<{ tablename: string; indexname: string }>;
  for (const expected of [
    ["skill_architecture_sync_runs", "skill_architecture_sync_runs_nonterminal_idx"],
    ["skill_architecture_sync_runs", "skill_architecture_sync_runs_target_history_idx"],
    ["skill_architecture_sync_steps", "skill_architecture_sync_steps_nonterminal_idx"],
    ["skill_architecture_sync_target_leases", "skill_architecture_sync_target_leases_expiry_idx"],
    ["skill_architecture_sync_baselines", "skill_architecture_sync_baselines_target_history_idx"],
    ["skill_architecture_sync_receipts", "skill_architecture_sync_receipts_run_history_idx"],
    ["skill_architecture_sync_recovery_evidence", "skill_architecture_sync_recovery_evidence_target_history_idx"],
  ]) {
    assert.ok(indexes.some((row) => row.tablename === expected[0] && row.indexname === expected[1]), `missing ${expected[1]}`);
  }
});

test("sync records reject unsafe metadata and retain no live credential or apply flag", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  await insertRun(pool, { requestKey: "request-safe-preview", idempotencyKey: "idempotency-safe-preview" });
  await insertReceipt(pool, { id: "28282828-2828-4282-8282-282828282828", code: "preview" });
  await assert.rejects(
    insertRun(pool, {
      requestKey: "request-unsafe",
      idempotencyKey: "idempotency-unsafe",
      metadata: { path: "/Users/jarel/.codex" },
    }),
    (error) => isConstraintError(error, "skill_architecture_sync_runs_metadata_check"),
  );
  for (const [id, message] of [
    ["32323232-3232-4232-8232-323232323232", "Bearer abcdefgh"],
    ["33333333-3333-4333-8333-333333333333", "Basic abcdefgh"],
  ] as const) {
    await assert.rejects(
      insertReceipt(pool, { id, message }),
      (error) => isConstraintError(error, "skill_architecture_sync_receipts_message_check"),
    );
  }
  const columns = (await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name IN (
        'skill_architecture_sync_runs',
        'skill_architecture_sync_steps',
        'skill_architecture_sync_target_leases',
        'skill_architecture_sync_baselines',
        'skill_architecture_sync_receipts',
        'skill_architecture_sync_recovery_evidence'
      )`,
  )).rows.map((row) => row.column_name as string);
  assert.equal(columns.some((column) => /credential|password|secret|path|prompt|config|spec|package|apply_flag/i.test(column)), false);
});

type RunOverrides = Partial<{
  id: string;
  architectureId: string;
  revisionId: string;
  targetId: string;
  targetGeneration: number;
  observedSnapshotId: string;
  requestKey: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
}>;

async function seedFixture(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await insertUser(pool, ownerId, "sync-fixture-owner@example.com");
  await insertUser(pool, memberId, "sync-fixture-member@example.com");
  await insertArchitecture(pool, architectureId, ownerId, "sync-fixture-architecture");
  await insertArchitecture(pool, otherArchitectureId, memberId, "sync-fixture-other-architecture");
  await insertRevision(pool, revisionId, architectureId, 1);
  await insertRevision(pool, otherRevisionId, otherArchitectureId, 1);
  await insertTarget(pool, targetId, architectureId, ownerId, 2);
  await insertTarget(pool, otherTargetId, otherArchitectureId, memberId, 1);
  await insertObservation(pool, observationId, targetId, 2);
  await insertObservation(pool, otherObservationId, otherTargetId, 1);
}

async function insertRun(pool: ReturnType<typeof createPgPool>, overrides: RunOverrides = {}): Promise<void> {
  const input = {
    id: runId,
    architectureId,
    revisionId,
    targetId,
    targetGeneration: 2,
    observedSnapshotId: observationId,
    requestKey: "request-default",
    idempotencyKey: "idempotency-default",
    metadata: {},
    ...overrides,
  };
  await pool.query(
    `INSERT INTO skill_architecture_sync_runs (
       id, architecture_id, revision_id, target_id, target_generation, observed_snapshot_id,
       profile_id, environment_id, actor_user_id, run_kind, status, request_key, idempotency_key,
       desired_digest, compiled_digest, observed_digest, plan_digest, metadata,
       created_at, updated_at, status_updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'personal', 'personal-mac', $7, 'sync', 'drafted',
       $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $15, $15)`,
    [
      input.id,
      input.architectureId,
      input.revisionId,
      input.targetId,
      input.targetGeneration,
      input.observedSnapshotId,
      ownerId,
      input.requestKey,
      input.idempotencyKey,
      digestA,
      digestB,
      digestC,
      digestD,
      JSON.stringify(input.metadata),
      "2026-08-30T00:00:00Z",
    ],
  );
}

type StepOverrides = Partial<{
  id: string;
  ordinal: number;
  idempotencyKey: string;
  targetGeneration: number;
}>;

async function insertStep(pool: ReturnType<typeof createPgPool>, overrides: StepOverrides = {}): Promise<void> {
  const input = {
    id: stepId,
    ordinal: 1,
    idempotencyKey: "step-1",
    targetGeneration: 2,
    ...overrides,
  };
  await pool.query(
    `INSERT INTO skill_architecture_sync_steps (
       id, run_id, ordinal, action, node_id, target_generation, status, idempotency_key,
       desired_digest, compiled_digest, observed_digest, plan_digest, step_digest,
       created_at, updated_at, status_updated_at
     ) VALUES ($1, $2, $3, 'install', 'leaf-a', $4, 'planned', $5, $6, $7, $8, $9, $10, $11, $11, $11)`,
    [input.id, runId, input.ordinal, input.targetGeneration, input.idempotencyKey, digestA, digestB, digestC, digestD, digestE, "2026-08-30T00:00:00Z"],
  );
}

type LeaseOverrides = Partial<{ id: string; fencingToken: number }>;

async function insertLease(pool: ReturnType<typeof createPgPool>, overrides: LeaseOverrides = {}): Promise<void> {
  const input = { id: leaseId, fencingToken: 1, ...overrides };
  await pool.query(
    `INSERT INTO skill_architecture_sync_target_leases (
       id, target_id, run_id, target_generation, holder_id, fencing_token, status,
       acquired_at, expires_at, metadata, created_at, updated_at
     ) VALUES ($1, $2, $3, 2, 'holder-one', $4, 'active',
       '2026-08-30T00:00:00Z', '2026-08-30T01:00:00Z', '{}'::jsonb,
       '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z')`,
    [input.id, targetId, runId, input.fencingToken],
  );
}

type ReceiptOverrides = Partial<{
  id: string;
  fencingToken: number | null;
  kind: "run" | "step" | "lease" | "approval" | "baseline" | "apply" | "verify" | "rollback" | "recovery";
  code: string;
  evidenceDigest: string | null;
  message: string | null;
}>;

async function insertReceipt(pool: ReturnType<typeof createPgPool>, overrides: ReceiptOverrides = {}): Promise<void> {
  const input = {
    id: receiptId,
    fencingToken: null,
    kind: "run" as const,
    code: "accepted",
    evidenceDigest: null,
    message: null,
    ...overrides,
  };
  await pool.query(
    `INSERT INTO skill_architecture_sync_receipts (
       id, run_id, target_id, target_generation, fencing_token, kind, status, code, evidence_digest,
       recorded_at, message, metadata
     ) VALUES ($1, $2, $3, 2, $4, $5, 'accepted', $6, $7, '2026-08-30T00:30:00Z', $8, '{}'::jsonb)`,
    [input.id, runId, targetId, input.fencingToken, input.kind, input.code, input.evidenceDigest, input.message],
  );
}

async function insertBaseline(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_sync_baselines (
       id, run_id, target_id, target_generation, observed_digest, baseline_digest,
       restorable, captured_at, metadata, created_at
     ) VALUES ($1, $2, $3, 2, $4, $5, true,
       '2026-08-30T00:05:00Z', '{}'::jsonb, '2026-08-30T00:00:00Z')`,
    [baselineId, runId, targetId, digestC, digestE],
  );
}

type RecoveryEvidenceOverrides = Partial<{ id: string; fencingToken: number | null; code: string }>;

async function insertRecoveryEvidence(
  pool: ReturnType<typeof createPgPool>,
  overrides: RecoveryEvidenceOverrides = {},
): Promise<void> {
  const input = { id: recoveryEvidenceId, fencingToken: 1, code: "recovery.retry", ...overrides };
  await pool.query(
    `INSERT INTO skill_architecture_sync_recovery_evidence (
       id, run_id, target_id, target_generation, fencing_token, condition, decision,
       next_run_state, safe_to_retry, requires_manual_review, code, evidence_digest,
       recorded_at, metadata
     ) VALUES ($1, $2, $3, 2, $4, 'no-mutation', 'retry', 'queued', true, false,
       $5, $6, '2026-08-30T00:30:00Z', '{}'::jsonb)`,
    [input.id, runId, targetId, input.fencingToken, input.code, digestE],
  );
}

async function insertArchitecture(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  owner: string,
  slug: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, 'Sync control fixture', 'flat')`,
    [id, owner, slug],
  );
}

async function insertRevision(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  architecture: string,
  number: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_revisions (id, architecture_id, revision_number, message, spec, created_by_user_id)
     VALUES ($1, $2, $3, 'fixture', '{"schemaVersion":1,"pattern":{"id":"flat","version":1},"nodes":[],"edges":[],"environments":[],"profiles":[]}'::jsonb, $4)`,
    [id, architecture, number, ownerId],
  );
}

async function insertTarget(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  architecture: string,
  owner: string,
  generation: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_targets (
       id, architecture_id, owner_user_id, name, adapter_kind, adapter_contract_version,
       adapter_version, environment_id, profile_id, status, consent_status,
       consent_granted_at, capabilities, capabilities_digest, identity_digest, generation, metadata, health_summary,
       created_by_user_id
     ) VALUES ($1, $2, $3, 'Codex fixture', 'codex', 1, '1.0.0', 'personal', 'personal',
       'connected', 'granted', '2026-08-30T00:00:00Z'::timestamptz, '{"inventory.read":true}'::jsonb, $4, $5, $6,
       '{"provider":"fixture"}'::jsonb, '{"status":"healthy"}'::jsonb, $3)`,
    [id, architecture, owner, digestA, digestB, generation],
  );
}

async function insertObservation(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  target: string,
  generation: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_observations (
       id, target_id, generation, adapter_kind, adapter_contract_version, adapter_version,
       adapter_digest, capabilities_digest, observed_digest, observed_state, counts, health_summary
     ) VALUES ($1, $2, $3, 'codex', 1, '1.0.0', $4, $5, $6,
       '{"nodes":[]}'::jsonb, '{"nodes":0}'::jsonb, '{"status":"healthy"}'::jsonb)`,
    [id, target, generation, digestA, digestB, digestC],
  );
}

async function insertUser(pool: ReturnType<typeof createPgPool>, id: string, email: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, $2, $2, 'Sync fixture', 'active', now())`,
    [id, email],
  );
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for architecture sync-control migration tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0019_architecture_sync_control");
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

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isConstraintError(error: unknown, constraint: string): boolean {
  return (typeof error === "object" && error !== null && "constraint" in error && error.constraint === constraint)
    || (error instanceof Error && error.message.includes(constraint));
}

function isImmutableEvidenceError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55000";
}
