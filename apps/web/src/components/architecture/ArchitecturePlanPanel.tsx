import { useEffect, useRef, useState } from "react";
import type { ArchitectureSyncRun } from "@myskills-app/core";
import { safeArchitectureTargetErrorMessage, type ArchitectureRevisionSummary, type ArchitectureTargetObservationRecord, type ArchitectureTargetRecord, type RegistryClient } from "../../api.js";
import type { ArchitecturePlanClient, ArchitecturePlanCreateInput } from "../../architecture-plan-client.js";
import { Button } from "../ui/button.js";
import "./architecture-plan.css";

export function ArchitecturePlanPanel({ client, target, observation }: {
  client: RegistryClient & Partial<ArchitecturePlanClient>;
  target: ArchitectureTargetRecord;
  observation?: ArchitectureTargetObservationRecord;
}) {
  const [runs, setRuns] = useState<ArchitectureSyncRun[]>([]);
  const [selected, setSelected] = useState<ArchitectureSyncRun | null>(null);
  const [revisions, setRevisions] = useState<ArchitectureRevisionSummary[]>([]);
  const [revisionId, setRevisionId] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "busy" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const requestRef = useRef<{ signature: string; input: ArchitecturePlanCreateInput } | null>(null);
  const epoch = useRef(0);
  const supported = Boolean(client.listArchitecturePlans && client.createArchitecturePlan && client.getArchitecturePlan && client.approveArchitecturePlan);

  useEffect(() => {
    if (!supported) return;
    const current = ++epoch.current;
    let cancelled = false;
    Promise.all([client.listArchitecturePlans!(target.id), client.getArchitecture(target.architectureId)])
      .then(([history, architecture]) => {
        if (cancelled || current !== epoch.current) return;
        const available = architecture.revisions?.length ? architecture.revisions : architecture.latestRevision ? [architecture.latestRevision] : [];
        setRuns(history);
        setRevisions(available);
        setRevisionId(previous => available.some(revision => revision.id === previous) ? previous : available[0]?.id ?? "");
        setState("ready");
      }).catch(error => {
        if (cancelled || current !== epoch.current) return;
        setState("error"); setMessage(safeArchitectureTargetErrorMessage(error));
      });
    return () => { cancelled = true; epoch.current += 1; };
  }, [client, supported, target.id, target.architectureId, refresh]);

  const locked = state === "loading" || state === "busy";
  const canCreate = !locked && Boolean(revisionId && observation?.id && observation.observedDigest) && target.status !== "revoked" && target.consent.status === "granted" && target.capabilities["plan.read"] === true;

  async function createPlan() {
    if (!canCreate || !observation?.id || !observation.observedDigest || !client.createArchitecturePlan) return;
    const signature = JSON.stringify([target.id, revisionId, target.generation, observation.id, observation.observedDigest]);
    if (requestRef.current?.signature !== signature) requestRef.current = { signature, input: {
      revisionId, expectedTargetGeneration: target.generation,
      expectedObservationId: observation.id, expectedObservationDigest: observation.observedDigest,
      idempotencyKey: crypto.randomUUID(),
    } };
    const request = requestRef.current;
    if (!request) return;
    const current = ++epoch.current;
    setState("busy"); setMessage(null);
    try {
      const result = await client.createArchitecturePlan(target.id, request.input);
      if (current !== epoch.current) return;
      setSelected(result.run);
      setRuns(previous => [result.run, ...previous.filter(run => run.identity.runId !== result.run.identity.runId)]);
      setState("ready");
    } catch (error) {
      if (current !== epoch.current) return;
      setState("error"); setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }

  async function inspect(runId: string) {
    if (!client.getArchitecturePlan || locked) return;
    const current = ++epoch.current;
    setState("busy"); setMessage(null);
    try {
      const run = await client.getArchitecturePlan(runId);
      if (current !== epoch.current) return;
      setSelected(run); setState("ready");
    } catch (error) {
      if (current !== epoch.current) return;
      setState("error"); setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }

  async function approve() {
    const reviewDigest = selected?.metadata?.reviewDigest;
    if (!selected || typeof reviewDigest !== "string" || !client.approveArchitecturePlan || locked) return;
    const current = ++epoch.current;
    setState("busy"); setMessage(null);
    try {
      const result = await client.approveArchitecturePlan(selected.identity.runId, reviewDigest);
      if (current !== epoch.current) return;
      setSelected(result.run);
      setRuns(previous => previous.map(run => run.identity.runId === result.run.identity.runId ? result.run : run));
      setState("ready"); setMessage("Review approved. Target execution is unavailable for this architecture plan.");
    } catch (error) {
      if (current !== epoch.current) return;
      setState("error"); setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }

  if (!supported) return <section className="cp-section" aria-label="Architecture review plans"><h3>Architecture review plans</h3><p>Review history is unavailable in this client.</p></section>;
  return <section className="cp-section architecture-plan-panel" aria-label="Architecture review plans">
    <div className="cp-section-head"><h3>Architecture review plans</h3><Button size="sm" variant="outline" disabled={locked} onClick={() => { setMessage(null); setState("loading"); setRefresh(value => value + 1); }}>Refresh plans</Button></div>
    <p className="cp-muted">Create a dry run from a saved revision and the latest observation. Review approval only records your review; target execution is unavailable.</p>
    <div className="cp-actions"><label>Saved revision<select value={revisionId} disabled={locked} onChange={event => setRevisionId(event.target.value)}><option value="">Choose a saved revision</option>{revisions.map(revision => <option key={revision.id} value={revision.id}>Revision {revision.revisionNumber} · {revision.id}</option>)}</select></label><Button size="sm" disabled={!canCreate} onClick={() => void createPlan()}>Create dry-run plan</Button></div>
    {!observation && <p className="cp-muted">Record an authorized observation before creating a plan.</p>}
    {state === "loading" && <p role="status">Loading review history…</p>}
    {message && <div className="cp-notice" data-tone={state === "error" ? "danger" : undefined} role={state === "error" ? "alert" : "status"}>{message}</div>}
    {runs.length > 0 && <ul className="architecture-plan-history">{runs.map(run => <li key={run.identity.runId}><button type="button" disabled={locked} aria-pressed={selected?.identity.runId === run.identity.runId} onClick={() => void inspect(run.identity.runId)}>{run.identity.revisionId} · {run.state} · {run.createdAt}</button></li>)}</ul>}
    {state === "ready" && !runs.length && <p className="cp-muted">No review plans yet.</p>}
    {selected && <div className="architecture-plan-inspection">
      <h4>Review approval only</h4>
      <dl className="cp-facts"><div><dt>Run</dt><dd>{selected.identity.runId}</dd></div><div><dt>Saved revision</dt><dd>{selected.identity.revisionId}</dd></div><div><dt>Target generation</dt><dd>{selected.identity.targetGeneration}</dd></div><div><dt>Context</dt><dd>{selected.identity.profileId} · {selected.identity.environmentId}</dd></div><div><dt>State</dt><dd>{selected.state}</dd></div><div><dt>Review digest</dt><dd>{String(selected.metadata?.reviewDigest ?? "Unavailable")}</dd></div></dl>
      <div className="architecture-plan-table"><table><thead><tr><th>Node</th><th>Planned action</th><th>State</th></tr></thead><tbody>{selected.steps.map(step => <tr key={step.id}><td>{step.nodeId}</td><td>{step.action}</td><td>{step.state}</td></tr>)}</tbody></table></div>
      {selected.receipts.length > 0 && <ul>{selected.receipts.map(receipt => <li key={receipt.id}>{receipt.kind} · {receipt.status} · {receipt.code}</li>)}</ul>}
      <Button size="sm" disabled={locked || selected.state !== "drafted" || target.status === "revoked" || target.consent.status !== "granted" || typeof selected.metadata?.reviewDigest !== "string"} onClick={() => void approve()}>Approve this review</Button>
    </div>}
  </section>;
}
