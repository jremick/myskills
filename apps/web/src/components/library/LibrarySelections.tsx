import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { LibraryCollectionSummary, LibraryEntry, LibraryGroupSummary, LibrarySelectionMember, LibrarySummary } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { libraryError, type LibraryClient, type LibrarySelectionInput, type LibrarySelectionUpdate } from "../../library-api.js";
import { dateTime, healthLabel } from "./library-display.js";

type Kind = "collections" | "groups";
type Selection = LibraryCollectionSummary | LibraryGroupSummary;
const singular = (kind: Kind) => kind === "collections" ? "collection" : "group";
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()];

// Normalize the two independent resources only at the presentation boundary.
function selectionClient(api: LibraryClient, kind: Kind) {
  return {
    list: async (libraryId: string, cursor?: string): Promise<{ items: Selection[]; nextCursor: string | null }> => kind === "collections" ? api.collections(libraryId, cursor).then(({ collections, nextCursor }) => ({ items: collections, nextCursor })) : api.groups(libraryId, cursor).then(({ groups, nextCursor }) => ({ items: groups, nextCursor })),
    get: async (id: string): Promise<Selection> => kind === "collections" ? (await api.collection(id)).collection : (await api.group(id)).group,
    create: async (id: string, input: LibrarySelectionInput): Promise<Selection> => kind === "collections" ? (await api.createCollection(id, input)).collection : (await api.createGroup(id, input)).group,
    update: async (id: string, input: LibrarySelectionUpdate): Promise<Selection> => kind === "collections" ? (await api.updateCollection(id, input)).collection : (await api.updateGroup(id, input)).group,
    remove: (id: string, revision: number) => kind === "collections" ? api.removeCollection(id, revision) : api.removeGroup(id, revision),
    members: (id: string, cursor?: string) => kind === "collections" ? api.collectionMembers(id, cursor) : api.groupMembers(id, cursor),
  };
}
type SelectionClient = ReturnType<typeof selectionClient>;

export function LibrarySelections({ api, library, kind, selectedId, onSelect, onEntry, onRefreshLibrary }: {
  api: LibraryClient; library: LibrarySummary; kind: Kind; selectedId: string | null;
  onSelect: (id: string | null) => void; onEntry: (id: string) => void; onRefreshLibrary: () => Promise<void>;
}) {
  const client = useMemo(() => selectionClient(api, kind), [api, kind]);
  return selectedId ? <SelectionDetail api={api} client={client} library={library} kind={kind} selectionId={selectedId} onBack={() => onSelect(null)} onEntry={onEntry} onRefreshLibrary={onRefreshLibrary} />
    : <SelectionList api={api} client={client} library={library} kind={kind} onSelect={onSelect} />;
}

function SelectionList({ api, client, library, kind, onSelect }: { api: LibraryClient; client: SelectionClient; library: LibrarySummary; kind: Kind; onSelect: (id: string) => void }) {
  const [items, setItems] = useState<Selection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [canWrite, setCanWrite] = useState(library.access.canWrite);
  const epoch = useRef(0);
  const noun = singular(kind);
  const writable = library.access.canWrite && canWrite;
  const load = useCallback(async (next?: string) => {
    const ticket = ++epoch.current;
    setLoading(true); setError(null);
    try {
      const [result, detail] = await Promise.all([client.list(library.id, next), api.get(library.id)]);
      if (ticket !== epoch.current) return;
      setCanWrite(detail.library.access.canWrite);
      setItems((current) => next ? unique([...current, ...result.items]) : result.items); setCursor(result.nextCursor);
    } catch (e) { if (ticket === epoch.current) { setError(libraryError(e)); if (!next || errorCode(e).endsWith("_NOT_FOUND")) { setItems([]); setCursor(null); setCanWrite(false); } } }
    finally { if (ticket === epoch.current) setLoading(false); }
  }, [api, client, library.id]);
  useEffect(() => { void load(); return () => { epoch.current++; }; }, [load]);
  return <section className="library-selection-workspace" aria-label={kind === "collections" ? "Collections" : "Groups"}>
    <header className="library-selection-heading">
      <div><h3>{kind === "collections" ? "Collections" : "Groups"}</h3><p className="library-muted">{kind === "collections" ? "Keep selected skills together and follow changes from their sources." : "Organize related skills. A skill can belong to more than one group."}</p></div>
      <div className="library-actions"><Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />Refresh {kind}</Button>{writable && !creating && <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" />New {noun}</Button>}</div>
    </header>
    {error && <p role="alert" className="library-alert">{error}</p>}
    {creating && writable ? <SelectionEditor api={api} libraryId={library.id} kind={kind} onCancel={() => setCreating(false)} onFailure={(e) => { if (errorCode(e) === "LIBRARY_WRITE_FORBIDDEN") { setCanWrite(false); setCreating(false); setError(libraryError(e)); } }} onSave={async (input) => { const saved = await client.create(library.id, input); return saved.id; }} onSaved={onSelect} /> : <>
      {loading && items.length === 0 ? <p role="status" className="library-muted">Loading {kind}…</p> : !error && items.length === 0 ? <p className="library-muted">No {kind} yet.{writable ? ` Create a ${noun} from skills already in this library.` : " A library curator can create one."}</p> : null}
      <ul className="library-selection-list">{items.map((item) => <li key={item.id}><button type="button" className="library-selection-row" aria-label={`View ${item.name}`} onClick={() => onSelect(item.id)}><span><strong>{item.name}</strong>{item.description && <span className="library-muted">{item.description}</span>}</span><span className="library-muted">{item.memberCount} {item.memberCount === 1 ? "skill" : "skills"}</span></button></li>)}</ul>
      {cursor && <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(cursor)}>Load more {kind}</Button>}
    </>}
  </section>;
}

function SelectionDetail({ api, client, library, kind, selectionId, onBack, onEntry, onRefreshLibrary }: {
  api: LibraryClient; client: SelectionClient; library: LibrarySummary; kind: Kind; selectionId: string;
  onBack: () => void; onEntry: (id: string) => void; onRefreshLibrary: () => Promise<void>;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [members, setMembers] = useState<LibrarySelectionMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sources, setSources] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LibraryEntry[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [canWrite, setCanWrite] = useState(library.access.canWrite);
  const [blocked, setBlocked] = useState(false);
  const epoch = useRef(0);
  const noun = singular(kind);
  const load = useCallback(async () => {
    const ticket = ++epoch.current;
    setLoading(true); setError(null); setSelection(null); setMembers([]); setSources([]); setEditing(null); setBlocked(false);
    try {
      const [item, page, detail] = await Promise.all([client.get(selectionId), client.members(selectionId), api.get(library.id)]);
      if (ticket !== epoch.current) return;
      if (item.libraryId !== library.id) { setError(libraryError({ code: `LIBRARY_${singular(kind).toUpperCase()}_NOT_FOUND` })); return; }
      setSelection(item); setMembers(page.members); setCursor(page.nextCursor); setCanWrite(detail.library.access.canWrite);
      if ("tracking" in item) {
        const sourceReads = await Promise.allSettled(item.tracking.sourceEntryIds.map((id) => api.entry(id)));
        if (ticket === epoch.current) setSources(sourceReads.flatMap((result) => result.status === "fulfilled" && result.value.entry.libraryId === library.id && result.value.entry.kind === "source" ? [result.value.entry] : []));
      }
    } catch (e) { if (ticket === epoch.current) setError(libraryError(e)); }
    finally { if (ticket === epoch.current) setLoading(false); }
  }, [api, client, kind, library.id, selectionId]);
  useEffect(() => { void load(); return () => { epoch.current++; }; }, [load]);
  async function more() {
    if (!cursor) return;
    const ticket = epoch.current;
    setLoading(true); setError(null);
    try {
      const page = await client.members(selectionId, cursor);
      if (ticket !== epoch.current) return;
      setMembers((current) => [...new Map([...current, ...page.members].map((member) => [member.entry.id, member])).values()]); setCursor(page.nextCursor);
    } catch (e) { if (ticket === epoch.current) { setError(libraryError(e)); if (errorCode(e).endsWith("_NOT_FOUND")) { setSelection(null); setMembers([]); setSources([]); } } }
    finally { if (ticket === epoch.current) setLoading(false); }
  }
  async function edit() {
    const ticket = epoch.current;
    setLoading(true); setError(null);
    try {
      // Replacement must contain every member, including unloaded member pages.
      const all = [...members];
      const seen = new Set<string>();
      let next = cursor;
      while (next) {
        if (seen.has(next) || all.length > 200) throw new Error("Invalid member pages");
        seen.add(next);
        const page = await client.members(selectionId, next);
        if (ticket !== epoch.current) return;
        all.push(...page.members); next = page.nextCursor;
      }
      if (ticket === epoch.current) setEditing(all.map((member) => member.entry));
    } catch (e) { if (ticket === epoch.current) setError(libraryError(e)); }
    finally { if (ticket === epoch.current) setLoading(false); }
  }
  const writable = library.access.canWrite && canWrite;
  function failed(e: unknown) {
    if (errorCode(e).endsWith("_REVISION_CONFLICT") || errorCode(e) === "LIBRARY_SELECTION_MEMBER_INVALID") setBlocked(true);
    if (errorCode(e) === "LIBRARY_WRITE_FORBIDDEN") { setCanWrite(false); setEditing(null); }
  }
  return <section className="library-selection-workspace" aria-label={`${noun} details`}>
    <div className="library-selection-heading"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />Back to {kind}</Button><Button variant="ghost" size="sm" disabled={loading} onClick={() => { void load(); void onRefreshLibrary().catch(() => {}); }}><RefreshCw size={14} aria-hidden="true" />Refresh {noun}</Button></div>
    {error && <p role="alert" className="library-alert">{error}</p>}
    {selection ? <>
      <header className="library-selection-heading"><div><h3>{selection.name}</h3>{selection.description && <p className="library-muted">{selection.description}</p>}<p className="library-muted">{selection.memberCount} {selection.memberCount === 1 ? "skill" : "skills"}</p></div>{writable && !editing && <div className="library-actions"><Button size="sm" variant="outline" disabled={loading || blocked} onClick={() => void edit()}>Edit {noun}</Button><Button size="sm" variant="ghost" disabled={loading || blocked} onClick={() => setDeleting(true)}><Trash2 size={14} aria-hidden="true" />Delete {noun}</Button></div>}</header>
      {editing && writable ? <SelectionEditor key={selection.revision} api={api} libraryId={library.id} kind={kind} selection={selection} initialMembers={editing} blocked={blocked} onCancel={() => setEditing(null)} onFailure={failed} onSave={async (input) => { await client.update(selectionId, { expectedRevision: selection.revision, name: input.name, description: input.description ?? "", memberEntryIds: input.memberEntryIds }); return selectionId; }} onSaved={() => void load()} /> : <>
        {"tracking" in selection && <section className="library-selection-tracking" aria-label="Collection tracking"><h4>Source tracking</h4><div className="library-actions"><span className="library-chip">{selection.tracking.health === "mixed" ? "Mixed source health" : healthLabel(selection.tracking.health).label}</span>{writable && <span className="library-muted">{selection.tracking.pendingCandidateCount} pending changes</span>}</div><p className="library-muted">Last successful check: {dateTime(selection.tracking.lastSuccessfulCheckAt)} · Next check: {dateTime(selection.tracking.nextCheckAt)}</p>{sources.map((entry) => <button type="button" className="library-link-button" key={entry.id} aria-label={`View source: ${entry.source?.fullName ?? entry.title}`} onClick={() => onEntry(entry.id)}>{entry.source?.fullName ?? entry.title}</button>)}{selection.tracking.sourceEntryIds.length === 0 && <p className="library-muted">These skills have no readable tracked source.</p>}{writable && sources.length > 0 && <p className="library-muted">Open a source to check for changes or review its candidates.</p>}</section>}
        <section aria-label="Members"><h4>Skills</h4>{members.length === 0 && <p className="library-muted">No skills in this {noun}.</p>}<ul className="library-selection-list">{members.map(({ entry }) => <li key={entry.id}><button type="button" className="library-selection-row" aria-label={`View ${entry.title}`} onClick={() => onEntry(entry.id)}><strong>{entry.title}</strong><span className="library-muted">{entry.adoption ? `Adopted ${entry.adoption.version}` : "No version adopted"}</span></button></li>)}</ul>{cursor && <Button variant="outline" size="sm" disabled={loading} onClick={() => void more()}>Load more members</Button>}</section>
      </>}
      {deleting && <ConfirmationDialog onClose={() => setDeleting(false)} request={{ key: `delete-${selectionId}`, title: `Delete ${selection.name}?`, description: `This deletes only the ${noun}. Skills, source tracking, adopted versions and installed copies stay unchanged.`, confirmLabel: `Delete ${noun}`, destructive: true, onConfirm: async () => { try { await client.remove(selectionId, selection.revision); onBack(); } catch (e) { failed(e); setDeleting(false); setError(libraryError(e)); } } }} />}
    </> : loading ? <p role="status" className="library-muted">Loading {noun}…</p> : null}
  </section>;
}

function SelectionEditor({ api, libraryId, kind, selection, initialMembers = [], blocked = false, onSave, onSaved, onCancel, onFailure }: {
  api: LibraryClient; libraryId: string; kind: Kind; selection?: Selection; initialMembers?: LibraryEntry[]; blocked?: boolean;
  onSave: (input: LibrarySelectionInput) => Promise<string>; onSaved: (id: string) => void; onCancel: () => void; onFailure?: (error: unknown) => void;
}) {
  const [name, setName] = useState(selection?.name ?? "");
  const [description, setDescription] = useState(selection?.description ?? "");
  const [selected, setSelected] = useState<string[]>(initialMembers.map((entry) => entry.id));
  const [entries, setEntries] = useState<LibraryEntry[]>(initialMembers);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const epoch = useRef(0);
  const mounted = useRef(true);
  const noun = singular(kind);
  const load = useCallback(async (next?: string) => {
    const ticket = ++epoch.current;
    setLoading(true); setError(null);
    try {
      const page = await api.entries(libraryId, next);
      if (ticket !== epoch.current) return;
      setEntries((current) => unique([...current, ...page.entries.filter((entry) => entry.kind === "skill" && entry.status === "active")])); setCursor(page.nextCursor); setLoaded(true);
    } catch (e) { if (ticket === epoch.current) setError(libraryError(e)); }
    finally { if (ticket === epoch.current) setLoading(false); }
  }, [api, libraryId]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; epoch.current++; }; }, [load]);
  const changed = () => { key.current = crypto.randomUUID(); };
  async function save() {
    if (busy || blocked || !loaded) return;
    setBusy(true); setError(null);
    try {
      const id = await onSave({ name: name.trim(), description: description.trim(), memberEntryIds: selected, clientMutationId: key.current });
      if (mounted.current) onSaved(id);
    } catch (e) { if (mounted.current) { setError(libraryError(e)); onFailure?.(e); } }
    finally { if (mounted.current) setBusy(false); }
  }
  const visible = entries.filter((entry) => !query.trim() || [entry.title, entry.skill?.slug].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase())));
  return <form className="library-selection-editor library-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={selection ? `Edit ${noun}` : `New ${noun}`}>
    <label className="library-field"><span>{kind === "collections" ? "Collection name" : "Group name"}</span><Input autoFocus value={name} maxLength={120} required disabled={busy} onChange={(event) => { setName(event.target.value); changed(); }} /></label>
    <label className="library-field"><span>Description</span><Textarea value={description} maxLength={2000} disabled={busy} onChange={(event) => { setDescription(event.target.value); changed(); }} /></label>
    <fieldset disabled={busy || blocked}><legend>Choose skills</legend><p className="library-muted">{selected.length} selected</p><label className="library-field"><span>Filter loaded skills</span><Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label><div className="library-selection-picker">{visible.map((entry) => <label className="library-selection-choice" key={entry.id}><input type="checkbox" aria-label={`Select ${entry.title}`} checked={selected.includes(entry.id)} disabled={!selected.includes(entry.id) && selected.length >= 200} onChange={(event) => { const checked = event.target.checked; setSelected((current) => checked ? [...current, entry.id] : current.filter((id) => id !== entry.id)); changed(); }} /><span><strong>{entry.title}</strong><span className="library-muted">{entry.skill?.slug}</span></span></label>)}</div>{!loading && visible.length === 0 && <p className="library-muted">{query ? "No loaded skills match this filter." : "No skills available in this library."}</p>}{loading && <p role="status" className="library-muted">Loading skills…</p>}{cursor && <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load(cursor)}>Load more skills</Button>}{!loaded && !loading && <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Retry loading skills</Button>}</fieldset>
    {error && <p role="alert" className="library-alert">{error}</p>}
    <div className="library-actions"><Button disabled={busy || loading || blocked || !loaded || !name.trim()}>{selection ? "Save" : "Create"} {noun}</Button><Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </form>;
}
