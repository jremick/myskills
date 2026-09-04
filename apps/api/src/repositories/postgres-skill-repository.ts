import { and, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  AppError,
  assertValidOrganizationPolicyV1,
  evaluateOrganizationShare,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
  type PublicSkill,
  type SharingSettings,
  type SkillAccessReason,
  type SkillRepository,
  type SkillSearchFilters,
  type SkillPlatformVariant,
  type SkillSharingActor,
  type SkillSharingDetails,
  type SkillSharingOrganizationSummary,
  type SkillSharingTeamSummary,
  type SkillSharingUserSummary,
  type TeamSharedSkillGroup,
  type UpdateSkillSharingInput,
  type VisibilityScope,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  instanceSettings,
  skillArtifacts,
  skillOrganizationGrants,
  skillPlatformVariants,
  skillTags,
  skillTeamGrants,
  skillUserGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  users,
} from "../db/schema.js";

const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: false,
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
      filters.afterSlug ? sql`${skills.slug} collate "C" > ${filters.afterSlug}` : undefined,
      query
        ? or(
            ilike(skills.slug, `%${escapeLike(query)}%`),
            ilike(skills.title, `%${escapeLike(query)}%`),
            ilike(skills.summary, `%${escapeLike(query)}%`),
          )
        : undefined,
    );

    return this.visibleSkillRows(where, limit, filters.actorId ?? null, sharing);
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

  async getSkillVisibleToTeamBySlug(slug: string, teamId: string): Promise<PublicSkill | null> {
    const sharing = await this.getSharingSettings();
    const rows = await this.visibleSkillRows(and(
      eq(skills.slug, slug),
      visibleReleasedSkillPredicate(),
      visibleToTeamPredicate(teamId, sharing),
    ), 1, null, sharing);
    return rows[0] ?? null;
  }

  async getSkillVisibleToOrganizationBySlug(slug: string, organizationId: string): Promise<PublicSkill | null> {
    const sharing = await this.getSharingSettings();
    const rows = await this.visibleSkillRows(and(
      eq(skills.slug, slug),
      visibleReleasedSkillPredicate(),
      visibleToOrganizationPredicate(organizationId, sharing),
    ), 1, null, sharing);
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
    const requestedTeamIds = input.teamIds === undefined ? undefined : uniqueStrings(input.teamIds);
    const requestedUserEmails = input.userEmails === undefined
      ? undefined
      : uniqueStrings(input.userEmails.map(normalizeEmail));
    const requestedOrganizationIds = input.organizationIds === undefined
      ? undefined
      : uniqueStrings(input.organizationIds);

    await this.db.transaction(async (tx) => {
      // Serialize sharing updates with instance setting changes. This lock is
      // also required for organization-only updates; otherwise a concurrent
      // admin disable can race a grant replacement after the preflight read.
      const lockedSettings = await lockSharingSettings(tx);
      const [lockedSkill] = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.id, skill.id))
        .for("update")
        .limit(1);
      if (!lockedSkill) {
        throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
      }

      const currentTeamRows = await tx
        .select({ teamId: skillTeamGrants.teamId })
        .from(skillTeamGrants)
        .where(eq(skillTeamGrants.skillId, skill.id))
        .orderBy(skillTeamGrants.teamId)
        .for("update");
      const currentUserRows = await tx
        .select({ userId: skillUserGrants.userId })
        .from(skillUserGrants)
        .where(eq(skillUserGrants.skillId, skill.id))
        .orderBy(skillUserGrants.userId)
        .for("update");
      const currentOrganizationRows = await tx
        .select({ organizationId: skillOrganizationGrants.organizationId })
        .from(skillOrganizationGrants)
        .where(eq(skillOrganizationGrants.skillId, skill.id))
        .orderBy(skillOrganizationGrants.organizationId)
        .for("update");

      const teamIds = requestedTeamIds ?? currentTeamRows.map((row) => row.teamId);
      const organizationIds = requestedOrganizationIds ?? currentOrganizationRows.map((row) => row.organizationId);
      validateVisibilityEnabled(input.visibility, lockedSettings);
      if (requestedOrganizationIds !== undefined && organizationIds.length > 0 && !lockedSettings.organizationVisibilityEnabled) {
        throw new AppError("Organization sharing is disabled for this instance.", "ORGANIZATION_SHARING_DISABLED", 403);
      }
      if (input.visibility === "organization" && organizationIds.length === 0) {
        throw new AppError("At least one organization grant is required.", "ORGANIZATION_GRANT_REQUIRED", 400);
      }
      if (requestedTeamIds !== undefined && teamIds.length > 0 && (!lockedSettings.teamsEnabled || !lockedSettings.teamVisibilityEnabled)) {
        throw new AppError("Team sharing is disabled for this instance.", "TEAM_SHARING_DISABLED", 403);
      }
      if (requestedUserEmails !== undefined && requestedUserEmails.length > 0 && !lockedSettings.userVisibilityEnabled) {
        throw new AppError("User sharing is disabled for this instance.", "USER_SHARING_DISABLED", 403);
      }
      if (input.visibility === "team" && teamIds.length === 0) {
        throw new AppError("At least one team grant is required.", "TEAM_GRANT_REQUIRED", 400);
      }
      const userGrantIds = requestedUserEmails === undefined
        ? currentUserRows.map((row) => row.userId)
        : requestedUserEmails.length > 0
          ? await this.resolveUserGrantIds(requestedUserEmails, tx)
          : [];
      if (input.visibility === "explicit-users" && userGrantIds.length === 0) {
        throw new AppError("At least one user grant is required.", "USER_GRANT_REQUIRED", 400);
      }

      if (requestedTeamIds !== undefined && teamIds.length > 0) {
        await assertCurrentTeamGrantAuthority(tx, input.actor.id, teamIds);
      }
      const organizationGrantContexts = requestedOrganizationIds !== undefined && organizationIds.length > 0
        ? await this.organizationGrantContexts(input.actor.id, organizationIds, tx)
        : [];

      await tx.update(skills).set({
        visibility: input.visibility,
        updatedAt: new Date(),
      }).where(eq(skills.id, skill.id));

      if (requestedTeamIds !== undefined) {
        await tx.delete(skillTeamGrants).where(eq(skillTeamGrants.skillId, skill.id));
        if (teamIds.length > 0) {
          await tx.insert(skillTeamGrants).values(teamIds.map((teamId) => ({
            skillId: skill.id,
            teamId,
          }))).onConflictDoNothing();
        }
      }

      if (requestedUserEmails !== undefined) {
        await tx.delete(skillUserGrants).where(eq(skillUserGrants.skillId, skill.id));
        if (userGrantIds.length > 0) {
          await tx.insert(skillUserGrants).values(userGrantIds.map((userId) => ({
            skillId: skill.id,
            userId,
          }))).onConflictDoNothing();
        }
      }

      if (requestedOrganizationIds !== undefined) {
        await tx.delete(skillOrganizationGrants).where(eq(skillOrganizationGrants.skillId, skill.id));
        if (organizationGrantContexts.length > 0) {
          await tx.insert(skillOrganizationGrants).values(organizationGrantContexts.map((organization) => ({
            skillId: skill.id,
            organizationId: organization.id,
            createdByUserId: input.actor.id,
            createdUnderPolicyRevisionId: organization.currentPolicyRevisionId,
          }))).onConflictDoNothing();
        }
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
          organizationGrantCount: organizationIds.length,
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
      .selectDistinctOn([sql`${skills.slug} collate "C"`], {
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
        hasTeamAccess: actorId && sharing.teamsEnabled && sharing.teamVisibilityEnabled
          ? effectiveTeamAccessPredicate(actorId)
          : sql<boolean>`false`,
        hasUserGrant: actorId && sharing.userVisibilityEnabled
          ? sql<boolean>`exists (
              select 1
              from ${skillUserGrants}
              where ${skillUserGrants.skillId} = ${skills.id}
                and ${skillUserGrants.userId} = ${actorId}
            )`
          : sql<boolean>`false`,
        hasOrganizationAccess: actorId && sharing.organizationVisibilityEnabled
          ? organizationVisibilityPredicateForActor(actorId)
          : sql<boolean>`false`,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
      .leftJoin(skillPlatformVariants, eq(skillPlatformVariants.skillVersionId, skillVersions.id))
      .leftJoin(skillTags, eq(skillTags.skillId, skills.id))
      .where(where)
      .groupBy(
        skills.id,
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
        skillVersions.id,
      )
      .orderBy(sql`${skills.slug} collate "C"`, sql`${skillVersions.createdAt} desc`, sql`${skillVersions.id} desc`)
      .limit(limit);

    return rows.map((row) => ({
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
          reasons: this.accessReasonsForSkill(row, actorId, sharing),
        }
        : undefined,
    }));
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
    const [settings, availableTeams, teamGrants, userGrants, availableOrganizations, organizationGrants] = await Promise.all([
      this.getSharingSettings(),
      this.teamsForUser(actor.id),
      this.teamGrantsForSkill(skill.id, actor.id),
      this.userGrantsForSkill(skill.id),
      this.organizationsForUser(actor.id),
      this.organizationGrantsForSkill(skill.id, actor.id),
    ]);
    return {
      slug: skill.slug,
      title: skill.title,
      visibility: skill.visibility,
      settings,
      availableTeams,
      teamGrants,
      userGrants,
      availableOrganizations,
      organizationGrants,
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
      .innerJoin(teamMemberships, and(
        eq(teamMemberships.teamId, teams.id),
        eq(teamMemberships.userId, actorId),
      ))
      .leftJoin(organizations, eq(organizations.id, teams.organizationId))
      .leftJoin(organizationPolicyRevisions, and(
        eq(organizationPolicyRevisions.organizationId, teams.organizationId),
        eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
      ))
      .leftJoin(organizationMemberships, and(
        eq(organizationMemberships.organizationId, teams.organizationId),
        eq(organizationMemberships.userId, actorId),
        isNull(organizationMemberships.removedAt),
      ))
      .where(and(
        eq(skillTeamGrants.skillId, skillId),
        effectiveTeamMembershipPredicate(actorId),
      ))
      .orderBy(teams.name);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role ?? "member",
    }));
  }

  private async organizationsForUser(userId: string): Promise<SkillSharingOrganizationSummary[]> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(and(
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.removedAt),
      ))
      .orderBy(organizations.name);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as OrganizationStatus,
      role: row.role as OrganizationMembershipRole,
    }));
  }

  private async organizationGrantsForSkill(skillId: string, actorId: string): Promise<SkillSharingOrganizationSummary[]> {
    const rows = await this.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        status: organizations.status,
        role: organizationMemberships.role,
      })
      .from(skillOrganizationGrants)
      .innerJoin(organizations, eq(organizations.id, skillOrganizationGrants.organizationId))
      .innerJoin(organizationMemberships, and(
        eq(organizationMemberships.organizationId, organizations.id),
        eq(organizationMemberships.userId, actorId),
        isNull(organizationMemberships.removedAt),
      ))
      .where(eq(skillOrganizationGrants.skillId, skillId))
      .orderBy(organizations.name);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status as OrganizationStatus,
      role: row.role as OrganizationMembershipRole,
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

  private async resolveUserGrantIds(
    userEmails: string[],
    db: SkillSharingDb = this.db,
  ): Promise<string[]> {
    const rows = await db
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

  private async organizationGrantContexts(
    actorId: string,
    organizationIds: string[],
    db: Pick<Database, "select"> = this.db,
  ): Promise<Array<{ id: string; currentPolicyRevisionId: string }>> {
    const rows = await db
      .select({
        id: organizations.id,
        status: organizations.status,
        currentPolicyRevisionId: organizations.currentPolicyRevisionId,
        policyRevisionId: organizationPolicyRevisions.id,
        policy: organizationPolicyRevisions.policy,
        membershipRole: organizationMemberships.role,
      })
      .from(organizations)
      .leftJoin(organizationPolicyRevisions, and(
        eq(organizationPolicyRevisions.organizationId, organizations.id),
        eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
      ))
      .leftJoin(organizationMemberships, and(
        eq(organizationMemberships.organizationId, organizations.id),
        eq(organizationMemberships.userId, actorId),
        isNull(organizationMemberships.removedAt),
      ))
      .where(inArray(organizations.id, organizationIds))
      .for("update", { of: organizations });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const contexts: Array<{ id: string; currentPolicyRevisionId: string }> = [];
    let targetLimit = Number.MAX_SAFE_INTEGER;
    for (const organizationId of organizationIds) {
      const row = byId.get(organizationId);
      const activeAuthorizedMember = Boolean(
        row &&
        row.status === "active" &&
        row.membershipRole &&
        ["owner", "admin", "member"].includes(row.membershipRole),
      );
      if (!row || !activeAuthorizedMember) {
        throw organizationGrantUnavailable();
      }
      if (!row.currentPolicyRevisionId || !row.policyRevisionId || !row.policy) {
        throw new AppError("Organization current policy is required for a skill grant.", "ORGANIZATION_POLICY_REQUIRED", 403);
      }
      let policy: OrganizationPolicyV1;
      try {
        policy = assertValidOrganizationPolicyV1(row.policy);
      } catch (error) {
        throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 500, error);
      }
      targetLimit = Math.min(targetLimit, policy.limits.organizationGrantsPerSkill);
      const decision = evaluateOrganizationShare({
        organizationId,
        organizationStatus: row.status as OrganizationStatus,
        policy,
        actor: {
          userId: actorId,
          memberships: row.membershipRole
            ? [{ organizationId, userId: actorId, role: row.membershipRole as OrganizationMembershipRole }]
            : [],
        },
        resource: "skill",
      });
      if (!decision.allowed) {
        const code = decision.reason === "not-member"
          ? "ORGANIZATION_MEMBERSHIP_REQUIRED"
          : decision.reason === "organization-inactive"
            ? "ORGANIZATION_INACTIVE"
            : "ORGANIZATION_SHARING_NOT_ALLOWED";
        throw new AppError("Organization policy does not allow this skill grant.", code, 403, {
          organizationId,
          reason: decision.reason,
        });
      }
      contexts.push({ id: organizationId, currentPolicyRevisionId: row.currentPolicyRevisionId });
    }
    if (organizationIds.length > targetLimit) {
      throw new AppError(
        "The organization skill grant limit has been reached.",
        "ORGANIZATION_SKILL_GRANT_LIMIT_EXCEEDED",
        409,
        { limit: targetLimit },
      );
    }
    return contexts;
  }

  private accessReasonsForSkill(
    row: {
      visibility: VisibilityScope;
      ownerUserId: string | null;
      hasTeamAccess: boolean;
      hasUserGrant: boolean;
      hasOrganizationAccess: boolean;
    },
    actorId: string,
    sharing: SharingSettings,
  ): SkillAccessReason[] {
    const reasons: SkillAccessReason[] = [];
    if (row.ownerUserId === actorId) {
      reasons.push("owner");
    }
    if (row.visibility === "public" && sharing.publicVisibilityEnabled) {
      reasons.push("public");
    }
    if (row.visibility === "authenticated" && sharing.authenticatedVisibilityEnabled) {
      reasons.push("authenticated");
    }
    if (row.visibility === "team" && sharing.teamsEnabled && sharing.teamVisibilityEnabled && row.hasTeamAccess) {
      reasons.push("team");
    }
    if (row.visibility === "organization" && sharing.organizationVisibilityEnabled && row.hasOrganizationAccess) {
      reasons.push("organization");
    }
    if (row.visibility === "explicit-users" && sharing.userVisibilityEnabled && row.hasUserGrant) {
      reasons.push("explicit-user");
    }
    return reasons;
  }
}

function organizationGrantUnavailable(): AppError {
  return new AppError("Organization grant is not available.", "ORGANIZATION_GRANT_NOT_AVAILABLE", 403);
}

type SkillSharingDb = Pick<Database, "select">;

/**
 * Recheck the complete requested team grant set while the replacement
 * transaction owns the relevant aggregate locks. The preflight
 * `teamsForUser` query is intentionally not authoritative: a membership can
 * be removed after that query returns. Team rows are locked before their
 * parent organizations, matching team mutation lock order, and the team scope
 * is compared with the pre-lock snapshot so a concurrent adoption cannot turn
 * a standalone grant into an organization grant under this request.
 */
async function assertCurrentTeamGrantAuthority(
  db: SkillSharingDb,
  actorId: string,
  teamIds: string[],
): Promise<void> {
  const sortedTeamIds = [...teamIds].sort();
  const hints = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(inArray(teams.id, sortedTeamIds))
    .orderBy(teams.id);
  if (hints.length !== sortedTeamIds.length) {
    throw teamGrantUnavailable();
  }

  const lockedTeams = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(inArray(teams.id, sortedTeamIds))
    .orderBy(teams.id)
    .for("update");
  if (lockedTeams.length !== sortedTeamIds.length) {
    throw teamGrantUnavailable();
  }
  const hintById = new Map(hints.map((team) => [team.id, team]));
  const teamById = new Map(lockedTeams.map((team) => [team.id, team]));
  for (const teamId of sortedTeamIds) {
    if (teamById.get(teamId)?.organizationId !== hintById.get(teamId)?.organizationId) {
      throw teamGrantUnavailable();
    }
  }

  const hintedOrganizationIds = [...new Set(
    lockedTeams
      .map((team) => team.organizationId)
      .filter((organizationId): organizationId is string => organizationId !== null),
  )].sort();
  const lockedOrganizations = hintedOrganizationIds.length > 0
    ? await db
      .select({
        id: organizations.id,
        status: organizations.status,
        currentPolicyRevisionId: organizations.currentPolicyRevisionId,
      })
      .from(organizations)
      .where(inArray(organizations.id, hintedOrganizationIds))
      .orderBy(organizations.id)
      .for("update")
    : [];
  const organizationById = new Map(lockedOrganizations.map((organization) => [organization.id, organization]));

  const currentOrganizationIds = [...new Set(
    lockedTeams
      .map((team) => team.organizationId)
      .filter((organizationId): organizationId is string => organizationId !== null),
  )].sort();
  const currentPolicyRevisionIds = lockedTeams
    .map((team) => team.organizationId ? organizationById.get(team.organizationId)?.currentPolicyRevisionId : null)
    .filter((revisionId): revisionId is string => revisionId !== null);
  const policyRows = currentPolicyRevisionIds.length > 0
    ? await db
      .select({ id: organizationPolicyRevisions.id, organizationId: organizationPolicyRevisions.organizationId, policy: organizationPolicyRevisions.policy })
      .from(organizationPolicyRevisions)
      .where(inArray(organizationPolicyRevisions.id, currentPolicyRevisionIds))
      .orderBy(organizationPolicyRevisions.id)
      .for("update")
    : [];
  const policyByOrganizationId = new Map(
    policyRows.map((row) => [row.organizationId, row]),
  );

  const organizationMembershipRows = currentOrganizationIds.length > 0
    ? await db
      .select({
        id: organizationMemberships.id,
        organizationId: organizationMemberships.organizationId,
        removedAt: organizationMemberships.removedAt,
      })
      .from(organizationMemberships)
      .where(and(
        inArray(organizationMemberships.organizationId, currentOrganizationIds),
        eq(organizationMemberships.userId, actorId),
      ))
      .orderBy(organizationMemberships.organizationId)
      .for("update")
    : [];
  const organizationMembershipById = new Map(
    organizationMembershipRows.map((membership) => [membership.organizationId, membership]),
  );

  const teamMembershipRows = await db
    .select({ id: teamMemberships.id, teamId: teamMemberships.teamId })
    .from(teamMemberships)
    .where(and(
      inArray(teamMemberships.teamId, sortedTeamIds),
      eq(teamMemberships.userId, actorId),
    ))
    .orderBy(teamMemberships.teamId)
    .for("update");
  const teamMembershipById = new Map(teamMembershipRows.map((membership) => [membership.teamId, membership]));

  for (const teamId of sortedTeamIds) {
    const team = teamById.get(teamId);
    if (!team || !teamMembershipById.has(teamId)) {
      throw teamGrantUnavailable();
    }
    if (team.organizationId === null) continue;

    const organization = organizationById.get(team.organizationId);
    const policyRow = policyByOrganizationId.get(team.organizationId);
    const organizationMembership = organizationMembershipById.get(team.organizationId);
    if (!organization
      || organization.status !== "active"
      || !organization.currentPolicyRevisionId
      || !policyRow
      || policyRow.id !== organization.currentPolicyRevisionId) {
      throw teamGrantUnavailable();
    }
    let policy: OrganizationPolicyV1;
    try {
      policy = assertValidOrganizationPolicyV1(policyRow.policy);
    } catch {
      throw teamGrantUnavailable();
    }
    if (policy.teams.requireOrganizationMembershipForTeamMembers
      && organizationMembership?.removedAt !== null) {
      throw teamGrantUnavailable();
    }
  }
}

async function lockSharingSettings(db: SkillSharingDb): Promise<SharingSettings> {
  const [setting] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "sharing"))
    .for("update")
    .limit(1);
  return parseSharingSettings(setting?.value);
}

function teamGrantUnavailable(): AppError {
  return new AppError("Team grant is not available to this user.", "TEAM_GRANT_NOT_AVAILABLE", 403);
}

function visibleReleasedSkillPredicate(): SQL | undefined {
  return and(
    inArray(skills.lifecycleStatus, ["approved", "deprecated"]),
    inArray(skillVersions.lifecycleStatus, ["approved", "deprecated"]),
    eq(skillVersions.reviewStatus, "approved"),
    eq(skillVersions.securityStatus, "passed"),
    isNotNull(skillVersions.publishedAt),
    isNull(skillVersions.deletedAt),
  );
}

/**
 * Organization-owned team access is derived from the current relational
 * context and current policy on every read. Standalone teams retain the
 * pre-tenancy behavior.
 */
function effectiveTeamMembershipPredicate(actorId: string): SQL<boolean> {
  return sql<boolean>`(
    ${teams.organizationId} is null
    or (
      ${teams.organizationId} is not null
      and ${organizations.status} = 'active'
      and ${organizations.currentPolicyRevisionId} is not null
      and ${organizationPolicyRevisions.id} is not null
      and (
        coalesce(${organizationPolicyRevisions.policy}->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false'
        or (
          ${organizationMemberships.id} is not null
          and ${organizationMemberships.userId} = ${actorId}
          and ${organizationMemberships.removedAt} is null
        )
      )
    )
  )`;
}

function effectiveTeamAccessPredicate(actorId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${skillTeamGrants} as stg
    inner join ${teamMemberships} as tm on tm.team_id = stg.team_id
    inner join ${teams} as team on team.id = stg.team_id
    left join ${organizations} as org on org.id = team.organization_id
    left join ${organizationPolicyRevisions} as opr
      on opr.organization_id = team.organization_id
      and opr.id = org.current_policy_revision_id
    left join ${organizationMemberships} as om
      on om.organization_id = team.organization_id
      and om.user_id = ${actorId}
      and om.removed_at is null
    where stg.skill_id = ${skills.id}
      and tm.user_id = ${actorId}
      and (
        team.organization_id is null
        or (
          org.status = 'active'
          and org.current_policy_revision_id is not null
          and opr.id is not null
          and (
            coalesce(opr.policy->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false'
            or om.id is not null
          )
        )
      )
  )`;
}

function visibleToActorPredicate(actorId: string | null, sharing: SharingSettings): SQL | undefined {
  const predicates: Array<SQL | undefined> = [
    sharing.publicVisibilityEnabled ? eq(skills.visibility, "public") : undefined,
  ];
  if (actorId) {
    predicates.push(eq(skills.ownerUserId, actorId));
    if (sharing.authenticatedVisibilityEnabled) {
      predicates.push(eq(skills.visibility, "authenticated"));
    }
    if (sharing.teamsEnabled && sharing.teamVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "team"),
        effectiveTeamAccessPredicate(actorId),
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
    if (sharing.organizationVisibilityEnabled) {
      predicates.push(and(
        eq(skills.visibility, "organization"),
        organizationVisibilityPredicateForActor(actorId),
      ));
    }
  }
  const active = predicates.filter((predicate): predicate is SQL => Boolean(predicate));
  return active.length > 0 ? or(...active) : sql`false`;
}

function visibleToTeamPredicate(teamId: string, sharing: SharingSettings): SQL | undefined {
  const predicates: Array<SQL | undefined> = [
    sharing.publicVisibilityEnabled ? eq(skills.visibility, "public") : undefined,
    sharing.authenticatedVisibilityEnabled ? eq(skills.visibility, "authenticated") : undefined,
    sharing.teamsEnabled && sharing.teamVisibilityEnabled
      ? and(
          eq(skills.visibility, "team"),
          sql`exists (
            select 1
            from ${skillTeamGrants} as stg
            inner join ${teams} as team on team.id = stg.team_id
            left join ${organizations} as org on org.id = team.organization_id
            left join ${organizationPolicyRevisions} as opr
              on opr.organization_id = team.organization_id
              and opr.id = org.current_policy_revision_id
            where stg.skill_id = ${skills.id}
              and stg.team_id = ${teamId}
              and (
                team.organization_id is null
                or (
                  org.status = 'active'
                  and org.current_policy_revision_id is not null
                  and opr.id is not null
                )
              )
          )`,
        )
      : undefined,
  ];
  const active = predicates.filter((predicate): predicate is SQL => Boolean(predicate));
  return active.length > 0 ? or(...active) : sql`false`;
}

function visibleToOrganizationPredicate(organizationId: string, sharing: SharingSettings): SQL | undefined {
  const predicates: Array<SQL | undefined> = [
    sharing.publicVisibilityEnabled ? eq(skills.visibility, "public") : undefined,
    sharing.authenticatedVisibilityEnabled ? eq(skills.visibility, "authenticated") : undefined,
    sharing.organizationVisibilityEnabled
      ? and(
          eq(skills.visibility, "organization"),
          organizationVisibilityPredicateForOrganization(organizationId),
        )
      : undefined,
  ];
  const active = predicates.filter((predicate): predicate is SQL => Boolean(predicate));
  return active.length > 0 ? or(...active) : sql`false`;
}

function organizationVisibilityPredicateForActor(actorId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${skillOrganizationGrants} as sog
    inner join ${organizations} as org on org.id = sog.organization_id
    inner join ${organizationPolicyRevisions} as opr
      on opr.organization_id = org.id
      and opr.id = org.current_policy_revision_id
    inner join ${organizationMemberships} as om
      on om.organization_id = org.id
      and om.user_id = ${actorId}
      and om.removed_at is null
    where sog.skill_id = ${skills.id}
      and sog.created_under_policy_revision_id = org.current_policy_revision_id
      and org.status = 'active'
      and opr.policy->'sharing'->>'organizationSkillSharingEnabled' = 'true'
  )`;
}

function organizationVisibilityPredicateForOrganization(organizationId: string): SQL<boolean> {
  return sql<boolean>`exists (
    select 1
    from ${skillOrganizationGrants} as sog
    inner join ${organizations} as org on org.id = sog.organization_id
    inner join ${organizationPolicyRevisions} as opr
      on opr.organization_id = org.id
      and opr.id = org.current_policy_revision_id
    where sog.skill_id = ${skills.id}
      and sog.organization_id = ${organizationId}
      and org.id = ${organizationId}
      and sog.created_under_policy_revision_id = org.current_policy_revision_id
      and org.status = 'active'
      and opr.policy->'sharing'->>'organizationSkillSharingEnabled' = 'true'
  )`;
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
    organizationVisibilityEnabled: typeof record.organizationVisibilityEnabled === "boolean"
      ? record.organizationVisibilityEnabled
      : false,
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
  if (visibility === "organization") {
    if (!settings.organizationVisibilityEnabled) {
      throw new AppError("Organization sharing is disabled for this instance.", "ORGANIZATION_SHARING_DISABLED", 403);
    }
  }
  if (visibility === "public" && !settings.publicVisibilityEnabled) {
    throw new AppError("Public sharing is disabled for this instance.", "PUBLIC_SHARING_DISABLED", 403);
  }
  if (visibility === "authenticated" && !settings.authenticatedVisibilityEnabled) {
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
