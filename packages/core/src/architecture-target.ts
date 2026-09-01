/**
 * Compatibility façade for connected architecture target contracts.
 *
 * The implementation is intentionally split into focused modules:
 * contracts/validation, access policy, observation/digests, and read-only
 * adapter conformance. Keep this module stable for existing consumers.
 */

export * from "./architecture-target-contracts.js";

export {
  assertValidArchitectureTarget,
  assertValidArchitectureTargetAdapterContext,
  validateArchitectureTarget,
  validateArchitectureTargetAdapterContext,
  validateConnectedArchitectureTarget,
} from "./architecture-target-validation.js";

export {
  assertValidArchitectureTargetAccessPolicyInput,
  evaluateArchitectureTargetAccess,
  evaluateArchitectureTargetAccessPolicy,
  evaluateArchitectureTargetOwnershipAccess,
  evaluateArchitectureTargetPolicy,
  isArchitectureTargetAccessAllowed,
  validateArchitectureTargetAccessPolicyInput,
} from "./architecture-target-access.js";

export {
  architectureObservationDigest,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetObservationDigest,
  assertValidArchitectureTargetObservation,
  validateArchitectureTargetHealth,
  validateArchitectureTargetObservation,
  validateArchitectureTargetObservationRecord,
} from "./architecture-target-observation.js";

export {
  assertReadOnlyArchitectureTargetAdapter,
  isReadOnlyArchitectureTargetAdapter,
  validateReadOnlyArchitectureTargetAdapter,
  type ArchitectureTargetAdapterConformanceResult,
} from "./architecture-target-adapter.js";
