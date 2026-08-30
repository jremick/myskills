import test from "node:test";
import assert from "node:assert/strict";
import { createRegistryApiClient, type FetchLike } from "../src/api-client.js";
import { createAiSkillsMcpHandlers } from "../src/tools.js";

test("missing MCP token fails before registry requests", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const client = createRegistryApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init?.headers?.authorization });
      return jsonResponse(200, {});
    },
  });

  const result = await createAiSkillsMcpHandlers(client).searchSkills({ query: "release" });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /skills:read/);
  assert.deepEqual(calls, []);
});

test("search forwards bearer token through MCP auth and registry requests only", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init?.headers?.authorization });
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession());
      }
      assert.equal(url, "http://localhost:3001/v1/skills?q=release&limit=2");
      return jsonResponse(200, { skills: [publicSkill()] });
    },
  });

  const result = await createAiSkillsMcpHandlers(client).searchSkills({ query: "release", limit: 2 });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.map((call) => call.authorization), ["Bearer aiss_test_secret", "Bearer aiss_test_secret"]);
  assert.equal(calls.some((call) => call.url.includes("aiss_test_secret")), false);
  assert.equal(JSON.stringify(result).includes("aiss_test_secret"), false);
  assert.equal(JSON.stringify(result).includes("tokenHash"), false);
  assert.deepEqual(result.structuredContent?.count, 1);
});

test("install instructions never fetch or expose bundle package contents", async () => {
  const calls: string[] = [];
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url, init) => {
      assert.equal(init?.headers?.authorization, "Bearer aiss_test_secret");
      calls.push(url);
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession());
      }
      if (url.endsWith("/v1/skills/release-notes-helper")) {
        return jsonResponse(200, { skill: publicSkill() });
      }
      if (url.endsWith("/v1/skills/release-notes-helper/releases/0.1.0")) {
        return jsonResponse(200, {
          release: {
            ...publicRelease(),
            storageKey: "private/storage/key",
            payload: { files: [{ path: "README.md", content: "secret package text" }] },
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const result = await createAiSkillsMcpHandlers(client).getInstallInstructions({
    slug: "release-notes-helper",
    platform: "codex",
  });
  const text = JSON.stringify(result);

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/skills/release-notes-helper",
    "http://localhost:3001/v1/skills/release-notes-helper/releases/0.1.0",
  ]);
  assert.equal(calls.some((url) => url.includes("/bundle")), false);
  assert.match(text, /myskills install 'release-notes-helper' --version '0\.1\.0' --platform 'codex'/);
  assert.match(text, /myskills export 'release-notes-helper' --version '0\.1\.0' --platform 'codex'/);
  assert.match(text, /packageContentsReturned/);
  assert.equal(text.includes("storageKey"), false);
  assert.equal(text.includes("payload"), false);
  assert.equal(text.includes("files"), false);
  assert.equal(text.includes("secret package text"), false);
});

test("install instructions only select supported platforms", async () => {
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession());
      }
      if (url.endsWith("/v1/skills/release-notes-helper")) {
        return jsonResponse(200, { skill: publicSkill() });
      }
      if (url.endsWith("/v1/skills/release-notes-helper/releases/0.1.0")) {
        return jsonResponse(200, {
          release: {
            ...publicRelease(),
            platforms: [
              { name: "codex", installTarget: "codex-skill", status: "planned" },
              { name: "generic", installTarget: "generic-bundle", status: "supported" },
            ],
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  const selected = await createAiSkillsMcpHandlers(client).getInstallInstructions({
    slug: "release-notes-helper",
  });
  assert.equal(selected.isError, undefined);
  assert.match(JSON.stringify(selected), /--platform 'generic'/);
  assert.equal(JSON.stringify(selected).includes("--platform 'codex'"), false);

  const unsupported = await createAiSkillsMcpHandlers(client).getInstallInstructions({
    slug: "release-notes-helper",
    platform: "codex",
  });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0]?.text ?? "", /not supported/);
});

test("upstream denial errors are sanitized", async () => {
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async () => jsonResponse(403, {
      error: {
        code: "API_TOKEN_SCOPE_REQUIRED",
        message: "scope missing for Bearer aiss_test_secret /private/path storageKey secret package text",
      },
    }),
  });

  const result = await createAiSkillsMcpHandlers(client).getSkillInfo({ slug: "release-notes-helper" });
  const text = JSON.stringify(result);

  assert.equal(result.isError, true);
  assert.match(text, /skills:read/);
  assert.equal(text.includes("aiss_test_secret"), false);
  assert.equal(text.includes("/private/path"), false);
  assert.equal(text.includes("storageKey"), false);
  assert.equal(text.includes("secret package text"), false);
});

test("missing, private, and unsafe skill responses remain indistinguishable", async () => {
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession());
      }
      return jsonResponse(404, {
        error: {
          code: "SKILL_NOT_FOUND",
          message: "Private helper exists but is hidden.",
        },
      });
    },
  });

  const result = await createAiSkillsMcpHandlers(client).getSkillInfo({ slug: "private-helper" });
  const text = JSON.stringify(result);

  assert.equal(result.isError, true);
  assert.match(text, /Skill or release not found/);
  assert.equal(text.includes("Private helper"), false);
  assert.equal(text.includes("private-helper"), false);
});

test("architecture tools forward auth and expose only safe owner projections", async () => {
  const calls: Array<{ url: string; method?: string; authorization?: string; body?: string }> = [];
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method, authorization: init?.headers?.authorization, body: init?.body });
      assert.equal(init?.headers?.authorization, "Bearer aiss_test_secret");
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession(["skills:read", "architectures:read"]));
      }
      if (url.endsWith("/v1/architecture-patterns")) {
        return jsonResponse(200, {
          patterns: [{
            id: "multi-level-router",
            name: "Multi-level routers",
            description: "Nested routers and skill leaves.",
            storageKey: "private-pattern-key",
            path: "/private/pattern.json",
          }],
        });
      }
      if (url.endsWith("/v1/architectures")) {
        return jsonResponse(200, {
          architectures: [{
            id: "arch-1",
            name: "Personal skills",
            patternId: "multi-level-router",
            ownerUserId: "user-1",
            spec: { path: "/private/spec.json", content: "secret spec" },
          }],
        });
      }
      if (url.endsWith("/v1/architectures/arch-1")) {
        return jsonResponse(200, {
          architecture: {
            id: "arch-1",
            name: "Personal skills",
            patternId: "multi-level-router",
            ownerUserId: "user-1",
            spec: { path: "/private/spec.json", content: "secret spec" },
          },
        });
      }
      if (url.endsWith("/v1/architectures/arch-1/preview")) {
        return jsonResponse(200, {
          revision: {
            id: "revision-1",
            architectureId: "arch-1",
            revisionNumber: 3,
            message: "Nested router revision",
            createdAt: "2026-08-30T00:00:00.000Z",
            createdByUserId: "user-1",
            spec: { path: "/private/spec.json", content: "secret spec" },
          },
          graph: {
            digest: "graph-digest",
            nodes: [{ id: "root", kind: "router", label: "Root", x: 0, y: 0, path: "/private/root" }],
            edges: [{ from: "root", to: "leaf", kind: "contains", content: "not allowed" }],
            mermaid: "flowchart TD\n  root[Root]",
            path: "/private/graph.json",
          },
          outline: {
            title: "Architecture arch-1",
            text: "Root",
            tree: [{ id: "root", kind: "router", label: "Root", path: "/private/root", children: [{ id: "leaf", content: "not allowed" }] }],
            path: "/private/outline.json",
          },
          compiled: {
            schemaVersion: 1,
            pattern: { id: "multi-level-router" },
            skills: [{ slug: "release-notes-helper", version: "0.1.0", content: "secret package text" }],
            runtimeBundle: { files: [{ path: "SKILL.md", content: "secret package text" }] },
          },
          plan: {
            dryRun: true,
            canApply: false,
            requiresApproval: true,
            targetId: "fixture-target",
            revisionDigest: "revision-digest",
            items: [{
              action: "install",
              nodeId: "leaf",
              kind: "leaf",
              reason: "Desired skill is absent from the target.",
              desired: { version: "0.1.0", digest: "skill-digest", enabled: true, path: "/private/desired" },
              observed: { metadata: { content: "not allowed" } },
              path: "/private/plan-item",
            }],
            files: [{ path: "SKILL.md", content: "secret package text" }],
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });
  const handlers = createAiSkillsMcpHandlers(client);

  const patterns = await handlers.listArchitecturePatterns();
  const architectures = await handlers.listArchitectures();
  const projection = await handlers.getArchitectureProjection({
    id: "arch-1",
    profileId: "personal",
    environmentId: "local",
    revisionId: "revision-1",
  });

  assert.equal(patterns.isError, undefined);
  assert.equal(architectures.isError, undefined);
  assert.equal(projection.isError, undefined);
  const combined = JSON.stringify({ patterns, architectures, projection });
  assert.match(combined, /multi-level-router/);
  assert.match(combined, /release-notes-helper/);
  assert.equal(combined.includes("private-pattern-key"), false);
  assert.equal(combined.includes("ownerUserId"), false);
  assert.equal(combined.includes("/private/"), false);
  assert.equal(combined.includes("secret spec"), false);
  assert.equal(combined.includes("secret package text"), false);
  assert.equal(combined.includes("runtimeBundle"), false);
  assert.equal(combined.includes("/private/graph.json"), false);
  assert.equal(combined.includes("/private/outline.json"), false);
  assert.equal(combined.includes("/private/plan-item"), false);
  assert.equal(combined.includes("files"), false);
  const safePreview = projection.structuredContent?.preview as Record<string, unknown>;
  assert.equal(safePreview.architectureId, "arch-1");
  assert.equal(safePreview.revisionId, "revision-1");
  assert.equal(safePreview.revisionNumber, 3);
  assert.equal("revision" in safePreview, false);
  assert.deepEqual(safePreview.graph, {
    digest: "graph-digest",
    nodes: [{ id: "root", kind: "router", label: "Root", x: 0, y: 0 }],
    edges: [{ from: "root", to: "leaf", kind: "contains" }],
    mermaid: "flowchart TD\n  root[Root]",
  });
  assert.deepEqual(safePreview.outline, [{ id: "root", kind: "router", label: "Root", children: [{ id: "leaf" }] }]);
  assert.deepEqual(safePreview.plan, {
    dryRun: true,
    canApply: false,
    requiresApproval: true,
    targetId: "fixture-target",
    revisionDigest: "revision-digest",
    items: [{
      action: "install",
      nodeId: "leaf",
      kind: "leaf",
      reason: "Desired skill is absent from the target.",
      desired: { version: "0.1.0", digest: "skill-digest", enabled: true },
      observed: {},
    }],
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/architecture-patterns",
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/architectures",
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/architectures/arch-1",
    "http://localhost:3001/v1/architectures/arch-1/preview",
  ]);
  const previewCall = calls.at(-1);
  assert.equal(previewCall?.method, "POST");
  assert.deepEqual(JSON.parse(previewCall?.body ?? "{}"), {
    profileId: "personal",
    environmentId: "local",
    revisionId: "revision-1",
  });
});

test("architecture tools deny tokens without architectures:read after MCP authentication", async () => {
  const calls: string[] = [];
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url) => {
      calls.push(url);
      assert.equal(url, "http://localhost:3001/v1/mcp/session");
      return jsonResponse(200, mcpSession());
    },
  });
  const handlers = createAiSkillsMcpHandlers(client);

  const patterns = await handlers.listArchitecturePatterns();
  const architectures = await handlers.listArchitectures();
  const projection = await handlers.getArchitectureProjection({ id: "arch-1" });

  for (const result of [patterns, architectures, projection]) {
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: "text", text: "MCP architecture tools require an API token with architectures:read scope." }]);
  }
  assert.deepEqual(calls, [
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/mcp/session",
    "http://localhost:3001/v1/mcp/session",
  ]);
});

test("architecture projection rejects unsafe identifiers before the architecture request", async () => {
  const calls: string[] = [];
  const client = createRegistryApiClient({
    token: "aiss_test_secret",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, mcpSession(["skills:read", "architectures:read"]));
      }
      return jsonResponse(500, {});
    },
  });

  const result = await createAiSkillsMcpHandlers(client).getArchitectureProjection({ id: "../private" });

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Architecture id is invalid/);
  assert.deepEqual(calls, ["http://localhost:3001/v1/mcp/session"]);
});

function jsonResponse(status: number, body: Record<string, unknown>): Awaited<ReturnType<FetchLike>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function mcpSession(scopes = ["skills:read"]) {
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

function publicRelease() {
  return {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: "2026-06-04T00:00:00.000Z",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    artifact: {
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      byteSize: 1234,
      contentType: "application/vnd.myskills-app.package+json",
    },
  };
}
