import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { OrganizationService } from "../src/organizations/service.js";
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { TeamService } from "../src/teams/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const outsiderId = "33333333-3333-4333-8333-333333333333";

test("Postgres team boundary creates children, preserves standalone teams, and adopts only fully scoped teams", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "owner@example.com", "Owner");
  await insertUser(pool, memberId, "member@example.com", "Member");
  await insertUser(pool, outsiderId, "outsider@example.com", "Outsider");

  const db = createDb(pool);
  const organizationStore = new PostgresOrganizationStore(db);
  const teamStore = new PostgresTeamStore(db);
  const organizationService = new OrganizationService(organizationStore, new TeamService(teamStore));
  const teamService = new TeamService(teamStore);
  const owner = { id: ownerId, email: "owner@example.com", name: "Owner" };
  const member = { id: memberId, email: "member@example.com", name: "Member" };

  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Platform Organization",
    slug: "platform-organization",
  });
  const standalone = await teamService.createTeam({
    actor: owner,
    name: "Standalone Team",
    settings: teamSettings(),
  });
  assert.equal(standalone.organizationId, null);

  const child = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "Child Team",
  });
  assert.equal(child.organizationId, organization.id);
  assert.equal((await teamStore.listTeamsForUser(ownerId)).find((team) => team.id === child.id)?.organizationId, organization.id);

  const memberInvitation = await teamService.inviteMember({
    actor: owner,
    teamId: standalone.id,
    email: member.email,
    settings: teamSettings(),
  });
  await teamService.acceptInvitation({ actor: member, invitationId: memberInvitation.id, settings: teamSettings() });

  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ORGANIZATION_TEAM_MEMBERSHIP_REQUIRED",
  );
  assert.equal((await teamStore.listTeamsForUser(ownerId)).find((team) => team.id === standalone.id)?.organizationId, null);

  const organizationInvitation = await organizationService.inviteMember({
    actor: owner,
    organizationId: organization.id,
    email: member.email,
  });
  await organizationService.acceptInvitation({ actor: member, invitationId: organizationInvitation.id });

  const adopted = await organizationService.adoptStandaloneTeam({
    actor: owner,
    organizationId: organization.id,
    teamId: standalone.id,
  });
  assert.equal(adopted.organizationId, organization.id);
  assert.equal((await teamStore.listTeamsForUser(memberId)).find((team) => team.id === standalone.id)?.organizationId, organization.id);

  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TEAM_ALREADY_PARENTED",
  );
});

test("Postgres parented team acceptance requires active organization membership and keeps the invitation pending", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "owner-accept@example.com", "Owner");
  await insertUser(pool, outsiderId, "outsider-accept@example.com", "Outsider");

  const db = createDb(pool);
  const organizationStore = new PostgresOrganizationStore(db);
  const teamStore = new PostgresTeamStore(db);
  const teamService = new TeamService(teamStore);
  const organizationService = new OrganizationService(organizationStore, teamService);
  const owner = { id: ownerId, email: "owner-accept@example.com", name: "Owner" };
  const outsider = { id: outsiderId, email: "outsider-accept@example.com", name: "Outsider" };

  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Acceptance Organization",
    slug: "acceptance-organization",
  });
  const team = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "Membership Team",
  });
  const invitation = await teamService.inviteMember({
    actor: owner,
    teamId: team.id,
    email: outsider.email,
    settings: teamSettings(),
  });

  await assert.rejects(
    teamService.acceptInvitation({ actor: outsider, invitationId: invitation.id, settings: teamSettings() }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ORGANIZATION_MEMBERSHIP_REQUIRED",
  );
  assert.equal((await teamStore.listPendingInvitationsForEmail(outsider.email)).some((item) => item.id === invitation.id), true);
  assert.equal((await teamStore.listTeamsForUser(outsiderId)).length, 0);
});

test("Postgres organization team limits include adoption and serialize concurrent adoptions", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "owner-limit@example.com", "Owner");
  const db = createDb(pool);
  const organizationStore = new PostgresOrganizationStore(db);
  const teamStore = new PostgresTeamStore(db);
  const teamService = new TeamService(teamStore);
  const organizationService = new OrganizationService(organizationStore, teamService);
  const owner = { id: ownerId, email: "owner-limit@example.com", name: "Owner" };

  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Limited Team Organization",
    slug: "limited-team-organization",
    policy: { limits: { teamsPerOrganization: 1 } },
  });
  const child = await organizationService.createChildTeam({
    actor: owner,
    organizationId: organization.id,
    name: "Existing Child Team",
  });
  assert.equal(child.organizationId, organization.id);
  const standalone = await teamService.createTeam({
    actor: owner,
    name: "Over-cap Standalone",
    settings: teamSettings(),
  });
  await assert.rejects(
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ORGANIZATION_TEAM_LIMIT_REACHED",
  );
  assert.equal((await teamStore.listTeamsForUser(ownerId)).find((team) => team.id === standalone.id)?.organizationId, null);

  const raceOrganization = await organizationService.createOrganization({
    actor: owner,
    name: "Adoption Race Organization",
    slug: "adoption-race-organization",
    policy: { limits: { teamsPerOrganization: 1 } },
  });
  const raceTeams = await Promise.all([
    teamService.createTeam({ actor: owner, name: "Race Standalone One", settings: teamSettings() }),
    teamService.createTeam({ actor: owner, name: "Race Standalone Two", settings: teamSettings() }),
  ]);
  const results = await Promise.allSettled(raceTeams.map((team) => organizationService.adoptStandaloneTeam({
    actor: owner,
    organizationId: raceOrganization.id,
    teamId: team.id,
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason?.code === "ORGANIZATION_TEAM_LIMIT_REACHED").length, 1);
  assert.equal((await teamStore.listTeamsForUser(ownerId)).filter((team) => team.organizationId === raceOrganization.id).length, 1);
});

test("Postgres adoption remains atomic when two requests race", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "owner-race@example.com", "Owner");
  const db = createDb(pool);
  const organizationStore = new PostgresOrganizationStore(db);
  const teamStore = new PostgresTeamStore(db);
  const organizationService = new OrganizationService(organizationStore, new TeamService(teamStore));
  const teamService = new TeamService(teamStore);
  const owner = { id: ownerId, email: "owner-race@example.com", name: "Owner" };

  const organization = await organizationService.createOrganization({
    actor: owner,
    name: "Race Organization",
    slug: "race-organization",
  });
  const standalone = await teamService.createTeam({
    actor: owner,
    name: "Race Team",
    settings: teamSettings(),
  });
  const results = await Promise.allSettled([
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
    organizationService.adoptStandaloneTeam({ actor: owner, organizationId: organization.id, teamId: standalone.id }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected?.reason?.code, "TEAM_ALREADY_PARENTED");
  assert.equal((await teamStore.listTeamsForUser(ownerId)).find((team) => team.id === standalone.id)?.organizationId, organization.id);
});

function teamSettings() {
  return {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
  } as const;
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for organization team tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const contents = readFileSync(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(contents);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    if (id === "0017_organizations_and_org_sharing") break;
  }
  return pool;
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  email: string,
  name: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, normalized_email, name, status, email_verified_at)
     VALUES ($1, $2, $3, $4, 'active', now())`,
    [id, email, email.toLowerCase(), name],
  );
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}
