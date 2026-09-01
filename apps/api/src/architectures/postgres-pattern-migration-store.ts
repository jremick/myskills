import { and, desc, eq } from "drizzle-orm";
import {
  AppError,
  architectureDigest,
  architecturePatternIds,
  architecturePatternMigrationDiffDigest,
  architecturePatternMigrationDigest,
  canonicalizeJson,
  sha256Hex,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  skillArchitecturePatternMigrations,
  skillArchitectureRevisions,
  skillArchitectures,
} from "../db/schema.js";
import type {
  ArchitecturePatternMigrationArchitectureAggregate,
  ArchitecturePatternMigrationAuditEvent,
  ArchitecturePatternMigrationAuditInput,
  ArchitecturePatternMigrationCreateStoreInput,
  ArchitecturePatternMigrationCreateStoreResult,
  ArchitecturePatternMigrationPersistedRecord,
  ArchitecturePatternMigrationStore,
} from "./pattern-migration-service.js";
import { assertPatternMigrationAllowAudit } from "./pattern-migration-service.js";
import { assertCurrentActorAuthority, reauthorizeInternalRegistrySnapshot } from "./postgres-pattern-migration-authorization.js";
import {
  assertRecordOwnerMetadata,
  ownerFromDb,
  parseArchitectureSpec,
  migrationValue,
  sameOwner,
  toPersistedRecord,
  type DbLike,
  type PatternMigrationRow,
  validateDiff,
  validateMapping,
} from "./postgres-pattern-migration-records.js";

export interface PostgresPatternMigrationStoreOptions {
  /** Test-only failure injection. It is called after the three target writes are staged. */
  beforeLineageInsert?: () => void | Promise<void>;
  /** Test-only failure injection immediately before the required allow audit insert. */
  beforeAuditInsert?: () => void | Promise<void>;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_AUDIT_LIMIT = 500;

const AUDIT_DETAIL_KEYS = new Set([
  "sourceArchitectureId",
  "sourceRevisionId",
  "sourcePatternId",
  "targetPatternId",
  "targetArchitectureId",
  "targetRevisionId",
  "sourceRevisionDigest",
  "targetRevisionDigest",
  "migrationDigest",
  "diffDigest",
  "code",
  "preservedSkillRefCount",
  "preservedLeafNodeCount",
  "addedRouterNodeCount",
  "droppedRouterNodeCount",
  "addedEdgeCount",
  "removedEdgeCount",
  "rewrittenBindingCount",
]);

/**
 * PostgreSQL persistence for derive-shell pattern migrations.
 *
 * The source architecture row is the serialization point for concurrent
 * creates. The target shell, first revision, current pointer, and lineage are
 * written in one transaction. No grants, targets, observations, or sync rows
 * are selected or copied here. Release authorization is an injected API
 * precheck, followed by a database-local exact registry snapshot recheck
 * under row locks. External provider state cannot be made atomic by this
 * adapter, but internal MySkills release, visibility, grant, membership, and
 * organization policy changes cannot commit between the recheck and shell
 * commit.
 */
export class PostgresPatternMigrationStore implements ArchitecturePatternMigrationStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly db: Database,
    private readonly options: PostgresPatternMigrationStoreOptions = {},
  ) {}

  async getByIdempotencyKey(actorId: string, idempotencyKey: string): Promise<ArchitecturePatternMigrationPersistedRecord | null> {
    const actor = validateUuid(actorId, "actorId");
    const key = validateIdentifier(idempotencyKey, "idempotencyKey");
    try {
      const row = await this.selectByActorKey(this.db, actor, key);
      return row ? toPersistedRecord(this.db, row) : null;
    } catch (error) {
      throw mapPersistenceError(error, "Pattern migration could not be read.", "ARCHITECTURE_PATTERN_MIGRATION_READ_FAILED");
    }
  }

  /** Alias retained for route/service composition. */
  async getPatternMigrationByIdempotencyKey(actorId: string, idempotencyKey: string): Promise<ArchitecturePatternMigrationPersistedRecord | null> {
    return this.getByIdempotencyKey(actorId, idempotencyKey);
  }

  async createDerivedShell(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    validateCreateInput(input);
    assertPatternMigrationAllowAudit(input.audit, input.actorId, input.targetArchitecture.id);
    const actorId = validateUuid(input.actorId, "actorId");
    const idempotencyKey = validateIdentifier(input.lineage.idempotencyKey, "idempotencyKey");
    const expectedIntentDigest = intentDigestFromCandidate(input);
    if (expectedIntentDigest !== input.intentDigest) {
      throw new AppError(
        "Pattern migration intent digest does not match the candidate.",
        "ARCHITECTURE_PATTERN_MIGRATION_INTENT_CONFLICT",
        409,
      );
    }

    try {
      return await this.db.transaction(async (tx) => {
        // The initial lookup makes already-committed replay cheap and lets a
        // replay proceed even if the source current pointer has advanced.
        let existing = await this.selectByActorKey(tx, actorId, idempotencyKey, true);
        if (existing) {
          return this.replayExisting(tx, input, existing);
        }

        const source = await this.lockSource(tx, input);

        // A concurrent request may have committed while this transaction was
        // waiting on the source lock. Re-read the unique key after the lock.
        existing = await this.selectByActorKey(tx, actorId, idempotencyKey, true);
        if (existing) {
          return this.replayExisting(tx, input, existing);
        }

        await assertCurrentActorAuthority(tx, actorId, source.architecture);
        assertSourceCandidateMatches(input, source.architecture, source.revision);
        await reauthorizeInternalRegistrySnapshot(tx, {
          actorId,
          architectureId: source.architecture.id,
          owner: ownerFromDb(source.architecture.ownerUserId, source.architecture.ownerTeamId),
          organizationIds: input.sourceArchitecture.access.allowedOrganizationIds,
          spec: parseArchitectureSpec(input.targetRevision.spec, input.targetArchitecture.id, input.targetArchitecture.patternId),
        });

        await tx.insert(skillArchitectures).values({
          id: input.targetArchitecture.id,
          ownerUserId: input.targetArchitecture.ownerUserId,
          ownerTeamId: input.targetArchitecture.ownerTeamId,
          accessPolicyVersion: input.targetArchitecture.accessPolicyVersion,
          name: input.targetArchitecture.name,
          description: input.targetArchitecture.description,
          patternId: input.targetArchitecture.patternId,
          // The composite FK is deferred by migration 0019. Starting with a
          // null pointer keeps this write safe on older compatible schemas too.
          currentRevisionId: null,
          createdAt: toDate(input.targetArchitecture.createdAt, "targetArchitecture.createdAt"),
          updatedAt: toDate(input.targetArchitecture.updatedAt, "targetArchitecture.updatedAt"),
        });

        await tx.insert(skillArchitectureRevisions).values({
          id: input.targetRevision.id,
          architectureId: input.targetRevision.architectureId,
          revisionNumber: input.targetRevision.revisionNumber,
          message: input.targetRevision.message,
          spec: input.targetRevision.spec,
          createdByUserId: input.targetRevision.createdByUserId,
          createdAt: toDate(input.targetRevision.createdAt, "targetRevision.createdAt"),
        });

        const [pointerUpdate] = await tx
          .update(skillArchitectures)
          .set({
            currentRevisionId: input.targetRevision.id,
            updatedAt: toDate(input.targetArchitecture.updatedAt, "targetArchitecture.updatedAt"),
          })
          .where(eq(skillArchitectures.id, input.targetArchitecture.id))
          .returning({ id: skillArchitectures.id });
        if (!pointerUpdate) {
          throw new AppError("Derived architecture shell could not be finalized.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
        }

        await this.options.beforeLineageInsert?.();
        await tx.insert(skillArchitecturePatternMigrations).values({
          id: input.lineage.id,
          schemaVersion: input.lineage.schemaVersion,
          mode: input.lineage.mode,
          sourceArchitectureId: input.lineage.sourceArchitectureId,
          sourceRevisionId: input.lineage.sourceRevisionId,
          sourcePatternId: input.lineage.sourcePatternId,
          sourceRevisionDigest: input.lineage.sourceRevisionDigest,
          targetArchitectureId: input.lineage.targetArchitectureId,
          targetRevisionId: input.lineage.targetRevisionId,
          targetPatternId: input.lineage.targetPatternId,
          targetRevisionDigest: input.lineage.targetRevisionDigest,
          mappingStatus: input.lineage.mappingStatus,
          mapping: input.lineage.mapping,
          diff: input.lineage.diff,
          migrationDigest: input.lineage.migrationDigest,
          diffDigest: input.lineage.diffDigest,
          actorUserId: actorId,
          idempotencyKey,
          createdAt: toDate(input.lineage.createdAt, "lineage.createdAt"),
        });

        await this.insertAllowAudit(tx, input.audit);

        const committed = await this.selectByTarget(tx, input.targetArchitecture.id, true);
        if (!committed) {
          throw new Error("Pattern migration commit could not be read back.");
        }
        return {
          record: await toPersistedRecord(tx, committed),
          replayed: false,
        };
      });
    } catch (error) {
      // If the source rows differed, the unique actor/key insert can race
      // independently. Re-read only that exact actor/key and replay when the
      // stable intent matches; every other unique conflict remains a conflict.
      const pgError = findPgError(error);
      if (pgError?.code === "23505" && pgError.constraint?.includes("actor_idempotency")) {
        const existing = await this.getByIdempotencyKey(actorId, idempotencyKey);
        if (existing && intentDigestFromPersisted(existing) === input.intentDigest) {
          return { record: existing, replayed: true };
        }
        throw idempotencyConflict();
      }
      throw mapPersistenceError(error, "Pattern migration could not be created.", "ARCHITECTURE_PATTERN_MIGRATION_CREATE_FAILED");
    }
  }

  /** Alias retained for callers using the full operation name. */
  async createPatternMigration(input: ArchitecturePatternMigrationCreateStoreInput): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    return this.createDerivedShell(input);
  }

  async recordAuditEvent(input: ArchitecturePatternMigrationAuditInput): Promise<void> {
    const action = boundedString(input.action, "action", 120);
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new AppError("Audit decision is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_INVALID", 400);
    }
    const details = sanitizeMigrationAuditDetails(input.details ?? {});
    try {
      await this.db.insert(auditEvents).values({
        // Denials may be emitted before the actor is resolved. The canonical
        // audit table permits a null actor for that case.
        actorUserId: isUuid(input.actorUserId) ? input.actorUserId : null,
        action,
        decision: input.decision,
        resourceType: "skill_architecture_pattern_migration",
        resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
        details,
      });
    } catch (error) {
      throw mapPersistenceError(error, "Pattern migration audit event could not be recorded.", "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_FAILED");
    }
  }

  private async insertAllowAudit(db: DbLike, input: ArchitecturePatternMigrationAuditInput): Promise<void> {
    await this.options.beforeAuditInsert?.();
    await insertPatternMigrationAuditEvent(db, input);
  }

  async listAuditEvents(limit = 100): Promise<ArchitecturePatternMigrationAuditEvent[]> {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_AUDIT_LIMIT) : 100;
    try {
      const rows = await this.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.resourceType, "skill_architecture_pattern_migration"))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(bounded);
      return rows.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId ?? "",
        action: row.action,
        decision: row.decision === "allow" ? "allow" : "deny",
        resourceId: row.resourceId,
        details: parseObject(row.details),
        createdAt: row.createdAt.toISOString(),
      }));
    } catch (error) {
      throw mapPersistenceError(error, "Pattern migration audit events could not be read.", "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_READ_FAILED");
    }
  }

  private async selectByActorKey(
    db: DbLike,
    actorId: string,
    idempotencyKey: string,
    forUpdate = false,
  ): Promise<PatternMigrationRow | null> {
    const query = db
      .select({
        lineage: skillArchitecturePatternMigrations,
        targetArchitecture: skillArchitectures,
        targetRevision: skillArchitectureRevisions,
      })
      .from(skillArchitecturePatternMigrations)
      .innerJoin(skillArchitectures, eq(skillArchitectures.id, skillArchitecturePatternMigrations.targetArchitectureId))
      .innerJoin(skillArchitectureRevisions, and(
        eq(skillArchitectureRevisions.id, skillArchitecturePatternMigrations.targetRevisionId),
        eq(skillArchitectureRevisions.architectureId, skillArchitecturePatternMigrations.targetArchitectureId),
      ))
      .where(and(
        eq(skillArchitecturePatternMigrations.actorUserId, actorId),
        eq(skillArchitecturePatternMigrations.idempotencyKey, idempotencyKey),
      ));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return rows[0] ?? null;
  }

  private async selectByTarget(db: DbLike, targetArchitectureId: string, forUpdate = false): Promise<PatternMigrationRow | null> {
    const query = db
      .select({
        lineage: skillArchitecturePatternMigrations,
        targetArchitecture: skillArchitectures,
        targetRevision: skillArchitectureRevisions,
      })
      .from(skillArchitecturePatternMigrations)
      .innerJoin(skillArchitectures, eq(skillArchitectures.id, skillArchitecturePatternMigrations.targetArchitectureId))
      .innerJoin(skillArchitectureRevisions, and(
        eq(skillArchitectureRevisions.id, skillArchitecturePatternMigrations.targetRevisionId),
        eq(skillArchitectureRevisions.architectureId, skillArchitecturePatternMigrations.targetArchitectureId),
      ))
      .where(eq(skillArchitecturePatternMigrations.targetArchitectureId, targetArchitectureId));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return rows[0] ?? null;
  }

  private async lockSource(db: DbLike, input: ArchitecturePatternMigrationCreateStoreInput): Promise<LockedSource> {
    const [architecture] = await db
      .select()
      .from(skillArchitectures)
      .where(eq(skillArchitectures.id, input.sourceArchitecture.id))
      .for("update")
      .limit(1);
    if (!architecture) {
      throw new AppError("Architecture not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    if (architecture.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new AppError(
        "The architecture changed after this migration was opened.",
        "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT",
        409,
        { currentRevisionId: architecture.currentRevisionId },
      );
    }
    if (!architecture.currentRevisionId) {
      throw new AppError("Architecture has no current revision.", "ARCHITECTURE_PATTERN_MIGRATION_REVISION_CONFLICT", 409);
    }
    const [revision] = await db
      .select()
      .from(skillArchitectureRevisions)
      .where(and(
        eq(skillArchitectureRevisions.architectureId, architecture.id),
        eq(skillArchitectureRevisions.id, architecture.currentRevisionId),
      ))
      .for("update")
      .limit(1);
    if (!revision) {
      throw new AppError("Architecture revision not found.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_REVISION_NOT_FOUND", 404);
    }
    return { architecture, revision };
  }

  private async replayExisting(
    db: DbLike,
    input: ArchitecturePatternMigrationCreateStoreInput,
    row: PatternMigrationRow,
  ): Promise<ArchitecturePatternMigrationCreateStoreResult> {
    const record = await toPersistedRecord(db, row);
    if (intentDigestFromPersisted(record) !== input.intentDigest) {
      throw idempotencyConflict();
    }
    const [source] = await db
      .select()
      .from(skillArchitectures)
      .where(eq(skillArchitectures.id, record.lineage.sourceArchitectureId))
      .for("update")
      .limit(1);
    if (!source) {
      throw new AppError("Architecture not found.", "ARCHITECTURE_NOT_FOUND", 404);
    }
    await assertCurrentActorAuthority(db, input.actorId, source);
    return { record, replayed: true };
  }

}

/** Compatibility alias for route wiring and future naming migrations. */
export const PostgresArchitecturePatternMigrationStore = PostgresPatternMigrationStore;

/** Structural aggregate marker for callers that compose a separate architecture read store. */
export type PostgresPatternMigrationArchitectureAggregate = ArchitecturePatternMigrationArchitectureAggregate;

interface LockedSource {
  architecture: typeof skillArchitectures.$inferSelect;
  revision: typeof skillArchitectureRevisions.$inferSelect;
}

function validateCreateInput(input: ArchitecturePatternMigrationCreateStoreInput): void {
  if (!input || typeof input !== "object") throw invalidStoreInput();
  if (!isRecord(input.sourceArchitecture) || !isRecord(input.sourceRevision) || !isRecord(input.targetArchitecture)
    || !isRecord(input.targetRevision) || !isRecord(input.lineage)
    || !isRecord(input.audit)
    || !isRecord(input.sourceArchitecture.owner) || !isRecord(input.targetArchitecture.owner)
    || !isRecord(input.sourceArchitecture.access) || !isRecord(input.targetArchitecture.access)
    || !isRecord(input.sourceArchitecture.access.owner) || !isRecord(input.targetArchitecture.access.owner)
    || !isRecord(input.sourceRevision.spec) || !isRecord(input.targetRevision.spec)
    || !Array.isArray(input.targetArchitecture.access.allowedOrganizationIds)) throw invalidStoreInput();

  validateUuid(input.actorId, "actorId");
  assertPatternMigrationAllowAudit(input.audit, input.actorId, input.targetArchitecture.id);
  validateUuid(input.expectedCurrentRevisionId, "expectedCurrentRevisionId");
  for (const [field, value] of [
    ["sourceArchitecture.id", input.sourceArchitecture.id],
    ["sourceRevision.id", input.sourceRevision.id],
    ["targetArchitecture.id", input.targetArchitecture.id],
    ["targetRevision.id", input.targetRevision.id],
    ["lineage.id", input.lineage.id],
    ["lineage.sourceArchitectureId", input.lineage.sourceArchitectureId],
    ["lineage.sourceRevisionId", input.lineage.sourceRevisionId],
    ["lineage.targetArchitectureId", input.lineage.targetArchitectureId],
    ["lineage.targetRevisionId", input.lineage.targetRevisionId],
    ["lineage.actorUserId", input.lineage.actorUserId],
  ] as const) validateUuid(value, field);
  validateIdentifier(input.lineage.idempotencyKey, "idempotencyKey");
  validateUuid(input.targetRevision.createdByUserId, "targetRevision.createdByUserId");
  validateDateString(input.sourceArchitecture.createdAt, "sourceArchitecture.createdAt");
  validateDateString(input.sourceArchitecture.updatedAt, "sourceArchitecture.updatedAt");
  validateDateString(input.sourceRevision.createdAt, "sourceRevision.createdAt");
  validateDateString(input.targetArchitecture.createdAt, "targetArchitecture.createdAt");
  validateDateString(input.targetArchitecture.updatedAt, "targetArchitecture.updatedAt");
  validateDateString(input.targetRevision.createdAt, "targetRevision.createdAt");
  validateDateString(input.lineage.createdAt, "lineage.createdAt");

  if (input.lineage.actorUserId !== input.actorId) throw new AppError("Lineage actor is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 409);
  if (input.lineage.sourceArchitectureId !== input.sourceArchitecture.id || input.lineage.sourceRevisionId !== input.sourceRevision.id) {
    throw new AppError("Pattern migration source identities are inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
  }
  if (input.lineage.targetArchitectureId !== input.targetArchitecture.id || input.lineage.targetRevisionId !== input.targetRevision.id) {
    throw new AppError("Pattern migration target identities are inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.sourceRevision.architectureId !== input.sourceArchitecture.id || input.sourceRevision.id !== input.expectedCurrentRevisionId) {
    throw new AppError("Pattern migration source revision is inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
  }
  if (input.targetRevision.architectureId !== input.targetArchitecture.id
    || input.targetArchitecture.currentRevisionId !== input.targetRevision.id
    || input.targetRevision.revisionNumber !== 1
    || input.targetArchitecture.revisionCount !== 1) {
    throw new AppError("A pattern migration must create one first revision for a new shell.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.sourceArchitecture.id === input.targetArchitecture.id) {
    throw new AppError("A pattern migration target must be a new architecture shell.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (!sameOwner(input.sourceArchitecture.owner, input.targetArchitecture.owner)) {
    throw new AppError("A derived shell must retain the source owner.", "ARCHITECTURE_PATTERN_MIGRATION_OWNER_INVALID", 409);
  }
  assertRecordOwnerMetadata(input.sourceArchitecture, "sourceArchitecture");
  assertRecordOwnerMetadata(input.targetArchitecture, "targetArchitecture");
  if (input.targetArchitecture.accessPolicyVersion !== 1 || input.targetArchitecture.access.role !== "owner") {
    throw new AppError("Derived shell access metadata is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_OWNER_INVALID", 409);
  }
  if (input.targetArchitecture.access.allowedOrganizationIds.length > 0) {
    throw new AppError("A derived shell cannot copy organization grants.", "ARCHITECTURE_PATTERN_MIGRATION_GRANT_COPY_FORBIDDEN", 409);
  }
  if (input.targetRevision.spec.id !== input.targetArchitecture.id
    || input.targetRevision.spec.name !== input.targetArchitecture.name
    || (input.targetRevision.spec.description ?? "") !== input.targetArchitecture.description
    || input.targetRevision.spec.pattern.id !== input.targetArchitecture.patternId
    || input.targetArchitecture.patternId !== input.lineage.targetPatternId) {
    throw new AppError("Derived shell metadata is not authoritative.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  if (input.lineage.schemaVersion !== 1 || input.lineage.mode !== "derive-shell") {
    throw new AppError("Pattern migration lineage version is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  if (!(architecturePatternIds as readonly string[]).includes(input.sourceArchitecture.patternId)
    || !(architecturePatternIds as readonly string[]).includes(input.lineage.targetPatternId)
    || input.lineage.sourcePatternId !== input.sourceArchitecture.patternId) {
    throw new AppError("Pattern migration pattern identity is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_INVALID", 409);
  }
  const mappingStatuses: readonly string[] = ["deterministic", "fallback", "provided"];
  if (!mappingStatuses.includes(input.lineage.mappingStatus)) {
    throw new AppError("Pattern migration mapping status is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_LINEAGE_INVALID", 400);
  }
  validateMapping(input.lineage.mapping);
  validateDiff(input.lineage.diff);
  validateDigest(input.lineage.sourceRevisionDigest, "sourceRevisionDigest");
  validateDigest(input.lineage.targetRevisionDigest, "targetRevisionDigest");
  validateDigest(input.lineage.migrationDigest, "migrationDigest");
  validateDigest(input.lineage.diffDigest, "diffDigest");
  validateDigest(input.intentDigest, "intentDigest");
  const sourceSpec = parseArchitectureSpec(input.sourceRevision.spec, input.sourceArchitecture.id, input.sourceArchitecture.patternId);
  const targetSpec = parseArchitectureSpec(input.targetRevision.spec, input.targetArchitecture.id, input.targetArchitecture.patternId);
  if (architectureDigest(sourceSpec) !== input.lineage.sourceRevisionDigest) {
    throw new AppError("Source revision digest does not match the candidate.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  if (architectureDigest(targetSpec) !== input.lineage.targetRevisionDigest) {
    throw new AppError("Target revision digest does not match the candidate.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  const expectedDiffDigest = architecturePatternMigrationDiffDigest(input.lineage.diff);
  if (expectedDiffDigest !== input.lineage.diffDigest) {
    throw new AppError("Pattern migration diff digest does not match the candidate.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
  const migration = migrationValue(input.lineage, targetSpec);
  if (architecturePatternMigrationDigest(migration) !== input.lineage.migrationDigest) {
    throw new AppError("Pattern migration digest does not match the candidate.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
}

function assertSourceCandidateMatches(
  input: ArchitecturePatternMigrationCreateStoreInput,
  source: typeof skillArchitectures.$inferSelect,
  revision: typeof skillArchitectureRevisions.$inferSelect,
): void {
  const owner = ownerFromDb(source.ownerUserId, source.ownerTeamId);
  if (!owner || !sameOwner(owner, input.sourceArchitecture.owner)) throw sourceConflict();
  if (source.id !== input.sourceArchitecture.id || source.currentRevisionId !== input.expectedCurrentRevisionId) throw sourceConflict();
  if (revision.id !== input.sourceRevision.id || revision.architectureId !== input.sourceArchitecture.id) throw sourceConflict();
  const sourceSpec = parseArchitectureSpec(revision.spec, source.id, source.patternId);
  if (architectureDigest(sourceSpec) !== input.lineage.sourceRevisionDigest
    || architectureDigest(input.sourceRevision.spec) !== input.lineage.sourceRevisionDigest) {
    throw new AppError("Source revision digest does not match the authoritative source.", "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_CONFLICT", 409);
  }
}

function intentDigestFromCandidate(input: ArchitecturePatternMigrationCreateStoreInput): string {
  return sha256Hex(canonicalizeJson({
    actorId: input.actorId,
    sourceArchitectureId: input.sourceArchitecture.id,
    sourceRevisionId: input.sourceRevision.id,
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    owner: input.sourceArchitecture.owner,
    sourceRevisionDigest: input.lineage.sourceRevisionDigest,
    targetPatternId: input.lineage.targetPatternId,
    mapping: Object.keys(input.lineage.mapping).length === 0 ? null : input.lineage.mapping,
    name: input.targetArchitecture.name,
    description: input.targetArchitecture.description,
    message: input.targetRevision.message,
  }));
}

function intentDigestFromPersisted(record: ArchitecturePatternMigrationPersistedRecord): string {
  return sha256Hex(canonicalizeJson({
    actorId: record.lineage.actorUserId,
    sourceArchitectureId: record.lineage.sourceArchitectureId,
    sourceRevisionId: record.lineage.sourceRevisionId,
    expectedCurrentRevisionId: record.lineage.sourceRevisionId,
    owner: record.targetArchitecture.owner,
    sourceRevisionDigest: record.lineage.sourceRevisionDigest,
    targetPatternId: record.lineage.targetPatternId,
    mapping: Object.keys(record.lineage.mapping).length === 0 ? null : record.lineage.mapping,
    name: record.targetArchitecture.name,
    description: record.targetArchitecture.description,
    message: record.targetRevision.message,
  }));
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  return value;
}

function validateUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  return value;
}

function validateDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_DIGEST_INVALID", 400);
  return value;
}

function validateDateString(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_METADATA_INVALID", 400);
}

function toDate(value: string, field: string): Date {
  validateDateString(value, field);
  return new Date(value);
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new AppError(`${field} is invalid.`, "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_INVALID", 400);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function parseObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sanitizeMigrationAuditDetails(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeAuditDetails(input);
  return Object.fromEntries(Object.entries(sanitized).filter(([key]) => AUDIT_DETAIL_KEYS.has(key)));
}

async function insertPatternMigrationAuditEvent(db: DbLike, input: ArchitecturePatternMigrationAuditInput): Promise<void> {
  const action = boundedString(input.action, "action", 120);
  if (input.decision !== "allow" && input.decision !== "deny") {
    throw new AppError("Audit decision is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_AUDIT_INVALID", 400);
  }
  await db.insert(auditEvents).values({
    actorUserId: isUuid(input.actorUserId) ? input.actorUserId : null,
    action,
    decision: input.decision,
    resourceType: "skill_architecture_pattern_migration",
    resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
    details: sanitizeMigrationAuditDetails(input.details ?? {}),
  });
}

function idempotencyConflict(): AppError {
  return new AppError("This idempotency key was already used for a different pattern migration.", "ARCHITECTURE_PATTERN_MIGRATION_IDEMPOTENCY_CONFLICT", 409);
}

function sourceConflict(): AppError {
  return new AppError("Pattern migration source changed or is inconsistent.", "ARCHITECTURE_PATTERN_MIGRATION_SOURCE_INVALID", 409);
}

function invalidStoreInput(): AppError {
  return new AppError("Pattern migration persistence input is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_STORE_INPUT_INVALID", 400);
}

function mapPersistenceError(error: unknown, message: string, code: string): AppError {
  if (error instanceof AppError) return error;
  const pgError = findPgError(error);
  if (pgError?.code === "23505") {
    if (pgError.constraint?.includes("actor_idempotency")) return idempotencyConflict();
    if (pgError.constraint?.includes("target_arch")) return new AppError("The derived architecture already exists.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_EXISTS", 409);
    if (pgError.constraint?.includes("target_revision")) return new AppError("The derived architecture revision already exists.", "ARCHITECTURE_PATTERN_MIGRATION_TARGET_REVISION_EXISTS", 409);
    return new AppError(message, code, 409);
  }
  if (pgError?.code === "23503") return new AppError("Pattern migration persistence references are invalid.", "ARCHITECTURE_PATTERN_MIGRATION_BINDING_CONFLICT", 409);
  if (pgError?.code === "23514") return new AppError("Pattern migration persistence constraints were not satisfied.", "ARCHITECTURE_PATTERN_MIGRATION_CONSTRAINT_FAILED", 409);
  if (pgError?.code === "22P02") return new AppError("Pattern migration persistence identifier is invalid.", "ARCHITECTURE_PATTERN_MIGRATION_IDENTIFIER_INVALID", 400);
  return new AppError(message, code, 409);
}

function findPgError(error: unknown): { code?: string; constraint?: string; message?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return {
      code: candidate.code,
      ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
      ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
    };
    current = candidate.cause;
  }
  return null;
}
