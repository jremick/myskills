import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateTotpCode, hashPassword } from "@ai-skills-share/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { writeStoredZip, type ZipFixtureEntry } from "../../../test-support/zip-fixture.js";

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

test("authors can submit clean archive packages", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: await cleanArchiveSubmissionPayload(t),
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

test("privileged submitters require MFA verification", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const unverifiedMaintainer = await addAndLoginAs(app, authStore, "maintainer@example.com", ["maintainer"]);
  const verifiedMaintainer = await addAndLoginWithMfa(app, authStore, "verified-maintainer@example.com", ["maintainer"]);

  const denied = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${unverifiedMaintainer}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, "MFA_VERIFICATION_REQUIRED");
  assert.equal(submissionStore.count(), 0);

  const allowed = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${verifiedMaintainer}` },
    payload: cleanSubmissionPayload(),
  });
  assert.equal(allowed.statusCode, 202);
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

test("archive submissions persist warning findings", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: await cleanArchiveSubmissionPayload(t, [
      { path: "package.json", content: JSON.stringify({ scripts: { postinstall: "node setup.js" } }) },
    ]),
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

test("archive submissions reject blocking findings without accepted records", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: await archiveSubmissionPayload(t, [
      { path: "skill.json", content: manifestJson() },
      { path: "README.md", content: `token: ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}` },
    ]),
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

test("archive manifest validation maps to package manifest errors", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const missingManifest = await archiveSubmissionPayload(t, [{ path: "README.md", content: "readme" }]);
  const invalidManifest = await archiveSubmissionPayload(t, [{ path: "skill.json", content: "{}" }]);
  const ambiguousManifest = await archiveSubmissionPayload(t, [
    { path: "skill.json", content: manifestJson() },
    { path: "skill-manifest.json", content: manifestJson() },
  ]);

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
  const ambiguousResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: ambiguousManifest,
  });

  assert.equal(missingResponse.statusCode, 400);
  assert.equal(missingResponse.json().error.code, "PACKAGE_MANIFEST_REQUIRED");
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.json().error.code, "INVALID_PACKAGE_MANIFEST");
  assert.equal(ambiguousResponse.statusCode, 400);
  assert.equal(ambiguousResponse.json().error.code, "PACKAGE_MANIFEST_AMBIGUOUS");
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

test("submitted manifest must match the archive package manifest file", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const payload = await cleanArchiveSubmissionPayload(t);

  const response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ...payload,
      manifest: {
        ...cleanManifest(),
        name: "different-helper",
      },
    },
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

test("archive payload validation rejects unsafe archive content", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const unsafePath = await cleanArchiveSubmissionPayload(t, [{ path: "../secret.txt", content: "nope" }]);
  const symlink = await cleanArchiveSubmissionPayload(t, [{ path: "link.txt", content: "target.txt", mode: 0o120777 }]);
  const binary = await cleanArchiveSubmissionPayload(t, [{ path: "binary.bin", content: Buffer.from([0xff]) }]);

  for (const payload of [unsafePath, symlink, binary]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/submissions",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "INVALID_PACKAGE_ARCHIVE");
  }
  assert.equal(submissionStore.count(), 0);
});

test("archive payload shape is validated before package processing", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const filesAndArchive = {
    ...cleanSubmissionPayload(),
    archive: (await cleanArchiveSubmissionPayload(t)).archive,
  };
  const invalidBase64 = {
    manifest: cleanManifest(),
    archive: { filename: "package.zip", contentBase64: "not base64" },
  };
  const unsafeFilename = {
    manifest: cleanManifest(),
    archive: { filename: "../package.zip", contentBase64: Buffer.from("not a zip").toString("base64") },
  };

  const ambiguousResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: filesAndArchive,
  });
  const invalidBase64Response = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: invalidBase64,
  });
  const unsafeFilenameResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: unsafeFilename,
  });

  assert.equal(ambiguousResponse.statusCode, 400);
  assert.equal(ambiguousResponse.json().error.code, "INVALID_SUBMISSION_PACKAGE_SOURCE");
  assert.equal(invalidBase64Response.statusCode, 400);
  assert.equal(invalidBase64Response.json().error.code, "INVALID_PACKAGE_ARCHIVE");
  assert.equal(unsafeFilenameResponse.statusCode, 400);
  assert.equal(unsafeFilenameResponse.json().error.code, "INVALID_PACKAGE_ARCHIVE");
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

test("server-local paths, artifact metadata, and unsafe file paths are rejected", async (t) => {
  const submissionStore = new MemorySubmissionStore();
  const authStore = new MemoryAuthStore("closed");
  const app = buildSubmissionApp({ authStore, submissionStore });
  t.after(() => app.close());
  const token = await addAndLogin(app, authStore, ["author"]);
  const topLevelPath = { ...cleanSubmissionPayload(), packagePath: "/etc/passwd" };
  const artifactMetadata = { ...cleanSubmissionPayload(), byteSize: 1234, contentType: "application/json" };
  const unsafeFilePath = cleanSubmissionPayload();
  unsafeFilePath.files[0].path = "../secret.txt";

  const topLevelResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: topLevelPath,
  });
  const artifactMetadataResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: artifactMetadata,
  });
  const unsafeFileResponse = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    headers: { authorization: `Bearer ${token}` },
    payload: unsafeFilePath,
  });

  assert.equal(topLevelResponse.statusCode, 400);
  assert.equal(topLevelResponse.json().error.code, "UNSUPPORTED_SUBMISSION_FIELD");
  assert.equal(artifactMetadataResponse.statusCode, 400);
  assert.equal(artifactMetadataResponse.json().error.code, "UNSUPPORTED_SUBMISSION_FIELD");
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
  return addAndLoginAs(app, authStore, "author@example.com", roles);
}

async function addAndLoginAs(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  email: string,
  roles: Array<"author" | "maintainer" | "user">,
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
  return response.json().token;
}

async function addAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  email: string,
  roles: Array<"author" | "maintainer" | "user">,
): Promise<string> {
  const setupSession = await addAndLoginAs(app, authStore, email, roles);
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

function cleanSubmissionPayload() {
  const manifest = cleanManifest();
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

function cleanManifest() {
  return {
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["writing", "release"],
  };
}

async function cleanArchiveSubmissionPayload(t: TestContext, extraEntries: ZipFixtureEntry[] = []) {
  return archiveSubmissionPayload(t, [
    { path: "skill.json", content: manifestJson() },
    { path: "README.md", content: "Summarize release notes." },
    ...extraEntries,
  ]);
}

async function archiveSubmissionPayload(t: TestContext, entries: ZipFixtureEntry[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ai-skills-api-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, entries);
  return {
    archive: {
      filename: "package.zip",
      contentBase64: (await readFile(zipPath)).toString("base64"),
    },
  };
}

function manifestJson(): string {
  return JSON.stringify(cleanManifest());
}
