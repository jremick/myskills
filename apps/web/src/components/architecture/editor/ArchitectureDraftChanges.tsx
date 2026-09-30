import { useId, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Eye,
  Minus,
  Monitor,
  PackageCheck,
  PencilLine,
  Plus,
  UserRound,
} from "lucide-react";
import type { ArchitectureDraftChangeKind } from "./architecture-draft-changes.js";
import type { ArchitectureDraftChangesProps } from "./types.js";

const CHANGE_ICONS: Record<ArchitectureDraftChangeKind, typeof Plus> = {
  rename: PencilLine,
  add: Plus,
  remove: Minus,
  move: ArrowRight,
  release: PackageCheck,
  exposure: Eye,
  profile: UserRound,
  environment: Monitor,
  other: Ellipsis,
};

/**
 * Named differences between the revision a draft started from and the
 * current draft, shown before saving. Collapsed, it keeps one line (the
 * selected node's change when there is one) so editing never shifts the
 * layout; expanded, it lists every change up to `limit` and counts the rest.
 */
export function ArchitectureDraftChanges({
  changes,
  baselineLabel,
  focusNodeId = null,
  limit = 50,
  className,
}: ArchitectureDraftChangesProps) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const count = changes.length;
  const expandable = count > 1;
  const open = expanded && expandable;
  const maxVisible = Math.max(1, Math.floor(limit));
  const leading = (focusNodeId ? changes.find((change) => change.nodeId === focusNodeId) : undefined) ?? changes[0];
  const visible = open ? changes.slice(0, maxVisible) : leading ? [leading] : [];
  const remaining = open ? count - visible.length : 0;
  const classes = ["architecture-draft-changes", open ? "is-expanded" : "", className ?? ""].filter(Boolean).join(" ");

  return (
    <section
      className={classes}
      aria-label="Draft changes"
      data-testid="architecture-draft-changes"
      data-state={count > 0 ? "changed" : "empty"}
      data-count={count}
    >
      <div className="architecture-draft-changes-head">
        <h3>Draft changes</h3>
        <span className="architecture-draft-changes-count" data-testid="architecture-draft-changes-count">
          {count}<span className="architecture-draft-changes-sr"> {count === 1 ? "change" : "changes"}</span>
        </span>
        {baselineLabel && <span className="architecture-draft-changes-baseline">Compared with {baselineLabel}</span>}
      </div>
      {expandable && (
        <button
          type="button"
          className="architecture-draft-changes-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          {open ? "Show less" : `Show all ${count}`}
        </button>
      )}
      {count === 0 ? (
        <p className="architecture-draft-changes-empty">No changes in this draft yet. Renames, moves and other edits appear here before you save.</p>
      ) : (
        <div
          className="architecture-draft-changes-body"
          id={bodyId}
          role={open ? "group" : undefined}
          aria-label={open ? "All draft changes" : undefined}
          tabIndex={open ? 0 : undefined}
        >
          <ul className="architecture-draft-changes-list">
            {visible.map((change) => {
              const Icon = CHANGE_ICONS[change.kind];
              return (
                <li key={change.id} data-kind={change.kind}>
                  <Icon size={14} aria-hidden="true" />
                  <span title={change.summary}>{change.summary}</span>
                </li>
              );
            })}
            {remaining > 0 && <li className="architecture-draft-changes-more">and {remaining} more</li>}
          </ul>
        </div>
      )}
    </section>
  );
}
