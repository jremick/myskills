import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PackageFileViewer } from "../src/components/registry/PackageFileViewer.js";
import { ManagedSkillsDashboard } from "../src/components/registry/ManagedSkillsDashboard.js";
import { SubmissionEvidencePanel } from "../src/components/registry/SubmissionEvidencePanel.js";
import { UpgradePolicyEditor } from "../src/components/update/UpgradePolicyEditor.js";
import type { ArchitectureTargetRecord, RegistryClient, SkillManagementSummary, SkillReleaseSummary, SkillUpgradePolicyRevisionRecord, UserSubmissionDetail } from "../src/api.js";
import type { SkillUpgradePolicyV1 } from "@myskills-app/core";

afterEach(() => cleanup());

test("package inspection is explicit and displays untrusted markup as text", async () => {
  let calls = 0;
  const payload = '<img src="https://example.invalid/tracker" onerror="alert(1)"><script>bad()</script>';
  const view = render(<PackageFileViewer resourceKey="skill:1" loadBundle={async () => { calls++; return { files: [{ path: "SKILL.md", content: payload }, { path: "examples/demo.txt", content: "A useful example" }] }; }} />);
  assert.equal(calls, 0);
  fireEvent.click(view.getByRole("button", { name: "Inspect package files" }));
  await view.findByText(payload);
  assert.equal(calls, 1);
  assert.equal(view.container.querySelector("img, script"), null);
  fireEvent.change(view.getByLabelText("Package file"), { target: { value: "examples/demo.txt" } });
  await view.findByText("A useful example");
});

test("a stale package response cannot replace another selected release", async () => {
  let resolveOld: ((bundle: { files: Array<{ path: string; content: string }> }) => void) | undefined;
  const old = new Promise<{ files: Array<{ path: string; content: string }> }>((resolve) => { resolveOld = resolve; });
  const view = render(<PackageFileViewer resourceKey="old" loadBundle={() => old} />);
  fireEvent.click(view.getByRole("button", { name: "Inspect package files" }));
  view.rerender(<PackageFileViewer resourceKey="new" loadBundle={async () => ({ files: [{ path: "SKILL.md", content: "New release" }] })} />);
  fireEvent.click(view.getByRole("button", { name: "Inspect package files" }));
  await view.findByText("New release");
  resolveOld?.({ files: [{ path: "SKILL.md", content: "Old release" }] });
  await Promise.resolve();
  assert.equal(view.queryByText("Old release"), null);
});

test("managed inventory restores an archived skill and an exact historical release", async () => {
  let skill: SkillManagementSummary = { slug: "archived-helper", title: "Archived helper", summary: "Kept for recovery", lifecycleStatus: "archived", visibility: "private", tags: [], allowedActions: ["restore"] };
  const calls: string[] = [];
  const releases: SkillReleaseSummary[] = [release("2.0.0", "approved", ["unpublish"]), release("1.0.0", "unpublished", ["restore"])];
  const client = {
    async listManagedSkills() { return { skills: [skill], nextCursor: null }; },
    async listSkillReleases() { return releases; },
    async performSkillAction(slug: string, action: string) { calls.push(`${slug}:${action}`); skill = { ...skill, lifecycleStatus: "approved", allowedActions: ["archive"] }; return skill; },
    async performReleaseAction(slug: string, version: string, action: string) { calls.push(`${slug}:${version}:${action}`); return releases[1]; },
  } as unknown as RegistryClient;
  const view = render(<ManagedSkillsDashboard client={client} mfaVerified />);
  fireEvent.click(await view.findByRole("button", { name: "Restore skill" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
  await waitFor(() => assert.equal(calls[0], "archived-helper:restore"));
  await view.findByRole("button", { name: "Archive skill" });
  await waitFor(() => assert.equal((view.getByRole("button", { name: "Archive skill" }) as HTMLButtonElement).disabled, false));
  fireEvent.change(view.getByLabelText("Managed release version"), { target: { value: "1.0.0" } });
  fireEvent.click(view.getByRole("button", { name: "Restore 1.0.0" }));
  fireEvent.click(view.getByRole("button", { name: "Confirm restore" }));
  await waitFor(() => assert.equal(calls[1], "archived-helper:1.0.0:restore"));
});

test("author feedback shows recorded reasons and scan findings before choosing a correction", async () => {
  let corrected = false;
  const detail = {
    id: "submission-1", slug: "helper", version: "1.0.0", reviewStatus: "changes-requested",
    changeRequestReason: "Add an example for an empty input.",
    correction: { requiresNewVersion: true, canSubmitNewVersion: true },
    reviewHistory: [{ action: "request-changes", reason: "Add an example for an empty input.", createdAt: "2026-09-01T00:00:00Z" }],
    scanRuns: [{ id: "scan-1", status: "warning", createdAt: "2026-09-01T00:00:00Z", startedAt: null, completedAt: null, findings: [{ category: "review", severity: "warning", path: "SKILL.md", message: "Check the external command." }] }],
  } as UserSubmissionDetail;
  const client = { async getUserSubmissionDetail() { return detail; } } as unknown as RegistryClient;
  const view = render(<SubmissionEvidencePanel client={client} submissionId="submission-1" mode="author" onCorrect={() => { corrected = true; }} />);
  await view.findByText("Check the external command.");
  assert.equal(view.getAllByText("Add an example for an empty input.").length, 2);
  fireEvent.click(view.getByRole("button", { name: "Choose corrected package" }));
  assert.equal(corrected, true);
});

test("organization policy editing loads its own revision and preserves its pins", async () => {
  const targetPolicy: SkillUpgradePolicyV1 = { schemaVersion: 1, mode: "manual", includePrerelease: true, allowedChangeKinds: ["feature"], pins: { "target-only": "2.0.0" } };
  const organizationPolicy: SkillUpgradePolicyV1 = { schemaVersion: 1, mode: "maintenance-window", includePrerelease: false, allowedChangeKinds: ["security", "fix"], pins: { "org-required": "1.0.0" }, maintenanceWindow: { timeZone: "UTC", daysOfWeek: [0], startMinute: 300, durationMinutes: 60 } };
  const saves: Array<{ policy: SkillUpgradePolicyV1; expectedRevisionNumber: number }> = [];
  const client = {
    async getTargetSkillUpgradePolicy() { return policyRevision("target", 3, targetPolicy); },
    async getOrganizationSkillUpgradePolicy() { return policyRevision("organization", 7, organizationPolicy); },
    async updateOrganizationSkillUpgradePolicy(_id: string, input: { policy: SkillUpgradePolicyV1; expectedRevisionNumber: number }) { saves.push(input); return { created: true, revision: policyRevision("organization", 8, input.policy) }; },
  } as unknown as RegistryClient;
  const target = { id: "target-1", owner: { type: "organization", id: "org-1" } } as ArchitectureTargetRecord;
  const view = render(<UpgradePolicyEditor client={client} target={target} resolved={{ policy: targetPolicy, source: "target", revision: policyRevision("target", 3, targetPolicy) }} onSaved={() => undefined} />);
  const details = view.container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new window.Event("toggle"));
  await view.findByText(/target-only 2.0.0/);
  fireEvent.change(view.getByLabelText("Upgrade policy scope"), { target: { value: "organization" } });
  await view.findByText(/org-required 1.0.0/);
  assert.equal((view.getByRole("checkbox") as HTMLInputElement).checked, false);
  assert.equal(view.queryByText(/target-only 2.0.0/), null);
  assert.match(view.getByText(/Window: days/).textContent ?? "", /05:00/);
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(view.getByRole("button", { name: "Save immutable policy revision" }));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.equal(saves[0]!.expectedRevisionNumber, 7);
  assert.deepEqual(saves[0]!.policy.pins, organizationPolicy.pins);
  assert.deepEqual(saves[0]!.policy.allowedChangeKinds, organizationPolicy.allowedChangeKinds);
  assert.deepEqual(saves[0]!.policy.maintenanceWindow, organizationPolicy.maintenanceWindow);
});

function release(version: string, lifecycleStatus: string, allowedActions: SkillReleaseSummary["allowedActions"]): SkillReleaseSummary {
  return { id: version, slug: "archived-helper", version, lifecycleStatus, reviewStatus: "approved", securityStatus: "passed", publishedAt: null, platforms: [], findingCount: 0, allowedActions };
}
function policyRevision(scopeType: "target" | "organization", revisionNumber: number, policy: SkillUpgradePolicyV1): SkillUpgradePolicyRevisionRecord {
  return { id: `${scopeType}-${revisionNumber}`, scopeType, scopeId: scopeType === "target" ? "target-1" : "org-1", revisionNumber, policy, policySha256: "a".repeat(64), reason: "Initial policy", createdByUserId: "user-1", createdAt: "2026-09-01T00:00:00Z" };
}
