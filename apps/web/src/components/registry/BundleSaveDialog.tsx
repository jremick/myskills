import { useCallback, useEffect, useRef, useState } from "react";
import type { BundleSummary, LibrarySummary } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { BundleClient } from "../../bundle-api.js";
import type { LibraryClient } from "../../library-api.js";
import { BundleModal } from "./BundleParts.js";
import { bundleError, errorStatus } from "./BundleUtils.js";

export interface SavedReference { libraryName: string; replayed: boolean }

interface LibraryPages {
  status: "loading" | "ready" | "error";
  /** Writable libraries from every page read so far. */
  items: LibrarySummary[];
  nextCursor: string | null;
  loadingMore: boolean;
  moreError: { message: string; restart: boolean } | null;
}

const LOADING: LibraryPages = { status: "loading", items: [], nextCursor: null, loadingMore: false, moreError: null };
const REPEATED = "The library list sent a page it had already sent, so loading stopped. Some libraries may not be listed. Retry libraries to start again.";

const writable = (libraries: LibrarySummary[]) => libraries.filter((library) => library.access.canWrite);

/** Saves a bundle reference into one writable library. It never adopts or installs. */
export function BundleSaveDialog({ api, libraries, bundle, onCancel, onSaved }: { api: BundleClient; libraries: LibraryClient; bundle: BundleSummary; onCancel: () => void; onSaved: (result: SavedReference) => void }) {
  const [pages, setPages] = useState<LibraryPages>(LOADING);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const seenCursors = useRef(new Set<string>());

  /** Accepts a cursor once. A repeated cursor ends paging and is reported. */
  const advance = useCallback((cursor: string | null) => {
    if (!cursor) return { next: null, repeated: false };
    if (seenCursors.current.has(cursor)) return { next: null, repeated: true };
    seenCursors.current.add(cursor);
    return { next: cursor, repeated: false };
  }, []);

  useEffect(() => {
    const ticket = ++epoch.current;
    seenCursors.current = new Set();
    setPages(LOADING);
    libraries.list().then((result) => {
      if (ticket !== epoch.current) return;
      const items = writable(result.libraries);
      const { next, repeated } = advance(result.nextCursor);
      setPages({ status: "ready", items, nextCursor: next, loadingMore: false, moreError: repeated ? { message: REPEATED, restart: true } : null });
      setChoice((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
    }, () => { if (ticket === epoch.current) setPages({ ...LOADING, status: "error" }); });
    return () => { epoch.current++; };
  }, [advance, libraries, reload]);

  const loadMore = useCallback(async () => {
    const cursor = pages.nextCursor;
    if (!cursor || pages.loadingMore) return;
    const ticket = epoch.current;
    setPages((current) => ({ ...current, loadingMore: true, moreError: null }));
    try {
      const result = await libraries.list(cursor);
      if (ticket !== epoch.current) return;
      const added = writable(result.libraries);
      const { next, repeated } = advance(result.nextCursor);
      setPages((current) => ({
        ...current,
        items: [...new Map([...current.items, ...added].map((item) => [item.id, item])).values()],
        nextCursor: next,
        loadingMore: false,
        moreError: repeated ? { message: REPEATED, restart: true } : null,
      }));
      setChoice((current) => current ?? added[0]?.id ?? null);
    } catch {
      if (ticket === epoch.current) setPages((current) => ({ ...current, loadingMore: false, moreError: { message: "More libraries couldn’t load. Try again.", restart: false } }));
    }
  }, [advance, libraries, pages.loadingMore, pages.nextCursor]);

  const save = useCallback(async () => {
    const library = pages.items.find((item) => item.id === choice);
    if (!library || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.save(bundle.id, { libraryId: library.id, expectedRevision: bundle.revision });
      onSaved({ libraryName: library.name, replayed: result.replayed });
    } catch (caught) {
      setError(errorStatus(caught) === 409
        ? "This bundle changed since you opened it. Close this dialog and review the current bundle before saving."
        : bundleError(caught, "The reference couldn’t be saved. Try again."));
      setBusy(false);
    }
  }, [api, bundle.id, bundle.revision, busy, choice, onSaved, pages.items]);

  const titleId = "bundle-save-title";
  const ready = pages.status === "ready";
  return (
    <BundleModal describedBy="bundle-save-description" labelledBy={titleId} onCancel={onCancel}>
      <form className="bundle-dialog-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <h2 id={titleId}>Save “{bundle.name}” to a library</h2>
        <p className="bundle-muted" id="bundle-save-description">Adds this bundle as a reference so its skills stay grouped with their purpose.</p>
        {pages.status === "loading" && <p className="bundle-muted" role="status">Loading your libraries…</p>}
        {pages.status === "error" && (
          <div className="bundle-dialog-state" role="alert">
            <p>Your libraries couldn’t load.</p>
            <Button size="sm" type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>Retry libraries</Button>
          </div>
        )}
        {ready && pages.items.length === 0 && !pages.nextCursor && !pages.moreError && (
          <p className="bundle-dialog-state">You don’t have a library you can add to. <a href="/libraries">Create one in Libraries</a> first.</p>
        )}
        {ready && pages.items.length === 0 && pages.nextCursor && (
          <p className="bundle-dialog-state">None of the libraries loaded so far can be changed by you. Load more to keep looking.</p>
        )}
        {ready && pages.items.length > 0 && (
          <fieldset className="bundle-fieldset">
            <legend>Library</legend>
            {pages.items.map((library) => (
              <label className="bundle-option" key={library.id}>
                <input checked={choice === library.id} disabled={busy} name="bundle-save-library" type="radio" value={library.id} onChange={() => { setChoice(library.id); setError(null); }} />
                <span>{library.name} <small>{library.owner.type === "team" ? "Team library" : "Personal library"}</small></span>
              </label>
            ))}
          </fieldset>
        )}
        {ready && pages.nextCursor && (
          <div className="bundle-dialog-state">
            <p className="bundle-muted">You may have more libraries that you can change.</p>
            <Button disabled={pages.loadingMore || busy} size="sm" type="button" variant="outline" onClick={() => void loadMore()}>{pages.loadingMore ? "Loading…" : "Load more libraries"}</Button>
          </div>
        )}
        {pages.moreError && (
          <div className="bundle-inline-error" role="alert">
            <p>{pages.moreError.message}</p>
            {pages.moreError.restart && <Button size="sm" type="button" variant="outline" onClick={() => setReload((value) => value + 1)}>Retry libraries</Button>}
          </div>
        )}
        <p className="bundle-dialog-note">Saving does not adopt, install or follow updates. People in a shared library only see skills they already have access to.</p>
        {error && <p className="bundle-inline-error" role="alert">{error}</p>}
        <div className="bundle-dialog-actions">
          <Button disabled={busy} type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={busy || !choice || !ready} type="submit">{busy ? "Saving…" : "Save reference"}</Button>
        </div>
      </form>
    </BundleModal>
  );
}
