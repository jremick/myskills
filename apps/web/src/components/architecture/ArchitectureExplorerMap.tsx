import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ArrowLeft, CircleAlert, FileText, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  architectureExplorerAncestorIds,
  architectureExplorerMapLayout,
  architectureExplorerPlural,
  type ArchitectureExplorerFilter,
  type ArchitectureExplorerModel,
  type ArchitectureExplorerSearchResult,
} from "./architecture-explorer-model.js";

type ExplorerMapNodeData = Record<string, unknown> & {
  label: string;
  kind: "router" | "leaf";
  meta: string;
  selected: boolean;
  exposed: boolean;
  root: boolean;
  dimmed: boolean;
  match: boolean;
  hasParent: boolean;
};

type ExplorerFlowNode = Node<ExplorerMapNodeData, "explorer">;

// Fit keeps 13px labels at 10px or larger (13 × 0.8); bigger branches pan
// instead of shrinking. Manual zoom can go a little further out.
const FIT_OPTIONS = { padding: 0.12, minZoom: 0.8, maxZoom: 1 };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.5;
const REVEAL_ZOOM = 0.8;
const MAP_ARIA_LABELS = {
  "node.a11yDescription.default": "Press Enter or Space to select this node and show its details.",
  "controls.ariaLabel": "Map zoom controls",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "controls.fitView.ariaLabel": "Fit map",
};

export interface ArchitectureExplorerMapProps {
  model: ArchitectureExplorerModel;
  filter: ArchitectureExplorerFilter;
  search: ArchitectureExplorerSearchResult | null;
  selectedId: string | null;
  /** Router whose branch is revealed; null shows the routers-only overview. */
  focusId: string | null;
  onActivate: (id: string, origin: HTMLElement | null) => void;
  onFocusChange: (id: string | null) => void;
}

/**
 * Complementary router map. It is a read-only projection of the explorer
 * model: no layout is persisted and the preview is never mutated. The HTML
 * list remains the complete accessible structure.
 */
export function ArchitectureExplorerMap({ model, filter, search, selectedId, focusId, onActivate, onFocusChange }: ArchitectureExplorerMapProps) {
  const layout = useMemo(() => architectureExplorerMapLayout(model, { focusId, filter }), [filter, focusId, model]);
  // Keep ancestors available for panning, but frame the branch being explored.
  // Fitting the whole ancestor chain can leave every child offscreen.
  const fitOptions = useMemo(() => layout.focusId ? {
    ...FIT_OPTIONS,
    nodes: layout.nodes
      .filter((node) => node.id === layout.focusId || model.nodes.get(node.id)?.parentId === layout.focusId)
      .map(({ id }) => ({ id })),
  } : FIT_OPTIONS, [layout, model]);
  const flowRef = useRef<ReactFlowInstance<ExplorerFlowNode, Edge> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const pendingFocusRef = useRef<string | null>(null);
  const fittedLayoutRef = useRef(layout);

  const pathIds = useMemo(() => {
    if (!selectedId || !model.nodes.has(selectedId)) return new Set<string>();
    return new Set([...architectureExplorerAncestorIds(model, selectedId), selectedId]);
  }, [model, selectedId]);

  const nodes = useMemo<ExplorerFlowNode[]>(() => layout.nodes.map((item): ExplorerFlowNode => {
    const node = model.nodes.get(item.id)!;
    const selected = item.id === selectedId;
    const count = filter === "exposed" ? node.exposedSkillCount : node.skillCount;
    const meta = node.kind === "router"
      ? `${architectureExplorerPlural(count, "skill")}${node.exposed ? "" : " · not exposed"}`
      : node.exposed ? node.skill?.version ?? "Skill" : "Not exposed";
    const ariaLabel = node.kind === "router"
      ? `Router ${node.label}, ${architectureExplorerPlural(count, "skill")}${node.exposed ? "" : ", not exposed"}${item.id === layout.focusId ? ", focused branch" : ""}`
      : `Skill ${node.label}${node.skill?.version ? `, version ${node.skill.version}` : ""}${node.exposed ? "" : ", not exposed"}`;
    return {
      id: item.id,
      type: "explorer",
      position: { x: item.x, y: item.y },
      width: item.width,
      height: item.height,
      // Sizes are fixed by the layout, so hand them to React Flow up front.
      // Re-projected nodes then keep their handle bounds without a re-measure.
      measured: { width: item.width, height: item.height },
      data: {
        label: node.label,
        kind: node.kind,
        meta,
        selected,
        exposed: node.exposed,
        root: node.kind === "router" && node.parentId === null,
        dimmed: search !== null && !search.visible.has(item.id),
        match: search !== null && search.matches.has(item.id),
        hasParent: item.hasParent,
      },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: true,
      ariaRole: "button",
      ariaLabel,
      ...(selected ? { domAttributes: { "aria-current": "true" as const } } : {}),
    };
  }), [filter, layout, model, search, selectedId]);

  const edges = useMemo<Edge[]>(() => layout.edges.map((edge): Edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "smoothstep",
    selectable: false,
    focusable: false,
    deletable: false,
    ...(pathIds.has(edge.source) && pathIds.has(edge.target) ? { className: "is-active" } : {}),
  })), [layout, pathIds]);

  const nodeElement = useCallback((id: string): HTMLElement | null => {
    const elements = canvasRef.current?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [];
    for (const element of elements) {
      if (element.getAttribute("data-id") === id) return element;
    }
    return null;
  }, []);

  // Keep the selected node in view without refitting when it is visible.
  const revealSelected = useCallback(() => {
    const flow = flowRef.current;
    const element = canvasRef.current;
    const id = selectedRef.current;
    if (!flow || !element || !id || element.clientWidth === 0) return;
    const node = flow.getNode(id);
    if (!node) return;
    const width = node.width ?? 0;
    const height = node.height ?? 0;
    const { x, y, zoom } = flow.getViewport();
    const left = node.position.x * zoom + x;
    const top = node.position.y * zoom + y;
    if (left >= 0 && top >= 0 && left + width * zoom <= element.clientWidth && top + height * zoom <= element.clientHeight) return;
    void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: Math.max(zoom, REVEAL_ZOOM) });
  }, []);

  const focusPendingNode = useCallback(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    pendingFocusRef.current = null;
    nodeElement(id)?.focus({ preventScroll: true });
  }, [nodeElement]);

  const handleInit = useCallback((instance: ReactFlowInstance<ExplorerFlowNode, Edge>) => {
    flowRef.current = instance;
    void instance.fitView(fitOptions).then(() => revealSelected());
  }, [fitOptions, revealSelected]);

  // Refit when the projected branch changes (focus or filter), then keep
  // the selection visible and restore keyboard focus after "All branches".
  useEffect(() => {
    if (fittedLayoutRef.current === layout) return;
    fittedLayoutRef.current = layout;
    const flow = flowRef.current;
    if (!flow) return;
    let active = true;
    void flow.fitView(fitOptions).then(() => {
      if (!active) return;
      revealSelected();
      focusPendingNode();
    });
    return () => {
      active = false;
    };
  }, [fitOptions, focusPendingNode, layout, revealSelected]);

  useEffect(() => {
    revealSelected();
  }, [revealSelected, selectedId]);

  const handleNodeClick = useCallback((event: ReactMouseEvent, node: ExplorerFlowNode) => {
    onActivate(node.id, event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
  }, [onActivate]);

  // React Flow nodes are focusable wrappers; Enter/Space activate them like
  // the list's buttons. Selection state stays owned by the explorer.
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("react-flow__node")) return;
    const id = target.getAttribute("data-id");
    if (!id || !model.nodes.has(id)) return;
    event.preventDefault();
    onActivate(id, target);
  }, [model, onActivate]);

  const focusNode = layout.focusId ? model.nodes.get(layout.focusId) ?? null : null;
  const focusPath = focusNode
    ? [...architectureExplorerAncestorIds(model, focusNode.id), focusNode.id].map((id) => model.nodes.get(id)?.label ?? id).join(" › ")
    : "";
  const focusCount = focusNode ? (filter === "exposed" ? focusNode.exposedSkillCount : focusNode.skillCount) : 0;
  const overviewRouters = layout.nodes.filter((node) => node.kind === "router").length;

  return (
    <div className="architecture-explorer-pane architecture-explorer-map-pane">
      <div className="architecture-explorer-pane-head">
        {focusNode ? (
          <>
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => {
                pendingFocusRef.current = focusNode.id;
                onFocusChange(null);
              }}
            >
              <ArrowLeft aria-hidden="true" />All branches
            </Button>
            <span className="architecture-explorer-map-title" title={focusPath}>
              {focusPath} · {architectureExplorerPlural(focusCount, "skill")}
            </span>
          </>
        ) : (
          <span className="architecture-explorer-map-title">
            {overviewRouters > 0
              ? `All branches · ${architectureExplorerPlural(overviewRouters, "router")}`
              : `All skills · ${architectureExplorerPlural(layout.truncated?.total ?? layout.nodes.length, "skill")}`}
          </span>
        )}
      </div>
      {layout.nodes.length === 0 ? (
        <div className="architecture-explorer-empty">
          <CircleAlert size={18} aria-hidden="true" />
          <p>No nodes to map in this context.</p>
        </div>
      ) : (
        <div className="architecture-explorer-map-canvas" ref={canvasRef}>
          <ReactFlow<ExplorerFlowNode, Edge>
            data-testid="architecture-explorer-map"
            aria-label="Architecture router map"
            nodes={nodes}
            edges={edges}
            nodeTypes={EXPLORER_NODE_TYPES}
            onInit={handleInit}
            onNodeClick={handleNodeClick}
            onKeyDown={handleKeyDown}
            fitView
            fitViewOptions={fitOptions}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable
            edgesFocusable={false}
            edgesReconnectable={false}
            elementsSelectable={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            panActivationKeyCode={null}
            panOnScroll
            zoomOnDoubleClick={false}
            ariaLabelConfig={MAP_ARIA_LABELS}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#dde3ea" gap={16} size={1} />
            <Controls showInteractive={false} position="top-right" orientation="horizontal" fitViewOptions={fitOptions} />
          </ReactFlow>
        </div>
      )}
      {layout.truncated && (
        <p className="architecture-explorer-map-note">
          Showing {layout.truncated.shown} of {architectureExplorerPlural(layout.truncated.total, "skill")}. Use List view for the full structure.
        </p>
      )}
      <p className="architecture-explorer-map-hint">
        Routers appear first; select a router to show its skills. The List view is the complete, accessible structure.
      </p>
    </div>
  );
}

const ExplorerMapNodeView = memo(function ExplorerMapNodeView({ id, data }: NodeProps<ExplorerFlowNode>) {
  const router = data.kind === "router";
  const Icon = router ? Workflow : FileText;
  return (
    <div
      className="architecture-explorer-map-node"
      data-node-id={id}
      data-node-kind={data.kind}
      data-selected={data.selected ? "true" : undefined}
      data-exposed={data.exposed ? "true" : "false"}
      data-root={data.root ? "true" : undefined}
      data-dimmed={data.dimmed ? "true" : undefined}
      data-match={data.match ? "true" : undefined}
      title={data.label}
    >
      {data.hasParent && <Handle type="target" position={Position.Left} className="architecture-explorer-map-handle" isConnectable={false} />}
      <Icon size={15} aria-hidden="true" />
      <span className="architecture-explorer-map-copy">
        <span className="architecture-explorer-map-label">{data.label}</span>
        <span className="architecture-explorer-map-meta">{data.meta}</span>
      </span>
      {router && <Handle type="source" position={Position.Right} className="architecture-explorer-map-handle" isConnectable={false} />}
    </div>
  );
});

const EXPLORER_NODE_TYPES: NodeTypes = {
  explorer: ExplorerMapNodeView,
};
