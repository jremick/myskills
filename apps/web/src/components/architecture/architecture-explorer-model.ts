/*
 * Server contract for the Architecture explorer (verified against
 * apps/api/src/app.ts `POST /v1/architectures/:id/preview`,
 * apps/api/src/architectures/service.ts and packages/core `compileArchitecture`):
 *
 * - The API compiles the authorized revision once for the selected
 *   profile/environment. `compiled.nodes`, `compiled.edges`, `compiled.skills`,
 *   `graph` and `outline` contain ONLY nodes exposed in that context (a node is
 *   active only when its binding is enabled and every ancestor is exposed).
 * - `compiled.allNodes` and `compiled.disabledNodeIds` list every topology node
 *   and are returned to all readers, including organization-only readers, but
 *   carry no parent edges for non-exposed nodes. The explorer never reads them.
 * - `revision` (and `revision.spec`) is omitted when the caller's only access
 *   reason is "organization"; owners and team members receive the same revision
 *   the server compiled, which they may also read through `/revisions/:id`.
 * - Therefore the exposed structure comes from graph/outline/compiled only.
 *   Non-exposed nodes (and the exposure filter) appear only when
 *   `preview.revision.spec` is present and consistent with the projection.
 *   Nothing is fetched, inferred from other caches, or written back.
 */
import dagre from "@dagrejs/dagre";
import { resolveArchitectureProfileBinding, type ArchitectureSpecV1 } from "@myskills-app/core";
import type { ArchitecturePreview } from "../../api.js";

export type ArchitectureExplorerFilter = "all" | "exposed";
export type ArchitectureExplorerNodeKind = "router" | "leaf";

export interface ArchitectureExplorerSkill {
  skillRefId: string;
  slug?: string;
  title?: string;
  version?: string;
  digest?: string;
  packageVisibility?: string;
  /**
   * "context": resolved by the server for the selected context.
   * "revision": pinned in the saved revision (only for authorized full-spec readers).
   */
  source: "context" | "revision";
}

export interface ArchitectureExplorerNode {
  id: string;
  kind: ArchitectureExplorerNodeKind;
  label: string;
  parentId: string | null;
  childIds: readonly string[];
  depth: number;
  /** True when the node is part of the server's exposed projection. */
  exposed: boolean;
  runtimeExposure?: "router" | "leaf";
  skill?: ArchitectureExplorerSkill;
  /** Distinct leaf (skill) nodes below this node. Routers never count. */
  skillCount: number;
  exposedSkillCount: number;
  /** Router nodes below this node. */
  routerCount: number;
  exposedRouterCount: number;
  childRouterCount: number;
  childSkillCount: number;
  exposedChildRouterCount: number;
  exposedChildSkillCount: number;
  /** Lower-cased label, skill slug and title. */
  searchText: string;
}

export interface ArchitectureExplorerModel {
  /** Architecture id; local explorer state resets when it changes. */
  key: string;
  nodes: ReadonlyMap<string, ArchitectureExplorerNode>;
  nodeIds: ReadonlySet<string>;
  rootIds: readonly string[];
  /** The response included the full revision for this caller. */
  fullSpecAvailable: boolean;
  /** Full-spec readers only: the topology contains nodes not exposed in this context. */
  hasHiddenNodes: boolean;
  totals: {
    routers: number;
    skills: number;
    exposedRouters: number;
    exposedSkills: number;
  };
}

export interface ArchitectureExplorerSearchResult {
  /** Normalized (trimmed, lower-cased) query. */
  query: string;
  matches: ReadonlySet<string>;
  /** Matches plus every ancestor, so results keep their branch context. */
  visible: ReadonlySet<string>;
}

export interface ArchitectureExplorerExposure {
  state: "included" | "conditional" | "excluded";
  label: string;
  detail: string;
  reason?: string;
}

/** Trees above this size open with branches collapsed. */
export const ARCHITECTURE_EXPLORER_LARGE_TREE = 40;
/** A flat map (no routers) shows at most this many skills. */
export const ARCHITECTURE_EXPLORER_MAP_LEAF_LIMIT = 120;

export const ARCHITECTURE_EXPLORER_MAP_NODE_WIDTH = 232;
export const ARCHITECTURE_EXPLORER_MAP_ROUTER_HEIGHT = 52;
export const ARCHITECTURE_EXPLORER_MAP_LEAF_HEIGHT = 40;

interface DraftNode {
  id: string;
  kind: ArchitectureExplorerNodeKind;
  label: string;
  skillRefId?: string;
  exposed: boolean;
}

interface OutlineLike {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  children?: unknown;
}

const modelCache = new WeakMap<ArchitecturePreview, ArchitectureExplorerModel>();

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function architectureExplorerPlural(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Build (and memoize per response object) the explorer model for a preview. */
export function architectureExplorerModel(preview: ArchitecturePreview): ArchitectureExplorerModel {
  const cached = modelCache.get(preview);
  if (cached) return cached;
  const model = buildArchitectureExplorerModel(preview);
  modelCache.set(preview, model);
  return model;
}

/** Ids that can be selected in the explorer for this exact preview. */
export function architectureExplorerNodeIds(preview: ArchitecturePreview): ReadonlySet<string> {
  return architectureExplorerModel(preview).nodeIds;
}

/**
 * The full revision is used only when the server returned it (the caller is
 * not an organization-only reader) and it describes the compiled projection.
 */
function fullSpecForPreview(preview: ArchitecturePreview, exposed: ReadonlyMap<string, DraftNode>): ArchitectureSpecV1 | null {
  const spec = preview.revision?.spec;
  if (!spec || !Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) return null;
  if (spec.id !== preview.compiled?.architectureId) return null;
  const specIds = new Set(spec.nodes.map((node) => node.id));
  for (const id of exposed.keys()) {
    if (!specIds.has(id)) return null;
  }
  return spec;
}

function buildArchitectureExplorerModel(preview: ArchitecturePreview): ArchitectureExplorerModel {
  const compiled = preview.compiled;
  const drafts = new Map<string, DraftNode>();
  // [parent, child] pairs in priority order: first parent wins.
  const parentPairs: Array<[string, string]> = [];

  const addExposed = (id: unknown, kind: unknown, label: unknown, skillRefId?: unknown) => {
    if (typeof id !== "string" || id.length === 0) return;
    const ref = typeof skillRefId === "string" && skillRefId.length > 0 ? skillRefId : undefined;
    const existing = drafts.get(id);
    if (existing) {
      if (!existing.skillRefId && ref) existing.skillRefId = ref;
      return;
    }
    drafts.set(id, {
      id,
      kind: kind === "leaf" ? "leaf" : "router",
      label: typeof label === "string" && label.trim().length > 0 ? label : id,
      ...(ref ? { skillRefId: ref } : {}),
      exposed: true,
    });
  };

  for (const node of preview.graph?.nodes ?? []) addExposed(node.id, node.kind, node.label, node.skillRefId);

  // The accessible outline is the primary structural source. Repeated
  // subtrees are visited once, so malformed input cannot loop or explode.
  const stack: Array<{ node: OutlineLike; parent: string | null }> = [];
  const outlineRoots = Array.isArray(preview.outline?.tree) ? preview.outline.tree : [];
  for (let index = outlineRoots.length - 1; index >= 0; index -= 1) stack.push({ node: outlineRoots[index] as OutlineLike, parent: null });
  const outlineVisited = new Set<string>();
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (!node || typeof node.id !== "string") continue;
    addExposed(node.id, node.kind, node.label);
    if (parent !== null) parentPairs.push([parent, node.id]);
    if (outlineVisited.has(node.id)) continue;
    outlineVisited.add(node.id);
    const children = Array.isArray(node.children) ? (node.children as OutlineLike[]) : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index] as OutlineLike, parent: node.id });
  }

  const runtimeById = new Map<string, "router" | "leaf">();
  for (const node of compiled?.nodes ?? []) {
    addExposed(node.id, node.kind, node.label, node.skillRefId);
    if (node.runtimeExposure === "router" || node.runtimeExposure === "leaf") runtimeById.set(node.id, node.runtimeExposure);
  }
  for (const edge of preview.graph?.edges ?? []) parentPairs.push([edge.from, edge.to]);
  for (const edge of compiled?.edges ?? []) parentPairs.push([edge.from, edge.to]);

  const spec = fullSpecForPreview(preview, drafts);
  if (spec) {
    for (const node of spec.nodes) {
      if (drafts.has(node.id)) continue;
      drafts.set(node.id, {
        id: node.id,
        kind: node.kind === "leaf" ? "leaf" : "router",
        label: node.label || node.id,
        ...(node.skillRefId ? { skillRefId: node.skillRefId } : {}),
        exposed: false,
      });
    }
    for (const edge of spec.edges) parentPairs.push([edge.from, edge.to]);
  }

  const parentById = new Map<string, string>();
  const createsCycle = (parent: string, child: string) => {
    let current: string | undefined = parent;
    for (let steps = 0; current !== undefined && steps <= drafts.size; steps += 1) {
      if (current === child) return true;
      current = parentById.get(current);
    }
    return false;
  };
  for (const [parent, child] of parentPairs) {
    if (parent === child || parentById.has(child)) continue;
    const parentDraft = drafts.get(parent);
    if (!parentDraft || parentDraft.kind !== "router" || !drafts.has(child)) continue;
    if (createsCycle(parent, child)) continue;
    parentById.set(child, parent);
  }

  const childrenById = new Map<string, string[]>();
  for (const [child, parent] of parentById) {
    const list = childrenById.get(parent);
    if (list) list.push(child);
    else childrenById.set(parent, [child]);
  }
  // Keep the server's projection order (graph, then outline, then full spec).
  const rootIds = [...drafts.keys()].filter((id) => !parentById.has(id));

  // Breadth-first order gives depth; reverse order gives bottom-up counts.
  const depthById = new Map<string, number>();
  const order: string[] = [];
  for (const id of rootIds) {
    depthById.set(id, 0);
    order.push(id);
  }
  for (let cursor = 0; cursor < order.length; cursor += 1) {
    const id = order[cursor];
    const depth = depthById.get(id) ?? 0;
    for (const child of childrenById.get(id) ?? []) {
      if (depthById.has(child)) continue;
      depthById.set(child, depth + 1);
      order.push(child);
    }
  }

  const contextSkills = new Map((compiled?.skills ?? []).map((skill) => [skill.skillRefId, skill]));
  const pinnedSkills = spec ? new Map(spec.skills.map((skill) => [skill.id, skill])) : null;
  const skillFor = (draft: DraftNode): ArchitectureExplorerSkill | undefined => {
    const ref = draft.skillRefId;
    if (!ref) return undefined;
    if (draft.exposed) {
      const resolved = contextSkills.get(ref);
      if (resolved) {
        return {
          skillRefId: ref,
          slug: resolved.slug,
          ...(resolved.title ? { title: resolved.title } : {}),
          version: resolved.version,
          digest: resolved.digest,
          packageVisibility: resolved.packageVisibility,
          source: "context",
        };
      }
    }
    const pinned = pinnedSkills?.get(ref);
    if (pinned) {
      return {
        skillRefId: ref,
        slug: pinned.slug,
        ...(pinned.title ? { title: pinned.title } : {}),
        version: pinned.version,
        digest: pinned.digest,
        packageVisibility: pinned.packageVisibility,
        source: "revision",
      };
    }
    return { skillRefId: ref, source: draft.exposed ? "context" : "revision" };
  };

  const nodes = new Map<string, ArchitectureExplorerNode>();
  for (const id of order) {
    const draft = drafts.get(id)!;
    const skill = skillFor(draft);
    const runtimeExposure = draft.exposed ? runtimeById.get(id) : undefined;
    nodes.set(id, {
      id,
      kind: draft.kind,
      label: draft.label,
      parentId: parentById.get(id) ?? null,
      childIds: childrenById.get(id) ?? [],
      depth: depthById.get(id) ?? 0,
      exposed: draft.exposed,
      ...(runtimeExposure ? { runtimeExposure } : {}),
      ...(skill ? { skill } : {}),
      skillCount: 0,
      exposedSkillCount: 0,
      routerCount: 0,
      exposedRouterCount: 0,
      childRouterCount: 0,
      childSkillCount: 0,
      exposedChildRouterCount: 0,
      exposedChildSkillCount: 0,
      searchText: [draft.label, skill?.slug, skill?.title].filter(Boolean).join("\n").toLowerCase(),
    });
  }

  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = nodes.get(order[index])!;
    for (const childId of node.childIds) {
      const child = nodes.get(childId);
      if (!child) continue;
      const childIsLeaf = child.kind === "leaf";
      node.skillCount += child.skillCount + (childIsLeaf ? 1 : 0);
      node.exposedSkillCount += child.exposedSkillCount + (childIsLeaf && child.exposed ? 1 : 0);
      node.routerCount += child.routerCount + (childIsLeaf ? 0 : 1);
      node.exposedRouterCount += child.exposedRouterCount + (!childIsLeaf && child.exposed ? 1 : 0);
      if (childIsLeaf) {
        node.childSkillCount += 1;
        if (child.exposed) node.exposedChildSkillCount += 1;
      } else {
        node.childRouterCount += 1;
        if (child.exposed) node.exposedChildRouterCount += 1;
      }
    }
  }

  let routers = 0;
  let skills = 0;
  let exposedRouters = 0;
  let exposedSkills = 0;
  for (const node of nodes.values()) {
    if (node.kind === "leaf") {
      skills += 1;
      if (node.exposed) exposedSkills += 1;
    } else {
      routers += 1;
      if (node.exposed) exposedRouters += 1;
    }
  }

  return {
    key: compiled?.architectureId ?? "",
    nodes,
    nodeIds: new Set(nodes.keys()),
    rootIds,
    fullSpecAvailable: spec !== null,
    hasHiddenNodes: spec !== null && [...nodes.values()].some((node) => !node.exposed),
    totals: { routers, skills, exposedRouters, exposedSkills },
  };
}

/** Root-first ancestor ids of a node (excluding the node itself). */
export function architectureExplorerAncestorIds(model: ArchitectureExplorerModel, id: string): string[] {
  const ancestors: string[] = [];
  let current = model.nodes.get(id)?.parentId ?? null;
  while (current !== null && ancestors.length <= model.nodes.size) {
    ancestors.unshift(current);
    current = model.nodes.get(current)?.parentId ?? null;
  }
  return ancestors;
}

/** Small trees open fully; large trees show roots with their router children. */
export function architectureExplorerInitialExpandedIds(model: ArchitectureExplorerModel): Set<string> {
  if (model.nodes.size <= ARCHITECTURE_EXPLORER_LARGE_TREE) return architectureExplorerExpandableIds(model);
  const expanded = new Set<string>();
  for (const id of model.rootIds) {
    const node = model.nodes.get(id);
    if (node?.kind === "router" && node.childRouterCount > 0) expanded.add(id);
  }
  return expanded;
}

export function architectureExplorerExpandableIds(model: ArchitectureExplorerModel): Set<string> {
  const expandable = new Set<string>();
  for (const node of model.nodes.values()) {
    if (node.kind === "router" && node.childIds.length > 0) expandable.add(node.id);
  }
  return expandable;
}

export function architectureExplorerNodeVisible(
  node: ArchitectureExplorerNode | undefined,
  filter: ArchitectureExplorerFilter,
  search: ArchitectureExplorerSearchResult | null,
): node is ArchitectureExplorerNode {
  if (!node) return false;
  if (filter === "exposed" && !node.exposed) return false;
  return search === null || search.visible.has(node.id);
}

export function architectureExplorerVisibleIds(
  model: ArchitectureExplorerModel,
  ids: readonly string[],
  filter: ArchitectureExplorerFilter,
  search: ArchitectureExplorerSearchResult | null,
): string[] {
  return ids.filter((id) => architectureExplorerNodeVisible(model.nodes.get(id), filter, search));
}

export function normalizeArchitectureExplorerQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Match labels and skill slugs/titles, keeping each match's ancestors. */
export function searchArchitectureExplorer(
  model: ArchitectureExplorerModel,
  rawQuery: string,
  filter: ArchitectureExplorerFilter,
): ArchitectureExplorerSearchResult | null {
  const query = normalizeArchitectureExplorerQuery(rawQuery);
  if (!query) return null;
  const matches = new Set<string>();
  const visible = new Set<string>();
  for (const node of model.nodes.values()) {
    if (filter === "exposed" && !node.exposed) continue;
    if (!node.searchText.includes(query)) continue;
    matches.add(node.id);
    let current: string | null = node.id;
    while (current !== null && !visible.has(current)) {
      visible.add(current);
      current = model.nodes.get(current)?.parentId ?? null;
    }
  }
  return { query, matches, visible };
}

/** Split a label around the first case-insensitive match for highlighting. */
export function architectureExplorerHighlight(label: string, query: string): [string, string, string] | null {
  if (!query) return null;
  const lower = label.toLowerCase();
  // Some characters change length when lower-cased; skip highlighting then.
  if (lower.length !== label.length) return null;
  const index = lower.indexOf(query);
  if (index < 0) return null;
  return [label.slice(0, index), label.slice(index, index + query.length), label.slice(index + query.length)];
}

function environmentName(spec: ArchitectureSpecV1, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return spec.environments.find((environment) => environment.id === id)?.name || undefined;
}

/**
 * Exposure of a node in the preview's profile/environment. Binding reasons
 * are derived only from the revision the server returned to this caller.
 */
export function architectureExplorerExposure(
  preview: ArchitecturePreview,
  model: ArchitectureExplorerModel,
  id: string,
): ArchitectureExplorerExposure | null {
  const node = model.nodes.get(id);
  if (!node) return null;
  let exposure: ArchitectureExplorerExposure;
  if (node.exposed) {
    const runtime = node.runtimeExposure ?? node.kind;
    if (runtime === node.kind) {
      exposure = {
        state: "included",
        label: "Included",
        detail: node.kind === "router" ? "Exposed as a router in this context." : "Exposed directly as a skill in this context.",
      };
    } else {
      exposure = {
        state: "conditional",
        label: "Conditional",
        detail: runtime === "router" ? "Reachable only through its router in this context." : "Exposed directly as a skill in this context.",
      };
    }
  } else {
    exposure = { state: "excluded", label: "Excluded", detail: "Not exposed in this context." };
  }
  const spec = model.fullSpecAvailable ? preview.revision?.spec : undefined;
  if (!spec) return exposure;
  try {
    const resolution = resolveArchitectureProfileBinding(spec, {
      profileId: preview.compiled.profileId,
      environmentId: preview.compiled.environmentId,
      nodeId: id,
    });
    if (!node.exposed && resolution.decision === "enabled") {
      return { ...exposure, reason: "A parent router is not exposed in this context." };
    }
    // The server projection is authoritative; never contradict it.
    if (node.exposed && resolution.decision !== "enabled") return exposure;
    switch (resolution.provenance.reason) {
      case "explicit-deny": {
        const source = environmentName(spec, resolution.sourceEnvironmentId);
        return { ...exposure, reason: source ? `Disabled by a rule for ${source}.` : "Disabled by a profile rule." };
      }
      case "missing":
        return { ...exposure, reason: "No profile rule enables this node." };
      case "selected-environment":
        return { ...exposure, reason: "Enabled by a rule for the selected environment." };
      case "ancestor-environment": {
        const source = environmentName(spec, resolution.sourceEnvironmentId);
        return { ...exposure, reason: source ? `Inherited from ${source}.` : "Inherited from a parent environment." };
      }
      case "wildcard":
        return { ...exposure, reason: "Enabled for every environment using this profile." };
      default:
        return exposure;
    }
  } catch {
    return exposure;
  }
}

export interface ArchitectureExplorerMapLayoutNode {
  id: string;
  kind: ArchitectureExplorerNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  hasParent: boolean;
}

export interface ArchitectureExplorerMapLayout {
  nodes: ArchitectureExplorerMapLayoutNode[];
  edges: Array<{ id: string; source: string; target: string }>;
  /** Validated focus; null for the routers-only overview. */
  focusId: string | null;
  /** Set when a flat map is capped at the leaf limit. */
  truncated: { shown: number; total: number } | null;
}

/**
 * Router map projection. The overview shows routers only (or a bounded set
 * of skills for flat architectures). A focused branch shows its ancestor
 * chain plus its direct children, revealing that branch's skills. Layout is
 * computed per render and never persisted.
 */
export function architectureExplorerMapLayout(
  model: ArchitectureExplorerModel,
  options: { focusId: string | null; filter: ArchitectureExplorerFilter },
): ArchitectureExplorerMapLayout {
  const visible = (id: string) => architectureExplorerNodeVisible(model.nodes.get(id), options.filter, null);
  const focus = options.focusId ? model.nodes.get(options.focusId) : undefined;
  const focusId = focus && focus.kind === "router" && visible(focus.id) ? focus.id : null;
  const included: string[] = [];
  let truncated: ArchitectureExplorerMapLayout["truncated"] = null;

  if (focusId) {
    for (const id of architectureExplorerAncestorIds(model, focusId)) if (visible(id)) included.push(id);
    included.push(focusId);
    for (const id of model.nodes.get(focusId)!.childIds) if (visible(id)) included.push(id);
  } else {
    for (const node of model.nodes.values()) if (node.kind === "router" && visible(node.id)) included.push(node.id);
    if (included.length === 0) {
      const leaves = [...model.nodes.values()].filter((node) => node.kind === "leaf" && visible(node.id)).map((node) => node.id).sort(compareIds);
      included.push(...leaves.slice(0, ARCHITECTURE_EXPLORER_MAP_LEAF_LIMIT));
      if (leaves.length > included.length) truncated = { shown: included.length, total: leaves.length };
    }
  }

  const includedSet = new Set(included);
  const edges: ArchitectureExplorerMapLayout["edges"] = [];
  for (const id of included) {
    const parentId = model.nodes.get(id)?.parentId ?? null;
    if (parentId !== null && includedSet.has(parentId)) edges.push({ id: `${parentId}->${id}`, source: parentId, target: id });
  }
  const sizeFor = (id: string) => ({
    width: ARCHITECTURE_EXPLORER_MAP_NODE_WIDTH,
    height: model.nodes.get(id)?.kind === "leaf" ? ARCHITECTURE_EXPLORER_MAP_LEAF_HEIGHT : ARCHITECTURE_EXPLORER_MAP_ROUTER_HEIGHT,
  });

  if (edges.length === 0) {
    // Without links Dagre would stack every node in one column; use a grid.
    const perColumn = 10;
    return {
      nodes: included.map((id, index) => {
        const size = sizeFor(id);
        return {
          id,
          kind: model.nodes.get(id)!.kind,
          x: 24 + Math.floor(index / perColumn) * (size.width + 32),
          y: 24 + (index % perColumn) * (ARCHITECTURE_EXPLORER_MAP_ROUTER_HEIGHT + 12),
          ...size,
          hasParent: false,
        };
      }),
      edges,
      focusId,
      truncated,
    };
  }

  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 64, marginx: 24, marginy: 24 });
  for (const id of included) graph.setNode(id, sizeFor(id));
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  return {
    nodes: included.map((id) => {
      const size = sizeFor(id);
      const positioned = graph.node(id) as { x?: number; y?: number } | undefined;
      const parentId = model.nodes.get(id)?.parentId ?? null;
      return {
        id,
        kind: model.nodes.get(id)!.kind,
        x: (positioned?.x ?? size.width / 2) - size.width / 2,
        y: (positioned?.y ?? size.height / 2) - size.height / 2,
        ...size,
        hasParent: parentId !== null && includedSet.has(parentId),
      };
    }),
    edges,
    focusId,
    truncated,
  };
}
