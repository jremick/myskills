import type { ArchitectureTargetRecord } from "../src/api.js";

// Matches the personal descriptor and identity returned by CLI workspace enrollment.
export function workspaceTarget(): ArchitectureTargetRecord {
  return {
    schemaVersion: 1,
    id: "target-1",
    name: "Personal Codex workspace",
    owner: { type: "user", id: "user-1" },
    adapter: { kind: "codex-workspace", version: "1.0.0", contractVersion: 2 },
    architectureId: "architecture-1",
    environmentId: "personal",
    profileId: "default",
    status: "connected",
    consent: { status: "granted", requestedAt: "2026-09-01T00:00:00.000Z", grantedAt: "2026-09-01T00:01:00.000Z" },
    generation: 1,
    identityDigest: "a".repeat(64),
    capabilities: { "inventory.read": true, "health.read": true, "plan.read": true, apply: true, rollback: true, "sync.write": true },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    health: null,
  };
}

export const unsupportedWorkspaceTargets: Array<[string, Partial<ArchitectureTargetRecord>]> = [
  ["read-only", { adapter: { kind: "codex-readonly", version: "1", contractVersion: 1 }, capabilities: { "inventory.read": true } }],
  ["team", { owner: { type: "team", id: "team-1" } }],
  ["organization", { owner: { type: "organization", id: "organization-1" } }],
  ["synthetic companion", { adapter: { kind: "codex-companion", version: "1", contractVersion: 2 } }],
  ["future adapter version", { adapter: { kind: "codex-workspace", version: "2.0.0", contractVersion: 2 } }],
  ["missing identity", { identityDigest: undefined }],
  ["revoked", { status: "revoked" }],
  ["pending consent", { consent: { status: "pending", requestedAt: "2026-09-01T00:00:00.000Z" } }],
  ["read-only capabilities", { capabilities: { "inventory.read": true } }],
];
