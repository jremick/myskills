import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Boxes,
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
  KeyRound,
  Link2,
  LockKeyhole,
  LogIn,
  LogOut,
  Mail,
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
import type { PublicSkill, SkillSharingDetails, TeamSharedSkillGroup, VisibilityScope } from "@myskills-app/core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { ArchitecturesDashboard } from "@/components/architecture/ArchitecturesDashboard";
import { OrganizationsDashboard } from "@/components/organization/OrganizationsDashboard";
import { ArchitectureTargetsDashboard } from "@/components/target/ArchitectureTargetsDashboard";
import { SystemUpdateCenter } from "@/components/update/SystemUpdateCenter";
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

interface RegistryAppProps {
  client?: RegistryClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AuthState = "idle" | "loading" | "mfa";
type AppView = "landing" | "login" | "register" | "reset-password" | "verify-email" | "change-email" | "browse" | "architectures" | "organizations" | "targets" | "updates" | "admin" | "review" | "submit" | "teams" | "settings" | "not-found";

interface AppLocation {
  view: AppView;
  slug: string | null;
  query: string;
  platform: string;
}

type ArchitectureNavigationGuard = (action: string) => boolean;

const APP_HISTORY_INDEX_KEY = "__myskillsAppHistoryIndex";

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

interface ConfirmationRequest {
  key: string;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  initialReason?: string;
  requireReason?: boolean;
  onConfirm: (reason: string) => Promise<void>;
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
  { scope: "review:read", label: "Review read" },
  { scope: "review:write", label: "Review write" },
  { scope: "targets:execute", label: "Execute target updates" },
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
  const [query, setQuery] = useState(initialLocation.query);
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialLocation.slug);
  const [selectedSkill, setSelectedSkill] = useState<PublicSkill | null>(null);
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [platform, setPlatform] = useState(initialLocation.platform);
  const [listState, setListState] = useState<LoadState>("idle");
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMoreMenuRef = useRef<HTMLDivElement>(null);
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
      setView(next.view);
      setSelectedSlug(next.slug);
      setQuery(next.query);
      setPlatform(next.platform);
      setMobileMoreOpen(false);
    }
    window.addEventListener("popstate", syncFromBrowserHistory);
    return () => window.removeEventListener("popstate", syncFromBrowserHistory);
  }, []);

  useEffect(() => {
    if (!mobileMoreOpen) {
      return;
    }
    mobileMoreMenuRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setMobileMoreOpen(false);
      queueMicrotask(() => mobileMoreButtonRef.current?.focus());
    }
    function closeOnOutsideClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof window.Node)) {
        return;
      }
      if (!mobileMoreMenuRef.current?.contains(target) && !mobileMoreButtonRef.current?.contains(target)) {
        setMobileMoreOpen(false);
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", closeOnOutsideClick);
    };
  }, [mobileMoreOpen]);

  useEffect(() => {
    if (!session && !isPublicView(view)) {
      setView("login");
      replaceAppHistory("/login");
      return;
    }
    if (session && view !== activeView) {
      setView(activeView);
      replaceAppHistory(activeView === "browse" ? browseUrl(selectedSlug, query, platform) : pathForView(activeView));
      return;
    }
    if (session && view === "login") {
      setView("browse");
      replaceAppHistory("/registry");
    }
  }, [activeView, platform, query, selectedSlug, session, view]);

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
      .catch(() => {
        if (!active) {
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
    if (activeView !== "browse") {
      setListState("idle");
      return;
    }
    let active = true;
    setListState("loading");
    setListMessage(null);
    registryClient.searchSkills(query)
      .then((result) => {
        if (!active) {
          return;
        }
        setSkills(result);
        setListMessage(null);
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSkills([]);
        setSelectedSlug(null);
        setListMessage(safeErrorMessage(error));
        setListState("error");
      });
    return () => {
      active = false;
    };
  }, [activeView, registryClient, query, refreshKey]);

  useEffect(() => {
    if (activeView !== "browse" || listState !== "ready") {
      return;
    }
    if (currentLocationRef.current.view !== "browse") {
      return;
    }
    const nextSlug = selectedSlug && skills.some((skill) => skill.slug === selectedSlug)
      ? selectedSlug
      : skills[0]?.slug ?? null;
    if (nextSlug !== selectedSlug) {
      setSelectedSlug(nextSlug);
    }
    const nextUrl = browseUrl(nextSlug, query, platform);
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      replaceAppHistory(nextUrl);
    }
  }, [activeView, listState, platform, query, selectedSlug, skills]);

  useEffect(() => {
    if (activeView !== "browse") {
      setSelectedSkill(null);
      setRelease(null);
      setDetailState("idle");
      return;
    }
    if (!selectedSlug) {
      setSelectedSkill(null);
      setRelease(null);
      setDetailState("idle");
      return;
    }
    let active = true;
    setDetailState("loading");
    setDetailMessage(null);
    registryClient.getSkill(selectedSlug)
      .then(async (skill) => {
        const latestVersion = skill.latestVersion;
        const nextRelease = latestVersion ? await registryClient.getRelease(skill.slug, latestVersion) : null;
        if (!active) {
          return;
        }
        setSelectedSkill(skill);
        setRelease(nextRelease);
        setDetailMessage(null);
        const availablePlatforms = nextRelease?.platforms ?? skill.platforms;
        setPlatform((current) => availablePlatforms.some((item) => item.name === current)
          ? current
          : preferredPlatform(availablePlatforms));
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSelectedSkill(null);
        setRelease(null);
        setDetailMessage(safeErrorMessage(error));
        setDetailState("error");
      });
    return () => {
      active = false;
    };
  }, [activeView, registryClient, selectedSlug, refreshKey]);

  const selectedCommand = useMemo(() => (
    selectedSkill && release ? exportCommand(selectedSkill.slug, release.version, platform) : ""
  ), [platform, release, selectedSkill]);

  function selectSkill(slug: string) {
    setView("browse");
    setSelectedSlug(slug);
    pushAppHistory(browseUrl(slug, query, platform));
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
    const nextSlug = selectedSlug ?? skills[0]?.slug ?? null;
    setSelectedSlug(nextSlug);
    pushAppHistory(browseUrl(nextSlug, query, platform));
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
      const nextSlug = selectedSlug ?? skills[0]?.slug ?? null;
      setSelectedSlug(nextSlug);
      pushAppHistory(browseUrl(nextSlug, query, platform));
    } else {
      pushAppHistory(pathForView(nextView));
    }
    setMobileMoreOpen(false);
  }

  function handleAppLink(event: ReactMouseEvent<HTMLAnchorElement>, nextView: AppView) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigateTo(nextView);
  }

  function updateSearch(nextQuery: string) {
    setQuery(nextQuery);
    replaceAppHistory(browseUrl(selectedSlug, nextQuery, platform));
  }

  function updatePlatform(nextPlatform: string) {
    setPlatform(nextPlatform);
    replaceAppHistory(browseUrl(selectedSlug, query, nextPlatform));
  }

  if (activeView === "landing") {
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
    return <NotFoundPage onHome={openLanding} />;
  }

  const navItems = [
    { view: "browse" as const, label: "Registry", group: "Library" as const, icon: <Boxes size={18} aria-hidden="true" />, enabled: true },
    { view: "architectures" as const, label: "Architectures", group: "Build" as const, icon: <Workflow size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "submit" as const, label: "Submit", group: "Build" as const, icon: <Upload size={18} aria-hidden="true" />, enabled: canUseSubmit },
    { view: "review" as const, label: "Review", group: "Govern" as const, icon: <ClipboardList size={18} aria-hidden="true" />, enabled: canUseReview },
    { view: "teams" as const, label: "Teams", group: "Govern" as const, icon: <UsersRound size={18} aria-hidden="true" />, enabled: canUseTeams },
    { view: "organizations" as const, label: "Organizations", group: "Govern" as const, icon: <UsersRound size={18} aria-hidden="true" />, enabled: canUseOrganizations },
    { view: "targets" as const, label: "Connected targets", group: "Observe" as const, icon: <Link2 size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "updates" as const, label: "Updates", group: "Observe" as const, icon: <RotateCw size={18} aria-hidden="true" />, enabled: canUseTargets },
    { view: "admin" as const, label: "Admin", group: "Account" as const, icon: <Settings size={18} aria-hidden="true" />, enabled: canUseAdmin },
    { view: "settings" as const, label: "Settings", group: "Account" as const, icon: <UserCog size={18} aria-hidden="true" />, enabled: Boolean(session) },
    { view: "login" as const, label: "Login", group: "Account" as const, icon: <LogIn size={18} aria-hidden="true" />, enabled: !session },
  ].filter((item) => item.enabled);
  const navGroups = (["Library", "Build", "Govern", "Observe", "Account"] as const)
    .map((label) => ({ label, items: navItems.filter((item) => item.group === label) }))
    .filter((group) => group.items.length > 0);
  const mobilePriority = ["browse", "architectures", "review", "targets", "submit"] as const;
  const mobilePrimaryItems = mobilePriority
    .map((view) => navItems.find((item) => item.view === view))
    .filter((item): item is (typeof navItems)[number] => Boolean(item))
    .slice(0, 4);
  const mobilePrimaryViews = new Set(mobilePrimaryItems.map((item) => item.view));
  const mobileOverflowItems = navItems.filter((item) => !mobilePrimaryViews.has(item.view));

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
        {activeView === "browse" && (
          <header className="app-topbar">
            <a className="mobile-brand" href="/registry" onClick={(event) => {
              handleAppLink(event, "browse");
            }}>
              <img src="/brand/myskills-mark.svg" alt="" width={100} height={100} />
              <span>MySkills</span>
            </a>
            <label className="global-search" htmlFor="skill-search">
              <Search size={18} aria-hidden="true" />
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
              <kbd>/</kbd>
            </label>
          </header>
        )}

        <div className="app-content" id="main-content" tabIndex={-1}>
          {activeView === "review" && session ? (
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
          ) : (
            <main className="workspace shadcn-registry-workspace shadcn-registry-layout">
              <header className="registry-page-header">
                <div>
                  <span className="registry-page-eyebrow">Library / approved catalogue</span>
                  <div className="registry-page-title-row">
                    <h1>Skill registry</h1>
                    <Badge className="registry-count-badge" variant="outline" aria-live="polite">
                      {listState === "ready" ? `${skills.length} approved` : resultCountText(listState, skills.length)}
                    </Badge>
                  </div>
                  <p>Find an exact release, inspect its trust evidence, and carry the approved reference into your workflow.</p>
                </div>
              </header>
              <Card className="results-panel registry-results-panel shadcn-console-card" aria-label="Skill search results">
                <CardHeader className="panel-heading review-registry-heading shadcn-card-header">
                  <div>
                    <CardTitle>Approved skills</CardTitle>
                    <CardDescription aria-live="polite">{resultCountText(listState, skills.length)}</CardDescription>
                  </div>
                  <span className="registry-panel-note">Exact references</span>
                </CardHeader>
                <CardContent className="review-card-content registry-card-content">
                  <div className="result-list shadcn-review-list registry-result-list">
                    {listState === "loading" && <LoadingRows />}
                    {listState === "error" && (
                      <div className="safe-message panel-state" role="status" aria-live="polite">
                        <CircleAlert size={24} aria-hidden="true" />
                        <strong>{listMessage ?? "The registry is not available."}</strong>
                        <span>The list could not load. Retry the registry request before selecting a skill.</span>
                        <Button className="state-action shadcn-action-button" size="sm" type="button" variant="outline" onClick={retryRegistry}>
                          <RotateCw size={15} aria-hidden="true" />
                          Retry
                        </Button>
                      </div>
                    )}
                    {listState !== "loading" && listState !== "error" && skills.map((skill) => (
                      <a
                        aria-current={skill.slug === selectedSlug ? "true" : undefined}
                        className={skill.slug === selectedSlug ? "result-row review-registry-row registry-result-row selected" : "result-row review-registry-row registry-result-row"}
                        href={browseUrl(skill.slug, query, platform)}
                        key={skill.slug}
                        onClick={(event) => handleCallbackLink(event, () => selectSkill(skill.slug))}
                      >
                        <SkillIcon slug={skill.slug} />
                        <span className="result-main review-registry-main">
                          <strong>{skill.title}</strong>
                          <span>{skill.slug}</span>
                          <span className="tag-row review-registry-tags">{skill.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</span>
                        </span>
                        <span className="registry-result-meta">
                          <Badge className="registry-version-badge" variant="secondary">{skill.latestVersion ?? "-"}</Badge>
                          <span className="registry-visibility">{formatStatusLabel(skill.visibility)}</span>
                          <span className="platform-icons">{skill.platforms.slice(0, 2).map((item) => item.name).join(", ")}</span>
                        </span>
                      </a>
                    ))}
                    {listState === "ready" && skills.length === 0 && (
                      <div className="empty-state">
                        <CircleAlert size={22} aria-hidden="true" />
                        <strong>No skills found.</strong>
                        <span>{query.trim() ? `No approved skills match "${query.trim()}".` : "Approved skills will appear here after publication."}</span>
                        {query.trim() && (
                          <Button className="state-action shadcn-action-button" size="sm" type="button" variant="outline" onClick={() => setQuery("")}>
                            Clear search
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="detail-panel registry-detail-panel shadcn-console-card" aria-label="Selected skill detail">
                {detailMessage && (
                  <CardContent className="registry-state-content">
                    <div className="safe-message panel-state" role="status" aria-live="polite">
                      <CircleAlert size={24} aria-hidden="true" />
                      <strong>{detailMessage}</strong>
                      <span>The selected skill could not load. Retry the request or choose a different approved skill.</span>
                      <Button className="state-action shadcn-action-button" size="sm" type="button" variant="outline" onClick={retryRegistry}>
                        <RotateCw size={15} aria-hidden="true" />
                        Retry
                      </Button>
                    </div>
                  </CardContent>
                )}
                {detailState === "loading" && <DetailSkeleton />}
                {detailState !== "loading" && !detailMessage && selectedSkill && release && (
                  <SkillDetail
                    command={selectedCommand}
                    client={registryClient}
                    platform={platform}
                    release={release}
                    selectedSkill={selectedSkill}
                    session={session}
                    setPlatform={updatePlatform}
                  />
                )}
                {detailState !== "loading" && !selectedSkill && !detailMessage && (
                  <CardContent className="registry-state-content">
                    <div className="empty-detail">
                      <FileCode2 size={42} aria-hidden="true" />
                      <h2>Select a skill</h2>
                      <p>Choose an approved skill to inspect release metadata and export guidance.</p>
                    </div>
                  </CardContent>
                )}
              </Card>
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
          {mobileOverflowItems.length > 0 && (
            <>
              <button
                aria-controls="mobile-more-navigation"
                aria-expanded={mobileMoreOpen}
                className={mobileOverflowItems.some((item) => item.view === activeView) ? "mobile-nav-item active" : "mobile-nav-item"}
                ref={mobileMoreButtonRef}
                type="button"
                onClick={() => setMobileMoreOpen((open) => !open)}
              >
                <Ellipsis size={18} aria-hidden="true" />
                <span>More</span>
              </button>
              {mobileMoreOpen && (
                <div className="mobile-more-menu" id="mobile-more-navigation" ref={mobileMoreMenuRef}>
                  {mobileOverflowItems.map((item) => (
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
              )}
            </>
          )}
        </nav>
      </div>
    </div>
  );
}

function MarketingLanding({ onLogin }: { onLogin: () => void }) {
  return (
    <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <main className="landing-page" id="main-content">
      <section className="landing-hero" aria-label="MySkills public beta landing page">
        <nav className="landing-nav" aria-label="Marketing navigation">
          <a className="landing-brand" href="/">
            <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} />
          </a>
          <div className="landing-links">
            <a href="#registry">Registry</a>
            <a href="#trust">Trust model</a>
            <a href="#beta-status">Status</a>
            <Button asChild className="shadcn-action-button" size="sm">
              <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>Login</a>
            </Button>
          </div>
        </nav>

        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <p className="landing-status">Public beta. Hosted signups are owner-gated.</p>
            <h1>MySkills</h1>
            <p className="landing-lede">
              A governed registry for packaging, reviewing, publishing, and installing reusable AI agent skills across web, CLI, API, and MCP surfaces.
            </p>
            <div className="landing-actions">
              <Button asChild className="landing-primary shadcn-action-button" size="sm">
                <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>
                  Login
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              </Button>
              <a className="landing-secondary" href="#beta-status">Read current status</a>
            </div>
          </div>
          <LandingPreview />
        </div>
      </section>

      <section className="landing-band" id="registry" aria-labelledby="registry-heading">
        <div className="landing-section-heading">
          <span>Registry foundation</span>
          <h2 id="registry-heading">Built around reviewed releases, not loose prompt folders.</h2>
        </div>
        <div className="landing-feature-layout">
          <article className="landing-feature featured">
            <Boxes size={24} aria-hidden="true" />
            <h3>Versioned skill packages</h3>
            <p>Semantic releases, artifact checksums, supported platforms, and install or rollback flows stay tied to a specific skill version.</p>
          </article>
          <div className="landing-feature-stack">
            <article className="landing-feature">
              <ShieldCheck size={24} aria-hidden="true" />
              <h3>Maintainer review</h3>
              <p>Submissions pass through validation, scan evidence, role-aware review, and publish decisions before they become installable.</p>
            </article>
            <article className="landing-feature">
              <Fingerprint size={24} aria-hidden="true" />
              <h3>Shared authorization</h3>
              <p>The API owns registry decisions so web, CLI, and MCP clients use one permission boundary instead of separate local assumptions.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="landing-band landing-split" id="trust" aria-labelledby="trust-heading">
        <div>
          <span className="landing-kicker">Trust boundary</span>
          <h2 id="trust-heading">Designed for governed teams before broad public onboarding.</h2>
        </div>
        <div className="landing-checks">
          <p><KeyRound size={18} aria-hidden="true" /> First-party accounts, MFA, scoped API tokens, and owner-controlled registration.</p>
          <p><LockKeyhole size={18} aria-hidden="true" /> Package artifacts live behind authenticated delivery and integrity checks.</p>
          <p><ShieldCheck size={18} aria-hidden="true" /> MCP starts read-only with discovery and install guidance, not package execution.</p>
        </div>
      </section>

      <section className="landing-band landing-status-band" id="beta-status" aria-labelledby="status-heading">
        <div className="landing-section-heading">
          <span>Current status</span>
          <h2 id="status-heading">Public beta release is live.</h2>
          <p>
            MySkills is available for external trial use and experimental self-hosting. This hosted registry remains owner-gated while public account creation, abuse handling, and support workflows mature.
          </p>
        </div>
        <Button asChild className="landing-primary shadcn-action-button" size="sm">
          <a href="/login" onClick={(event) => handleCallbackLink(event, onLogin)}>
            Login
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </Button>
      </section>
    </main>
    </>
  );
}

function LandingPreview() {
  return (
    <aside className="landing-preview" aria-label="Sanitized product preview">
      <div className="preview-chrome">
        <span />
        <span />
        <span />
      </div>
      <div className="preview-body">
        <div className="preview-rail">
          <strong>MySkills</strong>
          <span className="active">Registry</span>
          <span>Review</span>
          <span>Admin</span>
        </div>
        <div className="preview-list">
          <p>No registry content shown</p>
          {[
            ["Governed package release", "reviewed", "0.8.4"],
            ["Private team automation", "pending", "0.3.1"],
            ["Scoped MCP installer", "approved", "1.2.0"],
          ].map(([title, status, version]) => (
            <div className="preview-row" key={title}>
              <span>
                <strong>{title}</strong>
                <small>sanitized preview</small>
              </span>
              <StatusToken value={status} />
              <code>{version}</code>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function LoginPage({
  authMessage,
  authState,
  mfaPending,
  onHome,
  onLogin,
  onPasswordReset,
  onVerifyMfa,
}: {
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
        <a className="landing-brand" href="/" onClick={(event) => handleCallbackLink(event, onHome)}>
          <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" width={360} height={110} />
        </a>
        <Button asChild className="login-back shadcn-action-button" size="sm" variant="outline">
          <a href="/" onClick={(event) => handleCallbackLink(event, onHome)}>Public site</a>
        </Button>
      </nav>
      <section className="login-panel" aria-labelledby="login-heading">
        <p className="landing-status">Public beta. Hosted signups are closed.</p>
        <h1 id="login-heading">Login</h1>
        <p>Use an approved owner or team account to access the hosted beta workspace.</p>
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

function NotFoundPage({ onHome }: { onHome: () => void }) {
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <main className="login-page not-found-page" id="main-content">
        <section className="login-panel" aria-labelledby="not-found-heading">
          <p className="landing-status">404</p>
          <h1 id="not-found-heading">Page not found</h1>
          <p>The address does not match a MySkills page. Return to the public site and choose a current destination.</p>
          <Button asChild className="shadcn-action-button" size="sm">
            <a href="/" onClick={(event) => handleCallbackLink(event, onHome)}>Return home</a>
          </Button>
        </section>
      </main>
    </>
  );
}

function SubmitDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [submissionsState, setSubmissionsState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitSkillResult | null>(null);
  const [submissions, setSubmissions] = useState<UserSubmissionSummary[]>([]);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  async function refreshSubmissions() {
    setSubmissionsState("loading");
    try {
      setSubmissions(await client.listUserSubmissions());
      setSubmissionsState("ready");
    } catch (error) {
      setMessage(safeSubmitErrorMessage(error));
      setSubmissionsState("error");
    }
  }

  useEffect(() => {
    void refreshSubmissions();
  }, [client]);

  async function submitPackage() {
    setMessage(null);
    setResult(null);
    if (!file) {
      setMessage("Choose a package archive before submitting.");
      return;
    }
    if (!isZipArchive(file)) {
      setMessage("Choose a .zip package archive.");
      return;
    }
    if (file.size === 0) {
      setMessage("Package archive is empty.");
      return;
    }
    if (file.size > MAX_WEB_ARCHIVE_BYTES) {
      setMessage("Package archive exceeds 10 MB.");
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
      await refreshSubmissions();
    } catch (error) {
      setMessage(safeSubmitErrorMessage(error));
      setState("error");
    }
  }

  async function exportSubmission(submission: UserSubmissionSummary) {
    setMessage(null);
    setExportingId(submission.id);
    try {
      const bundle = await client.exportUserSubmission(submission.id);
      downloadJsonFile(`${submission.slug}-${submission.version}.myskills.json`, bundle);
    } catch (error) {
      setMessage(safeSubmitErrorMessage(error));
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
      destructive: true,
      requireReason: true,
      onConfirm: (confirmedReason) => commitSubmissionWithdrawal(submission, confirmedReason),
    });
  }

  async function commitSubmissionWithdrawal(submission: UserSubmissionSummary, confirmedReason: string) {
    setMessage(null);
    setActioningId(submission.id);
    try {
      await client.performSubmissionAction(submission.id, "withdraw", confirmedReason);
      await refreshSubmissions();
    } catch (error) {
      const safeMessage = safeSubmitErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    } finally {
      setActioningId(null);
    }
  }

  return (
    <main className="submit-workspace shadcn-submit-workspace" aria-label="Skill package submission">
      <section className="admin-hero shadcn-submit-hero">
        <div>
          <Badge className="shadcn-review-eyebrow" variant="outline">Author workflow</Badge>
          <h1>Submit package</h1>
          <p aria-live="polite">{session.user.email} · {state === "loading" ? "Uploading archive…" : "author submission"}</p>
        </div>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="submit-layout shadcn-submit-layout">
        <Card className="submit-panel shadcn-submit-panel shadcn-console-card" aria-label="Package upload">
          <CardHeader className="admin-panel-heading shadcn-card-header">
            <span className="admin-panel-icon"><Upload size={18} aria-hidden="true" /></span>
            <div>
              <CardTitle>Package archive</CardTitle>
              <CardDescription>{file ? `${file.name} · ${formatBytes(file.size)}` : "No file selected"}</CardDescription>
            </div>
          </CardHeader>

          <CardContent className="submit-form shadcn-submit-form">
            <form className="submit-form-fields" onSubmit={(event) => {
              event.preventDefault();
              void submitPackage();
            }}>
              <div className="submit-guidance">
                <strong>Package requirements</strong>
                <span>.zip archive, 10 MB maximum, semantic version metadata, and no private paths or install hooks without review notes.</span>
              </div>
              <label className="file-picker" htmlFor="package-archive">
                <PackageOpen size={26} aria-hidden="true" />
                <span>
                  <strong>{file?.name ?? "Choose .zip package"}</strong>
                  <small>{file ? formatBytes(file.size) : "Archive upload"}</small>
                </span>
                <input
                  accept=".zip,application/zip,application/x-zip-compressed"
                  id="package-archive"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>

              <Button className="save-button shadcn-action-button" disabled={state === "loading" || !file} size="sm" type="submit">
                <Upload size={16} aria-hidden="true" />
                Submit for review
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="submit-panel submit-result-panel shadcn-submit-panel shadcn-console-card" aria-label="Submission result">
          <CardHeader className="admin-panel-heading shadcn-card-header">
            <span className="admin-panel-icon"><ClipboardList size={18} aria-hidden="true" /></span>
            <div>
              <CardTitle>Submission status</CardTitle>
              <CardDescription>{result ? `${result.submission.slug}@${result.submission.version}` : "Awaiting upload"}</CardDescription>
            </div>
          </CardHeader>

          {result ? (
            <CardContent className="submit-result shadcn-submit-result">
              <div className={result.scan.findings.length > 0 ? "state-banner state-banner-warning" : "state-banner state-banner-success"}>
                {result.scan.findings.length > 0 ? (
                  <>
                    <CircleAlert size={18} aria-hidden="true" />
                    <span>Review the scan warnings before a maintainer approves this package.</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <span>No scan findings. The package is ready for maintainer review.</span>
                  </>
                )}
              </div>
              <dl className="metadata-grid">
                <Metadata label="Submission ID" value={result.submission.id} monospace />
                <Metadata label="Skill" value={result.submission.slug} />
                <Metadata label="Version" value={result.submission.version} />
                <Metadata label="Review" value={result.submission.reviewStatus} />
                <Metadata label="Security" value={result.submission.securityStatus} />
                <Metadata label="Findings" value={String(result.scan.findingCount)} />
              </dl>
              <div className="finding-list" aria-label="Scan findings">
                {result.scan.findings.length === 0 ? (
                  <div className="empty-state compact">
                    <ShieldCheck size={22} aria-hidden="true" />
                    <strong>No scan findings.</strong>
                    <span>Ready for maintainer review.</span>
                  </div>
                ) : result.scan.findings.map((finding, index) => (
                  <div className="finding-row" key={`${finding.category}-${finding.path ?? "package"}-${index}`}>
                    <StatusToken value={finding.severity} />
                    <span>
                      <strong>{finding.category}</strong>
                      <small>{finding.path ?? "package"}</small>
                    </span>
                    <p>{finding.message}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          ) : (
            <div className="empty-detail">
              <Upload size={42} aria-hidden="true" />
              <h2>No submission yet</h2>
              <p>Submitted packages appear here after server validation.</p>
            </div>
          )}
        </Card>

        <Card className="submit-panel user-submissions-panel shadcn-submit-panel shadcn-console-card" aria-label="My submitted skills">
          <CardHeader className="admin-panel-heading shadcn-card-header">
            <span className="admin-panel-icon"><PackageOpen size={18} aria-hidden="true" /></span>
            <div>
              <CardTitle>My submitted skills</CardTitle>
              <CardDescription aria-live="polite">{submissionsState === "loading" ? "Loading…" : `${submissions.length} versions`}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="submission-list shadcn-submission-list">
            {submissions.map((submission) => (
              <div className="submission-row" key={submission.id}>
                <span className="cell-main">
                  <strong>{submission.title}</strong>
                  <small>{submission.slug}@{submission.version}</small>
                </span>
                <span className="submission-statuses">
                  <StatusToken value={submission.reviewStatus} />
                  <StatusToken value={submission.lifecycleStatus} />
                  <StatusToken value={submission.securityStatus} />
                  <span>{formatBytes(submission.artifact.byteSize)}</span>
                </span>
                <span className="submission-actions">
                  <Button
                    className="save-button compact-button shadcn-action-button"
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
                      className="danger-button compact-button shadcn-action-button"
                      disabled={actioningId === submission.id}
                      size="sm"
                      type="button"
                      variant="destructive"
                      onClick={() => void withdrawSubmission(submission)}
                    >
                      <X size={15} aria-hidden="true" />
                      Withdraw
                    </Button>
                  )}
                </span>
              </div>
            ))}
            {submissionsState === "ready" && submissions.length === 0 && (
              <div className="empty-state compact">
                <PackageOpen size={22} aria-hidden="true" />
                <strong>No submitted skills.</strong>
                <span>Validated submissions will appear here for export.</span>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
      {confirmation && <ConfirmationDialog key={confirmation.key} request={confirmation} onClose={() => setConfirmation(null)} />}
    </main>
  );
}

function ReviewDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<ReviewSubmissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [reviewArtifactHashes, setReviewArtifactHashes] = useState<Record<string, string>>({});
  const [artifactLoadingId, setArtifactLoadingId] = useState<string | null>(null);
  const selected = submissions.find((submission) => submission.id === selectedId) ?? submissions[0] ?? null;
  const allowedReviewActions = selected?.allowedActions ?? fallbackReviewActions(selected);
  const selectedArtifactHash = selected ? reviewArtifactHashes[selected.id] ?? selected.approvedArtifactSha256 ?? null : null;
  const approveDisabled = !allowedReviewActions.includes("approve") || !selectedArtifactHash;
  const requestChangesDisabled = !allowedReviewActions.includes("request-changes");
  const rejectDisabled = !allowedReviewActions.includes("reject");
  const publishDisabled = !allowedReviewActions.includes("publish");
  const actionHint = selected
    ? selected.securityStatus !== "passed"
      ? "Resolve or document scan findings before approving or publishing."
      : selected.reviewStatus === "approved"
        ? "This submission is approved. Publish it when release notes and metadata are ready."
        : selectedArtifactHash
          ? "Approve after checking metadata, package integrity, and scan output."
          : "Download the review artifact before approving so the approval records its exact hash."
    : "";

  async function refreshReview() {
    setState("loading");
    setMessage(null);
    setNotice(null);
    try {
      const nextSubmissions = await client.listReviewSubmissions();
      setSubmissions(nextSubmissions);
      setSelectedId((current) => (
        current && nextSubmissions.some((submission) => submission.id === current)
          ? current
          : nextSubmissions[0]?.id ?? null
      ));
      setState("ready");
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
      setState("error");
    }
  }

  useEffect(() => {
    void refreshReview();
  }, [client]);

  async function commitReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName, confirmedReason: string) {
    setMessage(null);
    setNotice(null);
    try {
      if (action === "approve" && !selectedArtifactHash) {
        setMessage("Download the review artifact before approving this submission.");
        return;
      }
      const result = await client.performReviewAction({
        submissionId: submission.id,
        action,
        reason: confirmedReason || undefined,
        ...(action === "approve" && selectedArtifactHash ? { artifactSha256: selectedArtifactHash } : {}),
      });
      const nextSubmissions = await client.listReviewSubmissions();
      setSubmissions(nextSubmissions);
      setSelectedId(result.publishedAt ? nextSubmissions[0]?.id ?? null : result.id);
      setReason("");
      const actionLabel = action === "request-changes"
        ? "was returned for changes"
        : action === "reject"
          ? "was rejected"
          : action === "publish"
            ? "was published"
            : "was approved and can now be published";
      setNotice(`${submission.title} ${actionLabel}.`);
    } catch (error) {
      const safeMessage = safeReviewErrorMessage(error);
      setMessage(safeMessage);
      throw new Error(safeMessage);
    }
  }

  function requestReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName) {
    if (action === "approve" && !selectedArtifactHash) {
      setMessage("Download the review artifact before approving this submission.");
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
    setConfirmation({
      key: `review-${action}`,
      ...label,
      destructive: action === "reject",
      initialReason: reason,
      requireReason: action !== "approve",
      onConfirm: (confirmedReason) => commitReviewAction(submission, action, confirmedReason),
    });
  }

  async function downloadReviewArtifact(submission: ReviewSubmissionSummary) {
    setMessage(null);
    setNotice(null);
    setArtifactLoadingId(submission.id);
    try {
      const bundle = await client.getReviewSubmissionBundle(submission.id);
      setReviewArtifactHashes((current) => ({ ...current, [submission.id]: bundle.artifactSha256 }));
      downloadJsonFile(`${submission.slug}-${submission.version}-review.myskills.json`, bundle.payload);
      setNotice(`Review artifact downloaded. Hash ${bundle.artifactSha256.slice(0, 12)}… is ready for approval.`);
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
    } finally {
      setArtifactLoadingId(null);
    }
  }

  return (
    <main className="review-workspace shadcn-review-workspace" aria-label="Maintainer review dashboard">
      <section className="admin-hero shadcn-review-hero">
        <div>
          <Badge className="shadcn-review-eyebrow" variant="outline">Maintainer workflow</Badge>
          <h1>Review dashboard</h1>
          <p aria-live="polite">{session.user.email} · {state === "loading" ? "Loading queue…" : `${submissions.length} awaiting action`}</p>
        </div>
        <Button className="shadcn-action-button" size="sm" type="button" onClick={() => void refreshReview()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </Button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}
      {notice && <div className="success-message admin-message" role="status" aria-live="polite">{notice}</div>}

      <section className="review-layout shadcn-review-layout">
        <Card className="results-panel review-queue review-registry-panel shadcn-console-card" aria-label="Review queue">
          <CardHeader className="panel-heading review-registry-heading shadcn-card-header">
            <div>
              <CardTitle>Queue</CardTitle>
              <CardDescription aria-live="polite">{state === "loading" ? "Loading…" : `${submissions.length} submissions`}</CardDescription>
            </div>
            <Badge className="shadcn-review-eyebrow" variant="outline">Maintainer</Badge>
          </CardHeader>
          <CardContent className="review-card-content">
            <div className="result-list shadcn-review-list">
              {submissions.map((submission) => (
                <button
                  aria-pressed={selected?.id === submission.id}
                  className={selected?.id === submission.id ? "result-row review-registry-row selected" : "result-row review-registry-row"}
                  key={submission.id}
                  type="button"
                  onClick={() => setSelectedId(submission.id)}
                >
                  <SkillIcon slug={submission.slug} />
                  <span className="result-main review-registry-main">
                    <strong>{submission.title}</strong>
                    <span>{submission.slug}@{submission.version}</span>
                    <span className="tag-row review-registry-tags">
                      <ReviewStatusBadge value={submission.reviewStatus} />
                      <ReviewStatusBadge value={submission.lifecycleStatus} />
                      <ReviewStatusBadge value={submission.securityStatus} />
                    </span>
                  </span>
                  <Badge className="shadcn-finding-badge review-registry-finding" variant="secondary">{submission.findingCount} findings</Badge>
                </button>
              ))}
              {state === "ready" && submissions.length === 0 && (
                <div className="empty-state">
                  <ShieldCheck size={22} aria-hidden="true" />
                  <strong>Review queue is clear.</strong>
                  <span>No submissions are awaiting approval or publication.</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="detail-panel review-detail shadcn-console-card" aria-label="Selected submission review">
          {selected ? (
            <>
              <CardHeader className="shadcn-detail-header">
                <div className="shadcn-detail-title-row">
                  <SkillIcon slug={selected.slug} />
                  <div className="detail-title shadcn-detail-title">
                    <CardTitle>{selected.title}</CardTitle>
                    <CardDescription>{selected.slug}@{selected.version}</CardDescription>
                  </div>
                  <ReviewStatusBadge value={selected.reviewStatus} />
                </div>
              </CardHeader>
              <CardContent className="shadcn-detail-content">
                <dl className="shadcn-metadata-grid">
                  <div>
                    <dt>Visibility</dt>
                    <dd>{formatStatusLabel(selected.visibility)}</dd>
                  </div>
                  <div>
                    <dt>Security</dt>
                    <dd>{formatStatusLabel(selected.securityStatus)}</dd>
                  </div>
                  <div>
                    <dt>Platforms</dt>
                    <dd>{selected.platforms.map((item) => item.name).join(", ") || "-"}</dd>
                  </div>
                  <div>
                    <dt>Findings</dt>
                    <dd>{String(selected.findingCount)}</dd>
                  </div>
                  <div>
                    <dt>Artifact hash</dt>
                    <dd className="mono">{selectedArtifactHash ? `${selectedArtifactHash.slice(0, 12)}…` : "download required"}</dd>
                  </div>
                  <div>
                    <dt>Submitted</dt>
                    <dd>{formatDate(selected.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Submission ID</dt>
                    <dd className="mono">{selected.id}</dd>
                  </div>
                </dl>

                <label className="shadcn-review-reason">
                  <span>Reason</span>
                  <Textarea
                    className="review-textarea"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Optional review note"
                  />
                </label>

                <div className="shadcn-action-bar">
                  <div className="review-actions shadcn-review-actions">
                    <Button
                      className="shadcn-action-button"
                      disabled={artifactLoadingId === selected.id}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => void downloadReviewArtifact(selected)}
                    >
                      <Download size={16} aria-hidden="true" />
                      Download artifact
                    </Button>
                    <Button
                      className="shadcn-action-button"
                      disabled={approveDisabled}
                      size="sm"
                      type="button"
                      onClick={() => requestReviewAction(selected, "approve")}
                    >
                      <Check size={16} aria-hidden="true" />
                      Approve
                    </Button>
                    <Button
                      className="shadcn-action-button"
                      disabled={requestChangesDisabled}
                      size="sm"
                      type="button"
                      onClick={() => requestReviewAction(selected, "request-changes")}
                    >
                      <RotateCw size={16} aria-hidden="true" />
                      Request changes
                    </Button>
                    <Button
                      className="shadcn-action-button"
                      disabled={rejectDisabled}
                      variant="destructive"
                      size="sm"
                      type="button"
                      onClick={() => requestReviewAction(selected, "reject")}
                    >
                      <X size={16} aria-hidden="true" />
                      Reject
                    </Button>
                    <Button
                      className="shadcn-action-button"
                      disabled={publishDisabled}
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => requestReviewAction(selected, "publish")}
                    >
                      <PackageOpen size={16} aria-hidden="true" />
                      Publish
                    </Button>
                  </div>
                  <p className="action-hint">{actionHint}</p>
                </div>
              </CardContent>
            </>
          ) : (
            <div className="empty-detail">
              <ClipboardList size={42} aria-hidden="true" />
              <h2>No selected submission</h2>
              <p>Approved unpublished submissions and new review requests appear here.</p>
            </div>
          )}
        </Card>
      </section>
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
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft());
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteState, setInviteState] = useState<LoadState>("idle");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<RegistrationInvitation | null>(null);
  const sessionCanEditPrivilegedRoles = session.user.roles.includes("owner");
  const adminInitialLoading = state === "loading" && users.length === 0 && apiTokens.length === 0 && providers.length === 0 && auditEvents.length === 0;

  async function refreshAdmin() {
    setState("loading");
    setMessage(null);
    try {
      const [registration, nextUsers, nextApiTokens, nextProviders, nextAuditEvents] = await Promise.all([
        client.getAdminRegistration(),
        client.listAdminUsers(),
        client.listAdminApiTokens(),
        client.listAdminProviders(),
        client.listAdminAudit(25),
      ]);
      setRegistrationMode(registration.mode);
      setUsers(nextUsers);
      setApiTokens(nextApiTokens);
      setProviders(nextProviders);
      setAuditEvents(nextAuditEvents);
      setDraft((current) => current.key ? current : providerToDraft(nextProviders[0]));
      setState("ready");
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
      setState("error");
    }
  }

  useEffect(() => {
    void refreshAdmin();
  }, [client]);

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
      setAuditEvents(await client.listAdminAudit(25));
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
      setAuditEvents(await client.listAdminAudit(25));
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
      setAuditEvents(await client.listAdminAudit(25));
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
      setAuditEvents(await client.listAdminAudit(25));
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
      setAuditEvents(await client.listAdminAudit(25));
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
      setAuditEvents(await client.listAdminAudit(25));
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
          meta={`${auditEvents.length} latest`}
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

function ConfirmationDialog({ onClose, request }: { onClose: () => void; request: ConfirmationRequest }) {
  const [reason, setReason] = useState(request.initialReason ?? "");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loadingRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    document.activeElement instanceof window.HTMLElement ? document.activeElement : null,
  );
  const showReason = request.requireReason || request.initialReason !== undefined;
  const reasonIsValid = !request.requireReason || reason.trim().length >= 4;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    headingRef.current?.focus();
    function handleDialogKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !loadingRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleDialogKeydown);
    return () => {
      window.removeEventListener("keydown", handleDialogKeydown);
      document.body.style.overflow = previousOverflow;
      restoreInteractionFocus(previouslyFocusedRef.current);
    };
  }, [onClose]);

  async function confirm() {
    if (!reasonIsValid) {
      setError("Enter a specific reason of at least 4 characters.");
      return;
    }
    loadingRef.current = true;
    setStatus("loading");
    setError(null);
    try {
      await request.onConfirm(reason.trim());
      onClose();
    } catch (nextError) {
      loadingRef.current = false;
      setStatus("error");
      setError(nextError instanceof Error ? nextError.message : "The action could not be completed. Try again.");
    }
  }

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section className="confirmation-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${request.key}-title`} aria-describedby={`${request.key}-description`}>
        <div className="confirmation-heading">
          <CircleAlert size={22} aria-hidden="true" />
          <div>
            <h2 id={`${request.key}-title`} ref={headingRef} tabIndex={-1}>{request.title}</h2>
            <p id={`${request.key}-description`}>{request.description}</p>
          </div>
        </div>
        {showReason && (
          <div className="confirmation-reason">
            <label htmlFor={`${request.key}-reason`}>Reason {request.requireReason ? "(required)" : "(optional)"}</label>
            <Textarea
              aria-describedby={`${request.key}-reason-help`}
              aria-invalid={!reasonIsValid}
              disabled={status === "loading"}
              id={`${request.key}-reason`}
              name={`${request.key}-reason`}
              autoComplete="off"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain the decision…"
            />
            <small id={`${request.key}-reason-help`}>{request.requireReason ? "Record at least 4 characters so the decision is meaningful." : "This note is included with the decision when supported."}</small>
          </div>
        )}
        {error && <div className="safe-message compact" role="alert">{error}</div>}
        <div className="confirmation-actions">
          <Button disabled={status === "loading"} size="sm" type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={status === "loading" || !reasonIsValid} size="sm" type="button" variant={request.destructive ? "destructive" : "default"} onClick={() => void confirm()}>
            {status === "loading" ? "Working…" : request.confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

function restoreInteractionFocus(previous: HTMLElement | null): void {
  if (!previous) {
    return;
  }
  if (previous.isConnected) {
    previous.focus();
    return;
  }
  const ariaLabel = previous.getAttribute("aria-label");
  const text = previous.textContent?.trim();
  const replacement = Array.from(document.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
  )).find((candidate) => (
    candidate.tagName === previous.tagName
    && (ariaLabel ? candidate.getAttribute("aria-label") === ariaLabel : candidate.textContent?.trim() === text)
  ));
  replacement?.focus();
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

function ReviewStatusBadge({ value }: { value?: string }) {
  const statusValue = value ?? "unknown";
  return (
    <Badge className={`review-status-badge review-status-badge-${statusValue}`} variant="outline">
      {formatStatusLabel(statusValue)}
    </Badge>
  );
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

function SkillDetail({
  command,
  client,
  platform,
  release,
  selectedSkill,
  session,
  setPlatform,
}: {
  command: string;
  client: RegistryClient;
  platform: string;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  session: WebSession | null;
  setPlatform: (platform: string) => void;
}) {
  const canManageSkill = Boolean(session && selectedSkill.access?.canManageSharing);
  const canUsePrivilegedControls = Boolean(canManageSkill && session?.user.mfaVerified);
  return (
    <>
      <CardHeader className="shadcn-detail-header registry-detail-header">
        <div className="detail-heading shadcn-detail-title-row">
          <SkillIcon slug={selectedSkill.slug} large />
          <div className="detail-title shadcn-detail-title">
            <span className="registry-detail-eyebrow">Approved skill release</span>
            <CardTitle>{selectedSkill.title}</CardTitle>
            <CardDescription>{selectedSkill.slug}</CardDescription>
          </div>
          <div className="registry-detail-reference">
            <span>Exact release</span>
            <strong>{release.version}</strong>
            <div className="detail-status registry-detail-status" aria-label="Release status">
              <Badge className={`review-status-badge review-status-badge-${release.reviewStatus}`} variant="outline">
                Review {formatStatusLabel(release.reviewStatus)}
              </Badge>
              <Badge className={`review-status-badge review-status-badge-${release.securityStatus}`} variant="outline">
                Security {formatStatusLabel(release.securityStatus)}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="shadcn-detail-content registry-detail-content">
        <p className="summary">{selectedSkill.summary}</p>
        <dl className="metadata-grid shadcn-metadata-grid registry-metadata-grid">
          <Metadata label="Platforms" value={release.platforms.map((item) => item.name).join(", ")} />
          <Metadata label="Tags" value={selectedSkill.tags.join(", ") || "-"} />
          <Metadata label="Released" value={release.publishedAt ? formatDate(release.publishedAt) : "Not published"} />
          <Metadata label="Review" value={formatStatusLabel(release.reviewStatus)} />
          <Metadata label="Security" value={formatStatusLabel(release.securityStatus)} />
          <Metadata label="Byte size" value={new Intl.NumberFormat().format(release.artifact.byteSize)} />
          <Metadata label="Content type" value={release.artifact.contentType} />
          <Metadata label="SHA-256" value={shortHash(release.artifact.sha256)} monospace />
        </dl>

        <section className="control-plane-section release-notes-panel" aria-labelledby="release-notes-heading">
          <div className="control-plane-section-heading"><div><p className="control-plane-kicker">What changed</p><h2 id="release-notes-heading">Release notes</h2></div><Badge variant={release.requiresUserAction ? "destructive" : "outline"}>{release.changeKind ?? "maintenance"}</Badge></div>
          <p>{release.releaseNotes || "No release notes were supplied for this release."}</p>
          {release.requiresUserAction && <p className="control-plane-muted"><CircleAlert size={15} aria-hidden="true" /> This release requires a user action. Review the instructions before updating.</p>}
          {release.compatibility && Object.keys(release.compatibility).length > 0 && <dl className="metadata-grid shadcn-metadata-grid registry-metadata-grid"><Metadata label="Minimum MySkills" value={release.compatibility.minimumMyskillsVersion ?? "Any"} /><Metadata label="Minimum adapter contract" value={release.compatibility.minimumAdapterContractVersion?.toString() ?? "Any"} /><Metadata label="Minimum source version" value={release.compatibility.minimumSourceVersion ?? "Any"} /></dl>}
        </section>

        {session && (
          <ReleaseInstallPanel
            client={client}
            platform={platform}
            release={release}
            selectedSkill={selectedSkill}
          />
        )}

        <div className="platform-select registry-platform-select">
          <span>Export platform</span>
          <div>
            {release.platforms.map((item) => (
              <Button
                className={item.name === platform ? "platform-button active shadcn-action-button" : "platform-button shadcn-action-button"}
                key={item.name}
                size="sm"
                type="button"
                variant={item.name === platform ? "secondary" : "outline"}
                onClick={() => setPlatform(item.name)}
              >
                {item.name}
              </Button>
            ))}
          </div>
        </div>

        {canManageSkill && !canUsePrivilegedControls && <PrivilegedControlsLocked />}

        {session && canUsePrivilegedControls && (
          <LifecyclePanel
            client={client}
            release={release}
            selectedSkill={selectedSkill}
            session={session}
          />
        )}

        <div className="command-panel registry-command-panel">
          <div className="command-heading">
            <TerminalSquare size={18} aria-hidden="true" />
            <span>CLI export</span>
          </div>
          <code>{command}</code>
          <CopyButton text={command} variant="outline" />
        </div>
        {session && canUsePrivilegedControls && (
          <SharingPanel client={client} selectedSkill={selectedSkill} session={session} />
        )}
      </CardContent>
    </>
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
      const eligible = records.filter((target) => (
        target.status !== "revoked"
        && target.consent.status === "granted"
        && target.adapter.contractVersion === 2
        && target.capabilities.apply === true
        && target.capabilities["sync.write"] === true
      ));
      setTargets(eligible);
      setSelectedTargetId((current) => current || eligible[0]?.id || "");
      setState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setState("error");
      setMessage(safeArchitectureTargetErrorMessage(error));
    });
    return () => { active = false; };
  }, [client]);

  async function install() {
    if (!selectedTargetId || !client.scheduleTargetSkillOperation) return;
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
    <section className="control-plane-section release-install-panel" aria-labelledby="release-install-heading">
      <div className="control-plane-section-heading">
        <div><p className="control-plane-kicker">Connected target</p><h2 id="release-install-heading">Install this exact release</h2></div>
        <PackageOpen size={20} aria-hidden="true" />
      </div>
      {state === "loading" && <p className="control-plane-muted" role="status">Loading eligible targets…</p>}
      {state !== "loading" && targets.length === 0 && <p className="control-plane-muted">No consented contract-v2 target can accept installs. Register or update a target in Connected targets first.</p>}
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
}: {
  client: RegistryClient;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  session: WebSession;
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
      await refresh();
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
      await refresh();
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
          <Button className="danger-button shadcn-action-button" disabled={state === "loading"} size="sm" type="button" variant="destructive" onClick={() => void runSkillAction("delete")}>
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
                    className={action === "delete" || action === "revoke" ? "danger-button compact-button shadcn-action-button" : "compact-button shadcn-action-button"}
                    key={action}
                    disabled={state === "loading"}
                    size="sm"
                    type="button"
                    variant={action === "delete" || action === "revoke" ? "destructive" : "outline"}
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

function SkillIcon({ large, slug }: { slug: string; large?: boolean }) {
  const Icon = slug.includes("query") ? FileCode2 : PackageOpen;
  return (
    <span className={large ? "skill-icon large" : "skill-icon"} aria-hidden="true">
      <Icon size={large ? 34 : 26} />
    </span>
  );
}

function Tag({ children }: { children: string }) {
  return <span className="tag">{children}</span>;
}

function LoadingRows() {
  return (
    <div className="loading-announcement" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {[0, 1, 2].map((item) => <div className="loading-row" key={item} />)}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail-skeleton" role="status" aria-live="polite">
      <span className="sr-only">Loading skill detail…</span>
      <div />
      <div />
      <div />
    </div>
  );
}

function resultCountText(state: LoadState, count: number): string {
  if (state === "loading") {
    return "Loading registry…";
  }
  if (state === "error") {
    return "Registry unavailable";
  }
  return `${count} ${count === 1 ? "result" : "results"}`;
}

function preferredPlatform(platforms: Array<{ name: string; status?: string }>): string {
  return platforms.find((item) => item.name === "codex")?.name ?? platforms[0]?.name ?? "codex";
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
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
  return {
    view: initialViewFromPath(window.location.pathname),
    slug: skillSlugFromPath(window.location.pathname),
    query: params.get("q") ?? "",
    platform: params.get("platform") ?? "codex",
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

function browseUrl(slug: string | null, query: string, platform: string): string {
  const params = new URLSearchParams();
  if (query.trim()) {
    params.set("q", query);
  }
  if (platform !== "codex") {
    params.set("platform", platform);
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
