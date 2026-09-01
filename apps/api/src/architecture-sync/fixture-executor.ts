import {
  architectureSyncObservedDigest,
  type ArchitectureSyncRecoveryCondition,
} from "@myskills-app/core";
import {
  ArchitectureSyncExecutorError,
  type ArchitectureSyncExecutorApplyInput,
  type ArchitectureSyncExecutorApplyResult,
  type ArchitectureSyncExecutorRollbackInput,
  type ArchitectureSyncExecutorRollbackResult,
  type ArchitectureSyncExecutorVerifyInput,
  type ArchitectureSyncExecutorVerifyResult,
  type ArchitectureSyncExecutorFailureOptions,
  type ArchitectureSyncFixtureExecutor,
} from "./types.js";

/**
 * A deterministic local executor used only by tests and fixture previews.
 * It records synthetic step ids in memory and has no target client, file
 * access, network access, or source snapshot input.
 */
export class MemoryArchitectureSyncFixtureExecutor implements ArchitectureSyncFixtureExecutor {
  readonly kind = "fixture" as const;

  private readonly applied = new Map<string, Set<string>>();
  private readonly rolledBack = new Set<string>();
  private failure?: ArchitectureSyncExecutorFailureOptions;
  private failureUsesRemaining = 1;

  constructor(options: { readonly failure?: ArchitectureSyncExecutorFailureOptions; readonly failureUses?: number } = {}) {
    this.failure = options.failure;
    this.failureUsesRemaining = options.failureUses ?? 1;
  }

  injectFailure(options: ArchitectureSyncExecutorFailureOptions, uses = 1): void {
    this.failure = options;
    this.failureUsesRemaining = uses;
  }

  clearFailure(): void {
    this.failure = undefined;
    this.failureUsesRemaining = 0;
  }

  async apply(input: ArchitectureSyncExecutorApplyInput): Promise<ArchitectureSyncExecutorApplyResult> {
    this.assertFailure("before-mutation");
    const steps = this.applied.get(input.run.identity.runId) ?? new Set<string>();
    steps.add(input.step.id);
    this.applied.set(input.run.identity.runId, steps);
    this.assertFailure("after-mutation-before-receipt", true);
    return {
      mutated: input.step.action !== "noop",
      receipt: {
        status: "succeeded",
        code: "step.applied",
        metadata: { action: input.step.action },
      },
    };
  }

  async verify(input: ArchitectureSyncExecutorVerifyInput): Promise<ArchitectureSyncExecutorVerifyResult> {
    this.assertFailure("verify", true);
    const applied = this.applied.get(input.run.identity.runId)?.has(input.step.id) ?? false;
    if (!applied && input.step.action !== "noop") {
      return {
        ok: false,
        condition: "ambiguous-readback",
        receipt: { status: "unknown", code: "step.readback-ambiguous" },
      };
    }
    return {
      ok: true,
      receipt: {
        status: "succeeded",
        code: "step.verified",
        metadata: { observedDigest: architectureSyncObservedDigest({ stepId: input.step.id, state: "applied" }) },
      },
    };
  }

  async rollback(input: ArchitectureSyncExecutorRollbackInput): Promise<ArchitectureSyncExecutorRollbackResult> {
    this.assertFailure("rollback", true);
    this.rolledBack.add(input.run.identity.runId);
    this.applied.delete(input.run.identity.runId);
    return {
      ok: true,
      receipt: {
        status: "succeeded",
        code: "baseline.restored",
        metadata: { baselineRestorable: input.baseline.restorable },
      },
    };
  }

  hasApplied(runId: string, stepId: string): boolean {
    return this.applied.get(runId)?.has(stepId) ?? false;
  }

  wasRolledBack(runId: string): boolean {
    return this.rolledBack.has(runId);
  }

  private assertFailure(phase: ArchitectureSyncExecutorFailureOptions["phase"], mutateBeforeThrow = false): void {
    if (!this.failure || this.failure.phase !== phase || this.failureUsesRemaining <= 0) return;
    this.failureUsesRemaining -= 1;
    throw new ArchitectureSyncExecutorError({
      ...this.failure,
      mutateBeforeThrow: this.failure.mutateBeforeThrow ?? mutateBeforeThrow,
    });
  }
}
export function recoveryConditionForExecutorFailure(
  failure: ArchitectureSyncExecutorError,
): ArchitectureSyncRecoveryCondition {
  if (failure.condition) return failure.condition;
  if (!failure.mutated) return "no-mutation";
  return failure.phase === "verify" ? "restorable-partial-state" : "ambiguous-readback";
}
