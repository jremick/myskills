import { lstat, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactHash, artifactNamespace, assertArchitectureArtifactIntent, identifyArtifactFiles, renderArchitectureArtifact, type ArchitectureArtifactIntent, type ArtifactFile, type ArtifactFileIdentity, type ArchitectureSyncRun } from "@myskills-app/core";
import { assertInstallRootLocked, assertRegularDirectory, atomicPrivateWrite, ensureSafeDirectory, errorCode, readRegularText, validatePortableFilePaths, writeNewPackageTree } from "./install-filesystem.js";
import { validateCodexSkill } from "./codex-workspace.js";

interface RootIdentity { digest:string; dev:string; ino:string; discoveryDev:string; discoveryIno:string }
interface Manifest { schemaVersion:1; runId:string; intent:ArchitectureArtifactIntent; rootIdentity:RootIdentity; provenanceDigest:string }
interface Move { path:string; old:ArtifactFileIdentity[]; next:ArtifactFileIdentity[]; phase:"pending"|"old-intent"|"old-moved"|"new-intent"|"done" }
interface Journal { schemaVersion:1; runId:string; intent:ArchitectureArtifactIntent; rootIdentity:RootIdentity; provenanceDigest:string; baseline:Manifest|null; holderId:string; fence:number|null; state:"prepared"|"applying"|"manifest"|"receipted"|"rollback"|"rolled_back"; moves:Move[] }
export type ArtifactFaultPoint = "staged"|"before-old-move"|"after-old-move"|"after-old-rename"|"after-new-rename"|"before-new-move"|"after-new-move"|"manifest"|"receipt"|"rollback-move";
export interface ArtifactCompanionContext {
  workspace:string; lockRoot:string; targetId:string; generation:number; targetIdentityDigest:string; provenanceDigest:string;
  request(method:"GET"|"POST",route:string,body?:unknown):Promise<Record<string,unknown>>;
  download(pkg:ArchitectureArtifactIntent["projection"]["packages"][number]):Promise<ArtifactFile[]>;
  fault?(point:ArtifactFaultPoint):void|Promise<void>;
}
const base=(intent:ArchitectureArtifactIntent)=>`.myskills-app/architectures/${artifactNamespace(intent.projection.architectureId)}`;
const transaction=(runId:string,intent:ArchitectureArtifactIntent)=>`${base(intent)}/transactions/${artifactHash(runId).slice(0,40)}`;
const manifestPath=(intent:ArchitectureArtifactIntent)=>`${base(intent)}/manifest.json`;
const journalPath=(runId:string,intent:ArchitectureArtifactIntent)=>`${transaction(runId,intent)}/journal.json`;
const url=(runId:string,action="")=>`/v1/architecture-artifacts/${encodeURIComponent(runId)}${action?`/${action}`:""}`;
const absolute=(workspace:string,relative:string)=>path.join(workspace,relative);
function assertBound(intent:ArchitectureArtifactIntent,context:ArtifactCompanionContext):void {
  assertArchitectureArtifactIntent(intent);
  if(intent.projection.targetId!==context.targetId||intent.projection.generation!==context.generation||intent.projection.targetIdentityDigest!==context.targetIdentityDigest)throw new Error("Artifact belongs to a different enrolled workspace or generation.");
  assertInstallRootLocked(context.lockRoot);
}
async function identity(workspace:string):Promise<RootIdentity>{await assertRegularDirectory(workspace);const entry=await lstat(workspace);if(await realpath(workspace)!==workspace)throw new Error("Workspace root was substituted.");const discovery=await lstat(path.join(workspace,".agents/skills"));if(!discovery.isDirectory()||discovery.isSymbolicLink())throw new Error("Discovery root is not a regular directory.");return {digest:artifactHash(workspace),dev:String(entry.dev),ino:String(entry.ino),discoveryDev:String(discovery.dev),discoveryIno:String(discovery.ino)};}
async function assertRoot(context:ArtifactCompanionContext,pinned:RootIdentity):Promise<void>{exactKeys(pinned,["digest","dev","ino","discoveryDev","discoveryIno"]);if(artifactHash(await identity(context.workspace))!==artifactHash(pinned))throw new Error("Workspace root identity changed. Retain recovery copies.");await assertRegularDirectory(context.lockRoot);if(await realpath(context.lockRoot)!==context.lockRoot)throw new Error("Discovery root was substituted.");}
async function writeJournal(context:ArtifactCompanionContext,journal:Journal){await assertRoot(context,journal.rootIdentity);await atomicPrivateWrite(context.workspace,absolute(context.workspace,journalPath(journal.runId,journal.intent)),JSON.stringify(journal)+"\n");await syncDirectory(path.dirname(absolute(context.workspace,journalPath(journal.runId,journal.intent))));}
async function exists(file:string):Promise<boolean>{try{await lstat(file);return true;}catch(error){if(errorCode(error)==="ENOENT")return false;throw error;}}
/** Exact bounded readback; no recovery or restoration is performed. */
async function readTree(workspace:string,relative:string):Promise<ArtifactFile[]>{
  const root=absolute(workspace,relative);if(!await exists(root))return[];
  const files:ArtifactFile[]=[];let total=0;
  async function visit(directory:string,prefix:string){await assertRegularDirectory(directory);const entries=await readdir(directory,{withFileTypes:true});if(!entries.length)throw new Error("Owned tree contains an unexpected empty directory.");for(const entry of entries){const child=path.join(directory,entry.name);const name=prefix?`${prefix}/${entry.name}`:entry.name;const stat=await lstat(child);if(stat.isDirectory()&&!stat.isSymbolicLink())await visit(child,name);else if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1){const content=await readRegularText(child,16*1024*1024);total+=Buffer.byteLength(content);if(total>16*1024*1024||files.length>=2000)throw new Error("Owned tree exceeds bounds.");files.push({path:`${relative}/${name}`,content});}else throw new Error("Owned tree contains a link or special file.");}}
  await visit(root,"");validatePortableFilePaths(files);return files;
}
function identities(files:readonly ArtifactFile[]):ArtifactFileIdentity[]{return files.length?identifyArtifactFiles(files):[];}
async function matchTree(context:ArtifactCompanionContext,relative:string,expected:readonly ArtifactFileIdentity[]):Promise<void>{const actual=await readTree(context.workspace,relative);if(expected.length===0&&await exists(absolute(context.workspace,relative)))throw new Error("An unmanaged destination collides with the composed artifact.");if(artifactHash(identities(actual))!==artifactHash(expected))throw new Error("Owned tree drifted or contains unknown files. Preserve it for explicit recovery.");}
async function readManifest(context:ArtifactCompanionContext,intent:ArchitectureArtifactIntent):Promise<Manifest|null>{const file=absolute(context.workspace,manifestPath(intent));if(!await exists(file))return null;const value=await privateRecord(file) as unknown as Manifest;if(!value||Object.keys(value).sort().join(",")!==["schemaVersion","runId","intent","rootIdentity","provenanceDigest"].sort().join(",")||value.schemaVersion!==1)throw new Error("Composed ownership manifest is invalid.");assertArchitectureArtifactIntent(value.intent);assertBound(value.intent,context);await assertRoot(context,value.rootIdentity);if(value.provenanceDigest!==context.provenanceDigest)throw new Error("Composed manifest belongs to another registry.");return value;}
async function assertBaseline(context:ArtifactCompanionContext,intent:ArchitectureArtifactIntent):Promise<Manifest|null>{
  const manifest=await readManifest(context,intent);
  if((manifest?.runId??null)!==intent.baselineRunId||artifactHash(manifest?.intent??null)!==intent.baselineDigest)throw new Error("The whole artifact baseline changed before approval or promotion.");
  const old=manifest?.intent;
  const prefix=`ms-${artifactNamespace(intent.projection.architectureId)}-`;
  const ownedNames=new Set((old?.placements??[]).filter(p=>p.startsWith(".agents/skills/")).map(p=>p.split("/").at(-1)));
  for(const name of await readdir(context.lockRoot))if(name.startsWith(prefix)&&!ownedNames.has(name))throw new Error("Unknown discovery entry collides with this architecture namespace.");
  for(const owned of new Set([...intent.placements,...intent.removals,...old?.placements??[]]))await matchTree(context,owned,old?.files.filter(file=>file.path.startsWith(owned+"/"))??[]);
  return manifest;
}
export async function prepareLocalArchitectureArtifact(context:ArtifactCompanionContext,runId:string):Promise<{runId:string;intentDigest:string;treeDigest:string;baselineDigest:string;prepared:true}> {
  const remote=await context.request("GET",url(runId));const intent=remote.intent as ArchitectureArtifactIntent;assertBound(intent,context);
  const pinned=await identity(context.workspace);const baseline=await assertBaseline(context,intent);
  const location=transaction(runId,intent);const journalFile=absolute(context.workspace,journalPath(runId,intent));
  if(await exists(journalFile)){const journal=await readJournal(context,runId,intent);if(journal.state!=="prepared")throw new Error("Artifact already has partial or completed state. Use explicit verify or rollback.");await verifyStaging(context,journal);return prepared(runId,intent);}
  const packages=new Map<string,ArtifactFile[]>();
  for(const pkg of intent.projection.packages){const files=await context.download(pkg);validateCodexSkill(files,pkg.slug);validatePortableFilePaths(files);packages.set(pkg.refId,files);}
  const files=renderArchitectureArtifact(intent.projection,packages);validatePortableFilePaths(files);
  if(artifactHash(identifyArtifactFiles(files))!==intent.treeDigest)throw new Error("Downloaded materialized tree differs from API-owned intent.");
  await writeNewPackageTree(context.workspace,absolute(context.workspace,`${location}/stage`),files);
  const moves=[...new Set([...intent.placements,...intent.removals])].map(owned=>({path:owned,old:baseline?.intent.files.filter(f=>f.path.startsWith(owned+"/"))??[],next:intent.files.filter(f=>f.path.startsWith(owned+"/")),phase:"pending" as const}));
  const journal:Journal={schemaVersion:1,runId,intent,rootIdentity:pinned,provenanceDigest:context.provenanceDigest,baseline,holderId:`artifact-${randomUUID()}`,fence:null,state:"prepared",moves};
  await writeJournal(context,journal);await context.fault?.("staged");return prepared(runId,intent);
}
const prepared=(runId:string,intent:ArchitectureArtifactIntent)=>({runId,intentDigest:artifactHash(intent),treeDigest:intent.treeDigest,baselineDigest:intent.baselineDigest,prepared:true as const});
async function readJournal(context:ArtifactCompanionContext,runId:string,intent:ArchitectureArtifactIntent):Promise<Journal>{
  const journal=await privateRecord(absolute(context.workspace,journalPath(runId,intent))) as unknown as Journal;
  exactKeys(journal,["schemaVersion","runId","intent","rootIdentity","provenanceDigest","baseline","holderId","fence","state","moves"]);
  if(journal.baseline) validateManifest(journal.baseline);
  // Rebuild placement authority from immutable intent. Journal paths never grant ownership.
  if(!journal||journal.schemaVersion!==1||journal.runId!==runId||artifactHash(journal.intent)!==artifactHash(intent)||journal.provenanceDigest!==context.provenanceDigest||!Array.isArray(journal.moves)||journal.moves.length>501||! /^[A-Za-z0-9._:-]{1,128}$/.test(journal.holderId))throw new Error("Composed transaction journal is invalid.");
  assertBound(journal.intent,context);await assertRoot(context,journal.rootIdentity);
  if(artifactHash(journal.baseline?.intent??null)!==intent.baselineDigest || (journal.baseline?.runId??null)!==intent.baselineRunId)throw new Error("Journal baseline differs from immutable intent.");
  const allowed=[...new Set([...intent.placements,...intent.removals])];
  if(artifactHash(journal.moves.map(move=>move.path))!==artifactHash(allowed))throw new Error("Journal placement ownership changed.");
  for(const move of journal.moves){exactKeys(move,["path","old","next","phase"]);if(!["pending","old-intent","old-moved","new-intent","done"].includes(move.phase)||artifactHash(move.old)!==artifactHash(journal.baseline?.intent.files.filter(f=>f.path.startsWith(move.path+"/"))??[])||artifactHash(move.next)!==artifactHash(intent.files.filter(f=>f.path.startsWith(move.path+"/"))))throw new Error("Journal path identities changed.");}
  if(!["prepared","applying","manifest","receipted","rollback","rolled_back"].includes(journal.state)||journal.fence!==null&&(!Number.isSafeInteger(journal.fence)||journal.fence<1))throw new Error("Journal execution state is invalid.");
  return journal;
}
async function verifyStaging(context:ArtifactCompanionContext,journal:Journal){for(const move of journal.moves)if(move.next.length){const relative=`${transaction(journal.runId,journal.intent)}/stage/${move.path}`;const actual=await readTree(context.workspace,relative);const normalized=actual.map(f=>({...f,path:f.path.slice(`${transaction(journal.runId,journal.intent)}/stage/`.length)}));if(artifactHash(identities(normalized))!==artifactHash(move.next))throw new Error("Whole-artifact staging drifted.");}}
async function fence(context:ArtifactCompanionContext,journal:Journal){await assertRoot(context,journal.rootIdentity);if(journal.fence===null)throw new Error("Artifact has no claimed lease.");const response=await context.request("POST",url(journal.runId,"checkpoint"),{holderId:journal.holderId,fencingToken:journal.fence});const lease=response.lease as {expiresAt?:string};if(!lease.expiresAt||Date.parse(lease.expiresAt)<=Date.now())throw new Error("Artifact lease expired before local promotion.");}
async function moveDirectory(context:ArtifactCompanionContext,from:string,to:string){await assertRegularDirectory(absolute(context.workspace,from));await ensureSafeDirectory(context.workspace,path.dirname(absolute(context.workspace,to)));if(await exists(absolute(context.workspace,to)))throw new Error("Composed move destination already exists.");await rename(absolute(context.workspace,from),absolute(context.workspace,to));await syncDirectory(path.dirname(absolute(context.workspace,from)));await syncDirectory(path.dirname(absolute(context.workspace,to)));}
async function syncDirectory(directory:string){const {open}=await import("node:fs/promises");const handle=await open(directory,"r");try{await handle.sync();}finally{await handle.close();}}
export async function applyLocalArchitectureArtifact(context:ArtifactCompanionContext,runId:string):Promise<Record<string,unknown>>{
  const remote=await context.request("GET",url(runId));const intent=remote.intent as ArchitectureArtifactIntent;assertBound(intent,context);let journal=await readJournal(context,runId,intent);
  if(journal.state==="manifest"&&(remote.run as ArchitectureSyncRun).state==="succeeded")return verifyLocalArchitectureArtifact(context,runId);
  if(journal.state==="receipted")return verifyLocalArchitectureArtifact(context,runId);
  if(journal.state==="prepared"){
    await verifyStaging(context,journal);await assertBaseline(context,intent);
    // Approval is requested only after exact complete local staging/baseline readback.
    await context.request("POST",url(runId,"approve"),{expectedIntentDigest:artifactHash(intent),treeDigest:intent.treeDigest,baselineDigest:intent.baselineDigest});
    const claim=await context.request("POST",url(runId,"claim"),{holderId:journal.holderId,expectedIntentDigest:artifactHash(intent)});
    if(claim.decision!=="claimed")throw new Error("Another delivery already claimed this artifact. No local writes performed.");
    const run=claim.run as ArchitectureSyncRun;journal={...journal,state:"applying",fence:run.lease!.fencingToken};await writeJournal(context,journal);
  }
  if(!["applying","manifest"].includes(journal.state))throw new Error("Artifact requires explicit rollback or recovery.");
  for(const move of journal.moves){
    await fence(context,journal);
    const previous=`${transaction(runId,intent)}/baseline/${move.path}`;const stage=`${transaction(runId,intent)}/stage/${move.path}`;
    if(move.phase==="pending"){
      await matchTree(context,move.path,move.old);move.phase="old-intent";await writeJournal(context,journal);await context.fault?.("before-old-move");
    }
    if(move.phase==="old-intent"){
      if(move.old.length){
        if(await exists(absolute(context.workspace,previous))){await matchRelocated(context,previous,move.path,move.old);if(await exists(absolute(context.workspace,move.path)))throw new Error("Ambiguous partial baseline. Retain both trees.");}
        else{await matchTree(context,move.path,move.old);await fence(context,journal);await moveDirectory(context,move.path,previous);await context.fault?.("after-old-rename");}
      }else await matchTree(context,move.path,[]);
      move.phase="old-moved";await writeJournal(context,journal);await context.fault?.("after-old-move");
    }
    if(move.phase==="old-moved"){await matchTree(context,move.path,[]);move.phase="new-intent";await writeJournal(context,journal);await context.fault?.("before-new-move");}
    if(move.phase==="new-intent"){
      if(move.next.length){if(await exists(absolute(context.workspace,stage))){await matchRelocated(context,stage,move.path,move.next);await matchTree(context,move.path,[]);await fence(context,journal);await moveDirectory(context,stage,move.path);await context.fault?.("after-new-rename");}else await matchTree(context,move.path,move.next);}
      else await matchTree(context,move.path,[]);
      move.phase="done";await writeJournal(context,journal);await context.fault?.("after-new-move");
    }
    await matchTree(context,move.path,move.next);
  }
  await fence(context,journal);await verifyAggregate(context,intent);
  const manifest:Manifest={schemaVersion:1,runId,intent,rootIdentity:journal.rootIdentity,provenanceDigest:context.provenanceDigest};
  const existing=await readManifest(context,intent);if(existing&&existing.runId!==intent.baselineRunId&&existing.runId!==runId)throw new Error("Ownership manifest changed during operation.");
  await atomicPrivateWrite(context.workspace,absolute(context.workspace,manifestPath(intent)),JSON.stringify(manifest)+"\n");await syncDirectory(path.dirname(absolute(context.workspace,manifestPath(intent))));journal.state="manifest";await writeJournal(context,journal);await context.fault?.("manifest");
  await fence(context,journal);await verifyAggregate(context,intent);
  const result=await context.request("POST",url(runId,"receipt"),{holderId:journal.holderId,fencingToken:journal.fence,treeDigest:intent.treeDigest});
  await context.fault?.("receipt");journal.state="receipted";await writeJournal(context,journal);return {...result,treeDigest:intent.treeDigest,filesystemVerified:true,runtimeRecognized:false};
}
async function matchRelocated(context:ArtifactCompanionContext,location:string,owned:string,expected:ArtifactFileIdentity[]){const files=await readTree(context.workspace,location);const normalized=files.map(f=>({...f,path:owned+f.path.slice(location.length)}));if(artifactHash(identities(normalized))!==artifactHash(expected))throw new Error("Private staging/recovery bytes changed.");}
async function verifyAggregate(context:ArtifactCompanionContext,intent:ArchitectureArtifactIntent){const files:ArtifactFile[]=[];for(const owned of intent.placements){await matchTree(context,owned,intent.files.filter(f=>f.path.startsWith(owned+"/")));files.push(...await readTree(context.workspace,owned));}for(const removed of intent.removals)await matchTree(context,removed,[]);if(artifactHash(identities(files))!==intent.treeDigest)throw new Error("Aggregate architecture readback failed.");}
export async function verifyLocalArchitectureArtifact(context:ArtifactCompanionContext,runId:string):Promise<Record<string,unknown>>{
  const remote=await context.request("GET",url(runId));const intent=remote.intent as ArchitectureArtifactIntent;assertBound(intent,context);const journal=await readJournal(context,runId,intent);
  if(journal.state==="manifest"){
    const run=remote.run as ArchitectureSyncRun;
    if(run.state==="succeeded") {await verifyAggregate(context,intent);await context.request("POST",url(runId,"receipt"),{holderId:journal.holderId,fencingToken:journal.fence,treeDigest:intent.treeDigest});journal.state="receipted";await writeJournal(context,journal);}
    else {await fence(context,journal);await verifyAggregate(context,intent);await context.request("POST",url(runId,"receipt"),{holderId:journal.holderId,fencingToken:journal.fence,treeDigest:intent.treeDigest});journal.state="receipted";await writeJournal(context,journal);}
  }
  if(journal.state!=="receipted")throw new Error("Composed artifact is partial; verification does not restore exposed bytes.");
  const manifest=await readManifest(context,intent);if(manifest?.runId!==runId)throw new Error("A different architecture tree is active.");await verifyAggregate(context,intent);
  if(((await context.request("GET",url(runId))).run as ArchitectureSyncRun).state!=="succeeded")throw new Error("Exact API success receipt is missing.");
  return {runId,treeDigest:intent.treeDigest,filesystemVerified:true,receiptVerified:true,runtimeRecognized:false};
}
export async function rollbackLocalArchitectureArtifact(context:ArtifactCompanionContext,runId:string):Promise<Record<string,unknown>>{
  const remote=await context.request("GET",url(runId));const intent=remote.intent as ArchitectureArtifactIntent;assertBound(intent,context);const journal=await readJournal(context,runId,intent);
  if(journal.state==="rolled_back"||journal.state==="rollback"&&(remote.run as ArchitectureSyncRun).state==="rolled_back"){
    if(journal.baseline)await verifyAggregate(context,journal.baseline.intent);else for(const move of journal.moves)await matchTree(context,move.path,[]);
    const treeDigest=journal.baseline?.intent.treeDigest??artifactHash([]);
    const replay=await context.request("POST",url(runId,"receipt"),{holderId:journal.holderId,fencingToken:journal.fence,treeDigest});journal.state="rolled_back";await writeJournal(context,journal);return {...replay,treeDigest,filesystemVerified:true,runtimeRecognized:false};
  }
  // No implicit restoration: this current-authority approval claims a new fence.
  const claim=await context.request("POST",url(runId,"rollback"),{holderId:journal.holderId,expectedIntentDigest:artifactHash(intent),treeDigest:intent.treeDigest,baselineDigest:intent.baselineDigest});
  journal.fence=(claim.run as ArchitectureSyncRun).lease!.fencingToken;journal.state="rollback";await writeJournal(context,journal);
  for(const move of [...journal.moves].reverse()){
    await fence(context,journal);const backup=`${transaction(runId,intent)}/baseline/${move.path}`;const quarantined=`${transaction(runId,intent)}/quarantine/${move.path}`;
    const current=await readTree(context.workspace,move.path);const currentIds=identities(current);
    if(artifactHash(currentIds)===artifactHash(move.old) && (!move.old.length || !await exists(absolute(context.workspace,backup))))continue;
    if(current.length){if(artifactHash(currentIds)!==artifactHash(move.next))throw new Error("Rollback found altered or ambiguous active bytes. Retain quarantine.");await fence(context,journal);await moveDirectory(context,move.path,quarantined);await context.fault?.("rollback-move");}
    if(move.old.length){await matchRelocated(context,backup,move.path,move.old);await matchTree(context,move.path,[]);await fence(context,journal);await moveDirectory(context,backup,move.path);await context.fault?.("rollback-move");}
    await matchTree(context,move.path,move.old);
  }
  await fence(context,journal);
  if(journal.baseline){await verifyAggregate(context,journal.baseline.intent);await atomicPrivateWrite(context.workspace,absolute(context.workspace,manifestPath(intent)),JSON.stringify(journal.baseline)+"\n");}
  else{
    for(const move of journal.moves)await matchTree(context,move.path,[]);
    // Retain an explicit empty ownership manifest instead of deleting unrelated state.
    const {rm}=await import("node:fs/promises");const named=absolute(context.workspace,manifestPath(intent));const existing=await readManifest(context,intent);if(existing&&existing.runId!==runId)throw new Error("Rollback cannot remove another manifest.");if(await exists(named))await rm(named);
  }
  await syncDirectory(path.dirname(absolute(context.workspace,manifestPath(intent))));await fence(context,journal);
  const treeDigest=journal.baseline?.intent.treeDigest??artifactHash([]);
  const result=await context.request("POST",url(runId,"receipt"),{holderId:journal.holderId,fencingToken:journal.fence,treeDigest});await context.fault?.("receipt");journal.state="rolled_back";await writeJournal(context,journal);return {...result,treeDigest,filesystemVerified:true,runtimeRecognized:false};
}

function exactKeys(value:unknown,keys:readonly string[]):void{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw new Error("Composed local schema has missing or unknown fields.");}
function validateManifest(value:Manifest):void{exactKeys(value,["schemaVersion","runId","intent","rootIdentity","provenanceDigest"]);assertArchitectureArtifactIntent(value.intent);if(value.schemaVersion!==1||typeof value.runId!=="string"||typeof value.provenanceDigest!=="string")throw new Error("Composed manifest schema is invalid.");}
async function privateRecord(file:string):Promise<Record<string,unknown>>{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error("Composed metadata must be an regular file with one link.");return JSON.parse(await readRegularText(file,1024*1024)) as Record<string,unknown>;}
