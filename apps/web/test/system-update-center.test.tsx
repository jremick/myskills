import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { unsupportedWorkspaceTargets, workspaceTarget } from "./workspace-target-fixture.js";
import { SystemUpdateCenter } from "../src/components/update/SystemUpdateCenter.js";
import type { RegistryClient, TargetSkillOperationRecord, TargetSkillUpdates } from "../src/api.js";

afterEach(() => cleanup());

test("update centre reviews exact release notes before queueing and exposes recovery state", async () => {
  const target = workspaceTarget();
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
  await view.findByRole("heading", { name: "Personal Codex workspace" });
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

test("a blocked upgrade keeps intermediate release notes readable without allowing a queue", async () => {
  const updates = sampleUpdates();
  const evaluation = updates.items[0]!.evaluation;
  evaluation.status = "no-compatible-release";
  delete evaluation.candidate;
  evaluation.blockers = ["change-kind-not-allowed"];
  evaluation.includedReleases[0]!.changeKind = "breaking";
  evaluation.includedReleases[0]!.releaseNotes = "Breaking configuration layout.";
  let queued = 0;
  const client = {
    async listArchitectureTargets() { return [workspaceTarget()]; },
    async listTargetSkillUpdates() { return updates; },
    async listTargetSkillOperations() { return []; },
    async scheduleTargetSkillOperation() { queued += 1; },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;

  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByText("The upgrade crosses a release change kind that your policy does not allow.");
  assert.equal((view.getByRole("checkbox", { name: /release-notes-helper/ }) as HTMLInputElement).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Review" }));
  await view.findByRole("heading", { name: "Review blocked update for release-notes-helper" });
  await view.findByText("Breaking configuration layout.");
  await view.findByText("New update workflow.");
  const queue = view.getByRole("button", { name: "Queue exact update" }) as HTMLButtonElement;
  assert.equal(queue.disabled, true);
  fireEvent.click(queue);
  assert.equal(queued, 0);
});

test("an unavailable pin explains the exact version without offering another update", async () => {
  const updates = sampleUpdates();
  updates.policy!.constraints![0]!.policy.pins["release-notes-helper"] = "1.5.0";
  updates.items[0]!.evaluation = { status: "no-compatible-release", installedVersion: "1.0.0", includedReleases: [], blockers: ["pinned-release-unavailable"] };
  const client = {
    async listArchitectureTargets() { return [workspaceTarget()]; },
    async listTargetSkillUpdates() { return updates; },
    async listTargetSkillOperations() { return []; },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;

  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByText("Pinned release 1.5.0 is unavailable. Choose an available version in the upgrade policy.");
  assert.equal((view.getByRole("checkbox", { name: /release-notes-helper/ }) as HTMLInputElement).disabled, true);
  assert.equal(view.queryByRole("button", { name: "Review" }), null);
  assert.equal(view.queryByRole("button", { name: "Queue exact update" }), null);
});

for (const [name, patch] of [...unsupportedWorkspaceTargets, ["non-Codex platform", {}] as const]) {
  test(`${name} preserves review and receipt history but cannot queue updates or rollback`, async () => {
    const target = { ...workspaceTarget(), ...patch };
    const updates = sampleUpdates();
    const operation = sampleOperation();
    if (name === "non-Codex platform") {
      updates.items[0]!.platform = "generic";
      operation.platform = "generic";
    }
    let queued = 0;
    const client = {
      async listArchitectureTargets() { return [target]; },
      async listTargetSkillUpdates() { return updates; },
      async listTargetSkillOperations() { return [operation]; },
      async scheduleTargetSkillOperation() { queued += 1; },
      async scheduleTargetSkillOperationBatch() { queued += 1; },
      async getTargetSkillUpgradePolicy() { return null; },
    } as unknown as RegistryClient;
    const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
    await view.findByRole("heading", { name: target.name });
    const checkbox = view.getByRole("checkbox", { name: /release-notes-helper/ }) as HTMLInputElement;
    assert.equal(checkbox.disabled, true);
    fireEvent.click(checkbox);
    assert.equal(view.queryByRole("button", { name: "Review batch" }), null);
    const rollback = view.getByRole("button", { name: "Rollback" }) as HTMLButtonElement;
    assert.equal(rollback.disabled, true);
    fireEvent.click(rollback);
    fireEvent.click(view.getByRole("button", { name: "Review" }));
    await view.findByText("Security hardening.");
    const queue = view.getByRole("button", { name: "Queue exact update" }) as HTMLButtonElement;
    assert.equal(queue.disabled, true);
    fireEvent.click(queue);
    assert.equal(queued, 0);
    assert.match(view.getByRole("region", { name: `Operation history for ${target.name}` }).textContent ?? "", /succeeded/);
  });
}

test("enrolled personal workspaces can queue a batch and an exact rollback", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    async listArchitectureTargets() { return [workspaceTarget()]; },
    async listTargetSkillUpdates() { return sampleUpdates(); },
    async listTargetSkillOperations() { return [sampleOperation()]; },
    async scheduleTargetSkillOperationBatch(operations: Array<Record<string, unknown>>) { calls.push(...operations); return []; },
    async scheduleTargetSkillOperation(targetId: string, input: Record<string, unknown>) { calls.push({ targetId, ...input }); },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;
  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  fireEvent.click(await view.findByRole("checkbox", { name: /release-notes-helper/ }));
  fireEvent.click(view.getByRole("button", { name: "Review batch" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm batch" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.equal(calls[0]?.action, "update");
  assert.equal(calls[0]?.version, "1.2.0");
  fireEvent.click(view.getByRole("button", { name: "Rollback" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal(calls[1]?.action, "rollback");
  assert.equal(calls[1]?.version, "1.0.0");
});

test("update refreshes coalesce and publish only the requested fresh snapshot", async () => {
  const initial = deferred<ReturnType<typeof workspaceTarget>[]>();
  let lists = 0;
  const fresh = { ...workspaceTarget(), name: "Fresh workspace" };
  const client = {
    async listArchitectureTargets() { lists += 1; return lists === 1 ? initial.promise : [fresh]; },
    async listTargetSkillUpdates() { return sampleUpdates(); },
    async listTargetSkillOperations() { return []; },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;
  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  assert.equal(lists, 1);
  await act(async () => { initial.resolve([workspaceTarget()]); });
  await view.findByRole("heading", { name: fresh.name });
  assert.equal(lists, 2);
  assert.equal(view.queryByRole("heading", { name: "Personal Codex workspace" }), null);
});

test("a queued mutation requests fresh state after an in-flight refresh", async () => {
  const pending = deferred<ReturnType<typeof workspaceTarget>[]>();
  let lists = 0;
  let queued = false;
  const client = {
    async listArchitectureTargets() {
      lists += 1;
      if (lists === 2) return pending.promise;
      return [{ ...workspaceTarget(), name: queued ? "After rollback queue" : "Personal Codex workspace" }];
    },
    async listTargetSkillUpdates() { return sampleUpdates(); },
    async listTargetSkillOperations() { return [sampleOperation()]; },
    async scheduleTargetSkillOperation() { queued = true; },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;
  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByRole("heading", { name: "Personal Codex workspace" });
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  fireEvent.click(view.getByRole("button", { name: "Rollback" }));
  await waitFor(() => assert.equal(queued, true));
  assert.equal(lists, 2);
  await act(async () => { pending.resolve([workspaceTarget()]); });
  await view.findByRole("heading", { name: "After rollback queue" });
  assert.equal(lists, 3);
});

test("poll ticks reuse an in-flight refresh without overlapping or starving it", async () => {
  const pending = deferred<ReturnType<typeof workspaceTarget>[]>();
  let lists = 0;
  let tick: (() => void) | undefined;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  window.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as typeof window.setInterval;
  window.clearInterval = () => undefined;
  try {
    const client = {
      async listArchitectureTargets() { lists += 1; return lists === 1 ? [workspaceTarget()] : pending.promise; },
      async listTargetSkillUpdates() { return sampleUpdates(); },
      async listTargetSkillOperations() { return [{ ...sampleOperation(), state: "queued" }]; },
      async getTargetSkillUpgradePolicy() { return null; },
    } as unknown as RegistryClient;
    const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
    await view.findByRole("heading", { name: "Personal Codex workspace" });
    await waitFor(() => assert.ok(tick));
    await act(async () => { tick!(); tick!(); tick!(); });
    assert.equal(lists, 2);
    await act(async () => { pending.resolve([{ ...workspaceTarget(), name: "Polled workspace" }]); });
    await view.findByRole("heading", { name: "Polled workspace" });
    assert.equal(lists, 2);
    view.unmount();
  } finally {
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
  }
});

test("an old client response cannot replace the current update scope", async () => {
  const oldUpdates = deferred<TargetSkillUpdates>();
  let oldRead = false;
  const oldClient = {
    async listArchitectureTargets() { return [workspaceTarget()]; },
    async listTargetSkillUpdates() { oldRead = true; return oldUpdates.promise; },
    async listTargetSkillOperations() { return []; },
    async getTargetSkillUpgradePolicy() { return null; },
  } as unknown as RegistryClient;
  const nextClient = { ...oldClient,
    async listArchitectureTargets() { return [{ ...workspaceTarget(), name: "Current scope" }]; },
    async listTargetSkillUpdates() { return sampleUpdates(); },
  };
  const view = render(<SystemUpdateCenter client={oldClient} session={{ user: { email: "owner@example.com" } }} />);
  await waitFor(() => assert.equal(oldRead, true));
  view.rerender(<SystemUpdateCenter client={nextClient} session={{ user: { email: "next@example.com" } }} />);
  await view.findByRole("heading", { name: "Current scope" });
  await act(async () => { oldUpdates.resolve(sampleUpdates()); });
  assert.equal(view.queryByRole("heading", { name: "Personal Codex workspace" }), null);
  assert.ok(view.getByRole("heading", { name: "Current scope" }));
});

function sampleOperation(): TargetSkillOperationRecord {
  return {
    schemaVersion: 1, id: "operation-succeeded", targetId: "target-1", targetGeneration: 1,
    action: "update", skillSlug: "release-notes-helper", fromVersion: "1.0.0", toVersion: "1.2.0", platform: "codex",
    artifact: { sha256: "c".repeat(64), byteSize: 120, contentType: "application/json" },
    planDigest: "8".repeat(64), state: "succeeded", fencingToken: 1,
    createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-02T00:01:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("update centre shows both policy revisions and their windows when pins conflict", async () => {
  const updates = sampleUpdates();
  const base = updates.policy!.constraints![0]!.policy;
  const organizationPolicy = { ...base, pins: { "release-notes-helper": "1.1.0" }, mode: "maintenance-window" as const,
    maintenanceWindow: { timeZone: "UTC", daysOfWeek: [3], startMinute: 0, durationMinutes: 60 } };
  const targetPolicy = { ...base, pins: { "release-notes-helper": "1.2.0" }, mode: "maintenance-window" as const,
    maintenanceWindow: { timeZone: "Australia/Melbourne", daysOfWeek: [3], startMinute: 600, durationMinutes: 60 } };
  const revision = (scopeType: "organization" | "target", policy: typeof base, revisionNumber: number) => ({ id: `${scopeType}-${revisionNumber}`, scopeType, scopeId: `${scopeType}-1`, policy, revisionNumber,
    policySha256: "a".repeat(64), reason: "", createdByUserId: "owner-1", createdAt: "2026-09-02T00:00:00.000Z" });
  updates.policy = { policy: targetPolicy, source: "target", revision: revision("target", targetPolicy, 3), constraints: [
    { source: "organization", policy: organizationPolicy, revision: revision("organization", organizationPolicy, 2) },
    { source: "target", policy: targetPolicy, revision: revision("target", targetPolicy, 3) },
  ] };
  updates.items[0]!.evaluation = { status: "no-compatible-release", installedVersion: "1.0.0", includedReleases: [], blockers: ["policy-pin-conflict"] };
  const client = { async listArchitectureTargets() { return [workspaceTarget()]; }, async listTargetSkillUpdates() { return updates; },
    async listTargetSkillOperations() { return []; }, async getTargetSkillUpgradePolicy() { return null; } } as unknown as RegistryClient;
  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByText("Policies: organization r2 + target r3");
  await view.findByText("organization window: Wed 00:00–01:00 (UTC)");
  await view.findByText("target window: Wed 10:00–11:00 (Australia/Melbourne)");
  await view.findByText("Organization and target pins conflict. Update the target pin to match the organization ceiling.");
});

test("the update centre renders legacy policy responses and explains unknown blockers", async () => {
  const updates = sampleUpdates();
  delete updates.policy!.constraints;
  updates.policy!.policy.pins["release-notes-helper"] = "1.5.0";
  updates.items[0]!.evaluation = { status: "no-compatible-release", installedVersion: "1.0.0", includedReleases: [], blockers: ["pinned-release-unavailable"] };
  const unknown = "constructor" as TargetSkillUpdates["items"][number]["evaluation"]["blockers"][number];
  updates.items.push({ slug: "constructor", platform: "codex", evaluation: { status: "no-compatible-release", installedVersion: "1.0.0", includedReleases: [], blockers: ["pinned-release-unavailable", unknown] } });
  const client = { async listArchitectureTargets() { return [workspaceTarget()]; }, async listTargetSkillUpdates() { return updates; },
    async listTargetSkillOperations() { return []; }, async getTargetSkillUpgradePolicy() { return null; } } as unknown as RegistryClient;
  const view = render(<SystemUpdateCenter client={client} session={{ user: { email: "owner@example.com" } }} />);
  await view.findByText("Policies: default");
  await view.findByText("Channel: stable");
  await view.findByText("Pinned release 1.5.0 is unavailable. Choose an available version in the upgrade policy.");
  await view.findByText("The pinned release is unavailable. This update is blocked by a release or policy requirement. Refresh for current details.");
  assert.equal(view.container.textContent?.includes("function Object"), false, "an unpinned constructor slug must not read the prototype");
  assert.equal((view.getByRole("checkbox", { name: /constructor/ }) as HTMLInputElement).disabled, true);
  const details = view.container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  await view.findByText(/Saving creates the first policy/);
});

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
  const policy: NonNullable<TargetSkillUpdates["policy"]>["policy"] = { schemaVersion: 1, mode: "manual", includePrerelease: false, allowedChangeKinds: ["breaking", "feature", "fix", "maintenance", "security"], pins: {} };
  return {
    targetId: "target-1",
    observedAt: "2026-09-02T00:00:00.000Z",
    policy: { policy, source: "default", revision: null, constraints: [{ policy, source: "default", revision: null }] },
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
