export const skillLifecycleStatuses = ["draft", "private", "submitted", "review", "approved", "deprecated", "unpublished", "revoked", "archived"] as const;
export const reviewStatuses = ["unreviewed", "changes-requested", "approved", "rejected"] as const;
export const securityStatuses = ["not-run", "passed", "warning", "failed"] as const;
export const visibilityScopes = ["public", "authenticated", "organization", "team", "private", "explicit-users"] as const;
export const skillAccessReasons = ["public", "authenticated", "owner", "team", "explicit-user", "organization"] as const;

export type SkillLifecycleStatus = (typeof skillLifecycleStatuses)[number];
export type ReviewStatus = (typeof reviewStatuses)[number];
export type SecurityStatus = (typeof securityStatuses)[number];
export type VisibilityScope = (typeof visibilityScopes)[number];
export type SkillAccessReason = (typeof skillAccessReasons)[number];

export interface SkillPlatformVariant {
  name: string;
  installTarget: string;
  status: "supported" | "planned" | "deprecated";
}

export interface PublicSkill {
  slug: string;
  title: string;
  summary: string;
  lifecycleStatus: SkillLifecycleStatus;
  visibility: VisibilityScope;
  latestVersion: string | null;
  reviewStatus: ReviewStatus;
  securityStatus: SecurityStatus;
  platforms: SkillPlatformVariant[];
  tags: string[];
  access?: {
    canManageSharing: boolean;
    reasons: SkillAccessReason[];
  };
}

export interface SkillSearchFilters {
  query?: string;
  limit?: number;
  actorId?: string | null;
}

export interface SkillSharingActor {
  id: string;
  roles: string[];
}

export interface SharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
  /** Optional on input for backwards compatibility; repositories always return a boolean. */
  organizationVisibilityEnabled?: boolean;
}

export interface SkillSharingTeamSummary {
  id: string;
  name: string;
  role: "owner" | "member";
}

export interface SkillSharingUserSummary {
  id: string;
  email: string;
  name: string;
}

export interface SkillSharingOrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: "provisioning" | "active" | "suspended" | "archived";
  role: "owner" | "admin" | "member";
}

export interface SkillSharingDetails {
  slug: string;
  title: string;
  visibility: VisibilityScope;
  settings: SharingSettings;
  availableTeams: SkillSharingTeamSummary[];
  teamGrants: SkillSharingTeamSummary[];
  userGrants: SkillSharingUserSummary[];
  availableOrganizations?: SkillSharingOrganizationSummary[];
  organizationGrants?: SkillSharingOrganizationSummary[];
}

export interface UpdateSkillSharingInput {
  actor: SkillSharingActor;
  slug: string;
  visibility: VisibilityScope;
  /** Omitted grant fields preserve the complete current set; [] clears it. */
  teamIds?: string[];
  userEmails?: string[];
  organizationIds?: string[];
}

export interface TeamSharedSkillGroup {
  team: {
    id: string;
    name: string;
    role: "owner" | "member";
  };
  sharingWithTeam: PublicSkill[];
  sharedWithMe: PublicSkill[];
}

export interface SkillRepository {
  searchVisibleSkills(filters: SkillSearchFilters): Promise<PublicSkill[]>;
  getVisibleSkillBySlug(slug: string, actorId?: string | null): Promise<PublicSkill | null>;
  getSkillVisibleToTeamBySlug(slug: string, teamId: string): Promise<PublicSkill | null>;
  getSkillVisibleToOrganizationBySlug(slug: string, organizationId: string): Promise<PublicSkill | null>;
  getSharingSettings(): Promise<SharingSettings>;
  updateSharingSettings(actor: SkillSharingActor, settings: SharingSettings): Promise<SharingSettings>;
  getSkillSharing(slug: string, actor: SkillSharingActor): Promise<SkillSharingDetails>;
  updateSkillSharing(input: UpdateSkillSharingInput): Promise<SkillSharingDetails>;
  listTeamSkillGroups(actor: SkillSharingActor): Promise<TeamSharedSkillGroup[]>;
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code = "APP_ERROR",
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export * from "./skill-updates.js";
export * from "./skill-upgrade-policy.js";
export * from "./target-skill-operations.js";

export function assertNever(value: never): never {
  throw new AppError(`Unhandled value: ${String(value)}`, "UNHANDLED_VALUE", 500);
}

export * from "./architecture.js";
export * from "./architecture-tenancy.js";
export * from "./organization-tenancy.js";
export * from "./architecture-target.js";
export * from "./architecture-sync-control.js";
export * from "./architecture-pattern-migration.js";
