import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SystemUpdateCenter } from "../src/components/update/SystemUpdateCenter.js";
import type { ArchitectureTargetRecord, RegistryClient, TargetSkillOperationRecord, TargetSkillUpdates } from "../src/api.js";

afterEach(() => cleanup());

test("update centre reviews exact release notes before queueing and exposes recovery state", async () => {
  const target = sampleTarget();
  const calls: Array<Record<string, unknown>> = [];
  let operations: TargetSkillOperationRecord[] = [{
    schemaVersion: 1,
    id: "operation-failed",
    targetId: target.id,
    targetGeneration: 1,
    action: "update",
    skillSlug: "other-skill",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    platform: "codex",
    artifact: { sha256: "9".repeat(64), byteSize: 10, contentType: "application/json" },
    planDigest: "8".repeat(64),
    state: "failed",
    fencingToken: 1,
    result: { status: "failed", code: "operation.readback_failed", recordedAt: "2026-09-02T00:01:00.000Z" },
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:01:00.000Z",
  }];
  const client = {
    async listArchitectureTargets() { return [target]; },
    async listTargetSkillUpdates() { return sampleUpdates(); },
    async listTargetSkillOperations() { return operations; },
    async scheduleTargetSkillOperation(_targetId: string, input: Record<string, unknown>) {
      calls.push(input);
      const operation = { ...operations[0]!, id: "operation-queued", skillSlug: String(input.slug), toVersion: String(input.version), state: "queued" as const, result: undefined };
      operations = [operation];
      return { operation, replayed: false };
    },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;

  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByRole("heading", { name: "Personal companion" });
  await view.findByText(/operation\.readback_failed/);
  fireEvent.click(view.getByRole("button", { name: "Review" }));
  await view.findByRole("heading", { name: "Review release-notes-helper 1.0.0 → 1.2.0" });
  assert.match(view.getByText("Security hardening.").textContent ?? "", /Security/);
  assert.match(view.getByText("New update workflow.").textContent ?? "", /workflow/);
  fireEvent.click(view.getByRole("button", { name: "Queue exact update" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0]?.version, "1.2.0");
  assert.equal(calls[0]?.platform, "codex");
});

function sampleTarget(): ArchitectureTargetRecord {
  return {
    schemaVersion: 1,
    id: "target-1",
    name: "Personal companion",
    owner: { type: "user", id: "user-1" },
    adapter: { kind: "codex-companion", version: "1", contractVersion: 2 },
    architectureId: "architecture-1",
    environmentId: "personal",
    profileId: "default",
    status: "connected",
    consent: { status: "granted", requestedAt: "2026-09-01T00:00:00.000Z", grantedAt: "2026-09-01T00:01:00.000Z" },
    generation: 1,
    identityDigest: "a".repeat(64),
    capabilities: { "inventory.read": true, apply: true, rollback: true, "sync.write": true },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    health: null,
  };
}

function sampleUpdates(): TargetSkillUpdates {
  const base = {
    lifecycleStatus: "approved" as const,
    publishedAt: "2026-09-01T00:00:00.000Z",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" as const }],
    changeKind: "fix" as const,
    requiresUserAction: false,
    compatibility: {},
  };
  const first = { ...base, version: "1.1.0", releaseNotes: "Security hardening.", artifact: { sha256: "b".repeat(64), byteSize: 100, contentType: "application/json" } };
  const candidate = { ...base, version: "1.2.0", changeKind: "feature" as const, releaseNotes: "New update workflow.", artifact: { sha256: "c".repeat(64), byteSize: 120, contentType: "application/json" } };
  return {
    targetId: "target-1",
    observedAt: "2026-09-02T00:00:00.000Z",
    policy: { policy: { schemaVersion: 1, mode: "manual", includePrerelease: false, allowedChangeKinds: ["breaking", "feature", "fix", "maintenance", "security"], pins: {} }, source: "default", revision: null },
    items: [{
      slug: "release-notes-helper",
      platform: "codex",
      evaluation: {
        status: "update-available",
        installedVersion: "1.0.0",
        candidate,
        includedReleases: [first, candidate],
        blockers: [],
      },
    }],
  };
}
