import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createAiSkillsMcpHttpServer } from "../src/http.js";

// Failure ledger before implementation: schema omits a named action or required
// revision, truncates ordered members/retry keys/cursors, accepts invented proxy
// fields, bypasses consent scopes, or hides known server conflicts as API_ERROR.
// Real MCP SDK/HTTP with an API contract fixture; no host/persistence claims.
for (const kind of ["api_token", "oauth"] as const) test(`MCP ${kind} collection/group contract retains bounded inputs, pages, scopes and errors`, async (t) => {
  const requests: Array<{ method: string; pathname: string; query: Record<string, string>; body: unknown }> = [];
  let scopes = ["libraries:read", "libraries:write"];
  let failure: { code: string; status: number } | undefined;
  const server = createAiSkillsMcpHttpServer({ apiBaseUrl: "https://api.example.test", oauth: { issuer: "https://api.example.test", resourceUrl: "https://mcp.example.test/mcp" }, fetchImpl: async (url, init) => {
    if (url.endsWith("/v1/mcp/session")) return Response.json({ user: { id: "owner", email: "owner@example.test", name: "Owner", roles: ["owner"], emailVerified: true, mfaVerified: true }, credential: { kind, tokenId: "synthetic", grantId: "synthetic", clientId: "synthetic", resource: "https://mcp.example.test/mcp", scopes } });
    const parsed = new URL(url);
    requests.push({ method: init?.method ?? "GET", pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init?.body ? JSON.parse(init.body) : null });
    if (failure) return Response.json({ error: { code: failure.code, message: "synthetic-sensitive-message", details: { credential: "synthetic-sensitive-value" } } }, { status: failure.status });
    return Response.json({ accepted: true, nextCursor: "opaque+/cursor=", replayed: init?.method === "POST" });
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new Client({ name: "selection-contract", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { authorization: "Bearer synthetic-selection-token" } } }));
  t.after(() => client.close());
  const catalog = (await client.listTools()).tools;
  for (const entity of ["collection", "group"]) {
    const plural = `${entity}s`, id = `${entity}-a`, parameter = `${entity}Id`;
    const create = { name: `Reviewed ${entity}`, description: "Ordered", memberEntryIds: ["entry-b", "entry-a"], clientMutationId: `_${entity}:retry-1` };
    const update = { expectedRevision: 7, memberEntryIds: ["entry-a", "entry-b"] };
    const cases = [
      { name: `libraries_${plural}_list`, args: { path: { libraryId: "library-a" }, query: { limit: 1, cursor: "opaque+/cursor=" } }, method: "GET", pathname: `/v1/libraries/library-a/${plural}` },
      { name: `library_${plural}_get`, args: { path: { [parameter]: id } }, method: "GET", pathname: `/v1/library-${plural}/${id}` },
      { name: `library_${plural}_members_list`, args: { path: { [parameter]: id }, query: { limit: 100, cursor: "opaque+/members=" } }, method: "GET", pathname: `/v1/library-${plural}/${id}/members` },
      { name: `libraries_${plural}_create`, args: { path: { libraryId: "library-a" }, body: create }, method: "POST", pathname: `/v1/libraries/library-a/${plural}` },
      { name: `libraries_${plural}_create`, args: { path: { libraryId: "library-a" }, body: create }, method: "POST", pathname: `/v1/libraries/library-a/${plural}` },
      { name: `library_${plural}_update`, args: { path: { [parameter]: id }, body: update }, method: "PATCH", pathname: `/v1/library-${plural}/${id}` },
      { name: `library_${plural}_update`, args: { path: { [parameter]: id }, body: { expectedRevision: 8, memberEntryIds: [] } }, method: "PATCH", pathname: `/v1/library-${plural}/${id}` },
      { name: `library_${plural}_delete`, args: { path: { [parameter]: id }, query: { expectedRevision: 9 } }, method: "DELETE", pathname: `/v1/library-${plural}/${id}` },
    ];
    for (const step of cases) {
      const tool = catalog.find((item) => item.name === step.name);
      assert.ok(tool, step.name);
      assert.equal(tool.annotations?.readOnlyHint, step.method === "GET");
      assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [step.method === "GET" ? "libraries:read" : "libraries:write"] }]);
      const result = await client.callTool({ name: step.name, arguments: step.args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent?.nextCursor, "opaque+/cursor=");
      assert.deepEqual(requests.at(-1), { method: step.method, pathname: step.pathname, query: Object.fromEntries(Object.entries(step.args.query ?? {}).map(([key, value]) => [key, String(value)])), body: step.args.body ?? null });
    }
    const before = requests.length;
    const invalid = [
      ...[undefined, 0, 1.5, 9007199254740992].flatMap((revision) => [
        { name: `library_${plural}_delete`, args: { path: { [parameter]: id }, ...(revision === undefined ? {} : { query: { expectedRevision: revision } }) } },
        { name: `library_${plural}_update`, args: { path: { [parameter]: id }, body: { memberEntryIds: [], ...(revision === undefined ? {} : { expectedRevision: revision }) } } },
      ]),
      { name: `libraries_${plural}_list`, args: { path: { libraryId: "library-a" }, query: { limit: 101 } } },
      { name: `libraries_${plural}_create`, args: { path: { libraryId: "library-a" }, body: { ...create, memberEntryIds: Array.from({ length: 201 }, (_, index) => `entry-${index}`) } } },
      { name: `libraries_${plural}_create`, args: { path: { libraryId: "library-a" }, body: create, method: "DELETE" } },
    ];
    for (const step of invalid) assert.equal((await client.callTool({ name: step.name, arguments: step.args })).isError, true, JSON.stringify(step));
    assert.equal(requests.length, before);
    for (const code of [`LIBRARY_${entity.toUpperCase()}_NOT_FOUND`, `LIBRARY_${entity.toUpperCase()}_REVISION_CONFLICT`, "LIBRARY_SELECTION_MEMBER_INVALID", "LIBRARY_SELECTION_LIMIT_EXCEEDED", "CLIENT_MUTATION_ID_CONFLICT", "LIBRARY_WRITE_FORBIDDEN", "MFA_VERIFICATION_REQUIRED", "INVALID_REQUEST_BODY"]) {
      failure = { code, status: code.includes("CONFLICT") ? 409 : 403 };
      const result = await client.callTool({ name: `library_${plural}_update`, arguments: { path: { [parameter]: id }, body: update } });
      assert.equal(result.isError, true);
      assert.deepEqual((result.structuredContent?.error as { code: string; status: number }).code, code);
      assert.equal((result.structuredContent?.error as { status: number }).status, failure.status);
      assert.equal(JSON.stringify(result).includes("synthetic-sensitive"), false);
    }
    // A member page cursor from an earlier revision must tell the caller to
    // restart pagination; collapsing the API code loses that recovery signal.
    failure = { code: "INVALID_PAGE_CURSOR", status: 400 };
    const stalePage = await client.callTool({ name: `library_${plural}_members_list`, arguments: { path: { [parameter]: id }, query: { limit: 100, cursor: "opaque+/stale-members=" } } });
    assert.equal(stalePage.isError, true);
    assert.equal((stalePage.structuredContent?.error as { code: string }).code, "INVALID_PAGE_CURSOR");
    assert.equal((stalePage.structuredContent?.error as { status: number }).status, 400);
    assert.equal(stalePage.structuredContent?.nextCursor, undefined);
    assert.equal(JSON.stringify(stalePage).includes("synthetic-sensitive"), false);
    failure = undefined;
  }
  scopes = ["libraries:read"];
  const before = requests.length;
  // API tokens return tool errors; OAuth may reject at the protocol challenge.
  try {
    const denied = await client.callTool({ name: "libraries_collections_create", arguments: { path: { libraryId: "library-a" }, body: { name: "Denied", memberEntryIds: [] } } });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /API_TOKEN_SCOPE_REQUIRED/);
  } catch (error) { assert.equal(kind, "oauth"); assert.match(String(error), /403|scope/i); }
  assert.equal(requests.length, before);
  t.diagnostic("Repeat: node --import tsx --test apps/mcp/test/library-selections.e2e.test.ts; API fixture, no deployed/host proof.");
});
