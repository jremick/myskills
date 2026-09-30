import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService, type OAuthAccessTokenVerifier } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import type { ApiTokenScope } from "../src/auth/types.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";

// Failure inventory, authored before the delegated policy implementation:
// - Old/read-only credentials gain formerly synthetic-long-fixture-session-only writes after an upgrade.
// - A scoped credential gets another user's team or bypasses owner/MFA guards.
// - Role filtering or forged/stale assurance changes permissions; refresh is not MFA.
// - Raw requests, cookies and hidden tool calls bypass the same named-action gate.
// - Delegation reaches token issuance, MFA secrets, local producers or executors.
// - A completed/denied action lacks safe user/action/credential attribution.
// This runs real Fastify, AuthService, API-token minting, team services and stores.
// The OAuth verifier is a deterministic issuer-bound fixture; persistent OAuth
// consent/code/refresh provenance is independently exercised by OAuth E2E tests.

async function fixture(t: TestContext) {
  const store = new MemoryAuthStore("closed");
  const teams = new MemoryTeamStore();
  const verified = new Date(Date.now() - 1_000);
  for (const id of ["owner", "other"]) {
    store.addUser({ id, email: `${id}@example.test`, name: id, status: "active", roles: id === "owner" ? ["owner"] : ["user"], emailVerifiedAt: new Date() });
    teams.addKnownUser({ id, email: `${id}@example.test`, name: id });
    await store.createSession({ userId: id, tokenHash: hashSessionToken(`synthetic-long-fixture-session-${id}`), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: verified });
  }
  await store.createSession({ userId: "owner", tokenHash: hashSessionToken("synthetic-long-fixture-session-unverified"), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: null });
  const issued = new Map<string, Awaited<ReturnType<OAuthAccessTokenVerifier["verifyAccessToken"]>>>();
  const auth = new AuthService(store, { notificationSink: { sendEmailVerification() {}, sendPasswordReset() {}, sendRegistrationInvitation() {}, sendEmailChangeVerification() {} }, oauthAccessTokens: { verifyAccessToken: async (token) => issued.get(token) ?? null } });
  const app = buildApp({ authService: auth, skillRepository: new MemorySkillRepository([]), teamService: new TeamService(teams) });
  t.after(() => app.close());
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const apiToken = async (scopes: string[], session = "synthetic-long-fixture-session-owner") => {
    const response = await call("POST", "/v1/auth/api-tokens", session, { name: "delegation fixture", scopes });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().token.token as string;
  };
  const oauthToken = async (scopes: string[], options: { user?: string; verifiedAt?: Date | null; expiresAt?: Date | null } = {}) => {
    const id = options.user ?? "owner";
    const user = await store.findUserById(id);
    assert.ok(user);
    const token = `myskills_at.${issued.size.toString().padStart(43, "x")}`;
    const mfaVerifiedAt = options.verifiedAt === undefined ? verified : options.verifiedAt;
    issued.set(token, { user, grantId: `grant-${issued.size}`, clientId: "synthetic-client", resource: "https://example.test/mcp", scopes: scopes as ApiTokenScope[], mfaVerifiedAt, assuranceExpiresAt: options.expiresAt === undefined ? mfaVerifiedAt && new Date(mfaVerifiedAt.getTime() + 900_000) : options.expiresAt });
    return token;
  };
  return { app, auth, store, call, apiToken, oauthToken };
}

test("named delegated API actions retain scopes, ownership, MFA and safe audit attribution", async (t) => {
  const f = await fixture(t);
  const old = await f.apiToken(["skills:read", "review:write"]);
  const denied = await f.call("POST", "/v1/teams", old, { name: "Old token must not create" });
  assert.equal(denied.statusCode, 403);
  const token = await f.apiToken(["teams:read", "teams:write"]);
  const created = await f.call("POST", "/v1/teams", token, { name: "Scoped Team" });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().team.id;
  assert.equal((await f.call("GET", "/v1/teams", token)).json().teams[0].id, id);
  const other = await f.apiToken(["teams:read", "teams:write"], "synthetic-long-fixture-session-other");
  const stranger = await f.call("POST", `/v1/teams/${id}/invitations`, other, { email: "invitee@example.test" });
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json().error.code, "TEAM_OWNER_REQUIRED");
  assert.deepEqual((await f.call("GET", "/v1/teams", other)).json().teams, []);
  assert.equal(await f.auth.authenticateSessionAuthorizationHeader(`Bearer ${token}`), null);
  const audits = await f.store.listAuditEvents({ limit: 100 });
  const allowed = audits.find((row) => row.action === "delegated.teams.create" && row.decision === "allow");
  assert.ok(allowed);
  assert.equal(allowed.actorUserId, "owner");
  assert.equal(allowed.details.credentialKind, "api");
  assert.equal(typeof allowed.details.credentialId, "string");
  assert.equal(JSON.stringify(audits).includes(token), false);
});

test("OAuth raw calls enforce read scopes, live roles, bounded assurance and header-only credentials", async (t) => {
  const f = await fixture(t);
  const read = await f.oauthToken(["teams:read"]);
  assert.equal((await f.call("GET", "/v1/teams", read)).statusCode, 200);
  const denied = await f.call("POST", "/v1/teams", read, { name: "No write consent" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "API_TOKEN_SCOPE_REQUIRED");
  const privileged = await f.oauthToken(["teams:write", "teams:read", "admin:read"]);
  const created = await f.call("POST", "/v1/teams", privileged, { name: "Delegated Team" });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await f.call("GET", "/v1/admin/branding", privileged)).statusCode, 200);
  for (const options of [
    { verifiedAt: null },
    { verifiedAt: new Date(Date.now() - 901_000) },
    { verifiedAt: new Date(Date.now() + 60_000) },
    { expiresAt: new Date(Date.now() + 3_600_000) },
  ]) {
    const stale = await f.oauthToken(["teams:write"], options);
    const response = await f.call("POST", "/v1/teams", stale, { name: "Unassured" });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, "MFA_VERIFICATION_REQUIRED");
  }
  const forged = await f.call("POST", "/v1/teams", privileged, { name: "Forged", mfaVerified: true });
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.json().error.code, "UNSUPPORTED_TEAM_FIELD");
  for (const authorization of [undefined, `Bearer ${read}`]) {
    const cookie = await f.app.inject({ method: "GET", url: "/v1/teams", headers: { cookie: `myskills_session=${privileged}`, ...(authorization ? { authorization } : {}) } });
    assert.equal(cookie.statusCode, authorization ? 200 : 403, cookie.body);
  }
  const audit = (await f.store.listAuditEvents({ limit: 100 })).find((row) => row.action === "delegated.teams.create" && row.details.credentialKind === "oauth" && row.decision === "allow");
  assert.ok(audit);
  assert.equal(audit.details.clientId, "synthetic-client");
  assert.equal(typeof audit.details.grantId, "string");
});

test("delegation excludes secret, producer and executor routes while any application scope can bootstrap MCP", async (t) => {
  const f = await fixture(t);
  const token = await f.oauthToken(["account:read", "teams:write", "targets:control"]);
  assert.equal((await f.call("GET", "/v1/auth/api-tokens", token)).statusCode, 200);
  assert.ok((await f.store.listAuditEvents({ limit: 100 })).some((event) => event.action === "delegated.account.tokens.list"));
  const bootstrap = await f.call("GET", "/v1/mcp/session", token);
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  const native = await f.app.inject({ method: "GET", url: "/v1/mcp/session", headers: { authorization: `Bearer ${token}`, "x-myskills-mcp-method": "skills/list" } });
  assert.equal(native.statusCode, 403);
  for (const url of ["/v1/auth/api-tokens", "/v1/auth/mfa/totp/enroll", "/v1/auth/account/password", "/v1/architecture-targets/example/observations", "/v1/architecture-targets/example/operations/claim", "/v1/unknown"]) {
    const response = await f.call("POST", url, token, {});
    assert.equal(response.statusCode, 403, `${url}: ${response.body}`);
    assert.equal(response.json().error.code, "OAUTH_TOKEN_NOT_ALLOWED");
  }
  const minted = await f.call("POST", "/v1/auth/api-tokens", "synthetic-long-fixture-session-unverified", { name: "No MFA", scopes: ["sharing:write"] });
  assert.equal(minted.statusCode, 403);
  assert.equal(minted.json().error.code, "MFA_VERIFICATION_REQUIRED");
});

test("metadata sharing adds its own scope and assurance and legacy read grants gain no roles", async (t) => {
  const f = await fixture(t);
  const reviewer = await f.oauthToken(["review:write"]);
  const missingScope = await f.call("PUT", "/v1/skills/hidden", reviewer, { visibility: "public" });
  assert.equal(missingScope.statusCode, 403);
  assert.equal(missingScope.json().error.code, "API_TOKEN_SCOPE_REQUIRED");
  assert.equal(missingScope.json().error.details.scope, "sharing:write");
  const unassured = await f.oauthToken(["review:write", "sharing:write"], { verifiedAt: null });
  const missingAssurance = await f.call("PUT", "/v1/skills/hidden", unassured, { visibility: "public" });
  assert.equal(missingAssurance.statusCode, 403);
  assert.equal(missingAssurance.json().error.code, "MFA_VERIFICATION_REQUIRED");
  // Reviewed scope-label mismatch: registration invitations are user management,
  // never settings authority. Exercise both directions before correcting policy.
  for (const [kind, issue] of [["oauth", f.oauthToken], ["api", f.apiToken]] as const) {
    const settingsOnly = await issue(["admin:settings"]);
    const usersOnly = await issue(["admin:users"]);
    const settingsResult = await f.call("POST", "/v1/admin/registration/invitations", settingsOnly, { email: `${kind}-settings@example.test` });
    const usersResult = await f.call("POST", "/v1/admin/registration/invitations", usersOnly, { email: `${kind}-users@example.test` });
    assert.deepEqual([settingsResult.statusCode, usersResult.statusCode], [403, 201]);
    assert.equal(settingsResult.json().error.details.scope, "admin:users");
  }
  const legacy = await f.oauthToken(["skills:read", "architectures:read"], { verifiedAt: null });
  const legacyContext = await f.auth.authenticateRequest(`Bearer ${legacy}`);
  assert.deepEqual(legacyContext?.user.roles, ["user"]);
  assert.equal(legacyContext?.user.mfaVerified, false);
  const modern = await f.oauthToken(["skills:read"], { verifiedAt: new Date(Date.now() - 901_000) });
  const expiredContext = await f.auth.authenticateRequest(`Bearer ${modern}`);
  assert.deepEqual(expiredContext?.user.roles, ["owner"]);
  assert.equal(expiredContext?.user.mfaVerified, false);
});
