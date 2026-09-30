import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AppError, artifactHash, createMultiLevelRouterArchitecture, architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest } from "@myskills-app/core";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { PostgresArchitectureSyncStore } from "../src/architecture-sync/postgres-store.js";
import { ArchitecturePlanService } from "../src/architecture-sync/plan-service.js";
import { ArchitectureArtifactService } from "../src/architecture-sync/artifact-service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { MemoryArtifactObjectStorage } from "../src/artifacts/storage.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";

// Prepared canonical real-PostgreSQL journey. No Mini PG/Docker execution.
test("Postgres composed intent/approval/claim/receipt retain authority, purpose, append-only history and post-wait expiry",{timeout:120_000},async t=>{
  const url=process.env.TEST_DATABASE_URL;assert.ok(url);assert.match(new URL(url).pathname,/(test|ci)/i);
  const pool=createPgPool(url);t.after(()=>pool.end());await pool.query("DROP SCHEMA IF EXISTS public CASCADE");await pool.query("CREATE SCHEMA public");await runMigrations(pool);const db=createDb(pool);
  const actor={id:randomUUID(),mfaVerified:true,artifactCredential:{kind:"session" as const,hash:"fixture-session-hash"}};
  await pool.query("INSERT INTO users(id,email,normalized_email,name,status,email_verified_at) VALUES($1,'composed@example.test','composed@example.test','Composed','active',now())",[actor.id]);
  const sessionId=randomUUID();await pool.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',clock_timestamp())",[sessionId,actor.id,actor.artifactCredential.hash]);
  const storage=new MemoryArtifactObjectStorage();let reads=0,denyStorage=false;
  const readObject=storage.getObject.bind(storage);storage.getObject=async(key,options)=>{reads++;if(denyStorage)throw Object.assign(new Error("Synthetic storage permission denial"),{name:"AccessDenied"});return readObject(key,options);};
  const submissions=new SubmissionService(new PostgresSubmissionStore(db,{artifactStorage:storage}));const refs=[];
  for(const [slug,version] of [["composed-alpha","2.0.0"],["composed-beta","1.0.0"]]){
    const manifest={name:slug,title:slug,summary:"Synthetic composed PG fixture",version,license:"Apache-2.0",visibility:"public" as const,platforms:[{name:"codex",install_target:"codex-skill",status:"supported" as const}],tags:[]};
    const submitted=await submissions.createSubmission({actor:{id:actor.id,roles:["author"]},manifest,files:[{path:"skill.json",content:JSON.stringify(manifest)},{path:"SKILL.md",content:`---\nname: ${slug}\ndescription: Composed fixture\n---\nExact ${version}\n`},{path:"references/source.txt",content:"Fixture asset\n"}]});
    await submissions.performReviewAction({actor:{id:actor.id,roles:["maintainer"]},submissionId:submitted.id,action:"approve",artifactSha256:submitted.artifact.sha256});
    await submissions.performReviewAction({actor:{id:actor.id,roles:["maintainer"]},submissionId:submitted.id,action:"publish"});refs.push({id:slug,slug,version,digest:submitted.artifact.sha256,packageVisibility:"public" as const,domainId:"build"});
  }
  const architectures=new PostgresArchitectureStore(db),targets=new PostgresArchitectureTargetStore(db);const targetService=new ArchitectureTargetService(targets,new ArchitectureTargetBindingAuthorizer(architectures));
  const architecture=await architectures.createArchitecture({actor:actor.id,owner:{type:"user",id:actor.id},name:"Composed fixture",description:"",patternId:"multi-level-router"});
  const spec=createMultiLevelRouterArchitecture({id:architecture.id,name:architecture.name,skills:refs,profile:{id:"personal",subject:{type:"user",id:actor.id}},environment:{id:"workspace",kind:"personal"}});const revision=await architectures.createRevision({actor:actor.id,architectureId:architecture.id,expectedCurrentRevisionId:null,message:"Exact fixture",spec});assert.ok(revision);
  const registered=await targetService.registerTarget({actor:actor.id,name:"Explicit PG workspace",architectureId:architecture.id,profileId:"personal",environmentId:"workspace",adapter:{kind:"codex-workspace",version:"1.0.0",contractVersion:2},capabilities:{"inventory.read":true,"health.read":true,"plan.read":true,apply:true,rollback:true,"sync.write":true}});const target=await targetService.setConsent({actor:actor.id,targetId:registered.id,decision:"grant"});
  const observation=await targetService.appendObservation({actor:actor.id,targetId:target.id,observation:{schemaVersion:1,id:randomUUID(),targetId:target.id,targetGeneration:target.generation,adapterDigest:architectureTargetAdapterDigest(target.adapter),capabilitiesDigest:architectureTargetCapabilitiesDigest(target.capabilities,2),observedAt:new Date().toISOString(),skills:[],configFindings:[],promptAwareness:{detected:false,count:0,redacted:true}}});
  const store=new PostgresArchitectureSyncStore(db,{artifactStorage:storage});const deps={architectureStore:architectures,targetStore:targets,releaseDependencies:{skillRepository:new PostgresSkillRepository(db),submissionService:submissions}};const plans=new ArchitecturePlanService(store,deps),artifacts=new ArchitectureArtifactService(store,deps);
  const review=await plans.createPlan(actor,target.id,{revisionId:revision.id,expectedTargetGeneration:target.generation,expectedObservationId:observation.id!,expectedObservationDigest:observation.observedDigest,idempotencyKey:"pg-review"});await plans.approvePlan(actor,review.run.identity.runId,{expectedReviewDigest:String(review.run.metadata!.reviewDigest)});
  const placeholders=await pool.query("SELECT payload FROM skill_artifacts");assert.ok(placeholders.rows.every(row=>row.payload.files.length===0));
  denyStorage=true;await assert.rejects(artifacts.prepare(actor,target.id,{reviewRunId:review.run.identity.runId,baselineRunId:null,idempotencyKey:"storage-denied"}));denyStorage=false;reads=0;
  const candidate=await artifacts.prepare(actor,target.id,{reviewRunId:review.run.identity.runId,baselineRunId:null,idempotencyKey:"pg-artifact"});const input={expectedIntentDigest:candidate.intentDigest,treeDigest:candidate.intent.treeDigest,baselineDigest:candidate.intent.baselineDigest};
  const materializationReads=reads;assert.equal(materializationReads,2);
  assert.ok(candidate.intent.files.some(file=>file.path.endsWith("references/source.txt")&&file.size===Buffer.byteLength("Fixture asset\n")));
  assert.deepEqual(await new PostgresArchitectureSyncStore(db,{artifactStorage:storage}).getArtifactIntent(candidate.run.identity.runId),candidate.intent);
  // SQL itself rejects absent contract/purpose, immutable intent and conversion
  // of review intent even when application validators are bypassed.
  const row=(await pool.query("SELECT id FROM skill_architecture_sync_runs WHERE metadata->>'syncPublicRunId'=$1",[candidate.run.identity.runId])).rows[0];assert.ok(row);
  await assert.rejects(pool.query("UPDATE skill_architecture_sync_runs SET artifact_intent='{}'::jsonb WHERE id=$1",[row.id]));
  for(const [intent,metadata] of [[{},candidate.run.metadata],[candidate.intent,{reviewOnly:false,artifactDigest:candidate.intentDigest}],[{...candidate.intent,projection:{...candidate.intent.projection,contract:undefined}},candidate.run.metadata]]) {
    await assert.rejects(pool.query("INSERT INTO skill_architecture_sync_runs SELECT (jsonb_populate_record(NULL::skill_architecture_sync_runs,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'request_key',gen_random_uuid()::text,'idempotency_key',gen_random_uuid()::text,'artifact_intent',$2::jsonb,'metadata',$3::jsonb))).* FROM skill_architecture_sync_runs r WHERE id=$1",[row.id,JSON.stringify(intent),JSON.stringify(metadata)]),error=>(error as {code:string}).code==="23514");
  }

  await assert.rejects(pool.query("UPDATE skill_architecture_sync_runs SET metadata=metadata-'source' WHERE id=$1",[row.id]));
  await assert.rejects(pool.query("UPDATE skill_architecture_sync_runs SET artifact_intent=jsonb_set(artifact_intent,'{treeDigest}','\"bad\"') WHERE id=$1",[row.id]));
  await assert.rejects(pool.query("UPDATE skill_architecture_sync_runs SET artifact_intent=$1::jsonb WHERE metadata->>'syncPublicRunId'=$2",[JSON.stringify(candidate.intent),review.run.identity.runId]));
  const approvals=await Promise.all([1,2].map(()=>artifacts.approve(actor,candidate.run.identity.runId,input)));assert.equal(approvals.filter(a=>!a.replayed).length,1);
  const skillOperation=randomUUID();await pool.query("INSERT INTO target_skill_operations(id,target_id,target_generation,actor_user_id,action,skill_slug,to_version,platform,artifact_sha256,artifact_byte_size,artifact_content_type,plan_digest,state,fencing_token,holder_id,claim_token_hash,lease_expires_at,idempotency_key) VALUES($1,$2,$3,$4,'install','composed-alpha','2.0.0','codex',$5,1,'fixture',$5,'claimed',41,'ordinary-holder',$5,clock_timestamp()+interval '10 minutes','ordinary-contention')",[skillOperation,target.id,target.generation,actor.id,candidate.intentDigest]);
  await assert.rejects(artifacts.claim(actor,candidate.run.identity.runId,{holderId:"blocked-composed",expectedIntentDigest:candidate.intentDigest}));assert.equal((await store.getRun(candidate.run.identity.runId))!.state,"approved");await pool.query("DELETE FROM target_skill_operations WHERE id=$1",[skillOperation]);
  const claims=await Promise.all([1,2].map(i=>artifacts.claim(actor,candidate.run.identity.runId,{holderId:`pg-holder-${i}`,expectedIntentDigest:candidate.intentDigest})));assert.equal(claims.filter(c=>c.decision==="claimed").length,1);const claimed=claims.find(c=>c.decision==="claimed")!.run;
  const fence={holderId:claimed.lease!.holderId,fencingToken:claimed.lease!.fencingToken};await assert.rejects(artifacts.checkpoint(actor,candidate.run.identity.runId,{...fence,fencingToken:fence.fencingToken+1}));
  await assert.rejects(artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:artifactHash([])}));
  await artifacts.checkpoint(actor,candidate.run.identity.runId,fence);const completed=await artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:candidate.intent.treeDigest});assert.equal(completed.run.state,"succeeded");assert.equal((await artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:candidate.intent.treeDigest})).replayed,true);
  const rollback=await artifacts.rollback(actor,candidate.run.identity.runId,{...input,holderId:"pg-rollback"});assert.ok(rollback.run.lease!.fencingToken>fence.fencingToken);
  await artifacts.receipt(actor,candidate.run.identity.runId,{holderId:"pg-rollback",fencingToken:rollback.run.lease!.fencingToken,treeDigest:artifactHash([])});
  assert.equal(reads,materializationReads,"approval, checkpoints, receipt and rollback do not fetch objects again");
  // A held exact-release row makes executable work wait. The session expires
  // during that real wait; post-wait clock_timestamp must reject the write.
  const expiring=await artifacts.prepare(actor,target.id,{reviewRunId:review.run.identity.runId,baselineRunId:null,idempotencyKey:"pg-expiry"});
  const blocker=await pool.connect();await blocker.query("BEGIN");await blocker.query("SELECT id FROM skill_versions WHERE skill_id=(SELECT id FROM skills WHERE slug='composed-alpha') FOR UPDATE");
  await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",[sessionId]);
  const waiting=artifacts.approve(actor,expiring.run.identity.runId,{expectedIntentDigest:expiring.intentDigest,treeDigest:expiring.intent.treeDigest,baselineDigest:expiring.intent.baselineDigest});
  // Avoid unhandled rejection while the independent lock barrier is inspected.
  const observed=waiting.then(value=>({value}),error=>({error}));
  try{
    const deadline=Date.now()+10_000;let blocked=false;while(Date.now()<deadline){const activity=await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query ILIKE '%skill_versions%'");if(activity.rowCount){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(blocked,true,"actual release lock wait observed");
    await new Promise(resolve=>setTimeout(resolve,750));await blocker.query("COMMIT");const denied=await observed;assert.ok("error" in denied);assert.equal((await store.getRun(expiring.run.identity.runId))!.state,"drafted");assert.equal((await store.getRun(expiring.run.identity.runId))!.approval,undefined);
  }finally{await blocker.query("ROLLBACK");blocker.release();}
  // A revoked target cannot use retained actor ownership to approve/claim.
  await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[sessionId]);
  await targetService.setConsent({actor:actor.id,targetId:target.id,decision:"deny"});await assert.rejects(artifacts.approve(actor,expiring.run.identity.runId,{expectedIntentDigest:expiring.intentDigest,treeDigest:expiring.intent.treeDigest,baselineDigest:expiring.intent.baselineDigest}),error=>error instanceof AppError);
});
