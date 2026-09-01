import assert from "node:assert/strict";
import test from "node:test";
import {
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetObservationDigest,
  type ArchitectureTargetObservationInput,
} from "@myskills-app/core";
import { MemoryArchitectureTargetStore } from "../src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import type { ArchitectureTargetBindingAuthorizer, ArchitectureTargetBindingRequest } from "../src/targets/types.js";

const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };
const capabilities = { "inventory.read": true, "health.read": true, "plan.read": true, apply: false, rollback: false };
const adapterDigest = architectureTargetAdapterDigest(adapter);
const capabilitiesDigest = architectureTargetCapabilitiesDigest(capabilities);

function fixture(
  options: {
    authorizer?: ArchitectureTargetBindingAuthorizer;
    teams?: Array<{ userId: string; teamId: string; role: "owner" | "member" }>;
    organizations?: Array<{ userId: string; organizationId: string; role: "owner" | "admin" | "member" }>;
  } = {},
) {
  const store = new MemoryArchitectureTargetStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    teamMemberships: options.teams,
    organizationMemberships: options.organizations,
  });
  const authorizer = options.authorizer ?? allowAuthorizer();
  let nextId = 0;
  const service = new ArchitectureTargetService(store, authorizer, {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    idFactory: () => `fixture-${++nextId}`,
  });
  return { store, service };
}

function allowAuthorizer(): ArchitectureTargetBindingAuthorizer {
  return {
    authorizeBinding: async (request: ArchitectureTargetBindingRequest) => ({
      allowed: true,
      binding: {
        // The returned binding is the authoritative result. The service does
        // not reconstruct these fields from an untrusted client label.
        owner: request.requestedOwner,
        architectureId: request.architectureId,
        environmentId: request.environmentId,
        profileId: request.profileId,
      },
    }),
  };
}

function observation(targetId: string, overrides: Partial<ArchitectureTargetObservationInput> = {}): ArchitectureTargetObservationInput {
  return {
    schemaVersion: 1,
    id: `observation-${targetId}`,
    targetId,
    targetGeneration: 1,
    adapterDigest,
    capabilitiesDigest,
    observedAt: "2026-08-30T00:01:00.000Z",
    skills: [],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
    ...overrides,
  };
}

async function register(
  service: ArchitectureTargetService,
  actor: string,
  owner?: { type: "user" | "team" | "organization"; id: string },
  extra: Partial<Parameters<ArchitectureTargetService["registerTarget"]>[0]> = {},
) {
  return service.registerTarget({
    actor,
    name: `${owner?.type ?? "user"} target`,
    owner,
    architectureId: "architecture-1",
    environmentId: "environment-1",
    profileId: "profile-1",
    adapter,
    capabilities,
    ...extra,
  });
}

function mutationAudit(actorUserId: string, targetId: string, action: string) {
  return { actorUserId, action, decision: "allow" as const, targetId };
}

test("target service applies user, team, and organization role policy from current memberships", async () => {
  const { service } = fixture({
    teams: [
      { userId: "team-owner", teamId: "team-1", role: "owner" },
      { userId: "team-member", teamId: "team-1", role: "member" },
    ],
    organizations: [
      { userId: "org-owner", organizationId: "org-1", role: "owner" },
      { userId: "org-admin", organizationId: "org-1", role: "admin" },
      { userId: "org-member", organizationId: "org-1", role: "member" },
    ],
  });
  const userTarget = await register(service, "user-owner");
  const teamTarget = await register(service, "team-owner", { type: "team", id: "team-1" });
  const organizationTarget = await register(service, "org-owner", { type: "organization", id: "org-1" });

  assert.deepEqual((await service.listTargets("team-member")).map((target) => target.id).sort(), [teamTarget.id]);
  assert.deepEqual((await service.listTargets("org-member")).map((target) => target.id).sort(), [organizationTarget.id]);
  assert.deepEqual((await service.listTargets("org-admin")).map((target) => target.id).sort(), [organizationTarget.id]);
  assert.deepEqual((await service.listTargets("outsider")).map((target) => target.id), []);

  for (const [actor, targetId] of [["team-member", teamTarget.id], ["org-member", organizationTarget.id]] as const) {
    await assert.rejects(
      service.updateHealth({
        actor,
        targetId,
        health: { status: "healthy", checkedAt: "2026-08-30T00:01:00.000Z" },
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ACTION_FORBIDDEN",
    );
  }

  await assert.rejects(
    service.appendObservation({ actor: "team-member", targetId: teamTarget.id, observation: observation(teamTarget.id) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ACTION_FORBIDDEN",
  );
  assert.equal(await service.getTarget("outsider", userTarget.id), null);
});

test("binding authorizer denial and authoritative binding prevent trusting client labels", async () => {
  const authorizer: ArchitectureTargetBindingAuthorizer = {
    authorizeBinding: async (request) => {
      if (request.requestedOwner.type === "team") return { allowed: false, reason: "architecture_owner_required" };
      return {
        allowed: true,
        binding: {
          owner: { type: "user", id: "canonical-owner" },
          architectureId: "canonical-architecture",
          environmentId: "canonical-environment",
          profileId: "canonical-profile",
        },
      };
    },
  };
  const { service } = fixture({ authorizer });
  const canonical = await register(service, "requester", { type: "user", id: "label-owner" });
  assert.deepEqual(canonical.owner, { type: "user", id: "canonical-owner" });
  assert.equal(canonical.architectureId, "canonical-architecture");
  assert.equal(canonical.environmentId, "canonical-environment");
  assert.equal(canonical.profileId, "canonical-profile");
  await assert.rejects(
    register(service, "requester", { type: "team", id: "team-denied" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_BINDING_FORBIDDEN",
  );
});

test("service rejects malformed actor, owner, name, and credential inputs at the boundary", async () => {
  const { service } = fixture();
  const base = {
    actor: "owner",
    name: "safe target",
    owner: { type: "user" as const, id: "owner" },
    architectureId: "architecture-1",
    environmentId: "environment-1",
    profileId: "profile-1",
    adapter,
    capabilities,
  };

  await assert.rejects(
    service.registerTarget({ ...base, actor: null as never }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_TARGET_ACTOR",
  );
  await assert.rejects(
    service.registerTarget({ ...base, actor: { id: "owner", extra: "not-accepted" } as never }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_TARGET_ACTOR",
  );
  await assert.rejects(
    service.registerTarget({ ...base, name: 42 as never }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_TARGET_NAME",
  );
  await assert.rejects(
    service.registerTarget({ ...base, credentialReference: 42 as never }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_TARGET_CREDENTIAL_REFERENCE",
  );
  await assert.rejects(
    service.registerTarget({ ...base, owner: { type: "user", id: "owner", extra: "not-accepted" } as never }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ARCHITECTURE_TARGET_OWNER",
  );
  assert.deepEqual(await service.listTargets("owner"), []);
});

test("consent gates observation, while denial and revocation remain terminal for their operation", async () => {
  const { service, store } = fixture();
  const target = await register(service, "owner");
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_CONSENT_REQUIRED",
  );
  const denied = await service.denyConsent("owner", target.id);
  assert.equal(denied.consent.status, "denied");
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_CONSENT_REQUIRED",
  );
  const granted = await service.grantConsent("owner", target.id);
  assert.equal(granted.consent.status, "granted");
  const appended = await service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id) });
  assert.equal(appended.observedDigest.length, 64);

  const revoked = await service.revokeTarget({ actor: "owner", targetId: target.id });
  assert.equal(revoked.status, "revoked");
  const secondRevoke = await service.revokeTarget({ actor: "owner", targetId: target.id });
  assert.deepEqual(secondRevoke, revoked);
  assert.equal(await store.revokeTarget({
    actor: "outsider",
    targetId: target.id,
    audit: mutationAudit("outsider", target.id, "architecture-target.revoke"),
  }), null);
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_REVOKED",
  );
});

test("membership removal is effective immediately for team and organization targets", async () => {
  const { store, service } = fixture({
    teams: [{ userId: "team-member", teamId: "team-1", role: "member" }],
    organizations: [{ userId: "org-member", organizationId: "org-1", role: "member" }],
  });
  const teamTarget = await register(service, "team-owner", { type: "team", id: "team-1" });
  const orgTarget = await register(service, "org-owner", { type: "organization", id: "org-1" });
  assert.equal((await service.getTarget("team-member", teamTarget.id))?.id, teamTarget.id);
  assert.equal((await service.getTarget("org-member", orgTarget.id))?.id, orgTarget.id);
  store.removeTeamMembership("team-member", "team-1");
  store.removeOrganizationMembership("org-member", "org-1");
  assert.equal(await service.getTarget("team-member", teamTarget.id), null);
  assert.equal(await service.getTarget("org-member", orgTarget.id), null);
});

test("configured membership authority is queried on every access and wins over stale fixture hints", async () => {
  let teamMemberships = [{ teamId: "team-1", role: "member" as const }];
  const membershipResolver = {
    listTeamMemberships: async (userId: string) => userId === "member" ? teamMemberships : [],
    listOrganizationMemberships: async () => [],
  };
  const store = new MemoryArchitectureTargetStore({
    membershipResolver,
    teamMemberships: [{ userId: "member", teamId: "team-1", role: "member" }],
  });
  const service = new ArchitectureTargetService(store, allowAuthorizer());
  const target = await register(service, "owner", { type: "team", id: "team-1" });
  assert.equal((await service.getTarget("member", target.id))?.id, target.id);
  teamMemberships = [];
  assert.equal(await service.getTarget("member", target.id), null);
});

test("observations require current generation and exact binding digests, and reject sensitive input without echo", async () => {
  const { service } = fixture();
  const target = await register(service, "owner");
  await service.grantConsent("owner", target.id);
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id, { targetGeneration: 2 }) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_GENERATION_MISMATCH",
  );
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id, { adapterDigest: "b".repeat(64) }) }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_ADAPTER_DIGEST_MISMATCH",
  );
  const secret = "do-not-echo-this-secret";
  await assert.rejects(
    service.appendObservation({
      actor: "owner",
      targetId: target.id,
      observation: observation(target.id, { metadata: { secret } }),
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "INVALID_ARCHITECTURE_TARGET_OBSERVATION"
      && !error.message.includes(secret),
  );
});

test("server-assigned observation ids do not invalidate an adapter content digest", async () => {
  const { service } = fixture();
  const target = await register(service, "owner");
  await service.grantConsent("owner", target.id);
  const adapterObservation = observation(target.id);
  delete adapterObservation.id;
  adapterObservation.observedDigest = architectureTargetObservationDigest(adapterObservation);

  const appended = await service.appendObservation({
    actor: "owner",
    targetId: target.id,
    observation: adapterObservation,
  });
  assert.ok(appended.id);
  assert.equal(appended.observedDigest, adapterObservation.observedDigest);
});

test("observations are immutable, credentials stay private, and list ordering is deterministic", async () => {
  const { service, store } = fixture();
  const target = await register(service, "owner", undefined, { credentialReference: "keychain-target-1" });
  assert.equal("credentialReference" in target, false);
  await service.grantConsent("owner", target.id);
  const first = await service.appendObservation({ actor: "owner", targetId: target.id, observation: observation(target.id) });
  first.skills.push({ slug: "mutated-after-append" });
  const listed = await service.listObservations("owner", target.id);
  assert.deepEqual(listed[0]?.skills, []);
  const listedAgain = await service.listObservations("owner", target.id);
  assert.deepEqual(listedAgain.map((item) => item.id), listed.map((item) => item.id));

  const audit = await store.listAuditEvents();
  assert.equal(JSON.stringify(audit).includes("keychain-target-1"), false);
  assert.equal(JSON.stringify(audit).includes("credentialReference"), false);

  const targetTwo = await register(service, "owner", undefined, { name: "second target" });
  const targetThree = await register(service, "owner", undefined, { name: "third target" });
  const orderOne = (await service.listTargets("owner")).map((item) => item.id);
  const orderTwo = (await service.listTargets("owner")).map((item) => item.id);
  assert.deepEqual(orderOne, orderTwo);
  assert.ok(orderOne.includes(targetTwo.id));
  assert.ok(orderOne.includes(targetThree.id));
});

test("mutation capabilities are rejected before a target is persisted", async () => {
  const { service } = fixture();
  await assert.rejects(
    register(service, "owner", undefined, { capabilities: { ...capabilities, apply: true } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_ARCHITECTURE_TARGET",
  );
  assert.deepEqual(await service.listTargets("owner"), []);
});

test("required registration audit failure leaves no target and an identical retry commits once", async () => {
  let failNextCommit = true;
  const store = new MemoryArchitectureTargetStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    beforeCommit: () => {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("simulated registration audit failure");
      }
    },
  });
  let nextId = 0;
  const service = new ArchitectureTargetService(store, allowAuthorizer(), {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    idFactory: () => `retry-target-${++nextId}`,
  });

  const input = {
    actor: "owner",
    name: "Retry-safe target",
    owner: { type: "user" as const, id: "owner" },
    architectureId: "architecture-1",
    environmentId: "environment-1",
    profileId: "profile-1",
    adapter,
    capabilities,
  };
  await assert.rejects(
    service.registerTarget(input),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_TARGET_REGISTER_FAILED",
  );
  assert.deepEqual(await store.listTargets("owner"), []);
  const failedAudits = await store.listAuditEvents();
  assert.equal(failedAudits.filter((event) => event.action === "architecture-target.register" && event.decision === "allow").length, 0);

  const retry = await service.registerTarget(input);
  assert.equal((await store.listTargets("owner")).length, 1);
  assert.equal((await store.listTargets("owner"))[0]?.id, retry.id);
  const committedAudits = await store.listAuditEvents();
  assert.equal(committedAudits.filter((event) => event.action === "architecture-target.register" && event.decision === "allow").length, 1);
});

test("target mutations roll back before a required allow audit failure", async () => {
  let failNextAudit = false;
  const store = new MemoryArchitectureTargetStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    beforeAuditInsert: () => {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error("simulated target mutation audit failure");
      }
    },
  });
  const service = new ArchitectureTargetService(store, allowAuthorizer(), {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    idFactory: (() => {
      let nextId = 0;
      return () => `atomic-target-${++nextId}`;
    })(),
  });
  const target = await register(service, "owner");

  failNextAudit = true;
  await assert.rejects(
    service.grantConsent("owner", target.id),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_CONSENT_FAILED",
  );
  assert.equal((await store.getTarget("owner", target.id))?.consent.status, "pending");
  await service.grantConsent("owner", target.id);

  const firstObservation = observation(target.id);
  failNextAudit = true;
  await assert.rejects(
    service.appendObservation({ actor: "owner", targetId: target.id, observation: firstObservation }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_OBSERVATION_FAILED",
  );
  assert.deepEqual(await store.listObservations({ actor: "owner", targetId: target.id }), []);
  await service.appendObservation({ actor: "owner", targetId: target.id, observation: firstObservation });

  failNextAudit = true;
  await assert.rejects(
    service.updateHealth({
      actor: "owner",
      targetId: target.id,
      health: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_HEALTH_FAILED",
  );
  assert.equal((await store.getTarget("owner", target.id))?.health, null);
  await service.updateHealth({
    actor: "owner",
    targetId: target.id,
    health: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
  });
  await assert.rejects(
    service.updateHealth({
      actor: "owner",
      targetId: target.id,
      health: { status: "degraded", checkedAt: "2026-08-30T00:01:00.000Z" },
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_HEALTH_STALE",
  );
  assert.equal((await store.getTarget("owner", target.id))?.health?.checkedAt, "2026-08-30T00:02:00.000Z");

  failNextAudit = true;
  await assert.rejects(
    service.revokeTarget({ actor: "owner", targetId: target.id }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_TARGET_REVOKE_FAILED",
  );
  assert.notEqual((await store.getTarget("owner", target.id))?.status, "revoked");
  await service.revokeTarget({ actor: "owner", targetId: target.id });

  const allowActions = (await store.listAuditEvents())
    .filter((event) => event.decision === "allow")
    .map((event) => event.action);
  assert.deepEqual(allowActions.filter((action) => action === "architecture-target.consent.grant").length, 1);
  assert.deepEqual(allowActions.filter((action) => action === "architecture-target.observation.append").length, 1);
  assert.deepEqual(allowActions.filter((action) => action === "architecture-target.health.update").length, 1);
  assert.deepEqual(allowActions.filter((action) => action === "architecture-target.revoke").length, 1);
});
