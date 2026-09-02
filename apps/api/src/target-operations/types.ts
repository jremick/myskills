import type { TargetSkillOperation, TargetSkillOperationAction, TargetSkillOperationResult } from "@myskills-app/core";

export interface StoredTargetSkillOperation extends TargetSkillOperation {
  actorUserId: string;
  idempotencyKey: string;
  holderId?: string;
  claimTokenHash?: string;
}

export interface CreateTargetSkillOperationInput {
  operation: StoredTargetSkillOperation;
}

export interface ClaimTargetSkillOperationResult {
  operation: TargetSkillOperation;
  claimToken: string;
}

export interface TargetSkillOperationStore {
  readonly kind: "memory" | "postgres";
  create(input: CreateTargetSkillOperationInput): Promise<{ operation: TargetSkillOperation; replayed: boolean }>;
  listForTarget(targetId: string, limit?: number): Promise<TargetSkillOperation[]>;
  get(id: string): Promise<StoredTargetSkillOperation | null>;
  listClaimable(targetId: string, now: string, limit?: number): Promise<StoredTargetSkillOperation[]>;
  claim(input: {
    id: string;
    targetGeneration: number;
    holderId: string;
    claimTokenHash: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  advance(input: {
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    state: "applying" | "verifying";
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  complete(input: {
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    result: TargetSkillOperationResult;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  cancel(id: string, now: string): Promise<TargetSkillOperation | null>;
}

export interface ScheduleTargetSkillOperationInput {
  actorId: string;
  targetId: string;
  action: TargetSkillOperationAction;
  slug: string;
  version: string;
  platform?: string;
  idempotencyKey: string;
}
