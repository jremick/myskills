import { AppError, type SharingSettings } from "@myskills-app/core";
import type {
  TeamActor,
  TeamInvitationRecord,
  TeamMemberRecord,
  TeamMemberRole,
  TeamRecord,
  TeamStore,
} from "./types.js";

export interface CreateTeamInput {
  actor: TeamActor;
  name: string;
  settings: SharingSettings;
}

export interface CreateChildTeamServiceInput {
  actor: TeamActor;
  organizationId: string;
  name: string;
  slug?: string;
}

export interface AdoptStandaloneTeamServiceInput {
  actor: TeamActor;
  organizationId: string;
  teamId: string;
}

export interface InviteTeamMemberInput {
  actor: TeamActor;
  teamId: string;
  email: string;
  settings: SharingSettings;
}

export interface AcceptTeamInvitationInput {
  actor: TeamActor;
  invitationId: string;
  settings: SharingSettings;
}

export interface RevokeTeamInvitationInput {
  actor: TeamActor;
  teamId: string;
  invitationId: string;
  settings: SharingSettings;
}

export interface UpdateTeamMemberRoleInput {
  actor: TeamActor;
  teamId: string;
  memberId: string;
  role: TeamMemberRole;
  settings: SharingSettings;
}

export interface RemoveTeamMemberInput {
  actor: TeamActor;
  teamId: string;
  memberId: string;
  settings: SharingSettings;
}

export interface TeamDashboard {
  teams: TeamRecord[];
  invitations: TeamInvitationRecord[];
}

export class TeamService {
  constructor(private readonly store: TeamStore) {}

  async listDashboard(actor: TeamActor): Promise<TeamDashboard> {
    return {
      teams: await this.store.listTeamsForUser(actor.id),
      invitations: await this.store.listPendingInvitationsForEmail(normalizeEmail(actor.email)),
    };
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    assertTeamsEnabled(input.settings);
    const name = cleanTeamName(input.name);
    try {
      const team = await this.store.createTeam({
        actorId: input.actor.id,
        name,
        slug: teamSlug(name),
        audit: {
          actorUserId: input.actor.id,
          action: "team.create",
          decision: "allow",
          details: { teamName: name },
        },
      });
      return team;
    } catch (error) {
      const normalized = error instanceof AppError
        ? error
        : new AppError("Team could not be created.", "TEAM_CREATE_FAILED", 409);
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.create",
        decision: "deny",
        details: { reason: appErrorCode(normalized, "team_create_failed") },
      });
      throw normalized;
    }
  }

  /** Create an organization-child team through the organization boundary. */
  async createChildTeam(input: CreateChildTeamServiceInput): Promise<TeamRecord> {
    const organizationId = cleanOpaqueId(input.organizationId, "organizationId");
    const name = cleanTeamName(input.name);
    const team = await this.store.createChildTeam({
      actorId: input.actor.id,
      organizationId,
      name,
      slug: teamSlug(input.slug ?? name),
    });
    return team;
  }

  /** Adopt a standalone team after verifying the actor still owns that team. */
  async adoptStandaloneTeam(input: AdoptStandaloneTeamServiceInput): Promise<TeamRecord> {
    const organizationId = cleanOpaqueId(input.organizationId, "organizationId");
    const teamId = cleanOpaqueId(input.teamId, "teamId");
    await requireTeamOwner(this.store, input.actor, teamId, "organization.team.adopt", { organizationId });
    const team = await this.store.adoptStandaloneTeam({
      actorId: input.actor.id,
      organizationId,
      teamId,
    });
    if (!team) {
      throw new AppError("Team not found.", "TEAM_NOT_FOUND", 404);
    }
    return team;
  }

  async inviteMember(input: InviteTeamMemberInput): Promise<TeamInvitationRecord> {
    assertTeamsEnabled(input.settings);
    const membership = await this.store.findMembership({
      teamId: input.teamId,
      userId: input.actor.id,
    });
    if (membership?.role !== "owner") {
      await this.store.recordAuditEvent({
        actorUserId: input.actor.id,
        action: "team.invite",
        decision: "deny",
        resourceId: input.teamId,
        details: { reason: "team_owner_required" },
      });
      throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
    }
    const email = normalizeEmail(input.email);
    try {
      const invitation = await this.store.createInvitation({
        teamId: input.teamId,
        email,
        normalizedEmail: email,
        invitedByUserId: input.actor.id,
        audit: {
          actorUserId: input.actor.id,
          action: "team.invite",
          decision: "allow",
          resourceId: input.teamId,
          details: { invitedEmail: email },
        },
      });
      return invitation;
    } catch (error) {
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.invite",
        decision: "deny",
        resourceId: input.teamId,
        details: { invitedEmail: email, reason: appErrorCode(error, "team_invitation_failed") },
      });
      throw error;
    }
  }

  async revokeInvitation(input: RevokeTeamInvitationInput): Promise<TeamInvitationRecord> {
    assertTeamsEnabled(input.settings);
    const teamId = cleanOpaqueId(input.teamId, "teamId");
    const invitationId = cleanOpaqueId(input.invitationId, "invitationId");
    await requireTeamOwner(this.store, input.actor, teamId, "team.invitation.revoke", { invitationId });

    let invitation: TeamInvitationRecord | null;
    try {
      invitation = await this.store.revokeInvitation({
        teamId,
        invitationId,
        actorUserId: input.actor.id,
        audit: {
          actorUserId: input.actor.id,
          action: "team.invitation.revoke",
          decision: "allow",
          resourceId: teamId,
          details: { invitationId },
        },
      });
    } catch (error) {
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.invitation.revoke",
        decision: "deny",
        resourceId: teamId,
        details: { invitationId, reason: appErrorCode(error, "team_invitation_revoke_failed") },
      });
      throw error;
    }
    if (!invitation) {
      await recordTeamAudit(this.store, {
        actorUserId: input.actor.id,
        action: "team.invitation.revoke",
        decision: "deny",
        resourceId: teamId,
        details: { invitationId, reason: "invitation_not_found" },
      });
      throw new AppError("Team invitation not found.", "TEAM_INVITATION_NOT_FOUND", 404);
    }
    return invitation;
  }

  async updateMemberRole(input: UpdateTeamMemberRoleInput): Promise<TeamMemberRecord> {
    assertTeamsEnabled(input.settings);
    const teamId = cleanOpaqueId(input.teamId, "teamId");
    const memberId = cleanOpaqueId(input.memberId, "memberId");
    await requireTeamOwner(this.store, input.actor, teamId, "team.member.role.update", { memberId });
    let role: TeamMemberRole;
    try {
      role = normalizeTeamMemberRole(input.role);
    } catch (error) {
      await recordTeamAudit(this.store, {
        actorUserId: input.actor.id,
        action: "team.member.role.update",
        decision: "deny",
        resourceId: teamId,
        details: { memberId, reason: appErrorCode(error, "invalid_team_member_role") },
      });
      throw error;
    }
    const previous = await this.store.findMembership({ teamId, userId: memberId });

    let member: TeamMemberRecord | null;
    try {
      member = await this.store.updateMemberRole({
        teamId,
        userId: memberId,
        role,
        actorUserId: input.actor.id,
        audit: {
          actorUserId: input.actor.id,
          action: "team.member.role.update",
          decision: "allow",
          resourceId: teamId,
          details: { memberId, roleBefore: previous?.role, roleAfter: role },
        },
      });
    } catch (error) {
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.member.role.update",
        decision: "deny",
        resourceId: teamId,
        details: {
          memberId,
          roleBefore: previous?.role,
          roleAfter: role,
          reason: isLastOwnerError(error)
            ? "last_owner_required"
            : appErrorCode(error, "team_member_role_update_failed"),
        },
      });
      throw error;
    }
    if (!member) {
      await recordTeamAudit(this.store, {
        actorUserId: input.actor.id,
        action: "team.member.role.update",
        decision: "deny",
        resourceId: teamId,
        details: { memberId, roleAfter: role, reason: "member_not_found" },
      });
      throw new AppError("Team member not found.", "TEAM_MEMBER_NOT_FOUND", 404);
    }
    return member;
  }

  async removeMember(input: RemoveTeamMemberInput): Promise<TeamMemberRecord> {
    assertTeamsEnabled(input.settings);
    const teamId = cleanOpaqueId(input.teamId, "teamId");
    const memberId = cleanOpaqueId(input.memberId, "memberId");
    await requireTeamOwner(this.store, input.actor, teamId, "team.member.remove", { memberId });
    const previous = await this.store.findMembership({ teamId, userId: memberId });

    let member: TeamMemberRecord | null;
    try {
      member = await this.store.removeMember({
        teamId,
        userId: memberId,
        actorUserId: input.actor.id,
        audit: {
          actorUserId: input.actor.id,
          action: "team.member.remove",
          decision: "allow",
          resourceId: teamId,
          details: { memberId, roleBefore: previous?.role },
        },
      });
    } catch (error) {
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.member.remove",
        decision: "deny",
        resourceId: teamId,
        details: {
          memberId,
          roleBefore: previous?.role,
          reason: isLastOwnerError(error)
            ? "last_owner_required"
            : appErrorCode(error, "team_member_remove_failed"),
        },
      });
      throw error;
    }
    if (!member) {
      await recordTeamAudit(this.store, {
        actorUserId: input.actor.id,
        action: "team.member.remove",
        decision: "deny",
        resourceId: teamId,
        details: { memberId, reason: "member_not_found" },
      });
      throw new AppError("Team member not found.", "TEAM_MEMBER_NOT_FOUND", 404);
    }
    return member;
  }

  async acceptInvitation(input: AcceptTeamInvitationInput): Promise<TeamInvitationRecord> {
    assertTeamsEnabled(input.settings);
    const invitationId = cleanOpaqueId(input.invitationId, "invitationId");
    let invitation: TeamInvitationRecord | null;
    try {
      invitation = await this.store.acceptInvitation({
        invitationId,
        actorId: input.actor.id,
        normalizedEmail: normalizeEmail(input.actor.email),
        audit: {
          actorUserId: input.actor.id,
          action: "team.invitation.accept",
          decision: "allow",
          details: { invitationId },
        },
      });
    } catch (error) {
      await recordTeamAuditSafe(this.store, {
        actorUserId: input.actor.id,
        action: "team.invitation.accept",
        decision: "deny",
        details: { invitationId, reason: appErrorCode(error, "team_invitation_accept_failed") },
      });
      throw error;
    }
    if (!invitation) {
      await this.store.recordAuditEvent({
        actorUserId: input.actor.id,
        action: "team.invitation.accept",
        decision: "deny",
        details: { invitationId, reason: "invitation_not_found" },
      });
      throw new AppError("Team invitation not found.", "TEAM_INVITATION_NOT_FOUND", 404);
    }
    return invitation;
  }
}

function assertTeamsEnabled(settings: SharingSettings): void {
  if (!settings.teamsEnabled) {
    throw new AppError("Teams are disabled for this instance.", "TEAMS_DISABLED", 403);
  }
}

async function requireTeamOwner(
  store: TeamStore,
  actor: TeamActor,
  teamId: string,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const membership = await store.findMembership({ teamId, userId: actor.id });
  if (membership?.role !== "owner") {
    await recordTeamAudit(store, {
      actorUserId: actor.id,
      action,
      decision: "deny",
      resourceId: teamId,
      details: { ...details, reason: "team_owner_required" },
    });
    throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
  }
}

async function recordTeamAudit(
  store: TeamStore,
  input: {
    actorUserId: string;
    action: string;
    decision: "allow" | "deny";
    resourceId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await store.recordAuditEvent(input);
}

async function recordTeamAuditSafe(
  store: TeamStore,
  input: Parameters<TeamStore["recordAuditEvent"]>[0],
): Promise<void> {
  try {
    await recordTeamAudit(store, input);
  } catch {
    // Preserve the operation error when a best-effort deny audit also fails.
  }
}

function isLastOwnerError(error: unknown): boolean {
  return error instanceof AppError && error.code === "LAST_OWNER_REQUIRED";
}

function appErrorCode(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.code : fallback;
}

function normalizeTeamMemberRole(input: unknown): TeamMemberRole {
  if (input !== "owner" && input !== "member") {
    throw new AppError("Team member role must be owner or member.", "INVALID_TEAM_MEMBER_ROLE", 400);
  }
  return input;
}

function cleanTeamName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw new AppError("Team name must be 2 to 80 characters.", "INVALID_TEAM_NAME", 400);
  }
  return name;
}

function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!isValidEmailAddress(email)) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  return email;
}

function isValidEmailAddress(value: string): boolean {
  if (value.length < 3 || value.length > 254) {
    return false;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at > 64) {
    return false;
  }
  const domain = value.slice(at + 1);
  if (domain.length < 3 || domain.startsWith(".") || domain.endsWith(".") || !domain.includes(".")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function teamSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
  return slug || "team";
}

function cleanOpaqueId(input: string, field: string): string {
  const value = input.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new AppError(`${field} is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  return value;
}
