import {
  canonicalizeJson,
  type ArchitectureNode,
  type ArchitectureProfileBinding,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import { architectureSpecKey } from "./draft.js";

export type ArchitectureDraftChangeKind =
  | "rename"
  | "add"
  | "remove"
  | "move"
  | "release"
  | "exposure"
  | "profile"
  | "environment"
  | "other";

/** One named, readable difference between a saved baseline and the current draft. */
export interface ArchitectureDraftChange {
  /** Stable and unique within one result; suitable as a list key. */
  id: string;
  kind: ArchitectureDraftChangeKind;
  /** The node label (or profile, environment or architecture name) the change is about. */
  subject: string;
  before?: string;
  after?: string;
  /** One readable sentence, for example `Renamed “Old” → “New”`. */
  summary: string;
  /** The architecture node this change concerns, when there is one. */
  nodeId?: string;
}

const LABEL_LIMIT = 120;
const OTHER_CATEGORY_LIMIT = 5;
const ENVIRONMENT_NAME_LIMIT = 3;

interface ReleaseDescriptor {
  skillRefId: string;
  slug: string;
  version: string;
  digest: string;
}

/**
 * Describe the named differences between the revision a draft started from
 * and the current draft. Nodes are matched by id and parents are derived from
 * the first incoming edge, exactly as the editor's outline does. The result
 * is deterministic: architecture, then nodes in draft outline order, removed
 * nodes in baseline outline order, profiles, environments, exposure and a
 * single bounded "Other changes" entry for anything not named individually.
 *
 * This is a pure projection: it does not validate, authorize or persist.
 */
export function describeArchitectureDraftChanges(
  baseline: ArchitectureSpecV1 | null,
  draft: ArchitectureSpecV1,
): ArchitectureDraftChange[] {
  const base = baseline ?? emptyBaseline(draft);
  const changes: ArchitectureDraftChange[] = [];
  const other = new Map<string, number>();
  const addOther = (category: string) => other.set(category, (other.get(category) ?? 0) + 1);

  // Architecture-level details.
  if (base.name !== draft.name) {
    changes.push({
      id: "rename:architecture",
      kind: "rename",
      subject: draft.name,
      before: base.name,
      after: draft.name,
      summary: `Renamed architecture ${quote(base.name)} → ${quote(draft.name)}`,
    });
  }
  if (base.description !== draft.description) {
    const before = base.description ?? "";
    const after = draft.description ?? "";
    const summary = !before.trim() && after.trim()
      ? "Added an architecture description"
      : before.trim() && !after.trim()
        ? "Removed the architecture description"
        : "Changed the architecture description";
    changes.push({ id: "other:description", kind: "other", subject: draft.name, before, after, summary });
  }
  if (base.pattern?.id !== draft.pattern?.id || base.pattern?.version !== draft.pattern?.version) addOther("pattern");
  if (base.schemaVersion !== draft.schemaVersion || base.id !== draft.id) addOther("architecture identity");
  if (!sameJson(base.metadata, draft.metadata)) addOther("architecture metadata");

  // Nodes, in draft outline order.
  const baseNodes = firstById(base.nodes);
  const draftNodes = firstById(draft.nodes);
  const baseParents = parentMap(base);
  const draftParents = parentMap(draft);
  const baseSkills = firstById(base.skills);
  const draftSkills = firstById(draft.skills);
  const draftOrder = outlineOrder(draft);
  const baseOrder = outlineOrder(base);
  const added = new Set<string>();
  const removed = new Set<string>();
  const moved = new Set<string>();
  const survivingSkillRefs = new Set<string>();

  for (const id of draftOrder) {
    const node = draftNodes.get(id);
    if (!node) continue;
    const previous = baseNodes.get(id);
    if (!previous) {
      added.add(id);
      const parentId = draftParents.get(id) ?? null;
      const place = parentId ? `under ${quote(nodeLabel(parentId, draftNodes, baseNodes))}` : "at the top level";
      const release = releaseOf(draftSkills, node.skillRefId);
      const releaseNote = release ? ` (${release.slug}@${release.version || "unresolved"})` : "";
      changes.push({
        id: `add:${id}`,
        kind: "add",
        subject: node.label,
        after: node.label,
        nodeId: id,
        summary: `Added ${nodeNoun(node)} ${quote(node.label)} ${place}${releaseNote}`,
      });
      continue;
    }
    if (previous.label !== node.label) {
      changes.push({
        id: `rename:${id}`,
        kind: "rename",
        subject: node.label,
        before: previous.label,
        after: node.label,
        nodeId: id,
        summary: `Renamed ${quote(previous.label)} → ${quote(node.label)}`,
      });
    }
    const previousParent = baseParents.get(id) ?? null;
    const nextParent = draftParents.get(id) ?? null;
    if (previousParent !== nextParent) {
      moved.add(id);
      const before = previousParent ? nodeLabel(previousParent, baseNodes, draftNodes) : "top level";
      const after = nextParent ? nodeLabel(nextParent, draftNodes, baseNodes) : "top level";
      changes.push({
        id: `move:${id}`,
        kind: "move",
        subject: node.label,
        before,
        after,
        nodeId: id,
        summary: `Moved ${quote(node.label)} from ${previousParent ? quote(before) : "the top level"} to ${nextParent ? quote(after) : "the top level"}`,
      });
    }
    const previousRelease = releaseOf(baseSkills, previous.skillRefId);
    const nextRelease = releaseOf(draftSkills, node.skillRefId);
    if (previous.skillRefId) survivingSkillRefs.add(previous.skillRefId);
    if (node.skillRefId) survivingSkillRefs.add(node.skillRefId);
    if (!sameRelease(previousRelease, nextRelease)) {
      const before = releaseLabel(previousRelease, nextRelease);
      const after = releaseLabel(nextRelease, previousRelease);
      changes.push({
        id: `release:${id}`,
        kind: "release",
        subject: node.label,
        before,
        after,
        nodeId: id,
        summary: `Release for ${quote(node.label)}: ${before} → ${after}`,
      });
    } else if (previousRelease && nextRelease && previousRelease.skillRefId !== nextRelease.skillRefId) {
      addOther("skill references");
    }
    if (previous.kind !== node.kind) addOther("node types");
    if (!sameJson(previous.metadata, node.metadata)) addOther("node metadata");
  }

  // Removed nodes, in baseline outline order. A removed subtree is one change.
  for (const id of baseOrder) {
    if (!draftNodes.has(id)) removed.add(id);
  }
  const removedDescendants = new Map<string, number>();
  for (const id of baseOrder) {
    if (!removed.has(id)) continue;
    let top = id;
    const trail = new Set([id]);
    let parent = baseParents.get(top);
    while (parent && removed.has(parent) && !trail.has(parent)) {
      trail.add(parent);
      top = parent;
      parent = baseParents.get(top);
    }
    removedDescendants.set(top, (removedDescendants.get(top) ?? 0) + (top === id ? 0 : 1));
  }
  for (const id of baseOrder) {
    const count = removedDescendants.get(id);
    const node = baseNodes.get(id);
    if (count === undefined || !node) continue;
    changes.push({
      id: `remove:${id}`,
      kind: "remove",
      subject: node.label,
      before: node.label,
      nodeId: id,
      summary: `Removed ${nodeNoun(node)} ${quote(node.label)}${count > 0 ? ` and ${count} descendant${count === 1 ? "" : "s"}` : ""}`,
    });
  }

  // Topology details that the named node changes above do not explain.
  const baseEdges = new Map(base.edges.map((edge) => [edgeKey(edge), edge] as const));
  const draftEdges = new Map(draft.edges.map((edge) => [edgeKey(edge), edge] as const));
  for (const [key, edge] of draftEdges) {
    const previous = baseEdges.get(key);
    if (previous) {
      if (previous.kind !== edge.kind || !sameJson(previous.metadata, edge.metadata)) addOther("links");
      continue;
    }
    const explained = added.has(edge.to) || (moved.has(edge.to) && draftParents.get(edge.to) === edge.from);
    if (!explained) addOther("links");
  }
  for (const [key, edge] of baseEdges) {
    if (draftEdges.has(key)) continue;
    const explained = removed.has(edge.to)
      || removed.has(edge.from)
      || (moved.has(edge.to) && baseParents.get(edge.to) === edge.from);
    if (!explained) addOther("links");
  }
  const baseEntries = new Set(base.entryNodeIds);
  const draftEntries = new Set(draft.entryNodeIds);
  for (const id of draftEntries) {
    if (!baseEntries.has(id) && !added.has(id) && !moved.has(id)) addOther("entry points");
  }
  for (const id of baseEntries) {
    if (!draftEntries.has(id) && !removed.has(id) && !moved.has(id)) addOther("entry points");
  }

  // Skill catalogue entries that no named node change accounts for.
  const addedSkillRefs = new Set<string>();
  for (const id of added) {
    const skillRefId = draftNodes.get(id)?.skillRefId;
    if (skillRefId) addedSkillRefs.add(skillRefId);
  }
  const removedSkillRefs = new Set<string>();
  for (const id of removed) {
    const skillRefId = baseNodes.get(id)?.skillRefId;
    if (skillRefId) removedSkillRefs.add(skillRefId);
  }
  for (const [id, skill] of draftSkills) {
    const previous = baseSkills.get(id);
    if (!previous) {
      // Named by an added node or a node's release change.
      if (!addedSkillRefs.has(id) && !survivingSkillRefs.has(id)) addOther("skill catalogue");
      continue;
    }
    if (sameJson(previous, skill)) continue;
    const releaseChanged = previous.slug !== skill.slug || previous.version !== skill.version || previous.digest !== skill.digest;
    if (!sameJson(skillDetails(previous), skillDetails(skill))) addOther("skill details");
    if (releaseChanged && !survivingSkillRefs.has(id)) addOther("skill catalogue");
  }
  for (const id of baseSkills.keys()) {
    if (!draftSkills.has(id) && !removedSkillRefs.has(id) && !survivingSkillRefs.has(id)) addOther("skill catalogue");
  }

  // Profiles.
  const baseProfiles = firstById(base.profiles);
  const draftProfiles = firstById(draft.profiles);
  for (const profile of draftProfiles.values()) {
    const previous = baseProfiles.get(profile.id);
    if (!previous) {
      changes.push({
        id: `profile:add:${profile.id}`,
        kind: "profile",
        subject: profile.name,
        after: profile.name,
        summary: `Added profile ${quote(profile.name)}`,
      });
      continue;
    }
    if (previous.name !== profile.name) {
      changes.push({
        id: `profile:rename:${profile.id}`,
        kind: "profile",
        subject: profile.name,
        before: previous.name,
        after: profile.name,
        summary: `Renamed profile ${quote(previous.name)} → ${quote(profile.name)}`,
      });
    }
    if (!sameJson(previous.subject, profile.subject) || previous.defaultExposure !== profile.defaultExposure || !sameJson(previous.metadata, profile.metadata)) {
      addOther("profile settings");
    }
  }
  for (const profile of baseProfiles.values()) {
    if (draftProfiles.has(profile.id)) continue;
    changes.push({
      id: `profile:remove:${profile.id}`,
      kind: "profile",
      subject: profile.name,
      before: profile.name,
      summary: `Removed profile ${quote(profile.name)}`,
    });
  }

  // Environments.
  const baseEnvironments = firstById(base.environments);
  const draftEnvironments = firstById(draft.environments);
  const profileName = (id: string | null | undefined, primary: typeof draftProfiles, secondary: typeof baseProfiles) =>
    id ? primary.get(id)?.name ?? secondary.get(id)?.name ?? id : "none";
  const environmentName = (id: string | null | undefined, primary: typeof draftEnvironments, secondary: typeof baseEnvironments) =>
    id ? primary.get(id)?.name ?? secondary.get(id)?.name ?? id : "top level";
  for (const environment of draftEnvironments.values()) {
    const previous = baseEnvironments.get(environment.id);
    if (!previous) {
      changes.push({
        id: `environment:add:${environment.id}`,
        kind: "environment",
        subject: environment.name,
        after: environment.name,
        summary: `Added ${environment.kind} environment ${quote(environment.name)}`,
      });
      continue;
    }
    if (previous.name !== environment.name) {
      changes.push({
        id: `environment:rename:${environment.id}`,
        kind: "environment",
        subject: environment.name,
        before: previous.name,
        after: environment.name,
        summary: `Renamed environment ${quote(previous.name)} → ${quote(environment.name)}`,
      });
    }
    if (previous.kind !== environment.kind) {
      changes.push({
        id: `environment:kind:${environment.id}`,
        kind: "environment",
        subject: environment.name,
        before: previous.kind,
        after: environment.kind,
        summary: `Environment ${quote(environment.name)} type: ${previous.kind} → ${environment.kind}`,
      });
    }
    if (previous.profileId !== environment.profileId) {
      const before = profileName(previous.profileId, baseProfiles, draftProfiles);
      const after = profileName(environment.profileId, draftProfiles, baseProfiles);
      changes.push({
        id: `environment:profile:${environment.id}`,
        kind: "environment",
        subject: environment.name,
        before,
        after,
        summary: `Environment ${quote(environment.name)} profile: ${quote(before)} → ${quote(after)}`,
      });
    }
    const previousParent = previous.parentId ?? null;
    const nextParent = environment.parentId ?? null;
    if (previousParent !== nextParent) {
      const before = environmentName(previousParent, baseEnvironments, draftEnvironments);
      const after = environmentName(nextParent, draftEnvironments, baseEnvironments);
      changes.push({
        id: `environment:parent:${environment.id}`,
        kind: "environment",
        subject: environment.name,
        before,
        after,
        summary: `Environment ${quote(environment.name)} parent: ${previousParent ? quote(before) : "top level"} → ${nextParent ? quote(after) : "top level"}`,
      });
    }
    if (!sameJson(previous.metadata, environment.metadata)) addOther("environment metadata");
  }
  for (const environment of baseEnvironments.values()) {
    if (draftEnvironments.has(environment.id)) continue;
    changes.push({
      id: `environment:remove:${environment.id}`,
      kind: "environment",
      subject: environment.name,
      before: environment.name,
      summary: `Removed environment ${quote(environment.name)}`,
    });
  }

  // Exposure, per profile, node and normalized environment scope. A missing
  // rule differs from an explicit deny because another rule can supply exposure.
  const baseEnvironmentNames = new Map([...baseEnvironments.values()].map((environment) => [environment.id, environment.name] as const));
  const draftEnvironmentNames = new Map([...draftEnvironments.values()].map((environment) => [environment.id, environment.name] as const));
  for (const profile of draftProfiles.values()) {
    const previousBindings = bindingMap(baseProfiles.get(profile.id)?.bindings ?? []);
    const nextBindings = bindingMap(profile.bindings);
    for (const id of draftOrder) {
      const node = draftNodes.get(id);
      if (!node) continue;
      const previousScopes = previousBindings.get(id);
      const nextScopes = nextBindings.get(id);
      const scopes = new Set([...(previousScopes?.keys() ?? []), ...(nextScopes?.keys() ?? [])]);
      for (const scope of [...scopes].sort()) {
        const previous = previousScopes?.get(scope);
        const next = nextScopes?.get(scope);
        if (sameExposure(previous, next)) {
          if (previous && next && !sameJson(previous.metadata, next.metadata)) addOther("binding metadata");
          continue;
        }
        const before = exposureLabel(previous, baseEnvironmentNames, draftEnvironmentNames);
        const after = exposureLabel(next, draftEnvironmentNames, baseEnvironmentNames);
        changes.push({
          id: `exposure:${JSON.stringify([profile.id, id, scope])}`,
          kind: "exposure",
          subject: node.label,
          before,
          after,
          nodeId: id,
          summary: `Exposure for ${quote(node.label)} in ${quote(profile.name)}: ${before} → ${after}`,
        });
      }
    }
  }

  if (other.size > 0) {
    const parts = [...other].map(([category, count]) => (count > 1 ? `${category} (${count})` : category));
    const shown = parts.slice(0, OTHER_CATEGORY_LIMIT);
    const rest = parts.length - shown.length;
    changes.push({
      id: "other:aggregate",
      kind: "other",
      subject: draft.name,
      summary: `Other changes: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    });
  }

  // Keep the list consistent with the editor's dirty state: a draft that
  // differs from its baseline never reads as unchanged.
  if (changes.length === 0 && baseline && architectureSpecKey(baseline) !== architectureSpecKey(draft)) {
    changes.push({
      id: "other:unlisted",
      kind: "other",
      subject: draft.name,
      summary: "Other changes that are not listed individually",
    });
  }

  return uniqueChangeIds(changes);
}

function emptyBaseline(draft: ArchitectureSpecV1): ArchitectureSpecV1 {
  return { ...draft, skills: [], nodes: [], edges: [], entryNodeIds: [], profiles: [], environments: [] };
}

function quote(value: string): string {
  const input: unknown = value;
  const raw = typeof input === "string" ? input : input == null ? "" : String(input);
  const text = raw.trim() ? raw : "(unnamed)";
  return `“${text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text}”`;
}

function nodeNoun(node: ArchitectureNode): string {
  return node.kind === "router" ? "router" : "skill";
}

function nodeLabel(id: string, primary: ReadonlyMap<string, ArchitectureNode>, secondary: ReadonlyMap<string, ArchitectureNode>): string {
  return primary.get(id)?.label ?? secondary.get(id)?.label ?? id;
}

/** First item wins for duplicate ids, matching a forward search. */
function firstById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (!result.has(item.id)) result.set(item.id, item);
  }
  return result;
}

/** The first incoming edge is the parent, as in the editor's parentNodeId. */
function parentMap(spec: ArchitectureSpecV1): Map<string, string> {
  const parents = new Map<string, string>();
  for (const edge of spec.edges) {
    if (!parents.has(edge.to)) parents.set(edge.to, edge.from);
  }
  return parents;
}

/**
 * Depth-first outline order: declared entry nodes, then other roots, then any
 * orphaned nodes, each visited once. This mirrors the editor outline without
 * duplicating nodes that have more than one incoming edge.
 */
function outlineOrder(spec: ArchitectureSpecV1): string[] {
  const known = new Set(spec.nodes.map((node) => node.id));
  const children = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of spec.edges) {
    if (!known.has(edge.to)) continue;
    const siblings = children.get(edge.from) ?? [];
    siblings.push(edge.to);
    children.set(edge.from, siblings);
    incoming.add(edge.to);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !known.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  for (const id of spec.entryNodeIds) visit(id);
  for (const node of spec.nodes) {
    if (!incoming.has(node.id)) visit(node.id);
  }
  for (const node of spec.nodes) visit(node.id);
  return order;
}

function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from}\u0000${edge.to}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return canonicalizeJson(left) === canonicalizeJson(right);
  } catch {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}

function skillDetails(skill: ArchitectureSkillRef): Omit<ArchitectureSkillRef, "slug" | "version" | "digest"> {
  const { slug: _slug, version: _version, digest: _digest, ...details } = skill;
  return details;
}

function releaseOf(skills: ReadonlyMap<string, ArchitectureSkillRef>, skillRefId: string | undefined): ReleaseDescriptor | null {
  if (!skillRefId) return null;
  const skill = skills.get(skillRefId);
  return {
    skillRefId,
    slug: skill?.slug ?? skillRefId,
    version: skill?.version ?? "",
    digest: skill?.digest ?? "",
  };
}

function sameRelease(left: ReleaseDescriptor | null, right: ReleaseDescriptor | null): boolean {
  if (!left || !right) return left === right;
  return left.slug === right.slug && left.version === right.version && left.digest === right.digest;
}

/** Show the exact version; add the slug or a short digest only when needed to tell them apart. */
function releaseLabel(release: ReleaseDescriptor | null, other: ReleaseDescriptor | null): string {
  if (!release) return "no release";
  const version = release.version || "unresolved";
  const sameSlug = other !== null && other.slug === release.slug;
  const digestOnly = other !== null
    && other.slug === release.slug
    && other.version === release.version
    && other.digest !== release.digest;
  const digest = digestOnly ? ` (${release.digest ? `${release.digest.slice(0, 12)}…` : "no digest"})` : "";
  return sameSlug ? `${version}${digest}` : `${release.slug}@${version}${digest}`;
}

function bindingMap(bindings: readonly ArchitectureProfileBinding[]): Map<string, Map<string, ArchitectureProfileBinding>> {
  const result = new Map<string, Map<string, ArchitectureProfileBinding>>();
  for (const binding of bindings) {
    const scopes = result.get(binding.nodeId) ?? new Map<string, ArchitectureProfileBinding>();
    const key = environmentScopeKey(binding);
    if (!scopes.has(key)) scopes.set(key, binding);
    result.set(binding.nodeId, scopes);
  }
  return result;
}

function environmentScopeKey(binding: ArchitectureProfileBinding | undefined): string {
  const ids = binding?.environmentIds;
  return ids === undefined ? "*" : [...new Set(ids)].sort().join("\u0000");
}

function sameExposure(left: ArchitectureProfileBinding | undefined, right: ArchitectureProfileBinding | undefined): boolean {
  if (!left || !right) return left === right;
  const leftEnabled = left?.enabled ?? false;
  const rightEnabled = right?.enabled ?? false;
  return leftEnabled === rightEnabled
    && (left?.runtimeExposure ?? "disabled") === (right?.runtimeExposure ?? "disabled")
    && environmentScopeKey(left) === environmentScopeKey(right);
}

function exposureLabel(
  binding: ArchitectureProfileBinding | undefined,
  names: ReadonlyMap<string, string>,
  fallbackNames: ReadonlyMap<string, string>,
): string {
  if (!binding) return "No explicit rule";
  const enabled = binding?.enabled ?? false;
  const mode = enabled ? binding?.runtimeExposure ?? "disabled" : "disabled";
  const modeLabel = `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
  const ids = binding?.environmentIds;
  if (ids === undefined) return enabled ? `${modeLabel} · all environments` : modeLabel;
  if (ids.length === 0) return `${modeLabel} · no environments`;
  const labels = [...ids].sort().map((id) => names.get(id) ?? fallbackNames.get(id) ?? id);
  const shown = labels.slice(0, ENVIRONMENT_NAME_LIMIT);
  const rest = labels.length - shown.length;
  return `${modeLabel} · ${shown.join(", ")}${rest > 0 ? ` +${rest} more` : ""}`;
}

function uniqueChangeIds(changes: ArchitectureDraftChange[]): ArchitectureDraftChange[] {
  const seen = new Map<string, number>();
  return changes.map((change) => {
    const count = seen.get(change.id) ?? 0;
    seen.set(change.id, count + 1);
    return count === 0 ? change : { ...change, id: `${change.id}#${count + 1}` };
  });
}
