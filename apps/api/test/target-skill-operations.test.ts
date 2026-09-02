import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTargetSkillOperationStore } from "../src/target-operations/memory-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import type { ArchitectureTargetService } from "../src/targets/service.js";
import type { SubmissionService } from "../src/submissions/service.js";
import { MemorySkillUpgradePolicyStore } from "../src/upgrade-policies/memory-store.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";

const now = new Date("2026-09-02T00:00:00.000Z");
const target = {
  schemaVersion: 1 as const,
  id: "target-1",
  name: "Local companion",
  owner: { type: "user" as const, id: "owner-1" },
  adapter: { kind: "codex", version: "2.0.0", contractVersion: 2 as const },
  architectureId: "architecture-1",
  environmentId: "personal",
  profileId: "default",
  status: "connected" as const,
  consent: { status: "granted" as const, requestedAt: now.toISOString(), grantedAt: now.toISOString() },
  generation: 3,
  identityDigest: "a".repeat(64),
  capabilities: { "inventory.read": true, "sync.write": true, apply: true, rollback: true },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  health: null,
};

function fixture(upgradePolicies?: SkillUpgradePolicyService) {
  let clock = new Date(now);
  const store = new MemoryTargetSkillOperationStore();
  const targets = {
    authorizeCompanionOperation: async () => target,
    getTarget: async () => target,
    listObservations: async () => [{
      schemaVersion: 1,
      id: "observation-1",
      targetId: target.id,
      targetGeneration: target.generation,
      adapterDigest: "b".repeat(64),
      capabilitiesDigest: "c".repeat(64),
      observedAt: now.toISOString(),
      skills: [{ slug: "release-notes-helper", version: "1.0.0", managed: true }],
      configFindings: [],
      promptAwareness: { detected: false, count: 0 },
      observedDigest: "d".repeat(64),
    }],
  } as unknown as ArchitectureTargetService;
  const submissions = {
    getPublicRelease: async () => ({
      slug: "release-notes-helper",
      title: "Release Notes Helper",
      summary: "summary",
      version: "1.1.0",
      lifecycleStatus: "approved",
      reviewStatus: "approved",
      securityStatus: "passed",
      publishedAt: now.toISOString(),
      platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
      releaseNotes: "Changes",
      changeKind: "feature",
      requiresUserAction: false,
      compatibility: {},
      artifact: { sha256: "e".repeat(64), byteSize: 123, contentType: "application/json" },
    }),
  } as unknown as SubmissionService;
  const service = new TargetSkillOperationService(store, targets, submissions, {
    now: () => new Date(clock),
    idFactory: () => "operation-1",
    ...(upgradePolicies ? { upgradePolicies } : {}),
  });
  return { store, service, setNow: (value: string) => { clock = new Date(value); } };
}

test("companion operations bind exact plans, claims, fences, and receipts", async () => {
  const { service } = fixture();
  const scheduled = await service.schedule({
    actorId: "owner-1",
    targetId: target.id,
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    idempotencyKey: "update-1",
  });
  assert.equal(scheduled.replayed, false);
  assert.equal(scheduled.operation.state, "queued");
  assert.equal(scheduled.operation.fromVersion, "1.0.0");
  assert.equal(scheduled.operation.planDigest.length, 64);

  const replay = await service.schedule({
    actorId: "owner-1",
    targetId: target.id,
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    idempotencyKey: "update-1",
  });
  assert.equal(replay.replayed, true);

  const claim = await service.claim({
    actorId: "owner-1",
    targetId: target.id,
    targetGeneration: target.generation,
    holderId: "companion-1",
  });
  assert.ok(claim);
  assert.equal(claim.operation.state, "claimed");
  assert.equal(claim.operation.fencingToken, 1);
  assert.equal(JSON.stringify(claim.operation).includes("claimToken"), false);

  const applying = await service.advance({
    actorId: "owner-1",
    operationId: claim.operation.id,
    holderId: "companion-1",
    claimToken: claim.claimToken,
    fencingToken: 1,
    state: "applying",
  });
  assert.equal(applying.state, "applying");
  const verifying = await service.advance({
    actorId: "owner-1",
    operationId: claim.operation.id,
    holderId: "companion-1",
    claimToken: claim.claimToken,
    fencingToken: 1,
    state: "verifying",
  });
  assert.equal(verifying.state, "verifying");
  const completed = await service.complete({
    actorId: "owner-1",
    operationId: claim.operation.id,
    holderId: "companion-1",
    claimToken: claim.claimToken,
    fencingToken: 1,
    result: {
      status: "succeeded",
      code: "operation.succeeded",
      installedVersion: "1.1.0",
      artifactSha256: "e".repeat(64),
      contentDigest: "f".repeat(64),
    },
  });
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result?.installedVersion, "1.1.0");
  assert.equal(completed.leaseExpiresAt, undefined);
});

test("target upgrade policy revisions enforce exact pins", async () => {
  const policyService = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore(), {
    now: () => now,
    idFactory: () => "policy-revision-1",
  });
  const appended = await policyService.append({
    actorUserId: "owner-1",
    scopeType: "target",
    scopeId: target.id,
    expectedRevisionNumber: 0,
    policy: { pins: { "release-notes-helper": "1.0.0" } },
  });
  assert.equal(appended.revision.revisionNumber, 1);
  const { service } = fixture(policyService);
  await assert.rejects(service.schedule({
    actorId: "owner-1",
    targetId: target.id,
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    idempotencyKey: "update-pinned",
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_POLICY_PIN_CONFLICT");
});

test("companion claims fail closed for stale generations and invalid tokens", async () => {
  const { service } = fixture();
  await service.schedule({
    actorId: "owner-1",
    targetId: target.id,
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    idempotencyKey: "update-2",
  });
  assert.equal(await service.claim({
    actorId: "owner-1",
    targetId: target.id,
    targetGeneration: 2,
    holderId: "companion-1",
  }), null);
  const claim = await service.claim({
    actorId: "owner-1",
    targetId: target.id,
    targetGeneration: 3,
    holderId: "companion-1",
  });
  assert.ok(claim);
  await assert.rejects(service.advance({
    actorId: "owner-1",
    operationId: claim.operation.id,
    holderId: "companion-1",
    claimToken: "wrong-token-that-is-long-enough-0000000000",
    fencingToken: 1,
    state: "applying",
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_CLAIM_CONFLICT");
});

test("expired claims can be recovered with a new fencing token", async () => {
  const { service, setNow } = fixture();
  await service.schedule({
    actorId: "owner-1",
    targetId: target.id,
    action: "update",
    slug: "release-notes-helper",
    version: "1.1.0",
    idempotencyKey: "update-recovery",
  });
  const first = await service.claim({
    actorId: "owner-1",
    targetId: target.id,
    targetGeneration: 3,
    holderId: "companion-1",
  });
  assert.ok(first);
  setNow("2026-09-02T00:01:01.000Z");
  const recovered = await service.claim({
    actorId: "owner-1",
    targetId: target.id,
    targetGeneration: 3,
    holderId: "companion-2",
  });
  assert.ok(recovered);
  assert.equal(recovered.operation.fencingToken, 2);
  await assert.rejects(service.advance({
    actorId: "owner-1",
    operationId: first.operation.id,
    holderId: "companion-1",
    claimToken: first.claimToken,
    fencingToken: 1,
    state: "applying",
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_CLAIM_CONFLICT");
  const applying = await service.advance({
    actorId: "owner-1",
    operationId: recovered.operation.id,
    holderId: "companion-2",
    claimToken: recovered.claimToken,
    fencingToken: 2,
    state: "applying",
  });
  assert.equal(applying.state, "applying");
});
