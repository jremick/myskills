import { useEffect, useState } from "react";
import type { EvaluationClient, EvaluationView } from "@/evaluations-api";
const connections = new WeakMap<EvaluationClient, number>();
let epoch=0;
export function PackageEvaluationEvidence(props: { api: EvaluationClient; slug:string; version:string; publicSummary?:boolean }) {
  if (!connections.has(props.api)) connections.set(props.api,++epoch);
  return <Evidence key={`${connections.get(props.api)}:${props.slug}:${props.version}:${props.publicSummary}`} {...props}/>;
}
function Evidence({api,slug,version,publicSummary=false}:{api:EvaluationClient;slug:string;version:string;publicSummary?:boolean}) {
  const [runs,setRuns]=useState<EvaluationView[]|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{let active=true;void (publicSummary?api.summary(slug,version):api.list(slug,version)).then(value=>{if(active)setRuns(value.runs);}).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[api,slug,version,publicSummary]);
  return <section aria-label="Package evaluation evidence"><h4>Package evaluations</h4>
    <p>Static package checks cover the declared platform. Provider behavior remains unconfigured. Evaluation evidence does not approve a release.</p>
    {failed?<p role="alert">Evaluation evidence is unavailable for this connection.</p>:runs===null?<p role="status">Loading evaluation evidence…</p>:runs.length===0?<p>No evaluation evidence has been recorded for these exact bytes.</p>:runs.map(run=>{
      const value=publicSummary?run.summary:run.result;
      if(!value)return null;
      return <article key={run.id}><strong>{value.status}</strong> · {value.provenance} · {value.target.platform}
        <p>Pass {value.totals.pass} · Fail {value.totals.fail} · Warning {value.totals.warning} · Skipped {value.totals.skipped} · Incompatible {value.totals.incompatible}</p>
        <p>Artifact <code className="scan-evidence-digest">{value.artifactSha256}</code></p>{!publicSummary && run.result && <p>Suite revision <code>{run.suiteRevisionId}</code> · <code className="scan-evidence-digest">{run.result.suiteSha256}</code></p>}
        <p>Runner {value.runner.id}/{value.runner.version} · Scope {value.target.context}</p>
        {!publicSummary && run.result && <ul>{run.result.assertions.map(assertion=><li key={assertion.id}>{assertion.id}: {assertion.outcome} · {assertion.scope} · {assertion.code}</li>)}</ul>}
      </article>;
    })}</section>;
}
