import { randomUUID } from "node:crypto";
import {
  AppError, artifactHash, architectureSyncPlanDigest, architectureSyncSnapshotDigest,
  createArchitectureArtifactIntent, projectArchitectureArtifact, renderArchitectureArtifact,
  composeSkillUpgradePolicies, compareSemanticVersions, isPrereleaseVersion, skillReleaseUpgradeRange,
  skillReleaseUpdateBlockers,
  type ArchitectureArtifactIntent, type ArchitectureSyncRun, type ArchitectureSyncRunState,
  type SkillUpgradePolicyConstraint, type ArtifactFile,
} from "@myskills-app/core";
import { validatePortableFilePaths } from "@myskills-app/skill-package";
import { ArchitecturePlanService, type ArchitecturePlanActor, type ArchitecturePlanDependencies } from "./plan-service.js";
import type { ArchitectureSyncStore } from "./types.js";

export interface PrepareArchitectureArtifactInput { reviewRunId: string; baselineRunId: string | null; idempotencyKey: string }
export interface ArtifactExecutionInput { expectedIntentDigest: string; treeDigest: string; baselineDigest: string }
export interface ArtifactFenceInput { fencingToken: number; holderId: string; treeDigest?: string }
const fail = (code: string, message: string) => new AppError(message, `ARCHITECTURE_ARTIFACT_${code}`, 409);

/** No filesystem executor. Every executable operation retains current authority. */
export class ArchitectureArtifactService {
  constructor(private readonly store: ArchitectureSyncStore, private readonly dependencies: ArchitecturePlanDependencies) {}

  private authority<T>(actor: ArchitecturePlanActor, targetId: string, work: (service: ArchitectureArtifactService) => Promise<T>): Promise<T> {
    if (!this.store.withArtifactAuthority) throw new AppError("Composed execution requires a shared authority transaction.", "ARCHITECTURE_ARTIFACT_AUTHORITY_REQUIRED", 503);
    return this.store.withArtifactAuthority({ actorId: actor.id, targetId }, (store, dependencies) => {
      if (!dependencies.authorityNow || !dependencies.artifactSubmissions || !dependencies.readPolicyConstraints) throw new AppError("Composed authority dependencies are unavailable.", "ARCHITECTURE_ARTIFACT_AUTHORITY_REQUIRED", 503);
      return work(new ArchitectureArtifactService(store, dependencies));
    });
  }
  private async now(): Promise<string> { return (await this.dependencies.authorityNow!()).toISOString(); }
  private async snapshot(actor: ArchitecturePlanActor, targetId: string, revisionId: string) {
    await this.dependencies.assertArtifactCredential?.(actor, false);
    const snapshot = await new ArchitecturePlanService(this.store, this.dependencies).artifactSnapshot(actor, targetId, revisionId);
    const target = snapshot.target;
    if (target.adapter.kind !== "codex-workspace" || target.adapter.version !== "1.0.0" || target.adapter.contractVersion !== 2
      || target.capabilities.apply !== true || target.capabilities.rollback !== true || target.capabilities["sync.write"] !== true) throw fail("CAPABILITY_REQUIRED", "The enrolled target does not support the composed workspace contract.");
    return snapshot;
  }
  private async load(runId: string) {
    identifier(runId);
    const run = await this.store.getRun(runId); const intent = await this.store.getArtifactIntent(runId);
    if (!run || run.metadata?.source !== "architecture-artifact" || run.metadata.reviewOnly !== false || !intent || run.metadata.artifactDigest !== artifactHash(intent)) throw new AppError("Composed artifact was not found.","ARCHITECTURE_ARTIFACT_NOT_FOUND",404);
    return { run, intent };
  }
  async inspect(actor: ArchitecturePlanActor, runId: string) {
    const loaded = await this.load(runId);
    // Retained history is inspectable after consent revocation. Current tenancy
    // still applies, including independent receiving-organization grants.
    const target = await this.dependencies.targetStore.getTarget(actor.id,loaded.run.identity.targetId);
    const architecture = target && await this.dependencies.architectureStore.getArchitecture(actor.id,target.architectureId);
    if (!target || !architecture?.access.canRead || target.owner.type === "organization" && !architecture.access.allowedOrganizationIds.includes(target.owner.id)) throw new AppError("Composed artifact was not found.","ARCHITECTURE_ARTIFACT_NOT_FOUND",404);
    if (target.owner.type === "organization") {
      const revision=await this.dependencies.architectureStore.getRevisionForPreview(actor.id,target.architectureId,loaded.run.identity.revisionId,target.owner.id);
      if (!revision || revision.spec.skills.some(ref=>!["public","authenticated","organization"].includes(ref.packageVisibility))) throw new AppError("Composed artifact was not found.","ARCHITECTURE_ARTIFACT_NOT_FOUND",404);
      for (const ref of revision.spec.skills) {
        const visible=await this.dependencies.releaseDependencies.skillRepository.getSkillVisibleToOrganizationBySlug(ref.slug,target.owner.id);
        const release=await this.dependencies.releaseDependencies.submissionService.getPublicRelease({slug:ref.slug,version:ref.version,actorId:actor.id});
        if (!visible || visible.visibility!==ref.packageVisibility || !release || release.artifact.sha256!==ref.digest) throw new AppError("Composed artifact was not found.","ARCHITECTURE_ARTIFACT_NOT_FOUND",404);
      }
    }
    return { ...loaded, intentDigest: artifactHash(loaded.intent), runtimeRecognized: false };
  }
  async prepare(actor: ArchitecturePlanActor, targetId: string, input: PrepareArchitectureArtifactInput) {
    fields(input,["reviewRunId","baselineRunId","idempotencyKey"]); identifier(targetId); identifier(input.reviewRunId); identifier(input.idempotencyKey); if(input.baselineRunId!==null) identifier(input.baselineRunId);
    return this.authority(actor,targetId,service=>service.prepareLocked(actor,targetId,input));
  }
  private async prepareLocked(actor: ArchitecturePlanActor, targetId: string, input: PrepareArchitectureArtifactInput) {
    const review = await new ArchitecturePlanService(this.store,this.dependencies).getPlan(actor,input.reviewRunId);
    if (review.run.identity.targetId !== targetId || review.run.state !== "approved" || !review.run.approval) throw fail("REVIEW_REQUIRED","A saved, explicitly approved review for this target is required.");
    const snapshot = await this.snapshot(actor,targetId,review.run.identity.revisionId);
    for(const [key,value] of Object.entries(snapshot.metadata)) if(key!=="reviewDigest" && review.run.metadata?.[key]!==value) throw fail("REVIEW_STALE","Reviewed target authority changed. Create a fresh review.");
    let baseline: {runId:string;intent:ArchitectureArtifactIntent}|null=null;
    if(input.baselineRunId) {
      const prior=await this.load(input.baselineRunId);
      if(prior.run.identity.targetId!==targetId || prior.run.state!=="succeeded" || prior.intent.projection.targetIdentityDigest!==snapshot.target.identityDigest) throw fail("BASELINE_CONFLICT","Baseline must be a completed artifact of this exact workspace.");
      baseline={runId:input.baselineRunId,intent:prior.intent};
    }
    const built=await this.materialize(actor,snapshot,baseline?.intent ?? null);
    const intent=createArchitectureArtifactIntent(built.projection,input.reviewRunId,built.files,baseline);
    await this.dependencies.assertArtifactCredential?.(actor,false,"intent");
    const digest=artifactHash(intent); const key=`artifact-${artifactHash({actorId:actor.id,targetId,key:input.idempotencyKey}).slice(0,40)}`;
    const timestamp=await this.now();
    const run: ArchitectureSyncRun = {schemaVersion:1,identity:{schemaVersion:1,runId:key,targetId,targetGeneration:snapshot.target.generation,architectureId:snapshot.target.architectureId,revisionId:snapshot.revision.id,profileId:snapshot.target.profileId,environmentId:snapshot.target.environmentId},state:"drafted",digests:{desiredDigest:built.projection.revisionDigest,compiledDigest:built.projection.compiledDigest,observedDigest:built.projection.observationDigest,planDigest:architectureSyncPlanDigest([])},steps:[],receipts:[],createdAt:timestamp,updatedAt:timestamp,metadata:{source:"architecture-artifact",reviewOnly:false,artifactDigest:digest}};
    const result=await this.store.createRun({actorId:actor.id,requestKey:key,idempotencyKey:key,intentDigest:digest,run});
    await this.store.setArtifactIntent(result.run.identity.runId,intent);
    return {run:result.run,intent,intentDigest:digest,replayed:result.decision==="duplicate",runtimeRecognized:false};
  }
  private async materialize(actor: ArchitecturePlanActor, snapshot: Awaited<ReturnType<ArchitectureArtifactService["snapshot"]>>, baseline: ArchitectureArtifactIntent|null, readPayload = true) {
    const submissions=this.dependencies.artifactSubmissions!;
    const constraintsValue=await this.dependencies.readPolicyConstraints!(snapshot.target) as {constraints?:SkillUpgradePolicyConstraint[]};
    const policies=(constraintsValue?.constraints ?? composeSkillUpgradePolicies({})).map(c=>c.policy);
    const packages=[]; const payloads=new Map<string,readonly ArtifactFile[]>();
    for(const ref of snapshot.compiled.skills) {
      const bundle=await submissions.getPublicRelease({slug:ref.slug,version:ref.version,actorId:actor.id});
      if(!bundle || bundle.artifact.sha256!==ref.digest || !bundle.platforms.some(p=>p.name==="codex"&&p.status==="supported") || bundle.lifecycleStatus!=="approved") throw fail("RELEASE_UNAVAILABLE","An exact supported approved release is unavailable.");
      const from=baseline?.projection.packages.find(p=>p.refId===ref.skillRefId&&p.slug===ref.slug)?.version;
      const allowed=(kind:typeof bundle.changeKind)=>policies.every(policy=>policy.allowedChangeKinds.includes(kind));
      if(policies.some(p=>Object.hasOwn(p.pins,ref.slug)&&p.pins[ref.slug]!==ref.version || !p.includePrerelease&&isPrereleaseVersion(ref.version)) || !allowed(bundle.changeKind)) throw fail("POLICY_DENIED","An exact release conflicts with current upgrade policy.");
      if(from&&compareSemanticVersions(from,ref.version)<0) {
        const history=await submissions.listSkillReleaseChangeHistory({slug:ref.slug,actorId:actor.id});
        if(skillReleaseUpgradeRange(history,from,ref.version).some(r=>!allowed(r.changeKind))) throw fail("POLICY_DENIED","An intervening release change kind conflicts with current policy.");
      }
      const blockers=skillReleaseUpdateBlockers(bundle,{installed:{version:from??"0.0.0",platform:"codex"},releases:[bundle],policy:{includePrerelease:true},client:{adapterContractVersion:snapshot.target.adapter.contractVersion,...(typeof snapshot.target.metadata?.myskillsVersion==="string"?{myskillsVersion:snapshot.target.metadata.myskillsVersion}:{})}});
      // User action is explicit in execution approval; compatibility is mandatory.
      if(blockers.length) throw fail("RELEASE_INCOMPATIBLE","The target does not meet the exact release compatibility contract.");
      if (readPayload) {
        const downloaded=await submissions.getPublicBundle({slug:ref.slug,version:ref.version,platform:"codex",actorId:actor.id});
        if (!downloaded || downloaded.artifact.sha256!==bundle.artifact.sha256 || downloaded.artifact.byteSize!==bundle.artifact.byteSize) throw fail("RELEASE_UNAVAILABLE","Exact release bytes changed during materialization.");
        validatePortableFilePaths(downloaded.payload.files);
        if(!downloaded.payload.files.some(file=>file.path==="SKILL.md"))throw fail("FEATURE_UNSUPPORTED","Exact Codex instructions are missing from the approved package.");
        if(downloaded.payload.files.some(file=>typeof file.content!=="string" || /^(?:agents\/openai\.ya?ml|\.codex\/|\.agents\/)/i.test(file.path))) throw fail("FEATURE_UNSUPPORTED","Required provider configuration cannot be preserved by this renderer.");
        payloads.set(ref.skillRefId,downloaded.payload.files);
      }
      packages.push({refId:ref.skillRefId,slug:ref.slug,version:ref.version,digest:ref.digest,size:bundle.artifact.byteSize,platform:"codex" as const});
    }
    const m=snapshot.metadata; const projection=projectArchitectureArtifact(snapshot.compiled,{revisionId:snapshot.revision.id,targetId:snapshot.target.id,generation:snapshot.target.generation,targetIdentityDigest:snapshot.target.identityDigest,adapterDigest:String(m.adapterDigest),capabilitiesDigest:String(m.capabilitiesDigest),profileId:snapshot.target.profileId,environmentId:snapshot.target.environmentId,policyDigest:String(m.policyDigest),consentDigest:String(m.consentDigest),observationId:snapshot.observation.id!,observationDigest:snapshot.observation.observedDigest,packages});
    const files=readPayload ? renderArchitectureArtifact(projection,payloads) : []; validatePortableFilePaths(files); return {projection,files};
  }
  private async revalidate(actor: ArchitecturePlanActor, run: ArchitectureSyncRun, intent: ArchitectureArtifactIntent, rollback=false) {
    const snapshot=await this.snapshot(actor,run.identity.targetId,run.identity.revisionId);
    const baseline=intent.baselineRunId ? (await this.load(intent.baselineRunId)).intent : null;
    const current=await this.materialize(actor,snapshot,baseline,false);
    await this.dependencies.assertArtifactCredential?.(actor, true);
    if (!rollback && run.approval?.expiresAt && Date.parse(run.approval.expiresAt) <= Date.parse(await this.now())) throw fail("APPROVAL_EXPIRED", "Execution approval expired after current-authority checks.");
    if(artifactHash(current.projection)!==artifactHash(intent.projection)) throw fail("AUTHORITY_STALE","Current target, observation, policy, consent or release authority changed.");
    if(rollback&&baseline) {
      const previous=await this.snapshot(actor,run.identity.targetId,baseline.projection.revisionId);
      const eligible=await this.materialize(actor,previous,null,false);
      // Old observation/policy context remains exact bytes, but active topology
      // and release pins must still satisfy today's receiving-target authority.
      if(artifactHash(eligible.projection.nodes)!==artifactHash(baseline.projection.nodes) || artifactHash(eligible.projection.packages)!==artifactHash(baseline.projection.packages)) throw fail("ROLLBACK_DENIED","Baseline exposure or exact releases are now forbidden. Retain quarantine.");
    }
  }
  async approve(actor: ArchitecturePlanActor, runId: string, input: ArtifactExecutionInput) {
    validateExecution(input); const loaded=await this.load(runId);
    return this.authority(actor,loaded.run.identity.targetId,async service=>{
      const {run:initialRun,intent}=await service.load(runId); let run=initialRun; bindExecution(intent,input); await service.revalidate(actor,run,intent);
      if(run.approval) { if(run.approval.actorId!==actor.id) throw fail("APPROVAL_CONFLICT","Another actor owns execution approval."); return {run,replayed:true}; }
      if(run.state!=="drafted") throw fail("STATE_CONFLICT","Artifact is not awaiting execution approval.");
      run=await service.store.saveRun({...run,state:"awaiting_approval",updatedAt:await service.now()});
      const approval={schemaVersion:1 as const,id:`execution-${randomUUID()}`,runId,actorId:actor.id,planDigest:run.digests.planDigest,approvedAt:await service.now(),expiresAt:new Date(Date.parse(await service.now())+600_000).toISOString(),metadata:{artifactDigest:artifactHash(intent),treeDigest:intent.treeDigest,baselineDigest:intent.baselineDigest,execution:true}};
      run=await service.store.saveRun({...run,state:"approved",approval,digests:{...run.digests,approvalDigest:architectureSyncSnapshotDigest(approval)},receipts:[...run.receipts,{schemaVersion:1,id:`execution-receipt-${randomUUID()}`,runId,kind:"approval",status:"succeeded",code:"artifact.execution.approved",recordedAt:await service.now(),evidenceDigest:artifactHash(intent)}],updatedAt:await service.now()});
      return {run,replayed:false};
    });
  }
  async claim(actor: ArchitecturePlanActor,runId:string,input:{holderId:string;expectedIntentDigest:string}) {
    fields(input,["holderId","expectedIntentDigest"]); identifier(input.holderId); hash(input.expectedIntentDigest); const loaded=await this.load(runId);
    return this.authority(actor,loaded.run.identity.targetId,async service=>{
      const {run:initialRun,intent}=await service.load(runId); let run=initialRun;
      if(input.expectedIntentDigest!==artifactHash(intent) || !run.approval || run.approval.actorId!==actor.id) throw fail("APPROVAL_REQUIRED","The exact actor execution approval is required.");
      await service.revalidate(actor,run,intent);
      const result=await service.store.claimApply({runId,targetId:run.identity.targetId,targetGeneration:run.identity.targetGeneration,holderId:input.holderId,now:await service.now(),leaseSeconds:600});
      if(result.decision!=="claimed") return result;
      run=await service.store.saveRun({...result.run,state:"preparing",updatedAt:await service.now()});
      run=await service.store.saveRun({...run,state:"applying",updatedAt:await service.now()});
      return {decision:"claimed" as const,run};
    });
  }
  private async assertFence(actor: ArchitecturePlanActor,run:ArchitectureSyncRun,intent:ArchitectureArtifactIntent,input:ArtifactFenceInput,rollback=false) {
    await this.revalidate(actor,run,intent,rollback);
    const lease=await this.store.getCurrentLease(run.identity.targetId);
    if(!lease||lease.runId!==run.identity.runId||lease.holderId!==input.holderId||lease.fencingToken!==input.fencingToken||Date.parse(lease.expiresAt)<=Date.parse(await this.now())) throw fail("FENCE_LOST","The composed target lease is no longer current.");
    return lease;
  }
  async checkpoint(actor:ArchitecturePlanActor,runId:string,input:ArtifactFenceInput) {
    validateFence(input); const loaded=await this.load(runId);
    return this.authority(actor,loaded.run.identity.targetId,async service=>{const {run,intent}=await service.load(runId); if(!["applying","verifying","rolling_back"].includes(run.state)) throw fail("STATE_CONFLICT","Artifact has no active local operation."); const lease=await service.assertFence(actor,run,intent,input,run.state==="rolling_back"); return {run,lease,runtimeRecognized:false};});
  }
  async receipt(actor:ArchitecturePlanActor,runId:string,input:Required<ArtifactFenceInput>) {
    validateFence(input); hash(input.treeDigest); const loaded=await this.load(runId);
    return this.authority(actor,loaded.run.identity.targetId,async service=>{
      const {run:initialRun,intent}=await service.load(runId); let run=initialRun; const rollback=run.state==="rolling_back"||run.state==="rolled_back";
      const expected=rollback?(intent.baselineRunId?(await service.load(intent.baselineRunId)).intent.treeDigest:artifactHash([])):intent.treeDigest;
      if(input.treeDigest!==expected) throw fail("READBACK_CONFLICT","Aggregate readback differs from the approved tree.");
      if(run.state==="succeeded"||run.state==="rolled_back") { await service.revalidate(actor,run,intent,rollback); const previous=run.receipts.at(-1); if(previous?.metadata?.holderId!==input.holderId||previous.metadata.fence!==input.fencingToken) throw fail("FENCE_LOST","Receipt replay belongs to a different claim."); return {run,replayed:true}; }
      await service.assertFence(actor,run,intent,input,rollback);
      if(!rollback) { if(run.state!=="applying"&&run.state!=="verifying") throw fail("STATE_CONFLICT","Artifact is not applying."); if(run.state==="applying") run=await service.store.saveRun({...run,state:"verifying",updatedAt:await service.now()}); }
      run=await service.store.saveRun({...run,state:rollback?"rolled_back":"succeeded",receipts:[...run.receipts,{schemaVersion:1,id:`artifact-readback-${randomUUID()}`,runId,kind:rollback?"rollback":"verify",status:"succeeded",code:rollback?"artifact.rollback.verified":"artifact.aggregate.verified",recordedAt:await service.now(),evidenceDigest:input.treeDigest,metadata:{holderId:input.holderId,fence:input.fencingToken,runtimeRecognized:false}}],updatedAt:await service.now()});
      await service.store.releaseLease({targetId:run.identity.targetId,runId,fencingToken:input.fencingToken}); return {run,replayed:false};
    });
  }
  async rollback(actor:ArchitecturePlanActor,runId:string,input:ArtifactExecutionInput&{holderId:string}) {
    fields(input,["expectedIntentDigest","treeDigest","baselineDigest","holderId"]); identifier(input.holderId); const loaded=await this.load(runId);
    return this.authority(actor,loaded.run.identity.targetId,async service=>{
      const {run:initialRun,intent}=await service.load(runId); let run=initialRun; bindExecution(intent,input); await service.revalidate(actor,run,intent,true);
      if(!["succeeded","applying","verifying","rollback_required","rolling_back"].includes(run.state)) throw fail("STATE_CONFLICT","Artifact cannot begin an explicit rollback.");
      const active=await service.store.getCurrentLease(run.identity.targetId);
      if(active&&active.runId===runId&&active.holderId===input.holderId&&run.state!=="rolling_back") await service.store.releaseLease({targetId:run.identity.targetId,runId,fencingToken:active.fencingToken});
      if (run.state==="rolling_back" && active?.runId===runId && active.holderId===input.holderId) {
        await service.assertFence(actor,run,intent,{holderId:input.holderId,fencingToken:active.fencingToken},true);
        return {run,intent,baseline:intent.baselineRunId?(await service.load(intent.baselineRunId)).intent:null};
      }
      const lease=await service.store.acquireLease({runId,targetId:run.identity.targetId,targetGeneration:run.identity.targetGeneration,holderId:input.holderId,now:await service.now(),leaseSeconds:600});
      const receipt={schemaVersion:1 as const,id:`rollback-approval-${randomUUID()}`,runId,kind:"approval" as const,status:"succeeded" as const,code:"artifact.rollback.approved",recordedAt:await service.now(),evidenceDigest:artifactHash(intent),metadata:{actorId:actor.id,holderId:input.holderId,fence:lease.fencingToken,baselineDigest:intent.baselineDigest}};
      if(run.state!=="rolling_back") { run=await service.store.saveRun({...run,state:"rollback_required",lease,receipts:[...run.receipts,receipt],updatedAt:await service.now()}); run=await service.store.saveRun({...run,state:"rolling_back",updatedAt:await service.now()}); }
      else run=await service.store.saveRun({...run,lease,receipts:[...run.receipts,receipt],updatedAt:await service.now()});
      return {run,intent,baseline:intent.baselineRunId?(await service.load(intent.baselineRunId)).intent:null};
    });
  }
}
function fields(input:unknown,allowed:string[]):asserts input is Record<string,unknown>{if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||allowed.some(k=>!Object.hasOwn(input,k)))throw new AppError("Artifact request is invalid.","INVALID_REQUEST_BODY",400);}
function identifier(value:unknown):asserts value is string{if(typeof value!=="string"||! /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))throw new AppError("Artifact identifier is invalid.","INVALID_REQUEST_BODY",400);}
function hash(value:unknown):asserts value is string{if(typeof value!=="string"||! /^[a-f0-9]{64}$/.test(value))throw new AppError("Artifact digest is invalid.","INVALID_REQUEST_BODY",400);}
function validateExecution(input:unknown):asserts input is ArtifactExecutionInput {fields(input,["expectedIntentDigest","treeDigest","baselineDigest"]);hash(input.expectedIntentDigest);hash(input.treeDigest);hash(input.baselineDigest);}
function validateFence(input:unknown):asserts input is ArtifactFenceInput {if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!["fencingToken","holderId","treeDigest"].includes(k)))throw new AppError("Artifact fence is invalid.","INVALID_REQUEST_BODY",400);const i=input as ArtifactFenceInput;identifier(i.holderId);if(!Number.isSafeInteger(i.fencingToken)||i.fencingToken<1)throw new AppError("Artifact fence is invalid.","INVALID_REQUEST_BODY",400);if(i.treeDigest!==undefined)hash(i.treeDigest);}
function bindExecution(intent:ArchitectureArtifactIntent,input:ArtifactExecutionInput){if(artifactHash(intent)!==input.expectedIntentDigest||intent.treeDigest!==input.treeDigest||intent.baselineDigest!==input.baselineDigest)throw fail("APPROVAL_CONFLICT","Approval must bind complete intent, baseline and staged tree.");}
/** Narrow journal transition for explicit, approved composed rollback. */
export function isApprovedArtifactRollbackTransition(previous:ArchitectureSyncRun,next:ArchitectureSyncRun):boolean {
  return previous.metadata?.source==="architecture-artifact"&&next.state==="rollback_required"&&(["succeeded","applying","verifying"] as ArchitectureSyncRunState[]).includes(previous.state)&&next.receipts.length===previous.receipts.length+1&&next.receipts.at(-1)?.code==="artifact.rollback.approved"&&next.receipts.at(-1)?.kind==="approval"&&next.receipts.at(-1)?.evidenceDigest===previous.metadata.artifactDigest&&Boolean(next.lease);
}
