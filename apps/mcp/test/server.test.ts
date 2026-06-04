import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createAiSkillsMcpServer } from "../src/server.js";
import type { FetchLike } from "../src/api-client.js";

test("MCP server registers read-only registry tools and executes search", async () => {
  const calls: string[] = [];
  const { clientTransport, serverTransport } = linkedTransports();
  const server = createAiSkillsMcpServer({
    token: "aiss_test_secret",
    fetchImpl: async (url, init) => {
      assert.equal(init?.headers?.authorization, "Bearer aiss_test_secret");
      calls.push(url);
      if (url.endsWith("/v1/mcp/session")) {
        return jsonResponse(200, {
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
        });
      }
      assert.equal(url, "http://localhost:3001/v1/skills?q=release");
      return jsonResponse(200, {
        skills: [{
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
        }],
      });
    },
  });
  const client = new Client({ name: "mcp-test-client", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["get_install_instructions", "get_skill_info", "search_skills"],
    );
    assert.equal(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true), true);

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "release" },
    });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.stringify(result).includes("release-notes-helper"), true);
    assert.deepEqual(calls, [
      "http://localhost:3001/v1/mcp/session",
      "http://localhost:3001/v1/skills?q=release",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

class MemoryTransport implements Transport {
  peer?: MemoryTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function linkedTransports(): { clientTransport: MemoryTransport; serverTransport: MemoryTransport } {
  const clientTransport = new MemoryTransport();
  const serverTransport = new MemoryTransport();
  clientTransport.peer = serverTransport;
  serverTransport.peer = clientTransport;
  return { clientTransport, serverTransport };
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
