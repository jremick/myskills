import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { safeReviewErrorMessage, type RegistryClient, type ReleaseLifecycleActionName, type SkillLifecycleActionName, type SkillManagementSummary, type SkillReleaseSummary } from "../../api.js";

type PendingAction = { kind: "skill"; action: SkillLifecycleActionName } | { kind: "release"; action: ReleaseLifecycleActionName; version: string };

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
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selected = skills.find((skill) => skill.slug === selectedSlug) ?? null;
  const release = releases.find((item) => item.version === version) ?? null;

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
      if (epoch === detailEpoch.current) setDetailMessage(safeReviewErrorMessage(error));
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  }, [client, selectedSlug]);

  useEffect(() => { void loadList(); return () => { listEpoch.current += 1; }; }, [loadList]);
  useEffect(() => { setPending(null); setReason(""); void loadReleases(); return () => { detailEpoch.current += 1; }; }, [loadReleases]);

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

  async function confirm() {
    if (!selected || !pending || busy || !mfaVerified) return;
    if (pending.action !== "restore" && !reason.trim()) return;
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
        setDetailMessage("Lifecycle change saved. This inventory includes archived and unpublished records.");
      }
    } catch (error) {
      setDetailMessage(safeReviewErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return <main className="control-plane-workspace" aria-label="Manage skills">
    <section className="control-plane-hero"><div><p className="control-plane-kicker">Ownership and lifecycle</p><h1>Manage skills</h1><p>Find skills you can manage, including archived skills and unpublished releases.</p></div><Button type="button" variant="outline" onClick={() => void loadList()} disabled={busy}>Refresh inventory</Button></section>
    <label className="control-plane-form"><span>Search managed skills</span><Input aria-label="Search managed skills" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
    {message && <p role="alert">{message}</p>}
    {loading && <p role="status">Loading managed skills…</p>}
    <div className="managed-skills-layout">
      <Card><CardHeader><CardTitle>Managed inventory</CardTitle></CardHeader><CardContent>
        {skills.map((skill) => <Button className="managed-skill-row" key={skill.slug} type="button" variant={skill.slug === selectedSlug ? "secondary" : "outline"} disabled={busy} onClick={() => { setVersion(""); setSelectedSlug(skill.slug); }} aria-pressed={skill.slug === selectedSlug}><span>{skill.title} <small>{skill.slug}</small></span><Badge variant="outline">{skill.lifecycleStatus}</Badge></Button>)}
        {!loading && skills.length === 0 && <p>No manageable skills match this search.</p>}
        {cursor && <Button type="button" variant="outline" disabled={loadingMore || busy} onClick={() => void more()}>{loadingMore ? "Loading…" : "Load more managed skills"}</Button>}
      </CardContent></Card>
      {selected && <Card><CardHeader><CardTitle>{selected.title}</CardTitle><p>{selected.slug} · {selected.visibility} · {selected.lifecycleStatus}</p></CardHeader><CardContent>
        <p>{selected.summary}</p>
        {!mfaVerified && <p role="status">An MFA-verified session is required for lifecycle changes. <a href="/settings">Open security settings</a>.</p>}
        <div className="target-action-row">{selected.allowedActions.filter((action): action is SkillLifecycleActionName => action !== "edit").map((action) => <Button key={action} type="button" variant={action === "delete" ? "destructive" : "outline"} disabled={busy || !mfaVerified} onClick={() => { setReason(""); setPending({ kind: "skill", action }); }}>{label(action)} skill</Button>)}</div>
        <section className="control-plane-section"><h2>Release history</h2>
          {detailLoading && <p role="status">Loading releases…</p>}
          {!detailLoading && releases.length > 0 && <label className="control-plane-form"><span>Release version</span><select aria-label="Managed release version" value={version} disabled={busy} onChange={(event) => { setPending(null); setReason(""); setVersion(event.target.value); }}>{releases.map((item) => <option key={item.id} value={item.version}>{item.version} · {item.lifecycleStatus}</option>)}</select></label>}
          {!detailLoading && releases.length === 0 && <p>No release records are available.</p>}
          {release && <><p>{release.version} · {release.lifecycleStatus} · review {release.reviewStatus} · security {release.securityStatus}</p><p>{release.releaseNotes || "No release notes were supplied."}</p><div className="target-action-row">{release.allowedActions.map((action) => <Button key={action} type="button" variant={action === "delete" || action === "revoke" ? "destructive" : "outline"} disabled={busy || !mfaVerified} onClick={() => { setReason(""); setPending({ kind: "release", action, version: release.version }); }}>{label(action)} {release.version}</Button>)}</div></>}
        </section>
        {pending && <section className="control-plane-section" aria-label="Confirm lifecycle change"><h2>{label(pending.action)} {selected.slug}{pending.kind === "release" ? ` ${pending.version}` : ""}</h2><p>{pending.action === "delete" ? "Deletion removes this resource from use and cannot be undone from this screen." : pending.action === "restore" ? "Restore this exact resource when its review and security state permit it." : "This changes availability through the registry. Existing local installations may require a separate action."}</p><label className="control-plane-form"><span>Reason {pending.action === "restore" ? "(optional)" : "(required)"}</span><Input aria-label="Lifecycle reason" value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label><div className="target-action-row"><Button type="button" disabled={busy || (pending.action !== "restore" && !reason.trim())} variant={pending.action === "delete" ? "destructive" : "default"} onClick={() => void confirm()}>{busy ? "Saving…" : `Confirm ${pending.action}`}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>Cancel</Button></div></section>}
        {detailMessage && <p role="status">{detailMessage}</p>}
      </CardContent></Card>}
    </div>
  </main>;
}

function label(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
