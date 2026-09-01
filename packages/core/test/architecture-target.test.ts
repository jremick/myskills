import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureObservationDigest,
  architectureTargetAdapterDigest,
  architectureTargetAccessActions,
  architectureTargetAccessPolicyVersion,
  architectureTargetAccessReasons,
  architectureTargetCapabilitiesDigest,
  architectureTargetCapabilityNames,
  architectureTargetConsentStatuses,
  architectureTargetMutationCapabilities,
  architectureTargetObservationDigest,
  architectureTargetOwnerReferenceTypes,
  assertReadOnlyArchitectureTargetAdapter,
  evaluateArchitectureTargetAccess,
  evaluateArchitectureTargetAccessPolicy,
  assertValidArchitectureTargetAdapterContext,
  assertValidArchitectureTargetObservation,
  isReadOnlyArchitectureTargetAdapter,
  validateArchitectureTarget,
  validateArchitectureTargetAdapterContext,
  validateArchitectureTargetAccessPolicyInput,
  validateArchitectureTargetHealth,
  validateArchitectureTargetObservation,
  validateReadOnlyArchitectureTargetAdapter,
  type ArchitectureTarget,
  type ArchitectureTargetAdapterContext,
  type ArchitectureTargetAccessPolicyInput,
  type ArchitectureTargetObservationInput,
} from "../src/index.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };

function targetInput(): ArchitectureTarget {
  return {
    schemaVersion: 1,
    id: "target-personal",
    name: "Personal Codex",
    owner: { type: "user", id: "user-1" },
    adapter,
    architectureId: "architecture-personal",
    environmentId: "personal",
    profileId: "profile-default",
    status: "connected",
    consent: {
      status: "granted",
      requestedAt: "2026-08-30T00:00:00Z",
      grantedAt: "2026-08-30T00:01:00Z",
    },
    generation: 1,
    identityDigest: digestA,
    capabilities: {
      "inventory.read": true,
      "health.read": true,
      "plan.read": true,
      apply: false,
      rollback: false,
    },
    metadata: { provider: "local", purpose: "personal" },
  };
}

function observationInput(): ArchitectureTargetObservationInput {
  return {
    schemaVersion: 1,
    id: "observation-1",
    targetId: "target-personal",
    targetGeneration: 1,
    adapterDigest: architectureTargetAdapterDigest(adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest({ "inventory.read": true, "health.read": true, "plan.read": true }),
    observedAt: "2026-08-30T00:02:00Z",
    skills: [
      { slug: "beta", version: "1.0.0", digest: digestB, enabled: true, managed: true },
      { slug: "alpha", version: "1.0.0", digest: digestA, enabled: true, managed: true },
    ],
    configFindings: [{ code: "missing-profile", severity: "warning", count: 1 }],
    promptAwareness: { detected: false, count: 0, redacted: true },
    metadata: { adapter: "local-adapter" },
  };
}

test("target contract keeps physical target binding distinct from logical environments", () => {
  assert.deepEqual(architectureTargetOwnerReferenceTypes, ["user", "team", "organization"]);
  assert.deepEqual(architectureTargetConsentStatuses, ["pending", "granted", "denied", "revoked"]);
  const result = validateArchitectureTarget(targetInput());
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.value.environmentId, "personal");
  assert.equal(result.value.profileId, "profile-default");
  assert.equal(result.value.architectureId, "architecture-personal");
  assert.equal(result.value.owner.type, "user");
});

test("architecture target binding requires architecture scope for logical IDs", () => {
  const missing = targetInput() as unknown as Record<string, unknown>;
  delete missing.architectureId;
  const result = validateArchitectureTarget(missing);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_ARCHITECTURE_ID_INVALID"), true);

  const context: ArchitectureTargetAdapterContext = {
    targetId: "target-personal",
    targetGeneration: 1,
    architectureId: "architecture-personal",
    environmentId: "personal",
    profileId: "profile-default",
    adapterDigest: architectureTargetAdapterDigest(adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest({ "inventory.read": true, "health.read": true, "plan.read": true }),
  };
  const contextResult = validateArchitectureTargetAdapterContext(context);
  assert.equal(contextResult.valid, true);
  assert.deepEqual(assertValidArchitectureTargetAdapterContext(context), context);

  const contextWithUnknown = { ...context, environmentAlias: "personal" };
  const unknownResult = validateArchitectureTargetAdapterContext(contextWithUnknown);
  assert.equal(unknownResult.valid, false);
});

test("target access policy uses current team and organization memberships", () => {
  assert.deepEqual(architectureTargetAccessActions, ["list", "read", "register", "observe", "health", "revoke"]);
  assert.deepEqual(architectureTargetAccessReasons, [
    "owner",
    "team-owner",
    "team-member",
    "organization-owner",
    "organization-admin",
    "organization-member",
    "not-owner",
    "not-member",
    "target-revoked",
  ]);
  assert.equal(architectureTargetAccessPolicyVersion, 1);

  const teamInput: ArchitectureTargetAccessPolicyInput = {
    owner: { type: "team", id: "team-delivery" },
    status: "connected",
    actor: {
      userId: "user-member",
      teamMemberships: [{ teamId: "team-delivery", role: "member" }],
    },
  };
  const teamMember = evaluateArchitectureTargetAccessPolicy(teamInput);
  assert.deepEqual(teamMember.access, {
    canList: true,
    canRead: true,
    canRegister: false,
    canObserve: false,
    canHealth: false,
    canRevoke: false,
    reason: "team-member",
  });
  assert.equal(evaluateArchitectureTargetAccess({ ...teamInput, action: "health" }).allowed, false);
  assert.equal(evaluateArchitectureTargetAccess({ ...teamInput, action: "observe" }).allowed, false);

  const organizationInput: ArchitectureTargetAccessPolicyInput = {
    owner: { type: "organization", id: "org-work" },
    status: "degraded",
    actor: {
      userId: "user-admin",
      organizationMemberships: [{ organizationId: "org-work", role: "admin" }],
    },
  };
  const organizationAdmin = evaluateArchitectureTargetAccessPolicy(organizationInput);
  assert.equal(organizationAdmin.access.canRegister, true);
  assert.equal(organizationAdmin.access.canObserve, true);
  assert.equal(organizationAdmin.access.reason, "organization-admin");
});

test("target access policy fails closed for revoked targets and membership changes", () => {
  const ownerInput: ArchitectureTargetAccessPolicyInput = {
    owner: { type: "team", id: "team-delivery" },
    status: "revoked",
    actor: {
      userId: "user-owner",
      teamMemberships: [{ teamId: "team-delivery", role: "owner" }],
    },
  };
  const revoked = evaluateArchitectureTargetAccessPolicy(ownerInput);
  assert.deepEqual(revoked.access, {
    canList: true,
    canRead: true,
    canRegister: false,
    canObserve: false,
    canHealth: false,
    canRevoke: false,
    reason: "target-revoked",
  });
  assert.equal(evaluateArchitectureTargetAccess({ ...ownerInput, action: "read" }).allowed, true);
  assert.equal(evaluateArchitectureTargetAccess({ ...ownerInput, action: "observe" }).allowed, false);
  assert.equal(evaluateArchitectureTargetAccess({ ...ownerInput, action: "health" }).allowed, false);

  const noLongerMember = evaluateArchitectureTargetAccessPolicy({
    ...ownerInput,
    status: "connected",
    actor: { userId: "user-owner", teamMemberships: [{ teamId: "team-other", role: "owner" }] },
  });
  assert.deepEqual(noLongerMember.access, {
    canList: false,
    canRead: false,
    canRegister: false,
    canObserve: false,
    canHealth: false,
    canRevoke: false,
    reason: "not-member",
  });
  assert.equal(evaluateArchitectureTargetAccess({
    owner: { type: "organization", id: "org-work" },
    status: "connected",
    actor: { userId: "user-cross-org", organizationMemberships: [{ organizationId: "org-other", role: "admin" }] },
    action: "read",
  }).allowed, false);
});

test("target access policy validates membership snapshots and normalizes ordering", () => {
  const input: ArchitectureTargetAccessPolicyInput = {
    owner: { type: "organization", id: "org-work" },
    status: "connected",
    actor: {
      userId: "user-admin",
      teamMemberships: [
        { teamId: "team-zeta", role: "member" },
        { teamId: "team-alpha", role: "owner" },
      ],
      organizationMemberships: [
        { organizationId: "org-zeta", role: "member" },
        { organizationId: "org-work", role: "admin" },
      ],
    },
  };
  const result = validateArchitectureTargetAccessPolicyInput(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.value.actor.teamMemberships, [
    { teamId: "team-alpha", role: "owner" },
    { teamId: "team-zeta", role: "member" },
  ]);
  assert.deepEqual(result.value.actor.organizationMemberships, [
    { organizationId: "org-work", role: "admin" },
    { organizationId: "org-zeta", role: "member" },
  ]);

  const duplicate = validateArchitectureTargetAccessPolicyInput({
    ...input,
    actor: {
      ...input.actor,
      organizationMemberships: [...(input.actor.organizationMemberships ?? []), { organizationId: "org-work", role: "member" }],
    },
  });
  assert.equal(duplicate.valid, false);
  if (duplicate.valid) return;
  assert.equal(duplicate.errors.some((error) => error.code === "ARCHITECTURE_TARGET_ACCESS_ORGANIZATION_MEMBERSHIP_DUPLICATE"), true);
});

test("target owners include organizations and capability mutation is fail-closed", () => {
  const organizationTarget = targetInput();
  organizationTarget.owner = { type: "organization", id: "org-1" };
  assert.equal(validateArchitectureTarget(organizationTarget).valid, true);

  const mutation = targetInput();
  mutation.capabilities.apply = true;
  const mutationResult = validateArchitectureTarget(mutation);
  assert.equal(mutationResult.valid, false);
  if (mutationResult.valid) return;
  assert.equal(mutationResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_MUTATION_CAPABILITY_ENABLED"), true);
  assert.deepEqual(architectureTargetCapabilityNames, ["inventory.read", "health.read", "plan.read", "apply", "rollback", "sync.write"]);
  assert.deepEqual(architectureTargetMutationCapabilities, ["apply", "rollback", "sync.write"]);
});

test("target validation rejects unknown and sensitive keys recursively", () => {
  const unknown = targetInput() as unknown as Record<string, unknown>;
  unknown.metadata = { nested: { apiToken: "never-accepted" } };
  const result = validateArchitectureTarget(unknown);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_SENSITIVE_FIELD"), true);
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_METADATA_INVALID"), true);

  const extra = targetInput() as unknown as Record<string, unknown>;
  extra.adapter = { ...adapter, endpoint: "https://example.invalid" };
  const extraResult = validateArchitectureTarget(extra);
  assert.equal(extraResult.valid, false);
  if (extraResult.valid) return;
  assert.equal(extraResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_UNKNOWN_FIELD"), true);
  assert.equal(extraResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_SENSITIVE_FIELD"), true);
});

test("consent status requires its explicit lifecycle timestamp", () => {
  const denied = targetInput();
  denied.consent = { status: "denied", requestedAt: "2026-08-30T00:00:00Z" };
  const result = validateArchitectureTarget(denied);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_CONSENT_TIMESTAMP_REQUIRED" && error.path?.endsWith("deniedAt")), true);
});

test("target status and consent lifecycle cannot be contradictory", () => {
  const connectedWithoutConsent = targetInput();
  connectedWithoutConsent.consent = { status: "pending", requestedAt: "2026-08-30T00:00:00Z" };
  const pendingResult = validateArchitectureTarget(connectedWithoutConsent);
  assert.equal(pendingResult.valid, false);
  if (pendingResult.valid) return;
  assert.equal(pendingResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_CONSENT_INVALID"), true);

  const revokedWithoutRevokedConsent = targetInput();
  revokedWithoutRevokedConsent.status = "revoked";
  const grantedResult = validateArchitectureTarget(revokedWithoutRevokedConsent);
  assert.equal(grantedResult.valid, false);
  if (grantedResult.valid) return;
  assert.equal(grantedResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_CONSENT_INVALID"), true);

  const revokedConsentWithoutRevokedTarget = targetInput();
  revokedConsentWithoutRevokedTarget.status = "degraded";
  revokedConsentWithoutRevokedTarget.consent = {
    status: "revoked",
    requestedAt: "2026-08-30T00:00:00Z",
    revokedAt: "2026-08-30T00:01:00Z",
  };
  const degradedResult = validateArchitectureTarget(revokedConsentWithoutRevokedTarget);
  assert.equal(degradedResult.valid, false);
  if (degradedResult.valid) return;
  assert.equal(degradedResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_CONSENT_INVALID"), true);
});

test("observation digest is deterministic across collection ordering", () => {
  const input = observationInput();
  const reordered = structuredClone(input);
  reordered.skills.reverse();
  assert.equal(architectureTargetObservationDigest(input), architectureTargetObservationDigest(reordered));
  assert.equal(architectureObservationDigest(input), architectureTargetObservationDigest(input));
  const withoutId = structuredClone(input);
  delete withoutId.id;
  assert.equal(architectureTargetObservationDigest(input), architectureTargetObservationDigest(withoutId));

  const duplicateSkills = structuredClone(input);
  duplicateSkills.skills = [
    { slug: "duplicate", version: "1.0.0", digest: digestA, kind: "leaf", enabled: true, managed: true, metadata: { label: "one" } },
    { slug: "duplicate", version: "1.0.0", digest: digestA, kind: "router", enabled: false, managed: false, metadata: { label: "two" } },
  ];
  const reversedDuplicateSkills = structuredClone(duplicateSkills);
  reversedDuplicateSkills.skills.reverse();
  assert.equal(architectureTargetObservationDigest(duplicateSkills), architectureTargetObservationDigest(reversedDuplicateSkills));

  const valid = validateArchitectureTargetObservation(input);
  assert.equal(valid.valid, true);
  if (!valid.valid) return;
  assert.equal(valid.value.observedDigest, architectureTargetObservationDigest(input));
  assert.deepEqual(valid.value.skills.map((skill) => skill.slug), ["alpha", "beta"]);
  assert.deepEqual(assertValidArchitectureTargetObservation(input), valid.value);
});

test("observations are metadata-only and prompt awareness accepts booleans/counts only", () => {
  const rawPrompt = observationInput() as unknown as Record<string, unknown>;
  rawPrompt.promptAwareness = { detected: true, count: 1, promptText: "do not retain" };
  const result = validateArchitectureTargetObservation(rawPrompt);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_UNKNOWN_FIELD"), true);
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_SENSITIVE_FIELD"), true);

  const stale = observationInput();
  stale.observedDigest = digestA;
  const staleResult = validateArchitectureTargetObservation(stale);
  assert.equal(staleResult.valid, false);
  if (staleResult.valid) return;
  assert.equal(staleResult.errors.some((error) => error.code === "ARCHITECTURE_TARGET_OBSERVATION_DIGEST_MISMATCH"), true);
});

test("target metadata rejects names that could carry source or machine data at every metadata boundary", () => {
  const deniedKeys = [
    "root",
    "rootPath",
    "body",
    "promptBody",
    "source",
    "raw",
    "rawSnapshot",
    "snapshot",
    "payload",
    "file",
    "filename",
    "directory",
    "home",
    "host",
    "machine",
    "machineId",
    "credentialValue",
    "source_path",
  ];

  for (const key of deniedKeys) {
    const target = targetInput() as unknown as Record<string, unknown>;
    target.metadata = { [key]: "must-not-be-retained" };
    assertSensitiveMetadataFailure(validateArchitectureTarget(target));

    const observedSkill = structuredClone(observationInput());
    observedSkill.skills[0]!.metadata = { [key]: "must-not-be-retained" };
    assertSensitiveMetadataFailure(validateArchitectureTargetObservation(observedSkill));

    const observation = structuredClone(observationInput());
    observation.metadata = { [key]: "must-not-be-retained" };
    assertSensitiveMetadataFailure(validateArchitectureTargetObservation(observation));

    assertSensitiveMetadataFailure(validateArchitectureTargetHealth({
      status: "healthy",
      checkedAt: "2026-08-30T00:02:00Z",
      metadata: { [key]: "must-not-be-retained" },
    }));
  }
});

test("target metadata rejects private scalar values and malformed keys at every metadata boundary", () => {
  const deniedValues = [
    "https://example.invalid/private",
    "ftp://example.invalid/private",
    "/Users/example/.codex",
    "C:\\Users\\example\\.codex",
    "./skills/example/SKILL.md",
    "localhost:5432/metadata",
    "bearer abcdefghijklmnop",
    "secret: value",
    "prompt text",
    "contains\u0085control",
    "contains\u2028line-separator",
  ];

  for (const value of deniedValues) {
    const target = targetInput() as unknown as Record<string, unknown>;
    target.metadata = { label: value };
    assertSensitiveMetadataFailure(validateArchitectureTarget(target));

    const observation = structuredClone(observationInput());
    observation.metadata = { label: value };
    assertSensitiveMetadataFailure(validateArchitectureTargetObservation(observation));

    assertSensitiveMetadataFailure(validateArchitectureTargetHealth({
      status: "healthy",
      checkedAt: "2026-08-30T00:02:00Z",
      metadata: { label: value },
    }));
  }

  for (const key of ["1starts", "bad key", "bad/key", "\u0001"]) {
    const target = targetInput() as unknown as Record<string, unknown>;
    target.metadata = { [key]: "safe" };
    const result = validateArchitectureTarget(target);
    assert.equal(result.valid, false);
    if (result.valid) continue;
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_METADATA_INVALID"), true);
  }
});

test("read-only adapter conformance exposes observe/health and rejects mutation methods", () => {
  const readonlyAdapter = {
    ...adapter,
    observe: async (context: ArchitectureTargetAdapterContext) => {
      assert.equal(context.architectureId, "architecture-personal");
      return assertValidArchitectureTargetObservation(observationInput());
    },
    health: async () => ({ status: "healthy" as const, checkedAt: "2026-08-30T00:02:00Z" }),
  };
  assert.equal(validateReadOnlyArchitectureTargetAdapter(readonlyAdapter).valid, true);
  assert.equal(isReadOnlyArchitectureTargetAdapter(readonlyAdapter), true);
  assert.equal(assertReadOnlyArchitectureTargetAdapter(readonlyAdapter), readonlyAdapter);

  const mutable = { ...readonlyAdapter, apply: async () => undefined };
  const result = validateReadOnlyArchitectureTargetAdapter(mutable);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_TARGET_ADAPTER_MUTATION_METHOD"), true);
});

function assertSensitiveMetadataFailure(result: { valid: boolean; errors?: readonly { code: string }[] }): void {
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors?.some((error) => error.code === "ARCHITECTURE_TARGET_SENSITIVE_FIELD"), true);
}
