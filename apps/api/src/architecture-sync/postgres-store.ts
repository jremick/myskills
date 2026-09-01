import { createHash, randomUUID } from "node:crypto";
import { asc, desc, eq, and, sql } from "drizzle-orm";
import {
  AppError,
  architectureSyncControlLimits,
  architectureSyncSnapshotDigest,
  architectureSyncStepDigest,
  canonicalizeJson,
  assertValidArchitectureSyncApproval,
  assertValidArchitectureSyncLease,
  assertValidArchitectureSyncReceipt,
  assertValidArchitectureSyncRun,
  isValidArchitectureSyncCompensationTransition,
  isValidArchitectureSyncRecoveryStepTransition,
  isValidArchitectureSyncRecoveryTransition,
  isValidArchitectureSyncRunTransition,
  isValidArchitectureSyncStepTransition,
  type ArchitectureSyncApproval,
  type ArchitectureSyncBaseline,
  type ArchitectureSyncFailure,
  type ArchitectureSyncLease,
  type ArchitectureSyncReceipt,
  type ArchitectureSyncRecoveryCondition,
  type ArchitectureSyncRecoveryDecision,
  type ArchitectureSyncRun,
  type ArchitectureSyncRunState,
  type ArchitectureSyncStep,
  type ArchitectureSyncStepState,
} from "@myskills-app/core";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  skillArchitectureObservations,
  skillArchitectureRevisions,
  skillArchitectureSyncBaselines,
  skillArchitectureSyncReceipts,
  skillArchitectureSyncRecoveryEvidence,
  skillArchitectureSyncRuns,
  skillArchitectureSyncSteps,
  skillArchitectureSyncTargetLeases,
  skillArchitectureTargets,
  users,
} from "../db/schema.js";
import {
  architectureSyncReservedMetadataKeys,
  assertNoReservedArchitectureSyncMetadata,
  sanitizeArchitectureSyncMetadata,
} from "./metadata.js";
import type {
  ArchitectureSyncAuditEvent,
  ArchitectureSyncApplyClaimInput,
  ArchitectureSyncApplyClaimResult,
  ArchitectureSyncCreateRunStoreInput,
  ArchitectureSyncCreateRunStoreResult,
  ArchitectureSyncLeaseAcquireInput,
  ArchitectureSyncRecoveryAtomicPhase,
  ArchitectureSyncRecoveryClaimInput,
  ArchitectureSyncRecoveryClaimResult,
  ArchitectureSyncRunSaveOptions,
  ArchitectureSyncStore,
} from "./types.js";
import { architectureSyncRecoveryReceiptCode } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID_PATTERN = /^[0-9a-f]{32}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const WRITE_LIKE_RECEIPTS = new Set(["lease", "apply", "verify", "rollback", "recovery"]);
const TERMINAL_STEP_STATES = new Set<ArchitectureSyncStepState>(["succeeded", "compensated", "failed", "skipped"]);
const RESERVED_METADATA_KEYS = architectureSyncReservedMetadataKeys;

type DbLike = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type RunRow = typeof skillArchitectureSyncRuns.$inferSelect;
type StepRow = typeof skillArchitectureSyncSteps.$inferSelect;
type LeaseRow = typeof skillArchitectureSyncTargetLeases.$inferSelect;
type BaselineRow = typeof skillArchitectureSyncBaselines.$inferSelect;
type ReceiptRow = typeof skillArchitectureSyncReceipts.$inferSelect;

interface PostgresArchitectureSyncStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Test-only checkpoints used to prove transaction rollback. */
  readonly onRecoveryPhase?: (phase: ArchitectureSyncRecoveryAtomicPhase) => void;
}

interface RecoveryEvidenceShape {
  readonly condition: ArchitectureSyncRecoveryCondition;
  readonly decision: ArchitectureSyncRecoveryDecision;
  readonly nextRunState: ArchitectureSyncRunState;
  readonly safeToRetry: boolean;
  readonly requiresManualReview: boolean;
}

/**
 * PostgreSQL persistence for the metadata-only, fixture sync journal.
 *
 * Migration 0019 stores UUIDs while the core contract permits bounded public
 * identifiers. UUID values are passed through unchanged. Other bounded ids
 * are represented by a deterministic UUID and retained in a reserved,
 * sanitized metadata marker so a read after a process restart is lossless.
 * No adapter, target client, filesystem, or network surface is present here.
 */
export class PostgresArchitectureSyncStore implements ArchitectureSyncStore {
  readonly kind = "postgres" as const;

  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly onRecoveryPhase?: (phase: ArchitectureSyncRecoveryAtomicPhase) => void;

  constructor(
    private readonly db: Database,
    options: PostgresArchitectureSyncStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.onRecoveryPhase = options.onRecoveryPhase;
  }

  async createRun(input: ArchitectureSyncCreateRunStoreInput): Promise<ArchitectureSyncCreateRunStoreResult> {
    const actorId = validateIdentifier(input.actorId, "actorId");
    const requestKey = validateIdentifier(input.requestKey, "requestKey");
    const idempotencyKey = validateIdentifier(input.idempotencyKey, "idempotencyKey");
    const intentDigest = validateDigest(input.intentDigest, "intentDigest");
    const run = validateRun(input.run);
    const ids = runIds(run);
    const actorDbId = dbUuid(actorId, "actorId");
    const runDbId = ids.runId;

    try {
      return await this.db.transaction(async (tx) => {
        // Serialize all creates for a target and actor before checking the
        // unique keys. This makes the idempotency decision deterministic even
        // when two requests arrive before either insert commits.
        const target = await this.lockTarget(tx, ids.targetId);
        if (!target) throw new AppError("Sync target was not found.", "ARCHITECTURE_SYNC_TARGET_NOT_FOUND", 404);
        const actor = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, actorDbId))
          .for("update")
          .limit(1);

        const byRequest = await tx
          .select()
          .from(skillArchitectureSyncRuns)
          .where(and(
            eq(skillArchitectureSyncRuns.actorUserId, actorDbId),
            eq(skillArchitectureSyncRuns.requestKey, requestKey),
          ))
          .for("update")
          .limit(1);
        if (byRequest[0]) return this.replayOrConflict(tx, byRequest[0], intentDigest);

        const byIdempotency = await tx
          .select()
          .from(skillArchitectureSyncRuns)
          .where(and(
            eq(skillArchitectureSyncRuns.targetId, ids.targetId),
            eq(skillArchitectureSyncRuns.idempotencyKey, idempotencyKey),
          ))
          .for("update")
          .limit(1);
        if (byIdempotency[0]) return this.replayOrConflict(tx, byIdempotency[0], intentDigest);

        const byRunId = await tx
          .select()
          .from(skillArchitectureSyncRuns)
          .where(eq(skillArchitectureSyncRuns.id, runDbId))
          .for("update")
          .limit(1);
        if (byRunId[0]) {
          throw new AppError("Sync run already exists.", "ARCHITECTURE_SYNC_RUN_ALREADY_EXISTS", 409);
        }
        if (!actor[0]) throw new AppError("Sync actor was not found.", "ARCHITECTURE_SYNC_ACTOR_NOT_FOUND", 404);
        if (target.generation !== run.identity.targetGeneration) {
          throw new AppError("Sync target generation is stale.", "ARCHITECTURE_SYNC_GENERATION_STALE", 409, {
            currentGeneration: target.generation,
          });
        }
        if (target.architectureId !== ids.architectureId) {
          throw new AppError("Sync target architecture does not match the run.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
        }
        if (target.profileId !== run.identity.profileId || target.environmentId !== run.identity.environmentId) {
          throw new AppError("Sync target profile and environment do not match the run.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
        }
        await this.assertRevisionBinding(tx, ids.architectureId, ids.revisionId);
        const observation = await this.latestObservation(tx, ids.targetId, run.identity.targetGeneration, run.digests.observedDigest);
        if (!observation) {
          throw new AppError("The sync observed digest is not a current target observation.", "ARCHITECTURE_SYNC_OBSERVATION_NOT_FOUND", 409);
        }

        const metadata = runMetadata(run, {
          syncIntentDigest: intentDigest,
        });
        const row = await this.insertRun(tx, run, {
          actorDbId,
          requestKey,
          idempotencyKey,
          architectureId: ids.architectureId,
          revisionId: ids.revisionId,
          targetId: ids.targetId,
          observedSnapshotId: observation.id,
          metadata,
        });
        if (run.lease) await this.insertLeaseForRun(tx, run.lease);
        this.assertUniqueReceiptIds(run.receipts);
        this.assertReceiptReferences(run);
        if (run.lease && run.receipts.length > 0) {
          await this.assertReceiptFencing(tx, { ...run, receipts: [] }, run);
        }
        await this.insertSteps(tx, run, row.id);
        if (run.baseline) await this.insertBaseline(tx, run.baseline, row.id);
        await this.insertReceipts(tx, run, row.id, 0);
        await this.updateCounts(tx, row.id, run.updatedAt);
        return {
          run: await this.requireHydratedRun(tx, row.id),
          decision: "new",
        };
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync run could not be created.", "ARCHITECTURE_SYNC_CREATE_FAILED");
    }
  }

  async getRun(runId: string): Promise<ArchitectureSyncRun | null> {
    const dbRunId = dbUuid(validateIdentifier(runId, "runId"), "runId");
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.selectRun(tx, dbRunId, true);
        return row ? this.requireHydratedRun(tx, row.id) : null;
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync run could not be read.", "ARCHITECTURE_SYNC_READ_FAILED");
    }
  }

  /**
   * Serialize the apply claim with the target lease. A duplicate delivery of
   * the same run observes the committed winner and returns in-progress; it
   * never writes a blocking state or releases the winner's lease.
   */
  async claimApply(input: ArchitectureSyncApplyClaimInput): Promise<ArchitectureSyncApplyClaimResult> {
    const runId = validateIdentifier(input.runId, "runId");
    const targetId = validateIdentifier(input.targetId, "targetId");
    const targetGeneration = validateGeneration(input.targetGeneration);
    const holderId = validateIdentifier(input.holderId, "holderId");
    const now = validateTimestamp(input.now, "now");
    if (!Number.isInteger(input.leaseSeconds)
      || input.leaseSeconds < 1
      || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    const dbRunId = dbUuid(runId, "runId");
    const dbTargetId = dbUuid(targetId, "targetId");
    try {
      return await this.db.transaction(async (tx) => {
        const target = await this.lockTarget(tx, dbTargetId);
        if (!target) throw new AppError("Sync target was not found.", "ARCHITECTURE_SYNC_TARGET_NOT_FOUND", 404);
        const row = await this.selectRun(tx, dbRunId, true);
        if (!row) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
        if (row.targetId !== dbTargetId || row.targetGeneration !== targetGeneration) {
          throw new AppError("Sync run and target lease binding do not match.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
        }
        const run = await this.requireHydratedRun(tx, row.id);
        if (run.state === "succeeded" || run.state === "rolled_back") return { decision: "completed", run };
        if (target.generation !== targetGeneration) {
          throw new AppError("Sync target generation is stale.", "ARCHITECTURE_SYNC_GENERATION_STALE", 409, {
            currentGeneration: target.generation,
          });
        }
        const current = await this.selectLease(tx, dbTargetId, true);
        const nowDate = new Date(now);
        const active = current?.status === "active" && current.expiresAt.getTime() > nowDate.getTime();
        if (active) {
          const currentRunId = publicIdFromMetadata(current?.metadata, "syncPublicRunId", current.runId);
          if (currentRunId === runId && isInterruptedRunState(run.state)) return { decision: "in-progress", run };
          throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
        }
        if (isInterruptedRunState(run.state)) {
          // An interrupted run must be recovered with trusted readback before
          // it can be re-entered. Do not silently execute a stale intent.
          return { decision: "in-progress", run };
        }
        if (run.state !== "approved" && run.state !== "queued") {
          throw new AppError("Sync run is not ready to apply.", "ARCHITECTURE_SYNC_APPLY_STATE_INVALID", 409);
        }
        const lease = this.buildLease({
          runId,
          targetId,
          targetGeneration,
          holderId,
          now,
          leaseSeconds: input.leaseSeconds,
        }, Number(current?.fencingToken ?? 0));
        let claimed = run;
        if (claimed.state === "approved") claimed = transitionRunState(claimed, "queued");
        claimed = transitionRunState(claimed, "lease_acquiring");
        claimed = { ...claimed, lease, state: "revalidating", updatedAt: now };
        const existingIntentDigest = metadataString(row.metadata, "syncIntentDigest");
        await this.insertLeaseForRun(tx, lease);
        await this.writeRunState(tx, row, claimed, runMetadata(claimed, existingIntentDigest ? { syncIntentDigest: existingIntentDigest } : {}), undefined);
        await this.updateCounts(tx, row.id, claimed.updatedAt);
        return { decision: "claimed", run: await this.requireHydratedRun(tx, row.id) };
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync apply could not be claimed.", "ARCHITECTURE_SYNC_APPLY_CLAIM_FAILED");
    }
  }

  /**
   * Claim and finalize recovery in one database transaction. An active lease
   * is never reused as evidence of interruption, including when it belongs to
   * the same run. The recovery lease advances the durable fencing token before
   * any recovery receipt/evidence is written; all finalization is rolled back
   * if a later checkpoint fails.
   */
  async claimRecovery(input: ArchitectureSyncRecoveryClaimInput): Promise<ArchitectureSyncRecoveryClaimResult> {
    const run = validateRun(input.run);
    const nextRun = validateRun(input.nextRun);
    const ids = runIds(run);
    const actorId = validateIdentifier(input.actorId, "actorId");
    const holderId = validateIdentifier(input.holderId, "holderId");
    const now = validateTimestamp(input.now, "now");
    const evidenceDigest = validateDigest(input.evidenceDigest, "evidenceDigest");
    if (!Number.isInteger(input.leaseSeconds)
      || input.leaseSeconds < 1
      || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    if (input.transition.sourceState !== run.state
      || nextRun.identity.runId !== run.identity.runId
      || nextRun.identity.targetId !== run.identity.targetId
      || nextRun.identity.targetGeneration !== run.identity.targetGeneration
      || nextRun.lease !== undefined
      || input.transition.nextRunState !== nextRun.state
      || input.recoveryReceipt.runId !== run.identity.runId
      || input.recoveryReceipt.kind !== "recovery"
      || input.recoveryReceipt.evidenceDigest !== evidenceDigest
      || input.audit.runId !== run.identity.runId
      || input.audit.actorId !== actorId) {
      throw new AppError("Recovery finalization is not bound to the sync run.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    if (architectureSyncRecoveryReceiptCode(input.transition) !== input.recoveryReceipt.code) {
      throw new AppError("Recovery receipt code does not match the canonical transition.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
    }
    assertValidArchitectureSyncReceipt(input.recoveryReceipt);

    try {
      return await this.db.transaction(async (tx) => {
        const target = await this.lockTarget(tx, ids.targetId);
        if (!target) throw new AppError("Sync target was not found.", "ARCHITECTURE_SYNC_TARGET_NOT_FOUND", 404);
        if (target.generation !== run.identity.targetGeneration) {
          throw new AppError("Sync target generation is stale.", "ARCHITECTURE_SYNC_GENERATION_STALE", 409, {
            currentGeneration: target.generation,
          });
        }
        const row = await this.selectRun(tx, ids.runId, true);
        if (!row) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
        const existing = await this.requireHydratedRun(tx, row.id);
        const priorRecovery = existing.receipts.find((receipt) => receipt.kind === "recovery"
          && receipt.code === input.recoveryReceipt.code
          && receipt.evidenceDigest === evidenceDigest);
        if (priorRecovery) return { decision: "replayed", run: existing };

        if (row.targetId !== ids.targetId
          || row.targetGeneration !== run.identity.targetGeneration
          || canonicalizeJson(existing) !== canonicalizeJson(run)) {
          throw new AppError("Sync run changed before recovery could be claimed.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_CONFLICT", 409);
        }
        if (!isInterruptedRunState(existing.state)
          || !isValidArchitectureSyncRecoveryTransition({
            from: existing.state,
            to: nextRun.state,
            transition: input.transition,
          })) {
          throw new AppError("Only an explicitly interrupted sync run can be recovered.", "ARCHITECTURE_SYNC_RECOVERY_STATE_INVALID", 409);
        }
        this.assertImmutableRunFields(existing, nextRun);
        this.assertRunTimestamps(existing, nextRun);
        this.assertReceiptPrefix(existing, nextRun);
        if (nextRun.receipts.length !== existing.receipts.length) {
          throw new AppError("Recovery run receipts must be append-only.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
        }

        const current = await this.selectLease(tx, ids.targetId, true);
        const nowDate = new Date(now);
        if (current?.status === "active" && current.expiresAt.getTime() > nowDate.getTime()) {
          throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
        }
        const lease = this.buildLease({
          runId: run.identity.runId,
          targetId: run.identity.targetId,
          targetGeneration: run.identity.targetGeneration,
          holderId,
          now,
          leaseSeconds: input.leaseSeconds,
        }, Number(current?.fencingToken ?? 0));
        await this.insertLeaseForRun(tx, lease);
        this.onRecoveryPhase?.("after-claim");

        const finalized = assertValidArchitectureSyncRun({
          ...nextRun,
          lease,
          receipts: [...nextRun.receipts, input.recoveryReceipt],
        });
        this.assertUniqueReceiptIds(finalized.receipts);
        await this.assertReceiptFencing(tx, existing, finalized);
        const existingIntentDigest = metadataString(row.metadata, "syncIntentDigest");
        await this.syncSteps(tx, existing, nextRun, row.id, false, input.transition);
        await this.writeRunState(
          tx,
          row,
          finalized,
          runMetadata(finalized, existingIntentDigest ? { syncIntentDigest: existingIntentDigest } : {}),
          input.transition,
        );
        this.onRecoveryPhase?.("after-transition");
        await this.insertReceipts(tx, finalized, row.id, existing.receipts.length);
        this.onRecoveryPhase?.("after-evidence");
        await this.updateCounts(tx, row.id, finalized.updatedAt);
        await this.insertAuditEvent(tx, input.audit);
        this.onRecoveryPhase?.("after-audit");
        await this.releaseLeaseInTransaction(tx, {
          targetId: finalized.identity.targetId,
          runId: finalized.identity.runId,
          fencingToken: lease.fencingToken,
        });
        this.onRecoveryPhase?.("after-lease-disposition");
        return { decision: "claimed", run: await this.requireHydratedRun(tx, row.id) };
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync recovery could not be finalized.", "ARCHITECTURE_SYNC_RECOVERY_FAILED");
    }
  }

  async saveRun(
    input: ArchitectureSyncRun,
    options: ArchitectureSyncRunSaveOptions = {},
  ): Promise<ArchitectureSyncRun> {
    const run = validateRun(input);
    const ids = runIds(run);
    const dbRunId = ids.runId;

    try {
      return await this.db.transaction(async (tx) => {
        const existingRow = await this.selectRun(tx, dbRunId, true);
        if (!existingRow) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
        const existing = await this.requireHydratedRun(tx, existingRow.id);
        this.assertImmutableRunFields(existing, run);
        this.assertRunTimestamps(existing, run);
        const runTransitionAllowed = existing.state === run.state
          || (options.recoveryTransition
            ? isValidArchitectureSyncRecoveryTransition({
              from: existing.state,
              to: run.state,
              transition: options.recoveryTransition,
            })
            : isValidArchitectureSyncRunTransition(existing.state, run.state));
        if (!runTransitionAllowed) {
          throw new AppError("Sync run state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
        }
        this.assertReceiptPrefix(existing, run);
        this.assertUniqueReceiptIds(run.receipts);
        this.assertReceiptReferences(run);
        await this.assertReceiptFencing(tx, existing, run);

        const existingIntentDigest = metadataString(existingRow.metadata, "syncIntentDigest");
        const metadata = runMetadata(run, existingIntentDigest ? { syncIntentDigest: existingIntentDigest } : {});
        await this.syncSteps(tx, existing, run, existingRow.id, options.compensation === true, options.recoveryTransition);
        await this.writeRunState(tx, existingRow, run, metadata, options.recoveryTransition);
        await this.insertReceipts(tx, run, existingRow.id, existing.receipts.length);
        await this.updateCounts(tx, existingRow.id, run.updatedAt);
        return this.requireHydratedRun(tx, existingRow.id);
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync run could not be saved.", "ARCHITECTURE_SYNC_SAVE_FAILED");
    }
  }

  async acquireLease(input: ArchitectureSyncLeaseAcquireInput): Promise<ArchitectureSyncLease> {
    const runId = validateIdentifier(input.runId, "runId");
    const targetId = validateIdentifier(input.targetId, "targetId");
    const holderId = validateIdentifier(input.holderId, "holderId");
    const targetGeneration = validateGeneration(input.targetGeneration);
    const now = validateTimestamp(input.now, "now");
    if (!Number.isInteger(input.leaseSeconds)
      || input.leaseSeconds < 1
      || input.leaseSeconds > architectureSyncControlLimits.leaseMaximumSeconds) {
      throw new AppError("Lease duration is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    const dbRunId = dbUuid(runId, "runId");
    const dbTargetId = dbUuid(targetId, "targetId");
    try {
      return await this.db.transaction(async (tx) => {
        const target = await this.lockTarget(tx, dbTargetId);
        if (!target) throw new AppError("Sync target was not found.", "ARCHITECTURE_SYNC_TARGET_NOT_FOUND", 404);
        if (target.generation !== targetGeneration) {
          throw new AppError("Sync target generation is stale.", "ARCHITECTURE_SYNC_GENERATION_STALE", 409, {
            currentGeneration: target.generation,
          });
        }
        const run = await this.selectRun(tx, dbRunId, true);
        if (!run
          || run.targetId !== dbTargetId
          || run.targetGeneration !== targetGeneration) {
          throw new AppError("Sync run and target lease binding do not match.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
        }
        const current = await this.selectLease(tx, dbTargetId, true);
        const nowDate = new Date(now);
        if (current?.status === "active" && current.expiresAt.getTime() > nowDate.getTime()) {
          throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
        }
        if (current && (nowDate.getTime() < current.acquiredAt.getTime() || nowDate.getTime() < current.updatedAt.getTime())) {
          throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
        }
        const fencingToken = Number(current?.fencingToken ?? 0) + 1;
        if (fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
          throw new AppError("Sync fencing token limit was reached.", "ARCHITECTURE_SYNC_LEASE_INVALID", 409);
        }
        const lease: ArchitectureSyncLease = assertValidArchitectureSyncLease({
          schemaVersion: 1,
          leaseId: `lease-${this.idFactory()}`,
          runId,
          targetId,
          targetGeneration,
          holderId,
          fencingToken,
          acquiredAt: now,
          expiresAt: new Date(nowDate.getTime() + input.leaseSeconds * 1_000).toISOString(),
        }, {
          targetId,
          targetGeneration,
          fencingToken,
          runId,
        });
        const metadata = metadataWithPublicId(undefined, lease.leaseId, "leaseId");
        const values = {
          id: dbUuid(lease.leaseId, "leaseId"),
          schemaVersion: 1,
          targetId: dbTargetId,
          runId: dbRunId,
          targetGeneration,
          holderId,
          fencingToken,
          status: "active" as const,
          acquiredAt: nowDate,
          expiresAt: new Date(lease.expiresAt),
          releasedAt: null,
          metadata: leaseMetadata(metadata, lease),
          createdAt: current?.createdAt ?? nowDate,
          updatedAt: nowDate,
        };
        if (current) {
          await tx
            .update(skillArchitectureSyncTargetLeases)
            .set(values)
            .where(eq(skillArchitectureSyncTargetLeases.targetId, dbTargetId));
        } else {
          await tx.insert(skillArchitectureSyncTargetLeases).values(values);
        }
        return lease;
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync lease could not be acquired.", "ARCHITECTURE_SYNC_LEASE_FAILED");
    }
  }

  async getCurrentLease(targetId: string): Promise<ArchitectureSyncLease | null> {
    const publicTargetId = validateIdentifier(targetId, "targetId");
    const dbTargetId = dbUuid(publicTargetId, "targetId");
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.selectLease(tx, dbTargetId, true);
        if (!row || row.status !== "active" || row.expiresAt.getTime() <= this.now().getTime()) return null;
        return leaseFromRow(row);
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync lease could not be read.", "ARCHITECTURE_SYNC_LEASE_READ_FAILED");
    }
  }

  async releaseLease(input: { readonly targetId: string; readonly runId: string; readonly fencingToken: number }): Promise<void> {
    const targetId = validateIdentifier(input.targetId, "targetId");
    const runId = validateIdentifier(input.runId, "runId");
    if (!Number.isInteger(input.fencingToken) || input.fencingToken < 1 || input.fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
      throw new AppError("Lease fencing token is invalid.", "ARCHITECTURE_SYNC_LEASE_INVALID", 400);
    }
    try {
      await this.db.transaction(async (tx) => {
        await this.releaseLeaseInTransaction(tx, {
          targetId,
          runId,
          fencingToken: input.fencingToken,
        });
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync lease could not be released.", "ARCHITECTURE_SYNC_LEASE_RELEASE_FAILED");
    }
  }

  private async releaseLeaseInTransaction(
    tx: DbLike,
    input: { readonly targetId: string; readonly runId: string; readonly fencingToken: number },
  ): Promise<void> {
    const row = await this.selectLease(tx, dbUuid(input.targetId, "targetId"), true);
    if (!row
      || row.status !== "active"
      || row.runId !== dbUuid(input.runId, "runId")
      || Number(row.fencingToken) !== input.fencingToken) return;
    const now = new Date(Math.max(this.now().getTime(), row.acquiredAt.getTime(), row.updatedAt.getTime()));
    await tx
      .update(skillArchitectureSyncTargetLeases)
      .set({
        status: "released",
        releasedAt: now,
        updatedAt: now,
      })
      .where(eq(skillArchitectureSyncTargetLeases.targetId, row.targetId));
  }

  async recordAuditEvent(input: Omit<ArchitectureSyncAuditEvent, "id">): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        await this.insertAuditEvent(tx, input);
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync audit event could not be recorded.", "ARCHITECTURE_SYNC_AUDIT_FAILED");
    }
  }

  private async insertAuditEvent(tx: DbLike, input: Omit<ArchitectureSyncAuditEvent, "id">): Promise<void> {
    const actorId = validateIdentifier(input.actorId, "actorId");
    const runId = validateIdentifier(input.runId, "runId");
    const action = validateCode(input.action, "action");
    const code = validateCode(input.code, "code");
    const recordedAt = validateTimestamp(input.recordedAt, "recordedAt");
    if (input.decision !== "allow" && input.decision !== "deny") {
      throw new AppError("Audit decision is invalid.", "ARCHITECTURE_SYNC_AUDIT_INVALID", 400);
    }
    const dedupeKey = input.dedupeKey === undefined ? undefined : validateIdentifier(input.dedupeKey, "dedupeKey");
    assertNoReservedArchitectureSyncMetadata(input.metadata);
    const metadata = sanitizePublicMetadata(input.metadata);
    const actorDbId = dbUuid(actorId, "actorId");
    const runDbId = dbUuid(runId, "runId");
    if (dedupeKey) {
      // The audit table predates the sync journal and has no unique index for
      // its JSONB dedupe marker. Serialize the check-and-insert per run/key
      // so concurrent terminal or recovery retries cannot both append it.
      // PostgreSQL text values cannot contain a NUL byte. Compose the lock
      // key through the extended hash function instead of passing a binary
      // delimiter as a text parameter. Nesting the hashes keeps run and
      // dedupe components distinct without relying on a separator that may
      // also be valid in either identifier.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${runDbId}, hashtextextended(${dedupeKey}, 0)))`);
      const existing = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(
          eq(auditEvents.resourceType, "architecture_sync"),
          eq(auditEvents.resourceId, runDbId),
          sql`${auditEvents.details}->>'syncDedupeKey' = ${dedupeKey}`,
        ))
        .limit(1);
      if (existing[0]) return;
    }
    const actor = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, actorDbId))
      .limit(1);
    const persistedActorId = actor[0]?.id ?? null;
    await tx.insert(auditEvents).values({
      actorUserId: persistedActorId,
      action,
      decision: input.decision,
      resourceType: "architecture_sync",
      resourceId: runDbId,
      details: sanitizeAuditDetails({
        syncAction: action,
        syncCode: code,
        syncRecordedAt: recordedAt,
        ...(dedupeKey ? { syncDedupeKey: dedupeKey } : {}),
        ...(!persistedActorId || shouldMarkPublicId(actorId, actorDbId) ? { syncPublicActorId: actorId } : {}),
        ...(shouldMarkPublicId(runId, runDbId) ? { syncPublicRunId: runId } : {}),
        ...(metadata ? { syncMetadata: metadata } : {}),
      }),
      createdAt: new Date(recordedAt),
    });
  }

  async listAuditEvents(limit = 100): Promise<ArchitectureSyncAuditEvent[]> {
    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100;
    try {
      const rows = await this.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.resourceType, "architecture_sync"))
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(bounded);
      return rows.map((row) => {
        const details = parseObject(row.details);
        const metadata = sanitizePublicMetadata(details.syncMetadata);
        const event = {
          id: row.id,
          runId: metadataString(details, "syncPublicRunId") ?? row.resourceId ?? "",
          actorId: metadataString(details, "syncPublicActorId") ?? row.actorUserId ?? "",
          action: metadataString(details, "syncAction") ?? row.action,
          decision: row.decision === "allow" ? "allow" as const : "deny" as const,
          code: metadataString(details, "syncCode") ?? "sync.event",
          recordedAt: metadataString(details, "syncRecordedAt") ?? row.createdAt.toISOString(),
          ...(metadataString(details, "syncDedupeKey") ? { dedupeKey: metadataString(details, "syncDedupeKey") } : {}),
          ...(metadata ? { metadata } : {}),
        };
        return event;
      });
    } catch (error) {
      throw mapPersistenceError(error, "Sync audit events could not be read.", "ARCHITECTURE_SYNC_AUDIT_READ_FAILED");
    }
  }

  private async replayOrConflict(
    tx: DbLike,
    row: RunRow,
    intentDigest: string,
  ): Promise<ArchitectureSyncCreateRunStoreResult> {
    const storedIntent = metadataString(row.metadata, "syncIntentDigest");
    if (storedIntent !== intentDigest) {
      throw new AppError("The sync request key is already bound to different immutable inputs.", "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT", 409, {
        runId: publicIdFromMetadata(row.metadata, "syncPublicRunId", row.id),
      });
    }
    return {
      run: await this.requireHydratedRun(tx, row.id),
      decision: "duplicate",
    };
  }

  private async insertRun(
    tx: DbLike,
    run: ArchitectureSyncRun,
    input: {
      readonly actorDbId: string;
      readonly requestKey: string;
      readonly idempotencyKey: string;
      readonly architectureId: string;
      readonly revisionId: string;
      readonly targetId: string;
      readonly observedSnapshotId: string;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<RunRow> {
    assertForwardDates(run.createdAt, run.updatedAt, "run");
    const lifecycle = lifecycleDates(run, undefined);
    const [row] = await tx
      .insert(skillArchitectureSyncRuns)
      .values({
        id: dbUuid(run.identity.runId, "runId"),
        schemaVersion: run.schemaVersion,
        architectureId: input.architectureId,
        revisionId: input.revisionId,
        targetId: input.targetId,
        targetGeneration: run.identity.targetGeneration,
        observedSnapshotId: input.observedSnapshotId,
        profileId: run.identity.profileId,
        environmentId: run.identity.environmentId,
        actorUserId: input.actorDbId,
        runKind: "preview",
        status: run.state,
        requestKey: input.requestKey,
        idempotencyKey: input.idempotencyKey,
        desiredDigest: run.digests.desiredDigest,
        compiledDigest: run.digests.compiledDigest,
        observedDigest: run.digests.observedDigest,
        planDigest: run.digests.planDigest,
        approvalDigest: run.digests.approvalDigest ?? null,
        baselineDigest: run.digests.baselineDigest ?? null,
        failureClass: run.failure?.class ?? null,
        failureCode: run.failure?.code ?? null,
        failureRetryable: run.failure?.retryable ?? null,
        stepCount: run.steps.length,
        receiptCount: run.receipts.length,
        recoveryEvidenceCount: run.receipts.filter((receipt) => receipt.kind === "recovery").length,
        statusUpdatedAt: new Date(run.updatedAt),
        ...lifecycle,
        metadata: input.metadata,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt),
      })
      .returning();
    if (!row) throw new Error("Sync run insert failed.");
    return row;
  }

  private async insertSteps(tx: DbLike, run: ArchitectureSyncRun, dbRunId: string): Promise<void> {
    if (run.steps.length === 0) return;
    await tx.insert(skillArchitectureSyncSteps).values(run.steps.map((step) => {
      const stepMetadata = metadataWithPublicId(step.metadata, step.id, "stepId");
      return {
        id: dbUuid(step.id, "stepId"),
        schemaVersion: step.schemaVersion,
        runId: dbRunId,
        ordinal: step.ordinal,
        action: step.action,
        nodeId: step.nodeId,
        targetGeneration: step.targetGeneration,
        status: step.state,
        idempotencyKey: step.idempotencyKey,
        desiredDigest: run.digests.desiredDigest,
        compiledDigest: run.digests.compiledDigest,
        observedDigest: run.digests.observedDigest,
        planDigest: run.digests.planDigest,
        stepDigest: architectureSyncStepDigest(step),
        resultDigest: null,
        failureClass: run.failure?.stepId === step.id ? run.failure.class : null,
        failureCode: run.failure?.stepId === step.id ? run.failure.code : null,
        statusUpdatedAt: new Date(run.updatedAt),
        startedAt: stepStartedAt(step.state, run.updatedAt),
        completedAt: stepCompletedAt(step.state, run.updatedAt),
        metadata: stepMetadata,
        createdAt: new Date(run.createdAt),
        updatedAt: new Date(run.updatedAt),
      };
    }));
  }

  private async insertBaseline(tx: DbLike, baseline: ArchitectureSyncBaseline, dbRunId: string): Promise<void> {
    const metadata = metadataWithPublicId(baseline.metadata, baseline.id, "baselineId");
    await tx.insert(skillArchitectureSyncBaselines).values({
      id: dbUuid(baseline.id, "baselineId"),
      schemaVersion: baseline.schemaVersion,
      runId: dbRunId,
      targetId: dbUuid(baseline.targetId, "targetId"),
      targetGeneration: baseline.targetGeneration,
      observedDigest: baseline.observedDigest,
      baselineDigest: architectureSyncSnapshotDigest(baseline),
      restorable: baseline.restorable,
      capturedAt: new Date(baseline.capturedAt),
      metadata,
      createdAt: new Date(baseline.capturedAt),
    });
  }

  private async insertLeaseForRun(tx: DbLike, lease: ArchitectureSyncLease): Promise<void> {
    const targetId = dbUuid(lease.targetId, "targetId");
    const runId = dbUuid(lease.runId, "runId");
    const current = await this.selectLease(tx, targetId, true);
    if (current?.status === "active" && current.expiresAt.getTime() > Date.parse(lease.acquiredAt)) {
      throw new AppError("The target is leased by another sync run.", "ARCHITECTURE_SYNC_LEASE_CONFLICT", 409);
    }
    if (current && (Date.parse(lease.acquiredAt) < current.acquiredAt.getTime() || Date.parse(lease.acquiredAt) < current.updatedAt.getTime())) {
      throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }
    if (current && lease.fencingToken <= Number(current.fencingToken)) {
      throw new AppError("Sync lease fencing token is stale.", "ARCHITECTURE_SYNC_FENCE_STALE", 409);
    }
    const metadata = leaseMetadata(metadataWithPublicId(undefined, lease.leaseId, "leaseId"), lease);
    const values = {
      id: dbUuid(lease.leaseId, "leaseId"),
      schemaVersion: lease.schemaVersion,
      targetId,
      runId,
      targetGeneration: lease.targetGeneration,
      holderId: lease.holderId,
      fencingToken: lease.fencingToken,
      status: "active" as const,
      acquiredAt: new Date(lease.acquiredAt),
      expiresAt: new Date(lease.expiresAt),
      releasedAt: null,
      metadata,
      createdAt: current?.createdAt ?? new Date(lease.acquiredAt),
      updatedAt: new Date(lease.acquiredAt),
    };
    if (current) {
      await tx.update(skillArchitectureSyncTargetLeases).set(values).where(eq(skillArchitectureSyncTargetLeases.targetId, targetId));
    } else {
      await tx.insert(skillArchitectureSyncTargetLeases).values(values);
    }
  }

  private async insertReceipts(tx: DbLike, run: ArchitectureSyncRun, dbRunId: string, offset: number): Promise<void> {
    const appended = run.receipts.slice(offset);
    if (appended.length === 0) return;
    const dbStepIds = new Map(run.steps.map((step) => [step.id, dbUuid(step.id, "stepId")]));
    for (const [index, receipt] of appended.entries()) {
      if (receipt.stepId && !dbStepIds.has(receipt.stepId)) {
        throw new AppError("Sync receipt stepId does not belong to the immutable run plan.", "ARCHITECTURE_SYNC_RECEIPT_INVALID", 409);
      }
      const fencingToken = WRITE_LIKE_RECEIPTS.has(receipt.kind)
        ? this.requireRunFence(run, receipt)
        : null;
      const metadata = receiptMetadata(receipt.metadata, receipt.id, offset + index + 1);
      await tx.insert(skillArchitectureSyncReceipts).values({
        id: dbUuid(receipt.id, "receiptId"),
        schemaVersion: receipt.schemaVersion,
        runId: dbRunId,
        stepId: receipt.stepId ? dbStepIds.get(receipt.stepId) ?? null : null,
        targetId: dbUuid(run.identity.targetId, "targetId"),
        targetGeneration: run.identity.targetGeneration,
        fencingToken,
        kind: receipt.kind,
        status: receipt.status,
        code: receipt.code,
        evidenceDigest: receipt.evidenceDigest ?? null,
        recordedAt: new Date(receipt.recordedAt),
        message: receipt.message ?? null,
        metadata,
      });
      const recovery = recoveryEvidenceForReceipt(receipt);
      if (receipt.kind === "recovery" && !recovery) {
        throw new AppError("Recovery receipt code is not recognized.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
      }
      if (recovery) {
        if (!receipt.evidenceDigest) {
          throw new AppError("Recovery evidence requires a bound digest.", "ARCHITECTURE_SYNC_RECOVERY_EVIDENCE_INVALID", 409);
        }
        if (!run.lease) throw new AppError("Recovery evidence requires the current sync lease.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
        await tx.insert(skillArchitectureSyncRecoveryEvidence).values({
          id: randomUUID(),
          schemaVersion: 1,
          runId: dbRunId,
          targetId: dbUuid(run.identity.targetId, "targetId"),
          targetGeneration: run.identity.targetGeneration,
          fencingToken: run.lease.fencingToken,
          condition: recovery.condition,
          decision: recovery.decision,
          nextRunState: recovery.nextRunState,
          safeToRetry: recovery.safeToRetry,
          requiresManualReview: recovery.requiresManualReview,
          code: receipt.code,
          evidenceDigest: receipt.evidenceDigest,
          recordedAt: new Date(receipt.recordedAt),
          metadata,
        });
      }
    }
  }

  private async updateCounts(tx: DbLike, dbRunId: string, updatedAt: string): Promise<void> {
    const steps = await tx
      .select({ count: sql<number>`count(*)` })
      .from(skillArchitectureSyncSteps)
      .where(eq(skillArchitectureSyncSteps.runId, dbRunId));
    const receipts = await tx
      .select({ count: sql<number>`count(*)` })
      .from(skillArchitectureSyncReceipts)
      .where(eq(skillArchitectureSyncReceipts.runId, dbRunId));
    const recovery = await tx
      .select({ count: sql<number>`count(*)` })
      .from(skillArchitectureSyncRecoveryEvidence)
      .where(eq(skillArchitectureSyncRecoveryEvidence.runId, dbRunId));
    await tx
      .update(skillArchitectureSyncRuns)
      .set({
        stepCount: Number(steps[0]?.count ?? 0),
        receiptCount: Number(receipts[0]?.count ?? 0),
        recoveryEvidenceCount: Number(recovery[0]?.count ?? 0),
        updatedAt: new Date(updatedAt),
      })
      .where(eq(skillArchitectureSyncRuns.id, dbRunId));
  }

  private async syncSteps(
    tx: DbLike,
    existing: ArchitectureSyncRun,
    next: ArchitectureSyncRun,
    dbRunId: string,
    allowCompensation: boolean,
    recoveryTransition: ArchitectureSyncRunSaveOptions["recoveryTransition"],
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(skillArchitectureSyncSteps)
      .where(eq(skillArchitectureSyncSteps.runId, dbRunId))
      .orderBy(asc(skillArchitectureSyncSteps.ordinal), asc(skillArchitectureSyncSteps.id))
      .for("update");
    if (rows.length !== next.steps.length) {
      throw new AppError("Sync step identity is immutable.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
    }
    const existingById = new Map(existing.steps.map((step) => [step.id, step]));
    const nextById = new Map(next.steps.map((step) => [step.id, step]));
    for (const row of rows) {
      const publicId = publicIdFromMetadata(row.metadata, "syncPublicId", row.id);
      const previous = existingById.get(publicId);
      const candidate = nextById.get(publicId);
      if (!previous || !candidate) throw new AppError("Sync step identity is immutable.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
      if (row.id !== dbUuid(candidate.id, "stepId")
        || row.ordinal !== candidate.ordinal
        || row.action !== candidate.action
        || row.nodeId !== candidate.nodeId
        || row.targetGeneration !== candidate.targetGeneration
        || row.idempotencyKey !== candidate.idempotencyKey
        || row.stepDigest !== architectureSyncStepDigest(candidate)) {
        throw new AppError("Sync step identity is immutable.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
      }
      if (previous.state !== candidate.state
        && !isValidArchitectureSyncStepTransition(previous.state, candidate.state)
        && !(allowCompensation && isValidArchitectureSyncCompensationTransition(previous.state, candidate.state))
        && !(recoveryTransition && isValidArchitectureSyncRecoveryStepTransition(previous.state, candidate.state, recoveryTransition))) {
        throw new AppError("Sync step state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
      }
      const path = statePath(
        previous.state,
        candidate.state,
        (from, to) => isValidArchitectureSyncStepTransition(from, to)
          || (allowCompensation && isValidArchitectureSyncCompensationTransition(from, to))
          || (recoveryTransition !== undefined && isValidArchitectureSyncRecoveryStepTransition(from, to, recoveryTransition)),
        "step",
      );
      if (!path) throw new AppError("Sync step state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
      const metadata = metadataWithPublicId(candidate.metadata, candidate.id, "stepId");
      const persistedMetadata = recoveryTransition && previous.state !== candidate.state
        ? sanitizedInternalMetadata({
          ...metadata,
          syncRecoveryStepSourceState: previous.state,
          syncRecoveryStepNextState: candidate.state,
          syncRecoveryCondition: recoveryTransition.condition,
          syncRecoveryDecision: recoveryTransition.decision,
        })
        : metadata;
      let currentState = previous.state;
      for (const state of path.slice(1)) {
        currentState = state;
        await tx
          .update(skillArchitectureSyncSteps)
          .set(stepValues(candidate, next, currentState, persistedMetadata, currentState === candidate.state ? next.failure : existing.failure, row.createdAt, row.startedAt, row.completedAt))
          .where(and(eq(skillArchitectureSyncSteps.runId, dbRunId), eq(skillArchitectureSyncSteps.id, row.id)));
      }
      if (path.length === 1) {
        await tx
          .update(skillArchitectureSyncSteps)
          .set(stepValues(candidate, next, currentState, persistedMetadata, next.failure, row.createdAt, row.startedAt, row.completedAt))
          .where(and(eq(skillArchitectureSyncSteps.runId, dbRunId), eq(skillArchitectureSyncSteps.id, row.id)));
      }
    }
  }

  private async writeRunState(
    tx: DbLike,
    existingRow: RunRow,
    next: ArchitectureSyncRun,
    metadata: Record<string, unknown>,
    recoveryTransition: ArchitectureSyncRunSaveOptions["recoveryTransition"],
  ): Promise<void> {
    const persistedMetadata = recoveryTransition
      ? sanitizedInternalMetadata({
        ...metadata,
        syncRecoverySourceState: recoveryTransition.sourceState,
        syncRecoveryCondition: recoveryTransition.condition,
        syncRecoveryDecision: recoveryTransition.decision,
        syncRecoveryNextRunState: recoveryTransition.nextRunState,
      })
      : metadata;
    const path = statePath(
      existingRow.status,
      next.state,
      (from, to) => isValidArchitectureSyncRunTransition(from, to)
        || (recoveryTransition !== undefined && isValidArchitectureSyncRecoveryTransition({
          from,
          to,
          transition: recoveryTransition,
        })),
      "run",
    );
    if (!path) throw new AppError("Sync run state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
    const lifecycle = lifecycleDates(next, existingRow);
    let currentState = existingRow.status;
    for (const state of path.slice(1)) {
      currentState = state;
      await tx
        .update(skillArchitectureSyncRuns)
        .set({
          ...runValues(next, persistedMetadata, lifecycle, currentState),
          statusUpdatedAt: new Date(next.updatedAt),
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(skillArchitectureSyncRuns.id, existingRow.id));
    }
    if (path.length === 1) {
      await tx
        .update(skillArchitectureSyncRuns)
        .set({
          ...runValues(next, persistedMetadata, lifecycle, currentState),
          statusUpdatedAt: new Date(next.updatedAt),
          updatedAt: new Date(next.updatedAt),
        })
        .where(eq(skillArchitectureSyncRuns.id, existingRow.id));
    }
  }

  private async assertReceiptFencing(tx: DbLike, existing: ArchitectureSyncRun, next: ArchitectureSyncRun): Promise<void> {
    const appended = next.receipts.slice(existing.receipts.length);
    if (appended.length === 0) return;
    const writeLike = appended.some((receipt) => WRITE_LIKE_RECEIPTS.has(receipt.kind));
    if (!writeLike) return;
    const current = await this.selectLease(tx, dbUuid(next.identity.targetId, "targetId"), true);
    for (const receipt of appended) {
      if (!WRITE_LIKE_RECEIPTS.has(receipt.kind)) continue;
      if (!next.lease
        || !current
        || current.status !== "active"
        || current.runId !== dbUuid(next.identity.runId, "runId")
        || current.targetGeneration !== next.identity.targetGeneration
        || Number(current.fencingToken) !== next.lease.fencingToken
        || publicIdFromMetadata(current.metadata, "syncPublicId", current.id) !== next.lease.leaseId
        || current.holderId !== next.lease.holderId
        || current.acquiredAt.getTime() > Date.parse(receipt.recordedAt)
        || current.expiresAt.getTime() <= this.now().getTime()
        || current.expiresAt.getTime() <= Date.parse(receipt.recordedAt)) {
        throw new AppError("Write-like sync evidence requires the current lease and fencing token.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
      }
    }
  }

  private requireRunFence(run: ArchitectureSyncRun, receipt: ArchitectureSyncReceipt): number {
    if (!run.lease || run.lease.targetId !== run.identity.targetId || run.lease.runId !== run.identity.runId) {
      throw new AppError("Write-like sync evidence requires the current lease and fencing token.", "ARCHITECTURE_SYNC_LEASE_LOST", 409, {
        receiptId: receipt.id,
      });
    }
    return run.lease.fencingToken;
  }

  private assertImmutableRunFields(previous: ArchitectureSyncRun, next: ArchitectureSyncRun): void {
    const projection = (run: ArchitectureSyncRun) => ({
      identity: run.identity,
      digests: {
        desiredDigest: run.digests.desiredDigest,
        compiledDigest: run.digests.compiledDigest,
        observedDigest: run.digests.observedDigest,
        planDigest: run.digests.planDigest,
        ...(run.digests.baselineDigest === undefined ? {} : { baselineDigest: run.digests.baselineDigest }),
      },
      steps: run.steps.map((step) => ({
        schemaVersion: step.schemaVersion,
        id: step.id,
        ordinal: step.ordinal,
        action: step.action,
        nodeId: step.nodeId,
        targetGeneration: step.targetGeneration,
        idempotencyKey: step.idempotencyKey,
        ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
      })),
      capabilities: run.capabilities,
    });
    if (canonicalizeJson(projection(previous)) !== canonicalizeJson(projection(next))) {
      throw new AppError("Sync run identity and digests are immutable.", "ARCHITECTURE_SYNC_DIGEST_CONFLICT", 409);
    }
    if (previous.approval && (!next.approval || canonicalizeJson(previous.approval) !== canonicalizeJson(next.approval))) {
      throw new AppError("Sync approval is immutable.", "ARCHITECTURE_SYNC_APPROVAL_IMMUTABLE", 409);
    }
    if (previous.baseline && (!next.baseline || canonicalizeJson(previous.baseline) !== canonicalizeJson(next.baseline))) {
      throw new AppError("Sync baseline is immutable.", "ARCHITECTURE_SYNC_BASELINE_IMMUTABLE", 409);
    }
    if (previous.lease && next.lease && next.lease.fencingToken < previous.lease.fencingToken) {
      throw new AppError("Sync lease fencing cannot move backwards.", "ARCHITECTURE_SYNC_FENCE_STALE", 409);
    }
    if (previous.lease && next.lease) {
      if (next.lease.fencingToken === previous.lease.fencingToken
        && canonicalizeJson(previous.lease) !== canonicalizeJson(next.lease)) {
        throw new AppError("Sync lease identity is immutable at a fencing token.", "ARCHITECTURE_SYNC_FENCE_STALE", 409);
      }
      if (next.lease.fencingToken > previous.lease.fencingToken
        && Date.parse(next.lease.acquiredAt) < Date.parse(previous.lease.acquiredAt)) {
        throw new AppError("Sync lease acquisition time must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
      }
    }
  }

  private assertRunTimestamps(previous: ArchitectureSyncRun, next: ArchitectureSyncRun): void {
    assertForwardDates(next.createdAt, next.updatedAt, "run");
    if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
      throw new AppError("Sync run timestamps must move forward.", "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
    }
  }

  private assertReceiptPrefix(previous: ArchitectureSyncRun, next: ArchitectureSyncRun): void {
    if (next.receipts.length < previous.receipts.length
      || previous.receipts.some((receipt, index) => canonicalizeJson(receipt) !== canonicalizeJson(next.receipts[index]))) {
      throw new AppError("Sync receipts are append-only.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
    }
  }

  private assertUniqueReceiptIds(receipts: readonly ArchitectureSyncReceipt[]): void {
    const ids = new Set<string>();
    for (const receipt of receipts) {
      if (ids.has(receipt.id)) throw new AppError("Sync receipt ids must be unique.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
      ids.add(receipt.id);
    }
  }

  private assertReceiptReferences(run: ArchitectureSyncRun): void {
    const stepIds = new Set(run.steps.map((step) => step.id));
    for (const receipt of run.receipts) {
      if (receipt.stepId && !stepIds.has(receipt.stepId)) {
        throw new AppError("Sync receipt stepId does not belong to the immutable run plan.", "ARCHITECTURE_SYNC_RECEIPT_INVALID", 409);
      }
    }
  }

  private buildLease(input: ArchitectureSyncLeaseAcquireInput, previousFencingToken: number): ArchitectureSyncLease {
    const fencingToken = previousFencingToken + 1;
    if (fencingToken > architectureSyncControlLimits.fencingTokenMaximum) {
      throw new AppError("Sync fencing token limit was reached.", "ARCHITECTURE_SYNC_LEASE_INVALID", 409);
    }
    return assertValidArchitectureSyncLease({
      schemaVersion: 1,
      leaseId: `lease-${this.idFactory()}`,
      runId: input.runId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      holderId: input.holderId,
      fencingToken,
      acquiredAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + input.leaseSeconds * 1_000).toISOString(),
    }, {
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      fencingToken,
      runId: input.runId,
    });
  }

  private async selectRun(db: DbLike, id: string, forUpdate: boolean): Promise<RunRow | null> {
    const query = db.select().from(skillArchitectureSyncRuns).where(eq(skillArchitectureSyncRuns.id, id));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return rows[0] ?? null;
  }

  private async lockTarget(db: DbLike, id: string): Promise<typeof skillArchitectureTargets.$inferSelect | null> {
    const rows = await db
      .select()
      .from(skillArchitectureTargets)
      .where(eq(skillArchitectureTargets.id, id))
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  }

  private async latestObservation(db: DbLike, targetId: string, generation: number, digest: string) {
    const rows = await db
      .select()
      .from(skillArchitectureObservations)
      .where(and(
        eq(skillArchitectureObservations.targetId, targetId),
        eq(skillArchitectureObservations.generation, generation),
        eq(skillArchitectureObservations.observedDigest, digest),
      ))
      .orderBy(desc(skillArchitectureObservations.capturedAt), desc(skillArchitectureObservations.id))
      .for("update")
      .limit(1);
    return rows[0] ?? null;
  }

  private async assertRevisionBinding(db: DbLike, architectureId: string, revisionId: string): Promise<void> {
    const rows = await db
      .select({ architectureId: skillArchitectureRevisions.architectureId })
      .from(skillArchitectureRevisions)
      .where(eq(skillArchitectureRevisions.id, revisionId))
      .for("update")
      .limit(1);
    if (!rows[0]) throw new AppError("Sync revision was not found.", "ARCHITECTURE_SYNC_REVISION_NOT_FOUND", 404);
    if (rows[0].architectureId !== architectureId) {
      throw new AppError("Sync revision does not belong to the architecture.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
    }
  }

  private async selectLease(db: DbLike, targetId: string, forUpdate: boolean): Promise<LeaseRow | null> {
    const query = db.select().from(skillArchitectureSyncTargetLeases).where(eq(skillArchitectureSyncTargetLeases.targetId, targetId));
    const rows = forUpdate ? await query.for("update").limit(1) : await query.limit(1);
    return rows[0] ?? null;
  }

  private async requireHydratedRun(db: DbLike, id: string): Promise<ArchitectureSyncRun> {
    const row = await this.selectRun(db, id, false);
    if (!row) throw new AppError("Sync run was not found.", "ARCHITECTURE_SYNC_RUN_NOT_FOUND", 404);
    const stepRows = await db
      .select()
      .from(skillArchitectureSyncSteps)
      .where(eq(skillArchitectureSyncSteps.runId, row.id))
      .orderBy(asc(skillArchitectureSyncSteps.ordinal), asc(skillArchitectureSyncSteps.id));
    const receiptRows = await db
      .select()
      .from(skillArchitectureSyncReceipts)
      .where(eq(skillArchitectureSyncReceipts.runId, row.id));
    const baselineRows = await db
      .select()
      .from(skillArchitectureSyncBaselines)
      .where(eq(skillArchitectureSyncBaselines.runId, row.id))
      .for("update")
      .limit(1);
    const leaseRows = await db
      .select()
      .from(skillArchitectureSyncTargetLeases)
      .where(eq(skillArchitectureSyncTargetLeases.runId, row.id))
      .orderBy(desc(skillArchitectureSyncTargetLeases.fencingToken))
      .limit(1);
    const run = runFromRows(row, stepRows, receiptRows, baselineRows[0], leaseRows[0]);
    if (baselineRows[0]) {
      if (!run.baseline
        || baselineRows[0].baselineDigest !== architectureSyncSnapshotDigest(run.baseline)
        || baselineRows[0].observedDigest !== run.digests.observedDigest
        || row.baselineDigest !== baselineRows[0].baselineDigest) {
        throw new AppError("Persisted sync baseline is inconsistent.", "PERSISTED_ARCHITECTURE_SYNC_INVALID", 500);
      }
    } else if (row.baselineDigest !== null) {
      throw new AppError("Persisted sync baseline is missing.", "PERSISTED_ARCHITECTURE_SYNC_INVALID", 500);
    }
    try {
      return assertValidArchitectureSyncRun(run);
    } catch (error) {
      throw new AppError("Persisted sync run is invalid.", "PERSISTED_ARCHITECTURE_SYNC_INVALID", 500, {
        cause: error instanceof Error ? error.message : "validation-failed",
      });
    }
  }
}

function validateRun(input: ArchitectureSyncRun): ArchitectureSyncRun {
  const run = assertValidArchitectureSyncRun(input);
  assertSafeRunMetadata(run);
  return run;
}

function assertSafeRunMetadata(run: ArchitectureSyncRun): void {
  ensureNoReservedMetadata(run.metadata);
  sanitizePublicMetadata(run.metadata);
  for (const step of run.steps) {
    ensureNoReservedMetadata(step.metadata);
    sanitizePublicMetadata(step.metadata);
  }
  for (const receipt of run.receipts) {
    ensureNoReservedMetadata(receipt.metadata);
    sanitizePublicMetadata(receipt.metadata);
  }
  ensureNoReservedMetadata(run.approval?.metadata);
  ensureNoReservedMetadata(run.baseline?.metadata);
  ensureNoReservedMetadata(run.failure?.metadata);
}

function runIds(run: ArchitectureSyncRun): {
  readonly runId: string;
  readonly targetId: string;
  readonly architectureId: string;
  readonly revisionId: string;
} {
  return {
    runId: dbUuid(run.identity.runId, "runId"),
    targetId: dbUuid(run.identity.targetId, "targetId"),
    architectureId: dbUuid(run.identity.architectureId, "architectureId"),
    revisionId: dbUuid(run.identity.revisionId, "revisionId"),
  };
}

function runMetadata(
  run: ArchitectureSyncRun,
  internal: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = {
    ...run.metadata,
  };
  const entries: Record<string, unknown> = {
    ...internal,
    ...(shouldMarkPublicId(run.identity.runId, dbUuid(run.identity.runId, "runId")) ? { syncPublicRunId: run.identity.runId } : {}),
    ...(shouldMarkPublicId(run.identity.targetId, dbUuid(run.identity.targetId, "targetId")) ? { syncPublicTargetId: run.identity.targetId } : {}),
    ...(shouldMarkPublicId(run.identity.architectureId, dbUuid(run.identity.architectureId, "architectureId")) ? { syncPublicArchitectureId: run.identity.architectureId } : {}),
    ...(shouldMarkPublicId(run.identity.revisionId, dbUuid(run.identity.revisionId, "revisionId")) ? { syncPublicRevisionId: run.identity.revisionId } : {}),
    ...(run.capabilities ? { syncCapabilities: boundedJson(run.capabilities, "capabilities") } : {}),
    ...(run.approval ? {
      syncApprovalId: run.approval.id,
      syncApprovalActorId: run.approval.actorId,
      ...(run.approval.expiresAt ? { syncApprovalExpiresAt: run.approval.expiresAt } : {}),
      ...(run.approval.metadata ? { syncApprovalMetadata: boundedJson(run.approval.metadata, "approval metadata") } : {}),
    } : {}),
    ...(run.lease ? leaseMarkers(run.lease) : {}),
    ...(run.failure ? {
      syncFailureOccurredAt: run.failure.occurredAt,
      ...(run.failure.stepId ? { syncFailureStepId: run.failure.stepId } : {}),
      ...(run.failure.message ? { syncFailureMessage: run.failure.message } : {}),
      ...(run.failure.metadata ? { syncFailureMetadata: boundedJson(run.failure.metadata, "failure metadata") } : {}),
    } : {}),
  };
  return sanitizedInternalMetadata({ ...metadata, ...entries });
}

function leaseMarkers(lease: ArchitectureSyncLease): Record<string, string> {
  return {
    syncLeaseId: lease.leaseId,
    syncLeaseRunId: lease.runId,
    syncLeaseTargetId: lease.targetId,
    syncLeaseGeneration: String(lease.targetGeneration),
    syncLeaseHolderId: lease.holderId,
    syncLeaseFence: String(lease.fencingToken),
    syncLeaseAcquiredAt: lease.acquiredAt,
    syncLeaseExpiresAt: lease.expiresAt,
  };
}

function leaseMetadata(metadata: Record<string, unknown> | undefined, lease: ArchitectureSyncLease): Record<string, unknown> {
  return sanitizedInternalMetadata({
    ...metadata,
    ...leaseMarkers(lease),
    syncPublicRunId: lease.runId,
    syncPublicTargetId: lease.targetId,
  });
}

function metadataWithPublicId(metadata: unknown, id: string, kind: string): Record<string, unknown> {
  return sanitizedInternalMetadata({
    ...parseObject(metadata),
    ...(shouldMarkPublicId(id, dbUuid(id, kind)) ? { syncPublicId: id } : {}),
  });
}

function receiptMetadata(metadata: unknown, id: string, ordinal: number): Record<string, unknown> {
  return sanitizedInternalMetadata({
    ...parseObject(metadata),
    ...(shouldMarkPublicId(id, dbUuid(id, "receiptId")) ? { syncPublicId: id } : {}),
    syncReceiptOrdinal: String(ordinal),
  });
}

function sanitizedInternalMetadata(input: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(input).length > architectureSyncControlLimits.metadataKeys) {
    throw new AppError("Sync metadata cannot represent the persistence markers required by migration 0019.", "ARCHITECTURE_SYNC_SCHEMA_MISMATCH", 501);
  }
  const result = sanitizeArchitectureSyncMetadata(input);
  if (!result) return {};
  return result;
}

function sanitizePublicMetadata(value: unknown): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  const metadata = sanitizeArchitectureSyncMetadata(value);
  if (!metadata) return undefined;
  const publicEntries = Object.fromEntries(Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key)));
  return Object.keys(publicEntries).length > 0 ? publicEntries : undefined;
}

function ensureNoReservedMetadata(value: unknown): void {
  assertNoReservedArchitectureSyncMetadata(value);
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value) as Record<string, unknown>
    : {};
}

function metadataString(value: unknown, key: string): string | undefined {
  const parsed = parseObject(value)[key];
  return typeof parsed === "string" ? parsed : undefined;
}

function publicIdFromMetadata(metadata: unknown, key: string, fallback: string): string {
  return metadataString(metadata, key) ?? fallback;
}

function publicIdFromRowMetadata(metadata: unknown, fallback: string): string {
  return publicIdFromMetadata(metadata, "syncPublicId", fallback);
}

function shouldMarkPublicId(publicId: string, dbId: string): boolean {
  return publicId !== dbId;
}

function boundedJson(value: unknown, label: string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || encoded.length > architectureSyncControlLimits.metadataStringLength) {
    throw new AppError(`${label} is not representable by migration 0019 metadata.`, "ARCHITECTURE_SYNC_SCHEMA_MISMATCH", 501);
  }
  return encoded;
}

function dbUuid(value: string, kind: string): string {
  if (UUID_PATTERN.test(value)) return value.toLowerCase();
  const suffix = value.match(/^[A-Za-z][A-Za-z0-9._:-]{0,40}-(.+)$/)?.[1];
  if (suffix && UUID_PATTERN.test(suffix)) return suffix.toLowerCase();
  if (suffix && COMPACT_UUID_PATTERN.test(suffix)) return formatCompactUuid(suffix);
  const hash = createHash("sha256").update(`architecture-sync:${kind}:${value}`).digest("hex").slice(0, 32);
  return formatCompactUuid(hash);
}

function formatCompactUuid(value: string): string {
  const normalized = value.toLowerCase();
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function validateIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value) || value.length > architectureSyncControlLimits.identifierLength) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function validateDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_DIGEST_INVALID", 400);
  }
  return value;
}

function validateCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !CODE_PATTERN.test(value)) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  }
  return value;
}

function validateGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > architectureSyncControlLimits.generationMaximum) {
    throw new AppError("Target generation is invalid.", "ARCHITECTURE_SYNC_GENERATION_INVALID", 400);
  }
  return value;
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new AppError(`${field} is invalid.`, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 400);
  }
  return value;
}

function assertForwardDates(createdAt: string, updatedAt: string, field: string): void {
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new AppError(`${field} timestamps must move forward.`, "ARCHITECTURE_SYNC_TIMESTAMP_INVALID", 409);
  }
}

function lifecycleDates(run: ArchitectureSyncRun, existing: RunRow | undefined): Record<string, Date | null> {
  const value: Record<string, Date | null> = {
    awaitingApprovalAt: existing?.awaitingApprovalAt ?? null,
    approvedAt: existing?.approvedAt ?? null,
    queuedAt: existing?.queuedAt ?? null,
    startedAt: existing?.startedAt ?? null,
    completedAt: existing?.completedAt ?? null,
    failedAt: existing?.failedAt ?? null,
    rollbackRequiredAt: existing?.rollbackRequiredAt ?? null,
    rolledBackAt: existing?.rolledBackAt ?? null,
    cancelledAt: existing?.cancelledAt ?? null,
    expiredAt: existing?.expiredAt ?? null,
  };
  const timestamp = new Date(run.updatedAt);
  const stateColumn: Partial<Record<ArchitectureSyncRunState, keyof typeof value>> = {
    awaiting_approval: "awaitingApprovalAt",
    approved: "approvedAt",
    queued: "queuedAt",
    lease_acquiring: "startedAt",
    revalidating: "startedAt",
    preparing: "startedAt",
    applying: "startedAt",
    verifying: "startedAt",
    succeeded: "completedAt",
    failed: "failedAt",
    rollback_required: "rollbackRequiredAt",
    rolling_back: "startedAt",
    rolled_back: "rolledBackAt",
    rollback_failed: "failedAt",
    cancelled: "cancelledAt",
    expired: "expiredAt",
  };
  const column = stateColumn[run.state];
  if (column && value[column] === null) value[column] = run.state === "approved" && run.approval
    ? new Date(run.approval.approvedAt)
    : timestamp;
  if (run.approval && value.approvedAt === null) value.approvedAt = new Date(run.approval.approvedAt);
  if (run.failure && value.failedAt === null) value.failedAt = new Date(run.failure.occurredAt);
  return value;
}

function isInterruptedRunState(state: ArchitectureSyncRunState): boolean {
  return ["lease_acquiring", "revalidating", "preparing", "applying", "verifying"].includes(state);
}

function transitionRunState(run: ArchitectureSyncRun, state: ArchitectureSyncRunState): ArchitectureSyncRun {
  if (!isValidArchitectureSyncRunTransition(run.state, state)) {
    throw new AppError("Sync run state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
  }
  return { ...run, state };
}

function runValues(
  run: ArchitectureSyncRun,
  metadata: Record<string, unknown>,
  lifecycle: Record<string, Date | null>,
  state: ArchitectureSyncRunState,
): Record<string, unknown> {
  return {
    status: state,
    approvalDigest: run.digests.approvalDigest ?? null,
    baselineDigest: run.digests.baselineDigest ?? null,
    failureClass: run.failure?.class ?? null,
    failureCode: run.failure?.code ?? null,
    failureRetryable: run.failure?.retryable ?? null,
    ...lifecycle,
    metadata,
  };
}

function stepValues(
  step: ArchitectureSyncStep,
  run: ArchitectureSyncRun,
  state: ArchitectureSyncStepState,
  metadata: Record<string, unknown>,
  failure: ArchitectureSyncFailure | undefined,
  createdAt: Date,
  previousStartedAt: Date | null,
  previousCompletedAt: Date | null,
): Record<string, unknown> {
  const statusUpdatedAt = new Date(run.updatedAt);
  const startedAt = state === "started" || TERMINAL_STEP_STATES.has(state)
    ? new Date(run.updatedAt)
    : previousStartedAt;
  const completedAt = TERMINAL_STEP_STATES.has(state) ? new Date(run.updatedAt) : previousCompletedAt;
  return {
    status: state,
    statusUpdatedAt,
    startedAt: startedAt && startedAt.getTime() >= createdAt.getTime() ? startedAt : null,
    completedAt: completedAt && completedAt.getTime() >= createdAt.getTime() ? completedAt : null,
    failureClass: failure?.stepId === step.id ? failure.class : null,
    failureCode: failure?.stepId === step.id ? failure.code : null,
    metadata,
    updatedAt: statusUpdatedAt,
  };
}

function stepStartedAt(state: ArchitectureSyncStepState, updatedAt: string): Date | null {
  return state === "started" || TERMINAL_STEP_STATES.has(state) ? new Date(updatedAt) : null;
}

function stepCompletedAt(state: ArchitectureSyncStepState, updatedAt: string): Date | null {
  return TERMINAL_STEP_STATES.has(state) ? new Date(updatedAt) : null;
}

function statePath<T extends string>(
  from: T,
  to: T,
  allowed: (from: T, to: T) => boolean,
  domain: "run" | "step",
): T[] | null {
  if (from === to) return [from];
  if (allowed(from, to)) return [from, to];
  const states: T[] = domain === "step"
    ? ["planned", "prepared", "started", "succeeded", "verify_failed", "compensating", "compensated", "failed", "skipped"] as T[]
    : [
      "drafted",
      "awaiting_approval",
      "approved",
      "queued",
      "lease_acquiring",
      "revalidating",
      "preparing",
      "applying",
      "verifying",
      "succeeded",
      "blocked",
      "failed",
      "rollback_required",
      "rolling_back",
      "rolled_back",
      "rollback_failed",
      "cancelled",
      "expired",
    ] as T[];
  const queue: T[][] = [[from]];
  const seen = new Set<T>([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    for (const candidate of states) {
      if (!allowed(current, candidate) || seen.has(candidate)) continue;
      const next = [...path, candidate];
      if (candidate === to) return next;
      seen.add(candidate);
      queue.push(next);
    }
  }
  return null;
}

function runFromRows(
  row: RunRow,
  stepRows: readonly StepRow[],
  receiptRows: readonly ReceiptRow[],
  baselineRow: BaselineRow | undefined,
  leaseRow: LeaseRow | undefined,
): ArchitectureSyncRun {
  const metadata = parseObject(row.metadata);
  const runId = publicIdFromMetadata(metadata, "syncPublicRunId", row.id);
  const targetId = publicIdFromMetadata(metadata, "syncPublicTargetId", row.targetId);
  const architectureId = publicIdFromMetadata(metadata, "syncPublicArchitectureId", row.architectureId);
  const revisionId = publicIdFromMetadata(metadata, "syncPublicRevisionId", row.revisionId);
  const steps = stepRows.map((step) => ({
    schemaVersion: step.schemaVersion as 1,
    id: publicIdFromRowMetadata(step.metadata, step.id),
    ordinal: step.ordinal,
    action: step.action,
    nodeId: step.nodeId,
    targetGeneration: step.targetGeneration,
    state: step.status,
    idempotencyKey: step.idempotencyKey,
    ...(sanitizePublicMetadata(step.metadata) ? { metadata: sanitizePublicMetadata(step.metadata) } : {}),
  } satisfies ArchitectureSyncStep));
  const stepByDbId = new Map(stepRows.map((step) => [step.id, step]));
  const receipts = [...receiptRows]
    .sort((left, right) => receiptOrder(left) - receiptOrder(right)
      || left.recordedAt.getTime() - right.recordedAt.getTime()
      || left.id.localeCompare(right.id))
    .map((receipt) => ({
      schemaVersion: receipt.schemaVersion as 1,
      id: publicIdFromRowMetadata(receipt.metadata, receipt.id),
      runId,
      ...(receipt.stepId ? { stepId: publicIdFromRowMetadata(stepByDbId.get(receipt.stepId)?.metadata, receipt.stepId) } : {}),
      kind: receipt.kind,
      status: receipt.status,
      code: receipt.code,
      recordedAt: receipt.recordedAt.toISOString(),
      ...(receipt.evidenceDigest ? { evidenceDigest: receipt.evidenceDigest } : {}),
      ...(receipt.message ? { message: receipt.message } : {}),
      ...(sanitizePublicMetadata(receipt.metadata) ? { metadata: sanitizePublicMetadata(receipt.metadata) } : {}),
    } satisfies ArchitectureSyncReceipt));
  const baseline = baselineRow ? {
    schemaVersion: baselineRow.schemaVersion as 1,
    id: publicIdFromRowMetadata(baselineRow.metadata, baselineRow.id),
    runId,
    targetId,
    targetGeneration: baselineRow.targetGeneration,
    observedDigest: baselineRow.observedDigest,
    restorable: baselineRow.restorable,
    capturedAt: baselineRow.capturedAt.toISOString(),
    ...(sanitizePublicMetadata(baselineRow.metadata) ? { metadata: sanitizePublicMetadata(baselineRow.metadata) } : {}),
  } satisfies ArchitectureSyncBaseline : undefined;
  const approval = row.approvalDigest ? approvalFromMetadata(metadata, row, runId) : undefined;
  const lease = leaseFromRunMetadata(metadata, leaseRow, runId, targetId, row.targetGeneration);
  const failure = row.failureClass && row.failureCode ? failureFromMetadata(metadata, row) : undefined;
  const capabilitiesValue = metadataString(metadata, "syncCapabilities");
  const capabilities = capabilitiesValue ? parseJson(capabilitiesValue, "capabilities") as ArchitectureSyncRun["capabilities"] : undefined;
  return {
    schemaVersion: row.schemaVersion as 1,
    identity: {
      schemaVersion: row.schemaVersion as 1,
      runId,
      targetId,
      targetGeneration: row.targetGeneration,
      architectureId,
      revisionId,
      profileId: row.profileId,
      environmentId: row.environmentId,
    },
    state: row.status,
    digests: {
      desiredDigest: row.desiredDigest,
      compiledDigest: row.compiledDigest,
      observedDigest: row.observedDigest,
      planDigest: row.planDigest,
      ...(row.approvalDigest ? { approvalDigest: row.approvalDigest } : {}),
      ...(row.baselineDigest ? { baselineDigest: row.baselineDigest } : {}),
    },
    steps,
    receipts,
    ...(approval ? { approval } : {}),
    ...(baseline ? { baseline } : {}),
    ...(lease ? { lease } : {}),
    ...(failure ? { failure } : {}),
    ...(capabilities ? { capabilities } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(sanitizePublicMetadata(row.metadata) ? { metadata: sanitizePublicMetadata(row.metadata) } : {}),
  };
}

function approvalFromMetadata(metadata: Record<string, unknown>, row: RunRow, runId: string): ArchitectureSyncApproval {
  const approvalMetadata = metadataString(metadata, "syncApprovalMetadata");
  const candidate = {
    schemaVersion: 1 as const,
    id: metadataString(metadata, "syncApprovalId") ?? `approval-${row.id}`,
    runId,
    actorId: metadataString(metadata, "syncApprovalActorId") ?? row.actorUserId,
    planDigest: row.planDigest,
    approvedAt: row.approvedAt?.toISOString() ?? row.updatedAt.toISOString(),
    ...(metadataString(metadata, "syncApprovalExpiresAt") ? { expiresAt: metadataString(metadata, "syncApprovalExpiresAt") } : {}),
    ...(approvalMetadata ? { metadata: parseJson(approvalMetadata, "approval metadata") } : {}),
  };
  return assertValidArchitectureSyncApproval(candidate);
}

function failureFromMetadata(metadata: Record<string, unknown>, row: RunRow): ArchitectureSyncFailure {
  return {
    schemaVersion: 1,
    class: row.failureClass!,
    code: row.failureCode!,
    occurredAt: metadataString(metadata, "syncFailureOccurredAt") ?? row.failedAt?.toISOString() ?? row.updatedAt.toISOString(),
    retryable: row.failureRetryable === true,
    ...(metadataString(metadata, "syncFailureStepId") ? { stepId: metadataString(metadata, "syncFailureStepId") } : {}),
    ...(metadataString(metadata, "syncFailureMessage") ? { message: metadataString(metadata, "syncFailureMessage") } : {}),
    ...(metadataString(metadata, "syncFailureMetadata") ? { metadata: parseJson(metadataString(metadata, "syncFailureMetadata")!, "failure metadata") as ArchitectureSyncFailure["metadata"] } : {}),
  };
}

function leaseFromRunMetadata(
  metadata: Record<string, unknown>,
  leaseRow: LeaseRow | undefined,
  runId: string,
  targetId: string,
  generation: number,
): ArchitectureSyncLease | undefined {
  const markerFence = Number(metadataString(metadata, "syncLeaseFence"));
  if (leaseRow && (!Number.isInteger(markerFence) || Number(leaseRow.fencingToken) >= markerFence)) {
    return leaseFromRow(leaseRow);
  }
  const id = metadataString(metadata, "syncLeaseId") ?? (leaseRow ? metadataString(leaseRow.metadata, "syncPublicId") ?? leaseRow.id : undefined);
  const leaseRunId = metadataString(metadata, "syncLeaseRunId") ?? (leaseRow ? publicIdFromMetadata(leaseRow.metadata, "syncPublicRunId", leaseRow.runId) : runId);
  const leaseTargetId = metadataString(metadata, "syncLeaseTargetId") ?? (leaseRow ? publicIdFromMetadata(leaseRow.metadata, "syncPublicTargetId", leaseRow.targetId) : targetId);
  const fencing = metadataString(metadata, "syncLeaseFence") ?? (leaseRow ? String(leaseRow.fencingToken) : undefined);
  const acquiredAt = metadataString(metadata, "syncLeaseAcquiredAt") ?? leaseRow?.acquiredAt.toISOString();
  const expiresAt = metadataString(metadata, "syncLeaseExpiresAt") ?? leaseRow?.expiresAt.toISOString();
  const holderId = metadataString(metadata, "syncLeaseHolderId") ?? leaseRow?.holderId;
  if (!id || !fencing || !acquiredAt || !expiresAt || !holderId) return undefined;
  return assertValidArchitectureSyncLease({
    schemaVersion: 1,
    leaseId: id,
    runId: leaseRunId,
    targetId: leaseTargetId,
    targetGeneration: Number(metadataString(metadata, "syncLeaseGeneration") ?? leaseRow?.targetGeneration ?? generation),
    holderId,
    fencingToken: Number(fencing),
    acquiredAt,
    expiresAt,
  });
}

function leaseFromRow(row: LeaseRow): ArchitectureSyncLease {
  const metadata = parseObject(row.metadata);
  return assertValidArchitectureSyncLease({
    schemaVersion: row.schemaVersion as 1,
    leaseId: metadataString(metadata, "syncPublicId") ?? row.id,
    runId: publicIdFromMetadata(metadata, "syncPublicRunId", row.runId),
    targetId: publicIdFromMetadata(metadata, "syncPublicTargetId", row.targetId),
    targetGeneration: row.targetGeneration,
    holderId: row.holderId,
    fencingToken: Number(row.fencingToken),
    acquiredAt: row.acquiredAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}

function receiptOrder(row: ReceiptRow): number {
  const value = Number(metadataString(row.metadata, "syncReceiptOrdinal"));
  return Number.isInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new AppError(`Persisted sync ${field} is invalid.`, "PERSISTED_ARCHITECTURE_SYNC_INVALID", 500);
  }
}

const RECOVERY_EVIDENCE_BY_CODE: Record<string, RecoveryEvidenceShape> = {
  "recovery.retry": { condition: "no-mutation", decision: "retry", nextRunState: "queued", safeToRetry: true, requiresManualReview: false },
  "recovery.succeed": { condition: "desired-readback", decision: "succeed", nextRunState: "succeeded", safeToRetry: false, requiresManualReview: false },
  "recovery.rollback": { condition: "restorable-partial-state", decision: "rollback", nextRunState: "rollback_required", safeToRetry: false, requiresManualReview: false },
  "recovery.block": { condition: "ambiguous-readback", decision: "block", nextRunState: "blocked", safeToRetry: false, requiresManualReview: true },
  "recovery.manual": { condition: "irreversible-unrecoverable", decision: "manual-intervention", nextRunState: "rollback_failed", safeToRetry: false, requiresManualReview: true },
};

function recoveryEvidenceForReceipt(receipt: ArchitectureSyncReceipt): RecoveryEvidenceShape | undefined {
  return receipt.kind === "recovery" ? RECOVERY_EVIDENCE_BY_CODE[receipt.code] : undefined;
}

function mapPersistenceError(error: unknown, message: string, code: string): AppError {
  if (error instanceof AppError) return error;
  const pgError = findPgError(error);
  if (pgError?.code === "23505") {
    if (pgError.constraint?.includes("idempotency") || pgError.constraint?.includes("request")) {
      return new AppError("The sync request key is already bound to a different run.", "ARCHITECTURE_SYNC_IDEMPOTENCY_CONFLICT", 409);
    }
    return new AppError(message, code, 409);
  }
  if (pgError?.code === "23503") return new AppError("Sync persistence references are invalid.", "ARCHITECTURE_SYNC_BINDING_CONFLICT", 409);
  if (pgError?.code === "23514") return new AppError(message, code, 409);
  if (pgError?.code === "22P02") return new AppError("Sync persistence identifier is invalid.", "ARCHITECTURE_SYNC_IDENTIFIER_INVALID", 400);
  if (pgError?.code === "55000") {
    const detail = pgError.message ?? "";
    if (/fenc|evidence|lease/i.test(detail)) return new AppError("The sync lease is no longer current.", "ARCHITECTURE_SYNC_LEASE_LOST", 409);
    if (/transition/i.test(detail)) return new AppError("Sync state transition is not permitted.", "ARCHITECTURE_SYNC_TRANSITION_INVALID", 409);
    if (/receipt/i.test(detail)) return new AppError("Sync receipts are append-only.", "ARCHITECTURE_SYNC_RECEIPT_IMMUTABLE", 409);
  }
  return new AppError(message, code, 409);
}

function findPgError(error: unknown): { code?: string; constraint?: string; message?: string; cause?: unknown } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") return null;
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") {
      return {
        code: candidate.code,
        ...(typeof candidate.constraint === "string" ? { constraint: candidate.constraint } : {}),
        ...(typeof candidate.message === "string" ? { message: candidate.message } : {}),
      };
    }
    current = candidate.cause;
  }
  return null;
}
