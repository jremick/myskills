import test from "node:test";
import assert from "node:assert/strict";
import { PostgresAuthRateLimiter, type QueryablePool } from "../src/auth/rate-limit.js";

test("PostgresAuthRateLimiter enforces shared bucket counts", async () => {
  const queries: Array<{ query: string; values: unknown[] }> = [];
  const resetAt = new Date("2026-06-14T10:15:00Z");
  const pool: QueryablePool = {
    async query(query, values) {
      queries.push({ query, values });
      return { rows: [{ attempt_count: 3, reset_at: resetAt }] };
    },
  };
  const limiter = new PostgresAuthRateLimiter(pool, { maxAttempts: 2, windowMs: 15 * 60 * 1000 });

  const result = await limiter.consume("login:ip:203.0.113.10", new Date("2026-06-14T10:00:00Z"));

  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 900);
  assert.match(queries[0].query, /ON CONFLICT \(bucket_key\) DO UPDATE/);
  assert.equal(queries[0].values[0], "login:ip:203.0.113.10");
});

test("PostgresAuthRateLimiter allows attempts within the shared bucket limit", async () => {
  const pool: QueryablePool = {
    async query() {
      return { rows: [{ attempt_count: 2, reset_at: new Date("2026-06-14T10:15:00Z") }] };
    },
  };
  const limiter = new PostgresAuthRateLimiter(pool, { maxAttempts: 2, windowMs: 15 * 60 * 1000 });

  assert.deepEqual(
    await limiter.consume("login:ip:203.0.113.10", new Date("2026-06-14T10:00:00Z")),
    { allowed: true, retryAfterSeconds: 0 },
  );
});
