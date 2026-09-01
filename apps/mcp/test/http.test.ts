import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAiSkillsMcpHttpServer, withRequestTimeout } from "../src/http.js";
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

test("HTTP MCP transport rejects oversized or whitespace-padded bearer headers before registry calls", async (t) => {
  const calls: string[] = [];
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, mcpSession());
    },
  });
  const url = await listen(t, server);

  const oversized = await postRaw(url, {
    authorization: `Bearer ${"a".repeat(600)}`,
    "content-type": "application/json",
  });
  const padded = await postRaw(url, {
    authorization: `Bearer ${" ".repeat(600)}aiss_test_secret`,
    "content-type": "application/json",
  });

  assert.equal(oversized.status, 401);
  assert.equal(padded.status, 401);
  assert.match(oversized.body, /requires a bearer API token/);
  assert.match(padded.body, /requires a bearer API token/);
  assert.deepEqual(calls, []);
});

test("HTTP MCP transport rate limits by socket IP by default and preserves health", async (t) => {
  const server = createAiSkillsMcpHttpServer({
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  const url = await listen(t, server);

  const first = await postRaw(url, {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.10",
  });
  const limited = await postRaw(url, {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.11",
  });
  const health = await fetch(new URL("/health", url));

  assert.equal(first.status, 401);
  assert.equal(limited.status, 429);
  assert.match(limited.body, /Too many MCP HTTP requests/);
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(health.status, 200);
});

test("HTTP MCP transport only trusts forwarded client IPs when proxy hops are explicit", async (t) => {
  const server = createAiSkillsMcpHttpServer({
    trustedProxyHops: 1,
    rateLimit: { maxRequests: 1, windowMs: 60_000, maxBuckets: 2 },
  });
  const url = await listen(t, server);

  const firstClient = await postRaw(url, {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.10",
  });
  const secondClient = await postRaw(url, {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.11",
  });
  const overflowLimited = await postRaw(url, {
    "content-type": "application/json",
    "x-forwarded-for": "203.0.113.12",
  });

  assert.equal(firstClient.status, 401);
  assert.equal(secondClient.status, 401);
  assert.equal(overflowLimited.status, 429);
});

test("HTTP MCP transport rejects declared and streamed oversized bodies before SDK parsing", async (t) => {
  const calls: string[] = [];
  const server = createAiSkillsMcpHttpServer({
    maxRequestBodyBytes: 64,
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse(200, mcpSession());
    },
  });
  const url = await listen(t, server);

  const declared = await postBody(url, {
    authorization: "Bearer aiss_test_secret",
    "content-type": "application/json",
  }, "x".repeat(65));
  assert.equal(declared.status, 413);
  assert.deepEqual(calls, []);

  const streamed = await postChunked(url, {
    authorization: "Bearer aiss_test_secret",
    "content-type": "application/json",
  }, ["{" + "x".repeat(40), "x".repeat(40) + "}"]);
  assert.equal(streamed.status, 413);
  assert.equal(calls.length, 1);
  assert.equal(streamed.body.includes("aiss_test_secret"), false);
});

test("HTTP MCP transport bounds headers and configures finite socket lifetimes", async (t) => {
  const server = createAiSkillsMcpHttpServer({
    maxHeaderBytes: 512,
    requestTimeoutMs: 2_000,
    headersTimeoutMs: 1_000,
    socketTimeoutMs: 500,
    keepAliveTimeoutMs: 250,
    maxHeadersCount: 16,
    maxRequestsPerSocket: 4,
    maxConnections: 8,
  });
  assert.equal(server.requestTimeout, 2_000);
  assert.equal(server.headersTimeout, 1_000);
  assert.equal(server.timeout, 500);
  assert.equal(server.keepAliveTimeout, 250);
  assert.equal(server.maxHeadersCount, 16);
  assert.equal(server.maxRequestsPerSocket, 4);
  assert.equal(server.maxConnections, 8);
  const url = await listen(t, server);

  const oversizedHeaders = await postRaw(url, {
    "content-type": "application/json",
    "x-oversized": "h".repeat(1_024),
  });
  assert.equal(oversizedHeaders.status, 431);
});

test("HTTP MCP transport closes slow partial-body sockets within the configured timeout", async (t) => {
  const server = createAiSkillsMcpHttpServer({
    socketTimeoutMs: 50,
    requestTimeoutMs: 500,
    headersTimeoutMs: 250,
    fetchImpl: async () => jsonResponse(200, mcpSession()),
  });
  const url = await listen(t, server);

  const elapsedMs = await slowPartialBodyClose(url);

  assert.ok(elapsedMs < 500, `expected socket close under 500ms, received ${elapsedMs}ms`);
});

test("HTTP MCP transport aborts stalled upstream authentication within its request timeout", async (t) => {
  let aborted = false;
  const server = createAiSkillsMcpHttpServer({
    socketTimeoutMs: 500,
    upstreamRequestTimeoutMs: 25,
    fetchImpl: async (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal?.reason);
      }, { once: true });
    }),
  });
  const url = await listen(t, server);
  const startedAt = Date.now();

  const response = await postRaw(url, {
    authorization: "Bearer aiss_test_secret",
    "content-type": "application/json",
  });

  assert.equal(response.status, 503);
  assert.match(response.body, /temporarily unavailable/);
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("HTTP MCP request timeout preserves caller cancellation", async () => {
  const caller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const fetchImpl: FetchLike = async (_url, init) => new Promise((_, reject) => {
    observedSignal = init?.signal;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
  const request = withRequestTimeout(fetchImpl, 1_000)("http://localhost/upstream", {
    signal: caller.signal,
  });

  caller.abort(new Error("caller cancelled"));

  await assert.rejects(request, /caller cancelled/);
  assert.equal(observedSignal?.aborted, true);
});

test("HTTP MCP transport awaits per-request MCP server cleanup", async (t) => {
  const originalClose = McpServer.prototype.close;
  let closeCount = 0;
  McpServer.prototype.close = async function closeWithCount() {
    closeCount += 1;
    return originalClose.call(this);
  };
  t.after(() => {
    McpServer.prototype.close = originalClose;
  });
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async () => jsonResponse(200, mcpSession()),
  });
  const url = await listen(t, server);
  const response = await postBody(url, {
    accept: "application/json, text/event-stream",
    authorization: "Bearer aiss_test_secret",
    "content-type": "application/json",
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cleanup-test", version: "1.0.0" },
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(closeCount, 1);
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
      ["get_architecture_projection", "get_install_instructions", "get_skill_info", "list_architecture_patterns", "list_architectures", "search_skills"],
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

test("HTTP MCP transport forwards architecture organization context end to end", async (t) => {
  const calls: Array<{ authorization?: string; url: string; method?: string; body?: string }> = [];
  const server = createAiSkillsMcpHttpServer({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body, authorization: init?.headers?.authorization });
      assert.equal(init?.headers?.authorization, "Bearer aiss_test_secret");
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession(["architectures:read"]));
      }
      if (url.endsWith("/v1/architectures/arch-1")) {
        return jsonResponse(200, {
          architecture: { id: "arch-1", name: "Personal", patternId: "flat" },
        });
      }
      assert.equal(url, "http://localhost:3001/v1/architectures/arch-1/preview");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(init?.body ?? "{}"), { organizationId: "org-1" });
      return jsonResponse(200, {
        preview: {
          revision: { architectureId: "arch-1", id: "revision-1", revisionNumber: 1 },
          topology: { nodes: [], edges: [] },
        },
      });
    },
  });
  const url = await listen(t, server);
  const client = new Client({ name: "mcp-http-architecture-test-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: "Bearer aiss_test_secret" },
    },
  });

  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "get_architecture_projection",
      arguments: { id: "arch-1", organizationId: "org-1" },
    });
    assert.equal(result.isError, undefined);
    const previewCalls = calls.filter((call) => call.url.endsWith("/v1/architectures/arch-1/preview"));
    assert.equal(previewCalls.length, 1);
    assert.deepEqual(JSON.parse(previewCalls[0]?.body ?? "{}"), { organizationId: "org-1" });
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
  assert.equal(getMcp.headers.get("connection"), "close");
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

async function postRaw(url: string, headers: Record<string, string>): Promise<{
  body: string;
  headers: Record<string, string | undefined>;
  status: number;
}> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  return postBody(url, headers, body);
}

async function postBody(url: string, headers: Record<string, string>, body: string): ReturnType<typeof postRaw> {
  const target = new URL(url);
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
      response.on("end", () => resolve({
        body: text,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : value === undefined ? undefined : String(value),
        ])),
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function postChunked(url: string, headers: Record<string, string>, chunks: string[]): ReturnType<typeof postRaw> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers,
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
      response.on("end", () => resolve({
        body: text,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : value === undefined ? undefined : String(value),
        ])),
        status: response.statusCode ?? 0,
      }));
    });
    request.on("error", reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}

async function slowPartialBodyClose(url: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = connectSocket({ host: target.hostname, port: Number(target.port) }, () => {
      socket.write([
        `POST ${target.pathname} HTTP/1.1`,
        `Host: ${target.host}`,
        "Authorization: Bearer aiss_test_secret",
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        "{",
      ].join("\r\n"));
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Date.now() - startedAt);
    };
    socket.on("close", finish);
    socket.on("end", finish);
    socket.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
        finish();
        return;
      }
      reject(error);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("Slow partial-body socket was not closed by the server."));
    });
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

function mcpSession(scopes: string[] = ["skills:read"]) {
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
      scopes,
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
