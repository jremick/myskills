import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AppError, createFlatArchitecture, type ArchitectureSyncRun } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresArchitectureSyncStore } from "../src/architecture-sync/postgres-store.js";
import { ArchitecturePlanService } from "../src/architecture-sync/plan-service.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";
import { PostgresSkillUpgradePolicyStore } from "../src/upgrade-policies/postgres-store.js";

// Actual plan service, coherent production wrapper and independent PostgreSQL
// writers. No executor, provider, package-content read or filesystem mutation.
test("Postgres exact-revision review retains authority, rejects prior changes and rolls back partial approval", { timeout: 120_000 }, async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url);
  assert.match(new URL(url).pathname, /(^|[_/-])(test|ci)([_-]|$)/i);
  const pool = createPgPool(url);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);
  const actor = { id: randomUUID(), mfaVerified: true, artifactCredential:{kind:"session" as const,hash:hashSessionToken("pg-plan-session")} };
  await pool.query("INSERT INTO users(id,email,normalized_email,name,status,email_verified_at) VALUES($1,'plan@example.test','plan@example.test','Plan','active',now())", [actor.id]);
  const digest = "a".repeat(64);
  await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,mfa_verified_at) VALUES($1,$2,clock_timestamp()+interval '1 hour',clock_timestamp())",[actor.id,actor.artifactCredential.hash]);
  const skillId = randomUUID(), versionId = randomUUID();
  await pool.query("INSERT INTO skills(id,slug,title,summary,visibility,lifecycle_status,owner_user_id) VALUES($1,'review-plan','Review plan','Synthetic exact review','public','approved',$2)", [skillId, actor.id]);
  await pool.query("INSERT INTO skill_versions(id,skill_id,version,lifecycle_status,review_status,security_status,approved_artifact_sha256,published_at) VALUES($1,$2,'1.0.0','approved','approved','passed',$3,now())", [versionId, skillId, digest]);
  await pool.query("INSERT INTO skill_artifacts(skill_version_id,storage_key,sha256,byte_size,content_type,payload) VALUES($1,'synthetic-plan',$2,12,'application/vnd.myskills-app.package+json',$3::jsonb)", [versionId, digest, JSON.stringify({ files: [] })]);
  const architectures = new PostgresArchitectureStore(db), targets = new PostgresArchitectureTargetStore(db);
  const targetService = new ArchitectureTargetService(targets, new ArchitectureTargetBindingAuthorizer(architectures));
  const architecture = await architectures.createArchitecture({ actor: actor.id, owner: { type: "user", id: actor.id }, name: "Exact review", description: "", patternId: "flat" });
  const spec = createFlatArchitecture({ id: architecture.id, name: architecture.name, skills: [{ id: "review-plan", slug: "review-plan", version: "1.0.0", digest, packageVisibility: "public" }], profile: { id: "personal", subject: { type: "user", id: actor.id } }, environment: { id: "workspace", kind: "personal" } });
  const revision = await architectures.createRevision({ actor: actor.id, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "Synthetic exact plan", spec });
  assert.ok(revision);
  const registered = await targetService.registerTarget({ actor: actor.id, architectureId: architecture.id, name: "Review target", profileId: "personal", environmentId: "workspace", adapter: { kind: "fixture", version: "1.0.0", contractVersion: 1 }, capabilities: { "inventory.read": true, "plan.read": true } });
  const target = await targetService.setConsent({ actor: actor.id, targetId: registered.id, decision: "grant" });
  const { architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest } = await import("@myskills-app/core");
  const observation = await targetService.appendObservation({ actor: actor.id, targetId: target.id, observation: { schemaVersion: 1, id: randomUUID(), targetId: target.id, targetGeneration: target.generation, adapterDigest: architectureTargetAdapterDigest(target.adapter), capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities, 1), observedAt: new Date().toISOString(), skills: [], configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } } });
  const store = new PostgresArchitectureSyncStore(db);
  const dependencies = { architectureStore: architectures, targetStore: targets, releaseDependencies: { skillRepository: new PostgresSkillRepository(db), submissionService: new SubmissionService(new PostgresSubmissionStore(db)) } };
  const service = new ArchitecturePlanService(store, dependencies);
  const request = { revisionId: revision.id, expectedTargetGeneration: target.generation, expectedObservationId: observation.id!, expectedObservationDigest: observation.observedDigest, idempotencyKey: "initial-review" };
  const app=buildApp({authService:new AuthService(new PostgresAuthStore(db)),architectureStore:architectures,architectureTargetService:targetService,skillRepository:dependencies.releaseDependencies.skillRepository,submissionService:dependencies.releaseDependencies.submissionService,architecturePlanService:service});t.after(()=>app.close());
  for(const action of ["create","approve"]){
    const drafted=action==="approve"?await service.createPlan(actor,target.id,{...request,idempotencyKey:"credential-approve"}):null;
    const blocker=await pool.connect();await blocker.query("BEGIN");await blocker.query("SELECT id FROM skill_architecture_targets WHERE id=$1 FOR UPDATE",[target.id]);
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending=app.inject({method:"POST",url:drafted?`/v1/architecture-plans/${drafted.run.identity.runId}/approve`:`/v1/architecture-targets/${target.id}/plans`,headers:{authorization:"Bearer pg-plan-session"},payload:drafted?{expectedReviewDigest:String(drafted.run.metadata!.reviewDigest)}:{...request,idempotencyKey:"credential-create"}}).then(response=>response); // Dispatch the injection before observing its blocked SQL.
    try{await waitForLock(pool,"%skill_architecture_targets%",true,blockerPid);await pool.query("UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1",[actor.artifactCredential.hash]);await blocker.query("COMMIT");const response=await pending;assert.equal(response.statusCode,403,response.body);
      if(drafted)assert.deepEqual(await store.getRun(drafted.run.identity.runId),drafted.run);else assert.equal((await store.listRuns({targetId:target.id})).some(run=>run.metadata?.source==="architecture-plan"),false);
    }finally{await blocker.query("ROLLBACK");blocker.release();await pool.query("UPDATE auth_sessions SET revoked_at=NULL WHERE token_hash=$1",[actor.artifactCredential.hash]);}
  }
  const initial = await service.createPlan(actor, target.id, request);
  assert.equal(initial.run.metadata?.reviewOnly, true);
  const approval = await service.approvePlan(actor, initial.run.identity.runId, { expectedReviewDigest: String(initial.run.metadata?.reviewDigest) });
  await assert.rejects(store.claimApply({ runId: approval.run.identity.runId, targetId: target.id, targetGeneration: target.generation, holderId: "forbidden", now: new Date().toISOString(), leaseSeconds: 30 }), (error: unknown) => error instanceof AppError && error.code === "ARCHITECTURE_PLAN_REVIEW_ONLY");
  assert.equal(await store.getCurrentLease(target.id), null);

  // Barrier after the real service has locked and authorized the exact release.
  const authority = store.withPlanAuthority.bind(store);
  for (const writer of [
    { name: "consent", sql: "UPDATE skill_architecture_targets SET consent_status='denied' WHERE id=$1", params: [target.id], restore: "UPDATE skill_architecture_targets SET consent_status='granted' WHERE id=$1" },
    { name: "account", sql: "UPDATE users SET status='disabled' WHERE id=$1", params: [actor.id], restore: "UPDATE users SET status='active' WHERE id=$1" },
    { name: "release", sql: "UPDATE skill_versions SET lifecycle_status='revoked' WHERE id=$1", params: [versionId], restore: "UPDATE skill_versions SET lifecycle_status='approved' WHERE id=$1" },
  ]) {
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    store.withPlanAuthority = (input, operation) => authority(input, (scoped, deps) => operation(scoped, { ...deps, authorizeRevision: async value => { await deps.authorizeRevision?.(value); entered(); await paused; } }));
    const pending = service.createPlan(actor, target.id, { ...request, idempotencyKey: `writer-${writer.name}` });
    await Promise.race([entry, pending]);
    const mutation = pool.query(writer.sql, writer.params);
    try {
      await waitForLock(pool, writer.sql);
      release();
      const committed = await pending;
      await mutation;
      store.withPlanAuthority = authority;
      await assert.rejects(service.approvePlan(actor, committed.run.identity.runId, { expectedReviewDigest: String(committed.run.metadata?.reviewDigest) }));
      assert.deepEqual(await store.getRun(committed.run.identity.runId), committed.run);
    } finally { release(); await mutation; store.withPlanAuthority = authority; await pool.query(writer.restore, writer.params); }
  }

  const drafted = await service.createPlan(actor, target.id, { ...request, idempotencyKey: "approval-rollback" });
  let firstApprovalWrite = false;
  store.withPlanAuthority = (input, operation) => authority(input, (scoped, deps) => {
    const save = scoped.saveRun.bind(scoped);
    scoped.saveRun = async run => { const saved = await save(run); if (saved.state === "awaiting_approval") firstApprovalWrite = true; return saved; };
    return operation(scoped, deps);
  });
  await pool.query("CREATE FUNCTION reject_review_approval() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='approved' THEN IF OLD.status<>'awaiting_approval' THEN RAISE EXCEPTION 'test first write missing'; END IF; RAISE EXCEPTION 'test approval failure after awaiting_approval'; END IF; RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER reject_review_approval BEFORE UPDATE ON skill_architecture_sync_runs FOR EACH ROW EXECUTE FUNCTION reject_review_approval()");
  try { await assert.rejects(service.approvePlan(actor, drafted.run.identity.runId, { expectedReviewDigest: String(drafted.run.metadata?.reviewDigest) }), error => error instanceof AppError && error.code === "ARCHITECTURE_SYNC_SAVE_FAILED"); }
  finally { await pool.query("DROP TRIGGER reject_review_approval ON skill_architecture_sync_runs"); await pool.query("DROP FUNCTION reject_review_approval()"); store.withPlanAuthority = authority; }
  assert.equal(firstApprovalWrite, true, "the actual first write completed inside the rolled-back transaction");
  assert.deepEqual(await store.getRun(drafted.run.identity.runId), drafted.run, "first awaiting-approval write rolls back with the failed second write");
  const approvals = await Promise.all([1, 2].map(() => service.approvePlan(actor, drafted.run.identity.runId, { expectedReviewDigest: String(drafted.run.metadata?.reviewDigest) })));
  assert.equal(approvals.filter(result => !result.replayed).length, 1);
  assert.equal(approvals[0].run.receipts.length, 1);
  assert.deepEqual(approvals[0].run, approvals[1].run);
  const persisted = await new PostgresArchitectureSyncStore(db).getRun(drafted.run.identity.runId) as ArchitectureSyncRun;
  assert.deepEqual(persisted, approvals[0].run);

  // The production observation and policy writers use the target authority
  // lock. Both must serialize after the held review, then invalidate approval.
  const policies = new SkillUpgradePolicyService(new PostgresSkillUpgradePolicyStore(db));
  for (const mutation of [
    { name: "observation", fence: "OBSERVATION", execute: () => targetService.appendObservation({ actor: actor.id, targetId: target.id, observation: { schemaVersion: 1, targetId: target.id, targetGeneration: target.generation, adapterDigest: observation.adapterDigest, capabilitiesDigest: observation.capabilitiesDigest, id: randomUUID(), observedAt: new Date().toISOString(), skills: [], configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } } }) },
    { name: "policy", fence: "POLICY", execute: () => policies.append({ actorUserId: actor.id, scopeType: "target", scopeId: target.id, expectedRevisionNumber: 0, policy: { schemaVersion: 1, mode: "manual", includePrerelease: false, allowedChangeKinds: ["fix", "feature", "breaking", "security", "maintenance"], pins: {} } }) },
  ]) {
    const latest = (await targets.listObservations({ actor: actor.id, targetId: target.id, limit: 1 }))![0]!;
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    store.withPlanAuthority = (input, operation) => authority(input, (scoped, deps) => operation(scoped, { ...deps, authorizeRevision: async value => { await deps.authorizeRevision?.(value); entered(); await paused; } }));
    const pending = service.createPlan(actor, target.id, { ...request, expectedObservationId: latest.id!, expectedObservationDigest: latest.observedDigest, idempotencyKey: `writer-${mutation.name}` });
    await Promise.race([entry, pending]);
    const writing = mutation.execute();
    try {
      await waitForLock(pool, "%skill_architecture_targets%", true);
      release();
      const committed = await pending;
      await writing;
      store.withPlanAuthority = authority;
      await assert.rejects(service.approvePlan(actor, committed.run.identity.runId, { expectedReviewDigest: String(committed.run.metadata?.reviewDigest) }), (error: unknown) => error instanceof AppError && error.code === `ARCHITECTURE_PLAN_${mutation.fence}_STALE`);
      assert.deepEqual(await store.getRun(committed.run.identity.runId), committed.run);
    } finally { release(); await writing; store.withPlanAuthority = authority; }
  }
});

async function waitForLock(pool: ReturnType<typeof createPgPool>, query: string, pattern = false, blockingPid?: number) {
  for (let i = 0; i < 200; i++) {
    if ((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE query ${pattern ? "LIKE" : "="} $1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND ($2::int IS NULL OR $2=ANY(pg_blocking_pids(pid)))`, [query, blockingPid ?? null])).rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Independent writer did not wait on retained plan authority");
}
