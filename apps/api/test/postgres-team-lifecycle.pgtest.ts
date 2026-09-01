import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AppError } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { TeamService } from "../src/teams/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = "11111111-1111-4111-8111-111111111111";
const secondOwnerId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const pendingEmail = "pending@example.com";

const settings = {
  publicVisibilityEnabled: true,
  authenticatedVisibilityEnabled: true,
  teamsEnabled: true,
  teamVisibilityEnabled: true,
  userVisibilityEnabled: true,
} as const;

test("Postgres team lifecycle mutations reject an owner made stale after the service precheck", {
  timeout: 60_000,
  skip: !databaseUrl,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresTeamStore(db);
  const service = new TeamService(store);
  const owner = { id: ownerId, email: "owner@example.com", name: "Owner" };
  const secondOwner = { id: secondOwnerId, email: "second-owner@example.com", name: "Second Owner" };
  const member = { id: memberId, email: "member@example.com", name: "Member" };
  await insertUser(pool, owner);
  await insertUser(pool, secondOwner);
  await insertUser(pool, member);

  for (const operation of ["revoke", "role", "remove"] as const) {
    const team = await service.createTeam({ actor: owner, name: `Postgres ${operation}`, settings });
    const secondOwnerInvitation = await service.inviteMember({
      actor: owner,
      teamId: team.id,
      email: secondOwner.email,
      settings,
    });
    await service.acceptInvitation({ actor: secondOwner, invitationId: secondOwnerInvitation.id, settings });
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
      email: operation === "revoke" ? pendingEmail : member.email,
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
      demoter: secondOwner,
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
        assert.equal((await store.listPendingInvitationsForEmail(pendingEmail)).some((item) => item.id === targetInvitation.id), true);
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

test("Postgres organization-owned team lifecycle mutations recheck parent membership", {
  timeout: 60_000,
  skip: !databaseUrl,
}, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const organizationStore = new PostgresOrganizationStore(db);
  const teamStore = new PostgresTeamStore(db);
  const teamService = new TeamService(teamStore);
  const organizationService = new OrganizationService(organizationStore, teamService);
  const owner = { id: ownerId, email: "parent-owner@example.com", name: "Parent Owner" };
  const secondOwner = { id: secondOwnerId, email: "parent-second-owner@example.com", name: "Parent Second Owner" };
  const member = { id: memberId, email: "parent-member@example.com", name: "Parent Member" };
  await insertUser(pool, owner);
  await insertUser(pool, secondOwner);
  await insertUser(pool, member);

  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Parent Authority Organization",
    slug: "parent-authority-organization",
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
    name: "Parent Authority Team",
  });
  const secondTeamInvitation = await teamService.inviteMember({
    actor: owner,
    teamId: team.id,
    email: secondOwner.email,
    settings,
  });
  await teamService.acceptInvitation({ actor: secondOwner, invitationId: secondTeamInvitation.id, settings });
  await teamService.updateMemberRole({
    actor: owner,
    teamId: team.id,
    memberId: secondOwner.id,
    role: "owner",
    settings,
  });
  const pendingInvitation = await teamService.inviteMember({
    actor: owner,
    teamId: team.id,
    email: pendingEmail,
    settings,
  });
  const teamMemberInvitation = await teamService.inviteMember({
    actor: owner,
    teamId: team.id,
    email: member.email,
    settings,
  });
  await teamService.acceptInvitation({ actor: member, invitationId: teamMemberInvitation.id, settings });

  await organizationService.removeMember({
    actor: secondOwner,
    organizationId: organization.id,
    memberId: owner.id,
  });

  await assert.rejects(
    teamStore.revokeInvitation({ teamId: team.id, invitationId: pendingInvitation.id, actorUserId: owner.id }),
    (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
  );
  await assert.rejects(
    teamStore.updateMemberRole({ teamId: team.id, userId: member.id, role: "owner", actorUserId: owner.id }),
    (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
  );
  await assert.rejects(
    teamStore.removeMember({ teamId: team.id, userId: member.id, actorUserId: owner.id }),
    (error: unknown) => error instanceof AppError && error.code === "TEAM_OWNER_REQUIRED",
  );

  assert.equal((await teamStore.listPendingInvitationsForEmail(pendingEmail)).some((item) => item.id === pendingInvitation.id), true);
  assert.equal((await teamStore.findMembership({ teamId: team.id, userId: member.id }))?.role, "member");
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for team lifecycle tests.");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  return pool;
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  user: { id: string; email: string; name: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, $2, $3, $4, 'active', now())`,
    [user.id, user.email, user.email.toLowerCase(), user.name],
  );
}

function installStaleOwnerDemotion(input: {
  store: PostgresTeamStore;
  service: TeamService;
  teamId: string;
  actor: { id: string; email: string; name: string };
  demoter: { id: string; email: string; name: string };
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
