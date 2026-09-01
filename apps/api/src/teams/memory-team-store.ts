import {
  AppError,
  defaultOrganizationPolicyV1,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { OrganizationStore } from "../organizations/types.js";
import { isEffectiveTeamMembership } from "./effective-membership.js";
import type {
  AdoptStandaloneTeamStoreInput,
  CreateChildTeamStoreInput,
  TeamInvitationRecord,
  TeamMemberRecord,
  TeamMemberRole,
  TeamRecord,
  TeamAuditInput,
  TeamStore,
} from "./types.js";

interface MemoryTeam {
  id: string;
  name: string;
  slug: string;
  organizationId: string | null;
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
  role: TeamMemberRole;
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

export interface MemoryTeamStoreOptions {
  /** Organization membership and policy source used by organization-bound operations. */
  organizationStore?: OrganizationStore;
  /** Test-only failure injection before a mutation and its allow audit commit. */
  beforeCommit?: (input: TeamAuditInput) => void | Promise<void>;
}

export class MemoryTeamStore implements TeamStore {
  private teams = new Map<string, MemoryTeam>();
  private memberships = new Map<string, MemoryMembership>();
  private invitations = new Map<string, MemoryInvitation>();
  private audit: MemoryAuditEvent[] = [];
  private users = new Map<string, { id: string; email: string; name: string }>();
  private readonly teamMutationTails = new Map<string, Promise<void>>();
  private readonly organizationMutationTails = new Map<string, Promise<void>>();
  private readonly organizationStore?: OrganizationStore;
  private readonly beforeCommit?: (input: TeamAuditInput) => void | Promise<void>;

  constructor(options: MemoryTeamStoreOptions = {}) {
    this.organizationStore = options.organizationStore;
    this.beforeCommit = options.beforeCommit;
  }

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

  async createTeam(input: { name: string; slug: string; actorId: string; audit?: TeamAuditInput }): Promise<TeamRecord> {
    return this.withTeamMutation("__team_create__", async () => {
      if ([...this.teams.values()].some((team) => team.slug === input.slug)) {
        throw new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
      }
      const now = new Date();
      const team: MemoryTeam = {
        id: `team-${this.teams.size + 1}`,
        name: input.name,
        slug: input.slug,
        organizationId: null,
        createdByUserId: input.actorId,
        createdAt: now,
        updatedAt: now,
      };
      const user = this.users.get(input.actorId) ?? { id: input.actorId, email: "", name: "" };
      const membership: MemoryMembership = {
        id: `team-membership-${this.memberships.size + 1}`,
        teamId: team.id,
        userId: input.actorId,
        email: user.email,
        name: user.name,
        role: "owner",
      };
      const audit = await this.prepareAllowAudit(input.audit, team.id, { teamName: team.name });
      this.teams.set(team.id, team);
      this.memberships.set(`${team.id}:${input.actorId}`, membership);
      this.commitPreparedAudit(audit);
      return this.teamRecord(team, "owner");
    });
  }

  async createChildTeam(input: CreateChildTeamStoreInput): Promise<TeamRecord> {
    return this.withOrganizationMutation(input.organizationId, async () => {
      const organization = await this.requireOrganizationContext(input.organizationId);
      const actorMembership = await this.organizationStore?.findMembership({
        organizationId: input.organizationId,
        userId: input.actorId,
      });
      if (!actorMembership || actorMembership.removedAt !== null) {
        throw new AppError(
          "Active organization membership is required.",
          "ORGANIZATION_MEMBERSHIP_REQUIRED",
          403,
        );
      }
      const policy = await this.currentOrganizationPolicy(organization.id, organization.currentPolicyRevisionId);
      if (actorMembership.role === "member" && !policy.teams.membersCanCreateTeams) {
        throw new AppError(
          "Organization members cannot create teams under the current policy.",
          "ORGANIZATION_TEAM_CREATE_FORBIDDEN",
          403,
        );
      }
      if (actorMembership.role !== "owner" && actorMembership.role !== "admin" && actorMembership.role !== "member") {
        throw new AppError("Organization membership is invalid.", "ORGANIZATION_MEMBERSHIP_INVALID", 403);
      }
      const organizationTeamCount = [...this.teams.values()].filter((team) => team.organizationId === organization.id).length;
      if (organizationTeamCount >= policy.limits.teamsPerOrganization) {
        throw new AppError("Organization team limit has been reached.", "ORGANIZATION_TEAM_LIMIT_REACHED", 409);
      }
      return this.insertTeam({
        name: input.name,
        slug: input.slug,
        actorId: input.actorId,
        organizationId: organization.id,
      });
    });
  }

  async adoptStandaloneTeam(input: AdoptStandaloneTeamStoreInput): Promise<TeamRecord | null> {
    // Adoption changes a team-wide parent pointer. Serialize by team as well
    // as by organization so two admins cannot parent the same standalone team
    // to different organizations concurrently in the memory adapter.
    return this.withTeamMutation(input.teamId, () => this.withOrganizationMutation(input.organizationId, async () => {
      const organization = await this.requireOrganizationContext(input.organizationId);
      const team = this.teams.get(input.teamId);
      if (!team) return null;
      if (team.organizationId !== null) {
        throw new AppError("Team already belongs to an organization.", "TEAM_ALREADY_PARENTED", 409);
      }

      const teamMembership = this.memberships.get(`${team.id}:${input.actorId}`);
      if (teamMembership?.role !== "owner") {
        throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
      }
      const actorOrganizationMembership = await this.organizationStore?.findMembership({
        organizationId: organization.id,
        userId: input.actorId,
      });
      if (!actorOrganizationMembership || actorOrganizationMembership.removedAt !== null) {
        throw new AppError("Active organization membership is required.", "ORGANIZATION_MEMBERSHIP_REQUIRED", 403);
      }
      if (actorOrganizationMembership.role !== "owner" && actorOrganizationMembership.role !== "admin") {
        throw new AppError("Organization admin access is required.", "ORGANIZATION_ADMIN_REQUIRED", 403);
      }

      const policy = await this.currentOrganizationPolicy(organization.id, organization.currentPolicyRevisionId);
      if (!policy.teams.allowStandaloneTeamAdoption) {
        throw new AppError(
          "Standalone team adoption is disabled by organization policy.",
          "ORGANIZATION_TEAM_ADOPTION_DISABLED",
          403,
        );
      }
      if (policy.teams.requireOrganizationMembershipForTeamMembers) {
        const members = [...this.memberships.values()].filter((membership) => membership.teamId === team.id);
        const missing = [];
        for (const member of members) {
          const membership = await this.organizationStore?.findMembership({
            organizationId: organization.id,
            userId: member.userId,
          });
          if (!membership || membership.removedAt !== null) missing.push(member.userId);
        }
        if (missing.length > 0) {
          throw new AppError(
            "All current team members must belong to the organization.",
            "ORGANIZATION_TEAM_MEMBERSHIP_REQUIRED",
            409,
            { missingUserIds: missing },
          );
        }
      }

      const organizationTeamCount = [...this.teams.values()].filter((candidate) => candidate.organizationId === organization.id).length;
      if (organizationTeamCount >= policy.limits.teamsPerOrganization) {
        throw new AppError("Organization team limit has been reached.", "ORGANIZATION_TEAM_LIMIT_REACHED", 409);
      }
      team.organizationId = organization.id;
      team.updatedAt = new Date();
      return this.teamRecord(team, "owner");
    }));
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const records = await Promise.all([...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map(async (membership) => {
        const team = this.teams.get(membership.teamId);
        if (!team || !(await this.hasEffectiveMembership(team, userId))) return null;
        return this.teamRecord(team, membership.role);
      }));
    return records
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
    const team = this.teams.get(input.teamId);
    if (!membership || !team || !(await this.hasEffectiveMembership(team, input.userId))) return null;
    return { role: membership.role };
  }

  async createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord> {
    return this.withTeamMutation(input.teamId, async () => {
      const team = this.teams.get(input.teamId);
      if (!team) {
        throw new AppError("Team not found.", "TEAM_NOT_FOUND", 404);
      }
      // The service performs an early authorization check for a fast user-facing
      // response. Repeat it here so a demotion, organization archive, or policy
      // change between that check and this write cannot authorize an invitation.
      await this.assertTeamOwnerAuthority(team, input.invitedByUserId);
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
      const audit = await this.prepareAllowAudit(input.audit, input.teamId, { invitedEmail: input.email });
      this.invitations.set(invitation.id, invitation);
      this.commitPreparedAudit(audit);
      return this.invitationRecord(invitation);
    });
  }

  async revokeInvitation(input: { teamId: string; invitationId: string; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamInvitationRecord | null> {
    return this.withTeamMutation(input.teamId, async () => {
      const team = this.teams.get(input.teamId);
      if (!team) {
        return null;
      }
      await this.assertTeamOwnerAuthority(team, input.actorUserId);
      const invitation = this.invitations.get(input.invitationId);
      if (!invitation || invitation.teamId !== input.teamId || invitation.status !== "pending") return null;
      const now = new Date();
      const revoked = { ...invitation, status: "revoked" as const, updatedAt: now };
      const updatedTeam = { ...team, updatedAt: now };
      const audit = await this.prepareAllowAudit(input.audit, input.teamId, { invitationId: invitation.id });
      this.invitations.set(invitation.id, revoked);
      this.teams.set(team.id, updatedTeam);
      this.commitPreparedAudit(audit);
      return this.invitationRecord(revoked);
    });
  }

  async updateMemberRole(input: { teamId: string; userId: string; role: TeamMemberRole; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamMemberRecord | null> {
    return this.withTeamMutation(input.teamId, async () => {
      const team = this.teams.get(input.teamId);
      if (!team) {
        return null;
      }
      await this.assertTeamOwnerAuthority(team, input.actorUserId);
      const membership = this.memberships.get(`${input.teamId}:${input.userId}`);
      if (!membership) return null;
      if (membership.role === "owner" && input.role === "member" && this.ownerCount(input.teamId) <= 1) {
        throw new AppError("At least one team owner is required.", "LAST_OWNER_REQUIRED", 409);
      }
      const updated = { ...membership, role: input.role };
      const updatedTeam = { ...team, updatedAt: new Date() };
      const audit = await this.prepareAllowAudit(input.audit, input.teamId, {
        memberId: input.userId,
        roleBefore: membership.role,
        roleAfter: updated.role,
      });
      this.memberships.set(`${input.teamId}:${input.userId}`, updated);
      this.teams.set(team.id, updatedTeam);
      this.commitPreparedAudit(audit);
      return this.memberRecord(updated);
    });
  }

  async removeMember(input: { teamId: string; userId: string; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamMemberRecord | null> {
    return this.withTeamMutation(input.teamId, async () => {
      const team = this.teams.get(input.teamId);
      if (!team) {
        return null;
      }
      await this.assertTeamOwnerAuthority(team, input.actorUserId);
      const membership = this.memberships.get(`${input.teamId}:${input.userId}`);
      if (!membership) return null;
      if (membership.role === "owner" && this.ownerCount(input.teamId) <= 1) {
        throw new AppError("At least one team owner is required.", "LAST_OWNER_REQUIRED", 409);
      }
      const updatedTeam = { ...team, updatedAt: new Date() };
      const member = this.memberRecord(membership);
      const audit = await this.prepareAllowAudit(input.audit, input.teamId, {
        memberId: input.userId,
        roleBefore: membership.role,
      });
      this.memberships.delete(`${input.teamId}:${input.userId}`);
      this.teams.set(team.id, updatedTeam);
      this.commitPreparedAudit(audit);
      return member;
    });
  }

  async acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord | null> {
    const initialInvitation = this.invitations.get(input.invitationId);
    if (!initialInvitation) return null;
    return this.withTeamMutation(initialInvitation.teamId, async () => {
      const invitation = this.invitations.get(input.invitationId);
      if (!invitation || invitation.status !== "pending" || invitation.normalizedEmail !== input.normalizedEmail) {
        return null;
      }
      const team = this.teams.get(invitation.teamId);
      if (!team) return null;
      const organizationIdAtRead = team.organizationId;
      if (team.organizationId !== null) {
        if (!(await this.hasEffectiveMembership(team, input.actorId))) {
          throw new AppError(
            "Active organization membership is required to join this team.",
            "ORGANIZATION_MEMBERSHIP_REQUIRED",
            403,
          );
        }
        // Adoption and parent lifecycle updates can happen while the effective
        // membership check yields. Re-read the parent before inserting the team
        // membership so a changed ownership boundary is never accepted on the
        // basis of the earlier snapshot.
        if (team.organizationId !== organizationIdAtRead
          && !(await this.hasEffectiveMembership(team, input.actorId))) {
          throw new AppError(
            "Active organization membership is required to join this team.",
            "ORGANIZATION_MEMBERSHIP_REQUIRED",
            403,
          );
        }
      }
      const user = this.users.get(input.actorId);
      if (user && user.email !== input.normalizedEmail) return null;
      if (!user && [...this.users.values()].some((candidate) => candidate.email === input.normalizedEmail)) return null;
      const acceptingUser = user ?? { id: input.actorId, email: input.normalizedEmail, name: "" };
      const membership: MemoryMembership = {
        id: `team-membership-${this.memberships.size + 1}`,
        teamId: invitation.teamId,
        userId: input.actorId,
        email: acceptingUser.email,
        name: acceptingUser.name,
        role: "member",
      };
      const acceptedAt = new Date();
      const accepted = {
        ...invitation,
        status: "accepted" as const,
        acceptedByUserId: input.actorId,
        acceptedAt,
        updatedAt: acceptedAt,
      };
      const updatedTeam = { ...team, updatedAt: acceptedAt };
      const audit = await this.prepareAllowAudit(input.audit, team.id, { invitationId: invitation.id });
      this.memberships.set(`${invitation.teamId}:${input.actorId}`, membership);
      this.invitations.set(invitation.id, accepted);
      this.teams.set(team.id, updatedTeam);
      this.commitPreparedAudit(audit);
      return this.invitationRecord(accepted);
    });
  }

  async recordAuditEvent(input: {
    actorUserId: string;
    action: string;
    decision: "allow" | "deny";
    resourceId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    this.commitPreparedAudit(this.createAuditEvent(input));
  }

  private async prepareAllowAudit(
    input: TeamAuditInput | undefined,
    resourceId: string,
    details: Record<string, unknown> = {},
  ): Promise<MemoryAuditEvent | null> {
    if (!input) return null;
    const prepared = {
      ...input,
      resourceId,
      details: { ...input.details, ...details },
    };
    await this.beforeCommit?.(prepared);
    return this.createAuditEvent(prepared);
  }

  private commitPreparedAudit(event: MemoryAuditEvent | null): void {
    if (!event) return;
    this.audit.push(event);
  }

  private createAuditEvent(input: TeamAuditInput): MemoryAuditEvent {
    return {
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
    };
  }

  private ownerCount(teamId: string): number {
    return [...this.memberships.values()]
      .filter((membership) => membership.teamId === teamId && membership.role === "owner")
      .length;
  }

  /**
   * Recheck the server-authenticated actor immediately before a sensitive
   * team mutation. Organization-owned teams also require a live parent
   * organization, current policy, and active same-organization membership.
  */
  private async assertTeamOwnerAuthority(team: MemoryTeam, actorUserId: string): Promise<void> {
    const membership = this.memberships.get(`${team.id}:${actorUserId}`);
    if (membership?.role !== "owner") {
      throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
    }
    const effective = await this.hasEffectiveMembership(team, actorUserId);
    const currentMembership = this.memberships.get(`${team.id}:${actorUserId}`);
    if (!effective || currentMembership?.role !== "owner") {
      throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
    }
  }

  private memberRecord(membership: MemoryMembership): TeamMemberRecord {
    return {
      id: membership.userId,
      email: membership.email,
      name: membership.name,
      role: membership.role,
    };
  }

  private async teamRecord(team: MemoryTeam, role: "owner" | "member"): Promise<TeamRecord> {
    const members = await Promise.all([...this.memberships.values()]
      .filter((membership) => membership.teamId === team.id)
      .map(async (membership) => (
        (await this.hasEffectiveMembership(team, membership.userId))
          ? {
            id: membership.userId,
            email: membership.email,
            name: membership.name,
            role: membership.role,
          } satisfies TeamMemberRecord
          : null
      )));
    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      organizationId: team.organizationId,
      role,
      members: members.filter((member): member is TeamMemberRecord => Boolean(member)),
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

  private async requireOrganizationContext(organizationId: string) {
    if (!this.organizationStore) {
      throw new AppError(
        "Organization team boundary is not configured.",
        "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
        503,
      );
    }
    const organization = await this.organizationStore.getOrganization(organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    if (organization.status !== "active") throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
    return organization;
  }

  private async hasEffectiveMembership(team: MemoryTeam, userId: string): Promise<boolean> {
    if (team.organizationId === null) return true;
    if (!this.organizationStore) return false;
    const organization = await this.organizationStore.getOrganization(team.organizationId);
    if (!organization) return false;
    let hasCurrentPolicy = false;
    let requireOrganizationMembershipForTeamMembers = true;
    if (organization.currentPolicyRevisionId) {
      const revision = await this.organizationStore.getPolicyRevision({
        organizationId: organization.id,
        revisionId: organization.currentPolicyRevisionId,
      });
      if (revision?.id === organization.currentPolicyRevisionId) {
        try {
          const policy = normalizeOrganizationPolicyV1(revision.policy);
          hasCurrentPolicy = organizationPolicyDigest(policy) === revision.policySha256;
          requireOrganizationMembershipForTeamMembers = policy.teams.requireOrganizationMembershipForTeamMembers;
        } catch {
          hasCurrentPolicy = false;
        }
      }
    }
    const currentOrganization = await this.organizationStore.getOrganization(team.organizationId);
    if (!currentOrganization
      || currentOrganization.status !== organization.status
      || currentOrganization.currentPolicyRevisionId !== organization.currentPolicyRevisionId) {
      return false;
    }
    const currentMembership = await this.organizationStore.findMembership({
      organizationId: currentOrganization.id,
      userId,
    });
    return isEffectiveTeamMembership({
      organizationId: team.organizationId,
      organizationStatus: currentOrganization.status,
      currentPolicyRevisionId: currentOrganization.currentPolicyRevisionId,
      hasCurrentPolicy,
      hasActiveOrganizationMembership: Boolean(currentMembership && currentMembership.removedAt === null),
      requireOrganizationMembershipForTeamMembers,
    });
  }

  private async currentOrganizationPolicy(organizationId: string, revisionId: string | null): Promise<OrganizationPolicyV1> {
    if (!this.organizationStore) {
      throw new AppError(
        "Organization team boundary is not configured.",
        "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
        503,
      );
    }
    const revision = await this.organizationStore.getPolicyRevision({ organizationId, revisionId: revisionId ?? undefined });
    if (!revision) throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
    let policy: OrganizationPolicyV1;
    try {
      policy = normalizeOrganizationPolicyV1(revision.policy ?? defaultOrganizationPolicyV1);
    } catch {
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500);
    }
    if (organizationPolicyDigest(policy) !== revision.policySha256) {
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500);
    }
    return policy;
  }

  /** Serialize organization team mutations so quota checks and writes are atomic in memory. */
  private async withOrganizationMutation<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.organizationMutationTails.get(organizationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.organizationMutationTails.set(organizationId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.organizationMutationTails.get(organizationId) === current) {
        this.organizationMutationTails.delete(organizationId);
      }
    }
  }

  /** Serialize mutations that change or depend on one team's parent/members. */
  private async withTeamMutation<T>(teamId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.teamMutationTails.get(teamId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.teamMutationTails.set(teamId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.teamMutationTails.get(teamId) === current) {
        this.teamMutationTails.delete(teamId);
      }
    }
  }

  private async insertTeam(input: { name: string; slug: string; actorId: string; organizationId: string | null }): Promise<TeamRecord> {
    if ([...this.teams.values()].some((team) => team.slug === input.slug)) {
      throw new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
    }
    const now = new Date();
    const team: MemoryTeam = {
      id: `team-${this.teams.size + 1}`,
      name: input.name,
      slug: input.slug,
      organizationId: input.organizationId,
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
}
