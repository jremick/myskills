import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService, type AuthNotificationSink } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import type { CompletePasswordResetInput } from "../src/auth/types.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

function emptySkillRepository() {
  return new MemorySkillRepository([]);
}

test("closed registration denies self signup", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "new@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "REGISTRATION_CLOSED");
});

test("request registration creates a pending account without a session", async (t) => {
  const authStore = new MemoryAuthStore("request");
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "New@Example.com",
      password: "correct horse battery staple",
      name: "New User",
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: "pending" });
  const pending = await authStore.findUserByEmailWithPassword("new@example.com");
  assert.equal(pending?.status, "pending");
  assert.equal(pending?.passwordHash?.includes("correct horse"), false);
});

test("registration queues email verification without activating request-mode accounts", async (t) => {
  const authStore = new MemoryAuthStore("request");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "New@Example.com",
      password: "correct horse battery staple",
      name: "New User",
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: "pending" });
  assert.equal(outbox.emailVerifications.length, 1);
  assert.equal(outbox.emailVerifications[0].email, "new@example.com");
  assertNoSensitiveAuthMaterial(response.json());

  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: {
      token: outbox.emailVerifications[0].token,
    },
  });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(verified.json(), { status: "verified" });
  assertNoSensitiveAuthMaterial(verified.json());

  const user = await authStore.findUserByEmailWithPassword("new@example.com");
  assert.equal(user?.status, "pending");
  assert.equal(user?.emailVerifiedAt instanceof Date, true);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "new@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 403);
  assert.equal(login.json().error.code, "ACCOUNT_NOT_ACTIVE");
});

test("email verification requests are generic and active unverified users can verify", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  authStore.addUser({
    id: "active-unverified",
    email: "active-unverified@example.com",
    status: "active",
    emailVerifiedAt: null,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());

  const request = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/request",
    payload: { email: "ACTIVE-UNVERIFIED@example.com" },
  });
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/request",
    payload: { email: "unknown@example.com" },
  });
  assert.equal(request.statusCode, 202);
  assert.deepEqual(request.json(), { status: "pending" });
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(unknown.json(), { status: "pending" });
  assert.equal(outbox.emailVerifications.length, 1);

  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: { token: outbox.emailVerifications[0].token },
  });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(verified.json(), { status: "verified" });

  const replay = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: { token: outbox.emailVerifications[0].token },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, "INVALID_VERIFICATION_TOKEN");

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "active-unverified@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.emailVerified, true);
});

test("email verification requests are rate limited and invalid tokens are generic", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      emailVerificationLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
  });
  t.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/request",
    remoteAddress: "203.0.113.20",
    payload: { email: "unknown@example.com" },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/request",
    remoteAddress: "203.0.113.20",
    payload: { email: "unknown@example.com" },
  });
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: { token: "short" },
  });
  const unknownToken = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: { token: "a".repeat(43) },
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "INVALID_REQUEST_BODY");
  assert.equal(unknownToken.statusCode, 401);
  assert.equal(unknownToken.json().error.code, "INVALID_VERIFICATION_TOKEN");
});

test("pending accounts cannot login", async (t) => {
  const authStore = new MemoryAuthStore("request");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    email: "pending@example.com",
    status: "pending",
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "pending@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "ACCOUNT_NOT_ACTIVE");
});

test("trusted proxy configuration isolates auth rate limits only for trusted source addresses", async (t) => {
  const passwordHash = await hashPassword("correct horse battery staple");
  async function attempt(app: ReturnType<typeof buildApp>, forwardedFor: string, remoteAddress = "127.0.0.1") {
    return app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress,
      headers: { "x-forwarded-for": forwardedFor },
      payload: {
        email: "active@example.com",
        password: "wrong password",
      },
    });
  }
  function authStore() {
    const store = new MemoryAuthStore("closed");
    store.addUser({
      id: "proxy-user",
      email: "active@example.com",
      name: "Active User",
      status: "active",
      emailVerifiedAt: new Date(),
      passwordHash,
    });
    return store;
  }

  const sharedProxyBucketApp = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore(), {
      loginLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
  });
  t.after(() => sharedProxyBucketApp.close());
  assert.equal((await attempt(sharedProxyBucketApp, "203.0.113.10")).statusCode, 401);
  const sharedBucket = await attempt(sharedProxyBucketApp, "203.0.113.11");
  assert.equal(sharedBucket.statusCode, 429);

  const trustedProxyApp = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore(), {
      loginLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
    trustProxy: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "100.0.0.0/8"],
  });
  t.after(() => trustedProxyApp.close());
  assert.equal((await attempt(trustedProxyApp, "203.0.113.10", "100.64.0.10")).statusCode, 401);
  assert.equal((await attempt(trustedProxyApp, "203.0.113.11", "100.64.0.10")).statusCode, 401);

  const untrustedProxyApp = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore(), {
      loginLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
    trustProxy: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "100.0.0.0/8"],
  });
  t.after(() => untrustedProxyApp.close());
  assert.equal((await attempt(untrustedProxyApp, "203.0.113.10", "198.51.100.20")).statusCode, 401);
  assert.equal((await attempt(untrustedProxyApp, "203.0.113.11", "198.51.100.20")).statusCode, 429);
});

test("active verified accounts can login, call me, and logout", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    id: "user-active",
    email: "active@example.com",
    name: "Active User",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user", "author"],
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "ACTIVE@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(login.statusCode, 200);
  const token = login.json().token;
  assert.equal(typeof token, "string");
  assert.equal(login.json().mfaRequired, false);
  assert.equal(login.json().user.email, "active@example.com");
  assert.equal(login.json().user.mfaVerified, false);
  const sessionCookie = firstSetCookie(login.headers["set-cookie"], "myskills_session");
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Path=\//);
  assert.match(sessionCookie, /SameSite=Lax/);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, "user-active");
  assert.deepEqual(me.json().user.roles, ["user", "author"]);

  const meFromCookie = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie: sessionCookie.split(";")[0] },
  });
  assert.equal(meFromCookie.statusCode, 200);
  assert.equal(meFromCookie.json().user.id, "user-active");

  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      cookie: sessionCookie.split(";")[0],
      origin: "http://localhost:3000",
    },
  });
  assert.equal(logout.statusCode, 204);
  const clearedCookie = firstSetCookie(logout.headers["set-cookie"], "myskills_session");
  assert.match(clearedCookie, /Max-Age=0/);
  assert.match(clearedCookie, /HttpOnly/);

  const revoked = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(revoked.statusCode, 401);
});

test("browser cookie session mode omits bearer tokens from login responses", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    id: "browser-session-user",
    email: "browser-session@example.com",
    name: "Browser Session",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "x-myskills-session-response": "cookie" },
    payload: {
      email: "browser-session@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.json().token, undefined);
  assert.equal(login.json().mfaRequired, false);
  const sessionCookie = firstSetCookie(login.headers["set-cookie"], "myskills_session");

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie: sessionCookie.split(";")[0] },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, "browser-session-user");
});

test("password reset requests are generic and successful reset revokes existing credentials", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());
  authStore.addUser({
    id: "reset-user",
    email: "reset@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash: await hashPassword("correct horse battery staple"),
  });

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "reset@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  const sessionToken = login.json().token;

  const apiTokenResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: {
      name: "Reset regression",
      scopes: ["profile:read"],
    },
  });
  assert.equal(apiTokenResponse.statusCode, 201);
  const apiToken = apiTokenResponse.json().token.token;

  const request = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "RESET@example.com" },
  });
  const siblingRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "reset@example.com" },
  });
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "unknown@example.com" },
  });
  assert.equal(request.statusCode, 202);
  assert.equal(siblingRequest.statusCode, 202);
  assert.deepEqual(request.json(), { status: "pending" });
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(unknown.json(), { status: "pending" });
  assert.equal(outbox.passwordResets.length, 2);
  assertNoSensitiveAuthMaterial(request.json());

  const weak = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "short",
    },
  });
  assert.equal(weak.statusCode, 400);
  assert.equal(weak.json().error.code, "INVALID_PASSWORD");

  const reset = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "new correct horse battery staple",
    },
  });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json(), { status: "reset" });
  assertNoSensitiveAuthMaterial(reset.json());

  const replay = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "another correct horse battery staple",
    },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, "INVALID_RESET_TOKEN");

  const sibling = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[1].token,
      password: "sibling correct horse battery staple",
    },
  });
  assert.equal(sibling.statusCode, 401);
  assert.equal(sibling.json().error.code, "INVALID_RESET_TOKEN");

  const oldPassword = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "reset@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(oldPassword.statusCode, 401);
  assert.equal(oldPassword.json().error.code, "INVALID_CREDENTIALS");

  const newPassword = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "reset@example.com",
      password: "new correct horse battery staple",
    },
  });
  assert.equal(newPassword.statusCode, 200);
  assert.equal(newPassword.json().mfaRequired, false);

  for (const token of [sessionToken, apiToken]) {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.statusCode, 401);
  }
});

test("password reset failure does not consume the token or partially change the password", async (t) => {
  const authStore = new FailingPasswordResetStore("closed");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());
  authStore.addUser({
    id: "reset-failure-user",
    email: "reset-failure@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash: await hashPassword("correct horse battery staple"),
  });

  await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "reset-failure@example.com" },
  });
  const failed = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "new correct horse battery staple",
    },
  });
  const oldPasswordStillWorks = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "reset-failure@example.com",
      password: "correct horse battery staple",
    },
  });
  const retry = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "new correct horse battery staple",
    },
  });

  assert.equal(failed.statusCode, 500);
  assert.equal(oldPasswordStillWorks.statusCode, 200);
  assert.equal(retry.statusCode, 200);
});

test("password reset does not issue tokens for unusable accounts and invalid tokens are generic", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      notificationSink: outbox.sink,
      passwordResetLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
  });
  t.after(() => app.close());
  authStore.addUser({
    email: "pending@example.com",
    status: "pending",
    emailVerifiedAt: null,
    passwordHash: await hashPassword("correct horse battery staple"),
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    remoteAddress: "203.0.113.21",
    payload: { email: "pending@example.com" },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    remoteAddress: "203.0.113.21",
    payload: { email: "pending@example.com" },
  });
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: "short",
      password: "new correct horse battery staple",
    },
  });
  const unknownToken = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: "b".repeat(43),
      password: "new correct horse battery staple",
    },
  });

  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), { status: "pending" });
  assert.equal(outbox.passwordResets.length, 0);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "INVALID_REQUEST_BODY");
  assert.equal(unknownToken.statusCode, 401);
  assert.equal(unknownToken.json().error.code, "INVALID_RESET_TOKEN");
});

test("auth notification delivery failures remain generic for known and unknown accounts", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  authStore.addUser({
    email: "delivery-fail@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      notificationSink: {
        sendEmailVerification() {
          throw new Error("smtp token delivery failed with reset-token");
        },
        sendEmailChangeVerification() {
          throw new Error("smtp token delivery failed with reset-token");
        },
        sendPasswordReset() {
          throw new Error("smtp token delivery failed with reset-token");
        },
      },
    }),
  });
  t.after(() => app.close());

  const known = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "delivery-fail@example.com" },
  });
  const unknown = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "unknown-delivery-fail@example.com" },
  });

  assert.equal(known.statusCode, 202);
  assert.equal(unknown.statusCode, 202);
  assert.deepEqual(known.json(), { status: "pending" });
  assert.deepEqual(unknown.json(), { status: "pending" });
  assertNoSensitiveAuthMaterial(known.json());
  assertNoSensitiveAuthMaterial(unknown.json());
  assert.equal(JSON.stringify(known.json()).includes("reset-token"), false);
});

test("password reset preserves enabled MFA state", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "reset-mfa",
    email: "reset-mfa@example.com",
    roles: ["user"],
  });
  const enrollment = await enrollTotp(app, session);
  await confirmTotp(app, session, enrollment);

  const request = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "reset-mfa@example.com" },
  });
  assert.equal(request.statusCode, 202);
  assert.equal(outbox.passwordResets.length, 1);

  const reset = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "new correct horse battery staple",
    },
  });
  assert.equal(reset.statusCode, 200);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "reset-mfa@example.com",
      password: "new correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);
  assert.equal(typeof login.json().challengeToken, "string");
  assert.equal(login.json().token, undefined);
});

test("authenticated password changes revoke existing credentials", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "password-change",
    email: "password-change@example.com",
    roles: ["user"],
  });

  const changed = await app.inject({
    method: "POST",
    url: "/v1/auth/account/password",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      currentPassword: "correct horse battery staple",
      password: "new correct horse battery staple",
    },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json(), { status: "changed" });

  const revokedSession = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(revokedSession.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "password-change@example.com",
      password: "new correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, false);
});

test("email changes require current password and new email verification", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, { notificationSink: outbox.sink }),
  });
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "email-change",
    email: "old-email@example.com",
    roles: ["user"],
  });

  const requested = await app.inject({
    method: "POST",
    url: "/v1/auth/account/email-change",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      email: "New-Email@Example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(requested.statusCode, 202);
  assert.deepEqual(requested.json(), { status: "pending" });
  assert.equal(outbox.emailChanges.length, 1);
  assert.equal(outbox.emailChanges[0].email, "new-email@example.com");

  const confirmed = await app.inject({
    method: "POST",
    url: "/v1/auth/email-change/confirm",
    payload: { token: outbox.emailChanges[0].token },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(confirmed.json(), { status: "changed" });

  const revokedSession = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(revokedSession.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "new-email@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
});

test("MFA reset replaces old TOTP factors and removal revokes credentials", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const setupSession = await addAndLogin(app, authStore, {
    id: "mfa-reset",
    email: "mfa-reset@example.com",
    roles: ["user"],
  });
  const firstEnrollment = await enrollTotp(app, setupSession);
  const firstConfirmation = await confirmTotp(app, setupSession, firstEnrollment);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "mfa-reset@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: firstConfirmation.recoveryCodes[0],
    },
  });
  assert.equal(verified.statusCode, 200);
  const verifiedSession = verified.json().token;
  const verifiedCookie = firstSetCookie(verified.headers["set-cookie"], "myskills_session");
  assert.match(verifiedCookie, /HttpOnly/);
  assert.match(verifiedCookie, /SameSite=Lax/);

  const mfaMeFromCookie = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie: verifiedCookie.split(";")[0] },
  });
  assert.equal(mfaMeFromCookie.statusCode, 200);
  assert.equal(mfaMeFromCookie.json().user.mfaVerified, true);

  const secondEnrollment = await enrollTotp(app, verifiedSession);
  await confirmTotp(app, verifiedSession, secondEnrollment);
  const status = await app.inject({
    method: "GET",
    url: "/v1/auth/mfa",
    headers: { authorization: `Bearer ${verifiedSession}` },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().mfa.totpEnabled, true);
  assert.equal(status.json().mfa.factors.length, 1);
  assert.equal(status.json().mfa.factors[0].id, secondEnrollment.factorId);

  const removed = await app.inject({
    method: "DELETE",
    url: "/v1/auth/mfa/totp",
    headers: { authorization: `Bearer ${verifiedSession}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().mfa.status, "disabled");
  assert.equal(removed.json().mfa.disabledFactors, 1);

  const revokedSession = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${verifiedSession}` },
  });
  assert.equal(revokedSession.statusCode, 401);
});

test("expired email verification and password reset tokens are denied", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const outbox = createAuthOutbox();
  authStore.addUser({
    email: "expired@example.com",
    status: "active",
    emailVerifiedAt: null,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  authStore.addUser({
    email: "expired-reset@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      notificationSink: outbox.sink,
      emailVerificationTtlMs: -1,
      passwordResetTtlMs: -1,
    }),
  });
  t.after(() => app.close());

  const verificationRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/request",
    payload: { email: "expired@example.com" },
  });
  const resetRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/request",
    payload: { email: "expired-reset@example.com" },
  });
  assert.equal(verificationRequest.statusCode, 202);
  assert.equal(resetRequest.statusCode, 202);

  const verification = await app.inject({
    method: "POST",
    url: "/v1/auth/email-verification/confirm",
    payload: { token: outbox.emailVerifications[0].token },
  });
  const reset = await app.inject({
    method: "POST",
    url: "/v1/auth/password-reset/confirm",
    payload: {
      token: outbox.passwordResets[0].token,
      password: "new correct horse battery staple",
    },
  });

  assert.equal(verification.statusCode, 401);
  assert.equal(verification.json().error.code, "INVALID_VERIFICATION_TOKEN");
  assert.equal(reset.statusCode, 401);
  assert.equal(reset.json().error.code, "INVALID_RESET_TOKEN");
});

test("MFA enrollment requires a session and does not leak stored secret material", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "mfa-user",
    email: "mfa@example.com",
    roles: ["user"],
  });

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      password: "correct horse battery staple",
      label: "Work phone",
    },
  });

  assert.equal(enrollment.statusCode, 201);
  assert.equal(enrollment.json().enrollment.label, "Work phone");
  assert.match(enrollment.json().enrollment.secret, /^[A-Z2-7]{26,}$/);
  assert.equal(enrollment.json().enrollment.otpauthUrl.startsWith("otpauth://totp/"), true);
  assert.equal(JSON.stringify(enrollment.json()).includes("secretCiphertext"), false);
  assert.equal(JSON.stringify(enrollment.json()).includes("codeHash"), false);
});

test("MFA enrollment requires a valid TOTP before enabling recovery codes", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "mfa-invalid",
    email: "mfa-invalid@example.com",
    roles: ["user"],
  });
  const enrollment = await enrollTotp(app, session);

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      factorId: enrollment.factorId,
      code: "000000",
    },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json().error.code, "INVALID_MFA_CODE");

  const status = await app.inject({
    method: "GET",
    url: "/v1/auth/mfa",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().mfa.totpEnabled, false);
  assert.equal(status.json().mfa.recoveryCodesRemaining, 0);
});

test("MFA-enabled users complete login with a challenge and single-use recovery code", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "mfa-recovery",
    email: "mfa-recovery@example.com",
    roles: ["user"],
  });
  const enrollment = await enrollTotp(app, session);
  const confirmed = await confirmTotp(app, session, enrollment);
  const recoveryCode = confirmed.recoveryCodes[0];

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "mfa-recovery@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);
  assert.equal(typeof login.json().challengeToken, "string");
  assert.equal(login.json().token, undefined);

  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode,
    },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(typeof verified.json().token, "string");
  assert.equal(verified.json().user.mfaVerified, true);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${verified.json().token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.mfaVerified, true);

  const secondLogin = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "mfa-recovery@example.com",
      password: "correct horse battery staple",
    },
  });
  const replay = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: secondLogin.json().challengeToken,
      recoveryCode,
    },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, "INVALID_MFA_CODE");
});

test("MFA challenge verification fails closed when the challenge was already claimed", async (t) => {
  class LostChallengeClaimStore extends MemoryAuthStore {
    override async markMfaChallengeUsed(): Promise<boolean> {
      return false;
    }
  }

  const authStore = new LostChallengeClaimStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "mfa-race",
    email: "mfa-race@example.com",
    roles: ["user"],
  });
  const enrollment = await enrollTotp(app, session);
  const confirmed = await confirmTotp(app, session, enrollment);

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "mfa-race@example.com",
      password: "correct horse battery staple",
    },
  });
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirmed.recoveryCodes[0],
    },
  });

  assert.equal(login.statusCode, 200);
  assert.equal(verified.statusCode, 401);
  assert.equal(verified.json().error.code, "INVALID_MFA_CODE");
});

test("MFA-enabled users can complete login with TOTP", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAuthApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "mfa-totp",
    email: "mfa-totp@example.com",
    roles: ["user"],
  });
  const enrollment = await enrollTotp(app, session);
  await confirmTotp(app, session, enrollment);

  const originalDateNow = Date.now;
  t.after(() => {
    Date.now = originalDateNow;
  });
  Date.now = () => originalDateNow() + 30_000;

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "mfa-totp@example.com",
      password: "correct horse battery staple",
    },
  });
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    headers: { "x-myskills-session-response": "cookie" },
    payload: {
      challengeToken: login.json().challengeToken,
      code: generateTotpCode(enrollment.secret),
    },
  });

  assert.equal(login.statusCode, 200);
  assert.equal(login.json().mfaRequired, true);
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().token, undefined);
  assert.equal(verified.json().user.mfaVerified, true);
});

test("disabled users cannot keep using existing sessions", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    id: "user-disabled-later",
    email: "active@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "active@example.com",
      password: "correct horse battery staple",
    },
  });
  const token = login.json().token;
  authStore.setUserStatus("active@example.com", "disabled");

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(me.statusCode, 401);
});

test("deleted users cannot keep using existing sessions", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    id: "user-deleted-later",
    email: "active@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "active@example.com",
      password: "correct horse battery staple",
    },
  });
  const token = login.json().token;
  authStore.setUserStatus("active@example.com", "deleted");

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(me.statusCode, 401);
});

test("login uses a generic denial for wrong passwords", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    email: "active@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "active@example.com",
      password: "incorrect horse battery staple",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "INVALID_CREDENTIALS");
});

test("login uses a generic denial for malformed passwords", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    email: "active@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "active@example.com",
      password: "short",
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "INVALID_CREDENTIALS");
});

test("login attempts are rate limited before repeated password checks", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const passwordHash = await hashPassword("correct horse battery staple");
  authStore.addUser({
    email: "active@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    passwordHash,
  });
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      loginLimiter: new MemoryAuthRateLimiter({ maxAttempts: 2, windowMs: 60_000 }),
    }),
  });
  t.after(() => app.close());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "203.0.113.10",
      payload: {
        email: "active@example.com",
        password: "incorrect horse battery staple",
      },
    });
    assert.equal(response.statusCode, 401);
  }

  const limited = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    remoteAddress: "203.0.113.10",
    payload: {
      email: "active@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
});

test("registration attempts are rate limited before repeated hashing", async (t) => {
  const authStore = new MemoryAuthStore("request");
  const app = buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore, {
      registrationLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
    }),
  });
  t.after(() => app.close());

  const first = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    remoteAddress: "203.0.113.11",
    payload: {
      email: "new@example.com",
      password: "correct horse battery staple",
    },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    remoteAddress: "203.0.113.11",
    payload: {
      email: "new@example.com",
      password: "correct horse battery staple",
    },
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 429);
  assert.equal(second.json().error.code, "RATE_LIMITED");
});

function buildAuthApp(authStore: MemoryAuthStore) {
  return buildApp({
    skillRepository: emptySkillRepository(),
    authService: new AuthService(authStore),
  });
}

function createAuthOutbox(): {
  sink: AuthNotificationSink;
  emailVerifications: Array<{ email: string; token: string; expiresAt: Date }>;
  emailChanges: Array<{ email: string; token: string; expiresAt: Date }>;
  passwordResets: Array<{ email: string; token: string; expiresAt: Date }>;
  registrationInvitations: Array<{ email: string; token: string; expiresAt: Date }>;
} {
  const emailVerifications: Array<{ email: string; token: string; expiresAt: Date }> = [];
  const emailChanges: Array<{ email: string; token: string; expiresAt: Date }> = [];
  const passwordResets: Array<{ email: string; token: string; expiresAt: Date }> = [];
  const registrationInvitations: Array<{ email: string; token: string; expiresAt: Date }> = [];
  return {
    sink: {
      sendEmailVerification(input) {
        emailVerifications.push({
          email: input.email,
          token: input.token,
          expiresAt: input.expiresAt,
        });
      },
      sendEmailChangeVerification(input) {
        emailChanges.push({
          email: input.email,
          token: input.token,
          expiresAt: input.expiresAt,
        });
      },
      sendPasswordReset(input) {
        passwordResets.push({
          email: input.email,
          token: input.token,
          expiresAt: input.expiresAt,
        });
      },
      sendRegistrationInvitation(input) {
        registrationInvitations.push({
          email: input.email,
          token: input.token,
          expiresAt: input.expiresAt,
        });
      },
    },
    emailVerifications,
    emailChanges,
    passwordResets,
    registrationInvitations,
  };
}

function assertNoSensitiveAuthMaterial(input: unknown): void {
  const serialized = JSON.stringify(input);
  for (const value of ["passwordHash", "tokenHash", "verificationToken", "resetToken", "secretCiphertext"]) {
    assert.equal(serialized.includes(value), false);
  }
}

async function addAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id?: string;
    email: string;
    roles?: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles ?? ["user"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: input.email,
      password: "correct horse battery staple",
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mfaRequired, false);
  return response.json().token;
}

async function enrollTotp(app: ReturnType<typeof buildApp>, session: string): Promise<{ factorId: string; secret: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(response.statusCode, 201);
  return {
    factorId: response.json().enrollment.factorId,
    secret: response.json().enrollment.secret,
  };
}

async function confirmTotp(
  app: ReturnType<typeof buildApp>,
  session: string,
  enrollment: { factorId: string; secret: string },
): Promise<{ recoveryCodes: string[] }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      factorId: enrollment.factorId,
      code: generateTotpCode(enrollment.secret),
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mfa.factor.status, "enabled");
  assert.equal(response.json().mfa.recoveryCodes.length, 10);
  assert.equal(JSON.stringify(response.json()).includes("codeHash"), false);
  return {
    recoveryCodes: response.json().mfa.recoveryCodes,
  };
}

function firstSetCookie(header: string | string[] | number | undefined, name: string): string {
  const values = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  assert.equal(typeof cookie, "string");
  return cookie;
}

class FailingPasswordResetStore extends MemoryAuthStore {
  private failNextReset = true;

  override async completePasswordReset(input: CompletePasswordResetInput): Promise<boolean> {
    if (this.failNextReset) {
      this.failNextReset = false;
      throw new Error("Injected reset failure.");
    }
    return super.completePasswordReset(input);
  }
}
