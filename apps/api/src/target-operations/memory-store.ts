import { targetSkillOperationResultMatchesPlan, type TargetSkillOperation, type TargetSkillOperationResult } from "@myskills-app/core";
import type { CreateTargetSkillOperationInput, StoredTargetSkillOperation, TargetSkillOperationStore } from "./types.js";

export class MemoryTargetSkillOperationStore implements TargetSkillOperationStore {
  readonly kind = "memory" as const;
  private claimCursors = new Map<string, { createdAt: string; id: string }>();
  private operations = new Map<string, StoredTargetSkillOperation>();

  async create(input: CreateTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }> {
    return (await this.createBatch([input]))[0]!;
  }

  async findByIdempotencyKey(targetId: string, key: string): Promise<StoredTargetSkillOperation | null> {
    const operation = [...this.operations.values()].find((item) => item.targetId === targetId && item.idempotencyKey === key);
    return operation ? structuredClone(operation) : null;
  }

  async createBatch(inputs: CreateTargetSkillOperationInput[]): Promise<Array<{ operation: TargetSkillOperation; replayed: boolean }>> {
    // Stage the complete batch synchronously before publishing any changes.
    const staged = new Map(this.operations);
    const results = inputs.map(({ operation }) => {
      const existing = [...staged.values()].find((item) => item.targetId === operation.targetId && item.idempotencyKey === operation.idempotencyKey);
      if (existing) {
        if (existing.planDigest !== operation.planDigest || existing.actorUserId !== operation.actorUserId) throw operationConflict();
        return { operation: publicOperation(existing), replayed: true };
      }
      staged.set(operation.id, structuredClone(operation));
      return { operation: publicOperation(operation), replayed: false };
    });
    this.operations = staged;
    return results;
  }

  async listForTarget(targetId: string, limit = 100): Promise<TargetSkillOperation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.targetId === targetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.min(Math.max(limit, 1), 100))
      .map(publicOperation);
  }

  async get(id: string): Promise<StoredTargetSkillOperation | null> {
    const operation = this.operations.get(id);
    return operation ? structuredClone(operation) : null;
  }

  async latestSuccess(targetId: string, generation: number, slug: string): Promise<TargetSkillOperation | null> {
    const operation = [...this.operations.values()].filter((item) => item.targetId === targetId && item.targetGeneration === generation && item.skillSlug === slug
      && item.state === "succeeded" && item.result?.installedVersion === item.toVersion && item.result.artifactSha256 === item.artifact.sha256 && /^[a-f0-9]{64}$/.test(item.result.contentDigest ?? ""))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0];
    return operation ? publicOperation(operation) : null;
  }

  async listClaimable(targetId: string, now: string, limit = 10): Promise<StoredTargetSkillOperation[]> {
    const nowMs = Date.parse(now);
    const candidates = [...this.operations.values()]
      .filter((operation) => operation.targetId === targetId && (
        operation.state === "queued"
        || (["claimed", "applying", "verifying"].includes(operation.state)
          && Boolean(operation.leaseExpiresAt)
          && Date.parse(operation.leaseExpiresAt ?? "") <= nowMs)
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const cursor = this.claimCursors.get(targetId);
    const next = cursor ? candidates.filter((item) => item.createdAt > cursor.createdAt || (item.createdAt === cursor.createdAt && item.id > cursor.id)) : candidates;
    const selected = (next.length ? next : candidates).slice(0, Math.min(Math.max(limit, 1), 10));
    const last = selected.at(-1);
    if (last) this.claimCursors.set(targetId, { createdAt: last.createdAt, id: last.id });
    return selected.map((operation) => structuredClone(operation));
  }

  async claim(input: {
    actorId: string;
    id: string;
    targetGeneration: number;
    holderId: string;
    claimTokenHash: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const operation = this.operations.get(input.id);
    const reclaimable = operation
      && ["claimed", "applying", "verifying"].includes(operation.state)
      && Boolean(operation.leaseExpiresAt)
      && Date.parse(operation.leaseExpiresAt ?? "") <= Date.parse(input.now);
    if (!operation || (operation.state !== "queued" && !reclaimable) || operation.targetGeneration !== input.targetGeneration) return null;
    if ([...this.operations.values()].some((item) => item.targetId === operation.targetId && item.id !== operation.id
      && ["claimed", "applying", "verifying"].includes(item.state) && Date.parse(item.leaseExpiresAt ?? "") > Date.parse(input.now))) return null;
    operation.state = "claimed";
    operation.fencingToken = Math.max(0, ...[...this.operations.values()].filter((item) => item.targetId === operation.targetId).map((item) => item.fencingToken)) + 1;
    operation.holderId = input.holderId;
    operation.claimTokenHash = input.claimTokenHash;
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.now;
    return publicOperation(operation);
  }

  async advance(input: {
    actorId: string;
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    state: "applying" | "verifying";
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const operation = this.currentClaim(input);
    if (!operation || (input.state === "applying" && operation.state !== "claimed" && operation.state !== "applying") || (input.state === "verifying" && operation.state !== "applying" && operation.state !== "verifying")) return null;
    operation.state = input.state;
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.now;
    return publicOperation(operation);
  }

  async complete(input: {
    actorId: string;
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    result: TargetSkillOperationResult;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const operation = this.currentClaim(input);
    if (!operation || (operation.state !== "applying" && operation.state !== "verifying")) return null;
    if (!targetSkillOperationResultMatchesPlan(operation, input.result)) return null;
    operation.state = input.result.status;
    operation.result = structuredClone(input.result);
    operation.updatedAt = input.now;
    operation.leaseExpiresAt = undefined;
    operation.holderId = undefined;
    operation.claimTokenHash = undefined;
    return publicOperation(operation);
  }

  async cancel(id: string, now: string, _actorId: string): Promise<TargetSkillOperation | null> {
    const operation = this.operations.get(id);
    if (!operation || operation.state !== "queued") return null;
    operation.state = "cancelled";
    operation.updatedAt = now;
    return publicOperation(operation);
  }

  private currentClaim(input: { id: string; holderId: string; claimTokenHash: string; fencingToken: number; now: string }): StoredTargetSkillOperation | null {
    const operation = this.operations.get(input.id);
    if (
      !operation
      || operation.holderId !== input.holderId
      || operation.claimTokenHash !== input.claimTokenHash
      || operation.fencingToken !== input.fencingToken
      || !operation.leaseExpiresAt
      || Date.parse(operation.leaseExpiresAt) <= Date.parse(input.now)
    ) return null;
    return operation;
  }
}

function publicOperation(operation: StoredTargetSkillOperation): TargetSkillOperation {
  const { actorUserId: _actor, idempotencyKey: _idempotency, holderId: _holder, claimTokenHash: _claim, ...safe } = operation;
  return structuredClone(safe);
}

function operationConflict(): Error & { code: string } {
  return Object.assign(new Error("Target operation idempotency key conflicts with another plan."), { code: "TARGET_OPERATION_IDEMPOTENCY_CONFLICT" });
}
