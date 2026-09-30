import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  FileText,
  Focus,
  List,
  ListTree,
  MapIcon,
  Pencil,
  Search,
  SearchX,
  Workflow,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ArchitecturePreview } from "../../api.js";
import { ArchitectureExplorerMap } from "./ArchitectureExplorerMap.js";
import { packageVisibilityLabel } from "./architecture-dashboard-helpers.js";
import {
  architectureExplorerAncestorIds,
  architectureExplorerExpandableIds,
  architectureExplorerExposure,
  architectureExplorerHighlight,
  architectureExplorerInitialExpandedIds,
  architectureExplorerModel,
  architectureExplorerPlural,
  architectureExplorerVisibleIds,
  searchArchitectureExplorer,
  type ArchitectureExplorerFilter,
  type ArchitectureExplorerModel,
  type ArchitectureExplorerNode,
  type ArchitectureExplorerSearchResult,
} from "./architecture-explorer-model.js";

export type ArchitectureExplorerView = "list" | "map";

export interface ArchitectureExplorerProps {
  /** Exact server preview projection (safe projection for organization readers). */
  preview: ArchitecturePreview;
  /** Controlled selection; unknown ids are ignored (treated as no selection). */
  selectedNodeId?: string | null;
  onSelectNode?: (id: string) => void;
  /** Controlled view; defaults to internal state starting at "list". */
  view?: ArchitectureExplorerView;
  onViewChange?: (view: ArchitectureExplorerView) => void;
  /** Present only for authorized owners; renders "Edit in Workbench" in inspector. */
  onEditNode?: (id: string) => void;
  /** Optional display label of the selected profile/environment context, e.g. "Default profile · Production". */
  contextLabel?: string;
}

type ExplorerLayout = "split" | "stack";

// Below this measured explorer width the inspector becomes a closable sheet.
const STACK_BELOW_WIDTH = 660;
const SEARCH_MAX_LENGTH = 200;

/** Measures the explorer itself (not the viewport), like the other workspaces. */
function useExplorerLayout(): [ExplorerLayout, (node: HTMLElement | null) => void] {
  const [layout, setLayout] = useState<ExplorerLayout>("split");
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    // A surface without layout (width 0, as in DOM tests) keeps the split.
    const apply = (width: number) => setLayout(width === 0 || width >= STACK_BELOW_WIDTH ? "split" : "stack");
    apply(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.contentRect.width);
    });
    observer.current.observe(node);
  }, []);
  return [layout, measure];
}

/**
 * Structure overview for one architecture preview: a dense collapsible list
 * (primary, accessible), a complementary router map and a node inspector.
 * Purely presentational: it renders the passed server projection and makes
 * no requests.
 */
export function ArchitectureExplorer({
  preview,
  selectedNodeId,
  onSelectNode,
  view: viewProp,
  onViewChange,
  onEditNode,
  contextLabel,
}: ArchitectureExplorerProps) {
  const model = useMemo(() => architectureExplorerModel(preview), [preview]);
  const [layout, measureLayout] = useExplorerLayout();
  const sheetMode = layout === "stack";
  const sheetModeRef = useRef(sheetMode);
  sheetModeRef.current = sheetMode;

  const [internalView, setInternalView] = useState<ArchitectureExplorerView>("list");
  const view: ArchitectureExplorerView = viewProp ?? internalView;
  const selectionControlled = selectedNodeId !== undefined;
  const [internalSelection, setInternalSelection] = useState<string | null>(null);
  const requestedSelection = selectionControlled ? selectedNodeId : internalSelection;
  const selectedNode = requestedSelection ? model.nodes.get(requestedSelection) ?? null : null;
  const selectedId = selectedNode?.id ?? null;

  const [scopeKey, setScopeKey] = useState(model.key);
  const [query, setQuery] = useState("");
  const [filterChoice, setFilterChoice] = useState<ArchitectureExplorerFilter>("all");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => architectureExplorerInitialExpandedIds(model));
  const [mapFocusId, setMapFocusId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // A different architecture starts from a fresh local presentation state.
  if (scopeKey !== model.key) {
    setScopeKey(model.key);
    setQuery("");
    setFilterChoice("all");
    setExpandedIds(architectureExplorerInitialExpandedIds(model));
    setMapFocusId(null);
    setSheetOpen(false);
  }

  const filter: ArchitectureExplorerFilter = model.hasHiddenNodes ? filterChoice : "all";
  const search = useMemo(() => searchArchitectureExplorer(model, query, filter), [filter, model, query]);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const mainRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingSheetFocus = useRef(false);
  const pendingReturnFocus = useRef(false);
  const pendingHeadingFocus = useRef(false);

  const registerRow = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  }, []);

  const selectNode = useCallback((id: string, origin?: HTMLElement | null) => {
    if (!selectionControlled) setInternalSelection(id);
    onSelectNode?.(id);
    // User selection from the list or map opens the details sheet.
    if (origin !== undefined && sheetModeRef.current) {
      openerRef.current = origin;
      pendingSheetFocus.current = true;
      setSheetOpen(true);
    }
  }, [onSelectNode, selectionControlled]);

  const closeSheet = useCallback(() => {
    // Return focus only when it was in the sheet (or lost), never away from
    // a control the user moved to meanwhile.
    const active = document.activeElement;
    pendingReturnFocus.current = !active
      || active === document.body
      || Boolean(inspectorRef.current?.contains(active));
    setSheetOpen(false);
  }, []);

  const setView = useCallback((next: ArchitectureExplorerView) => {
    closeSheet();
    if (next === view) return;
    if (viewProp === undefined) setInternalView(next);
    onViewChange?.(next);
  }, [closeSheet, onViewChange, view, viewProp]);

  const toggleNode = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
    searchRef.current?.focus();
  }, []);

  // Selection from outside (URL, handoff, map) always reveals its branch.
  useLayoutEffect(() => {
    if (!selectedId) return;
    const ancestors = architectureExplorerAncestorIds(model, selectedId);
    if (ancestors.length === 0) return;
    setExpandedIds((current) => ancestors.every((id) => current.has(id)) ? current : new Set([...current, ...ancestors]));
  }, [model, selectedId]);

  // A non-exposed node selected from outside must stay visible in the list.
  // Only a new selection may change the user's filter choice.
  const selectedHidden = selectedNode !== null && !selectedNode.exposed;
  const selectedHiddenRef = useRef(selectedHidden);
  selectedHiddenRef.current = selectedHidden;
  useEffect(() => {
    if (selectedHiddenRef.current) setFilterChoice((current) => current === "exposed" ? "all" : current);
  }, [selectedId]);

  // In the map, a selected skill reveals its branch; a router focuses itself.
  useEffect(() => {
    if (view !== "map" || !selectedId) return;
    const node = model.nodes.get(selectedId);
    if (!node) return;
    if (node.kind === "router") setMapFocusId(node.childIds.length > 0 ? node.id : node.parentId);
    else setMapFocusId(node.parentId);
  }, [model, selectedId, view]);

  // Keep the selected row visible inside the list's own scroll area.
  useEffect(() => {
    if (view !== "list" || !selectedId) return;
    const frame = requestAnimationFrame(() => {
      const row = rowRefs.current.get(selectedId);
      const container = listScrollRef.current;
      if (!row || !container || container.scrollHeight <= container.clientHeight) return;
      const rowBox = row.getBoundingClientRect();
      const box = container.getBoundingClientRect();
      if (rowBox.top < box.top) container.scrollTop -= box.top - rowBox.top + 8;
      else if (rowBox.bottom > box.bottom) container.scrollTop += rowBox.bottom - box.bottom + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedId, view]);

  const sheetVisible = sheetMode && sheetOpen && selectedNode !== null;

  // Widening into the split layout shows the inspector as a column; do not
  // reopen a stale sheet if the explorer narrows again later.
  useEffect(() => {
    if (!sheetMode) setSheetOpen(false);
  }, [sheetMode]);

  // Sheet focus: move in on open, return to the originating control on close.
  useEffect(() => {
    if (sheetVisible && pendingSheetFocus.current) {
      pendingSheetFocus.current = false;
      headingRef.current?.focus();
      return;
    }
    if (!sheetVisible && pendingReturnFocus.current) {
      // A view change unmounts the opener. Let the destination render, then
      // focus its selected node without stealing focus from another control.
      const frame = requestAnimationFrame(() => {
        pendingReturnFocus.current = false;
        const active = document.activeElement;
        if (active && active !== document.body && !inspectorRef.current?.contains(active)) return;
        const opener = openerRef.current;
        const mapNode = selectedId && view === "map"
          ? [...(mainRef.current?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])].find((element) => element.dataset.id === selectedId)
          : null;
        const target = opener?.isConnected ? opener : mapNode ?? (selectedId ? rowRefs.current.get(selectedId) : null);
        (target ?? searchRef.current)?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [selectedId, sheetVisible, view]);

  useEffect(() => {
    if (!pendingHeadingFocus.current) return;
    pendingHeadingFocus.current = false;
    headingRef.current?.focus({ preventScroll: true });
  }, [selectedId]);

  useEffect(() => {
    if (!sheetVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeSheet();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSheet, sheetVisible]);

  const selectFromInspector = useCallback((id: string) => {
    pendingHeadingFocus.current = true;
    selectNode(id);
  }, [selectNode]);

  const activateFromMap = useCallback((id: string, origin: HTMLElement | null) => {
    const node = model.nodes.get(id);
    selectNode(id, origin);
    if (node?.kind === "router" && node.childIds.length > 0) setMapFocusId(id);
  }, [model, selectNode]);

  const focusBranch = useCallback((id: string) => {
    setMapFocusId(id);
    setView("map");
  }, [setView]);

  const listContext = useMemo<ExplorerListContext>(() => ({
    model,
    filter,
    search,
    expandedIds,
    selectedId,
    onToggle: toggleNode,
    onSelect: selectNode,
    registerRow,
  }), [expandedIds, filter, model, registerRow, search, selectNode, selectedId, toggleNode]);

  const counts = filter === "exposed"
    ? { routers: model.totals.exposedRouters, skills: model.totals.exposedSkills }
    : { routers: model.totals.routers, skills: model.totals.skills };
  const summary = [
    ...(counts.routers > 0 ? [architectureExplorerPlural(counts.routers, "router")] : []),
    architectureExplorerPlural(counts.skills, "skill"),
    ...(model.hasHiddenNodes && filter === "all"
      ? [`${model.totals.exposedSkills} exposed${contextLabel ? ` in ${contextLabel}` : ""}`]
      : []),
  ].join(" · ");
  const resultText = search
    ? search.matches.size === 0 ? "No matches" : architectureExplorerPlural(search.matches.size, "match", "matches")
    : "";
  const rootIds = architectureExplorerVisibleIds(model, model.rootIds, filter, search);
  const expandable = useMemo(() => architectureExplorerExpandableIds(model), [model]);
  const noMatches = search !== null && search.matches.size === 0;

  if (model.nodes.size === 0) {
    return (
      <section className="architecture-explorer" data-testid="architecture-explorer" aria-label="Architecture structure" ref={measureLayout}>
        <div className="architecture-explorer-empty architecture-explorer-pane">
          <CircleAlert size={18} aria-hidden="true" />
          <p><strong>No nodes are exposed in this context.</strong></p>
          <p>Choose another profile or environment to see its structure.</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="architecture-explorer"
      data-testid="architecture-explorer"
      aria-label="Architecture structure"
      data-layout={layout}
      data-view={view}
      ref={measureLayout}
    >
      <div className="architecture-explorer-toolbar">
        <div className="architecture-explorer-segment" role="group" aria-label="Structure view">
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
            <List size={14} aria-hidden="true" />List
          </button>
          <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>
            <MapIcon size={14} aria-hidden="true" />Map
          </button>
        </div>
        <div className="architecture-explorer-search">
          <Search size={15} aria-hidden="true" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search structure"
            placeholder="Search nodes and skills"
            autoComplete="off"
            spellCheck={false}
            maxLength={SEARCH_MAX_LENGTH}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
          />
        </div>
        {model.hasHiddenNodes && (
          <div className="architecture-explorer-segment" role="group" aria-label="Exposure filter">
            <button type="button" aria-pressed={filter === "all"} onClick={() => setFilterChoice("all")}>All nodes</button>
            <button type="button" aria-pressed={filter === "exposed"} onClick={() => setFilterChoice("exposed")}>Exposed only</button>
          </div>
        )}
        <p className="architecture-explorer-summary">{summary}</p>
        <span className="architecture-explorer-results" role="status" aria-live="polite">{resultText}</span>
      </div>

      <div className="architecture-explorer-body">
        <div className="architecture-explorer-main" ref={mainRef}>
          {noMatches ? (
            <div className="architecture-explorer-pane architecture-explorer-empty">
              <SearchX size={20} aria-hidden="true" />
              <p><strong>No nodes match “{query.trim()}”</strong></p>
              <p>Search checks node labels and skill slugs and titles{filter === "exposed" ? " among exposed nodes" : ""}.</p>
              <Button size="sm" type="button" variant="outline" onClick={clearSearch}>Clear search</Button>
            </div>
          ) : rootIds.length === 0 ? (
            <div className="architecture-explorer-pane architecture-explorer-empty">
              <CircleAlert size={20} aria-hidden="true" />
              <p><strong>No nodes are exposed in this context.</strong></p>
              <Button size="sm" type="button" variant="outline" onClick={() => setFilterChoice("all")}>Show all nodes</Button>
            </div>
          ) : view === "map" ? (
            <ArchitectureExplorerMap
              model={model}
              filter={filter}
              search={search}
              selectedId={selectedId}
              focusId={mapFocusId}
              onActivate={activateFromMap}
              onFocusChange={setMapFocusId}
            />
          ) : (
            <div className="architecture-explorer-pane">
              <div className="architecture-explorer-pane-head">
                <span className="architecture-explorer-pane-title">
                  {search ? "Matches shown with their branch" : "Outline"}
                </span>
                {expandable.size > 0 && (
                  <span className="architecture-explorer-pane-actions">
                    <Button size="xs" type="button" variant="ghost" disabled={search !== null} onClick={() => setExpandedIds(new Set(expandable))}>
                      <ChevronsUpDown aria-hidden="true" />Expand all
                    </Button>
                    <Button size="xs" type="button" variant="ghost" disabled={search !== null} onClick={() => setExpandedIds(new Set())}>
                      <ChevronsDownUp aria-hidden="true" />Collapse all
                    </Button>
                  </span>
                )}
              </div>
              <div className="architecture-explorer-scroll" ref={listScrollRef}>
                <ul className="architecture-explorer-tree" aria-label="Architecture outline">
                  {rootIds.map((id) => <ExplorerItem context={listContext} id={id} key={id} />)}
                </ul>
              </div>
            </div>
          )}
        </div>

        <ExplorerInspector
          contextLabel={contextLabel}
          headingRef={headingRef}
          inspectorRef={inspectorRef}
          mapFocusId={mapFocusId}
          model={model}
          node={selectedNode}
          preview={preview}
          sheetMode={sheetMode}
          sheetVisible={sheetVisible}
          view={view}
          onClose={closeSheet}
          onEdit={onEditNode}
          onFocusBranch={focusBranch}
          onSelect={selectFromInspector}
          onShowInList={() => setView("list")}
        />
      </div>
    </section>
  );
}

interface ExplorerListContext {
  model: ArchitectureExplorerModel;
  filter: ArchitectureExplorerFilter;
  search: ArchitectureExplorerSearchResult | null;
  expandedIds: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (id: string, origin?: HTMLElement | null) => void;
  registerRow: (id: string, element: HTMLButtonElement | null) => void;
}

function ExplorerItem({ id, context }: { id: string; context: ExplorerListContext }) {
  const node = context.model.nodes.get(id);
  if (!node) return null;
  const searching = context.search !== null;
  const children = architectureExplorerVisibleIds(context.model, node.childIds, context.filter, context.search);
  const expandable = node.kind === "router" && children.length > 0;
  // While searching, branches with matches are shown open.
  const expanded = expandable && (searching || context.expandedIds.has(id));
  const count = context.filter === "exposed" ? node.exposedSkillCount : node.skillCount;
  return (
    <li
      className="architecture-explorer-item"
      data-node-id={id}
      data-node-kind={node.kind}
      data-exposed={node.exposed ? "true" : "false"}
      data-match={context.search?.matches.has(id) ? "true" : undefined}
    >
      <ExplorerRow
        count={count}
        expandable={expandable}
        expanded={expanded}
        node={node}
        query={context.search?.query ?? ""}
        registerRow={context.registerRow}
        searching={searching}
        selected={context.selectedId === id}
        onSelect={context.onSelect}
        onToggle={context.onToggle}
      />
      {expanded && (
        <ul>
          {children.map((childId) => <ExplorerItem context={context} id={childId} key={childId} />)}
        </ul>
      )}
    </li>
  );
}

const ExplorerRow = memo(function ExplorerRow({
  node,
  count,
  expandable,
  expanded,
  searching,
  selected,
  query,
  registerRow,
  onSelect,
  onToggle,
}: {
  node: ArchitectureExplorerNode;
  count: number;
  expandable: boolean;
  expanded: boolean;
  searching: boolean;
  selected: boolean;
  query: string;
  registerRow: (id: string, element: HTMLButtonElement | null) => void;
  onSelect: (id: string, origin?: HTMLElement | null) => void;
  onToggle: (id: string) => void;
}) {
  const { id } = node;
  const router = node.kind === "router";
  const Icon = router ? Workflow : FileText;
  const buttonRef = useCallback((element: HTMLButtonElement | null) => registerRow(id, element), [id, registerRow]);
  const highlight = architectureExplorerHighlight(node.label, query);
  const version = node.skill?.version;
  // One spoken suffix replaces the visual count, version and tag.
  const spoken = router
    ? `, router, ${architectureExplorerPlural(count, "skill")}`
    : `, skill${version ? `, version ${version}` : ""}`;
  return (
    <div className="architecture-explorer-row" data-selected={selected ? "true" : undefined} data-depth={node.depth}>
      {expandable ? (
        <button
          type="button"
          className="architecture-explorer-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${node.label}`}
          disabled={searching}
          onClick={() => onToggle(id)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ) : (
        <span className="architecture-explorer-toggle-spacer" aria-hidden="true" />
      )}
      <button
        type="button"
        className="architecture-explorer-node"
        aria-current={selected ? "true" : undefined}
        ref={buttonRef}
        title={node.label}
        onClick={(event) => onSelect(id, event.currentTarget)}
      >
        <Icon size={15} aria-hidden="true" />
        <span className="architecture-explorer-label">
          {highlight ? <>{highlight[0]}<mark>{highlight[1]}</mark>{highlight[2]}</> : node.label}
        </span>
        <span className="sr-only">{`${spoken}${node.exposed ? "" : ", not exposed"}`}</span>
        {!node.exposed && <span className="architecture-explorer-tag" aria-hidden="true">Not exposed</span>}
        {router ? (
          <span className="architecture-explorer-count" aria-hidden="true">{count}</span>
        ) : version ? (
          <span className="architecture-explorer-version" aria-hidden="true">{version}</span>
        ) : null}
      </button>
    </div>
  );
});

function ExplorerInspector({
  model,
  node,
  preview,
  contextLabel,
  sheetMode,
  sheetVisible,
  view,
  mapFocusId,
  headingRef,
  inspectorRef,
  onClose,
  onSelect,
  onEdit,
  onFocusBranch,
  onShowInList,
}: {
  model: ArchitectureExplorerModel;
  node: ArchitectureExplorerNode | null;
  preview: ArchitecturePreview;
  contextLabel?: string;
  sheetMode: boolean;
  sheetVisible: boolean;
  view: ArchitectureExplorerView;
  mapFocusId: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  inspectorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (id: string) => void;
  onEdit?: (id: string) => void;
  onFocusBranch: (id: string) => void;
  onShowInList: () => void;
}) {
  const exposure = useMemo(() => node ? architectureExplorerExposure(preview, model, node.id) : null, [model, node, preview]);
  const ancestors = useMemo(() => node ? architectureExplorerAncestorIds(model, node.id) : [], [model, node]);
  const context = contextLabel?.trim()
    || `Profile ${preview.compiled.profileId} · Environment ${preview.compiled.environmentId}`;

  return (
    <aside
      aria-label="Node details"
      className="architecture-explorer-inspector"
      data-testid="architecture-inspector"
      data-sheet={sheetMode ? "true" : undefined}
      hidden={sheetMode && !sheetVisible}
      ref={inspectorRef}
    >
      {!node ? (
        <div className="architecture-explorer-inspector-empty">
          <ListTree size={20} aria-hidden="true" />
          <p><strong>Select a node to see details</strong></p>
          <p>Choose a router or skill in the {view === "map" ? "map" : "list"} to see its path, release and exposure.</p>
        </div>
      ) : (
        <>
          <div className="architecture-explorer-inspector-head">
            <span className="architecture-explorer-kind" data-kind={node.kind}>
              {node.kind === "router" ? <Workflow size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
              {node.kind === "router" ? "Router" : "Skill"}
            </span>
            {sheetMode && (
              <Button aria-label="Close details" className="architecture-explorer-inspector-close" size="icon-sm" type="button" variant="ghost" onClick={onClose}>
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
          <h3 className="architecture-explorer-inspector-title" ref={headingRef} tabIndex={-1}>{node.label}</h3>
          <dl className="architecture-explorer-facts">
            <div>
              <dt>Kind</dt>
              <dd>{node.kind === "router" ? "Router · not counted as a skill" : "Skill"}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>
                <ol className="architecture-explorer-path">
                  {ancestors.map((id) => (
                    <li key={id}>
                      <button type="button" className="architecture-explorer-link" onClick={() => onSelect(id)}>
                        {model.nodes.get(id)?.label ?? id}
                      </button>
                      <span className="architecture-explorer-path-separator" aria-hidden="true">›</span>
                    </li>
                  ))}
                  <li aria-current="location">{node.label}</li>
                </ol>
              </dd>
            </div>
            {node.skill && (
              <>
                <div>
                  <dt>Skill slug</dt>
                  <dd>{node.skill.slug ? <code>{node.skill.slug}</code> : <span className="architecture-explorer-muted">Unavailable</span>}</dd>
                </div>
                {node.skill.title && (
                  <div>
                    <dt>Title</dt>
                    <dd>{node.skill.title}</dd>
                  </div>
                )}
                <div>
                  <dt>Version</dt>
                  <dd>
                    {node.skill.version ? <code>{node.skill.version}</code> : <span className="architecture-explorer-muted">Unavailable</span>}
                    {node.skill.source === "revision" && (
                      <span className="architecture-explorer-note">Pinned in the saved revision; not resolved for this context.</span>
                    )}
                  </dd>
                </div>
                {node.skill.digest && (
                  <div>
                    <dt>Digest</dt>
                    <dd className="architecture-explorer-digest-row">
                      <code className="architecture-explorer-digest" title={node.skill.digest}>
                        <span aria-hidden="true">sha256:{shortDigest(node.skill.digest)}</span>
                        <span className="sr-only">sha256 {node.skill.digest}</span>
                      </code>
                      <CopyValueButton label="Copy digest" value={node.skill.digest} />
                    </dd>
                  </div>
                )}
                {node.skill.packageVisibility && (
                  <div>
                    <dt>Package access</dt>
                    <dd>{packageVisibilityLabel(node.skill.packageVisibility)}</dd>
                  </div>
                )}
              </>
            )}
            {node.kind === "router" && (
              <>
                <div>
                  <dt>Contains</dt>
                  <dd>
                    {architectureExplorerPlural(node.childRouterCount, "router")} · {architectureExplorerPlural(node.childSkillCount, "skill")} directly
                  </dd>
                </div>
                <div>
                  <dt>Skills in branch</dt>
                  <dd>
                    {architectureExplorerPlural(node.skillCount, "skill")}
                    {model.hasHiddenNodes ? ` · ${node.exposedSkillCount} exposed` : ""}
                  </dd>
                </div>
              </>
            )}
            {exposure && (
              <div>
                <dt>Exposure</dt>
                <dd>
                  <span className="architecture-explorer-exposure" data-state={exposure.state}>{exposure.label}</span>
                  <span className="architecture-explorer-exposure-detail">{exposure.detail}</span>
                  {exposure.reason && <span className="architecture-explorer-exposure-reason">{exposure.reason}</span>}
                </dd>
              </div>
            )}
            <div>
              <dt>Context</dt>
              <dd>{context}</dd>
            </div>
            <div>
              <dt>Node ID</dt>
              <dd><code>{node.id}</code></dd>
            </div>
          </dl>
          <div className="architecture-explorer-inspector-actions">
            {node.kind === "router" && node.childIds.length > 0 && !(view === "map" && mapFocusId === node.id) && (
              <Button size="sm" type="button" variant="outline" onClick={() => onFocusBranch(node.id)}>
                <Focus aria-hidden="true" />Focus branch
              </Button>
            )}
            {view === "map" && (
              <Button size="sm" type="button" variant="outline" onClick={onShowInList}>
                <List aria-hidden="true" />Show in list
              </Button>
            )}
            {onEdit && (
              <Button size="sm" type="button" variant="outline" onClick={() => onEdit(node.id)}>
                <Pencil aria-hidden="true" />Edit in Workbench
              </Button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function shortDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 12)}…` : digest;
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button aria-label={copied ? `${label}: copied` : label} className="architecture-explorer-copy" size="icon-xs" type="button" variant="ghost" onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
