import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { AppError, isWithinSkillUpgradeMaintenanceWindow, targetSkillOperationResultMatchesPlan, type TargetSkillOperation } from "@myskills-app/core";
import type { Database } from "../db/client.js";
import { auditEvents, skillArchitectureTargets, skillArchitectureSyncTargetLeases, targetSkillOperations, targetSkillOperationClaimCursors } from "../db/schema.js";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import { assertOperationEligibility, canReadOperationRelease, lockOperationTarget, lockOperationSharing, resolveLockedUpgradePolicy, operationDenied, type OperationDatabase } from "./postgres-authorization.js";
import type { CreateTargetSkillOperationInput, StoredTargetSkillOperation, TargetSkillOperationStore } from "./types.js";

const activeStates = ["claimed", "applying", "verifying"];

export class PostgresTargetSkillOperationStore implements TargetSkillOperationStore {
  readonly kind = "postgres" as const;
  constructor(private readonly db: Database, private readonly options: {
    beforeAuthorization?: (operation: StoredTargetSkillOperation) => void | Promise<void>;
    beforeEligibility?: () => void | Promise<void>;
    beforeAuditInsert?: () => void | Promise<void>;
  } = {}) {}

  async create(input: CreateTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }> {
    return (await this.createBatch([input]))[0]!;
  }

  async createBatch(inputs: CreateTargetSkillOperationInput[]): Promise<Array<{ operation: TargetSkillOperation; replayed: boolean }>> {
    return this.transaction(async (tx) => {
      // Acquire all target locks in stable order before touching owner or release rows.
      const targetIds = [...new Set(inputs.map(({ operation }) => operation.targetId))].sort();
      await tx.select({ id: skillArchitectureTargets.id }).from(skillArchitectureTargets)
        .where(inArray(skillArchitectureTargets.id, targetIds)).orderBy(asc(skillArchitectureTargets.id)).for("update");
      const results = [];
      for (const { operation } of inputs) {
        await this.options.beforeAuthorization?.(operation);
        const [existing] = await tx.select().from(targetSkillOperations).where(and(
          eq(targetSkillOperations.targetId, operation.targetId), eq(targetSkillOperations.idempotencyKey, operation.idempotencyKey),
        )).limit(1);
        if (existing) {
          if (existing.actorUserId !== operation.actorUserId || existing.action !== operation.action || existing.skillSlug !== operation.skillSlug
            || existing.toVersion !== operation.toVersion || existing.platform !== operation.platform) throw idempotencyConflict();
          await lockOperationTarget(tx, operation.actorUserId, operation.targetId, false);
          if (!await canReadOperationRelease(tx, operation.actorUserId, operation)) throw operationDenied();
          results.push({ operation: publicOperation(rowOperation(existing)), replayed: true });
          continue;
        }
        const target = await lockOperationTarget(tx, operation.actorUserId, operation.targetId);
        await this.options.beforeEligibility?.();
        await lockOperationSharing(tx);
        await assertOperationEligibility(tx, operation.actorUserId, operation, target, { source: true, now: operation.createdAt });
        const [inserted] = await tx.insert(targetSkillOperations).values(insertValues(operation)).returning();
        if (!inserted) throw operationDenied();
        await this.audit(tx, operation.actorUserId, rowOperation(inserted), "schedule");
        results.push({ operation: publicOperation(rowOperation(inserted)), replayed: false });
      }
      return results;
    });
  }

  async findByIdempotencyKey(targetId: string, key: string): Promise<StoredTargetSkillOperation | null> {
    const [row] = await this.db.select().from(targetSkillOperations).where(and(
      eq(targetSkillOperations.targetId, targetId), eq(targetSkillOperations.idempotencyKey, key),
    )).limit(1);
    return row ? rowOperation(row) : null;
  }

  async canReadRelease(actorId: string, operation: Pick<TargetSkillOperation, "targetId" | "skillSlug" | "toVersion">): Promise<boolean> {
    return canReadOperationRelease(this.db, actorId, operation);
  }

  async listForTarget(targetId: string, limit = 100): Promise<TargetSkillOperation[]> {
    const rows = await this.db.select().from(targetSkillOperations).where(eq(targetSkillOperations.targetId, targetId))
      .orderBy(desc(targetSkillOperations.createdAt), desc(targetSkillOperations.id)).limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => publicOperation(rowOperation(row)));
  }

  async get(id: string): Promise<StoredTargetSkillOperation | null> {
    const [row] = await this.db.select().from(targetSkillOperations).where(eq(targetSkillOperations.id, id)).limit(1);
    return row ? rowOperation(row) : null;
  }

  async latestSuccess(targetId: string, generation: number, slug: string): Promise<TargetSkillOperation | null> {
    const [row] = await this.db.select().from(targetSkillOperations).where(and(
      eq(targetSkillOperations.targetId, targetId), eq(targetSkillOperations.targetGeneration, generation),
      eq(targetSkillOperations.skillSlug, slug), eq(targetSkillOperations.state, "succeeded"),
      sql`${targetSkillOperations.result}->>'installedVersion' = ${targetSkillOperations.toVersion} AND ${targetSkillOperations.result}->>'artifactSha256' = ${targetSkillOperations.artifactSha256} AND ${targetSkillOperations.result}->>'contentDigest' ~ '^[0-9a-f]{64}$'`,
    )).orderBy(desc(targetSkillOperations.updatedAt), desc(targetSkillOperations.id)).limit(1);
    return row ? publicOperation(rowOperation(row)) : null;
  }

  async listClaimable(targetId: string, _now: string, limit = 10, actorId?: string): Promise<StoredTargetSkillOperation[]> {
    if (!actorId) throw operationDenied();
    return this.transaction(async (tx) => {
      const target = await lockOperationTarget(tx, actorId, targetId);
      const now = await databaseTime(tx);
      const [cursor] = await tx.select().from(targetSkillOperationClaimCursors).where(eq(targetSkillOperationClaimCursors.targetId, targetId));
      const select = (after: boolean) => tx.select().from(targetSkillOperations).where(and(
        eq(targetSkillOperations.targetId, targetId), or(eq(targetSkillOperations.state, "queued"),
          and(inArray(targetSkillOperations.state, activeStates), sql`${targetSkillOperations.leaseExpiresAt} <= ${new Date(now)}`)),
        after && cursor ? sql`(${targetSkillOperations.createdAt}, ${targetSkillOperations.id}) > (${cursor.operationCreatedAt}, ${cursor.operationId}::uuid)` : undefined,
      )).orderBy(asc(targetSkillOperations.createdAt), asc(targetSkillOperations.id)).limit(Math.min(Math.max(limit, 1), 10));
      let rows = await select(true);
      if (rows.length === 0 && cursor) rows = await select(false);
      const last = rows.at(-1);
      if (last) await tx.insert(targetSkillOperationClaimCursors).values({ targetId, operationCreatedAt: last.createdAt, operationId: last.id })
        .onConflictDoUpdate({ target: targetSkillOperationClaimCursors.targetId, set: { operationCreatedAt: last.createdAt, operationId: last.id } });
      const candidates = [];
      for (const row of rows) {
        if (row.targetGeneration !== target.generation) await this.expire(tx, actorId, rowOperation(row), now, "target-generation-changed");
        else candidates.push(rowOperation(row));
      }
      return candidates;
    });
  }

  async claim(input: Parameters<TargetSkillOperationStore["claim"]>[0]): Promise<TargetSkillOperation | null> {
    return this.mutate(input.actorId, input.id, async (tx, operation, target) => {
      input = await refreshedLeaseInput(tx, input);
      if (operation.targetGeneration !== target.generation) {
        if (["queued", ...activeStates].includes(operation.state)) await this.expire(tx, input.actorId, operation, input.now, "target-generation-changed");
        return null;
      }
      const claimable = operation.state === "queued" || (activeStates.includes(operation.state) && Date.parse(operation.leaseExpiresAt ?? "") <= Date.parse(input.now));
      if (!claimable || operation.targetGeneration !== input.targetGeneration) return null;
      try { await assertOperationEligibility(tx, input.actorId, operation, target, { source: true, now: input.now }); }
      catch (error) {
        if (operation.state !== "queued" || databaseErrorCode(error) !== "TARGET_OPERATION_SOURCE_CHANGED") throw error;
        await this.expire(tx, input.actorId, operation, input.now, "source-changed");
        return null;
      }
      input = await refreshedLeaseInput(tx, input);
      await assertCurrentWindow(tx, target, input.now);
      const [busy] = await tx.select({ id: targetSkillOperations.id }).from(targetSkillOperations).where(and(
        eq(targetSkillOperations.targetId, operation.targetId), ne(targetSkillOperations.id, operation.id), inArray(targetSkillOperations.state, activeStates),
        sql`${targetSkillOperations.leaseExpiresAt} > ${new Date(input.now)}`,
      )).limit(1);
      const [syncLease] = await tx.select().from(skillArchitectureSyncTargetLeases).where(eq(skillArchitectureSyncTargetLeases.targetId, operation.targetId)).for("update").limit(1);
      if (busy || (syncLease?.status === "active" && syncLease.expiresAt > new Date(input.now))) return null;
      const [maximum] = await tx.select({ fence: sql<number>`coalesce(max(${targetSkillOperations.fencingToken}), 0)` }).from(targetSkillOperations)
        .where(eq(targetSkillOperations.targetId, operation.targetId));
      const fence = Math.max(Number(maximum?.fence ?? 0), Number(syncLease?.fencingToken ?? 0)) + 1;
      if (fence > 1_000_000_000) throw operationDenied("TARGET_OPERATION_FENCE_EXHAUSTED");
      const [row] = await tx.update(targetSkillOperations).set({
        state: "claimed", fencingToken: fence, holderId: input.holderId, claimTokenHash: input.claimTokenHash,
        leaseExpiresAt: new Date(input.leaseExpiresAt), updatedAt: new Date(input.now),
      }).where(eq(targetSkillOperations.id, input.id)).returning();
      if (!row) return null;
      await this.audit(tx, input.actorId, rowOperation(row), "claim");
      return publicOperation(rowOperation(row));
    });
  }

  async advance(input: Parameters<TargetSkillOperationStore["advance"]>[0]): Promise<TargetSkillOperation | null> {
    return this.mutate(input.actorId, input.id, async (tx, operation, target) => {
      const allowed = input.state === "applying" ? ["claimed", "applying"] : ["applying", "verifying"];
      if (!currentClaim(operation, input) || !allowed.includes(operation.state)) return null;
      await assertOperationEligibility(tx, input.actorId, operation, target, { source: true, now: input.now });
      input = await refreshedLeaseInput(tx, input);
      if (!currentClaim(operation, input) || input.fencingToken !== await targetFence(tx, operation.targetId)) return null;
      await assertCurrentWindow(tx, target, input.now);
      const [row] = await tx.update(targetSkillOperations).set({ state: input.state, leaseExpiresAt: new Date(input.leaseExpiresAt), updatedAt: new Date(input.now) })
        .where(eq(targetSkillOperations.id, input.id)).returning();
      if (!row) return null;
      await this.audit(tx, input.actorId, rowOperation(row), input.state);
      return publicOperation(rowOperation(row));
    });
  }

  async complete(input: Parameters<TargetSkillOperationStore["complete"]>[0]): Promise<TargetSkillOperation | null> {
    return this.mutate(input.actorId, input.id, async (tx, operation, target) => {
      if (!currentClaim(operation, input) || !["applying", "verifying"].includes(operation.state) || !targetSkillOperationResultMatchesPlan(operation, input.result)) return null;
      if (input.result.status === "succeeded") await assertOperationEligibility(tx, input.actorId, operation, target, { source: true, now: input.now });
      const currentTime = await databaseTime(tx);
      input = { ...input, now: currentTime, result: { ...input.result, recordedAt: currentTime } };
      if (!currentClaim(operation, input) || input.fencingToken !== await targetFence(tx, operation.targetId)) return null;
      const [row] = await tx.update(targetSkillOperations).set({ state: input.result.status, result: input.result,
        holderId: null, claimTokenHash: null, leaseExpiresAt: null, updatedAt: new Date(input.now),
      }).where(eq(targetSkillOperations.id, input.id)).returning();
      if (!row) return null;
      await this.audit(tx, input.actorId, rowOperation(row), input.result.status);
      return publicOperation(rowOperation(row));
    });
  }

  async cancel(id: string, now: string, actorId: string): Promise<TargetSkillOperation | null> {
    return this.mutate(actorId, id, async (tx, operation) => {
      if (operation.state !== "queued") return null;
      if (!await canReadOperationRelease(tx, actorId, operation)) throw operationDenied();
      const [row] = await tx.update(targetSkillOperations).set({ state: "cancelled", updatedAt: new Date(now) })
        .where(eq(targetSkillOperations.id, id)).returning();
      if (!row) return null;
      await this.audit(tx, actorId, rowOperation(row), "cancel");
      return publicOperation(rowOperation(row));
    });
  }

  private async mutate<T>(actorId: string, id: string, work: (tx: OperationDatabase, operation: StoredTargetSkillOperation,
    target: Awaited<ReturnType<typeof lockOperationTarget>>) => Promise<T>): Promise<T | null> {
    const hint = await this.get(id);
    if (!hint) return null;
    return this.transaction(async (tx) => {
      await tx.select({ id: skillArchitectureTargets.id }).from(skillArchitectureTargets).where(eq(skillArchitectureTargets.id, hint.targetId)).for("update");
      await this.options.beforeAuthorization?.(hint);
      const target = await lockOperationTarget(tx, actorId, hint.targetId);
      await this.options.beforeEligibility?.();
      await lockOperationSharing(tx);
      const [row] = await tx.select().from(targetSkillOperations).where(eq(targetSkillOperations.id, id)).for("update").limit(1);
      if (!row) return null;
      return work(tx, rowOperation(row), target);
    });
  }

  private async expire(db: OperationDatabase, actorId: string, operation: StoredTargetSkillOperation, now: string, reason: string): Promise<void> {
    const [row] = await db.update(targetSkillOperations).set({ state: "expired", holderId: null, claimTokenHash: null, leaseExpiresAt: null, updatedAt: new Date(now) })
      .where(eq(targetSkillOperations.id, operation.id)).returning();
    if (row) await this.audit(db, actorId, rowOperation(row), "expire", reason);
  }

  private async transaction<T>(work: (tx: OperationDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          // Existing owner/grant writers use different aggregate lock orders.
          // A bounded whole-transaction retry releases every lock and audit row.
          await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
          return work(tx);
        });
      } catch (error) {
        if (!["55P03", "40P01"].includes(databaseErrorCode(error) ?? "")) throw error;
        if (attempt >= 3) throw operationDenied("TARGET_OPERATION_BUSY");
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  private async audit(db: OperationDatabase, actorId: string, operation: StoredTargetSkillOperation, action: string, reason?: string): Promise<void> {
    await this.options.beforeAuditInsert?.();
    await db.insert(auditEvents).values({ actorUserId: actorId, action: `target-operation.${action}`, decision: "allow",
      resourceType: "target_skill_operation", resourceId: operation.id,
      details: sanitizeAuditDetails({ targetId: operation.targetId, generation: operation.targetGeneration, action: operation.action,
        planDigest: operation.planDigest, state: operation.state, fence: operation.fencingToken, ...(reason ? { reason } : {}) }),
    });
  }
}

function currentClaim(operation: StoredTargetSkillOperation, input: { holderId: string; claimTokenHash: string; fencingToken: number; now: string }): boolean {
  return operation.holderId === input.holderId && operation.claimTokenHash === input.claimTokenHash && operation.fencingToken === input.fencingToken
    && Date.parse(operation.leaseExpiresAt ?? "") > Date.parse(input.now);
}

function idempotencyConflict(): AppError {
  return new AppError("Target operation idempotency conflict.", "TARGET_OPERATION_IDEMPOTENCY_CONFLICT", 409);
}

function insertValues(operation: StoredTargetSkillOperation): typeof targetSkillOperations.$inferInsert {
  return {
    id: operation.id,
    schemaVersion: 1,
    targetId: operation.targetId,
    targetGeneration: operation.targetGeneration,
    actorUserId: operation.actorUserId,
    action: operation.action,
    skillSlug: operation.skillSlug,
    fromVersion: operation.fromVersion ?? null,
    toVersion: operation.toVersion,
    platform: operation.platform,
    artifactSha256: operation.artifact.sha256,
    artifactByteSize: operation.artifact.byteSize,
    artifactContentType: operation.artifact.contentType,
    planDigest: operation.planDigest,
    state: operation.state,
    fencingToken: operation.fencingToken,
    idempotencyKey: operation.idempotencyKey,
    createdAt: new Date(operation.createdAt),
    updatedAt: new Date(operation.updatedAt),
  };
}

function rowOperation(row: typeof targetSkillOperations.$inferSelect): StoredTargetSkillOperation {
  return {
    schemaVersion: 1,
    id: row.id,
    targetId: row.targetId,
    targetGeneration: row.targetGeneration,
    actorUserId: row.actorUserId,
    action: row.action as StoredTargetSkillOperation["action"],
    skillSlug: row.skillSlug,
    ...(row.fromVersion ? { fromVersion: row.fromVersion } : {}),
    toVersion: row.toVersion,
    platform: row.platform,
    artifact: { sha256: row.artifactSha256, byteSize: row.artifactByteSize, contentType: row.artifactContentType },
    planDigest: row.planDigest,
    state: row.state as StoredTargetSkillOperation["state"],
    fencingToken: row.fencingToken,
    ...(row.holderId ? { holderId: row.holderId } : {}),
    ...(row.claimTokenHash ? { claimTokenHash: row.claimTokenHash } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
    ...(row.result ? { result: row.result } : {}),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publicOperation(operation: StoredTargetSkillOperation): TargetSkillOperation {
  const { actorUserId: _actor, idempotencyKey: _key, holderId: _holder, claimTokenHash: _token, ...safe } = operation;
  return safe;
}

async function databaseTime(db: OperationDatabase): Promise<string> {
  const result = await db.execute(sql`SELECT clock_timestamp() AS now`);
  return new Date(result.rows[0]!.now as string | Date).toISOString();
}
async function refreshedLeaseInput<T extends { now: string; leaseExpiresAt: string }>(db: OperationDatabase, input: T): Promise<T> {
  const duration = Math.min(300_000, Math.max(1_000, Date.parse(input.leaseExpiresAt) - Date.parse(input.now)));
  const now = await databaseTime(db);
  return { ...input, now, leaseExpiresAt: new Date(Date.parse(now) + duration).toISOString() };
}
async function targetFence(db: OperationDatabase, targetId: string): Promise<number> {
  const [operations] = await db.select({ fence: sql<number>`coalesce(max(${targetSkillOperations.fencingToken}), 0)` }).from(targetSkillOperations).where(eq(targetSkillOperations.targetId, targetId));
  const [sync] = await db.select({ fence: skillArchitectureSyncTargetLeases.fencingToken }).from(skillArchitectureSyncTargetLeases).where(eq(skillArchitectureSyncTargetLeases.targetId, targetId));
  return Math.max(Number(operations?.fence ?? 0), Number(sync?.fence ?? 0));
}
async function assertCurrentWindow(db: OperationDatabase, target: Awaited<ReturnType<typeof lockOperationTarget>>, now: string): Promise<void> {
  const policy = await resolveLockedUpgradePolicy(db, target);
  if (policy.mode === "maintenance-window" && !isWithinSkillUpgradeMaintenanceWindow(policy, new Date(now))) throw operationDenied("TARGET_OPERATION_OUTSIDE_MAINTENANCE_WINDOW");
}
function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? databaseErrorCode(error.cause) : undefined;
}
