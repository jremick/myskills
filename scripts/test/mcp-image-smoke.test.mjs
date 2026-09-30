import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

// Failure cases, before the smoke implementation: an unrelated HTTP server passes;
// anonymous MCP succeeds; the packaged entrypoint ignores PORT; a failed start hangs.
test("MCP image smoke checks the real entrypoint on the platform port without credentials", async (t) => {
  const reserve = createServer();
  await listen(reserve);
  const port = reserve.address().port;
  await close(reserve);
  const env = { ...process.env, PORT: String(port), MYSKILLS_MCP_HOST: "127.0.0.1", MYSKILLS_MCP_ALLOWED_HOSTS: `127.0.0.1:${port}` };
  for (const key of ["MYSKILLS_MCP_PORT", "MYSKILLS_OAUTH_ISSUER", "MYSKILLS_MCP_PUBLIC_URL", "MYSKILLS_API_TOKEN"]) delete env[key];
  const server = spawn(process.execPath, ["--import", "tsx", "apps/mcp/src/http-index.ts"], { env, stdio: "ignore" });
  t.after(async () => { if (server.exitCode === null && server.signalCode === null) { const ended = once(server, "exit"); server.kill("SIGTERM"); await ended; } });
  const result = await smoke(env);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output), { service: "myskills-app-mcp-http", health: "passed", anonymousMcp: "denied", port });
});

for (const invalid of ["wrong-service", "anonymous-access"]) test(`MCP image smoke rejects ${invalid}`, async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ ok: true, service: invalid === "wrong-service" ? "web" : "myskills-app-mcp-http" }));
    else response.end(JSON.stringify({ result: {} }));
  });
  await listen(server);
  t.after(() => close(server));
  const result = await smoke({ ...process.env, PORT: String(server.address().port), MYSKILLS_MCP_PORT: "" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /MCP (health|anonymous request) check failed/);
});

test("MCP image smoke fails when the server never starts", async () => {
  const reserve = createServer();
  await listen(reserve);
  const port = reserve.address().port;
  await close(reserve);
  const result = await smoke({ ...process.env, PORT: String(port), MYSKILLS_MCP_PORT: "" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /MCP server did not become ready/);
});

function smoke(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/smoke-mcp-http.mjs"], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
