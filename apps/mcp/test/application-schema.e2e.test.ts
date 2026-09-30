import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import { APPLICATION_SCOPES } from "@myskills-app/core";

// Failure inventory before fixes: valid source ref kinds/root paths/provider
// mappings get rejected by the adapter; invented file encoding is silently
// forwarded; upstream errors leak payloads; oversized response bodies are read
// without limits. The API here is a transport contract fixture, not domain proof.
test("SDK application schemas preserve library source/root and provider contracts and reject invented encoding", async (t) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const server = createAiSkillsMcpHttpServer({ apiBaseUrl: "https://api.example.test", fetchImpl: async (url, init) => {
    if (url.endsWith("/v1/mcp/session")) return Response.json({ user: { id: "owner", email: "owner@example.test", name: "Owner", roles: ["owner"], emailVerified: true, mfaVerified: true }, credential: { kind: "api_token", tokenId: "synthetic", scopes: APPLICATION_SCOPES } });
    if (url.includes("/v1/review/submissions/")) {
      const raw = '{ "files": [{ "path": "SKILL.md", "content": "Verified review content" }] }\n';
      const hash = createHash("sha256").update(raw).digest("hex");
      const header = url.includes("corrupt") ? "0".repeat(64) : hash;
      return new Response(raw, { headers: url.includes("missing") ? {} : { "x-myskills-artifact-sha256": header } });
    }
    if (url.endsWith("/v1/teams/error/invitations")) return Response.json({ error: { code: "SECRET_CREDENTIAL_VALUE", message: "Bearer synthetic-sensitive-upstream-message", details: { password: "synthetic-secret" } } }, { status: 403 });
    if (url.endsWith("/v1/teams" ) && init?.method === "GET") return new Response(' {"oversize":"' + "x".repeat(600_000) + '"}');
    const body = init?.body ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    return Response.json({ accepted: true, ...(url.endsWith("/v1/submissions") ? { bytes: init?.body?.length } : { body }) });
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const client = new Client({ name: "schema-contract-e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: "Bearer synthetic-application-api-token" } } }));
  t.after(() => client.close());
  const calls = [
    ["libraries_create", { body: { name: "Personal default" } }],
    ["libraries_entries_create", { path: { libraryId: "library" }, body: { kind: "source", url: "https://github.com/example/skills", ref: { kind: "default-branch" } } }],
    ["libraries_entries_create", { path: { libraryId: "library" }, body: { kind: "source", url: "https://github.com/example/skills", ref: { kind: "tag-prefix", value: "v" } } }],
    ["library_entries_preview", { path: { entryId: "entry" }, body: { snapshotId: "snapshot", paths: ["", "skills/nested"] } }],
    ["admin_providers_upsert", { path: { key: "oidc" }, body: { type: "oidc", displayName: "Identity provider", roleMappings: [{ claim: "groups", value: "authors", role: "author" }] } }],
    ["targets_observations_list", { path: { id: "target" }, query: { limit: 500 } }],
    ["improvements_plans_create", { body: { request: {}, idempotencyKey: "_plan0001" } }],
    ["improvements_evidence_share", { path: { id: "run" }, body: { reportSha256: "a".repeat(64), disclosure: "summary", proposals: [], idempotencyKey: "-share001" } }],
    ["improvements_policy_set", { path: { scopeType: "user", scopeId: "owner" }, body: { policy: {}, expectedRevisionNumber: 0, reason: null } }],
    ["organizations_create", { body: { name: "Engineering", slug: "Platform Engineering" } }],
  ] as const;
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, `${name}: ${JSON.stringify(result)}`);
  }
  assert.equal(requests.length, 10);
  assert.deepEqual((requests[1].body as { ref: unknown }).ref, { kind: "default-branch" });
  assert.deepEqual((requests[3].body as { paths: string[] }).paths, ["", "skills/nested"]);
  assert.equal((await client.listTools()).tools.find(tool => tool.name === "library_entries_preview")?.annotations?.readOnlyHint, false);
  const invented = await client.callTool({ name: "submissions_create", arguments: { body: { files: [{ path: "SKILL.md", content: "ZmFrZQ==", encoding: "base64" }] } } });
  assert.equal(invented.isError, true);
  assert.equal(requests.length, 10);
  const large = await client.callTool({ name: "submissions_create", arguments: { body: { files: [{ path: "reference.md", content: "x".repeat(900_000) }] } } });
  assert.equal(large.isError, undefined, JSON.stringify(large));
  const archive = await client.callTool({ name: "submissions_create", arguments: { body: { archive: { filename: "package.zip", contentBase64: "x".repeat(13_000_000) } } } });
  assert.equal(archive.isError, undefined, JSON.stringify(archive));
  const exported = await client.callTool({ name: "review_submissions_export", arguments: { path: { id: "valid" } } });
  assert.equal(exported.isError, undefined, JSON.stringify(exported));
  assert.equal((exported.structuredContent as { artifact: { verification: string } }).artifact.verification, "response_header");
  for (const id of ["corrupt", "missing"]) {
    const rejected = await client.callTool({ name: "review_submissions_export", arguments: { path: { id } } });
    assert.equal(rejected.isError, true, id);
    assert.equal(JSON.stringify(rejected).includes("Verified review content"), false);
  }
  const upstream = await client.callTool({ name: "teams_invitations_create", arguments: { path: { id: "error" }, body: { email: "user@example.test" } } });
  assert.equal(upstream.isError, true);
  assert.equal(JSON.stringify(upstream).includes("synthetic-sensitive"), false);
  assert.equal(JSON.stringify(upstream).includes("SECRET_CREDENTIAL"), false);
  const oversized = await client.callTool({ name: "teams_list", arguments: {} });
  assert.equal(oversized.isError, true);
  assert.match(JSON.stringify(oversized), /API_RESPONSE_TOO_LARGE/);
});
