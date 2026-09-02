import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { skillUpgradePolicyRevisions } from "../db/schema.js";
import type { SkillUpgradePolicyRevision, SkillUpgradePolicyScope, SkillUpgradePolicyStore } from "./types.js";

export class PostgresSkillUpgradePolicyStore implements SkillUpgradePolicyStore {
  readonly kind = "postgres" as const;
  constructor(private readonly db: Database) {}

  async getLatest(scopeType: SkillUpgradePolicyScope, scopeId: string): Promise<SkillUpgradePolicyRevision | null> {
    const [row] = await this.db.select().from(skillUpgradePolicyRevisions).where(and(
      eq(skillUpgradePolicyRevisions.scopeType, scopeType),
      eq(skillUpgradePolicyRevisions.scopeId, scopeId),
    )).orderBy(desc(skillUpgradePolicyRevisions.revisionNumber)).limit(1);
    return row ? projection(row) : null;
  }

  async append(input: Parameters<SkillUpgradePolicyStore["append"]>[0]): Promise<{ revision: SkillUpgradePolicyRevision; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.scopeType}:${input.scopeId}`}, 0))`);
      const [latest] = await tx.select().from(skillUpgradePolicyRevisions).where(and(
        eq(skillUpgradePolicyRevisions.scopeType, input.scopeType),
        eq(skillUpgradePolicyRevisions.scopeId, input.scopeId),
      )).orderBy(desc(skillUpgradePolicyRevisions.revisionNumber)).limit(1);
      if ((latest?.revisionNumber ?? 0) !== input.expectedRevisionNumber) throw conflict();
      if (latest?.policySha256 === input.policySha256) return { revision: projection(latest), created: false };
      const [created] = await tx.insert(skillUpgradePolicyRevisions).values({
        id: input.id,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        revisionNumber: input.expectedRevisionNumber + 1,
        policy: input.policy,
        policySha256: input.policySha256,
        reason: input.reason,
        createdByUserId: input.actorUserId,
        createdAt: new Date(input.createdAt),
      }).returning();
      if (!created) throw conflict();
      return { revision: projection(created), created: true };
    });
  }
}

function projection(row: typeof skillUpgradePolicyRevisions.$inferSelect): SkillUpgradePolicyRevision {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    revisionNumber: row.revisionNumber,
    policy: row.policy,
    policySha256: row.policySha256,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function conflict(): Error & { code: string } {
  return Object.assign(new Error("Skill upgrade policy revision changed."), { code: "SKILL_UPGRADE_POLICY_REVISION_CONFLICT" });
}
