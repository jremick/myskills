import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createFlatArchitecture } from "@myskills-app/core";
import { ArchitectureOrganizationGrantsCard } from "../src/components/architecture/ArchitectureOrganizationGrantsCard.js";
import { ArchitecturePatternMigrationCard } from "../src/components/architecture/ArchitecturePatternMigrationCard.js";
import { RevisionHistoryPanel } from "../src/components/architecture/ArchitectureDashboardHistoryPanel.js";
import type {
  ArchitectureDetail,
  ArchitectureOrganizationGrantsResult,
  ArchitecturePattern,
  ArchitecturePatternMigrationCreateResult,
  ArchitecturePatternMigrationPreviewResult,
  OrganizationListItem,
  RegistryClient,
} from "../src/api.js";

afterEach(() => cleanup());

test("organization-only history exposes summaries without requesting restricted revision specs", () => {
  const detail = architectureDetail();
  const current = detail.latestRevision!;
  const older = { ...current, id: "revision-older", revisionNumber: 0, message: "Older" };
  const sharedDetail: ArchitectureDetail = {
    ...detail,
    currentRevisionId: current.id,
    latestRevision: null,
    revisions: [older],
  };
  const view = render(
    <RevisionHistoryPanel
      detail={sharedDetail}
      selectedRevisionId={null}
      selectedRevision={null}
      state="idle"
      message={null}
      readOnly
      revisionDetailsAvailable={false}
      onSelect={async () => { throw new Error("restricted revision should not be requested"); }}
      onUseAsDraft={() => { throw new Error("restricted revision should not seed a draft"); }}
    />,
  );

  assert.match(view.getByTestId("architecture-history-panel").textContent ?? "", /full revision content is restricted/);
  assert.equal((view.getByRole("button", { name: /Revision 1/ }) as HTMLButtonElement).disabled, true);
});

test("organization sharing lists only visible organizations and supports complete save and revoke", async () => {
  let grants: ArchitectureOrganizationGrantsResult = {
    architectureId: "architecture-1",
    currentRevisionId: "revision-1",
    grants: [],
    organizationIds: ["org-1"],
  };
  const saves: Array<{ expectedCurrentRevisionId: string | null; organizationIds: string[] }> = [];
  const organizations = [organization("org-1", "Acme"), organization("org-2", "Workgroup")];
  const client = {
    async listOrganizations() { return organizations; },
    async listArchitectureOrganizationGrants() { return grants; },
    async replaceArchitectureOrganizationGrants(_architectureId: string, input: { expectedCurrentRevisionId: string | null; organizationIds: string[] }) {
      saves.push(input);
      grants = { ...grants, organizationIds: input.organizationIds.slice(), changed: true };
      return grants;
    },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureOrganizationGrantsCard architectureId="architecture-1" currentRevisionId="revision-1" client={client} />);
  await view.findByRole("checkbox", { name: "Share with Acme" });
  assert.equal(view.queryByRole("checkbox", { name: /org-3/i }), null);
  assert.equal((view.getByRole("button", { name: "Save organization access" }) as HTMLButtonElement).disabled, true);

  fireEvent.click(view.getByRole("checkbox", { name: "Share with Workgroup" }));
  fireEvent.click(view.getByRole("button", { name: "Save organization access" }));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.deepEqual(saves[0], { expectedCurrentRevisionId: "revision-1", organizationIds: ["org-1", "org-2"] });

  fireEvent.click(view.getByRole("button", { name: "Revoke all" }));
  assert.equal(saves.length, 1);
  await view.findByRole("button", { name: "Confirm revoke all" });
  fireEvent.click(view.getByRole("button", { name: "Confirm revoke all" }));
  await waitFor(() => assert.equal(saves.length, 2));
  assert.deepEqual(saves[1], { expectedCurrentRevisionId: "revision-1", organizationIds: [] });
  await view.findByText("Organization access revoked for every organization.");
});

test("organization sharing blocks partial changes when a current grant is not visible", async () => {
  const client = {
    async listOrganizations() { return [organization("org-1", "Acme")]; },
    async listArchitectureOrganizationGrants() {
      return { architectureId: "architecture-1", currentRevisionId: "revision-1", grants: [], organizationIds: ["org-1", "hidden-org"] };
    },
    async replaceArchitectureOrganizationGrants() {
      throw new Error("should not save a partial set");
    },
  } as unknown as RegistryClient;
  const view = render(<ArchitectureOrganizationGrantsCard architectureId="architecture-1" currentRevisionId="revision-1" client={client} />);
  await view.findByText(/Some existing grants are not visible/);
  assert.equal((view.getByRole("button", { name: "Save organization access" }) as HTMLButtonElement).disabled, true);
  assert.equal((view.getByRole("button", { name: "Revoke all" }) as HTMLButtonElement).disabled, false);
});

test("organization sharing announces save failures and retries the same bounded request", async () => {
  let attempts = 0;
  const client = {
    async listOrganizations() { return [organization("org-1", "Acme")]; },
    async listArchitectureOrganizationGrants() { return { architectureId: "architecture-1", currentRevisionId: "revision-1", grants: [], organizationIds: [] }; },
    async replaceArchitectureOrganizationGrants(_architectureId: string, input: { expectedCurrentRevisionId: string | null; organizationIds: string[] }) {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary sharing failure");
      return { architectureId: "architecture-1", currentRevisionId: input.expectedCurrentRevisionId, grants: [], organizationIds: input.organizationIds };
    },
  } as unknown as RegistryClient;
  const view = render(<ArchitectureOrganizationGrantsCard architectureId="architecture-1" currentRevisionId="revision-1" client={client} />);
  await view.findByRole("checkbox", { name: "Share with Acme" });
  fireEvent.click(view.getByRole("checkbox", { name: "Share with Acme" }));
  fireEvent.click(view.getByRole("button", { name: "Save organization access" }));
  await view.findByRole("alert");
  assert.equal(attempts, 1);
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(attempts, 2));
  await view.findByText("Organization access saved.");
});

test("pattern migration previews a bounded diff and creates with stable intent only", async () => {
  const preview = migrationPreview();
  const previewInputs: Array<Record<string, unknown>> = [];
  const createInputs: Array<Record<string, unknown>> = [];
  const created: ArchitecturePatternMigrationCreateResult = { ...preview, created: true, replayed: false };
  const client = {
    async previewArchitecturePatternMigration(_architectureId: string, input: Record<string, unknown>) {
      previewInputs.push(input);
      return preview;
    },
    async createArchitecturePatternMigration(_architectureId: string, input: Record<string, unknown>) {
      createInputs.push(input);
      return created;
    },
  } as unknown as RegistryClient;
  const patterns: ArchitecturePattern[] = [
    { id: "flat", name: "Flat library", description: "Flat", status: "available" },
    { id: "multi-level-router", name: "Multi-level router", description: "Nested", supportsNestedRouters: true, status: "available" },
  ];
  const view = render(
    <ArchitecturePatternMigrationCard
      architectureId="architecture-1"
      architectureName="Review assistant"
      currentPatternId="flat"
      currentRevisionId="revision-1"
      detail={architectureDetail()}
      patterns={patterns}
      client={client}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Preview migration" }));
  await view.findByText("Migration preview ready. The source architecture is unchanged.");
  await view.findByText("Bounded topology and semantic diff");
  fireEvent.input(view.getByLabelText("Derived architecture name"), { target: { value: "Nested review assistant" } });
  fireEvent.input(view.getByLabelText("Derived architecture description"), { target: { value: "Nested shell" } });
  fireEvent.input(view.getByLabelText("Derived architecture revision message"), { target: { value: "Try nested routing" } });
  fireEvent.click(view.getByRole("button", { name: "Review create" }));
  await view.findByRole("button", { name: "Confirm create derived shell" });
  fireEvent.click(view.getByRole("button", { name: "Confirm create derived shell" }));
  await waitFor(() => assert.equal(createInputs.length, 1));

  assert.equal(previewInputs[0]?.expectedCurrentRevisionId, "revision-1");
  assert.equal(previewInputs[0]?.targetPatternId, "multi-level-router");
  assert.equal("spec" in previewInputs[0]!, false);
  assert.equal("organizationId" in previewInputs[0]!, false);
  assert.equal(createInputs[0]?.expectedCurrentRevisionId, "revision-1");
  assert.equal(createInputs[0]?.targetPatternId, "multi-level-router");
  assert.equal(typeof createInputs[0]?.idempotencyKey, "string");
  assert.equal(createInputs[0]?.name, "Nested review assistant");
  assert.equal("spec" in createInputs[0]!, false);
  assert.equal("organizationId" in createInputs[0]!, false);
  await view.findByText("Derived shell created. The source architecture was not changed.");
});

test("pattern migration sends bounded router group controls instead of raw mapping JSON", async () => {
  const preview = migrationPreview();
  const previewInputs: Array<Record<string, unknown>> = [];
  const client = {
    async previewArchitecturePatternMigration(_architectureId: string, input: Record<string, unknown>) {
      previewInputs.push(input);
      return preview;
    },
  } as unknown as RegistryClient;
  const patterns: ArchitecturePattern[] = [
    { id: "flat", name: "Flat library", description: "Flat", status: "available" },
    { id: "multi-level-router", name: "Multi-level router", description: "Nested", supportsNestedRouters: true, status: "available" },
  ];
  const view = render(
    <ArchitecturePatternMigrationCard
      architectureId="architecture-1"
      architectureName="Review assistant"
      currentPatternId="flat"
      currentRevisionId="revision-1"
      detail={architectureDetail()}
      patterns={patterns}
      client={client}
    />,
  );

  const addGroupButton = view.getByRole("button", { name: /Add router group/ });
  fireEvent.click(addGroupButton);
  const groupLabel = view.container.querySelector<HTMLInputElement>("#router-group-1-label");
  assert.ok(groupLabel);
  fireEvent.input(groupLabel, { target: { value: "Reviews" } });
  fireEvent.click(view.getByRole("checkbox", { name: /Review helper/ }));
  fireEvent.click(view.getByRole("button", { name: "Preview migration" }));
  await waitFor(() => assert.equal(previewInputs.length, 1));

  assert.deepEqual(previewInputs[0]?.mapping, {
    routerGroups: [{ id: "router-group-1", label: "Reviews", leafNodeIds: ["leaf-skill-1"] }],
  });
  assert.equal("mappingText" in previewInputs[0]!, false);
  assert.equal("spec" in previewInputs[0]!, false);
});

test("pattern migration announces preview loading and retries a failed request", async () => {
  let attempts = 0;
  const client = {
    async previewArchitecturePatternMigration() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary preview failure");
      return migrationPreview();
    },
  } as unknown as RegistryClient;
  const patterns: ArchitecturePattern[] = [
    { id: "flat", name: "Flat library", description: "Flat", status: "available" },
    { id: "multi-level-router", name: "Multi-level router", description: "Nested", supportsNestedRouters: true, status: "available" },
  ];
  const view = render(
    <ArchitecturePatternMigrationCard
      architectureId="architecture-1"
      architectureName="Review assistant"
      currentPatternId="flat"
      currentRevisionId="revision-1"
      detail={architectureDetail()}
      patterns={patterns}
      client={client}
    />,
  );

  fireEvent.click(view.getByRole("button", { name: "Preview migration" }));
  await view.findByText("Loading migration preview…");
  await view.findByRole("alert");
  fireEvent.click(view.getByRole("button", { name: "Retry preview" }));
  await waitFor(() => assert.equal(attempts, 2));
  await view.findByText("Migration preview ready. The source architecture is unchanged.");
});

function organization(id: string, name: string): OrganizationListItem {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    status: "active",
    currentPolicyRevisionId: "policy-1",
    createdByUserId: "user-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    role: "owner",
  };
}

function architectureDetail(): ArchitectureDetail {
  const spec = createFlatArchitecture({
    id: "architecture-1",
    name: "Review assistant",
    skills: [{ id: "skill-1", slug: "review-helper", title: "Review helper", version: "1.0.0", digest: "a".repeat(64) }],
  });
  const revision = {
    id: "revision-1",
    architectureId: "architecture-1",
    revisionNumber: 1,
    revision: 1,
    patternId: "flat" as const,
    message: "Initial",
    createdByUserId: "user-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    spec,
  };
  return {
    id: "architecture-1",
    name: "Review assistant",
    description: "Review work",
    patternId: "flat",
    owner: { type: "user", id: "user-1" },
    ownerType: "user",
    ownerId: "user-1",
    access: {
      owner: { type: "user", id: "user-1" },
      ownerType: "user",
      ownerId: "user-1",
      policyVersion: 1,
      accessPolicyVersion: 1,
      role: "owner",
      canList: true,
      canRead: true,
      canPreview: true,
      canCreate: true,
      canAppend: true,
      canManage: true,
      reasons: ["owner"],
    },
    currentRevisionId: "revision-1",
    latestRevision: revision,
    revisions: [revision],
    revisionCount: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
    status: "active",
  };
}

function migrationPreview(): ArchitecturePatternMigrationPreviewResult {
  return {
    sourceArchitectureId: "architecture-1",
    sourceRevisionId: "revision-1",
    expectedCurrentRevisionId: "revision-1",
    migration: {
      schemaVersion: 1,
      mode: "derive-shell",
      source: { architectureId: "architecture-1", patternId: "flat", revisionDigest: "a".repeat(64) },
      mappingStatus: "fallback",
      diff: {
        preservedSkillRefIds: ["skill-1"],
        preservedLeafNodeIds: ["leaf-1"],
        addedRouterNodeIds: ["root-router"],
        droppedRouterNodeIds: [],
        addedEdgeCount: 0,
        removedEdgeCount: 0,
        rewrittenBindingCount: 1,
      },
      issues: [],
      migrationDigest: "b".repeat(64),
      diffDigest: "c".repeat(64),
      target: { patternId: "multi-level-router", spec: {} as never, revisionDigest: "d".repeat(64) },
    },
  };
}
