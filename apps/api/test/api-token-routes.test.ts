import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashApiToken, hashPassword, hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("session users can create, list, use, and revoke scoped API tokens", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "author-1",
    email: "author@example.com",
    roles: ["author"],
  });

  const create = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      name: "Local CLI",
      scopes: ["profile:read", "skills:submit"],
    },
  });
  assert.equal(create.statusCode, 201);
  const token = create.json().token as {
    id: string;
    token: string;
    tokenPrefix: string;
    scopes: string[];
    lastUsedAt: string | null;
  };
  assert.equal(token.token.startsWith("aiss_"), true);
  assert.equal(token.tokenPrefix, token.token.slice(0, 12));
  assert.deepEqual(token.scopes, ["profile:read", "skills:submit"]);
  assert.equal(token.lastUsedAt, null);
  assert.equal(JSON.stringify(create.json()).includes("tokenHash"), false);

  const stored = await authStore.findUserByApiTokenHash(hashApiToken(token.token));
  assert.equal(stored?.id, "author-1");
  assert.deepEqual(stored?.apiTokenScopes, ["profile:read", "skills:submit"]);
  assert.equal(await authStore.findUserByApiTokenHash(hashApiToken(`${token.tokenPrefix}wrong-secret`)), null);

  const me = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.id, "author-1");
  assert.equal(JSON.stringify(me.json()).includes("apiTokenScopes"), false);

  const list = await app.inject({
    method: "GET",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().tokens[0].id, token.id);
  assert.equal(list.json().tokens[0].lastUsedAt.length > 0, true);
  assert.equal(JSON.stringify(list.json()).includes(token.token), false);
  assert.equal(JSON.stringify(list.json()).includes(hashApiToken(token.token)), false);

  const revoke = await app.inject({
    method: "DELETE",
    url: `/v1/auth/api-tokens/${token.id}`,
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.json().token.revokedAt.length > 0, true);

  const revoked = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(revoked.statusCode, 401);
});

test("API token management requires a session, not another API token", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    email: "owner@example.com",
    roles: ["owner"],
  });
  const token = await createApiToken(app, session, ["profile:read"]);

  for (const request of [
    { method: "GET", url: "/v1/auth/api-tokens" },
    { method: "POST", url: "/v1/auth/api-tokens", payload: { name: "Nested", scopes: ["profile:read"] } },
    { method: "DELETE", url: `/v1/auth/api-tokens/${token.id}` },
  ] as const) {
    const response = await app.inject({
      ...request,
      headers: { authorization: `Bearer ${token.token}` },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "SESSION_AUTH_REQUIRED");
  }

  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(logout.statusCode, 204);
  const stillWorks = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(stillWorks.statusCode, 200);
});

test("API token scopes gate protected routes separately from roles", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const submissionStore = new MemorySubmissionStore();
  const app = buildTokenApp(authStore, submissionStore);
  t.after(() => app.close());
  const authorSession = await addAndLogin(app, authStore, {
    email: "author@example.com",
    roles: ["author"],
  });
  const userSession = await addAndLogin(app, authStore, {
    email: "user@example.com",
    roles: ["user"],
  });
  const maintainerSession = await addAndLoginWithMfa(app, authStore, {
    email: "maintainer@example.com",
    roles: ["maintainer"],
  });
  const profileOnly = await createApiToken(app, authorSession, ["profile:read"]);
  const authorSubmit = await createApiToken(app, authorSession, ["skills:submit"]);
  const userSubmit = await createApiToken(app, userSession, ["skills:submit"]);
  const unverifiedMaintainerSession = await addAndLogin(app, authStore, {
    email: "unverified-maintainer@example.com",
    roles: ["maintainer"],
  });
  const unverifiedMaintainerSubmit = await createApiToken(app, unverifiedMaintainerSession, ["skills:submit"]);
  const reviewRead = await createApiToken(app, maintainerSession, ["review:read"]);
  const reviewWrite = await createApiToken(app, maintainerSession, ["review:write"]);

  const missingScope = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${profileOnly.token}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(missingScope.statusCode, 403);
  assert.equal(missingScope.json().error.code, "API_TOKEN_SCOPE_REQUIRED");
  assert.equal(submissionStore.count(), 0);

  const missingRole = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${userSubmit.token}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(missingRole.statusCode, 403);
  assert.equal(missingRole.json().error.code, "SUBMISSION_ROLE_REQUIRED");
  assert.equal(submissionStore.count(), 0);

  const submitted = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorSubmit.token}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitted.statusCode, 202);
  assert.equal(submissionStore.count(), 1);

  const missingMfa = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${unverifiedMaintainerSubmit.token}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(missingMfa.statusCode, 403);
  assert.equal(missingMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");
  assert.equal(submissionStore.count(), 1);

  const reviewList = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${reviewRead.token}` },
  });
  assert.equal(reviewList.statusCode, 200);
  assert.equal(reviewList.json().submissions.length, 1);

  const writeWithReadOnly = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submitted.json().submission.id}/actions`,
    headers: { authorization: `Bearer ${reviewRead.token}` },
    payload: { action: "approve" },
  });
  assert.equal(writeWithReadOnly.statusCode, 403);
  assert.equal(writeWithReadOnly.json().error.code, "API_TOKEN_SCOPE_REQUIRED");

  const readWithWriteOnly = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${reviewWrite.token}` },
  });
  assert.equal(readWithWriteOnly.statusCode, 403);
  assert.equal(readWithWriteOnly.json().error.code, "API_TOKEN_SCOPE_REQUIRED");

  const approved = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submitted.json().submission.id}/actions`,
    headers: { authorization: `Bearer ${reviewWrite.token}` },
    payload: { action: "approve" },
  });
  assert.equal(approved.statusCode, 200);
});

test("review API tokens require MFA-verified maintainer sessions at creation", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    email: "maintainer@example.com",
    roles: ["maintainer"],
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      name: "Review token",
      scopes: ["review:write"],
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "MFA_VERIFICATION_REQUIRED");
});

test("MCP session requires an API token with skills read scope", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "reader-1",
    email: "reader@example.com",
    roles: ["user"],
  });
  const readToken = await createApiToken(app, session, ["skills:read"]);
  const profileToken = await createApiToken(app, session, ["profile:read"]);

  const missing = await app.inject({ method: "GET", url: "/v1/mcp/session" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error.code, "AUTHENTICATION_REQUIRED");

  const sessionDenied = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(sessionDenied.statusCode, 403);
  assert.equal(sessionDenied.json().error.code, "API_TOKEN_AUTH_REQUIRED");

  const wrongScope = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${profileToken.token}` },
  });
  assert.equal(wrongScope.statusCode, 403);
  assert.equal(wrongScope.json().error.code, "API_TOKEN_SCOPE_REQUIRED");

  const allowed = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${readToken.token}` },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().user.id, "reader-1");
  assert.equal(allowed.json().credential.kind, "api_token");
  assert.equal(allowed.json().credential.tokenId, readToken.id);
  assert.deepEqual(allowed.json().credential.scopes, ["skills:read"]);
  assert.equal(JSON.stringify(allowed.json()).includes(readToken.token), false);
  assert.equal(JSON.stringify(allowed.json()).includes(hashApiToken(readToken.token)), false);

  authStore.setUserStatus("reader@example.com", "disabled");
  const disabled = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${readToken.token}` },
  });
  assert.equal(disabled.statusCode, 401);
});

test("MCP session writes sanitized audit events for allow and deny decisions", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    id: "reader-1",
    email: "reader@example.com",
    roles: ["user"],
  });
  const readToken = await createApiToken(app, session, ["skills:read"]);
  const profileToken = await createApiToken(app, session, ["profile:read"]);

  const missing = await app.inject({ method: "GET", url: "/v1/mcp/session" });
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.json().error.code, "AUTHENTICATION_REQUIRED");

  const invalid = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: "Bearer aiss_test_secret" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json().error.code, "AUTHENTICATION_REQUIRED");

  const sessionDenied = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(sessionDenied.statusCode, 403);
  assert.equal(sessionDenied.json().error.code, "API_TOKEN_AUTH_REQUIRED");

  const wrongScope = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${profileToken.token}` },
  });
  assert.equal(wrongScope.statusCode, 403);
  assert.equal(wrongScope.json().error.code, "API_TOKEN_SCOPE_REQUIRED");

  const allowed = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${readToken.token}` },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().credential.tokenId, readToken.id);

  authStore.setUserStatus("reader@example.com", "disabled");
  const disabled = await app.inject({
    method: "GET",
    url: "/v1/mcp/session",
    headers: { authorization: `Bearer ${readToken.token}` },
  });
  assert.equal(disabled.statusCode, 401);

  const events = await authStore.listAuditEvents({ limit: 10 });
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((event) => event.action), [
    "mcp.session",
    "mcp.session",
    "mcp.session",
    "mcp.session",
    "mcp.session",
    "mcp.session",
  ]);
  assert.deepEqual(events.map((event) => event.resourceType), [
    "mcp_session",
    "mcp_session",
    "mcp_session",
    "mcp_session",
    "mcp_session",
    "mcp_session",
  ]);
  assert.deepEqual(events.map((event) => event.details.reason).sort(), [
    "api_credential_required",
    "authorized",
    "invalid_bearer",
    "invalid_bearer",
    "missing_bearer",
    "missing_scope",
  ]);
  assert.equal(events.some((event) => event.decision === "allow" && event.actorUserId === "reader-1"), true);
  assert.equal(events.some((event) => event.decision === "deny" && event.details.credentialKind === "session"), true);
  assert.equal(events.some((event) => event.decision === "deny" && event.details.credentialKind === "api"), true);
  assert.equal(events.some((event) => event.decision === "deny" && event.details.credentialKind === "none"), true);
  assert.equal(events.every((event) => event.details.endpoint === "/v1/mcp/session"), true);
  assert.equal(events.every((event) => event.details.requiredScope === "skills:read"), true);

  const serialized = JSON.stringify(events);
  for (const forbidden of [
    session,
    readToken.token,
    profileToken.token,
    hashSessionToken(session),
    hashApiToken(readToken.token),
    hashApiToken(profileToken.token),
    "aiss_test_secret",
    "tokenHash",
    "Authorization",
    "Bearer",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(serialized.includes("credentialKind"), true);
  assert.equal(serialized.includes("missing_scope"), true);

  const ownerSession = await addAndLoginWithMfa(app, authStore, {
    id: "owner-1",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const adminAudit = await app.inject({
    method: "GET",
    url: "/v1/admin/audit?limit=10",
    headers: { authorization: `Bearer ${ownerSession}` },
  });
  assert.equal(adminAudit.statusCode, 200);
  assert.equal(adminAudit.json().events.some((event: { action: string }) => event.action === "mcp.session"), true);
  const externalSerialized = JSON.stringify(adminAudit.json());
  for (const forbidden of [
    session,
    ownerSession,
    readToken.token,
    profileToken.token,
    hashSessionToken(session),
    hashSessionToken(ownerSession),
    hashApiToken(readToken.token),
    hashApiToken(profileToken.token),
    "aiss_test_secret",
    "tokenHash",
    "Authorization",
    "Bearer",
  ]) {
    assert.equal(externalSerialized.includes(forbidden), false);
  }
  assert.equal(externalSerialized.includes("mcp.session"), true);
  assert.equal(externalSerialized.includes("requiredScope"), true);
});

test("disabled users cannot keep using API tokens", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    email: "active@example.com",
    roles: ["user"],
  });
  const token = await createApiToken(app, session, ["profile:read"]);

  authStore.setUserStatus("active@example.com", "disabled");

  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { authorization: `Bearer ${token.token}` },
  });
  assert.equal(response.statusCode, 401);
});

test("invalid API token requests are rejected", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildTokenApp(authStore);
  t.after(() => app.close());
  const session = await addAndLogin(app, authStore, {
    email: "owner@example.com",
    roles: ["owner"],
  });

  for (const payload of [
    { name: "", scopes: ["profile:read"] },
    { name: "Empty scopes", scopes: [] },
    { name: "Unknown scope", scopes: ["admin:all"] },
    { name: "Past expiry", scopes: ["profile:read"], expiresAt: new Date(Date.now() - 1000).toISOString() },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/api-tokens",
      headers: { authorization: `Bearer ${session}` },
      payload,
    });
    assert.equal(response.statusCode, 400);
  }
});

function buildTokenApp(authStore: MemoryAuthStore, submissionStore = new MemorySubmissionStore()) {
  return buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    submissionService: new SubmissionService(submissionStore),
  });
}

async function addAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id?: string;
    email: string;
    roles: Array<"owner" | "admin" | "maintainer" | "author" | "user">;
  },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles,
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

async function addAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: {
    id?: string;
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
): Promise<{ id: string; token: string }> {
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
  return {
    id: response.json().token.id,
    token: response.json().token.token,
  };
}

function cleanSubmissionPayload() {
  return {
    manifest: {
      name: "release-notes-helper",
      title: "Release Notes Helper",
      summary: "Turns merged changes into concise release notes.",
      version: "0.1.0",
      license: "Apache-2.0",
      visibility: "public",
      platforms: [{ name: "codex", install_target: "codex-skill" }],
      tags: ["writing", "release"],
    },
    files: [
      {
        path: "skill.json",
        content: JSON.stringify({
          name: "release-notes-helper",
          title: "Release Notes Helper",
          summary: "Turns merged changes into concise release notes.",
          version: "0.1.0",
          license: "Apache-2.0",
          visibility: "public",
          platforms: [{ name: "codex", install_target: "codex-skill" }],
          tags: ["writing", "release"],
        }),
      },
      {
        path: "README.md",
        content: "Summarize release notes.",
      },
    ],
  };
}
