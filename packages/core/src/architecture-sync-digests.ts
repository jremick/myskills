/**
 * Deterministic digest helpers for architecture sync records.
 *
 * These functions only operate on bounded JSON-safe metadata. They do not
 * perform adapter, filesystem, network, database, or target mutations.
 */

import { canonicalizeJson, sha256Hex } from "./architecture.js";
import {
  actionSet,
  architectureSyncControlLimits,
  architectureSyncControlSchemaVersion,
  assertValidArchitectureSyncRunIdentity,
  checkCanonicalBounds,
  checkSensitiveInput,
  isRecord,
  validDigest,
  validIdentifier,
  ArchitectureSyncValidationError,
  type ArchitectureSyncDigest,
  type ArchitectureSyncRunIdentity,
  type ArchitectureSyncStep,
  type ArchitectureSyncValidationIssue,
} from "./architecture-sync-contracts.js";

/** Digest of the immutable identity. Object key order never changes it. */
export function architectureSyncRunIdentityDigest(input: ArchitectureSyncRunIdentity): ArchitectureSyncDigest {
  return sha256Hex(canonicalizeJson(assertValidArchitectureSyncRunIdentity(input)));
}

export const digestArchitectureSyncRunIdentity = architectureSyncRunIdentityDigest;

function canonicalizeUnordered(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => canonicalizeUnordered(item));
    return normalized.sort((left, right) => canonicalizeJson(left).localeCompare(canonicalizeJson(right)));
  }
  if (isRecord(value)) {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) normalized[key] = canonicalizeUnordered(value[key]);
    return normalized;
  }
  return value;
}

function safeCanonicalJson(value: unknown, orderIndependent: boolean): string {
  const normalized = orderIndependent ? canonicalizeUnordered(value) : value;
  try {
    return canonicalizeJson(normalized);
  } catch {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_UNSAFE_VALUE",
      message: "Digest inputs must contain JSON-safe values only.",
    }]);
  }
}

/** Digest arbitrary JSON-safe metadata with object-key canonicalization. */
export function architectureSyncDigest(value: unknown, options: { orderIndependent?: boolean } = {}): ArchitectureSyncDigest {
  const errors: ArchitectureSyncValidationIssue[] = [];
  checkCanonicalBounds(value, "digest", errors);
  checkSensitiveInput(value, "digest", errors);
  if (errors.length > 0) throw new ArchitectureSyncValidationError(errors);
  return sha256Hex(safeCanonicalJson(value, options.orderIndependent === true));
}

/** Desired/compiled/observed snapshots are sets of metadata records. */
export function architectureSyncSnapshotDigest(value: unknown): ArchitectureSyncDigest {
  return architectureSyncDigest(value, { orderIndependent: true });
}

export const architectureSyncDesiredDigest = architectureSyncSnapshotDigest;
export const architectureSyncCompiledDigest = architectureSyncSnapshotDigest;
export const architectureSyncObservedDigest = architectureSyncSnapshotDigest;

/** Plans retain step order because execution order is part of their meaning. */
export function architectureSyncOrderedDigest(value: unknown): ArchitectureSyncDigest {
  return architectureSyncDigest(value, { orderIndependent: false });
}

export const architectureSyncPlanDigestFromValue = architectureSyncOrderedDigest;


export function architectureSyncStepIdempotencyKey(input: {
  readonly identity: ArchitectureSyncRunIdentity;
  readonly planDigest: ArchitectureSyncDigest;
  readonly step: Pick<ArchitectureSyncStep, "ordinal" | "action" | "nodeId">;
}): string {
  const identity = assertValidArchitectureSyncRunIdentity(input.identity);
  if (!validDigest(input.planDigest)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_DIGEST_INVALID", message: "planDigest must be a lowercase SHA-256 hex digest." }]);
  if (!Number.isInteger(input.step.ordinal) || input.step.ordinal < 1 || input.step.ordinal > architectureSyncControlLimits.ordinalMaximum) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_STEP_ORDER_INVALID", message: "Step ordinal must be a bounded positive integer." }]);
  if (!actionSet.has(input.step.action)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_ACTION_INVALID", message: "Step action is invalid." }]);
  if (!validIdentifier(input.step.nodeId)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", message: "Step nodeId must be a bounded identifier." }]);
  return `step_${sha256Hex(canonicalizeJson({
    schemaVersion: architectureSyncControlSchemaVersion,
    runId: identity.runId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    architectureId: identity.architectureId,
    revisionId: identity.revisionId,
    profileId: identity.profileId,
    environmentId: identity.environmentId,
    planDigest: input.planDigest,
    ordinal: input.step.ordinal,
    action: input.step.action,
    nodeId: input.step.nodeId,
  }))}`;
}

export const createArchitectureSyncStepIdempotencyKey = architectureSyncStepIdempotencyKey;
export const orderedArchitectureSyncStepKey = architectureSyncStepIdempotencyKey;

function stepImmutableProjection(step: ArchitectureSyncStep): Record<string, unknown> {
  return {
    schemaVersion: step.schemaVersion,
    id: step.id,
    ordinal: step.ordinal,
    action: step.action,
    nodeId: step.nodeId,
    targetGeneration: step.targetGeneration,
    idempotencyKey: step.idempotencyKey,
    ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
  };
}

function stepPlanProjection(step: ArchitectureSyncStep): Record<string, unknown> {
  return {
    schemaVersion: step.schemaVersion,
    id: step.id,
    ordinal: step.ordinal,
    action: step.action,
    nodeId: step.nodeId,
    targetGeneration: step.targetGeneration,
    ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
  };
}

/** Ordered digest for a step sequence. State changes do not rewrite plan identity. */
export function architectureSyncPlanDigest(steps: readonly ArchitectureSyncStep[]): ArchitectureSyncDigest {
  // Idempotency keys are derived from this digest, so the digest intentionally
  // covers the immutable operation projection but not its derived key.
  return architectureSyncOrderedDigest(steps.map((step) => stepPlanProjection(step)));
}

export const digestArchitectureSyncPlan = architectureSyncPlanDigest;

export function architectureSyncStepDigest(step: ArchitectureSyncStep): ArchitectureSyncDigest {
  return architectureSyncOrderedDigest(stepImmutableProjection(step));
}
