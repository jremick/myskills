import test from "node:test";
import assert from "node:assert/strict";
import {
  organizationAccessActions,
  organizationAccessReasons,
  organizationMembershipRoles,
  organizationStatuses,
  assertValidOrganizationPolicyRevisionInput,
  canonicalOrganizationPolicyJson,
  defaultOrganizationPolicyV1,
  evaluateOrganizationAccess,
  evaluateOrganizationAdmin,
  evaluateOrganizationPolicy,
  evaluateOrganizationPolicyAction,
  evaluateOrganizationRead,
  evaluateOrganizationShare,
  normalizeOrganizationPolicyV1,
  organizationPolicyDigest,
  validateOrganizationPolicyV1,
  validateOrganizationPolicyRevisionInput,
  validateOrganizationPolicyInput,
} from "../src/index.js";

const organizationId = "org-alpha";
const ownerId = "user-owner";
const adminId = "user-admin";
const memberId = "user-member";

function policyInput(
  userId: string,
  memberships = [{ organizationId, userId, role: "member" as const }],
  policy = defaultOrganizationPolicyV1,
  resource: "skill" | "architecture" | undefined = "skill",
) {
  return {
    organizationId,
    organizationStatus: "active" as const,
    policy,
    actor: { userId, memberships },
    ...(resource ? { resource } : {}),
  };
}

test("organization contract exports the designed status, role, action, and reason vocabularies", () => {
  assert.deepEqual(organizationStatuses, ["provisioning", "active", "suspended", "archived"]);
  assert.deepEqual(organizationMembershipRoles, ["owner", "admin", "member"]);
  assert.deepEqual(organizationAccessActions, ["read", "share", "admin", "policy"]);
  assert.deepEqual(organizationAccessReasons, [
    "owner",
    "admin",
    "member",
    "not-member",
    "organization-inactive",
    "policy-disabled",
    "member-sharing-disabled",
  ]);
});

test("policy normalization applies the Phase 2B defaults and returns a detached value", () => {
  const normalized = normalizeOrganizationPolicyV1({});
  assert.deepEqual(normalized, defaultOrganizationPolicyV1);
  assert.notEqual(normalized, defaultOrganizationPolicyV1);
  assert.notEqual(normalized.sharing, defaultOrganizationPolicyV1.sharing);

  normalized.sharing.organizationSkillSharingEnabled = false;
  assert.equal(defaultOrganizationPolicyV1.sharing.organizationSkillSharingEnabled, true);
  assert.equal(normalized.limits.membersPerOrganization, 1000);
  assert.equal(normalized.teams.requireOrganizationMembershipForTeamMembers, true);
});

test("policy normalization rejects unknown fields, wrong types, and unbounded limits", () => {
  const unknown = validateOrganizationPolicyV1({
    sharing: { organizationSkillSharingEnabled: true, extra: false },
    extra: true,
  });
  assert.equal(unknown.valid, false);
  if (unknown.valid) return;
  assert.deepEqual(unknown.errors.map((error) => [error.code, error.path]), [
    ["ORGANIZATION_POLICY_UNKNOWN_FIELD", "extra"],
    ["ORGANIZATION_POLICY_UNKNOWN_FIELD", "sharing.extra"],
  ]);

  const invalid = validateOrganizationPolicyV1({ limits: { teamsPerOrganization: -1 } });
  assert.equal(invalid.valid, false);
  if (invalid.valid) return;
  assert.equal(invalid.errors[0]?.code, "ORGANIZATION_POLICY_LIMIT_OUT_OF_RANGE");

  const wrongType = validateOrganizationPolicyV1({ sharing: { organizationSkillSharingEnabled: "yes" } });
  assert.equal(wrongType.valid, false);
  if (wrongType.valid) return;
  assert.equal(wrongType.errors[0]?.code, "ORGANIZATION_POLICY_FLAG_INVALID");
});

test("policy canonical JSON and digest are stable across object and section ordering", () => {
  const first = {
    schemaVersion: 1,
    sharing: {
      organizationSkillSharingEnabled: false,
      organizationArchitectureSharingEnabled: true,
      membersCanShareOwnedSkillsToOrganization: true,
      teamOwnersCanShareArchitecturesToParentOrganization: false,
    },
    teams: {
      membersCanCreateTeams: true,
      requireOrganizationMembershipForTeamMembers: true,
      allowStandaloneTeamAdoption: false,
    },
    limits: {
      teamsPerOrganization: 10,
      membersPerOrganization: 20,
      organizationGrantsPerSkill: 3,
      organizationGrantsPerArchitecture: 4,
    },
  };
  const second = {
    limits: { ...first.limits },
    teams: { ...first.teams },
    sharing: { ...first.sharing },
    schemaVersion: 1,
  };
  assert.equal(canonicalOrganizationPolicyJson(first), canonicalOrganizationPolicyJson(second));
  assert.equal(organizationPolicyDigest(first), organizationPolicyDigest(second));
  assert.match(organizationPolicyDigest(first), /^[a-f0-9]{64}$/);
});

test("membership input is active-only, normalizes ordering, and rejects duplicates or unknown fields", () => {
  const valid = validateOrganizationPolicyInput({
    ...policyInput(memberId, [
      { organizationId: "org-zeta", userId: memberId, role: "admin" },
      { organizationId, userId: memberId, role: "member" },
    ]),
  });
  assert.equal(valid.valid, true);
  if (!valid.valid) return;
  assert.deepEqual(valid.value.actor.memberships, [
    { organizationId, userId: memberId, role: "member" },
    { organizationId: "org-zeta", userId: memberId, role: "admin" },
  ]);

  const duplicate = validateOrganizationPolicyInput({
    ...policyInput(memberId, [
      { organizationId, userId: memberId, role: "member" },
      { organizationId, userId: memberId, role: "admin" },
    ]),
  });
  assert.equal(duplicate.valid, false);
  if (duplicate.valid) return;
  assert.equal(duplicate.errors.some((error) => error.code === "ORGANIZATION_MEMBERSHIP_DUPLICATE"), true);

  const inactiveField = validateOrganizationPolicyInput({
    ...policyInput(memberId),
    actor: { userId: memberId, memberships: [{ organizationId, userId: memberId, role: "member", active: false }] },
  });
  assert.equal(inactiveField.valid, false);
  if (inactiveField.valid) return;
  assert.equal(inactiveField.errors.some((error) => error.path === "actor.memberships[0].active"), true);
});

test("organization roles receive the intended read, share, admin, and policy capabilities", () => {
  const owner = policyInput(ownerId, [{ organizationId, userId: ownerId, role: "owner" }]);
  const admin = policyInput(adminId, [{ organizationId, userId: adminId, role: "admin" }]);
  const member = policyInput(memberId, [{ organizationId, userId: memberId, role: "member" }]);

  assert.deepEqual(evaluateOrganizationPolicy(owner).access, {
    canRead: true,
    canShare: true,
    canAdmin: true,
    canManagePolicy: true,
    reason: "owner",
    membershipRole: "owner",
  });
  assert.deepEqual(evaluateOrganizationPolicy(admin).access, {
    canRead: true,
    canShare: true,
    canAdmin: true,
    canManagePolicy: false,
    reason: "admin",
    membershipRole: "admin",
  });
  assert.deepEqual(evaluateOrganizationPolicy(member).access, {
    canRead: true,
    canShare: false,
    canAdmin: false,
    canManagePolicy: false,
    reason: "member",
    membershipRole: "member",
  });
});

test("explicit action evaluators map capabilities and resource policy gates", () => {
  const member = policyInput(memberId);
  assert.equal(evaluateOrganizationRead(member).allowed, true);
  assert.equal(evaluateOrganizationShare(member).allowed, false);
  assert.equal(evaluateOrganizationAdmin(member).allowed, false);
  assert.equal(evaluateOrganizationPolicyAction(member).allowed, false);
  assert.equal(evaluateOrganizationAccess({ ...member, action: "read" }).reason, "member");

  const memberSharingPolicy = {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      membersCanShareOwnedSkillsToOrganization: true,
    },
  };
  assert.equal(evaluateOrganizationShare(policyInput(memberId, undefined, memberSharingPolicy)).allowed, true);

  const architectureDisabledPolicy = {
    ...defaultOrganizationPolicyV1,
    sharing: { ...defaultOrganizationPolicyV1.sharing, organizationArchitectureSharingEnabled: false },
  };
  const disabled = evaluateOrganizationRead(policyInput(memberId, undefined, architectureDisabledPolicy, "architecture"));
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.reason, "policy-disabled");
});

test("organization isolation and lifecycle status fail closed while provisioning permits owner policy setup", () => {
  const outsider = evaluateOrganizationRead(policyInput("user-outsider", [{ organizationId: "org-other", userId: "user-outsider", role: "owner" }]));
  assert.equal(outsider.allowed, false);
  assert.equal(outsider.reason, "not-member");

  const suspended = evaluateOrganizationAdmin({
    ...policyInput(ownerId, [{ organizationId, userId: ownerId, role: "owner" }]),
    organizationStatus: "suspended",
  });
  assert.equal(suspended.allowed, false);
  assert.equal(suspended.reason, "organization-inactive");

  const provisioning = evaluateOrganizationPolicyAction({
    ...policyInput(ownerId, [{ organizationId, userId: ownerId, role: "owner" }]),
    organizationStatus: "provisioning",
  });
  assert.equal(provisioning.allowed, true);
});

test("policy revision input is normalized, digest-bearing, and strict", () => {
  const input = {
    organizationId,
    policy: { sharing: { organizationSkillSharingEnabled: false } },
    reason: "Enable the first organization policy.",
  };
  const result = validateOrganizationPolicyRevisionInput(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.value.organizationId, organizationId);
  assert.equal(result.value.policy.sharing.organizationSkillSharingEnabled, false);
  assert.equal(result.value.policySha256, organizationPolicyDigest(result.value.policy));
  assert.equal(result.value.reason, input.reason);
  assert.deepEqual(assertValidOrganizationPolicyRevisionInput(input), result.value);

  const unknown = validateOrganizationPolicyRevisionInput({ ...input, revisionNumber: 2 });
  assert.equal(unknown.valid, false);
  if (unknown.valid) return;
  assert.equal(unknown.errors[0]?.code, "ORGANIZATION_REVISION_INVALID");
});

test("revision digest excludes organization identity and audit reason", () => {
  const policy = { sharing: { organizationSkillSharingEnabled: false } };
  const first = assertValidOrganizationPolicyRevisionInput({ organizationId: "org-one", policy, reason: "first" });
  const second = assertValidOrganizationPolicyRevisionInput({ organizationId: "org-two", policy, reason: "second" });
  assert.equal(first.policySha256, second.policySha256);
  assert.notEqual(first.organizationId, second.organizationId);
  assert.notEqual(first.reason, second.reason);
});
