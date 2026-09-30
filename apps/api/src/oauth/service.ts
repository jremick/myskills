import { AppError, APPLICATION_PRIVILEGED_SCOPES } from "@myskills-app/core";
import type { AuthResponseUser, AuthStore, AuthUserRecord } from "../auth/types.js";
import { canonicalResource, validateRedirectUri, type OAuthConfig } from "./config.js";
import {
  ACCESS_TOKEN_PREFIX,
  AUTHORIZATION_CODE_PREFIX,
  CLIENT_SECRET_PREFIX,
  DYNAMIC_CLIENT_PREFIX,
  PKCE_CHALLENGE_PATTERN,
  REFRESH_TOKEN_PREFIX,
  REQUEST_HANDLE_PATTERN,
  digestsEqual,
  hasTokenShape,
  isPkceVerifier,
  randomClientId,
  randomSecret,
  secretDigest,
  verifyPkceS256,
} from "./tokens.js";
import {
  OAUTH_SCOPES,
  OAUTH_SCOPE_DESCRIPTIONS,
  OAUTH_SCOPE_READ_ONLY,
  OAUTH_ASSURANCE_WINDOW_MS,
  type OAuthClientAuthMethod,
  type OAuthClientRecord,
  type OAuthGrantRecord,
  type OAuthGrantRevocationReason,
  type OAuthScope,
  type OAuthStore,
} from "./types.js";

export const OAUTH_STATE_MAX_CHARS = 1024;
const MAX_PARAMETER_CHARS = 2048;
const MAX_CLIENT_NAME_CHARS = 100;
const GRANT_TOUCH_INTERVAL_MS = 60_000;
const PRIVILEGED_ROLES = new Set(["owner", "admin", "maintainer"]);

export type OAuthParams = Record<string, string | string[] | undefined>;

/** RFC 6749 section 5.2 style error for the token, revocation and registration endpoints. */
export class OAuthProtocolError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly statusCode = 400,
  ) {
    super(description);
  }
}

export interface OAuthAccessContext {
  user: AuthUserRecord;
  grantId: string;
  clientId: string;
  scopes: OAuthScope[];
  resource: string;
  mfaVerifiedAt: Date | null;
  assuranceExpiresAt: Date | null;
}

export interface OAuthConnectionSummary {
  id: string;
  client: { id: string; name: string; registration: "dynamic" | "configured" };
  scopes: OAuthScope[];
  resource: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

export class OAuthService {
  private readonly now: () => Date;

  constructor(private readonly options: { store: OAuthStore; authStore: AuthStore; config: OAuthConfig; now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
  }

  get config(): OAuthConfig {
    return this.options.config;
  }

  metadata(): Record<string, unknown> {
    const { issuer, dynamicRegistration } = this.options.config;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      ...(dynamicRegistration ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [...OAUTH_SCOPES],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    };
  }

  connectorInfo() {
    const { issuer, resource, dynamicRegistration } = this.options.config;
    return {
      enabled: true,
      mcpUrl: resource,
      issuer,
      dynamicRegistration,
      scopes: OAUTH_SCOPES.map(scopeDescriptor),
    };
  }

  // --- dynamic client registration (RFC 7591) ---------------------------------

  async registerClient(body: unknown): Promise<Record<string, unknown>> {
    if (!this.options.config.dynamicRegistration) {
      throw new OAuthProtocolError("invalid_request", "Dynamic client registration is not enabled.", 404);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new OAuthProtocolError("invalid_client_metadata", "Client metadata must be a JSON object.");
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5) {
      throw new OAuthProtocolError("invalid_redirect_uri", "Register between one and five exact redirect URIs.");
    }
    const validated = redirectUris.map((uri) => validateRedirectUri(uri, this.options.config.redirectHosts));
    if (validated.some((uri) => uri === null)) {
      throw new OAuthProtocolError("invalid_redirect_uri", "Each redirect URI must be an exact https URL on an allowed host.");
    }
    const authMethod = metadata.token_endpoint_auth_method ?? "client_secret_basic";
    if (authMethod !== "none" && authMethod !== "client_secret_post" && authMethod !== "client_secret_basic") {
      throw new OAuthProtocolError("invalid_client_metadata", "Unsupported token endpoint authentication method.");
    }
    const grantTypes = metadata.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grantTypes) || grantTypes.length === 0 || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
      throw new OAuthProtocolError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
    }
    const responseTypes = metadata.response_types ?? ["code"];
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
      throw new OAuthProtocolError("invalid_client_metadata", "Only the code response type is supported.");
    }
    const clientName = cleanClientName(metadata.client_name);
    const secret = authMethod === "none" ? null : randomSecret(CLIENT_SECRET_PREFIX);
    const now = this.now();
    const client = await this.options.store.createDynamicClient({
      client: {
        clientId: randomClientId(),
        clientName,
        redirectUris: [...new Set(validated as string[])],
        tokenEndpointAuthMethod: authMethod,
        clientSecretHash: secret ? secretDigest(secret) : null,
      },
      now,
      maxClients: this.options.config.maxDynamicClients,
    });
    if (!client) {
      throw new OAuthProtocolError("temporarily_unavailable", "Client registration capacity is exhausted. Try again later.", 503);
    }
    await this.audit({ actorUserId: null, action: "oauth.client.register", decision: "allow", details: { clientId: client.clientId, authMethod, redirectOrigins: client.redirectUris.map((uri) => new URL(uri).origin) } });
    // Untrusted URIs such as logo_uri or client_uri are neither stored, echoed nor fetched.
    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    };
  }

  // --- authorization endpoint --------------------------------------------------

  /** Returns the redirect location. Never redirects to an unverified client URI. */
  async authorize(query: OAuthParams): Promise<string> {
    const { config } = this.options;
    const errorPage = (code: string) => `${config.consentOrigin}/connect/authorize?error=${encodeURIComponent(code)}`;
    const clientId = single(query, "client_id");
    if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 160) return errorPage("invalid_client");
    const client = await this.resolveClient(clientId);
    if (!client) return errorPage("invalid_client");
    const redirectUri = single(query, "redirect_uri");
    if (typeof redirectUri !== "string" || !client.redirectUris.includes(redirectUri)) return errorPage("invalid_redirect_uri");

    const stateValue = single(query, "state");
    const state = typeof stateValue === "string" && stateValue.length <= OAUTH_STATE_MAX_CHARS ? stateValue : null;
    const fail = (error: string) => this.clientRedirect(redirectUri, { error }, state);
    if (stateValue === DUPLICATE || (typeof stateValue === "string" && stateValue.length > OAUTH_STATE_MAX_CHARS)) return fail("invalid_request");
    if (Object.values(query).some((value) => Array.isArray(value) || (typeof value === "string" && value.length > MAX_PARAMETER_CHARS))) return fail("invalid_request");
    if (query.response_type !== "code") return fail("unsupported_response_type");
    const challenge = query.code_challenge;
    if (query.code_challenge_method !== "S256" || typeof challenge !== "string" || !PKCE_CHALLENGE_PATTERN.test(challenge)) return fail("invalid_request");
    const scopes = parseScopes(query.scope as string | undefined);
    if (!scopes) return fail("invalid_scope");
    const resource = query.resource as string | undefined;
    if (resource !== undefined && canonicalResource(resource) !== canonicalResource(config.resource)) return fail("invalid_target");

    const handle = randomSecret();
    const now = this.now();
    await this.options.store.createAuthorizationRequest({
      handleHash: secretDigest(handle),
      clientId: client.clientId,
      redirectUri,
      scopes,
      resource: config.resource,
      state,
      codeChallenge: challenge,
      now,
      expiresAt: new Date(now.getTime() + config.authorizationRequestTtlSeconds * 1000),
    });
    // The handle travels in the fragment so it stays out of server logs and Referer headers.
    return `${config.consentOrigin}/connect/authorize#request=${handle}`;
  }

  // --- consent ---------------------------------------------------------------

  async inspect(actor: AuthResponseUser, handle: unknown, sessionTokenHash?: string) {
    const { request, client } = await this.pendingRequest(handle);
    const now = this.now();
    const session = sessionTokenHash ? await this.options.authStore.findUserBySessionTokenHash(sessionTokenHash, now) : null;
    const stamp = session?.id === actor.id && isUsableAccount(session) ? session.sessionMfaVerifiedAt : null;
    const mfaVerifiedAt = stamp && Number.isFinite(stamp.getTime()) && stamp <= now ? stamp : null;
    const assuranceExpiresAt = mfaVerifiedAt ? new Date(mfaVerifiedAt.getTime() + OAUTH_ASSURANCE_WINDOW_MS) : null;
    const policy = await this.consentMfaPolicy(actor, request.scopes);
    return {
      client: clientSummary(client, request.redirectUri),
      scopes: request.scopes.map(scopeDescriptor),
      resource: request.resource,
      expiresAt: request.expiresAt.toISOString(),
      account: { email: actor.email, mfaVerified: mfaVerifiedAt !== null },
      mfaRequired: (policy.requireMfa && !mfaVerifiedAt)
        || (policy.requireFreshMfa && (!assuranceExpiresAt || assuranceExpiresAt <= now)),
      assuranceExpiresAt: assuranceExpiresAt?.toISOString() ?? null,
    };
  }

  /** sessionTokenHash identifies the approving session so the store can recheck it under the account lock. */
  async decide(actor: AuthResponseUser, sessionTokenHash: string, handle: unknown, decision: unknown): Promise<{ redirectTo: string }> {
    if (decision !== "approve" && decision !== "deny") {
      throw new AppError("Choose approve or deny.", "INVALID_REQUEST_BODY", 400);
    }
    const { request, client } = await this.pendingRequest(handle);
    const policy = await this.consentMfaPolicy(actor, request.scopes);
    const now = this.now();
    const code = decision === "approve" ? randomSecret(AUTHORIZATION_CODE_PREFIX) : null;
    const result = await this.options.store.decideAuthorizationRequest({
      handleHash: secretDigest(handle as string),
      userId: actor.id,
      sessionTokenHash,
      decision,
      now,
      ...(code ? { code: { codeHash: secretDigest(code), expiresAt: new Date(now.getTime() + this.options.config.codeTtlSeconds * 1000) } } : {}),
      maxActiveGrantsPerUser: this.options.config.maxConnectionsPerUser,
      ...policy,
    });
    if (result.outcome === "session_revoked") throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
    if (result.outcome === "mfa_required") {
      throw new AppError("Sign in and verify MFA again, then return to approve this connection.", "MFA_VERIFICATION_REQUIRED", 403, {
        reason: "oauth_consent_assurance_required", action: "reauthenticate", assuranceWindowSeconds: OAUTH_ASSURANCE_WINDOW_MS / 1000,
      });
    }
    if (result.outcome === "not_found") throw requestNotFound();
    if (result.outcome === "expired") throw requestExpired();
    if (result.outcome === "already_decided") throw requestDecided();
    if (result.outcome === "connection_limit") {
      throw new AppError("This account has too many active connections. Revoke one in Settings before connecting another.", "OAUTH_CONNECTION_LIMIT", 409);
    }
    if (result.outcome !== "decided") throw requestNotFound();
    await this.audit({
      actorUserId: actor.id,
      action: "oauth.consent",
      decision: decision === "approve" ? "allow" : "deny",
      details: { clientId: client.clientId, registration: client.registration, scopes: result.request.scopes, redirectOrigin: new URL(result.request.redirectUri).origin },
    });
    return {
      redirectTo: this.clientRedirect(result.request.redirectUri, code ? { code } : { error: "access_denied" }, result.request.state),
    };
  }

  // --- token endpoint ----------------------------------------------------------

  async token(params: OAuthParams, authorization: string | undefined): Promise<Record<string, unknown>> {
    rejectDuplicates(params);
    const grantType = params.grant_type;
    if (typeof grantType !== "string") throw new OAuthProtocolError("invalid_request", "grant_type is required.");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      throw new OAuthProtocolError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    }
    const client = await this.authenticateClient(params, authorization);
    const resource = params.resource as string | undefined;
    if (resource !== undefined && canonicalResource(resource) !== canonicalResource(this.options.config.resource)) {
      throw new OAuthProtocolError("invalid_target", "The requested resource is not served by this authorization server.");
    }
    return grantType === "authorization_code"
      ? this.exchangeCode(client, params)
      : this.refresh(client, params);
  }

  async revoke(params: OAuthParams, authorization: string | undefined): Promise<void> {
    rejectDuplicates(params);
    const client = await this.authenticateClient(params, authorization);
    const token = params.token;
    if (typeof token !== "string" || token.length === 0) throw new OAuthProtocolError("invalid_request", "token is required.");
    const now = this.now();
    if (hasTokenShape(token, REFRESH_TOKEN_PREFIX)) {
      const found = await this.options.store.findRefreshToken(secretDigest(token));
      if (found && found.grant.clientId === client.clientId) {
        await this.revokeGrant(found.grant.id, "client", now, { clientId: client.clientId });
      }
    } else if (hasTokenShape(token, ACCESS_TOKEN_PREFIX)) {
      await this.options.store.revokeAccessToken({ tokenHash: secretDigest(token), clientId: client.clientId, now });
    }
    // RFC 7009: unknown or foreign tokens still receive 200.
  }

  // --- account connection management -------------------------------------------

  async listConnections(userId: string): Promise<OAuthConnectionSummary[]> {
    const grants = await this.options.store.listActiveGrants({ userId, now: this.now() });
    return grants.map(connectionSummary);
  }

  async revokeConnection(userId: string, connectionId: string): Promise<OAuthConnectionSummary> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(connectionId)) throw connectionNotFound();
    const grant = await this.revokeGrant(connectionId, "user", this.now(), { userId, actorUserId: userId });
    if (!grant) throw connectionNotFound();
    return connectionSummary(grant);
  }

  // --- resource-side verification ----------------------------------------------

  async verifyAccessToken(token: string): Promise<OAuthAccessContext | null> {
    if (!hasTokenShape(token, ACCESS_TOKEN_PREFIX)) return null;
    const found = await this.options.store.findAccessToken(secretDigest(token));
    if (!found) return null;
    const now = this.now();
    const { token: record, grant } = found;
    if (record.revokedAt || record.expiresAt <= now || grant.revokedAt || grant.expiresAt <= now) return null;
    if (canonicalResource(grant.resource) !== canonicalResource(this.options.config.resource)) return null;
    if (!(await this.clientStillValid(grant.clientId))) return null;
    const user = await this.options.authStore.findUserById(grant.userId);
    if (!user || !isUsableAccount(user)) return null;
    if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() > GRANT_TOUCH_INTERVAL_MS) {
      await this.options.store.touchGrant({ grantId: grant.id, now });
    }
    return {
      user, grantId: grant.id, clientId: grant.clientId, scopes: record.scopes, resource: grant.resource,
      mfaVerifiedAt: grant.mfaVerifiedAt ?? null, assuranceExpiresAt: grant.assuranceExpiresAt ?? null,
    };
  }

  async cleanup(): Promise<void> {
    await this.options.store.cleanup(this.now());
  }

  // --- internals ---------------------------------------------------------------

  private async exchangeCode(client: OAuthClientRecord, params: OAuthParams): Promise<Record<string, unknown>> {
    const code = params.code;
    const redirectUri = params.redirect_uri;
    const verifier = params.code_verifier;
    if (typeof code !== "string" || typeof redirectUri !== "string" || typeof verifier !== "string" || !isPkceVerifier(verifier)) {
      throw new OAuthProtocolError("invalid_request", "code, redirect_uri and a valid code_verifier are required.");
    }
    if (!hasTokenShape(code, AUTHORIZATION_CODE_PREFIX)) throw invalidGrant();
    const now = this.now();
    const access = this.newAccessToken(now);
    const refresh = this.newRefreshToken(now);
    const grantExpiresAt = new Date(now.getTime() + this.options.config.connectionTtlSeconds * 1000);
    const accessExpiresAt = minDate(access.expiresAt, grantExpiresAt);
    const resource = this.options.config.resource;
    const redeemed = await this.options.store.redeemAuthorizationCode({
      codeHash: secretDigest(code),
      now,
      // Runs after the code is consumed: every mismatch burns the code.
      verify: (record) => record.expiresAt > now
        && record.clientId === client.clientId
        && record.redirectUri === redirectUri
        && verifyPkceS256(verifier, record.codeChallenge)
        && canonicalResource(record.resource) === canonicalResource(resource),
      issue: (record) => ({
        grant: {
          userId: record.userId,
          clientId: client.clientId,
          clientName: client.clientName,
          registration: client.registration,
          scopes: record.scopes,
          resource: record.resource,
          createdAt: now,
          expiresAt: grantExpiresAt,
          mfaVerifiedAt: record.mfaVerifiedAt ?? null,
          assuranceExpiresAt: record.assuranceExpiresAt ?? null,
        },
        accessToken: { tokenHash: secretDigest(access.token), expiresAt: accessExpiresAt, scopes: record.scopes },
        refreshToken: { tokenHash: secretDigest(refresh.token), expiresAt: minDate(refresh.expiresAt, grantExpiresAt) },
      }),
      maxActiveGrantsPerUser: this.options.config.maxConnectionsPerUser,
    });
    if (redeemed.outcome === "replayed") {
      const revoked = redeemed.revokedGrant;
      if (revoked) {
        await this.audit({ actorUserId: null, action: "oauth.connection.revoke", decision: "allow", resourceId: revoked.id, details: { clientId: revoked.clientId, reason: "code_replay" } });
      }
      await this.audit({ actorUserId: null, action: "oauth.code_replay", decision: "deny", details: { clientId: client.clientId } });
      throw invalidGrant();
    }
    if (redeemed.outcome === "connection_limit") {
      throw new OAuthProtocolError("invalid_grant", "This account has reached its active connection limit.");
    }
    if (redeemed.outcome !== "issued") throw invalidGrant();
    const { grant, code: record } = redeemed;
    // The account is rechecked after issuance so a disable that raced the
    // exchange still ends the new connection before any token is returned.
    const user = await this.options.authStore.findUserById(record.userId);
    if (!user || !isUsableAccount(user)) {
      await this.revokeGrant(grant.id, "account", now, {});
      throw invalidGrant();
    }
    await this.audit({ actorUserId: record.userId, action: "oauth.connection.create", decision: "allow", resourceId: grant.id, details: { clientId: client.clientId, scopes: record.scopes } });
    return tokenResponse(access.token, refresh.token, accessExpiresAt, now, record.scopes);
  }

  private async refresh(client: OAuthClientRecord, params: OAuthParams): Promise<Record<string, unknown>> {
    const refreshToken = params.refresh_token;
    if (typeof refreshToken !== "string") throw new OAuthProtocolError("invalid_request", "refresh_token is required.");
    if (!hasTokenShape(refreshToken, REFRESH_TOKEN_PREFIX)) throw invalidGrant();
    const tokenHash = secretDigest(refreshToken);
    const found = await this.options.store.findRefreshToken(tokenHash);
    if (!found || found.grant.clientId !== client.clientId) throw invalidGrant();
    const now = this.now();
    if (found.token.usedAt) {
      await this.handleRefreshReuse(found.grant, now);
      throw invalidGrant();
    }
    const { grant } = found;
    if (found.token.revokedAt || found.token.expiresAt <= now || grant.revokedAt || grant.expiresAt <= now) throw invalidGrant();
    let scopes = grant.scopes;
    if (params.scope !== undefined) {
      const requested = parseScopes(params.scope as string);
      if (!requested || requested.some((scope) => !grant.scopes.includes(scope))) {
        throw new OAuthProtocolError("invalid_scope", "A refreshed token cannot exceed the approved scopes.");
      }
      scopes = requested;
    }
    const user = await this.options.authStore.findUserById(grant.userId);
    if (!user || !isUsableAccount(user)) throw invalidGrant();
    const access = this.newAccessToken(now);
    const next = this.newRefreshToken(now);
    const accessExpiresAt = minDate(access.expiresAt, grant.expiresAt);
    const rotated = await this.options.store.rotateRefreshToken({
      tokenHash,
      now,
      accessToken: { tokenHash: secretDigest(access.token), expiresAt: accessExpiresAt, scopes },
      refreshToken: { tokenHash: secretDigest(next.token), expiresAt: minDate(next.expiresAt, grant.expiresAt) },
    });
    if (rotated.outcome === "reused") {
      await this.handleRefreshReuse(grant, now);
      throw invalidGrant();
    }
    if (rotated.outcome !== "rotated") throw invalidGrant();
    return tokenResponse(access.token, next.token, accessExpiresAt, now, scopes);
  }

  private async handleRefreshReuse(grant: OAuthGrantRecord, now: Date): Promise<void> {
    await this.revokeGrant(grant.id, "refresh_reuse", now, {});
    await this.audit({ actorUserId: grant.userId, action: "oauth.refresh_reuse", decision: "deny", resourceId: grant.id, details: { clientId: grant.clientId } });
  }

  private async revokeGrant(
    grantId: string,
    reason: OAuthGrantRevocationReason,
    now: Date,
    scope: { userId?: string; clientId?: string; actorUserId?: string },
  ): Promise<OAuthGrantRecord | null> {
    const grant = await this.options.store.revokeGrant({ grantId, reason, now, ...(scope.userId ? { userId: scope.userId } : {}), ...(scope.clientId ? { clientId: scope.clientId } : {}) });
    if (grant) {
      await this.audit({ actorUserId: scope.actorUserId ?? null, action: "oauth.connection.revoke", decision: "allow", resourceId: grant.id, details: { clientId: grant.clientId, reason } });
    }
    return grant;
  }

  private async authenticateClient(params: OAuthParams, authorization: string | undefined): Promise<OAuthClientRecord> {
    let clientId = typeof params.client_id === "string" ? params.client_id : undefined;
    let secret = typeof params.client_secret === "string" ? params.client_secret : undefined;
    const basic = parseBasicAuthorization(authorization);
    if (basic === "invalid") throw invalidClient();
    if (basic) {
      if (secret !== undefined || (clientId !== undefined && clientId !== basic.clientId)) {
        throw new OAuthProtocolError("invalid_request", "Use exactly one client authentication method.");
      }
      clientId = basic.clientId;
      secret = basic.secret;
    }
    if (!clientId || clientId.length > 160) throw invalidClient();
    const suppliedMethod: OAuthClientAuthMethod = basic ? "client_secret_basic" : secret !== undefined ? "client_secret_post" : "none";
    const client = await this.resolveClient(clientId);
    if (!client || client.tokenEndpointAuthMethod !== suppliedMethod) throw invalidClient();
    if (client.clientSecretHash === null) {
      if (secret) throw invalidClient();
      return client;
    }
    if (!secret || secret.length > 256 || !digestsEqual(secretDigest(secret), client.clientSecretHash)) throw invalidClient();
    return client;
  }

  private async resolveClient(clientId: string): Promise<OAuthClientRecord | null> {
    if (clientId.startsWith(DYNAMIC_CLIENT_PREFIX)) {
      return this.options.config.dynamicRegistration ? this.options.store.findDynamicClient(clientId) : null;
    }
    const configured = this.options.config.clients.find((client) => client.clientId === clientId);
    if (!configured) return null;
    const method: OAuthClientAuthMethod = configured.clientSecretSha256 ? "client_secret_basic" : "none";
    return {
      clientId: configured.clientId,
      clientName: configured.clientName,
      redirectUris: configured.redirectUris,
      tokenEndpointAuthMethod: method,
      clientSecretHash: configured.clientSecretSha256,
      registration: "configured",
      createdAt: new Date(0),
    };
  }

  private async clientStillValid(clientId: string): Promise<boolean> {
    // Removing a configured client or disabling dynamic registration ends its access.
    if (clientId.startsWith(DYNAMIC_CLIENT_PREFIX)) return this.options.config.dynamicRegistration;
    return this.options.config.clients.some((client) => client.clientId === clientId);
  }

  private async pendingRequest(handle: unknown) {
    if (typeof handle !== "string" || !REQUEST_HANDLE_PATTERN.test(handle)) throw requestNotFound();
    const request = await this.options.store.findAuthorizationRequest(secretDigest(handle));
    if (!request) throw requestNotFound();
    if (request.status !== "pending") throw requestDecided();
    if (request.expiresAt <= this.now()) throw requestExpired();
    const client = await this.resolveClient(request.clientId);
    if (!client || !client.redirectUris.includes(request.redirectUri)) throw requestNotFound();
    return { request, client };
  }

  private async consentMfaPolicy(actor: AuthResponseUser, scopes: OAuthScope[]) {
    const requireFreshMfa = scopes.some((scope) => (APPLICATION_PRIVILEGED_SCOPES as readonly string[]).includes(scope));
    const requireMfa = requireFreshMfa || actor.roles.some((role) => PRIVILEGED_ROLES.has(role))
      || (await this.options.authStore.countEnabledMfaFactors(actor.id)) > 0;
    return { requireMfa, requireFreshMfa };
  }

  private clientRedirect(redirectUri: string, values: Record<string, string>, state: string | null): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(values)) url.searchParams.append(key, value);
    if (state !== null) url.searchParams.append("state", state);
    url.searchParams.append("iss", this.options.config.issuer);
    return url.href;
  }

  private newAccessToken(now: Date) {
    return { token: randomSecret(ACCESS_TOKEN_PREFIX), expiresAt: new Date(now.getTime() + this.options.config.accessTokenTtlSeconds * 1000) };
  }

  private newRefreshToken(now: Date) {
    return { token: randomSecret(REFRESH_TOKEN_PREFIX), expiresAt: new Date(now.getTime() + this.options.config.refreshTokenTtlSeconds * 1000) };
  }

  private async audit(input: { actorUserId: string | null; action: string; decision: "allow" | "deny"; resourceId?: string; details: Record<string, unknown> }) {
    await this.options.authStore.recordAuditEvent({
      actorUserId: input.actorUserId,
      action: input.action,
      decision: input.decision,
      resourceType: "oauth_connection",
      resourceId: input.resourceId ?? null,
      details: input.details,
    });
  }
}

const DUPLICATE = Symbol("duplicate");

function scopeDescriptor(scope: OAuthScope) {
  return { scope, description: OAUTH_SCOPE_DESCRIPTIONS[scope], readOnly: OAUTH_SCOPE_READ_ONLY[scope] };
}

function single(params: OAuthParams, name: string): string | undefined | typeof DUPLICATE {
  const value = params[name];
  return Array.isArray(value) ? DUPLICATE : value;
}

function rejectDuplicates(params: OAuthParams): void {
  for (const value of Object.values(params)) {
    if (Array.isArray(value)) throw new OAuthProtocolError("invalid_request", "Parameters must not repeat.");
    if (typeof value === "string" && value.length > MAX_PARAMETER_CHARS) throw new OAuthProtocolError("invalid_request", "A parameter is too long.");
  }
}

/** Space-delimited scope list; `offline_access` is accepted and ignored because refresh is always issued. */
function parseScopes(value: string | undefined): OAuthScope[] | null {
  if (value === undefined || value.trim() === "") return ["skills:read"];
  const requested = value.split(" ").filter(Boolean).filter((scope) => scope !== "offline_access");
  if (requested.some((scope) => !(OAUTH_SCOPES as readonly string[]).includes(scope))) return null;
  const scopes = OAUTH_SCOPES.filter((scope) => requested.includes(scope));
  return scopes.length > 0 ? scopes : ["skills:read"];
}

function parseBasicAuthorization(header: string | undefined): { clientId: string; secret: string } | null | "invalid" {
  if (!header) return null;
  const match = /^Basic[ \t]+([A-Za-z0-9+/=]{1,1024})[ \t]*$/i.exec(header);
  if (!match) return "invalid";
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return "invalid";
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, "%20")),
      secret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, "%20")),
    };
  } catch {
    return "invalid";
  }
}

function cleanClientName(value: unknown): string {
  if (value === undefined || value === null) return "Unnamed client";
  if (typeof value !== "string") throw new OAuthProtocolError("invalid_client_metadata", "client_name must be a string.");
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > MAX_CLIENT_NAME_CHARS) {
    throw new OAuthProtocolError("invalid_client_metadata", `client_name must be 1-${MAX_CLIENT_NAME_CHARS} characters.`);
  }
  return cleaned;
}

function clientSummary(client: OAuthClientRecord, redirectUri: string) {
  return {
    id: client.clientId,
    name: client.clientName,
    registration: client.registration,
    redirectUri,
    redirectOrigin: new URL(redirectUri).origin,
  };
}

function connectionSummary(grant: OAuthGrantRecord): OAuthConnectionSummary {
  return {
    id: grant.id,
    client: { id: grant.clientId, name: grant.clientName, registration: grant.registration },
    scopes: grant.scopes,
    resource: grant.resource,
    createdAt: grant.createdAt.toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    expiresAt: grant.expiresAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}

function tokenResponse(accessToken: string, refreshToken: string, expiresAt: Date, now: Date, scopes: OAuthScope[]) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)),
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

function isUsableAccount(user: AuthUserRecord): boolean {
  return user.status === "active" && Boolean(user.emailVerifiedAt);
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function invalidGrant() {
  return new OAuthProtocolError("invalid_grant", "The authorization grant is invalid, expired or revoked.");
}

function invalidClient() {
  return new OAuthProtocolError("invalid_client", "Client authentication failed.", 401);
}

function requestNotFound() {
  return new AppError("This connection request was not found.", "OAUTH_REQUEST_NOT_FOUND", 404);
}

function requestExpired() {
  return new AppError("This connection request expired. Start again from the AI app.", "OAUTH_REQUEST_EXPIRED", 410);
}

function requestDecided() {
  return new AppError("This connection request was already answered.", "OAUTH_REQUEST_ALREADY_DECIDED", 409);
}

function connectionNotFound() {
  return new AppError("Connection not found.", "OAUTH_CONNECTION_NOT_FOUND", 404);
}
