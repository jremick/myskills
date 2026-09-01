import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  AppError,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  evaluateArchitectureTargetAccess,
  validateOrganizationPolicyV1,
  validateArchitectureTarget,
  validateArchitectureTargetHealth,
  validateArchitectureTargetObservation,
  type ArchitectureTarget,
  type ArchitectureTargetAccessAction,
  type ArchitectureTargetHealth,
  type ArchitectureTargetObservation,
  type ArchitectureTargetOrganizationMembership,
  type ArchitectureTargetOwnerReference,
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
  skillArchitectures,
  skillArchitectureObservations,
  skillArchitectureTargets,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
import { isEffectiveTeamMembership } from "../teams/effective-membership.js";
import type {
  ArchitectureTargetActorInput,
  ArchitectureTargetAuditEvent,
  ArchitectureTargetAuditInput,
  ArchitectureTargetBindingAuthorizationContext,
  ArchitectureTargetRecord,
  ArchitectureTargetStore,
  AppendArchitectureTargetObservationStoreInput,
  RegisterArchitectureTargetStoreInput,
  RevokeArchitectureTargetStoreInput,
  SetArchitectureTargetConsentStoreInput,
  UpdateArchitectureTargetHealthStoreInput,
} from "./types.js";

const CREDENTIAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
// PostgreSQL accepts all UUID variants, including the nil UUID and newer
// time-ordered versions. Do not narrow the persistence boundary to the
// RFC-4122 versions emitted by the default generator.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^target-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const OBSERVATION_ID_PATTERN = /^observation-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PRIVATE_AUDIT_KEY_PATTERN = /(?:^|[^a-z0-9])(?:api-key|authorization|credential|cookie|password|private-key|secret|token|prompt|path|endpoint|url|package|content|config|root|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)(?:$|[^a-z0-9])/i;

type TargetRow = typeof skillArchitectureTargets.$inferSelect;
type ObservationRow = typeof skillArchitectureObservations.$inferSelect;
type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const MAX_TARGETS = 500;
const MAX_OBSERVATIONS = 500;

export interface PostgresArchitectureTargetStoreOptions {
  /** Test-only failure injection immediately before the allow audit insert. */
  beforeAuditInsert?: () => void | Promise<void>;
  /** Test-only hook between the target lock and authority revalidation. */
  beforeMutationAuthorizationRecheck?: (targetId: string) => void | Promise<void>;
}

export class PostgresArchitectureTargetStore implements ArchitectureTargetStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresArchitectureTargetStoreOptions = {},
  ) {}

  async listTargets(actorInput: ArchitectureTargetActorInput): Promise<ArchitectureTargetRecord[]> {
    const actor = await this.resolveActor(actorInput);
    const teamIds = actor.teamMemberships.map((membership) => membership.teamId);
    const organizationIds = actor.organizationMemberships.map((membership) => membership.organizationId);
    const rows = await this.db
      .select()
      .from(skillArchitectureTargets)
      .where(targetOwnerPredicate(actor.userId, teamIds, organizationIds))
      .orderBy(desc(skillArchitectureTargets.updatedAt), desc(skillArchitectureTargets.id))
      .limit(MAX_TARGETS);
    return rows
      .map((row) => toTargetRecord(row))
      .filter((target) => evaluateArchitectureTargetAccess({
        owner: target.owner,
        status: target.status,
        actor,
        action: "list",
      }).allowed);
  }

  async getTarget(actorInput: ArchitectureTargetActorInput, targetId: string): Promise<ArchitectureTargetRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const row = await this.getTargetRow(targetDbId(targetId));
    if (!row) return null;
    const target = toTargetRecord(row);
    return evaluateArchitectureTargetAccess({
      owner: target.owner,
      status: target.status,
      actor,
      action: "read",
    }).allowed
      ? target
      : null;
  }

  async getTargetAccess(
    actorInput: ArchitectureTargetActorInput,
    targetId: string,
    action: ArchitectureTargetAccessAction,
  ) {
    const actor = await this.resolveActor(actorInput);
    const row = await this.getTargetRow(targetDbId(targetId));
    if (!row) return null;
    const target = toTargetRecord(row);
    return evaluateArchitectureTargetAccess({ owner: target.owner, status: target.status, actor, action });
  }

  async registerTarget(input: RegisterArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord> {
    const validation = validateArchitectureTarget(input.target);
    if (!validation.valid) {
      throw new AppError("Architecture target is invalid.", "INVALID_ARCHITECTURE_TARGET", 400, {
        issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
      });
    }
    if (input.credentialReference !== null
      && (typeof input.credentialReference !== "string" || !CREDENTIAL_REFERENCE_PATTERN.test(input.credentialReference))) {
      throw new AppError("Credential reference is invalid.", "INVALID_TARGET_CREDENTIAL_REFERENCE", 400);
    }
    const target = validation.value;
    assertRegistrationAudit(input.audit, target);
    try {
      return await this.db.transaction(async (tx) => {
        // Binding authorization is performed against the architecture store
        // before this call. Recheck its non-secret context while holding the
        // architecture/tenancy rows so a concurrent revocation cannot turn a
        // stale preflight into a persisted target.
        await this.recheckRegistrationAuthorization(tx, target, input.authorization);
        const [row] = await tx
          .insert(skillArchitectureTargets)
          .values({
            id: targetDbId(target.id),
            schemaVersion: target.schemaVersion,
            architectureId: target.architectureId,
            ownerUserId: target.owner.type === "user" ? target.owner.id : null,
            ownerTeamId: target.owner.type === "team" ? target.owner.id : null,
            ownerOrganizationId: target.owner.type === "organization" ? target.owner.id : null,
            name: target.name,
            adapterKind: target.adapter.kind,
            adapterContractVersion: target.adapter.contractVersion,
            adapterVersion: target.adapter.version,
            environmentId: target.environmentId,
            profileId: target.profileId,
            status: target.status,
            consentStatus: target.consent.status,
            consentRequestedAt: new Date(target.consent.requestedAt),
            consentGrantedAt: target.consent.grantedAt ? new Date(target.consent.grantedAt) : null,
            consentDeniedAt: target.consent.deniedAt ? new Date(target.consent.deniedAt) : null,
            consentRevokedAt: target.consent.revokedAt ? new Date(target.consent.revokedAt) : null,
            capabilities: target.capabilities,
            capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities),
            identityDigest: target.identityDigest,
            generation: target.generation,
            metadata: target.metadata ?? {},
            healthSummary: {},
            credentialReference: input.credentialReference,
          })
          .returning();
        if (!row) throw new Error("Architecture target insert failed.");
        await this.insertAllowAudit(tx, input.audit);
        return toTargetRecord(row);
      });
    } catch (error) {
      throw mapTargetPersistenceError(error, "Architecture target could not be registered.", "ARCHITECTURE_TARGET_REGISTER_FAILED");
    }
  }

  async setConsent(input: SetArchitectureTargetConsentStoreInput): Promise<ArchitectureTargetRecord | null> {
    const targetId = targetDbId(input.targetId);
    if (input.decision !== "grant" && input.decision !== "deny") {
      throw new AppError("Target consent decision is invalid.", "INVALID_TARGET_CONSENT_DECISION", 400);
    }
    assertMutationAudit(input.audit, `architecture-target.consent.${input.decision}`, input.targetId);
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.getTargetRow(targetId, tx, true);
        if (!row) return null;
        const target = toTargetRecord(row);
        await this.options.beforeMutationAuthorizationRecheck?.(input.targetId);
        const actor = await this.resolveMutationActor(input.actor, target, tx);
        if (!actor) return null;
        const access = evaluateArchitectureTargetAccess({
          owner: target.owner,
          status: target.status,
          actor,
          action: "register",
        });
        if (!access.allowed || target.status === "revoked" || target.consent.status === "revoked") return null;

        const now = new Date();
        const healthStatus = target.health?.status ?? "degraded";
        const [updated] = await tx
          .update(skillArchitectureTargets)
          .set(input.decision === "grant"
            ? {
              consentStatus: "granted",
              consentGrantedAt: now,
              consentDeniedAt: null,
              consentRevokedAt: null,
              status: healthStatus === "healthy" ? "connected" : "degraded",
              updatedAt: now,
            }
            : {
              consentStatus: "denied",
              consentGrantedAt: null,
              consentDeniedAt: now,
              consentRevokedAt: null,
              status: "degraded",
              updatedAt: now,
            })
          .where(eq(skillArchitectureTargets.id, targetId))
          .returning();
        if (!updated) return null;
        const record = toTargetRecord(updated);
        await this.insertAllowAudit(tx, input.audit);
        return record;
      });
    } catch (error) {
      throw mapTargetPersistenceError(error, "Target consent could not be updated.", "ARCHITECTURE_TARGET_CONSENT_FAILED");
    }
  }

  async appendObservation(input: AppendArchitectureTargetObservationStoreInput): Promise<ArchitectureTargetObservation | null> {
    const targetId = targetDbId(input.targetId);
    assertMutationAudit(input.audit, "architecture-target.observation.append", input.targetId);
    try {
      return await this.db.transaction(async (tx) => {
        // Serialize observation appends with target lifecycle changes. This
        // makes generation, consent, and revocation checks authoritative for
        // the write that follows them.
        const row = await this.getTargetRow(targetId, tx, true);
        if (!row) return null;
        const target = toTargetRecord(row);
        await this.options.beforeMutationAuthorizationRecheck?.(input.targetId);
        const actor = await this.resolveMutationActor(input.actor, target, tx);
        if (!actor) return null;
        const access = evaluateArchitectureTargetAccess({
          owner: target.owner,
          status: target.status,
          actor,
          action: "observe",
        });
        if (!access.allowed || target.status === "revoked" || target.consent.status !== "granted") return null;

        const validation = validateArchitectureTargetObservation(input.observation);
        if (!validation.valid) {
          throw new AppError("Target observation is invalid.", "INVALID_ARCHITECTURE_TARGET_OBSERVATION", 400, {
            issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
          });
        }
        const observation = validation.value;
        if (targetDbId(observation.targetId) !== row.id) {
          throw new AppError("Observation targetId does not match the target.", "ARCHITECTURE_TARGET_OBSERVATION_TARGET_MISMATCH", 409);
        }
        if (observation.targetGeneration !== target.generation) {
          throw new AppError("Observation generation is stale for this target.", "ARCHITECTURE_TARGET_GENERATION_MISMATCH", 409, {
            expectedGeneration: target.generation,
          });
        }
        const expectedAdapterDigest = architectureTargetAdapterDigest(target.adapter);
        if (observation.adapterDigest !== expectedAdapterDigest) {
          throw new AppError("Observation adapter digest does not match the current target binding.", "ARCHITECTURE_TARGET_ADAPTER_DIGEST_MISMATCH", 409);
        }
        const expectedCapabilitiesDigest = architectureTargetCapabilitiesDigest(target.capabilities);
        if (observation.capabilitiesDigest !== expectedCapabilitiesDigest) {
          throw new AppError(
            "Observation capability digest does not match the current target binding.",
            "ARCHITECTURE_TARGET_CAPABILITIES_DIGEST_MISMATCH",
            409,
          );
        }

        const [stored] = await tx
          .insert(skillArchitectureObservations)
          .values({
            ...(observation.id ? { id: observationDbId(observation.id) } : {}),
            schemaVersion: observation.schemaVersion,
            targetId: row.id,
            generation: observation.targetGeneration,
            adapterKind: target.adapter.kind,
            adapterContractVersion: target.adapter.contractVersion,
            adapterVersion: target.adapter.version,
            adapterDigest: observation.adapterDigest,
            capabilitiesDigest: observation.capabilitiesDigest,
            observedDigest: observation.observedDigest,
            observedState: observation,
            counts: {
              skillCount: observation.skills.length,
              configFindingCount: observation.configFindings.length,
            },
            healthSummary: {},
            capturedAt: new Date(observation.observedAt),
          })
          .returning();
        if (!stored) throw new Error("Architecture target observation insert failed.");
        const storedObservation = observationFromRow(stored);
        await this.insertAllowAudit(tx, input.audit);
        return storedObservation;
      });
    } catch (error) {
      throw mapTargetPersistenceError(
        error,
        "Target observation could not be appended.",
        "ARCHITECTURE_TARGET_OBSERVATION_FAILED",
      );
    }
  }

  async listObservations(input: {
    actor: ArchitectureTargetActorInput;
    targetId: string;
    limit?: number;
  }): Promise<ArchitectureTargetObservation[] | null> {
    const actor = await this.resolveActor(input.actor);
    const targetId = targetDbId(input.targetId);
    const row = await this.getTargetRow(targetId);
    if (!row) return null;
    const target = toTargetRecord(row);
    const access = evaluateArchitectureTargetAccess({
      owner: target.owner,
      status: target.status,
      actor,
      action: "read",
    });
    if (!access.allowed) return null;
    const limit = boundedLimit(input.limit);
    const rows = await this.db
      .select()
      .from(skillArchitectureObservations)
      .where(eq(skillArchitectureObservations.targetId, targetId))
      .orderBy(desc(skillArchitectureObservations.capturedAt), desc(skillArchitectureObservations.id))
      .limit(limit);
    return rows.map(observationFromRow);
  }

  async updateHealth(input: UpdateArchitectureTargetHealthStoreInput): Promise<ArchitectureTargetRecord | null> {
    const validation = validateArchitectureTargetHealth(input.health);
    if (!validation.valid) {
      throw new AppError("Target health is invalid.", "INVALID_ARCHITECTURE_TARGET_HEALTH", 400, {
        issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
      });
    }
    const targetId = targetDbId(input.targetId);
    assertMutationAudit(input.audit, "architecture-target.health.update", input.targetId);
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.getTargetRow(targetId, tx, true);
        if (!row) return null;
        const target = toTargetRecord(row);
        await this.options.beforeMutationAuthorizationRecheck?.(input.targetId);
        const actor = await this.resolveMutationActor(input.actor, target, tx);
        if (!actor) return null;
        const access = evaluateArchitectureTargetAccess({
          owner: target.owner,
          status: target.status,
          actor,
          action: "health",
        });
        if (!access.allowed || target.status === "revoked") return null;
        assertHealthIsCurrent(target.health, validation.value);
        const now = new Date();
        const [updated] = await tx
          .update(skillArchitectureTargets)
          .set({
            healthSummary: validation.value,
            status: target.consent.status === "granted" && validation.value.status === "healthy" ? "connected" : "degraded",
            updatedAt: now,
          })
          .where(eq(skillArchitectureTargets.id, targetId))
          .returning();
        if (!updated) return null;
        const record = toTargetRecord(updated);
        await this.insertAllowAudit(tx, input.audit);
        return record;
      });
    } catch (error) {
      throw mapTargetPersistenceError(error, "Target health could not be updated.", "ARCHITECTURE_TARGET_HEALTH_FAILED");
    }
  }

  async revokeTarget(input: RevokeArchitectureTargetStoreInput): Promise<ArchitectureTargetRecord | null> {
    const targetId = targetDbId(input.targetId);
    assertMutationAudit(input.audit, "architecture-target.revoke", input.targetId);
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.getTargetRow(targetId, tx, true);
        if (!row) return null;
        const target = toTargetRecord(row);
        await this.options.beforeMutationAuthorizationRecheck?.(input.targetId);
        const actor = await this.resolveMutationActor(input.actor, target, tx);
        if (!actor) return null;
        const readAccess = evaluateArchitectureTargetAccess({
          owner: target.owner,
          status: target.status,
          actor,
          action: "read",
        });
        if (target.status === "revoked") return readAccess.allowed ? target : null;
        const access = evaluateArchitectureTargetAccess({
          owner: target.owner,
          status: target.status,
          actor,
          action: "revoke",
        });
        if (!access.allowed) return null;

        const now = new Date();
        const [updated] = await tx
          .update(skillArchitectureTargets)
          .set({
            status: "revoked",
            consentStatus: "revoked",
            consentGrantedAt: null,
            consentDeniedAt: null,
            consentRevokedAt: now,
            credentialReference: null,
            updatedAt: now,
          })
          .where(eq(skillArchitectureTargets.id, targetId))
          .returning();
        if (!updated) return null;
        const record = toTargetRecord(updated);
        await this.insertAllowAudit(tx, input.audit);
        return record;
      });
    } catch (error) {
      throw mapTargetPersistenceError(error, "Target could not be revoked.", "ARCHITECTURE_TARGET_REVOKE_FAILED");
    }
  }

  async recordAuditEvent(input: ArchitectureTargetAuditInput): Promise<void> {
    await insertTargetAuditEvent(this.db, input);
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureTargetAuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "skill_architecture_target"))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(boundedLimit(limit, MAX_OBSERVATIONS));
    return rows.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId ?? "",
      action: event.action,
      decision: event.decision === "allow" ? "allow" : "deny",
      targetId: event.resourceId,
      details: parseObject(event.details),
      createdAt: event.createdAt.toISOString(),
    }));
  }

  private async getTargetRow(targetId: string, db: DbLike = this.db, forUpdate = false): Promise<TargetRow | null> {
    const query = db
      .select()
      .from(skillArchitectureTargets)
      .where(eq(skillArchitectureTargets.id, targetId));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return rows[0] ?? null;
  }

  private async insertAllowAudit(db: DbLike, input: ArchitectureTargetAuditInput): Promise<void> {
    await this.options.beforeAuditInsert?.();
    await insertTargetAuditEvent(db, input);
  }

  private async resolveMutationActor(
    actorInput: ArchitectureTargetActorInput,
    target: ArchitectureTargetRecord,
    db: DbLike,
  ) {
    const userId = actorId(actorInput);
    if (!await lockTargetMutationAuthority(db, target.owner, userId)) return null;
    return this.resolveActor(userId, db);
  }

  private async recheckRegistrationAuthorization(
    db: DbLike,
    target: ArchitectureTarget,
    authorizationInput?: ArchitectureTargetBindingAuthorizationContext,
  ): Promise<void> {
    const authorization = normalizeRegistrationAuthorization(authorizationInput, target);
    if (!authorization) {
      throw new AppError(
        "Target binding authorization context is required.",
        "ARCHITECTURE_TARGET_BINDING_AUTHORIZATION_REQUIRED",
        403,
      );
    }

    const [architecture] = await db
      .select({
        id: skillArchitectures.id,
        ownerUserId: skillArchitectures.ownerUserId,
        ownerTeamId: skillArchitectures.ownerTeamId,
        currentRevisionId: skillArchitectures.currentRevisionId,
      })
      .from(skillArchitectures)
      .where(eq(skillArchitectures.id, target.architectureId))
      .for("update")
      .limit(1);
    if (!architecture || architecture.currentRevisionId !== authorization.currentRevisionId) {
      throw new AppError(
        "The architecture binding changed before registration completed.",
        "ARCHITECTURE_TARGET_BINDING_STALE",
        409,
      );
    }

    let parentOrganizationId: string | null = null;
    if (target.owner.type === "user") {
      if (architecture.ownerUserId !== target.owner.id || architecture.ownerTeamId !== null) {
        throw registrationBindingForbidden();
      }
    } else if (target.owner.type === "team") {
      if (architecture.ownerTeamId !== target.owner.id || architecture.ownerUserId !== null) {
        throw registrationBindingForbidden();
      }
      // Team-owned target registration follows the same aggregate lock order
      // as team mutations: team, then its parent organization, then the
      // membership rows. The first read is only a scope hint; re-read the
      // parent after the team lock so a concurrent adoption cannot authorize
      // against stale standalone-team state.
      const [teamHint] = await db
        .select({ id: teams.id, organizationId: teams.organizationId })
        .from(teams)
        .where(eq(teams.id, target.owner.id))
        .limit(1);
      if (!teamHint) throw registrationBindingForbidden();
      const team = await lockTeam(db, target.owner.id);
      if (team.organizationId !== teamHint.organizationId) throw registrationBindingForbidden();
      parentOrganizationId = team.organizationId;
      if (team.organizationId !== null) await lockOrganizationContext(db, team.organizationId, authorization.actorUserId);
      await lockTeamMembership(db, team.id, authorization.actorUserId);
    } else {
      await lockOrganizationTargetContext(db, target.architectureId, target.owner.id, authorization.actorUserId);
    }

    const actor = await this.resolveActor(authorization.actorUserId, db);
    const access = evaluateArchitectureTargetAccess({
      owner: target.owner,
      status: target.status,
      actor,
      action: "register",
    });
    if (!access.allowed) throw registrationBindingForbidden();

    // Parent organization authority is part of the team-owner check above.
    // Keep this explicit so a future owner policy cannot accidentally treat a
    // raw team membership as sufficient for a parented target.
    if (target.owner.type === "team" && parentOrganizationId !== null
      && !actor.teamMemberships.some((membership) => membership.teamId === target.owner.id)) {
      throw registrationBindingForbidden();
    }
  }

  private async resolveActor(actorInput: ArchitectureTargetActorInput, db: DbLike = this.db) {
    const userId = actorId(actorInput);
    const [teamRows, organizationRows] = await Promise.all([
      db
        .select({
          teamId: teamMemberships.teamId,
          role: teamMemberships.role,
          organizationId: teams.organizationId,
          organizationStatus: organizations.status,
          organizationCurrentPolicyRevisionId: organizations.currentPolicyRevisionId,
          organizationCurrentPolicyId: organizationPolicyRevisions.id,
          organizationPolicy: organizationPolicyRevisions.policy,
          organizationMemberId: organizationMemberships.userId,
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
        .where(eq(teamMemberships.userId, userId)),
      db
        .select({ organizationId: organizationMemberships.organizationId, role: organizationMemberships.role })
        .from(organizationMemberships)
        .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
        .innerJoin(organizationPolicyRevisions, and(
          eq(organizationPolicyRevisions.organizationId, organizations.id),
          eq(organizationPolicyRevisions.id, organizations.currentPolicyRevisionId),
        ))
        .where(and(
          eq(organizationMemberships.userId, userId),
          isNull(organizationMemberships.removedAt),
          eq(organizations.status, "active"),
        )),
    ]);
    return {
      userId,
      teamMemberships: teamRows
        .filter((membership) => {
          const policy = validateOrganizationPolicyV1(membership.organizationPolicy);
          return isEffectiveTeamMembership({
            organizationId: membership.organizationId,
            organizationStatus: membership.organizationStatus ?? undefined,
            currentPolicyRevisionId: membership.organizationCurrentPolicyRevisionId,
            hasCurrentPolicy: policy.valid
              && membership.organizationCurrentPolicyId === membership.organizationCurrentPolicyRevisionId,
            hasActiveOrganizationMembership: membership.organizationMemberId === userId,
            requireOrganizationMembershipForTeamMembers: policy.valid
              ? policy.value.teams.requireOrganizationMembershipForTeamMembers
              : undefined,
          });
        })
        .map((membership) => ({
          teamId: membership.teamId,
          role: membership.role === "owner" ? "owner" as const : "member" as const,
        }))
        .sort((left, right) => left.teamId.localeCompare(right.teamId)),
      organizationMemberships: organizationRows
        .map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role as ArchitectureTargetOrganizationMembership["role"],
        }))
        .sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
    };
  }
}

/**
 * Lock every authority row that can change a target mutation decision after
 * the target row is locked. Team-owned targets follow the shared team ->
 * parent organization -> policy/membership -> user -> team-membership order.
 */
async function lockTargetMutationAuthority(
  db: DbLike,
  owner: ArchitectureTargetOwnerReference,
  actorUserId: string,
): Promise<boolean> {
  if (owner.type === "user") {
    const actor = await lockActiveUser(db, actorUserId);
    return actor && owner.id === actorUserId;
  }

  if (owner.type === "organization") {
    if (!await lockOrganizationMutationContext(db, owner.id)) return false;
    const [membership] = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(and(
        eq(organizationMemberships.organizationId, owner.id),
        eq(organizationMemberships.userId, actorUserId),
        isNull(organizationMemberships.removedAt),
      ))
      .for("update")
      .limit(1);
    if (!membership) return false;
    return Boolean(await lockActiveUser(db, actorUserId));
  }

  const [teamHint] = await db
    .select({ organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, owner.id))
    .limit(1);
  if (!teamHint) return false;
  const [team] = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, owner.id))
    .for("update")
    .limit(1);
  if (!team || team.organizationId !== teamHint.organizationId) return false;

  if (team.organizationId !== null) {
    if (!await lockEffectiveTeamOrganizationContext(db, team.organizationId, actorUserId)) return false;
  }

  if (!await lockActiveUser(db, actorUserId)) return false;
  const [teamMembership] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, owner.id),
      eq(teamMemberships.userId, actorUserId),
    ))
    .for("update")
    .limit(1);
  return Boolean(teamMembership);
}

async function lockOrganizationMutationContext(db: DbLike, organizationId: string): Promise<boolean> {
  const [organization] = await db
    .select({ id: organizations.id, status: organizations.status, currentPolicyRevisionId: organizations.currentPolicyRevisionId })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization || organization.status !== "active" || organization.currentPolicyRevisionId === null) return false;
  const [policy] = await db
    .select({ policy: organizationPolicyRevisions.policy })
    .from(organizationPolicyRevisions)
    .where(and(
      eq(organizationPolicyRevisions.organizationId, organizationId),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
    ))
    .for("update")
    .limit(1);
  return Boolean(policy && validateOrganizationPolicyV1(policy.policy).valid);
}

async function lockActiveUser(db: DbLike, userId: string): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .for("update")
    .limit(1);
  return Boolean(user && user.status === "active");
}

async function lockTeam(db: DbLike, teamId: string): Promise<typeof teams.$inferSelect> {
  const [team] = await db
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .for("update")
    .limit(1);
  if (!team) throw registrationBindingForbidden();
  return team;
}

async function lockTeamMembership(db: DbLike, teamId: string, userId: string): Promise<void> {
  const [membership] = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, teamId),
      eq(teamMemberships.userId, userId),
    ))
    .for("update")
    .limit(1);
  if (!membership) throw registrationBindingForbidden();
}

async function lockOrganizationContext(db: DbLike, organizationId: string, userId: string): Promise<void> {
  if (!await lockEffectiveTeamOrganizationContext(db, organizationId, userId)) {
    throw registrationBindingForbidden();
  }
}

async function lockEffectiveTeamOrganizationContext(
  db: DbLike,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [organization] = await db
    .select({
      id: organizations.id,
      status: organizations.status,
      currentPolicyRevisionId: organizations.currentPolicyRevisionId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization || organization.status !== "active" || organization.currentPolicyRevisionId === null) {
    return false;
  }
  const [policy] = await db
    .select({ id: organizationPolicyRevisions.id, policy: organizationPolicyRevisions.policy })
    .from(organizationPolicyRevisions)
    .where(and(
      eq(organizationPolicyRevisions.organizationId, organizationId),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
    ))
    .for("update")
    .limit(1);
  if (!policy) return false;
  const policyValidation = validateOrganizationPolicyV1(policy.policy);
  if (!policyValidation.valid) return false;
  const [membership] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, organizationId),
      eq(organizationMemberships.userId, userId),
      isNull(organizationMemberships.removedAt),
    ))
      .for("update")
      .limit(1);
  return isEffectiveTeamMembership({
    organizationId,
    organizationStatus: organization.status,
    currentPolicyRevisionId: organization.currentPolicyRevisionId,
    hasCurrentPolicy: policy.id === organization.currentPolicyRevisionId,
    hasActiveOrganizationMembership: Boolean(membership),
    requireOrganizationMembershipForTeamMembers: policyValidation.value.teams.requireOrganizationMembershipForTeamMembers,
  });
}

async function lockOrganizationTargetContext(
  db: DbLike,
  architectureId: string,
  organizationId: string,
  userId: string,
): Promise<void> {
  const [setting] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "sharing"))
    .for("update")
    .limit(1);
  if (!hasOrganizationVisibilityEnabled(setting?.value)) throw registrationBindingForbidden();

  const [organization] = await db
    .select({
      id: organizations.id,
      status: organizations.status,
      currentPolicyRevisionId: organizations.currentPolicyRevisionId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization || organization.status !== "active" || organization.currentPolicyRevisionId === null) {
    throw registrationBindingForbidden();
  }
  const [policy] = await db
    .select({ id: organizationPolicyRevisions.id, policy: organizationPolicyRevisions.policy })
    .from(organizationPolicyRevisions)
    .where(and(
      eq(organizationPolicyRevisions.organizationId, organizationId),
      eq(organizationPolicyRevisions.id, organization.currentPolicyRevisionId),
    ))
    .for("update")
    .limit(1);
  const policyValidation = policy ? validateOrganizationPolicyV1(policy.policy) : { valid: false as const };
  if (!policy || !policyValidation.valid || !policyValidation.value.sharing.organizationArchitectureSharingEnabled) {
    throw registrationBindingForbidden();
  }

  const [membership] = await db
    .select({ id: organizationMemberships.id, role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, organizationId),
      eq(organizationMemberships.userId, userId),
      isNull(organizationMemberships.removedAt),
    ))
    .for("update")
    .limit(1);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw registrationBindingForbidden();
  }

  const [grant] = await db
    .select({
      accessLevel: skillArchitectureOrganizationGrants.accessLevel,
      createdUnderPolicyRevisionId: skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId,
    })
    .from(skillArchitectureOrganizationGrants)
    .where(and(
      eq(skillArchitectureOrganizationGrants.architectureId, architectureId),
      eq(skillArchitectureOrganizationGrants.organizationId, organizationId),
    ))
    .for("update")
    .limit(1);
  if (!grant
    || grant.accessLevel !== "read"
    || grant.createdUnderPolicyRevisionId !== organization.currentPolicyRevisionId) {
    throw registrationBindingForbidden();
  }
}

function normalizeRegistrationAuthorization(
  input: ArchitectureTargetBindingAuthorizationContext | undefined,
  target: ArchitectureTarget,
): ArchitectureTargetBindingAuthorizationContext | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (typeof input.actorUserId !== "string" || !UUID_PATTERN.test(input.actorUserId)) return null;
  if (input.currentRevisionId !== null
    && (typeof input.currentRevisionId !== "string" || !UUID_PATTERN.test(input.currentRevisionId))) return null;
  if (!input.owner || typeof input.owner !== "object" || Array.isArray(input.owner)) return null;
  if (input.owner.type !== target.owner.type
    || typeof input.owner.id !== "string"
    || input.owner.id.toLowerCase() !== target.owner.id.toLowerCase()) return null;
  if (typeof input.architectureId !== "string"
    || typeof input.environmentId !== "string"
    || typeof input.profileId !== "string") return null;
  if (input.architectureId.toLowerCase() !== target.architectureId.toLowerCase()
    || input.environmentId !== target.environmentId
    || input.profileId !== target.profileId) return null;
  return {
    actorUserId: input.actorUserId.toLowerCase(),
    owner: { type: input.owner.type, id: input.owner.id.toLowerCase() },
    architectureId: input.architectureId.toLowerCase(),
    environmentId: input.environmentId,
    profileId: input.profileId,
    currentRevisionId: input.currentRevisionId === null ? null : input.currentRevisionId.toLowerCase(),
  };
}

function registrationBindingForbidden(): AppError {
  return new AppError(
    "The actor cannot bind this architecture target.",
    "ARCHITECTURE_TARGET_BINDING_FORBIDDEN",
    403,
  );
}

function hasOrganizationVisibilityEnabled(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).organizationVisibilityEnabled === true,
  );
}

function targetOwnerPredicate(userId: string, teamIds: string[], organizationIds: string[]): SQL {
  const predicates = [eq(skillArchitectureTargets.ownerUserId, userId)];
  if (teamIds.length > 0) predicates.push(inArray(skillArchitectureTargets.ownerTeamId, teamIds));
  if (organizationIds.length > 0) predicates.push(inArray(skillArchitectureTargets.ownerOrganizationId, organizationIds));
  return predicates.length === 1 ? predicates[0]! : or(...predicates)!;
}

function ownerFromRow(row: TargetRow): ArchitectureTargetOwnerReference {
  if (row.ownerUserId) return { type: "user", id: row.ownerUserId };
  if (row.ownerTeamId) return { type: "team", id: row.ownerTeamId };
  return { type: "organization", id: row.ownerOrganizationId ?? "" };
}

function toTargetRecord(row: TargetRow): ArchitectureTargetRecord {
  const target: ArchitectureTarget = {
    schemaVersion: row.schemaVersion as 1,
    id: row.id,
    name: row.name,
    owner: ownerFromRow(row),
    adapter: {
      kind: row.adapterKind,
      version: row.adapterVersion,
      contractVersion: row.adapterContractVersion as 1,
    },
    architectureId: row.architectureId,
    environmentId: row.environmentId,
    profileId: row.profileId,
    status: row.status,
    consent: {
      status: row.consentStatus,
      requestedAt: row.consentRequestedAt.toISOString(),
      ...(row.consentGrantedAt ? { grantedAt: row.consentGrantedAt.toISOString() } : {}),
      ...(row.consentDeniedAt ? { deniedAt: row.consentDeniedAt.toISOString() } : {}),
      ...(row.consentRevokedAt ? { revokedAt: row.consentRevokedAt.toISOString() } : {}),
    },
    generation: row.generation,
    identityDigest: row.identityDigest,
    capabilities: parseObject(row.capabilities),
    metadata: parseObject(row.metadata) as ArchitectureTarget["metadata"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  const validation = validateArchitectureTarget(target);
  if (!validation.valid) {
    throw new AppError("Persisted architecture target is invalid.", "PERSISTED_ARCHITECTURE_TARGET_INVALID", 500, {
      issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
    });
  }
  if (architectureTargetCapabilitiesDigest(validation.value.capabilities) !== row.capabilitiesDigest) {
    throw new AppError("Persisted architecture target digest is invalid.", "PERSISTED_ARCHITECTURE_TARGET_INVALID", 500);
  }
  const health = healthFromRow(row);
  return {
    ...validation.value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    health,
  };
}

function healthFromRow(row: TargetRow): ArchitectureTargetHealth | null {
  const health = parseObject(row.healthSummary);
  if (Object.keys(health).length === 0) return null;
  const validation = validateArchitectureTargetHealth(health);
  if (!validation.valid) {
    throw new AppError("Persisted architecture target health is invalid.", "PERSISTED_ARCHITECTURE_TARGET_INVALID", 500, {
      issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
    });
  }
  return validation.value;
}

function observationFromRow(row: ObservationRow): ArchitectureTargetObservation {
  const validation = validateArchitectureTargetObservation(row.observedState);
  if (!validation.valid) {
    throw new AppError("Persisted target observation is invalid.", "PERSISTED_ARCHITECTURE_TARGET_OBSERVATION_INVALID", 500, {
      issueCodes: [...new Set(validation.errors.map((error) => error.code))].sort(),
    });
  }
  const observation = validation.value;
  if (
    targetDbId(observation.targetId) !== row.targetId
    || observation.targetGeneration !== row.generation
    || observation.adapterDigest !== row.adapterDigest
    || observation.capabilitiesDigest !== row.capabilitiesDigest
    || observation.observedDigest !== row.observedDigest
    || (observation.id !== undefined && observationDbId(observation.id) !== row.id)
  ) {
    throw new AppError("Persisted target observation does not match its immutable envelope.", "PERSISTED_ARCHITECTURE_TARGET_OBSERVATION_INVALID", 500);
  }
  return observation;
}

function parseObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? structuredClone(input) as Record<string, unknown>
    : {};
}

async function insertTargetAuditEvent(db: DbLike, input: ArchitectureTargetAuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    action: input.action,
    decision: input.decision,
    resourceType: "skill_architecture_target",
    resourceId: input.targetId ? targetDbId(input.targetId) : null,
    details: safeTargetAuditDetails(input.details ?? {}),
  });
}

function targetDbId(value: string): string {
  const prefixed = TARGET_ID_PATTERN.exec(value);
  if (prefixed) return prefixed[1]!.toLowerCase();
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  throw new AppError("Target id is invalid.", "INVALID_TARGET_IDENTIFIER", 400);
}

function observationDbId(value: string): string {
  const prefixed = OBSERVATION_ID_PATTERN.exec(value);
  if (prefixed) return prefixed[1]!.toLowerCase();
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  throw new AppError("Observation id is invalid.", "INVALID_TARGET_IDENTIFIER", 400);
}

function safeTargetAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isPrivateAuditKey(key))
      .map(([key, child]) => [key, strip(child)]));
  };
  return sanitizeAuditDetails(strip(input) as Record<string, unknown>);
}

function isPrivateAuditKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
  return PRIVATE_AUDIT_KEY_PATTERN.test(normalized);
}

function actorId(input: ArchitectureTargetActorInput): string {
  const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
  const userId = typeof input === "string" ? input : record?.userId ?? record?.id;
  if (typeof userId !== "string") throw new AppError("Target actor id is invalid.", "INVALID_TARGET_ACTOR", 400);
  if (record && Object.keys(record).some((key) => key !== "id" && key !== "userId")) {
    throw new AppError("Target actor fields are invalid.", "INVALID_TARGET_ACTOR", 400);
  }
  if (record?.userId && record.id && record.userId !== record.id) {
    throw new AppError("Target actor id is ambiguous.", "INVALID_TARGET_ACTOR", 400);
  }
  if (!UUID_PATTERN.test(userId)) throw new AppError("Target actor id is invalid.", "INVALID_TARGET_ACTOR", 400);
  return userId.toLowerCase();
}

function assertRegistrationAudit(
  input: ArchitectureTargetAuditInput | undefined,
  target: ArchitectureTarget,
): void {
  if (!input
    || input.action !== "architecture-target.register"
    || input.decision !== "allow"
    || input.targetId !== target.id
    || typeof input.actorUserId !== "string"
    || input.actorUserId.length === 0) {
    throw new AppError(
      "A valid registration allow audit is required.",
      "INVALID_ARCHITECTURE_TARGET_AUDIT",
      400,
    );
  }
}

function assertMutationAudit(
  input: ArchitectureTargetAuditInput | undefined,
  action: string,
  targetId: string,
): void {
  let matchingTarget = false;
  try {
    matchingTarget = input?.targetId !== undefined
      && input.targetId !== null
      && targetDbId(input.targetId) === targetDbId(targetId);
  } catch {
    matchingTarget = false;
  }
  if (!input
    || input.action !== action
    || input.decision !== "allow"
    || !matchingTarget
    || typeof input.actorUserId !== "string"
    || !UUID_PATTERN.test(input.actorUserId)) {
    throw new AppError(
      "A valid target mutation allow audit is required.",
      "INVALID_ARCHITECTURE_TARGET_AUDIT",
      400,
    );
  }
}

function assertHealthIsCurrent(
  current: ArchitectureTargetHealth | null,
  next: ArchitectureTargetHealth,
): void {
  if (!current || Date.parse(next.checkedAt) >= Date.parse(current.checkedAt)) return;
  throw new AppError(
    "Target health update is older than the current health record.",
    "ARCHITECTURE_TARGET_HEALTH_STALE",
    409,
    { currentCheckedAt: current.checkedAt, requestedCheckedAt: next.checkedAt },
  );
}

function boundedLimit(input: number | undefined, maximum = MAX_OBSERVATIONS): number {
  if (!Number.isFinite(input) || input === undefined || input <= 0) return 100;
  return Math.min(Math.floor(input), maximum);
}

function mapTargetPersistenceError(error: unknown, message: string, code: string): AppError {
  if (error instanceof AppError) return error;
  const pgError = findPgError(error);
  if (pgError) {
    if (pgError.code === "23505") {
      if (pgError.constraint?.includes("observations")) {
        return new AppError("Target observation already exists.", "ARCHITECTURE_TARGET_OBSERVATION_ALREADY_EXISTS", 409);
      }
      if (pgError.constraint?.includes("targets")) {
        return new AppError("Architecture target already exists.", "ARCHITECTURE_TARGET_ALREADY_EXISTS", 409);
      }
      return new AppError(message, code, 409);
    }
    if (pgError.code === "23503") return new AppError(message, code, 409);
    if (pgError.code === "23514" || pgError.code === "22P02") return new AppError(message, code, 400);
  }
  return new AppError(message, code, 409);
}

function findPgError(error: unknown): { code: string; constraint?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return null;
}
