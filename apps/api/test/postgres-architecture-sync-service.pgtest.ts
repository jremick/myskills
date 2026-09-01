import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  architectureSyncObservedDigest,
  architectureSyncRecoveryEvidenceDigest,
  architectureSyncSnapshotDigest,
  decideArchitectureSyncRecovery,
  type ArchitectureSyncRecoveryCondition,
} from "@myskills-app/core";
import { ArchitectureSyncService, type ArchitectureSyncPorts, type ArchitectureSyncPreviewInput } from "../src/architecture-sync/service.js";
import { MemoryArchitectureSyncFixtureExecutor } from "../src/architecture-sync/fixture-executor.js";
import { ArchitectureSyncExecutorError, type ArchitectureSyncFixtureExecutor } from "../src/architecture-sync/types.js";
import { PostgresArchitectureSyncStore } from "../src/architecture-sync/postgres-store.js";
import { createDb, createPgPool } from "../src/db/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const now = new Date("2026-08-30T00:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const architectureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const revisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const observationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const observed = { nodes: [{ id: "leaf-a", enabled: false }] };
const observedDigest = architectureSyncObservedDigest(observed);

test("PostgresArchitectureSyncStore persists the fixture service journal atomically and replays idempotently", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const db = createDb(pool);
  const store = new PostgresArchitectureSyncStore(db, { now: () => new Date(now) });
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const ports: ArchitectureSyncPorts = {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort(),
  };
  let id = 0;
  const service = new ArchitectureSyncService(store, executor, ports, {
    now: () => new Date(now),
    idFactory: () => `${++id}`.padStart(32, "0"),
  });
  const previewInput = input();

  const [first, second] = await Promise.all([
    service.createPreviewRun(previewInput),
    service.createPreviewRun(previewInput),
  ]);
  const created = first.replayed ? second : first;
  const replay = first.replayed ? first : second;
  assert.equal(created.replayed, false);
  assert.equal(created.run.state, "drafted");
  assert.equal((await store.getRun(created.run.identity.runId))?.identity.runId, created.run.identity.runId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.identity.runId, created.run.identity.runId);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_architecture_sync_runs")).rows[0]?.count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skill_architecture_sync_steps")).rows[0]?.count, 2);

  const approved = await service.approve({ actor: ownerId, runId: created.run.identity.runId });
  assert.equal(approved.state, "approved");
  const applied = await service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" });
  assert.equal(applied.state, "succeeded");
  assert.deepEqual(applied.steps.map((step) => step.state), ["succeeded", "succeeded"]);
  assert.deepEqual((await store.getRun(applied.identity.runId))?.receipts.map((receipt) => receipt.kind), [
    "approval", "apply", "apply", "verify", "verify", "run",
  ]);
  assert.equal((await store.getCurrentLease(targetId)), null);

  const counts = (await pool.query(
    `SELECT step_count, receipt_count, recovery_evidence_count
       FROM skill_architecture_sync_runs WHERE id = $1`,
    [dbRunId(applied.identity.runId)],
  )).rows[0];
  assert.deepEqual(counts, { step_count: 2, receipt_count: 6, recovery_evidence_count: 0 });
  const leases = (await pool.query(
    "SELECT status, fencing_token FROM skill_architecture_sync_target_leases WHERE target_id = $1",
    [targetId],
  )).rows;
  assert.deepEqual(leases, [{ status: "released", fencing_token: "1" }]);
  const audits = await store.listAuditEvents();
  assert.ok(audits.some((event) => event.action === "sync.preview" && event.code === "run.created"));
  assert.ok(audits.some((event) => event.action === "sync.apply" && event.code === "run.succeeded"));
  await store.recordAuditEvent({
    runId: applied.identity.runId,
    actorId: "unseeded-audit-actor",
    action: "sync.audit",
    decision: "allow",
    code: "audit.test",
    recordedAt: now.toISOString(),
  });
  assert.ok((await store.listAuditEvents()).some((event) => event.actorId === "unseeded-audit-actor"));

  const tampered = structuredClone(applied);
  tampered.digests.desiredDigest = "e".repeat(64);
  await assert.rejects(
    store.saveRun(tampered),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_DIGEST_CONFLICT",
  );
});

test("PostgresArchitectureSyncStore replays a concurrent apply without blocking the winning lease", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const fixtureExecutor = new MemoryArchitectureSyncFixtureExecutor();
  let firstApply = true;
  let releaseExecutor!: () => void;
  let enteredExecutor!: () => void;
  const entered = new Promise<void>((resolve) => { enteredExecutor = resolve; });
  const released = new Promise<void>((resolve) => { releaseExecutor = resolve; });
  const executor: ArchitectureSyncFixtureExecutor = {
    kind: "fixture",
    apply: async (applyInput) => {
      if (firstApply) {
        firstApply = false;
        enteredExecutor();
        await released;
      }
      return fixtureExecutor.apply(applyInput);
    },
    verify: fixtureExecutor.verify.bind(fixtureExecutor),
    rollback: fixtureExecutor.rollback.bind(fixtureExecutor),
  };
  let id = 50;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort(),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "concurrent-apply-request",
    idempotencyKey: "concurrent-apply-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  const winner = service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "winner" });
  await entered;
  const replay = await service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "duplicate" });
  assert.equal(replay.state, "applying");
  assert.equal((await store.getCurrentLease(targetId))?.runId, approved.identity.runId);
  releaseExecutor();
  const applied = await winner;
  assert.equal(applied.state, "succeeded");
  assert.equal(await store.getCurrentLease(targetId), null);
});

test("PostgresArchitectureSyncStore rejects recovery while an apply lease is active", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const fixtureExecutor = new MemoryArchitectureSyncFixtureExecutor();
  let firstApply = true;
  let enteredExecutor!: () => void;
  let releaseExecutor!: () => void;
  const entered = new Promise<void>((resolve) => { enteredExecutor = resolve; });
  const released = new Promise<void>((resolve) => { releaseExecutor = resolve; });
  const executor: ArchitectureSyncFixtureExecutor = {
    kind: "fixture",
    apply: async (applyInput) => {
      if (firstApply) {
        firstApply = false;
        enteredExecutor();
        await released;
      }
      return fixtureExecutor.apply(applyInput);
    },
    verify: fixtureExecutor.verify.bind(fixtureExecutor),
    rollback: fixtureExecutor.rollback.bind(fixtureExecutor),
  };
  let id = 75;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("no-mutation"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "recovery-active-request",
    idempotencyKey: "recovery-active-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  const applying = service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "active-holder" });
  await entered;

  await assert.rejects(
    service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "no-mutation" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_CONFLICT",
  );
  assert.equal((await store.getCurrentLease(targetId))?.holderId, "active-holder");
  assert.equal((await store.getRun(approved.identity.runId))?.receipts.some((receipt) => receipt.kind === "recovery"), false);

  releaseExecutor();
  const applied = await applying;
  assert.equal(applied.state, "succeeded");
});

test("PostgresArchitectureSyncStore records recovery evidence and fences concurrent target leases", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const db = createDb(pool);
  const store = new PostgresArchitectureSyncStore(db, { now: () => new Date(now) });
  const executor = new MemoryArchitectureSyncFixtureExecutor({
    failure: { phase: "after-mutation-before-receipt", mutateBeforeThrow: true },
  });
  const ports: ArchitectureSyncPorts = {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("desired-readback"),
  };
  let id = 100;
  const service = new ArchitectureSyncService(store, executor, ports, {
    now: () => new Date(now),
    idFactory: () => `${++id}`.padStart(32, "0"),
  });
  const approved = await service.approve({
    actor: ownerId,
    runId: (await service.createPreviewRun(input())).run.identity.runId,
  });

  const firstLease = await store.acquireLease({
    runId: approved.identity.runId,
    targetId,
    targetGeneration: 2,
    holderId: "holder-one",
    now: now.toISOString(),
    leaseSeconds: 60,
  });
  const concurrent = await Promise.allSettled([
    store.acquireLease({
      runId: approved.identity.runId,
      targetId,
      targetGeneration: 2,
      holderId: "holder-two",
      now: now.toISOString(),
      leaseSeconds: 60,
    }),
    store.acquireLease({
      runId: approved.identity.runId,
      targetId,
      targetGeneration: 2,
      holderId: "holder-three",
      now: now.toISOString(),
      leaseSeconds: 60,
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 2);
  assert.equal((concurrent[0] as PromiseRejectedResult).reason.code, "ARCHITECTURE_SYNC_LEASE_CONFLICT");
  await store.releaseLease({ targetId, runId: approved.identity.runId, fencingToken: firstLease.fencingToken });
  const fenced = await store.acquireLease({
    runId: approved.identity.runId,
    targetId,
    targetGeneration: 2,
    holderId: "holder-two",
    now: now.toISOString(),
    leaseSeconds: 60,
  });
  assert.equal(fenced.fencingToken, firstLease.fencingToken + 1);
  await store.releaseLease({ targetId, runId: approved.identity.runId, fencingToken: fenced.fencingToken });

  await assert.rejects(
    service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED",
  );
  const interrupted = await store.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "applying");
  await releaseLeaseBeforeRecovery(store, interrupted);

  const recoveryRun = await service.recover({
    actor: ownerId,
    runId: approved.identity.runId,
    condition: "desired-readback",
  });
  assert.equal(recoveryRun.run.state, "succeeded");
  assert.equal(recoveryRun.run.receipts.at(-1)?.code, "recovery.succeed");
  const evidence = (await pool.query(
    `SELECT condition, decision, next_run_state, fencing_token, evidence_digest
       FROM skill_architecture_sync_recovery_evidence
      WHERE run_id = $1`,
    [dbRunId(approved.identity.runId)],
  )).rows;
  assert.deepEqual(evidence, [{
    condition: "desired-readback",
    decision: "succeed",
    next_run_state: "succeeded",
    fencing_token: "4",
    evidence_digest: recoveryEvidenceDigest(interrupted!, "desired-readback"),
  }]);
});

test("PostgresArchitectureSyncStore rolls back recovery transition, evidence, lease, and audit together", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  let fail = true;
  const store = new PostgresArchitectureSyncStore(createDb(pool), {
    now: () => new Date(now),
    onRecoveryPhase: (phase) => {
      if (fail && phase === "after-audit") throw new Error("injected recovery finalization failure");
    },
  });
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  let id = 150;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("no-mutation"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "recovery-atomic-pg-request",
    idempotencyKey: "recovery-atomic-pg-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }));
  const interrupted = await store.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "applying");
  await releaseLeaseBeforeRecovery(store, interrupted);

  await assert.rejects(
    service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "no-mutation" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECOVERY_FAILED",
  );
  const afterFailure = await store.getRun(approved.identity.runId);
  assert.equal(afterFailure?.state, "applying");
  assert.equal(afterFailure?.receipts.some((receipt) => receipt.kind === "recovery"), false);
  assert.deepEqual((await pool.query(
    `SELECT count(*)::int AS count FROM skill_architecture_sync_recovery_evidence WHERE run_id = $1`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ count: 0 }]);
  assert.deepEqual((await pool.query(
    `SELECT count(*)::int AS count
       FROM audit_events
      WHERE resource_type = 'architecture_sync'
        AND resource_id = $1
        AND details->>'syncDedupeKey' LIKE 'recovery-%'`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ count: 0 }]);
  assert.deepEqual((await pool.query(
    `SELECT status, fencing_token FROM skill_architecture_sync_target_leases WHERE target_id = $1`,
    [targetId],
  )).rows, [{ status: "released", fencing_token: "1" }]);

  fail = false;
  const recovered = await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "no-mutation" });
  assert.equal(recovered.run.state, "queued");
  assert.equal(recovered.run.lease?.fencingToken, 2);
  assert.deepEqual((await pool.query(
    `SELECT condition, decision, next_run_state, fencing_token
       FROM skill_architecture_sync_recovery_evidence WHERE run_id = $1`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ condition: "no-mutation", decision: "retry", next_run_state: "queued", fencing_token: "2" }]);
  assert.deepEqual((await pool.query(
    `SELECT kind, fencing_token FROM skill_architecture_sync_receipts
      WHERE run_id = $1 AND kind = 'recovery'`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ kind: "recovery", fencing_token: "2" }]);
  assert.deepEqual((await pool.query(
    `SELECT status, fencing_token FROM skill_architecture_sync_target_leases WHERE target_id = $1`,
    [targetId],
  )).rows, [{ status: "released", fencing_token: "2" }]);
  const replay = await service.recover({ actor: ownerId, runId: approved.identity.runId });
  assert.equal(replay.run.receipts.filter((receipt) => receipt.kind === "recovery").length, 1);
  assert.deepEqual((await pool.query(
    `SELECT count(*)::int AS count
       FROM audit_events
      WHERE resource_type = 'architecture_sync'
        AND resource_id = $1
        AND details->>'syncDedupeKey' LIKE 'recovery-%'`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ count: 1 }]);
});

test("PostgresArchitectureSyncStore persists no-mutation recovery and retries with a new fence", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  let id = 200;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("no-mutation"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "recovery-forward-request",
    idempotencyKey: "recovery-forward-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(
    service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED",
  );
  assert.equal((await store.getRun(approved.identity.runId))?.state, "applying");
  const interrupted = await store.getRun(approved.identity.runId);
  await releaseLeaseBeforeRecovery(store, interrupted);
  const claimRecovery = store.claimRecovery.bind(store);
  let invalidInputs = 0;
  store.claimRecovery = async (claim) => {
    for (const code of ["recovery.succeed", "recovery.unknown"]) {
      await assert.rejects(
        claimRecovery({ ...claim, recoveryReceipt: { ...claim.recoveryReceipt, code } }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID",
      );
      invalidInputs += 1;
    }
    return claimRecovery(claim);
  };
  const retriable = await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "no-mutation" });
  assert.equal(retriable.run.state, "queued");
  assert.equal(invalidInputs, 2);
  assert.deepEqual(retriable.run.steps.map((step) => step.state), ["prepared", "planned"]);
  assert.equal(retriable.run.receipts.at(-1)?.code, "recovery.retry");
  const evidence = (await pool.query(
    `SELECT condition, decision, next_run_state, fencing_token, evidence_digest
       FROM skill_architecture_sync_recovery_evidence
      WHERE run_id = $1`,
    [dbRunId(approved.identity.runId)],
  )).rows;
  assert.deepEqual(evidence, [{
    condition: "no-mutation",
    decision: "retry",
    next_run_state: "queued",
    fencing_token: "2",
    evidence_digest: recoveryEvidenceDigest(interrupted!, "no-mutation"),
  }]);
  const retried = await service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" });
  assert.equal(retried.state, "succeeded");
  assert.deepEqual(retried.steps.map((step) => step.state), ["succeeded", "succeeded"]);
  assert.equal((await store.getCurrentLease(targetId)), null);
  const fencedReceipts = (await pool.query(
    `SELECT kind, fencing_token
       FROM skill_architecture_sync_receipts
      WHERE run_id = $1 AND kind = 'recovery'
      ORDER BY (metadata->>'syncReceiptOrdinal')::integer`,
    [dbRunId(approved.identity.runId)],
  )).rows;
  assert.deepEqual(fencedReceipts, [{ kind: "recovery", fencing_token: "2" }]);
});

test("PostgresArchitectureSyncStore retries a started step without rewinding its timestamps", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const fixtureExecutor = new MemoryArchitectureSyncFixtureExecutor();
  let applyCount = 0;
  const executor: ArchitectureSyncFixtureExecutor = {
    kind: "fixture",
    apply: async (applyInput) => {
      applyCount += 1;
      if (applyCount === 2) throw new ArchitectureSyncExecutorError({ phase: "before-mutation" });
      return fixtureExecutor.apply(applyInput);
    },
    verify: fixtureExecutor.verify.bind(fixtureExecutor),
    rollback: fixtureExecutor.rollback.bind(fixtureExecutor),
  };
  let id = 250;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("no-mutation"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "started-step-recovery-request",
    idempotencyKey: "started-step-recovery-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }));
  const interrupted = await store.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "applying");
  assert.deepEqual(interrupted?.steps.map((step) => step.state), ["started", "prepared"]);
  await releaseLeaseBeforeRecovery(store, interrupted);
  const beforeStartedAt = (await pool.query(
    `SELECT started_at FROM skill_architecture_sync_steps
      WHERE run_id = $1 ORDER BY ordinal LIMIT 1`,
    [dbRunId(approved.identity.runId)],
  )).rows[0]?.started_at;
  const recovered = await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "no-mutation" });
  assert.equal(recovered.run.state, "queued");
  assert.deepEqual(recovered.run.steps.map((step) => step.state), ["prepared", "prepared"]);
  const afterStartedAt = (await pool.query(
    `SELECT started_at FROM skill_architecture_sync_steps
      WHERE run_id = $1 ORDER BY ordinal LIMIT 1`,
    [dbRunId(approved.identity.runId)],
  )).rows[0]?.started_at;
  assert.equal(afterStartedAt?.toISOString(), beforeStartedAt?.toISOString());
  assert.equal(await store.getCurrentLease(targetId), null);
});

test("PostgresArchitectureSyncStore persists rollback compensation for succeeded steps", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const fixtureExecutor = new MemoryArchitectureSyncFixtureExecutor();
  let verifyCount = 0;
  const executor: ArchitectureSyncFixtureExecutor = {
    kind: "fixture",
    apply: fixtureExecutor.apply.bind(fixtureExecutor),
    verify: async (verifyInput) => {
      verifyCount += 1;
      if (verifyCount === 2) {
        throw new ArchitectureSyncExecutorError({ phase: "verify", condition: "restorable-partial-state" });
      }
      return fixtureExecutor.verify(verifyInput);
    },
    rollback: fixtureExecutor.rollback.bind(fixtureExecutor),
  };
  let id = 300;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("restorable-partial-state"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "rollback-compensation-request",
    idempotencyKey: "rollback-compensation-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(
    service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED",
  );
  const partiallyApplied = await store.getRun(approved.identity.runId);
  assert.equal(partiallyApplied?.state, "verifying");
  assert.deepEqual(partiallyApplied?.steps.map((step) => step.state), ["succeeded", "started"]);
  await releaseLeaseBeforeRecovery(store, partiallyApplied);
  const recovery = await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "restorable-partial-state" });
  assert.equal(recovery.run.state, "rollback_required");
  const rolledBack = await service.rollback({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" });
  assert.equal(rolledBack.state, "rolled_back");
  assert.deepEqual(rolledBack.steps.map((step) => step.state), ["compensated", "started"]);
  assert.equal((await store.getCurrentLease(targetId)), null);
  const evidence = (await pool.query(
    `SELECT condition, decision, next_run_state, fencing_token, evidence_digest
       FROM skill_architecture_sync_recovery_evidence
      WHERE run_id = $1`,
    [dbRunId(approved.identity.runId)],
  )).rows;
  assert.deepEqual(evidence, [{
    condition: "restorable-partial-state",
    decision: "rollback",
    next_run_state: "rollback_required",
    fencing_token: "2",
    evidence_digest: recoveryEvidenceDigest(partiallyApplied!, "restorable-partial-state"),
  }]);
  const fencedReceipts = (await pool.query(
    `SELECT kind, fencing_token
       FROM skill_architecture_sync_receipts
      WHERE run_id = $1 AND kind IN ('recovery', 'rollback')
      ORDER BY (metadata->>'syncReceiptOrdinal')::integer`,
    [dbRunId(approved.identity.runId)],
  )).rows;
  assert.deepEqual(fencedReceipts, [
    { kind: "recovery", fencing_token: "2" },
    { kind: "rollback", fencing_token: "3" },
  ]);
  await assert.rejects(
    pool.query("UPDATE skill_architecture_sync_recovery_evidence SET code = 'tampered' WHERE run_id = $1", [dbRunId(approved.identity.runId)]),
    (error: unknown) => error instanceof Error && error.message.includes("append-only"),
  );
});

test("PostgresArchitectureSyncStore finalizes rollback throw cleanup without compensation", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const executor = rollbackFailureExecutor("throw");
  let id = 400;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("restorable-partial-state"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "rollback-throw-request",
    idempotencyKey: "rollback-throw-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(
    service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED",
  );
  const interrupted = await store.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "verifying");
  await releaseLeaseBeforeRecovery(store, interrupted);
  await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "restorable-partial-state" });
  await assert.rejects(
    service.rollback({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_ROLLBACK_FAILED",
  );
  const failed = await store.getRun(approved.identity.runId);
  assert.equal(failed?.state, "rollback_failed");
  assert.deepEqual(failed?.steps.map((step) => step.state), ["succeeded", "started"]);
  assert.equal(failed?.receipts.at(-1)?.kind, "rollback");
  assert.equal(failed?.receipts.at(-1)?.status, "failed");
  assert.equal(failed?.receipts.at(-1)?.code, "rollback.failed");
  assert.equal(await store.getCurrentLease(targetId), null);
  assert.deepEqual((await pool.query(
    `SELECT kind, status, code
       FROM skill_architecture_sync_receipts
      WHERE run_id = $1 AND kind = 'rollback'`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ kind: "rollback", status: "failed", code: "rollback.failed" }]);
  assert.deepEqual((await pool.query(
    `SELECT status FROM skill_architecture_sync_steps WHERE run_id = $1 ORDER BY ordinal`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ status: "succeeded" }, { status: "started" }]);
  const replay = await service.rollback({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" });
  assert.equal(replay.state, "rollback_failed");
  assert.equal(replay.receipts.filter((receipt) => receipt.kind === "rollback").length, 1);
  assert.equal((await pool.query(
    `SELECT count(*)::int AS count
       FROM audit_events
      WHERE resource_type = 'architecture_sync'
        AND resource_id = $1
        AND details->>'syncDedupeKey' = $2`,
    [dbRunId(approved.identity.runId), `terminal-${architectureSyncSnapshotDigest({ runId: approved.identity.runId, action: "rollback", code: "rollback.failed" })}`],
  )).rows[0]?.count, 1);
});

test("PostgresArchitectureSyncStore finalizes rollback ok:false cleanup without compensation", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await seedFixture(pool);
  const store = new PostgresArchitectureSyncStore(createDb(pool), { now: () => new Date(now) });
  const executor = rollbackFailureExecutor("false");
  let id = 500;
  const service = new ArchitectureSyncService(store, executor, {
    authorization: { authorize: async () => ({ allowed: true }) },
    mfa: { verify: async () => ({ allowed: true }) },
    consent: { check: async () => ({ allowed: true }) },
    recovery: recoveryPort("restorable-partial-state"),
  }, { now: () => new Date(now), idFactory: () => `${++id}`.padStart(32, "0") });
  const draft = await service.createPreviewRun(input({
    requestKey: "rollback-false-request",
    idempotencyKey: "rollback-false-intent",
  }));
  const approved = await service.approve({ actor: ownerId, runId: draft.run.identity.runId });
  await assert.rejects(service.apply({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }));
  await releaseLeaseBeforeRecovery(store, await store.getRun(approved.identity.runId));
  await service.recover({ actor: ownerId, runId: approved.identity.runId, condition: "restorable-partial-state" });
  await assert.rejects(
    service.rollback({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_ROLLBACK_FAILED",
  );
  const failed = await store.getRun(approved.identity.runId);
  assert.equal(failed?.state, "rollback_failed");
  assert.deepEqual(failed?.steps.map((step) => step.state), ["succeeded", "started"]);
  assert.equal(failed?.receipts.at(-1)?.kind, "rollback");
  assert.equal(failed?.receipts.at(-1)?.status, "failed");
  assert.equal(failed?.receipts.at(-1)?.code, "rollback.rejected");
  assert.equal(await store.getCurrentLease(targetId), null);
  assert.deepEqual((await pool.query(
    `SELECT kind, status, code
       FROM skill_architecture_sync_receipts
      WHERE run_id = $1 AND kind = 'rollback'`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ kind: "rollback", status: "failed", code: "rollback.rejected" }]);
  assert.deepEqual((await pool.query(
    `SELECT status FROM skill_architecture_sync_steps WHERE run_id = $1 ORDER BY ordinal`,
    [dbRunId(approved.identity.runId)],
  )).rows, [{ status: "succeeded" }, { status: "started" }]);
  const replay = await service.rollback({ actor: ownerId, runId: approved.identity.runId, holderId: "fixture-holder" });
  assert.equal(replay.state, "rollback_failed");
  assert.equal(replay.receipts.filter((receipt) => receipt.kind === "rollback").length, 1);
  assert.equal(await store.getCurrentLease(targetId), null);
});

function input(): ArchitectureSyncPreviewInput {
  return {
    actor: ownerId,
    requestKey: "fixture-request",
    idempotencyKey: "fixture-intent",
    targetId,
    targetGeneration: 2,
    architectureId,
    revisionId,
    profileId: "personal",
    environmentId: "personal-mac",
    desired: { nodes: [{ id: "leaf-a", enabled: true }] },
    compiled: { nodes: [{ id: "leaf-a", enabled: true }] },
    observed,
    steps: [
      { action: "install", nodeId: "leaf-a" },
      { action: "configure-router", nodeId: "router-root" },
    ],
    baseline: { restorable: true },
  };
}

function recoveryPort(condition: ArchitectureSyncRecoveryCondition = "desired-readback"): ArchitectureSyncPorts["recovery"] {
  return {
    read: async ({ run }) => {
      const sourceState = run.state as "lease_acquiring" | "revalidating" | "preparing" | "applying" | "verifying";
      const outcome = decideArchitectureSyncRecovery(condition);
      return {
        sourceState,
        condition,
        decision: outcome.decision,
        nextRunState: outcome.nextRunState,
        evidenceDigest: architectureSyncSnapshotDigest({
          runId: run.identity.runId,
          sourceState,
          condition,
          evidence: "postgres-fixture-readback",
        }),
      };
    },
  };
}

function recoveryEvidenceDigest(
  run: {
    readonly identity: {
      readonly runId: string;
      readonly targetId: string;
      readonly targetGeneration: number;
      readonly architectureId: string;
      readonly revisionId: string;
      readonly profileId: string;
      readonly environmentId: string;
    };
    readonly digests: {
      readonly desiredDigest: string;
      readonly compiledDigest: string;
      readonly observedDigest: string;
      readonly planDigest: string;
    };
    readonly state: string;
  },
  condition: ArchitectureSyncRecoveryCondition,
): string {
  const sourceState = run.state as "lease_acquiring" | "revalidating" | "preparing" | "applying" | "verifying";
  const outcome = decideArchitectureSyncRecovery(condition);
  return architectureSyncRecoveryEvidenceDigest({
    ...run.identity,
    ...run.digests,
    sourceState,
    condition,
    decision: outcome.decision,
    nextRunState: outcome.nextRunState,
    evidenceDigest: architectureSyncSnapshotDigest({
      runId: run.identity.runId,
      sourceState,
      condition,
      evidence: "postgres-fixture-readback",
    }),
  });
}

function rollbackFailureExecutor(mode: "throw" | "false"): ArchitectureSyncFixtureExecutor {
  const fixtureExecutor = new MemoryArchitectureSyncFixtureExecutor();
  let verifyCount = 0;
  return {
    kind: "fixture",
    apply: fixtureExecutor.apply.bind(fixtureExecutor),
    verify: async (verifyInput) => {
      verifyCount += 1;
      if (verifyCount === 2) {
        throw new ArchitectureSyncExecutorError({ phase: "verify", condition: "restorable-partial-state" });
      }
      return fixtureExecutor.verify(verifyInput);
    },
    rollback: async () => {
      if (mode === "throw") {
        throw new ArchitectureSyncExecutorError({ phase: "rollback", mutateBeforeThrow: true });
      }
      return {
        ok: false,
        receipt: {
          status: "failed",
          code: "rollback.rejected",
          metadata: { reason: "fixture" },
        },
      };
    },
  };
}

async function releaseLeaseBeforeRecovery(
  store: PostgresArchitectureSyncStore,
  run: Awaited<ReturnType<PostgresArchitectureSyncStore["getRun"]>>,
): Promise<void> {
  if (!run?.lease) return;
  await store.releaseLease({
    targetId: run.identity.targetId,
    runId: run.identity.runId,
    fencingToken: run.lease.fencingToken,
  });
}

async function freshPool(t: { after(callback: () => void): void }) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres architecture sync service tests.");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file.slice(0, -4)]);
    if (file === "0019_architecture_sync_control.sql") break;
  }
  return pool;
}

async function seedFixture(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, 'sync-store@example.com', 'sync-store@example.com', 'Sync store', 'active', $2)`,
    [ownerId, now],
  );
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, 'Sync fixture', '', 'flat')`,
    [architectureId, ownerId],
  );
  await pool.query(
    `INSERT INTO skill_architecture_revisions
       (id, architecture_id, revision_number, message, spec, created_by_user_id)
     VALUES ($1, $2, 1, 'Fixture', '{"schemaVersion":1}'::jsonb, $3)`,
    [revisionId, architectureId, ownerId],
  );
  await pool.query("UPDATE skill_architectures SET current_revision_id = $1 WHERE id = $2", [revisionId, architectureId]);
  await pool.query(
    `INSERT INTO skill_architecture_targets (
       id, architecture_id, owner_user_id, name, adapter_kind, adapter_contract_version,
       adapter_version, environment_id, profile_id, status, consent_status,
       consent_requested_at, consent_granted_at, capabilities, capabilities_digest,
       identity_digest, generation, metadata, health_summary, created_by_user_id
     ) VALUES ($1, $2, $3, 'Sync target', 'fixture', 1, '1.0.0', 'personal-mac', 'personal',
     'connected', 'granted', $4, $4, '{"inventory.read":true}'::jsonb, $5,
       $6, 2, '{}'::jsonb, '{}'::jsonb, $3)`,
    [targetId, architectureId, ownerId, now, "a".repeat(64), "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO skill_architecture_observations (
       id, target_id, generation, adapter_kind, adapter_contract_version, adapter_version,
       adapter_digest, capabilities_digest, observed_digest, observed_state, counts, health_summary,
       captured_at
     ) VALUES ($1, $2, 2, 'fixture', 1, '1.0.0', $3, $4, $5, $6::jsonb,
       '{"nodes":1}'::jsonb, '{"status":"healthy"}'::jsonb, $7)`,
    [observationId, targetId, "a".repeat(64), "b".repeat(64), observedDigest, JSON.stringify(observed), now],
  );
}

function dbRunId(publicId: string): string {
  const compact = publicId.replace(/^run-/, "");
  assert.match(compact, /^[0-9a-f]{32}$/i);
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
