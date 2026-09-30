import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Boxes, ChevronLeft, CircleAlert, List, ListTree, Plus, RotateCw, Search } from "lucide-react";
import type { BundleSummary, RegistryCatalogRow, RegistryView } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import type { BundleClient } from "../../bundle-api.js";
import type { LibraryClient } from "../../library-api.js";
import type { TeamDashboard } from "../../api.js";
import { useCatalog, useExpansion, useMemberPages, type CatalogState, type MemberPage } from "./BundleData.js";
import { BundleEditorDialog } from "./BundleEditorDialog.js";
import { BundleDetail, BundleLegend, BundleMemberships } from "./BundleInspector.js";
import { BundleSaveDialog, type SavedReference } from "./BundleSaveDialog.js";
import { DETAIL_HEADING, bundleKey, plural, revealsMembers, type Selection } from "./BundleUtils.js";
import { GroupedView, ListView, OutlineView, type CatalogViewProps } from "./BundleViews.js";

export type { Selection } from "./BundleUtils.js";

export interface BundleWorkspaceProps {
  api: BundleClient;
  libraries?: LibraryClient;
  listTeams?: () => Promise<TeamDashboard>;
  signedIn: boolean;
  canCreate: boolean;
  /** Workspace controls shown beside the page title (the Skills scope switch). */
  headerControls?: ReactNode;
  query: string;
  onClearQuery: () => void;
  onQueryChange: (query: string) => void;
  view: RegistryView;
  onViewChange: (view: RegistryView) => void;
  selection: Selection;
  skillHref: (slug: string) => string;
  bundleHref: (id: string) => string;
  onSelectSkill: (slug: string) => void;
  onSelectBundle: (id: string) => void;
  onClearSelection: () => void;
  /** The server has no catalog: the App falls back to the flat Skills list. */
  onUnavailable: () => void;
  /** Existing skill detail (release, export, trust panels), with a slot for bundle backlinks. */
  renderSkillDetail: (bundles: ReactNode) => ReactNode;
}

const VIEWS: Array<{ id: RegistryView; label: string; icon: ReactNode }> = [
  { id: "grouped", label: "Grouped", icon: <Boxes aria-hidden="true" size={15} /> },
  { id: "list", label: "List", icon: <List aria-hidden="true" size={15} /> },
  { id: "outline", label: "Outline", icon: <ListTree aria-hidden="true" size={15} /> },
];

type Dialog = { kind: "save"; bundle: BundleSummary } | { kind: "edit"; bundle: BundleSummary | null } | null;

/** Split when the workspace itself has room, not when the viewport does. */
function useContentLayout(ref: RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<"split" | "stack">(() => typeof window !== "undefined" && window.innerWidth >= 1180 ? "split" : "stack");
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setLayout(element.clientWidth >= 880 ? "split" : "stack");
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}

function focusHeading(element: HTMLElement) {
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus();
}

function hasOverlap(rows: RegistryCatalogRow[], pages: Record<string, MemberPage>) {
  if (rows.some((row) => row.kind === "skill" && row.memberships.length > 1)) return true;
  return Object.values(pages).some((page) => page.skills.some((member) => member.memberships.length > 1));
}

function Summary({ catalog, overlap }: { catalog: CatalogState; overlap: boolean }) {
  // After a failure or snapshot change, no totals are shown until a fresh read.
  if (catalog.status === "error" || catalog.status === "changed") return null;
  const settled = catalog.status === "ready" || catalog.rows.length > 0;
  if (!settled) return <>Loading the catalog…</>;
  if (catalog.query && catalog.totalSkills === 0 && catalog.totalBundles === 0) return <>No skills or bundles match “{catalog.query}”.</>;
  return (
    <>
      {catalog.query && <>Matches for “{catalog.query}”: </>}
      <strong>{plural(catalog.totalSkills, "unique skill")}</strong> · {plural(catalog.totalBundles, "bundle")}
      {overlap && ". Skills in more than one bundle are counted once."}
    </>
  );
}

export function BundleWorkspace(props: BundleWorkspaceProps) {
  const { api, selection } = props;
  const catalog = useCatalog(api, props.query, props.view, props.onUnavailable);
  const loaded = catalog.state;
  const members = useMemberPages(api, loaded.query, catalog.memberScope);
  const expansion = useExpansion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const layout = useContentLayout(bodyRef);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saved, setSaved] = useState<{ bundleId: string; message: string } | null>(null);
  const [detailReload, setDetailReload] = useState(0);
  const saveButton = useRef<HTMLButtonElement | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const dialogReturn = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<string | null>(null);
  const focusDetail = useRef(false);
  const selectionKey = selection ? (selection.kind === "skill" ? `skill:${selection.slug}` : `bundle:${selection.id}`) : "";
  const previousSelection = useRef(selectionKey);

  const { isOpen: expansionOpen, toggle, seed } = expansion;
  const isOpen = useCallback((key: string, reveal: boolean, fallback: boolean) => expansionOpen(key, loaded.query, reveal, fallback), [expansionOpen, loaded.query]);

  useEffect(() => {
    if (loaded.status !== "ready" || loaded.query || loaded.view === "list") return;
    const first = loaded.rows.find((row) => row.kind === "bundle");
    if (first?.kind === "bundle") seed(bundleKey(first.bundle.id));
  }, [loaded, seed]);

  // Members load lazily for open bundles only, and page separately from rows.
  useEffect(() => {
    if (loaded.view === "list" || loaded.status === "error") return;
    for (const row of loaded.rows) {
      if (row.kind !== "bundle") continue;
      const section = row.bundle.kind === "source" ? "top:source" : "top:curated";
      if (loaded.view === "outline" && !isOpen(section, false, true)) continue;
      if (isOpen(bundleKey(row.bundle.id), revealsMembers(row.bundle, loaded.query), false) && !members.pages[row.bundle.id]) members.load(row.bundle.id);
    }
  }, [isOpen, loaded, members]);

  // Focus follows the reader: into the detail on narrow layouts or when the
  // trigger lives inside the inspector, and back to the trigger afterwards.
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selectionKey;
    if (!selectionKey) {
      if (previous && layout === "stack") {
        const target = (returnFocus.current && document.getElementById(returnFocus.current)) || document.getElementById("skill-search");
        target?.focus();
      }
      return;
    }
    if (!focusDetail.current && !(layout === "stack" && previous !== selectionKey)) return;
    focusDetail.current = false;
    const root = inspectorRef.current;
    if (!root) return;
    const find = () => root.querySelector<HTMLElement>(`[${DETAIL_HEADING}]`) ?? root.querySelector<HTMLElement>("h2");
    const found = find();
    if (found) { focusHeading(found); return; }
    const observer = new MutationObserver(() => {
      const target = find();
      if (target) { observer.disconnect(); focusHeading(target); }
    });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 8000);
    return () => { observer.disconnect(); window.clearTimeout(timeout); };
  }, [selectionKey, layout]);

  useEffect(() => {
    if (dialog || !dialogReturn.current) return;
    const target = dialogReturn.current;
    dialogReturn.current = null;
    if (target.isConnected) target.focus();
  }, [dialog]);

  const noteOrigin = useCallback((from: HTMLElement) => {
    const inInspector = Boolean(inspectorRef.current?.contains(from));
    if (!inInspector && from.id) returnFocus.current = from.id;
    focusDetail.current = inInspector || layout === "stack";
  }, [layout]);

  const viewProps: CatalogViewProps = {
    rows: loaded.rows,
    query: loaded.query,
    members: members.pages,
    selection,
    isOpen,
    onToggle: (key, current) => toggle(key, loaded.query, current),
    onMoreMembers: (bundleId, cursor) => members.load(bundleId, cursor),
    onRetryMembers: members.retry,
    onRefreshCatalog: catalog.reload,
    skillHref: props.skillHref,
    bundleHref: props.bundleHref,
    onOpenSkill: (slug, from) => { noteOrigin(from); props.onSelectSkill(slug); },
    onOpenBundle: (id, from) => { noteOrigin(from); props.onSelectBundle(id); },
  };

  const back = layout === "stack" ? (
    <Button className="bundle-back" size="sm" type="button" variant="ghost" onClick={props.onClearSelection}>
      <ChevronLeft aria-hidden="true" size={16} />Back to skills
    </Button>
  ) : null;

  const inspector = selection?.kind === "bundle" ? (
    <BundleDetail
      api={api}
      back={back}
      bundleHref={props.bundleHref}
      bundleId={selection.id}
      canSave={props.signedIn && Boolean(props.libraries)}
      editRef={(element) => { editButton.current = element; }}
      key={selection.id}
      onAccessLost={catalog.reload}
      onEdit={(bundle) => { dialogReturn.current = editButton.current; setDialog({ kind: "edit", bundle }); }}
      onOpenBundle={viewProps.onOpenBundle}
      onOpenSkill={viewProps.onOpenSkill}
      onSave={(bundle) => { dialogReturn.current = saveButton.current; setDialog({ kind: "save", bundle }); }}
      reloadKey={detailReload}
      saveRef={(element) => { saveButton.current = element; }}
      savedMessage={saved?.bundleId === selection.id ? saved.message : null}
      skillHref={props.skillHref}
    />
  ) : selection?.kind === "skill" ? (
    <aside aria-label="Selected skill detail" className="bundle-inspector-panel is-skill registry-inspector">
      {back}
      {props.renderSkillDetail(<BundleMemberships api={api} bundleHref={props.bundleHref} onOpenBundle={viewProps.onOpenBundle} slug={selection.slug} />)}
    </aside>
  ) : layout === "split" ? <BundleLegend /> : null;

  const busy = loaded.status === "loading";
  const skillRows = loaded.rows.filter((row) => row.kind === "skill").length;
  const bundleRows = loaded.rows.length - skillRows;
  const empty = loaded.status === "ready" && loaded.rows.length === 0;

  function afterSaved(bundle: BundleSummary, reference: SavedReference) {
    setSaved({ bundleId: bundle.id, message: `${reference.replayed ? "Already saved" : "Saved"} to ${reference.libraryName} as a reference. Nothing was adopted, installed or set to follow updates.` });
    setDialog(null);
  }

  function afterEdited(bundle: BundleSummary, created: boolean) {
    setDialog(null);
    catalog.reload();
    if (created) {
      dialogReturn.current = null;
      focusDetail.current = true;
      props.onSelectBundle(bundle.id);
    } else {
      setDetailReload((value) => value + 1);
    }
  }

  return (
    <main aria-labelledby="registry-title" className="bundle-workspace registry-workspace">
      <header className="bundle-page-head">
        <h1 id="registry-title">Skills</h1>
        {props.headerControls}
        {props.canCreate && (
          <Button ref={newButton} size="sm" type="button" variant="outline" onClick={() => { dialogReturn.current = newButton.current; setDialog({ kind: "edit", bundle: null }); }}>
            <Plus aria-hidden="true" size={15} />New bundle
          </Button>
        )}
      </header>
      <div className="bundle-surface">
        <div className="bundle-toolbar">
          <label className="registry-search bundle-search" htmlFor="skill-search">
            <Search size={16} aria-hidden="true" />
            <input id="skill-search" aria-label="Search skills and bundles" value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search skills and bundles…" autoComplete="off" spellCheck={false} />
          </label>
          <p className="bundle-summary" role="status"><Summary catalog={loaded} overlap={hasOverlap(loaded.rows, members.pages)} /></p>
          <div aria-label="Catalog view" className="bundle-views" role="group">
            {VIEWS.map((item) => (
              <button aria-pressed={props.view === item.id} key={item.id} type="button" onClick={() => { if (props.view !== item.id) props.onViewChange(item.id); }}>
                {item.icon}{item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="bundle-body" data-inspector={selection?.kind ?? "legend"} data-layout={layout} ref={bodyRef}>
          <section aria-busy={busy} aria-label="Catalog results" className="bundle-results" hidden={layout === "stack" && Boolean(selection)}>
            {loaded.status === "error" && (
              <div className="bundle-state" role="alert">
                <CircleAlert aria-hidden="true" size={20} />
                <strong>The catalog couldn’t load.</strong>
                <span>{loaded.error}</span>
                <Button size="sm" type="button" variant="outline" onClick={catalog.reload}><RotateCw aria-hidden="true" size={14} />Retry catalog</Button>
              </div>
            )}
            {busy && loaded.rows.length === 0 && <div aria-hidden="true" className="bundle-skeleton"><span /><span /><span /><span /></div>}
            {empty && loaded.query && (
              <div className="bundle-state">
                <strong>Nothing matches “{loaded.query}”.</strong>
                <span>Search covers skill names, slugs and summaries, and bundle names, purposes and curators.</span>
                <Button size="sm" type="button" variant="outline" onClick={props.onClearQuery}>Clear search</Button>
              </div>
            )}
            {empty && !loaded.query && (
              <div className="bundle-state">
                <strong>No published skills yet.</strong>
                <span>Approved skills and bundles appear here after publication.</span>
              </div>
            )}
            {loaded.rows.length > 0 && (loaded.view === "list" ? <ListView {...viewProps} /> : loaded.view === "outline" ? <OutlineView {...viewProps} /> : <GroupedView {...viewProps} />)}
            {loaded.status !== "error" && loaded.nextCursor && (
              <div className="bundle-results-foot">
                <span>{loaded.view === "list" ? `Showing ${skillRows} of ${plural(loaded.totalSkills, "skill")}` : `Showing ${bundleRows} of ${plural(loaded.totalBundles, "bundle")}`}</span>
                <Button disabled={loaded.loadingMore || busy} size="sm" type="button" variant="outline" onClick={() => void catalog.loadMore()}>{loaded.loadingMore ? "Loading…" : "Load more results"}</Button>
              </div>
            )}
            {loaded.moreError && (
              <div className="bundle-inline-error" role="alert">
                <p>{loaded.moreError.message}</p>
                {loaded.moreError.changed && <Button size="sm" type="button" variant="outline" onClick={catalog.reload}>Refresh results</Button>}
              </div>
            )}
          </section>
          {inspector && <div className="bundle-inspector" ref={inspectorRef}>{inspector}</div>}
        </div>
      </div>
      {dialog?.kind === "save" && props.libraries && (
        <BundleSaveDialog api={api} bundle={dialog.bundle} libraries={props.libraries} onCancel={() => setDialog(null)} onSaved={(reference) => afterSaved(dialog.bundle, reference)} />
      )}
      {dialog?.kind === "edit" && (
        <BundleEditorDialog api={api} editing={dialog.bundle} listTeams={props.listTeams} onCancel={() => setDialog(null)} onSaved={(bundle) => afterEdited(bundle, dialog.bundle === null)} />
      )}
    </main>
  );
}
