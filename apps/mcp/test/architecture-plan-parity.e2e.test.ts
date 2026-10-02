import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import { createArchitecturePlanFixture } from "../../api/test/fixtures/architecture-plan-fixture.js";

// Test first: SDK → MCP HTTP → real API. Preserve full review digest and retry
// identity. Invented apply fields must fail before forwarding. No real host proof.
test("MCP architecture plan actions retain exact input and explicit review approval", async (t) => {
  const fixture = await createArchitecturePlanFixture(t);
  const tokenResponse = await fixture.app.inject({ method: "POST", url: "/v1/auth/api-tokens", headers: { authorization: `Bearer ${fixture.sessions.owner}` }, payload: { name: "Synthetic plan parity", scopes: ["targets:read", "targets:control", "architectures:read"] } });
  assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
  let requests = 0;
  const server = createAiSkillsMcpHttpServer({ apiBaseUrl: "http://fixture.test", fetchImpl: async (url, init) => {
    // HTTP authenticates each SDK request before argument validation. Count
    // domain forwarding, not that required credential bootstrap.
    if (new URL(url).pathname !== "/v1/mcp/session") requests += 1;
    const response = await fixture.app.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: new URL(url).pathname + new URL(url).search, headers: init?.headers, ...(init?.body ? { payload: JSON.parse(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = new Client({ name: "architecture-plan-parity", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokenResponse.json().token.token}` } } }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === "architecture_plans_create")?.annotations?.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === "architecture_plans_get")?.annotations?.readOnlyHint, true);
  const args = { path: { id: fixture.target.id }, body: fixture.request };
  const created = await client.callTool({ name: "architecture_plans_create", arguments: args });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const run = (created.structuredContent as { run: { identity: { runId: string; revisionId: string }; metadata: { reviewDigest: string; canApply: boolean } } }).run;
  assert.equal(run.identity.revisionId, fixture.revision.id);
  assert.equal(run.metadata.canApply, false);
  const replay = await client.callTool({ name: "architecture_plans_create", arguments: args });
  assert.equal((replay.structuredContent as { run: { identity: { runId: string } } }).run.identity.runId, run.identity.runId);
  const listed = await client.callTool({ name: "architecture_plans_list", arguments: { path: { id: fixture.target.id }, query: { limit: 1 } } });
  assert.equal(listed.isError, undefined, JSON.stringify(listed));
  const shown = await client.callTool({ name: "architecture_plans_get", arguments: { path: { id: run.identity.runId } } });
  assert.equal(shown.isError, undefined, JSON.stringify(shown));
  const before = requests;
  const invented = await client.callTool({ name: "architecture_plans_approve", arguments: { path: { id: run.identity.runId }, body: { expectedReviewDigest: run.metadata.reviewDigest, apply: true } } });
  assert.equal(invented.isError, true);
  assert.equal(requests, before);
  const approved = await client.callTool({ name: "architecture_plans_approve", arguments: { path: { id: run.identity.runId }, body: { expectedReviewDigest: run.metadata.reviewDigest } } });
  assert.equal(approved.isError, undefined, JSON.stringify(approved));
  assert.equal((approved.structuredContent as { run: { state: string } }).run.state, "approved");
  t.diagnostic(JSON.stringify({ journey: "architecture-plan-mcp", namedActions: 4, exactInput: true, inventedApplyRejected: true, reviewApprovalOnly: true }));
});
