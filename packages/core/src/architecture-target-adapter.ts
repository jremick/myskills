/** Read-only adapter shape and conformance checks. */

import {
  type ReadOnlyArchitectureTargetAdapter,
  type ArchitectureTargetValidationIssue,
  type ArchitectureTargetValidationResult,
  ArchitectureTargetValidationError,
} from "./architecture-target-contracts.js";
import {
  issue,
  validateAdapterDescriptor,
} from "./architecture-target-validation.js";

export type ArchitectureTargetAdapterConformanceResult = ArchitectureTargetValidationResult<ReadOnlyArchitectureTargetAdapter>;

const forbiddenAdapterMethods = ["apply", "rollback", "write", "mutate", "install", "remove", "update", "configure", "enable", "disable", "sync"] as const;

/** Validate an adapter object without invoking it or mutating any state. */
export function validateReadOnlyArchitectureTargetAdapter(input: unknown): ArchitectureTargetAdapterConformanceResult {
  const errors: ArchitectureTargetValidationIssue[] = [];
  if ((typeof input !== "object" && typeof input !== "function") || input === null) {
    return { valid: false, errors: [{ code: "ARCHITECTURE_TARGET_ADAPTER_CONFORMANCE_INVALID", message: "Read-only adapter must be an object." }] };
  }
  const adapter = input as Partial<ReadOnlyArchitectureTargetAdapter> & Record<string, unknown>;
  const descriptor = validateAdapterDescriptor({ kind: adapter.kind, version: adapter.version, contractVersion: adapter.contractVersion }, "adapter", errors);
  if (typeof adapter.observe !== "function") issue(errors, "ARCHITECTURE_TARGET_ADAPTER_OBSERVE_METHOD_INVALID", "Read-only adapter must expose observe(context).", "adapter.observe");
  if (typeof adapter.health !== "function") issue(errors, "ARCHITECTURE_TARGET_ADAPTER_HEALTH_METHOD_INVALID", "Read-only adapter must expose health(context).", "adapter.health");
  for (const method of forbiddenAdapterMethods) {
    if (method in adapter) issue(errors, "ARCHITECTURE_TARGET_ADAPTER_MUTATION_METHOD", `Read-only adapter cannot expose '${method}'.`, `adapter.${method}`);
  }
  if (errors.length > 0 || !descriptor || typeof adapter.observe !== "function" || typeof adapter.health !== "function") return { valid: false, errors };
  return {
    valid: true,
    value: adapter as ReadOnlyArchitectureTargetAdapter,
  };
}

export function isReadOnlyArchitectureTargetAdapter(input: unknown): input is ReadOnlyArchitectureTargetAdapter {
  return validateReadOnlyArchitectureTargetAdapter(input).valid;
}

export function assertReadOnlyArchitectureTargetAdapter(input: unknown): ReadOnlyArchitectureTargetAdapter {
  const result = validateReadOnlyArchitectureTargetAdapter(input);
  if (!result.valid) throw new ArchitectureTargetValidationError(result.errors);
  return result.value;
}
