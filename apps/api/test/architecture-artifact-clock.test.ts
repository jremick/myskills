import assert from "node:assert/strict";
import test from "node:test";
import { AppError, artifactHash } from "@myskills-app/core";
import { createArchitectureArtifactFixture } from "./fixtures/architecture-artifact-fixture.js";

// Calendar position must not determine lease validity. Exercise real composed
// consumption and exact expiry, rather than inspecting fixture constructor options.
for (const [label, timestamp] of [["historical", "2000-01-01T08:14:00.000Z"], ["future", "2100-01-01T08:14:00.000Z"]]) {
  test(`${label} artifact fixture clock permits current receipts and denies expired rollback consumption`, async t => {
    const f = await createArchitectureArtifactFixture(t);
    f.setTime(timestamp);
    const review = await f.review();
    const candidate = await f.artifacts.prepare(f.actor, f.target.id, { reviewRunId: review.identity.runId, baselineRunId: null, idempotencyKey: `clock-${label}` });
    const id = candidate.run.identity.runId;
    const input = { expectedIntentDigest: candidate.intentDigest, treeDigest: candidate.intent.treeDigest, baselineDigest: candidate.intent.baselineDigest };
    await f.artifacts.approve(f.actor, id, input);
    const claim = await f.artifacts.claim(f.actor, id, { holderId: "clock-holder", expectedIntentDigest: candidate.intentDigest });
    assert.equal(claim.decision, "claimed");
    assert.equal(claim.run.lease!.acquiredAt, timestamp);
    assert.equal(Date.parse(claim.run.lease!.expiresAt) - Date.parse(timestamp), 600_000);
    assert.deepEqual(await f.store.getCurrentLease(f.target.id), claim.run.lease);
    const fence = { holderId: "clock-holder", fencingToken: claim.run.lease!.fencingToken };
    f.advance(599_999);
    await f.artifacts.checkpoint(f.actor, id, fence);
    const accepted = await f.artifacts.receipt(f.actor, id, { ...fence, treeDigest: candidate.intent.treeDigest });
    assert.equal(accepted.run.state, "succeeded");
    assert.equal(accepted.run.updatedAt, new Date(Date.parse(timestamp) + 599_999).toISOString());
    assert.equal(await f.store.getCurrentLease(f.target.id), null);

    const rollback = await f.artifacts.rollback(f.actor, id, { ...input, holderId: "clock-rollback" });
    const rollbackFence = { holderId: "clock-rollback", fencingToken: rollback.run.lease!.fencingToken };
    assert.ok(rollbackFence.fencingToken > fence.fencingToken);
    assert.deepEqual(await f.store.getCurrentLease(f.target.id), rollback.run.lease);
    f.setTime(new Date(Date.parse(rollback.run.lease!.expiresAt) - 1).toISOString());
    await f.artifacts.checkpoint(f.actor, id, rollbackFence);
    const before = await f.store.getRun(id);
    f.advance(1);
    assert.equal(await f.store.getCurrentLease(f.target.id), null, "the store must expire the lease at the authority clock boundary");
    const denied = (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_ARTIFACT_FENCE_LOST";
    await assert.rejects(f.artifacts.checkpoint(f.actor, id, rollbackFence), denied);
    await assert.rejects(f.artifacts.receipt(f.actor, id, { ...rollbackFence, treeDigest: artifactHash([]) }), denied);
    assert.deepEqual(await f.store.getRun(id), before, "expired consumption cannot append receipts or advance the run");
  });
}
