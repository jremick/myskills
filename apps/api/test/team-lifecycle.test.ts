import assert from "node:assert/strict";
import test from "node:test";
import type { SharingSettings } from "@myskills-app/core";
import { AppError } from "@myskills-app/core";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

const settings: SharingSettings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
};

test("team owners can revoke invitations while members are denied and revoked invites cannot be accepted", async () => {
  const { service, store, owner, member } = fixture();
  const team = await service.createTeam({ actor: owner, name: "Platform", settings });
  const invitation = await service.inviteMember({
    actor: owner,
    teamId: team.id,
    email: member.email,
    settings,
  });

  await assert.rejects(
    service.revokeInvitation({
      actor: member,
      teamId: team.id,
      invitationId: invitation.id,
      settings,
    }),
    (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
  );
  assert.equal((await store.listPendingInvitationsForEmail(member.email)).length, 1);

  const revoked = await service.revokeInvitation({
    actor: owner,
    teamId: team.id,
    invitationId: invitation.id,
    settings,
  });
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(await store.listPendingInvitationsForEmail(member.email), []);

  await assert.rejects(
    service.acceptInvitation({ actor: member, invitationId: invitation.id, settings }),
    (error: unknown) => error instanceof AppError && error.code === "TEAM_INVITATION_NOT_FOUND",
  );

  await store.recordAuditEvent({
    actorUserId: owner.id,
    action: "team.test",
    decision: "deny",
    resourceId: team.id,
    details: {
      password: "do-not-store",
      token: "do-not-store",
      note: "safe audit detail",
    },
  });
  const audit = store.auditEvents().at(-1);
  assert.deepEqual(audit?.details, {
    password: "[redacted]",
    token: "[redacted]",
    note: "safe audit detail",
  });
  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.invitation.revoke" &&
    event.decision === "allow" &&
    event.details.invitationId === invitation.id
  )), true);
  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.invitation.revoke" &&
    event.decision === "deny" &&
    event.details.reason === "team_owner_required"
  )), true);
});

test("team member role changes and removals preserve the final owner", async () => {
  const { service, store, owner, member, secondMember } = fixture();
  const team = await service.createTeam({ actor: owner, name: "Platform", settings });
  for (const invitee of [member, secondMember]) {
    const invitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: invitee.email,
      settings,
    });
    await service.acceptInvitation({ actor: invitee, invitationId: invitation.id, settings });
  }

  const promoted = await service.updateMemberRole({
    actor: owner,
    teamId: team.id,
    memberId: secondMember.id,
    role: "owner",
    settings,
  });
  assert.equal(promoted.role, "owner");

  const demoted = await service.updateMemberRole({
    actor: owner,
    teamId: team.id,
    memberId: owner.id,
    role: "member",
    settings,
  });
  assert.equal(demoted.role, "member");

  await assert.rejects(
    service.updateMemberRole({
      actor: secondMember,
      teamId: team.id,
      memberId: secondMember.id,
      role: "member",
      settings,
    }),
    (error: unknown) => error instanceof AppError && error.code === "LAST_OWNER_REQUIRED",
  );

  const removed = await service.removeMember({
    actor: secondMember,
    teamId: team.id,
    memberId: owner.id,
    settings,
  });
  assert.equal(removed.id, owner.id);
  assert.equal(removed.role, "member");
  assert.deepEqual(await store.listTeamsForUser(owner.id), []);

  await assert.rejects(
    service.removeMember({
      actor: secondMember,
      teamId: team.id,
      memberId: secondMember.id,
      settings,
    }),
    (error: unknown) => error instanceof AppError && error.code === "LAST_OWNER_REQUIRED",
  );
  assert.equal((await store.listTeamsForUser(secondMember.id))[0]?.role, "owner");

  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.member.role.update" &&
    event.decision === "allow" &&
    event.details.roleAfter === "owner"
  )), true);
  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.member.role.update" &&
    event.decision === "deny" &&
    event.details.reason === "last_owner_required"
  )), true);
  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.member.remove" &&
    event.decision === "allow" &&
    event.details.memberId === owner.id
  )), true);
  assert.equal(store.auditEvents().some((event) => (
    event.action === "team.member.remove" &&
    event.decision === "deny" &&
    event.details.reason === "last_owner_required"
  )), true);
});

test("team member roles accept only owner and member", async () => {
  const { service, owner } = fixture();
  const team = await service.createTeam({ actor: owner, name: "Platform", settings });

  await assert.rejects(
    service.updateMemberRole({
      actor: owner,
      teamId: team.id,
      memberId: owner.id,
      role: "admin" as never,
      settings,
    }),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_TEAM_MEMBER_ROLE",
  );
});

test("memory team lifecycle mutations reject an owner made stale after the service precheck", async () => {
  for (const operation of ["revoke", "role", "remove"] as const) {
    const { service, store, owner, member, secondMember } = fixture();
    const team = await service.createTeam({ actor: owner, name: `Platform ${operation}`, settings });
    const secondOwnerInvitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: secondMember.email,
      settings,
    });
    await service.acceptInvitation({ actor: secondMember, invitationId: secondOwnerInvitation.id, settings });
    await service.updateMemberRole({
      actor: owner,
      teamId: team.id,
      memberId: secondMember.id,
      role: "owner",
      settings,
    });

    const targetInvitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: member.email,
      settings,
    });
    if (operation !== "revoke") {
      await service.acceptInvitation({ actor: member, invitationId: targetInvitation.id, settings });
    }

    const restoreFindMembership = installStaleOwnerDemotion({
      store,
      service,
      teamId: team.id,
      actor: owner,
      demoter: secondMember,
    });
    try {
      if (operation === "revoke") {
        await assert.rejects(
          service.revokeInvitation({
            actor: owner,
            teamId: team.id,
            invitationId: targetInvitation.id,
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await store.listPendingInvitationsForEmail(member.email)).some((item) => item.id === targetInvitation.id), true);
      } else if (operation === "role") {
        await assert.rejects(
          service.updateMemberRole({
            actor: owner,
            teamId: team.id,
            memberId: member.id,
            role: "owner",
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await store.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");
      } else {
        await assert.rejects(
          service.removeMember({
            actor: owner,
            teamId: team.id,
            memberId: member.id,
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await store.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");
      }
    } finally {
      restoreFindMembership();
    }
  }
});

test("memory organization-owned team mutations recheck parent membership after the service precheck", async () => {
  for (const operation of ["revoke", "role", "remove"] as const) {
    const organizationStore = new MemoryOrganizationStore();
    const teamStore = new MemoryTeamStore({ organizationStore });
    const organizationService = new OrganizationService(organizationStore, new TeamService(teamStore));
    const service = new TeamService(teamStore);
    const owner = { id: "owner-user", email: "owner@example.com", name: "Owner" };
    const secondOwner = { id: "second-owner-user", email: "second-owner@example.com", name: "Second Owner" };
    const member = { id: "member-user", email: "member@example.com", name: "Member" };
    for (const user of [owner, secondOwner, member]) {
      organizationStore.addKnownUser(user);
      teamStore.addKnownUser(user);
    }

    const organization = await organizationService.createOrganization({
      actor: owner,
      name: `Team Authority ${operation}`,
      slug: `team-authority-${operation}`,
    });
    const secondOwnerInvitation = await organizationService.inviteMember({
      actor: owner,
      organizationId: organization.id,
      email: secondOwner.email,
      role: "owner",
    });
    await organizationService.acceptInvitation({ actor: secondOwner, invitationId: secondOwnerInvitation.id });
    const memberInvitation = await organizationService.inviteMember({
      actor: owner,
      organizationId: organization.id,
      email: member.email,
    });
    await organizationService.acceptInvitation({ actor: member, invitationId: memberInvitation.id });

    const team = await organizationService.createChildTeam({
      actor: owner,
      organizationId: organization.id,
      name: `Team ${operation}`,
    });
    const secondTeamInvitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: secondOwner.email,
      settings,
    });
    await service.acceptInvitation({ actor: secondOwner, invitationId: secondTeamInvitation.id, settings });
    await service.updateMemberRole({
      actor: owner,
      teamId: team.id,
      memberId: secondOwner.id,
      role: "owner",
      settings,
    });
    const targetInvitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: member.email,
      settings,
    });
    if (operation !== "revoke") {
      await service.acceptInvitation({ actor: member, invitationId: targetInvitation.id, settings });
    }

    const restoreFindMembership = installStaleOrganizationMembershipRemoval({
      store: teamStore,
      organizationService,
      organizationId: organization.id,
      teamId: team.id,
      actor: owner,
      remover: secondOwner,
    });
    try {
      if (operation === "revoke") {
        await assert.rejects(
          service.revokeInvitation({
            actor: owner,
            teamId: team.id,
            invitationId: targetInvitation.id,
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await teamStore.listPendingInvitationsForEmail(member.email)).some((item) => item.id === targetInvitation.id), true);
      } else if (operation === "role") {
        await assert.rejects(
          service.updateMemberRole({
            actor: owner,
            teamId: team.id,
            memberId: member.id,
            role: "owner",
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await teamStore.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");
      } else {
        await assert.rejects(
          service.removeMember({
            actor: owner,
            teamId: team.id,
            memberId: member.id,
            settings,
          }),
          (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
        );
        assert.equal((await teamStore.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");
      }
    } finally {
      restoreFindMembership();
    }
  }
});

function fixture(): {
  service: TeamService;
  store: MemoryTeamStore;
  owner: { id: string; email: string };
  member: { id: string; email: string };
  secondMember: { id: string; email: string };
} {
  const store = new MemoryTeamStore();
  const owner = { id: "owner-user", email: "owner@example.com" };
  const member = { id: "member-user", email: "member@example.com" };
  const secondMember = { id: "second-member-user", email: "second@example.com" };
  store.addKnownUser({ ...owner, name: "Owner" });
  store.addKnownUser({ ...member, name: "Member" });
  store.addKnownUser({ ...secondMember, name: "Second Member" });
  return { service: new TeamService(store), store, owner, member, secondMember };
}

test("team mutations roll back when their required allow audit fails", async () => {
  let failNextAllowAudit = false;
  const store = new MemoryTeamStore({
    beforeCommit: (audit) => {
      if (failNextAllowAudit && audit.decision === "allow") {
        failNextAllowAudit = false;
        throw new Error("simulated team allow-audit failure");
      }
    },
  });
  const owner = { id: "audit-owner", email: "audit-owner@example.com" };
  const member = { id: "audit-member", email: "audit-member@example.com" };
  store.addKnownUser(owner);
  store.addKnownUser(member);
  const service = new TeamService(store);
  const failNext = async (operation: () => Promise<unknown>): Promise<void> => {
    failNextAllowAudit = true;
    await assert.rejects(operation());
  };

  await failNext(() => service.createTeam({ actor: owner, name: "Audit Team", settings }));
  assert.equal((await store.listTeamsForUser(owner.id)).length, 0);

  const team = await service.createTeam({ actor: owner, name: "Audit Team", settings });
  await failNext(() => service.inviteMember({ actor: owner, teamId: team.id, email: member.email, settings }));
  assert.equal((await service.listDashboard(owner)).invitations.length, 0);

  const invitation = await service.inviteMember({ actor: owner, teamId: team.id, email: member.email, settings });
  await failNext(() => service.acceptInvitation({ actor: member, invitationId: invitation.id, settings }));
  assert.equal(await store.findMembership({ teamId: team.id, userId: member.id }), null);
  assert.equal((await service.listDashboard(member)).invitations.some((item) => item.id === invitation.id), true);
  await service.acceptInvitation({ actor: member, invitationId: invitation.id, settings });

  await failNext(() => service.updateMemberRole({
    actor: owner,
    teamId: team.id,
    memberId: member.id,
    role: "owner",
    settings,
  }));
  assert.equal((await store.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");

  await failNext(() => service.removeMember({ actor: owner, teamId: team.id, memberId: member.id, settings }));
  assert.equal((await store.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");

  const revokeInvitation = await service.inviteMember({ actor: owner, teamId: team.id, email: "pending-audit@example.com", settings });
  await failNext(() => service.revokeInvitation({
    actor: owner,
    teamId: team.id,
    invitationId: revokeInvitation.id,
    settings,
  }));
  assert.equal((await service.listDashboard({ id: "pending-audit-user", email: "pending-audit@example.com" })).invitations.some((item) => item.id === revokeInvitation.id), true);
  assert.equal(store.auditEvents().filter((event) => event.decision === "deny").length >= 6, true);
});

function installStaleOwnerDemotion(input: {
  store: MemoryTeamStore;
  service: TeamService;
  teamId: string;
  actor: { id: string; email: string };
  demoter: { id: string; email: string };
}): () => void {
  const originalFindMembership = input.store.findMembership.bind(input.store);
  let demoted = false;
  input.store.findMembership = async (membershipInput) => {
    const result = await originalFindMembership(membershipInput);
    if (!demoted
      && membershipInput.teamId === input.teamId
      && membershipInput.userId === input.actor.id
      && result?.role === "owner") {
      demoted = true;
      await input.service.updateMemberRole({
        actor: input.demoter,
        teamId: input.teamId,
        memberId: input.actor.id,
        role: "member",
        settings,
      });
    }
    return result;
  };
  return () => {
    input.store.findMembership = originalFindMembership;
  };
}

function installStaleOrganizationMembershipRemoval(input: {
  store: MemoryTeamStore;
  organizationService: OrganizationService;
  organizationId: string;
  teamId: string;
  actor: { id: string; email: string };
  remover: { id: string; email: string; name: string };
}): () => void {
  const originalFindMembership = input.store.findMembership.bind(input.store);
  let removed = false;
  input.store.findMembership = async (membershipInput) => {
    const result = await originalFindMembership(membershipInput);
    if (!removed
      && membershipInput.teamId === input.teamId
      && membershipInput.userId === input.actor.id
      && result?.role === "owner") {
      removed = true;
      await input.organizationService.removeMember({
        actor: input.remover,
        organizationId: input.organizationId,
        memberId: input.actor.id,
      });
    }
    return result;
  };
  return () => {
    input.store.findMembership = originalFindMembership;
  };
}
