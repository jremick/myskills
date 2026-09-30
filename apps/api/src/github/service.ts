import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { AppError } from "@myskills-app/core";
import { hashSessionToken } from "@myskills-app/auth";
import { sql } from "drizzle-orm";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { AuthResponseUser } from "../auth/types.js";
import type { Database, DatabaseTransaction } from "../db/client.js";

type Db = Database | DatabaseTransaction;
type Json = Record<string, unknown>;
interface Config {
  enabled: boolean; app_id: string; client_id: string;
  client_secret_ciphertext: string | null; private_key_ciphertext: string | null;
  installation_id: string | null; installation_enabled: boolean; generation: number;
  installation_ciphertext: string | null; installation_expires_at: Date | null;
  installation_invalid: boolean; last_checked_at: Date | null; last_error_code: string | null;
}
interface Connection {
  user_id: string; github_id: string; login: string; config_generation: number;
  access_ciphertext: string | null; refresh_ciphertext: string | null;
  access_expires_at: Date | null; refresh_expires_at: Date | null;
  reconnect_required: boolean; connected_at: Date;
}
interface OAuthState { user_id: string; config_generation: number; verifier_ciphertext: string }
export interface GithubCredential {
  key: string; kind: "anonymous" | "user" | "installation"; token?: string;
  userId?: string; generation?: number;
}
export interface GithubAccountView {
  available: boolean; status: "disconnected" | "connected" | "reconnect_required";
  login: string | null; connectedAt: string | null; credentialSource: GithubCredential["kind"];
}
export interface GithubAdminView {
  enabled: boolean; appId: string; clientId: string; installationId: string | null;
  installationEnabled: boolean; hasClientSecret: boolean; hasPrivateKey: boolean;
  callbackUrl: string; status: "not_configured" | "configured" | "connected" | "error";
  lastCheckedAt: string | null; lastErrorCode: string | null;
}
export interface GithubIntegrationOptions {
  db: Database; secret: string; apiBaseUrl: string; webBaseUrl: string;
  transport?: typeof fetch; now?: () => Date;
}

/** Credentials never enter the sign-in provider registry or API readback models. */
export class GithubIntegrationService {
  private readonly db: Database;
  private readonly key: Buffer;
  private readonly transport: typeof fetch;
  private readonly now: () => Date;
  readonly callbackUrl: string;
  private readonly returnUrl: string;

  constructor(options: GithubIntegrationOptions) {
    if (Buffer.byteLength(options.secret) < 32) throw new Error("GitHub integration requires an AUTH_SECRET of at least 32 bytes.");
    this.db = options.db;
    this.key = createHash("sha256").update("myskills:github-credentials:v1\0").update(options.secret).digest();
    this.transport = options.transport ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.callbackUrl = `${safeBase(options.apiBaseUrl)}/v1/account/github/callback`;
    this.returnUrl = `${safeBase(options.webBaseUrl)}/settings`;
  }

  async getAccount(actor: AuthResponseUser): Promise<GithubAccountView> {
    const config = await this.config(this.db);
    const connection = await this.connection(this.db, actor.id);
    return {
      available: configured(config),
      status: !connection ? "disconnected" : connection.reconnect_required || connection.config_generation !== config.generation ? "reconnect_required" : "connected",
      login: connection?.login ?? null,
      connectedAt: connection ? iso(connection.connected_at) : null,
      credentialSource: config.enabled && config.installation_enabled ? "installation" : config.enabled && connection ? "user" : "anonymous",
    };
  }

  async getAdmin(actor: AuthResponseUser): Promise<GithubAdminView> {
    assertAdmin(actor);
    return this.adminView(await this.config(this.db));
  }

  async updateAdmin(actor: AuthResponseUser, input: unknown): Promise<GithubAdminView> {
    assertAdmin(actor);
    const data = parseConfig(input);
    await this.db.transaction(async (tx) => {
      const current = await this.config(tx, "update");
      const secret = data.clientSecret === undefined ? current.client_secret_ciphertext : this.encrypt(data.clientSecret, "config:client-secret");
      const privateKey = data.privateKey === undefined ? current.private_key_ciphertext : this.encrypt(data.privateKey, "config:private-key");
      if (data.enabled && (!secret || !data.appId || !data.clientId)) throw invalid("App ID, client ID and client secret are required.");
      if (data.installationEnabled && (!data.enabled || !data.installationId || !privateKey)) throw invalid("An enabled app, installation ID and private key are required.");
      await tx.execute(sql`UPDATE github_app_config SET enabled=${data.enabled}, app_id=${data.appId}, client_id=${data.clientId},
        client_secret_ciphertext=${secret}, private_key_ciphertext=${privateKey}, installation_id=${data.installationId},
        installation_enabled=${data.installationEnabled}, generation=generation+1, installation_ciphertext=NULL,
        installation_expires_at=NULL, installation_invalid=false, last_checked_at=NULL, last_error_code=NULL, updated_at=${this.now()} WHERE id=true`);
      await tx.execute(sql`DELETE FROM github_oauth_states`);
      // Invalidated tokens are erased; the identity remains to explain reconnect.
      await tx.execute(sql`UPDATE github_user_connections SET access_ciphertext=NULL, refresh_ciphertext=NULL, reconnect_required=true, updated_at=${this.now()}`);
      await this.audit(tx, actor.id, "admin.github.update", { enabled: data.enabled, installationEnabled: data.installationEnabled, appId: data.appId });
    });
    return this.getAdmin(actor);
  }

  async testAdmin(actor: AuthResponseUser): Promise<GithubAdminView> {
    assertAdmin(actor);
    await this.db.transaction(async (tx) => {
      const config = await this.config(tx, "update");
      requireConfigured(config);
      if (!config.private_key_ciphertext && !config.installation_enabled) {
        // OAuth-only configuration is validated by completing a user connection;
        // no GitHub endpoint validates its secret without an authorization code.
        await this.audit(tx, actor.id, "admin.github.test", { outcome: "configuration_checked" });
        return;
      }
      let errorCode: string | null = null;
      try {
        const jwt = this.jwt(config);
        const app = await this.request("https://api.github.com/app", jwt);
        if (String(app.id) !== config.app_id || (app.client_id !== undefined && app.client_id !== config.client_id)) throw appAuthError();
        if (config.installation_enabled) await this.installation(tx, config, true);
      } catch (error) { errorCode = safeErrorCode(error); }
      const installationInvalid = errorCode === null ? false
        : errorCode === "GITHUB_APP_AUTH_FAILED" && config.installation_enabled ? true : config.installation_invalid;
      await tx.execute(sql`UPDATE github_app_config SET last_checked_at=${this.now()}, last_error_code=${errorCode}, installation_invalid=${installationInvalid} WHERE id=true`);
      await this.audit(tx, actor.id, "admin.github.test", { outcome: errorCode ? "failed" : "connected", errorCode });
    });
    return this.getAdmin(actor);
  }

  async connect(actor: AuthResponseUser, sessionToken: string): Promise<{ authorizationUrl: string }> {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const stateHash = hash(state);
    const clientId = await this.db.transaction(async (tx) => {
      const config = await this.config(tx, "share");
      requireConfigured(config);
      await lockUser(tx, actor.id);
      await tx.execute(sql`DELETE FROM github_oauth_states WHERE user_id=${actor.id} OR expires_at <= ${this.now()}`);
      await tx.execute(sql`INSERT INTO github_oauth_states(state_hash,user_id,session_hash,config_generation,verifier_ciphertext,expires_at)
        VALUES(${stateHash},${actor.id},${hash(sessionToken)},${config.generation},${this.encrypt(verifier, `state:${stateHash}`)},${new Date(this.now().getTime() + 600_000)})`);
      return config.client_id;
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: this.callbackUrl, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    return { authorizationUrl: url.toString() };
  }

  async callback(actor: AuthResponseUser, sessionToken: string, input: { state: string; code?: string; error?: string }): Promise<string> {
    const failure = `${this.returnUrl}?github=error`;
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return failure;
    const stateHash = hash(input.state);
    try {
      const connected = await this.db.transaction(async (tx) => {
        const config = await this.config(tx, "share");
        await lockUser(tx, actor.id);
        // Commit state consumption even when the provider rejects the exchange.
        // Holding the user lock also fences disconnect against in-flight exchange.
        const result = await tx.execute(sql`DELETE FROM github_oauth_states WHERE state_hash=${stateHash} AND user_id=${actor.id}
          AND session_hash=${hash(sessionToken)} AND expires_at>${this.now()} RETURNING *`);
        const state = result.rows[0] as unknown as OAuthState | undefined;
        if (!state || input.error || !input.code || !/^[A-Za-z0-9_-]{1,256}$/.test(input.code)
          || !configured(config) || config.generation !== state.config_generation) return false;
        let tokens: Tokens;
        let profile: Json;
        try {
          tokens = await this.exchange(config, { code: input.code, redirect_uri: this.callbackUrl, code_verifier: this.decrypt(state.verifier_ciphertext, `state:${stateHash}`) });
          profile = await this.request("https://api.github.com/user", tokens.access_token);
          if (!/^\d{1,20}$/.test(String(profile.id)) || typeof profile.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)) throw upstreamError();
        } catch { return false; }
        // Session or account revocation during provider I/O must win before save.
        const session = await tx.execute(sql`SELECT s.id FROM auth_sessions s JOIN users u ON u.id=s.user_id
          WHERE s.token_hash=${hashSessionToken(sessionToken)} AND s.user_id=${actor.id}
            AND s.revoked_at IS NULL AND s.expires_at>${this.now()} AND u.status='active' FOR SHARE OF s,u`);
        if (!session.rows[0]) return false;
        await this.saveConnection(tx, actor.id, String(profile.id), profile.login as string, config.generation, tokens);
        await this.audit(tx, actor.id, "account.github.connect", { githubId: String(profile.id) });
        return true;
      });
      return connected ? `${this.returnUrl}?github=connected` : failure;
    } catch { return failure; }
  }

  async disconnect(actor: AuthResponseUser): Promise<GithubAccountView> {
    await this.db.transaction(async (tx) => {
      await this.config(tx, "share");
      await lockUser(tx, actor.id);
      await tx.execute(sql`DELETE FROM github_oauth_states WHERE user_id=${actor.id}`);
      await tx.execute(sql`DELETE FROM github_user_connections WHERE user_id=${actor.id}`);
      await this.audit(tx, actor.id, "account.github.disconnect", {});
    });
    return this.getAccount(actor);
  }

  async credentialKey(userId?: string): Promise<string> {
    const config = await this.config(this.db);
    if (config.enabled && config.installation_enabled) return installationKey(config);
    const connection = config.enabled && userId ? await this.connection(this.db, userId) : undefined;
    return connection ? `github:user:${connection.github_id}` : "github:anonymous";
  }

  async resolve(userId?: string): Promise<GithubCredential> {
    const selected = await this.config(this.db);
    if (!selected.enabled) return { key: "github:anonymous", kind: "anonymous" };
    const resolved = await this.db.transaction(async (tx): Promise<GithubCredential | AppError> => {
      // Installation renewal serializes on the singleton row; user renewals use
      // share + per-user locks so different user quotas do not block one another.
      const config = await this.config(tx, selected.installation_enabled ? "update" : "share");
      if (!config.enabled) return { key: "github:anonymous", kind: "anonymous" };
      if (config.installation_enabled) {
        if (!selected.installation_enabled) return appAuthError(); // Selection changed: retry through caller.
        try { return await this.installation(tx, config); }
        catch (error) {
          if (error instanceof AppError && error.code === "GITHUB_APP_AUTH_FAILED") {
            await tx.execute(sql`UPDATE github_app_config SET installation_invalid=true, installation_ciphertext=NULL, last_error_code='GITHUB_APP_AUTH_FAILED' WHERE id=true`);
          }
          return error instanceof AppError ? error : upstreamError();
        }
      }
      if (!userId) return { key: "github:anonymous", kind: "anonymous" };
      await lockUser(tx, userId);
      const connection = await this.connection(tx, userId);
      if (!connection) return { key: "github:anonymous", kind: "anonymous" };
      if (connection.reconnect_required || connection.config_generation !== config.generation || !connection.access_ciphertext) return reconnectError();
      if (connection.access_expires_at && new Date(connection.access_expires_at).getTime() <= this.now().getTime() + 60_000) {
        try {
          if (!connection.refresh_ciphertext || !connection.refresh_expires_at || new Date(connection.refresh_expires_at).getTime() <= this.now().getTime()) throw reconnectError();
          const tokens = await this.exchange(config, { grant_type: "refresh_token", refresh_token: this.decrypt(connection.refresh_ciphertext, `user:${userId}:refresh`) });
          await this.saveConnection(tx, userId, connection.github_id, connection.login, config.generation, tokens);
          return { key: `github:user:${connection.github_id}`, kind: "user", token: tokens.access_token, userId, generation: config.generation };
        } catch (error) {
          if (error instanceof AppError && error.code === "GITHUB_RECONNECT_REQUIRED") {
            await tx.execute(sql`UPDATE github_user_connections SET reconnect_required=true,access_ciphertext=NULL,refresh_ciphertext=NULL,updated_at=${this.now()} WHERE user_id=${userId}`);
          }
          return error instanceof AppError ? error : upstreamError();
        }
      }
      return { key: `github:user:${connection.github_id}`, kind: "user", token: this.decrypt(connection.access_ciphertext, `user:${userId}:access`), userId, generation: config.generation };
    });
    if (resolved instanceof AppError) throw resolved;
    return resolved;
  }

  async markInvalid(credential: GithubCredential): Promise<void> {
    if (!credential.token || credential.kind === "anonymous") return;
    await this.db.transaction(async (tx) => {
      const config = await this.config(tx, credential.kind === "installation" ? "update" : "share");
      if (config.generation !== credential.generation) return;
      if (credential.kind === "installation") {
        if (config.installation_ciphertext && this.decrypt(config.installation_ciphertext, "config:installation") === credential.token) {
          await tx.execute(sql`UPDATE github_app_config SET installation_ciphertext=NULL,installation_invalid=true,last_error_code='GITHUB_APP_AUTH_FAILED' WHERE id=true`);
        }
      } else if (credential.userId) {
        await lockUser(tx, credential.userId);
        const connection = await this.connection(tx, credential.userId);
        if (connection?.access_ciphertext && this.decrypt(connection.access_ciphertext, `user:${credential.userId}:access`) === credential.token) {
          await tx.execute(sql`UPDATE github_user_connections SET reconnect_required=true,access_ciphertext=NULL,refresh_ciphertext=NULL,updated_at=${this.now()} WHERE user_id=${credential.userId}`);
        }
      }
    });
  }

  private async config(db: Db, lock?: "share" | "update"): Promise<Config> {
    const result = await db.execute(sql`SELECT * FROM github_app_config WHERE id=true ${lock === "update" ? sql`FOR UPDATE` : lock === "share" ? sql`FOR SHARE` : sql``}`);
    if (!result.rows[0]) throw new AppError("GitHub configuration is unavailable.", "GITHUB_NOT_CONFIGURED", 503);
    return result.rows[0] as unknown as Config;
  }
  private async connection(db: Db, userId: string): Promise<Connection | undefined> {
    const result = await db.execute(sql`SELECT c.* FROM github_user_connections c JOIN users u ON u.id=c.user_id WHERE c.user_id=${userId} AND u.status='active'`);
    return result.rows[0] as unknown as Connection | undefined;
  }
  private adminView(config: Config): GithubAdminView {
    return { enabled: config.enabled, appId: config.app_id, clientId: config.client_id, installationId: config.installation_id,
      installationEnabled: config.installation_enabled, hasClientSecret: !!config.client_secret_ciphertext, hasPrivateKey: !!config.private_key_ciphertext,
      callbackUrl: this.callbackUrl, status: !configured(config) ? "not_configured" : config.last_error_code || config.installation_invalid ? "error" : config.last_checked_at ? "connected" : "configured",
      lastCheckedAt: config.last_checked_at ? iso(config.last_checked_at) : null, lastErrorCode: config.last_error_code };
  }
  private async saveConnection(tx: DatabaseTransaction, userId: string, githubId: string, login: string, generation: number, tokens: Tokens): Promise<void> {
    const access = this.encrypt(tokens.access_token, `user:${userId}:access`);
    const refresh = tokens.refresh_token ? this.encrypt(tokens.refresh_token, `user:${userId}:refresh`) : null;
    const accessExpiry = tokens.expires_in ? new Date(this.now().getTime() + tokens.expires_in * 1000) : null;
    const refreshExpiry = tokens.refresh_token_expires_in ? new Date(this.now().getTime() + tokens.refresh_token_expires_in * 1000) : null;
    await tx.execute(sql`INSERT INTO github_user_connections(user_id,github_id,login,config_generation,access_ciphertext,refresh_ciphertext,access_expires_at,refresh_expires_at,connected_at,updated_at)
      VALUES(${userId},${githubId},${login},${generation},${access},${refresh},${accessExpiry},${refreshExpiry},${this.now()},${this.now()})
      ON CONFLICT(user_id) DO UPDATE SET github_id=excluded.github_id,login=excluded.login,config_generation=excluded.config_generation,
        access_ciphertext=excluded.access_ciphertext,refresh_ciphertext=excluded.refresh_ciphertext,access_expires_at=excluded.access_expires_at,
        refresh_expires_at=excluded.refresh_expires_at,reconnect_required=false,updated_at=excluded.updated_at`);
  }
  private async installation(tx: DatabaseTransaction, config: Config, force = false): Promise<GithubCredential> {
    requireConfigured(config);
    if (!config.installation_id || (config.installation_invalid && !force)) throw appAuthError();
    if (!force && config.installation_ciphertext && config.installation_expires_at && new Date(config.installation_expires_at).getTime() > this.now().getTime() + 60_000) {
      return { key: installationKey(config), kind: "installation", token: this.decrypt(config.installation_ciphertext, "config:installation"), generation: config.generation };
    }
    const jwt = this.jwt(config);
    const install = await this.request(`https://api.github.com/app/installations/${config.installation_id}`, jwt);
    if (String(install.id) !== config.installation_id || String(install.app_id) !== config.app_id || install.target_type !== "Organization" || install.suspended_at) throw appAuthError();
    const result = await this.request(`https://api.github.com/app/installations/${config.installation_id}/access_tokens`, jwt, { permissions: { contents: "read", metadata: "read" } });
    const expiry = typeof result.expires_at === "string" ? new Date(result.expires_at) : new Date(NaN);
    if (typeof result.token !== "string" || !validToken(result.token) || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= this.now().getTime() + 60_000) throw appAuthError();
    const permissions = result.permissions;
    if (!permissions || typeof permissions !== "object" || Object.entries(permissions).some(([key, value]) => !["contents", "metadata"].includes(key) || value !== "read")) throw appAuthError();
    await tx.execute(sql`UPDATE github_app_config SET installation_ciphertext=${this.encrypt(result.token, "config:installation")},installation_expires_at=${expiry},installation_invalid=false,last_error_code=NULL WHERE id=true`);
    return { key: installationKey(config), kind: "installation", token: result.token, generation: config.generation };
  }
  private jwt(config: Config): string {
    if (!config.private_key_ciphertext) throw appAuthError();
    const seconds = Math.floor(this.now().getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.client_id })).toString("base64url");
    try { return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.decrypt(config.private_key_ciphertext, "config:private-key")).toString("base64url")}`; }
    catch { throw appAuthError(); }
  }
  private async exchange(config: Config, values: Record<string, string>): Promise<Tokens> {
    if (!config.client_secret_ciphertext) throw reconnectError();
    const body = new URLSearchParams({ client_id: config.client_id, client_secret: this.decrypt(config.client_secret_ciphertext, "config:client-secret"), ...values });
    const result = await this.fetchJson("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (typeof result.error === "string") {
      if (["bad_refresh_token", "bad_verification_code", "incorrect_client_credentials", "expired_token", "access_denied"].includes(result.error)) throw reconnectError();
      throw upstreamError();
    }
    if (result.token_type !== "bearer" || typeof result.access_token !== "string" || !validToken(result.access_token)) throw reconnectError();
    if (result.expires_in !== undefined && (!positiveSeconds(result.expires_in) || typeof result.refresh_token !== "string" || !validToken(result.refresh_token) || !positiveSeconds(result.refresh_token_expires_in))) throw reconnectError();
    return result as unknown as Tokens;
  }
  private request(url: string, token: string, body?: Json): Promise<Json> {
    return this.fetchJson(url, { method: body ? "POST" : "GET", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  private async fetchJson(url: string, init: RequestInit): Promise<Json> {
    try {
      const target = new URL(url);
      if (target.origin !== "https://api.github.com" && url !== "https://github.com/login/oauth/access_token") throw upstreamError();
      const response = await this.transport(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (response.status === 401 || response.status === 404) throw target.hostname === "github.com" ? reconnectError() : appAuthError();
      if (!response.ok) throw upstreamError();
      if (Number(response.headers.get("content-length") ?? "0") > 65_536) throw upstreamError();
      const reader = response.body?.getReader();
      if (!reader) throw upstreamError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65_536) throw upstreamError();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw upstreamError();
      return parsed as Json;
    } catch (error) { throw error instanceof AppError ? error : upstreamError(); }
  }
  private encrypt(value: string, purpose: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`myskills:github:v1:${purpose}`));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${bytes.toString("base64url")}`;
  }
  private decrypt(value: string, purpose: string): string {
    try {
      const [version, iv, tag, bytes] = value.split(":");
      if (version !== "v1" || !iv || !tag || !bytes) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(`myskills:github:v1:${purpose}`));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(bytes, "base64url")), decipher.final()]).toString("utf8");
    } catch { throw new AppError("GitHub credentials cannot be read. Reconfigure the connection.", "GITHUB_CREDENTIAL_UNAVAILABLE", 503); }
  }
  private async audit(db: Db, actorId: string, action: string, details: Json): Promise<void> {
    await db.execute(sql`INSERT INTO audit_events(actor_user_id,action,decision,resource_type,details)
      VALUES(${actorId},${action},'allow','github_integration',${JSON.stringify(sanitizeAuditDetails(details))}::jsonb)`);
  }
}

interface Tokens { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function iso(value: Date): string { return new Date(value).toISOString(); }
function installationKey(config: Config): string { return `github:installation:${config.app_id}:${config.installation_id}`; }
function configured(config: Config): boolean { return config.enabled && !!config.client_id && !!config.client_secret_ciphertext; }
function requireConfigured(config: Config): void { if (!configured(config)) throw new AppError("An administrator must configure GitHub first.", "GITHUB_NOT_CONFIGURED", 409); }
function invalid(message = "GitHub configuration is invalid."): AppError { return new AppError(message, "INVALID_REQUEST_BODY", 400); }
function reconnectError(): AppError { return new AppError("Reconnect your GitHub account to continue source checks.", "GITHUB_RECONNECT_REQUIRED", 401); }
function appAuthError(): AppError { return new AppError("Ask an administrator to check the GitHub App connection.", "GITHUB_APP_AUTH_FAILED", 503); }
function upstreamError(): AppError { return new AppError("GitHub did not return a valid response. Try again later.", "GITHUB_UPSTREAM_UNAVAILABLE", 503); }
function safeErrorCode(error: unknown): string { return error instanceof AppError ? error.code : "GITHUB_UPSTREAM_UNAVAILABLE"; }
// Treat both classic and stateless GitHub tokens as opaque RFC 6750 credentials.
function validToken(value: string): boolean { return value.length >= 8 && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value); }
function positiveSeconds(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 31_536_000; }
async function lockUser(db: Db, userId: string): Promise<void> { await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`github-user:${userId}`},0))`); }
function assertAdmin(actor: AuthResponseUser): void {
  if (!actor.roles.some((role) => role === "owner" || role === "admin")) throw new AppError("Admin privileges are required.", "ADMIN_ROLE_REQUIRED", 403);
  if (!actor.mfaVerified) throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
}
function safeBase(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("GitHub integration requires a trusted HTTPS base URL.");
  return url.toString().replace(/\/$/, "");
}
function parseConfig(input: unknown): { enabled: boolean; appId: string; clientId: string; installationId: string | null; installationEnabled: boolean; clientSecret?: string; privateKey?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const data = input as Json;
  if (Object.keys(data).some((key) => !["enabled", "appId", "clientId", "installationId", "installationEnabled", "clientSecret", "privateKey"].includes(key))) throw invalid();
  if (typeof data.enabled !== "boolean" || typeof data.installationEnabled !== "boolean" || typeof data.appId !== "string" || !/^\d{0,20}$/.test(data.appId)
    || typeof data.clientId !== "string" || !/^[A-Za-z0-9_.-]{0,100}$/.test(data.clientId)
    || (data.installationId !== null && (typeof data.installationId !== "string" || !/^\d{1,20}$/.test(data.installationId)))) throw invalid();
  if (data.clientSecret !== undefined && (typeof data.clientSecret !== "string" || data.clientSecret.length < 8 || data.clientSecret.length > 512 || /\s/.test(data.clientSecret))) throw invalid();
  if (data.privateKey !== undefined) {
    if (typeof data.privateKey !== "string" || data.privateKey.length > 16_384) throw invalid();
    try {
      const key = createPrivateKey(data.privateKey);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw invalid();
    } catch { throw invalid("Provide a valid RSA private key with at least 2048 bits."); }
  }
  return data as ReturnType<typeof parseConfig>;
}
