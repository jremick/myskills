import assert from "node:assert/strict";
import test from "node:test";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresDeviceLoginStore } from "../src/auth/device-login/postgres-store.js";
import { deviceLoginJourney } from "./device-login-cases.js";

test("Postgres device login persists through API/service restart and serializes concurrent token issuance", { timeout: 60_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(^|[_/-])(test|ci)([_/-]|$)/i);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const db = createDb(pool);
  t.diagnostic(JSON.stringify(await deviceLoginJourney(new PostgresAuthStore(db), clock => new PostgresDeviceLoginStore(db, clock))));
});
