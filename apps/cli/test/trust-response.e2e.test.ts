import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCli, type CliRuntime, type StoredCliToken } from "../src/cli.js";
import { readBoundedResponse, decodeResponseUtf8 } from "../src/bounded-response.js";

test("bounded response cancels overflow/stalls before text allocation and strictly decodes raw UTF-8", async () => {
  let cancelled = false;
  const response = { body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("12345")); }, cancel() { cancelled = true; },
  }), text: async () => { assert.fail("streaming responses must never call text()"); } };
  await assert.rejects(readBoundedResponse(response, 4, new AbortController().signal), /byte limit/);
  assert.equal(cancelled, true);
  const controller = new AbortController();
  let stalledCancelled = false;
  const stalled = readBoundedResponse({ body: new ReadableStream({ cancel() { stalledCancelled = true; } }), text: async () => "" }, 4, controller.signal);
  controller.abort();
  await assert.rejects(stalled, /timed out/);
  assert.equal(stalledCancelled, true);
  assert.throws(() => decodeResponseUtf8(new Uint8Array([0xc3, 0x28])), /UTF-8/);
  assert.equal(decodeResponseUtf8(new Uint8Array([0xe2, 0x82, 0xac])), "€");
});

test("real HTTP stalled response is cancelled within the body deadline", async (t) => {
  let socketClosed = false;
  const api = createServer((_request, reply) => {
    reply.once("close", () => { socketClosed = true; });
    reply.write("x");
  });
  const apiUrl = await listen(t, api);
  const signal = AbortSignal.timeout(200);
  const response = await fetch(apiUrl, { signal, redirect: "error" });
  await assert.rejects(readBoundedResponse(response, 32, signal), /timed out|abort/i);
  for (let attempts = 0; !socketClosed && attempts < 50; attempts++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socketClosed, true);
});

for (const mode of ["header-overflow", "chunk-overflow", "invalid-utf8", "stalled-body", "redirect", "invalid-size"] as const) {
  test(`real CLI export rejects ${mode} before filesystem or credential writes`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "myskills-trust-cli-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let forwarded = 0;
    const other = createServer((_request, reply) => { forwarded++; reply.end("forwarded"); });
    const otherOrigin = await listen(t, other);
    const files = [{ path: "SKILL.md", content: "---\nname: bounded-example\ndescription: Synthetic fixture.\n---\nHello.\n" },
      { path: "skill.json", content: JSON.stringify({ name: "bounded-example", title: "Bounded example", summary: "Synthetic fixture.", version: "1.0.0", license: "MIT", platforms: [{ name: "codex", install_target: "codex-skill" }] }) }];
    const expected = mode === "invalid-utf8" ? Buffer.from([0xc3, 0x28]) : Buffer.from(JSON.stringify({ files }));
    const artifact = { sha256: createHash("sha256").update(expected).digest("hex"), byteSize: mode === "invalid-size" ? 10 * 1024 * 1024 + 1 : expected.length };
    let bundleReads = 0;
    const api = createServer((request, reply) => {
      reply.setHeader("content-type", "application/json");
      if (request.url?.includes("/bundle?")) {
        bundleReads++;
        assert.equal(new URL(request.url, "http://fixture").searchParams.get("sha256"), artifact.sha256);
        if (mode === "redirect") { reply.writeHead(307, { location: `${otherOrigin}/forward` }); reply.end(); }
        else if (mode === "header-overflow") { reply.setHeader("content-length", String(expected.length + 1)); reply.end(expected); }
        else if (mode === "chunk-overflow") { reply.write(expected); reply.end("x"); }
        else if (mode === "stalled-body") { reply.write("x"); }
        else reply.end(expected);
      } else {
        reply.end(JSON.stringify({ release: { slug: "bounded-example", version: "1.0.0", artifact, platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }] } }));
      }
    });
    const apiUrl = await listen(t, api);
    const f = runtime();
    if (mode === "stalled-body") f.options.fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(200) });
    const code = await runCli(["export", "bounded-example", "--version", "1.0.0", "--platform", "codex", "--api-url", apiUrl, "--output", path.join(root, "export")], f.options);
    assert.equal(code, 1, f.errors.join("\n"));
    assert.deepEqual(await readdir(root), []);
    assert.equal(f.writes(), 0);
    assert.equal(forwarded, 0);
    assert.equal(bundleReads, mode === "invalid-size" ? 0 : 1);
    assert.equal(f.errors.join("\n").includes(f.existing.token), false);
  });
}

for (const phase of ["start", "poll"] as const) {
  test(`real CLI device ${phase} redirect never forwards the redeemable code or replaces credentials`, { timeout: 15_000 }, async (t) => {
    let forwarded = 0;
    const other = createServer((_request, reply) => { forwarded++; reply.end("forwarded"); });
    const otherOrigin = await listen(t, other);
    let polls = 0;
    const api = createServer((request, reply) => {
      if (phase === "poll" && request.url?.endsWith("/start")) {
        reply.setHeader("content-type", "application/json");
        reply.end(JSON.stringify({ deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK", verificationUri: "https://example.test/auth/device", expiresIn: 60, interval: 5 }));
      } else {
        if (request.url?.endsWith("/poll")) polls++;
        reply.writeHead(308, { location: `${otherOrigin}/capture` }); reply.end();
      }
    });
    const apiUrl = await listen(t, api);
    const f = runtime();
    assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl], f.options), 1);
    assert.equal(forwarded, 0);
    assert.equal(polls, phase === "poll" ? 1 : 0);
    assert.equal(f.writes(), 0);
    assert.equal(f.errors.join("\n").includes(f.existing.token), false);
  });
}

for (const mode of ["header-overflow", "chunk-overflow", "invalid-utf8"] as const) {
  test(`real CLI device response rejects ${mode} and retains credentials`, async (t) => {
    const api = createServer((_request, reply) => {
      reply.setHeader("content-type", "application/json");
      if (mode === "header-overflow") { reply.setHeader("content-length", "16385"); reply.end("{}"); }
      else if (mode === "chunk-overflow") { reply.write(" ".repeat(16_384)); reply.end("{}"); }
      else reply.end(Buffer.from([0xc3, 0x28]));
    });
    const apiUrl = await listen(t, api);
    const f = runtime();
    assert.equal(await runCli(["login", "--method", "browser", "--api-url", apiUrl], f.options), 1);
    assert.equal(f.writes(), 0);
  });
}

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
function runtime() {
  const existing: StoredCliToken = { kind: "api", token: "synthetic-existing-credential", email: "fixture@example.test", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  let writes = 0;
  const errors: string[] = [];
  const options: CliRuntime = { env: {}, fetch, io: { stdout() {}, stderr(line) { errors.push(line); } },
    tokenStore: { get: async () => existing, set: async () => { writes++; }, delete: async () => { writes++; } } };
  return { options, errors, existing, writes: () => writes };
}
