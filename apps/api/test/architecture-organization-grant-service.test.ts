import assert from "node:assert/strict";
import test from "node:test";
import {
  AppError,
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import {
  ArchitectureOrganizationGrantService,
  type ArchitectureOrganizationGrantReleaseInput,
  type ReplaceArchitectureOrganizationGrantsInput,
} from "../src/architectures/organization-grant-service.js";
import { MemoryArchitectureOrganizationGrantStore } from "../src/architectures/memory-organization-grant-store.js";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";

const owner = { id: "owner-user", email: "owner@example.com", name: "Owner" };
const admin = { id: "admin-user", email: "admin@example.com", name: "Admin" };
const member = { id: "member-user", email: "member@example.com", name: "Member" };
const outsider = { id: "outsider-user", email: "outsider@example.com", name: "Outsider" };
const fixedNow = () => new Date("2026-08-30T00:00:00.000Z");

interface Fixture {
  architectureStore: MemoryArchitectureStore;
  organizationStore: MemoryOrganizationStore;
  grantStore: MemoryArchitectureOrganizationGrantStore;
  organizationService: OrganizationService;
  service: ArchitectureOrganizationGrantService;
  architectureId: string;
  revisionId: string;
}

async function fixture(options: {
  ownerType?: "user" | "team";
  visibilityEnabled?: boolean;
  releaseAuthorizer?: (input: ArchitectureOrganizationGrantReleaseInput) => boolean | { allowed: boolean; release?: { id: string; slug: string; version: string; digest: string } };
} = {}): Promise<Fixture> {
  const organizationStore = new MemoryOrganizationStore({ now: fixedNow });
  for (const user of [owner, admin, member, outsider]) organizationStore.addKnownUser(user);
  const organizationService = new OrganizationService(organizationStore);
  const architectureStore = new MemoryArchitectureStore();
  const grantStore = new MemoryArchitectureOrganizationGrantStore({ now: fixedNow });

  const architecture = options.ownerType === "team"
    ? await architectureStore.createArchitecture({
      actor: { id: owner.id, teamMemberships: [{ teamId: "team-owned", role: "owner" }] },
      owner: { type: "team", id: "team-owned" },
      name: "Team architecture",
      description: "Team-owned fixture",
      patternId: "flat",
    })
    : await architectureStore.createArchitecture({
      ownerUserId: owner.id,
      name: "User architecture",
      description: "User-owned fixture",
      patternId: "flat",
    });
  const revision = await architectureStore.createRevision(
    options.ownerType === "team"
      ? { id: owner.id, teamMemberships: [{ teamId: "team-owned", role: "owner" }] }
      : owner.id,
    {
      architectureId: architecture.id,
      expectedCurrentRevisionId: null,
      message: "Initial exact release",
      spec: createFlatArchitecture({
        id: architecture.id,
        name: architecture.name,
        skills: [{
          id: "skill-one",
          slug: "skill-one",
          version: "1.0.0",
          digest: "a".repeat(64),
          packageVisibility: "public",
        }],
      }),
    },
  );
  assert.ok(revision);

  const releaseAuthorizer = options.releaseAuthorizer ?? (() => true);
  const service = new ArchitectureOrganizationGrantService({
    architectureStore,
    organizationStore,
    grantStore,
    organizationVisibilityEnabled: options.visibilityEnabled ?? true,
    releaseAuthorizer: async (input) => releaseAuthorizer(input),
    ...(options.ownerType === "team"
      ? { teamParentAuthority: { getTeamOrganizationId: async () => "organization-1" } }
      : {}),
  });
  return {
    architectureStore,
    organizationStore,
    grantStore,
    organizationService,
    service,
    architectureId: architecture.id,
    revisionId: revision.id,
  };
}

async function createOrganization(
  service: OrganizationService,
  input: { name: string; policy?: OrganizationPolicyV1 } = { name: "Target Organization" },
  actor: typeof owner | typeof outsider = owner,
) {
  return service.createOrganization({
    actor,
    name: input.name,
    slug: input.name.toLowerCase().replace(/\s+/g, "-"),
    ...(input.policy ? { policy: input.policy } : {}),
  });
}

async function addMember(
  service: OrganizationService,
  organizationId: string,
  user: typeof admin | typeof member,
  role: "admin" | "member",
  inviter: typeof owner | typeof outsider = owner,
) {
  const invitation = await service.inviteMember({ actor: inviter, organizationId, email: user.email, role });
  await service.acceptInvitation({ actor: user, invitationId: invitation.id });
}

function replaceGrants(
  fixtureState: Pick<Fixture, "service" | "revisionId">,
  input: Omit<ReplaceArchitectureOrganizationGrantsInput, "expectedCurrentRevisionId">,
) {
  return fixtureState.service.replaceOrganizationGrants({
    ...input,
    expectedCurrentRevisionId: fixtureState.revisionId,
  });
}

test("user-owned architecture grants require the architecture owner and org owner/admin", async () => {
  const fixtureState = await fixture();
  const organization = await createOrganization(fixtureState.organizationService);
  await addMember(fixtureState.organizationService, organization.id, admin, "admin");
  await addMember(fixtureState.organizationService, organization.id, member, "member");

  const granted = await replaceGrants(fixtureState, {
    actor: owner,
    architectureId: fixtureState.architectureId,
    organizationIds: [organization.id],
  });
  assert.equal(granted.changed, true);
  assert.deepEqual(granted.organizationIds, [organization.id]);
  assert.equal(granted.grants[0]?.createdUnderPolicyRevisionId, organization.currentPolicyRevisionId);

  await assert.rejects(
    replaceGrants(fixtureState, { actor: member, architectureId: fixtureState.architectureId, organizationIds: [organization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_NOT_FOUND",
  );
  await assert.rejects(
    replaceGrants(fixtureState, { actor: outsider, architectureId: fixtureState.architectureId, organizationIds: [organization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_NOT_FOUND",
  );

});

test("team owners need explicit parent policy, while unrelated organizations require org owner/admin", async () => {
  const fixtureState = await fixture({ ownerType: "team" });
  const parent = await createOrganization(fixtureState.organizationService, { name: "Parent Organization" });
  const unrelated = await createOrganization(fixtureState.organizationService, { name: "Unrelated Organization" }, outsider);
  const parentPolicy = {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      teamOwnersCanShareArchitecturesToParentOrganization: true,
    },
  };
  await fixtureState.organizationService.appendPolicyRevision({ actor: owner, organizationId: parent.id, policy: parentPolicy });

  const parentGrant = await replaceGrants(fixtureState, {
    actor: { id: owner.id, teamMemberships: [{ teamId: "team-owned", role: "owner" }] },
    architectureId: fixtureState.architectureId,
    organizationIds: [parent.id],
  });
  assert.deepEqual(parentGrant.organizationIds, [parent.id]);

  await assert.rejects(
    replaceGrants(fixtureState, {
      actor: { id: owner.id, teamMemberships: [{ teamId: "team-owned", role: "owner" }] },
      architectureId: fixtureState.architectureId,
      organizationIds: [unrelated.id],
    }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN",
  );
  await addMember(fixtureState.organizationService, unrelated.id, owner, "admin", outsider);
  const unrelatedGrant = await replaceGrants(fixtureState, {
    actor: { id: owner.id, teamMemberships: [{ teamId: "team-owned", role: "owner" }] },
    architectureId: fixtureState.architectureId,
    organizationIds: [unrelated.id],
  });
  assert.deepEqual(unrelatedGrant.organizationIds, [unrelated.id]);
});

test("target organizations require active membership, current policy, and enabled architecture sharing", async () => {
  const fixtureState = await fixture();
  const organization = await createOrganization(fixtureState.organizationService);

  await fixtureState.organizationService.appendPolicyRevision({
    actor: owner,
    organizationId: organization.id,
    policy: {
      ...defaultOrganizationPolicyV1,
      sharing: { ...defaultOrganizationPolicyV1.sharing, organizationArchitectureSharingEnabled: false },
    },
  });
  await assert.rejects(
    replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [organization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_ARCHITECTURE_SHARING_DISABLED",
  );

  await fixtureState.organizationService.appendPolicyRevision({
    actor: owner,
    organizationId: organization.id,
    policy: defaultOrganizationPolicyV1,
  });
  await fixtureState.organizationService.archiveOrganization({ actor: owner, organizationId: organization.id });
  await assert.rejects(
    replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [organization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN",
  );

  const noMembership = await createOrganization(fixtureState.organizationService, { name: "No Membership" }, outsider);
  await assert.rejects(
    replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [noMembership.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ORGANIZATION_GRANT_FORBIDDEN",
  );

  const noPolicy = await createOrganization(fixtureState.organizationService, { name: "No Current Policy" }, outsider);
  await addMember(fixtureState.organizationService, noPolicy.id, owner, "admin", outsider);
  const row = await fixtureState.organizationStore.getOrganization(noPolicy.id);
  assert.ok(row);
  // This is fixture-only corruption to prove a missing current pointer fails
  // closed; production schema prevents an active row in this state.
  (row as { currentPolicyRevisionId: string | null }).currentPolicyRevisionId = null;
  const originalGet = fixtureState.organizationStore.getOrganization.bind(fixtureState.organizationStore);
  fixtureState.organizationStore.getOrganization = async (id: string) => id === noPolicy.id
    ? row
    : originalGet(id);
  await assert.rejects(
    replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [noPolicy.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_POLICY_REQUIRED",
  );
});

test("exact release visibility rejects private/team/explicit references and digest mismatches", async () => {
  const denied = await fixture({
    releaseAuthorizer: ({ release }) => ({
      allowed: release.digest === "a".repeat(64),
      release: {
        id: release.id,
        slug: release.slug,
        version: release.version,
        digest: release.digest,
      },
    }),
  });
  const organization = await createOrganization(denied.organizationService);
  const allowed = await replaceGrants(denied, {
    actor: owner,
    architectureId: denied.architectureId,
    organizationIds: [organization.id],
  });
  assert.equal(allowed.changed, true);

  const mismatch = await fixture({
    releaseAuthorizer: ({ release }) => ({
      allowed: true,
      release: {
        id: release.id,
        slug: release.slug,
        version: release.version,
        digest: release.digest,
        packageVisibility: "private",
      },
    }),
  });
  const mismatchOrganization = await createOrganization(mismatch.organizationService);
  await assert.rejects(
    replaceGrants(mismatch, { actor: owner, architectureId: mismatch.architectureId, organizationIds: [mismatchOrganization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_RELEASE_NOT_VISIBLE",
  );

  const privateStore = new MemoryArchitectureStore();
  const privateArchitecture = await privateStore.createArchitecture({ ownerUserId: owner.id, name: "Private", description: "", patternId: "flat" });
  const privateRevision = await privateStore.createRevision(owner.id, {
    architectureId: privateArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Private ref",
    spec: createFlatArchitecture({
      id: privateArchitecture.id,
      name: privateArchitecture.name,
      skills: [{ id: "private", slug: "private", version: "1.0.0", digest: "c".repeat(64), packageVisibility: "private" }],
    }),
  });
  assert.ok(privateRevision);
  const privateOrganizationStore = new MemoryOrganizationStore({ now: fixedNow });
  privateOrganizationStore.addKnownUser(owner);
  const privateOrganizationService = new OrganizationService(privateOrganizationStore);
  const privateOrganization = await createOrganization(privateOrganizationService, { name: "Private Target" });
  const privateGrantStore = new MemoryArchitectureOrganizationGrantStore({ now: fixedNow });
  const privateService = new ArchitectureOrganizationGrantService({
    architectureStore: privateStore,
    organizationStore: privateOrganizationStore,
    grantStore: privateGrantStore,
    organizationVisibilityEnabled: true,
    releaseAuthorizer: async () => true,
  });
  await assert.rejects(
    privateService.replaceOrganizationGrants({
      actor: owner,
      architectureId: privateArchitecture.id,
      expectedCurrentRevisionId: privateRevision.id,
      organizationIds: [privateOrganization.id],
    }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_RELEASE_NOT_VISIBLE",
  );
  assert.deepEqual(await privateGrantStore.listGrants(privateArchitecture.id), []);
});

test("replacement is atomic, idempotent, immediate on removal, and enforces policy limits", async () => {
  const fixtureState = await fixture();
  const first = await createOrganization(fixtureState.organizationService, { name: "First Target" });
  const second = await createOrganization(fixtureState.organizationService, { name: "Second Target" });
  const firstGrant = await replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [first.id] });
  assert.equal(firstGrant.changed, true);
  const retry = await replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [first.id] });
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.addedOrganizationIds, []);
  assert.deepEqual(retry.removedOrganizationIds, []);

  const replacement = await replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [second.id] });
  assert.deepEqual(replacement.addedOrganizationIds, [second.id]);
  assert.deepEqual(replacement.removedOrganizationIds, [first.id]);
  assert.deepEqual((await fixtureState.grantStore.listGrants(fixtureState.architectureId)).map((grant) => grant.organizationId), [second.id]);

  const listed = await fixtureState.service.listOrganizationGrants({
    actor: owner,
    architectureId: fixtureState.architectureId,
  });
  assert.equal(listed.currentRevisionId, fixtureState.revisionId);
  assert.deepEqual(listed.organizationIds, [second.id]);

  await assert.rejects(
    fixtureState.service.replaceOrganizationGrants({
      actor: owner,
      architectureId: fixtureState.architectureId,
      expectedCurrentRevisionId: "stale-revision",
      organizationIds: [],
    }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_REVISION_CONFLICT",
  );

  const revocationService = new ArchitectureOrganizationGrantService({
    architectureStore: fixtureState.architectureStore,
    organizationStore: fixtureState.organizationStore,
    grantStore: fixtureState.grantStore,
    organizationVisibilityEnabled: false,
    releaseAuthorizer: async () => false,
  });
  const revoked = await revocationService.replaceOrganizationGrants({
    actor: owner,
    architectureId: fixtureState.architectureId,
    expectedCurrentRevisionId: fixtureState.revisionId,
    organizationIds: [],
  });
  assert.equal(revoked.changed, true);
  assert.deepEqual(revoked.organizationIds, []);

  const limited = await fixture();
  const limitedOne = await createOrganization(limited.organizationService, { name: "Limited One", policy: {
    ...defaultOrganizationPolicyV1,
    limits: { ...defaultOrganizationPolicyV1.limits, organizationGrantsPerArchitecture: 1 },
  } });
  const limitedTwo = await createOrganization(limited.organizationService, { name: "Limited Two", policy: {
    ...defaultOrganizationPolicyV1,
    limits: { ...defaultOrganizationPolicyV1.limits, organizationGrantsPerArchitecture: 1 },
  } });
  await assert.rejects(
    replaceGrants(limited, { actor: owner, architectureId: limited.architectureId, organizationIds: [limitedOne.id, limitedTwo.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ORGANIZATION_GRANT_LIMIT_EXCEEDED",
  );
  assert.deepEqual(await limited.grantStore.listGrants(limited.architectureId), []);

  const disabled = await fixture({ visibilityEnabled: false });
  const disabledOrganization = await createOrganization(disabled.organizationService, { name: "Disabled Target" });
  await assert.rejects(
    replaceGrants(disabled, { actor: owner, architectureId: disabled.architectureId, organizationIds: [disabledOrganization.id] }),
    (error: unknown) => error instanceof AppError && error.code === "ORGANIZATION_SHARING_DISABLED",
  );
});

test("audit details contain only bounded IDs/counts/codes and never release content", async () => {
  const fixtureState = await fixture({
    releaseAuthorizer: () => ({ allowed: false, code: "PRIVATE_RELEASE" }),
  });
  const organization = await createOrganization(fixtureState.organizationService);
  await assert.rejects(
    replaceGrants(fixtureState, { actor: owner, architectureId: fixtureState.architectureId, organizationIds: [organization.id] }),
  );
  const audit = (await fixtureState.architectureStore.listAuditEvents()).find((event) => event.action === "architecture.organization-grants.replace");
  assert.ok(audit);
  const serialized = JSON.stringify(audit.details);
  assert.equal(serialized.includes("skill-one"), false);
  assert.equal(serialized.includes("PRIVATE_RELEASE"), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
  assert.equal(serialized.includes("organizationCount"), true);
});

test("allow-audit failure leaves the memory grant replacement unchanged", async () => {
  const fixtureState = await fixture();
  const first = await createOrganization(fixtureState.organizationService, { name: "Audit First Target" });
  const second = await createOrganization(fixtureState.organizationService, { name: "Audit Second Target" });
  await replaceGrants(fixtureState, {
    actor: owner,
    architectureId: fixtureState.architectureId,
    organizationIds: [first.id],
  });
  const before = await fixtureState.grantStore.listGrants(fixtureState.architectureId);
  const recordAuditEvent = fixtureState.architectureStore.recordAuditEvent.bind(fixtureState.architectureStore);

  fixtureState.architectureStore.recordAuditEvent = async (input) => {
    if (Object.prototype.hasOwnProperty.call(input.details ?? {}, "changed")) {
      throw new Error("injected allow-audit failure");
    }
    await recordAuditEvent(input);
  };
  await assert.rejects(
    replaceGrants(fixtureState, {
      actor: owner,
      architectureId: fixtureState.architectureId,
      organizationIds: [second.id],
    }),
    (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ORGANIZATION_GRANT_FAILED",
  );
  assert.deepEqual(await fixtureState.grantStore.listGrants(fixtureState.architectureId), before);
  const audits = await fixtureState.architectureStore.listAuditEvents();
  assert.equal((audits[0]?.details as { code?: string } | undefined)?.code, "ARCHITECTURE_ORGANIZATION_GRANT_FAILED");
});
