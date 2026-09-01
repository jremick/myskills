import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  AppError,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
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

export interface PostgresTeamStoreOptions {
  /** Test-only failure injection before a required allow audit insert. */
  beforeAuditInsert?: (input: TeamAuditInput) => void | Promise<void>;
}

export class PostgresTeamStore implements TeamStore {
  constructor(
    private readonly db: Database,
    private readonly options: PostgresTeamStoreOptions = {},
  ) {}

  async createTeam(input: { name: string; slug: string; actorId: string; audit?: TeamAuditInput }): Promise<TeamRecord> {
    return this.db.transaction(async (tx) => {
      const [actor] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.actorId), eq(users.status, "active")))
        .for("update")
        .limit(1);
      if (!actor) {
        throw new AppError("An active team owner is required.", "TEAM_OWNER_REQUIRED", 403);
      }
      const [team] = await tx
        .insert(teams)
        .values({
          name: input.name,
          slug: input.slug,
          createdByUserId: input.actorId,
        })
        .onConflictDoNothing()
        .returning();
      if (!team) {
        throw new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
      }
      await tx.insert(teamMemberships).values({
        teamId: team.id,
        userId: input.actorId,
        role: "owner",
      });
      const result = {
        ...toTeamRecord(team, "owner"),
        members: await membersForTeam(tx, team.id),
        invitations: [],
      };
      await this.insertAllowAudit(tx, input.audit, team.id, { teamName: team.name });
      return result;
    });
  }

  /**
   * Create a child team while holding the organization aggregate lock. The
   * service performs the user-facing authorization check, but this store
   * repeats the membership, policy, and quota checks inside the transaction
   * so a concurrent policy or membership change cannot widen access.
   */
  async createChildTeam(input: CreateChildTeamStoreInput): Promise<TeamRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) {
          throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
        }
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        const policy = await currentOrganizationPolicy(tx, organization);
        const [actorMembership] = await tx
          .select({ role: organizationMemberships.role, userStatus: users.status })
          .from(organizationMemberships)
          .innerJoin(users, eq(users.id, organizationMemberships.userId))
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.userId, input.actorId),
            isNull(organizationMemberships.removedAt),
          ))
          .for("update")
          .limit(1);
        if (!actorMembership || actorMembership.userStatus !== "active") {
          throw new AppError("Active organization membership is required.", "ORGANIZATION_MEMBERSHIP_REQUIRED", 403);
        }
        if (actorMembership.role === "member" && !policy.teams.membersCanCreateTeams) {
          throw new AppError(
            "Organization members cannot create teams under the current policy.",
            "ORGANIZATION_TEAM_CREATE_FORBIDDEN",
            403,
          );
        }
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(teams)
          .where(eq(teams.organizationId, input.organizationId));
        if (Number(count) >= policy.limits.teamsPerOrganization) {
          throw new AppError("Organization team limit has been reached.", "ORGANIZATION_TEAM_LIMIT_REACHED", 409);
        }
        const [team] = await tx
          .insert(teams)
          .values({
            name: input.name,
            slug: input.slug,
            createdByUserId: input.actorId,
            organizationId: input.organizationId,
          })
          .onConflictDoNothing()
          .returning();
        if (!team) {
          throw new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
        }
        await tx.insert(teamMemberships).values({
          teamId: team.id,
          userId: input.actorId,
          role: "owner",
        });
        return {
          ...toTeamRecord(team, "owner"),
          members: await membersForTeam(tx, team.id),
          invitations: [],
        };
      });
    } catch (error) {
      throw mapTeamPersistenceError(error, "Organization team could not be created.", "ORGANIZATION_TEAM_CREATE_FAILED");
    }
  }

  /**
   * Adopt a standalone team with a stable NULL -> organization transition.
   * Team mutations lock the team first and then the parent organization. Keep
   * that order here so adoption cannot deadlock with a lifecycle mutation that
   * observes the team while it is being parented.
   */
  async adoptStandaloneTeam(input: AdoptStandaloneTeamStoreInput): Promise<TeamRecord | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const [team] = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, input.teamId))
          .for("update")
          .limit(1);
        if (!team) return null;
        if (team.organizationId !== null) {
          throw new AppError("Team already belongs to an organization.", "TEAM_ALREADY_PARENTED", 409);
        }

        const [teamOwner] = await tx
          .select({ id: teamMemberships.id, userStatus: users.status })
          .from(teamMemberships)
          .innerJoin(users, eq(users.id, teamMemberships.userId))
          .where(and(
            eq(teamMemberships.teamId, team.id),
            eq(teamMemberships.userId, input.actorId),
            eq(teamMemberships.role, "owner"),
          ))
          .for("update")
          .limit(1);
        if (!teamOwner || teamOwner.userStatus !== "active") {
          throw new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
        }

        const organization = await lockOrganization(tx, input.organizationId);
        if (!organization) return null;
        if (organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        const policy = await currentOrganizationPolicy(tx, organization);
        const [actorOrganizationMembership] = await tx
          .select({ role: organizationMemberships.role })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.organizationId, input.organizationId),
            eq(organizationMemberships.userId, input.actorId),
            isNull(organizationMemberships.removedAt),
          ))
          .for("update")
          .limit(1);
        if (!actorOrganizationMembership) {
          throw new AppError("Active organization membership is required.", "ORGANIZATION_MEMBERSHIP_REQUIRED", 403);
        }
        if (actorOrganizationMembership.role !== "owner" && actorOrganizationMembership.role !== "admin") {
          throw new AppError("Organization admin access is required.", "ORGANIZATION_ADMIN_REQUIRED", 403);
        }
        if (!policy.teams.allowStandaloneTeamAdoption) {
          throw new AppError(
            "Standalone team adoption is disabled by organization policy.",
            "ORGANIZATION_TEAM_ADOPTION_DISABLED",
            403,
          );
        }

        // The organization row lock serializes this count with child-team
        // creation and other standalone-team adoptions for the same org.
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)` })
          .from(teams)
          .where(eq(teams.organizationId, input.organizationId));
        if (Number(count) >= policy.limits.teamsPerOrganization) {
          throw new AppError("Organization team limit has been reached.", "ORGANIZATION_TEAM_LIMIT_REACHED", 409);
        }

        if (policy.teams.requireOrganizationMembershipForTeamMembers) {
          const [missingMember] = await tx
            .select({ userId: teamMemberships.userId })
            .from(teamMemberships)
            .leftJoin(organizationMemberships, and(
              eq(organizationMemberships.organizationId, input.organizationId),
              eq(organizationMemberships.userId, teamMemberships.userId),
              isNull(organizationMemberships.removedAt),
            ))
            .where(and(
              eq(teamMemberships.teamId, team.id),
              isNull(organizationMemberships.userId),
            ))
            .limit(1);
          if (missingMember) {
            throw new AppError(
              "All current team members must belong to the organization.",
              "ORGANIZATION_TEAM_MEMBERSHIP_REQUIRED",
              409,
              { missingUserId: missingMember.userId },
            );
          }
        }

        const [adopted] = await tx
          .update(teams)
          .set({ organizationId: input.organizationId, updatedAt: new Date() })
          .where(and(eq(teams.id, team.id), isNull(teams.organizationId)))
          .returning();
        if (!adopted) {
          throw new AppError("Team already belongs to an organization.", "TEAM_ALREADY_PARENTED", 409);
        }
        return {
          ...toTeamRecord(adopted, "owner"),
          members: await membersForTeam(tx, adopted.id),
          invitations: await invitationsForTeam(tx, adopted.id),
        };
      });
    } catch (error) {
      throw mapTeamPersistenceError(error, "Standalone team could not be adopted.", "ORGANIZATION_TEAM_ADOPTION_FAILED");
    }
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const rows = await this.db
      .select({
        team: teams,
        role: teamMemberships.role,
      })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .leftJoin(organizations, eq(organizations.id, teams.organizationId))
      .leftJoin(organizationPolicyRevisions, and(
        eq(organizationPolicyRevisions.organizationId, teams.organizationId),
        eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
      ))
      .leftJoin(organizationMemberships, and(
        eq(organizationMemberships.organizationId, teams.organizationId),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.removedAt),
      ))
      .where(and(
        eq(teamMemberships.userId, userId),
        effectiveTeamMembershipPredicate(userId),
      ))
      .orderBy(teams.name);

    return Promise.all(rows.map(async (row) => ({
      ...toTeamRecord(row.team, row.role),
      members: await membersForTeam(this.db, row.team.id),
      invitations: await invitationsForTeam(this.db, row.team.id),
    })));
  }

  async listPendingInvitationsForEmail(normalizedEmail: string): Promise<TeamInvitationRecord[]> {
    const rows = await this.db
      .select({
        invitation: teamInvitations,
        teamName: teams.name,
      })
      .from(teamInvitations)
      .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
      .where(and(
        eq(teamInvitations.normalizedEmail, normalizedEmail),
        eq(teamInvitations.status, "pending"),
      ))
      .orderBy(desc(teamInvitations.createdAt));
    return rows.map((row) => toInvitationRecord(row.invitation, row.teamName));
  }

  async findMembership(input: { teamId: string; userId: string }): Promise<{ role: "owner" | "member" } | null> {
    const [membership] = await this.db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(users, eq(users.id, teamMemberships.userId))
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .leftJoin(organizations, eq(organizations.id, teams.organizationId))
      .leftJoin(organizationPolicyRevisions, and(
        eq(organizationPolicyRevisions.organizationId, teams.organizationId),
        eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
      ))
      .leftJoin(organizationMemberships, and(
        eq(organizationMemberships.organizationId, teams.organizationId),
        eq(organizationMemberships.userId, input.userId),
        isNull(organizationMemberships.removedAt),
      ))
      .where(and(
        eq(teamMemberships.teamId, input.teamId),
        eq(teamMemberships.userId, input.userId),
        effectiveTeamMembershipPredicate(input.userId),
      ))
      .limit(1);
    return membership ?? null;
  }

  async createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord> {
    return this.db.transaction(async (tx) => {
      // Lock the team and re-evaluate the complete owner boundary before
      // checking the recipient or writing the invitation. This closes the
      // service-preflight TOCTOU window for team demotions and parent-org
      // membership/policy changes.
      const team = await lockTeamOwnerAuthority(tx, input.teamId, input.invitedByUserId);
      if (!team) {
        throw new AppError("Team not found.", "TEAM_NOT_FOUND", 404);
      }

      const [existingMember] = await tx
        .select({ id: teamMemberships.id })
        .from(teamMemberships)
        .innerJoin(users, eq(users.id, teamMemberships.userId))
        .where(and(
          eq(teamMemberships.teamId, input.teamId),
          eq(users.normalizedEmail, input.normalizedEmail),
        ))
        .limit(1);
      if (existingMember) {
        throw new AppError("User is already a team member.", "TEAM_MEMBER_EXISTS", 409);
      }

      const now = new Date();
      const [invitation] = await tx
        .insert(teamInvitations)
        .values({
          teamId: input.teamId,
          email: input.email,
          normalizedEmail: input.normalizedEmail,
          invitedByUserId: input.invitedByUserId,
          status: "pending",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [teamInvitations.teamId, teamInvitations.normalizedEmail],
          set: {
            email: input.email,
            invitedByUserId: input.invitedByUserId,
            status: "pending",
            acceptedByUserId: null,
            acceptedAt: null,
            updatedAt: now,
          },
        })
        .returning();
      if (!invitation) {
        throw new Error("Team invitation insert failed.");
      }
      await this.insertAllowAudit(tx, input.audit, team.id, { invitedEmail: input.email });
      return toInvitationRecord(invitation, team.name);
    });
  }

  async revokeInvitation(input: { teamId: string; invitationId: string; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamInvitationRecord | null> {
    return this.db.transaction(async (tx) => {
      if (!await lockTeamOwnerAuthority(tx, input.teamId, input.actorUserId)) return null;
      const [row] = await tx
        .select({
          invitation: teamInvitations,
          teamName: teams.name,
        })
        .from(teamInvitations)
        .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
        .where(and(
          eq(teamInvitations.id, input.invitationId),
          eq(teamInvitations.teamId, input.teamId),
          eq(teamInvitations.status, "pending"),
        ))
        .limit(1);
      if (!row) {
        return null;
      }

      const [updated] = await tx
        .update(teamInvitations)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(and(
          eq(teamInvitations.id, input.invitationId),
          eq(teamInvitations.teamId, input.teamId),
          eq(teamInvitations.status, "pending"),
        ))
        .returning();
      if (updated) await this.insertAllowAudit(tx, input.audit, input.teamId, { invitationId: updated.id });
      return updated ? toInvitationRecord(updated, row.teamName) : null;
    });
  }

  async updateMemberRole(input: { teamId: string; userId: string; role: TeamMemberRole; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamMemberRecord | null> {
    return this.db.transaction(async (tx) => {
      if (!await lockTeamOwnerAuthority(tx, input.teamId, input.actorUserId)) return null;

      const [membership] = await tx
        .select()
        .from(teamMemberships)
        .where(and(
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.userId, input.userId),
        ))
        .for("update")
        .limit(1);
      if (!membership) {
        return null;
      }
      if (membership.role === "owner" && input.role === "member" && await ownerCount(tx, input.teamId) <= 1) {
        throw new AppError("At least one team owner is required.", "LAST_OWNER_REQUIRED", 409);
      }

      const [user] = await tx
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user) {
        return null;
      }
      const [updated] = await tx
        .update(teamMemberships)
        .set({ role: input.role })
        .where(eq(teamMemberships.id, membership.id))
        .returning({ role: teamMemberships.role });
      if (!updated) {
        return null;
      }
      await tx.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, input.teamId));
      const result = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: updated.role,
      };
      await this.insertAllowAudit(tx, input.audit, input.teamId, {
        memberId: result.id,
        roleBefore: membership.role,
        roleAfter: result.role,
      });
      return result;
    });
  }

  async removeMember(input: { teamId: string; userId: string; actorUserId: string; audit?: TeamAuditInput }): Promise<TeamMemberRecord | null> {
    return this.db.transaction(async (tx) => {
      if (!await lockTeamOwnerAuthority(tx, input.teamId, input.actorUserId)) return null;

      const [membership] = await tx
        .select()
        .from(teamMemberships)
        .where(and(
          eq(teamMemberships.teamId, input.teamId),
          eq(teamMemberships.userId, input.userId),
        ))
        .for("update")
        .limit(1);
      if (!membership) {
        return null;
      }
      if (membership.role === "owner" && await ownerCount(tx, input.teamId) <= 1) {
        throw new AppError("At least one team owner is required.", "LAST_OWNER_REQUIRED", 409);
      }

      const [user] = await tx
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1);
      if (!user) {
        return null;
      }
      const [removed] = await tx
        .delete(teamMemberships)
        .where(eq(teamMemberships.id, membership.id))
        .returning({ id: teamMemberships.id });
      if (!removed) {
        return null;
      }
      await tx.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, input.teamId));
      const result = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: membership.role,
      };
      await this.insertAllowAudit(tx, input.audit, input.teamId, {
        memberId: result.id,
        roleBefore: result.role,
      });
      return result;
    });
  }

  async acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
    audit?: TeamAuditInput;
  }): Promise<TeamInvitationRecord | null> {
    return this.db.transaction(async (tx) => {
      // Resolve the team ID first, then acquire the team lock before the
      // invitation lock. Team lifecycle mutations use the same order, which
      // makes acceptance linear with adoption, revocation, and owner changes.
      const [invitationLookup] = await tx
        .select({ teamId: teamInvitations.teamId })
        .from(teamInvitations)
        .where(eq(teamInvitations.id, input.invitationId))
        .limit(1);
      if (!invitationLookup) return null;

      const team = await lockTeam(tx, invitationLookup.teamId);
      if (!team) return null;

      const [invitation] = await tx
        .select({
          invitation: teamInvitations,
        })
        .from(teamInvitations)
        .where(and(
          eq(teamInvitations.id, input.invitationId),
          eq(teamInvitations.teamId, team.id),
          eq(teamInvitations.normalizedEmail, input.normalizedEmail),
          eq(teamInvitations.status, "pending"),
        ))
        .for("update")
        .limit(1);
      if (!invitation) return null;

      if (team.organizationId !== null) {
        const organization = await lockOrganization(tx, team.organizationId);
        if (!organization || organization.status !== "active") {
          throw new AppError("Organization is not active.", "ORGANIZATION_INACTIVE", 409);
        }
        const policy = await currentOrganizationPolicy(tx, organization);
        if (policy.teams.requireOrganizationMembershipForTeamMembers) {
          const [membership] = await tx
            .select({ id: organizationMemberships.id })
            .from(organizationMemberships)
            .where(and(
              eq(organizationMemberships.organizationId, team.organizationId),
              eq(organizationMemberships.userId, input.actorId),
              isNull(organizationMemberships.removedAt),
            ))
            .for("update")
            .limit(1);
          if (!membership) {
            throw new AppError(
              "Active organization membership is required to join this team.",
              "ORGANIZATION_MEMBERSHIP_REQUIRED",
              403,
            );
          }
        }
      }

      // The authenticated request identity must still match the invitation
      // address at the write boundary. This mirrors organization invitation
      // acceptance and prevents a mismatched/stale actor record from joining.
      const [actor] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(and(
          eq(users.id, input.actorId),
          eq(users.normalizedEmail, input.normalizedEmail),
        ))
        .for("update")
        .limit(1);
      if (!actor || actor.status !== "active") return null;

      await tx.insert(teamMemberships).values({
        teamId: team.id,
        userId: input.actorId,
        role: "member",
      }).onConflictDoNothing();

      const now = new Date();
      const [updated] = await tx
        .update(teamInvitations)
        .set({
          status: "accepted",
          acceptedByUserId: input.actorId,
          acceptedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(teamInvitations.id, invitation.invitation.id),
          eq(teamInvitations.teamId, team.id),
          eq(teamInvitations.normalizedEmail, input.normalizedEmail),
          eq(teamInvitations.status, "pending"),
        ))
        .returning();
      if (!updated) return null;
      await tx.update(teams).set({ updatedAt: now }).where(eq(teams.id, team.id));
      await this.insertAllowAudit(tx, input.audit, team.id, { invitationId: updated.id });
      return toInvitationRecord(updated, team.name);
    });
  }

  async recordAuditEvent(input: TeamAuditInput): Promise<void> {
    await insertTeamAuditEvent(this.db, input);
  }

  private async insertAllowAudit(
    db: DbLike,
    input: TeamAuditInput | undefined,
    resourceId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!input) return;
    const audit = {
      ...input,
      resourceId,
      details: { ...input.details, ...details },
    };
    await this.options.beforeAuditInsert?.(audit);
    await insertTeamAuditEvent(db, audit);
  }
}

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * A team membership is effective only while its parent organization is
 * active, has its current policy row, and contains the same active user.
 * Standalone teams deliberately retain the legacy membership semantics.
 */
function effectiveTeamMembershipPredicate(userId: string): SQL<boolean> {
  return or(
    and(
      isNull(teams.organizationId),
      eq(users.status, "active"),
    ),
    and(
      isNotNull(teams.organizationId),
      eq(users.status, "active"),
      eq(organizations.status, "active"),
      isNotNull(organizations.currentPolicyRevisionId),
      isNotNull(organizationPolicyRevisions.id),
      or(
        organizationPolicyAllowsExternalTeamMembers(),
        and(
          isNotNull(organizationMemberships.id),
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.removedAt),
        ),
      ),
    ),
  )! as SQL<boolean>;
}

async function lockOrganization(db: DbLike, organizationId: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  return organization ?? null;
}

async function lockTeam(db: DbLike, teamId: string) {
  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update")
    .limit(1);
  return team ?? null;
}

/**
 * Lock and re-evaluate team-owner authority at the write boundary. Team rows
 * are locked first; organization-owned teams then lock their parent and the
 * actor's active organization membership. This gives team mutations one
 * linearization point with team-role, organization-membership, and parent
 * lifecycle changes.
 */
async function lockTeamOwnerAuthority(
  db: DbLike,
  teamId: string,
  actorUserId: string,
): Promise<typeof teams.$inferSelect | null> {
  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update")
    .limit(1);
  if (!team) return null;

  if (team.organizationId !== null) {
    const organization = await lockOrganization(db, team.organizationId);
    if (!organization || organization.status !== "active") {
      throw teamOwnerRequired();
    }
    let policy: OrganizationPolicyV1;
    try {
      policy = await currentOrganizationPolicy(db, organization);
    } catch {
      throw teamOwnerRequired();
    }
    if (policy.teams.requireOrganizationMembershipForTeamMembers) {
      const [organizationMembership] = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, team.organizationId),
          eq(organizationMemberships.userId, actorUserId),
          isNull(organizationMemberships.removedAt),
        ))
        .for("update")
        .limit(1);
      if (!organizationMembership) {
        throw teamOwnerRequired();
      }
    }
  }

  // The session may outlive an account-status change. Lock the authoritative
  // user row after the organization row/membership order above, then require
  // an active identity before accepting the team-owner role.
  const [actor] = await db
    .select({ status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId))
    .for("update")
    .limit(1);
  if (!actor || actor.status !== "active") {
    throw teamOwnerRequired();
  }

  const [ownerMembership] = await db
    .select({ role: teamMemberships.role })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, teamId),
      eq(teamMemberships.userId, actorUserId),
    ))
    .for("update")
    .limit(1);
  if (ownerMembership?.role !== "owner") {
    throw teamOwnerRequired();
  }
  return team;
}

function teamOwnerRequired(): AppError {
  return new AppError("Team owner access is required.", "TEAM_OWNER_REQUIRED", 403);
}

async function currentOrganizationPolicy(
  db: DbLike,
  organization: typeof organizations.$inferSelect,
): Promise<OrganizationPolicyV1> {
  if (!organization.currentPolicyRevisionId) {
    throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
  }
  const [revision] = await db
    .select({
      policy: organizationPolicyRevisions.policy,
      policySha256: organizationPolicyRevisions.policySha256,
    })
    .from(organizationPolicyRevisions)
    .where(and(
      eq(organizationPolicyRevisions.organizationId, organization.id),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
    ))
    .limit(1);
  if (!revision) {
    throw new AppError("Organization policy is unavailable.", "ORGANIZATION_POLICY_UNAVAILABLE", 500);
  }
  let policy: OrganizationPolicyV1;
  try {
    policy = normalizeOrganizationPolicyV1(revision.policy);
  } catch {
    throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500);
  }
  if (organizationPolicyDigest(policy) !== revision.policySha256) {
    throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500);
  }
  return policy;
}

async function ownerCount(db: DbLike, teamId: string): Promise<number> {
  const rows = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, teamId),
      eq(teamMemberships.role, "owner"),
    ));
  return rows.length;
}

async function membersForTeam(db: DbLike, teamId: string): Promise<TeamMemberRecord[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: teamMemberships.role,
    })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .leftJoin(organizations, eq(organizations.id, teams.organizationId))
    .leftJoin(organizationPolicyRevisions, and(
      eq(organizationPolicyRevisions.organizationId, teams.organizationId),
      eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
    ))
    .leftJoin(organizationMemberships, and(
      eq(organizationMemberships.organizationId, teams.organizationId),
      eq(organizationMemberships.userId, teamMemberships.userId),
      isNull(organizationMemberships.removedAt),
    ))
    .where(and(
      eq(teamMemberships.teamId, teamId),
      effectiveTeamMembershipPredicateForColumn(teamMemberships.userId),
    ))
    .orderBy(teamMemberships.role, users.normalizedEmail);
  return rows;
}

function effectiveTeamMembershipPredicateForColumn(userId: typeof teamMemberships.userId): SQL<boolean> {
  return or(
    and(
      isNull(teams.organizationId),
      eq(users.status, "active"),
    ),
    and(
      isNotNull(teams.organizationId),
      eq(users.status, "active"),
      eq(organizations.status, "active"),
      isNotNull(organizations.currentPolicyRevisionId),
      isNotNull(organizationPolicyRevisions.id),
      or(
        organizationPolicyAllowsExternalTeamMembers(),
        and(
          isNotNull(organizationMemberships.id),
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.removedAt),
        ),
      ),
    ),
  )! as SQL<boolean>;
}

/** Treat malformed/missing policy JSON as requiring parent membership. */
function organizationPolicyAllowsExternalTeamMembers(): SQL<boolean> {
  return sql`coalesce(${organizationPolicyRevisions.policy}->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false'`;
}

async function invitationsForTeam(db: DbLike, teamId: string): Promise<TeamInvitationRecord[]> {
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId)).limit(1);
  const rows = await db
    .select()
    .from(teamInvitations)
    .where(and(eq(teamInvitations.teamId, teamId), eq(teamInvitations.status, "pending")))
    .orderBy(desc(teamInvitations.createdAt));
  return rows.map((row) => toInvitationRecord(row, team?.name ?? ""));
}

function toTeamRecord(team: typeof teams.$inferSelect, role: "owner" | "member"): Omit<TeamRecord, "members" | "invitations"> {
  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    organizationId: team.organizationId,
    role,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function toInvitationRecord(invitation: typeof teamInvitations.$inferSelect, teamName: string): TeamInvitationRecord {
  return {
    id: invitation.id,
    teamId: invitation.teamId,
    teamName,
    email: invitation.email,
    status: invitation.status,
    createdAt: invitation.createdAt,
  };
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}

async function insertTeamAuditEvent(db: DbLike, input: TeamAuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: isUuid(input.actorUserId) ? input.actorUserId : null,
    action: input.action,
    decision: input.decision,
    resourceType: "team",
    resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
    details: sanitizeAuditDetails(input.details ?? {}),
  });
}

function mapTeamPersistenceError(error: unknown, fallbackMessage: string, fallbackCode: string): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return new AppError("Team name is already in use.", "TEAM_ALREADY_EXISTS", 409);
  }
  return new AppError(fallbackMessage, fallbackCode, 409);
}
