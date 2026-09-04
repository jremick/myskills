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
  createBatch(inputs: CreateTargetSkillOperationInput[]): Promise<Array<{ operation: TargetSkillOperation; replayed: boolean }>>;
  findByIdempotencyKey(targetId: string, key: string): Promise<StoredTargetSkillOperation | null>;
  latestSuccess(targetId: string, generation: number, slug: string): Promise<TargetSkillOperation | null>;
  canReadRelease?(actorId: string, operation: Pick<TargetSkillOperation, "targetId" | "skillSlug" | "toVersion">): Promise<boolean>;
  listForTarget(targetId: string, limit?: number): Promise<TargetSkillOperation[]>;
  get(id: string): Promise<StoredTargetSkillOperation | null>;
  listClaimable(targetId: string, now: string, limit?: number, actorId?: string): Promise<StoredTargetSkillOperation[]>;
  claim(input: {
    actorId: string;
    id: string;
    targetGeneration: number;
    holderId: string;
    claimTokenHash: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  advance(input: {
    actorId: string;
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    state: "applying" | "verifying";
    leaseExpiresAt: string;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  complete(input: {
    actorId: string;
    id: string;
    holderId: string;
    claimTokenHash: string;
    fencingToken: number;
    result: TargetSkillOperationResult;
    now: string;
  }): Promise<TargetSkillOperation | null>;
  cancel(id: string, now: string, actorId: string): Promise<TargetSkillOperation | null>;
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
