import type { ImprovementScopeRef } from "@myskills-app/core";

export type ImprovementScopeRole = "owner" | "admin" | "member";
export interface ImprovementScopeAccess {
  team(id: string): Promise<{ role: ImprovementScopeRole; organizationId: string | null } | null>;
  organization(id: string): Promise<ImprovementScopeRole | null>;
}
/** Suite/document access requires parent organization membership even when release sharing permits external teams. */
export async function resolveImprovementScopeRole(actorId: string, scope: ImprovementScopeRef, access: ImprovementScopeAccess): Promise<ImprovementScopeRole | null> {
  if (scope.type === "user") return scope.id === actorId ? "owner" : null;
  if (scope.type === "organization") return access.organization(scope.id);
  const team = await access.team(scope.id);
  if (!team || (team.organizationId && !await access.organization(team.organizationId))) return null;
  return team.role;
}
export function isImprovementScopeWriter(scope: ImprovementScopeRef, role: ImprovementScopeRole | null): boolean {
  return role !== null && (scope.type === "user" || (scope.type === "team" ? role === "owner" : role === "owner" || role === "admin"));
}
