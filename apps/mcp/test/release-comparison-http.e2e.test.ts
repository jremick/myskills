import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { APPLICATION_SCOPES } from "@myskills-app/core";
import { createAiSkillsMcpHttpServer } from "../src/http.js";

test("MCP comparison returns complete comparison through exact API primitives and denies revoked or invalid pins", async t => {
  const payloads = new Map(["1.0.0", "2.0.0"].map(version => [version, { files: [{ path: "skill.json", content: JSON.stringify({ name: "compare", version }) }, { path: "SKILL.md", content: `# ${version}` }] }]));
  const sha = (version: string) => createHash("sha256").update(JSON.stringify(payloads.get(version))).digest("hex");
  const calls: string[] = []; let revoke = false; let revokeAt = 5;
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/session") { response.end(JSON.stringify({ credential: { kind: "oauth", grantId: "fixture", clientId: "fixture", scopes: [...APPLICATION_SCOPES], resource: "http://127.0.0.1:43998/mcp" } })); return; }
    calls.push(request.url!);
    if (revoke && calls.length === revokeAt) { response.statusCode = 401; response.end(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED", message: "PRIVATE-ERROR-CANARY" } })); return; }
    const version = request.url!.includes("1.0.0") ? "1.0.0" : "2.0.0", payload = payloads.get(version)!;
    if (request.url!.includes("/bundle")) response.setHeader("x-myskills-artifact-sha256", sha(version));
    if (request.url!.includes("/review/") && !request.url!.includes("/bundle")) { response.end(JSON.stringify({ submission: { id: "00000000-0000-4000-8000-000000000001", slug: "compare", version: "2.0.0" } })); return; }
    response.end(JSON.stringify(request.url!.includes("/bundle") ? payload : { release: { slug: "compare", version, reviewStatus: "approved", lifecycleStatus: "approved", publishedAt: "2026-10-01T00:00:00Z", artifact: { sha256: sha(version), byteSize: Buffer.byteLength(JSON.stringify(payload)) } } }));
  });
  await new Promise<void>(done => api.listen(0, "127.0.0.1", done)); t.after(() => new Promise<void>(done => api.close(() => done())));
  const mcp = createAiSkillsMcpHttpServer({ apiBaseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, oauth: { issuer: "http://127.0.0.1:43999", resourceUrl: "http://127.0.0.1:43998/mcp" } });
  await new Promise<void>(done => mcp.listen(0, "127.0.0.1", done)); t.after(() => new Promise<void>(done => mcp.close(() => done())));
  const client = new Client({ name: "comparison-transport", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: "Bearer fixture-token" } } })); t.after(() => client.close());
  assert.ok((await client.listTools()).tools.some(tool => tool.name === "skills_releases_compare"));
  const input = { base: { slug: "compare", version: "1.0.0", artifactSha256: sha("1.0.0") }, target: { slug: "compare", version: "2.0.0", artifactSha256: sha("2.0.0") } };
  const compared = await client.callTool({ name: "skills_releases_compare", arguments: input });
  assert.equal(compared.isError, undefined, JSON.stringify(compared)); assert.equal((compared.structuredContent as {totals:{modified:number}}).totals.modified, 2);
  assert.equal(calls.length, 6); assert.ok(calls[2]!.endsWith(`?sha256=${input.base.artifactSha256}`));
  calls.length = 0; revoke = true;
  const denied = await client.callTool({ name: "skills_releases_compare", arguments: input });
  assert.equal(denied.isError, true); assert.equal(denied.structuredContent, undefined); assert.equal(JSON.stringify(denied).includes("PRIVATE-ERROR-CANARY"), false);
  calls.length = 0; revoke = false;
  const invalid = await client.callTool({ name: "skills_releases_compare", arguments: { ...input, base: { ...input.base, artifactSha256: "f".repeat(64) } } });
  assert.equal(invalid.isError, true); assert.equal(calls.length, 1);
  calls.length = 0;
  const candidateInput = { ...input, target: { ...input.target, submissionId: "00000000-0000-4000-8000-000000000001" } };
  const reviewed = await client.callTool({ name: "review_submissions_compare", arguments: candidateInput });
  assert.equal(reviewed.isError, undefined, JSON.stringify(reviewed)); assert.equal((reviewed.structuredContent as {context:string}).context, "review-candidate"); assert.equal(calls.length, 7);
  calls.length = 0; revoke = true; revokeAt = 7;
  const lostReviewer = await client.callTool({ name: "review_submissions_compare", arguments: candidateInput });
  assert.equal(lostReviewer.isError, true); assert.equal(lostReviewer.structuredContent, undefined); assert.equal(JSON.stringify(lostReviewer).includes("PRIVATE-ERROR-CANARY"), false);
});
