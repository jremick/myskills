import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateTotpCode, hashPassword, type Role } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("review routes require authentication", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const app = buildReviewApp({ submissionStore });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/review/submissions" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
});

test("authors cannot list or act on reviews", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
  });
  const actionResponse = await app.inject({
    method: "POST",
    url: "/v1/review/submissions/submission-1/actions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { action: "approve" },
  });

  assert.equal(listResponse.statusCode, 403);
  assert.equal(listResponse.json().error.code, "REVIEW_ROLE_REQUIRED");
  assert.equal(actionResponse.statusCode, 403);
  assert.equal(actionResponse.json().error.code, "REVIEW_ROLE_REQUIRED");
  assert.equal(JSON.stringify(listResponse.json()).includes("Release Notes Helper"), false);
});

test("maintainers can approve and publish a clean public submission", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;

  const listResponse = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${maintainerToken}` },
  });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().submissions[0].id, submissionId);
  assert.equal(JSON.stringify(listResponse.json()).includes("storageKey"), false);
  assert.equal(JSON.stringify(listResponse.json()).includes("Summarize release notes."), false);

  const approveResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "approve", reason: "checked Bearer abcdefghijklmnopqrstuvwxyz" },
  });
  assert.equal(approveResponse.statusCode, 200);
  assert.equal(approveResponse.json().submission.reviewStatus, "approved");
  assert.equal(approveResponse.json().submission.publishedAt, null);

  const approvedListResponse = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${maintainerToken}` },
  });
  assert.equal(approvedListResponse.statusCode, 200);
  assert.equal(approvedListResponse.json().submissions[0].id, submissionId);
  assert.equal(approvedListResponse.json().submissions[0].reviewStatus, "approved");

  const publishResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "publish" },
  });
  assert.equal(publishResponse.statusCode, 200);
  assert.equal(publishResponse.json().submission.publishedAt.length > 0, true);

  const publishedListResponse = await app.inject({
    method: "GET",
    url: "/v1/review/submissions",
    headers: { authorization: `Bearer ${maintainerToken}` },
  });
  assert.equal(publishedListResponse.statusCode, 200);
  assert.equal(publishedListResponse.json().submissions.some((submission: { id: string }) => submission.id === submissionId), false);

  const releaseResponse = await app.inject({
    method: "GET",
    url: "/v1/skills/release-notes-helper/releases/0.1.0",
  });
  assert.equal(releaseResponse.statusCode, 200);
  assert.equal(releaseResponse.json().release.slug, "release-notes-helper");
  assert.equal(JSON.stringify(releaseResponse.json()).includes("storageKey"), false);
  assert.equal(JSON.stringify(releaseResponse.json()).includes("Summarize release notes."), false);

  const bundleResponse = await app.inject({
    method: "GET",
    url: "/v1/skills/release-notes-helper/releases/0.1.0/bundle?platform=codex",
  });
  assert.equal(bundleResponse.statusCode, 200);
  assert.match(bundleResponse.headers["content-type"] as string, /application\/vnd\.myskills-app\.package\+json/);
  const metadata = releaseResponse.json().release.artifact;
  assert.equal(Buffer.byteLength(bundleResponse.body), metadata.byteSize);
  assert.equal(createHash("sha256").update(bundleResponse.body).digest("hex"), metadata.sha256);
  assert.deepEqual(JSON.parse(bundleResponse.body).files.map((file: { path: string }) => file.path), ["README.md", "skill.json"]);

  const missingPlatformResponse = await app.inject({
    method: "GET",
    url: "/v1/skills/release-notes-helper/releases/0.1.0/bundle?platform=missing",
  });
  assert.equal(missingPlatformResponse.statusCode, 404);
  assert.equal(missingPlatformResponse.json().error.code, "RELEASE_NOT_FOUND");

  const approveAudit = submissionStore.auditEvents().find((event) => event.action === "review.approve" && event.decision === "allow");
  assert.equal(approveAudit?.details.reason, "checked Bearer [redacted]");
  assert.equal(submissionStore.auditEvents().some((event) => event.action === "artifact.bundle" && event.decision === "allow"), true);
  assert.equal(submissionStore.auditEvents().some((event) => event.action === "artifact.bundle" && event.decision === "deny"), true);
});

test("warning submissions cannot be approved or published", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);
  const payload = cleanSubmissionPayload();
  payload.files.push({
    path: "package.json",
    content: JSON.stringify({ scripts: { postinstall: "node setup.js" } }),
  });

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload,
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;

  const approveResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "approve" },
  });
  const publishResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "publish" },
  });

  assert.equal(approveResponse.statusCode, 422);
  assert.equal(approveResponse.json().error.code, "PACKAGE_SCAN_NOT_PASSED");
  assert.equal(publishResponse.statusCode, 422);
  assert.equal(publishResponse.json().error.code, "PACKAGE_SCAN_NOT_PASSED");
});

test("authors can withdraw unreviewed submissions", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;

  const withdrawResponse = await app.inject({
    method: "POST",
    url: `/v1/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { action: "withdraw", reason: "superseded" },
  });

  assert.equal(withdrawResponse.statusCode, 200);
  assert.equal(withdrawResponse.json().submission.reviewStatus, "rejected");
  assert.equal(withdrawResponse.json().submission.lifecycleStatus, "archived");
  assert.equal(submissionStore.auditEvents().some((event) => (
    event.action === "submission.withdraw" &&
    event.decision === "allow" &&
    event.details.reason === "superseded"
  )), true);
});

test("maintainers can request changes and reject submissions", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;

  const changesResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "request-changes", reason: "missing examples" },
  });
  assert.equal(changesResponse.statusCode, 200);
  assert.equal(changesResponse.json().submission.reviewStatus, "changes-requested");
  assert.equal(changesResponse.json().submission.lifecycleStatus, "review");

  const rejectResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "reject", reason: "unsafe pattern" },
  });
  assert.equal(rejectResponse.statusCode, 200);
  assert.equal(rejectResponse.json().submission.reviewStatus, "rejected");
  assert.equal(rejectResponse.json().submission.lifecycleStatus, "archived");
});

test("release lifecycle actions hide and restore published releases", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;
  await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "approve" },
  });
  await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "publish" },
  });

  const unpublishResponse = await app.inject({
    method: "POST",
    url: "/v1/skills/release-notes-helper/releases/0.1.0/actions",
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "unpublish", reason: "bad metadata" },
  });
  assert.equal(unpublishResponse.statusCode, 200);
  assert.equal(unpublishResponse.json().release.lifecycleStatus, "unpublished");

  const hiddenResponse = await app.inject({
    method: "GET",
    url: "/v1/skills/release-notes-helper/releases/0.1.0",
  });
  assert.equal(hiddenResponse.statusCode, 404);

  const restoreResponse = await app.inject({
    method: "POST",
    url: "/v1/skills/release-notes-helper/releases/0.1.0/actions",
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "restore", reason: "metadata fixed" },
  });
  assert.equal(restoreResponse.statusCode, 200);
  assert.equal(restoreResponse.json().release.lifecycleStatus, "approved");

  const visibleResponse = await app.inject({
    method: "GET",
    url: "/v1/skills/release-notes-helper/releases/0.1.0",
  });
  assert.equal(visibleResponse.statusCode, 200);
  assert.equal(visibleResponse.json().release.lifecycleStatus, "approved");
});

test("publish revalidates the stored package manifest", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const submitResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(submitResponse.statusCode, 202);
  const submissionId = submitResponse.json().submission.id as string;

  const approveResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "approve" },
  });
  assert.equal(approveResponse.statusCode, 200);

  const stored = firstStoredSubmission(submissionStore);
  const manifestFile = stored.artifact.payload.files.find((file) => file.path === "skill.json");
  if (!manifestFile) {
    throw new Error("Expected stored package manifest.");
  }
  manifestFile.content = JSON.stringify({
    ...JSON.parse(manifestFile.content),
    name: "different-helper",
  });

  const publishResponse = await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${submissionId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "publish" },
  });

  assert.equal(publishResponse.statusCode, 422);
  assert.equal(publishResponse.json().error.code, "PACKAGE_MANIFEST_MISMATCH");
  assert.equal(submissionStore.auditEvents().some((event) => (
    event.action === "release.publish" &&
    event.decision === "deny" &&
    event.details.reason === "PACKAGE_MANIFEST_MISMATCH"
  )), true);
});

test("release routes hide unpublished and private releases consistently", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const authorToken = await addAndLogin(app, authStore, "author@example.com", ["author"]);
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const unpublishedSubmit = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload({ version: "0.2.0" }),
  });
  assert.equal(unpublishedSubmit.statusCode, 202);

  const privateSubmit = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: cleanSubmissionPayload({ name: "private-helper", version: "0.1.0", visibility: "private" }),
  });
  assert.equal(privateSubmit.statusCode, 202);
  const privateId = privateSubmit.json().submission.id as string;
  await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${privateId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "approve" },
  });
  await app.inject({
    method: "POST",
    url: `/v1/review/submissions/${privateId}/actions`,
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "publish" },
  });

  for (const url of [
    "/v1/skills/release-notes-helper/releases/0.2.0",
    "/v1/skills/release-notes-helper/releases/0.2.0/bundle?platform=codex",
    "/v1/skills/private-helper/releases/0.1.0",
    "/v1/skills/private-helper/releases/0.1.0/bundle?platform=codex",
  ]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "RELEASE_NOT_FOUND");
    assert.deepEqual(Object.keys(response.json().error).sort(), ["code", "message"]);
  }
});

test("invalid review actions are rejected before state changes", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildReviewApp({ authStore, submissionStore });
  t.after(() => app.close());
  const maintainerToken = await addAndLoginWithMfa(app, authStore, "maintainer@example.com", ["maintainer"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/review/submissions/submission-1/actions",
    headers: { authorization: `Bearer ${maintainerToken}` },
    payload: { action: "delete" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REVIEW_ACTION");
});

function buildReviewApp(options: {
  authStore?: MemoryAuthStore;
  submissionStore: MemorySubmissionStore;
}) {
  const authStore = options.authStore ?? new MemoryAuthStore("closed");
  return buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    submissionService: new SubmissionService(options.submissionStore),
  });
}

async function addAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  email: string,
  roles: Role[],
): Promise<string> {
  authStore.addUser({
    email,
    status: "active",
    emailVerifiedAt: new Date(),
    roles,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email,
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
  email: string,
  roles: Role[],
): Promise<string> {
  const setupSession = await addAndLogin(app, authStore, email, roles);
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
      email,
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

function cleanSubmissionPayload(input: {
  name?: string;
  version?: string;
  visibility?: "public" | "private";
} = {}) {
  return {
    manifest: {
      name: input.name ?? "release-notes-helper",
      title: "Release Notes Helper",
      summary: "Turns merged changes into concise release notes.",
      version: input.version ?? "0.1.0",
      license: "Apache-2.0",
      visibility: input.visibility ?? "public",
      platforms: [{ name: "codex", install_target: "codex-skill" }],
      tags: ["writing", "release"],
    },
    files: [
      {
        path: "skill.json",
        content: JSON.stringify({
          name: input.name ?? "release-notes-helper",
          title: "Release Notes Helper",
          summary: "Turns merged changes into concise release notes.",
          version: input.version ?? "0.1.0",
          license: "Apache-2.0",
          visibility: input.visibility ?? "public",
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

function firstStoredSubmission(submissionStore: MemorySubmissionStore) {
  const internalStore = submissionStore as unknown as {
    submissions: Map<string, {
      artifact: {
        payload: {
          files: Array<{ path: string; content: string }>;
        };
      };
    }>;
  };
  const stored = [...internalStore.submissions.values()][0];
  if (!stored) {
    throw new Error("Expected stored submission.");
  }
  return stored;
}
