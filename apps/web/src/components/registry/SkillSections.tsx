import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SkillReleaseSummary } from "../../api.js";
import { changeKindLabel, chipTone, lifecycleLabel, releaseVersionLabel, shortDate } from "./status-display.js";
import { isPublishedRelease, sectionPanelId, sectionTabId, type SkillTab } from "./skill-workspace.js";

const TAB_LABELS: Record<SkillTab, string> = { overview: "Overview", versions: "Versions", manage: "Manage" };

/** Manual-activation tabs: arrows move focus, Enter or Space selects (and records history). */
export function SkillSectionTabs({ active, baseId, onSelect, tabs }: { active: SkillTab; baseId: string; onSelect: (tab: SkillTab) => void; tabs: SkillTab[] }) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <div aria-label="Skill sections" className="skill-tabs" ref={listRef} role="tablist">
      {tabs.map((tab, index) => (
        <button
          aria-controls={sectionPanelId(baseId)}
          aria-selected={tab === active}
          id={sectionTabId(baseId, tab)}
          key={tab}
          role="tab"
          tabIndex={tab === active ? 0 : -1}
          type="button"
          onClick={() => { if (tab !== active) onSelect(tab); }}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

/**
 * Release history for the selected skill. Readers see published releases;
 * managers see every release record the server returned, with its state.
 */
export function SkillVersionsPanel({
  historyState,
  latestVersion,
  onRetry,
  onSelect,
  releases,
  selectedVersion,
  versionHref,
}: {
  historyState: "idle" | "loading" | "ready" | "error";
  latestVersion: string | null;
  onRetry: () => void;
  onSelect: (version: string) => void;
  releases: SkillReleaseSummary[];
  selectedVersion: string | null;
  versionHref: (version: string) => string;
}) {
  if (historyState === "loading" || historyState === "idle") return <p className="registry-muted" role="status">Loading release history…</p>;
  if (historyState === "error") {
    return (
      <div className="registry-list-state" role="status">
        <strong>Release history is unavailable.</strong>
        <Button size="sm" type="button" variant="outline" onClick={onRetry}><RotateCw size={15} aria-hidden="true" />Retry release history</Button>
      </div>
    );
  }
  if (releases.length === 0) return <p className="registry-muted" role="status">No release history is available.</p>;
  return (
    <ol aria-label="Release history" className="skill-version-list">
      {releases.map((item) => {
        const published = isPublishedRelease(item);
        const status = lifecycleLabel(item.lifecycleStatus);
        return (
          <li key={item.version}>
            <a
              aria-current={item.version === selectedVersion ? "true" : undefined}
              className="skill-version-row"
              href={versionHref(item.version)}
              onClick={(event) => followLink(event, () => onSelect(item.version))}
            >
              <span className="skill-version-name">
                <code title={item.version}>{releaseVersionLabel(item.version, releases)}</code>
                {item.version === latestVersion && <>{" "}<span className="registry-chip" data-tone="teal">Latest</span></>}
              </span>
              {" "}
              <span className="skill-version-meta">
                {published ? <span>Published {shortDate(item.publishedAt)}</span> : <span className="registry-chip" data-tone="amber">Not published</span>}
                {(!published || item.lifecycleStatus !== "approved") && <>{" "}<span className="registry-chip" data-tone={chipTone(status.tone)}>{status.label}</span></>}
                {item.changeKind && <>{" "}<span>{changeKindLabel(item.changeKind)}</span></>}
              </span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Exact version control for a management-only record, which has no readable
 * release card. It lists the release records the server returned to the manager.
 */
export function ManagedReleaseSelect({ onSelect, releases, version }: { onSelect: (version: string) => void; releases: SkillReleaseSummary[]; version: string | null }) {
  if (releases.length === 0) return null;
  return (
    <label className="skill-managed-version">
      <span>Release version</span>
      <select value={version ?? ""} onChange={(event) => onSelect(event.target.value)}>
        {version === null && <option value="" disabled>Choose an exact release</option>}
        {version !== null && !releases.some((item) => item.version === version) && <option value={version} disabled>Unavailable exact version</option>}
        {releases.map((item) => (
          <option key={item.version} value={item.version}>
            {releaseVersionLabel(item.version, releases)}{isPublishedRelease(item) ? "" : ` · ${item.publishedAt ? lifecycleLabel(item.lifecycleStatus).label : "Not published"}`}
          </option>
        ))}
      </select>
    </label>
  );
}

function followLink(event: MouseEvent<HTMLAnchorElement>, callback: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  callback();
}
