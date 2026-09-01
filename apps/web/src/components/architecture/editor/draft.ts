import {
  canonicalizeJson,
  canonicalArchitectureJson,
  validateArchitectureSpec,
  type ArchitectureEnvironmentKind,
  type ArchitectureEdge,
  type ArchitectureNode,
  type ArchitectureProfile,
  type ArchitectureProfileBinding,
  type ArchitectureSpecV1,
  type ArchitectureValidationIssue,
} from "@myskills-app/core";
import type { ArchitectureTreeNode } from "./types.js";

export type ArchitectureEditorNodeKind = ArchitectureNode["kind"];

export interface MoveTarget {
  id: string | null;
  label: string;
  disabled?: boolean;
}

export interface EnvironmentParentOption {
  id: string | null;
  label: string;
}

export interface ArchitectureSkillReleaseInput {
  id: string;
  slug: string;
  title?: string;
  summary?: string;
  version: string;
  digest: string;
  packageVisibility: ArchitectureSpecV1["skills"][number]["packageVisibility"];
  tags?: string[];
}

/** Clone a server-owned spec before placing it in local editor state. */
export function cloneArchitectureSpec(spec: ArchitectureSpecV1): ArchitectureSpecV1 {
  return structuredClone(spec);
}

/**
 * Canonical JSON is intentionally kept in the core package. It makes dirty
 * state independent of object key order and keeps the server's digest rules
 * visible to the editor.
 */
export function architectureSpecKey(spec: ArchitectureSpecV1): string {
  try {
    return canonicalArchitectureJson(spec);
  } catch {
    // Bootstrap drafts are intentionally incomplete until an exact release is
    // selected. Keep their dirty-state key deterministic without treating
    // them as valid revisions.
    return canonicalizeJson(spec);
  }
}

function nodeMap(spec: ArchitectureSpecV1): Map<string, ArchitectureNode> {
  return new Map(spec.nodes.map((node) => [node.id, node]));
}

function edgeKey(edge: Pick<ArchitectureEdge, "from" | "to">): string {
  return `${edge.from}\u0000${edge.to}`;
}

function childMap(spec: ArchitectureSpecV1): Map<string, ArchitectureNode[]> {
  const nodes = nodeMap(spec);
  const children = new Map<string, ArchitectureNode[]>();
  for (const edge of spec.edges) {
    const child = nodes.get(edge.to);
    if (!child) continue;
    const siblings = children.get(edge.from) ?? [];
    siblings.push(child);
    children.set(edge.from, siblings);
  }
  return children;
}

/** Build the canonical semantic tree from the topology edges. */
export function createArchitectureTree(spec: ArchitectureSpecV1): ArchitectureTreeNode[] {
  const nodes = nodeMap(spec);
  const children = childMap(spec);
  const incoming = new Set(spec.edges.map((edge) => edge.to));
  const roots: ArchitectureNode[] = [];
  const rootIds = new Set<string>();

  for (const id of spec.entryNodeIds) {
    const node = nodes.get(id);
    if (node && !rootIds.has(node.id)) {
      roots.push(node);
      rootIds.add(node.id);
    }
  }
  for (const node of spec.nodes) {
    if (!incoming.has(node.id) && !rootIds.has(node.id)) {
      roots.push(node);
      rootIds.add(node.id);
    }
  }
  const reachable = new Set<string>();
  const markReachable = (nodeId: string) => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const child of children.get(nodeId) ?? []) markReachable(child.id);
  };
  for (const root of roots) markReachable(root.id);
  // Keep an invalid/orphaned draft visible in the outline instead of hiding
  // it behind a broken edge. Validation still reports the underlying issue.
  for (const node of spec.nodes) {
    if (!reachable.has(node.id)) {
      roots.push(node);
      markReachable(node.id);
    }
  }

  const build = (node: ArchitectureNode, depth: number, trail: Set<string>, position: number, siblingCount: number): ArchitectureTreeNode => {
    const nextTrail = new Set(trail).add(node.id);
    const nested = (children.get(node.id) ?? [])
      .filter((child) => !nextTrail.has(child.id))
      .map((child, childIndex, siblings) => build(child, depth + 1, nextTrail, childIndex + 1, siblings.length));
    return { node, children: nested, depth, position, siblingCount };
  };

  return roots.map((root, index) => build(root, 1, new Set(), index + 1, roots.length));
}

export function flattenArchitectureTree(tree: readonly ArchitectureTreeNode[], expanded: ReadonlySet<string>): ArchitectureTreeNode[] {
  const result: ArchitectureTreeNode[] = [];
  const visit = (items: readonly ArchitectureTreeNode[]) => {
    for (const item of items) {
      result.push(item);
      if (item.node.kind === "router" && expanded.has(item.node.id)) visit(item.children);
    }
  };
  visit(tree);
  return result;
}

export function descendantsOf(spec: ArchitectureSpecV1, nodeId: string): Set<string> {
  const children = childMap(spec);
  const descendants = new Set<string>();
  const visit = (current: string) => {
    for (const child of children.get(current) ?? []) {
      if (descendants.has(child.id)) continue;
      descendants.add(child.id);
      visit(child.id);
    }
  };
  visit(nodeId);
  return descendants;
}

export function parentNodeId(spec: ArchitectureSpecV1, nodeId: string): string | null {
  return spec.edges.find((edge) => edge.to === nodeId)?.from ?? null;
}

function uniqueId(prefix: string, taken: Iterable<string>): string {
  const occupied = new Set(taken);
  if (!occupied.has(prefix)) return prefix;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!occupied.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

export function nodeParentIsAllowed(spec: ArchitectureSpecV1, node: ArchitectureNode, parentId: string | null): boolean {
  if (!parentId) return true;
  const parent = spec.nodes.find((candidate) => candidate.id === parentId);
  if (!parent || parent.kind !== "router" || parent.id === node.id) return false;
  if (descendantsOf(spec, node.id).has(parent.id)) return false;
  if (spec.pattern.id === "flat") return false;
  if (spec.pattern.id === "domain-router") return node.kind === "leaf" && parent.id === spec.entryNodeIds[0];
  return true;
}

export function moveTargetsForNode(spec: ArchitectureSpecV1, nodeId: string): MoveTarget[] {
  const node = spec.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const parentId = parentNodeId(spec, nodeId);
  const targets: MoveTarget[] = [{ id: null, label: "Top level" }];
  for (const candidate of spec.nodes) {
    if (nodeParentIsAllowed(spec, node, candidate.id)) {
      targets.push({ id: candidate.id, label: `Under ${candidate.label}` });
    }
  }
  if (parentId === null && spec.pattern.id !== "flat") {
    // A root router can stay top-level, but leaf targets should be easy to
    // find because the list is grouped by type.
    return targets;
  }
  return targets;
}

function parentEdgeFor(node: ArchitectureNode, parentId: string): ArchitectureEdge {
  return { from: parentId, to: node.id, kind: node.kind === "router" ? "contains" : "routes" };
}

/**
 * Add one exact, API-authorized release to the semantic draft. Placement is
 * deliberately explicit for router patterns; a leaf never silently attaches
 * to an inferred root. This helper does not fetch, authorize, or mutate a
 * persisted revision.
 */
export function addArchitectureSkillRelease(
  spec: ArchitectureSpecV1,
  release: ArchitectureSkillReleaseInput,
  parentId: string | null,
): ArchitectureSpecV1 {
  const duplicate = spec.skills.some((skill) => skill.id === release.id || (skill.slug === release.slug && skill.version === release.version));
  if (duplicate) {
    throw new Error("That exact skill release is already in this architecture.");
  }
  const skill = {
    id: release.id,
    slug: release.slug,
    ...(release.title ? { title: release.title } : {}),
    ...(release.summary ? { summary: release.summary } : {}),
    version: release.version,
    digest: release.digest,
    packageVisibility: release.packageVisibility,
    ...(release.tags && release.tags.length > 0 ? { tags: [...release.tags] } : {}),
  } satisfies ArchitectureSpecV1["skills"][number];
  const slugId = release.slug.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  const nodeId = uniqueId(`leaf-${slugId}`, spec.nodes.map((node) => node.id));
  const node: ArchitectureNode = {
    id: nodeId,
    kind: "leaf",
    label: release.title || release.slug,
    skillRefId: release.id,
  };
  if (spec.pattern.id === "flat") {
    if (parentId !== null) {
      throw new Error("Flat patterns place releases at the top level.");
    }
  } else {
    if (!parentId) {
      throw new Error("Select a parent router before adding a release.");
    }
    if (!nodeParentIsAllowed(spec, node, parentId)) {
      throw new Error("Select a valid router parent for this release.");
    }
  }
  return {
    ...spec,
    skills: [...spec.skills, skill],
    nodes: [...spec.nodes, node],
    edges: parentId ? [...spec.edges, parentEdgeFor(node, parentId)] : [...spec.edges],
    entryNodeIds: parentId ? [...spec.entryNodeIds] : [...spec.entryNodeIds, node.id],
    profiles: spec.profiles.map((profile) => ({
      ...profile,
      bindings: [...profile.bindings, { nodeId: node.id, enabled: false, runtimeExposure: "disabled" }],
    })),
  };
}

/** Add a node and an explicit disabled binding for every existing profile. */
export function addArchitectureNode(
  spec: ArchitectureSpecV1,
  kind: ArchitectureEditorNodeKind,
  parentId?: string | null,
  skillRefId?: string,
): ArchitectureSpecV1 {
  const id = uniqueId(kind === "router" ? "router-new" : "leaf-new", spec.nodes.map((node) => node.id));
  const skill = spec.skills.find((candidate) => candidate.id === skillRefId) ?? spec.skills[0];
  const node: ArchitectureNode = kind === "router"
    ? { id, kind, label: "New router" }
    : { id, kind, label: skill?.title ?? skill?.slug ?? "Unassigned leaf", skillRefId: skill?.id ?? skillRefId ?? "unassigned-skill" };
  const safeParent = parentId && nodeParentIsAllowed(spec, node, parentId) ? parentId : null;
  const next: ArchitectureSpecV1 = {
    ...spec,
    nodes: [...spec.nodes, node],
    edges: safeParent ? [...spec.edges, parentEdgeFor(node, safeParent)] : [...spec.edges],
    entryNodeIds: safeParent ? [...spec.entryNodeIds] : [...spec.entryNodeIds, node.id],
    profiles: spec.profiles.map((profile) => ({
      ...profile,
      bindings: [...profile.bindings, { nodeId: node.id, enabled: false, runtimeExposure: "disabled" }],
    })),
  };
  return next;
}

/** Remove a subtree and its profile bindings while preserving skill catalogue refs. */
export function removeArchitectureNode(spec: ArchitectureSpecV1, nodeId: string): ArchitectureSpecV1 {
  const removed = new Set([nodeId, ...descendantsOf(spec, nodeId)]);
  return {
    ...spec,
    nodes: spec.nodes.filter((node) => !removed.has(node.id)),
    edges: spec.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
    entryNodeIds: spec.entryNodeIds.filter((id) => !removed.has(id)),
    profiles: spec.profiles.map((profile) => ({
      ...profile,
      bindings: profile.bindings.filter((binding) => !removed.has(binding.nodeId)),
    })),
  };
}

/** Move a node without changing its semantic kind or saving canvas position. */
export function moveArchitectureNode(spec: ArchitectureSpecV1, nodeId: string, parentId: string | null): ArchitectureSpecV1 {
  const node = spec.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !nodeParentIsAllowed(spec, node, parentId)) return spec;
  const nextEdges = spec.edges.filter((edge) => edge.to !== nodeId);
  if (parentId) nextEdges.push(parentEdgeFor(node, parentId));
  const nextEntryNodeIds = parentId
    ? spec.entryNodeIds.filter((id) => id !== nodeId)
    : [...spec.entryNodeIds.filter((id) => id !== nodeId), nodeId];
  // Keep the original edge order stable where possible, with a moved edge at
  // the end. The semantic compiler does not rely on this order.
  return { ...spec, edges: nextEdges, entryNodeIds: nextEntryNodeIds };
}

export function updateArchitectureNodeLabel(spec: ArchitectureSpecV1, nodeId: string, label: string): ArchitectureSpecV1 {
  return {
    ...spec,
    nodes: spec.nodes.map((node) => node.id === nodeId ? { ...node, label } : node),
  };
}

export function updateArchitectureName(spec: ArchitectureSpecV1, name: string, description = spec.description): ArchitectureSpecV1 {
  const next = { ...spec, name };
  if (description === undefined) {
    delete next.description;
  } else {
    next.description = description;
  }
  return next;
}

export function addArchitectureProfile(spec: ArchitectureSpecV1): ArchitectureSpecV1 {
  const id = uniqueId("profile-new", spec.profiles.map((profile) => profile.id));
  const subject = spec.profiles[0]?.subject ?? { type: "user" as const, id: "local-user" };
  const profile: ArchitectureProfile = {
    id,
    name: "New profile",
    subject: { ...subject },
    defaultExposure: "disabled",
    bindings: spec.nodes.map((node) => ({ nodeId: node.id, enabled: false, runtimeExposure: "disabled" })),
  };
  return { ...spec, profiles: [...spec.profiles, profile] };
}

export function removeArchitectureProfile(spec: ArchitectureSpecV1, profileId: string): ArchitectureSpecV1 {
  if (spec.profiles.length <= 1 || !spec.profiles.some((profile) => profile.id === profileId)) return spec;
  const replacement = spec.profiles.find((profile) => profile.id !== profileId)?.id;
  if (!replacement) return spec;
  return {
    ...spec,
    profiles: spec.profiles.filter((profile) => profile.id !== profileId),
    environments: spec.environments.map((environment) => environment.profileId === profileId ? { ...environment, profileId: replacement } : environment),
  };
}

export function updateArchitectureProfileName(spec: ArchitectureSpecV1, profileId: string, name: string): ArchitectureSpecV1 {
  return { ...spec, profiles: spec.profiles.map((profile) => profile.id === profileId ? { ...profile, name } : profile) };
}

export function addArchitectureEnvironment(
  spec: ArchitectureSpecV1,
  profileId?: string,
  kind: ArchitectureEnvironmentKind = "personal",
  parentId: string | null = null,
): ArchitectureSpecV1 {
  const id = uniqueId("environment-new", spec.environments.map((environment) => environment.id));
  const selectedProfileId = profileId && spec.profiles.some((profile) => profile.id === profileId)
    ? profileId
    : spec.profiles[0]?.id;
  if (!selectedProfileId) return spec;
  const safeParentId = parentId && spec.environments.some((environment) => environment.id === parentId) ? parentId : null;
  return {
    ...spec,
    environments: [...spec.environments, {
      id,
      name: "New environment",
      kind,
      profileId: selectedProfileId,
      ...(safeParentId ? { parentId: safeParentId } : {}),
    }],
  };
}

export function removeArchitectureEnvironment(spec: ArchitectureSpecV1, environmentId: string): ArchitectureSpecV1 {
  if (spec.environments.length <= 1) return spec;
  const removed = spec.environments.find((environment) => environment.id === environmentId);
  if (!removed) return spec;
  const replacementParentId = removed.parentId ?? null;
  return {
    ...spec,
    environments: spec.environments
      .filter((environment) => environment.id !== environmentId)
      .map((environment) => environment.parentId === environmentId
        ? {
          ...environment,
          ...(replacementParentId ? { parentId: replacementParentId } : { parentId: null }),
        }
        : environment),
    profiles: spec.profiles.map((profile) => ({
      ...profile,
      bindings: profile.bindings.map((binding) => {
        if (!binding.environmentIds) return binding;
        return {
          ...binding,
          environmentIds: binding.environmentIds.filter((id) => id !== environmentId),
        };
      }),
    })),
  };
}

export function updateArchitectureEnvironment(
  spec: ArchitectureSpecV1,
  environmentId: string,
  update: { name?: string; kind?: ArchitectureEnvironmentKind; profileId?: string; parentId?: string | null },
): ArchitectureSpecV1 {
  const environment = spec.environments.find((candidate) => candidate.id === environmentId);
  if (!environment) return spec;
  const profileId = update.profileId && spec.profiles.some((profile) => profile.id === update.profileId) ? update.profileId : undefined;
  const parentId = update.parentId === undefined
    ? undefined
    : update.parentId === null
      ? null
      : environmentParentOptions(spec, environmentId).some((option) => option.id === update.parentId)
        ? update.parentId
        : undefined;
  return {
    ...spec,
    environments: spec.environments.map((environment) => environment.id === environmentId
      ? {
        ...environment,
        ...(update.name !== undefined ? { name: update.name } : {}),
        ...(update.kind !== undefined ? { kind: update.kind } : {}),
        ...(profileId ? { profileId } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
      }
      : environment),
  };
}

function environmentDescendantsOf(spec: ArchitectureSpecV1, environmentId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const environment of spec.environments) {
    if (typeof environment.parentId !== "string") continue;
    const children = childrenByParent.get(environment.parentId) ?? [];
    children.push(environment.id);
    childrenByParent.set(environment.parentId, children);
  }
  const descendants = new Set<string>();
  const visit = (currentId: string) => {
    for (const childId of childrenByParent.get(currentId) ?? []) {
      if (descendants.has(childId)) continue;
      descendants.add(childId);
      visit(childId);
    }
  };
  visit(environmentId);
  return descendants;
}

/** Return cycle-safe parent choices for one environment, in spec order. */
export function environmentParentOptions(spec: ArchitectureSpecV1, environmentId: string): EnvironmentParentOption[] {
  const environment = spec.environments.find((candidate) => candidate.id === environmentId);
  if (!environment) return [];
  const descendants = environmentDescendantsOf(spec, environmentId);
  return [
    { id: null, label: "No parent (top level)" },
    ...spec.environments
      .filter((candidate) => candidate.id !== environmentId && !descendants.has(candidate.id))
      .map((candidate) => ({ id: candidate.id, label: `${candidate.name} · ${candidate.kind}` })),
  ];
}

function defaultRuntimeExposure(node: ArchitectureNode): "disabled" | "router" | "leaf" {
  return node.kind;
}

export function profileBinding(spec: ArchitectureSpecV1, profileId: string, nodeId: string): ArchitectureProfileBinding {
  const profile = spec.profiles.find((candidate) => candidate.id === profileId);
  const binding = profile?.bindings.find((candidate) => candidate.nodeId === nodeId);
  const node = spec.nodes.find((candidate) => candidate.id === nodeId);
  return binding ?? { nodeId, enabled: false, runtimeExposure: node ? "disabled" : "disabled" };
}

export function updateArchitectureProfileBinding(
  spec: ArchitectureSpecV1,
  profileId: string,
  nodeId: string,
  update: Partial<Pick<ArchitectureProfileBinding, "enabled" | "runtimeExposure" | "environmentIds">>,
): ArchitectureSpecV1 {
  const node = spec.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return spec;
  return {
    ...spec,
    profiles: spec.profiles.map((profile) => {
      if (profile.id !== profileId) return profile;
      const existing = profile.bindings.find((binding) => binding.nodeId === nodeId);
      const current = existing ?? { nodeId, enabled: false, runtimeExposure: "disabled" as const };
      const enabled = update.enabled ?? current.enabled;
      const runtimeExposure = enabled
        ? (update.runtimeExposure && update.runtimeExposure !== "disabled" ? update.runtimeExposure : defaultRuntimeExposure(node))
        : "disabled";
      const nextBinding: ArchitectureProfileBinding = {
        ...current,
        ...update,
        enabled,
        runtimeExposure,
      };
      const bindings = existing
        ? profile.bindings.map((binding) => binding.nodeId === nodeId ? nextBinding : binding)
        : [...profile.bindings, nextBinding];
      return { ...profile, bindings };
    }),
  };
}

export function validationIssues(spec: ArchitectureSpecV1): ArchitectureValidationIssue[] {
  try {
    const result = validateArchitectureSpec(spec);
    return result.valid ? [] : result.errors;
  } catch (error) {
    return [{
      code: "ARCHITECTURE_INVALID_OBJECT",
      message: error instanceof Error ? error.message : "The draft could not be validated.",
      path: "spec",
    }];
  }
}

export function isRouterNode(node: ArchitectureNode | undefined): node is Extract<ArchitectureNode, { kind: "router" }> {
  return node?.kind === "router";
}

export function edgeRelationshipLabel(edge: ArchitectureEdge): string {
  return edge.kind === "contains" ? "contains" : "routes to";
}

export function edgeIdentity(edge: Pick<ArchitectureEdge, "from" | "to" | "kind">): string {
  return `${edgeKey(edge)}\u0000${edge.kind}`;
}
