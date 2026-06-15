import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  ClipboardList,
  Copy,
  FileCode2,
  LogIn,
  LogOut,
  MailPlus,
  PackageOpen,
  PanelLeftClose,
  PanelLeftOpen,
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
  UsersRound,
  X,
} from "lucide-react";
import type { PublicSkill, SkillSharingDetails, TeamSharedSkillGroup, VisibilityScope } from "@myskills-app/core";
import {
  createRegistryClient,
  exportCommand,
  safeAdminErrorMessage,
  safeAuthErrorMessage,
  safeErrorMessage,
  safeReviewErrorMessage,
  safeSubmitErrorMessage,
  safeTeamErrorMessage,
  type AdminSharingSettings,
  type AdminAuditEvent,
  type AdminProviderConfig,
  type AdminRegistrationMode,
  type AdminUser,
  type ProviderRoleMappingInput,
  type RegistryClient,
  type RegistrationInvitation,
  type ReleaseMetadata,
  type ReviewActionResult,
  type ReviewSubmissionSummary,
  type TeamDashboard,
  type TeamInvitation,
  type TeamRecord,
  type SubmitSkillResult,
  type WebAuthUser,
} from "./api.js";

interface RegistryAppProps {
  client?: RegistryClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AuthState = "idle" | "loading" | "mfa";
type AppView = "browse" | "admin" | "review" | "submit" | "teams";

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
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [session, setSession] = useState<WebSession | null>(() => readStoredSession());
  const registryClient = useMemo(() => client ?? createRegistryClient(undefined, undefined, session?.token), [client, session?.token]);
  const [registrationInviteToken, setRegistrationInviteToken] = useState<string | null>(() => registrationInviteTokenFromLocation(window.location.pathname, window.location.hash));
  const [query, setQuery] = useState("");
  const [skills, setSkills] = useState<PublicSkill[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialSlug);
  const [selectedSkill, setSelectedSkill] = useState<PublicSkill | null>(null);
  const [release, setRelease] = useState<ReleaseMetadata | null>(null);
  const [platform, setPlatform] = useState("codex");
  const [listState, setListState] = useState<LoadState>("idle");
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [topbarAction, setTopbarAction] = useState<ReactNode | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  const isInviteRegistrationRoute = window.location.pathname === "/auth/register" && !session;
  const canUseAdmin = Boolean(session && isAdminUser(session.user));
  const canUseReview = Boolean(session && isReviewerUser(session.user));
  const canUseSubmit = Boolean(session && isSubmitterUser(session.user));
  const canUseTeams = Boolean(session);
  const activeView: AppView = view === "admin" && canUseAdmin
    ? "admin"
    : view === "review" && canUseReview
      ? "review"
      : view === "submit" && canUseSubmit
        ? "submit"
        : view === "teams" && canUseTeams
          ? "teams"
          : "browse";

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
    if (isInviteRegistrationRoute) {
      return;
    }
    let active = true;
    setListState("loading");
    registryClient.searchSkills(query)
      .then((result) => {
        if (!active) {
          return;
        }
        setSkills(result);
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
        setMessage(safeErrorMessage(error));
        setListState("error");
      });
    return () => {
      active = false;
    };
  }, [isInviteRegistrationRoute, registryClient, query]);

  useEffect(() => {
    if (!selectedSlug) {
      setSelectedSkill(null);
      setRelease(null);
      setDetailState("idle");
      return;
    }
    let active = true;
    setDetailState("loading");
    setMessage(null);
    registryClient.getSkill(selectedSlug)
      .then(async (skill) => {
        const latestVersion = skill.latestVersion;
        const nextRelease = latestVersion ? await registryClient.getRelease(skill.slug, latestVersion) : null;
        if (!active) {
          return;
        }
        setSelectedSkill(skill);
        setRelease(nextRelease);
        setPlatform(preferredPlatform(nextRelease?.platforms ?? skill.platforms));
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setSelectedSkill(null);
        setRelease(null);
        setMessage(safeErrorMessage(error));
        setDetailState("error");
      });
    return () => {
      active = false;
    };
  }, [registryClient, selectedSlug]);

  const selectedCommand = useMemo(() => (
    selectedSkill && release ? exportCommand(selectedSkill.slug, release.version, platform) : ""
  ), [platform, release, selectedSkill]);

  useEffect(() => {
    if (activeView !== "review") {
      setTopbarAction(null);
    }
  }, [activeView]);

  function selectSkill(slug: string) {
    setView("browse");
    setSelectedSlug(slug);
    window.history.replaceState({}, "", `/skills/${slug}`);
  }

  function navigateTo(nextView: AppView, pathname: string) {
    setView(nextView);
    if (nextView === "browse" && !selectedSlug) {
      setSelectedSlug(skills[0]?.slug ?? null);
    }
    window.history.replaceState({}, "", pathname);
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
    } catch (error) {
      setAuthState("idle");
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
    } catch (error) {
      setAuthState("mfa");
      setAuthMessage(safeAuthErrorMessage(error));
    }
  }

  function completeInviteRegistration(nextSession: WebSession) {
    setSession(nextSession);
    writeStoredSession(nextSession);
    setRegistrationInviteToken(null);
    setAuthMessage(null);
    window.history.replaceState({}, "", "/");
    setView("browse");
  }

  const chrome = viewChrome(activeView, skills.length);
  const showTopbarAuth = !session;
  const showTopbarAction = showTopbarAuth || Boolean(topbarAction);

  if (isInviteRegistrationRoute) {
    return (
      <InviteRegistrationView
        client={registryClient}
        inviteToken={registrationInviteToken}
        onComplete={completeInviteRegistration}
      />
    );
  }

  return (
    <div className={navCollapsed ? "app-shell nav-collapsed" : "app-shell"}>
      <ShellNav
        activeView={activeView}
        canUseAdmin={canUseAdmin}
        canUseReview={canUseReview}
        canUseSubmit={canUseSubmit}
        canUseTeams={canUseTeams}
        collapsed={navCollapsed}
        onNavigate={navigateTo}
        onLogout={handleLogout}
        onToggle={() => setNavCollapsed((current) => !current)}
        session={session}
      />
      <div className="app-main">
        <header className={showTopbarAction ? "topbar" : "topbar topbar-simple"}>
          <div className="topbar-title">
            {chrome.kicker && <span>{chrome.kicker}</span>}
            <strong>{chrome.title}</strong>
            <small>{chrome.description}</small>
          </div>
          <label className="global-search" htmlFor="skill-search">
            <Search size={17} aria-hidden="true" />
            <input
              id="skill-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills..."
              autoComplete="off"
            />
            <kbd>/</kbd>
          </label>
          {showTopbarAuth && (
            <div className="topbar-actions">
              <AuthWidget
                authMessage={authMessage}
                authState={authState}
                mfaPending={mfaPending}
                onLogin={handleLogin}
                onVerifyMfa={handleVerifyMfa}
              />
            </div>
          )}
          {!showTopbarAuth && topbarAction && (
            <div className="topbar-actions">
              {topbarAction}
            </div>
          )}
        </header>

        {activeView === "review" && session ? (
          <ReviewDashboard client={registryClient} session={session} setTopbarAction={setTopbarAction} />
        ) : activeView === "submit" && session ? (
          <SubmitDashboard client={registryClient} session={session} />
        ) : activeView === "teams" && session ? (
          <TeamsDashboard client={registryClient} session={session} />
        ) : activeView === "admin" && session ? (
          <AdminConsole client={registryClient} session={session} />
        ) : (
          <main className="workspace">
          <section className="results-panel" aria-label="Skill search results">
            <div className="result-list-header">
              <span className="count-badge">{resultCountText(listState, skills.length)}</span>
            </div>
            <div className="result-list">
              {listState === "loading" && <LoadingRows />}
              {listState !== "loading" && skills.map((skill) => (
                <button
                  className={skill.slug === selectedSlug ? "result-row selected" : "result-row"}
                  key={skill.slug}
                  type="button"
                  onClick={() => selectSkill(skill.slug)}
                >
                  <span className="result-main">
                    <strong>{skill.title}</strong>
                    <span className="tag-row">{skill.tags.slice(0, 3).map((tag) => <Tag key={tag}>{tag}</Tag>)}</span>
                  </span>
                  <span className="version">{skill.latestVersion ?? "-"}</span>
                  <span className="platform-icons">{skill.platforms.slice(0, 2).map((item) => item.name).join(", ")}</span>
                  <StatusPill />
                </button>
              ))}
              {listState === "ready" && skills.length === 0 && (
                <div className="empty-state">
                  <CircleAlert size={22} aria-hidden="true" />
                  <strong>No skills found.</strong>
                  <span>Try a different search term.</span>
                </div>
              )}
            </div>
          </section>

          <section className="detail-panel" aria-label="Selected skill detail">
            {message && <div className="safe-message" role="status">{message}</div>}
            {detailState === "loading" && <DetailSkeleton />}
            {detailState !== "loading" && selectedSkill && release && (
              <SkillDetail
                command={selectedCommand}
                client={registryClient}
                platform={platform}
                release={release}
                selectedSkill={selectedSkill}
                session={session}
                setPlatform={setPlatform}
              />
            )}
            {detailState !== "loading" && !selectedSkill && !message && (
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
    </div>
  );
}

function ShellNav({
  activeView,
  canUseAdmin,
  canUseReview,
  canUseSubmit,
  canUseTeams,
  collapsed,
  onNavigate,
  onLogout,
  onToggle,
  session,
}: {
  activeView: AppView;
  canUseAdmin: boolean;
  canUseReview: boolean;
  canUseSubmit: boolean;
  canUseTeams: boolean;
  collapsed: boolean;
  onNavigate: (view: AppView, pathname: string) => void;
  onLogout: () => Promise<void>;
  onToggle: () => void;
  session: WebSession | null;
}) {
  return (
    <aside className="side-rail" aria-label="Primary navigation">
      <a className="rail-brand" href="/" aria-label="MySkills registry" onClick={(event) => {
        event.preventDefault();
        onNavigate("browse", "/");
      }}>
        <img src="/brand/myskills-mark.svg" alt="" />
        <span>MySkills</span>
      </a>
      <nav className="rail-nav">
        <RailButton active={activeView === "browse"} icon={<PackageOpen size={18} aria-hidden="true" />} label="Skills List" onClick={() => onNavigate("browse", "/")} />
        {canUseTeams && <RailButton active={activeView === "teams"} icon={<UsersRound size={18} aria-hidden="true" />} label="Teams" onClick={() => onNavigate("teams", "/teams")} />}
        {canUseSubmit && <RailButton active={activeView === "submit"} icon={<Upload size={18} aria-hidden="true" />} label="Submit" onClick={() => onNavigate("submit", "/submit")} />}
        {canUseReview && <RailButton active={activeView === "review"} icon={<ClipboardList size={18} aria-hidden="true" />} label="Review" onClick={() => onNavigate("review", "/review")} />}
        {canUseAdmin && <RailButton active={activeView === "admin"} icon={<Settings size={18} aria-hidden="true" />} label="Admin" onClick={() => onNavigate("admin", "/admin")} />}
      </nav>
      <div className="rail-footer">
        {session && <RailAccount session={session} onLogout={onLogout} />}
        <button className="rail-toggle" type="button" aria-pressed={collapsed} onClick={onToggle}>
          {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
          <span>{collapsed ? "Expand nav" : "Collapse nav"}</span>
        </button>
      </div>
    </aside>
  );
}

function RailButton({ active, icon, label, onClick }: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "rail-link active" : "rail-link"} type="button" aria-label={label} title={label} onClick={onClick}>
      <span className="rail-icon">{icon}</span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

function RailAccount({ onLogout, session }: { onLogout: () => Promise<void>; session: WebSession }) {
  const accountLabel = session.user.name || session.user.email;
  const accountTooltip = session.user.name ? `${session.user.name} (${session.user.email})` : session.user.email;
  return (
    <div className="rail-account" aria-label="Authenticated user" title={accountTooltip}>
      <span className="rail-account-text">
        <strong>{accountLabel}</strong>
        {session.user.name && <small>{session.user.email}</small>}
      </span>
      <button className="rail-account-signout" type="button" aria-label="Sign out" title={`Sign out ${accountTooltip}`} onClick={() => void onLogout()}>
        <LogOut size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

function InviteRegistrationView({
  client,
  inviteToken,
  onComplete,
}: {
  client: RegistryClient;
  inviteToken: string | null;
  onComplete: (session: WebSession) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [state, setState] = useState<LoadState>("idle");
  const [message, setMessage] = useState<string | null>(inviteToken ? null : "Invitation link is invalid or expired.");

  async function completeRegistration() {
    if (!inviteToken) {
      setMessage("Invitation link is invalid or expired.");
      return;
    }
    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      await client.registerWithInvitation({
        email,
        name,
        password,
        inviteToken,
      });
      const login = await client.login({ email, password });
      if (login.mfaRequired) {
        setMessage("Registration complete. Sign in with your new password.");
        setState("ready");
        return;
      }
      const nextSession = {
        token: login.token,
        expiresAt: login.expiresAt,
        user: await client.getMe(login.token),
      };
      onComplete(nextSession);
    } catch (error) {
      setMessage(safeAuthErrorMessage(error));
      setState("error");
    }
  }

  return (
    <main className="invite-registration-page" aria-label="Registration invitation">
      <section className="invite-registration-panel">
        <div className="invite-registration-brand">
          <img src="/brand/myskills-mark.svg" alt="" />
          <span>MySkills</span>
        </div>
        <div className="invite-registration-head">
          <MailPlus size={22} aria-hidden="true" />
          <div>
            <h1>Complete registration</h1>
            <p>Use the invited email address to create your account.</p>
          </div>
        </div>
        {message && <div className="safe-message admin-message" role="status">{message}</div>}
        <form className="invite-registration-form" onSubmit={(event) => {
          event.preventDefault();
          void completeRegistration();
        }}>
          <label>
            Email
            <input
              autoComplete="email"
              disabled={state === "loading" || !inviteToken}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <label>
            Name
            <input
              autoComplete="name"
              disabled={state === "loading" || !inviteToken}
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="new-password"
              disabled={state === "loading" || !inviteToken}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>
          <label>
            Confirm password
            <input
              autoComplete="new-password"
              disabled={state === "loading" || !inviteToken}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              value={confirmPassword}
            />
          </label>
          <button
            className="save-button"
            disabled={state === "loading" || !inviteToken || !email.trim() || !password || !confirmPassword}
            type="submit"
          >
            <LogIn size={16} aria-hidden="true" />
            {state === "loading" ? "Registering" : "Create account"}
          </button>
        </form>
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
      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="submit-layout refined-submit">
        <section className="submit-panel submit-intake" aria-label="Package upload">
          <div className="submit-section-head">
            <div>
              <h2>Package archive</h2>
              <p>Upload one .zip skill package up to 10 MB.</p>
            </div>
            <StatusToken value={state === "loading" ? "uploading" : file ? "ready" : "pending"} />
          </div>

          <form className="submit-form" onSubmit={(event) => {
            event.preventDefault();
            void submitPackage();
          }}>
            <label className="file-picker" htmlFor="package-archive">
              <PackageOpen size={26} aria-hidden="true" />
              <span>
                <strong>{file?.name ?? "Choose .zip package"}</strong>
                <small>{file ? `${formatBytes(file.size)} selected` : "Manifest, package files, and metadata archive"}</small>
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
              {state === "loading" ? "Submitting" : "Submit for review"}
            </button>
          </form>
        </section>

        <section className="submit-panel submit-status-panel" aria-label="Submission result">
          <div className="submit-section-head">
            <div>
              <h2>{result ? "Submitted for review" : "Review handoff"}</h2>
              <p>{result ? `${result.submission.slug}@${result.submission.version}` : "Server validation runs after upload."}</p>
            </div>
            {result && <StatusToken value={result.submission.reviewStatus} />}
          </div>

          {result ? (
            <div className="submit-result">
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
            <ul className="submit-checklist" aria-label="Submission checks">
              <li><Check size={15} aria-hidden="true" /> Package archive is required.</li>
              <li><ShieldCheck size={15} aria-hidden="true" /> Security scan runs before maintainer review.</li>
              <li><ClipboardList size={15} aria-hidden="true" /> Approved packages move to the review queue.</li>
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}

function ReviewDashboard({
  client,
  session,
  setTopbarAction,
}: {
  client: RegistryClient;
  session: WebSession;
  setTopbarAction: (action: ReactNode | null) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<ReviewSubmissionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const selected = submissions.find((submission) => submission.id === selectedId) ?? submissions[0] ?? null;

  const refreshReview = useCallback(async () => {
    setState("loading");
    setMessage(null);
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
  }, [client, session.token]);

  useEffect(() => {
    void refreshReview();
  }, [refreshReview]);

  useEffect(() => {
    setTopbarAction(
      <button className="refresh-button" disabled={state === "loading"} type="button" onClick={() => void refreshReview()}>
        <RotateCw size={16} aria-hidden="true" />
        Refresh
      </button>,
    );
    return () => setTopbarAction(null);
  }, [refreshReview, setTopbarAction, state]);

  async function runReviewAction(submission: ReviewSubmissionSummary, action: ReviewActionName) {
    setMessage(null);
    try {
      const result = await client.performReviewAction(submission.id, action, reason, session.token);
      const nextSubmissions = await client.listReviewSubmissions(session.token);
      setSubmissions(nextSubmissions);
      setSelectedId(result.publishedAt ? nextSubmissions[0]?.id ?? null : result.id);
      setReason("");
    } catch (error) {
      setMessage(safeReviewErrorMessage(error));
    }
  }

  return (
    <main className="review-workspace" aria-label="Maintainer review dashboard">
      {message && <div className="safe-message admin-message" role="status">{message}</div>}

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
                  <small>Version {submission.version}</small>
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
                <div className="detail-title">
                  <h2>{selected.title}</h2>
                  <span>Version {selected.version} | submitted {formatDate(selected.createdAt)}</span>
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
                  disabled={selected.reviewStatus === "approved" || selected.securityStatus !== "passed"}
                  type="button"
                  onClick={() => void runReviewAction(selected, "approve")}
                >
                  <Check size={16} aria-hidden="true" />
                  Approve
                </button>
                <button
                  disabled={selected.reviewStatus !== "approved" || selected.securityStatus !== "passed"}
                  type="button"
                  onClick={() => void runReviewAction(selected, "publish")}
                >
                  <PackageOpen size={16} aria-hidden="true" />
                  Publish
                </button>
              </div>
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

function TeamsDashboard({ client, session }: { client: RegistryClient; session: WebSession }) {
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<TeamDashboard>({ teams: [], invitations: [] });
  const [sharedGroups, setSharedGroups] = useState<TeamSharedSkillGroup[]>([]);
  const [teamName, setTeamName] = useState("");
  const [inviteEmails, setInviteEmails] = useState<Record<string, string>>({});

  const refreshTeams = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const [nextDashboard, nextGroups] = await Promise.all([
        client.listTeams(session.token),
        client.listTeamSharedSkills(session.token),
      ]);
      setDashboard(nextDashboard);
      setSharedGroups(nextGroups);
      setState("ready");
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
      setState("error");
    }
  }, [client, session.token]);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);

  async function createTeam() {
    if (!teamName.trim()) {
      return;
    }
    setMessage(null);
    try {
      await client.createTeam(teamName, session.token);
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
      await client.inviteTeamMember(team.id, email, session.token);
      setInviteEmails((current) => ({ ...current, [team.id]: "" }));
      await refreshTeams();
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  async function acceptInvitation(invitation: TeamInvitation) {
    setMessage(null);
    try {
      await client.acceptTeamInvitation(invitation.id, session.token);
      await refreshTeams();
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  return (
    <main className="teams-workspace" aria-label="Teams">
      <section className="admin-overview" aria-label="Team summary">
        <div className="admin-overview-title">
          <strong>Team sharing</strong>
          <span>{state === "loading" ? "Refreshing teams" : "Current team access"}</span>
        </div>
        <div className="admin-overview-metrics">
          <div className="admin-status-item">
            <span>Teams</span>
            <strong>{dashboard.teams.length}</strong>
          </div>
          <div className="admin-status-item">
            <span>Invitations</span>
            <strong>{dashboard.invitations.length}</strong>
          </div>
          <div className="admin-status-item">
            <span>Sharing out</span>
            <strong>{sharedGroups.reduce((total, group) => total + group.sharingWithTeam.length, 0)}</strong>
          </div>
          <div className="admin-status-item">
            <span>Shared in</span>
            <strong>{sharedGroups.reduce((total, group) => total + group.sharedWithMe.length, 0)}</strong>
          </div>
        </div>
        <button className="refresh-button" type="button" onClick={() => void refreshTeams()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="teams-layout">
        <section className="admin-section">
          <div className="admin-section-head">
            <span className="admin-panel-icon"><UsersRound size={18} aria-hidden="true" /></span>
            <div>
              <h2>Teams</h2>
              <p>Create teams and invite members.</p>
            </div>
          </div>
          <form className="team-create-row" onSubmit={(event) => {
            event.preventDefault();
            void createTeam();
          }}>
            <input
              aria-label="Team name"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="Team name"
            />
            <button className="save-button" disabled={!teamName.trim()} type="submit">
              <Plus size={16} aria-hidden="true" />
              Create
            </button>
          </form>
          <div className="team-list">
            {dashboard.teams.map((team) => (
              <div className="team-row" key={team.id}>
                <div className="team-row-main">
                  <strong>{team.name}</strong>
                  <small>{team.members.length} members | {team.invitations.length} pending</small>
                </div>
                <StatusToken value={team.role} />
                <form className="team-invite-row" onSubmit={(event) => {
                  event.preventDefault();
                  void inviteMember(team);
                }}>
                  <input
                    aria-label={`Invite user to ${team.name}`}
                    disabled={team.role !== "owner"}
                    value={inviteEmails[team.id] ?? ""}
                    onChange={(event) => setInviteEmails((current) => ({ ...current, [team.id]: event.target.value }))}
                    placeholder="user@example.com"
                    type="email"
                  />
                  <button disabled={team.role !== "owner" || !inviteEmails[team.id]?.trim()} type="submit">
                    <Plus size={15} aria-hidden="true" />
                    Invite
                  </button>
                </form>
              </div>
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

        <section className="admin-section">
          <div className="admin-section-head">
            <span className="admin-panel-icon"><ClipboardList size={18} aria-hidden="true" /></span>
            <div>
              <h2>Invitations</h2>
              <p>Pending team invitations for this account.</p>
            </div>
          </div>
          <div className="invitation-list">
            {dashboard.invitations.map((invitation) => (
              <div className="invitation-row" key={invitation.id}>
                <span>
                  <strong>{invitation.teamName}</strong>
                  <small>{invitation.email}</small>
                </span>
                <button className="save-button" type="button" onClick={() => void acceptInvitation(invitation)}>
                  <Check size={16} aria-hidden="true" />
                  Accept
                </button>
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
      </section>

      <section className="team-shared-groups" aria-label="Team shared skills">
        {sharedGroups.map((group) => (
          <TeamSkillGroupCard group={group} key={group.team.id} />
        ))}
        {state === "ready" && sharedGroups.length === 0 && (
          <div className="empty-state">
            <PackageOpen size={24} aria-hidden="true" />
            <strong>No team-shared skills.</strong>
            <span>Team visibility grants will appear here grouped by team.</span>
          </div>
        )}
      </section>
    </main>
  );
}

function TeamSkillGroupCard({ group }: { group: TeamSharedSkillGroup }) {
  return (
    <section className="admin-section team-skill-group">
      <div className="admin-section-head">
        <span className="admin-panel-icon"><UsersRound size={18} aria-hidden="true" /></span>
        <div>
          <h2>{group.team.name}</h2>
          <p>{group.sharingWithTeam.length} shared by you | {group.sharedWithMe.length} shared with you</p>
        </div>
      </div>
      <div className="team-skill-columns">
        <TeamSkillList title="Sharing with this team" skills={group.sharingWithTeam} />
        <TeamSkillList title="Shared with you" skills={group.sharedWithMe} />
      </div>
    </section>
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
  const [registrationMode, setRegistrationMode] = useState<AdminRegistrationMode>("closed");
  const [sharingSettings, setSharingSettings] = useState<AdminSharingSettings>(() => defaultSharingSettings());
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [providers, setProviders] = useState<AdminProviderConfig[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([]);
  const [draft, setDraft] = useState<ProviderDraft>(() => emptyProviderDraft());
  const [inviteDraft, setInviteDraft] = useState({ email: "", name: "" });
  const [inviteState, setInviteState] = useState<LoadState>("idle");
  const [lastInvitation, setLastInvitation] = useState<RegistrationInvitation | null>(null);
  const sessionCanEditPrivilegedRoles = session.user.roles.includes("owner");
  const sessionCanEditSharing = session.user.roles.includes("owner");

  async function refreshAdmin() {
    setState("loading");
    setMessage(null);
    try {
      const [registration, sharing, nextUsers, nextProviders, nextAuditEvents] = await Promise.all([
        client.getAdminRegistration(session.token),
        client.getAdminSharing(session.token),
        client.listAdminUsers(session.token),
        client.listAdminProviders(session.token),
        client.listAdminAudit(25, session.token),
      ]);
      setRegistrationMode(registration.mode);
      setSharingSettings(sharing);
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
    try {
      const registration = await client.updateAdminRegistration(mode, session.token);
      setRegistrationMode(registration.mode);
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  async function createRegistrationInvitation() {
    setMessage(null);
    setLastInvitation(null);
    setInviteState("loading");
    try {
      const invitation = await client.createRegistrationInvitation({
        email: inviteDraft.email,
        name: optionalDraftValue(inviteDraft.name),
      }, session.token);
      setLastInvitation(invitation);
      setInviteDraft({ email: "", name: "" });
      const [nextUsers, nextAuditEvents] = await Promise.all([
        client.listAdminUsers(session.token),
        client.listAdminAudit(25, session.token),
      ]);
      setUsers(nextUsers);
      setAuditEvents(nextAuditEvents);
      setInviteState("ready");
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
      setInviteState("error");
    }
  }

  async function updateSharingSetting(key: keyof AdminSharingSettings, value: boolean) {
    setMessage(null);
    const next = { ...sharingSettings, [key]: value };
    try {
      const saved = await client.updateAdminSharing(next, session.token);
      setSharingSettings(saved);
      setAuditEvents(await client.listAdminAudit(25, session.token));
    } catch (error) {
      setMessage(safeAdminErrorMessage(error));
    }
  }

  async function performUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete") {
    setMessage(null);
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
      <section className="admin-overview" aria-label="Admin status summary">
        <div className="admin-overview-title">
          <strong>Instance status</strong>
          <span>{state === "loading" ? "Refreshing settings" : "Current governance controls"}</span>
        </div>
        <div className="admin-overview-metrics">
          <div className="admin-status-item">
            <span>API</span>
            <StatusToken value={state === "error" ? "unavailable" : "connected"} />
          </div>
          <div className="admin-status-item">
            <span>Registration</span>
            <strong>{registrationMode}</strong>
          </div>
          <div className="admin-status-item">
            <span>Accounts</span>
            <strong>{users.length}</strong>
          </div>
          <div className="admin-status-item">
            <span>Providers</span>
            <strong>{providers.length}</strong>
          </div>
        </div>
        <button className="refresh-button" type="button" onClick={() => void refreshAdmin()}>
          <RotateCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </section>

      {message && <div className="safe-message admin-message" role="status">{message}</div>}

      <section className="admin-layout">
        <div className="admin-content">
        <AdminPanel
          icon={<Settings size={18} aria-hidden="true" />}
          title="Registration posture"
          meta="Opening registration changes the access boundary for this instance."
        >
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
        </AdminPanel>

        <AdminPanel
          icon={<MailPlus size={18} aria-hidden="true" />}
          title="Registration invitations"
          meta="Invite one user without changing the instance registration mode."
        >
          <form className="admin-invite-form" onSubmit={(event) => {
            event.preventDefault();
            void createRegistrationInvitation();
          }}>
            <label>
              Email
              <input
                autoComplete="email"
                onChange={(event) => setInviteDraft({ ...inviteDraft, email: event.target.value })}
                type="email"
                value={inviteDraft.email}
              />
            </label>
            <label>
              Name
              <input
                autoComplete="name"
                onChange={(event) => setInviteDraft({ ...inviteDraft, name: event.target.value })}
                value={inviteDraft.name}
              />
            </label>
            <button className="save-button" disabled={inviteState === "loading" || !inviteDraft.email.trim()} type="submit">
              <MailPlus size={16} aria-hidden="true" />
              {inviteState === "loading" ? "Sending" : "Send invite"}
            </button>
          </form>
          {lastInvitation && (
            <div className="inline-success" role="status">
              <Check size={15} aria-hidden="true" />
              <span>Invite sent to {lastInvitation.email}. Expires {formatDate(lastInvitation.expiresAt)}.</span>
            </div>
          )}
        </AdminPanel>

        <AdminPanel
          icon={<ShieldCheck size={18} aria-hidden="true" />}
          title="Sharing controls"
          meta="Instance owners choose which visibility scopes are available."
        >
          <SharingControls
            disabled={!sessionCanEditSharing}
            settings={sharingSettings}
            onChange={(key, value) => void updateSharingSetting(key, value)}
          />
        </AdminPanel>

        <AdminPanel
          icon={<UsersRound size={18} aria-hidden="true" />}
          title="Users"
          meta="Role changes are governed account actions."
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
                <span>{user.emailVerified ? "verified" : "unverified"} - {user.mfaEnabled ? "MFA" : "no MFA"}</span>
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
          title="Identity providers"
          meta="Provider settings control trusted login and role claims."
        >
          <div className="provider-layout">
            <div className="provider-list">
              {providers.length === 0 && (
                <div className="provider-empty">
                  No providers configured.
                </div>
              )}
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
              <div className="provider-form-head">
                <span>Provider configuration</span>
                <button className="text-button" type="button" onClick={() => setDraft(emptyProviderDraft())}>
                  Clear form
                </button>
              </div>
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
          title="Audit history"
          meta="Recent decisions across registration, roles, providers, and review."
        >
          <div className="audit-list">
            {auditEvents.map((event) => (
              <div className="audit-row" key={event.id}>
                <span className={event.decision === "allow" ? "audit-decision allow" : "audit-decision deny"}>
                  {event.decision}
                </span>
                <span>
                  <strong>{event.action}</strong>
                  <small>{event.resourceType}{event.resourceId ? ` - ${event.resourceId}` : ""}</small>
                </span>
                <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
              </div>
            ))}
            {state === "ready" && auditEvents.length === 0 && <div className="empty-state">No audit events.</div>}
          </div>
        </AdminPanel>
        </div>
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
    <section className="admin-section">
      <div className="admin-section-head">
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

function SharingControls({
  disabled,
  onChange,
  settings,
}: {
  disabled: boolean;
  onChange: (key: keyof AdminSharingSettings, value: boolean) => void;
  settings: AdminSharingSettings;
}) {
  const rows: Array<{ key: keyof AdminSharingSettings; label: string; detail: string }> = [
    { key: "publicVisibilityEnabled", label: "Public", detail: "Skills can be visible without sign-in." },
    { key: "authenticatedVisibilityEnabled", label: "Signed-in users", detail: "Skills can be visible to any active account." },
    { key: "teamsEnabled", label: "Teams", detail: "Users can create teams and manage invitations." },
    { key: "teamVisibilityEnabled", label: "Team sharing", detail: "Skills can be granted to teams." },
    { key: "userVisibilityEnabled", label: "Individual users", detail: "Skills can be granted to specific accounts." },
  ];
  return (
    <div className="sharing-controls">
      {rows.map((row) => (
        <label className="sharing-toggle" key={row.key}>
          <input
            checked={settings[row.key]}
            disabled={disabled}
            type="checkbox"
            onChange={(event) => onChange(row.key, event.target.checked)}
          />
          <span>
            <strong>{row.label}</strong>
            <small>{row.detail}</small>
          </span>
        </label>
      ))}
      {disabled && <div className="warning-box">Owner role required to change sharing controls.</div>}
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
  mfaPending,
  onLogin,
  onVerifyMfa,
}: {
  authMessage: string | null;
  authState: AuthState;
  mfaPending: MfaPending | null;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  if (mfaPending) {
    return (
      <form className="auth-widget auth-form" onSubmit={(event) => {
        event.preventDefault();
        void onVerifyMfa(mfaCode).finally(() => setMfaCode(""));
      }}>
        <input
          aria-label="MFA code"
          autoComplete="one-time-code"
          disabled={authState === "loading"}
          onChange={(event) => setMfaCode(event.target.value)}
          placeholder="MFA code"
          value={mfaCode}
        />
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
      <input
        aria-label="Email"
        autoComplete="email"
        disabled={authState === "loading"}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Email"
        type="email"
        value={email}
      />
      <input
        aria-label="Password"
        autoComplete="current-password"
        disabled={authState === "loading"}
        onChange={(event) => setPassword(event.target.value)}
        placeholder="Password"
        type="password"
        value={password}
      />
      <button disabled={authState === "loading" || !email.trim() || !password} type="submit">
        <LogIn size={16} aria-hidden="true" />
        Sign in
      </button>
      <AuthMessage message={authMessage} />
    </form>
  );
}

function AuthMessage({ message }: { message: string | null }) {
  return message ? <span className="auth-message" role="status">{message}</span> : null;
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
  const activePlatform = release.platforms.find((item) => item.name === platform) ?? release.platforms[0];
  const platformNames = release.platforms.map((item) => item.name).join(", ") || "-";
  const installTargets = Array.from(new Set(release.platforms.map((item) => item.installTarget).filter(Boolean))).join(", ") || "-";

  return (
    <article className="skill-detail-layout">
      <div className="detail-hero">
        <div className="detail-hero-copy">
          <h2>{selectedSkill.title}</h2>
          <p>{selectedSkill.summary}</p>
        </div>
        <div className="detail-status" aria-label="Release status">
          <StatusToken value={release.reviewStatus} />
          <StatusToken value={release.securityStatus} />
        </div>
      </div>

      <section className="detail-section">
        <div className="detail-section-head">
          <p className="section-label">Install</p>
          <div className="platform-select compact">
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
      </section>

      <section className="detail-section">
        <p className="section-label">Trust and release metadata</p>
        <dl className="metadata-grid">
          <Metadata label="Latest version" value={release.version} />
          <Metadata label="Platforms" value={platformNames} />
          <Metadata label="Review" value={`Review ${release.reviewStatus}`} />
          <Metadata label="Security" value={`Security ${release.securityStatus}`} />
          <Metadata label="Released" value={formatDate(release.publishedAt)} />
          <Metadata label="Checksum" value={shortHash(release.artifact.sha256)} monospace />
        </dl>
      </section>

      <section className="detail-section">
        <p className="section-label">Package notes</p>
        <dl className="metadata-grid">
          <Metadata label="Tags" value={selectedSkill.tags.join(", ") || "-"} />
          <Metadata label="Install target" value={activePlatform?.installTarget ?? installTargets} />
          <Metadata label="Size" value={formatPackageSize(release.artifact.byteSize)} />
          <Metadata label="Content type" value={release.artifact.contentType} />
        </dl>
      </section>

      {session && selectedSkill.access?.canManageSharing && (
        <SharingPanel client={client} selectedSkill={selectedSkill} session={session} />
      )}
    </article>
  );
}

function SharingPanel({
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

  const loadSharing = useCallback(async () => {
    setState("loading");
    setMessage(null);
    try {
      const next = await client.getSkillSharing(selectedSkill.slug, session.token);
      setDetails(next);
      setVisibility(next.visibility);
      setTeamIds(next.teamGrants.map((team) => team.id));
      setUserEmails(next.userGrants.map((user) => user.email).join(", "));
      setState("ready");
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
      setState("error");
    }
  }, [client, selectedSkill.slug, session.token]);

  useEffect(() => {
    void loadSharing();
  }, [loadSharing]);

  async function saveSharing() {
    if (!details) {
      return;
    }
    setMessage(null);
    try {
      const next = await client.updateSkillSharing({
        slug: selectedSkill.slug,
        visibility,
        teamIds: visibility === "team" ? teamIds : [],
        userEmails: visibility === "explicit-users" ? splitEmails(userEmails) : [],
      }, session.token);
      setDetails(next);
      setVisibility(next.visibility);
      setTeamIds(next.teamGrants.map((team) => team.id));
      setUserEmails(next.userGrants.map((user) => user.email).join(", "));
      setMessage("Sharing saved.");
    } catch (error) {
      setMessage(safeTeamErrorMessage(error));
    }
  }

  const settings = details?.settings ?? defaultSharingSettings();
  const visibilityOptions: Array<{ value: VisibilityScope; label: string; enabled: boolean }> = [
    { value: "public", label: "Public", enabled: settings.publicVisibilityEnabled },
    { value: "authenticated", label: "Signed-in users", enabled: settings.authenticatedVisibilityEnabled },
    { value: "private", label: "Private", enabled: true },
    { value: "team", label: "Teams", enabled: settings.teamsEnabled && settings.teamVisibilityEnabled },
    { value: "explicit-users", label: "Individual users", enabled: settings.userVisibilityEnabled },
  ];

  return (
    <section className="detail-section sharing-panel">
      <div className="detail-section-head">
        <p className="section-label">Sharing</p>
        <button className="save-button" disabled={state === "loading"} type="button" onClick={() => void saveSharing()}>
          <Save size={16} aria-hidden="true" />
          Save sharing
        </button>
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
          {(details?.availableTeams ?? []).map((team) => (
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
          {details && details.availableTeams.length === 0 && <small>No teams available.</small>}
        </div>

        <label className={visibility === "explicit-users" ? "grant-box active" : "grant-box"}>
          <strong>Individual users</strong>
          <input
            disabled={visibility !== "explicit-users"}
            value={userEmails}
            onChange={(event) => setUserEmails(event.target.value)}
            placeholder="user@example.com, teammate@example.com"
          />
        </label>
      </div>
    </section>
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

function StatusPill() {
  return (
    <span className="status-pill">
      <ShieldCheck size={16} aria-hidden="true" />
      Approved
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

function viewChrome(view: AppView, skillCount: number): { kicker: string; title: string; description: string } {
  if (view === "admin") {
    return {
      kicker: "",
      title: "Admin console",
      description: "Registration, accounts, providers, and audit history.",
    };
  }
  if (view === "review") {
    return {
      kicker: "",
      title: "Review Dashboard",
      description: "Pending submissions and package evidence.",
    };
  }
  if (view === "submit") {
    return {
      kicker: "",
      title: "Submit Skill",
      description: "Upload packages for maintainer review.",
    };
  }
  if (view === "teams") {
    return {
      kicker: "",
      title: "Teams",
      description: "Team membership, invitations, and shared skill access.",
    };
  }
  return {
    kicker: "",
    title: "Skills List",
    description: `${skillCount} approved ${skillCount === 1 ? "skill" : "skills"} available to this instance.`,
  };
}

function resultCountText(state: LoadState, count: number): string {
  if (state === "loading") {
    return "loading";
  }
  if (state === "error") {
    return "unavailable";
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
  if (pathname === "/admin") {
    return "admin";
  }
  if (pathname === "/review") {
    return "review";
  }
  if (pathname === "/submit") {
    return "submit";
  }
  if (pathname === "/teams") {
    return "teams";
  }
  return "browse";
}

function registrationInviteTokenFromLocation(pathname: string, hash: string): string | null {
  if (pathname !== "/auth/register") {
    return null;
  }
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token")?.trim();
  return token || null;
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

function splitEmails(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
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

function formatPackageSize(bytes: number): string {
  const megabyte = 1024 * 1024;
  const unit = bytes >= megabyte ? "MB" : "KB";
  const value = bytes / (unit === "MB" ? megabyte : 1024);
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value) + ` ${unit}`;
}

function skillSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/skills\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
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
