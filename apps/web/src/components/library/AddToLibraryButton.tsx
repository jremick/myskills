import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert, Plus } from "lucide-react";
import type { LibrarySummary } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { RegistryClient } from "../../api.js";
import { libraryError, type LibraryClient } from "../../library-api.js";
import { roleLabel } from "./library-display.js";
import { findSkillEntry, librariesUrl, MAX_PAGES } from "./library-location.js";

interface LibraryList {
  status: "loading" | "ready" | "error";
  /** Writable libraries from every page read so far. */
  items: LibrarySummary[];
  loading: boolean;
  /** Cursor of the page that failed; retry continues from it. */
  failedCursor: string | null;
  message: string | null;
}

type Outcome =
  | { kind: "saved"; library: LibrarySummary; entryId: string; looking: false }
  | { kind: "duplicate"; library: LibrarySummary; entryId: string | null; looking: boolean };

const START: LibraryList = { status: "loading", items: [], loading: true, failedCursor: null, message: null };
const RETRY_SAVE = "Saving didn’t finish. Try again. A retry won’t add a second copy.";
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";

/** Saves a reference to one exact skill in a writable library. It never adopts, installs or follows. */
export function AddToLibraryButton({ client, slug, title }: { client: RegistryClient; slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!client.libraries) return null;
  return <>
    <Button ref={trigger} type="button" size="sm" variant="outline" aria-haspopup="dialog" onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add to library</Button>
    {open && <SaveDialog key={slug} api={client.libraries} slug={slug} title={title} onClose={() => setOpen(false)} />}
  </>;
}

function SaveDialog({ api, slug, title, onClose }: { api: LibraryClient; slug: string; title: string; onClose: () => void }) {
  const [list, setList] = useState<LibraryList>(START);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const alive = useRef(true);
  const started = useRef(false);
  const busyRef = useRef(false);
  // One mutation ID per chosen library, kept across retries so a lost response replays.
  const mutation = useRef<{ libraryId: string; id: string } | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const noteId = `${baseId}-note`;

  /** Reads every library page from `cursor`, keeping writable libraries only. */
  const loadFrom = useCallback(async (cursor: string | null, kept: LibrarySummary[]) => {
    const ticket = ++epoch.current;
    const seen = new Set<string>();
    let items = kept;
    let next = cursor;
    setList((current) => ({ ...current, status: kept.length || cursor ? "ready" : "loading", loading: true, failedCursor: null, message: null }));
    try {
      for (let page = 0; ; page++) {
        const result = await api.list(next ?? undefined);
        if (ticket !== epoch.current || !alive.current) return;
        const added = result.libraries.filter((library) => library.access.canWrite);
        items = [...new Map([...items, ...added].map((library) => [library.id, library])).values()];
        const following = result.nextCursor;
        if (following && (seen.has(following) || page + 1 >= MAX_PAGES)) {
          setList({ status: "ready", items, loading: false, failedCursor: null, message: "The library list stopped before its end. Some libraries may be missing." });
          return;
        }
        if (following) seen.add(following);
        next = following;
        setList({ status: "ready", items, loading: Boolean(next), failedCursor: null, message: null });
        if (!next) return;
      }
    } catch (caught) {
      if (ticket !== epoch.current || !alive.current) return;
      const first = next === null && items.length === 0;
      setList({
        status: first ? "error" : "ready",
        items,
        loading: false,
        failedCursor: first ? null : next,
        message: first
          ? errorCode(caught) === "LIBRARY_SERVICE_UNAVAILABLE" ? libraryError(caught) : "Your libraries couldn’t load."
          : "Some libraries couldn’t load. Retry to continue the list.",
      });
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    headingRef.current?.focus();
    // One opening reads the list once. A development remount of the same
    // dialog keeps that read instead of discarding it and starting another.
    if (!started.current) { started.current = true; void loadFrom(null, []); }
    return () => {
      alive.current = false;
      if (dialog?.open) dialog.close();
    };
  }, [loadFrom]);

  useEffect(() => { if (outcome && !outcome.looking) outcomeRef.current?.focus(); }, [outcome]);

  async function save() {
    const library = list.items.find((item) => item.id === choice);
    if (!library || busyRef.current) return;
    if (mutation.current?.libraryId !== library.id) mutation.current = { libraryId: library.id, id: crypto.randomUUID() };
    busyRef.current = true;
    setBusy(true); setError(null); setOutcome(null);
    try {
      const result = await api.addSkill(library.id, slug, mutation.current.id);
      if (alive.current) setOutcome({ kind: "saved", library, entryId: result.entry.id, looking: false });
    } catch (caught) {
      if (!alive.current) return;
      const code = errorCode(caught);
      if (code === "LIBRARY_ENTRY_DUPLICATE") {
        // The client does not expose the server's entry ID here, so find the
        // existing reference by reading the library. Never repeat the save.
        setOutcome({ kind: "duplicate", library, entryId: null, looking: true });
        const entryId = await findSkillEntry(api, library.id, slug);
        if (alive.current) setOutcome({ kind: "duplicate", library, entryId, looking: false });
      } else if (code === "LIBRARY_RELEASE_NOT_AUTHORIZED") {
        setError(`${library.name} can’t use this skill yet. Share it with the team first.`);
      } else if (code === "SKILL_NOT_FOUND") {
        setError("This skill is unavailable or you no longer have access.");
      } else {
        const message = libraryError(caught);
        setError(message === libraryError(null) ? RETRY_SAVE : message);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const ready = list.status === "ready";
  const chosen = list.items.find((item) => item.id === choice) ?? null;
  const settled = outcome && !outcome.looking;
  const alreadyDone = Boolean(settled && chosen && outcome?.library.id === chosen.id);
  return <dialog
    ref={dialogRef}
    className="library-save-dialog"
    aria-labelledby={titleId}
    aria-describedby={noteId}
    onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}
  >
    <form className="library-save-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header className="library-save-head">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>Add “{title}” to a library</h2>
        <p className="library-muted"><code>{slug}</code></p>
      </header>
      {list.status === "loading" && <p role="status" className="library-muted">Loading your libraries…</p>}
      {list.message && <div role="alert" className="library-alert library-save-state">
        <p>{list.message}</p>
        <Button type="button" size="sm" variant="outline" disabled={list.loading} onClick={() => void loadFrom(list.failedCursor, list.failedCursor ? list.items : [])}>Retry libraries</Button>
      </div>}
      {ready && list.items.length === 0 && !list.loading && !list.message && <p className="library-save-state">
        You don’t have a library you can add to. <a href="/libraries">Create one in Libraries</a>
      </p>}
      {list.items.length > 0 && <fieldset className="library-save-options" disabled={busy}>
        <legend>Library</legend>
        {list.items.map((library) => <label key={library.id} className="library-save-option">
          <input type="radio" name={`${baseId}-library`} value={library.id} checked={choice === library.id} onChange={() => { setChoice(library.id); setError(null); }} />
          <span className="library-save-option-text">
            <span className="library-save-option-name">{library.name}</span>{" "}
            <small>{library.owner.type === "team" ? `Team library · ${roleLabel(library.access.role)}` : "Personal library"}</small>
          </span>
        </label>)}
      </fieldset>}
      {ready && list.loading && list.items.length > 0 && <p role="status" className="library-muted">Loading more libraries…</p>}
      <p id={noteId} className="library-muted">Saving adds a reference only. It does not adopt, install or follow updates.</p>
      {error && <p role="alert" className="library-alert"><CircleAlert size={14} aria-hidden="true" /> {error}</p>}
      {outcome && <div ref={outcomeRef} role="status" tabIndex={-1} className="library-save-outcome">
        {outcome.kind === "saved" ? <>
          <p><Check size={16} aria-hidden="true" />Saved to {outcome.library.name}.</p>
          <a href={librariesUrl({ library: outcome.library.id, entry: outcome.entryId })}>Open in {outcome.library.name}</a>
        </> : <>
          <p><Check size={16} aria-hidden="true" />Already saved in {outcome.library.name}.{outcome.looking ? " Finding the saved entry…" : outcome.entryId ? "" : " The saved entry isn’t visible to you, so the link opens the library."}</p>
          {!outcome.looking && <a href={librariesUrl({ library: outcome.library.id, entry: outcome.entryId })}>Open in {outcome.library.name}</a>}
        </>}
      </div>}
      <div className="library-save-actions">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>{settled ? "Done" : "Cancel"}</Button>
        <Button type="submit" size="sm" disabled={busy || !chosen || alreadyDone}>{busy && !outcome ? "Saving…" : "Save to library"}</Button>
      </div>
    </form>
  </dialog>;
}
