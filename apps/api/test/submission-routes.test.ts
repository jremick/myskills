import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "@ai-skills-share/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("submission requires authentication", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const app = buildSubmissionApp({ submissionStore });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    payload: cleanSubmissionPayload(),
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  assert.equal(submissionStore.count(), 0);
});

test("plain users cannot create submissions", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["user"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: cleanSubmissionPayload(),
  });

  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "SUBMISSION_ROLE_REQUIRED");
  assert.equal(submissionStore.count(), 0);
});

test("authors can submit clean packages", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: cleanSubmissionPayload(),
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.json().submission.slug, "release-notes-helper");
  assert.equal(response.json().submission.version, "0.1.0");
  assert.equal(response.json().submission.reviewStatus, "unreviewed");
  assert.equal(response.json().submission.securityStatus, "passed");
  assert.equal(response.json().scan.findingCount, 0);
  assert.equal(JSON.stringify(response.json()).includes("storageKey"), false);
  assert.equal(submissionStore.count(), 1);
});

test("warning findings are persisted as scan evidence", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const payload = cleanSubmissionPayload();
  payload.files.push({
    path: "package.json",
    content: JSON.stringify({ scripts: { postinstall: "node setup.js" } }),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.json().submission.securityStatus, "warning");
  assert.equal(response.json().scan.findings[0].category, "install-hook");
  assert.equal(response.json().scan.findings[0].path, "package.json");
});

test("blocking findings reject without accepted records", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const payload = cleanSubmissionPayload();
  payload.files[1].content = `token: ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, "PACKAGE_SCAN_BLOCKED");
  assert.equal(response.json().error.details.findings[0].path, "README.md");
  assert.equal(submissionStore.count(), 0);
  assert.equal(submissionStore.deniedCount(), 1);
});

test("invalid manifests are rejected", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const payload = cleanSubmissionPayload();
  payload.manifest.name = "Bad--Slug";

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_PACKAGE_MANIFEST");
  assert.equal(submissionStore.count(), 0);
});

test("submitted manifest must match the package manifest file", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const payload = cleanSubmissionPayload();
  payload.files[0].content = JSON.stringify({
    ...payload.manifest,
    name: "different-helper",
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "PACKAGE_MANIFEST_MISMATCH");
  assert.equal(submissionStore.count(), 0);
  assert.equal(submissionStore.deniedCount(), 0);
});

test("package manifest file is required and must be valid", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const missingManifest = cleanSubmissionPayload();
  missingManifest.files = [{ path: "README.md", content: "Summarize release notes." }];
  const invalidManifest = cleanSubmissionPayload();
  invalidManifest.files[0].content = "{}";

  const missingResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: missingManifest,
  });
  const invalidResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: invalidManifest,
  });

  assert.equal(missingResponse.statusCode, 400);
  assert.equal(missingResponse.json().error.code, "PACKAGE_MANIFEST_REQUIRED");
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.json().error.code, "INVALID_PACKAGE_MANIFEST");
  assert.equal(submissionStore.count(), 0);
});

test("duplicate slug and version are rejected", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const first = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: cleanSubmissionPayload(),
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: cleanSubmissionPayload(),
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error.code, "PACKAGE_VERSION_EXISTS");
  assert.equal(submissionStore.count(), 1);
});

test("server-local package paths and unsafe file paths are rejected", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const topLevelPath = { ...cleanSubmissionPayload(), packagePath: "/etc/passwd" };
  const unsafeFilePath = cleanSubmissionPayload();
  unsafeFilePath.files[0].path = "../secret.txt";

  const topLevelResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: topLevelPath,
  });
  const unsafeFileResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: unsafeFilePath,
  });

  assert.equal(topLevelResponse.statusCode, 400);
  assert.equal(topLevelResponse.json().error.code, "UNSUPPORTED_SUBMISSION_FIELD");
  assert.equal(unsafeFileResponse.statusCode, 400);
  assert.equal(unsafeFileResponse.json().error.code, "INVALID_PACKAGE_PAYLOAD");
  assert.equal(submissionStore.count(), 0);
});

function buildSubmissionApp(options: {
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
  roles: Array<"author" | "maintainer" | "user">,
): Promise<string> {
  authStore.addUser({
    email: "author@example.com",
    status: "active",
    emailVerifiedAt: new Date(),
    roles,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: "author@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token;
}

function cleanSubmissionPayload() {
  const manifest = {
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["writing", "release"],
  };
  return {
    manifest,
    files: [
      {
        path: "skill.json",
        content: JSON.stringify(manifest),
      },
      {
        path: "README.md",
        content: "Summarize release notes.",
      },
    ],
  };
}
