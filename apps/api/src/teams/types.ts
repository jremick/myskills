export type TeamMemberRole = "owner" | "member";
export type TeamInvitationStatus = "pending" | "accepted" | "revoked";

export interface TeamActor {
  id: string;
  email: string;
}

export interface TeamMemberRecord {
  id: string;
  email: string;
  name: string;
  role: TeamMemberRole;
}

export interface TeamInvitationRecord {
  id: string;
  teamId: string;
  teamName: string;
  email: string;
  status: TeamInvitationStatus;
  createdAt: Date;
}

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  role: TeamMemberRole;
  members: TeamMemberRecord[];
  invitations: TeamInvitationRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamStore {
  createTeam(input: { name: string; slug: string; actorId: string }): Promise<TeamRecord>;
  listTeamsForUser(userId: string): Promise<TeamRecord[]>;
  listPendingInvitationsForEmail(normalizedEmail: string): Promise<TeamInvitationRecord[]>;
  findMembership(input: { teamId: string; userId: string }): Promise<{ role: TeamMemberRole } | null>;
  createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
  }): Promise<TeamInvitationRecord>;
  acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
  }): Promise<TeamInvitationRecord | null>;
  recordAuditEvent(input: {
    actorUserId: string;
    action: string;
    decision: "allow" | "deny";
    resourceId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void>;
}
