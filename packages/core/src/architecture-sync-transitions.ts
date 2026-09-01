/**
 * State transition and idempotency rules for the architecture sync journal.
 *
 * The tables are deterministic policy. They do not perform persistence or
 * authorize target writes.
 */

import {
  ArchitectureSyncValidationError,
  type ArchitectureSyncIdempotencyDecision,
  type ArchitectureSyncRunState,
  type ArchitectureSyncStep,
  type ArchitectureSyncStepState,
} from "./architecture-sync-contracts.js";
import { architectureSyncStepDigest } from "./architecture-sync-digests.js";

const runTransitions: Readonly<Record<ArchitectureSyncRunState, readonly ArchitectureSyncRunState[]>> = {
  drafted: ["awaiting_approval", "blocked", "cancelled", "expired"],
  awaiting_approval: ["approved", "blocked", "cancelled", "expired"],
  approved: ["queued", "blocked", "cancelled", "expired"],
  queued: ["lease_acquiring", "blocked", "cancelled", "expired"],
  lease_acquiring: ["revalidating", "blocked", "failed", "expired"],
  revalidating: ["preparing", "blocked", "failed", "expired"],
  preparing: ["applying", "blocked", "failed", "expired"],
  applying: ["verifying", "rollback_required", "failed", "blocked"],
  verifying: ["succeeded", "rollback_required", "failed", "blocked"],
  succeeded: [],
  blocked: [],
  failed: ["rollback_required"],
  rollback_required: ["rolling_back", "rollback_failed", "blocked"],
  rolling_back: ["rolled_back", "rollback_failed", "blocked"],
  rolled_back: [],
  rollback_failed: [],
  cancelled: [],
  expired: [],
};

const stepTransitions: Readonly<Record<ArchitectureSyncStepState, readonly ArchitectureSyncStepState[]>> = {
  planned: ["prepared", "skipped", "failed"],
  prepared: ["started", "skipped", "failed"],
  started: ["succeeded", "verify_failed", "failed"],
  succeeded: [],
  verify_failed: ["compensating", "failed"],
  compensating: ["compensated", "failed"],
  compensated: [],
  failed: [],
  skipped: [],
};

export function architectureSyncRunStateTransitions(from: ArchitectureSyncRunState): readonly ArchitectureSyncRunState[] {
  return runTransitions[from] ?? [];
}

export function architectureSyncStepStateTransitions(from: ArchitectureSyncStepState): readonly ArchitectureSyncStepState[] {
  return stepTransitions[from] ?? [];
}

export function isValidArchitectureSyncRunTransition(from: ArchitectureSyncRunState, to: ArchitectureSyncRunState): boolean {
  return runTransitions[from]?.includes(to) ?? false;
}

export function isValidArchitectureSyncStepTransition(from: ArchitectureSyncStepState, to: ArchitectureSyncStepState): boolean {
  return stepTransitions[from]?.includes(to) ?? false;
}

export function assertValidArchitectureSyncRunTransition(from: ArchitectureSyncRunState, to: ArchitectureSyncRunState): void {
  if (!isValidArchitectureSyncRunTransition(from, to)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_TRANSITION_INVALID", message: `Run transition '${from}' to '${to}' is not permitted.` }]);
}

export function assertValidArchitectureSyncStepTransition(from: ArchitectureSyncStepState, to: ArchitectureSyncStepState): void {
  if (!isValidArchitectureSyncStepTransition(from, to)) throw new ArchitectureSyncValidationError([{ code: "ARCHITECTURE_SYNC_TRANSITION_INVALID", message: `Step transition '${from}' to '${to}' is not permitted.` }]);
}

export const canTransitionArchitectureSyncRun = isValidArchitectureSyncRunTransition;
export const canTransitionArchitectureSyncStep = isValidArchitectureSyncStepTransition;
export const assertArchitectureSyncRunTransition = assertValidArchitectureSyncRunTransition;
export const assertArchitectureSyncStepTransition = assertValidArchitectureSyncStepTransition;

/** Compare retry deliveries without treating state updates as new operations. */
export function compareArchitectureSyncStepIdempotency(existing: ArchitectureSyncStep, incoming: ArchitectureSyncStep): ArchitectureSyncIdempotencyDecision {
  if (existing.idempotencyKey !== incoming.idempotencyKey) return "new";
  return architectureSyncStepDigest(existing) === architectureSyncStepDigest(incoming) ? "duplicate" : "conflict";
}

export const resolveArchitectureSyncStepIdempotency = compareArchitectureSyncStepIdempotency;
export const architectureSyncIdempotencyOutcome = compareArchitectureSyncStepIdempotency;
