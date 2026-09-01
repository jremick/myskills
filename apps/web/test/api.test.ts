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
  const calls: Array<{ credentials?: RequestCredentials; url: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({ credentials: init?.credentials, url: String(input) });
    return jsonResponse(200, {
      skills: [{ slug: "release-notes-helper", title: "Release Notes Helper" }],
    });
  });

  const skills = await client.searchSkills("release notes");

  assert.equal(calls[0]?.url, "http://api.test/v1/skills?q=release%20notes");
  assert.equal(calls[0]?.credentials, "include");
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

test("registry client round-trips the complete skill organization grant set", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const sharing = {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    visibility: "team",
    settings: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
    availableTeams: [],
    teamGrants: [],
    userGrants: [],
    availableOrganizations: [
      { id: "org-2", name: "Workgroup", slug: "workgroup", status: "active", role: "member" },
      { id: "org-1", name: "Acme", slug: "acme", status: "active", role: "owner" },
    ],
    organizationGrants: [
      { id: "org-1", name: "Acme", slug: "acme", status: "active", role: "owner" },
    ],
  };
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
    });
    return jsonResponse(200, { sharing });
  }, "session-token");

  const current = await client.getSkillSharing("release-notes-helper");
  await client.updateSkillSharing({
    slug: current.slug,
    visibility: "private",
    teamIds: [],
    userEmails: [],
    organizationIds: current.organizationGrants?.map((organization) => organization.id) ?? [],
  });

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/skills/release-notes-helper/sharing",
    "PUT http://api.test/v1/skills/release-notes-helper/sharing",
  ]);
  assert.equal(calls[1]?.body, JSON.stringify({
    visibility: "private",
    teamIds: [],
    userEmails: [],
    organizationIds: ["org-1"],
  }));
});

test("registry client forwards an optional team owner and omits it for the default user owner", async () => {
  const calls: Array<{ body?: string; method?: string; url: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
    });
    return jsonResponse(201, { architecture: { id: "architecture-1", name: "Team stack", patternId: "flat" } });
  }, "session-token");

  await client.createArchitecture({
    name: "Team stack",
    patternId: "flat",
    owner: { type: "team", id: "team-1" },
  });
  await client.createArchitecture({ name: "Personal stack", patternId: "flat" });

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "POST http://api.test/v1/architectures",
    "POST http://api.test/v1/architectures",
  ]);
  assert.equal(calls[0]?.body, JSON.stringify({
    name: "Team stack",
    patternId: "flat",
    owner: { type: "team", id: "team-1" },
  }));
  assert.equal(calls[1]?.body, JSON.stringify({
    name: "Personal stack",
    patternId: "flat",
  }));
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
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string; sessionResponse?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      sessionResponse: headers.get("x-myskills-session-response") ?? undefined,
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
  await client.verifyMfa({ challengeToken: "challenge-token", codeOrRecoveryCode: "123456" });
  const user = await client.getMe();
  await client.logout();

  assert.equal(login.mfaRequired, true);
  assert.equal(user.email, "maintainer@example.com");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://api.test/v1/auth/login",
    "http://api.test/v1/auth/mfa/verify",
    "http://api.test/v1/me",
    "http://api.test/v1/auth/logout",
  ]);
  assert.deepEqual(calls.map((call) => call.sessionResponse), ["cookie", "cookie", undefined, undefined]);
  assert.equal(calls[2].authorization, undefined);
  assert.equal(calls[3].authorization, undefined);
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
    if (url.endsWith("/v1/auth/api-tokens") && !init?.method) {
      return jsonResponse(200, { tokens: [{ id: "api-token-1", name: "CLI" }] });
    }
    if (url.endsWith("/v1/auth/api-tokens") && init?.method === "POST") {
      return jsonResponse(201, { token: { id: "api-token-2", name: "MCP", token: "plain-token" } });
    }
    if (url.endsWith("/v1/auth/api-tokens/api-token-1")) {
      return jsonResponse(200, { token: { id: "api-token-1", name: "CLI", revokedAt: "2026-06-14T00:00:00.000Z" } });
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
  await client.listApiTokens("session-token");
  await client.createApiToken({ name: "MCP", scopes: ["skills:read"] }, "session-token");
  await client.revokeApiToken("api-token-1", "session-token");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "POST http://api.test/v1/auth/password-reset/request",
    "POST http://api.test/v1/auth/password-reset/confirm",
    "POST http://api.test/v1/auth/email-verification/confirm",
    "POST http://api.test/v1/auth/account/email-change",
    "POST http://api.test/v1/auth/email-change/confirm",
    "POST http://api.test/v1/auth/account/password",
    "DELETE http://api.test/v1/auth/mfa/totp",
    "GET http://api.test/v1/auth/api-tokens",
    "POST http://api.test/v1/auth/api-tokens",
    "DELETE http://api.test/v1/auth/api-tokens/api-token-1",
  ]);
  assert.equal(calls[3].authorization, "Bearer session-token");
  assert.equal(calls[5].authorization, "Bearer session-token");
  assert.equal(calls[6].authorization, "Bearer session-token");
  assert.equal(calls[7].authorization, "Bearer session-token");
  assert.equal(calls[8].authorization, "Bearer session-token");
  assert.equal(calls[9].authorization, "Bearer session-token");
  assert.equal(calls[0].body, JSON.stringify({ email: "reader@example.com" }));
  assert.equal(calls[3].body, JSON.stringify({ email: "new@example.com", password: "current-password" }));
  assert.equal(calls[6].body, JSON.stringify({ password: "current-password" }));
  assert.equal(calls[8].body, JSON.stringify({ name: "MCP", scopes: ["skills:read"] }));
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
    if (url.endsWith("/v1/admin/api-tokens") && !init?.method) {
      return jsonResponse(200, { tokens: [{ id: "api-token-1", name: "CLI", user: { email: "reader@example.com" } }] });
    }
    if (url.endsWith("/v1/admin/api-tokens/api-token-1")) {
      return jsonResponse(200, { token: { id: "api-token-1", name: "CLI", revokedAt: "2026-06-14T00:00:00.000Z", user: { email: "reader@example.com" } } });
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
  await client.performAdminUserAction("user-1", "disable", "Access review failed", "session-token");
  await client.updateAdminUserRoles("user-1", ["maintainer", "author"], "Maintainer promotion approved", "session-token");
  await client.listAdminApiTokens("session-token");
  await client.revokeAdminApiToken("api-token-1", "session-token");
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
    "GET http://api.test/v1/admin/api-tokens",
    "DELETE http://api.test/v1/admin/api-tokens/api-token-1",
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
    "Bearer session-token",
    "Bearer session-token",
  ]);
  assert.equal(calls[1].body, JSON.stringify({ mode: "request" }));
  assert.equal(calls[3].body, JSON.stringify({ action: "disable", reason: "Access review failed" }));
  assert.equal(calls[4].body, JSON.stringify({ roles: ["maintainer", "author"], reason: "Maintainer promotion approved" }));
  assert.equal(calls[8].body?.includes("groups"), true);
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
          approvedArtifactSha256: null,
          findingCount: 0,
        }],
      });
    }
    if (url.endsWith("/v1/review/submissions/submission-1/bundle")) {
      return jsonResponse(
        200,
        { files: [{ path: "skill.json", content: "{}" }] },
        { "x-myskills-artifact-sha256": "a".repeat(64) },
      );
    }
    return jsonResponse(200, {
      submission: {
        id: "submission-1",
        slug: "release-notes-helper",
        version: "0.1.0",
        lifecycleStatus: "review",
        reviewStatus: "approved",
        securityStatus: "passed",
        approvedArtifactSha256: "a".repeat(64),
        publishedAt: null,
      },
    });
  });

  await client.listReviewSubmissions("review-session");
  const bundle = await client.getReviewSubmissionBundle("submission-1", undefined, "review-session");
  await client.performReviewAction({
    submissionId: "submission-1",
    action: "approve",
    reason: "checked",
    artifactSha256: bundle.artifactSha256,
  }, "review-session");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/review/submissions",
    "GET http://api.test/v1/review/submissions/submission-1/bundle",
    "POST http://api.test/v1/review/submissions/submission-1/actions",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer review-session",
    "Bearer review-session",
    "Bearer review-session",
  ]);
  assert.equal(bundle.artifactSha256, "a".repeat(64));
  assert.equal(calls[2].body, JSON.stringify({ action: "approve", reason: "checked", artifactSha256: "a".repeat(64) }));
});

test("registry client submits package archives with the session bearer", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/submissions/mine")) {
      return jsonResponse(200, { submissions: [{ id: "submission-1", slug: "release-notes-helper" }] });
    }
    if (url.endsWith("/v1/submissions/submission-1/bundle")) {
      return jsonResponse(200, { files: [{ path: "skill.json", content: "{}" }] });
    }
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
  await client.listUserSubmissions("author-session");
  await client.exportUserSubmission("submission-1", "author-session");

  assert.equal(result.submission.id, "submission-1");
  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "POST http://api.test/v1/submissions",
    "GET http://api.test/v1/submissions/mine",
    "GET http://api.test/v1/submissions/submission-1/bundle",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer author-session",
    "Bearer author-session",
    "Bearer author-session",
  ]);
  assert.equal(calls[0]?.body, JSON.stringify({
    archive: {
      filename: "release-notes-helper.zip",
      contentBase64: "UEsDBA==",
    },
  }));
});

test("registry client manages skill and release lifecycle controls", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: init?.headers instanceof Headers ? init.headers.get("authorization") ?? undefined : (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    if (url.endsWith("/v1/skills/release-notes-helper/releases") && !init?.method) {
      return jsonResponse(200, {
        releases: [{
          id: "version-1",
          slug: "release-notes-helper",
          version: "0.1.0",
          lifecycleStatus: "approved",
          reviewStatus: "approved",
          securityStatus: "passed",
          publishedAt: "2026-06-18T00:00:00.000Z",
          platforms: [],
          findingCount: 0,
          allowedActions: ["unpublish"],
        }],
      });
    }
    if (url.endsWith("/v1/skills/release-notes-helper/releases/0.1.0/actions")) {
      return jsonResponse(200, {
        release: {
          id: "version-1",
          slug: "release-notes-helper",
          version: "0.1.0",
          lifecycleStatus: "unpublished",
          reviewStatus: "approved",
          securityStatus: "passed",
          publishedAt: "2026-06-18T00:00:00.000Z",
          platforms: [],
          findingCount: 0,
          allowedActions: ["restore"],
        },
      });
    }
    return jsonResponse(200, {
      skill: {
        slug: "release-notes-helper",
        title: "Release Notes Assistant",
        summary: "Updated",
        lifecycleStatus: "approved",
        visibility: "public",
        tags: ["writing"],
        allowedActions: ["edit"],
      },
    });
  });

  await client.listSkillReleases("release-notes-helper", "maintainer-session");
  await client.updateSkillMetadata({ slug: "release-notes-helper", title: "Release Notes Assistant" }, "maintainer-session");
  await client.performReleaseAction("release-notes-helper", "0.1.0", "unpublish", "bad metadata", undefined, "maintainer-session");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/skills/release-notes-helper/releases",
    "PUT http://api.test/v1/skills/release-notes-helper",
    "POST http://api.test/v1/skills/release-notes-helper/releases/0.1.0/actions",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer maintainer-session",
    "Bearer maintainer-session",
    "Bearer maintainer-session",
  ]);
  assert.equal(calls[1].body, JSON.stringify({ title: "Release Notes Assistant" }));
  assert.equal(calls[2].body, JSON.stringify({ action: "unpublish", reason: "bad metadata" }));
});

test("registry client keeps architecture previews API-backed and bearer-authenticated", async () => {
  const calls: Array<{ body?: string; method?: string; url: string; authorization?: string }> = [];
  const client = createRegistryClient("http://api.test", async (input, init) => {
    const url = String(input);
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      method: init?.method,
      url,
      authorization: headers.get("authorization") ?? undefined,
    });
    if (url.endsWith("/v1/architecture-patterns")) {
      return jsonResponse(200, { patterns: [{ id: "multi-level-router", name: "Multi-level router", description: "Nested routers" }] });
    }
    if (url.endsWith("/v1/architectures") && init?.method === "POST") {
      return jsonResponse(201, { architecture: { id: "architecture-1", name: "Review assistant", patternId: "multi-level-router" } });
    }
    if (url.endsWith("/v1/architectures")) {
      return jsonResponse(200, { architectures: [{ id: "architecture-1", name: "Review assistant", patternId: "multi-level-router" }] });
    }
    if (url.endsWith("/v1/architectures/architecture-1")) {
      return jsonResponse(200, {
        architecture: {
          id: "architecture-1",
          name: "Review assistant",
          patternId: "multi-level-router",
          revisionCount: 2,
          ownerUserId: "user-1",
          ownerTeamId: null,
          owner: { type: "user", id: "user-1" },
          ownerType: "user",
          ownerId: "user-1",
          accessPolicyVersion: 1,
          access: {
            owner: { type: "user", id: "user-1" },
            ownerType: "user",
            ownerId: "user-1",
            policyVersion: 1,
            accessPolicyVersion: 1,
            role: "owner",
            canList: true,
            canRead: true,
            canPreview: true,
            canCreate: true,
            canAppend: true,
            canManage: true,
            reasons: ["owner"],
          },
        },
        latestRevision: {
          id: "revision-current",
          architectureId: "architecture-1",
          revisionNumber: 2,
          message: "Current revision",
          createdByUserId: "user-1",
          createdAt: "2026-06-14T00:00:00.000Z",
          patternId: "multi-level-router",
          spec: {
            schemaVersion: 1,
            id: "architecture-1",
            name: "Review assistant",
            pattern: { id: "multi-level-router", version: 1 },
            skills: [{ id: "release", slug: "release-notes-helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" }],
            nodes: [
              { id: "root", kind: "router", label: "Review router" },
              { id: "branch", kind: "router", label: "Quality branch" },
              { id: "release", kind: "leaf", label: "Release Notes Helper", skillRefId: "release" },
            ],
            edges: [
              { from: "root", to: "branch", kind: "contains" },
              { from: "branch", to: "release", kind: "routes" },
            ],
            entryNodeIds: ["root"],
            profiles: [{ id: "work", name: "Work", subject: { type: "user", id: "user-1" }, defaultExposure: "disabled", bindings: [{ nodeId: "root", enabled: true, runtimeExposure: "router" }, { nodeId: "branch", enabled: true, runtimeExposure: "router" }, { nodeId: "release", enabled: true, runtimeExposure: "leaf" }] }],
            environments: [{ id: "codex-work", name: "Codex work", kind: "work", profileId: "work" }],
          },
        },
        revisions: [{ id: "revision-summary", architectureId: "architecture-1", revisionNumber: 1, message: "Previous revision", patternId: "multi-level-router", createdAt: "2026-06-13T00:00:00.000Z", nodeCount: 3, skillCount: 1 }],
      });
    }
    if (url.endsWith("/v1/architectures/architecture-1/revisions")) {
      return jsonResponse(201, {
        revision: {
          id: "revision-next",
          architectureId: "architecture-1",
          revisionNumber: 3,
          message: "Draft revision",
          createdByUserId: "user-1",
          createdAt: "2026-06-14T00:00:00.000Z",
          spec: {},
        },
      });
    }
    if (url.endsWith("/v1/architectures/architecture-1/revisions/revision-older")) {
      return jsonResponse(200, {
        revision: {
          id: "revision-older",
          architectureId: "architecture-1",
          revisionNumber: 1,
          message: "Older revision",
          createdByUserId: "user-1",
          createdAt: "2026-06-13T00:00:00.000Z",
          spec: {},
        },
      });
    }
    if (url.endsWith("/v1/architectures/architecture-1/draft-preview")) {
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      return jsonResponse(200, {
        draft: {
          expectedCurrentRevisionId: requestBody.expectedCurrentRevisionId,
          spec: requestBody.spec,
        },
        compiled: {
          schemaVersion: 1,
          architectureId: "architecture-1",
          revisionDigest: "a".repeat(64),
          pattern: { id: "multi-level-router", version: 1 },
          profileId: "work",
          environmentId: "codex-work",
          nodes: [],
          allNodes: [],
          disabledNodeIds: [],
          edges: [],
          skills: [],
          routers: [],
        },
        graph: { digest: "a".repeat(64), nodes: [], edges: [], mermaid: "flowchart TD" },
        outline: { title: "Architecture architecture-1", text: "Architecture architecture-1", tree: [] },
        diagram: {
          schemaVersion: 1,
          architectureId: "architecture-1",
          revisionDigest: "a".repeat(64),
          profileId: "work",
          environmentId: "codex-work",
          accessibleTitle: "Architecture architecture-1",
          accessibleDescription: "A deterministic topology projection.",
          mermaid: "flowchart TD",
          mermaidSha256: "b".repeat(64),
          accessibleOutline: "Architecture architecture-1",
          artifactDigest: "c".repeat(64),
        },
      });
    }
    if (url.endsWith("/preview")) {
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      const plan = requestBody.fixture !== undefined ? {
        dryRun: true,
        canApply: false,
        requiresApproval: true,
        targetId: "fixture-target",
        environmentId: "codex-work",
        architectureId: "architecture-1",
        revisionDigest: "a".repeat(64),
        items: [{
          action: "noop",
          nodeId: "root",
          kind: "router",
          reason: "Target already matches the desired router state.",
        }],
      } : undefined;
      return jsonResponse(200, {
        revision: {
          id: "revision-current",
          architectureId: "architecture-1",
          revisionNumber: 2,
          message: "Current revision",
          spec: {
            schemaVersion: 1,
            id: "architecture-1",
            name: "Review assistant",
            pattern: { id: "multi-level-router", version: 1 },
            skills: [],
            nodes: [],
            edges: [],
            entryNodeIds: [],
            profiles: [],
            environments: [],
          },
          createdByUserId: "user-1",
          createdAt: "2026-06-14T00:00:00.000Z",
        },
        compiled: {
          schemaVersion: 1,
          architectureId: "architecture-1",
          revisionDigest: "a".repeat(64),
          pattern: { id: "multi-level-router", version: 1 },
          profileId: "work",
          environmentId: "codex-work",
          nodes: [],
          allNodes: [],
          disabledNodeIds: [],
          edges: [],
          skills: [],
          routers: [],
        },
        graph: { digest: "a".repeat(64), nodes: [], edges: [], mermaid: "flowchart TD" },
        outline: { title: "Architecture architecture-1", text: "Architecture architecture-1", tree: [] },
        diagram: {
          schemaVersion: 1,
          architectureId: "architecture-1",
          revisionDigest: "a".repeat(64),
          profileId: "work",
          environmentId: "codex-work",
          accessibleTitle: "Architecture architecture-1",
          accessibleDescription: "A deterministic topology projection.",
          mermaid: "flowchart TD",
          mermaidSha256: "b".repeat(64),
          accessibleOutline: "Architecture architecture-1",
          artifactDigest: "c".repeat(64),
        },
        ...(plan ? { plan } : {}),
      });
    }
    return jsonResponse(200, { architecture: { id: "architecture-1", name: "Review assistant", patternId: "multi-level-router" } });
  });

  await client.listArchitecturePatterns("architecture-session");
  await client.listArchitectures("architecture-session");
  const detail = await client.getArchitecture("architecture-1", "architecture-session");
  await client.createArchitecture({ name: "Review assistant", patternId: "multi-level-router" }, "architecture-session");
  const revisionSpec = detail.latestRevision?.spec;
  assert.ok(revisionSpec);
  const revision = await client.createArchitectureRevision("architecture-1", {
    spec: revisionSpec,
    message: "Draft revision",
    expectedCurrentRevisionId: "revision-current",
  }, "architecture-session");
  const olderRevision = await client.getArchitectureRevision("architecture-1", "revision-older", "architecture-session");
  const draftPreview = await client.previewArchitectureDraft("architecture-1", {
    spec: revisionSpec,
    expectedCurrentRevisionId: "revision-current",
    profileId: "work",
    environmentId: "codex-work",
  }, "architecture-session");
  const preview = await client.previewArchitecture("architecture-1", { profileId: "work", environmentId: "codex-work" }, "architecture-session");
  const organizationPreview = await client.previewArchitecture("architecture-1", {
    profileId: "work",
    environmentId: "codex-work",
    organizationId: "organization-1",
  }, "architecture-session");
  const fixturePreview = await client.previewArchitecture("architecture-1", {
    profileId: "work",
    environmentId: "codex-work",
    fixture: { targetId: "fixture-target", nodes: [] },
  }, "architecture-session");

  assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
    "GET http://api.test/v1/architecture-patterns",
    "GET http://api.test/v1/architectures",
    "GET http://api.test/v1/architectures/architecture-1",
    "POST http://api.test/v1/architectures",
    "POST http://api.test/v1/architectures/architecture-1/revisions",
    "GET http://api.test/v1/architectures/architecture-1/revisions/revision-older",
    "POST http://api.test/v1/architectures/architecture-1/draft-preview",
    "POST http://api.test/v1/architectures/architecture-1/preview",
    "POST http://api.test/v1/architectures/architecture-1/preview",
    "POST http://api.test/v1/architectures/architecture-1/preview",
  ]);
  assert.equal(calls.every((call) => call.authorization === "Bearer architecture-session"), true);
  assert.equal(detail.latestRevision?.id, "revision-current");
  assert.equal(revision.id, "revision-next");
  assert.equal(olderRevision.id, "revision-older");
  assert.equal(draftPreview.draft.expectedCurrentRevisionId, "revision-current");
  assert.equal(preview.revision?.id, "revision-current");
  assert.equal(organizationPreview.revision?.id, "revision-current");
  assert.equal(draftPreview.diagram.revisionDigest, "a".repeat(64));
  assert.equal(preview.diagram.architectureId, "architecture-1");
  assert.equal(preview.diagram.mermaid, "flowchart TD");
  assert.equal(preview.plan, undefined);
  assert.equal(fixturePreview.plan?.targetId, "fixture-target");
  assert.equal(calls[3]?.body, JSON.stringify({ name: "Review assistant", patternId: "multi-level-router" }));
  assert.equal(calls[4]?.body, JSON.stringify({ spec: revisionSpec, message: "Draft revision", expectedCurrentRevisionId: "revision-current" }));
  assert.equal(calls[6]?.body, JSON.stringify({ spec: revisionSpec, expectedCurrentRevisionId: "revision-current", profileId: "work", environmentId: "codex-work" }));
  assert.equal(calls[7]?.body, JSON.stringify({ profileId: "work", environmentId: "codex-work" }));
  assert.equal(calls[8]?.body, JSON.stringify({ profileId: "work", environmentId: "codex-work", organizationId: "organization-1" }));
  assert.equal(calls[9]?.body, JSON.stringify({ profileId: "work", environmentId: "codex-work", fixture: { targetId: "fixture-target", nodes: [] } }));
  assert.equal(calls.some((call) => call.body?.includes("visibility")), false);
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
    "myskills export 'release-notes-helper' --version '0.1.0' --platform 'codex' --output './skills/release-notes-helper'",
  );
});

function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}
