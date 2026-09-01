import { useMemo } from "react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type ArchitectureDetail,
  type ArchitectureRevisionRecord,
  type ArchitectureRevisionSummary,
} from "../../api.js";
import { revisionLabel } from "./architecture-dashboard-helpers.js";

interface ArchitectureRevisionDiffCounts {
  added: number;
  removed: number;
  changed: number;
}

interface ArchitectureRevisionDiff {
  skills: ArchitectureRevisionDiffCounts;
  nodes: ArchitectureRevisionDiffCounts;
  edges: ArchitectureRevisionDiffCounts;
  profiles: ArchitectureRevisionDiffCounts;
  environments: ArchitectureRevisionDiffCounts;
  bindings: ArchitectureRevisionDiffCounts;
}

export function RevisionHistoryPanel({
  detail,
  selectedRevisionId,
  selectedRevision,
  state,
  message,
  readOnly,
  revisionDetailsAvailable = true,
  onSelect,
  onUseAsDraft,
}: {
  detail: ArchitectureDetail;
  selectedRevisionId: string | null;
  selectedRevision: ArchitectureRevisionRecord | null;
  state: "idle" | "loading" | "error";
  message: string | null;
  readOnly: boolean;
  /** Organization-only projections expose revision summaries, not specs. */
  revisionDetailsAvailable?: boolean;
  onSelect: (revisionId: string) => Promise<void>;
  onUseAsDraft: (revision: ArchitectureRevisionRecord) => void;
}) {
  const revisions = useMemo(() => {
    const entries = new Map<string, ArchitectureRevisionSummary>();
    for (const revision of detail.revisions ?? []) entries.set(revision.id, revision);
    if (detail.latestRevision) entries.set(detail.latestRevision.id, detail.latestRevision);
    return [...entries.values()].sort((left, right) => right.revisionNumber - left.revisionNumber || right.id.localeCompare(left.id));
  }, [detail.latestRevision, detail.revisions]);
  const latestId = detail.latestRevision?.id ?? null;
  const selectedIsOlder = Boolean(selectedRevision && latestId && selectedRevision.id !== latestId);
  const diff = selectedIsOlder && detail.latestRevision
    ? semanticRevisionDiff(selectedRevision!.spec, detail.latestRevision.spec)
    : null;

  return (
    <section className="architecture-history-panel" aria-labelledby="architecture-history-heading" data-testid="architecture-history-panel">
      <div className="architecture-history-heading">
        <div>
          <p className="architecture-kicker">Immutable history</p>
          <h2 id="architecture-history-heading">Revision history</h2>
        </div>
        <span className="architecture-section-note">
          {revisionDetailsAvailable
            ? "Selecting history never changes saved state."
            : "Revision metadata is visible; full revision content is restricted for this shared architecture."}
        </span>
      </div>
      {revisions.length === 0 ? (
        <p className="architecture-muted">No immutable revisions yet. The first revision can be bootstrapped below.</p>
      ) : (
        <div className="architecture-history-layout">
          <ol className="architecture-history-list" aria-label="Architecture revisions">
            {revisions.map((revision) => {
              const current = revision.id === latestId;
              const selected = revision.id === selectedRevisionId;
              return (
                <li key={revision.id}>
                  <button
                    type="button"
                    className={selected ? "architecture-history-row selected" : "architecture-history-row"}
                    aria-pressed={selected}
                    disabled={!revisionDetailsAvailable}
                    title={!revisionDetailsAvailable ? "Full revision history is restricted for this shared architecture." : undefined}
                    onClick={() => void onSelect(revision.id)}
                  >
                    <span className="architecture-history-row-main">
                      <strong>{current ? `Current · ${revisionLabel(revision)}` : revisionLabel(revision)}</strong>
                      <small>{revision.message || "No message"}</small>
                    </span>
                    {current && <Badge variant="secondary">Current</Badge>}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="architecture-history-detail" aria-live="polite">
            {state === "loading" && <p className="architecture-muted">Loading the selected immutable revision…</p>}
            {state === "error" && message && <div className="architecture-inline-message" role="alert">{message}</div>}
            {state !== "loading" && state !== "error" && selectedRevision && !selectedIsOlder && (
              <>
                <strong>Current revision selected</strong>
                <p>The editor and persisted preview use this revision as their canonical baseline.</p>
              </>
            )}
            {state !== "loading" && state !== "error" && selectedRevision && selectedIsOlder && diff && (
              <>
                <div className="architecture-history-detail-heading">
                  <strong>{revisionLabel(selectedRevision)} compared with current</strong>
                  {!readOnly && <Button size="sm" type="button" variant="outline" onClick={() => onUseAsDraft(selectedRevision)}>Use as new draft</Button>}
                </div>
                <p>Semantic changes from this older revision to the current revision. Content metadata and digests are not displayed.</p>
                <dl className="architecture-history-diff-grid">
                  {revisionDiffFacts(diff).map((fact) => <div key={fact.label}><dt>{fact.label}</dt><dd><span>+{fact.counts.added}</span><span>−{fact.counts.removed}</span><span>~{fact.counts.changed}</span></dd></div>)}
                </dl>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function semanticRevisionDiff(from: ArchitectureSpecV1, to: ArchitectureSpecV1): ArchitectureRevisionDiff {
  return {
    skills: diffCollection(from.skills, to.skills, (skill) => skill.id, (skill) => ({
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      version: skill.version,
      digest: skill.digest,
      packageVisibility: skill.packageVisibility,
      tags: [...(skill.tags ?? [])].sort(),
    })),
    nodes: diffCollection(from.nodes, to.nodes, (node) => node.id, (node) => ({ id: node.id, kind: node.kind, label: node.label, skillRefId: "skillRefId" in node ? node.skillRefId : undefined })),
    edges: diffCollection(from.edges, to.edges, (edge) => `${edge.from}\u0000${edge.to}\u0000${edge.kind}`, (edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
    profiles: diffCollection(from.profiles, to.profiles, (profile) => profile.id, (profile) => ({ id: profile.id, name: profile.name, subject: profile.subject })),
    environments: diffCollection(from.environments, to.environments, (environment) => environment.id, (environment) => ({ id: environment.id, name: environment.name, kind: environment.kind, profileId: environment.profileId, parentId: environment.parentId ?? null })),
    bindings: diffCollection(
      flattenArchitectureBindings(from),
      flattenArchitectureBindings(to),
      (binding) => binding.key,
      (binding) => ({ enabled: binding.enabled, runtimeExposure: binding.runtimeExposure }),
    ),
  };
}

function flattenArchitectureBindings(spec: ArchitectureSpecV1): Array<{ key: string; enabled: boolean; runtimeExposure: string }> {
  return spec.profiles.flatMap((profile) => profile.bindings.map((binding) => ({
    key: `${profile.id}\u0000${binding.nodeId}\u0000${(binding.environmentIds ?? []).slice().sort().join(",")}`,
    enabled: binding.enabled,
    runtimeExposure: binding.runtimeExposure,
  })));
}

function diffCollection<T>(from: readonly T[], to: readonly T[], keyOf: (value: T) => string, project: (value: T) => unknown): ArchitectureRevisionDiffCounts {
  const fromMap = new Map(from.map((value) => [keyOf(value), project(value)]));
  const toMap = new Map(to.map((value) => [keyOf(value), project(value)]));
  let changed = 0;
  for (const [key, value] of fromMap) {
    if (toMap.has(key) && stableJson(value) !== stableJson(toMap.get(key))) changed += 1;
  }
  let added = 0;
  for (const key of toMap.keys()) if (!fromMap.has(key)) added += 1;
  let removed = 0;
  for (const key of fromMap.keys()) if (!toMap.has(key)) removed += 1;
  return { added, removed, changed };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function revisionDiffFacts(diff: ArchitectureRevisionDiff): Array<{ label: string; counts: ArchitectureRevisionDiffCounts }> {
  return [
    { label: "Skills", counts: diff.skills },
    { label: "Nodes", counts: diff.nodes },
    { label: "Edges", counts: diff.edges },
    { label: "Profiles", counts: diff.profiles },
    { label: "Environments", counts: diff.environments },
    { label: "Bindings", counts: diff.bindings },
  ];
}

/**
 * A first-revision editor needs a local semantic shell so the owner can use
 * the exact-release picker. It is never submitted or treated as an API
 * revision until the user saves a valid draft.
 */
