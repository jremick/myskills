import { and, eq, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { AppError, type PublicSkill, type SharingSettings, type SkillAccessReason, type SkillRepository, type SkillSearchFilters, type SkillPlatformVariant, type SkillSharingActor, type SkillSharingDetails, type SkillSharingTeamSummary, type SkillSharingUserSummary, type TeamSharedSkillGroup, type UpdateSkillSharingInput, type VisibilityScope } from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  instanceSettings,
  skillArtifacts,
  skillPlatformVariants,
  skillTags,
  skillTeamGrants,
  skillUserGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";

const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
};

export class PostgresSkillRepository implements SkillRepository {
  constructor(private readonly db: Database) {}

  async searchVisibleSkills(filters: SkillSearchFilters = {}): Promise<PublicSkill[]> {
    const sharing = await this.getSharingSettings();
    const query = filters.query?.trim() ?? "";
    const limit = filters.limit ?? 50;
    const where = and(
      visibleReleasedSkillPredicate(),
      visibleToActorPredicate(filters.actorId ?? null, sharing),
      query
        ? or(
            ilike(skills.slug, `%${query}%`),
            ilike(skills.title, `%${query}%`),
            ilike(skills.summary, `%${query}%`),
          )
        : undefined,
    );

    return uniqueBySlug(await this.visibleSkillRows(where, limit * 5, filters.actorId ?? null, sharing)).slice(0, limit);
  }

  async getVisibleSkillBySlug(slug: string, actorId?: string | null): Promise<PublicSkill | null> {
    const sharing = await this.getSharingSettings();
    const rows = await this.visibleSkillRows(and(
      eq(skills.slug, slug),
      visibleReleasedSkillPredicate(),
      visibleToActorPredicate(actorId ?? null, sharing),
    ), 1, actorId ?? null, sharing);
    return rows[0] ?? null;
  }

  async getSharingSettings(): Promise<SharingSettings> {
    const [setting] = await this.db
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, "sharing"))
      .limit(1);
    return parseSharingSettings(setting?.value);
  }

  async updateSharingSettings(actor: SkillSharingActor, settings: SharingSettings): Promise<SharingSettings> {
    if (!actor.roles.includes("owner")) {
      throw new AppError("Owner access is required.", "OWNER_ROLE_REQUIRED", 403);
    }
    const next = parseSharingSettings(settings);
    await this.db
      .insert(instanceSettings)
      .values({
        key: "sharing",
        value: next,
      })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: {
          value: next,
          updatedAt: new Date(),
        },
      });
    await this.db.insert(auditEvents).values({
      actorUserId: actor.id,
      action: "admin.sharing.update",
      decision: "allow",
      resourceType: "instance_setting",
      details: sanitizeAuditDetails({ setting: "sharing", settings: next }),
    });
    return next;
  }

  async getSkillSharing(slug: string, actor: SkillSharingActor): Promise<SkillSharingDetails> {
    const skill = await this.findSkillForSharing(slug);
    assertCanManageSkillSharing(skill, actor);
    return this.skillSharingDetails(skill, actor);
  }

  async updateSkillSharing(input: UpdateSkillSharingInput): Promise<SkillSharingDetails> {
    const skill = await this.findSkillForSharing(input.slug);
    assertCanManageSkillSharing(skill, input.actor);
    const settings = await this.getSharingSettings();
    validateVisibilityEnabled(input.visibility, settings);

    const teamIds = uniqueStrings(input.teamIds);
    const userEmails = uniqueStrings(input.userEmails.map(normalizeEmail));
    if (teamIds.length > 0 && (!settings.teamsEnabled || !settings.teamVisibilityEnabled)) {
      throw new AppError("Team sharing is disabled for this instance.", "TEAM_SHARING_DISABLED", 403);
    }
    if (userEmails.length > 0 && !settings.userVisibilityEnabled) {
      throw new AppError("User sharing is disabled for this instance.", "USER_SHARING_DISABLED", 403);
    }
    if (input.visibility === "team" && teamIds.length === 0) {
      throw new AppError("At least one team grant is required.", "TEAM_GRANT_REQUIRED", 400);
    }
    if (input.visibility === "explicit-users" && userEmails.length === 0) {
      throw new AppError("At least one user grant is required.", "USER_GRANT_REQUIRED", 400);
    }

    const availableTeams = await this.teamsForUser(input.actor.id);
    const availableTeamIds = new Set(availableTeams.map((team) => team.id));
    const unavailableTeam = teamIds.find((teamId) => !availableTeamIds.has(teamId));
    if (unavailableTeam) {
      throw new AppError("Team grant is not available to this user.", "TEAM_GRANT_NOT_AVAILABLE", 403);
    }

    const userGrantIds = userEmails.length > 0 ? await this.resolveUserGrantIds(userEmails) : [];
    await this.db.transaction(async (tx) => {
      await tx.update(skills).set({
        visibility: input.visibility,
        updatedAt: new Date(),
      }).where(eq(skills.id, skill.id));

      await tx.delete(skillTeamGrants).where(eq(skillTeamGrants.skillId, skill.id));
      if (teamIds.length > 0) {
        await tx.insert(skillTeamGrants).values(teamIds.map((teamId) => ({
          skillId: skill.id,
          teamId,
        }))).onConflictDoNothing();
      }

      await tx.delete(skillUserGrants).where(eq(skillUserGrants.skillId, skill.id));
      if (userGrantIds.length > 0) {
        await tx.insert(skillUserGrants).values(userGrantIds.map((userId) => ({
          skillId: skill.id,
          userId,
        }))).onConflictDoNothing();
      }

      await tx.insert(auditEvents).values({
        actorUserId: input.actor.id,
        action: "skill.sharing.update",
        decision: "allow",
        resourceType: "skill",
        resourceId: skill.id,
        details: sanitizeAuditDetails({
          slug: skill.slug,
          visibility: input.visibility,
          teamGrantCount: teamIds.length,
          userGrantCount: userGrantIds.length,
        }),
      });
    });

    return this.skillSharingDetails({ ...skill, visibility: input.visibility }, input.actor);
  }

  async listTeamSkillGroups(actor: SkillSharingActor): Promise<TeamSharedSkillGroup[]> {
    const settings = await this.getSharingSettings();
    if (!settings.teamsEnabled || !settings.teamVisibilityEnabled) {
      return [];
    }
    const userTeams = await this.teamsForUser(actor.id);
    return Promise.all(userTeams.map(async (team) => ({
      team,
      sharingWithTeam: uniqueBySlug(await this.visibleSkillRows(and(
        visibleReleasedSkillPredicate(),
        eq(skills.ownerUserId, actor.id),
        eq(skills.visibility, "team"),
        sql`exists (
          select 1
          from ${skillTeamGrants}
          where ${skillTeamGrants.skillId} = ${skills.id}
            and ${skillTeamGrants.teamId} = ${team.id}
        )`,
      ), 100, actor.id, settings)),
      sharedWithMe: uniqueBySlug(await this.visibleSkillRows(and(
        visibleReleasedSkillPredicate(),
        eq(skills.visibility, "team"),
        sql`${skills.ownerUserId} is distinct from ${actor.id}`,
        sql`exists (
          select 1
          from ${skillTeamGrants}
          where ${skillTeamGrants.skillId} = ${skills.id}
            and ${skillTeamGrants.teamId} = ${team.id}
        )`,
      ), 100, actor.id, settings)),
    })));
  }

  private async visibleSkillRows(
    where: SQL | undefined,
    limit: number,
    actorId: string | null,
    sharing: SharingSettings,
  ): Promise<PublicSkill[]> {
    const rows = await this.db
      .select({
        id: skills.id,
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
        lifecycleStatus: skills.lifecycleStatus,
        visibility: skills.visibility,
        ownerUserId: skills.ownerUserId,
        latestVersion: skillVersions.version,
        reviewStatus: skillVersions.reviewStatus,
        securityStatus: skillVersions.securityStatus,
        platforms: sql<SkillPlatformVariant[]>`
          coalesce(
            json_agg(
              json_build_object(
                'name', ${skillPlatformVariants.name},
                'installTarget', ${skillPlatformVariants.installTarget},
                'status', ${skillPlatformVariants.status}
              )
            ) filter (where ${skillPlatformVariants.id} is not null),
            '[]'::json
          )
        `,
        tags: sql<string[]>`
          coalesce(
            array_agg(distinct ${skillTags.tag}) filter (where ${skillTags.tag} is not null),
            '{}'::text[]
          )
        `,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
      .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
      .leftJoin(skillTags, eq(skillTags.skillId, skills.id))
      .where(where)
      .groupBy(
        skills.slug,
        skills.title,
        skills.summary,
        skills.lifecycleStatus,
        skills.visibility,
        skills.ownerUserId,
        skillVersions.version,
        skillVersions.reviewStatus,
        skillVersions.securityStatus,
        skillVersions.createdAt,
      )
      .orderBy(sql`${skillVersions.createdAt} desc`, skills.title)
      .limit(limit);

    return Promise.all(rows.map(async (row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      lifecycleStatus: row.lifecycleStatus,
      visibility: row.visibility,
      latestVersion: row.latestVersion,
      reviewStatus: row.reviewStatus,
      securityStatus: row.securityStatus,
      platforms: dedupePlatforms(row.platforms),
      tags: row.tags,
      access: actorId
        ? {
          canManageSharing: row.ownerUserId === actorId,
          reasons: await this.accessReasonsForSkill(row, actorId, sharing),
        }
        : undefined,
    })));
  }

  private async findSkillForSharing(slug: string) {
    const [skill] = await this.db
      .select({
        id: skills.id,
        slug: skills.slug,
        title: skills.title,
        visibility: skills.visibility,
        ownerUserId: skills.ownerUserId,
      })
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1);
    if (!skill) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    return skill;
  }

  private async skillSharingDetails(
    skill: { id: string; slug: string; title: string; visibility: VisibilityScope },
    actor: SkillSharingActor,
  ): Promise<SkillSharingDetails> {
    const [settings, availableTeams, teamGrants, userGrants] = await Promise.all([
      this.getSharingSettings(),
      this.teamsForUser(actor.id),
      this.teamGrantsForSkill(skill.id, actor.id),
      this.userGrantsForSkill(skill.id),
    ]);
    return {
      slug: skill.slug,
      title: skill.title,
      visibility: skill.visibility,
      settings,
      availableTeams,
      teamGrants,
      userGrants,
    };
  }

  private async teamsForUser(userId: string): Promise<SkillSharingTeamSummary[]> {
    const rows = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        role: teamMemberships.role,
      })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(eq(teamMemberships.userId, userId))
      .orderBy(teams.name);
    return rows;
  }

  private async teamGrantsForSkill(skillId: string, actorId: string): Promise<SkillSharingTeamSummary[]> {
    const rows = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        role: teamMemberships.role,
      })
      .from(skillTeamGrants)
      .innerJoin(teams, eq(teams.id, skillTeamGrants.teamId))
      .leftJoin(teamMemberships, and(
        eq(teamMemberships.teamId, teams.id),
        eq(teamMemberships.userId, actorId),
      ))
      .where(eq(skillTeamGrants.skillId, skillId))
      .orderBy(teams.name);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role ?? "member",
    }));
  }

  private async userGrantsForSkill(skillId: string): Promise<SkillSharingUserSummary[]> {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
      })
      .from(skillUserGrants)
      .innerJoin(users, eq(users.id, skillUserGrants.userId))
      .where(eq(skillUserGrants.skillId, skillId))
      .orderBy(users.normalizedEmail);
  }

  private async resolveUserGrantIds(userEmails: string[]): Promise<string[]> {
    const rows = await this.db
      .select({
        id: users.id,
        normalizedEmail: users.normalizedEmail,
      })
      .from(users)
      .where(and(inArray(users.normalizedEmail, userEmails), eq(users.status, "active")));
    const found = new Set(rows.map((row) => row.normalizedEmail));
    const missing = userEmails.find((email) => !found.has(email));
    if (missing) {
      throw new AppError("Shared user must be an active account.", "SHARED_USER_NOT_FOUND", 404);
    }
    return rows.map((row) => row.id);
  }

  private async accessReasonsForSkill(
    row: { id: string; visibility: VisibilityScope; ownerUserId: string | null },
    actorId: string,
    sharing: SharingSettings,
  ): Promise<SkillAccessReason[]> {
    const reasons: SkillAccessReason[] = [];
    if (row.ownerUserId === actorId) {
      reasons.push("owner");
    }
    if (row.visibility === "public" && sharing.publicVisibilityEnabled) {
      reasons.push("public");
    }
    if ((row.visibility === "authenticated" || row.visibility === "organization") && sharing.authenticatedVisibilityEnabled) {
      reasons.push("authenticated");
    }
    if (row.visibility === "team" && sharing.teamsEnabled && sharing.teamVisibilityEnabled && await this.hasTeamAccess(row.id, actorId)) {
      reasons.push("team");
    }
    if (row.visibility === "explicit-users" && sharing.userVisibilityEnabled && await this.hasUserGrant(row.id, actorId)) {
      reasons.push("explicit-user");
    }
    return reasons;
  }

  private async hasTeamAccess(skillId: string, actorId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ teamId: skillTeamGrants.teamId })
      .from(skillTeamGrants)
      .innerJoin(teamMemberships, eq(teamMemberships.teamId, skillTeamGrants.teamId))
      .where(and(eq(skillTeamGrants.skillId, skillId), eq(teamMemberships.userId, actorId)))
      .limit(1);
    return Boolean(row);
  }

  private async hasUserGrant(skillId: string, actorId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: skillUserGrants.userId })
      .from(skillUserGrants)
      .where(and(eq(skillUserGrants.skillId, skillId), eq(skillUserGrants.userId, actorId)))
      .limit(1);
    return Boolean(row);
  }
}

function visibleReleasedSkillPredicate(): SQL | undefined {
  return and(
    eq(skills.lifecycleStatus, "approved"),
    eq(skillVersions.reviewStatus, "approved"),
    eq(skillVersions.securityStatus, "passed"),
    isNotNull(skillVersions.publishedAt),
  );
}

function visibleToActorPredicate(actorId: string | null, sharing: SharingSettings): SQL | undefined {
  const predicates: Array<SQL | undefined> = [
    sharing.publicVisibilityEnabled ? eq(skills.visibility, "public") : undefined,
  ];
  if (actorId) {
    predicates.push(eq(skills.ownerUserId, actorId));
    if (sharing.authenticatedVisibilityEnabled) {
      predicates.push(inArray(skills.visibility, ["authenticated", "organization"]));
    }
    if (sharing.teamsEnabled && sharing.teamVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "team"),
        sql`exists (
          select 1
          from ${skillTeamGrants}
          inner join ${teamMemberships} on ${teamMemberships.teamId} = ${skillTeamGrants.teamId}
          where ${skillTeamGrants.skillId} = ${skills.id}
            and ${teamMemberships.userId} = ${actorId}
        )`,
      ));
    }
    if (sharing.userVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "explicit-users"),
        sql`exists (
          select 1
          from ${skillUserGrants}
          where ${skillUserGrants.skillId} = ${skills.id}
            and ${skillUserGrants.userId} = ${actorId}
        )`,
      ));
    }
  }
  const active = predicates.filter((predicate): predicate is SQL => Boolean(predicate));
  return active.length > 0 ? or(...active) : sql`false`;
}

function uniqueBySlug(skills: PublicSkill[]): PublicSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.slug)) {
      return false;
    }
    seen.add(skill.slug);
    return true;
  });
}

function dedupePlatforms(platforms: SkillPlatformVariant[]): SkillPlatformVariant[] {
  const seen = new Set<string>();
  return platforms.filter((platform) => {
    const key = `${platform.name}:${platform.installTarget}:${platform.status}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseSharingSettings(input: unknown): SharingSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return DEFAULT_SHARING_SETTINGS;
  }
  const record = input as Partial<SharingSettings>;
  return {
    publicVisibilityEnabled: typeof record.publicVisibilityEnabled === "boolean" ? record.publicVisibilityEnabled : true,
    authenticatedVisibilityEnabled: typeof record.authenticatedVisibilityEnabled === "boolean" ? record.authenticatedVisibilityEnabled : true,
    teamsEnabled: typeof record.teamsEnabled === "boolean" ? record.teamsEnabled : true,
    teamVisibilityEnabled: typeof record.teamVisibilityEnabled === "boolean" ? record.teamVisibilityEnabled : true,
    userVisibilityEnabled: typeof record.userVisibilityEnabled === "boolean" ? record.userVisibilityEnabled : true,
  };
}

function assertCanManageSkillSharing(
  skill: { ownerUserId: string | null; slug: string },
  actor: SkillSharingActor,
): void {
  if (skill.ownerUserId === actor.id || actor.roles.includes("owner") || actor.roles.includes("admin")) {
    return;
  }
  throw new AppError("Skill owner access is required.", "SKILL_OWNER_REQUIRED", 403);
}

function validateVisibilityEnabled(visibility: VisibilityScope, settings: SharingSettings): void {
  if (visibility === "public" && !settings.publicVisibilityEnabled) {
    throw new AppError("Public sharing is disabled for this instance.", "PUBLIC_SHARING_DISABLED", 403);
  }
  if ((visibility === "authenticated" || visibility === "organization") && !settings.authenticatedVisibilityEnabled) {
    throw new AppError("Signed-in-user sharing is disabled for this instance.", "AUTHENTICATED_SHARING_DISABLED", 403);
  }
  if (visibility === "team" && (!settings.teamsEnabled || !settings.teamVisibilityEnabled)) {
    throw new AppError("Team sharing is disabled for this instance.", "TEAM_SHARING_DISABLED", 403);
  }
  if (visibility === "explicit-users" && !settings.userVisibilityEnabled) {
    throw new AppError("User sharing is disabled for this instance.", "USER_SHARING_DISABLED", 403);
  }
}

function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError("Valid user grant email is required.", "INVALID_USER_GRANT_EMAIL", 400);
  }
  return email;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
