import assert from "node:assert/strict";
import test from "node:test";
import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { runCli } from "../../cli/src/cli.js";
import { createAiSkillsMcpServer } from "../../mcp/src/server.js";
import { discoveryFixture } from "./fixtures/task-discovery.js";

// Authored before adapters. Protects CLI dispatch/arguments and actual MCP tool
// protocol/scope enforcement against the real API/domain fixture, not canned
// discovery responses. HTTP bytes use Fastify injection; this is local proof.
test("CLI and MCP retain exact API release identity and never mutate or execute", async t => {
  const f = await discoveryFixture(); t.after(() => f.app.close());
  const context = await f.authService.authenticateRequest(`Bearer ${f.token}`);
  assert.ok(context);
  const credential = await f.authService.createApiToken(context.user, { name: "Discovery adapter journey", scopes: ["skills:read"] });
  const requests: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const path = new URL(url).pathname + new URL(url).search;
    const method = (init?.method ?? "GET") as "GET" | "POST";
    requests.push({ path, method });
    const result = await f.app.inject({ url: path, method, headers: init?.headers, ...(init?.body ? { payload: init.body } : {}) });
    return new Response(result.body, { status: result.statusCode, headers: { "content-type": "application/json" } });
  };
  const stdout: string[] = []; const stderr: string[] = [];
  const runtime = { env: {}, fetch: fetchImpl, io: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) } };
  const task = "Review code for correctness and concurrency races";
  const api = (await f.request(task)).json();
  assert.equal(await runCli(["discover", task, "--limit", "3", "--api-url", "http://api.test", "--token", credential.token, "--json"], runtime), 0, stderr.join("\n"));
  assert.deepEqual(JSON.parse(stdout.pop()!), api);
  assert.equal(await runCli(["discover", task, "--limit", "500", "--api-url", "http://api.test", "--json"], runtime), 2);
  const server = createAiSkillsMcpServer({ token: credential.token, fetchImpl, apiBaseUrl: "http://api.test" });
  const client = new Client({ name: "discovery-journey", version: "1" });
  const a = new MemoryTransport(); const b = new MemoryTransport(); a.peer = b; b.peer = a;
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  const tool = tools.tools.find(row => row.name === "discover_skills");
  assert.ok(tool); assert.equal(tool.annotations?.readOnlyHint, true);
  const found = await client.callTool({ name: "discover_skills", arguments: { task, limit: 3 } });
  assert.notEqual(found.isError, true);
  assert.deepEqual(found.structuredContent, api);
  await f.authService.revokeApiToken(context.user, credential.id);
  const denied = await client.callTool({ name: "discover_skills", arguments: { task } });
  assert.equal(denied.isError, true);
  assert.ok(requests.every(r => r.method === "GET" || r.path === "/v1/skills/discover"));
  assert.ok(!requests.some(r => /install|targets|bundle|execution/.test(r.path)));
});

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  async start() {}
  async send(message: JSONRPCMessage) { queueMicrotask(() => this.peer?.onmessage?.(message)); }
  async close() { this.onclose?.(); }
}
