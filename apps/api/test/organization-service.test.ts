import assert from "node:assert/strict";
import test from "node:test";
import {
  AppError,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type OrganizationPolicyV1Input,
} from "@myskills-app/core";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";

const owner = { id: "owner-user", email: "Owner@Example.com", name: "Owner" };
const admin = { id: "admin-user", email: "admin@example.com", name: "Admin" };
const member = { id: "member-user", email: "member@example.com", name: "Member" };
const outsider = { id: "outsider-user", email: "outsider@example.com", name: "Outsider" };

function fixture(): { store: MemoryOrganizationStore; service: OrganizationService } {
  const store = new MemoryOrganizationStore({ now: () => new Date("2026-08-30T00:00:00.000Z") });
  for (const user of [owner, admin, member, outsider]) store.addKnownUser(user);
  return { store, service: new OrganizationService(store) };
}

async function createOrganization(service: OrganizationService, policy?: OrganizationPolicyV1Input) {
  return service.createOrganization({
    actor: owner,
    name: "Platform Skills",
    slug: "platform-skills",
    ...(policy === undefined ? {} : { policy }),
  });
}

test("create is one logical operation with an active owner and immutable initial policy revision", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service, {
    sharing: { organizationSkillSharingEnabled: false },
  });

  assert.equal(created.status, "active");
  assert.equal(created.currentPolicyRevisionId, created.currentPolicy?.id);
  assert.equal(created.role, "owner");
  assert.equal(created.currentPolicy?.revisionNumber, 1);
  assert.equal(created.currentPolicy?.policy.sharing.organizationSkillSharingEnabled, false);
  assert.equal(created.currentPolicy?.policySha256, organizationPolicyDigest(created.currentPolicy?.policy));
  assert.deepEqual(await store.listMemberships({ organizationId: created.id }), [
    {
      id: "organization-membership-1",
      organizationId: created.id,
      userId: owner.id,
      email: owner.email.toLowerCase(),
      name: owner.name,
      role: "owner",
      invitedByUserId: null,
      removedAt: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ]);
  const firstRevision = await store.getPolicyRevision({ organizationId: created.id });
  assert.ok(firstRevision);
  assert.notEqual(firstRevision.policy, created.currentPolicy?.policy);
  assert.equal((await store.getPolicyRevision({ organizationId: created.id }))?.policy.sharing.organizationSkillSharingEnabled, false);
});

test("listing and detail fail closed for outsiders, removed members, and archived organizations", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  assert.equal((await service.listOrganizations(outsider)).length, 0);
  assert.equal(await service.getOrganization(outsider, created.id), null);

  const invitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: member.email });
  await service.acceptInvitation({ actor: member, invitationId: invitation.id });
  assert.equal((await service.listOrganizations(member)).length, 1);

  await service.removeMember({ actor: owner, organizationId: created.id, memberId: member.id });
  assert.equal((await service.listOrganizations(member)).length, 0);
  assert.equal(await service.getOrganization(member, created.id), null);

  await service.archiveOrganization({ actor: owner, organizationId: created.id });
  assert.equal((await service.listOrganizations(owner)).length, 0);
  assert.equal(await service.getOrganization(owner, created.id), null);
});

test("owner and admin invitation rules are enforced and acceptance uses normalized email", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  const adminInvitation = await service.inviteMember({
    actor: owner,
    organizationId: created.id,
    email: admin.email,
    role: "admin",
  });
  await service.acceptInvitation({ actor: { ...admin, email: " ADMIN@example.com " }, invitationId: adminInvitation.id });

  await assert.rejects(
    service.inviteMember({ actor: admin, organizationId: created.id, email: "new-owner@example.com", role: "owner" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );

  const memberInvitation = await service.inviteMember({
    actor: admin,
    organizationId: created.id,
    email: "New-Member@example.com",
  });
  assert.equal(memberInvitation.normalizedEmail, "new-member@example.com");
  const accepted = await service.acceptInvitation({
    actor: { id: "new-member-user", email: " NEW-MEMBER@EXAMPLE.COM ", name: "New Member" },
    invitationId: memberInvitation.id,
  });
  assert.equal(accepted.status, "accepted");
  assert.equal((await service.listMembers(owner, created.id)).some((candidate) => candidate.email === "new-member@example.com"), true);
});

test("organization member limits are enforced at acceptance and leave the invitation pending", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service, {
    limits: { membersPerOrganization: 1 },
  });
  const invitation = await service.inviteMember({
    actor: owner,
    organizationId: created.id,
    email: member.email,
  });

  await assert.rejects(
    service.acceptInvitation({ actor: member, invitationId: invitation.id }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_MEMBER_LIMIT_REACHED"
      && error.statusCode === 409,
  );
  assert.equal((await store.findMembership({ organizationId: created.id, userId: member.id })), null);
  assert.equal((await store.listInvitations({ organizationId: created.id }))[0]?.status, "pending");
});

test("organization member limits also block reactivation while preserving the removed membership", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service, {
    limits: { membersPerOrganization: 2 },
  });
  const firstInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: member.email });
  await service.acceptInvitation({ actor: member, invitationId: firstInvitation.id });
  await service.removeMember({ actor: owner, organizationId: created.id, memberId: member.id });
  await service.appendPolicyRevision({
    actor: owner,
    organizationId: created.id,
    policy: { limits: { membersPerOrganization: 1 } },
  });

  const reactivationInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: member.email });
  await assert.rejects(
    service.acceptInvitation({ actor: member, invitationId: reactivationInvitation.id }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_MEMBER_LIMIT_REACHED"
      && error.statusCode === 409,
  );
  assert.equal((await store.findMembership({ organizationId: created.id, userId: member.id, includeRemoved: true }))?.removedAt !== null, true);
  assert.equal((await store.listInvitations({ organizationId: created.id })).find((row) => row.id === reactivationInvitation.id)?.status, "pending");
});

test("member administration preserves the last active owner and revokes access immediately", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  const adminInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: admin.email, role: "admin" });
  await service.acceptInvitation({ actor: admin, invitationId: adminInvitation.id });
  const secondOwnerInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: member.email, role: "owner" });
  await service.acceptInvitation({ actor: member, invitationId: secondOwnerInvitation.id });

  await assert.rejects(
    service.updateMemberRole({ actor: admin, organizationId: created.id, memberId: member.id, role: "member" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );
  const demoted = await service.updateMemberRole({ actor: owner, organizationId: created.id, memberId: owner.id, role: "member" });
  assert.equal(demoted.role, "member");
  await assert.rejects(
    service.removeMember({ actor: member, organizationId: created.id, memberId: member.id }),
    (error: unknown) => error instanceof AppError && error.code === "LAST_ORGANIZATION_OWNER_REQUIRED",
  );

  const removed = await service.removeMember({ actor: member, organizationId: created.id, memberId: owner.id });
  assert.equal(removed.removedAt, "2026-08-30T00:00:00.000Z");
  assert.equal((await service.listMembers(member, created.id)).some((candidate) => candidate.userId === owner.id), false);
  assert.equal(await service.getOrganization(owner, created.id), null);
});

test("store mutation boundaries reject a demoted actor even after a stale authorization read", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service);
  const adminInvitation = await service.inviteMember({
    actor: owner,
    organizationId: created.id,
    email: admin.email,
    role: "admin",
  });
  await service.acceptInvitation({ actor: admin, invitationId: adminInvitation.id });
  const memberInvitation = await service.inviteMember({
    actor: owner,
    organizationId: created.id,
    email: member.email,
  });
  await service.acceptInvitation({ actor: member, invitationId: memberInvitation.id });

  // Model a request that read admin access before another request demoted the
  // actor. Direct store calls must still enforce the current membership.
  await service.updateMemberRole({ actor: owner, organizationId: created.id, memberId: admin.id, role: "member" });
  await assert.rejects(
    store.updateMembershipRole({
      organizationId: created.id,
      userId: member.id,
      role: "admin",
      actorUserId: admin.id,
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_ADMIN_REQUIRED",
  );
  await assert.rejects(
    store.removeMembership({ organizationId: created.id, userId: member.id, actorUserId: admin.id }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_ADMIN_REQUIRED",
  );
  await assert.rejects(
    store.activatePolicyRevision({
      organizationId: created.id,
      revisionId: created.currentPolicy?.id ?? "missing",
      actorUserId: admin.id,
    }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );
  await assert.rejects(
    store.archiveOrganization({ organizationId: created.id, actorUserId: admin.id }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );
  assert.equal((await service.getOrganization(owner, created.id))?.status, "active");
});

test("policy revisions append and activate with duplicate digest idempotency and owner-only access", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  const adminInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: admin.email, role: "admin" });
  await service.acceptInvitation({ actor: admin, invitationId: adminInvitation.id });
  const policy = {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationArchitectureSharingEnabled: false },
  };

  await assert.rejects(
    service.appendPolicyRevision({ actor: admin, organizationId: created.id, policy }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );
  const appended = await service.appendPolicyRevision({ actor: owner, organizationId: created.id, policy, reason: "Disable architecture sharing" });
  assert.equal(appended.created, true);
  assert.equal(appended.activated, true);
  assert.equal(appended.revision.revisionNumber, 2);
  const duplicate = await service.appendPolicyRevision({ actor: owner, organizationId: created.id, policy, reason: "Retry" });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.activated, true);
  assert.equal(duplicate.revision.id, appended.revision.id);
  assert.equal((await service.listPolicies(owner, created.id)).length, 2);
  assert.equal((await service.getOrganization(owner, created.id))?.currentPolicy?.id, appended.revision.id);
});

test("existing policy revisions can be activated without mutating immutable content", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service);
  const initial = created.currentPolicy;
  assert.ok(initial);
  const policy = {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationSkillSharingEnabled: false },
  };
  const appended = await service.appendPolicyRevision({ actor: owner, organizationId: created.id, policy, reason: "Disable skill sharing" });

  const restored = await service.activatePolicyRevision({
    actor: owner,
    organizationId: created.id,
    revisionId: initial.id,
  });
  assert.equal(restored.activated, true);
  assert.equal(restored.changed, true);
  assert.equal(restored.revision.id, initial.id);
  assert.equal((await service.getOrganization(owner, created.id))?.currentPolicy?.id, initial.id);
  assert.deepEqual(await store.getPolicyRevision({ organizationId: created.id, revisionId: initial.id }), initial);

  const idempotent = await service.activatePolicyRevision({
    actor: owner,
    organizationId: created.id,
    revisionId: initial.id,
  });
  assert.equal(idempotent.activated, true);
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.revision.id, initial.id);
  assert.equal((await store.getPolicyRevision({ organizationId: created.id, revisionId: appended.revision.id }))?.policy.sharing.organizationSkillSharingEnabled, false);

  const allowAudit = store.auditEvents().find((event) => event.action === "organization.policy.activate" && event.decision === "allow");
  assert.deepEqual(allowAudit?.details, {
    revisionNumber: initial.revisionNumber,
    policySha256: initial.policySha256,
  });
  assert.equal(JSON.stringify(allowAudit?.details).includes("organizationSkillSharingEnabled"), false);
});

test("policy activation is owner-only, same-organization, and fails closed for inactive organizations", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  const adminInvitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: admin.email, role: "admin" });
  await service.acceptInvitation({ actor: admin, invitationId: adminInvitation.id });

  await assert.rejects(
    service.activatePolicyRevision({ actor: admin, organizationId: created.id, revisionId: created.currentPolicy?.id ?? "missing" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_OWNER_REQUIRED",
  );
  await assert.rejects(
    service.activatePolicyRevision({ actor: owner, organizationId: created.id, revisionId: "organization-policy-revision-999" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_POLICY_REVISION_NOT_FOUND" && error.statusCode === 404,
  );
  await service.archiveOrganization({ actor: owner, organizationId: created.id });
  await assert.rejects(
    service.activatePolicyRevision({ actor: owner, organizationId: created.id, revisionId: created.currentPolicy?.id ?? "missing" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_NOT_FOUND" && error.statusCode === 404,
  );
});

test("cross-boundary mutations return generic not-found and audits redact sensitive values", async () => {
  const { service, store } = fixture();
  const created = await createOrganization(service);
  await assert.rejects(
    service.inviteMember({ actor: outsider, organizationId: created.id, email: "new@example.com" }),
    (error: unknown) => error instanceof AppError
      && error.code === "ORGANIZATION_NOT_FOUND"
      && error.statusCode === 404,
  );
  await store.recordAuditEvent({
    actorUserId: outsider.id,
    action: "organization.test",
    decision: "deny",
    details: { token: "secret-token", password: "secret-password", note: "safe" },
  });
  const audit = store.auditEvents().at(-1);
  assert.deepEqual(audit?.details, { token: "[redacted]", password: "[redacted]", note: "safe" });
  assert.equal(store.auditEvents().some((event) => event.action === "organization.member.invite" && event.decision === "deny"), true);
});

test("team linking requires an explicitly wired team boundary", async () => {
  const { service } = fixture();
  const created = await createOrganization(service);
  await assert.rejects(
    service.createChildTeam({ actor: owner, organizationId: created.id, name: "Platform" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
  );
  await assert.rejects(
    service.adoptStandaloneTeam({ actor: owner, organizationId: created.id, teamId: "team-1" }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_TEAM_BOUNDARY_UNAVAILABLE",
  );
});

test("organization mutations roll back when their required allow audit fails", async () => {
  let failNextAllowAudit = false;
  const store = new MemoryOrganizationStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    beforeCommit: (audit) => {
      if (failNextAllowAudit && audit.decision === "allow") {
        failNextAllowAudit = false;
        throw new Error("simulated organization allow-audit failure");
      }
    },
  });
  for (const user of [owner, admin, member]) store.addKnownUser(user);
  const service = new OrganizationService(store);
  const failNext = async (operation: () => Promise<unknown>): Promise<void> => {
    failNextAllowAudit = true;
    await assert.rejects(operation());
  };

  await failNext(() => createOrganization(service));
  assert.equal((await store.listOrganizations()).length, 0);
  assert.equal(store.auditEvents().at(-1)?.decision, "deny");

  const created = await createOrganization(service);
  await failNext(() => service.inviteMember({ actor: owner, organizationId: created.id, email: member.email }));
  assert.equal((await store.listInvitations({ organizationId: created.id })).length, 0);

  const invitation = await service.inviteMember({ actor: owner, organizationId: created.id, email: member.email });
  await failNext(() => service.acceptInvitation({ actor: member, invitationId: invitation.id }));
  assert.equal(await store.findMembership({ organizationId: created.id, userId: member.id }), null);
  assert.equal((await store.listInvitations({ organizationId: created.id }))[0]?.status, "pending");
  await service.acceptInvitation({ actor: member, invitationId: invitation.id });

  await failNext(() => service.updateMemberRole({ actor: owner, organizationId: created.id, memberId: member.id, role: "admin" }));
  assert.equal((await store.findMembership({ organizationId: created.id, userId: member.id }))?.role, "member");

  await failNext(() => service.removeMember({ actor: owner, organizationId: created.id, memberId: member.id }));
  assert.equal((await store.findMembership({ organizationId: created.id, userId: member.id }))?.removedAt, null);

  const beforeRevision = (await service.getOrganization(owner, created.id))?.currentPolicyRevisionId;
  await failNext(() => service.appendPolicyRevision({
    actor: owner,
    organizationId: created.id,
    policy: { sharing: { organizationSkillSharingEnabled: false } },
  }));
  assert.equal((await service.getOrganization(owner, created.id))?.currentPolicyRevisionId, beforeRevision);

  await failNext(() => service.archiveOrganization({ actor: owner, organizationId: created.id }));
  assert.equal((await service.getOrganization(owner, created.id))?.status, "active");
  for (const action of [
    "organization.create",
    "organization.member.invite",
    "organization.invitation.accept",
    "organization.member.role.update",
    "organization.member.remove",
    "organization.policy.append",
    "organization.archive",
  ]) {
    assert.equal(store.auditEvents().some((event) => event.action === action && event.decision === "deny"), true, action);
  }
});
