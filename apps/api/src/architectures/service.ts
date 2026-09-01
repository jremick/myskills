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
export const MAX_VISIBLE_ARCHITECTURES = 500;
export const MAX_REVISIONS_PER_ARCHITECTURE = 50;
export const MAX_CANONICAL_SPEC_BYTES = 128 * 1024;

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

export function sanitizeArchitectureAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  return sanitizeAuditDetails(details);
}

function parseObservedArchitectureState(input: unknown): ObservedArchitectureState {
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
