import assert from "node:assert/strict";
import test from "node:test";
import { requestLogDecision, requestLoggingConfigFromEnv } from "../src/request-logging.js";

test("request logging defaults to 1% sampling with 1s slow threshold", () => {
  assert.deepEqual(requestLoggingConfigFromEnv({}), { mode: "sampled", sampleRate: 0.01, slowMs: 1000 });
  assert.deepEqual(
    requestLoggingConfigFromEnv({ API_REQUEST_LOG_MODE: "ALL", API_REQUEST_LOG_SAMPLE_RATE: "0.5", API_REQUEST_LOG_SLOW_MS: "250" }),
    { mode: "all", sampleRate: 0.5, slowMs: 250 },
  );
  assert.deepEqual(
    requestLoggingConfigFromEnv({ API_REQUEST_LOG_MODE: "loud", API_REQUEST_LOG_SAMPLE_RATE: "2", API_REQUEST_LOG_SLOW_MS: "-1" }),
    { mode: "sampled", sampleRate: 0.01, slowMs: 1000 },
  );
});

test("server errors and slow requests are always logged, even in errors mode and on probes", () => {
  const quiet = { mode: "errors" as const, sampleRate: 0, slowMs: 1000 };
  assert.equal(requestLogDecision(quiet, { statusCode: 503, durationMs: 5, path: "/ready" }), "error");
  assert.equal(requestLogDecision(quiet, { statusCode: 200, durationMs: 1500, path: "/v1/skills" }), "slow");
  assert.equal(requestLogDecision(quiet, { statusCode: 200, durationMs: 5, path: "/v1/skills" }), "skip");
});

test("ordinary requests are sampled; health probes are never sampled in", () => {
  const sampled = { mode: "sampled" as const, sampleRate: 0.1, slowMs: 1000 };
  assert.equal(requestLogDecision(sampled, { statusCode: 200, durationMs: 5, path: "/v1/skills" }, () => 0.05), "sampled");
  assert.equal(requestLogDecision(sampled, { statusCode: 404, durationMs: 5, path: "/v1/skills" }, () => 0.5), "skip");
  assert.equal(requestLogDecision(sampled, { statusCode: 200, durationMs: 5, path: "/health" }, () => 0), "skip");
  assert.equal(requestLogDecision({ ...sampled, mode: "all" }, { statusCode: 200, durationMs: 5, path: "/health" }), "sampled");
});
