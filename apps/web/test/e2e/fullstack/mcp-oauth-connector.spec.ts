import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Real browser + nginx web proxy + API + MCP service + Postgres. One public
 * origin serves discovery, authorization, consent, token and MCP traffic.
 * The client redirect host is intercepted in the browser; no provider is
 * contacted. This is local stack evidence, not ChatGPT or Claude acceptance.
 *
 * Scoped-write failure inventory (before the application MCP adapter):
 * - A default read grant mutates a team or silently gains additional scopes.
 * - Consent hides write effects or accepts a grant without real session MFA.
 * - A successful MCP reply has no persistent API result after browser reload.
 * - A team write scope bypasses the live resource-owner check.
 * - Revocation blocks discovery but still permits a previously discovered write.
 * - A revoked grant refreshes or creates another persistent team.
 */
test.use({ trace: "off", video: "off", screenshot: "off" });

const REDIRECT = "https://client.example.test/callback";

test("remote MCP connector: MFA consent, scoped writes, persistent readback and revocation", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const ownerEmail = requiredEnvironment("MYSKILLS_E2E_OWNER_EMAIL");
  const ownerPassword = requiredEnvironment("MYSKILLS_E2E_OWNER_PASSWORD");
  const recoveryCodes = JSON.parse(requiredEnvironment("MYSKILLS_E2E_OWNER_RECOVERY_CODES")) as string[];
  // Codes 0-6 belong to other full-stack specs and runner bootstrap.
  const recoveryCode = recoveryCodes[8 + testInfo.retry];
  expect(recoveryCode, "an unused owner recovery code for this retry").toBeTruthy();
  const origin = new URL(baseURL!).origin;
  const evidence: Record<string, unknown> = { origin, providerAcceptance: "not performed" };

  const metadata = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(metadata.issuer).toBe(origin);
  expect(metadata.authorization_endpoint).toBe(`${origin}/oauth/authorize`);
  const resourceMetadata = await (await request.get("/.well-known/oauth-protected-resource/mcp")).json();
  expect(resourceMetadata).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  const challenge = await mcp(request, undefined, "initialize");
  expect(challenge.status()).toBe(401);
  expect(challenge.headers()["www-authenticate"]).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);

  const registered = await request.post("/oauth/register", { data: { client_name: "Full-stack connector", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" } });
  expect(registered.status()).toBe(201);
  const clientId = (await registered.json()).client_id as string;

  const verifier = randomBytes(32).toString("base64url");
  const state = `fullstack-${randomBytes(6).toString("hex")}`;
  let callback: URL | null = null;
  await page.route("https://client.example.test/**", async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ contentType: "text/html", body: "<title>Synthetic client</title><p>Callback received</p>" });
  });
  const readInspection = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/oauth/consent/inspect" && response.request().method() === "POST" && response.status() === 200);
  await page.goto(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${origin}/mcp`,
  })}`);
  await expect(page).toHaveURL(`${origin}/connect/authorize`);
  await page.getByRole("button", { name: "Sign in to continue" }).click();
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(ownerPassword);
  // Report auth failures, such as a consumed login rate limit (429), at once.
  const login = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/login" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const loginStatus = (await login).status();
  expect(loginStatus, `owner login returned HTTP ${loginStatus}${loginStatus === 429 ? " (login rate limit already consumed; run this journey on a fresh stack)" : ""}`).toBe(200);
  await page.getByLabel("MFA code").fill(recoveryCode!);
  const verify = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/auth/mfa/verify" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const verifyStatus = (await verify).status();
  expect(verifyStatus, `owner MFA verification returned HTTP ${verifyStatus}`).toBe(200);
  await expect(page).toHaveURL(`${origin}/connect/authorize`);
  await expect(page.getByRole("heading", { name: "Connect Full-stack connector to MySkills" })).toBeVisible();
  const readDetails = (await (await readInspection).json()).authorization;
  expect(readDetails.scopes).toEqual([expect.objectContaining({ scope: "skills:read", readOnly: true })]);
  await expect(page.getByText("https://client.example.test", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("fullstack-consent.png"), fullPage: true });
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => callback?.href ?? "").toContain("code=");
  const received = callback as unknown as URL;
  expect(received.searchParams.get("state")).toBe(state);
  expect(received.searchParams.get("iss")).toBe(origin);

  const exchanged = await request.post("/oauth/token", { form: { grant_type: "authorization_code", code: received.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${origin}/mcp` } });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  expect(tokens.scope).toBe("skills:read");

  const tools = await mcp(request, tokens.access_token, "tools/list");
  expect(tools.status()).toBe(200);
  const toolNames = ((await tools.json()).result.tools as Array<{ name: string }>).map((tool) => tool.name);
  expect(toolNames).toContain("read_skill_file");
  const search = await mcp(request, tokens.access_token, "tools/call", { name: "search_skills", arguments: { query: "release" } });
  expect(search.status()).toBe(200);
  expect(JSON.stringify(await search.json())).toContain("release-notes-helper");
  const misuse = await request.get("/api/v1/me", { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(misuse.status()).toBe(403);

  const suffix = randomBytes(5).toString("hex");
  const blockedName = `Read grant must not create ${suffix}`;
  const scopeDenied = await mcp(request, tokens.access_token, "tools/call", { name: "teams_create", arguments: { body: { name: blockedName } } });
  expect(scopeDenied.status()).toBe(403);
  expect(scopeDenied.headers()["www-authenticate"]).toContain("teams:write");
  const initialTeams = await page.request.get(`${origin}/api/v1/teams`);
  expect(initialTeams.status()).toBe(200);
  expect((await initialTeams.json()).teams.some((team: { name: string }) => team.name === blockedName)).toBe(false);

  // New permissions require a separate explicit consent. Reuse only the real
  // browser session that completed MFA above; never inject a verified flag.
  callback = null;
  const writeVerifier = randomBytes(32).toString("base64url");
  const writeState = `write-${suffix}`;
  const writeInspection = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/oauth/consent/inspect" && response.request().method() === "POST" && response.status() === 200);
  await page.goto(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: writeState, scope: "skills:read teams:read teams:write",
    code_challenge: createHash("sha256").update(writeVerifier).digest("base64url"), code_challenge_method: "S256", resource: `${origin}/mcp`,
  })}`);
  await expect(page.getByRole("heading", { name: "Connect Full-stack connector to MySkills" })).toBeVisible();
  const writeDetails = (await (await writeInspection).json()).authorization;
  expect(writeDetails.mfaRequired).toBe(false);
  expect(writeDetails.scopes).toContainEqual(expect.objectContaining({ scope: "teams:write", readOnly: false }));
  expect(writeDetails.scopes).toContainEqual(expect.objectContaining({ scope: "teams:read", readOnly: true }));
  expect(new Date(writeDetails.assuranceExpiresAt).getTime()).toBeGreaterThan(Date.now());
  await expect(page.getByText("teams:write", { exact: true })).toBeVisible();
  await expect(page.getByText(/This app can make the changes listed above/)).toBeVisible();
  await expect(page.getByText(/This connection is read-only/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("fullstack-write-consent.png"), fullPage: true });
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect.poll(() => callback?.href ?? "").toContain("code=");
  const writeCallback = callback as unknown as URL;
  expect(writeCallback.searchParams.get("state")).toBe(writeState);
  expect(writeCallback.searchParams.get("iss")).toBe(origin);
  const writeExchange = await request.post("/oauth/token", { form: { grant_type: "authorization_code", code: writeCallback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: writeVerifier, resource: `${origin}/mcp` } });
  expect(writeExchange.status()).toBe(200);
  const writeTokens = await writeExchange.json();
  expect(writeTokens.scope.split(" ").sort()).toEqual(["skills:read", "teams:read", "teams:write"]);
  const teamName = `Connector team ${suffix}`;
  const created = await mcp(request, writeTokens.access_token, "tools/call", { name: "teams_create", arguments: { body: { name: teamName } } });
  expect(created.status()).toBe(200);
  const createdReply = await created.json();
  expect(createdReply.result.isError).not.toBe(true);
  expect(createdReply.result.structuredContent.team).toMatchObject({ name: teamName });
  const createdTeamId = createdReply.result.structuredContent.team.id as string;
  expect(createdTeamId).toMatch(/^[a-f0-9-]{36}$/);
  const listed = await mcp(request, writeTokens.access_token, "tools/call", { name: "teams_list", arguments: {} });
  expect(listed.status()).toBe(200);
  const listedReply = await listed.json();
  expect(listedReply.result.isError).not.toBe(true);
  expect(listedReply.result.structuredContent.teams).toContainEqual(expect.objectContaining({ id: createdTeamId, name: teamName }));

  // A scope does not make this actor the owner of an inaccessible target team.
  const inaccessibleTeam = randomUUID();
  const ownershipDenied = await mcp(request, writeTokens.access_token, "tools/call", { name: "teams_invitations_create", arguments: { path: { id: inaccessibleTeam }, body: { email: `member-${suffix}@example.test` } } });
  expect(ownershipDenied.status()).toBe(200);
  const ownershipReply = await ownershipDenied.json();
  expect(ownershipReply.result.isError).toBe(true);
  expect(ownershipReply.result.structuredContent.error).toMatchObject({ code: "TEAM_OWNER_REQUIRED", status: 403 });

  await page.goto("/teams");
  await page.reload();
  await expect(page.getByText(teamName, { exact: true }).first()).toBeVisible();
  const persistedResponse = await page.request.get(`${origin}/api/v1/teams`);
  expect(persistedResponse.status()).toBe(200);
  const persisted = (await persistedResponse.json()).teams as Array<{ id: string; name: string }>;
  const saved = persisted.filter((team) => team.name === teamName);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.id).toBe(createdTeamId);
  expect(persisted.some((team) => team.name === blockedName)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("fullstack-mcp-team-readback.png"), fullPage: true });

  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Remote connections" });
  await expect(section.getByText(`${origin}/mcp`, { exact: true })).toBeVisible();
  await expect(section.getByText("Full-stack connector", { exact: true })).toHaveCount(2);
  await section.screenshot({ path: testInfo.outputPath("fullstack-remote-connections.png") });
  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await section.getByRole("button", { name: "Revoke Full-stack connector" }).first().click();
    await page.getByRole("button", { name: "Revoke connection" }).click();
    await expect(section.getByText("Full-stack connector", { exact: true })).toHaveCount(remaining - 1);
  }
  expect((await mcp(request, tokens.access_token, "tools/list")).status()).toBe(401);
  const refreshed = await request.post("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId } });
  expect((await refreshed.json()).error).toBe("invalid_grant");

  const afterRevocationName = `Revoked grant must not create ${suffix}`;
  const revokedWrite = await mcp(request, writeTokens.access_token, "tools/call", { name: "teams_create", arguments: { body: { name: afterRevocationName } } });
  expect(revokedWrite.status()).toBe(401);
  const revokedRefresh = await request.post("/oauth/token", { form: { grant_type: "refresh_token", refresh_token: writeTokens.refresh_token, client_id: clientId } });
  expect((await revokedRefresh.json()).error).toBe("invalid_grant");
  const finalReadback = await page.request.get(`${origin}/api/v1/teams`);
  expect(finalReadback.status()).toBe(200);
  const finalTeams = (await finalReadback.json()).teams as Array<{ id: string; name: string }>;
  expect(finalTeams.filter((team) => team.id === saved[0]!.id && team.name === teamName)).toHaveLength(1);
  expect(finalTeams.some((team) => team.name === blockedName || team.name === afterRevocationName)).toBe(false);

  Object.assign(evidence, {
    discovery: true, sameOriginConsent: true, mfaReturn: true, authentication: "browser password and MFA recovery challenge", tokenExchange: true, mcpTools: toolNames.length,
    defaultReadScope: tokens.scope, readGrantWriteDenied: true, explicitWriteScopes: writeTokens.scope.split(" "),
    namedWrite: "teams_create", persistedTeamId: saved[0]!.id, persistedExactlyOnce: true,
    inaccessibleTeamOwnerCheck: true, revocation: true, revokedWriteDenied: true, revokedRefreshDenied: true,
    artifacts: ["fullstack-consent.png", "fullstack-write-consent.png", "fullstack-mcp-team-readback.png", "fullstack-remote-connections.png"],
  });
  await testInfo.attach("mcp-oauth-fullstack", { body: JSON.stringify(evidence), contentType: "application/json" });
});

function mcp(request: APIRequestContext, token: string | undefined, method: string, params: Record<string, unknown> = {}) {
  return request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    data: {
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fullstack-connector", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Run this spec through scripts/run-fullstack-e2e.mjs.`);
  return value;
}
