import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { TargetSkillOperation } from "@myskills-app/core";
import type { Database } from "../db/client.js";
import { targetSkillOperations } from "../db/schema.js";
import type { CreateTargetSkillOperationInput, StoredTargetSkillOperation, TargetSkillOperationStore } from "./types.js";

export class PostgresTargetSkillOperationStore implements TargetSkillOperationStore {
  readonly kind = "postgres" as const;
  constructor(private readonly db: Database) {}

  async create(input: CreateTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }> {
    const values = insertValues(input.operation);
    const [inserted] = await this.db.insert(targetSkillOperations).values(values).onConflictDoNothing({
      target: [targetSkillOperations.targetId, targetSkillOperations.idempotencyKey],
    }).returning();
    if (inserted) return { operation: publicOperation(rowOperation(inserted)), replayed: false };
    const [existing] = await this.db.select().from(targetSkillOperations).where(and(
      eq(targetSkillOperations.targetId, input.operation.targetId),
      eq(targetSkillOperations.idempotencyKey, input.operation.idempotencyKey),
    )).limit(1);
    if (!existing || existing.planDigest !== input.operation.planDigest || existing.actorUserId !== input.operation.actorUserId) {
      throw Object.assign(new Error("Target operation idempotency conflict."), { code: "TARGET_OPERATION_IDEMPOTENCY_CONFLICT" });
    }
    return { operation: publicOperation(rowOperation(existing)), replayed: true };
  }

  async listForTarget(targetId: string, limit = 100): Promise<TargetSkillOperation[]> {
    const rows = await this.db.select().from(targetSkillOperations)
      .where(eq(targetSkillOperations.targetId, targetId))
      .orderBy(desc(targetSkillOperations.createdAt), desc(targetSkillOperations.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => publicOperation(rowOperation(row)));
  }

  async get(id: string): Promise<StoredTargetSkillOperation | null> {
    const [row] = await this.db.select().from(targetSkillOperations).where(eq(targetSkillOperations.id, id)).limit(1);
    return row ? rowOperation(row) : null;
  }

  async listClaimable(targetId: string, now: string, limit = 10): Promise<StoredTargetSkillOperation[]> {
    const rows = await this.db.select().from(targetSkillOperations).where(and(
      eq(targetSkillOperations.targetId, targetId),
      or(
        eq(targetSkillOperations.state, "queued"),
        and(
          inArray(targetSkillOperations.state, ["claimed", "applying", "verifying"]),
          lt(targetSkillOperations.leaseExpiresAt, new Date(now)),
        ),
      ),
    )).orderBy(asc(targetSkillOperations.createdAt), asc(targetSkillOperations.id)).limit(Math.min(Math.max(limit, 1), 10));
    return rows.map(rowOperation);
  }

  async claim(input: {
    id: string;
    targetGeneration: number;
    holderId: string;
    claimTokenHash: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const [row] = await this.db.update(targetSkillOperations).set({
      state: "claimed",
      fencingToken: sql`${targetSkillOperations.fencingToken} + 1`,
      holderId: input.holderId,
      claimTokenHash: input.claimTokenHash,
      leaseExpiresAt: new Date(input.leaseExpiresAt),
      updatedAt: new Date(input.now),
    }).where(and(
      eq(targetSkillOperations.id, input.id),
      eq(targetSkillOperations.targetGeneration, input.targetGeneration),
      or(
        eq(targetSkillOperations.state, "queued"),
        and(
          inArray(targetSkillOperations.state, ["claimed", "applying", "verifying"]),
          lt(targetSkillOperations.leaseExpiresAt, new Date(input.now)),
        ),
      ),
    )).returning();
    return row ? publicOperation(rowOperation(row)) : null;
  }

  async advance(input: {
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    state: "applying" | "verifying";
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const expectedState = input.state === "applying" ? "claimed" : "applying";
    const [row] = await this.db.update(targetSkillOperations).set({
      state: input.state,
      leaseExpiresAt: new Date(input.leaseExpiresAt),
      updatedAt: new Date(input.now),
    }).where(and(
      eq(targetSkillOperations.id, input.id),
      eq(targetSkillOperations.state, expectedState),
      eq(targetSkillOperations.holderId, input.holderId),
      eq(targetSkillOperations.claimTokenHash, input.claimTokenHash),
      eq(targetSkillOperations.fencingToken, input.fencingToken),
      gt(targetSkillOperations.leaseExpiresAt, new Date(input.now)),
    )).returning();
    return row ? publicOperation(rowOperation(row)) : null;
  }

  async complete(input: Parameters<TargetSkillOperationStore["complete"]>[0]): Promise<TargetSkillOperation | null> {
    const [row] = await this.db.update(targetSkillOperations).set({
      state: input.result.status,
      result: input.result,
      holderId: null,
      claimTokenHash: null,
      leaseExpiresAt: null,
      updatedAt: new Date(input.now),
    }).where(and(
      eq(targetSkillOperations.id, input.id),
      inArray(targetSkillOperations.state, ["applying", "verifying"]),
      eq(targetSkillOperations.holderId, input.holderId),
      eq(targetSkillOperations.claimTokenHash, input.claimTokenHash),
      eq(targetSkillOperations.fencingToken, input.fencingToken),
      gt(targetSkillOperations.leaseExpiresAt, new Date(input.now)),
    )).returning();
    return row ? publicOperation(rowOperation(row)) : null;
  }

  async cancel(id: string, now: string): Promise<TargetSkillOperation | null> {
    const [row] = await this.db.update(targetSkillOperations).set({ state: "cancelled", updatedAt: new Date(now) })
      .where(and(eq(targetSkillOperations.id, id), eq(targetSkillOperations.state, "queued"))).returning();
    return row ? publicOperation(rowOperation(row)) : null;
  }
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
