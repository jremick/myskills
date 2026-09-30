import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemoryTeamStore } from "../../api/src/teams/memory-team-store.js";
import { TeamService } from "../../api/src/teams/service.js";
import { parseOAuthConfig } from "../../api/src/oauth/config.js";
import { MemoryOAuthStore } from "../../api/src/oauth/memory-store.js";
import { OAuthService } from "../../api/src/oauth/service.js";
import { createAiSkillsMcpHttpServer } from "../src/http.js";

// Failure inventory, written before adapter implementation:
// - Read-only grants silently gain writes, or writes disappear from discovery so consent cannot step up.
// - SDK calls lose action-specific scope challenges or fail to report the trusted resource metadata URL.
// - A fresh approved grant cannot persist a valid action, or a foreign user can change its resource.
// - Expired consent assurance/refresh or revoked grants keep privileged actions usable.
// - Caller-controlled method/path/query/body fields create a proxy or leak upstream errors/secrets.
// - API tokens, old tools and native Skills regress while adding application actions.
// - Release/search cursors are dropped or unknown request fields are silently accepted.
// Real sockets: MCP SDK -> HTTP adapter -> API -> auth/OAuth/team service -> stores.
const ORIGIN = "http://127.0.0.1:43999";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.example.test/connector/callback";

test("MCP application actions: discover scopes, challenge, consent, persist, foreign denial, stale assurance and revoke", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const reader = await f.connect("owner", "teams:read");
  const readClient = await f.client(reader.access_token);
  const catalog = (await readClient.listTools()).tools;
  const create = catalog.find((tool) => tool.name === "teams_create");
  assert.ok(create, "write actions remain discoverable before incremental consent");
  assert.equal(create.annotations?.readOnlyHint, false);
  assert.deepEqual(create._meta?.securitySchemes, [{ type: "oauth2", scopes: ["teams:write"] }]);
  const challenge = await f.raw(reader.access_token, "teams_create", { body: { name: "Not consented" } });
  assert.equal(challenge.status, 403, await challenge.clone().text());
  assert.match(challenge.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /scope="teams:write"/);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127.0.0.1:43999\/.well-known\/oauth-protected-resource\/mcp"/);
  await assert.rejects(readClient.callTool({ name: "teams_create", arguments: { body: { name: "Not consented either" } } }));

  const conditional = await f.connect("owner", "skills:read review:write skills:submit");
  const sharingChallenge = await f.raw(conditional.access_token, "skills_metadata_update", { path: { slug: "existing-skill" }, body: { visibility: "public" } });
  assert.equal(sharingChallenge.status, 403);
  assert.match(sharingChallenge.headers.get("www-authenticate") ?? "", /scope="review:write sharing:write"/);
  const bundleChallenge = await f.raw(conditional.access_token, "bundles_create", { body: { kind: "source", name: "Reviewed bundle", purpose: "A source bundle", owner: { type: "user" }, visibility: "private", memberSlugs: ["existing-skill"], sourceEntryId: "source" } });
  assert.equal(bundleChallenge.status, 403);
  assert.match(bundleChallenge.headers.get("www-authenticate") ?? "", /scope="skills:read skills:submit libraries:read"/);

  const writer = await f.connect("owner", "teams:read teams:write account:read account:connections:revoke");
  const writerClient = await f.client(writer.access_token);
  const created = await writerClient.callTool({ name: "teams_create", arguments: { body: { name: "Delegated team" } } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const id = (created.structuredContent as { team: { id: string } }).team.id;
  const listed = await writerClient.callTool({ name: "teams_list", arguments: {} });
  assert.equal((listed.structuredContent as { teams: Array<{ id: string }> }).teams[0].id, id);
  const stored = await f.app.inject({ method: "GET", url: "/v1/teams", headers: { authorization: `Bearer ${f.session("owner")}` } });
  assert.equal(stored.json().teams[0].id, id, "the API persisted the MCP action");
  const foreign = await f.connect("other", "teams:read teams:write");
  const foreignClient = await f.client(foreign.access_token);
  const denied = await foreignClient.callTool({ name: "teams_invitations_create", arguments: { path: { id }, body: { email: "invitee@example.test" } } });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /TEAM_OWNER_REQUIRED/);
  const proxy = await writerClient.callTool({ name: "teams_create", arguments: { body: { name: "Rejected extra" }, method: "DELETE", path: { id } } });
  assert.equal(proxy.isError, true);
  const traversal = await writerClient.callTool({ name: "teams_invitations_create", arguments: { path: { id: "../auth/api-tokens" }, body: { email: "invitee@example.test" } } });
  assert.equal(traversal.isError, true);

  const refreshed = await f.token({ grant_type: "refresh_token", refresh_token: writer.refresh_token });
  assert.equal(refreshed.status, 200);
  const freshTokens = await refreshed.json();
  const verifier = await f.oauth.verifyAccessToken(freshTokens.access_token);
  assert.ok(verifier?.mfaVerifiedAt);
  t.mock.timers.enable({ apis: ["Date"], now: verifier.mfaVerifiedAt.getTime() + 900_001 });
  const staleClient = await f.client(freshTokens.access_token);
  const stale = await staleClient.callTool({ name: "teams_create", arguments: { body: { name: "Expired assurance" } } });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /MFA_VERIFICATION_REQUIRED/);
  t.mock.timers.reset();
  const connections = await writerClient.callTool({ name: "connections_list", arguments: {} });
  assert.equal(connections.isError, undefined);
  const current = (connections.structuredContent as { connections: Array<{ id: string }> }).connections[0];
  assert.ok(current);
  await f.authStore.revokeUserCredentials("owner");
  const revoked = await f.raw(freshTokens.access_token, "teams_list", {});
  assert.equal(revoked.status, 401);
  assert.equal((await f.app.inject({ method: "GET", url: "/v1/teams", headers: { authorization: `Bearer ${foreign.access_token}` } })).json().teams.length, 0);
});

async function fixture(t: TestContext) {
  const authStore = new MemoryAuthStore("closed");
  const teamStore = new MemoryTeamStore();
  const verifiedAt = new Date(Date.now() - 1_000);
  const session = (user: string) => `synthetic-application-parity-session-${user}`;
  for (const id of ["owner", "other"]) {
    authStore.addUser({ id, email: `${id}@example.test`, roles: id === "owner" ? ["owner"] : ["user"], status: "active", emailVerifiedAt: new Date() });
    teamStore.addKnownUser({ id, email: `${id}@example.test`, name: id });
    await authStore.createSession({ userId: id, tokenHash: hashSessionToken(session(id)), expiresAt: new Date(Date.now() + 3_600_000), mfaVerifiedAt: verifiedAt });
  }
  const store = new MemoryOAuthStore(authStore);
  const config = parseOAuthConfig({ NODE_ENV: "production", MYSKILLS_OAUTH_ENABLED: "true", MYSKILLS_OAUTH_ISSUER: ORIGIN, MYSKILLS_MCP_PUBLIC_URL: RESOURCE, APP_BASE_URL: ORIGIN, MYSKILLS_OAUTH_CLIENTS: JSON.stringify([{ client_id: "application-test", client_name: "Application test", redirect_uris: [REDIRECT] }]) })!;
  const oauth = new OAuthService({ store, authStore, config });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(authStore, { oauthAccessTokens: oauth }), oauthService: oauth, teamService: new TeamService(teamStore), allowedOrigins: [ORIGIN] });
  await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const mcp = createAiSkillsMcpHttpServer({ apiBaseUrl: apiBase, oauth: { issuer: ORIGIN, resourceUrl: RESOURCE } });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => mcp.close(() => resolve())));
  const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  const token = (fields: Record<string, string>) => fetch(`${apiBase}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: "application-test", ...fields }) });
  return {
    app, authStore, oauth, session, token,
    async client(accessToken: string) {
      const client = new Client({ name: "application-e2e", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
      t.after(() => client.close());
      return client;
    },
    raw: (accessToken: string, name: string, args: Record<string, unknown>) => fetch(mcpUrl, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "application-e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }),
    async connect(user: string, scope: string) {
      const verifier = randomBytes(32).toString("base64url");
      const authorize = await fetch(`${apiBase}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "application-test", redirect_uri: REDIRECT, scope, state: "synthetic-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE })}`, { redirect: "manual" });
      assert.equal(authorize.status, 302);
      const handle = new URLSearchParams(new URL(authorize.headers.get("location")!).hash.slice(1)).get("request");
      const decide = await fetch(`${apiBase}/v1/oauth/consent/decision`, { method: "POST", headers: { authorization: `Bearer ${session(user)}`, "content-type": "application/json" }, body: JSON.stringify({ request: handle, decision: "approve" }) });
      assert.equal(decide.status, 200, await decide.clone().text());
      const redirect = (await decide.json()).redirectTo;
      const response = await token({ grant_type: "authorization_code", code: new URL(redirect).searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE });
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { access_token: string; refresh_token: string };
    },
  };
}
