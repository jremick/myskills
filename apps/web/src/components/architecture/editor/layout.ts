import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import type { ArchitectureFlowNodeData, ArchitectureGraphPosition } from "./types.js";

export const ARCHITECTURE_NODE_WIDTH = 232;
export const ARCHITECTURE_NODE_HEIGHT = 82;

export interface ArchitectureLayoutOptions {
  direction?: "LR" | "TB";
  nodeWidth?: number;
  nodeHeight?: number;
  nodeSep?: number;
  rankSep?: number;
}

/**
 * Pure adapter around Dagre. It knows only the versioned architecture
 * topology and returns positions; React Flow state and viewport state remain
 * outside this adapter and are therefore never persisted in ArchitectureSpecV1.
 */
export function layoutArchitectureGraph(
  spec: ArchitectureSpecV1,
  options: ArchitectureLayoutOptions = {},
): Record<string, ArchitectureGraphPosition> {
  const width = options.nodeWidth ?? ARCHITECTURE_NODE_WIDTH;
  const height = options.nodeHeight ?? ARCHITECTURE_NODE_HEIGHT;
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.direction ?? "LR",
    nodesep: options.nodeSep ?? 42,
    ranksep: options.rankSep ?? 92,
    marginx: 32,
    marginy: 32,
  });

  const known = new Set(spec.nodes.map((node) => node.id));
  for (const node of spec.nodes) graph.setNode(node.id, { width, height });
  for (const edge of spec.edges) {
    if (known.has(edge.from) && known.has(edge.to)) graph.setEdge(edge.from, edge.to);
  }
  dagre.layout(graph);

  return Object.fromEntries(spec.nodes.map((node) => {
    const positioned = graph.node(node.id) as { x?: number; y?: number } | undefined;
    const centerX = positioned?.x ?? width / 2;
    const centerY = positioned?.y ?? height / 2;
    return [node.id, {
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
    } satisfies ArchitectureGraphPosition];
  }));
}

export type ArchitectureFlowNode = Node<ArchitectureFlowNodeData, "architecture">;

export interface ArchitectureFlowProjection {
  nodes: ArchitectureFlowNode[];
  edges: Edge[];
}

/** Create the controlled React Flow projection from the same semantic draft. */
export function projectArchitectureToFlow(
  spec: ArchitectureSpecV1,
  selectedNodeId: string | null,
  positions: Record<string, ArchitectureGraphPosition> = layoutArchitectureGraph(spec),
): ArchitectureFlowProjection {
  const nodes: ArchitectureFlowNode[] = spec.nodes.map((node) => {
    const position = positions[node.id] ?? { x: 0, y: 0, width: ARCHITECTURE_NODE_WIDTH, height: ARCHITECTURE_NODE_HEIGHT };
    return {
      id: node.id,
      type: "architecture",
      position: { x: position.x, y: position.y },
      width: position.width,
      height: position.height,
      data: {
        label: node.label,
        kind: node.kind,
        skillRefId: "skillRefId" in node ? node.skillRefId : undefined,
        selected: node.id === selectedNodeId,
      },
      selectable: false,
      deletable: false,
      draggable: true,
      focusable: false,
      ariaRole: "img",
      ariaLabel: `${node.kind === "router" ? "Router" : "Leaf"}: ${node.label}`,
    };
  });
  const known = new Set(spec.nodes.map((node) => node.id));
  const edges: Edge[] = spec.edges
    .filter((edge) => known.has(edge.from) && known.has(edge.to))
    .map((edge) => ({
      id: `${edge.from}->${edge.to}:${edge.kind}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      label: edge.kind === "contains" ? "contains" : "routes",
      animated: false,
      selectable: false,
      deletable: false,
    }));
  return { nodes, edges };
}
