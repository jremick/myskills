import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { canonicalArchitectureDiagramArtifactJson } from "@myskills-app/core";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Clipboard,
  Download,
  Search,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { ArchitectureExplorer } from "./ArchitectureExplorer.js";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type ArchitecturePreview,
  type ArchitecturePreviewPlan,
} from "../../api.js";
import {
  packageVisibilityLabel,
  runtimeExposureLabel,
} from "./architecture-dashboard-helpers.js";

/** The full API result stack, used for the Workbench's unsaved draft preview. */
export function ArchitecturePreviewPanel({ preview }: { preview: ArchitecturePreview }) {
  const headingId = useId();
  return (
    <div className="architecture-preview-stack">
      <ArchitecturePlanBanner preview={preview} />
      <section className="architecture-panel-section" aria-labelledby={headingId}>
        <div className="architecture-panel-section-heading">
          <h3 id={headingId}>Draft structure</h3>
        </div>
        <ArchitectureExplorer preview={preview} />
      </section>
      <ArchitectureSkillsSection preview={preview} />
      <ArchitectureSyncPlan plan={preview.plan} />
      <ArchitectureCompiledSection preview={preview} />
    </div>
  );
}

export function ArchitecturePlanBanner({ preview }: { preview: ArchitecturePreview }) {
  const conflict = preview.plan?.items.some((item) => item.action === "conflict") ?? false;
  const unsupported = preview.plan?.items.some((item) => item.action === "unsupported") ?? false;
  if (!conflict && !unsupported) return null;
  return (
    <div className={conflict ? "architecture-banner conflict" : "architecture-banner unsupported"} role="alert">
      {conflict ? <AlertTriangle size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
      <span>
        <strong>{conflict ? "Conflict needs review" : "Target capability is incomplete"}</strong>
        <small>{conflict ? "The observed target differs from the selected revision. Review the dry-run plan before changing anything." : "The selected target cannot apply every desired operation. No live apply is available from this view."}</small>
      </span>
    </div>
  );
}

type SkillExposureFilter = "all" | "leaf" | "router";

interface ArchitectureSkillRow {
  key: string;
  skillRefId: string;
  title: string;
  slug: string;
  version: string;
  digest: string;
  packageVisibility: string;
  /** Exposed nodes that use this skill in the compiled projection. */
  nodeIds: string[];
  branches: string[];
  exposures: Array<"router" | "leaf">;
}

/**
 * Effective skills for the selected context. Rows come only from the compiled
 * projection the API returned for this reader, so filters never reveal more.
 */
export function ArchitectureSkillsSection({ preview, contextLabel, onShowInStructure }: {
  preview: ArchitecturePreview;
  /** Readable name of the selected profile and environment. */
  contextLabel?: string;
  /** Selects the skill's node on the Structure tab. */
  onShowInStructure?: (nodeId: string) => void;
}) {
  const headingId = useId();
  const searchId = useId();
  const exposureId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [exposure, setExposure] = useState<SkillExposureFilter>("all");
  const rows = useMemo(() => architectureSkillRows(preview), [preview]);
  const normalized = query.trim().toLowerCase();
  const visible = rows.filter((row) => (exposure === "all" || row.exposures.includes(exposure))
    && (!normalized || [row.title, row.slug, row.version, ...row.branches].some((value) => value.toLowerCase().includes(normalized))));
  const filtered = normalized !== "" || exposure !== "all";
  function clearFilters() {
    setQuery("");
    setExposure("all");
    searchRef.current?.focus();
  }
  return (
    <section className="architecture-panel-section architecture-skills-section" aria-labelledby={headingId}>
      <div className="architecture-panel-section-heading">
        <h3 id={headingId}>Skills available in this context</h3>
        <span className="architecture-section-note">{contextLabel ? `Exposure in ${contextLabel}. ` : ""}Routers are not counted.</span>
      </div>
      {rows.length === 0 ? (
        <div className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> No skills are effective for this profile and environment.</div>
      ) : (
        <>
          <div className="architecture-skills-toolbar">
            <div className="architecture-skills-search">
              <Search size={15} aria-hidden="true" />
              <label className="sr-only" htmlFor={searchId}>Search skills</label>
              <Input
                autoComplete="off"
                id={searchId}
                placeholder="Search skills, versions and branches"
                ref={searchRef}
                spellCheck={false}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.preventDefault();
                    setQuery("");
                  }
                }}
              />
            </div>
            <div className="architecture-skills-filter">
              <label htmlFor={exposureId}>Exposure</label>
              <select id={exposureId} value={exposure} onChange={(event) => setExposure(event.target.value as SkillExposureFilter)}>
                <option value="all">All exposures</option>
                <option value="leaf">Direct leaf</option>
                <option value="router">Router only</option>
              </select>
            </div>
            <span className="architecture-section-note" role="status">
              {filtered ? `Showing ${visible.length} of ${pluralize(rows.length, "skill")}` : pluralize(rows.length, "skill")}
            </span>
          </div>
          {visible.length === 0 ? (
            <div className="architecture-empty-inline architecture-skills-empty">
              <Search size={17} aria-hidden="true" />
              <span>{normalized ? `No skills match “${query.trim()}”.` : "No skills match this exposure filter."}</span>
              <Button size="sm" type="button" variant="outline" onClick={clearFilters}>Clear filters</Button>
            </div>
          ) : (
            <div className="architecture-skill-table-wrap">
              <table className="architecture-skill-table">
                <thead><tr><th scope="col">Skill</th><th scope="col">Branch</th><th scope="col">Version</th><th scope="col">Exposure</th><th scope="col">Package access</th></tr></thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">
                        <strong>{row.title}</strong>
                        <small>{row.slug}</small>
                        {onShowInStructure && row.nodeIds[0] && (
                          <button className="architecture-skill-locate" type="button" onClick={() => onShowInStructure(row.nodeIds[0]!)}>
                            Show in structure<span className="sr-only">: {row.title}</span>
                          </button>
                        )}
                      </th>
                      <td>{row.branches.length > 0 ? row.branches.join(", ") : "Top level"}</td>
                      <td><span className="architecture-skill-version">{row.version}</span><small className="architecture-skill-digest" title={row.digest}>{row.digest.slice(0, 12)}</small></td>
                      <td>
                        {row.exposures.length === 0
                          ? <span className="architecture-exposure excluded">{runtimeExposureLabel(undefined)}</span>
                          : row.exposures.map((value) => <span className="architecture-exposure" key={value}>{runtimeExposureLabel(value)}</span>)}
                      </td>
                      <td>{packageVisibilityLabel(row.packageVisibility)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function architectureSkillRows(preview: ArchitecturePreview): ArchitectureSkillRow[] {
  const nodes = preview.compiled.nodes;
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const parents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const childId of node.childNodeIds) parents.set(childId, [...(parents.get(childId) ?? []), node.id]);
  }
  return preview.compiled.skills.map((skill) => {
    const skillNodes = nodes.filter((node) => node.skillRefId === skill.skillRefId);
    const branches = new Set<string>();
    for (const node of skillNodes) {
      for (const parentId of parents.get(node.id) ?? []) {
        const label = labels.get(parentId);
        if (label) branches.add(label);
      }
    }
    return {
      key: `${skill.skillRefId}:${skill.version}`,
      skillRefId: skill.skillRefId,
      title: skill.title || skill.slug,
      slug: skill.slug,
      version: skill.version,
      digest: skill.digest,
      packageVisibility: skill.packageVisibility,
      nodeIds: skillNodes.map((node) => node.id),
      branches: [...branches].sort((left, right) => left.localeCompare(right)),
      exposures: [...new Set(skillNodes.map((node) => node.runtimeExposure))].sort(),
    };
  });
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Saved-revision technical output: sync plan, observed fixture and exports. */
export function ArchitectureTechnicalDetails({ preview, fixture }: { preview: ArchitecturePreview; fixture?: ReactNode }) {
  return (
    <details className="cp-details architecture-technical-details">
      <summary>Technical details</summary>
      <div className="cp-details-body">
        <ArchitectureSyncPlan plan={preview.plan} />
        {fixture}
        <ArchitectureCompiledSection preview={preview} />
      </div>
    </details>
  );
}

function ArchitectureCompiledSection({ preview }: { preview: ArchitecturePreview }) {
  const headingId = useId();
  const diagramJson = canonicalArchitectureDiagramArtifactJson(preview.diagram);
  return (
      <section className="architecture-panel-section architecture-compile-section" aria-labelledby={headingId}>
        <div className="architecture-panel-section-heading">
          <h3 id={headingId}>Compiled projection</h3>
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
  );
}

function ArchitectureSyncPlan({ plan }: { plan?: ArchitecturePreviewPlan }) {
  const headingId = useId();
  if (!plan) {
    return (
      <section className="architecture-panel-section" aria-labelledby={headingId}>
        <div className="architecture-panel-section-heading">
          <h3 id={headingId}>Dry-run sync plan</h3>
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
    <section className="architecture-panel-section" aria-labelledby={headingId}>
      <div className="architecture-panel-section-heading">
        <h3 id={headingId}>Dry-run sync plan</h3>
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
