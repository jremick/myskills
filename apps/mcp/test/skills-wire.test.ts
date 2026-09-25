import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { createAiSkillsMcpHttpServer } from "../src/http.js";
import { SKILLS_EXTENSION } from "../src/skills.js";
import { nativeFixture } from "./native-fixture.js";

const listResult = z.object({ skills: z.array(z.object({ uri: z.string() }).passthrough()) }).passthrough();
const getResult = z.object({ skill: z.object({ uri: z.string() }).passthrough() }).passthrough();

for (const declared of [false, true]) {
  test(`Modern HTTP native methods enforce extension declaration (${declared})`, async (t) => {
    const fixture = nativeFixture();
    const server = createAiSkillsMcpHttpServer({ fetchImpl: fixture.fetchImpl });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new Client({ name: "native-http-client", version: "1.0.0" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: declared ? { extensions: { [SKILLS_EXTENSION]: {} } } : {},
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: "Bearer aiss_native_test" } } });
    try {
      await client.connect(transport);
      const caps = client.getDiscoverResult()?.capabilities;
      assert.deepEqual(caps?.extensions?.[SKILLS_EXTENSION], {});
      assert.ok(caps?.resources);
      assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
      assert.equal((await client.listTools()).tools.length, 6);
      if (!declared) {
        await assert.rejects(client.request({ method: "skills/list", params: {} }, listResult), /Declare the io.modelcontextprotocol\/skills/);
        assert.equal(fixture.calls.some((call) => call.method === "skills/list"), false);
        return;
      }
      const listed = await client.request({ method: "skills/list", params: {} }, listResult);
      assert.equal(listed.skills.length, 1);
      assert.equal(listed.cacheScope, "private");
      assert.equal(listed.ttlMs, 0);
      const uri = listed.skills[0].uri;
      assert.equal((await client.request({ method: "skills/get", params: { uri } }, getResult)).skill.uri, uri);
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents.length, 1);
      assert.equal("text" in resource.contents[0] && resource.contents[0].text, fixture.files[1].content);
      fixture.state.revoked = true;
      await assert.rejects(client.readResource({ uri }));
    } finally {
      await client.close();
    }
  });
}

for (const era of ["legacy", "modern"] as const) {
  for (const declared of [false, true]) {
    test(`Native stdio resources and capability gate: ${era}, declared=${declared}`, { timeout: 20_000 }, async (t) => {
      const fixture = nativeFixture();
      const api = createServer((request, response) => {
        void (async () => {
          const result = await fixture.fetchImpl(`http://fixture.test${request.url}`, { headers: {
            authorization: request.headers.authorization ?? "",
            ...(typeof request.headers["x-myskills-mcp-method"] === "string" ? { "x-myskills-mcp-method": request.headers["x-myskills-mcp-method"] } : {}),
          } });
          response.writeHead(result.status, { "content-type": "application/json" });
          response.end(await result.text());
        })().catch(() => { response.writeHead(500); response.end(); });
      });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => { api.closeAllConnections(); api.close(() => resolve()); }));
      const address = api.address();
      assert.ok(address && typeof address === "object");
      const client = new Client({ name: "native-stdio-test", version: "1.0.0" }, {
        versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } },
        capabilities: declared ? { extensions: { [SKILLS_EXTENSION]: {} } } : {},
      });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { MYSKILLS_API_URL: `http://127.0.0.1:${address.port}`, MYSKILLS_TOKEN: "aiss_native_test" },
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        assert.equal(client.getProtocolEra(), era);
        assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
        if (!declared) {
          await assert.rejects(client.request({ method: "skills/list", params: {} }, listResult), /Declare the io.modelcontextprotocol\/skills/);
          return;
        }
        const list = await client.request({ method: "skills/list", params: {} }, listResult);
        assert.equal(list.skills.length, 1);
        assert.equal((await client.readResource({ uri: list.skills[0].uri })).contents.length, 1);
        assert.ok(fixture.calls.some((call) => call.method === "resources/read"));
      } finally {
        await client.close();
      }
    });
  }
}
