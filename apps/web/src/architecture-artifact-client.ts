import type { ArchitectureArtifactIntent, ArchitectureSyncRun } from "@myskills-app/core";
export interface ArchitectureArtifactResult { run:ArchitectureSyncRun; intent:ArchitectureArtifactIntent; intentDigest:string; runtimeRecognized:false }
export interface ArchitectureArtifactClient {
  prepareArchitectureArtifact(targetId:string,input:{reviewRunId:string;baselineRunId:string|null;idempotencyKey:string}):Promise<ArchitectureArtifactResult>;
  getArchitectureArtifact(runId:string):Promise<ArchitectureArtifactResult>;
}
export function createArchitectureArtifactClient(request:(method:"GET"|"POST",path:string,body?:unknown)=>Promise<unknown>):ArchitectureArtifactClient {
  return {prepareArchitectureArtifact:async(targetId,input)=>await request("POST",`/v1/architecture-targets/${encodeURIComponent(targetId)}/artifacts`,input) as ArchitectureArtifactResult,getArchitectureArtifact:async(runId)=>await request("GET",`/v1/architecture-artifacts/${encodeURIComponent(runId)}`) as ArchitectureArtifactResult};
}
