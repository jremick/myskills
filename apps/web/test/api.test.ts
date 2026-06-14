import test from "node:test";
import assert from "node:assert/strict";
import {
  createRegistryClient,
  exportCommand,
  safeAdminErrorMessage,
  safeErrorMessage,
  safeReviewErrorMessage,
  safeSubmitErrorMessage,
  type SafeApiError,
} from "../src/api.js";

test("registry client searches skills through the API", async () => {
  const calls: string[] = [];
  const client = createRegistryClient("http://api.test", async (input) => {
    calls.push(String(input));
    return jsonResponse(200, {
      skills: [{ slug: "release-notes-helper", title: "Release Notes Helper" }],
    });
  });

  const skills = await client.searchSkills("release notes");

  assert.equal(calls[0], "http://api.test/v1/skills?q=release%20notes");
  assert.equal(skills[0]?.slug, "release-notes-helper");
});

test("registry client fetches skill and release metadata without bundle content", async () => {
  const calls: string[] = [];
  const client = createRegistryClient("http://api.test", async (input) => {
    calls.push(String(input));
    if (String(input).includes("/releases/")) {
      return jsonResponse(200, { release: { version: "0.1.0", artifact: { sha256: "abc", byteSize: 12 } } });
    }
    return jsonResponse(200, { skill: { slug: "release-notes-helper", latestVersion: "0.1.0" } });
  });

  await client.getSkill("release-notes-helper");
  await client.getRelease("release-notes-helper", "0.1.0");

  assert.deepEqual(calls, [
    "http://api.test/v1/skills/release-notes-helper",
    "http://api.test/v1/skills/release-notes-helper/releases/0.1.0",
  ]);
  assert.equal(calls.some((call) => call.includes("/bundle")), false);
});

test("registry client forwards bearer tokens to authorized registry reads", async () => {
  const calls: Array<{ authorization: string; url: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? "" : (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
      url,
    });
    if (url.includes("/releases/")) {
      return jsonResponse(200, { release: { version: "0.1.0", artifact: { sha256: "abc", byteSize: 12 } } });
    }
    if (url.includes("/v1/skills/release-notes-helper")) {
      return jsonResponse(200, { skill: { slug: "release-notes-helper", latestVersion: "0.1.0" } });
    }
    return jsonResponse(200, { skills: [] });
  }, "session-token");

  await client.searchSkills("");
  await client.getSkill("release-notes-helper");
  await client.getRelease("release-notes-helper", "0.1.0");

  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
  ]);
  assert.equal(calls.some((call) => call.url.includes("/bundle")), false);
});

test("registry client supports login, MFA verification, current user, and logout", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (String(input).endsWith("/v1/auth/login")) {
      return jsonResponse(200, {
        mfaRequired: true,
        challengeToken: "challenge-token",
        expiresAt: "2026-06-04T01:00:00.000Z",
        user: { email: "maintainer@example.com" },
      });
    }
    if (String(input).endsWith("/v1/auth/mfa/verify")) {
      return jsonResponse(200, {
        token: "verified-session-token",
        expiresAt: "2026-06-04T01:00:00.000Z",
        user: { email: "maintainer@example.com" },
      });
    }
    if (String(input).endsWith("/v1/me")) {
      return jsonResponse(200, { user: { email: "maintainer@example.com", roles: ["maintainer"] } });
    }
    return jsonResponse(204, {});
  });

  const login = await client.login({ email: "maintainer@example.com", password: "test-password" });
  const verified = await client.verifyMfa({ challengeToken: "challenge-token", codeOrRecoveryCode: "123456" });
  const user = await client.getMe(verified.token);
  await client.logout(verified.token);

  assert.equal(login.mfaRequired, true);
  assert.equal(verified.token, "verified-session-token");
  assert.equal(user.email, "maintainer@example.com");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://api.test/v1/auth/login",
    "http://api.test/v1/auth/mfa/verify",
    "http://api.test/v1/me",
    "http://api.test/v1/auth/logout",
  ]);
  assert.equal(calls[2].authorization, "Bearer verified-session-token");
  assert.equal(calls[3].authorization, "Bearer verified-session-token");
});

test("registry client supports MFA status and TOTP enrollment", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/auth/mfa") && !init?.method) {
      return jsonResponse(200, { mfa: { totpEnabled: false, recoveryCodesRemaining: 0, factors: [] } });
    }
    if (url.endsWith("/v1/auth/mfa/totp/enroll")) {
      return jsonResponse(201, {
        enrollment: {
          factorId: "factor-1",
          label: "1Password",
          secret: "JBSWY3DPEHPK3PXP",
          otpauthUrl: "otpauth://totp/MySkills:owner%40example.com",
        },
      });
    }
    return jsonResponse(200, {
      mfa: {
        factor: {
          id: "factor-1",
          type: "totp",
          status: "enabled",
          label: "1Password",
          enabledAt: "2026-06-14T00:00:00.000Z",
          createdAt: "2026-06-14T00:00:00.000Z",
        },
        recoveryCodes: ["recovery-one"],
      },
    });
  });

  const status = await client.getMfaStatus("session-token");
  const enrollment = await client.startTotpEnrollment({ password: "test-password", label: "1Password" }, "session-token");
  const confirmation = await client.confirmTotpEnrollment({ factorId: enrollment.factorId, code: "123456" }, "session-token");

  assert.equal(status.totpEnabled, false);
  assert.equal(enrollment.secret, "JBSWY3DPEHPK3PXP");
  assert.deepEqual(confirmation.recoveryCodes, ["recovery-one"]);
  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/auth/mfa",
    "POST http://api.test/v1/auth/mfa/totp/enroll",
    "POST http://api.test/v1/auth/mfa/totp/confirm",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
  ]);
  assert.equal(calls[1].body, JSON.stringify({ password: "test-password", label: "1Password" }));
  assert.equal(calls[2].body, JSON.stringify({ factorId: "factor-1", code: "123456" }));
});

test("registry client supports account recovery and settings endpoints", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/auth/password-reset/confirm")) {
      return jsonResponse(200, { status: "reset" });
    }
    if (url.endsWith("/v1/auth/email-verification/confirm")) {
      return jsonResponse(200, { status: "verified" });
    }
    if (url.endsWith("/v1/auth/email-change/confirm")) {
      return jsonResponse(200, { status: "changed" });
    }
    if (url.endsWith("/v1/auth/account/password")) {
      return jsonResponse(200, { status: "changed" });
    }
    if (url.endsWith("/v1/auth/mfa/totp")) {
      return jsonResponse(200, { mfa: { status: "disabled", disabledFactors: 1 } });
    }
    return jsonResponse(202, { status: "pending" });
  });

  await client.requestPasswordReset({ email: "reader@example.com" });
  await client.confirmPasswordReset({ token: "reset-token", password: "new-password" });
  await client.confirmEmailVerification({ token: "verify-token" });
  await client.requestEmailChange({ email: "new@example.com", password: "current-password" }, "session-token");
  await client.confirmEmailChange({ token: "change-token" });
  await client.changePassword({ currentPassword: "current-password", password: "new-password" }, "session-token");
  await client.disableTotpMfa({ password: "current-password" }, "session-token");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "POST http://api.test/v1/auth/password-reset/request",
    "POST http://api.test/v1/auth/password-reset/confirm",
    "POST http://api.test/v1/auth/email-verification/confirm",
    "POST http://api.test/v1/auth/account/email-change",
    "POST http://api.test/v1/auth/email-change/confirm",
    "POST http://api.test/v1/auth/account/password",
    "DELETE http://api.test/v1/auth/mfa/totp",
  ]);
  assert.equal(calls[3].authorization, "Bearer session-token");
  assert.equal(calls[5].authorization, "Bearer session-token");
  assert.equal(calls[6].authorization, "Bearer session-token");
  assert.equal(calls[0].body, JSON.stringify({ email: "reader@example.com" }));
  assert.equal(calls[3].body, JSON.stringify({ email: "new@example.com", password: "current-password" }));
  assert.equal(calls[6].body, JSON.stringify({ password: "current-password" }));
});

test("registry client manages admin settings with the session bearer", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/admin/registration") && init?.method === "PUT") {
      return jsonResponse(200, { registration: { mode: "request" } });
    }
    if (url.endsWith("/v1/admin/registration")) {
      return jsonResponse(200, { registration: { mode: "closed" } });
    }
    if (url.endsWith("/v1/admin/users")) {
      return jsonResponse(200, { users: [{ id: "user-1", email: "reader@example.com" }] });
    }
    if (url.endsWith("/v1/admin/users/user-1/actions")) {
      return jsonResponse(200, { user: { id: "user-1", status: "disabled" } });
    }
    if (url.endsWith("/v1/admin/users/user-1/roles")) {
      return jsonResponse(200, { user: { id: "user-1", roles: ["maintainer", "author"] } });
    }
    if (url.endsWith("/v1/admin/providers") && !init?.method) {
      return jsonResponse(200, { providers: [{ key: "oidc-main", roleMappings: [] }] });
    }
    if (url.endsWith("/v1/admin/providers/oidc-main")) {
      return jsonResponse(200, { provider: { key: "oidc-main", type: "oidc", roleMappings: [] } });
    }
    return jsonResponse(200, { events: [{ id: "audit-1", action: "admin.registration.update" }] });
  });

  await client.getAdminRegistration("session-token");
  await client.updateAdminRegistration("request", "session-token");
  await client.listAdminUsers("session-token");
  await client.performAdminUserAction("user-1", "disable", "session-token");
  await client.updateAdminUserRoles("user-1", ["maintainer", "author"], "session-token");
  await client.listAdminProviders("session-token");
  await client.upsertAdminProvider("oidc-main", {
    type: "oidc",
    displayName: "OIDC",
    enabled: true,
    roleMappings: [{ claim: "groups", value: "authors", role: "author" }],
  }, "session-token");
  await client.listAdminAudit(10, "session-token");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/admin/registration",
    "PUT http://api.test/v1/admin/registration",
    "GET http://api.test/v1/admin/users",
    "POST http://api.test/v1/admin/users/user-1/actions",
    "PUT http://api.test/v1/admin/users/user-1/roles",
    "GET http://api.test/v1/admin/providers",
    "PUT http://api.test/v1/admin/providers/oidc-main",
    "GET http://api.test/v1/admin/audit?limit=10",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
    "Bearer session-token",
  ]);
  assert.equal(calls[1].body, JSON.stringify({ mode: "request" }));
  assert.equal(calls[3].body, JSON.stringify({ action: "disable" }));
  assert.equal(calls[4].body, JSON.stringify({ roles: ["maintainer", "author"] }));
  assert.equal(calls[6].body?.includes("groups"), true);
});

test("registry client manages review queue with the session bearer", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/review/submissions") && !init?.method) {
      return jsonResponse(200, {
        submissions: [{
          id: "submission-1",
          slug: "release-notes-helper",
          version: "0.1.0",
          reviewStatus: "unreviewed",
          securityStatus: "passed",
          findingCount: 0,
        }],
      });
    }
    return jsonResponse(200, {
      submission: {
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        lifecycleStatus: "review",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: null,
      },
    });
  });

  await client.listReviewSubmissions("review-session");
  await client.performReviewAction("submission-1", "approve", "checked", "review-session");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/review/submissions",
    "POST http://api.test/v1/review/submissions/submission-1/actions",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer review-session",
    "Bearer review-session",
  ]);
  assert.equal(calls[1].body, JSON.stringify({ action: "approve", reason: "checked" }));
});

test("registry client submits package archives with the session bearer", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    return jsonResponse(202, {
      submission: {
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        reviewStatus: "unreviewed",
        securityStatus: "passed",
      },
      scan: {
        status: "succeeded",
        findingCount: 0,
        findings: [],
      },
    });
  });

  const result = await client.submitArchive({
    filename: "release-notes-helper.zip",
    contentBase64: "UEsDBA==",
  }, "author-session");

  assert.equal(result.submission.id, "submission-1");
  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "POST http://api.test/v1/submissions",
  ]);
  assert.equal(calls[0]?.authorization, "Bearer author-session");
  assert.equal(calls[0]?.body, JSON.stringify({
    archive: {
      filename: "release-notes-helper.zip",
      contentBase64: "UEsDBA==",
    },
  }));
});

test("safe error messages do not render raw server internals", () => {
  const error = new Error("stack trace /Users/example token storageKey") as SafeApiError;
  error.status = 500;
  error.code = "INTERNAL_SERVER_ERROR";

  assert.equal(safeErrorMessage(error), "The registry is not available.");
  assert.equal(safeAdminErrorMessage(error), "Admin data is not available.");
  assert.equal(safeSubmitErrorMessage(error), "Submission service is not available.");
  assert.equal(safeReviewErrorMessage(error), "Review queue is not available.");
});

test("export command matches CLI contract", () => {
  assert.equal(
    exportCommand("release-notes-helper", "0.1.0", "codex"),
    "myskills export release-notes-helper --version 0.1.0 --platform codex --output ./skills/release-notes-helper",
  );
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}
