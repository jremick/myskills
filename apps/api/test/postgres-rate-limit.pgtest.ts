import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAuthRateLimiter } from "../src/auth/rate-limit.js";
import { createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

// Failure cases: lost concurrent increments, independent instance budgets,
// cross-key interference, stale expiry, unbounded cleanup, or deletion of live buckets.
test("Postgres limiter shares concurrent budgets, resets expired windows, and preserves live buckets during bounded cleanup", { timeout: 60_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assert.match(new URL(databaseUrl).pathname.replace(/^\//, ""), /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  const secondPool = createPgPool(databaseUrl);
  t.after(async () => { await Promise.all([pool.end(), secondPool.end()]); });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);

  const options = { maxAttempts: 3, windowMs: 60_000, cleanupEvery: 1000, cleanupBatchSize: 2 };
  const first = new PostgresAuthRateLimiter(pool, options);
  const second = new PostgresAuthRateLimiter(secondPool, options);
  const now = new Date("2026-09-27T00:00:00Z");
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : second).consume("login:shared", now)));
  assert.equal(results.filter((result) => result.allowed).length, 3);
  assert.deepEqual(results.filter((result) => !result.allowed), Array.from({ length: 5 }, () => ({ allowed: false, retryAfterSeconds: 60 })));
  assert.equal((await pool.query("SELECT attempt_count FROM auth_rate_limits WHERE bucket_key = 'login:shared'")).rows[0].attempt_count, 8);
  assert.deepEqual(await second.consume("login:other", now), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(await first.consume("login:shared", new Date(now.getTime() + 59_001)), { allowed: false, retryAfterSeconds: 1 });

  const boundary = new Date(now.getTime() + 60_000);
  assert.deepEqual(await second.consume("login:shared", boundary), { allowed: true, retryAfterSeconds: 0 });
  const reset = (await pool.query("SELECT attempt_count, reset_at FROM auth_rate_limits WHERE bucket_key = 'login:shared'")).rows[0];
  assert.equal(reset.attempt_count, 1);
  assert.equal(reset.reset_at.toISOString(), "2026-09-27T00:02:00.000Z");

  // Three expired rows and two live rows: one cleanup must delete exactly two expired rows.
  for (const key of ["expired:one", "expired:two"]) await first.consume(key, now);
  await second.consume("live:other", boundary);
  const remaining = async () => (await pool.query("SELECT bucket_key FROM auth_rate_limits ORDER BY bucket_key")).rows.map((row) => row.bucket_key);
  await first.cleanupExpiredBuckets(boundary);
  const afterFirstCleanup = await remaining();
  assert.equal(afterFirstCleanup.length, 3);
  assert.equal(afterFirstCleanup.includes("login:shared"), true);
  assert.equal(afterFirstCleanup.includes("live:other"), true);
  await second.cleanupExpiredBuckets(boundary);
  assert.deepEqual(await remaining(), ["live:other", "login:shared"]);
  assert.equal((await first.consume("login:shared", boundary)).allowed, true);
  assert.equal((await second.consume("login:shared", boundary)).allowed, true);
  assert.deepEqual(await first.consume("login:shared", boundary), { allowed: false, retryAfterSeconds: 60 });
});
