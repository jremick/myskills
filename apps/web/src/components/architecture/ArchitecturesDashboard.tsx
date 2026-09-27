import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ArchitectureSpecV1 } from "@myskills-app/core";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArchitectureList } from "./ArchitectureDashboardListPanel.js";
import { CreateArchitectureCard } from "./ArchitectureDashboardCreatePanel.js";
import { ArchitectureDetailPanel } from "./ArchitectureDashboardDetailPanel.js";
import { useSplitLayout } from "../registry/useSplitLayout.js";
import { ArchitectureState } from "./ArchitectureDashboardFeedback.js";
import {
  architectureContexts,
  architectureIsOrganizationOnly,
  architectureOrganizationIds,
  boundEnvironmentForProfile,
  environmentBelongsToProfile,
  environmentProfileId,
  isUnsupportedError,
  organizationChoices,
} from "./architecture-dashboard-helpers.js";
import type { ArchitectureEditorStatus } from "./editor/index.js";
import { useArchitectureNavigationGuard } from "./useArchitectureNavigationGuard.js";
import { useArchitectureRegistry } from "./useArchitectureRegistry.js";
import {
  BUILTIN_PATTERNS,
  type ArchitectureLoadState,
  type WebSessionLike,
} from "./architecture-dashboard-types.js";
import {
  safeArchitectureErrorMessage,
  type ArchitectureDraftPreview,
  type ArchitectureDetail,
  type ArchitectureEnvironment,
  type ArchitecturePattern,
  type ArchitecturePreview,
  type ArchitectureProfile,
  type ArchitectureRevisionRecord,
  type ArchitectureSummary,
  type OrganizationListItem,
  type RegistryClient,
} from "../../api.js";

export function ArchitecturesDashboard({ client, session, onNavigationGuardChange }: {
  client: RegistryClient;
  session: WebSessionLike;
  onNavigationGuardChange?: (guard: ((action: string) => boolean) | null) => void;
}) {
  const [loadState, setLoadState] = useState<ArchitectureLoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<ArchitecturePattern[]>(BUILTIN_PATTERNS);
  const [architectures, setArchitectures] = useState<ArchitectureSummary[]>([]);
  const [profiles, setProfiles] = useState<ArchitectureProfile[]>([]);
  const [environments, setEnvironments] = useState<ArchitectureEnvironment[]>([]);
  const [selectedArchitectureId, setSelectedArchitectureId] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>("");
  const [visibleOrganizations, setVisibleOrganizations] = useState<OrganizationListItem[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<ArchitectureDetail | null>(null);
  const [historyRevisionId, setHistoryRevisionId] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState<ArchitectureRevisionRecord | null>(null);
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "error">("idle");
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);
  const [editorSeed, setEditorSeed] = useState<{ revisionId: string; spec: ArchitectureSpecV1 } | null>(null);
  const [preview, setPreview] = useState<ArchitecturePreview | null>(null);
  const [draftPreview, setDraftPreview] = useState<ArchitectureDraftPreview | null>(null);
  const [detailState, setDetailState] = useState<ArchitectureLoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fixturePreviewEpoch = useRef(0);
  const draftPreviewEpoch = useRef(0);
  const historyRevisionEpoch = useRef(0);
  const previewContextRef = useRef("");
  const refreshEpoch = useRef(0);
  const [hasUnsavedDraft, setHasUnsavedDraft] = useState(false);
  const [mode, setMode] = useState<"detail" | "new">("detail");
  const [opened, setOpened] = useState(false);
  const selectedArchitectureRef = useRef(selectedArchitectureId);
  selectedArchitectureRef.current = selectedArchitectureId;
  const { layout, ref: measureSurface } = useSplitLayout();
  const surfaceNode = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<{ kind: "title" } | { kind: "editor" } | { kind: "new" } | { kind: "row"; id: string } | null>(null);
  const stacked = layout === "stack";

  const surfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceNode.current = node;
    measureSurface(node);
  }, [measureSurface]);

  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    const element = next.kind === "title" ? titleRef.current
      : next.kind === "editor" ? editorRef.current
        : next.kind === "new" ? newNameRef.current
          : Array.from(surfaceNode.current?.querySelectorAll<HTMLElement>("[data-architecture-id]") ?? []).find((item) => item.dataset.architectureId === next.id) ?? null;
    if (!element || element.closest("[hidden]")) return;
    pendingFocus.current = null;
    element.focus();
  });

  const confirmDiscardDraft = useArchitectureNavigationGuard(hasUnsavedDraft);

  useEffect(() => {
    if (!onNavigationGuardChange) return;
    onNavigationGuardChange(confirmDiscardDraft);
    return () => onNavigationGuardChange(null);
  }, [confirmDiscardDraft, onNavigationGuardChange]);

  const requestRefresh = useCallback(() => {
    if (!confirmDiscardDraft("refresh")) return;
    setHasUnsavedDraft(false);
    setRefreshKey((value) => value + 1);
  }, [confirmDiscardDraft]);

  const { searchArchitectureRegistrySkills, loadArchitectureRegistryReleases } = useArchitectureRegistry(client);

  const refresh = useCallback(async () => {
    const requestEpoch = refreshEpoch.current + 1;
    refreshEpoch.current = requestEpoch;
    setLoadState("loading");
    setMessage(null);
    try {
      const [nextPatterns, nextArchitectures] = await Promise.all([
        client.listArchitecturePatterns(),
        client.listArchitectures(),
      ]);
      if (requestEpoch !== refreshEpoch.current) return;
      setPatterns(nextPatterns.length > 0 ? nextPatterns : BUILTIN_PATTERNS);
      setArchitectures(nextArchitectures);
      // A phone view must not reopen onto a different architecture when the
      // selected one is no longer visible.
      if (!nextArchitectures.some((item) => item.id === selectedArchitectureRef.current)) setOpened(false);
      setSelectedArchitectureId((current) => current && nextArchitectures.some((item) => item.id === current)
        ? current
        : nextArchitectures[0]?.id ?? null);
      setLoadState("ready");
    } catch (error) {
      if (requestEpoch !== refreshEpoch.current) return;
      setMessage(safeArchitectureErrorMessage(error));
      setLoadState(isUnsupportedError(error) ? "unsupported" : "error");
    }
  }, [client]);

  const previewSelectionKey = architectureIsOrganizationOnly(selectedDetail)
    ? `organization:${selectedOrganizationId}`
    : `context:${selectedProfileId}:${selectedEnvironmentId}:${selectedDetail?.latestRevision?.id ?? ""}:${selectedOrganizationId}`;

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // A fast list refresh can batch loading and ready, so detail also tracks refresh intent.
  useEffect(() => {
    if (!selectedArchitectureId || loadState !== "ready") {
      setSelectedDetail(null);
      setHistoryRevisionId(null);
      setHistoryRevision(null);
      setHistoryState("idle");
      setHistoryMessage(null);
      setEditorSeed(null);
      setPreview(null);
      setDraftPreview(null);
      setDetailState("ready");
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    client.getArchitecture(selectedArchitectureId)
      .then((detail) => {
        const contexts = architectureContexts(detail);
        const profileId = contexts.profiles.some((item) => item.id === selectedProfileId)
          ? selectedProfileId
          : contexts.profiles[0]?.id ?? "";
        const environmentId = contexts.environments.find((environment) => environment.id === selectedEnvironmentId && environmentBelongsToProfile(environment, profileId))?.id
          ?? boundEnvironmentForProfile(contexts.environments, profileId)?.id
          ?? "";
        if (active) {
          setSelectedDetail(detail);
          setHistoryRevisionId(detail.latestRevision?.id ?? null);
          setHistoryRevision(detail.latestRevision ?? null);
          setHistoryState("idle");
          setHistoryMessage(null);
          setEditorSeed(null);
          setProfiles(contexts.profiles);
          setEnvironments(contexts.environments);
          setSelectedProfileId(profileId);
          setSelectedEnvironmentId(environmentId);
          const allowedOrganizationIds = architectureOrganizationIds(detail);
          setSelectedOrganizationId((current) => allowedOrganizationIds.includes(current) ? current : "");
          setPreview(null);
          setDraftPreview(null);
          setDetailState("ready");
        }
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSelectedDetail(null);
        setHistoryRevisionId(null);
        setHistoryRevision(null);
        setHistoryState("error");
        setHistoryMessage(safeArchitectureErrorMessage(error));
        setEditorSeed(null);
        setPreview(null);
        setDraftPreview(null);
        setDetailMessage(safeArchitectureErrorMessage(error));
        setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
      });
    return () => {
      active = false;
    };
  }, [client, loadState, refreshKey, selectedArchitectureId]);

  useEffect(() => {
    if (!selectedDetail || !architectureIsOrganizationOnly(selectedDetail)) {
      setVisibleOrganizations([]);
      return;
    }
    const allowedIds = new Set(architectureOrganizationIds(selectedDetail));
    if (!client.listOrganizations) {
      setVisibleOrganizations([]);
      setSelectedOrganizationId((current) => current && allowedIds.has(current) ? current : "");
      return;
    }
    let active = true;
    client.listOrganizations()
      .then((organizations) => {
        if (!active) return;
        const visible = organizations.filter((organization) => allowedIds.has(organization.id));
        setVisibleOrganizations(visible);
        setSelectedOrganizationId((current) => current && allowedIds.has(current) ? current : visible[0]?.id ?? "");
      })
      .catch(() => {
        if (!active) return;
        setVisibleOrganizations([]);
        setSelectedOrganizationId((current) => current && allowedIds.has(current) ? current : "");
      });
    return () => {
      active = false;
    };
  }, [client, selectedDetail]);

  useEffect(() => {
    const organizationOnly = architectureIsOrganizationOnly(selectedDetail);
    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || (!organizationOnly && (!selectedDetail?.latestRevision || !selectedProfileId || !selectedEnvironmentId))) {
      return;
    }
    if (organizationOnly && !selectedOrganizationId) {
      setPreview(null);
      setDetailMessage(null);
      setDetailState("ready");
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    const request = organizationOnly
      ? { organizationId: selectedOrganizationId }
      : {
        profileId: selectedProfileId,
        environmentId: selectedEnvironmentId,
        revisionId: selectedDetail.latestRevision!.id,
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
      };
    client.previewArchitecture(selectedArchitectureId, request).then((nextPreview) => {
      if (!active) return;
      if (organizationOnly) {
        const profileId = nextPreview.compiled.profileId;
        const environmentId = nextPreview.compiled.environmentId;
        setProfiles([{ id: profileId, name: "Authorized profile", scope: "personal", environmentIds: [environmentId] }]);
        setEnvironments([{ id: environmentId, name: "Authorized environment", kind: "personal", profileId }]);
        setSelectedProfileId(profileId);
        setSelectedEnvironmentId(environmentId);
      }
      setPreview(nextPreview);
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setPreview(null);
      setDetailMessage(safeArchitectureErrorMessage(error));
      setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
    });
    return () => {
      active = false;
    };
  }, [client, previewSelectionKey, selectedArchitectureId, selectedDetail, selectedOrganizationId]);

  const selectedArchitecture = useMemo(
    () => architectures.find((item) => item.id === selectedArchitectureId) ?? null,
    [architectures, selectedArchitectureId],
  );
  const previewContextKey = [
    selectedArchitectureId ?? "",
    selectedDetail?.id ?? "",
    selectedDetail?.latestRevision?.id ?? "",
    selectedProfileId,
    selectedEnvironmentId,
    selectedOrganizationId,
  ].join("\u0000");
  // Keep the latest context available to async fixture-preview continuations
  // without introducing an effect solely for derived state.
  previewContextRef.current = previewContextKey;
  useEffect(() => {
    fixturePreviewEpoch.current += 1;
    draftPreviewEpoch.current += 1;
    setDraftPreview(null);
  }, [previewContextKey]);

  const handleHistorySelect = useCallback(async (revisionId: string) => {
    if (!selectedArchitectureId || !selectedDetail || selectedDetail.id !== selectedArchitectureId) return;
    const currentRevision = selectedDetail.latestRevision;
    const requestContextKey = previewContextRef.current;
    const requestEpoch = historyRevisionEpoch.current + 1;
    historyRevisionEpoch.current = requestEpoch;
    setHistoryRevisionId(revisionId);
    setHistoryMessage(null);
    if (currentRevision?.id === revisionId) {
      setHistoryRevision(currentRevision);
      setHistoryState("idle");
      return;
    }
    setHistoryState("loading");
    try {
      const nextRevision = await client.getArchitectureRevision(selectedArchitectureId, revisionId);
      if (requestEpoch !== historyRevisionEpoch.current || requestContextKey !== previewContextRef.current) return;
      setHistoryRevision(nextRevision);
      setHistoryState("idle");
    } catch (error) {
      if (requestEpoch !== historyRevisionEpoch.current || requestContextKey !== previewContextRef.current) return;
      setHistoryState("error");
      setHistoryMessage(safeArchitectureErrorMessage(error));
    }
  }, [client, selectedArchitectureId, selectedDetail]);

  const handleUseRevisionAsDraft = useCallback((revision: ArchitectureRevisionRecord) => {
    if (!selectedArchitectureId || !selectedDetail || selectedDetail.id !== selectedArchitectureId || !selectedDetail.latestRevision) return;
    if (!confirmDiscardDraft("replace the current draft")) return;
    setEditorSeed({ revisionId: revision.id, spec: structuredClone(revision.spec) });
    setDraftPreview(null);
    draftPreviewEpoch.current += 1;
    // The editor sits above the history, so move the reader to the new draft.
    pendingFocus.current = { kind: "editor" };
  }, [confirmDiscardDraft, selectedArchitectureId, selectedDetail]);
  const availableProfiles = profiles;
  const availableEnvironments = environments;
  const handleDraftChange = useCallback((status: ArchitectureEditorStatus) => {
    setHasUnsavedDraft(status.dirty);
    if (status.dirty) {
      setDraftPreview(null);
      draftPreviewEpoch.current += 1;
    }
  }, []);

  function selectArchitecture(id: string): boolean {
    if (id === selectedArchitectureId) {
      return true;
    }
    if (!confirmDiscardDraft("switch architectures")) return false;
    setSelectedDetail(null);
    setHistoryRevisionId(null);
    setHistoryRevision(null);
    setHistoryState("idle");
    setHistoryMessage(null);
    setEditorSeed(null);
    setProfiles([]);
    setEnvironments([]);
    setSelectedProfileId("");
    setSelectedEnvironmentId("");
    setSelectedOrganizationId("");
    setVisibleOrganizations([]);
    setHasUnsavedDraft(false);
    setSelectedArchitectureId(id);
    setPreview(null);
    setDraftPreview(null);
    setDetailMessage(null);
    return true;
  }

  // Tapping the already-selected row still opens it in the stacked layout;
  // selectArchitecture keeps the discard guard for a different architecture.
  function openArchitecture(id: string) {
    if (!selectArchitecture(id)) return;
    setMode("detail");
    openerRef.current = null;
    if (stacked) {
      setOpened(true);
      pendingFocus.current = { kind: "title" };
    }
  }

  function backToArchitectures() {
    setOpened(false);
    if (selectedArchitectureId) pendingFocus.current = { kind: "row", id: selectedArchitectureId };
  }

  function openNew(event: MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setMode("new");
    pendingFocus.current = { kind: "new" };
  }

  // The detail stays mounted while New is open, so Cancel keeps the draft.
  function cancelNew() {
    setMode("detail");
    const opener = openerRef.current;
    openerRef.current = null;
    pendingFocus.current = null;
    opener?.focus();
  }

  const noArchitectures = loadState === "ready" && architectures.length === 0;
  const newVisible = mode === "new" || noArchitectures;
  const showList = !stacked || (!opened && !newVisible);
  const showInspector = !stacked || opened || newVisible;

  return (
    <main className="architecture-workspace cp-page" aria-label="Skill architectures">
      <header className="cp-page-head app-page-header">
        <div><h1 id="architectures-heading">Skill architectures</h1></div>
        <div className="cp-page-actions">
          <Button aria-controls="architecture-new-panel" aria-expanded={newVisible} disabled={loadState !== "ready"} size="sm" type="button" variant="outline" onClick={openNew}>
            <Plus size={15} aria-hidden="true" />New architecture
          </Button>
          <Button aria-label="Refresh" size="icon-sm" title="Refresh" type="button" variant="outline" onClick={requestRefresh}>
            <RefreshCw size={16} aria-hidden="true" />
          </Button>
        </div>
      </header>

      {message && loadState !== "ready" && (
        <ArchitectureState state={loadState} message={message} onRetry={requestRefresh} />
      )}
      {loadState === "loading" && <div className="cp-loading" role="status"><span className="sr-only">Loading architectures…</span><span /><span /><span /></div>}

      {loadState === "ready" && (
        <div className="cp-surface" data-layout={layout} ref={surfaceRef}>
          <div className="cp-body">
            <ArchitectureList
              architectures={architectures}
              hidden={!showList}
              selectedId={selectedArchitectureId}
              onSelect={openArchitecture}
            />
            <div className="cp-inspector" hidden={!showInspector}>
              <div className="cp-panel" id="architecture-new-panel" hidden={!newVisible}>
                <CreateArchitectureCard
                  client={client}
                  session={session}
                  patterns={patterns}
                  nameInputRef={newNameRef}
                  onCancel={noArchitectures ? undefined : cancelNew}
                  onCreated={(created) => {
                    const shouldOpen = confirmDiscardDraft("open the new architecture");
                    setArchitectures((current) => [created, ...current.filter((item) => item.id !== created.id)]);
                    setMode("detail");
                    setOpened(true);
                    openerRef.current = null;
                    // Declining the discard returns to the dirty architecture.
                    pendingFocus.current = { kind: "title" };
                    if (!shouldOpen) return;
                    setSelectedDetail(null);
                    setHistoryRevisionId(null);
                    setHistoryRevision(null);
                    setHistoryState("idle");
                    setHistoryMessage(null);
                    setEditorSeed(null);
                    setProfiles([]);
                    setEnvironments([]);
                    setSelectedProfileId("");
                    setSelectedEnvironmentId("");
                    setSelectedOrganizationId("");
                    setVisibleOrganizations([]);
                    setHasUnsavedDraft(false);
                    setDraftPreview(null);
                    setSelectedArchitectureId(created.id);
                  }}
                />
              </div>
              <div className="cp-panel" hidden={newVisible}>
                <ArchitectureDetailPanel
                  titleRef={titleRef}
                  editorRef={editorRef}
                  onBack={stacked ? backToArchitectures : undefined}
                  architecture={selectedArchitecture}
                  detail={selectedDetail}
                  detailState={detailState}
                  message={detailMessage}
                  preview={preview}
                  draftPreview={draftPreview}
                  historyRevisionId={historyRevisionId}
                  historyRevision={historyRevision}
                  historyState={historyState}
                  historyMessage={historyMessage}
                  editorSeed={editorSeed}
                  profiles={availableProfiles}
                  environments={availableEnvironments}
                  patterns={patterns}
                  selectedProfileId={selectedProfileId}
                  selectedEnvironmentId={selectedEnvironmentId}
                  allowedOrganizationIds={architectureOrganizationIds(selectedDetail ?? selectedArchitecture)}
                  organizationChoices={organizationChoices(architectureOrganizationIds(selectedDetail ?? selectedArchitecture), visibleOrganizations)}
                  organizationOnly={architectureIsOrganizationOnly(selectedDetail ?? selectedArchitecture)}
                  selectedOrganizationId={selectedOrganizationId}
                  onProfileChange={(value) => {
                    const profile = availableProfiles.find((item) => item.id === value);
                    const environment = profile ? boundEnvironmentForProfile(availableEnvironments, profile.id) : undefined;
                    if (!profile || !environment) return;
                    setDraftPreview(null);
                    setSelectedProfileId(profile.id);
                    setSelectedEnvironmentId(environment.id);
                  }}
                  onEnvironmentChange={(value) => {
                    const environment = availableEnvironments.find((item) => item.id === value);
                    const profileId = environment ? environmentProfileId(environment, availableProfiles) : undefined;
                    if (!environment || !profileId) return;
                    setDraftPreview(null);
                    setSelectedProfileId(profileId);
                    setSelectedEnvironmentId(environment.id);
                  }}
                  onOrganizationChange={(value) => {
                    const allowedOrganizationIds = architectureOrganizationIds(selectedDetail ?? selectedArchitecture);
                    if (value && !allowedOrganizationIds.includes(value)) return;
                    setDraftPreview(null);
                    setSelectedOrganizationId(value);
                  }}
                  onDraftPreview={async ({ spec, expectedRevisionId }) => {
                    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || !selectedDetail.latestRevision || !selectedProfileId || !selectedEnvironmentId) {
                      return;
                    }
                    const requestEpoch = draftPreviewEpoch.current + 1;
                    draftPreviewEpoch.current = requestEpoch;
                    const requestContextKey = previewContextRef.current;
                    try {
                      const nextPreview = await client.previewArchitectureDraft(selectedArchitectureId, {
                        spec,
                        expectedCurrentRevisionId: expectedRevisionId,
                        profileId: selectedProfileId,
                        environmentId: selectedEnvironmentId,
                      });
                      if (requestEpoch !== draftPreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                        return;
                      }
                      setDraftPreview(nextPreview);
                    } catch (error) {
                      if (requestEpoch !== draftPreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                        return;
                      }
                      throw new Error(safeArchitectureErrorMessage(error));
                    }
                  }}
                  onDraftSave={async ({ spec, expectedRevisionId, message: revisionMessage }) => {
                    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId) {
                      return;
                    }
                    try {
                      await client.createArchitectureRevision(selectedArchitectureId, {
                        spec,
                        expectedCurrentRevisionId: expectedRevisionId,
                        ...(revisionMessage ? { message: revisionMessage } : {}),
                      });
                      setDraftPreview(null);
                      setRefreshKey((value) => value + 1);
                    } catch (error) {
                      throw new Error(safeArchitectureErrorMessage(error));
                    }
                  }}
                  onDraftChange={handleDraftChange}
                  onHistorySelect={handleHistorySelect}
                  onUseRevisionAsDraft={handleUseRevisionAsDraft}
                  onSearchRegistrySkills={searchArchitectureRegistrySkills}
                  onLoadRegistryReleases={loadArchitectureRegistryReleases}
                  onFixturePreview={async (fixture) => {
                    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || !selectedDetail?.latestRevision || !selectedProfileId || !selectedEnvironmentId) {
                      return;
                    }
                    const requestEpoch = fixturePreviewEpoch.current + 1;
                    fixturePreviewEpoch.current = requestEpoch;
                    const requestContextKey = previewContextKey;
                    setDetailMessage(null);
                    try {
                      const nextPreview = await client.previewArchitecture(selectedArchitectureId, {
                        profileId: selectedProfileId,
                        environmentId: selectedEnvironmentId,
                        revisionId: selectedDetail.latestRevision.id,
                        fixture,
                        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
                      });
                      if (requestEpoch !== fixturePreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                        return;
                      }
                      setDraftPreview(null);
                      setPreview(nextPreview);
                      setDetailState("ready");
                    } catch (error) {
                      if (requestEpoch !== fixturePreviewEpoch.current || requestContextKey !== previewContextRef.current) {
                        return;
                      }
                      setDetailMessage(safeArchitectureErrorMessage(error));
                      setDetailState(isUnsupportedError(error) ? "unsupported" : "error");
                      throw error;
                    }
                  }}
                  onPatternMigrationCreated={(result) => {
                    const created = result.persisted?.targetArchitecture;
                    if (created) {
                      setArchitectures((current) => [created, ...current.filter((item) => item.id !== created.id)]);
                      selectArchitecture(created.id);
                    } else {
                      setRefreshKey((value) => value + 1);
                    }
                  }}
                  client={client}
                  onRetry={requestRefresh}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
