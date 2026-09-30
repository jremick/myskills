import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliRuntime } from "../src/cli.js";
import { runEvaluationCommand } from "../src/evaluation-commands.js";
import { encodePackageArchive } from "@myskills-app/skill-package";
import type { ParityCommandContext } from "../src/parity-types.js";
test("local evaluation safely reads directories/archives and never uploads", async t=> {
  const directory=await mkdtemp(join(tmpdir(),"eval-cli-")); t.after(()=>rm(directory,{recursive:true,force:true}));
  const pkg=join(directory,"package");await mkdir(pkg);
  const files=[{path:"skill.json",content:JSON.stringify({name:"local-eval",title:"Local",summary:"Fixture",version:"1.0.0",license:"MIT",visibility:"public",platforms:[{name:"codex",install_target:"codex-skill"}]})},{path:"SKILL.md",content:"# Fixture"}];
  for (const file of files) await writeFile(join(pkg,file.path),file.content);
  const zip=join(directory,"package.zip");await writeFile(zip,encodePackageArchive(files));
  const output: unknown[]=[];
  const context={output:(value:unknown)=>output.push(value),request:async()=>assert.fail("local eval must never call API")} as unknown as ParityCommandContext;
  for(const input of [pkg,zip]) await runEvaluationCommand({command:"evals",args:["local",input],options:{platform:"codex"}},context);
  const first=output[0] as {run:{artifactSha256:string;provenance:string;totals:{skipped:number}}};
  assert.equal(first.run.artifactSha256,(output[1] as typeof first).run.artifactSha256);
  assert.equal(first.run.provenance,"self-reported"); assert.equal(first.run.totals.skipped,1);
  assert.equal(JSON.stringify(output).includes(directory),false);
  await assert.rejects(runEvaluationCommand({command:"evals",args:["local",pkg],options:{platform:"codex",upload:true}},context),/Unknown/);
  await assert.rejects(runEvaluationCommand({command:"evals",args:["local",join(pkg,"skill.json")],options:{platform:"codex"}},context),/could not be read safely/);
});
test("authenticated evaluation adapters preserve exact request and denial without fallback", async()=> {
  const requests: unknown[]=[];const body={suiteRevisionId:"revision",artifactSha256:"a".repeat(64),platform:"codex",idempotencyKey:"eval-replay"};
  const context={readInput:async()=>body,output(){},request:async(...args:unknown[])=>{requests.push(args);throw new Error("AUTHENTICATION_REQUIRED");}} as unknown as ParityCommandContext;
  await assert.rejects(runEvaluationCommand({command:"evals",args:["run","skill","1.0.0"],options:{input:"body.json"}},context),/AUTHENTICATION_REQUIRED/);
  assert.equal(requests.length,1);assert.deepEqual(requests[0],["POST","/v1/evaluations/releases/skill/1.0.0/runs",body]);
});

test("CLI dispatcher prints bounded JSON and human local results and preserves authenticated HTTP denial", async t => {
  const root=await mkdtemp(join(tmpdir(),"eval-dispatch-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const files=[{path:"skill.json",content:JSON.stringify({name:"local-eval",title:"Local",summary:"Fixture",version:"1.0.0",license:"MIT",visibility:"public",platforms:[{name:"codex",install_target:"codex-skill",status:"supported"}]})},{path:"SKILL.md",content:"# PRIVATE-CLI-CANARY"}];
  const pkg=join(root,"fixture.zip");await writeFile(pkg,encodePackageArchive(files));
  const stdout:string[]=[],stderr:string[]=[],requests:string[]=[];
  const runtime:CliRuntime={env:{HOME:root,MYSKILLS_TOKEN:"disposable-fixture-token"},io:{stdout:value=>stdout.push(value),stderr:value=>stderr.push(value)},fetch:async(input,init)=>{
    requests.push(String(input));assert.equal(new Headers(init?.headers).get("authorization"),"Bearer disposable-fixture-token");return new Response(JSON.stringify({error:{code:"AUTHENTICATION_REQUIRED",message:"PRIVATE-ERROR-CANARY"}}),{status:401});
  }};
  for(const args of [[],["--json"]]){stdout.length=0;assert.equal(await runCli(["evals","local",pkg,"--platform","codex",...args],runtime),0,stderr.join(""));const output=JSON.parse(stdout.at(-1)!);assert.equal(output.run.provenance,"self-reported");assert.equal(output.run.totals.skipped,1);assert.equal(stdout.join("").includes(root),false);assert.equal(stdout.join("").includes("PRIVATE-CLI-CANARY"),false);}
  assert.equal(requests.length,0);
  const missingSuite=join(root,"PRIVATE-SUITE-PATH-CANARY.json");
  assert.equal(await runCli(["evals","local",pkg,"--platform","codex","--suite",missingSuite,"--json"],runtime),1);
  assert.equal(stderr.join("").includes("PRIVATE-SUITE-PATH-CANARY"),false);assert.equal(requests.length,0);
  assert.equal(await runCli(["evals","list","local-eval","1.0.0","--api-url","http://fixture.invalid","--json"],runtime),1);
  assert.equal(requests.length,1);assert.match(stderr.at(-1)!,/AUTHENTICATION_REQUIRED/);assert.equal(stderr.join("").includes("PRIVATE-ERROR-CANARY"),false);
});
