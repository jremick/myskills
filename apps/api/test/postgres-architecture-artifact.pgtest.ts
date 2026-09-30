import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AppError, artifactHash, createMultiLevelRouterArchitecture, architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest, defaultOrganizationPolicyV1, organizationPolicyDigest, defaultSkillUpgradePolicyV1 } from "@myskills-app/core";
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
import { PostgresOrganizationStore } from "../src/organizations/postgres-organization-store.js";
import { SkillUpgradePolicyService } from "../src/upgrade-policies/service.js";
import { PostgresSkillUpgradePolicyStore } from "../src/upgrade-policies/postgres-store.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";

// Prepared canonical real-PostgreSQL journey. No Mini PG/Docker execution.
test("Postgres composed intent/approval/claim/receipt retain authority, purpose, append-only history and post-wait expiry",{timeout:240_000},async t=>{
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
  const persistedApproval=await new PostgresArchitectureSyncStore(db,{artifactStorage:storage}).getRun(candidate.run.identity.runId);
  assert.deepEqual(persistedApproval,approvals[0].run);assert.ok(JSON.stringify(persistedApproval!.approval!.metadata).length<=256);
  assert.deepEqual(persistedApproval!.approval!.metadata,{artifactDigest:candidate.intentDigest,execution:true});
  await assert.rejects(store.saveRun({...persistedApproval!,approval:{...persistedApproval!.approval!,metadata:{artifactDigest:"0".repeat(64),execution:true}}}));
  assert.deepEqual(await store.getRun(candidate.run.identity.runId),persistedApproval);
  const skillOperation=randomUUID();await pool.query("INSERT INTO target_skill_operations(id,target_id,target_generation,actor_user_id,action,skill_slug,to_version,platform,artifact_sha256,artifact_byte_size,artifact_content_type,plan_digest,state,fencing_token,holder_id,claim_token_hash,lease_expires_at,idempotency_key) VALUES($1,$2,$3,$4,'install','composed-alpha','2.0.0','codex',$5,1,'fixture',$5,'claimed',41,'ordinary-holder',$5,clock_timestamp()+interval '10 minutes','ordinary-contention')",[skillOperation,target.id,target.generation,actor.id,candidate.intentDigest]);
  await assert.rejects(artifacts.claim(actor,candidate.run.identity.runId,{holderId:"blocked-composed",expectedIntentDigest:candidate.intentDigest}));assert.equal((await store.getRun(candidate.run.identity.runId))!.state,"approved");await pool.query("DELETE FROM target_skill_operations WHERE id=$1",[skillOperation]);
  const claims=await Promise.all([1,2].map(i=>artifacts.claim(actor,candidate.run.identity.runId,{holderId:`pg-holder-${i}`,expectedIntentDigest:candidate.intentDigest})));assert.equal(claims.filter(c=>c.decision==="claimed").length,1);const claimed=claims.find(c=>c.decision==="claimed")!.run;
  const fence={holderId:claimed.lease!.holderId,fencingToken:claimed.lease!.fencingToken};await assert.rejects(artifacts.checkpoint(actor,candidate.run.identity.runId,{...fence,fencingToken:fence.fencingToken+1}));
  await assert.rejects(artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:artifactHash([])}));
  await artifacts.checkpoint(actor,candidate.run.identity.runId,fence);const completed=await artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:candidate.intent.treeDigest});assert.equal(completed.run.state,"succeeded");assert.equal((await artifacts.receipt(actor,candidate.run.identity.runId,{...fence,treeDigest:candidate.intent.treeDigest})).replayed,true);
  const rollback=await artifacts.rollback(actor,candidate.run.identity.runId,{...input,holderId:"pg-rollback"});assert.ok(rollback.run.lease!.fencingToken>fence.fencingToken);
  await artifacts.receipt(actor,candidate.run.identity.runId,{holderId:"pg-rollback",fencingToken:rollback.run.lease!.fencingToken,treeDigest:artifactHash([])});
  assert.equal(reads,materializationReads,"approval, checkpoints, receipt and rollback do not fetch objects again");
  // Real receiving organization, current grants and two distinct administrators.
  const other={id:randomUUID(),mfaVerified:true,artifactCredential:{kind:"session" as const,hash:"fixture-other-session-hash"}};
  await pool.query("INSERT INTO users(id,email,normalized_email,name,status,email_verified_at) VALUES($1,'composed-other@example.test','composed-other@example.test','Other','active',now())",[other.id]);
  const otherSession=randomUUID();await pool.query("INSERT INTO auth_sessions(id,user_id,token_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',clock_timestamp())",[otherSession,other.id,other.artifactCredential.hash]);
  await pool.query("INSERT INTO instance_settings(key,value) VALUES('sharing',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[JSON.stringify({publicVisibilityEnabled:true,authenticatedVisibilityEnabled:true,teamsEnabled:true,teamVisibilityEnabled:true,userVisibilityEnabled:true,organizationVisibilityEnabled:true})]);
  const organizationId=randomUUID(), otherOrganization=randomUUID();
  for(const [org,slug] of [[organizationId,"composed-receiving"],[otherOrganization,"composed-unrelated"]]) {
    const policyId=randomUUID();await pool.query("INSERT INTO organizations(id,name,slug,created_by_user_id) VALUES($1,'Composed receiving organization',$2,$3)",[org,slug,actor.id]);
    await pool.query("INSERT INTO organization_policy_revisions(id,organization_id,revision_number,policy,policy_sha256,created_by_user_id) VALUES($1,$2,1,$3::jsonb,$4,$5)",[policyId,org,JSON.stringify(defaultOrganizationPolicyV1),organizationPolicyDigest(defaultOrganizationPolicyV1),actor.id]);
    await pool.query("UPDATE organizations SET status='active',current_policy_revision_id=$2 WHERE id=$1",[org,policyId]);
    await pool.query("INSERT INTO organization_memberships(organization_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'admin')",[org,actor.id,other.id]);
    await pool.query("INSERT INTO skill_architecture_organization_grants(architecture_id,organization_id,created_by_user_id,created_under_policy_revision_id) VALUES($1,$2,$3,$4)",[architecture.id,org,actor.id,policyId]);
  }
  const organizationTargets=new ArchitectureTargetService(targets,new ArchitectureTargetBindingAuthorizer(architectures,new PostgresOrganizationStore(db)));
  const organizationRegistered=await organizationTargets.registerTarget({actor:actor.id,owner:{type:"organization",id:organizationId},name:"Real receiving organization",architectureId:architecture.id,profileId:"personal",environmentId:"workspace",adapter:target.adapter,capabilities:target.capabilities});
  const organizationTarget=await organizationTargets.setConsent({actor:actor.id,targetId:organizationRegistered.id,decision:"grant"});
  const organizationObservation=await organizationTargets.appendObservation({actor:actor.id,targetId:organizationTarget.id,observation:{schemaVersion:1,id:randomUUID(),targetId:organizationTarget.id,targetGeneration:organizationTarget.generation,adapterDigest:architectureTargetAdapterDigest(organizationTarget.adapter),capabilitiesDigest:architectureTargetCapabilitiesDigest(organizationTarget.capabilities,2),observedAt:new Date().toISOString(),skills:[],configFindings:[],promptAwareness:{detected:false,count:0,redacted:true}}});
  async function prepareOrganization(revisionId:string,baselineRunId:string|null,key:string) {
    const reviewed=await plans.createPlan(actor,organizationTarget.id,{revisionId,expectedTargetGeneration:organizationTarget.generation,expectedObservationId:organizationObservation.id!,expectedObservationDigest:organizationObservation.observedDigest,idempotencyKey:`review-${key}`});
    await plans.approvePlan(actor,reviewed.run.identity.runId,{expectedReviewDigest:String(reviewed.run.metadata!.reviewDigest)});
    const prepared=await artifacts.prepare(actor,organizationTarget.id,{reviewRunId:reviewed.run.identity.runId,baselineRunId,idempotencyKey:key});return {prepared,reviewed};
  }
  const {prepared:organizationArtifact,reviewed:organizationReview}=await prepareOrganization(revision.id,null,"organization-actor");
  const organizationInput={expectedIntentDigest:organizationArtifact.intentDigest,treeDigest:organizationArtifact.intent.treeDigest,baselineDigest:organizationArtifact.intent.baselineDigest};
  await artifacts.approve(actor,organizationArtifact.run.identity.runId,organizationInput);
  const organizationClaim=await artifacts.claim(actor,organizationArtifact.run.identity.runId,{holderId:"organization-forward",expectedIntentDigest:organizationArtifact.intentDigest});
  const inspected=await artifacts.inspect(other,organizationArtifact.run.identity.runId);assert.equal(inspected.run.lease!.holderId,"organization-forward");
  const organizationFence={holderId:inspected.run.lease!.holderId,fencingToken:inspected.run.lease!.fencingToken};
  const actorDenied=(error:unknown)=>error instanceof AppError&&error.code==="ARCHITECTURE_ARTIFACT_CLAIM_ACTOR_REQUIRED";
  await assert.rejects(artifacts.checkpoint(other,inspected.run.identity.runId,organizationFence),actorDenied);
  await assert.rejects(artifacts.receipt(other,inspected.run.identity.runId,{...organizationFence,treeDigest:organizationArtifact.intent.treeDigest}),actorDenied);
  assert.deepEqual(await store.getRun(inspected.run.identity.runId),organizationClaim.run);
  await artifacts.checkpoint(actor,inspected.run.identity.runId,organizationFence);
  await artifacts.receipt(actor,inspected.run.identity.runId,{...organizationFence,treeDigest:organizationArtifact.intent.treeDigest});
  await assert.rejects(artifacts.receipt(other,inspected.run.identity.runId,{...organizationFence,treeDigest:organizationArtifact.intent.treeDigest}),actorDenied);
  const distinctRollback=await artifacts.rollback(other,inspected.run.identity.runId,{...organizationInput,holderId:"organization-other-rollback"});
  const distinctFence={holderId:"organization-other-rollback",fencingToken:distinctRollback.run.lease!.fencingToken};
  assert.equal(distinctRollback.run.receipts.at(-1)!.metadata!.actorId,other.id);
  await assert.rejects(artifacts.checkpoint(actor,inspected.run.identity.runId,distinctFence),actorDenied);
  await assert.rejects(artifacts.receipt(actor,inspected.run.identity.runId,{...distinctFence,treeDigest:artifactHash([])}),actorDenied);
  await artifacts.checkpoint(other,inspected.run.identity.runId,distinctFence);await artifacts.receipt(other,inspected.run.identity.runId,{...distinctFence,treeDigest:artifactHash([])});
  await assert.rejects(artifacts.receipt(actor,inspected.run.identity.runId,{...distinctFence,treeDigest:artifactHash([])}),actorDenied);

  // Install old exact A, then B. Only A's release row is held during rollback.
  const oldManifest={name:"composed-alpha",title:"composed-alpha",summary:"Baseline-only release",version:"1.0.0",license:"Apache-2.0",visibility:"public" as const,platforms:[{name:"codex",install_target:"codex-skill",status:"supported" as const}],tags:[]};
  const oldSubmission=await submissions.createSubmission({actor:{id:actor.id,roles:["author"]},manifest:oldManifest,files:[{path:"skill.json",content:JSON.stringify(oldManifest)},{path:"SKILL.md",content:"---\nname: composed-alpha\ndescription: Baseline fixture\n---\nOld exact A\n"}]});
  await submissions.performReviewAction({actor:{id:actor.id,roles:["maintainer"]},submissionId:oldSubmission.id,action:"approve",artifactSha256:oldSubmission.artifact.sha256});await submissions.performReviewAction({actor:{id:actor.id,roles:["maintainer"]},submissionId:oldSubmission.id,action:"publish"});
  const oldSpec=structuredClone(spec);oldSpec.skills=oldSpec.skills.map(ref=>ref.slug==="composed-alpha"?{...ref,version:"1.0.0",digest:oldSubmission.artifact.sha256}:ref);
  const oldRevision=await architectures.createRevision({actor:actor.id,architectureId:architecture.id,expectedCurrentRevisionId:revision.id,message:"Baseline A",spec:oldSpec});assert.ok(oldRevision);
  const {prepared:oldArtifact}=await prepareOrganization(oldRevision.id,null,"baseline-a");
  const oldInput={expectedIntentDigest:oldArtifact.intentDigest,treeDigest:oldArtifact.intent.treeDigest,baselineDigest:oldArtifact.intent.baselineDigest};
  await artifacts.approve(actor,oldArtifact.run.identity.runId,oldInput);const oldClaim=await artifacts.claim(actor,oldArtifact.run.identity.runId,{holderId:"baseline-holder",expectedIntentDigest:oldArtifact.intentDigest});await artifacts.receipt(actor,oldArtifact.run.identity.runId,{holderId:"baseline-holder",fencingToken:oldClaim.run.lease!.fencingToken,treeDigest:oldArtifact.intent.treeDigest});
  const newRevision=await architectures.createRevision({actor:actor.id,architectureId:architecture.id,expectedCurrentRevisionId:oldRevision.id,message:"Desired B",spec});assert.ok(newRevision);
  const {prepared:updated}=await prepareOrganization(newRevision.id,oldArtifact.run.identity.runId,"desired-b");const updatedId=updated.run.identity.runId,updatedInput={expectedIntentDigest:updated.intentDigest,treeDigest:updated.intent.treeDigest,baselineDigest:updated.intent.baselineDigest};
  await artifacts.approve(actor,updatedId,updatedInput);const updateClaim=await artifacts.claim(actor,updatedId,{holderId:"update-holder",expectedIntentDigest:updated.intentDigest});await artifacts.receipt(actor,updatedId,{holderId:"update-holder",fencingToken:updateClaim.run.lease!.fencingToken,treeDigest:updated.intent.treeDigest});
  let rollbackFence:{holderId:string;fencingToken:number}|undefined;
  for(const boundary of ["approval","checkpoint","receipt"] as const) {
    const before=await store.getRun(updatedId),beforeLease=await store.getCurrentLease(organizationTarget.id);
    const baselineBlocker=await pool.connect();await baselineBlocker.query("BEGIN");await baselineBlocker.query("SELECT id FROM skill_versions WHERE skill_id=(SELECT id FROM skills WHERE slug='composed-alpha') AND version='1.0.0' FOR UPDATE");const blockingPid=(await baselineBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",[otherSession]);
    const pending=boundary==="approval"?artifacts.rollback(other,updatedId,{...updatedInput,holderId:"baseline-rollback"}):boundary==="checkpoint"?artifacts.checkpoint(other,updatedId,rollbackFence!):artifacts.receipt(other,updatedId,{...rollbackFence!,treeDigest:oldArtifact.intent.treeDigest});
    const settled=pending.then(value=>({value}),error=>({error}));
    try {
      await waitForActualBlock(pool,blockingPid);
      await waitForDatabaseDeadline(pool,async()=>Boolean((await pool.query("SELECT expires_at<=clock_timestamp() AS elapsed FROM auth_sessions WHERE id=$1",[otherSession])).rows[0].elapsed));
      await baselineBlocker.query("COMMIT");const denied=await settled;assert.ok("error" in denied);assert.equal((denied as {error:AppError}).error.code,"MFA_VERIFICATION_REQUIRED");
      assert.deepEqual(await store.getRun(updatedId),before);assert.deepEqual(await store.getCurrentLease(organizationTarget.id),beforeLease);
    } finally {await baselineBlocker.query("ROLLBACK");baselineBlocker.release();await pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour',mfa_verified_at=clock_timestamp() WHERE id=$1",[otherSession]);}
    if(boundary==="approval"){const allowed=await artifacts.rollback(other,updatedId,{...updatedInput,holderId:"baseline-rollback"});rollbackFence={holderId:"baseline-rollback",fencingToken:allowed.run.lease!.fencingToken};}
  }
  await artifacts.receipt(other,updatedId,{...rollbackFence!,treeDigest:oldArtifact.intent.treeDigest});

  // Both unchanged policy ceilings use actual post-lock time. The real lock
  // crosses the closing UTC minute; approval/claim/receipt remain denied after it.
  let clock=new Date((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now);
  if(60_000-clock.getUTCSeconds()*1000-clock.getUTCMilliseconds()<10_000){await new Promise(resolve=>setTimeout(resolve,10_050));clock=new Date((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now);}
  const utcMinute=clock.getUTCHours()*60+clock.getUTCMinutes();
  const policyClock=new Date(clock.getTime()+(utcMinute<14?12*60*60_000:0));
  const startMinute=policyClock.getUTCHours()*60+policyClock.getUTCMinutes()-14, closes=new Date(clock.getTime()).setUTCSeconds(0,0)+60_000;
  const window={...defaultSkillUpgradePolicyV1,mode:"maintenance-window" as const,maintenanceWindow:{timeZone:utcMinute<14?"Etc/GMT-12":"UTC",daysOfWeek:[policyClock.getUTCDay()],startMinute,durationMinutes:15}};
  await pool.query("UPDATE organization_memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2",[organizationId,actor.id]);
  const policies=new SkillUpgradePolicyService(new PostgresSkillUpgradePolicyStore(db));
  for(const [scopeType,scopeId] of [["organization",organizationId],["target",organizationTarget.id]] as const)await policies.append({actorUserId:actor.id,scopeType,scopeId,expectedRevisionNumber:0,policy:window});
  const {prepared:windowCandidate}=await prepareOrganization(newRevision.id,null,"window-execution"),{prepared:unclaimedWindow}=await prepareOrganization(newRevision.id,null,"window-unclaimed");
  const executionInput=(value:typeof windowCandidate)=>({expectedIntentDigest:value.intentDigest,treeDigest:value.intent.treeDigest,baselineDigest:value.intent.baselineDigest});
  await artifacts.approve(actor,windowCandidate.run.identity.runId,executionInput(windowCandidate));await artifacts.approve(actor,unclaimedWindow.run.identity.runId,executionInput(unclaimedWindow));
  const windowClaim=await artifacts.claim(actor,windowCandidate.run.identity.runId,{holderId:"window-pg",expectedIntentDigest:windowCandidate.intentDigest});const windowFence={holderId:"window-pg",fencingToken:windowClaim.run.lease!.fencingToken};
  const windowBlocker=await pool.connect();await windowBlocker.query("BEGIN");await windowBlocker.query("SELECT id FROM skill_versions WHERE skill_id=(SELECT id FROM skills WHERE slug='composed-alpha') AND version='2.0.0' FOR UPDATE");const windowPid=(await windowBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const waitingWindow=artifacts.checkpoint(actor,windowCandidate.run.identity.runId,windowFence).then(value=>({value}),error=>({error}));
  try {
    await waitForActualBlock(pool,windowPid);assert.ok(new Date((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now).getTime()<closes,"the operation started before the real window closed");
    await waitForDatabaseDeadline(pool,async()=>new Date((await pool.query("SELECT clock_timestamp() AS now")).rows[0].now).getTime()>=closes);
    await windowBlocker.query("COMMIT");const closed=await waitingWindow;assert.ok("error" in closed);assert.equal((closed as {error:AppError}).error.code,"ARCHITECTURE_ARTIFACT_MAINTENANCE_WINDOW_CLOSED");
  } finally {await windowBlocker.query("ROLLBACK");windowBlocker.release();}
  const windowDenied=(error:unknown)=>error instanceof AppError&&error.code==="ARCHITECTURE_ARTIFACT_MAINTENANCE_WINDOW_CLOSED";
  await assert.rejects(artifacts.claim(actor,unclaimedWindow.run.identity.runId,{holderId:"late-claim",expectedIntentDigest:unclaimedWindow.intentDigest}),windowDenied);
  await assert.rejects(artifacts.receipt(actor,windowCandidate.run.identity.runId,{...windowFence,treeDigest:windowCandidate.intent.treeDigest}),windowDenied);
  assert.deepEqual(await store.getRun(windowCandidate.run.identity.runId),windowClaim.run);assert.equal((await store.getRun(unclaimedWindow.run.identity.runId))!.state,"approved");
  const outside=await prepareOrganization(newRevision.id,null,"outside-window");await assert.rejects(artifacts.approve(actor,outside.prepared.run.identity.runId,executionInput(outside.prepared)),windowDenied);

  // Historical reads still require this receiving grant, even for the personal
  // owner who keeps a separate real organization grant and the underlying rows.
  assert.equal((await plans.getPlan(actor,organizationReview.run.identity.runId)).run.identity.runId,organizationReview.run.identity.runId);
  assert.ok((await plans.listPlans(other,organizationTarget.id)).runs.length);assert.ok(await artifacts.inspect(other,organizationArtifact.run.identity.runId));
  await organizationTargets.setConsent({actor:actor.id,targetId:organizationTarget.id,decision:"deny"});
  assert.ok(await artifacts.inspect(other,organizationArtifact.run.identity.runId));assert.ok(await plans.getPlan(actor,organizationReview.run.identity.runId));
  const retained=await store.getRun(organizationArtifact.run.identity.runId);
  await pool.query("DELETE FROM skill_architecture_organization_grants WHERE architecture_id=$1 AND organization_id=$2",[architecture.id,organizationId]);
  const ownerAfterGrant=await architectures.getArchitecture(actor.id,architecture.id);assert.ok(ownerAfterGrant?.access.canManage);assert.ok(ownerAfterGrant.access.allowedOrganizationIds.includes(otherOrganization));assert.equal(ownerAfterGrant.access.allowedOrganizationIds.includes(organizationId),false);
  assert.ok(await targets.getTarget(actor.id,organizationTarget.id),"real target history still exists under current membership");
  for(const currentActor of [actor,other]){await assert.rejects(plans.getPlan(currentActor,organizationReview.run.identity.runId));await assert.rejects(plans.listPlans(currentActor,organizationTarget.id));await assert.rejects(artifacts.inspect(currentActor,organizationArtifact.run.identity.runId));}
  assert.deepEqual(await store.getRun(organizationArtifact.run.identity.runId),retained);
  // A held exact-release row makes executable work wait. The session expires
  // during that real wait; post-wait clock_timestamp must reject the write.
  const expiryReview=await plans.createPlan(actor,target.id,{revisionId:newRevision.id,expectedTargetGeneration:target.generation,expectedObservationId:observation.id!,expectedObservationDigest:observation.observedDigest,idempotencyKey:"post-grant-expiry-review"});
  await plans.approvePlan(actor,expiryReview.run.identity.runId,{expectedReviewDigest:String(expiryReview.run.metadata!.reviewDigest)});
  const expiring=await artifacts.prepare(actor,target.id,{reviewRunId:expiryReview.run.identity.runId,baselineRunId:null,idempotencyKey:"pg-expiry"});
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


async function waitForActualBlock(pool:ReturnType<typeof createPgPool>,blockingPid:number):Promise<void> {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline){const blocked=await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%skill_versions%'",[blockingPid]);if(blocked.rowCount)return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail("The exact independent baseline/release row did not block the operation");
}
async function waitForDatabaseDeadline(_pool:ReturnType<typeof createPgPool>,elapsed:()=>Promise<boolean>):Promise<void> {
  const deadline=Date.now()+70_000;
  while(Date.now()<deadline){if(await elapsed())return;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.fail("Actual database execution deadline was not reached");
}
