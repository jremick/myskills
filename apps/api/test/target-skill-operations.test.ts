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
import type { ArchitectureTargetRecord } from "../src/targets/types.js";
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

function fixture(upgradePolicies?: SkillUpgradePolicyService, releaseSet?: PublicReleaseMetadata[], submissionService?: SubmissionService, observedDigest?: string, targetRecord: ArchitectureTargetRecord = target) {
  let clock = new Date(now);
  const store: MemoryTargetSkillOperationStore & { canReadRelease?: () => Promise<boolean> } = new MemoryTargetSkillOperationStore();
  if (targetRecord.owner.type === "organization") store.canReadRelease = async () => true;
  const targets = {
    authorizeCompanionOperation: async () => targetRecord,
    getTarget: async () => targetRecord,
    listObservations: async () => [{
      schemaVersion: 1,
      id: "observation-1",
      targetId: target.id,
      targetGeneration: target.generation,
      adapterDigest: "b".repeat(64),
      capabilitiesDigest: "c".repeat(64),
      observedAt: now.toISOString(),
      skills: [{ slug: releaseSet?.[0]?.slug ?? "release-notes-helper", version: "1.0.0", managed: true, ...(observedDigest ? { digest: observedDigest } : {}) }],
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

test("update planning keeps the version and digest of a newer successful receipt together", async () => {
  const releases = rangeReleases().map((release, index) => ({
    ...release, artifact: { ...release.artifact, sha256: ["a", "e", "f"][index].repeat(64) },
  }));
  const { service, setNow } = fixture(undefined, releases, undefined, "a".repeat(64));
  setNow("2026-09-02T00:01:00.000Z");
  await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.0", idempotencyKey: "receipt-identity" });
  const claim = await service.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" });
  assert.ok(claim);
  const binding = { actorId: "owner-1", operationId: claim.operation.id, holderId: "companion-1", claimToken: claim.claimToken, fencingToken: claim.operation.fencingToken };
  await service.advance({ ...binding, state: "applying" });
  await service.advance({ ...binding, state: "verifying" });
  await service.complete({ ...binding, result: {
    status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.0",
    artifactSha256: "e".repeat(64), contentDigest: "d".repeat(64),
  } });
  const updates = await service.listUpdates({ id: "owner-1", roles: [] }, target.id);
  assert.equal(updates.items[0]?.evaluation.installedVersion, "1.1.0");
  assert.equal(updates.items[0]?.evaluation.status, "update-available");
  assert.equal(updates.items[0]?.evaluation.candidate?.version, "1.1.1");
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

const organizationTarget: ArchitectureTargetRecord = { ...target, owner: { type: "organization", id: "org-1" } };

test("organization ceiling survives a wider target policy in planning and scheduling", async () => {
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: "owner-1", scopeType: "organization", scopeId: "org-1", expectedRevisionNumber: 0, policy: { allowedChangeKinds: ["fix"] } });
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { includePrerelease: true } });
  const { service } = fixture(policies, rangeReleases(), undefined, undefined, organizationTarget);
  const updates = await service.listUpdates({ id: "owner-1", roles: [] }, target.id);
  // The serialized envelope remains additive for shipped clients, while evaluation uses both policies.
  const envelope = JSON.parse(JSON.stringify(updates)) as typeof updates;
  assert.ok(envelope.policy);
  assert.ok(Object.hasOwn(envelope.policy, "policy"));
  assert.ok(Object.hasOwn(envelope.policy, "source"));
  assert.ok(Object.hasOwn(envelope.policy, "revision"));
  assert.equal(envelope.policy.source, "target");
  assert.equal(envelope.policy.policy.includePrerelease, true);
  assert.equal(envelope.policy.revision?.scopeType, "target");
  assert.equal(envelope.policy.revision?.revisionNumber, 1);
  assert.deepEqual(envelope.policy.constraints.map(({ source, revision }) => [source, revision?.revisionNumber]), [["organization", 1], ["target", 1]]);
  assert.equal(envelope.policy.constraints[0]?.policy.includePrerelease, false);
  assert.equal(envelope.items[0]?.evaluation.status, "no-compatible-release");
  await assert.rejects(service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.1", idempotencyKey: "org-range" }), errorCode("TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED"));
  const prerelease = rangeReleases().map((release) => ({ ...release, version: release.version === "1.1.1" ? "2.0.0-rc.1" : release.version }));
  await assert.rejects(fixture(policies, prerelease, undefined, undefined, organizationTarget).service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "2.0.0-rc.1", idempotencyKey: "org-prerelease" }), errorCode("TARGET_OPERATION_POLICY_PRERELEASE_BLOCKED"));
  await policies.append({ actorUserId: "owner-1", scopeType: "organization", scopeId: "org-1", expectedRevisionNumber: 1, policy: { pins: { "release-notes-helper": "1.1.0" } } });
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 1, policy: { pins: { "release-notes-helper": "1.1.1" } } });
  assert.deepEqual((await service.listUpdates({ id: "owner-1", roles: [] }, target.id)).items[0]?.evaluation.blockers, ["policy-pin-conflict"]);
  await assert.rejects(service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.1", idempotencyKey: "org-pin" }), errorCode("TARGET_OPERATION_POLICY_PIN_CONFLICT"));
});

test("current organization ceiling is rechecked at every memory execution boundary", async (t) => {
  for (const boundary of ["claim", "apply", "renew", "verify", "complete"] as const) await t.test(boundary, async () => {
    const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
    await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: {} });
    const { service } = fixture(policies, undefined, undefined, undefined, organizationTarget);
    await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.0", idempotencyKey: boundary });
    const claimed = boundary === "claim" ? null : await service.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" });
    const binding = { actorId: "owner-1", operationId: "operation-1", holderId: "companion-1", claimToken: claimed?.claimToken ?? "", fencingToken: claimed?.operation.fencingToken ?? 0 };
    if (["renew", "verify", "complete"].includes(boundary)) await service.advance({ ...binding, state: "applying" });
    if (boundary === "complete") await service.advance({ ...binding, state: "verifying" });
    await policies.append({ actorUserId: "owner-1", scopeType: "organization", scopeId: "org-1", expectedRevisionNumber: 0, policy: { pins: { "release-notes-helper": "1.0.0" } } });
    if (boundary === "claim") {
      assert.equal(await service.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" }), null);
    } else if (boundary === "complete") {
      await assert.rejects(service.complete({ ...binding, result: { status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.0", artifactSha256: "e".repeat(64), contentDigest: "f".repeat(64) } }), errorCode("TARGET_OPERATION_POLICY_CHANGED"));
      assert.equal((await service.complete({ ...binding, result: { status: "failed", code: "operation.policy-changed" } })).state, "failed");
    } else await assert.rejects(service.advance({ ...binding, state: boundary === "verify" ? "verifying" : "applying" }), errorCode("TARGET_OPERATION_POLICY_CHANGED"));
  });
});

test("organization windows constrain a manual target at every memory execution boundary", async (t) => {
  for (const boundary of ["claim", "apply", "renew", "verify", "complete"] as const) await t.test(boundary, async () => {
    const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
    await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { mode: "manual" } });
    const { service, store } = fixture(policies, undefined, undefined, undefined, organizationTarget);
    const scheduled = await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "release-notes-helper", version: "1.1.0", idempotencyKey: boundary });
    const claimInput = { actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" };
    const claimed = boundary === "claim" ? null : await service.claim(claimInput);
    if (boundary !== "claim") assert.ok(claimed);
    const binding = { actorId: "owner-1", operationId: scheduled.operation.id, holderId: "companion-1", claimToken: claimed?.claimToken ?? "", fencingToken: claimed?.operation.fencingToken ?? 0 };
    if (["renew", "verify", "complete"].includes(boundary)) await service.advance({ ...binding, state: "applying" });
    if (boundary === "complete") await service.advance({ ...binding, state: "verifying" });
    const before = await store.get(scheduled.operation.id);
    await policies.append({ actorUserId: "owner-1", scopeType: "organization", scopeId: "org-1", expectedRevisionNumber: 0, policy: { mode: "maintenance-window", maintenanceWindow: { timeZone: "UTC", daysOfWeek: [3], startMinute: 60, durationMinutes: 60 } } });
    if (boundary === "claim") assert.equal(await service.claim(claimInput), null);
    else await assert.rejects(boundary === "complete"
      ? service.complete({ ...binding, result: { status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.0", artifactSha256: "e".repeat(64), contentDigest: "f".repeat(64) } })
      : service.advance({ ...binding, state: boundary === "verify" ? "verifying" : "applying" }), errorCode("TARGET_OPERATION_OUTSIDE_MAINTENANCE_WINDOW"));
    assert.deepEqual(await store.get(scheduled.operation.id), before, "closed windows must preserve state, lease, and fence");
    if (boundary === "complete") assert.equal((await service.complete({ ...binding, result: { status: "failed", code: "operation.window-closed" } })).state, "failed");
  });
});

test("claims require the intersection of organization and target windows in different zones", async () => {
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: "owner-1", scopeType: "organization", scopeId: "org-1", expectedRevisionNumber: 0, policy: { mode: "maintenance-window", maintenanceWindow: { timeZone: "UTC", daysOfWeek: [3], startMinute: 0, durationMinutes: 60 } } });
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { mode: "maintenance-window", maintenanceWindow: { timeZone: "America/New_York", daysOfWeek: [2], startMinute: 1200, durationMinutes: 60 } } });
  const open = fixture(policies, undefined, undefined, undefined, organizationTarget).service;
  const request = { actorId: "owner-1", targetId: target.id, action: "update" as const, slug: "release-notes-helper", version: "1.1.0", idempotencyKey: "window-intersection" };
  await open.schedule(request);
  assert.ok(await open.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" }));
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 1, policy: { mode: "maintenance-window", maintenanceWindow: { timeZone: "UTC", daysOfWeek: [3], startMinute: 60, durationMinutes: 60 } } });
  const closed = fixture(policies, undefined, undefined, undefined, organizationTarget).service;
  await closed.schedule(request);
  assert.equal(await closed.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" }), null);
});

test("constructor is a valid unpinned skill through preview and every memory execution boundary", async () => {
  assert.equal(parseSkillManifest({ name: "constructor", title: "Constructor", summary: "Pin lookup fixture", version: "1.1.0", license: "Apache-2.0", platforms: [{ name: "codex", install_target: "codex-skill" }] }).name, "constructor");
  const policies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: {} });
  const { service } = fixture(policies, rangeReleases().map((release) => ({ ...release, slug: "constructor" })));
  assert.equal((await service.listUpdates({ id: "owner-1", roles: [] }, target.id)).items[0]?.evaluation.status, "update-available");
  await service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "constructor", version: "1.1.0", idempotencyKey: "constructor" });
  const claimed = await service.claim({ actorId: "owner-1", targetId: target.id, targetGeneration: target.generation, holderId: "companion-1" });
  assert.ok(claimed);
  const binding = { actorId: "owner-1", operationId: claimed.operation.id, holderId: "companion-1", claimToken: claimed.claimToken, fencingToken: claimed.operation.fencingToken };
  await service.advance({ ...binding, state: "applying" });
  await service.advance({ ...binding, state: "applying" });
  await service.advance({ ...binding, state: "verifying" });
  assert.equal((await service.complete({ ...binding, result: { status: "succeeded", code: "operation.succeeded", installedVersion: "1.1.0", artifactSha256: "e".repeat(64), contentDigest: "f".repeat(64) } })).state, "succeeded");
  await policies.append({ actorUserId: "owner-1", scopeType: "target", scopeId: target.id, expectedRevisionNumber: 1, policy: { pins: { constructor: "1.0.0" } } });
  await assert.rejects(service.schedule({ actorId: "owner-1", targetId: target.id, action: "update", slug: "constructor", version: "1.1.1", idempotencyKey: "explicit-pin" }), errorCode("TARGET_OPERATION_POLICY_PIN_CONFLICT"));
});

function errorCode(expected: string) { return (error: unknown) => error instanceof Error && "code" in error && error.code === expected; }
