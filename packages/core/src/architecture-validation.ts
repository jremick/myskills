import {
  architectureEdgeKinds,
  architectureEnvironmentKinds,
  architectureLimits,
  architectureNodeKinds,
  architecturePackageVisibilityScopes,
  architecturePatternIds,
  architectureSchemaVersion,
  architectureSubjectKinds,
  runtimeExposureModes,
  ArchitectureValidationError,
  type ArchitectureEdge,
  type ArchitectureEdgeKind,
  type ArchitectureEnvironment,
  type ArchitectureEnvironmentKind,
  type ArchitectureMetadata,
  type ArchitectureNode,
  type ArchitectureNodeKind,
  type ArchitecturePackageVisibility,
  type ArchitecturePatternId,
  type ArchitectureProfile,
  type ArchitectureProfileBinding,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
  type ArchitectureSubjectKind,
  type ArchitectureValidationCode,
  type ArchitectureValidationIssue,
  type ArchitectureValidationResult,
  type RuntimeExposureMode,
} from "./architecture-contracts.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const skillSlugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const metadataKeyPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const metadataControlCharacterPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const unsafeMetadataValuePattern = /(?:\b(?:https?|ftp):\/\/|(?:^|[\s(])(?:\/\/|\\\\|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/(?:[A-Za-z0-9._-]+[\\/])|\/(?:Users|home|root|private|var|tmp|etc|opt|workspace|mnt|Volumes)(?:[\\/]|$))|(?:^|[\s(])(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+(?:$|[\s)])|(?:^|[\s(])(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[\\/]|$)|-----BEGIN [A-Z0-9 ]+-----|\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_ -]?key|auth(?:entication|orization)?|credential|password|private[-_ ]?key|secret|token)\b\s*[:=]\s*\S+|\b(?:secret|token|credential|password|private\s+key|api\s+key|authorization|authentication|prompt|content|body|package\s+bytes?)\b)/i;
const sensitiveMetadataWords = new Set([
  "api",
  "archive",
  "auth",
  "authentication",
  "authorization",
  "bearer",
  "body",
  "bundle",
  "certificate",
  "ciphertext",
  "content",
  "contents",
  "cookie",
  "credential",
  "directory",
  "endpoint",
  "file",
  "filename",
  "filepath",
  "filesystem",
  "header",
  "host",
  "location",
  "package",
  "password",
  "path",
  "prompt",
  "private",
  "secret",
  "token",
  "uri",
  "url",
  "username",
]);
const sensitiveMetadataCompounds = new Set(["apikey", "privatekey"]);
const metadataMaximumInspectionDepth = 4;
const metadataMaximumInspectionEntries = architectureLimits.metadataKeys * 4;

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

function metadataFieldPath(path: string, key: string): string {
  // Keep diagnostics location-specific while preventing malformed field names
  // from injecting control characters or unbounded text into logs/responses.
  const safeSegment = metadataKeyPattern.test(key) ? key : "<field>";
  return `${path}.${safeSegment}`;
}

function isSensitiveMetadataKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized.length === 0) return false;
  const words = normalized.split(/\s+/);
  const compact = words.join("");
  return words.some((word) => sensitiveMetadataWords.has(word))
    || sensitiveMetadataWords.has(compact)
    || sensitiveMetadataCompounds.has(compact);
}

interface MetadataInspectionState {
  entries: number;
  seen: WeakSet<object>;
}

function validateMetadataValue(
  value: unknown,
  errors: ArchitectureValidationIssue[],
  path: string,
  state: MetadataInspectionState,
  depth: number,
): void {
  if (typeof value === "string") {
    if (value.length > architectureLimits.metadataStringLength) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Metadata strings may contain at most ${architectureLimits.metadataStringLength} characters.`, path);
    }
    if (metadataControlCharacterPattern.test(value) || unsafeMetadataValuePattern.test(value)) {
      pushIssue(errors, "ARCHITECTURE_METADATA_UNSAFE_VALUE", "Metadata values must not contain sensitive material, paths, URLs, or control characters.", path);
    }
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (depth >= metadataMaximumInspectionDepth || state.entries >= metadataMaximumInspectionEntries) {
    pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", "Nested metadata must remain within the bounded metadata inspection limit.", path);
    return;
  }
  if (state.seen.has(value)) {
    pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata values must be scalar.", path);
    return;
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > architectureLimits.metadataKeys) {
        pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Nested metadata arrays may contain at most ${architectureLimits.metadataKeys} items.`, path);
      }
      for (const [index, item] of value.slice(0, architectureLimits.metadataKeys).entries()) {
        state.entries += 1;
        validateMetadataValue(item, errors, `${path}[${index}]`, state, depth + 1);
      }
      return;
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > architectureLimits.metadataKeys) {
      pushIssue(errors, "ARCHITECTURE_LIMIT_EXCEEDED", `Nested metadata objects may contain at most ${architectureLimits.metadataKeys} fields.`, path);
    }
    for (const [key, item] of entries.slice(0, architectureLimits.metadataKeys)) {
      const fieldPath = metadataFieldPath(path, key);
      if (!metadataKeyPattern.test(key)) {
        pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata field name is invalid.", fieldPath);
      } else if (isSensitiveMetadataKey(key)) {
        pushIssue(errors, "ARCHITECTURE_METADATA_SENSITIVE_FIELD", "Metadata field is not allowed in metadata-only architecture records.", fieldPath);
      }
      state.entries += 1;
      validateMetadataValue(item, errors, fieldPath, state, depth + 1);
    }
  } finally {
    state.seen.delete(value);
  }
}

export function validateMetadata(value: unknown, errors: ArchitectureValidationIssue[], path: string): void {
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
  const state: MetadataInspectionState = { entries: 0, seen: new WeakSet<object>() };
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const fieldPath = metadataFieldPath(path, key);
    if (!metadataKeyPattern.test(key) || key.length === 0 || key.length > architectureLimits.metadataKeyLength) {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata field name is invalid.", fieldPath);
    } else if (isSensitiveMetadataKey(key)) {
      pushIssue(errors, "ARCHITECTURE_METADATA_SENSITIVE_FIELD", "Metadata field is not allowed in metadata-only architecture records.", fieldPath);
    }
    if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata values must be scalar.", fieldPath);
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      pushIssue(errors, "ARCHITECTURE_METADATA_NOT_METADATA", "Metadata numbers must be finite.", fieldPath);
    }
    state.entries += 1;
    validateMetadataValue(item, errors, fieldPath, state, 0);
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
