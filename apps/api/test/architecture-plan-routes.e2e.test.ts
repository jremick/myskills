import assert from "node:assert/strict";
import test from "node:test";
import { createArchitecturePlanFixture } from "./fixtures/architecture-plan-fixture.js";

// Test first: real HTTP routes and domain authorities must retain immutable exact
// intent and reject changed review fences. No fixture executor or target writer.
test("architecture plan journey retains mixed-revision topology, explicit review and immutable history", async t => {
  const f = await createArchitecturePlanFixture(t);
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  const create = (payload = f.request, token = f.sessions.owner) => f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers: { authorization: `Bearer ${token}` }, payload });
  const beforeTargets = await f.targetStore.listTargets(f.ownerId);
  const beforeObservations = await f.targetStore.listObservations({ actor: f.ownerId, targetId: f.target.id });
  const created = await create();
  assert.equal(created.statusCode, 201, created.body);
  const run = created.json().run;
  assert.equal(run.identity.revisionId, f.revision.id);
  assert.deepEqual(run.steps.map((step: { action: string }) => step.action).sort(), ["configure-router", "configure-router", "configure-router", "disable", "downgrade", "update"].sort());
  assert.equal(run.metadata.reviewOnly, true);
  assert.equal(run.metadata.dryRun, true);
  assert.equal(run.metadata.canApply, false);
  assert.equal(run.digests.observedDigest, f.request.expectedObservationDigest);
  assert.notEqual(run.metadata.reviewDigest, run.digests.planDigest);
  const serialized = JSON.stringify(run);
  assert.equal(serialized.includes("Synthetic architecture fixture."), false);
  assert.equal(/"(?:path|credentialReference|promptAwareness|spec)":/.test(serialized), false);
  const replay = await create();
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().replayed, true);
  assert.deepEqual(replay.json().run, run);
  const listed = await f.app.inject({ method: "GET", url: `/v1/architecture-targets/${f.target.id}/plans?limit=1`, headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().runs, [run]);
  const approve = (digest: string, token = f.sessions.owner) => f.app.inject({ method: "POST", url: `/v1/architecture-plans/${run.identity.runId}/approve`, headers: { authorization: `Bearer ${token}` }, payload: { expectedReviewDigest: digest } });
  assert.equal((await approve(run.digests.planDigest)).statusCode, 409);
  assert.equal((await approve(run.metadata.reviewDigest, f.sessions.plain)).statusCode, 403);
  const approvals = await Promise.all([approve(run.metadata.reviewDigest), approve(run.metadata.reviewDigest), approve(run.metadata.reviewDigest)]);
  for (const response of approvals) assert.equal(response.statusCode, 200, response.body);
  const approved = approvals[0].json().run;
  assert.equal(approved.state, "approved");
  assert.equal(approved.receipts.filter((receipt: { kind: string }) => receipt.kind === "approval").length, 1);
  assert.equal(approved.approval.metadata.reviewDigest, run.metadata.reviewDigest);
  assert.deepEqual(approved.steps, run.steps);
  await assert.rejects(f.syncStore.saveRun({ ...approved, metadata: { ...approved.metadata, reviewDigest: "f".repeat(64) } }), (error: unknown) => (error as { code?: string }).code === "ARCHITECTURE_SYNC_DIGEST_CONFLICT");
  assert.deepEqual(await f.targetStore.listTargets(f.ownerId), beforeTargets);
  assert.deepEqual(await f.targetStore.listObservations({ actor: f.ownerId, targetId: f.target.id }), beforeObservations);
  assert.equal(await f.syncStore.getCurrentLease(f.target.id), null);
  await f.targetService.revokeTarget({ actor: f.ownerId, targetId: f.target.id });
  const retained = await f.app.inject({ method: "GET", url: `/v1/architecture-plans/${run.identity.runId}`, headers });
  assert.equal(retained.statusCode, 200, retained.body);
  assert.deepEqual(retained.json().run, approved);
  assert.equal((await approve(run.metadata.reviewDigest)).statusCode, 410);
  assert.deepEqual(await f.syncStore.getRun(run.identity.runId), approved);
  t.diagnostic(JSON.stringify({ journey: "architecture-plan-api", topologyDepth: 3, mixedRevisions: true, profileDenial: true, immutableApproval: true, concurrentReplay: true, retainedAfterRevoke: true, targetWrites: 0, evidence: "memory-authorities" }));
});

test("architecture plan routes reject malformed input and unauthorized history before metadata writes", async t => {
  const f = await createArchitecturePlanFixture(t);
  const createUrl = `/v1/architecture-targets/${f.target.id}/plans`;
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  for (const payload of [{ ...f.request, apply: true }, { ...f.request, expectedObservationDigest: "bad" }, { ...f.request, revisionId: "../escape" }, { ...f.request, expectedTargetGeneration: 0 }, { ...f.request, idempotencyKey: "" }]) {
    const response = await f.app.inject({ method: "POST", url: createUrl, headers, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  for (const method of ["GET", "POST"] as const) {
    const response = await f.app.inject({ method, url: createUrl, headers: { authorization: `Bearer ${f.sessions.outsider}` }, ...(method === "POST" ? { payload: f.request } : {}) });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.body.includes(f.target.id), false);
  }
  assert.deepEqual(await f.syncStore.listRuns({ targetId: f.target.id }), []);
  assert.deepEqual(await f.syncStore.listAuditEvents(), []);
  const created = await f.app.inject({ method: "POST", url: createUrl, headers, payload: f.request });
  assert.equal(created.statusCode, 201, created.body);
  const run = created.json().run;
  const forbidden = await f.app.inject({ method: "GET", url: `/v1/architecture-plans/${run.identity.runId}`, headers: { authorization: `Bearer ${f.sessions.outsider}` } });
  assert.equal(forbidden.statusCode, 404);
  assert.equal(forbidden.body.includes(run.identity.runId), false);
  assert.equal((await f.app.inject({ method: "GET", url: `${createUrl}?limit=501`, headers })).statusCode, 400);
});

test("architecture plan approval rejects newer observations, changed profile policy and withdrawn release access", async t => {
  const f = await createArchitecturePlanFixture(t);
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  async function draft(key: string, observation = f.request) {
    const response = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers, payload: { ...observation, idempotencyKey: key } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().run;
  }
  const approve = (run: { identity: { runId: string }; metadata: { reviewDigest: string } }) => f.app.inject({ method: "POST", url: `/v1/architecture-plans/${run.identity.runId}/approve`, headers, payload: { expectedReviewDigest: run.metadata.reviewDigest } });
  const stale = await draft("stale-observation");
  const observation = await f.appendObservation();
  const observationInput = { ...f.request, expectedObservationId: observation.id!, expectedObservationDigest: observation.observedDigest };
  const denial = await approve(stale);
  assert.equal(denial.statusCode, 409, denial.body);
  assert.equal(denial.json().error.code, "ARCHITECTURE_PLAN_OBSERVATION_STALE");
  assert.deepEqual(await f.syncStore.getRun(stale.identity.runId), stale);
  const policy = await draft("stale-policy", observationInput);
  const revised = structuredClone(f.spec);
  revised.profiles[0].bindings = revised.profiles[0].bindings.map(binding => binding.nodeId === "leaf-plan-denied" ? { ...binding, enabled: true, runtimeExposure: "leaf" as const } : binding);
  await f.architectureStore.createRevision({ actor: f.ownerId, architectureId: f.spec.id, expectedCurrentRevisionId: f.revision.id, message: "Changes selected profile policy", spec: revised });
  const policyDenial = await approve(policy);
  assert.equal(policyDenial.statusCode, 409, policyDenial.body);
  assert.equal(policyDenial.json().error.code, "ARCHITECTURE_PLAN_POLICY_STALE");
  assert.deepEqual(await f.syncStore.getRun(policy.identity.runId), policy);
  const releases = await draft("stale-release", observationInput);
  await f.skillRepository.updateSkillSharing({ actor: { id: f.ownerId, roles: ["user"] }, slug: "plan-alpha", visibility: "private" });
  const releaseDenial = await approve(releases);
  assert.equal(releaseDenial.statusCode, 422, releaseDenial.body);
  assert.equal(releaseDenial.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
  assert.deepEqual(await f.syncStore.getRun(releases.identity.runId), releases);
});

test("architecture review fences reject changed target generation, capabilities and consent without rewriting a draft", async t => {
  const f = await createArchitecturePlanFixture(t);
  const headers = { authorization: `Bearer ${f.sessions.owner}` };
  for (const [name, change, code] of [
    ["generation", (target: typeof f.target) => ({ ...target, generation: target.generation + 1 }), "ARCHITECTURE_PLAN_GENERATION_STALE"],
    ["capabilities", (target: typeof f.target) => ({ ...target, capabilities: { ...target.capabilities, "health.read": false } }), "ARCHITECTURE_PLAN_CAPABILITIES_STALE"],
    ["consent", (target: typeof f.target) => ({ ...target, consent: { ...target.consent, status: "denied" as const } }), "ARCHITECTURE_PLAN_CONSENT_REQUIRED"],
  ] as const) {
    const draft = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers, payload: { ...f.request, idempotencyKey: `fence-${name}` } });
    assert.equal(draft.statusCode, 201, draft.body);
    const run = draft.json().run;
    const read = f.targetStore.getTarget.bind(f.targetStore);
    f.targetStore.getTarget = async (actor, id) => { const target = await read(actor, id); return target ? change(target) : null; };
    const response = await f.app.inject({ method: "POST", url: `/v1/architecture-plans/${run.identity.runId}/approve`, headers, payload: { expectedReviewDigest: run.metadata.reviewDigest } });
    f.targetStore.getTarget = read;
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.code, code);
    assert.deepEqual(await f.syncStore.getRun(run.identity.runId), run);
  }
});


test("historical exposure denied by current ancestors is refused before review creation", async t => {
  const f = await createArchitecturePlanFixture(t);
  const denied = structuredClone(f.spec);
  denied.profiles[0].bindings = denied.profiles[0].bindings.map(binding => binding.nodeId === "leaf-plan-alpha" ? { ...binding, enabled: false, runtimeExposure: "disabled" as const } : binding);
  await f.architectureStore.createRevision({ actor: f.ownerId, architectureId: f.spec.id, expectedCurrentRevisionId: f.revision.id, message: "Current exposure denial", spec: denied });
  const response = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers: { authorization: `Bearer ${f.sessions.owner}` }, payload: { ...f.request, idempotencyKey: "historical-denial" } });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "ARCHITECTURE_PLAN_POLICY_STALE");
  assert.deepEqual(await f.syncStore.listRuns({ targetId: f.target.id }), []);
});

test("review-only purpose refuses lease and apply without changing the journal", async t => {
  const f = await createArchitecturePlanFixture(t);
  const created = await f.planService.createPlan({ id: f.ownerId, mfaVerified: true }, f.target.id, f.request);
  const approved = await f.planService.approvePlan({ id: f.ownerId, mfaVerified: true }, created.run.identity.runId, { expectedReviewDigest: String(created.run.metadata?.reviewDigest) });
  const lease = { runId: approved.run.identity.runId, targetId: f.target.id, targetGeneration: f.target.generation, holderId: "forbidden", now: new Date().toISOString(), leaseSeconds: 30 };
  await assert.rejects(f.syncStore.claimApply(lease), /review-only/);
  await assert.rejects(f.syncStore.acquireLease(lease), /review-only/);
  assert.equal(await f.syncStore.getCurrentLease(f.target.id), null);
  assert.deepEqual(await f.syncStore.getRun(lease.runId), approved.run);
});


test("personal owner authority cannot bypass a receiving organization's revoked grant", async t => {
  const f = await createArchitecturePlanFixture(t);
  const read = f.targetStore.getTarget.bind(f.targetStore);
  f.targetStore.getTarget = async (actor, id) => {
    const target = await read(actor, id);
    return target ? { ...target, owner: { type: "organization", id: "receiving-org" } } : null;
  };
  const response = await f.app.inject({ method: "POST", url: `/v1/architecture-targets/${f.target.id}/plans`, headers: { authorization: `Bearer ${f.sessions.owner}` }, payload: f.request });
  assert.equal(response.statusCode, 404, response.body);
  assert.equal(response.json().error.code, "ARCHITECTURE_TARGET_NOT_FOUND");
  assert.deepEqual(await f.syncStore.listRuns({ targetId: f.target.id }), []);
});
