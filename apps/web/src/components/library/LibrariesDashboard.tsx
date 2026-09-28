import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bell, Check, CircleAlert, ExternalLink, GitBranch, Lock, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Users } from "lucide-react";
import type { LibrarySummary, LibraryEntry, LibraryCandidate, LibraryInboxItem, LibraryBinding, SourceDiscovery, LibrarySourceRefKind, LibraryTrackingMode } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import type { RegistryClient, ReleaseMetadata, TeamRecord, WebAuthUser } from "../../api.js";
import { libraryError, type LibraryClient, type LibrarySettingsResponse } from "../../library-api.js";
import { PackageFileViewer } from "../registry/PackageFileViewer.js";
import { LibrarySharingReview } from "./LibrarySharingReview.js";
import { LibraryDisclosure } from "./LibraryDisclosure.js";
import { attestationLabel, bindingStatusLabel, candidateStateLabel, dateTime, eventLabel, healthLabel, platformLabel, refLabel, repositoryLabel, reviewStatusLabel, roleLabel, securityStatusLabel, severityLabel, shortDate, tileTone, trackingModeLabel, type Tone } from "./library-display.js";
import { BundleReference } from "./BundleReference.js";

const mutationId = () => crypto.randomUUID();
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Never";
// Measured surface width at which the entry list and inspector sit side by side.
// 700 keeps 1024px windows (about 726px of surface) in the two-pane layout.
const SPLIT_WIDTH = 700;

function Chip({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className="library-chip" data-tone={tone}>{tone === "danger" && <CircleAlert size={12} aria-hidden="true" />}{tone === "coral" && <span className="library-chip-mark" aria-hidden="true" />}{children}</span>;
}

function Tile({ tone, size }: { tone: string; size: 12 | 16 | 24 | 32 }) {
  return <span className="library-tile" data-tone={tone} data-size={size} aria-hidden="true" />;
}

function SourceGlyph({ large = false }: { large?: boolean }) {
  return <span className="library-source-glyph" data-size={large ? "lg" : "sm"} aria-hidden="true"><GitBranch size={large ? 14 : 12} /></span>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function SurfaceSkeleton({ label }: { label: string }) {
  return <div className="library-skeleton">
    <p role="status" className="sr-only">{label}</p>
    <div className="library-skeleton-head" aria-hidden="true"><span /><span /></div>
    {[0, 1, 2, 3].map((row) => <div key={row} className="library-skeleton-row" aria-hidden="true"><span /><span /></div>)}
  </div>;
}

export function LibrariesDashboard({ client, user }: { client: RegistryClient; user: WebAuthUser }) {
  if (!client.libraries) return <main className="library-workspace" aria-label="Libraries">
    <header className="library-page-header app-page-header"><h1>Libraries</h1></header>
    <div className="library-surface library-state"><p>Libraries are not available on this server.</p></div>
  </main>;
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
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminMounted, setAdminMounted] = useState(false);
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
    setBusy(true); setCreateError(null);
    try {
      const result = await api.create({ name: name.trim(), owner: owner === "user" ? { type: "user" } : { type: "team", id: owner }, clientMutationId: createKey.current });
      createKey.current = mutationId(); setName(""); await load(); setSelected(result.library.id);
      return true;
    } catch (e) { setCreateError(libraryError(e)); return false; } finally { setBusy(false); }
  }
  const canReviewSharing = user.roles.some((role) => ["owner", "admin", "maintainer"].includes(role));
  const canSetPolicy = user.roles.some((role) => role === "owner" || role === "admin");
  const createForm = (done?: () => void) => <form className="library-form library-create-form" onSubmit={(event) => { event.preventDefault(); void create().then((created) => { if (created) done?.(); }); }}>
    <label className="library-field library-grow"><span>Library name</span><Input value={name} onChange={(event) => { setName(event.target.value); createKey.current = mutationId(); }} maxLength={120} required /></label>
    {teams.length > 0 && <label className="library-field"><span>Library owner</span><select value={owner} onChange={(event) => { setOwner(event.target.value); createKey.current = mutationId(); }}><option value="user">Me</option>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
    <Button disabled={busy || !name.trim()}><Plus size={16} aria-hidden="true" />Create library</Button>
    {createError && <p role="alert" className="library-alert">{createError}</p>}
  </form>;
  function removed() {
    const index = libraries.findIndex((library) => library.id === selected);
    setSelected(libraries[index + 1]?.id ?? libraries[index - 1]?.id ?? null);
    void load();
  }
  return <main className="library-workspace" aria-label="Libraries">
    <header className="library-page-header app-page-header">
      <h1>Libraries</h1>
      <div className="library-page-actions">
        <LibraryInbox api={api} onSelect={setSelected} />
        {canReviewSharing && <Button type="button" size="sm" variant="outline" aria-label="Library administration" aria-expanded={adminOpen} aria-controls={adminMounted ? "library-administration" : undefined} onClick={() => { setAdminMounted(true); setAdminOpen((open) => !open); }}>
          <ShieldCheck size={16} aria-hidden="true" /><span className="library-action-text">Administration</span>
        </Button>}
        {libraries.length > 0 && <LibraryDisclosure label="New library" icon={<Plus size={16} aria-hidden="true" />}>
          {(close) => <div className="library-popover-body"><h2 className="library-popover-title">New library</h2>{createForm(close)}</div>}
        </LibraryDisclosure>}
      </div>
    </header>
    {adminMounted && <section id="library-administration" className="library-admin" aria-label="Library administration" hidden={!adminOpen}>
      <LibrarySharingReview api={api} mfaVerified={user.mfaVerified} />
      {canSetPolicy && <LibrarySettings api={api} mfaVerified={user.mfaVerified} />}
    </section>}
    {loading ? <>
      <div className="library-switcher library-skeleton-switcher" aria-hidden="true"><span /><span /></div>
      <div className="library-surface"><SurfaceSkeleton label="Loading libraries…" /></div>
    </> : <>
      {(libraries.length > 1 || cursor) && <nav className="library-switcher" aria-label="Your libraries">
        <div className="library-switcher-track">
          {libraries.map((library) => <button key={library.id} type="button" className="library-switch" aria-current={selected === library.id ? "true" : undefined} onClick={() => setSelected(library.id)}>
            <Tile tone={tileTone(library.id)} size={12} />
            <span className="library-switch-name">{library.name}</span>
            {library.owner.type === "team" && <><span className="library-switch-tag" aria-hidden="true"><Users size={12} /><span className="library-switch-tag-text">Team</span></span><span className="sr-only">, team library</span></>}
          </button>)}
        </div>
        {cursor && <Button type="button" variant="ghost" size="sm" onClick={() => void load(cursor)}>Load more libraries</Button>}
      </nav>}
      {error && libraries.length > 0 && <p role="alert" className="library-alert library-alert-bar">{error}</p>}
      {error && libraries.length === 0 ? <div className="library-surface library-state">
        <h2>Couldn't load libraries</h2>
        <p role="alert">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
      </div> : libraries.length === 0 ? <section className="library-surface library-first-use" aria-labelledby="library-first-use-title">
        <div className="library-first-use-body">
          <span className="library-first-glyph" aria-hidden="true"><span data-tone="teal" /><span data-tone="amber" /><span data-tone="navy" /></span>
          <h2 id="library-first-use-title">Create your first library</h2>
          <p className="library-lede">Keep useful skills together, retain their sources, and choose which versions you use.</p>
          {createForm()}
          <ol className="library-steps">
            <li><Tile tone="teal" size={12} /><strong>Save</strong><span>Save a GitHub repository or a skill. Saving a source does not install its content.</span></li>
            <li><Tile tone="amber" size={12} /><strong>Check</strong><span>Preview complete skill packages before importing them.</span></li>
            <li><Tile tone="navy" size={12} /><strong>Adopt</strong><span>Adoption records the reviewed version you recommend. Installed copies change only when you update them.</span></li>
          </ol>
        </div>
      </section> : selected ? <LibraryDetail key={selected} api={api} client={client} libraryId={selected} onRemoved={removed} /> : null}
    </>}
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
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [subscriptionPending, setSubscriptionPending] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"split" | "stack" | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ kind: "row" | "title"; id: string } | null>(null);
  const sourceKey = useRef(mutationId());
  const skillKey = useRef(mutationId());
  const epoch = useRef(0);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const automaticSelection = useRef(false);
  const baseId = useId();
  const titleId = (id: string) => `${baseId}-entry-${id}`;
  const load = useCallback(async (next?: string) => {
    const ticket = ++epoch.current;
    const [detail, page] = await Promise.all([api.get(libraryId), api.entries(libraryId, next)]);
    if (ticket !== epoch.current) return;
    setLibrary(detail.library); setEntries((current) => next ? [...current, ...page.entries] : page.entries); setCursor(page.nextCursor);
  }, [api, libraryId]);
  useEffect(() => { void load().catch((e) => setError(libraryError(e))); return () => { epoch.current++; }; }, [load]);
  // Split or stack follows the surface's own width, not the viewport.
  const measure = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect(); observer.current = null;
    if (!node) return;
    const apply = (width: number) => setLayout(width >= SPLIT_WIDTH ? "split" : "stack");
    apply(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([item]) => { if (item) apply(item.contentRect.width); });
    observer.current.observe(node);
  }, []);
  async function action(work: () => Promise<unknown>, report: (message: string | null) => void = setError) {
    setBusy(true); report(null);
    try { await work(); await load(); } catch (e) { report(libraryError(e)); } finally { setBusy(false); }
  }
  async function saveSource() {
    const result = await api.addSource(libraryId, { url, ...(path.trim() ? { path: path.trim() } : {}), ...(refKind === "url" ? {} : { ref: { kind: refKind, ...(refValue.trim() ? { value: refValue.trim() } : {}) } }), clientMutationId: sourceKey.current });
    sourceKey.current = mutationId(); setUrl(""); setPath(""); setRefKind("url"); setRefValue(""); setSourceSelection({ id: result.entry.id, discover: true });
  }
  const importing = Boolean(sourceSelection && library?.access.canImport);
  const skills = entries.filter((entry) => entry.kind !== "source");
  const sources = entries.filter((entry) => entry.kind === "source");
  const ordered = [...skills, ...sources];
  const selectedEntry = entries.find((entry) => entry.id === selectedId) ?? null;
  const firstId = ordered[0]?.id ?? null;
  useEffect(() => { if (sourceSelection) { automaticSelection.current = false; setSelectedId(sourceSelection.id); } }, [sourceSelection]);
  useEffect(() => {
    if (layout === "stack" && automaticSelection.current && !sourceSelection) {
      automaticSelection.current = false;
      setSelectedId(null);
    } else if (layout === "split" && !busy && !selectedEntry && firstId && !sourceSelection) {
      automaticSelection.current = true;
      setSelectedId(firstId);
    }
  }, [layout, busy, selectedEntry, firstId, sourceSelection]);
  useEffect(() => {
    if (!focusTarget) return;
    const node = focusTarget.kind === "row" ? rows.current.get(focusTarget.id) : document.getElementById(titleId(focusTarget.id));
    node?.focus();
    if (document.activeElement === node || !busy) setFocusTarget(null);
  });
  function openEntry(id: string, moveFocus = layout === "stack") {
    automaticSelection.current = false;
    setSelectedId(id);
    if (moveFocus) setFocusTarget({ kind: "title", id });
  }
  function crossLink(id: string) {
    setSourceSelection(null);
    openEntry(id, true);
  }
  function backToEntries() {
    if (selectedId) setFocusTarget({ kind: "row", id: selectedId });
    automaticSelection.current = false;
    setSelectedId(null);
  }
  const afterRemove = (entry: LibraryEntry) => async () => {
    const index = ordered.findIndex((row) => row.id === entry.id);
    const next = ordered[index + 1]?.id ?? ordered[index - 1]?.id ?? null;
    if (sourceSelection?.id === entry.id) setSourceSelection(null);
    await load();
    automaticSelection.current = layout === "split";
    setSelectedId(layout === "split" ? next : null);
    if (next) setFocusTarget({ kind: "row", id: next });
  };
  if (!library) return <section ref={measure} className="library-surface">
    {error ? <div className="library-state"><p role="alert">{error}</p></div> : <SurfaceSkeleton label="Loading library…" />}
  </section>;

  const team = library.owner.type === "team";
  const sourceForm = (primary: boolean, done?: () => void) => <form className="library-form" onSubmit={(event) => { event.preventDefault(); void action(async () => { await saveSource(); done?.(); }, setSourceError); }}>
    <label className="library-field"><span>GitHub source URL</span><Input type="url" value={url} onChange={(event) => { setUrl(event.target.value); sourceKey.current = mutationId(); }} placeholder="https://github.com/owner/repo" required /></label>
    <details className="library-details"><summary>Source selection</summary><div className="library-form library-details-body">
      <label className="library-field"><span>Directory filter</span><Input value={path} onChange={(event) => { setPath(event.target.value); sourceKey.current = mutationId(); }} placeholder="Optional, such as skills" /></label>
      <label className="library-field"><span>Track ref</span><select value={refKind} onChange={(event) => { setRefKind(event.target.value as LibrarySourceRefKind | "url"); setRefValue(""); sourceKey.current = mutationId(); }}><option value="url">Use ref from URL</option><option value="default-branch">Default branch</option><option value="latest-release">Latest stable release</option><option value="branch">Named branch</option><option value="tag">Exact tag</option><option value="tag-prefix">Release tag prefix</option><option value="commit">Exact commit</option></select></label>
      {!["url", "default-branch", "latest-release"].includes(refKind) && <label className="library-field"><span>Ref value</span><Input value={refValue} onChange={(event) => { setRefValue(event.target.value); sourceKey.current = mutationId(); }} required /></label>}
    </div></details>
    {sourceError && <p role="alert" className="library-alert">{sourceError}</p>}
    <div className="library-form-actions"><Button variant={primary ? "default" : "outline"} disabled={busy || !url.trim()}>Save source</Button></div>
  </form>;
  const skillForm = (primary: boolean, done?: () => void) => <form className="library-form library-form-row" onSubmit={(event) => {
    event.preventDefault();
    let added: string | null = null;
    void action(async () => { const result = await api.addSkill(libraryId, slug.trim(), skillKey.current); skillKey.current = mutationId(); setSlug(""); added = result.entry.id; done?.(); }, setSkillError).then(() => { if (added) openEntry(added); });
  }}>
    <label className="library-field library-grow"><span>Skill slug</span><Input value={slug} onChange={(event) => { setSlug(event.target.value); skillKey.current = mutationId(); }} placeholder="such as release-notes-helper" required /></label>
    <Button variant={primary ? "default" : "outline"} disabled={busy || !slug.trim()}>Save skill</Button>
    {skillError && <p role="alert" className="library-alert">{skillError}</p>}
  </form>;

  const needle = query.trim().toLowerCase();
  const matches = (entry: LibraryEntry) => !needle || [entry.title, entry.skill?.slug, entry.source?.fullName, entry.source?.path].some((value) => value?.toLowerCase().includes(needle));
  const shownSkills = skills.filter(matches);
  const shownSources = sources.filter(matches);
  const shown = shownSkills.length + shownSources.length;
  const sourceNames = new Map(sources.map((entry) => [entry.id, entry.source?.fullName ?? entry.title]));
  const count = (visible: number, total: number) => needle ? `${visible} of ${total}${cursor ? " loaded" : ""}` : cursor ? `${total} loaded` : String(total);
  const loadMore = cursor && <Button type="button" variant="outline" size="sm" onClick={() => void load(cursor).catch((e) => setError(libraryError(e)))}>Load more entries</Button>;
  const clearFilter = <Button type="button" variant="ghost" size="sm" onClick={() => setQuery("")}>Clear filter</Button>;
  const row = (entry: LibraryEntry) => <EntryRow
    key={entry.id}
    entry={entry}
    sourceName={entry.skill?.sourceEntryId ? sourceNames.get(entry.skill.sourceEntryId) : undefined}
    selected={entry.id === selectedId}
    register={(node) => { if (node) rows.current.set(entry.id, node); else rows.current.delete(entry.id); }}
    onSelect={() => openEntry(entry.id)}
  />;

  const inspected = importing ? entries.find((entry) => entry.id === sourceSelection?.id) ?? null : selectedEntry;
  const listHidden = importing || (layout === "stack" && Boolean(selectedEntry));
  const showInspector = importing || layout === "split" || Boolean(selectedEntry);
  const remove = (entry: LibraryEntry) => library.access.canWrite && <RemoveEntry api={api} entry={entry} onChanged={afterRemove(entry)} />;
  const inspector = inspected ? <aside key={inspected.id} className="library-inspector" aria-labelledby={titleId(inspected.id)} onFocusCapture={() => { automaticSelection.current = false; }}>
    {layout === "stack" && !importing && <Button type="button" variant="ghost" size="sm" className="library-back" onClick={backToEntries}><ArrowLeft size={16} aria-hidden="true" />Back to entries</Button>}
    {inspected.kind === "bundle" ? <><header className="library-inspector-head"><h3 id={titleId(inspected.id)} tabIndex={-1}>{inspected.title}</h3><Chip>Bundle</Chip></header><BundleReference entry={inspected} />{remove(inspected)}</> : inspected.kind === "source" && inspected.source ? <SourceEntry
      api={api}
      entry={inspected}
      library={library}
      titleId={titleId(inspected.id)}
      importing={importing}
      skills={skills.filter((entry) => entry.skill?.sourceEntryId === inspected.id)}
      partial={Boolean(cursor)}
      onDiscover={() => setSourceSelection({ id: inspected.id, discover: true })}
      onReview={() => setSourceSelection({ id: inspected.id, discover: false })}
      onSelectEntry={crossLink}
      onChanged={() => load()}
      importer={sourceSelection && library.access.canImport && sourceSelection.id === inspected.id && <SourceImporter key={`${sourceSelection.id}:${sourceSelection.discover}`} api={api} entryId={sourceSelection.id} discoverOnOpen={sourceSelection.discover} entries={entries} onChanged={() => load()} onClose={() => setSourceSelection(null)} />}
      footer={remove(inspected)}
    /> : <SkillEntry
      api={api}
      client={client}
      entry={inspected}
      canWrite={library.access.canWrite}
      titleId={titleId(inspected.id)}
      sourceEntry={sources.find((entry) => entry.id === inspected.skill?.sourceEntryId)}
      onSelectEntry={crossLink}
      onChanged={() => load()}
      footer={remove(inspected)}
    />}
  </aside> : importing ? <div className="library-inspector"><p role="status" className="library-muted">Loading source…</p></div>
    : layout === "split" ? <div className="library-inspector library-inspector-empty"><p className="library-muted">Select an entry to see its details.</p></div> : null;

  return <section ref={measure} className="library-surface" data-layout={layout ?? undefined} data-mode={importing ? "import" : undefined} aria-labelledby={`${baseId}-name`}>
    <header className="library-head">
      <Tile tone={tileTone(library.id)} size={32} />
      <div className="library-head-text">
        <h2 id={`${baseId}-name`}>{library.name}</h2>
        <p className="library-head-meta">
          <span>{team && library.owner.type === "team" ? `Team library · ${library.owner.name}` : "Personal library"}</span>
          <span>{roleLabel(library.access.role)}</span>
          {!library.access.canWrite && <span className="library-view-only"><Lock size={12} aria-hidden="true" />View only</span>}
        </p>
        {library.description && <p className="library-head-desc">{library.description}</p>}
      </div>
      <div className="library-head-actions">
        <label className="library-switch-field"><input type="checkbox" className="library-switch-input" checked={subscriptionPending ?? Boolean(library.subscription)} disabled={busy} onChange={(event) => { const enabled = event.target.checked; setSubscriptionPending(enabled); void action(() => enabled ? api.subscribe(libraryId) : api.unsubscribe(libraryId)).finally(() => setSubscriptionPending(null)); }} /><span>Notify me about changes</span></label>
        <Button type="button" size="icon-sm" variant="ghost" className="library-refresh" data-busy={busy || undefined} disabled={busy} onClick={() => void action(() => Promise.resolve())}><RefreshCw size={16} aria-hidden="true" /><span className="sr-only">Refresh</span></Button>
        {library.access.canWrite && <LibraryDisclosure label="Library settings" iconOnly focusPanel variant="ghost" icon={<Settings2 size={16} aria-hidden="true" />}>
          {(close) => <div className="library-popover-body">
            <h3 className="library-popover-title">Library settings</h3>
            <p className="library-muted">Deleting a library stops tracking and subscriptions. Installed files stay in place; bindings stop following new recommendations.</p>
            <div className="library-form-actions"><Button type="button" variant="outline" size="sm" className="library-danger-button" disabled={busy} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={14} aria-hidden="true" />Delete this library</Button></div>
          </div>}
        </LibraryDisclosure>}
      </div>
    </header>
    {error && <p role="alert" className="library-alert library-alert-bar">{error}</p>}
    {entries.length > 0 || importing ? <>
      <div className="library-toolbar" hidden={layout === "stack" && !importing && Boolean(selectedEntry)}>
        <div className="library-filter" hidden={importing}>
          <Search size={16} aria-hidden="true" />
          <Input type="search" aria-label="Filter entries" placeholder={cursor ? "Filter loaded entries" : "Filter entries"} value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {library.access.canWrite ? <div className="library-toolbar-actions">
          <LibraryDisclosure label="Add source" variant={team ? "outline" : "default"} icon={<GitBranch size={16} aria-hidden="true" />}>
            {(close) => <div className="library-popover-body">
              <h3 className="library-popover-title">Add a GitHub source</h3>
              <p className="library-muted">Use a public github.com repository, directory, or SKILL.md URL. Saving a source does not install its content.</p>
              {sourceForm(true, close)}
            </div>}
          </LibraryDisclosure>
          <LibraryDisclosure label="Add skill" variant={team ? "default" : "outline"} icon={<Plus size={16} aria-hidden="true" />}>
            {(close) => <div className="library-popover-body">
              <h3 className="library-popover-title">Add a skill</h3>
              <p className="library-muted">{team ? "Curate releases already shared with your team." : "Save an authorized skill by its slug."}</p>
              {skillForm(true, close)}
            </div>}
          </LibraryDisclosure>
        </div> : team ? <p className="library-readonly"><Lock size={14} aria-hidden="true" />View only. Team curators choose what this library recommends.</p> : null}
      </div>
      <div className="library-body" data-mode={importing ? "import" : "browse"}>
        <div className="library-list" hidden={listHidden}>
          {needle && shown === 0 ? <div className="library-list-empty">
            <p>No loaded entries match “{query.trim()}”.</p>
            <div className="library-actions">{clearFilter}{loadMore}</div>
          </div> : <>
            {shownSkills.length > 0 && <section className="library-group" aria-labelledby={`${baseId}-skills`}>
              <div className="library-group-label"><h3 id={`${baseId}-skills`}>Skills</h3><span>{count(shownSkills.length, skills.length)}</span></div>
              <ul className="library-entries">{shownSkills.map(row)}</ul>
            </section>}
            {shownSources.length > 0 && <section className="library-group" aria-labelledby={`${baseId}-sources`}>
              <div className="library-group-label"><h3 id={`${baseId}-sources`}>Sources</h3><span>{count(shownSources.length, sources.length)}</span></div>
              <ul className="library-entries">{shownSources.map(row)}</ul>
            </section>}
            {(needle || cursor) && <div className="library-list-foot">
              <span>{needle ? `Showing ${shown} of ${entries.length} loaded` : `Showing ${entries.length} loaded`}</span>
              {needle && clearFilter}{loadMore}
            </div>}
          </>}
        </div>
        {showInspector && inspector}
      </div>
    </> : library.access.canWrite ? <div className="library-empty">
      <h3>Add a source or a skill</h3>
      <p>No entries yet. Save a source to discover its skills.</p>
      {team && <p className="library-muted">Curate releases already shared with your team. Sources can be saved as references.</p>}
      <div className="library-empty-forms">
        {team ? skillForm(true) : sourceForm(true)}
        <div className="library-or"><span>or</span></div>
        {team ? sourceForm(false) : skillForm(false)}
      </div>
      <p className="library-muted">Saving a source does not install its content. Adoption records the reviewed version you recommend.</p>
    </div> : <div className="library-empty">
      <h3>Nothing here yet</h3>
      <p>Team curators choose what this library recommends. Entries appear here once they add some.</p>
    </div>}
    {confirmDelete && <ConfirmationDialog onClose={() => setConfirmDelete(false)} request={{
      key: `library-delete-${library.id}`,
      title: `Delete ${library.name}?`,
      description: "Deleting a library stops tracking and subscriptions. Installed files stay in place; bindings stop following new recommendations.",
      confirmLabel: "Delete library",
      destructive: true,
      details: [{ label: "Library", value: team ? "Team library" : "Personal library" }, { label: "Entries", value: cursor ? `${entries.length} loaded` : String(entries.length) }],
      onConfirm: async () => {
        try { await api.remove(libraryId, library.revision); } catch (e) { throw new Error(libraryError(e)); }
        onRemoved();
      },
    }} />}
  </section>;
}

function retryDeadline(tracking: LibraryEntry["tracking"]): string | null {
  if (tracking?.retryAvailableAt !== undefined) return tracking.retryAvailableAt;
  return tracking?.health === "rate-limited" ? tracking.nextCheckAt ?? null : null;
}

function useDeadlineNow(deadline: string | null | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const until = deadline ? Date.parse(deadline) : NaN;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function tick() {
      const current = Date.now();
      setNow(current);
      const remaining = until - current;
      if (remaining > 0) timer = setTimeout(tick, remaining > 60_000 ? Math.min(60_000, remaining - 60_000) : Math.min(1_000, remaining));
    }
    tick();
    return () => clearTimeout(timer);
  }, [deadline]);
  return now;
}

function CheckSchedule({ tracking, compact = false }: { tracking: LibraryEntry["tracking"]; compact?: boolean }) {
  const scheduled = (tracking?.mode === "daily" || tracking?.mode === "weekly") && tracking.workerAvailable !== false;
  const retryAt = retryDeadline(tracking);
  const nextAt = tracking?.nextCheckAt;
  const deadline = scheduled && nextAt ? retryAt && Date.parse(retryAt) > Date.parse(nextAt) ? retryAt : nextAt : retryAt;
  const now = useDeadlineNow(deadline);
  if (!tracking || (!scheduled && !deadline)) return compact ? null : <Fact label="Checks">No automatic checks scheduled</Fact>;
  const timestamp = deadline ? Date.parse(deadline) : NaN;
  const remaining = Math.max(0, timestamp - now);
  const countdown = !Number.isFinite(timestamp) ? "" : remaining === 0 ? scheduled ? "due" : "now"
    : remaining >= 3_600_000 ? `in ${Math.ceil(remaining / 3_600_000)}h` : remaining >= 60_000 ? `in ${Math.ceil(remaining / 60_000)}m` : `in ${Math.ceil(remaining / 1_000)}s`;
  const label = scheduled ? "Next check" : "Retry available";
  const content = <>{deadline && Number.isFinite(timestamp) ? <time dateTime={deadline} title={new Date(timestamp).toLocaleString()}>{dateTime(deadline)}</time> : "Not scheduled"}{countdown && <span className="library-check-countdown">{countdown}</span>}</>;
  return compact ? <span className="library-check-schedule">{label}: {content}</span> : <Fact label={label}><span className="library-check-schedule">{content}</span></Fact>;
}

function EntryRow({ entry, sourceName, selected, register, onSelect }: { entry: LibraryEntry; sourceName?: string; selected: boolean; register: (node: HTMLButtonElement | null) => void; onSelect: () => void }) {
  const id = useId();
  const source = entry.kind === "source" ? entry.source : undefined;
  const slug = entry.skill?.slug;
  const health = healthLabel(entry.tracking?.health);
  const attestation = entry.adoption ? attestationLabel(entry.adoption.attestation) : null;
  return <li>
    <button ref={register} type="button" className="library-entry" aria-labelledby={`${id}-title`} aria-describedby={`${id}-meta ${id}-chips`} aria-current={selected ? "true" : undefined} onClick={onSelect}>
      {entry.kind === "source" ? <SourceGlyph /> : <Tile tone={tileTone(slug ?? entry.id)} size={16} />}
      <span className="library-entry-text">
        <span id={`${id}-title`} className="library-entry-title">{entry.title}</span>
        <span id={`${id}-meta`} className="library-entry-meta">
          {entry.kind === "bundle" ? <span>Bundle reference</span> : entry.kind === "source" ? <><span>{source?.path || "Repository root"}</span><span>{refLabel(source?.ref)}</span></>
            : <>{slug && <code>{slug}</code>}<span>{sourceName ?? (entry.skill?.sourceEntryId ? "Library source" : "Skills")}</span></>}
        </span>
        {source && <CheckSchedule tracking={entry.tracking} compact />}
      </span>
      <span id={`${id}-chips`} className="library-entry-chips">
        {entry.kind === "bundle" ? <Chip>Bundle</Chip> : entry.kind === "source" ? <>
          {entry.tracking && <Chip>{trackingModeLabel(entry.tracking.mode).label}</Chip>}
          {!["neutral", "teal"].includes(health.tone) && <Chip tone={health.tone}>{health.label}</Chip>}
        </> : entry.adoption ? <>
          <Chip tone="teal">Adopted {entry.adoption.version}</Chip>
          {entry.adoption.attestation === "private-self-reviewed" && attestation && <Chip tone={attestation.tone}>{attestation.label}</Chip>}
        </> : <Chip>Not adopted</Chip>}
      </span>
    </button>
  </li>;
}

function SourceEntry({ api, entry, library, titleId, importing, skills, partial, onDiscover, onReview, onSelectEntry, onChanged, importer, footer }: {
  api: LibraryClient; entry: LibraryEntry; library: LibrarySummary; titleId: string; importing: boolean; skills: LibraryEntry[]; partial: boolean;
  onDiscover: () => void; onReview: () => void; onSelectEntry: (id: string) => void; onChanged: () => Promise<void>; importer: ReactNode; footer: ReactNode;
}) {
  const source = entry.source!;
  const tracking = entry.tracking;
  const health = healthLabel(tracking?.health);
  const identity = Boolean(tracking?.identityChange);
  const checks = library.access.canTrackSources && <TrackingControls key={`${entry.id}:${entry.revision}`} api={api} entry={entry} onChanged={onChanged} />;
  const snapshot = tracking?.lastGoodSnapshot;
  return <>
    <header className="library-inspector-head">
      <SourceGlyph large />
      <div className="library-inspector-title">
        <h3 id={titleId} tabIndex={-1}>{source.fullName || entry.title}</h3>
        {source.url && <p><a href={source.url} target="_blank" rel="noreferrer">{repositoryLabel(source.url)}<ExternalLink size={12} aria-hidden="true" /></a></p>}
      </div>
    </header>
    {identity && checks && <section className="library-section" aria-label="Source checks">{checks}</section>}
    <dl className="library-facts">
      <Fact label="Path">{source.path || "Repository root"}</Fact>
      <Fact label="Tracks">{refLabel(source.ref)}{source.ref?.kind === "default-branch" && source.defaultBranch ? <span className="library-muted"> · {source.defaultBranch}</span> : null}</Fact>
      {source.license !== undefined && <Fact label="License">{source.license ?? "Not declared"}</Fact>}
      {tracking && <Fact label="Checks"><span className="library-fact-inline">{trackingModeLabel(tracking.mode).label}<Chip tone={health.tone}>{health.label}</Chip></span></Fact>}
      {tracking && <Fact label="Last success">{dateTime(tracking.lastSuccessfulCheckAt) ?? "Never"}</Fact>}
      {tracking && <CheckSchedule tracking={tracking} />}
      {snapshot && <Fact label="Last snapshot"><span className="library-fact-inline"><code>{snapshot.commit.slice(0, 12)}</code>{snapshot.upstreamLabel && <span>{snapshot.upstreamLabel}</span>}{shortDate(snapshot.observedAt) && <span className="library-muted">{shortDate(snapshot.observedAt)}</span>}</span></Fact>}
      {source.archived && <Fact label="Upstream"><Chip tone="amber">Archived upstream</Chip></Fact>}
    </dl>
    {library.access.canImport && <section className="library-section" aria-labelledby={`${titleId}-import`}>
      <h4 id={`${titleId}-import`}>Import skills</h4>
      <p className="library-muted">Inspect the frozen source and complete package before submitting. Saved candidates remain available when the source is offline.</p>
      <div className="library-actions">
        <Button type="button" size="sm" variant={importing ? "outline" : "default"} onClick={onDiscover}>Discover skills</Button>
        <Button type="button" size="sm" variant="outline" onClick={onReview}>Review candidates</Button>
      </div>
    </section>}
    {importer}
    <section className="library-section" aria-labelledby={`${titleId}-skills`}>
      <h4 id={`${titleId}-skills`}>In this library</h4>
      {skills.length ? <ul className="library-links">{skills.map((skill) => <li key={skill.id}><button type="button" className="library-link-row" onClick={() => onSelectEntry(skill.id)}>
        <Tile tone={tileTone(skill.skill?.slug ?? skill.id)} size={12} /><span>{skill.title}</span>{skill.skill?.slug && <code>{skill.skill.slug}</code>}
      </button></li>)}</ul> : <p className="library-muted">No {partial ? "loaded " : ""}skills in this library come from this source yet.</p>}
      {partial && skills.length > 0 && <p className="library-muted">Showing loaded entries only.</p>}
    </section>
    {!identity && checks && <section className="library-section" aria-labelledby={`${titleId}-checks`}><h4 id={`${titleId}-checks`}>Source checks</h4>{checks}</section>}
    {footer && <div className="library-section library-section-end">{footer}</div>}
  </>;
}

function TrackingControls({ api, entry, onChanged }: { api: LibraryClient; entry: LibraryEntry; onChanged: () => Promise<void> }) {
  const [mode, setMode] = useState<LibraryTrackingMode>(entry.tracking?.mode ?? "off");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identityChange = entry.tracking?.identityChange;
  const retryAt = retryDeadline(entry.tracking);
  const now = useDeadlineNow(retryAt);
  const coolingDown = Boolean(retryAt && Date.parse(retryAt) > now);
  const needsAcknowledgement = identityChange && !acknowledged && (mode === "daily" || mode === "weekly");
  async function run(check: boolean) { if (check && coolingDown) return; setBusy(true); setError(null); try { if (check) { const response = await api.check(entry.id); setResult(`Check ${response.check.outcome}. ${response.check.candidateIds.length} new candidates.`); } else await api.tracking(entry.id, { expectedRevision: entry.revision, mode, ...(identityChange && acknowledged ? { acknowledgeIdentityChange: true } : {}) }); await onChanged(); } catch (e) { setError(libraryError(e)); } finally { setBusy(false); } }
  return <div className="library-tracking">
    {identityChange && <div className="library-callout" data-tone="amber">
      <strong className="library-callout-title"><CircleAlert size={16} aria-hidden="true" />Repository identity changed</strong>
      <p>Previously trusted: {identityChange.acknowledgedFullName}</p>
      <a href={identityChange.observedUrl} target="_blank" rel="noreferrer">Review {identityChange.observedFullName}</a>
      <p>Review the repository's new identity before resuming checks. Pausing tracking keeps this review pending.</p>
      <label className="library-check"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />I reviewed the repository identity change</label>
    </div>}
    <div className="library-form-row">
      <label className="library-field"><span>Check frequency</span><select disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as LibraryTrackingMode)}><option value="off">Off</option><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
      <Button size="sm" variant="outline" disabled={busy || Boolean(needsAcknowledgement)} onClick={() => void run(false)}>Save tracking</Button>
      <Button size="sm" variant="ghost" disabled={busy || Boolean(identityChange) || coolingDown} onClick={() => void run(true)}>Check now</Button>
    </div>
    {coolingDown && <p className="library-muted">GitHub’s request allowance resets at the retry time. Check now will be available then.</p>}
    {entry.tracking?.workerAvailable === false && <p className="library-muted">Scheduled checks are unavailable on this instance. Manual checks remain available.</p>}
    {error && <p role="alert" className="library-alert">{error}</p>}{result && <p role="status" className="library-muted">{result}</p>}
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
  const headingId = useId();
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
  const roots = discovery ? [...discovery.skills, ...discovery.excluded] : [];
  return <section className="library-workbench" aria-labelledby={headingId}>
    <header className="library-workbench-head">
      <h4 id={headingId}>Source import</h4>
      <div className="library-actions">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void loadCandidates()}>Refresh saved candidates</Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>Close import</Button>
      </div>
    </header>
    {error && <p role="alert" className="library-alert">{error}</p>}
    {busy && <p role="status" className="library-muted">Loading import details…</p>}
    <div className="library-workbench-grid" data-columns={discovery ? "2" : "1"}>
      {discovery && <div className="library-workbench-pane">
        <div className="library-commit"><span>Source commit</span><code className="library-digest">{discovery.snapshot.commit}</code></div>
        {!discovery.complete && <p role="alert" className="library-alert">The repository inventory is incomplete. Import is unavailable.</p>}
        <fieldset className="library-roots" disabled={busy || !discovery.complete}><legend className="library-pane-label">Choose skills</legend>
          {roots.map((root) => <div key={root.path} className="library-inset library-root">
            <label className="library-root-label"><input type="checkbox" aria-label={`Select ${root.path}`} checked={paths.includes(root.path)} disabled={root.blockers.some((finding) => finding.severity === "blocking")} onChange={(event) => setPaths((current) => event.target.checked ? [...current, root.path] : current.filter((path) => path !== root.path))} />
              <span className="library-root-text"><span className="library-root-path">{root.path || "Repository root"}</span><small>{root.fileCount} files · {root.byteCount.toLocaleString()} bytes{root.excludedReason ? " · Excluded by default" : ""}</small></span>
            </label>
            {root.blockers.map((finding, index) => <p key={index} className="library-finding" data-tone={severityLabel(finding.severity).tone}>{finding.message}</p>)}
            <details className="library-details"><summary>Metadata mapping</summary><div className="library-form library-details-body">
              <label className="library-field"><span>Short summary</span><Input value={mappings[root.path]?.summary ?? ""} onChange={(event) => setMappings((current) => ({ ...current, [root.path]: { ...current[root.path], summary: event.target.value } }))} maxLength={500} /></label>
              <label className="library-field"><span>License identifier</span><Input value={mappings[root.path]?.license ?? ""} onChange={(event) => setMappings((current) => ({ ...current, [root.path]: { ...current[root.path], license: event.target.value } }))} maxLength={80} /></label>
            </div></details>
          </div>)}
        </fieldset>
        <div className="library-workbench-foot">
          <span className="library-muted">{paths.length} of {roots.length} selected · up to 20 per preview</span>
          <Button type="button" size="sm" disabled={busy || !paths.length || paths.length > 20 || !discovery.complete} onClick={() => void preview()}>Preview import</Button>
        </div>
      </div>}
      <div className="library-workbench-pane">
        <p className="library-pane-label">Candidates</p>
        {!busy && candidates.length === 0 && <p className="library-muted">No saved candidates.</p>}
        {candidates.map((candidate) => <CandidateReview key={`${candidate.id}:${candidate.packageDigest}:${candidate.state}:${candidate.registry?.reviewStatus}`} api={api} initial={candidate} entry={entries.find((entry) => entry.id === candidate.skillEntryId || entry.skill?.slug === candidate.lineage.slug)} onChanged={onChanged} />)}
        {cursor && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void loadCandidates(cursor)}>More candidates</Button>}
      </div>
    </div>
  </section>;
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
  const state = candidateStateLabel(candidate.state);
  const review = candidate.registry ? candidate.registry.attestation ? attestationLabel(candidate.registry.attestation) : reviewStatusLabel(candidate.registry.reviewStatus) : null;
  const scan = candidate.registry ? securityStatusLabel(candidate.registry.securityStatus) : null;
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await work(); await onChanged(); } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  return <article className="library-candidate" aria-label={`Import ${candidate.sourcePath}`}>
    <header className="library-candidate-head"><h5>{candidate.mapping.title}</h5><Chip tone={state.tone}>{state.label}</Chip></header>
    <p className="library-candidate-meta"><code>{candidate.lineage.slug}</code><span>{candidate.expectedVersion}</span>{candidate.mapping.license && <span>{candidate.mapping.license}</span>}</p>
    <p className="library-muted">Native name: {candidate.lineage.nativeName ?? "Unknown"} · Preview expires: {date(candidate.expiresAt)}</p>
    {nameNormalization && <section aria-label="Installed skill name" className="library-callout">
      <h6 className="library-callout-title">Installed skill name</h6>
      <p>To match its install folder, SKILL.md uses <code>{nameNormalization.runtimeName}</code>. The source name is <code>{nameNormalization.originalName ?? "Not declared"}</code>.</p>
      <p>The exact original is preserved in <code>{nameNormalization.originalPath}</code>. It is not loaded as a second skill.</p>
      <details className="library-details"><summary>Original and installed file digests</summary>
        <p>Original SHA-256</p><code className="library-digest">{nameNormalization.originalSha256}</code>
        <p>Installed SKILL.md SHA-256</p><code className="library-digest">{nameNormalization.transformedSha256}</code>
      </details>
    </section>}
    {candidate.packageDigest && <details className="library-details"><summary>Artifact digest</summary><code className="library-digest">{candidate.packageDigest}</code></details>}
    {candidate.findings.map((finding, index) => { const severity = severityLabel(finding.severity); return <p key={index} className="library-finding" data-tone={severity.tone}><strong>{severity.label}</strong>: {finding.message}</p>; })}
    {candidate.changes && <p className="library-muted">Changes: {candidate.changes.added.length} added · {candidate.changes.changed.length} changed · {candidate.changes.removed.length} removed</p>}
    <details open className="library-file-preview"><summary>Included files ({candidate.files.length})</summary>
      <ul className="library-files">{candidate.files.map((file) => <li key={file.path}><details>
        <summary><span>{file.path}</span><small>{file.bytes} bytes</small></summary>
        {file.content !== undefined ? <>
          <pre tabIndex={0}>{file.content.slice(0, 128_000)}</pre>
          {file.content.length > 128_000 && <p role="status">Preview limited to the first 128,000 characters. Export the package to inspect the complete file.</p>}
        </> : expired ? <p className="library-muted">Held preview content expired.{candidate.registry ? " Inspect the submitted artifact below." : " Discover this source again to create a new preview."}</p> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => setCandidate((await api.candidate(candidate.id)).candidate))}>Load held content</Button>}
      </details></li>)}</ul>
    </details>
    {candidate.state === "ready-for-review" && candidate.orderStatus === "unverified" && <label className="library-field"><span>Reason for accepting unverified source order</span><Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label>}
    {["ready-for-review", "blocked"].includes(candidate.state) && <div className="library-decision">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => setCandidate((await api.ignore(candidate.id)).candidate))}>Ignore candidate</Button>
      {candidate.state === "ready-for-review" && <div className="library-decision-main">
        <p className="library-muted">Unclassified changes require user action before an update. Submitting does not adopt or install this version.</p>
        <Button size="sm" disabled={busy || expired || !candidate.packageDigest || (candidate.orderStatus === "unverified" && !reason.trim())} onClick={() => void run(async () => {
          const result = await api.import(candidate.id, { expectedPackageDigest: candidate.packageDigest!, release: { classification: "unclassified" }, clientMutationId: key.current, ...(candidate.orderStatus === "unverified" && reason.trim() ? { acknowledgeUnverifiedOrder: { reason: reason.trim() } } : {}) });
          setCandidate(result.candidate); setInspected(false); setAttested(false);
        })}>Submit import for review</Button>
      </div>}
    </div>}
    {candidate.registry && <div className="library-candidate-registry">
      <p className="library-chips">{review && <Chip tone={review.tone}>{review.label}</Chip>}{scan && <Chip tone={scan.tone}>{scan.label}</Chip>}</p>
      {candidate.registry.reviewStatus === "unreviewed" && <>
        <PackageFileViewer resourceKey={`${candidate.id}:${candidate.packageDigest}`} label="Inspect submitted artifact" loadBundle={async () => {
          if (!candidate.packageDigest || !candidate.registry) throw new Error("No submitted artifact is available.");
          const bundle = await api.submittedBundle(candidate.registry.submissionId, candidate.packageDigest);
          setInspected(true); return bundle;
        }} />
        <label className="library-check"><input type="checkbox" checked={attested} disabled={!inspected || busy} onChange={(event) => setAttested(event.target.checked)} />I reviewed these files for my private use</label>
        <div className="library-decision-main">
          <p className="library-muted">Requires MFA and an enabled instance policy. This attestation does not authorize sharing.</p>
          <Button size="sm" disabled={busy || !inspected || !attested || !candidate.packageDigest} onClick={() => void run(async () => setCandidate((await api.selfReview(candidate.id, candidate.packageDigest!)).candidate))}>Approve for my private use</Button>
        </div>
      </>}
      {(candidate.registry.attestation === "private-self-reviewed" || (candidate.registry.reviewStatus === "approved" && candidate.skillEntryId)) && <div className="library-actions">
        {candidate.registry.attestation === "private-self-reviewed" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await api.requestReview(candidate.id); setMessage("Instance review requested. Sharing stays restricted until review is complete."); })}>Request instance review for sharing</Button>}
        {candidate.registry.reviewStatus === "approved" && candidate.skillEntryId && <Button size="sm" disabled={busy || entry?.adoption?.version === candidate.registry.version} onClick={() => void run(async () => {
          const current = (await api.entry(candidate.skillEntryId!)).entry;
          await api.adopt(candidate.skillEntryId!, { version: candidate.registry!.version, artifactSha256: candidate.packageDigest!, expectedCurrentAdoptionId: current.adoption?.id ?? null });
          setMessage("Version adopted. Installed copies change only when you update them.");
        })}><Check size={16} aria-hidden="true" />Adopt version</Button>}
      </div>}
    </div>}
    {error && <p role="alert" className="library-alert">{error}</p>}{message && <p role="status" className="library-status">{message}</p>}
  </article>;
}

function SkillEntry({ api, client, entry, canWrite, titleId, sourceEntry, onSelectEntry, onChanged, footer }: {
  api: LibraryClient; client: RegistryClient; entry: LibraryEntry; canWrite: boolean; titleId: string; sourceEntry?: LibraryEntry;
  onSelectEntry: (id: string) => void; onChanged: () => Promise<void>; footer: ReactNode;
}) {
  const [version, setVersion] = useState("");
  const [curatorNote, setCuratorNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [requiresAction, setRequiresAction] = useState<boolean | null>(null);
  const slug = entry.skill?.slug;
  const adoptedVersion = entry.adoption?.version;
  const artifactSha256 = entry.adoption?.artifactSha256;
  useEffect(() => {
    let active = true;
    setRequiresAction(null); setRelease(null);
    if (slug && adoptedVersion) void client.getRelease(slug, adoptedVersion).then((release) => {
      if (!active) return;
      if (release.artifact.sha256 !== artifactSha256) { setError("The adopted artifact is unavailable. Refresh and inspect the release before installing."); return; }
      setRelease(release);
      setRequiresAction(release.requiresUserAction === true);
    }).catch((e) => { if (active) setError(libraryError(e)); });
    return () => { active = false; };
  }, [client, slug, adoptedVersion, artifactSha256]);
  if (!entry.skill || !slug) return <header className="library-inspector-head"><div className="library-inspector-title"><h3 id={titleId} tabIndex={-1}>{entry.title}</h3></div></header>;
  async function adopt() {
    setBusy(true); setError(null);
    try {
      const release = await client.getRelease(slug!, version.trim());
      await api.adopt(entry.id, { version: version.trim(), artifactSha256: release.artifact.sha256, expectedCurrentAdoptionId: entry.adoption?.id ?? null, reason: curatorNote.trim() });
      await onChanged();
      setCuratorNote("");
    } catch (e) { setError(libraryError(e)); } finally { setBusy(false); }
  }
  const adoption = entry.adoption;
  const attestation = adoption ? attestationLabel(adoption.attestation) : null;
  const published = shortDate(release?.publishedAt);
  const platforms = release?.platforms?.map((platform) => platformLabel(platform.name)).filter(Boolean) ?? [];
  const adoptForm = <form className="library-form" onSubmit={(event) => { event.preventDefault(); void adopt(); }}>
    <label className="library-field"><span>Reviewed release version</span><Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.0.1" required /></label>
    <label className="library-field"><span>Curator note (optional)</span><Input value={curatorNote} onChange={(event) => setCuratorNote(event.target.value)} maxLength={500} /></label>
    <div className="library-form-actions"><Button size="sm" variant={adoption ? "outline" : "default"} disabled={busy || !version.trim()}>Adopt skill release</Button></div>
  </form>;
  return <>
    <header className="library-inspector-head">
      <Tile tone={tileTone(slug)} size={24} />
      <div className="library-inspector-title">
        <h3 id={titleId} tabIndex={-1}>{entry.title}</h3>
        <p><code>{slug}</code><a href={`/skills/${encodeURIComponent(slug)}`}>View in Skills</a></p>
      </div>
    </header>
    <dl className="library-facts">
      <Fact label="Library">{adoption ? <span className="library-fact-inline">
        <Chip tone="teal">Adopted {adoption.version}</Chip>
        {attestation && <Chip tone={attestation.tone}>{attestation.label}</Chip>}
        {shortDate(adoption.adoptedAt) && <span className="library-muted">{shortDate(adoption.adoptedAt)}</span>}
      </span> : <span className="library-muted">No version adopted</span>}</Fact>
      {adoption && <Fact label="Skills">{release ? <span className="library-fact-inline">
        {release.lifecycleStatus === "deprecated" ? <Chip tone="amber">Deprecated</Chip> : <Chip tone="teal">{published ? `Published ${published}` : "Published"}</Chip>}
        {platforms.length > 0 && <span className="library-muted">{platforms.join(" · ")}</span>}
      </span> : <span className="library-muted">{error ? "Release unavailable" : "Checking release…"}</span>}</Fact>}
      <Fact label="From">{sourceEntry ? <button type="button" className="library-link-button" onClick={() => onSelectEntry(sourceEntry.id)}><GitBranch size={12} aria-hidden="true" />{sourceEntry.source?.fullName ?? sourceEntry.title}</button>
        : entry.skill.sourceEntryId ? <span>A source in this library{entry.skill.sourcePath ? <> · <code>{entry.skill.sourcePath}</code></> : null}</span> : "Skills"}</Fact>
    </dl>
    {(release?.summary || release?.releaseNotes || adoption?.reason || !entry.skill.ownership?.isCaller) && <div className="library-section library-prose-block">
      {release?.summary && <p className="library-prose">{release.summary}</p>}
      {release?.releaseNotes && <details className="library-details"><summary>Release notes for {release.version ?? adoption?.version}</summary><p className="library-prose library-notes">{release.releaseNotes}</p></details>}
      {adoption?.reason && <p className="library-note">Curator note: {adoption.reason}</p>}
      {!entry.skill.ownership?.isCaller && <p className="library-muted">This skill remains owned by its contributor. Library membership does not transfer ownership or grant release access.</p>}
    </div>}
    {adoption && <section className="library-section" aria-labelledby={`${titleId}-install`}>
      <h4 id={`${titleId}-install`}>Install</h4>
      {requiresAction !== null ? <>
        {requiresAction && <p className="library-muted">Review this release's required actions before running the command. The flag records your explicit acceptance.</p>}
        <code className="library-command">{["myskills", "install", slug, "--library-entry", entry.id, ...(requiresAction ? ["--accept-user-action"] : [])].flatMap((argument, index) => [index ? " " : "", <span key={index}>{argument}</span>])}</code>
      </> : !error && <p className="library-muted">Checking the adopted artifact…</p>}
    </section>}
    {canWrite && !adoption && <section className="library-section" aria-labelledby={`${titleId}-adopt`}>
      <h4 id={`${titleId}-adopt`}>Adopt a skill release</h4>
      <p className="library-muted">Adoption records the reviewed version you recommend. Installed copies change only when you update them.</p>
      {adoptForm}
    </section>}
    {(adoption || footer) && <div className="library-section library-secondary-actions">
      {canWrite && adoption && <details className="library-details"><summary>Change adopted version</summary><div className="library-details-body">{adoptForm}</div></details>}
      {adoption && <details className="library-details" onToggle={(event) => setBindingsOpen(event.currentTarget.open)}>
        <summary>Connect an existing target</summary>
        {bindingsOpen && <div className="library-details-body"><TargetBindings api={api} entry={entry} /></div>}
      </details>}
      {footer && <div className="library-section-end">{footer}</div>}
    </div>}
    {error && <p role="alert" className="library-alert">{error}</p>}
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
  return <div className="library-bindings">
    <p className="library-muted">Choose a target you can manage. Its update policy will also require this adopted version. Changes require an MFA-verified session.</p>
    <form className="library-form library-form-row" onSubmit={(event) => { event.preventDefault(); void bind(false); }}>
      <label className="library-field library-grow"><span>Target ID</span><Input value={targetId} onChange={(event) => { setTargetId(event.target.value); setConflict(false); }} required /></label>
      <Button size="sm" disabled={busy || !targetId.trim()}>Bind target</Button>
    </form>
    {conflict && <div className="library-callout" data-tone="amber"><p>Replace the conflicting library bindings for {targetId} with this adoption? Installed files stay unchanged.</p><div className="library-actions"><Button size="sm" variant="outline" disabled={busy || !targetId.trim()} onClick={() => void bind(true)}>Replace conflicting binding</Button></div></div>}
    {bindings.filter((binding) => binding.status !== "detached").map((binding) => <div className="library-binding" key={binding.id}>
      <div className="library-binding-text"><strong>{binding.targetId}</strong><p className="library-muted">{bindingStatusLabel(binding.status).label} · {binding.pinnedVersion ?? "No adopted version"}</p></div>
      {confirmDetach === binding.id ? <div className="library-confirm"><p>Stop this target following this library entry?</p><div className="library-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void api.detach(binding.id).then(async () => { setConfirmDetach(null); await load(); setMessage("Binding detached. Installed files stay unchanged."); }).catch((e) => setError(libraryError(e))).finally(() => setBusy(false));
      }}>Confirm detach binding</Button><Button size="sm" variant="ghost" onClick={() => setConfirmDetach(null)}>Cancel</Button></div></div> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDetach(binding.id)}>Detach binding</Button>}
    </div>)}
    {message && <p role="status" className="library-status">{message}</p>}{error && <p role="alert" className="library-alert">{error}</p>}
  </div>;
}

function RemoveEntry({ api, entry, onChanged }: { api: LibraryClient; entry: LibraryEntry; onChanged: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  return <div className="library-remove">{confirm ? <div className="library-confirm"><p>Remove this entry? Installed files and skill releases stay intact.</p><div className="library-actions"><Button variant="destructive" size="sm" disabled={busy} onClick={() => { setBusy(true); void api.removeEntry(entry.id).then(() => onChanged()).catch((e) => setError(libraryError(e))).finally(() => setBusy(false)); }}>Confirm remove</Button><Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button></div></div> : <Button variant="ghost" size="sm" className="library-remove-button" onClick={() => setConfirm(true)}><Trash2 size={14} aria-hidden="true" />Remove entry</Button>}{error && <p role="alert" className="library-alert">{error}</p>}</div>;
}

function LibrarySettings({ api, mfaVerified }: { api: LibraryClient; mfaVerified: boolean }) {
  const [settings, setSettings] = useState<LibrarySettingsResponse | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const headingId = useId();
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
  return <section className="library-admin-panel" aria-labelledby={headingId}>
    <header><h2 id={headingId}>Private import policy</h2><p className="library-muted">Administrator setting for this instance.</p></header>
    <label className="library-switch-field"><input type="checkbox" className="library-switch-input" checked={pending ?? settings?.settings.privateSelfReviewEnabled ?? false} disabled={!settings || !mfaVerified || busy} onChange={(event) => { void save(event.target.checked); }} /><span>Allow private import self-review</span></label>
    {busy && <p role="status" className="library-muted">Saving policy…</p>}
    <p className="library-muted">Users may approve only their own private imports after a clean scan. Disabling stops new approvals; existing private copies remain available.</p>
    {!mfaVerified && <p className="library-muted">Verify MFA to change this setting.</p>}
    {error && <p role="alert" className="library-alert">{error}</p>}
  </section>;
}

function LibraryInbox({ api, onSelect }: { api: LibraryClient; onSelect: (id: string) => void }) {
  const [items, setItems] = useState<LibraryInboxItem[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => { let active = true; void api.inbox().then((value) => { if (active) { setItems(value.items); setCursor(value.nextCursor); setUnread(value.unreadCount ?? 0); } }).catch((e) => { if (active) setError(libraryError(e)); }); return () => { active = false; }; }, [api]);
  return <LibraryDisclosure label="Changes" ariaLabel={unread > 0 ? `Changes, ${unread} unread` : undefined} icon={<Bell size={16} aria-hidden="true" />} badge={unread > 0 ? <span className="library-count" aria-hidden="true">{unread}</span> : undefined}>
    {(close) => <div className="library-popover-body">
      <div><h2 className="library-popover-title">Changes</h2><p className="library-muted">Updates from libraries you follow.</p></div>
      {items.length === 0 ? <p className="library-muted">No notifications yet.</p> : <ul className="library-inbox">{items.map((item) => {
        const kind = eventLabel(item.kind);
        const fresh = !item.readAt;
        return <li key={item.id}><button type="button" className="library-inbox-item" onClick={() => { onSelect(item.libraryId); void api.markRead([item.id]).then(() => { setItems((current) => current.map((row) => row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row)); if (fresh) setUnread((count) => Math.max(0, count - 1)); }).catch((e) => setError(libraryError(e))); close(); }}>
          <span className="library-inbox-mark" data-state={fresh ? (item.kind === "candidate-ready" ? "change" : "unread") : "read"} aria-hidden="true" />
          <span className="library-inbox-text">
            <span className="library-inbox-title">{item.libraryName}</span>
            <span className="library-inbox-kind" data-tone={fresh && item.kind === "candidate-ready" ? "coral" : undefined}>{kind.label}{item.entryTitle ? ` · ${item.entryTitle}` : ""}{item.version ? ` ${item.version}` : ""}</span>
          </span>
          <span className="library-inbox-date">{fresh && <span className="sr-only">Unread, </span>}{shortDate(item.createdAt)}</span>
        </button></li>;
      })}</ul>}
      {cursor && <Button type="button" variant="outline" size="sm" onClick={() => void api.inbox(cursor).then((value) => { setItems((current) => [...current, ...value.items]); setCursor(value.nextCursor); }).catch((e) => setError(libraryError(e)))}>More notifications</Button>}
      {error && <p role="alert" className="library-alert">{error}</p>}
    </div>}
  </LibraryDisclosure>;
}
