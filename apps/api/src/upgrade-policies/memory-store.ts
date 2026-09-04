import type { SkillUpgradePolicyRevision, SkillUpgradePolicyScope, SkillUpgradePolicyStore } from "./types.js";

export class MemorySkillUpgradePolicyStore implements SkillUpgradePolicyStore {
  readonly kind = "memory" as const;
  private readonly revisions: SkillUpgradePolicyRevision[] = [];

  async getLatest(scopeType: SkillUpgradePolicyScope, scopeId: string): Promise<SkillUpgradePolicyRevision | null> {
    const revision = this.revisions
      .filter((item) => item.scopeType === scopeType && item.scopeId === scopeId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    return revision ? structuredClone(revision) : null;
  }

  async append(input: Parameters<SkillUpgradePolicyStore["append"]>[0]): Promise<{ revision: SkillUpgradePolicyRevision; created: boolean }> {
    const latest = await this.getLatest(input.scopeType, input.scopeId);
    if ((latest?.revisionNumber ?? 0) !== input.expectedRevisionNumber) throw conflict("SKILL_UPGRADE_POLICY_REVISION_CONFLICT");
    if (latest?.policySha256 === input.policySha256) return { revision: latest, created: false };
    const revision: SkillUpgradePolicyRevision = {
      id: input.id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      revisionNumber: input.expectedRevisionNumber + 1,
      policy: structuredClone(input.policy),
      policySha256: input.policySha256,
      reason: input.reason,
      createdByUserId: input.actorUserId,
      createdAt: input.createdAt,
    };
    this.revisions.push(revision);
    return { revision: structuredClone(revision), created: true };
  }
}

function conflict(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
