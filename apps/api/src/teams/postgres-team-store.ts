import { and, desc, eq } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  teamInvitations,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
import type {
  TeamInvitationRecord,
  TeamMemberRecord,
  TeamRecord,
  TeamStore,
} from "./types.js";

export class PostgresTeamStore implements TeamStore {
  constructor(private readonly db: Database) {}

  async createTeam(input: { name: string; slug: string; actorId: string }): Promise<TeamRecord> {
    return this.db.transaction(async (tx) => {
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
      return {
        ...toTeamRecord(team, "owner"),
        members: await membersForTeam(tx, team.id),
        invitations: [],
      };
    });
  }

  async listTeamsForUser(userId: string): Promise<TeamRecord[]> {
    const rows = await this.db
      .select({
        team: teams,
        role: teamMemberships.role,
      })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(eq(teamMemberships.userId, userId))
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
      .where(and(eq(teamMemberships.teamId, input.teamId), eq(teamMemberships.userId, input.userId)))
      .limit(1);
    return membership ?? null;
  }

  async createInvitation(input: {
    teamId: string;
    email: string;
    normalizedEmail: string;
    invitedByUserId: string;
  }): Promise<TeamInvitationRecord> {
    const [existingMember] = await this.db
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

    const [team] = await this.db.select().from(teams).where(eq(teams.id, input.teamId)).limit(1);
    if (!team) {
      throw new AppError("Team not found.", "TEAM_NOT_FOUND", 404);
    }

    const now = new Date();
    const [invitation] = await this.db
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
    return toInvitationRecord(invitation, team.name);
  }

  async acceptInvitation(input: {
    invitationId: string;
    actorId: string;
    normalizedEmail: string;
  }): Promise<TeamInvitationRecord | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          invitation: teamInvitations,
          teamName: teams.name,
        })
        .from(teamInvitations)
        .innerJoin(teams, eq(teams.id, teamInvitations.teamId))
        .where(and(
          eq(teamInvitations.id, input.invitationId),
          eq(teamInvitations.normalizedEmail, input.normalizedEmail),
          eq(teamInvitations.status, "pending"),
        ))
        .limit(1);
      if (!row) {
        return null;
      }

      await tx.insert(teamMemberships).values({
        teamId: row.invitation.teamId,
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
        .where(eq(teamInvitations.id, row.invitation.id))
        .returning();
      return updated ? toInvitationRecord(updated, row.teamName) : null;
    });
  }

  async recordAuditEvent(input: {
    actorUserId: string;
    action: string;
    decision: "allow" | "deny";
    resourceId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceType: "team",
      resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
      details: sanitizeAuditDetails(input.details ?? {}),
    });
  }
}

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

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
    .where(eq(teamMemberships.teamId, teamId))
    .orderBy(teamMemberships.role, users.normalizedEmail);
  return rows;
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
