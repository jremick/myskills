import type { PackageEvaluationResult } from "@myskills-app/core";
import { requestJson } from "./api.js";
export interface EvaluationView { id: string; versionId: string; suiteRevisionId?: string; createdAt: string; result?: PackageEvaluationResult; summary?: Omit<PackageEvaluationResult,"assertions" | "suiteSha256"> }
export interface EvaluationClient {
  list(slug: string, version: string): Promise<{runs:EvaluationView[]}>;
  summary(slug: string, version: string): Promise<{runs:EvaluationView[]}>;
}
/** Reject unavailable/malformed evidence rather than render partial success or throw inside React. */
export function evaluationRuns(input: unknown, publicSummary: boolean): EvaluationView[] {
  const malformed = () => { throw new Error("Malformed evaluation evidence."); };
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : malformed();
  const text = (value: unknown, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max;
  const outcomes = ["pass", "fail", "warning", "skipped", "incompatible"];
  const body = object(input);
  if (!Array.isArray(body.runs) || body.runs.length > 20) return malformed();
  for (const inputRun of body.runs) {
    const run = object(inputRun), value = object(run[publicSummary ? "summary" : "result"]);
    const target = object(value.target), runner = object(value.runner), totals = object(value.totals);
    if (!text(run.id) || !text(run.versionId) || !text(run.createdAt) || !Number.isFinite(Date.parse(String(run.createdAt)))
      || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(String(value.artifactSha256))
      || !outcomes.includes(String(value.status)) || !["api-owned", "self-reported"].includes(String(value.provenance))
      || !text(target.platform, 64) || !["local", "submission", "release"].includes(String(target.context))
      || runner.id !== "package-static" || runner.version !== "1"
      || !outcomes.every(key => Number.isSafeInteger(totals[key]) && Number(totals[key]) >= 0 && Number(totals[key]) <= 100)) return malformed();
    if (publicSummary) {
      if (run.suiteRevisionId !== undefined || value.suiteSha256 !== undefined || value.assertions !== undefined) return malformed();
    } else {
      if (!text(run.suiteRevisionId) || !/^[a-f0-9]{64}$/.test(String(value.suiteSha256)) || !Array.isArray(value.assertions) || value.assertions.length > 100) return malformed();
      for (const inputAssertion of value.assertions) {
        const assertion = object(inputAssertion);
        if (!text(assertion.id) || !text(assertion.code) || !outcomes.includes(String(assertion.outcome)) || !["static-package", "provider-behavior"].includes(String(assertion.scope))) return malformed();
      }
    }
  }
  return body.runs as EvaluationView[];
}
export function createEvaluationClient(root:string,fetchImpl:typeof fetch,token?:string):EvaluationClient {
  const path=(slug:string,version:string)=>`${root}/v1/evaluations/releases/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
  return {list:(slug,version)=>requestJson(fetchImpl,`${path(slug,version)}/runs`,{token}),summary:(slug,version)=>requestJson(fetchImpl,`${path(slug,version)}/summary`,{token})};
}
