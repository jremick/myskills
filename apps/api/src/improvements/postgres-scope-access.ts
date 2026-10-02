import { sql } from "drizzle-orm";
import type { ImprovementScopeRef } from "@myskills-app/core";
import type { DatabaseTransaction } from "../db/client.js";
import { resolveImprovementScopeRole, type ImprovementScopeRole } from "./scope-access.js";

/** Retain governing aggregates and membership rows through evaluation completion/readback. */
export async function readImprovementScopeRole(tx: DatabaseTransaction, actorId: string, scope: ImprovementScopeRef) {
  return resolveImprovementScopeRole(actorId, scope, {
    team: async id => {
      const teams = await tx.execute(sql`SELECT organization_id FROM teams WHERE id=${id}::uuid FOR SHARE`);
      if (!teams.rows[0]) return null;
      const members = await tx.execute(sql`SELECT role FROM team_memberships WHERE team_id=${id}::uuid AND user_id=${actorId}::uuid FOR SHARE`);
      return members.rows[0] ? { role: members.rows[0].role as ImprovementScopeRole, organizationId: teams.rows[0].organization_id as string | null } : null;
    },
    organization: async id => {
      const organizations = await tx.execute(sql`SELECT status FROM organizations WHERE id=${id}::uuid FOR SHARE`);
      if (organizations.rows[0]?.status !== "active") return null;
      const members = await tx.execute(sql`SELECT role FROM organization_memberships WHERE organization_id=${id}::uuid AND user_id=${actorId}::uuid AND removed_at IS NULL FOR SHARE`);
      return members.rows[0]?.role as ImprovementScopeRole | undefined ?? null;
    },
  });
}
