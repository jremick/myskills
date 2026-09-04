import { canonicalizeJson, sha256Hex } from "./architecture.js";

export const targetSkillOperationActions = ["install", "update", "rollback"] as const;
export type TargetSkillOperationAction = (typeof targetSkillOperationActions)[number];

export const targetSkillOperationStates = [
  "queued",
  "claimed",
  "applying",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export type TargetSkillOperationState = (typeof targetSkillOperationStates)[number];

export interface TargetSkillOperationArtifact {
  sha256: string;
  byteSize: number;
  contentType: string;
}

export interface TargetSkillOperationResult {
  status: "succeeded" | "failed";
  code: string;
  installedVersion?: string;
  artifactSha256?: string;
  contentDigest?: string;
  recordedAt: string;
}

export interface TargetSkillOperation {
  schemaVersion: 1;
  id: string;
  targetId: string;
  targetGeneration: number;
  action: TargetSkillOperationAction;
  skillSlug: string;
  fromVersion?: string;
  toVersion: string;
  platform: string;
  artifact: TargetSkillOperationArtifact;
  planDigest: string;
  state: TargetSkillOperationState;
  fencingToken: number;
  leaseExpiresAt?: string;
  result?: TargetSkillOperationResult;
  createdAt: string;
  updatedAt: string;
}

export interface TargetSkillOperationPlanInput {
  targetId: string;
  targetGeneration: number;
  action: TargetSkillOperationAction;
  skillSlug: string;
  fromVersion?: string;
  toVersion: string;
  platform: string;
  artifact: TargetSkillOperationArtifact;
}

export function targetSkillOperationPlanDigest(input: TargetSkillOperationPlanInput): string {
  return sha256Hex(canonicalizeJson({
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
    action: input.action,
    skillSlug: input.skillSlug,
    ...(input.fromVersion ? { fromVersion: input.fromVersion } : {}),
    toVersion: input.toVersion,
    platform: input.platform,
    artifact: input.artifact,
  }));
}

/** A receipt reports executor verification; it does not prove runtime recognition. */
export function targetSkillOperationResultMatchesPlan(operation: TargetSkillOperation, result: TargetSkillOperationResult): boolean {
  return result.status === "failed" || (
    operation.state === "verifying"
    && result.installedVersion === operation.toVersion
    && result.artifactSha256 === operation.artifact.sha256
    && typeof result.contentDigest === "string"
    && /^[a-f0-9]{64}$/.test(result.contentDigest)
  );
}
