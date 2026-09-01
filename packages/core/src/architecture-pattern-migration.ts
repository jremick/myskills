/**
 * Pure, revision-to-revision architecture pattern migration contracts.
 *
 * A pattern migration derives a new shell candidate from a server-supplied
 * ArchitectureSpecV1. It never mutates the source revision, chooses registry
 * releases, persists a shell, rebinds a target, or talks to an adapter. The
 * API is responsible for fetching the authoritative source revision and for
 * appending the derived candidate to a new shell in one transaction.
 */

import {
  architectureDigest,
  architectureLimits,
  architecturePatternIds,
  architectureSchemaVersion,
  assertValidArchitectureSpec,
  canonicalizeJson,
  resolveArchitectureEnvironment,
  resolveArchitectureProfileBinding,
  sha256Hex,
  type ArchitectureEdge,
  type ArchitectureLeafNode,
  type ArchitectureNode,
  type ArchitecturePatternId,
  type ArchitectureProfile,
  type ArchitectureProfileBinding,
  type ArchitectureRouterNode,
  type ArchitectureSpecV1,
} from "./architecture.js";

export const architecturePatternMigrationSchemaVersion = 1 as const;
export type ArchitecturePatternMigrationSchemaVersion = typeof architecturePatternMigrationSchemaVersion;
export const architecturePatternMigrationMode = "derive-shell" as const;
export const architecturePatternMigrationModes = [architecturePatternMigrationMode] as const;
export type ArchitecturePatternMigrationMode = typeof architecturePatternMigrationMode;

/** Limits apply before a transformed candidate reaches the architecture validator. */
export const architecturePatternMigrationLimits = {
  mappingGroups: architectureLimits.nodes,
  mappingLeafNodeIds: architectureLimits.nodes,
  mappingBytes: 32_768,
  generatedBindingsPerProfile: architectureLimits.bindingsPerProfile,
  labelLength: 160,
} as const;

export interface ArchitecturePatternMigrationRouterGroup {
  id: string;
  label: string;
  parentRouterId?: string | null;
  leafNodeIds: string[];
}

export interface ArchitecturePatternMigrationMapping {
  rootRouterId?: string;
  rootLabel?: string;
  routerGroups?: ArchitecturePatternMigrationRouterGroup[];
  allowUnassignedLeafFallback?: boolean;
}

export interface ArchitecturePatternMigrationInput {
  /** The API must load this revision; callers must not trust a client-supplied copy. */
  source: ArchitectureSpecV1;
  targetPatternId: ArchitecturePatternId;
  mapping?: ArchitecturePatternMigrationMapping;
}

export interface ArchitecturePatternMigrationSourceSummary {
  architectureId: string;
  patternId: ArchitecturePatternId;
  revisionDigest: string;
}

export interface ArchitecturePatternMigrationTargetSummary {
  patternId: ArchitecturePatternId;
  /** The API replaces shell identity with the newly created shell before save. */
  spec: ArchitectureSpecV1;
  revisionDigest: string;
}

export interface ArchitecturePatternMigrationDiff {
  preservedSkillRefIds: string[];
  preservedLeafNodeIds: string[];
  addedRouterNodeIds: string[];
  droppedRouterNodeIds: string[];
  addedEdgeCount: number;
  removedEdgeCount: number;
  /** Number of old topology bindings removed plus new topology bindings emitted. */
  rewrittenBindingCount: number;
}

export type ArchitecturePatternMigrationMappingStatus =
  | "deterministic"
  | "fallback"
  | "provided"
  | "blocked";

export type ArchitecturePatternMigrationIssueCode =
  | "ARCHITECTURE_PATTERN_MIGRATION_INVALID_OBJECT"
  | "ARCHITECTURE_PATTERN_MIGRATION_UNKNOWN_FIELD"
  | "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_REQUIRED"
  | "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID"
  | "ARCHITECTURE_PATTERN_MIGRATION_TARGET_PATTERN_REQUIRED"
  | "ARCHITECTURE_PATTERN_MIGRATION_TARGET_PATTERN_INVALID"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_NOT_APPLICABLE"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_ID_INVALID"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_UNKNOWN"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_DUPLICATE"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_PARENT_INVALID"
  | "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_UNASSIGNED"
  | "ARCHITECTURE_PATTERN_MIGRATION_EXPOSURE_NOT_PRESERVED"
  | "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED"
  | "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID";

export interface ArchitecturePatternMigrationIssue {
  code: ArchitecturePatternMigrationIssueCode | string;
  message: string;
  path?: string;
}

interface ArchitecturePatternMigrationBase {
  schemaVersion: ArchitecturePatternMigrationSchemaVersion;
  mode: ArchitecturePatternMigrationMode;
  source: ArchitecturePatternMigrationSourceSummary;
  mappingStatus: ArchitecturePatternMigrationMappingStatus;
  diff: ArchitecturePatternMigrationDiff;
  issues: ArchitecturePatternMigrationIssue[];
  /** Digest of the semantic result, excluding this digest and diffDigest. */
  migrationDigest: string;
  /** Digest of the semantic diff only. */
  diffDigest: string;
}

export interface ArchitecturePatternMigrationSuccess extends ArchitecturePatternMigrationBase {
  mappingStatus: Exclude<ArchitecturePatternMigrationMappingStatus, "blocked">;
  target: ArchitecturePatternMigrationTargetSummary;
}

export interface ArchitecturePatternMigrationBlocked extends ArchitecturePatternMigrationBase {
  mappingStatus: "blocked";
  target: null;
}

export type ArchitecturePatternMigrationResult = ArchitecturePatternMigrationSuccess | ArchitecturePatternMigrationBlocked;

export type ArchitecturePatternMigrationValidationResult =
  | { valid: true; value: ArchitecturePatternMigrationInput }
  | { valid: false; errors: ArchitecturePatternMigrationIssue[] };

export class ArchitecturePatternMigrationValidationError extends Error {
  public readonly code = "ARCHITECTURE_PATTERN_MIGRATION_VALIDATION_FAILED";
  public readonly statusCode = 422;

  constructor(public readonly errors: ArchitecturePatternMigrationIssue[]) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join("; ") || "Pattern migration input is invalid.");
    this.name = "ArchitecturePatternMigrationValidationError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pushIssue(
  errors: ArchitecturePatternMigrationIssue[],
  code: ArchitecturePatternMigrationIssueCode,
  message: string,
  path?: string,
): void {
  errors.push(path ? { code, message, path } : { code, message });
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: ArchitecturePatternMigrationIssue[],
  path: string,
  code: ArchitecturePatternMigrationIssueCode = "ARCHITECTURE_PATTERN_MIGRATION_UNKNOWN_FIELD",
): void {
  for (const key of unknownKeys(value, allowed)) {
    pushIssue(errors, code, `Field '${key}' is not accepted.`, `${path}.${key}`);
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function mappingHasFields(mapping: ArchitecturePatternMigrationMapping | undefined): boolean {
  if (!mapping) return false;
  return Object.keys(mapping).length > 0;
}

function normalizeMapping(mapping: ArchitecturePatternMigrationMapping): ArchitecturePatternMigrationMapping {
  const normalized: ArchitecturePatternMigrationMapping = {};
  if (mapping.rootRouterId !== undefined) normalized.rootRouterId = mapping.rootRouterId;
  if (mapping.rootLabel !== undefined) normalized.rootLabel = mapping.rootLabel;
  if (mapping.allowUnassignedLeafFallback !== undefined) normalized.allowUnassignedLeafFallback = mapping.allowUnassignedLeafFallback;
  if (mapping.routerGroups !== undefined) {
    normalized.routerGroups = mapping.routerGroups.map((group) => {
      const result: ArchitecturePatternMigrationRouterGroup = {
        id: group.id,
        label: group.label,
        leafNodeIds: [...group.leafNodeIds].sort(compareStrings),
      };
      if (group.parentRouterId !== undefined) result.parentRouterId = group.parentRouterId;
      return result;
    }).sort((left, right) => left.id.localeCompare(right.id));
  }
  return normalized;
}

function strictSourceShapeIssues(source: unknown): ArchitecturePatternMigrationIssue[] {
  const errors: ArchitecturePatternMigrationIssue[] = [];
  if (!isRecord(source)) return errors;
  checkUnknownKeys(source, ["schemaVersion", "id", "name", "description", "pattern", "skills", "nodes", "edges", "entryNodeIds", "profiles", "environments", "metadata"], errors, "source");
  if (isRecord(source.pattern)) checkUnknownKeys(source.pattern, ["id", "version"], errors, "source.pattern");
  if (Array.isArray(source.skills)) {
    source.skills.forEach((skill, index) => {
      if (isRecord(skill)) checkUnknownKeys(skill, ["id", "slug", "title", "summary", "version", "digest", "packageVisibility", "visibility", "tags", "metadata"], errors, `source.skills[${index}]`);
    });
  }
  if (Array.isArray(source.nodes)) {
    source.nodes.forEach((node, index) => {
      if (isRecord(node)) checkUnknownKeys(node, ["id", "kind", "label", "skillRefId", "metadata"], errors, `source.nodes[${index}]`);
    });
  }
  if (Array.isArray(source.edges)) {
    source.edges.forEach((edge, index) => {
      if (isRecord(edge)) checkUnknownKeys(edge, ["from", "to", "kind", "metadata"], errors, `source.edges[${index}]`);
    });
  }
  if (Array.isArray(source.profiles)) {
    source.profiles.forEach((profile, index) => {
      if (!isRecord(profile)) return;
      checkUnknownKeys(profile, ["id", "name", "subject", "defaultExposure", "bindings", "metadata"], errors, `source.profiles[${index}]`);
      if (isRecord(profile.subject)) checkUnknownKeys(profile.subject, ["type", "id"], errors, `source.profiles[${index}].subject`);
      if (Array.isArray(profile.bindings)) {
        profile.bindings.forEach((binding, bindingIndex) => {
          if (isRecord(binding)) checkUnknownKeys(binding, ["nodeId", "enabled", "environmentIds", "runtimeExposure", "exposure", "metadata"], errors, `source.profiles[${index}].bindings[${bindingIndex}]`);
        });
      }
    });
  }
  if (Array.isArray(source.environments)) {
    source.environments.forEach((environment, index) => {
      if (isRecord(environment)) checkUnknownKeys(environment, ["id", "name", "kind", "profileId", "parentId", "metadata"], errors, `source.environments[${index}]`);
    });
  }
  return errors;
}

function validateMappingInput(value: unknown, errors: ArchitecturePatternMigrationIssue[], path = "mapping"): ArchitecturePatternMigrationMapping | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "Mapping must be an object.", path);
    return undefined;
  }
  checkUnknownKeys(value, ["rootRouterId", "rootLabel", "routerGroups", "allowUnassignedLeafFallback"], errors, path, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD");

  if (value.rootRouterId !== undefined && !validIdentifier(value.rootRouterId)) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_ID_INVALID", "rootRouterId must be a valid architecture identifier.", `${path}.rootRouterId`);
  }
  if (value.rootLabel !== undefined && (typeof value.rootLabel !== "string" || value.rootLabel.length === 0 || value.rootLabel.length > architecturePatternMigrationLimits.labelLength)) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", `rootLabel must be a non-empty string of at most ${architecturePatternMigrationLimits.labelLength} characters.`, `${path}.rootLabel`);
  }
  if (value.allowUnassignedLeafFallback !== undefined && typeof value.allowUnassignedLeafFallback !== "boolean") {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "allowUnassignedLeafFallback must be boolean.", `${path}.allowUnassignedLeafFallback`);
  }

  const rawGroups = value.routerGroups;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "routerGroups must be an array.", `${path}.routerGroups`);
    return {
      ...(typeof value.rootRouterId === "string" ? { rootRouterId: value.rootRouterId } : {}),
      ...(typeof value.rootLabel === "string" ? { rootLabel: value.rootLabel } : {}),
      ...(typeof value.allowUnassignedLeafFallback === "boolean" ? { allowUnassignedLeafFallback: value.allowUnassignedLeafFallback } : {}),
    };
  }
  if (Array.isArray(rawGroups) && rawGroups.length > architecturePatternMigrationLimits.mappingGroups) {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", `routerGroups may contain at most ${architecturePatternMigrationLimits.mappingGroups} groups.`, `${path}.routerGroups`);
    return undefined;
  }

  const groups: ArchitecturePatternMigrationRouterGroup[] = [];
  const groupIds = new Set<string>();
  for (const [index, rawGroup] of (Array.isArray(rawGroups) ? rawGroups.entries() : [])) {
    const groupPath = `${path}.routerGroups[${index}]`;
    if (!isRecord(rawGroup)) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "Router group must be an object.", groupPath);
      continue;
    }
    checkUnknownKeys(rawGroup, ["id", "label", "parentRouterId", "leafNodeIds"], errors, groupPath, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD");
    if (!validIdentifier(rawGroup.id)) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_ID_INVALID", "Router group id must be a valid architecture identifier.", `${groupPath}.id`);
    if (typeof rawGroup.id === "string" && groupIds.has(rawGroup.id)) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE", "Router group ids must be unique.", `${groupPath}.id`);
    if (typeof rawGroup.id === "string") groupIds.add(rawGroup.id);
    if (typeof rawGroup.label !== "string" || rawGroup.label.length === 0 || rawGroup.label.length > architecturePatternMigrationLimits.labelLength) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", `Router group label must be a non-empty string of at most ${architecturePatternMigrationLimits.labelLength} characters.`, `${groupPath}.label`);
    }
    if (rawGroup.parentRouterId !== undefined && rawGroup.parentRouterId !== null && !validIdentifier(rawGroup.parentRouterId)) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_PARENT_INVALID", "parentRouterId must be null or a valid architecture identifier.", `${groupPath}.parentRouterId`);
    }
    if (!Array.isArray(rawGroup.leafNodeIds)) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "leafNodeIds must be an array.", `${groupPath}.leafNodeIds`);
      continue;
    }
    if (rawGroup.leafNodeIds.length === 0) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "Router groups must contain at least one leaf node.", `${groupPath}.leafNodeIds`);
    }
    if (rawGroup.leafNodeIds.length > architecturePatternMigrationLimits.mappingLeafNodeIds) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", `leafNodeIds may contain at most ${architecturePatternMigrationLimits.mappingLeafNodeIds} items.`, `${groupPath}.leafNodeIds`);
    }
    const leafNodeIds: string[] = [];
    const groupLeafIds = new Set<string>();
    for (const [leafIndex, leafNodeId] of rawGroup.leafNodeIds.entries()) {
      if (!validIdentifier(leafNodeId)) {
        pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_ID_INVALID", "leafNodeIds must contain valid architecture identifiers.", `${groupPath}.leafNodeIds[${leafIndex}]`);
        continue;
      }
      if (groupLeafIds.has(leafNodeId)) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_DUPLICATE", "A leaf cannot appear twice in one router group.", `${groupPath}.leafNodeIds[${leafIndex}]`);
      groupLeafIds.add(leafNodeId);
      leafNodeIds.push(leafNodeId);
    }
    if (typeof rawGroup.id === "string" && typeof rawGroup.label === "string") {
      groups.push({
        id: rawGroup.id,
        label: rawGroup.label,
        ...(rawGroup.parentRouterId === null || typeof rawGroup.parentRouterId === "string" ? { parentRouterId: rawGroup.parentRouterId } : {}),
        leafNodeIds: [...new Set(leafNodeIds)].sort(compareStrings),
      });
    }
  }

  const result: ArchitecturePatternMigrationMapping = {};
  if (typeof value.rootRouterId === "string") result.rootRouterId = value.rootRouterId;
  if (typeof value.rootLabel === "string") result.rootLabel = value.rootLabel;
  if (typeof value.allowUnassignedLeafFallback === "boolean") result.allowUnassignedLeafFallback = value.allowUnassignedLeafFallback;
  if (Array.isArray(rawGroups)) result.routerGroups = groups.sort((left, right) => left.id.localeCompare(right.id));
  try {
    if (canonicalizeJson(result).length > architecturePatternMigrationLimits.mappingBytes) {
      pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED", `Mapping must be at most ${architecturePatternMigrationLimits.mappingBytes} canonical characters.`, path);
    }
  } catch {
    pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID", "Mapping must contain JSON-safe values.", path);
  }
  return result;
}

/** Strictly validate and normalize the caller intent before deriving a shell. */
export function validateArchitecturePatternMigrationInput(input: unknown): ArchitecturePatternMigrationValidationResult {
  const errors: ArchitecturePatternMigrationIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, errors: [{ code: "ARCHITECTURE_PATTERN_MIGRATION_INVALID_OBJECT", message: "Pattern migration input must be an object." }] };
  }
  checkUnknownKeys(input, ["source", "targetPatternId", "mapping"], errors, "input");
  if (input.source === undefined) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_REQUIRED", "A server-supplied source architecture revision is required.", "source");
  errors.push(...strictSourceShapeIssues(input.source));
  let source: ArchitectureSpecV1 | undefined;
  if (input.source !== undefined && errors.every((error) => !error.path?.startsWith("source."))) {
    try {
      source = assertValidArchitectureSpec(input.source);
    } catch (error) {
      if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
        for (const issue of error.errors) {
          if (isRecord(issue) && typeof issue.code === "string" && typeof issue.message === "string") {
            errors.push({ code: "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", message: issue.message, path: typeof issue.path === "string" ? `source.${issue.path}` : "source" });
          }
        }
      } else {
        pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", "Source architecture revision is invalid.", "source");
      }
    }
  }
  if (input.targetPatternId === undefined) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_TARGET_PATTERN_REQUIRED", "A target pattern is required.", "targetPatternId");
  else if (!isOneOf(input.targetPatternId, architecturePatternIds)) pushIssue(errors, "ARCHITECTURE_PATTERN_MIGRATION_TARGET_PATTERN_INVALID", "Target pattern is unsupported.", "targetPatternId");
  const mapping = validateMappingInput(input.mapping, errors);
  if (errors.length > 0 || !source || !isOneOf(input.targetPatternId, architecturePatternIds)) return { valid: false, errors };
  return {
    valid: true,
    value: {
      source,
      targetPatternId: input.targetPatternId,
      ...(mapping !== undefined ? { mapping: normalizeMapping(mapping) } : {}),
    },
  };
}

export function assertValidArchitecturePatternMigrationInput(input: unknown): ArchitecturePatternMigrationInput {
  const result = validateArchitecturePatternMigrationInput(input);
  if (!result.valid) throw new ArchitecturePatternMigrationValidationError(result.errors);
  return result.value;
}

interface EffectiveExposure {
  enabled: boolean;
  runtimeExposure: "disabled" | "leaf" | "router";
}

function effectiveLeafExposure(spec: ArchitectureSpecV1, profile: ArchitectureProfile, environmentId: string, leafNodeId: string): EffectiveExposure {
  // An environment can select only its bound profile. Profile bindings for
  // other environments remain in the revision, but they are not active in
  // this profile's context and must not be treated as an implicit grant.
  const context = resolveArchitectureEnvironment(spec, { environmentId });
  if (context.profile.id !== profile.id) return { enabled: false, runtimeExposure: "disabled" };
  const ownBinding = resolveArchitectureProfileBinding(spec, {
    profileId: profile.id,
    environmentId,
    nodeId: leafNodeId,
  });
  if (ownBinding.decision !== "enabled" || !ownBinding.binding || ownBinding.binding.runtimeExposure !== "leaf") {
    return { enabled: false, runtimeExposure: "disabled" };
  }
  const parentByNode = new Map<string, string>();
  for (const edge of spec.edges) parentByNode.set(edge.to, edge.from);
  let parent = parentByNode.get(leafNodeId);
  while (parent !== undefined) {
    const ancestorBinding = resolveArchitectureProfileBinding(spec, {
      profileId: profile.id,
      environmentId,
      nodeId: parent,
    });
    if (ancestorBinding.decision !== "enabled" || !ancestorBinding.binding || ancestorBinding.binding.runtimeExposure !== "router") {
      return { enabled: false, runtimeExposure: "disabled" };
    }
    parent = parentByNode.get(parent);
  }
  return { enabled: true, runtimeExposure: "leaf" };
}

function targetRouterExposure(
  targetSpec: ArchitectureSpecV1,
  profile: ArchitectureProfile,
  environmentId: string,
  routerId: string,
  sourceExposures: Map<string, Map<string, EffectiveExposure>>,
): EffectiveExposure {
  const children = new Map<string, string[]>();
  for (const edge of targetSpec.edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
  const leavesUnder = (nodeId: string, seen = new Set<string>()): string[] => {
    if (seen.has(nodeId)) return [];
    seen.add(nodeId);
    const node = targetSpec.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return [];
    if (node.kind === "leaf") return [node.id];
    return (children.get(node.id) ?? []).flatMap((childId) => leavesUnder(childId, new Set(seen)));
  };
  const active = leavesUnder(routerId).some((leafId) => sourceExposures.get(profile.id)?.get(`${environmentId}\u0000${leafId}`)?.enabled === true);
  return active ? { enabled: true, runtimeExposure: "router" as const } : { enabled: false, runtimeExposure: "disabled" as const };
}

function bindingStateKey(exposure: EffectiveExposure): string {
  return exposure.enabled ? "enabled:leaf" : "disabled";
}

function bindingFromExposure(nodeId: string, exposure: EffectiveExposure, environmentIds?: string[]): ArchitectureProfileBinding {
  return {
    nodeId,
    enabled: exposure.enabled,
    ...(environmentIds && environmentIds.length > 0 ? { environmentIds: [...environmentIds].sort(compareStrings) } : {}),
    runtimeExposure: exposure.runtimeExposure,
  };
}

function generatedBindingsForNode(
  nodeId: string,
  environmentIds: readonly string[],
  exposureForEnvironment: (environmentId: string) => EffectiveExposure,
): ArchitectureProfileBinding[] {
  const byState = new Map<string, string[]>();
  const stateExposure = new Map<string, EffectiveExposure>();
  for (const environmentId of environmentIds) {
    const exposure = exposureForEnvironment(environmentId);
    const key = bindingStateKey(exposure);
    byState.set(key, [...(byState.get(key) ?? []), environmentId]);
    stateExposure.set(key, exposure);
  }
  if (byState.size === 1) {
    const exposure = stateExposure.values().next().value as EffectiveExposure;
    return [bindingFromExposure(nodeId, exposure)];
  }
  return [...byState.keys()].sort().map((key) => bindingFromExposure(nodeId, stateExposure.get(key) as EffectiveExposure, byState.get(key))).sort((left, right) => (
    left.nodeId.localeCompare(right.nodeId) || (left.environmentIds ?? []).join(",").localeCompare((right.environmentIds ?? []).join(","))
  ));
}

function rewriteProfileBindings(
  source: ArchitectureSpecV1,
  target: ArchitectureSpecV1,
  profile: ArchitectureProfile,
  sourceExposures: Map<string, Map<string, EffectiveExposure>>,
): { profile: ArchitectureProfile; oldCount: number; newCount: number } {
  const environmentIds = target.environments.map((environment) => environment.id).sort(compareStrings);
  const topologyNodeIds = new Set(target.nodes.map((node) => node.id));
  const bindings: ArchitectureProfileBinding[] = [];
  for (const node of target.nodes.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    if (node.kind === "leaf") {
      bindings.push(...generatedBindingsForNode(node.id, environmentIds, (environmentId) => sourceExposures.get(profile.id)?.get(`${environmentId}\u0000${node.id}`) ?? { enabled: false, runtimeExposure: "disabled" }));
    } else {
      bindings.push(...generatedBindingsForNode(node.id, environmentIds, (environmentId) => targetRouterExposure(target, profile, environmentId, node.id, sourceExposures)));
    }
  }
  const oldCount = profile.bindings.filter((binding) => topologyNodeIds.has(binding.nodeId) || source.nodes.some((node) => node.id === binding.nodeId)).length;
  if (bindings.length > architecturePatternMigrationLimits.generatedBindingsPerProfile) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED",
      message: `Derived profile bindings may contain at most ${architecturePatternMigrationLimits.generatedBindingsPerProfile} items.`,
      path: `profiles.${profile.id}.bindings`,
    }]);
  }
  return { profile: { ...clone(profile), bindings }, oldCount, newCount: bindings.length };
}

function sourceRoot(source: ArchitectureSpecV1): ArchitectureRouterNode | undefined {
  const entryRoot = source.entryNodeIds.map((id) => source.nodes.find((node) => node.id === id)).find((node): node is ArchitectureRouterNode => node?.kind === "router");
  return entryRoot ?? source.nodes.find((node): node is ArchitectureRouterNode => node.kind === "router");
}

function preferredGeneratedId(preferred: string, source: ArchitectureSpecV1, targetPatternId: ArchitecturePatternId, reserved: Set<string>): string {
  if (!reserved.has(preferred)) return preferred;
  const seed = sha256Hex(`${source.id}\u0000${source.pattern.id}\u0000${targetPatternId}\u0000${preferred}`).slice(0, 12);
  const base = preferred.slice(0, Math.max(1, 127 - seed.length - 1));
  let candidate = `${base}-${seed}`;
  let suffix = 2;
  while (reserved.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 127 - seed.length - suffixText.length)}-${seed}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function cloneLeafNodes(source: ArchitectureSpecV1): ArchitectureLeafNode[] {
  return source.nodes.filter((node): node is ArchitectureLeafNode => node.kind === "leaf").map((node) => clone(node));
}

function cloneOrCreateRoot(
  source: ArchitectureSpecV1,
  targetPatternId: ArchitecturePatternId,
  mapping: ArchitecturePatternMigrationMapping | undefined,
  reserved: Set<string>,
): ArchitectureRouterNode {
  const existing = sourceRoot(source);
  const requestedId = mapping?.rootRouterId;
  if (requestedId !== undefined && reserved.has(requestedId) && requestedId !== existing?.id) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE",
      message: `rootRouterId '${requestedId}' collides with a retained node.`,
      path: "mapping.rootRouterId",
    }]);
  }
  const id = requestedId ?? (existing?.id ?? preferredGeneratedId("router-root", source, targetPatternId, reserved));
  const root: ArchitectureRouterNode = existing ? clone(existing) : { id, kind: "router", label: source.name };
  root.id = id;
  if (mapping?.rootLabel !== undefined) root.label = mapping.rootLabel;
  return root;
}

interface TopologyBuild {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  entryNodeIds: string[];
}

function buildFlatTopology(source: ArchitectureSpecV1): TopologyBuild {
  const leaves = cloneLeafNodes(source);
  return { nodes: leaves, edges: [], entryNodeIds: leaves.map((node) => node.id).sort(compareStrings) };
}

function buildDomainTopology(source: ArchitectureSpecV1, mapping: ArchitecturePatternMigrationMapping | undefined, targetPatternId: ArchitecturePatternId): TopologyBuild {
  if (mapping?.routerGroups && mapping.routerGroups.length > 0) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_NOT_APPLICABLE",
      message: "routerGroups are only applicable to a multi-level-router target.",
      path: "mapping.routerGroups",
    }]);
  }
  if (mapping?.allowUnassignedLeafFallback !== undefined) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_NOT_APPLICABLE",
      message: "allowUnassignedLeafFallback is only applicable to a multi-level-router target.",
      path: "mapping.allowUnassignedLeafFallback",
    }]);
  }
  const leaves = cloneLeafNodes(source);
  const reserved = new Set(leaves.map((node) => node.id));
  const root = cloneOrCreateRoot(source, targetPatternId, mapping, reserved);
  return {
    nodes: [root, ...leaves],
    edges: leaves.map((leaf): ArchitectureEdge => ({ from: root.id, to: leaf.id, kind: "routes" })),
    entryNodeIds: [root.id],
  };
}

function buildMultiLevelTopology(source: ArchitectureSpecV1, mapping: ArchitecturePatternMigrationMapping | undefined, targetPatternId: ArchitecturePatternId): TopologyBuild {
  const leaves = cloneLeafNodes(source);
  const reserved = new Set(leaves.map((node) => node.id));
  const root = cloneOrCreateRoot(source, targetPatternId, mapping, reserved);
  reserved.add(root.id);
  const groups = mapping?.routerGroups ?? [];
  const sourceRootId = sourceRoot(source)?.id;
  const groupById = new Map<string, ArchitecturePatternMigrationRouterGroup>();
  const assignedLeaves = new Set<string>();
  for (const group of groups) {
    if (reserved.has(group.id)) {
      throw new ArchitecturePatternMigrationValidationError([{
        code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE",
        message: `Router group id '${group.id}' collides with a retained node.`,
        path: "mapping.routerGroups",
      }]);
    }
    if (groupById.has(group.id)) {
      throw new ArchitecturePatternMigrationValidationError([{
        code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_DUPLICATE",
        message: `Router group id '${group.id}' is duplicated.`,
        path: "mapping.routerGroups",
      }]);
    }
    groupById.set(group.id, group);
    reserved.add(group.id);
    for (const leafId of group.leafNodeIds) {
      if (!leaves.some((leaf) => leaf.id === leafId)) {
        throw new ArchitecturePatternMigrationValidationError([{
          code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_UNKNOWN",
          message: `Mapped leaf '${leafId}' does not exist in the source architecture.`,
          path: "mapping.routerGroups",
        }]);
      }
      if (assignedLeaves.has(leafId)) {
        throw new ArchitecturePatternMigrationValidationError([{
          code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_DUPLICATE",
          message: `Leaf '${leafId}' is assigned to more than one router group.`,
          path: "mapping.routerGroups",
        }]);
      }
      assignedLeaves.add(leafId);
    }
  }

  const unassigned = leaves.map((leaf) => leaf.id).filter((id) => !assignedLeaves.has(id)).sort(compareStrings);
  const allowFallback = groups.length === 0 || mapping?.allowUnassignedLeafFallback === true;
  if (unassigned.length > 0 && !allowFallback) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_UNASSIGNED",
      message: "Every leaf must be mapped when allowUnassignedLeafFallback is false.",
      path: "mapping.routerGroups",
    }]);
  }

  const generalId = unassigned.length > 0 || groups.length === 0
    ? preferredGeneratedId("router-general", source, targetPatternId, reserved)
    : undefined;
  if (generalId) reserved.add(generalId);
  const routerNodes: ArchitectureRouterNode[] = groups.map((group) => ({ id: group.id, kind: "router", label: group.label }));
  if (generalId) routerNodes.push({ id: generalId, kind: "router", label: "General" });
  const edges: ArchitectureEdge[] = [];
  const parentOfGroup = new Map<string, string>();
  for (const group of groups) {
    const parentId = group.parentRouterId === undefined || group.parentRouterId === null ? root.id : group.parentRouterId;
    if (parentId !== root.id && !groupById.has(parentId)) {
      throw new ArchitecturePatternMigrationValidationError([{
        code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_PARENT_INVALID",
        message: `Router group parent '${parentId}' does not exist in the mapping or root.`,
        path: "mapping.routerGroups",
      }]);
    }
    parentOfGroup.set(group.id, parentId);
  }
  for (const group of groups) {
    const seen = new Set<string>();
    let current: string | undefined = group.id;
    while (current && current !== root.id) {
      if (seen.has(current)) {
        throw new ArchitecturePatternMigrationValidationError([{
          code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_PARENT_INVALID",
          message: "Router group parents must be acyclic.",
          path: "mapping.routerGroups",
        }]);
      }
      seen.add(current);
      current = parentOfGroup.get(current);
    }
    edges.push({ from: parentOfGroup.get(group.id) as string, to: group.id, kind: "contains" });
    for (const leafId of group.leafNodeIds) edges.push({ from: group.id, to: leafId, kind: "routes" });
  }
  if (generalId) {
    edges.push({ from: root.id, to: generalId, kind: "contains" });
    for (const leafId of unassigned) edges.push({ from: generalId, to: leafId, kind: "routes" });
  }

  // A domain source keeps its root in the new hierarchy. A multi-level source
  // only reaches this builder when the requested mapping changes topology, so
  // retaining its root is still the least surprising identity-preserving rule.
  if (sourceRootId && sourceRootId === root.id && !edges.some((edge) => edge.from === root.id)) {
    throw new ArchitecturePatternMigrationValidationError([{
      code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_INVALID",
      message: "A multi-level target must expose at least one child router.",
      path: "mapping",
    }]);
  }
  return {
    nodes: [root, ...routerNodes, ...leaves],
    edges,
    entryNodeIds: [root.id],
  };
}

function edgeKey(edge: ArchitectureEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
}

function buildDiff(source: ArchitectureSpecV1, target: ArchitectureSpecV1, rewrittenBindingCount: number): ArchitecturePatternMigrationDiff {
  const sourceEdges = new Set(source.edges.map(edgeKey));
  const targetEdges = new Set(target.edges.map(edgeKey));
  const sourceRouters = new Set(source.nodes.filter((node) => node.kind === "router").map((node) => node.id));
  const targetRouters = new Set(target.nodes.filter((node) => node.kind === "router").map((node) => node.id));
  const targetSkillIds = new Set(target.skills.map((skill) => skill.id));
  const targetLeafIds = new Set(target.nodes.filter((node) => node.kind === "leaf").map((node) => node.id));
  return {
    preservedSkillRefIds: source.skills.filter((skill) => targetSkillIds.has(skill.id)).map((skill) => skill.id).sort(compareStrings),
    preservedLeafNodeIds: source.nodes.filter((node) => node.kind === "leaf" && targetLeafIds.has(node.id)).map((node) => node.id).sort(compareStrings),
    addedRouterNodeIds: [...targetRouters].filter((id) => !sourceRouters.has(id)).sort(compareStrings),
    droppedRouterNodeIds: [...sourceRouters].filter((id) => !targetRouters.has(id)).sort(compareStrings),
    addedEdgeCount: [...targetEdges].filter((key) => !sourceEdges.has(key)).length,
    removedEdgeCount: [...sourceEdges].filter((key) => !targetEdges.has(key)).length,
    rewrittenBindingCount,
  };
}

function semanticResultValue(result: ArchitecturePatternMigrationResult): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    mode: result.mode,
    source: result.source,
    ...(result.target ? { target: { patternId: result.target.patternId, spec: result.target.spec, revisionDigest: result.target.revisionDigest } } : { target: null }),
    mappingStatus: result.mappingStatus,
    diff: result.diff,
    issues: result.issues,
  };
}

export function canonicalArchitecturePatternMigrationJson(result: ArchitecturePatternMigrationResult): string {
  return canonicalizeJson(semanticResultValue(result));
}

export function architecturePatternMigrationDigest(result: ArchitecturePatternMigrationResult): string {
  return sha256Hex(canonicalArchitecturePatternMigrationJson(result));
}

export function architecturePatternMigrationDiffDigest(diff: ArchitecturePatternMigrationDiff): string {
  return sha256Hex(canonicalizeJson(diff));
}

export const canonicalPatternMigrationJson = canonicalArchitecturePatternMigrationJson;
export const patternMigrationDigest = architecturePatternMigrationDigest;
export const patternMigrationDiffDigest = architecturePatternMigrationDiffDigest;

function blockedResult(
  source: unknown,
  targetPatternId: unknown,
  issues: ArchitecturePatternMigrationIssue[],
): ArchitecturePatternMigrationBlocked {
  const sourceRecord = isRecord(source) ? source : {};
  const rawPattern = isRecord(sourceRecord.pattern) ? sourceRecord.pattern : {};
  const sourcePatternId = isOneOf(rawPattern.id, architecturePatternIds)
    ? rawPattern.id
    : "flat";
  const sourceSummary = {
    architectureId: typeof sourceRecord.id === "string" ? sourceRecord.id : "",
    patternId: sourcePatternId,
    revisionDigest: (() => {
      try {
        return architectureDigest(sourceRecord as unknown as ArchitectureSpecV1);
      } catch {
        return sha256Hex(canonicalizeJson({ architectureId: typeof sourceRecord.id === "string" ? sourceRecord.id : "", patternId: sourcePatternId }));
      }
    })(),
  };
  const emptyDiff: ArchitecturePatternMigrationDiff = {
    preservedSkillRefIds: [],
    preservedLeafNodeIds: [],
    addedRouterNodeIds: [],
    droppedRouterNodeIds: [],
    addedEdgeCount: 0,
    removedEdgeCount: 0,
    rewrittenBindingCount: 0,
  };
  const result: ArchitecturePatternMigrationBlocked = {
    schemaVersion: architecturePatternMigrationSchemaVersion,
    mode: architecturePatternMigrationMode,
    source: sourceSummary,
    target: null,
    mappingStatus: "blocked",
    diff: emptyDiff,
    issues: issues.slice().sort((left, right) => (left.path ?? "").localeCompare(right.path ?? "") || left.code.localeCompare(right.code) || left.message.localeCompare(right.message)),
    migrationDigest: "",
    diffDigest: architecturePatternMigrationDiffDigest(emptyDiff),
  };
  result.migrationDigest = architecturePatternMigrationDigest(result);
  return result;
}

/**
 * Derive a new pattern shell candidate. Mapping, source, and transformed
 * limits fail closed as a blocked result; no exception escapes for expected
 * caller input errors.
 */
export function deriveArchitecturePatternMigration(input: ArchitecturePatternMigrationInput): ArchitecturePatternMigrationResult {
  const validation = validateArchitecturePatternMigrationInput(input);
  if (!validation.valid) return blockedResult(isRecord(input) ? input.source : undefined, isRecord(input) ? input.targetPatternId : undefined, validation.errors);
  const normalizedInput = validation.value;
  const source = normalizedInput.source;
  const targetPatternId = normalizedInput.targetPatternId;
  const mapping = normalizedInput.mapping;
  const sourceSummary: ArchitecturePatternMigrationSourceSummary = {
    architectureId: source.id,
    patternId: source.pattern.id,
    revisionDigest: architectureDigest(source),
  };

  if (source.pattern.id === targetPatternId) {
    if (mappingHasFields(mapping)) {
      return blockedResult(source, targetPatternId, [{
        code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_NOT_APPLICABLE",
        message: "A mapping is not applicable when source and target patterns are identical.",
        path: "mapping",
      }]);
    }
    const target = clone(source);
    const diff = buildDiff(source, target, 0);
    const result: ArchitecturePatternMigrationSuccess = {
      schemaVersion: architecturePatternMigrationSchemaVersion,
      mode: architecturePatternMigrationMode,
      source: sourceSummary,
      target: { patternId: targetPatternId, spec: target, revisionDigest: architectureDigest(target) },
      mappingStatus: "deterministic",
      diff,
      issues: [],
      migrationDigest: "",
      diffDigest: architecturePatternMigrationDiffDigest(diff),
    };
    result.migrationDigest = architecturePatternMigrationDigest(result);
    return result;
  }

  try {
    if (targetPatternId === "flat") {
      if (mappingHasFields(mapping)) {
        throw new ArchitecturePatternMigrationValidationError([{
          code: "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_NOT_APPLICABLE",
          message: "Mappings are not applicable to a flat target.",
          path: "mapping",
        }]);
      }
    }
    const topology = targetPatternId === "flat"
      ? buildFlatTopology(source)
      : targetPatternId === "domain-router"
        ? buildDomainTopology(source, mapping, targetPatternId)
        : buildMultiLevelTopology(source, mapping, targetPatternId);
    const draftTarget: ArchitectureSpecV1 = {
      ...clone(source),
      pattern: { id: targetPatternId, version: architectureSchemaVersion },
      nodes: topology.nodes,
      edges: topology.edges,
      entryNodeIds: topology.entryNodeIds,
      profiles: [],
    };

    const sourceExposures = new Map<string, Map<string, EffectiveExposure>>();
    for (const profile of source.profiles) {
      const profileExposures = new Map<string, EffectiveExposure>();
      for (const environment of source.environments) {
        if (environment.profileId !== profile.id) continue;
        for (const leaf of source.nodes.filter((node): node is ArchitectureLeafNode => node.kind === "leaf")) {
          profileExposures.set(`${environment.id}\u0000${leaf.id}`, effectiveLeafExposure(source, profile, environment.id, leaf.id));
        }
      }
      sourceExposures.set(profile.id, profileExposures);
    }

    let rewrittenBindingCount = 0;
    const rewrittenProfiles: ArchitectureProfile[] = [];
    for (const profile of source.profiles) {
      const rewritten = rewriteProfileBindings(source, draftTarget, profile, sourceExposures);
      rewrittenProfiles.push(rewritten.profile);
      rewrittenBindingCount += rewritten.oldCount + rewritten.newCount;
    }
    draftTarget.profiles = rewrittenProfiles;
    const target = assertValidArchitectureSpec(draftTarget);

    // Re-check the key safety property against the target compiler semantics.
    for (const profile of source.profiles) {
      for (const environment of source.environments) {
        const targetProfile = target.profiles.find((candidate) => candidate.id === profile.id);
        if (!targetProfile) throw new ArchitecturePatternMigrationValidationError([{
          code: "ARCHITECTURE_PATTERN_MIGRATION_EXPOSURE_NOT_PRESERVED",
          message: `Profile '${profile.id}' was not preserved.`,
          path: `profiles.${profile.id}`,
        }]);
        for (const leaf of source.nodes.filter((node): node is ArchitectureLeafNode => node.kind === "leaf")) {
          if (environment.profileId !== profile.id) continue;
          const before = effectiveLeafExposure(source, profile, environment.id, leaf.id);
          const after = effectiveLeafExposure(target, targetProfile, environment.id, leaf.id);
          if (before.enabled !== after.enabled || before.runtimeExposure !== after.runtimeExposure) {
            throw new ArchitecturePatternMigrationValidationError([{
              code: "ARCHITECTURE_PATTERN_MIGRATION_EXPOSURE_NOT_PRESERVED",
              message: `Effective exposure for leaf '${leaf.id}' changed in environment '${environment.id}'.`,
              path: `profiles.${profile.id}.bindings`,
            }]);
          }
        }
      }
    }

    const diff = buildDiff(source, target, rewrittenBindingCount);
    const mappingStatus: Exclude<ArchitecturePatternMigrationMappingStatus, "blocked"> = mappingHasFields(mapping)
      ? "provided"
      : targetPatternId === "multi-level-router"
        ? "fallback"
        : "deterministic";
    const result: ArchitecturePatternMigrationSuccess = {
      schemaVersion: architecturePatternMigrationSchemaVersion,
      mode: architecturePatternMigrationMode,
      source: sourceSummary,
      target: { patternId: targetPatternId, spec: target, revisionDigest: architectureDigest(target) },
      mappingStatus,
      diff,
      issues: [],
      migrationDigest: "",
      diffDigest: architecturePatternMigrationDiffDigest(diff),
    };
    result.migrationDigest = architecturePatternMigrationDigest(result);
    return result;
  } catch (error) {
    if (error instanceof ArchitecturePatternMigrationValidationError) return blockedResult(source, targetPatternId, error.errors);
    if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
      const issues = error.errors.filter((issue): issue is Record<string, unknown> => isRecord(issue)).map((issue) => ({
        code: typeof issue.code === "string" ? issue.code : "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID",
        message: typeof issue.message === "string" ? issue.message : "Transformed architecture is invalid.",
        ...(typeof issue.path === "string" ? { path: issue.path } : {}),
      }));
      return blockedResult(source, targetPatternId, issues.length > 0 ? issues : [{
        code: "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID",
        message: "Transformed architecture is invalid.",
      }]);
    }
    return blockedResult(source, targetPatternId, [{
      code: "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID",
      message: "Transformed architecture could not be derived.",
    }]);
  }
}

export const derivePatternMigration = deriveArchitecturePatternMigration;
export const migrateArchitecturePattern = deriveArchitecturePatternMigration;
