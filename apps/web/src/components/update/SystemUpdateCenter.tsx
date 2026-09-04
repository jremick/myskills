import { useCallback, useEffect, useMemo, useState } from "react";
import type { SkillUpdateBlockerCode } from "@myskills-app/core";
import { Check, CircleAlert, Clock3, PackageCheck, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  ArchitectureTargetRecord,
  RegistryClient,
  TargetSkillOperationRecord,
  TargetSkillUpdates,
} from "../../api.js";
import { safeArchitectureTargetErrorMessage } from "../../api.js";
import { UpgradePolicyEditor } from "./UpgradePolicyEditor.js";

interface UpdateSession { user: { email: string } }
interface TargetUpdateState { target: ArchitectureTargetRecord; updates: TargetSkillUpdates | null; operations: TargetSkillOperationRecord[]; error?: string }
interface SelectedUpdate { targetId: string; slug: string }

export function SystemUpdateCenter({ client, session }: { client: RegistryClient; session: UpdateSession }) {
  const [rows, setRows] = useState<TargetUpdateState[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedUpdate[]>([]);
  const [review, setReview] = useState<SelectedUpdate | null>(null);
  const [batchReview, setBatchReview] = useState(false);
  const [architectureReviewTarget, setArchitectureReviewTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!client.listArchitectureTargets || !client.listTargetSkillUpdates || !client.listTargetSkillOperations) {
      setState("error");
      setMessage("The system update centre is not available in this workspace.");
      return;
    }
    if (!quiet) setState("loading");
    try {
      const targets = await client.listArchitectureTargets();
      const next = await Promise.all(targets.map(async (target): Promise<TargetUpdateState> => {
        try {
          const [updates, operations] = await Promise.all([
            client.listTargetSkillUpdates!(target.id),
            client.listTargetSkillOperations!(target.id),
          ]);
          return { target, updates, operations };
        } catch (error) {
          return { target, updates: null, operations: [], error: safeArchitectureTargetErrorMessage(error) };
        }
      }));
      setRows(next);
      setSelected((current) => current.filter((item) => candidateFor(next, item)));
      setState("ready");
      setMessage(null);
    } catch (error) {
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  const hasActive = rows.some((row) => row.operations.some((operation) => ["queued", "claimed", "applying", "verifying"].includes(operation.state)));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void load(true), 4_000);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  const availableCount = rows.reduce((count, row) => count + (row.updates?.items.filter((item) => item.evaluation.status === "update-available").length ?? 0), 0);
  const activeCount = rows.reduce((count, row) => count + row.operations.filter((operation) => ["queued", "claimed", "applying", "verifying"].includes(operation.state)).length, 0);
  const reviewed = review ? reviewFor(rows, review) : null;
  const reviewedPin = review ? rows.find((row) => row.target.id === review.targetId)?.updates?.policy?.policy.pins[review.slug] : undefined;

  async function queueOne(selection: SelectedUpdate) {
    const candidate = candidateFor(rows, selection);
    if (!candidate || !client.scheduleTargetSkillOperation) return;
    setBusy(`queue:${selection.targetId}:${selection.slug}`);
    setMessage(null);
    try {
      await client.scheduleTargetSkillOperation(selection.targetId, {
        action: "update",
        slug: selection.slug,
        version: candidate.evaluation.candidate!.version,
        platform: candidate.platform,
        idempotencyKey: operationKey("update"),
      });
      setReview(null);
      await load(true);
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function queueBatch() {
    if (!client.scheduleTargetSkillOperationBatch) return;
    const operations = selected.flatMap((selection) => {
      const candidate = candidateFor(rows, selection);
      return candidate?.evaluation.candidate ? [{
        targetId: selection.targetId,
        action: "update" as const,
        slug: selection.slug,
        version: candidate.evaluation.candidate.version,
        platform: candidate.platform,
        idempotencyKey: operationKey("update"),
      }] : [];
    });
    if (!operations.length) return;
    setBusy("batch");
    try {
      await client.scheduleTargetSkillOperationBatch(operations);
      setSelected([]);
      setBatchReview(false);
      await load(true);
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancel(operation: TargetSkillOperationRecord) {
    if (!client.cancelTargetSkillOperation) return;
    setBusy(`cancel:${operation.id}`);
    try {
      await client.cancelTargetSkillOperation(operation.id);
      await load(true);
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function rollback(operation: TargetSkillOperationRecord) {
    if (!client.scheduleTargetSkillOperation || !operation.fromVersion) return;
    setBusy(`rollback:${operation.id}`);
    try {
      await client.scheduleTargetSkillOperation(operation.targetId, {
        action: "rollback",
        slug: operation.skillSlug,
        version: operation.fromVersion,
        platform: operation.platform,
        idempotencyKey: operationKey("rollback"),
      });
      await load(true);
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function promoteArchitecture(targetId: string) {
    const row = rows.find((item) => item.target.id === targetId);
    if (!row?.updates || !client.createArchitectureRevision) return;
    setBusy(`architecture:${targetId}`);
    try {
      const architecture = await client.getArchitecture(row.target.architectureId);
      const source = architecture.latestRevision;
      if (!source || source.id !== architecture.currentRevisionId) throw new Error("The current architecture revision changed. Refresh before creating a revision.");
      const candidates = new Map(row.updates.items.filter((item) => item.evaluation.status === "update-available" && item.evaluation.candidate).map((item) => [item.slug, item.evaluation.candidate!]));
      const spec = {
        ...source.spec,
        skills: source.spec.skills.map((skill) => {
          const candidate = candidates.get(skill.slug);
          return candidate ? { ...skill, version: candidate.version, digest: candidate.artifact.sha256 } : skill;
        }),
      };
      await client.createArchitectureRevision(row.target.architectureId, {
        spec,
        expectedCurrentRevisionId: source.id,
        message: `Promote ${candidates.size} reviewed skill update${candidates.size === 1 ? "" : "s"}`,
      });
      setArchitectureReviewTarget(null);
      setMessage("A new immutable architecture revision was created. Connected targets remain unchanged until you queue their operations.");
    } catch (error) {
      setMessage(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return <main className="control-plane-workspace update-centre-workspace" aria-label="System update centre">
    <section className="control-plane-hero" aria-labelledby="updates-heading"><div><p className="control-plane-kicker">Installed state and recovery</p><h1 id="updates-heading">System update centre</h1><p>{session.user.email} · {availableCount} updates available · {activeCount} active operations</p></div><Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />Refresh</Button></section>
    {message && <div className="safe-message control-plane-message" role="status">{message}</div>}
    {state === "loading" && <div className="control-plane-loading" role="status"><span /><span /><span className="short" /></div>}
    {state === "error" && <div className="safe-message control-plane-message" role="alert"><CircleAlert size={20} aria-hidden="true" />{message}</div>}
    {state === "ready" && rows.length === 0 && <Card className="control-plane-card"><CardContent className="control-plane-empty-state"><PackageCheck size={28} aria-hidden="true" /><strong>No installed targets</strong><span>Register a target and submit its bounded inventory before checking for updates.</span></CardContent></Card>}
    {state === "ready" && selected.length > 0 && <Card className="control-plane-card update-batch-card"><CardHeader><CardTitle>{selected.length} selected updates</CardTitle><CardDescription>Batch execution creates one separately fenced and recoverable operation per target and skill.</CardDescription></CardHeader><CardContent><div className="target-action-row">{batchReview ? <><Button disabled={busy === "batch"} onClick={() => void queueBatch()}><Check size={15} />{busy === "batch" ? "Queueing…" : "Confirm batch"}</Button><Button variant="outline" onClick={() => setBatchReview(false)}>Back</Button></> : <Button onClick={() => setBatchReview(true)}>Review batch</Button>}<Button variant="outline" onClick={() => setSelected([])}>Clear</Button></div>{batchReview && <ul>{selected.map((item) => { const candidate = candidateFor(rows, item); return <li key={`${item.targetId}:${item.slug}`}>{item.slug} → {candidate?.evaluation.candidate?.version} on {rows.find((row) => row.target.id === item.targetId)?.target.name}</li>; })}</ul>}</CardContent></Card>}
    <div className="update-centre-grid">{rows.map((row) => <TargetUpdateCard key={row.target.id} row={row} selected={selected} busy={busy} architectureReview={architectureReviewTarget === row.target.id} onSelect={(selection, checked) => setSelected((current) => checked ? [...current.filter((item) => item.targetId !== selection.targetId || item.slug !== selection.slug), selection] : current.filter((item) => item.targetId !== selection.targetId || item.slug !== selection.slug))} onReview={setReview} onArchitectureReview={() => setArchitectureReviewTarget((current) => current === row.target.id ? null : row.target.id)} onPromoteArchitecture={() => void promoteArchitecture(row.target.id)} onCancel={(operation) => void cancel(operation)} onRollback={(operation) => void rollback(operation)} client={client} onPolicySaved={() => void load(true)} />)}</div>
    {reviewed && review && <Card className="control-plane-card update-review-card" aria-label="Update review"><CardHeader><CardTitle>{reviewed.evaluation.candidate ? `Review ${review.slug} ${reviewed.evaluation.installedVersion} → ${reviewed.evaluation.candidate.version}` : `Review blocked update for ${review.slug}`}</CardTitle><CardDescription>Review every included release before queueing the exact artifact.</CardDescription></CardHeader><CardContent>{reviewed.evaluation.blockers.length > 0 && <p>{reviewed.evaluation.blockers.map((blocker) => updateBlockerText(blocker, reviewedPin)).join(" ")}</p>}<div className="release-review-list">{reviewed.evaluation.includedReleases.map((release) => <article key={release.version}><div><strong>{release.version}</strong> <Badge variant="outline">{release.changeKind}</Badge>{release.requiresUserAction && <Badge variant="destructive">User action required</Badge>}</div><p>{release.releaseNotes || "No release notes were supplied."}</p><small>SHA-256 {release.artifact.sha256.slice(0, 12)}… · {release.artifact.byteSize.toLocaleString()} bytes</small></article>)}</div><div className="target-action-row"><Button disabled={reviewed.evaluation.status !== "update-available" || busy?.startsWith("queue:")} onClick={() => void queueOne(review)}><ShieldCheck size={15} />Queue exact update</Button><Button variant="outline" onClick={() => setReview(null)}>Close</Button></div></CardContent></Card>}
  </main>;
}

function TargetUpdateCard({ row, selected, busy, architectureReview, onSelect, onReview, onArchitectureReview, onPromoteArchitecture, onCancel, onRollback, client, onPolicySaved }: {
  row: TargetUpdateState;
  selected: SelectedUpdate[];
  busy: string | null;
  architectureReview: boolean;
  onSelect: (selection: SelectedUpdate, checked: boolean) => void;
  onReview: (selection: SelectedUpdate) => void;
  onArchitectureReview: () => void;
  onPromoteArchitecture: () => void;
  onCancel: (operation: TargetSkillOperationRecord) => void;
  onRollback: (operation: TargetSkillOperationRecord) => void;
  client: RegistryClient;
  onPolicySaved: () => void;
}) {
  const candidates = row.updates?.items.filter((item) => item.evaluation.status === "update-available") ?? [];
  return <Card className="control-plane-card target-update-card"><CardHeader><div><CardTitle>{row.target.name}</CardTitle><CardDescription>{row.target.adapter.kind} · generation {row.target.generation} · observed {formatDate(row.updates?.observedAt)}</CardDescription></div><Badge variant={candidates.length ? "secondary" : "outline"}>{candidates.length} updates</Badge></CardHeader><CardContent>
    {row.error && <div className="control-plane-inline-message" role="alert">{row.error}</div>}
    {row.updates && <><div className="target-update-policy-summary"><span>Policy: {row.updates.policy?.source ?? "default"}</span><span>Channel: {row.updates.policy?.policy.includePrerelease ? "prerelease" : "stable"}</span><span>Mode: {row.updates.policy?.policy.mode ?? "manual"}</span></div><div className="target-update-list">{row.updates.items.map((item) => {
      const selection = { targetId: row.target.id, slug: item.slug };
      const checked = selected.some((candidate) => candidate.targetId === selection.targetId && candidate.slug === selection.slug);
      return <div className="target-update-row" key={item.slug}><label><input type="checkbox" disabled={item.evaluation.status !== "update-available"} checked={checked} onChange={(event) => onSelect(selection, event.target.checked)} /><span><strong>{item.slug}</strong><small>{item.evaluation.installedVersion} {item.evaluation.candidate ? `→ ${item.evaluation.candidate.version}` : ""}</small>{item.evaluation.blockers.length > 0 && <small className="block">{item.evaluation.blockers.map((blocker) => updateBlockerText(blocker, row.updates?.policy?.policy.pins[item.slug])).join(" ")}</small>}</span></label><Badge variant={item.evaluation.status === "update-available" ? "secondary" : item.evaluation.status === "drifted" ? "destructive" : "outline"}>{item.evaluation.status}</Badge>{(item.evaluation.status === "update-available" || (item.evaluation.blockers.length > 0 && item.evaluation.includedReleases.length > 0)) && <Button size="sm" variant="outline" onClick={() => onReview(selection)}>Review</Button>}</div>;
    })}</div>{row.updates.items.length === 0 && <p className="control-plane-muted">No managed installed skills were present in the latest observation.</p>}
    <div className="target-action-row"><Button disabled={!candidates.length} size="sm" variant="outline" onClick={onArchitectureReview}>Review architecture revision</Button>{architectureReview && <Button disabled={busy === `architecture:${row.target.id}`} size="sm" onClick={onPromoteArchitecture}>{busy === `architecture:${row.target.id}` ? "Creating…" : `Confirm ${candidates.length} pinned versions`}</Button>}</div>
    <UpgradePolicyEditor client={client} target={row.target} resolved={row.updates.policy} onSaved={onPolicySaved} /></>}
    <section className="target-operation-history" aria-label={`Operation history for ${row.target.name}`}><h3>Operations and recovery</h3>{row.operations.map((operation) => <div className="target-operation-row" key={operation.id}><Clock3 size={15} aria-hidden="true" /><span><strong>{operation.action} {operation.skillSlug}</strong><small>{operation.fromVersion ?? "not installed"} → {operation.toVersion} · {operation.result?.code ?? operation.state}</small></span><Badge variant={operation.state === "succeeded" ? "secondary" : operation.state === "failed" ? "destructive" : "outline"}>{operation.state}</Badge>{operation.state === "queued" && <Button size="sm" variant="outline" disabled={busy === `cancel:${operation.id}`} onClick={() => onCancel(operation)}>Cancel</Button>}{operation.state === "succeeded" && operation.action !== "rollback" && operation.fromVersion && <Button size="sm" variant="outline" disabled={busy === `rollback:${operation.id}`} onClick={() => onRollback(operation)}><RotateCcw size={14} />Rollback</Button>}</div>)}{row.operations.length === 0 && <p className="control-plane-muted">No update or rollback operations yet.</p>}</section>
  </CardContent></Card>;
}

function candidateFor(rows: TargetUpdateState[], selection: SelectedUpdate) {
  return rows.find((row) => row.target.id === selection.targetId)?.updates?.items.find((item) => item.slug === selection.slug && item.evaluation.status === "update-available") ?? null;
}

function reviewFor(rows: TargetUpdateState[], selection: SelectedUpdate) {
  return rows.find((row) => row.target.id === selection.targetId)?.updates?.items.find((item) => item.slug === selection.slug && (item.evaluation.candidate || item.evaluation.includedReleases.length > 0)) ?? null;
}

function updateBlockerText(blocker: SkillUpdateBlockerCode, pinnedVersion?: string): string {
  if (blocker === "pinned-release-unavailable" && pinnedVersion) return `Pinned release ${pinnedVersion} is unavailable. Choose an available version in the upgrade policy.`;
  const messages: Record<SkillUpdateBlockerCode, string> = {
    "release-deprecated": "This release is deprecated.",
    "platform-unsupported": "This release does not support the target's platform.",
    "prerelease-not-selected": "Prereleases are disabled by the upgrade policy.",
    "minimum-myskills-version": "Update the MySkills CLI before installing this release.",
    "minimum-adapter-contract-version": "This release requires a newer adapter contract.",
    "minimum-source-version": "Install the required intermediate release first.",
    "pinned-release-unavailable": "The pinned release is unavailable.",
    "change-kind-not-allowed": "The upgrade crosses a release change kind that your policy does not allow.",
  };
  return messages[blocker];
}

function operationKey(action: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${action}:${random.replaceAll("-", "")}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "unknown" : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
