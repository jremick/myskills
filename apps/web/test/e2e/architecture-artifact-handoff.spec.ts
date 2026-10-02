import { expect, test } from "@playwright/test";

// Test first: rendered plan review must bind the selected saved revision and
// observation. Approval is a distinct click with the complete review digest;
// stale approval preserves inspectable history and never requests target apply.
const user = { id: "plan-owner", email: "plan@example.test", name: "Plan owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
const digest = "a".repeat(64);
const reviewDigest = "b".repeat(64);
const target = {
  schemaVersion: 1, id: "plan-target", name: "Review workspace", owner: { type: "user", id: user.id },
  architectureId: "plan-architecture", profileId: "personal", environmentId: "personal-machine",
  adapter: { kind: "codex-workspace", version: "1.0.0", contractVersion: 2 }, status: "connected", generation: 3,
  capabilities: { "inventory.read": true, "health.read": true, "plan.read": true, apply: true, rollback: true, "sync.write": true },
  consent: { status: "granted" }, metadata: {}, health: { status: "healthy", checkedAt: "2026-09-30T01:00:00Z" },
};
const observation = { schemaVersion: 1, id: "observation-3", targetId: target.id, targetGeneration: 3, observedDigest: digest, adapterDigest: digest, capabilitiesDigest: digest, observedAt: "2026-09-30T01:00:00Z", skills: [], configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } };
const run = {
  schemaVersion: 1, identity: { schemaVersion: 1, runId: "review-run", targetId: target.id, targetGeneration: 3, architectureId: target.architectureId, revisionId: "revision-1", profileId: "personal", environmentId: "personal-machine" },
  state: "approved", digests: { desiredDigest: digest, compiledDigest: digest, observedDigest: digest, planDigest: "c".repeat(64) },
  steps: [
    { id: "step-router", ordinal: 0, nodeId: "root-router", action: "configure-router", state: "planned", targetGeneration: 3 },
    { id: "step-leaf", ordinal: 1, nodeId: "review-skill", action: "update", state: "planned", targetGeneration: 3 },
    { id: "step-denied", ordinal: 2, nodeId: "work-leaf", action: "disable", state: "planned", targetGeneration: 3 },
  ], receipts: [], capabilities: { "plan.read": true, apply: false, "sync.write": false },
  metadata: { source: "architecture-plan", reviewOnly: true, dryRun: true, canApply: false, reviewDigest, observationId: observation.id, observationDigest: digest, revisionDigest: digest, adapterDigest: digest, capabilitiesDigest: digest, consentDigest: digest, policyDigest: digest },
  createdAt: "2026-09-30T01:00:00Z", updatedAt: "2026-09-30T01:00:00Z",
};


for (const fixture of [{width:1280,readOnly:false},{width:390,readOnly:false},{width:1280,readOnly:true}]) test(fixture.readOnly?"read-only target cannot request composed intent":`browser prepares composed intent and hands filesystem execution to enrolled CLI at ${fixture.width}`,async({page},info)=>{
  const {width,readOnly}=fixture;const selectedTarget=readOnly?{...target,adapter:{kind:"codex",version:"1.0.0",contractVersion:1},capabilities:{"inventory.read":true,"health.read":true,"plan.read":true}}:target;
  await page.setViewportSize({width,height:900});await page.addInitScript(user=>localStorage.setItem("myskills-app:web-session",JSON.stringify({user,expiresAt:"2027-01-01T00:00:00Z"})),user);
  const writes:Array<{path:string;body:unknown}>=[];let completed=false;
  const artifact={run:{...run,identity:{...run.identity,runId:"artifact-run"},state:"drafted",metadata:{source:"architecture-artifact",reviewOnly:false}},intentDigest:digest,runtimeRecognized:false,intent:{treeDigest:digest,projection:{packages:[{slug:"exact-alpha",version:"2.0.0"},{slug:"exact-beta",version:"1.0.0"}]}}};
  await page.route("**/api/v1/**",async route=>{const request=route.request();const path=new URL(request.url()).pathname.replace(/^\/api/,"");const json=(value:unknown)=>route.fulfill({json:value});
    if(request.method()==="POST"){writes.push({path,body:request.postDataJSON()});if(path.endsWith("/artifacts"))return json(artifact);return route.fulfill({status:400,json:{error:{code:"UNEXPECTED_WRITE"}}});}
    if(path==="/v1/me")return json({user});if(path==="/v1/architecture-targets")return json({targets:[selectedTarget]});if(path===`/v1/architecture-targets/${target.id}`)return json({target:selectedTarget});if(path.endsWith("/observations"))return json({observations:[observation]});if(path.endsWith("/plans"))return json({runs:[run]});if(path==="/v1/architecture-plans/review-run")return json({run});
    if(path==="/v1/architecture-artifacts/artifact-run")return json({...artifact,run:{...artifact.run,state:completed?"succeeded":"drafted"}});
    if(path===`/v1/architectures/${target.architectureId}`)return json({architecture:{id:target.architectureId,name:"Router architecture",patternId:"multi-level-router",currentRevisionId:"revision-1",access:{canRead:true,canAppend:true}},revisions:[{id:"revision-1",revisionNumber:1,digest}],latestRevision:{id:"revision-1",revisionNumber:1,digest}});
    if(path==="/v1/capabilities")return json({capabilities:{architectureTargets:true,architecturePlans:true}});if(path==="/v1/branding")return json({branding:{appName:"MySkills"}});return json({architectures:[],patterns:[],teams:[],invitations:[],organizations:[],skills:[]});
  });
  await page.goto("/targets");await page.getByRole("button",{name:/Review workspace/}).click();const panel=page.getByRole("region",{name:"Architecture review plans"});await panel.getByRole("button",{name:/revision-1.*approved/}).click();
  const handoff=page.getByRole("region",{name:"Composed workspace handoff"});await expect(handoff).toBeVisible();if(readOnly){await expect(handoff).toContainText("read-only or unsupported");await expect(handoff.getByRole("button",{name:"Prepare composed intent"})).toBeDisabled();expect(writes).toHaveLength(0);return;}await handoff.getByRole("button",{name:"Prepare composed intent"}).click();await expect(handoff).toContainText("No complete filesystem receipt");await expect(handoff).toContainText("exact-alpha@2.0.0, exact-beta@1.0.0");
  expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({path:`/v1/architecture-targets/${target.id}/artifacts`,body:{reviewRunId:"review-run",baselineRunId:null}});
  await expect(handoff.getByLabel("Install and verify commands")).toContainText("myskills architecture-artifacts apply artifact-run --workspace <absolute-project-workspace>");await expect(handoff.getByLabel("Install and verify commands")).not.toContainText("rollback");await handoff.getByText("Optional rollback",{exact:true}).click();await expect(handoff.getByLabel("Optional rollback command")).toContainText("myskills architecture-artifacts rollback artifact-run");await expect(handoff).toContainText("Rollback requires current authority");await page.screenshot({path:info.outputPath(`composed-prepared-${width}.png`),fullPage:true});completed=true;await handoff.getByRole("button",{name:"Refresh artifact receipt"}).click();await expect(handoff).toContainText("does not prove provider recognition or current local bytes");expect(writes).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
