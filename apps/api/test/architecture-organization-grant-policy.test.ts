import assert from "node:assert/strict";
import test from "node:test";
import {
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
} from "@myskills-app/core";
import { MemoryArchitectureOrganizationGrantStore } from "../src/architectures/memory-organization-grant-store.js";
import {
  evaluateArchitectureOrganizationGrantPolicy,
  freezeArchitectureOrganizationGrantPolicySnapshot,
  type ArchitectureOrganizationGrantPolicyCommand,
  type ArchitectureOrganizationGrantPolicySnapshot,
} from "../src/architectures/organization-grant-policy.js";

const architectureId = "architecture-policy-fixture";
const actorUserId = "grant-policy-owner";
const organizationId = "grant-policy-organization";
const revisionId = "grant-policy-revision";
const policyRevisionId = "grant-policy-organization-policy";
const skill = {
  id: "grant-policy-skill",
  slug: "grant-policy-skill",
  version: "1.0.0",
  digest: "a".repeat(64),
  packageVisibility: "public" as const,
};

function snapshot(
  overrides: Partial<ArchitectureOrganizationGrantPolicySnapshot> = {},
): ArchitectureOrganizationGrantPolicySnapshot {
  const policy = defaultOrganizationPolicyV1;
  return {
    architectureId,
    actorUserId,
    owner: { type: "user", id: actorUserId },
    actorCanManage: true,
    currentRevisionId: revisionId,
    currentRevision: {
      id: revisionId,
      architectureId,
      spec: createFlatArchitecture({ id: architectureId, name: "Policy fixture", skills: [skill] }),
    },
    sharing: {
      organizationVisibilityEnabled: true,
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
    },
    teamParent: { organizationId: null, teamExists: true },
    organizations: [{
      organizationId,
      status: "active",
      currentPolicyRevisionId: policyRevisionId,
      currentPolicy: {
        id: policyRevisionId,
        organizationId,
        policy,
        policySha256: organizationPolicyDigest(policy),
      },
      actorMembershipRole: "owner",
    }],
    releaseChecks: [{
      organizationId,
      skill,
      allowed: true,
      identityMatches: true,
    }],
    ...overrides,
  };
}

function command(overrides: Partial<ArchitectureOrganizationGrantPolicyCommand> = {}): ArchitectureOrganizationGrantPolicyCommand {
  return {
    architectureId,
    actorUserId,
    expectedCurrentRevisionId: revisionId,
    grants: [{ organizationId, accessLevel: "read", createdUnderPolicyRevisionId: policyRevisionId }],
    ...overrides,
  };
}

async function errorCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return "allowed";
  } catch (error) {
    assert.ok(error && typeof error === "object" && "code" in error);
    return String(error.code);
  }
}

test("shared grant evaluator is deterministic, fail-closed, and permits disabled-gate revoke", () => {
  const frozen = freezeArchitectureOrganizationGrantPolicySnapshot(snapshot());
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.organizations), true);
  assert.equal(evaluateArchitectureOrganizationGrantPolicy(frozen, command()).allowed, true);

  const denied = evaluateArchitectureOrganizationGrantPolicy(
    freezeArchitectureOrganizationGrantPolicySnapshot(snapshot({
      sharing: {
        organizationVisibilityEnabled: false,
        publicVisibilityEnabled: true,
        authenticatedVisibilityEnabled: true,
      },
    })),
    command(),
  );
  assert.deepEqual(denied, {
    allowed: false,
    policyVersion: 1,
    code: "ORGANIZATION_SHARING_DISABLED",
    statusCode: 403,
  });

  const revoked = evaluateArchitectureOrganizationGrantPolicy(
    freezeArchitectureOrganizationGrantPolicySnapshot(snapshot({
      sharing: {
        organizationVisibilityEnabled: false,
        publicVisibilityEnabled: false,
        authenticatedVisibilityEnabled: false,
      },
    })),
    command({ grants: [] }),
  );
  assert.equal(revoked.allowed, true);
});

test("memory adapter applies the same shared policy decision before replacing rows", async () => {
  const store = new MemoryArchitectureOrganizationGrantStore({
    grants: [{
      architectureId,
      organizationId,
      accessLevel: "read",
      createdUnderPolicyRevisionId: policyRevisionId,
      createdByUserId: actorUserId,
      createdAt: "2026-08-30T00:00:00.000Z",
    }],
  });
  const revoked = await store.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId,
    expectedCurrentRevisionId: revisionId,
    grants: [],
    authorizationSnapshot: snapshot({
      sharing: {
        organizationVisibilityEnabled: false,
        publicVisibilityEnabled: false,
        authenticatedVisibilityEnabled: false,
      },
    }),
  });
  assert.equal(revoked.changed, true);
  assert.deepEqual(await store.listArchitectureOrganizationGrants(architectureId), []);

  const denied = await errorCode(store.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId,
    expectedCurrentRevisionId: revisionId,
    grants: [{ organizationId, accessLevel: "read", createdUnderPolicyRevisionId: policyRevisionId }],
    authorizationSnapshot: snapshot({
      sharing: {
        organizationVisibilityEnabled: false,
        publicVisibilityEnabled: true,
        authenticatedVisibilityEnabled: true,
      },
    }),
  }));
  assert.equal(denied, "ORGANIZATION_SHARING_DISABLED");

  const missingSnapshot = await errorCode(store.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId,
    expectedCurrentRevisionId: revisionId,
    grants: [],
  }));
  assert.equal(missingSnapshot, "ARCHITECTURE_GRANT_MANAGE_REQUIRED");
});

test("memory adapter prefers an authoritative snapshot provider over a stale preflight", async () => {
  let reads = 0;
  const store = new MemoryArchitectureOrganizationGrantStore({
    authorizationSnapshotProvider: async () => {
      reads += 1;
      return snapshot({ currentRevisionId: "new-current-revision" });
    },
  });

  const result = await errorCode(store.replaceArchitectureOrganizationGrants({
    architectureId,
    actorUserId,
    expectedCurrentRevisionId: revisionId,
    grants: [],
    // This is the snapshot captured during service preflight. The provider
    // represents the authoritative state observed inside the mutation.
    authorizationSnapshot: snapshot(),
  }));
  assert.equal(result, "ARCHITECTURE_REVISION_CONFLICT");
  assert.equal(reads, 1);
  assert.deepEqual(await store.listArchitectureOrganizationGrants(architectureId), []);
});
