import {
  ArchitectureCompileError,
  ArchitectureValidationError,
  architecturePatternIds,
  assertValidArchitectureSpec,
  canonicalArchitectureJson,
  compileArchitecture as compileCoreArchitecture,
  mermaidArchitecture,
  planArchitectureSync,
  validateArchitectureSpec as validateCoreArchitectureSpec,
  type ArchitectureCompileOptions,
  type ArchitectureNode,
  type ArchitecturePatternId,
  type ArchitectureSpecV1,
  type ArchitectureSyncPlan,
  type AuthorizedRegistrySnapshot,
  type CompiledArchitecture,
  type ObservedArchitectureState,
} from "@myskills-app/core";
import { AppError } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";

const ARCHITECTURE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SKILL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const MAX_ARCHITECTURES_PER_OWNER = 25;
export const MAX_REVISIONS_PER_ARCHITECTURE = 50;
export const MAX_CANONICAL_SPEC_BYTES = 128 * 1024;
export const MAX_ARCHITECTURE_RESOLUTION_CANDIDATES = 100;
export const MAX_ARCHITECTURE_RESOLUTION_SKILL_REFERENCES = 1_000;

export const architectureTargetObservationSchemaVersion = "myskills.target-observation.v1" as const;

export interface ArchitectureTargetObservation {
  schemaVersion: typeof architectureTargetObservationSchemaVersion;
  target: {
    id: string;
    toolKind: string;
    adapterVersion: string;
    capabilities: Record<string, boolean>;
  };
  observedState: ObservedArchitectureState;
}

export interface ArchitectureResolutionCandidateInput {
  architectureId: string;
  architectureName: string;
  revisionId: string;
  revisionNumber: number;
  patternId: ArchitecturePatternId;
  profileId: string;
  environmentId: string;
  environmentKind: "personal" | "work" | "team";
  compiled: CompiledArchitecture;
  plan: ArchitectureSyncPlan;
}

export interface ArchitectureResolutionCandidate {
  architectureId: string;
  architectureName: string;
  revisionId: string;
  revisionNumber: number;
  revisionDigest: string;
  patternId: ArchitecturePatternId;
  profileId: string;
  environmentId: string;
  environmentKind: "personal" | "work" | "team";
  score: number;
  confidence: "none" | "low" | "medium" | "high";
  canConfigure: boolean;
  reasons: string[];
  blockers: string[];
  summary: {
    observedNodeCount: number;
    matchedObservedNodeCount: number;
    desiredNodeCount: number;
    exactNodeCount: number;
    changeCount: number;
    blockingChangeCount: number;
  };
  plan: ArchitectureSyncPlan;
}

export type ArchitectureResolutionCandidateSummary = Omit<ArchitectureResolutionCandidate, "plan">;

export interface ArchitectureResolution {
  status: "resolved" | "ambiguous" | "no-match";
  confidence: ArchitectureResolutionCandidate["confidence"];
  selected: ArchitectureResolutionCandidate | null;
  candidates: ArchitectureResolutionCandidateSummary[];
  candidateCount: number;
  truncated: boolean;
}

export interface ApiArchitecturePattern {
  id: ArchitecturePatternId;
  version: 1;
  name: string;
  description: string;
  supportsNestedRouters: boolean;
}

export const ARCHITECTURE_PATTERNS: ApiArchitecturePattern[] = [
  {
    id: "flat",
    version: 1,
    name: "Flat skill set",
    description: "A single-level set of leaf skills with no router hierarchy.",
    supportsNestedRouters: false,
  },
  {
    id: "domain-router",
    version: 1,
    name: "Domain router",
    description: "One router routes requests to leaf skills grouped under a domain.",
    supportsNestedRouters: false,
  },
  {
    id: "multi-level-router",
    version: 1,
    name: "Multi-level router",
    description: "Nested routers route to other routers and leaf skills.",
    supportsNestedRouters: true,
  },
];

export interface ArchitectureGraphNode {
  id: string;
  kind: ArchitectureNode["kind"];
  label: string;
  depth: number;
  x: number;
  y: number;
  skillRefId?: string;
}

export interface ArchitectureGraph {
  digest: string;
  nodes: ArchitectureGraphNode[];
  edges: CompiledArchitecture["edges"];
  mermaid: string;
}

export function patternById(patternId: string): ApiArchitecturePattern | undefined {
  return ARCHITECTURE_PATTERNS.find((pattern) => pattern.id === patternId);
}

export function validateArchitecturePattern(input: unknown): ArchitecturePatternId {
  if (typeof input !== "string" || !(architecturePatternIds as readonly string[]).includes(input)) {
    throw new AppError("Architecture pattern is invalid.", "INVALID_ARCHITECTURE_PATTERN", 400);
  }
  return input as ArchitecturePatternId;
}

export function validateArchitectureSpec(input: unknown, expectedPatternId?: ArchitecturePatternId): ArchitectureSpecV1 {
  const result = validateCoreArchitectureSpec(input);
  if (!result.valid) {
    const preferred = result.errors.find((error) => error.code === "ARCHITECTURE_CYCLE")
      ?? result.errors.find((error) => error.code === "ARCHITECTURE_ORPHAN_NODE")
      ?? result.errors[0];
    throw new AppError(
      preferred?.message ?? "Architecture is invalid.",
      preferred?.code ?? "INVALID_ARCHITECTURE_SPEC",
      422,
      { issues: result.errors },
    );
  }
  if (expectedPatternId && result.value.pattern.id !== expectedPatternId) {
    throw new AppError("Revision pattern must match the architecture pattern.", "ARCHITECTURE_PATTERN_MISMATCH", 400);
  }
  assertArchitectureSpecSize(result.value);
  return result.value;
}

export function assertArchitectureSpecSize(spec: ArchitectureSpecV1): void {
  const bytes = Buffer.byteLength(canonicalArchitectureJson(spec), "utf8");
  if (bytes > MAX_CANONICAL_SPEC_BYTES) {
    throw new AppError(
      `Architecture specification exceeds ${MAX_CANONICAL_SPEC_BYTES} bytes.`,
      "ARCHITECTURE_SPEC_TOO_LARGE",
      413,
      { maxBytes: MAX_CANONICAL_SPEC_BYTES },
    );
  }
}

export function compileArchitecture(
  spec: ArchitectureSpecV1,
  registry: AuthorizedRegistrySnapshot,
  options: { profileId?: string; environmentId?: string } = {},
): CompiledArchitecture {
  try {
    const normalized = assertValidArchitectureSpec(spec);
    assertArchitectureSpecSize(normalized);
    const compileOptions: ArchitectureCompileOptions = {
      registry,
      ...(options.profileId ? { profileId: options.profileId } : {}),
      ...(options.environmentId ? { environmentId: options.environmentId } : {}),
    };
    return compileCoreArchitecture(normalized, compileOptions);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ArchitectureCompileError || error instanceof ArchitectureValidationError) {
      throw new AppError(error.message, error.code, error.statusCode, "errors" in error ? { issues: error.errors } : undefined);
    }
    throw error;
  }
}

export function graphForCompiledArchitecture(compiled: CompiledArchitecture): ArchitectureGraph {
  const depthById = new Map<string, number>();
  const childrenById = new Map<string, string[]>();
  for (const node of compiled.nodes) childrenById.set(node.id, []);
  for (const edge of compiled.edges) childrenById.set(edge.from, [...(childrenById.get(edge.from) ?? []), edge.to]);
  const roots = compiled.nodes.filter((node) => !compiled.edges.some((edge) => edge.to === node.id)).map((node) => node.id).sort();
  const queue = roots.map((root) => {
    depthById.set(root, 0);
    return root;
  });
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of (childrenById.get(current) ?? []).sort()) {
      const nextDepth = (depthById.get(current) ?? 0) + 1;
      if (!depthById.has(child) || nextDepth < (depthById.get(child) ?? Number.POSITIVE_INFINITY)) {
        depthById.set(child, nextDepth);
        queue.push(child);
      }
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const node of compiled.nodes) {
    const depth = depthById.get(node.id) ?? 0;
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), node.id]);
  }
  for (const ids of byDepth.values()) ids.sort();
  const nodes = compiled.nodes
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => {
      const depth = depthById.get(node.id) ?? 0;
      const index = (byDepth.get(depth) ?? []).indexOf(node.id);
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        depth,
        x: index * 260,
        y: depth * 140,
        ...(node.skillRefId ? { skillRefId: node.skillRefId } : {}),
      };
    });
  return {
    digest: compiled.revisionDigest,
    nodes,
    edges: compiled.edges,
    mermaid: mermaidArchitecture(compiled),
  };
}

export function outlineForArchitecture(compiled: CompiledArchitecture): {
  title: string;
  text: string;
  tree: Array<{ id: string; label: string; kind: ArchitectureNode["kind"]; children: unknown[] }>;
} {
  const nodeById = new Map(compiled.nodes.map((node) => [node.id, node]));
  const childrenById = new Map<string, string[]>();
  for (const edge of compiled.edges) childrenById.set(edge.from, [...(childrenById.get(edge.from) ?? []), edge.to]);
  for (const children of childrenById.values()) children.sort();
  const roots = compiled.nodes.filter((node) => !compiled.edges.some((edge) => edge.to === node.id)).map((node) => node.id).sort();
  const textLines = [`Architecture ${compiled.architectureId}`];
  const makeNode = (id: string, depth: number): { id: string; label: string; kind: ArchitectureNode["kind"]; children: unknown[] } => {
    const node = nodeById.get(id);
    if (!node) throw new ArchitectureCompileError("ARCHITECTURE_NODE_NOT_FOUND", `Compiled node '${id}' is unavailable.`);
    textLines.push(`${"  ".repeat(depth)}- ${node.label} (${node.kind})`);
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      children: (childrenById.get(node.id) ?? []).map((childId) => makeNode(childId, depth + 1)),
    };
  };
  const tree = roots.map((id) => makeNode(id, 0));
  return { title: `Architecture ${compiled.architectureId}`, text: textLines.join("\n"), tree };
}

export function planSync(compiled: CompiledArchitecture, fixture: unknown) {
  const observed = parseObservedArchitectureState(fixture);
  try {
    return planArchitectureSync(compiled, observed);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ArchitectureCompileError || error instanceof ArchitectureValidationError) {
      throw new AppError(error.message, error.code, error.statusCode, "errors" in error ? { issues: error.errors } : undefined);
    }
    throw error;
  }
}

export function parseArchitectureTargetObservation(input: unknown): ArchitectureTargetObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("Target observation is required.", "INVALID_TARGET_OBSERVATION", 400);
  }
  const observation = input as Record<string, unknown>;
  rejectUnknownKeys(observation, ["schemaVersion", "target", "observedState"]);
  if (observation.schemaVersion !== architectureTargetObservationSchemaVersion) {
    throw new AppError("Target observation schemaVersion is unsupported.", "TARGET_OBSERVATION_SCHEMA_UNSUPPORTED", 400);
  }
  if (!observation.target || typeof observation.target !== "object" || Array.isArray(observation.target)) {
    throw new AppError("Target observation target is required.", "INVALID_TARGET_OBSERVATION", 400);
  }
  const target = observation.target as Record<string, unknown>;
  rejectUnknownKeys(target, ["id", "toolKind", "adapterVersion", "capabilities"]);
  const id = requiredFixtureString(target.id, "target.id");
  const toolKind = requiredTargetText(target.toolKind, "target.toolKind", 64, true);
  const adapterVersion = requiredTargetText(target.adapterVersion, "target.adapterVersion", 128, false);
  const capabilities = parseTargetCapabilities(target.capabilities);
  const observedState = parseObservedArchitectureState(observation.observedState);
  if (observedState.targetId !== id) {
    throw new AppError("Target observation ids do not match.", "TARGET_OBSERVATION_ID_MISMATCH", 400);
  }
  return {
    schemaVersion: architectureTargetObservationSchemaVersion,
    target: { id, toolKind, adapterVersion, capabilities },
    observedState,
  };
}

export function resolveArchitectureCandidates(
  observation: ArchitectureTargetObservation,
  inputs: readonly ArchitectureResolutionCandidateInput[],
): ArchitectureResolution {
  const scored = inputs.map((input) => scoreArchitectureResolutionCandidate(observation, input));
  scored.sort(compareResolutionCandidates);
  const candidateCount = scored.length;
  const candidates = scored.slice(0, 10).map(({ plan: _plan, ...candidate }) => candidate);
  const top = scored[0];
  const second = scored[1];
  if (!top || top.score === 0) {
    return {
      status: "no-match",
      confidence: "none",
      selected: null,
      candidates,
      candidateCount,
      truncated: candidateCount > candidates.length,
    };
  }
  const clearMargin = !second || top.score - second.score >= 10;
  const resolved = top.score >= 60 && clearMargin;
  return {
    status: resolved ? "resolved" : "ambiguous",
    confidence: top.confidence,
    selected: resolved ? top : null,
    candidates,
    candidateCount,
    truncated: candidateCount > candidates.length,
  };
}

function scoreArchitectureResolutionCandidate(
  observation: ArchitectureTargetObservation,
  input: ArchitectureResolutionCandidateInput,
): ArchitectureResolutionCandidate {
  const canInspectRouters = observation.target.capabilities.canInspectRouters === true;
  const scorableNodes = input.compiled.nodes.filter((node) => node.kind !== "router" || canInspectRouters);
  const scorableNodeIds = new Set(scorableNodes.map((node) => node.id));
  const allNodeIds = new Set(input.compiled.allNodes.map((node) => node.id));
  const observedNodeCount = observedArchitectureNodeCount(observation.observedState, canInspectRouters);
  const matchedObservedNodeIds = new Set<string>();
  const matchedDesiredNodeIds = new Set<string>();
  const exactNodeIds = new Set<string>();
  const blockers: string[] = [];
  let changeCount = 0;
  let blockingChangeCount = 0;

  for (const item of input.plan.items) {
    if (item.action !== "noop") changeCount += 1;
    if (item.action === "conflict" || item.action === "unsupported") {
      blockingChangeCount += 1;
      blockers.push(`${item.action}:${item.nodeId}`);
    }
    if (item.observed !== undefined && allNodeIds.has(item.nodeId)) {
      matchedObservedNodeIds.add(item.nodeId);
    }
    if (!scorableNodeIds.has(item.nodeId) || item.observed === undefined) continue;
    matchedDesiredNodeIds.add(item.nodeId);
    if (item.action === "noop") exactNodeIds.add(item.nodeId);
  }

  const desiredNodeCount = scorableNodes.length;
  const observedCoverage = observedNodeCount === 0 ? 0 : Math.min(1, matchedObservedNodeIds.size / observedNodeCount);
  const desiredCoverage = desiredNodeCount === 0 ? 0 : matchedDesiredNodeIds.size / desiredNodeCount;
  const exactCoverage = desiredNodeCount === 0 ? 0 : exactNodeIds.size / desiredNodeCount;
  const score = Math.max(0, Math.min(100, Math.round(
    observedCoverage * 50
    + desiredCoverage * 30
    + exactCoverage * 20,
  )));
  const confidence: ArchitectureResolutionCandidate["confidence"] = score >= 85
    ? "high"
    : score >= 60
      ? "medium"
      : score > 0
        ? "low"
        : "none";
  const capabilityBlockers = configurationCapabilityBlockers(observation, input);
  blockers.push(...capabilityBlockers);
  const reasons = [
    `Matched ${matchedObservedNodeIds.size} of ${observedNodeCount} observed nodes.`,
    `${exactNodeIds.size} of ${desiredNodeCount} comparable desired nodes are exact.`,
    `${changeCount} dry-run changes remain.`,
  ];
  if (!canInspectRouters && input.compiled.nodes.some((node) => node.kind === "router")) {
    reasons.push("The adapter cannot inspect router topology, so routers did not increase match confidence.");
  }
  return {
    architectureId: input.architectureId,
    architectureName: input.architectureName,
    revisionId: input.revisionId,
    revisionNumber: input.revisionNumber,
    revisionDigest: input.compiled.revisionDigest,
    patternId: input.patternId,
    profileId: input.profileId,
    environmentId: input.environmentId,
    environmentKind: input.environmentKind,
    score,
    confidence,
    canConfigure: blockers.length === 0,
    reasons,
    blockers: [...new Set(blockers)].sort(),
    summary: {
      observedNodeCount,
      matchedObservedNodeCount: matchedObservedNodeIds.size,
      desiredNodeCount,
      exactNodeCount: exactNodeIds.size,
      changeCount,
      blockingChangeCount,
    },
    plan: input.plan,
  };
}

function observedArchitectureNodeCount(observed: ObservedArchitectureState, canInspectRouters: boolean): number {
  return (observed.skills?.length ?? 0)
    + (canInspectRouters ? observed.routers?.length ?? 0 : 0)
    + (observed.nodes?.filter((node) => canInspectRouters || node.kind !== "router").length ?? 0);
}

function configurationCapabilityBlockers(
  observation: ArchitectureTargetObservation,
  input: ArchitectureResolutionCandidateInput,
): string[] {
  const capabilities = observation.target.capabilities;
  const blockers: string[] = [];
  const actions = new Set(input.plan.items.map((item) => item.action));
  if (actions.has("install") && capabilities.canInstall !== true) blockers.push("capability:canInstall");
  if ((actions.has("update") || actions.has("downgrade")) && capabilities.canUpdate !== true) blockers.push("capability:canUpdate");
  if (actions.has("remove") && capabilities.canRemove !== true) blockers.push("capability:canRemove");
  if ((actions.has("enable") || actions.has("disable")) && capabilities.canEnable !== true) blockers.push("capability:canEnable");
  if (actions.has("configure-router") && capabilities.canConfigureRouters !== true) blockers.push("capability:canConfigureRouters");
  return blockers;
}

function compareResolutionCandidates(left: ArchitectureResolutionCandidate, right: ArchitectureResolutionCandidate): number {
  return right.score - left.score
    || left.summary.blockingChangeCount - right.summary.blockingChangeCount
    || left.summary.changeCount - right.summary.changeCount
    || left.architectureId.localeCompare(right.architectureId)
    || left.environmentId.localeCompare(right.environmentId)
    || left.profileId.localeCompare(right.profileId);
}

function requiredTargetText(value: unknown, field: string, maxLength: number, identifierOnly: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new AppError(`Target observation ${field} is invalid.`, "INVALID_TARGET_OBSERVATION", 400);
  }
  if (identifierOnly && !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new AppError(`Target observation ${field} is invalid.`, "INVALID_TARGET_OBSERVATION", 400);
  }
  return value;
}

function parseTargetCapabilities(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("Target observation capabilities are required.", "INVALID_TARGET_OBSERVATION", 400);
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 32) {
    throw new AppError("Target observation capabilities are invalid.", "INVALID_TARGET_OBSERVATION", 400);
  }
  const capabilities: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)
      || /path|secret|token|password|credential|privatekey|package|connection|endpoint|url/i.test(key)
      || typeof value !== "boolean"
    ) {
      throw new AppError("Target observation capabilities are invalid.", "INVALID_TARGET_OBSERVATION", 400);
    }
    capabilities[key] = value;
  }
  return capabilities;
}

export function sanitizeArchitectureAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeAuditDetails(details);
}

export function parseObservedArchitectureState(input: unknown): ObservedArchitectureState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("Sync fixture is required.", "INVALID_SYNC_FIXTURE", 400);
  }
  const fixture = input as Record<string, unknown>;
  rejectUnknownKeys(fixture, ["targetId", "environmentId", "skills", "routers", "nodes"]);
  const targetId = requiredFixtureString(fixture.targetId, "targetId");
  const environmentId = fixture.environmentId === undefined ? undefined : requiredFixtureString(fixture.environmentId, "environmentId");
  const skills = parseFixtureArray(fixture.skills, "skills", ["nodeId", "skillRefId", "slug", "version", "digest", "enabled", "runtimeExposure", "managed", "supported"]);
  const routers = parseFixtureArray(fixture.routers, "routers", ["nodeId", "configurationDigest", "configured", "managed", "supported"]);
  const nodes = parseFixtureArray(fixture.nodes, "nodes", ["nodeId", "kind", "skillRefId", "slug", "version", "digest", "enabled", "runtimeExposure", "configurationDigest", "configured", "managed", "supported"]);
  return {
    targetId,
    ...(environmentId ? { environmentId } : {}),
    ...(skills ? { skills: skills as unknown as ObservedArchitectureState["skills"] } : {}),
    ...(routers ? { routers: routers as unknown as ObservedArchitectureState["routers"] } : {}),
    ...(nodes ? { nodes: nodes as unknown as ObservedArchitectureState["nodes"] } : {}),
  };
}

function parseFixtureArray(input: unknown, field: string, allowed: string[]): Record<string, unknown>[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 500) {
    throw new AppError(`Sync fixture ${field} is invalid.`, "INVALID_SYNC_FIXTURE", 400);
  }
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new AppError(`Sync fixture ${field}[${index}] is invalid.`, "INVALID_SYNC_FIXTURE", 400);
    }
    const value = item as Record<string, unknown>;
    rejectUnknownKeys(value, allowed);
    const normalized: Record<string, unknown> = {};
    for (const key of ["nodeId", "skillRefId", "slug", "version"] as const) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 128) invalidFixtureItem(field, index, key);
      if (key === "nodeId" || key === "skillRefId") {
        normalized[key] = fixtureArchitectureIdentifier(value[key], field, index, key);
      } else if (key === "slug") {
        normalized[key] = fixtureSkillSlug(value[key], field, index);
      } else {
        normalized[key] = value[key];
      }
    }
    for (const key of ["enabled", "managed", "supported", "configured"] as const) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "boolean") invalidFixtureItem(field, index, key);
      normalized[key] = value[key];
    }
    if (value.kind !== undefined) {
      if (value.kind !== "router" && value.kind !== "leaf") invalidFixtureItem(field, index, "kind");
      normalized.kind = value.kind;
    }
    if (value.runtimeExposure !== undefined) {
      if (value.runtimeExposure !== "disabled" && value.runtimeExposure !== "router" && value.runtimeExposure !== "leaf") invalidFixtureItem(field, index, "runtimeExposure");
      normalized.runtimeExposure = value.runtimeExposure;
    }
    for (const key of ["digest", "configurationDigest"] as const) {
      if (value[key] === undefined) continue;
      if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) invalidFixtureItem(field, index, key);
      normalized[key] = value[key];
    }
    if (value.version !== undefined && (typeof value.version !== "string"
      || CONTROL_CHARACTER_PATTERN.test(value.version)
      || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version))) {
      invalidFixtureItem(field, index, "version");
    }
    if (field === "skills" && (typeof normalized.slug !== "string" || typeof normalized.version !== "string" || typeof normalized.digest !== "string" || typeof normalized.enabled !== "boolean")) {
      throw new AppError(`Sync fixture ${field}[${index}] requires slug, version, digest, and enabled.`, "INVALID_SYNC_FIXTURE", 400);
    }
    if ((field === "routers" || field === "nodes") && typeof normalized.nodeId !== "string") {
      throw new AppError(`Sync fixture ${field}[${index}] requires nodeId.`, "INVALID_SYNC_FIXTURE", 400);
    }
    return normalized;
  });
}

function invalidFixtureItem(field: string, index: number, key: string): never {
  throw new AppError(`Sync fixture ${field}[${index}].${key} is invalid.`, "INVALID_SYNC_FIXTURE", 400);
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: string[]): void {
  const forbidden = Object.keys(input).find((key) => /path|secret|token|password|credential|private[-_ ]?key|package|connection|endpoint|url/i.test(key));
  if (forbidden) {
    throw new AppError(`Sync fixture field is not accepted: ${forbidden}.`, "UNSUPPORTED_ARCHITECTURE_FIELD", 400);
  }
  const unsupported = Object.keys(input).find((key) => !allowed.includes(key));
  if (unsupported) {
    throw new AppError(`Sync fixture field is not accepted: ${unsupported}.`, "UNSUPPORTED_ARCHITECTURE_FIELD", 400);
  }
}

function requiredFixtureString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new AppError(`Sync fixture ${field} is required.`, "INVALID_SYNC_FIXTURE", 400);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value) || !ARCHITECTURE_IDENTIFIER_PATTERN.test(value)) {
    throw new AppError(`Sync fixture ${field} is invalid.`, "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  }
  return value;
}

function fixtureArchitectureIdentifier(value: string, field: string, index: number, key: string): string {
  if (CONTROL_CHARACTER_PATTERN.test(value) || !ARCHITECTURE_IDENTIFIER_PATTERN.test(value)) {
    throw new AppError(`Sync fixture ${field}[${index}].${key} is invalid.`, "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  }
  return value;
}

function fixtureSkillSlug(value: string, field: string, index: number): string {
  if (CONTROL_CHARACTER_PATTERN.test(value) || !SKILL_SLUG_PATTERN.test(value) || value.includes("--")) {
    throw new AppError(`Sync fixture ${field}[${index}].slug is invalid.`, "INVALID_SKILL_SLUG", 400);
  }
  return value;
}
