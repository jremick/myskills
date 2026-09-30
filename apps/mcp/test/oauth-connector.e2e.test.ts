import { APPLICATION_SCOPES } from "@myskills-app/core";
import { ALL_APPLICATION_TOOL_NAMES, FRIENDLY_READ_TOOLS } from "./application-tool-names.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import type { PublicSkill } from "@myskills-app/core";
import { buildApp } from "../../api/src/app.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../api/src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../api/src/submissions/service.js";
import { parseOAuthConfig } from "../../api/src/oauth/config.js";
import { MemoryOAuthStore } from "../../api/src/oauth/memory-store.js";
import { OAuthService } from "../../api/src/oauth/service.js";
import { createAiSkillsMcpHttpServer } from "../src/http.js";

// Real sockets end to end: the MySkills API (authorization server and registry),
// the MCP HTTP adapter (protected resource) and the MCP SDK client. The public
// origin is a logical loopback proxy origin, as a reverse proxy would present.
// Synthetic users, skills and hosts only.
const PUBLIC_ORIGIN = "http://127.0.0.1:43999";
const RESOURCE = `${PUBLIC_ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.example.test/connector/oauth/e2e";
const PASSWORD = "correct horse battery staple";
const PRM_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const CONNECTOR_TOOLS = ALL_APPLICATION_TOOL_NAMES;

test("remote MCP connector: discovery, consent, private skill isolation, content, refresh, revocation and legacy tokens", { timeout: 60_000 }, async (t) => {
  const stack = await startStack(t);

  // Discovery from the protected resource.
  const prm = await fetch(`${stack.mcpBase}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(prm.status, 200);
  assert.deepEqual(await prm.json(), {
    resource: RESOURCE,
    authorization_servers: [PUBLIC_ORIGIN],
    scopes_supported: [...APPLICATION_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "MySkills",
  });
  const rootPrm = await fetch(`${stack.mcpBase}/.well-known/oauth-protected-resource`);
  assert.equal((await rootPrm.json()).resource, RESOURCE);

  const anonymous = await postMcp(stack.mcpUrl, undefined);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), `Bearer resource_metadata="${PRM_URL}", scope="skills:read"`);
  const invalid = await postMcp(stack.mcpUrl, "myskills_at.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.match(invalid.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${escapeRegExp(PRM_URL)}"`));

  const metadata = await (await fetch(`${stack.apiBase}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, PUBLIC_ORIGIN);

  // Two users connect the same kind of host.
  const alice = await stack.connect("alice@example.test", "skills:read architectures:read");
  const bob = await stack.connect("bob@example.test", "architectures:read");

  const aliceClient = await mcpClient(stack.mcpUrl, alice.tokens.access_token);
  t.after(() => aliceClient.close());
  const tools = await aliceClient.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), CONNECTOR_TOOLS);
  assert.ok(tools.tools.filter(tool => FRIENDLY_READ_TOOLS.includes(tool.name)).every((tool) => tool.annotations?.readOnlyHint === true));

  const aliceSearch = await aliceClient.callTool({ name: "search_skills", arguments: {} });
  const aliceSlugs = (aliceSearch.structuredContent as { skills: Array<{ slug: string }> }).skills.map((skill) => skill.slug).sort();
  assert.deepEqual(aliceSlugs, ["alice-private", "shared-public"]);

  const instructions = await aliceClient.callTool({ name: "read_skill_file", arguments: { slug: "alice-private" } });
  assert.equal(instructions.isError, undefined, JSON.stringify(instructions));
  const read = instructions.structuredContent as {
    skill: { slug: string; version: string; name: string; description: string };
    file: { path: string; sha256: string; size: number; mimeType: string };
    files: Array<{ path: string; sha256: string; size: number }>;
    content: string;
  };
  assert.deepEqual(read.skill, { slug: "alice-private", version: "1.0.0", name: "alice-private", description: "Alice's private synthetic workflow." });
  assert.equal(read.file.path, "SKILL.md");
  assert.equal(read.file.mimeType, "text/markdown");
  assert.equal(read.file.sha256, sha256(read.content));
  assert.match(read.content, /Read references\/notes\.md when needed/);
  assert.deepEqual(read.files.map((file) => file.path).sort(), ["SKILL.md", "references/notes.md", "skill.json"]);
  const supporting = await aliceClient.callTool({ name: "read_skill_file", arguments: { slug: "alice-private", version: "1.0.0", path: "references/notes.md" } });
  assert.equal((supporting.structuredContent as { content: string }).content, "Private note for Alice only.\n");
  for (const path of ["../skill.json", "/SKILL.md", "references/missing.md", "references\\notes.md"]) {
    const rejected = await aliceClient.callTool({ name: "read_skill_file", arguments: { slug: "alice-private", path } });
    assert.equal(rejected.isError, true, path);
    assert.equal(JSON.stringify(rejected).includes("Private note"), false, path);
  }
  const foreign = await aliceClient.callTool({ name: "read_skill_file", arguments: { slug: "bob-private" } });
  assert.equal(foreign.isError, true);
  assert.equal(JSON.stringify(foreign).includes("Bob"), false);
  const write = await aliceClient.callTool({ name: "curate_bundle", arguments: { action: "create", input: {} } }).catch((error: unknown) => error);
  assert.ok(write instanceof Error || (write as { isError?: boolean }).isError === true, "read-only connector grants cannot call write tools");

  // Native Skills delivery keeps working over the same connector token.
  const nativeList = await rawModern(stack.mcpUrl, alice.tokens.access_token, "skills/list", {}, true);
  assert.equal(nativeList.status, 200);
  assert.ok((await nativeList.json()).result.skills.some((skill: { frontmatter: { name: string } }) => skill.frontmatter.name === "alice-private"));

  // Bob's architectures-only grant cannot read skills.
  const bobClient = await mcpClient(stack.mcpUrl, bob.tokens.access_token);
  t.after(() => bobClient.close());
  await assert.rejects(bobClient.callTool({ name: "search_skills", arguments: {} }), /Insufficient scope: required "skills:read"/);
  await assert.rejects(bobClient.callTool({ name: "read_skill_file", arguments: { slug: "shared-public" } }), /Insufficient scope: required "skills:read"/);

  // Refresh rotation keeps the connector working; reuse ends it.
  const rotated = await stack.token({ grant_type: "refresh_token", refresh_token: alice.tokens.refresh_token, client_id: alice.clientId });
  assert.equal(rotated.status, 200);
  const rotatedTokens = await rotated.json();
  const rotatedClient = await mcpClient(stack.mcpUrl, rotatedTokens.access_token);
  t.after(() => rotatedClient.close());
  assert.equal((await rotatedClient.callTool({ name: "search_skills", arguments: {} })).isError, undefined);
  const reuse = await stack.token({ grant_type: "refresh_token", refresh_token: alice.tokens.refresh_token, client_id: alice.clientId });
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal((await postMcp(stack.mcpUrl, rotatedTokens.access_token)).status, 401);

  // User revocation from account settings takes effect on the next MCP call.
  const again = await stack.connect("alice@example.test", "skills:read");
  assert.equal((await postMcp(stack.mcpUrl, again.tokens.access_token)).status, 200);
  const connections = await (await fetch(`${stack.apiBase}/v1/oauth/connections`, { headers: bearer(again.session) })).json();
  assert.equal(connections.connections.length, 1);
  const revoked = await fetch(`${stack.apiBase}/v1/oauth/connections/${connections.connections[0].id}`, { method: "DELETE", headers: bearer(again.session) });
  assert.equal(revoked.status, 200);
  assert.equal((await postMcp(stack.mcpUrl, again.tokens.access_token)).status, 401);

  // Account disable takes effect immediately.
  assert.equal((await postMcp(stack.mcpUrl, bob.tokens.access_token)).status, 200);
  stack.authStore.setUserStatus("bob@example.test", "disabled");
  assert.equal((await postMcp(stack.mcpUrl, bob.tokens.access_token)).status, 401);

  // Existing API-token clients keep every tool, including the write tool.
  const aliceSession = await stack.login("alice@example.test");
  const created = await fetch(`${stack.apiBase}/v1/auth/api-tokens`, {
    method: "POST",
    headers: { ...bearer(aliceSession), "content-type": "application/json" },
    body: JSON.stringify({ name: "Legacy MCP", scopes: ["skills:read"] }),
  });
  assert.equal(created.status, 201);
  const legacy = await mcpClient(stack.mcpUrl, (await created.json()).token.token);
  t.after(() => legacy.close());
  assert.deepEqual((await legacy.listTools()).tools.map((tool) => tool.name).sort(), CONNECTOR_TOOLS);
  const legacyRead = await legacy.callTool({ name: "read_skill_file", arguments: { slug: "alice-private" } });
  assert.equal(legacyRead.isError, undefined);
});

test("an MCP adapter rejects connector tokens bound to another resource or when OAuth is not configured", { timeout: 60_000 }, async (t) => {
  const stack = await startStack(t);
  const alice = await stack.connect("alice@example.test", "skills:read");
  assert.equal((await postMcp(stack.mcpUrl, alice.tokens.access_token)).status, 200);

  const otherResource = createAiSkillsMcpHttpServer({ apiBaseUrl: stack.apiBase, oauth: { issuer: PUBLIC_ORIGIN, resourceUrl: "http://127.0.0.1:43998/mcp" } });
  const otherUrl = await listen(t, otherResource);
  const mismatched = await postMcp(otherUrl, alice.tokens.access_token);
  assert.equal(mismatched.status, 401);
  assert.match(mismatched.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

  const legacyOnly = createAiSkillsMcpHttpServer({ apiBaseUrl: stack.apiBase });
  const legacyUrl = await listen(t, legacyOnly);
  const unconfigured = await postMcp(legacyUrl, alice.tokens.access_token);
  assert.equal(unconfigured.status, 401);
  assert.equal(unconfigured.headers.get("www-authenticate"), null, "legacy adapters keep their existing challenge-free response");
  assert.equal((await fetch(legacyUrl.replace(/\/mcp$/, "/.well-known/oauth-protected-resource/mcp"))).status, 404);

  assert.throws(() => createAiSkillsMcpHttpServer({ oauth: { issuer: PUBLIC_ORIGIN, resourceUrl: "http://127.0.0.1:43999/other" } }), /path/);
  assert.throws(() => createAiSkillsMcpHttpServer({ oauth: { issuer: "https://skills.example.test/path", resourceUrl: "https://skills.example.test/mcp" } }), /issuer/);
  assert.throws(() => createAiSkillsMcpHttpServer({ oauth: { issuer: "http://skills.example.test", resourceUrl: "http://skills.example.test/mcp" } }), /https/);
});

// --- fixture ------------------------------------------------------------------

async function startStack(t: { after(fn: () => unknown): void }) {
  const authStore = new MemoryAuthStore("closed");
  const skills: Array<PublicSkill & { ownerUserId?: string | null }> = [
    publicSkill("shared-public", "public", "user-alice"),
    publicSkill("alice-private", "private", "user-alice"),
    publicSkill("bob-private", "private", "user-bob"),
  ];
  const config = parseOAuthConfig({
    NODE_ENV: "production",
    MYSKILLS_OAUTH_ENABLED: "true",
    MYSKILLS_OAUTH_ISSUER: PUBLIC_ORIGIN,
    MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
    APP_BASE_URL: PUBLIC_ORIGIN,
    MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true",
    MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test",
  });
  assert.ok(config);
  const oauthService = new OAuthService({ store: new MemoryOAuthStore(authStore), authStore, config });
  const app = buildApp({
    skillRepository: new MemorySkillRepository(skills),
    authService: new AuthService(authStore, { oauthAccessTokens: oauthService }),
    submissionService: new SubmissionService(new MemorySubmissionStore()),
    oauthService,
    allowedOrigins: [PUBLIC_ORIGIN],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const mcp = createAiSkillsMcpHttpServer({ apiBaseUrl: apiBase, oauth: { issuer: PUBLIC_ORIGIN, resourceUrl: RESOURCE } });
  const mcpUrl = await listen(t, mcp);
  const mcpBase = mcpUrl.replace(/\/mcp$/, "");

  for (const [id, email, roles] of [
    ["user-alice", "alice@example.test", ["author"]],
    ["user-bob", "bob@example.test", ["author"]],
    ["user-owner", "owner@example.test", ["owner"]],
  ] as const) {
    authStore.addUser({ id, email, status: "active", emailVerifiedAt: new Date(), roles: [...roles], passwordHash: await hashPassword(PASSWORD) });
  }

  const login = async (email: string) => {
    const response = await fetch(`${apiBase}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    assert.equal(response.status, 200);
    return (await response.json()).token as string;
  };
  const owner = await ownerWithMfa(apiBase, login);
  await publish(apiBase, await login("alice@example.test"), owner, "shared-public", "public", "A public synthetic workflow.", "Shared public guidance.\n");
  await publish(apiBase, await login("alice@example.test"), owner, "alice-private", "private", "Alice's private synthetic workflow.", "Private note for Alice only.\n");
  await publish(apiBase, await login("bob@example.test"), owner, "bob-private", "private", "Bob's private synthetic workflow.", "Private note for Bob only.\n");

  const token = (fields: Record<string, string>) => fetch(`${apiBase}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  const connect = async (email: string, scope: string) => {
    const registered = await fetch(`${apiBase}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    assert.equal(registered.status, 201);
    const clientId = (await registered.json()).client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await fetch(`${apiBase}/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: `state-${email}`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: RESOURCE,
    })}`, { redirect: "manual" });
    assert.equal(authorize.status, 302);
    const consentUrl = new URL(authorize.headers.get("location")!);
    assert.equal(`${consentUrl.origin}${consentUrl.pathname}`, `${PUBLIC_ORIGIN}/connect/authorize`);
    const handle = new URLSearchParams(consentUrl.hash.slice(1)).get("request")!;
    const session = await login(email);
    const decision = await fetch(`${apiBase}/v1/oauth/consent/decision`, {
      method: "POST",
      headers: { ...bearer(session), "content-type": "application/json" },
      body: JSON.stringify({ request: handle, decision: "approve" }),
    });
    assert.equal(decision.status, 200);
    const callback = new URL((await decision.json()).redirectTo);
    assert.equal(callback.searchParams.get("state"), `state-${email}`);
    assert.equal(callback.searchParams.get("iss"), PUBLIC_ORIGIN);
    const exchanged = await token({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
    assert.equal(exchanged.status, 200);
    return { clientId, session, tokens: await exchanged.json() as { access_token: string; refresh_token: string } };
  };

  return { authStore, apiBase, mcpBase, mcpUrl, login, token, connect };
}

async function ownerWithMfa(apiBase: string, login: (email: string) => Promise<string>) {
  const setup = await login("owner@example.test");
  const enroll = await fetch(`${apiBase}/v1/auth/mfa/totp/enroll`, { method: "POST", headers: { ...bearer(setup), "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  const enrollment = (await enroll.json()).enrollment;
  const confirm = await fetch(`${apiBase}/v1/auth/mfa/totp/confirm`, { method: "POST", headers: { ...bearer(setup), "content-type": "application/json" }, body: JSON.stringify({ factorId: enrollment.factorId, code: generateTotpCode(enrollment.secret) }) });
  const recoveryCodes = (await confirm.json()).mfa.recoveryCodes as string[];
  const challenge = await (await fetch(`${apiBase}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: PASSWORD }) })).json();
  const verified = await fetch(`${apiBase}/v1/auth/mfa/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeToken: challenge.challengeToken, recoveryCode: recoveryCodes[0] }) });
  assert.equal(verified.status, 200);
  return (await verified.json()).token as string;
}

async function publish(apiBase: string, authorSession: string, ownerSession: string, slug: string, visibility: "public" | "private", description: string, note: string) {
  const manifest = {
    name: slug, title: slug, summary: description, version: "1.0.0", license: "MIT", visibility,
    platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["synthetic"],
  };
  const files = [
    { path: "skill.json", content: JSON.stringify(manifest) },
    { path: "SKILL.md", content: `---\nname: ${slug}\ndescription: ${description}\n---\nRead references/notes.md when needed.\n` },
    { path: "references/notes.md", content: note },
  ];
  const submitted = await fetch(`${apiBase}/v1/submissions`, { method: "POST", headers: { ...bearer(authorSession), "content-type": "application/json" }, body: JSON.stringify({ manifest, files }) });
  // Established submission contract: accepted for review (202), then approved and published.
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const id = (await submitted.json()).submission.id;
  const preview = await fetch(`${apiBase}/v1/review/submissions/${id}/bundle?platform=codex`, { headers: bearer(ownerSession) });
  assert.equal(preview.status, 200);
  const artifactSha256 = sha256(await preview.text());
  for (const payload of [{ action: "approve", artifactSha256 }, { action: "publish" }]) {
    const action = await fetch(`${apiBase}/v1/review/submissions/${id}/actions`, { method: "POST", headers: { ...bearer(ownerSession), "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal(action.status, 200, await action.clone().text());
  }
}

function publicSkill(slug: string, visibility: "public" | "private", ownerUserId: string): PublicSkill & { ownerUserId: string } {
  return {
    slug, title: slug, summary: `${slug} summary`, lifecycleStatus: "approved", visibility, latestVersion: "1.0.0",
    reviewStatus: "approved", securityStatus: "passed", platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    tags: ["synthetic"], ownerUserId,
  };
}

async function mcpClient(url: string, token: string) {
  const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

function postMcp(url: string, token: string | undefined) {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "1" } } }),
  });
}

function rawModern(url: string, token: string, method: string, params: Record<string, unknown>, skills = false) {
  return fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "oauth-e2e", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": skills ? { extensions: { "io.modelcontextprotocol/skills": {} } } : {},
        },
      },
    }),
  });
}

async function listen(t: { after(fn: () => unknown): void }, server: ReturnType<typeof createAiSkillsMcpHttpServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function bearer(token: string) { return { authorization: `Bearer ${token}` }; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
