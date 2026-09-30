import { expect,test,type Page } from "@playwright/test";
import { defaultPackageEvaluationSuite,evaluatePackageFiles } from "@myskills-app/skill-package";
import { packageEvaluationSummary } from "@myskills-app/core";
// Browser wiring/layout proof only. Deterministic outcomes are computed locally;
// canonical API+PG fixtures separately prove authority and durable persistence.
const manifest={name:"evaluation-fixture",title:"Evaluation Fixture",summary:"Inspect exact static evidence.",version:"1.0.0",license:"MIT",visibility:"public",platforms:[{name:"codex",install_target:"codex-skill",status:"supported"}]};
const result=evaluatePackageFiles({files:[{path:"skill.json",content:JSON.stringify(manifest)},{path:"SKILL.md",content:"# PRIVATE-PACKAGE-CANARY"}],suite:defaultPackageEvaluationSuite(),target:{platform:"codex",context:"submission"},provenance:"api-owned"});
const artifact={sha256:result.artifactSha256,byteSize:500,contentType:"application/json"};
const platforms=[{name:"codex",installTarget:"codex-skill",status:"supported"}];
const submission={id:"submission",slug:manifest.name,title:manifest.title,summary:manifest.summary,version:"1.0.0",visibility:"public",lifecycleStatus:"submitted",reviewStatus:"unreviewed",securityStatus:"passed",artifact,platforms,createdAt:"2026-10-01T00:00:00Z",publishedAt:null,approvedArtifactSha256:null,findingCount:0,allowedActions:["approve","request-changes","reject"]};
const run={id:"run",versionId:"submission",suiteRevisionId:"11111111-1111-4111-8111-111111111111",createdAt:"2026-10-01T00:00:00Z",result};
async function fixture(page:Page,reviewer:boolean){
  const user={id:"reviewer",email:"reviewer@example.test",name:"Reviewer",status:"active",roles:["owner"],emailVerified:true,mfaVerified:true};
  if(reviewer)await page.addInitScript(user=>localStorage.setItem("myskills-app:web-session",JSON.stringify({user,expiresAt:"2027-01-01T00:00:00Z"})),user);
  await page.route("**/api/v1/**",route=>{
    const path=new URL(route.request().url()).pathname.replace(/^\/api/,"");
    const reply=(json:unknown,status=200)=>route.fulfill({json,status});
    if(path==="/v1/me")return reviewer?reply({user}):reply({error:{code:"AUTHENTICATION_REQUIRED"}},401);
    if(path==="/v1/site")return reply({site:{landingPageEnabled:true}});
    if(path==="/v1/branding")return reply({branding:{text:"MySkills",showText:true,logoDataUrl:null}});
    if(path==="/v1/review/submissions")return reply({submissions:[submission],nextCursor:null});
    if(path==="/v1/review/submissions/submission")return reply({submission:{...submission,reviewHistory:[],scanRuns:[],changeRequestReason:null}});
    if(path==="/v1/evaluations/releases/evaluation-fixture/1.0.0/runs")return reply({runs:[run]});
    if(path==="/v1/evaluations/releases/evaluation-fixture/1.0.0/summary")return reply({runs:[{id:run.id,versionId:run.versionId,suiteRevisionId:run.suiteRevisionId,createdAt:run.createdAt,summary:packageEvaluationSummary(result)}]});
    const release={...submission,lifecycleStatus:"approved",reviewStatus:"approved",publishedAt:"2026-10-01T01:00:00Z",allowedActions:[]};
    const skill={slug:manifest.name,title:manifest.title,summary:manifest.summary,visibility:"public",latestVersion:"1.0.0",lifecycleStatus:"approved",reviewStatus:"approved",securityStatus:"passed",platforms,tags:[],access:{canManageSharing:false,reasons:["public"]}};
    if(path==="/v1/skills")return reply({skills:[skill],nextCursor:null});
    if(path==="/v1/skills/evaluation-fixture")return reply({skill});
    if(path==="/v1/skills/evaluation-fixture/releases")return reply({releases:[release]});
    if(path==="/v1/skills/evaluation-fixture/releases/1.0.0")return reply({release});
    if(path==="/v1/teams")return reply({teams:[],invitations:[]});
    if(path==="/v1/libraries")return reply({libraries:[],nextCursor:null});
    if(path==="/v1/library-inbox")return reply({items:[],unreadCount:0,nextCursor:null});
    return reply({error:{code:"NOT_FOUND"}},404);
  });
}
for(const width of [1280,390])test(`reviewer static evidence exposes exact bindings and provider skips at ${width}`,async({page},info)=>{
  await fixture(page,true);await page.setViewportSize({width,height:844});await page.goto("/review");
  await page.getByLabel("Review queue",{exact:true}).getByRole("button",{name:/Evaluation Fixture/}).click();
  const evidence=page.getByRole("region",{name:"Package evaluation evidence"});
  await expect(evidence.getByText(/behavior: skipped/)).toBeVisible();await expect(evidence.getByText(result.artifactSha256,{exact:true})).toBeVisible();
  await expect(evidence.getByText(/Pass 3/)).toBeVisible();await expect(evidence).not.toContainText("PRIVATE-PACKAGE-CANARY");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath(`reviewer-evaluation-${width}.png`),fullPage:true});
});
test("public approved release shows bounded summary and no assertion details",async({page},info)=>{
  await fixture(page,false);await page.goto("/skills/evaluation-fixture?version=1.0.0");
  const evidence=page.getByRole("region",{name:"Package evaluation evidence"});await expect(evidence.getByText(/Pass 3/)).toBeVisible();
  await expect(evidence.getByText(result.artifactSha256,{exact:true})).toBeVisible();await expect(evidence).not.toContainText("behavior: skipped");await expect(evidence).not.toContainText("PRIVATE-PACKAGE-CANARY");
  await page.screenshot({path:info.outputPath("public-evaluation-summary.png"),fullPage:true});
});
