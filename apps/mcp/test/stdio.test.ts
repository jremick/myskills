import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

for (const era of ["legacy", "modern"] as const) {
  test(`stdio entrypoint serves ${era} discovery and registry tools over real pipes`, { timeout: 20_000 }, async (t) => {
    const apiCalls: string[] = [];
    const api = createServer((request, response) => {
      assert.equal(request.headers.authorization, "Bearer aiss_stdio_test");
      apiCalls.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/v1/mcp/session") {
        response.end(JSON.stringify({
          user: {
            id: "stdio-user", email: "stdio@example.com", name: "Stdio Reader",
            roles: ["user"], emailVerified: true, mfaVerified: false,
          },
          credential: { kind: "api_token", tokenId: "stdio-token", scopes: ["skills:read"] },
        }));
        return;
      }
      assert.equal(request.url, "/v1/skills?q=stdio");
      response.end(JSON.stringify({ skills: [{
        slug: "stdio-helper", title: "Stdio Helper", summary: "A test skill.",
        lifecycleStatus: "approved", visibility: "public", latestVersion: "0.1.0",
        reviewStatus: "approved", securityStatus: "passed", platforms: [], tags: [],
      }] }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => {
      api.closeAllConnections();
      api.close(() => resolve());
    }));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const client = new Client({ name: `stdio-${era}-test`, version: "1.0.0" }, {
      versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        MYSKILLS_API_URL: `http://127.0.0.1:${address.port}`,
        MYSKILLS_TOKEN: "aiss_stdio_test",
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), era);
      assert.equal(client.getServerVersion()?.name, "myskills-app");
      if (era === "modern") {
        assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
        assert.ok(client.getDiscoverResult());
      }
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        "get_architecture_projection", "get_install_instructions", "get_skill_info",
        "list_architecture_patterns", "list_architectures", "search_skills",
      ]);
      const result = await client.callTool({ name: "search_skills", arguments: { query: "stdio" } });
      assert.equal(result.isError, undefined);
      assert.match(JSON.stringify(result), /stdio-helper/);
      assert.equal(JSON.stringify(result).includes("aiss_stdio_test"), false);
      assert.deepEqual(apiCalls, ["/v1/mcp/session", "/v1/skills?q=stdio"]);
    } finally {
      await client.close();
    }
  });
}
