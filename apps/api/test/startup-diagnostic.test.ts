import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { apiStartupFailure, formatApiStartupFailure, readApiStartupFailure } from "../src/startup-diagnostic.js";
import { createAuthNotificationSinkFromEnv } from "../src/auth/notification.js";

test("isolated process fixture disables unrelated notifications through the supported test mode", () => {
  assert.throws(() => createAuthNotificationSinkFromEnv({ NODE_ENV: "test" }), /APP_BASE_URL is required/);
  assert.equal(createAuthNotificationSinkFromEnv({ NODE_ENV: "test", AUTH_NOTIFICATION_MODE: "disabled" }), undefined);
  assert.throws(() => createAuthNotificationSinkFromEnv({ NODE_ENV: "production", AUTH_NOTIFICATION_MODE: "disabled" }), /not allowed in production/);
});

test("startup receipts retain only fixed codes and phases, never error payloads", () => {
  const privatePayload = "private-startup-fixture-value";
  for (const [code, category] of [["EADDRINUSE", "network"], ["28P01", "database"], ["ERR_MODULE_NOT_FOUND", "module"], ["FST_ERR_PLUGIN_TIMEOUT", "fastify"]]) {
    const error = Object.assign(new Error(privatePayload), { code, address: privatePayload, detail: privatePayload, cause: new Error(privatePayload) });
    const receipt = formatApiStartupFailure(error, "listen");
    assert.equal(receipt.includes(privatePayload), false);
    assert.ok(receipt.length <= 256);
    assert.deepEqual(readApiStartupFailure(receipt), { phase: "listen", category, code });
  }
  assert.deepEqual(apiStartupFailure({ code: privatePayload, message: privatePayload }, "worker_start"), { phase: "worker_start", category: "unclassified", code: "UNKNOWN" });
  assert.deepEqual(apiStartupFailure(null, "listen"), { phase: "listen", category: "unclassified", code: "UNKNOWN" });
});

test("child startup receipt parsing rejects malformed phases and discards injected fields", () => {
  const prefix = "MYSKILLS_API_STARTUP_FAILURE ";
  for (const body of ["null", "{", JSON.stringify({ phase: "secret-value", code: "EADDRINUSE" }), JSON.stringify({ phase: "listen" })]) {
    assert.equal(readApiStartupFailure(`${prefix}${body}\n`), undefined);
  }
  assert.deepEqual(readApiStartupFailure(`${prefix}${JSON.stringify({ phase: "listen", code: "EADDRINUSE", category: "secret-value", payload: "secret-value" })}\n`), { phase: "listen", category: "network", code: "EADDRINUSE" });
  assert.equal(readApiStartupFailure(prefix + "x".repeat(300)), undefined);
});

test("actual Fastify listen failure has a safe receipt with the logger disabled", async t => {
  const owner = Fastify({ logger: false });
  const candidate = Fastify({ logger: false });
  t.after(async () => { await candidate.close(); await owner.close(); });
  await owner.listen({ host: "127.0.0.1", port: 0 });
  const port = (owner.server.address() as { port: number }).port;
  await assert.rejects(candidate.listen({ host: "127.0.0.1", port }), error => {
    const receipt = formatApiStartupFailure(error, "listen");
    assert.deepEqual(readApiStartupFailure(receipt), { phase: "listen", category: "network", code: "EADDRINUSE" });
    assert.equal(receipt.includes("127.0.0.1"), false);
    return true;
  });
});
