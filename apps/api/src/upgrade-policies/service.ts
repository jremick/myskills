import { randomUUID } from "node:crypto";
import {
  AppError,
  defaultSkillUpgradePolicyV1,
  normalizeSkillUpgradePolicyV1,
  skillUpgradePolicyDigest,
  type SkillUpgradePolicyV1,
} from "@myskills-app/core";
import type { ArchitectureTargetRecord } from "../targets/types.js";
import type { SkillUpgradePolicyRevision, SkillUpgradePolicyScope, SkillUpgradePolicyStore } from "./types.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class SkillUpgradePolicyService {
  constructor(private readonly store: SkillUpgradePolicyStore, private readonly options: { now?: () => Date; idFactory?: () => string } = {}) {}

  async get(scopeTypeInput: SkillUpgradePolicyScope, scopeIdInput: string): Promise<SkillUpgradePolicyRevision | null> {
    return this.store.getLatest(scopeType(scopeTypeInput), identifier(scopeIdInput));
  }

  async resolveForTarget(target: ArchitectureTargetRecord): Promise<{ policy: SkillUpgradePolicyV1; source: "target" | "organization" | "default"; revision: SkillUpgradePolicyRevision | null }> {
    const targetRevision = await this.store.getLatest("target", target.id);
    if (targetRevision) return { policy: targetRevision.policy, source: "target", revision: targetRevision };
    if (target.owner.type === "organization") {
      const organizationRevision = await this.store.getLatest("organization", target.owner.id);
      if (organizationRevision) return { policy: organizationRevision.policy, source: "organization", revision: organizationRevision };
    }
    return { policy: structuredClone(defaultSkillUpgradePolicyV1), source: "default", revision: null };
  }

  async append(input: {
    actorUserId: string;
    scopeType: SkillUpgradePolicyScope;
    scopeId: string;
    expectedRevisionNumber: number;
    policy: unknown;
    reason?: string;
  }): Promise<{ revision: SkillUpgradePolicyRevision; created: boolean }> {
    const actorUserId = identifier(input.actorUserId);
    const normalizedScope = scopeType(input.scopeType);
    const scopeId = identifier(input.scopeId);
    if (!Number.isInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 0 || input.expectedRevisionNumber > 1_000_000_000) throw invalid("Expected policy revision is invalid.");
    let policy: SkillUpgradePolicyV1;
    try {
      policy = normalizeSkillUpgradePolicyV1(input.policy);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "Skill upgrade policy is invalid.");
    }
    const reason = input.reason?.trim() ?? "";
    if (reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) throw invalid("Policy reason is invalid.");
    try {
      return await this.store.append({
        id: this.options.idFactory?.() ?? randomUUID(),
        scopeType: normalizedScope,
        scopeId,
        expectedRevisionNumber: input.expectedRevisionNumber,
        policy,
        policySha256: skillUpgradePolicyDigest(policy),
        reason,
        actorUserId,
        createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
    } catch (error) {
      if (errorCode(error) === "SKILL_UPGRADE_POLICY_REVISION_CONFLICT") throw new AppError("The upgrade policy changed. Refresh before saving.", "SKILL_UPGRADE_POLICY_REVISION_CONFLICT", 409);
      throw error;
    }
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw invalid("Policy identifier is invalid.");
  return value;
}

function scopeType(value: unknown): SkillUpgradePolicyScope {
  if (value !== "target" && value !== "organization") throw invalid("Policy scope is invalid.");
  return value;
}

function invalid(message: string): AppError {
  return new AppError(message, "INVALID_SKILL_UPGRADE_POLICY", 400);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
}
