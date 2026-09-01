import {
  AppError,
  assertValidOrganizationPolicyV1,
  type ArchitectureSkillRef,
  type OrganizationMembershipRole,
  type OrganizationPolicyRevision,
  type OrganizationStatus,
} from "@myskills-app/core";
import type { OrganizationStore } from "../organizations/types.js";
import type { TeamStore } from "../teams/types.js";
import type {
  ArchitectureActorInput,
  ArchitectureRecord,
  ArchitectureRevisionRecord,
  ArchitectureStore,
} from "./types.js";
import type {
  ArchitectureOrganizationGrantPolicyDenied,
  ArchitectureOrganizationGrantPolicySnapshot,
  ArchitectureOrganizationGrantReleaseCheck,
} from "./organization-grant-policy.js";
import {
  architectureOrganizationGrantPolicyFailureMessage,
  evaluateArchitectureOrganizationGrantPolicy,
  freezeArchitectureOrganizationGrantPolicySnapshot,
} from "./organization-grant-policy.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_RELEASE_VISIBILITIES = new Set(["public", "authenticated", "organization"]);

/** Bounded request size before any organization or release lookup occurs. */
export const MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS = 500;

/** The only grant capability exposed by this Phase 2A/2B boundary. */
export type ArchitectureOrganizationGrantAccessLevel = "read";

export interface ArchitectureOrganizationGrant {
  architectureId: string;
  organizationId: string;
  accessLevel: ArchitectureOrganizationGrantAccessLevel;
  createdByUserId: string | null;
  createdUnderPolicyRevisionId: string;
  createdAt: string;
}

export interface ArchitectureOrganizationGrantInput {
  organizationId: string;
  accessLevel?: ArchitectureOrganizationGrantAccessLevel;
  createdByUserId?: string | null;
  createdUnderPolicyRevisionId: string;
  createdAt?: string;
}

export interface ReplaceArchitectureOrganizationGrantsStoreInput {
  architectureId: string;
  actorUserId: string;
  /**
   * Revision observed while authorizing the complete replacement. A
   * persistence adapter must compare this token while holding its
   * architecture lock before changing any grant rows.
   */
  expectedCurrentRevisionId: string | null;
  grants: readonly ArchitectureOrganizationGrantInput[];
  /**
   * Service preflight snapshot for memory adapters. PostgreSQL deliberately
   * ignores this hint and loads/locks its authoritative snapshot in its
   * transaction before evaluating the command.
   */
  authorizationSnapshot?: ArchitectureOrganizationGrantPolicySnapshot;
  /**
   * Required allow-audit hook for the service path. Memory adapters invoke
   * this before swapping their staged grant set; PostgreSQL persists the
   * equivalent event directly in its replacement transaction and ignores the
   * callback. Denial audits remain owned by the service's best-effort path.
   */
  recordAllowAuditEvent?: (
    input: Parameters<ArchitectureStore["recordAuditEvent"]>[0],
  ) => Promise<void>;
}

export interface ReplaceArchitectureOrganizationGrantsStoreResult {
  grants: ArchitectureOrganizationGrant[];
  changed: boolean;
  addedOrganizationIds: string[];
  removedOrganizationIds: string[];
}

/**
 * Authorization-aware atomic command boundary for the composite-key grant
 * rows. Implementations must perform the final policy/release decision before
 * replacing the complete set. The optional snapshot is a service preflight
 * hint for memory fixtures; PostgreSQL never treats it as authoritative.
 */
export interface ArchitectureOrganizationGrantStore {
  readonly kind?: "memory" | "postgres";
  listArchitectureOrganizationGrants(architectureId: string): Promise<ArchitectureOrganizationGrant[]>;
  /** Optional helper for fixture/reporting callers. */
  countArchitectureOrganizationGrantsForOrganization?(organizationId: string): Promise<number>;
  /** Compatibility alias for stores with compact naming. */
  countGrantsForOrganization?(organizationId: string): Promise<number>;
  replaceArchitectureOrganizationGrants(
    input: ReplaceArchitectureOrganizationGrantsStoreInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsStoreResult>;
}

/** Narrow authority used by the service; OrganizationStore satisfies it. */
export type ArchitectureOrganizationGrantOrganizationStore = Pick<
  OrganizationStore,
  "getOrganization" | "findMembership" | "getPolicyRevision"
>;

export interface ArchitectureOrganizationGrantTeamParentAuthority {
  getTeamOrganizationId(teamId: string): Promise<string | null>;
}

export interface ArchitectureOrganizationGrantReleaseInput {
  actorUserId: string;
  organizationId: string;
  /** Current policy snapshot used by the authorizer for the exact org gate. */
  organizationPolicyRevisionId: string;
  organizationPolicySha256: string;
  release: Pick<ArchitectureSkillRef, "id" | "slug" | "version" | "digest" | "packageVisibility">;
}

export interface ArchitectureOrganizationGrantReleaseProjection {
  id?: string;
  slug?: string;
  version?: string;
  digest?: string;
  packageVisibility?: string;
}

export interface ArchitectureOrganizationGrantReleaseDecision {
  allowed: boolean;
  code?: string;
  release?: ArchitectureOrganizationGrantReleaseProjection;
}

/**
 * This port must resolve one exact, current release for one exact
 * organization. It is intentionally not a generic registry search method.
 */
export interface ArchitectureOrganizationGrantReleaseAuthorizer {
  authorizeRelease?(
    input: ArchitectureOrganizationGrantReleaseInput,
  ): Promise<boolean | ArchitectureOrganizationGrantReleaseDecision>;
  /** Alias accepted for adapters that use policy terminology. */
  isReleaseAuthorized?(
    input: ArchitectureOrganizationGrantReleaseInput,
  ): Promise<boolean | ArchitectureOrganizationGrantReleaseDecision>;
}

export interface ArchitectureOrganizationGrantSharingSettingsProvider {
  getSharingSettings(): Promise<{ organizationVisibilityEnabled?: boolean }>;
}

export interface ArchitectureOrganizationGrantServiceDependencies {
  architectureStore: ArchitectureStore;
  organizationStore: ArchitectureOrganizationGrantOrganizationStore;
  grantStore: ArchitectureOrganizationGrantStore;
  releaseAuthorizer: ArchitectureOrganizationGrantReleaseAuthorizer | ((
    input: ArchitectureOrganizationGrantReleaseInput,
  ) => Promise<boolean | ArchitectureOrganizationGrantReleaseDecision>);
  /** Secure default is false when no setting provider is supplied. */
  organizationVisibilityEnabled?: boolean | (() => Promise<boolean>);
  sharingSettingsProvider?: ArchitectureOrganizationGrantSharingSettingsProvider;
  /** Used to distinguish a team owner's parent organization from other orgs. */
  teamParentAuthority?: ArchitectureOrganizationGrantTeamParentAuthority;
  /** Existing TeamStore is supported as a read-only parentage fallback. */
  teamStore?: Pick<TeamStore, "listTeamsForUser">;
}

export interface ArchitectureOrganizationGrantServiceOptions {
  organizationVisibilityEnabled?: boolean | (() => Promise<boolean>);
  sharingSettingsProvider?: ArchitectureOrganizationGrantSharingSettingsProvider;
  teamParentAuthority?: ArchitectureOrganizationGrantTeamParentAuthority;
  teamStore?: Pick<TeamStore, "listTeamsForUser">;
}

export interface ReplaceArchitectureOrganizationGrantsInput {
  actor: ArchitectureActorInput;
  architectureId: string;
  /** Current pointer observed by the client. Null is valid for an empty shell. */
  expectedCurrentRevisionId: string | null;
  /** Complete desired set. An empty array revokes all organization grants. */
  organizationIds: readonly string[];
}

export interface ReplaceArchitectureOrganizationGrantsResult {
  architectureId: string;
  currentRevisionId: string | null;
  grants: ArchitectureOrganizationGrant[];
  organizationIds: string[];
  addedOrganizationIds: string[];
  removedOrganizationIds: string[];
  changed: boolean;
}

export interface ListArchitectureOrganizationGrantsInput {
  actor: ArchitectureActorInput;
  architectureId: string;
}

export interface ListArchitectureOrganizationGrantsResult {
  architectureId: string;
  currentRevisionId: string | null;
  grants: ArchitectureOrganizationGrant[];
  organizationIds: string[];
}

/** Compatibility aliases for route handlers that call the operation update. */
export type UpdateArchitectureOrganizationGrantsInput = ReplaceArchitectureOrganizationGrantsInput;
export type UpdateArchitectureOrganizationGrantsResult = ReplaceArchitectureOrganizationGrantsResult;

/**
 * Policy-gated orchestration for architecture organization grants.
 *
 * The service validates the complete request, current architecture revision,
 * current organization policy/membership, and every exact release before it
 * invokes the repository's atomic replacement operation. It never consults
 * a profile subject or treats a context label as authority.
 */
export class ArchitectureOrganizationGrantService {
  private readonly architectureStore: ArchitectureStore;
  private readonly organizationStore: ArchitectureOrganizationGrantOrganizationStore;
  private readonly grantStore: ArchitectureOrganizationGrantStore;
  private readonly releaseAuthorizer: ArchitectureOrganizationGrantServiceDependencies["releaseAuthorizer"];
  private readonly organizationVisibilityEnabled?: boolean | (() => Promise<boolean>);
  private readonly sharingSettingsProvider?: ArchitectureOrganizationGrantSharingSettingsProvider;
  private readonly teamParentAuthority?: ArchitectureOrganizationGrantTeamParentAuthority;
  private readonly teamStore?: Pick<TeamStore, "listTeamsForUser">;

  constructor(dependencies: ArchitectureOrganizationGrantServiceDependencies);
  constructor(
    architectureStore: ArchitectureStore,
    organizationStore: ArchitectureOrganizationGrantOrganizationStore,
    grantStore: ArchitectureOrganizationGrantStore,
    releaseAuthorizer: ArchitectureOrganizationGrantServiceDependencies["releaseAuthorizer"],
    options?: ArchitectureOrganizationGrantServiceOptions,
  );
  constructor(
    first: ArchitectureOrganizationGrantServiceDependencies | ArchitectureStore,
    organizationStore?: ArchitectureOrganizationGrantOrganizationStore,
    grantStore?: ArchitectureOrganizationGrantStore,
    releaseAuthorizer?: ArchitectureOrganizationGrantServiceDependencies["releaseAuthorizer"],
    options: ArchitectureOrganizationGrantServiceOptions = {},
  ) {
    const dependencies: ArchitectureOrganizationGrantServiceDependencies = isDependencies(first)
      ? first
      : {
        architectureStore: first,
        organizationStore: organizationStore as ArchitectureOrganizationGrantOrganizationStore,
        grantStore: grantStore as ArchitectureOrganizationGrantStore,
        releaseAuthorizer: releaseAuthorizer as ArchitectureOrganizationGrantServiceDependencies["releaseAuthorizer"],
        ...options,
      };
    if (!dependencies.organizationStore || !dependencies.grantStore || !dependencies.releaseAuthorizer) {
      throw new AppError(
        "Architecture organization grant dependencies are incomplete.",
        "ARCHITECTURE_ORGANIZATION_GRANT_DEPENDENCIES_INVALID",
        500,
      );
    }
    this.architectureStore = dependencies.architectureStore;
    this.organizationStore = dependencies.organizationStore;
    this.grantStore = dependencies.grantStore;
    this.releaseAuthorizer = dependencies.releaseAuthorizer;
    this.organizationVisibilityEnabled = dependencies.organizationVisibilityEnabled;
    this.sharingSettingsProvider = dependencies.sharingSettingsProvider;
    this.teamParentAuthority = dependencies.teamParentAuthority;
    this.teamStore = dependencies.teamStore;
  }

  async listOrganizationGrants(
    input: ListArchitectureOrganizationGrantsInput,
  ): Promise<ListArchitectureOrganizationGrantsResult> {
    const actorUserId = actorId(input?.actor);
    const architectureId = cleanIdentifier(input?.architectureId, "architectureId");
    try {
      const architecture = await this.architectureStore.getArchitecture(input.actor, architectureId);
      if (!architecture) throw architectureNotFound();
      requireArchitectureManager(architecture);
      const grants = (await this.grantStore.listArchitectureOrganizationGrants(architectureId))
        .slice()
        .sort((left, right) => compareStrings(left.organizationId, right.organizationId));
      await this.recordAuditSafe({
        actorUserId,
        action: "architecture.organization-grants.list",
        resourceType: "architecture",
        resourceId: architectureId,
        details: { organizationGrantCount: grants.length },
      });
      return {
        architectureId,
        currentRevisionId: architecture.currentRevisionId,
        grants,
        organizationIds: grants.map((grant) => grant.organizationId),
      };
    } catch (error) {
      const normalized = toGrantReadError(error);
      await this.recordAuditSafe({
        actorUserId,
        action: "architecture.organization-grants.list",
        resourceType: "architecture",
        resourceId: architectureId,
        details: { code: normalized.code },
      });
      throw normalized;
    }
  }

  async replaceOrganizationGrants(
    input: ReplaceArchitectureOrganizationGrantsInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsResult> {
    const actorUserId = actorId(input?.actor);
    const architectureId = cleanIdentifier(input?.architectureId, "architectureId");
    const expectedCurrentRevisionId = normalizeExpectedCurrentRevisionId(input?.expectedCurrentRevisionId);
    const organizationIds = normalizeOrganizationIds(input?.organizationIds);

    try {
      const architecture = await this.architectureStore.getArchitecture(input.actor, architectureId);
      if (!architecture) throw architectureNotFound();
      requireArchitectureManager(architecture);

      const currentRevisionId = architecture.currentRevisionId;
      if (currentRevisionId !== expectedCurrentRevisionId) {
        throw new AppError(
          "The architecture current revision changed. Refresh and retry.",
          "ARCHITECTURE_REVISION_CONFLICT",
          409,
          { currentRevisionId },
        );
      }
      const contexts = [] as ValidatedOrganizationContext[];
      const teamParentOrganizationId = architecture.owner.type === "team"
        ? await this.resolveTeamParentOrganizationId(architecture.owner.id, actorUserId)
        : null;
      const teamParentContext = teamParentOrganizationId
        ? await this.loadOrganizationContext(actorUserId, teamParentOrganizationId)
        : null;
      let revision: ArchitectureRevisionRecord | null = null;
      let releaseChecks: ArchitectureOrganizationGrantReleaseCheck[] = [];
      const organizationVisibilityEnabled = organizationIds.length > 0
        ? await this.isOrganizationVisibilityEnabled()
        : false;
      if (organizationIds.length > 0) {
        if (!organizationVisibilityEnabled) {
          throw new AppError(
            "Organization sharing is disabled for this instance.",
            "ORGANIZATION_SHARING_DISABLED",
            403,
          );
        }
        if (!currentRevisionId) {
          throw new AppError(
            "An architecture revision is required before organization sharing.",
            "ARCHITECTURE_CURRENT_REVISION_REQUIRED",
            409,
          );
        }
        revision = await this.architectureStore.getRevision(input.actor, architectureId, currentRevisionId);
        if (!revision || revision.architectureId !== architectureId || revision.id !== currentRevisionId) {
          throw new AppError(
            "The architecture current revision is unavailable.",
            "ARCHITECTURE_CURRENT_REVISION_UNAVAILABLE",
            409,
          );
        }
        for (const organizationId of organizationIds) {
          const context = await this.validateOrganizationTarget({
            actorUserId,
            architecture,
            organizationId,
            teamParentOrganizationId,
          });
          contexts.push(context);
        }
        await this.validateGrantLimits(organizationIds, contexts);
        releaseChecks = await this.validateExactReleases(actorUserId, revision, contexts);
      }

      const authorizationSnapshot = freezeArchitectureOrganizationGrantPolicySnapshot({
        architectureId,
        actorUserId,
        owner: { ...architecture.owner },
        actorCanManage: architecture.access.canManage,
        currentRevisionId,
        currentRevision: revision
          ? {
            id: revision.id,
            architectureId: revision.architectureId,
            spec: revision.spec,
          }
          : null,
        sharing: {
          // The existing service dependency exposes the organization gate;
          // exact public/authenticated gates remain in the release authorizer
          // and the PostgreSQL transaction.
          organizationVisibilityEnabled,
          publicVisibilityEnabled: true,
          authenticatedVisibilityEnabled: true,
        },
        teamParent: {
          organizationId: teamParentOrganizationId,
          teamExists: true,
        },
        organizations: [...contexts, ...(teamParentContext && !contexts.some((context) => context.organizationId === teamParentContext.organizationId)
          ? [teamParentContext]
          : [])].map((context) => ({
          organizationId: context.organizationId,
          status: context.organization.status,
          currentPolicyRevisionId: context.organization.currentPolicyRevisionId,
          currentPolicy: {
            id: context.currentPolicy.id,
            organizationId: context.currentPolicy.organizationId,
            policy: context.policy,
            policySha256: context.currentPolicy.policySha256,
          },
          actorMembershipRole: context.membership.role,
        })),
        releaseChecks,
      });
      const policyDecision = evaluateArchitectureOrganizationGrantPolicy(authorizationSnapshot, {
        architectureId,
        actorUserId,
        expectedCurrentRevisionId,
        grants: organizationIds.map((organizationId) => ({
          organizationId,
          accessLevel: "read",
          createdUnderPolicyRevisionId: contexts.find((context) => context.organizationId === organizationId)?.currentPolicy.id ?? "",
        })),
      });
      if (!policyDecision.allowed) throw grantPolicyError(policyDecision);

      const persisted = await this.grantStore.replaceArchitectureOrganizationGrants({
        architectureId,
        actorUserId,
        expectedCurrentRevisionId,
        grants: contexts.map((context) => ({
          organizationId: context.organizationId,
          accessLevel: "read",
          createdByUserId: actorUserId,
          createdUnderPolicyRevisionId: context.currentPolicy.id,
        })),
        authorizationSnapshot,
        recordAllowAuditEvent: (audit) => this.architectureStore.recordAuditEvent(audit),
      });
      const result: ReplaceArchitectureOrganizationGrantsResult = {
        architectureId,
        currentRevisionId: expectedCurrentRevisionId,
        grants: persisted.grants,
        organizationIds: persisted.grants.map((grant) => grant.organizationId).sort(compareStrings),
        addedOrganizationIds: persisted.addedOrganizationIds.slice().sort(compareStrings),
        removedOrganizationIds: persisted.removedOrganizationIds.slice().sort(compareStrings),
        changed: persisted.changed,
      };
      return result;
    } catch (error) {
      const normalized = toGrantError(error);
      await this.recordAuditSafe({
        actorUserId,
        action: "architecture.organization-grants.replace",
        resourceType: "architecture",
        resourceId: architectureId,
        details: {
          code: normalized.code,
          organizationCount: organizationIds.length,
        },
      });
      throw normalized;
    }
  }

  async updateOrganizationGrants(
    input: UpdateArchitectureOrganizationGrantsInput,
  ): Promise<UpdateArchitectureOrganizationGrantsResult> {
    return this.replaceOrganizationGrants(input);
  }

  async setOrganizationGrants(
    input: ReplaceArchitectureOrganizationGrantsInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsResult> {
    return this.replaceOrganizationGrants(input);
  }

  async replaceGrants(
    input: ReplaceArchitectureOrganizationGrantsInput,
  ): Promise<ReplaceArchitectureOrganizationGrantsResult> {
    return this.replaceOrganizationGrants(input);
  }

  private async validateOrganizationTarget(input: {
    actorUserId: string;
    architecture: ArchitectureRecord;
    organizationId: string;
    teamParentOrganizationId: string | null;
  }): Promise<ValidatedOrganizationContext> {
    const organization = await this.organizationStore.getOrganization(input.organizationId);
    const membership = await this.organizationStore.findMembership({
      organizationId: input.organizationId,
      userId: input.actorUserId,
    });
    const isCurrentMember = Boolean(membership && membership.removedAt === null);
    if (!organization || !isCurrentMember || organization.status !== "active") {
      throw organizationGrantUnavailable();
    }
    const currentPolicyRevisionId = organization.currentPolicyRevisionId;
    const currentPolicy = currentPolicyRevisionId
      ? await this.organizationStore.getPolicyRevision({
        organizationId: input.organizationId,
        revisionId: currentPolicyRevisionId,
      })
      : null;
    if (!currentPolicy || currentPolicy.id !== currentPolicyRevisionId || currentPolicy.organizationId !== input.organizationId) {
      throw new AppError(
        "Organization policy is unavailable.",
        "ORGANIZATION_POLICY_REQUIRED",
        409,
      );
    }
    let policy;
    try {
      policy = assertValidOrganizationPolicyV1(currentPolicy.policy);
    } catch {
      throw new AppError("Organization policy is invalid.", "ORGANIZATION_POLICY_INVALID", 409);
    }
    if (!policy.sharing.organizationArchitectureSharingEnabled) {
      throw new AppError(
        "Organization policy does not allow architecture sharing.",
        "ORGANIZATION_ARCHITECTURE_SHARING_DISABLED",
        403,
      );
    }

    const isOrganizationAdmin = membership?.role === "owner" || membership?.role === "admin";
    if (input.architecture.owner.type === "user") {
      if (!isOrganizationAdmin) throw organizationGrantUnavailable();
    } else {
      const isParent = input.teamParentOrganizationId === input.organizationId;
      if (isParent) {
        if (!policy.sharing.teamOwnersCanShareArchitecturesToParentOrganization) {
          throw new AppError(
            "Organization policy does not allow team owners to share to the parent organization.",
            "ORGANIZATION_TEAM_PARENT_ARCHITECTURE_SHARING_DISABLED",
            403,
          );
        }
        // isCurrentMember is already required above. A parent grant does not
        // derive membership from the team or from a profile subject.
      } else if (!isOrganizationAdmin) {
        throw organizationGrantUnavailable();
      }
    }
    return {
      organizationId: input.organizationId,
      organization,
      membership: membership as NonNullable<typeof membership>,
      currentPolicy,
      policy,
    };
  }

  /**
   * Load the same current organization facts used by the pure evaluator. This
   * helper intentionally does not apply the target role or sharing gates; it
   * is also used to capture effective parent context for an empty revoke.
   */
  private async loadOrganizationContext(
    actorUserId: string,
    organizationId: string,
  ): Promise<ValidatedOrganizationContext | null> {
    const organization = await this.organizationStore.getOrganization(organizationId);
    const membership = await this.organizationStore.findMembership({ organizationId, userId: actorUserId });
    if (!organization || !membership || membership.removedAt !== null || organization.status !== "active") return null;
    const currentPolicyRevisionId = organization.currentPolicyRevisionId;
    if (!currentPolicyRevisionId) return null;
    const currentPolicy = await this.organizationStore.getPolicyRevision({
      organizationId,
      revisionId: currentPolicyRevisionId,
    });
    if (!currentPolicy || currentPolicy.id !== currentPolicyRevisionId || currentPolicy.organizationId !== organizationId) return null;
    let policy: ReturnType<typeof assertValidOrganizationPolicyV1>;
    try {
      policy = assertValidOrganizationPolicyV1(currentPolicy.policy);
    } catch {
      return null;
    }
    return {
      organizationId,
      organization,
      membership,
      currentPolicy,
      policy,
    };
  }

  private async validateGrantLimits(
    organizationIds: readonly string[],
    contexts: readonly ValidatedOrganizationContext[],
  ): Promise<void> {
    const limits = contexts.map((context) => context.policy.limits.organizationGrantsPerArchitecture);
    const targetLimit = Math.min(...limits, MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS);
    if (organizationIds.length > targetLimit) {
      throw new AppError(
        "The organization architecture grant limit has been reached.",
        "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED",
        409,
        { limit: targetLimit },
      );
    }
  }

  private async validateExactReleases(
    actorUserId: string,
    revision: ArchitectureRevisionRecord,
    contexts: readonly ValidatedOrganizationContext[],
  ): Promise<ArchitectureOrganizationGrantReleaseCheck[]> {
    const checked = new Set<string>();
    const releaseChecks: ArchitectureOrganizationGrantReleaseCheck[] = [];
    for (const context of contexts) {
      for (const skill of revision.spec.skills) {
        if (!ALLOWED_RELEASE_VISIBILITIES.has(skill.packageVisibility)) {
          throw new AppError(
            "Every architecture release must be visible to the target organization.",
            "ARCHITECTURE_RELEASE_NOT_VISIBLE",
            403,
          );
        }
        const key = `${context.organizationId}\u0000${skill.id}\u0000${skill.version}\u0000${skill.digest}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const decision = await this.authorizeRelease({
          actorUserId,
          organizationId: context.organizationId,
          organizationPolicyRevisionId: context.currentPolicy.id,
          organizationPolicySha256: context.currentPolicy.policySha256,
          release: skill,
        });
        const identityMatches = releaseIdentityMatches(skill, decision.release);
        releaseChecks.push({
          organizationId: context.organizationId,
          skill: {
            id: skill.id,
            slug: skill.slug,
            version: skill.version,
            digest: skill.digest,
            packageVisibility: skill.packageVisibility,
          },
          allowed: decision.allowed,
          identityMatches,
          ...(decision.code ? { code: safeReleaseDecisionCode(decision.code) } : {}),
        });
        if (!decision.allowed || !identityMatches) {
          throw new AppError(
            "An architecture release is not visible to the target organization.",
            "ARCHITECTURE_RELEASE_NOT_VISIBLE",
            403,
            { code: safeReleaseDecisionCode(decision.code) },
          );
        }
      }
    }
    return releaseChecks;
  }

  private async authorizeRelease(input: ArchitectureOrganizationGrantReleaseInput): Promise<ArchitectureOrganizationGrantReleaseDecision> {
    const authorizer = this.releaseAuthorizer;
    let result: boolean | ArchitectureOrganizationGrantReleaseDecision;
    try {
      result = typeof authorizer === "function"
        ? await authorizer(input)
        : authorizer.authorizeRelease
          ? await authorizer.authorizeRelease(input)
          : authorizer.isReleaseAuthorized
            ? await authorizer.isReleaseAuthorized(input)
            : false;
    } catch {
      // A release-authorizer failure cannot widen a grant and must not expose
      // registry or provider details through the architecture API.
      return { allowed: false, code: "release_authorizer_unavailable" };
    }
    return typeof result === "boolean" ? { allowed: result } : result ?? { allowed: false };
  }

  private async resolveTeamParentOrganizationId(teamId: string, actorUserId: string): Promise<string | null> {
    if (this.teamParentAuthority) {
      const organizationId = await this.teamParentAuthority.getTeamOrganizationId(teamId);
      return organizationId ?? null;
    }
    if (this.teamStore) {
      const team = (await this.teamStore.listTeamsForUser(actorUserId)).find((candidate) => candidate.id === teamId);
      return team?.organizationId ?? null;
    }
    return null;
  }

  private async isOrganizationVisibilityEnabled(): Promise<boolean> {
    if (typeof this.organizationVisibilityEnabled === "function") {
      try {
        return await this.organizationVisibilityEnabled();
      } catch {
        throw new AppError(
          "Organization sharing setting is unavailable.",
          "ORGANIZATION_SHARING_SETTING_UNAVAILABLE",
          503,
        );
      }
    }
    if (typeof this.organizationVisibilityEnabled === "boolean") return this.organizationVisibilityEnabled;
    if (this.sharingSettingsProvider) {
      try {
        const settings = await this.sharingSettingsProvider.getSharingSettings();
        return settings.organizationVisibilityEnabled === true;
      } catch {
        throw new AppError(
          "Organization sharing setting is unavailable.",
          "ORGANIZATION_SHARING_SETTING_UNAVAILABLE",
          503,
        );
      }
    }
    return false;
  }

  private async recordAuditSafe(input: Parameters<ArchitectureStore["recordAuditEvent"]>[0]): Promise<void> {
    try {
      await this.architectureStore.recordAuditEvent(input);
    } catch {
      // Read and denial audits are best effort. A successful replacement's
      // allow audit is passed to the grant adapter and is required before its
      // state commit, so it does not use this recovery path.
    }
  }
}

interface ValidatedOrganizationContext {
  organizationId: string;
  organization: { id: string; status: OrganizationStatus; currentPolicyRevisionId: string | null };
  membership: { organizationId: string; userId: string; role: OrganizationMembershipRole; removedAt: string | null };
  currentPolicy: OrganizationPolicyRevision;
  policy: ReturnType<typeof assertValidOrganizationPolicyV1>;
}

function isDependencies(input: ArchitectureOrganizationGrantServiceDependencies | ArchitectureStore): input is ArchitectureOrganizationGrantServiceDependencies {
  return Boolean(input && typeof input === "object" && "architectureStore" in input && "organizationStore" in input && "grantStore" in input);
}

function actorId(input: ArchitectureActorInput | undefined): string {
  if (input === undefined || input === null) throw new AppError("Session actor is required.", "ARCHITECTURE_ACTOR_REQUIRED", 401);
  const actor = typeof input === "string"
    ? input
    : "userId" in input
      ? input.userId
      : input.id;
  if (!isIdentifier(actor)) throw new AppError("Session actor is invalid.", "INVALID_ARCHITECTURE_ACTOR", 400);
  return actor;
}

function cleanIdentifier(input: unknown, field: string): string {
  if (!isIdentifier(input)) throw new AppError(`${field} is invalid.`, "INVALID_ARCHITECTURE_IDENTIFIER", 400);
  return input;
}

function normalizeOrganizationIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_ARCHITECTURE_ORGANIZATION_GRANT_TARGETS) {
    throw new AppError(
      "organizationIds must be a bounded array.",
      "INVALID_ARCHITECTURE_ORGANIZATION_GRANTS",
      400,
    );
  }
  const ids = input.map((value) => cleanIdentifier(value, "organizationId"));
  if (new Set(ids).size !== ids.length) {
    throw new AppError(
      "organizationIds must contain one entry per organization.",
      "ARCHITECTURE_ORGANIZATION_GRANT_DUPLICATE",
      400,
    );
  }
  return ids.sort(compareStrings);
}

function normalizeExpectedCurrentRevisionId(input: unknown): string | null {
  if (input === null) return null;
  return cleanIdentifier(input, "expectedCurrentRevisionId");
}

function requireArchitectureManager(architecture: ArchitectureRecord): void {
  if (!architecture.access.canManage) {
    throw new AppError(
      "Architecture owner access is required.",
      "ARCHITECTURE_GRANT_MANAGE_REQUIRED",
      403,
    );
  }
  if (architecture.owner.type !== "user" && architecture.owner.type !== "team") {
    throw new AppError("Architecture owner is invalid.", "INVALID_ARCHITECTURE_OWNER", 400);
  }
}

function releaseIdentityMatches(
  skill: Pick<ArchitectureSkillRef, "id" | "slug" | "version" | "digest" | "packageVisibility">,
  release: ArchitectureOrganizationGrantReleaseProjection | undefined,
): boolean {
  if (!release) return true;
  return (release.id === undefined || release.id === skill.id)
    && (release.slug === undefined || release.slug === skill.slug)
    && (release.version === undefined || release.version === skill.version)
    && (release.digest === undefined || release.digest === skill.digest)
    && (release.packageVisibility === undefined || release.packageVisibility === skill.packageVisibility);
}

function organizationGrantUnavailable(): AppError {
  // Keep organization existence, status, membership, and role failures
  // indistinguishable to a caller outside that organization.
  return new AppError(
    "Organization is unavailable for this architecture grant.",
    "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN",
    403,
  );
}

function architectureNotFound(): AppError {
  return new AppError("Architecture not found.", "ARCHITECTURE_NOT_FOUND", 404);
}

function toGrantError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "Architecture organization grants could not be updated.",
    "ARCHITECTURE_ORGANIZATION_GRANT_FAILED",
    409,
  );
}

function toGrantReadError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "Architecture organization grants could not be read.",
    "ARCHITECTURE_ORGANIZATION_GRANT_READ_FAILED",
    409,
  );
}

function grantPolicyError(decision: ArchitectureOrganizationGrantPolicyDenied): AppError {
  return new AppError(
    architectureOrganizationGrantPolicyFailureMessage(decision.code),
    decision.code,
    decision.statusCode,
    decision.limit === undefined ? undefined : { limit: decision.limit },
  );
}

function safeReleaseDecisionCode(input: unknown): string {
  return typeof input === "string" && /^[a-z][a-z0-9._:-]{0,95}$/.test(input)
    ? input
    : "release_not_visible";
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}
