import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicSkill } from "@myskills-app/core";
import { RegistryApp } from "../src/App.js";
import type {
  AdminAuditEvent,
  AdminProviderConfig,
  AdminRegistrationMode,
  AdminUser,
  ProviderRoleMappingInput,
  RegistryClient,
  ReleaseMetadata,
  ReviewSubmissionSummary,
  SafeApiError,
  SubmitSkillResult,
} from "../src/api.js";

test("landing page explains private development and opens the login page", async () => {
  setupDom("http://localhost/");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "MySkills" });
  assert.equal(document.body.textContent?.includes("Private development. Not open for signups."), true);
  assert.equal(client.searchCalls.length, 0);

  fireEvent.click(view.getAllByRole("button", { name: "Login" })[0]!);

  await view.findByRole("heading", { name: "Login" });
  assert.deepEqual(client.searchCalls, []);
  assert.equal(document.body.textContent?.includes("Release Notes Helper"), false);
  assert.equal(window.location.pathname, "/login");
});

test("anonymous registry routes resolve to login without loading skills", async () => {
  setupDom("http://localhost/registry");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "Login" });
  assert.deepEqual(client.searchCalls, []);
  assert.equal(document.body.textContent?.includes("Release Notes Helper"), false);
  assert.equal(window.location.pathname, "/login");
});

test("browse page requests skills with query and renders API-returned skills", async () => {
  setupAuthenticatedDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Release Notes Helper");
  fireEvent.input(view.getByPlaceholderText("Search skills..."), { target: { value: "release" } });

  await waitFor(() => assert.equal(client.searchCalls.includes("release"), true));
  assert.equal(view.getAllByText("release-notes-helper").length, 2);
  assert.equal(document.body.textContent?.includes("private-risk-reviewer"), false);
});

test("default registry client is stable between renders", async () => {
  setupAuthenticatedDom();
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/me")) {
      return jsonResponse(200, { user: authUser() });
    }
    if (url.includes("/releases/")) {
      return jsonResponse(200, { release: publicRelease() });
    }
    if (url.includes("/v1/skills/release-notes-helper")) {
      return jsonResponse(200, { skill: publicSkill() });
    }
    return jsonResponse(200, { skills: [publicSkill()] });
  }) as typeof fetch;

  try {
    const view = render(<RegistryApp />);

    await view.findByText("Turns merged changes into concise release notes.");
    await waitFor(() => assert.equal(calls.length, 4));
    await delay(25);
    assert.deepEqual(calls, [
      "http://localhost:3001/v1/me",
      "http://localhost:3001/v1/skills",
      "http://localhost:3001/v1/skills/release-notes-helper",
      "http://localhost:3001/v1/skills/release-notes-helper/releases/0.1.0",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("searching selects a matching result when the current detail is filtered out", async () => {
  setupAuthenticatedDom();
  const smokeSkill = {
    ...publicSkill("smoke-skill"),
    title: "Smoke Skill",
    summary: "Smoke-only detail.",
    tags: ["smoke"],
  };
  const releaseSkill = publicSkill();
  const client = mockClient({
    skills: [smokeSkill, releaseSkill],
    searchResults(query) {
      return query === "release" ? [releaseSkill] : [smokeSkill, releaseSkill];
    },
  });

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Smoke-only detail.");

  fireEvent.input(view.getByPlaceholderText("Search skills..."), { target: { value: "release" } });

  await view.findByText("Turns merged changes into concise release notes.");
  assert.equal(document.body.textContent?.includes("Smoke-only detail."), false);
  assert.equal(client.bundleCalls, 0);
});

test("empty search state does not leak denied identifiers", async () => {
  setupAuthenticatedDom();
  const client = mockClient({ skills: [] });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("No skills found.");
  assert.equal(document.body.textContent?.includes("private-risk-reviewer"), false);
  assert.equal(document.body.textContent?.includes("failed-public-skill"), false);
});

test("skill detail displays public metadata and release artifact metadata only", async () => {
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Turns merged changes into concise release notes.");
  assert.equal(view.getAllByText("0.1.0").length, 2);
  assert.equal(view.getAllByText("codex, generic").length, 2);
  assert.equal(view.getByText("approved").textContent, "approved");
  assert.equal(view.getByText("passed").textContent, "passed");
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
  assert.equal(client.bundleCalls, 0);
});

test("404 detail responses render generic not found state", async () => {
  setupAuthenticatedDom("http://localhost/skills/private-helper");
  const client = mockClient({
    getSkillError: safeApiError(404, "SKILL_NOT_FOUND", "Private helper exists but is hidden."),
  });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skill or release not found.");
  assert.equal(document.body.textContent?.includes("Private helper exists"), false);
  assert.equal(document.body.textContent?.includes("private-helper"), false);
});

test("platform selection changes CLI export guidance only", async () => {
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  await view.findByText(/myskills export release-notes-helper --version 0\.1\.0 --platform codex/);

  fireEvent.click(view.getByRole("button", { name: "generic" }));

  await view.findByText(/myskills export release-notes-helper --version 0\.1\.0 --platform generic/);
  assert.equal(client.releaseCalls.length, 1);
  assert.equal(client.bundleCalls, 0);
});

test("login stores a verified session and logout clears it", async () => {
  setupDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("reader@example.com");
  await view.findByText("Release Notes Helper");
  assert.equal(window.location.pathname, "/registry");
  assert.equal(document.body.textContent?.includes("web-session-token"), false);
  assert.equal(JSON.parse(window.localStorage.getItem("myskills-app:web-session") ?? "{}").token, "web-session-token");

  fireEvent.click(view.getByLabelText("Sign out"));

	  await view.findByRole("button", { name: /sign in/i });
	  assert.equal((view.getByLabelText("Password") as HTMLInputElement).value, "");
	  assert.equal(window.localStorage.getItem("myskills-app:web-session"), null);
	  assert.equal(client.logoutCalls, 1);
	});

test("MFA login verifies the challenge before storing a session", async () => {
  setupDom();
  const client = mockClient({ mfaRequired: true });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "maintainer@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("MFA required.");
  fireEvent.input(view.getByLabelText("MFA code"), { target: { value: "123456" } });
  fireEvent.click(view.getByRole("button", { name: /verify/i }));

  await view.findByText("reader@example.com");
  assert.deepEqual(client.mfaCalls, ["123456"]);
  assert.equal(JSON.parse(window.localStorage.getItem("myskills-app:web-session") ?? "{}").token, "mfa-session-token");
});

test("non-admin sessions do not render the admin entry point", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ roles: ["author"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("reader@example.com");
  assert.equal(view.queryByRole("button", { name: /admin/i }), null);
  assert.equal(view.queryByRole("button", { name: /review/i }), null);
});

test("admin sessions can manage registration, users, and provider metadata", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("owner@example.com");
  fireEvent.click(view.getByRole("button", { name: /admin/i }));

  await view.findByText("Admin console");
  await waitFor(() => assert.equal(view.getAllByText("Cloudflare Access").length >= 1, true));
  assert.equal(document.body.textContent?.includes("clientSecret"), false);
  assert.equal(document.body.textContent?.includes("private_key"), false);
  assert.equal((view.getByLabelText("Set author@example.com author role") as HTMLInputElement).disabled, true);

  fireEvent.click(view.getByRole("button", { name: "Request" }));
  await waitFor(() => assert.deepEqual(client.registrationUpdates, ["request"]));

  const originalConfirm = window.confirm;
  window.confirm = () => false;
  fireEvent.click(view.getByRole("button", { name: "Open" }));
  assert.deepEqual(client.registrationUpdates, ["request"]);

  window.confirm = () => true;
  fireEvent.click(view.getByRole("button", { name: "Open" }));
  await waitFor(() => assert.deepEqual(client.registrationUpdates, ["request", "open"]));

  window.confirm = () => true;
  try {
    fireEvent.click(view.getByLabelText("Disable user"));
    await waitFor(() => assert.deepEqual(client.userActions, ["user-2:disable"]));
  } finally {
    window.confirm = originalConfirm;
  }

  fireEvent.click(view.getByLabelText("Set author@example.com maintainer role"));
  await waitFor(() => assert.deepEqual(client.roleUpdates, ["user-2:maintainer,author"]));
  await waitFor(() => assert.equal((view.getByLabelText("Set author@example.com maintainer role") as HTMLInputElement).checked, true));

  fireEvent.input(view.getByLabelText("Display name"), { target: { value: "Cloudflare Main" } });
  fireEvent.click(view.getByRole("button", { name: /save provider/i }));

  await waitFor(() => assert.equal(client.providerUpserts[0]?.displayName, "Cloudflare Main"));
  assert.equal(client.providerUpserts[0]?.roleMappings?.[0]?.role, "maintainer");
});

test("non-owner admin sessions cannot edit privileged target role controls", async () => {
  setupDom();
  const client = mockClient({
    user: authUser({ email: "admin@example.com", roles: ["admin"] }),
    adminUsers: [
      {
        id: "owner-1",
        email: "owner@example.com",
        name: "Owner",
        status: "active",
        roles: ["owner"],
        emailVerified: true,
        mfaEnabled: true,
      },
      ...defaultAdminUsers(),
    ],
  });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "admin@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("admin@example.com");
  fireEvent.click(view.getByRole("button", { name: /admin/i }));

  await view.findByText("Admin console");
  assert.equal((view.getByLabelText("Set owner@example.com maintainer role") as HTMLInputElement).disabled, true);
  assert.equal((view.getByLabelText("Set author@example.com maintainer role") as HTMLInputElement).disabled, false);
});

test("maintainer sessions can approve and publish review submissions without bundle content", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "maintainer@example.com", roles: ["maintainer"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "maintainer@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("maintainer@example.com");
  assert.equal(view.queryByRole("button", { name: /admin/i }), null);
  fireEvent.click(view.getByRole("button", { name: /review/i }));

  await view.findByText("Review dashboard");
  await waitFor(() => assert.equal(view.getAllByText("release-notes-helper@0.1.0").length >= 1, true));
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
  assert.equal(client.bundleCalls, 0);

  fireEvent.input(view.getByLabelText("Reason"), { target: { value: "checked" } });
  fireEvent.click(view.getByRole("button", { name: /approve/i }));
  await waitFor(() => assert.deepEqual(client.reviewActions, ["submission-1:approve:checked"]));

  fireEvent.click(view.getByRole("button", { name: /publish/i }));
  await waitFor(() => assert.deepEqual(client.reviewActions, ["submission-1:approve:checked", "submission-1:publish:"]));
  await view.findByText("Review queue is clear.");
});

test("author sessions can submit a package archive without rendering package content", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "author@example.com", roles: ["author"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "author@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("author@example.com");
  fireEvent.click(view.getByRole("button", { name: /submit/i }));

  await view.findByText("Submit package");
  const archive = new File(["PK archive content"], "release-notes-helper.zip", { type: "application/zip" });
  fireEvent.change(view.getByLabelText(/choose \.zip package/i), { target: { files: [archive] } });
  fireEvent.click(view.getByRole("button", { name: /submit for review/i }));

  await view.findByText("submission-1");
  assert.equal(client.submitCalls[0]?.filename, "release-notes-helper.zip");
  assert.equal(client.submitCalls[0]?.contentBase64, "UEsgYXJjaGl2ZSBjb250ZW50");
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("PK archive content"), false);
  assert.equal(document.body.textContent?.includes("UEsgYXJjaGl2ZSBjb250ZW50"), false);
});

test("submission result renders controlled scan warnings", async () => {
  setupDom();
  const client = mockClient({
    user: authUser({ email: "author@example.com", roles: ["author"] }),
    submitResult: {
      ...defaultSubmitResult(),
      scan: {
        status: "succeeded",
        findingCount: 1,
        findings: [{
          category: "install-hook",
          severity: "warning",
          message: "Dependency install hook requires maintainer review.",
          path: "package.json",
        }],
      },
    },
  });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "author@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("author@example.com");
  fireEvent.click(view.getByRole("button", { name: /submit/i }));
  fireEvent.change(await view.findByLabelText(/choose \.zip package/i), {
    target: { files: [new File(["warning zip"], "warning-skill.zip", { type: "application/zip" })] },
  });
  fireEvent.click(view.getByRole("button", { name: /submit for review/i }));

  await view.findByText("install-hook");
  await view.findByText("package.json");
  await view.findByText("Dependency install hook requires maintainer review.");
  assert.equal(document.body.textContent?.includes("warning zip"), false);
});

test("malformed stored sessions are ignored before signed-in render", async () => {
  setupDom();
  window.localStorage.setItem("myskills-app:web-session", JSON.stringify({
    token: "stored-session-token",
    expiresAt: "2026-06-04T01:00:00.000Z",
    user: {},
  }));
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("button", { name: /sign in/i });
  assert.equal(window.localStorage.getItem("myskills-app:web-session"), null);
});

test("failed login shows auth-specific safe copy", async () => {
  setupDom();
  const client = mockClient({
    loginError: safeApiError(401, "INVALID_CREDENTIALS", "Wrong password for reader@example.com."),
  });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "wrong-password" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("Invalid email or password.");
  assert.equal(document.body.textContent?.includes("registry item"), false);
  assert.equal(document.body.textContent?.includes("Wrong password"), false);
  assert.equal(window.localStorage.getItem("myskills-app:web-session"), null);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function setupDom(url = "http://localhost/registry") {
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", url);
}

function setupAuthenticatedDom(url = "http://localhost/registry", user = authUser()) {
  setupDom(url);
  window.localStorage.setItem("myskills-app:web-session", JSON.stringify({
    token: "stored-session-token",
    expiresAt: "2026-06-04T01:00:00.000Z",
    user,
  }));
}

function mockClient(input: {
  adminProviders?: AdminProviderConfig[];
  adminUsers?: AdminUser[];
  reviewSubmissions?: ReviewSubmissionSummary[];
  skills?: PublicSkill[];
  release?: ReleaseMetadata;
  getSkillError?: SafeApiError;
  loginError?: SafeApiError;
  mfaRequired?: boolean;
  searchResults?: (query: string) => PublicSkill[];
  submitError?: SafeApiError;
  submitResult?: SubmitSkillResult;
  user?: ReturnType<typeof authUser>;
} = {}) {
  const skills = input.skills ?? [publicSkill()];
  const release = input.release ?? publicRelease();
  const currentUser = input.user ?? authUser();
  let registrationMode: AdminRegistrationMode = "closed";
  let adminUsers = input.adminUsers ?? defaultAdminUsers();
  let adminProviders = input.adminProviders ?? defaultAdminProviders();
  let reviewSubmissions = input.reviewSubmissions ?? defaultReviewSubmissions();
  const client: RegistryClient & {
    bundleCalls: number;
    logoutCalls: number;
    mfaCalls: string[];
    providerUpserts: Array<{ key: string; displayName: string; roleMappings?: ProviderRoleMappingInput[] }>;
    registrationUpdates: AdminRegistrationMode[];
    releaseCalls: string[];
    reviewActions: string[];
    roleUpdates: string[];
    searchCalls: string[];
    submitCalls: Array<{ filename: string; contentBase64: string }>;
    userActions: string[];
  } = {
    bundleCalls: 0,
    logoutCalls: 0,
    mfaCalls: [],
    providerUpserts: [],
    registrationUpdates: [],
    releaseCalls: [],
    reviewActions: [],
    roleUpdates: [],
    searchCalls: [],
    submitCalls: [],
    userActions: [],
    async searchSkills(query) {
      client.searchCalls.push(query);
      return input.searchResults?.(query) ?? skills;
    },
    async getSkill(slug) {
      if (input.getSkillError) {
        throw input.getSkillError;
      }
      const skill = skills.find((item) => item.slug === slug) ?? publicSkill(slug);
      return skill;
    },
    async getRelease(slug, version) {
      client.releaseCalls.push(`${slug}@${version}`);
      return release;
    },
    async getMe() {
      return currentUser;
    },
    async login() {
      if (input.loginError) {
        throw input.loginError;
      }
      return input.mfaRequired
        ? {
          mfaRequired: true,
          challengeToken: "mfa-challenge-token",
          expiresAt: "2026-06-04T01:00:00.000Z",
          user: authUser({ email: "maintainer@example.com", mfaVerified: false }),
        }
        : {
          mfaRequired: false,
          token: "web-session-token",
          expiresAt: "2026-06-04T01:00:00.000Z",
          user: currentUser,
        };
    },
    async logout() {
      client.logoutCalls += 1;
    },
    async verifyMfa(input) {
      client.mfaCalls.push(input.codeOrRecoveryCode);
      return {
        token: "mfa-session-token",
        expiresAt: "2026-06-04T01:00:00.000Z",
        user: authUser({ mfaVerified: true }),
      };
    },
    async getAdminRegistration() {
      return { mode: registrationMode };
    },
    async updateAdminRegistration(mode) {
      registrationMode = mode;
      client.registrationUpdates.push(mode);
      return { mode };
    },
    async listAdminUsers() {
      return adminUsers;
    },
    async performAdminUserAction(userId, action) {
      client.userActions.push(`${userId}:${action}`);
      adminUsers = adminUsers.map((user) => user.id === userId ? {
        ...user,
        status: action === "disable" ? "disabled" : action === "delete" ? "deleted" : "active",
      } : user);
      return adminUsers.find((user) => user.id === userId) ?? defaultAdminUsers()[0];
    },
    async updateAdminUserRoles(userId, roles) {
      client.roleUpdates.push(`${userId}:${roles.join(",")}`);
      adminUsers = adminUsers.map((user) => user.id === userId ? { ...user, roles } : user);
      return adminUsers.find((user) => user.id === userId) ?? defaultAdminUsers()[0];
    },
    async listAdminProviders() {
      return adminProviders;
    },
    async upsertAdminProvider(key, provider) {
      client.providerUpserts.push({ key, displayName: provider.displayName, roleMappings: provider.roleMappings });
      const saved: AdminProviderConfig = {
        key,
        type: provider.type,
        displayName: provider.displayName,
        issuer: provider.issuer ?? null,
        clientId: provider.clientId ?? null,
        enabled: Boolean(provider.enabled),
        roleMappings: provider.roleMappings ?? [],
      };
      adminProviders = [saved, ...adminProviders.filter((item) => item.key !== key)];
      return saved;
    },
    async listAdminAudit() {
      return defaultAuditEvents();
    },
    async submitArchive(archive) {
      client.submitCalls.push(archive);
      if (input.submitError) {
        throw input.submitError;
      }
      return input.submitResult ?? defaultSubmitResult();
    },
    async listReviewSubmissions() {
      return reviewSubmissions;
    },
    async performReviewAction(submissionId, action, reason) {
      client.reviewActions.push(`${submissionId}:${action}:${reason ?? ""}`);
      if (action === "approve") {
        reviewSubmissions = reviewSubmissions.map((submission) => (
          submission.id === submissionId ? { ...submission, reviewStatus: "approved" } : submission
        ));
        return {
          id: submissionId,
          slug: "release-notes-helper",
          version: "0.1.0",
          visibility: "public",
          lifecycleStatus: "review",
          reviewStatus: "approved",
          securityStatus: "passed",
          publishedAt: null,
        };
      }
      reviewSubmissions = reviewSubmissions.filter((submission) => submission.id !== submissionId);
      return {
        id: submissionId,
        slug: "release-notes-helper",
        version: "0.1.0",
        visibility: "public",
        lifecycleStatus: "approved",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: "2026-06-04T00:00:00.000Z",
      };
    },
  };
  return client;
}

function defaultSubmitResult(): SubmitSkillResult {
  return {
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
  };
}

function authUser(input: { email?: string; mfaVerified?: boolean; roles?: string[] } = {}) {
  return {
    id: "user-1",
    email: input.email ?? "reader@example.com",
    name: "Reader",
    status: "active",
    roles: input.roles ?? ["author"],
    emailVerified: true,
    mfaVerified: input.mfaVerified ?? true,
  };
}

function defaultAdminUsers(): AdminUser[] {
  return [
    {
      id: "user-2",
      email: "author@example.com",
      name: "Author",
      status: "active",
      roles: ["author"],
      emailVerified: true,
      mfaEnabled: false,
    },
  ];
}

function defaultAdminProviders(): AdminProviderConfig[] {
  return [
    {
      key: "cloudflare-main",
      type: "cloudflare_access",
      displayName: "Cloudflare Access",
      issuer: "https://team.cloudflareaccess.com",
      clientId: "public-client-id",
      enabled: true,
      roleMappings: [{ claim: "groups", value: "skills-maintainers", role: "maintainer" }],
    },
  ];
}

function defaultAuditEvents(): AdminAuditEvent[] {
  return [
    {
      id: "audit-1",
      actorUserId: "user-1",
      action: "admin.provider.upsert",
      decision: "allow",
      resourceType: "provider_config",
      resourceId: "provider-1",
      details: {},
      createdAt: "2026-06-04T00:00:00.000Z",
    },
  ];
}

function defaultReviewSubmissions(): ReviewSubmissionSummary[] {
  return [
    {
      id: "submission-1",
      slug: "release-notes-helper",
      title: "Release Notes Helper",
      version: "0.1.0",
      visibility: "public",
      reviewStatus: "unreviewed",
      securityStatus: "passed",
      platforms: [
        { name: "codex", installTarget: "codex-skill", status: "supported" },
        { name: "generic", installTarget: "prompt-pack", status: "supported" },
      ],
      findingCount: 0,
      createdAt: "2026-06-04T00:00:00.000Z",
    },
  ];
}

function publicSkill(slug = "release-notes-helper"): PublicSkill {
  return {
    slug,
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [
      { name: "codex", installTarget: "codex-skill", status: "supported" },
      { name: "generic", installTarget: "prompt-pack", status: "supported" },
    ],
    tags: ["writing", "release"],
  };
}

function publicRelease(): ReleaseMetadata {
  return {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: "2026-06-04T00:00:00.000Z",
    platforms: [
      { name: "codex", installTarget: "codex-skill", status: "supported" },
      { name: "generic", installTarget: "prompt-pack", status: "supported" },
    ],
    artifact: {
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      byteSize: 1234,
      contentType: "application/vnd.myskills-app.package+json",
    },
  };
}

function safeApiError(status: number, code: string, message: string): SafeApiError {
  const error = new Error(message) as SafeApiError;
  error.status = status;
  error.code = code;
  return error;
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
