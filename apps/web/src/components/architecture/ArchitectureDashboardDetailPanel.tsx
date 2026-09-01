import {
  CircleAlert,
  Network,
  ShieldCheck,
} from "lucide-react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArchitectureOrganizationGrantsCard } from "./ArchitectureOrganizationGrantsCard.js";
import { ArchitecturePatternMigrationCard } from "./ArchitecturePatternMigrationCard.js";
import {
  type ArchitectureDraftPreview,
  type ArchitectureDetail,
  type ArchitectureEnvironment,
  type ArchitectureObservedFixture,
  type ArchitecturePattern,
  type ArchitecturePatternMigrationCreateResult,
  type ArchitecturePreview,
  type ArchitectureProfile,
  type ArchitectureRevisionRecord,
  type ArchitectureSummary,
  type RegistryClient,
} from "../../api.js";
import {
  architectureIsOrganizationOnly,
  architectureRevisionLabel,
  bootstrapArchitectureSpec,
  boundEnvironmentForProfile,
  environmentBelongsToProfile,
  organizationChoices,
  patternLabel,
} from "./architecture-dashboard-helpers.js";
import { ArchitectureState, ArchitectureDetailLoading } from "./ArchitectureDashboardFeedback.js";
import { ArchitecturePreviewPanel } from "./ArchitectureDashboardPreviewPanel.js";
import {
  AddArchitectureRevisionCard,
  ArchitectureEditorCard,
  ObservedFixturePreviewCard,
} from "./ArchitectureDashboardEditorPanels.js";
import { RevisionHistoryPanel } from "./ArchitectureDashboardHistoryPanel.js";
import type {
  ArchitectureEditorPreviewRequest,
  ArchitectureEditorSaveRequest,
  ArchitectureEditorStatus,
  ArchitectureRegistryReleaseOption,
  ArchitectureRegistrySkillOption,
} from "./editor/index.js";
import type {
  ArchitectureLoadState,
  OrganizationChoice,
} from "./architecture-dashboard-types.js";

export function ArchitectureDetailPanel({
  architecture,
  detail,
  detailState,
  message,
  preview,
  draftPreview,
  historyRevisionId,
  historyRevision,
  historyState,
  historyMessage,
  editorSeed,
  profiles,
  environments,
  patterns,
  selectedProfileId,
  selectedEnvironmentId,
  allowedOrganizationIds,
  organizationChoices,
  organizationOnly,
  selectedOrganizationId,
  onProfileChange,
  onEnvironmentChange,
  onOrganizationChange,
  onDraftPreview,
  onDraftSave,
  onDraftChange,
  onHistorySelect,
  onUseRevisionAsDraft,
  onSearchRegistrySkills,
  onLoadRegistryReleases,
  onFixturePreview,
  onPatternMigrationCreated,
  client,
  onRetry,
}: {
  architecture: ArchitectureSummary | null;
  detail: ArchitectureDetail | null;
  detailState: ArchitectureLoadState;
  message: string | null;
  preview: ArchitecturePreview | null;
  draftPreview: ArchitectureDraftPreview | null;
  historyRevisionId: string | null;
  historyRevision: ArchitectureRevisionRecord | null;
  historyState: "idle" | "loading" | "error";
  historyMessage: string | null;
  editorSeed: { revisionId: string; spec: ArchitectureSpecV1 } | null;
  profiles: ArchitectureProfile[];
  environments: ArchitectureEnvironment[];
  patterns: ArchitecturePattern[];
  selectedProfileId: string;
  selectedEnvironmentId: string;
  allowedOrganizationIds: string[];
  organizationChoices: OrganizationChoice[];
  organizationOnly: boolean;
  selectedOrganizationId: string;
  onProfileChange: (value: string) => void;
  onEnvironmentChange: (value: string) => void;
  onOrganizationChange: (value: string) => void;
  onDraftPreview: (request: ArchitectureEditorPreviewRequest) => Promise<void>;
  onDraftSave: (request: ArchitectureEditorSaveRequest) => Promise<void>;
  onDraftChange: (status: ArchitectureEditorStatus) => void;
  onHistorySelect: (revisionId: string) => Promise<void>;
  onUseRevisionAsDraft: (revision: ArchitectureRevisionRecord) => void;
  onSearchRegistrySkills: (query: string) => Promise<ArchitectureRegistrySkillOption[]>;
  onLoadRegistryReleases: (skill: ArchitectureRegistrySkillOption) => Promise<ArchitectureRegistryReleaseOption[]>;
  onFixturePreview: (fixture: ArchitectureObservedFixture) => Promise<void>;
  onPatternMigrationCreated: (result: ArchitecturePatternMigrationCreateResult) => void;
  client: RegistryClient;
  onRetry: () => void;
}) {
  if (!architecture) {
    return (
      <Card className="architecture-detail-card empty" aria-label="Architecture detail">
        <CardContent className="architecture-detail-empty">
          <Network size={42} aria-hidden="true" />
          <h2>Select an architecture</h2>
          <p>Choose a saved architecture to inspect its topology, effective skills, and dry-run sync plan.</p>
        </CardContent>
      </Card>
    );
  }

  const canAppend = detail?.access?.canAppend ?? architecture.access?.canAppend ?? false;
  const canManage = detail?.access?.canManage ?? architecture.access?.canManage ?? false;
  const readOnly = !canAppend;
  const ownerType = detail?.access?.ownerType ?? architecture.access?.ownerType ?? architecture.owner?.type;
  const activePreview = draftPreview && detail?.latestRevision
    ? {
      revision: { ...detail.latestRevision, spec: draftPreview.draft.spec },
      compiled: draftPreview.compiled,
      graph: draftPreview.graph,
      outline: draftPreview.outline,
      diagram: draftPreview.diagram,
      ...(draftPreview.plan ? { plan: draftPreview.plan } : {}),
    }
    : preview;

  return (
    <Card className="architecture-detail-card" aria-label={`Architecture detail: ${architecture.name}`}>
      <CardHeader className="architecture-detail-header">
        <div>
          <p className="architecture-kicker">Architecture detail</p>
          <CardTitle>{architecture.name}</CardTitle>
          <CardDescription>{architecture.description || "No description supplied."}</CardDescription>
          <p className="architecture-access-note" data-testid="architecture-access-note">
            {ownerType === "team" ? "Team-owned" : "Personal owner"} · {readOnly ? "Read-only access" : "Append access enabled"}
          </p>
        </div>
        <div className="architecture-detail-badges">
          <Badge variant="outline">{patternLabel(architecture.patternId)}</Badge>
          <Badge variant="secondary">{architectureRevisionLabel(architecture)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="architecture-detail-content">
        {(profiles.length > 0 && environments.length > 0) || (organizationOnly && allowedOrganizationIds.length > 0) ? (
          <div className="architecture-context-bar" aria-label="Preview context">
            {profiles.length > 0 && <label>
              <span>Profile</span>
              <select aria-label="Preview profile" onChange={(event) => onProfileChange(event.target.value)} value={selectedProfileId}>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.scope}</option>)}
              </select>
            </label>}
            {environments.length > 0 && <label>
              <span>Environment</span>
              <select aria-label="Preview environment" onChange={(event) => onEnvironmentChange(event.target.value)} value={selectedEnvironmentId}>
                {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
              </select>
            </label>}
            {allowedOrganizationIds.length > 0 && (
              <label>
                <span>Organization {organizationOnly ? "(required)" : "(optional)"}</span>
                <select aria-label="Preview organization" onChange={(event) => onOrganizationChange(event.target.value)} value={selectedOrganizationId}>
                  {!organizationOnly && <option value="">Owner/team context</option>}
                  {organizationOnly && <option value="">Choose an organization…</option>}
                  {organizationChoices.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {organization.slug}</option>)}
                </select>
              </label>
            )}
            <span className="architecture-context-note"><ShieldCheck size={15} aria-hidden="true" /> Effective result returned by API</span>
            {organizationOnly && !selectedOrganizationId && (
              <span className="architecture-context-note" role="status"><CircleAlert size={15} aria-hidden="true" /> Select one authorized organization to preview this shared architecture.</span>
            )}
          </div>
        ) : (
          <div className="architecture-empty-inline" role="status"><CircleAlert size={17} aria-hidden="true" /> This draft has no revision yet. Add a validated spec through the architecture revision API before previewing it.</div>
        )}

        {detailState === "loading" && <ArchitectureDetailLoading />}
        {detailState !== "loading" && message && (
          <ArchitectureState state={detailState} message={message} onRetry={onRetry} compact />
        )}
        {detail && <RevisionHistoryPanel
          detail={detail}
          selectedRevisionId={historyRevisionId}
          selectedRevision={historyRevision}
          state={historyState}
          message={historyMessage}
          readOnly={readOnly}
          revisionDetailsAvailable={!organizationOnly}
          onSelect={onHistorySelect}
          onUseAsDraft={onUseRevisionAsDraft}
        />}
        {detail && canManage && (
          <>
            <ArchitectureOrganizationGrantsCard
              key={`organization-grants:${architecture.id}:${detail.latestRevision?.id ?? "empty"}`}
              architectureId={architecture.id}
              currentRevisionId={detail.latestRevision?.id ?? architecture.currentRevisionId ?? null}
              client={client}
              onSaved={() => onRetry()}
            />
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
          </>
        )}
        {detailState !== "loading" && !message && activePreview && (
          <>
            {draftPreview && <div className="architecture-draft-preview-note" role="status"><strong>Unsaved draft preview · noncanonical</strong><span>The API compiled this editor draft. The latest saved revision is unchanged until you save it.</span></div>}
            <ArchitecturePreviewPanel detail={detail} preview={activePreview} />
          </>
        )}
        {detailState !== "loading" && !message && preview && (
          <ObservedFixturePreviewCard
            key={`${architecture.id}:${selectedProfileId}:${selectedEnvironmentId}`}
            onPreview={onFixturePreview}
          />
        )}
        {detail && (detail.latestRevision || !readOnly) && (
          <ArchitectureEditorCard
            key={`editor:${architecture.id}:${detail.latestRevision?.id ?? "bootstrap"}:${editorSeed?.revisionId ?? "current"}`}
            detail={detail}
            readOnly={readOnly}
            initialSpec={editorSeed?.spec ?? detail.latestRevision?.spec ?? bootstrapArchitectureSpec(architecture, detail)}
            expectedRevisionId={detail.latestRevision?.id ?? null}
            seededFromRevision={editorSeed?.revisionId ?? null}
            onPreview={readOnly || !detail.latestRevision ? undefined : onDraftPreview}
            onSave={readOnly ? undefined : onDraftSave}
            onDraftChange={onDraftChange}
            onSearchRegistrySkills={readOnly ? undefined : onSearchRegistrySkills}
            onLoadRegistryReleases={readOnly ? undefined : onLoadRegistryReleases}
          />
        )}
        {detail && !readOnly && (
          <AddArchitectureRevisionCard
            key={`json:${architecture.id}:${detail.latestRevision?.id ?? "draft"}`}
            architectureId={architecture.id}
            client={client}
            detail={detail}
            onSaved={onRetry}
          />
        )}
      </CardContent>
    </Card>
  );
}
