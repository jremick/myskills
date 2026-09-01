import {
  AppError,
  type ArchitectureSpecV1,
  type SkillRepository,
} from "@myskills-app/core";
import type { SubmissionService } from "../submissions/service.js";
import type {
  ArchitectureOrganizationGrantReleaseAuthorizer,
  ArchitectureOrganizationGrantReleaseDecision,
  ArchitectureOrganizationGrantReleaseInput,
} from "./organization-grant-service.js";
import type {
  ArchitecturePatternMigrationReleaseAuthorization,
  ArchitecturePatternMigrationReleaseAuthorizationInput,
  ArchitecturePatternMigrationReleaseAuthorizationPort,
} from "./pattern-migration-service.js";
import {
  evaluatePatternMigrationRelease,
  patternMigrationReleaseVisibilities,
} from "./pattern-migration-release-policy.js";

const ALLOWED_RELEASE_VISIBILITIES = ["public", "authenticated", "organization"] as const;

export interface ArchitectureResolutionScope {
  /** The source team context, when the architecture is team-owned. */
  teamId?: string;
  /** Explicit, server-derived organization contexts. Never a client label. */
  organizationIds?: readonly string[];
}

export interface ExactReleaseResolutionDependencies {
  skillRepository: Pick<SkillRepository, "getVisibleSkillBySlug" | "getSkillVisibleToTeamBySlug" | "getSkillVisibleToOrganizationBySlug">;
  submissionService: Pick<SubmissionService, "getPublicRelease">;
}

/**
 * Resolve every architecture skill reference against one exact release and a
 * server-derived access scope. The returned registry snapshot contains only
 * metadata needed by the compiler; it never includes package content.
 */
export async function resolveAuthorizedArchitectureRegistry(
  dependencies: ExactReleaseResolutionDependencies,
  actorId: string,
  spec: ArchitectureSpecV1,
  scope?: ArchitectureResolutionScope,
) {
  if (!dependencies.submissionService) {
    throw new AppError(
      "Architecture release resolution is not configured.",
      "ARCHITECTURE_REGISTRY_RESOLVER_UNAVAILABLE",
      503,
    );
  }
  try {
    return await mapWithConcurrency(spec.skills, 8, async (reference) => {
      let skill: Awaited<ReturnType<typeof resolveAuthorizedArchitectureSkill>>;
      let release: Awaited<ReturnType<SubmissionService["getPublicRelease"]>>;
      try {
        skill = await resolveAuthorizedArchitectureSkill(dependencies, actorId, reference, scope);
        release = await dependencies.submissionService.getPublicRelease({
          slug: reference.slug,
          version: reference.version,
          actorId,
        });
      } catch {
        throw new AppError(
          "Architecture release resolution is temporarily unavailable.",
          "ARCHITECTURE_REGISTRY_RESOLVER_UNAVAILABLE",
          503,
        );
      }
      const decision = evaluatePatternMigrationRelease({
        reference,
        resolvedVisibility: skill?.visibility,
        release: release
          ? {
            slug: release.slug,
            version: release.version,
            digest: release.artifact.sha256,
          }
          : null,
        authorized: Boolean(skill),
        allowedVisibilities: patternMigrationReleaseVisibilities,
        // A reference's package visibility is part of its exact identity. A
        // repository result from a broader or different visibility scope must
        // not be allowed to satisfy the reference merely because its slug,
        // version, and digest match.
        requireVisibilityMatch: true,
      });
      if (!decision.allowed || !skill || !release) {
        throw new AppError(
          "An exact authorized skill release is unavailable for this architecture.",
          "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE",
          422,
        );
      }
      return {
        id: reference.id,
        slug: release.slug,
        title: release.title,
        summary: release.summary,
        version: release.version,
        digest: release.artifact.sha256,
        packageVisibility: skill.visibility,
        tags: skill.tags,
      };
    });
  } catch (error) {
    // Do not leak provider/repository errors through a metadata resolution
    // boundary. Preserve our own bounded decision codes and normalize every
    // lower-level failure to one retryable availability error.
    if (error instanceof AppError && error.code === "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE") throw error;
    throw new AppError(
      "Architecture release resolution is temporarily unavailable.",
      "ARCHITECTURE_REGISTRY_RESOLVER_UNAVAILABLE",
      503,
    );
  }
}

/** Resolve one reference without widening a team or organization scope. */
export async function resolveAuthorizedArchitectureSkill(
  dependencies: ExactReleaseResolutionDependencies,
  actorId: string,
  reference: ArchitectureSpecV1["skills"][number],
  scope?: ArchitectureResolutionScope,
) {
  if (reference.packageVisibility === "organization") {
    const organizationIds = organizationIdsForArchitectureResolution(scope);
    for (const organizationId of organizationIds) {
      const skill = await dependencies.skillRepository.getSkillVisibleToOrganizationBySlug(reference.slug, organizationId);
      if (skill?.visibility === "organization") return skill;
    }
    return null;
  }
  if (scope?.teamId) {
    return dependencies.skillRepository.getSkillVisibleToTeamBySlug(reference.slug, scope.teamId);
  }
  return dependencies.skillRepository.getVisibleSkillBySlug(reference.slug, actorId);
}

export function organizationIdsForArchitectureResolution(scope?: ArchitectureResolutionScope): string[] {
  return [...new Set((scope?.organizationIds ?? []).filter((id) => id.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Shared authorizer for organization grants and derive-shell migrations.
 * Both operations use the same policy-bound skill repository and exact
 * release metadata lookup, while keeping their public ports separate.
 */
export class ExactArchitectureReleaseAuthorizer
  implements ArchitectureOrganizationGrantReleaseAuthorizer, ArchitecturePatternMigrationReleaseAuthorizationPort {
  constructor(private readonly dependencies: ExactReleaseResolutionDependencies) {}

  async authorizeRelease(
    input: ArchitectureOrganizationGrantReleaseInput,
  ): Promise<ArchitectureOrganizationGrantReleaseDecision> {
    const release = input.release;
    if (!ALLOWED_RELEASE_VISIBILITIES.includes(release.packageVisibility as (typeof ALLOWED_RELEASE_VISIBILITIES)[number])) {
      return { allowed: false, code: "release_visibility_not_allowed" };
    }
    try {
      const skill = await this.dependencies.skillRepository.getSkillVisibleToOrganizationBySlug(
        release.slug,
        input.organizationId,
      );
      const exactRelease = await this.dependencies.submissionService.getPublicRelease({
        slug: release.slug,
        version: release.version,
        actorId: input.actorUserId,
      });
      const decision = evaluatePatternMigrationRelease({
        reference: release,
        resolvedVisibility: skill?.visibility,
        release: exactRelease
          ? {
            slug: exactRelease.slug,
            version: exactRelease.version,
            digest: exactRelease.artifact.sha256,
          }
          : null,
        authorized: Boolean(skill),
        allowedVisibilities: ALLOWED_RELEASE_VISIBILITIES,
        requireVisibilityMatch: true,
      });
      if (!decision.allowed || !skill || !exactRelease) {
        return { allowed: false, code: "release_not_visible" };
      }
      return {
        allowed: true,
        release: {
          slug: exactRelease.slug,
          version: exactRelease.version,
          digest: exactRelease.artifact.sha256,
          packageVisibility: skill.visibility,
        },
      };
    } catch {
      return { allowed: false, code: "release_authorizer_unavailable" };
    }
  }

  async authorize(
    input: ArchitecturePatternMigrationReleaseAuthorizationInput,
  ): Promise<ArchitecturePatternMigrationReleaseAuthorization> {
    try {
      await resolveAuthorizedArchitectureRegistry(
        this.dependencies,
        input.actorId,
        input.targetSpec,
        {
          ...(input.owner.type === "team" ? { teamId: input.owner.id } : {}),
          organizationIds: input.organizationIds,
        },
      );
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        code: error instanceof AppError && /^[a-z][a-z0-9._:-]{0,95}$/.test(error.code)
          ? error.code
          : "release_not_visible",
      };
    }
  }
}

export function createExactArchitectureReleaseAuthorizer(
  dependencies: ExactReleaseResolutionDependencies,
): ExactArchitectureReleaseAuthorizer {
  return new ExactArchitectureReleaseAuthorizer(dependencies);
}

export type ArchitectureRegistrySnapshot = Awaited<ReturnType<typeof resolveAuthorizedArchitectureRegistry>>;

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
