import type { ArchitectureTargetRecord } from "../../api.js";

/** Browser queue support follows the shipped CLI workspace adapter. The API
 * remains the authority for consent, ownership, policy, and execution checks. */
export function canQueueWorkspaceOperation(
  target: ArchitectureTargetRecord,
  platform: string,
  action: "install" | "update" | "rollback",
): boolean {
  return platform === "codex"
    && target.owner.type === "user"
    && target.adapter.kind === "codex-workspace"
    && target.adapter.version === "1.0.0"
    && target.adapter.contractVersion === 2
    && typeof target.identityDigest === "string"
    && /^[a-f0-9]{64}$/.test(target.identityDigest)
    && target.status !== "revoked"
    && target.consent.status === "granted"
    && target.capabilities["sync.write"] === true
    && target.capabilities[action === "rollback" ? "rollback" : "apply"] === true;
}

export function targetInventoryLabels(target: ArchitectureTargetRecord) {
  const provider = target.adapter.kind === "codex-inventory" ? "Codex" : target.adapter.kind === "claude-inventory" ? "Claude" : null;
  if (!provider) return null;
  const scope = target.metadata?.scope === "global" ? "Global inventory" : target.metadata?.scope === "project" ? "Project inventory" : "Inventory scope not reported";
  return { provider, scope, label: `${provider} · ${scope.toLowerCase()}` };
}
