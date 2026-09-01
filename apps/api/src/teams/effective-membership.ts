import type { OrganizationStatus } from "@myskills-app/core";

/**
 * The minimum resolved context required before a membership in an
 * organization-owned team can be treated as effective. Standalone teams use
 * a null organization id and retain the pre-tenancy behavior.
 */
export interface EffectiveTeamMembershipContext {
  organizationId: string | null;
  organizationStatus?: OrganizationStatus;
  currentPolicyRevisionId?: string | null;
  hasCurrentPolicy: boolean;
  hasActiveOrganizationMembership: boolean;
  /** Organization policy may explicitly allow external team members. */
  requireOrganizationMembershipForTeamMembers?: boolean;
}

/**
 * Keep organization-owned team access fail-closed. A team membership row is
 * not an organization membership and never substitutes for one.
 */
export function isEffectiveTeamMembership(context: EffectiveTeamMembershipContext): boolean {
  if (context.organizationId === null) return true;
  return context.organizationStatus === "active" &&
    Boolean(context.currentPolicyRevisionId) &&
    context.hasCurrentPolicy &&
    (context.requireOrganizationMembershipForTeamMembers === false || context.hasActiveOrganizationMembership);
}
