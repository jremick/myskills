import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService, type AuthActionNotification, type AuthNotificationSink } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

test("Postgres registration invitations preserve redemption and cleanup invariants", {
  timeout: 60_000,
}, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => {
    await pool.end();
  });

  await resetDatabase(pool);
  await applyMigrations(pool);

  const authStore = new PostgresAuthStore(createDb(pool));
  const invitations: AuthActionNotification[] = [];
  const failingEmails = new Set<string>();
  const app = buildApp({
    authService: new AuthService(authStore, {
      notificationSink: invitationOutbox(invitations, failingEmails),
    }),
    skillRepository: new MemorySkillRepository([]),
  });
  t.after(() => app.close());

  const ownerSession = await addOwnerAndLoginWithMfa(app, authStore);

  const invited = await app.inject({
    method: "POST",
    url: "/v1/admin/registration/invitations",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      email: "invited@example.com",
      name: "Invited User",
    },
  });
  assert.equal(invited.statusCode, 201);
  assert.equal(invitations.length, 1);

  const pendingUser = await authStore.findUserByEmailWithPassword("invited@example.com");
  assert.equal(pendingUser?.status, "pending");
  assert.equal(pendingUser?.passwordHash, null);

  const wrongEmail = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "other@example.com",
      password: "correct horse battery staple",
      inviteToken: invitations[0].token,
    },
  });
  assert.equal(wrongEmail.statusCode, 401);
  assert.equal(wrongEmail.json().error.code, "INVALID_INVITATION_TOKEN");
  assert.equal((await authStore.findUserByEmailWithPassword("invited@example.com"))?.passwordHash, null);

  const correctEmail = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "invited@example.com",
      password: "correct horse battery staple",
      inviteToken: invitations[0].token,
    },
  });
  assert.equal(correctEmail.statusCode, 202);
  assert.deepEqual(correctEmail.json(), { status: "active" });

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "invited@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);

  const reused = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "invited@example.com",
      password: "correct horse battery staple",
      inviteToken: invitations[0].token,
    },
  });
  assert.equal(reused.statusCode, 401);
  assert.equal(reused.json().error.code, "INVALID_INVITATION_TOKEN");

  failingEmails.add("delivery-failure@example.com");
  const failedDelivery = await app.inject({
    method: "POST",
    url: "/v1/admin/registration/invitations",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      email: "delivery-failure@example.com",
    },
  });
  assert.equal(failedDelivery.statusCode, 502);
  assert.equal(failedDelivery.json().error.code, "INVITATION_DELIVERY_FAILED");
  assert.equal(await authStore.findUserByEmailWithPassword("delivery-failure@example.com"), null);
});

async function addOwnerAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: PostgresAuthStore,
): Promise<string> {
  const owner = await authStore.createUserWithPassword({
    email: "owner@example.com",
    name: "Owner",
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  assert.equal(owner.created, true);
  assert.ok(owner.user);
  await authStore.updateUserStatus({
    userId: owner.user.id,
    status: "active",
    emailVerifiedAt: new Date(),
  });
  await authStore.updateUserRoles({
    userId: owner.user.id,
    roles: ["owner"],
  });

  const setupLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "owner@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(setupLogin.statusCode, 200);

  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupLogin.json().token}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupLogin.json().token}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "owner@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token;
}

function invitationOutbox(
  invitations: AuthActionNotification[],
  failingEmails: Set<string>,
): AuthNotificationSink {
  return {
    sendEmailVerification() {},
    sendPasswordReset() {},
    sendRegistrationInvitation(input) {
      if (failingEmails.has(input.email)) {
        throw new Error("SMTP unavailable");
      }
      invitations.push(input);
    },
  };
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}. Use TEST_DATABASE_URL with a test database.`);
  }
}

async function resetDatabase(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function applyMigrations(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [id]);
    if (existing.rowCount) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
