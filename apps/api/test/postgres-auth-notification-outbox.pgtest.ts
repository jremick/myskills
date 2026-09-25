import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { authNotificationOutboxCases, type OutboxFixture } from "./auth-notification-outbox-cases.js";

test("Postgres auth notification outbox", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname.replace(/^\//, ""), /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  await pool.query(`CREATE FUNCTION fail_auth_notification_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outbox insertion failure'; END $$`);
  await authNotificationOutboxCases(t, async () => {
    // This fixture creates auth rows only. Avoid TRUNCATE CASCADE, which also
    // invokes immutable architecture-history guards even when those tables are empty.
    await pool.query("DELETE FROM users");
    return {
      store: new PostgresAuthStore(createDb(pool)),
      setDisplayEmail: async (userId, email) => { await pool.query("UPDATE users SET email = $2 WHERE id = $1", [userId, email]); },
      rows: async () => (await pool.query('SELECT payload_ciphertext AS "payloadCiphertext", status, attempts FROM auth_notification_outbox ORDER BY created_at, id')).rows,
      counts: async () => {
        const result = await pool.query("SELECT (SELECT count(*)::int FROM auth_action_tokens) AS tokens, (SELECT count(*)::int FROM auth_notification_outbox) AS intents");
        return result.rows[0];
      },
      failIntentInsertion: async () => {
        await pool.query("CREATE TRIGGER fail_auth_notification_intent BEFORE INSERT ON auth_notification_outbox FOR EACH ROW EXECUTE FUNCTION fail_auth_notification_intent()");
        return async () => { await pool.query("DROP TRIGGER fail_auth_notification_intent ON auth_notification_outbox"); };
      },
    } satisfies OutboxFixture;
  });
});
