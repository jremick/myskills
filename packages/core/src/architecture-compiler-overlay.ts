import {
  architectureSchemaVersion,
  ArchitectureCompileError,
  type ArchitectureBindingDecision,
  type ArchitectureBindingProvenanceReason,
  type ArchitectureCompileOptions,
  type ArchitectureEnvironment,
  type ArchitectureEnvironmentResolution,
  type ArchitectureEnvironmentResolutionOptions,
  type ArchitectureProfileBinding,
  type ArchitectureProfileBindingResolution,
  type ArchitectureProfileBindingResolutionOptions,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
  type ArchitectureValidationIssue,
  type AuthorizedRegistrySkillSnapshot,
  type AuthorizedRegistrySnapshot,
  type CompiledArchitecture,
  type CompiledArchitectureNode,
  type CompiledRouterConfiguration,
} from "./architecture-contracts.js";
import { assertValidArchitectureSpec, validateMetadata } from "./architecture-validation.js";
import { architectureDigest, canonicalizeJson, sha256Hex } from "./architecture-canonical.js";

function resolveCompileOptions(input: ArchitectureCompileOptions | AuthorizedRegistrySnapshot): ArchitectureCompileOptions {
  if (Array.isArray(input)) return { registry: input as AuthorizedRegistrySnapshot };
  return input as ArchitectureCompileOptions;
}

/**
 * Return the selected environment followed by its inheritance chain.
 *
 * The helper intentionally accepts an environment object as well as an ID so
 * callers that already hold a normalized environment can use it without
 * reconstructing a second selector. The declared spec remains authoritative
 * for parent relationships.
 */
export function environmentAncestors(spec: ArchitectureSpecV1, environmentOrId: ArchitectureEnvironment | string): string[] {
  const environmentId = typeof environmentOrId === "string" ? environmentOrId : environmentOrId.id;
  const byId = new Map(spec.environments.map((candidate) => [candidate.id, candidate]));
  let current = byId.get(environmentId);
  if (!current) {
    throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_REQUIRED", "A valid environment must be selected before compilation.");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) {
      throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_PARENT_CYCLE", "Environment inheritance must be acyclic.");
    }
    seen.add(current.id);
    result.push(current.id);
    if (typeof current.parentId !== "string") break;
    const parent = byId.get(current.parentId);
    if (!parent) {
      throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_UNKNOWN_PARENT", "Environment parent does not exist.");
    }
    current = parent;
  }
  return result;
}

/** Resolve one explicit logical environment and its bound profile. */
export function resolveArchitectureEnvironment(
  specInput: ArchitectureSpecV1,
  options: ArchitectureEnvironmentResolutionOptions = {},
): ArchitectureEnvironmentResolution {
  const spec = assertValidArchitectureSpec(specInput);
  const environment = options.environmentId === undefined
    ? (spec.environments.length === 1 ? spec.environments[0] : undefined)
    : spec.environments.find((candidate) => candidate.id === options.environmentId);
  if (!environment) {
    throw new ArchitectureCompileError("ARCHITECTURE_ENVIRONMENT_REQUIRED", "A valid environment must be selected before compilation.");
  }
  const profileId = options.profileId ?? environment.profileId;
  if (profileId !== environment.profileId) {
    throw new ArchitectureCompileError("ARCHITECTURE_PROFILE_ENVIRONMENT_MISMATCH", "Selected profile is not bound to the selected environment.");
  }
  const profile = spec.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new ArchitectureCompileError("ARCHITECTURE_PROFILE_REQUIRED", "A valid profile must be selected before compilation.");
  }
  return { environment, profile, ancestorIds: environmentAncestors(spec, environment) };
}

interface RankedArchitectureBinding {
  binding: ArchitectureProfileBinding;
  denied: boolean;
  specificity: number;
  sourceEnvironmentId?: string;
  wildcard: boolean;
  scopeKey: string;
}

function rankArchitectureBinding(
  binding: ArchitectureProfileBinding,
  ancestorIds: readonly string[],
): RankedArchitectureBinding | undefined {
  if (binding.environmentIds === undefined) {
    return {
      binding,
      denied: !binding.enabled || binding.runtimeExposure === "disabled",
      specificity: Number.POSITIVE_INFINITY,
      wildcard: true,
      scopeKey: "*",
    };
  }
  const sourceEnvironmentId = ancestorIds.find((id) => binding.environmentIds?.includes(id));
  if (sourceEnvironmentId === undefined) return undefined;
  return {
    binding,
    denied: !binding.enabled || binding.runtimeExposure === "disabled",
    specificity: ancestorIds.indexOf(sourceEnvironmentId),
    sourceEnvironmentId,
    wildcard: false,
    scopeKey: binding.environmentIds.slice().sort().join(","),
  };
}

function bindingProvenanceReason(
  ranked: RankedArchitectureBinding | undefined,
): ArchitectureBindingProvenanceReason {
  if (!ranked) return "missing";
  if (ranked.denied) return "explicit-deny";
  if (ranked.wildcard) return "wildcard";
  return ranked.specificity === 0 ? "selected-environment" : "ancestor-environment";
}

/**
 * Resolve one node's effective profile binding using the shared overlay
 * precedence: explicit denial, selected environment, nearest parent, then
 * wildcard. Missing rules are disabled and never grant exposure.
 */
export function resolveArchitectureProfileBinding(
  specInput: ArchitectureSpecV1,
  options: ArchitectureProfileBindingResolutionOptions,
): ArchitectureProfileBindingResolution {
  const resolved = resolveArchitectureEnvironment(specInput, {
    profileId: options.profileId,
    environmentId: options.environmentId,
  });
  const matching = resolved.profile.bindings
    .map((binding) => binding.nodeId === options.nodeId ? rankArchitectureBinding(binding, resolved.ancestorIds) : undefined)
    .filter((ranked): ranked is RankedArchitectureBinding => ranked !== undefined);
  const selected = matching.slice().sort((left, right) => Number(right.denied) - Number(left.denied)
    || left.specificity - right.specificity
    || left.scopeKey.localeCompare(right.scopeKey)
    || Number(right.binding.enabled) - Number(left.binding.enabled)
    || left.binding.runtimeExposure.localeCompare(right.binding.runtimeExposure))[0];
  const denied = selected?.denied === true;
  const decision: ArchitectureBindingDecision = selected && !denied ? "enabled" : "disabled";
  const specificity = selected?.specificity ?? Number.POSITIVE_INFINITY;
  const sourceEnvironmentId = selected?.sourceEnvironmentId;
  const wildcard = selected?.wildcard ?? false;
  return {
    decision,
    ...(selected ? { binding: selected.binding } : {}),
    denied,
    specificity,
    ...(sourceEnvironmentId !== undefined ? { sourceEnvironmentId } : {}),
    wildcard,
    provenance: {
      kind: selected ? "binding" : "missing",
      reason: bindingProvenanceReason(selected),
      ...(sourceEnvironmentId !== undefined ? { sourceEnvironmentId } : {}),
      wildcard,
      specificity,
      scopeKey: selected?.scopeKey ?? "none",
    },
  };
}

function registrySkillFor(ref: ArchitectureSkillRef, snapshot: AuthorizedRegistrySnapshot): AuthorizedRegistrySkillSnapshot {
  const candidates = snapshot.filter((item) => (item.id === ref.id || item.skillRefId === ref.id || item.slug === ref.slug) && item.version === ref.version && item.digest === ref.digest);
  if (candidates.length === 0) throw new ArchitectureCompileError("ARCHITECTURE_REGISTRY_SNAPSHOT_MISSING", `Authorized registry metadata for '${ref.id}' at ${ref.version} is unavailable.`);
  if (candidates.length > 1) {
    throw new ArchitectureCompileError("ARCHITECTURE_REGISTRY_SNAPSHOT_AMBIGUOUS", `Authorized registry metadata for '${ref.id}' at ${ref.version} is ambiguous.`);
  }
  const candidate = candidates[0];
  const candidateIndex = snapshot.indexOf(candidate);
  const metadataErrors: ArchitectureValidationIssue[] = [];
  validateMetadata(candidate.metadata, metadataErrors, `registry[${candidateIndex}].metadata`);
  if (metadataErrors.length > 0) {
    throw new ArchitectureCompileError(
      "ARCHITECTURE_REGISTRY_METADATA_INVALID",
      "Authorized registry metadata is not safe for compiled output.",
      metadataErrors,
    );
  }
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
  const context = resolveArchitectureEnvironment(spec, options);
  const { environment, profile } = context;
  const skillById = new Map(spec.skills.map((skill) => [skill.id, skill]));
  const disabledNodeIds: string[] = [];
  const exposedBindings = new Map<string, ArchitectureProfileBinding>();
  for (const node of spec.nodes) {
    const resolution = resolveArchitectureProfileBinding(spec, {
      profileId: profile.id,
      environmentId: environment.id,
      nodeId: node.id,
    });
    if (resolution.decision === "disabled" || !resolution.binding) disabledNodeIds.push(node.id);
    else exposedBindings.set(node.id, resolution.binding);
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
