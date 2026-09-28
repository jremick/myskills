import type { MouseEvent, ReactNode, RefObject } from "react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { ArrowLeft, CircleAlert } from "lucide-react";
import type {
  ArchitectureDetail,
  ArchitectureDraftPreview,
  ArchitecturePreview,
  ArchitectureSummary,
  RegistryClient,
} from "../../api.js";
import { bootstrapArchitectureSpec, revisionLabel } from "./architecture-dashboard-helpers.js";
import { ArchitectureDetailLoading, ArchitectureState } from "./ArchitectureDashboardFeedback.js";
import { AddArchitectureRevisionCard, ArchitectureEditorCard } from "./ArchitectureDashboardEditorPanels.js";
import { ArchitecturePreviewPanel } from "./ArchitectureDashboardPreviewPanel.js";
import type { ArchitectureLoadState } from "./architecture-dashboard-types.js";
import type {
  ArchitectureEditorPreviewRequest,
  ArchitectureEditorSaveRequest,
  ArchitectureEditorStatus,
  ArchitectureRegistryReleaseOption,
  ArchitectureRegistrySkillOption,
} from "./editor/index.js";

export interface ArchitectureEditorSeed {
  revisionId: string;
  revisionLabel: string;
  spec: ArchitectureSpecV1;
  /** Unique per accepted "Use as new draft", so reusing one revision still resets the draft. */
  generation: number;
}

/**
 * Full-page Workbench for one architecture. The dashboard keeps this panel
 * mounted (hidden) on the overview so one draft session survives both
 * surfaces; it never renders the saved-result overview itself.
 */
export function ArchitectureWorkbenchPanel({
  architecture,
  detail,
  detailState,
  message,
  editorSeed,
  overviewHref,
  onOverviewLink,
  titleRef,
  notices,
  contextSelectors,
  draftPreview,
  client,
  onRetry,
  onDraftPreview,
  onDraftSave,
  onDraftChange,
  onMessageDirtyChange,
  onSearchRegistrySkills,
  onLoadRegistryReleases,
}: {
  architecture: ArchitectureSummary;
  detail: ArchitectureDetail | null;
  detailState: ArchitectureLoadState;
  message: string | null;
  editorSeed: ArchitectureEditorSeed | null;
  overviewHref: string;
  onOverviewLink: (event: MouseEvent<HTMLAnchorElement>) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
  notices?: ReactNode;
  contextSelectors: ReactNode;
  draftPreview: ArchitectureDraftPreview | null;
  client: RegistryClient;
  onRetry: () => void;
  onDraftPreview: (request: ArchitectureEditorPreviewRequest) => Promise<void>;
  onDraftSave: (request: ArchitectureEditorSaveRequest) => Promise<void>;
  onDraftChange: (status: ArchitectureEditorStatus) => void;
  onMessageDirtyChange: (dirty: boolean) => void;
  onSearchRegistrySkills: (query: string) => Promise<ArchitectureRegistrySkillOption[]>;
  onLoadRegistryReleases: (skill: ArchitectureRegistrySkillOption) => Promise<ArchitectureRegistryReleaseOption[]>;
}) {
  const readOnly = !(detail?.access?.canAppend ?? architecture.access?.canAppend ?? false);
  const latest = detail?.latestRevision ?? null;
  const editable = Boolean(detail && (latest || !readOnly));
  const mode = readOnly
    ? "Inspect this architecture"
    : !latest
      ? "Build the first revision"
      : editorSeed
        ? `Draft from ${editorSeed.revisionLabel}`
        : "Edit the current revision";
  const baseLine = !detail
    ? null
    : !latest
      ? "No saved revision yet"
      : readOnly
        ? `Viewing ${revisionLabel(latest)}`
        : editorSeed
          ? `Draft from ${editorSeed.revisionLabel} · saves after ${revisionLabel(latest)}`
          : `Based on ${revisionLabel(latest)}`;
  const heading = (
    <div className="architecture-workbench-heading">
      <h1 id="architecture-workbench-title" ref={titleRef} tabIndex={-1}>{architecture.name}</h1>
      {editable && <h2>{mode}</h2>}
    </div>
  );
  const activePreview: ArchitecturePreview | null = draftPreview && latest
    ? {
      revision: { ...latest, spec: draftPreview.draft.spec },
      compiled: draftPreview.compiled,
      graph: draftPreview.graph,
      outline: draftPreview.outline,
      diagram: draftPreview.diagram,
      ...(draftPreview.plan ? { plan: draftPreview.plan } : {}),
    }
    : null;

  return (
    <section className="architecture-workbench" aria-labelledby="architecture-workbench-title">
      <div className="architecture-workbench-nav">
        <a className="architecture-workbench-back" href={overviewHref} onClick={onOverviewLink}>
          <ArrowLeft size={15} aria-hidden="true" />Architecture overview
        </a>
        {baseLine && <span className="architecture-workbench-base">{baseLine}</span>}
      </div>
      {notices}
      {detail && editable ? (
        <ArchitectureEditorCard
          key={`editor:${architecture.id}:${latest?.id ?? "bootstrap"}:${editorSeed ? `${editorSeed.revisionId}:${editorSeed.generation}` : "current"}`}
          detail={detail}
          readOnly={readOnly}
          heading={heading}
          initialSpec={editorSeed?.spec ?? latest?.spec ?? bootstrapArchitectureSpec(architecture, detail)}
          expectedRevisionId={latest?.id ?? null}
          onPreview={readOnly || !latest ? undefined : onDraftPreview}
          onSave={readOnly ? undefined : onDraftSave}
          onDraftChange={onDraftChange}
          onMessageDirtyChange={onMessageDirtyChange}
          onSearchRegistrySkills={readOnly ? undefined : onSearchRegistrySkills}
          onLoadRegistryReleases={readOnly ? undefined : onLoadRegistryReleases}
          previewPanel={readOnly ? undefined : (
            <div className="architecture-workbench-preview">
              <div className="architecture-workbench-preview-head">
                <h3>Draft preview</h3>
                {contextSelectors}
              </div>
              {activePreview ? (
                <>
                  <div className="architecture-draft-preview-note" role="status"><strong>Unsaved draft preview · noncanonical</strong><span>The API compiled this editor draft. The latest saved revision is unchanged until you save it.</span></div>
                  <ArchitecturePreviewPanel preview={activePreview} />
                </>
              ) : (
                <p className="architecture-empty-inline"><CircleAlert size={17} aria-hidden="true" /> {latest
                  ? "Preview draft compiles this draft for the selected context. The saved revision stays unchanged."
                  : "Save the first revision before previewing a draft for a profile and environment."}</p>
              )}
            </div>
          )}
          advancedPanel={readOnly ? undefined : (
            <AddArchitectureRevisionCard
              key={`json:${architecture.id}:${latest?.id ?? "draft"}`}
              architectureId={architecture.id}
              client={client}
              detail={detail}
              onSaved={onRetry}
            />
          )}
        />
      ) : (
        <>
          {heading}
          {detailState === "loading" && <ArchitectureDetailLoading />}
          {detailState !== "loading" && message && !detail && (
            <ArchitectureState state={detailState} message={message} onRetry={onRetry} compact />
          )}
          {detail && !editable && (
            <div className="architecture-empty-inline" role="status"><CircleAlert size={17} aria-hidden="true" /> This architecture has no saved revision to inspect yet.</div>
          )}
        </>
      )}
    </section>
  );
}
