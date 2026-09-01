import type { ArchitectureSpecV1 } from "@myskills-app/core";
import type {
  ArchitectureDetail,
  ArchitectureEnvironment,
  ArchitecturePattern,
  ArchitecturePatternId,
  ArchitectureProfile,
  ArchitectureSummary,
  OrganizationListItem,
} from "../../api.js";
import {
  type ArchitectureRevisionSummaryLike,
  type OrganizationChoice,
} from "./architecture-dashboard-types.js";

export function bootstrapArchitectureSpec(architecture: ArchitectureSummary, detail: ArchitectureDetail): ArchitectureSpecV1 {
  const patternId = architecture.patternId === "flat" || architecture.patternId === "domain-router" || architecture.patternId === "multi-level-router"
    ? architecture.patternId
    : "multi-level-router";
  const owner = detail.access?.owner ?? architecture.owner ?? {
    type: detail.access?.ownerType ?? architecture.ownerType ?? "user",
    id: detail.access?.ownerId ?? architecture.ownerId ?? "local-user",
  };
  const nodes: ArchitectureSpecV1["nodes"] = patternId === "flat"
    ? []
    : patternId === "domain-router"
      ? [{ id: "root-router", kind: "router", label: "Root router" }]
      : [
        { id: "root-router", kind: "router", label: "Root router" },
        { id: "domain-router", kind: "router", label: "Domain router" },
      ];
  const edges: ArchitectureSpecV1["edges"] = patternId === "multi-level-router"
    ? [{ from: "root-router", to: "domain-router", kind: "contains" }]
    : [];
  const profileId = "profile-default";
  const environmentId = "environment-default";
  return {
    schemaVersion: 1,
    id: architecture.id,
    name: architecture.name,
    ...(architecture.description ? { description: architecture.description } : {}),
    pattern: { id: patternId, version: 1 },
    skills: [],
    nodes,
    edges,
    entryNodeIds: patternId === "flat" ? [] : ["root-router"],
    profiles: [{
      id: profileId,
      name: owner.type === "team" ? "Team default" : "Personal default",
      subject: { type: owner.type, id: owner.id },
      defaultExposure: "disabled",
      bindings: nodes.map((node) => ({ nodeId: node.id, enabled: false, runtimeExposure: "disabled" })),
    }],
    environments: [{
      id: environmentId,
      name: owner.type === "team" ? "Team environment" : architecture.scope === "work" ? "Work environment" : "Personal environment",
      kind: owner.type === "team" ? "team" : architecture.scope === "work" ? "work" : "personal",
      profileId,
    }],
  };
}

export function patternLabel(patternId: ArchitecturePatternId): string {
  switch (patternId) {
    case "flat": return "Flat library";
    case "domain-router": return "Domain router";
    case "multi-level-router": return "Multi-level router";
    default: return patternId;
  }
}

export function patternTopologyLabel(pattern: ArchitecturePattern): string {
  if (pattern.supportsNestedRouters) return "Nested router topology";
  if (pattern.id === "flat") return "Flat leaf topology";
  return "Single-level domain routing";
}

export function revisionLabel(revision: ArchitectureRevisionSummaryLike | null | undefined): string {
  if (!revision) {
    return "Draft";
  }
  return `Revision ${revision.revision ?? revision.revisionNumber ?? revision.version ?? "—"}`;
}

export function architectureRevisionLabel(architecture: ArchitectureSummary): string {
  return revisionLabel(architecture.latestRevision ?? (architecture.revisionCount ? { revisionNumber: architecture.revisionCount } : null));
}

export function architectureOrganizationIds(
  architecture: Pick<ArchitectureSummary, "access"> | null | undefined,
): string[] {
  return [...new Set(architecture?.access?.allowedOrganizationIds ?? [])]
    .filter((organizationId): organizationId is string => Boolean(organizationId))
    .sort((left, right) => left.localeCompare(right));
}

export function organizationChoices(ids: string[], visible: readonly OrganizationListItem[]): OrganizationChoice[] {
  const byId = new Map(visible.map((organization) => [organization.id, organization]));
  return ids.map((id, index) => {
    const organization = byId.get(id);
    return organization
      ? { id: organization.id, name: organization.name, slug: organization.slug }
      : { id, name: `Authorized organization ${index + 1}`, slug: "shared" };
  });
}

export function architectureIsOrganizationOnly(
  architecture: Pick<ArchitectureSummary, "access"> | null | undefined,
): boolean {
  const reasons = architecture?.access?.reasons ?? [];
  return reasons.length === 1 && reasons[0] === "organization";
}

interface ArchitectureContextProfile {
  id: string;
  name?: string;
  subject?: { type?: string; id?: string };
}

interface ArchitectureContextEnvironment {
  id: string;
  name?: string;
  kind?: string;
  profileId?: string;
}

interface ArchitectureContextSpec {
  profiles: ArchitectureContextProfile[];
  environments: ArchitectureContextEnvironment[];
}

export function architectureContexts(detail: ArchitectureDetail): {
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
} {
  const spec = architectureContextSpec(detail.latestRevision?.spec);
  const rawEnvironments = spec.environments;
  const rawProfiles = spec.profiles;
  const declaredProfileIds = new Set(rawProfiles.map((profile) => profile.id));
  const environments = rawEnvironments.map((environment) => ({
    id: environment.id,
    name: environment.name || environment.id,
    key: environment.id,
    kind: environment.kind || undefined,
    profileId: environment.profileId || undefined,
    profileIds: environment.profileId ? [environment.profileId] : [],
  })).filter((environment) => environment.id && environment.profileId && declaredProfileIds.has(environment.profileId));
  const profiles = rawProfiles.map((profile) => {
    const id = profile.id;
    const subject = profile.subject;
    const environmentKinds = rawEnvironments
      .filter((environment) => environment.profileId === id)
      .map((environment) => environment.kind);
    const scope = subject?.type === "team"
      ? "team"
      : environmentKinds.includes("work")
        ? "work"
        : "personal";
    return {
      id,
      name: profile.name || id,
      scope,
      ...(subject?.type === "team" ? { teamId: subject.id || null } : {}),
      environmentIds: environments.filter((environment) => environment.profileIds?.includes(id)).map((environment) => environment.id),
    };
  }).filter((profile) => profile.id && profile.environmentIds.length > 0);
  return { profiles, environments };
}

function architectureContextSpec(value: unknown): ArchitectureContextSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { profiles: [], environments: [] };
  }
  const candidate = value as { profiles?: unknown; environments?: unknown };
  return {
    profiles: Array.isArray(candidate.profiles) ? candidate.profiles.filter(isArchitectureContextProfile) : [],
    environments: Array.isArray(candidate.environments) ? candidate.environments.filter(isArchitectureContextEnvironment) : [],
  };
}

function isArchitectureContextProfile(value: unknown): value is ArchitectureContextProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; name?: unknown; subject?: unknown };
  if (typeof candidate.id !== "string" || !candidate.id) {
    return false;
  }
  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    return false;
  }
  if (candidate.subject === undefined) {
    return true;
  }
  if (!candidate.subject || typeof candidate.subject !== "object" || Array.isArray(candidate.subject)) {
    return false;
  }
  const subject = candidate.subject as { type?: unknown; id?: unknown };
  return (subject.type === undefined || typeof subject.type === "string")
    && (subject.id === undefined || typeof subject.id === "string");
}

function isArchitectureContextEnvironment(value: unknown): value is ArchitectureContextEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; name?: unknown; kind?: unknown; profileId?: unknown };
  return typeof candidate.id === "string"
    && Boolean(candidate.id)
    && (candidate.name === undefined || typeof candidate.name === "string")
    && (candidate.kind === undefined || typeof candidate.kind === "string")
    && (candidate.profileId === undefined || typeof candidate.profileId === "string");
}

export function environmentBelongsToProfile(environment: ArchitectureEnvironment, profileId: string): boolean {
  return environment.profileId === profileId || Boolean(environment.profileIds?.includes(profileId));
}

export function environmentProfileId(environment: ArchitectureEnvironment, profiles: ArchitectureProfile[]): string | undefined {
  const candidate = environment.profileId ?? environment.profileIds?.find((profileId) => profiles.some((profile) => profile.id === profileId));
  return candidate && profiles.some((profile) => profile.id === candidate) ? candidate : undefined;
}

export function boundEnvironmentForProfile(environments: ArchitectureEnvironment[], profileId: string): ArchitectureEnvironment | undefined {
  return environments.find((environment) => environmentBelongsToProfile(environment, profileId));
}

export function formatArchitectureSpec(spec: unknown): string {
  if (!spec || typeof spec !== "object") {
    return "";
  }
  try {
    return JSON.stringify(spec, null, 2);
  } catch {
    return "";
  }
}

export function truncateSvgLabel(value: string): string {
  return value.length > 25 ? `${value.slice(0, 22)}…` : value;
}

export function isLeafNodeKind(kind: string): boolean {
  return kind === "leaf";
}

export function runtimeExposureLabel(value: string | undefined): string {
  if (value === "router") return "Router only";
  if (value === "leaf") return "Direct leaf";
  return "Not exposed";
}

export function isUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 501 || candidate.code === "ARCHITECTURE_NOT_SUPPORTED";
}
