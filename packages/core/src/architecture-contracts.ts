/**
 * Versioned, metadata-only skill architecture contracts.
 *
 * This module deliberately has no dependency on a registry, a filesystem, or
 * an agent runtime. The API owns the canonical revision; everything here is a
 * pure validation, projection, compilation, or dry-run operation over that
 * revision and already-authorized metadata snapshots.
 */

export const architectureSchemaVersion = 1 as const;
export const architecturePatternIds = ["flat", "domain-router", "multi-level-router"] as const;
export const architectureNodeKinds = ["router", "leaf"] as const;
export const architectureEdgeKinds = ["contains", "routes"] as const;
export const runtimeExposureModes = ["disabled", "router", "leaf"] as const;
export const architectureEnvironmentKinds = ["personal", "work", "team"] as const;
export const architectureSubjectKinds = ["user", "team"] as const;
export const architectureLimits = {
  skills: 500,
  nodes: 500,
  edges: 999,
  entryNodeIds: 500,
  profiles: 50,
  bindingsPerProfile: 500,
  environments: 100,
  topologyDepth: 12,
  metadataKeys: 64,
  metadataKeyLength: 64,
  metadataStringLength: 512,
} as const;
export const architectureSyncActions = [
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
] as const;

export type ArchitectureSchemaVersion = typeof architectureSchemaVersion;
export type ArchitecturePatternId = (typeof architecturePatternIds)[number];
export type ArchitectureNodeKind = (typeof architectureNodeKinds)[number];
export type ArchitectureEdgeKind = (typeof architectureEdgeKinds)[number];
export type RuntimeExposureMode = (typeof runtimeExposureModes)[number];
export type ArchitectureEnvironmentKind = (typeof architectureEnvironmentKinds)[number];
export type ArchitectureSubjectKind = (typeof architectureSubjectKinds)[number];
export type ArchitectureSyncAction = (typeof architectureSyncActions)[number];

/** The package catalogue visibility is intentionally separate from runtime exposure. */
export const architecturePackageVisibilityScopes = [
  "public",
  "authenticated",
  "organization",
  "team",
  "private",
  "explicit-users",
] as const;
export type ArchitecturePackageVisibility = (typeof architecturePackageVisibilityScopes)[number];

export type ArchitectureMetadataValue = string | number | boolean | null;
export type ArchitectureMetadata = Record<string, ArchitectureMetadataValue>;

export interface ArchitecturePattern {
  id: ArchitecturePatternId;
  version: ArchitectureSchemaVersion;
}

export interface ArchitectureSkillRef {
  /** Stable registry identifier. This is not package content. */
  id: string;
  slug: string;
  title?: string;
  summary?: string;
  version: string;
  /** Lowercase SHA-256 of the approved package artifact. */
  digest: string;
  /** Package discovery/sharing visibility, not runtime exposure. */
  packageVisibility: ArchitecturePackageVisibility;
  tags?: string[];
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureRouterNode {
  id: string;
  kind: "router";
  label: string;
  /** Optional when the router is a logical node rather than an installed skill. */
  skillRefId?: string;
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureLeafNode {
  id: string;
  kind: "leaf";
  label: string;
  skillRefId: string;
  metadata?: ArchitectureMetadata;
}

export type ArchitectureNode = ArchitectureRouterNode | ArchitectureLeafNode;

export interface ArchitectureEdge {
  from: string;
  to: string;
  kind: ArchitectureEdgeKind;
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureProfileBinding {
  nodeId: string;
  enabled: boolean;
  /** Omitted means this rule applies to every environment using the profile. */
  environmentIds?: string[];
  /** `disabled` is valid only when enabled is false. */
  runtimeExposure: RuntimeExposureMode;
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureProfile {
  id: string;
  name: string;
  subject: {
    type: ArchitectureSubjectKind;
    id: string;
  };
  /** Profiles never grant by default. Missing bindings are disabled. */
  defaultExposure: "disabled";
  bindings: ArchitectureProfileBinding[];
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureEnvironment {
  id: string;
  name: string;
  kind: ArchitectureEnvironmentKind;
  profileId: string;
  parentId?: string | null;
  metadata?: ArchitectureMetadata;
}

export interface ArchitectureSpecV1 {
  schemaVersion: ArchitectureSchemaVersion;
  id: string;
  name: string;
  description?: string;
  pattern: ArchitecturePattern;
  skills: ArchitectureSkillRef[];
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  /** Roots of the topology. A multi-level router has one root router. */
  entryNodeIds: string[];
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
  metadata?: ArchitectureMetadata;
}

/** A registry snapshot is metadata-only and must already have passed auth. */
export interface AuthorizedRegistrySkillSnapshot {
  id?: string;
  skillRefId?: string;
  slug: string;
  title?: string;
  summary?: string;
  version: string;
  digest: string;
  packageVisibility?: ArchitecturePackageVisibility;
  /** Compatibility alias for registry rows that call this field `visibility`. */
  visibility?: ArchitecturePackageVisibility;
  tags?: string[];
  metadata?: ArchitectureMetadata;
}

export type AuthorizedRegistrySnapshot = readonly AuthorizedRegistrySkillSnapshot[];

export interface ArchitectureCompileOptions {
  registry: AuthorizedRegistrySnapshot;
  profileId?: string;
  environmentId?: string;
}

export interface ArchitectureEnvironmentResolutionOptions {
  /** Omit only when the architecture has exactly one environment. */
  environmentId?: string;
  /** Must match the profile bound to the selected environment. */
  profileId?: string;
}

/** The selected logical context used by compilation and explainability views. */
export interface ArchitectureEnvironmentResolution {
  environment: ArchitectureEnvironment;
  profile: ArchitectureProfile;
  /** Selected environment first, followed by each declared parent. */
  ancestorIds: string[];
}

export type ArchitectureBindingDecision = "enabled" | "disabled";
export type ArchitectureBindingProvenanceKind = "binding" | "missing";
export type ArchitectureBindingProvenanceReason =
  | "selected-environment"
  | "ancestor-environment"
  | "wildcard"
  | "explicit-deny"
  | "missing";

/** Stable explanation for the binding selected by the environment overlay. */
export interface ArchitectureBindingProvenance {
  kind: ArchitectureBindingProvenanceKind;
  reason: ArchitectureBindingProvenanceReason;
  /** The scope that supplied the selected rule; omitted for wildcard/missing. */
  sourceEnvironmentId?: string;
  wildcard: boolean;
  /** Zero is the selected environment; larger values are nearer ancestors. */
  specificity: number;
  /** Canonical scope key used as the final deterministic tie-breaker. */
  scopeKey: string;
}

export interface ArchitectureProfileBindingResolution {
  decision: ArchitectureBindingDecision;
  binding?: ArchitectureProfileBinding;
  /** True only when the selected rule explicitly disables the node. */
  denied: boolean;
  /** `Infinity` denotes a wildcard rule or no matching rule. */
  specificity: number;
  sourceEnvironmentId?: string;
  wildcard: boolean;
  provenance: ArchitectureBindingProvenance;
}

export interface ArchitectureProfileBindingResolutionOptions {
  profileId: string;
  environmentId: string;
  nodeId: string;
}

export interface CompiledArchitectureSkill {
  skillRefId: string;
  slug: string;
  title?: string;
  summary?: string;
  version: string;
  digest: string;
  packageVisibility: ArchitecturePackageVisibility;
  tags?: string[];
  metadata?: ArchitectureMetadata;
}

export interface CompiledArchitectureNode {
  id: string;
  kind: ArchitectureNodeKind;
  label: string;
  skillRefId?: string;
  runtimeExposure: Exclude<RuntimeExposureMode, "disabled">;
  childNodeIds: string[];
}

export interface CompiledArchitectureRoute {
  from: string;
  to: string;
  kind: ArchitectureEdgeKind;
}

export interface CompiledRouterConfiguration {
  nodeId: string;
  childNodeIds: string[];
  routes: CompiledArchitectureRoute[];
  digest: string;
}

export interface CompiledArchitecture {
  schemaVersion: ArchitectureSchemaVersion;
  architectureId: string;
  revisionDigest: string;
  pattern: ArchitecturePattern;
  profileId: string;
  environmentId: string;
  /** Only nodes exposed by the selected profile/environment. */
  nodes: CompiledArchitectureNode[];
  /** All topology node metadata, retained so a planner can disable stale nodes. */
  allNodes: Array<Pick<ArchitectureNode, "id" | "kind" | "label"> & { skillRefId?: string; slug?: string }>;
  disabledNodeIds: string[];
  edges: CompiledArchitectureRoute[];
  skills: CompiledArchitectureSkill[];
  routers: CompiledRouterConfiguration[];
}

export interface ObservedArchitectureSkill {
  nodeId?: string;
  /** Optional when a package observation also identifies its installed node kind. */
  kind?: ArchitectureNodeKind;
  skillRefId?: string;
  slug: string;
  version: string;
  digest: string;
  enabled: boolean;
  runtimeExposure?: RuntimeExposureMode;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
  metadata?: ArchitectureMetadata;
}

export interface ObservedArchitectureRouter {
  nodeId: string;
  /** Package identity/state is optional for logical routers, but required to reconcile skill-backed routers. */
  skillRefId?: string;
  slug?: string;
  version?: string;
  digest?: string;
  enabled?: boolean;
  runtimeExposure?: RuntimeExposureMode;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
  metadata?: ArchitectureMetadata;
}

export interface ObservedArchitectureNode {
  /** Optional for adapters that identify a skill only by registry ref or slug. */
  nodeId?: string;
  kind?: ArchitectureNodeKind;
  skillRefId?: string;
  slug?: string;
  version?: string;
  digest?: string;
  enabled?: boolean;
  runtimeExposure?: RuntimeExposureMode;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
  metadata?: ArchitectureMetadata;
}

export interface ObservedArchitectureState {
  targetId: string;
  environmentId?: string;
  skills?: readonly ObservedArchitectureSkill[];
  routers?: readonly ObservedArchitectureRouter[];
  /** Generic node form is useful for adapters that cannot split routers/leaves. */
  nodes?: readonly ObservedArchitectureNode[];
}

export interface ArchitectureSyncPlanItem {
  action: ArchitectureSyncAction;
  nodeId: string;
  kind: ArchitectureNodeKind;
  skillRefId?: string;
  reason: string;
  desired?: {
    version?: string;
    digest?: string;
    enabled: boolean;
    runtimeExposure?: RuntimeExposureMode;
  };
  observed?: {
    version?: string;
    digest?: string;
    enabled?: boolean;
    runtimeExposure?: RuntimeExposureMode;
    configurationDigest?: string;
    configured?: boolean;
  };
}

export interface ArchitectureSyncPlan {
  dryRun: true;
  canApply: false;
  requiresApproval: true;
  targetId: string;
  environmentId: string;
  architectureId: string;
  revisionDigest: string;
  items: ArchitectureSyncPlanItem[];
}

export type ArchitectureValidationCode =
  | "ARCHITECTURE_INVALID_OBJECT"
  | "ARCHITECTURE_FIELD_TYPE_INVALID"
  | "ARCHITECTURE_SCHEMA_VERSION_UNSUPPORTED"
  | "ARCHITECTURE_ID_REQUIRED"
  | "ARCHITECTURE_ID_INVALID"
  | "ARCHITECTURE_NAME_REQUIRED"
  | "ARCHITECTURE_PATTERN_REQUIRED"
  | "ARCHITECTURE_PATTERN_UNSUPPORTED"
  | "ARCHITECTURE_PATTERN_VERSION_UNSUPPORTED"
  | "ARCHITECTURE_SKILLS_REQUIRED"
  | "ARCHITECTURE_DUPLICATE_SKILL_ID"
  | "ARCHITECTURE_SKILL_ID_INVALID"
  | "ARCHITECTURE_SKILL_SLUG_INVALID"
  | "ARCHITECTURE_SKILL_VERSION_INVALID"
  | "ARCHITECTURE_SKILL_DIGEST_INVALID"
  | "ARCHITECTURE_PACKAGE_VISIBILITY_INVALID"
  | "ARCHITECTURE_NODES_REQUIRED"
  | "ARCHITECTURE_DUPLICATE_NODE_ID"
  | "ARCHITECTURE_NODE_ID_INVALID"
  | "ARCHITECTURE_NODE_KIND_INVALID"
  | "ARCHITECTURE_NODE_LABEL_REQUIRED"
  | "ARCHITECTURE_NODE_SKILL_REQUIRED"
  | "ARCHITECTURE_NODE_SKILL_UNKNOWN"
  | "ARCHITECTURE_EDGES_REQUIRED"
  | "ARCHITECTURE_EDGE_INVALID"
  | "ARCHITECTURE_EDGE_DUPLICATE"
  | "ARCHITECTURE_EDGE_SOURCE_NOT_ROUTER"
  | "ARCHITECTURE_EDGE_TARGET_NOT_ROUTER"
  | "ARCHITECTURE_EDGE_TARGET_NOT_LEAF"
  | "ARCHITECTURE_NODE_MULTIPLE_PARENTS"
  | "ARCHITECTURE_ENTRY_REQUIRED"
  | "ARCHITECTURE_ENTRY_UNKNOWN"
  | "ARCHITECTURE_CYCLE"
  | "ARCHITECTURE_ORPHAN_NODE"
  | "ARCHITECTURE_PATTERN_SHAPE_INVALID"
  | "ARCHITECTURE_PROFILES_REQUIRED"
  | "ARCHITECTURE_DUPLICATE_PROFILE_ID"
  | "ARCHITECTURE_PROFILE_INVALID"
  | "ARCHITECTURE_PROFILE_BINDING_INVALID"
  | "ARCHITECTURE_PROFILE_BINDING_DUPLICATE"
  | "ARCHITECTURE_PROFILE_BINDING_UNKNOWN_NODE"
  | "ARCHITECTURE_PROFILE_BINDING_UNKNOWN_ENVIRONMENT"
  | "ARCHITECTURE_RUNTIME_EXPOSURE_INVALID"
  | "ARCHITECTURE_DEFAULT_EXPOSURE_INVALID"
  | "ARCHITECTURE_ENVIRONMENTS_REQUIRED"
  | "ARCHITECTURE_DUPLICATE_ENVIRONMENT_ID"
  | "ARCHITECTURE_ENVIRONMENT_INVALID"
  | "ARCHITECTURE_ENVIRONMENT_UNKNOWN_PROFILE"
  | "ARCHITECTURE_ENVIRONMENT_UNKNOWN_PARENT"
  | "ARCHITECTURE_ENVIRONMENT_PARENT_CYCLE"
  | "ARCHITECTURE_LIMIT_EXCEEDED"
  | "ARCHITECTURE_METADATA_NOT_METADATA"
  | "ARCHITECTURE_METADATA_SENSITIVE_FIELD"
  | "ARCHITECTURE_METADATA_UNSAFE_VALUE";

export interface ArchitectureValidationIssue {
  code: ArchitectureValidationCode;
  message: string;
  path?: string;
}

export type ArchitectureValidationResult =
  | { valid: true; value: ArchitectureSpecV1 }
  | { valid: false; errors: ArchitectureValidationIssue[] };

export class ArchitectureValidationError extends Error {
  public readonly code = "ARCHITECTURE_VALIDATION_FAILED";
  public readonly statusCode = 422;

  constructor(public readonly errors: ArchitectureValidationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Architecture is invalid.");
    this.name = "ArchitectureValidationError";
  }
}

export class ArchitectureCompileError extends Error {
  public readonly code: string;
  public readonly statusCode = 422;
  public readonly errors?: readonly ArchitectureValidationIssue[];

  constructor(code: string, message: string, errors?: readonly ArchitectureValidationIssue[]) {
    super(message);
    this.name = "ArchitectureCompileError";
    this.code = code;
    if (errors !== undefined) this.errors = [...errors];
  }
}
