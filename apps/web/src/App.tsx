import { ConfirmationDialog, type ConfirmationRequest } from "@/components/ui/confirmation-dialog";
import { MarketingLanding } from "./components/marketing/MarketingLanding.js";
import { LandingSettings } from "./components/marketing/LandingSettings.js";
import { QRCodeSVG } from "qrcode.react";
import { BrandingProvider } from "./components/branding/BrandingProvider.js";
import { BrandIdentity } from "./components/branding/BrandIdentity.js";
import { GithubAccountConnection } from "./components/github/GithubAccountConnection.js";
import { GithubSettings } from "./components/github/GithubSettings.js";
import { BrandingSettings } from "./components/branding/BrandingSettings.js";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  Ellipsis,
  FileCode2,
  KeyRound,
  Layers,
  LayoutGrid,
  Library,
  Link2,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  Monitor,
  PackageCheck,
  PackageOpen,
  Pin,
  Plus,
  RotateCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Shield,
  SquareCheckBig,
  Trash2,
  Upload,
  UserCog,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { parseSemanticVersion, type PublicSkill, type RegistryView, type SkillSharingDetails, type TeamSharedSkillGroup, type VisibilityScope } from "@myskills-app/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Frame, FramePanel } from "@/components/reui/frame";
import { ArchitecturesDashboard } from "@/components/architecture/ArchitecturesDashboard";
import { isArchitecturePath } from "@/components/architecture/architecture-route";
import type { ArchitectureNavigationGuard } from "@/components/architecture/useArchitectureNavigationGuard";
import { OrganizationsDashboard } from "@/components/organization/OrganizationsDashboard";
import { ArchitectureTargetsDashboard } from "@/components/target/ArchitectureTargetsDashboard";
import { LibrariesDashboard } from "@/components/library/LibrariesDashboard";
import { tileTone } from "@/components/library/library-display";
import { SystemUpdateCenter } from "@/components/update/SystemUpdateCenter";
import { AddToLibraryButton } from "@/components/library/AddToLibraryButton";
import { PackageFileViewer } from "@/components/registry/PackageFileViewer";
import { ManagedSkillsInventory } from "@/components/registry/ManagedSkillsInventory";
import { SkillManagePanel } from "@/components/registry/SkillManagePanel";
import { ManagedReleaseSelect, SkillSectionTabs, SkillVersionsPanel } from "@/components/registry/SkillSections";
import { isPublishedRelease, parseSkillScope, parseSkillTab, safeLibraryReturn, sectionPanelId, sectionTabId, type SkillScope, type SkillTab } from "@/components/registry/skill-workspace";
import { SubmissionEvidencePanel } from "@/components/registry/SubmissionEvidencePanel";
import { SkillImprovementPanel } from "@/components/registry/SkillImprovementPanel";
import { BundleWorkspace } from "@/components/registry/BundleWorkspace";
import { isBootstrapVersion, releaseVersionLabel, chipTone, findingsLabel, lifecycleLabel, reviewStatusLabel, securityStatusLabel, severityLabel, visibilityLabel } from "@/components/registry/status-display";
import { useSplitLayout } from "@/components/registry/useSplitLayout";
import {
  createRegistryClient,
  exportCommand,
  safeAccountErrorMessage,
  safeAdminErrorMessage,
  safeAuthErrorMessage,
  safeErrorMessage,
  safeReviewErrorMessage,
  safeSubmitErrorMessage,
  safeTeamErrorMessage,
  safeArchitectureTargetErrorMessage,
  type AdminSharingSettings,
  type AdminApiToken,
  type ConfirmMfaResult,
  type ApiToken,
  type ApiTokenScope,
  type AdminAuditEvent,
  type AdminProviderConfig,
  type AdminRegistrationMode,
  type AdminUser,
  type ArchitectureTargetRecord,
  type MfaStatus,
  type ProviderRoleMappingInput,
  type RegistryClient,
  type ReleaseMetadata,
  type ReleaseLifecycleActionName,
  type RegistrationInvitation,
  type ReviewActionResult,
  type ReviewActionName,
  type ReviewSubmissionSummary,
  type SkillManagementSummary,
  type SkillReleaseSummary,
  type SubmitSkillResult,
  type TeamDashboard,
  type TeamInvitation,
  type TeamRecord,
  type UserSubmissionSummary,
  type WebAuthUser,
} from "./api.js";

import { canQueueWorkspaceOperation } from "./components/target/workspace-target.js";

interface RegistryAppProps {
  client?: RegistryClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AuthState = "idle" | "loading" | "mfa";
type AppView = "libraries" | "landing" | "login" | "register" | "reset-password" | "verify-email" | "change-email" | "browse" | "architectures" | "organizations" | "targets" | "updates" | "admin" | "review" | "submit" | "teams" | "settings" | "not-found";

interface AppLocation {
  view: AppView;
  slug: string | null;
  query: string;
  platform: string;
  version: string | null;
  catalog: CatalogLocation;
  workspace: WorkspaceLocation;
}

/** Skills catalog state kept in the URL beside the existing skill parameters. */
interface CatalogLocation {
  view: RegistryView;
  bundle: string | null;
}

/** Skills workspace scope, detail section and a validated Libraries return path. */
interface WorkspaceLocation {
  scope: SkillScope;
  tab: SkillTab;
  returnTo: string | null;
}

// "denied" is the server's answer (401/403/404). "error" means the check did
// not complete (network, 5xx) and must be retried, not shown as a denial.
type ManagedDetail = { slug: string; status: "loading" | "ready" | "denied" | "error"; record: SkillManagementSummary | null };

type RegistryLayout = "split" | "stack";
type MobileMenu = "more" | "account";
type RegistryFocus = { kind: "title" } | { kind: "row"; slug: string };
interface RegistryDisclosures {
  notes: boolean;
  details: boolean;
  files: boolean;
  improvement: boolean;
}
type ReleaseCardState = "ready" | "loading" | "error" | "no-default";

const APP_HISTORY_INDEX_KEY = "__myskillsAppHistoryIndex";
// The Skills page splits into list and inspector when its own surface is this wide.
const REGISTRY_SPLIT_WIDTH = 880;

interface WebSession {
  expiresAt: string;
  user: WebAuthUser;
}

interface MfaPending {
  challengeToken: string;
  email: string;
}

interface ProviderDraft {
  key: string;
  type: AdminProviderConfig["type"];
  displayName: string;
  issuer: string;
  clientId: string;
  enabled: boolean;
  roleMappings: ProviderRoleMappingInput[];
}


function operationKey(action: "install"): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${action}:${random.replaceAll("-", "")}`;
}

const API_TOKEN_SCOPE_OPTIONS: Array<{ scope: ApiTokenScope; label: string }> = [
  { scope: "profile:read", label: "Profile" },
  { scope: "skills:read", label: "Read skills" },
  { scope: "architectures:read", label: "Read architectures" },
  { scope: "skills:submit", label: "Submit skills" },
  { scope: "libraries:read", label: "Read libraries" },
  { scope: "libraries:write", label: "Manage libraries" },
  { scope: "review:read", label: "Review read" },
  { scope: "review:write", label: "Review write" },
  { scope: "targets:execute", label: "Execute target updates" },
  { scope: "improvements:read", label: "Read improvement plans and evidence" },
  { scope: "improvements:configure", label: "Configure improvement policies" },
  { scope: "improvements:run", label: "Run skill improvements" },
  { scope: "improvements:report", label: "Share and review improvement evidence" },
];

export function RegistryApp({ client }: RegistryAppProps) {
  const registryClient = useMemo(() => client ?? createRegistryClient(), [client]);
  return <BrandingProvider client={registryClient}><RegistryContent client={registryClient} /></BrandingProvider>;
}

function RegistryContent({ client: registryClient }: { client: RegistryClient }) {
  const initialLocation = appLocationFromWindow();
  const historyIndexRef = useRef(readAppHistoryIndex(window.history.state) ?? 0);
  const currentLocationRef = useRef(initialLocation);
  const currentUrlRef = useRef(currentBrowserUrl());
  const architectureNavigationGuardRef = useRef<ArchitectureNavigationGuard | null>(null);
  const restoringPopstateRef = useRef(false);
  const [view, setView] = useState<AppView>(initialLocation.view);
  // Routes that own URL state beyond the view (the architecture section) read it from here.
  const [appUrl, setAppUrl] = useState(currentBrowserUrl);
  const [session, setSession] = useState<WebSession | null>(() => readStoredSession());
  // Bundle catalog, when the client and server provide it. A 404 from the
  // catalog falls back to the flat Skills list for this session.
  const [catalogAvailable, setCatalogAvailable] = useState(() => Boolean(registryClient.bundles));
  const [catalogView, setCatalogView] = useState<RegistryView>(initialLocation.catalog.view);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(initialLocation.catalog.bundle);
  const catalogLocationRef = useRef<CatalogLocation>(initialLocation.catalog);
  const [scope, setScope] = useState<SkillScope>(initialLocation.workspace.scope);
  const [tab, setTab] = useState<SkillTab>(initialLocation.workspace.tab);
  const [returnTo, setReturnTo] = useState<string | null>(initialLocation.workspace.returnTo);
  const workspaceLocationRef = useRef<WorkspaceLocation>(initialLocation.workspace);
  const browseUrl = (slug: string | null, nextQuery: string, nextPlatform: string, version: string | null = null) => (
    registryUrl(slug, nextQuery, nextPlatform, version, catalogLocationRef.current, workspaceLocationRef.current)
  );
  const updateWorkspaceLocation = (next: Partial<WorkspaceLocation>) => {
    workspaceLocationRef.current = { ...workspaceLocationRef.current, ...next };
    if (next.scope !== undefined) setScope(next.scope);
    if (next.tab !== undefined) setTab(next.tab);
    if (next.returnTo !== undefined) setReturnTo(next.returnTo);
  };
  const bundleCatalog = catalogAvailable ? registryClient.bundles : undefined;
  const [siteState, setSiteState] = useState<{ view: AppView; enabled?: boolean; failed?: boolean } | null>(null);
  const [siteRetry, setSiteRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setSiteState(null);
    if (!["landing", "login", "not-found"].includes(view)) return;
    registryClient.getSiteSettings().then((site) => {
      if (!active) return;
      if (typeof site.landingPageEnabled !== "boolean") throw new Error("Invalid site settings.");
      setSiteState({ view, enabled: site.landingPageEnabled });
      if (view === "landing" && !site.landingPageEnabled) {
        setView("login");
        replaceAppHistory("/login");
      }
    }).catch(() => { if (active) setSiteState({ view, failed: true }); });
    return () => { active = false; };
  }, [registryClient, view, siteRetry]);
  const [query, setQuery] = useState(initialLocation.query);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialLocation.slug);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(initialLocation.version);
  const [selectedSkill, setSelectedSkill] = useState<PublicSkill | null>(null);
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [visibleReleases, setVisibleReleases] = useState<SkillReleaseSummary[]>([]);
  // Every exact release record the server returned for the selected skill. For
  // a manager this includes unpublished releases; readers only see published.
  const [releaseRows, setReleaseRows] = useState<SkillReleaseSummary[]>([]);
  const [historyState, setHistoryState] = useState<LoadState>("idle");
  // Management authority for the selected skill comes from the server's
  // management record, never from the readable skill's sharing flag.
  const [managed, setManaged] = useState<ManagedDetail | null>(null);
  const [managedRetry, setManagedRetry] = useState(0);
  // The slug whose readable (public) detail failed; a manager may still load it.
  const [publicFailure, setPublicFailure] = useState<string | null>(null);
  // A saved management change reloads in place instead of clearing the detail.
  const softReload = useRef({ detail: false, managed: false });
  const [platform, setPlatform] = useState(initialLocation.platform);
  const [listState, setListState] = useState<LoadState>("idle");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listEpoch = useRef(0);
  const searchSelectionQuery = useRef<string | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenu, setMobileMenu] = useState<MobileMenu | null>(null);
  // Explicit app navigation to Libraries starts it fresh from the new URL.
  // Its own library/entry URL writes (navigateFromLibraries) never bump this.
  const [libraryNavigationRevision, setLibraryNavigationRevision] = useState(0);
  const mobileMoreButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMoreMenuRef = useRef<HTMLDivElement>(null);
  const mobileAccountButtonRef = useRef<HTMLButtonElement>(null);
  const mobileAccountMenuRef = useRef<HTMLDivElement>(null);
  const [registryLayout, setRegistryLayout] = useState<RegistryLayout | null>(null);
  const registryLayoutRef = useRef<RegistryLayout | null>(null);
  const registryObserver = useRef<ResizeObserver | null>(null);
  const registrySurfaceRef = useRef<HTMLDivElement | null>(null);
  const inspectorTitleRef = useRef<HTMLHeadingElement>(null);
  const pendingRegistryFocus = useRef<RegistryFocus | null>(null);
  const [registryDisclosures, setRegistryDisclosures] = useState<RegistryDisclosures>({ notes: false, details: false, files: false, improvement: false });
  const setRegistryDisclosure = (key: keyof RegistryDisclosures, open: boolean) => setRegistryDisclosures((current) => current[key] === open ? current : { ...current, [key]: open });
  const sectionsId = useId();
  // Can manage needs a session and the management inventory; otherwise the
  // workspace reads the catalog.
  const canUseManageScope = Boolean(session && registryClient.listManagedSkills);
  const workspaceScope: SkillScope = scope === "manage" && canUseManageScope ? "manage" : "all";
  // A desktop split shows the first result without choosing it: the URL stays
  // /registry until the reader picks a skill. A stack shows the list instead.
  const implicitSlug = workspaceScope === "all" && registryLayout === "split" && selectedSlug === null ? skills[0]?.slug ?? null : null;
  const detailSlug = selectedSlug ?? implicitSlug;
  const canUseAdmin = Boolean(session && isAdminUser(session.user));
  const canUseReview = Boolean(session && isReviewerUser(session.user));
  const canUseSubmit = Boolean(session && isSubmitterUser(session.user));
  const canUseTeams = Boolean(session);
  const canUseOrganizations = Boolean(session && registryClient.listOrganizations);
  const canUseTargets = Boolean(session && registryClient.listArchitectureTargets);
  const activeView: AppView = view === "browse" && scope === "manage" && !session
    ? "login"
    : isPublicView(view)
    ? view
    : !session
      ? "login"
        : view === "admin" && canUseAdmin
          ? "admin"
        : view === "review" && canUseReview
          ? "review"
        : view === "submit" && canUseSubmit
          ? "submit"
        : view === "libraries" && session
          ? "libraries"
        : view === "architectures" && session
          ? "architectures"
        : view === "organizations" && canUseOrganizations
          ? "organizations"
        : view === "targets" && canUseTargets
          ? "targets"
        : view === "updates" && canUseTargets
          ? "updates"
        : view === "teams" && canUseTeams
          ? "teams"
        : view === "settings"
          ? "settings"
          : "browse";

  const replaceAppHistory = (nextUrl: string) => {
    window.history.replaceState(appHistoryState(historyIndexRef.current), "", nextUrl);
    currentLocationRef.current = appLocationFromWindow();
    currentUrlRef.current = currentBrowserUrl();
    setAppUrl(currentUrlRef.current);
  };

  const pushAppHistory = (nextUrl: string) => {
    historyIndexRef.current += 1;
    window.history.pushState(appHistoryState(historyIndexRef.current), "", nextUrl);
    currentLocationRef.current = appLocationFromWindow();
    currentUrlRef.current = currentBrowserUrl();
    setAppUrl(currentUrlRef.current);
  };

  const navigateArchitectures = (nextUrl: string, mode: "push" | "replace") => {
    if (mode === "push") pushAppHistory(nextUrl);
    else replaceAppHistory(nextUrl);
  };

  const registerArchitectureNavigationGuard = useCallback((guard: ArchitectureNavigationGuard | null) => {
    architectureNavigationGuardRef.current = guard;
  }, []);

  // Split or stack follows the Skills surface's own width, not the viewport.
  // A surface without layout (width 0, as in DOM tests) keeps the split default.
  const measureRegistry = useCallback((node: HTMLDivElement | null) => {
    registryObserver.current?.disconnect();
    registryObserver.current = null;
    registrySurfaceRef.current = node;
    if (!node) return;
    const apply = (width: number) => {
      const next: RegistryLayout = width === 0 || width >= REGISTRY_SPLIT_WIDTH ? "split" : "stack";
      registryLayoutRef.current = next;
      setRegistryLayout(next);
    };
    apply(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    registryObserver.current = new ResizeObserver(([entry]) => { if (entry) apply(entry.contentRect.width); });
    registryObserver.current.observe(node);
  }, []);

  useEffect(() => {
    const url = currentBrowserUrl();
    window.history.replaceState(appHistoryState(historyIndexRef.current), "", url);
    currentUrlRef.current = url;
  }, []);

  useEffect(() => {
    function syncFromBrowserHistory(event: PopStateEvent) {
      const next = appLocationFromWindow();
      const previous = currentLocationRef.current;
      const nextHistoryIndex = readAppHistoryIndex(event.state);

      if (restoringPopstateRef.current) {
        restoringPopstateRef.current = false;
        if (nextHistoryIndex !== null) {
          historyIndexRef.current = nextHistoryIndex;
        }
        currentLocationRef.current = next;
        currentUrlRef.current = currentBrowserUrl();
        setAppUrl(currentUrlRef.current);
        return;
      }

      // The architecture guard sees every move, including moves inside the
      // section; it prompts only when the destination would discard a draft.
      if (previous.view === "architectures") {
        const guard = architectureNavigationGuardRef.current;
        if (guard) {
          const action = nextHistoryIndex !== null && nextHistoryIndex < historyIndexRef.current
            ? "go back"
            : nextHistoryIndex !== null && nextHistoryIndex > historyIndexRef.current
              ? "go forward"
              : "navigate away";
          if (!guard(action, currentBrowserUrl())) {
            const restoreDelta = nextHistoryIndex === null
              ? null
              : historyIndexRef.current - nextHistoryIndex;
            if (restoreDelta && Number.isFinite(restoreDelta)) {
              restoringPopstateRef.current = true;
              try {
                window.history.go(restoreDelta);
              } catch {
                restoringPopstateRef.current = false;
                replaceAppHistory(currentUrlRef.current);
              }
            } else {
              replaceAppHistory(currentUrlRef.current);
            }
            return;
          }
        }
      }

      if (nextHistoryIndex !== null) {
        historyIndexRef.current = nextHistoryIndex;
      }
      applyLocation(next, previous);
    }
    window.addEventListener("popstate", syncFromBrowserHistory);
    return () => window.removeEventListener("popstate", syncFromBrowserHistory);
  }, []);

  // Moves every URL-owned piece of state to a location. Uses only setters and
  // refs, so the popstate listener registered once can call it safely.
  function applyLocation(next: AppLocation, previous: AppLocation) {
    currentLocationRef.current = next;
    currentUrlRef.current = currentBrowserUrl();
    setAppUrl(currentUrlRef.current);
    searchSelectionQuery.current = null;
    setView(next.view);
    // Clear eagerly only when the detail effects are certain to reload. An
    // implicit desktop selection can become the same explicit skill, so a
    // change to or from /registry is left to those effects.
    const bothExplicit = next.slug !== null && previous.slug !== null;
    if (bothExplicit && next.slug !== previous.slug) {
      setSelectedSkill(null);
      setVisibleReleases([]);
      setReleaseRows([]);
      setHistoryState("idle");
    }
    if (bothExplicit && (next.slug !== previous.slug || next.version !== previous.version)) {
      setRelease(null);
      setDetailState("loading");
    }
    if (registryLayoutRef.current === "stack" && next.view === "browse" && previous.view === "browse" && next.slug !== previous.slug) {
      pendingRegistryFocus.current = next.slug ? { kind: "title" } : previous.slug ? { kind: "row", slug: previous.slug } : null;
    }
    setSelectedSlug(next.slug);
    setSelectedVersion(next.version);
    setQuery(next.query);
    setPlatform(next.platform);
    catalogLocationRef.current = next.catalog;
    setCatalogView(next.catalog.view);
    setSelectedBundleId(next.catalog.bundle);
    workspaceLocationRef.current = next.workspace;
    setScope(next.workspace.scope);
    setTab(next.workspace.tab);
    setReturnTo(next.workspace.returnTo);
    setMobileMenu(null);
  }

  /** Opens an internal app URL (for example an exact skill link from Review) as a new history entry. */
  function openAppUrl(url: string) {
    const previous = currentLocationRef.current;
    pushAppHistory(url);
    applyLocation(currentLocationRef.current, previous);
  }

  // Libraries records its own library/entry/candidate URLs through the app
  // history so the history index and location refs stay accurate. A link that
  // leaves Libraries (for example to an exact skill) moves the app there too.
  // Stable: it uses only refs, setters and ref-backed helpers.
  const navigateFromLibraries = useCallback((url: string, mode: "push" | "replace") => {
    const previous = currentLocationRef.current;
    if (mode === "replace") replaceAppHistory(url);
    else pushAppHistory(url);
    if (currentLocationRef.current.view !== "libraries") applyLocation(currentLocationRef.current, previous);
  }, []);

  useEffect(() => {
    if (!mobileMenu) {
      return;
    }
    const menu = mobileMenu === "more" ? mobileMoreMenuRef.current : mobileAccountMenuRef.current;
    const trigger = mobileMenu === "more" ? mobileMoreButtonRef.current : mobileAccountButtonRef.current;
    menu?.querySelector<HTMLElement>("a[href], button")?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setMobileMenu(null);
      queueMicrotask(() => trigger?.focus());
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof window.Node)) {
        return;
      }
      if (!menu?.contains(target) && !trigger?.contains(target)) {
        setMobileMenu(null);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [mobileMenu]);

  useEffect(() => {
    // Can manage is private: signed-out readers sign in first, as the old
    // /manage/skills page required.
    if (!session && (!isPublicView(view) || (view === "browse" && scope === "manage"))) {
      setView("login");
      replaceAppHistory("/login");
      return;
    }
    if (session && view !== activeView) {
      setView(activeView);
      replaceAppHistory(activeView === "browse" ? browseUrl(selectedSlug, query, platform, selectedVersion) : pathForView(activeView));
      return;
    }
    if (session && view === "login") {
      setView("browse");
      replaceAppHistory("/registry");
    }
  }, [activeView, platform, query, scope, selectedSlug, selectedVersion, session, view]);

  useEffect(() => {
    if (activeView !== "browse") {
      return;
    }
    function focusSearch(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return;
      }
      event.preventDefault();
      document.getElementById("skill-search")?.focus();
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [activeView]);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    registryClient.getMe()
      .then((user) => {
        if (!active) {
          return;
        }
        const nextSession = { ...session, user };
        setSession(nextSession);
        writeStoredSession(nextSession);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        if (!error || typeof error !== "object" || !("status" in error) || error.status !== 401) {
          setAuthMessage("Your account could not be refreshed. Try again shortly.");
          return;
        }
        setSession(null);
        clearStoredSession();
        setAuthMessage("Session expired.");
      });
    return () => {
      active = false;
    };
  }, [registryClient, session?.expiresAt]);

  useEffect(() => {
    const requestEpoch = ++listEpoch.current;
    // The bundle catalog owns Skills rows while it is mounted, and the
    // management inventory owns them in the Can manage scope.
    if (activeView !== "browse" || catalogAvailable || workspaceScope !== "all") {
      setListState("idle");
      return;
    }
    let active = true;
    setListState("loading");
    setListMessage(null);
    setNextCursor(null);
    setLoadingMore(false);
    const request = registryClient.searchSkillPage
      ? registryClient.searchSkillPage({ query })
      : registryClient.searchSkills(query).then((items) => ({ skills: items, nextCursor: null }));
    request.then((result) => {
        if (!active) {
          return;
        }
        if (requestEpoch !== listEpoch.current) return;
        setSkills(result.skills);
        setNextCursor(result.nextCursor ?? null);
        if (searchSelectionQuery.current === query) {
          searchSelectionQuery.current = null;
          // Only an explicit split-view selection follows the search. An
          // implicit selection follows the first result, and a stacked list
          // never opens a skill the reader did not tap.
          const current = currentLocationRef.current;
          if (registryLayoutRef.current === "split" && current.slug !== null) {
            const nextSlug = result.skills.some((skill) => skill.slug === current.slug) ? current.slug : result.skills[0]?.slug ?? null;
            if (nextSlug !== current.slug) {
              setSelectedVersion(null);
              setRelease(null);
              setDetailState("loading");
              setSelectedSlug(nextSlug);
              replaceAppHistory(browseUrl(nextSlug, current.query, current.platform));
            }
          }
        }
        setListMessage(null);
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSkills([]);
        setListMessage(safeErrorMessage(error));
        setListState("error");
      });
    return () => {
      active = false;
    };
  }, [activeView, catalogAvailable, registryClient, query, refreshKey, workspaceScope]);

  function applyReleaseRows(slug: string, rows: SkillReleaseSummary[]) {
    const exact = rows.filter((row) => row.slug === slug && isExactReleaseVersion(row.version));
    setReleaseRows(exact.filter((row, index, all) => all.findIndex((other) => other.version === row.version) === index));
    setVisibleReleases(exact
      .filter((row) => isPublishedRelease(row))
      .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
      .filter((row, index, all) => all.findIndex((other) => other.version === row.version) === index));
  }

  useEffect(() => {
    if (activeView !== "browse" || !detailSlug) {
      setSelectedSkill(null);
      setRelease(null);
      setVisibleReleases([]);
      setReleaseRows([]);
      setHistoryState("idle");
      setDetailState("idle");
      setDetailMessage(null);
      setPublicFailure(null);
      return;
    }
    let active = true;
    // A soft reload keeps the current detail on screen until fresh data lands.
    const soft = softReload.current.detail;
    softReload.current.detail = false;
    if (!soft) {
      setSelectedSkill(null);
      setRelease(null);
      setVisibleReleases([]);
      setReleaseRows([]);
      setHistoryState("loading");
      setDetailState("loading");
      setDetailMessage(null);
      setPublicFailure(null);
    }
    registryClient.getSkill(detailSlug)
      .then(async (skill) => {
        if (!active) return;
        if (skill.slug !== detailSlug) {
          setSelectedSkill(null);
          setHistoryState("error");
          setDetailMessage("Skill or release not found.");
          setDetailState("error");
          return;
        }
        setSelectedSkill(skill);
        setPublicFailure(null);
        try {
          const rows = await registryClient.listSkillReleases(detailSlug);
          if (!active) return;
          applyReleaseRows(detailSlug, rows);
          setHistoryState("ready");
        } catch {
          if (!active) return;
          setVisibleReleases([]);
          setReleaseRows([]);
          setHistoryState("error");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSelectedSkill(null);
        setRelease(null);
        // A manager's management-only history reloads separately; keep it on a soft reload.
        if (!soft) {
          setVisibleReleases([]);
          setReleaseRows([]);
          setHistoryState("idle");
        }
        setDetailMessage(safeErrorMessage(error));
        setDetailState("error");
        setPublicFailure(detailSlug);
      });
    return () => { active = false; };
  }, [activeView, registryClient, detailSlug, refreshKey]);

  // Ask for the management record only when it can matter: in Can manage, for
  // privileged roles, when the readable skill says the reader owns it, or when
  // the readable detail is unavailable (archived or unpublished). The server
  // decides; a denial hides every lifecycle control.
  const sessionUserId = session?.user.id ?? null;
  const privilegedSession = Boolean(session && isReviewerUser(session.user));
  const skillReady = selectedSkill !== null && selectedSkill.slug === detailSlug;
  const ownsReadableSkill = skillReady && Boolean(session && selectedSkill.access?.canManageSharing);
  const wantManaged = activeView === "browse" && Boolean(detailSlug) && Boolean(session && registryClient.getManagedSkill)
    && (workspaceScope === "manage" || privilegedSession || ownsReadableSkill || publicFailure === detailSlug);
  const managedForSlug = managed && managed.slug === detailSlug ? managed : null;
  const managedRecord = managedForSlug?.status === "ready" ? managedForSlug.record : null;
  const managedLoading = wantManaged && (!managedForSlug || managedForSlug.status === "loading");
  const managementOnly = !skillReady && publicFailure === detailSlug && managedRecord !== null;

  useEffect(() => {
    const getManagedSkill = registryClient.getManagedSkill?.bind(registryClient);
    if (!wantManaged || !detailSlug || !getManagedSkill) {
      softReload.current.managed = false;
      setManaged(null);
      return;
    }
    let active = true;
    const slug = detailSlug;
    const soft = softReload.current.managed;
    softReload.current.managed = false;
    setManaged((current) => soft && current?.slug === slug ? current : { slug, status: "loading", record: null });
    getManagedSkill(slug)
      .then((record) => {
        if (!active) return;
        setManaged(record && record.slug === slug ? { slug, status: "ready", record } : { slug, status: "denied", record: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const status = apiErrorStatus(error);
        setManaged({ slug, status: status === 401 || status === 403 || status === 404 ? "denied" : "error", record: null });
      });
    return () => { active = false; };
  }, [wantManaged, detailSlug, refreshKey, registryClient, sessionUserId, managedRetry]);

  // Readable detail failed but the manager can load the record: its release
  // history comes from the same authorised releases read, never from a
  // synthesized PublicSkill or release.
  useEffect(() => {
    if (!managementOnly || !detailSlug) return;
    let active = true;
    setHistoryState((current) => current === "ready" ? current : "loading");
    registryClient.listSkillReleases(detailSlug)
      .then((rows) => {
        if (!active) return;
        applyReleaseRows(detailSlug, rows);
        setHistoryState("ready");
      })
      .catch(() => {
        if (!active) return;
        setReleaseRows([]);
        setVisibleReleases([]);
        setHistoryState("error");
      });
    return () => { active = false; };
  }, [managementOnly, detailSlug, registryClient, refreshKey]);

  useEffect(() => {
    if (activeView !== "browse" || !detailSlug || !selectedSkill || selectedSkill.slug !== detailSlug
      || (historyState !== "ready" && historyState !== "error")) return;
    let active = true;
    const exactVersion = selectedVersion ?? selectedSkill.latestVersion;
    setRelease(null);
    setDetailMessage(null);
    if (selectedVersion === null && !exactVersion) {
      setDetailState("ready");
      return;
    }
    if (!exactVersion || !isExactReleaseVersion(exactVersion)
      || (selectedVersion !== null && historyState === "ready"
        && !visibleReleases.some((item) => item.version === exactVersion))) {
      setDetailMessage("This exact release is unavailable.");
      setDetailState("error");
      return;
    }
    setDetailState("loading");
    registryClient.getRelease(detailSlug, exactVersion)
      .then((nextRelease) => {
        if (!active) return;
        if (nextRelease.slug !== detailSlug || nextRelease.version !== exactVersion
          || !isPublishedRelease(nextRelease)
          || !Array.isArray(nextRelease.platforms)
          || !nextRelease.artifact
          || typeof nextRelease.artifact.sha256 !== "string"
          || !Number.isFinite(nextRelease.artifact.byteSize)
          || typeof nextRelease.artifact.contentType !== "string") {
          setDetailMessage("This exact release is unavailable.");
          setDetailState("error");
          return;
        }
        setRelease(nextRelease);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRelease(null);
        setDetailMessage(selectedVersion !== null ? "This exact release is unavailable." : safeErrorMessage(error));
        setDetailState("error");
      });
    return () => { active = false; };
  }, [activeView, registryClient, detailSlug, selectedSkill, selectedVersion, historyState, visibleReleases]);

  useEffect(() => {
    if (activeView !== "browse" || !release || release.slug !== detailSlug
      || (selectedVersion !== null && release.version !== selectedVersion)) return;
    const nextPlatform = releasePlatform(release.platforms, platform);
    if (nextPlatform && nextPlatform !== platform) {
      setPlatform(nextPlatform);
      const current = currentLocationRef.current;
      // An implicit desktop selection leaves the URL alone.
      if (selectedSlug !== null && current.slug === selectedSlug && current.version === selectedVersion) {
        replaceAppHistory(browseUrl(selectedSlug, current.query, nextPlatform, selectedVersion));
      }
    }
  }, [activeView, platform, release, detailSlug, selectedSlug, selectedVersion]);

  const supportedDetailPlatform = release ? releasePlatform(release.platforms, platform) : null;
  const detailPlatform = supportedDetailPlatform ?? platform;
  const selectedCommand = useMemo(() => (
    selectedSkill && release && supportedDetailPlatform ? exportCommand(selectedSkill.slug, release.version, supportedDetailPlatform) : ""
  ), [release, selectedSkill, supportedDetailPlatform]);
  const latestVisibleRelease = visibleReleases.find((item) => item.version === selectedSkill?.latestVersion) ?? null;
  // Guards keep a stale skill or release off screen for the frame between a
  // selection change and the effects that reload it (skillReady is above).
  const expectedVersion = selectedVersion ?? selectedSkill?.latestVersion ?? null;
  const releaseReady = skillReady && release !== null && release.slug === detailSlug && release.version === expectedVersion;
  const releaseCardState: ReleaseCardState = detailMessage ? "error"
    : detailState === "ready" && releaseReady ? "ready"
      : detailState === "ready" && expectedVersion === null ? "no-default"
        : "loading";
  // Managers may select any release record the server returned to them (from
  // Versions); readers select published releases only.
  const selectableReleases = managedRecord ? releaseRows : visibleReleases;
  // A readable skill defaults only to its latest stable release; with none, it
  // stays unselected until an exact choice. Only a management-only record
  // (no readable release at all) opens on its newest release record.
  const defaultVersion = skillReady ? selectedSkill.latestVersion : managementOnly ? releaseRows[0]?.version ?? null : null;
  const workspaceVersion = selectedVersion ?? defaultVersion;
  const registryStacked = registryLayout === "stack";
  const showRegistryList = !(registryStacked && selectedSlug !== null);
  const showRegistryInspector = registryLayout === "split" || selectedSlug !== null;

  useEffect(() => {
    const pending = pendingRegistryFocus.current;
    if (!pending || activeView !== "browse") return;
    if (pending.kind === "title") {
      if ((skillReady || managementOnly) && inspectorTitleRef.current) {
        inspectorTitleRef.current.focus();
        pendingRegistryFocus.current = null;
      }
      return;
    }
    if (!showRegistryList || listState === "loading") return;
    const rows = registrySurfaceRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-slug]") ?? [];
    Array.from(rows).find((row) => row.dataset.slug === pending.slug)?.focus();
    pendingRegistryFocus.current = null;
  }, [activeView, skillReady, managementOnly, showRegistryList, listState, skills]);

  function selectSkill(slug: string) {
    searchSelectionQuery.current = null;
    setView("browse");
    if (slug !== detailSlug) {
      setSelectedVersion(null);
      setRelease(null);
      setDetailState("loading");
    }
    if (registryLayoutRef.current === "stack") pendingRegistryFocus.current = { kind: "title" };
    setSelectedSlug(slug);
    catalogLocationRef.current = { ...catalogLocationRef.current, bundle: null };
    setSelectedBundleId(null);
    // A Libraries return belongs to the skill it was opened for.
    if (slug !== selectedSlug) updateWorkspaceLocation({ returnTo: null });
    pushAppHistory(browseUrl(slug, query, platform, slug === selectedSlug ? selectedVersion : null));
  }

  function backToSkills() {
    pendingRegistryFocus.current = selectedSlug ? { kind: "row", slug: selectedSlug } : null;
    searchSelectionQuery.current = null;
    setSelectedSlug(null);
    setSelectedVersion(null);
    updateWorkspaceLocation({ tab: "overview", returnTo: null });
    pushAppHistory(browseUrl(null, query, platform));
  }

  /** Selecting a bundle (or nothing) clears the skill so no release is fetched. */
  function selectBundle(bundleId: string | null) {
    searchSelectionQuery.current = null;
    setView("browse");
    setSelectedSlug(null);
    setSelectedVersion(null);
    setSelectedSkill(null);
    setRelease(null);
    catalogLocationRef.current = { ...catalogLocationRef.current, bundle: bundleId };
    setSelectedBundleId(bundleId);
    updateWorkspaceLocation({ tab: "overview", returnTo: null });
    pushAppHistory(browseUrl(null, query, platform));
  }

  /** Scope changes keep the exact skill, version and section; only Can manage drops a bundle selection. */
  function changeScope(nextScope: SkillScope) {
    if (nextScope === workspaceScope) return;
    searchSelectionQuery.current = null;
    setView("browse");
    catalogLocationRef.current = { ...catalogLocationRef.current, bundle: null };
    setSelectedBundleId(null);
    updateWorkspaceLocation({ scope: nextScope });
    pushAppHistory(browseUrl(selectedSlug, query, platform, selectedVersion));
  }

  /** A list link keeps this skill's version and return path; another skill starts at its latest release. */
  function skillLinkUrl(slug: string): string {
    const same = slug === selectedSlug;
    return registryUrl(slug, query, platform, same ? selectedVersion : null, catalogLocationRef.current, { ...workspaceLocationRef.current, returnTo: same ? workspaceLocationRef.current.returnTo : null });
  }

  function scopeHref(nextScope: SkillScope): string {
    return registryUrl(selectedSlug, query, platform, selectedVersion, { ...catalogLocationRef.current, bundle: null }, { ...workspaceLocationRef.current, scope: nextScope });
  }

  function selectTab(nextTab: SkillTab) {
    if (!detailSlug) return;
    // Choosing a section makes an implicit desktop selection explicit.
    setSelectedSlug(detailSlug);
    updateWorkspaceLocation({ tab: nextTab });
    pushAppHistory(browseUrl(detailSlug, query, platform, selectedVersion));
  }

  /** A saved management change reloads the detail in place so its confirmation stays visible. */
  function reloadAfterManagement() {
    softReload.current = { detail: true, managed: true };
    setRefreshKey((value) => value + 1);
  }

  function changeCatalogView(nextView: RegistryView) {
    catalogLocationRef.current = { ...catalogLocationRef.current, view: nextView };
    setCatalogView(nextView);
    pushAppHistory(browseUrl(selectedSlug, query, platform, selectedVersion));
  }

  function selectVersion(version: string) {
    const target = selectableReleases.find((item) => item.version === version);
    if (!detailSlug || !target || version === selectedVersion) return;
    const nextPlatform = releasePlatform(target.platforms, platform) ?? platform;
    // Pinning a version makes an implicit desktop selection explicit.
    setSelectedSlug(detailSlug);
    setSelectedVersion(version);
    setPlatform(nextPlatform);
    setRelease(null);
    setDetailMessage(null);
    setDetailState("loading");
    pushAppHistory(browseUrl(detailSlug, query, nextPlatform, version));
  }

  function returnToLatest() {
    if (!detailSlug) return;
    const nextPlatform = latestVisibleRelease
      ? releasePlatform(latestVisibleRelease.platforms, platform) ?? platform
      : platform;
    setSelectedVersion(null);
    setPlatform(nextPlatform);
    setRelease(null);
    setDetailMessage(null);
    setDetailState("loading");
    setSelectedSlug(detailSlug);
    pushAppHistory(browseUrl(detailSlug, query, nextPlatform));
    if (!selectedSkill && !managementOnly) setRefreshKey((current) => current + 1);
  }

  function openLanding() {
    setView("landing");
    pushAppHistory("/");
  }

  function openLogin() {
    setView("login");
    pushAppHistory("/login");
  }

  function openRegistry() {
    setView("browse");
    pushAppHistory(browseUrl(selectedSlug, query, platform, selectedVersion));
  }

  async function loadMoreSkills() {
    if (!nextCursor || !registryClient.searchSkillPage || loadingMore) return;
    const requestEpoch = listEpoch.current;
    setLoadingMore(true);
    setListMessage(null);
    try {
      const result = await registryClient.searchSkillPage({ query, cursor: nextCursor });
      if (requestEpoch !== listEpoch.current) return;
      setSkills((current) => [...new Map([...current, ...result.skills].map((skill) => [skill.slug, skill])).values()]);
      setNextCursor(result.nextCursor ?? null);
    } catch (error) {
      if (requestEpoch === listEpoch.current) setListMessage(safeErrorMessage(error));
    } finally {
      if (requestEpoch === listEpoch.current) setLoadingMore(false);
    }
  }

  function retryRegistry() {
    setListMessage(null);
    setDetailMessage(null);
    setRefreshKey((value) => value + 1);
  }

  async function handleLogin(input: { email: string; password: string }) {
    setAuthState("loading");
    setAuthMessage(null);
    try {
      const result = await registryClient.login(input);
      if (result.mfaRequired) {
        setMfaPending({ challengeToken: result.challengeToken, email: input.email });
        setAuthState("mfa");
        setAuthMessage("MFA required.");
        return;
      }
      const nextSession = {
        expiresAt: result.expiresAt,
        user: await registryClient.getMe(),
      };
      setSession(nextSession);
      writeStoredSession(nextSession);
      setAuthState("idle");
      openRegistry();
    } catch (error) {
      setAuthState("idle");
      setAuthMessage(safeAuthErrorMessage(error));
    }
  }

  async function handleVerifyMfa(codeOrRecoveryCode: string) {
    if (!mfaPending) {
      return;
    }
    setAuthState("loading");
    setAuthMessage(null);
    try {
      const result = await registryClient.verifyMfa({
        challengeToken: mfaPending.challengeToken,
        codeOrRecoveryCode,
      });
      const nextSession = {
        expiresAt: result.expiresAt,
        user: await registryClient.getMe(),
      };
      setSession(nextSession);
      writeStoredSession(nextSession);
      setMfaPending(null);
      setAuthState("idle");
      openRegistry();
    } catch (error) {
      setAuthState("mfa");
      setAuthMessage(safeAuthErrorMessage(error));
    }
  }

  async function handlePasswordResetRequest(input: { email: string }) {
    setAuthState("loading");
    setAuthMessage(null);
    try {
      await registryClient.requestPasswordReset(input);
      setAuthMessage("If that account exists, a password reset email has been sent.");
    } catch (error) {
      setAuthMessage(safeAuthErrorMessage(error));
    } finally {
      setAuthState("idle");
    }
  }

  async function handleLogout() {
    setMobileMenu(null);
    setAuthMessage(null);
    setSession(null);
    clearStoredSession();
    setMfaPending(null);
    setView("login");
    replaceAppHistory("/login");
    try {
      await registryClient.logout();
    } catch {
      setAuthMessage("Signed out locally.");
    }
  }

  function handleSessionInvalidated(message: string) {
    setMobileMenu(null);
    setSession(null);
    clearStoredSession();
    setMfaPending(null);
    setAuthState("idle");
    setAuthMessage(message);
    setView("login");
    replaceAppHistory("/login");
  }

  function navigateTo(nextView: AppView) {
    setView(nextView);
    if (nextView === "libraries") setLibraryNavigationRevision((value) => value + 1);
    if (nextView === "browse") {
      pushAppHistory(browseUrl(selectedSlug, query, platform, selectedVersion));
    } else {
      pushAppHistory(pathForView(nextView));
    }
    setMobileMenu(null);
  }

  function handleAppLink(event: ReactMouseEvent<HTMLAnchorElement>, nextView: AppView) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigateTo(nextView);
  }

  function updateSearch(nextQuery: string) {
    searchSelectionQuery.current = nextQuery;
    setQuery(nextQuery);
    replaceAppHistory(browseUrl(selectedSlug, nextQuery, platform, selectedVersion));
  }

  function updatePlatform(nextPlatform: string) {
    setPlatform(nextPlatform);
    replaceAppHistory(browseUrl(selectedSlug, query, nextPlatform, selectedVersion));
  }

  if (activeView === "landing") {
    if (siteState?.view !== "landing" || siteState.enabled !== true) {
      return <SiteBootstrap failed={siteState?.view === "landing" && siteState.failed === true} onRetry={() => setSiteRetry((value) => value + 1)} onLogin={openLogin} />;
    }
    return <MarketingLanding onLogin={openLogin} />;
  }

  if (activeView === "reset-password") {
    return (
      <AuthTokenPage
        client={registryClient}
        kind="reset-password"
        onHome={openLanding}
        onLogin={openLogin}
      />
    );
  }

  if (activeView === "register") {
    return (
      <InvitationRegistrationPage
        client={registryClient}
        onHome={openLanding}
        onLogin={openLogin}
      />
    );
  }

  if (activeView === "verify-email" || activeView === "change-email") {
    return (
      <AuthTokenPage
        client={registryClient}
        kind={activeView}
        onHome={openLanding}
        onLogin={openLogin}
      />
    );
  }

  if (activeView === "login") {
    return (
      <LoginPage
        showLandingLink={siteState?.view === view && siteState.enabled === true}
        authMessage={authMessage}
        authState={authState}
        mfaPending={mfaPending}
        onHome={openLanding}
        onLogin={handleLogin}
        onPasswordReset={handlePasswordResetRequest}
        onVerifyMfa={handleVerifyMfa}
      />
    );
  }

  if (activeView === "not-found") {
    return <NotFoundPage onHome={openLanding} onLogin={openLogin} showLandingLink={siteState?.view === view && siteState.enabled === true} />;
  }

  const navItems = [
    { view: "libraries" as const, label: "Libraries", group: "Skills" as const, icon: <Library size={18} aria-hidden="true" />, enabled: Boolean(session && registryClient.libraries) },
    { view: "browse" as const, label: "Skills", group: "Skills" as const, icon: <LayoutGrid size={18} aria-hidden="true" />, enabled: true },
    { view: "submit" as const, label: "Submit", group: "Publish" as const, icon: <Upload size={18} aria-hidden="true" />, enabled: canUseSubmit },
    { view: "review" as const, label: "Review", group: "Publish" as const, icon: <SquareCheckBig size={18} aria-hidden="true" />, enabled: canUseReview },
    { view: "architectures" as const, label: "Architectures", group: "Deploy" as const, icon: <Layers size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "targets" as const, label: "Connected targets", group: "Deploy" as const, icon: <Monitor size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "updates" as const, label: "Updates", group: "Deploy" as const, icon: <RotateCw size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "teams" as const, label: "Teams", group: "People" as const, icon: <UsersRound size={18} aria-hidden="true" />, enabled: canUseTeams },
    { view: "organizations" as const, label: "Organizations", group: "People" as const, icon: <Building2 size={18} aria-hidden="true" />, enabled: canUseOrganizations },
    { view: "admin" as const, label: "Admin", group: "Account" as const, icon: <Shield size={18} aria-hidden="true" />, enabled: canUseAdmin },
    { view: "settings" as const, label: "Settings", group: "Account" as const, icon: <UserCog size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "login" as const, label: "Login", group: "Account" as const, icon: <LogIn size={18} aria-hidden="true" />, enabled: !session },
  ].filter((item) => item.enabled);
  const navGroups = (["Skills", "Publish", "Deploy", "People", "Account"] as const)
    .map((label) => ({ label, items: navItems.filter((item) => item.group === label) }))
    .filter((group) => group.items.length > 0);
  // Mobile keeps Libraries and Skills, plus one shortcut for the reader's
  // main job. Every other allowed destination stays grouped under More.
  const mobileRoleView = canUseReview ? "review" : canUseSubmit ? "submit" : canUseTargets ? "targets" : null;
  const mobilePrimaryItems = navItems.filter((item) => item.view === "libraries" || item.view === "browse" || item.view === mobileRoleView);
  const mobilePrimaryViews = new Set<AppView>(mobilePrimaryItems.map((item) => item.view));
  const mobileOverflowGroups = navGroups
    .map((group) => ({ label: group.label, items: group.items.filter((item) => !mobilePrimaryViews.has(item.view)) }))
    .filter((group) => group.items.length > 0);
  const mobileOverflowActive = mobileOverflowGroups.some((group) => group.items.some((item) => item.view === activeView));

  // Can manage shows only skills the server lets this account manage.
  const manageDenied = workspaceScope === "manage" && wantManaged && managedForSlug?.status === "denied";
  // In Can manage, wait for authority before showing any detail for the selection.
  const awaitingManageAuthority = workspaceScope === "manage" && managedLoading;
  // The management check did not complete: offer a retry, never a denial.
  const manageCheckFailed = wantManaged && managedForSlug?.status === "error";
  const retryManagement = () => setManagedRetry((value) => value + 1);
  const canManageSharing = Boolean(session && skillReady && selectedSkill.access?.canManageSharing);
  const manageTabAvailable = Boolean(managedRecord) || canManageSharing || manageCheckFailed || (tab === "manage" && managedLoading);
  const sectionTabs: SkillTab[] = manageTabAvailable ? ["overview", "versions", "manage"] : ["overview", "versions"];
  const activeTab: SkillTab = sectionTabs.includes(tab) ? tab : "overview";
  const managedVersion = releaseRows.find((item) => item.version === selectedVersion) ?? null;

  // The readable skill itself could not load (a version problem stays in its release card).
  const skillErrorState = (
    <div className="registry-inspector-state" role="status" aria-live="polite">
      <CircleAlert size={20} aria-hidden="true" />
      <div>
        <strong>{detailMessage}</strong>
        <p>{selectedVersion !== null
          ? "The requested exact version was not substituted. Choose a published version or view the latest."
          : "The selected skill could not load. Retry the request or choose a different approved skill."}</p>
        <div className="registry-actions">
          <Button size="sm" type="button" variant="outline" onClick={retryRegistry}>
            <RotateCw size={15} aria-hidden="true" />
            Retry
          </Button>
          {selectedVersion !== null && !selectedSkill && <Button size="sm" type="button" variant="outline" onClick={returnToLatest}>View latest</Button>}
        </div>
      </div>
    </div>
  );

  const managementCheckError = (
    <div className="registry-inspector-state" role="status" aria-live="polite">
      <CircleAlert size={20} aria-hidden="true" />
      <div>
        <strong>Management access couldn't be checked.</strong>
        <p>The management check did not complete, so nothing is shown as allowed or denied. Retry before changing this skill.</p>
        <div className="registry-actions">
          <Button size="sm" type="button" variant="outline" onClick={retryManagement}>
            <RotateCw size={15} aria-hidden="true" />
            Retry management check
          </Button>
        </div>
      </div>
    </div>
  );

  // Overview: the readable skill pane (summary, tags, one card for the exact
  // release, bundle backlinks), or a manager's record with no readable release.
  const renderOverview = (bundles: ReactNode) => {
    if (managementOnly && managedRecord) {
      const status = lifecycleLabel(managedRecord.lifecycleStatus);
      return (
        <div className="registry-inspector-body">
          {managedRecord.summary && <p className="registry-summary">{managedRecord.summary}</p>}
          <p className="registry-callout registry-section-callout" data-tone="amber" role="status">
            <CircleAlert size={16} aria-hidden="true" />
            <span><strong>No readable published release.</strong> This record comes from your management inventory. Readable content, export and install stay unavailable until a release is published and the skill is active.</span>
          </p>
          <dl className="registry-facts registry-section">
            <RegistryFact label="Lifecycle"><span className="registry-chip" data-tone={chipTone(status.tone)}>{status.label}</span></RegistryFact>
            <RegistryFact label="Visibility">{visibilityLabel(managedRecord.visibility)}</RegistryFact>
            {managedRecord.tags.length > 0 && <RegistryFact label="Tags">{managedRecord.tags.join(", ")}</RegistryFact>}
          </dl>
        </div>
      );
    }
    if (!skillReady) return <RegistryInspectorSkeleton withHeader={false} />;
    const readyRelease = releaseCardState === "ready" ? release : null;
    return (
      <>
        <p className="registry-summary">{selectedSkill.summary}</p>
        {selectedSkill.tags.length > 0 && (
          <ul aria-label="Tags" className="registry-tags">
            {selectedSkill.tags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        )}
        <SkillReleaseCard
          historyState={historyState}
          message={detailMessage}
          release={readyRelease}
          releases={visibleReleases}
          selectedVersion={selectedVersion}
          skill={selectedSkill}
          state={releaseCardState}
          onRetry={retryRegistry}
          onReturn={returnToLatest}
          onSelect={selectVersion}
        >
          {readyRelease && (
            <SkillDetail
              command={selectedCommand}
              client={registryClient}
              disclosures={registryDisclosures}
              platform={detailPlatform}
              release={readyRelease}
              selectedSkill={selectedSkill}
              session={session}
              setDisclosure={setRegistryDisclosure}
              setPlatform={updatePlatform}
            />
          )}
        </SkillReleaseCard>
        {managedRecord && managedVersion && !isPublishedRelease(managedVersion) && (
          <p className="registry-callout registry-section-callout" data-tone="amber" role="status">
            <CircleAlert size={16} aria-hidden="true" />
            <span>Version {managedVersion.version} is {lifecycleLabel(managedVersion.lifecycleStatus).label.toLowerCase()}{managedVersion.publishedAt ? "" : " and not published"}. Readable content, export and install are unavailable. Use Manage to change its lifecycle.</span>
          </p>
        )}
        {bundles && <div className="registry-skill-foot">{bundles}</div>}
      </>
    );
  };

  const renderSectionPanel = (bundles: ReactNode) => {
    if (activeTab === "versions" && detailSlug) {
      return (
        <SkillVersionsPanel
          historyState={historyState}
          latestVersion={latestVisibleRelease?.version ?? null}
          onRetry={retryRegistry}
          onSelect={selectVersion}
          releases={selectableReleases}
          selectedVersion={workspaceVersion}
          versionHref={(version) => browseUrl(detailSlug, query, platform, version)}
        />
      );
    }
    if (activeTab === "manage" && detailSlug) {
      const mfaVerified = Boolean(session?.user.mfaVerified);
      return (
        <SkillManagePanel
          client={registryClient}
          historyState={historyState}
          key={detailSlug}
          mfaVerified={mfaVerified}
          onChanged={reloadAfterManagement}
          onRetryRecord={retryManagement}
          record={managedRecord}
          recordState={managedRecord ? "ready" : managedLoading ? "loading" : manageCheckFailed ? "error" : "denied"}
          releases={releaseRows}
          sharing={canManageSharing && mfaVerified && session && selectedSkill ? <SharingPanel client={registryClient} selectedSkill={selectedSkill} session={session} /> : null}
          version={workspaceVersion}
        />
      );
    }
    return renderOverview(bundles);
  };

  // One skill detail for both scopes: skill identity, then Overview / Versions /
  // Manage. The bundle workspace renders it in its inspector and passes backlinks.
  const renderSkillDetail = (bundles: ReactNode) => {
    // Can manage shows no detail until authority is known.
    if (workspaceScope === "manage" && manageCheckFailed) return managementCheckError;
    if (manageDenied) {
      return (
        <div className="registry-inspector-state" role="status" aria-live="polite">
          <LockKeyhole size={20} aria-hidden="true" />
          <div>
            <strong>You can't manage this skill.</strong>
            <p>Can manage lists only skills your account can manage, including archived and unpublished records.</p>
            <div className="registry-actions">
              <a className="skill-inline-link" href={scopeHref("all")} onClick={(event) => handleCallbackLink(event, () => changeScope("all"))}>View in All skills</a>
            </div>
          </div>
        </div>
      );
    }
    const identity = awaitingManageAuthority ? null
      : skillReady ? { slug: selectedSkill.slug, title: selectedSkill.title }
        : managementOnly && managedRecord ? { slug: managedRecord.slug, title: managedRecord.title }
          : null;
    if (!identity) {
      // An unreadable skill may still be manageable: do not call it missing while that check failed.
      if (manageCheckFailed && publicFailure === detailSlug) return managementCheckError;
      if (!awaitingManageAuthority && detailMessage && !(publicFailure === detailSlug && managedLoading)) return skillErrorState;
      if (detailSlug || detailState === "loading" || listState === "loading") return <RegistryInspectorSkeleton withHeader />;
      return <p className="registry-inspector-empty">{workspaceScope === "manage" ? "Select a skill you manage to see its versions and controls." : skills.length > 0 ? "Select a skill to see its exact releases." : "No skill selected."}</p>;
    }
    const lifecycle = managementOnly && managedRecord ? lifecycleLabel(managedRecord.lifecycleStatus) : null;
    return (
      <div className="registry-skill-pane">
        <header className="registry-inspector-head">
          <span className="registry-tile" data-size="32" data-tone={tileTone(identity.slug)} aria-hidden="true" />
          <div className="registry-inspector-title">
            <h2 ref={inspectorTitleRef} tabIndex={-1}>{identity.title}</h2>
            <p className="registry-ref"><code>{identity.slug}</code></p>
            {lifecycle && managedRecord && (
              <p className="registry-inspector-meta">
                <span>{visibilityLabel(managedRecord.visibility)}</span>
                <span className="registry-chip" data-tone={chipTone(lifecycle.tone)}>{lifecycle.label}</span>
              </p>
            )}
          </div>
          {managementOnly && <div className="registry-version-slot"><ManagedReleaseSelect onSelect={selectVersion} releases={releaseRows} version={workspaceVersion} /></div>}
        </header>
        {(returnTo || (session && skillReady)) && (
          <div className="skill-detail-actions">
            {returnTo && (
              <a className="skill-inline-link" href={returnTo} onClick={(event) => handleCallbackLink(event, () => openAppUrl(returnTo))}>
                <ArrowLeft size={15} aria-hidden="true" />
                Return to library
              </a>
            )}
            {session && skillReady && <AddToLibraryButton client={registryClient} slug={selectedSkill.slug} title={selectedSkill.title} />}
          </div>
        )}
        <SkillSectionTabs active={activeTab} baseId={sectionsId} onSelect={selectTab} tabs={sectionTabs} />
        <div aria-labelledby={sectionTabId(sectionsId, activeTab)} className="skill-tab-panel" id={sectionPanelId(sectionsId)} role="tabpanel">
          {renderSectionPanel(bundles)}
        </div>
      </div>
    );
  };

  const scopeControl = canUseManageScope ? (
    <nav aria-label="Skill scope" className="skill-scope">
      {(["all", "manage"] as const).map((item) => (
        <a
          aria-current={workspaceScope === item ? "page" : undefined}
          href={scopeHref(item)}
          key={item}
          onClick={(event) => handleCallbackLink(event, () => changeScope(item))}
        >
          {item === "all" ? "All skills" : "Can manage"}
        </a>
      ))}
    </nav>
  ) : null;

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="sidebar-brand-row">
          <a className="brand" href="/registry" onClick={(event) => {
            handleAppLink(event, "browse");
          }}>
            <BrandIdentity />
          </a>
          <IconButton
            label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronLeft size={15} aria-hidden="true" />}
          </IconButton>
        </div>
        <nav className="side-nav">
          {navGroups.map((group) => (
            <div className="side-nav-group" key={group.label}>
              <span className="side-nav-label">{group.label}</span>
              <div className="side-nav-links">
                {group.items.map((item) => (
                  <a
                    aria-current={activeView === item.view ? "page" : undefined}
                    className={activeView === item.view ? "side-nav-item active" : "side-nav-item"}
                    href={pathForView(item.view)}
                    key={item.view}
                    onClick={(event) => handleAppLink(event, item.view)}
                    aria-label={sidebarCollapsed ? item.label : undefined}
                    title={sidebarCollapsed ? item.label : undefined}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        {session && (
          <SidebarAccount
            collapsed={sidebarCollapsed}
            onLogout={handleLogout}
            onSettings={() => navigateTo("settings")}
            session={session}
          />
        )}
      </aside>

      <div className="app-main">
        <header className="mobile-topbar">
          <a className="mobile-brand" href="/registry" onClick={(event) => {
            handleAppLink(event, "browse");
          }}>
            <BrandIdentity />
          </a>
          {session && (
            <div className="mobile-account">
              <button
                aria-controls="mobile-account-menu"
                aria-expanded={mobileMenu === "account"}
                aria-label="Account menu"
                className="mobile-account-button"
                ref={mobileAccountButtonRef}
                type="button"
                onClick={() => setMobileMenu((open) => open === "account" ? null : "account")}
              >
                <UserRound size={20} aria-hidden="true" />
              </button>
              {mobileMenu === "account" && (
                <div className="mobile-account-menu" id="mobile-account-menu" ref={mobileAccountMenuRef}>
                  <div className="mobile-account-identity">
                    <strong>{session.user.email}</strong>
                    <span>{session.user.roles.map(formatStatusLabel).join(", ") || "User"} · {session.user.mfaVerified ? "MFA verified" : "MFA pending"}</span>
                  </div>
                  <a
                    aria-current={activeView === "settings" ? "page" : undefined}
                    href="/settings"
                    onClick={(event) => handleAppLink(event, "settings")}
                  >
                    <UserCog size={18} aria-hidden="true" />
                    <span>Settings</span>
                  </a>
                  <button type="button" onClick={() => void handleLogout()}>
                    <LogOut size={18} aria-hidden="true" />
                    <span>Sign out</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </header>

        <div className="app-content" id="main-content" tabIndex={-1}>
          {activeView === "libraries" && session ? (
            <LibrariesDashboard client={registryClient} key={libraryNavigationRevision} onNavigate={navigateFromLibraries} user={session.user} />
          ) : activeView === "review" && session ? (
            <ReviewDashboard client={registryClient} onOpenSkill={openAppUrl} session={session} />
          ) : activeView === "submit" && session ? (
            <SubmitDashboard client={registryClient} onOpenSkill={openAppUrl} session={session} />
          ) : activeView === "teams" && session ? (
            <TeamsDashboard client={registryClient} session={session} />
          ) : activeView === "architectures" && session ? (
            <ArchitecturesDashboard client={registryClient} onNavigate={navigateArchitectures} onNavigationGuardChange={registerArchitectureNavigationGuard} session={session} url={appUrl} />
          ) : activeView === "organizations" && session ? (
            <OrganizationsDashboard client={registryClient} session={session} />
          ) : activeView === "targets" && session ? (
            <ArchitectureTargetsDashboard client={registryClient} session={session} />
          ) : activeView === "updates" && session ? (
            <SystemUpdateCenter client={registryClient} session={session} />
          ) : activeView === "admin" && session ? (
            <AdminConsole client={registryClient} session={session} />
          ) : activeView === "settings" && session ? (
            <AccountSettings
              client={registryClient}
              onSessionInvalidated={handleSessionInvalidated}
              session={session}
            />
          ) : bundleCatalog && workspaceScope === "all" ? (
            <BundleWorkspace
              api={bundleCatalog}
              bundleHref={(bundleId) => registryUrl(null, query, platform, null, { view: catalogView, bundle: bundleId })}
              canCreate={canUseSubmit}
              headerControls={scopeControl}
              libraries={session ? registryClient.libraries : undefined}
              listTeams={session ? () => registryClient.listTeams() : undefined}
              onClearQuery={() => updateSearch("")}
              onQueryChange={updateSearch}
              onClearSelection={() => selectBundle(null)}
              onSelectBundle={selectBundle}
              onSelectSkill={selectSkill}
              onUnavailable={() => setCatalogAvailable(false)}
              onViewChange={changeCatalogView}
              query={query}
              renderSkillDetail={renderSkillDetail}
              selection={selectedSlug ? { kind: "skill", slug: selectedSlug } : selectedBundleId ? { kind: "bundle", id: selectedBundleId } : null}
              signedIn={Boolean(session)}
              skillHref={skillLinkUrl}
              view={catalogView}
            />
          ) : (
            <main className="registry-workspace" aria-labelledby="registry-heading">
              <header className="registry-page-head">
                <h1 id="registry-heading">Skills</h1>
                {scopeControl}
              </header>
              <div
                className="registry-surface"
                data-layout={registryLayout ?? undefined}
                data-view={showRegistryList ? "list" : "detail"}
                ref={measureRegistry}
              >
                {showRegistryList && (
                  <div className="registry-toolbar">
                    <label className="registry-search" htmlFor="skill-search">
                      <Search size={16} aria-hidden="true" />
                      <input
                        id="skill-search"
                        aria-label={workspaceScope === "manage" ? "Search skills you can manage" : "Search skills"}
                        name="skill-search"
                        value={query}
                        onChange={(event) => updateSearch(event.target.value)}
                        placeholder={workspaceScope === "manage" ? "Search skills you can manage…" : "Search skills…"}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <kbd aria-hidden="true">/</kbd>
                    </label>
                  </div>
                )}
                <div className="registry-body">
                  {workspaceScope === "manage" && (
                    <ManagedSkillsInventory
                      client={registryClient}
                      hidden={!showRegistryList}
                      onOpenSkill={selectSkill}
                      query={query}
                      reloadKey={refreshKey}
                      selectedSlug={selectedSlug}
                      skillHref={skillLinkUrl}
                      stacked={registryStacked}
                    />
                  )}
                  {workspaceScope === "all" && showRegistryList && (
                    <section className="registry-results-panel registry-list" aria-label="Skill search results">
                      <div className="registry-list-label">
                        <h2>Skills</h2>
                        <span aria-live="polite">{listState === "ready" ? (nextCursor ? `${skills.length} loaded` : String(skills.length)) : ""}</span>
                      </div>
                      {listState === "loading" && <RegistryLoadingRows />}
                      {listState === "error" && (
                        <div className="registry-list-state" role="status" aria-live="polite">
                          <strong>{listMessage ?? "Skills are not available."}</strong>
                          <p>The list could not load. Retry the request before selecting a skill.</p>
                          <Button size="sm" type="button" variant="outline" onClick={retryRegistry}>
                            <RotateCw size={15} aria-hidden="true" />
                            Retry
                          </Button>
                        </div>
                      )}
                      {listState !== "loading" && listState !== "error" && skills.length > 0 && (
                        <div className="registry-rows">
                          {skills.map((skill) => (
                            <a
                              aria-current={!registryStacked && skill.slug === detailSlug ? "true" : undefined}
                              className="registry-row"
                              data-slug={skill.slug}
                              href={skillLinkUrl(skill.slug)}
                              key={skill.slug}
                              onClick={(event) => handleCallbackLink(event, () => selectSkill(skill.slug))}
                            >
                              <span className="registry-tile" data-tone={tileTone(skill.slug)} aria-hidden="true" />
                              <span className="registry-row-text">
                                <span className="registry-row-title">{skill.title}</span>
                                <span className="registry-row-meta">
                                  <code>{skill.slug}</code>
                                  <span>{formatStatusLabel(skill.visibility)}</span>
                                  {skill.platforms.length > 0 && <span>{skill.platforms.slice(0, 2).map((item) => item.name).join(", ")}</span>}
                                </span>
                              </span>
                              {skill.latestVersion && <span className="registry-version-chip" title={skill.latestVersion}>{releaseVersionLabel(skill.latestVersion)}</span>}
                            </a>
                          ))}
                        </div>
                      )}
                      {listState === "ready" && nextCursor && (
                        <div className="registry-list-foot">
                          <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMoreSkills()}>{loadingMore ? "Loading more skills…" : "Load more skills"}</Button>
                        </div>
                      )}
                      {listState === "ready" && listMessage && <p className="registry-alert" role="alert">{listMessage}</p>}
                      {listState === "ready" && skills.length === 0 && (
                        <div className="registry-list-state">
                          <strong>No skills found.</strong>
                          <p>{query.trim() ? `No approved skills match "${query.trim()}".` : "Approved skills will appear here after publication."}</p>
                          {query.trim() && (
                            <Button size="sm" type="button" variant="outline" onClick={() => updateSearch("")}>
                              Clear search
                            </Button>
                          )}
                        </div>
                      )}
                    </section>
                  )}
                  {showRegistryInspector && (
                    <section className="registry-detail-panel registry-inspector" aria-label="Selected skill detail">
                      {registryStacked && (
                        <Button className="registry-back" type="button" variant="ghost" onClick={backToSkills}>
                          <ArrowLeft size={16} aria-hidden="true" />
                          Back to skills
                        </Button>
                      )}
                      {renderSkillDetail(null)}
                    </section>
                  )}
                </div>
              </div>
            </main>
          )}
        </div>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          {mobilePrimaryItems.map((item) => (
            <a
              aria-label={item.label}
              aria-current={activeView === item.view ? "page" : undefined}
              className={activeView === item.view ? "mobile-nav-item active" : "mobile-nav-item"}
              href={pathForView(item.view)}
              key={item.view}
              onClick={(event) => handleAppLink(event, item.view)}
            >
              {item.icon}
              <span>{item.view === "architectures" ? "Build" : item.view === "targets" ? "Targets" : item.label}</span>
            </a>
          ))}
          {mobileOverflowGroups.length > 0 && (
            <>
              <button
                aria-controls="mobile-more-navigation"
                aria-expanded={mobileMenu === "more"}
                className={mobileOverflowActive ? "mobile-nav-item active" : "mobile-nav-item"}
                ref={mobileMoreButtonRef}
                type="button"
                onClick={() => setMobileMenu((open) => open === "more" ? null : "more")}
              >
                <Ellipsis size={18} aria-hidden="true" />
                <span>More</span>
              </button>
              {mobileMenu === "more" && (
                <div className="mobile-more-menu" id="mobile-more-navigation" ref={mobileMoreMenuRef}>
                  {mobileOverflowGroups.map((group) => (
                    <div className="mobile-more-group" role="group" aria-labelledby={`mobile-more-${group.label.toLowerCase()}`} key={group.label}>
                      <span className="mobile-more-label" id={`mobile-more-${group.label.toLowerCase()}`}>{group.label}</span>
                      {group.items.map((item) => (
                        <a
                          aria-current={activeView === item.view ? "page" : undefined}
                          href={pathForView(item.view)}
                          key={item.view}
                          onClick={(event) => handleAppLink(event, item.view)}
                        >
                          {item.icon}
                          <span>{item.label}</span>
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </nav>
      </div>
    </div>
  );
}

function SiteBootstrap({ failed, onRetry, onLogin }: { failed: boolean; onRetry: () => void; onLogin: () => void }) {
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShowDetails(true), 600);
    return () => window.clearTimeout(timer);
  }, []);
  return <main className="site-bootstrap" id="main-content">
    <BrandIdentity />
    {failed ? <>
      <div role="alert"><h1>We couldn’t load this page.</h1><p>Try again, or continue to sign in.</p></div>
      <Button type="button" onClick={onRetry}>Try again</Button>
    </> : <p role="status">{showDetails ? "Loading…" : ""}</p>}
    {(failed || showDetails) && <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>Sign in</a>}
  </main>;
}

function newPasswordByteError(password: string): string | null {
  return new TextEncoder().encode(password).byteLength > 72
    ? "Password must be at most 72 UTF-8 bytes. Non-ASCII characters can use more than one byte."
    : null;
}

function LoginPage({
  showLandingLink,
  authMessage,
  authState,
  mfaPending,
  onHome,
  onLogin,
  onPasswordReset,
  onVerifyMfa,
}: {
  showLandingLink: boolean;
  authMessage: string | null;
  authState: AuthState;
  mfaPending: MfaPending | null;
  onHome: () => void;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onPasswordReset: (input: { email: string }) => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
}) {
  const [resetMode, setResetMode] = useState(false);
  const step = mfaPending ? "mfa" : resetMode ? "reset" : "login";
  return (
    <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main className="login-page" id="main-content">
      <nav className="login-nav" aria-label="Login navigation">
        {showLandingLink ? <a className="landing-brand" href="/" onClick={(event) => handleCallbackLink(event, onHome)}>
          <BrandIdentity horizontal />
        </a> : <span className="landing-brand"><BrandIdentity horizontal /></span>}
        {showLandingLink && <Button asChild className="login-back shadcn-action-button" size="sm" variant="outline">
          <a href="/" onClick={(event) => handleCallbackLink(event, onHome)}>Public site</a>
        </Button>}
      </nav>
      <section className="login-panel" aria-labelledby="login-heading">
        <p className="landing-status">Public beta. Hosted signups are closed.</p>
        <h1 id="login-heading">{step === "mfa" ? "Verify sign-in" : step === "reset" ? "Reset password" : "Login"}</h1>
        {step === "login" && <>
          <p>Use an approved owner or team account to sign in. Need an account? Ask the instance owner for an invitation and follow the email link.</p>
          <p><a href="/registry">Browse public skills</a> · <a href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md">Self-host MySkills</a></p>
        </>}
        <AuthWidget
          authMessage={authMessage}
          authState={authState}
          mfaPending={mfaPending}
          onLogin={onLogin}
          onLogout={async () => undefined}
          onPasswordReset={onPasswordReset}
          onResetModeChange={setResetMode}
          onVerifyMfa={onVerifyMfa}
          resetMode={resetMode}
          session={null}
        />
      </section>
    </main>
    </>
  );
}

function InvitationRegistrationPage({
  client,
  onHome,
  onLogin,
}: {
  client: RegistryClient;
  onHome: () => void;
  onLogin: () => void;
}) {
  const token = useMemo(() => authActionTokenFromLocation(), []);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<LoadState>(token ? "idle" : "error");
  const [message, setMessage] = useState<string | null>(token ? null : "This invitation link is missing its token.");
  const [linkInvalid, setLinkInvalid] = useState(!token);

  useEffect(() => {
    clearAuthActionTokenFromLocation();
  }, []);

  async function register() {
    setMessage(null);
    if (!token) {
      setLinkInvalid(true);
      setState("error");
      setMessage("This invitation link is missing its token.");
      return;
    }
    if (password.length < 12) {
      setState("error");
      setMessage("Use a password with at least 12 characters.");
      return;
    }
    const passwordError = newPasswordByteError(password);
    if (passwordError) {
      setState("error");
      setMessage(passwordError);
      return;
    }
    if (password !== confirmPassword) {
      setState("error");
      setMessage("Passwords do not match.");
      return;
    }
    setState("loading");
    try {
      await client.registerWithInvitation({
        email,
        password,
        ...(name.trim() ? { name: name.trim() } : {}),
        inviteToken: token,
      });
      setPassword("");
      setConfirmPassword("");
      setState("ready");
      setMessage("Registration complete. You can now log in.");
    } catch (error) {
      setLinkInvalid(apiErrorCode(error) === "INVALID_INVITATION_TOKEN");
      setState("error");
      setMessage(safeAccountErrorMessage(error));
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main className="login-page" id="main-content">
        <nav className="login-nav" aria-label="Registration navigation">
          <a className="landing-brand" href="/" onClick={(event) => handleCallbackLink(event, onHome)}>
            <BrandIdentity horizontal />
          </a>
          <Button asChild className="login-back shadcn-action-button" size="sm" variant="outline">
            <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>Login</a>
          </Button>
        </nav>
        <section className="login-panel" aria-labelledby="invitation-registration-heading">
          <p className="landing-status">Public beta. Invitation required.</p>
          <h1 id="invitation-registration-heading">Complete registration</h1>
          <p>Create the account for the email address that received this invitation.</p>

          {!linkInvalid && state !== "ready" && (
            <form className="auth-widget auth-form" onSubmit={(event) => {
              event.preventDefault();
              void register();
            }}>
              <label className="auth-field">
                <span>Email</span>
                <Input
                  className="auth-input"
                  autoComplete="email"
                  disabled={state === "loading"}
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  spellCheck={false}
                  type="email"
                  value={email}
                />
              </label>
              <label className="auth-field">
                <span>Name <small>(optional)</small></span>
                <Input
                  className="auth-input"
                  autoComplete="name"
                  disabled={state === "loading"}
                  name="name"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
              <label className="auth-field">
                <span>Password</span>
                <Input
                  className="auth-input"
                  autoComplete="new-password"
                  disabled={state === "loading"}
                  minLength={12}
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>
              <label className="auth-field">
                <span>Confirm password</span>
                <Input
                  className="auth-input"
                  autoComplete="new-password"
                  disabled={state === "loading"}
                  minLength={12}
                  name="confirm-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  type="password"
                  value={confirmPassword}
                />
              </label>
              <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="submit">
                <UserRound size={16} aria-hidden="true" />
                {state === "loading" ? "Creating account…" : "Create account"}
              </Button>
            </form>
          )}

          {message && (
            <div className={state === "ready" ? "success-message compact-message" : "safe-message compact-message"} role="status" aria-live="polite">
              {message}
            </div>
          )}
          {(state === "ready" || linkInvalid) && (
            <Button asChild className="save-button shadcn-action-button" size="sm">
              <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>
                <LogIn size={16} aria-hidden="true" />
                {state === "ready" ? "Continue to login" : "Return to login"}
              </a>
            </Button>
          )}
        </section>
      </main>
    </>
  );
}

function NotFoundPage({ onHome, onLogin, showLandingLink }: { onHome: () => void; onLogin: () => void; showLandingLink: boolean }) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main className="login-page not-found-page" id="main-content">
        <section className="login-panel" aria-labelledby="not-found-heading">
          <p className="landing-status">404</p>
          <h1 id="not-found-heading">Page not found</h1>
          <p>The address does not match a MySkills page. Choose a destination below.</p>
          <Button asChild className="shadcn-action-button" size="sm">
            {showLandingLink ? <a href="/" onClick={(event) => handleCallbackLink(event, onHome)}>Return home</a> : <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>Go to sign in</a>}
          </Button>
        </section>
      </main>
    </>
  );
}

function SubmitDashboard({ client, onOpenSkill }: { client: RegistryClient; onOpenSkill: (url: string) => void; session: WebSession }) {
  const [file, setFile] = useState<File | null>(null);
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [submissionsState, setSubmissionsState] = useState<LoadState>("loading");
  // Each message renders in the part of the page that produced it.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<{ submissionId: string; text: string; alert: boolean } | null>(null);
  const [result, setResult] = useState<SubmitSkillResult | null>(null);
  const [submissions, setSubmissions] = useState<UserSubmissionSummary[]>([]);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const baseId = useId();
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const feedbackTriggers = useRef(new Map<string, HTMLButtonElement>());
  const focusTarget = useRef<{ kind: "result" } | { kind: "trigger"; id: string } | null>(null);

  async function refreshSubmissions() {
    setSubmissionsState("loading");
    setListMessage(null);
    try {
      setSubmissions(await client.listUserSubmissions());
      setSubmissionsState("ready");
    } catch (error) {
      setListMessage(safeSubmitErrorMessage(error));
      setSubmissionsState("error");
    }
  }

  useEffect(() => {
    void refreshSubmissions();
  }, [client]);

  // Focus follows the result, or returns to a row's feedback trigger (or the
  // list heading when the row has gone) once any dialog has closed.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target || confirmation) return;
    const element = target.kind === "result" ? resultHeadingRef.current : feedbackTriggers.current.get(target.id) ?? listHeadingRef.current;
    if (!element?.isConnected) return;
    focusTarget.current = null;
    element.focus();
  });

  async function submitPackage() {
    setMessage(null);
    setResult(null);
    if (!file) {
      setMessage({ text: "Choose a package archive before submitting.", error: true });
      return;
    }
    if (!isZipArchive(file)) {
      setMessage({ text: "Choose a .zip package archive.", error: true });
      return;
    }
    if (file.size === 0) {
      setMessage({ text: "Package archive is empty.", error: true });
      return;
    }
    if (file.size > MAX_WEB_ARCHIVE_BYTES) {
      setMessage({ text: "Package archive exceeds 10 MB.", error: true });
      return;
    }
    setState("loading");
    try {
      const submitted = await client.submitArchive({
        filename: file.name,
        contentBase64: await fileToBase64(file),
      });
      setResult(submitted);
      setState("ready");
      focusTarget.current = { kind: "result" };
      await refreshSubmissions();
    } catch (error) {
      setMessage({ text: safeSubmitErrorMessage(error), error: true });
      setState("error");
    }
  }

  async function exportSubmission(submission: UserSubmissionSummary) {
    setRowMessage(null);
    setExportingId(submission.id);
    try {
      const bundle = await client.exportUserSubmission(submission.id);
      downloadJsonFile(`${submission.slug}-${submission.version}.myskills.json`, bundle);
    } catch (error) {
      setRowMessage({ submissionId: submission.id, text: safeSubmitErrorMessage(error), alert: true });
    } finally {
      setExportingId(null);
    }
  }

  async function withdrawSubmission(submission: UserSubmissionSummary) {
    setConfirmation({
      key: "withdraw-submission",
      title: "Withdraw this submission?",
      description: "The version will leave the active review queue. Record why the author is withdrawing it.",
      confirmLabel: "Withdraw submission",
      details: [{ label: "Release", value: `${submission.slug}@${submission.version}` }],
      destructive: true,
      requireReason: true,
      onConfirm: (confirmedReason) => commitSubmissionWithdrawal(submission, confirmedReason),
    });
  }

  async function commitSubmissionWithdrawal(submission: UserSubmissionSummary, confirmedReason: string) {
    setRowMessage(null);
    setActioningId(submission.id);
    try {
      await client.performSubmissionAction(submission.id, "withdraw", confirmedReason);
      focusTarget.current = { kind: "trigger", id: submission.id };
      await refreshSubmissions();
    } catch (error) {
      const safeMessage = safeSubmitErrorMessage(error);
      // The dialog owns the alert; the row keeps a quiet copy after it closes.
      setRowMessage({ submissionId: submission.id, text: safeMessage, alert: false });
      throw new Error(safeMessage);
    } finally {
      setActioningId(null);
    }
  }

  function closeFeedback(submissionId: string) {
    setFeedbackId(null);
    focusTarget.current = { kind: "trigger", id: submissionId };
  }

  function chooseCorrection() {
    setFile(null);
    setResult(null);
    setMessage({ text: "Choose the corrected archive with a new semantic version. Previous submissions remain immutable.", error: false });
    const input = document.getElementById("package-archive") as HTMLInputElement | null;
    if (input) { input.value = ""; input.focus(); input.scrollIntoView?.({ block: "center" }); }
  }

  const resultReview = result ? reviewStatusLabel(result.submission.reviewStatus) : null;
  const resultSecurity = result ? securityStatusLabel(result.submission.securityStatus) : null;
  const resultFindings = result ? findingsLabel(result.scan.findingCount) : null;

  return (
    <main className="registry-workspace author-review submit-dashboard" aria-label="Skill package submission">
      <header className="registry-page-head">
        <h1>Submit package</h1>
      </header>

      <div className="registry-surface">
        <section aria-labelledby={`${baseId}-upload`} className="submit-upload">
          <h2 id={`${baseId}-upload`}>Package archive</h2>
          <form className="submit-upload-form" onSubmit={(event) => {
            event.preventDefault();
            void submitPackage();
          }}>
            <label className="file-picker submit-picker" htmlFor="package-archive">
              <PackageOpen size={20} aria-hidden="true" />
              <span>
                <strong>{file?.name ?? "Choose .zip package"}</strong>
                <small>{file ? formatBytes(file.size) : "Archive upload"}</small>
              </span>
              <input
                accept=".zip,application/zip,application/x-zip-compressed"
                aria-describedby={`${baseId}-requirements`}
                id="package-archive"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                type="file"
              />
            </label>
            <Button disabled={state === "loading" || !file} size="sm" type="submit">
              <Upload size={16} aria-hidden="true" />
              Submit for review
            </Button>
          </form>
          <p className="registry-muted" id={`${baseId}-requirements`}>.zip archive, 10 MB maximum, semantic version metadata, and no private paths or install hooks without review notes.</p>
          {state === "loading" && <p className="registry-muted" role="status">Uploading archive…</p>}
          {message && <p className="author-status" data-tone={message.error ? "danger" : undefined} role={message.error ? "alert" : "status"}>{message.text}</p>}
          {result && resultReview && resultSecurity && resultFindings && (
            <div className="submit-result-block">
              <h3 ref={resultHeadingRef} tabIndex={-1}>Submitted {result.submission.slug}@{result.submission.version}</h3>
              <p className="review-outcome-link">
                <a
                  href={exactSkillUrl(result.submission.slug, result.submission.version, false)}
                  onClick={(event) => handleCallbackLink(event, () => onOpenSkill(exactSkillUrl(result.submission.slug, result.submission.version, false)))}
                >
                  Open {result.submission.slug}@{result.submission.version} in Skills
                </a>
              </p>
              <p className="author-chips">
                <span className="registry-chip" data-tone={chipTone(resultReview.tone)}>{resultReview.label}</span>
                <span className="registry-chip" data-tone={chipTone(resultSecurity.tone)}>{resultSecurity.label}</span>
                <span className="registry-chip" data-tone={chipTone(resultFindings.tone)}>{resultFindings.label}</span>
              </p>
              <p className="author-status" data-tone={result.scan.findings.length > 0 ? "amber" : "teal"}>
                {result.scan.findings.length > 0 ? "Review the scan warnings before a maintainer approves this package." : "No scan findings. The package is ready for maintainer review."}
              </p>
              <dl className="registry-facts" data-labels="wide">
                <div>
                  <dt>Submission ID</dt>
                  <dd className="registry-mono">{result.submission.id}</dd>
                </div>
              </dl>
              {result.scan.findings.length > 0 && (
                <ul aria-label="Scan findings" className="submit-findings">
                  {result.scan.findings.map((finding, index) => {
                    const severity = severityLabel(finding.severity);
                    return (
                      <li key={`${finding.category}-${finding.path ?? "package"}-${index}`}>
                        <span className="registry-chip" data-tone={chipTone(severity.tone)}>{severity.label}</span>
                        <strong>{finding.category}</strong>
                        <code>{finding.path ?? "package"}</code>
                        <p>{finding.message}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </section>

        <section aria-busy={submissionsState === "loading"} aria-labelledby={`${baseId}-submitted`} className="registry-list submit-list">
          <div className="registry-list-label">
            <h2 id={`${baseId}-submitted`} ref={listHeadingRef} tabIndex={-1}>{submissions.some((submission) => submission.owner?.type === "team") ? "Personal and team submissions" : "My submitted skills"}</h2>
            <span aria-live="polite">{submissionsState === "ready" ? String(submissions.length) : ""}</span>
          </div>
          {submissionsState === "loading" && submissions.length === 0 && (
            <div className="registry-skeleton" role="status" aria-live="polite">
              <span className="sr-only">Loading submissions…</span>
              {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
            </div>
          )}
          {submissionsState === "error" && (
            <div className="registry-list-state">
              <p role="alert"><strong>{listMessage ?? "Your submissions could not load."}</strong></p>
              <Button size="sm" type="button" variant="outline" onClick={() => void refreshSubmissions()}>
                <RotateCw size={15} aria-hidden="true" />
                Retry
              </Button>
            </div>
          )}
          {submissions.length > 0 && (
            <ul className="registry-rows submit-rows">
              {submissions.map((submission) => {
                const titleId = `${baseId}-${submission.id}-title`;
                const feedbackPanelId = `${baseId}-${submission.id}-feedback`;
                const feedbackOpen = feedbackId === submission.id;
                const review = reviewStatusLabel(submission.reviewStatus);
                const security = securityStatusLabel(submission.securityStatus);
                const findings = findingsLabel(submission.findingCount);
                return (
                  <li className="submit-item" key={submission.id}>
                    <div className="registry-row submission-row">
                      <span className="registry-tile" data-tone={tileTone(submission.slug)} aria-hidden="true" />
                      <span className="registry-row-text">
                        <span className="registry-row-title" id={titleId}>{submission.title}</span>
                        <span className="registry-row-meta">
                          <a
                            className="submission-skill-link"
                            href={exactSkillUrl(submission.slug, submission.version, isPublishedRelease(submission))}
                            onClick={(event) => handleCallbackLink(event, () => onOpenSkill(exactSkillUrl(submission.slug, submission.version, isPublishedRelease(submission))))}
                          >
                            <code>{submission.slug}@{submission.version}</code>
                          </a>
                          <span>{formatBytes(submission.artifact.byteSize)}</span>
                          <span>Submitted {formatDate(submission.createdAt)}</span>
                        </span>
                        <span className="author-chips">
                          {submission.owner?.type === "team" && <span className="registry-chip" data-tone="navy">Team-owned</span>}
                          <span className="registry-chip" data-tone={chipTone(review.tone)}>{review.label}</span>
                          <span className="registry-chip" data-tone={chipTone(security.tone)}>{security.label}</span>
                          <span className="registry-chip" data-tone={chipTone(findings.tone)}>{findings.label}</span>
                        </span>
                      </span>
                      <span className="submit-row-actions">
                        {client.getUserSubmissionDetail && (
                          <Button
                            aria-controls={feedbackPanelId}
                            aria-describedby={titleId}
                            aria-expanded={feedbackOpen}
                            ref={(element: HTMLButtonElement | null) => {
                              if (element) feedbackTriggers.current.set(submission.id, element);
                              else feedbackTriggers.current.delete(submission.id);
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={() => setFeedbackId((current) => current === submission.id ? null : submission.id)}
                          >
                            View feedback for {submission.version}
                          </Button>
                        )}
                        <Button
                          aria-describedby={titleId}
                          disabled={exportingId === submission.id}
                          size="sm"
                          type="button"
                          variant="outline"
                          onClick={() => void exportSubmission(submission)}
                        >
                          <Download size={15} aria-hidden="true" />
                          Export
                        </Button>
                        {(submission.allowedActions ?? []).includes("withdraw") && (
                          <Button
                            aria-describedby={titleId}
                            className="author-danger"
                            disabled={actioningId === submission.id}
                            size="sm"
                            type="button"
                            variant="outline"
                            onClick={() => void withdrawSubmission(submission)}
                          >
                            <X size={15} aria-hidden="true" />
                            Withdraw
                          </Button>
                        )}
                      </span>
                    </div>
                    {rowMessage?.submissionId === submission.id && (
                      <p className="author-status submit-row-message" data-tone="danger" role={rowMessage.alert ? "alert" : "status"}>{rowMessage.text}</p>
                    )}
                    {feedbackOpen && (
                      <div className="submit-feedback" id={feedbackPanelId}>
                        <SubmissionEvidencePanel client={client} submissionId={submission.id} mode="author" focusOnOpen onClose={() => closeFeedback(submission.id)} onCorrect={chooseCorrection} />
                        <PackageFileViewer resourceKey={`author:${submission.id}`} loadBundle={() => client.exportUserSubmission(submission.id)} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {submissionsState === "ready" && submissions.length === 0 && (
            <div className="registry-list-state">
              <strong>No submitted skills.</strong>
              <p>Validated submissions will appear here for export.</p>
            </div>
          )}
        </section>
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function appendUniqueById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  return [...current, ...incoming.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  })];
}

function ReviewDashboard({ client, onOpenSkill, session }: { client: RegistryClient; onOpenSkill: (url: string) => void; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  // Queue load failures stay in the queue; decision and artifact messages stay
  // beside the submission they belong to.
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ submissionId: string; text: string; skill: { label: string; href: string } } | null>(null);
  const [decisionError, setDecisionError] = useState<{ submissionId: string; text: string } | null>(null);
  const [artifactStatus, setArtifactStatus] = useState<{ submissionId: string; text: string; error: boolean } | null>(null);
  const [submissions, setSubmissions] = useState<ReviewSubmissionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listEpoch = useRef(0);
  const morePending = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [reviewArtifactHashes, setReviewArtifactHashes] = useState<Record<string, string>>({});
  const [artifactLoadingId, setArtifactLoadingId] = useState<string | null>(null);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [inspectAttempts, setInspectAttempts] = useState<Record<string, number>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const inspecting = useRef<string | null>(null);
  const { layout, ref: surfaceRef } = useSplitLayout();
  const queueRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const decisionNoticeRef = useRef<HTMLParagraphElement>(null);
  const queueNoticeRef = useRef<HTMLParagraphElement>(null);
  const focusTarget = useRef<ReviewFocus | null>(null);
  const baseId = useId();
  const stacked = layout === "stack";
  const selected = submissions.find((submission) => submission.id === selectedId) ?? queueOrder(submissions)[0] ?? null;
  const allowedReviewActions = selected?.allowedActions ?? fallbackReviewActions(selected);
  const selectedArtifactHash = selected ? reviewArtifactHashes[selected.id] ?? selected.approvedArtifactSha256 ?? null : null;
  const inspectorVisible = Boolean(selected || state === "loading") && (!stacked || detailOpen);
  const showQueue = !stacked || !inspectorVisible;
  const queueNotice = notice && !submissions.some((submission) => submission.id === notice.submissionId) ? notice : null;
  const actionHint = selected
    ? selected.securityStatus !== "passed"
      ? "Resolve or document scan findings before approving or publishing."
      : selected.reviewStatus === "approved"
        ? "This submission is approved. Publish it when release notes and metadata are ready."
        : selectedArtifactHash
          ? "Approve after checking metadata, package integrity, and scan output."
          : "Inspect or download the review artifact before approving so the approval records its exact hash."
    : "";

  async function readReviewPage(cursor?: string) {
    return client.listReviewSubmissionPage ? client.listReviewSubmissionPage({ limit: 100, cursor })
      : { submissions: await client.listReviewSubmissions(), nextCursor: null };
  }

  async function refreshReview() {
    const epoch = ++listEpoch.current;
    morePending.current = false;
    setLoadingMore(false);
    setNextCursor(null);
    setSubmissions([]);
    setState("loading");
    setMessage(null);
    setNotice(null);
    setDecisionError(null);
    setArtifactStatus(null);
    try {
      const page = await readReviewPage();
      if (epoch !== listEpoch.current) return;
      const nextSubmissions = page.submissions;
      setNextCursor(page.nextCursor);
      setSubmissions(nextSubmissions);
      setSelectedId((current) => (
        current && nextSubmissions.some((submission) => submission.id === current)
          ? current
          : queueOrder(nextSubmissions)[0]?.id ?? null
      ));
      setState("ready");
    } catch (error) {
      if (epoch !== listEpoch.current) return;
      setMessage(safeReviewErrorMessage(error));
      setState("error");
    }
  }

  useEffect(() => {
    void refreshReview();
    return () => { listEpoch.current += 1; };
  }, [client, session.user.id, session.expiresAt]);

  async function loadMoreReview() {
    if (!nextCursor || morePending.current || !client.listReviewSubmissionPage) return;
    const epoch = listEpoch.current;
    morePending.current = true;
    setLoadingMore(true);
    setMessage(null);
    try {
      const page = await readReviewPage(nextCursor);
      if (epoch !== listEpoch.current) return;
      setSubmissions((current) => appendUniqueById(current, page.submissions));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (epoch === listEpoch.current) setMessage(safeReviewErrorMessage(error));
    } finally {
      if (epoch === listEpoch.current) { morePending.current = false; setLoadingMore(false); }
    }
  }

  // The approval hash is the one shown in the confirmation, captured when it opened.
  async function commitReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName, confirmedReason: string, artifactSha256: string | null) {
    setDecisionError(null);
    setNotice(null);
    const epoch = listEpoch.current;
    try {
      if (action === "approve" && !artifactSha256) {
        setDecisionError({ submissionId: submission.id, text: "Download the review artifact before approving this submission." });
        return;
      }
      const result = await client.performReviewAction({
        submissionId: submission.id,
        action,
        reason: confirmedReason || undefined,
        ...(action === "approve" && artifactSha256 ? { artifactSha256 } : {}),
      });
      if (epoch !== listEpoch.current) return;
      focusTarget.current = { kind: "decision", id: submission.id };
      await refreshReview();
      if (!result.publishedAt) setSelectedId(result.id);
      const actionLabel = action === "request-changes"
        ? "was returned for changes"
        : action === "reject"
          ? "was rejected"
          : action === "publish"
            ? "was published"
            : "was approved and can now be published";
      setNotice({
        submissionId: submission.id,
        text: `${submission.title} ${actionLabel}.`,
        skill: { label: `Open ${result.slug}@${result.version} in Skills`, href: exactSkillUrl(result.slug, result.version, Boolean(result.publishedAt)) },
      });
    } catch (error) {
      const safeMessage = safeReviewErrorMessage(error);
      // The dialog owns the alert; the decision band keeps a quiet copy.
      setDecisionError({ submissionId: submission.id, text: safeMessage });
      throw new Error(safeMessage);
    }
  }

  function requestReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName) {
    const artifactSha256 = reviewArtifactHashes[submission.id] ?? submission.approvedArtifactSha256 ?? null;
    if (action === "approve" && !artifactSha256) {
      setDecisionError({ submissionId: submission.id, text: "Download the review artifact before approving this submission." });
      return;
    }
    const labels: Record<ReviewActionName, { title: string; description: string; confirmLabel: string }> = {
      approve: {
        title: "Approve this submission?",
        description: "Approval records the downloaded artifact hash and moves this version toward publication.",
        confirmLabel: "Approve submission",
      },
      "request-changes": {
        title: "Request changes?",
        description: "The author will need the recorded reason to understand what must change before another review.",
        confirmLabel: "Request changes",
      },
      reject: {
        title: "Reject this submission?",
        description: "Rejection ends the current review path. Record why this version should not proceed.",
        confirmLabel: "Reject submission",
      },
      publish: {
        title: "Publish this release?",
        description: "Publication makes the approved release available to install and export through Skills.",
        confirmLabel: "Publish release",
      },
    };
    const label = labels[action];
    const release = { label: "Release", value: `${submission.slug}@${submission.version}` };
    const details = action === "approve" && artifactSha256 ? [release, { label: "Artifact SHA-256", value: artifactSha256 }]
      : action === "publish" && submission.approvedArtifactSha256 ? [release, { label: "Approved SHA-256", value: submission.approvedArtifactSha256 }]
        : [release];
    setConfirmation({
      key: `review-${action}`,
      ...label,
      details,
      destructive: action === "reject",
      // An empty initial reason keeps the optional approval note in the dialog.
      initialReason: "",
      requireReason: action !== "approve",
      onConfirm: (confirmedReason) => commitReviewAction(submission, action, confirmedReason, action === "approve" ? artifactSha256 : null),
    });
  }

  async function downloadReviewArtifact(submission: ReviewSubmissionSummary) {
    setArtifactStatus(null);
    setArtifactLoadingId(submission.id);
    try {
      const bundle = await client.getReviewSubmissionBundle(submission.id);
      setReviewArtifactHashes((current) => ({ ...current, [submission.id]: bundle.artifactSha256 }));
      downloadJsonFile(`${submission.slug}-${submission.version}-review.myskills.json`, bundle.payload);
      setArtifactStatus({ submissionId: submission.id, error: false, text: "Review artifact downloaded. Its SHA-256 is recorded for approval." });
    } catch (error) {
      setArtifactStatus({ submissionId: submission.id, error: true, text: safeReviewErrorMessage(error) });
    } finally {
      setArtifactLoadingId(null);
    }
  }

  // "Inspect artifact" mounts the auto-loading viewer; pressing it again after
  // a failure starts a fresh attempt. The loader records the header hash for
  // the submission it was created for.
  function inspectArtifact(submission: ReviewSubmissionSummary) {
    if (inspecting.current === submission.id) return;
    inspecting.current = submission.id;
    setInspectingId(submission.id);
    setInspectAttempts((current) => ({ ...current, [submission.id]: (current[submission.id] ?? 0) + 1 }));
  }

  async function loadReviewBundle(submissionId: string) {
    inspecting.current = submissionId;
    setInspectingId(submissionId);
    try {
      const bundle = await client.getReviewSubmissionBundle(submissionId);
      setReviewArtifactHashes((current) => ({ ...current, [submissionId]: bundle.artifactSha256 }));
      return bundle.payload;
    } finally {
      if (inspecting.current === submissionId) inspecting.current = null;
      setInspectingId((current) => current === submissionId ? null : current);
    }
  }

  function openSubmission(submissionId: string) {
    setSelectedId(submissionId);
    if (stacked) {
      setDetailOpen(true);
      focusTarget.current = { kind: "title" };
    }
  }

  function backToQueue() {
    setDetailOpen(false);
    if (selected) focusTarget.current = { kind: "row", id: selected.id };
  }

  // Focus moves into the detail, back to the row, and after a decision to the
  // same submission's next step, or to the queue notice when it has left the
  // queue. This runs after the dialog's own focus restoration.
  useEffect(() => {
    if (stacked && detailOpen && state !== "loading" && !selected) setDetailOpen(false);
    const target = focusTarget.current;
    if (!target || confirmation) return;
    let element: HTMLElement | null | undefined = null;
    if (target.kind === "title") element = titleRef.current;
    else if (target.kind === "row") element = Array.from(queueRef.current?.querySelectorAll<HTMLElement>("[data-id]") ?? []).find((row) => row.dataset.id === target.id);
    else {
      if (state === "loading") return;
      if (submissions.some((submission) => submission.id === target.id)) {
        element = primaryRef.current ?? decisionNoticeRef.current ?? titleRef.current;
      } else if (stacked && detailOpen) {
        setDetailOpen(false);
        return;
      } else {
        element = queueNoticeRef.current;
      }
    }
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  // Decisions link back to the exact release: readable once published,
  // otherwise the Can manage Versions section.
  const renderOutcomeLink = (skill: { label: string; href: string }) => (
    <p className="review-outcome-link">
      <a href={skill.href} onClick={(event) => handleCallbackLink(event, () => onOpenSkill(skill.href))}>{skill.label}</a>
    </p>
  );

  const canPublish = allowedReviewActions.includes("publish");
  const canApprove = allowedReviewActions.includes("approve");
  const primary = !selected ? null
    : canPublish ? { label: "Publish", icon: <PackageCheck size={16} aria-hidden="true" />, busy: false, run: () => requestReviewAction(selected, "publish") }
      : canApprove && !selectedArtifactHash ? { label: inspectingId === selected.id ? "Inspecting artifact…" : "Inspect artifact", icon: <FileCode2 size={16} aria-hidden="true" />, busy: inspectingId === selected.id, run: () => inspectArtifact(selected) }
        : canApprove ? { label: "Approve", icon: <Check size={16} aria-hidden="true" />, busy: false, run: () => requestReviewAction(selected, "approve") }
          : null;
  const inspectAttempt = selected ? inspectAttempts[selected.id] : undefined;

  const renderQueueRow = (submission: ReviewSubmissionSummary) => {
    const security = securityStatusLabel(submission.securityStatus);
    const findings = findingsLabel(submission.findingCount);
    const review = reviewStatusLabel(submission.reviewStatus);
    return (
      <button
        aria-pressed={stacked ? undefined : selected?.id === submission.id}
        className="registry-row result-row"
        data-id={submission.id}
        key={submission.id}
        type="button"
        onClick={() => openSubmission(submission.id)}
      >
        <span className="registry-tile" data-tone={tileTone(submission.slug)} aria-hidden="true" />
        <span className="registry-row-text">
          <span className="registry-row-title">{submission.title}</span>
          <span className="registry-row-meta">
            <code>{submission.slug}@{submission.version}</code>
            <span>Submitted {formatDate(submission.createdAt)}</span>
          </span>
          <span className="author-chips">
            {["changes-requested", "rejected"].includes(submission.reviewStatus) && <span className="registry-chip" data-tone={chipTone(review.tone)}>{review.label}</span>}
            <span className="registry-chip" data-tone={chipTone(security.tone)}>{security.label}</span>
            <span className="registry-chip" data-tone={chipTone(findings.tone)}>{findings.label}</span>
          </span>
        </span>
      </button>
    );
  };

  const renderInspector = (submission: ReviewSubmissionSummary) => {
    const security = securityStatusLabel(submission.securityStatus);
    const findings = findingsLabel(submission.findingCount);
    const review = reviewStatusLabel(submission.reviewStatus);
    const steps = reviewSteps(submission, allowedReviewActions, selectedArtifactHash);
    const canRequestChanges = allowedReviewActions.includes("request-changes");
    const canReject = allowedReviewActions.includes("reject");
    const decisionNotice = notice?.submissionId === submission.id ? notice : null;
    const decisionMessage = decisionError?.submissionId === submission.id ? decisionError : null;
    const artifactMessage = artifactStatus?.submissionId === submission.id ? artifactStatus : null;
    return (
      <>
        <header className="registry-inspector-head">
          <span className="registry-tile" data-size="32" data-tone={tileTone(submission.slug)} aria-hidden="true" />
          <div className="registry-inspector-title">
            <h2 ref={titleRef} tabIndex={-1}>{submission.title}</h2>
            <p className="registry-ref">
              <code>{submission.slug}</code>
              <span aria-hidden="true">@</span>
              <code>{submission.version}</code>
            </p>
            <p className="registry-inspector-meta">
              <span>Submitted {formatDate(submission.createdAt)}</span>
              <span aria-hidden="true">·</span>
              <span>{visibilityLabel(submission.visibility)}</span>
            </p>
            <p className="author-chips">
              {["changes-requested", "rejected"].includes(submission.reviewStatus) && <span className="registry-chip" data-tone={chipTone(review.tone)}>{review.label}</span>}
              <span className="registry-chip" data-tone={chipTone(security.tone)}>{security.label}</span>
              <span className="registry-chip" data-tone={chipTone(findings.tone)}>{findings.label}</span>
            </p>
          </div>
        </header>

        <section aria-label="Review decision" className="review-decision">
          <p className="review-decision-context">Decision for <code>{submission.slug}@{submission.version}</code></p>
          <ol aria-label="Release steps" className="review-steps">
            {steps.map((step) => (
              <li aria-current={step.state === "current" ? "step" : undefined} data-state={step.state} key={step.label}>
                {step.state === "done" && <span className="sr-only">Done: </span>}
                {step.state === "blocked" && <span className="sr-only">Blocked: </span>}
                {step.label}
              </li>
            ))}
          </ol>
          {actionHint && <p className="review-hint">{actionHint}</p>}
          {decisionNotice && <p className="author-status" data-tone="teal" ref={decisionNoticeRef} role="status" tabIndex={-1}>{decisionNotice.text}</p>}
          {decisionNotice && renderOutcomeLink(decisionNotice.skill)}
          {decisionMessage && <p className="author-status" data-tone="danger" role="status">{decisionMessage.text}</p>}
          {primary || canRequestChanges || canReject ? (
            <div className="review-decision-actions">
              {primary && (
                <Button
                  aria-disabled={primary.busy || undefined}
                  className="review-primary"
                  ref={primaryRef}
                  size="sm"
                  type="button"
                  onClick={() => { if (!primary.busy) primary.run(); }}
                >
                  {primary.icon}
                  {primary.label}
                </Button>
              )}
              {canRequestChanges && (
                <Button size="sm" type="button" variant="outline" onClick={() => requestReviewAction(submission, "request-changes")}>
                  <RotateCw size={16} aria-hidden="true" />
                  Request changes
                </Button>
              )}
              {canReject && (
                <Button className="author-danger review-reject" size="sm" type="button" variant="outline" onClick={() => requestReviewAction(submission, "reject")}>
                  <X size={16} aria-hidden="true" />
                  Reject
                </Button>
              )}
            </div>
          ) : (
            <p className="registry-muted">No review decision is available for this submission.</p>
          )}
        </section>

        <div className="registry-inspector-body">
          <section aria-labelledby={`${baseId}-artifact`} className="registry-section review-artifact">
            <h3 id={`${baseId}-artifact`}>Artifact</h3>
            <dl className="registry-facts">
              <div>
                <dt>SHA-256</dt>
                <dd className={selectedArtifactHash ? "registry-mono" : undefined}>{selectedArtifactHash ?? "Not inspected yet"}</dd>
              </div>
              {selectedArtifactHash && (
                <div>
                  <dt>Recorded</dt>
                  <dd>{reviewArtifactHashes[submission.id] ? "In this session" : "At approval"}</dd>
                </div>
              )}
            </dl>
            <div className="registry-actions">
              <Button disabled={artifactLoadingId === submission.id} size="sm" type="button" variant="outline" onClick={() => void downloadReviewArtifact(submission)}>
                <Download size={16} aria-hidden="true" />
                Download artifact
              </Button>
            </div>
            {artifactMessage && <p className="author-status" data-tone={artifactMessage.error ? "danger" : "teal"} role={artifactMessage.error ? "alert" : "status"}>{artifactMessage.text}</p>}
            {inspectAttempt !== undefined && (
              <PackageFileViewer autoInspect loadBundle={() => loadReviewBundle(submission.id)} resourceKey={`review:${submission.id}:${inspectAttempt}`} />
            )}
          </section>

          {client.getReviewSubmissionDetail && <SubmissionEvidencePanel key={`${submission.id}:${submission.reviewStatus}`} client={client} submissionId={submission.id} mode="reviewer" />}

          <section aria-labelledby={`${baseId}-details`} className="registry-section">
            <h3 id={`${baseId}-details`}>Submission details</h3>
            <dl className="registry-facts" data-labels="wide">
              <div><dt>Review status</dt><dd>{review.label}</dd></div>
              <div><dt>Lifecycle</dt><dd>{lifecycleLabel(submission.lifecycleStatus).label}</dd></div>
              <div><dt>Platforms</dt><dd>{submission.platforms.map((item) => item.name).join(", ") || "None declared"}</dd></div>
              <div><dt>Submission ID</dt><dd className="registry-mono">{submission.id}</dd></div>
            </dl>
          </section>
        </div>
      </>
    );
  };

  return (
    <main className="registry-workspace author-review review-dashboard" aria-label="Maintainer review dashboard">
      <header className="registry-page-head">
        <h1>Review dashboard</h1>
        <Button aria-label="Refresh" size="icon-sm" type="button" variant="outline" onClick={() => void refreshReview()}>
          <RotateCw size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className="registry-surface" data-layout={layout} ref={surfaceRef}>
        <div className="registry-body" data-columns={inspectorVisible && showQueue ? undefined : "1"}>
          {showQueue && (
            <section aria-busy={state === "loading"} aria-label="Review queue" className="registry-list review-queue" ref={queueRef}>
              <div className="registry-list-label">
                <h2>Queue</h2>
                <span aria-live="polite">{state === "ready" ? (nextCursor ? `${submissions.length} loaded` : String(submissions.length)) : ""}</span>
              </div>
              {queueNotice && <p className="author-status" data-tone="teal" ref={queueNoticeRef} role="status" tabIndex={-1}>{queueNotice.text}</p>}
              {queueNotice && renderOutcomeLink(queueNotice.skill)}
              {state === "loading" && (
                <div className="registry-skeleton" role="status" aria-live="polite">
                  <span className="sr-only">Loading submissions…</span>
                  {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
                </div>
              )}
              {state === "error" && (
                <div className="registry-list-state">
                  <p role="alert"><strong>{message ?? "Review queue is not available."}</strong></p>
                  <p>Retry the queue before reviewing a submission.</p>
                  <Button size="sm" type="button" variant="outline" onClick={() => void refreshReview()}>
                    <RotateCw size={15} aria-hidden="true" />
                    Retry
                  </Button>
                </div>
              )}
              {QUEUE_GROUPS.map((group) => {
                const rows = submissions.filter((submission) => reviewGroup(submission) === group.id);
                if (rows.length === 0) return null;
                return (
                  <div aria-labelledby={`${baseId}-${group.id}`} className="review-group" key={group.id} role="group">
                    <h3 className="review-group-label" id={`${baseId}-${group.id}`}>{group.label}</h3>
                    <div className="registry-rows">{rows.map(renderQueueRow)}</div>
                  </div>
                );
              })}
              {state === "ready" && nextCursor && (
                <div className="registry-list-foot">
                  <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={() => void loadMoreReview()}>{loadingMore ? "Loading more submissions…" : "Load more submissions"}</Button>
                </div>
              )}
              {state === "ready" && message && <p className="registry-alert" role="alert">{message}</p>}
              {state === "ready" && submissions.length === 0 && (
                <div className="registry-list-state">
                  <strong>Review queue is clear.</strong>
                  <p>No submissions are awaiting approval or publication.</p>
                </div>
              )}
            </section>
          )}
          {inspectorVisible && (
            <section aria-label="Selected submission review" className="registry-inspector review-inspector">
              {stacked && (
                <Button className="registry-back" type="button" variant="ghost" onClick={backToQueue}>
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back to queue
                </Button>
              )}
              {selected ? renderInspector(selected) : (
                <div className="registry-skeleton registry-skeleton-detail" role="status" aria-live="polite">
                  <span className="sr-only">Loading submission…</span>
                  <div className="registry-skeleton-head"><span /><span /></div>
                  <div className="registry-skeleton-line" />
                  <div className="registry-skeleton-line" />
                  <div className="registry-skeleton-block" />
                </div>
              )}
            </section>
          )}
        </div>
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function fallbackReviewActions(submission: ReviewSubmissionSummary | null): ReviewActionName[] {
  if (!submission) {
    return [];
  }
  if (submission.reviewStatus === "approved" && submission.securityStatus === "passed") {
    return submission.approvedArtifactSha256 ? ["publish"] : [];
  }
  if (["unreviewed", "changes-requested"].includes(submission.reviewStatus)) {
    return submission.securityStatus === "passed"
      ? ["approve", "request-changes", "reject"]
      : ["request-changes", "reject"];
  }
  return [];
}

type ReviewFocus = { kind: "title" } | { kind: "row"; id: string } | { kind: "decision"; id: string };
type ReviewGroup = "decide" | "publish" | "blocked";
type ReviewStepState = "done" | "current" | "blocked" | "upcoming";

// The queue groups rows by the next action the server allows.
const QUEUE_GROUPS: Array<{ id: ReviewGroup; label: string }> = [
  { id: "decide", label: "Needs a decision" },
  { id: "publish", label: "Ready to publish" },
  { id: "blocked", label: "Approval blocked" },
];

function reviewGroup(submission: ReviewSubmissionSummary): ReviewGroup {
  const allowed = submission.allowedActions ?? fallbackReviewActions(submission);
  return allowed.includes("approve") ? "decide" : allowed.includes("publish") ? "publish" : "blocked";
}

/** Queue rows in display order, so the implicit selection is the first visible row. */
function queueOrder(submissions: ReviewSubmissionSummary[]): ReviewSubmissionSummary[] {
  return QUEUE_GROUPS.flatMap((group) => submissions.filter((submission) => reviewGroup(submission) === group.id));
}

function reviewSteps(submission: ReviewSubmissionSummary, allowed: ReviewActionName[], artifactHash: string | null): Array<{ label: string; state: ReviewStepState }> {
  const approved = submission.reviewStatus === "approved";
  const canApprove = allowed.includes("approve");
  return [
    { label: "Inspect artifact", state: artifactHash ? "done" : canApprove ? "current" : "upcoming" },
    { label: "Approve", state: approved ? "done" : canApprove ? (artifactHash ? "current" : "upcoming") : "blocked" },
    { label: "Publish", state: allowed.includes("publish") ? "current" : approved ? "blocked" : "upcoming" },
  ];
}

type TeamEntry = { id: string; name: string; role: string; team: TeamRecord | null; group: TeamSharedSkillGroup | null };
type PeopleNotice = { scope: string; text: string; tone: "danger" | "teal" };
type TeamsFocus = { kind: "title" | "new-team" | "team-name" | "invite-email" | "invite-trigger" | "accepted" } | { kind: "row"; id: string };

/** Listed teams, plus read-only entries for shared groups whose team is not listed. */
function teamEntries(dashboard: TeamDashboard, groups: TeamSharedSkillGroup[]): TeamEntry[] {
  const groupByTeam = new Map(groups.map((group) => [group.team.id, group]));
  const entries: TeamEntry[] = dashboard.teams.map((team) => ({ id: team.id, name: team.name, role: team.role, team, group: groupByTeam.get(team.id) ?? null }));
  const listed = new Set(entries.map((entry) => entry.id));
  for (const group of groups) {
    if (!listed.has(group.team.id)) entries.push({ id: group.team.id, name: group.team.name, role: group.team.role, team: null, group });
  }
  return entries;
}

function findRowById(root: HTMLElement | null, id: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []) {
    if (element.dataset.rowId === id) return element;
  }
  return null;
}

// Teams use the Skills list and detail layout (people.css): the list comes
// first, and the selected team's detail sits beside it on a wide surface or
// replaces it (with Back) on a narrow one. Messages render beside the control
// that caused them.
function TeamsDashboard({ client }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<PeopleNotice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboard>({ teams: [], invitations: [] });
  const [sharedGroups, setSharedGroups] = useState<TeamSharedSkillGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [inviteOpenId, setInviteOpenId] = useState<string | null>(null);
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const { layout, ref: surfaceRef } = useSplitLayout();
  const refreshEpoch = useRef(0);
  const selectedRef = useRef<string | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const listLabelRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const newTeamRef = useRef<HTMLButtonElement>(null);
  const inviteTriggerRef = useRef<HTMLButtonElement>(null);
  const acceptedRef = useRef<HTMLParagraphElement>(null);
  const focusTarget = useRef<TeamsFocus | null>(null);
  const baseId = useId();
  const stacked = layout === "stack";
  const entries = useMemo(() => teamEntries(dashboard, sharedGroups), [dashboard, sharedGroups]);
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const team = selected?.team ?? null;
  const inviteOpen = team !== null && inviteOpenId === team.id;
  const showDetail = selected !== null && (!stacked || detailOpen);
  const listHidden = stacked && showDetail;

  const refreshTeams = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    setState("loading");
    setNotice((current) => current?.scope === "load" ? null : current);
    try {
      const [nextDashboard, nextGroups] = await Promise.all([
        client.listTeams(),
        client.listTeamSharedSkills(),
      ]);
      if (epoch !== refreshEpoch.current) return false;
      const ids = teamEntries(nextDashboard, nextGroups).map((entry) => entry.id);
      const current = selectedRef.current;
      const kept = current && ids.includes(current) ? current : null;
      // Auto-selection never opens the stacked detail; only a tap does.
      if (!kept) setDetailOpen(false);
      selectedRef.current = kept ?? ids[0] ?? null;
      setSelectedId(selectedRef.current);
      setDashboard(nextDashboard);
      setSharedGroups(nextGroups);
      setLoaded(true);
      setState("ready");
      return true;
    } catch (error) {
      if (epoch !== refreshEpoch.current) return false;
      setNotice({ scope: "load", text: safeTeamErrorMessage(error), tone: "danger" });
      setState("error");
      return false;
    }
  }, [client]);

  useEffect(() => {
    void refreshTeams();
    return () => { refreshEpoch.current += 1; };
  }, [refreshTeams]);

  // Focus follows the reader: into an opened team, back to its row, and
  // between each on-demand form and the button that opened it.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    const element = target.kind === "row" ? findRowById(listRef.current, target.id) ?? listLabelRef.current
      : target.kind === "title" ? titleRef.current
        : target.kind === "new-team" ? newTeamRef.current
          : target.kind === "team-name" ? document.getElementById(`${baseId}-team-name`)
            : target.kind === "invite-email" ? document.getElementById(`${baseId}-invite-email`)
              : target.kind === "invite-trigger" ? inviteTriggerRef.current
                : acceptedRef.current;
    if (!element) return;
    focusTarget.current = null;
    element.focus();
  });

  function openTeam(id: string) {
    if (id !== selectedRef.current) setInviteOpenId(null);
    selectedRef.current = id;
    setSelectedId(id);
    setDetailOpen(true);
    focusTarget.current = { kind: "title" };
  }

  function backToTeams() {
    setDetailOpen(false);
    setInviteOpenId(null);
    if (selectedRef.current) focusTarget.current = { kind: "row", id: selectedRef.current };
  }

  function openCreate() {
    setCreateOpen(true);
    if (stacked) setDetailOpen(false);
    focusTarget.current = { kind: "team-name" };
  }

  function closeCreate() {
    if (pending === "create") return;
    setCreateOpen(false);
    setTeamName("");
    setNotice((current) => current?.scope === "create" ? null : current);
    focusTarget.current = { kind: "new-team" };
  }

  function openInvite(teamId: string) {
    setInviteOpenId(teamId);
    setNotice((current) => current?.scope === `invite:${teamId}` ? null : current);
    focusTarget.current = { kind: "invite-email" };
  }

  function closeInvite() {
    if (pending?.startsWith("invite:")) return;
    setInviteOpenId(null);
    focusTarget.current = { kind: "invite-trigger" };
  }

  async function createTeam() {
    if (!teamName.trim() || pending) return;
    const created = teamName.trim();
    setPending("create");
    setNotice(null);
    try {
      await client.createTeam(teamName);
      setTeamName("");
      setCreateOpen(false);
      focusTarget.current = { kind: "new-team" };
      if (await refreshTeams()) setNotice({ scope: "list", text: `${created} was created.`, tone: "teal" });
    } catch (error) {
      setNotice({ scope: "create", text: safeTeamErrorMessage(error), tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  async function inviteMember(invitedTeam: TeamRecord) {
    const email = inviteEmails[invitedTeam.id]?.trim();
    if (!email || pending) return;
    const scope = `invite:${invitedTeam.id}`;
    setPending(scope);
    setNotice(null);
    try {
      await client.inviteTeamMember(invitedTeam.id, email);
      setInviteEmails((current) => ({ ...current, [invitedTeam.id]: "" }));
      setInviteOpenId(null);
      focusTarget.current = { kind: "invite-trigger" };
      if (await refreshTeams()) setNotice({ scope, text: `Invitation sent to ${email}.`, tone: "teal" });
    } catch (error) {
      setNotice({ scope, text: safeTeamErrorMessage(error), tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  async function acceptInvitation(invitation: TeamInvitation) {
    if (pending) return;
    setPending(`accept:${invitation.id}`);
    setNotice(null);
    try {
      await client.acceptTeamInvitation(invitation.id);
      if (await refreshTeams()) {
        setNotice({ scope: "accepted", text: `You joined ${invitation.teamName}.`, tone: "teal" });
        focusTarget.current = { kind: "accepted" };
      }
    } catch (error) {
      setNotice({ scope: `accept:${invitation.id}`, text: safeTeamErrorMessage(error), tone: "danger" });
    } finally {
      setPending(null);
    }
  }

  const scoped = (scope: string) => notice?.scope === scope
    ? <p className="people-status" data-tone={notice.tone} role={notice.tone === "danger" ? "alert" : "status"}>{notice.text}</p>
    : null;

  return (
    <main className="registry-workspace people-workspace teams-workspace" aria-label="Teams">
      <header className="app-page-header people-page-head">
        <h1>Teams</h1>
        <div className="people-page-actions">
          <Button aria-expanded={createOpen} ref={newTeamRef} size="sm" type="button" onClick={openCreate}>
            <Plus size={16} aria-hidden="true" />
            New team
          </Button>
          <Button size="sm" type="button" variant="outline" onClick={() => void refreshTeams()}>
            <RotateCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      {(dashboard.invitations.length > 0 || notice?.scope === "accepted") && (
        <section aria-labelledby={`${baseId}-invitations`} className="people-invitations">
          <h2 id={`${baseId}-invitations`}>Invitations for you</h2>
          {dashboard.invitations.length > 0 && (
            <ul>
              {dashboard.invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span className="people-person">
                    <strong id={`${baseId}-invitation-${invitation.id}`}>{invitation.teamName}</strong>
                    <small>{invitation.email} · Sent {formatDate(invitation.createdAt)}</small>
                  </span>
                  <Button aria-describedby={`${baseId}-invitation-${invitation.id}`} disabled={pending !== null} size="sm" type="button" onClick={() => void acceptInvitation(invitation)}>
                    <Check size={15} aria-hidden="true" />
                    {pending === `accept:${invitation.id}` ? "Accepting…" : "Accept"}
                  </Button>
                  {scoped(`accept:${invitation.id}`)}
                </li>
              ))}
            </ul>
          )}
          {notice?.scope === "accepted" && <p className="people-status" data-tone="teal" ref={acceptedRef} role="status" tabIndex={-1}>{notice.text}</p>}
        </section>
      )}

      <div className="registry-surface" data-layout={layout} ref={surfaceRef}>
        <div className="registry-body" data-columns={showDetail && !listHidden ? undefined : "1"}>
          <section aria-busy={state === "loading"} aria-labelledby={`${baseId}-list`} className="registry-list" hidden={listHidden} ref={listRef}>
            {createOpen && (
              <form className="people-create" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeCreate(); } }} onSubmit={(event) => { event.preventDefault(); void createTeam(); }}>
                <label className="people-field" htmlFor={`${baseId}-team-name`}>
                  <span>Team name</span>
                  <Input autoComplete="off" disabled={pending === "create"} id={`${baseId}-team-name`} onChange={(event) => setTeamName(event.target.value)} value={teamName} />
                </label>
                <div className="people-form-actions">
                  <Button disabled={!teamName.trim() || pending === "create"} size="sm" type="submit">
                    <Plus size={15} aria-hidden="true" />
                    Create
                  </Button>
                  <Button disabled={pending === "create"} size="sm" type="button" variant="outline" onClick={closeCreate}>Cancel</Button>
                </div>
                {scoped("create")}
              </form>
            )}
            <div className="registry-list-label">
              <h2 id={`${baseId}-list`} ref={listLabelRef} tabIndex={-1}>Teams</h2>
              <span aria-live="polite">{loaded ? entries.length : ""}</span>
            </div>
            {scoped("list")}
            {state === "loading" && !loaded && (
              <div className="registry-skeleton" role="status" aria-live="polite">
                <span className="sr-only">Loading teams…</span>
                {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
              </div>
            )}
            {notice?.scope === "load" && (
              <div className="registry-list-state">
                <p role="alert">{notice.text}</p>
                <Button size="sm" type="button" variant="outline" onClick={() => void refreshTeams()}>
                  <RotateCw size={15} aria-hidden="true" />
                  Retry
                </Button>
              </div>
            )}
            {entries.length > 0 && (
              <div className="registry-rows">
                {entries.map((entry) => (
                  <button
                    aria-current={!stacked && entry.id === selectedId ? "true" : undefined}
                    className="registry-row people-row"
                    data-row-id={entry.id}
                    key={entry.id}
                    type="button"
                    onClick={() => openTeam(entry.id)}
                  >
                    <span className="people-row-icon" aria-hidden="true"><UsersRound size={16} /></span>
                    <span className="registry-row-text">
                      <span className="registry-row-title">{entry.name}</span>
                      <span className="registry-row-meta">
                        <span>{formatStatusLabel(entry.role)}</span>
                        <span>{entry.team ? `${entry.team.members.length} ${entry.team.members.length === 1 ? "member" : "members"}` : "Shared skills only"}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {state === "ready" && entries.length === 0 && (
              <div className="registry-list-state">
                <strong>No teams yet.</strong>
                <p>Create a team to start sharing private skills with members.</p>
              </div>
            )}
          </section>

          {showDetail && selected && (
            <section aria-labelledby={`${baseId}-title`} className="registry-inspector people-detail">
              {stacked && (
                <Button className="registry-back" type="button" variant="ghost" onClick={backToTeams}>
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back to teams
                </Button>
              )}
              <header className="people-detail-head">
                <div className="registry-inspector-title">
                  <h2 id={`${baseId}-title`} ref={titleRef} tabIndex={-1}>{selected.name}</h2>
                  <p className="registry-inspector-meta">
                    {team && <><code>{team.slug}</code><span aria-hidden="true">·</span></>}
                    <span>Your role: {formatStatusLabel(selected.role)}</span>
                  </p>
                </div>
              </header>
              {team ? (
                <>
                  <section aria-labelledby={`${baseId}-members`} className="registry-section">
                    <div className="people-section-head">
                      <h3 id={`${baseId}-members`}>Members</h3>
                      {team.role === "owner" && (
                        <Button aria-expanded={inviteOpen} ref={inviteTriggerRef} size="sm" type="button" variant="outline" onClick={() => inviteOpen ? closeInvite() : openInvite(team.id)}>
                          <Mail size={15} aria-hidden="true" />
                          Invite member
                        </Button>
                      )}
                    </div>
                    {team.role !== "owner" && <p className="registry-muted">Only team owners can invite members.</p>}
                    {inviteOpen && (
                      <form className="people-inline-form" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeInvite(); } }} onSubmit={(event) => { event.preventDefault(); void inviteMember(team); }}>
                        <label className="people-field people-field-grow" htmlFor={`${baseId}-invite-email`}>
                          <span>Email</span>
                          <Input
                            aria-label={`Invite user to ${team.name}`}
                            autoComplete="email"
                            disabled={pending === `invite:${team.id}`}
                            id={`${baseId}-invite-email`}
                            onChange={(event) => setInviteEmails((current) => ({ ...current, [team.id]: event.target.value }))}
                            placeholder="user@example.com"
                            spellCheck={false}
                            type="email"
                            value={inviteEmails[team.id] ?? ""}
                          />
                        </label>
                        <div className="people-form-actions">
                          <Button disabled={!inviteEmails[team.id]?.trim() || pending === `invite:${team.id}`} size="sm" type="submit">
                            <Plus size={15} aria-hidden="true" />
                            Invite
                          </Button>
                          <Button disabled={pending === `invite:${team.id}`} size="sm" type="button" variant="outline" onClick={closeInvite}>Cancel</Button>
                        </div>
                      </form>
                    )}
                    {scoped(`invite:${team.id}`)}
                    {team.members.length > 0 ? (
                      <ul aria-labelledby={`${baseId}-members`} className="people-list">
                        {team.members.map((member) => (
                          <li key={member.id}>
                            <span className="people-person">
                              <strong>{member.name || member.email}</strong>
                              {member.name && <small>{member.email}</small>}
                            </span>
                            <span className="registry-chip">{formatStatusLabel(member.role)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="registry-muted">No members returned for this team.</p>}
                  </section>
                  <section aria-labelledby={`${baseId}-invited`} className="registry-section">
                    <h3 id={`${baseId}-invited`}>Pending invitations</h3>
                    {team.invitations.length > 0 ? (
                      <ul aria-labelledby={`${baseId}-invited`} className="people-list">
                        {team.invitations.map((invitation) => (
                          <li key={invitation.id}>
                            <span className="people-person">
                              <strong>{invitation.email}</strong>
                              <small>Sent {formatDate(invitation.createdAt)}</small>
                            </span>
                            {invitation.status !== "pending" && <span className="registry-chip">{formatStatusLabel(invitation.status)}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="registry-muted">No pending invitations.</p>}
                  </section>
                </>
              ) : (
                <p className="registry-muted">This team is not in your team list, so only the skills shared through it are shown.</p>
              )}
              <TeamSkillSection title="Shared by you" skills={selected.group?.sharingWithTeam ?? []} empty="You are not sharing skills with this team." />
              <TeamSkillSection title="Shared with you" skills={selected.group?.sharedWithMe ?? []} empty="No skills are shared with you through this team." />
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function TeamSkillSection({ empty, skills, title }: { empty: string; skills: PublicSkill[]; title: string }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="registry-section">
      <h3 id={headingId}>{title}</h3>
      {skills.length > 0 ? (
        <ul aria-labelledby={headingId} className="people-list">
          {skills.map((skill) => (
            <li key={skill.slug}>
              <span className="people-person">
                <strong>{skill.title}</strong>
                <small><code>{skill.slug}</code>{skill.latestVersion ? ` · ${releaseVersionLabel(skill.latestVersion)}` : ""}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="registry-muted">{empty}</p>}
    </section>
  );
}

type AdminTab = "people" | "instance" | "github" | "branding" | "keys" | "providers" | "audit";
const ADMIN_TABS: ReadonlyArray<{ id: AdminTab; label: string }> = [
  { id: "people", label: "People" },
  { id: "instance", label: "Instance" },
  { id: "branding", label: "Branding" },
  { id: "github", label: "GitHub" },
  { id: "keys", label: "API keys" },
  { id: "providers", label: "Sign-in providers" },
  { id: "audit", label: "Audit" },
];

function AdminConsole({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [registrationMode, setRegistrationMode] = useState<AdminRegistrationMode>("closed");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [apiTokens, setApiTokens] = useState<AdminApiToken[]>([]);
  const [providers, setProviders] = useState<AdminProviderConfig[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const auditScope = useMemo(() => ({ active: true }), [client, session.user.id, session.expiresAt]);
  const auditEpoch = useRef(0);
  const auditPending = useRef(false);
  const adminEpoch = useRef(0);
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft());
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteState, setInviteState] = useState<LoadState>("idle");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<RegistrationInvitation | null>(null);
  const [tab, setTab] = useState<AdminTab>("people");
  const [inviteOpen, setInviteOpen] = useState(false);
  const tabRefs = useRef(new Map<AdminTab, HTMLButtonElement>());
  const inviteTriggerRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const sessionCanEditPrivilegedRoles = session.user.roles.includes("owner");
  const adminInitialLoading = state === "loading" && users.length === 0 && apiTokens.length === 0 && providers.length === 0 && auditEvents.length === 0;

  async function refreshAudit() {
    if (!auditScope.active) return;
    const epoch = ++auditEpoch.current;
    auditPending.current = false;
    setAuditCursor(null);
    setAuditEvents([]);
    setLoadingAudit(true);
    try {
      const page = client.listAdminAuditPage ? await client.listAdminAuditPage({ limit: 25 })
        : { events: await client.listAdminAudit(25), nextCursor: null };
      if (!auditScope.active || epoch !== auditEpoch.current) return;
      setAuditEvents(page.events);
      setAuditCursor(page.nextCursor);
    } finally {
      if (auditScope.active && epoch === auditEpoch.current) setLoadingAudit(false);
    }
  }

  async function loadMoreAudit() {
    if (!auditCursor || auditPending.current || !client.listAdminAuditPage) return;
    const epoch = auditEpoch.current;
    auditPending.current = true;
    setLoadingAudit(true);
    setMessage(null);
    try {
      const page = await client.listAdminAuditPage({ limit: 25, cursor: auditCursor });
      if (epoch !== auditEpoch.current) return;
      setAuditEvents((current) => appendUniqueById(current, page.events));
      setAuditCursor(page.nextCursor);
    } catch (error) {
      if (epoch === auditEpoch.current) setMessage(safeAdminErrorMessage(error));
    } finally {
      if (epoch === auditEpoch.current) { auditPending.current = false; setLoadingAudit(false); }
    }
  }

  async function refreshAdmin() {
    const epoch = ++adminEpoch.current;
    setState("loading");
    setMessage(null);
    try {
      const [registration, nextUsers, nextApiTokens, nextProviders] = await Promise.all([
        client.getAdminRegistration(),
        client.listAdminUsers(),
        client.listAdminApiTokens(),
        client.listAdminProviders(),
        refreshAudit(),
      ]);
      if (epoch !== adminEpoch.current) return;
      setRegistrationMode(registration.mode);
      setUsers(nextUsers);
      setApiTokens(nextApiTokens);
      setProviders(nextProviders);
      setDraft((current) => current.key ? current : providerToDraft(nextProviders[0]));
      setState("ready");
    } catch (error) {
      if (epoch !== adminEpoch.current) return;
      setMessage(safeAdminErrorMessage(error));
      setState("error");
    }
  }

  useEffect(() => {
    auditScope.active = true;
    setAuditEvents([]);
    void refreshAdmin();
    return () => { auditScope.active = false; auditEpoch.current += 1; adminEpoch.current += 1; };
  }, [client, session.user.id, session.expiresAt, auditScope]);

  async function updateRegistration(mode: AdminRegistrationMode) {
    setMessage(null);
    if (mode === "open" && registrationMode !== "open") {
      setConfirmation({
        key: "open-registration",
        title: "Open public registration?",
        description: "New accounts will be able to sign up without an owner approving each request first.",
        confirmLabel: "Open registration",
        onConfirm: async () => applyRegistration(mode),
      });
      return;
    }
    try {
      await applyRegistration(mode);
    } catch {
      // The safe error is already rendered by applyRegistration.
    }
  }

  async function applyRegistration(mode: AdminRegistrationMode) {
    try {
      const registration = await client.updateAdminRegistration(mode);
      setRegistrationMode(registration.mode);
      await refreshAudit();
    } catch (error) {
      const safeMessage = safeAdminErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function createInvitation() {
    setInviteMessage(null);
    setInvitation(null);
    setInviteState("loading");
    try {
      const created = await client.createRegistrationInvitation({
        email: inviteEmail,
        ...(inviteName.trim() ? { name: inviteName.trim() } : {}),
      });
      setInvitation(created);
      setInviteEmail("");
      setInviteName("");
      setInviteState("ready");
      await refreshAudit();
    } catch (error) {
      setInviteState("error");
      setInviteMessage(safeAdminErrorMessage(error));
    }
  }

  async function performUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete") {
    setMessage(null);
    if (action === "disable" || action === "delete") {
      setConfirmation({
        key: `${action}-user`,
        title: action === "delete" ? "Delete this user?" : "Disable this user?",
        description: action === "delete"
          ? "This removes account access and cannot be undone from this screen."
          : "The user will lose access until an administrator reactivates the account.",
        confirmLabel: action === "delete" ? "Delete user" : "Disable user",
        destructive: true,
        initialReason: "",
        requireReason: true,
        onConfirm: (confirmedReason) => applyUserAction(userId, action, confirmedReason),
      });
      return;
    }
    try {
      await applyUserAction(userId, action);
    } catch {
      // The safe error is already rendered by applyUserAction.
    }
  }

  async function applyUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete", reason?: string) {
    try {
      const updated = await client.performAdminUserAction(userId, action, reason);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      await refreshAudit();
    } catch (error) {
      const safeMessage = safeAdminErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function updateUserRoles(userId: string, roles: string[]) {
    setMessage(null);
    const user = users.find((item) => item.id === userId);
    setConfirmation({
      key: "change-user-roles",
      title: `Change roles for ${user?.email ?? "this user"}?`,
      description: `Access will change from ${(user?.roles ?? []).join(", ") || "no roles"} to ${roles.join(", ") || "no roles"}.`,
      confirmLabel: "Save role change",
      initialReason: "",
      requireReason: true,
      onConfirm: (confirmedReason) => applyUserRoles(userId, roles, confirmedReason),
    });
  }

  async function applyUserRoles(userId: string, roles: string[], reason: string) {
    try {
      const updated = await client.updateAdminUserRoles(userId, roles, reason);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      await refreshAudit();
    } catch (error) {
      const safeMessage = safeAdminErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function revokeAdminToken(tokenId: string) {
    setMessage(null);
    const token = apiTokens.find((item) => item.id === tokenId);
    setConfirmation({
      key: "revoke-admin-token",
      title: "Revoke this API key?",
      description: `${token?.name ?? "This key"} will stop working immediately for its current user and scopes.`,
      confirmLabel: "Revoke key",
      destructive: true,
      onConfirm: async () => applyAdminTokenRevocation(tokenId),
    });
  }

  async function applyAdminTokenRevocation(tokenId: string) {
    try {
      const token = await client.revokeAdminApiToken(tokenId);
      setApiTokens((current) => current.map((item) => item.id === token.id ? token : item));
      await refreshAudit();
    } catch (error) {
      const safeMessage = safeAdminErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function saveProvider() {
    setMessage(null);
    try {
      const provider = await client.upsertAdminProvider(draft.key, {
        type: draft.type,
        displayName: draft.displayName,
        issuer: optionalDraftValue(draft.issuer),
        clientId: optionalDraftValue(draft.clientId),
        enabled: draft.enabled,
        roleMappings: draft.roleMappings.filter((mapping) => mapping.claim.trim() && mapping.value.trim()),
      });
      setProviders((current) => upsertProvider(current, provider));
      setDraft(providerToDraft(provider));
      await refreshAudit();
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  // Tabs activate on arrow, Home and End. Inactive panels stay mounted and
  // hidden, so an unsaved landing or provider draft survives a tab change.
  function moveTab(event: ReactKeyboardEvent<HTMLDivElement>) {
    const focused = ADMIN_TABS.findIndex((item) => item.id === (event.target as HTMLElement).dataset.tab);
    const from = focused >= 0 ? focused : ADMIN_TABS.findIndex((item) => item.id === tab);
    const last = ADMIN_TABS.length - 1;
    const next = event.key === "ArrowRight" ? (from === last ? 0 : from + 1)
      : event.key === "ArrowLeft" ? (from === 0 ? last : from - 1)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = ADMIN_TABS[next]!.id;
    setTab(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  }

  function closeInvite() {
    setInviteOpen(false);
    setInvitation(null);
    setInviteMessage(null);
    setInviteState("idle");
    inviteTriggerRef.current?.focus();
  }

  const panelProps = (id: AdminTab) => ({
    "aria-labelledby": `${baseId}-${id}-tab`,
    className: "account-panel",
    hidden: tab !== id,
    id: `${baseId}-${id}-panel`,
    role: "tabpanel",
  });
  const activeTokenCount = apiTokens.filter((token) => !token.revokedAt).length;

  return (
    <main className="account-workspace account-admin" aria-label="Admin console">
      <header className="account-page-head">
        <h1 id="admin-console-heading">Admin console</h1>
        <Button size="sm" type="button" variant="outline" onClick={() => void refreshAdmin()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <div className="account-surface">
        <div aria-label="Admin sections" className="account-tabs" role="tablist" onKeyDown={moveTab}>
          {ADMIN_TABS.map((item) => (
            <button
              aria-controls={`${baseId}-${item.id}-panel`}
              aria-selected={tab === item.id}
              className="account-tab"
              data-tab={item.id}
              id={`${baseId}-${item.id}-tab`}
              key={item.id}
              ref={(node) => { if (node) tabRefs.current.set(item.id, node); else tabRefs.current.delete(item.id); }}
              role="tab"
              tabIndex={tab === item.id ? 0 : -1}
              type="button"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {message && (
          <div className="account-notice account-surface-notice" data-tone="amber" role="status">
            <span>{message}</span>
            {state === "error" && <Button size="sm" type="button" variant="outline" onClick={() => void refreshAdmin()}>Retry</Button>}
          </div>
        )}

        <section {...panelProps("people")}>
          <div className="account-panel-head">
            <div>
              <h2>People</h2>
              <p>{adminInitialLoading ? "Loading accounts…" : `${users.length} ${users.length === 1 ? "account" : "accounts"}`}</p>
            </div>
            {session.user.mfaVerified && (
              <Button aria-expanded={inviteOpen} ref={inviteTriggerRef} size="sm" type="button" onClick={() => inviteOpen ? closeInvite() : setInviteOpen(true)}>
                <Mail size={16} aria-hidden="true" />
                Invite user
              </Button>
            )}
          </div>
          {!session.user.mfaVerified && (
            <p className="account-callout" role="status">
              <LockKeyhole size={16} aria-hidden="true" />
              <span>Sign in with MFA before sending registration invitations.</span>
            </p>
          )}
          {session.user.mfaVerified && inviteOpen && (
            <form aria-label="Invite user" className="account-form account-invite" onSubmit={(event) => {
              event.preventDefault();
              void createInvitation();
            }}>
              <label className="account-field">
                <span>Email</span>
                <Input
                  autoComplete="email"
                  disabled={inviteState === "loading"}
                  name="invitation-email"
                  onChange={(event) => setInviteEmail(event.target.value)}
                  required
                  spellCheck={false}
                  type="email"
                  value={inviteEmail}
                />
              </label>
              <label className="account-field">
                <span>Name <small>(optional)</small></span>
                <Input
                  autoComplete="name"
                  disabled={inviteState === "loading"}
                  name="invitation-name"
                  onChange={(event) => setInviteName(event.target.value)}
                  value={inviteName}
                />
              </label>
              <div className="account-actions">
                <Button disabled={inviteState === "loading"} size="sm" type="submit">
                  <Mail size={16} aria-hidden="true" />
                  {inviteState === "loading" ? "Sending invitation…" : "Send invitation"}
                </Button>
                <Button disabled={inviteState === "loading"} size="sm" type="button" variant="outline" onClick={closeInvite}>Cancel</Button>
              </div>
              {invitation && (
                <p className="account-notice" data-tone="teal" role="status">
                  Invitation sent to {invitation.email}. It expires {formatDate(invitation.expiresAt)}.
                </p>
              )}
              {inviteMessage && <p className="account-notice" data-tone="danger" role="status">{inviteMessage}</p>}
            </form>
          )}
          <div className="account-users">
            <div className="account-users-head" aria-hidden="true">
              <span>User</span>
              <span>Status</span>
              <span>Roles</span>
              <span>Actions</span>
            </div>
            {adminInitialLoading && <LoadingRows />}
            <ul aria-label="Accounts" className="account-user-list">
              {users.map((user) => (
                <li className="account-user" key={user.id}>
                  <span className="account-cell-main">
                    <strong>{user.email}</strong>
                    <small>{user.name || user.id}</small>
                  </span>
                  <span className="account-user-status">
                    <span className="account-chip" data-tone={user.status === "active" ? undefined : user.status === "pending" ? "amber" : "danger"}>{formatStatusLabel(user.status)}</span>
                    <small>{user.emailVerified ? "Email verified" : "Email unverified"} · {user.mfaEnabled ? "MFA on" : "No MFA"}</small>
                  </span>
                  <RoleEditor
                    canEditPrivilegedRoles={sessionCanEditPrivilegedRoles}
                    disabled={
                      user.id === session.user.id
                      || user.status === "deleted"
                      || (!sessionCanEditPrivilegedRoles && user.roles.some(isPrivilegedRole))
                    }
                    roles={user.roles}
                    userEmail={user.email}
                    onChange={(roles) => void updateUserRoles(user.id, roles)}
                  />
                  <span className="account-user-actions">
                    {user.status === "pending" && (
                      <Button aria-label="Approve user" size="icon-sm" title="Approve user" type="button" variant="outline" onClick={() => void performUserAction(user.id, "approve")}>
                        <Check size={15} aria-hidden="true" />
                      </Button>
                    )}
                    {user.status === "disabled" && (
                      <Button aria-label="Activate user" size="icon-sm" title="Activate user" type="button" variant="outline" onClick={() => void performUserAction(user.id, "activate")}>
                        <RotateCw size={15} aria-hidden="true" />
                      </Button>
                    )}
                    {user.id !== session.user.id && user.status === "active" && (
                      <Button aria-label="Disable user" size="icon-sm" title="Disable user" type="button" variant="outline" onClick={() => void performUserAction(user.id, "disable")}>
                        <X size={15} aria-hidden="true" />
                      </Button>
                    )}
                    {user.id !== session.user.id && user.status !== "deleted" && (
                      <Button aria-label="Delete user" className="account-danger" size="icon-sm" title="Delete user" type="button" variant="outline" onClick={() => void performUserAction(user.id, "delete")}>
                        <Trash2 size={15} aria-hidden="true" />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section {...panelProps("instance")}>
          <div className="account-panel-head">
            <div><h2>New account sign-ups</h2></div>
          </div>
          {adminInitialLoading ? (
            <LoadingRows />
          ) : (
            <>
              <p className="account-posture"><strong>{registrationPostureTitle(registrationMode)}</strong> {registrationPostureDescription(registrationMode)}</p>
              <div aria-label="Registration mode" className="account-segmented" role="group">
                {(["closed", "request", "open"] as const).map((mode) => (
                  <Button aria-pressed={registrationMode === mode} key={mode} size="sm" type="button" variant="outline" onClick={() => void updateRegistration(mode)}>
                    {capitalize(mode)}
                  </Button>
                ))}
              </div>
            </>
          )}
          <div className="account-panel-head account-panel-divider">
            <div><h2>Landing page</h2><p>First visit to this instance</p></div>
          </div>
          <LandingSettings key={`${session.user.id}:${session.expiresAt}`} client={client} canEdit={session.user.mfaVerified} onSaved={() => { void refreshAudit().catch(() => setMessage("Landing setting saved. Refresh to load the audit history.")); }} />
        </section>

        <section {...panelProps("github")}>
          <div className="account-panel-head"><div><h2>GitHub</h2><p>Authenticated source checks for users and organization instances</p></div></div>
          {client.github && <GithubSettings key={`${session.user.id}:${session.expiresAt}`} api={client.github} canEdit={session.user.mfaVerified} onSaved={() => { void refreshAudit().catch(() => setMessage("GitHub settings changed. Refresh to load the audit history.")); }} />}
        </section>

        <section {...panelProps("branding")}>
          <div className="account-panel-head"><div><h2>Branding</h2><p>The logo and name shown to everyone, including visitors</p></div></div>
          <BrandingSettings key={`${session.user.id}:${session.expiresAt}`} client={client} canEdit={session.user.mfaVerified} onSaved={() => { void refreshAudit().catch(() => setMessage("Branding saved. Refresh to load the audit history.")); }} />
        </section>

        <section {...panelProps("keys")}>
          <div className="account-panel-head">
            <div><h2 id={`${baseId}-keys-heading`}>API keys</h2><p>{activeTokenCount} active</p></div>
          </div>
          {adminInitialLoading && <LoadingRows />}
          {apiTokens.length > 0 && (
            <ul aria-labelledby={`${baseId}-keys-heading`} className="account-token-list">
              {apiTokens.map((token) => (
                <li className="account-token" key={token.id}>
                  <span className="account-cell-main">
                    <strong>{token.name}</strong>
                    <small>{token.user.email} · <code>{token.tokenPrefix}…</code></small>
                  </span>
                  <span className="account-chip" data-tone={token.revokedAt ? "danger" : undefined}>{token.revokedAt ? "Revoked" : "Active"}</span>
                  <small className="account-token-meta">{token.scopes.join(", ")} · Expires {formatDate(token.expiresAt)}</small>
                  <Button aria-label={`Revoke ${token.name}`} className="account-danger" disabled={Boolean(token.revokedAt)} size="icon-sm" title={`Revoke ${token.name}`} type="button" variant="outline" onClick={() => void revokeAdminToken(token.id)}>
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {state === "ready" && apiTokens.length === 0 && <p className="account-muted">No API keys. User-created keys appear here for monitoring and revocation.</p>}
        </section>

        <section {...panelProps("providers")}>
          <div className="account-panel-head">
            <div><h2>Sign-in providers</h2><p>{providers.length} configured</p></div>
          </div>
          {adminInitialLoading ? (
            <LoadingRows />
          ) : (
            <div className="account-providers">
              <div className="account-provider-list">
                <Button size="sm" type="button" variant="outline" onClick={() => setDraft(emptyProviderDraft())}>
                  <Plus size={15} aria-hidden="true" />
                  New provider
                </Button>
                {providers.map((provider) => (
                  <button
                    aria-current={provider.key === draft.key ? "true" : undefined}
                    className="account-provider"
                    key={provider.key}
                    type="button"
                    onClick={() => setDraft(providerToDraft(provider))}
                  >
                    <span className="account-cell-main">
                      <strong>{provider.displayName}</strong>
                      <small>{provider.key}</small>
                    </span>
                    <span className="account-chip" data-tone={provider.enabled ? "teal" : undefined}>{provider.enabled ? "Enabled" : "Disabled"}</span>
                  </button>
                ))}
              </div>
              <form className="account-form account-provider-form" onSubmit={(event) => {
                event.preventDefault();
                void saveProvider();
              }}>
                <div className="account-field-grid">
                  <label className="account-field">
                    <span>Key</span>
                    <Input value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
                  </label>
                  <label className="account-field">
                    <span>Type</span>
                    <select className="account-select" value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ProviderDraft["type"] })}>
                      <option value="oidc">OIDC</option>
                      <option value="saml">SAML</option>
                      <option value="cloudflare_access">Cloudflare Access</option>
                      <option value="github">GitHub</option>
                      <option value="google">Google</option>
                    </select>
                  </label>
                  <label className="account-field">
                    <span>Display name</span>
                    <Input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
                  </label>
                  <label className="account-field">
                    <span>Issuer</span>
                    <Input value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} />
                  </label>
                  <label className="account-field">
                    <span>Client ID</span>
                    <Input value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} />
                  </label>
                </div>
                <label className="account-check">
                  <input checked={draft.enabled} type="checkbox" onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                  <span>Enabled</span>
                </label>
                <fieldset className="account-mappings">
                  <legend>Role mappings</legend>
                  {draft.roleMappings.map((mapping, index) => (
                    <div className="account-mapping" key={index}>
                      <Input
                        aria-label={`Mapping ${index + 1} claim`}
                        placeholder="Claim"
                        value={mapping.claim}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { claim: event.target.value })}
                      />
                      <Input
                        aria-label={`Mapping ${index + 1} value`}
                        placeholder="Value"
                        value={mapping.value}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { value: event.target.value })}
                      />
                      <select
                        aria-label={`Mapping ${index + 1} role`}
                        className="account-select"
                        value={mapping.role}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { role: event.target.value })}
                      >
                        <option value="user">User</option>
                        <option value="author">Author</option>
                        <option value="maintainer">Maintainer</option>
                      </select>
                      <Button aria-label={`Remove mapping ${index + 1}`} size="icon-sm" title={`Remove mapping ${index + 1}`} type="button" variant="outline" onClick={() => setDraft({
                        ...draft,
                        roleMappings: draft.roleMappings.filter((_, itemIndex) => itemIndex !== index),
                      })}>
                        <Trash2 size={14} aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" type="button" variant="outline" onClick={() => setDraft({
                    ...draft,
                    roleMappings: [...draft.roleMappings, { claim: "", value: "", role: "user" }],
                  })}>
                    <Plus size={15} aria-hidden="true" />
                    Add
                  </Button>
                </fieldset>
                <div className="account-actions">
                  <Button size="sm" type="submit">
                    <Save size={16} aria-hidden="true" />
                    Save provider
                  </Button>
                </div>
              </form>
            </div>
          )}
        </section>

        <section {...panelProps("audit")}>
          <div className="account-panel-head">
            <div><h2>Audit</h2><p>{auditEvents.length} loaded</p></div>
          </div>
          <div className="audit-list account-audit">
            {adminInitialLoading && <LoadingRows />}
            {auditEvents.map((event) => (
              <div className="audit-row" key={event.id}>
                <span className="account-chip" data-tone={event.decision === "allow" ? "teal" : "danger"}>{formatStatusLabel(event.decision)}</span>
                <span className="account-cell-main">
                  <strong>{event.action}</strong>
                  <small>{event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ""}</small>
                </span>
                <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
              </div>
            ))}
            {auditCursor && (
              <div className="account-actions">
                <Button disabled={loadingAudit} size="sm" type="button" variant="outline" onClick={() => void loadMoreAudit()}>{loadingAudit ? "Loading more events…" : "Load more audit events"}</Button>
              </div>
            )}
            {state === "ready" && auditEvents.length === 0 && <p className="account-muted">No audit events.</p>}
          </div>
        </section>
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function SidebarAccount({
  collapsed,
  onLogout,
  onSettings,
  session,
}: {
  collapsed: boolean;
  onLogout: () => Promise<void>;
  onSettings: () => void;
  session: WebSession;
}) {
  return (
    <div className={collapsed ? "sidebar-account collapsed" : "sidebar-account"}>
      <a className="sidebar-account-main" href="/settings" aria-label="Account settings" aria-description={session.user.mfaVerified ? "MFA verified" : "MFA not verified. Set up or verify MFA."} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        onSettings();
      }} title={session.user.email}>
        {session.user.mfaVerified ? (
          <ShieldCheck className="sidebar-account-status" data-verified="true" size={20} role="img" aria-label="MFA verified" />
        ) : (
          <CircleAlert className="sidebar-account-status" size={20} role="img" aria-label="MFA not verified" />
        )}
        <span>
          <strong>{session.user.email}</strong>
          <small>{session.user.roles.join(" · ") || "user"}</small>
          {!session.user.mfaVerified && <small className="sidebar-account-warning">MFA unverified</small>}
        </span>
      </a>
      <IconButton label="Sign out" onClick={() => void onLogout()}>
        <LogOut size={15} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function AuthTokenPage({
  client,
  kind,
  onHome,
  onLogin,
}: {
  client: RegistryClient;
  kind: "reset-password" | "verify-email" | "change-email";
  onHome: () => void;
  onLogin: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<LoadState>(kind === "reset-password" ? "idle" : "loading");
  const [message, setMessage] = useState<string | null>(null);
  const token = useMemo(() => authActionTokenFromLocation(), []);

  useEffect(() => {
    if (kind === "reset-password") {
      return;
    }
    let active = true;
    async function confirmToken() {
      setState("loading");
      setMessage(null);
      if (!token) {
        setState("error");
        setMessage("This verification link is missing its token.");
        return;
      }
      try {
        if (kind === "verify-email") {
          await client.confirmEmailVerification({ token });
          if (active) {
            setMessage("Email verified. You can log in after your account is approved.");
          }
        } else {
          await client.confirmEmailChange({ token });
          if (active) {
            setMessage("Email changed. Sign in again with the new address.");
          }
        }
        if (active) {
          setState("ready");
        }
      } catch (error) {
        if (active) {
          setState("error");
          setMessage(safeAccountErrorMessage(error));
        }
      }
    }
    void confirmToken();
    return () => {
      active = false;
    };
  }, [client, kind, token]);

  async function resetPassword() {
    setMessage(null);
    if (!token) {
      setState("error");
      setMessage("This reset link is missing its token.");
      return;
    }
    if (password !== confirmPassword) {
      setState("error");
      setMessage("Passwords do not match.");
      return;
    }
    const passwordError = newPasswordByteError(password);
    if (passwordError) {
      setState("error");
      setMessage(passwordError);
      return;
    }
    setState("loading");
    try {
      await client.confirmPasswordReset({ token, password });
      setPassword("");
      setConfirmPassword("");
      setState("ready");
      setMessage("Password reset. You can log in with the new password.");
    } catch (error) {
      setState("error");
      setMessage(safeAccountErrorMessage(error));
    }
  }

  const heading = kind === "reset-password"
    ? "Reset password"
    : kind === "verify-email"
      ? "Verify email"
      : "Confirm email change";

  return (
    <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main className="login-page" id="main-content">
      <nav className="login-nav" aria-label="Account action navigation">
        <a className="landing-brand" href="/" onClick={(event) => handleCallbackLink(event, onHome)}>
          <BrandIdentity horizontal />
        </a>
        <Button asChild className="login-back shadcn-action-button" size="sm" variant="outline">
          <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>Login</a>
        </Button>
      </nav>
      <section className="login-panel" aria-labelledby="auth-token-heading">
        <p className="landing-status">Public beta. Account action required.</p>
        <h1 id="auth-token-heading">{heading}</h1>
        {kind === "reset-password" ? (
          <form className="auth-widget auth-form" onSubmit={(event) => {
            event.preventDefault();
            void resetPassword();
          }}>
            <label className="auth-field">
              <span>New password</span>
              <Input
                className="auth-input"
                aria-label="New password"
                autoComplete="new-password"
                disabled={state === "loading"}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <Input
                className="auth-input"
                aria-label="Confirm password"
                autoComplete="new-password"
                disabled={state === "loading"}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                value={confirmPassword}
              />
            </label>
            <Button className="shadcn-action-button" disabled={state === "loading" || !password || !confirmPassword} size="sm" type="submit">
              <KeyRound size={16} aria-hidden="true" />
              Save password
            </Button>
          </form>
        ) : (
          <div className={state === "error" ? "safe-message compact-message" : "success-message compact-message"} role="status" aria-live="polite">
            {state === "loading" ? "Confirming link…" : message}
          </div>
        )}
        {kind === "reset-password" && <AuthMessage message={message} />}
        {state === "ready" && (
          <Button asChild className="save-button shadcn-action-button" size="sm">
            <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>
              <LogIn size={16} aria-hidden="true" />
              Login
            </a>
          </Button>
        )}
      </section>
    </main>
    </>
  );
}

function AccountSettings({
  client,
  onSessionInvalidated,
  session,
}: {
  client: RegistryClient;
  onSessionInvalidated: (message: string) => void;
  session: WebSession;
}) {
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [apiTokens, setApiTokens] = useState<ApiToken[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  // Each message belongs to one settings row and renders under that row's action.
  const [notice, setNotice] = useState<{ scope: AccountScope; text: string; tone: "danger" | "teal" } | null>(null);
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [mfaPassword, setMfaPassword] = useState("");
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [mfaRemovalOpen, setMfaRemovalOpen] = useState(false);
  const removeMfaRef = useRef<HTMLButtonElement>(null);
  const focusRemoval = useRef<"password" | "trigger" | null>(null);
  const baseId = useId();
  const [apiTokenName, setApiTokenName] = useState("");
  const [apiTokenScopes, setApiTokenScopes] = useState<ApiTokenScope[]>(["skills:read"]);
  const [apiTokenExpiresAt, setApiTokenExpiresAt] = useState("");
  const [apiTokenExpiryError, setApiTokenExpiryError] = useState<string | null>(null);
  const [createdApiToken, setCreatedApiToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const tokenExpiryBounds = useMemo(() => apiTokenExpiryBounds(), []);

  async function refreshAccountSecurity() {
    setNotice((current) => current?.scope === "load" ? null : current);
    try {
      const [nextMfaStatus, nextApiTokens] = await Promise.all([
        client.getMfaStatus(),
        client.listApiTokens(),
      ]);
      setMfaStatus(nextMfaStatus);
      setApiTokens(nextApiTokens);
      setState("ready");
    } catch (error) {
      setNotice({ scope: "load", text: safeAccountErrorMessage(error), tone: "danger" });
      setState("error");
    }
  }

  useEffect(() => {
    void refreshAccountSecurity();
  }, [client]);

  useEffect(() => {
    const target = focusRemoval.current;
    if (!target) return;
    const element = target === "password" ? document.getElementById(`${baseId}-mfa-removal`) : removeMfaRef.current;
    if (!element) return;
    focusRemoval.current = null;
    element.focus();
  });

  async function submitPasswordChange(input?: { currentPassword: string; password: string; confirmPassword: string }) {
    setNotice(null);
    const passwordInput = input ?? {
      currentPassword,
      password: newPassword,
      confirmPassword: confirmNewPassword,
    };
    if (passwordInput.password !== passwordInput.confirmPassword) {
      setNotice({ scope: "password", text: "Passwords do not match.", tone: "danger" });
      return;
    }
    const passwordError = newPasswordByteError(passwordInput.password);
    if (passwordError) {
      setNotice({ scope: "password", text: passwordError, tone: "danger" });
      return;
    }
    setState("loading");
    try {
      await client.changePassword({ currentPassword: passwordInput.currentPassword, password: passwordInput.password });
      onSessionInvalidated("Password changed. Sign in again with the new password.");
    } catch (error) {
      setState("error");
      setNotice({ scope: "password", text: safeAccountErrorMessage(error), tone: "danger" });
    }
  }

  async function submitEmailChange(input?: { email: string; password: string }) {
    setNotice(null);
    setState("loading");
    try {
      const emailInput = input ?? { email, password: emailPassword };
      await client.requestEmailChange({ email: emailInput.email, password: emailInput.password });
      setEmail("");
      setEmailPassword("");
      setState("ready");
      setNotice({ scope: "email", text: "Verification email sent. Confirm the new address to complete the change.", tone: "teal" });
    } catch (error) {
      setState("error");
      setNotice({ scope: "email", text: safeAccountErrorMessage(error), tone: "danger" });
    }
  }

  function openMfaRemoval() {
    setMfaRemovalOpen(true);
    focusRemoval.current = "password";
  }

  function closeMfaRemoval() {
    setMfaRemovalOpen(false);
    setMfaPassword("");
    focusRemoval.current = "trigger";
  }

  function requestMfaRemoval(password: string) {
    setConfirmation({
      key: "remove-mfa",
      title: "Remove MFA from this account?",
      description: "This weakens sign-in protection and ends the current session. You will need to sign in again.",
      confirmLabel: "Remove MFA",
      destructive: true,
      onConfirm: async () => removeMfa(password),
    });
  }

  async function removeMfa(password: string) {
    setNotice(null);
    setState("loading");
    try {
      await client.disableTotpMfa({ password });
      onSessionInvalidated("MFA removed. Sign in again to continue.");
    } catch (error) {
      setState("error");
      const safeMessage = safeAccountErrorMessage(error);
      setNotice({ scope: "mfa", text: safeMessage, tone: "danger" });
      throw new Error(safeMessage);
    }
  }

  async function createAccountApiToken() {
    setNotice(null);
    setCreatedApiToken(null);
    const expiry = validateApiTokenExpiry(apiTokenExpiresAt);
    if (!expiry.valid) {
      setApiTokenExpiryError(expiry.message);
      setState("ready");
      return;
    }
    setApiTokenExpiryError(null);
    setState("loading");
    try {
      const token = await client.createApiToken({
        name: apiTokenName,
        scopes: apiTokenScopes,
        expiresAt: expiry.iso,
      });
      setCreatedApiToken(token.token);
      setApiTokens(await client.listApiTokens());
      setApiTokenName("");
      setApiTokenExpiresAt("");
      setState("ready");
    } catch (error) {
      setState("error");
      setNotice({ scope: "tokens", text: safeAccountErrorMessage(error), tone: "danger" });
    }
  }

  async function revokeAccountApiToken(tokenId: string) {
    setNotice(null);
    const token = apiTokens.find((item) => item.id === tokenId);
    setConfirmation({
      key: "revoke-account-token",
      title: "Revoke this API key?",
      description: `${token?.name ?? "This key"} will stop working immediately for all assigned scopes.`,
      confirmLabel: "Revoke key",
      destructive: true,
      onConfirm: async () => applyAccountTokenRevocation(tokenId),
    });
  }

  async function applyAccountTokenRevocation(tokenId: string) {
    setState("loading");
    try {
      const token = await client.revokeApiToken(tokenId);
      setApiTokens((current) => current.map((item) => item.id === token.id ? token : item));
      setState("ready");
    } catch (error) {
      setState("error");
      const safeMessage = safeAccountErrorMessage(error);
      setNotice({ scope: "tokens", text: safeMessage, tone: "danger" });
      throw new Error(safeMessage);
    }
  }

  const mfaEnabled = Boolean(mfaStatus?.totpEnabled);
  const accountInitialLoading = state === "loading" && mfaStatus === null;
  const recoveryCodes = mfaStatus?.recoveryCodesRemaining ?? 0;
  const roleLabel = session.user.roles.map(formatStatusLabel).join(", ") || "User";
  const rowNotice = (scope: AccountScope) => notice?.scope === scope
    ? <p className="account-notice" data-tone={notice.tone} role="status">{notice.text}</p>
    : null;

  return (
    <main className="account-workspace account-settings" aria-label="Account settings">
      <header className="account-page-head">
        <div>
          <h1>Security and access</h1>
          <p>{session.user.email} · {roleLabel} · {session.user.emailVerified ? "Email verified" : "Email not verified"}</p>
        </div>
      </header>

      {!accountInitialLoading && mfaEnabled && !session.user.mfaVerified && (
        <section className="account-banner" role="status" aria-live="polite">
          <CircleAlert size={20} aria-hidden="true" />
          <div>
            <strong>MFA is enabled, but this session is not MFA verified.</strong>
            <p>Privileged owner workflows remain locked until the next MFA sign-in.</p>
          </div>
          <Button size="sm" type="button" variant="outline" onClick={() => onSessionInvalidated("Sign in with MFA to continue.")}>
            <LogIn size={16} aria-hidden="true" />
            Sign in with MFA
          </Button>
        </section>
      )}

      <div className="account-surface">
        {notice?.scope === "load" && (
          <div className="account-notice account-surface-notice" data-tone="danger" role="status">
            <span>{notice.text}</span>
            <Button size="sm" type="button" variant="outline" onClick={() => { setState("loading"); void refreshAccountSecurity(); }}>Retry</Button>
          </div>
        )}

        <section aria-labelledby={`${baseId}-email`} className="account-row">
          <div className="account-row-intro">
            <h2 id={`${baseId}-email`}>Email</h2>
            <p>The new address must be verified before it replaces the current one.</p>
          </div>
          <form className="account-form account-row-body" onSubmit={(event) => {
            event.preventDefault();
            const formData = new window.FormData(event.currentTarget);
            void submitEmailChange({
              email: String(formData.get("new-email") ?? ""),
              password: String(formData.get("email-current-password") ?? ""),
            });
          }}>
            <label className="account-field">
              <span>New email</span>
              <Input
                aria-label="New email"
                autoComplete="email"
                name="new-email"
                onChange={(event) => setEmail(event.target.value)}
                onInput={(event) => setEmail(event.currentTarget.value)}
                required
                type="email"
                value={email}
              />
            </label>
            <label className="account-field">
              <span>Current password</span>
              <Input
                aria-describedby={`${baseId}-email-password-help`}
                autoComplete="current-password"
                name="email-current-password"
                onChange={(event) => setEmailPassword(event.target.value)}
                onInput={(event) => setEmailPassword(event.currentTarget.value)}
                required
                type="password"
                value={emailPassword}
              />
            </label>
            <small className="account-hint" id={`${baseId}-email-password-help`}>Required for account identity changes.</small>
            <div className="account-actions">
              <Button disabled={state === "loading"} size="sm" type="submit">
                <Mail size={16} aria-hidden="true" />
                Send verification
              </Button>
            </div>
            {rowNotice("email")}
          </form>
        </section>

        <section aria-labelledby={`${baseId}-password`} className="account-row">
          <div className="account-row-intro">
            <h2 id={`${baseId}-password`}>Password</h2>
            <p>Changing the password ends this session. Sign in again with the new password.</p>
          </div>
          <form className="account-form account-row-body" onSubmit={(event) => {
            event.preventDefault();
            const formData = new window.FormData(event.currentTarget);
            void submitPasswordChange({
              currentPassword: String(formData.get("current-password") ?? ""),
              password: String(formData.get("new-password") ?? ""),
              confirmPassword: String(formData.get("confirm-new-password") ?? ""),
            });
          }}>
            <label className="account-field">
              <span>Current password</span>
              <Input
                autoComplete="current-password"
                name="current-password"
                onChange={(event) => setCurrentPassword(event.target.value)}
                onInput={(event) => setCurrentPassword(event.currentTarget.value)}
                required
                type="password"
                value={currentPassword}
              />
            </label>
            <label className="account-field">
              <span>New password</span>
              <Input
                aria-label="New password"
                autoComplete="new-password"
                name="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
                onInput={(event) => setNewPassword(event.currentTarget.value)}
                required
                type="password"
                value={newPassword}
              />
            </label>
            <label className="account-field">
              <span>Confirm new password</span>
              <Input
                aria-label="Confirm new password"
                autoComplete="new-password"
                name="confirm-new-password"
                onChange={(event) => setConfirmNewPassword(event.target.value)}
                onInput={(event) => setConfirmNewPassword(event.currentTarget.value)}
                required
                type="password"
                value={confirmNewPassword}
              />
            </label>
            <div className="account-actions">
              <Button disabled={state === "loading"} size="sm" type="submit">
                <Save size={16} aria-hidden="true" />
                Change password
              </Button>
            </div>
            {rowNotice("password")}
          </form>
        </section>

        {client.github && <GithubAccountConnection key={`${session.user.id}:${session.expiresAt}`} api={client.github} />}

        <section aria-labelledby={`${baseId}-mfa`} className="account-row">
          <div className="account-row-intro">
            <h2 id={`${baseId}-mfa`}>MFA</h2>
            <p>An authenticator app code at sign-in. Privileged owner workflows need an MFA-verified session.</p>
          </div>
          <div className="account-row-body">
            {accountInitialLoading ? (
              <LoadingRows />
            ) : mfaStatus === null ? (
              <p className="account-muted">MFA status could not be loaded.</p>
            ) : (
              <>
                <p className="account-status-line">
                  <strong>{mfaEnabled ? "Authenticator app MFA is enabled." : "Authenticator app MFA is not set."}</strong>
                  <span>
                    {mfaEnabled
                      ? `${recoveryCodes} recovery ${recoveryCodes === 1 ? "code" : "codes"} left.${session.user.mfaVerified ? " This session is MFA verified." : ""}`
                      : "Enter your current password to start setup."}
                  </span>
                </p>
                {mfaEnabled && (
                  <div className="account-actions">
                    <Button aria-expanded={mfaSetupOpen} size="sm" type="button" variant="outline" onClick={() => setMfaSetupOpen((open) => !open)}>
                      <RotateCw size={16} aria-hidden="true" />
                      Reset authenticator
                    </Button>
                    {!mfaRemovalOpen && (
                      <Button className="account-danger" ref={removeMfaRef} size="sm" type="button" variant="outline" onClick={openMfaRemoval}>
                        <X size={16} aria-hidden="true" />
                        Remove MFA
                      </Button>
                    )}
                  </div>
                )}
                {mfaEnabled && mfaRemovalOpen && (
                  <form className="account-form account-inline-form" onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    closeMfaRemoval();
                  }} onSubmit={(event) => {
                    event.preventDefault();
                    const formData = new window.FormData(event.currentTarget);
                    requestMfaRemoval(String(formData.get("mfa-removal-password") ?? ""));
                  }}>
                    <label className="account-field">
                      <span>Password for MFA removal</span>
                      <Input
                        aria-label="Password for MFA removal"
                        autoComplete="current-password"
                        id={`${baseId}-mfa-removal`}
                        name="mfa-removal-password"
                        onChange={(event) => setMfaPassword(event.target.value)}
                        onInput={(event) => setMfaPassword(event.currentTarget.value)}
                        required
                        type="password"
                        value={mfaPassword}
                      />
                    </label>
                    <div className="account-actions">
                      <Button disabled={state === "loading"} size="sm" type="submit" variant="destructive">
                        <X size={16} aria-hidden="true" />
                        Remove MFA
                      </Button>
                      <Button size="sm" type="button" variant="outline" onClick={closeMfaRemoval}>Cancel</Button>
                    </div>
                  </form>
                )}
                {(!mfaEnabled || mfaSetupOpen) && (
                  <MfaSetupPanel
                    client={client}
                    onComplete={(result) => {
                      setMfaStatus({
                        totpEnabled: true,
                        recoveryCodesRemaining: result.recoveryCodes.length,
                        factors: [result.factor],
                      });
                      setMfaSetupOpen(true);
                    }}
                    session={session}
                  />
                )}
                {rowNotice("mfa")}
                <p className="account-muted">Passkeys are not available yet.</p>
              </>
            )}
          </div>
        </section>

        <section aria-labelledby={`${baseId}-keys`} className="account-row">
          <div className="account-row-intro">
            <h2 id={`${baseId}-keys`}>API keys</h2>
            <p>Scoped keys for the CLI, MCP clients and automation. A new key is shown only once.</p>
          </div>
          <div className="account-row-body">
            <form className="account-form" noValidate onSubmit={(event) => {
              event.preventDefault();
              void createAccountApiToken();
            }}>
              <label className="account-field">
                <span>Key name</span>
                <Input
                  aria-label="Key name"
                  name="api-token-name"
                  onChange={(event) => setApiTokenName(event.target.value)}
                  onInput={(event) => setApiTokenName(event.currentTarget.value)}
                  placeholder="CLI or MCP client"
                  value={apiTokenName}
                />
              </label>
              <label className="account-field">
                <span>Expires at</span>
                <Input
                  aria-label="Expires at"
                  aria-describedby="api-token-expiry-help api-token-expiry-error"
                  aria-invalid={Boolean(apiTokenExpiryError)}
                  autoComplete="off"
                  max={tokenExpiryBounds.max}
                  min={tokenExpiryBounds.min}
                  name="api-token-expires-at"
                  onChange={(event) => {
                    setApiTokenExpiresAt(event.target.value);
                    setApiTokenExpiryError(null);
                  }}
                  onInput={(event) => {
                    setApiTokenExpiresAt(event.currentTarget.value);
                    setApiTokenExpiryError(null);
                  }}
                  type="datetime-local"
                  value={apiTokenExpiresAt}
                />
                <small id="api-token-expiry-help">Optional. Choose a future expiry no more than 1 year away; blank uses the 90-day default.</small>
                {apiTokenExpiryError && <small className="field-error" id="api-token-expiry-error" role="alert">{apiTokenExpiryError}</small>}
              </label>
              <fieldset className="account-scopes">
                <legend>API key scopes</legend>
                {API_TOKEN_SCOPE_OPTIONS.map((option) => (
                  <label className="account-check" key={option.scope}>
                    <input
                      checked={apiTokenScopes.includes(option.scope)}
                      onChange={() => setApiTokenScopes((current) => toggleApiTokenScope(current, option.scope))}
                      type="checkbox"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
              <div className="account-actions">
                <Button disabled={state === "loading" || !apiTokenName.trim() || apiTokenScopes.length === 0} size="sm" type="submit">
                  <KeyRound size={16} aria-hidden="true" />
                  Create key
                </Button>
              </div>
              {rowNotice("tokens")}
            </form>
            {createdApiToken && (
              <div className="account-reveal" role="status">
                <span>Copy this key now. It will not be shown again.</span>
                <code>{createdApiToken}</code>
                <CopyButton text={createdApiToken} />
              </div>
            )}
            {accountInitialLoading ? <LoadingRows /> : <TokenList tokens={apiTokens} onRevoke={(tokenId) => void revokeAccountApiToken(tokenId)} />}
          </div>
        </section>
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

type AccountScope = "load" | "email" | "password" | "mfa" | "tokens";

function TokenList({ tokens, onRevoke }: { tokens: ApiToken[]; onRevoke: (tokenId: string) => void }) {
  if (tokens.length === 0) return <p className="account-muted">No API keys. Create a scoped key for CLI, MCP, or automation access.</p>;
  return (
    <ul aria-label="Your API keys" className="account-token-list">
      {tokens.map((token) => (
        <li className="account-token" key={token.id}>
          <span className="account-cell-main">
            <strong>{token.name}</strong>
            <small><code>{token.tokenPrefix}…</code> · {token.scopes.join(", ")}</small>
          </span>
          <span className="account-chip" data-tone={token.revokedAt ? "danger" : undefined}>{token.revokedAt ? "Revoked" : "Active"}</span>
          <small className="account-token-meta">Expires {formatDate(token.expiresAt)} · {token.lastUsedAt ? `Used ${formatDate(token.lastUsedAt)}` : "Never used"}</small>
          <Button aria-label={`Revoke ${token.name}`} className="account-danger" disabled={Boolean(token.revokedAt)} size="icon-sm" title={`Revoke ${token.name}`} type="button" variant="outline" onClick={() => onRevoke(token.id)}>
            <Trash2 size={15} aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function IconButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function CopyButton({
  className = "shadcn-action-button",
  failureHint,
  iconOnly = false,
  label = "Copy",
  selectOnFailure,
  text,
  variant,
}: {
  className?: string;
  /** Visible text after a failed copy. Without it the failure is only announced. */
  failureHint?: string;
  iconOnly?: boolean;
  /** Visible label, or the accessible name of an icon-only button. */
  label?: string;
  /** Element whose text is selected for manual copying when the clipboard fails. */
  selectOnFailure?: RefObject<HTMLElement | null>;
  text: string;
  variant?: "outline" | "ghost";
}) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  async function copy() {
    setStatus("copying");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
      const target = selectOnFailure?.current;
      const selection = window.getSelection();
      if (target && selection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  return (
    <>
      <Button
        aria-label={iconOnly ? label : undefined}
        className={className}
        disabled={status === "copying"}
        size={iconOnly ? "icon-sm" : "sm"}
        title={iconOnly ? label : undefined}
        type="button"
        variant={variant}
        onClick={() => void copy()}
      >
        {iconOnly && status === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {!iconOnly && (status === "copying" ? "Copying…" : status === "copied" ? "Copied" : label)}
      </Button>
      {failureHint && status === "error" && <span className="registry-copy-failure">{failureHint}</span>}
      <span className="sr-only" role="status" aria-live="polite">
        {status === "copied" ? "Copied to clipboard." : status === "error" ? "Copy failed. Select and copy the text manually." : ""}
      </span>
    </>
  );
}


function RoleEditor({
  canEditPrivilegedRoles,
  disabled,
  onChange,
  roles,
  userEmail,
}: {
  canEditPrivilegedRoles: boolean;
  disabled: boolean;
  onChange: (roles: string[]) => void;
  roles: string[];
  userEmail: string;
}) {
  return (
    <div aria-label={`Roles for ${userEmail}`} className="role-editor" role="group">
      {ADMIN_ROLE_OPTIONS.map((role) => {
        const privilegedRole = role === "owner" || role === "admin";
        const removingLastRole = roles.length === 1 && roles.includes(role);
        const roleDisabled = disabled || removingLastRole || (privilegedRole && !canEditPrivilegedRoles);
        return (
          <label className="role-toggle" key={role}>
            <input
              aria-label={`Set ${userEmail} ${role} role`}
              checked={roles.includes(role)}
              disabled={roleDisabled}
              onChange={() => onChange(toggleRole(roles, role))}
              type="checkbox"
            />
            <span>{formatStatusLabel(role)}</span>
          </label>
        );
      })}
    </div>
  );
}

function StatusToken({ value }: { value?: string }) {
  const statusValue = value ?? "unknown";
  return <span className={`status-token status-token-${statusValue}`}>{formatStatusLabel(statusValue)}</span>;
}

function formatStatusLabel(value: string) {
  const label = value.replace(/[-_]+/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function AuthWidget({
  authMessage,
  authState,
  client,
  mfaPending,
  onLogin,
  onLogout,
  onPasswordReset,
  onResetModeChange,
  onVerifyMfa,
  resetMode,
  session,
}: {
  authMessage: string | null;
  authState: AuthState;
  client?: RegistryClient;
  mfaPending: MfaPending | null;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  onPasswordReset?: (input: { email: string }) => Promise<void>;
  onResetModeChange: (resetMode: boolean) => void;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
  resetMode: boolean;
  session: WebSession | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const step = mfaPending ? "mfa" : resetMode && onPasswordReset ? "reset" : "login";
  const previousStep = useRef(step);
  const backToLogin = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const mfaCodeRef = useRef<HTMLInputElement>(null);
  const resetEmailRef = useRef<HTMLInputElement>(null);
  const forgotRef = useRef<HTMLButtonElement>(null);

  // Focus moves only when the step changes, never on a keystroke: to the
  // step's first field, or back to "Forgot password?" after "Back to login".
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const target = step === "mfa" ? mfaCodeRef.current
      : step === "reset" ? resetEmailRef.current
        : backToLogin.current ? forgotRef.current
          : emailRef.current;
    backToLogin.current = false;
    target?.focus();
  }, [step]);

  useEffect(() => {
    if (!session || !client) {
      setMfaStatus(null);
      setMfaSetupOpen(false);
      return;
    }
    let active = true;
    client.getMfaStatus()
      .then((status) => {
        if (active) {
          setMfaStatus(status);
        }
      })
      .catch(() => {
        if (active) {
          setMfaStatus(null);
        }
      });
    return () => {
      active = false;
    };
  }, [client, session?.expiresAt]);

  if (session) {
    const mfaEnabled = Boolean(mfaStatus?.totpEnabled || session.user.mfaVerified);
    return (
      <div className="auth-shell">
        <div className="auth-widget signed-in" aria-label="Authenticated user">
          <UserRound size={17} aria-hidden="true" />
          <span>
            <strong>{session.user.email}</strong>
            <small>
              {session.user.roles.join(", ") || "user"} · {session.user.mfaVerified ? "MFA verified" : mfaEnabled ? "MFA enabled" : "MFA not set"}
            </small>
          </span>
          {!mfaEnabled && (
            <Button className="shadcn-action-button" size="icon-sm" type="button" variant="outline" onClick={() => setMfaSetupOpen((open) => !open)} aria-label="Set up MFA">
              <ShieldCheck size={16} aria-hidden="true" />
            </Button>
          )}
          <Button className="shadcn-action-button" size="icon-sm" type="button" variant="outline" onClick={() => void onLogout()} aria-label="Sign out">
            <LogOut size={16} aria-hidden="true" />
          </Button>
        </div>
        {mfaSetupOpen && client && (
          <MfaSetupPanel
            client={client}
            onComplete={(result) => {
              setMfaStatus({
                totpEnabled: true,
                recoveryCodesRemaining: result.recoveryCodes.length,
                factors: [result.factor],
              });
            }}
            session={session}
          />
        )}
      </div>
    );
  }

  if (mfaPending) {
    return (
      <form className="auth-widget auth-form" onSubmit={(event) => {
        event.preventDefault();
        void onVerifyMfa(mfaCode).finally(() => setMfaCode(""));
      }}>
        <label className="auth-field">
          <span>Verification code</span>
          <Input
            className="auth-input"
            aria-label="MFA code"
            autoComplete="one-time-code"
            disabled={authState === "loading"}
            inputMode="numeric"
            name="mfa-code"
            onChange={(event) => setMfaCode(event.target.value)}
            placeholder="123456"
            ref={mfaCodeRef}
            spellCheck={false}
            value={mfaCode}
          />
        </label>
        <p className="auth-help">Use your authenticator app or recovery code for {mfaPending.email}.</p>
        <Button className="shadcn-action-button" disabled={authState === "loading" || !mfaCode.trim()} size="sm" type="submit">
          <ShieldCheck size={16} aria-hidden="true" />
          Verify
        </Button>
        <AuthMessage message={authMessage ?? mfaPending.email} />
      </form>
    );
  }

  if (resetMode && onPasswordReset) {
    return (
      <form className="auth-widget auth-form" onSubmit={(event) => {
        event.preventDefault();
        void onPasswordReset({ email }).then(() => onResetModeChange(false));
      }}>
        <label className="auth-field">
          <span>Email</span>
          <Input
            className="auth-input"
            aria-label="Reset email"
            autoComplete="email"
            disabled={authState === "loading"}
            name="reset-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="owner@example.com"
            ref={resetEmailRef}
            spellCheck={false}
            type="email"
            value={email}
          />
        </label>
        <Button className="shadcn-action-button" disabled={authState === "loading" || !email.trim()} size="sm" type="submit">
          <Mail size={16} aria-hidden="true" />
          Send reset email
        </Button>
        <Button className="link-button shadcn-action-button" disabled={authState === "loading"} size="sm" type="button" variant="link" onClick={() => {
          backToLogin.current = true;
          onResetModeChange(false);
        }}>
          Back to login
        </Button>
        <AuthMessage message={authMessage} />
      </form>
    );
  }

  return (
    <form className="auth-widget auth-form" onSubmit={(event) => {
      event.preventDefault();
      void onLogin({ email, password }).finally(() => setPassword(""));
    }}>
      <label className="auth-field">
        <span>Email</span>
        <Input
          className="auth-input"
          aria-label="Email"
          autoComplete="email"
          disabled={authState === "loading"}
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="owner@example.com"
          ref={emailRef}
          spellCheck={false}
          type="email"
          value={email}
        />
      </label>
      <label className="auth-field">
        <span>Password</span>
        <Input
          className="auth-input"
          aria-label="Password"
          autoComplete="current-password"
          disabled={authState === "loading"}
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Account password"
          type="password"
          value={password}
        />
      </label>
      <Button className="shadcn-action-button" disabled={authState === "loading" || !email.trim() || !password} size="sm" type="submit">
        <LogIn size={16} aria-hidden="true" />
        Sign in
      </Button>
      {onPasswordReset && (
        <Button className="link-button shadcn-action-button" disabled={authState === "loading"} ref={forgotRef} size="sm" type="button" variant="link" onClick={() => onResetModeChange(true)}>
          Forgot password?
        </Button>
      )}
      <AuthMessage message={authMessage} />
    </form>
  );
}

function AuthMessage({ message }: { message: string | null }) {
  return message ? <span className="auth-message" role="status" aria-live="polite">{message}</span> : null;
}

function MfaSetupPanel({
  client,
  onComplete,
  session,
}: {
  client: RegistryClient;
  onComplete: (result: ConfirmMfaResult) => void;
  session: WebSession;
}) {
  const instructionsId = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ factorId: string; secret: string; otpauthUrl: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function startEnrollment(passwordOverride?: string) {
    setState("loading");
    setMessage(null);
    try {
      const nextEnrollment = await client.startTotpEnrollment({ password: passwordOverride ?? password, label: "1Password" });
      setEnrollment({
        factorId: nextEnrollment.factorId,
        secret: nextEnrollment.secret,
        otpauthUrl: nextEnrollment.otpauthUrl,
      });
      setPassword("");
      setState("ready");
    } catch (error) {
      setState("error");
      setMessage(safeAuthErrorMessage(error));
    }
  }

  async function confirmEnrollment(codeOverride?: string) {
    if (!enrollment) {
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const result = await client.confirmTotpEnrollment({ factorId: enrollment.factorId, code: (codeOverride ?? code).trim() });
      setRecoveryCodes(result.recoveryCodes);
      setCode("");
      setState("ready");
      setMessage("MFA enabled. Save these recovery codes before leaving this page.");
      onComplete(result);
    } catch (error) {
      setState("error");
      setMessage(safeAuthErrorMessage(error));
    }
  }

  return (
    <section className="mfa-setup" aria-label="MFA setup">
      {!enrollment ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          const formData = new window.FormData(event.currentTarget);
          void startEnrollment(String(formData.get("mfa-setup-password") ?? ""));
        }}>
          <label className="auth-field">
            <span>Current password</span>
            <Input
              className="settings-input"
              autoComplete="current-password"
              disabled={state === "loading"}
              name="mfa-setup-password"
              onChange={(event) => setPassword(event.target.value)}
              onInput={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="submit">
            <KeyRound size={16} aria-hidden="true" />
            Continue
          </Button>
        </form>
      ) : recoveryCodes.length === 0 ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          const formData = new window.FormData(event.currentTarget);
          void confirmEnrollment(String(formData.get("mfa-setup-code") ?? ""));
        }}>
          <div className="mfa-secret">
            <span>Authenticator setup</span>
            <p className="mfa-instructions" id={instructionsId}>
              Scan this QR code with your authenticator app, then enter its six-digit code.
              You can also use the manual secret or setup URL below.
            </p>
            <QRCodeSVG
              aria-describedby={instructionsId}
              aria-label="Authenticator setup QR code"
              bgColor="#ffffff"
              className="mfa-qr"
              fgColor="#000000"
              level="M"
              marginSize={4}
              role="img"
              size={240}
              value={enrollment.otpauthUrl}
            />
            <span>Setup URL</span>
            <code>{enrollment.otpauthUrl}</code>
            <small>Manual secret: {enrollment.secret}</small>
          </div>
          <label className="auth-field">
            <span>Verification code</span>
            <Input
              className="settings-input"
              aria-label="MFA setup code"
              autoComplete="one-time-code"
              disabled={state === "loading"}
              inputMode="numeric"
              name="mfa-setup-code"
              onChange={(event) => setCode(event.target.value)}
              onInput={(event) => setCode(event.currentTarget.value)}
              placeholder="123456"
              required
              value={code}
            />
          </label>
          <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="submit">
            <ShieldCheck size={16} aria-hidden="true" />
            Enable MFA
          </Button>
        </form>
      ) : (
        <div className="mfa-recovery">
          <span>Recovery codes</span>
          <code>{recoveryCodes.join("\n")}</code>
        </div>
      )}
      <AuthMessage message={message} />
    </section>
  );
}

/**
 * One card for everything tied to the exact release. The head stays mounted
 * while a version loads, so the Versions control keeps focus, and release facts
 * and actions appear only for the loaded release.
 */
function SkillReleaseCard({
  children,
  historyState,
  message,
  onRetry,
  onReturn,
  onSelect,
  release,
  releases,
  selectedVersion,
  skill,
  state,
}: {
  children: ReactNode;
  historyState: LoadState;
  message: string | null;
  onRetry: () => void;
  onReturn: () => void;
  onSelect: (version: string) => void;
  /** The loaded release, only when state is "ready". */
  release: ReleaseMetadata | null;
  releases: SkillReleaseSummary[];
  selectedVersion: string | null;
  skill: PublicSkill;
  state: ReleaseCardState;
}) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const versionRef = useRef<HTMLSpanElement>(null);
  const focusHeading = useRef(false);
  const listId = useId();
  const latest = skill.latestVersion;
  // The requested version stays visible while it loads or when it is missing.
  const version = release?.version ?? selectedVersion ?? latest;
  const currentVersion = selectedVersion ?? latest;
  const showVersions = historyState === "ready" && releases.length > 0;
  const latestIndex = releases.findIndex((item) => item.version === latest);
  const pinnedIndex = releases.findIndex((item) => item.version === selectedVersion);
  const olderPin = latest !== null && selectedVersion !== latest && latestIndex >= 0 && pinnedIndex > latestIndex;
  // Without a default stable release, clearing a pin promises no latest one.
  const clearPinLabel = latest === null || selectedVersion === latest ? "Unpin" : "View latest";

  useEffect(() => {
    if (focusHeading.current && headingRef.current) {
      headingRef.current.focus();
      focusHeading.current = false;
    }
  });

  function pick(next: string) {
    setVersionsOpen(false);
    toggleRef.current?.focus();
    onSelect(next);
  }

  function clearPin() {
    focusHeading.current = true;
    setVersionsOpen(false);
    onReturn();
  }

  function listKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setVersionsOpen(false);
      toggleRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const index = rows.findIndex((row) => row === document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  }

  return (
    <section aria-label="Release" className="registry-release">
      <div className="registry-release-head">
        <div className="registry-release-top">
          <span aria-hidden="true" className="registry-release-label">Release</span>
          {showVersions ? (
            <Button
              aria-controls={listId}
              aria-expanded={versionsOpen}
              className="registry-versions-toggle"
              ref={toggleRef}
              size="sm"
              type="button"
              variant="outline"
              onClick={() => setVersionsOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && versionsOpen) {
                  event.preventDefault();
                  setVersionsOpen(false);
                }
              }}
            >
              Versions <span className="registry-count">{releases.length}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
          ) : historyState === "loading" ? (
            <p className="registry-release-history" role="status">Loading release history…</p>
          ) : historyState === "error" ? (
            <p className="registry-release-history" role="status">
              Release history is unavailable.{" "}
              <button className="registry-link-button" type="button" onClick={onRetry}>Retry release history</button>
            </p>
          ) : historyState === "ready" ? (
            <p className="registry-release-history" role="status">No published release history is available.</p>
          ) : null}
        </div>
        {showVersions && (
          <ul aria-label="Published versions" className="registry-versions" hidden={!versionsOpen} id={listId} onKeyDown={listKeyDown}>
            {releases.map((item) => (
              <li key={item.version}>
                <button aria-current={item.version === currentVersion ? "true" : undefined} className="registry-version-row" type="button" onClick={() => pick(item.version)}>
                  <Check size={14} aria-hidden="true" />
                  <code title={item.version}>{releaseVersionLabel(item.version, releases)}</code>
                  <span className="registry-version-meta">
                    {item.version === latest && <span className="registry-chip" data-tone="line">Latest</span>}
                    {item.lifecycleStatus === "deprecated" && <span className="registry-chip" data-tone="amber">Deprecated</span>}
                    {item.publishedAt && <span>{formatDate(item.publishedAt)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {state === "no-default" ? (
          <div className="registry-inspector-state">
            <FileCode2 size={20} aria-hidden="true" />
            <div>
              <h3 ref={headingRef} tabIndex={-1}>No default stable release</h3>
              <p>Choose an exact version from release history when no approved stable release is available.</p>
            </div>
          </div>
        ) : version ? (
          <div className="registry-release-id">
            <h3 ref={headingRef} tabIndex={-1} title={version}><span className="sr-only">Release</span>{" "}<span ref={versionRef}>{releaseVersionLabel(version)}</span></h3>
            <CopyButton
              className="registry-icon-copy"
              failureHint={isBootstrapVersion(version) ? `Copy failed. Exact version: ${version}` : "Copy failed. The version is selected for manual copying."}
              iconOnly
              key={version}
              label="Copy version"
              selectOnFailure={isBootstrapVersion(version) ? undefined : versionRef}
              text={version}
              variant="ghost"
            />
            {state === "ready" && release && (release.version === latest || release.lifecycleStatus === "deprecated") && (
              <span className="registry-release-chips">
                {release.version === latest && <span className="registry-chip" data-tone="line">Latest</span>}
                {release.lifecycleStatus === "deprecated" && <span className="registry-chip" data-tone="amber">Deprecated</span>}
              </span>
            )}
            {state === "error" && selectedVersion !== null && <span className="registry-chip" data-tone="amber">Unavailable</span>}
          </div>
        ) : null}
        {selectedVersion !== null && state !== "error" && (
          <p className="registry-pin">
            <Pin size={14} aria-hidden="true" />
            <span>{olderPin ? "Pinned to an older release" : "Pinned to this version"}</span>
            <span aria-hidden="true">·</span>
            <button className="registry-link-button" type="button" onClick={clearPin}>{clearPinLabel}</button>
          </p>
        )}
        {state === "ready" && release && (
          <dl className="registry-release-facts">
            <div><dt>Released</dt><dd>{release.publishedAt ? formatDate(release.publishedAt) : "Not published"}</dd></div>
            <div><dt>Review</dt><dd><RegistryStatus value={release.reviewStatus} /></dd></div>
            <div><dt>Security</dt><dd><RegistryStatus value={release.securityStatus} /></dd></div>
          </dl>
        )}
        {state === "error" && (
          <div className="registry-release-error" role="status" aria-live="polite">
            <CircleAlert size={16} aria-hidden="true" />
            <div>
              <strong>{message}</strong>
              <p>{selectedVersion !== null
                ? `No other version was substituted. Choose a published version or ${latest === null ? "clear the pin" : "view the latest"}.`
                : "The selected skill could not load. Retry the request or choose a different approved skill."}</p>
              <div className="registry-actions">
                {selectedVersion !== null && <Button size="sm" type="button" variant="outline" onClick={clearPin}>{clearPinLabel}</Button>}
                <Button size="sm" type="button" variant="outline" onClick={onRetry}>
                  <RotateCw size={15} aria-hidden="true" />
                  Retry
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      {state === "ready" ? children : state === "loading" ? <RegistryInspectorSkeleton withHeader={false} /> : null}
    </section>
  );
}

/** A disclosure row. The hint describes the row without joining its name. */
function RegistryDisclosure({
  bodyClassName,
  children,
  hint,
  id,
  onToggle,
  open,
  title,
}: {
  bodyClassName?: string;
  children: ReactNode;
  hint?: ReactNode;
  id: string;
  onToggle: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <div className="registry-disclosure">
      <button
        aria-controls={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-expanded={open}
        aria-labelledby={`${id}-title`}
        className="registry-disclosure-button"
        type="button"
        onClick={onToggle}
      >
        <span id={`${id}-title`}>{title}</span>
        <span className="registry-disclosure-hint">
          {hint && <span id={`${id}-hint`}>{hint}</span>}
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </button>
      <div className={bodyClassName ? `registry-disclosure-body ${bodyClassName}` : "registry-disclosure-body"} hidden={!open} id={id}>{children}</div>
    </div>
  );
}

/**
 * Shows the export command with each flag kept beside its value. Display only:
 * the text content equals the command, and copying uses the command itself.
 */
function CommandText({ command }: { command: string }) {
  const [head, ...flags] = command.split(" --");
  return (
    <>
      <span className="registry-command-part">{head}</span>
      {flags.map((part, index) => {
        const space = part.indexOf(" ");
        const flag = space < 0 ? part : part.slice(0, space);
        return (
          <Fragment key={index}>
            {" "}
            <span className="registry-command-part">
              <span className="registry-command-flag">--{flag}</span>
              {space >= 0 && <span data-version={flag === "version" ? "" : undefined}>{part.slice(space)}</span>}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

// The release card body: use first, then optional depth in disclosures whose
// open state carries across version changes. Lifecycle, metadata and sharing live in Manage.
function SkillDetail({
  command,
  client,
  disclosures,
  platform,
  release,
  selectedSkill,
  session,
  setDisclosure,
  setPlatform,
}: {
  command: string;
  client: RegistryClient;
  disclosures: RegistryDisclosures;
  platform: string;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  session: WebSession | null;
  setDisclosure: (key: keyof RegistryDisclosures, open: boolean) => void;
  setPlatform: (platform: string) => void;
}) {
  const supportedPlatforms = release.platforms.filter((item) => item.status === "supported");
  const hasSupportedPlatform = supportedPlatforms.length > 0;
  const canManageSkill = Boolean(session && selectedSkill.access?.canManageSharing);
  const baseId = useId();
  const commandRef = useRef<HTMLElement>(null);
  const compatibility = release.compatibility && Object.keys(release.compatibility).length > 0 ? release.compatibility : null;

  return (
    <>
      {hasSupportedPlatform ? (
        <section className="registry-use" aria-labelledby={`${baseId}-use`}>
          <div className="registry-use-head">
            <h4 id={`${baseId}-use`}>Use this release</h4>
            {supportedPlatforms.length === 1 ? (
              <p className="registry-use-platform">Platform <code>{platform}</code></p>
            ) : (
              <div className="registry-use-platforms" role="group" aria-labelledby={`${baseId}-platform`}>
                <span id={`${baseId}-platform`}>Platform</span>
                {supportedPlatforms.map((item) => (
                  <Button
                    aria-pressed={item.name === platform}
                    className={item.name === platform ? "platform-button active" : "platform-button"}
                    key={item.name}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => setPlatform(item.name)}
                  >
                    {item.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {release.requiresUserAction && (
            <p className="registry-callout" data-tone="amber">
              <CircleAlert size={16} aria-hidden="true" />
              This release requires a user action. Review the instructions before updating.
            </p>
          )}
          <div className="command-panel registry-command">
            <code ref={commandRef}><CommandText command={command} /></code>
          </div>
          <div className="registry-use-actions">
            <CopyButton
              className="registry-copy-command"
              failureHint="Copy failed. The command is selected; copy it with Ctrl+C or ⌘C."
              key={command}
              label="Copy command"
              selectOnFailure={commandRef}
              text={command}
            />
            {platform === "codex" && <p className="registry-muted"><a href="/targets">Connect a Codex workspace</a> to install this exact release.</p>}
          </div>
          {session && (
            <ReleaseInstallPanel
              key={`${selectedSkill.slug}:${release.version}:${platform}`}
              client={client}
              platform={platform}
              release={release}
              selectedSkill={selectedSkill}
            />
          )}
        </section>
      ) : (
        <p className="registry-callout registry-section-callout" data-tone="amber" role="status">No supported export platform is available for this release. Export and install are unavailable.</p>
      )}

      <div className="registry-release-more">
        <RegistryDisclosure
          hint={release.changeKind && <span className="registry-chip registry-change-kind">{release.changeKind}</span>}
          id={`${baseId}-notes`}
          open={disclosures.notes}
          title="Release notes"
          onToggle={() => setDisclosure("notes", !disclosures.notes)}
        >
          <p className="registry-notes">{release.releaseNotes || "No release notes were supplied for this release."}</p>
          {compatibility && (
            <dl className="registry-facts" data-labels="wide">
              <RegistryFact label="Minimum MySkills">{compatibility.minimumMyskillsVersion ?? "Any"}</RegistryFact>
              <RegistryFact label="Minimum adapter contract">{compatibility.minimumAdapterContractVersion?.toString() ?? "Any"}</RegistryFact>
              <RegistryFact label="Minimum source version">{compatibility.minimumSourceVersion ?? "Any"}</RegistryFact>
            </dl>
          )}
        </RegistryDisclosure>

        <RegistryDisclosure
          hint={formatByteSize(release.artifact.byteSize)}
          id={`${baseId}-package`}
          open={disclosures.details}
          title="Package details"
          onToggle={() => setDisclosure("details", !disclosures.details)}
        >
          <dl className="registry-facts">
            {isBootstrapVersion(release.version) && <RegistryFact label="Exact version" mono>{release.version}</RegistryFact>}
            <RegistryFact label="Platforms">{release.platforms.map((item) => `${item.name} · ${item.status}`).join(", ") || "None declared"}</RegistryFact>
            <RegistryFact label="Size">{`${new Intl.NumberFormat().format(release.artifact.byteSize)} bytes`}</RegistryFact>
            <RegistryFact label="Content type" mono>{release.artifact.contentType}</RegistryFact>
            <RegistryFact label="SHA-256" mono>{release.artifact.sha256}</RegistryFact>
          </dl>
        </RegistryDisclosure>

        {hasSupportedPlatform && client.getReleaseBundle && (
          <RegistryDisclosure
            hint="Shown as text"
            id={`${baseId}-files`}
            open={disclosures.files}
            title="Package files"
            onToggle={() => setDisclosure("files", !disclosures.files)}
          >
            {/* Loads only on request; a new release or platform resets it. */}
            <PackageFileViewer
              resourceKey={`${selectedSkill.slug}:${release.version}:${platform}`}
              loadBundle={() => client.getReleaseBundle!(selectedSkill.slug, release.version, platform)}
            />
          </RegistryDisclosure>
        )}

        {client.improvements && (
          <RegistryDisclosure
            id={`${baseId}-improvement`}
            open={disclosures.improvement}
            title="Compatibility and improvement"
            onToggle={() => setDisclosure("improvement", !disclosures.improvement)}
          >
            {/* Stays mounted so compatibility evidence and planner drafts persist. */}
            <SkillImprovementPanel key={`${release.slug}:${release.version}`} client={client} release={release} user={session?.user ?? null} canManage={canManageSkill} visibility={selectedSkill.visibility} />
          </RegistryDisclosure>
        )}
      </div>
    </>
  );
}

function formatByteSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

function RegistryFact({ children, label, mono }: { children: ReactNode; label: string; mono?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "registry-mono" : undefined}>{children}</dd>
    </div>
  );
}

function RegistryStatus({ value }: { value: string }) {
  return <span className="registry-chip" data-tone={value === "approved" || value === "passed" ? "teal" : "amber"}>{formatStatusLabel(value)}</span>;
}

function RegistryLoadingRows() {
  return (
    <div className="registry-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading skills…</span>
      {[0, 1, 2].map((item) => <div className="registry-skeleton-row" key={item}><span /><span /></div>)}
    </div>
  );
}

function RegistryInspectorSkeleton({ withHeader }: { withHeader: boolean }) {
  return (
    <div className="registry-skeleton registry-skeleton-detail" role="status" aria-live="polite">
      <span className="sr-only">Loading skill detail…</span>
      {withHeader && <div className="registry-skeleton-head"><span /><span /></div>}
      <div className="registry-skeleton-line" />
      <div className="registry-skeleton-line" />
      <div className="registry-skeleton-block" />
    </div>
  );
}

function ReleaseInstallPanel({
  client,
  platform,
  release,
  selectedSkill,
}: {
  client: RegistryClient;
  platform: string;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
}) {
  const [targets, setTargets] = useState<ArchitectureTargetRecord[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "queueing" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!client.listArchitectureTargets || !client.scheduleTargetSkillOperation) {
      setState("error");
      setMessage("Connected-target installs are not available in this workspace.");
      return () => { active = false; };
    }
    void client.listArchitectureTargets().then((records) => {
      if (!active) return;
      const eligible = records.filter((target) => canQueueWorkspaceOperation(target, platform, "install"));
      setTargets(eligible);
      setSelectedTargetId((current) => eligible.some((target) => target.id === current) ? current : eligible[0]?.id ?? "");
      setState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    });
    return () => { active = false; };
  }, [client, platform]);

  async function install() {
    const target = targets.find((item) => item.id === selectedTargetId);
    if (!target || !canQueueWorkspaceOperation(target, platform, "install") || !client.scheduleTargetSkillOperation) return;
    setState("queueing");
    setMessage(null);
    try {
      await client.scheduleTargetSkillOperation(selectedTargetId, {
        action: "install",
        slug: selectedSkill.slug,
        version: release.version,
        platform,
        idempotencyKey: operationKey("install"),
      });
      setReviewing(false);
      setState("ready");
      setMessage(`Queued exact install of ${selectedSkill.slug} ${release.version}. Track execution and recovery in Updates.`);
    } catch (error) {
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    }
  }

  return (
    <section className="release-install-panel" aria-labelledby="release-install-heading">
      <h4 id="release-install-heading">Install this exact release</h4>
      {state === "loading" && <p className="control-plane-muted" role="status">Loading eligible targets…</p>}
      {state !== "loading" && targets.length === 0 && <p className="control-plane-muted">Browser installs require a consented personal Codex workspace and a Codex release. Use Connect a Codex workspace in Connected targets to enroll with the CLI.</p>}
      {targets.length > 0 && <div className="release-install-controls"><label><span>Target</span><select value={selectedTargetId} onChange={(event) => { setSelectedTargetId(event.target.value); setReviewing(false); }} disabled={state === "queueing"}>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label>{reviewing ? <div className="release-install-review"><p><strong>{selectedSkill.slug} {release.version}</strong> for {targets.find((target) => target.id === selectedTargetId)?.name}</p><p>{release.releaseNotes || "No release notes were supplied."}</p><small>{platform} · SHA-256 {release.artifact.sha256.slice(0, 12)}… · {release.artifact.byteSize.toLocaleString()} bytes</small>{release.requiresUserAction && <div className="control-plane-inline-message"><CircleAlert size={16} aria-hidden="true" />This release requires a user action after installation.</div>}<div className="target-action-row"><Button type="button" disabled={state === "queueing"} onClick={() => void install()}><ShieldCheck size={15} aria-hidden="true" />{state === "queueing" ? "Queueing…" : "Confirm exact install"}</Button><Button type="button" variant="outline" disabled={state === "queueing"} onClick={() => setReviewing(false)}>Back</Button></div></div> : <Button size="sm" type="button" variant="outline" onClick={() => setReviewing(true)}>Review install</Button>}</div>}
      {message && <div className="control-plane-inline-message" role="status">{message}</div>}
    </section>
  );
}

export function SharingPanel({
  client,
  selectedSkill,
}: {
  client: RegistryClient;
  selectedSkill: Pick<PublicSkill, "slug" | "visibility">;
  session: WebSession;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [details, setDetails] = useState<SkillSharingDetails | null>(null);
  const [visibility, setVisibility] = useState<VisibilityScope>(selectedSkill.visibility);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userEmails, setUserEmails] = useState("");
  const [availableOrganizations, setAvailableOrganizations] = useState<NonNullable<SkillSharingDetails["availableOrganizations"]>>([]);
  const [organizationIds, setOrganizationIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  const loadSharing = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const next = await client.getSkillSharing(selectedSkill.slug);
      setDetails(next);
      setVisibility(next.visibility);
      setTeamIds(next.teamGrants.map((team) => team.id));
      setUserEmails(next.userGrants.map((user) => user.email).join(", "));
      const listedOrganizations = [...(next.availableOrganizations ?? [])];
      if (client.listOrganizations) {
        try {
          listedOrganizations.push(...await client.listOrganizations());
        } catch {
          // The sharing response still contains the server's safe fallback list.
        }
      }
      setAvailableOrganizations(uniqueOrganizations(listedOrganizations));
      setOrganizationIds(uniqueStrings(next.organizationGrants?.map((organization) => organization.id) ?? []));
      setState("ready");
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
      setState("error");
    }
  }, [client, selectedSkill.slug]);

  useEffect(() => {
    void loadSharing();
  }, [loadSharing]);

  async function saveSharing() {
    if (!details) {
      return;
    }
    if (visibility === "public" && details.visibility !== "public") {
      setConfirmation({
        key: "publish-sharing",
        title: "Make this skill public?",
        description: "Any visitor will be able to discover the skill and reach its approved install or export guidance.",
        confirmLabel: "Make public",
        onConfirm: async () => commitSharing(),
      });
      return;
    }
    try {
      await commitSharing();
    } catch {
      // The safe error is already rendered by commitSharing.
    }
  }

  async function commitSharing() {
    if (!details) {
      return;
    }
    setMessage(null);
    setState("loading");
    try {
      const next = await client.updateSkillSharing({
        slug: selectedSkill.slug,
        visibility,
        teamIds: visibility === "team" ? teamIds : [],
        userEmails: visibility === "explicit-users" ? splitEmails(userEmails) : [],
        organizationIds: uniqueStrings(organizationIds),
      });
      setDetails(next);
      setVisibility(next.visibility);
      setTeamIds(next.teamGrants.map((team) => team.id));
      setUserEmails(next.userGrants.map((user) => user.email).join(", "));
      setOrganizationIds(uniqueStrings(next.organizationGrants?.map((organization) => organization.id) ?? organizationIds));
      if (next.availableOrganizations) {
        setAvailableOrganizations(uniqueOrganizations(next.availableOrganizations));
      }
      setMessage("Sharing saved.");
      setState("ready");
    } catch (error) {
      const safeMessage = safeTeamErrorMessage(error);
      setMessage(safeMessage);
      setState("error");
      throw new Error(safeMessage);
    }
  }

  const settings = details?.settings ?? defaultSharingSettings();
  const visibilityOptions: Array<{ value: VisibilityScope; label: string; enabled: boolean }> = [
    { value: "public", label: "Public", enabled: settings.publicVisibilityEnabled },
    { value: "authenticated", label: "Signed-in users", enabled: settings.authenticatedVisibilityEnabled },
    { value: "organization", label: "Organizations", enabled: settings.organizationVisibilityEnabled === true },
    { value: "private", label: "Private", enabled: true },
    { value: "team", label: "Teams", enabled: settings.teamsEnabled && settings.teamVisibilityEnabled },
    { value: "explicit-users", label: "Individual users", enabled: settings.userVisibilityEnabled },
  ];
  const availableTeams = details?.availableTeams ?? [];
  const currentOrganizationGrants = details?.organizationGrants ?? [];
  const organizationOptions = uniqueOrganizations([
    ...availableOrganizations,
    ...currentOrganizationGrants,
  ]);
  const organizationNames = currentOrganizationGrants.map((organization) => organization.name);
  const hiddenOrganizationGrantCount = organizationIds.filter(
    (organizationId) => !organizationOptions.some((organization) => organization.id === organizationId),
  ).length;

  return (
    <Frame className="sharing-panel reui-registry-frame" role="region" aria-label="Sharing controls" spacing="sm">
      <FramePanel className="reui-registry-panel">
        <div className="sharing-panel-head">
          <div>
            <strong>Sharing</strong>
            <span>Control who can discover and install this skill.</span>
          </div>
          <Button className="save-button shadcn-action-button" disabled={state === "loading" || (visibility === "organization" && organizationIds.length === 0)} size="sm" type="button" onClick={() => void saveSharing()}>
            <Save size={16} aria-hidden="true" />
            Save sharing
          </Button>
        </div>
        {message && <div className="inline-message" role="status">{message}</div>}
        <div className="sharing-editor">
          <label>
            Visibility
            <select value={visibility} disabled={state === "loading"} onChange={(event) => setVisibility(event.target.value as VisibilityScope)}>
              {visibilityOptions.map((option) => (
                <option disabled={!option.enabled} key={option.value} value={option.value}>
                  {option.label}{option.enabled ? "" : " (disabled)"}
                </option>
              ))}
            </select>
          </label>

          <div className={visibility === "team" ? "grant-box active" : "grant-box"}>
            <strong>Teams</strong>
            {availableTeams.map((team) => (
              <label className="role-toggle" key={team.id}>
                <input
                  checked={teamIds.includes(team.id)}
                  disabled={visibility !== "team"}
                  type="checkbox"
                  onChange={() => setTeamIds((current) => toggleString(current, team.id))}
                />
                <span>{team.name}</span>
              </label>
            ))}
            {details && availableTeams.length === 0 && <small>No teams available.</small>}
          </div>

          <div className={visibility === "organization" ? "grant-box active" : "grant-box"}>
            <strong>Organizations</strong>
            <small>Select from organizations returned by the server. Existing grants stay selected when another visibility setting changes.</small>
            {organizationNames.length > 0 && <small>Current grants: {organizationNames.join(", ")}</small>}
            {organizationOptions.map((organization) => (
              <label className="role-toggle" key={organization.id}>
                <input
                  aria-label={`Share with ${organization.name}`}
                  checked={organizationIds.includes(organization.id)}
                  disabled={visibility !== "organization" || state === "loading"}
                  type="checkbox"
                  onChange={() => setOrganizationIds((current) => toggleString(current, organization.id))}
                />
                <span>{organization.name}</span>
              </label>
            ))}
            {hiddenOrganizationGrantCount > 0 && <small>{hiddenOrganizationGrantCount} existing organization grant{hiddenOrganizationGrantCount === 1 ? "" : "s"} are not in the current organization list and will be preserved.</small>}
            {organizationOptions.length === 0 && <small>No organizations available.</small>}
          </div>

          <label className={visibility === "explicit-users" ? "grant-box active" : "grant-box"}>
            <strong>Individual users</strong>
            <Input
              className="registry-input"
              disabled={visibility !== "explicit-users"}
              value={userEmails}
              onChange={(event) => setUserEmails(event.target.value)}
              placeholder="user@example.com, teammate@example.com"
            />
          </label>
        </div>
        {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
      </FramePanel>
    </Frame>
  );
}

function LoadingRows() {
  return (
    <div className="loading-announcement" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((item) => <div className="loading-row" key={item} />)}
    </div>
  );
}

function preferredPlatform(platforms: Array<{ name: string; status?: string }>): string {
  return platforms.find((item) => item.name === "codex")?.name ?? platforms[0]?.name ?? "codex";
}

function releasePlatform(platforms: Array<{ name: string; status: string }>, current: string): string | null {
  const supported = platforms.filter((item) => item.status === "supported");
  if (supported.length === 0) return null;
  return supported.some((item) => item.name === current) ? current : preferredPlatform(supported);
}

function isExactReleaseVersion(version: string): boolean {
  return parseSemanticVersion(version) !== null || /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

function formatDate(input: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(input));
}

function isAdminUser(user: WebAuthUser): boolean {
  return user.roles.includes("owner") || user.roles.includes("admin");
}

function isReviewerUser(user: WebAuthUser): boolean {
  return isAdminUser(user) || user.roles.includes("maintainer");
}

function isSubmitterUser(user: WebAuthUser): boolean {
  return isReviewerUser(user) || user.roles.includes("author");
}

function isPublicView(view: AppView): boolean {
  return view === "landing"
    || view === "login"
    || view === "register"
    || view === "reset-password"
    || view === "verify-email"
    || view === "change-email"
    || view === "browse"
    || view === "not-found";
}

function initialViewFromPath(pathname: string): AppView {
  if (pathname === "/libraries") return "libraries";
  // Legacy Manage skills page: now the Can manage scope of Skills.
  if (pathname === "/manage/skills") return "browse";
  if (pathname === "/") {
    return "landing";
  }
  if (pathname === "/login") {
    return "login";
  }
  if (pathname === "/auth/register") {
    return "register";
  }
  if (pathname === "/auth/reset-password") {
    return "reset-password";
  }
  if (pathname === "/auth/verify-email") {
    return "verify-email";
  }
  if (pathname === "/auth/change-email") {
    return "change-email";
  }
  if (pathname === "/admin") {
    return "admin";
  }
  if (pathname === "/review") {
    return "review";
  }
  if (pathname === "/submit") {
    return "submit";
  }
  if (isArchitecturePath(pathname)) {
    return "architectures";
  }
  if (pathname === "/organizations") {
    return "organizations";
  }
  if (pathname === "/targets") {
    return "targets";
  }
  if (pathname === "/updates") {
    return "updates";
  }
  if (pathname === "/teams") {
    return "teams";
  }
  if (pathname === "/settings") {
    return "settings";
  }
  if (pathname === "/registry" || skillSlugFromPath(pathname)) {
    return "browse";
  }
  return "not-found";
}

function pathForView(view: AppView): string {
  if (view === "landing") {
    return "/";
  }
  if (view === "login") {
    return "/login";
  }
  if (view === "register") {
    return "/auth/register";
  }
  if (view === "reset-password") {
    return "/auth/reset-password";
  }
  if (view === "verify-email") {
    return "/auth/verify-email";
  }
  if (view === "change-email") {
    return "/auth/change-email";
  }
  if (view === "not-found") {
    return "/404";
  }
  return view === "browse" ? "/registry" : `/${view}`;
}

function appLocationFromWindow(): AppLocation {
  const params = new URLSearchParams(window.location.search);
  const slug = skillSlugFromPath(window.location.pathname);
  const catalogView = params.get("view");
  return {
    view: initialViewFromPath(window.location.pathname),
    slug,
    query: params.get("q") ?? "",
    platform: params.get("platform") ?? "codex",
    version: slug ? params.get("version") : null,
    catalog: {
      view: catalogView === "list" || catalogView === "outline" ? catalogView : "grouped",
      bundle: slug ? null : params.get("bundle") || null,
    },
    workspace: {
      scope: window.location.pathname === "/manage/skills" ? "manage" : parseSkillScope(params.get("scope")),
      tab: slug ? parseSkillTab(params.get("tab")) : "overview",
      returnTo: slug ? safeLibraryReturn(params.get("returnTo"), window.location.origin) : null,
    },
  };
}

function currentBrowserUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function readAppHistoryIndex(state: unknown): number | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const value = (state as Record<string, unknown>)[APP_HISTORY_INDEX_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function appHistoryState(index: number): Record<string, unknown> {
  const state = window.history.state;
  const base = state && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return { ...base, [APP_HISTORY_INDEX_KEY]: index };
}

/** Exact release link for Submit and Review outcomes: readable when published, otherwise the manager's Versions. */
function exactSkillUrl(slug: string, version: string, published: boolean): string {
  return registryUrl(slug, "", "codex", version, undefined, published ? undefined : { scope: "manage", tab: "versions", returnTo: null });
}

function registryUrl(slug: string | null, query: string, platform: string, version: string | null = null, catalog?: CatalogLocation, workspace?: WorkspaceLocation): string {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set("q", query);
  }
  if (platform !== "codex") {
    params.set("platform", platform);
  }
  if (slug && version !== null) {
    params.set("version", version);
  }
  if (catalog && catalog.view !== "grouped") {
    params.set("view", catalog.view);
  }
  if (catalog?.bundle && !slug) {
    params.set("bundle", catalog.bundle);
  }
  // Workspace keys follow the existing ones so older URLs keep their shape.
  if (workspace?.scope === "manage") {
    params.set("scope", "manage");
  }
  if (slug && workspace && workspace.tab !== "overview") {
    params.set("tab", workspace.tab);
  }
  if (slug && workspace?.returnTo) {
    params.set("returnTo", workspace.returnTo);
  }
  const pathname = slug ? `/skills/${slug}` : "/registry";
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function handleCallbackLink(event: ReactMouseEvent<HTMLAnchorElement>, callback: () => void): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  callback();
}

function registrationPostureTitle(mode: AdminRegistrationMode): string {
  switch (mode) {
    case "closed":
      return "Only existing approved accounts can access MySkills.";
    case "request":
      return "New accounts require owner or admin approval.";
    case "open":
      return "New accounts can sign up without prior approval.";
  }
}

function registrationPostureDescription(mode: AdminRegistrationMode): string {
  switch (mode) {
    case "closed":
      return "Best for owner-gated beta operation and production hardening before public onboarding.";
    case "request":
      return "Best for controlled collaborator onboarding while review workflows are still maturing.";
    case "open":
      return "Use only when public onboarding, abuse handling, and support workflows are ready.";
  }
}

function emptyProviderDraft(): ProviderDraft {
  return {
    key: "",
    type: "oidc",
    displayName: "",
    issuer: "",
    clientId: "",
    enabled: false,
    roleMappings: [],
  };
}

function providerToDraft(provider: AdminProviderConfig | undefined): ProviderDraft {
  if (!provider) {
    return emptyProviderDraft();
  }
  return {
    key: provider.key,
    type: provider.type,
    displayName: provider.displayName,
    issuer: provider.issuer ?? "",
    clientId: provider.clientId ?? "",
    enabled: provider.enabled,
    roleMappings: provider.roleMappings.map((mapping) => ({ ...mapping })),
  };
}

function optionalDraftValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function upsertProvider(providers: AdminProviderConfig[], provider: AdminProviderConfig): AdminProviderConfig[] {
  const next = providers.filter((item) => item.key !== provider.key);
  next.push(provider);
  return next.sort((a, b) => a.key.localeCompare(b.key));
}

function defaultSharingSettings(): AdminSharingSettings {
  return {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
  };
}

function updateDraftMapping(
  setDraft: (value: ProviderDraft) => void,
  draft: ProviderDraft,
  index: number,
  patch: Partial<ProviderRoleMappingInput>,
) {
  setDraft({
    ...draft,
    roleMappings: draft.roleMappings.map((mapping, itemIndex) => (
      itemIndex === index ? { ...mapping, ...patch } : mapping
    )),
  });
}

function toggleRole(roles: string[], role: string): string[] {
  const next = new Set(roles);
  if (next.has(role)) {
    next.delete(role);
  } else {
    next.add(role);
  }
  return ADMIN_ROLE_OPTIONS.filter((item) => next.has(item));
}

function toggleString(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

type SkillSharingOrganization = NonNullable<SkillSharingDetails["availableOrganizations"]>[number];

function uniqueOrganizations(values: SkillSharingOrganization[]): SkillSharingOrganization[] {
  const byId = new Map(values.map((organization) => [organization.id, organization]));
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function splitEmails(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivilegedRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function isZipArchive(file: File): boolean {
  return /^[A-Za-z0-9._-]+\.zip$/i.test(file.name);
}

function toggleApiTokenScope(scopes: ApiTokenScope[], scope: ApiTokenScope): ApiTokenScope[] {
  return scopes.includes(scope)
    ? scopes.filter((item) => item !== scope)
    : [...scopes, scope];
}

function apiTokenExpiryBounds(now = new Date()): { min: string; max: string } {
  const minimum = new Date(now.getTime() + 60_000);
  const maximum = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  return { min: localDateTimeValue(minimum), max: localDateTimeValue(maximum) };
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function validateApiTokenExpiry(value: string, now = Date.now()):
  | { valid: true; iso: string | undefined }
  | { valid: false; message: string } {
  if (!value) {
    return { valid: true, iso: undefined };
  }
  const expiry = new Date(value);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= now) {
    return { valid: false, message: "Choose a valid future date and time." };
  }
  if (expiry.getTime() - now > 365 * 24 * 60 * 60 * 1000) {
    return { valid: false, message: "Choose an expiry no more than 1 year away." };
  }
  return { valid: true, iso: expiry.toISOString() };
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function downloadJsonFile(filename: string, value: unknown): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([JSON.stringify(value)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(value) + ` ${units[unitIndex]}`;
}

function skillSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/(?:registry\/)?skills\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
  return match?.[1] ?? null;
}

function authActionTokenFromLocation(): string | null {
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) {
    return null;
  }
  const params = new URLSearchParams(rawHash);
  const token = params.get("token");
  return token && token.trim() ? token.trim() : null;
}

function clearAuthActionTokenFromLocation(): void {
  if (!window.location.hash) {
    return;
  }
  window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
}

function apiErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

function apiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

const SESSION_STORAGE_KEY = "myskills-app:web-session";
const MAX_WEB_ARCHIVE_BYTES = 10 * 1024 * 1024;
const ADMIN_ROLE_OPTIONS = ["owner", "admin", "maintainer", "author", "user"];

function readStoredSession(): WebSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    if ("token" in parsed) {
      clearStoredSession();
      return null;
    }
    if (!isStoredSession(parsed)) {
      clearStoredSession();
      return null;
    }
    return parsed;
  } catch {
    clearStoredSession();
    return null;
  }
}

function isStoredSession(input: unknown): input is WebSession {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Partial<WebSession>;
  return typeof record.expiresAt === "string" && record.expiresAt.length > 0
    && isStoredUser(record.user);
}

function isStoredUser(input: unknown): input is WebAuthUser {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Partial<WebAuthUser>;
  return typeof record.id === "string" && record.id.length > 0
    && typeof record.email === "string" && record.email.length > 0
    && typeof record.name === "string"
    && typeof record.status === "string" && record.status.length > 0
    && Array.isArray(record.roles) && record.roles.every((role) => typeof role === "string")
    && typeof record.emailVerified === "boolean"
    && typeof record.mfaVerified === "boolean";
}

function writeStoredSession(session: WebSession): void {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    expiresAt: session.expiresAt,
    user: session.user,
  }));
}

function clearStoredSession(): void {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}
