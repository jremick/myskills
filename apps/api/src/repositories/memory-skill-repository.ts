import {
  AppError,
  assertValidOrganizationPolicyV1,
  defaultOrganizationPolicyV1,
  evaluateOrganizationShare,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
  type PublicSkill,
  type SharingSettings,
  type SkillRepository,
  type SkillSearchFilters,
  type SkillSharingActor,
  type SkillSharingDetails,
  type SkillSharingOrganizationSummary,
  type SkillSharingTeamSummary,
  type SkillSharingUserSummary,
  type TeamSharedSkillGroup,
  type UpdateSkillSharingInput,
} from "@myskills-app/core";
import { isEffectiveTeamMembership } from "../teams/effective-membership.js";

interface MemorySkill extends PublicSkill {
  ownerUserId?: string | null;
}

const DEFAULT_SHARING_SETTINGS: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: false,
};

interface MemoryOrganization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  currentPolicyRevisionId: string | null;
  policy: OrganizationPolicyV1;
}

interface MemoryOrganizationMembership {
  organizationId: string;
  role: OrganizationMembershipRole;
  removedAt: string | null;
}

interface MemoryTeamMembership extends SkillSharingTeamSummary {
  organizationId: string | null;
}

export class MemorySkillRepository implements SkillRepository {
  private sharingSettings: SharingSettings = DEFAULT_SHARING_SETTINGS;
  private teamMemberships = new Map<string, MemoryTeamMembership[]>();
  private teamOrganizations = new Map<string, string | null>();
  private teamGrants = new Map<string, string[]>();
  private userGrants = new Map<string, SkillSharingUserSummary[]>();
  private organizations = new Map<string, MemoryOrganization>();
  private organizationMemberships = new Map<string, MemoryOrganizationMembership[]>();
  private organizationGrants = new Map<string, Map<string, string>>();

  constructor(private readonly skills: MemorySkill[]) {}

  addTeamMembership(userId: string, team: SkillSharingTeamSummary & { organizationId?: string | null }): void {
    const organizationId = team.organizationId ?? this.teamOrganizations.get(team.id) ?? null;
    this.teamOrganizations.set(team.id, organizationId);
    const teams = this.teamMemberships.get(userId) ?? [];
    this.teamMemberships.set(userId, [
      ...teams.filter((item) => item.id !== team.id),
      { ...team, organizationId },
    ]);
  }

  removeTeamMembership(userId: string, teamId: string): void {
    const teams = this.teamMemberships.get(userId) ?? [];
    this.teamMemberships.set(userId, teams.filter((team) => team.id !== teamId));
  }

  addTeam(input: { id: string; organizationId?: string | null }): void {
    this.teamOrganizations.set(input.id, input.organizationId ?? null);
  }

  addKnownUserGrant(slug: string, user: SkillSharingUserSummary): void {
    const users = this.userGrants.get(slug) ?? [];
    this.userGrants.set(slug, [...users.filter((item) => item.id !== user.id), user]);
  }

  addTeamGrant(slug: string, teamId: string): void {
    const teamIds = this.teamGrants.get(slug) ?? [];
    this.teamGrants.set(slug, [...new Set([...teamIds, teamId])]);
  }

  addOrganization(input: {
    id: string;
    name: string;
    slug?: string;
    status?: OrganizationStatus;
    policy?: OrganizationPolicyV1;
    currentPolicyRevisionId?: string | null;
  }): void {
    this.organizations.set(input.id, {
      id: input.id,
      name: input.name,
      slug: input.slug ?? slugify(input.name),
      status: input.status ?? "active",
      currentPolicyRevisionId: input.currentPolicyRevisionId === undefined
        ? `${input.id}:policy:1`
        : input.currentPolicyRevisionId,
      policy: assertValidOrganizationPolicyV1(input.policy ?? defaultOrganizationPolicyV1),
    });
  }

  addOrganizationMembership(
    userId: string,
    organization: SkillSharingOrganizationSummary | {
      id: string;
      name: string;
      slug?: string;
      status?: OrganizationStatus;
      role: OrganizationMembershipRole;
      removedAt?: string | null;
    },
  ): void;
  addOrganizationMembership(
    userId: string,
    organizationId: string,
    role: OrganizationMembershipRole,
    options?: { removedAt?: string | null },
  ): void;
  addOrganizationMembership(
    userId: string,
    organizationOrId: SkillSharingOrganizationSummary | {
      id: string;
      name: string;
      slug?: string;
      status?: OrganizationStatus;
      role: OrganizationMembershipRole;
      removedAt?: string | null;
    } | string,
    role?: OrganizationMembershipRole,
    options: { removedAt?: string | null } = {},
  ): void {
    const organizationId = typeof organizationOrId === "string" ? organizationOrId : organizationOrId.id;
    const membershipRole = typeof organizationOrId === "string" ? role : organizationOrId.role;
    if (!membershipRole) {
      throw new AppError("Organization membership role is required.", "ORGANIZATION_MEMBERSHIP_ROLE_REQUIRED", 400);
    }
    if (typeof organizationOrId !== "string" && !this.organizations.has(organizationId)) {
      this.addOrganization(organizationOrId);
    }
    const memberships = this.organizationMemberships.get(userId) ?? [];
    this.organizationMemberships.set(userId, [
      ...memberships.filter((membership) => membership.organizationId !== organizationId),
      {
        organizationId,
        role: membershipRole,
        removedAt: typeof organizationOrId === "string"
          ? options.removedAt ?? null
          : "removedAt" in organizationOrId ? organizationOrId.removedAt ?? null : null,
      },
    ]);
  }

  removeOrganizationMembership(userId: string, organizationId: string): void {
    const memberships = this.organizationMemberships.get(userId) ?? [];
    this.organizationMemberships.set(
      userId,
      memberships.map((membership) => membership.organizationId === organizationId
        ? { ...membership, removedAt: new Date().toISOString() }
        : membership),
    );
  }

  setOrganizationStatus(organizationId: string, status: OrganizationStatus): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    organization.status = status;
  }

  setOrganizationPolicy(
    organizationId: string,
    policy: OrganizationPolicyV1,
    currentPolicyRevisionId = `${organizationId}:policy:${Date.now()}`,
  ): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) {
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    organization.policy = assertValidOrganizationPolicyV1(policy);
    organization.currentPolicyRevisionId = currentPolicyRevisionId;
  }

  addOrganizationGrant(slug: string, organizationId: string, policyRevisionId?: string | null): void {
    const organization = this.organizations.get(organizationId);
    if (!organization) {
      throw new AppError("Organization not found.", "ORGANIZATION_NOT_FOUND", 404);
    }
    const grants = this.organizationGrants.get(slug) ?? new Map<string, string>();
    const revisionId = policyRevisionId ?? organization.currentPolicyRevisionId;
    if (!revisionId) {
      throw new AppError("Organization current policy is required.", "ORGANIZATION_POLICY_REQUIRED", 403);
    }
    grants.set(organizationId, revisionId);
    this.organizationGrants.set(slug, grants);
  }

  async searchVisibleSkills(filters: SkillSearchFilters = {}): Promise<PublicSkill[]> {
    const query = filters.query?.trim().toLowerCase() ?? "";
    const limit = filters.limit ?? 50;
    const matches = this.skills
      .filter((skill) => this.isVisibleReleasedSkill(skill, filters.actorId ?? null))
      .filter((skill) => !filters.afterSlug || skill.slug > filters.afterSlug)
      .filter((skill) => !query || [
        skill.slug,
        skill.title,
        skill.summary,
      ].some((value) => value.toLowerCase().includes(query)))
      .sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
    return matches
      .filter((skill, index) => index === 0 || skill.slug !== matches[index - 1]!.slug)
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

  async getSkillVisibleToTeamBySlug(slug: string, teamId: string): Promise<PublicSkill | null> {
    const skill = this.skills.find((candidate) => (
      candidate.slug === slug &&
      this.isVisibleReleasedSkillToTeam(candidate, teamId)
    ));
    return skill ? this.publicSkill(skill, null) : null;
  }

  async getSkillVisibleToOrganizationBySlug(slug: string, organizationId: string): Promise<PublicSkill | null> {
    const skill = this.skills.find((candidate) => (
      candidate.slug === slug &&
      this.isVisibleReleasedSkillToOrganization(candidate, organizationId)
    ));
    return skill ? this.publicSkill(skill, null) : null;
  }

  async getSharingSettings(): Promise<SharingSettings> {
    return this.sharingSettings;
  }

  async updateSharingSettings(actor: SkillSharingActor, settings: SharingSettings): Promise<SharingSettings> {
    if (!actor.roles.includes("owner")) {
      throw new AppError("Owner access is required.", "OWNER_ROLE_REQUIRED", 403);
    }
    this.sharingSettings = {
      ...settings,
      organizationVisibilityEnabled: settings.organizationVisibilityEnabled ?? false,
    };
    return this.sharingSettings;
  }

  async getSkillSharing(slug: string, actor: SkillSharingActor): Promise<SkillSharingDetails> {
    const skill = this.findManagedSkill(slug, actor);
    return this.sharingDetails(skill, actor);
  }

  async updateSkillSharing(input: UpdateSkillSharingInput): Promise<SkillSharingDetails> {
    const skill = this.findManagedSkill(input.slug, input.actor);
    validateVisibilityEnabled(input.visibility, this.sharingSettings);
    const currentTeamIds = this.teamGrants.get(input.slug) ?? [];
    const currentOrganizationGrants = this.organizationGrants.get(input.slug) ?? new Map<string, string>();
    const teamIds = input.teamIds === undefined ? [...currentTeamIds] : uniqueStrings(input.teamIds);
    const organizationIds = input.organizationIds === undefined
      ? [...currentOrganizationGrants.keys()]
      : uniqueStrings(input.organizationIds);
    if (input.organizationIds !== undefined && organizationIds.length > 0 && !this.sharingSettings.organizationVisibilityEnabled) {
      throw new AppError("Organization sharing is disabled for this instance.", "ORGANIZATION_SHARING_DISABLED", 403);
    }
    if (input.visibility === "organization" && organizationIds.length === 0) {
      throw new AppError("At least one organization grant is required.", "ORGANIZATION_GRANT_REQUIRED", 400);
    }
    const organizationGrantRevisions = input.organizationIds === undefined
      ? new Map(currentOrganizationGrants)
      : this.validateOrganizationGrants(input.actor.id, organizationIds);
    skill.visibility = input.visibility;
    if (input.teamIds !== undefined) {
      this.teamGrants.set(input.slug, teamIds);
    }
    if (input.userEmails !== undefined) {
      const grantedUsers = input.userEmails.map((email, index) => ({
        id: `user-grant-${index + 1}`,
        email: normalizeEmail(email),
        name: "",
      }));
      this.userGrants.set(input.slug, grantedUsers);
    }
    if (input.organizationIds !== undefined) {
      this.organizationGrants.set(input.slug, organizationGrantRevisions);
    }
    return this.sharingDetails(skill, input.actor);
  }

  async listTeamSkillGroups(actor: SkillSharingActor): Promise<TeamSharedSkillGroup[]> {
    if (!this.sharingSettings.teamsEnabled || !this.sharingSettings.teamVisibilityEnabled) {
      return [];
    }
    return (this.teamMemberships.get(actor.id) ?? [])
      .filter((team) => this.isEffectiveTeamMembership(actor.id, team))
      .map((team) => ({
      team: {
        id: team.id,
        name: team.name,
        role: team.role,
      },
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
    if (!this.isReleasedSkill(skill)) {
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
    if (skill.visibility === "authenticated" && this.sharingSettings.authenticatedVisibilityEnabled) {
      return true;
    }
    if (skill.visibility === "team" && this.sharingSettings.teamsEnabled && this.sharingSettings.teamVisibilityEnabled) {
      return (this.teamGrants.get(skill.slug) ?? []).some((teamId) => (
        (this.teamMemberships.get(actorId) ?? []).some((team) => (
          team.id === teamId && this.isEffectiveTeamMembership(actorId, team)
        ))
      ));
    }
    if (skill.visibility === "organization" && this.sharingSettings.organizationVisibilityEnabled) {
      return this.organizationIdsForUser(actorId).some((organizationId) => (
        this.isVisibleReleasedSkillToOrganization(skill, organizationId)
      ));
    }
    if (skill.visibility === "explicit-users" && this.sharingSettings.userVisibilityEnabled) {
      return (this.userGrants.get(skill.slug) ?? []).some((user) => user.id === actorId);
    }
    return false;
  }

  private isVisibleReleasedSkillToTeam(skill: MemorySkill, teamId: string): boolean {
    if (!this.isReleasedSkill(skill)) {
      return false;
    }
    if (skill.visibility === "public") {
      return this.sharingSettings.publicVisibilityEnabled;
    }
    if (skill.visibility === "authenticated") {
      return this.sharingSettings.authenticatedVisibilityEnabled;
    }
    return skill.visibility === "team" &&
      this.sharingSettings.teamsEnabled &&
      this.sharingSettings.teamVisibilityEnabled &&
      (this.teamGrants.get(skill.slug) ?? []).includes(teamId) &&
      this.isEffectiveTeamContext(teamId);
  }

  private isVisibleReleasedSkillToOrganization(skill: MemorySkill, organizationId: string): boolean {
    if (!this.isReleasedSkill(skill)) {
      return false;
    }
    if (skill.visibility === "public") {
      return this.sharingSettings.publicVisibilityEnabled;
    }
    if (skill.visibility === "authenticated") {
      return this.sharingSettings.authenticatedVisibilityEnabled;
    }
    if (skill.visibility !== "organization" || !this.sharingSettings.organizationVisibilityEnabled) {
      return false;
    }
    const organization = this.organizations.get(organizationId);
    return Boolean(
      organization &&
      organization.status === "active" &&
      this.hasCurrentOrganizationPolicy(organization) &&
      organization.policy.sharing.organizationSkillSharingEnabled &&
      this.organizationGrants.get(skill.slug)?.get(organizationId) === organization.currentPolicyRevisionId,
    );
  }

  private isReleasedSkill(skill: MemorySkill): boolean {
    return (
      skill.lifecycleStatus === "approved" &&
      skill.reviewStatus === "approved" &&
      skill.securityStatus === "passed" &&
      Boolean(skill.latestVersion)
    );
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
            ...(skill.visibility === "authenticated" ? ["authenticated" as const] : []),
            ...(skill.visibility === "team" ? ["team" as const] : []),
            ...(skill.visibility === "organization" && actorId && this.sharingSettings.organizationVisibilityEnabled &&
              this.organizationIdsForUser(actorId).some((organizationId) => this.isVisibleReleasedSkillToOrganization(skill, organizationId))
              ? ["organization" as const]
              : []),
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
    const availableTeams = (this.teamMemberships.get(actor.id) ?? [])
      .filter((team) => this.isEffectiveTeamMembership(actor.id, team));
    return {
      slug: skill.slug,
      title: skill.title,
      visibility: skill.visibility,
      settings: this.sharingSettings,
      availableTeams: availableTeams.map((team) => ({
        id: team.id,
        name: team.name,
        role: team.role,
      })),
      teamGrants: availableTeams
        .filter((team) => (this.teamGrants.get(skill.slug) ?? []).includes(team.id))
        .map((team) => ({
          id: team.id,
          name: team.name,
          role: team.role,
        })),
      userGrants: this.userGrants.get(skill.slug) ?? [],
      availableOrganizations: this.organizationsForUser(actor.id),
      organizationGrants: this.organizationsForUser(actor.id)
        .filter((organization) => this.organizationGrants.get(skill.slug)?.has(organization.id)),
    };
  }

  private organizationsForUser(userId: string): SkillSharingOrganizationSummary[] {
    return (this.organizationMemberships.get(userId) ?? [])
      .map((membership) => {
        const organization = this.organizations.get(membership.organizationId);
        if (!organization) return null;
        return {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          role: membership.role,
        } satisfies SkillSharingOrganizationSummary;
      })
      .filter((organization): organization is SkillSharingOrganizationSummary => Boolean(organization))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private organizationIdsForUser(userId: string): string[] {
    return (this.organizationMemberships.get(userId) ?? [])
      .filter((membership) => this.isEffectiveOrganizationMembership(membership.organizationId, userId))
      .map((membership) => membership.organizationId);
  }

  private isEffectiveTeamMembership(userId: string, team: MemoryTeamMembership): boolean {
    if (team.organizationId === null) {
      return isEffectiveTeamMembership({
        organizationId: null,
        hasCurrentPolicy: true,
        hasActiveOrganizationMembership: true,
      });
    }
    const context = this.organizationContext(team.organizationId, userId);
    return isEffectiveTeamMembership({
      organizationId: team.organizationId,
      ...(context.organizationStatus === undefined ? {} : { organizationStatus: context.organizationStatus }),
      ...(context.currentPolicyRevisionId === undefined ? {} : { currentPolicyRevisionId: context.currentPolicyRevisionId }),
      hasCurrentPolicy: context.hasCurrentPolicy,
      hasActiveOrganizationMembership: context.hasActiveOrganizationMembership,
      requireOrganizationMembershipForTeamMembers: context.requireOrganizationMembershipForTeamMembers,
    });
  }

  private isEffectiveTeamContext(teamId: string): boolean {
    const organizationId = this.teamOrganizations.get(teamId) ?? null;
    if (organizationId === null) return true;
    const organization = this.organizations.get(organizationId);
    return Boolean(
      organization &&
      organization.status === "active" &&
      this.hasCurrentOrganizationPolicy(organization),
    );
  }

  private isEffectiveOrganizationMembership(organizationId: string, userId: string): boolean {
    return isEffectiveTeamMembership({
      organizationId,
      ...this.organizationContext(organizationId, userId),
    });
  }

  private organizationContext(organizationId: string, userId?: string) {
    const organization = this.organizations.get(organizationId);
    const membership = userId
      ? (this.organizationMemberships.get(userId) ?? [])
        .find((candidate) => candidate.organizationId === organizationId && candidate.removedAt === null)
      : undefined;
    return {
      organizationStatus: organization?.status,
      currentPolicyRevisionId: organization?.currentPolicyRevisionId,
      hasCurrentPolicy: Boolean(organization && this.hasCurrentOrganizationPolicy(organization)),
      hasActiveOrganizationMembership: Boolean(membership),
      requireOrganizationMembershipForTeamMembers: organization?.policy.teams.requireOrganizationMembershipForTeamMembers,
    };
  }

  private hasCurrentOrganizationPolicy(organization: MemoryOrganization): boolean {
    return Boolean(organization.currentPolicyRevisionId && organization.policy);
  }

  private validateOrganizationGrants(actorId: string, organizationIds: string[]): Map<string, string> {
    const memberships = this.organizationMemberships.get(actorId) ?? [];
    const result = new Map<string, string>();
    let targetLimit = Number.MAX_SAFE_INTEGER;
    for (const organizationId of organizationIds) {
      const organization = this.organizations.get(organizationId);
      const membership = memberships.find((candidate) => candidate.organizationId === organizationId);
      const activeAuthorizedMember = Boolean(
        organization &&
        organization.status === "active" &&
        membership &&
        membership.removedAt === null &&
        ["owner", "admin", "member"].includes(membership.role),
      );
      if (!organization || !membership || membership.removedAt !== null || !activeAuthorizedMember) {
        throw organizationGrantUnavailable();
      }
      if (!organization.currentPolicyRevisionId) {
        throw new AppError("Organization current policy is required for a skill grant.", "ORGANIZATION_POLICY_REQUIRED", 403);
      }
      targetLimit = Math.min(targetLimit, organization.policy.limits.organizationGrantsPerSkill);
      const decision = evaluateOrganizationShare({
        organizationId,
        organizationStatus: organization.status,
        policy: organization.policy,
        actor: {
          userId: actorId,
          memberships: [{ organizationId, userId: actorId, role: membership.role }],
        },
        resource: "skill",
      });
      if (!decision.allowed) {
        throw new AppError(
          "Organization policy does not allow this skill grant.",
          decision.reason === "organization-inactive" ? "ORGANIZATION_INACTIVE" : "ORGANIZATION_SHARING_NOT_ALLOWED",
          403,
          { organizationId, reason: decision.reason },
        );
      }
      result.set(organizationId, organization.currentPolicyRevisionId);
    }
    if (organizationIds.length > targetLimit) {
      throw new AppError(
        "The organization skill grant limit has been reached.",
        "ORGANIZATION_SKILL_GRANT_LIMIT_EXCEEDED",
        409,
        { limit: targetLimit },
      );
    }
    return result;
  }
}

function organizationGrantUnavailable(): AppError {
  return new AppError("Organization grant is not available.", "ORGANIZATION_GRANT_NOT_AVAILABLE", 403);
}

function validateVisibilityEnabled(visibility: PublicSkill["visibility"], settings: SharingSettings): void {
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

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "organization";
}
