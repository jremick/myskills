import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { generateTotpCode, hashPassword, hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { parseOAuthConfig } from "../src/oauth/config.js";
import { MemoryOAuthStore } from "../src/oauth/memory-store.js";
import { OAuthService } from "../src/oauth/service.js";
import { secretDigest } from "../src/oauth/tokens.js";

// Failure inventory, written before assurance implementation:
// - Consent or exchange time silently replaces the real MFA timestamp.
// - A forged actor/body boolean, stale/future timestamp or revoked session enables consent.
// - Refresh extends privileged assurance or adds unapproved application scopes.
// - A read-only legacy grant receives invented assurance on upgrade/refresh.
// - Revocation races leave an approved code or live grant usable.
// These journeys use actual HTTP handlers, auth, OAuth services and memory stores.
const ORIGIN = "https://skills.example.test";
const REDIRECT = "https://chatgpt.example.test/connector/callback";
const PASSWORD = "synthetic correct horse battery staple";
const WINDOW = 15 * 60_000;

test("OAuth consent carries real session MFA through code exchange and refresh without renewal", async (t) => {
  const f = fixture(t);
  f.authStore.addUser({ id: "owner", email: "owner@example.test", roles: ["owner"], status: "active", emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) });
  const login = () => f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "owner@example.test", password: PASSWORD } });
  const initial = (await login()).json().token as string;
  const enrollment = await f.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: bearer(initial), payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirmed = await f.app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: bearer(initial), payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const challenge = (await login()).json().challengeToken;
  const verified = await f.app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge, recoveryCode: confirmed.json().mfa.recoveryCodes[0] } });
  assert.equal(verified.statusCode, 200, verified.body);
  const session = verified.json().token as string;
  const actual = (await f.authStore.findUserBySessionTokenHash(hashSessionToken(session)))!.sessionMfaVerifiedAt!;
  f.setNow(new Date(actual.getTime() + 60_000));
  const started = await f.start("skills:read architectures:write");
  const inspected = await f.app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: started.handle } });
  assert.equal(inspected.statusCode, 200, inspected.body);
  assert.equal(inspected.json().authorization.mfaRequired, false);
  assert.match(inspected.json().authorization.scopes.find((entry: { scope: string }) => entry.scope === "architectures:write").description, /create|change|update/i);
  const decided = await f.decide(session, started.handle, { mfaVerified: false });
  assert.equal(decided.statusCode, 200, decided.body);
  f.setNow(new Date(actual.getTime() + 90_000));
  const tokens = await f.exchange(started, decided.json().redirectTo);
  const context = await f.oauth.verifyAccessToken(tokens.access_token);
  assert.equal(context?.mfaVerifiedAt?.toISOString(), actual.toISOString());
  assert.equal(context?.assuranceExpiresAt?.getTime(), actual.getTime() + WINDOW);
  const stored = await f.store.findAccessToken(secretDigest(tokens.access_token));
  assert.equal(stored?.grant.mfaVerifiedAt?.toISOString(), actual.toISOString());

  f.setNow(new Date(actual.getTime() + WINDOW));
  const stale = await f.start("architectures:write");
  const staleInspection = await f.app.inject({ method: "POST", url: "/v1/oauth/consent/inspect", headers: bearer(session), payload: { request: stale.handle } });
  assert.equal(staleInspection.json().authorization.mfaRequired, true);
  const denied = await f.decide(session, stale.handle, { mfaVerified: true, mfaVerifiedAt: f.now().toISOString() });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "MFA_VERIFICATION_REQUIRED");
  assert.match(denied.json().error.message, /sign in|reconnect|verify/i);
  assert.equal((await f.store.findAuthorizationRequest(secretDigest(stale.handle)))?.status, "pending");
  const refresh = await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refresh.statusCode, 200, refresh.body);
  const refreshed = await f.oauth.verifyAccessToken(refresh.json().access_token);
  assert.equal(refreshed?.mfaVerifiedAt?.toISOString(), actual.toISOString());
  assert.equal(refreshed?.assuranceExpiresAt?.getTime(), actual.getTime() + WINDOW);
  const escalation = await f.token({ grant_type: "refresh_token", refresh_token: refresh.json().refresh_token, scope: "admin:settings" });
  assert.equal(escalation.json().error, "invalid_scope");
  await f.authStore.revokeUserCredentials("owner");
  assert.equal(await f.oauth.verifyAccessToken(refresh.json().access_token), null);
});

test("OAuth consent refuses forged, missing, future or revoked session assurance and keeps read defaults", async (t) => {
  const f = fixture(t);
  f.authStore.addUser({ id: "reader", email: "reader@example.test", roles: ["user"], status: "active", emailVerifiedAt: new Date(), passwordHash: await hashPassword(PASSWORD) });
  const login = await f.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "reader@example.test", password: PASSWORD } });
  const session = login.json().token as string;
  const actor = login.json().user;
  const started = await f.start();
  const decision = await f.decide(session, started.handle);
  assert.equal(decision.statusCode, 200, decision.body);
  const tokens = await f.exchange(started, decision.json().redirectTo);
  assert.equal(tokens.scope, "skills:read");
  const readContext = await f.oauth.verifyAccessToken(tokens.access_token);
  assert.equal(readContext?.mfaVerifiedAt, null);
  assert.equal(readContext?.assuranceExpiresAt, null);
  const refreshed = await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal((await f.oauth.verifyAccessToken(refreshed.json().access_token))?.assuranceExpiresAt, null);

  for (const stamp of [null, new Date(f.now().getTime() + 1), new Date(f.now().getTime() - WINDOW)]) {
    await f.authStore.createSession({ userId: "reader", tokenHash: hashSessionToken(session), expiresAt: new Date(f.now().getTime() + 86_400_000), mfaVerifiedAt: stamp });
    const privileged = await f.start("architectures:write");
    await assert.rejects(f.oauth.decide({ ...actor, mfaVerified: true }, hashSessionToken(session), privileged.handle, "approve"), (error: unknown) => (error as { code: string }).code === "MFA_VERIFICATION_REQUIRED");
  }
  await f.authStore.createSession({ userId: "reader", tokenHash: hashSessionToken(session), expiresAt: new Date(f.now().getTime() + 86_400_000), mfaVerifiedAt: f.now() });
  const revoked = await f.start("architectures:write");
  await f.authStore.revokeSessionByTokenHash(hashSessionToken(session));
  await assert.rejects(f.oauth.decide({ ...actor, mfaVerified: true }, hashSessionToken(session), revoked.handle, "approve"), (error: unknown) => (error as { code: string }).code === "AUTHENTICATION_REQUIRED");
  assert.equal((await f.store.findAuthorizationRequest(secretDigest(revoked.handle)))?.status, "pending");
});

function fixture(t: { after(fn: () => Promise<void>): void }) {
  let now = new Date();
  const authStore = new MemoryAuthStore("open");
  const store = new MemoryOAuthStore(authStore);
  const config = parseOAuthConfig({ NODE_ENV: "production", MYSKILLS_OAUTH_ENABLED: "true", MYSKILLS_OAUTH_ISSUER: ORIGIN, MYSKILLS_MCP_PUBLIC_URL: `${ORIGIN}/mcp`, APP_BASE_URL: ORIGIN, MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{ client_id: "assurance-test", client_name: "Assurance test", redirect_uris: [REDIRECT] }]) })!;
  const oauth = new OAuthService({ store, authStore, config, now: () => now });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(authStore, { oauthAccessTokens: oauth }), oauthService: oauth, allowedOrigins: [ORIGIN] });
  t.after(() => app.close());
  const token = (fields: Record<string, string>) => app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ client_id: "assurance-test", ...fields }).toString() });
  return {
    app, oauth, authStore, store, token, now: () => now, setNow: (value: Date) => { now = value; },
    async start(scope?: string) {
      const verifier = randomBytes(32).toString("base64url");
      const location = await oauth.authorize({ response_type: "code", client_id: "assurance-test", redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", ...(scope ? { scope } : {}) });
      const handle = new URLSearchParams(new URL(location).hash.slice(1)).get("request");
      assert.ok(handle, location);
      return { handle, verifier };
    },
    decide: (session: string, handle: string, extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: bearer(session), payload: { request: handle, decision: "approve", ...extra } }),
    async exchange(started: { verifier: string }, redirect: string) {
      const response = await token({ grant_type: "authorization_code", code: new URL(redirect).searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: started.verifier });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { access_token: string; refresh_token: string; scope: string };
    },
  };
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
