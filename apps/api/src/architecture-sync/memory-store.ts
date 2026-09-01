import { randomUUID } from "node:crypto";
import {
  AppError,
  architectureSyncControlLimits,
  assertValidArchitectureSyncLease,
  assertValidArchitectureSyncReceipt,
  assertValidArchitectureSyncRun,
  canonicalizeJson,
  isValidArchitectureSyncCompensationTransition,
  isValidArchitectureSyncRecoveryStepTransition,
  isValidArchitectureSyncRecoveryTransition,
  isValidArchitectureSyncRunTransition,
  isValidArchitectureSyncStepTransition,
  type ArchitectureSyncLease,
  type ArchitectureSyncRun,
} from "@myskills-app/core";
import type {
  ArchitectureSyncAuditEvent,
  ArchitectureSyncCreateRunStoreInput,
  ArchitectureSyncCreateRunStoreResult,
  ArchitectureSyncLeaseAcquireInput,
  ArchitectureSyncApplyClaimInput,
  ArchitectureSyncApplyClaimResult,
  ArchitectureSyncRecoveryAtomicPhase,
  ArchitectureSyncRecoveryClaimInput,
  ArchitectureSyncRecoveryClaimResult,
  ArchitectureSyncRunSaveOptions,
  ArchitectureSyncStore,
} from "./types.js";
import { architectureSyncRecoveryReceiptCode } from "./types.js";
import {
  assertNoReservedArchitectureSyncMetadata,
  sanitizeArchitectureSyncMetadata,
} from "./metadata.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;

interface StoredLease {
  lease: ArchitectureSyncLease;
  active: boolean;
}

interface MemoryArchitectureSyncStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Test-only fault injection; production callers leave this unset. */
  readonly onRecoveryPhase?: (phase: ArchitectureSyncRecoveryAtomicPhase) => void;
}

interface IdempotencyRecord {
  actorId?: string;
  targetId: string;
  intentDigest: string;
  runId: string;
}

/**
 * Deterministic in-memory persistence for the fixture-only sync service.
 *
 * The store keeps only the public, digest-bound journal. Source snapshots are
 * intentionally not accepted by this boundary. The lease map models a
 * single current holder per target while retaining its latest fencing token.
 */
export class MemoryArchitectureSyncStore implements ArchitectureSyncStore {
  readonly kind = "memory" as const;

  private readonly runs = new Map<string, ArchitectureSyncRun>();
  private readonly requestKeys = new Map<string, IdempotencyRecord>();
  private readonly idempotencyKeys = new Map<string, IdempotencyRecord>();
  private readonly leases = new Map<string, StoredLease>();
  private readonly auditEvents: ArchitectureSyncAuditEvent[] = [];
  private readonly auditDedupeKeys = new Set<string>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onRecoveryPhase?: (phase: ArchitectureSyncRecoveryAtomicPhase) => void;
  private nextAuditNumber = 1;

  constructor(options: MemoryArchitectureSyncStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.onRecoveryPhase = options.onRecoveryPhase;
  }

  async createRun(input: ArchitectureSyncCreateRunStoreInput): Promise<ArchitectureSyncCreateRunStoreResult> {
    const actorId = validateIdentifier(input.actorId, "actorId");
    const requestKey = validateIdentifier(input.requestKey, "requestKey");
    const idempotencyKey = validateIdentifier(input.idempotencyKey, "idempotencyKey");
    const intentDigest = validateDigest(input.intentDigest, "intentDigest");
    const run = assertValidArchitectureSyncRun(input.run);
    assertSafeRunMetadata(run);
    this.assertReceiptIntegrity(run);
    if (run.identity.runId !== input.run.identity.runId) {
      throw new AppError("Sync run identity is invalid.", "ARCHITECTURE_SYNC_IDENTITY_CONFLICT", 409);
    }

    const requestRecord = this.requestKeys.get(`${actorId}\u0000${requestKey}`);
    if (requestRecord) return this.replayOrConflict(requestRecord, intentDigest);
    const idempotencyRecord = this.idempotencyKeys.get(`${run.identity.targetId}\u0000${idempotencyKey}`);
    if (idempotencyRecord) return this.replayOrConflict(idempotencyRecord, intentDigest);
    if (this.runs.has(run.identity.runId)) {
      throw new AppError("Sync run already exists.", "ARCHITECTURE_SYNC_RUN_ALREADY_EXISTS", 409);
    }

    const record: IdempotencyRecord = {
      actorId,
      targetId: run.identity.targetId,
      intentDigest,
      runId: run.identity.runId,
    };
    this.runs.set(run.identity.runId, cloneRun(run));
    this.requestKeys.set(`${actorId}\u0000${requestKey}`, record);
    this.idempotencyKeys.set(`${run.identity.targetId}\u0000${idempotencyKey}`, record);
    return { run: cloneRun(run), decision: "new" };
  }

  async getRun(runId: string): Promise<ArchitectureSyncRun | null> {
    const id = validateIdentifier(runId, "runId");
    const run = this.runs.get(id);
    return run ? cloneRun(run) : null;
  }

  /**
   * Atomically claim an apply delivery in the in-memory model. JavaScript
   * executes this synchronous section without interleaving another caller, so
   * the second delivery observes an active winner and is returned as a replay.
   */
  async claimApply(input: ArchitectureSyncApplyClaimInput): Promise<ArchitectureSyncApplyClaimResult> {
    const runId = validateIdentifier(input.runId, "runId");
    const targetId = validateIdentifier(input.targetId, "targetId");
    const targetGeneration = validateGeneration(input.targetGeneration);
    const holderId = validateIdentifier(input.holderId, "holderId");
    const now = validateTimestamp(input.now, "now");
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    const currentRun = this.runs.get(runId);
    if (!currentRun) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
    if (currentRun.identity.targetId !== targetId || currentRun.identity.targetGeneration !== targetGeneration) {
      throw new AppError("Sync run and target lease binding do not match.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
    }
    if (currentRun.state === "succeeded" || currentRun.state === "rolled_back") {
      return { decision: "completed", run: cloneRun(currentRun) };
    }
    const currentLease = this.leases.get(targetId);
    const nowMs = Date.parse(now);
    const leaseActive = currentLease?.active === true && Date.parse(currentLease.lease.expiresAt) > nowMs;
    if (leaseActive) {
      if (currentLease.lease.runId === runId && isInterruptedRunState(currentRun.state)) {
        return { decision: "in-progress", run: cloneRun(currentRun) };
      }
      throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
    }
    if (isInterruptedRunState(currentRun.state)) {
      // An interrupted run cannot be silently resumed after its lease is gone;
      // recovery must provide trusted readback evidence first.
      return { decision: "in-progress", run: cloneRun(currentRun) };
    }
    if (currentRun.state !== "approved" && currentRun.state !== "queued") {
      throw new AppError("Sync run is not ready to apply.", "ARCHITECTURE_SYNC_APPLY_STATE_INVALID", 409);
    }
    const lease = buildLease({
      runId,
      targetId,
      targetGeneration,
      holderId,
      now,
      leaseSeconds: input.leaseSeconds,
    }, currentLease?.lease.fencingToken ?? 0, `lease-${this.idFactory()}`);
    let run = cloneRun(currentRun);
    if (run.state === "approved") run = transitionRun(run, "queued");
    run = transitionRun(run, "lease_acquiring");
    run = { ...run, lease, state: "revalidating", updatedAt: now };
    this.runs.set(runId, cloneRun(run));
    this.leases.set(targetId, { lease, active: true });
    return { decision: "claimed", run: cloneRun(run) };
  }

  /**
   * Atomically claim a recovery lease and finalize its evidence. Recovery is
   * never allowed to reuse an active apply lease, even when that lease belongs
   * to the same run. A failed checkpoint restores the complete in-memory
   * journal so a caller can safely retry from the interrupted state.
   */
  async claimRecovery(input: ArchitectureSyncRecoveryClaimInput): Promise<ArchitectureSyncRecoveryClaimResult> {
    const run = assertValidArchitectureSyncRun(input.run);
    const nextRun = assertValidArchitectureSyncRun(input.nextRun);
    const runId = validateIdentifier(run.identity.runId, "runId");
    const targetId = validateIdentifier(run.identity.targetId, "targetId");
    const actorId = validateIdentifier(input.actorId, "actorId");
    const holderId = validateIdentifier(input.holderId, "holderId");
    const now = validateTimestamp(input.now, "now");
    const evidenceDigest = validateDigest(input.evidenceDigest, "evidenceDigest");
    if (!Number.isInteger(input.leaseSeconds)
      || input.leaseSeconds < 1
      || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    if (run.identity.targetId !== targetId || input.transition.sourceState !== run.state) {
      throw new AppError("Recovery source state does not match the sync run.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
    }
    if (nextRun.identity.runId !== runId
      || nextRun.identity.targetId !== targetId
      || nextRun.identity.targetGeneration !== run.identity.targetGeneration
      || nextRun.lease !== undefined
      || input.transition.nextRunState !== nextRun.state
      || input.recoveryReceipt.runId !== runId
      || input.recoveryReceipt.kind !== "recovery"
      || input.recoveryReceipt.evidenceDigest !== evidenceDigest
      || input.audit.runId !== runId
      || input.audit.actorId !== actorId) {
      throw new AppError("Recovery finalization is not bound to the sync run.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    if (architectureSyncRecoveryReceiptCode(input.transition) !== input.recoveryReceipt.code) {
      throw new AppError("Recovery receipt code does not match the canonical transition.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    assertValidArchitectureSyncReceipt(input.recoveryReceipt);
    const current = this.runs.get(runId);
    if (!current) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);

    const priorRecovery = current.receipts.find((receipt) => receipt.kind === "recovery"
      && receipt.code === input.recoveryReceipt.code
      && receipt.evidenceDigest === evidenceDigest);
    if (priorRecovery) return { decision: "replayed", run: cloneRun(current) };

    if (canonicalizeJson(current) !== canonicalizeJson(run)) {
      throw new AppError("Sync run changed before recovery could be claimed.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
    }
    if (!isInterruptedRunState(current.state)
      || !isValidArchitectureSyncRecoveryTransition({
        from: current.state,
        to: nextRun.state,
        transition: input.transition,
      })) {
      throw new AppError("Only an explicitly interrupted sync run can be recovered.", "ARCHITECTURE_SYNC_RECOVERY_STATE_INVALID", 409);
    }

    const currentLease = this.leases.get(targetId);
    const nowMs = Date.parse(now);
    if (currentLease?.active && Date.parse(currentLease.lease.expiresAt) > nowMs) {
      throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
    }
    if (currentLease && nowMs < Date.parse(currentLease.lease.acquiredAt)) {
      throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }

    const snapshotRuns = new Map<string, ArchitectureSyncRun>([...this.runs].map(([id, value]) => [id, cloneRun(value)]));
    const snapshotRequestKeys = new Map<string, IdempotencyRecord>(this.requestKeys);
    const snapshotIdempotencyKeys = new Map<string, IdempotencyRecord>(this.idempotencyKeys);
    const snapshotLeases = new Map<string, StoredLease>([...this.leases].map(([id, value]) => [id, {
      lease: structuredClone(value.lease),
      active: value.active,
    }]));
    const snapshotAudits = this.auditEvents.map((event) => structuredClone(event));
    const snapshotAuditDedupeKeys = new Set(this.auditDedupeKeys);
    const snapshotNextAuditNumber = this.nextAuditNumber;
    try {
      const lease = buildLease({
        runId,
        targetId,
        targetGeneration: run.identity.targetGeneration,
        holderId,
        now,
        leaseSeconds: input.leaseSeconds,
      }, currentLease?.lease.fencingToken ?? 0, `lease-${this.idFactory()}`);
      this.leases.set(targetId, { lease, active: true });
      this.onRecoveryPhase?.("after-claim");

      this.assertImmutableRunFields(current, nextRun);
      this.assertStepTransitions(current, nextRun, false, input.transition);
      if (!hasPrefix(current.receipts, nextRun.receipts)
        || nextRun.receipts.length !== current.receipts.length
        || Date.parse(nextRun.updatedAt) < Date.parse(current.updatedAt)) {
        throw new AppError("Recovery run snapshot is stale or mutable.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
      }
      const withLease: ArchitectureSyncRun = {
        ...nextRun,
        lease,
        receipts: [...nextRun.receipts, input.recoveryReceipt],
      };
      const finalized = assertValidArchitectureSyncRun(withLease);
      this.assertReceiptFencing(current, finalized);
      this.runs.set(runId, cloneRun(finalized));
      this.onRecoveryPhase?.("after-transition");
      // The receipt is the in-memory representation of the recovery evidence.
      this.onRecoveryPhase?.("after-evidence");
      await this.recordAuditEvent(input.audit);
      this.onRecoveryPhase?.("after-audit");
      const latest = this.leases.get(targetId);
      if (!latest
        || latest.lease.runId !== runId
        || latest.lease.targetId !== targetId
        || latest.lease.targetGeneration !== lease.targetGeneration
        || latest.lease.leaseId !== lease.leaseId
        || latest.lease.holderId !== lease.holderId
        || latest.lease.fencingToken !== lease.fencingToken) {
        throw new AppError("The recovery lease is no longer current.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
      }
      latest.active = false;
      this.onRecoveryPhase?.("after-lease-disposition");
      return { decision: "claimed", run: cloneRun(finalized) };
    } catch (error) {
      this.runs.clear();
      for (const [id, value] of snapshotRuns) this.runs.set(id, value);
      this.requestKeys.clear();
      for (const [id, value] of snapshotRequestKeys) this.requestKeys.set(id, value);
      this.idempotencyKeys.clear();
      for (const [id, value] of snapshotIdempotencyKeys) this.idempotencyKeys.set(id, value);
      this.leases.clear();
      for (const [id, value] of snapshotLeases) this.leases.set(id, value);
      this.auditEvents.splice(0, this.auditEvents.length, ...snapshotAudits);
      this.auditDedupeKeys.clear();
      for (const value of snapshotAuditDedupeKeys) this.auditDedupeKeys.add(value);
      this.nextAuditNumber = snapshotNextAuditNumber;
      throw error;
    }
  }

  async saveRun(
    input: ArchitectureSyncRun,
    options: ArchitectureSyncRunSaveOptions = {},
  ): Promise<ArchitectureSyncRun> {
    const run = assertValidArchitectureSyncRun(input);
    assertSafeRunMetadata(run);
    const existing = this.runs.get(run.identity.runId);
    if (!existing) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
    this.assertImmutableRunFields(existing, run);
    const runTransitionAllowed = existing.state === run.state
      || (options.recoveryTransition
        ? isValidArchitectureSyncRecoveryTransition({
          from: existing.state,
          to: run.state,
          transition: options.recoveryTransition,
        })
        : isValidArchitectureSyncRunTransition(existing.state, run.state));
    if (!runTransitionAllowed) {
      throw new AppError("Sync run state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
    }
    this.assertStepTransitions(existing, run, options.compensation === true, options.recoveryTransition);
    if (Date.parse(run.updatedAt) < Date.parse(existing.updatedAt)) {
      throw new AppError("Sync run timestamps must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }
    if (!hasPrefix(existing.receipts, run.receipts)) {
      throw new AppError("Sync receipts are append-only.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
    }
    this.assertReceiptIntegrity(run);
    this.assertReceiptFencing(existing, run);
    this.runs.set(run.identity.runId, cloneRun(run));
    return cloneRun(run);
  }

  async acquireLease(input: ArchitectureSyncLeaseAcquireInput): Promise<ArchitectureSyncLease> {
    const runId = validateIdentifier(input.runId, "runId");
    const targetId = validateIdentifier(input.targetId, "targetId");
    const holderId = validateIdentifier(input.holderId, "holderId");
    const targetGeneration = validateGeneration(input.targetGeneration);
    const now = validateTimestamp(input.now, "now");
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    const run = this.runs.get(runId);
    if (!run) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
    if (run.identity.targetId !== targetId || run.identity.targetGeneration !== targetGeneration) {
      throw new AppError("Sync run and target lease binding do not match.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
    }
    const current = this.leases.get(targetId);
    const nowMs = Date.parse(now);
    if (current?.active && Date.parse(current.lease.expiresAt) > nowMs) {
      throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
    }
    if (current && nowMs < Date.parse(current.lease.acquiredAt)) {
      throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }
    const fencingToken = (current?.lease.fencingToken ?? 0) + 1;
    if (fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
      throw new AppError("Sync fencing token limit was reached.", "ARCHITECTURE_SYNC_LEASE_INVALID", 409);
    }
    const lease: ArchitectureSyncLease = {
      schemaVersion: 1,
      leaseId: `lease-${this.idFactory()}`,
      runId,
      targetId,
      targetGeneration,
      holderId,
      fencingToken,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + input.leaseSeconds * 1_000).toISOString(),
    };
    assertValidArchitectureSyncLease(lease, {
      targetId,
      targetGeneration,
      fencingToken,
      runId,
    });
    this.leases.set(targetId, { lease, active: true });
    return structuredClone(lease);
  }

  async getCurrentLease(targetIdInput: string): Promise<ArchitectureSyncLease | null> {
    const targetId = validateIdentifier(targetIdInput, "targetId");
    const current = this.leases.get(targetId);
    if (!current || !current.active || Date.parse(current.lease.expiresAt) <= this.now().getTime()) return null;
    return structuredClone(current.lease);
  }

  async releaseLease(input: { readonly targetId: string; readonly runId: string; readonly fencingToken: number }): Promise<void> {
    const targetId = validateIdentifier(input.targetId, "targetId");
    const runId = validateIdentifier(input.runId, "runId");
    if (!Number.isInteger(input.fencingToken)
      || input.fencingToken < 1
      || input.fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
      throw new AppError("Lease fencing token is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    const current = this.leases.get(targetId);
    if (!current || current.lease.runId !== runId || current.lease.fencingToken !== input.fencingToken) return;
    current.active = false;
  }

  /** Test-only fixture control to simulate a lease expiring between boundaries. */
  expireLease(targetIdInput: string): void {
    const targetId = validateIdentifier(targetIdInput, "targetId");
    const current = this.leases.get(targetId);
    if (!current) return;
    current.active = false;
  }

  /** Test-only fixture control to force the next acquisition to fence this holder. */
  fenceTarget(targetIdInput: string): void {
    const targetId = validateIdentifier(targetIdInput, "targetId");
    const current = this.leases.get(targetId);
    if (!current) {
      this.leases.set(targetId, {
        active: false,
        lease: {
          schemaVersion: 1,
          leaseId: `lease-fence-${this.idFactory()}`,
          runId: "fenced-placeholder",
          targetId,
          targetGeneration: 1,
          holderId: "fenced-placeholder",
          fencingToken: 1,
          acquiredAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + 1_000).toISOString(),
        },
      });
      return;
    }
    current.active = false;
  }

  async recordAuditEvent(input: Omit<ArchitectureSyncAuditEvent, "id">): Promise<void> {
    const actorId = validateIdentifier(input.actorId, "actorId");
    const runId = validateIdentifier(input.runId, "runId");
    const action = validateCode(input.action, "action");
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new AppError("Audit decision is invalid.", "ARCHITECTURE_SYNC_AUDIT_INVALID", 400);
    }
    const code = validateCode(input.code, "code");
    const recordedAt = validateTimestamp(input.recordedAt, "recordedAt");
    assertNoReservedArchitectureSyncMetadata(input.metadata);
    const metadata = sanitizeArchitectureSyncMetadata(input.metadata);
    const dedupeKey = input.dedupeKey === undefined ? undefined : validateIdentifier(input.dedupeKey, "dedupeKey");
    const scopedDedupeKey = dedupeKey === undefined ? undefined : `${runId}\u0000${dedupeKey}`;
    if (scopedDedupeKey && this.auditDedupeKeys.has(scopedDedupeKey)) return;
    this.auditEvents.push({
      id: `sync-audit-${this.nextAuditNumber++}`,
      runId,
      actorId,
      action,
      decision: input.decision,
      code,
      recordedAt,
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(metadata ? { metadata } : {}),
    });
    if (scopedDedupeKey) this.auditDedupeKeys.add(scopedDedupeKey);
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureSyncAuditEvent[]> {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
    return this.auditEvents.slice(-bounded).reverse().map((event) => structuredClone(event));
  }

  private replayOrConflict(record: IdempotencyRecord, intentDigest: string): ArchitectureSyncCreateRunStoreResult {
    if (record.intentDigest !== intentDigest) {
      throw new AppError("The sync request key is already bound to different immutable inputs.", "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT", 409, {
        runId: record.runId,
      });
    }
    const run = this.runs.get(record.runId);
    if (!run) throw new AppError("Sync idempotency record is inconsistent.", "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT", 409);
    return { run: cloneRun(run), decision: "duplicate" };
  }

  private assertImmutableRunFields(previous: ArchitectureSyncRun, next: ArchitectureSyncRun): void {
    if (Date.parse(previous.createdAt) !== Date.parse(next.createdAt)) {
      throw new AppError("Sync run creation time is immutable.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }
    const previousProjection = immutableRunProjection(previous);
    const nextProjection = immutableRunProjection(next);
    if (canonicalizeJson(previousProjection) !== canonicalizeJson(nextProjection)) {
      throw new AppError("Sync run identity and digests are immutable.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
    }
    if (previous.approval && (!next.approval || canonicalizeJson(previous.approval) !== canonicalizeJson(next.approval))) {
      throw new AppError("Sync approval is immutable.", "ARCHITECTURE_SYNC_APPROVAL_IMMUTABLE", 409);
    }
    if (previous.baseline && (!next.baseline || canonicalizeJson(previous.baseline) !== canonicalizeJson(next.baseline))) {
      throw new AppError("Sync baseline is immutable.", "ARCHITECTURE_SYNC_BASELINE_IMMUTABLE", 409);
    }
    if (previous.lease && next.lease && next.lease.fencingToken < previous.lease.fencingToken) {
      throw new AppError("Sync lease fencing cannot move backwards.", "ARCHITECTURE_SYNC_FENCE_STALE", 409);
    }
    if (previous.lease && next.lease) {
      if (next.lease.fencingToken === previous.lease.fencingToken
        && canonicalizeJson(previous.lease) !== canonicalizeJson(next.lease)) {
        throw new AppError("Sync lease identity is immutable at a fencing token.", "ARCHITECTURE_SYNC_FENCE_STALE", 409);
      }
      if (next.lease.fencingToken > previous.lease.fencingToken
        && Date.parse(next.lease.acquiredAt) < Date.parse(previous.lease.acquiredAt)) {
        throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
      }
    }
  }

  private assertReceiptFencing(previous: ArchitectureSyncRun, next: ArchitectureSyncRun): void {
    const writeLikeKinds = new Set(["lease", "apply", "verify", "rollback", "recovery"]);
    const appended = next.receipts.slice(previous.receipts.length);
    for (const receipt of appended) {
      if (!writeLikeKinds.has(receipt.kind)) continue;
      const current = this.leases.get(next.identity.targetId);
      if (!current || !current.active || !next.lease
        || current.lease.runId !== next.identity.runId
        || current.lease.targetGeneration !== next.identity.targetGeneration
        || current.lease.fencingToken !== next.lease.fencingToken
        || current.lease.leaseId !== next.lease.leaseId
        || current.lease.holderId !== next.lease.holderId
        || Date.parse(receipt.recordedAt) < Date.parse(current.lease.acquiredAt)
        || Date.parse(current.lease.expiresAt) <= this.now().getTime()
        || Date.parse(current.lease.expiresAt) <= Date.parse(receipt.recordedAt)) {
        throw new AppError("Write-like sync evidence requires the current lease and fencing token.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
      }
    }
  }

  private assertReceiptIntegrity(run: ArchitectureSyncRun): void {
    const receiptIds = new Set<string>();
    const stepIds = new Set(run.steps.map((step) => step.id));
    for (const receipt of run.receipts) {
      if (receiptIds.has(receipt.id)) {
        throw new AppError("Sync receipt ids must be unique.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
      }
      receiptIds.add(receipt.id);
      if (receipt.stepId && !stepIds.has(receipt.stepId)) {
        throw new AppError("Sync receipt stepId does not belong to the immutable run plan.", "ARCHITECTURE_SYNC_RECEIPT_INVALID", 409);
      }
    }
  }

  private assertStepTransitions(
    previous: ArchitectureSyncRun,
    next: ArchitectureSyncRun,
    allowCompensation: boolean,
    recoveryTransition: ArchitectureSyncRunSaveOptions["recoveryTransition"],
  ): void {
    for (const previousStep of previous.steps) {
      const nextStep = next.steps.find((candidate) => candidate.id === previousStep.id);
      if (!nextStep || previousStep.state === nextStep.state) continue;
      if (!isValidArchitectureSyncStepTransition(previousStep.state, nextStep.state)
        && !(allowCompensation && isValidArchitectureSyncCompensationTransition(previousStep.state, nextStep.state))
        && !(recoveryTransition && isValidArchitectureSyncRecoveryStepTransition(previousStep.state, nextStep.state, recoveryTransition))) {
        throw new AppError("Sync step state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
      }
    }
  }
}

function immutableRunProjection(run: ArchitectureSyncRun): Record<string, unknown> {
  return {
    identity: run.identity,
    digests: {
      desiredDigest: run.digests.desiredDigest,
      compiledDigest: run.digests.compiledDigest,
      observedDigest: run.digests.observedDigest,
      planDigest: run.digests.planDigest,
      ...(run.digests.baselineDigest === undefined ? {} : { baselineDigest: run.digests.baselineDigest }),
    },
    steps: run.steps.map((step) => ({
      schemaVersion: step.schemaVersion,
      id: step.id,
      ordinal: step.ordinal,
      action: step.action,
      nodeId: step.nodeId,
      targetGeneration: step.targetGeneration,
      idempotencyKey: step.idempotencyKey,
      ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
    })),
    capabilities: run.capabilities,
  };
}

function cloneRun(run: ArchitectureSyncRun): ArchitectureSyncRun {
  return structuredClone(run);
}

function assertSafeRunMetadata(run: ArchitectureSyncRun): void {
  assertNoReservedArchitectureSyncMetadata(run.metadata);
  sanitizeArchitectureSyncMetadata(run.metadata);
  for (const step of run.steps) {
    assertNoReservedArchitectureSyncMetadata(step.metadata);
    sanitizeArchitectureSyncMetadata(step.metadata);
  }
  for (const receipt of run.receipts) {
    assertNoReservedArchitectureSyncMetadata(receipt.metadata);
    sanitizeArchitectureSyncMetadata(receipt.metadata);
  }
  if (run.approval) {
    assertNoReservedArchitectureSyncMetadata(run.approval.metadata);
    sanitizeArchitectureSyncMetadata(run.approval.metadata);
  }
  if (run.baseline) {
    assertNoReservedArchitectureSyncMetadata(run.baseline.metadata);
    sanitizeArchitectureSyncMetadata(run.baseline.metadata);
  }
  if (run.failure) {
    assertNoReservedArchitectureSyncMetadata(run.failure.metadata);
    sanitizeArchitectureSyncMetadata(run.failure.metadata);
  }
}

function isInterruptedRunState(state: ArchitectureSyncRun["state"]): boolean {
  return ["lease_acquiring", "revalidating", "preparing", "applying", "verifying"].includes(state);
}

function transitionRun(run: ArchitectureSyncRun, state: ArchitectureSyncRun["state"]): ArchitectureSyncRun {
  if (!isValidArchitectureSyncRunTransition(run.state, state)) {
    throw new AppError("Sync run state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
  }
  return { ...run, state };
}

function buildLease(input: ArchitectureSyncLeaseAcquireInput, previousFencingToken: number, leaseId = `lease-${input.runId}-${previousFencingToken + 1}`): ArchitectureSyncLease {
  const fencingToken = previousFencingToken + 1;
  if (fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
    throw new AppError("Sync fencing token limit was reached.", "ARCHITECTURE_SYNC_LEASE_INVALID", 409);
  }
  const lease: ArchitectureSyncLease = {
    schemaVersion: 1,
    leaseId,
    runId: input.runId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    holderId: input.holderId,
    fencingToken,
    acquiredAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + input.leaseSeconds * 1_000).toISOString(),
  };
  return assertValidArchitectureSyncLease(lease, {
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    fencingToken,
    runId: input.runId,
  });
}

function hasPrefix<T>(prefix: readonly T[], value: readonly T[]): boolean {
  if (value.length < prefix.length) return false;
  return prefix.every((item, index) => canonicalizeJson(item) === canonicalizeJson(value[index]));
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value) || value.length > architectureSyncControlLimits.identifierLength) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function validateDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_DIGEST_INVALID", 400);
  }
  return value;
}

function validateCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_CODE_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function validateGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > architectureSyncControlLimits.generationMaximum) {
    throw new AppError("Target generation is invalid.", "ARCHITECTURE_SYNC_GENERATION_INVALID", 400);
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 400);
  }
  return value;
}
