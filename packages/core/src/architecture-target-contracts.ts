/**
 * Framework-neutral contracts for connected architecture targets.
 *
 * A target is a physical, mutable integration boundary (for example a local
 * Codex installation). It is deliberately separate from the desired logical
 * environments in ArchitectureSpecV1. This module contains metadata-only
 * records and a read-only adapter surface. It never carries credentials,
 * machine paths, prompt text, configuration contents, or package bytes.
 */

import type { RuntimeExposureMode } from "./architecture.js";

export const architectureTargetSchemaVersion = 1 as const;
export type ArchitectureTargetSchemaVersion = typeof architectureTargetSchemaVersion;

export const architectureTargetOwnerReferenceTypes = ["user", "team", "organization"] as const;
export type ArchitectureTargetOwnerReferenceType = (typeof architectureTargetOwnerReferenceTypes)[number];

export interface ArchitectureTargetOwnerReference {
  type: ArchitectureTargetOwnerReferenceType;
  id: string;
}

export const architectureTargetStatuses = ["connected", "degraded", "revoked"] as const;
export type ArchitectureTargetStatus = (typeof architectureTargetStatuses)[number];

export const architectureTargetAccessPolicyVersion = 1 as const;
export type ArchitectureTargetAccessPolicyVersion = typeof architectureTargetAccessPolicyVersion;
export const architectureTargetAccessActions = ["list", "read", "register", "observe", "health", "revoke"] as const;
export type ArchitectureTargetAccessAction = (typeof architectureTargetAccessActions)[number];
export const architectureTargetAccessRoles = ["owner", "admin", "member"] as const;
export type ArchitectureTargetAccessRole = (typeof architectureTargetAccessRoles)[number];
export const architectureTargetAccessReasons = [
  "owner",
  "team-owner",
  "team-member",
  "organization-owner",
  "organization-admin",
  "organization-member",
  "not-owner",
  "not-member",
  "target-revoked",
] as const;
export type ArchitectureTargetAccessReason = (typeof architectureTargetAccessReasons)[number];

export const architectureTargetConsentStatuses = ["pending", "granted", "denied", "revoked"] as const;
export type ArchitectureTargetConsentStatus = (typeof architectureTargetConsentStatuses)[number];

export const architectureTargetAdapterContractVersions = [1] as const;
export type ArchitectureTargetAdapterContractVersion = (typeof architectureTargetAdapterContractVersions)[number];

export interface ArchitectureTargetAdapterDescriptor {
  kind: string;
  version: string;
  contractVersion: ArchitectureTargetAdapterContractVersion;
}

export const architectureTargetReadCapabilities = ["inventory.read", "health.read", "plan.read"] as const;
export type ArchitectureTargetReadCapability = (typeof architectureTargetReadCapabilities)[number];

/**
 * Mutation names are reserved in v1 so a target cannot accidentally advertise
 * a write surface. They may be omitted or explicitly set to false, but never
 * true until a later version defines an apply/recovery contract.
 */
export const architectureTargetMutationCapabilities = ["apply", "rollback", "sync.write"] as const;
export type ArchitectureTargetMutationCapability = (typeof architectureTargetMutationCapabilities)[number];

export const architectureTargetCapabilityNames = [
  ...architectureTargetReadCapabilities,
  ...architectureTargetMutationCapabilities,
] as const;
export type ArchitectureTargetCapability = (typeof architectureTargetCapabilityNames)[number];
export type ArchitectureTargetCapabilitySet = Partial<Record<ArchitectureTargetCapability, boolean>>;
export type ArchitectureTargetCapabilities = ArchitectureTargetCapabilitySet;

export const architectureTargetHealthStatuses = ["healthy", "degraded", "unavailable"] as const;
export type ArchitectureTargetHealthStatus = (typeof architectureTargetHealthStatuses)[number];

export const architectureTargetConfigFindingSeverities = ["info", "warning", "error"] as const;
export type ArchitectureTargetConfigFindingSeverity = (typeof architectureTargetConfigFindingSeverities)[number];

export const architectureTargetLimits = {
  identifierLength: 128,
  nameLength: 120,
  adapterKindLength: 64,
  adapterVersionLength: 64,
  versionLength: 64,
  metadataKeys: 32,
  metadataKeyLength: 64,
  metadataStringLength: 256,
  skills: 500,
  configFindings: 100,
  observationIdLength: 128,
  counterMaximum: 1_000_000_000,
  generationMaximum: 1_000_000_000,
} as const;

export type ArchitectureTargetMetadataValue = string | number | boolean | null;
export type ArchitectureTargetMetadata = Record<string, ArchitectureTargetMetadataValue>;

export interface ArchitectureTargetConsent {
  status: ArchitectureTargetConsentStatus;
  requestedAt: string;
  grantedAt?: string | null;
  deniedAt?: string | null;
  revokedAt?: string | null;
}

export interface ArchitectureTarget {
  schemaVersion: ArchitectureTargetSchemaVersion;
  id: string;
  name: string;
  owner: ArchitectureTargetOwnerReference;
  adapter: ArchitectureTargetAdapterDescriptor;
  /** ID of the desired architecture that owns the logical environment. */
  architectureId: string;
  /** ID of the desired logical ArchitectureSpecV1 environment. */
  environmentId: string;
  /** ID of the profile used by the logical environment. */
  profileId: string;
  status: ArchitectureTargetStatus;
  consent: ArchitectureTargetConsent;
  /** Monotonic binding generation used to reject stale observations. */
  generation: number;
  /** Opaque SHA-256 identity; never a path, host name, or machine identifier. */
  identityDigest: string;
  capabilities: ArchitectureTargetCapabilitySet;
  metadata?: ArchitectureTargetMetadata;
  createdAt?: string;
  updatedAt?: string;
}

export interface ArchitectureTargetTeamMembership {
  teamId: string;
  role: "owner" | "member";
}

export interface ArchitectureTargetOrganizationMembership {
  organizationId: string;
  role: ArchitectureTargetAccessRole;
}

/** Already-resolved current memberships consumed by the pure target policy. */
export interface ArchitectureTargetAccessActor {
  userId: string;
  teamMemberships?: readonly ArchitectureTargetTeamMembership[];
  organizationMemberships?: readonly ArchitectureTargetOrganizationMembership[];
}

export interface ArchitectureTargetAccessPolicyInput {
  owner: ArchitectureTargetOwnerReference;
  status: ArchitectureTargetStatus;
  actor: ArchitectureTargetAccessActor;
}

export interface ArchitectureTargetAccess {
  canList: boolean;
  canRead: boolean;
  canRegister: boolean;
  canObserve: boolean;
  canHealth: boolean;
  canRevoke: boolean;
  reason: ArchitectureTargetAccessReason;
}

export interface ArchitectureTargetAccessPolicyDecision {
  owner: ArchitectureTargetOwnerReference;
  targetStatus: ArchitectureTargetStatus;
  accessPolicyVersion: ArchitectureTargetAccessPolicyVersion;
  access: ArchitectureTargetAccess;
}

export interface ArchitectureTargetAccessEvaluationInput extends ArchitectureTargetAccessPolicyInput {
  action: ArchitectureTargetAccessAction;
}

export interface ArchitectureTargetAccessEvaluation {
  owner: ArchitectureTargetOwnerReference;
  targetStatus: ArchitectureTargetStatus;
  accessPolicyVersion: ArchitectureTargetAccessPolicyVersion;
  action: ArchitectureTargetAccessAction;
  allowed: boolean;
  reason: ArchitectureTargetAccessReason;
}

export type ArchitectureTargetPolicyActor = ArchitectureTargetAccessActor;
export type ArchitectureTargetPolicyInput = ArchitectureTargetAccessPolicyInput;
export type ArchitectureTargetPolicyDecision = ArchitectureTargetAccessPolicyDecision;

export interface ArchitectureTargetObservedSkill {
  /** Registry reference when the local adapter can resolve one. */
  skillRefId?: string;
  slug: string;
  version?: string;
  digest?: string;
  kind?: "router" | "leaf";
  enabled?: boolean;
  runtimeExposure?: RuntimeExposureMode;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
  metadata?: ArchitectureTargetMetadata;
}

/** A finding is a bounded classification/count, never a config path or value. */
export interface ArchitectureTargetConfigFinding {
  code: string;
  severity: ArchitectureTargetConfigFindingSeverity;
  count: number;
}

/** Prompt awareness is intentionally limited to booleans and counts. */
export interface ArchitectureTargetPromptAwareness {
  detected: boolean;
  count: number;
  redacted?: boolean;
}

/**
 * Append-only metadata observation. The digest is calculated from the
 * normalized metadata record without observedDigest or the storage id.
 */
export interface ArchitectureTargetObservation {
  schemaVersion: ArchitectureTargetSchemaVersion;
  id?: string;
  targetId: string;
  targetGeneration: number;
  adapterDigest: string;
  capabilitiesDigest: string;
  observedAt: string;
  skills: ArchitectureTargetObservedSkill[];
  configFindings: ArchitectureTargetConfigFinding[];
  promptAwareness: ArchitectureTargetPromptAwareness;
  metadata?: ArchitectureTargetMetadata;
  observedDigest: string;
}

export type ArchitectureTargetObservationInput = Omit<ArchitectureTargetObservation, "observedDigest"> & {
  observedDigest?: string;
};

export interface ArchitectureTargetHealth {
  status: ArchitectureTargetHealthStatus;
  checkedAt: string;
  metadata?: ArchitectureTargetMetadata;
}

/** Context passed to a local adapter; it contains no credentials or paths. */
export interface ArchitectureTargetAdapterContext {
  targetId: string;
  targetGeneration: number;
  architectureId: string;
  environmentId: string;
  profileId: string;
  adapterDigest: string;
  capabilitiesDigest: string;
}

/**
 * The v1 adapter surface is intentionally read-only. Do not add apply,
 * rollback, write, or mutation methods to this interface.
 */
export interface ReadOnlyArchitectureTargetAdapter {
  readonly kind: string;
  readonly version: string;
  readonly contractVersion: ArchitectureTargetAdapterContractVersion;
  observe(context: ArchitectureTargetAdapterContext): Promise<ArchitectureTargetObservation>;
  health(context: ArchitectureTargetAdapterContext): Promise<ArchitectureTargetHealth>;
}

export type ArchitectureTargetAdapter = ReadOnlyArchitectureTargetAdapter;

export type ArchitectureTargetValidationCode =
  | "ARCHITECTURE_TARGET_INVALID_OBJECT"
  | "ARCHITECTURE_TARGET_UNKNOWN_FIELD"
  | "ARCHITECTURE_TARGET_SENSITIVE_FIELD"
  | "ARCHITECTURE_TARGET_SCHEMA_VERSION_INVALID"
  | "ARCHITECTURE_TARGET_ID_INVALID"
  | "ARCHITECTURE_TARGET_NAME_INVALID"
  | "ARCHITECTURE_TARGET_OWNER_INVALID"
  | "ARCHITECTURE_TARGET_OWNER_TYPE_INVALID"
  | "ARCHITECTURE_TARGET_OWNER_ID_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_KIND_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_VERSION_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_CONTRACT_VERSION_INVALID"
  | "ARCHITECTURE_TARGET_ARCHITECTURE_ID_INVALID"
  | "ARCHITECTURE_TARGET_ENVIRONMENT_ID_INVALID"
  | "ARCHITECTURE_TARGET_PROFILE_ID_INVALID"
  | "ARCHITECTURE_TARGET_STATUS_INVALID"
  | "ARCHITECTURE_TARGET_CONSENT_INVALID"
  | "ARCHITECTURE_TARGET_CONSENT_STATUS_INVALID"
  | "ARCHITECTURE_TARGET_TIMESTAMP_INVALID"
  | "ARCHITECTURE_TARGET_CONSENT_TIMESTAMP_REQUIRED"
  | "ARCHITECTURE_TARGET_GENERATION_INVALID"
  | "ARCHITECTURE_TARGET_IDENTITY_DIGEST_INVALID"
  | "ARCHITECTURE_TARGET_CAPABILITIES_INVALID"
  | "ARCHITECTURE_TARGET_CAPABILITY_INVALID"
  | "ARCHITECTURE_TARGET_MUTATION_CAPABILITY_ENABLED"
  | "ARCHITECTURE_TARGET_METADATA_INVALID"
  | "ARCHITECTURE_TARGET_LIMIT_EXCEEDED"
  | "ARCHITECTURE_TARGET_OBSERVATION_INVALID"
  | "ARCHITECTURE_TARGET_OBSERVATION_DIGEST_INVALID"
  | "ARCHITECTURE_TARGET_OBSERVATION_DIGEST_MISMATCH"
  | "ARCHITECTURE_TARGET_SKILL_INVALID"
  | "ARCHITECTURE_TARGET_CONFIG_FINDING_INVALID"
  | "ARCHITECTURE_TARGET_PROMPT_AWARENESS_INVALID"
  | "ARCHITECTURE_TARGET_HEALTH_INVALID"
  | "ARCHITECTURE_TARGET_HEALTH_STATUS_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_POLICY_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_ACTOR_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_USER_ID_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIPS_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIP_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_TEAM_ID_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_TEAM_ROLE_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_TEAM_MEMBERSHIP_DUPLICATE"
  | "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIPS_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIP_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_ID_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_ROLE_INVALID"
  | "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIP_DUPLICATE"
  | "ARCHITECTURE_TARGET_ACCESS_ACTION_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_CONFORMANCE_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_MUTATION_METHOD"
  | "ARCHITECTURE_TARGET_ADAPTER_OBSERVE_METHOD_INVALID"
  | "ARCHITECTURE_TARGET_ADAPTER_HEALTH_METHOD_INVALID";

export interface ArchitectureTargetValidationIssue {
  code: ArchitectureTargetValidationCode;
  message: string;
  path?: string;
}

export type ArchitectureTargetValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: ArchitectureTargetValidationIssue[] };

export class ArchitectureTargetValidationError extends Error {
  public readonly code = "ARCHITECTURE_TARGET_VALIDATION_FAILED";
  public readonly statusCode = 422;

  constructor(public readonly errors: readonly ArchitectureTargetValidationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Architecture target input is invalid.");
    this.name = "ArchitectureTargetValidationError";
  }
}
