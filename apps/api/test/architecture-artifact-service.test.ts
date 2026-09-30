import { hashSessionToken } from "@myskills-app/auth";
import assert from "node:assert/strict";
import test from "node:test";
import { AppError, artifactHash } from "@myskills-app/core";
import { ArchitectureArtifactService } from "../src/architecture-sync/artifact-service.js";
import { MemoryArchitectureSyncStore } from "../src/architecture-sync/memory-store.js";
import { createArchitectureArtifactFixture } from "./fixtures/architecture-artifact-fixture.js";

test("ordinary memory review cannot authorize composed execution; review stays immutable",async t=>{
  const f=await createArchitectureArtifactFixture(t);const review=await f.review();
  const dependencies={architectureStore:f.architectureStore,targetStore:f.targetStore,releaseDependencies:{skillRepository:f.skillRepository,submissionService:f.submissionService}};
  const plain=new ArchitectureArtifactService(new MemoryArchitectureSyncStore(),dependencies);
  await assert.rejects(plain.prepare(f.actor,f.target.id,{reviewRunId:review.identity.runId,baselineRunId:null,idempotencyKey:"denied"}),error=>error instanceof AppError&&error.code==="ARCHITECTURE_ARTIFACT_AUTHORITY_REQUIRED");
  const before=await f.store.getRun(review.identity.runId);
  const candidate=await f.artifacts.prepare(f.actor,f.target.id,{reviewRunId:review.identity.runId,baselineRunId:null,idempotencyKey:"composed"});
  assert.deepEqual(await f.store.getRun(review.identity.runId),before);assert.equal(candidate.run.approval,undefined);assert.equal(candidate.run.metadata!.reviewOnly,false);
  const input={expectedIntentDigest:candidate.intentDigest,treeDigest:candidate.intent.treeDigest,baselineDigest:candidate.intent.baselineDigest};
  await assert.rejects(f.artifacts.approve(f.actor,candidate.run.identity.runId,{...input,treeDigest:"0".repeat(64)}));
  const approvals=await Promise.all([1,2].map(()=>f.artifacts.approve(f.actor,candidate.run.identity.runId,input)));assert.equal(approvals.filter(x=>!x.replayed).length,1);
  const claims=await Promise.all([1,2].map(i=>f.artifacts.claim(f.actor,candidate.run.identity.runId,{holderId:`holder-${i}`,expectedIntentDigest:candidate.intentDigest})));assert.equal(claims.filter(x=>x.decision==="claimed").length,1);
  const run=claims.find(x=>x.decision==="claimed")!.run;
  await assert.rejects(f.artifacts.receipt(f.actor,run.identity.runId,{holderId:run.lease!.holderId,fencingToken:run.lease!.fencingToken,treeDigest:artifactHash([])}));
  f.advance(601_000);
  await assert.rejects(f.artifacts.checkpoint(f.actor,run.identity.runId,{holderId:run.lease!.holderId,fencingToken:run.lease!.fencingToken}));
  assert.notEqual((await f.store.getRun(run.identity.runId))!.state,"succeeded");
});

test("current policy, consent, observation and credential changes deny before execution and receipt",async t=>{
  for(const change of ["policy","consent","observation","credential"]){const f=await createArchitectureArtifactFixture(t);const review=await f.review();const candidate=await f.artifacts.prepare(f.actor,f.target.id,{reviewRunId:review.identity.runId,baselineRunId:null,idempotencyKey:change});
    await f.coordinator.run(async()=>{if(change==="policy")f.policy.revision++;if(change==="consent")await f.targetService.setConsent({actor:f.ownerId,targetId:f.target.id,decision:"deny"});if(change==="observation")await f.appendObservation();if(change==="credential")f.denyCredential();});
    const before=await f.store.getRun(candidate.run.identity.runId);
    await assert.rejects(f.artifacts.approve(f.actor,candidate.run.identity.runId,{expectedIntentDigest:candidate.intentDigest,treeDigest:candidate.intent.treeDigest,baselineDigest:candidate.intent.baselineDigest}));assert.deepEqual(await f.store.getRun(candidate.run.identity.runId),before);assert.equal(await f.store.getCurrentLease(f.target.id),null);
  }
});

test("current boundaries authorize metadata without repeating full artifact downloads or access audits",async t=>{
  const f=await createArchitectureArtifactFixture(t);let downloads=0;const original=f.submissionService.getPublicBundle.bind(f.submissionService);
  f.submissionService.getPublicBundle=async input=>{downloads++;return original(input);};
  const review=await f.review();const candidate=await f.artifacts.prepare(f.actor,f.target.id,{reviewRunId:review.identity.runId,baselineRunId:null,idempotencyKey:"counted"});
  const count=downloads;assert.equal(count,candidate.intent.projection.packages.length);
  await f.artifacts.approve(f.actor,candidate.run.identity.runId,{expectedIntentDigest:candidate.intentDigest,treeDigest:candidate.intent.treeDigest,baselineDigest:candidate.intent.baselineDigest});
  const claim=await f.artifacts.claim(f.actor,candidate.run.identity.runId,{holderId:"counted-holder",expectedIntentDigest:candidate.intentDigest});const fence={holderId:"counted-holder",fencingToken:claim.run.lease!.fencingToken};
  for(let i=0;i<20;i++)await f.artifacts.checkpoint(f.actor,candidate.run.identity.runId,fence);
  await f.artifacts.receipt(f.actor,candidate.run.identity.runId,{...fence,treeDigest:candidate.intent.treeDigest});
  await f.artifacts.rollback(f.actor,candidate.run.identity.runId,{expectedIntentDigest:candidate.intentDigest,treeDigest:candidate.intent.treeDigest,baselineDigest:candidate.intent.baselineDigest,holderId:"rollback-holder"});
  assert.equal(downloads,count);
});

test("review create and approve reject credential revocation after an API snapshot wait without journal writes",async t=>{
  for(const action of ["create","approve"]){
    const f=await createArchitectureArtifactFixture(t);const review=action==="approve"?await f.review():null;const before=await f.store.listRuns({targetId:f.target.id});
    const original=f.architectureStore.getRevisionForPreview.bind(f.architectureStore);let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});const wait=new Promise<void>(resolve=>{resume=resolve;});let armed=true;
    f.architectureStore.getRevisionForPreview=async(...args)=>{const value=await original(...args);if(armed){armed=false;enter();await wait;}return value;};
    const pending=f.app.inject({method:"POST",url:review?`/v1/architecture-plans/${review.identity.runId}/approve`:`/v1/architecture-targets/${f.target.id}/plans`,headers:{authorization:`Bearer ${f.sessions.owner}`},payload:review?{expectedReviewDigest:String(review.metadata!.reviewDigest)}:{...f.request,idempotencyKey:"revoked-review"}});
    await entered;await f.authStore.revokeSessionByTokenHash(hashSessionToken(f.sessions.owner));resume();const response=await pending;assert.ok(response.statusCode>=400);assert.deepEqual(await f.store.listRuns({targetId:f.target.id}),before);
  }
});
