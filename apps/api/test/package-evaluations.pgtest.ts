import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { hashPassword,hashSessionToken } from "@myskills-app/auth";
import { defaultPackageEvaluationSuite,parseSkillManifest } from "@myskills-app/skill-package";
import { createDb,createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { ImprovementService } from "../src/improvements/service.js";
import { PostgresImprovementStore } from "../src/improvements/postgres-store.js";
import { EvaluationService } from "../src/evaluations/service.js";
import { buildApp } from "../src/app.js";

// API+PG proof: real credential authorization, immutable shared suite revision,
// exact artifact, concurrent same-key replay, denied reads and expiry under waits.
test("exact-version evaluation HTTP/PG authority, replay, immutability and public projection",{timeout:60_000},async t=>{
  const url=process.env.TEST_DATABASE_URL!;assert.match(new URL(url).pathname,/(^|[_/-])(test|ci)([_-]|$)/i);
  const pool=createPgPool(url);t.after(()=>pool.end());await pool.query("DROP SCHEMA public CASCADE");await pool.query("CREATE SCHEMA public");await runMigrations(pool);
  const db=createDb(pool);const authStore=new PostgresAuthStore(db);const password="Evaluation-test-password-827!";
  const users=[];
  for(const name of ["author","outsider"]) {
    const user=(await authStore.createUserWithPassword({email:`${name}@evaluation.test`,name,passwordHash:await hashPassword(password)})).user!;
    await authStore.updateUserStatus({userId:user.id,status:"active",emailVerifiedAt:new Date()});
    await pool.query("INSERT INTO role_assignments(user_id,role) VALUES($1,'author') ON CONFLICT DO NOTHING",[user.id]);users.push(user);
  }
  const author=users[0]!;const outsider=users[1]!;
  const submissions=new SubmissionService(new PostgresSubmissionStore(db));
  const improvements=new ImprovementService(new PostgresImprovementStore(db),{submissionService:submissions,authStore});
  const app=buildApp({skillRepository:new PostgresSkillRepository(db),authService:new AuthService(authStore,{}),submissionService:submissions,improvementService:improvements,evaluationService:new EvaluationService(db),requestLimiter:new MemoryAuthRateLimiter({maxAttempts:1000,windowMs:60_000})});t.after(()=>app.close());
  const call=async(method:"GET"|"POST",url:string,token?:string,body?:unknown)=>app.inject({method,url,headers:token?{authorization:`Bearer ${token}`}:{},...(body?{payload:body as Record<string,unknown>}:{})});
  const authorToken=(await call("POST","/v1/auth/login",undefined,{email:author.email,password})).json().token as string;
  const outsiderToken=(await call("POST","/v1/auth/login",undefined,{email:outsider.email,password})).json().token as string;
  const suiteResponse=await call("POST","/v1/improvements/suites",authorToken,{owner:{type:"user",id:author.id},suite:defaultPackageEvaluationSuite()});assert.equal(suiteResponse.statusCode,201,suiteResponse.body);
  const document=suiteResponse.json().suite;
  const suiteRevisionId=document.latest.id;
  const manifest=parseSkillManifest({name:"evaluation-fixture",title:"Fixture",summary:"Version evaluation",version:"1.0.0",license:"MIT",visibility:"private",platforms:[{name:"codex",install_target:"codex-skill"}]});
  const first=await submissions.createSubmission({actor:{id:author.id,roles:["author"]},manifest,files:[{path:"skill.json",content:JSON.stringify(manifest)},{path:"SKILL.md",content:"# PRIVATE-CONTENT-CANARY"}]});
  const endpoint="/v1/evaluations/releases/evaluation-fixture/1.0.0";
  const input={artifactSha256:first.artifact.sha256,suiteRevisionId,platform:"codex",idempotencyKey:"evaluation-replay"};
  const concurrent=await Promise.all([call("POST",`${endpoint}/runs`,authorToken,input),call("POST",`${endpoint}/runs`,authorToken,input)]);
  assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,201]);assert.equal(concurrent[0]!.json().run.id,concurrent[1]!.json().run.id);
  const run=concurrent[0]!.json().run;
  assert.equal(run.versionId,first.id);assert.equal(run.suiteRevisionId,suiteRevisionId);assert.equal(run.result.suiteSha256,document.latest.bodySha256);
  assert.equal(run.result.provenance,"api-owned");assert.deepEqual(run.result.totals,{pass:3,fail:0,warning:0,skipped:1,incompatible:0});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM package_evaluation_runs")).rows[0].n,1);
  for(const query of ["UPDATE package_evaluation_runs SET result='{}'::jsonb WHERE id=$1","DELETE FROM package_evaluation_runs WHERE id=$1"])await assert.rejects(pool.query(query,[run.id]),/immutable/);
  assert.equal((await call("POST",`${endpoint}/runs`,authorToken,{...input,platform:"other"})).statusCode,409);
  assert.equal((await call("POST",`${endpoint}/runs`,authorToken,{...input,artifactSha256:"a".repeat(64),idempotencyKey:"different-binding"})).statusCode,409);
  assert.equal((await call("GET",`${endpoint}/runs`,outsiderToken)).statusCode,404);
  assert.equal((await call("GET",`${endpoint}/summary`)).statusCode,404);
  assert.equal((await call("GET",`${endpoint}/summary`,"invalid-token")).statusCode,401);
  const readTokenResponse=await call("POST","/v1/auth/api-tokens",authorToken,{name:"Read only",scopes:["improvements:read"]});assert.equal(readTokenResponse.statusCode,201);
  const readToken=readTokenResponse.json().token.token as string;
  assert.equal((await call("POST",`${endpoint}/runs`,readToken,{...input,idempotencyKey:"read-cannot-run"})).statusCode,403);
  for(const failure of ["revocation","expiry"] as const) {
    const session=(await call("POST","/v1/auth/login",undefined,{email:author.email,password})).json().token as string;
    const key=`blocked-${failure}`;const locker=await pool.connect();await locker.query("BEGIN");await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`evaluation:${author.id}:${key}`]);
    const pending=call("POST",`${endpoint}/runs`,session,{...input,idempotencyKey:key});
    try {
      await waitForLock(pool);
      if(failure==="revocation")await authStore.revokeSessionByTokenHash(hashSessionToken(session));
      else await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[hashSessionToken(session)]);
    } finally {await locker.query("COMMIT");locker.release();}
    assert.equal((await pending).statusCode,401);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM package_evaluation_runs")).rows[0].n,1);
  // Direct cross-version binding is rejected by the database, independent of service code.
  const nextManifest={...manifest,version:"1.0.1"};const next=await submissions.createSubmission({actor:{id:author.id,roles:["author"]},manifest:nextManifest,files:[{path:"skill.json",content:JSON.stringify(nextManifest)},{path:"SKILL.md",content:"# Corrected"}]});
  await assert.rejects(pool.query(`INSERT INTO package_evaluation_runs(id,skill_version_id,artifact_sha256,suite_revision_id,suite_sha256,actor_user_id,idempotency_key,request_sha256,result,review_context)
    SELECT $1,$2,artifact_sha256,suite_revision_id,suite_sha256,actor_user_id,'cross-artifact',request_sha256,result,review_context FROM package_evaluation_runs WHERE id=$3`,[randomUUID(),next.id,run.id]),/binding mismatch/);
  const secondEndpoint="/v1/evaluations/releases/evaluation-fixture/1.0.1";
  assert.equal((await call("POST",`${secondEndpoint}/runs`,authorToken,{...input,artifactSha256:next.artifact.sha256,idempotencyKey:"new-version-eval"})).statusCode,201);
  assert.equal((await call("GET",`${endpoint}/runs`,authorToken)).json().runs[0].result.artifactSha256,first.artifact.sha256);
  // Use the real approval/publication services, then release visibility policy, for public summary proof.
  const reviewer={id:author.id,roles:["maintainer" as const],mfaVerified:true};
  await submissions.performReviewAction({actor:reviewer,submissionId:first.id,action:"approve",artifactSha256:first.artifact.sha256});
  await submissions.performReviewAction({actor:reviewer,submissionId:first.id,action:"publish"});
  await pool.query("UPDATE skills SET visibility='public' WHERE slug='evaluation-fixture'");
  const summary=await call("GET",`${endpoint}/summary`);assert.equal(summary.statusCode,200,summary.body);
  assert.equal(summary.json().runs[0].summary.artifactSha256,first.artifact.sha256);
  for(const canary of ["PRIVATE-CONTENT-CANARY","assertions","reviewContext","actorUserId","files","tokenHash"])assert.equal(summary.body.includes(canary),false,canary);
  assert.equal((await call("GET",`${endpoint}/summary`,"invalid-token")).statusCode,401);
  await authStore.revokeApiToken({userId:author.id,tokenId:readTokenResponse.json().token.id});
  assert.equal((await call("GET",`${endpoint}/summary`,readToken)).statusCode,401);
  assert.equal((await call("GET",`${endpoint}/runs`,readToken)).statusCode,401);
});
async function waitForLock(pool:ReturnType<typeof createPgPool>){
  const deadline=Date.now()+5000;while(Date.now()<deadline){const r=await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' AND pid<>pg_backend_pid()");if(r.rows.length)return;await new Promise(done=>setTimeout(done,20));}assert.fail("No blocked API evaluation transaction");
}
