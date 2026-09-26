import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { LibrarySummary, LibraryEntry, LibraryCandidate, LibraryInboxItem, LibraryBinding, SourceDiscovery, LibrarySourceRefKind, LibraryTrackingMode } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { RegistryClient, TeamRecord, WebAuthUser } from "../../api.js";
import { libraryError, type LibraryClient, type LibrarySettingsResponse } from "../../library-api.js";
import { PackageFileViewer } from "../registry/PackageFileViewer.js";
import { LibrarySharingReview } from "./LibrarySharingReview.js";

const mutationId = () => crypto.randomUUID();
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Never";

export function LibrariesDashboard({ client, user }: { client: RegistryClient; user: WebAuthUser }) {
  if (!client.libraries) return <main><h1>Libraries</h1><p>Libraries are not available on this server.</p></main>;
  return <LibraryWorkspace key={user.id} api={client.libraries} client={client} user={user} />;
}

function LibraryWorkspace({ api, client, user }: { api: LibraryClient; client: RegistryClient; user: WebAuthUser }) {
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamRecord[]>([]);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("user");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const createKey = useRef(mutationId());
  const epoch = useRef(0);
  const load = useCallback(async (next?: string) => {
    const ticket = ++epoch.current;
    try {
      const result = await api.list(next);
      if (ticket !== epoch.current) return;
      setLibraries((current) => next ? [...current, ...result.libraries] : result.libraries);
      setCursor(result.nextCursor);
      setSelected((current) => current ?? result.libraries[0]?.id ?? null);
      setError(null);
    } catch (e) { if (ticket === epoch.current) setError(libraryError(e)); }
    finally { if (ticket === epoch.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    let active = true;
    void load();
    void client.listTeams().then((result) => { if (active) setTeams(result.teams.filter((team) => team.role === "owner")); }).catch(() => {});
    return () => { active = false; epoch.current++; };
  }, [client, load]);
  async function create() {
    setBusy(true); setError(null);
    try {
      const result = await api.create({ name: name.trim(), owner: owner === "user" ? { type: "user" } : { type: "team", id: owner }, clientMutationId: createKey.current });
      createKey.current = mutationId(); setName(""); await load(); setSelected(result.library.id);
    } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  return <main className="library-workspace" aria-label="Libraries">
    <header className="library-page-header"><div><p className="control-plane-muted">Collect · follow · adopt</p><h1>Libraries</h1><p>Keep useful skills together, retain their sources, and choose which versions you use.</p></div><BookOpen size={30} aria-hidden="true" /></header>
    {error && <p role="alert">{error}</p>}
    <div className="library-layout">
      <aside aria-label="Your libraries" className="library-sidebar">
        <Card><CardHeader><CardTitle>Your libraries</CardTitle><CardDescription>Personal collections and team recommendations.</CardDescription></CardHeader><CardContent className="library-stack">
          {loading ? <p role="status">Loading libraries…</p> : libraries.length === 0 ? <p>Create your first library to save a source.</p> : libraries.map((library) => <Button key={library.id} variant={selected === library.id ? "secondary" : "ghost"} className="library-choice" aria-pressed={selected === library.id} onClick={() => setSelected(library.id)}><span>{library.name}</span><small>{library.owner.type === "team" ? "Team" : "Personal"}</small></Button>)}
          {cursor && <Button variant="outline" onClick={() => void load(cursor)}>Load more libraries</Button>}
          <form className="library-stack" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <label>Library name<Input value={name} onChange={(event) => { setName(event.target.value); createKey.current = mutationId(); }} maxLength={120} required /></label>
            <label>Library owner<select value={owner} onChange={(event) => { setOwner(event.target.value); createKey.current = mutationId(); }}><option value="user">Me</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
            <Button disabled={busy || !name.trim()}><Plus size={16} />Create library</Button>
          </form>
        </CardContent></Card>
        <LibraryInbox api={api} onSelect={setSelected} />
        {user.roles.some((role) => ["owner", "admin", "maintainer"].includes(role)) && <LibrarySharingReview api={api} mfaVerified={user.mfaVerified} />}
        {user.roles.some((role) => role === "owner" || role === "admin") && <LibrarySettings api={api} mfaVerified={user.mfaVerified} />}
      </aside>
      {selected ? <LibraryDetail key={selected} api={api} client={client} libraryId={selected} onRemoved={() => { setSelected(null); void load(); }} /> : <Card className="library-empty"><CardHeader><CardTitle>Start with a source you trust</CardTitle><CardDescription>Save a GitHub repository or a registry skill. Preview complete skill packages before importing them.</CardDescription></CardHeader></Card>}
    </div>
  </main>;
}

function LibraryDetail({ api, client, libraryId, onRemoved }: { api: LibraryClient; client: RegistryClient; libraryId: string; onRemoved: () => void }) {
  const [library, setLibrary] = useState<LibrarySummary | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [refKind, setRefKind] = useState<LibrarySourceRefKind | "url">("url");
  const [refValue, setRefValue] = useState("");
  const [slug, setSlug] = useState("");
  const [sourceSelection, setSourceSelection] = useState<{ id: string; discover: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [subscriptionPending, setSubscriptionPending] = useState<boolean | null>(null);
  const sourceKey = useRef(mutationId());
  const skillKey = useRef(mutationId());
  const epoch = useRef(0);
  const load = useCallback(async (next?: string) => {
    const ticket = ++epoch.current;
    const [detail, page] = await Promise.all([api.get(libraryId), api.entries(libraryId, next)]);
    if (ticket !== epoch.current) return;
    setLibrary(detail.library); setEntries((current) => next ? [...current, ...page.entries] : page.entries); setCursor(page.nextCursor);
  }, [api, libraryId]);
  useEffect(() => { void load().catch((e) => setError(libraryError(e))); return () => { epoch.current++; }; }, [load]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await work(); await load(); } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  async function saveSource() {
    const result = await api.addSource(libraryId, { url, ...(path.trim() ? { path: path.trim() } : {}), ...(refKind === "url" ? {} : { ref: { kind: refKind, ...(refValue.trim() ? { value: refValue.trim() } : {}) } }), clientMutationId: sourceKey.current });
    sourceKey.current = mutationId(); setUrl(""); setPath(""); setRefKind("url"); setRefValue(""); setSourceSelection({ id: result.entry.id, discover: true });
  }
  if (!library) return <section>{error ? <p role="alert">{error}</p> : <p role="status">Loading library…</p>}</section>;
  return <section className="library-stack" aria-label={library.name}>
    <Card><CardHeader><div className="library-row"><CardTitle>{library.name}</CardTitle><Badge variant="outline">{library.owner.type === "team" ? "Team library" : "Private library"}</Badge></div><CardDescription>{library.description || "Saving a source does not install its content. Adoption records the reviewed version you recommend."}</CardDescription></CardHeader><CardContent className="library-stack">
      <div className="library-row"><label className="library-checkbox"><input type="checkbox" checked={subscriptionPending ?? Boolean(library.subscription)} disabled={busy} onChange={(event) => { const enabled = event.target.checked; setSubscriptionPending(enabled); void action(() => enabled ? api.subscribe(libraryId) : api.unsubscribe(libraryId)).finally(() => setSubscriptionPending(null)); }} />Notify me about changes</label><Button size="sm" variant="ghost" disabled={busy} onClick={() => void action(() => Promise.resolve())}><RefreshCw size={14} />Refresh</Button></div>
      {library.access.canWrite && <details><summary>Library settings</summary><p>Deleting a library stops tracking and subscriptions. Installed files stay in place; bindings stop following new recommendations.</p><Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete library</Button>{confirmDelete && <div className="library-row"><Button variant="destructive" disabled={busy} onClick={() => void action(async () => { await api.remove(libraryId, library.revision); onRemoved(); })}>Confirm delete library</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button></div>}</details>}
      {error && <p role="alert">{error}</p>}
    </CardContent></Card>
    {library.access.canWrite && <Card><CardHeader><CardTitle>Add to this library</CardTitle><CardDescription>{library.owner.type === "team" ? "Curate releases already shared with your team. Sources can be saved as references." : "Save a public GitHub source or an authorized registry skill."}</CardDescription></CardHeader><CardContent className="library-stack">
      <form className="library-stack" onSubmit={(event) => { event.preventDefault(); void action(saveSource); }}>
        <label>GitHub source URL<Input type="url" value={url} onChange={(event) => { setUrl(event.target.value); sourceKey.current = mutationId(); }} placeholder="https://github.com/owner/repo" required /></label>
        <details><summary>Source selection</summary><div className="library-stack"><label>Directory filter<Input value={path} onChange={(event) => { setPath(event.target.value); sourceKey.current = mutationId(); }} placeholder="Optional, such as skills" /></label><label>Track ref<select value={refKind} onChange={(event) => { setRefKind(event.target.value as LibrarySourceRefKind | "url"); setRefValue(""); sourceKey.current = mutationId(); }}><option value="url">Use ref from URL</option><option value="default-branch">Default branch</option><option value="latest-release">Latest stable release</option><option value="branch">Named branch</option><option value="tag">Exact tag</option><option value="tag-prefix">Release tag prefix</option><option value="commit">Exact commit</option></select></label>{!["url", "default-branch", "latest-release"].includes(refKind) && <label>Ref value<Input value={refValue} onChange={(event) => { setRefValue(event.target.value); sourceKey.current = mutationId(); }} required /></label>}</div></details>
        <Button disabled={busy || !url.trim()} className="library-fit">Save source</Button>
      </form>
      <form className="library-row" onSubmit={(event) => { event.preventDefault(); void action(async () => { await api.addSkill(libraryId, slug.trim(), skillKey.current); skillKey.current = mutationId(); setSlug(""); }); }}><label className="library-grow">Registry skill slug<Input value={slug} onChange={(event) => { setSlug(event.target.value); skillKey.current = mutationId(); }} required /></label><Button variant="outline" disabled={busy || !slug.trim()}>Save registry skill</Button></form>
    </CardContent></Card>}
    {entries.length === 0 && <p className="control-plane-muted">No entries yet. Save a source to discover its skills.</p>}
    {entries.map((entry) => <Card key={entry.id}><CardHeader><div className="library-row"><CardTitle>{entry.title}</CardTitle><Badge variant="outline">{entry.kind === "source" ? "Source" : "Skill"}</Badge></div></CardHeader><CardContent className="library-stack">
      {entry.source ? <><a className="library-source" href={entry.source.url} target="_blank" rel="noreferrer">{entry.source.fullName}<ExternalLink size={14} aria-hidden="true" /></a><p className="control-plane-muted">{entry.source.path || "Repository root"} · {entry.source.ref.kind}{entry.source.ref.value ? `: ${entry.source.ref.value}` : ""}</p>{library.access.canImport && <Button className="library-fit" variant="outline" onClick={() => setSourceSelection({ id: entry.id, discover: true })}>Discover skills</Button>}{library.access.canImport && <Button className="library-fit" variant="ghost" onClick={() => setSourceSelection({ id: entry.id, discover: false })}>Review candidates</Button>}{library.access.canTrackSources && <TrackingControls key={`${entry.id}:${entry.revision}`} api={api} entry={entry} onChanged={() => load()} />}</> : <SkillEntry api={api} client={client} entry={entry} canWrite={library.access.canWrite} onChanged={() => load()} />}
      {library.access.canWrite && <RemoveEntry api={api} entry={entry} onChanged={async () => { if (sourceSelection?.id === entry.id) setSourceSelection(null); await load(); }} />}
    </CardContent></Card>)}
    {cursor && <Button variant="outline" onClick={() => void load(cursor).catch((e) => setError(libraryError(e)))}>Load more entries</Button>}
    {sourceSelection && library.access.canImport && <SourceImporter key={`${sourceSelection.id}:${sourceSelection.discover}`} api={api} entryId={sourceSelection.id} discoverOnOpen={sourceSelection.discover} entries={entries} onChanged={() => load()} onClose={() => setSourceSelection(null)} />}
  </section>;
}

function TrackingControls({ api, entry, onChanged }: { api: LibraryClient; entry: LibraryEntry; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<LibraryTrackingMode>(entry.tracking?.mode ?? "off");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identityChange = entry.tracking?.identityChange;
  const needsAcknowledgement = identityChange && !acknowledged && (mode === "daily" || mode === "weekly");
  async function run(check: boolean) { setBusy(true); setError(null); try { if (check) { const response = await api.check(entry.id); setResult(`Check ${response.check.outcome}. ${response.check.candidateIds.length} new candidates.`); } else await api.tracking(entry.id, { expectedRevision: entry.revision, mode, ...(identityChange && acknowledged ? { acknowledgeIdentityChange: true } : {}) }); await onChanged(); } catch (e) { setError(libraryError(e)); } finally { setBusy(false); } }
  return <div className="library-stack library-inset">
    {identityChange && <div className="library-stack"><strong>Repository identity changed</strong><p>Previously trusted: {identityChange.acknowledgedFullName}</p><a href={identityChange.observedUrl} target="_blank" rel="noreferrer">Review {identityChange.observedFullName}</a><p>Review the repository's new identity before resuming checks. Pausing tracking keeps this review pending.</p><label className="library-checkbox"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />I reviewed the repository identity change</label></div>}
    <div className="library-row"><label>Check frequency<select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as LibraryTrackingMode)}><option value="off">Off</option><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><Button size="sm" variant="outline" disabled={busy || Boolean(needsAcknowledgement)} onClick={() => void run(false)}>Save tracking</Button><Button size="sm" variant="ghost" disabled={busy || Boolean(identityChange)} onClick={() => void run(true)}>Check now</Button></div><p className="control-plane-muted">{entry.tracking?.health ?? "not-tracked"} · Last success: {date(entry.tracking?.lastSuccessfulCheckAt)} · Next check: {date(entry.tracking?.nextCheckAt)}</p>{entry.tracking?.workerAvailable === false && <p>Scheduled checks are unavailable on this instance. Manual checks remain available.</p>}{error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
  </div>;
}

function SourceImporter({ api, entryId, discoverOnOpen, entries, onChanged, onClose }: { api: LibraryClient; entryId: string; discoverOnOpen: boolean; entries: LibraryEntry[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const [discovery, setDiscovery] = useState<SourceDiscovery | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<LibraryCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<string, { summary?: string; license?: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    const saved = api.candidates(entryId).then((result) => {
      if (active) { setCandidates(result.candidates); setCursor(result.nextCursor); }
    });
    const source = discoverOnOpen ? api.discover(entryId).then((result) => { if (active) setDiscovery(result.discovery); }) : Promise.resolve();
    void Promise.allSettled([saved, source]).then((results) => {
      if (!active) return;
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") setError(libraryError(failure.reason));
      setBusy(false);
    });
    return () => { active = false; };
  }, [api, entryId, discoverOnOpen]);
  async function loadCandidates(next?: string) {
    setBusy(true); setError(null);
    try {
      const result = await api.candidates(entryId, next);
      setCandidates((current) => next ? [...current, ...result.candidates.filter((candidate) => !current.some((row) => row.id === candidate.id))] : result.candidates);
      setCursor(result.nextCursor);
    } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  async function preview() {
    if (!discovery) return;
    setBusy(true); setError(null);
    const selectedMappings = Object.fromEntries(paths.flatMap((path) => {
      const mapping = mappings[path];
      const summary = mapping?.summary?.trim();
      const license = mapping?.license?.trim();
      return summary || license ? [[path, { ...(summary ? { summary } : {}), ...(license ? { license } : {}) }]] : [];
    }));
    try {
      const result = await api.preview(entryId, { snapshotId: discovery.snapshot.id, paths, ...(Object.keys(selectedMappings).length ? { mappings: selectedMappings } : {}) });
      setCandidates(result.preview.candidates); setCursor(null);
    } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  return <Card className="library-import">
    <CardHeader><div className="library-row"><CardTitle>Source import</CardTitle><Button size="sm" variant="ghost" onClick={onClose}>Close import</Button></div><CardDescription>Inspect the frozen source and complete package before submitting. Saved candidates remain available when the source is offline.</CardDescription></CardHeader>
    <CardContent className="library-stack">
      {error && <p role="alert">{error}</p>}{busy && <p role="status">Loading import details…</p>}
      {discovery && <>
        <p>Source commit</p><code className="library-digest">{discovery.snapshot.commit}</code>
        {!discovery.complete && <p role="alert">The repository inventory is incomplete. Import is unavailable.</p>}
        <fieldset disabled={busy || !discovery.complete}><legend>Choose skills</legend>
          {[...discovery.skills, ...discovery.excluded].map((root) => <div key={root.path} className="library-stack library-inset">
            <label className="library-checkbox"><input type="checkbox" aria-label={`Select ${root.path}`} checked={paths.includes(root.path)} disabled={root.blockers.some((finding) => finding.severity === "blocking")} onChange={(event) => setPaths((current) => event.target.checked ? [...current, root.path] : current.filter((path) => path !== root.path))} />{root.path || "Repository root"} <small>{root.fileCount} files · {root.byteCount.toLocaleString()} bytes</small></label>
            {root.blockers.map((finding, index) => <p key={index}>{finding.message}</p>)}
            <details><summary>Metadata mapping</summary>
              <label>Short summary<Input value={mappings[root.path]?.summary ?? ""} onChange={(event) => setMappings((current) => ({ ...current, [root.path]: { ...current[root.path], summary: event.target.value } }))} maxLength={500} /></label>
              <label>License identifier<Input value={mappings[root.path]?.license ?? ""} onChange={(event) => setMappings((current) => ({ ...current, [root.path]: { ...current[root.path], license: event.target.value } }))} maxLength={80} /></label>
            </details>
          </div>)}
        </fieldset>
        <Button disabled={busy || !paths.length || paths.length > 20 || !discovery.complete} className="library-fit" onClick={() => void preview()}>Preview import</Button>
      </>}
      <Button variant="ghost" size="sm" className="library-fit" disabled={busy} onClick={() => void loadCandidates()}>Refresh saved candidates</Button>
      {!busy && candidates.length === 0 && <p>No saved candidates.</p>}
      {candidates.map((candidate) => <CandidateReview key={`${candidate.id}:${candidate.packageDigest}:${candidate.state}:${candidate.registry?.reviewStatus}`} api={api} initial={candidate} entry={entries.find((entry) => entry.id === candidate.skillEntryId || entry.skill?.slug === candidate.lineage.slug)} onChanged={onChanged} />)}
      {cursor && <Button variant="outline" disabled={busy} onClick={() => void loadCandidates(cursor)}>More candidates</Button>}
    </CardContent>
  </Card>;
}

function CandidateReview({ api, initial, entry, onChanged }: { api: LibraryClient; initial: LibraryCandidate; entry?: LibraryEntry; onChanged: () => Promise<void> }) {
  const [candidate, setCandidate] = useState(initial);
  const [inspected, setInspected] = useState(false);
  const [attested, setAttested] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const key = useRef(mutationId());
  const expired = Date.parse(candidate.expiresAt) <= Date.now();
  const nameNormalization = candidate.mapping.transforms?.find((transform) => transform.kind === "normalize-runtime-name");
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); await onChanged(); } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  return <article className="library-stack library-inset" aria-label={`Import ${candidate.sourcePath}`}>
    <div className="library-row"><h3>{candidate.mapping.title}</h3><Badge variant="outline">{candidate.state}</Badge></div>
    <p>{candidate.lineage.slug} · {candidate.expectedVersion} · {candidate.mapping.license}</p>
    <p className="control-plane-muted">Native name: {candidate.lineage.nativeName ?? "Unknown"} · Preview expires: {date(candidate.expiresAt)}</p>
    {nameNormalization && <section aria-label="Installed skill name" className="library-stack library-inset">
      <h4>Installed skill name</h4>
      <p>To match its install folder, SKILL.md uses <code>{nameNormalization.runtimeName}</code>. The source name is <code>{nameNormalization.originalName ?? "Not declared"}</code>.</p>
      <p>The exact original is preserved in <code>{nameNormalization.originalPath}</code>. It is not loaded as a second skill.</p>
      <details><summary>Original and installed file digests</summary>
        <p>Original SHA-256</p><code className="library-digest">{nameNormalization.originalSha256}</code>
        <p>Installed SKILL.md SHA-256</p><code className="library-digest">{nameNormalization.transformedSha256}</code>
      </details>
    </section>}
    {candidate.packageDigest && <details><summary>Artifact digest</summary><code className="library-digest">{candidate.packageDigest}</code></details>}
    {candidate.findings.map((finding, index) => <p key={index}><strong>{finding.severity}</strong>: {finding.message}</p>)}
    {candidate.changes && <p>Changes: {candidate.changes.added.length} added · {candidate.changes.changed.length} changed · {candidate.changes.removed.length} removed</p>}
    <details open><summary>Included files ({candidate.files.length})</summary>
      <ul className="library-files">{candidate.files.map((file) => <li key={file.path}><details>
        <summary><span>{file.path}</span><small>{file.bytes} bytes</small></summary>
        {file.content !== undefined ? <>
          <pre tabIndex={0}>{file.content.slice(0, 128_000)}</pre>
          {file.content.length > 128_000 && <p role="status">Preview limited to the first 128,000 characters. Export the package to inspect the complete file.</p>}
        </> : expired ? <p>Held preview content expired.{candidate.registry ? " Inspect the submitted artifact below." : " Discover this source again to create a new preview."}</p> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => setCandidate((await api.candidate(candidate.id)).candidate))}>Load held content</Button>}
      </details></li>)}</ul>
    </details>
    {candidate.state === "ready-for-review" && candidate.orderStatus === "unverified" && <label>Reason for accepting unverified source order<Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label>}
    {candidate.state === "ready-for-review" && <>
      <p className="control-plane-muted">Unclassified changes require user action before an update. Submitting does not adopt or install this version.</p>
      <Button disabled={busy || expired || !candidate.packageDigest || (candidate.orderStatus === "unverified" && !reason.trim())} onClick={() => void run(async () => {
        const result = await api.import(candidate.id, { expectedPackageDigest: candidate.packageDigest!, release: { classification: "unclassified" }, clientMutationId: key.current, ...(candidate.orderStatus === "unverified" && reason.trim() ? { acknowledgeUnverifiedOrder: { reason: reason.trim() } } : {}) });
        setCandidate(result.candidate); setInspected(false); setAttested(false);
      })}>Submit import for review</Button>
    </>}
    {["ready-for-review", "blocked"].includes(candidate.state) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => setCandidate((await api.ignore(candidate.id)).candidate))}>Ignore candidate</Button>}
    {candidate.registry && <>
      <p>Review: {candidate.registry.attestation ?? candidate.registry.reviewStatus} · Scan: {candidate.registry.securityStatus}</p>
      {candidate.registry.reviewStatus === "unreviewed" && <>
        <PackageFileViewer resourceKey={`${candidate.id}:${candidate.packageDigest}`} label="Inspect submitted artifact" loadBundle={async () => {
          if (!candidate.packageDigest || !candidate.registry) throw new Error("No submitted artifact is available.");
          const bundle = await api.submittedBundle(candidate.registry.submissionId, candidate.packageDigest);
          setInspected(true); return bundle;
        }} />
        <label className="library-checkbox"><input type="checkbox" checked={attested} disabled={!inspected || busy} onChange={(event) => setAttested(event.target.checked)} />I reviewed these files for my private use</label>
        <Button disabled={busy || !inspected || !attested || !candidate.packageDigest} onClick={() => void run(async () => setCandidate((await api.selfReview(candidate.id, candidate.packageDigest!)).candidate))}>Approve for my private use</Button>
        <p className="control-plane-muted">Requires MFA and an enabled instance policy. This attestation does not authorize sharing.</p>
      </>}
      {candidate.registry.attestation === "private-self-reviewed" && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await api.requestReview(candidate.id); setMessage("Instance review requested. Sharing stays restricted until review is complete."); })}>Request instance review for sharing</Button>}
      {candidate.registry.reviewStatus === "approved" && candidate.skillEntryId && <Button disabled={busy || entry?.adoption?.version === candidate.registry.version} onClick={() => void run(async () => {
        const current = (await api.entry(candidate.skillEntryId!)).entry;
        await api.adopt(candidate.skillEntryId!, { version: candidate.registry!.version, artifactSha256: candidate.packageDigest!, expectedCurrentAdoptionId: current.adoption?.id ?? null });
        setMessage("Version adopted. Installed copies change only when you update them.");
      })}><Check size={16} />Adopt version</Button>}
    </>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </article>;
}

function SkillEntry({ api, client, entry, canWrite, onChanged }: { api: LibraryClient; client: RegistryClient; entry: LibraryEntry; canWrite: boolean; onChanged: () => Promise<void> }) {
  const [version, setVersion] = useState("");
  const [curatorNote, setCuratorNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [requiresAction, setRequiresAction] = useState<boolean | null>(null);
  const slug = entry.skill?.slug;
  const adoptedVersion = entry.adoption?.version;
  const artifactSha256 = entry.adoption?.artifactSha256;
  useEffect(() => {
    let active = true;
    setRequiresAction(null);
    if (slug && adoptedVersion) void client.getRelease(slug, adoptedVersion).then((release) => {
      if (!active) return;
      if (release.artifact.sha256 !== artifactSha256) { setError("The adopted artifact is unavailable. Refresh and inspect the release before installing."); return; }
      setRequiresAction(release.requiresUserAction === true);
    }).catch((e) => { if (active) setError(libraryError(e)); });
    return () => { active = false; };
  }, [client, slug, adoptedVersion, artifactSha256]);
  if (!entry.skill || !slug) return null;
  async function adopt() {
    setBusy(true); setError(null);
    try {
      const release = await client.getRelease(slug!, version.trim());
      await api.adopt(entry.id, { version: version.trim(), artifactSha256: release.artifact.sha256, expectedCurrentAdoptionId: entry.adoption?.id ?? null, reason: curatorNote.trim() });
      await onChanged();
      setCuratorNote("");
    } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  return <>
    <p><a href={`/skills/${encodeURIComponent(slug)}`}>{slug}</a></p>
    <p>{entry.adoption ? <>Adopted <strong>{entry.adoption.version}</strong> · {entry.adoption.attestation}</> : "No version adopted"}</p>
    {entry.adoption?.reason && <p>Curator note: {entry.adoption.reason}</p>}
    {!entry.skill.ownership.isCaller && <p className="control-plane-muted">This skill remains owned by its contributor. Library membership does not transfer ownership or grant release access.</p>}
    {entry.adoption && requiresAction !== null && <>
      {requiresAction && <p className="control-plane-muted">Review this release's required actions before running the command. The flag records your explicit acceptance.</p>}
      <code className="library-command">myskills install {slug} --library-entry {entry.id}{requiresAction ? " --accept-user-action" : ""}</code>
    </>}
    {canWrite && <form className="library-stack" onSubmit={(event) => { event.preventDefault(); void adopt(); }}><label>Reviewed release version<Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.0.1" required /></label><label>Curator note (optional)<Input value={curatorNote} onChange={(event) => setCuratorNote(event.target.value)} maxLength={500} /></label><Button className="library-fit" variant="outline" disabled={busy || !version.trim()}>Adopt registry release</Button></form>}
    {entry.adoption && <details onToggle={(event) => setBindingsOpen(event.currentTarget.open)}>
      <summary>Connect an existing target</summary>
      {bindingsOpen && <TargetBindings api={api} entry={entry} />}
    </details>}
    {error && <p role="alert">{error}</p>}
  </>;
}

function TargetBindings({ api, entry }: { api: LibraryClient; entry: LibraryEntry }) {
  const [bindings, setBindings] = useState<LibraryBinding[]>([]);
  const [targetId, setTargetId] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => setBindings((await api.bindings(entry.id)).bindings), [api, entry.id]);
  useEffect(() => {
    let active = true;
    void api.bindings(entry.id).then((result) => { if (active) setBindings(result.bindings); }).catch((e) => { if (active) setError(libraryError(e)); });
    return () => { active = false; };
  }, [api, entry.id]);
  async function bind(replace: boolean) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.bind(entry.id, targetId.trim(), replace);
      setTargetId(""); setConflict(false); await load(); setMessage("Target binding saved. Updates must respect this library's adopted version.");
    } catch (e) {
      setConflict(Boolean(e && typeof e === "object" && "code" in e && e.code === "BINDING_VERSION_CONFLICT"));
      setError(libraryError(e));
    } finally { setBusy(false); }
  }
  return <div className="library-stack">
    <p>Choose a target you can manage. Its update policy will also require this adopted version. Changes require an MFA-verified session.</p>
    <form className="library-row" onSubmit={(event) => { event.preventDefault(); void bind(false); }}>
      <label>Target ID<Input value={targetId} onChange={(event) => { setTargetId(event.target.value); setConflict(false); }} required /></label>
      <Button disabled={busy || !targetId.trim()}>Bind target</Button>
    </form>
    {conflict && <div className="library-stack"><p>Replace the conflicting library bindings for {targetId} with this adoption? Installed files stay unchanged.</p><Button variant="outline" disabled={busy || !targetId.trim()} onClick={() => void bind(true)}>Replace conflicting binding</Button></div>}
    {bindings.filter((binding) => binding.status !== "detached").map((binding) => <div className="library-inset library-stack" key={binding.id}>
      <strong>{binding.targetId}</strong><p>{binding.status} · {binding.pinnedVersion ?? "No adopted version"}</p>
      {confirmDetach === binding.id ? <div className="library-row"><p>Stop this target following this library entry?</p><Button variant="outline" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void api.detach(binding.id).then(async () => { setConfirmDetach(null); await load(); setMessage("Binding detached. Installed files stay unchanged."); }).catch((e) => setError(libraryError(e))).finally(() => setBusy(false));
      }}>Confirm detach binding</Button><Button variant="ghost" onClick={() => setConfirmDetach(null)}>Cancel</Button></div> : <Button variant="ghost" disabled={busy} className="library-fit" onClick={() => setConfirmDetach(binding.id)}>Detach binding</Button>}
    </div>)}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}

function RemoveEntry({ api, entry, onChanged }: { api: LibraryClient; entry: LibraryEntry; onChanged: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return <div>{confirm ? <div className="library-row"><p>Remove this entry? Installed files and registry releases stay intact.</p><Button variant="destructive" size="sm" disabled={busy} onClick={() => { setBusy(true); void api.removeEntry(entry.id).then(() => onChanged()).catch((e) => setError(libraryError(e))).finally(() => setBusy(false)); }}>Confirm remove</Button><Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button></div> : <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}><Trash2 size={14} />Remove entry</Button>}{error && <p role="alert">{error}</p>}</div>;
}

function LibrarySettings({ api, mfaVerified }: { api: LibraryClient; mfaVerified: boolean }) {
  const [settings, setSettings] = useState<LibrarySettingsResponse | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  useEffect(() => { let active = true; void api.settings().then((value) => { if (active) setSettings(value); }).catch((e) => { if (active) setError(libraryError(e)); }); return () => { active = false; }; }, [api]);
  async function save(enabled: boolean) {
    setPending(enabled); setBusy(true); setError(null);
    try { setSettings(await api.setSettings(enabled)); }
    catch (e) {
      setError(libraryError(e));
      try {
        const current = await api.settings(); setSettings(current);
        setError(current.settings.privateSelfReviewEnabled === enabled
          ? "The save response could not be confirmed. The current policy was reloaded and matches your choice."
          : `${libraryError(e)} The current policy was reloaded.`);
      }
      catch { setSettings(null); setError("The current private-import policy could not be verified. Refresh before changing it again."); }
    } finally { setPending(null); setBusy(false); }
  }
  return <Card><CardHeader><CardTitle>Instance policy</CardTitle><CardDescription>Administrator setting</CardDescription></CardHeader><CardContent className="library-stack"><label className="library-checkbox"><input type="checkbox" checked={pending ?? settings?.settings.privateSelfReviewEnabled ?? false} disabled={!settings || !mfaVerified || busy} onChange={(event) => { void save(event.target.checked); }} />Allow private import self-review</label>{busy && <p role="status">Saving policy…</p>}<p className="control-plane-muted">Users may approve only their own private imports after a clean scan. Disabling stops new approvals; existing private copies remain available.</p>{!mfaVerified && <p>Verify MFA to change this setting.</p>}{error && <p role="alert">{error}</p>}</CardContent></Card>;
}

function LibraryInbox({ api, onSelect }: { api: LibraryClient; onSelect: (id: string) => void }) {
  const [items, setItems] = useState<LibraryInboxItem[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; void api.inbox().then((value) => { if (active) { setItems(value.items); setCursor(value.nextCursor); } }).catch((e) => { if (active) setError(libraryError(e)); }); return () => { active = false; }; }, [api]);
  return <Card><CardHeader><CardTitle>Change inbox</CardTitle><CardDescription>Updates from libraries you follow.</CardDescription></CardHeader><CardContent className="library-stack">{items.length === 0 && <p className="control-plane-muted">No notifications yet.</p>}{items.map((item) => <div key={item.id}><Button variant="ghost" className="library-choice" onClick={() => { onSelect(item.libraryId); void api.markRead([item.id]).then(() => setItems((current) => current.map((row) => row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row))).catch((e) => setError(libraryError(e))); }}><span>{item.libraryName} · {item.kind.replaceAll("-", " ")}</span>{!item.readAt && <Badge>New</Badge>}</Button><small>{date(item.createdAt)}</small></div>)}{cursor && <Button variant="outline" size="sm" onClick={() => void api.inbox(cursor).then((value) => { setItems((current) => [...current, ...value.items]); setCursor(value.nextCursor); }).catch((e) => setError(libraryError(e)))}>More notifications</Button>}{error && <p role="alert">{error}</p>}</CardContent></Card>;
}
