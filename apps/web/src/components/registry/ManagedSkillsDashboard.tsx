import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, LockKeyhole, RotateCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeReviewErrorMessage, type RegistryClient, type ReleaseLifecycleActionName, type SkillLifecycleActionName, type SkillManagementSummary, type SkillReleaseSummary } from "../../api.js";
import { isBootstrapVersion, releaseVersionLabel, changeKindLabel, chipTone, findingsLabel, lifecycleLabel, reviewStatusLabel, securityStatusLabel, shortDate, tileTone, visibilityLabel } from "./status-display.js";
import { useSplitLayout } from "./useSplitLayout.js";

type PendingAction = { kind: "skill"; action: SkillLifecycleActionName } | { kind: "release"; action: ReleaseLifecycleActionName; version: string };
type Section = PendingAction["kind"];
type FocusTarget = { kind: "title" } | { kind: "row"; slug: string } | { kind: "confirm" } | { kind: "trigger"; key: string } | { kind: "saved" };

export function ManagedSkillsDashboard({ client, mfaVerified }: { client: RegistryClient; mfaVerified: boolean }) {
  const [skills, setSkills] = useState<SkillManagementSummary[]>([]);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [releases, setReleases] = useState<SkillReleaseSummary[]>([]);
  const [version, setVersion] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detailMessage, setDetailMessage] = useState<{ section: Section; text: string; saved?: boolean } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const { layout, ref: surfaceRef } = useSplitLayout();
  const listRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const focusTarget = useRef<FocusTarget | null>(null);
  const baseId = useId();
  const selected = skills.find((skill) => skill.slug === selectedSlug) ?? null;
  const release = releases.find((item) => item.version === version) ?? null;
  const stacked = layout === "stack";
  const showDetail = Boolean(selected) && (!stacked || detailOpen);
  const showList = !stacked || !showDetail;

  const loadList = useCallback(async () => {
    const epoch = ++listEpoch.current;
    setLoading(true);
    setLoadingMore(false);
    setMessage(null);
    setCursor(null);
    try {
      if (!client.listManagedSkills) throw new Error("Skill management is unavailable.");
      const page = await client.listManagedSkills({ query });
      if (epoch !== listEpoch.current) return;
      setSkills(page.skills);
      setCursor(page.nextCursor ?? null);
      setSelectedSlug((current) => page.skills.some((skill) => skill.slug === current) ? current : page.skills[0]?.slug ?? null);
    } catch (error) {
      if (epoch !== listEpoch.current) return;
      setSkills([]);
      setSelectedSlug(null);
      setMessage(safeReviewErrorMessage(error));
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [client, query]);

  const loadReleases = useCallback(async () => {
    const epoch = ++detailEpoch.current;
    setReleases([]);
    setDetailMessage(null);
    if (!selectedSlug) {
      setDetailLoading(false);
      setVersion("");
      return false;
    }
    setDetailLoading(true);
    try {
      const records = await client.listSkillReleases(selectedSlug);
      if (epoch !== detailEpoch.current) return;
      setReleases(records);
      setVersion((current) => records.some((item) => item.version === current) ? current : records[0]?.version ?? "");
      return true;
    } catch (error) {
      if (epoch === detailEpoch.current) setDetailMessage({ section: "release", text: safeReviewErrorMessage(error) });
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  }, [client, selectedSlug]);

  useEffect(() => { void loadList(); return () => { listEpoch.current += 1; }; }, [loadList]);
  useEffect(() => { setPending(null); setReason(""); void loadReleases(); return () => { detailEpoch.current += 1; }; }, [loadReleases]);

  // Focus moves with the reader: into the detail, the confirmation and the
  // saved status, and back to the row or trigger that opened them.
  useEffect(() => {
    if (stacked && detailOpen && !selected && !loading) setDetailOpen(false);
    const target = focusTarget.current;
    if (!target) return;
    const element = target.kind === "title" ? titleRef.current
      : target.kind === "row" ? findByData(listRef.current, "slug", target.slug)
        : target.kind === "confirm" ? confirmRef.current
          : target.kind === "trigger" ? findByData(inspectorRef.current, "action", target.key)
            : savedRef.current;
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  async function more() {
    if (!cursor || !client.listManagedSkills || loadingMore) return;
    const epoch = listEpoch.current;
    setLoadingMore(true);
    setMessage(null);
    try {
      const page = await client.listManagedSkills({ query, cursor });
      if (epoch !== listEpoch.current) return;
      setSkills((current) => [...new Map([...current, ...page.skills].map((skill) => [skill.slug, skill])).values()]);
      setCursor(page.nextCursor ?? null);
    } catch (error) {
      if (epoch === listEpoch.current) setMessage(safeReviewErrorMessage(error));
    } finally {
      if (epoch === listEpoch.current) setLoadingMore(false);
    }
  }

  function openSkill(slug: string) {
    // Reset the version only for a different skill; the same slug keeps its loaded releases.
    if (slug !== selectedSlug) {
      setVersion("");
      setSelectedSlug(slug);
    }
    if (stacked) {
      setDetailOpen(true);
      focusTarget.current = { kind: "title" };
    }
  }

  function backToSkills() {
    setPending(null);
    setReason("");
    setDetailOpen(false);
    if (selectedSlug) focusTarget.current = { kind: "row", slug: selectedSlug };
  }

  function openPending(next: PendingAction) {
    setReason("");
    setDetailMessage(null);
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
    if (!selected || !pending || busy || !mfaVerified) return;
    if (pending.action !== "restore" && !reason.trim()) return;
    const section = pending.kind;
    setBusy(true);
    setDetailMessage(null);
    try {
      if (pending.kind === "skill") {
        const updated = await client.performSkillAction(selected.slug, pending.action, reason.trim() || undefined);
        setSkills((current) => current.map((skill) => skill.slug === updated.slug ? updated : skill));
      } else {
        await client.performReleaseAction(selected.slug, pending.version, pending.action, reason.trim() || undefined);
      }
      setPending(null);
      setReason("");
      if (await loadReleases()) {
        setDetailMessage({ section, saved: true, text: "Lifecycle change saved. This inventory includes archived and unpublished records." });
        focusTarget.current = { kind: "saved" };
      }
    } catch (error) {
      setDetailMessage({ section, text: safeReviewErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function sectionMessage(section: Section) {
    if (detailMessage?.section !== section) return null;
    return detailMessage.saved
      ? <p className="author-status" data-tone="teal" ref={savedRef} role="status" tabIndex={-1}>{detailMessage.text}</p>
      : <p className="author-status" data-tone="danger" role="status">{detailMessage.text}</p>;
  }

  function confirmation(section: Section) {
    if (!selected || pending?.kind !== section) return null;
    const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelPending();
    };
    const reasonId = `${baseId}-reason`;
    return <section aria-label="Confirm lifecycle change" className="manage-confirm" onKeyDown={onKeyDown}>
      <h4 ref={confirmRef} tabIndex={-1}>{label(pending.action)} {selected.slug}{pending.kind === "release" ? ` ${pending.version}` : ""}</h4>
      <p>{pending.action === "delete" ? "Deletion removes this resource from use and cannot be undone from this screen." : pending.action === "restore" ? "Restore this exact resource when its review and security state permit it." : "This changes availability through Skills. Existing local installations may require a separate action."}</p>
      <label className="manage-reason" htmlFor={reasonId}>
        <span>Reason {pending.action === "restore" ? "(optional)" : "(required)"}</span>
        <Input aria-label="Lifecycle reason" id={reasonId} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="registry-actions">
        <Button type="button" size="sm" disabled={busy || (pending.action !== "restore" && !reason.trim())} variant={isDestructive(pending.action) ? "destructive" : "default"} onClick={() => void confirm()}>{busy ? "Saving…" : `Confirm ${pending.action}`}</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={cancelPending}>Cancel</Button>
      </div>
    </section>;
  }

  const skillActions = selected ? selected.allowedActions.filter((action): action is SkillLifecycleActionName => action !== "edit") : [];
  const lifecycle = selected ? lifecycleLabel(selected.lifecycleStatus) : null;

  return <main className="registry-workspace author-review manage-dashboard" aria-label="Manage skills">
    <header className="registry-page-head">
      <h1>Manage skills</h1>
      <Button aria-label="Refresh inventory" size="icon-sm" type="button" variant="outline" onClick={() => void loadList()} disabled={busy}>
        <RotateCw size={16} aria-hidden="true" />
      </Button>
    </header>
    <div className="registry-surface" data-layout={layout} ref={surfaceRef}>
      {showList && (
        <div className="registry-toolbar">
          <label className="registry-search" htmlFor={`${baseId}-search`}>
            <Search size={16} aria-hidden="true" />
            <input id={`${baseId}-search`} aria-label="Search managed skills" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Search managed skills…" autoComplete="off" spellCheck={false} />
          </label>
        </div>
      )}
      <div className="registry-body" data-columns={showDetail && showList ? undefined : "1"}>
        {showList && (
          <section aria-busy={loading} aria-label="Managed skills" className="registry-list" ref={listRef}>
            <div className="registry-list-label">
              <h2>Skills</h2>
              <span aria-live="polite">{loading ? "" : cursor ? `${skills.length} loaded` : String(skills.length)}</span>
            </div>
            {loading && skills.length === 0 && (
              <div className="registry-skeleton" role="status" aria-live="polite">
                <span className="sr-only">Loading managed skills…</span>
                {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
              </div>
            )}
            {message && <p className="registry-alert" role="alert">{message}</p>}
            {skills.length > 0 && (
              <div className="registry-rows">
                {skills.map((skill) => {
                  const status = lifecycleLabel(skill.lifecycleStatus);
                  return (
                    <button
                      aria-pressed={stacked ? undefined : skill.slug === selectedSlug}
                      className="registry-row managed-skill-row"
                      data-slug={skill.slug}
                      disabled={busy}
                      key={skill.slug}
                      type="button"
                      onClick={() => openSkill(skill.slug)}
                    >
                      <span className="registry-tile" data-tone={tileTone(skill.slug)} aria-hidden="true" />
                      <span className="registry-row-text">
                        <span className="registry-row-title">{skill.title}</span>
                        <span className="registry-row-meta"><code>{skill.slug}</code><span>{visibilityLabel(skill.visibility)}</span></span>
                        {skill.lifecycleStatus !== "approved" && <span className="author-chips"><span className="registry-chip" data-tone={chipTone(status.tone)}>{status.label}</span></span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {!loading && !message && skills.length === 0 && (
              <div className="registry-list-state">
                <strong>No manageable skills match this search.</strong>
                <p>The inventory includes archived skills and unpublished releases you can manage.</p>
              </div>
            )}
            {cursor && (
              <div className="registry-list-foot">
                <Button type="button" size="sm" variant="outline" disabled={loadingMore || busy} onClick={() => void more()}>{loadingMore ? "Loading…" : "Load more managed skills"}</Button>
              </div>
            )}
          </section>
        )}
        {showDetail && selected && lifecycle && (
          <section aria-label="Selected managed skill" className="registry-inspector" ref={inspectorRef}>
            {stacked && (
              <Button className="registry-back" type="button" variant="ghost" onClick={backToSkills}>
                <ArrowLeft size={16} aria-hidden="true" />
                Back to skills
              </Button>
            )}
            <header className="registry-inspector-head">
              <span className="registry-tile" data-size="32" data-tone={tileTone(selected.slug)} aria-hidden="true" />
              <div className="registry-inspector-title">
                <h2 ref={titleRef} tabIndex={-1}>{selected.title}</h2>
                <p className="registry-ref"><code>{selected.slug}</code></p>
                <p className="registry-inspector-meta"><span>{visibilityLabel(selected.visibility)}</span><span aria-hidden="true">·</span><span>{lifecycle.label}</span></p>
              </div>
            </header>
            <div className="registry-inspector-body">
              {selected.summary && <p className="registry-summary">{selected.summary}</p>}
              {!mfaVerified && (
                <p className="registry-callout" role="status">
                  <LockKeyhole size={16} aria-hidden="true" />
                  <span>An MFA-verified session is required for lifecycle changes. <a href="/settings">Open security settings</a>.</span>
                </p>
              )}
              <section aria-labelledby={`${baseId}-release`} className="registry-section">
                <h3 id={`${baseId}-release`}>Release lifecycle</h3>
                {detailLoading && <p className="registry-muted" role="status">Loading releases…</p>}
                {!detailLoading && releases.length > 0 && (
                  <label className="manage-version">
                    <span>Release version</span>
                    <select aria-label="Managed release version" value={version} disabled={busy} onChange={(event) => { setPending(null); setReason(""); setVersion(event.target.value); }}>
                      {releases.map((item) => <option key={item.id} value={item.version}>{releaseVersionLabel(item.version, releases)} · {lifecycleLabel(item.lifecycleStatus).label}</option>)}
                    </select>
                  </label>
                )}
                {!detailLoading && releases.length === 0 && !detailMessage && <p className="registry-muted">No release records are available.</p>}
                {release && <ReleaseFacts release={release} />}
                {release && (
                  <div className="manage-notes">
                    <h4>Release notes</h4>
                    <p className="registry-notes">{release.releaseNotes || "No release notes were supplied."}</p>
                  </div>
                )}
                {release && release.allowedActions.length > 0 && (
                  <div className="registry-actions">
                    {release.allowedActions.map((action) => <Button className={isDestructive(action) ? "author-danger" : undefined} data-action={`release:${action}:${release.version}`} key={action} size="sm" type="button" variant="outline" disabled={busy || !mfaVerified} onClick={() => openPending({ kind: "release", action, version: release.version })}>{label(action)} {releaseVersionLabel(release.version)}</Button>)}
                  </div>
                )}
                {confirmation("release")}
                {sectionMessage("release")}
              </section>
              {(skillActions.length > 0 || detailMessage?.section === "skill") && (
                <section aria-labelledby={`${baseId}-skill`} className="registry-section">
                  <h3 id={`${baseId}-skill`}>Skill lifecycle</h3>
                  {skillActions.length > 0 && (
                    <div className="registry-actions">
                      {skillActions.map((action) => <Button className={isDestructive(action) ? "author-danger" : undefined} data-action={`skill:${action}`} key={action} size="sm" type="button" variant="outline" disabled={busy || !mfaVerified} onClick={() => openPending({ kind: "skill", action })}>{label(action)} skill</Button>)}
                    </div>
                  )}
                  {confirmation("skill")}
                  {sectionMessage("skill")}
                </section>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  </main>;
}

function ReleaseFacts({ release }: { release: SkillReleaseSummary }) {
  const status = lifecycleLabel(release.lifecycleStatus);
  const review = reviewStatusLabel(release.reviewStatus);
  const security = securityStatusLabel(release.securityStatus);
  return <dl className="registry-facts">
    {isBootstrapVersion(release.version) && <div><dt>Exact version</dt><dd className="registry-mono">{release.version}</dd></div>}
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

function findByData(root: HTMLElement | null, key: string, value: string): HTMLElement | undefined {
  return Array.from(root?.querySelectorAll<HTMLElement>(`[data-${key}]`) ?? []).find((element) => element.dataset[key] === value);
}

function isDestructive(action: string): boolean { return action === "delete" || action === "revoke"; }

function label(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
