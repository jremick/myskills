import assert from "node:assert/strict";
import test from "node:test";
import {
  architectureSyncSnapshotDigest,
  decideArchitectureSyncRecovery,
} from "@myskills-app/core";
import {
  ArchitectureSyncExecutorError,
  type ArchitectureSyncApplyInput,
  type ArchitectureSyncRecoveryAtomicPhase,
  type ArchitectureSyncRecoveryCondition,
  type ArchitectureSyncFixtureExecutor,
  type ArchitectureSyncPreviewInput,
  type ArchitectureSyncReceipt,
} from "../src/architecture-sync/types.js";
import { MemoryArchitectureSyncFixtureExecutor } from "../src/architecture-sync/fixture-executor.js";
import { MemoryArchitectureSyncStore } from "../src/architecture-sync/memory-store.js";
import { ArchitectureSyncService, type ArchitectureSyncPorts } from "../src/architecture-sync/service.js";

const now = new Date("2026-08-30T00:00:00.000Z");

interface FixtureOptions {
  readonly authorization?: (action: string) => boolean;
  readonly mfa?: boolean | (() => boolean);
  readonly consent?: (boundary: string) => boolean;
  readonly generation?: number | (() => number | undefined);
  readonly executor?: MemoryArchitectureSyncFixtureExecutor;
  readonly recovery?: ArchitectureSyncRecoveryCondition | (() => ArchitectureSyncRecoveryCondition);
  readonly onRecoveryPhase?: (phase: ArchitectureSyncRecoveryAtomicPhase) => void;
}

function fixture(options: FixtureOptions = {}) {
  const store = new MemoryArchitectureSyncStore({
    now: () => new Date(now),
    onRecoveryPhase: options.onRecoveryPhase,
  });
  const executor = options.executor ?? new MemoryArchitectureSyncFixtureExecutor();
  const ports: ArchitectureSyncPorts = {
    authorization: {
      authorize: async ({ action }) => ({ allowed: options.authorization?.(action) ?? true }),
    },
    mfa: {
      verify: async () => ({ allowed: typeof options.mfa === "function" ? options.mfa() : options.mfa ?? true }),
    },
    consent: {
      check: async ({ boundary }) => ({
        allowed: options.consent?.(boundary) ?? true,
        currentTargetGeneration: typeof options.generation === "function" ? options.generation() : options.generation,
      }),
    },
    recovery: {
      read: async ({ run }) => {
        const condition = typeof options.recovery === "function" ? options.recovery() : options.recovery ?? "no-mutation";
        const outcome = decideArchitectureSyncRecovery(condition);
        return {
          sourceState: run.state as "lease_acquiring" | "revalidating" | "preparing" | "applying" | "verifying",
          condition,
          decision: outcome.decision,
          nextRunState: outcome.nextRunState,
          evidenceDigest: architectureSyncSnapshotDigest({
            runId: run.identity.runId,
            sourceState: run.state,
            condition,
            evidence: "fixture-readback",
          }),
        };
      },
    },
  };
  let sequence = 0;
  const service = new ArchitectureSyncService(store, executor, ports, {
    now: () => new Date(now),
    idFactory: () => `fixture-${++sequence}`,
    defaultLeaseSeconds: 60,
    defaultApprovalSeconds: 900,
  });
  return { store, executor, service };
}

function input(overrides: Partial<ArchitectureSyncPreviewInput> = {}): ArchitectureSyncPreviewInput {
  return {
    actor: "owner-1",
    requestKey: "request-1",
    idempotencyKey: "intent-1",
    targetId: "target-1",
    targetGeneration: 2,
    architectureId: "architecture-1",
    revisionId: "revision-1",
    profileId: "personal",
    environmentId: "personal-mac",
    desired: { nodes: [{ id: "leaf-a", enabled: true }] },
    compiled: { nodes: [{ id: "leaf-a", enabled: true }] },
    observed: { nodes: [{ id: "leaf-a", enabled: false }] },
    steps: [
      { action: "install", nodeId: "leaf-a" },
      { action: "configure-router", nodeId: "router-root" },
    ],
    baseline: { restorable: true },
    ...overrides,
  };
}

async function approvedFixture(options: FixtureOptions = {}) {
  const result = fixture(options);
  const draft = await result.service.createPreviewRun(input());
  const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  return { ...result, draft: draft.run, approved };
}

async function applyInput(runId: string, overrides: Partial<ArchitectureSyncApplyInput> = {}): Promise<ArchitectureSyncApplyInput> {
  return { actor: "owner-1", runId, ...overrides };
}

test("preview is digest-only, side-effect-free, and request/idempotency replay is deterministic", async () => {
  const { service, store, executor } = fixture();
  const preview = await service.createPreviewRun(input());
  assert.equal(preview.replayed, false);
  assert.equal(preview.run.state, "drafted");
  assert.equal(preview.run.receipts.length, 0);
  assert.equal(preview.run.digests.desiredDigest.length, 64);
  assert.equal(executor.hasApplied(preview.run.identity.runId, "step-1"), false);

  const serialized = JSON.stringify(preview.run);
  assert.equal(/"(?:spec|path|url|prompt|credential|config)"/i.test(serialized), false);
  const replay = await service.createPreviewRun(input());
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.identity.runId, preview.run.identity.runId);
  assert.equal((await store.listAuditEvents()).length, 2);

  await assert.rejects(
    service.createPreviewRun(input({ desired: { nodes: [{ id: "different", enabled: true }] } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    service.createPreviewRun(input({ requestKey: "request-config-metadata", idempotencyKey: "intent-config-metadata", metadata: { config: "raw" } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_METADATA_INVALID",
  );
});

test("approval binds the actor and plan digest, then staged apply verifies in order", async () => {
  const { service, store, executor } = fixture();
  const draft = await service.createPreviewRun(input({ requestKey: "request-2", idempotencyKey: "intent-2" }));
  await assert.rejects(
    service.approve({ actor: "owner-1", runId: draft.run.identity.runId, expectedPlanDigest: "a".repeat(64) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_DIGEST_CONFLICT",
  );
  const approvedSecond = await service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  assert.equal(approvedSecond.state, "approved");
  const applied = await service.apply(await applyInput(approvedSecond.identity.runId));
  assert.equal(applied.state, "succeeded");
  assert.deepEqual(applied.steps.map((step) => step.state), ["succeeded", "succeeded"]);
  assert.deepEqual(applied.receipts.map((receipt) => receipt.kind), ["approval", "apply", "apply", "verify", "verify", "run"]);
  assert.equal((await store.getCurrentLease(applied.identity.targetId)), null);
  assert.equal(executor.hasApplied(applied.identity.runId, "step-1"), true);
  const replay = await service.apply(await applyInput(applied.identity.runId));
  assert.deepEqual(replay, applied);
});

test("concurrent apply deliveries replay in progress without blocking the winning lease", async () => {
  let entered = false;
  let releaseExecutor!: () => void;
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const originalApply = executor.apply.bind(executor);
  const enteredExecutor = new Promise<void>((resolve) => {
    executor.apply = async (args) => {
      entered = true;
      executor.apply = originalApply;
      resolve();
      await new Promise<void>((resolveRelease) => { releaseExecutor = resolveRelease; });
      return originalApply(args);
    };
  });
  const { service, store, approved } = await approvedFixture({ executor });
  const first = service.apply(await applyInput(approved.identity.runId));
  await enteredExecutor;
  assert.equal(entered, true);
  const second = await service.apply(await applyInput(approved.identity.runId, { holderId: "duplicate-holder" }));
  assert.equal(second.state, "applying");
  assert.equal((await store.getCurrentLease(approved.identity.targetId))?.runId, approved.identity.runId);
  releaseExecutor();
  const winner = await first;
  assert.equal(winner.state, "succeeded");
  assert.equal((await service.getRun(approved.identity.runId))?.state, "succeeded");
});

test("public digest and baseline identity cannot be changed after creation", async () => {
  const { service, store } = fixture();
  const draft = await service.createPreviewRun(input());
  const tampered = structuredClone(draft.run) as typeof draft.run & { digests: { desiredDigest: string } };
  tampered.digests.desiredDigest = "b".repeat(64);
  await assert.rejects(
    store.saveRun(tampered),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_DIGEST_CONFLICT",
  );
  await assert.rejects(
    store.saveRun({ ...draft.run, createdAt: "2026-08-30T00:00:01.000Z", updatedAt: "2026-08-30T00:00:01.000Z" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_TIMESTAMP_INVALID",
  );
  await assert.rejects(
    service.apply({ actor: "owner-1", runId: draft.run.identity.runId, expectedPlanDigest: "c".repeat(64) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_DIGEST_CONFLICT",
  );
});

test("MFA, authorization, consent, and target generation are fail-closed before apply", async () => {
  for (const scenario of [
    { setup: (state: { mfa: boolean; authorization: boolean; consent: boolean; generation?: number }) => { state.mfa = false; }, code: "ARCHITECTURE_SYNC_MFA_REQUIRED" },
    { setup: (state: { mfa: boolean; authorization: boolean; consent: boolean; generation?: number }) => { state.authorization = false; }, code: "ARCHITECTURE_SYNC_AUTHORIZATION_REQUIRED" },
    { setup: (state: { mfa: boolean; authorization: boolean; consent: boolean; generation?: number }) => { state.consent = false; }, code: "ARCHITECTURE_SYNC_CONSENT_REQUIRED" },
    { setup: (state: { mfa: boolean; authorization: boolean; consent: boolean; generation?: number }) => { state.generation = 3; }, code: "ARCHITECTURE_SYNC_GENERATION_STALE" },
  ] as const) {
    const state = { mfa: true, authorization: true, consent: true, generation: undefined as number | undefined };
    const result = fixture({
      mfa: () => state.mfa,
      authorization: () => state.authorization,
      consent: () => state.consent,
      generation: () => state.generation,
    });
    const draft = await result.service.createPreviewRun(input({ requestKey: `request-${scenario.code}`, idempotencyKey: `intent-${scenario.code}` }));
    const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
    scenario.setup(state);
    await assert.rejects(
      result.service.apply(await applyInput(approved.identity.runId)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === scenario.code,
    );
    assert.equal((await result.service.getRun(approved.identity.runId))?.state, "blocked");
  }
});

test("mutation capability claims are rejected before a preview run is persisted", async () => {
  const { service } = fixture();
  await assert.rejects(
    service.createPreviewRun(input({ capabilities: { "inventory.read": true, apply: true } })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_CAPABILITY_INVALID",
  );
});

test("the five deterministic recovery branches produce their core outcomes", async () => {
  const expected = [
    ["no-mutation", "queued"],
    ["desired-readback", "succeeded"],
    ["restorable-partial-state", "rollback_required"],
    ["ambiguous-readback", "blocked"],
    ["irreversible-unrecoverable", "rollback_failed"],
  ] as const;
  for (const [condition, state] of expected) {
    const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "after-mutation-before-receipt", mutateBeforeThrow: true } });
    const fixtureState = await approvedFixture({ executor, recovery: condition });
    await assert.rejects(fixtureState.service.apply(await applyInput(fixtureState.approved.identity.runId)));
    // Recovery must wait for the failed apply holder to release or expire.
    fixtureState.store.expireLease(fixtureState.approved.identity.targetId);
    const result = await fixtureState.service.recover({ actor: "owner-1", runId: fixtureState.approved.identity.runId, condition });
    assert.equal(result.recovery.condition, condition);
    assert.equal(result.run.state, state);
    assert.equal(result.run.receipts.at(-1)?.kind, "recovery");
    assert.match(result.run.receipts.at(-1)?.evidenceDigest ?? "", /^[a-f0-9]{64}$/);
  }
});

test("recovery uses trusted evidence instead of a caller condition and binds the run state", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  const { service, approved } = await approvedFixture({ executor, recovery: "no-mutation" });
  await assert.rejects(service.apply(await applyInput(approved.identity.runId)));
  await assert.rejects(
    service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "desired-readback" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT",
  );
  const interrupted = await service.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "applying");
  assert.equal(interrupted?.receipts.some((receipt) => receipt.kind === "recovery"), false);
});

test("recovery cannot overlap an active apply holder, including the same run", async () => {
  let firstApply = true;
  let entered!: () => void;
  let release!: () => void;
  const enteredApply = new Promise<void>((resolve) => { entered = resolve; });
  const releasedApply = new Promise<void>((resolve) => { release = resolve; });
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const originalApply = executor.apply.bind(executor);
  executor.apply = async (args) => {
    if (firstApply) {
      firstApply = false;
      entered();
      await releasedApply;
    }
    return originalApply(args);
  };
  const fixtureState = await approvedFixture({ executor, recovery: "no-mutation" });
  const applying = fixtureState.service.apply(await applyInput(fixtureState.approved.identity.runId));
  await enteredApply;

  await assert.rejects(
    fixtureState.service.recover({ actor: "owner-1", runId: fixtureState.approved.identity.runId, condition: "no-mutation" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_CONFLICT",
  );
  assert.equal((await fixtureState.store.getCurrentLease(fixtureState.approved.identity.targetId))?.holderId, "owner-1");
  assert.equal((await fixtureState.store.getRun(fixtureState.approved.identity.runId))?.receipts.some((receipt) => receipt.kind === "recovery"), false);

  release();
  const applied = await applying;
  assert.equal(applied.state, "succeeded");
});

test("memory recovery finalization rolls back transition, evidence, lease, and audit together", async () => {
  let fail = true;
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  const fixtureState = fixture({
    executor,
    recovery: "no-mutation",
    onRecoveryPhase: (phase) => {
      if (fail && phase === "after-audit") throw new Error("injected recovery finalization failure");
    },
  });
  const draft = await fixtureState.service.createPreviewRun(input({
    requestKey: "recovery-atomic-request",
    idempotencyKey: "recovery-atomic-intent",
  }));
  const approved = await fixtureState.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  await assert.rejects(fixtureState.service.apply(await applyInput(approved.identity.runId)));
  const interrupted = await fixtureState.service.getRun(approved.identity.runId);
  assert.equal(interrupted?.state, "applying");
  const oldFence = interrupted?.lease?.fencingToken;
  fixtureState.store.expireLease(approved.identity.targetId);

  await assert.rejects(
    fixtureState.service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "no-mutation" }),
    /injected recovery finalization failure/,
  );
  const afterFailure = await fixtureState.service.getRun(approved.identity.runId);
  assert.equal(afterFailure?.state, "applying");
  assert.equal(afterFailure?.receipts.some((receipt) => receipt.kind === "recovery"), false);
  assert.equal(await fixtureState.store.getCurrentLease(approved.identity.targetId), null);
  assert.equal((await fixtureState.store.listAuditEvents()).some((event) => event.dedupeKey?.startsWith("recovery-")), false);

  fail = false;
  const recovered = await fixtureState.service.recover({ actor: "owner-1", runId: approved.identity.runId });
  assert.equal(recovered.run.state, "queued");
  assert.equal(recovered.run.lease?.fencingToken, (oldFence ?? 0) + 1);
  const replay = await fixtureState.service.recover({ actor: "owner-1", runId: approved.identity.runId });
  assert.equal(replay.run.state, "queued");
  assert.equal(replay.run.receipts.filter((receipt) => receipt.kind === "recovery").length, 1);
  assert.equal((await fixtureState.store.listAuditEvents()).filter((event) => event.dedupeKey?.startsWith("recovery-")).length, 1);
});

test("recovery refuses an approved run before consulting trusted evidence", async () => {
  const result = fixture();
  const draft = await result.service.createPreviewRun(input({ requestKey: "approved-recovery-request", idempotencyKey: "approved-recovery-intent" }));
  const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  await assert.rejects(
    result.service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "desired-readback" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECOVERY_STATE_INVALID",
  );
});

test("before-mutation crash can be retried after no-mutation recovery", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  const fixtureState = await approvedFixture({ executor, recovery: "no-mutation" });
  await assert.rejects(
    fixtureState.service.apply(await applyInput(fixtureState.approved.identity.runId)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED",
  );
  assert.equal((await fixtureState.service.getRun(fixtureState.approved.identity.runId))?.state, "applying");
  fixtureState.store.expireLease(fixtureState.approved.identity.targetId);
  const recovered = await fixtureState.service.recover({ actor: "owner-1", runId: fixtureState.approved.identity.runId, condition: "no-mutation" });
  assert.equal(recovered.run.state, "queued");
  executor.clearFailure();
  const applied = await fixtureState.service.apply(await applyInput(fixtureState.approved.identity.runId));
  assert.equal(applied.state, "succeeded");
});

test("after-mutation crash and verify crash are recoverable without exposing raw state", async () => {
  const afterMutation = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "after-mutation-before-receipt", mutateBeforeThrow: true } });
  const first = await approvedFixture({ executor: afterMutation, recovery: "desired-readback" });
  const approved = first.approved;
  await assert.rejects(first.service.apply(await applyInput(approved.identity.runId)), (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED");
  first.store.expireLease(approved.identity.targetId);
  const recovered = await first.service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "desired-readback" });
  assert.equal(recovered.run.state, "succeeded");
  assert.equal(recovered.run.steps.every((step) => step.state === "succeeded"), true);

  const verifyExecutor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "verify", condition: "restorable-partial-state", mutateBeforeThrow: true } });
  const second = await approvedFixture({ executor: verifyExecutor, recovery: "restorable-partial-state" });
  const secondApproved = second.approved;
  await assert.rejects(second.service.apply(await applyInput(secondApproved.identity.runId)), (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_EXECUTOR_FAILED");
  second.store.expireLease(secondApproved.identity.targetId);
  const secondRecovered = await second.service.recover({ actor: "owner-1", runId: secondApproved.identity.runId, condition: "restorable-partial-state" });
  assert.equal(secondRecovered.run.state, "rollback_required");
});

test("rollback restores an explicit baseline and records failure safely", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "verify", condition: "restorable-partial-state" } });
  const fixtureState = await approvedFixture({ executor, recovery: "restorable-partial-state" });
  await assert.rejects(fixtureState.service.apply(await applyInput(fixtureState.approved.identity.runId)));
  fixtureState.store.expireLease(fixtureState.approved.identity.targetId);
  const recovered = await fixtureState.service.recover({ actor: "owner-1", runId: fixtureState.approved.identity.runId, condition: "restorable-partial-state" });
  assert.equal(recovered.run.state, "rollback_required");
  const run = await fixtureState.service.getRun(fixtureState.approved.identity.runId);
  assert.equal(run?.state, "rollback_required");
  executor.clearFailure();
  const rolledBack = await fixtureState.service.rollback({ actor: "owner-1", runId: fixtureState.approved.identity.runId });
  assert.equal(rolledBack.state, "rolled_back");
  assert.equal(executor.wasRolledBack(fixtureState.approved.identity.runId), true);
  assert.equal(rolledBack.receipts.at(-1)?.code, "baseline.restored");

  const failedExecutor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "verify", condition: "restorable-partial-state" } });
  const failed = await approvedFixture({ executor: failedExecutor, recovery: "restorable-partial-state" });
  const failedApproved = failed.approved;
  await assert.rejects(failed.service.apply(await applyInput(failedApproved.identity.runId)));
  failed.store.expireLease(failedApproved.identity.targetId);
  await failed.service.recover({ actor: "owner-1", runId: failedApproved.identity.runId, condition: "restorable-partial-state" });
  failedExecutor.clearFailure();
  failedExecutor.injectFailure({ phase: "rollback", mutateBeforeThrow: true });
  await assert.rejects(failed.service.rollback({ actor: "owner-1", runId: failedApproved.identity.runId }));
  assert.equal((await failed.service.getRun(failedApproved.identity.runId))?.state, "rollback_failed");
});

test("rollback ok:false leaves rollback_failed, no compensation, and no current lease", async () => {
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
    rollback: async () => ({
      ok: false,
      receipt: { status: "failed", code: "rollback.rejected", metadata: { reason: "fixture" } },
    }),
  };
  const result = fixture({ executor, recovery: "restorable-partial-state" });
  const draft = await result.service.createPreviewRun(input({ requestKey: "rollback-false-request", idempotencyKey: "rollback-false-intent" }));
  const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  await assert.rejects(result.service.apply(await applyInput(approved.identity.runId)));
  result.store.expireLease(approved.identity.targetId);
  await result.service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "restorable-partial-state" });
  await assert.rejects(
    result.service.rollback({ actor: "owner-1", runId: approved.identity.runId }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_ROLLBACK_FAILED",
  );
  const failed = await result.service.getRun(approved.identity.runId);
  assert.equal(failed?.state, "rollback_failed");
  assert.deepEqual(failed?.steps.map((step) => step.state), ["succeeded", "started"]);
  assert.equal(failed?.receipts.at(-1)?.code, "rollback.rejected");
  assert.equal(await result.store.getCurrentLease(approved.identity.targetId), null);
  const replay = await result.service.rollback({ actor: "owner-1", runId: approved.identity.runId });
  assert.equal(replay.receipts.filter((receipt) => receipt.kind === "rollback").length, 1);
  assert.equal((await result.store.listAuditEvents()).filter((event) => event.dedupeKey?.startsWith("terminal-")).length, 1);
});

test("authority revocation and lease loss block during safe boundaries", async () => {
  let allow = true;
  let applyCalls = 0;
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const first = fixture({
    executor,
    authorization: () => allow,
  });
  const draft = await first.service.createPreviewRun(input());
  const approved = await first.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  const originalApply = executor.apply.bind(executor);
  executor.apply = async (args) => {
    const result = await originalApply(args);
    applyCalls += 1;
    if (applyCalls === 1) allow = false;
    return result;
  };
  await assert.rejects(first.service.apply(await applyInput(approved.identity.runId)), (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_AUTHORIZATION_REQUIRED");
  assert.equal((await first.service.getRun(approved.identity.runId))?.state, "blocked");

  const leaseExecutor = new MemoryArchitectureSyncFixtureExecutor();
  const second = fixture({ executor: leaseExecutor });
  const secondDraft = await second.service.createPreviewRun(input({ requestKey: "request-lease-loss", idempotencyKey: "intent-lease-loss" }));
  const secondApproved = await second.service.approve({ actor: "owner-1", runId: secondDraft.run.identity.runId });
  const originalLeaseApply = leaseExecutor.apply.bind(leaseExecutor);
  leaseExecutor.apply = async (args) => {
    const result = await originalLeaseApply(args);
    second.store.expireLease(args.run.identity.targetId);
    return result;
  };
  await assert.rejects(second.service.apply(await applyInput(secondApproved.identity.runId)), (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_LOST");
  const blocked = await second.service.getRun(secondApproved.identity.runId);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.failure?.class, "lease-lost");
});

test("consent revocation is rechecked at the next safe boundary", async () => {
  let consentAllowed = true;
  let applyCalls = 0;
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const result = fixture({
    executor,
    consent: () => consentAllowed,
  });
  const draft = await result.service.createPreviewRun(input({ requestKey: "request-consent-loss", idempotencyKey: "intent-consent-loss" }));
  const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  const originalApply = executor.apply.bind(executor);
  executor.apply = async (args) => {
    const value = await originalApply(args);
    applyCalls += 1;
    if (applyCalls === 1) consentAllowed = false;
    return value;
  };

  await assert.rejects(
    result.service.apply(await applyInput(approved.identity.runId)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_CONSENT_REQUIRED",
  );
  const blocked = await result.service.getRun(approved.identity.runId);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.failure?.class, "consent");
});

test("memory store rejects write-like receipts without a current or matching fence", async () => {
  const { service, store } = fixture();
  const draft = await service.createPreviewRun(input({ requestKey: "request-fence-store", idempotencyKey: "intent-fence-store" }));
  const makeReceipt = (id: string, stepId?: string): ArchitectureSyncReceipt => ({
    schemaVersion: 1,
    id,
    runId: draft.run.identity.runId,
    ...(stepId ? { stepId } : {}),
    kind: "apply",
    status: "started",
    code: "step.started",
    recordedAt: now.toISOString(),
  });

  await assert.rejects(
    store.saveRun({ ...draft.run, receipts: [makeReceipt("receipt-no-lease")] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_LOST",
  );
  await assert.rejects(
    store.saveRun({ ...draft.run, metadata: { config: "raw" } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_METADATA_INVALID",
  );
  await assert.rejects(
    store.saveRun({ ...draft.run, receipts: [makeReceipt("receipt-invalid-step", "missing-step")] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECEIPT_INVALID",
  );

  const firstLease = await store.acquireLease({
    runId: draft.run.identity.runId,
    targetId: draft.run.identity.targetId,
    targetGeneration: draft.run.identity.targetGeneration,
    holderId: "owner-1",
    now: now.toISOString(),
    leaseSeconds: 60,
  });
  const withLease = { ...draft.run, lease: firstLease };
  const withReceipt = await store.saveRun({ ...withLease, receipts: [makeReceipt("receipt-current")] });
  store.expireLease(draft.run.identity.targetId);
  await store.acquireLease({
    runId: draft.run.identity.runId,
    targetId: draft.run.identity.targetId,
    targetGeneration: draft.run.identity.targetGeneration,
    holderId: "owner-1",
    now: now.toISOString(),
    leaseSeconds: 60,
  });

  await assert.rejects(
    store.saveRun({
      ...withReceipt,
      receipts: [...withReceipt.receipts, makeReceipt("receipt-stale-fence")],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_LOST",
  );
});

test("memory leases bind to persisted runs and audit dedupe is scoped per run", async () => {
  const { service, store } = fixture();
  const first = await service.createPreviewRun(input());
  const second = await service.createPreviewRun(input({ requestKey: "request-audit-second", idempotencyKey: "intent-audit-second" }));

  await assert.rejects(
    store.acquireLease({
      runId: "missing-run",
      targetId: first.run.identity.targetId,
      targetGeneration: first.run.identity.targetGeneration,
      holderId: "owner-1",
      now: now.toISOString(),
      leaseSeconds: 60,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RUN_NOT_FOUND",
  );
  await assert.rejects(
    store.acquireLease({
      runId: first.run.identity.runId,
      targetId: "different-target",
      targetGeneration: first.run.identity.targetGeneration,
      holderId: "owner-1",
      now: now.toISOString(),
      leaseSeconds: 60,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_BINDING_CONFLICT",
  );
  await assert.rejects(
    store.releaseLease({ targetId: first.run.identity.targetId, runId: first.run.identity.runId, fencingToken: 0 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_INVALID",
  );

  const lease = await store.acquireLease({
    runId: first.run.identity.runId,
    targetId: first.run.identity.targetId,
    targetGeneration: first.run.identity.targetGeneration,
    holderId: "owner-1",
    now: now.toISOString(),
    leaseSeconds: 60,
  });
  const leased = await store.saveRun({ ...first.run, lease });
  await assert.rejects(
    store.saveRun({ ...leased, lease: { ...lease, holderId: "spoofed-holder" } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_FENCE_STALE",
  );

  const record = async (runId: string) => store.recordAuditEvent({
    runId,
    actorId: "owner-1",
    action: "sync.test",
    decision: "allow",
    code: "audit.dedupe",
    recordedAt: now.toISOString(),
    dedupeKey: "same-key",
  });
  await record(first.run.identity.runId);
  await record(first.run.identity.runId);
  await record(second.run.identity.runId);
  const matching = (await store.listAuditEvents()).filter((event) => event.dedupeKey === "same-key");
  assert.equal(matching.length, 2);
  assert.deepEqual(new Set(matching.map((event) => event.runId)), new Set([first.run.identity.runId, second.run.identity.runId]));
});

test("memory rollback does not commit compensation after lease loss", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "verify", condition: "restorable-partial-state" } });
  const result = fixture({ executor, recovery: "restorable-partial-state" });
  const originalRollback = executor.rollback.bind(executor);
  executor.rollback = async (args) => {
    const outcome = await originalRollback(args);
    result.store.expireLease(args.run.identity.targetId);
    return outcome;
  };
  const draft = await result.service.createPreviewRun(input({ requestKey: "rollback-fenced-request", idempotencyKey: "rollback-fenced-intent" }));
  const approved = await result.service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  await assert.rejects(result.service.apply(await applyInput(approved.identity.runId)));
  result.store.expireLease(approved.identity.targetId);
  await result.service.recover({ actor: "owner-1", runId: approved.identity.runId, condition: "restorable-partial-state" });
  executor.clearFailure();

  await assert.rejects(
    result.service.rollback({ actor: "owner-1", runId: approved.identity.runId }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_LEASE_LOST",
  );
  const blocked = await result.service.getRun(approved.identity.runId);
  assert.equal(blocked?.state, "blocked");
  assert.equal(blocked?.steps.some((step) => step.state === "compensated"), false);
  assert.equal(blocked?.receipts.some((receipt) => receipt.code === "rollback.succeeded"), false);
});

test("memory recovery claims reject mismatched and unknown receipt codes", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor({ failure: { phase: "before-mutation" } });
  const result = await approvedFixture({ executor, recovery: "no-mutation" });
  await assert.rejects(result.service.apply(await applyInput(result.approved.identity.runId)));
  result.store.expireLease(result.approved.identity.targetId);

  const claimRecovery = result.store.claimRecovery.bind(result.store);
  let invalidInputs = 0;
  result.store.claimRecovery = async (claim) => {
    for (const code of ["recovery.succeed", "recovery.unknown"]) {
      await assert.rejects(
        claimRecovery({ ...claim, recoveryReceipt: { ...claim.recoveryReceipt, code } }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID",
      );
      invalidInputs += 1;
    }
    return claimRecovery(claim);
  };

  const recovered = await result.service.recover({ actor: "owner-1", runId: result.approved.identity.runId });
  assert.equal(recovered.run.state, "queued");
  assert.equal(invalidInputs, 2);
});

test("concurrent terminal retries replay the committed receipt", async () => {
  const { service, store } = fixture();
  const draft = await service.createPreviewRun(input({ requestKey: "terminal-retry-request", idempotencyKey: "terminal-retry-intent" }));
  const approved = await service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  const lease = await store.acquireLease({
    runId: approved.identity.runId,
    targetId: approved.identity.targetId,
    targetGeneration: approved.identity.targetGeneration,
    holderId: "owner-1",
    now: now.toISOString(),
    leaseSeconds: 60,
  });
  let terminal = await store.saveRun({ ...approved, lease, state: "queued", updatedAt: now.toISOString() });
  for (const state of ["lease_acquiring", "revalidating", "preparing", "applying", "verifying", "succeeded"] as const) {
    terminal = await store.saveRun({ ...terminal, state, updatedAt: now.toISOString() });
  }

  const [first, second] = await Promise.all([
    service.apply(await applyInput(terminal.identity.runId)),
    service.apply(await applyInput(terminal.identity.runId, { holderId: "retry-holder" })),
  ]);
  assert.equal(first.state, "succeeded");
  assert.deepEqual(second, first);
  assert.equal(first.receipts.filter((receipt) => receipt.kind === "run" && receipt.code === "run.succeeded").length, 1);
});

test("completed apply claims repair terminal evidence after a state-only commit", async () => {
  const { service, store } = fixture();
  const draft = await service.createPreviewRun(input({ requestKey: "completed-claim-request", idempotencyKey: "completed-claim-intent" }));
  const approved = await service.approve({ actor: "owner-1", runId: draft.run.identity.runId });
  const originalGetRun = store.getRun.bind(store);
  let staged = false;
  store.getRun = async (runId) => {
    const current = await originalGetRun(runId);
    if (staged || !current || current.state !== "approved") return current;
    staged = true;
    const lease = await store.acquireLease({
      runId: current.identity.runId,
      targetId: current.identity.targetId,
      targetGeneration: current.identity.targetGeneration,
      holderId: "owner-1",
      now: now.toISOString(),
      leaseSeconds: 60,
    });
    let terminal = await store.saveRun({ ...current, lease, state: "queued", updatedAt: now.toISOString() });
    for (const state of ["lease_acquiring", "revalidating", "preparing", "applying", "verifying", "succeeded"] as const) {
      terminal = await store.saveRun({ ...terminal, state, updatedAt: now.toISOString() });
    }
    return current;
  };

  const repaired = await service.apply(await applyInput(approved.identity.runId));
  assert.equal(repaired.state, "succeeded");
  assert.equal(repaired.receipts.filter((receipt) => receipt.kind === "run" && receipt.code === "run.succeeded").length, 1);
  assert.equal(await store.getCurrentLease(approved.identity.targetId), null);
  assert.equal((await store.listAuditEvents()).filter((event) => event.dedupeKey?.startsWith("terminal-")).length, 1);
});

test("write-like receipts require a current lease and sanitized executor metadata", async () => {
  const executor = new MemoryArchitectureSyncFixtureExecutor();
  const { service, store, approved } = await approvedFixture({ executor });
  const originalApply = executor.apply.bind(executor);
  executor.apply = async (args) => ({
    ...(await originalApply(args)),
    receipt: {
      status: "succeeded",
      code: "unsafe",
      metadata: { path: "/Users/private", prompt: "do-not-store" } as never,
    },
  });
  const applied = await service.apply(await applyInput(approved.identity.runId));
  const publicText = JSON.stringify({ run: applied, audits: await store.listAuditEvents() });
  assert.equal(publicText.includes("/Users/private"), false);
  assert.equal(publicText.includes("do-not-store"), false);
  await assert.rejects(
    store.recordAuditEvent({
      runId: applied.identity.runId,
      actorId: "owner-1",
      action: "sync.test",
      decision: "allow",
      code: "audit.test",
      recordedAt: now.toISOString(),
      metadata: { path: "/Users/private" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_SYNC_METADATA_INVALID",
  );
  await store.recordAuditEvent({
    runId: applied.identity.runId,
    actorId: "owner-1",
    action: "sync.test",
    decision: "allow",
    code: "audit.test",
    recordedAt: now.toISOString(),
    metadata: { z: 1, profile: "personal", a: true },
  });
  assert.deepEqual((await store.listAuditEvents(1))[0]?.metadata, { a: true, profile: "personal", z: 1 });
});
