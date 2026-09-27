import { ConfirmationDialog, type ConfirmationRequest } from "@/components/ui/confirmation-dialog";
import { MarketingLanding } from "./components/marketing/MarketingLanding.js";
import { LandingSettings } from "./components/marketing/LandingSettings.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Copy,
  Download,
  Ellipsis,
  FileCode2,
  Fingerprint,
  Globe,
  KeyRound,
  Link2,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
  PackageCheck,
  PackageOpen,
  Plus,
  RotateCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  UserCog,
  UserRound,
  UsersRound,
  Workflow,
  X,
} from "lucide-react";
import { parseSemanticVersion, type PublicSkill, type RegistryView, type SkillSharingDetails, type TeamSharedSkillGroup, type VisibilityScope } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { ArchitecturesDashboard } from "@/components/architecture/ArchitecturesDashboard";
import { OrganizationsDashboard } from "@/components/organization/OrganizationsDashboard";
import { ArchitectureTargetsDashboard } from "@/components/target/ArchitectureTargetsDashboard";
import { LibrariesDashboard } from "@/components/library/LibrariesDashboard";
import { tileTone } from "@/components/library/library-display";
import { SystemUpdateCenter } from "@/components/update/SystemUpdateCenter";
import { PackageFileViewer } from "@/components/registry/PackageFileViewer";
import { ManagedSkillsDashboard } from "@/components/registry/ManagedSkillsDashboard";
import { SubmissionEvidencePanel } from "@/components/registry/SubmissionEvidencePanel";
import { SkillImprovementPanel } from "@/components/registry/SkillImprovementPanel";
import { BundleWorkspace } from "@/components/registry/BundleWorkspace";
import { chipTone, findingsLabel, lifecycleLabel, reviewStatusLabel, securityStatusLabel, severityLabel, visibilityLabel } from "@/components/registry/status-display";
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
type AppView = "libraries" | "manage" | "landing" | "login" | "register" | "reset-password" | "verify-email" | "change-email" | "browse" | "architectures" | "organizations" | "targets" | "updates" | "admin" | "review" | "submit" | "teams" | "settings" | "not-found";

interface AppLocation {
  view: AppView;
  slug: string | null;
  query: string;
  platform: string;
  version: string | null;
  catalog: CatalogLocation;
}

/** Registry catalog state kept in the URL beside the existing skill parameters. */
interface CatalogLocation {
  view: RegistryView;
  bundle: string | null;
}

type ArchitectureNavigationGuard = (action: string) => boolean;
type RegistryLayout = "split" | "stack";
type MobileMenu = "more" | "account";
type RegistryFocus = { kind: "title" } | { kind: "row"; slug: string };
interface RegistryDisclosures {
  notes: boolean;
  improvement: boolean;
  owner: boolean;
}

const APP_HISTORY_INDEX_KEY = "__myskillsAppHistoryIndex";
// The Registry splits into list and inspector when its own surface is this wide.
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
  const initialLocation = appLocationFromWindow();
  const historyIndexRef = useRef(readAppHistoryIndex(window.history.state) ?? 0);
  const currentLocationRef = useRef(initialLocation);
  const currentUrlRef = useRef(currentBrowserUrl());
  const architectureNavigationGuardRef = useRef<ArchitectureNavigationGuard | null>(null);
  const restoringPopstateRef = useRef(false);
  const [view, setView] = useState<AppView>(initialLocation.view);
  const [session, setSession] = useState<WebSession | null>(() => readStoredSession());
  const registryClient = useMemo(() => client ?? createRegistryClient(), [client]);
  // Bundle catalog, when the client and server provide it. A 404 from the
  // catalog falls back to the flat registry for this session.
  const [catalogAvailable, setCatalogAvailable] = useState(() => Boolean(registryClient.bundles));
  const [catalogView, setCatalogView] = useState<RegistryView>(initialLocation.catalog.view);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(initialLocation.catalog.bundle);
  const catalogLocationRef = useRef<CatalogLocation>(initialLocation.catalog);
  const browseUrl = (slug: string | null, nextQuery: string, nextPlatform: string, version: string | null = null) => (
    registryUrl(slug, nextQuery, nextPlatform, version, catalogLocationRef.current)
  );
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
  const [historyState, setHistoryState] = useState<LoadState>("idle");
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
  const [registryDisclosures, setRegistryDisclosures] = useState<RegistryDisclosures>({ notes: false, improvement: false, owner: false });
  // A desktop split shows the first result without choosing it: the URL stays
  // /registry until the reader picks a skill. A stack shows the list instead.
  const implicitSlug = registryLayout === "split" && selectedSlug === null ? skills[0]?.slug ?? null : null;
  const detailSlug = selectedSlug ?? implicitSlug;
  const canUseAdmin = Boolean(session && isAdminUser(session.user));
  const canUseReview = Boolean(session && isReviewerUser(session.user));
  const canUseSubmit = Boolean(session && isSubmitterUser(session.user));
  const canUseTeams = Boolean(session);
  const canUseOrganizations = Boolean(session && registryClient.listOrganizations);
  const canUseTargets = Boolean(session && registryClient.listArchitectureTargets);
  const activeView: AppView = isPublicView(view)
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
        : view === "manage" && session
          ? "manage"
        : view === "teams" && canUseTeams
          ? "teams"
        : view === "settings"
          ? "settings"
          : "browse";

  const replaceAppHistory = (nextUrl: string) => {
    window.history.replaceState(appHistoryState(historyIndexRef.current), "", nextUrl);
    currentLocationRef.current = appLocationFromWindow();
    currentUrlRef.current = currentBrowserUrl();
  };

  const pushAppHistory = (nextUrl: string) => {
    historyIndexRef.current += 1;
    window.history.pushState(appHistoryState(historyIndexRef.current), "", nextUrl);
    currentLocationRef.current = appLocationFromWindow();
    currentUrlRef.current = currentBrowserUrl();
  };

  const registerArchitectureNavigationGuard = useCallback((guard: ArchitectureNavigationGuard | null) => {
    architectureNavigationGuardRef.current = guard;
  }, []);

  // Split or stack follows the Registry surface's own width, not the viewport.
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
        return;
      }

      if (previous.view === "architectures" && next.view !== "architectures") {
        const guard = architectureNavigationGuardRef.current;
        if (guard) {
          const action = nextHistoryIndex !== null && nextHistoryIndex < historyIndexRef.current
            ? "go back"
            : nextHistoryIndex !== null && nextHistoryIndex > historyIndexRef.current
              ? "go forward"
              : "navigate away";
          if (!guard(action)) {
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
      currentLocationRef.current = next;
      currentUrlRef.current = currentBrowserUrl();
      searchSelectionQuery.current = null;
      setView(next.view);
      // Clear eagerly only when the detail effects are certain to reload. An
      // implicit desktop selection can become the same explicit skill, so a
      // change to or from /registry is left to those effects.
      const bothExplicit = next.slug !== null && previous.slug !== null;
      if (bothExplicit && next.slug !== previous.slug) {
        setSelectedSkill(null);
        setVisibleReleases([]);
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
      setMobileMenu(null);
    }
    window.addEventListener("popstate", syncFromBrowserHistory);
    return () => window.removeEventListener("popstate", syncFromBrowserHistory);
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
    if (!session && !isPublicView(view)) {
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
  }, [activeView, platform, query, selectedSlug, selectedVersion, session, view]);

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
    // The bundle catalog owns registry rows while it is mounted.
    if (activeView !== "browse" || catalogAvailable) {
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
  }, [activeView, catalogAvailable, registryClient, query, refreshKey]);

  useEffect(() => {
    if (activeView !== "browse" || !detailSlug) {
      setSelectedSkill(null);
      setRelease(null);
      setVisibleReleases([]);
      setHistoryState("idle");
      setDetailState("idle");
      setDetailMessage(null);
      return;
    }
    let active = true;
    setSelectedSkill(null);
    setRelease(null);
    setVisibleReleases([]);
    setHistoryState("loading");
    setDetailState("loading");
    setDetailMessage(null);
    registryClient.getSkill(detailSlug)
      .then(async (skill) => {
        if (!active) return;
        if (skill.slug !== detailSlug) {
          setHistoryState("error");
          setDetailMessage("Skill or release not found.");
          setDetailState("error");
          return;
        }
        setSelectedSkill(skill);
        try {
          const rows = await registryClient.listSkillReleases(detailSlug);
          if (!active) return;
          const visible = rows
            .filter((row) => row.slug === detailSlug && isExactReleaseVersion(row.version) && isPublishedRelease(row))
            .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
            .filter((row, index, all) => all.findIndex((other) => other.version === row.version) === index);
          setVisibleReleases(visible);
          setHistoryState("ready");
        } catch {
          if (!active) return;
          setVisibleReleases([]);
          setHistoryState("error");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSelectedSkill(null);
        setRelease(null);
        setVisibleReleases([]);
        setHistoryState("idle");
        setDetailMessage(safeErrorMessage(error));
        setDetailState("error");
      });
    return () => { active = false; };
  }, [activeView, registryClient, detailSlug, refreshKey]);

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
  // selection change and the effects that reload it.
  const skillReady = selectedSkill !== null && selectedSkill.slug === detailSlug;
  const expectedVersion = selectedVersion ?? selectedSkill?.latestVersion ?? null;
  const releaseReady = skillReady && release !== null && release.slug === detailSlug && release.version === expectedVersion;
  const historyControls = skillReady ? (
    <ReleaseHistoryControls
      historyState={historyState}
      latestVersion={latestVisibleRelease?.version ?? null}
      onRetry={retryRegistry}
      onReturn={returnToLatest}
      onSelect={selectVersion}
      releases={visibleReleases}
      selectedVersion={selectedVersion}
    />
  ) : null;
  const registryStacked = registryLayout === "stack";
  const showRegistryList = !(registryStacked && selectedSlug !== null);
  const showRegistryInspector = registryLayout === "split" || selectedSlug !== null;

  useEffect(() => {
    const pending = pendingRegistryFocus.current;
    if (!pending || activeView !== "browse") return;
    if (pending.kind === "title") {
      if (skillReady && inspectorTitleRef.current) {
        inspectorTitleRef.current.focus();
        pendingRegistryFocus.current = null;
      }
      return;
    }
    if (!showRegistryList || listState === "loading") return;
    const rows = registrySurfaceRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-slug]") ?? [];
    Array.from(rows).find((row) => row.dataset.slug === pending.slug)?.focus();
    pendingRegistryFocus.current = null;
  }, [activeView, skillReady, showRegistryList, listState, skills]);

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
    pushAppHistory(browseUrl(slug, query, platform, slug === selectedSlug ? selectedVersion : null));
  }

  function backToSkills() {
    pendingRegistryFocus.current = selectedSlug ? { kind: "row", slug: selectedSlug } : null;
    searchSelectionQuery.current = null;
    setSelectedSlug(null);
    setSelectedVersion(null);
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
    pushAppHistory(browseUrl(null, query, platform));
  }

  function changeCatalogView(nextView: RegistryView) {
    catalogLocationRef.current = { ...catalogLocationRef.current, view: nextView };
    setCatalogView(nextView);
    pushAppHistory(browseUrl(selectedSlug, query, platform, selectedVersion));
  }

  function selectVersion(version: string) {
    const target = visibleReleases.find((item) => item.version === version);
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
    if (!selectedSkill) setRefreshKey((current) => current + 1);
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
    { view: "libraries" as const, label: "Libraries", group: "Library" as const, icon: <PackageOpen size={18} aria-hidden="true" />, enabled: Boolean(session && registryClient.libraries) },
    { view: "browse" as const, label: "Registry", group: "Library" as const, icon: <Boxes size={18} aria-hidden="true" />, enabled: true },
    { view: "architectures" as const, label: "Architectures", group: "Build" as const, icon: <Workflow size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "submit" as const, label: "Submit", group: "Build" as const, icon: <Upload size={18} aria-hidden="true" />, enabled: canUseSubmit },
    { view: "manage" as const, label: "Manage skills", group: "Govern" as const, icon: <PackageCheck size={18} aria-hidden="true" />, enabled: Boolean(session && registryClient.listManagedSkills) },
    { view: "review" as const, label: "Review", group: "Govern" as const, icon: <ClipboardList size={18} aria-hidden="true" />, enabled: canUseReview },
    { view: "teams" as const, label: "Teams", group: "Govern" as const, icon: <UsersRound size={18} aria-hidden="true" />, enabled: canUseTeams },
    { view: "organizations" as const, label: "Organizations", group: "Govern" as const, icon: <Building2 size={18} aria-hidden="true" />, enabled: canUseOrganizations },
    { view: "targets" as const, label: "Connected targets", group: "Observe" as const, icon: <Link2 size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "updates" as const, label: "Updates", group: "Observe" as const, icon: <RotateCw size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "admin" as const, label: "Admin", group: "Account" as const, icon: <Settings size={18} aria-hidden="true" />, enabled: canUseAdmin },
    { view: "settings" as const, label: "Settings", group: "Account" as const, icon: <UserCog size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "login" as const, label: "Login", group: "Account" as const, icon: <LogIn size={18} aria-hidden="true" />, enabled: !session },
  ].filter((item) => item.enabled);
  const navGroups = (["Library", "Build", "Govern", "Observe", "Account"] as const)
    .map((label) => ({ label, items: navItems.filter((item) => item.group === label) }))
    .filter((group) => group.items.length > 0);
  // Mobile keeps Libraries and Registry, plus one shortcut for the reader's
  // main job. Every other allowed destination stays grouped under More.
  const mobileRoleView = canUseReview ? "review" : canUseSubmit ? "submit" : canUseTargets ? "targets" : null;
  const mobilePrimaryItems = navItems.filter((item) => item.view === "libraries" || item.view === "browse" || item.view === mobileRoleView);
  const mobilePrimaryViews = new Set<AppView>(mobilePrimaryItems.map((item) => item.view));
  const mobileOverflowGroups = navGroups
    .map((group) => ({ label: group.label, items: group.items.filter((item) => !mobilePrimaryViews.has(item.view)) }))
    .filter((group) => group.items.length > 0);
  const mobileOverflowActive = mobileOverflowGroups.some((group) => group.items.some((item) => item.view === activeView));

  // Existing skill detail (release history, export, trust panels). The bundle
  // workspace renders it in its inspector and adds bundle backlinks.
  const renderSkillDetail = (bundles: ReactNode) => (
    <>
                      {skillReady && selectedSkill ? (
                        <header className="registry-inspector-head">
                          <span className="registry-tile" data-size="32" data-tone={tileTone(selectedSkill.slug)} aria-hidden="true" />
                          <div className="registry-inspector-title">
                            <h2 ref={inspectorTitleRef} tabIndex={-1}>{selectedSkill.title}</h2>
                            <p className="registry-ref">
                              <code>{selectedSkill.slug}</code>
                              {releaseReady && release && <><span aria-hidden="true">@</span><code>{release.version}</code></>}
                            </p>
                            {releaseReady && release && ((selectedVersion !== null && selectedSkill.latestVersion && selectedSkill.latestVersion !== release.version) || release.lifecycleStatus === "deprecated") && (
                              <p className="registry-inspector-meta">
                                {selectedVersion !== null && selectedSkill.latestVersion && selectedSkill.latestVersion !== release.version && <span>Latest is {selectedSkill.latestVersion}</span>}
                                {release.lifecycleStatus === "deprecated" && <span className="registry-chip" data-tone="amber">Deprecated</span>}
                              </p>
                            )}
                          </div>
                          <div className="registry-version-slot">{historyControls}</div>
                        </header>
                      ) : null}
                      {detailMessage ? (
                        <div className="registry-inspector-state" role="status" aria-live="polite">
                          <CircleAlert size={20} aria-hidden="true" />
                          <div>
                            <strong>{detailMessage}</strong>
                            <p>{selectedVersion !== null
                              ? "The requested exact version was not substituted. Choose a published version or return to latest."
                              : "The selected skill could not load. Retry the request or choose a different approved skill."}</p>
                            <div className="registry-actions">
                              <Button size="sm" type="button" variant="outline" onClick={retryRegistry}>
                                <RotateCw size={15} aria-hidden="true" />
                                Retry
                              </Button>
                              {selectedVersion !== null && !selectedSkill && <Button size="sm" type="button" variant="outline" onClick={returnToLatest}>Return to latest</Button>}
                            </div>
                          </div>
                        </div>
                      ) : detailState === "ready" && releaseReady && release && selectedSkill ? (
                        <SkillDetail
                          bundles={bundles}
                          command={selectedCommand}
                          client={registryClient}
                          disclosures={registryDisclosures}
                          platform={detailPlatform}
                          release={release}
                          selectedSkill={selectedSkill}
                          session={session}
                          setDisclosure={(key, open) => setRegistryDisclosures((current) => current[key] === open ? current : { ...current, [key]: open })}
                          setPlatform={updatePlatform}
                          onChanged={() => setRefreshKey((value) => value + 1)}
                        />
                      ) : detailState === "ready" && skillReady && !release ? (
                        <div className="registry-inspector-state">
                          <FileCode2 size={20} aria-hidden="true" />
                          <div>
                            <h3>No default stable release</h3>
                            <p>Choose an exact version from release history when no approved stable release is available.</p>
                          </div>
                        </div>
                      ) : detailSlug || detailState === "loading" || listState === "loading" ? (
                        <RegistryInspectorSkeleton withHeader={!skillReady} />
                      ) : (
                        <p className="registry-inspector-empty">{skills.length > 0 ? "Select a skill to see its exact releases." : "No skill selected."}</p>
                      )}
    </>
  );

  return (
    <div className={sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="sidebar-brand-row">
          <a className="brand" href="/registry" onClick={(event) => {
            handleAppLink(event, "browse");
          }}>
            <span className="brand-mark" aria-hidden="true">
              <img src="/brand/myskills-mark.svg" alt="" width={100} height={100} />
            </span>
            <span>MySkills</span>
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
            <img src="/brand/myskills-mark.svg" alt="" width={100} height={100} />
            <span>MySkills</span>
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
            <LibrariesDashboard client={registryClient} user={session.user} />
          ) : activeView === "manage" && session ? (
            <ManagedSkillsDashboard client={registryClient} mfaVerified={session.user.mfaVerified} />
          ) : activeView === "review" && session ? (
            <ReviewDashboard client={registryClient} session={session} />
          ) : activeView === "submit" && session ? (
            <SubmitDashboard client={registryClient} session={session} />
          ) : activeView === "teams" && session ? (
            <TeamsDashboard client={registryClient} session={session} />
          ) : activeView === "architectures" && session ? (
            <ArchitecturesDashboard client={registryClient} onNavigationGuardChange={registerArchitectureNavigationGuard} session={session} />
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
          ) : bundleCatalog ? (
            <BundleWorkspace
              api={bundleCatalog}
              bundleHref={(bundleId) => registryUrl(null, query, platform, null, { view: catalogView, bundle: bundleId })}
              canCreate={canUseSubmit}
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
              skillHref={(slug) => browseUrl(slug, query, platform, slug === selectedSlug ? selectedVersion : null)}
              view={catalogView}
            />
          ) : (
            <main className="registry-workspace" aria-labelledby="registry-heading">
              <header className="registry-page-head">
                <h1 id="registry-heading">Skill registry</h1>
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
                        aria-label="Search skills"
                        name="skill-search"
                        value={query}
                        onChange={(event) => updateSearch(event.target.value)}
                        placeholder="Search skills…"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <kbd aria-hidden="true">/</kbd>
                    </label>
                  </div>
                )}
                <div className="registry-body">
                  {showRegistryList && (
                    <section className="registry-results-panel registry-list" aria-label="Skill search results">
                      <div className="registry-list-label">
                        <h2>Skills</h2>
                        <span aria-live="polite">{listState === "ready" ? (nextCursor ? `${skills.length} loaded` : String(skills.length)) : ""}</span>
                      </div>
                      {listState === "loading" && <RegistryLoadingRows />}
                      {listState === "error" && (
                        <div className="registry-list-state" role="status" aria-live="polite">
                          <strong>{listMessage ?? "The registry is not available."}</strong>
                          <p>The list could not load. Retry the registry request before selecting a skill.</p>
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
                              href={browseUrl(skill.slug, query, platform, skill.slug === selectedSlug ? selectedVersion : null)}
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
                              {skill.latestVersion && <span className="registry-version-chip">{skill.latestVersion}</span>}
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
    <img src="/brand/myskills-mark.svg" alt="MySkills" width={48} height={48} />
    {failed ? <>
      <div role="alert"><h1>We couldn’t load this page.</h1><p>Try again, or continue to sign in.</p></div>
      <Button type="button" onClick={onRetry}>Try again</Button>
    </> : <p role="status">{showDetails ? "Loading MySkills…" : ""}</p>}
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
  return (
    <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main className="login-page" id="main-content">
      <nav className="login-nav" aria-label="Login navigation">
        {showLandingLink ? <a className="landing-brand" href="/" onClick={(event) => handleCallbackLink(event, onHome)}>
          <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} />
        </a> : <span className="landing-brand"><img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} /></span>}
        {showLandingLink && <Button asChild className="login-back shadcn-action-button" size="sm" variant="outline">
          <a href="/" onClick={(event) => handleCallbackLink(event, onHome)}>Public site</a>
        </Button>}
      </nav>
      <section className="login-panel" aria-labelledby="login-heading">
        <p className="landing-status">Public beta. Hosted signups are closed.</p>
        <h1 id="login-heading">Login</h1>
        <p>Use an approved owner or team account to access the hosted beta workspace. Need an account? Ask the instance owner for an invitation and follow the email link.</p>
        <p><a href="/registry">Browse public skills</a> · <a href="https://github.com/jremick/myskills/blob/main/docs/GETTING_STARTED.md">Self-host MySkills</a></p>
        <AuthWidget
          authMessage={authMessage}
          authState={authState}
          mfaPending={mfaPending}
          onLogin={onLogin}
          onLogout={async () => undefined}
          onPasswordReset={onPasswordReset}
          onVerifyMfa={onVerifyMfa}
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
            <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} />
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

function SubmitDashboard({ client }: { client: RegistryClient; session: WebSession }) {
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
            <h2 id={`${baseId}-submitted`} ref={listHeadingRef} tabIndex={-1}>My submitted skills</h2>
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
                          <code>{submission.slug}@{submission.version}</code>
                          <span>{formatBytes(submission.artifact.byteSize)}</span>
                          <span>Submitted {formatDate(submission.createdAt)}</span>
                        </span>
                        <span className="author-chips">
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

function ReviewDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  // Queue load failures stay in the queue; decision and artifact messages stay
  // beside the submission they belong to.
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ submissionId: string; text: string } | null>(null);
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
      setNotice({ submissionId: submission.id, text: `${submission.title} ${actionLabel}.` });
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
        description: "Publication makes the approved release available through registry install and export surfaces.",
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

function TeamsDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboard>({ teams: [], invitations: [] });
  const [sharedGroups, setSharedGroups] = useState<TeamSharedSkillGroup[]>([]);
  const [teamName, setTeamName] = useState("");
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});
  const teamCount = dashboard.teams.length;
  const invitationCount = dashboard.invitations.length;
  const sharedByYouCount = sharedGroups.reduce((total, group) => total + group.sharingWithTeam.length, 0);
  const sharedWithYouCount = sharedGroups.reduce((total, group) => total + group.sharedWithMe.length, 0);

  const refreshTeams = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const [nextDashboard, nextGroups] = await Promise.all([
        client.listTeams(),
        client.listTeamSharedSkills(),
      ]);
      setDashboard(nextDashboard);
      setSharedGroups(nextGroups);
      setState("ready");
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
      setState("error");
    }
  }, [client]);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  async function createTeam() {
    if (!teamName.trim()) {
      return;
    }
    setMessage(null);
    try {
      await client.createTeam(teamName);
      setTeamName("");
      await refreshTeams();
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  async function inviteMember(team: TeamRecord) {
    const email = inviteEmails[team.id]?.trim();
    if (!email) {
      return;
    }
    setMessage(null);
    try {
      await client.inviteTeamMember(team.id, email);
      setInviteEmails((current) => ({ ...current, [team.id]: "" }));
      await refreshTeams();
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  async function acceptInvitation(invitation: TeamInvitation) {
    setMessage(null);
    try {
      await client.acceptTeamInvitation(invitation.id);
      await refreshTeams();
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  return (
    <main className="teams-workspace" aria-label="Teams">
      <section className="admin-hero teams-hero shadcn-teams-hero" aria-labelledby="teams-heading">
        <div>
          <h1 id="teams-heading">Teams</h1>
          <p aria-live="polite">{session.user.email} · {state === "loading" ? "Refreshing team access…" : `${teamCount} teams`}</p>
        </div>
        <div className="teams-hero-actions">
          <dl className="teams-header-metrics" aria-label="Team summary">
            <div>
              <dt>Teams</dt>
              <dd>{teamCount}</dd>
            </div>
            <div>
              <dt>Invitations</dt>
              <dd>{invitationCount}</dd>
            </div>
            <div>
              <dt>Sharing</dt>
              <dd>{sharedByYouCount}</dd>
            </div>
            <div>
              <dt>Shared</dt>
              <dd>{sharedWithYouCount}</dd>
            </div>
          </dl>
          <Button className="shadcn-action-button teams-refresh-button" size="sm" type="button" variant="outline" onClick={() => void refreshTeams()}>
            <RotateCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="teams-layout shadcn-teams-layout">
        <Card className="teams-access-panel shadcn-console-card" aria-label="Teams and invitations">
          <CardHeader className="admin-panel-heading shadcn-card-header teams-combined-heading">
            <span className="admin-panel-icon"><UsersRound size={18} aria-hidden="true" /></span>
            <div>
              <CardTitle>Teams and invitations</CardTitle>
              <CardDescription>Create teams, review members, and accept pending invites.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="teams-access-content">
            <form className="team-create-row shadcn-team-create-row" onSubmit={(event) => {
              event.preventDefault();
              void createTeam();
            }}>
              <Input
                aria-label="Team name"
                value={teamName}
                onChange={(event) => setTeamName(event.target.value)}
                placeholder="Team name"
              />
              <Button className="save-button shadcn-action-button" disabled={!teamName.trim()} size="sm" type="submit">
                <Plus size={16} aria-hidden="true" />
                Create
              </Button>
            </form>

            <section className="teams-combined-section" aria-labelledby="team-list-heading">
              <div className="teams-section-heading">
                <h2 id="team-list-heading">Teams</h2>
                <span>{teamCount} active</span>
              </div>
              <div className="team-list">
                {state === "loading" && <TeamsLoadingRows />}
                {state !== "loading" && dashboard.teams.map((team) => (
                  <article className="team-card" key={team.id}>
                    <div className="team-row">
                      <div className="team-row-main">
                        <strong>{team.name}</strong>
                        <small>{team.members.length} members · {team.invitations.length} pending · {team.slug}</small>
                      </div>
                      <StatusToken value={team.role} />
                      {team.role === "owner" ? (
                        <form className="team-invite-row" onSubmit={(event) => {
                          event.preventDefault();
                          void inviteMember(team);
                        }}>
                          <Input
                            aria-label={`Invite user to ${team.name}`}
                            value={inviteEmails[team.id] ?? ""}
                            onChange={(event) => setInviteEmails((current) => ({ ...current, [team.id]: event.target.value }))}
                            placeholder="user@example.com"
                            type="email"
                          />
                          <Button className="shadcn-action-button" disabled={!inviteEmails[team.id]?.trim()} size="sm" type="submit" variant="outline">
                            <Plus size={15} aria-hidden="true" />
                            Invite
                          </Button>
                        </form>
                      ) : (
                        <span className="team-permission-note">Invite access limited to owners</span>
                      )}
                    </div>

                    <div className="team-detail-grid">
                      <div className="team-detail-list">
                        <h3>Members</h3>
                        {team.members.map((member) => (
                          <div className="team-person-row" key={member.id}>
                            <UserRound size={15} aria-hidden="true" />
                            <span>
                              <strong>{member.name || member.email}</strong>
                              <small>{member.email}</small>
                            </span>
                            <StatusToken value={member.role} />
                          </div>
                        ))}
                        {team.members.length === 0 && <div className="empty-inline">No members returned for this team.</div>}
                      </div>

                      <div className="team-detail-list">
                        <h3>Pending invitations</h3>
                        {team.invitations.map((invitation) => (
                          <div className="team-person-row" key={invitation.id}>
                            <Mail size={15} aria-hidden="true" />
                            <span>
                              <strong>{invitation.email}</strong>
                              <small>Sent {formatDate(invitation.createdAt)}</small>
                            </span>
                            <StatusToken value={invitation.status} />
                          </div>
                        ))}
                        {team.invitations.length === 0 && <div className="empty-inline">No pending invitations.</div>}
                      </div>
                    </div>
                  </article>
                ))}
                {state === "ready" && dashboard.teams.length === 0 && (
                  <div className="empty-state compact">
                    <UsersRound size={22} aria-hidden="true" />
                    <strong>No teams yet.</strong>
                    <span>Create a team to start sharing private skills with members.</span>
                  </div>
                )}
              </div>
            </section>

            <section className="teams-combined-section" aria-labelledby="team-invitations-heading">
              <div className="teams-section-heading">
                <h2 id="team-invitations-heading">Invitations</h2>
                <span>{invitationCount} pending</span>
              </div>
              <div className="invitation-list">
                {state === "loading" && <TeamsLoadingRows />}
                {state !== "loading" && dashboard.invitations.map((invitation) => (
                  <div className="invitation-row" key={invitation.id}>
                    <span>
                      <strong>{invitation.teamName}</strong>
                      <small>{invitation.email} · sent {formatDate(invitation.createdAt)}</small>
                    </span>
                    <StatusToken value={invitation.status} />
                    <Button className="save-button shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void acceptInvitation(invitation)}>
                      <Check size={16} aria-hidden="true" />
                      Accept
                    </Button>
                  </div>
                ))}
                {state === "ready" && dashboard.invitations.length === 0 && (
                  <div className="empty-state compact">
                    <Check size={22} aria-hidden="true" />
                    <strong>No pending invitations.</strong>
                    <span>Accepted teams appear in the team list.</span>
                  </div>
                )}
              </div>
            </section>
          </CardContent>
        </Card>

        <section className="team-shared-groups teams-shared-column" aria-label="Team shared skills">
          {state === "loading" && (
            <Card className="team-skill-group shadcn-console-card">
              <CardHeader className="admin-panel-heading shadcn-card-header">
                <span className="admin-panel-icon"><PackageOpen size={18} aria-hidden="true" /></span>
                <div>
                  <CardTitle>Shared skills</CardTitle>
                  <CardDescription>Loading team visibility grants.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <TeamsLoadingRows />
              </CardContent>
            </Card>
          )}
          {state !== "loading" && sharedGroups.map((group) => (
            <TeamSkillGroupCard group={group} key={group.team.id} />
          ))}
          {state === "ready" && sharedGroups.length === 0 && (
            <Card className="team-skill-group teams-shared-empty shadcn-console-card">
              <CardHeader className="admin-panel-heading shadcn-card-header">
                <span className="admin-panel-icon"><PackageOpen size={18} aria-hidden="true" /></span>
                <div>
                  <CardTitle>Shared skills</CardTitle>
                  <CardDescription>Team visibility grants grouped by team.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="empty-state compact">
                  <PackageOpen size={24} aria-hidden="true" />
                  <strong>No team-shared skills.</strong>
                  <span>Team visibility grants will appear here grouped by team.</span>
                </div>
              </CardContent>
            </Card>
          )}
        </section>
      </section>
    </main>
  );
}

function TeamsLoadingRows() {
  return (
    <div className="teams-loading-list" role="status" aria-live="polite">
      <span className="sr-only">Loading teams…</span>
      <span className="loading-row" />
      <span className="loading-row short" />
      <span className="loading-row" />
    </div>
  );
}

function TeamSkillGroupCard({ group }: { group: TeamSharedSkillGroup }) {
  return (
    <Card className="team-skill-group shadcn-console-card">
      <CardHeader className="admin-panel-heading shadcn-card-header">
        <span className="admin-panel-icon"><UsersRound size={18} aria-hidden="true" /></span>
        <div>
          <CardTitle>{group.team.name}</CardTitle>
          <CardDescription>{group.sharingWithTeam.length} shared by you · {group.sharedWithMe.length} shared with you</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="team-skill-columns">
        <TeamSkillList title="Sharing with this team" skills={group.sharingWithTeam} />
        <TeamSkillList title="Shared with you" skills={group.sharedWithMe} />
      </CardContent>
    </Card>
  );
}

function TeamSkillList({ skills, title }: { skills: PublicSkill[]; title: string }) {
  return (
    <div className="team-skill-list">
      <h3>{title}</h3>
      {skills.map((skill) => (
        <div className="team-skill-row" key={skill.slug}>
          <span>
            <strong>{skill.title}</strong>
            <small>{skill.latestVersion ?? "-"} | {skill.tags.slice(0, 2).join(", ") || "untagged"}</small>
          </span>
          <StatusToken value={skill.visibility} />
        </div>
      ))}
      {skills.length === 0 && <div className="empty-inline">No skills in this group.</div>}
    </div>
  );
}

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

  return (
    <main className="admin-workspace shadcn-admin-workspace" aria-label="Admin console">
      <section className="admin-hero shadcn-admin-hero" aria-labelledby="admin-console-heading">
        <div>
          <Badge className="shadcn-review-eyebrow" variant="outline">Owner workflow</Badge>
          <h1 id="admin-console-heading">Admin console</h1>
          <p aria-live="polite">{session.user.email} · {adminInitialLoading ? "Loading accounts…" : `${users.length} accounts`}</p>
        </div>
        <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => void refreshAdmin()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </Button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="admin-grid">
        <AdminPanel icon={<Globe size={18} aria-hidden="true" />} title="Landing page" meta="First visit to this instance">
          <LandingSettings key={`${session.user.id}:${session.expiresAt}`} client={client} canEdit={session.user.mfaVerified} onSaved={() => { void refreshAudit().catch(() => setMessage("Landing setting saved. Refresh to load the audit history.")); }} />
        </AdminPanel>
        <AdminPanel
          icon={<Settings size={18} aria-hidden="true" />}
          title="Registration"
          meta={state === "loading" ? "Loading…" : registrationMode}
        >
          {adminInitialLoading ? (
            <LoadingRows />
          ) : (
            <>
              <div className={`registration-posture registration-posture-${registrationMode}`}>
                <span>{capitalize(registrationMode)}</span>
                <strong>{registrationPostureTitle(registrationMode)}</strong>
                <p>{registrationPostureDescription(registrationMode)}</p>
              </div>
              <div className="segmented-control" aria-label="Registration mode">
                {(["closed", "request", "open"] as const).map((mode) => (
                  <button
                    className={registrationMode === mode ? "active" : undefined}
                    key={mode}
                    type="button"
                    onClick={() => void updateRegistration(mode)}
                  >
                    {capitalize(mode)}
                  </button>
                ))}
              </div>
              <p className="admin-guidance">
                Use request mode for controlled beta access. Open registration is intentionally guarded until public onboarding and abuse handling are ready.
              </p>
              {session.user.mfaVerified ? (
                <form className="provider-form admin-invite-form" aria-label="Invite user" onSubmit={(event) => {
                  event.preventDefault();
                  void createInvitation();
                }}>
                  <label>
                    Email
                    <input
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
                  <label>
                    Name <small>(optional)</small>
                    <input
                      autoComplete="name"
                      disabled={inviteState === "loading"}
                      name="invitation-name"
                      onChange={(event) => setInviteName(event.target.value)}
                      value={inviteName}
                    />
                  </label>
                  <Button className="save-button shadcn-action-button" disabled={inviteState === "loading"} size="sm" type="submit">
                    <Mail size={16} aria-hidden="true" />
                    {inviteState === "loading" ? "Sending invitation…" : "Send invitation"}
                  </Button>
                  {invitation && (
                    <div className="success-message compact-message admin-invite-message" role="status" aria-live="polite">
                      Invitation sent to {invitation.email}. It expires {formatDate(invitation.expiresAt)}.
                    </div>
                  )}
                  {inviteMessage && (
                    <div className="safe-message compact-message admin-invite-message" role="status" aria-live="polite">{inviteMessage}</div>
                  )}
                </form>
              ) : (
                <div className="safe-message compact-message" role="status">
                  Sign in with MFA before sending registration invitations.
                </div>
              )}
            </>
          )}
        </AdminPanel>

        <AdminPanel
          icon={<UsersRound size={18} aria-hidden="true" />}
          title="Users"
          meta={`${users.length} accounts`}
        >
          <div className="admin-table user-table">
            <div className="admin-table-head">
              <span>User</span>
              <span>Status</span>
              <span>Roles</span>
              <span>Security</span>
              <span>Actions</span>
            </div>
            {adminInitialLoading && <LoadingRows />}
            {users.map((user) => (
              <div className="admin-table-row" key={user.id}>
                <span className="cell-main">
                  <strong>{user.email}</strong>
                  <small>{user.name || user.id}</small>
                </span>
                <span><StatusToken value={user.status} /></span>
                <span>
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
                </span>
                <span>{user.emailVerified ? "verified" : "unverified"} · {user.mfaEnabled ? "MFA" : "no MFA"}</span>
                <span className="row-actions">
                  {user.status === "pending" && (
                    <IconButton label="Approve user" onClick={() => void performUserAction(user.id, "approve")}>
                      <Check size={15} aria-hidden="true" />
                    </IconButton>
                  )}
                  {user.status === "disabled" && (
                    <IconButton label="Activate user" onClick={() => void performUserAction(user.id, "activate")}>
                      <RotateCw size={15} aria-hidden="true" />
                    </IconButton>
                  )}
                  {user.id !== session.user.id && user.status === "active" && (
                    <IconButton label="Disable user" onClick={() => void performUserAction(user.id, "disable")}>
                      <X size={15} aria-hidden="true" />
                    </IconButton>
                  )}
                  {user.id !== session.user.id && user.status !== "deleted" && (
                    <IconButton label="Delete user" onClick={() => void performUserAction(user.id, "delete")}>
                      <Trash2 size={15} aria-hidden="true" />
                    </IconButton>
                  )}
                </span>
              </div>
            ))}
          </div>
        </AdminPanel>

        <AdminPanel
          icon={<KeyRound size={18} aria-hidden="true" />}
          title="API keys"
          meta={`${apiTokens.filter((token) => !token.revokedAt).length} active`}
        >
          <div className="admin-token-list">
            {adminInitialLoading && <LoadingRows />}
            {apiTokens.map((token) => (
              <div className="token-row admin-token-row" key={token.id}>
                <span className="cell-main">
                  <strong>{token.name}</strong>
                  <small>{token.user.email} · {token.tokenPrefix}…</small>
                </span>
                <StatusToken value={token.revokedAt ? "revoked" : "active"} />
                <span className="admin-token-scopes">{token.scopes.join(", ")}</span>
                <span className="admin-token-expiry">Expires {formatDate(token.expiresAt)}</span>
                <button
                  className="icon-button"
                  disabled={Boolean(token.revokedAt)}
                  type="button"
                  onClick={() => void revokeAdminToken(token.id)}
                  aria-label={`Revoke ${token.name}`}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            ))}
            {state === "ready" && apiTokens.length === 0 && (
              <div className="empty-state compact">
                <KeyRound size={22} aria-hidden="true" />
                <strong>No API keys.</strong>
                <span>User-created keys will appear here for monitoring and revocation.</span>
              </div>
            )}
          </div>
        </AdminPanel>

        <AdminPanel
          icon={<UserCog size={18} aria-hidden="true" />}
          title="Provider"
          meta={`${providers.length} configured`}
        >
          {adminInitialLoading ? (
            <LoadingRows />
          ) : (
            <div className="provider-layout">
              <div className="provider-list">
                <button type="button" onClick={() => setDraft(emptyProviderDraft())}>
                  <Plus size={15} aria-hidden="true" />
                  New provider
                </button>
                {providers.map((provider) => (
                  <button
                    className={provider.key === draft.key ? "selected" : undefined}
                    key={provider.key}
                    type="button"
                    onClick={() => setDraft(providerToDraft(provider))}
                  >
                    <span>
                      <strong>{provider.displayName}</strong>
                      <small>{provider.key}</small>
                    </span>
                    <StatusToken value={provider.enabled ? "enabled" : "disabled"} />
                  </button>
                ))}
              </div>
              <form className="provider-form" onSubmit={(event) => {
                event.preventDefault();
                void saveProvider();
              }}>
                <label>
                  Key
                  <input value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
                </label>
                <label>
                  Type
                  <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as ProviderDraft["type"] })}>
                    <option value="oidc">OIDC</option>
                    <option value="saml">SAML</option>
                    <option value="cloudflare_access">Cloudflare Access</option>
                    <option value="github">GitHub</option>
                    <option value="google">Google</option>
                  </select>
                </label>
                <label>
                  Display name
                  <input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
                </label>
                <label>
                  Issuer
                  <input value={draft.issuer} onChange={(event) => setDraft({ ...draft, issuer: event.target.value })} />
                </label>
                <label>
                  Client ID
                  <input value={draft.clientId} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} />
                </label>
                <label className="toggle-row">
                  <input checked={draft.enabled} type="checkbox" onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
                  Enabled
                </label>

                <div className="mapping-editor">
                  <div className="mapping-heading">
                    <span>Role mappings</span>
                    <button type="button" onClick={() => setDraft({
                      ...draft,
                      roleMappings: [...draft.roleMappings, { claim: "", value: "", role: "user" }],
                    })}>
                      <Plus size={15} aria-hidden="true" />
                      Add
                    </button>
                  </div>
                  {draft.roleMappings.map((mapping, index) => (
                    <div className="mapping-row" key={index}>
                      <input
                        aria-label={`Mapping ${index + 1} claim`}
                        value={mapping.claim}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { claim: event.target.value })}
                      />
                      <input
                        aria-label={`Mapping ${index + 1} value`}
                        value={mapping.value}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { value: event.target.value })}
                      />
                      <select
                        aria-label={`Mapping ${index + 1} role`}
                        value={mapping.role}
                        onChange={(event) => updateDraftMapping(setDraft, draft, index, { role: event.target.value })}
                      >
                        <option value="user">user</option>
                        <option value="author">author</option>
                        <option value="maintainer">maintainer</option>
                      </select>
                      <IconButton label={`Remove mapping ${index + 1}`} onClick={() => setDraft({
                        ...draft,
                        roleMappings: draft.roleMappings.filter((_, itemIndex) => itemIndex !== index),
                      })}>
                        <Trash2 size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                  ))}
                </div>
                <button className="save-button" type="submit">
                  <Save size={16} aria-hidden="true" />
                  Save provider
                </button>
              </form>
            </div>
          )}
        </AdminPanel>

        <AdminPanel
          icon={<ShieldCheck size={18} aria-hidden="true" />}
          title="Audit"
          meta={`${auditEvents.length} loaded`}
        >
          <div className="audit-list">
            {adminInitialLoading && <LoadingRows />}
            {auditEvents.map((event) => (
              <div className="audit-row" key={event.id}>
                <span className={event.decision === "allow" ? "audit-decision allow" : "audit-decision deny"}>
                  {event.decision}
                </span>
                <span>
                  <strong>{event.action}</strong>
                  <small>{event.resourceType}{event.resourceId ? ` · ${event.resourceId}` : ""}</small>
                </span>
                <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
              </div>
            ))}
            {auditCursor && <Button type="button" size="sm" variant="outline" disabled={loadingAudit} onClick={() => void loadMoreAudit()}>{loadingAudit ? "Loading more events…" : "Load more audit events"}</Button>}
            {state === "ready" && auditEvents.length === 0 && <div className="empty-state">No audit events.</div>}
          </div>
        </AdminPanel>
      </section>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function AdminPanel({ children, icon, meta, title }: {
  children: ReactNode;
  icon: ReactNode;
  meta: string;
  title: string;
}) {
  return (
    <section className="admin-panel reui-admin-section">
      <Frame className="reui-admin-frame" dense spacing="xs" variant="ghost">
        <FramePanel className="reui-admin-panel">
          <FrameHeader className="admin-panel-heading reui-admin-heading">
            <span className="admin-panel-icon">{icon}</span>
            <div>
              <FrameTitle>{title}</FrameTitle>
              <FrameDescription>{meta}</FrameDescription>
            </div>
          </FrameHeader>
          {children}
        </FramePanel>
      </Frame>
    </section>
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
      <a className="sidebar-account-main" href="/settings" aria-label="Account settings" onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        onSettings();
      }} title={session.user.email}>
        <UserRound size={18} aria-hidden="true" />
        <span>
          <strong>{session.user.email}</strong>
          <small>{session.user.roles.join(", ") || "user"} · {session.user.mfaVerified ? "MFA verified" : "MFA pending"}</small>
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
          <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} />
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
  const [message, setMessage] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [mfaPassword, setMfaPassword] = useState("");
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [apiTokenName, setApiTokenName] = useState("");
  const [apiTokenScopes, setApiTokenScopes] = useState<ApiTokenScope[]>(["skills:read"]);
  const [apiTokenExpiresAt, setApiTokenExpiresAt] = useState("");
  const [apiTokenExpiryError, setApiTokenExpiryError] = useState<string | null>(null);
  const [createdApiToken, setCreatedApiToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const tokenExpiryBounds = useMemo(() => apiTokenExpiryBounds(), []);

  async function refreshAccountSecurity() {
    try {
      const [nextMfaStatus, nextApiTokens] = await Promise.all([
        client.getMfaStatus(),
        client.listApiTokens(),
      ]);
      setMfaStatus(nextMfaStatus);
      setApiTokens(nextApiTokens);
      setState("ready");
    } catch (error) {
      setMessage(safeAccountErrorMessage(error));
      setState("error");
    }
  }

  useEffect(() => {
    void refreshAccountSecurity();
  }, [client]);

  async function submitPasswordChange(input?: { currentPassword: string; password: string; confirmPassword: string }) {
    setMessage(null);
    const passwordInput = input ?? {
      currentPassword,
      password: newPassword,
      confirmPassword: confirmNewPassword,
    };
    if (passwordInput.password !== passwordInput.confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    const passwordError = newPasswordByteError(passwordInput.password);
    if (passwordError) {
      setMessage(passwordError);
      return;
    }
    setState("loading");
    try {
      await client.changePassword({ currentPassword: passwordInput.currentPassword, password: passwordInput.password });
      onSessionInvalidated("Password changed. Sign in again with the new password.");
    } catch (error) {
      setState("error");
      setMessage(safeAccountErrorMessage(error));
    }
  }

  async function submitEmailChange(input?: { email: string; password: string }) {
    setMessage(null);
    setState("loading");
    try {
      const emailInput = input ?? { email, password: emailPassword };
      await client.requestEmailChange({ email: emailInput.email, password: emailInput.password });
      setEmail("");
      setEmailPassword("");
      setState("ready");
      setMessage("Verification email sent. Confirm the new address to complete the change.");
    } catch (error) {
      setState("error");
      setMessage(safeAccountErrorMessage(error));
    }
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
    setMessage(null);
    setState("loading");
    try {
      await client.disableTotpMfa({ password });
      onSessionInvalidated("MFA removed. Sign in again to continue.");
    } catch (error) {
      setState("error");
      const safeMessage = safeAccountErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function createAccountApiToken() {
    setMessage(null);
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
      setMessage(safeAccountErrorMessage(error));
    }
  }

  async function revokeAccountApiToken(tokenId: string) {
    setMessage(null);
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
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  const mfaEnabled = Boolean(mfaStatus?.totpEnabled);
  const activeApiTokenCount = apiTokens.filter((token) => !token.revokedAt).length;
  const accountInitialLoading = state === "loading" && mfaStatus === null;
  const sessionMfaLabel = session.user.mfaVerified ? "verified" : "not verified";
  const mfaPostureLabel = accountInitialLoading ? "Loading…" : mfaEnabled ? (session.user.mfaVerified ? "MFA verified" : "MFA enabled") : "MFA not set";
  const apiTokenCountLabel = accountInitialLoading ? "Loading…" : String(activeApiTokenCount);
  const recoveryCodeLabel = accountInitialLoading ? "Loading…" : mfaEnabled ? String(mfaStatus?.recoveryCodesRemaining ?? 0) : "not issued";

  return (
    <main className="settings-workspace shadcn-settings-workspace" aria-label="Account settings">
      {message && <div className={state === "error" ? "safe-message admin-message" : "success-message admin-message"} role="status">{message}</div>}
      <section className="settings-hero shadcn-settings-hero">
        <div>
          <Badge className="settings-eyebrow shadcn-review-eyebrow" variant="outline">Account settings</Badge>
          <h1>Security and access</h1>
          <p>Manage identity, authentication, and external access for this account.</p>
        </div>
        <div className="settings-hero-metrics" aria-label="Account posture">
          <SettingsMetric label="Session MFA" value={sessionMfaLabel} strong={session.user.mfaVerified} />
          <SettingsMetric label="Active API keys" value={apiTokenCountLabel} />
        </div>
      </section>

      {!accountInitialLoading && mfaEnabled && !session.user.mfaVerified && (
        <section className="settings-risk-banner" role="status" aria-live="polite">
          <CircleAlert size={20} aria-hidden="true" />
          <div>
            <strong>MFA is enabled, but this session is not MFA verified.</strong>
            <p>Privileged owner workflows remain locked until the next MFA sign-in.</p>
          </div>
          <Button className="shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => onSessionInvalidated("Sign in with MFA to continue.")}>
            <LogIn size={16} aria-hidden="true" />
            Sign in with MFA
          </Button>
        </section>
      )}

      <div className="settings-layout">
        <aside className="settings-overview" aria-label="Account summary">
          <div className="settings-profile">
            <span className="settings-avatar" aria-hidden="true">
              <UserRound size={24} />
            </span>
            <div>
              <strong>{session.user.email}</strong>
              <span>{session.user.roles.join(", ") || "user"}</span>
            </div>
          </div>
          <dl className="settings-summary-list">
            <Metadata label="Email status" value={session.user.emailVerified ? "verified" : "unverified"} />
            <Metadata label="MFA posture" value={mfaPostureLabel} />
            <Metadata label="Recovery codes" value={recoveryCodeLabel} />
            <Metadata label="API access" value={accountInitialLoading ? "Loading…" : `${activeApiTokenCount} active`} />
          </dl>
        </aside>

        <section className="settings-content" aria-label="Settings controls">
          <AccountPanel icon={<Mail size={18} aria-hidden="true" />} title="Change email" meta="Requires new-address verification">
            <form className="settings-form two-column" onSubmit={(event) => {
              event.preventDefault();
              const formData = new window.FormData(event.currentTarget);
              void submitEmailChange({
                email: String(formData.get("new-email") ?? ""),
                password: String(formData.get("email-current-password") ?? ""),
              });
            }}>
              <div className="settings-field">
                <label>
                  <span>New email</span>
                  <Input
                    className="settings-input"
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
                <small>The new address must be verified before it replaces the current one.</small>
              </div>
              <div className="settings-field">
                <label>
                  <span>Current password</span>
                  <Input
                    className="settings-input"
                    autoComplete="current-password"
                    name="email-current-password"
                    onChange={(event) => setEmailPassword(event.target.value)}
                    onInput={(event) => setEmailPassword(event.currentTarget.value)}
                    required
                    type="password"
                    value={emailPassword}
                  />
                </label>
                <small>Required for account identity changes.</small>
              </div>
              <div className="settings-submit-row">
                <Button className="save-button shadcn-action-button" disabled={state === "loading"} size="sm" type="submit">
                  <Mail size={16} aria-hidden="true" />
                  Send verification
                </Button>
              </div>
            </form>
          </AccountPanel>

          <AccountPanel icon={<KeyRound size={18} aria-hidden="true" />} title="Password" meta="Current password required">
            <form className="settings-form password-grid" onSubmit={(event) => {
              event.preventDefault();
              const formData = new window.FormData(event.currentTarget);
              void submitPasswordChange({
                currentPassword: String(formData.get("current-password") ?? ""),
                password: String(formData.get("new-password") ?? ""),
                confirmPassword: String(formData.get("confirm-new-password") ?? ""),
              });
            }}>
              <label className="span-all">
                <span>Current password</span>
                <Input
                  className="settings-input"
                  autoComplete="current-password"
                  name="current-password"
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  onInput={(event) => setCurrentPassword(event.currentTarget.value)}
                  required
                  type="password"
                  value={currentPassword}
                />
              </label>
              <label>
                <span>New password</span>
                <Input
                  className="settings-input"
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
              <label>
                <span>Confirm new password</span>
                <Input
                  className="settings-input"
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
              <div className="settings-submit-row">
                <Button className="save-button shadcn-action-button" disabled={state === "loading"} size="sm" type="submit">
                  <Save size={16} aria-hidden="true" />
                  Change password
                </Button>
              </div>
            </form>
          </AccountPanel>

          <AccountPanel icon={<ShieldCheck size={18} aria-hidden="true" />} title="MFA" meta={accountInitialLoading ? "Loading…" : mfaEnabled ? `${mfaStatus?.recoveryCodesRemaining ?? 0} recovery codes` : "Authenticator app not set"}>
            {accountInitialLoading ? (
              <LoadingRows />
            ) : (
              <div className="settings-stack">
                <div className={mfaEnabled ? "settings-security-state verified" : "settings-security-state attention"}>
                  <ShieldCheck size={18} aria-hidden="true" />
                  <div>
                    <strong>{mfaEnabled ? "Authenticator app MFA is enabled." : "Authenticator app MFA is not set."}</strong>
                    <span>{session.user.mfaVerified ? "This session is MFA verified." : "Sign in with MFA before using privileged owner workflows."}</span>
                  </div>
                </div>
                {mfaEnabled && (
                  <div className="settings-actions">
                    <Button className="save-button shadcn-action-button secondary-action" size="sm" type="button" variant="outline" onClick={() => setMfaSetupOpen((open) => !open)}>
                      <RotateCw size={16} aria-hidden="true" />
                      Reset authenticator
                    </Button>
                    <form className="inline-security-form" onSubmit={(event) => {
                      event.preventDefault();
                      const formData = new window.FormData(event.currentTarget);
                      requestMfaRemoval(String(formData.get("mfa-removal-password") ?? ""));
                    }}>
                      <label>
                        <span>Password for MFA removal</span>
                        <Input
                          className="settings-input"
                          aria-label="Password for MFA removal"
                          autoComplete="current-password"
                          name="mfa-removal-password"
                          onChange={(event) => setMfaPassword(event.target.value)}
                          onInput={(event) => setMfaPassword(event.currentTarget.value)}
                          placeholder="Current password"
                          required
                          type="password"
                          value={mfaPassword}
                        />
                      </label>
                      <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="submit" variant="destructive">
                        <X size={16} aria-hidden="true" />
                        Remove MFA
                      </Button>
                    </form>
                  </div>
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
              </div>
            )}
          </AccountPanel>

          <AccountPanel icon={<KeyRound size={18} aria-hidden="true" />} title="API keys" meta={accountInitialLoading ? "Loading…" : `${activeApiTokenCount} active`}>
            <div className="settings-stack">
              <form className="settings-form api-key-form" noValidate onSubmit={(event) => {
                event.preventDefault();
                void createAccountApiToken();
              }}>
                <label>
                  <span>Key name</span>
                  <Input
                    className="settings-input"
                    aria-label="Key name"
                    name="api-token-name"
                    onChange={(event) => setApiTokenName(event.target.value)}
                    onInput={(event) => setApiTokenName(event.currentTarget.value)}
                    placeholder="CLI or MCP client"
                    value={apiTokenName}
                  />
                </label>
                <label>
                  <span>Expires at</span>
                  <Input
                    className="settings-input"
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
                <fieldset className="scope-grid">
                  <legend>API key scopes</legend>
                  {API_TOKEN_SCOPE_OPTIONS.map((option) => (
                    <label className="role-toggle" key={option.scope}>
                      <input
                        checked={apiTokenScopes.includes(option.scope)}
                        onChange={() => setApiTokenScopes((current) => toggleApiTokenScope(current, option.scope))}
                        type="checkbox"
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="settings-submit-row">
                  <Button className="save-button shadcn-action-button" disabled={state === "loading" || !apiTokenName.trim() || apiTokenScopes.length === 0} size="sm" type="submit">
                    <KeyRound size={16} aria-hidden="true" />
                    Create key
                  </Button>
                </div>
              </form>
              {createdApiToken && (
                <div className="token-reveal" role="status">
                  <span>Copy this key now. It will not be shown again.</span>
                  <code>{createdApiToken}</code>
                  <CopyButton text={createdApiToken} />
                </div>
              )}
              {accountInitialLoading ? <LoadingRows /> : <TokenList tokens={apiTokens} onRevoke={(tokenId) => void revokeAccountApiToken(tokenId)} />}
            </div>
          </AccountPanel>

          <AccountPanel icon={<Fingerprint size={18} aria-hidden="true" />} title="Passkeys" meta="Planned security option">
            <div className="passkey-panel">
              <StatusToken value="planned" />
              <p>Passkeys can be added after WebAuthn credential storage, challenge expiry, relying-party ID, and origin checks are implemented in the API.</p>
            </div>
          </AccountPanel>
        </section>
      </div>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function SettingsMetric({ label, strong, value }: { label: string; strong?: boolean; value: string }) {
  return (
    <div className={strong ? "settings-metric strong" : "settings-metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AccountPanel({ children, icon, meta, title }: {
  children: ReactNode;
  icon: ReactNode;
  meta: string;
  title: string;
}) {
  return (
    <section className="settings-panel reui-settings-section">
      <Frame className="reui-settings-frame" dense spacing="xs" variant="ghost">
        <FramePanel className="reui-settings-panel">
          <FrameHeader className="settings-panel-heading reui-settings-heading">
            <span className="settings-panel-icon">{icon}</span>
            <div>
              <FrameTitle>{title}</FrameTitle>
              <FrameDescription>{meta}</FrameDescription>
            </div>
          </FrameHeader>
          {children}
        </FramePanel>
      </Frame>
    </section>
  );
}

function TokenList({ tokens, onRevoke }: { tokens: ApiToken[]; onRevoke: (tokenId: string) => void }) {
  return (
    <div className="token-list">
      {tokens.map((token) => (
        <div className="token-row" key={token.id}>
          <span className="cell-main">
            <strong>{token.name}</strong>
            <small>{token.tokenPrefix}… · {token.scopes.join(", ")}</small>
          </span>
          <StatusToken value={token.revokedAt ? "revoked" : "active"} />
          <span>Expires {formatDate(token.expiresAt)}</span>
          <span>{token.lastUsedAt ? `Used ${formatDate(token.lastUsedAt)}` : "Never used"}</span>
          <button className="icon-button" disabled={Boolean(token.revokedAt)} type="button" onClick={() => onRevoke(token.id)} aria-label={`Revoke ${token.name}`}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      {tokens.length === 0 && (
        <div className="empty-state compact">
          <KeyRound size={22} aria-hidden="true" />
          <strong>No API keys.</strong>
          <span>Create a scoped key for CLI, MCP, or automation access.</span>
        </div>
      )}
    </div>
  );
}

function IconButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function CopyButton({ text, variant }: { text: string; variant?: "outline" }) {
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
    }
  }

  return (
    <>
      <Button className="shadcn-action-button" disabled={status === "copying"} size="sm" type="button" variant={variant} onClick={() => void copy()}>
        <Copy size={15} aria-hidden="true" />
        {status === "copying" ? "Copying…" : status === "copied" ? "Copied" : "Copy"}
      </Button>
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
    <div className="role-editor">
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
            <span>{role}</span>
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

function releaseActionConfirmationDescription(action: ReleaseLifecycleActionName): string {
  switch (action) {
    case "delete":
      return "This release will be removed and cannot be restored from this screen. Record why deletion is required.";
    case "revoke":
      return "Install and export access will be revoked for this release. Record the security or governance reason.";
    case "unpublish":
      return "The release will no longer be available from public registry surfaces. Record why it must be withdrawn.";
    case "deprecate":
      return "The release remains discoverable but will be marked as deprecated. Record the migration or support reason.";
    case "restore":
      return "The release will return to the lifecycle state allowed by its review and security status.";
  }
}

function AuthWidget({
  authMessage,
  authState,
  client,
  mfaPending,
  onLogin,
  onLogout,
  onPasswordReset,
  onVerifyMfa,
  session,
}: {
  authMessage: string | null;
  authState: AuthState;
  client?: RegistryClient;
  mfaPending: MfaPending | null;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  onPasswordReset?: (input: { email: string }) => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
  session: WebSession | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);
  const [resetMode, setResetMode] = useState(false);

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
        void onPasswordReset({ email }).then(() => setResetMode(false));
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
            spellCheck={false}
            type="email"
            value={email}
          />
        </label>
        <Button className="shadcn-action-button" disabled={authState === "loading" || !email.trim()} size="sm" type="submit">
          <Mail size={16} aria-hidden="true" />
          Send reset email
        </Button>
        <Button className="link-button shadcn-action-button" disabled={authState === "loading"} size="sm" type="button" variant="link" onClick={() => setResetMode(false)}>
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
        <Button className="link-button shadcn-action-button" disabled={authState === "loading"} size="sm" type="button" variant="link" onClick={() => setResetMode(true)}>
          Forgot password?
        </Button>
      )}
      <p className="auth-help">Access is limited to approved hosted-beta accounts.</p>
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

function ReleaseHistoryControls({
  historyState,
  latestVersion,
  onRetry,
  onReturn,
  onSelect,
  releases,
  selectedVersion,
}: {
  historyState: LoadState;
  latestVersion: string | null;
  onRetry: () => void;
  onReturn: () => void;
  onSelect: (version: string) => void;
  releases: SkillReleaseSummary[];
  selectedVersion: string | null;
}) {
  const missingPin = selectedVersion !== null && !releases.some((item) => item.version === selectedVersion);
  return (
    <div className="registry-version-control">
      {historyState === "loading" && <p className="control-plane-muted" role="status">Loading release history…</p>}
      {historyState === "ready" && releases.length === 0 && <p className="control-plane-muted" role="status">No published release history is available.</p>}
      {historyState === "error" && (
        <div role="status">
          <p className="control-plane-muted">Release history is unavailable.</p>
          <Button size="sm" type="button" variant="outline" onClick={onRetry}>Retry release history</Button>
        </div>
      )}
      {historyState === "ready" && releases.length > 0 && (
        <label>
          <span>Release version</span>
          <select value={selectedVersion ?? latestVersion ?? ""} onChange={(event) => onSelect(event.target.value)}>
            {selectedVersion === null && latestVersion === null && <option value="" disabled>Choose an exact release</option>}
            {selectedVersion !== null && missingPin && <option value={selectedVersion} disabled>Unavailable exact version</option>}
            {releases.map((item) => (
              <option key={item.version} value={item.version}>
                {item.version}{item.version === latestVersion ? " (latest)" : item.lifecycleStatus === "deprecated" ? " (deprecated)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedVersion !== null && <Button size="sm" type="button" variant="outline" onClick={onReturn}>Return to latest</Button>}
    </div>
  );
}

// The inspector body for one exact release: consumer facts and use first,
// optional depth in disclosures, and owner tools last.
function SkillDetail({
  bundles,
  command,
  client,
  disclosures,
  platform,
  release,
  selectedSkill,
  session,
  setDisclosure,
  setPlatform,
  onChanged,
}: {
  /** Optional bundle backlinks, shown after the summary. */
  bundles?: ReactNode;
  command: string;
  client: RegistryClient;
  disclosures: RegistryDisclosures;
  platform: string;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  session: WebSession | null;
  setDisclosure: (key: keyof RegistryDisclosures, open: boolean) => void;
  setPlatform: (platform: string) => void;
  onChanged: () => void;
}) {
  const supportedPlatforms = release.platforms.filter((item) => item.status === "supported");
  const hasSupportedPlatform = supportedPlatforms.length > 0;
  const canManageSkill = Boolean(session && selectedSkill.access?.canManageSharing);
  const canUsePrivilegedControls = Boolean(canManageSkill && session?.user.mfaVerified);
  // Owner tools load on first open and stay mounted so drafts survive closing.
  const [ownerVisited, setOwnerVisited] = useState(disclosures.owner);
  const baseId = useId();
  const compatibility = release.compatibility && Object.keys(release.compatibility).length > 0 ? release.compatibility : null;

  function toggleOwner() {
    if (!disclosures.owner) setOwnerVisited(true);
    setDisclosure("owner", !disclosures.owner);
  }

  return (
    <div className="registry-inspector-body">
      <p className="registry-summary">{selectedSkill.summary}</p>
      {bundles}

      <dl className="registry-facts registry-section">
        <RegistryFact label="Released">{release.publishedAt ? formatDate(release.publishedAt) : "Not published"}</RegistryFact>
        <RegistryFact label="Review"><RegistryStatus value={release.reviewStatus} /></RegistryFact>
        <RegistryFact label="Security"><RegistryStatus value={release.securityStatus} /></RegistryFact>
        <RegistryFact label="Platforms">{hasSupportedPlatform
          ? supportedPlatforms.map((item) => item.name).join(", ")
          : release.platforms.map((item) => `${item.name} (${item.status})`).join(", ") || "None declared"}</RegistryFact>
        <RegistryFact label="Byte size">{new Intl.NumberFormat().format(release.artifact.byteSize)}</RegistryFact>
        <RegistryFact label="Content type" mono>{release.artifact.contentType}</RegistryFact>
        <RegistryFact label="SHA-256" mono>{release.artifact.sha256}</RegistryFact>
        {selectedSkill.tags.length > 0 && <RegistryFact label="Tags">{selectedSkill.tags.join(", ")}</RegistryFact>}
      </dl>

      {hasSupportedPlatform ? (
        <section className="registry-section registry-use" aria-labelledby={`${baseId}-use`}>
          <h3 id={`${baseId}-use`}>Use this release</h3>
          {release.requiresUserAction && (
            <p className="registry-callout" data-tone="amber">
              <CircleAlert size={16} aria-hidden="true" />
              This release requires a user action. Review the instructions before updating.
            </p>
          )}
          <div className="registry-platforms">
            <span id={`${baseId}-platform`}>Export platform</span>
            <div role="group" aria-labelledby={`${baseId}-platform`}>
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
          </div>
          <div className="command-panel registry-command">
            <span className="registry-command-label">
              <TerminalSquare size={14} aria-hidden="true" />
              CLI export
            </span>
            <div className="registry-command-row">
              <code>{command}</code>
              <CopyButton text={command} variant="outline" />
            </div>
          </div>
          <p className="registry-muted">For a personal Codex workspace, follow <a href="/targets">Connect a Codex workspace</a> to enroll the directory and install this exact version with the matching CLI release.</p>
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

      <div className="registry-section registry-more">
        <details className="registry-details" open={disclosures.notes}>
          <summary onClick={(event) => {
            // Save the preference before a release change can unmount the disclosure.
            event.preventDefault();
            setDisclosure("notes", !disclosures.notes);
          }}>
            <span>Release notes for {release.version}</span>
            {release.changeKind && <span className="registry-chip registry-change-kind">{release.changeKind}</span>}
          </summary>
          <div className="registry-details-body">
            <p className="registry-notes">{release.releaseNotes || "No release notes were supplied for this release."}</p>
            {compatibility && (
              <dl className="registry-facts" data-labels="wide">
                <RegistryFact label="Minimum MySkills">{compatibility.minimumMyskillsVersion ?? "Any"}</RegistryFact>
                <RegistryFact label="Minimum adapter contract">{compatibility.minimumAdapterContractVersion?.toString() ?? "Any"}</RegistryFact>
                <RegistryFact label="Minimum source version">{compatibility.minimumSourceVersion ?? "Any"}</RegistryFact>
              </dl>
            )}
          </div>
        </details>

        {hasSupportedPlatform && client.getReleaseBundle && <PackageFileViewer
          resourceKey={`${selectedSkill.slug}:${release.version}:${platform}`}
          loadBundle={() => client.getReleaseBundle!(selectedSkill.slug, release.version, platform)}
        />}

        {client.improvements && (
          <div className="registry-disclosure">
            <button
              aria-controls={`${baseId}-improvement`}
              aria-expanded={disclosures.improvement}
              className="registry-disclosure-button"
              type="button"
              onClick={() => setDisclosure("improvement", !disclosures.improvement)}
            >
              Compatibility and improvement
            </button>
            {/* Stays mounted so compatibility evidence and planner drafts persist. */}
            <div className="registry-disclosure-body" hidden={!disclosures.improvement} id={`${baseId}-improvement`}>
              <SkillImprovementPanel key={`${release.slug}:${release.version}`} client={client} release={release} user={session?.user ?? null} canManage={canManageSkill} visibility={selectedSkill.visibility} />
            </div>
          </div>
        )}
      </div>

      {canManageSkill && (
        <div className="registry-section registry-owner">
          <div className="registry-owner-head">
            <button
              aria-controls={`${baseId}-owner`}
              aria-expanded={disclosures.owner}
              className="registry-disclosure-button"
              type="button"
              onClick={toggleOwner}
            >
              Owner controls
            </button>
            {!canUsePrivilegedControls && (
              <span className="registry-owner-hint">
                <LockKeyhole size={14} aria-hidden="true" />
                Locked until MFA
              </span>
            )}
          </div>
          <div className="registry-disclosure-body registry-owner-panel" hidden={!disclosures.owner} id={`${baseId}-owner`}>
            {(disclosures.owner || ownerVisited) && (canUsePrivilegedControls && session ? (
              <>
                <LifecyclePanel
                  client={client}
                  release={release}
                  selectedSkill={selectedSkill}
                  session={session}
                  onChanged={onChanged}
                />
                <SharingPanel client={client} selectedSkill={selectedSkill} session={session} />
              </>
            ) : <PrivilegedControlsLocked />)}
          </div>
        </div>
      )}
    </div>
  );
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

function PrivilegedControlsLocked() {
  return (
    <section className="privileged-controls-locked" role="status" aria-labelledby="privileged-controls-heading">
      <LockKeyhole size={20} aria-hidden="true" />
      <div>
        <h2 id="privileged-controls-heading">Lifecycle and sharing controls are locked</h2>
        <p>Sign in with MFA before changing lifecycle state, release availability, metadata, or sharing access.</p>
      </div>
      <a href="/settings">Review security settings</a>
    </section>
  );
}

function LifecyclePanel({
  client,
  release,
  selectedSkill,
  session,
  onChanged,
}: {
  client: RegistryClient;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  session: WebSession;
  onChanged: () => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [releases, setReleases] = useState<SkillReleaseSummary[]>([]);
  const [title, setTitle] = useState(selectedSkill.title);
  const [summary, setSummary] = useState(selectedSkill.summary);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const currentRelease = releases.find((item) => item.version === release.version);

  const refresh = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      setReleases(await client.listSkillReleases(selectedSkill.slug));
      setState("ready");
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
      setState("error");
    }
  }, [client, selectedSkill.slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function saveMetadata() {
    setMessage(null);
    try {
      await client.updateSkillMetadata({
        slug: selectedSkill.slug,
        title,
        summary,
        reason,
      });
      setMessage("Skill metadata saved.");
      setReason("");
      onChanged();
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
    }
  }

  async function runSkillAction(action: "archive" | "restore" | "delete") {
    if (action === "restore") {
      try {
        await commitSkillAction(action, reason);
      } catch {
        // The safe error is already rendered by commitSkillAction.
      }
      return;
    }
    setConfirmation({
      key: `skill-${action}`,
      title: action === "delete" ? "Delete this skill?" : "Archive this skill?",
      description: action === "delete"
        ? "The skill and its public discovery path will be removed. Record why this destructive action is required."
        : "The skill will be removed from active discovery until it is restored.",
      confirmLabel: action === "delete" ? "Delete skill" : "Archive skill",
      destructive: action === "delete",
      initialReason: reason,
      requireReason: true,
      onConfirm: (confirmedReason) => commitSkillAction(action, confirmedReason),
    });
  }

  async function commitSkillAction(action: "archive" | "restore" | "delete", confirmedReason: string) {
    setMessage(null);
    try {
      await client.performSkillAction(selectedSkill.slug, action, confirmedReason || undefined);
      setMessage(`Skill ${formatStatusLabel(action).toLowerCase()} complete.`);
      setReason("");
      onChanged();
    } catch (error) {
      const safeMessage = safeReviewErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  async function runReleaseAction(action: ReleaseLifecycleActionName) {
    setConfirmation({
      key: `release-${action}`,
      title: `${formatStatusLabel(action)} this release?`,
      description: releaseActionConfirmationDescription(action),
      confirmLabel: `${formatStatusLabel(action)} release`,
      destructive: action === "delete" || action === "revoke" || action === "unpublish",
      initialReason: reason,
      requireReason: action !== "restore",
      onConfirm: (confirmedReason) => commitReleaseAction(action, confirmedReason),
    });
  }

  async function commitReleaseAction(action: ReleaseLifecycleActionName, confirmedReason: string) {
    setMessage(null);
    try {
      await client.performReleaseAction(selectedSkill.slug, release.version, action, confirmedReason || undefined, undefined);
      setMessage(`Release ${formatStatusLabel(action).toLowerCase()} complete.`);
      setReason("");
      onChanged();
    } catch (error) {
      const safeMessage = safeReviewErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  return (
    <Frame className="lifecycle-panel reui-registry-frame" role="region" aria-label="Skill lifecycle controls" spacing="sm">
      <FramePanel className="reui-registry-panel">
        <FrameHeader className="admin-panel-heading reui-admin-heading reui-registry-heading">
          <span className="admin-panel-icon"><Settings size={18} aria-hidden="true" /></span>
          <div>
            <FrameTitle>Lifecycle controls</FrameTitle>
            <FrameDescription aria-live="polite">{state === "loading" ? "Loading release state…" : `${releases.length} versions tracked`}</FrameDescription>
          </div>
        </FrameHeader>
        {message && <div className="safe-message compact" role="status">{message}</div>}
        <div className="metadata-edit-grid">
          <label>
            Title
            <Input className="registry-input" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Summary
            <Input className="registry-input" value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <label className="reason-field">
            Reason
            <Input className="registry-input" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <Button className="save-button compact-button shadcn-action-button" size="sm" type="button" onClick={() => void saveMetadata()}>
            <Save size={15} aria-hidden="true" />
            Save metadata
          </Button>
        </div>
        <div className="lifecycle-actions">
          <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="button" variant="outline" onClick={() => void runSkillAction("archive")}>
            <PackageOpen size={15} aria-hidden="true" />
            Archive skill
          </Button>
          <Button className="shadcn-action-button" disabled={state === "loading"} size="sm" type="button" variant="outline" onClick={() => void runSkillAction("restore")}>
            <RotateCw size={15} aria-hidden="true" />
            Restore skill
          </Button>
          <Button className="registry-danger-button shadcn-action-button" disabled={state === "loading"} size="sm" type="button" variant="outline" onClick={() => void runSkillAction("delete")}>
            <Trash2 size={15} aria-hidden="true" />
            Delete skill
          </Button>
        </div>
        <div className="release-lifecycle-list">
          {(currentRelease ? [currentRelease] : releases.slice(0, 1)).map((item) => (
            <div className="release-lifecycle-row" key={item.id}>
              <div className="release-lifecycle-meta">
                <span>
                  <strong>{item.slug}@{item.version}</strong>
                  <small>{item.publishedAt ? formatDate(item.publishedAt) : "not published"}</small>
                </span>
                <span className="release-lifecycle-statuses">
                  <StatusToken value={item.lifecycleStatus} />
                  <StatusToken value={item.reviewStatus} />
                  <StatusToken value={item.securityStatus} />
                </span>
              </div>
              <div className="release-lifecycle-actions">
                {item.allowedActions.map((action) => (
                  <Button
                    className={action === "delete" || action === "revoke" ? "registry-danger-button compact-button shadcn-action-button" : "compact-button shadcn-action-button"}
                    key={action}
                    disabled={state === "loading"}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => void runReleaseAction(action)}
                  >
                    {formatStatusLabel(action)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
      </FramePanel>
    </Frame>
  );
}

export function SharingPanel({
  client,
  selectedSkill,
  session,
}: {
  client: RegistryClient;
  selectedSkill: PublicSkill;
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

function Metadata({ label, monospace, value }: { label: string; value: string; monospace?: boolean }) {
  return (
    <div className="metadata-item">
      <dt>{label}</dt>
      <dd className={monospace ? "mono" : undefined}>{value}</dd>
    </div>
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

function isPublishedRelease(release: Pick<SkillReleaseSummary, "lifecycleStatus" | "reviewStatus" | "securityStatus" | "publishedAt">): boolean {
  return (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated")
    && release.reviewStatus === "approved"
    && release.securityStatus === "passed"
    && typeof release.publishedAt === "string"
    && Number.isFinite(Date.parse(release.publishedAt));
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
  if (pathname === "/manage/skills") return "manage";
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
  if (pathname === "/architectures") {
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
  if (view === "manage") return "/manage/skills";
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

function registryUrl(slug: string | null, query: string, platform: string, version: string | null = null, catalog?: CatalogLocation): string {
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
      return "Only existing approved accounts can access the registry.";
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
