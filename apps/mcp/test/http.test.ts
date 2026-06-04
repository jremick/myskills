import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import type { FetchLike } from "../src/api-client.js";

test("HTTP MCP transport rejects missing bearer tokens before registry calls", async (t) => {
  const calls: string[] = [];
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, {});
    },
  });
  const url = await listen(t, server);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const body = await response.text();

  assert.equal(response.status, 401);
  assert.match(body, /bearer API token/);
  assert.equal(body.includes("aiss_"), false);
  assert.deepEqual(calls, []);
});

test("HTTP MCP transport rejects invalid or session bearers before protocol initialization", async (t) => {
  const calls: Array<{ authorization?: string; url: string }> = [];
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init?.headers?.authorization });
      return jsonResponse(403, {
        error: {
          code: "API_TOKEN_AUTH_REQUIRED",
          message: "Bearer aiss_test_secret is not an MCP API token.",
        },
      });
    },
  });
  const url = await listen(t, server);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer aiss_test_secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const body = await response.text();

  assert.equal(response.status, 403);
  assert.match(body, /scoped API token/);
  assert.equal(body.includes("aiss_test_secret"), false);
  assert.deepEqual(calls, [
    { url: "http://localhost:3001/v1/mcp/session", authorization: "Bearer aiss_test_secret" },
  ]);
});

test("HTTP MCP transport executes tools with the request bearer token", async (t) => {
  const calls: Array<{ authorization?: string; url: string }> = [];
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init?.headers?.authorization });
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession());
      }
      assert.equal(url, "http://localhost:3001/v1/skills?q=release");
      return jsonResponse(200, { skills: [publicSkill()] });
    },
  });
  const url = await listen(t, server);
  const client = new Client({ name: "mcp-http-test-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: "Bearer aiss_test_secret" },
    },
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["get_install_instructions", "get_skill_info", "search_skills"],
    );

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "release" },
    });
    const text = JSON.stringify(result);

    assert.equal(result.isError, undefined);
    assert.equal(text.includes("release-notes-helper"), true);
    assert.equal(text.includes("aiss_test_secret"), false);
    assert.equal(text.includes("tokenHash"), false);
    assert.equal(calls.every((call) => call.authorization === "Bearer aiss_test_secret"), true);
    assert.equal(calls.some((call) => call.url.includes("aiss_test_secret")), false);
    assert.equal(calls.filter((call) => call.url.endsWith("/v1/mcp/session")).length >= 3, true);
    assert.equal(calls.filter((call) => call.url === "http://localhost:3001/v1/skills?q=release").length, 1);
  } finally {
    await client.close();
  }
});

test("HTTP MCP transport returns health and rejects non-POST MCP methods", async (t) => {
  const server = createAiSkillsMcpHttpServer();
  const url = await listen(t, server);

  const health = await fetch(new URL("/health", url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "myskills-app-mcp-http" });

  const getMcp = await fetch(url);
  assert.equal(getMcp.status, 405);
  assert.match(await getMcp.text(), /Method not allowed/);
});

test("HTTP MCP transport rejects untrusted Host and Origin before registry calls", async (t) => {
  const calls: string[] = [];
  const server = createAiSkillsMcpHttpServer({
    allowedHosts: ["allowed.test"],
    allowedOrigins: ["https://client.test"],
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, mcpSession());
    },
  });
  const url = await listen(t, server);

  const hostileHost = await postRaw(url, {
    authorization: "Bearer aiss_test_secret",
    host: "hostile.test",
    "content-type": "application/json",
  });
  assert.equal(hostileHost.status, 403);
  assert.match(hostileHost.body, /host is not allowed/);

  const hostileOrigin = await postRaw(url, {
    authorization: "Bearer aiss_test_secret",
    "content-type": "application/json",
    host: "allowed.test",
    origin: "https://hostile.test",
  });
  assert.equal(hostileOrigin.status, 403);
  assert.match(hostileOrigin.body, /origin is not allowed/);
  assert.equal(hostileOrigin.body.includes("aiss_test_secret"), false);

  assert.deepEqual(calls, []);
});

async function listen(t: { after(callback: () => void | Promise<void>): void }, server: ReturnType<typeof createAiSkillsMcpHttpServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return `http://127.0.0.1:${address!.port}/mcp`;
}

async function postRaw(url: string, headers: Record<string, string>): Promise<{ body: string; status: number }> {
  const target = new URL(url);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        ...headers,
        "content-length": String(Buffer.byteLength(body)),
      },
      hostname: target.hostname,
      method: "POST",
      path: target.pathname,
      port: Number(target.port),
    }, (response) => {
      response.setEncoding("utf8");
      let text = "";
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve({ body: text, status: response.statusCode ?? 0 }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function jsonResponse(status: number, body: Record<string, unknown>): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function mcpSession() {
  return {
    user: {
      id: "user-1",
      email: "reader@example.com",
      name: "Reader",
      roles: ["user"],
      emailVerified: true,
      mfaVerified: false,
    },
    credential: {
      kind: "api_token",
      tokenId: "token-1",
      scopes: ["skills:read"],
    },
  };
}

function publicSkill() {
  return {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    tags: ["release", "writing"],
  };
}
