import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

test("MFA-verified admins can manage registration mode", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });

  const readClosed = await app.inject({
    method: "GET",
    url: "/v1/admin/registration",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(readClosed.statusCode, 200);
  assert.deepEqual(readClosed.json(), { registration: { mode: "closed" } });

  const setRequest = await app.inject({
    method: "PUT",
    url: "/v1/admin/registration",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { mode: "request" },
  });
  assert.equal(setRequest.statusCode, 200);
  assert.deepEqual(setRequest.json(), { registration: { mode: "request" } });
  assert.equal(await authStore.getRegistrationMode(), "request");

  const registerAllowed = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "new@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(registerAllowed.statusCode, 202);

  const invalid = await app.inject({
    method: "PUT",
    url: "/v1/admin/registration",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { mode: "invite-only" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_REGISTRATION_MODE");
  assert.equal(await authStore.getRegistrationMode(), "request");

  const setClosed = await app.inject({
    method: "PUT",
    url: "/v1/admin/registration",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { mode: "closed" },
  });
  assert.equal(setClosed.statusCode, 200);
  assert.equal(await authStore.getRegistrationMode(), "closed");

  const registerDenied = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: "closed@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(registerDenied.statusCode, 403);
  assert.equal(registerDenied.json().error.code, "REGISTRATION_CLOSED");
});

test("MFA-verified admins can manage non-secret provider configs and role mappings", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  await addUser(authStore, {
    id: "existing-1",
    email: "existing@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });

  const secretFields = {
    clientSecret: "must-not-be-stored",
    client_secret: "must-not-be-stored-underscore",
    "client-secret": "must-not-be-stored-hyphen",
    private_key: "must-not-be-stored-private",
    apiKey: "must-not-be-stored-api-key",
  };
  for (const [field, value] of Object.entries(secretFields)) {
    const secretRejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/providers/cloudflare-main",
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: {
        type: "cloudflare_access",
        displayName: "Cloudflare Access",
        issuer: "https://team.cloudflareaccess.com",
        clientId: "public-client-id",
        [field]: value,
        roleMappings: [],
      },
    });
    assert.equal(secretRejected.statusCode, 400);
    assert.equal(secretRejected.json().error.code, "UNSUPPORTED_PROVIDER_SECRET_FIELD");
    assert.equal(JSON.stringify(secretRejected.json()).includes(value), false);
  }

  for (const role of ["admin", "owner"]) {
    const elevatedRoleRejected = await app.inject({
      method: "PUT",
      url: "/v1/admin/providers/cloudflare-main",
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: {
        type: "cloudflare_access",
        displayName: "Cloudflare Access",
        issuer: "https://team.cloudflareaccess.com",
        clientId: "public-client-id",
        roleMappings: [{ claim: "groups", value: "platform-admins", role }],
      },
    });
    assert.equal(elevatedRoleRejected.statusCode, 400);
    assert.equal(elevatedRoleRejected.json().error.code, "INVALID_PROVIDER_ROLE_MAPPING");
  }

  const upsert = await app.inject({
    method: "PUT",
    url: "/v1/admin/providers/cloudflare-main",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      type: "cloudflare_access",
      displayName: "Cloudflare Access",
      issuer: "https://team.cloudflareaccess.com",
      clientId: "public-client-id",
      enabled: true,
      roleMappings: [
        { claim: "groups", value: "skills-maintainers", role: "maintainer" },
        { claim: "email_domain", value: "example.com", role: "user" },
      ],
    },
  });
  assert.equal(upsert.statusCode, 200);
  assert.deepEqual(upsert.json().provider, {
    key: "cloudflare-main",
    type: "cloudflare_access",
    displayName: "Cloudflare Access",
    issuer: "https://team.cloudflareaccess.com",
    clientId: "public-client-id",
    enabled: true,
    roleMappings: [
      { claim: "email_domain", value: "example.com", role: "user" },
      { claim: "groups", value: "skills-maintainers", role: "maintainer" },
    ],
  });

  const list = await app.inject({
    method: "GET",
    url: "/v1/admin/providers",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { providers: [upsert.json().provider] });

  const users = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(users.statusCode, 200);
  const existing = users.json().users.find((user: { id: string }) => user.id === "existing-1");
  assert.deepEqual(existing.roles, ["user"]);

  const audit = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=5",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().events.some((event: { action: string }) => event.action === "admin.provider.upsert"), true);

  const serialized = JSON.stringify({ list: list.json(), audit: audit.json() });
  for (const forbidden of [
    "clientSecret",
    "client_secret",
    "client-secret",
    "apiKey",
    "must-not-be-stored",
    "secret",
    "tokenHash",
    "privateKey",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("admin user list returns deterministic safe fields only", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  await addUser(authStore, {
    id: "admin-1",
    email: "admin@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["admin"],
  });
  await addUser(authStore, {
    id: "pending-1",
    email: "pending@example.com",
    status: "pending",
    emailVerifiedAt: null,
    roles: ["user"],
  });
  await addUser(authStore, {
    id: "disabled-1",
    email: "disabled@example.com",
    status: "disabled",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${ownerSession}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().users.map((user: { email: string }) => user.email), [
    "admin@example.com",
    "disabled@example.com",
    "owner@example.com",
    "pending@example.com",
  ]);
  const serialized = JSON.stringify(response.json());
  for (const forbidden of ["passwordHash", "tokenHash", "secretCiphertext", "codeHash", "normalizedEmail"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  for (const user of response.json().users as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(user).sort(), ["email", "emailVerified", "id", "mfaEnabled", "name", "roles", "status"]);
  }
});

test("admins can approve, disable, activate, and delete users without preserving old credentials", async (t) => {
  const authStore = new MemoryAuthStore("request");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  await addUser(authStore, {
    id: "pending-1",
    email: "pending@example.com",
    status: "pending",
    emailVerifiedAt: null,
    roles: ["user"],
  });
  const activeSession = await addAndLogin(app, authStore, {
    id: "active-1",
    email: "active@example.com",
    roles: ["user"],
  });
  const activeApiToken = await createApiToken(app, activeSession, ["profile:read"]);

  const approve = await app.inject({
    method: "POST",
    url: "/v1/admin/users/pending-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "approve" },
  });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().user.status, "active");
  assert.equal(approve.json().user.emailVerified, false);
  assert.equal((await authStore.findUserById("pending-1"))?.status, "active");

  const disable = await app.inject({
    method: "POST",
    url: "/v1/admin/users/active-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "disable" },
  });
  assert.equal(disable.statusCode, 200);
  assert.equal(disable.json().user.status, "disabled");
  assert.equal((await authStore.findUserById("active-1"))?.status, "disabled");

  const oldSessionDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${activeSession}` },
  });
  assert.equal(oldSessionDenied.statusCode, 401);
  const oldApiTokenDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${activeApiToken}` },
  });
  assert.equal(oldApiTokenDenied.statusCode, 401);

  const activate = await app.inject({
    method: "POST",
    url: "/v1/admin/users/active-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "activate" },
  });
  assert.equal(activate.statusCode, 200);
  assert.equal(activate.json().user.status, "active");
  const oldApiTokenStillDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${activeApiToken}` },
  });
  assert.equal(oldApiTokenStillDenied.statusCode, 401);

  const deletedSession = await addAndLogin(app, authStore, {
    id: "delete-1",
    email: "delete@example.com",
    roles: ["user"],
  });
  const deleted = await app.inject({
    method: "POST",
    url: "/v1/admin/users/delete-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "delete" },
  });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().user.status, "deleted");
  const deletedSessionDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${deletedSession}` },
  });
  assert.equal(deletedSessionDenied.statusCode, 401);
});

test("owners can update user roles with audit and immediate authorization changes", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const targetSession = await addAndLogin(app, authStore, {
    id: "target-1",
    email: "target@example.com",
    roles: ["user"],
  });
  const targetApiToken = await createApiToken(app, targetSession, ["profile:read"]);

  const update = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/target-1/roles",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { roles: ["maintainer", "author", "author"], reason: "approved contributor" },
  });
  assert.equal(update.statusCode, 200);
  assert.deepEqual(update.json().user.roles, ["maintainer", "author"]);
  assert.deepEqual((await authStore.findUserById("target-1"))?.roles, ["maintainer", "author"]);

  const revokedSessionDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${targetSession}` },
  });
  assert.equal(revokedSessionDenied.statusCode, 401);
  const revokedApiTokenDenied = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${targetApiToken}` },
  });
  assert.equal(revokedApiTokenDenied.statusCode, 401);

  const audit = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=1",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().events[0].action, "admin.user.roles.update");
  assert.deepEqual(audit.json().events[0].details.rolesBefore, ["user"]);
  assert.deepEqual(audit.json().events[0].details.rolesAfter, ["maintainer", "author"]);
  assert.equal(audit.json().events[0].details.credentialsRevoked, true);
});

test("role updates enforce owner, self-lockout, deleted-user, and invalid-role safeguards", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const adminSession = await addAndLoginWithMfa(app, authStore, {
    id: "admin-1",
    email: "admin@example.com",
    roles: ["admin"],
  });
  await addUser(authStore, {
    id: "target-1",
    email: "target@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });
  await addUser(authStore, {
    id: "deleted-1",
    email: "deleted@example.com",
    status: "deleted",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });

  const adminGrantOwner = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/target-1/roles",
    headers: { authorization: `Bearer ${adminSession}` },
    payload: { roles: ["owner"] },
  });
  assert.equal(adminGrantOwner.statusCode, 403);
  assert.equal(adminGrantOwner.json().error.code, "OWNER_ROLE_UPDATE_REQUIRES_OWNER");
  assert.deepEqual((await authStore.findUserById("target-1"))?.roles, ["user"]);

  const selfChange = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/owner-1/roles",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { roles: ["owner", "admin"] },
  });
  assert.equal(selfChange.statusCode, 409);
  assert.equal(selfChange.json().error.code, "SELF_ROLE_CHANGE_PREVENTED");

  const deleted = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/deleted-1/roles",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { roles: ["author"] },
  });
  assert.equal(deleted.statusCode, 409);
  assert.equal(deleted.json().error.code, "USER_DELETED");

  const lastOwner = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/owner-1/roles",
    headers: { authorization: `Bearer ${adminSession}` },
    payload: { roles: ["user"] },
  });
  assert.equal(lastOwner.statusCode, 403);
  assert.equal(lastOwner.json().error.code, "OWNER_ROLE_UPDATE_REQUIRES_OWNER");

  const invalid = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/target-1/roles",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { roles: [] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_ADMIN_USER_ROLES");
});

test("admin user actions reject missing users and invalid actions without mutation", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  await addUser(authStore, {
    id: "target-1",
    email: "target@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });
  await addUser(authStore, {
    id: "deleted-1",
    email: "deleted@example.com",
    status: "deleted",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });

  const missing = await app.inject({
    method: "POST",
    url: "/v1/admin/users/missing/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "disable" },
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "USER_NOT_FOUND");

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/admin/users/target-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "demote" },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "INVALID_ADMIN_USER_ACTION");
  assert.equal((await authStore.findUserById("target-1"))?.status, "active");

  const restoreDeleted = await app.inject({
    method: "POST",
    url: "/v1/admin/users/deleted-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { action: "activate" },
  });
  assert.equal(restoreDeleted.statusCode, 409);
  assert.equal(restoreDeleted.json().error.code, "USER_DELETED");
  assert.equal((await authStore.findUserById("deleted-1"))?.status, "deleted");
});

test("admin routes require session auth, admin role, and MFA", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSessionWithoutMfa = await addAndLogin(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const userSessionWithMfa = await addAndLoginWithMfa(app, authStore, {
    id: "user-1",
    email: "user@example.com",
    roles: ["user"],
  });
  const ownerApiToken = await createApiToken(app, ownerSessionWithoutMfa, ["profile:read"]);
  const userApiToken = await createApiToken(app, userSessionWithMfa, ["profile:read"]);

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

  const apiTokenDenied = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${userApiToken}` },
  });
  assert.equal(apiTokenDenied.statusCode, 403);
  assert.equal(apiTokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");

  const mfaRequired = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${ownerSessionWithoutMfa}` },
  });
  assert.equal(mfaRequired.statusCode, 403);
  assert.equal(mfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const roleRequired = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${userSessionWithMfa}` },
  });
  assert.equal(roleRequired.statusCode, 403);
  assert.equal(roleRequired.json().error.code, "ADMIN_ROLE_REQUIRED");

  const auditApiTokenDenied = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: { authorization: `Bearer ${userApiToken}` },
  });
  assert.equal(auditApiTokenDenied.statusCode, 403);
  assert.equal(auditApiTokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");

  const auditMfaRequired = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: { authorization: `Bearer ${ownerSessionWithoutMfa}` },
  });
  assert.equal(auditMfaRequired.statusCode, 403);
  assert.equal(auditMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const auditRoleRequired = await app.inject({
    method: "GET",
    url: "/v1/admin/audit",
    headers: { authorization: `Bearer ${userSessionWithMfa}` },
  });
  assert.equal(auditRoleRequired.statusCode, 403);
  assert.equal(auditRoleRequired.json().error.code, "ADMIN_ROLE_REQUIRED");

  const providerApiTokenDenied = await app.inject({
    method: "GET",
    url: "/v1/admin/providers",
    headers: { authorization: `Bearer ${userApiToken}` },
  });
  assert.equal(providerApiTokenDenied.statusCode, 403);
  assert.equal(providerApiTokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");

  const providerOwnerApiTokenDenied = await app.inject({
    method: "PUT",
    url: "/v1/admin/providers/oidc-main",
    headers: { authorization: `Bearer ${ownerApiToken}` },
    payload: { type: "oidc", displayName: "OIDC", roleMappings: [] },
  });
  assert.equal(providerOwnerApiTokenDenied.statusCode, 403);
  assert.equal(providerOwnerApiTokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");

  const providerMfaRequired = await app.inject({
    method: "PUT",
    url: "/v1/admin/providers/oidc-main",
    headers: { authorization: `Bearer ${ownerSessionWithoutMfa}` },
    payload: { type: "oidc", displayName: "OIDC", roleMappings: [] },
  });
  assert.equal(providerMfaRequired.statusCode, 403);
  assert.equal(providerMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const providerRoleRequired = await app.inject({
    method: "GET",
    url: "/v1/admin/providers",
    headers: { authorization: `Bearer ${userSessionWithMfa}` },
  });
  assert.equal(providerRoleRequired.statusCode, 403);
  assert.equal(providerRoleRequired.json().error.code, "ADMIN_ROLE_REQUIRED");

  const roleUpdateApiTokenDenied = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/user-1/roles",
    headers: { authorization: `Bearer ${ownerApiToken}` },
    payload: { roles: ["author"] },
  });
  assert.equal(roleUpdateApiTokenDenied.statusCode, 403);
  assert.equal(roleUpdateApiTokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");

  const roleUpdateMfaRequired = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/user-1/roles",
    headers: { authorization: `Bearer ${ownerSessionWithoutMfa}` },
    payload: { roles: ["author"] },
  });
  assert.equal(roleUpdateMfaRequired.statusCode, 403);
  assert.equal(roleUpdateMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const roleUpdateRoleRequired = await app.inject({
    method: "PUT",
    url: "/v1/admin/users/user-1/roles",
    headers: { authorization: `Bearer ${userSessionWithMfa}` },
    payload: { roles: ["author"] },
  });
  assert.equal(roleUpdateRoleRequired.statusCode, 403);
  assert.equal(roleUpdateRoleRequired.json().error.code, "ADMIN_ROLE_REQUIRED");
});

test("admins cannot disable or delete their own account", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });

  for (const action of ["disable", "delete"]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/users/owner-1/actions",
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { action },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "SELF_LOCKOUT_PREVENTED");
  }
  assert.equal((await authStore.findUserById("owner-1"))?.status, "active");

  const stillAdmin = await app.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(stillAdmin.statusCode, 200);
});

test("MFA-verified admins can list sanitized audit events newest first", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildAdminApp(authStore);
  t.after(() => app.close());
  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  await addUser(authStore, {
    id: "target-1",
    email: "target@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["user"],
  });
  const fakeVendorToken = ["AT", "ATTfake_token_should_not_persist"].join("");

  const registration = await app.inject({
    method: "PUT",
    url: "/v1/admin/registration",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { mode: "request" },
  });
  assert.equal(registration.statusCode, 200);

  const disable = await app.inject({
    method: "POST",
    url: "/v1/admin/users/target-1/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      action: "disable",
      reason: "reviewed Bearer abcdefghijklmnopqrstuvwxyz and secret before approval",
    },
  });
  assert.equal(disable.statusCode, 200);

  const missing = await app.inject({
    method: "POST",
    url: "/v1/admin/users/missing/actions",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      action: "delete",
      reason: fakeVendorToken,
    },
  });
  assert.equal(missing.statusCode, 404);

  const response = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=2",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().events.length, 2);
  assert.deepEqual(response.json().events.map((event: { action: string; decision: string }) => `${event.action}:${event.decision}`), [
    "admin.user.delete:deny",
    "admin.user.disable:allow",
  ]);

  const all = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=9999",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().events.length >= 3, true);
  assert.equal(all.json().events.some((event: { action: string }) => event.action === "admin.registration.update"), true);

  const minLimit = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=0",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(minLimit.statusCode, 200);
  assert.equal(minLimit.json().events.length, 1);

  const event = response.json().events[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(event).sort(), [
    "action",
    "actorUserId",
    "createdAt",
    "decision",
    "details",
    "id",
    "resourceId",
    "resourceType",
  ]);
  const serialized = JSON.stringify(response.json());
  for (const forbidden of [
    "abcdefghijklmnopqrstuvwxyz",
    fakeVendorToken.slice(0, 8),
    "passwordHash",
    "tokenHash",
    "secretCiphertext",
    "codeHash",
    "normalizedEmail",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes("[redacted]") || serialized.includes("[redacted-token]"), true);
});

function buildAdminApp(authStore: MemoryAuthStore) {
  return buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
  });
}

async function addUser(
  authStore: MemoryAuthStore,
  input: {
    id: string;
    email: string;
    status: "pending" | "active" | "disabled" | "deleted";
    emailVerifiedAt: Date | null;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
) {
  authStore.addUser({
    id: input.id,
    email: input.email,
    status: input.status,
    emailVerifiedAt: input.emailVerifiedAt,
    roles: input.roles,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
}

async function addAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id: string;
    email: string;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  await addUser(authStore, {
    ...input,
    status: "active",
    emailVerifiedAt: new Date(),
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

async function addAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id: string;
    email: string;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  const setupSession = await addAndLogin(app, authStore, input);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      password: "correct horse battery staple",
    },
  });
  assert.equal(enrollment.statusCode, 201);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupSession}` },
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
      email: input.email,
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

async function createApiToken(
  app: ReturnType<typeof buildApp>,
  session: string,
  scopes: string[],
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      name: `Token ${scopes.join(",")}`,
      scopes,
    },
  });
  assert.equal(response.statusCode, 201);
  return response.json().token.token;
}
