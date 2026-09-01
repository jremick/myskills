import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  type ArchitecturePolicyActor,
  type ArchitectureTargetOwnerReference,
  type OrganizationMembershipRole,
} from "@myskills-app/core";
import type { ArchitectureRevisionRecord } from "../src/architectures/types.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import {
  ArchitectureTargetBindingAuthorizer,
  type ArchitectureTargetOrganizationMembershipAuthority,
} from "../src/targets/architecture-binding-authorizer.js";
import type { ArchitectureTargetBindingRequest } from "../src/targets/types.js";

const actorId = "binding-actor";
const organizationId = "binding-org";

interface SeededArchitecture {
  architectureId: string;
  environmentId: string;
  profileId: string;
  revisionId: string;
}

interface MutableOrganizationMembership {
  organizationId: string;
  userId: string;
  role: OrganizationMembershipRole;
  removedAt?: string | null;
  organizationStatus?: string;
  canRegisterArchitectureTargets?: boolean;
}

function request(
  actorUserId: string,
  owner: ArchitectureTargetOwnerReference,
  seeded: SeededArchitecture,
  overrides: Partial<ArchitectureTargetBindingRequest> = {},
): ArchitectureTargetBindingRequest {
  return {
    actor: { userId: actorUserId },
    actorUserId,
    requestedOwner: { ...owner },
    owner: { ...owner },
    architectureId: seeded.architectureId,
    environmentId: seeded.environmentId,
    profileId: seeded.profileId,
    ...overrides,
  };
}

async function seedUserArchitecture(
  store: MemoryArchitectureStore,
  ownerId = actorId,
  actor: string | ArchitecturePolicyActor = ownerId,
): Promise<SeededArchitecture> {
  const architecture = await store.createArchitecture({
    actor,
    owner: { type: "user", id: ownerId },
    name: "Binding architecture",
    description: "",
    patternId: "flat",
  });
  const environmentId = `environment-${architecture.id}`;
  const profileId = `profile-${architecture.id}`;
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    profile: { id: profileId, subject: { type: "user", id: "profile-subject" } },
    environment: { id: environmentId, kind: "personal" },
    skills: [{ id: "binding-skill", slug: "binding-skill", version: "1.0.0", digest: "a".repeat(64), packageVisibility: "authenticated" }],
  });
  const revision = await store.createRevision({
    actor,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "initial",
    spec,
  });
  assert.ok(revision);
  return {
    architectureId: architecture.id,
    environmentId,
    profileId,
    revisionId: revision.id,
  };
}

async function seedTeamArchitecture(store: MemoryArchitectureStore): Promise<SeededArchitecture> {
  const architecture = await store.createArchitecture({
    actor: { id: "team-owner", teamMemberships: [{ teamId: "binding-team", role: "owner" }] },
    owner: { type: "team", id: "binding-team" },
    name: "Team binding architecture",
    description: "",
    patternId: "flat",
  });
  const environmentId = `environment-${architecture.id}`;
  const profileId = `profile-${architecture.id}`;
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    profile: { id: profileId },
    environment: { id: environmentId },
    skills: [{ id: "team-binding-skill", slug: "team-binding-skill", version: "1.0.0", digest: "b".repeat(64) }],
  });
  const revision = await store.createRevision({
    actor: { id: "team-owner", teamMemberships: [{ teamId: "binding-team", role: "owner" }] },
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "initial",
    spec,
  });
  assert.ok(revision);
  return { architectureId: architecture.id, environmentId, profileId, revisionId: revision.id };
}

function membershipAuthority(rows: MutableOrganizationMembership[]): ArchitectureTargetOrganizationMembershipAuthority {
  return {
    findMembership: async ({ organizationId: requestedOrganizationId, userId }) => rows.find((row) => (
      row.organizationId === requestedOrganizationId
      && row.userId === userId
      && row.removedAt == null
    )) ?? null,
  };
}

function organizationStore(): MemoryArchitectureStore {
  return new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [{ id: organizationId, status: "active", policy: defaultOrganizationPolicyV1 }],
    organizationMemberships: [{ userId: actorId, organizationId, role: "admin" }],
  });
}

test("user-owned target binding requires the exact architecture owner and returns current server context", async () => {
  const store = new MemoryArchitectureStore();
  const seeded = await seedUserArchitecture(store);
  const authorizer = new ArchitectureTargetBindingAuthorizer(store);

  const decision = await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded));
  assert.deepEqual(decision, {
    allowed: true,
    binding: {
      owner: { type: "user", id: actorId },
      architectureId: seeded.architectureId,
      environmentId: seeded.environmentId,
      profileId: seeded.profileId,
    },
    authorization: {
      actorUserId: actorId,
      owner: { type: "user", id: actorId },
      architectureId: seeded.architectureId,
      environmentId: seeded.environmentId,
      profileId: seeded.profileId,
      currentRevisionId: seeded.revisionId,
    },
  });

  const mismatch = await authorizer.authorizeBinding(request(actorId, { type: "user", id: "other-owner" }, seeded));
  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, "owner-mismatch");
});

test("team owners can bind while members and removed members cannot", async () => {
  const memberships = new Map<string, "owner" | "member">([
    ["team-owner", "owner"],
    ["team-member", "member"],
  ]);
  const teamStore = {
    findMembership: async ({ teamId, userId }: { teamId: string; userId: string }) => {
      const role = memberships.get(userId);
      return role && teamId === "binding-team" ? { role } : null;
    },
    listTeamsForUser: async (userId: string) => memberships.has(userId)
      ? [{ id: "binding-team", role: memberships.get(userId) as "owner" | "member" }]
      : [],
  };
  const store = new MemoryArchitectureStore({ teamStore });
  const seeded = await seedTeamArchitecture(store);
  const authorizer = new ArchitectureTargetBindingAuthorizer(store);

  const owner = await authorizer.authorizeBinding(request("team-owner", { type: "team", id: "binding-team" }, seeded));
  assert.equal(owner.allowed, true);
  assert.deepEqual(owner.binding?.owner, { type: "team", id: "binding-team" });

  const member = await authorizer.authorizeBinding(request("team-member", { type: "team", id: "binding-team" }, seeded));
  assert.deepEqual(member, { allowed: false, reason: "management-required" });

  memberships.delete("team-member");
  const removed = await authorizer.authorizeBinding(request("team-member", { type: "team", id: "binding-team" }, seeded));
  assert.deepEqual(removed, { allowed: false, reason: "not-authorized" });
});

test("organization target binding requires an exact grant, active membership, and current admin/owner authority", async () => {
  const store = organizationStore();
  const seeded = await seedUserArchitecture(store, "architecture-owner");
  store.addOrganizationGrant({ architectureId: seeded.architectureId, organizationId });
  const rows: MutableOrganizationMembership[] = [{ organizationId, userId: actorId, role: "admin" }];
  const authorizer = new ArchitectureTargetBindingAuthorizer(store, membershipAuthority(rows));

  const allowed = await authorizer.authorizeBinding(request(actorId, { type: "organization", id: organizationId }, seeded));
  assert.deepEqual(allowed, {
    allowed: true,
    binding: {
      owner: { type: "organization", id: organizationId },
      architectureId: seeded.architectureId,
      environmentId: seeded.environmentId,
      profileId: seeded.profileId,
    },
    authorization: {
      actorUserId: actorId,
      owner: { type: "organization", id: organizationId },
      architectureId: seeded.architectureId,
      environmentId: seeded.environmentId,
      profileId: seeded.profileId,
      currentRevisionId: seeded.revisionId,
    },
  });

  rows[0].role = "member";
  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "organization", id: organizationId }, seeded)),
    { allowed: false, reason: "organization-management-required" },
  );

  rows[0].removedAt = "2026-08-30T00:00:00.000Z";
  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "organization", id: organizationId }, seeded)),
    { allowed: false, reason: "organization-management-required" },
  );
});

test("organization binding fails closed for inactive, policy-disabled, grant-disabled, and cross-organization cases", async () => {
  const store = organizationStore();
  const seeded = await seedUserArchitecture(store, "architecture-owner");
  store.addOrganizationGrant({ architectureId: seeded.architectureId, organizationId });
  const rows: MutableOrganizationMembership[] = [{ organizationId, userId: actorId, role: "owner" }];
  const authorizer = new ArchitectureTargetBindingAuthorizer(store, membershipAuthority(rows));
  const ownerRequest = request(actorId, { type: "organization", id: organizationId }, seeded);

  store.setOrganizationStatus(organizationId, "suspended");
  assert.deepEqual(await authorizer.authorizeBinding(ownerRequest), { allowed: false, reason: "not-authorized" });

  store.setOrganizationStatus(organizationId, "active");
  store.setOrganizationPolicy(organizationId, {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationArchitectureSharingEnabled: false },
  });
  assert.deepEqual(await authorizer.authorizeBinding(ownerRequest), { allowed: false, reason: "not-authorized" });

  store.setOrganizationPolicy(organizationId, defaultOrganizationPolicyV1);
  store.removeOrganizationGrant(seeded.architectureId, organizationId);
  assert.deepEqual(await authorizer.authorizeBinding(ownerRequest), { allowed: false, reason: "not-authorized" });

  const crossOrgRequest = request(actorId, { type: "organization", id: "other-org" }, seeded);
  rows[0].organizationId = "other-org";
  rows[0].role = "admin";
  assert.deepEqual(await authorizer.authorizeBinding(crossOrgRequest), { allowed: false, reason: "not-authorized" });
});

test("environment and profile identifiers must exist and point to the same server profile", async () => {
  const store = new MemoryArchitectureStore();
  const seeded = await seedUserArchitecture(store);
  const authorizer = new ArchitectureTargetBindingAuthorizer(store);

  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded, { environmentId: "missing-environment" })),
    { allowed: false, reason: "environment-not-found" },
  );
  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded, { profileId: "missing-profile" })),
    { allowed: false, reason: "profile-not-found" },
  );

  const architecture = await store.getArchitecture(actorId, seeded.architectureId);
  assert.ok(architecture);
  const revision = await store.getRevision(actorId, seeded.architectureId, seeded.revisionId);
  assert.ok(revision);
  const mismatchedSpec = structuredClone(revision.spec);
  mismatchedSpec.environments[0].profileId = "other-profile";
  const revisionStore = {
    getArchitecture: store.getArchitecture.bind(store),
    getRevision: async () => ({ ...revision, spec: mismatchedSpec }),
  } as unknown as MemoryArchitectureStore;
  const mismatchedAuthorizer = new ArchitectureTargetBindingAuthorizer(revisionStore);
  assert.deepEqual(
    await mismatchedAuthorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded)),
    { allowed: false, reason: "environment-profile-mismatch" },
  );
});

test("binding authorization fails closed for unknown request and owner fields", async () => {
  const store = new MemoryArchitectureStore();
  const seeded = await seedUserArchitecture(store);
  const authorizer = new ArchitectureTargetBindingAuthorizer(store);

  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded, {
      actor: { userId: actorId, memberships: [] } as never,
    })),
    { allowed: false, reason: "invalid-request" },
  );
  assert.deepEqual(
    await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded, {
      requestedOwner: { type: "user", id: actorId, label: "untrusted" } as never,
    })),
    { allowed: false, reason: "invalid-request" },
  );
  assert.deepEqual(
    await authorizer.authorizeBinding({
      ...request(actorId, { type: "user", id: actorId }, seeded),
      clientLabel: "untrusted",
    } as never),
    { allowed: false, reason: "invalid-request" },
  );
});

test("stale current revision and hidden architecture state fail generically without echoing identifiers", async () => {
  const store = new MemoryArchitectureStore();
  const seeded = await seedUserArchitecture(store);
  const architecture = await store.getArchitecture(actorId, seeded.architectureId);
  assert.ok(architecture);
  const staleStore = {
    getArchitecture: async () => ({ ...architecture, currentRevisionId: "stale-revision" }),
    getRevision: store.getRevision.bind(store),
  } as unknown as MemoryArchitectureStore;
  const authorizer = new ArchitectureTargetBindingAuthorizer(staleStore);
  const stale = await authorizer.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded));
  assert.deepEqual(stale, { allowed: false, reason: "not-authorized" });

  const hidden = new ArchitectureTargetBindingAuthorizer({
    getArchitecture: async () => null,
    getRevision: async () => null,
  } as never);
  const hiddenDecision = await hidden.authorizeBinding(request(actorId, { type: "user", id: actorId }, seeded));
  assert.deepEqual(hiddenDecision, { allowed: false, reason: "not-authorized" });
  assert.equal(JSON.stringify(hiddenDecision).includes(seeded.architectureId), false);
  assert.equal(JSON.stringify(hiddenDecision).includes(seeded.revisionId), false);
});

test("organization policy gate and membership authority are evaluated independently of profile subject", async () => {
  const store = organizationStore();
  const seeded = await seedUserArchitecture(store, "architecture-owner");
  store.addOrganizationGrant({ architectureId: seeded.architectureId, organizationId });
  const rows: MutableOrganizationMembership[] = [{
    organizationId,
    userId: actorId,
    role: "admin",
  }];
  const authority = membershipAuthority(rows);
  const authorizer = new ArchitectureTargetBindingAuthorizer(store, authority);
  const profileSubjectRequest = request(actorId, { type: "organization", id: organizationId }, seeded);
  assert.equal((await authorizer.authorizeBinding(profileSubjectRequest)).allowed, true);

  rows[0].canRegisterArchitectureTargets = false;
  assert.deepEqual(await authorizer.authorizeBinding(profileSubjectRequest), {
    allowed: false,
    reason: "organization-policy-disabled",
  });
});

test("organization target binding reads the exact current revision through the redacted preview path", async () => {
  const store = organizationStore();
  const seeded = await seedUserArchitecture(store, "architecture-owner");
  store.addOrganizationGrant({ architectureId: seeded.architectureId, organizationId });
  const calls: Array<{ actor: unknown; architectureId: string; revisionId: string | undefined; organizationId: string | null | undefined }> = [];
  const guardedStore = {
    getArchitecture: store.getArchitecture.bind(store),
    getRevision: async () => {
      throw new Error("organization target binding must not use raw revision access");
    },
    getRevisionForPreview: async (
      actor: unknown,
      architectureId: string,
      revisionId?: string,
      requestedOrganizationId?: string | null,
    ): Promise<ArchitectureRevisionRecord | null> => {
      calls.push({ actor, architectureId, revisionId, organizationId: requestedOrganizationId });
      return store.getRevisionForPreview(
        actor as string,
        architectureId,
        revisionId,
        requestedOrganizationId,
      );
    },
  };
  const authorizer = new ArchitectureTargetBindingAuthorizer(guardedStore as never, membershipAuthority([{
    organizationId,
    userId: actorId,
    role: "admin",
  }]));

  const decision = await authorizer.authorizeBinding(
    request(actorId, { type: "organization", id: organizationId }, seeded),
  );

  assert.equal(decision.allowed, true);
  assert.deepEqual(calls, [{
    actor: actorId,
    architectureId: seeded.architectureId,
    revisionId: seeded.revisionId,
    organizationId,
  }]);
});
