import { useId, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Shuffle,
  SquarePen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArchitectureExplorer, type ArchitectureExplorerView } from "./ArchitectureExplorer.js";
import { ArchitectureOrganizationGrantsCard } from "./ArchitectureOrganizationGrantsCard.js";
import { ArchitecturePatternMigrationCard } from "./ArchitecturePatternMigrationCard.js";
import {
  type ArchitectureDetail,
  type ArchitectureObservedFixture,
  type ArchitecturePattern,
  type ArchitecturePatternMigrationCreateResult,
  type ArchitecturePreview,
  type ArchitectureRevisionRecord,
  type ArchitectureSummary,
  type RegistryClient,
} from "../../api.js";
import {
  architectureRevisionLabel,
  patternLabel,
  revisionLabel,
} from "./architecture-dashboard-helpers.js";
import { ArchitectureState, ArchitectureDetailLoading } from "./ArchitectureDashboardFeedback.js";
import {
  ArchitecturePlanBanner,
  ArchitectureSkillsSection,
  ArchitectureTechnicalDetails,
} from "./ArchitectureDashboardPreviewPanel.js";
import { ObservedFixturePreviewCard } from "./ArchitectureDashboardEditorPanels.js";
import { RevisionHistoryPanel } from "./ArchitectureDashboardHistoryPanel.js";
import { ArchitectureTabList, ArchitectureTabPanel, type ArchitectureTab } from "./ArchitectureTabs.js";
import type { ArchitectureLoadState } from "./architecture-dashboard-types.js";

export type ArchitectureOverviewTab = "overview" | "skills" | "history" | "access";

export interface ArchitectureLauncher {
  href: string;
  label: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
  ref: RefObject<HTMLAnchorElement | null>;
}

/**
 * Saved-revision overview. Editing happens on the Workbench surface.
 *
 * Tab ids keep their original keys ("overview" is Structure, "access" is
 * Sharing) so existing state and panel ids stay stable.
 */
export function ArchitectureDetailPanel({
  tab,
  onTabChange,
  selectedNodeId,
  onSelectNode,
  structureView,
  onStructureViewChange,
  onEditNode,
  contextLabel,
  architecture,
  detail,
  detailState,
  message,
  preview,
  historyRevisionId,
  historyRevision,
  historyState,
  historyMessage,
  patterns,
  organizationOnly,
  contextAvailable,
  contextSelectors,
  notices,
  launcher,
  hasUnsavedDraft,
  fixtureKey,
  onHistorySelect,
  onUseRevisionAsDraft,
  onFixturePreview,
  onPatternMigrationCreated,
  client,
  onRetry,
  titleRef,
  onBack,
}: {
  tab: ArchitectureOverviewTab;
  onTabChange: (tab: ArchitectureOverviewTab) => void;
  /** Shared with the Workbench; validated by the dashboard against the loaded projection. */
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  structureView: ArchitectureExplorerView;
  onStructureViewChange: (view: ArchitectureExplorerView) => void;
  /** Present only when the reader can save revisions of this architecture. */
  onEditNode?: (id: string) => void;
  /** Readable profile and environment (or organization) of the preview. */
  contextLabel?: string;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  /** Shown in the stacked layout; returns to the list without unmounting the draft. */
  onBack?: () => void;
  architecture: ArchitectureSummary | null;
  detail: ArchitectureDetail | null;
  detailState: ArchitectureLoadState;
  message: string | null;
  preview: ArchitecturePreview | null;
  historyRevisionId: string | null;
  historyRevision: ArchitectureRevisionRecord | null;
  historyState: "idle" | "loading" | "error";
  historyMessage: string | null;
  patterns: ArchitecturePattern[];
  organizationOnly: boolean;
  /** False when the saved revision declares no preview context yet. */
  contextAvailable: boolean;
  contextSelectors: ReactNode;
  notices?: ReactNode;
  launcher: ArchitectureLauncher | null;
  hasUnsavedDraft: boolean;
  fixtureKey: string;
  onHistorySelect: (revisionId: string) => Promise<void>;
  onUseRevisionAsDraft: (revision: ArchitectureRevisionRecord) => void;
  onFixturePreview: (fixture: ArchitectureObservedFixture) => Promise<void>;
  onPatternMigrationCreated: (result: ArchitecturePatternMigrationCreateResult) => void;
  client: RegistryClient;
  onRetry: () => void;
}) {
  const idPrefix = useId();
  // Scoped to one architecture so switching closes the disclosure.
  const [patternOpenFor, setPatternOpenFor] = useState<string | null>(null);
  const back = onBack && (
    <Button className="cp-back" type="button" variant="ghost" onClick={onBack}>
      <ArrowLeft size={16} aria-hidden="true" />
      Back to architectures
    </Button>
  );
  if (!architecture) {
    return (
      <div className="cp-detail">
        {back}
        <p className="cp-inspector-empty">Choose a saved architecture to inspect its topology, effective skills, and dry-run sync plan.</p>
      </div>
    );
  }

  const canAppend = detail?.access?.canAppend ?? architecture.access?.canAppend ?? false;
  const canManage = detail?.access?.canManage ?? architecture.access?.canManage ?? false;
  const readOnly = !canAppend;
  const ownerType = detail?.access?.ownerType ?? architecture.access?.ownerType ?? architecture.owner?.type;
  const currentRevision = detail?.latestRevision ?? null;
  const revisionText = currentRevision
    ? revisionLabel(currentRevision)
    : architecture.latestRevision || architecture.revisionCount ? architectureRevisionLabel(architecture) : "No revision yet";
  const tabs: Array<ArchitectureTab<ArchitectureOverviewTab>> = [
    { id: "overview", label: "Structure" },
    { id: "skills", label: <>Skills{preview && <span className="architecture-tab-count">{preview.compiled.skills.length}</span>}</> },
    { id: "history", label: "History" },
    ...(detail && canManage ? [{ id: "access" as const, label: "Sharing" }] : []),
  ];
  const selectedTab = tabs.some((candidate) => candidate.id === tab) ? tab : "overview";
  const LauncherIcon = hasUnsavedDraft ? ArrowRight : SquarePen;
  const patternPanelId = `${idPrefix}-pattern`;
  const patternOpen = patternOpenFor === architecture.id;

  return (
    <article className="cp-detail architecture-detail" aria-labelledby="architecture-detail-title">
      <header className="cp-detail-head architecture-overview-head">
        {back}
        <div className="architecture-overview-title">
          <div className="cp-title-block">
            <h2 id="architecture-detail-title" ref={titleRef} tabIndex={-1}>{architecture.name}</h2>
            <p className="cp-meta">{architecture.description || "No description supplied."}</p>
            <p className="architecture-access-note cp-meta architecture-meta-line" data-testid="architecture-access-note">
              <span>{patternLabel(architecture.patternId)}</span>
              <span>{revisionText}</span>
              <span>{ownerType === "team" ? "Team-owned" : "Personal owner"}</span>
              <span data-access={readOnly ? "read-only" : "append"}>{readOnly ? "Read-only access" : "Can save revisions"}</span>
            </p>
          </div>
          {(launcher || (detail && canManage)) && (
            <div className="architecture-overview-actions">
              {detail && canManage && (
                <Button
                  aria-controls={patternPanelId}
                  aria-expanded={patternOpen}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => setPatternOpenFor(patternOpen ? null : architecture.id)}
                >
                  <Shuffle size={15} aria-hidden="true" />Change pattern
                  <ChevronDown className="architecture-disclosure-chevron" size={14} aria-hidden="true" />
                </Button>
              )}
              {launcher && (
                <Button asChild className="architecture-launcher" size="sm">
                  <a href={launcher.href} ref={launcher.ref} onClick={launcher.onClick}>
                    <LauncherIcon size={15} aria-hidden="true" />{launcher.label}
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>
        {contextSelectors}
      </header>
      {detail && canManage && (
        // Stays mounted while closed, which preserves the migration draft and
        // its retry idempotency key.
        <section aria-label="Change pattern" className="architecture-pattern-panel" hidden={!patternOpen} id={patternPanelId}>
          <ArchitecturePatternMigrationCard
            key={`pattern-migration:${architecture.id}:${detail.latestRevision?.id ?? "empty"}`}
            architectureId={architecture.id}
            architectureName={architecture.name}
            currentPatternId={architecture.patternId}
            currentRevisionId={detail.latestRevision?.id ?? architecture.currentRevisionId ?? null}
            detail={detail}
            patterns={patterns}
            client={client}
            onCreated={onPatternMigrationCreated}
          />
        </section>
      )}
      {hasUnsavedDraft && (
        <p className="architecture-draft-note" role="status"><CircleAlert size={15} aria-hidden="true" /> You have an unsaved draft in the workbench.</p>
      )}
      {notices}

      <ArchitectureTabList className="architecture-overview-tabs" idPrefix={idPrefix} label="Architecture sections" selected={selectedTab} tabs={tabs} onSelect={onTabChange} />
      <div className="architecture-preview-stack">
        <ArchitectureTabPanel className="architecture-overview-panel" id="overview" idPrefix={idPrefix} selected={selectedTab}>
          {detailState === "loading" && <ArchitectureDetailLoading />}
          {detailState !== "loading" && message && (
            <ArchitectureState state={detailState} message={message} onRetry={onRetry} compact />
          )}
          {detailState !== "loading" && !message && detail && !contextAvailable && (
            <div className="architecture-empty-inline" role="status"><CircleAlert size={17} aria-hidden="true" /> {readOnly
              ? "This architecture has no revision yet. A preview is available after the owner saves its first revision."
              : "No revision yet. Build and save the first revision in the workbench."}</div>
          )}
          {detailState !== "loading" && !message && preview && (
            <>
              <ArchitecturePlanBanner preview={preview} />
              <ArchitectureExplorer
                preview={preview}
                selectedNodeId={selectedNodeId}
                onSelectNode={onSelectNode}
                view={structureView}
                onViewChange={onStructureViewChange}
                {...(onEditNode ? { onEditNode } : {})}
                {...(contextLabel ? { contextLabel } : {})}
              />
              <ArchitectureTechnicalDetails
                preview={preview}
                fixture={<ObservedFixturePreviewCard key={fixtureKey} onPreview={onFixturePreview} />}
              />
            </>
          )}
        </ArchitectureTabPanel>
        <ArchitectureTabPanel className="architecture-overview-panel" id="skills" idPrefix={idPrefix} selected={selectedTab}>
          {preview
            ? (
              <ArchitectureSkillsSection
                preview={preview}
                {...(contextLabel ? { contextLabel } : {})}
                onShowInStructure={(nodeId) => {
                  onSelectNode(nodeId);
                  onStructureViewChange("list");
                  onTabChange("overview");
                }}
              />
            )
            : <p className="architecture-muted">Effective skills appear when the saved revision compiles for the selected context.</p>}
        </ArchitectureTabPanel>
      </div>
      <ArchitectureTabPanel className="architecture-overview-panel architecture-history-tab" id="history" idPrefix={idPrefix} selected={selectedTab}>
        {detail ? (
          <RevisionHistoryPanel
            detail={detail}
            selectedRevisionId={historyRevisionId}
            selectedRevision={historyRevision}
            state={historyState}
            message={historyMessage}
            readOnly={readOnly}
            revisionDetailsAvailable={!organizationOnly}
            onSelect={onHistorySelect}
            onUseAsDraft={onUseRevisionAsDraft}
          />
        ) : <p className="architecture-muted">Revision history is available after the architecture loads.</p>}
      </ArchitectureTabPanel>
      {detail && canManage && (
        // Hidden tab panels stay mounted, which preserves grant drafts.
        <ArchitectureTabPanel className="architecture-overview-panel" id="access" idPrefix={idPrefix} selected={selectedTab}>
          <ArchitectureOrganizationGrantsCard
            key={`organization-grants:${architecture.id}:${detail.latestRevision?.id ?? "empty"}`}
            architectureId={architecture.id}
            currentRevisionId={detail.latestRevision?.id ?? architecture.currentRevisionId ?? null}
            client={client}
            onSaved={() => onRetry()}
          />
        </ArchitectureTabPanel>
      )}
    </article>
  );
}
