import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm/alias";
import {
  AppError,
  assertValidOrganizationPolicyV1,
  type ArchitectureOrganizationGrantContext,
  type ArchitectureOrganizationMembership,
  type OrganizationMembershipRole,
  type OrganizationPolicyV1,
  type OrganizationStatus,
  validateArchitectureSpec as validateCoreArchitectureSpec,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  instanceSettings,
  organizationMemberships as organizationMembershipsTable,
  organizationPolicyRevisions,
  organizations,
  skillArtifacts,
  skillArchitectureOrganizationGrants,
  skillArchitectureRevisions,
  skillArchitectures,
  skillOrganizationGrants,
  skillTeamGrants,
  skillUserGrants,
  skillVersions,
  skills,
  teamMemberships,
  teams,
  users,
} from "../db/schema.js";
import {
  architectureAccessForRecord,
  evaluateArchitectureAccess,
  normalizeArchitectureActor,
  normalizeOwnerReference,
  type ArchitectureActor,
  type ArchitectureActorInput,
  type ArchitectureAuditEvent,
  type ArchitectureAuditInput,
  type ArchitectureOwnerReference,
  type ArchitectureRecord,
  type ArchitectureRevisionRecord,
  type ArchitectureSpec,
  type ArchitectureStore,
  type ArchitectureTeamMemberRole,
  type CreateArchitectureInput,
  type CreateArchitectureRevisionInput,
} from "./types.js";
import { evaluateArchitectureRevisionAuthorizationIntent } from "./revision-authorization.js";
import {
  assertArchitectureSpecSize,
  MAX_ARCHITECTURES_PER_OWNER,
  MAX_VISIBLE_ARCHITECTURES,
  MAX_REVISIONS_PER_ARCHITECTURE,
  validateArchitecturePattern,
  validateArchitectureSpec,
} from "./service.js";
import { isEffectiveTeamMembership } from "../teams/effective-membership.js";

/*
 * These optional fields keep the store usable for legacy/fixture callers that
 * deliberately stop at migration 0015 or 0016. The Postgres server wires
 * createPostgresArchitectureReadinessProbe, so this compatibility path is
 * never a readiness signal for the Phase 2 deployment.
 */
type OptionalArchitectureColumn = typeof skillArchitectures.ownerUserId;
type ExtendedArchitectureTable = typeof skillArchitectures & {
  ownerTeamId?: OptionalArchitectureColumn;
  accessPolicyVersion?: OptionalArchitectureColumn;
};
const architectureTable = skillArchitectures as ExtendedArchitectureTable;

interface ArchitectureColumnSupport {
  ownerTeamId: boolean;
  accessPolicyVersion: boolean;
}

interface OrganizationSchemaSupport {
  teamOrganizationId: boolean;
  fullTenancy: boolean;
}

/**
 * Phase 2 architecture services are deployed as one migration program. The
 * server readiness gate uses these IDs and a small set of contract columns so
 * a partially applied schema cannot be reported as usable.
 */
export const PHASE2_ARCHITECTURE_MIGRATION_IDS = [
  "0015_skill_architectures",
  "0016_architecture_owner_tenancy",
  "0017_organizations_and_org_sharing",
  "0018_architecture_targets_and_observations",
  "0019_architecture_sync_control",
  "0020_architecture_pattern_migrations",
] as const;

const PHASE2_ARCHITECTURE_SCHEMA_COLUMNS = {
  skill_architectures: [
    "id",
    "owner_user_id",
    "owner_team_id",
    "access_policy_version",
    "name",
    "description",
    "pattern_id",
    "current_revision_id",
  ],
  skill_architecture_revisions: [
    "id",
    "architecture_id",
    "revision_number",
    "message",
    "spec",
    "created_by_user_id",
  ],
  organizations: ["id", "status", "current_policy_revision_id"],
  organization_policy_revisions: [
    "id",
    "organization_id",
    "revision_number",
    "schema_version",
    "policy",
    "policy_sha256",
  ],
  organization_memberships: ["organization_id", "user_id", "role", "removed_at"],
  organization_invitations: ["organization_id", "normalized_email", "role", "status"],
  teams: ["organization_id"],
  skill_organization_grants: ["skill_id", "organization_id", "created_under_policy_revision_id"],
  skill_architecture_organization_grants: [
    "architecture_id",
    "organization_id",
    "access_level",
    "created_under_policy_revision_id",
  ],
  skill_architecture_targets: [
    "id",
    "architecture_id",
    "owner_user_id",
    "owner_team_id",
    "owner_organization_id",
    "environment_id",
    "profile_id",
    "status",
    "consent_status",
    "capabilities",
    "capabilities_digest",
    "identity_digest",
    "generation",
    "metadata",
    "health_summary",
    "credential_reference",
  ],
  skill_architecture_observations: [
    "id",
    "target_id",
    "generation",
    "adapter_kind",
    "adapter_contract_version",
    "adapter_version",
    "adapter_digest",
    "capabilities_digest",
    "observed_digest",
    "observed_state",
    "counts",
    "health_summary",
    "captured_at",
  ],
  skill_architecture_sync_runs: [
    "id",
    "architecture_id",
    "revision_id",
    "target_id",
    "target_generation",
    "observed_snapshot_id",
    "profile_id",
    "environment_id",
    "actor_user_id",
    "run_kind",
    "status",
    "request_key",
    "idempotency_key",
    "desired_digest",
    "compiled_digest",
    "observed_digest",
    "plan_digest",
    "metadata",
  ],
  skill_architecture_sync_steps: [
    "id",
    "run_id",
    "ordinal",
    "action",
    "node_id",
    "target_generation",
    "status",
    "idempotency_key",
    "desired_digest",
    "compiled_digest",
    "observed_digest",
    "plan_digest",
    "step_digest",
    "metadata",
  ],
  skill_architecture_sync_target_leases: [
    "id",
    "run_id",
    "target_id",
    "target_generation",
    "holder_id",
    "fencing_token",
    "status",
    "expires_at",
    "metadata",
  ],
  skill_architecture_sync_baselines: [
    "id",
    "run_id",
    "target_id",
    "target_generation",
    "observed_digest",
    "baseline_digest",
    "restorable",
    "captured_at",
    "metadata",
  ],
  skill_architecture_sync_receipts: [
    "id",
    "run_id",
    "step_id",
    "target_id",
    "target_generation",
    "fencing_token",
    "kind",
    "status",
    "code",
    "evidence_digest",
    "recorded_at",
    "metadata",
  ],
  skill_architecture_sync_recovery_evidence: [
    "id",
    "run_id",
    "target_id",
    "target_generation",
    "fencing_token",
    "condition",
    "decision",
    "next_run_state",
    "safe_to_retry",
    "requires_manual_review",
    "code",
    "evidence_digest",
    "metadata",
  ],
  skill_architecture_pattern_migrations: [
    "id",
    "source_architecture_id",
    "source_revision_id",
    "source_pattern_id",
    "source_revision_digest",
    "target_architecture_id",
    "target_revision_id",
    "target_pattern_id",
    "target_revision_digest",
    "mapping_status",
    "mapping",
    "diff",
    "migration_digest",
    "diff_digest",
    "actor_user_id",
    "idempotency_key",
  ],
} as const;

type ArchitectureSchemaReadinessDb = Pick<Database, "execute">;

/**
 * Return the bounded readiness probe used by the production Postgres server.
 * The probe throws on a missing migration/table/column; app.ts converts that
 * failure to a 503 and hides Phase 2 capability flags.
 */
export function createPostgresArchitectureReadinessProbe(
  db: ArchitectureSchemaReadinessDb,
): () => Promise<void> {
  return async () => {
    const migrationTable = await db.execute<{ exists: boolean }>(sql`
      select to_regclass(current_schema() || '.schema_migrations') is not null as exists
    `);
    if (migrationTable.rows[0]?.exists !== true) {
      throw new Error("Phase 2 architecture migrations are not recorded.");
    }

    const migrations = await db.execute<{ id: string }>(sql`
      select id
      from schema_migrations
      where id in (
        '0015_skill_architectures',
        '0016_architecture_owner_tenancy',
        '0017_organizations_and_org_sharing',
        '0018_architecture_targets_and_observations',
        '0019_architecture_sync_control',
        '0020_architecture_pattern_migrations'
      )
    `);
    const applied = new Set(migrations.rows.map((row) => row.id));
    const missingMigrations = PHASE2_ARCHITECTURE_MIGRATION_IDS.filter((id) => !applied.has(id));
    if (missingMigrations.length > 0) {
      throw new Error(`Phase 2 architecture migrations are incomplete: ${missingMigrations.join(", ")}.`);
    }

    const columns = await db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name in (
          'skill_architectures',
          'skill_architecture_revisions',
          'organizations',
          'organization_policy_revisions',
          'organization_memberships',
          'organization_invitations',
          'teams',
          'skill_organization_grants',
          'skill_architecture_organization_grants',
          'skill_architecture_targets',
          'skill_architecture_observations',
          'skill_architecture_sync_runs',
          'skill_architecture_sync_steps',
          'skill_architecture_sync_target_leases',
          'skill_architecture_sync_baselines',
          'skill_architecture_sync_receipts',
          'skill_architecture_sync_recovery_evidence',
          'skill_architecture_pattern_migrations'
        )
    `);
    const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const missingColumns: string[] = [];
    for (const [tableName, requiredColumns] of Object.entries(PHASE2_ARCHITECTURE_SCHEMA_COLUMNS)) {
      for (const columnName of requiredColumns) {
        if (!present.has(`${tableName}.${columnName}`)) {
          missingColumns.push(`${tableName}.${columnName}`);
        }
      }
    }
    if (missingColumns.length > 0) {
      throw new Error(`Phase 2 architecture schema is incomplete: ${missingColumns.join(", ")}.`);
    }
  };
}

interface ArchitectureRow {
  id: string;
  ownerUserId: string | null;
  ownerTeamId?: string | null;
  accessPolicyVersion?: number | string | null;
  name: string;
  description: string;
  patternId: string;
  currentRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface PostgresArchitectureStoreOptions {
  /** Test-only barrier used to prove post-preflight revocation is fail-closed. */
  beforeRevisionAuthorizationRecheck?: () => void | Promise<void>;
  /** Test-only failure injection immediately before an allow audit insert. */
  beforeAuditInsert?: (input: ArchitectureAuditInput) => void | Promise<void>;
}

const architectureCurrentOrganizationPolicy = aliasedTable(
  organizationPolicyRevisions,
  "architecture_current_organization_policy",
);
const architectureGrantOrganizationPolicy = aliasedTable(
  organizationPolicyRevisions,
  "architecture_grant_organization_policy",
);
const architectureCurrentRevision = aliasedTable(
  skillArchitectureRevisions,
  "architecture_current_revision",
);

export class PostgresArchitectureStore implements ArchitectureStore {
  readonly kind = "postgres" as const;
  private architectureColumns?: Promise<ArchitectureColumnSupport>;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresArchitectureStoreOptions = {},
  ) {}

  async listArchitectures(actorInput: ArchitectureActorInput): Promise<ArchitectureRecord[]> {
    const actor = await this.resolveActor(actorInput);
    const support = await this.architectureColumnSupport();
    const rows = [
      ...(await this.selectArchitecturesByOwner(this.db, actor.id, support)),
      ...(support.ownerTeamId
        ? await this.selectArchitecturesByTeams(this.db, actor, support)
        : []),
      ...(await this.selectArchitecturesByOrganizations(this.db, actor.id, support)),
    ];
    const uniqueRows = [...new Map(rows.map((row) => {
      const architecture = row.architecture as ArchitectureRow;
      return [architecture.id, row] as const;
    })).values()];
    const records = await Promise.all(uniqueRows.map(async (row) => {
      const architecture = this.toArchitectureRecord(row.architecture, Number(row.revisionCount), actor);
      return this.withCurrentAccess(actor, architecture);
    }));
    return records
      .filter((architecture) => architecture.access.canRead)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
      .slice(0, MAX_VISIBLE_ARCHITECTURES);
  }

  async getArchitecture(actorInput: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const row = await this.selectArchitectureById(this.db, architectureId, await this.architectureColumnSupport());
    if (!row) return null;
    const architecture = await this.withCurrentAccess(
      actor,
      this.toArchitectureRecord(row.architecture, Number(row.revisionCount), actor),
    );
    return architecture.access.canRead ? architecture : null;
  }

  async listRevisions(actorInput: ArchitectureActorInput, architectureId: string): Promise<ArchitectureRevisionRecord[] | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = await this.getArchitectureRow(this.db, architectureId, await this.architectureColumnSupport());
    if (!architecture) return null;
    const record = await this.withCurrentAccess(actor, this.toArchitectureRecord(architecture, undefined, actor));
    if (!record.access.canRead) return null;
    const rows = await this.db
      .select()
      .from(skillArchitectureRevisions)
      .where(eq(skillArchitectureRevisions.architectureId, architecture.id))
      .orderBy(desc(skillArchitectureRevisions.revisionNumber), desc(skillArchitectureRevisions.id))
      .limit(MAX_REVISIONS_PER_ARCHITECTURE);
    return rows
      .slice(0, MAX_REVISIONS_PER_ARCHITECTURE)
      .flatMap((row) => {
        const revision = toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId), record.access);
        return revisionSpecReadableToActor(revision.spec, record.access) ? [revision] : [];
      });
  }

  async getRevision(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
  ): Promise<ArchitectureRevisionRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = await this.getArchitectureRow(this.db, architectureId, await this.architectureColumnSupport());
    if (!architecture) return null;
    const record = await this.withCurrentAccess(actor, this.toArchitectureRecord(architecture, undefined, actor));
    if (!record.access.canRead) return null;
    // Organization readers receive revision summaries through the API, but a
    // raw revision DTO could expose skill references outside that boundary.
    // Parent-owned preview code resolves an exact org-scoped release instead.
    if (record.access.reasons.includes("organization")) return null;
    const conditions = [eq(skillArchitectureRevisions.architectureId, architecture.id)];
    if (revisionId) conditions.push(eq(skillArchitectureRevisions.id, revisionId));
    const [row] = await this.db
      .select()
      .from(skillArchitectureRevisions)
      .where(and(...conditions))
      .orderBy(desc(skillArchitectureRevisions.revisionNumber))
      .limit(1);
    if (!row) return null;
    const revision = toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId), record.access);
    return revisionSpecReadableToActor(revision.spec, record.access) ? revision : null;
  }

  async getRevisionForPreview(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
    organizationId?: string | null,
  ): Promise<ArchitectureRevisionRecord | null> {
    const actor = await this.resolveActor(actorInput);
    const architecture = await this.getArchitectureRow(this.db, architectureId, await this.architectureColumnSupport());
    if (!architecture) return null;
    const record = await this.withCurrentAccess(actor, this.toArchitectureRecord(architecture, undefined, actor));
    if (!record.access.canPreview) return null;
    if (
      record.access.reasons.includes("organization")
      && (!organizationId || !record.access.allowedOrganizationIds.includes(organizationId))
    ) {
      return null;
    }
    const conditions = [eq(skillArchitectureRevisions.architectureId, architecture.id)];
    if (revisionId) conditions.push(eq(skillArchitectureRevisions.id, revisionId));
    const [row] = await this.db
      .select()
      .from(skillArchitectureRevisions)
      .where(and(...conditions))
      .orderBy(desc(skillArchitectureRevisions.revisionNumber))
      .limit(1);
    if (!row) return null;
    const revision = toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId), record.access);
    return revisionSpecReadableToActor(revision.spec, record.access) ? revision : null;
  }

  async createArchitecture(input: CreateArchitectureInput): Promise<ArchitectureRecord>;
  async createArchitecture(actorInput: ArchitectureActorInput, input: CreateArchitectureInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRecord>;
  async createArchitecture(
    first: CreateArchitectureInput | ArchitectureActorInput,
    second?: CreateArchitectureInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRecord> {
    const input = second ?? first as CreateArchitectureInput;
    const owner = normalizeOwnerReference(input);
    if (!owner) {
      throw new AppError("Exactly one architecture owner is required.", "INVALID_ARCHITECTURE_OWNER", 400);
    }
    const actorInput = second ? first as ArchitectureActorInput : input.actor ?? owner.id;
    const support = await this.architectureColumnSupport();
    if (owner.type === "team" && !support.ownerTeamId) {
      throw new AppError("Team-owned architectures are not available yet.", "ARCHITECTURE_TENANCY_UNAVAILABLE", 501);
    }
    return this.db.transaction(async (tx) => {
      const actor = await this.resolveActor(actorInput, tx);
      if (audit) assertArchitectureMutationAudit(audit, actor.id, "architecture.create");
      if (!evaluateArchitectureAccess(actor, owner, "create").allowed) {
        throw new AppError(
          owner.type === "team" ? "Team owner access is required." : "Architecture owner access is required.",
          "ARCHITECTURE_OWNER_REQUIRED",
          403,
        );
      }
      if (owner.type === "user") {
        const [ownerRow] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, owner.id))
          .for("update")
          .limit(1);
        if (!ownerRow) throw new AppError("Architecture owner was not found.", "ARCHITECTURE_NOT_FOUND", 404);
      } else {
        const [team] = await tx
          .select({ id: teams.id })
          .from(teams)
          .where(eq(teams.id, owner.id))
          .for("update")
          .limit(1);
        if (!team) throw new AppError("Architecture team was not found.", "ARCHITECTURE_NOT_FOUND", 404);
        // The preflight actor snapshot is only a hint. Re-resolve team-owner
        // authority after the team/organization locks so a concurrent
        // demotion, removal, or parent lifecycle change cannot commit a
        // stale owner write.
        if (!await assertCurrentRevisionActorAuthority(
          tx,
          actor.id,
          owner,
          await this.organizationSchemaSupport(tx),
        )) {
          throw new AppError("Team owner access is required.", "ARCHITECTURE_OWNER_REQUIRED", 403);
        }
      }
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(skillArchitectures)
        .where(owner.type === "user"
          ? eq(skillArchitectures.ownerUserId, owner.id)
          : eq(architectureTable.ownerTeamId as OptionalArchitectureColumn, owner.id));
      if (Number(count) >= MAX_ARCHITECTURES_PER_OWNER) {
        throw new AppError(
          `An owner may create at most ${MAX_ARCHITECTURES_PER_OWNER} architectures.`,
          "ARCHITECTURE_QUOTA_EXCEEDED",
          409,
        );
      }
      const values: Record<string, unknown> = {
        ownerUserId: owner.type === "user" ? owner.id : null,
        name: input.name,
        description: input.description,
        patternId: input.patternId,
      };
      if (support.ownerTeamId) values.ownerTeamId = owner.type === "team" ? owner.id : null;
      if (support.accessPolicyVersion) values.accessPolicyVersion = 1;
      const [row] = await tx
        .insert(skillArchitectures)
        .values(values as typeof skillArchitectures.$inferInsert)
        .returning(architectureSelection(support));
      if (!row) throw new Error("Architecture insert failed.");
      if (audit) {
        await this.options.beforeAuditInsert?.({ ...audit, resourceId: row.id });
        await insertArchitectureAuditEvent(tx, audit, row.id);
      }
      const record = this.toArchitectureRecord(row as ArchitectureRow, 0, actor);
      return record;
    });
  }

  async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(actorInput: ArchitectureActorInput, input: CreateArchitectureRevisionInput, audit?: ArchitectureAuditInput): Promise<ArchitectureRevisionRecord | null>;
  async createRevision(
    first: CreateArchitectureRevisionInput | ArchitectureActorInput,
    second?: CreateArchitectureRevisionInput,
    audit?: ArchitectureAuditInput,
  ): Promise<ArchitectureRevisionRecord | null> {
    const input = second ?? first as CreateArchitectureRevisionInput;
    const actorInput = second ? first as ArchitectureActorInput : input.actor ?? input.ownerUserId ?? "";
    return this.db.transaction(async (tx) => {
      const support = await this.architectureColumnSupport();
      const organizationSupport = await this.organizationSchemaSupport(tx);
      const architecture = await this.getArchitectureRow(tx, input.architectureId, support, true);
      if (!architecture) return null;
      // The architecture row is the serialization point for current-pointer
      // updates. The hook exists only for deterministic tests that release a
      // separate authority row after the lock and before every recheck below.
      await this.options.beforeRevisionAuthorizationRecheck?.();
      const actor = await this.resolveActor(actorInput, tx, organizationSupport);
      const owner = ownerFromRow(architecture);
      if (!owner || !(await assertCurrentRevisionActorAuthority(tx, actor.id, owner, organizationSupport))) return null;
      const record = await this.withCurrentAccess(actor, this.toArchitectureRecord(architecture, undefined, actor), tx);
      if (!record.access.canAppend) return null;
      if (audit) assertArchitectureMutationAudit(audit, actor.id, "architecture.revision.create", architecture.id);
      if (input.expectedCurrentRevisionId !== architecture.currentRevisionId) {
        throw new AppError(
          "The architecture changed after this draft was opened.",
          "ARCHITECTURE_REVISION_CONFLICT",
          409,
          { currentRevisionId: architecture.currentRevisionId },
        );
      }
      const spec = validateArchitectureSpec(input.spec, validateArchitecturePattern(architecture.patternId));
      assertArchitectureSpecSize(spec);
      const authorization = evaluateArchitectureRevisionAuthorizationIntent({
        actor,
        actorId: actor.id,
        architectureId: architecture.id,
        owner,
        spec,
        authorizationSnapshot: input.authorizationSnapshot,
      });
      if (!authorization.allowed) {
        throw new AppError(
          "The exact architecture release authorization changed before this revision could be saved.",
          "ARCHITECTURE_REVISION_AUTHORIZATION_CONFLICT",
          409,
        );
      }
      await reauthorizeRevisionRegistrySnapshot(tx, {
        actorId: actor.id,
        architectureId: architecture.id,
        owner,
        organizationIds: input.authorizationSnapshot?.organizationIds ?? record.access.allowedOrganizationIds,
        organizationSupport,
        spec,
      });
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(skillArchitectureRevisions)
        .where(eq(skillArchitectureRevisions.architectureId, architecture.id));
      if (Number(count) >= MAX_REVISIONS_PER_ARCHITECTURE) {
        throw new AppError(
          `An architecture may contain at most ${MAX_REVISIONS_PER_ARCHITECTURE} revisions.`,
          "ARCHITECTURE_REVISION_QUOTA_EXCEEDED",
          409,
        );
      }
      const revisionNumber = (await tx
        .select({ max: sql<number>`coalesce(max(${skillArchitectureRevisions.revisionNumber}), 0)` })
        .from(skillArchitectureRevisions)
        .where(eq(skillArchitectureRevisions.architectureId, architecture.id)))[0]?.max ?? 0;
      const nextRevisionNumber = Number(revisionNumber) + 1;
      const [row] = await tx
        .insert(skillArchitectureRevisions)
        .values({
          architectureId: architecture.id,
          revisionNumber: nextRevisionNumber,
          message: input.message,
          spec,
          createdByUserId: actor.id,
        })
        .returning();
      if (!row) throw new Error("Architecture revision insert failed.");
      await tx
        .update(skillArchitectures)
        .set({ currentRevisionId: row.id, updatedAt: new Date() })
        .where(eq(skillArchitectures.id, architecture.id));
      if (audit) {
        const auditInput = withRevisionAuditDetails(audit, row.id, nextRevisionNumber);
        await this.options.beforeAuditInsert?.(auditInput);
        await insertArchitectureAuditEvent(tx, auditInput, architecture.id);
      }
      return toRevisionRecord(row, architecture.id, validateArchitecturePattern(architecture.patternId), record.access);
    });
  }

  async recordAuditEvent(input: ArchitectureAuditInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: input.action,
      decision: "allow",
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
    });
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureAuditEvent[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceType, "skill_architecture"))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(Math.max(1, Math.min(limit, 500)));
    return rows.map((event) => ({
      id: event.id,
      actorUserId: event.actorUserId,
      action: event.action,
      decision: event.decision === "allow" ? "allow" : "deny",
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      details: parseDetails(event.details),
      createdAt: event.createdAt.toISOString(),
    }));
  }

  private architectureColumnSupport(): Promise<ArchitectureColumnSupport> {
    if (!this.architectureColumns) {
      this.architectureColumns = this.loadArchitectureColumnSupport();
    }
    return this.architectureColumns;
  }

  private async loadArchitectureColumnSupport(): Promise<ArchitectureColumnSupport> {
    const result = await this.db.execute<{ column_name: string }>(sql`
      select column_name
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'skill_architectures'
        and column_name in ('owner_team_id', 'access_policy_version')
    `);
    const names = new Set(result.rows.map((row) => row.column_name));
    return {
      ownerTeamId: names.has("owner_team_id") && Boolean(architectureTable.ownerTeamId),
      accessPolicyVersion: names.has("access_policy_version") && Boolean(architectureTable.accessPolicyVersion),
    };
  }

  private async resolveActor(
    actorInput: ArchitectureActorInput,
    db: DbLike = this.db,
    resolvedOrganizationSupport?: OrganizationSchemaSupport,
  ): Promise<ArchitectureActor> {
    const actor = normalizeArchitectureActor(actorInput);
    const organizationSupport = resolvedOrganizationSupport ?? await this.organizationSchemaSupport(db);
    type ResolvedTeamMembership = {
      teamId: string;
      role: ArchitectureTeamMemberRole;
      organizationId: string | null;
      organizationStatus: OrganizationStatus | null;
      organizationMemberId: string | null;
      organizationCurrentPolicyRevisionId: string | null;
      organizationCurrentPolicyId: string | null;
      organizationPolicy: unknown;
    };
    let rows: ResolvedTeamMembership[];
    if (organizationSupport.fullTenancy) {
      rows = (await db
        .select({
          teamId: teamMemberships.teamId,
          role: teamMemberships.role,
          organizationId: teams.organizationId,
          organizationStatus: organizations.status,
          organizationMemberId: organizationMembershipsTable.userId,
          organizationCurrentPolicyRevisionId: organizations.currentPolicyRevisionId,
          organizationCurrentPolicyId: architectureCurrentOrganizationPolicy.id,
          organizationPolicy: architectureCurrentOrganizationPolicy.policy,
        })
        .from(teamMemberships)
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .leftJoin(organizations, eq(organizations.id, teams.organizationId))
        .leftJoin(architectureCurrentOrganizationPolicy, and(
          eq(architectureCurrentOrganizationPolicy.organizationId, teams.organizationId),
          eq(architectureCurrentOrganizationPolicy.id, organizations.currentPolicyRevisionId),
        ))
        .leftJoin(organizationMembershipsTable, and(
          eq(organizationMembershipsTable.organizationId, teams.organizationId),
          eq(organizationMembershipsTable.userId, actor.id),
          isNull(organizationMembershipsTable.removedAt),
        ))
        .where(eq(teamMemberships.userId, actor.id))) as ResolvedTeamMembership[];
    } else if (organizationSupport.teamOrganizationId) {
      // If only part of the organization migration is present, retain the
      // parent id and fail closed for parented teams instead of treating a
      // raw team_memberships row as effective access.
      rows = (await db
        .select({ teamId: teamMemberships.teamId, role: teamMemberships.role, organizationId: teams.organizationId })
        .from(teamMemberships)
        .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
        .where(eq(teamMemberships.userId, actor.id)))
        .map((row) => ({
          teamId: row.teamId,
          role: row.role,
          organizationId: row.organizationId,
          organizationStatus: null,
          organizationMemberId: null,
          organizationCurrentPolicyRevisionId: null,
          organizationCurrentPolicyId: null,
          organizationPolicy: null,
        }));
    } else {
      // The pre-tenancy schema has no parent column, so all rows are
      // standalone. Caller-supplied team ids still remain untrusted.
      rows = (await db
        .select({ teamId: teamMemberships.teamId, role: teamMemberships.role })
        .from(teamMemberships)
        .where(eq(teamMemberships.userId, actor.id)))
        .map((row) => ({
          teamId: row.teamId,
          role: row.role,
          organizationId: null,
          organizationStatus: null,
          organizationMemberId: null,
          organizationCurrentPolicyRevisionId: null,
          organizationCurrentPolicyId: null,
          organizationPolicy: null,
        }));
    }
    const byTeam = new Map<string, ArchitectureTeamMemberRole>();
    for (const row of rows) {
      let policy: OrganizationPolicyV1 | null = null;
      if (row.organizationId !== null) {
        try {
          policy = assertValidOrganizationPolicyV1(row.organizationPolicy);
        } catch {
          policy = null;
        }
      }
      if (!isEffectiveTeamMembership({
        organizationId: row.organizationId,
        organizationStatus: row.organizationStatus ?? undefined,
        currentPolicyRevisionId: row.organizationCurrentPolicyRevisionId,
        hasCurrentPolicy: policy !== null
          && row.organizationCurrentPolicyId === row.organizationCurrentPolicyRevisionId,
        hasActiveOrganizationMembership: row.organizationMemberId === actor.id,
        requireOrganizationMembershipForTeamMembers: policy?.teams.requireOrganizationMembershipForTeamMembers,
      })) {
        continue;
      }
      byTeam.set(row.teamId, strongerRole(byTeam.get(row.teamId), row.role));
    }
    const organizationMemberships = new Map<string, ArchitectureOrganizationMembership["role"]>();
    if (organizationSupport.fullTenancy) {
      const organizationRows = await db
        .select({ organizationId: organizationMembershipsTable.organizationId, role: organizationMembershipsTable.role })
        .from(organizationMembershipsTable)
        .where(and(
          eq(organizationMembershipsTable.userId, actor.id),
          isNull(organizationMembershipsTable.removedAt),
        ));
      for (const row of organizationRows) {
        organizationMemberships.set(
          row.organizationId,
          strongerOrganizationRole(organizationMemberships.get(row.organizationId), row.role as OrganizationMembershipRole),
        );
      }
    }
    return {
      // Keep only canonical membership rows. Caller-supplied teamIds/teams
      // are hints for memory fixtures, not proof of a database membership.
      id: actor.id,
      roles: actor.roles,
      teamMemberships: [...byTeam.entries()].map(([teamId, role]) => ({ teamId, role })),
      organizationMemberships: [...organizationMemberships.entries()]
        .map(([organizationId, role]) => ({ organizationId, role })),
    };
  }

  private async organizationSchemaSupport(db: DbLike): Promise<OrganizationSchemaSupport> {
    const result = await db.execute<{
      team_organization_id: boolean;
      organizations_table: boolean;
      memberships_table: boolean;
      policy_revisions_table: boolean;
    }>(sql`
      select
        exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'teams'
            and column_name = 'organization_id'
        ) as team_organization_id,
        to_regclass(current_schema() || '.organizations') is not null as organizations_table,
        to_regclass(current_schema() || '.organization_memberships') is not null as memberships_table,
        to_regclass(current_schema() || '.organization_policy_revisions') is not null as policy_revisions_table
    `);
    const row = result.rows[0];
    const teamOrganizationId = row?.team_organization_id === true;
    return {
      teamOrganizationId,
      fullTenancy: teamOrganizationId
        && row?.organizations_table === true
        && row.memberships_table === true
        && row.policy_revisions_table === true,
    };
  }

  private async withCurrentAccess(
    actor: ArchitectureActor,
    record: ArchitectureRecord,
    db: DbLike = this.db,
  ): Promise<ArchitectureRecord> {
    const organizationAccess = await this.organizationAccessForArchitecture(actor.id, record.id, db);
    return {
      ...record,
      access: architectureAccessForRecord(actor, record, organizationAccess),
    };
  }

  private async organizationAccessForArchitecture(
    actorId: string,
    architectureId: string,
    db: DbLike = this.db,
  ): Promise<{
    organizationVisibilityEnabled: boolean;
    organizationGrantContexts: ArchitectureOrganizationGrantContext[];
  }> {
    try {
      const [setting] = await db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, "sharing"))
        .limit(1);
      const organizationVisibilityEnabled = hasOrganizationVisibilityEnabled(setting?.value);
      if (!organizationVisibilityEnabled) {
        return { organizationVisibilityEnabled: false, organizationGrantContexts: [] };
      }

      const rows = await db
        .select({
          organizationId: skillArchitectureOrganizationGrants.organizationId,
          accessLevel: skillArchitectureOrganizationGrants.accessLevel,
          grantPolicyRevisionId: skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId,
          grantPolicyOrganizationId: architectureGrantOrganizationPolicy.organizationId,
          organizationStatus: organizations.status,
          currentPolicyRevisionId: organizations.currentPolicyRevisionId,
          currentPolicyOrganizationId: architectureCurrentOrganizationPolicy.organizationId,
          policy: architectureCurrentOrganizationPolicy.policy,
          currentRevisionId: skillArchitectures.currentRevisionId,
          currentRevisionSpec: architectureCurrentRevision.spec,
        })
        .from(skillArchitectureOrganizationGrants)
        .innerJoin(skillArchitectures, eq(skillArchitectures.id, skillArchitectureOrganizationGrants.architectureId))
        .leftJoin(architectureCurrentRevision, and(
          eq(architectureCurrentRevision.id, skillArchitectures.currentRevisionId),
          eq(architectureCurrentRevision.architectureId, skillArchitectures.id),
        ))
        .innerJoin(organizations, eq(organizations.id, skillArchitectureOrganizationGrants.organizationId))
        .innerJoin(architectureGrantOrganizationPolicy, and(
          eq(architectureGrantOrganizationPolicy.id, skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId),
          eq(architectureGrantOrganizationPolicy.organizationId, skillArchitectureOrganizationGrants.organizationId),
          eq(architectureGrantOrganizationPolicy.id, organizations.currentPolicyRevisionId),
        ))
        .innerJoin(architectureCurrentOrganizationPolicy, and(
          eq(architectureCurrentOrganizationPolicy.id, organizations.currentPolicyRevisionId),
          eq(architectureCurrentOrganizationPolicy.organizationId, organizations.id),
        ))
        .innerJoin(organizationMembershipsTable, and(
          eq(organizationMembershipsTable.organizationId, organizations.id),
          eq(organizationMembershipsTable.userId, actorId),
          isNull(organizationMembershipsTable.removedAt),
        ))
        .where(eq(skillArchitectureOrganizationGrants.architectureId, architectureId));

      const contexts: ArchitectureOrganizationGrantContext[] = [];
      for (const row of rows) {
        if (row.accessLevel !== "read") continue;
        // A current pointer that is missing or points at another architecture
        // must fail closed. Otherwise an org grant could bypass the revision
        // reference disclosure check through a malformed current pointer.
        if (row.currentRevisionId !== null
          && (row.currentRevisionSpec === null || !organizationRevisionSpecIsSafe(row.currentRevisionSpec))) continue;
        let policy: OrganizationPolicyV1;
        try {
          policy = assertValidOrganizationPolicyV1(row.policy);
        } catch {
          // A malformed policy must never widen visibility. The schema check
          // protects normal writes, while this keeps older/manual rows fail-closed.
          continue;
        }
        contexts.push({
          organizationId: row.organizationId,
          accessLevel: "read",
          grantPolicyRevisionId: row.grantPolicyRevisionId,
          grantPolicyOrganizationId: row.grantPolicyOrganizationId,
          organizationStatus: row.organizationStatus as OrganizationStatus,
          currentPolicyRevisionId: row.currentPolicyRevisionId,
          currentPolicyOrganizationId: row.currentPolicyOrganizationId,
          policy,
        });
      }
      return {
        organizationVisibilityEnabled,
        organizationGrantContexts: contexts.sort((left, right) => left.organizationId.localeCompare(right.organizationId)),
      };
    } catch (error) {
      if (!isMissingOrganizationSchemaError(error)) throw error;
      // Legacy/fixture callers may stop before migration 0017. The server's
      // Phase 2 readiness probe rejects that state before it is advertised.
      return { organizationVisibilityEnabled: false, organizationGrantContexts: [] };
    }
  }

  private async selectArchitecturesByOwner(
    db: DbLike,
    ownerUserId: string,
    support: ArchitectureColumnSupport,
  ) {
    return db
      .select({
        architecture: architectureSelection(support),
        revisionCount: sql<number>`count(${skillArchitectureRevisions.id})`,
      })
      .from(skillArchitectures)
      .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
      .where(eq(skillArchitectures.ownerUserId, ownerUserId))
      .groupBy(skillArchitectures.id)
      .orderBy(desc(skillArchitectures.updatedAt), desc(skillArchitectures.id))
      .limit(MAX_VISIBLE_ARCHITECTURES);
  }

  private async selectArchitecturesByTeams(
    db: DbLike,
    actor: ArchitectureActor,
    support: ArchitectureColumnSupport,
  ) {
    const teamIds = (actor.teamMemberships ?? []).map((membership) => membership.teamId);
    if (!teamIds.length || !support.ownerTeamId) return [];
    return db
      .select({
        architecture: architectureSelection(support),
        revisionCount: sql<number>`count(${skillArchitectureRevisions.id})`,
      })
      .from(skillArchitectures)
      .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
      .where(inArray(architectureTable.ownerTeamId as OptionalArchitectureColumn, teamIds))
      .groupBy(skillArchitectures.id)
      .orderBy(desc(skillArchitectures.updatedAt), desc(skillArchitectures.id))
      .limit(MAX_VISIBLE_ARCHITECTURES);
  }

  private async selectArchitecturesByOrganizations(
    db: DbLike,
    actorId: string,
    support: ArchitectureColumnSupport,
  ) {
    try {
      const [setting] = await db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, "sharing"))
        .limit(1);
      if (!hasOrganizationVisibilityEnabled(setting?.value)) return [];
      return await db
        .select({
          architecture: architectureSelection(support),
          // One architecture can have multiple organization grants. Count
          // revisions after that join without multiplying each revision by
          // the number of organizations visible to the actor.
          revisionCount: sql<number>`count(distinct ${skillArchitectureRevisions.id})`,
        })
        .from(skillArchitectures)
        .innerJoin(
          skillArchitectureOrganizationGrants,
          and(
            eq(skillArchitectureOrganizationGrants.architectureId, skillArchitectures.id),
            eq(skillArchitectureOrganizationGrants.accessLevel, "read"),
          ),
        )
        .innerJoin(organizationMembershipsTable, and(
          eq(organizationMembershipsTable.organizationId, skillArchitectureOrganizationGrants.organizationId),
          eq(organizationMembershipsTable.userId, actorId),
          isNull(organizationMembershipsTable.removedAt),
        ))
        .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
        .groupBy(skillArchitectures.id)
        .orderBy(desc(skillArchitectures.updatedAt), desc(skillArchitectures.id))
        .limit(MAX_VISIBLE_ARCHITECTURES);
    } catch (error) {
      if (!isMissingOrganizationSchemaError(error)) throw error;
      return [];
    }
  }

  private async selectArchitectureById(db: DbLike, architectureId: string, support: ArchitectureColumnSupport) {
    return db
      .select({
        architecture: architectureSelection(support),
        revisionCount: sql<number>`count(${skillArchitectureRevisions.id})`,
      })
      .from(skillArchitectures)
      .leftJoin(skillArchitectureRevisions, eq(skillArchitectureRevisions.architectureId, skillArchitectures.id))
      .where(eq(skillArchitectures.id, architectureId))
      .groupBy(skillArchitectures.id)
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  private async getArchitectureRow(
    db: DbLike,
    architectureId: string,
    support: ArchitectureColumnSupport,
    forUpdate = false,
  ): Promise<ArchitectureRow | null> {
    const query = db
      .select(architectureSelection(support))
      .from(skillArchitectures)
      .where(eq(skillArchitectures.id, architectureId));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return (rows[0] as ArchitectureRow | undefined) ?? null;
  }

  private toArchitectureRecord(
    row: ArchitectureRow,
    revisionCount = 0,
    actor?: ArchitectureActor,
  ): ArchitectureRecord {
    const owner = ownerFromRow(row);
    if (!owner) throw new AppError("Persisted architecture owner is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
    const record: ArchitectureRecord = {
      id: row.id,
      ownerUserId: row.ownerUserId,
      ownerTeamId: row.ownerTeamId ?? null,
      owner,
      ownerType: owner.type,
      ownerId: owner.id,
      accessPolicyVersion: Number(row.accessPolicyVersion ?? 1),
      access: architectureAccessForRecord(actor ?? { id: owner.id }, {
        owner,
        ownerType: owner.type,
        ownerId: owner.id,
        accessPolicyVersion: Number(row.accessPolicyVersion ?? 1),
      }),
      name: row.name,
      description: row.description,
      patternId: row.patternId as ArchitectureRecord["patternId"],
      currentRevisionId: row.currentRevisionId,
      revisionCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return record;
  }
}

function architectureSelection(support: ArchitectureColumnSupport) {
  const selection: Record<string, unknown> = {
    id: skillArchitectures.id,
    ownerUserId: skillArchitectures.ownerUserId,
    name: skillArchitectures.name,
    description: skillArchitectures.description,
    patternId: skillArchitectures.patternId,
    currentRevisionId: skillArchitectures.currentRevisionId,
    createdAt: skillArchitectures.createdAt,
    updatedAt: skillArchitectures.updatedAt,
  };
  if (support.ownerTeamId && architectureTable.ownerTeamId) selection.ownerTeamId = architectureTable.ownerTeamId;
  if (support.accessPolicyVersion && architectureTable.accessPolicyVersion) selection.accessPolicyVersion = architectureTable.accessPolicyVersion;
  return selection as {
    id: typeof skillArchitectures.id;
    ownerUserId: typeof skillArchitectures.ownerUserId;
    ownerTeamId?: typeof skillArchitectures.ownerUserId;
    accessPolicyVersion?: typeof skillArchitectures.ownerUserId;
    name: typeof skillArchitectures.name;
    description: typeof skillArchitectures.description;
    patternId: typeof skillArchitectures.patternId;
    currentRevisionId: typeof skillArchitectures.currentRevisionId;
    createdAt: typeof skillArchitectures.createdAt;
    updatedAt: typeof skillArchitectures.updatedAt;
  };
}

function ownerFromRow(row: Pick<ArchitectureRow, "ownerUserId" | "ownerTeamId">): ArchitectureOwnerReference | null {
  if (row.ownerTeamId) return { type: "team", id: row.ownerTeamId };
  if (row.ownerUserId) return { type: "user", id: row.ownerUserId };
  return null;
}

/**
 * Re-resolve the append actor after the architecture row is locked. The row
 * locks make membership demotion/removal serialize with this append, including
 * the effective parent-organization checks for organization-owned teams.
 */
async function assertCurrentRevisionActorAuthority(
  db: DbLike,
  actorId: string,
  owner: ArchitectureOwnerReference,
  organizationSupport: OrganizationSchemaSupport,
): Promise<boolean> {
  if (owner.type === "user") {
    const [actor] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, actorId))
      .for("update")
      .limit(1);
    return Boolean(actor && actor.status === "active" && owner.id === actorId);
  }

  // The owner-tenancy migration is optional for legacy fixture callers. Avoid
  // selecting the newer parent column until its presence has been confirmed.
  if (!organizationSupport.teamOrganizationId) {
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, owner.id))
      .for("update")
      .limit(1);
    if (!team) return false;
    const [actor] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, actorId))
      .for("update")
      .limit(1);
    if (!actor || actor.status !== "active") return false;
    const [membership] = await db
      .select({ role: teamMemberships.role })
      .from(teamMemberships)
      .where(and(
        eq(teamMemberships.teamId, owner.id),
        eq(teamMemberships.userId, actorId),
      ))
      .for("update")
      .limit(1);
    return membership?.role === "owner";
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
  if (!hint) return false;
  const [team] = await db
    .select({ id: teams.id, organizationId: teams.organizationId })
    .from(teams)
    .where(eq(teams.id, owner.id))
    .for("update")
    .limit(1);
  if (!team || team.organizationId !== hint.organizationId) return false;

  const organization = team.organizationId && organizationSupport.fullTenancy
    ? await lockRevisionOrganization(db, team.organizationId)
    : null;
  if (team.organizationId && !organizationSupport.fullTenancy) return false;

  if (organization && (organization.status !== "active" || !organization.currentPolicyRevisionId)) return false;
  if (organization) {
    const currentPolicyRevisionId = organization.currentPolicyRevisionId;
    if (!currentPolicyRevisionId) return false;
    const [policy] = await db
      .select({ policy: organizationPolicyRevisions.policy })
      .from(organizationPolicyRevisions)
      .where(and(
        eq(organizationPolicyRevisions.organizationId, organization.id),
        eq(organizationPolicyRevisions.id, currentPolicyRevisionId),
      ))
      .for("update")
      .limit(1);
    if (!policy) return false;
    let parsedPolicy: OrganizationPolicyV1;
    try {
      parsedPolicy = assertValidOrganizationPolicyV1(policy.policy);
    } catch {
      return false;
    }
    const [organizationMembership] = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organization.id),
        eq(organizationMembershipsTable.userId, actorId),
        isNull(organizationMembershipsTable.removedAt),
      ))
      .for("update")
      .limit(1);
    if (!isEffectiveTeamMembership({
      organizationId: organization.id,
      organizationStatus: organization.status as OrganizationStatus,
      currentPolicyRevisionId,
      hasCurrentPolicy: true,
      hasActiveOrganizationMembership: Boolean(organizationMembership),
      requireOrganizationMembershipForTeamMembers: parsedPolicy.teams.requireOrganizationMembershipForTeamMembers,
    })) return false;
  }

  // Match team mutation order: team -> organization -> organization
  // membership/policy -> user -> team membership.
  const [actor] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, actorId))
    .for("update")
    .limit(1);
  if (!actor || actor.status !== "active") return false;
  const [membership] = await db
    .select({ id: teamMemberships.id, role: teamMemberships.role })
    .from(teamMemberships)
    .where(and(
      eq(teamMemberships.teamId, owner.id),
      eq(teamMemberships.userId, actorId),
    ))
    .for("update")
    .limit(1);
  return membership?.role === "owner";
}

interface RevisionRegistrySharingSettings {
  publicVisibilityEnabled: boolean;
  authenticatedVisibilityEnabled: boolean;
  teamsEnabled: boolean;
  teamVisibilityEnabled: boolean;
  userVisibilityEnabled: boolean;
  organizationVisibilityEnabled: boolean;
}

interface RevisionRegistryRelease {
  skillId: string;
  ownerUserId: string | null;
  visibility: string;
  version: string;
  artifactSha256: string;
}

/**
 * Bind each exact skill reference to local registry and tenancy authority while
 * the architecture transaction remains open. External/provider lookups are
 * intentionally outside this boundary; every local row that can revoke the
 * append is locked and checked again here.
 */
async function reauthorizeRevisionRegistrySnapshot(
  db: DbLike,
  input: {
    actorId: string;
    architectureId: string;
    owner: ArchitectureOwnerReference;
    organizationIds: readonly string[];
    organizationSupport: OrganizationSchemaSupport;
    spec: ArchitectureSpec;
  },
): Promise<void> {
  const sharing = await lockRevisionSharingSettings(db);
  const organizationIds = uniqueRevisionStrings(input.organizationIds);
  const references = input.spec.skills.slice().sort((left, right) => (
    left.slug.localeCompare(right.slug)
    || left.version.localeCompare(right.version)
    || left.digest.localeCompare(right.digest)
    || left.packageVisibility.localeCompare(right.packageVisibility)
  ));
  for (const reference of references) {
    const release = await lockExactRevisionRelease(db, reference);
    if (!release) throw revisionReleaseRevalidationFailed();

    if (reference.packageVisibility === "public") {
      if (!sharing.publicVisibilityEnabled) throw revisionReleaseRevalidationFailed();
      continue;
    }
    if (reference.packageVisibility === "authenticated") {
      if (!sharing.authenticatedVisibilityEnabled) throw revisionReleaseRevalidationFailed();
      continue;
    }
    if (reference.packageVisibility === "private") {
      if (input.owner.type !== "user" || release.ownerUserId !== input.actorId) {
        throw revisionReleaseRevalidationFailed();
      }
      continue;
    }
    if (reference.packageVisibility === "explicit-users") {
      if (input.owner.type !== "user"
        || !sharing.userVisibilityEnabled
        || !(await revisionActorHasExplicitUserGrant(db, release.skillId, input.actorId))) {
        throw revisionReleaseRevalidationFailed();
      }
      continue;
    }
    if (reference.packageVisibility === "team") {
      if (!sharing.teamsEnabled || !sharing.teamVisibilityEnabled
        || !(await revisionActorHasTeamReleaseAccess(
          db,
          release.skillId,
          input.actorId,
          input.owner,
          input.organizationSupport,
        ))) {
        throw revisionReleaseRevalidationFailed();
      }
      continue;
    }
    if (!input.organizationSupport.fullTenancy) throw revisionReleaseRevalidationFailed();
    if (!sharing.organizationVisibilityEnabled
      || !(await revisionActorHasOrganizationReleaseAccess(
        db,
        release.skillId,
        input.actorId,
        input.architectureId,
        organizationIds,
      ))) {
      throw revisionReleaseRevalidationFailed();
    }
  }
}

async function lockRevisionSharingSettings(db: DbLike): Promise<RevisionRegistrySharingSettings> {
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

async function lockExactRevisionRelease(
  db: DbLike,
  reference: ArchitectureSpec["skills"][number],
): Promise<RevisionRegistryRelease | null> {
  const rows = await db
    .select({
      skillId: skills.id,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
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
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

async function revisionActorHasExplicitUserGrant(db: DbLike, skillId: string, actorId: string): Promise<boolean> {
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

async function revisionActorHasTeamReleaseAccess(
  db: DbLike,
  skillId: string,
  actorId: string,
  owner: ArchitectureOwnerReference,
  organizationSupport: OrganizationSchemaSupport,
): Promise<boolean> {
  const ownerTeamId = owner.type === "team" ? owner.id : undefined;
  if (!organizationSupport.teamOrganizationId) {
    const rows = await db
      .select({ teamId: skillTeamGrants.teamId })
      .from(skillTeamGrants)
      .innerJoin(teamMemberships, and(
        eq(teamMemberships.teamId, skillTeamGrants.teamId),
        eq(teamMemberships.userId, actorId),
      ))
      .innerJoin(teams, eq(teams.id, skillTeamGrants.teamId))
      .where(and(
        eq(skillTeamGrants.skillId, skillId),
        ownerTeamId ? eq(skillTeamGrants.teamId, ownerTeamId) : undefined,
      ))
      .orderBy(asc(skillTeamGrants.teamId))
      .for("update", { of: [skillTeamGrants, teamMemberships, teams] });
    return rows.length > 0;
  }

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
      ownerTeamId ? eq(skillTeamGrants.teamId, ownerTeamId) : undefined,
    ))
    .orderBy(asc(skillTeamGrants.teamId))
    .for("update", { of: [skillTeamGrants, teamMemberships, teams] });

  for (const row of rows) {
    if (!row.organizationId) return true;
    if (!organizationSupport.fullTenancy) continue;
    const organization = await lockRevisionOrganization(db, row.organizationId);
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
    let parsedPolicy: OrganizationPolicyV1;
    try {
      parsedPolicy = assertValidOrganizationPolicyV1(policy.policy);
    } catch {
      continue;
    }
    const [membership] = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organization.id),
        eq(organizationMembershipsTable.userId, actorId),
        isNull(organizationMembershipsTable.removedAt),
      ))
      .for("update")
      .limit(1);
    if (isEffectiveTeamMembership({
      organizationId: organization.id,
      organizationStatus: organization.status as OrganizationStatus,
      currentPolicyRevisionId: organization.currentPolicyRevisionId,
      hasCurrentPolicy: true,
      hasActiveOrganizationMembership: Boolean(membership),
      requireOrganizationMembershipForTeamMembers: parsedPolicy.teams.requireOrganizationMembershipForTeamMembers,
    })) return true;
  }
  return false;
}

async function revisionActorHasOrganizationReleaseAccess(
  db: DbLike,
  skillId: string,
  actorId: string,
  architectureId: string,
  organizationIds: readonly string[],
): Promise<boolean> {
  for (const organizationId of uniqueRevisionStrings(organizationIds)) {
    const organization = await lockRevisionOrganization(db, organizationId);
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
      if (!assertValidOrganizationPolicyV1(policy.policy).sharing.organizationSkillSharingEnabled) continue;
    } catch {
      continue;
    }
    const [membership] = await db
      .select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organization.id),
        eq(organizationMembershipsTable.userId, actorId),
        isNull(organizationMembershipsTable.removedAt),
      ))
      .for("update")
      .limit(1);
    if (!membership) continue;
    const [skillGrant] = await db
      .select({ skillId: skillOrganizationGrants.skillId })
      .from(skillOrganizationGrants)
      .where(and(
        eq(skillOrganizationGrants.skillId, skillId),
        eq(skillOrganizationGrants.organizationId, organization.id),
        eq(skillOrganizationGrants.createdUnderPolicyRevisionId, organization.currentPolicyRevisionId),
      ))
      .for("update")
      .limit(1);
    if (!skillGrant) continue;
    const [architectureGrant] = await db
      .select({ architectureId: skillArchitectureOrganizationGrants.architectureId })
      .from(skillArchitectureOrganizationGrants)
      .where(and(
        eq(skillArchitectureOrganizationGrants.architectureId, architectureId),
        eq(skillArchitectureOrganizationGrants.organizationId, organization.id),
        eq(skillArchitectureOrganizationGrants.accessLevel, "read"),
        eq(skillArchitectureOrganizationGrants.createdUnderPolicyRevisionId, organization.currentPolicyRevisionId),
      ))
      .for("update")
      .limit(1);
    if (architectureGrant) return true;
  }
  return false;
}

async function lockRevisionOrganization(db: DbLike, organizationId: string) {
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update")
    .limit(1);
  return organization ?? null;
}

function uniqueRevisionStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function revisionReleaseRevalidationFailed(): AppError {
  return new AppError(
    "An exact architecture release changed before this revision could commit.",
    "ARCHITECTURE_REVISION_RELEASE_REVALIDATION_FAILED",
    409,
  );
}

function strongerRole(current: ArchitectureTeamMemberRole | undefined, next: ArchitectureTeamMemberRole): ArchitectureTeamMemberRole {
  return current === "owner" || next === "owner" ? "owner" : "member";
}

function strongerOrganizationRole(
  current: ArchitectureOrganizationMembership["role"] | undefined,
  next: ArchitectureOrganizationMembership["role"],
): ArchitectureOrganizationMembership["role"] {
  if (current === "owner" || next === "owner") return "owner";
  if (current === "admin" || next === "admin") return "admin";
  return "member";
}

function toRevisionRecord(
  row: typeof skillArchitectureRevisions.$inferSelect,
  architectureId: string,
  expectedPatternId: ArchitectureRecord["patternId"],
  access?: ArchitectureRecord["access"],
): ArchitectureRevisionRecord {
  const result = validateCoreArchitectureSpec(row.spec);
  if (!result.valid || result.value.id !== architectureId || result.value.pattern.id !== expectedPatternId) {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
  try {
    assertArchitectureSpecSize(result.value);
  } catch {
    throw new AppError("Persisted architecture revision is invalid.", "PERSISTED_ARCHITECTURE_INVALID", 500);
  }
  return {
    id: row.id,
    architectureId: row.architectureId,
    revisionNumber: row.revisionNumber,
    message: row.message,
    spec: result.value as ArchitectureSpec,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    ...(access ? { access } : {}),
  };
}

function parseDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertArchitectureMutationAudit(
  input: ArchitectureAuditInput,
  actorUserId: string,
  action: "architecture.create" | "architecture.revision.create",
  resourceId?: string,
): void {
  if (
    input.action !== action
    || input.resourceType !== "skill_architecture"
    || input.actorUserId !== actorUserId
    || (resourceId === undefined ? input.resourceId !== undefined && input.resourceId !== null : input.resourceId !== resourceId)
  ) {
    throw new AppError("A valid architecture allow audit is required.", "INVALID_ARCHITECTURE_AUDIT", 400);
  }
}

async function insertArchitectureAuditEvent(
  db: DbLike,
  input: ArchitectureAuditInput,
  resourceId: string,
): Promise<void> {
  await db.insert(auditEvents).values({
    actorUserId: input.actorUserId,
    action: input.action,
    decision: "allow",
    resourceType: "skill_architecture",
    resourceId,
    details: sanitizeAuditDetails(input.details ?? {}),
  });
}

function withRevisionAuditDetails(
  input: ArchitectureAuditInput,
  revisionId: string,
  revisionNumber: number,
): ArchitectureAuditInput {
  return {
    ...input,
    details: {
      ...(input.details ?? {}),
      revisionId,
      revisionNumber,
    },
  };
}

function organizationRevisionSpecIsSafe(input: unknown): boolean {
  const result = validateCoreArchitectureSpec(input);
  return result.valid && result.value.skills.every((skill) => (
    skill.packageVisibility === "public"
    || skill.packageVisibility === "authenticated"
    || skill.packageVisibility === "organization"
  ));
}

function revisionSpecReadableToActor(
  spec: ArchitectureRevisionRecord["spec"],
  access: ArchitectureRecord["access"],
): boolean {
  return !access.reasons.includes("organization") || organizationRevisionSpecIsSafe(spec);
}

function hasOrganizationVisibilityEnabled(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).organizationVisibilityEnabled === true,
  );
}

function isMissingOrganizationSchemaError(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code : undefined;
    if (code === "42P01" || code === "42703" || code === "42704") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
