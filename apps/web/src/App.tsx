import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  Copy,
  FileCode2,
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
  UserCog,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { PublicSkill } from "@ai-skills-share/core";
import {
  createRegistryClient,
  exportCommand,
  safeAdminErrorMessage,
  safeAuthErrorMessage,
  safeErrorMessage,
  type AdminAuditEvent,
  type AdminProviderConfig,
  type AdminRegistrationMode,
  type AdminUser,
  type ProviderRoleMappingInput,
  type RegistryClient,
  type ReleaseMetadata,
  type WebAuthUser,
} from "./api.js";

interface RegistryAppProps {
  client?: RegistryClient;
}

type LoadState = "idle" | "loading" | "ready" | "error";
type AuthState = "idle" | "loading" | "mfa";
type AppView = "browse" | "admin";

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

export function RegistryApp({ client }: RegistryAppProps) {
  const initialSlug = skillSlugFromPath(window.location.pathname);
  const [view, setView] = useState<AppView>(window.location.pathname === "/admin" ? "admin" : "browse");
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
  const [message, setMessage] = useState<string | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("idle");
  const [mfaPending, setMfaPending] = useState<MfaPending | null>(null);
  const canUseAdmin = Boolean(session && isAdminUser(session.user));
  const activeView: AppView = view === "admin" && canUseAdmin ? "admin" : "browse";

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
  }, [registryClient, query]);

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

  function selectSkill(slug: string) {
    setView("browse");
    setSelectedSlug(slug);
    window.history.replaceState({}, "", `/skills/${slug}`);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => {
          event.preventDefault();
          setView("browse");
          setSelectedSlug(skills[0]?.slug ?? null);
          window.history.replaceState({}, "", "/");
        }}>
          <span className="brand-mark" aria-hidden="true"><PackageOpen size={22} /></span>
          <span>AI Skills Share</span>
        </a>
        <label className="global-search" htmlFor="skill-search">
          <Search size={18} aria-hidden="true" />
          <input
            id="skill-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills..."
            autoComplete="off"
          />
          <kbd>/</kbd>
        </label>
        <div className="topbar-actions">
          {canUseAdmin && (
            <button
              className={activeView === "admin" ? "admin-nav active" : "admin-nav"}
              type="button"
              onClick={() => {
                setView("admin");
                window.history.replaceState({}, "", "/admin");
              }}
            >
              <Settings size={16} aria-hidden="true" />
              Admin
            </button>
          )}
          <div className={listState === "error" ? "api-state api-state-error" : "api-state"} aria-live="polite">
            <span className="status-dot" />
            {listState === "error" ? "API unavailable" : "API connected"}
            <ChevronsUpDown size={16} aria-hidden="true" />
          </div>
          <AuthWidget
            authMessage={authMessage}
            authState={authState}
            mfaPending={mfaPending}
            onLogin={async (input) => {
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
            }}
            onLogout={async () => {
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
            }}
            onVerifyMfa={async (codeOrRecoveryCode) => {
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
            }}
            session={session}
          />
        </div>
      </header>

      {activeView === "admin" && session ? (
        <AdminConsole client={registryClient} session={session} />
      ) : (
        <main className="workspace">
          <section className="results-panel" aria-label="Skill search results">
            <div className="panel-heading">
              <div>
                <h1>Search results</h1>
                <p>{resultCountText(listState, skills.length)}</p>
              </div>
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
                  <SkillIcon slug={skill.slug} />
                  <span className="result-main">
                    <strong>{skill.title}</strong>
                    <span>{skill.slug}</span>
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
                platform={platform}
                release={release}
                selectedSkill={selectedSkill}
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
    try {
      const updated = await client.performAdminUserAction(userId, action, session.token);
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
                <span>{user.roles.join(", ") || "user"}</span>
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

function StatusToken({ value }: { value: string }) {
  return <span className={`status-token status-token-${value}`}>{value}</span>;
}

function AuthWidget({
  authMessage,
  authState,
  mfaPending,
  onLogin,
  onLogout,
  onVerifyMfa,
  session,
}: {
  authMessage: string | null;
  authState: AuthState;
  mfaPending: MfaPending | null;
  onLogin: (input: { email: string; password: string }) => Promise<void>;
  onLogout: () => Promise<void>;
  onVerifyMfa: (codeOrRecoveryCode: string) => Promise<void>;
  session: WebSession | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");

  if (session) {
    return (
      <div className="auth-widget signed-in" aria-label="Authenticated user">
        <UserRound size={17} aria-hidden="true" />
        <span>
          <strong>{session.user.email}</strong>
          <small>{session.user.roles.join(", ") || "user"} · {session.user.mfaVerified ? "MFA" : "no MFA"}</small>
        </span>
        <button type="button" onClick={() => void onLogout()} aria-label="Sign out">
          <LogOut size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

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
        <StatusPill />
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

function StatusPill() {
  return (
    <span className="status-pill">
      <ShieldCheck size={16} aria-hidden="true" />
      Approved
    </span>
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

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function skillSlugFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/skills\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
  return match?.[1] ?? null;
}

const SESSION_STORAGE_KEY = "ai-skills-share:web-session";

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
