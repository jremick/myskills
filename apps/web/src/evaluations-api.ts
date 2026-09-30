import type { PackageEvaluationResult } from "@myskills-app/core";
import { requestJson } from "./api.js";
export interface EvaluationView { id: string; versionId: string; suiteRevisionId?: string; createdAt: string; result?: PackageEvaluationResult; summary?: Omit<PackageEvaluationResult,"assertions" | "suiteSha256"> }
export interface EvaluationClient {
  list(slug: string, version: string): Promise<{runs:EvaluationView[]}>;
  summary(slug: string, version: string): Promise<{runs:EvaluationView[]}>;
}
export function createEvaluationClient(root:string,fetchImpl:typeof fetch,token?:string):EvaluationClient {
  const path=(slug:string,version:string)=>`${root}/v1/evaluations/releases/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;
  return {list:(slug,version)=>requestJson(fetchImpl,`${path(slug,version)}/runs`,{token}),summary:(slug,version)=>requestJson(fetchImpl,`${path(slug,version)}/summary`,{token})};
}
