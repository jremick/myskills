/**
 * Strict validation and normalization for architecture sync records.
 *
 * Validation is intentionally fail-closed: unknown fields, sensitive values,
 * stale generations, mismatched digests, and invalid transitions are rejected
 * before a record can reach a persistence adapter.
 */

import {
  actionSet,
  architectureSyncCapabilityNames,
  architectureSyncControlLimits,
  architectureSyncControlSchemaVersion,
  architectureSyncFailureClasses,
  architectureSyncMutationCapabilities,
  architectureSyncReceiptKinds,
  architectureSyncReceiptStatuses,
  architectureSyncRunStates,
  architectureSyncStepStates,
  checkSensitiveInput,
  checkUnknownKeys,
  codePattern,
  isOneOf,
  isRecord,
  issue,
  normalizeMetadata,
  validBoundedText,
  validDigest,
  validIdentifier,
  validTimestamp,
  validateGeneration,
  validateIdentityRecord,
  type ArchitectureSyncAction,
  type ArchitectureSyncApproval,
  type ArchitectureSyncBaseline,
  type ArchitectureSyncCapabilityName,
  type ArchitectureSyncCapabilitySet,
  type ArchitectureSyncDigestSet,
  type ArchitectureSyncDigestSources,
  type ArchitectureSyncFailure,
  type ArchitectureSyncFailureClass,
  type ArchitectureSyncFencingRecord,
  type ArchitectureSyncLease,
  type ArchitectureSyncLeaseExpectation,
  type ArchitectureSyncReceipt,
  type ArchitectureSyncReceiptKind,
  type ArchitectureSyncReceiptStatus,
  type ArchitectureSyncRun,
  type ArchitectureSyncRunIdentity,
  type ArchitectureSyncStep,
  type ArchitectureSyncStepState,
  type ArchitectureSyncValidationIssue,
  type ArchitectureSyncValidationResult,
  ArchitectureSyncValidationError,
} from "./architecture-sync-contracts.js";
import {
  architectureSyncCompiledDigest,
  architectureSyncDesiredDigest,
  architectureSyncObservedDigest,
  architectureSyncPlanDigest,
  architectureSyncSnapshotDigest,
  architectureSyncStepIdempotencyKey,
} from "./architecture-sync-digests.js";

function validateDigestField(value: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): value is string {
  if (!validDigest(value)) {
    issue(errors, "ARCHITECTURE_SYNC_DIGEST_INVALID", "Digest must be a lowercase SHA-256 hex digest.", path);
    return false;
  }
  return true;
}

function validateDigestSetRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): ArchitectureSyncDigestSet | undefined {
  if (!isRecord(input)) {
    issue(errors, "ARCHITECTURE_SYNC_INVALID_OBJECT", "Sync digest set must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(input, ["desiredDigest", "compiledDigest", "observedDigest", "planDigest", "approvalDigest", "baselineDigest"], path, errors);
  for (const field of ["desiredDigest", "compiledDigest", "observedDigest", "planDigest"] as const) validateDigestField(input[field], `${path}.${field}`, errors);
  for (const field of ["approvalDigest", "baselineDigest"] as const) {
    if (input[field] !== undefined) validateDigestField(input[field], `${path}.${field}`, errors);
  }
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    desiredDigest: input.desiredDigest as string,
    compiledDigest: input.compiledDigest as string,
    observedDigest: input.observedDigest as string,
    planDigest: input.planDigest as string,
    ...(input.approvalDigest === undefined ? {} : { approvalDigest: input.approvalDigest as string }),
    ...(input.baselineDigest === undefined ? {} : { baselineDigest: input.baselineDigest as string }),
  };
}

export function validateArchitectureSyncDigestSet(input: unknown): ArchitectureSyncValidationResult<ArchitectureSyncDigestSet> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Sync digest set must be an object." }] };
  checkSensitiveInput(input, "digests", errors);
  const value = validateDigestSetRecord(input, "digests", errors);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncDigestSet(input: unknown): ArchitectureSyncDigestSet {
  const result = validateArchitectureSyncDigestSet(input);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export interface ArchitectureSyncDigestValidationOptions {
  readonly expected?: Partial<ArchitectureSyncDigestSet>;
}

/**
 * Validate a digest set against immutable source snapshots.  Source values
 * are not retained by this function and may only contain safe JSON metadata.
 */
export function validateArchitectureSyncDigests(
  input: unknown,
  sources?: Partial<ArchitectureSyncDigestSources>,
): ArchitectureSyncValidationResult<ArchitectureSyncDigestSet> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Sync digest set must be an object." }] };
  checkSensitiveInput(input, "digests", errors);
  const value = validateDigestSetRecord(input, "digests", errors);
  if (!value) return { valid: false, errors };
  const deriveDigest = <T>(field: string, source: T | undefined, digest: (source: T) => string): string | undefined => {
    if (source === undefined) return undefined;
    try {
      return digest(source);
    } catch (error) {
      if (error instanceof ArchitectureSyncValidationError) {
        for (const detail of error.errors) {
          errors.push({
            ...detail,
            path: detail.path === undefined ? `sources.${field}` : `sources.${field}.${detail.path}`,
          });
        }
      } else {
        errors.push({
          code: "ARCHITECTURE_SYNC_UNSAFE_VALUE",
          message: `Digest source '${field}' is not valid JSON-safe metadata.`,
          path: `sources.${field}`,
        });
      }
      return undefined;
    }
  };
  const expected: Partial<Record<keyof ArchitectureSyncDigestSet, string>> = {
    ...(sources?.desired === undefined ? {} : { desiredDigest: deriveDigest("desired", sources.desired, architectureSyncDesiredDigest) }),
    ...(sources?.compiled === undefined ? {} : { compiledDigest: deriveDigest("compiled", sources.compiled, architectureSyncCompiledDigest) }),
    ...(sources?.observed === undefined ? {} : { observedDigest: deriveDigest("observed", sources.observed, architectureSyncObservedDigest) }),
    ...(sources?.plan === undefined ? {} : { planDigest: deriveDigest("plan", sources.plan, architectureSyncPlanDigest) }),
    ...(sources?.approval === undefined ? {} : { approvalDigest: deriveDigest("approval", sources.approval, architectureSyncSnapshotDigest) }),
    ...(sources?.baseline === undefined ? {} : { baselineDigest: deriveDigest("baseline", sources.baseline, architectureSyncSnapshotDigest) }),
  };
  for (const [field, digest] of Object.entries(expected) as Array<[keyof ArchitectureSyncDigestSet, string]>) {
    if (digest !== undefined && value[field] !== digest) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", `${String(field)} does not match its immutable source.`, `digests.${String(field)}`);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

export function createArchitectureSyncDigests(sources: ArchitectureSyncDigestSources): ArchitectureSyncDigestSet {
  const value: ArchitectureSyncDigestSet = {
    desiredDigest: architectureSyncDesiredDigest(sources.desired),
    compiledDigest: architectureSyncCompiledDigest(sources.compiled),
    observedDigest: architectureSyncObservedDigest(sources.observed),
    planDigest: architectureSyncPlanDigest(sources.plan),
    ...(sources.approval === undefined ? {} : { approvalDigest: architectureSyncSnapshotDigest(sources.approval) }),
    ...(sources.baseline === undefined ? {} : { baselineDigest: architectureSyncSnapshotDigest(sources.baseline) }),
  };
  return assertValidArchitectureSyncDigestSet(value);
}

export const buildArchitectureSyncDigests = createArchitectureSyncDigests;

function validateMetadataOnlyRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: ArchitectureSyncValidationIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issue(errors, "ARCHITECTURE_SYNC_INVALID_OBJECT", "Record must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, allowed, path, errors);
  return value;
}

function validateApprovalRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): ArchitectureSyncApproval | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "id", "runId", "actorId", "planDigest", "approvedAt", "expiresAt", "metadata"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  for (const [field, maximum] of [["id", architectureSyncControlLimits.approvalIdLength], ["runId", architectureSyncControlLimits.runIdLength], ["actorId", architectureSyncControlLimits.identifierLength]] as const) {
    if (!validIdentifier(value[field], maximum)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", `${field} must be a bounded identifier.`, `${path}.${field}`);
  }
  validateDigestField(value.planDigest, `${path}.planDigest`, errors);
  if (!validTimestamp(value.approvedAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "approvedAt must be an ISO-8601 UTC timestamp.", `${path}.approvedAt`);
  if (value.expiresAt !== undefined && !validTimestamp(value.expiresAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "expiresAt must be an ISO-8601 UTC timestamp.", `${path}.expiresAt`);
  const metadata = normalizeMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    id: value.id as string,
    runId: value.runId as string,
    actorId: value.actorId as string,
    planDigest: value.planDigest as string,
    approvedAt: value.approvedAt as string,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as string }),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function validateArchitectureSyncApproval(input: unknown): ArchitectureSyncValidationResult<ArchitectureSyncApproval> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Approval must be an object." }] };
  checkSensitiveInput(input, "approval", errors);
  const value = validateApprovalRecord(input, "approval", errors);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncApproval(input: unknown): ArchitectureSyncApproval {
  const result = validateArchitectureSyncApproval(input);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

function validateBaselineRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[], expected?: ArchitectureSyncRunIdentity): ArchitectureSyncBaseline | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "id", "runId", "targetId", "targetGeneration", "observedDigest", "restorable", "capturedAt", "metadata"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  for (const [field, maximum] of [["id", architectureSyncControlLimits.baselineIdLength], ["runId", architectureSyncControlLimits.runIdLength], ["targetId", architectureSyncControlLimits.targetIdLength]] as const) {
    if (!validIdentifier(value[field], maximum)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", `${field} must be a bounded identifier.`, `${path}.${field}`);
  }
  validateGeneration(value.targetGeneration, `${path}.targetGeneration`, errors, expected?.targetGeneration);
  validateDigestField(value.observedDigest, `${path}.observedDigest`, errors);
  if (typeof value.restorable !== "boolean") issue(errors, "ARCHITECTURE_SYNC_FAILURE_INVALID", "Baseline restorable must be boolean.", `${path}.restorable`);
  if (!validTimestamp(value.capturedAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "capturedAt must be an ISO-8601 UTC timestamp.", `${path}.capturedAt`);
  if (expected && value.runId !== expected.runId) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "Baseline runId does not match the immutable run identity.", `${path}.runId`);
  if (expected && value.targetId !== expected.targetId) issue(errors, "ARCHITECTURE_SYNC_GENERATION_STALE", "Baseline targetId does not match the immutable target identity.", `${path}.targetId`);
  const metadata = normalizeMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    id: value.id as string,
    runId: value.runId as string,
    targetId: value.targetId as string,
    targetGeneration: value.targetGeneration as number,
    observedDigest: value.observedDigest as string,
    restorable: value.restorable as boolean,
    capturedAt: value.capturedAt as string,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function validateArchitectureSyncBaseline(input: unknown, expected?: ArchitectureSyncRunIdentity): ArchitectureSyncValidationResult<ArchitectureSyncBaseline> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Baseline must be an object." }] };
  checkSensitiveInput(input, "baseline", errors);
  const value = validateBaselineRecord(input, "baseline", errors, expected);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncBaseline(input: unknown, expected?: ArchitectureSyncRunIdentity): ArchitectureSyncBaseline {
  const result = validateArchitectureSyncBaseline(input, expected);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

function validateStepRecord(
  input: unknown,
  path: string,
  errors: ArchitectureSyncValidationIssue[],
  expected?: ArchitectureSyncRunIdentity,
): ArchitectureSyncStep | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "id", "ordinal", "action", "nodeId", "targetGeneration", "state", "idempotencyKey", "metadata"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  if (!validIdentifier(value.id, architectureSyncControlLimits.stepIdLength)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", "Step id must be a bounded identifier.", `${path}.id`);
  if (typeof value.ordinal !== "number" || !Number.isInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > architectureSyncControlLimits.ordinalMaximum) issue(errors, "ARCHITECTURE_SYNC_STEP_ORDER_INVALID", "Step ordinal must be a bounded positive integer.", `${path}.ordinal`);
  if (!isOneOf(value.action, [...actionSet] as string[])) issue(errors, "ARCHITECTURE_SYNC_ACTION_INVALID", "Step action is not supported by the architecture planner.", `${path}.action`);
  if (!validIdentifier(value.nodeId)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", "Step nodeId must be a bounded identifier.", `${path}.nodeId`);
  validateGeneration(value.targetGeneration, `${path}.targetGeneration`, errors, expected?.targetGeneration);
  if (!isOneOf(value.state, architectureSyncStepStates)) issue(errors, "ARCHITECTURE_SYNC_STEP_STATE_INVALID", "Step state is invalid.", `${path}.state`);
  if (!validIdentifier(value.idempotencyKey, architectureSyncControlLimits.identifierLength)) issue(errors, "ARCHITECTURE_SYNC_IDEMPOTENCY_KEY_INVALID", "Step idempotencyKey must be a bounded identifier.", `${path}.idempotencyKey`);
  const metadata = normalizeMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    id: value.id as string,
    ordinal: value.ordinal as number,
    action: value.action as ArchitectureSyncAction,
    nodeId: value.nodeId as string,
    targetGeneration: value.targetGeneration as number,
    state: value.state as ArchitectureSyncStepState,
    idempotencyKey: value.idempotencyKey as string,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}


export function validateArchitectureSyncStep(input: unknown, expected?: ArchitectureSyncRunIdentity): ArchitectureSyncValidationResult<ArchitectureSyncStep> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Sync step must be an object." }] };
  checkSensitiveInput(input, "step", errors);
  const value = validateStepRecord(input, "step", errors, expected);
  if (errors.length > 0 || !value) return { valid: false, errors };
  if (expected && value.targetGeneration !== expected.targetGeneration) issue(errors, "ARCHITECTURE_SYNC_GENERATION_STALE", "Step target generation is stale.", "step.targetGeneration");
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncStep(input: unknown, expected?: ArchitectureSyncRunIdentity): ArchitectureSyncStep {
  const result = validateArchitectureSyncStep(input, expected);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

function validateLeaseRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[], expected?: ArchitectureSyncLeaseExpectation): ArchitectureSyncLease | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "leaseId", "runId", "targetId", "targetGeneration", "holderId", "fencingToken", "acquiredAt", "expiresAt"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  for (const [field, maximum] of [["leaseId", architectureSyncControlLimits.leaseIdLength], ["runId", architectureSyncControlLimits.runIdLength], ["targetId", architectureSyncControlLimits.targetIdLength], ["holderId", architectureSyncControlLimits.holderIdLength]] as const) {
    if (!validIdentifier(value[field], maximum)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", `${field} must be a bounded identifier.`, `${path}.${field}`);
  }
  validateGeneration(value.targetGeneration, `${path}.targetGeneration`, errors, expected?.targetGeneration);
  if (typeof value.fencingToken !== "number" || !Number.isInteger(value.fencingToken) || value.fencingToken < 1 || value.fencingToken > architectureSyncControlLimits.fencingTokenMaximum) issue(errors, "ARCHITECTURE_SYNC_LEASE_INVALID", "fencingToken must be a bounded positive integer.", `${path}.fencingToken`);
  if (!validTimestamp(value.acquiredAt) || !validTimestamp(value.expiresAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "Lease timestamps must be ISO-8601 UTC timestamps.", path);
  if (validTimestamp(value.acquiredAt) && validTimestamp(value.expiresAt) && Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) issue(errors, "ARCHITECTURE_SYNC_LEASE_INVALID", "Lease expiresAt must be after acquiredAt.", `${path}.expiresAt`);
  if (validTimestamp(value.acquiredAt) && validTimestamp(value.expiresAt) && (Date.parse(value.expiresAt) - Date.parse(value.acquiredAt)) / 1_000 > architectureSyncControlLimits.leaseMaximumSeconds) issue(errors, "ARCHITECTURE_SYNC_LEASE_INVALID", `Lease duration may not exceed ${architectureSyncControlLimits.leaseMaximumSeconds} seconds.`, `${path}.expiresAt`);
  if (expected?.runId !== undefined && value.runId !== expected.runId) issue(errors, "ARCHITECTURE_SYNC_FENCE_STALE", "Lease runId does not match the expected fencing context.", `${path}.runId`);
  if (expected && value.targetId !== expected.targetId) issue(errors, "ARCHITECTURE_SYNC_FENCE_STALE", "Lease targetId does not match the expected fencing context.", `${path}.targetId`);
  if (expected && value.fencingToken !== expected.fencingToken) issue(errors, "ARCHITECTURE_SYNC_FENCE_STALE", "Lease fencingToken is stale.", `${path}.fencingToken`);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    leaseId: value.leaseId as string,
    runId: value.runId as string,
    targetId: value.targetId as string,
    targetGeneration: value.targetGeneration as number,
    holderId: value.holderId as string,
    fencingToken: value.fencingToken as number,
    acquiredAt: value.acquiredAt as string,
    expiresAt: value.expiresAt as string,
  };
}

export function validateArchitectureSyncLease(input: unknown, expected?: ArchitectureSyncLeaseExpectation): ArchitectureSyncValidationResult<ArchitectureSyncLease> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Lease must be an object." }] };
  checkSensitiveInput(input, "lease", errors);
  const value = validateLeaseRecord(input, "lease", errors, expected);
  if (errors.length > 0 || !value) return { valid: false, errors };
  if (expected?.now && Date.parse(expected.now) >= Date.parse(value.expiresAt)) {
    return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_FENCE_STALE", message: "Lease has expired.", path: "lease.expiresAt" }] };
  }
  return { valid: true, value };
}

export function assertValidArchitectureSyncLease(input: unknown, expected?: ArchitectureSyncLeaseExpectation): ArchitectureSyncLease {
  const result = validateArchitectureSyncLease(input, expected);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export function isArchitectureSyncLeaseCurrent(lease: ArchitectureSyncLease, expected: ArchitectureSyncLeaseExpectation): boolean {
  const result = validateArchitectureSyncLease(lease, expected);
  return result.valid;
}

export function assertCurrentArchitectureSyncLease(lease: ArchitectureSyncLease, expected: ArchitectureSyncLeaseExpectation): ArchitectureSyncLease {
  return assertValidArchitectureSyncLease(lease, expected);
}

export function validateArchitectureSyncFencingRecord(input: unknown, expected?: ArchitectureSyncLeaseExpectation): ArchitectureSyncValidationResult<ArchitectureSyncFencingRecord> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Fencing record must be an object." }] };
  checkSensitiveInput(input, "fencing", errors);
  checkUnknownKeys(input, ["targetId", "targetGeneration", "fencingToken"], "fencing", errors);
  if (!validIdentifier(input.targetId, architectureSyncControlLimits.targetIdLength)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", "targetId must be a bounded identifier.", "fencing.targetId");
  validateGeneration(input.targetGeneration, "fencing.targetGeneration", errors, expected?.targetGeneration);
  if (typeof input.fencingToken !== "number" || !Number.isInteger(input.fencingToken) || input.fencingToken < 1 || input.fencingToken > architectureSyncControlLimits.fencingTokenMaximum) issue(errors, "ARCHITECTURE_SYNC_LEASE_INVALID", "fencingToken must be a bounded positive integer.", "fencing.fencingToken");
  if (expected && input.targetId !== expected.targetId) issue(errors, "ARCHITECTURE_SYNC_FENCE_STALE", "Fencing targetId does not match the expected target.", "fencing.targetId");
  if (expected && input.fencingToken !== expected.fencingToken) issue(errors, "ARCHITECTURE_SYNC_FENCE_STALE", "Fencing token is stale.", "fencing.fencingToken");
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      targetId: input.targetId as string,
      targetGeneration: input.targetGeneration as number,
      fencingToken: input.fencingToken as number,
    },
  };
}

export function assertValidArchitectureSyncFencingRecord(input: unknown, expected?: ArchitectureSyncLeaseExpectation): ArchitectureSyncFencingRecord {
  const result = validateArchitectureSyncFencingRecord(input, expected);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export const validateArchitectureSyncFencing = validateArchitectureSyncFencingRecord;
export const assertArchitectureSyncFence = assertValidArchitectureSyncFencingRecord;

function validateReceiptRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): ArchitectureSyncReceipt | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "id", "runId", "stepId", "kind", "status", "code", "recordedAt", "evidenceDigest", "message", "metadata"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  for (const [field, maximum] of [["id", architectureSyncControlLimits.receiptIdLength], ["runId", architectureSyncControlLimits.runIdLength]] as const) {
    if (!validIdentifier(value[field], maximum)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", `${field} must be a bounded identifier.`, `${path}.${field}`);
  }
  if (value.stepId !== undefined && !validIdentifier(value.stepId, architectureSyncControlLimits.stepIdLength)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", "stepId must be a bounded identifier.", `${path}.stepId`);
  if (!isOneOf(value.kind, architectureSyncReceiptKinds)) issue(errors, "ARCHITECTURE_SYNC_RECEIPT_INVALID", "Receipt kind is invalid.", `${path}.kind`);
  if (!isOneOf(value.status, architectureSyncReceiptStatuses)) issue(errors, "ARCHITECTURE_SYNC_RECEIPT_INVALID", "Receipt status is invalid.", `${path}.status`);
  if (!codePattern.test(typeof value.code === "string" ? value.code : "")) issue(errors, "ARCHITECTURE_SYNC_RECEIPT_INVALID", "Receipt code must be a bounded code.", `${path}.code`);
  if (!validTimestamp(value.recordedAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "recordedAt must be an ISO-8601 UTC timestamp.", `${path}.recordedAt`);
  if (value.evidenceDigest !== undefined) validateDigestField(value.evidenceDigest, `${path}.evidenceDigest`, errors);
  if (value.message !== undefined && !validBoundedText(value.message, architectureSyncControlLimits.messageLength)) issue(errors, "ARCHITECTURE_SYNC_UNSAFE_VALUE", "Receipt message must be bounded and sanitized.", `${path}.message`);
  const metadata = normalizeMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    id: value.id as string,
    runId: value.runId as string,
    ...(value.stepId === undefined ? {} : { stepId: value.stepId as string }),
    kind: value.kind as ArchitectureSyncReceiptKind,
    status: value.status as ArchitectureSyncReceiptStatus,
    code: value.code as string,
    recordedAt: value.recordedAt as string,
    ...(value.evidenceDigest === undefined ? {} : { evidenceDigest: value.evidenceDigest as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function validateArchitectureSyncReceipt(input: unknown): ArchitectureSyncValidationResult<ArchitectureSyncReceipt> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Receipt must be an object." }] };
  checkSensitiveInput(input, "receipt", errors);
  const value = validateReceiptRecord(input, "receipt", errors);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncReceipt(input: unknown): ArchitectureSyncReceipt {
  const result = validateArchitectureSyncReceipt(input);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

function validateFailureRecord(input: unknown, path: string, errors: ArchitectureSyncValidationIssue[]): ArchitectureSyncFailure | undefined {
  const value = validateMetadataOnlyRecord(input, path, ["schemaVersion", "class", "code", "occurredAt", "retryable", "stepId", "message", "metadata"], errors);
  if (!value) return undefined;
  if (value.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", `${path}.schemaVersion`);
  if (!isOneOf(value.class, architectureSyncFailureClasses)) issue(errors, "ARCHITECTURE_SYNC_FAILURE_INVALID", "Failure class is invalid.", `${path}.class`);
  if (!codePattern.test(typeof value.code === "string" ? value.code : "")) issue(errors, "ARCHITECTURE_SYNC_FAILURE_INVALID", "Failure code must be a bounded code.", `${path}.code`);
  if (!validTimestamp(value.occurredAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "occurredAt must be an ISO-8601 UTC timestamp.", `${path}.occurredAt`);
  if (typeof value.retryable !== "boolean") issue(errors, "ARCHITECTURE_SYNC_FAILURE_INVALID", "retryable must be boolean.", `${path}.retryable`);
  if (value.stepId !== undefined && !validIdentifier(value.stepId, architectureSyncControlLimits.stepIdLength)) issue(errors, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", "stepId must be a bounded identifier.", `${path}.stepId`);
  if (value.message !== undefined && !validBoundedText(value.message, architectureSyncControlLimits.messageLength)) issue(errors, "ARCHITECTURE_SYNC_UNSAFE_VALUE", "Failure message must be bounded and sanitized.", `${path}.message`);
  const metadata = normalizeMetadata(value.metadata, `${path}.metadata`, errors);
  if (errors.some((error) => error.path?.startsWith(`${path}.`))) return undefined;
  return {
    schemaVersion: architectureSyncControlSchemaVersion,
    class: value.class as ArchitectureSyncFailureClass,
    code: value.code as string,
    occurredAt: value.occurredAt as string,
    retryable: value.retryable as boolean,
    ...(value.stepId === undefined ? {} : { stepId: value.stepId as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function validateArchitectureSyncFailure(input: unknown): ArchitectureSyncValidationResult<ArchitectureSyncFailure> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Failure must be an object." }] };
  checkSensitiveInput(input, "failure", errors);
  const value = validateFailureRecord(input, "failure", errors);
  if (errors.length > 0 || !value) return { valid: false, errors };
  return { valid: true, value };
}

export function assertValidArchitectureSyncFailure(input: unknown): ArchitectureSyncFailure {
  const result = validateArchitectureSyncFailure(input);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export type ArchitectureSyncCapabilityValidationResult = ArchitectureSyncValidationResult<ArchitectureSyncCapabilitySet>;

export function validateArchitectureSyncCapabilities(input: unknown): ArchitectureSyncCapabilityValidationResult {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Capabilities must be an object." }] };
  checkSensitiveInput(input, "capabilities", errors);
  checkUnknownKeys(input, architectureSyncCapabilityNames, "capabilities", errors);
  const normalized: ArchitectureSyncCapabilitySet = {};
  const known = new Set<string>(architectureSyncCapabilityNames);
  for (const [key, value] of Object.entries(input)) {
    if (!known.has(key)) continue;
    if (typeof value !== "boolean") {
      issue(errors, "ARCHITECTURE_SYNC_CAPABILITY_INVALID", "Capability values must be boolean.", `capabilities.${key}`);
      continue;
    }
    if ((architectureSyncMutationCapabilities as readonly string[]).includes(key) && value === true) {
      issue(errors, "ARCHITECTURE_SYNC_MUTATION_CAPABILITY_ENABLED", "Mutation capabilities require a later, separately governed adapter contract.", `capabilities.${key}`);
      continue;
    }
    normalized[key as ArchitectureSyncCapabilityName] = value;
  }
  const ordered: ArchitectureSyncCapabilitySet = {};
  for (const key of Object.keys(normalized).sort()) ordered[key as ArchitectureSyncCapabilityName] = normalized[key as ArchitectureSyncCapabilityName];
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: ordered };
}

export function assertValidArchitectureSyncCapabilities(input: unknown): ArchitectureSyncCapabilitySet {
  const result = validateArchitectureSyncCapabilities(input);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

function validateRunSteps(
  input: unknown,
  path: string,
  identity: ArchitectureSyncRunIdentity,
  planDigest: string,
  errors: ArchitectureSyncValidationIssue[],
): ArchitectureSyncStep[] | undefined {
  if (!Array.isArray(input)) {
    issue(errors, "ARCHITECTURE_SYNC_STEP_INVALID", "Run steps must be an array.", path);
    return undefined;
  }
  if (input.length > architectureSyncControlLimits.steps) issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `A run may contain at most ${architectureSyncControlLimits.steps} steps.`, path);
  const steps: ArchitectureSyncStep[] = [];
  const ids = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const [index, item] of input.entries()) {
    const step = validateStepRecord(item, `${path}[${index}]`, errors, identity);
    if (!step) continue;
    if (step.ordinal !== index + 1) issue(errors, "ARCHITECTURE_SYNC_STEP_ORDER_INVALID", "Step ordinals must be contiguous and match array order.", `${path}[${index}].ordinal`);
    if (ids.has(step.id) || idempotencyKeys.has(step.idempotencyKey)) issue(errors, "ARCHITECTURE_SYNC_DUPLICATE_STEP", "Step ids and idempotency keys must be unique within a run.", `${path}[${index}]`);
    ids.add(step.id);
    idempotencyKeys.add(step.idempotencyKey);
    let expectedKey: string | undefined;
    try {
      expectedKey = architectureSyncStepIdempotencyKey({ identity, planDigest, step });
    } catch {
      issue(errors, "ARCHITECTURE_SYNC_IDEMPOTENCY_KEY_INVALID", "Step idempotency key cannot be derived from the immutable run identity.", `${path}[${index}].idempotencyKey`);
    }
    if (expectedKey !== undefined && step.idempotencyKey !== expectedKey) issue(errors, "ARCHITECTURE_SYNC_IDEMPOTENCY_KEY_INVALID", "Step idempotencyKey does not match the immutable run identity, plan, and order.", `${path}[${index}].idempotencyKey`);
    steps.push(step);
  }
  return steps;
}

export function validateArchitectureSyncRun(input: unknown, expectedTargetGeneration?: number): ArchitectureSyncValidationResult<ArchitectureSyncRun> {
  const errors: ArchitectureSyncValidationIssue[] = [];
  if (!isRecord(input)) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_INVALID_OBJECT", message: "Sync run must be an object." }] };
  checkSensitiveInput(input, "run", errors);
  checkUnknownKeys(input, ["schemaVersion", "identity", "state", "digests", "steps", "receipts", "approval", "baseline", "lease", "failure", "capabilities", "createdAt", "updatedAt", "metadata"], "run", errors);
  if (input.schemaVersion !== architectureSyncControlSchemaVersion) issue(errors, "ARCHITECTURE_SYNC_SCHEMA_VERSION_INVALID", "Only sync control schema version 1 is supported.", "run.schemaVersion");
  const identity = validateIdentityRecord(input.identity, "run.identity", errors, expectedTargetGeneration);
  const digests = validateDigestSetRecord(input.digests, "run.digests", errors);
  if (!isOneOf(input.state, architectureSyncRunStates)) issue(errors, "ARCHITECTURE_SYNC_RUN_STATE_INVALID", "Run state is invalid.", "run.state");
  const steps = identity && digests ? validateRunSteps(input.steps, "run.steps", identity, digests.planDigest, errors) : undefined;
  if (!Array.isArray(input.receipts)) issue(errors, "ARCHITECTURE_SYNC_RECEIPT_INVALID", "Run receipts must be an array.", "run.receipts");
  else if (input.receipts.length > architectureSyncControlLimits.receipts) issue(errors, "ARCHITECTURE_SYNC_LIMIT_EXCEEDED", `A run may contain at most ${architectureSyncControlLimits.receipts} receipts.`, "run.receipts");
  const receipts: ArchitectureSyncReceipt[] = [];
  for (const [index, item] of (Array.isArray(input.receipts) ? input.receipts : []).entries()) {
    const receipt = validateReceiptRecord(item, `run.receipts[${index}]`, errors);
    if (receipt) {
      if (identity && receipt.runId !== identity.runId) issue(errors, "ARCHITECTURE_SYNC_RECEIPT_INVALID", "Receipt runId does not match the immutable run identity.", `run.receipts[${index}].runId`);
      if (receipt.kind === "recovery" && receipt.evidenceDigest === undefined) issue(errors, "ARCHITECTURE_SYNC_RECOVERY_INVALID", "Recovery receipts require a bound evidence digest.", `run.receipts[${index}].evidenceDigest`);
      receipts.push(receipt);
    }
  }
  const approval = input.approval === undefined ? undefined : validateApprovalRecord(input.approval, "run.approval", errors);
  const baseline = input.baseline === undefined ? undefined : validateBaselineRecord(input.baseline, "run.baseline", errors, identity);
  const lease = input.lease === undefined ? undefined : validateLeaseRecord(input.lease, "run.lease", errors, identity ? {
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    fencingToken: isRecord(input.lease) && typeof input.lease.fencingToken === "number" ? input.lease.fencingToken : 1,
    runId: identity.runId,
  } : undefined);
  const failure = input.failure === undefined ? undefined : validateFailureRecord(input.failure, "run.failure", errors);
  const capabilities = input.capabilities === undefined ? undefined : validateArchitectureSyncCapabilities(input.capabilities);
  if (capabilities && !capabilities.valid) errors.push(...capabilities.errors);
  const metadata = normalizeMetadata(input.metadata, "run.metadata", errors);
  if (!validTimestamp(input.createdAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "createdAt must be an ISO-8601 UTC timestamp.", "run.createdAt");
  if (!validTimestamp(input.updatedAt)) issue(errors, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", "updatedAt must be an ISO-8601 UTC timestamp.", "run.updatedAt");
  if (approval && digests && approval.planDigest !== digests.planDigest) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "Approval planDigest does not match the immutable run plan digest.", "run.approval.planDigest");
  if (approval && identity && approval.runId !== identity.runId) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "Approval runId does not match the immutable run identity.", "run.approval.runId");
  if (approval && digests && digests.approvalDigest !== architectureSyncSnapshotDigest(approval)) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "approvalDigest does not match the immutable approval record.", "run.digests.approvalDigest");
  if (baseline && digests && digests.baselineDigest !== architectureSyncSnapshotDigest(baseline)) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "baselineDigest does not match the immutable baseline record.", "run.digests.baselineDigest");
  if (approval && digests && digests.approvalDigest === undefined) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "An approval record requires approvalDigest.", "run.digests.approvalDigest");
  if (baseline && digests && digests.baselineDigest === undefined) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "A baseline record requires baselineDigest.", "run.digests.baselineDigest");
  if (!approval && digests?.approvalDigest !== undefined) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "approvalDigest requires an immutable approval record.", "run.digests.approvalDigest");
  if (!baseline && digests?.baselineDigest !== undefined) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "baselineDigest requires an immutable baseline record.", "run.digests.baselineDigest");
  if (steps && digests && architectureSyncPlanDigest(steps) !== digests.planDigest) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "planDigest does not match the immutable ordered steps.", "run.digests.planDigest");
  if (isOneOf(input.state, ["approved", "queued", "lease_acquiring", "revalidating", "preparing", "applying", "verifying", "succeeded", "rollback_required", "rolling_back", "rolled_back", "rollback_failed"] as const) && !approval) issue(errors, "ARCHITECTURE_SYNC_DIGEST_MISMATCH", "This run state requires an immutable approval record.", "run.approval");
  if (errors.length > 0 || !identity || !digests || !steps || !isOneOf(input.state, architectureSyncRunStates) || !Array.isArray(input.receipts)) return { valid: false, errors };
  return {
    valid: true,
    value: {
      schemaVersion: architectureSyncControlSchemaVersion,
      identity,
      state: input.state as ArchitectureSyncRun["state"],
      digests,
      steps,
      receipts,
      ...(approval ? { approval } : {}),
      ...(baseline ? { baseline } : {}),
      ...(lease ? { lease } : {}),
      ...(failure ? { failure } : {}),
      ...(capabilities?.valid ? { capabilities: capabilities.value } : {}),
      createdAt: input.createdAt as string,
      updatedAt: input.updatedAt as string,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
  };
}

export function assertValidArchitectureSyncRun(input: unknown, expectedTargetGeneration?: number): ArchitectureSyncRun {
  const result = validateArchitectureSyncRun(input, expectedTargetGeneration);
  if (!result.valid) throw new ArchitectureSyncValidationError(result.errors);
  return result.value;
}

export const validateArchitectureSyncRunRecord = validateArchitectureSyncRun;
export const assertValidArchitectureSyncRunRecord = assertValidArchitectureSyncRun;
