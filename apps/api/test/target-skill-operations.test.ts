import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { MemoryTargetSkillOperationStore } from "../src/target-operations/memory-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import type { ArchitectureTargetService } from "../src/targets/service.js";
import { SubmissionService } from "../src/submissions/service.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { MemorySkillUpgradePolicyStore } from "../src/upgrade-policies/memory-store.js";
import type { PublicReleaseMetadata } from "../src/submissions/types.js";
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

function fixture(upgradePolicies?: SkillUpgradePolicyService, releaseSet?: PublicReleaseMetadata[], submissionService?: SubmissionService) {
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
  const defaultRelease: PublicReleaseMetadata = {
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
    };
  const releases = releaseSet ?? [defaultRelease];
  const submissions = {
    getPublicRelease: async (input: { version: string }) => releaseSet ? releases.find((release) => release.version === input.version) ?? null : defaultRelease,
    listSkillReleases: async () => releases,
    listSkillReleaseChangeHistory: async () => releases.map(({ version, changeKind }) => ({ version, changeKind })),
  } as unknown as SubmissionService;
  const service = new TargetSkillOperationService(store, targets, submissionService ?? submissions, {
    now: () => new Date(clock),
    idFactory: () => "operation-1",
    ...(upgradePolicies ? { upgradePolicies } : {}),
  });
  return { store, service, setNow: (value: string) => { clock = new Date(value); } };
}

function rangeReleases(): PublicReleaseMetadata[] {
  return ["1.0.0", "1.1.0", "1.1.1"].map((version) => ({
    slug: "release-notes-helper", title: "Release Notes Helper", summary: "summary", version,
    lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: now.toISOString(),
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    releaseNotes: `Notes for ${version}`, changeKind: version === "1.1.0" ? "breaking" : "fix", requiresUserAction: false, compatibility: {},
    artifact: { sha256: "e".repeat(64), byteSize: 123, contentType: "application/json" },
  }));
}

test("upgrade planning and scheduling retain and enforce every crossed release change", async () => {
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
  const { service } = fixture(policies, rangeReleases());
  await assert.rejects(service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.1", idempotencyKey: "range-policy" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED");
  const updates = await service.listUpdates({ id: "owner-1", roles: [] }, target.id);
  assert.equal(updates.items[0]?.evaluation.status, "no-compatible-release");
  assert.deepEqual(updates.items[0]?.evaluation.includedReleases.map((release) => release.releaseNotes), ["Notes for 1.1.0", "Notes for 1.1.1"]);
});

test("memory queue rechecks the upgrade range after a policy changes at every execution boundary", async (t) => {
  for (const boundary of ["claim", "apply", "renew", "verify", "complete"] as const) await t.test(boundary, async () => {
    const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
    const { service, store } = fixture(policies, rangeReleases());
    const scheduled = await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.1", idempotencyKey: boundary });
    const claimInput = { actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" };
    if (boundary === "claim") {
      await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
      assert.equal(await service.claim(claimInput), null);
      assert.equal((await store.get(scheduled.operation.id))?.state, "queued");
      return;
    }
    const claimed = await service.claim(claimInput);
    assert.ok(claimed);
    const binding = { actorId: "owner-1", operationId: claimed.operation.id, holderId: "companion-1", claimToken: claimed.claimToken, fencingToken: claimed.operation.fencingToken };
    if (boundary !== "apply") await service.advance({ ...binding, state: "applying" });
    if (boundary === "complete") await service.advance({ ...binding, state: "verifying" });
    const previous = (await store.get(claimed.operation.id))?.state;
    await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
    await assert.rejects(boundary === "complete"
      ? service.complete({ ...binding, result: { status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.1", artifactSha256: "e".repeat(64), contentDigest: "f".repeat(64) } })
      : service.advance({ ...binding, state: boundary === "verify" ? "verifying" : "applying" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_POLICY_CHANGED");
    assert.equal((await store.get(claimed.operation.id))?.state, previous);
    if (boundary !== "apply") {
      assert.equal((await service.complete({ ...binding, result: { status: "failed", code: "operation.policy-changed" } })).state, "failed", "a failure receipt must remain possible after policy revocation");
    }
  });
});

test("memory queue accepts an allowed range and rejects newly restricted intermediate metadata", async () => {
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
  const releases = rangeReleases().map((release) => ({ ...release, changeKind: "fix" as const }));
  const { service } = fixture(policies, releases);
  const updates = await service.listUpdates({ id: "owner-1", roles: [] }, target.id);
  assert.equal(updates.items[0]?.evaluation.candidate?.version, "1.1.1");
  assert.deepEqual(updates.items[0]?.evaluation.includedReleases.map((release) => release.version), ["1.1.0", "1.1.1"]);
  await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.1", idempotencyKey: "metadata-range" });
  Object.assign(releases[1]!, { changeKind: "breaking" });
  assert.equal(await service.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" }), null);
});

test("memory submission history retains withdrawn changes, excludes drafts, and respects current visibility", async () => {
  const submissions = new SubmissionService(new MemorySubmissionStore());
  const actor = { id: "owner-1", roles: ["author" as const] };
  const reviewer = { id: "reviewer-1", roles: ["maintainer" as const] };
  const slug = "release-notes-helper";
  for (const version of ["1.0.0", "1.1.0", "1.1.1", "1.0.1"]) {
    const manifest = parseSkillManifest({ name: slug, title: "Release notes helper", summary: "Upgrade range fixture.", version, license: "Apache-2.0", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["workflow"] });
    const submission = await submissions.createSubmission({ actor, manifest,
      release: { changeKind: version === "1.1.0" ? "breaking" : "fix", releaseNotes: version === "1.1.0" ? "Hidden migration notes" : `Notes ${version}` },
      files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "README.md", content: "Fixture usage." }] });
    if (version === "1.0.1") continue;
    await submissions.performReviewAction({ actor: reviewer, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await submissions.performReviewAction({ actor: reviewer, submissionId: submission.id, action: "publish" });
  }
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: actor.id, scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
  const { service } = fixture(policies, undefined, submissions);
  for (const action of ["unpublish", "revoke", "delete"] as const) {
    if (action === "revoke") await submissions.performReleaseAction({ actor, slug, version: "1.1.0", action: "restore" });
    await submissions.performReleaseAction({ actor, slug, version: "1.1.0", action });
    const history = await submissions.listSkillReleaseChangeHistory({ slug, actorId: "reader-1" });
    assert.deepEqual(history.map((release) => release.version), ["1.0.0", "1.1.0", "1.1.1"]);
    assert.deepEqual(history[1], { version: "1.1.0", changeKind: "breaking" });
    const updates = await service.listUpdates({ id: "reader-1", roles: [] }, target.id);
    assert.equal(updates.items[0]?.evaluation.status, "no-compatible-release", action);
    assert.deepEqual(updates.items[0]?.evaluation.includedReleases.map((release) => release.version), ["1.1.1"]);
    assert.equal(JSON.stringify(updates).includes("Hidden migration notes"), false);
    await assert.rejects(service.schedule({ actorId: actor.id, targetId: target.id, action: "update", slug, version: "1.1.1", idempotencyKey: action }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED");
  }
  await submissions.performSkillAction({ actor, slug, action: "archive" });
  assert.deepEqual(await submissions.listSkillReleaseChangeHistory({ slug, actorId: "reader-1" }), []);
});

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
