import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureSyncCapabilityNames,
  architectureSyncCompiledDigest,
  architectureSyncDesiredDigest,
  architectureSyncFailureClasses,
  architectureSyncMutationCapabilities,
  architectureSyncObservedDigest,
  architectureSyncPlanDigest,
  architectureSyncRecoveryConditions,
  architectureSyncRunIdentityDigest,
  architectureSyncRecoveryEvidenceDigest,
  architectureSyncRecoverySourceStates,
  architectureSyncRunStates,
  architectureSyncSnapshotDigest,
  architectureSyncStepIdempotencyKey,
  architectureSyncStepStates,
  architectureSyncStepStateTransitions,
  architectureSyncRunStateTransitions,
  architectureSyncOrderedDigest,
  assertCurrentArchitectureSyncLease,
  assertValidArchitectureSyncFencingRecord,
  assertValidArchitectureSyncRun,
  assertValidArchitectureSyncRunIdentity,
  compareArchitectureSyncStepIdempotency,
  createArchitectureSyncDigests,
  decideArchitectureSyncRecovery,
  isArchitectureSyncLeaseCurrent,
  isValidArchitectureSyncRecoveryStepTransition,
  isValidArchitectureSyncRecoveryTransition,
  isValidArchitectureSyncRunTransition,
  isValidArchitectureSyncStepTransition,
  MAX_SYNC_RECEIPTS,
  MAX_SYNC_STEPS,
  validateArchitectureSyncCapabilities,
  validateArchitectureSyncDigests,
  validateArchitectureSyncFencingRecord,
  validateArchitectureSyncLease,
  validateArchitectureSyncRun,
  validateArchitectureSyncStep,
  type ArchitectureSyncApproval,
  type ArchitectureSyncBaseline,
  type ArchitectureSyncReceipt,
  type ArchitectureSyncRun,
  type ArchitectureSyncRunIdentity,
  type ArchitectureSyncStep,
} from "../src/architecture-sync-control.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const timestamp = "2026-08-30T00:00:00Z";

const identity: ArchitectureSyncRunIdentity = {
  schemaVersion: 1,
  runId: "run-1",
  targetId: "target-1",
  targetGeneration: 4,
  architectureId: "architecture-1",
  revisionId: "revision-1",
  profileId: "profile-1",
  environmentId: "environment-1",
};

function plannedSteps(): ArchitectureSyncStep[] {
  return [
    {
      schemaVersion: 1,
      id: "step-1",
      ordinal: 1,
      action: "install",
      nodeId: "leaf-a",
      targetGeneration: identity.targetGeneration,
      state: "planned",
      idempotencyKey: "placeholder-1",
      metadata: { source: "fixture" },
    },
    {
      schemaVersion: 1,
      id: "step-2",
      ordinal: 2,
      action: "configure-router",
      nodeId: "router-a",
      targetGeneration: identity.targetGeneration,
      state: "planned",
      idempotencyKey: "placeholder-2",
      metadata: { source: "fixture" },
    },
  ];
}

function keyedSteps(): ArchitectureSyncStep[] {
  const steps = plannedSteps();
  const planDigest = architectureSyncPlanDigest(steps);
  return steps.map((step) => ({
    ...step,
    idempotencyKey: architectureSyncStepIdempotencyKey({ identity, planDigest, step }),
  }));
}

function approval(planDigest: string): ArchitectureSyncApproval {
  return {
    schemaVersion: 1,
    id: "approval-1",
    runId: identity.runId,
    actorId: "user-1",
    planDigest,
    approvedAt: timestamp,
  };
}

function baseline(): ArchitectureSyncBaseline {
  return {
    schemaVersion: 1,
    id: "baseline-1",
    runId: identity.runId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    observedDigest: digestA,
    restorable: true,
    capturedAt: timestamp,
  };
}

function runFixture(state: ArchitectureSyncRun["state"] = "drafted"): ArchitectureSyncRun {
  const steps = keyedSteps();
  const planDigest = architectureSyncPlanDigest(steps);
  const currentApproval = state === "drafted" || state === "awaiting_approval" ? undefined : approval(planDigest);
  const currentBaseline = ["applying", "verifying", "succeeded", "rollback_required", "rolling_back", "rolled_back", "rollback_failed"].includes(state)
    ? baseline()
    : undefined;
  const digests = {
    desiredDigest: architectureSyncDesiredDigest({ nodes: ["leaf-a"] }),
    compiledDigest: architectureSyncCompiledDigest({ nodes: ["leaf-a"] }),
    observedDigest: architectureSyncObservedDigest({ nodes: ["leaf-a"] }),
    planDigest,
    ...(currentApproval ? { approvalDigest: architectureSyncSnapshotDigest(currentApproval) } : {}),
    ...(currentBaseline ? { baselineDigest: architectureSyncSnapshotDigest(currentBaseline) } : {}),
  };
  return {
    schemaVersion: 1,
    identity,
    state,
    digests,
    steps,
    receipts: [],
    ...(currentApproval ? { approval: currentApproval } : {}),
    ...(currentBaseline ? { baseline: currentBaseline } : {}),
    createdAt: timestamp,
    updatedAt: "2026-08-30T00:01:00Z",
  };
}

function maximumLifecycleRun(): ArchitectureSyncRun {
  const unkeyedSteps: ArchitectureSyncStep[] = Array.from({ length: MAX_SYNC_STEPS }, (_, index) => ({
    schemaVersion: 1,
    id: `max-step-${index + 1}`,
    ordinal: index + 1,
    action: index % 2 === 0 ? "install" : "configure-router",
    nodeId: `max-node-${index + 1}`,
    targetGeneration: identity.targetGeneration,
    state: "succeeded",
    idempotencyKey: `placeholder-${index + 1}`,
  }));
  const planDigest = architectureSyncPlanDigest(unkeyedSteps);
  const steps = unkeyedSteps.map((step) => ({
    ...step,
    idempotencyKey: architectureSyncStepIdempotencyKey({ identity, planDigest, step }),
  }));
  const receipts: ArchitectureSyncReceipt[] = [
    {
      schemaVersion: 1,
      id: "max-receipt-approval",
      runId: identity.runId,
      kind: "approval",
      status: "accepted",
      code: "approval.accepted",
      recordedAt: timestamp,
    },
    ...steps.map((step) => ({
      schemaVersion: 1 as const,
      id: `max-receipt-apply-${step.ordinal}`,
      runId: identity.runId,
      stepId: step.id,
      kind: "apply" as const,
      status: "succeeded" as const,
      code: "step.applied",
      recordedAt: timestamp,
    })),
    ...steps.map((step) => ({
      schemaVersion: 1 as const,
      id: `max-receipt-verify-${step.ordinal}`,
      runId: identity.runId,
      stepId: step.id,
      kind: "verify" as const,
      status: "succeeded" as const,
      code: "step.verified",
      recordedAt: timestamp,
    })),
    {
      schemaVersion: 1,
      id: "max-receipt-terminal",
      runId: identity.runId,
      kind: "run",
      status: "succeeded",
      code: "run.succeeded",
      recordedAt: timestamp,
    },
    {
      schemaVersion: 1,
      id: "max-receipt-recovery",
      runId: identity.runId,
      kind: "recovery",
      status: "accepted",
      code: "recovery.retry",
      recordedAt: timestamp,
      evidenceDigest: digestA,
    },
    ...steps.map((step) => ({
      schemaVersion: 1 as const,
      id: `max-receipt-retry-apply-${step.ordinal}`,
      runId: identity.runId,
      stepId: step.id,
      kind: "apply" as const,
      status: "succeeded" as const,
      code: "step.retried",
      recordedAt: timestamp,
    })),
    ...steps.map((step) => ({
      schemaVersion: 1 as const,
      id: `max-receipt-retry-verify-${step.ordinal}`,
      runId: identity.runId,
      stepId: step.id,
      kind: "verify" as const,
      status: "succeeded" as const,
      code: "step.reverified",
      recordedAt: timestamp,
    })),
    {
      schemaVersion: 1,
      id: "max-receipt-retry-terminal",
      runId: identity.runId,
      kind: "run",
      status: "succeeded",
      code: "run.retried",
      recordedAt: timestamp,
    },
  ];
  const currentApproval = approval(planDigest);
  return {
    schemaVersion: 1,
    identity,
    state: "succeeded",
    digests: {
      desiredDigest: architectureSyncDesiredDigest({ nodes: ["max"] }),
      compiledDigest: architectureSyncCompiledDigest({ nodes: ["max"] }),
      observedDigest: architectureSyncObservedDigest({ nodes: ["max"] }),
      planDigest,
      approvalDigest: architectureSyncSnapshotDigest(currentApproval),
    },
    steps,
    receipts,
    approval: currentApproval,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test("sync control exposes bounded states and read-only capability vocabulary", () => {
  assert.deepEqual(architectureSyncRunStates, [
    "drafted",
    "awaiting_approval",
    "approved",
    "queued",
    "lease_acquiring",
    "revalidating",
    "preparing",
    "applying",
    "verifying",
    "succeeded",
    "blocked",
    "failed",
    "rollback_required",
    "rolling_back",
    "rolled_back",
    "rollback_failed",
    "cancelled",
    "expired",
  ]);
  assert.deepEqual(architectureSyncStepStates, ["planned", "prepared", "started", "succeeded", "verify_failed", "compensating", "compensated", "failed", "skipped"]);
  assert.deepEqual(architectureSyncFailureClasses.includes("ambiguous-readback"), true);
  assert.deepEqual(architectureSyncRecoveryConditions, ["no-mutation", "desired-readback", "restorable-partial-state", "ambiguous-readback", "irreversible-unrecoverable"]);
  assert.deepEqual(architectureSyncCapabilityNames, ["inventory.read", "health.read", "plan.read", "apply", "rollback", "sync.write"]);
  assert.deepEqual(architectureSyncMutationCapabilities, ["apply", "rollback", "sync.write"]);
  assert.equal(validateArchitectureSyncCapabilities({ "inventory.read": true, "health.read": true, "plan.read": true }).valid, true);
  const mutation = validateArchitectureSyncCapabilities({ apply: true });
  assert.equal(mutation.valid, false);
  if (!mutation.valid) assert.equal(mutation.errors.some((error) => error.code === "ARCHITECTURE_SYNC_MUTATION_CAPABILITY_ENABLED"), true);
});

test("identity and snapshot digests are deterministic for object and set ordering", () => {
  const reorderedIdentity = { environmentId: identity.environmentId, ...identity };
  assert.equal(architectureSyncRunIdentityDigest(identity), architectureSyncRunIdentityDigest(reorderedIdentity));
  assert.deepEqual(assertValidArchitectureSyncRunIdentity(identity), identity);

  const left = { nodes: [{ id: "a" }, { id: "b" }], metadata: { z: 1, a: true } };
  const right = { metadata: { a: true, z: 1 }, nodes: [{ id: "b" }, { id: "a" }] };
  assert.equal(architectureSyncSnapshotDigest(left), architectureSyncSnapshotDigest(right));
  assert.equal(architectureSyncDesiredDigest(left), architectureSyncDesiredDigest(right));
  assert.equal(architectureSyncCompiledDigest(left), architectureSyncCompiledDigest(right));
  assert.equal(architectureSyncObservedDigest(left), architectureSyncObservedDigest(right));
  assert.notEqual(architectureSyncOrderedDigest(["a", "b"]), architectureSyncOrderedDigest(["b", "a"]));
  assert.equal(architectureSyncSnapshotDigest({ packageVisibility: "private" }), architectureSyncSnapshotDigest({ packageVisibility: "private" }));
  assert.throws(() => architectureSyncSnapshotDigest({ value: "x".repeat(513) }), /ARCHITECTURE_SYNC_LIMIT_EXCEEDED/);
});

test("plan digest preserves execution order while derived keys remain stable", () => {
  const steps = plannedSteps();
  const planDigest = architectureSyncPlanDigest(steps);
  const reversed = [...steps].reverse();
  assert.notEqual(architectureSyncPlanDigest(steps), architectureSyncPlanDigest(reversed));
  const keyed = steps.map((step) => ({ ...step, idempotencyKey: architectureSyncStepIdempotencyKey({ identity, planDigest, step }) }));
  assert.equal(architectureSyncPlanDigest(keyed), planDigest);
  assert.equal(keyed[0].idempotencyKey, architectureSyncStepIdempotencyKey({ identity, planDigest, step: keyed[0] }));
  assert.equal(validateArchitectureSyncStep(keyed[0], identity).valid, true);
});

test("digest validation rejects source mismatches", () => {
  const steps = keyedSteps();
  const planDigest = architectureSyncPlanDigest(steps);
  const digestSet = createArchitectureSyncDigests({
    desired: { nodes: ["a"] },
    compiled: { nodes: ["a"] },
    observed: { nodes: ["a"] },
    plan: steps,
  });
  assert.equal(digestSet.planDigest, planDigest);
  const result = validateArchitectureSyncDigests({ ...digestSet, desiredDigest: digestB }, {
    desired: { nodes: ["a"] },
    compiled: { nodes: ["a"] },
    observed: { nodes: ["a"] },
    plan: steps,
  });
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_SYNC_DIGEST_MISMATCH" && error.path === "digests.desiredDigest"), true);

  const invalidSource = validateArchitectureSyncDigests(digestSet, { desired: { value: "x".repeat(513) } });
  assert.equal(invalidSource.valid, false);
  if (!invalidSource.valid) assert.equal(invalidSource.errors.some((error) => error.code === "ARCHITECTURE_SYNC_LIMIT_EXCEEDED" && error.path?.startsWith("sources.desired")), true);
});

test("run validation binds ordered steps, approval, and baseline to immutable digests", () => {
  const draft = validateArchitectureSyncRun(runFixture());
  assert.equal(draft.valid, true);
  const approved = validateArchitectureSyncRun(runFixture("approved"));
  assert.equal(approved.valid, true);
  const mismatched = runFixture("approved") as unknown as Record<string, unknown>;
  mismatched.digests = { ...(mismatched.digests as Record<string, unknown>), planDigest: digestB };
  const mismatch = validateArchitectureSyncRun(mismatched);
  assert.equal(mismatch.valid, false);
  if (!mismatch.valid) assert.equal(mismatch.errors.some((error) => error.code === "ARCHITECTURE_SYNC_IDEMPOTENCY_KEY_INVALID" || error.code === "ARCHITECTURE_SYNC_DIGEST_MISMATCH"), true);

  const stale = validateArchitectureSyncRun(runFixture(), identity.targetGeneration + 1);
  assert.equal(stale.valid, false);
  if (!stale.valid) assert.equal(stale.errors.some((error) => error.code === "ARCHITECTURE_SYNC_GENERATION_STALE"), true);
  assert.equal(assertValidArchitectureSyncRun(runFixture("approved")).state, "approved");
});

test("maximum step lifecycle fits receipt capacity with one bounded retry headroom", () => {
  const run = maximumLifecycleRun();
  assert.equal(MAX_SYNC_STEPS, 500);
  assert.equal(MAX_SYNC_RECEIPTS, 2_004);
  assert.equal(run.steps.length, MAX_SYNC_STEPS);
  assert.equal(run.receipts.length, MAX_SYNC_RECEIPTS);
  assert.equal(1 + MAX_SYNC_STEPS + MAX_SYNC_STEPS + 1, 1_002);
  assert.equal(validateArchitectureSyncRun(run).valid, true);

  const oversized = {
    ...run,
    receipts: [...run.receipts, { ...run.receipts[0], id: "max-receipt-over-capacity" }],
  };
  const result = validateArchitectureSyncRun(oversized);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_SYNC_LIMIT_EXCEEDED" && error.path === "run.receipts"), true);
});

test("state transitions are forward-only and route rollback as explicit later states", () => {
  assert.equal(isValidArchitectureSyncRunTransition("drafted", "awaiting_approval"), true);
  assert.equal(isValidArchitectureSyncRunTransition("applying", "rollback_required"), true);
  assert.equal(isValidArchitectureSyncRunTransition("succeeded", "applying"), false);
  assert.equal(isValidArchitectureSyncRunTransition("applying", "preparing"), false);
  assert.deepEqual(architectureSyncRunStateTransitions("succeeded"), []);
  assert.equal(isValidArchitectureSyncStepTransition("planned", "prepared"), true);
  assert.equal(isValidArchitectureSyncStepTransition("verify_failed", "compensating"), true);
  assert.equal(isValidArchitectureSyncStepTransition("succeeded", "started"), false);
  assert.equal(isValidArchitectureSyncStepTransition("failed", "planned"), false);
  assert.deepEqual(architectureSyncStepStateTransitions("compensated"), []);
  assert.throws(() => assertCurrentArchitectureSyncLease({} as never, {} as never), /ARCHITECTURE_SYNC/);
});

test("recovery transitions require an interrupted source and deterministic outcome", () => {
  assert.deepEqual(architectureSyncRecoverySourceStates, ["lease_acquiring", "revalidating", "preparing", "applying", "verifying"]);
  const transition = {
    sourceState: "applying" as const,
    condition: "no-mutation" as const,
    decision: "retry" as const,
    nextRunState: "queued" as const,
  };
  assert.equal(isValidArchitectureSyncRecoveryTransition({ from: "applying", to: "queued", transition }), true);
  assert.equal(isValidArchitectureSyncRecoveryTransition({ from: "approved", to: "queued", transition }), false);
  assert.equal(isValidArchitectureSyncRecoveryTransition({
    from: "applying",
    to: "succeeded",
    transition: { ...transition, decision: "succeed", nextRunState: "succeeded" },
  }), false);
  assert.equal(isValidArchitectureSyncRecoveryStepTransition("started", "prepared", transition), true);
  assert.equal(isValidArchitectureSyncRecoveryStepTransition("planned", "succeeded", {
    ...transition,
    condition: "desired-readback",
    decision: "succeed",
    nextRunState: "succeeded",
  }), true);
  assert.equal(isValidArchitectureSyncRecoveryStepTransition("succeeded", "started", transition), false);
  assert.equal(isValidArchitectureSyncRecoveryStepTransition("started", "prepared", { ...transition, sourceState: "approved" as never }), false);
  assert.equal(isValidArchitectureSyncRecoveryStepTransition("started", "prepared", { ...transition, condition: "desired-readback" as never }), false);
});

test("recovery evidence digest binds immutable run context and source decision", () => {
  const base = {
    runId: identity.runId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    architectureId: identity.architectureId,
    revisionId: identity.revisionId,
    profileId: identity.profileId,
    environmentId: identity.environmentId,
    desiredDigest: digestA,
    compiledDigest: digestA,
    observedDigest: digestB,
    planDigest: digestB,
    sourceState: "applying" as const,
    condition: "no-mutation" as const,
    decision: "retry" as const,
    nextRunState: "queued" as const,
    evidenceDigest: digestA,
  };
  assert.equal(architectureSyncRecoveryEvidenceDigest(base), architectureSyncRecoveryEvidenceDigest({ ...base }));
  assert.notEqual(architectureSyncRecoveryEvidenceDigest(base), architectureSyncRecoveryEvidenceDigest({ ...base, evidenceDigest: digestB }));
  assert.throws(() => architectureSyncRecoveryEvidenceDigest({ ...base, sourceState: "approved" as never }), /ARCHITECTURE_SYNC_RECOVERY_INVALID/);
});

test("lease validation rejects stale generations and fencing tokens", () => {
  const lease = {
    schemaVersion: 1 as const,
    leaseId: "lease-1",
    runId: identity.runId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    holderId: "worker-1",
    fencingToken: 9,
    acquiredAt: timestamp,
    expiresAt: "2026-08-30T00:10:00Z",
  };
  assert.equal(isArchitectureSyncLeaseCurrent(lease, { targetId: identity.targetId, targetGeneration: 4, fencingToken: 9, runId: identity.runId, now: "2026-08-30T00:05:00Z" }), true);
  const fencing = validateArchitectureSyncFencingRecord({ targetId: identity.targetId, targetGeneration: 4, fencingToken: 9 }, { targetId: identity.targetId, targetGeneration: 4, fencingToken: 9 });
  assert.equal(fencing.valid, true);
  assert.equal(assertValidArchitectureSyncFencingRecord({ targetId: identity.targetId, targetGeneration: 4, fencingToken: 9 }).targetGeneration, 4);
  assert.equal(isArchitectureSyncLeaseCurrent(lease, { targetId: identity.targetId, targetGeneration: 5, fencingToken: 9, runId: identity.runId }), false);
  const stale = validateArchitectureSyncLease(lease, { targetId: identity.targetId, targetGeneration: 5, fencingToken: 9, runId: identity.runId });
  assert.equal(stale.valid, false);
  if (!stale.valid) assert.equal(stale.errors.some((error) => error.code === "ARCHITECTURE_SYNC_GENERATION_STALE"), true);
  const fenced = validateArchitectureSyncLease(lease, { targetId: identity.targetId, targetGeneration: 4, fencingToken: 10, runId: identity.runId });
  assert.equal(fenced.valid, false);
  if (!fenced.valid) assert.equal(fenced.errors.some((error) => error.code === "ARCHITECTURE_SYNC_FENCE_STALE"), true);
  const expired = validateArchitectureSyncLease(lease, { targetId: identity.targetId, targetGeneration: 4, fencingToken: 9, runId: identity.runId, now: "2026-08-30T00:10:00Z" });
  assert.equal(expired.valid, false);
  assert.throws(() => assertCurrentArchitectureSyncLease(lease, { targetId: identity.targetId, targetGeneration: 4, fencingToken: 10 }), /fencingToken/);
});

test("duplicate delivery is idempotent only for the same immutable step", () => {
  const [first] = keyedSteps();
  const duplicate = { ...first, state: "started" as const };
  assert.equal(compareArchitectureSyncStepIdempotency(first, duplicate), "duplicate");
  const conflict = { ...first, action: "update" as const };
  assert.equal(compareArchitectureSyncStepIdempotency(first, conflict), "conflict");
  const fresh = { ...first, idempotencyKey: "step-new" };
  assert.equal(compareArchitectureSyncStepIdempotency(first, fresh), "new");
});

test("receipts, failures, and metadata reject sensitive or unbounded values", () => {
  const unsafe = runFixture() as unknown as Record<string, unknown>;
  unsafe.receipts = [{
    schemaVersion: 1,
    id: "receipt-1",
    runId: identity.runId,
    kind: "run",
    status: "failed",
    code: "failed",
    recordedAt: timestamp,
    metadata: { path: "/Users/jarel/.codex", token: "do-not-store" },
  }];
  const result = validateArchitectureSyncRun(unsafe);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_SYNC_SENSITIVE_FIELD"), true);
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_SYNC_UNSAFE_VALUE"), true);
  }

  const content = runFixture() as unknown as Record<string, unknown>;
  content.metadata = { packageContents: "not retained" };
  const contentResult = validateArchitectureSyncRun(content);
  assert.equal(contentResult.valid, false);
  if (!contentResult.valid) assert.equal(contentResult.errors.some((error) => error.code === "ARCHITECTURE_SYNC_SENSITIVE_FIELD"), true);

  const unknown = runFixture() as unknown as Record<string, unknown>;
  unknown.receipts = [{
    schemaVersion: 1,
    id: "receipt-1",
    runId: identity.runId,
    kind: "run",
    status: "accepted",
    code: "accepted",
    recordedAt: timestamp,
    unexpected: true,
  }];
  const unknownResult = validateArchitectureSyncRun(unknown);
  assert.equal(unknownResult.valid, false);
  if (!unknownResult.valid) assert.equal(unknownResult.errors.some((error) => error.code === "ARCHITECTURE_SYNC_UNKNOWN_FIELD"), true);
});

test("run validation rejects an approval from another run even when the plan matches", () => {
  const run = runFixture("approved") as unknown as Record<string, unknown>;
  run.approval = {
    ...(run.approval as Record<string, unknown>),
    runId: "run-other",
  };
  const result = validateArchitectureSyncRun(run);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.errors.some((error) => error.path === "run.approval.runId"), true);
});

test("crash recovery chooses a deterministic safe outcome for each evidence branch", () => {
  assert.deepEqual(decideArchitectureSyncRecovery("no-mutation"), {
    condition: "no-mutation",
    decision: "retry",
    nextRunState: "queued",
    safeToRetry: true,
    requiresManualReview: false,
  });
  assert.equal(decideArchitectureSyncRecovery("desired-readback").nextRunState, "succeeded");
  assert.equal(decideArchitectureSyncRecovery("restorable-partial-state").nextRunState, "rollback_required");
  assert.equal(decideArchitectureSyncRecovery("ambiguous-readback").requiresManualReview, true);
  assert.equal(decideArchitectureSyncRecovery("irreversible-unrecoverable").nextRunState, "rollback_failed");
  assert.throws(() => decideArchitectureSyncRecovery("unknown" as never), /ARCHITECTURE_SYNC_RECOVERY_INVALID/);
});
