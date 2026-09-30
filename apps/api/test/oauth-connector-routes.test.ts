import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { APPLICATION_SCOPES } from "@myskills-app/core";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { parseOAuthConfig, type OAuthConfig } from "../src/oauth/config.js";
import { MemoryOAuthStore } from "../src/oauth/memory-store.js";
import { OAuthService } from "../src/oauth/service.js";

// Synthetic fixtures only. Hosts use the reserved .test TLD.
const ORIGIN = "https://skills.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CHATGPT_REDIRECT = "https://chatgpt.example.test/connector/oauth/callback-1";
const CLAUDE_REDIRECT = "https://claude.example.test/api/mcp/auth_callback";
const CONFIGURED_SECRET = "myskills_cs.synthetic-configured-secret-for-tests-only";
const PASSWORD = "correct horse battery staple";

test("OAuth is off by default: discovery, authorization and consent routes are absent", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(authStore) });
  t.after(() => app.close());
  for (const [method, url] of [
    ["GET", "/.well-known/oauth-authorization-server"],
    ["GET", "/oauth/authorize?client_id=x"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/revoke"],
    ["POST", "/oauth/register"],
    ["POST", "/v1/oauth/consent/inspect"],
    ["POST", "/v1/oauth/consent/decision"],
    ["GET", "/v1/oauth/connections"],
  ] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 404, `${method} ${url}`);
  }
  const connector = await app.inject({ method: "GET", url: "/v1/oauth/connector" });
  assert.equal(connector.statusCode, 200);
  assert.deepEqual(connector.json(), { connector: { enabled: false, mcpUrl: null } });
  assert.equal(connector.headers["cache-control"], "no-store");
});

test("OAuth configuration fails closed when incomplete, unsafe or ambiguous", () => {
  const base = {
    NODE_ENV: "production",
    MYSKILLS_OAUTH_ENABLED: "true",
    MYSKILLS_OAUTH_ISSUER: ORIGIN,
    MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
    APP_BASE_URL: ORIGIN,
    MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true",
    MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test",
  };
  assert.equal(parseOAuthConfig({}), null);
  assert.equal(parseOAuthConfig({ MYSKILLS_OAUTH_ENABLED: "false", MYSKILLS_OAUTH_ISSUER: "not a url" }), null);
  assert.ok(parseOAuthConfig(base));
  for (const [label, patch] of [
    ["ambiguous flag", { MYSKILLS_OAUTH_ENABLED: "yes" }],
    ["missing issuer", { MYSKILLS_OAUTH_ISSUER: undefined }],
    ["issuer with path", { MYSKILLS_OAUTH_ISSUER: `${ORIGIN}/auth` }],
    ["issuer with query", { MYSKILLS_OAUTH_ISSUER: `${ORIGIN}?x=1` }],
    ["plain-http public issuer", { MYSKILLS_OAUTH_ISSUER: "http://skills.example.test" }],
    ["missing resource", { MYSKILLS_MCP_PUBLIC_URL: undefined }],
    ["resource fragment", { MYSKILLS_MCP_PUBLIC_URL: `${RESOURCE}#x` }],
    ["plain-http public resource", { MYSKILLS_MCP_PUBLIC_URL: "http://skills.example.test/mcp" }],
    ["missing consent origin", { APP_BASE_URL: undefined }],
    ["DCR without redirect hosts", { MYSKILLS_OAUTH_REDIRECT_HOSTS: undefined }],
    ["wildcard redirect host", { MYSKILLS_OAUTH_REDIRECT_HOSTS: "*.example.test" }],
    ["no registration path", { MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "false", MYSKILLS_OAUTH_REDIRECT_HOSTS: undefined }],
    ["malformed clients", { MYSKILLS_OAUTH_CLIENTS: "{" }],
    ["client wildcard redirect", { MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{ client_id: "configured-one", client_name: "One", redirect_uris: ["https://*.example.test/cb"] }]) }],
    ["client reserved prefix", { MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{ client_id: "msc_reserved-prefix", client_name: "One", redirect_uris: [CLAUDE_REDIRECT] }]) }],
  ] as const) {
    const env: Record<string, string | undefined> = { ...base, ...patch };
    assert.throws(() => parseOAuthConfig(env), Error, label);
  }
  // Loopback HTTP is allowed so disposable local stacks can prove the flow.
  const loopback = parseOAuthConfig({ ...base, MYSKILLS_OAUTH_ISSUER: "http://127.0.0.1:43100", MYSKILLS_MCP_PUBLIC_URL: "http://127.0.0.1:43100/mcp", APP_BASE_URL: "http://127.0.0.1:43100" });
  assert.equal(loopback?.issuer, "http://127.0.0.1:43100");
  const clients = parseOAuthConfig({ ...base, MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "false", MYSKILLS_OAUTH_REDIRECT_HOSTS: undefined, MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{ client_id: "configured-one", client_name: "One", redirect_uris: [CLAUDE_REDIRECT] }]) });
  assert.equal(clients?.dynamicRegistration, false);
  assert.equal(clients?.clients[0]?.clientSecretSha256, null);
});

test("authorization server metadata is derived only from configuration", async (t) => {
  const { app } = oauthApp(t);
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/oauth-authorization-server",
    headers: { host: "attacker.example.test", "x-forwarded-host": "attacker.example.test", "x-forwarded-proto": "http" },
  });
  assert.equal(response.statusCode, 200);
  const metadata = response.json();
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(metadata.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.equal(metadata.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(metadata.response_types_supported, ["code"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.scopes_supported, [...APPLICATION_SCOPES]);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.equal(metadata.client_id_metadata_document_supported, false);
  assert.equal(JSON.stringify(metadata).includes("attacker"), false);
  assert.match(response.headers["cache-control"] ?? "", /max-age=\d+/);
});

test("dynamic registration accepts only exact allowlisted redirect URIs and bounded metadata", async (t) => {
  const { app } = oauthApp(t);
  const registered = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none", logo_uri: "http://169.254.169.254/latest" });
  assert.match(registered.client_id, /^msc_[A-Za-z0-9_-]{20,64}$/);
  assert.equal(registered.client_secret, undefined);
  assert.deepEqual(registered.redirect_uris, [CHATGPT_REDIRECT]);
  assert.equal(registered.logo_uri, undefined, "untrusted URIs are neither stored nor fetched");
  const confidential = await register(app, { client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "client_secret_post" });
  assert.match(confidential.client_secret, /^myskills_cs\./);
  assert.equal(confidential.client_secret_expires_at, 0);

  for (const [label, body] of [
    ["host outside allowlist", { redirect_uris: ["https://attacker.example.test/cb"] }],
    ["subdomain of allowlisted host", { redirect_uris: ["https://evil.chatgpt.example.test/cb"] }],
    ["plain http", { redirect_uris: ["http://chatgpt.example.test/cb"] }],
    ["fragment", { redirect_uris: [`${CHATGPT_REDIRECT}#frag`] }],
    ["userinfo", { redirect_uris: ["https://user:pw@chatgpt.example.test/cb"] }],
    ["wildcard", { redirect_uris: ["https://chatgpt.example.test/*"] }],
    ["no redirect", { redirect_uris: [] }],
    ["too many redirects", { redirect_uris: Array.from({ length: 6 }, (_, index) => `${CHATGPT_REDIRECT}-${index}`) }],
    ["oversized redirect", { redirect_uris: [`${CHATGPT_REDIRECT}?${"x".repeat(600)}`] }],
    ["unsupported grant", { redirect_uris: [CHATGPT_REDIRECT], grant_types: ["client_credentials"] }],
    ["unsupported auth method", { redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "private_key_jwt" }],
  ] as const) {
    const response = await app.inject({ method: "POST", url: "/oauth/register", payload: body });
    assert.equal(response.statusCode, 400, label);
    assert.match(response.json().error, /^invalid_(redirect_uri|client_metadata)$/, label);
  }
  const oversized = await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [CHATGPT_REDIRECT], client_name: "x".repeat(20_000) } });
  assert.equal(oversized.statusCode, 413);
});

test("dynamic registration is absent when only configured clients are enabled", async (t) => {
  const { app } = oauthApp(t, { dynamicRegistration: false });
  const metadata = (await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })).json();
  assert.equal(metadata.registration_endpoint, undefined);
  const response = await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [CHATGPT_REDIRECT] } });
  assert.equal(response.statusCode, 404);
});

test("authorize never redirects to an unverified client or redirect URI", async (t) => {
  const { app } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const pkce = createPkce();
  for (const [label, query, expected] of [
    ["unknown client", { client_id: "msc_unknown-client-identifier-000", redirect_uri: CHATGPT_REDIRECT }, "invalid_client"],
    ["missing client", { redirect_uri: CHATGPT_REDIRECT }, "invalid_client"],
    ["unregistered redirect", { client_id: client.client_id, redirect_uri: "https://chatgpt.example.test/other" }, "invalid_redirect_uri"],
    ["missing redirect", { client_id: client.client_id }, "invalid_redirect_uri"],
    ["redirect prefix match", { client_id: client.client_id, redirect_uri: `${CHATGPT_REDIRECT}/extra` }, "invalid_redirect_uri"],
  ] as const) {
    const response = await app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", code_challenge: pkce.challenge, code_challenge_method: "S256", state: "s1", ...query })}` });
    assert.equal(response.statusCode, 302, label);
    const location = new URL(String(response.headers.location));
    assert.equal(location.origin, ORIGIN, label);
    assert.equal(location.pathname, "/connect/authorize", label);
    assert.equal(location.searchParams.get("error"), expected, label);
    assert.equal(String(response.headers.location).includes("state"), false, label);
  }
});

test("authorize errors after client validation return to the registered URI with state and iss", async (t) => {
  const { app } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const pkce = createPkce();
  const state = "opaque state/+= value ✓";
  for (const [label, patch, expected] of [
    ["unsupported response type", { response_type: "token" }, "unsupported_response_type"],
    ["missing PKCE", { code_challenge: undefined, code_challenge_method: undefined }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["malformed challenge", { code_challenge: "short" }, "invalid_request"],
    ["executor scope", { scope: "skills:read targets:execute" }, "invalid_scope"],
    ["foreign resource", { resource: "https://other.example.test/mcp" }, "invalid_target"],
  ] as const) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: pkce.challenge, code_challenge_method: "S256", state, ...patch })) {
      if (value !== undefined) params.set(key, value);
    }
    const response = await app.inject({ method: "GET", url: `/oauth/authorize?${params}` });
    assert.equal(response.statusCode, 302, label);
    const location = new URL(String(response.headers.location));
    assert.equal(`${location.origin}${location.pathname}`, CHATGPT_REDIRECT, label);
    assert.equal(location.searchParams.get("error"), expected, label);
    assert.equal(location.searchParams.get("state"), state, label);
    assert.equal(location.searchParams.get("iss"), ORIGIN, label);
    assert.equal(location.searchParams.get("code"), null, label);
  }
  const duplicate = await app.inject({ method: "GET", url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT)}&code_challenge=${pkce.challenge}&code_challenge_method=S256&state=a&state=b` });
  assert.equal(new URL(String(duplicate.headers.location)).searchParams.get("error"), "invalid_request");
  const oversizedState = await app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: pkce.challenge, code_challenge_method: "S256", state: "s".repeat(1025) })}` });
  assert.equal(new URL(String(oversizedState.headers.location)).searchParams.get("error"), "invalid_request");
});

test("consent requires a session, shows the actual client and scopes, and denial returns access_denied", async (t) => {
  const { app, authStore } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT <script>", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const pkce = createPkce();
  const handle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: pkce.challenge, state: "deny-state", scope: "skills:read architectures:read" });
  assert.match(handle, /^[A-Za-z0-9_-]{43}$/);

  const anonymous = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", payload: { request: handle } });
  assert.equal(anonymous.statusCode, 401);

  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const inspected = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: handle } });
  assert.equal(inspected.statusCode, 200);
  assert.equal(inspected.headers["cache-control"], "no-store");
  const authorization = inspected.json().authorization;
  assert.deepEqual(authorization.client, {
    id: client.client_id,
    name: "ChatGPT <script>",
    registration: "dynamic",
    redirectUri: CHATGPT_REDIRECT,
    redirectOrigin: "https://chatgpt.example.test",
  });
  assert.deepEqual(authorization.scopes.map((scope: { scope: string }) => scope.scope), ["skills:read", "architectures:read"]);
  assert.ok(authorization.scopes.every((scope: { description: string }) => scope.description.length > 10));
  assert.equal(authorization.resource, RESOURCE);
  assert.equal(authorization.account.email, "reader@example.test");
  assert.equal(authorization.mfaRequired, false);
  assert.equal(JSON.stringify(inspected.json()).includes("deny-state"), false);
  assert.equal(JSON.stringify(inspected.json()).includes(pkce.challenge), false);

  const unknown = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: "A".repeat(43) } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, "OAUTH_REQUEST_NOT_FOUND");

  const denied = await decide(app, session, handle, "deny");
  assert.equal(denied.statusCode, 200);
  const location = new URL(denied.json().redirectTo);
  assert.equal(`${location.origin}${location.pathname}`, CHATGPT_REDIRECT);
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "deny-state");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
  assert.equal(location.searchParams.get("code"), null);

  const again = await decide(app, session, handle, "approve");
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, "OAUTH_REQUEST_ALREADY_DECIDED");
});

test("consent requests expire and approvals are single-use", async (t) => {
  const clock = new TestClock();
  const { app, authStore } = oauthApp(t, { clock });
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const expiring = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  clock.advance(11 * 60_000);
  const expired = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: expiring } });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json().error.code, "OAUTH_REQUEST_EXPIRED");
  assert.equal((await decide(app, session, expiring, "approve")).statusCode, 410);

  const handle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  const [first, second] = await Promise.all([decide(app, session, handle, "approve"), decide(app, session, handle, "approve")]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
});

test("consent decisions keep the existing MFA and cookie-origin boundaries", async (t) => {
  const { app, authStore } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const owner = await addAndLogin(app, authStore, { id: "owner-1", email: "owner@example.test", roles: ["owner"] });
  const ownerHandle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  const ownerInspect = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(owner), payload: { request: ownerHandle } });
  assert.equal(ownerInspect.json().authorization.mfaRequired, true);
  const ownerDecision = await decide(app, owner, ownerHandle, "approve");
  assert.equal(ownerDecision.statusCode, 403);
  assert.equal(ownerDecision.json().error.code, "MFA_VERIFICATION_REQUIRED");

  // A session created before MFA enrollment is not MFA verified.
  const staleSession = await addAndLogin(app, authStore, { id: "reader-mfa", email: "mfa-reader@example.test", roles: ["user"] });
  await enrollMfa(app, staleSession);
  const mfaHandle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  const staleDecision = await decide(app, staleSession, mfaHandle, "approve");
  assert.equal(staleDecision.statusCode, 403);
  assert.equal(staleDecision.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const reader = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const handle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  const crossSite = await app.inject({
    method: "POST",
    url: "/v1/oauth/consent/decision",
    headers: { cookie: `myskills_session=${reader}`, origin: "https://attacker.example.test" },
    payload: { request: handle, decision: "approve" },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.json().error.code, "COOKIE_ORIGIN_REJECTED");
  const sameSite = await app.inject({
    method: "POST",
    url: "/v1/oauth/consent/decision",
    headers: { cookie: `myskills_session=${reader}`, origin: ORIGIN },
    payload: { request: handle, decision: "approve" },
  });
  assert.equal(sameSite.statusCode, 200);
});

test("authorization code exchange binds client, redirect, verifier and resource, and is single-use", async (t) => {
  const { app, authStore } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const other = await register(app, { client_name: "Other", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });

  for (const [label, patch, expected] of [
    ["wrong verifier", { code_verifier: createPkce().verifier }, "invalid_grant"],
    ["missing verifier", { code_verifier: undefined }, "invalid_request"],
    ["wrong redirect", { redirect_uri: `${CHATGPT_REDIRECT}-x` }, "invalid_grant"],
    ["wrong client", { client_id: other.client_id }, "invalid_grant"],
    ["foreign resource", { resource: "https://other.example.test/mcp" }, "invalid_target"],
  ] as const) {
    const { code, pkce } = await approvedCode(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
    const failed = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: pkce.verifier, resource: RESOURCE, ...patch });
    assert.equal(failed.statusCode, 400, label);
    assert.equal(failed.json().error, expected, label);
    const retry = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: pkce.verifier });
    if (expected === "invalid_grant") {
      // A semantic mismatch consumed the code: the correct request cannot use it afterwards.
      assert.equal(retry.json().error, "invalid_grant", `${label}: code burned`);
    } else {
      // Malformed or foreign-resource requests are rejected before the code is read.
      assert.equal(retry.statusCode, 200, `${label}: code not consumed`);
    }
  }

  const { code, pkce, state } = await approvedCode(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, state: "exchange-state" });
  assert.equal(state, "exchange-state");
  const exchanged = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: pkce.verifier, resource: RESOURCE });
  assert.equal(exchanged.statusCode, 200);
  assert.equal(exchanged.headers["cache-control"], "no-store");
  assert.equal(exchanged.headers.pragma, "no-cache");
  const tokens = exchanged.json();
  assert.match(tokens.access_token, /^myskills_at\.[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^myskills_rt\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, "skills:read");
  assert.ok(tokens.expires_in > 0 && tokens.expires_in <= 3600);

  const connectorSession = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.access_token) });
  assert.equal(connectorSession.statusCode, 200);
  assert.equal(connectorSession.json().credential.kind, "oauth");
  assert.equal(connectorSession.json().credential.clientId, client.client_id);
  assert.equal(connectorSession.json().credential.resource, RESOURCE);
  assert.deepEqual(connectorSession.json().credential.scopes, ["skills:read"]);

  // RFC 6749 section 4.1.2: a replayed code revokes the tokens issued from it.
  const replay = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: pkce.verifier });
  assert.equal(replay.statusCode, 400);
  assert.equal(replay.json().error, "invalid_grant");
  const afterReplay = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.access_token) });
  assert.equal(afterReplay.statusCode, 401);
  const refreshAfterReplay = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refreshAfterReplay.json().error, "invalid_grant");
});

test("configured confidential clients must authenticate at the token endpoint", async (t) => {
  const { app, authStore } = oauthApp(t);
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const handle = await startAuthorization(app, { clientId: "configured-connector", redirectUri: CLAUDE_REDIRECT, challenge: createPkce().challenge });
  const inspected = await app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: handle } });
  assert.equal(inspected.json().authorization.client.registration, "configured");
  assert.equal(inspected.json().authorization.client.name, "Configured Claude");

  for (const [label, auth, expected] of [
    ["missing secret", {}, 401],
    ["wrong secret", { client_secret: "myskills_cs.wrong" }, 401],
  ] as const) {
    const { code, pkce } = await approvedCode(app, session, { clientId: "configured-connector", redirectUri: CLAUDE_REDIRECT });
    const response = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, client_id: "configured-connector", code_verifier: pkce.verifier, ...auth });
    assert.equal(response.statusCode, expected, label);
    assert.equal(response.json().error, "invalid_client", label);
  }
  const { code, pkce } = await approvedCode(app, session, { clientId: "configured-connector", redirectUri: CLAUDE_REDIRECT });
  const basic = Buffer.from(`${encodeURIComponent("configured-connector")}:${encodeURIComponent(CONFIGURED_SECRET)}`).toString("base64");
  const exchanged = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: pkce.verifier }, { authorization: `Basic ${basic}` });
  assert.equal(exchanged.statusCode, 200);
  const both = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: exchanged.json().refresh_token, client_id: "configured-connector", client_secret: CONFIGURED_SECRET }, { authorization: `Basic ${basic}` });
  assert.equal(both.json().error, "invalid_request", "a client must use one authentication method");
});

// Failure inventory before enforcing registered client authentication methods:
// - Basic and POST secrets are interchangeable despite client registration.
// - Public clients accept an empty secret through Basic or a form field.
// - Malformed/unsupported Authorization falls back to body or public auth.
// - Mixed methods or failures consume a code, rotate/revoke a grant, or echo secrets.
for (const registration of ["none", "client_secret_basic", "client_secret_post", "configured_basic"] as const) {
  for (const operation of ["authorization_code", "refresh_token", "revocation"] as const) {
    test(`OAuth ${registration} client enforces its method during ${operation}`, async (t) => {
      const { app, authStore } = oauthApp(t);
      const client = registration === "configured_basic"
        ? { client_id: "configured-connector", client_secret: CONFIGURED_SECRET, token_endpoint_auth_method: "client_secret_basic" }
        : await register(app, { client_name: "Method-bound connector", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: registration });
      const clientId = client.client_id as string;
      const secret = (client.client_secret ?? "") as string;
      const method = client.token_endpoint_auth_method as "none" | "client_secret_basic" | "client_secret_post";
      const authentication = (suppliedMethod: typeof method, value = secret): { fields: Record<string, string>; headers: Record<string, string> } => suppliedMethod === "client_secret_basic"
        ? { fields: {}, headers: basicAuthorization(clientId, value) }
        : { fields: { client_id: clientId, ...(suppliedMethod === "client_secret_post" ? { client_secret: value } : {}) }, headers: {} };
      const correct = authentication(method);
      const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
      const { code, pkce } = await approvedCode(app, session, { clientId, redirectUri: CLAUDE_REDIRECT });
      let fields: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, code_verifier: pkce.verifier };
      let accessToken: string | undefined;
      if (operation !== "authorization_code") {
        const exchange = await tokenRequest(app, { ...fields, ...correct.fields }, correct.headers);
        assert.equal(exchange.statusCode, 200, "registered client authentication must prepare the lifecycle fixture");
        const tokens = exchange.json();
        accessToken = tokens.access_token;
        fields = operation === "refresh_token"
          ? { grant_type: "refresh_token", refresh_token: tokens.refresh_token }
          : { token: tokens.refresh_token, token_type_hint: "refresh_token" };
      }
      const endpoint = operation === "revocation" ? "/oauth/revoke" : "/oauth/token";
      const rejected = [
        ...(["none", "client_secret_basic", "client_secret_post"] as const).filter((value) => value !== method).map((value) => ({ label: `unregistered ${value}`, ...authentication(value), status: 401, error: "invalid_client" })),
        ...["Basic !!!", "Basic\t%%%", "Basic", "Bearer unsupported"].map((authorization) => ({ label: "malformed or unsupported Authorization", fields: correct.fields, headers: { authorization }, status: 401, error: "invalid_client" })),
        { label: "mixed Basic and form secret", fields: authentication("client_secret_post").fields, headers: basicAuthorization(clientId, secret), status: 400, error: "invalid_request" },
        { label: "conflicting client identifiers", fields: { client_id: "another-client" }, headers: basicAuthorization(clientId, secret), status: 400, error: "invalid_request" },
        ...(method === "none" ? [] : [{ label: "wrong secret with registered method", ...authentication(method, "incorrect-client-secret"), status: 401, error: "invalid_client" }]),
      ];
      for (const attempt of rejected) {
        const response = await formRequest(app, endpoint, { ...fields, ...attempt.fields }, attempt.headers);
        assert.equal(response.statusCode, attempt.status, attempt.label);
        assert.equal(response.json().error, attempt.error, attempt.label);
        assert.deepEqual(Object.keys(response.json()).sort(), ["error", "error_description"], attempt.label);
        for (const credential of [secret, code, fields.refresh_token, fields.token, accessToken]) {
          if (credential) assert.equal(response.body.includes(credential), false, `${attempt.label}: credential leaked`);
        }
        if (accessToken) {
          const stillActive = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(accessToken) });
          assert.equal(stillActive.statusCode, 200, `${attempt.label}: rejected authentication changed the connection`);
        }
      }
      // A repeated matching client_id is metadata, not a second secret method.
      const accepted = await formRequest(app, endpoint, { ...fields, ...correct.fields, client_id: clientId }, correct.headers);
      assert.equal(accepted.statusCode, 200, "registered client authentication must remain usable after rejected attempts");
      const liveToken = operation === "revocation" ? accessToken : accepted.json().access_token;
      assert.ok(liveToken);
      const live = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(liveToken) });
      assert.equal(live.statusCode, operation === "revocation" ? 401 : 200);
    });
  }
}

test("refresh tokens rotate, reject reuse, downscope and revoke the connection on reuse", async (t) => {
  const { app, authStore } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const first = await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, scope: "skills:read architectures:read" });

  const escalate = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, scope: "skills:read skills:submit" });
  assert.equal(escalate.json().error, "invalid_scope");
  // A rejected request does not consume the refresh token.
  const rotated = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id, scope: "skills:read" });
  assert.equal(rotated.statusCode, 200);
  const second = rotated.json();
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal(second.scope, "skills:read");
  const downscoped = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(second.access_token) });
  assert.deepEqual(downscoped.json().credential.scopes, ["skills:read"]);

  const wrongClient = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: second.refresh_token }, basicAuthorization("configured-connector", CONFIGURED_SECRET));
  assert.equal(wrongClient.json().error, "invalid_grant");

  const reuse = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: client.client_id });
  assert.equal(reuse.statusCode, 400);
  assert.equal(reuse.json().error, "invalid_grant");
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(second.access_token) })).statusCode, 401);
  assert.equal((await tokenRequest(app, { grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: client.client_id })).json().error, "invalid_grant");
  const audit = await authStore.listAuditEvents({ limit: 100 });
  const reuseAudit = audit.find((event) => event.action === "oauth.refresh_reuse");
  assert.equal(reuseAudit?.decision, "deny");
  assert.equal(JSON.stringify(audit).includes(first.refresh_token), false);
  assert.equal(JSON.stringify(audit).includes(second.access_token), false);
});

test("access tokens expire and each call rechecks the account", async (t) => {
  const clock = new TestClock();
  const { app, authStore } = oauthApp(t, { clock });
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const tokens = await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.access_token) })).statusCode, 200);
  clock.advance((tokens.expires_in + 1) * 1000);
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.access_token) })).statusCode, 401);
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(refreshed.statusCode, 200);

  authStore.setUserStatus("reader@example.test", "disabled");
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(refreshed.json().access_token) })).statusCode, 401);
  assert.equal((await tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshed.json().refresh_token, client_id: client.client_id })).json().error, "invalid_grant");
});

test("read-only connector grants cannot call write actions or trusted controls despite real owner assurance", async (t) => {
  const { app, authStore, oauthService } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const owner = await addAndLoginWithMfa(app, authStore, { id: "owner-1", email: "owner@example.test", roles: ["owner"] });
  const tokens = await connect(app, owner, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, scope: "skills:read architectures:read" });
  const session = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.access_token) });
  assert.equal(session.statusCode, 200);
  const verified = await oauthService.verifyAccessToken(tokens.access_token);
  assert.deepEqual(verified?.user.roles, ["owner"]);
  assert.ok(verified?.mfaVerifiedAt);
  // Bootstrap scopes are not consent to disclose the account profile. This
  // must agree with /v1/me's profile:read boundary below.
  assert.equal(Object.hasOwn(session.json(), "user"), false);
  assert.equal(session.body.includes("owner@example.test"), false);
  const profileTokens = await connect(app, owner, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, scope: "skills:read profile:read" });
  const profileSession = await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(profileTokens.access_token) });
  assert.equal(profileSession.statusCode, 200);
  assert.equal(profileSession.json().user.email, "owner@example.test");

  for (const [method, url, payload] of [
    ["GET", "/v1/me", undefined],
    ["GET", "/v1/auth/api-tokens", undefined],
    ["POST", "/v1/auth/api-tokens", { name: "escalate", scopes: ["skills:read"] }],
    ["GET", "/v1/oauth/connections", undefined],
    ["GET", "/v1/admin/users", undefined],
    ["GET", "/v1/review/submissions", undefined],
    ["POST", "/v1/submissions", {}],
    ["POST", "/v1/bundles", {}],
    ["PUT", "/v1/skills/release-notes-helper", {}],
    ["GET", "/v1/bundle-sources", undefined],
  ] as const) {
    const response = await app.inject({ method, url, headers: bearer(tokens.access_token), ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 403, `${method} ${url}`);
    assert.equal(response.json().error.code, method === "POST" && url === "/v1/auth/api-tokens" ? "OAUTH_TOKEN_NOT_ALLOWED" : "API_TOKEN_SCOPE_REQUIRED", `${method} ${url}`);
  }
  for (const url of ["/v1/skills", "/v1/skills/release-notes-helper", "/v1/skills/release-notes-helper/releases", "/v1/architectures", "/v1/architecture-patterns"]) {
    const response = await app.inject({ method: "GET", url, headers: bearer(tokens.access_token) });
    assert.notEqual(response.json()?.error?.code, "OAUTH_TOKEN_NOT_ALLOWED", url);
  }
  // Refresh tokens and codes are never bearer credentials.
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(tokens.refresh_token) })).statusCode, 401);

  // The boundary applies to the effective credential: a connector token in the
  // session cookie, plain or percent-encoded, is refused on every route,
  // including routes whose own scope checks predate connector credentials.
  const encoded = tokens.access_token.replace(".", "%2E");
  // AuthService strips ASCII whitespace 0x09-0x0d and 0x20 around a bearer
  // value, so the boundary must recognize the same decoded forms.
  const whitespaceVariants = ["%09", "%0A", "%0B", "%0C", "%0D", "%20"].flatMap((space) => [
    `myskills_session=${space}${tokens.access_token}`,
    `myskills_session=${tokens.access_token}${space}`,
    `myskills_session=${space}${space}${encoded}${space}`,
  ]);
  for (const cookie of [`myskills_session=${tokens.access_token}`, `myskills_session=${encoded}`, ...whitespaceVariants]) {
    for (const [method, url, payload] of [
      ["GET", "/v1/me", undefined],
      ["GET", "/v1/mcp/session", undefined],
      ["GET", "/v1/skills", undefined],
      ["GET", "/v1/improvements/releases/release-notes-helper/0.1.0/compatibility", undefined],
      ["PUT", "/v1/improvements/policies/user/owner-1", {}],
      ["POST", "/v1/auth/api-tokens", { name: "escalate", scopes: ["skills:read"] }],
    ] as const) {
      const response = await app.inject({ method, url, headers: { cookie, origin: ORIGIN }, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 403, `${cookie.includes("%2E") ? "encoded" : "plain"} cookie ${method} ${url}`);
      assert.equal(response.json().error.code, "OAUTH_TOKEN_NOT_ALLOWED", `${method} ${url}`);
    }
  }
});

test("RFC 7009 revocation, account connection management and account security events revoke access", async (t) => {
  const { app, authStore } = oauthApp(t);
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  const otherSession = await addAndLogin(app, authStore, { id: "reader-2", email: "other@example.test", roles: ["user"] });

  // Refresh-token revocation ends the whole connection.
  const revokedByClient = await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  const revoke = await formRequest(app, "/oauth/revoke", { token: revokedByClient.refresh_token, token_type_hint: "refresh_token", client_id: client.client_id });
  assert.equal(revoke.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(revokedByClient.access_token) })).statusCode, 401);
  assert.equal((await formRequest(app, "/oauth/revoke", { token: "myskills_rt.unknown", client_id: client.client_id })).statusCode, 200);
  const foreign = await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  const foreignRevocation = await formRequest(app, "/oauth/revoke", { token: foreign.refresh_token }, basicAuthorization("configured-connector", CONFIGURED_SECRET));
  assert.equal(foreignRevocation.statusCode, 200, "a correctly authenticated client cannot revoke another client's token");
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(foreign.access_token) })).statusCode, 200, "another client cannot revoke this connection");

  const listed = await app.inject({ method: "GET", url: "/v1/oauth/connections", headers: bearer(session) });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["cache-control"], "no-store");
  const connections = listed.json().connections as Array<{ id: string; client: { id: string; name: string; registration: string }; scopes: string[] }>;
  assert.equal(connections.length, 1, "revoked connections are not listed as active");
  assert.equal(connections[0]?.client.name, "ChatGPT");
  assert.equal(JSON.stringify(listed.json()).includes("myskills_"), false);
  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/oauth/connections", headers: bearer(otherSession) })).json().connections, []);
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/oauth/connections/${connections[0]!.id}`, headers: bearer(otherSession) })).statusCode, 404);
  const deleted = await app.inject({ method: "DELETE", url: `/v1/oauth/connections/${connections[0]!.id}`, headers: bearer(session) });
  assert.equal(deleted.statusCode, 200);
  assert.ok(deleted.json().connection.revokedAt);
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(foreign.access_token) })).statusCode, 401);

  // Password change revokes connector access with the other credentials.
  const beforePasswordChange = await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  const changed = await app.inject({ method: "POST", url: "/v1/auth/account/password", headers: bearer(session), payload: { currentPassword: PASSWORD, password: "another correct horse battery staple" } });
  assert.equal(changed.statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/v1/mcp/session", headers: bearer(beforePasswordChange.access_token) })).statusCode, 401);
  assert.equal((await tokenRequest(app, { grant_type: "refresh_token", refresh_token: beforePasswordChange.refresh_token, client_id: client.client_id })).json().error, "invalid_grant");
});

test("approved but unredeemed codes cannot bypass the connection cap or survive account revocation", async (t) => {
  const { app, authStore } = oauthApp(t, { maxConnectionsPerUser: 2 });
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  // All three approvals happen while the account has no active connection.
  const pending = [];
  for (let index = 0; index < 3; index += 1) pending.push(await approvedCode(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT }));
  const exchanged = [];
  for (const { code, pkce } of pending) {
    exchanged.push(await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: pkce.verifier }));
  }
  assert.deepEqual(exchanged.map((response) => response.statusCode), [200, 200, 400]);
  assert.equal(exchanged[2]!.json().error, "invalid_grant");
  assert.equal((await app.inject({ method: "GET", url: "/v1/oauth/connections", headers: bearer(session) })).json().connections.length, 2);

  // A code approved before an account security event loses its authority.
  const other = await addAndLogin(app, authStore, { id: "reader-2", email: "other@example.test", roles: ["user"] });
  const beforeChange = await approvedCode(app, other, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  const changed = await app.inject({ method: "POST", url: "/v1/auth/account/password", headers: bearer(other), payload: { currentPassword: PASSWORD, password: "another correct horse battery staple" } });
  assert.equal(changed.statusCode, 200);
  const redeemed = await tokenRequest(app, { grant_type: "authorization_code", code: beforeChange.code, redirect_uri: CHATGPT_REDIRECT, client_id: client.client_id, code_verifier: beforeChange.pkce.verifier });
  assert.equal(redeemed.statusCode, 400);
  assert.equal(redeemed.json().error, "invalid_grant");
});

test("connection count, request rates and form bodies are bounded", async (t) => {
  const { app, authStore } = oauthApp(t, { maxConnectionsPerUser: 2 });
  const client = await register(app, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" });
  const session = await addAndLogin(app, authStore, { id: "reader-1", email: "reader@example.test", roles: ["user"] });
  await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  await connect(app, session, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT });
  const handle = await startAuthorization(app, { clientId: client.client_id, redirectUri: CHATGPT_REDIRECT, challenge: createPkce().challenge });
  const limited = await decide(app, session, handle, "approve");
  assert.equal(limited.statusCode, 409);
  assert.equal(limited.json().error.code, "OAUTH_CONNECTION_LIMIT");

  const duplicate = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: "grant_type=refresh_token&grant_type=authorization_code&refresh_token=x",
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(duplicate.json().error, "invalid_request");
  const oversized = await app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `grant_type=refresh_token&refresh_token=${"x".repeat(20_000)}`,
  });
  assert.equal(oversized.statusCode, 413);
  const json = await app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token" } });
  assert.equal(json.statusCode, 400);
  assert.equal(json.json().error, "invalid_request");
  const unsupported = await tokenRequest(app, { grant_type: "client_credentials", client_id: client.client_id });
  assert.equal(unsupported.json().error, "unsupported_grant_type");

  let limitedCount = 0;
  for (let index = 0; index < 40; index += 1) {
    const response = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: `C${index}`, redirect_uris: [CHATGPT_REDIRECT] }, remoteAddress: "198.51.100.7" });
    if (response.statusCode === 429) limitedCount += 1;
  }
  assert.ok(limitedCount > 0, "dynamic registration is rate limited per client address");
});

test("dynamic client capacity is bounded and unused registrations are pruned", async (t) => {
  const clock = new TestClock();
  const { app, oauthStore } = oauthApp(t, { clock, maxDynamicClients: 3 });
  for (let index = 0; index < 3; index += 1) {
    await register(app, { client_name: `C${index}`, redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "none" }, `198.51.100.${index + 10}`);
  }
  const full = await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [CHATGPT_REDIRECT] }, remoteAddress: "198.51.100.20" });
  assert.equal(full.statusCode, 503);
  assert.equal(full.json().error, "temporarily_unavailable");
  clock.advance(25 * 60 * 60 * 1000);
  await oauthStore.cleanup(clock.now());
  const after = await app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris: [CHATGPT_REDIRECT] }, remoteAddress: "198.51.100.21" });
  assert.equal(after.statusCode, 201);
});

// --- helpers ---------------------------------------------------------------

class TestClock {
  private current = Date.parse("2026-09-29T00:00:00.000Z");
  now = () => new Date(this.current);
  advance(ms: number) { this.current += ms; }
}

function oauthApp(t: { after(fn: () => unknown): void }, options: {
  clock?: TestClock;
  dynamicRegistration?: boolean;
  maxConnectionsPerUser?: number;
  maxDynamicClients?: number;
} = {}) {
  const authStore = new MemoryAuthStore("closed");
  const oauthStore = new MemoryOAuthStore(authStore);
  const parsed = parseOAuthConfig({
    NODE_ENV: "production",
    MYSKILLS_OAUTH_ENABLED: "true",
    MYSKILLS_OAUTH_ISSUER: ORIGIN,
    MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
    APP_BASE_URL: ORIGIN,
    MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: options.dynamicRegistration === false ? "false" : "true",
    MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test,claude.example.test",
    MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{
      client_id: "configured-connector",
      client_name: "Configured Claude",
      redirect_uris: [CLAUDE_REDIRECT],
      client_secret_sha256: sha256(CONFIGURED_SECRET),
    }]),
  });
  assert.ok(parsed);
  const config: OAuthConfig = {
    ...parsed,
    ...(options.maxConnectionsPerUser ? { maxConnectionsPerUser: options.maxConnectionsPerUser } : {}),
    ...(options.maxDynamicClients ? { maxDynamicClients: options.maxDynamicClients } : {}),
  };
  const oauthService = new OAuthService({ store: oauthStore, authStore, config, ...(options.clock ? { now: options.clock.now } : {}) });
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore, { oauthAccessTokens: oauthService }),
    submissionService: new SubmissionService(new MemorySubmissionStore()),
    oauthService,
    allowedOrigins: [ORIGIN],
  });
  t.after(() => app.close());
  return { app, authStore, oauthStore, oauthService };
}

type App = ReturnType<typeof buildApp>;

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }

function basicAuthorization(clientId: string, secret: string) {
  return { authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString("base64")}` };
}

async function register(app: App, body: Record<string, unknown>, remoteAddress = "203.0.113.5") {
  const response = await app.inject({ method: "POST", url: "/oauth/register", payload: body, remoteAddress });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  return response.json();
}

async function startAuthorization(app: App, input: { clientId: string; redirectUri: string; challenge: string; state?: string; scope?: string }) {
  const response = await app.inject({
    method: "GET",
    url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      state: input.state ?? "state-1",
      ...(input.scope ? { scope: input.scope } : {}),
    })}`,
  });
  assert.equal(response.statusCode, 302, response.body);
  const location = new URL(String(response.headers.location));
  assert.equal(`${location.origin}${location.pathname}`, `${ORIGIN}/connect/authorize`);
  assert.equal(location.search, "", "the request handle stays out of query strings and server logs");
  const handle = new URLSearchParams(location.hash.slice(1)).get("request");
  assert.ok(handle);
  return handle;
}

function decide(app: App, session: string, handle: string, decision: "approve" | "deny") {
  return app.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: bearer(session), payload: { request: handle, decision } });
}

async function approvedCode(app: App, session: string, input: { clientId: string; redirectUri: string; state?: string; scope?: string }) {
  const pkce = createPkce();
  const handle = await startAuthorization(app, { ...input, challenge: pkce.challenge });
  const response = await decide(app, session, handle, "approve");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const location = new URL(response.json().redirectTo);
  assert.equal(`${location.origin}${location.pathname}`, input.redirectUri);
  assert.equal(location.searchParams.get("iss"), ORIGIN);
  const code = location.searchParams.get("code");
  assert.match(code ?? "", /^myskills_ac\.[A-Za-z0-9_-]{43}$/);
  return { code: code!, pkce, state: location.searchParams.get("state") };
}

async function connect(app: App, session: string, input: { clientId: string; redirectUri: string; scope?: string }) {
  const { code, pkce } = await approvedCode(app, session, input);
  const response = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: input.redirectUri, client_id: input.clientId, code_verifier: pkce.verifier, resource: RESOURCE });
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

function formRequest(app: App, url: string, fields: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) body.set(key, value);
  return app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, payload: body.toString() });
}

function tokenRequest(app: App, fields: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  return formRequest(app, "/oauth/token", fields, headers);
}

async function addAndLogin(app: App, authStore: MemoryAuthStore, input: { id: string; email: string; roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> }) {
  authStore.addUser({ ...input, status: "active", emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) });
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: input.email, password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  return response.json().token as string;
}

async function enrollMfa(app: App, session: string) {
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: bearer(session), payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: bearer(session),
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200);
  return confirm.json().mfa.recoveryCodes as string[];
}

async function addAndLoginWithMfa(app: App, authStore: MemoryAuthStore, input: { id: string; email: string; roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> }) {
  const setup = await addAndLogin(app, authStore, input);
  const recoveryCodes = await enrollMfa(app, setup);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: input.email, password: PASSWORD } });
  const verify = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: login.json().challengeToken, recoveryCode: recoveryCodes[0] } });
  assert.equal(verify.statusCode, 200);
  return verify.json().token as string;
}
