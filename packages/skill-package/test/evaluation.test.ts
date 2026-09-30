import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { improvementDocumentDigest, normalizeImprovementEvaluationSuiteV1, packageEvaluationAssertionsDigest, packageEvaluationSummary } from "@myskills-app/core";
import { defaultPackageEvaluationSuite, evaluatePackageFiles, packageEvaluationArtifactDigest } from "../src/evaluation.js";
const files = [{ path: "skill.json", content: JSON.stringify({ name: "eval-fixture", title: "Fixture", summary: "Deterministic checks", version: "1.0.0", license: "MIT", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }] }) }, { path: "SKILL.md", content: "# Fixture\nDo the bounded task." }];
const run = (input = files, platform = "codex") => evaluatePackageFiles({ files: input, suite: defaultPackageEvaluationSuite(), target: { platform, context: "local" }, provenance: "self-reported" });
test("static evaluation binds bytes, suite, target and runner; behavior is explicitly skipped", () => {
  const result = run();
  assert.equal(result.artifactSha256, packageEvaluationArtifactDigest(files));
  assert.equal(result.suiteSha256, improvementDocumentDigest("suite", defaultPackageEvaluationSuite()));
  assert.deepEqual(result.totals, { pass: 3, fail: 0, warning: 0, skipped: 1, incompatible: 0 });
  assert.equal(result.status, "skipped");
  assert.equal(result.assertions.find(a => a.kind === "behavior")!.code, "provider_unconfigured");
  assert.equal(result.provenance, "self-reported");
  assert.notEqual(run([...files,{path:"private-canary.md",content:"changed"}]).artifactSha256,result.artifactSha256);
  assert.equal(JSON.stringify(packageEvaluationSummary(result)).includes("assertions"),false);
  assert.deepEqual(result.runner,{id:"package-static",version:"1"});
});
test("failure, warning and incompatible stay distinct; regression compares exact text bytes", () => {
  assert.equal(run(files,"other").totals.incompatible,1);
  assert.equal(run([...files,{path:"warning.md",content:'{"postinstall":"echo fixture"}'}]).totals.warning,1);
  assert.equal(run([...files,{path:"unsafe.md",content:"rm -rf /"}]).totals.fail,1);
  assert.equal(run(files.filter(f => f.path !== "SKILL.md")).totals.fail,1);
  const suite = defaultPackageEvaluationSuite();
  suite.assertions!.push({id:"protected",kind:"regression",path:"SKILL.md",sha256:createHash("sha256").update(files[1]!.content).digest("hex")});
  suite.caseCount++; suite.contentSha256=packageEvaluationAssertionsDigest(suite.assertions!);
  const result = evaluatePackageFiles({files,suite,target:{platform:"codex",context:"local"},provenance:"self-reported"});
  assert.equal(result.assertions.at(-1)!.outcome,"pass");
  const changed=structuredClone(files); changed[1]!.content+="changed";
  assert.equal(evaluatePackageFiles({files:changed,suite,target:{platform:"codex",context:"local"},provenance:"self-reported"}).assertions.at(-1)!.outcome,"fail");
});
test("suite revision cannot substitute content or rubric hashes or execute arbitrary assertions", () => {
  const suite=defaultPackageEvaluationSuite();
  for (const invalid of [{...suite,graders:["model"]},{...suite,graders:["deterministic","human"]},{...suite,caseCount:1},{...suite,contentSha256:"a".repeat(64)},{...suite,rubricSha256:"b".repeat(64)}, {...suite,assertions:[{id:"run",kind:"shell",command:"arbitrary"}]}]) assert.throws(()=>normalizeImprovementEvaluationSuiteV1(invalid));
  const legacy={...suite}; delete legacy.assertions;
  assert.throws(()=>evaluatePackageFiles({files,suite:legacy,target:{platform:"codex",context:"local"},provenance:"self-reported"}),/no package-static assertions/);
});
