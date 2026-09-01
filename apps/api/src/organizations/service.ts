import {
  AppError,
  defaultOrganizationPolicyV1,
  normalizeOrganizationPolicyRevisionInput,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationMembershipRole,
  type OrganizationPolicyRevision,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import type {
  AcceptOrganizationInvitationInput,
  AdoptStandaloneTeamInput,
  ActivateOrganizationPolicyInput,
  AppendOrganizationPolicyInput,
  ArchiveOrganizationInput,
  CreateChildTeamInput,
  CreateOrganizationInput,
  InviteOrganizationMemberInput,
  OrganizationActor,
  OrganizationDetail,
  OrganizationInvitationRecord,
  OrganizationListItem,
  OrganizationMembershipRecord,
  OrganizationPolicyAppendResult,
  OrganizationPolicyActivationResult,
  OrganizationRecord,
  OrganizationStore,
  OrganizationTeamPort,
  RemoveOrganizationMemberInput,
  UpdateOrganizationMemberRoleInput,
} from "./types.js";

const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ORGANIZATION_NAME_LENGTH = 120;

export class OrganizationService {
  constructor(
    private readonly store: OrganizationStore,
    private readonly teamPort?: OrganizationTeamPort,
  ) {}

  /**
   * Create the organization, owner membership, and policy revision through
   * one store operation. The store owns the transaction boundary.
   */
  async createOrganization(input: CreateOrganizationInput): Promise<OrganizationDetail> {
    const actor = normalizeActor(input.actor);
    const name = normalizeOrganizationName(input.name);
    const slug = normalizeOrganizationSlug(input.slug ?? name);
    const policy = normalizePolicy(input.policy ?? defaultOrganizationPolicyV1);
    const reason = normalizePolicyReason(input.reason);

    let created;
    try {
      created = await this.store.createOrganization({
        name,
        slug,
        createdByUserId: actor.id,
        creatorEmail: actor.email,
        creatorName: actor.name ?? "",
        policy,
        policySha256: organizationPolicyDigest(policy),
        reason,
        audit: {
          actorUserId: actor.id,
          action: "organization.create",
          decision: "allow",
        },
      });
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.create",
        decision: "deny",
        details: { reason: appErrorCode(error, "organization_create_failed") },
      });
      throw toOrganizationError(error, "Organization could not be created.", "ORGANIZATION_CREATE_FAILED", 409);
    }

    return {
      ...created.organization,
      role: "owner",
      currentPolicy: created.policyRevision,
    };
  }

  /** Only active organization members can see an organization in this list. */
  async listOrganizations(actorInput: OrganizationActor): Promise<OrganizationListItem[]> {
    const actor = normalizeActor(actorInput);
    const organizations = await this.store.listOrganizations();
    const visible: OrganizationListItem[] = [];
    for (const organization of organizations) {
      if (organization.status !== "active") continue;
      const membership = await this.store.findMembership({ organizationId: organization.id, userId: actor.id });
      if (!membership || membership.removedAt !== null) continue;
      visible.push({ ...organization, role: membership.role });
    }
    return visible.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  /** Returns null for missing, inactive, or cross-organization access. */
  async getOrganization(actorInput: OrganizationActor, organizationId: string): Promise<OrganizationDetail | null> {
    const actor = normalizeActor(actorInput);
    const id = cleanIdentifier(organizationId, "organizationId");
    const context = await this.visibleContext(actor, id);
    if (!context) return null;
    const currentPolicy = await this.store.getPolicyRevision({
      organizationId: id,
      revisionId: context.organization.currentPolicyRevisionId ?? undefined,
    });
    return {
      ...context.organization,
      role: context.membership.role,
      currentPolicy,
    };
  }

  async listMembers(actorInput: OrganizationActor, organizationId: string): Promise<OrganizationMembershipRecord[]> {
    const actor = normalizeActor(actorInput);
    const context = await this.requireVisible(actor, organizationId, "organization.member.list");
    return this.store.listMemberships({ organizationId: context.organization.id });
  }

  /** Member email addresses are administrative data, so require an admin. */
  async listInvitations(actorInput: OrganizationActor, organizationId: string): Promise<OrganizationInvitationRecord[]> {
    const actor = normalizeActor(actorInput);
    const context = await this.requireVisible(actor, organizationId, "organization.invitation.list");
    await this.requireRole(context.membership, "admin", actor, context.organization.id, "organization.invitation.list");
    return this.store.listInvitations({ organizationId: context.organization.id });
  }

  /** Pending invitations for the signed-in recipient, across active orgs only. */
  async listPendingInvitations(actorInput: OrganizationActor): Promise<OrganizationInvitationRecord[]> {
    const actor = normalizeActor(actorInput);
    const invitations = await this.store.listInvitationsForEmail(actor.email);
    const activeOrganizations = new Set(
      (await this.store.listOrganizations())
        .filter((organization) => organization.status === "active")
        .map((organization) => organization.id),
    );
    return invitations.filter((invitation) => activeOrganizations.has(invitation.organizationId));
  }

  async listPolicies(actorInput: OrganizationActor, organizationId: string): Promise<OrganizationPolicyRevision[]> {
    const actor = normalizeActor(actorInput);
    const context = await this.requireVisible(actor, organizationId, "organization.policy.list");
    return this.store.listPolicyRevisions(context.organization.id);
  }

  async inviteMember(input: InviteOrganizationMemberInput): Promise<OrganizationInvitationRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const email = normalizeEmail(input.email);
    const role = normalizeOrganizationRole(input.role ?? "member");
    const context = await this.requireVisible(actor, organizationId, "organization.member.invite");
    await this.requireRole(context.membership, "admin", actor, organizationId, "organization.member.invite");
    if (context.membership.role === "admin" && role === "owner") {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.member.invite",
        decision: "deny",
        resourceId: organizationId,
        details: { invitedRole: role, reason: "organization_owner_required" },
      });
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }

    try {
      const invitation = await this.store.createInvitation({
        organizationId,
        email,
        normalizedEmail: email,
        role,
        invitedByUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.member.invite",
          decision: "allow",
          resourceId: organizationId,
          details: { invitedRole: role, invitedEmail: email },
        },
      });
      return invitation;
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.member.invite",
        decision: "deny",
        resourceId: organizationId,
        details: { invitedRole: role, reason: appErrorCode(error, "organization_invitation_failed") },
      });
      throw toOrganizationError(error, "Organization invitation could not be created.", "ORGANIZATION_INVITATION_FAILED", 409);
    }
  }

  /** The invitation recipient is identified by normalized email, not an ID in the request. */
  async acceptInvitation(input: AcceptOrganizationInvitationInput): Promise<OrganizationInvitationRecord> {
    const actor = normalizeActor(input.actor);
    const invitationId = cleanIdentifier(input.invitationId, "invitationId");
    let invitation: OrganizationInvitationRecord | null;
    try {
      invitation = await this.store.acceptInvitation({
        invitationId,
        userId: actor.id,
        email: actor.email,
        name: actor.name ?? "",
        audit: {
          actorUserId: actor.id,
          action: "organization.invitation.accept",
          decision: "allow",
          details: { invitationId },
        },
      });
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.invitation.accept",
        decision: "deny",
        details: { invitationId, reason: appErrorCode(error, "organization_invitation_accept_failed") },
      });
      throw error;
    }
    if (!invitation) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.invitation.accept",
        decision: "deny",
        details: { invitationId, reason: "invitation_not_found" },
      });
      throw new AppError("Organization invitation not found.", "ORGANIZATION_INVITATION_NOT_FOUND", 404);
    }
    return invitation;
  }

  async updateMemberRole(input: UpdateOrganizationMemberRoleInput): Promise<OrganizationMembershipRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const memberId = cleanIdentifier(input.memberId, "memberId");
    const role = normalizeOrganizationRole(input.role);
    const context = await this.requireVisible(actor, organizationId, "organization.member.role.update");
    await this.requireRole(context.membership, "admin", actor, organizationId, "organization.member.role.update");
    const previous = await this.store.findMembership({ organizationId, userId: memberId });
    if (!previous) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.member.role.update",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, reason: "member_not_found" },
      });
      throw new AppError("Organization member not found.", "ORGANIZATION_MEMBER_NOT_FOUND", 404);
    }
    if (context.membership.role === "admin" && (previous.role === "owner" || role === "owner")) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.member.role.update",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, roleBefore: previous.role, roleAfter: role, reason: "organization_owner_required" },
      });
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    try {
      const member = await this.store.updateMembershipRole({
        organizationId,
        userId: memberId,
        role,
        actorUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.member.role.update",
          decision: "allow",
          resourceId: organizationId,
          details: { memberId, roleBefore: previous.role, roleAfter: role },
        },
      });
      if (!member) throw new AppError("Organization member not found.", "ORGANIZATION_MEMBER_NOT_FOUND", 404);
      return member;
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.member.role.update",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, roleBefore: previous.role, roleAfter: role, reason: appErrorCode(error, "role_update_failed") },
      });
      throw error;
    }
  }

  async removeMember(input: RemoveOrganizationMemberInput): Promise<OrganizationMembershipRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const memberId = cleanIdentifier(input.memberId, "memberId");
    const context = await this.requireVisible(actor, organizationId, "organization.member.remove");
    await this.requireRole(context.membership, "admin", actor, organizationId, "organization.member.remove");
    const previous = await this.store.findMembership({ organizationId, userId: memberId });
    if (!previous) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.member.remove",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, reason: "member_not_found" },
      });
      throw new AppError("Organization member not found.", "ORGANIZATION_MEMBER_NOT_FOUND", 404);
    }
    if (context.membership.role === "admin" && previous.role === "owner") {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.member.remove",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, reason: "organization_owner_required" },
      });
      throw new AppError("Organization owner access is required.", "ORGANIZATION_OWNER_REQUIRED", 403);
    }
    try {
      const member = await this.store.removeMembership({
        organizationId,
        userId: memberId,
        actorUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.member.remove",
          decision: "allow",
          resourceId: organizationId,
          details: { memberId, roleBefore: previous.role },
        },
      });
      if (!member) throw new AppError("Organization member not found.", "ORGANIZATION_MEMBER_NOT_FOUND", 404);
      return member;
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.member.remove",
        decision: "deny",
        resourceId: organizationId,
        details: { memberId, roleBefore: previous.role, reason: appErrorCode(error, "member_remove_failed") },
      });
      throw error;
    }
  }

  /** Append and activate are one persistence operation; duplicate digests are idempotent. */
  async appendPolicyRevision(input: AppendOrganizationPolicyInput): Promise<OrganizationPolicyAppendResult> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const context = await this.requireVisible(actor, organizationId, "organization.policy.append");
    await this.requireRole(context.membership, "owner", actor, organizationId, "organization.policy.append");
    let revisionInput;
    try {
      revisionInput = normalizeOrganizationPolicyRevisionInput({
        organizationId,
        policy: input.policy,
        reason: normalizePolicyReason(input.reason),
      });
    } catch (error) {
      const normalizedError = toOrganizationError(error, "Organization policy is invalid.", "INVALID_ORGANIZATION_POLICY", 400);
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.policy.append",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: appErrorCode(normalizedError, "invalid_organization_policy") },
      });
      throw normalizedError;
    }
    try {
      const result = await this.store.appendPolicyRevision({
        organizationId,
        policy: revisionInput.policy,
        policySha256: revisionInput.policySha256,
        reason: revisionInput.reason,
        createdByUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.policy.append",
          decision: "allow",
          resourceId: organizationId,
          details: { policySha256: revisionInput.policySha256 },
        },
      });
      return result;
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.policy.append",
        decision: "deny",
        resourceId: organizationId,
        details: { policySha256: revisionInput.policySha256, reason: appErrorCode(error, "policy_append_failed") },
      });
      throw toOrganizationError(error, "Organization policy could not be activated.", "ORGANIZATION_POLICY_APPEND_FAILED", 409);
    }
  }

  /**
   * Activate an existing immutable policy revision. The store moves only the
   * organization's current pointer; the selected revision is never rewritten.
   */
  async activatePolicyRevision(input: ActivateOrganizationPolicyInput): Promise<OrganizationPolicyActivationResult> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const revisionId = cleanIdentifier(input.revisionId, "revisionId");
    const context = await this.requireVisible(actor, organizationId, "organization.policy.activate");
    await this.requireRole(context.membership, "owner", actor, organizationId, "organization.policy.activate");

    let result: OrganizationPolicyActivationResult | null;
    try {
      result = await this.store.activatePolicyRevision({
        organizationId,
        revisionId,
        actorUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.policy.activate",
          decision: "allow",
          resourceId: organizationId,
        },
      });
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.policy.activate",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: appErrorCode(error, "policy_activation_failed") },
      });
      throw toOrganizationError(error, "Organization policy could not be activated.", "ORGANIZATION_POLICY_ACTIVATE_FAILED", 409);
    }
    if (!result) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.policy.activate",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: "policy_revision_not_found" },
      });
      throw new AppError("Organization policy revision not found.", "ORGANIZATION_POLICY_REVISION_NOT_FOUND", 404);
    }
    return result;
  }

  async archiveOrganization(input: ArchiveOrganizationInput): Promise<OrganizationRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const context = await this.requireVisible(actor, organizationId, "organization.archive");
    await this.requireRole(context.membership, "owner", actor, organizationId, "organization.archive");
    let archived: OrganizationRecord | null;
    try {
      archived = await this.store.archiveOrganization({
        organizationId,
        actorUserId: actor.id,
        audit: {
          actorUserId: actor.id,
          action: "organization.archive",
          decision: "allow",
          resourceId: organizationId,
          details: { previousStatus: context.organization.status },
        },
      });
    } catch (error) {
      await this.recordAuditSafe({
        actorUserId: actor.id,
        action: "organization.archive",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: appErrorCode(error, "organization_archive_failed") },
      });
      throw error;
    }
    if (!archived) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.archive",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: "organization_not_found" },
      });
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    return archived;
  }

  /** Create a team under an active organization policy boundary. */
  async createChildTeam(input: CreateChildTeamInput): Promise<import("../teams/types.js").TeamRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const context = await this.requireVisible(actor, organizationId, "organization.team.create");
    const policy = await this.requireCurrentPolicy(context, actor, organizationId, "organization.team.create");
    const canCreate = context.membership.role === "owner"
      || context.membership.role === "admin"
      || (context.membership.role === "member" && policy.policy.teams.membersCanCreateTeams);
    if (!canCreate) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.create",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: "organization_team_member_create_disabled" },
      });
      throw new AppError(
        "Organization members cannot create teams under the current policy.",
        "ORGANIZATION_TEAM_CREATE_FORBIDDEN",
        403,
      );
    }
    if (!this.teamPort) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.create",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: "team_boundary_unavailable" },
      });
      throw new AppError(
        "Organization team boundary is not configured.",
        "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
        503,
      );
    }
    try {
      const team = await this.teamPort.createChildTeam({
        actor: { id: actor.id, email: actor.email },
        organizationId,
        name: input.name,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
      });
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.create",
        decision: "allow",
        resourceId: team.id,
        details: { organizationId, teamName: team.name },
      });
      return team;
    } catch (error) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.create",
        decision: "deny",
        resourceId: organizationId,
        details: { reason: appErrorCode(error, "organization_team_create_failed") },
      });
      throw error;
    }
  }

  /** Adopt a standalone team without changing its existing memberships. */
  async adoptStandaloneTeam(input: AdoptStandaloneTeamInput): Promise<import("../teams/types.js").TeamRecord> {
    const actor = normalizeActor(input.actor);
    const organizationId = cleanIdentifier(input.organizationId, "organizationId");
    const teamId = cleanIdentifier(input.teamId, "teamId");
    const context = await this.requireVisible(actor, organizationId, "organization.team.adopt");
    await this.requireRole(context.membership, "admin", actor, organizationId, "organization.team.adopt");
    const policy = await this.requireCurrentPolicy(context, actor, organizationId, "organization.team.adopt");
    if (!policy.policy.teams.allowStandaloneTeamAdoption) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.adopt",
        decision: "deny",
        resourceId: teamId,
        details: { organizationId, reason: "standalone_team_adoption_disabled" },
      });
      throw new AppError(
        "Standalone team adoption is disabled by organization policy.",
        "ORGANIZATION_TEAM_ADOPTION_DISABLED",
        403,
      );
    }
    if (!this.teamPort) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.adopt",
        decision: "deny",
        resourceId: teamId,
        details: { organizationId, reason: "team_boundary_unavailable" },
      });
      throw new AppError(
        "Organization team boundary is not configured.",
        "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
        503,
      );
    }
    try {
      const team = await this.teamPort.adoptStandaloneTeam({
        actor: { id: actor.id, email: actor.email },
        organizationId,
        teamId,
      });
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.adopt",
        decision: "allow",
        resourceId: teamId,
        details: { organizationId },
      });
      return team;
    } catch (error) {
      await this.recordAudit({
        actorUserId: actor.id,
        action: "organization.team.adopt",
        decision: "deny",
        resourceId: teamId,
        details: { organizationId, reason: appErrorCode(error, "organization_team_adoption_failed") },
      });
      throw error;
    }
  }

  private async visibleContext(actor: OrganizationActor, organizationId: string): Promise<{
    organization: OrganizationRecord;
    membership: OrganizationMembershipRecord;
  } | null> {
    const organization = await this.store.getOrganization(organizationId);
    if (!organization || organization.status !== "active") return null;
    const membership = await this.store.findMembership({ organizationId, userId: actor.id });
    if (!membership || membership.removedAt !== null) return null;
    return { organization, membership };
  }

  private async requireVisible(actor: OrganizationActor, organizationIdInput: string, action: string): Promise<{
    organization: OrganizationRecord;
    membership: OrganizationMembershipRecord;
  }> {
    const organizationId = cleanIdentifier(organizationIdInput, "organizationId");
    const context = await this.visibleContext(actor, organizationId);
    if (context) return context;
    await this.recordAudit({
      actorUserId: actor.id,
      action,
      decision: "deny",
      resourceId: organizationId,
      details: { reason: "organization_not_found" },
    });
    // Do not reveal whether the ID exists, is inactive, or belongs to another user.
    throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
  }

  private async requireRole(
    membership: OrganizationMembershipRecord,
    minimum: "admin" | "owner",
    actor: OrganizationActor,
    organizationId: string,
    action: string,
  ): Promise<void> {
    const allowed = minimum === "owner"
      ? membership.role === "owner"
      : membership.role === "owner" || membership.role === "admin";
    if (allowed) return;
    await this.recordAudit({
      actorUserId: actor.id,
      action,
      decision: "deny",
      resourceId: organizationId,
      details: { reason: minimum === "owner" ? "organization_owner_required" : "organization_admin_required" },
    });
    throw new AppError(
      minimum === "owner" ? "Organization owner access is required." : "Organization admin access is required.",
      minimum === "owner" ? "ORGANIZATION_OWNER_REQUIRED" : "ORGANIZATION_ADMIN_REQUIRED",
      403,
    );
  }

  private async requireCurrentPolicy(
    context: { organization: OrganizationRecord; membership: OrganizationMembershipRecord },
    actor: OrganizationActor,
    organizationId: string,
    action: string,
  ): Promise<OrganizationPolicyRevision> {
    const policy = await this.store.getPolicyRevision({
      organizationId,
      revisionId: context.organization.currentPolicyRevisionId ?? undefined,
    });
    if (policy) {
      try {
        const normalized = normalizeOrganizationPolicyV1(policy.policy);
        if (organizationPolicyDigest(normalized) === policy.policySha256) return { ...policy, policy: normalized };
      } catch {
        // Fall through to the same fail-closed error as a missing policy.
      }
      await this.recordAudit({
        actorUserId: actor.id,
        action,
        decision: "deny",
        resourceId: organizationId,
        details: { reason: "organization_policy_invalid" },
      });
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 409);
    }
    await this.recordAudit({
      actorUserId: actor.id,
      action,
      decision: "deny",
      resourceId: organizationId,
      details: { reason: "organization_policy_unavailable" },
    });
    throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
  }

  private async recordAudit(input: Parameters<OrganizationStore["recordAuditEvent"]>[0]): Promise<void> {
    await this.store.recordAuditEvent(input);
  }

  private async recordAuditSafe(input: Parameters<OrganizationStore["recordAuditEvent"]>[0]): Promise<void> {
    try {
      await this.recordAudit(input);
    } catch {
      // Preserve the operation error when a best-effort deny audit also fails.
    }
  }
}

function normalizeActor(input: OrganizationActor): OrganizationActor {
  if (!input || typeof input.id !== "string" || !ORGANIZATION_ID_PATTERN.test(input.id)) {
    throw new AppError("Organization actor is invalid.", "INVALID_ORGANIZATION_ACTOR", 400);
  }
  return {
    id: input.id,
    email: normalizeEmail(input.email),
    ...(input.name !== undefined ? { name: normalizeDisplayName(input.name) } : {}),
  };
}

function normalizeOrganizationName(input: string): string {
  if (typeof input !== "string") throw new AppError("Organization name is required.", "INVALID_ORGANIZATION_NAME", 400);
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > MAX_ORGANIZATION_NAME_LENGTH) {
    throw new AppError("Organization name must be 2 to 120 characters.", "INVALID_ORGANIZATION_NAME", 400);
  }
  return name;
}

function normalizeOrganizationSlug(input: string): string {
  if (typeof input !== "string") throw new AppError("Organization slug is invalid.", "INVALID_ORGANIZATION_SLUG", 400);
  const slug = input.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ORGANIZATION_SLUG_PATTERN.test(slug) || slug.length > 120) {
    throw new AppError("Organization slug is invalid.", "INVALID_ORGANIZATION_SLUG", 400);
  }
  return slug;
}

function normalizeEmail(input: string): string {
  if (typeof input !== "string") throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  const email = input.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || at > 64) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  const domain = email.slice(at + 1);
  if (domain.length < 3 || domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  if ([...email].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) > 0x7e)) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  return email;
}

function normalizeDisplayName(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 200);
}

function normalizePolicy(input: unknown): OrganizationPolicyV1 {
  try {
    return normalizeOrganizationPolicyV1(input);
  } catch (error) {
    throw toOrganizationError(error, "Organization policy is invalid.", "INVALID_ORGANIZATION_POLICY", 400);
  }
}

function normalizePolicyReason(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input !== "string" || input.length > 500) {
    throw new AppError("Organization policy reason must be at most 500 characters.", "INVALID_ORGANIZATION_POLICY_REASON", 400);
  }
  return input.trim();
}

function normalizeOrganizationRole(input: unknown): OrganizationMembershipRole {
  if (input !== "owner" && input !== "admin" && input !== "member") {
    throw new AppError("Organization member role is invalid.", "INVALID_ORGANIZATION_MEMBER_ROLE", 400);
  }
  return input;
}

function cleanIdentifier(input: string, field: string): string {
  if (typeof input !== "string" || !ORGANIZATION_ID_PATTERN.test(input)) {
    throw new AppError(`${field} is invalid.`, "INVALID_ORGANIZATION_IDENTIFIER", 400);
  }
  return input;
}

function toOrganizationError(error: unknown, fallbackMessage: string, fallbackCode: string, fallbackStatus: number): AppError {
  if (error instanceof AppError) return error;
  return new AppError(fallbackMessage, fallbackCode, fallbackStatus, error instanceof Error ? { cause: error.message } : undefined);
}

function appErrorCode(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.code : fallback;
}
