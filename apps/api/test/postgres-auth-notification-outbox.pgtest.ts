import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { encryptAuthNotification } from "../src/auth/notification-outbox.js";
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
  await t.test("initial availability uses the application clock without making retries early", async (t) => {
    // Freeze the application clock behind Postgres to make mixed-clock admission
    // fail deterministically, including on slower machines that hide the race.
    const { rows: [{ now: databaseNow }] } = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now");
    const now = new Date(databaseNow.getTime() - 30_000);
    t.mock.timers.enable({ apis: ["Date"], now });
    const store = new PostgresAuthStore(createDb(pool));
    const { user } = await store.createUserWithPassword({ email: "clock@example.test", passwordHash: "synthetic-test-hash" });
    assert.ok(user);
    const token = randomUUID();
    assert.ok(await store.createAuthActionToken({
      userId: user.id, purpose: "email_verification", tokenHash: hashSessionToken(token),
      sentToNormalizedEmail: user.email, expiresAt: new Date(now.getTime() + 60_000),
      notification: encryptAuthNotification("synthetic-test-secret", { email: user.email, token, purpose: "email_verification" }),
    }));
    const [claim] = await store.claimAuthNotifications({ now, limit: 1, leaseId: randomUUID() });
    assert.ok(claim, "a committed new intent must be due on the application's admission clock");
    const availableAt = new Date(now.getTime() + 30_000);
    assert.equal(await store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome: "retry", availableAt }), true);
    assert.deepEqual(await store.claimAuthNotifications({ now: new Date(availableAt.getTime() - 1), limit: 1, leaseId: randomUUID() }), []);
    const [retry] = await store.claimAuthNotifications({ now: availableAt, limit: 1, leaseId: randomUUID() });
    assert.ok(retry);
    assert.equal(retry.id, claim.id);
    assert.equal(retry.attempts, 2);
    assert.equal(await store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now: availableAt, outcome: "delivered" }), false);
    assert.equal(await store.finishAuthNotification({ id: retry.id, leaseId: retry.leaseId, now: availableAt, outcome: "delivered" }), true);
  });
  await authNotificationOutboxCases(t, async () => {
    // This fixture creates auth rows only. Avoid TRUNCATE CASCADE, which also
    // invokes immutable architecture-history guards even when those tables are empty.
    await pool.query("DELETE FROM users");
    return {
      store: new PostgresAuthStore(createDb(pool)),
      expireToken: async (tokenHash) => { await pool.query("UPDATE auth_action_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [tokenHash]); },
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
