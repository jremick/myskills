import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicSkill, SkillSharingDetails, TeamSharedSkillGroup } from "@myskills-app/core";
import { RegistryApp } from "../src/App.js";
import type {
  AdminAuditEvent,
  AdminApiToken,
  ApiToken,
  ApiTokenScope,
  AdminProviderConfig,
  AdminRegistrationMode,
  AdminUser,
  MfaStatus,
  ProviderRoleMappingInput,
  RegistryClient,
  ReleaseMetadata,
  ReviewSubmissionSummary,
  SafeApiError,
  SubmitSkillResult,
  TeamDashboard,
  TeamInvitation,
  TeamRecord,
  UserSubmissionSummary,
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
    assert.deepEqual([...calls].sort(), [
      "http://localhost:3001/v1/me",
      "http://localhost:3001/v1/skills",
      "http://localhost:3001/v1/skills/release-notes-helper",
      "http://localhost:3001/v1/skills/release-notes-helper/releases/0.1.0",
    ].sort());
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
  await view.findByText(/myskills export 'release-notes-helper' --version '0\.1\.0' --platform 'codex'/);

  fireEvent.click(view.getByRole("button", { name: "generic" }));

  await view.findByText(/myskills export 'release-notes-helper' --version '0\.1\.0' --platform 'generic'/);
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

test("login form can request a password reset email", async () => {
  setupDom("http://localhost/login");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  fireEvent.click(await view.findByRole("button", { name: /forgot password/i }));
  fireEvent.input(view.getByLabelText("Reset email"), { target: { value: "reader@example.com" } });
  fireEvent.click(view.getByRole("button", { name: /send reset email/i }));

  await view.findByText("If that account exists, a password reset email has been sent.");
  assert.deepEqual(client.passwordResetRequests, ["reader@example.com"]);
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

test("signed-in users can set up MFA and save recovery codes", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"], mfaVerified: false }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("owner@example.com");
  fireEvent.click(view.getByRole("button", { name: "Settings" }));
  await view.findByText("Authenticator app not set");
  fireEvent.input(view.getAllByLabelText("Current password").at(-1)!, { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /continue/i }));

  await view.findByText(/otpauth:\/\/totp\/MySkills/);
  fireEvent.input(view.getByLabelText("MFA setup code"), { target: { value: "123456" } });
  fireEvent.click(view.getByRole("button", { name: /enable mfa/i }));

  await view.findByText("MFA enabled. Save these recovery codes before leaving this page.");
  await view.findByText(/recovery-one/);
  assert.deepEqual(client.mfaEnrollments, ["correct horse battery staple"]);
  assert.deepEqual(client.mfaConfirmations, ["mfa-factor-1:123456"]);
});

test("settings can request email change and password change", async () => {
  setupAuthenticatedDom("http://localhost/settings", authUser({ email: "owner@example.com", roles: ["owner"] }));
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"] }) });

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Change email");

  fireEvent.input(view.getByLabelText("New email"), { target: { value: "new@example.com" } });
  fireEvent.input(view.getAllByLabelText("Current password")[0]!, { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /send verification/i }));
  await view.findByText("Verification email sent. Confirm the new address to complete the change.");
  assert.deepEqual(client.emailChangeRequests, ["new@example.com:correct horse battery staple"]);

  fireEvent.input(view.getAllByLabelText("Current password")[1]!, { target: { value: "correct horse battery staple" } });
  fireEvent.input(view.getByLabelText("New password"), { target: { value: "new correct horse battery staple" } });
  fireEvent.input(view.getByLabelText("Confirm new password"), { target: { value: "new correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /change password/i }));

  await view.findByText("Password changed. Sign in again with the new password.");
  assert.deepEqual(client.passwordChanges, ["correct horse battery staple"]);
  assert.equal(window.localStorage.getItem("myskills-app:web-session"), null);
});

test("settings can create and revoke API keys", async () => {
  setupAuthenticatedDom("http://localhost/settings", authUser({ email: "owner@example.com", roles: ["owner"] }));
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"] }) });

  const view = render(<RegistryApp client={client} />);
  await view.findByText("API keys");

  fireEvent.input(view.getByLabelText("Key name"), { target: { value: "MCP client" } });
  fireEvent.click(view.getByLabelText("Submit skills"));
  fireEvent.click(view.getByRole("button", { name: /create key/i }));

  await view.findByText("mysk_live_created_secret");
  assert.deepEqual(client.apiTokenCreates, [{ name: "MCP client", scopes: ["skills:read", "skills:submit"] }]);

  fireEvent.click(view.getByLabelText("Revoke CLI"));
  await waitFor(() => assert.deepEqual(client.apiTokenRevokes, ["api-token-1"]));
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

test("signed-in users can open the teams workspace", async () => {
  setupAuthenticatedDom("http://localhost/teams");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Team sharing");
  assert.equal((await view.findAllByText("Platform Team")).length >= 1, true);
  await view.findByText("Release Notes Helper");
  assert.equal(client.listTeamCalls, 1);
  assert.equal(client.searchCalls.length, 0);
  assert.equal(window.location.pathname, "/teams");
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

  await view.findByRole("button", { name: "Refresh" });
  await waitFor(() => assert.equal(view.getAllByText("Cloudflare Access").length >= 1, true));
  await view.findByText("API keys");
  assert.equal(document.body.textContent?.includes("clientSecret"), false);
  assert.equal(document.body.textContent?.includes("private_key"), false);
  assert.equal((view.getByLabelText("Set author@example.com author role") as HTMLInputElement).disabled, true);

  fireEvent.click(view.getByLabelText("Revoke CLI"));
  await waitFor(() => assert.deepEqual(client.adminTokenRevokes, ["api-token-1"]));

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

  await view.findByRole("button", { name: "Refresh" });
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
  const client = mockClient({ user: authUser({ email: "author@example.com", roles: ["author"] }), userSubmissions: [] });

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
  await view.findByText("My submitted skills");
  assert.equal(client.submitCalls[0]?.filename, "release-notes-helper.zip");
  assert.equal(client.submitCalls[0]?.contentBase64, "UEsgYXJjaGl2ZSBjb250ZW50");
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("PK archive content"), false);
  assert.equal(document.body.textContent?.includes("UEsgYXJjaGl2ZSBjb250ZW50"), false);

  fireEvent.click(view.getByRole("button", { name: /export/i }));
  await waitFor(() => assert.deepEqual(client.submissionExports, ["submission-1"]));
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
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
  adminApiTokens?: AdminApiToken[];
  apiTokens?: ApiToken[];
  adminProviders?: AdminProviderConfig[];
  adminUsers?: AdminUser[];
  reviewSubmissions?: ReviewSubmissionSummary[];
  skills?: PublicSkill[];
  release?: ReleaseMetadata;
  getSkillError?: SafeApiError;
  loginError?: SafeApiError;
  mfaRequired?: boolean;
  mfaStatus?: MfaStatus;
  searchResults?: (query: string) => PublicSkill[];
  sharingDetails?: SkillSharingDetails;
  submitError?: SafeApiError;
  submitResult?: SubmitSkillResult;
  teamDashboard?: TeamDashboard;
  teamSharedGroups?: TeamSharedSkillGroup[];
  userSubmissions?: UserSubmissionSummary[];
  user?: ReturnType<typeof authUser>;
} = {}) {
  const skills = input.skills ?? [publicSkill()];
  const release = input.release ?? publicRelease();
  const currentUser = input.user ?? authUser();
  let registrationMode: AdminRegistrationMode = "closed";
  let adminUsers = input.adminUsers ?? defaultAdminUsers();
  let apiTokens = input.apiTokens ?? defaultApiTokens();
  let adminApiTokens = input.adminApiTokens ?? defaultAdminApiTokens();
  let adminProviders = input.adminProviders ?? defaultAdminProviders();
  let reviewSubmissions = input.reviewSubmissions ?? defaultReviewSubmissions();
  let userSubmissions = input.userSubmissions ?? defaultUserSubmissions();
  let mfaStatus = input.mfaStatus ?? defaultMfaStatus(currentUser.mfaVerified);
  let teamDashboard = input.teamDashboard ?? defaultTeamDashboard();
  let teamSharedGroups = input.teamSharedGroups ?? defaultTeamSharedGroups();
  let sharingDetails = input.sharingDetails ?? defaultSharingDetails();
  const client: RegistryClient & {
    adminTokenRevokes: string[];
    apiTokenCreates: Array<{ name: string; scopes: ApiTokenScope[] }>;
    apiTokenRevokes: string[];
    bundleCalls: number;
    emailChangeRequests: string[];
    mfaConfirmations: string[];
    mfaDisables: string[];
    mfaEnrollments: string[];
    listTeamCalls: number;
    logoutCalls: number;
    mfaCalls: string[];
    passwordChanges: string[];
    passwordResetRequests: string[];
    providerUpserts: Array<{ key: string; displayName: string; roleMappings?: ProviderRoleMappingInput[] }>;
    registrationUpdates: AdminRegistrationMode[];
    releaseCalls: string[];
    reviewActions: string[];
    roleUpdates: string[];
    searchCalls: string[];
    submitCalls: Array<{ filename: string; contentBase64: string }>;
    submissionExports: string[];
    userActions: string[];
    teamCreates: string[];
    teamInvites: string[];
    teamInvitationAccepts: string[];
    sharingUpdates: Array<{ slug: string; visibility: string; teamIds: string[]; userEmails: string[] }>;
  } = {
    adminTokenRevokes: [],
    apiTokenCreates: [],
    apiTokenRevokes: [],
    bundleCalls: 0,
    emailChangeRequests: [],
    mfaConfirmations: [],
    mfaDisables: [],
    mfaEnrollments: [],
    listTeamCalls: 0,
    logoutCalls: 0,
    mfaCalls: [],
    passwordChanges: [],
    passwordResetRequests: [],
    providerUpserts: [],
    registrationUpdates: [],
    releaseCalls: [],
    reviewActions: [],
    roleUpdates: [],
    searchCalls: [],
    submitCalls: [],
    submissionExports: [],
    userActions: [],
    teamCreates: [],
    teamInvites: [],
    teamInvitationAccepts: [],
    sharingUpdates: [],
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
    async requestPasswordReset(input) {
      client.passwordResetRequests.push(input.email);
      return { status: "pending" };
    },
    async confirmPasswordReset() {
      return { status: "reset" };
    },
    async confirmEmailVerification() {
      return { status: "verified" };
    },
    async logout() {
      client.logoutCalls += 1;
    },
    async changePassword(input) {
      client.passwordChanges.push(input.currentPassword);
      return { status: "changed" };
    },
    async requestEmailChange(input) {
      client.emailChangeRequests.push(`${input.email}:${input.password}`);
      return { status: "pending" };
    },
    async confirmEmailChange() {
      return { status: "changed" };
    },
    async verifyMfa(input) {
      client.mfaCalls.push(input.codeOrRecoveryCode);
      return {
        token: "mfa-session-token",
        expiresAt: "2026-06-04T01:00:00.000Z",
        user: authUser({ mfaVerified: true }),
      };
    },
    async getMfaStatus() {
      return mfaStatus;
    },
    async startTotpEnrollment(input) {
      client.mfaEnrollments.push(input.password);
      return {
        factorId: "mfa-factor-1",
        label: input.label ?? "Authenticator app",
        secret: "JBSWY3DPEHPK3PXP",
        otpauthUrl: "otpauth://totp/MySkills:owner%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=MySkills",
      };
    },
    async confirmTotpEnrollment(input) {
      client.mfaConfirmations.push(`${input.factorId}:${input.code}`);
      mfaStatus = {
        totpEnabled: true,
        recoveryCodesRemaining: 2,
        factors: [{
          id: input.factorId,
          type: "totp",
          status: "enabled",
          label: "1Password",
          enabledAt: "2026-06-14T00:00:00.000Z",
          createdAt: "2026-06-14T00:00:00.000Z",
        }],
      };
      return {
        factor: mfaStatus.factors[0]!,
        recoveryCodes: ["recovery-one", "recovery-two"],
      };
    },
    async disableTotpMfa(input) {
      client.mfaDisables.push(input.password);
      mfaStatus = {
        totpEnabled: false,
        recoveryCodesRemaining: 0,
        factors: [],
      };
      return { status: "disabled", disabledFactors: 1 };
    },
    async listApiTokens() {
      return apiTokens;
    },
    async createApiToken(input) {
      client.apiTokenCreates.push({ name: input.name, scopes: input.scopes });
      const token: ApiToken & { token: string } = {
        id: `api-token-${apiTokens.length + 1}`,
        name: input.name,
        tokenPrefix: "mysk_live",
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? "2026-09-01T00:00:00.000Z",
        revokedAt: null,
        lastUsedAt: null,
        createdAt: "2026-06-14T00:00:00.000Z",
        token: "mysk_live_created_secret",
      };
      apiTokens = [token, ...apiTokens];
      return token;
    },
    async revokeApiToken(tokenId) {
      client.apiTokenRevokes.push(tokenId);
      apiTokens = apiTokens.map((token) => token.id === tokenId ? { ...token, revokedAt: "2026-06-14T00:00:00.000Z" } : token);
      return apiTokens.find((token) => token.id === tokenId) ?? defaultApiTokens()[0];
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
    async listAdminApiTokens() {
      return adminApiTokens;
    },
    async revokeAdminApiToken(tokenId) {
      client.adminTokenRevokes.push(tokenId);
      adminApiTokens = adminApiTokens.map((token) => token.id === tokenId ? { ...token, revokedAt: "2026-06-14T00:00:00.000Z" } : token);
      return adminApiTokens.find((token) => token.id === tokenId) ?? defaultAdminApiTokens()[0];
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
      const submitResult = input.submitResult ?? defaultSubmitResult();
      userSubmissions = [defaultUserSubmission({
        id: submitResult.submission.id,
        slug: submitResult.submission.slug,
        version: submitResult.submission.version,
        reviewStatus: submitResult.submission.reviewStatus,
        securityStatus: submitResult.submission.securityStatus,
      }), ...userSubmissions.filter((submission) => submission.id !== submitResult.submission.id)];
      return submitResult;
    },
    async listUserSubmissions() {
      return userSubmissions;
    },
    async exportUserSubmission(submissionId) {
      client.submissionExports.push(submissionId);
      return {
        files: [
          { path: "skill.json", content: "{\"name\":\"release-notes-helper\"}" },
          { path: "README.md", content: "Summarize release notes." },
        ],
      };
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
    async listTeams() {
      client.listTeamCalls += 1;
      return teamDashboard;
    },
    async createTeam(name) {
      client.teamCreates.push(name);
      const team = defaultTeamRecord({ id: `team-${teamDashboard.teams.length + 1}`, name });
      teamDashboard = { ...teamDashboard, teams: [team, ...teamDashboard.teams] };
      return team;
    },
    async inviteTeamMember(teamId, email) {
      client.teamInvites.push(`${teamId}:${email}`);
      const invitation = defaultTeamInvitation({ id: `invite-${client.teamInvites.length + 1}`, teamId, email });
      teamDashboard = {
        ...teamDashboard,
        teams: teamDashboard.teams.map((team) => (
          team.id === teamId ? { ...team, invitations: [invitation, ...team.invitations] } : team
        )),
      };
      return invitation;
    },
    async acceptTeamInvitation(invitationId) {
      client.teamInvitationAccepts.push(invitationId);
      const invitation = teamDashboard.invitations.find((item) => item.id === invitationId) ?? defaultTeamInvitation({ id: invitationId });
      teamDashboard = {
        ...teamDashboard,
        invitations: teamDashboard.invitations.filter((item) => item.id !== invitationId),
      };
      return { ...invitation, status: "accepted" };
    },
    async listTeamSharedSkills() {
      return teamSharedGroups;
    },
    async getSkillSharing() {
      return sharingDetails;
    },
    async updateSkillSharing(input) {
      client.sharingUpdates.push(input);
      sharingDetails = {
        ...sharingDetails,
        visibility: input.visibility,
        teamGrants: sharingDetails.availableTeams.filter((team) => input.teamIds.includes(team.id)),
        userGrants: input.userEmails.map((email, index) => ({ id: `grant-user-${index + 1}`, email, name: email })),
      };
      teamSharedGroups = teamSharedGroups.map((group) => ({ ...group }));
      return sharingDetails;
    },
  };
  return client;
}

function defaultTeamDashboard(): TeamDashboard {
  const team = defaultTeamRecord();
  return {
    teams: [team],
    invitations: [defaultTeamInvitation({ id: "invite-owned-1", teamId: team.id, teamName: team.name })],
  };
}

function defaultTeamRecord(input: Partial<TeamRecord> = {}): TeamRecord {
  const now = "2026-06-14T00:00:00.000Z";
  return {
    id: input.id ?? "team-1",
    name: input.name ?? "Platform Team",
    slug: input.slug ?? "platform-team",
    role: input.role ?? "owner",
    members: input.members ?? [{
      id: "user-1",
      email: "reader@example.com",
      name: "Reader",
      role: "owner",
    }],
    invitations: input.invitations ?? [],
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function defaultTeamInvitation(input: Partial<TeamInvitation> = {}): TeamInvitation {
  return {
    id: input.id ?? "invite-1",
    teamId: input.teamId ?? "team-1",
    teamName: input.teamName ?? "Platform Team",
    email: input.email ?? "reader@example.com",
    status: input.status ?? "pending",
    createdAt: input.createdAt ?? "2026-06-14T00:00:00.000Z",
  };
}

function defaultTeamSharedGroups(): TeamSharedSkillGroup[] {
  return [{
    team: {
      id: "team-1",
      name: "Platform Team",
      role: "owner",
    },
    sharingWithTeam: [publicSkill()],
    sharedWithMe: [{
      ...publicSkill("private-risk-reviewer"),
      title: "Private Risk Reviewer",
      summary: "Surfaces private review risks.",
      tags: ["review"],
    }],
  }];
}

function defaultSharingDetails(): SkillSharingDetails {
  return {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    visibility: "team",
    settings: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
    },
    availableTeams: [{ id: "team-1", name: "Platform Team", role: "owner" }],
    teamGrants: [{ id: "team-1", name: "Platform Team", role: "owner" }],
    userGrants: [],
  };
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

function defaultUserSubmission(input: Partial<UserSubmissionSummary> = {}): UserSubmissionSummary {
  return {
    id: input.id ?? "submission-owned-1",
    slug: input.slug ?? "release-notes-helper",
    title: input.title ?? "Release Notes Helper",
    summary: input.summary ?? "Turns merged changes into concise release notes.",
    version: input.version ?? "0.1.0",
    visibility: input.visibility ?? "public",
    reviewStatus: input.reviewStatus ?? "approved",
    securityStatus: input.securityStatus ?? "passed",
    platforms: input.platforms ?? [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    findingCount: input.findingCount ?? 0,
    artifact: input.artifact ?? {
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      byteSize: 1234,
      contentType: "application/vnd.myskills-app.package+json",
    },
    createdAt: input.createdAt ?? "2026-06-14T00:00:00.000Z",
    publishedAt: input.publishedAt ?? "2026-06-14T00:00:00.000Z",
  };
}

function defaultUserSubmissions(): UserSubmissionSummary[] {
  return [defaultUserSubmission()];
}

function defaultApiTokens(): ApiToken[] {
  return [{
    id: "api-token-1",
    name: "CLI",
    tokenPrefix: "mysk_live",
    scopes: ["skills:read"],
    expiresAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-06-14T00:00:00.000Z",
  }];
}

function defaultAdminApiTokens(): AdminApiToken[] {
  return [{
    ...defaultApiTokens()[0]!,
    user: {
      id: "user-2",
      email: "author@example.com",
      name: "Author",
      status: "active",
      roles: ["author"],
    },
  }];
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

function defaultMfaStatus(enabled: boolean): MfaStatus {
  return {
    totpEnabled: enabled,
    recoveryCodesRemaining: enabled ? 10 : 0,
    factors: enabled
      ? [{
        id: "mfa-factor-existing",
        type: "totp",
        status: "enabled",
        label: "Authenticator app",
        enabledAt: "2026-06-04T00:00:00.000Z",
        createdAt: "2026-06-04T00:00:00.000Z",
      }]
      : [],
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
