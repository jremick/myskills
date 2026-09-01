import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import {
  MemoryArchitectureStore,
  type MemoryArchitectureOrganization,
} from "../src/architectures/memory-store.js";

const architectureOwner = "architecture-owner";
const organizationMember = "organization-member";
const teamId = "team-parent";

function organization(
  id: string,
  policy: OrganizationPolicyV1 = defaultOrganizationPolicyV1,
): MemoryArchitectureOrganization {
  return {
    id,
    status: "active",
    currentPolicyRevisionId: `${id}:policy:1`,
    policy,
  };
}

test("memory organization grants allow exact read/preview access and never append", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: false,
    organizations: [organization("org-allowed")],
    organizationMemberships: [{ userId: organizationMember, organizationId: "org-allowed", role: "member" }],
  });
  const architecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Organization-shared architecture",
    description: "",
    patternId: "flat",
  });
  const spec = createFlatArchitecture({
    id: architecture.id,
    name: architecture.name,
    skills: [{
      id: "skill-one",
      slug: "skill-one",
      version: "1.0.0",
      digest: "a".repeat(64),
      packageVisibility: "public",
    }],
  });
  const ownerRevision = await store.createRevision(architectureOwner, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Public reference",
    spec,
  });
  assert.ok(ownerRevision);
  store.addOrganizationGrant({
    architectureId: architecture.id,
    organizationId: "org-allowed",
    policyRevisionId: "org-allowed:policy:1",
  });

  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);
  store.setOrganizationVisibilityEnabled(true);

  const visible = await store.getArchitecture(organizationMember, architecture.id);
  assert.ok(visible);
  assert.deepEqual(visible.access.allowedOrganizationIds, ["org-allowed"]);
  assert.deepEqual(visible.access.reasons, ["organization"]);
  assert.equal(visible.access.canRead, true);
  assert.equal(visible.access.canPreview, true);
  assert.equal(visible.access.canCreate, false);
  assert.equal(visible.access.canAppend, false);
  assert.equal(visible.access.canManage, false);
  assert.equal((await store.listArchitectures(organizationMember)).length, 1);
  assert.equal((await store.listRevisions(organizationMember, architecture.id))?.length, 1);
  assert.equal(await store.getRevision(organizationMember, architecture.id, ownerRevision.id), null);
  const organizationPreviewRevision = await store.getRevisionForPreview(
    organizationMember,
    architecture.id,
    ownerRevision.id,
    "org-allowed",
  );
  assert.equal(organizationPreviewRevision?.id, ownerRevision.id);
  assert.equal(organizationPreviewRevision?.spec.skills[0]?.packageVisibility, "public");
  assert.equal(await store.getRevisionForPreview(organizationMember, architecture.id, ownerRevision.id), null);
  assert.equal(await store.getRevisionForPreview(organizationMember, architecture.id, ownerRevision.id, "org-other"), null);
  assert.equal((await store.getRevisionForPreview(architectureOwner, architecture.id, ownerRevision.id))?.id, ownerRevision.id);

  assert.equal(await store.createRevision(organizationMember, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "organization grant cannot write",
    spec,
  }), null);

  const privateArchitecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Private-reference architecture",
    description: "An organization grant must not expose private skill references.",
    patternId: "flat",
  });
  const privateRevision = await store.createRevision(architectureOwner, {
    architectureId: privateArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Private reference",
    spec: createFlatArchitecture({
      id: privateArchitecture.id,
      name: privateArchitecture.name,
      skills: [{
        id: "private-skill",
        slug: "private-skill",
        version: "1.0.0",
        digest: "b".repeat(64),
        packageVisibility: "private",
      }],
    }),
  });
  assert.ok(privateRevision);
  store.addOrganizationGrant({
    architectureId: privateArchitecture.id,
    organizationId: "org-allowed",
    policyRevisionId: "org-allowed:policy:1",
  });
  assert.equal(await store.getArchitecture(organizationMember, privateArchitecture.id), null);
  assert.equal(await store.getRevision(organizationMember, privateArchitecture.id, privateRevision.id), null);
  assert.equal(
    await store.getRevisionForPreview(organizationMember, privateArchitecture.id, privateRevision.id, "org-allowed"),
    null,
  );

  const organizationReferenceArchitecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Organization-reference architecture",
    description: "Organization-visible refs are resolved by the preview boundary.",
    patternId: "flat",
  });
  const organizationReferenceRevision = await store.createRevision(architectureOwner, {
    architectureId: organizationReferenceArchitecture.id,
    expectedCurrentRevisionId: null,
    message: "Organization reference",
    spec: createFlatArchitecture({
      id: organizationReferenceArchitecture.id,
      name: organizationReferenceArchitecture.name,
      skills: [{
        id: "organization-skill",
        slug: "organization-skill",
        version: "1.0.0",
        digest: "c".repeat(64),
        packageVisibility: "organization",
      }],
    }),
  });
  assert.ok(organizationReferenceRevision);
  store.addOrganizationGrant({ architectureId: organizationReferenceArchitecture.id, organizationId: "org-allowed" });
  assert.ok(await store.getArchitecture(organizationMember, organizationReferenceArchitecture.id));
  assert.equal(await store.getRevision(organizationMember, organizationReferenceArchitecture.id, organizationReferenceRevision.id), null);
  assert.equal(
    (await store.getRevisionForPreview(
      organizationMember,
      organizationReferenceArchitecture.id,
      organizationReferenceRevision.id,
      "org-allowed",
    ))?.spec.skills[0]?.packageVisibility,
    "organization",
  );
  assert.equal(
    await store.getRevisionForPreview(
      organizationMember,
      organizationReferenceArchitecture.id,
      organizationReferenceRevision.id,
      "org-other",
    ),
    null,
  );
});

test("memory grants return only current exact organization contexts and revoke immediately", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-alpha"), organization("org-beta")],
    organizationMemberships: [
      { userId: organizationMember, organizationId: "org-alpha", role: "owner" },
      { userId: organizationMember, organizationId: "org-beta", role: "admin" },
    ],
  });
  const architecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Multi-organization architecture",
    description: "",
    patternId: "flat",
  });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-beta" });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-alpha" });

  const both = await store.getArchitecture(organizationMember, architecture.id);
  assert.deepEqual(both?.access.allowedOrganizationIds, ["org-alpha", "org-beta"]);

  store.removeOrganizationMembership(organizationMember, "org-alpha");
  const betaOnly = await store.getArchitecture(organizationMember, architecture.id);
  assert.deepEqual(betaOnly?.access.allowedOrganizationIds, ["org-beta"]);
  assert.deepEqual(betaOnly?.access.reasons, ["organization"]);

  store.setOrganizationPolicy("org-beta", {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationArchitectureSharingEnabled: false },
  });
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);

  store.setOrganizationPolicy("org-beta", defaultOrganizationPolicyV1);
  store.setOrganizationStatus("org-beta", "suspended");
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);

  store.setOrganizationStatus("org-beta", "active");
  store.removeOrganizationGrant(architecture.id, "org-beta");
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);
});

test("memory architecture grants are invalidated when an organization rotates policy", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-rotating")],
    organizationMemberships: [{ userId: organizationMember, organizationId: "org-rotating", role: "member" }],
  });
  const architecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Rotating policy architecture",
    description: "",
    patternId: "flat",
  });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-rotating" });

  assert.equal((await store.getArchitecture(organizationMember, architecture.id))?.access.canRead, true);
  store.setOrganizationPolicy("org-rotating", defaultOrganizationPolicyV1, "org-rotating:policy:2");
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);
});

test("memory preview revisions require one exact allowed organization and never union contexts", async () => {
  const betaPolicy: OrganizationPolicyV1 = {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      organizationArchitectureSharingEnabled: false,
    },
  };
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-alpha"), organization("org-beta", betaPolicy)],
    organizationMemberships: [
      { userId: organizationMember, organizationId: "org-alpha", role: "member" },
      { userId: organizationMember, organizationId: "org-beta", role: "member" },
    ],
  });
  const architecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Single-context preview architecture",
    description: "Only one current organization context remains eligible.",
    patternId: "flat",
  });
  const revision = await store.createRevision(architectureOwner, {
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Organization reference",
    spec: createFlatArchitecture({
      id: architecture.id,
      name: architecture.name,
      skills: [{
        id: "organization-skill",
        slug: "organization-skill",
        version: "1.0.0",
        digest: "d".repeat(64),
        packageVisibility: "organization",
      }],
    }),
  });
  assert.ok(revision);
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-alpha" });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-beta" });

  const visible = await store.getArchitecture(organizationMember, architecture.id);
  assert.deepEqual(visible?.access.allowedOrganizationIds, ["org-alpha"]);
  assert.equal(
    (await store.getRevisionForPreview(organizationMember, architecture.id, revision.id, "org-alpha"))?.id,
    revision.id,
  );
  assert.equal(await store.getRevisionForPreview(organizationMember, architecture.id, revision.id, "org-beta"), null);
  assert.equal(await store.getRevisionForPreview(organizationMember, architecture.id, revision.id), null);
});

test("team parentage and instance roles do not create organization architecture access", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-parent")],
    organizationMemberships: [],
  });
  const architecture = await store.createArchitecture({
    actor: { id: architectureOwner, teamMemberships: [{ teamId, role: "owner" }] },
    owner: { type: "team", id: teamId },
    name: "Team-owned architecture",
    description: "",
    patternId: "flat",
  });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-parent" });

  // The team could be conceptually attached to the organization, but no
  // parentage input exists in this access snapshot and no org membership is
  // inferred from it.
  assert.equal(await store.getArchitecture({ id: organizationMember, roles: ["admin"] }, architecture.id), null);
});

test("memory org-parented team membership requires a current active organization membership", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-team-parent")],
    teamMemberships: [
      { userId: architectureOwner, teamId, role: "owner", organizationId: "org-team-parent" },
      { userId: organizationMember, teamId, role: "member", organizationId: "org-team-parent" },
    ],
    organizationMemberships: [
      { userId: architectureOwner, organizationId: "org-team-parent", role: "owner" },
    ],
  });
  const architecture = await store.createArchitecture({
    actor: architectureOwner,
    owner: { type: "team", id: teamId },
    name: "Organization-parented team architecture",
    description: "Team access follows the organization boundary.",
    patternId: "flat",
  });
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);

  store.addOrganizationMembership(organizationMember, "org-team-parent", "member");
  assert.equal((await store.getArchitecture(organizationMember, architecture.id))?.access.canRead, true);
  store.setOrganizationStatus("org-team-parent", "suspended");
  assert.equal(await store.getArchitecture(organizationMember, architecture.id), null);
});

test("session and API-token-shaped actors resolve the same organization policy", async () => {
  const store = new MemoryArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [organization("org-token")],
    organizationMemberships: [{ userId: organizationMember, organizationId: "org-token", role: "member" }],
  });
  const architecture = await store.createArchitecture({
    ownerUserId: architectureOwner,
    name: "Token policy architecture",
    description: "",
    patternId: "flat",
  });
  store.addOrganizationGrant({ architectureId: architecture.id, organizationId: "org-token" });

  const session = await store.getArchitecture({ id: organizationMember }, architecture.id);
  const token = await store.getArchitecture({ id: organizationMember, roles: ["owner"] }, architecture.id);
  assert.deepEqual(token?.access, session?.access);
});
