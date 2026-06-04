import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "@ai-skills-share/auth";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
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
  assert.equal(login.json().user.email, "active@example.com");

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, "user-active");
  assert.deepEqual(me.json().user.roles, ["user", "author"]);

  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(logout.statusCode, 204);

  const revoked = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(revoked.statusCode, 401);
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
