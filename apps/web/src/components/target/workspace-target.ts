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
