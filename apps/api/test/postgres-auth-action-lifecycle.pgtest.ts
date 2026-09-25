import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { authActionLifecycleCases, authActionRollbackCases } from "./auth-action-lifecycle-cases.js";

test("Postgres auth action lifecycle", { timeout: 60_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const store = new PostgresAuthStore(createDb(pool));
  await authActionLifecycleCases(t, store);
  await pool.query(`
    CREATE FUNCTION fail_lifecycle_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected credential revocation failure';
    END $$;
  `);
  await authActionRollbackCases(t, store, async () => {
    await pool.query("CREATE TRIGGER fail_lifecycle_revocation BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fail_lifecycle_revocation()");
  }, async () => {
    await pool.query("DROP TRIGGER fail_lifecycle_revocation ON auth_sessions");
  });
});
