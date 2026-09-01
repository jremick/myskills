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
  /** Null preserves the pre-organization standalone-team model. */
  organizationId: string | null;
  role: TeamMemberRole;
  members: TeamMemberRecord[];
  invitations: TeamInvitationRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RevokeTeamInvitationInput {
  teamId: string;
  invitationId: string;
  /** Server-authenticated actor rechecked at the mutation boundary. */
  actorUserId: string;
}

export interface UpdateTeamMemberRoleInput {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  /** Server-authenticated actor rechecked at the mutation boundary. */
  actorUserId: string;
}

export interface RemoveTeamMemberInput {
  teamId: string;
  userId: string;
  /** Server-authenticated actor rechecked at the mutation boundary. */
  actorUserId: string;
}

export interface TeamAuditInput {
  actorUserId: string;
  action: string;
  decision: "allow" | "deny";
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface CreateChildTeamStoreInput {
  organizationId: string;
  name: string;
  slug: string;
  actorId: string;
}

export interface AdoptStandaloneTeamStoreInput {
  organizationId: string;
  teamId: string;
  actorId: string;
}

export interface TeamStore {
  createTeam(input: { name: string; slug: string; actorId: string; audit?: TeamAuditInput }): Promise<TeamRecord>;
  /** Create a team already parented to an active organization. */
  createChildTeam(input: CreateChildTeamStoreInput): Promise<TeamRecord>;
  /** Adopt a standalone team. Implementations must only allow NULL -> org. */
  adoptStandaloneTeam(input: AdoptStandaloneTeamStoreInput): Promise<TeamRecord | null>;
  listTeamsForUser(userId: string): Promise<TeamRecord[]>;
  listPendingInvitationsForEmail(normalizedEmail: string): Promise<TeamInvitationRecord[]>;
  findMembership(input: { teamId: string; userId: string }): Promise<{ role: TeamMemberRole } | null>;
  createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
    /** Persisted with the invitation transaction when supplied. */
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord>;
  revokeInvitation(input: RevokeTeamInvitationInput & { audit?: TeamAuditInput }): Promise<TeamInvitationRecord | null>;
  updateMemberRole(input: UpdateTeamMemberRoleInput & { audit?: TeamAuditInput }): Promise<TeamMemberRecord | null>;
  removeMember(input: RemoveTeamMemberInput & { audit?: TeamAuditInput }): Promise<TeamMemberRecord | null>;
  acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
    /** Persisted with the acceptance transaction when supplied. */
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord | null>;
  recordAuditEvent(input: TeamAuditInput): Promise<void>;
}
