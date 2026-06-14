import { AppError, type PublicSkill, type SharingSettings, type SkillRepository, type SkillSearchFilters, type SkillSharingActor, type SkillSharingDetails, type SkillSharingTeamSummary, type SkillSharingUserSummary, type TeamSharedSkillGroup, type UpdateSkillSharingInput } from "@myskills-app/core";

interface MemorySkill extends PublicSkill {
  ownerUserId?: string | null;
}

const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
};

export class MemorySkillRepository implements SkillRepository {
  private sharingSettings: SharingSettings = DEFAULT_SHARING_SETTINGS;
  private teamMemberships = new Map<string, SkillSharingTeamSummary[]>();
  private teamGrants = new Map<string, string[]>();
  private userGrants = new Map<string, SkillSharingUserSummary[]>();

  constructor(private readonly skills: MemorySkill[]) {}

  addTeamMembership(userId: string, team: SkillSharingTeamSummary): void {
    const teams = this.teamMemberships.get(userId) ?? [];
    this.teamMemberships.set(userId, [...teams.filter((item) => item.id !== team.id), team]);
  }

  addKnownUserGrant(slug: string, user: SkillSharingUserSummary): void {
    const users = this.userGrants.get(slug) ?? [];
    this.userGrants.set(slug, [...users.filter((item) => item.id !== user.id), user]);
  }

  addTeamGrant(slug: string, teamId: string): void {
    const teamIds = this.teamGrants.get(slug) ?? [];
    this.teamGrants.set(slug, [...new Set([...teamIds, teamId])]);
  }

  async searchVisibleSkills(filters: SkillSearchFilters = {}): Promise<PublicSkill[]> {
    const query = filters.query?.trim().toLowerCase() ?? "";
    const limit = filters.limit ?? 50;
    return this.skills
      .filter((skill) => this.isVisibleReleasedSkill(skill, filters.actorId ?? null))
      .filter((skill) => !query || [
        skill.slug,
        skill.title,
        skill.summary,
        skill.latestVersion ?? "",
        ...skill.tags,
        ...skill.platforms.map((platform) => platform.name),
      ].some((value) => value.toLowerCase().includes(query)))
      .map((skill) => this.publicSkill(skill, filters.actorId ?? null))
      .slice(0, limit);
  }

  async getVisibleSkillBySlug(slug: string, actorId?: string | null): Promise<PublicSkill | null> {
    const skill = this.skills.find((candidate) => (
      candidate.slug === slug &&
      this.isVisibleReleasedSkill(candidate, actorId ?? null)
    ));
    return skill ? this.publicSkill(skill, actorId ?? null) : null;
  }

  async getSharingSettings(): Promise<SharingSettings> {
    return this.sharingSettings;
  }

  async updateSharingSettings(actor: SkillSharingActor, settings: SharingSettings): Promise<SharingSettings> {
    if (!actor.roles.includes("owner")) {
      throw new AppError("Owner access is required.", "OWNER_ROLE_REQUIRED", 403);
    }
    this.sharingSettings = { ...settings };
    return this.sharingSettings;
  }

  async getSkillSharing(slug: string, actor: SkillSharingActor): Promise<SkillSharingDetails> {
    const skill = this.findManagedSkill(slug, actor);
    return this.sharingDetails(skill, actor);
  }

  async updateSkillSharing(input: UpdateSkillSharingInput): Promise<SkillSharingDetails> {
    const skill = this.findManagedSkill(input.slug, input.actor);
    validateVisibilityEnabled(input.visibility, this.sharingSettings);
    skill.visibility = input.visibility;
    this.teamGrants.set(input.slug, uniqueStrings(input.teamIds));
    const grantedUsers = input.userEmails.map((email, index) => ({
      id: `user-grant-${index + 1}`,
      email: normalizeEmail(email),
      name: "",
    }));
    this.userGrants.set(input.slug, grantedUsers);
    return this.sharingDetails(skill, input.actor);
  }

  async listTeamSkillGroups(actor: SkillSharingActor): Promise<TeamSharedSkillGroup[]> {
    if (!this.sharingSettings.teamsEnabled || !this.sharingSettings.teamVisibilityEnabled) {
      return [];
    }
    return (this.teamMemberships.get(actor.id) ?? []).map((team) => ({
      team,
      sharingWithTeam: this.skills
        .filter((skill) => (
          skill.ownerUserId === actor.id &&
          skill.visibility === "team" &&
          (this.teamGrants.get(skill.slug) ?? []).includes(team.id) &&
          this.isVisibleReleasedSkill(skill, actor.id)
        ))
        .map((skill) => this.publicSkill(skill, actor.id)),
      sharedWithMe: this.skills
        .filter((skill) => (
          skill.ownerUserId !== actor.id &&
          skill.visibility === "team" &&
          (this.teamGrants.get(skill.slug) ?? []).includes(team.id) &&
          this.isVisibleReleasedSkill(skill, actor.id)
        ))
        .map((skill) => this.publicSkill(skill, actor.id)),
    }));
  }

  private isVisibleReleasedSkill(skill: MemorySkill, actorId: string | null): boolean {
    const released = (
      skill.lifecycleStatus === "approved" &&
      skill.reviewStatus === "approved" &&
      skill.securityStatus === "passed" &&
      Boolean(skill.latestVersion)
    );
    if (!released) {
      return false;
    }
    if (actorId && skill.ownerUserId === actorId) {
      return true;
    }
    if (skill.visibility === "public") {
      return this.sharingSettings.publicVisibilityEnabled;
    }
    if (!actorId) {
      return false;
    }
    if ((skill.visibility === "authenticated" || skill.visibility === "organization") && this.sharingSettings.authenticatedVisibilityEnabled) {
      return true;
    }
    if (skill.visibility === "team" && this.sharingSettings.teamsEnabled && this.sharingSettings.teamVisibilityEnabled) {
      const userTeamIds = new Set((this.teamMemberships.get(actorId) ?? []).map((team) => team.id));
      return (this.teamGrants.get(skill.slug) ?? []).some((teamId) => userTeamIds.has(teamId));
    }
    if (skill.visibility === "explicit-users" && this.sharingSettings.userVisibilityEnabled) {
      return (this.userGrants.get(skill.slug) ?? []).some((user) => user.id === actorId);
    }
    return false;
  }

  private publicSkill(skill: MemorySkill, actorId: string | null): PublicSkill {
    return {
      ...skill,
      access: actorId
        ? {
          canManageSharing: skill.ownerUserId === actorId,
          reasons: [
            ...(skill.ownerUserId === actorId ? ["owner" as const] : []),
            ...(skill.visibility === "public" ? ["public" as const] : []),
            ...(skill.visibility === "authenticated" || skill.visibility === "organization" ? ["authenticated" as const] : []),
            ...(skill.visibility === "team" ? ["team" as const] : []),
            ...(skill.visibility === "explicit-users" ? ["explicit-user" as const] : []),
          ],
        }
        : undefined,
    };
  }

  private findManagedSkill(slug: string, actor: SkillSharingActor): MemorySkill {
    const skill = this.skills.find((item) => item.slug === slug);
    if (!skill) {
      throw new AppError("Skill not found.", "SKILL_NOT_FOUND", 404);
    }
    if (skill.ownerUserId !== actor.id && !actor.roles.includes("owner") && !actor.roles.includes("admin")) {
      throw new AppError("Skill owner access is required.", "SKILL_OWNER_REQUIRED", 403);
    }
    return skill;
  }

  private sharingDetails(skill: MemorySkill, actor: SkillSharingActor): SkillSharingDetails {
    const availableTeams = this.teamMemberships.get(actor.id) ?? [];
    return {
      slug: skill.slug,
      title: skill.title,
      visibility: skill.visibility,
      settings: this.sharingSettings,
      availableTeams,
      teamGrants: availableTeams.filter((team) => (this.teamGrants.get(skill.slug) ?? []).includes(team.id)),
      userGrants: this.userGrants.get(skill.slug) ?? [],
    };
  }
}

function validateVisibilityEnabled(visibility: PublicSkill["visibility"], settings: SharingSettings): void {
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
