import assert from "node:assert/strict";
import test from "node:test";
import { architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest } from "@myskills-app/core";
import { createArchitecturePlanFixture } from "./fixtures/architecture-plan-fixture.js";
import { legacyArchitecturePlanCreation } from "./fixtures/legacy-architecture-plan.js";

test("pre-correction nonempty review creation replays exact stored IDs and digests under current authority", async t => {
  const f = await createArchitecturePlanFixture(t);
  const create = f.syncStore.createRun.bind(f.syncStore);
  f.syncStore.createRun = input => create(legacyArchitecturePlanCreation(input));
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  const request = () => f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers, payload: f.request });
  const seeded = await request();
  assert.equal(seeded.statusCode, 201, seeded.body);
  f.syncStore.createRun = create;
  const original = seeded.json().run;
  assert.ok(original.steps.length > 0);
  assert.deepEqual(original.steps.map((step: { id: string }) => step.id), original.steps.map((_step: unknown, index: number) => `step-${index + 1}`));
  const replay = await request();
  assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().run, original); assert.deepEqual(await f.syncStore.getRun(original.identity.runId), original);
  const revision = await f.architectureStore.createRevision({ actor: f.ownerId, architectureId: f.spec.id, expectedCurrentRevisionId: f.revision.id, message: "Changed immutable revision", spec: f.spec });
  assert.ok(revision);
  const changed = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers, payload: { ...f.request, revisionId: revision.id } });
  assert.equal(changed.statusCode, 409, changed.body);
  const denied = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers: { authorization: `Bearer ${f.sessions.plain}` }, payload: f.request });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.deepEqual(await f.syncStore.getRun(original.identity.runId), original);
});

// Two supported Codex instances need distinct physical bindings, observations,
// approvals and lifecycle history. Sharing logical context must never share a
// receipt, approval or revocation. This is memory-API proof, not host execution.
test("two explicit Codex instance review histories preserve placement and independent revocation", async t => {
  const f = await createArchitecturePlanFixture(t);
  const registered = await f.targetService.registerTarget({ actor: f.ownerId, name: "Second isolated Codex instance", architectureId: f.target.architectureId, profileId: f.target.profileId, environmentId: f.target.environmentId, adapter: f.target.adapter, capabilities: f.target.capabilities });
  const second = await f.targetService.setConsent({ actor: f.ownerId, targetId: registered.id, decision: "grant" });
  const firstObservation = (await f.targetService.listObservations(f.ownerId, f.target.id, 1))[0];
  const secondObservation = await f.targetService.appendObservation({ actor: f.ownerId, targetId: second.id, observation: { schemaVersion: 1, id: "second-instance-observation", targetId: second.id, targetGeneration: second.generation, adapterDigest: architectureTargetAdapterDigest(second.adapter), capabilitiesDigest: architectureTargetCapabilitiesDigest(second.capabilities, second.adapter.contractVersion), observedAt: "2026-09-30T01:00:00Z", skills: firstObservation.skills, configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } } });
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  const create = (id: string, body: unknown) => f.app.inject({ method: "POST", url: `/v1/architecture-targets/${id}/plans`, headers, payload: body });
  const secondRequest = { ...f.request, expectedTargetGeneration: second.generation, expectedObservationId: secondObservation.id, expectedObservationDigest: secondObservation.observedDigest };
  const [one, two] = await Promise.all([create(f.target.id, f.request), create(second.id, secondRequest)]);
  assert.equal(one.statusCode, 201, one.body); assert.equal(two.statusCode, 201, two.body);
  const firstRun = one.json().run; const secondRun = two.json().run;
  assert.notEqual(firstRun.identity.runId, secondRun.identity.runId);
  assert.equal(firstRun.identity.targetId, f.target.id); assert.equal(secondRun.identity.targetId, second.id);
  assert.notEqual(firstRun.metadata.reviewDigest, secondRun.metadata.reviewDigest);
  const wrongApproval = await f.app.inject({ method: "POST", url: `/v1/architecture-plans/${secondRun.identity.runId}/approve`, headers, payload: { expectedReviewDigest: firstRun.metadata.reviewDigest } });
  assert.equal(wrongApproval.statusCode, 409, wrongApproval.body);
  await f.targetService.revokeTarget({ actor: f.ownerId, targetId: f.target.id });
  const revokedApproval = await f.app.inject({ method: "POST", url: `/v1/architecture-plans/${firstRun.identity.runId}/approve`, headers, payload: { expectedReviewDigest: firstRun.metadata.reviewDigest } });
  assert.equal(revokedApproval.statusCode, 410, revokedApproval.body);
  const approvedSecond = await f.app.inject({ method: "POST", url: `/v1/architecture-plans/${secondRun.identity.runId}/approve`, headers, payload: { expectedReviewDigest: secondRun.metadata.reviewDigest } });
  assert.equal(approvedSecond.statusCode, 200, approvedSecond.body);
  assert.equal(approvedSecond.json().run.state, "approved");
  const history = async (id: string) => (await f.app.inject({ method: "GET", url: `/v1/architecture-targets/${id}/plans`, headers })).json().runs;
  assert.deepEqual(await history(f.target.id), [firstRun]);
  assert.deepEqual((await history(second.id)).map((run: { identity: { runId: string } }) => run.identity.runId), [secondRun.identity.runId]);
  assert.equal(await f.syncStore.getCurrentLease(f.target.id), null);
  assert.equal(await f.syncStore.getCurrentLease(second.id), null);
  t.diagnostic(JSON.stringify({ journey: "two-codex-review-instances", distinctPlacement: true, approvalIsolated: true, lifecycleIsolated: true, targetExecution: false }));
});
