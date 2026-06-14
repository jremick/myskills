import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  CircleAlert,
  ClipboardList,
  Copy,
  FileCode2,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  LogIn,
  LogOut,
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
  X,
} from "lucide-react";
import type { PublicSkill } from "@myskills-app/core";
import {
  createRegistryClient,
  exportCommand,
  safeAdminErrorMessage,
  safeAuthErrorMessage,
  safeErrorMessage,
  safeReviewErrorMessage,
  safeSubmitErrorMessage,
  type ConfirmMfaResult,
  type AdminAuditEvent,
  type AdminProviderConfig,
  type AdminRegistrationMode,
  type AdminUser,
  type MfaStatus,
  type ProviderRoleMappingInput,
  type RegistryClient,
  type ReleaseMetadata,
  type ReviewActionResult,
  type ReviewSubmissionSummary,
  type SubmitSkillResult,
  type WebAuthUser,
} from "./api.js";

interface RegistryAppProps {
  client?: RegistryClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AuthState = "idle" | "loading" | "mfa";
type AppView = "landing" | "login" | "browse" | "admin" | "review" | "submit";

interface WebSession {
  token: string;
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

type ReviewActionName = "approve" | "publish";

export function RegistryApp({ client }: RegistryAppProps) {
  const initialSlug = skillSlugFromPath(window.location.pathname);
  const [view, setView] = useState<AppView>(initialViewFromPath(window.location.pathname));
  const [session, setSession] = useState<WebSession | null>(() => readStoredSession());
  const registryClient = useMemo(() => client ?? createRegistryClient(undefined, undefined, session?.token), [client, session?.token]);
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialSlug);
  const [selectedSkill, setSelectedSkill] = useState<PublicSkill | null>(null);
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [platform, setPlatform] = useState("codex");
  const [listState, setListState] = useState<LoadState>("idle");
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [listMessage, setListMessage] = useState<string | null>(null);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  const canUseAdmin = Boolean(session && isAdminUser(session.user));
  const canUseReview = Boolean(session && isReviewerUser(session.user));
  const canUseSubmit = Boolean(session && isSubmitterUser(session.user));
  const activeView: AppView = view === "landing"
    ? "landing"
    : !session
    ? "login"
    : view === "login"
    ? "browse"
    : view === "admin" && canUseAdmin
    ? "admin"
    : view === "review" && canUseReview
      ? "review"
      : view === "submit" && canUseSubmit
        ? "submit"
        : "browse";

  useEffect(() => {
    if (!session && view !== "landing" && view !== "login") {
      setView("login");
      window.history.replaceState({}, "", "/login");
      return;
    }
    if (session && view === "login") {
      setView("browse");
      window.history.replaceState({}, "", "/registry");
    }
  }, [session, view]);

  useEffect(() => {
    if (activeView === "landing" || activeView === "login") {
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
    registryClient.getMe(session.token)
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
  }, [registryClient, session?.token]);

  useEffect(() => {
    if (activeView === "landing" || activeView === "login") {
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
        setSelectedSlug((current) => {
          if (current && result.some((skill) => skill.slug === current)) {
            return current;
          }
          return result[0]?.slug ?? null;
        });
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
    if (activeView === "landing" || activeView === "login") {
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
        setPlatform(preferredPlatform(nextRelease?.platforms ?? skill.platforms));
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
    window.history.replaceState({}, "", `/skills/${slug}`);
  }

  function openLanding() {
    setView("landing");
    window.history.replaceState({}, "", "/");
  }

  function openLogin() {
    setView("login");
    window.history.replaceState({}, "", "/login");
  }

  function openRegistry() {
    setView("browse");
    setSelectedSlug((current) => current ?? skills[0]?.slug ?? null);
    window.history.replaceState({}, "", "/registry");
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
        token: result.token,
        expiresAt: result.expiresAt,
        user: await registryClient.getMe(result.token),
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
        token: result.token,
        expiresAt: result.expiresAt,
        user: await registryClient.getMe(result.token),
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

  async function handleLogout() {
    const token = session?.token;
    setAuthMessage(null);
    setSession(null);
    clearStoredSession();
    setMfaPending(null);
    if (token) {
      try {
        await registryClient.logout(token);
      } catch {
        setAuthMessage("Signed out locally.");
      }
    }
  }

  function navigateTo(nextView: AppView) {
    setView(nextView);
    if (nextView === "browse") {
      setSelectedSlug((current) => current ?? skills[0]?.slug ?? null);
    }
    window.history.replaceState({}, "", pathForView(nextView));
  }

  if (activeView === "landing") {
    return <MarketingLanding onLogin={openLogin} />;
  }

  if (activeView === "login") {
    return (
      <LoginPage
        authMessage={authMessage}
        authState={authState}
        mfaPending={mfaPending}
        onHome={openLanding}
        onLogin={handleLogin}
        onVerifyMfa={handleVerifyMfa}
      />
    );
  }

  const navItems = [
    { view: "browse" as const, label: "Registry", icon: <Boxes size={18} aria-hidden="true" />, enabled: true },
    { view: "submit" as const, label: "Submit", icon: <Upload size={18} aria-hidden="true" />, enabled: canUseSubmit },
    { view: "review" as const, label: "Review", icon: <ClipboardList size={18} aria-hidden="true" />, enabled: canUseReview },
    { view: "admin" as const, label: "Admin", icon: <Settings size={18} aria-hidden="true" />, enabled: canUseAdmin },
  ].filter((item) => item.enabled);

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Primary navigation">
        <a className="brand" href="/registry" onClick={(event) => {
          event.preventDefault();
          navigateTo("browse");
        }}>
          <span className="brand-mark" aria-hidden="true">
            <img src="/brand/myskills-mark.svg" alt="" />
          </span>
          <span>MySkills</span>
        </a>
        <nav className="side-nav">
          {navItems.map((item) => (
            <button
              className={activeView === item.view ? "side-nav-item active" : "side-nav-item"}
              key={item.view}
              type="button"
              onClick={() => navigateTo(item.view)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span>Private workspace</span>
          <strong>{session?.user.roles.includes("owner") ? "Owner access" : "Approved account"}</strong>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <a className="mobile-brand" href="/registry" onClick={(event) => {
            event.preventDefault();
            navigateTo("browse");
          }}>
            <img src="/brand/myskills-mark.svg" alt="" />
            <span>MySkills</span>
          </a>
          <div className="page-heading">
            <span>{viewKicker(activeView)}</span>
            <strong>{viewTitle(activeView)}</strong>
          </div>
          {activeView === "browse" && (
            <label className="global-search" htmlFor="skill-search">
              <Search size={18} aria-hidden="true" />
              <input
                id="skill-search"
                name="skill-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search skills..."
                autoComplete="off"
                spellCheck={false}
              />
              <kbd>/</kbd>
            </label>
          )}
          <AuthWidget
            authMessage={authMessage}
            authState={authState}
            client={registryClient}
            mfaPending={mfaPending}
            onLogin={handleLogin}
            onLogout={handleLogout}
            onVerifyMfa={handleVerifyMfa}
            session={session}
          />
        </header>

        <div className="app-content">
          {activeView === "review" && session ? (
            <ReviewDashboard client={registryClient} session={session} />
          ) : activeView === "submit" && session ? (
            <SubmitDashboard client={registryClient} session={session} />
          ) : activeView === "admin" && session ? (
            <AdminConsole client={registryClient} session={session} />
          ) : (
            <main className="workspace">
              <section className="results-panel" aria-label="Skill search results">
                <div className="panel-heading">
                  <div>
                    <h1>Approved registry</h1>
                    <p>{resultCountText(listState, skills.length)}</p>
                  </div>
                </div>
                <div className="result-list">
                  {listState === "loading" && <LoadingRows />}
                  {listState === "error" && (
                    <div className="safe-message panel-state" role="status" aria-live="polite">
                      <CircleAlert size={24} aria-hidden="true" />
                      <strong>{listMessage ?? "The registry is not available."}</strong>
                      <span>The list could not load. Retry the registry request before selecting a skill.</span>
                      <button className="state-action" type="button" onClick={retryRegistry}>
                        <RotateCw size={15} aria-hidden="true" />
                        Retry
                      </button>
                    </div>
                  )}
                  {listState !== "loading" && listState !== "error" && skills.map((skill) => (
                    <button
                      className={skill.slug === selectedSlug ? "result-row selected" : "result-row"}
                      key={skill.slug}
                      type="button"
                      onClick={() => selectSkill(skill.slug)}
                    >
                      <SkillIcon slug={skill.slug} />
                      <span className="result-main">
                        <strong>{skill.title}</strong>
                        <span>{skill.slug}</span>
                        <span className="tag-row">{skill.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</span>
                      </span>
                      <span className="version">{skill.latestVersion ?? "-"}</span>
                      <span className="platform-icons">{skill.platforms.slice(0, 2).map((item) => item.name).join(", ")}</span>
                    </button>
                  ))}
                  {listState === "ready" && skills.length === 0 && (
                    <div className="empty-state">
                      <CircleAlert size={22} aria-hidden="true" />
                      <strong>No skills found.</strong>
                      <span>{query.trim() ? `No approved skills match "${query.trim()}".` : "Approved skills will appear here after publication."}</span>
                      {query.trim() && (
                        <button className="state-action" type="button" onClick={() => setQuery("")}>
                          Clear search
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </section>

              <section className="detail-panel" aria-label="Selected skill detail">
                {detailMessage && (
                  <div className="safe-message panel-state" role="status" aria-live="polite">
                    <CircleAlert size={24} aria-hidden="true" />
                    <strong>{detailMessage}</strong>
                    <span>The selected skill could not load. Retry the request or choose a different approved skill.</span>
                    <button className="state-action" type="button" onClick={retryRegistry}>
                      <RotateCw size={15} aria-hidden="true" />
                      Retry
                    </button>
                  </div>
                )}
                {detailState === "loading" && <DetailSkeleton />}
                {detailState !== "loading" && !detailMessage && selectedSkill && release && (
                  <SkillDetail
                    command={selectedCommand}
                    platform={platform}
                    release={release}
                    selectedSkill={selectedSkill}
                    setPlatform={setPlatform}
                  />
                )}
                {detailState !== "loading" && !selectedSkill && !detailMessage && (
                  <div className="empty-detail">
                    <FileCode2 size={42} aria-hidden="true" />
                    <h2>Select a skill</h2>
                    <p>Choose an approved skill to inspect release metadata and export guidance.</p>
                  </div>
                )}
              </section>
            </main>
          )}
        </div>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          {navItems.map((item) => (
            <a
              className={activeView === item.view ? "mobile-nav-item active" : "mobile-nav-item"}
              href={pathForView(item.view)}
              key={item.view}
              onClick={(event) => {
                event.preventDefault();
                navigateTo(item.view);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}

function MarketingLanding({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="landing-page">
      <section className="landing-hero" aria-label="MySkills private development landing page">
        <nav className="landing-nav" aria-label="Marketing navigation">
          <a className="landing-brand" href="/" onClick={(event) => event.preventDefault()}>
            <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" />
          </a>
          <div className="landing-links">
            <a href="#registry">Registry</a>
            <a href="#trust">Trust model</a>
            <a href="#private-development">Status</a>
            <button type="button" onClick={onLogin}>Login</button>
          </div>
        </nav>

        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <p className="landing-status">Private development. Not open for signups.</p>
            <h1>MySkills</h1>
            <p className="landing-lede">
              A governed registry for packaging, reviewing, publishing, and installing reusable AI agent skills across web, CLI, API, and MCP surfaces.
            </p>
            <div className="landing-actions">
              <button className="landing-primary" type="button" onClick={onLogin}>
                Login
                <ArrowRight size={18} aria-hidden="true" />
              </button>
              <a className="landing-secondary" href="#private-development">Read current status</a>
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
          <h2 id="trust-heading">Designed for private teams before public distribution.</h2>
        </div>
        <div className="landing-checks">
          <p><KeyRound size={18} aria-hidden="true" /> First-party accounts, MFA, scoped API tokens, and owner-controlled registration.</p>
          <p><LockKeyhole size={18} aria-hidden="true" /> Package artifacts live behind authenticated delivery and integrity checks.</p>
          <p><ShieldCheck size={18} aria-hidden="true" /> MCP starts read-only with discovery and install guidance, not package execution.</p>
        </div>
      </section>

      <section className="landing-band landing-status-band" id="private-development" aria-labelledby="status-heading">
        <div className="landing-section-heading">
          <span>Current status</span>
          <h2 id="status-heading">Private alpha work is underway.</h2>
          <p>
            MySkills is being prepared for a responsible public alpha. The live site will share product direction and allow owner access, but public account creation is not available yet.
          </p>
        </div>
        <button className="landing-primary" type="button" onClick={onLogin}>
          Login
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </section>
    </main>
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
  onVerifyMfa,
}: {
  authMessage: string | null;
  authState: AuthState;
  mfaPending: MfaPending | null;
  onHome: () => void;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
}) {
  return (
    <main className="login-page">
      <nav className="login-nav" aria-label="Login navigation">
        <a className="landing-brand" href="/" onClick={(event) => {
          event.preventDefault();
          onHome();
        }}>
          <img src="/brand/myskills-logo-horizontal.svg" alt="MySkills" />
        </a>
        <button className="login-back" type="button" onClick={onHome}>Public site</button>
      </nav>
      <section className="login-panel" aria-labelledby="login-heading">
        <p className="landing-status">Private development. Public signups are closed.</p>
        <h1 id="login-heading">Login</h1>
        <p>Use an approved owner or team account to access the private registry workspace.</p>
        <AuthWidget
          authMessage={authMessage}
          authState={authState}
          mfaPending={mfaPending}
          onLogin={onLogin}
          onLogout={async () => undefined}
          onVerifyMfa={onVerifyMfa}
          session={null}
        />
      </section>
    </main>
  );
}

function SubmitDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitSkillResult | null>(null);

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
      }, session.token);
      setResult(submitted);
      setState("ready");
    } catch (error) {
      setMessage(safeSubmitErrorMessage(error));
      setState("error");
    }
  }

  return (
    <main className="submit-workspace" aria-label="Skill package submission">
      <section className="admin-hero">
        <div>
          <h1>Submit package</h1>
          <p>{session.user.email} · {state === "loading" ? "uploading archive" : "author submission"}</p>
        </div>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="submit-layout">
        <section className="submit-panel" aria-label="Package upload">
          <div className="admin-panel-heading">
            <span className="admin-panel-icon"><Upload size={18} aria-hidden="true" /></span>
            <div>
              <h2>Package archive</h2>
              <p>{file ? `${file.name} · ${formatBytes(file.size)}` : "No file selected"}</p>
            </div>
          </div>

          <form className="submit-form" onSubmit={(event) => {
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

            <button className="save-button" disabled={state === "loading" || !file} type="submit">
              <Upload size={16} aria-hidden="true" />
              Submit for review
            </button>
          </form>
        </section>

        <section className="submit-panel submit-result-panel" aria-label="Submission result">
          <div className="admin-panel-heading">
            <span className="admin-panel-icon"><ClipboardList size={18} aria-hidden="true" /></span>
            <div>
              <h2>Submission status</h2>
              <p>{result ? `${result.submission.slug}@${result.submission.version}` : "Awaiting upload"}</p>
            </div>
          </div>

          {result ? (
            <div className="submit-result">
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
            </div>
          ) : (
            <div className="empty-detail">
              <Upload size={42} aria-hidden="true" />
              <h2>No submission yet</h2>
              <p>Submitted packages appear here after server validation.</p>
            </div>
          )}
        </section>
      </section>
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
  const selected = submissions.find((submission) => submission.id === selectedId) ?? submissions[0] ?? null;
  const approveDisabled = !selected || selected.reviewStatus === "approved" || selected.securityStatus !== "passed";
  const publishDisabled = !selected || selected.reviewStatus !== "approved" || selected.securityStatus !== "passed";
  const actionHint = selected
    ? selected.securityStatus !== "passed"
      ? "Resolve or document scan findings before approving or publishing."
      : selected.reviewStatus === "approved"
        ? "This submission is approved. Publish it when release notes and metadata are ready."
        : "Approve after checking metadata, package integrity, and scan output."
    : "";

  async function refreshReview() {
    setState("loading");
    setMessage(null);
    setNotice(null);
    try {
      const nextSubmissions = await client.listReviewSubmissions(session.token);
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
  }, [client, session.token]);

  async function runReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName) {
    setMessage(null);
    setNotice(null);
    try {
      const result = await client.performReviewAction(submission.id, action, reason, session.token);
      const nextSubmissions = await client.listReviewSubmissions(session.token);
      setSubmissions(nextSubmissions);
      setSelectedId(result.publishedAt ? nextSubmissions[0]?.id ?? null : result.id);
      setReason("");
      setNotice(result.publishedAt
        ? `${submission.title} was published.`
        : `${submission.title} was approved and can now be published.`);
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
    }
  }

  return (
    <main className="review-workspace" aria-label="Maintainer review dashboard">
      <section className="admin-hero">
        <div>
          <h1>Review dashboard</h1>
          <p>{session.user.email} · {state === "loading" ? "loading queue" : `${submissions.length} awaiting action`}</p>
        </div>
        <button type="button" onClick={() => void refreshReview()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}
      {notice && <div className="success-message admin-message" role="status" aria-live="polite">{notice}</div>}

      <section className="review-layout">
        <section className="review-queue" aria-label="Review queue">
          <div className="admin-panel-heading">
            <span className="admin-panel-icon"><ClipboardList size={18} aria-hidden="true" /></span>
            <div>
              <h2>Queue</h2>
              <p>{state === "loading" ? "Loading" : `${submissions.length} submissions`}</p>
            </div>
          </div>
          <div className="review-list">
            {submissions.map((submission) => (
              <button
                className={selected?.id === submission.id ? "review-row selected" : "review-row"}
                key={submission.id}
                type="button"
                onClick={() => setSelectedId(submission.id)}
              >
                <span>
                  <strong>{submission.title}</strong>
                  <small>{submission.slug}@{submission.version}</small>
                </span>
                <StatusToken value={submission.reviewStatus} />
                <StatusToken value={submission.securityStatus} />
                <span className="finding-count">{submission.findingCount} findings</span>
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
        </section>

        <section className="review-detail" aria-label="Selected submission review">
          {selected ? (
            <>
              <div className="detail-heading compact">
                <SkillIcon slug={selected.slug} />
                <div className="detail-title">
                  <h2>{selected.title}</h2>
                  <span>{selected.slug}@{selected.version}</span>
                </div>
                <StatusToken value={selected.reviewStatus} />
              </div>
              <dl className="metadata-grid review-metadata">
                <Metadata label="Visibility" value={selected.visibility} />
                <Metadata label="Security" value={selected.securityStatus} />
                <Metadata label="Platforms" value={selected.platforms.map((item) => item.name).join(", ") || "-"} />
                <Metadata label="Findings" value={String(selected.findingCount)} />
                <Metadata label="Submitted" value={formatDate(selected.createdAt)} />
                <Metadata label="Submission ID" value={selected.id} monospace />
              </dl>

              <label className="review-reason">
                Reason
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Optional review note"
                />
              </label>

              <div className="review-actions">
                <button
                  disabled={approveDisabled}
                  type="button"
                  onClick={() => void runReviewAction(selected, "approve")}
                >
                  <Check size={16} aria-hidden="true" />
                  Approve
                </button>
                <button
                  disabled={publishDisabled}
                  type="button"
                  onClick={() => void runReviewAction(selected, "publish")}
                >
                  <PackageOpen size={16} aria-hidden="true" />
                  Publish
                </button>
              </div>
              <p className="action-hint">{actionHint}</p>
            </>
          ) : (
            <div className="empty-detail">
              <ClipboardList size={42} aria-hidden="true" />
              <h2>No selected submission</h2>
              <p>Approved unpublished submissions and new review requests appear here.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function AdminConsole({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [registrationMode, setRegistrationMode] = useState<AdminRegistrationMode>("closed");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [providers, setProviders] = useState<AdminProviderConfig[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([]);
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft());
  const sessionCanEditPrivilegedRoles = session.user.roles.includes("owner");

  async function refreshAdmin() {
    setState("loading");
    setMessage(null);
    try {
      const [registration, nextUsers, nextProviders, nextAuditEvents] = await Promise.all([
        client.getAdminRegistration(session.token),
        client.listAdminUsers(session.token),
        client.listAdminProviders(session.token),
        client.listAdminAudit(25, session.token),
      ]);
      setRegistrationMode(registration.mode);
      setUsers(nextUsers);
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
  }, [client, session.token]);

  async function updateRegistration(mode: AdminRegistrationMode) {
    setMessage(null);
    if (
      mode === "open"
      && registrationMode !== "open"
      && !window.confirm("Open registration? This allows new accounts to sign up without an owner approving each request first.")
    ) {
      return;
    }
    try {
      const registration = await client.updateAdminRegistration(mode, session.token);
      setRegistrationMode(registration.mode);
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  async function performUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete") {
    setMessage(null);
    const confirmationMessage = action === "disable"
      ? "Disable this user? They will lose access until reactivated."
      : action === "delete"
        ? "Delete this user? This removes access and cannot be undone from this screen."
        : null;
    if (confirmationMessage && !window.confirm(confirmationMessage)) {
      return;
    }
    try {
      const updated = await client.performAdminUserAction(userId, action, session.token);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  async function updateUserRoles(userId: string, roles: string[]) {
    setMessage(null);
    try {
      const updated = await client.updateAdminUserRoles(userId, roles, session.token);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
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
      }, session.token);
      setProviders((current) => upsertProvider(current, provider));
      setDraft(providerToDraft(provider));
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  return (
    <main className="admin-workspace" aria-label="Admin console">
      <section className="admin-hero">
        <div>
          <h1>Admin console</h1>
          <p>{session.user.email} · {registrationMode} registration</p>
        </div>
        <button type="button" onClick={() => void refreshAdmin()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="admin-grid">
        <AdminPanel
          icon={<Settings size={18} aria-hidden="true" />}
          title="Registration"
          meta={state === "loading" ? "Loading" : registrationMode}
        >
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
            Use request mode for private alpha access. Open registration is intentionally guarded because public signups are not ready.
          </p>
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
          icon={<UserCog size={18} aria-hidden="true" />}
          title="Provider"
          meta={`${providers.length} configured`}
        >
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
        </AdminPanel>

        <AdminPanel
          icon={<ShieldCheck size={18} aria-hidden="true" />}
          title="Audit"
          meta={`${auditEvents.length} latest`}
        >
          <div className="audit-list">
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
    <section className="admin-panel">
      <div className="admin-panel-heading">
        <span className="admin-panel-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{meta}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function IconButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
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

function StatusToken({ value }: { value: string }) {
  return <span className={`status-token status-token-${value}`}>{value}</span>;
}

function AuthWidget({
  authMessage,
  authState,
  client,
  mfaPending,
  onLogin,
  onLogout,
  onVerifyMfa,
  session,
}: {
  authMessage: string | null;
  authState: AuthState;
  client: RegistryClient;
  mfaPending: MfaPending | null;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
  session: WebSession | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaSetupOpen, setMfaSetupOpen] = useState(false);

  useEffect(() => {
    if (!session) {
      setMfaStatus(null);
      setMfaSetupOpen(false);
      return;
    }
    let active = true;
    client.getMfaStatus(session.token)
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
  }, [client, session?.token]);

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
            <button type="button" onClick={() => setMfaSetupOpen((open) => !open)} aria-label="Set up MFA">
              <ShieldCheck size={16} aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={() => void onLogout()} aria-label="Sign out">
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
        {mfaSetupOpen && (
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
          <input
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
        <button disabled={authState === "loading" || !mfaCode.trim()} type="submit">
          <ShieldCheck size={16} aria-hidden="true" />
          Verify
        </button>
        <AuthMessage message={authMessage ?? mfaPending.email} />
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
        <input
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
        <input
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
      <button disabled={authState === "loading" || !email.trim() || !password} type="submit">
        <LogIn size={16} aria-hidden="true" />
        Sign in
      </button>
      <p className="auth-help">Access is limited to approved private-development accounts.</p>
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

  async function startEnrollment() {
    setState("loading");
    setMessage(null);
    try {
      const nextEnrollment = await client.startTotpEnrollment({ password, label: "1Password" }, session.token);
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

  async function confirmEnrollment() {
    if (!enrollment) {
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const result = await client.confirmTotpEnrollment({ factorId: enrollment.factorId, code: code.trim() }, session.token);
      setRecoveryCodes(result.recoveryCodes);
      setCode("");
      setState("ready");
      setMessage("MFA enabled. Sign out and sign in again to verify this session for privileged actions.");
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
          void startEnrollment();
        }}>
          <label className="auth-field">
            <span>Current password</span>
            <input
              aria-label="Current password"
              autoComplete="current-password"
              disabled={state === "loading"}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <button disabled={state === "loading" || !password} type="submit">
            <KeyRound size={16} aria-hidden="true" />
            Continue
          </button>
        </form>
      ) : recoveryCodes.length === 0 ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          void confirmEnrollment();
        }}>
          <div className="mfa-secret">
            <span>Authenticator setup</span>
            <code>{enrollment.otpauthUrl}</code>
            <small>Manual secret: {enrollment.secret}</small>
          </div>
          <label className="auth-field">
            <span>Verification code</span>
            <input
              aria-label="MFA setup code"
              autoComplete="one-time-code"
              disabled={state === "loading"}
              inputMode="numeric"
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              value={code}
            />
          </label>
          <button disabled={state === "loading" || !code.trim()} type="submit">
            <ShieldCheck size={16} aria-hidden="true" />
            Enable MFA
          </button>
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
  platform,
  release,
  selectedSkill,
  setPlatform,
}: {
  command: string;
  platform: string;
  release: ReleaseMetadata;
  selectedSkill: PublicSkill;
  setPlatform: (platform: string) => void;
}) {
  return (
    <>
      <div className="detail-heading">
        <SkillIcon slug={selectedSkill.slug} large />
        <div className="detail-title">
          <h2>{selectedSkill.title}</h2>
          <span>{selectedSkill.slug}</span>
        </div>
        <div className="detail-status" aria-label="Release status">
          <span className={`status-token status-token-${release.reviewStatus}`}>Review {release.reviewStatus}</span>
          <span className={`status-token status-token-${release.securityStatus}`}>Security {release.securityStatus}</span>
        </div>
      </div>
      <p className="summary">{selectedSkill.summary}</p>
      <dl className="metadata-grid">
        <Metadata label="Latest version" value={release.version} />
        <Metadata label="Platforms" value={release.platforms.map((item) => item.name).join(", ")} />
        <Metadata label="Tags" value={selectedSkill.tags.join(", ") || "-"} />
        <Metadata label="Released" value={formatDate(release.publishedAt)} />
        <Metadata label="Review" value={release.reviewStatus} />
        <Metadata label="Security" value={release.securityStatus} />
        <Metadata label="Byte size" value={new Intl.NumberFormat().format(release.artifact.byteSize)} />
        <Metadata label="Content type" value={release.artifact.contentType} />
        <Metadata label="SHA-256" value={shortHash(release.artifact.sha256)} monospace />
      </dl>

      <div className="platform-select">
        <span>Export platform</span>
        <div>
          {release.platforms.map((item) => (
            <button
              className={item.name === platform ? "platform-button active" : "platform-button"}
              key={item.name}
              type="button"
              onClick={() => setPlatform(item.name)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>

      <div className="command-panel">
        <div className="command-heading">
          <TerminalSquare size={18} aria-hidden="true" />
          <span>CLI export</span>
        </div>
        <code>{command}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(command)}>
          <Copy size={16} aria-hidden="true" />
          Copy
        </button>
      </div>
    </>
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
    <>
      {[0, 1, 2].map((item) => <div className="loading-row" key={item} />)}
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="detail-skeleton" aria-label="Loading skill detail">
      <div />
      <div />
      <div />
    </div>
  );
}

function resultCountText(state: LoadState, count: number): string {
  if (state === "loading") {
    return "Loading registry...";
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
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
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

function initialViewFromPath(pathname: string): AppView {
  if (pathname === "/") {
    return "landing";
  }
  if (pathname === "/login") {
    return "login";
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
  return "browse";
}

function pathForView(view: AppView): string {
  if (view === "landing") {
    return "/";
  }
  if (view === "login") {
    return "/login";
  }
  return view === "browse" ? "/registry" : `/${view}`;
}

function viewTitle(view: AppView): string {
  switch (view) {
    case "admin":
      return "Admin";
    case "review":
      return "Review";
    case "submit":
      return "Submit";
    case "browse":
      return "Registry";
    case "login":
      return "Login";
    case "landing":
      return "MySkills";
  }
}

function viewKicker(view: AppView): string {
  switch (view) {
    case "admin":
      return "Governance";
    case "review":
      return "Maintainer workflow";
    case "submit":
      return "Author workflow";
    case "browse":
      return "Approved releases";
    case "login":
      return "Private access";
    case "landing":
      return "Private development";
  }
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
      return "Best for private development and production hardening before public alpha.";
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

function isPrivilegedRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function isZipArchive(file: File): boolean {
  return /^[A-Za-z0-9._-]+\.zip$/i.test(file.name);
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
  return typeof record.token === "string" && record.token.length > 0
    && typeof record.expiresAt === "string" && record.expiresAt.length > 0
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
    token: session.token,
    expiresAt: session.expiresAt,
    user: session.user,
  }));
}

function clearStoredSession(): void {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}
