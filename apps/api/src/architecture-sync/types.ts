import type {
  ArchitectureSyncAction,
  ArchitectureSyncApproval,
  ArchitectureSyncBaseline,
  ArchitectureSyncCapabilitySet,
  ArchitectureSyncDigestSet,
  ArchitectureSyncFailureClass,
  ArchitectureSyncLease,
  ArchitectureSyncMetadata,
  ArchitectureSyncRecoveryCondition,
  ArchitectureSyncRecoveryConditionAlias,
  ArchitectureSyncRecoveryDecision,
  ArchitectureSyncRecoverySourceState,
  ArchitectureSyncRecoveryTransition,
  ArchitectureSyncRecoveryResult,
  ArchitectureSyncReceipt,
  ArchitectureSyncRun,
  ArchitectureSyncStep,
} from "@myskills-app/core";

export type {
  ArchitectureSyncAction,
  ArchitectureSyncApproval,
  ArchitectureSyncBaseline,
  ArchitectureSyncCapabilitySet,
  ArchitectureSyncDigestSet,
  ArchitectureSyncFailureClass,
  ArchitectureSyncLease,
  ArchitectureSyncMetadata,
  ArchitectureSyncRecoveryCondition,
  ArchitectureSyncRecoveryConditionAlias,
  ArchitectureSyncRecoveryDecision,
  ArchitectureSyncRecoverySourceState,
  ArchitectureSyncRecoveryTransition,
  ArchitectureSyncRecoveryResult,
  ArchitectureSyncReceipt,
  ArchitectureSyncRun,
  ArchitectureSyncStep,
};

/**
 * Recovery receipts use a canonical code for each condition/decision/state
 * transition. Stores call this before journaling so a direct caller cannot
 * attach an unrelated or unknown code to otherwise valid recovery evidence.
 */
export function architectureSyncRecoveryReceiptCode(
  transition: ArchitectureSyncRecoveryTransition,
): string | undefined {
  const values = [
    { condition: "no-mutation", decision: "retry", nextRunState: "queued", code: "recovery.retry" },
    { condition: "desired-readback", decision: "succeed", nextRunState: "succeeded", code: "recovery.succeed" },
    { condition: "restorable-partial-state", decision: "rollback", nextRunState: "rollback_required", code: "recovery.rollback" },
    { condition: "ambiguous-readback", decision: "block", nextRunState: "blocked", code: "recovery.block" },
    { condition: "irreversible-unrecoverable", decision: "manual-intervention", nextRunState: "rollback_failed", code: "recovery.manual" },
  ] as const;
  return values.find((value) => value.condition === transition.condition
    && value.decision === transition.decision
    && value.nextRunState === transition.nextRunState)?.code;
}

export const architectureSyncExecutorFailurePhases = [
  "before-mutation",
  "after-mutation-before-receipt",
  "verify",
  "rollback",
] as const;
export type ArchitectureSyncExecutorFailurePhase = (typeof architectureSyncExecutorFailurePhases)[number];

/** A sync actor is deliberately only an application user id. */
export type ArchitectureSyncActorInput = string | { readonly userId?: string; readonly id?: string };

export interface ArchitectureSyncActor {
  readonly userId: string;
}

/**
 * The preview contract accepts only metadata digests as a public result. The
 * source snapshots are consumed to calculate digests and are never retained
 * by the memory store.
 */
export interface ArchitectureSyncPreviewStepInput {
  readonly id?: string;
  readonly action: ArchitectureSyncAction;
  readonly nodeId: string;
  readonly targetGeneration?: number;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncBaselineInput {
  readonly id?: string;
  readonly observedDigest?: string;
  readonly restorable: boolean;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncPreviewInput {
  readonly actor: ArchitectureSyncActorInput;
  readonly requestKey: string;
  readonly idempotencyKey: string;
  readonly runId?: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly architectureId: string;
  readonly revisionId: string;
  readonly profileId: string;
  readonly environmentId: string;
  /** Metadata-only snapshots. They are hashed and then discarded. */
  readonly desired: unknown;
  readonly compiled: unknown;
  readonly observed: unknown;
  readonly steps: readonly ArchitectureSyncPreviewStepInput[];
  readonly baseline?: ArchitectureSyncBaselineInput;
  readonly capabilities?: ArchitectureSyncCapabilitySet;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncPreviewResult {
  readonly run: ArchitectureSyncRun;
  readonly replayed: boolean;
}

export interface ArchitectureSyncApprovalInput {
  readonly actor: ArchitectureSyncActorInput;
  readonly runId: string;
  readonly expectedPlanDigest?: string;
  readonly expiresInSeconds?: number;
}

export interface ArchitectureSyncApplyInput {
  readonly actor: ArchitectureSyncActorInput;
  readonly runId: string;
  readonly expectedPlanDigest?: string;
  readonly holderId?: string;
  readonly leaseSeconds?: number;
}

export interface ArchitectureSyncRecoveryInput {
  readonly actor: ArchitectureSyncActorInput;
  readonly runId: string;
  /** Compatibility hint only. It is never authoritative for recovery. */
  readonly condition?: ArchitectureSyncRecoveryCondition | ArchitectureSyncRecoveryConditionAlias;
  /** Optional recovery lease holder; defaults to the actor at the service boundary. */
  readonly holderId?: string;
  /** Optional recovery lease duration; bounded by the service/store contract. */
  readonly leaseSeconds?: number;
}

export interface ArchitectureSyncRollbackInput {
  readonly actor: ArchitectureSyncActorInput;
  readonly runId: string;
  readonly expectedBaselineDigest?: string;
  readonly holderId?: string;
  readonly leaseSeconds?: number;
}

export type ArchitectureSyncGateAction = "approve" | "apply" | "recover" | "rollback";

export interface ArchitectureSyncAuthorizationRequest {
  readonly actorId: string;
  readonly run: ArchitectureSyncRun;
  readonly action: ArchitectureSyncGateAction;
}

export interface ArchitectureSyncRecoveryEvidenceRequest {
  readonly actorId: string;
  readonly run: ArchitectureSyncRun;
}

/**
 * Metadata-only readback from the injected, trusted recovery boundary. The
 * service validates and binds evidenceDigest before it is persisted.
 */
export interface ArchitectureSyncRecoveryEvidence {
  readonly sourceState: ArchitectureSyncRecoverySourceState;
  readonly condition: ArchitectureSyncRecoveryCondition;
  readonly decision: ArchitectureSyncRecoveryDecision;
  readonly nextRunState: ArchitectureSyncRun["state"];
  readonly evidenceDigest: string;
}

export interface ArchitectureSyncRecoveryPort {
  read(input: ArchitectureSyncRecoveryEvidenceRequest): Promise<ArchitectureSyncRecoveryEvidence | null>;
}

export interface ArchitectureSyncGateResult {
  readonly allowed: boolean;
  /** A bounded reason code. It is never copied from an untrusted message. */
  readonly reason?: string;
}

export interface ArchitectureSyncAuthorizationPort {
  authorize(input: ArchitectureSyncAuthorizationRequest): Promise<ArchitectureSyncGateResult | boolean>;
}

export interface ArchitectureSyncMfaRequest {
  readonly actorId: string;
  readonly runId: string;
  readonly action: ArchitectureSyncGateAction;
}

export interface ArchitectureSyncMfaPort {
  verify(input: ArchitectureSyncMfaRequest): Promise<ArchitectureSyncGateResult | boolean>;
}

export interface ArchitectureSyncConsentRequest {
  readonly actorId: string;
  readonly run: ArchitectureSyncRun;
  readonly action: ArchitectureSyncGateAction;
  readonly boundary: "approval" | "before-apply" | "before-step" | "before-verify" | "before-rollback";
}

export interface ArchitectureSyncConsentResult extends ArchitectureSyncGateResult {
  /** Authority may return the current generation for a stale-target check. */
  readonly currentTargetGeneration?: number;
}

export interface ArchitectureSyncConsentPort {
  check(input: ArchitectureSyncConsentRequest): Promise<ArchitectureSyncConsentResult | boolean>;
}

export interface ArchitectureSyncExecutorDigests {
  readonly desiredDigest: string;
  readonly compiledDigest: string;
  readonly observedDigest: string;
  readonly planDigest: string;
}

export interface ArchitectureSyncExecutorApplyInput {
  readonly run: ArchitectureSyncRun;
  readonly step: ArchitectureSyncStep;
  readonly lease: ArchitectureSyncLease;
  readonly digests: ArchitectureSyncExecutorDigests;
}

export interface ArchitectureSyncExecutorVerifyInput {
  readonly run: ArchitectureSyncRun;
  readonly step: ArchitectureSyncStep;
  readonly lease: ArchitectureSyncLease;
  readonly digests: ArchitectureSyncExecutorDigests;
}

export interface ArchitectureSyncExecutorRollbackInput {
  readonly run: ArchitectureSyncRun;
  readonly baseline: ArchitectureSyncBaseline;
  readonly lease: ArchitectureSyncLease;
  readonly digests: ArchitectureSyncExecutorDigests;
}

export interface ArchitectureSyncExecutorReceiptInput {
  readonly status: "accepted" | "started" | "succeeded" | "failed" | "skipped" | "unknown";
  readonly code: string;
  readonly message?: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncExecutorApplyResult {
  readonly mutated: boolean;
  readonly receipt?: ArchitectureSyncExecutorReceiptInput;
}

export interface ArchitectureSyncExecutorVerifyResult {
  readonly ok: boolean;
  readonly condition?: ArchitectureSyncRecoveryCondition;
  readonly receipt?: ArchitectureSyncExecutorReceiptInput;
}

export interface ArchitectureSyncExecutorRollbackResult {
  readonly ok: boolean;
  readonly receipt?: ArchitectureSyncExecutorReceiptInput;
}

/**
 * The only executor surface supported by this phase. Implementations must be
 * synthetic and local; they receive no specifications, observations, paths,
 * credentials, URLs, prompts, or target clients.
 */
export interface ArchitectureSyncFixtureExecutor {
  readonly kind: "fixture";
  apply(input: ArchitectureSyncExecutorApplyInput): Promise<ArchitectureSyncExecutorApplyResult>;
  verify(input: ArchitectureSyncExecutorVerifyInput): Promise<ArchitectureSyncExecutorVerifyResult>;
  rollback(input: ArchitectureSyncExecutorRollbackInput): Promise<ArchitectureSyncExecutorRollbackResult>;
}

export interface ArchitectureSyncExecutorFailureOptions {
  readonly phase: ArchitectureSyncExecutorFailurePhase;
  readonly condition?: ArchitectureSyncRecoveryCondition;
  readonly code?: string;
  readonly mutateBeforeThrow?: boolean;
}

export class ArchitectureSyncExecutorError extends Error {
  public readonly code: string;
  public readonly phase: ArchitectureSyncExecutorFailurePhase;
  public readonly mutated: boolean;
  public readonly condition?: ArchitectureSyncRecoveryCondition;

  constructor(options: ArchitectureSyncExecutorFailureOptions) {
    super("Synthetic sync executor failure.");
    this.name = "ArchitectureSyncExecutorError";
    this.code = options.code ?? `executor.${options.phase.replaceAll("-", ".")}`;
    this.phase = options.phase;
    this.mutated = options.mutateBeforeThrow === true;
    this.condition = options.condition;
  }
}

export interface ArchitectureSyncAuditEvent {
  readonly id: string;
  readonly runId: string;
  readonly actorId: string;
  readonly action: string;
  readonly decision: "allow" | "deny";
  readonly code: string;
  readonly recordedAt: string;
  /** Optional stable key used by replay-safe terminal finalization. */
  readonly dedupeKey?: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

/**
 * Atomic recovery finalization input. The service supplies the immutable
 * before/after snapshots and trusted evidence; the store claims a new fence,
 * records the recovery evidence/receipt, disposes the lease, and appends the
 * deduplicated audit event in one transaction.
 */
export interface ArchitectureSyncRecoveryClaimInput {
  readonly run: ArchitectureSyncRun;
  readonly nextRun: ArchitectureSyncRun;
  readonly transition: ArchitectureSyncRecoveryTransition;
  readonly evidenceDigest: string;
  readonly recoveryReceipt: ArchitectureSyncReceipt;
  readonly actorId: string;
  readonly holderId: string;
  readonly now: string;
  readonly leaseSeconds: number;
  readonly audit: Omit<ArchitectureSyncAuditEvent, "id">;
}

export interface ArchitectureSyncRecoveryClaimResult {
  /** claimed is the sole recovery finalizer; replayed is an idempotent retry. */
  readonly decision: "claimed" | "replayed";
  readonly run: ArchitectureSyncRun;
}

/** Test-only checkpoints used to prove atomic recovery rollback behavior. */
export type ArchitectureSyncRecoveryAtomicPhase =
  | "after-claim"
  | "after-transition"
  | "after-evidence"
  | "after-audit"
  | "after-lease-disposition";

export interface ArchitectureSyncCreateRunStoreInput {
  readonly actorId: string;
  readonly requestKey: string;
  readonly idempotencyKey: string;
  /** Stable intent digest excludes generated ids and timestamps. */
  readonly intentDigest: string;
  readonly run: ArchitectureSyncRun;
}

export interface ArchitectureSyncCreateRunStoreResult {
  readonly run: ArchitectureSyncRun;
  readonly decision: "new" | "duplicate" | "conflict";
}

export interface ArchitectureSyncApplyClaimInput {
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly holderId: string;
  readonly now: string;
  readonly leaseSeconds: number;
}

export interface ArchitectureSyncApplyClaimResult {
  /** claimed is the sole delivery allowed to execute; in-progress is replay. */
  readonly decision: "claimed" | "in-progress" | "completed";
  readonly run: ArchitectureSyncRun;
}

export interface ArchitectureSyncRunSaveOptions {
  readonly recoveryTransition?: ArchitectureSyncRecoveryTransition;
  readonly compensation?: boolean;
}

export interface ArchitectureSyncLeaseAcquireInput {
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly holderId: string;
  readonly now: string;
  readonly leaseSeconds: number;
}

export interface ArchitectureSyncStore {
  readonly kind: "memory" | "postgres";
  createRun(input: ArchitectureSyncCreateRunStoreInput): Promise<ArchitectureSyncCreateRunStoreResult>;
  getRun(runId: string): Promise<ArchitectureSyncRun | null>;
  saveRun(run: ArchitectureSyncRun, options?: ArchitectureSyncRunSaveOptions): Promise<ArchitectureSyncRun>;
  claimApply(input: ArchitectureSyncApplyClaimInput): Promise<ArchitectureSyncApplyClaimResult>;
  claimRecovery(input: ArchitectureSyncRecoveryClaimInput): Promise<ArchitectureSyncRecoveryClaimResult>;
  acquireLease(input: ArchitectureSyncLeaseAcquireInput): Promise<ArchitectureSyncLease>;
  getCurrentLease(targetId: string): Promise<ArchitectureSyncLease | null>;
  releaseLease(input: { readonly targetId: string; readonly runId: string; readonly fencingToken: number }): Promise<void>;
  recordAuditEvent(input: Omit<ArchitectureSyncAuditEvent, "id">): Promise<void>;
  listAuditEvents(limit?: number): Promise<ArchitectureSyncAuditEvent[]>;
}

export interface ArchitectureSyncServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly defaultLeaseSeconds?: number;
  readonly defaultApprovalSeconds?: number;
}
