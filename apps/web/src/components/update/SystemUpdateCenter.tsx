import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { SkillUpdateBlockerCode, SkillUpgradeMaintenanceWindow } from "@myskills-app/core";
import { ArrowLeft, Check, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import type {
  ArchitectureTargetRecord,
  RegistryClient,
  TargetSkillOperationRecord,
  TargetSkillUpdates,
} from "../../api.js";
import { safeArchitectureTargetErrorMessage, targetSkillUpgradePolicyConstraints } from "../../api.js";
import { canQueueWorkspaceOperation } from "../target/workspace-target.js";
import { useSplitLayout } from "../registry/useSplitLayout.js";
import {
  adapterLabel,
  changeKindLabel,
  isActiveOperationState,
  operationActionLabel,
  operationStateLabel,
  plural,
  targetStatusLabel,
  toneOf,
  updateStatusLabel,
  updateStatusRank,
} from "../control-plane/control-plane-display.js";
import { UpgradePolicyEditor } from "./UpgradePolicyEditor.js";

interface UpdateSession { user: { email: string } }
interface TargetUpdateState { target: ArchitectureTargetRecord; updates: TargetSkillUpdates | null; operations: TargetSkillOperationRecord[]; error?: string }
interface SelectedUpdate { targetId: string; slug: string }
interface RollbackReview { operation: TargetSkillOperationRecord; targetName: string; idempotencyKey: string }
interface TargetNotice { targetId: string; text: string; tone: "status" | "error" }
type PendingFocus = { kind: "title" } | { kind: "row"; id: string } | { kind: "review" } | { kind: "batch" };

export function SystemUpdateCenter({ client, session }: { client: RegistryClient; session: UpdateSession }) {
  const [rows, setRows] = useState<TargetUpdateState[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<TargetNotice | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedUpdate[]>([]);
  const [review, setReview] = useState<SelectedUpdate | null>(null);
  const [batchReview, setBatchReview] = useState(false);
  const [architectureReviewTarget, setArchitectureReviewTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rollbackReview, setRollbackReview] = useState<RollbackReview | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const { layout, ref: measureSurface } = useSplitLayout();
  const surfaceNode = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const batchHeadingRef = useRef<HTMLHeadingElement>(null);
  const reviewButtons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);

  const surfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceNode.current = node;
    measureSurface(node);
  }, [measureSurface]);

  const refresh = useMemo(() => ({
    active: false,
    pending: false,
    inFlight: null as Promise<void> | null,
  }), [client, session.user.email]);

  const load = useCallback((quiet = false, afterMutation = false): Promise<void> => {
    if (!refresh.active) return Promise.resolve();
    if (refresh.inFlight) {
      // Serialize refreshes, including those requested after a mutation. Skip
      // publishing an older snapshot when a newer refresh is already pending.
      if (!quiet || afterMutation) refresh.pending = true;
      return refresh.inFlight;
    }
    if (!client.listArchitectureTargets || !client.listTargetSkillUpdates || !client.listTargetSkillOperations) {
      setState("error");
      setLoadError("The system update centre is not available in this workspace.");
      return Promise.resolve();
    }
    if (!quiet) setState("loading");
    refresh.inFlight = (async () => {
      do {
        refresh.pending = false;
        try {
          const targets = await client.listArchitectureTargets!();
          if (!refresh.active) return;
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
          if (!refresh.active) return;
          if (refresh.pending) continue;
          setRows(next);
          setSelected((current) => current.filter((item) => candidateFor(next, item)));
          setState("ready");
          setLoadError(null);
        } catch (error) {
          if (!refresh.active) return;
          if (refresh.pending) continue;
          setState("error");
          setLoadError(safeArchitectureTargetErrorMessage(error));
        }
      } while (refresh.active && refresh.pending);
    })().finally(() => { refresh.inFlight = null; });
    return refresh.inFlight;
  }, [client, refresh]);

  useEffect(() => {
    refresh.active = true;
    setRows([]);
    setSelected([]);
    setReview(null);
    setRollbackReview(null);
    setSelectedTargetId(null);
    setOpened(false);
    setNotice(null);
    setBatchError(null);
    void load();
    return () => { refresh.active = false; };
  }, [load, refresh]);
  const hasActive = rows.some((row) => row.operations.some((operation) => isActiveOperationState(operation.state)));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void load(true), 4_000);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  // A target that leaves the refreshed list (for example after revocation of
  // access) must not keep its review or its opened phone view.
  useEffect(() => {
    if (state !== "ready" || !selectedTargetId || rows.some((row) => row.target.id === selectedTargetId)) return;
    setSelectedTargetId(null);
    setOpened(false);
    setReview(null);
    setArchitectureReviewTarget(null);
  }, [rows, selectedTargetId, state]);

  useEffect(() => {
    if (selected.length === 0) setBatchReview(false);
  }, [selected.length]);

  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    const element = next.kind === "title" ? titleRef.current
      : next.kind === "review" ? reviewHeadingRef.current
        : next.kind === "batch" ? batchHeadingRef.current
          : Array.from(surfaceNode.current?.querySelectorAll<HTMLElement>("[data-target-id]") ?? []).find((item) => item.dataset.targetId === next.id) ?? null;
    if (!element || element.closest("[hidden]")) return;
    pendingFocus.current = null;
    element.focus();
  });

  const selectedRow = rows.find((row) => row.target.id === selectedTargetId) ?? rows[0] ?? null;
  const single = rows.length === 1;
  const stacked = layout === "stack";
  const showList = !stacked || (!single && !opened);
  const showDetail = !stacked || single || opened;

  const availableCount = rows.reduce((count, row) => count + (row.updates?.items.filter((item) => item.evaluation.status === "update-available").length ?? 0), 0);
  const activeCount = rows.reduce((count, row) => count + row.operations.filter((operation) => isActiveOperationState(operation.state)).length, 0);
  const selectedTargetCount = new Set(selected.map((item) => item.targetId)).size;
  const rollbackObservedVersion = rollbackReview && rows.find((row) => row.target.id === rollbackReview.operation.targetId)?.updates?.items
    .find((item) => item.slug === rollbackReview.operation.skillSlug && item.platform === rollbackReview.operation.platform)?.evaluation.installedVersion;

  function selectTarget(targetId: string) {
    setSelectedTargetId(targetId);
    setReview(null);
    setArchitectureReviewTarget(null);
    if (stacked) {
      setOpened(true);
      pendingFocus.current = { kind: "title" };
    }
  }

  function backToTargets() {
    setOpened(false);
    setReview(null);
    if (selectedRow) pendingFocus.current = { kind: "row", id: selectedRow.target.id };
  }

  function openReview(selection: SelectedUpdate) {
    setReview(selection);
    pendingFocus.current = { kind: "review" };
  }

  function closeReview(selection: SelectedUpdate) {
    setReview(null);
    reviewButtons.current.get(`${selection.targetId}:${selection.slug}`)?.focus();
  }

  async function queueOne(selection: SelectedUpdate) {
    const candidate = candidateFor(rows, selection);
    if (!candidate || !client.scheduleTargetSkillOperation) return;
    setBusy(`queue:${selection.targetId}:${selection.slug}`);
    setNotice(null);
    try {
      await client.scheduleTargetSkillOperation(selection.targetId, {
        action: "update",
        slug: selection.slug,
        version: candidate.evaluation.candidate!.version,
        platform: candidate.platform,
        idempotencyKey: operationKey("update"),
      });
      setReview(null);
      reviewButtons.current.get(`${selection.targetId}:${selection.slug}`)?.focus();
      await load(true, true);
    } catch (error) {
      setNotice({ targetId: selection.targetId, text: safeArchitectureTargetErrorMessage(error), tone: "error" });
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
    setBatchError(null);
    try {
      await client.scheduleTargetSkillOperationBatch(operations);
      setSelected([]);
      setBatchReview(false);
      await load(true, true);
    } catch (error) {
      setBatchError(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function cancel(operation: TargetSkillOperationRecord) {
    if (!client.cancelTargetSkillOperation) return;
    setBusy(`cancel:${operation.id}`);
    setNotice(null);
    try {
      await client.cancelTargetSkillOperation(operation.id);
      await load(true, true);
    } catch (error) {
      setNotice({ targetId: operation.targetId, text: safeArchitectureTargetErrorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function reviewRollback(operation: TargetSkillOperationRecord) {
    const row = rows.find((item) => item.target.id === operation.targetId);
    if (!row || !operation.fromVersion || !canQueueWorkspaceOperation(row.target, operation.platform, "rollback")) return;
    setRollbackReview({ operation, targetName: row.target.name, idempotencyKey: operationKey("rollback") });
  }

  async function rollback({ operation, idempotencyKey }: RollbackReview) {
    const target = rows.find((row) => row.target.id === operation.targetId)?.target;
    if (!target || !canQueueWorkspaceOperation(target, operation.platform, "rollback") || !client.scheduleTargetSkillOperation || !operation.fromVersion) {
      throw new Error("This workspace can no longer accept the rollback. Cancel and refresh its access and consent.");
    }
    setBusy(`rollback:${operation.id}`);
    try {
      await client.scheduleTargetSkillOperation(operation.targetId, {
        action: "rollback",
        slug: operation.skillSlug,
        version: operation.fromVersion,
        platform: operation.platform,
        idempotencyKey,
      });
      await load(true, true);
    } catch (error) {
      throw new Error(safeArchitectureTargetErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function promoteArchitecture(targetId: string) {
    const row = rows.find((item) => item.target.id === targetId);
    if (!row?.updates || !client.createArchitectureRevision) return;
    setBusy(`architecture:${targetId}`);
    setNotice(null);
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
      setNotice({ targetId, text: "A new immutable architecture revision was created. Connected targets remain unchanged until you queue their operations.", tone: "status" });
    } catch (error) {
      setNotice({ targetId, text: safeArchitectureTargetErrorMessage(error), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  function toggleSelection(selection: SelectedUpdate, checked: boolean) {
    if (checked && !candidateFor(rows, selection)) return;
    setSelected((current) => checked
      ? [...current.filter((item) => item.targetId !== selection.targetId || item.slug !== selection.slug), selection]
      : current.filter((item) => item.targetId !== selection.targetId || item.slug !== selection.slug));
  }

  return <main className="control-plane-workspace update-centre-workspace cp-page" aria-label="System update centre">
    <header className="cp-page-head app-page-header">
      <div>
        <h1 id="updates-heading">System update centre</h1>
        {state !== "loading" || rows.length > 0 ? <p>{plural(availableCount, "update")} available · {activeCount} in progress</p> : null}
      </div>
      <div className="cp-page-actions">
        <Button aria-label="Refresh" size="icon-sm" title="Refresh" type="button" variant="outline" onClick={() => { setNotice(null); void load(); }}><RefreshCw size={16} aria-hidden="true" /></Button>
      </div>
    </header>
    <div className="cp-surface" data-layout={layout} data-empty={state === "ready" && rows.length === 0 ? "true" : undefined} ref={surfaceRef}>
      {state === "error" && loadError && <div className="cp-surface-alert" role="alert">{loadError}</div>}
      {selected.length > 0 && <section className="cp-tray" aria-labelledby="update-batch-heading">
        <div className="cp-tray-head">
          <h2 id="update-batch-heading" ref={batchHeadingRef} tabIndex={-1}>{`${selected.length} selected across ${plural(selectedTargetCount, "target")}`}</h2>
          <div className="cp-actions">
            {batchReview
              ? <><Button disabled={busy === "batch"} size="sm" type="button" onClick={() => void queueBatch()}><Check size={15} aria-hidden="true" />{busy === "batch" ? "Queueing…" : "Confirm batch"}</Button><Button size="sm" type="button" variant="outline" onClick={() => setBatchReview(false)}>Back</Button></>
              : <Button size="sm" type="button" variant="outline" onClick={() => { setBatchReview(true); pendingFocus.current = { kind: "batch" }; }}>Review batch</Button>}
            <Button size="sm" type="button" variant="outline" onClick={() => { setSelected([]); setBatchError(null); }}>Clear</Button>
          </div>
        </div>
        {batchReview && <>
          <p className="cp-muted">Each item becomes its own fenced, recoverable operation for that target and skill.</p>
          <ul className="cp-tray-list">{selected.map((item) => {
            const candidate = candidateFor(rows, item);
            return <li key={`${item.targetId}:${item.slug}`}><code>{item.slug}</code> {candidate?.evaluation.installedVersion} → {candidate?.evaluation.candidate?.version} on <strong>{rows.find((row) => row.target.id === item.targetId)?.target.name}</strong></li>;
          })}</ul>
        </>}
        {batchError && <p className="cp-notice" data-tone="danger" role="alert">{batchError}</p>}
      </section>}
      <div className="cp-body">
        <section className="cp-list" aria-label="Targets with installed skills" hidden={!showList}>
          <div className="cp-list-label"><h2>Targets</h2><span aria-live="polite">{state === "loading" && rows.length === 0 ? "" : rows.length}</span></div>
          {state === "loading" && rows.length === 0 && <div className="cp-loading" role="status"><span className="sr-only">Loading update targets…</span><span /><span /><span /></div>}
          {state === "ready" && rows.length === 0 && <div className="cp-list-state"><strong>No installed targets</strong><p>Register a target and submit its bounded inventory before checking for updates.</p></div>}
          {rows.length > 0 && <div className="cp-rows">{rows.map((row) => {
            const current = row.target.id === selectedRow?.target.id;
            const available = row.updates?.items.filter((item) => item.evaluation.status === "update-available").length ?? 0;
            const active = row.operations.filter((operation) => isActiveOperationState(operation.state)).length;
            const chosen = selected.filter((item) => item.targetId === row.target.id).length;
            const status = targetStatusLabel(row.target.status);
            return <button aria-current={current ? "true" : undefined} aria-pressed={current} className="cp-row" data-target-id={row.target.id} key={row.target.id} type="button" onClick={() => selectTarget(row.target.id)}>
              <span className="cp-row-text"><span className="cp-row-title">{row.target.name}</span><span className="cp-row-meta">{adapterLabel(row.target.adapter.kind)} · observed {formatDate(row.updates?.observedAt)}</span></span>
              <span className="cp-row-chips">
                {row.target.status !== "connected" && <span className="cp-chip" data-tone={toneOf(status)}>{status.label}</span>}
                {available > 0 && <span className="cp-chip" data-tone="teal">{available} available</span>}
                {active > 0 && <span className="cp-chip">{active} in progress</span>}
                {chosen > 0 && <span className="cp-chip" data-tone="amber">{chosen} selected</span>}
              </span>
            </button>;
          })}</div>}
        </section>
        <div className="cp-inspector" hidden={!showDetail || !selectedRow}>
          {selectedRow && <TargetUpdateSurface
            key={selectedRow.target.id}
            row={selectedRow}
            titleRef={titleRef}
            reviewHeadingRef={reviewHeadingRef}
            reviewButtons={reviewButtons.current}
            onBack={stacked && !single ? backToTargets : undefined}
            notice={notice?.targetId === selectedRow.target.id ? notice : null}
            selected={selected}
            busy={busy}
            review={review?.targetId === selectedRow.target.id ? review : null}
            rows={rows}
            architectureReview={architectureReviewTarget === selectedRow.target.id}
            onSelect={toggleSelection}
            onReview={openReview}
            onCloseReview={closeReview}
            onQueue={(selection) => void queueOne(selection)}
            onArchitectureReview={() => setArchitectureReviewTarget((current) => current === selectedRow.target.id ? null : selectedRow.target.id)}
            onPromoteArchitecture={() => void promoteArchitecture(selectedRow.target.id)}
            onCancel={(operation) => void cancel(operation)}
            onRollback={reviewRollback}
            client={client}
            onPolicySaved={() => void load(true, true)}
          />}
        </div>
      </div>
    </div>
    {rollbackReview && <ConfirmationDialog request={{
      key: `rollback-${rollbackReview.operation.id}`,
      title: `Queue rollback for ${rollbackReview.operation.skillSlug}?`,
      description: "The workspace runner will replace the installed skill with the selected earlier version. Current access, consent and upgrade policy still apply.",
      details: [
        { label: "Workspace", value: rollbackReview.targetName },
        { label: "Skill", value: rollbackReview.operation.skillSlug },
        { label: "Recorded update", value: `${rollbackReview.operation.fromVersion} → ${rollbackReview.operation.toVersion}` },
        { label: "Currently observed", value: rollbackObservedVersion ?? "Unavailable; refresh the workspace inventory to verify." },
        { label: "Roll back to", value: rollbackReview.operation.fromVersion! },
      ],
      confirmLabel: "Queue rollback",
      onConfirm: () => rollback(rollbackReview),
    }} onClose={() => setRollbackReview(null)} />}
  </main>;
}

function TargetUpdateSurface({ row, titleRef, reviewHeadingRef, reviewButtons, onBack, notice, selected, busy, review, rows, architectureReview, onSelect, onReview, onCloseReview, onQueue, onArchitectureReview, onPromoteArchitecture, onCancel, onRollback, client, onPolicySaved }: {
  row: TargetUpdateState;
  titleRef: RefObject<HTMLHeadingElement | null>;
  reviewHeadingRef: RefObject<HTMLHeadingElement | null>;
  reviewButtons: Map<string, HTMLButtonElement>;
  onBack?: () => void;
  notice: TargetNotice | null;
  selected: SelectedUpdate[];
  busy: string | null;
  review: SelectedUpdate | null;
  rows: TargetUpdateState[];
  architectureReview: boolean;
  onSelect: (selection: SelectedUpdate, checked: boolean) => void;
  onReview: (selection: SelectedUpdate) => void;
  onCloseReview: (selection: SelectedUpdate) => void;
  onQueue: (selection: SelectedUpdate) => void;
  onArchitectureReview: () => void;
  onPromoteArchitecture: () => void;
  onCancel: (operation: TargetSkillOperationRecord) => void;
  onRollback: (operation: TargetSkillOperationRecord) => void;
  client: RegistryClient;
  onPolicySaved: () => void;
}) {
  const baseId = useId();
  const candidates = row.updates?.items.filter((item) => item.evaluation.status === "update-available") ?? [];
  const constraints = targetSkillUpgradePolicyConstraints(row.updates?.policy);
  const items = [...(row.updates?.items ?? [])].sort((left, right) => updateStatusRank(left.evaluation.status) - updateStatusRank(right.evaluation.status));
  const active = row.operations.filter((operation) => isActiveOperationState(operation.state));
  const history = row.operations.filter((operation) => !isActiveOperationState(operation.state));
  const reviewed = review ? reviewFor(rows, review) : null;
  const reviewedPin = review ? policyPin(row.updates?.policy, review.slug) : undefined;

  const operationRow = (operation: TargetSkillOperationRecord) => {
    const stateLabel = operationStateLabel(operation.state);
    return <div className="target-operation-row" key={operation.id}>
      <span><strong>{operationActionLabel(operation.action)} <code>{operation.skillSlug}</code></strong><small>{operation.fromVersion ?? "Not installed"} → {operation.toVersion}</small>{operation.result?.code && <small className="cp-mono">Result code: {operation.result.code}</small>}</span>
      <span className="cp-chip" data-tone={toneOf(stateLabel)}>{stateLabel.label}</span>
      <span className="cp-row-actions">
        {operation.state === "queued" && <Button size="sm" type="button" variant="outline" disabled={busy === `cancel:${operation.id}`} onClick={() => onCancel(operation)}>Cancel</Button>}
        {operation.state === "succeeded" && operation.action !== "rollback" && operation.fromVersion && <Button size="sm" type="button" variant="outline" disabled={busy === `rollback:${operation.id}` || !canQueueWorkspaceOperation(row.target, operation.platform, "rollback")} onClick={() => onRollback(operation)}><RotateCcw size={14} aria-hidden="true" />Rollback</Button>}
      </span>
    </div>;
  };

  return <article className="cp-detail" aria-labelledby={`${baseId}-title`}>
    <header className="cp-detail-head">
      {onBack && <Button className="cp-back" type="button" variant="ghost" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Back to targets</Button>}
      <div className="cp-title-block">
        <h2 id={`${baseId}-title`} ref={titleRef} tabIndex={-1}>{row.target.name}</h2>
        <p className="cp-meta">{adapterLabel(row.target.adapter.kind)} · generation {row.target.generation} · observed {formatDate(row.updates?.observedAt)}</p>
        {row.updates && <p className="cp-meta target-update-policy-summary"><span>Policies: {constraints.map(({ source, revision }) => `${source}${revision ? ` r${revision.revisionNumber}` : ""}`).join(" + ") || "default"}</span><span>Channel: {(constraints.length > 0 && constraints.every(({ policy }) => policy.includePrerelease)) ? "prerelease" : "stable"}</span><span>{constraints.some(({ policy }) => policy.mode === "maintenance-window") ? "Queued work requires every maintenance window to be open" : "Manually queued"}</span>{constraints.map(({ source, policy }) => policy.mode === "maintenance-window" && policy.maintenanceWindow
          ? <span key={source}>{source} window: {windowSummary(policy.maintenanceWindow)}</span> : null)}</p>}
      </div>
      {row.updates && <UpgradePolicyEditor client={client} target={row.target} resolved={row.updates.policy} onSaved={onPolicySaved} />}
    </header>
    {!canQueueWorkspaceOperation(row.target, "codex", "update") && <p className="cp-muted">Browser execution requires a consented personal Codex workspace enrolled with the CLI. Update details and operation history remain available.</p>}
    {row.error && <p className="cp-notice" data-tone="danger" role="alert">{row.error}</p>}
    {notice && <p className="cp-notice" data-tone={notice.tone === "error" ? "danger" : undefined} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
    {row.updates && <section className="cp-section" aria-labelledby={`${baseId}-installed`}>
      <div className="cp-section-head"><h3 id={`${baseId}-installed`}>Installed skills</h3></div>
      <div className="target-update-list">{items.map((item) => {
        const selection = { targetId: row.target.id, slug: item.slug };
        const checked = selected.some((candidate) => candidate.targetId === selection.targetId && candidate.slug === selection.slug);
        const status = updateStatusLabel(item.evaluation.status);
        const reviewable = item.evaluation.status === "update-available" || (item.evaluation.blockers.length > 0 && item.evaluation.includedReleases.length > 0);
        const reviewKey = `${row.target.id}:${item.slug}`;
        const reviewOpen = review?.slug === item.slug && reviewed;
        return <Fragment key={item.slug}>
          <div className="target-update-row">
            <label><input type="checkbox" disabled={item.evaluation.status !== "update-available" || !canQueueWorkspaceOperation(row.target, item.platform, "update")} checked={checked} onChange={(event) => onSelect(selection, event.target.checked)} /><span><strong>{item.slug}</strong><small>{item.evaluation.installedVersion} {item.evaluation.candidate ? `→ ${item.evaluation.candidate.version}` : ""}</small>{item.library && <small className="block">{item.library.state === "adopted" ? `Library adoption: ${item.library.adoptedVersions.join(", ")}` : item.library.state === "curation-unavailable" ? "Library unavailable. The retained pin prevents automatic fallback." : "Library recommendations conflict. Resolve the bindings before updating."}</small>}{item.evaluation.blockers.length > 0 && <small className="block">{item.evaluation.blockers.map((blocker) => updateBlockerText(blocker, policyPin(row.updates?.policy, item.slug))).join(" ")}</small>}</span></label>
            <span className="cp-row-actions">
              <span className="cp-chip" data-tone={toneOf(status)}>{status.label}</span>
              {reviewable && <Button aria-expanded={Boolean(reviewOpen)} ref={(node) => { if (node) reviewButtons.set(reviewKey, node); else reviewButtons.delete(reviewKey); }} size="sm" type="button" variant="outline" onClick={() => onReview(selection)}>Review</Button>}
            </span>
          </div>
          {reviewOpen && review && reviewed && <section className="cp-review update-review-card" aria-label="Update review">
            <h3 ref={reviewHeadingRef} tabIndex={-1}>{reviewed.evaluation.candidate ? `Review ${review.slug} ${reviewed.evaluation.installedVersion} → ${reviewed.evaluation.candidate.version}` : `Review blocked update for ${review.slug}`}</h3>
            <p className="cp-muted">Review every included release before queueing the exact artifact.</p>
            {reviewed.evaluation.blockers.length > 0 && <p className="cp-notice">{reviewed.evaluation.blockers.map((blocker) => updateBlockerText(blocker, reviewedPin)).join(" ")}</p>}
            <div className="release-review-list">{reviewed.evaluation.includedReleases.map((release) => <article key={release.version}><div className="cp-chips"><strong>{release.version}</strong><span className="cp-chip">{changeKindLabel(release.changeKind)}</span>{release.requiresUserAction && <span className="cp-chip" data-tone="danger">User action required</span>}</div><p>{release.releaseNotes || "No release notes were supplied."}</p><small className="cp-mono">SHA-256 {release.artifact.sha256.slice(0, 12)}… · {release.artifact.byteSize.toLocaleString()} bytes</small></article>)}</div>
            <div className="cp-actions"><Button disabled={!candidateFor(rows, review) || busy?.startsWith("queue:")} size="sm" type="button" onClick={() => onQueue(review)}><ShieldCheck size={15} aria-hidden="true" />Queue exact update</Button><Button size="sm" type="button" variant="outline" onClick={() => onCloseReview(review)}>Close</Button></div>
          </section>}
        </Fragment>;
      })}</div>
      {row.updates.items.length === 0 && <p className="cp-muted">No managed installed skills were present in the latest observation.</p>}
      <div className="cp-actions"><Button disabled={!candidates.length} size="sm" type="button" variant="outline" onClick={onArchitectureReview}>Review architecture revision</Button>{architectureReview && <Button disabled={busy === `architecture:${row.target.id}`} size="sm" type="button" variant="outline" onClick={onPromoteArchitecture}>{busy === `architecture:${row.target.id}` ? "Creating…" : `Confirm ${candidates.length} pinned versions`}</Button>}</div>
    </section>}
    <section className="cp-section target-operation-history" aria-label={`Operation history for ${row.target.name}`}>
      {active.length > 0 && <div className="cp-band"><h3>In progress</h3>{active.map(operationRow)}</div>}
      <div className="cp-band"><h3>History</h3>{history.map(operationRow)}{row.operations.length === 0 ? <p className="cp-muted">No update or rollback operations yet.</p> : history.length === 0 ? <p className="cp-muted">No finished operations yet.</p> : null}</div>
    </section>
  </article>;
}

function candidateFor(rows: TargetUpdateState[], selection: SelectedUpdate) {
  const row = rows.find((candidate) => candidate.target.id === selection.targetId);
  return row?.updates?.items.find((item) => item.slug === selection.slug
    && item.evaluation.status === "update-available"
    && canQueueWorkspaceOperation(row.target, item.platform, "update")) ?? null;
}

function reviewFor(rows: TargetUpdateState[], selection: SelectedUpdate) {
  return rows.find((row) => row.target.id === selection.targetId)?.updates?.items.find((item) => item.slug === selection.slug && (item.evaluation.candidate || item.evaluation.includedReleases.length > 0)) ?? null;
}

function windowSummary(window: SkillUpgradeMaintenanceWindow): string {
  const clock = (minute: number) => `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
  const days = window.daysOfWeek.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  return `${days} ${clock(window.startMinute)}–${clock(window.startMinute + window.durationMinutes)} (${window.timeZone})`;
}

function policyPin(resolved: TargetSkillUpdates["policy"] | undefined, slug: string): string | undefined {
  const pins = [...new Set(targetSkillUpgradePolicyConstraints(resolved).flatMap(({ policy }) => Object.hasOwn(policy.pins, slug) ? [policy.pins[slug]] : []))];
  return pins.length === 1 ? pins[0] : undefined;
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
    "policy-pin-conflict": "Organization and target pins conflict. Update the target pin to match the organization ceiling.",
    "change-kind-not-allowed": "The upgrade crosses a release change kind that your policy does not allow.",
  };
  return Object.hasOwn(messages, blocker) ? messages[blocker] : "This update is blocked by a release or policy requirement. Refresh for current details.";
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
