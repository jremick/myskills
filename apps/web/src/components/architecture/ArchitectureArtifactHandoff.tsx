import { useEffect, useRef, useState } from "react";
import type { ArchitectureSyncRun } from "@myskills-app/core";
import type { ArchitectureArtifactClient, ArchitectureArtifactResult } from "../../architecture-artifact-client.js";
import { safeArchitectureTargetErrorMessage, type ArchitectureTargetRecord } from "../../api.js";
import { Input } from "../ui/input.js";
import { Button } from "../ui/button.js";
/** Browser creates/inspects intent. Only the enrolled local companion stages bytes. */
export function ArchitectureArtifactHandoff({client,review,target}:{client:Partial<ArchitectureArtifactClient>;review:ArchitectureSyncRun;target:ArchitectureTargetRecord}) {
  const [baseline,setBaseline]=useState("");const [artifact,setArtifact]=useState<ArchitectureArtifactResult|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState<string|null>(null);
  const epoch=useRef(0);const key=useRef<string|null>(null);
  const targetSupported=target.adapter.kind==="codex-workspace"&&target.adapter.version==="1.0.0"&&target.adapter.contractVersion===2&&target.capabilities.apply===true&&target.capabilities.rollback===true&&target.capabilities["sync.write"]===true;
  const currentBinding=target.id===review.identity.targetId&&target.generation===review.identity.targetGeneration&&target.profileId===review.identity.profileId&&target.environmentId===review.identity.environmentId&&target.status!=="revoked"&&target.consent.status==="granted";
  const canPrepare=targetSupported&&currentBinding&&review.state==="approved";
  useEffect(()=>{epoch.current++;key.current=null;setBaseline("");setArtifact(null);setBusy(false);setMessage(null);return()=>{epoch.current++;};},[client,review.identity.runId,target.id,target.generation,targetSupported,currentBinding]);
  if(!client.prepareArchitectureArtifact||!client.getArchitectureArtifact)return null;
  async function prepare(){if(!canPrepare||busy)return;const current=++epoch.current;setBusy(true);setMessage(null);key.current??=crypto.randomUUID();try{const value=await client.prepareArchitectureArtifact!(review.identity.targetId,{reviewRunId:review.identity.runId,baselineRunId:baseline.trim()||null,idempotencyKey:key.current});if(current===epoch.current){setArtifact(value);setBusy(false);}}catch(error){if(current===epoch.current){setMessage(safeArchitectureTargetErrorMessage(error));setBusy(false);}}}
  async function refresh(){if(!artifact)return;const current=++epoch.current;setBusy(true);try{const value=await client.getArchitectureArtifact!(artifact.run.identity.runId);if(current===epoch.current){setArtifact(value);setBusy(false);}}catch(error){if(current===epoch.current){setMessage(safeArchitectureTargetErrorMessage(error));setBusy(false);}}}
  const runId=artifact?.run.identity.runId;
  const command=(action:string)=>`myskills architecture-artifacts ${action} ${runId} --workspace <absolute-project-workspace>`;
  return <section className="cp-section architecture-artifact-handoff" aria-label="Composed workspace handoff">
    <div className="cp-section-head"><h4>Composed workspace handoff</h4></div>
    <p>{review.state==="approved"?"Create immutable intent from this approved review.":"Approve this review first to prepare composed intent."} The enrolled companion stages the whole tree before a separate execution approval. Routing is guidance; provider recognition remains unproven.</p>
    {!targetSupported&&<p className="cp-muted">This target is read-only or unsupported for composed delivery. Preparation requires an explicitly enrolled Codex workspace v2 with apply, rollback and sync.write capabilities.</p>}
    {targetSupported&&!currentBinding&&<p className="cp-muted">Grant target consent and create a review for its current generation and profile before preparation.</p>}
    <label>Current composed baseline run (leave empty for a new workspace)<Input value={baseline} disabled={busy||!canPrepare||Boolean(artifact)} onChange={event=>{setBaseline(event.target.value);key.current=null;}}/></label>
    <Button size="sm" disabled={busy||!canPrepare||Boolean(artifact)} onClick={()=>void prepare()}>Prepare composed intent</Button>
    {message&&<p role="alert">{message}</p>}
    {artifact&&<>
      <dl className="cp-facts"><div><dt>Artifact</dt><dd>{runId}</dd></div><div><dt>State</dt><dd>{artifact.run.state}</dd></div><div><dt>Tree digest</dt><dd>{artifact.intent.treeDigest}</dd></div><div><dt>Exact packages</dt><dd>{artifact.intent.projection.packages.map(p=>`${p.slug}@${p.version}`).join(", ")}</dd></div></dl>
      <h5>Install and verify</h5><pre aria-label="Install and verify commands">{["prepare","apply","verify"].map(command).join("\n")}</pre>
      <details><summary>Optional rollback</summary><p>Rollback requires current authority to restore the exact baseline. A forbidden baseline stays quarantined.</p><pre aria-label="Optional rollback command">{command("rollback")}</pre></details>
      <p>{artifact.run.state==="succeeded"?"API accepted the aggregate filesystem receipt. This does not prove provider recognition or current local bytes.":"No complete filesystem receipt is recorded. Continue in the trusted local companion."}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void refresh()}>Refresh artifact receipt</Button>
    </>}
  </section>;
}
