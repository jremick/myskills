import test from "node:test";
import assert from "node:assert/strict";
import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService, type OAuthAccessTokenVerifier } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import type { ApiTokenScope } from "../src/auth/types.js";
import type { GithubIntegrationService } from "../src/github/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

// Failure inventory before implementation: previously issued/read-only grants
// reach safe writes; a scope is mistaken for MFA; OAuth becomes a session for
// link callbacks or credential configuration. This tests the real API auth
// boundary with service-call sentinels. Real GitHub domain/storage behavior is
// covered by github-integration.pgtest.ts, not fabricated by these sentinels.
test("GitHub delegated routes enforce named scopes without delegating linking or secrets", async (t) => {
  const store = new MemoryAuthStore("closed");
  store.addUser({ id: "owner", email: "owner@example.test", name: "Owner", status: "active", roles: ["owner"], emailVerifiedAt: new Date() });
  const verified = new Date(Date.now() - 1000);
  const session = "synthetic-github-delegation-session";
  await store.createSession({ userId: "owner", tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: verified });
  const grants = new Map<string, Awaited<ReturnType<OAuthAccessTokenVerifier["verifyAccessToken"]>>>();
  const calls: string[] = [];
  const view = (operation: string, actor: { id: string }) => { calls.push(operation); return { status: "connected", actorId: actor.id }; };
  const github = {
    getAccount: async (actor: { id: string }) => view("account.get", actor),
    disconnect: async (actor: { id: string }) => view("account.disconnect", actor),
    getAdmin: async (actor: { id: string }) => view("admin.get", actor),
    testAdmin: async (actor: { id: string }) => view("admin.test", actor),
    connect: async () => { throw new Error("Linking must remain session-only."); },
    callback: async () => { throw new Error("Callback must remain session-only."); },
    updateAdmin: async () => { throw new Error("Secret configuration must remain session-only."); },
  } as unknown as GithubIntegrationService;
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), githubService: github,
    authService: new AuthService(store, { oauthAccessTokens: { verifyAccessToken: async (token) => grants.get(token) ?? null } }) });
  t.after(() => app.close());
  const request = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token: string) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
  const oauth = async (scopes: ApiTokenScope[], mfa = true) => {
    const token = `myskills_at.${grants.size.toString().padStart(43, "x")}`;
    const user = await store.findUserById("owner"); assert.ok(user);
    grants.set(token, { user, grantId: `grant-${grants.size}`, clientId: "fixture", resource: "https://example.test/mcp", scopes,
      mfaVerifiedAt: mfa ? verified : null, assuranceExpiresAt: mfa ? new Date(verified.getTime() + 900_000) : null });
    return token;
  };
  const safe = await oauth(["account:read", "account:connections:revoke", "admin:read", "admin:settings"]);
  const read = await oauth(["account:read"]);
  assert.equal((await request("GET", "/v1/account/github", read)).statusCode, 200);
  assert.equal((await request("DELETE", "/v1/account/github", read)).statusCode, 403);
  for (const [method, path] of [["DELETE", "/v1/account/github"], ["GET", "/v1/admin/github"], ["POST", "/v1/admin/github/test"]] as const) {
    const response = await request(method, path, safe);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().github.actorId, "owner");
  }
  for (const [method, path] of [["POST", "/v1/account/github/connect"], ["GET", "/v1/account/github/callback"], ["PUT", "/v1/admin/github"]] as const) {
    assert.equal((await request(method, path, safe)).statusCode, 403);
  }
  assert.deepEqual(calls, ["account.get", "account.disconnect", "admin.get", "admin.test"]);
  const tokenResponse = await app.inject({ method: "POST", url: "/v1/auth/api-tokens", headers: { authorization: `Bearer ${session}` }, payload: { name: "GitHub read", scopes: ["account:read"] } });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
  const token = tokenResponse.json().token.token;
  assert.equal((await request("GET", "/v1/account/github", token)).statusCode, 200);
  assert.equal((await request("DELETE", "/v1/account/github", token)).statusCode, 403);
});
