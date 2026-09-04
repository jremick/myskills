import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryClient } from "../src/api.js";

test("registry client keeps organization and target management on explicit API routes", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({ body: typeof init?.body === "string" ? init.body : undefined, method: init?.method, url });
    return new Response(JSON.stringify({
      organizations: [],
      organization: { id: "org-1", name: "Acme", status: "active", currentPolicy: null },
      invitations: [],
      members: [],
      revisions: [],
      teams: [],
      member: { id: "member-1" },
      revision: { id: "policy-1" },
      activated: true,
      changed: true,
      target: {
        id: "target-1",
        name: "Personal Codex",
        owner: { type: "user", id: "user-1" },
        adapter: { kind: "codex-readonly", version: "1", contractVersion: 1 },
        architectureId: "architecture-1",
        environmentId: "personal",
        profileId: "profile-1",
        status: "degraded",
        consent: { status: "pending", requestedAt: "2026-08-30T00:00:00.000Z" },
        generation: 1,
        identityDigest: "a".repeat(64),
        capabilities: { "inventory.read": true },
        health: null,
      },
      targets: [],
      observations: [],
      observation: { id: "observation-1" },
      operations: [],
      operation: { id: "operation-1", state: "queued" },
      results: [],
      items: [],
      observedAt: null,
      policy: null,
      replayed: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, "session-token");

  await client.listOrganizations!();
  await client.createOrganization!({ name: "Acme" });
  await client.getOrganization!("org-1");
  await client.listOrganizationMembers!("org-1");
  await client.listOrganizationInvitations!("org-1");
  await client.listOrganizationPendingInvitations!();
  await client.inviteOrganizationMember!({ organizationId: "org-1", email: "member@example.com", role: "member" });
  await client.acceptOrganizationInvitation!("invitation-1");
  await client.updateOrganizationMemberRole!({ organizationId: "org-1", memberId: "member-1", role: "admin" });
  await client.removeOrganizationMember!("org-1", "member-1");
  await client.listOrganizationPolicies!("org-1");
  await client.appendOrganizationPolicy!({ organizationId: "org-1", policy: { schemaVersion: 1 } as never });
  await client.activateOrganizationPolicy!("org-1", "policy-1");
  await client.archiveOrganization!("org-1");
  await client.listOrganizationTeams!("org-1");
  await client.createOrganizationTeam!({ organizationId: "org-1", name: "Quality" });
  await client.adoptTeamToOrganization!("team-1", "org-1");
  await client.listArchitectureTargets!();
  await client.getArchitectureTarget!("target-1");
  await client.registerArchitectureTarget!({
    name: "Personal Codex",
    owner: { type: "user", id: "user-1" },
    architectureId: "architecture-1",
    environmentId: "personal",
    profileId: "profile-1",
    adapter: { kind: "codex-readonly", version: "1", contractVersion: 1 },
    capabilities: { "inventory.read": true },
    credentialReference: "secret-ref",
  });
  await client.setArchitectureTargetConsent!("target-1", "grant");
  await client.listArchitectureTargetObservations!("target-1", 25);
  await client.updateArchitectureTargetHealth!("target-1", { status: "healthy", checkedAt: "2026-08-30T00:00:00.000Z" });
  await client.revokeArchitectureTarget!("target-1");
  await client.listTargetSkillUpdates!("target-1");
  await client.listTargetSkillOperations!("target-1");
  await client.scheduleTargetSkillOperation!("target-1", { action: "update", slug: "release-notes-helper", version: "1.1.0", idempotencyKey: "update-1" });
  await client.cancelTargetSkillOperation!("operation-1");
  await client.getTargetSkillUpgradePolicy!("target-1");
  await client.updateTargetSkillUpgradePolicy!("target-1", { policy: { schemaVersion: 1 } as never, expectedRevisionNumber: 0 });
  await client.scheduleTargetSkillOperationBatch!([{ targetId: "target-1", action: "update", slug: "release-notes-helper", version: "1.1.0", idempotencyKey: "update-2" }]);
  await client.getOrganizationSkillUpgradePolicy!("org-1");
  await client.updateOrganizationSkillUpgradePolicy!("org-1", { policy: { schemaVersion: 1 } as never, expectedRevisionNumber: 0 });

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${new URL(call.url).pathname}`), [
    "GET /v1/organizations",
    "POST /v1/organizations",
    "GET /v1/organizations/org-1",
    "GET /v1/organizations/org-1/members",
    "GET /v1/organizations/org-1/invitations",
    "GET /v1/organizations/invitations",
    "POST /v1/organizations/org-1/invitations",
    "POST /v1/organizations/invitations/invitation-1/accept",
    "PUT /v1/organizations/org-1/members/member-1",
    "DELETE /v1/organizations/org-1/members/member-1",
    "GET /v1/organizations/org-1/policy-revisions",
    "POST /v1/organizations/org-1/policy-revisions",
    "POST /v1/organizations/org-1/policy-revisions/policy-1/actions",
    "POST /v1/organizations/org-1/actions",
    "GET /v1/organizations/org-1/teams",
    "POST /v1/organizations/org-1/teams",
    "PUT /v1/teams/team-1/organization",
    "GET /v1/architecture-targets",
    "GET /v1/architecture-targets/target-1",
    "POST /v1/architecture-targets",
    "POST /v1/architecture-targets/target-1/consent",
    "GET /v1/architecture-targets/target-1/observations",
    "POST /v1/architecture-targets/target-1/health",
    "DELETE /v1/architecture-targets/target-1",
    "GET /v1/architecture-targets/target-1/updates",
    "GET /v1/architecture-targets/target-1/operations",
    "POST /v1/architecture-targets/target-1/operations",
    "POST /v1/target-operations/operation-1/cancel",
    "GET /v1/architecture-targets/target-1/update-policy",
    "PUT /v1/architecture-targets/target-1/update-policy",
    "POST /v1/target-operations/batch",
    "GET /v1/organizations/org-1/update-policy",
    "PUT /v1/organizations/org-1/update-policy",
  ]);
  assert.equal(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/architecture-targets"))?.body?.includes("secret-ref"), true);
});
