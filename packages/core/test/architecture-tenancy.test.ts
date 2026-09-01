import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureAccessActions,
  architectureAccessPolicyVersion,
  architectureAccessReasons,
  architectureAccessRoles,
  architectureOwnerReferenceTypes,
  assertValidArchitectureOwnerReference,
  assertValidArchitecturePolicyInput,
  defaultOrganizationPolicyV1,
  evaluateArchitectureAccess,
  evaluateArchitecturePolicy,
  isArchitectureAccessAllowed,
  validateArchitectureOwnerReference,
  validateArchitecturePolicyInput,
  type ArchitectureAccess,
  type ArchitecturePolicyInput,
} from "../src/index.js";

const userOwner = { type: "user" as const, id: "user-owner" };
const teamOwner = { type: "team" as const, id: "team-delivery" };

function policyInput(owner: ArchitecturePolicyInput["owner"], actor: ArchitecturePolicyInput["actor"]): ArchitecturePolicyInput {
  return { owner, actor };
}

test("tenancy contract exports the frozen Phase 2A vocabularies", () => {
  assert.deepEqual(architectureOwnerReferenceTypes, ["user", "team"]);
  assert.deepEqual(architectureAccessRoles, ["owner", "member"]);
  assert.deepEqual(architectureAccessActions, ["read", "preview", "create", "append-revision", "manage-policy"]);
  assert.deepEqual(architectureAccessReasons, ["owner", "team-owner", "team-member", "organization", "not-owner", "not-team-member"]);
  assert.equal(architectureAccessPolicyVersion, 1);
});

test("owner references validate strictly and do not accept organization or malformed identities", () => {
  assert.deepEqual(validateArchitectureOwnerReference(userOwner), { valid: true, value: userOwner });
  assert.deepEqual(validateArchitectureOwnerReference(teamOwner), { valid: true, value: teamOwner });

  const unsupported = validateArchitectureOwnerReference({ type: "organization", id: "org-1" });
  assert.equal(unsupported.valid, false);
  if (unsupported.valid) return;
  assert.deepEqual(unsupported.errors.map((error) => error.code), ["ARCHITECTURE_OWNER_TYPE_INVALID"]);

  const malformed = validateArchitectureOwnerReference({ type: "team", id: " team-1 " });
  assert.equal(malformed.valid, false);
  if (malformed.valid) return;
  assert.deepEqual(malformed.errors.map((error) => error.code), ["ARCHITECTURE_OWNER_ID_INVALID"]);
  assert.throws(
    () => assertValidArchitectureOwnerReference({ type: "team", id: "" }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ARCHITECTURE_OWNERSHIP_VALIDATION_FAILED",
  );
});

test("user ownership is private and owner access is independent of input ordering", () => {
  const ownerInput = policyInput(userOwner, {
    userId: "user-owner",
    teamMemberships: [
      { teamId: "team-zeta", role: "member" },
      { teamId: "team-alpha", role: "owner" },
    ],
  });
  const ownerDecision = evaluateArchitecturePolicy(ownerInput);
  assert.deepEqual(ownerDecision, {
    owner: userOwner,
    accessPolicyVersion: 1,
    access: {
      canRead: true,
      canPreview: true,
      canAppendRevision: true,
      canManagePolicy: true,
      reason: "owner",
    },
  });

  const otherDecision = evaluateArchitecturePolicy(policyInput(userOwner, {
    userId: "user-other",
    teamMemberships: [{ teamId: "team-alpha", role: "owner" }],
  }));
  assert.deepEqual(otherDecision.access, {
    canRead: false,
    canPreview: false,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "not-owner",
  });
});

test("team ownership grants read and preview to members but writes to team owners", () => {
  const memberDecision = evaluateArchitecturePolicy(policyInput(teamOwner, {
    userId: "user-member",
    teamMemberships: [{ teamId: "team-delivery", role: "member" }],
  }));
  assert.deepEqual(memberDecision.access, {
    canRead: true,
    canPreview: true,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "team-member",
  });

  const ownerDecision = evaluateArchitecturePolicy(policyInput(teamOwner, {
    userId: "user-owner",
    teamMemberships: [{ teamId: "team-delivery", role: "owner" }],
  }));
  assert.deepEqual(ownerDecision.access, {
    canRead: true,
    canPreview: true,
    canAppendRevision: true,
    canManagePolicy: true,
    reason: "team-owner",
  });

  const outsiderDecision = evaluateArchitecturePolicy(policyInput(teamOwner, {
    userId: "user-outsider",
    teamMemberships: [{ teamId: "team-other", role: "owner" }],
  }));
  assert.deepEqual(outsiderDecision.access, {
    canRead: false,
    canPreview: false,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "not-team-member",
  });
});

test("action evaluation maps capability fields without side effects", () => {
  const input = {
    ...policyInput(teamOwner, {
      userId: "user-member",
      teamMemberships: [{ teamId: "team-delivery", role: "member" }],
    }),
    action: "append-revision" as const,
  };
  assert.deepEqual(evaluateArchitectureAccess(input), {
    owner: teamOwner,
    accessPolicyVersion: 1,
    action: "append-revision",
    allowed: false,
    reason: "team-member",
  });

  assert.deepEqual(evaluateArchitectureAccess({ ...input, action: "read" }), {
    owner: teamOwner,
    accessPolicyVersion: 1,
    action: "read",
    allowed: true,
    reason: "team-member",
  });
  const access: ArchitectureAccess = {
    canRead: true,
    canPreview: true,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "team-member",
  };
  assert.equal(isArchitectureAccessAllowed(access, "read"), true);
  assert.equal(isArchitectureAccessAllowed(access, "create"), false);
  assert.equal(isArchitectureAccessAllowed(access, "append-revision"), false);
  assert.equal(isArchitectureAccessAllowed(access, "manage-policy"), false);
});

test("policy input validation normalizes membership order and rejects duplicates or unknown fields", () => {
  const input = {
    owner: teamOwner,
    actor: {
      userId: "user-member",
      teamMemberships: [
        { teamId: "team-zeta", role: "member" },
        { teamId: "team-alpha", role: "owner" },
      ],
    },
  };
  const valid = validateArchitecturePolicyInput(input);
  assert.equal(valid.valid, true);
  if (!valid.valid) return;
  assert.deepEqual(valid.value.actor.teamMemberships, [
    { teamId: "team-alpha", role: "owner" },
    { teamId: "team-zeta", role: "member" },
  ]);
  assert.deepEqual(assertValidArchitecturePolicyInput(input), valid.value);
  assert.deepEqual(evaluateArchitecturePolicy(input), evaluateArchitecturePolicy({
    owner: teamOwner,
    actor: {
      userId: "user-member",
      teamMemberships: [
        { teamId: "team-alpha", role: "owner" },
        { teamId: "team-zeta", role: "member" },
      ],
    },
  }));

  const duplicate = validateArchitecturePolicyInput({
    ...input,
    actor: {
      ...input.actor,
      teamMemberships: [...input.actor.teamMemberships, { teamId: "team-alpha", role: "member" }],
    },
  });
  assert.equal(duplicate.valid, false);
  if (duplicate.valid) return;
  assert.equal(duplicate.errors.some((error) => error.code === "ARCHITECTURE_TEAM_MEMBERSHIP_DUPLICATE"), true);

  const unknown = validateArchitecturePolicyInput({ ...input, extra: true });
  assert.equal(unknown.valid, false);
  if (unknown.valid) return;
  assert.deepEqual(unknown.errors[0], {
    code: "ARCHITECTURE_POLICY_INPUT_INVALID",
    message: "Architecture policy field 'extra' is not accepted.",
    path: "extra",
  });
});

function organizationGrant(
  organizationId: string,
  grantPolicyRevisionId = `${organizationId}:policy:2`,
  overrides: Partial<{
    accessLevel: "read";
    grantPolicyOrganizationId: string;
    organizationStatus: "provisioning" | "active" | "suspended" | "archived";
    currentPolicyRevisionId: string | null;
    currentPolicyOrganizationId: string | null;
    policy: typeof defaultOrganizationPolicyV1;
  }> = {},
) {
  return {
    organizationId,
    grantPolicyRevisionId,
    grantPolicyOrganizationId: organizationId,
    organizationStatus: "active" as const,
    currentPolicyRevisionId: `${organizationId}:policy:2`,
    currentPolicyOrganizationId: organizationId,
    policy: { ...defaultOrganizationPolicyV1, sharing: { ...defaultOrganizationPolicyV1.sharing } },
    ...overrides,
  };
}

test("organization grants allow only read and preview with exact current policy and membership context", () => {
  const input: ArchitecturePolicyInput = {
    owner: userOwner,
    actor: {
      userId: "organization-member",
      organizationMemberships: [
        { organizationId: "org-zeta", role: "member" },
        { organizationId: "org-allowed", role: "admin" },
      ],
    },
    organizationVisibilityEnabled: true,
    organizationGrantContexts: [
      organizationGrant("org-zeta"),
      organizationGrant("org-allowed"),
    ],
  };
  const decision = evaluateArchitecturePolicy(input);
  assert.deepEqual(decision.access, {
    canRead: true,
    canPreview: true,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "organization",
    allowedOrganizationIds: ["org-allowed", "org-zeta"],
  });
  assert.deepEqual(evaluateArchitectureAccess({ ...input, action: "append-revision" }), {
    owner: userOwner,
    accessPolicyVersion: 1,
    action: "append-revision",
    allowed: false,
    reason: "organization",
    allowedOrganizationIds: ["org-allowed", "org-zeta"],
  });
  assert.deepEqual(evaluateArchitectureAccess({ ...input, action: "preview" }), {
    owner: userOwner,
    accessPolicyVersion: 1,
    action: "preview",
    allowed: true,
    reason: "organization",
    allowedOrganizationIds: ["org-allowed", "org-zeta"],
  });
});

test("organization context predicates fail closed without leaking unrelated organizations", () => {
  const actor = {
    userId: "organization-member",
    organizationMemberships: [
      { organizationId: "org-allowed", role: "member" as const },
    ],
  };
  const base = {
    owner: userOwner,
    actor,
    organizationVisibilityEnabled: true,
  } satisfies ArchitecturePolicyInput;

  const invalidContexts = [
    organizationGrant("org-allowed", "org-allowed:policy:1", { grantPolicyOrganizationId: "org-other" }),
    organizationGrant("org-suspended", "org-suspended:policy:1", { organizationStatus: "suspended" }),
    organizationGrant("org-no-policy", "org-no-policy:policy:1", { currentPolicyRevisionId: null }),
    organizationGrant("org-unrelated"),
  ];
  const noAccess = evaluateArchitecturePolicy({ ...base, organizationGrantContexts: invalidContexts });
  assert.deepEqual(noAccess.access, {
    canRead: false,
    canPreview: false,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "not-owner",
  });
});

test("organization architecture grants fail closed when their policy revision is stale", () => {
  const decision = evaluateArchitecturePolicy({
    owner: userOwner,
    actor: {
      userId: "organization-member",
      organizationMemberships: [{ organizationId: "org-allowed", role: "member" }],
    },
    organizationVisibilityEnabled: true,
    organizationGrantContexts: [organizationGrant("org-allowed", "org-allowed:policy:1")],
  });

  assert.deepEqual(decision.access, {
    canRead: false,
    canPreview: false,
    canAppendRevision: false,
    canManagePolicy: false,
    reason: "not-owner",
  });
});

test("owners retain stronger access even when organization grants are present", () => {
  const decision = evaluateArchitecturePolicy({
    owner: userOwner,
    actor: {
      userId: userOwner.id,
      organizationMemberships: [{ organizationId: "org-allowed", role: "member" }],
    },
    organizationVisibilityEnabled: true,
    organizationGrantContexts: [organizationGrant("org-allowed")],
  });
  assert.equal(decision.access.reason, "owner");
  assert.equal(decision.access.canAppendRevision, true);
  assert.equal(decision.access.canManagePolicy, true);
  assert.deepEqual(decision.access.allowedOrganizationIds, ["org-allowed"]);
});

test("organization contexts require strict shape and normalize organization ordering", () => {
  const valid = validateArchitecturePolicyInput({
    owner: userOwner,
    actor: {
      userId: "organization-member",
      organizationMemberships: [
        { organizationId: "org-zeta", role: "member" },
        { organizationId: "org-alpha", role: "owner" },
      ],
    },
    organizationVisibilityEnabled: true,
    organizationGrantContexts: [organizationGrant("org-zeta"), organizationGrant("org-alpha")],
  });
  assert.equal(valid.valid, true);
  if (!valid.valid) return;
  assert.deepEqual(valid.value.actor.organizationMemberships, [
    { organizationId: "org-alpha", role: "owner" },
    { organizationId: "org-zeta", role: "member" },
  ]);
  assert.deepEqual(valid.value.organizationGrantContexts?.map((context) => context.organizationId), ["org-alpha", "org-zeta"]);

  const duplicate = validateArchitecturePolicyInput({
    owner: userOwner,
    actor: {
      userId: "organization-member",
      organizationMemberships: [
        { organizationId: "org-alpha", role: "member" },
        { organizationId: "org-alpha", role: "admin" },
      ],
    },
  });
  assert.equal(duplicate.valid, false);
  if (duplicate.valid) return;
  assert.equal(duplicate.errors.some((error) => error.code === "ARCHITECTURE_ORGANIZATION_MEMBERSHIP_DUPLICATE"), true);

  const malformed = validateArchitecturePolicyInput({
    owner: userOwner,
    actor: { userId: "organization-member", organizationMemberships: [{ organizationId: "org-alpha", role: "member" }] },
    organizationVisibilityEnabled: true,
    organizationGrantContexts: [{
      ...organizationGrant("org-alpha"),
      accessLevel: "write",
    }],
  });
  assert.equal(malformed.valid, false);
  if (malformed.valid) return;
  assert.equal(malformed.errors.some((error) => error.code === "ARCHITECTURE_ORGANIZATION_GRANT_ACCESS_LEVEL_INVALID"), true);
});
