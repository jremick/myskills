/**
 * Deterministic crash-recovery decisions and evidence binding.
 *
 * Recovery is evidence and intent only. It cannot authorize a target write or
 * manufacture a successful run from a caller-supplied condition.
 */

import { canonicalizeJson, sha256Hex } from "./architecture.js";
import {
  architectureSyncControlSchemaVersion,
  architectureSyncRecoveryConditionAliases,
  architectureSyncRecoveryDecisions,
  architectureSyncRecoverySourceStates,
  architectureSyncRunStates,
  assertValidArchitectureSyncRunIdentity,
  isOneOf,
  recoveryConditionSet,
  validDigest,
  ArchitectureSyncValidationError,
  type ArchitectureSyncDigest,
  type ArchitectureSyncRecoveryCondition,
  type ArchitectureSyncRecoveryConditionAlias,
  type ArchitectureSyncRecoveryEvidenceDigestInput,
  type ArchitectureSyncRecoveryResult,
  type ArchitectureSyncRecoverySourceState,
  type ArchitectureSyncRecoveryTransition,
  type ArchitectureSyncRunState,
  type ArchitectureSyncStepState,
  type ArchitectureSyncValidationResult,
} from "./architecture-sync-contracts.js";

/**
 * Deterministic crash-recovery table.  No branch attempts a write.  The
 * caller may journal the returned next state after separately checking its
 * authority and target generation.
 */
export function decideArchitectureSyncRecovery(condition: ArchitectureSyncRecoveryCondition | ArchitectureSyncRecoveryConditionAlias): ArchitectureSyncRecoveryResult {
  const canonicalCondition = (Object.prototype.hasOwnProperty.call(architectureSyncRecoveryConditionAliases, condition)
    ? architectureSyncRecoveryConditionAliases[condition as ArchitectureSyncRecoveryConditionAlias]
    : condition) as ArchitectureSyncRecoveryCondition;
  if (!recoveryConditionSet.has(canonicalCondition)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_RECOVERY_INVALID", message: "Recovery condition is invalid." }]);
  const table: Record<ArchitectureSyncRecoveryCondition, ArchitectureSyncRecoveryResult> = {
    "no-mutation": { condition: "no-mutation", decision: "retry", nextRunState: "queued", safeToRetry: true, requiresManualReview: false },
    "desired-readback": { condition: "desired-readback", decision: "succeed", nextRunState: "succeeded", safeToRetry: false, requiresManualReview: false },
    "restorable-partial-state": { condition: "restorable-partial-state", decision: "rollback", nextRunState: "rollback_required", safeToRetry: false, requiresManualReview: false },
    "ambiguous-readback": { condition: "ambiguous-readback", decision: "block", nextRunState: "blocked", safeToRetry: false, requiresManualReview: true },
    "irreversible-unrecoverable": { condition: "irreversible-unrecoverable", decision: "manual-intervention", nextRunState: "rollback_failed", safeToRetry: false, requiresManualReview: true },
  };
  return table[canonicalCondition];
}

export const decideArchitectureSyncRecoveryOutcome = decideArchitectureSyncRecovery;
export const architectureSyncRecoveryDecision = decideArchitectureSyncRecovery;

/**
 * Validate the explicit context for a recovery transition.  The decision and
 * target state are derived from the canonical condition table, so a caller
 * cannot pair (for example) a success decision with a queued state.
 */
export function isValidArchitectureSyncRecoveryTransition(input: {
  readonly from: ArchitectureSyncRunState;
  readonly to: ArchitectureSyncRunState;
  readonly transition: ArchitectureSyncRecoveryTransition;
}): boolean {
  if (!architectureSyncRecoverySourceStates.includes(input.from as ArchitectureSyncRecoverySourceState)) return false;
  if (input.transition.sourceState !== input.from || input.transition.nextRunState !== input.to) return false;
  const expected = decideArchitectureSyncRecovery(input.transition.condition);
  return expected.decision === input.transition.decision
    && expected.nextRunState === input.transition.nextRunState;
}

export function assertValidArchitectureSyncRecoveryTransition(input: {
  readonly from: ArchitectureSyncRunState;
  readonly to: ArchitectureSyncRunState;
  readonly transition: ArchitectureSyncRecoveryTransition;
}): void {
  if (!isValidArchitectureSyncRecoveryTransition(input)) {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_TRANSITION_INVALID",
      message: `Recovery transition '${input.from}' to '${input.to}' is not permitted.`,
    }]);
  }
}

export const canTransitionArchitectureSyncRecovery = isValidArchitectureSyncRecoveryTransition;

/** The sole step transition that is authorized by the fixture rollback path. */
export function isValidArchitectureSyncCompensationTransition(from: ArchitectureSyncStepState, to: ArchitectureSyncStepState): boolean {
  return from === "succeeded" && to === "compensated";
}

/**
 * Recovery may reconcile step state only through the deterministic outcome of
 * the trusted evidence. This keeps the memory and Postgres journals aligned
 * when a crash occurs before a step receipt is committed.
 */
export function isValidArchitectureSyncRecoveryStepTransition(
  from: ArchitectureSyncStepState,
  to: ArchitectureSyncStepState,
  transition: ArchitectureSyncRecoveryTransition,
): boolean {
  try {
    if (!isValidArchitectureSyncRecoveryTransition({
      from: transition.sourceState,
      to: transition.nextRunState,
      transition,
    })) return false;
  } catch {
    return false;
  }
  if (from === to) return true;
  if (transition.decision === "retry") return (from === "started" || from === "verify_failed") && to === "prepared";
  if (transition.decision === "succeed") return ["planned", "prepared", "started", "verify_failed"].includes(from) && to === "succeeded";
  return false;
}

/**
 * Bind trusted readback evidence to the immutable run identity, source state,
 * recovery condition, decision, and resulting state.  The supplied evidence
 * digest is itself opaque; this digest is the persisted proof binding it to
 * this exact run and recovery transition.
 */
export function architectureSyncRecoveryEvidenceDigest(input: ArchitectureSyncRecoveryEvidenceDigestInput): ArchitectureSyncDigest {
  const identity = assertValidArchitectureSyncRunIdentity({
    schemaVersion: architectureSyncControlSchemaVersion,
    runId: input.runId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    architectureId: input.architectureId,
    revisionId: input.revisionId,
    profileId: input.profileId,
    environmentId: input.environmentId,
  });
  for (const [field, value] of Object.entries({
    desiredDigest: input.desiredDigest,
    compiledDigest: input.compiledDigest,
    observedDigest: input.observedDigest,
    planDigest: input.planDigest,
    evidenceDigest: input.evidenceDigest,
  })) {
    if (!validDigest(value)) {
      throw new ArchitectureSyncValidationError([{
        code: "ARCHITECTURE_SYNC_DIGEST_INVALID",
        message: `${field} must be a lowercase SHA-256 hex digest.`,
        path: field,
      }]);
    }
  }
  if (!architectureSyncRecoverySourceStates.includes(input.sourceState)) {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_RECOVERY_INVALID",
      message: "Recovery source state is not an interrupted state.",
      path: "sourceState",
    }]);
  }
  if (!isOneOf(input.nextRunState, architectureSyncRunStates)) {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_RUN_STATE_INVALID",
      message: "Recovery next run state is invalid.",
      path: "nextRunState",
    }]);
  }
  if (!recoveryConditionSet.has(input.condition) || !architectureSyncRecoveryDecisions.includes(input.decision)) {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_RECOVERY_INVALID",
      message: "Recovery condition or decision is invalid.",
    }]);
  }
  if (!isValidArchitectureSyncRecoveryTransition({
    from: input.sourceState,
    to: input.nextRunState,
    transition: {
      sourceState: input.sourceState,
      condition: input.condition,
      decision: input.decision,
      nextRunState: input.nextRunState,
    },
  })) {
    throw new ArchitectureSyncValidationError([{
      code: "ARCHITECTURE_SYNC_TRANSITION_INVALID",
      message: "Recovery evidence does not describe a permitted transition.",
    }]);
  }
  return sha256Hex(canonicalizeJson({
    schemaVersion: architectureSyncControlSchemaVersion,
    identity,
    digests: {
      desiredDigest: input.desiredDigest,
      compiledDigest: input.compiledDigest,
      observedDigest: input.observedDigest,
      planDigest: input.planDigest,
    },
    sourceState: input.sourceState,
    condition: input.condition,
    decision: input.decision,
    nextRunState: input.nextRunState,
    evidenceDigest: input.evidenceDigest,
  }));
}

export const digestArchitectureSyncRecoveryEvidence = architectureSyncRecoveryEvidenceDigest;

export function validateArchitectureSyncRecoveryCondition(input: unknown): ArchitectureSyncValidationResult<ArchitectureSyncRecoveryCondition> {
  const alias = typeof input === "string" && Object.prototype.hasOwnProperty.call(architectureSyncRecoveryConditionAliases, input)
    ? architectureSyncRecoveryConditionAliases[input as ArchitectureSyncRecoveryConditionAlias]
    : input;
  if (!recoveryConditionSet.has(String(alias))) return { valid: false, errors: [{ code: "ARCHITECTURE_SYNC_RECOVERY_INVALID", message: "Recovery condition is invalid.", path: "condition" }] };
  return { valid: true, value: alias as ArchitectureSyncRecoveryCondition };
}
