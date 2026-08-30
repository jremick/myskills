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
  | "ARCHITECTURE_METADATA_NOT_METADATA";

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

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArchitectureCompileError";
    this.code = code;
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const skillSlugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const deniedMetadataKeyPattern = /content|instruction|prompt|secret|token|password|credential|private[-_ ]?key|package|path|endpoint|url/i;

function isSemVer(value: string): boolean {
  const match = value.match(semverPattern);
  if (!match) return false;
  return !(match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) ?? false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function pushIssue(errors: ArchitectureValidationIssue[], code: ArchitectureValidationCode, message: string, path?: string): void {
  errors.push(path ? { code, message, path } : { code, message });
}

function validateMetadata(value: unknown, errors: ArchitectureValidationIssue[], path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata must be a flat object of scalar values.", path);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > architectureLimits.metadataKeys) {
    pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Metadata may contain at most ${architectureLimits.metadataKeys} fields.`, path);
    return;
  }
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > architectureLimits.metadataKeyLength || deniedMetadataKeyPattern.test(key)) {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", `Metadata field '${key}' is not allowed.`, `${path}.${key}`);
    }
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata values must be scalar.", `${path}.${key}`);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata numbers must be finite.", `${path}.${key}`);
    }
    if (typeof item === "string" && item.length > architectureLimits.metadataStringLength) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Metadata strings may contain at most ${architectureLimits.metadataStringLength} characters.`, `${path}.${key}`);
    }
  }
}

function validateCollectionLimit(
  value: unknown,
  maximum: number,
  errors: ArchitectureValidationIssue[],
  path: string,
): void {
  if (Array.isArray(value) && value.length > maximum) {
    pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `${path} may contain at most ${maximum} items.`, path);
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string") as string | undefined;
}

function rawPackageVisibility(skill: Record<string, unknown>): unknown {
  return skill.packageVisibility ?? skill.visibility;
}

function rawRuntimeExposure(binding: Record<string, unknown>): unknown {
  return binding.runtimeExposure ?? binding.exposure;
}

function validateStringField(
  value: unknown,
  errors: ArchitectureValidationIssue[],
  code: ArchitectureValidationCode,
  message: string,
  path: string,
): value is string {
  if (typeof value !== "string" || value.length === 0) {
    pushIssue(errors, code, message, path);
    return false;
  }
  return true;
}

function validateOptionalStringField(value: unknown, errors: ArchitectureValidationIssue[], path: string, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    pushIssue(errors, "ARCHITECTURE_FIELD_TYPE_INVALID", `${field} must be a string when provided.`, path);
  }
}

function normalizeMetadata(value: unknown): ArchitectureMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const result: ArchitectureMetadata = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeSkillRef(value: Record<string, unknown>): ArchitectureSkillRef {
  const packageVisibility = (rawPackageVisibility(value) as ArchitecturePackageVisibility | undefined) ?? "private";
  const result: ArchitectureSkillRef = {
    id: String(value.id ?? ""),
    slug: String(value.slug ?? ""),
    version: String(value.version ?? ""),
    digest: String(value.digest ?? ""),
    packageVisibility,
  };
  const title = firstString(value.title);
  const summary = firstString(value.summary);
  const tags = Array.isArray(value.tags) ? value.tags.filter((item): item is string => typeof item === "string").slice().sort() : undefined;
  const metadata = normalizeMetadata(value.metadata);
  if (title !== undefined) result.title = title;
  if (summary !== undefined) result.summary = summary;
  if (tags !== undefined && tags.length > 0) result.tags = tags;
  if (metadata !== undefined) result.metadata = metadata;
  return result;
}

/** Validate a revision without consulting a registry or runtime. */
export function validateArchitectureSpec(input: unknown): ArchitectureValidationResult {
  const errors: ArchitectureValidationIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: [{ code: "ARCHITECTURE_INVALID_OBJECT", message: "Architecture must be an object." }] };
  }

  if (input.schemaVersion !== architectureSchemaVersion && input.schemaVersion !== String(architectureSchemaVersion)) {
    pushIssue(errors, "ARCHITECTURE_SCHEMA_VERSION_UNSUPPORTED", "Only architecture schema version 1 is supported.", "schemaVersion");
  }
  const id = input.id;
  if (!validateStringField(id, errors, "ARCHITECTURE_ID_REQUIRED", "Architecture id is required.", "id")) {
    // Keep the stable required code for empty values, and add the format code only for non-empty invalid values.
  } else if (!identifierPattern.test(id)) {
    pushIssue(errors, "ARCHITECTURE_ID_INVALID", "Architecture id contains unsupported characters.", "id");
  }
  const name = input.name;
  if (validateStringField(name, errors, "ARCHITECTURE_NAME_REQUIRED", "Architecture name is required.", "name") && name.length > 120) {
    pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Architecture name may contain at most 120 characters.", "name");
  }
  validateOptionalStringField(input.description, errors, "description", "Architecture description");
  if (typeof input.description === "string" && input.description.length > 500) {
    pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Architecture description may contain at most 500 characters.", "description");
  }

  const pattern = input.pattern;
  if (!isRecord(pattern)) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_REQUIRED", "Architecture pattern is required.", "pattern");
  } else {
    if (!isOneOf(pattern.id, architecturePatternIds)) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_UNSUPPORTED", "Architecture pattern is unsupported.", "pattern.id");
    }
    if (pattern.version !== architectureSchemaVersion && pattern.version !== String(architectureSchemaVersion)) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_VERSION_UNSUPPORTED", "Only pattern version 1 is supported.", "pattern.version");
    }
  }

  const topLevelCollections: Array<[unknown, number, string]> = [
    [input.skills, architectureLimits.skills, "skills"],
    [input.nodes, architectureLimits.nodes, "nodes"],
    [input.edges, architectureLimits.edges, "edges"],
    [input.entryNodeIds, architectureLimits.entryNodeIds, "entryNodeIds"],
    [input.profiles, architectureLimits.profiles, "profiles"],
    [input.environments, architectureLimits.environments, "environments"],
  ];
  for (const [value, maximum, path] of topLevelCollections) {
    validateCollectionLimit(value, maximum, errors, path);
  }
  if (errors.some((error) => error.code === "ARCHITECTURE_LIMIT_EXCEEDED")) {
    return { valid: false, errors };
  }

  const skillsInput = input.skills;
  const skills = Array.isArray(skillsInput) ? skillsInput : [];
  if (!Array.isArray(skillsInput) || skills.length === 0) {
    pushIssue(errors, "ARCHITECTURE_SKILLS_REQUIRED", "At least one skill reference is required.", "skills");
  }
  const skillIds = new Set<string>();
  for (const [index, rawSkill] of skills.entries()) {
    const path = `skills[${index}]`;
    if (!isRecord(rawSkill)) {
      pushIssue(errors, "ARCHITECTURE_SKILL_ID_INVALID", "Skill reference must be an object.", path);
      continue;
    }
    if (!validateStringField(rawSkill.id, errors, "ARCHITECTURE_SKILL_ID_INVALID", "Skill reference id is required.", `${path}.id`)) {
      // no-op
    } else {
      if (!identifierPattern.test(rawSkill.id)) pushIssue(errors, "ARCHITECTURE_SKILL_ID_INVALID", "Skill reference id contains unsupported characters.", `${path}.id`);
      if (skillIds.has(rawSkill.id)) pushIssue(errors, "ARCHITECTURE_DUPLICATE_SKILL_ID", "Skill reference ids must be unique.", `${path}.id`);
      skillIds.add(rawSkill.id);
    }
    if (!validateStringField(rawSkill.slug, errors, "ARCHITECTURE_SKILL_SLUG_INVALID", "Skill slug is required.", `${path}.slug`)) {
      // no-op
    } else if (!skillSlugPattern.test(rawSkill.slug) || rawSkill.slug.length > 64 || rawSkill.slug.includes("--")) {
      pushIssue(errors, "ARCHITECTURE_SKILL_SLUG_INVALID", "Skill slug must use lowercase letters, numbers, and single hyphens.", `${path}.slug`);
    }
    if (!validateStringField(rawSkill.version, errors, "ARCHITECTURE_SKILL_VERSION_INVALID", "Skill version is required.", `${path}.version`)) {
      // no-op
    } else if (!isSemVer(rawSkill.version)) {
      pushIssue(errors, "ARCHITECTURE_SKILL_VERSION_INVALID", "Skill version must use semantic versioning.", `${path}.version`);
    }
    if (!validateStringField(rawSkill.digest, errors, "ARCHITECTURE_SKILL_DIGEST_INVALID", "Skill digest is required.", `${path}.digest`)) {
      // no-op
    } else if (!digestPattern.test(rawSkill.digest)) {
      pushIssue(errors, "ARCHITECTURE_SKILL_DIGEST_INVALID", "Skill digest must be a lowercase SHA-256 hex digest.", `${path}.digest`);
    }
    if (!isOneOf(rawPackageVisibility(rawSkill), architecturePackageVisibilityScopes)) {
      pushIssue(errors, "ARCHITECTURE_PACKAGE_VISIBILITY_INVALID", "Package visibility is invalid.", `${path}.packageVisibility`);
    }
    validateOptionalStringField(rawSkill.title, errors, `${path}.title`, "Skill title");
    validateOptionalStringField(rawSkill.summary, errors, `${path}.summary`, "Skill summary");
    if (typeof rawSkill.title === "string" && rawSkill.title.length > 160) pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Skill titles may contain at most 160 characters.", `${path}.title`);
    if (typeof rawSkill.summary === "string" && rawSkill.summary.length > 500) pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Skill summaries may contain at most 500 characters.", `${path}.summary`);
    if (rawSkill.tags !== undefined && (!Array.isArray(rawSkill.tags) || rawSkill.tags.length > 50 || rawSkill.tags.some((tag) => typeof tag !== "string" || tag.length > 64))) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Skill tags must contain at most 50 strings of 64 characters.", `${path}.tags`);
    }
    validateMetadata(rawSkill.metadata, errors, `${path}.metadata`);
  }

  const nodesInput = input.nodes;
  const nodes = Array.isArray(nodesInput) ? nodesInput : [];
  if (!Array.isArray(nodesInput) || nodes.length === 0) {
    pushIssue(errors, "ARCHITECTURE_NODES_REQUIRED", "At least one architecture node is required.", "nodes");
  }
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const [index, rawNode] of nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!isRecord(rawNode)) {
      pushIssue(errors, "ARCHITECTURE_NODE_ID_INVALID", "Architecture node must be an object.", path);
      continue;
    }
    const nodeId = rawNode.id;
    if (!validateStringField(nodeId, errors, "ARCHITECTURE_NODE_ID_INVALID", "Node id is required.", `${path}.id`)) {
      // no-op
    } else {
      if (!identifierPattern.test(nodeId)) pushIssue(errors, "ARCHITECTURE_NODE_ID_INVALID", "Node id contains unsupported characters.", `${path}.id`);
      if (nodeIds.has(nodeId)) pushIssue(errors, "ARCHITECTURE_DUPLICATE_NODE_ID", "Node ids must be unique.", `${path}.id`);
      nodeIds.add(nodeId);
      nodeById.set(nodeId, rawNode);
    }
    if (!isOneOf(rawNode.kind, architectureNodeKinds)) {
      pushIssue(errors, "ARCHITECTURE_NODE_KIND_INVALID", "Node kind must be router or leaf.", `${path}.kind`);
    }
    if (!validateStringField(rawNode.label, errors, "ARCHITECTURE_NODE_LABEL_REQUIRED", "Node label is required.", `${path}.label`)) {
      // no-op
    } else if (rawNode.label.length > 160) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Node labels may contain at most 160 characters.", `${path}.label`);
    }
    if (rawNode.kind === "leaf" && !validateStringField(rawNode.skillRefId, errors, "ARCHITECTURE_NODE_SKILL_REQUIRED", "Leaf nodes require a skill reference.", `${path}.skillRefId`)) {
      // no-op
    }
    if (rawNode.kind !== "leaf") validateOptionalStringField(rawNode.skillRefId, errors, `${path}.skillRefId`, "Node skill reference");
    if (typeof rawNode.skillRefId === "string" && !skillIds.has(rawNode.skillRefId)) {
      pushIssue(errors, "ARCHITECTURE_NODE_SKILL_UNKNOWN", "Node skill reference does not exist in skills.", `${path}.skillRefId`);
    }
    validateMetadata(rawNode.metadata, errors, `${path}.metadata`);
  }

  const edgesInput = input.edges;
  const edges = Array.isArray(edgesInput) ? edgesInput : [];
  if (!Array.isArray(edgesInput)) pushIssue(errors, "ARCHITECTURE_EDGES_REQUIRED", "Edges must be an array.", "edges");
  const edgeKeys = new Set<string>();
  const parentByNode = new Map<string, string>();
  const adjacency = new Map<string, string[]>();
  for (const [index, rawEdge] of edges.entries()) {
    const path = `edges[${index}]`;
    if (!isRecord(rawEdge) || typeof rawEdge.from !== "string" || typeof rawEdge.to !== "string" || !isOneOf(rawEdge.kind, architectureEdgeKinds)) {
      pushIssue(errors, "ARCHITECTURE_EDGE_INVALID", "Edge must contain valid from, to, and kind fields.", path);
      continue;
    }
    const key = `${rawEdge.from}\u0000${rawEdge.to}\u0000${rawEdge.kind}`;
    if (edgeKeys.has(key)) pushIssue(errors, "ARCHITECTURE_EDGE_DUPLICATE", "Edges must be unique.", path);
    edgeKeys.add(key);
    if (!nodeIds.has(rawEdge.from) || !nodeIds.has(rawEdge.to) || rawEdge.from === rawEdge.to) {
      pushIssue(errors, "ARCHITECTURE_EDGE_INVALID", "Edge endpoints must be distinct known nodes.", path);
      continue;
    }
    const source = nodeById.get(rawEdge.from);
    const target = nodeById.get(rawEdge.to);
    if (source?.kind !== "router") {
      pushIssue(errors, "ARCHITECTURE_EDGE_SOURCE_NOT_ROUTER", "Only routers can route or contain child nodes.", `${path}.from`);
    }
    if (rawEdge.kind === "contains" && target?.kind !== "router") {
      pushIssue(errors, "ARCHITECTURE_EDGE_TARGET_NOT_ROUTER", "Contains edges must target routers.", `${path}.to`);
    }
    if (rawEdge.kind === "routes" && target?.kind !== "leaf") {
      pushIssue(errors, "ARCHITECTURE_EDGE_TARGET_NOT_LEAF", "Routes edges must target leaf nodes.", `${path}.to`);
    }
    const parent = parentByNode.get(rawEdge.to);
    if (parent !== undefined && parent !== rawEdge.from) {
      pushIssue(errors, "ARCHITECTURE_NODE_MULTIPLE_PARENTS", "A topology node can have only one parent.", `${path}.to`);
    } else {
      parentByNode.set(rawEdge.to, rawEdge.from);
    }
    const children = adjacency.get(rawEdge.from) ?? [];
    children.push(rawEdge.to);
    adjacency.set(rawEdge.from, children);
    validateMetadata(rawEdge.metadata, errors, `${path}.metadata`);
  }

  const entryNodeIdsInput = input.entryNodeIds;
  const entryNodeIds = Array.isArray(entryNodeIdsInput) ? entryNodeIdsInput : [];
  if (!Array.isArray(entryNodeIdsInput) || entryNodeIds.length === 0) {
    pushIssue(errors, "ARCHITECTURE_ENTRY_REQUIRED", "At least one topology entry node is required.", "entryNodeIds");
  }
  for (const [index, entryId] of entryNodeIds.entries()) {
    if (typeof entryId !== "string" || !nodeIds.has(entryId)) {
      pushIssue(errors, "ARCHITECTURE_ENTRY_UNKNOWN", "Entry node does not exist.", `entryNodeIds[${index}]`);
    }
  }

  // Detect topology cycles in stable node order.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      pushIssue(errors, "ARCHITECTURE_CYCLE", "Architecture topology must be acyclic.", `nodes.${nodeId}`);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of [...nodeIds].sort()) visit(nodeId);

  const reachable = new Set<string>();
  const markReachable = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) markReachable(childId);
  };
  for (const entryId of entryNodeIds) if (typeof entryId === "string" && nodeIds.has(entryId)) markReachable(entryId);
  for (const nodeId of [...nodeIds].sort()) {
    if (!reachable.has(nodeId)) pushIssue(errors, "ARCHITECTURE_ORPHAN_NODE", "Every node must be reachable from an entry node.", `nodes.${nodeId}`);
  }
  const topologyDepthById = new Map<string, number>();
  const measureDepth = (nodeId: string, depth: number): void => {
    if (depth > architectureLimits.topologyDepth) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Architecture topology may be at most ${architectureLimits.topologyDepth} levels deep.`, `nodes.${nodeId}`);
      return;
    }
    if ((topologyDepthById.get(nodeId) ?? -1) >= depth) return;
    topologyDepthById.set(nodeId, depth);
    for (const childId of adjacency.get(nodeId) ?? []) measureDepth(childId, depth + 1);
  };
  for (const entryId of entryNodeIds) if (typeof entryId === "string" && nodeIds.has(entryId)) measureDepth(entryId, 1);

  const profileInput = input.profiles;
  const profiles = Array.isArray(profileInput) ? profileInput : [];
  if (!Array.isArray(profileInput) || profiles.length === 0) {
    pushIssue(errors, "ARCHITECTURE_PROFILES_REQUIRED", "At least one profile is required.", "profiles");
  }
  const profileIds = new Set<string>();
  for (const [index, rawProfile] of profiles.entries()) {
    const path = `profiles[${index}]`;
    if (!isRecord(rawProfile)) {
      pushIssue(errors, "ARCHITECTURE_PROFILE_INVALID", "Profile must be an object.", path);
      continue;
    }
    if (!validateStringField(rawProfile.id, errors, "ARCHITECTURE_PROFILE_INVALID", "Profile id is required.", `${path}.id`)) {
      // no-op
    } else {
      if (!identifierPattern.test(rawProfile.id)) pushIssue(errors, "ARCHITECTURE_PROFILE_INVALID", "Profile id contains unsupported characters.", `${path}.id`);
      if (profileIds.has(rawProfile.id)) pushIssue(errors, "ARCHITECTURE_DUPLICATE_PROFILE_ID", "Profile ids must be unique.", `${path}.id`);
      profileIds.add(rawProfile.id);
    }
    if (validateStringField(rawProfile.name, errors, "ARCHITECTURE_PROFILE_INVALID", "Profile name is required.", `${path}.name`) && rawProfile.name.length > 120) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Profile names may contain at most 120 characters.", `${path}.name`);
    }
    if (rawProfile.defaultExposure !== "disabled") {
      pushIssue(errors, "ARCHITECTURE_DEFAULT_EXPOSURE_INVALID", "Profiles must fail closed with disabled default exposure.", `${path}.defaultExposure`);
    }
    if (!isRecord(rawProfile.subject) || !isOneOf(rawProfile.subject.type, architectureSubjectKinds) || typeof rawProfile.subject.id !== "string" || !identifierPattern.test(rawProfile.subject.id)) {
      pushIssue(errors, "ARCHITECTURE_PROFILE_INVALID", "Profile subject must identify a user or team.", `${path}.subject`);
    }
    const bindings = Array.isArray(rawProfile.bindings) ? rawProfile.bindings : [];
    validateCollectionLimit(rawProfile.bindings, architectureLimits.bindingsPerProfile, errors, `${path}.bindings`);
    if (bindings.length > architectureLimits.bindingsPerProfile) continue;
    if (!Array.isArray(rawProfile.bindings)) pushIssue(errors, "ARCHITECTURE_PROFILE_INVALID", "Profile bindings must be an array.", `${path}.bindings`);
    const bindingKeys = new Set<string>();
    for (const [bindingIndex, rawBinding] of bindings.entries()) {
      const bindingPath = `${path}.bindings[${bindingIndex}]`;
      if (!isRecord(rawBinding) || typeof rawBinding.nodeId !== "string" || typeof rawBinding.enabled !== "boolean") {
        pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_INVALID", "Profile binding must identify a node and enabled state.", bindingPath);
        continue;
      }
      if (!nodeIds.has(rawBinding.nodeId)) pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_UNKNOWN_NODE", "Profile binding node does not exist.", `${bindingPath}.nodeId`);
      const envIds = rawBinding.environmentIds;
      if (envIds !== undefined && (!Array.isArray(envIds) || envIds.some((value) => typeof value !== "string"))) {
        pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_INVALID", "Binding environmentIds must be an array of strings.", `${bindingPath}.environmentIds`);
      }
      const normalizedEnvironmentIds = Array.isArray(envIds) ? [...new Set(envIds as string[])].sort() : ["*"];
      const bindingKey = `${rawBinding.nodeId}\u0000${normalizedEnvironmentIds.join(",")}`;
      if (bindingKeys.has(bindingKey)) pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_DUPLICATE", "Profile bindings must be unique per node/environment scope.", bindingPath);
      bindingKeys.add(bindingKey);
      const exposure = rawRuntimeExposure(rawBinding);
      if (!isOneOf(exposure, runtimeExposureModes)) {
        pushIssue(errors, "ARCHITECTURE_RUNTIME_EXPOSURE_INVALID", "Runtime exposure is invalid.", `${bindingPath}.runtimeExposure`);
      } else if ((rawBinding.enabled === false && exposure !== "disabled") || (rawBinding.enabled === true && exposure === "disabled")) {
        pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_INVALID", "Enabled bindings must expose a router or leaf, and disabled bindings must use disabled exposure.", bindingPath);
      } else if (rawBinding.enabled === true && (exposure === "router" || exposure === "leaf") && nodeById.get(rawBinding.nodeId)?.kind !== exposure) {
        pushIssue(errors, "ARCHITECTURE_PROFILE_BINDING_INVALID", "Enabled binding runtime exposure must match the node kind.", `${bindingPath}.runtimeExposure`);
      }
      validateMetadata(rawBinding.metadata, errors, `${bindingPath}.metadata`);
    }
    validateMetadata(rawProfile.metadata, errors, `${path}.metadata`);
  }

  const environmentInput = input.environments;
  const environments = Array.isArray(environmentInput) ? environmentInput : [];
  if (!Array.isArray(environmentInput) || environments.length === 0) {
    pushIssue(errors, "ARCHITECTURE_ENVIRONMENTS_REQUIRED", "At least one environment is required.", "environments");
  }
  const environmentIds = new Set<string>();
  const environmentById = new Map<string, Record<string, unknown>>();
  for (const [index, rawEnvironment] of environments.entries()) {
    const path = `environments[${index}]`;
    if (!isRecord(rawEnvironment)) {
      pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_INVALID", "Environment must be an object.", path);
      continue;
    }
    if (!validateStringField(rawEnvironment.id, errors, "ARCHITECTURE_ENVIRONMENT_INVALID", "Environment id is required.", `${path}.id`)) {
      // no-op
    } else {
      if (!identifierPattern.test(rawEnvironment.id)) pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_INVALID", "Environment id contains unsupported characters.", `${path}.id`);
      if (environmentIds.has(rawEnvironment.id)) pushIssue(errors, "ARCHITECTURE_DUPLICATE_ENVIRONMENT_ID", "Environment ids must be unique.", `${path}.id`);
      environmentIds.add(rawEnvironment.id);
      environmentById.set(rawEnvironment.id, rawEnvironment);
    }
    if (validateStringField(rawEnvironment.name, errors, "ARCHITECTURE_ENVIRONMENT_INVALID", "Environment name is required.", `${path}.name`) && rawEnvironment.name.length > 120) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Environment names may contain at most 120 characters.", `${path}.name`);
    }
    if (!isOneOf(rawEnvironment.kind, architectureEnvironmentKinds)) pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_INVALID", "Environment kind is invalid.", `${path}.kind`);
    if (typeof rawEnvironment.profileId !== "string" || !profileIds.has(rawEnvironment.profileId)) {
      pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_UNKNOWN_PROFILE", "Environment profile does not exist.", `${path}.profileId`);
    }
    if (rawEnvironment.parentId !== undefined && rawEnvironment.parentId !== null && (typeof rawEnvironment.parentId !== "string" || !environmentIds.has(rawEnvironment.parentId))) {
      // A parent later in the input is checked by the second pass below.
      if (typeof rawEnvironment.parentId !== "string") pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_UNKNOWN_PARENT", "Environment parent does not exist.", `${path}.parentId`);
    }
    validateMetadata(rawEnvironment.metadata, errors, `${path}.metadata`);
  }
  for (const [index, rawEnvironment] of environments.entries()) {
    if (!isRecord(rawEnvironment) || rawEnvironment.parentId === undefined || rawEnvironment.parentId === null) continue;
    if (typeof rawEnvironment.parentId !== "string" || !environmentIds.has(rawEnvironment.parentId)) {
      pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_UNKNOWN_PARENT", "Environment parent does not exist.", `environments[${index}].parentId`);
    }
  }
  for (const environmentId of [...environmentIds].sort()) {
    const chain = new Set<string>();
    let current: string | null = environmentId;
    while (current !== null) {
      if (chain.has(current)) {
        pushIssue(errors, "ARCHITECTURE_ENVIRONMENT_PARENT_CYCLE", "Environment inheritance must be acyclic.", `environments.${environmentId}`);
        break;
      }
      chain.add(current);
      const parentValue: unknown = environmentById.get(current)?.parentId;
      current = typeof parentValue === "string" && environmentIds.has(parentValue) ? parentValue : null;
    }
  }
  for (const [profileIndex, rawProfile] of profiles.entries()) {
    if (!isRecord(rawProfile) || !Array.isArray(rawProfile.bindings)) continue;
    for (const [bindingIndex, rawBinding] of rawProfile.bindings.entries()) {
      if (!isRecord(rawBinding) || !Array.isArray(rawBinding.environmentIds)) continue;
      for (const [environmentIndex, environmentId] of rawBinding.environmentIds.entries()) {
        if (typeof environmentId === "string" && !environmentIds.has(environmentId)) {
          pushIssue(
            errors,
            "ARCHITECTURE_PROFILE_BINDING_UNKNOWN_ENVIRONMENT",
            "Profile binding environment does not exist.",
            `profiles[${profileIndex}].bindings[${bindingIndex}].environmentIds[${environmentIndex}]`,
          );
        }
      }
    }
  }

  if (isRecord(pattern) && isOneOf(pattern.id, architecturePatternIds)) {
    const routerCount = nodes.filter((node): node is Record<string, unknown> => isRecord(node) && node.kind === "router").length;
    const routeEdges = edges.filter((edge): edge is Record<string, unknown> => isRecord(edge) && edge.kind === "routes");
    const containsEdges = edges.filter((edge): edge is Record<string, unknown> => isRecord(edge) && edge.kind === "contains");
    const entryKinds = entryNodeIds.map((entryId) => nodeById.get(entryId)?.kind);
    const hasNestedRouterLeafPath = containsEdges.some((edge) => {
      if (typeof edge.to !== "string") return false;
      const queue = [edge.to];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const candidate of edges) {
          if (!isRecord(candidate) || candidate.from !== current || typeof candidate.to !== "string") continue;
          if (candidate.kind === "routes" && nodeById.get(candidate.to)?.kind === "leaf") return true;
          if (nodeById.get(candidate.to)?.kind === "router") queue.push(candidate.to);
        }
      }
      return false;
    });
    if (pattern.id === "flat" && (routerCount !== 0 || edges.length !== 0 || nodes.some((node) => isRecord(node) && node.kind !== "leaf"))) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_SHAPE_INVALID", "Flat patterns contain only leaf nodes and no edges.", "pattern.id");
    }
    if (pattern.id === "domain-router" && (routerCount !== 1 || containsEdges.length !== 0 || routeEdges.length !== nodes.length - routerCount || entryNodeIds.length !== 1 || entryKinds[0] !== "router")) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_SHAPE_INVALID", "Domain-router patterns contain one router with leaf routes.", "pattern.id");
    }
    if (pattern.id === "multi-level-router" && (routerCount < 2 || !hasNestedRouterLeafPath || entryNodeIds.length !== 1 || entryKinds[0] !== "router")) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_SHAPE_INVALID", "Multi-level-router patterns require nested routers and leaf routes.", "pattern.id");
    }
  }

  validateMetadata(input.metadata, errors, "metadata");
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: normalizeArchitectureSpec(input as unknown as ArchitectureSpecV1) };
}

/** Validate and return the normalized revision, or throw a stable error. */
export function assertValidArchitectureSpec(input: unknown): ArchitectureSpecV1 {
  const result = validateArchitectureSpec(input);
  if (!result.valid) throw new ArchitectureValidationError(result.errors);
  return result.value;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Normalize identity-bearing arrays before hashing or compiling. */
export function normalizeArchitectureSpec(input: ArchitectureSpecV1): ArchitectureSpecV1 {
  const raw = cloneRecord(input as ArchitectureSpecV1) as unknown as Record<string, unknown>;
  const patternRaw = isRecord(raw.pattern) ? raw.pattern : {};
  const normalized: ArchitectureSpecV1 = {
    schemaVersion: architectureSchemaVersion,
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    pattern: {
      id: String(patternRaw.id ?? "flat") as ArchitecturePatternId,
      version: architectureSchemaVersion,
    },
    skills: (Array.isArray(raw.skills) ? raw.skills : []).map((skill) => normalizeSkillRef(isRecord(skill) ? skill : {})).sort((left, right) => left.id.localeCompare(right.id)),
    nodes: [],
    edges: [],
    entryNodeIds: (Array.isArray(raw.entryNodeIds) ? raw.entryNodeIds : []).map(String).sort(),
    profiles: [],
    environments: [],
  };
  if (typeof raw.description === "string") normalized.description = raw.description;
  const metadata = normalizeMetadata(raw.metadata);
  if (metadata !== undefined) normalized.metadata = metadata;

  normalized.nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).map((node): ArchitectureNode => {
    const value = isRecord(node) ? node : {};
    const result = {
      id: String(value.id ?? ""),
      kind: String(value.kind ?? "leaf") as ArchitectureNodeKind,
      label: String(value.label ?? ""),
    } as ArchitectureNode;
    if (typeof value.skillRefId === "string") result.skillRefId = value.skillRefId;
    const nodeMetadata = normalizeMetadata(value.metadata);
    if (nodeMetadata !== undefined) result.metadata = nodeMetadata;
    return result;
  }).sort((left, right) => left.id.localeCompare(right.id));
  normalized.edges = (Array.isArray(raw.edges) ? raw.edges : []).map((edge): ArchitectureEdge => {
    const value = isRecord(edge) ? edge : {};
    const result: ArchitectureEdge = {
      from: String(value.from ?? ""),
      to: String(value.to ?? ""),
      kind: String(value.kind ?? "routes") as ArchitectureEdgeKind,
    };
    const metadataEdge = normalizeMetadata(value.metadata);
    if (metadataEdge !== undefined) result.metadata = metadataEdge;
    return result;
  }).sort((left, right) => `${left.from}\u0000${left.to}\u0000${left.kind}`.localeCompare(`${right.from}\u0000${right.to}\u0000${right.kind}`));
  normalized.profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).map((profile): ArchitectureProfile => {
    const value = isRecord(profile) ? profile : {};
    const subject = isRecord(value.subject) ? value.subject : {};
    const result: ArchitectureProfile = {
      id: String(value.id ?? ""),
      name: String(value.name ?? ""),
      subject: {
        type: String(subject.type ?? "user") as ArchitectureSubjectKind,
        id: String(subject.id ?? ""),
      },
      defaultExposure: "disabled",
      bindings: [],
    };
    const profileMetadata = normalizeMetadata(value.metadata);
    if (profileMetadata !== undefined) result.metadata = profileMetadata;
    result.bindings = (Array.isArray(value.bindings) ? value.bindings : []).map((binding): ArchitectureProfileBinding => {
      const item = isRecord(binding) ? binding : {};
      const bindingResult: ArchitectureProfileBinding = {
        nodeId: String(item.nodeId ?? ""),
        enabled: item.enabled === true,
        runtimeExposure: String(rawRuntimeExposure(item) ?? (item.enabled === true ? "leaf" : "disabled")) as RuntimeExposureMode,
      };
      if (Array.isArray(item.environmentIds)) bindingResult.environmentIds = item.environmentIds.map(String).sort();
      const bindingMetadata = normalizeMetadata(item.metadata);
      if (bindingMetadata !== undefined) bindingResult.metadata = bindingMetadata;
      return bindingResult;
    }).sort((left, right) => `${left.nodeId}\u0000${(left.environmentIds ?? ["*"]).join(",")}`.localeCompare(`${right.nodeId}\u0000${(right.environmentIds ?? ["*"]).join(",")}`));
    return result;
  }).sort((left, right) => left.id.localeCompare(right.id));
  normalized.environments = (Array.isArray(raw.environments) ? raw.environments : []).map((environment): ArchitectureEnvironment => {
    const value = isRecord(environment) ? environment : {};
    const result: ArchitectureEnvironment = {
      id: String(value.id ?? ""),
      name: String(value.name ?? ""),
      kind: String(value.kind ?? "personal") as ArchitectureEnvironmentKind,
      profileId: String(value.profileId ?? ""),
    };
    if (typeof value.parentId === "string" || value.parentId === null) result.parentId = value.parentId;
    const environmentMetadata = normalizeMetadata(value.metadata);
    if (environmentMetadata !== undefined) result.metadata = environmentMetadata;
    return result;
  }).sort((left, right) => left.id.localeCompare(right.id));
  return normalized;
}

/** RFC 8785-style object-key canonicalization for JSON-safe values. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalizeJson(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("Canonical JSON supports only JSON values.");
}

export function canonicalArchitectureJson(input: ArchitectureSpecV1): string {
  return canonicalizeJson(assertValidArchitectureSpec(input));
}

// SHA-256 is kept local so this shared package remains browser-compatible and dependency-free.
const sha256RoundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9) + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + sha256RoundConstants[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function architectureDigest(input: ArchitectureSpecV1): string {
  return sha256Hex(canonicalArchitectureJson(input));
}

export const digestArchitecture = architectureDigest;
export const computeArchitectureDigest = architectureDigest;

export interface ArchitectureFactorySkillInput extends Omit<Partial<ArchitectureSkillRef>, "id" | "slug" | "version" | "digest" | "packageVisibility"> {
  id?: string;
  slug: string;
  version?: string;
  digest?: string;
  packageVisibility?: ArchitecturePackageVisibility;
  /** Compatibility alias for packageVisibility. */
  visibility?: ArchitecturePackageVisibility;
  domainId?: string;
}

export interface ArchitectureDomainInput {
  id: string;
  label?: string;
  skillIds?: string[];
}

export interface ArchitectureFactoryInput {
  id: string;
  name: string;
  description?: string;
  skills: ArchitectureFactorySkillInput[];
  domains?: ArchitectureDomainInput[];
  profile?: {
    id?: string;
    name?: string;
    subject?: { type: ArchitectureSubjectKind; id: string };
  };
  environment?: {
    id?: string;
    name?: string;
    kind?: ArchitectureEnvironmentKind;
  };
  metadata?: ArchitectureMetadata;
}

function factoryDigest(skill: ArchitectureFactorySkillInput, version: string, title: string): string {
  return sha256Hex(canonicalizeJson({ slug: skill.slug, title, version, summary: skill.summary ?? "" }));
}

function buildFactorySpec(input: ArchitectureFactoryInput, pattern: ArchitecturePatternId, nodes: ArchitectureNode[], edges: ArchitectureEdge[], entryNodeIds: string[]): ArchitectureSpecV1 {
  const profileId = input.profile?.id ?? `${input.id}-profile`;
  const environmentId = input.environment?.id ?? `${input.id}-personal`;
  const profile: ArchitectureProfile = {
    id: profileId,
    name: input.profile?.name ?? "Personal profile",
    subject: input.profile?.subject ?? { type: "user", id: "local-user" },
    defaultExposure: "disabled",
    bindings: nodes.map((node) => ({
      nodeId: node.id,
      enabled: true,
      runtimeExposure: node.kind,
    })),
  };
  const environment: ArchitectureEnvironment = {
    id: environmentId,
    name: input.environment?.name ?? "Personal",
    kind: input.environment?.kind ?? "personal",
    profileId,
  };
  const spec: ArchitectureSpecV1 = {
    schemaVersion: architectureSchemaVersion,
    id: input.id,
    name: input.name,
    pattern: { id: pattern, version: architectureSchemaVersion },
    skills: input.skills.map((skill) => {
      const version = skill.version ?? "0.0.0";
      const title = skill.title ?? skill.slug;
      return {
        id: skill.id ?? skill.slug,
        slug: skill.slug,
        title,
        summary: skill.summary,
        version,
        digest: skill.digest ?? factoryDigest(skill, version, title),
        packageVisibility: skill.packageVisibility ?? skill.visibility ?? "private",
        tags: skill.tags,
        metadata: skill.metadata,
      };
    }),
    nodes,
    edges,
    entryNodeIds,
    profiles: [profile],
    environments: [environment],
    metadata: input.metadata,
  };
  if (input.description !== undefined) spec.description = input.description;
  return assertValidArchitectureSpec(spec);
}

export function createFlatArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const nodes: ArchitectureNode[] = input.skills.map((skill) => ({
    id: `leaf-${skill.id ?? skill.slug}`,
    kind: "leaf",
    label: skill.title ?? skill.slug,
    skillRefId: skill.id ?? skill.slug,
  }));
  return buildFactorySpec(input, "flat", nodes, [], nodes.map((node) => node.id));
}

export function createDomainRouterArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const router: ArchitectureRouterNode = { id: "router-root", kind: "router", label: input.name };
  const leaves: ArchitectureLeafNode[] = input.skills.map((skill) => ({
    id: `leaf-${skill.id ?? skill.slug}`,
    kind: "leaf",
    label: skill.title ?? skill.slug,
    skillRefId: skill.id ?? skill.slug,
  }));
  const edges = leaves.map((leaf): ArchitectureEdge => ({ from: router.id, to: leaf.id, kind: "routes" }));
  return buildFactorySpec(input, "domain-router", [router, ...leaves], edges, [router.id]);
}

function domainsForInput(input: ArchitectureFactoryInput): ArchitectureDomainInput[] {
  if (input.domains && input.domains.length > 0) return input.domains;
  const domainIds = [...new Set(input.skills.map((skill) => skill.domainId ?? "general"))];
  return domainIds.map((id) => ({ id, label: id }));
}

export function createMultiLevelRouterArchitecture(input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  const root: ArchitectureRouterNode = { id: "router-root", kind: "router", label: input.name };
  const domains = domainsForInput(input);
  const nodes: ArchitectureNode[] = [root];
  const edges: ArchitectureEdge[] = [];
  for (const domain of domains) {
    const domainNode: ArchitectureRouterNode = { id: `router-${domain.id}`, kind: "router", label: domain.label ?? domain.id };
    nodes.push(domainNode);
    edges.push({ from: root.id, to: domainNode.id, kind: "contains" });
    const selectedSkills = input.skills.filter((skill) => {
      const skillId = skill.id ?? skill.slug;
      return (skill.domainId ?? "general") === domain.id || domain.skillIds?.includes(skillId) === true;
    });
    for (const skill of selectedSkills) {
      const leaf: ArchitectureLeafNode = {
        id: `leaf-${skill.id ?? skill.slug}`,
        kind: "leaf",
        label: skill.title ?? skill.slug,
        skillRefId: skill.id ?? skill.slug,
      };
      nodes.push(leaf);
      edges.push({ from: domainNode.id, to: leaf.id, kind: "routes" });
    }
  }
  return buildFactorySpec(input, "multi-level-router", nodes, edges, [root.id]);
}

export function createArchitectureFromPattern(pattern: ArchitecturePatternId, input: ArchitectureFactoryInput): ArchitectureSpecV1 {
  if (pattern === "flat") return createFlatArchitecture(input);
  if (pattern === "domain-router") return createDomainRouterArchitecture(input);
  return createMultiLevelRouterArchitecture(input);
}

export const createFlatPattern = createFlatArchitecture;
export const createDomainRouterPattern = createDomainRouterArchitecture;
export const createMultiLevelRouterPattern = createMultiLevelRouterArchitecture;
export const architecturePatternFactory = createArchitectureFromPattern;

function resolveCompileOptions(input: ArchitectureCompileOptions | AuthorizedRegistrySnapshot): ArchitectureCompileOptions {
  if (Array.isArray(input)) return { registry: input as AuthorizedRegistrySnapshot };
  return input as ArchitectureCompileOptions;
}

function selectEnvironment(spec: ArchitectureSpecV1, options: ArchitectureCompileOptions): ArchitectureEnvironment {
  const environment = options.environmentId === undefined
    ? (spec.environments.length === 1 ? spec.environments[0] : undefined)
    : spec.environments.find((candidate) => candidate.id === options.environmentId);
  if (!environment) throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_REQUIRED", "A valid environment must be selected before compilation.");
  return environment;
}

function selectProfile(spec: ArchitectureSpecV1, environment: ArchitectureEnvironment, options: ArchitectureCompileOptions): ArchitectureProfile {
  const profileId = options.profileId ?? environment.profileId;
  if (profileId !== environment.profileId) throw new ArchitectureCompileError("ARCHITECTURE_PROFILE_ENVIRONMENT_MISMATCH", "Selected profile is not bound to the selected environment.");
  const profile = spec.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new ArchitectureCompileError("ARCHITECTURE_PROFILE_REQUIRED", "A valid profile must be selected before compilation.");
  return profile;
}

function environmentAncestors(spec: ArchitectureSpecV1, environment: ArchitectureEnvironment): string[] {
  const byId = new Map(spec.environments.map((candidate) => [candidate.id, candidate]));
  const result = [environment.id];
  let current = environment;
  while (typeof current.parentId === "string") {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    result.push(parent.id);
    current = parent;
  }
  return result;
}

function bindingForNode(profile: ArchitectureProfile, environment: ArchitectureEnvironment, nodeId: string, spec: ArchitectureSpecV1): ArchitectureProfileBinding | undefined {
  const ancestorIds = environmentAncestors(spec, environment);
  const matching = profile.bindings.filter((binding) => binding.nodeId === nodeId && (
    binding.environmentIds === undefined || binding.environmentIds.some((id) => ancestorIds.includes(id))
  ));
  const specificity = (binding: ArchitectureProfileBinding): number => {
    if (binding.environmentIds === undefined) return Number.POSITIVE_INFINITY;
    return Math.min(...binding.environmentIds.map((id) => {
      const index = ancestorIds.indexOf(id);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    }));
  };
  const isDenied = (binding: ArchitectureProfileBinding): number => Number(!binding.enabled || binding.runtimeExposure === "disabled");
  const scopeKey = (binding: ArchitectureProfileBinding): string => (binding.environmentIds ?? []).slice().sort().join(",");
  // Denials always win, then the closest environment scope wins. The final
  // lexical key makes overlapping rules deterministic even when their scopes
  // have the same specificity. Missing rules remain disabled by the caller.
  return matching.sort((left, right) => isDenied(right) - isDenied(left)
    || specificity(left) - specificity(right)
    || scopeKey(left).localeCompare(scopeKey(right))
    || Number(right.enabled) - Number(left.enabled)
    || left.runtimeExposure.localeCompare(right.runtimeExposure))[0];
}

function registrySkillFor(ref: ArchitectureSkillRef, snapshot: AuthorizedRegistrySnapshot): AuthorizedRegistrySkillSnapshot {
  const candidate = snapshot.find((item) => (item.id === ref.id || item.skillRefId === ref.id || item.slug === ref.slug) && item.version === ref.version && item.digest === ref.digest);
  if (!candidate) throw new ArchitectureCompileError("ARCHITECTURE_REGISTRY_SNAPSHOT_MISSING", `Authorized registry metadata for '${ref.id}' at ${ref.version} is unavailable.`);
  return candidate;
}

function nodeAncestors(spec: ArchitectureSpecV1, nodeId: string): string[] {
  const parentByNode = new Map<string, string>();
  for (const edge of spec.edges) parentByNode.set(edge.to, edge.from);
  const result: string[] = [];
  let current = parentByNode.get(nodeId);
  while (current) {
    result.push(current);
    current = parentByNode.get(current);
  }
  return result;
}

export function compileArchitecture(specInput: ArchitectureSpecV1, input: ArchitectureCompileOptions | AuthorizedRegistrySnapshot): CompiledArchitecture {
  const spec = assertValidArchitectureSpec(specInput);
  const options = resolveCompileOptions(input);
  const environment = selectEnvironment(spec, options);
  const profile = selectProfile(spec, environment, options);
  const skillById = new Map(spec.skills.map((skill) => [skill.id, skill]));
  const disabledNodeIds: string[] = [];
  const exposedBindings = new Map<string, ArchitectureProfileBinding>();
  for (const node of spec.nodes) {
    const binding = bindingForNode(profile, environment, node.id, spec);
    if (!binding || !binding.enabled || binding.runtimeExposure === "disabled") disabledNodeIds.push(node.id);
    else exposedBindings.set(node.id, binding);
  }
  const activeNodeIds = new Set<string>();
  for (const node of spec.nodes) {
    if (!exposedBindings.has(node.id)) continue;
    const ancestors = nodeAncestors(spec, node.id);
    if (ancestors.every((ancestorId) => exposedBindings.has(ancestorId))) activeNodeIds.add(node.id);
    else disabledNodeIds.push(node.id);
  }
  const allNodes = spec.nodes.map((node) => {
    const skill = node.skillRefId ? skillById.get(node.skillRefId) : undefined;
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.skillRefId ? { skillRefId: node.skillRefId } : {}),
      ...(skill ? { slug: skill.slug } : {}),
    };
  });
  const edges = spec.edges
    .filter((edge) => activeNodeIds.has(edge.from) && activeNodeIds.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind }))
    .sort((left, right) => `${left.from}\u0000${left.to}\u0000${left.kind}`.localeCompare(`${right.from}\u0000${right.to}\u0000${right.kind}`));
  const usedSkillIds = new Set<string>();
  const nodes: CompiledArchitectureNode[] = spec.nodes
    .filter((node) => activeNodeIds.has(node.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => {
      if (node.skillRefId) usedSkillIds.add(node.skillRefId);
      const binding = exposedBindings.get(node.id);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        ...(node.skillRefId ? { skillRefId: node.skillRefId } : {}),
        runtimeExposure: binding?.runtimeExposure === "router" || binding?.runtimeExposure === "leaf" ? binding.runtimeExposure : node.kind,
        childNodeIds: edges.filter((edge) => edge.from === node.id).map((edge) => edge.to),
      };
    });
  const skills = [...usedSkillIds].sort().map((skillRefId) => {
    const ref = skillById.get(skillRefId);
    if (!ref) throw new ArchitectureCompileError("ARCHITECTURE_NODE_SKILL_UNKNOWN", `Skill reference '${skillRefId}' is not available.`);
    const snapshot = registrySkillFor(ref, options.registry);
    const packageVisibility = snapshot.packageVisibility ?? snapshot.visibility ?? ref.packageVisibility;
    return {
      skillRefId: ref.id,
      slug: snapshot.slug,
      title: snapshot.title ?? ref.title,
      summary: snapshot.summary ?? ref.summary,
      version: snapshot.version,
      digest: snapshot.digest,
      packageVisibility,
      tags: snapshot.tags ?? ref.tags,
      metadata: snapshot.metadata ?? ref.metadata,
    };
  });
  const routers: CompiledRouterConfiguration[] = nodes.filter((node) => node.kind === "router").map((node) => {
    const routes = edges.filter((edge) => edge.from === node.id);
    const configuration = { nodeId: node.id, childNodeIds: node.childNodeIds, routes };
    return { ...configuration, digest: sha256Hex(canonicalizeJson(configuration)) };
  });
  const uniqueDisabledNodeIds = [...new Set(disabledNodeIds)].sort();
  return {
    schemaVersion: architectureSchemaVersion,
    architectureId: spec.id,
    revisionDigest: architectureDigest(spec),
    pattern: spec.pattern,
    profileId: profile.id,
    environmentId: environment.id,
    nodes,
    allNodes,
    disabledNodeIds: uniqueDisabledNodeIds,
    edges,
    skills,
    routers,
  };
}

export function tryCompileArchitecture(spec: ArchitectureSpecV1, input: ArchitectureCompileOptions | AuthorizedRegistrySnapshot): { ok: true; value: CompiledArchitecture } | { ok: false; error: ArchitectureCompileError } {
  try {
    return { ok: true, value: compileArchitecture(spec, input) };
  } catch (error) {
    if (error instanceof ArchitectureCompileError) return { ok: false, error };
    throw error;
  }
}

type ObservedArchitectureNodeSource = "skill" | "router" | "generic";

interface ObservedArchitectureNodeRecord extends ObservedArchitectureNode {
  source: ObservedArchitectureNodeSource;
}

const observedIdentityKeys = ["nodeId", "skillRefId", "slug"] as const;

function observedDesiredNodeIds(compiled: CompiledArchitecture, node: ObservedArchitectureNodeRecord): Set<string> {
  const candidateSets: Set<string>[] = [];
  if (node.nodeId !== undefined && compiled.allNodes.some((candidate) => candidate.id === node.nodeId)) candidateSets.push(new Set([node.nodeId]));
  if (node.skillRefId !== undefined) {
    const ids = compiled.allNodes.filter((candidate) => candidate.skillRefId === node.skillRefId).map((candidate) => candidate.id);
    if (ids.length > 0) candidateSets.push(new Set(ids));
  }
  if (node.slug !== undefined) {
    const ids = compiled.allNodes.filter((candidate) => candidate.slug === node.slug).map((candidate) => candidate.id);
    if (ids.length > 0) candidateSets.push(new Set(ids));
  }
  return candidateSets.length === 0 ? new Set() : new Set([...candidateSets[0]].filter((id) => candidateSets.slice(1).every((set) => set.has(id))));
}

function observationsCanMerge(left: ObservedArchitectureNodeRecord, right: ObservedArchitectureNodeRecord, compiled?: CompiledArchitecture): boolean {
  if (left.source === right.source || left.source === "generic" || right.source === "generic") return false;
  const identitiesCompatible = observedIdentityKeys.every((key) => left[key] === undefined || right[key] === undefined || left[key] === right[key]);
  if (!identitiesCompatible) return false;
  const sharedIdentity = observedIdentityKeys.some((key) => left[key] !== undefined && right[key] !== undefined && left[key] === right[key]);
  if (sharedIdentity) return true;
  if (!compiled) return false;
  const leftIds = observedDesiredNodeIds(compiled, left);
  const rightIds = observedDesiredNodeIds(compiled, right);
  return leftIds.size === 1 && rightIds.size === 1 && [...leftIds][0] === [...rightIds][0];
}

function mergeObservedArchitectureNodes(left: ObservedArchitectureNodeRecord, right: ObservedArchitectureNodeRecord): ObservedArchitectureNodeRecord {
  const result: ObservedArchitectureNodeRecord = { ...left, ...right, source: left.source === "skill" || right.source === "skill" ? "skill" : "router" };
  for (const key of observedIdentityKeys) {
    if (left[key] !== undefined) result[key] = left[key];
  }
  if (left.kind !== undefined && right.kind === undefined) result.kind = left.kind;
  if (left.version !== undefined) result.version = left.version;
  if (left.digest !== undefined) result.digest = left.digest;
  if (left.runtimeExposure !== undefined) result.runtimeExposure = left.runtimeExposure;
  const mergeBoolean = (leftValue: boolean | undefined, rightValue: boolean | undefined): boolean | undefined => {
    if (leftValue === false || rightValue === false) return false;
    if (leftValue === true || rightValue === true) return true;
    return undefined;
  };
  const enabled = mergeBoolean(left.enabled, right.enabled);
  if (enabled !== undefined) result.enabled = enabled;
  const managed = mergeBoolean(left.managed, right.managed);
  if (managed !== undefined) result.managed = managed;
  const supported = mergeBoolean(left.supported, right.supported);
  if (supported !== undefined) result.supported = supported;
  const configured = mergeBoolean(left.configured, right.configured);
  if (configured !== undefined) result.configured = configured;
  if (left.metadata !== undefined) result.metadata = left.metadata;
  return result;
}

function observedSkillNodes(observed: ObservedArchitectureState, compiled?: CompiledArchitecture): ObservedArchitectureNodeRecord[] {
  const result: ObservedArchitectureNodeRecord[] = [];
  for (const skill of observed.skills ?? []) result.push({ ...skill, nodeId: skill.nodeId, source: "skill" });
  for (const router of observed.routers ?? []) result.push({ ...router, kind: "router", source: "router" });
  for (const node of observed.nodes ?? []) result.push({ ...node, source: "generic" });
  const merged: ObservedArchitectureNodeRecord[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < result.length; index += 1) {
    if (consumed.has(index)) continue;
    const current = result[index];
    if (current.source !== "skill" && current.source !== "router") {
      merged.push(current);
      continue;
    }
    const candidates = result
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => candidateIndex !== index && !consumed.has(candidateIndex) && observationsCanMerge(current, candidate, compiled));
    if (candidates.length === 1) {
      const { candidate, candidateIndex } = candidates[0];
      merged.push(mergeObservedArchitectureNodes(current, candidate));
      consumed.add(candidateIndex);
    } else {
      merged.push(current);
    }
    consumed.add(index);
  }
  return merged;
}

function compareVersions(left: string, right: string): number | undefined {
  const parse = (value: string): { core: [string, string, string]; prerelease?: string[] } | undefined => {
    const match = value.match(semverPattern);
    if (!match || (match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0")) ?? false)) return undefined;
    return {
      core: [match[1], match[2], match[3]],
      prerelease: match[4]?.split("."),
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  if (!leftVersion || !rightVersion) return undefined;
  const compareNumeric = (leftValue: string, rightValue: string): number => {
    const normalizedLeft = leftValue.replace(/^0+(?=\d)/, "");
    const normalizedRight = rightValue.replace(/^0+(?=\d)/, "");
    return normalizedLeft.length === normalizedRight.length
      ? (normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1)
      : normalizedLeft.length > normalizedRight.length ? 1 : -1;
  };
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumeric(leftVersion.core[index], rightVersion.core[index]);
    if (difference !== 0) return difference;
  }
  const leftPrerelease = leftVersion.prerelease;
  const rightPrerelease = rightVersion.prerelease;
  if (!leftPrerelease && !rightPrerelease) return 0;
  if (!leftPrerelease) return 1;
  if (!rightPrerelease) return -1;
  const length = Math.max(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function syncItemForNode(compiled: CompiledArchitecture, node: CompiledArchitectureNode | undefined, allNode: CompiledArchitecture["allNodes"][number], observed: ObservedArchitectureNodeRecord | undefined, router: ObservedArchitectureNodeRecord | undefined): ArchitectureSyncPlanItem {
  const desiredEnabled = node !== undefined;
  const desiredSkill = node?.skillRefId ? compiled.skills.find((skill) => skill.skillRefId === node.skillRefId) : undefined;
  const desired = {
    ...(desiredSkill ? { version: desiredSkill.version, digest: desiredSkill.digest } : {}),
    enabled: desiredEnabled,
    ...(node ? { runtimeExposure: node.runtimeExposure } : { runtimeExposure: "disabled" as const }),
  };
  if (observed && observed.kind !== undefined && observed.kind !== allNode.kind) {
    return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target node kind differs from the desired architecture.", desired, observed };
  }
  if (allNode.kind === "router" && !allNode.skillRefId) {
    if (!desiredEnabled) {
      if (observed && observed.enabled !== false && observed.managed !== true) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, reason: "Target router is not explicitly managed by MySkills.", desired, observed };
      if (observed && observed.enabled !== false) return { action: "disable", nodeId: allNode.id, kind: allNode.kind, reason: "Router is disabled by the selected profile/environment.", desired, observed };
      return { action: "noop", nodeId: allNode.id, kind: allNode.kind, reason: "Router is already disabled.", desired, observed };
    }
    if (observed?.supported === false) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, reason: "Target does not support this router adapter.", desired, observed };
    if (!router) return { action: "configure-router", nodeId: allNode.id, kind: allNode.kind, reason: "Router configuration is absent on the target.", desired, observed };
    const desiredRouter = compiled.routers.find((candidate) => candidate.nodeId === allNode.id);
    if (router.configured === false || (desiredRouter && router.configurationDigest !== desiredRouter.digest)) {
      if (router.managed !== true) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, reason: "Target router is not explicitly managed by MySkills.", desired, observed };
      return { action: "configure-router", nodeId: allNode.id, kind: allNode.kind, reason: "Router configuration differs from the desired topology.", desired, observed };
    }
    return { action: "noop", nodeId: allNode.id, kind: allNode.kind, reason: "Router configuration matches the desired topology.", desired, observed };
  }
  if (!desiredEnabled) {
    if (!observed) return { action: "noop", nodeId: allNode.id, kind: allNode.kind, reason: "Skill is not present and remains disabled.", desired };
    if (observed.managed !== true && observed.enabled !== false) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, reason: "Target skill is not explicitly managed by MySkills.", desired, observed };
    if (observed.enabled !== false) return { action: "disable", nodeId: allNode.id, kind: allNode.kind, reason: "Skill is disabled by the selected profile/environment.", desired, observed };
    return { action: "noop", nodeId: allNode.id, kind: allNode.kind, reason: "Skill is already disabled.", desired, observed };
  }
  if (observed?.supported === false) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target does not support this skill adapter.", desired, observed };
  if (!observed) return { action: "install", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Desired skill is absent from the target.", desired };
  if (observed.runtimeExposure === undefined || (observed.source === "generic" && observed.enabled === undefined)) {
    return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target skill state is incomplete; enabled and runtime exposure are required.", desired, observed };
  }
  const versionComparison = desiredSkill && observed.version ? compareVersions(desiredSkill.version, observed.version) : undefined;
  if (versionComparison === undefined) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Skill versions cannot be compared deterministically.", desired, observed };
  const differs = versionComparison !== 0 || (desiredSkill && observed.digest !== desiredSkill.digest) || observed.enabled === false || (observed.runtimeExposure !== undefined && observed.runtimeExposure !== node?.runtimeExposure);
  if (differs && observed.managed !== true) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target skill is not explicitly managed by MySkills.", desired, observed };
  if (versionComparison > 0) return { action: "update", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Desired skill version is newer than the target version.", desired, observed };
  if (versionComparison < 0) return { action: "downgrade", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Desired skill version is older than the target version.", desired, observed };
  if (desiredSkill && observed.digest !== desiredSkill.digest) return { action: "conflict", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target has the same version with a different artifact digest.", desired, observed };
  if (observed.enabled === false) return { action: "enable", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Desired skill is enabled but the target is disabled.", desired, observed };
  if (observed.runtimeExposure !== undefined && observed.runtimeExposure !== node?.runtimeExposure) return { action: "conflict", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target runtime exposure differs from the desired exposure.", desired, observed };
  return { action: "noop", nodeId: allNode.id, kind: allNode.kind, skillRefId: allNode.skillRefId, reason: "Target metadata matches the desired architecture.", desired, observed };
}

function skillBackedRouterConfigurationItem(
  compiled: CompiledArchitecture,
  node: CompiledArchitectureNode | undefined,
  allNode: CompiledArchitecture["allNodes"][number],
  observed: ObservedArchitectureNodeRecord | undefined,
  primary: ArchitectureSyncPlanItem,
): ArchitectureSyncPlanItem | undefined {
  if (!node || allNode.kind !== "router" || !allNode.skillRefId || primary.action === "unsupported") return undefined;
  const desiredRouter = compiled.routers.find((candidate) => candidate.nodeId === allNode.id);
  if (!desiredRouter) {
    return {
      action: "unsupported",
      nodeId: allNode.id,
      kind: allNode.kind,
      skillRefId: allNode.skillRefId,
      reason: "Desired router configuration is unavailable.",
      desired: primary.desired,
      observed: primary.observed,
    };
  }
  const configurationMatches = observed !== undefined
    && observed.configurationDigest === desiredRouter.digest
    && observed.configured !== false;
  if (configurationMatches) return undefined;
  if (observed?.managed !== undefined && observed.managed !== true) {
    return {
      action: "unsupported",
      nodeId: allNode.id,
      kind: allNode.kind,
      skillRefId: allNode.skillRefId,
      reason: "Target router configuration is not explicitly managed by MySkills.",
      desired: primary.desired,
      observed: primary.observed,
    };
  }
  return {
    action: "configure-router",
    nodeId: allNode.id,
    kind: allNode.kind,
    skillRefId: allNode.skillRefId,
    reason: "Router configuration is absent or differs from the desired topology.",
    desired: primary.desired,
    observed: primary.observed,
  };
}

interface ObservedIdentityIndex {
  byNodeId: Map<string, ObservedArchitectureNodeRecord>;
  bySkillRef: Map<string, ObservedArchitectureNodeRecord>;
  bySlug: Map<string, ObservedArchitectureNodeRecord>;
  byDesiredNodeId: Map<string, ObservedArchitectureNodeRecord>;
  matched: Set<ObservedArchitectureNodeRecord>;
}

function observedIdentityConflict(): never {
  throw new ArchitectureCompileError(
    "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
    "Observed target state contains duplicate or conflicting node identities.",
  );
}

function registerObservedIdentity(
  index: Map<string, ObservedArchitectureNodeRecord>,
  identity: unknown,
  node: ObservedArchitectureNodeRecord,
): void {
  if (identity === undefined) return;
  if (typeof identity !== "string" || identity.length === 0) observedIdentityConflict();
  const previous = index.get(identity);
  if (previous !== undefined && previous !== node) observedIdentityConflict();
  index.set(identity, node);
}

function desiredNodeIdsBySkill(compiled: CompiledArchitecture): { bySkillRef: Map<string, string[]>; bySlug: Map<string, string[]> } {
  const bySkillRef = new Map<string, string[]>();
  for (const node of compiled.allNodes) {
    if (node.skillRefId) bySkillRef.set(node.skillRefId, [...(bySkillRef.get(node.skillRefId) ?? []), node.id]);
  }
  const bySlug = new Map<string, string[]>();
  for (const node of compiled.allNodes) {
    if (node.slug) bySlug.set(node.slug, [...(bySlug.get(node.slug) ?? []), node.id]);
  }
  for (const ids of bySkillRef.values()) ids.sort();
  for (const ids of bySlug.values()) ids.sort();
  return { bySkillRef, bySlug };
}

function intersectDesiredIds(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  const [first, ...rest] = sets;
  return new Set([...first].filter((id) => rest.every((candidate) => candidate.has(id))));
}

function buildObservedIdentityIndex(compiled: CompiledArchitecture, observedNodes: ObservedArchitectureNodeRecord[]): ObservedIdentityIndex {
  const byNodeId = new Map<string, ObservedArchitectureNodeRecord>();
  const bySkillRef = new Map<string, ObservedArchitectureNodeRecord>();
  const bySlug = new Map<string, ObservedArchitectureNodeRecord>();
  for (const node of observedNodes) {
    registerObservedIdentity(byNodeId, node.nodeId, node);
    registerObservedIdentity(bySkillRef, node.skillRefId, node);
    registerObservedIdentity(bySlug, node.slug, node);
  }

  const desiredByNodeId = new Map(compiled.allNodes.map((node) => [node.id, node.id]));
  const desiredIdentities = desiredNodeIdsBySkill(compiled);
  const byDesiredNodeId = new Map<string, ObservedArchitectureNodeRecord>();
  const matched = new Set<ObservedArchitectureNodeRecord>();

  for (const node of observedNodes) {
    const candidateSets: Set<string>[] = [];
    if (node.nodeId !== undefined && desiredByNodeId.has(node.nodeId)) candidateSets.push(new Set([node.nodeId]));
    if (node.skillRefId !== undefined) {
      const ids = desiredIdentities.bySkillRef.get(node.skillRefId);
      if (ids !== undefined) candidateSets.push(new Set(ids));
    }
    if (node.slug !== undefined) {
      const ids = desiredIdentities.bySlug.get(node.slug);
      if (ids !== undefined) candidateSets.push(new Set(ids));
    }
    const candidates = intersectDesiredIds(candidateSets);
    if (candidateSets.length > 1 && candidates.size === 0) observedIdentityConflict();
    if (candidates.size > 1) observedIdentityConflict();
    if (candidates.size === 0) continue;
    const desiredNodeId = [...candidates][0];
    if (!desiredNodeId) continue;
    const previous = byDesiredNodeId.get(desiredNodeId);
    if (previous !== undefined && previous !== node) observedIdentityConflict();
    byDesiredNodeId.set(desiredNodeId, node);
    matched.add(node);
  }
  return { byNodeId, bySkillRef, bySlug, byDesiredNodeId, matched };
}

function observedNodeIdentifier(node: ObservedArchitectureNode, index: number): string {
  return node.nodeId ?? node.skillRefId ?? node.slug ?? `observed-${index + 1}`;
}

/** Build a deterministic, approval-required dry-run plan. This function never writes. */
export function planArchitectureSync(compiled: CompiledArchitecture, observed: ObservedArchitectureState): ArchitectureSyncPlan {
  if (observed.environmentId !== undefined && observed.environmentId !== compiled.environmentId) {
    throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_MISMATCH", "Observed state belongs to a different environment.");
  }
  const observedNodes = observedSkillNodes(observed, compiled);
  const identityIndex = buildObservedIdentityIndex(compiled, observedNodes);
  const routerByNodeId = new Map([...identityIndex.byNodeId.entries()].filter(([, node]) => node.kind === "router"));
  const desiredByNodeId = new Map(compiled.nodes.map((node) => [node.id, node]));
  const items: ArchitectureSyncPlanItem[] = [];
  for (const allNode of compiled.allNodes) {
    const observedNode = identityIndex.byDesiredNodeId.get(allNode.id);
    const desiredNode = desiredByNodeId.get(allNode.id);
    const primary = syncItemForNode(compiled, desiredNode, allNode, observedNode, routerByNodeId.get(allNode.id));
    const configuration = skillBackedRouterConfigurationItem(compiled, desiredNode, allNode, observedNode, primary);
    if (configuration && primary.action === "noop") items.push(configuration);
    else {
      items.push(primary);
      if (configuration) items.push(configuration);
    }
  }
  for (const [index, observedNode] of observedNodes.entries()) {
    if (identityIndex.matched.has(observedNode)) continue;
    const nodeId = observedNodeIdentifier(observedNode, index);
    if (observedNode.managed !== true) {
      items.push({ action: "unsupported", nodeId, kind: observedNode.kind ?? "leaf", skillRefId: observedNode.skillRefId, reason: "Target contains an unmanaged node outside this architecture." });
    } else {
      items.push({ action: "remove", nodeId, kind: observedNode.kind ?? "leaf", skillRefId: observedNode.skillRefId, reason: "Target contains a managed node absent from this architecture." });
    }
  }
  const actionOrder = new Map(architectureSyncActions.map((action, index) => [action, index]));
  items.sort((left, right) => `${left.nodeId}`.localeCompare(`${right.nodeId}`)
    || (actionOrder.get(left.action) ?? Number.MAX_SAFE_INTEGER) - (actionOrder.get(right.action) ?? Number.MAX_SAFE_INTEGER)
    || left.reason.localeCompare(right.reason));
  return {
    dryRun: true,
    canApply: false,
    requiresApproval: true,
    targetId: observed.targetId,
    environmentId: observed.environmentId ?? compiled.environmentId,
    architectureId: compiled.architectureId,
    revisionDigest: compiled.revisionDigest,
    items,
  };
}

export const createArchitectureSyncPlan = planArchitectureSync;

export interface MermaidProjectionOptions {
  includeDisabled?: boolean;
}

function mermaidNodeId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
  return `node_${safe || "item"}_${sha256Hex(id).slice(0, 12)}`;
}

function mermaidLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, " ");
}

export function mermaidArchitecture(input: ArchitectureSpecV1 | CompiledArchitecture, options: MermaidProjectionOptions = {}): string {
  const lines = ["flowchart TD"];
  if ("architectureId" in input) {
    const nodes = options.includeDisabled ? input.allNodes : input.nodes;
    const activeIds = new Set(input.nodes.map((node) => node.id));
    for (const node of nodes.slice().sort((left, right) => left.id.localeCompare(right.id))) {
      const suffix = "runtimeExposure" in node ? ` [${node.runtimeExposure}]` : activeIds.has(node.id) ? "" : " [disabled]";
      lines.push(`    ${mermaidNodeId(node.id)}["${mermaidLabel(node.label)} (${node.kind}) · ${mermaidLabel(node.id)}${suffix}"]`);
    }
    for (const edge of input.edges.slice().sort((left, right) => `${left.from}\u0000${left.to}`.localeCompare(`${right.from}\u0000${right.to}`))) lines.push(`    ${mermaidNodeId(edge.from)} -->|${edge.kind}| ${mermaidNodeId(edge.to)}`);
  } else {
    const spec = assertValidArchitectureSpec(input);
    const nodes = spec.nodes.slice().sort((left, right) => left.id.localeCompare(right.id));
    for (const node of nodes) lines.push(`    ${mermaidNodeId(node.id)}["${mermaidLabel(node.label)} (${node.kind}) · ${mermaidLabel(node.id)}"]`);
    for (const edge of spec.edges) lines.push(`    ${mermaidNodeId(edge.from)} -->|${edge.kind}| ${mermaidNodeId(edge.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

export const renderMermaidArchitecture = mermaidArchitecture;
export const architectureToMermaid = mermaidArchitecture;

export interface AccessibleArchitectureOutlineNode {
  id: string;
  label: string;
  kind: ArchitectureNodeKind;
  children: AccessibleArchitectureOutlineNode[];
}

export interface AccessibleArchitectureOutline {
  title: string;
  text: string;
  tree: AccessibleArchitectureOutlineNode[];
  html: string;
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createAccessibleArchitectureOutline(specInput: ArchitectureSpecV1): AccessibleArchitectureOutline {
  const spec = assertValidArchitectureSpec(specInput);
  const nodeById = new Map(spec.nodes.map((node) => [node.id, node]));
  const childrenById = new Map<string, string[]>();
  for (const edge of spec.edges) childrenById.set(edge.from, [...(childrenById.get(edge.from) ?? []), edge.to]);
  for (const children of childrenById.values()) children.sort();
  const makeNode = (id: string): AccessibleArchitectureOutlineNode => {
    const node = nodeById.get(id);
    if (!node) throw new ArchitectureValidationError([{ code: "ARCHITECTURE_ENTRY_UNKNOWN", message: `Node '${id}' does not exist.` }]);
    return { id: node.id, label: node.label, kind: node.kind, children: (childrenById.get(id) ?? []).map(makeNode) };
  };
  const tree = spec.entryNodeIds.slice().sort().map(makeNode);
  const textLines: string[] = [spec.name];
  const htmlNode = (node: AccessibleArchitectureOutlineNode, level: number): string => {
    textLines.push(`${"  ".repeat(level)}- ${node.label} (${node.kind})`);
    const children = node.children.map((child) => htmlNode(child, level + 1)).join("");
    return `<li role="treeitem" aria-level="${level}" aria-label="${htmlEscape(`${node.label} (${node.kind})`)}">${htmlEscape(node.label)} <span>(${node.kind})</span>${children ? `<ul role="group">${children}</ul>` : ""}</li>`;
  };
  const html = `<ul role="tree" aria-label="${htmlEscape(spec.name)}">${tree.map((node) => htmlNode(node, 1)).join("")}</ul>`;
  return { title: spec.name, text: textLines.join("\n"), tree, html };
}

export function accessibleArchitectureOutline(spec: ArchitectureSpecV1): string {
  return createAccessibleArchitectureOutline(spec).text;
}

export const architectureOutline = accessibleArchitectureOutline;
export const renderAccessibleArchitectureOutline = (spec: ArchitectureSpecV1): string => createAccessibleArchitectureOutline(spec).html;
export const architectureToAccessibleOutline = createAccessibleArchitectureOutline;
