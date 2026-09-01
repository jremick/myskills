import {
  AppError,
  architectureSyncControlLimits,
  architectureSyncDesiredDigest,
  architectureSyncCompiledDigest,
  architectureSyncObservedDigest,
  architectureSyncOrderedDigest,
  architectureSyncPlanDigest,
  architectureSyncRecoveryEvidenceDigest,
  architectureSyncSnapshotDigest,
  architectureSyncStepIdempotencyKey,
  assertValidArchitectureSyncApproval,
  assertValidArchitectureSyncBaseline,
  assertValidArchitectureSyncCapabilities,
  assertValidArchitectureSyncRun,
  assertValidArchitectureSyncRunIdentity,
  assertValidArchitectureSyncStep,
  decideArchitectureSyncRecovery,
  isArchitectureSyncLeaseCurrent,
  validateArchitectureSyncRecoveryCondition,
  validateArchitectureSyncReceipt,
  type ArchitectureSyncApproval,
  type ArchitectureSyncBaseline,
  type ArchitectureSyncCapabilitySet,
  type ArchitectureSyncFailureClass,
  type ArchitectureSyncLease,
  type ArchitectureSyncReceipt,
  type ArchitectureSyncRun,
  type ArchitectureSyncStep,
  type ArchitectureSyncStepState,
} from "@myskills-app/core";
import {
  ArchitectureSyncExecutorError,
  type ArchitectureSyncActor,
  type ArchitectureSyncActorInput,
  type ArchitectureSyncApplyInput,
  type ArchitectureSyncApprovalInput,
  type ArchitectureSyncAuthorizationPort,
  type ArchitectureSyncBaselineInput,
  type ArchitectureSyncConsentPort,
  type ArchitectureSyncConsentResult,
  type ArchitectureSyncCreateRunStoreInput,
  type ArchitectureSyncExecutorApplyResult,
  type ArchitectureSyncExecutorReceiptInput,
  type ArchitectureSyncExecutorVerifyResult,
  type ArchitectureSyncFixtureExecutor,
  type ArchitectureSyncGateAction,
  type ArchitectureSyncGateResult,
  type ArchitectureSyncMetadata,
  type ArchitectureSyncMfaPort,
  type ArchitectureSyncPreviewInput,
  type ArchitectureSyncPreviewResult,
  type ArchitectureSyncPreviewStepInput,
  type ArchitectureSyncRecoveryInput,
  type ArchitectureSyncRecoveryCondition,
  type ArchitectureSyncRecoveryEvidence,
  type ArchitectureSyncRecoveryPort,
  type ArchitectureSyncRunSaveOptions,
  type ArchitectureSyncRecoveryResult,
  type ArchitectureSyncRollbackInput,
  type ArchitectureSyncServiceOptions,
  type ArchitectureSyncStore,
} from "./types.js";
import { sanitizeArchitectureSyncMetadata } from "./metadata.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;
const DEFAULT_CAPABILITIES: ArchitectureSyncCapabilitySet = {
  "inventory.read": true,
  "health.read": true,
  "plan.read": true,
  apply: false,
  rollback: false,
  "sync.write": false,
};

export interface ArchitectureSyncPorts {
  readonly authorization: ArchitectureSyncAuthorizationPort;
  readonly mfa: ArchitectureSyncMfaPort;
  readonly consent: ArchitectureSyncConsentPort;
  readonly recovery: ArchitectureSyncRecoveryPort;
}

interface GateFailure {
  readonly category: "mfa" | "authorization" | "consent" | "generation" | "lease";
  readonly code: string;
}

class ArchitectureSyncGateError extends AppError {
  readonly gateFailure: GateFailure;

  constructor(failure: GateFailure) {
    const messages: Record<GateFailure["category"], string> = {
      mfa: "Multi-factor verification is required for this sync operation.",
      authorization: "The actor is not authorized for this sync operation.",
      consent: "Current target consent is required for this sync operation.",
      generation: "The target changed before this sync operation could continue.",
      lease: "The sync lease is no longer current.",
    };
    const codes: Record<GateFailure["category"], string> = {
      mfa: "ARCHITECTURE_SYNC_MFA_REQUIRED",
      authorization: "ARCHITECTURE_SYNC_AUTHORIZATION_REQUIRED",
      consent: "ARCHITECTURE_SYNC_CONSENT_REQUIRED",
      generation: "ARCHITECTURE_SYNC_GENERATION_STALE",
      lease: "ARCHITECTURE_SYNC_LEASE_LOST",
    };
    super(messages[failure.category], codes[failure.category], failure.category === "authorization" || failure.category === "mfa" ? 403 : 409, {
      reason: failure.code,
    });
    this.gateFailure = failure;
  }
}

class ArchitectureSyncLeaseError extends AppError {
  constructor() {
    super("The sync lease is no longer current.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
  }
}

/**
 * Fixture-only application orchestration for staged architecture sync.
 *
 * The service journals a digest-bound intent and calls only the synthetic
 * executor port. It never receives or forwards a target client, filesystem,
 * network client, package payload, configuration, or source snapshot.
 */
export class ArchitectureSyncService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly defaultLeaseSeconds: number;
  private readonly defaultApprovalSeconds: number;

  constructor(
    private readonly store: ArchitectureSyncStore,
    private readonly executor: ArchitectureSyncFixtureExecutor,
    private readonly ports: ArchitectureSyncPorts,
    options: ArchitectureSyncServiceOptions = {},
  ) {
    if (executor.kind !== "fixture") {
      throw new AppError("Only the fixture sync executor is supported.", "ARCHITECTURE_SYNC_EXECUTOR_UNSUPPORTED", 400);
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => cryptoRandomId());
    this.defaultLeaseSeconds = boundedSeconds(options.defaultLeaseSeconds ?? 60, "lease");
    this.defaultApprovalSeconds = boundedSeconds(options.defaultApprovalSeconds ?? 900, "approval");
  }

  /** Create a digest-only draft. No executor call or target side effect occurs. */
  async createPreviewRun(input: ArchitectureSyncPreviewInput): Promise<ArchitectureSyncPreviewResult> {
    const actor = normalizeActor(input.actor);
    const identity = this.buildIdentity(input);
    const placeholderSteps = normalizePreviewSteps(input.steps, identity.targetGeneration);
    const planDigest = architectureSyncPlanDigest(placeholderSteps);
    const steps = placeholderSteps.map((step) => ({
      ...step,
      idempotencyKey: architectureSyncStepIdempotencyKey({ identity, planDigest, step }),
    }));
    const capabilities = normalizeCapabilities(input.capabilities);
    const metadata = sanitizeArchitectureSyncMetadata(input.metadata);
    const digests = {
      desiredDigest: architectureSyncDesiredDigest(input.desired),
      compiledDigest: architectureSyncCompiledDigest(input.compiled),
      observedDigest: architectureSyncObservedDigest(input.observed),
      planDigest,
    };
    const createdAt = this.timestamp();
    const baseline = input.baseline
      ? this.buildBaseline(input.baseline, identity, digests.observedDigest, createdAt)
      : undefined;
    const run: ArchitectureSyncRun = assertValidArchitectureSyncRun({
      schemaVersion: 1,
      identity,
      state: "drafted",
      digests: {
        ...digests,
        ...(baseline ? { baselineDigest: architectureSyncSnapshotDigest(baseline) } : {}),
      },
      steps,
      receipts: [],
      ...(baseline ? { baseline } : {}),
      capabilities,
      createdAt,
      updatedAt: createdAt,
      ...(metadata === undefined ? {} : { metadata }),
    });
    const intentDigest = architectureSyncOrderedDigest({
      targetId: identity.targetId,
      targetGeneration: identity.targetGeneration,
      architectureId: identity.architectureId,
      revisionId: identity.revisionId,
      profileId: identity.profileId,
      environmentId: identity.environmentId,
      digests,
      steps: steps.map((step) => ({
        ordinal: step.ordinal,
        action: step.action,
        nodeId: step.nodeId,
        ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
      })),
      ...(baseline ? { baseline: { observedDigest: baseline.observedDigest, restorable: baseline.restorable, metadata: baseline.metadata } } : {}),
      capabilities,
      ...(metadata === undefined ? {} : { metadata }),
    });
    const createInput: ArchitectureSyncCreateRunStoreInput = {
      actorId: actor.userId,
      requestKey: normalizeIdentifier(input.requestKey, "requestKey"),
      idempotencyKey: normalizeIdentifier(input.idempotencyKey, "idempotencyKey"),
      intentDigest,
      run,
    };
    const created = await this.store.createRun(createInput);
    await this.audit(created.run, actor.userId, "preview", created.decision === "conflict" ? "deny" : "allow", created.decision === "new" ? "run.created" : "run.replayed");
    return { run: created.run, replayed: created.decision === "duplicate" };
  }

  async getRun(runId: string): Promise<ArchitectureSyncRun | null> {
    return this.store.getRun(normalizeIdentifier(runId, "runId"));
  }

  async approve(input: ArchitectureSyncApprovalInput): Promise<ArchitectureSyncRun> {
    const actor = normalizeActor(input.actor);
    let run = await this.requireRun(input.runId);
    this.assertExpectedPlanDigest(run, input.expectedPlanDigest);
    if (run.state === "approved" && run.approval) {
      if (run.approval.actorId === actor.userId) return run;
      throw new AppError("Only the approving actor may use this approval.", "ARCHITECTURE_SYNC_APPROVAL_ACTOR_CONFLICT", 409);
    }
    if (run.state !== "drafted" && run.state !== "awaiting_approval") {
      throw new AppError("Sync run is not awaiting approval.", "ARCHITECTURE_SYNC_APPROVAL_STATE_INVALID", 409);
    }
    await this.checkGates(run, actor, "approve", "approval");
    if (run.state === "drafted") {
      run = await this.saveRun({ ...run, state: "awaiting_approval", updatedAt: this.timestamp() });
    }
    const approvedAt = this.timestamp();
    const expiresInSeconds = input.expiresInSeconds === undefined
      ? this.defaultApprovalSeconds
      : boundedSeconds(input.expiresInSeconds, "approval");
    const approval: ArchitectureSyncApproval = assertValidArchitectureSyncApproval({
      schemaVersion: 1,
      id: `approval-${this.idFactory()}`,
      runId: run.identity.runId,
      actorId: actor.userId,
      planDigest: run.digests.planDigest,
      approvedAt,
      expiresAt: new Date(Date.parse(approvedAt) + expiresInSeconds * 1_000).toISOString(),
    });
    const next: ArchitectureSyncRun = {
      ...run,
      state: "approved",
      approval,
      digests: { ...run.digests, approvalDigest: architectureSyncSnapshotDigest(approval) },
      receipts: [...run.receipts, this.receipt(run, "approval", "succeeded", "approval.accepted")],
      updatedAt: approvedAt,
    };
    const saved = await this.saveRun(next);
    await this.audit(saved, actor.userId, "approve", "allow", "approval.accepted");
    return saved;
  }

  async apply(input: ArchitectureSyncApplyInput): Promise<ArchitectureSyncRun> {
    const actor = normalizeActor(input.actor);
    let run = await this.requireRun(input.runId);
    this.assertExpectedPlanDigest(run, input.expectedPlanDigest);
    this.assertMutationCapabilitiesFailClosed(run);
    if (run.state === "succeeded") return this.finalizeTerminalRun(run, actor.userId, "apply", "run.succeeded");
    if (run.state === "rolled_back") return this.finalizeTerminalRun(run, actor.userId, "rollback", "rollback.succeeded");
    if (run.state === "blocked") return this.finalizeTerminalRun(run, actor.userId, "apply", "run.blocked", "failed", "deny");
    if (!run.approval) throw new AppError("Sync approval is required before apply.", "ARCHITECTURE_SYNC_APPROVAL_REQUIRED", 409);
    if (run.approval.actorId !== actor.userId) {
      return this.blockAndThrow(run, actor, {
        category: "authorization",
        code: "approval.actor",
      });
    }
    if (Date.parse(run.approval.expiresAt ?? "9999-12-31T00:00:00Z") <= this.now().getTime()) {
      return this.blockAndThrow(run, actor, { category: "authorization", code: "approval.expired" });
    }
    if (run.state !== "approved" && run.state !== "queued" && !isInterruptedRunState(run.state)) {
      throw new AppError("Sync run is not ready to apply.", "ARCHITECTURE_SYNC_APPLY_STATE_INVALID", 409);
    }
    try {
      await this.checkGates(run, actor, "apply", "before-apply");
    } catch (error) {
      if (error instanceof ArchitectureSyncGateError) return this.blockAndThrow(run, actor, error.gateFailure);
      throw error;
    }
    let claim: Awaited<ReturnType<ArchitectureSyncStore["claimApply"]>>;
    try {
      claim = await this.store.claimApply({
        runId: run.identity.runId,
        targetId: run.identity.targetId,
        targetGeneration: run.identity.targetGeneration,
        holderId: normalizeIdentifier(input.holderId ?? actor.userId, "holderId"),
        now: this.timestamp(),
        leaseSeconds: input.leaseSeconds === undefined ? this.defaultLeaseSeconds : boundedSeconds(input.leaseSeconds, "lease"),
      });
    } catch (error) {
      const failure: GateFailure = { category: "lease", code: errorCode(error) === "ARCHITECTURE_SYNC_LEASE_CONFLICT" ? "lease.conflict" : "lease.acquire" };
      return this.blockAndThrow(run, actor, failure);
    }
    if (claim.decision === "completed") {
      const terminalAction = claim.run.state === "rolled_back" ? "rollback" : "apply";
      const terminalCode = claim.run.state === "rolled_back" ? "rollback.succeeded" : "run.succeeded";
      return this.finalizeTerminalRun(claim.run, actor.userId, terminalAction, terminalCode);
    }
    if (claim.decision === "in-progress") return claim.run;
    run = claim.run;
    const lease = run.lease;
    if (!lease) throw new AppError("The sync lease claim is incomplete.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
    /*
     * claimApply serializes the ready-to-run state transition and lease
     * acquisition. A duplicate delivery therefore observes in-progress and
     * cannot block or release the winner's lease.
     */
    try {
      await this.enforceBoundary(run, actor, "apply", "before-apply");
      run = await this.saveRun({ ...run, state: "preparing", updatedAt: this.timestamp() });
      run = await this.saveRun({ ...run, state: "applying", updatedAt: this.timestamp() });
      for (const step of run.steps) {
        if (step.state === "succeeded" || step.state === "skipped" || step.state === "compensated") continue;
        run = await this.enforceBoundary(run, actor, "apply", "before-step");
        if (step.state === "planned") run = await this.saveRun(this.withStepState(run, step.id, "prepared"));
        const prepared = run.steps.find((candidate) => candidate.id === step.id);
        if (!prepared) throw new AppError("Sync step was not found.", "ARCHITECTURE_SYNC_STEP_NOT_FOUND", 409);
        let result: ArchitectureSyncExecutorApplyResult;
        // Keep the fence check at the fixture mutation boundary. The
        // earlier safe-boundary check may be separated from the executor by
        // a durable step transition or another asynchronous operation.
        await this.assertLease(run);
        try {
          result = await this.executor.apply({ run, step: prepared, lease, digests: run.digests });
        } catch (error) {
          run = await this.recordExecutorFailure(run, actor, error, prepared.id);
          throw executorAppError(error);
        }
        run = await this.saveRun(this.withStepState(run, prepared.id, "started"));
        run = await this.appendReceipt(run, actor, "apply", "started", "step.started", prepared.id, result.receipt, true);
      }
      run = await this.saveRun({ ...run, state: "verifying", updatedAt: this.timestamp() });
      for (const step of run.steps) {
        if (step.state === "succeeded" || step.state === "skipped" || step.state === "compensated") continue;
        run = await this.enforceBoundary(run, actor, "apply", "before-verify");
        const currentStep = run.steps.find((candidate) => candidate.id === step.id);
        if (!currentStep) throw new AppError("Sync step was not found.", "ARCHITECTURE_SYNC_STEP_NOT_FOUND", 409);
        let result: ArchitectureSyncExecutorVerifyResult;
        try {
          result = await this.executor.verify({ run, step: currentStep, lease, digests: run.digests });
        } catch (error) {
          run = await this.recordExecutorFailure(run, actor, error, currentStep.id);
          throw executorAppError(error);
        }
        if (!result.ok) {
          const failureClass: ArchitectureSyncFailureClass = result.condition === "ambiguous-readback" ? "ambiguous-readback" : "verification";
          run = await this.failRun(run, failureClass, "step.verify_failed", currentStep.id);
          run = await this.saveRun(this.withStepState(run, currentStep.id, "verify_failed"));
          run = await this.appendReceipt(run, actor, "verify", "failed", "step.verify_failed", currentStep.id, result.receipt, true);
          run = await this.saveRun({ ...run, state: "rollback_required", updatedAt: this.timestamp() });
          await this.releaseLease(run);
          throw new AppError("Sync verification failed.", "ARCHITECTURE_SYNC_VERIFICATION_FAILED", 409);
        }
        run = await this.saveRun(this.withStepState(run, currentStep.id, "succeeded"));
        run = await this.appendReceipt(run, actor, "verify", "succeeded", "step.verified", currentStep.id, result.receipt, true);
      }
      run = await this.saveRun({ ...run, state: "succeeded", failure: undefined, updatedAt: this.timestamp() });
      return this.finalizeTerminalRun(run, actor.userId, "apply", "run.succeeded");
    } catch (error) {
      if (error instanceof ArchitectureSyncGateError || error instanceof ArchitectureSyncLeaseError) {
        const failure: GateFailure = error instanceof ArchitectureSyncGateError
          ? error.gateFailure
        : { category: "lease", code: "lease.lost" };
        return this.blockAndThrow(run, actor, failure);
      }
      throw error;
    }
  }

  async recover(input: ArchitectureSyncRecoveryInput): Promise<{ run: ArchitectureSyncRun; recovery: ArchitectureSyncRecoveryResult }> {
    const actor = normalizeActor(input.actor);
    const run = await this.requireRun(input.runId);
    if (!isInterruptedRunState(run.state)) {
      const replay = this.replayRecovery(run, input.condition);
      if (replay) return replay;
      throw new AppError("Only an explicitly interrupted sync run can be recovered.", "ARCHITECTURE_SYNC_RECOVERY_STATE_INVALID", 409);
    }
    if (!run.approval) throw new AppError("Sync approval is required before recovery.", "ARCHITECTURE_SYNC_APPROVAL_REQUIRED", 409);
    if (run.approval.actorId !== actor.userId) return this.blockAndThrow(run, actor, { category: "authorization", code: "approval.actor" });
    try {
      await this.checkGates(run, actor, "recover", "before-apply");
    } catch (error) {
      if (error instanceof ArchitectureSyncGateError) return this.blockAndThrow(run, actor, error.gateFailure);
      throw error;
    }

    const evidence = await this.readRecoveryEvidence(actor.userId, run);
    if (input.condition !== undefined) {
      const expectedCondition = validateArchitectureSyncRecoveryCondition(input.condition);
      if (!expectedCondition.valid || expectedCondition.value !== evidence.condition) {
        throw new AppError("The requested recovery condition does not match trusted readback evidence.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
      }
    }
    const recovery = decideArchitectureSyncRecovery(evidence.condition);
    if (evidence.sourceState !== run.state
      || evidence.decision !== recovery.decision
      || evidence.nextRunState !== recovery.nextRunState) {
      throw new AppError("Trusted recovery evidence does not match the deterministic recovery policy.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    const evidenceDigest = architectureSyncRecoveryEvidenceDigest({
      ...run.identity,
      ...run.digests,
      sourceState: evidence.sourceState,
      condition: evidence.condition,
      decision: evidence.decision,
      nextRunState: evidence.nextRunState,
      evidenceDigest: evidence.evidenceDigest,
    });
    const steps = run.steps.map((step) => {
      if (recovery.decision === "retry" && (step.state === "started" || step.state === "verify_failed")) return { ...step, state: "prepared" as const };
      if (recovery.decision === "succeed" && !["succeeded", "skipped", "compensated"].includes(step.state)) return { ...step, state: "succeeded" as const };
      return step;
    });
    const shouldClearFailure = recovery.decision === "retry" || recovery.decision === "succeed";
    const recoveryAt = this.timestamp();
    const { lease: _lease, ...runWithoutLease } = run;
    const nextRun: ArchitectureSyncRun = {
      ...runWithoutLease,
      state: recovery.nextRunState,
      steps,
      ...(shouldClearFailure ? { failure: undefined } : {}),
      updatedAt: recoveryAt,
    };
    const recoveryCode = recoveryReceiptCode(recovery.decision);
    const receipt = this.receipt(
      run,
      "recovery",
      recovery.decision === "block" || recovery.decision === "manual-intervention" ? "unknown" : "succeeded",
      recoveryCode,
      undefined,
      undefined,
      evidenceDigest,
    );
    const dedupeKey = `recovery-${architectureSyncSnapshotDigest({ runId: run.identity.runId, evidenceDigest, code: recoveryCode })}`;
    const auditRecordedAt = this.timestamp();
    const finalized = await this.store.claimRecovery({
      run,
      nextRun,
      transition: {
        sourceState: evidence.sourceState,
        condition: evidence.condition,
        decision: evidence.decision,
        nextRunState: evidence.nextRunState,
      },
      evidenceDigest,
      recoveryReceipt: receipt,
      actorId: actor.userId,
      holderId: normalizeIdentifier(input.holderId ?? actor.userId, "holderId"),
      now: recoveryAt,
      leaseSeconds: input.leaseSeconds === undefined ? this.defaultLeaseSeconds : boundedSeconds(input.leaseSeconds, "lease"),
      audit: {
        runId: run.identity.runId,
        actorId: actor.userId,
        action: "sync.recover",
        decision: "allow",
        code: recoveryCode,
        recordedAt: auditRecordedAt,
        dedupeKey,
      },
    });
    return { run: finalized.run, recovery };
  }

  async rollback(input: ArchitectureSyncRollbackInput): Promise<ArchitectureSyncRun> {
    const actor = normalizeActor(input.actor);
    let run = await this.requireRun(input.runId);
    if (run.state === "rolled_back") return this.finalizeTerminalRun(run, actor.userId, "rollback", "rollback.succeeded");
    if (run.state === "rollback_failed") return this.finalizeTerminalRun(run, actor.userId, "rollback", "rollback.failed", "failed", "deny");
    if (run.state !== "rollback_required" && run.state !== "rolling_back") {
      throw new AppError("Sync run does not require rollback.", "ARCHITECTURE_SYNC_ROLLBACK_STATE_INVALID", 409);
    }
    const baseline = run.baseline;
    if (!baseline || !baseline.restorable) {
      throw new AppError("A restorable baseline is required before rollback.", "ARCHITECTURE_SYNC_BASELINE_REQUIRED", 409);
    }
    if (input.expectedBaselineDigest && input.expectedBaselineDigest !== run.digests.baselineDigest) {
      throw new AppError("The rollback baseline digest does not match this run.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
    }
    if (!run.approval || run.approval.actorId !== actor.userId) return this.blockAndThrow(run, actor, { category: "authorization", code: "approval.actor" });
    try {
      await this.checkGates(run, actor, "rollback", "before-rollback");
      run = await this.ensureLease(run, actor, input.holderId, input.leaseSeconds);
      await this.enforceBoundary(run, actor, "rollback", "before-rollback");
      if (run.state === "rollback_required") run = await this.saveRun({ ...run, state: "rolling_back", updatedAt: this.timestamp() });
      await this.assertLease(run);
      let result: { readonly ok: boolean; readonly receipt?: ArchitectureSyncExecutorReceiptInput };
      try {
        result = await this.executor.rollback({ run, baseline, lease: run.lease as ArchitectureSyncLease, digests: run.digests });
      } catch (error) {
        run = await this.recordExecutorFailure(run, actor, error);
        run = await this.saveRun({ ...run, state: "rollback_failed", updatedAt: this.timestamp() });
        run = await this.appendReceipt(run, actor, "rollback", "failed", "rollback.failed", undefined, undefined, false);
        await this.releaseLease(run);
        throw new AppError("Sync rollback failed.", "ARCHITECTURE_SYNC_ROLLBACK_FAILED", 409);
      }
      if (!result.ok) {
        run = await this.failRun(run, "rollback", "rollback.failed");
        run = await this.saveRun({ ...run, state: "rollback_failed", updatedAt: this.timestamp() });
        run = await this.appendReceipt(run, actor, "rollback", "failed", "rollback.failed", undefined, result.receipt, false);
        await this.releaseLease(run);
        throw new AppError("Sync rollback failed.", "ARCHITECTURE_SYNC_ROLLBACK_FAILED", 409);
      }
      // The executor may return after the lease expires or is fenced. Do not
      // commit compensation evidence under a lease that is no longer current.
      // Keeping the run in rolling_back lets the outer lease handler block it
      // through the normal, explicitly permitted transition.
      await this.assertLease(run);
      const steps = run.steps.map((step) => step.state === "succeeded" ? { ...step, state: "compensated" as const } : step);
      run = await this.saveRun({ ...run, steps, state: "rolled_back", failure: undefined, updatedAt: this.timestamp() }, { compensation: true });
      run = await this.appendReceipt(run, actor, "rollback", "succeeded", "rollback.succeeded", undefined, result.receipt, true);
      return this.finalizeTerminalRun(run, actor.userId, "rollback", "rollback.succeeded");
    } catch (error) {
      if (error instanceof ArchitectureSyncGateError || error instanceof ArchitectureSyncLeaseError) {
        const failure: GateFailure = error instanceof ArchitectureSyncGateError ? error.gateFailure : { category: "lease", code: "lease.lost" };
        return this.blockAndThrow(run, actor, failure);
      }
      throw error;
    }
  }

  private buildIdentity(input: ArchitectureSyncPreviewInput) {
    return assertValidArchitectureSyncRunIdentity({
      schemaVersion: 1,
      runId: normalizeIdentifier(input.runId ?? `run-${this.idFactory()}`, "runId"),
      targetId: normalizeIdentifier(input.targetId, "targetId"),
      targetGeneration: input.targetGeneration,
      architectureId: normalizeIdentifier(input.architectureId, "architectureId"),
      revisionId: normalizeIdentifier(input.revisionId, "revisionId"),
      profileId: normalizeIdentifier(input.profileId, "profileId"),
      environmentId: normalizeIdentifier(input.environmentId, "environmentId"),
    });
  }

  private buildBaseline(input: ArchitectureSyncBaselineInput, identity: ArchitectureSyncRun["identity"], observedDigest: string, capturedAt: string): ArchitectureSyncBaseline {
    if (input.observedDigest !== undefined && input.observedDigest !== observedDigest) {
      throw new AppError("The baseline digest does not match the observed snapshot.", "ARCHITECTURE_SYNC_BASELINE_DIGEST_CONFLICT", 409);
    }
    const metadata = sanitizeArchitectureSyncMetadata(input.metadata);
    return assertValidArchitectureSyncBaseline({
      schemaVersion: 1,
      id: normalizeIdentifier(input.id ?? `baseline-${this.idFactory()}`, "baselineId"),
      runId: identity.runId,
      targetId: identity.targetId,
      targetGeneration: identity.targetGeneration,
      observedDigest,
      restorable: input.restorable,
      capturedAt,
      ...(metadata === undefined ? {} : { metadata }),
    }, identity);
  }

  private async requireRun(runId: string): Promise<ArchitectureSyncRun> {
    const run = await this.store.getRun(normalizeIdentifier(runId, "runId"));
    if (!run) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
    return assertValidArchitectureSyncRun(run);
  }

  private async readRecoveryEvidence(actorId: string, run: ArchitectureSyncRun): Promise<ArchitectureSyncRecoveryEvidence> {
    let evidence: ArchitectureSyncRecoveryEvidence | null;
    try {
      evidence = await this.ports.recovery.read({ actorId, run });
    } catch {
      throw new AppError("Trusted recovery evidence could not be read.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_UNAVAILABLE", 409);
    }
    if (!evidence || typeof evidence !== "object") {
      throw new AppError("Trusted recovery evidence is required.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_REQUIRED", 409);
    }
    const condition = validateArchitectureSyncRecoveryCondition(evidence.condition);
    if (!condition.valid
      || !isInterruptedRunState(evidence.sourceState)
      || typeof evidence.decision !== "string"
      || typeof evidence.nextRunState !== "string"
      || typeof evidence.evidenceDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(evidence.evidenceDigest)) {
      throw new AppError("Trusted recovery evidence is invalid.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    return {
      sourceState: evidence.sourceState,
      condition: condition.value,
      decision: evidence.decision as ArchitectureSyncRecoveryEvidence["decision"],
      nextRunState: evidence.nextRunState as ArchitectureSyncRecoveryEvidence["nextRunState"],
      evidenceDigest: evidence.evidenceDigest,
    };
  }

  /**
   * A response can be lost after an atomic recovery commit. Replaying the
   * exact persisted recovery receipt is safe even if a later apply has
   * already advanced the run beyond the recovery state. An ordinary queued
   * or terminal run without that receipt is never treated as recoverable.
   */
  private replayRecovery(
    run: ArchitectureSyncRun,
    requestedCondition: ArchitectureSyncRecoveryInput["condition"],
  ): { run: ArchitectureSyncRun; recovery: ArchitectureSyncRecoveryResult } | null {
    const receipt = [...run.receipts].reverse().find((candidate) => candidate.kind === "recovery");
    if (!receipt) return null;
    const persistedCondition = recoveryConditionForReceiptCode(receipt.code);
    if (!persistedCondition || !receipt.evidenceDigest) return null;
    if (requestedCondition !== undefined) {
      const expected = validateArchitectureSyncRecoveryCondition(requestedCondition);
      if (!expected.valid || expected.value !== persistedCondition) {
        throw new AppError("The requested recovery condition does not match the persisted recovery result.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
      }
    }
    return { run, recovery: decideArchitectureSyncRecovery(persistedCondition) };
  }

  private async saveRun(run: ArchitectureSyncRun, options: ArchitectureSyncRunSaveOptions = {}): Promise<ArchitectureSyncRun> {
    return this.store.saveRun(assertValidArchitectureSyncRun(run), options);
  }

  private async finalizeTerminalRun(
    run: ArchitectureSyncRun,
    actorId: string,
    action: string,
    code: string,
    receiptStatus: ArchitectureSyncReceipt["status"] = "succeeded",
    auditDecision: "allow" | "deny" = "allow",
  ): Promise<ArchitectureSyncRun> {
    let finalized = run;
    const receiptKind = action === "apply" ? "run" : "rollback";
    const hasTerminalReceipt = this.hasTerminalReceipt(finalized, receiptKind, code, receiptStatus);
    let firstFailure: unknown;
    if (!hasTerminalReceipt) {
      try {
        finalized = await this.appendReceipt(finalized, { userId: actorId }, receiptKind, receiptStatus, code);
      } catch (error) {
        // A concurrent terminal retry may have committed the same receipt
        // between the read above and this append. Re-read and replay that
        // durable winner instead of surfacing an append-only conflict.
        try {
          const latest = await this.store.getRun(run.identity.runId);
          if (latest && this.hasTerminalReceipt(latest, receiptKind, code, receiptStatus)) finalized = latest;
          else firstFailure = error;
        } catch {
          firstFailure = error;
        }
      }
    }
    try {
      await this.releaseLease(finalized);
    } catch (error) {
      firstFailure ??= error;
    }
    if (firstFailure) throw firstFailure;
    await this.audit(finalized, actorId, action, auditDecision, code, { dedupeKey: `terminal-${architectureSyncSnapshotDigest({ runId: finalized.identity.runId, action, code })}` });
    return finalized;
  }

  private hasTerminalReceipt(
    run: ArchitectureSyncRun,
    kind: ArchitectureSyncReceipt["kind"],
    code: string,
    status: ArchitectureSyncReceipt["status"],
  ): boolean {
    return run.receipts.some((receipt) => receipt.kind === kind && (receipt.code === code || receipt.status === status));
  }

  private withStepState(run: ArchitectureSyncRun, stepId: string, state: ArchitectureSyncStepState): ArchitectureSyncRun {
    const steps = run.steps.map((step) => step.id === stepId ? { ...step, state } : step);
    return { ...run, steps, updatedAt: this.timestamp() };
  }

  private receipt(
    run: ArchitectureSyncRun,
    kind: ArchitectureSyncReceipt["kind"],
    status: ArchitectureSyncReceipt["status"],
    code: string,
    stepId?: string,
    input?: ArchitectureSyncExecutorReceiptInput,
    evidenceDigest?: string,
  ): ArchitectureSyncReceipt {
    let metadata: ArchitectureSyncMetadata | undefined;
    try {
      metadata = sanitizeArchitectureSyncMetadata(input?.metadata);
    } catch {
      metadata = undefined;
    }
    const candidate = {
      schemaVersion: 1 as const,
      id: `receipt-${this.idFactory()}`,
      runId: run.identity.runId,
      ...(stepId ? { stepId } : {}),
      kind,
      status: input?.status ?? status,
      code: safeCode(input?.code ?? code, code),
      recordedAt: this.timestamp(),
      ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
      ...(safeReceiptMessage(input?.message) ? { message: safeReceiptMessage(input?.message) } : {}),
      ...(metadata === undefined ? {} : { metadata }),
    };
    const valid = validateArchitectureSyncReceipt(candidate);
    if (valid.valid) return valid.value;
    return {
      schemaVersion: 1,
      id: candidate.id,
      runId: candidate.runId,
      ...(stepId ? { stepId } : {}),
      kind,
      status,
      code,
      recordedAt: candidate.recordedAt,
    };
  }

  private async appendReceipt(
    run: ArchitectureSyncRun,
    actor: ArchitectureSyncActor,
    kind: ArchitectureSyncReceipt["kind"],
    status: ArchitectureSyncReceipt["status"],
    code: string,
    stepId?: string,
    input?: ArchitectureSyncExecutorReceiptInput,
    requiresLease = false,
    evidenceDigest?: string,
  ): Promise<ArchitectureSyncRun> {
    if (requiresLease) await this.assertLease(run);
    const receipt = this.receipt(run, kind, status, code, stepId, input, evidenceDigest);
    return this.saveRun({ ...run, receipts: [...run.receipts, receipt], updatedAt: receipt.recordedAt });
  }

  private async checkGates(run: ArchitectureSyncRun, actor: ArchitectureSyncActor, action: ArchitectureSyncGateAction, boundary: "approval" | "before-apply" | "before-step" | "before-verify" | "before-rollback"): Promise<void> {
    const mfa = normalizeGate(await this.ports.mfa.verify({ actorId: actor.userId, runId: run.identity.runId, action }));
    if (!mfa.allowed) throw new ArchitectureSyncGateError({ category: "mfa", code: safeReason(mfa.reason, "mfa.denied") });
    const authorization = normalizeGate(await this.ports.authorization.authorize({ actorId: actor.userId, run, action }));
    if (!authorization.allowed) throw new ArchitectureSyncGateError({ category: "authorization", code: safeReason(authorization.reason, "authorization.denied") });
    const consent = normalizeConsent(await this.ports.consent.check({ actorId: actor.userId, run, action, boundary }));
    if (!consent.allowed) throw new ArchitectureSyncGateError({ category: "consent", code: safeReason(consent.reason, "consent.denied") });
    if (consent.currentTargetGeneration !== undefined && consent.currentTargetGeneration !== run.identity.targetGeneration) {
      throw new ArchitectureSyncGateError({ category: "generation", code: "target.generation.stale" });
    }
  }

  private async enforceBoundary(run: ArchitectureSyncRun, actor: ArchitectureSyncActor, action: ArchitectureSyncGateAction, boundary: "before-apply" | "before-step" | "before-verify" | "before-rollback"): Promise<ArchitectureSyncRun> {
    await this.checkGates(run, actor, action, boundary);
    await this.assertLease(run);
    return run;
  }

  private async assertLease(run: ArchitectureSyncRun): Promise<ArchitectureSyncLease> {
    if (!run.lease) throw new ArchitectureSyncLeaseError();
    const current = await this.store.getCurrentLease(run.identity.targetId);
    if (!current || !isArchitectureSyncLeaseCurrent(run.lease, {
      targetId: run.identity.targetId,
      targetGeneration: run.identity.targetGeneration,
      fencingToken: current.fencingToken,
      runId: run.identity.runId,
      now: this.timestamp(),
    })) throw new ArchitectureSyncLeaseError();
    return run.lease;
  }

  private async ensureLease(
    run: ArchitectureSyncRun,
    actor: ArchitectureSyncActor,
    holderId?: string,
    leaseSeconds?: number,
  ): Promise<ArchitectureSyncRun> {
    const existing = await this.store.getCurrentLease(run.identity.targetId);
    if (existing
      && existing.runId === run.identity.runId
      && existing.targetGeneration === run.identity.targetGeneration
      && existing.fencingToken === run.lease?.fencingToken) return run;
    const lease = await this.store.acquireLease({
      runId: run.identity.runId,
      targetId: run.identity.targetId,
      targetGeneration: run.identity.targetGeneration,
      holderId: normalizeIdentifier(holderId ?? actor.userId, "holderId"),
      now: this.timestamp(),
      leaseSeconds: leaseSeconds === undefined ? this.defaultLeaseSeconds : boundedSeconds(leaseSeconds, "lease"),
    });
    return this.saveRun({ ...run, lease, updatedAt: this.timestamp() });
  }

  private async failRun(run: ArchitectureSyncRun, failureClass: ArchitectureSyncFailureClass, code: string, stepId?: string): Promise<ArchitectureSyncRun> {
    const occurredAt = this.timestamp();
    return this.saveRun({
      ...run,
      failure: {
        schemaVersion: 1,
        class: failureClass,
        code: safeCode(code, "sync.failed"),
        occurredAt,
        retryable: failureClass === "transient" || failureClass === "lease-lost",
        ...(stepId ? { stepId } : {}),
      },
      updatedAt: occurredAt,
    });
  }

  private async recordExecutorFailure(run: ArchitectureSyncRun, actor: ArchitectureSyncActor, error: unknown, stepId?: string): Promise<ArchitectureSyncRun> {
    const executorError = error instanceof ArchitectureSyncExecutorError ? error : undefined;
    const failureClass: ArchitectureSyncFailureClass = executorError?.phase === "verify" ? "verification" : executorError?.phase === "rollback" ? "rollback" : "transient";
    const failed = await this.failRun(run, failureClass, safeCode(executorError?.code, "executor.failed"), stepId);
    await this.audit(failed, actor.userId, executorError?.phase === "rollback" ? "rollback" : "apply", "deny", safeCode(executorError?.code, "executor.failed"));
    return failed;
  }

  private async releaseLease(run: ArchitectureSyncRun): Promise<void> {
    if (!run.lease) return;
    await this.store.releaseLease({ targetId: run.identity.targetId, runId: run.identity.runId, fencingToken: run.lease.fencingToken });
  }

  private async blockAndThrow(run: ArchitectureSyncRun, actor: ArchitectureSyncActor, failure: GateFailure): Promise<never> {
    const blocked = await this.blockRun(run, actor, failure);
    void blocked;
    throw new ArchitectureSyncGateError(failure);
  }

  private async blockRun(run: ArchitectureSyncRun, actor: ArchitectureSyncActor, failure: GateFailure): Promise<ArchitectureSyncRun> {
    const failureClass: ArchitectureSyncFailureClass = failure.category === "consent"
      ? "consent"
      : failure.category === "generation"
        ? "stale-target"
        : failure.category === "lease"
          ? "lease-lost"
          : "authorization";
    const failed = await this.failRun(run, failureClass, failure.code);
    const next = await this.saveRun({
      ...failed,
      state: "blocked",
      receipts: [...failed.receipts, this.receipt(failed, "run", "failed", "run.blocked")],
      updatedAt: this.timestamp(),
    });
    await this.releaseLease(next);
    await this.audit(next, actor.userId, failure.category === "consent" ? "consent" : "apply", "deny", "run.blocked");
    return next;
  }

  private assertExpectedPlanDigest(run: ArchitectureSyncRun, expected?: string): void {
    if (expected !== undefined && expected !== run.digests.planDigest) {
      throw new AppError("The sync plan digest does not match this run.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409, {
        runId: run.identity.runId,
      });
    }
  }

  private assertMutationCapabilitiesFailClosed(run: ArchitectureSyncRun): void {
    for (const key of ["apply", "rollback", "sync.write"] as const) {
      if (run.capabilities?.[key] === true) throw new AppError("Mutation capabilities are not supported by the fixture sync service.", "ARCHITECTURE_SYNC_MUTATION_CAPABILITY_UNSUPPORTED", 400);
    }
  }

  private async audit(
    run: ArchitectureSyncRun,
    actorId: string,
    action: string,
    decision: "allow" | "deny",
    code: string,
    options: { readonly dedupeKey?: string } = {},
  ): Promise<void> {
    const safeAction = safeCode(`sync.${action}`, "sync.event");
    await this.store.recordAuditEvent({
      runId: run.identity.runId,
      actorId: normalizeIdentifier(actorId, "actorId"),
      action: safeAction,
      decision,
      code: safeCode(code, "sync.event"),
      recordedAt: this.timestamp(),
      ...(options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey }),
    });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function normalizeActor(input: ArchitectureSyncActorInput): ArchitectureSyncActor {
  const value = typeof input === "string" ? input : input.userId ?? input.id;
  return { userId: normalizeIdentifier(value, "actorId") };
}

function isInterruptedRunState(state: ArchitectureSyncRun["state"]): state is ArchitectureSyncRecoveryEvidence["sourceState"] {
  return ["lease_acquiring", "revalidating", "preparing", "applying", "verifying"].includes(state);
}

function normalizeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > architectureSyncControlLimits.identifierLength || !IDENTIFIER_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function normalizePreviewSteps(input: readonly ArchitectureSyncPreviewStepInput[], expectedGeneration: number): ArchitectureSyncStep[] {
  if (!Array.isArray(input) || input.length > architectureSyncControlLimits.steps) throw new AppError("Sync steps are invalid.", "ARCHITECTURE_SYNC_STEP_INVALID", 400);
  const ids = new Set<string>();
  return input.map((item, index) => {
    if (!item || typeof item !== "object") throw new AppError("Sync step is invalid.", "ARCHITECTURE_SYNC_STEP_INVALID", 400);
    const id = normalizeIdentifier(item.id ?? `step-${index + 1}`, "stepId");
    if (ids.has(id)) throw new AppError("Sync step ids must be unique.", "ARCHITECTURE_SYNC_DUPLICATE_STEP", 400);
    ids.add(id);
    const generation = item.targetGeneration ?? expectedGeneration;
    if (generation !== expectedGeneration) throw new AppError("Sync step target generation is stale.", "ARCHITECTURE_SYNC_GENERATION_STALE", 409);
    const metadata = sanitizeArchitectureSyncMetadata(item.metadata);
    return assertValidArchitectureSyncStep({
      schemaVersion: 1,
      id,
      ordinal: index + 1,
      action: item.action,
      nodeId: item.nodeId,
      targetGeneration: generation,
      state: "planned",
      idempotencyKey: `placeholder-${index + 1}`,
      ...(metadata === undefined ? {} : { metadata }),
    });
  });
}

function normalizeCapabilities(input: ArchitectureSyncCapabilitySet | undefined): ArchitectureSyncCapabilitySet {
  try {
    return assertValidArchitectureSyncCapabilities(input ?? DEFAULT_CAPABILITIES);
  } catch (error) {
    if (error instanceof Error && "errors" in error && Array.isArray(error.errors)) {
      throw new AppError("Sync capabilities are invalid.", "ARCHITECTURE_SYNC_CAPABILITY_INVALID", 400);
    }
    throw error;
  }
}

function boundedSeconds(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > architectureSyncControlLimits.leaseMaximumSeconds) {
    throw new AppError(`${field} duration is invalid.`, "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
  }
  return value;
}

function normalizeGate(value: ArchitectureSyncGateResult | boolean): ArchitectureSyncGateResult {
  if (typeof value === "boolean") return { allowed: value };
  if (!value || typeof value !== "object") return { allowed: false, reason: "denied" };
  return { allowed: value.allowed === true, ...(value.reason ? { reason: safeReason(value.reason, "denied") } : {}) };
}

function normalizeConsent(value: ArchitectureSyncConsentResult | boolean): ArchitectureSyncConsentResult {
  if (typeof value === "boolean") return { allowed: value };
  if (!value || typeof value !== "object") return { allowed: false, reason: "denied" };
  return {
    allowed: value.allowed === true,
    ...(value.reason ? { reason: safeReason(value.reason, "denied") } : {}),
    ...(value.currentTargetGeneration === undefined ? {} : { currentTargetGeneration: value.currentTargetGeneration }),
  };
}

function safeReason(value: unknown, fallback: string): string {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : fallback;
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : fallback;
}

function safeReceiptMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  if (/(?:https?:\/\/|ftp:\/\/|file:\/\/|\/Users\/|\/home\/|\/root\/|password|secret|token|credential|prompt|\b(?:raw\s+)?(?:config|configuration|package\s+content)\b)/i.test(value)) return undefined;
  return value;
}

function recoveryReceiptCode(decision: ArchitectureSyncRecoveryResult["decision"]): string {
  if (decision === "manual-intervention") return "recovery.manual";
  return `recovery.${decision}`;
}

function recoveryConditionForReceiptCode(code: string): ArchitectureSyncRecoveryCondition | undefined {
  const values: Record<string, ArchitectureSyncRecoveryCondition> = {
    "recovery.retry": "no-mutation",
    "recovery.succeed": "desired-readback",
    "recovery.rollback": "restorable-partial-state",
    "recovery.block": "ambiguous-readback",
    "recovery.manual": "irreversible-unrecoverable",
  };
  return values[code];
}

function executorAppError(error: unknown): AppError {
  const executorError = error instanceof ArchitectureSyncExecutorError ? error : undefined;
  return new AppError("Synthetic sync execution failed.", "ARCHITECTURE_SYNC_EXECUTOR_FAILED", 409, {
    phase: executorError?.phase ?? "unknown",
  });
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "unknown";
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
