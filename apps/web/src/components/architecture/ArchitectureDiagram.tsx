import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CircleAlert, Minus, Plus, Scan, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ArchitectureTopologyEdge, ArchitectureTopologyNode } from "../../api.js";
import { isLeafNodeKind, truncateSvgLabel } from "./architecture-dashboard-helpers.js";

type Topology = { nodes: ArchitectureTopologyNode[]; edges: ArchitectureTopologyEdge[] };

function diagramLayout(topology: Topology) {
  const positions = new Map(topology.nodes.map((node, index) => [node.id,
    node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
      ? node.position
      : { x: 40 + (index % 3) * 246, y: 22 + Math.floor(index / 3) * 102 },
  ] as const));
  const coordinates = [...positions.values()];
  const minX = Math.min(0, ...coordinates.map(position => position.x));
  const minY = Math.min(0, ...coordinates.map(position => position.y));
  const maxX = Math.max(184, ...coordinates.map(position => position.x + 184));
  const maxY = Math.max(60, ...coordinates.map(position => position.y + 60));
  return { positions, x: minX - 32, y: minY - 32, width: Math.max(760, maxX - minX + 64), height: Math.max(260, maxY - minY + 64) };
}
type Layout = ReturnType<typeof diagramLayout>;

export function ArchitectureDiagram({ topology, expanded, onClose }: { topology: Topology; expanded: boolean; onClose: () => void }) {
  const layout = useMemo(() => diagramLayout(topology), [topology]);
  return (
    <>
      <div className="architecture-diagram-shell" role="region" aria-label="Scrollable architecture topology" tabIndex={0}>
        {topology.nodes.length === 0
          ? <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No topology nodes were returned.</div>
          : <DiagramGraphic topology={topology} layout={layout} style={{ minWidth: Math.ceil(layout.width * 0.9) }} />}
      </div>
      {expanded && <DiagramOverlay topology={topology} layout={layout} onClose={onClose} />}
    </>
  );
}

function DiagramGraphic({ topology, layout, style }: { topology: Topology; layout: Layout; style?: CSSProperties }) {
  const id = useId();
  return (
    <svg className="architecture-diagram" style={style} role="img" aria-labelledby={`${id}-title ${id}-description`} viewBox={`${layout.x} ${layout.y} ${layout.width} ${layout.height}`}>
      <title id={`${id}-title`}>Skill architecture topology</title>
      <desc id={`${id}-description`}>A deterministic map of routers, sub-routers, and leaf skills returned by the API.</desc>
      <g className="architecture-diagram-edges" aria-hidden="true">
        {topology.edges.map((edge, index) => {
          const from = layout.positions.get(edge.from);
          const to = layout.positions.get(edge.to);
          return from && to ? <line key={edge.id ?? `${edge.from}:${edge.to}:${index}`} markerEnd={`url(#${id}-arrow)`} x1={from.x + 92} x2={to.x + 92} y1={from.y + 30} y2={to.y + 30} /> : null;
        })}
        <defs><marker id={`${id}-arrow`} markerHeight="8" markerWidth="8" orient="auto" refX="6" refY="3"><path d="M0,0 L0,6 L6,3 z" /></marker></defs>
      </g>
      <g className="architecture-diagram-nodes">
        {topology.nodes.map(node => {
          const position = layout.positions.get(node.id)!;
          const leaf = isLeafNodeKind(node.kind);
          return (
            <g key={node.id} transform={`translate(${position.x}, ${position.y})`}>
              <title>{node.label}</title>
              <rect className={leaf ? "architecture-diagram-node skill" : "architecture-diagram-node router"} height="60" rx="9" width="184" />
              <text className="architecture-diagram-kind" x="14" y="19">{leaf ? "LEAF SKILL" : "ROUTER"}</text>
              <text className="architecture-diagram-label" x="14" y="41">{truncateSvgLabel(node.label)}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function DiagramOverlay({ topology, layout, onClose }: { topology: Topology; layout: Layout; onClose: () => void }) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const zoomRef = useRef(1);
  const fitting = useRef(true);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const anchor = useRef<{ x: number; y: number; worldX: number; worldY: number } | null>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    fitting.current = true;
    anchor.current = null;
    const next = Math.max(0.01, Math.min(1, (viewport.clientWidth - 48) / layout.width, (viewport.clientHeight - 48) / layout.height));
    zoomRef.current = next;
    setZoom(next);
    viewport.scrollTo(0, 0);
    return next;
  }, [layout.width, layout.height]);

  useLayoutEffect(() => {
    const initial = fit();
    // Start with readable labels on a phone; Fit remains an explicit overview.
    if (initial !== undefined && initial < 0.75) {
      fitting.current = false;
      zoomRef.current = 0.75;
      setZoom(0.75);
    }
    const observer = new ResizeObserver(() => { if (fitting.current) fit(); });
    observer.observe(viewportRef.current!);
    return () => observer.disconnect();
  }, [fit]);

  const changeZoom = useCallback((value: number, point?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector("svg");
    if (!viewport || !svg) return;
    const next = Math.max(0.1, Math.min(4, value));
    fitting.current = false;
    if (next === zoomRef.current) return;
    const box = viewport.getBoundingClientRect();
    const image = svg.getBoundingClientRect();
    const x = point?.x ?? box.left + viewport.clientWidth / 2;
    const y = point?.y ?? box.top + viewport.clientHeight / 2;
    anchor.current = { x, y, worldX: (x - image.left) / zoomRef.current, worldY: (y - image.top) / zoomRef.current };
    zoomRef.current = next;
    setZoom(next);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const svg = viewport?.querySelector("svg");
    const point = anchor.current;
    if (!viewport || !svg || !point) return;
    const image = svg.getBoundingClientRect();
    viewport.scrollLeft += point.worldX * zoom - (point.x - image.left);
    viewport.scrollTop += point.worldY * zoom - (point.y - image.top);
    anchor.current = null;
  }, [zoom]);

  useEffect(() => {
    const viewport = viewportRef.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [changeZoom]);

  return (
    <dialog className="architecture-diagram-overlay" aria-labelledby={`${id}-title`} ref={dialogRef} onClose={event => { if (!event.currentTarget.open) onClose(); }} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key !== "Tab") return;
      // Keep Tab in the viewer, including browsers that allow native-dialog
      // tab order to visit browser chrome after its last control.
      const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']");
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header className="architecture-diagram-toolbar">
        <div><h2 id={`${id}-title`}>Architecture diagram</h2><p>{topology.nodes.length} nodes · {topology.edges.length} links</p></div>
        <div className="architecture-diagram-controls" role="group" aria-label="Diagram zoom">
          <Button aria-label="Zoom out" disabled={zoom <= 0.1} onClick={() => changeZoom(zoomRef.current / 1.2)} size="icon-sm" type="button" variant="outline"><Minus aria-hidden="true" /></Button>
          <output aria-label="Zoom level" aria-live="polite">{Math.round(zoom * 100)}%</output>
          <Button aria-label="Zoom in" disabled={zoom >= 4} onClick={() => changeZoom(zoomRef.current * 1.2)} size="icon-sm" type="button" variant="outline"><Plus aria-hidden="true" /></Button>
          <Button aria-label="Actual size, 1:1" onClick={() => changeZoom(1)} size="sm" type="button" variant="outline">1:1</Button>
          <Button aria-label="Fit diagram" onClick={fit} size="sm" type="button" variant="outline"><Scan aria-hidden="true" />Fit</Button>
        </div>
        <Button aria-label="Close diagram" className="architecture-diagram-close" onClick={onClose} ref={closeRef} size="icon-sm" type="button" variant="outline"><X aria-hidden="true" /></Button>
      </header>
      <div
        aria-label="Diagram viewport" aria-describedby={`${id}-help`} className="architecture-diagram-viewport" data-dragging={dragging} ref={viewportRef} role="region" tabIndex={0}
        onKeyDown={event => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.key === "+" || event.key === "=") { event.preventDefault(); changeZoom(zoomRef.current * 1.2); }
          if (event.key === "-" || event.key === "_") { event.preventDefault(); changeZoom(zoomRef.current / 1.2); }
          if (event.key === "0") { event.preventDefault(); changeZoom(1); }
          if (event.key.toLowerCase() === "f") { event.preventDefault(); fit(); }
        }}
        onPointerDown={event => {
          if (event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX >= box.left + event.currentTarget.clientWidth || event.clientY >= box.top + event.currentTarget.clientHeight) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
          setDragging(true);
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      >
        <div className="architecture-diagram-stage" style={{ width: layout.width * zoom + 48, height: layout.height * zoom + 48 }}>
          <DiagramGraphic topology={topology} layout={layout} style={{ width: layout.width * zoom, height: layout.height * zoom }} />
        </div>
      </div>
      <p className="architecture-diagram-help" id={`${id}-help`}>Drag or scroll to pan. With the diagram focused, use + and − to zoom or F to fit. Escape closes the viewer.</p>
    </dialog>
  );
}
