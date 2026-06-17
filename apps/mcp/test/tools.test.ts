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
