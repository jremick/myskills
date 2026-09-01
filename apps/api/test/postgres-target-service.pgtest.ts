import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetObservationDigest,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type ArchitectureTargetObservationInput,
} from "@myskills-app/core";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import type { ArchitectureTargetBindingAuthorizer } from "../src/targets/types.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { users } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

const ownerId = "11111111-1111-4111-8111-111111111111";
const teamMemberId = "22222222-2222-4222-8222-222222222222";
const organizationMemberId = "33333333-3333-4333-8333-333333333333";
const outsiderId = "44444444-4444-4444-8444-444444444444";
const organizationAdminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const teamId = "55555555-5555-4555-8555-555555555555";
const organizationId = "66666666-6666-4666-8666-666666666666";
const architectureId = "77777777-7777-4777-8777-777777777777";
const standaloneTeamId = "88888888-8888-4888-8888-888888888888";
const teamArchitectureId = "99999999-9999-4999-8999-999999999999";
const standaloneArchitectureId = "abababab-abab-4bab-8bab-abababababab";
const externalTeamPolicyId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";

const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };
const capabilities = {
  "inventory.read": true,
  "health.read": true,
  "plan.read": true,
  apply: false,
  rollback: false,
} as const;
const adapterDigest = architectureTargetAdapterDigest(adapter);
const capabilitiesDigest = architectureTargetCapabilitiesDigest(capabilities);

test("Postgres target store enforces current user, team, and organization tenancy", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-owner@example.com");
  await insertUser(pool, teamMemberId, "target-team-member@example.com");
  await insertUser(pool, organizationMemberId, "target-org-member@example.com");
  await insertUser(pool, outsiderId, "target-outsider@example.com");
  await insertUser(pool, organizationAdminId, "target-org-admin@example.com");
  await insertArchitecture(pool);
  await insertTeam(pool);
  await insertOrganization(pool);
  await insertTeamArchitecture(pool);
  await insertArchitectureOrganizationGrant(pool);
  await pool.query(
    `INSERT INTO team_memberships (team_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
    [teamId, ownerId, teamMemberId],
  );
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member'), ($1, $3, 'admin')`,
    [organizationId, organizationMemberId, organizationAdminId],
  );

  const store = new PostgresArchitectureTargetStore(createDb(pool));
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const revokingOrganizationService = new ArchitectureTargetService(store, {
    authorizeBinding: async (request) => {
      await pool.query(
        "DELETE FROM skill_architecture_organization_grants WHERE architecture_id = $1 AND organization_id = $2",
        [architectureId, organizationId],
      );
      await pool.query(
        "UPDATE organizations SET status = 'suspended', current_policy_revision_id = NULL WHERE id = $1",
        [organizationId],
      );
      return allowAuthorization(request);
    },
  });
  await assert.rejects(
    revokingOrganizationService.registerTarget({
      actor: ownerId,
      name: "Stale organization registration",
      owner: { type: "organization", id: organizationId },
      architectureId,
      environmentId: "work",
      profileId: "work",
      adapter,
      capabilities,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_BINDING_FORBIDDEN",
  );
  await pool.query(
    "UPDATE organizations SET status = 'active', current_policy_revision_id = $1 WHERE id = $2",
    [organizationAdminId, organizationId],
  );
  await insertArchitectureOrganizationGrant(pool);
  const userTarget = await service.registerTarget({
    actor: ownerId,
    name: "Personal Codex",
    owner: { type: "user", id: ownerId },
    architectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
    credentialReference: "keychain-target-001",
  });
  const teamTarget = await service.registerTarget({
    actor: ownerId,
    name: "Team Codex",
    owner: { type: "team", id: teamId },
    architectureId: teamArchitectureId,
    environmentId: "team",
    profileId: "shared",
    adapter,
    capabilities,
  });
  const organizationTarget = await service.registerTarget({
    actor: ownerId,
    name: "Organization Codex",
    owner: { type: "organization", id: organizationId },
    architectureId,
    environmentId: "work",
    profileId: "work",
    adapter,
    capabilities,
  });

  assert.equal("credentialReference" in userTarget, false);
  assert.deepEqual((await service.listTargets(ownerId)).map((target) => target.id).sort(), [
    userTarget.id,
    teamTarget.id,
    organizationTarget.id,
  ].sort());
  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id), [teamTarget.id]);
  assert.deepEqual((await service.listTargets(organizationMemberId)).map((target) => target.id), [organizationTarget.id]);
  assert.deepEqual((await service.listTargets(organizationAdminId)).map((target) => target.id), [organizationTarget.id]);
  assert.deepEqual((await service.listTargets(outsiderId)).map((target) => target.id), []);
  assert.equal(await service.getTarget(outsiderId, userTarget.id), null);

  // Organization access requires both an active membership and an active
  // organization. Removing either fact takes effect on the next call.
  assert.equal((await service.getTarget(organizationMemberId, organizationTarget.id))?.id, organizationTarget.id);
  await pool.query(
    "UPDATE organization_memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2",
    [organizationId, organizationMemberId],
  );
  assert.equal(await service.getTarget(organizationMemberId, organizationTarget.id), null);
  await pool.query(
    "UPDATE organization_memberships SET removed_at = null WHERE organization_id = $1 AND user_id = $2",
    [organizationId, organizationMemberId],
  );
  await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [organizationId]);
  assert.equal(await service.getTarget(organizationMemberId, organizationTarget.id), null);
  await pool.query("UPDATE organizations SET status = 'active' WHERE id = $1", [organizationId]);

  await pool.query(
    "DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2",
    [teamId, teamMemberId],
  );
  assert.equal(await service.getTarget(teamMemberId, teamTarget.id), null);
});

test("Postgres target team access follows effective parent organization state across every operation", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-effective-owner@example.com");
  await insertUser(pool, teamMemberId, "target-effective-member@example.com");
  await insertOrganization(pool);
  await insertParentedAndStandaloneTeams(pool);
  await insertTeamArchitecture(pool, teamArchitectureId, teamId, "parented-target-architecture");
  await insertTeamArchitecture(pool, standaloneArchitectureId, standaloneTeamId, "standalone-target-architecture");
  await pool.query(
    `INSERT INTO team_memberships (team_id, user_id, role)
     VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($4, $2, 'owner'), ($4, $3, 'member')`,
    [teamId, ownerId, teamMemberId, standaloneTeamId],
  );
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [organizationId, teamMemberId],
  );

  const store = new PostgresArchitectureTargetStore(createDb(pool));
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const revokingService = new ArchitectureTargetService(store, {
    authorizeBinding: async (request) => {
      await pool.query(
        "UPDATE organization_memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2",
        [organizationId, ownerId],
      );
      return allowAuthorization(request);
    },
  });
  await assert.rejects(
    revokingService.registerTarget({
      actor: ownerId,
      name: "Stale parented registration",
      owner: { type: "team", id: teamId },
      architectureId: teamArchitectureId,
      environmentId: "personal",
      profileId: "personal",
      adapter,
      capabilities,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_BINDING_FORBIDDEN",
  );
  await pool.query(
    "UPDATE organization_memberships SET removed_at = null WHERE organization_id = $1 AND user_id = $2",
    [organizationId, ownerId],
  );
  const parentedTarget = await service.registerTarget({
    actor: ownerId,
    name: "Parented team target",
    owner: { type: "team", id: teamId },
    architectureId: teamArchitectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
  });
  const standaloneTarget = await service.registerTarget({
    actor: ownerId,
    name: "Standalone team target",
    owner: { type: "team", id: standaloneTeamId },
    architectureId: standaloneArchitectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
  });
  await service.grantConsent(ownerId, parentedTarget.id);
  await service.grantConsent(ownerId, standaloneTarget.id);
  await service.appendObservation({
    actor: ownerId,
    targetId: parentedTarget.id,
    observation: makeObservation(parentedTarget.id, "observation-11111111-1111-4111-8111-111111111111"),
  });
  await service.appendObservation({
    actor: ownerId,
    targetId: standaloneTarget.id,
    observation: makeObservation(standaloneTarget.id, "observation-22222222-2222-4222-8222-222222222222"),
  });

  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id).sort(), [
    parentedTarget.id,
    standaloneTarget.id,
  ].sort());
  assert.equal((await service.getTarget(teamMemberId, parentedTarget.id))?.id, parentedTarget.id);
  assert.equal((await service.listObservations(teamMemberId, parentedTarget.id)).length, 1);
  await assert.rejects(
    service.updateHealth({
      actor: teamMemberId,
      targetId: parentedTarget.id,
      health: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ACTION_FORBIDDEN",
  );
  await assert.rejects(
    service.appendObservation({
      actor: teamMemberId,
      targetId: parentedTarget.id,
      observation: makeObservation(parentedTarget.id, "observation-33333333-3333-4333-8333-333333333333"),
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ACTION_FORBIDDEN",
  );
  await assert.rejects(
    service.revokeTarget({ actor: teamMemberId, targetId: parentedTarget.id }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ACTION_FORBIDDEN",
  );

  // A raw team-membership row must stop authorizing access as soon as the
  // actor leaves the parent organization, while the standalone team remains.
  await pool.query(
    "UPDATE organization_memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2",
    [organizationId, teamMemberId],
  );
  await assertParentedTargetHidden(service, teamMemberId, parentedTarget.id);
  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id), [standaloneTarget.id]);

  const externalTeamPolicy = {
    ...defaultOrganizationPolicyV1,
    teams: {
      ...defaultOrganizationPolicyV1.teams,
      requireOrganizationMembershipForTeamMembers: false,
    },
  };
  await pool.query(
    `INSERT INTO organization_policy_revisions
       (id, organization_id, revision_number, schema_version, policy, policy_sha256, created_by_user_id)
     VALUES ($1, $2, 2, 1, $3::jsonb, $4, $5)`,
    [externalTeamPolicyId, organizationId, JSON.stringify(externalTeamPolicy), organizationPolicyDigest(externalTeamPolicy), ownerId],
  );
  await pool.query(
    "UPDATE organizations SET current_policy_revision_id = $1 WHERE id = $2",
    [externalTeamPolicyId, organizationId],
  );
  assert.equal((await service.getTarget(teamMemberId, parentedTarget.id))?.id, parentedTarget.id);
  assert.equal((await service.listObservations(teamMemberId, parentedTarget.id)).length, 1);
  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id).sort(), [
    parentedTarget.id,
    standaloneTarget.id,
  ].sort());

  await pool.query(
    "UPDATE organizations SET current_policy_revision_id = $1 WHERE id = $2",
    [organizationAdminId, organizationId],
  );
  await assertParentedTargetHidden(service, teamMemberId, parentedTarget.id);

  // Restoring membership is not enough when the parent organization is
  // suspended. The current organization state remains the authority.
  await pool.query(
    "UPDATE organization_memberships SET removed_at = null WHERE organization_id = $1 AND user_id = $2",
    [organizationId, teamMemberId],
  );
  await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [organizationId]);
  await assertParentedTargetHidden(service, teamMemberId, parentedTarget.id);
  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id), [standaloneTarget.id]);

  // A parent organization without a current policy is also not an effective
  // tenancy boundary, even if the organization membership row is present.
  await pool.query(
    "UPDATE organizations SET status = 'provisioning', current_policy_revision_id = NULL WHERE id = $1",
    [organizationId],
  );
  await assertParentedTargetHidden(service, teamMemberId, parentedTarget.id);
  assert.deepEqual((await service.listTargets(teamMemberId)).map((target) => target.id), [standaloneTarget.id]);
  await pool.query(
    "UPDATE organizations SET status = 'active', current_policy_revision_id = $1 WHERE id = $2",
    [organizationAdminId, organizationId],
  );

  // The standalone team path is unchanged even while the parent organization
  // is suspended, including observation, health, append, and revoke actions.
  assert.equal((await service.getTarget(ownerId, standaloneTarget.id))?.id, standaloneTarget.id);
  assert.equal((await service.listObservations(ownerId, standaloneTarget.id)).length, 1);
  assert.equal((await service.updateHealth({
    actor: ownerId,
    targetId: standaloneTarget.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:03:00.000Z" },
  })).health?.status, "healthy");
  await service.appendObservation({
    actor: ownerId,
    targetId: standaloneTarget.id,
    observation: makeObservation(standaloneTarget.id, "observation-44444444-4444-4444-8444-444444444444"),
  });
  assert.equal((await service.revokeTarget({ actor: ownerId, targetId: standaloneTarget.id })).status, "revoked");
});

test("Postgres target store gates consent, appends immutable observations, and preserves terminal audit visibility", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-observation-owner@example.com");
  await insertUser(pool, outsiderId, "target-observation-outsider@example.com");
  await insertArchitecture(pool);

  const store = new PostgresArchitectureTargetStore(createDb(pool));
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const target = await service.registerTarget({
    actor: ownerId,
    name: "Observation target",
    owner: { type: "user", id: ownerId },
    architectureId,
    environmentId: "personal",
    profileId: "default",
    adapter,
    capabilities,
    credentialReference: "keychain-observation-001",
  });

  const observation = makeObservation(target.id, "observation-88888888-8888-4888-8888-888888888888");
  assert.equal(await store.appendObservation({
    actor: ownerId,
    targetId: target.id,
    observation,
    audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
  }), null);
  const denied = await service.denyConsent(ownerId, target.id);
  assert.equal(denied.consent.status, "denied");
  assert.equal(await store.appendObservation({
    actor: ownerId,
    targetId: target.id,
    observation,
    audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
  }), null);
  await service.grantConsent(ownerId, target.id);
  const healthy = await service.updateHealth({
    actor: ownerId,
    targetId: target.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:00:30.000Z" },
  });
  assert.equal(healthy.status, "connected");
  assert.equal(healthy.health?.status, "healthy");
  const appended = await store.appendObservation({
    actor: ownerId,
    targetId: target.id,
    observation,
    audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
  });
  assert.equal(appended?.id, observation.id);
  assert.equal(appended?.observedDigest, observation.observedDigest);

  const listed = await store.listObservations({ actor: ownerId, targetId: target.id });
  assert.equal(listed?.length, 1);
  assert.deepEqual(listed?.[0]?.skills, []);

  // Same-id concurrent appends serialize on the target row and produce one
  // immutable observation plus one deterministic duplicate conflict.
  const concurrent = await Promise.allSettled([
    store.appendObservation({
      actor: ownerId,
      targetId: target.id,
      observation: makeObservation(target.id, "observation-99999999-9999-4999-8999-999999999999"),
      audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
    }),
    store.appendObservation({
      actor: ownerId,
      targetId: target.id,
      observation: makeObservation(target.id, "observation-99999999-9999-4999-8999-999999999999"),
      audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason?.code === "ARCHITECTURE_TARGET_OBSERVATION_ALREADY_EXISTS").length, 1);

  await assert.rejects(
    pool.query(
      "UPDATE skill_architecture_observations SET observed_digest = $1 WHERE id = $2",
      ["f".repeat(64), dbUuid(observation.id!)],
    ),
    (error: unknown) => isImmutableObservationError(error),
  );

  // A changed generation invalidates an observation captured against the old
  // binding even when its actor remains authorized.
  await pool.query("UPDATE skill_architecture_targets SET generation = 2 WHERE id = $1", [dbUuid(target.id)]);
  await assert.rejects(
    store.appendObservation({
      actor: ownerId,
      targetId: target.id,
      observation: makeObservation(target.id, "observation-abababab-abab-4bab-8bab-abababababab"),
      audit: mutationAudit(ownerId, target.id, "architecture-target.observation.append"),
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_GENERATION_MISMATCH",
  );

  const revoked = await service.revokeTarget({ actor: ownerId, targetId: target.id });
  assert.equal(revoked.status, "revoked");
  assert.equal((await service.getTarget(ownerId, target.id))?.status, "revoked");
  assert.equal(await service.getTarget(outsiderId, target.id), null);
  await assert.rejects(
    service.appendObservation({ actor: ownerId, targetId: target.id, observation: makeObservation(target.id, "observation-cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd") }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_REVOKED",
  );

  const audits = await store.listAuditEvents();
  const serializedAudits = JSON.stringify(audits);
  assert.match(serializedAudits, /architecture-target\.revoke/);
  assert.equal(serializedAudits.includes("keychain-observation-001"), false);
  assert.equal(serializedAudits.includes("credentialReference"), false);
  const privateRow = await pool.query("SELECT credential_reference FROM skill_architecture_targets WHERE id = $1", [dbUuid(target.id)]);
  assert.equal(privateRow.rows[0]?.credential_reference, null);
});

test("Postgres registration audit failure rolls back the target and an identical retry commits once", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-registration-audit-owner@example.com");
  await insertArchitecture(pool);

  let failNextAudit = true;
  const store = new PostgresArchitectureTargetStore(createDb(pool), {
    beforeAuditInsert: () => {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error("simulated registration audit failure");
      }
    },
  });
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const input = {
    actor: ownerId,
    name: "Retry-safe Postgres target",
    owner: { type: "user" as const, id: ownerId },
    architectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
  };

  await assert.rejects(
    service.registerTarget(input),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_REGISTER_FAILED",
  );
  const afterFailure = await pool.query(
    "SELECT count(*)::int AS count FROM skill_architecture_targets WHERE architecture_id = $1",
    [architectureId],
  );
  assert.equal(afterFailure.rows[0]?.count, 0);
  const allowAuditsAfterFailure = await pool.query(
    `SELECT count(*)::int AS count
     FROM audit_events
     WHERE resource_type = 'skill_architecture_target'
       AND action = 'architecture-target.register'
       AND decision = 'allow'`,
  );
  assert.equal(allowAuditsAfterFailure.rows[0]?.count, 0);

  const retry = await service.registerTarget(input);
  const afterRetry = await pool.query(
    "SELECT count(*)::int AS count FROM skill_architecture_targets WHERE architecture_id = $1",
    [architectureId],
  );
  assert.equal(afterRetry.rows[0]?.count, 1);
  const committedAllowAudits = await pool.query(
    `SELECT count(*)::int AS count, count(DISTINCT resource_id)::int AS target_count
     FROM audit_events
     WHERE resource_type = 'skill_architecture_target'
       AND action = 'architecture-target.register'
       AND decision = 'allow'`,
  );
  assert.equal(committedAllowAudits.rows[0]?.count, 1);
  assert.equal(committedAllowAudits.rows[0]?.target_count, 1);
  assert.equal((await service.getTarget(ownerId, retry.id))?.id, retry.id);
});

test("Postgres target mutations roll back before a required allow audit failure", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-mutation-audit-owner@example.com");
  await insertArchitecture(pool);

  let failNextAudit = false;
  const store = new PostgresArchitectureTargetStore(createDb(pool), {
    beforeAuditInsert: () => {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error("simulated target mutation audit failure");
      }
    },
  });
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const target = await service.registerTarget({
    actor: ownerId,
    name: "Atomic Postgres target",
    owner: { type: "user", id: ownerId },
    architectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
    credentialReference: "keychain-atomic-target",
  });

  failNextAudit = true;
  await assert.rejects(
    service.grantConsent(ownerId, target.id),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_CONSENT_FAILED",
  );
  assert.equal((await service.getTarget(ownerId, target.id))?.consent.status, "pending");
  // Target status is an operational state and remains degraded until a
  // healthy observation is recorded; consent is the pending lifecycle field.
  assert.equal((await service.getTarget(ownerId, target.id))?.status, "degraded");
  await service.grantConsent(ownerId, target.id);

  const observation = makeObservation(target.id, "observation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  failNextAudit = true;
  await assert.rejects(
    service.appendObservation({ actor: ownerId, targetId: target.id, observation }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_OBSERVATION_FAILED",
  );
  assert.equal((await service.listObservations(ownerId, target.id)).length, 0);
  await service.appendObservation({ actor: ownerId, targetId: target.id, observation });

  failNextAudit = true;
  await assert.rejects(
    service.updateHealth({
      actor: ownerId,
      targetId: target.id,
      health: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_HEALTH_FAILED",
  );
  assert.equal((await service.getTarget(ownerId, target.id))?.health, null);
  assert.equal((await service.getTarget(ownerId, target.id))?.status, "degraded");
  await service.updateHealth({
    actor: ownerId,
    targetId: target.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
  });
  await assert.rejects(
    service.updateHealth({
      actor: ownerId,
      targetId: target.id,
      health: { status: "degraded", checkedAt: "2026-08-30T00:01:00.000Z" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_HEALTH_STALE",
  );
  assert.equal((await service.getTarget(ownerId, target.id))?.health?.checkedAt, "2026-08-30T00:02:00.000Z");

  failNextAudit = true;
  await assert.rejects(
    service.revokeTarget({ actor: ownerId, targetId: target.id }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_REVOKE_FAILED",
  );
  assert.equal((await service.getTarget(ownerId, target.id))?.status, "connected");
  const credentialAfterFailure = await pool.query(
    "SELECT credential_reference FROM skill_architecture_targets WHERE id = $1",
    [dbUuid(target.id)],
  );
  assert.equal(credentialAfterFailure.rows[0]?.credential_reference, "keychain-atomic-target");
  await service.revokeTarget({ actor: ownerId, targetId: target.id });

  const allowAudits = await pool.query(
    `SELECT action, count(*)::int AS count
     FROM audit_events
     WHERE resource_type = 'skill_architecture_target'
       AND decision = 'allow'
       AND action IN (
         'architecture-target.consent.grant',
         'architecture-target.observation.append',
         'architecture-target.health.update',
         'architecture-target.revoke'
       )
     GROUP BY action
     ORDER BY action`,
  );
  assert.deepEqual(allowAudits.rows, [
    { action: "architecture-target.consent.grant", count: 1 },
    { action: "architecture-target.health.update", count: 1 },
    { action: "architecture-target.observation.append", count: 1 },
    { action: "architecture-target.revoke", count: 1 },
  ]);
});

test("Postgres target mutations revalidate active actor authority after locking the target", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  await insertUser(pool, ownerId, "target-mutation-authority-owner@example.com");
  await insertArchitecture(pool);

  let revokeAuthorityBeforeRecheck = false;
  const store = new PostgresArchitectureTargetStore(createDb(pool), {
    beforeMutationAuthorizationRecheck: async () => {
      if (!revokeAuthorityBeforeRecheck) return;
      revokeAuthorityBeforeRecheck = false;
      await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId]);
    },
  });
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const target = await service.registerTarget({
    actor: ownerId,
    name: "Authority revalidation target",
    owner: { type: "user", id: ownerId },
    architectureId,
    environmentId: "personal",
    profileId: "personal",
    adapter,
    capabilities,
  });

  const disableBeforeMutation = async (mutation: () => Promise<unknown>): Promise<void> => {
    revokeAuthorityBeforeRecheck = true;
    await assert.rejects(
      mutation(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_NOT_FOUND",
    );
    await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [ownerId]);
  };

  await disableBeforeMutation(() => service.grantConsent(ownerId, target.id));
  assert.equal((await service.getTarget(ownerId, target.id))?.consent.status, "pending");
  await service.grantConsent(ownerId, target.id);

  await disableBeforeMutation(() => service.appendObservation({
    actor: ownerId,
    targetId: target.id,
    observation: makeObservation(target.id, "observation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  }));
  assert.equal((await service.listObservations(ownerId, target.id)).length, 0);
  await service.appendObservation({
    actor: ownerId,
    targetId: target.id,
    observation: makeObservation(target.id, "observation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  });

  await disableBeforeMutation(() => service.updateHealth({
    actor: ownerId,
    targetId: target.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:03:00.000Z" },
  }));
  assert.equal((await service.getTarget(ownerId, target.id))?.health, null);
  await service.updateHealth({
    actor: ownerId,
    targetId: target.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:03:00.000Z" },
  });

  await disableBeforeMutation(() => service.revokeTarget({ actor: ownerId, targetId: target.id }));
  assert.equal((await service.getTarget(ownerId, target.id))?.status, "connected");
  await service.revokeTarget({ actor: ownerId, targetId: target.id });
});

function allowAuthorizer(): ArchitectureTargetBindingAuthorizer {
  return {
    authorizeBinding: async (request) => allowAuthorization(request),
  };
}

function allowAuthorization(request: Parameters<ArchitectureTargetBindingAuthorizer["authorizeBinding"]>[0]) {
  return {
    allowed: true as const,
    binding: {
      owner: request.requestedOwner,
      architectureId: request.architectureId,
      environmentId: request.environmentId,
      profileId: request.profileId,
    },
    authorization: {
      actorUserId: request.actorUserId,
      owner: request.requestedOwner,
      architectureId: request.architectureId,
      environmentId: request.environmentId,
      profileId: request.profileId,
      currentRevisionId: null,
    },
  };
}

function makeObservation(targetId: string, id: string): ArchitectureTargetObservationInput & { observedDigest: string } {
  const input: ArchitectureTargetObservationInput = {
    schemaVersion: 1,
    id,
    targetId,
    targetGeneration: 1,
    adapterDigest,
    capabilitiesDigest,
    observedAt: "2026-08-30T00:01:00.000Z",
    skills: [],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
  };
  return { ...input, observedDigest: architectureTargetObservationDigest(input) };
}

function mutationAudit(actorUserId: string, targetId: string, action: string) {
  return {
    actorUserId,
    action,
    decision: "allow" as const,
    targetId,
  };
}

async function insertUser(
  pool: ReturnType<typeof createPgPool>,
  id: string,
  email: string,
): Promise<void> {
  await createDb(pool).insert(users).values({
    id,
    email,
    normalizedEmail: email.toLowerCase(),
    name: email.split("@")[0] ?? "",
    status: "active",
    emailVerifiedAt: new Date(),
  });
}

async function insertArchitecture(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [architectureId, ownerId, "Target architecture", "Target service fixture", "flat"],
  );
}

async function insertTeam(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [teamId, "Target team", "target-service-team", ownerId],
  );
}

async function insertTeamArchitecture(
  pool: ReturnType<typeof createPgPool>,
  id = teamArchitectureId,
  ownerTeamId = teamId,
  name = "Team target architecture",
): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architectures (id, owner_user_id, owner_team_id, name, description, pattern_id)
     VALUES ($1, null, $2, $3, $4, $5)`,
    [id, ownerTeamId, name, "Target service fixture", "flat"],
  );
}

async function insertParentedAndStandaloneTeams(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO teams (id, name, slug, created_by_user_id, organization_id)
     VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $4, null)`,
    [
      teamId,
      "Parented target team",
      "parented-target-team",
      ownerId,
      organizationId,
      standaloneTeamId,
      "Standalone target team",
      "standalone-target-team",
    ],
  );
}

async function assertParentedTargetHidden(
  service: ArchitectureTargetService,
  actor: string,
  targetId: string,
): Promise<void> {
  assert.equal(await service.getTarget(actor, targetId), null);
  await assert.rejects(
    service.listObservations(actor, targetId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_NOT_FOUND",
  );
  await assert.rejects(
    service.updateHealth({
      actor,
      targetId,
      health: { status: "healthy", checkedAt: "2026-08-30T00:04:00.000Z" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_NOT_FOUND",
  );
  await assert.rejects(
    service.appendObservation({
      actor,
      targetId,
      observation: makeObservation(targetId, "observation-55555555-5555-4555-8555-555555555555"),
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_NOT_FOUND",
  );
  await assert.rejects(
    service.revokeTarget({ actor, targetId }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_NOT_FOUND",
  );
}

async function insertOrganization(pool: ReturnType<typeof createPgPool>): Promise<void> {
  const policy = defaultOrganizationPolicyV1;
  const policyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await pool.query(
    `INSERT INTO organizations (id, name, slug, status, created_by_user_id)
     VALUES ($1, $2, $3, 'provisioning', $4)`,
    [organizationId, "Target organization", "target-service-organization", ownerId],
  );
  await pool.query(
    `INSERT INTO organization_policy_revisions
       (id, organization_id, revision_number, schema_version, policy, policy_sha256, created_by_user_id)
     VALUES ($1, $2, 1, 1, $3::jsonb, $4, $5)`,
    [policyId, organizationId, JSON.stringify(policy), organizationPolicyDigest(policy), ownerId],
  );
  await pool.query(
    `INSERT INTO organization_memberships (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [organizationId, ownerId],
  );
  await pool.query(
    "UPDATE organizations SET status = 'active', current_policy_revision_id = $1 WHERE id = $2",
    [policyId, organizationId],
  );
  await pool.query(
    `UPDATE instance_settings
     SET value = value || '{"organizationVisibilityEnabled": true}'::jsonb
     WHERE key = 'sharing'`,
  );
}

async function insertArchitectureOrganizationGrant(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(
    `INSERT INTO skill_architecture_organization_grants
       (architecture_id, organization_id, access_level, created_under_policy_revision_id)
     VALUES ($1, $2, 'read', $3)`,
    [architectureId, organizationId, organizationAdminId],
  );
}

function dbUuid(value: string): string {
  const match = value.match(/(?:target|observation)-([0-9a-f-]+)$/i);
  return match?.[1] ?? value;
}

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required for Postgres target service tests.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrationsThrough(pool, "0018_architecture_targets_and_observations");
  return pool;
}

async function applyMigrationsThrough(pool: ReturnType<typeof createPgPool>, lastMigration: string): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await applyMigration(pool, id);
    if (id === lastMigration) return;
  }
  throw new Error(`Migration ${lastMigration} was not found.`);
}

async function applyMigration(pool: ReturnType<typeof createPgPool>, id: string): Promise<void> {
  const contents = readFileSync(join(migrationsDir, `${id}.sql`), "utf8");
  await pool.query("BEGIN");
  try {
    await pool.query(contents);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "TEST_DATABASE_URL must target a disposable database whose name includes test or ci.");
}

function isImmutableObservationError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "55000";
}
