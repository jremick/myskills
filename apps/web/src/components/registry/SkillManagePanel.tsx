import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LockKeyhole, RotateCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeReviewErrorMessage, type RegistryClient, type ReleaseLifecycleActionName, type SkillLifecycleActionName, type SkillManagementSummary, type SkillReleaseSummary } from "../../api.js";
import { changeKindLabel, chipTone, findingsLabel, lifecycleLabel, releaseVersionLabel, reviewStatusLabel, securityStatusLabel, shortDate } from "./status-display.js";

type PendingAction = { kind: "skill"; action: SkillLifecycleActionName } | { kind: "release"; action: ReleaseLifecycleActionName; version: string };
type Section = PendingAction["kind"] | "details";
type FocusTarget = { kind: "confirm" } | { kind: "trigger"; key: string } | { kind: "saved" };

/**
 * The one lifecycle control surface for a skill. Lifecycle and metadata
 * controls require the server's management record and render only the
 * actions it allows; sharing is supplied separately by the caller because it
 * has its own server authority. Every change needs an MFA-verified session.
 */
export function SkillManagePanel({
  client,
  historyState,
  mfaVerified,
  onChanged,
  onRetryRecord,
  record,
  recordState,
  releases,
  sharing,
  version,
}: {
  client: RegistryClient;
  historyState: "idle" | "loading" | "ready" | "error";
  mfaVerified: boolean;
  /** Reload the parent detail after a saved change, without discarding this panel. */
  onChanged: () => void;
  /** Repeat a management check that did not complete. */
  onRetryRecord: () => void;
  /** The management record, or null while loading, when denied, or when the check failed. */
  record: SkillManagementSummary | null;
  recordState: "loading" | "ready" | "denied" | "error";
  /** Release records returned to this manager, newest first. */
  releases: SkillReleaseSummary[];
  sharing: ReactNode;
  /** The exact version selected in the workspace. */
  version: string | null;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ section: Section; text: string; saved?: boolean } | null>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<FocusTarget | null>(null);
  const baseId = useId();
  const release = version ? releases.find((item) => item.version === version) ?? null : null;
  const skillActions = record ? record.allowedActions.filter((action): action is SkillLifecycleActionName => action !== "edit") : [];
  const canEdit = Boolean(record?.allowedActions.includes("edit"));
  const locked = !mfaVerified;

  // A different exact release is a different target: never carry a pending confirmation across.
  useEffect(() => {
    setPending((current) => current?.kind === "release" && current.version !== version ? null : current);
  }, [version]);

  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const element = target.kind === "confirm" ? confirmRef.current
      : target.kind === "saved" ? savedRef.current
        : Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-action]") ?? []).find((item) => item.dataset.action === target.key);
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  function openPending(next: PendingAction) {
    setReason("");
    setMessage(null);
    setPending(next);
    focusTarget.current = { kind: "confirm" };
  }

  function cancelPending() {
    if (!pending || busy) return;
    focusTarget.current = { kind: "trigger", key: pendingKey(pending) };
    setPending(null);
    setReason("");
  }

  async function confirm() {
    if (!record || !pending || busy || locked) return;
    if (pending.action !== "restore" && !reason.trim()) return;
    const section = pending.kind;
    setBusy(true);
    setMessage(null);
    try {
      if (pending.kind === "skill") await client.performSkillAction(record.slug, pending.action, reason.trim() || undefined);
      else await client.performReleaseAction(record.slug, pending.version, pending.action, reason.trim() || undefined);
      setPending(null);
      setReason("");
      setMessage({ section, saved: true, text: "Lifecycle change saved. Can manage includes archived and unpublished records." });
      focusTarget.current = { kind: "saved" };
      onChanged();
    } catch (error) {
      setMessage({ section, text: safeReviewErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(input: { title: string; summary: string; reason: string }): Promise<boolean> {
    if (!record || busy || locked) return false;
    setBusy(true);
    setMessage(null);
    try {
      await client.updateSkillMetadata({ slug: record.slug, ...input });
      setMessage({ section: "details", saved: true, text: "Skill metadata saved." });
      focusTarget.current = { kind: "saved" };
      onChanged();
      return true;
    } catch (error) {
      setMessage({ section: "details", text: safeReviewErrorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function sectionMessage(section: Section) {
    if (message?.section !== section) return null;
    return message.saved
      ? <p className="author-status" data-tone="teal" ref={savedRef} role="status" tabIndex={-1}>{message.text}</p>
      : <p className="author-status" data-tone="danger" role="status">{message.text}</p>;
  }

  function confirmation(section: PendingAction["kind"]) {
    if (!record || pending?.kind !== section) return null;
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelPending();
    };
    const target = pending.kind === "release" ? releases.find((item) => item.version === pending.version) ?? null : null;
    const reasonId = `${baseId}-reason`;
    return (
      <section aria-label="Confirm lifecycle change" className="manage-confirm" onKeyDown={onKeyDown}>
        <h4 ref={confirmRef} tabIndex={-1}>{label(pending.action)} {record.slug}{pending.kind === "release" ? ` ${pending.version}` : ""}</h4>
        <p>{pending.action === "delete" ? "Deletion removes this resource from use and cannot be undone from this screen." : pending.action === "restore" ? "Restore this exact resource when its review and security state permit it." : "This changes availability through Skills. Existing local installations may require a separate action."}</p>
        {pending.kind === "release" && (
          <dl className="registry-facts">
            <div><dt>Exact version</dt><dd className="registry-mono">{pending.version}</dd></div>
            {target?.artifact && <div><dt>SHA-256</dt><dd className="registry-mono">{target.artifact.sha256}</dd></div>}
          </dl>
        )}
        <label className="manage-reason" htmlFor={reasonId}>
          <span>Reason {pending.action === "restore" ? "(optional)" : "(required)"}</span>
          <Input aria-label="Lifecycle reason" id={reasonId} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="registry-actions">
          <Button type="button" size="sm" disabled={busy || locked || (pending.action !== "restore" && !reason.trim())} variant={isDestructive(pending.action) ? "destructive" : "default"} onClick={() => void confirm()}>{busy ? "Saving…" : `Confirm ${pending.action}`}</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={cancelPending}>Cancel</Button>
        </div>
      </section>
    );
  }

  return (
    <div className="skill-manage" ref={rootRef}>
      {locked && (
        <p className="registry-callout" role="status">
          <LockKeyhole size={16} aria-hidden="true" />
          <span>An MFA-verified session is required to change metadata, lifecycle or sharing. <a href="/settings">Open security settings</a>.</span>
        </p>
      )}
      {recordState === "loading" && <p className="registry-muted" role="status">Loading management record…</p>}
      {recordState === "error" && (
        <div className="registry-inspector-state" role="status">
          <div>
            <strong>Management access couldn't be checked.</strong>
            <p>Lifecycle and metadata controls stay hidden until the check completes.</p>
            <div className="registry-actions">
              <Button size="sm" type="button" variant="outline" onClick={onRetryRecord}>
                <RotateCw size={15} aria-hidden="true" />
                Retry management check
              </Button>
            </div>
          </div>
        </div>
      )}
      {record && (
        <>
          <section aria-labelledby={`${baseId}-release`} className="registry-section">
            <h3 id={`${baseId}-release`}>Release lifecycle</h3>
            {historyState === "loading" && <p className="registry-muted" role="status">Loading releases…</p>}
            {historyState === "error" && <p className="registry-muted" role="status">Release records are unavailable. Retry from Versions.</p>}
            {historyState === "ready" && !version && <p className="registry-muted" role="status">{releases.length > 0 ? "Choose an exact release version to manage its lifecycle." : "No release records are available."}</p>}
            {historyState === "ready" && version && !release && <p className="registry-muted" role="status">Version {version} is not in this skill's release records. Choose a listed version.</p>}
            {release && <ReleaseFacts release={release} />}
            {release && release.allowedActions.length > 0 && (
              <div className="registry-actions">
                {release.allowedActions.map((action) => (
                  <Button className={isDestructive(action) ? "author-danger" : undefined} data-action={`release:${action}:${release.version}`} key={action} size="sm" type="button" variant="outline" disabled={busy || locked} onClick={() => openPending({ kind: "release", action, version: release.version })}>
                    {label(action)} {releaseVersionLabel(release.version, releases)}
                  </Button>
                ))}
              </div>
            )}
            {release && release.allowedActions.length === 0 && <p className="registry-muted">No lifecycle change is available for this release.</p>}
            {confirmation("release")}
            {sectionMessage("release")}
          </section>
          {(skillActions.length > 0 || message?.section === "skill") && (
            <section aria-labelledby={`${baseId}-skill`} className="registry-section">
              <h3 id={`${baseId}-skill`}>Skill lifecycle</h3>
              <p className="registry-muted">Current state: {lifecycleLabel(record.lifecycleStatus).label}</p>
              {skillActions.length > 0 && (
                <div className="registry-actions">
                  {skillActions.map((action) => (
                    <Button className={isDestructive(action) ? "author-danger" : undefined} data-action={`skill:${action}`} key={action} size="sm" type="button" variant="outline" disabled={busy || locked} onClick={() => openPending({ kind: "skill", action })}>
                      {label(action)} skill
                    </Button>
                  ))}
                </div>
              )}
              {confirmation("skill")}
              {sectionMessage("skill")}
            </section>
          )}
          {canEdit && (
            <section aria-labelledby={`${baseId}-details`} className="registry-section">
              <h3 id={`${baseId}-details`}>Skill details</h3>
              {/* Mounted once the record exists, so fields start from it even when the
                  record arrives after this panel; the parent reloads in place, so
                  unsaved drafts survive a saved lifecycle change. */}
              <SkillDetailsForm disabled={busy || locked} key={record.slug} record={record} onSave={saveDetails} />
              {sectionMessage("details")}
            </section>
          )}
        </>
      )}
      {sharing}
      {recordState === "denied" && !sharing && !locked && <p className="registry-muted" role="status">No management actions are available to your account for this skill.</p>}
    </div>
  );
}

function SkillDetailsForm({ disabled, onSave, record }: { disabled: boolean; onSave: (input: { title: string; summary: string; reason: string }) => Promise<boolean>; record: SkillManagementSummary }) {
  const [title, setTitle] = useState(record.title);
  const [summary, setSummary] = useState(record.summary);
  const [reason, setReason] = useState("");
  return (
    <form className="metadata-edit-grid" onSubmit={(event) => {
      event.preventDefault();
      void onSave({ title, summary, reason }).then((saved) => { if (saved) setReason(""); });
    }}>
      <label>
        Title
        <Input className="registry-input" disabled={disabled} value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Summary
        <Input className="registry-input" disabled={disabled} value={summary} onChange={(event) => setSummary(event.target.value)} />
      </label>
      <label className="reason-field">
        Reason
        <Input className="registry-input" disabled={disabled} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <Button className="save-button compact-button" disabled={disabled} size="sm" type="submit">
        <Save size={15} aria-hidden="true" />
        Save metadata
      </Button>
    </form>
  );
}

function ReleaseFacts({ release }: { release: SkillReleaseSummary }) {
  const status = lifecycleLabel(release.lifecycleStatus);
  const review = reviewStatusLabel(release.reviewStatus);
  const security = securityStatusLabel(release.securityStatus);
  return <dl className="registry-facts">
    {/* Manage acts on this exact version, so it is always shown, not only for imports. */}
    <div><dt>Exact version</dt><dd className="registry-mono">{release.version}</dd></div>
    <div><dt>Status</dt><dd><span className="registry-chip" data-tone={chipTone(status.tone)}>{status.label}</span></dd></div>
    <div><dt>Review</dt><dd><span className="registry-chip" data-tone={chipTone(review.tone)}>{review.label}</span></dd></div>
    <div><dt>Security</dt><dd><span className="registry-chip" data-tone={chipTone(security.tone)}>{security.label}</span></dd></div>
    <div><dt>Published</dt><dd>{shortDate(release.publishedAt) ?? "Not published"}</dd></div>
    <div><dt>Findings</dt><dd>{findingsLabel(release.findingCount).label}</dd></div>
    {release.changeKind && <div><dt>Change kind</dt><dd>{changeKindLabel(release.changeKind)}</dd></div>}
    {release.artifact && <div><dt>SHA-256</dt><dd className="registry-mono">{release.artifact.sha256}</dd></div>}
  </dl>;
}

function pendingKey(pending: PendingAction): string {
  return pending.kind === "skill" ? `skill:${pending.action}` : `release:${pending.action}:${pending.version}`;
}

function isDestructive(action: string): boolean { return action === "delete" || action === "revoke"; }

function label(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
