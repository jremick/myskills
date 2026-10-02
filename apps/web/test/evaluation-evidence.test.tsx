import assert from "node:assert/strict";
import test,{afterEach} from "node:test";
import {render,cleanup,act} from "@testing-library/react";
import {evaluatePackageFiles,defaultPackageEvaluationSuite} from "@myskills-app/skill-package";
import {packageEvaluationSummary} from "@myskills-app/core";
import {PackageEvaluationEvidence} from "../src/components/registry/PackageEvaluationEvidence.js";
import type {EvaluationClient,EvaluationView} from "../src/evaluations-api.js";
afterEach(()=>cleanup());
const result=evaluatePackageFiles({files:[{path:"skill.json",content:JSON.stringify({name:"fixture",title:"Fixture",summary:"Fixture",version:"1.0.0",license:"MIT",visibility:"public",platforms:[{name:"codex",install_target:"codex-skill"}]})},{path:"SKILL.md",content:"PRIVATE-PROMPT-CANARY"}],suite:defaultPackageEvaluationSuite(),target:{platform:"codex",context:"submission"},provenance:"api-owned"});
const run:EvaluationView={id:"run",versionId:"version",suiteRevisionId:"PRIVATE-SUITE-REVISION",createdAt:"2026-10-01",result};
test("reviewer sees scopes and distinct outcomes; public summary omits assertion details",async()=>{
  const publicRun:EvaluationView={id:run.id,versionId:run.versionId,createdAt:run.createdAt,summary:packageEvaluationSummary(result)};
  const api={list:async()=>({runs:[run]}),summary:async()=>({runs:[publicRun]})};
  const view=render(<PackageEvaluationEvidence api={api} slug="fixture" version="1.0.0"/>);
  await view.findByText(/behavior: skipped/);
  assert.equal(document.body.textContent?.includes("PRIVATE-PROMPT-CANARY"),false);
  view.rerender(<PackageEvaluationEvidence api={api} slug="fixture" version="1.0.0" publicSummary/>);
  await view.findByText(/Pass 3/);
  assert.equal(view.queryByText(/behavior: skipped/),null);
  assert.equal(document.body.textContent?.includes("PRIVATE-SUITE-REVISION"),false);
  assert.equal(document.body.textContent?.includes(result.suiteSha256),false);
  assert.ok(view.getByText(result.artifactSha256));
});
test("reviewer denial invalidates old evidence with no public fallback",async()=>{
  let resolve!:(value:{runs:EvaluationView[]})=>void;
  const api:EvaluationClient={list:()=>new Promise(done=>{resolve=done;}),summary:async()=>assert.fail("denial cannot fall back")};
  const denied:EvaluationClient={list:async()=>{throw new Error("Denied");},summary:api.summary};
  const view=render(<PackageEvaluationEvidence api={api} slug="fixture" version="1.0.0"/>);
  view.rerender(<PackageEvaluationEvidence api={denied} slug="fixture" version="1.0.0"/>);
  await view.findByRole("alert");await act(async()=>resolve({runs:[run]}));
  assert.equal(view.queryByText(result.artifactSha256),null);
});

test("malformed or missing evaluation responses show unavailable evidence without crashing or implying empty success", async () => {
  for (const body of [undefined, null, {}, { runs: null }, { runs: [{}] }, { runs: [{ ...run, result: { ...result, totals: null } }] }]) {
    const api = { list: async () => body, summary: async () => body } as unknown as EvaluationClient;
    const view = render(<PackageEvaluationEvidence api={api} slug="fixture" version="1.0.0" />);
    await view.findByRole("alert");
    assert.equal(view.queryByText(/No evaluation evidence has been recorded/), null);
    assert.equal(view.queryByText(result.artifactSha256), null);
    view.unmount();
  }
});
