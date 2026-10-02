import assert from "node:assert/strict";
import test from "node:test";
import { verifyPassword } from "@myskills-app/auth";
import { bootstrapOwner } from "../src/db/bootstrap-owner.js";
import { createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

// First-owner failure cases, before implementation:
// - Retries change credentials, re-enable a disabled owner or restore removed roles.
// - Concurrent bootstraps create two owners or partial creation survives a failure.
// - Existing application data is treated as an uninitialized registry.
// - Bootstrap seeds or repairs sample packages, or accepts invalid credentials.
test("first-owner bootstrap preserves lifecycle, rejects populated registries and commits atomically", { timeout: 90_000 }, async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url, "A disposable TEST_DATABASE_URL is required");
  assert.match(decodeURIComponent(new URL(url).pathname), /(?:^|[_/-])(test|ci)(?:[_/-]|$)/i);
  const pool = createPgPool(url);
  t.after(() => pool.end());
  const input = { email: "first-owner@fixture.test", password: "first-bootstrap-password-123" };
  async function fresh() {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  }
  await fresh();
  const concurrent = await Promise.all([bootstrapOwner(pool, input), bootstrapOwner(pool, input)]);
  assert.deepEqual(concurrent.map((r) => r.outcome).sort(), ["already-initialized", "created"]);
  const original = (await pool.query("SELECT u.id,u.status,p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id")).rows[0];
  assert.ok(await verifyPassword(original.password_hash, input.password));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM skills")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM role_assignments WHERE role='owner'")).rows[0].count, 1);
  const retry = await bootstrapOwner(pool, { ...input, email: " FIRST-OWNER@fixture.test ", password: "different-retry-password-123" });
  assert.equal(retry.outcome, "already-initialized");
  assert.equal((await pool.query("SELECT password_hash FROM password_credentials WHERE user_id=$1", [original.id])).rows[0].password_hash, original.password_hash);
  await assert.rejects(bootstrapOwner(pool, { ...input, email: "second-owner@fixture.test" }));
  await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [original.id]);
  await assert.rejects(bootstrapOwner(pool, input));
  assert.equal((await pool.query("SELECT status FROM users WHERE id=$1", [original.id])).rows[0].status, "disabled");
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [original.id]);
  await pool.query("DELETE FROM role_assignments WHERE user_id=$1 AND role='owner'", [original.id]);
  await assert.rejects(bootstrapOwner(pool, input));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM role_assignments WHERE role='owner'")).rows[0].count, 0);

  await fresh();
  await pool.query("INSERT INTO users(email,normalized_email,name) VALUES ('existing@fixture.test','existing@fixture.test','Existing user')");
  await assert.rejects(bootstrapOwner(pool, input));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM password_credentials")).rows[0].count, 0);

  await fresh();
  await pool.query("CREATE FUNCTION reject_bootstrap_password() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END; $$");
  await pool.query("CREATE TRIGGER reject_bootstrap_password BEFORE INSERT ON password_credentials FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_password()");
  await assert.rejects(bootstrapOwner(pool, input));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM instance_settings WHERE key='owner-bootstrap'")).rows[0].count, 0);
  await pool.query("DROP TRIGGER reject_bootstrap_password ON password_credentials");
  const race = await Promise.allSettled([bootstrapOwner(pool, input), bootstrapOwner(pool, { ...input, email: "racing-owner@fixture.test" })]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 1);

  await fresh();
  for (const invalid of [{ ...input, email: "bad-address" }, { ...input, password: "short" }, { ...input, password: "é".repeat(40) }]) {
    await assert.rejects(bootstrapOwner(pool, invalid));
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM users")).rows[0].count, 0);
});
