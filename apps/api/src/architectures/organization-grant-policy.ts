import {
  organizationPolicyDigest,
  type ArchitectureOwnerReference,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
} from "@myskills-app/core";

/**
 * The policy version is local to the architecture-grant mutation contract.
 * It is deliberately separate from the read/preview architecture policy
 * version because this decision also covers organization mutation gates.
 */
export const architectureOrganizationGrantPolicyVersion = 1 as const;

export type ArchitectureOrganizationGrantPolicyFailureCode =
  | "ARCHITECTURE_REVISION_CONFLICT"
  | "ARCHITECTURE_GRANT_MANAGE_REQUIRED"
  | "ARCHITECTURE_CURRENT_REVISION_REQUIRED"
  | "ARCHITECTURE_CURRENT_REVISION_UNAVAILABLE"
  | "ORGANIZATION_SHARING_DISABLED"
  | "ARCHITECTURE_TEAM_PARENT_UNAVAILABLE"
  | "ORGANIZATION_POLICY_REQUIRED"
  | "ORGANIZATION_POLICY_INVALID"
  | "ORGANIZATION_POLICY_CONFLICT"
  | "ORGANIZATION_ARCHITECTURE_SHARING_DISABLED"
  | "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN"
  | "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED"
  | "ARCHITECTURE_RELEASE_NOT_VISIBLE";

export interface ArchitectureOrganizationGrantRequestedGrant {
  readonly organizationId: string;
  readonly accessLevel?: "read";
  readonly createdUnderPolicyRevisionId: string;
}

/** Exact release result captured by an adapter's authoritative registry read. */
export interface ArchitectureOrganizationGrantReleaseCheck {
  readonly organizationId: string;
  readonly skill: Pick<ArchitectureSkillRef, "id" | "slug" | "version" | "digest" | "packageVisibility">;
  readonly allowed: boolean;
  /** False when a provider returned metadata that does not identify the exact reference. */
  readonly identityMatches: boolean;
  readonly code?: string;
}

export interface ArchitectureOrganizationGrantPolicySnapshot {
  readonly architectureId: string;
  readonly actorUserId: string;
  readonly owner: ArchitectureOwnerReference;
  /** True only after the adapter resolves the actor against the owner boundary. */
  readonly actorCanManage: boolean;
  readonly currentRevisionId: string | null;
  readonly currentRevision: {
    readonly id: string;
    readonly architectureId: string;
    readonly spec: ArchitectureSpecV1;
  } | null;
  readonly sharing: {
    readonly organizationVisibilityEnabled: boolean;
    readonly publicVisibilityEnabled: boolean;
    readonly authenticatedVisibilityEnabled: boolean;
  };
  readonly teamParent: {
    /** Null is a known standalone team. */
    readonly organizationId: string | null;
    /** False means the owner team row could not be resolved. */
    readonly teamExists: boolean;
  };
  /** Includes the team parent context when one exists, even for an empty revoke. */
  readonly organizations: readonly ArchitectureOrganizationGrantOrganizationSnapshot[];
  readonly releaseChecks: readonly ArchitectureOrganizationGrantReleaseCheck[];
}

export interface ArchitectureOrganizationGrantOrganizationSnapshot {
  readonly organizationId: string;
  readonly status: OrganizationStatus;
  readonly currentPolicyRevisionId: string | null;
  readonly currentPolicy: {
    readonly id: string;
    readonly organizationId: string;
    readonly policy: OrganizationPolicyV1;
    readonly policySha256: string;
  } | null;
  /** Only an active membership is represented. */
  readonly actorMembershipRole: OrganizationMembershipRole | null;
}

export interface ArchitectureOrganizationGrantPolicyCommand {
  readonly architectureId: string;
  readonly actorUserId: string;
  readonly expectedCurrentRevisionId: string | null;
  readonly grants: readonly ArchitectureOrganizationGrantRequestedGrant[];
}

export interface ArchitectureOrganizationGrantPolicyAllowed {
  readonly allowed: true;
  readonly policyVersion: typeof architectureOrganizationGrantPolicyVersion;
  readonly targetLimit: number;
  readonly organizationIds: readonly string[];
}

export interface ArchitectureOrganizationGrantPolicyDenied {
  readonly allowed: false;
  readonly policyVersion: typeof architectureOrganizationGrantPolicyVersion;
  readonly code: ArchitectureOrganizationGrantPolicyFailureCode;
  readonly statusCode: 403 | 409;
  readonly limit?: number;
}

export type ArchitectureOrganizationGrantPolicyDecision =
  | ArchitectureOrganizationGrantPolicyAllowed
  | ArchitectureOrganizationGrantPolicyDenied;

const MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS = 500;
const RELEASE_VISIBILITIES = new Set(["public", "authenticated", "organization"]);

/**
 * Evaluate one complete replacement against one immutable authorization
 * snapshot. This function has no I/O and does not mutate either input. The
 * memory and PostgreSQL adapters deliberately call this same function.
 */
export function evaluateArchitectureOrganizationGrantPolicy(
  snapshot: ArchitectureOrganizationGrantPolicySnapshot,
  command: ArchitectureOrganizationGrantPolicyCommand,
): ArchitectureOrganizationGrantPolicyDecision {
  if (snapshot.architectureId !== command.architectureId || snapshot.actorUserId !== command.actorUserId) {
    return denied("ARCHITECTURE_GRANT_MANAGE_REQUIRED", 403);
  }
  if (snapshot.currentRevisionId !== command.expectedCurrentRevisionId) {
    return denied("ARCHITECTURE_REVISION_CONFLICT", 409);
  }
  if (!snapshot.actorCanManage) {
    return denied("ARCHITECTURE_GRANT_MANAGE_REQUIRED", 403);
  }
  if (!snapshot.teamParent.teamExists) {
    return denied("ARCHITECTURE_TEAM_PARENT_UNAVAILABLE", 403);
  }

  if (snapshot.teamParent.organizationId !== null) {
    const parent = snapshot.organizations.find((candidate) => (
      candidate.organizationId === snapshot.teamParent.organizationId
    ));
    if (!parent || !isCurrentOrganizationContext(parent)) {
      return denied("ARCHITECTURE_TEAM_PARENT_UNAVAILABLE", 403);
    }
  }

  const requestedOrganizationIds = command.grants.map((grant) => grant.organizationId);
  if (requestedOrganizationIds.length > MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS) {
    return denied(
      "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED",
      409,
      MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS,
    );
  }
  if (requestedOrganizationIds.length === 0) {
    // Revocation remains valid while global organization sharing is disabled.
    // A parented team still needs a current effective parent context because
    // that is part of the owner authorization boundary.
    return allowed([], MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS);
  }

  if (!snapshot.currentRevision) {
    return denied("ARCHITECTURE_CURRENT_REVISION_REQUIRED", 409);
  }
  if (
    snapshot.currentRevision.id !== snapshot.currentRevisionId
    || snapshot.currentRevision.architectureId !== snapshot.architectureId
  ) {
    return denied("ARCHITECTURE_CURRENT_REVISION_UNAVAILABLE", 409);
  }
  if (!snapshot.sharing.organizationVisibilityEnabled) {
    return denied("ORGANIZATION_SHARING_DISABLED", 403);
  }

  const contexts = new Map<string, ArchitectureOrganizationGrantOrganizationSnapshot>();
  for (const grant of command.grants) {
    const context = snapshot.organizations.find((candidate) => candidate.organizationId === grant.organizationId);
    if (!context || context.status !== "active" || context.actorMembershipRole === null) {
      return denied("ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN", 403);
    }
    if (context.currentPolicyRevisionId === null || context.currentPolicy === null) {
      return denied("ORGANIZATION_POLICY_REQUIRED", 409);
    }
    if (
      context.currentPolicy.id !== context.currentPolicyRevisionId
      || context.currentPolicy.organizationId !== context.organizationId
    ) {
      return denied("ORGANIZATION_POLICY_REQUIRED", 409);
    }
    if (grant.createdUnderPolicyRevisionId !== context.currentPolicyRevisionId) {
      return denied("ORGANIZATION_POLICY_CONFLICT", 409);
    }
    const policy = context.currentPolicy.policy;
    if (!policyDigestMatches(context)) {
      return denied("ORGANIZATION_POLICY_INVALID", 409);
    }
    if (!policy.sharing.organizationArchitectureSharingEnabled) {
      return denied("ORGANIZATION_ARCHITECTURE_SHARING_DISABLED", 403);
    }

    const isOrganizationAdmin = context.actorMembershipRole === "owner" || context.actorMembershipRole === "admin";
    const isTeamParent = snapshot.owner.type === "team"
      && snapshot.teamParent.organizationId === grant.organizationId;
    if (!isOrganizationAdmin && !(
      isTeamParent
      && policy.sharing.teamOwnersCanShareArchitecturesToParentOrganization
    )) {
      return denied("ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN", 403);
    }
    contexts.set(grant.organizationId, context);
  }

  let targetLimit = MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS;
  for (const context of contexts.values()) {
    targetLimit = Math.min(targetLimit, context.currentPolicy?.policy.limits.organizationGrantsPerArchitecture ?? 0);
  }
  if (command.grants.length > targetLimit) {
    return denied("ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED", 409, targetLimit);
  }

  const requestedOrganizationSet = new Set(requestedOrganizationIds);
  for (const skill of snapshot.currentRevision.spec.skills) {
    if (!RELEASE_VISIBILITIES.has(skill.packageVisibility)) {
      return denied("ARCHITECTURE_RELEASE_NOT_VISIBLE", 403);
    }
    if (skill.packageVisibility === "public" && !snapshot.sharing.publicVisibilityEnabled) {
      return denied("ARCHITECTURE_RELEASE_NOT_VISIBLE", 403);
    }
    if (skill.packageVisibility === "authenticated" && !snapshot.sharing.authenticatedVisibilityEnabled) {
      return denied("ARCHITECTURE_RELEASE_NOT_VISIBLE", 403);
    }
    if (skill.packageVisibility === "organization") {
      for (const organizationId of requestedOrganizationSet) {
        const context = contexts.get(organizationId);
        if (!context?.currentPolicy?.policy.sharing.organizationSkillSharingEnabled) {
          return denied("ARCHITECTURE_RELEASE_NOT_VISIBLE", 403);
        }
      }
    }
    for (const organizationId of requestedOrganizationSet) {
      const check = snapshot.releaseChecks.find((candidate) => (
        candidate.organizationId === organizationId && sameSkill(candidate.skill, skill)
      ));
      if (!check || !check.allowed || !check.identityMatches) {
        return denied("ARCHITECTURE_RELEASE_NOT_VISIBLE", 403);
      }
    }
  }

  return allowed([...contexts.keys()].sort(compareStrings), targetLimit);
}

/** Create a deeply immutable copy before an adapter evaluates the snapshot. */
export function freezeArchitectureOrganizationGrantPolicySnapshot(
  snapshot: ArchitectureOrganizationGrantPolicySnapshot,
): ArchitectureOrganizationGrantPolicySnapshot {
  const clone = structuredClone(snapshot);
  return deepFreeze({
    ...clone,
    organizations: [...clone.organizations].sort((left, right) => (
      compareStrings(left.organizationId, right.organizationId)
    )),
    releaseChecks: [...clone.releaseChecks].sort((left, right) => (
      compareStrings(left.organizationId, right.organizationId)
      || compareStrings(left.skill.slug, right.skill.slug)
      || compareStrings(left.skill.version, right.skill.version)
      || compareStrings(left.skill.digest, right.skill.digest)
      || compareStrings(left.skill.packageVisibility, right.skill.packageVisibility)
      || compareStrings(left.skill.id, right.skill.id)
    )),
  });
}

/** Keep user-facing text bounded and independent from provider/registry data. */
export function architectureOrganizationGrantPolicyFailureMessage(
  code: ArchitectureOrganizationGrantPolicyFailureCode,
): string {
  switch (code) {
    case "ARCHITECTURE_REVISION_CONFLICT": return "The architecture current revision changed. Refresh and retry.";
    case "ARCHITECTURE_GRANT_MANAGE_REQUIRED": return "Architecture owner access is required.";
    case "ARCHITECTURE_CURRENT_REVISION_REQUIRED": return "An architecture revision is required before organization sharing.";
    case "ARCHITECTURE_CURRENT_REVISION_UNAVAILABLE": return "The architecture current revision is unavailable.";
    case "ORGANIZATION_SHARING_DISABLED": return "Organization sharing is disabled for this instance.";
    case "ARCHITECTURE_TEAM_PARENT_UNAVAILABLE": return "The architecture team parent organization is unavailable.";
    case "ORGANIZATION_POLICY_REQUIRED": return "Organization policy is unavailable.";
    case "ORGANIZATION_POLICY_INVALID": return "Organization policy is invalid.";
    case "ORGANIZATION_POLICY_CONFLICT": return "The organization policy changed. Refresh and retry.";
    case "ORGANIZATION_ARCHITECTURE_SHARING_DISABLED": return "Organization policy does not allow architecture sharing.";
    case "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN": return "Organization is unavailable for this architecture grant.";
    case "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED": return "The organization architecture grant limit has been reached.";
    case "ARCHITECTURE_RELEASE_NOT_VISIBLE": return "An architecture release is not visible to the target organization.";
  }
}

function isCurrentOrganizationContext(
  context: ArchitectureOrganizationGrantOrganizationSnapshot,
): boolean {
  return context.status === "active"
    && context.currentPolicyRevisionId !== null
    && context.currentPolicy !== null
    && context.currentPolicy.id === context.currentPolicyRevisionId
    && context.currentPolicy.organizationId === context.organizationId
    && context.actorMembershipRole !== null
    && policyDigestMatches(context);
}

function policyDigestMatches(context: ArchitectureOrganizationGrantOrganizationSnapshot): boolean {
  try {
    return organizationPolicyDigest(context.currentPolicy?.policy) === context.currentPolicy?.policySha256;
  } catch {
    return false;
  }
}

function sameSkill(
  left: ArchitectureOrganizationGrantReleaseCheck["skill"],
  right: Pick<ArchitectureSkillRef, "id" | "slug" | "version" | "digest" | "packageVisibility">,
): boolean {
  return left.id === right.id
    && left.slug === right.slug
    && left.version === right.version
    && left.digest === right.digest
    && left.packageVisibility === right.packageVisibility;
}

function allowed(
  organizationIds: readonly string[],
  targetLimit: number,
): ArchitectureOrganizationGrantPolicyAllowed {
  return {
    allowed: true,
    policyVersion: architectureOrganizationGrantPolicyVersion,
    targetLimit,
    organizationIds: [...organizationIds],
  };
}

function denied(
  code: ArchitectureOrganizationGrantPolicyFailureCode,
  statusCode: 403 | 409,
  limit?: number,
): ArchitectureOrganizationGrantPolicyDenied {
  return {
    allowed: false,
    policyVersion: architectureOrganizationGrantPolicyVersion,
    code,
    statusCode,
    ...(limit === undefined ? {} : { limit }),
  };
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
