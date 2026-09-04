import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import {
  AppError,
  assertValidOrganizationPolicyV1,
  type ArchitectureOwnerReference,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import {
  instanceSettings,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillArchitectureOrganizationGrants,
  skillArtifacts,
  skillOrganizationGrants,
  skillTeamGrants,
  skillUserGrants,
  skillArchitectures,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
import {
  evaluatePatternMigrationRelease,
  patternMigrationReleaseVisibilities,
} from "./pattern-migration-release-policy.js";
import { ownerFromDb, type DbLike } from "./postgres-pattern-migration-records.js";

export type PatternMigrationAuthorityArchitecture = Pick<
  typeof skillArchitectures.$inferSelect,
  "ownerUserId" | "ownerTeamId"
>;

export interface InternalRegistrySnapshotInput {
  actorId: string;
  architectureId: string;
  owner: ArchitectureOwnerReference | null;
  organizationIds: readonly string[];
  spec: Pick<ArchitectureSpecV1, "skills">;
}

interface LockedRegistryRelease {
  skillId: string;
  ownerUserId: string | null;
  visibility: string;
  slug: string;
  version: string;
  artifactSha256: string;
}

interface RegistrySharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
  organizationVisibilityEnabled: boolean;
}

/**
 * Resolve current actor authority while the migration transaction owns the
 * source lock. Parent organization context is rechecked after the team lock;
 * a parented team never falls back to stale standalone-team membership.
 */
export async function assertCurrentActorAuthority(
  db: DbLike,
  actorId: string,
  architecture: PatternMigrationAuthorityArchitecture,
): Promise<void> {
  const owner = ownerFromDb(architecture.ownerUserId, architecture.ownerTeamId);
  if (!owner) throw persistedInvalid();
  if (owner.type === "user") {
    const [actor] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, actorId))
      .for("update")
      .limit(1);
    if (!actor || actor.status !== "active") throw forbidden();
    if (owner.id !== actorId) throw forbidden();
    return;
  }

  // Team mutations lock the team before its parent organization. Read the
  // parent first only as a hint, then acquire the team lock and re-read it so
  // a concurrent adoption cannot turn stale standalone membership into
  // authority.
  const [hint] = await db
    .select({ organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, owner.id))
    .limit(1);
  if (!hint) throw forbidden();
  const [team] = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, owner.id))
    .for("update")
    .limit(1);
  if (!team) throw forbidden();
  if (team.organizationId !== hint.organizationId) {
    // The parent can only move from NULL under the team -> organization lock
    // order. Retry from the caller after this transaction rolls back.
    throw new AppError("Team organization scope changed during migration.", "ARCHITECTURE_PATTERN_MIGRATION_SCOPE_CONFLICT", 409);
  }

  const organization = team.organizationId ? await lockOrganization(db, team.organizationId) : null;
  if (team.organizationId) {
    if (!organization || organization.status !== "active" || !organization.currentPolicyRevisionId) throw forbidden();
    const [policy] = await db
      .select({ policy: organizationPolicyRevisions.policy })
      .from(organizationPolicyRevisions)
      .where(and(
        eq(organizationPolicyRevisions.organizationId, organization.id),
        eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
      ))
      .for("update")
      .limit(1);
    if (!policy) throw forbidden();
    try {
      assertValidOrganizationPolicyV1(policy.policy);
    } catch {
      throw forbidden();
    }
    const [organizationMembership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, organization.id),
        eq(organizationMemberships.userId, actorId),
        sql`${organizationMemberships.removedAt} IS NULL`,
      ))
      .for("update")
      .limit(1);
    if (!organizationMembership) throw forbidden();
  }

  const [actor] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, actorId))
    .for("update")
    .limit(1);
  if (!actor || actor.status !== "active") throw forbidden();
  const [membership] = await db
    .select({ id: teamMemberships.id, role: teamMemberships.role })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, owner.id),
      eq(teamMemberships.userId, actorId),
    ))
    .for("update")
    .limit(1);
  if (!membership || membership.role !== "owner") throw forbidden();
}

/**
 * Recheck every exact release against the local registry while the source
 * transaction remains open. Provider preflight happens outside this boundary;
 * this DB-local pass locks the MySkills rows that can change the decision.
 */
export async function reauthorizeInternalRegistrySnapshot(
  db: DbLike,
  input: InternalRegistrySnapshotInput,
): Promise<void> {
  if (!input.owner) throw releaseRevalidationFailed();
  const sharing = await lockRegistrySharingSettings(db);
  const organizationIds = uniqueStrings(input.organizationIds);
  for (const reference of uniqueSkillRefs(input.spec.skills)) {
    const release = await lockExactRegistryRelease(db, reference);
    if (!release) throw releaseRevalidationFailed();

    let visibilityEnabled = true;
    let authorized = true;
    if (reference.packageVisibility === "public") {
      visibilityEnabled = sharing.publicVisibilityEnabled;
    } else if (reference.packageVisibility === "authenticated") {
      visibilityEnabled = sharing.authenticatedVisibilityEnabled;
    } else if (reference.packageVisibility === "private") {
      // Team-scoped repository resolution deliberately does not widen to a
      // private user-owned release, even when the team owner is also a user.
      authorized = input.owner.type === "user" && release.ownerUserId === input.actorId;
    } else if (reference.packageVisibility === "explicit-users") {
      visibilityEnabled = sharing.userVisibilityEnabled;
      authorized = input.owner.type === "user"
        && sharing.userVisibilityEnabled
        && await actorHasExplicitUserGrant(db, release.skillId, input.actorId);
    } else if (reference.packageVisibility === "team") {
      visibilityEnabled = sharing.teamsEnabled && sharing.teamVisibilityEnabled;
      authorized = sharing.teamsEnabled
        && sharing.teamVisibilityEnabled
        && await actorHasTeamReleaseAccess(db, release.skillId, input.actorId, input.owner);
    } else {
      visibilityEnabled = sharing.organizationVisibilityEnabled;
      authorized = sharing.organizationVisibilityEnabled
        && await actorHasOrganizationReleaseAccess(
          db,
          release.skillId,
          input.actorId,
          input.architectureId,
          organizationIds,
        );
    }

    const decision = evaluatePatternMigrationRelease({
      reference,
      resolvedVisibility: release.visibility,
      release: {
        slug: release.slug,
        version: release.version,
        digest: release.artifactSha256,
      },
      authorized,
      visibilityEnabled,
      allowedVisibilities: patternMigrationReleaseVisibilities,
      requireVisibilityMatch: true,
    });
    if (!decision.allowed) throw releaseRevalidationFailed();
  }
}

async function lockRegistrySharingSettings(db: DbLike): Promise<RegistrySharingSettings> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "sharing"))
    .for("update")
    .limit(1);
  const value = row?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: false,
    };
  }
  const settings = value as Record<string, unknown>;
  return {
    publicVisibilityEnabled: settings.publicVisibilityEnabled !== false,
    authenticatedVisibilityEnabled: settings.authenticatedVisibilityEnabled !== false,
    teamsEnabled: settings.teamsEnabled !== false,
    teamVisibilityEnabled: settings.teamVisibilityEnabled !== false,
    userVisibilityEnabled: settings.userVisibilityEnabled !== false,
    organizationVisibilityEnabled: settings.organizationVisibilityEnabled === true,
  };
}

async function lockExactRegistryRelease(
  db: DbLike,
  reference: ArchitectureSpecV1["skills"][number],
): Promise<LockedRegistryRelease | null> {
  const [release] = await db
    .select({
      skillId: skills.id,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
      slug: skills.slug,
      version: skillVersions.version,
      artifactSha256: skillArtifacts.sha256,
    })
    .from(skills)
    .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
    .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
    .where(and(
      eq(skills.slug, reference.slug),
      eq(skillVersions.version, reference.version),
      eq(skills.visibility, reference.packageVisibility),
      inArray(skills.lifecycleStatus, ["approved", "deprecated"]),
      inArray(skillVersions.lifecycleStatus, ["approved", "deprecated"]),
      eq(skillVersions.reviewStatus, "approved"),
      eq(skillVersions.securityStatus, "passed"),
      isNotNull(skillVersions.publishedAt),
      isNull(skillVersions.deletedAt),
      eq(skillArtifacts.sha256, reference.digest),
    ))
    .for("update", { of: [skills, skillVersions, skillArtifacts] })
    .limit(1);
  return release ?? null;
}

async function actorHasExplicitUserGrant(
  db: DbLike,
  skillId: string,
  actorId: string,
): Promise<boolean> {
  const [grant] = await db
    .select({ skillId: skillUserGrants.skillId })
    .from(skillUserGrants)
    .where(and(
      eq(skillUserGrants.skillId, skillId),
      eq(skillUserGrants.userId, actorId),
    ))
    .for("update")
    .limit(1);
  return Boolean(grant);
}

async function actorHasTeamReleaseAccess(
  db: DbLike,
  skillId: string,
  actorId: string,
  owner: ArchitectureOwnerReference,
): Promise<boolean> {
  const teamId = owner.type === "team" ? owner.id : undefined;
  const rows = await db
    .select({
      teamId: skillTeamGrants.teamId,
      organizationId: teams.organizationId,
    })
    .from(skillTeamGrants)
    .innerJoin(teamMemberships, and(
      eq(teamMemberships.teamId, skillTeamGrants.teamId),
      eq(teamMemberships.userId, actorId),
    ))
    .innerJoin(teams, eq(teams.id, skillTeamGrants.teamId))
    .where(and(
      eq(skillTeamGrants.skillId, skillId),
      teamId ? eq(skillTeamGrants.teamId, teamId) : undefined,
    ))
    .orderBy(asc(skillTeamGrants.teamId))
    .for("update", { of: [skillTeamGrants, teamMemberships, teams] });

  for (const row of rows) {
    if (!row.organizationId) return true;
    const organization = await lockOrganization(db, row.organizationId);
    if (!organization || organization.status !== "active" || !organization.currentPolicyRevisionId) continue;
    const [policy] = await db
      .select({ policy: organizationPolicyRevisions.policy })
      .from(organizationPolicyRevisions)
      .where(and(
        eq(organizationPolicyRevisions.organizationId, organization.id),
        eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
      ))
      .for("update")
      .limit(1);
    if (!policy) continue;
    try {
      assertValidOrganizationPolicyV1(policy.policy);
    } catch {
      continue;
    }
    const [membership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, organization.id),
        eq(organizationMemberships.userId, actorId),
        isNull(organizationMemberships.removedAt),
      ))
      .for("update")
      .limit(1);
    if (membership) return true;
  }
  return false;
}

async function actorHasOrganizationReleaseAccess(
  db: DbLike,
  skillId: string,
  actorId: string,
  architectureId: string,
  organizationIds: readonly string[],
): Promise<boolean> {
  if (organizationIds.length === 0) return false;
  const rows = await db
    .select({
      organizationId: skillOrganizationGrants.organizationId,
      createdUnderPolicyRevisionId: skillOrganizationGrants.createdUnderPolicyRevisionId,
      organizationStatus: organizations.status,
      currentPolicyRevisionId: organizations.currentPolicyRevisionId,
      policy: organizationPolicyRevisions.policy,
    })
    .from(skillOrganizationGrants)
    .innerJoin(organizations, eq(organizations.id, skillOrganizationGrants.organizationId))
    .innerJoin(skillArchitectureOrganizationGrants, and(
      eq(skillArchitectureOrganizationGrants.architectureId, architectureId),
      eq(skillArchitectureOrganizationGrants.organizationId, skillOrganizationGrants.organizationId),
      eq(skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId, organizations.currentPolicyRevisionId),
    ))
    .innerJoin(organizationPolicyRevisions, and(
      eq(organizationPolicyRevisions.organizationId, organizations.id),
      eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
    ))
    .innerJoin(organizationMemberships, and(
      eq(organizationMemberships.organizationId, organizations.id),
      eq(organizationMemberships.userId, actorId),
      isNull(organizationMemberships.removedAt),
    ))
    .where(and(
      eq(skillOrganizationGrants.skillId, skillId),
      inArray(skillOrganizationGrants.organizationId, organizationIds),
      eq(skillOrganizationGrants.createdUnderPolicyRevisionId, organizations.currentPolicyRevisionId),
      eq(skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId, organizations.currentPolicyRevisionId),
    ))
    .orderBy(asc(skillOrganizationGrants.organizationId))
    .for("update", {
      of: [skillOrganizationGrants, skillArchitectureOrganizationGrants, organizations, organizationPolicyRevisions, organizationMemberships],
    });

  for (const row of rows) {
    if (row.organizationStatus !== "active" || !row.currentPolicyRevisionId) continue;
    try {
      const policy = assertValidOrganizationPolicyV1(row.policy);
      if (policy.sharing.organizationSkillSharingEnabled) return true;
    } catch {
      // Invalid policy rows fail closed even if they passed database checks
      // in an older schema or were written by a manual migration.
    }
  }
  return false;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function uniqueSkillRefs(
  refs: readonly ArchitectureSpecV1["skills"][number][],
): ArchitectureSpecV1["skills"][number][] {
  const byKey = new Map<string, ArchitectureSpecV1["skills"][number]>();
  for (const reference of refs) {
    byKey.set(
      `${reference.slug}\u0000${reference.version}\u0000${reference.digest}\u0000${reference.packageVisibility}`,
      reference,
    );
  }
  return [...byKey.values()];
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

function releaseRevalidationFailed(): AppError {
  return new AppError(
    "An exact architecture release changed before the migration could commit.",
    "ARCHITECTURE_PATTERN_MIGRATION_RELEASE_REVALIDATION_FAILED",
    409,
  );
}

function forbidden(): AppError {
  return new AppError("Current user is not authorized to migrate this architecture.", "ARCHITECTURE_PATTERN_MIGRATION_FORBIDDEN", 403);
}

function persistedInvalid(): AppError {
  return new AppError("Persisted pattern migration is invalid.", "PERSISTED_ARCHITECTURE_PATTERN_MIGRATION_INVALID", 500);
}
