export const skillLifecycleStatuses = ["draft", "private", "submitted", "review", "approved", "deprecated", "revoked", "archived"] as const;
export const reviewStatuses = ["unreviewed", "changes-requested", "approved", "rejected"] as const;
export const securityStatuses = ["not-run", "passed", "warning", "failed"] as const;
export const visibilityScopes = ["public", "authenticated", "organization", "team", "private", "explicit-users"] as const;

export type SkillLifecycleStatus = (typeof skillLifecycleStatuses)[number];
export type ReviewStatus = (typeof reviewStatuses)[number];
export type SecurityStatus = (typeof securityStatuses)[number];
export type VisibilityScope = (typeof visibilityScopes)[number];

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
}

export interface SkillSearchFilters {
  query?: string;
  limit?: number;
}

export interface SkillRepository {
  searchVisibleSkills(filters: SkillSearchFilters): Promise<PublicSkill[]>;
  getVisibleSkillBySlug(slug: string): Promise<PublicSkill | null>;
}

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code = "APP_ERROR",
    public readonly statusCode = 500,
  ) {
    super(message);
  }
}

export function assertNever(value: never): never {
  throw new AppError(`Unhandled value: ${String(value)}`, "UNHANDLED_VALUE", 500);
}
