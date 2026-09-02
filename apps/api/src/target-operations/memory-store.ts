import type { TargetSkillOperation, TargetSkillOperationResult } from "@myskills-app/core";
import type { CreateTargetSkillOperationInput, StoredTargetSkillOperation, TargetSkillOperationStore } from "./types.js";

export class MemoryTargetSkillOperationStore implements TargetSkillOperationStore {
  readonly kind = "memory" as const;
  private readonly operations = new Map<string, StoredTargetSkillOperation>();

  async create(input: CreateTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }> {
    const duplicate = [...this.operations.values()].find((operation) => (
      operation.targetId === input.operation.targetId
      && operation.idempotencyKey === input.operation.idempotencyKey
    ));
    if (duplicate) {
      if (duplicate.planDigest !== input.operation.planDigest || duplicate.actorUserId !== input.operation.actorUserId) {
        throw operationConflict();
      }
      return { operation: publicOperation(duplicate), replayed: true };
    }
    this.operations.set(input.operation.id, structuredClone(input.operation));
    return { operation: publicOperation(input.operation), replayed: false };
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

  async listClaimable(targetId: string, now: string, limit = 10): Promise<StoredTargetSkillOperation[]> {
    const nowMs = Date.parse(now);
    return [...this.operations.values()]
      .filter((operation) => operation.targetId === targetId && (
        operation.state === "queued"
        || (["claimed", "applying", "verifying"].includes(operation.state)
          && Boolean(operation.leaseExpiresAt)
          && Date.parse(operation.leaseExpiresAt ?? "") <= nowMs)
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, Math.min(Math.max(limit, 1), 10))
      .map((operation) => structuredClone(operation));
  }

  async claim(input: {
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
    operation.state = "claimed";
    operation.fencingToken += 1;
    operation.holderId = input.holderId;
    operation.claimTokenHash = input.claimTokenHash;
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.now;
    return publicOperation(operation);
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
    const operation = this.currentClaim(input);
    if (!operation || (input.state === "applying" && operation.state !== "claimed") || (input.state === "verifying" && operation.state !== "applying")) return null;
    operation.state = input.state;
    operation.leaseExpiresAt = input.leaseExpiresAt;
    operation.updatedAt = input.now;
    return publicOperation(operation);
  }

  async complete(input: {
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    result: TargetSkillOperationResult;
    now: string;
  }): Promise<TargetSkillOperation | null> {
    const operation = this.currentClaim(input);
    if (!operation || (operation.state !== "applying" && operation.state !== "verifying")) return null;
    operation.state = input.result.status;
    operation.result = structuredClone(input.result);
    operation.updatedAt = input.now;
    operation.leaseExpiresAt = undefined;
    operation.holderId = undefined;
    operation.claimTokenHash = undefined;
    return publicOperation(operation);
  }

  async cancel(id: string, now: string): Promise<TargetSkillOperation | null> {
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
