import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, link, rename, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactGeneratedName, artifactPrivateRoot, type ArchitectureArtifactIntent } from "@myskills-app/core";
import { runCli, type CliRuntime } from "../src/cli.js";
import { createArchitectureArtifactFixture } from "../../api/test/fixtures/architecture-artifact-fixture.js";

async function setup(t:Parameters<typeof createArchitectureArtifactFixture>[0]){
  const fixture=await createArchitectureArtifactFixture(t);const temp=await mkdtemp(path.join(os.tmpdir(),"myskills-composed-fixture-"));t.after(()=>rm(temp,{recursive:true,force:true}));
  const output:string[]=[];const errors:string[]=[];const runtime:CliRuntime={env:{HOME:temp,MYSKILLS_TOKEN:fixture.sessions.owner},io:{stdout:text=>output.push(text),stderr:text=>errors.push(text)},fetch:async(input,init)=>{const u=new URL(String(input));const res=await fixture.app.inject({method:(init?.method??"GET") as "GET"|"POST",url:u.pathname+u.search,headers:init?.headers,...(init?.body?{payload:JSON.parse(String(init.body))}:{})});return new Response(res.body,{status:res.statusCode,headers:res.headers as Record<string,string>});}} as CliRuntime;
  async function cli(args:string[],workspace:string){output.length=0;errors.length=0;const code=await runCli([...args,"--workspace",workspace,"--api-url","http://fixture.test","--json"],runtime);return {code,output:output.length?JSON.parse(output.at(-1)!):null,error:errors.join("\n")};}
  async function enroll(name:string,profileId=fixture.target.profileId,environmentId=fixture.target.environmentId){const workspace=path.join(temp,name);await mkdir(workspace);const result=await cli(["codex","enroll","--architecture-id",fixture.target.architectureId,"--environment-id",environmentId,"--profile-id",profileId],workspace);assert.equal(result.code,0,result.error);const observed=await cli(["codex","observe","--upload"],workspace);assert.equal(observed.code,0,observed.error);return {workspace,targetId:result.output.targetId as string};}
  async function artifact(targetId:string,baselineRunId:string|null=null,revisionId=fixture.revision.id){const review=await fixture.review(targetId,revisionId);const result=await fixture.artifacts.prepare(fixture.actor,targetId,{reviewRunId:review.identity.runId,baselineRunId,idempotencyKey:`artifact-${crypto.randomUUID()}`});return result;}
  return {fixture,temp,runtime,cli,enroll,artifact};
}
async function assertBytes(workspace:string,intent:ArchitectureArtifactIntent){for(const file of intent.files){const bytes=await readFile(path.join(workspace,file.path));assert.equal(bytes.length,file.size);const {createHash}=await import("node:crypto");assert.equal(createHash("sha256").update(bytes).digest("hex"),file.digest);}for(const node of intent.projection.disabledNodeIds)await assert.rejects(readFile(path.join(workspace,".agents/skills",artifactGeneratedName(intent.projection.architectureId,node),"SKILL.md")),{code:"ENOENT"});}

test("two explicitly enrolled workspaces install/verify/update/rollback composed multilevel trees with mixed pins and isolated approvals",async t=>{
  const s=await setup(t);const profiles=structuredClone(s.fixture.spec);profiles.profiles.push({...structuredClone(profiles.profiles[0]),id:"second-personal",bindings:profiles.profiles[0].bindings.map(binding=>binding.nodeId==="leaf-plan-beta"?{...binding,enabled:false,runtimeExposure:"disabled" as const}:binding.nodeId==="leaf-plan-denied"?{...binding,enabled:true,runtimeExposure:"leaf" as const}:{...binding})});profiles.environments.push({id:"second-workspace",name:"Second fixture workspace",kind:"personal",profileId:"second-personal"});
  const selected=await s.fixture.coordinator.run(()=>s.fixture.architectureStore.createRevision({actor:s.fixture.ownerId,architectureId:profiles.id,expectedCurrentRevisionId:s.fixture.revision.id,message:"Independent profile denials",spec:profiles}));assert.ok(selected);
  const a=await s.enroll("one");const b=await s.enroll("two","second-personal","second-workspace");assert.notEqual(a.targetId,b.targetId);
  for (const enrolled of [a,b]) {
    await mkdir(path.join(enrolled.workspace,".agents/skills/unrelated"));
    await writeFile(path.join(enrolled.workspace,".agents/skills/unrelated/SKILL.md"),"Unrelated discovery bytes\n");
    await writeFile(path.join(enrolled.workspace,"keep.txt"),"Unrelated workspace bytes\n");
  }
  async function unrelated() { for(const enrolled of [a,b]) {
    assert.equal(await readFile(path.join(enrolled.workspace,".agents/skills/unrelated/SKILL.md"),"utf8"),"Unrelated discovery bytes\n");
    assert.equal(await readFile(path.join(enrolled.workspace,"keep.txt"),"utf8"),"Unrelated workspace bytes\n");
  } }
  const firstA=await s.artifact(a.targetId,null,selected.id);const firstB=await s.artifact(b.targetId,null,selected.id);
  assert.notDeepEqual(firstA.intent.projection.disabledNodeIds,firstB.intent.projection.disabledNodeIds);
  assert.notEqual(firstA.run.identity.runId,firstB.run.identity.runId);assert.notEqual(firstA.intent.projection.observationId,firstB.intent.projection.observationId);
  assert.deepEqual(firstA.intent.projection.packages.map(p=>p.version),["2.0.0","1.0.0"]);
  for(const [workspace,candidate]of [[a.workspace,firstA],[b.workspace,firstB]] as const){assert.equal((await s.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],workspace)).code,0);const applied=await s.cli(["architecture-artifacts","apply",candidate.run.identity.runId],workspace);assert.equal(applied.code,0,applied.error);assert.equal(applied.output.run.state,"succeeded");assert.equal(applied.output.runtimeRecognized,false);assert.equal((await s.cli(["architecture-artifacts","verify",candidate.run.identity.runId],workspace)).code,0);await assertBytes(workspace,candidate.intent);await unrelated();}
  assert.equal((await s.cli(["architecture-artifacts","prepare",firstA.run.identity.runId],b.workspace)).code,1);
  const beforeA=await s.fixture.store.getRun(firstA.run.identity.runId);const beforeB=await s.fixture.store.getRun(firstB.run.identity.runId);assert.notEqual(beforeA!.approval!.id,beforeB!.approval!.id);assert.notEqual(beforeA!.lease!.runId,beforeB!.lease!.runId);assert.notEqual(beforeA!.lease!.holderId,beforeB!.lease!.holderId);assert.notEqual(beforeA!.receipts.at(-1)!.id,beforeB!.receipts.at(-1)!.id);
  const spec=structuredClone(profiles);spec.nodes.find(n=>n.kind==="router")!.label="Changed ordered router context";
  const revision=await s.fixture.coordinator.run(()=>s.fixture.architectureStore.createRevision({actor:s.fixture.ownerId,architectureId:spec.id,expectedCurrentRevisionId:selected.id,message:"Router context update",spec}));assert.ok(revision);
  for(const [workspace,prior,targetId] of [[a.workspace,firstA,a.targetId],[b.workspace,firstB,b.targetId]] as const){const update=await s.artifact(targetId,prior.run.identity.runId,revision.id);assert.notEqual(update.intent.treeDigest,prior.intent.treeDigest);assert.equal((await s.cli(["architecture-artifacts","prepare",update.run.identity.runId],workspace)).code,0);const apply=await s.cli(["architecture-artifacts","apply",update.run.identity.runId],workspace);assert.equal(apply.code,0,apply.error);await assertBytes(workspace,update.intent);const rollback=await s.cli(["architecture-artifacts","rollback",update.run.identity.runId],workspace);assert.equal(rollback.code,0,rollback.error);assert.equal(rollback.output.run.state,"rolled_back");await assertBytes(workspace,prior.intent);await unrelated();}
});

test("each journal move, manifest and lost receipt response is replayable without per-skill success",async t=>{
  for(const point of ["staged","before-old-move","after-old-move","after-old-rename","after-new-rename","before-new-move","after-new-move","manifest","receipt"] as const){
    const indexes=["staged","manifest","receipt"].includes(point)?[1]:[1,2,3,4,5,6];
    for(const position of indexes){
    const s=await setup(t);const {workspace,targetId}=await s.enroll(`fault-${point}-${position}`);
    const baseline=await s.artifact(targetId);await s.cli(["architecture-artifacts","prepare",baseline.run.identity.runId],workspace);const installed=await s.cli(["architecture-artifacts","apply",baseline.run.identity.runId],workspace);assert.equal(installed.code,0,installed.error);
    const candidate=await s.artifact(targetId,baseline.run.identity.runId);assert.equal(candidate.intent.placements.length,6);let occurrence=0;let armed=true;s.runtime.artifactFault=p=>{if(armed&&p===point&&++occurrence===position){armed=false;throw new Error(`fixture-${point}-${position}`);}};
    const stage=await s.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],workspace);if(point==="staged")assert.equal(stage.code,1);else assert.equal(stage.code,0,stage.error);
    const applied=await s.cli(["architecture-artifacts","apply",candidate.run.identity.runId],workspace);if(point!=="staged")assert.equal(applied.code,1,point);
    s.runtime.artifactFault=undefined;
    const retry=await s.cli(["architecture-artifacts",point==="receipt"?"verify":"apply",candidate.run.identity.runId],workspace);assert.equal(retry.code,0,`${point}: ${retry.error}`);await assertBytes(workspace,candidate.intent);
    const run=await s.fixture.store.getRun(candidate.run.identity.runId);assert.equal(run!.receipts.filter(r=>r.code==="artifact.aggregate.verified").length,1);
    }
  }
});

test("denied checkpoints/read helpers retain quarantine; collision, drift, link and replay attacks fail closed",async t=>{
  const s=await setup(t);const {workspace,targetId}=await s.enroll("attacks");const first=await s.artifact(targetId);await s.cli(["architecture-artifacts","prepare",first.run.identity.runId],workspace);assert.equal((await s.cli(["architecture-artifacts","apply",first.run.identity.runId],workspace)).code,0);
  const next=await s.artifact(targetId,first.run.identity.runId);assert.equal((await s.cli(["architecture-artifacts","prepare",next.run.identity.runId],workspace)).code,0);
  s.runtime.artifactFault=async point=>{if(point==="after-old-move"){s.runtime.artifactFault=undefined;await s.fixture.coordinator.run(()=>s.fixture.targetService.setConsent({actor:s.fixture.ownerId,targetId,decision:"deny"}));}};
  assert.equal((await s.cli(["architecture-artifacts","apply",next.run.identity.runId],workspace)).code,1);
  assert.equal((await s.cli(["architecture-artifacts","verify",next.run.identity.runId],workspace)).code,1);
  assert.equal((await s.cli(["architecture-artifacts","rollback",next.run.identity.runId],workspace)).code,1);
  await assert.rejects(readFile(path.join(workspace,artifactPrivateRoot(first.intent.projection.architectureId),"context.json")),{code:"ENOENT"});
  assert.notEqual((await s.fixture.store.getRun(next.run.identity.runId))!.state,"succeeded");
  for(const attack of ["collision","drift","symlink","hardlink"]){const x=await setup(t);const enrolled=await x.enroll(attack);const candidate=await x.artifact(enrolled.targetId);const owned=path.join(enrolled.workspace,candidate.intent.placements[1]);await mkdir(owned,{recursive:true});const file=path.join(owned,"SKILL.md");if(attack==="symlink")await symlink(path.join(x.temp,"outside"),file);else if(attack==="hardlink"){await writeFile(path.join(x.temp,"outside"),"unmanaged");await link(path.join(x.temp,"outside"),file);}else await writeFile(file,"unmanaged");const result=await x.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],enrolled.workspace);assert.equal(result.code,1,attack);}
});

test("router disable and leaf removal remove discovery and private payload, with forbidden baseline rollback quarantined",async t=>{
  const s=await setup(t);const {workspace,targetId}=await s.enroll("removals");const first=await s.artifact(targetId);await s.cli(["architecture-artifacts","prepare",first.run.identity.runId],workspace);assert.equal((await s.cli(["architecture-artifacts","apply",first.run.identity.runId],workspace)).code,0);
  const spec=structuredClone(s.fixture.spec);const removed="leaf-plan-alpha";spec.nodes=spec.nodes.filter(n=>n.id!==removed);spec.edges=spec.edges.filter(e=>e.from!==removed&&e.to!==removed);spec.skills=spec.skills.filter(ref=>ref.id!=="plan-alpha");
  const router=spec.nodes.find(n=>n.kind==="router")!.id;
  for(const profile of spec.profiles)profile.bindings=profile.bindings.filter(b=>b.nodeId!==removed).map(b=>b.nodeId===router?{...b,enabled:false,runtimeExposure:"disabled" as const}:b);
  const revision=await s.fixture.coordinator.run(()=>s.fixture.architectureStore.createRevision({actor:s.fixture.ownerId,architectureId:spec.id,expectedCurrentRevisionId:s.fixture.revision.id,message:"Remove and disable owned nodes",spec}));assert.ok(revision);
  const next=await s.artifact(targetId,first.run.identity.runId,revision.id);await s.cli(["architecture-artifacts","prepare",next.run.identity.runId],workspace);const applied=await s.cli(["architecture-artifacts","apply",next.run.identity.runId],workspace);assert.equal(applied.code,0,applied.error);await assertBytes(workspace,next.intent);
  for(const nodeId of [removed,router,"leaf-plan-beta"])await assert.rejects(readFile(path.join(workspace,".agents/skills",artifactGeneratedName(spec.id,nodeId),"SKILL.md")),{code:"ENOENT"});
  for(const oldFile of first.intent.files.filter(file=>file.path.includes("/payload/")))await assert.rejects(readFile(path.join(workspace,oldFile.path)),{code:"ENOENT"});
  assert.equal(next.intent.projection.packages.length,0);assert.equal((await s.cli(["architecture-artifacts","rollback",next.run.identity.runId],workspace)).code,1);await assertBytes(workspace,next.intent);
});

test("prepared baseline drift and replaced workspace root deny before approval; interrupted explicit rollback resumes",async t=>{
  const s=await setup(t);const {workspace,targetId}=await s.enroll("baseline");const first=await s.artifact(targetId);await s.cli(["architecture-artifacts","prepare",first.run.identity.runId],workspace);await s.cli(["architecture-artifacts","apply",first.run.identity.runId],workspace);
  const next=await s.artifact(targetId,first.run.identity.runId);await s.cli(["architecture-artifacts","prepare",next.run.identity.runId],workspace);
  const file=path.join(workspace,first.intent.files[0].path);const original=await readFile(file);await writeFile(file,"Fixture drift");assert.equal((await s.cli(["architecture-artifacts","apply",next.run.identity.runId],workspace)).code,1);assert.equal((await s.fixture.store.getRun(next.run.identity.runId))!.approval,undefined);await writeFile(file,original);
  assert.equal((await s.cli(["architecture-artifacts","apply",next.run.identity.runId],workspace)).code,0);
  let armed=true;s.runtime.artifactFault=p=>{if(armed&&p==="rollback-move"){armed=false;throw new Error("Fixture rollback interruption");}};assert.equal((await s.cli(["architecture-artifacts","rollback",next.run.identity.runId],workspace)).code,1);s.runtime.artifactFault=undefined;const retry=await s.cli(["architecture-artifacts","rollback",next.run.identity.runId],workspace);assert.equal(retry.code,0,retry.error);await assertBytes(workspace,first.intent);
  const root=await s.enroll("root-identity");const candidate=await s.artifact(root.targetId);await s.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],root.workspace);await rename(root.workspace,root.workspace+"-original");await mkdir(root.workspace);assert.equal((await s.cli(["architecture-artifacts","apply",candidate.run.identity.runId],root.workspace)).code,1);
});


test("overlapping and discovery-contained managed roots reject before registration, staging or approval", async t => {
  const s=await setup(t);const outer=await s.enroll("outer");const candidate=await s.artifact(outer.targetId);
  for (const relative of ["nested", ".agents/skills/nested", ".claude/skills/nested"]) {
    const workspace=path.join(outer.workspace,relative);await mkdir(workspace,{recursive:true});
    const enrollment=await s.cli(["codex","enroll","--architecture-id",s.fixture.target.architectureId,"--environment-id",s.fixture.target.environmentId,"--profile-id",s.fixture.target.profileId],workspace);
    assert.equal(enrollment.code,1,enrollment.error);assert.match(enrollment.error,/overlap|discovery tree/);
    await assert.rejects(readFile(path.join(workspace,".agents/skills/.myskills-app/codex-workspace.json")),{code:"ENOENT"});
    assert.equal((await s.fixture.store.getRun(candidate.run.identity.runId))!.approval,undefined);
  }
  // Historical overlapping enrollments must also fail when the outer executor is used.
  const inner=await s.enroll("legacy-inner");await rename(inner.workspace,path.join(outer.workspace,"historical-inner"));
  const denied=await s.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],outer.workspace);
  assert.equal(denied.code,1,denied.error);assert.match(denied.error,/enrolled descendant/);
  await assert.rejects(readdir(path.join(outer.workspace,".myskills-app/architectures")),{code:"ENOENT"});
  assert.equal((await s.fixture.store.getRun(candidate.run.identity.runId))!.approval,undefined);
  const parent=path.join(s.temp,"parent-of-enrolled");await mkdir(parent);const descendant=await s.enroll("enrolled-descendant");await rename(descendant.workspace,path.join(parent,"child"));
  const rejected=await s.cli(["codex","enroll","--architecture-id",s.fixture.target.architectureId,"--environment-id",s.fixture.target.environmentId,"--profile-id",s.fixture.target.profileId],parent);
  assert.equal(rejected.code,1);assert.match(rejected.error,/enrolled descendant/);
});

test("staging and recovery directory sync boundaries precede approval and destructive renames, including retry ancestry", async t => {
  const s=await setup(t);const {workspace,targetId}=await s.enroll("durable");const baseline=await s.artifact(targetId);
  const canonicalWorkspace=await realpath(workspace);
  let ancestryFailed=false;s.runtime.artifactDurability=event=>{if(!ancestryFailed&&event.phase==="before-sync"&&event.directory.includes("/transactions/")){ancestryFailed=true;throw new Error("transaction-ancestry-failed");}};
  assert.equal((await s.cli(["architecture-artifacts","prepare",baseline.run.identity.runId],workspace)).code,1);assert.equal(ancestryFailed,true);
  assert.equal((await s.fixture.store.getRun(baseline.run.identity.runId))!.approval,undefined);
  const synced:string[]=[];s.runtime.artifactDurability=event=>{if(event.phase==="after-sync")synced.push(event.directory);};
  assert.equal((await s.cli(["architecture-artifacts","prepare",baseline.run.identity.runId],workspace)).code,0);
  // Inspect observed paths instead of reconstructing namespace implementation.
  const nested=synced.find(directory=>directory.includes("/stage/")&&directory.endsWith("/references"));assert.ok(nested);
  assert.ok(synced.indexOf(nested)<synced.indexOf(path.dirname(nested)),"child directory entries are synced before the staging parent");
  assert.ok(synced.includes(canonicalWorkspace));assert.equal((await s.fixture.store.getRun(baseline.run.identity.runId))!.approval,undefined);
  assert.equal((await s.cli(["architecture-artifacts","apply",baseline.run.identity.runId],workspace)).code,0);
  const candidate=await s.artifact(targetId,baseline.run.identity.runId);let failed=false;
  s.runtime.artifactDurability=event=>{if(!failed&&event.phase==="before-sync"&&event.directory.includes("/stage/")&&event.directory.endsWith("/references")){failed=true;throw new Error("stage-durability-failed");}};
  const staged=await s.cli(["architecture-artifacts","prepare",candidate.run.identity.runId],workspace);assert.equal(staged.code,1,staged.error);assert.equal(failed,true);
  assert.equal((await s.fixture.store.getRun(candidate.run.identity.runId))!.approval,undefined);await assertBytes(workspace,baseline.intent);
  // A separate transaction exercises a failed recovery-ancestor sync, before any rename.
  s.runtime.artifactDurability=undefined;const update=await s.artifact(targetId,baseline.run.identity.runId);assert.equal((await s.cli(["architecture-artifacts","prepare",update.run.identity.runId],workspace)).code,0);
  s.runtime.artifactDurability=event=>{if(event.phase==="before-sync"&&event.directory.includes("/baseline/"))throw new Error("recovery-ancestry-failed");};
  const applied=await s.cli(["architecture-artifacts","apply",update.run.identity.runId],workspace);assert.equal(applied.code,1,applied.error);await assertBytes(workspace,baseline.intent);
  assert.equal((await s.fixture.store.getRun(update.run.identity.runId))!.receipts.some(receipt=>receipt.code==="artifact.aggregate.verified"),false);
  const events:string[]=[];s.runtime.artifactDurability=event=>{if(event.phase==="after-sync")events.push(event.directory);};s.runtime.artifactFault=point=>{if(point==="after-old-rename"){assert.ok(events.some(directory=>directory.includes("/baseline/")));assert.ok(events.includes(canonicalWorkspace));events.length=0;}};
  const resumed=await s.cli(["architecture-artifacts","apply",update.run.identity.runId],workspace);assert.equal(resumed.code,0,resumed.error);await assertBytes(workspace,update.intent);
  s.runtime.artifactFault=undefined;assert.equal((await s.cli(["architecture-artifacts","rollback",update.run.identity.runId],workspace)).code,0);await assertBytes(workspace,baseline.intent);
});
