/**
 * Framework-neutral, fixture-only sync control contracts.
 *
 * This module describes the durable journal that a future adapter may use
 * around a staged reconciliation.  It deliberately contains no adapter,
 * filesystem, network, database, authentication, or mutation surface.  A
 * plan, lease, receipt, and recovery decision are evidence and intent only;
 * they never authorize a target write by themselves.
 */


import { type ArchitectureSyncAction } from "./architecture.js";
export type { ArchitectureSyncAction } from "./architecture.js";

export const architectureSyncControlSchemaVersion = 1 as const;
export type ArchitectureSyncControlSchemaVersion = typeof architectureSyncControlSchemaVersion;

export const architectureSyncRunStates = [
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
] as const;
export type ArchitectureSyncRunState = (typeof architectureSyncRunStates)[number];

export const architectureSyncStepStates = [
  "planned",
  "prepared",
  "started",
  "succeeded",
  "verify_failed",
  "compensating",
  "compensated",
  "failed",
  "skipped",
] as const;
export type ArchitectureSyncStepState = (typeof architectureSyncStepStates)[number];

export const architectureSyncFailureClasses = [
  "validation",
  "authorization",
  "consent",
  "stale-target",
  "digest-mismatch",
  "conflict",
  "unsupported",
  "lease-lost",
  "transient",
  "verification",
  "mutation",
  "rollback",
  "ambiguous-readback",
  "irreversible",
  "unrecoverable",
] as const;
export type ArchitectureSyncFailureClass = (typeof architectureSyncFailureClasses)[number];

/** These names are intentionally evidence-oriented and not adapter methods. */
export const architectureSyncRecoveryConditions = [
  "no-mutation",
  "desired-readback",
  "restorable-partial-state",
  "ambiguous-readback",
  "irreversible-unrecoverable",
] as const;
export type ArchitectureSyncRecoveryCondition = (typeof architectureSyncRecoveryConditions)[number];
/** Readable underscore spellings accepted at API boundaries as aliases. */
export const architectureSyncRecoveryConditionAliases = {
  no_mutation: "no-mutation",
  desired_readback: "desired-readback",
  restorable_partial_state: "restorable-partial-state",
  ambiguous_readback: "ambiguous-readback",
  irreversible_unrecoverable: "irreversible-unrecoverable",
} as const;
export type ArchitectureSyncRecoveryConditionAlias = keyof typeof architectureSyncRecoveryConditionAliases;

export const architectureSyncRecoveryDecisions = [
  "retry",
  "succeed",
  "rollback",
  "block",
  "manual-intervention",
] as const;
export type ArchitectureSyncRecoveryDecision = (typeof architectureSyncRecoveryDecisions)[number];

/**
 * A recovery can only make a decision for a run that was observed in one of
 * these in-flight states.  Approved/queued and terminal runs are not
 * recoverable: accepting a caller-supplied condition for one of those states
 * could manufacture success without an interrupted operation.
 */
export const architectureSyncRecoverySourceStates = [
  "lease_acquiring",
  "revalidating",
  "preparing",
  "applying",
  "verifying",
] as const;
export type ArchitectureSyncRecoverySourceState = (typeof architectureSyncRecoverySourceStates)[number];

export const architectureSyncReadCapabilities = ["inventory.read", "health.read", "plan.read"] as const;
export type ArchitectureSyncReadCapability = (typeof architectureSyncReadCapabilities)[number];

/**
 * These names are reserved so v1 can reject an accidental write claim.  A
 * later adapter contract must define and authorize them before they can ever
 * be true.  This module does not define such an adapter contract.
 */
export const architectureSyncMutationCapabilities = ["apply", "rollback", "sync.write"] as const;
export type ArchitectureSyncMutationCapability = (typeof architectureSyncMutationCapabilities)[number];

export const architectureSyncCapabilityNames = [
  ...architectureSyncReadCapabilities,
  ...architectureSyncMutationCapabilities,
] as const;
export type ArchitectureSyncCapabilityName = (typeof architectureSyncCapabilityNames)[number];
export type ArchitectureSyncCapabilitySet = Partial<Record<ArchitectureSyncCapabilityName, boolean>>;

export const architectureSyncReceiptKinds = [
  "run",
  "step",
  "lease",
  "approval",
  "baseline",
  "apply",
  "verify",
  "rollback",
  "recovery",
] as const;
export type ArchitectureSyncReceiptKind = (typeof architectureSyncReceiptKinds)[number];

export const architectureSyncReceiptStatuses = [
  "accepted",
  "started",
  "succeeded",
  "failed",
  "skipped",
  "unknown",
] as const;
export type ArchitectureSyncReceiptStatus = (typeof architectureSyncReceiptStatuses)[number];

export const architectureSyncIdempotencyDecisions = ["new", "duplicate", "conflict"] as const;
export type ArchitectureSyncIdempotencyDecision = (typeof architectureSyncIdempotencyDecisions)[number];

/**
 * A successful run emits approval, apply, verify, and terminal receipts. Keep
 * one full apply/verify retry plus recovery/terminal headroom in the receipt
 * limit so a maximum-size run cannot be stranded while verifying.
 */
export const MAX_SYNC_STEPS = 500;
const SYNC_RECEIPTS_PER_STEP = 2;
const SYNC_RUN_RECEIPT_OVERHEAD = 2;
const SYNC_RETRY_RECEIPT_HEADROOM = SYNC_RECEIPTS_PER_STEP * MAX_SYNC_STEPS + 2;
export const MAX_SYNC_RECEIPTS = SYNC_RECEIPTS_PER_STEP * MAX_SYNC_STEPS
  + SYNC_RUN_RECEIPT_OVERHEAD
  + SYNC_RETRY_RECEIPT_HEADROOM;

export const architectureSyncControlLimits = {
  identifierLength: 128,
  runIdLength: 128,
  targetIdLength: 128,
  architectureIdLength: 128,
  revisionIdLength: 128,
  profileIdLength: 128,
  environmentIdLength: 128,
  stepIdLength: 128,
  leaseIdLength: 128,
  holderIdLength: 128,
  approvalIdLength: 128,
  baselineIdLength: 128,
  receiptIdLength: 128,
  codeLength: 96,
  messageLength: 512,
  metadataKeys: 32,
  metadataKeyLength: 64,
  metadataStringLength: 256,
  steps: MAX_SYNC_STEPS,
  receipts: MAX_SYNC_RECEIPTS,
  generationMaximum: 1_000_000_000,
  fencingTokenMaximum: 1_000_000_000_000,
  ordinalMaximum: 1_000_000,
  leaseMaximumSeconds: 3_600,
  canonicalMaximumDepth: 32,
  canonicalObjectKeys: 128,
} as const;

export type ArchitectureSyncDigest = string;
export type ArchitectureSyncMetadataValue = string | number | boolean | null;
export type ArchitectureSyncMetadata = Record<string, ArchitectureSyncMetadataValue>;

export interface ArchitectureSyncRunIdentity {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly architectureId: string;
  readonly revisionId: string;
  readonly profileId: string;
  readonly environmentId: string;
}

export interface ArchitectureSyncDigestSet {
  readonly desiredDigest: ArchitectureSyncDigest;
  readonly compiledDigest: ArchitectureSyncDigest;
  readonly observedDigest: ArchitectureSyncDigest;
  readonly planDigest: ArchitectureSyncDigest;
  readonly approvalDigest?: ArchitectureSyncDigest;
  readonly baselineDigest?: ArchitectureSyncDigest;
}

export interface ArchitectureSyncDigestSources {
  readonly desired: unknown;
  readonly compiled: unknown;
  readonly observed: unknown;
  /** Ordered step input. Reordering this array is significant. */
  readonly plan: readonly ArchitectureSyncStep[];
  readonly approval?: unknown;
  readonly baseline?: unknown;
}

export interface ArchitectureSyncApproval {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly id: string;
  readonly runId: string;
  readonly actorId: string;
  readonly planDigest: ArchitectureSyncDigest;
  readonly approvedAt: string;
  readonly expiresAt?: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncBaseline {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly id: string;
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly observedDigest: ArchitectureSyncDigest;
  /** True only when the recorded baseline is suitable for compensation. */
  readonly restorable: boolean;
  readonly capturedAt: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncStep {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly id: string;
  /** One-based, contiguous position in the immutable plan. */
  readonly ordinal: number;
  readonly action: ArchitectureSyncAction;
  readonly nodeId: string;
  readonly targetGeneration: number;
  readonly state: ArchitectureSyncStepState;
  readonly idempotencyKey: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncLease {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly leaseId: string;
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly holderId: string;
  /** Monotonic token; a lower or mismatched token is stale fencing. */
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface ArchitectureSyncFencingRecord {
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly fencingToken: number;
}

export interface ArchitectureSyncLeaseExpectation extends ArchitectureSyncFencingRecord {
  readonly runId?: string;
  readonly now?: string;
}

export interface ArchitectureSyncReceipt {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly id: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly kind: ArchitectureSyncReceiptKind;
  readonly status: ArchitectureSyncReceiptStatus;
  readonly code: string;
  readonly recordedAt: string;
  /** Digest of the bounded evidence for a recovery receipt, when present. */
  readonly evidenceDigest?: ArchitectureSyncDigest;
  readonly message?: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncFailure {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly class: ArchitectureSyncFailureClass;
  readonly code: string;
  readonly occurredAt: string;
  readonly retryable: boolean;
  readonly stepId?: string;
  readonly message?: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncRun {
  readonly schemaVersion: ArchitectureSyncControlSchemaVersion;
  readonly identity: ArchitectureSyncRunIdentity;
  readonly state: ArchitectureSyncRunState;
  readonly digests: ArchitectureSyncDigestSet;
  readonly steps: readonly ArchitectureSyncStep[];
  readonly receipts: readonly ArchitectureSyncReceipt[];
  readonly approval?: ArchitectureSyncApproval;
  readonly baseline?: ArchitectureSyncBaseline;
  readonly lease?: ArchitectureSyncLease;
  readonly failure?: ArchitectureSyncFailure;
  readonly capabilities?: ArchitectureSyncCapabilitySet;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: ArchitectureSyncMetadata;
}

export interface ArchitectureSyncRecoveryResult {
  readonly condition: ArchitectureSyncRecoveryCondition;
  readonly decision: ArchitectureSyncRecoveryDecision;
  readonly nextRunState: ArchitectureSyncRunState;
  readonly safeToRetry: boolean;
  readonly requiresManualReview: boolean;
}

/**
 * Explicit context required for the only non-forward run transitions.  Both
 * persistence adapters use this value; a boolean bypass is intentionally not
 * part of the contract.
 */
export interface ArchitectureSyncRecoveryTransition {
  readonly sourceState: ArchitectureSyncRecoverySourceState;
  readonly condition: ArchitectureSyncRecoveryCondition;
  readonly decision: ArchitectureSyncRecoveryDecision;
  readonly nextRunState: ArchitectureSyncRunState;
}

export interface ArchitectureSyncRecoveryEvidenceDigestInput {
  readonly runId: string;
  readonly targetId: string;
  readonly targetGeneration: number;
  readonly architectureId: string;
  readonly revisionId: string;
  readonly profileId: string;
  readonly environmentId: string;
  readonly desiredDigest: ArchitectureSyncDigest;
  readonly compiledDigest: ArchitectureSyncDigest;
  readonly observedDigest: ArchitectureSyncDigest;
  readonly planDigest: ArchitectureSyncDigest;
  readonly sourceState: ArchitectureSyncRecoverySourceState;
  readonly condition: ArchitectureSyncRecoveryCondition;
  readonly decision: ArchitectureSyncRecoveryDecision;
  readonly nextRunState: ArchitectureSyncRunState;
  /** Digest returned by the trusted readback/evidence port. */
  readonly evidenceDigest: ArchitectureSyncDigest;
}

export type ArchitectureSyncValidationCode =
  | "ARCHITECTURE_SYNC_INVALID_OBJECT"
  | "ARCHITECTURE_SYNC_UNKNOWN_FIELD"
  | "ARCHITECTURE_SYNC_SENSITIVE_FIELD"
  | "ARCHITECTURE_SYNC_UNSAFE_VALUE"
  | "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID"
  | "ARCHITECTURE_SYNC_IDENTIFIER_INVALID"
  | "ARCHITECTURE_SYNC_DIGEST_INVALID"
  | "ARCHITECTURE_SYNC_DIGEST_MISMATCH"
  | "ARCHITECTURE_SYNC_TIMESTAMP_INVALID"
  | "ARCHITECTURE_SYNC_GENERATION_INVALID"
  | "ARCHITECTURE_SYNC_GENERATION_STALE"
  | "ARCHITECTURE_SYNC_RUN_STATE_INVALID"
  | "ARCHITECTURE_SYNC_STEP_STATE_INVALID"
  | "ARCHITECTURE_SYNC_TRANSITION_INVALID"
  | "ARCHITECTURE_SYNC_ACTION_INVALID"
  | "ARCHITECTURE_SYNC_STEP_INVALID"
  | "ARCHITECTURE_SYNC_STEP_ORDER_INVALID"
  | "ARCHITECTURE_SYNC_DUPLICATE_STEP"
  | "ARCHITECTURE_SYNC_IDEMPOTENCY_KEY_INVALID"
  | "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT"
  | "ARCHITECTURE_SYNC_LEASE_INVALID"
  | "ARCHITECTURE_SYNC_FENCE_STALE"
  | "ARCHITECTURE_SYNC_CAPABILITY_INVALID"
  | "ARCHITECTURE_SYNC_MUTATION_CAPABILITY_ENABLED"
  | "ARCHITECTURE_SYNC_METADATA_INVALID"
  | "ARCHITECTURE_SYNC_RECEIPT_INVALID"
  | "ARCHITECTURE_SYNC_FAILURE_INVALID"
  | "ARCHITECTURE_SYNC_RECOVERY_INVALID"
  | "ARCHITECTURE_SYNC_LIMIT_EXCEEDED";

export interface ArchitectureSyncValidationIssue {
  readonly code: ArchitectureSyncValidationCode;
  readonly message: string;
  readonly path?: string;
}

export type ArchitectureSyncValidationResult<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly errors: readonly ArchitectureSyncValidationIssue[] };

export class ArchitectureSyncValidationError extends Error {
  public readonly code = "ARCHITECTURE_SYNC_VALIDATION_FAILED";
  public readonly statusCode = 422;

  constructor(public readonly errors: readonly ArchitectureSyncValidationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Architecture sync input is invalid.");
    this.name = "ArchitectureSyncValidationError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
export const codePattern = /^[a-z][a-z0-9._:-]{0,95}$/;
const metadataKeyPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const printableTextPattern = /^[^\u0000-\u001f\u007f]+$/;
const sensitiveKeyPattern = /(?:api[_-]?key|authorization|bearer|certificate|ciphertext|cookie|credential|directory|endpoint|filesystem|(?:^|[_-])file(?:name|path|system)?(?:$|[_-])|file(?:name|path|system)|header|host|password|path|private[-_ ]?key|prompt|package|(?:^|[_-])content(?:s)?(?:$|[_-])|content(?:s)|bundle|archive|secret|token|url|username)/i;
const unsafeValuePattern = /(?:https?:\/\/|ftp:\/\/|(?:^|[\s(])[A-Za-z]:[\\/]|(?:^|[\s(])\/(?:Users|home|root|private|var|tmp|etc|opt|workspace)(?:[\\/\s)]|$)|-----BEGIN [A-Z ]+-----|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}|(?:api[_-]?key|authorization|credential|password|private[-_ ]?key|secret|token)\s*[:=])/i;
const safeInputKeys = new Set(["fencingToken", "packageVisibility"]);

export const actionSet = new Set<string>([
  "noop",
  "install",
  "update",
  "downgrade",
  "enable",
  "disable",
  "remove",
  "conflict",
  "unsupported",
  "configure-router",
]);
export const recoveryConditionSet = new Set<string>(architectureSyncRecoveryConditions);

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

export function issue(
  errors: ArchitectureSyncValidationIssue[],
  code: ArchitectureSyncValidationCode,
  message: string,
  path?: string,
): void {
  errors.push(path ? { code, message, path } : { code, message });
}

export function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ArchitectureSyncValidationIssue[],
): void {
  for (const key of unknownKeys(value, allowed)) issue(errors, "ARCHITECTURE_SYNC_UNKNOWN_FIELD", `Field '${key}' is not accepted.`, `${path}.${key}`);
}

/**
 * Check key names and scalar values recursively before any record-specific
 * parser runs.  This keeps future fields from becoming an accidental data
 * exfiltration channel.
 */
export function checkSensitiveInput(value: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) checkSensitiveInput(item, `${path}[${index}]`, errors);
    return;
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && unsafeValuePattern.test(value)) issue(errors, "ARCHITECTURE_SYNC_UNSAFE_VALUE", "Raw paths, URLs, credentials, and package content are not accepted.", path);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key) && !safeInputKeys.has(key)) issue(errors, "ARCHITECTURE_SYNC_SENSITIVE_FIELD", `Field '${key}' is not permitted in sync records.`, `${path}.${key}`);
    checkSensitiveInput(item, `${path}.${key}`, errors);
  }
}

/** Bound generic digest inputs before canonicalization can do expensive work. */
export function checkCanonicalBounds(value: unknown, path: string, errors: ArchitectureSyncValidationIssue[], depth = 0): void {
  if (depth > architectureSyncControlLimits.canonicalMaximumDepth) {
    issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `Digest input nesting may not exceed ${architectureSyncControlLimits.canonicalMaximumDepth} levels.`, path);
    return;
  }
  if (typeof value === "string") {
    if (value.length > architectureSyncControlLimits.messageLength) issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `Digest input strings may contain at most ${architectureSyncControlLimits.messageLength} characters.`, path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > architectureSyncControlLimits.receipts) {
      issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `Digest input arrays may contain at most ${architectureSyncControlLimits.receipts} items.`, path);
      return;
    }
    for (const [index, item] of value.entries()) checkCanonicalBounds(item, `${path}[${index}]`, errors, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (Object.keys(value).length > architectureSyncControlLimits.canonicalObjectKeys) {
    issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `Digest input objects may contain at most ${architectureSyncControlLimits.canonicalObjectKeys} fields.`, path);
    return;
  }
  for (const [key, item] of Object.entries(value)) checkCanonicalBounds(item, `${path}.${key}`, errors, depth + 1);
}

export function validIdentifier(value: unknown, maximum = architectureSyncControlLimits.identifierLength): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && identifierPattern.test(value);
}

export function validDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

export function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || !printableTextPattern.test(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

export function validBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && printableTextPattern.test(value) && !unsafeValuePattern.test(value);
}

export function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function validateGeneration(
  value: unknown,
  path: string,
  errors: ArchitectureSyncValidationIssue[],
  expected?: number,
): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > architectureSyncControlLimits.generationMaximum) {
    issue(errors, "ARCHITECTURE_SYNC_GENERATION_INVALID", "Target generation must be a positive bounded integer.", path);
    return false;
  }
  if (expected !== undefined && value !== expected) issue(errors, "ARCHITECTURE_SYNC_GENERATION_STALE", "Target generation is stale for this sync operation.", path);
  return true;
}

export function normalizeMetadata(
  value: unknown,
  path: string,
  errors: ArchitectureSyncValidationIssue[],
): ArchitectureSyncMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_SYNC_METADATA_INVALID", "Metadata must be a bounded object of scalar values.", path);
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length > architectureSyncControlLimits.metadataKeys) {
    issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `Metadata may contain at most ${architectureSyncControlLimits.metadataKeys} fields.`, path);
  }
  const normalized: ArchitectureSyncMetadata = {};
  for (const [key, item] of entries) {
    if (!metadataKeyPattern.test(key) || sensitiveKeyPattern.test(key)) {
      issue(errors, "ARCHITECTURE_SYNC_SENSITIVE_FIELD", `Metadata field '${key}' is not allowed.`, `${path}.${key}`);
      continue;
    }
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      issue(errors, "ARCHITECTURE_SYNC_METADATA_INVALID", "Metadata values must be scalar.", `${path}.${key}`);
      continue;
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      issue(errors, "ARCHITECTURE_SYNC_METADATA_INVALID", "Metadata numbers must be finite.", `${path}.${key}`);
      continue;
    }
    if (typeof item === "string" && (!validBoundedText(item, architectureSyncControlLimits.metadataStringLength) || unsafeValuePattern.test(item))) {
      issue(errors, "ARCHITECTURE_SYNC_UNSAFE_VALUE", "Metadata values must not contain raw paths, URLs, credentials, or package content.", `${path}.${key}`);
      continue;
    }
    normalized[key] = item as ArchitectureSyncMetadataValue;
  }
  const ordered: ArchitectureSyncMetadata = {};
  for (const key of Object.keys(normalized).sort()) ordered[key] = normalized[key];
  return ordered;
}

export function normalizedIdentity(input: ArchitectureSyncRunIdentity): ArchitectureSyncRunIdentity {
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    runId: input.runId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration as number,
    architectureId: input.architectureId,
    revisionId: input.revisionId,
    profileId: input.profileId,
    environmentId: input.environmentId,
  };
}

export function validateIdentityRecord(
  input: unknown,
  path: string,
  errors: ArchitectureSyncValidationIssue[],
  expectedTargetGeneration?: number,
): ArchitectureSyncRunIdentity | undefined {
  if (!isRecord(input)) {
    issue(errors, "ARCHITECTURE_SYNC_INVALID_OBJECT", "Sync-run identity must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(input, ["schemaVersion", "runId", "targetId", "targetGeneration", "architectureId", "revisionId", "profileId", "environmentId"], path, errors);
  if (input.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  const fields = [
    ["runId", architectureSyncControlLimits.runIdLength],
    ["targetId", architectureSyncControlLimits.targetIdLength],
    ["architectureId", architectureSyncControlLimits.architectureIdLength],
    ["revisionId", architectureSyncControlLimits.revisionIdLength],
    ["profileId", architectureSyncControlLimits.profileIdLength],
    ["environmentId", architectureSyncControlLimits.environmentIdLength],
  ] as const;
  for (const [field, maximum] of fields) {
    if (!validIdentifier(input[field], maximum)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", `${field} must be a bounded identifier.`, `${path}.${field}`);
  }
  const validTargetGeneration = validateGeneration(input.targetGeneration, `${path}.targetGeneration`, errors, expectedTargetGeneration);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  if (!validTargetGeneration) return undefined;
  return normalizedIdentity({
    schemaVersion: architectureSyncControlSchemaVersion,
    runId: input.runId as string,
    targetId: input.targetId as string,
    targetGeneration: input.targetGeneration as number,
    architectureId: input.architectureId as string,
    revisionId: input.revisionId as string,
    profileId: input.profileId as string,
    environmentId: input.environmentId as string,
  });
}

export function validateArchitectureSyncRunIdentity(input: unknown, expectedTargetGeneration?: number): ArchitectureSyncValidationResult<ArchitectureSyncRunIdentity> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Sync-run identity must be an object." }] };
  checkSensitiveInput(input, "identity", errors);
  const value = validateIdentityRecord(input, "identity", errors, expectedTargetGeneration);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncRunIdentity(input: unknown, expectedTargetGeneration?: number): ArchitectureSyncRunIdentity {
  const result = validateArchitectureSyncRunIdentity(input, expectedTargetGeneration);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export function isArchitectureSyncRunIdentity(input: unknown): input is ArchitectureSyncRunIdentity {
  return validateArchitectureSyncRunIdentity(input).valid;
}
