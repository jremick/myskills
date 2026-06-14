import { AppError } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type {
  TeamInvitationRecord,
  TeamMemberRecord,
  TeamRecord,
  TeamStore,
} from "./types.js";

interface MemoryTeam {
  id: string;
  name: string;
  slug: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryMembership {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  name: string;
  role: "owner" | "member";
}

interface MemoryInvitation {
  id: string;
  teamId: string;
  email: string;
  normalizedEmail: string;
  invitedByUserId: string;
  status: "pending" | "accepted" | "revoked";
  acceptedByUserId: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryAuditEvent {
  actorUserId: string;
  action: string;
  decision: "allow" | "deny";
  resourceId: string | null;
  details: Record<string, unknown>;
}

export class MemoryTeamStore implements TeamStore {
  private teams = new Map<string, MemoryTeam>();
  private memberships = new Map<string, MemoryMembership>();
  private invitations = new Map<string, MemoryInvitation>();
  private audit: MemoryAuditEvent[] = [];
  private users = new Map<string, { id: string; email: string; name: string }>();

  addKnownUser(input: { id: string; email: string; name?: string }): void {
    this.users.set(input.id, {
      id: input.id,
      email: input.email.toLowerCase(),
      name: input.name ?? "",
    });
  }

  auditEvents(): MemoryAuditEvent[] {
    return this.audit;
  }

  async createTeam(input: { name: string; slug: string; actorId: string }): Promise<TeamRecord> {
    if ([...this.teams.values()].some((team) => team.slug === input.slug)) {
      throw new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
    }
    const now = new Date();
    const team: MemoryTeam = {
      id: `team-${this.teams.size + 1}`,
      name: input.name,
      slug: input.slug,
      createdByUserId: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.teams.set(team.id, team);
    const user = this.users.get(input.actorId) ?? { id: input.actorId, email: "", name: "" };
    this.memberships.set(`${team.id}:${input.actorId}`, {
      id: `team-membership-${this.memberships.size + 1}`,
      teamId: team.id,
      userId: input.actorId,
      email: user.email,
      name: user.name,
      role: "owner",
    });
    return this.teamRecord(team, "owner");
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    return [...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map((membership) => {
        const team = this.teams.get(membership.teamId);
        return team ? this.teamRecord(team, membership.role) : null;
      })
      .filter((team): team is TeamRecord => Boolean(team))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listPendingInvitationsForEmail(normalizedEmail: string): Promise<TeamInvitationRecord[]> {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.normalizedEmail === normalizedEmail && invitation.status === "pending")
      .map((invitation) => this.invitationRecord(invitation))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findMembership(input: { teamId: string; userId: string }): Promise<{ role: "owner" | "member" } | null> {
    const membership = this.memberships.get(`${input.teamId}:${input.userId}`);
    return membership ? { role: membership.role } : null;
  }

  async createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
  }): Promise<TeamInvitationRecord> {
    if (!this.teams.has(input.teamId)) {
      throw new AppError("Team not found.", "TEAM_NOT_FOUND", 404);
    }
    if ([...this.memberships.values()].some((membership) => (
      membership.teamId === input.teamId &&
      membership.email === input.normalizedEmail
    ))) {
      throw new AppError("User is already a team member.", "TEAM_MEMBER_EXISTS", 409);
    }
    const now = new Date();
    const existing = [...this.invitations.values()].find((invitation) => (
      invitation.teamId === input.teamId &&
      invitation.normalizedEmail === input.normalizedEmail
    ));
    const invitation: MemoryInvitation = {
      id: existing?.id ?? `team-invitation-${this.invitations.size + 1}`,
      teamId: input.teamId,
      email: input.email,
      normalizedEmail: input.normalizedEmail,
      invitedByUserId: input.invitedByUserId,
      status: "pending",
      acceptedByUserId: null,
      acceptedAt: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.invitations.set(invitation.id, invitation);
    return this.invitationRecord(invitation);
  }

  async acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
  }): Promise<TeamInvitationRecord | null> {
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation || invitation.status !== "pending" || invitation.normalizedEmail !== input.normalizedEmail) {
      return null;
    }
    const user = this.users.get(input.actorId) ?? { id: input.actorId, email: input.normalizedEmail, name: "" };
    this.memberships.set(`${invitation.teamId}:${input.actorId}`, {
      id: `team-membership-${this.memberships.size + 1}`,
      teamId: invitation.teamId,
      userId: input.actorId,
      email: user.email,
      name: user.name,
      role: "member",
    });
    invitation.status = "accepted";
    invitation.acceptedByUserId = input.actorId;
    invitation.acceptedAt = new Date();
    invitation.updatedAt = invitation.acceptedAt;
    return this.invitationRecord(invitation);
  }

  async recordAuditEvent(input: {
    actorUserId: string;
    action: string;
    decision: "allow" | "deny";
    resourceId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    this.audit.push({
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
    });
  }

  private teamRecord(team: MemoryTeam, role: "owner" | "member"): TeamRecord {
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      role,
      members: [...this.memberships.values()]
        .filter((membership) => membership.teamId === team.id)
        .map((membership): TeamMemberRecord => ({
          id: membership.userId,
          email: membership.email,
          name: membership.name,
          role: membership.role,
        })),
      invitations: [...this.invitations.values()]
        .filter((invitation) => invitation.teamId === team.id && invitation.status === "pending")
        .map((invitation) => this.invitationRecord(invitation)),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    };
  }

  private invitationRecord(invitation: MemoryInvitation): TeamInvitationRecord {
    return {
      id: invitation.id,
      teamId: invitation.teamId,
      teamName: this.teams.get(invitation.teamId)?.name ?? "",
      email: invitation.email,
      status: invitation.status,
      createdAt: invitation.createdAt,
    };
  }
}
