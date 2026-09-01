import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ArchitectureSpecV1, ArchitectureTargetHealth, ArchitectureTargetObservation, OrganizationPolicyV1 } from "@myskills-app/core";
import { OrganizationsDashboard } from "../src/components/organization/OrganizationsDashboard.js";
import { ArchitectureTargetsDashboard } from "../src/components/target/ArchitectureTargetsDashboard.js";
import type {
  ArchitectureTargetRecord,
  ArchitectureDetail,
  OrganizationDetail,
  OrganizationInvitationRecord,
  OrganizationListItem,
  OrganizationMembershipRecord,
  OrganizationPolicyRevisionRecord,
  RegistryClient,
  ArchitectureSummary,
  TeamRecord,
} from "../src/api.js";

afterEach(() => cleanup());

test("organization management loads a scoped detail and keeps member/policy actions server-backed", async () => {
  const organization = sampleOrganization();
  const members = [sampleMember()];
  const policies = [
    samplePolicyRevision(),
    { ...samplePolicyRevision(), id: "policy-2", revisionNumber: 2, reason: "Prepared policy" },
  ];
  const calls: string[] = [];
  const client = {
    async listOrganizations() { return [organization]; },
    async listOrganizationPendingInvitations() { return []; },
    async getOrganization() { return organization; },
    async listOrganizationMembers() { return members; },
    async listOrganizationInvitations() { return []; },
    async listOrganizationPolicies() { return policies; },
    async listOrganizationTeams() { return []; },
    async inviteOrganizationMember(input: { email: string }) { calls.push(`invite:${input.email}`); return sampleInvitation(); },
    async updateOrganizationMemberRole(input: { memberId: string; role: string }) { calls.push(`role:${input.memberId}:${input.role}`); return members[0]!; },
    async appendOrganizationPolicy() { calls.push("append-policy"); return { revision: policies[0]!, created: true, activated: true }; },
    async activateOrganizationPolicy() { calls.push("activate-policy"); return { revision: policies[0]!, activated: true as const, changed: true }; },
  } as unknown as RegistryClient;

  const view = render(<OrganizationsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);

  await view.findByRole("heading", { name: "Acme Skills" });
  await view.findByText(/owner@example\.com/);
  assert.equal(view.getByText("Organization is a sharing boundary. Personal, work, and team labels do not grant access.").textContent?.includes("labels do not grant access"), true);

  fireEvent.input(view.getByLabelText("Organization member email"), { target: { value: "member@example.com" } });
  fireEvent.click(view.getByRole("button", { name: "Invite" }));
  await waitFor(() => assert.deepEqual(calls, ["invite:member@example.com"]));

  fireEvent.change(view.getByLabelText("Role for member@example.com"), { target: { value: "admin" } });
  assert.equal(calls.includes("role:user-2:admin"), false);
  fireEvent.click(await view.findByRole("button", { name: "Confirm role change" }));
  await waitFor(() => assert.equal(calls.includes("role:user-2:admin"), true));

  fireEvent.click(view.getByRole("button", { name: "Review append and activate" }));
  fireEvent.click(await view.findByRole("button", { name: "Confirm append and activate" }));
  await waitFor(() => assert.equal(calls.includes("append-policy"), true));
  await view.findByText("Policy revision 1 was appended and activated.");
  fireEvent.click(view.getByRole("button", { name: "Activate" }));
  fireEvent.click(await view.findByRole("button", { name: "Confirm activate" }));
  await waitFor(() => assert.equal(calls.includes("activate-policy"), true));
});

test("organization list refresh invalidates a stale detail response", async () => {
  const pending: Array<(detail: OrganizationDetail) => void> = [];
  const organization = sampleOrganization();
  const client = {
    async listOrganizations() { return [organization]; },
    async listOrganizationPendingInvitations() { return []; },
    async getOrganization() { return new Promise<OrganizationDetail>((resolve) => pending.push(resolve)); },
    async listOrganizationMembers() { return []; },
    async listOrganizationInvitations() { return []; },
    async listOrganizationPolicies() { return []; },
    async listOrganizationTeams() { return []; },
  } as unknown as RegistryClient;

  const view = render(<OrganizationsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await waitFor(() => assert.equal(pending.length, 1));
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => assert.equal(pending.length, 2));
  pending[0]!(organization);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.queryByRole("heading", { name: "Acme Skills" }), null);
  pending[1]!(organization);
  await view.findByRole("heading", { name: "Acme Skills" });
});

test("members can create child teams when the current organization policy allows it", async () => {
  const organization: OrganizationDetail & OrganizationListItem = {
    ...sampleOrganization(),
    role: "member",
    currentPolicy: {
      ...samplePolicyRevision(),
      policy: { ...samplePolicy(), teams: { ...samplePolicy().teams, membersCanCreateTeams: true } },
    },
  };
  const created: Array<{ organizationId: string; name: string }> = [];
  const client = {
    async listOrganizations() { return [organization]; },
    async listOrganizationPendingInvitations() { return []; },
    async getOrganization() { return organization; },
    async listOrganizationMembers() { return [sampleMember()]; },
    async listOrganizationInvitations() { return []; },
    async listOrganizationPolicies() { return [organization.currentPolicy!]; },
    async listOrganizationTeams() { return []; },
    async createOrganizationTeam(input: { organizationId: string; name: string }) {
      created.push(input);
      return sampleTeam();
    },
  } as unknown as RegistryClient;

  const view = render(<OrganizationsDashboard client={client} session={{ user: { id: "user-2", email: "member@example.com" } }} />);
  await view.findByRole("heading", { name: "Acme Skills" });
  await view.findByText("Your current organization policy allows members to create child teams.");
  fireEvent.input(view.getByLabelText("Child team name"), { target: { value: "Reviews" } });
  fireEvent.click(view.getByRole("button", { name: "Create child team" }));
  await waitFor(() => assert.deepEqual(created, [{ organizationId: "org-1", name: "Reviews" }]));
});

test("target registry guides the owner and current architecture context and never renders a credential reference", async () => {
  let target = sampleTarget();
  const registered: Array<Record<string, unknown>> = [];
  const consent: string[] = [];
  const health: ArchitectureTargetHealth[] = [];
  const client = {
    async listArchitectureTargets() { return [target]; },
    async getArchitectureTarget() { return target; },
    async listArchitectureTargetObservations() { return [sampleObservation(target.id)]; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return sampleArchitectureDetail(); },
    async listOrganizations() { return [sampleOrganization()]; },
    async registerArchitectureTarget(input: Record<string, unknown>) {
      registered.push(input);
      target = { ...target, name: String(input.name) };
      return target;
    },
    async setArchitectureTargetConsent(_targetId: string, decision: "grant" | "deny") { consent.push(decision); target = { ...target, consent: { ...target.consent, status: decision === "grant" ? "granted" : "denied" } }; return target; },
    async updateArchitectureTargetHealth(_targetId: string, nextHealth: ArchitectureTargetHealth) { health.push(nextHealth); target = { ...target, health: nextHealth }; return target; },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await view.findByRole("heading", { name: "Personal Codex" });
  await view.findByText("1 skills · 0 config findings · prompt detected: no");
  assert.equal(document.body.textContent?.includes("secret-store-token"), false);

  fireEvent.input(view.getByLabelText("Target name"), { target: { value: "Work Codex" } });
  const architecture = await view.findByLabelText("Target architecture");
  await waitFor(() => assert.equal((architecture as HTMLSelectElement).value, "architecture-1"));
  assert.equal(view.getByText(/architecture owner's server-authorized ownership boundary/).textContent?.includes("server-authorized"), true);
  const profile = await view.findByLabelText("Target profile");
  const environment = await view.findByLabelText("Target logical environment");
  await waitFor(() => assert.equal((profile as HTMLSelectElement).value, "personal"));
  await waitFor(() => assert.equal((environment as HTMLSelectElement).value, "personal-laptop"));
  assert.equal(view.container.querySelector("details")?.open, false);
  fireEvent.click(view.getByText("Advanced target settings"));
  fireEvent.input(view.getByLabelText("Credential reference"), { target: { value: "secret-store-token" } });
  fireEvent.click(view.getByRole("button", { name: "Register target" }));
  await waitFor(() => assert.equal(registered.length, 1));
  assert.deepEqual(registered[0]?.owner, { type: "user", id: "user-1" });
  assert.equal(registered[0]?.architectureId, "architecture-1");
  assert.equal(registered[0]?.environmentId, "personal-laptop");
  assert.equal(registered[0]?.profileId, "personal");
  assert.equal(registered[0]?.credentialReference, "secret-store-token");
  assert.equal(document.body.textContent?.includes("secret-store-token"), false);

  fireEvent.click(view.getByRole("button", { name: "Grant consent" }));
  await waitFor(() => assert.deepEqual(consent, ["grant"]));
  await view.findByRole("button", { name: "Update health" });
  fireEvent.change(view.getByLabelText("Target health status"), { target: { value: "healthy" } });
  fireEvent.click(view.getByRole("button", { name: "Update health" }));
  await waitFor(() => assert.equal(health[0]?.status, "healthy"));
});

test("target registration prefers the selected user's personal context regardless of response order", async () => {
  const registered: Array<Record<string, unknown>> = [];
  const detail = sampleReorderedUserArchitectureDetail();
  const client = {
    async listArchitectureTargets() { return []; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return detail; },
    async registerArchitectureTarget(input: Record<string, unknown>) {
      registered.push(input);
      return sampleTarget();
    },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await view.findByText("No connected targets");
  await waitFor(() => assert.equal((view.getByLabelText("Target profile") as HTMLSelectElement).value, "personal"));
  await waitFor(() => assert.equal((view.getByLabelText("Target logical environment") as HTMLSelectElement).value, "personal-laptop"));
  assert.equal(view.getByText(/User-owned targets prefer a matching user profile and personal environment/).textContent?.includes("explicit selections remain authoritative"), true);
  const summary = view.getByRole("region", { name: "Binding and consent summary" });
  assert.equal(within(summary).getByText("Personal", { exact: true }).textContent, "Personal");
  assert.equal(within(summary).getByText("Personal laptop", { exact: true }).textContent, "Personal laptop");

  fireEvent.input(view.getByLabelText("Target name"), { target: { value: "Deterministic personal target" } });
  fireEvent.click(view.getByRole("button", { name: "Register target" }));
  await waitFor(() => assert.equal(registered.length, 1));
  assert.equal(registered[0]?.profileId, "personal");
  assert.equal(registered[0]?.environmentId, "personal-laptop");
});

test("target registration prefers a team profile and team environment for a team owner", async () => {
  const registered: Array<Record<string, unknown>> = [];
  const detail = sampleReorderedTeamArchitectureDetail();
  const client = {
    async listArchitectureTargets() { return []; },
    async listArchitectures() { return [sampleTeamArchitectureSummary()]; },
    async getArchitecture() { return detail; },
    async registerArchitectureTarget(input: Record<string, unknown>) {
      registered.push(input);
      return sampleTarget();
    },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await view.findByText("No connected targets");
  await waitFor(() => assert.equal((view.getByLabelText("Authorized target owner") as HTMLSelectElement).value, "team:team-1"));
  await waitFor(() => assert.equal((view.getByLabelText("Target profile") as HTMLSelectElement).value, "team"));
  await waitFor(() => assert.equal((view.getByLabelText("Target logical environment") as HTMLSelectElement).value, "team-runtime"));
  const summary = view.getByRole("region", { name: "Binding and consent summary" });
  assert.equal(within(summary).getByText("Team", { exact: true }).textContent, "Team");
  assert.equal(within(summary).getByText("Team runtime", { exact: true }).textContent, "Team runtime");

  fireEvent.input(view.getByLabelText("Target name"), { target: { value: "Deterministic team target" } });
  fireEvent.click(view.getByRole("button", { name: "Register target" }));
  await waitFor(() => assert.equal(registered.length, 1));
  assert.deepEqual(registered[0]?.owner, { type: "team", id: "team-1" });
  assert.equal(registered[0]?.profileId, "team");
  assert.equal(registered[0]?.environmentId, "team-runtime");
});

test("target registration uses stable name and ID fallback when the preferred context is unavailable", async () => {
  const registered: Array<Record<string, unknown>> = [];
  const detail = sampleNoMatchArchitectureDetail();
  const client = {
    async listArchitectureTargets() { return []; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return detail; },
    async registerArchitectureTarget(input: Record<string, unknown>) {
      registered.push(input);
      return sampleTarget();
    },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await view.findByText("No connected targets");
  await waitFor(() => assert.equal((view.getByLabelText("Target profile") as HTMLSelectElement).value, "fallback-profile"));
  await waitFor(() => assert.equal((view.getByLabelText("Target logical environment") as HTMLSelectElement).value, "a-work"));
  const summary = view.getByRole("region", { name: "Binding and consent summary" });
  assert.equal(within(summary).getByText("Fallback", { exact: true }).textContent, "Fallback");
  assert.equal(within(summary).getByText("A work", { exact: true }).textContent, "A work");

  fireEvent.input(view.getByLabelText("Target name"), { target: { value: "Stable fallback target" } });
  fireEvent.click(view.getByRole("button", { name: "Register target" }));
  await waitFor(() => assert.equal(registered.length, 1));
  assert.equal(registered[0]?.profileId, "fallback-profile");
  assert.equal(registered[0]?.environmentId, "a-work");
});

test("reselecting the active target refreshes detail and exposes selected state", async () => {
  let detailReads = 0;
  const client = {
    async listArchitectureTargets() { return [sampleTarget()]; },
    async getArchitectureTarget() { detailReads += 1; return sampleTarget(); },
    async listArchitectureTargetObservations() { return []; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return sampleArchitectureDetail(); },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await view.findByRole("heading", { name: "Personal Codex" });
  await waitFor(() => assert.equal(detailReads, 1));
  const row = within(view.getByRole("list")).getByRole("button", { name: /Personal Codex/ });
  assert.equal(row.getAttribute("aria-pressed"), "true");
  fireEvent.click(row);
  await waitFor(() => assert.equal(detailReads, 2));
  assert.equal(row.getAttribute("aria-pressed"), "true");
});

test("a stale detail response cannot repopulate the panel after list refresh", async () => {
  const pending: Array<(target: ArchitectureTargetRecord) => void> = [];
  const target = sampleTarget();
  const client = {
    async listArchitectureTargets() { return [target]; },
    async getArchitectureTarget() { return new Promise<ArchitectureTargetRecord>((resolve) => pending.push(resolve)); },
    async listArchitectureTargetObservations() { return []; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return sampleArchitectureDetail(); },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  await waitFor(() => assert.equal(pending.length, 1));
  fireEvent.click(view.getByRole("button", { name: "Refresh" }));
  await waitFor(() => assert.equal(pending.length, 2));
  pending[0]!(target);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.queryByRole("heading", { name: "Personal Codex" }), null);
  pending[1]!(target);
  await view.findByRole("heading", { name: "Personal Codex" });
});

test("target detail failures render a retry state instead of the empty detail state", async () => {
  const target = sampleTarget();
  const detailError = new Error("target detail unavailable");
  let detailReads = 0;
  const client = {
    async listArchitectureTargets() { return [target]; },
    async getArchitectureTarget() {
      detailReads += 1;
      if (detailReads === 1) throw detailError;
      return target;
    },
    async listArchitectureTargetObservations() { return []; },
    async listArchitectures() { return [sampleArchitectureSummary()]; },
    async getArchitecture() { return sampleArchitectureDetail(); },
  } as unknown as RegistryClient;

  const view = render(<ArchitectureTargetsDashboard client={client} session={{ user: { id: "user-1", email: "owner@example.com" } }} />);
  const alert = await view.findByRole("alert");
  assert.equal(alert.textContent?.includes("Connected-environment data is not available."), true);
  assert.equal(alert.textContent?.includes("Retry"), true);
  assert.equal(view.queryByRole("heading", { name: "Select a connected target" }), null);

  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await view.findByRole("heading", { name: "Personal Codex" });
  assert.equal(detailReads, 2);
});

function sampleOrganization(): OrganizationDetail & OrganizationListItem {
  return {
    id: "org-1",
    name: "Acme Skills",
    slug: "acme-skills",
    status: "active",
    currentPolicyRevisionId: "policy-1",
    createdByUserId: "user-1",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    role: "owner",
    currentPolicy: samplePolicyRevision(),
  };
}

function sampleMember(): OrganizationMembershipRecord {
  return {
    id: "membership-1",
    organizationId: "org-1",
    userId: "user-2",
    email: "member@example.com",
    name: "Member User",
    role: "member",
    invitedByUserId: "user-1",
    removedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function sampleInvitation(): OrganizationInvitationRecord {
  return {
    id: "invitation-1",
    organizationId: "org-1",
    organizationName: "Acme Skills",
    email: "member@example.com",
    normalizedEmail: "member@example.com",
    role: "member",
    status: "pending",
    invitedByUserId: "user-1",
    acceptedByUserId: null,
    acceptedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function sampleTeam(): TeamRecord {
  return {
    id: "team-1",
    name: "Reviews",
    slug: "reviews",
    organizationId: "org-1",
    role: "member",
    members: [],
    invitations: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function samplePolicy(): OrganizationPolicyV1 {
  return {
    schemaVersion: 1,
    sharing: {
      organizationSkillSharingEnabled: true,
      organizationArchitectureSharingEnabled: true,
      membersCanShareOwnedSkillsToOrganization: false,
      teamOwnersCanShareArchitecturesToParentOrganization: false,
    },
    teams: {
      membersCanCreateTeams: false,
      requireOrganizationMembershipForTeamMembers: true,
      allowStandaloneTeamAdoption: true,
    },
    limits: {
      teamsPerOrganization: 100,
      membersPerOrganization: 1000,
      organizationGrantsPerSkill: 25,
      organizationGrantsPerArchitecture: 25,
    },
  };
}

function samplePolicyRevision(): OrganizationPolicyRevisionRecord {
  return {
    id: "policy-1",
    organizationId: "org-1",
    revisionNumber: 1,
    policy: samplePolicy(),
    policySha256: "a".repeat(64),
    reason: "Initial policy",
    createdByUserId: "user-1",
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function sampleArchitectureSummary(): ArchitectureSummary {
  return {
    id: "architecture-1",
    name: "Personal skills",
    description: "Personal architecture",
    patternId: "multi-level-router",
    owner: { type: "user", id: "user-1" },
    ownerType: "user",
    ownerId: "user-1",
    ownerUserId: "user-1",
    ownerTeamId: null,
    accessPolicyVersion: 1,
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
    revisionCount: 1,
    latestRevision: {
      id: "revision-1",
      architectureId: "architecture-1",
      revisionNumber: 1,
      message: "Personal profile",
      patternId: "multi-level-router",
      createdAt: "2026-08-30T00:00:00.000Z",
      nodeCount: 1,
      skillCount: 1,
      status: "published",
    },
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function sampleArchitectureDetail(): ArchitectureDetail {
  const summary = sampleArchitectureSummary();
  const spec: ArchitectureSpecV1 = {
    schemaVersion: 1,
    id: summary.id,
    name: summary.name,
    description: summary.description,
    pattern: { id: "multi-level-router", version: 1 },
    skills: [{ id: "release-notes", slug: "release-notes-helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" }],
    nodes: [
      { id: "root", kind: "router", label: "Personal router" },
      { id: "domain", kind: "router", label: "Personal domain" },
      { id: "release-notes", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-notes" },
    ],
    edges: [
      { from: "root", to: "domain", kind: "contains" },
      { from: "domain", to: "release-notes", kind: "routes" },
    ],
    entryNodeIds: ["root"],
    profiles: [{
      id: "personal",
      name: "Personal",
      subject: { type: "user", id: "user-1" },
      defaultExposure: "disabled",
      bindings: [
        { nodeId: "root", enabled: true, runtimeExposure: "router" },
        { nodeId: "domain", enabled: true, runtimeExposure: "router" },
        { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
      ],
    }],
    environments: [{ id: "personal-laptop", name: "Personal laptop", kind: "personal", profileId: "personal" }],
  };
  return {
    ...summary,
    revisions: [summary.latestRevision!],
    latestRevision: {
      ...summary.latestRevision!,
      spec,
      createdByUserId: "user-1",
      message: "Personal profile",
    },
  };
}

function sampleReorderedUserArchitectureDetail(): ArchitectureDetail {
  const detail = sampleArchitectureDetail();
  const spec = detail.latestRevision!.spec;
  const personalProfile = spec.profiles[0]!;
  const personalEnvironment = spec.environments[0]!;
  return {
    ...detail,
    latestRevision: {
      ...detail.latestRevision!,
      spec: {
        ...spec,
        profiles: [
          { ...personalProfile, id: "work", name: "Work", subject: { type: "user", id: "user-1" } },
          personalProfile,
        ],
        environments: [
          { ...personalEnvironment, id: "codex-work", name: "Codex work", kind: "work", profileId: "work" },
          personalEnvironment,
        ],
      },
    },
  };
}

function sampleTeamArchitectureSummary(): ArchitectureSummary {
  const summary = sampleArchitectureSummary();
  const owner = { type: "team" as const, id: "team-1" };
  return {
    ...summary,
    owner,
    ownerType: "team",
    ownerId: owner.id,
    ownerUserId: null,
    ownerTeamId: owner.id,
    access: {
      ...summary.access!,
      owner,
      ownerType: "team",
      ownerId: owner.id,
      role: "owner",
      canCreate: true,
      canManage: true,
    },
  };
}

function sampleReorderedTeamArchitectureDetail(): ArchitectureDetail {
  const detail = sampleArchitectureDetail();
  const spec = detail.latestRevision!.spec;
  const personalProfile = spec.profiles[0]!;
  const personalEnvironment = spec.environments[0]!;
  const teamProfile = { ...personalProfile, id: "team", name: "Team", subject: { type: "team" as const, id: "team-1" } };
  return {
    ...sampleTeamArchitectureSummary(),
    revisions: [detail.latestRevision!],
    latestRevision: {
      ...detail.latestRevision!,
      spec: {
        ...spec,
        profiles: [personalProfile, teamProfile],
        environments: [
          personalEnvironment,
          { ...personalEnvironment, id: "team-runtime", name: "Team runtime", kind: "team", profileId: "team" },
        ],
      },
    },
  };
}

function sampleNoMatchArchitectureDetail(): ArchitectureDetail {
  const detail = sampleArchitectureDetail();
  const spec = detail.latestRevision!.spec;
  return {
    ...detail,
    latestRevision: {
      ...detail.latestRevision!,
      spec: {
        ...spec,
        profiles: [{ ...spec.profiles[0]!, id: "fallback-profile", name: "Fallback", subject: { type: "team", id: "other-team" } }],
        environments: [
          { ...spec.environments[0]!, id: "z-work", name: "Z work", kind: "work", profileId: "fallback-profile" },
          { ...spec.environments[0]!, id: "a-work", name: "A work", kind: "work", profileId: "fallback-profile" },
        ],
      },
    },
  };
}

function sampleTarget(): ArchitectureTargetRecord {
  return {
    schemaVersion: 1,
    id: "target-1",
    name: "Personal Codex",
    owner: { type: "user", id: "user-1" },
    adapter: { kind: "codex-readonly", version: "1", contractVersion: 1 },
    architectureId: "architecture-1",
    environmentId: "personal-laptop",
    profileId: "personal",
    status: "connected",
    consent: { status: "pending", requestedAt: "2026-08-30T00:00:00.000Z" },
    generation: 1,
    identityDigest: "b".repeat(64),
    capabilities: { "inventory.read": true, "health.read": true, "plan.read": true },
    metadata: { label: "personal" },
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    health: { status: "degraded", checkedAt: "2026-08-30T00:00:00.000Z" },
  };
}

function sampleObservation(targetId: string): ArchitectureTargetObservation {
  return {
    schemaVersion: 1,
    id: "observation-1",
    targetId,
    targetGeneration: 1,
    adapterDigest: "c".repeat(64),
    capabilitiesDigest: "d".repeat(64),
    observedAt: "2026-08-30T00:00:00.000Z",
    skills: [{ slug: "release-notes-helper" }],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
    observedDigest: "e".repeat(64),
  };
}
