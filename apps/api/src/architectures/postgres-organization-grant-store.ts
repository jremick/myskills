import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  AppError,
  assertValidOrganizationPolicyV1,
  organizationPolicyDigest,
  validateArchitectureSpec,
  type ArchitectureSkillRef,
  type ArchitectureSpecV1,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  instanceSettings,
  organizationMemberships,
  organizationPolicyRevisions,
  organizations,
  skillArchitectureOrganizationGrants,
  skillArchitectureRevisions,
  skillArchitectures,
  skillArtifacts,
  skillOrganizationGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
import {
  MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS,
  type ArchitectureOrganizationGrant,
  type ArchitectureOrganizationGrantInput,
  type ArchitectureOrganizationGrantStore,
  type ReplaceArchitectureOrganizationGrantsStoreInput,
  type ReplaceArchitectureOrganizationGrantsStoreResult,
} from "./organization-grant-service.js";
import {
  architectureOrganizationGrantPolicyFailureMessage,
  evaluateArchitectureOrganizationGrantPolicy,
  freezeArchitectureOrganizationGrantPolicySnapshot,
  type ArchitectureOrganizationGrantOrganizationSnapshot,
  type ArchitectureOrganizationGrantPolicySnapshot,
  type ArchitectureOrganizationGrantReleaseCheck,
} from "./organization-grant-policy.js";

const IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_VISIBILITIES = new Set(["public", "authenticated", "organization"]);
const DEFAULT_SHARING_SETTINGS = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
  organizationVisibilityEnabled: false,
} as const;

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

interface NormalizedGrant {
  organizationId: string;
  createdUnderPolicyRevisionId: string;
}

interface ArchitectureRow {
  id: string;
  ownerUserId: string | null;
  ownerTeamId: string | null;
  currentRevisionId: string | null;
  patternId: string;
}

interface OrganizationContext {
  id: string;
  currentPolicyRevisionId: string | null;
}

interface SharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
  organizationVisibilityEnabled: boolean;
}

/**
 * PostgreSQL persistence for architecture-to-organization grants.
 *
 * The complete replacement is one transaction. It rechecks ownership,
 * effective team membership, organization policy, and exact release metadata
 * after taking the relevant aggregate locks. The injected service-level
 * release authorizer remains a preflight; this adapter does not call external
 * providers while holding a database transaction.
 */
export class PostgresArchitectureOrganizationGrantStore implements ArchitectureOrganizationGrantStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: Database,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async listArchitectureOrganizationGrants(architectureId: string): Promise<ArchitectureOrganizationGrant[]> {
    assertUuid(architectureId, "architectureId");
    try {
      const rows = await this.db
        .select()
        .from(skillArchitectureOrganizationGrants)
        .where(eq(skillArchitectureOrganizationGrants.architectureId, architectureId))
        .orderBy(asc(skillArchitectureOrganizationGrants.organizationId));
      return rows.map(toGrantRecord);
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async countArchitectureOrganizationGrantsForOrganization(organizationId: string): Promise<number> {
    assertUuid(organizationId, "organizationId");
    try {
      const [row] = await this.db
        .select({ count: countRows() })
        .from(skillArchitectureOrganizationGrants)
        .where(eq(skillArchitectureOrganizationGrants.organizationId, organizationId));
      return Number(row?.count ?? 0);
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async countGrantsForOrganization(organizationId: string): Promise<number> {
    return this.countArchitectureOrganizationGrantsForOrganization(organizationId);
  }

  async replaceArchitectureOrganizationGrants(
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult> {
    const normalized = normalizeReplacementInput(input);
    try {
      return await this.db.transaction((tx) => this.replaceInTransaction(tx, normalized));
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async replaceGrants(
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult> {
    return this.replaceArchitectureOrganizationGrants(input);
  }

  private async replaceInTransaction(
    tx: DbLike,
    input: NormalizedReplacementInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult> {
    const architecture = await lockArchitecture(tx, input.architectureId);
    if (!architecture) {
      throw new AppError("Architecture was not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    if ((architecture.ownerUserId === null) === (architecture.ownerTeamId === null)) {
      throw new AppError("Persisted architecture ownership is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
    }

    if (architecture.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture current revision changed. Refresh and retry.",
        "ARCHITECTURE_REVISION_CONFLICT",
        409,
        { currentRevisionId: architecture.currentRevisionId },
      );
    }

    const currentRevision = architecture.currentRevisionId
      ? await lockCurrentRevision(tx, architecture.id, architecture.currentRevisionId)
      : null;
    if (architecture.currentRevisionId && !currentRevision) {
      throw new AppError(
        "The architecture current revision is unavailable.",
        "ARCHITECTURE_CURRENT_REVISION_UNAVAILABLE",
        409,
      );
    }
    const sharing = await lockSharingSettings(tx);

    // Team-owned architectures lock the team before any parent organization
    // rows. Team adoption and team lifecycle writes use this same order;
    // reading the parent first would leave a TOCTOU window and can deadlock
    // against an adoption that already holds the team lock.
    const lockedTeam = architecture.ownerTeamId
      ? await lockTeam(tx, architecture.ownerTeamId)
      : null;
    if (architecture.ownerTeamId && !lockedTeam) {
      throw new AppError("Architecture team was not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    const initialTeamOrganizationId = lockedTeam?.organizationId ?? null;

    const organizationIds = uniqueSorted([
      ...input.grants.map((grant) => grant.organizationId),
      ...(initialTeamOrganizationId ? [initialTeamOrganizationId] : []),
    ]);
    const organizationsById = await lockOrganizations(tx, organizationIds);
    const policiesByOrganizationId = await lockCurrentPolicies(tx, organizationsById);
    const membershipsByOrganizationId = await lockActiveMemberships(
      tx,
      input.actorUserId,
      organizationIds,
    );
    const actorCanManage = await assertCurrentManager(
      tx,
      architecture,
      input.actorUserId,
      lockedTeam?.id ?? null,
      initialTeamOrganizationId,
      organizationsById,
      policiesByOrganizationId,
      membershipsByOrganizationId,
    );
    const contexts = new Map<string, OrganizationContext>();
    for (const grant of input.grants) {
      const organization = organizationsById.get(grant.organizationId);
      contexts.set(grant.organizationId, {
        id: grant.organizationId,
        currentPolicyRevisionId: organization?.currentPolicyRevisionId ?? null,
      });
    }
    const spec = currentRevision ? persistedRevisionSpec(currentRevision.spec, architecture) : null;
    const releaseChecks = spec && input.grants.length > 0
      ? await reauthorizeExactReleases(tx, spec, contexts)
      : [];
    const organizationSnapshots = [...organizationsById.values()]
      .sort((left, right) => compareStrings(left.id, right.id))
      .map((organization): ArchitectureOrganizationGrantOrganizationSnapshot => {
        const policy = policiesByOrganizationId.get(organization.id);
        return {
          organizationId: organization.id,
          status: organization.status,
          currentPolicyRevisionId: organization.currentPolicyRevisionId,
          currentPolicy: policy
            ? {
              id: policy.id,
              organizationId: organization.id,
              policy: policy.policy,
              policySha256: policy.policySha256,
            }
            : null,
          actorMembershipRole: membershipsByOrganizationId.get(organization.id) ?? null,
        };
      });
    const authorizationSnapshot: ArchitectureOrganizationGrantPolicySnapshot = freezeArchitectureOrganizationGrantPolicySnapshot({
      architectureId: architecture.id,
      actorUserId: input.actorUserId,
      owner: architecture.ownerUserId
        ? { type: "user", id: architecture.ownerUserId }
        : { type: "team", id: architecture.ownerTeamId ?? "" },
      actorCanManage,
      currentRevisionId: architecture.currentRevisionId,
      currentRevision: spec && currentRevision
        ? { id: currentRevision.id, architectureId: currentRevision.architectureId, spec }
        : null,
      sharing: {
        organizationVisibilityEnabled: sharing.organizationVisibilityEnabled,
        publicVisibilityEnabled: sharing.publicVisibilityEnabled,
        authenticatedVisibilityEnabled: sharing.authenticatedVisibilityEnabled,
      },
      teamParent: {
        organizationId: initialTeamOrganizationId ?? null,
        teamExists: architecture.ownerTeamId ? Boolean(lockedTeam) : true,
      },
      organizations: organizationSnapshots,
      releaseChecks,
    });
    const policyDecision = evaluateArchitectureOrganizationGrantPolicy(authorizationSnapshot, {
      architectureId: architecture.id,
      actorUserId: input.actorUserId,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      grants: input.grants,
    });
    if (!policyDecision.allowed) {
      throw new AppError(
        architectureOrganizationGrantPolicyFailureMessage(policyDecision.code),
        policyDecision.code,
        policyDecision.statusCode,
        policyDecision.limit === undefined ? undefined : { limit: policyDecision.limit },
      );
    }

    const existingRows = await tx
      .select()
      .from(skillArchitectureOrganizationGrants)
      .where(eq(skillArchitectureOrganizationGrants.architectureId, architecture.id))
      .orderBy(asc(skillArchitectureOrganizationGrants.organizationId))
      .for("update");
    const existingByOrganizationId = new Map(existingRows.map((row) => [row.organizationId, row]));
    const desiredByOrganizationId = new Map(input.grants.map((grant) => [grant.organizationId, grant]));
    const changed = !sameGrantSet(existingByOrganizationId, desiredByOrganizationId);
    const addedOrganizationIds = [...desiredByOrganizationId.keys()]
      .filter((organizationId) => !existingByOrganizationId.has(organizationId))
      .sort(compareStrings);
    const removedOrganizationIds = [...existingByOrganizationId.keys()]
      .filter((organizationId) => !desiredByOrganizationId.has(organizationId))
      .sort(compareStrings);

    let resultRows = existingRows;
    if (changed) {
      await tx
        .delete(skillArchitectureOrganizationGrants)
        .where(eq(skillArchitectureOrganizationGrants.architectureId, architecture.id));
      if (input.grants.length > 0) {
        const now = this.options.now?.() ?? new Date();
        resultRows = await tx
          .insert(skillArchitectureOrganizationGrants)
          .values(input.grants.map((grant) => ({
            architectureId: architecture.id,
            organizationId: grant.organizationId,
            accessLevel: "read",
            createdByUserId: input.actorUserId,
            createdUnderPolicyRevisionId: grant.createdUnderPolicyRevisionId,
            createdAt: now,
          })))
          .returning();
      } else {
        resultRows = [];
      }
    }

    // Keep the allow audit in the same transaction as the complete grant
    // replacement. A service-level audit callback is intentionally ignored by
    // this adapter; an external callback could commit outside this boundary.
    await tx.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: "architecture.organization-grants.replace",
      decision: "allow",
      resourceType: "architecture",
      resourceId: architecture.id,
      details: sanitizeAuditDetails({
        currentRevisionId: architecture.currentRevisionId,
        organizationIds: input.grants.map((grant) => grant.organizationId),
        organizationGrantCount: input.grants.length,
        addedCount: addedOrganizationIds.length,
        removedCount: removedOrganizationIds.length,
        changed,
      }),
    });

    return {
      grants: resultRows
        .slice()
        .sort((left, right) => compareStrings(left.organizationId, right.organizationId))
        .map(toGrantRecord),
      changed,
      addedOrganizationIds,
      removedOrganizationIds,
    };
  }
}

interface NormalizedReplacementInput {
  architectureId: string;
  actorUserId: string;
  expectedCurrentRevisionId: string | null;
  grants: NormalizedGrant[];
}

function normalizeReplacementInput(input: ReplaceArchitectureOrganizationGrantsStoreInput): NormalizedReplacementInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Architecture organization grant input is invalid.", "INVALID_ARCHITECTURE_ORGANIZATION_GRANTS", 400);
  }
  const architectureId = uuidValue(input.architectureId, "architectureId");
  const actorUserId = uuidValue(input.actorUserId, "actorUserId");
  if (!Object.prototype.hasOwnProperty.call(input, "expectedCurrentRevisionId")) {
    throw new AppError(
      "The expected architecture revision is required.",
      "ARCHITECTURE_EXPECTED_REVISION_REQUIRED",
      400,
    );
  }
  const expectedCurrentRevisionId = input.expectedCurrentRevisionId === null
    ? null
    : uuidValue(input.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  if (!Array.isArray(input.grants) || input.grants.length > MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS) {
    throw new AppError(
      "Architecture organization grants must be a bounded array.",
      "INVALID_ARCHITECTURE_ORGANIZATION_GRANTS",
      400,
    );
  }

  const seen = new Set<string>();
  const grants = input.grants.map((grant) => normalizeGrant(grant, seen)).sort((left, right) => (
    compareStrings(left.organizationId, right.organizationId)
  ));
  return {
    architectureId,
    actorUserId,
    expectedCurrentRevisionId,
    grants,
  };
}

function normalizeGrant(
  grant: ArchitectureOrganizationGrantInput,
  seen: Set<string>,
): NormalizedGrant {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
    throw new AppError("Architecture organization grant is invalid.", "INVALID_ARCHITECTURE_ORGANIZATION_GRANT", 400);
  }
  const organizationId = uuidValue(grant.organizationId, "organizationId");
  if (seen.has(organizationId)) {
    throw new AppError(
      "Architecture organization grants must contain one entry per organization.",
      "ARCHITECTURE_ORGANIZATION_GRANT_DUPLICATE",
      400,
    );
  }
  seen.add(organizationId);
  if (grant.accessLevel !== undefined && grant.accessLevel !== "read") {
    throw new AppError(
      "Architecture organization grants are read-only.",
      "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_INVALID",
      400,
    );
  }
  const createdUnderPolicyRevisionId = uuidValue(grant.createdUnderPolicyRevisionId, "createdUnderPolicyRevisionId");
  return {
    organizationId,
    createdUnderPolicyRevisionId,
  };
}

async function lockArchitecture(db: DbLike, architectureId: string): Promise<ArchitectureRow | null> {
  const [row] = await db
    .select({
      id: skillArchitectures.id,
      ownerUserId: skillArchitectures.ownerUserId,
      ownerTeamId: skillArchitectures.ownerTeamId,
      currentRevisionId: skillArchitectures.currentRevisionId,
      patternId: skillArchitectures.patternId,
    })
    .from(skillArchitectures)
    .where(eq(skillArchitectures.id, architectureId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function lockCurrentRevision(
  db: DbLike,
  architectureId: string,
  revisionId: string,
) {
  const [row] = await db
    .select()
    .from(skillArchitectureRevisions)
    .where(and(
      eq(skillArchitectureRevisions.architectureId, architectureId),
      eq(skillArchitectureRevisions.id, revisionId),
    ))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function lockSharingSettings(db: DbLike): Promise<SharingSettings> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "sharing"))
    .for("update")
    .limit(1);
  return parseSharingSettings(row?.value);
}

async function lockTeam(db: DbLike, teamId: string) {
  const [row] = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function assertCurrentManager(
  db: DbLike,
  architecture: ArchitectureRow,
  actorUserId: string,
  teamId: string | null,
  teamParentOrganizationId: string | null,
  organizationsById: Map<string, typeof organizations.$inferSelect>,
  policiesByOrganizationId: Map<string, { id: string; policy: OrganizationPolicyV1; policySha256: string }>,
  membershipsByOrganizationId: Map<string, "owner" | "admin" | "member">,
): Promise<boolean> {
  const [actor] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, actorUserId))
    .for("update")
    .limit(1);
  if (!actor || actor.status !== "active") return false;

  if (architecture.ownerUserId) {
    return architecture.ownerUserId === actorUserId;
  }
  if (!teamId || architecture.ownerTeamId !== teamId) return false;
  const [membership] = await db
    .select({ role: teamMemberships.role })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, teamId),
      eq(teamMemberships.userId, actorUserId),
    ))
    .for("update")
    .limit(1);
  if (!membership || membership.role !== "owner") return false;
  if (teamParentOrganizationId === null) return true;

  // A team owner only retains architecture-manager authority while the
  // parent organization boundary is live. These maps were populated after
  // locking the parent organization, its current policy, and the actor's
  // active membership, so this check is linear with those mutations.
  const organization = organizationsById.get(teamParentOrganizationId);
  return Boolean(
    organization
    && organization.status === "active"
    && policiesByOrganizationId.has(teamParentOrganizationId)
    && membershipsByOrganizationId.has(teamParentOrganizationId),
  );
}

async function lockOrganizations(
  db: DbLike,
  organizationIds: readonly string[],
): Promise<Map<string, typeof organizations.$inferSelect>> {
  if (organizationIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(organizations)
    .where(inArray(organizations.id, organizationIds))
    .orderBy(asc(organizations.id))
    .for("update")
    .limit(MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS + 1);
  return new Map(rows.map((row) => [row.id, row]));
}

async function lockCurrentPolicies(
  db: DbLike,
  organizationsById: Map<string, typeof organizations.$inferSelect>,
): Promise<Map<string, { id: string; policy: OrganizationPolicyV1; policySha256: string }>> {
  const currentPolicyPairs = [...organizationsById.values()]
    .filter((organization) => organization.currentPolicyRevisionId !== null)
    .map((organization) => and(
      eq(organizationPolicyRevisions.organizationId, organization.id),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId as string),
    ));
  if (currentPolicyPairs.length === 0) return new Map();
  const rows = await db
    .select({
      organizationId: organizationPolicyRevisions.organizationId,
      id: organizationPolicyRevisions.id,
      policy: organizationPolicyRevisions.policy,
      policySha256: organizationPolicyRevisions.policySha256,
    })
    .from(organizationPolicyRevisions)
    .where(or(...currentPolicyPairs))
    .orderBy(asc(organizationPolicyRevisions.organizationId), asc(organizationPolicyRevisions.id))
    .for("update");
  const result = new Map<string, { id: string; policy: OrganizationPolicyV1; policySha256: string }>();
  for (const organization of organizationsById.values()) {
    if (!organization.currentPolicyRevisionId) continue;
    const row = rows.find((candidate) => (
      candidate.organizationId === organization.id
      && candidate.id === organization.currentPolicyRevisionId
    ));
    if (!row) continue;
    let policy: OrganizationPolicyV1;
    try {
      policy = assertValidOrganizationPolicyV1(row.policy);
    } catch {
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 409);
    }
    if (organizationPolicyDigest(policy) !== row.policySha256) {
      throw new AppError("Organization policy digest is invalid.", "ORGANIZATION_POLICY_INVALID", 409);
    }
    result.set(organization.id, { id: row.id, policy, policySha256: row.policySha256 });
  }
  return result;
}

async function lockActiveMemberships(
  db: DbLike,
  actorUserId: string,
  organizationIds: readonly string[],
): Promise<Map<string, "owner" | "admin" | "member">> {
  if (organizationIds.length === 0) return new Map();
  const rows = await db
    .select({ organizationId: organizationMemberships.organizationId, role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.userId, actorUserId),
      inArray(organizationMemberships.organizationId, organizationIds),
      isNull(organizationMemberships.removedAt),
    ))
    .orderBy(asc(organizationMemberships.organizationId))
    .for("update")
    .limit(MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS + 1);
  return new Map(rows.map((row) => [row.organizationId, row.role]));
}

function persistedRevisionSpec(input: unknown, architecture: ArchitectureRow): ArchitectureSpecV1 {
  const result = validateArchitectureSpec(input);
  if (!result.valid || result.value.id !== architecture.id || result.value.pattern.id !== architecture.patternId) {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
  return result.value;
}

async function reauthorizeExactReleases(
  db: DbLike,
  spec: ArchitectureSpecV1,
  contexts: Map<string, OrganizationContext>,
): Promise<ArchitectureOrganizationGrantReleaseCheck[]> {
  const refs = uniqueSkillRefs(spec.skills);
  const releases = new Map<string, { skillId: string; available: boolean }>();
  for (const skill of refs) {
    if (!RELEASE_VISIBILITIES.has(skill.packageVisibility)) {
      releases.set(skillKey(skill), { skillId: "", available: false });
      continue;
    }

    const [release] = await db
      .select({
        skillId: skills.id,
        slug: skills.slug,
        version: skillVersions.version,
        visibility: skills.visibility,
        artifactSha256: skillArtifacts.sha256,
      })
      .from(skills)
      .innerJoin(skillVersions, eq(skillVersions.skillId, skills.id))
      .innerJoin(skillArtifacts, eq(skillArtifacts.skillVersionId, skillVersions.id))
      .where(and(
        eq(skills.slug, skill.slug),
        eq(skillVersions.version, skill.version),
        eq(skills.visibility, skill.packageVisibility),
        inArray(skills.lifecycleStatus, ["approved", "deprecated"]),
        inArray(skillVersions.lifecycleStatus, ["approved", "deprecated"]),
        eq(skillVersions.reviewStatus, "approved"),
        eq(skillVersions.securityStatus, "passed"),
        isNotNull(skillVersions.publishedAt),
        isNull(skillVersions.deletedAt),
        eq(skillArtifacts.sha256, skill.digest),
      ))
      .for("update", { of: [skills, skillVersions, skillArtifacts] })
      .limit(1);
    releases.set(skillKey(skill), {
      skillId: release?.skillId ?? "",
      available: Boolean(release && release.version === skill.version && release.artifactSha256 === skill.digest),
    });
  }

  const organizationRefs = refs.filter((skill) => skill.packageVisibility === "organization");
  const releaseIds = uniqueSorted(organizationRefs.map((skill) => {
    const release = releases.get(skillKey(skill));
    return release?.skillId ?? "";
  }).filter((id) => id.length > 0));
  const organizationIds = uniqueSorted([...contexts.keys()]);
  const rows = releaseIds.length > 0 && organizationIds.length > 0
    ? await db
      .select({
        skillId: skillOrganizationGrants.skillId,
        organizationId: skillOrganizationGrants.organizationId,
        createdUnderPolicyRevisionId: skillOrganizationGrants.createdUnderPolicyRevisionId,
      })
      .from(skillOrganizationGrants)
      .where(and(
        inArray(skillOrganizationGrants.skillId, releaseIds),
        inArray(skillOrganizationGrants.organizationId, organizationIds),
      ))
      .for("update")
    : [];
  const grantKeys = new Set(rows.map((row) => (
    `${row.skillId}\u0000${row.organizationId}\u0000${row.createdUnderPolicyRevisionId}`
  )));
  const releaseChecks: ArchitectureOrganizationGrantReleaseCheck[] = [];
  for (const context of contexts.values()) {
    for (const skill of refs) {
      const release = releases.get(skillKey(skill));
      const organizationGrantKey = `${release?.skillId ?? ""}\u0000${context.id}\u0000${context.currentPolicyRevisionId ?? ""}`;
      const organizationGrantAllowed = skill.packageVisibility !== "organization"
        || grantKeys.has(organizationGrantKey);
      releaseChecks.push({
        organizationId: context.id,
        skill: {
          id: skill.id,
          slug: skill.slug,
          version: skill.version,
          digest: skill.digest,
          packageVisibility: skill.packageVisibility,
        },
        allowed: Boolean(release?.available) && organizationGrantAllowed,
        identityMatches: Boolean(release?.available),
      });
    }
  }
  return releaseChecks;
}

function uniqueSkillRefs(refs: readonly ArchitectureSkillRef[]): ArchitectureSkillRef[] {
  const byKey = new Map<string, ArchitectureSkillRef>();
  for (const ref of refs) byKey.set(skillKey(ref), ref);
  return [...byKey.values()];
}

function skillKey(skill: Pick<ArchitectureSkillRef, "id" | "slug" | "version" | "digest" | "packageVisibility">): string {
  return `${skill.id}\u0000${skill.slug}\u0000${skill.version}\u0000${skill.digest}\u0000${skill.packageVisibility}`;
}

function sameGrantSet(
  existing: Map<string, typeof skillArchitectureOrganizationGrants.$inferSelect>,
  desired: Map<string, NormalizedGrant>,
): boolean {
  if (existing.size !== desired.size) return false;
  for (const [organizationId, grant] of desired) {
    const row = existing.get(organizationId);
    if (!row || row.accessLevel !== "read" || row.createdUnderPolicyRevisionId !== grant.createdUnderPolicyRevisionId) {
      return false;
    }
  }
  return true;
}

function toGrantRecord(row: typeof skillArchitectureOrganizationGrants.$inferSelect): ArchitectureOrganizationGrant {
  return {
    architectureId: row.architectureId,
    organizationId: row.organizationId,
    accessLevel: "read",
    createdByUserId: row.createdByUserId,
    createdUnderPolicyRevisionId: row.createdUnderPolicyRevisionId,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseSharingSettings(input: unknown): SharingSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...DEFAULT_SHARING_SETTINGS };
  const value = input as Partial<SharingSettings>;
  return {
    publicVisibilityEnabled: typeof value.publicVisibilityEnabled === "boolean" ? value.publicVisibilityEnabled : true,
    authenticatedVisibilityEnabled: typeof value.authenticatedVisibilityEnabled === "boolean" ? value.authenticatedVisibilityEnabled : true,
    teamsEnabled: typeof value.teamsEnabled === "boolean" ? value.teamsEnabled : true,
    teamVisibilityEnabled: typeof value.teamVisibilityEnabled === "boolean" ? value.teamVisibilityEnabled : true,
    userVisibilityEnabled: typeof value.userVisibilityEnabled === "boolean" ? value.userVisibilityEnabled : true,
    organizationVisibilityEnabled: typeof value.organizationVisibilityEnabled === "boolean"
      ? value.organizationVisibilityEnabled
      : false,
  };
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  }
}

function uuidValue(value: unknown, field: string): string {
  assertUuid(value, field);
  return value.toLowerCase();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function countRows() {
  // Keep the count expression in one place so callers receive a number even
  // when PostgreSQL returns its bigint aggregate as text.
  return sql<number>`count(*)`;
}

function mapPersistenceError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const pgError = findPgError(error);
  if (pgError?.code === "22P02") {
    return new AppError("Architecture organization grant identifiers are invalid.", "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  }
  if (pgError?.code === "23505") {
    return new AppError("Architecture organization grant already exists.", "ARCHITECTURE_ORGANIZATION_GRANT_CONFLICT", 409);
  }
  if (pgError?.code === "23503" || pgError?.code === "23514" || pgError?.code === "23502") {
    return new AppError("Architecture organization grant references are invalid.", "INVALID_ARCHITECTURE_ORGANIZATION_GRANT", 409);
  }
  if (pgError?.code === "40001" || pgError?.code === "40P01" || pgError?.code === "55P03") {
    return new AppError("The architecture organization grant operation must be retried.", "ARCHITECTURE_ORGANIZATION_GRANT_RETRY", 409);
  }
  return new AppError(
    "Architecture organization grants could not be persisted.",
    "ARCHITECTURE_ORGANIZATION_GRANT_PERSISTENCE_FAILED",
    500,
  );
}

interface PgErrorLike {
  code?: string;
  cause?: unknown;
}

function findPgError(error: unknown): PgErrorLike | null {
  let current: unknown = error;
  for (let index = 0; index < 4 && current; index += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const candidate = current as PgErrorLike;
      if (typeof candidate.code === "string") return candidate;
    }
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as PgErrorLike).cause
      : null;
  }
  return null;
}
