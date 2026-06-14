import { AppError, type SharingSettings } from "@myskills-app/core";
import type {
  TeamActor,
  TeamInvitationRecord,
  TeamRecord,
  TeamStore,
} from "./types.js";

export interface CreateTeamInput {
  actor: TeamActor;
  name: string;
  settings: SharingSettings;
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
      });
      await this.store.recordAuditEvent({
        actorUserId: input.actor.id,
        action: "team.create",
        decision: "allow",
        resourceId: team.id,
        details: { teamName: team.name },
      });
      return team;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError("Team could not be created.", "TEAM_CREATE_FAILED", 409);
    }
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
    const invitation = await this.store.createInvitation({
      teamId: input.teamId,
      email,
      normalizedEmail: email,
      invitedByUserId: input.actor.id,
    });
    await this.store.recordAuditEvent({
      actorUserId: input.actor.id,
      action: "team.invite",
      decision: "allow",
      resourceId: input.teamId,
      details: { invitedEmail: email },
    });
    return invitation;
  }

  async acceptInvitation(input: AcceptTeamInvitationInput): Promise<TeamInvitationRecord> {
    assertTeamsEnabled(input.settings);
    const invitation = await this.store.acceptInvitation({
      invitationId: cleanOpaqueId(input.invitationId, "invitationId"),
      actorId: input.actor.id,
      normalizedEmail: normalizeEmail(input.actor.email),
    });
    if (!invitation) {
      await this.store.recordAuditEvent({
        actorUserId: input.actor.id,
        action: "team.invitation.accept",
        decision: "deny",
        details: { reason: "invitation_not_found" },
      });
      throw new AppError("Team invitation not found.", "TEAM_INVITATION_NOT_FOUND", 404);
    }
    await this.store.recordAuditEvent({
      actorUserId: input.actor.id,
      action: "team.invitation.accept",
      decision: "allow",
      resourceId: invitation.teamId,
      details: { invitationId: invitation.id },
    });
    return invitation;
  }
}

function assertTeamsEnabled(settings: SharingSettings): void {
  if (!settings.teamsEnabled) {
    throw new AppError("Teams are disabled for this instance.", "TEAMS_DISABLED", 403);
  }
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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError("Valid email is required.", "INVALID_EMAIL", 400);
  }
  return email;
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
