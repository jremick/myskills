import { AppError } from "@myskills-app/core";
import { sql, type SQL } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client.js";

/** Management authority only. Registry delivery still requires a release grant. */
export function effectiveTeamOwnerPredicate(teamId: SQL | string, actorId: SQL | string): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM teams ownership_team
    JOIN team_memberships ownership_member ON ownership_member.team_id = ownership_team.id
    JOIN users ownership_user ON ownership_user.id = ownership_member.user_id
    LEFT JOIN organizations ownership_org ON ownership_org.id = ownership_team.organization_id
    LEFT JOIN organization_policy_revisions ownership_policy
      ON ownership_policy.organization_id = ownership_org.id AND ownership_policy.id = ownership_org.current_policy_revision_id
    LEFT JOIN organization_memberships ownership_org_member
      ON ownership_org_member.organization_id = ownership_org.id AND ownership_org_member.user_id = ownership_member.user_id
      AND ownership_org_member.removed_at IS NULL
    WHERE ownership_team.id = ${teamId}::uuid AND ownership_member.user_id = ${actorId}::uuid
      AND ownership_member.role = 'owner' AND ownership_user.status = 'active'
      AND coalesce((SELECT value->>'teamsEnabled' FROM instance_settings WHERE key = 'sharing'), 'true') = 'true'
      AND coalesce((SELECT value->>'teamVisibilityEnabled' FROM instance_settings WHERE key = 'sharing'), 'true') = 'true'
      AND (ownership_team.organization_id IS NULL OR (
        ownership_org.status = 'active' AND ownership_policy.id IS NOT NULL
        AND (coalesce(ownership_policy.policy->'teams'->>'requireOrganizationMembershipForTeamMembers', 'true') = 'false'
          OR ownership_org_member.id IS NOT NULL)
      ))
  )`;
}

export async function isCurrentTeamOwner(db: Pick<Database, "execute">, teamId: string, actorId: string): Promise<boolean> {
  const result = await db.execute<{ allowed: boolean }>(sql`SELECT ${effectiveTeamOwnerPredicate(teamId, actorId)} AS allowed`);
  return result.rows[0]?.allowed === true;
}

/**
 * Match team mutations: settings, team, parent organization, organization
 * membership, user, team membership. Parent locks fence immutable policy changes;
 * the user lock also fences instance role replacement and account disabling.
 * Shared authority locks coexist with bundle reads in the opposite aggregate
 * order; callers serialize their own Library, skill, entry and lineage writes.
 * Callers that need skill locks acquire settings and skill rows before this helper.
 */
export async function assertCurrentTeamOwner(tx: DatabaseTransaction, teamId: string, actorId: string): Promise<void> {
  await tx.execute(sql`SELECT key FROM instance_settings WHERE key = 'sharing' FOR SHARE`);
  const team = (await tx.execute<{ organization_id: string | null }>(sql`
    SELECT organization_id FROM teams WHERE id = ${teamId}::uuid FOR SHARE
  `)).rows[0];
  if (team?.organization_id) {
    await tx.execute(sql`SELECT id FROM organizations WHERE id = ${team.organization_id}::uuid FOR SHARE`);
    await tx.execute(sql`SELECT id FROM organization_memberships
      WHERE organization_id = ${team.organization_id}::uuid AND user_id = ${actorId}::uuid FOR SHARE`);
  }
  await tx.execute(sql`SELECT id FROM users WHERE id = ${actorId}::uuid FOR SHARE`);
  await tx.execute(sql`SELECT id FROM team_memberships
    WHERE team_id = ${teamId}::uuid AND user_id = ${actorId}::uuid FOR SHARE`);
  if (!team || !await isCurrentTeamOwner(tx, teamId, actorId)) {
    throw new AppError("Library write access is required.", "LIBRARY_WRITE_FORBIDDEN", 403);
  }
}
