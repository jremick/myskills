import {
  architectureSyncActions,
  ArchitectureCompileError,
  type ArchitectureSyncPlan,
  type ArchitectureSyncPlanItem,
  type CompiledArchitecture,
  type CompiledArchitectureNode,
  type ObservedArchitectureNode,
  type ObservedArchitectureState,
} from "./architecture-contracts.js";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

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
    if (!router) {
      if (observed && observed.managed !== true) return { action: "unsupported", nodeId: allNode.id, kind: allNode.kind, reason: "Target router is not explicitly managed by MySkills.", desired, observed };
      return { action: "configure-router", nodeId: allNode.id, kind: allNode.kind, reason: "Router configuration is absent on the target.", desired, observed };
    }
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

function assertObservedAliasesMatchExplicitNode(
  node: ObservedArchitectureNodeRecord,
  desiredNodeId: string,
  desiredIdentities: { bySkillRef: Map<string, string[]>; bySlug: Map<string, string[]> },
): void {
  if (node.nodeId !== desiredNodeId) return;
  for (const [identity, candidates] of [
    [node.skillRefId, desiredIdentities.bySkillRef.get(node.skillRefId ?? "")],
    [node.slug, desiredIdentities.bySlug.get(node.slug ?? "")],
  ] as const) {
    if (identity !== undefined && (candidates === undefined || !candidates.includes(desiredNodeId))) observedIdentityConflict();
  }
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
    const explicitNodeIdIsUnknown = node.nodeId !== undefined && !desiredByNodeId.has(node.nodeId);
    const explicitAliasMatchesDesired = [
      node.skillRefId !== undefined && desiredIdentities.bySkillRef.has(node.skillRefId),
      node.slug !== undefined && desiredIdentities.bySlug.has(node.slug),
    ].some(Boolean);
    if (explicitNodeIdIsUnknown && explicitAliasMatchesDesired) observedIdentityConflict();

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
    assertObservedAliasesMatchExplicitNode(node, desiredNodeId, desiredIdentities);
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
