import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAuthRateLimiter, PostgresAuthRateLimiter, type QueryablePool } from "../src/auth/rate-limit.js";

test("memory limiter bounds identities without evicting active attempt budgets", () => {
  const limiter = new MemoryAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000, maxBuckets: 2 });
  const now = new Date("2026-09-25T00:00:00Z");
  assert.equal(limiter.consume("first", now).allowed, true);
  assert.equal(limiter.consume("second", now).allowed, true);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.consume(`extra:${index}`, now).allowed, false);
  }
  assert.equal(limiter.consume("first", now).allowed, true);
  assert.equal(limiter.consume("first", now).allowed, false);
  assert.equal(limiter.consume("extra", new Date(now.getTime() + 60_000)).allowed, true);
});

test("memory limiter reclaims expired identities across bounded cleanup passes", () => {
  const limiter = new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 1000, maxBuckets: 64 });
  const now = new Date("2026-09-25T00:00:00Z");
  for (let index = 0; index < 64; index += 1) assert.equal(limiter.consume(`old:${index}`, now).allowed, true);
  assert.equal(limiter.consume("overflow", now).allowed, false);
  const later = new Date(now.getTime() + 1000);
  for (let index = 0; index < 64; index += 1) assert.equal(limiter.consume(`new:${index}`, later).allowed, true);
  assert.equal(limiter.consume("overflow", later).allowed, false);
  assert.equal(limiter.consume("new:0", later).allowed, false);
});

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

test("PostgresAuthRateLimiter periodically deletes expired buckets in bounded batches", async () => {
  const queries: string[] = [];
  const pool: QueryablePool = {
    async query(query) {
      queries.push(query);
      if (query.includes("RETURNING attempt_count")) {
        return { rows: [{ attempt_count: 1, reset_at: new Date("2026-06-14T10:15:00Z") }] };
      }
      return { rows: [] };
    },
  };
  const limiter = new PostgresAuthRateLimiter(pool, {
    maxAttempts: 10,
    windowMs: 60_000,
    cleanupEvery: 2,
    cleanupBatchSize: 25,
  });

  await limiter.consume("api:ip:203.0.113.1", new Date("2026-06-14T10:00:00Z"));
  await limiter.consume("api:ip:203.0.113.2", new Date("2026-06-14T10:00:01Z"));

  assert.equal(queries.length, 3);
  assert.match(queries[2], /DELETE FROM auth_rate_limits/);
  assert.match(queries[2], /LIMIT \$2/);
});

test("PostgresAuthRateLimiter does not fail requests when best-effort cleanup fails", async () => {
  const pool: QueryablePool = {
    async query(query) {
      if (query.includes("DELETE FROM auth_rate_limits")) {
        throw new Error("cleanup unavailable");
      }
      return { rows: [{ attempt_count: 1, reset_at: new Date("2026-06-14T10:15:00Z") }] };
    },
  };
  const limiter = new PostgresAuthRateLimiter(pool, {
    maxAttempts: 10,
    windowMs: 60_000,
    cleanupEvery: 1,
  });

  assert.deepEqual(
    await limiter.consume("api:ip:203.0.113.3", new Date("2026-06-14T10:00:00Z")),
    { allowed: true, retryAfterSeconds: 0 },
  );
});
