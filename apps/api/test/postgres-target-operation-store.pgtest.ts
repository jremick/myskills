import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { architectureTargetCapabilitiesDigest, assertValidArchitectureTargetObservation, defaultSkillUpgradePolicyV1, skillUpgradePolicyDigest, targetSkillOperationPlanDigest } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { PostgresTargetSkillOperationStore } from "../src/target-operations/postgres-store.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";
import { PostgresSkillUpgradePolicyStore } from "../src/upgrade-policies/postgres-store.js";
import { PostgresArchitectureSyncStore } from "../src/architecture-sync/postgres-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import type { SubmissionService } from "../src/submissions/service.js";
import type { StoredTargetSkillOperation } from "../src/target-operations/types.js";

const now = new Date(Date.now() - 1_000).toISOString();
const later = new Date(Date.now() + 120_000).toISOString();
const owner = "11111111-1111-4111-8111-111111111111";
const member = "22222222-2222-4222-8222-222222222222";
const architecture = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const team = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const revision = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const observation = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const hash = "a".repeat(64);
const capabilities = { "inventory.read": true, "sync.write": true, apply: true, rollback: true };
const capabilitiesDigest = architectureTargetCapabilitiesDigest(capabilities, 2);
const migrationDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

test("production queue serializes target claims, verifies exact receipts, and replays after completion", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  const store = new PostgresTargetSkillOperationStore(db);
  const first = operation();
  const second = operation();
  await store.createBatch([{ operation: first }, { operation: second }]);
  const claimed = await Promise.all([store.claim(claim(first)), store.claim(claim(second))]);
  assert.equal(claimed.filter(Boolean).length, 1, "only one executor may own the target root");
  const winner = claimed.find((item) => item !== null)!;
  const binding = { ...claim(winner), fencingToken: winner.fencingToken };
  assert.equal(await store.complete({ ...binding, result: result() }), null, "claimed cannot report success");
  await store.advance({ ...binding, state: "applying" });
  assert.equal(await store.complete({ ...binding, result: result() }), null, "applying cannot report success");
  assert.equal((await store.advance({ ...binding, state: "applying" }))?.state, "applying", "promotion preflight renews its lease");
  await store.advance({ ...binding, state: "verifying" });
  for (const invalid of [{ ...result(), installedVersion: "9.9.9" }, { ...result(), artifactSha256: "b".repeat(64) }, { ...result(), contentDigest: undefined }]) {
    assert.equal(await store.complete({ ...binding, result: invalid }), null);
  }
  assert.equal((await store.complete({ ...binding, result: result() }))?.state, "succeeded");
  const service = serviceFor(db, store);
  const original = winner.id === first.id ? first : second;
  const replay = await service.schedule({ actorId: owner, targetId: target, action: "update", slug: original.skillSlug, version: "1.1.0", idempotencyKey: original.idempotencyKey });
  assert.equal(replay.replayed, true);
  assert.equal(replay.operation.id, original.id);
  assert.equal(replay.operation.state, "succeeded");
  await pool.query(`INSERT INTO target_skill_operations (target_id,target_generation,actor_user_id,action,skill_slug,from_version,to_version,platform,artifact_sha256,artifact_byte_size,artifact_content_type,plan_digest,state,idempotency_key)
    SELECT target_id,target_generation,actor_user_id,action,'other-skill',from_version,to_version,platform,artifact_sha256,artifact_byte_size,artifact_content_type,plan_digest,'cancelled',gen_random_uuid()::text
    FROM target_skill_operations CROSS JOIN generate_series(1,101) WHERE id = $1`, [winner.id]);
  assert.equal((await store.listForTarget(target, 100)).some((item) => item.id === winner.id), false);
  const rollback = await service.schedule({ actorId: owner, targetId: target, action: "rollback", slug: "release-helper", version: "1.0.0", idempotencyKey: "rollback-after-long-history" });
  assert.equal(rollback.operation.fromVersion, "1.1.0", "planning uses the latest verified receipt even beyond the history page");
  await pool.query("UPDATE skill_architecture_targets SET generation = generation + 1 WHERE id = $1", [target]);
  assert.equal((await store.get(winner.id))?.targetGeneration, 1, "history does not prevent generation advancement");
  const audit = await pool.query("SELECT action FROM audit_events WHERE resource_id = $1", [winner.id]);
  assert.ok(audit.rows.some((row) => row.action === "target-operation.succeeded"));
});

test("production operation batches and audits commit together, including conflicting replays", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  const store = new PostgresTargetSkillOperationStore(db);
  const first = operation();
  await assert.rejects(store.createBatch([{ operation: first }, { operation: operation({ toVersion: "9.9.9" }) }]));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM target_skill_operations")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n, 0);
  const failing = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: () => { throw new Error("audit unavailable"); } });
  await assert.rejects(failing.create({ operation: first }), /audit unavailable/);
  assert.equal(await store.get(first.id), null);
  const [a, b] = await Promise.all([store.create({ operation: first }), store.create({ operation: { ...first, id: randomUUID() } })]);
  assert.equal([a, b].filter((item) => item.replayed).length, 1);
  await assert.rejects(store.create({ operation: { ...first, id: randomUUID(), toVersion: "1.2.0" } }), code("TARGET_OPERATION_IDEMPOTENCY_CONFLICT"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n, 1);
});

test("production queue denies private release widening and hides previously queued private metadata", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  const store = new PostgresTargetSkillOperationStore(db);
  const queued = operation();
  await store.create({ operation: queued });
  await pool.query("UPDATE skills SET visibility = 'private' WHERE slug = 'release-helper'");
  assert.equal(await store.canReadRelease(owner, queued), false, "personal skill ownership does not authorize a shared target");
  assert.equal(await store.canReadRelease(member, queued), false);
  assert.deepEqual(await serviceFor(db, store).list(member, target), []);
  await assert.rejects(store.claim(claim(queued)));
  await assert.rejects(store.cancel(queued.id, now, owner), code("TARGET_OPERATION_AUTHORIZATION_CHANGED"));
  await assert.rejects(store.create({ operation: operation() }));
});

test("production queue rechecks consent, policy, lifecycle, capabilities, source, and generation", { timeout: 60_000 }, async (t) => {
  const cases = [
    ["consent", "UPDATE skill_architecture_targets SET status = 'degraded', consent_status = 'denied', consent_denied_at = consent_requested_at, consent_granted_at = NULL WHERE id = $1"],
    ["generation", "UPDATE skill_architecture_targets SET generation = 2 WHERE id = $1"],
    ["lifecycle", "UPDATE skill_versions SET lifecycle_status = 'revoked'"],
    ["unpublish", "UPDATE skill_versions SET published_at = NULL"],
    ["capabilities", "UPDATE skill_architecture_targets SET capabilities = '{\"inventory.read\":true}'"],
  ];
  for (const [name, statement] of cases) await t.test(name!, async (sub) => {
    const { pool, db } = await fixture(sub);
    const store = new PostgresTargetSkillOperationStore(db);
    const op = operation();
    await store.create({ operation: op });
    const leased = await store.claim(claim(op));
    assert.ok(leased);
    await pool.query(statement!, statement!.includes("$1") ? [target] : []);
    await assert.rejects(store.advance({ ...claim(op), fencingToken: leased.fencingToken, state: "applying" }));
    assert.equal((await store.get(op.id))?.state, "claimed");
  });
  await t.test("policy pin and source observation", async (sub) => {
    const { pool, db } = await fixture(sub);
    const store = new PostgresTargetSkillOperationStore(db);
    const op = operation();
    await store.create({ operation: op });
    const policies = new PostgresSkillUpgradePolicyStore(db);
    await policies.append(policyInput(0, { ...defaultSkillUpgradePolicyV1, pins: { "release-helper": "1.0.0" } }));
    await assert.rejects(store.claim(claim(op)), code("TARGET_OPERATION_POLICY_CHANGED"));
    await policies.append(policyInput(1));
    await insertObservation(pool, randomUUID(), "1.2.0", later);
    assert.equal(await store.claim({ ...claim(op), now: later, leaseExpiresAt: new Date(Date.parse(later) + 60_000).toISOString() }), null);
    assert.equal((await store.get(op.id))?.state, "expired");
  });
});

test("production upgrade planning and atomic scheduling enforce every crossed published change", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  await insertRangeRelease(pool);
  await pool.query("UPDATE skill_versions SET change_kind = 'breaking', release_notes = 'Breaking migration' WHERE version = '1.1.0'");
  const store = new PostgresTargetSkillOperationStore(db);
  const service = serviceFor(db, store);
  await new PostgresSkillUpgradePolicyStore(db).append(policyInput(0, { ...defaultSkillUpgradePolicyV1, allowedChangeKinds: ["fix"] }));
  const updates = await service.listUpdates({ id: owner, roles: [] }, target);
  assert.equal(updates.items[0]?.evaluation.status, "no-compatible-release");
  assert.ok(updates.items[0]?.evaluation.blockers.includes("change-kind-not-allowed"));
  assert.deepEqual(updates.items[0]?.evaluation.includedReleases.map((release) => release.releaseNotes), ["Breaking migration", "Follow-up fix"]);
  await assert.rejects(service.schedule({ actorId: owner, targetId: target, action: "update", slug: "release-helper", version: "1.1.1", idempotencyKey: "range-blocked" }), code("TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED"));
  await insertRangeRelease(pool, "1.0.1");
  await assert.rejects(store.createBatch([{ operation: operation({ toVersion: "1.0.1" }) }, { operation: operation({ toVersion: "1.1.1" }) }]), code("TARGET_OPERATION_POLICY_CHANGED"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM target_skill_operations")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'target-operation.%'")).rows[0].n, 0);
  await insertObservation(pool, randomUUID(), "1.1.0", new Date().toISOString());
  assert.equal((await service.schedule({ actorId: owner, targetId: target, action: "update", slug: "release-helper", version: "1.1.1", idempotencyKey: "already-crossed" })).operation.fromVersion, "1.1.0", "the installed source release is outside the upgrade range");
});

test("production queue rechecks full-range policy at claim, promotion, renewal, verification, and success", { timeout: 60_000 }, async (t) => {
  for (const boundary of ["claim", "apply", "renew", "verify", "complete"] as const) await t.test(boundary, async (sub) => {
    const { pool, db } = await fixture(sub);
    await insertRangeRelease(pool);
    await pool.query("UPDATE skill_versions SET change_kind = 'breaking' WHERE version = '1.1.0'");
    const store = new PostgresTargetSkillOperationStore(db);
    const op = operation({ toVersion: "1.1.1" });
    await store.create({ operation: op });
    const leased = boundary === "claim" ? null : await store.claim(claim(op));
    const binding = { ...claim(op), fencingToken: leased?.fencingToken ?? 0 };
    if (boundary !== "claim" && boundary !== "apply") await store.advance({ ...binding, state: "applying" });
    if (boundary === "complete") await store.advance({ ...binding, state: "verifying" });
    const previous = (await store.get(op.id))?.state;
    await new PostgresSkillUpgradePolicyStore(db).append(policyInput(0, { ...defaultSkillUpgradePolicyV1, allowedChangeKinds: ["fix"] }));
    await assert.rejects(boundary === "claim" ? store.claim(claim(op))
      : boundary === "complete" ? store.complete({ ...binding, result: { ...result(), installedVersion: "1.1.1" } })
        : store.advance({ ...binding, state: boundary === "verify" ? "verifying" : "applying" }), code("TARGET_OPERATION_POLICY_CHANGED"));
    assert.equal((await store.get(op.id))?.state, previous);
    if (boundary === "claim") assert.equal(await serviceFor(db, store).claim({ actorId: owner, targetId: target, targetGeneration: 1, holderId: "poller" }), null);
    if (boundary !== "claim" && boundary !== "apply") {
      assert.equal((await store.complete({ ...binding, result: { status: "failed", code: "operation.policy-changed", recordedAt: now } }))?.state, "failed");
    }
  });
});

test("withdrawn and unsafe intermediate releases remain policy evidence without exposing their metadata", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  await insertRangeRelease(pool);
  await new PostgresSkillUpgradePolicyStore(db).append(policyInput(0, { ...defaultSkillUpgradePolicyV1, allowedChangeKinds: ["fix"] }));
  const store = new PostgresTargetSkillOperationStore(db);
  const service = serviceFor(db, store);
  const submissions = new PostgresSubmissionStore(db);
  for (const state of ["unpublished", "revoked", "deleted", "unsafe"]) {
    await pool.query(`UPDATE skill_versions SET change_kind = 'breaking', release_notes = 'Hidden release notes', lifecycle_status = $1,
      deleted_at = $2, security_status = $3 WHERE version = '1.1.0'`, [state === "deleted" ? "archived" : state === "unsafe" ? "approved" : state, state === "deleted" ? now : null, state === "unsafe" ? "failed" : "passed"]);
    const history = await submissions.listSkillReleaseChangeHistory({ slug: "release-helper", actorId: member });
    assert.deepEqual(history.find((release) => release.version === "1.1.0"), { version: "1.1.0", changeKind: "breaking" });
    const updates = await service.listUpdates({ id: member, roles: [] }, target);
    assert.equal(updates.items[0]?.evaluation.status, "no-compatible-release", state);
    assert.ok(updates.items[0]?.evaluation.blockers.includes("change-kind-not-allowed"), state);
    assert.deepEqual(updates.items[0]?.evaluation.includedReleases.map((release) => release.version), ["1.1.1"], state);
    assert.equal(JSON.stringify(updates).includes("Hidden release notes"), false, state);
    await assert.rejects(service.schedule({ actorId: owner, targetId: target, action: "update", slug: "release-helper", version: "1.1.1", idempotencyKey: state }), code("TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED"));
    await assert.rejects(store.create({ operation: operation({ toVersion: "1.1.1" }) }), code("TARGET_OPERATION_POLICY_CHANGED"));
  }
  await pool.query("UPDATE skills SET visibility = 'private' WHERE slug = 'release-helper'");
  assert.deepEqual(await submissions.listSkillReleaseChangeHistory({ slug: "release-helper", actorId: member }), []);
  assert.deepEqual((await service.listUpdates({ id: member, roles: [] }, target)).items, []);
});

test("production full-range checks lock intermediate metadata and new published versions through commit", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  await insertRangeRelease(pool);
  await pool.query("UPDATE skill_versions SET change_kind = 'fix'");
  await pool.query("INSERT INTO skill_versions (skill_id, version, change_kind) SELECT id, '1.0.2', 'breaking' FROM skills WHERE slug = 'release-helper'");
  await new PostgresSkillUpgradePolicyStore(db).append(policyInput(0, { ...defaultSkillUpgradePolicyV1, allowedChangeKinds: ["fix"] }));
  const op = operation({ toVersion: "1.1.1" });
  await new PostgresTargetSkillOperationStore(db).create({ operation: op });
  const entered = deferred(); const finish = deferred();
  const store = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: async () => { entered.resolve(); await finish.promise; } });
  const pending = store.claim(claim(op));
  await entered.promise;
  const writer = await pool.connect();
  try {
    await writer.query("SET lock_timeout = '50ms'");
    await assert.rejects(writer.query("UPDATE skill_versions SET change_kind = 'breaking' WHERE version = '1.1.0'"), code("55P03"));
    await assert.rejects(writer.query("UPDATE skill_versions SET published_at = clock_timestamp(), lifecycle_status = 'approved', review_status = 'approved', security_status = 'passed' WHERE version = '1.0.2'"), code("55P03"));
    await assert.rejects(writer.query("INSERT INTO skill_versions (skill_id, version, lifecycle_status, review_status, security_status, published_at, change_kind) SELECT id, '1.0.1', 'approved', 'approved', 'passed', clock_timestamp(), 'breaking' FROM skills WHERE slug = 'release-helper'"), code("55P03"));
  } finally { await writer.query("RESET lock_timeout"); writer.release(); finish.resolve(); }
  const leased = await pending;
  assert.ok(leased);
  await pool.query("UPDATE skill_versions SET change_kind = 'breaking' WHERE version = '1.1.0'");
  await assert.rejects(store.advance({ ...claim(op), fencingToken: leased.fencingToken, state: "applying" }), code("TARGET_OPERATION_POLICY_CHANGED"));
});

test("current membership is checked after preflight and held through operation audit commit", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  const gate = deferred();
  const entered = deferred();
  let pause = false;
  const store = new PostgresTargetSkillOperationStore(db, { beforeAuthorization: async () => { if (pause) { entered.resolve(); await gate.promise; } } });
  const op = operation();
  await store.create({ operation: op });
  pause = true;
  const pending = store.claim(claim(op));
  const rejection = assert.rejects(pending, code("TARGET_OPERATION_AUTHORIZATION_CHANGED"));
  await entered.promise;
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [team, owner]);
  gate.resolve();
  await rejection;
  assert.equal((await store.get(op.id))?.state, "queued");
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner')", [team, owner]);
  const audited = deferred();
  const finish = deferred();
  const protectedStore = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: async () => { audited.resolve(); await finish.promise; } });
  const protectedClaim = protectedStore.claim(claim(op));
  await audited.promise;
  const revoker = await pool.connect();
  try {
    await revoker.query("SET lock_timeout = '50ms'");
    await assert.rejects(revoker.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [team, owner]), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03"));
  } finally { await revoker.query("RESET lock_timeout"); revoker.release(); finish.resolve(); }
  assert.equal((await protectedClaim)?.state, "claimed");
});

test("policy mutation rechecks authority, audits atomically, and can restore an earlier policy", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  const store = new PostgresSkillUpgradePolicyStore(db);
  await store.append(policyInput(0));
  await store.append(policyInput(1, { ...defaultSkillUpgradePolicyV1, pins: { "release-helper": "1.0.0" } }));
  const restored = await store.append(policyInput(2));
  assert.equal(restored.revision.revisionNumber, 3);
  const failing = new PostgresSkillUpgradePolicyStore(db, { beforeAuditInsert: () => { throw new Error("audit unavailable"); } });
  await assert.rejects(failing.append(policyInput(3, { ...defaultSkillUpgradePolicyV1, includePrerelease: true })), /audit unavailable/);
  assert.equal((await store.getLatest("target", target))?.revisionNumber, 3);
  const gate = deferred();
  const entered = deferred();
  const delayed = new PostgresSkillUpgradePolicyStore(db, { beforeAuthorization: async () => { entered.resolve(); await gate.promise; } });
  const pending = delayed.append(policyInput(3, { ...defaultSkillUpgradePolicyV1, includePrerelease: true }));
  const rejected = assert.rejects(pending);
  await entered.promise;
  await pool.query("UPDATE team_memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2", [team, owner]);
  gate.resolve();
  await rejected;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'skill-upgrade-policy.append'")).rows[0].n, 3);
});

test("companion and architecture sync share a target mutex and monotonic fences in both directions", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  const runId = randomUUID();
  await insertSyncRun(pool, runId);
  const sync = new PostgresArchitectureSyncStore(db);
  const op = operation();
  const store = new PostgresTargetSkillOperationStore(db);
  await store.create({ operation: op });
  const entered = deferred();
  const gate = deferred();
  const delayed = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: async () => { entered.resolve(); await gate.promise; } });
  const queueClaim = delayed.claim(claim(op));
  await entered.promise;
  const syncInput = { runId, targetId: target, targetGeneration: 1, holderId: "sync-worker", now, leaseSeconds: 60 };
  const syncAttempt = sync.acquireLease(syncInput);
  const rejected = assert.rejects(syncAttempt, code("ARCHITECTURE_SYNC_LEASE_CONFLICT"));
  gate.resolve();
  assert.equal((await queueClaim)?.fencingToken, 1);
  await rejected;
  // Force the reverse interleaving: sync owns target and waits on its run row.
  await pool.query("UPDATE target_skill_operations SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [op.id]);
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT id FROM skill_architecture_sync_runs WHERE id = $1 FOR UPDATE", [runId]);
  const syncPending = sync.acquireLease({ ...syncInput, now: new Date().toISOString() });
  try {
    await waitForTargetLock(pool);
    const queuePending = store.claim({ ...claim(op), now: later, leaseExpiresAt: new Date(Date.parse(later) + 60_000).toISOString() });
    await blocker.query("COMMIT");
    assert.equal((await syncPending).fencingToken, 2);
    assert.equal(await queuePending, null);
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  await sync.releaseLease({ runId, targetId: target, fencingToken: 2 });
  const renewed = await store.claim({ ...claim(op), now: later, leaseExpiresAt: new Date(Date.parse(later) + 60_000).toISOString() });
  assert.equal(renewed?.fencingToken, 3);
  assert.equal(await store.advance({ ...claim(op), fencingToken: 1, state: "applying", now: later }), null, "expired fence cannot promote");
});


test("bounded queue polling reaches work behind more than 100 temporary blockers and wraps", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  const store = new PostgresTargetSkillOperationStore(db);
  const blocked = Array.from({ length: 101 }, (_, i) => operation({ createdAt: new Date(Date.parse(now) + i).toISOString(), updatedAt: new Date(Date.parse(now) + i).toISOString() }));
  await store.createBatch(blocked.map((operation) => ({ operation })));
  await insertObservation(pool, randomUUID(), "1.2.0", new Date().toISOString());
  const healthy = operation({ action: "rollback", fromVersion: "1.2.0", toVersion: "1.0.0", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await store.create({ operation: healthy });
  await new PostgresSkillUpgradePolicyStore(db).append(policyInput(0, { ...defaultSkillUpgradePolicyV1, pins: { "release-helper": "1.0.0" } }));
  const service = serviceFor(db, store);
  let winner = null;
  for (let poll = 0; poll < 12 && !winner; poll += 1) winner = await service.claim({ actorId: owner, targetId: target, targetGeneration: 1, holderId: "poller" });
  assert.equal(winner?.operation.id, healthy.id);
  const wrapped = await store.listClaimable(target, now, 10, owner);
  assert.equal(wrapped.length, 10);
  assert.equal(wrapped[0]?.id, blocked[0]?.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM target_skill_operations WHERE state = 'queued'")).rows[0].n, 101);
});

test("a stale source expires with audit instead of poisoning the next candidate", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t);
  const store = new PostgresTargetSkillOperationStore(db);
  const stale = operation();
  await store.create({ operation: stale });
  await insertObservation(pool, randomUUID(), "1.2.0", new Date().toISOString());
  const healthy = operation({ action: "rollback", fromVersion: "1.2.0", toVersion: "1.0.0", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await store.create({ operation: healthy });
  const winner = await serviceFor(db, store).claim({ actorId: owner, targetId: target, targetGeneration: 1, holderId: "poller" });
  assert.equal(winner?.operation.id, healthy.id);
  assert.equal((await store.get(stale.id))?.state, "expired");
  assert.equal((await pool.query("SELECT details->>'reason' AS reason FROM audit_events WHERE resource_id = $1 AND action = 'target-operation.expire'", [stale.id])).rows[0].reason, "source-changed");
});

test("delayed renewal and completion cannot revive a lease after a newer target fence", { timeout: 60_000 }, async (t) => {
  for (const state of ["applying", "verifying"] as const) await t.test(state, async (sub) => {
    const { pool, db } = await fixture(sub);
    const store = new PostgresTargetSkillOperationStore(db);
    const first = operation(); const second = operation();
    await store.createBatch([{ operation: first }, { operation: second }]);
    const leased = await store.claim(claim(first)); assert.ok(leased);
    const binding = { ...claim(first), fencingToken: leased.fencingToken };
    await store.advance({ ...binding, state: "applying" });
    if (state === "verifying") await store.advance({ ...binding, state: "verifying" });
    await pool.query("UPDATE target_skill_operations SET lease_expires_at = clock_timestamp() - interval '1 microsecond' WHERE id = $1", [first.id]);
    const entered = deferred(); const finish = deferred();
    const nextStore = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: async () => { entered.resolve(); await finish.promise; } });
    const newClaim = nextStore.claim(claim(second));
    await entered.promise;
    const delayed = state === "applying" ? store.advance({ ...binding, state }) : store.complete({ ...binding, result: result() });
    finish.resolve();
    assert.equal((await newClaim)?.fencingToken, 2);
    assert.equal(await delayed, null);
    // The global fence also rejects an older row even if an external repair extends its lease.
    await pool.query("UPDATE target_skill_operations SET lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1", [first.id]);
    assert.equal(state === "applying" ? await store.advance({ ...binding, state }) : await store.complete({ ...binding, result: result() }), null);
  });
});

test("queue protects absent sharing defaults and retries reverse-order sharing lock contention", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  await pool.query("DELETE FROM instance_settings WHERE key = 'sharing'");
  const base = new PostgresTargetSkillOperationStore(db);
  const op = operation(); await base.create({ operation: op });
  const auditEntered = deferred(); const auditFinish = deferred();
  const locked = new PostgresTargetSkillOperationStore(db, { beforeAuditInsert: async () => { auditEntered.resolve(); await auditFinish.promise; } });
  const pending = locked.claim(claim(op));
  await auditEntered.promise;
  const settings = await pool.connect();
  try {
    await settings.query("SET lock_timeout = '50ms'");
    await assert.rejects(settings.query("INSERT INTO instance_settings (key, value) VALUES ('sharing', '{\"publicVisibilityEnabled\":false}')"), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "55P03"));
  } finally { await settings.query("RESET lock_timeout"); auditFinish.resolve(); settings.release(); }
  assert.ok(await pending);
  // With no sharing row, a sharing writer can hold skill before requesting team.
  const absentWriter = await pool.connect();
  await absentWriter.query("BEGIN");
  await absentWriter.query("SELECT key FROM instance_settings WHERE key = 'sharing' FOR UPDATE");
  await absentWriter.query("SELECT id FROM skills WHERE slug = 'release-helper' FOR UPDATE");
  const absentEntered = deferred(); const absentFinish = deferred(); let absentAttempts = 0;
  const absentStore = new PostgresTargetSkillOperationStore(db, { beforeEligibility: async () => {
    absentAttempts += 1; if (absentAttempts === 1) { absentEntered.resolve(); await absentFinish.promise; }
  } });
  const absentRenewal = absentStore.advance({ ...claim(op), fencingToken: 1, state: "applying" });
  await absentEntered.promise;
  const absentTeamLock = absentWriter.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [team]);
  absentFinish.resolve();
  await absentTeamLock;
  await absentWriter.query("COMMIT"); absentWriter.release();
  assert.equal((await absentRenewal)?.state, "applying");
  assert.ok(absentAttempts >= 2);
  await pool.query("INSERT INTO instance_settings (key, value) VALUES ('sharing', '{}')");
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query("SELECT key FROM instance_settings WHERE key = 'sharing' FOR UPDATE");
  const entered = deferred(); const finish = deferred(); let attempts = 0;
  const retrying = new PostgresTargetSkillOperationStore(db, { beforeEligibility: async () => { attempts += 1; if (attempts === 1) { entered.resolve(); await finish.promise; } } });
  const renewal = retrying.advance({ ...claim(op), fencingToken: 1, state: "applying" });
  await entered.promise;
  const grantLock = blocker.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE", [team]);
  finish.resolve();
  await grantLock;
  await blocker.query("COMMIT"); blocker.release();
  assert.equal((await renewal)?.state, "applying");
  assert.ok(attempts >= 2, "NOWAIT rolls back the owner lock before retrying sharing authority");
});


test("mixed-team batch and third-target claim retry the entire contended transaction", { timeout: 60_000 }, async (t) => {
  const { pool, db } = await fixture(t, true);
  const team2 = randomUUID(); const architecture2 = randomUUID(); const target2 = randomUUID(); const target3 = randomUUID();
  await pool.query("INSERT INTO teams (id, slug, name, created_by_user_id) VALUES ($1, 'second-team', 'Second', $2)", [team2, owner]);
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner')", [team2, owner]);
  await pool.query("INSERT INTO skill_architectures (id, owner_team_id, name, pattern_id) VALUES ($1, $2, 'Second', 'flat')", [architecture2, team2]);
  for (const targetId of [target2, target3]) {
    await pool.query(`INSERT INTO skill_architecture_targets (id,architecture_id,owner_team_id,name,adapter_kind,adapter_contract_version,adapter_version,environment_id,profile_id,status,consent_status,consent_requested_at,consent_granted_at,capabilities,capabilities_digest,identity_digest,generation,created_by_user_id,created_at,updated_at)
      SELECT $1,$2,$3,name,adapter_kind,adapter_contract_version,adapter_version,environment_id,profile_id,status,consent_status,consent_requested_at,consent_granted_at,capabilities,capabilities_digest,identity_digest,generation,created_by_user_id,created_at,updated_at FROM skill_architecture_targets WHERE id = $4`, [targetId, architecture2, team2, target]);
    await insertObservation(pool, randomUUID(), "1.0.0", now, targetId);
  }
  const a1 = operation(); const a2 = operation({ targetId: target2 }); const b = operation({ targetId: target3 });
  await new PostgresTargetSkillOperationStore(db).create({ operation: b });
  const entered = deferred(); const finish = deferred(); let aAttempts = 0; let bAttempts = 0;
  const batchStore = new PostgresTargetSkillOperationStore(db, {
    beforeAuthorization: (op) => { if (op.id === a1.id) aAttempts += 1; },
    beforeAuditInsert: async () => { if (aAttempts === 1) { entered.resolve(); await finish.promise; } },
  });
  const claimant = new PostgresTargetSkillOperationStore(db, { beforeAuthorization: () => { bAttempts += 1; } });
  const batch = batchStore.createBatch([{ operation: a1 }, { operation: a2 }]);
  await entered.promise;
  const claimed = claimant.claim(claim(b));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await pool.query("SELECT id FROM teams WHERE id = $1 FOR UPDATE NOWAIT", [team2]); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") break;
      throw error;
    }
    if (attempt === 99) assert.fail("claim did not lock its team before waiting for the batch actor");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  finish.resolve();
  const [created, winner] = await Promise.all([batch, claimed]);
  assert.equal(created.length, 2); assert.equal(winner?.state, "claimed");
  assert.ok(aAttempts > 1 || bAttempts > 1, "the contended transaction must retry from current authority");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM target_skill_operations")).rows[0].n, 3);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'target-operation.schedule'")).rows[0].n, 3, "rolled-back attempts leave no partial audit or batch rows");
});

function operation(overrides: Partial<StoredTargetSkillOperation> = {}): StoredTargetSkillOperation {
  const plan = { targetId: target, targetGeneration: 1, action: "update" as const, skillSlug: "release-helper", fromVersion: "1.0.0", toVersion: "1.1.0", platform: "codex", artifact: { sha256: hash, byteSize: 123, contentType: "application/json" } };
  const value: StoredTargetSkillOperation = { schemaVersion: 1, ...plan, id: randomUUID(), actorUserId: owner, idempotencyKey: randomUUID(), state: "queued", fencingToken: 0, planDigest: targetSkillOperationPlanDigest(plan), createdAt: now, updatedAt: now, ...overrides };
  value.planDigest = targetSkillOperationPlanDigest(value);
  return value;
}
function claim(op: { id: string }) { return { actorId: owner, id: op.id, targetGeneration: 1, holderId: "companion-1", claimTokenHash: "b".repeat(64), leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(), now }; }
function result() { return { status: "succeeded" as const, code: "operation.succeeded", recordedAt: now, installedVersion: "1.1.0", artifactSha256: hash, contentDigest: "c".repeat(64) }; }
function policyInput(expectedRevisionNumber: number, policy = defaultSkillUpgradePolicyV1) { return { id: randomUUID(), scopeType: "target" as const, scopeId: target, actorUserId: owner, expectedRevisionNumber, policy, policySha256: skillUpgradePolicyDigest(policy), reason: "", createdAt: now }; }
function code(expected: string) { return (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
function serviceFor(db: ReturnType<typeof createDb>, store: PostgresTargetSkillOperationStore) {
  const targets = new ArchitectureTargetService(new PostgresArchitectureTargetStore(db), { authorizeBinding: async () => ({ allowed: false }) });
  const submissions = new PostgresSubmissionStore(db);
  return new TargetSkillOperationService(store, targets, { getPublicRelease: (input: Parameters<PostgresSubmissionStore["getPublicRelease"]>[0]) => submissions.getPublicRelease(input),
    listSkillReleases: (input: Parameters<PostgresSubmissionStore["listSkillReleases"]>[0]) => submissions.listSkillReleases(input),
    listSkillReleaseChangeHistory: (input: Parameters<PostgresSubmissionStore["listSkillReleaseChangeHistory"]>[0]) => submissions.listSkillReleaseChangeHistory(input),
  } as SubmissionService, { now: () => new Date(), upgradePolicies: new SkillUpgradePolicyService(new PostgresSkillUpgradePolicyStore(db)) });
}
async function fixture(t: test.TestContext, teamOwned = false) {
  const connection = process.env.TEST_DATABASE_URL;
  assert.ok(connection, "TEST_DATABASE_URL is required");
  assert.match(new URL(connection).pathname, /(test|ci)/i);
  const admin = createPgPool(connection);
  const schema = `queue_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(connection);
  scoped.searchParams.set("options", `-csearch_path=${schema},public`);
  const pool = createPgPool(scoped.toString());
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const name of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql") && name <= "0025_target_operation_safety.sql").sort()) await pool.query(readFileSync(`${migrationDirectory}/${name}`, "utf8"));
  await pool.query("INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, 'owner@example.test', 'owner@example.test', 'Owner', 'active', $3), ($2, 'member@example.test', 'member@example.test', 'Member', 'active', $3)", [owner, member, now]);
  if (teamOwned) {
    await pool.query("INSERT INTO teams (id, slug, name, created_by_user_id) VALUES ($1, 'test-team', 'Team', $2)", [team, owner]);
    await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [team, owner, member]);
  }
  await pool.query("INSERT INTO skill_architectures (id, owner_user_id, owner_team_id, name, pattern_id) VALUES ($1, $2, $3, 'Fixture', 'flat')", [architecture, teamOwned ? null : owner, teamOwned ? team : null]);
  await pool.query("INSERT INTO skill_architecture_revisions (id, architecture_id, revision_number, spec, created_by_user_id) VALUES ($1, $2, 1, '{\"schemaVersion\":1}', $3)", [revision, architecture, owner]);
  await pool.query(`INSERT INTO skill_architecture_targets (id, architecture_id, owner_user_id, owner_team_id, name, adapter_kind, adapter_contract_version, adapter_version, environment_id, profile_id, status, consent_status, consent_requested_at, consent_granted_at, capabilities, capabilities_digest, identity_digest, generation, created_by_user_id, created_at, updated_at)
    VALUES ($1,$2,$3,$4,'Companion','codex-workspace',2,'1.0.0','personal','default','connected','granted',$5,$5,$6,$7,$8,1,$9,$5,$5)`, [target, architecture, teamOwned ? null : owner, teamOwned ? team : null, now, capabilities, capabilitiesDigest, "d".repeat(64), owner]);
  await insertObservation(pool, observation, "1.0.0", now);
  const skill = await pool.query("INSERT INTO skills (slug,title,summary,lifecycle_status,visibility,owner_user_id) VALUES ('release-helper','Release helper','Fixture','approved','public',$1) RETURNING id", [owner]);
  for (const version of ["1.0.0", "1.1.0"]) {
    const release = await pool.query("INSERT INTO skill_versions (skill_id,version,lifecycle_status,review_status,security_status,published_at,change_kind) VALUES ($1,$2,'approved','approved','passed',$3,'feature') RETURNING id", [skill.rows[0].id, version, now]);
    await pool.query("INSERT INTO skill_artifacts (skill_version_id,storage_key,sha256,byte_size,content_type) VALUES ($1,$2,$3,123,'application/json')", [release.rows[0].id, `fixture/${version}`, hash]);
    await pool.query("INSERT INTO skill_platform_variants (skill_version_id,name,install_target,status) VALUES ($1,'codex','codex-skill','supported')", [release.rows[0].id]);
  }
  return { pool, db: createDb(pool) };
}
async function insertObservation(pool: ReturnType<typeof createPgPool>, id: string, version: string, captured: string, targetId = target) {
  const record = assertValidArchitectureTargetObservation({ schemaVersion: 1, id, targetId, targetGeneration: 1,
    adapterDigest: "e".repeat(64), capabilitiesDigest, observedAt: captured,
    skills: [{ slug: "release-helper", version, digest: hash, managed: true }], configFindings: [], promptAwareness: { detected: false, count: 0 } });
  await pool.query(`INSERT INTO skill_architecture_observations (id,target_id,generation,adapter_kind,adapter_contract_version,adapter_version,adapter_digest,capabilities_digest,observed_digest,observed_state,captured_at)
    VALUES ($1,$2,1,'codex-workspace',2,'1.0.0',$3,$4,$5,$6,$7)`, [id, targetId, "e".repeat(64), capabilitiesDigest, record.observedDigest, record, captured]);
}
async function insertRangeRelease(pool: ReturnType<typeof createPgPool>, version = "1.1.1") {
  const release = await pool.query("INSERT INTO skill_versions (skill_id,version,lifecycle_status,review_status,security_status,published_at,change_kind,release_notes) SELECT id,$2,'approved','approved','passed',$1,'fix','Follow-up fix' FROM skills WHERE slug = 'release-helper' RETURNING id", [now, version]);
  await pool.query("INSERT INTO skill_artifacts (skill_version_id,storage_key,sha256,byte_size,content_type) VALUES ($1,$3,$2,123,'application/json')", [release.rows[0].id, hash, `fixture/${version}`]);
  await pool.query("INSERT INTO skill_platform_variants (skill_version_id,name,install_target,status) VALUES ($1,'codex','codex-skill','supported')", [release.rows[0].id]);
}
async function insertSyncRun(pool: ReturnType<typeof createPgPool>, id: string) {
  await pool.query(`INSERT INTO skill_architecture_sync_runs (id,architecture_id,revision_id,target_id,target_generation,observed_snapshot_id,profile_id,environment_id,actor_user_id,run_kind,request_key,idempotency_key,desired_digest,compiled_digest,observed_digest,plan_digest,created_at,updated_at,status_updated_at)
    VALUES ($1,$2,$3,$4,1,$5,'default','personal',$6,'sync',($1::uuid)::text,($1::uuid)::text,$7,$7,$7,$7,$8,$8,$8)`, [id, architecture, revision, target, observation, owner, hash, now]);
}

async function waitForTargetLock(pool: ReturnType<typeof createPgPool>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await pool.query("SELECT id FROM skill_architecture_targets WHERE id = $1 FOR UPDATE NOWAIT", [target]); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "55P03") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("sync did not acquire the shared target mutex");
}
