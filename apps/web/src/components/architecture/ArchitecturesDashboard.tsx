import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Check, CircleAlert, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArchitectureList } from "./ArchitectureDashboardListPanel.js";
import { CreateArchitectureCard } from "./ArchitectureDashboardCreatePanel.js";
import { ArchitectureDetailPanel, type ArchitectureOverviewTab } from "./ArchitectureDashboardDetailPanel.js";
import { ArchitectureWorkbenchPanel, type ArchitectureEditorSeed } from "./ArchitectureWorkbenchPanel.js";
import { ArchitectureContextSelectors } from "./ArchitectureContextSelectors.js";
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
  revisionLabel,
} from "./architecture-dashboard-helpers.js";
import type { ArchitectureEditorStatus } from "./editor/index.js";
import { useArchitectureNavigationGuard, type ArchitectureNavigationGuard } from "./useArchitectureNavigationGuard.js";
import { useArchitectureRegistry } from "./useArchitectureRegistry.js";
import {
  architectureContextKey,
  architectureUrl,
  hasRequestedContext,
  parseArchitectureRoute,
  type ArchitectureContextParams,
  type ArchitectureRoute,
} from "./architecture-route.js";
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

const ROOT_ROUTE: ArchitectureRoute = { architectureId: null, surface: "overview", context: {} };
const CONTEXT_FALLBACK_NOTICE = "The requested preview context isn't available for this architecture. Showing the default context.";

type PendingFocus =
  | { kind: "title" }
  | { kind: "workbench-title" }
  | { kind: "launcher" }
  | { kind: "new" }
  | { kind: "row"; id: string };

export function ArchitecturesDashboard({ client, session, url, onNavigate, onNavigationGuardChange }: {
  client: RegistryClient;
  session: WebSessionLike;
  /** Current app URL (path, query and hash). The URL owns selection, surface and requested context. */
  url: string;
  onNavigate: (url: string, mode: "push" | "replace") => void;
  onNavigationGuardChange?: (guard: ArchitectureNavigationGuard | null) => void;
}) {
  const route = useMemo(() => {
    const parsed = new URL(url, "http://architecture.invalid");
    return parseArchitectureRoute(parsed.pathname, parsed.search) ?? ROOT_ROUTE;
  }, [url]);
  const routeId = route.architectureId;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const [loadState, setLoadState] = useState<ArchitectureLoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<ArchitecturePattern[]>(BUILTIN_PATTERNS);
  const [architectures, setArchitectures] = useState<ArchitectureSummary[]>([]);
  const [overviewTab, setOverviewTab] = useState<ArchitectureOverviewTab>("overview");
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
  const [editorSeed, setEditorSeed] = useState<ArchitectureEditorSeed | null>(null);
  const [preview, setPreview] = useState<ArchitecturePreview | null>(null);
  const [draftPreview, setDraftPreview] = useState<ArchitectureDraftPreview | null>(null);
  const [detailState, setDetailState] = useState<ArchitectureLoadState>("ready");
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [contextNotice, setContextNotice] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const fixturePreviewEpoch = useRef(0);
  const draftPreviewEpoch = useRef(0);
  const historyRevisionEpoch = useRef(0);
  const previewContextRef = useRef("");
  const refreshEpoch = useRef(0);
  // Spec and revision message are tracked separately: a message-only change
  // is unsaved work, but it does not make a draft preview stale.
  const [specDirty, setSpecDirty] = useState(false);
  const [messageDirty, setMessageDirty] = useState(false);
  const hasUnsavedDraft = specDirty || messageDirty;
  const [mode, setMode] = useState<"detail" | "new">("detail");
  const [opened, setOpened] = useState(false);
  const [seenRouteId, setSeenRouteId] = useState(routeId);
  const routeContextKey = architectureContextKey(route.context);
  const [seenRouteContextKey, setSeenRouteContextKey] = useState(routeContextKey);
  // Changes whenever the draft being edited is replaced (another architecture
  // or a history seed), so late async completions cannot touch a newer draft.
  const draftSessionRef = useRef(0);
  const seedGenerationRef = useRef(0);
  // The latest requested context, read when a detail response arrives, so a
  // Back/Forward move during the request wins over the request's closure.
  const requestedContextRef = useRef({ profileId: "", environmentId: "", organizationId: "" });
  const selectedArchitectureRef = useRef(selectedArchitectureId);
  selectedArchitectureRef.current = selectedArchitectureId;
  const { layout, ref: measureSurface } = useSplitLayout();
  const surfaceNode = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const workbenchTitleRef = useRef<HTMLHeadingElement>(null);
  const launcherRef = useRef<HTMLAnchorElement>(null);
  const newNameRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const stacked = layout === "stack";

  // The URL owns explicit selection. Guards run before any URL change, so
  // adopting the route here never prompts. The root keeps the current
  // architecture, or the first one when nothing is selected yet.
  const resolvedArchitectureId = loadState !== "ready"
    ? selectedArchitectureId
    : routeId ?? (selectedArchitectureId && architectures.some((item) => item.id === selectedArchitectureId)
      ? selectedArchitectureId
      : architectures[0]?.id ?? null);
  if (resolvedArchitectureId !== selectedArchitectureId) {
    adoptArchitecture(resolvedArchitectureId, routeId === resolvedArchitectureId ? route.context : {});
  }
  if (routeId !== seenRouteId) {
    setSeenRouteId(routeId);
    // A move back to the section root shows the list again on phones.
    if (routeId === null) setOpened(false);
  }

  function adoptArchitecture(id: string | null, context: ArchitectureContextParams) {
    setSelectedArchitectureId(id);
    setSelectedDetail(null);
    setHistoryRevisionId(null);
    setHistoryRevision(null);
    setHistoryState("idle");
    setHistoryMessage(null);
    setEditorSeed(null);
    setProfiles([]);
    setEnvironments([]);
    // Requested context is validated once the architecture detail loads.
    setSelectedProfileId(context.profile ?? "");
    setSelectedEnvironmentId(context.environment ?? "");
    setSelectedOrganizationId(context.organization ?? "");
    setVisibleOrganizations([]);
    setSpecDirty(false);
    setMessageDirty(false);
    setPreview(null);
    setDraftPreview(null);
    setDetailMessage(null);
    setContextNotice(false);
    setSavedNotice(null);
    setOverviewTab("overview");
  }

  const selectedArchitecture = useMemo(
    () => architectures.find((item) => item.id === selectedArchitectureId) ?? null,
    [architectures, selectedArchitectureId],
  );
  const selectedAvailable = selectedArchitecture !== null;
  const unavailable = loadState === "ready" && routeId !== null && !architectures.some((item) => item.id === routeId);
  const workbench = route.surface === "workbench" && !unavailable;
  const organizationOnly = architectureIsOrganizationOnly(selectedDetail ?? selectedArchitecture);
  const currentContext = useMemo<ArchitectureContextParams>(() => organizationOnly
    ? (selectedOrganizationId ? { organization: selectedOrganizationId } : {})
    : {
      ...(selectedProfileId ? { profile: selectedProfileId } : {}),
      ...(selectedEnvironmentId ? { environment: selectedEnvironmentId } : {}),
      ...(selectedOrganizationId ? { organization: selectedOrganizationId } : {}),
    }, [organizationOnly, selectedEnvironmentId, selectedOrganizationId, selectedProfileId]);

  // Back and Forward between entries of the same architecture restore that
  // entry's context. Our own replaceState writes already match the state, so
  // only a real history move reaches restoreRouteContext.
  if (routeContextKey !== seenRouteContextKey) {
    setSeenRouteContextKey(routeContextKey);
    if (routeId !== null
      && routeId === selectedArchitectureId
      && resolvedArchitectureId === selectedArchitectureId
      && hasRequestedContext(route.context)
      && routeContextKey !== architectureContextKey(currentContext)) {
      restoreRouteContext(route.context);
    }
  }

  function restoreRouteContext(context: ArchitectureContextParams) {
    if (!selectedDetail || selectedDetail.id !== selectedArchitectureId) {
      // The pending detail response validates this request when it arrives.
      setSelectedProfileId(context.profile ?? "");
      setSelectedEnvironmentId(context.environment ?? "");
      setSelectedOrganizationId(context.organization ?? "");
      setContextNotice(false);
      return;
    }
    const allowedOrganizationIds = architectureOrganizationIds(selectedDetail);
    const requestedOrganization = context.organization ?? "";
    // An organization outside the grant is never applied.
    const organizationAllowed = requestedOrganization === "" || allowedOrganizationIds.includes(requestedOrganization);
    let replaced = !organizationAllowed;
    if (!architectureIsOrganizationOnly(selectedDetail)) {
      const profile = profiles.find((item) => item.id === context.profile) ?? profiles[0];
      const environment = (profile && environments.find((item) => item.id === context.environment && environmentBelongsToProfile(item, profile.id)))
        || (profile ? boundEnvironmentForProfile(environments, profile.id) : undefined);
      if ((context.profile && profile?.id !== context.profile) || (context.environment && environment?.id !== context.environment)) replaced = true;
      setSelectedProfileId(profile?.id ?? "");
      setSelectedEnvironmentId(environment?.id ?? "");
    }
    setSelectedOrganizationId(organizationAllowed ? requestedOrganization : "");
    setDraftPreview(null);
    setContextNotice(replaced);
  }

  // Another architecture, a new history seed or a reload each replace the draft session.
  useEffect(() => {
    draftSessionRef.current += 1;
  }, [selectedArchitectureId, editorSeed, refreshKey]);

  requestedContextRef.current = { profileId: selectedProfileId, environmentId: selectedEnvironmentId, organizationId: selectedOrganizationId };

  const surfaceRef = useCallback((node: HTMLDivElement | null) => {
    surfaceNode.current = node;
    measureSurface(node);
  }, [measureSurface]);

  // Declared before the focus effect so a surface change focuses in the same commit.
  const previousSurface = useRef(workbench);
  useEffect(() => {
    if (previousSurface.current === workbench) return;
    previousSurface.current = workbench;
    pendingFocus.current = workbench ? { kind: "workbench-title" } : { kind: "launcher" };
  }, [workbench]);

  useEffect(() => {
    const next = pendingFocus.current;
    if (!next) return;
    const element = next.kind === "title" ? titleRef.current
      : next.kind === "workbench-title" ? workbenchTitleRef.current
        : next.kind === "launcher" ? launcherRef.current ?? titleRef.current
          : next.kind === "new" ? newNameRef.current
            : Array.from(surfaceNode.current?.querySelectorAll<HTMLElement>("[data-architecture-id]") ?? []).find((item) => item.dataset.architectureId === next.id) ?? null;
    if (!element || element.closest("[hidden]")) return;
    pendingFocus.current = null;
    element.focus();
  });

  // Moves inside the section keep the draft when they stay on the current
  // architecture or return to the section root, which keeps the selection.
  const keepsDraft = useCallback((destination: URL) => {
    const next = parseArchitectureRoute(destination.pathname, destination.search);
    return next !== null && (next.architectureId === null || next.architectureId === selectedArchitectureRef.current);
  }, []);
  const { confirmDiscardDraft, guardNavigation } = useArchitectureNavigationGuard(hasUnsavedDraft, keepsDraft);

  useEffect(() => {
    if (!onNavigationGuardChange) return;
    onNavigationGuardChange(guardNavigation);
    return () => onNavigationGuardChange(null);
  }, [guardNavigation, onNavigationGuardChange]);

  const requestRefresh = useCallback(() => {
    if (!confirmDiscardDraft("refresh")) return;
    setSpecDirty(false);
    setMessageDirty(false);
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
    // An explicit ID outside the authorized list is never requested.
    if (!selectedArchitectureId || loadState !== "ready" || !selectedAvailable) {
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
        if (!active) return;
        // Validate the latest request, not the values captured when the fetch began.
        const requested = requestedContextRef.current;
        const contexts = architectureContexts(detail);
        const profileId = contexts.profiles.some((item) => item.id === requested.profileId)
          ? requested.profileId
          : contexts.profiles[0]?.id ?? "";
        const environmentId = contexts.environments.find((environment) => environment.id === requested.environmentId && environmentBelongsToProfile(environment, profileId))?.id
          ?? boundEnvironmentForProfile(contexts.environments, profileId)?.id
          ?? "";
        const allowedOrganizationIds = architectureOrganizationIds(detail);
        // Say so when a requested context was replaced; never widen it silently.
        const contextReplaced = (!architectureIsOrganizationOnly(detail) && ((requested.profileId !== "" && profileId !== requested.profileId)
          || (requested.environmentId !== "" && environmentId !== requested.environmentId)))
          || (requested.organizationId !== "" && !allowedOrganizationIds.includes(requested.organizationId));
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
        setSelectedOrganizationId((current) => allowedOrganizationIds.includes(current) ? current : "");
        if (contextReplaced) setContextNotice(true);
        setPreview(null);
        setDraftPreview(null);
        setDetailState("ready");
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
  }, [client, loadState, refreshKey, selectedArchitectureId, selectedAvailable]);

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
    const organizationOnlyDetail = architectureIsOrganizationOnly(selectedDetail);
    if (!selectedArchitectureId || selectedDetail?.id !== selectedArchitectureId || (!organizationOnlyDetail && (!selectedDetail?.latestRevision || !selectedProfileId || !selectedEnvironmentId))) {
      return;
    }
    if (organizationOnlyDetail && !selectedOrganizationId) {
      setPreview(null);
      setDetailMessage(null);
      setDetailState("ready");
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    const request = organizationOnlyDetail
      ? { organizationId: selectedOrganizationId }
      : {
        profileId: selectedProfileId,
        environmentId: selectedEnvironmentId,
        revisionId: selectedDetail.latestRevision!.id,
        ...(selectedOrganizationId ? { organizationId: selectedOrganizationId } : {}),
      };
    client.previewArchitecture(selectedArchitectureId, request).then((nextPreview) => {
      if (!active) return;
      if (organizationOnlyDetail) {
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

  // Keep the explicit URL in step with the validated context, replacing the
  // entry so reloads, new tabs and Back/Forward restore the same view.
  useEffect(() => {
    if (routeId === null || routeId !== selectedArchitectureId || selectedDetail?.id !== routeId) return;
    if (architectureContextKey(route.context) === architectureContextKey(currentContext)) return;
    onNavigateRef.current(architectureUrl(routeId, route.surface, currentContext), "replace");
  }, [currentContext, route, routeId, selectedArchitectureId, selectedDetail]);

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
    // Saving still sends the latest revision as the concurrency token.
    seedGenerationRef.current += 1;
    setEditorSeed({ revisionId: revision.id, revisionLabel: revisionLabel(revision), spec: structuredClone(revision.spec), generation: seedGenerationRef.current });
    setDraftPreview(null);
    setSavedNotice(null);
    draftPreviewEpoch.current += 1;
    onNavigateRef.current(architectureUrl(selectedArchitectureId, "workbench", currentContext), "push");
  }, [confirmDiscardDraft, currentContext, selectedArchitectureId, selectedDetail]);

  const handleDraftChange = useCallback((status: ArchitectureEditorStatus) => {
    setSpecDirty(status.dirty);
    // Any spec change, including an undo back to the baseline, makes an
    // earlier draft preview stale.
    setDraftPreview(null);
    draftPreviewEpoch.current += 1;
    if (status.dirty) setSavedNotice(null);
  }, []);

  const handleMessageDirtyChange = useCallback((dirty: boolean) => {
    setMessageDirty(dirty);
  }, []);

  function followSectionLink(event: MouseEvent<HTMLAnchorElement>) {
    // Modified clicks keep normal browser behaviour, such as a new tab.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const href = event.currentTarget.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    onNavigate(href, "push");
  }

  // Replace a root URL once the reader picks a context, so it can be shared.
  function syncRootContext(context: ArchitectureContextParams) {
    if (routeId === null && selectedArchitectureId) onNavigate(architectureUrl(selectedArchitectureId, "overview", context), "replace");
  }

  function openArchitecture(id: string) {
    if (id !== selectedArchitectureId && !confirmDiscardDraft("switch architectures")) return;
    setMode("detail");
    openerRef.current = null;
    if (stacked) {
      setOpened(true);
      pendingFocus.current = { kind: "title" };
    }
    const next = architectureUrl(id, "overview", id === selectedArchitectureId ? currentContext : {});
    if (routeId !== id || route.surface !== "overview") onNavigate(next, "push");
  }

  function backToArchitectures() {
    setOpened(false);
    if (selectedArchitectureId) pendingFocus.current = { kind: "row", id: selectedArchitectureId };
    if (routeId !== null) onNavigate(architectureUrl(null, "overview"), "push");
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
  const newVisible = !workbench && (mode === "new" || (noArchitectures && routeId === null));
  const detailOpen = routeId !== null || opened;
  const showList = !workbench && (!stacked || (!detailOpen && !newVisible));
  const showInspector = workbench || !stacked || detailOpen || newVisible;
  const readOnly = !(selectedDetail?.access?.canAppend ?? selectedArchitecture?.access?.canAppend ?? false);
  const launcherLabel = !selectedDetail || selectedDetail.id !== selectedArchitectureId
    ? null
    : hasUnsavedDraft
      ? "Resume draft"
      : selectedDetail.latestRevision
        ? readOnly ? "Inspect in workbench" : "Open workbench"
        : readOnly ? null : "Build first revision";
  const allowedOrganizationIds = architectureOrganizationIds(selectedDetail ?? selectedArchitecture);
  const contextAvailable = (profiles.length > 0 && environments.length > 0) || (organizationOnly && allowedOrganizationIds.length > 0);
  const contextSelectors = (
    <ArchitectureContextSelectors
      profiles={profiles}
      environments={environments}
      selectedProfileId={selectedProfileId}
      selectedEnvironmentId={selectedEnvironmentId}
      allowedOrganizationIds={allowedOrganizationIds}
      organizationChoices={organizationChoices(allowedOrganizationIds, visibleOrganizations)}
      organizationOnly={organizationOnly}
      selectedOrganizationId={selectedOrganizationId}
      onProfileChange={(value) => {
        const profile = profiles.find((item) => item.id === value);
        const environment = profile ? boundEnvironmentForProfile(environments, profile.id) : undefined;
        if (!profile || !environment) return;
        setDraftPreview(null);
        setContextNotice(false);
        setSelectedProfileId(profile.id);
        setSelectedEnvironmentId(environment.id);
        syncRootContext({ ...currentContext, profile: profile.id, environment: environment.id });
      }}
      onEnvironmentChange={(value) => {
        const environment = environments.find((item) => item.id === value);
        const profileId = environment ? environmentProfileId(environment, profiles) : undefined;
        if (!environment || !profileId) return;
        setDraftPreview(null);
        setContextNotice(false);
        setSelectedProfileId(profileId);
        setSelectedEnvironmentId(environment.id);
        syncRootContext({ ...currentContext, profile: profileId, environment: environment.id });
      }}
      onOrganizationChange={(value) => {
        if (value && !allowedOrganizationIds.includes(value)) return;
        setDraftPreview(null);
        setContextNotice(false);
        setSelectedOrganizationId(value);
        syncRootContext({ ...currentContext, organization: value || undefined });
      }}
    />
  );
  const contextNoticeNode = contextNotice
    ? <p className="architecture-context-fallback" role="status"><CircleAlert size={15} aria-hidden="true" /> {CONTEXT_FALLBACK_NOTICE}</p>
    : null;

  return (
    <main className="architecture-workspace cp-page" aria-label="Skill architectures" data-surface={workbench ? "workbench" : "overview"}>
      <header className="cp-page-head app-page-header" hidden={workbench}>
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
        <div className="cp-surface" data-layout={layout} data-surface={workbench ? "workbench" : "overview"} ref={surfaceRef}>
          <div className="cp-body">
            <ArchitectureList
              architectures={architectures}
              hidden={!showList}
              selectedId={unavailable ? null : selectedArchitectureId}
              onSelect={openArchitecture}
            />
            <div className="cp-inspector" hidden={!showInspector} onFocusCapture={() => {
              // Preserve the active detail (and its diagram dialog) when a
              // desktop inspector becomes a stacked layout during resize.
              if (!stacked && !newVisible) setOpened(true);
            }}>
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
                    if (!shouldOpen) {
                      // Declining the discard returns to the dirty architecture.
                      pendingFocus.current = { kind: "title" };
                      return;
                    }
                    // Back from the new Workbench lands on the new overview.
                    onNavigate(architectureUrl(created.id, "overview"), "push");
                    onNavigate(architectureUrl(created.id, "workbench"), "push");
                  }}
                />
              </div>
              {unavailable ? (
                <div className="cp-panel" hidden={newVisible}>
                  {stacked && (
                    <Button className="cp-back" type="button" variant="ghost" onClick={backToArchitectures}>Back to architectures</Button>
                  )}
                  <div className="cp-inspector-state architecture-unavailable" role="alert">
                    <CircleAlert size={20} aria-hidden="true" />
                    <div>
                      <strong>This architecture isn't available to your account.</strong>
                      <p>It may have been removed, or your access may have changed. No other architecture was opened in its place.</p>
                      <a className="architecture-text-link" href={architectureUrl(null, "overview")} onClick={followSectionLink}>View all architectures</a>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="cp-panel" hidden={newVisible || workbench}>
                    <ArchitectureDetailPanel
                      tab={overviewTab}
                      onTabChange={setOverviewTab}
                      titleRef={titleRef}
                      onBack={stacked ? backToArchitectures : undefined}
                      architecture={selectedArchitecture}
                      detail={selectedDetail}
                      detailState={detailState}
                      message={detailMessage}
                      preview={preview}
                      historyRevisionId={historyRevisionId}
                      historyRevision={historyRevision}
                      historyState={historyState}
                      historyMessage={historyMessage}
                      patterns={patterns}
                      organizationOnly={organizationOnly}
                      contextAvailable={contextAvailable}
                      contextSelectors={workbench ? null : contextSelectors}
                      notices={workbench ? null : contextNoticeNode}
                      launcher={selectedArchitectureId && launcherLabel ? {
                        href: architectureUrl(selectedArchitectureId, "workbench", currentContext),
                        label: launcherLabel,
                        onClick: followSectionLink,
                        ref: launcherRef,
                      } : null}
                      hasUnsavedDraft={hasUnsavedDraft}
                      fixtureKey={`${selectedArchitectureId ?? ""}:${selectedProfileId}:${selectedEnvironmentId}`}
                      onHistorySelect={handleHistorySelect}
                      onUseRevisionAsDraft={handleUseRevisionAsDraft}
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
                        if (!created) {
                          setRefreshKey((value) => value + 1);
                          return;
                        }
                        setArchitectures((current) => [created, ...current.filter((item) => item.id !== created.id)]);
                        if (confirmDiscardDraft("switch architectures")) onNavigate(architectureUrl(created.id, "overview"), "push");
                      }}
                      client={client}
                      onRetry={requestRefresh}
                    />
                  </div>
                  {selectedArchitecture && (
                    <div className="cp-panel architecture-workbench-panel" hidden={!workbench}>
                      <ArchitectureWorkbenchPanel
                        architecture={selectedArchitecture}
                        detail={selectedDetail?.id === selectedArchitecture.id ? selectedDetail : null}
                        detailState={detailState}
                        message={detailMessage}
                        editorSeed={editorSeed}
                        overviewHref={architectureUrl(selectedArchitecture.id, "overview", currentContext)}
                        onOverviewLink={followSectionLink}
                        titleRef={workbenchTitleRef}
                        notices={workbench ? <>
                          {savedNotice && <p className="architecture-saved-note" role="status"><Check size={15} aria-hidden="true" /> {savedNotice}</p>}
                          {contextNoticeNode}
                        </> : null}
                        contextSelectors={workbench ? contextSelectors : null}
                        draftPreview={draftPreview}
                        client={client}
                        onRetry={requestRefresh}
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
                          const architectureId = selectedArchitectureId;
                          const draftSession = draftSessionRef.current;
                          try {
                            const revision = await client.createArchitectureRevision(architectureId, {
                              spec,
                              expectedCurrentRevisionId: expectedRevisionId,
                              ...(revisionMessage ? { message: revisionMessage } : {}),
                            });
                            // The reader moved to another draft while this save was pending:
                            // the revision is stored, but the newer draft is left untouched.
                            if (draftSession !== draftSessionRef.current || selectedArchitectureRef.current !== architectureId) return;
                            setDraftPreview(null);
                            setSavedNotice(`${revisionLabel(revision)} saved.`);
                            pendingFocus.current = { kind: "workbench-title" };
                            setRefreshKey((value) => value + 1);
                          } catch (error) {
                            throw new Error(safeArchitectureErrorMessage(error));
                          }
                        }}
                        onDraftChange={handleDraftChange}
                        onMessageDirtyChange={handleMessageDirtyChange}
                        onSearchRegistrySkills={searchArchitectureRegistrySkills}
                        onLoadRegistryReleases={loadArchitectureRegistryReleases}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
