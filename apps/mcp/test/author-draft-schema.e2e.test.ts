import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { APPLICATION_SCOPES } from "@myskills-app/core";
import { createAiSkillsMcpHttpServer } from "../src/http.js";

// Failure inventory before production implementation: tools disappear from
// discovery, draft body unions strip invented authority, source forks fail to
// challenge for additional consent, numeric revisions alter routes, legal 1 MiB
// text responses hit the 512 KiB metadata cap, mutable snapshots acquire artifact
// wrappers, release metadata/queued scan status are lost, or errors echo content.
// Real SDK -> MCP socket -> API socket. API is a transport contract fixture only.
const RESOURCE = "http://127.0.0.1:43999/mcp";
const files = [{ path: "skill.json", content: "{incomplete}\n" }, { path: "SKILL.md", content: "作者\n\"quoted\"\t" + "large text\n".repeat(60_000) }, { path: "LICENSE", content: "Apache-2.0\n" }];

test("SDK draft tools preserve package bytes, strict unions, revisions, API errors and read-only annotations", async (t) => {
  const f = await fixture(t);
  const client = await f.client("all");
  const tools = (await client.listTools()).tools;
  for (const name of ["list", "get", "create", "update", "history", "revision", "validate", "preview", "submit"]) assert.ok(tools.find(tool => tool.name === `draft_${name}`), `missing draft_${name}`);
  for (const name of ["list", "get", "history", "revision", "validate", "preview"]) assert.equal(tools.find(tool => tool.name === `draft_${name}`)?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === "draft_submit")?.annotations?.readOnlyHint, false);
  const calls = [
    ["draft_list", {}, "GET", "/v1/drafts", null],
    ["draft_create", { body: { title: "Incomplete package", files } }, "POST", "/v1/drafts", { title: "Incomplete package", files }],
    ["draft_create", { body: { source: { kind: "release", slug: "workflow", version: "1.0.0", platform: "codex" } } }, "POST", "/v1/drafts", { source: { kind: "release", slug: "workflow", version: "1.0.0", platform: "codex" } }],
    ["draft_create", { body: { title: "Correction", source: { kind: "submission", submissionId: "submission-1" } } }, "POST", "/v1/drafts", { title: "Correction", source: { kind: "submission", submissionId: "submission-1" } }],
    ["draft_get", { path: { id: "draft-1" } }, "GET", "/v1/drafts/draft-1", null],
    ["draft_update", { path: { id: "draft-1" }, body: { expectedRevision: 7, title: "Saved", files } }, "PUT", "/v1/drafts/draft-1", { expectedRevision: 7, title: "Saved", files }],
    ["draft_history", { path: { id: "draft-1" } }, "GET", "/v1/drafts/draft-1/history", null],
    ["draft_revision", { path: { id: "draft-1", revision: "7" } }, "GET", "/v1/drafts/draft-1/revisions/7", null],
    ["draft_validate", { path: { id: "draft-1" }, body: { expectedRevision: 7 } }, "POST", "/v1/drafts/draft-1/validate", { expectedRevision: 7 }],
    ["draft_preview", { body: { files } }, "POST", "/v1/drafts/preview", { files }],
    ["draft_preview", { body: { archive: { filename: "package.zip", contentBase64: "UEsDBA==" } } }, "POST", "/v1/drafts/preview", { archive: { filename: "package.zip", contentBase64: "UEsDBA==" } }],
  ] as const;
  for (const [name, args, method, url, body] of calls) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(f.requests.at(-1), { method, url, body });
    if (["draft_create", "draft_get", "draft_update", "draft_revision", "draft_preview"].includes(name)) {
      const content = result.structuredContent as { draft?: { files: unknown }; preview?: { files: unknown } };
      assert.deepEqual(content.draft?.files ?? content.preview?.files, files);
      assert.equal("artifact" in result.structuredContent!, false, "mutable drafts are not immutable artifact exports");
    }
  }
  const body = { expectedRevision: 7, release: { releaseNotes: "Correct setup.\n", changeKind: "fix", requiresUserAction: true, compatibility: { minimumMyskillsVersion: "0.1.0", minimumAdapterContractVersion: 2, minimumSourceVersion: "1.0.0" } } };
  const submitted = await client.callTool({ name: "draft_submit", arguments: { path: { id: "draft-1" }, body } });
  assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
  assert.deepEqual(f.requests.at(-1), { method: "POST", url: "/v1/drafts/draft-1/submit", body });
  const receipt = submitted.structuredContent as { submission: { securityStatus: string; scan: { status: string } } };
  assert.equal(receipt.submission.securityStatus, "not-run");
  assert.equal(receipt.submission.scan.status, "queued");
  const invalid = [
    ["draft_create", { body: { title: "One", files: [], owner: { type: "team", id: "other" } } }],
    ["draft_create", { body: { title: "One", files: [{ path: "SKILL.md", content: "x", encoding: "base64" }] } }],
    ["draft_create", { body: { source: { kind: "release", slug: "workflow", version: "1.0.0", artifactSha256: "invented" } } }],
    ["draft_create", { body: { title: "One", files: [], source: { kind: "submission", submissionId: "one" } } }],
    ["draft_preview", { body: { files, archive: { contentBase64: "UEsDBA==" } } }],
    ["draft_preview", { body: { archive: { contentBase64: "%%%=" } } }],
    ["draft_update", { path: { id: "draft-1" }, body: { expectedRevision: 0, title: "One", files } }],
    ["draft_update", { path: { id: "draft-1" }, body: { expectedRevision: Number.MAX_SAFE_INTEGER + 1, title: "One", files } }],
    ["draft_validate", { path: { id: "../escape" }, body: { expectedRevision: 7 } }],
    ...["0", "1.2", "1e2", "9007199254740992", "../7"].map(revision => ["draft_revision", { path: { id: "draft-1", revision } }]),
    ["draft_create", { body: { title: "One", files: [{ path: "SKILL.md", content: "é".repeat(600_000) }] } }],
    ["draft_submit", { path: { id: "draft-1" }, body: { expectedRevision: 7, visibility: "public" } }],
  ] as Array<[string, Record<string, unknown>]>;
  for (const [name, args] of invalid) {
    const before = f.requests.length;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.equal(f.requests.length, before, "invalid arguments never reach the API fixture");
  }
  for (const [id, code] of [["foreign", "DRAFT_NOT_FOUND"], ["stale", "DRAFT_REVISION_CONFLICT"], ["denied", "SUBMISSION_ROLE_REQUIRED"], ["unknown", "API_ERROR"]]) {
    const result = await client.callTool({ name: "draft_validate", arguments: { path: { id }, body: { expectedRevision: 7 } } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, code);
    assert.equal(JSON.stringify(result).includes("synthetic-sensitive-content"), false);
  }
});

test("SDK source forks remain discoverable and challenge for their additional read scopes", async (t) => {
  const f = await fixture(t);
  const author = await f.client("author");
  const tool = (await author.listTools()).tools.find(tool => tool.name === "draft_create");
  assert.ok(tool);
  assert.match(tool.description!, /skills:read/);
  assert.match(tool.description!, /submissions:read/);
  for (const [source, scope] of [[{ kind: "release", slug: "workflow", version: "1.0.0" }, "skills:read"], [{ kind: "submission", submissionId: "one" }, "submissions:read"]] as const) {
    const before = f.requests.length;
    const response = await f.raw("author", "draft_create", { body: { source } });
    assert.equal(response.status, 403, await response.clone().text());
    assert.match(response.headers.get("www-authenticate") ?? "", new RegExp(`scope="skills:submit ${scope}"`));
    assert.equal(f.requests.length, before);
  }
  const created = await author.callTool({ name: "draft_create", arguments: { body: { title: "Local", files } } });
  assert.equal(created.isError, undefined, JSON.stringify(created));
});

async function fixture(t: TestContext) {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const api = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/mcp/session") {
      const scopes = request.headers.authorization === "Bearer author" ? ["skills:submit"] : [...APPLICATION_SCOPES];
      response.end(JSON.stringify({ credential: { kind: "oauth", grantId: "synthetic", clientId: "fixture", scopes, resource: RESOURCE } }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method!, url: request.url!, body: text ? JSON.parse(text) : null });
    const error = request.url?.match(/\/(foreign|stale|denied|unknown)\//)?.[1];
    if (error) {
      response.statusCode = error === "foreign" ? 404 : error === "stale" ? 409 : 403;
      response.end(JSON.stringify({ error: { code: error === "foreign" ? "DRAFT_NOT_FOUND" : error === "stale" ? "DRAFT_REVISION_CONFLICT" : error === "denied" ? "SUBMISSION_ROLE_REQUIRED" : "synthetic-sensitive-content", message: "synthetic-sensitive-content", details: { content: "synthetic-sensitive-content" } } }));
    } else if (request.url?.endsWith("/history")) response.end(JSON.stringify({ revisions: [{ id: "draft-1", revision: 7 }] }));
    else if (request.url?.endsWith("/validate")) response.end(JSON.stringify({ validation: { valid: false, manifest: null, issues: [{ code: "INVALID_MANIFEST", message: "Incomplete" }], findings: [] } }));
    else if (request.url?.endsWith("/submit")) response.end(JSON.stringify({ draft: { id: "draft-1", revision: 7 }, submission: { id: "submission-1", securityStatus: "not-run", scan: { status: "queued", findings: [], findingCount: 0 } } }));
    else if (request.url === "/v1/drafts" && request.method === "GET") response.end(JSON.stringify({ drafts: [{ id: "draft-1", revision: 7 }] }));
    else if (request.url === "/v1/drafts/preview") response.end(JSON.stringify({ preview: { files, fileCount: files.length } }));
    else response.end(JSON.stringify({ draft: { id: "draft-1", revision: 7, files } }));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => api.close(() => resolve())));
  const mcp = createAiSkillsMcpHttpServer({ apiBaseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, oauth: { issuer: "http://127.0.0.1:43999", resourceUrl: RESOURCE } });
  await new Promise<void>(resolve => mcp.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => mcp.close(() => resolve())));
  const url = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  return { requests,
    async client(token: string) { const client = new Client({ name: "author-draft-transport-fixture", version: "1" }); await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); t.after(() => client.close()); return client; },
    raw: (token: string, name: string, args: Record<string, unknown>) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "author-draft-transport-fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }),
  };
}
