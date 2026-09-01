import { useState } from "react";
import { canonicalArchitectureDiagramArtifactJson } from "@myskills-app/core";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Clipboard,
  Download,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ArchitectureDetail,
  type ArchitecturePreview,
  type ArchitecturePreviewPlan,
  type ArchitectureTopologyEdge,
  type ArchitectureTopologyNode,
} from "../../api.js";
import {
  isLeafNodeKind,
  runtimeExposureLabel,
  truncateSvgLabel,
} from "./architecture-dashboard-helpers.js";

export function ArchitecturePreviewPanel({ detail, preview }: { detail: ArchitectureDetail | null; preview: ArchitecturePreview }) {
  const topology = topologyForPreview(preview);
  const diagramJson = canonicalArchitectureDiagramArtifactJson(preview.diagram);
  const conflict = preview.plan?.items.some((item) => item.action === "conflict") ?? false;
  const unsupported = preview.plan?.items.some((item) => item.action === "unsupported") ?? false;
  return (
    <div className="architecture-preview-stack">
      {(conflict || unsupported) && (
        <div className={conflict ? "architecture-banner conflict" : "architecture-banner unsupported"} role="alert">
          {conflict ? <AlertTriangle size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
          <span>
            <strong>{conflict ? "Conflict needs review" : "Target capability is incomplete"}</strong>
            <small>{conflict ? "The observed target differs from the selected revision. Review the dry-run plan before changing anything." : "The selected target cannot apply every desired operation. No live apply is available from this view."}</small>
          </span>
        </div>
      )}

      <section className="architecture-panel-section" aria-labelledby="architecture-diagram-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Topology</p>
            <h2 id="architecture-diagram-heading">Router and leaf map</h2>
          </div>
          <Badge variant="outline">{topology.nodes.length} nodes · {topology.edges.length} links</Badge>
        </div>
        <ArchitectureDiagram topology={topology} />
        <ArchitectureOutline outline={preview.outline} />
      </section>

      <section className="architecture-panel-section" aria-labelledby="architecture-effective-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Effective result</p>
            <h2 id="architecture-effective-heading">Skills available in this context</h2>
          </div>
          <span className="architecture-section-note">Authorization is resolved server-side.</span>
        </div>
        {preview.compiled.skills.length === 0 ? (
          <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No skills are effective for this profile and environment.</div>
        ) : (
          <div className="architecture-skill-table-wrap">
            <table className="architecture-skill-table">
              <thead><tr><th scope="col">Skill</th><th scope="col">Version</th><th scope="col">Exposure</th><th scope="col">Reason</th></tr></thead>
              <tbody>
                {preview.compiled.skills.map((skill) => {
                  const node = preview.compiled.nodes.find((candidate) => candidate.skillRefId === skill.skillRefId);
                  return (
                  <tr key={`${skill.skillRefId}:${skill.version}`}>
                    <th scope="row"><strong>{skill.title || skill.slug}</strong><small>{skill.slug}</small></th>
                    <td>{skill.version}</td>
                    <td><span className="architecture-exposure">{runtimeExposureLabel(node?.runtimeExposure)}</span></td>
                    <td>Enabled by profile {preview.compiled.profileId} for {preview.compiled.environmentId}; package access remains {skill.packageVisibility}.</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ArchitectureSyncPlan plan={preview.plan} />

      <section className="architecture-panel-section architecture-compile-section" aria-labelledby="architecture-compile-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Portable output</p>
            <h2 id="architecture-compile-heading">Compiled projection</h2>
          </div>
          <Badge variant="secondary"><TerminalSquare size={13} aria-hidden="true" /> Read-only</Badge>
        </div>
        <div className="architecture-compile-grid">
          <dl className="architecture-compile-facts">
            <div><dt>Revision</dt><dd>{preview.revision ? preview.revision.revisionNumber : "Revision unavailable"}</dd></div>
            <div><dt>Entrypoint</dt><dd>API projection</dd></div>
            <div><dt>Revision digest</dt><dd>{preview.compiled.revisionDigest || preview.graph.digest}</dd></div>
          </dl>
          <div className="architecture-mermaid-block">
            <div className="architecture-mermaid-heading">
              <span>Mermaid export</span>
              <div className="architecture-export-actions">
                <CopyDiagramButton value={preview.diagram.mermaid} label="Copy Mermaid architecture export" />
                <DownloadDiagramButton value={preview.diagram.mermaid} filename="architecture-diagram.mmd" mimeType="text/plain" label="Download Mermaid architecture export" />
              </div>
            </div>
            <pre aria-label="Mermaid architecture export">{preview.diagram.mermaid || "The API did not return a Mermaid projection for this revision."}</pre>
          </div>
        </div>
        <div className="architecture-export-grid" aria-label="Diagram exports">
          <div className="architecture-export-block">
            <div className="architecture-export-heading">
              <div><strong>Canonical diagram JSON</strong><small>Digest-excluded semantic payload for portable interchange.</small></div>
              <div className="architecture-export-actions">
                <CopyDiagramButton value={diagramJson} label="Copy canonical diagram JSON" />
                <DownloadDiagramButton value={diagramJson} filename="architecture-diagram.json" mimeType="application/json" label="Download canonical diagram JSON" />
              </div>
            </div>
            <pre aria-label="Canonical diagram JSON">{diagramJson}</pre>
          </div>
          <details className="architecture-outline-fallback">
            <summary>Plain-text outline fallback</summary>
            <p>Use this text-only projection when a visual diagram is not available.</p>
            <pre aria-label="Plain-text architecture outline">{preview.diagram.accessibleOutline}</pre>
          </details>
        </div>
      </section>
    </div>
  );
}

function ArchitectureDiagram({ topology }: { topology: { nodes: ArchitectureTopologyNode[]; edges: ArchitectureTopologyEdge[] } }) {
  const nodeWidth = 184;
  const nodeHeight = 60;
  const rowHeight = 102;
  const padding = 32;
  const columns = 3;
  const positions = new Map(topology.nodes.map((node, index) => {
    const serverPosition = node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
      ? node.position
      : { x: 40 + (index % columns) * 246, y: 22 + Math.floor(index / columns) * rowHeight };
    return [node.id, serverPosition] as const;
  }));
  const coordinates = Array.from(positions.values());
  const minX = Math.min(0, ...coordinates.map((position) => position.x));
  const minY = Math.min(0, ...coordinates.map((position) => position.y));
  const maxX = Math.max(nodeWidth, ...coordinates.map((position) => position.x + nodeWidth));
  const maxY = Math.max(nodeHeight, ...coordinates.map((position) => position.y + nodeHeight));
  const viewBoxX = minX - padding;
  const viewBoxY = minY - padding;
  const width = Math.max(760, maxX - minX + padding * 2);
  const height = Math.max(260, maxY - minY + padding * 2);
  return (
    <div className="architecture-diagram-shell">
      {topology.nodes.length === 0 ? (
        <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No topology nodes were returned.</div>
      ) : (
        <svg className="architecture-diagram" role="img" aria-labelledby="architecture-diagram-title architecture-diagram-description" viewBox={`${viewBoxX} ${viewBoxY} ${width} ${height}`}>
          <title id="architecture-diagram-title">Skill architecture topology</title>
          <desc id="architecture-diagram-description">A deterministic map of routers, sub-routers, and leaf skills returned by the API.</desc>
          <g className="architecture-diagram-edges" aria-hidden="true">
            {topology.edges.map((edge, index) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) {
                return null;
              }
              return <line key={edge.id ?? `${edge.from}:${edge.to}:${index}`} markerEnd="url(#architecture-arrow)" x1={from.x + 92} x2={to.x + 92} y1={from.y + 30} y2={to.y + 30} />;
            })}
          </g>
          <defs><marker id="architecture-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="6" refY="3"><path d="M0,0 L0,6 L6,3 z" /></marker></defs>
          <g className="architecture-diagram-nodes">
            {topology.nodes.map((node) => {
              const position = positions.get(node.id)!;
              const leaf = isLeafNodeKind(node.kind);
              return (
                <g key={node.id} transform={`translate(${position.x}, ${position.y})`}>
                  <rect className={leaf ? "architecture-diagram-node skill" : "architecture-diagram-node router"} height="60" rx="9" width="184" />
                  <text className="architecture-diagram-kind" x="14" y="19">{leaf ? "LEAF SKILL" : "ROUTER"}</text>
                  <text className="architecture-diagram-label" x="14" y="41">{truncateSvgLabel(node.label)}</text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

function ArchitectureOutline({ outline }: { outline: ArchitecturePreview["outline"] }) {
  return (
    <div className="architecture-outline">
      <div className="architecture-outline-heading"><h3>Accessible outline</h3><span>Same nodes as the diagram</span></div>
      {outline.tree.length === 0 ? <p className="architecture-muted">No outline is available.</p> : (
        <ol aria-label="Architecture topology outline">
          {outline.tree.map((node) => <ArchitectureOutlineItem key={node.id} node={node} />)}
        </ol>
      )}
    </div>
  );
}

function ArchitectureOutlineItem({ node }: { node: ArchitecturePreview["outline"]["tree"][number] }) {
  return (
    <li>
      <span className={isLeafNodeKind(node.kind) ? "architecture-outline-dot skill" : "architecture-outline-dot router"} aria-hidden="true" />
      <span><strong>{node.label}</strong><small>{isLeafNodeKind(node.kind) ? "Leaf skill" : "Router branch"}</small></span>
      {node.children.length > 0 && <ol>{node.children.map((child) => <ArchitectureOutlineItem key={child.id} node={child} />)}</ol>}
    </li>
  );
}

function topologyForPreview(preview: ArchitecturePreview): { nodes: ArchitectureTopologyNode[]; edges: ArchitectureTopologyEdge[] } {
  return {
    nodes: preview.graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.skillRefId ? { slug: node.skillRefId } : {}),
      depth: node.depth,
      position: { x: node.x, y: node.y },
    })),
    edges: preview.graph.edges.map((edge, index) => ({
      id: `edge-${index + 1}`,
      from: edge.from,
      to: edge.to,
      relationship: edge.kind,
    })),
  };
}

function ArchitectureSyncPlan({ plan }: { plan?: ArchitecturePreviewPlan }) {
  if (!plan) {
    return (
      <section className="architecture-panel-section" aria-labelledby="architecture-sync-heading">
        <div className="architecture-panel-section-heading">
          <div>
            <p className="architecture-kicker">Target reconciliation</p>
            <h2 id="architecture-sync-heading">Dry-run sync plan</h2>
          </div>
          <span className="architecture-sync-status">Not generated</span>
        </div>
        <div className="architecture-empty-inline" role="status">
          <CircleAlert size={17} aria-hidden="true" /> No sync plan generated. Provide an observed-state fixture to preview a target dry run.
        </div>
      </section>
    );
  }

  const conflict = plan.items.some((item) => item.action === "conflict");
  const unsupported = plan.items.some((item) => item.action === "unsupported");
  const changes = plan.items.filter((item) => item.action !== "noop");
  const status = conflict ? "Conflict" : unsupported ? "Unsupported" : changes.length === 0 ? "No changes" : `${changes.length} dry-run changes`;
  return (
    <section className="architecture-panel-section" aria-labelledby="architecture-sync-heading">
      <div className="architecture-panel-section-heading">
        <div>
          <p className="architecture-kicker">Target reconciliation</p>
          <h2 id="architecture-sync-heading">Dry-run sync plan</h2>
        </div>
        <span className={`architecture-sync-status ${conflict ? "conflict" : unsupported ? "unsupported" : ""}`}>{status}</span>
      </div>
      <p className="architecture-sync-note"><ShieldCheck size={15} aria-hidden="true" /> No target is changed by this preview. Target: {plan.targetId}.</p>
      {changes.length === 0 ? (
        <div className="architecture-empty-inline"><Check size={17} aria-hidden="true" /> Target already matches the selected desired state.</div>
      ) : (
        <div className="architecture-sync-list" role="list">
          {changes.map((change, index) => <SyncChangeRow change={change} key={`${change.action}:${change.nodeId}:${index}`} />)}
        </div>
      )}
    </section>
  );
}

function SyncChangeRow({ change }: { change: ArchitecturePreviewPlan["items"][number] }) {
  const tone = change.action === "conflict" || change.action === "unsupported" ? "danger" : change.action === "noop" ? "neutral" : "normal";
  return (
    <div className={`architecture-sync-row ${tone}`} role="listitem">
      <span className="architecture-sync-type">{change.action.replace(/-/g, " ")}</span>
      <span><strong>{change.skillRefId ?? change.nodeId}</strong><small>{change.reason}</small></span>
    </div>
  );
}

function CopyDiagramButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value || !navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return <Button aria-label={label} className="architecture-copy-button" size="xs" type="button" variant="outline" disabled={!value} onClick={() => void copy()}><Clipboard size={13} aria-hidden="true" /> {copied ? "Copied" : "Copy"}</Button>;
}

function DownloadDiagramButton({ value, filename, mimeType, label }: { value: string; filename: string; mimeType: string; label: string }) {
  function download() {
    if (!value || typeof URL.createObjectURL !== "function") return;
    const blob = new Blob([value], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.setAttribute("aria-label", label);
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <Button aria-label={label} className="architecture-copy-button" size="xs" type="button" variant="outline" disabled={!value} onClick={download}><Download size={13} aria-hidden="true" /> Download</Button>;
}
