import type { SkillUpgradePolicyConstraint, SkillUpgradePolicyV1 } from "@myskills-app/core";

export type SkillUpgradePolicyScope = "target" | "organization";

export interface SkillUpgradePolicyRevision {
  id: string;
  scopeType: SkillUpgradePolicyScope;
  scopeId: string;
  revisionNumber: number;
  policy: SkillUpgradePolicyV1;
  policySha256: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
}

export interface SkillUpgradePolicyStore {
  readonly kind: "memory" | "postgres";
  getLatest(scopeType: SkillUpgradePolicyScope, scopeId: string): Promise<SkillUpgradePolicyRevision | null>;
  append(input: {
    id: string;
    scopeType: SkillUpgradePolicyScope;
    scopeId: string;
    expectedRevisionNumber: number;
    policy: SkillUpgradePolicyV1;
    policySha256: string;
    reason: string;
    actorUserId: string;
    createdAt: string;
  }): Promise<{ revision: SkillUpgradePolicyRevision; created: boolean }>;
}

export interface ResolvedSkillUpgradePolicy {
  /** @deprecated Requested-policy projection only; constraints define the enforced ceiling. */
  policy: SkillUpgradePolicyV1;
  /** @deprecated Source of the requested-policy projection, not the effective ceiling. */
  source: SkillUpgradePolicyConstraint["source"];
  /** @deprecated Revision of the requested-policy projection. */
  revision: SkillUpgradePolicyRevision | null;
  constraints: Array<SkillUpgradePolicyConstraint & { revision: SkillUpgradePolicyRevision | null }>;
}
