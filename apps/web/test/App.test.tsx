import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicSkill } from "@myskills-app/core";
import { RegistryApp } from "../src/App.js";
import type {
  AdminAuditEvent,
  AdminProviderConfig,
  AdminRegistrationMode,
  AdminSharingSettings,
  AdminUser,
  ProviderRoleMappingInput,
  RegistryClient,
  ReleaseMetadata,
  ReviewSubmissionSummary,
  SafeApiError,
  SubmitSkillResult,
  TeamDashboard,
} from "../src/api.js";

test("browse page requests skills with query and renders API-returned skills", async () => {
  setupDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Release Notes Helper");
  fireEvent.input(view.getByPlaceholderText("Search skills..."), { target: { value: "release" } });

  await waitFor(() => assert.equal(client.searchCalls.includes("release"), true));
  assert.equal(view.getAllByText("Release Notes Helper").length >= 1, true);
  assert.equal(document.body.textContent?.includes("private-risk-reviewer"), false);
});

test("default registry client is stable between renders", async () => {
  setupDom();
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
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
    await waitFor(() => assert.equal(calls.length, 3));
    await delay(25);
    assert.deepEqual(calls, [
      "http://localhost:3001/v1/skills",
      "http://localhost:3001/v1/skills/release-notes-helper",
      "http://localhost:3001/v1/skills/release-notes-helper/releases/0.1.0",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("searching selects a matching result when the current detail is filtered out", async () => {
  setupDom();
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
  setupDom();
  const client = mockClient({ skills: [] });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("No skills found.");
  assert.equal(document.body.textContent?.includes("private-risk-reviewer"), false);
  assert.equal(document.body.textContent?.includes("failed-public-skill"), false);
});

test("skill detail displays public metadata and release artifact metadata only", async () => {
  setupDom("http://localhost/skills/release-notes-helper");
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
  setupDom("http://localhost/skills/private-helper");
  const client = mockClient({
    getSkillError: safeApiError(404, "SKILL_NOT_FOUND", "Private helper exists but is hidden."),
  });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skill or release not found.");
  assert.equal(document.body.textContent?.includes("Private helper exists"), false);
  assert.equal(document.body.textContent?.includes("private-helper"), false);
});

test("platform selection changes CLI export guidance only", async () => {
  setupDom("http://localhost/skills/release-notes-helper");
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

test("registration invitation links create an account and store a session", async () => {
  setupDom("http://localhost/auth/register#token=invite-token");
  const client = mockClient({ user: authUser({ email: "invited@example.com" }) });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Complete registration");
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "invited@example.com" } });
  fireEvent.input(view.getByLabelText("Name"), { target: { value: "Invited User" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.input(view.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /create account/i }));

  await waitFor(() => assert.deepEqual(client.inviteRegistrations, [{
    email: "invited@example.com",
    name: "Invited User",
    inviteToken: "invite-token",
  }]));
  await view.findByText("invited@example.com");
  assert.equal(JSON.parse(window.localStorage.getItem("myskills-app:web-session") ?? "{}").token, "web-session-token");
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

test("signed-in users can open teams, create a team, invite a member, and accept invitations", async () => {
  setupDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("reader@example.com");
  fireEvent.click(view.getByRole("button", { name: /teams/i }));

  await view.findByText("Team sharing");
  await waitFor(() => assert.equal(view.getAllByText("Platform").length >= 1, true));

  fireEvent.input(view.getByLabelText("Team name"), { target: { value: "Docs" } });
  fireEvent.click(view.getByRole("button", { name: /create/i }));
  await waitFor(() => assert.deepEqual(client.teamCreates, ["Docs"]));

  const platformInvite = view.getByLabelText("Invite user to Platform");
  fireEvent.input(platformInvite, { target: { value: "teammate@example.com" } });
  fireEvent.submit(platformInvite.closest("form") as HTMLFormElement);
  await waitFor(() => assert.deepEqual(client.teamInvites, ["team-1:teammate@example.com"]));

  fireEvent.click(view.getByRole("button", { name: /accept/i }));
  await waitFor(() => assert.deepEqual(client.teamInvitationAccepts, ["invite-1"]));
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

  fireEvent.input(view.getByLabelText("Email"), { target: { value: "new@example.com" } });
  fireEvent.input(view.getByLabelText("Name"), { target: { value: "New User" } });
  fireEvent.click(view.getByRole("button", { name: /send invite/i }));
  await waitFor(() => assert.deepEqual(client.registrationInvites, [{ email: "new@example.com", name: "New User" }]));
  await view.findByText(/Invite sent to new@example\.com/);

  fireEvent.click(view.getByLabelText("Disable user"));
  await waitFor(() => assert.deepEqual(client.userActions, ["user-2:disable"]));

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

  await view.findByText("Review Dashboard");
  await waitFor(() => assert.equal(view.getAllByText("Version 0.1.0").length >= 1, true));
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

  await view.findByText("Submit Skill");
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

  await view.findByText("Sign in could not be completed.");
  assert.equal(document.body.textContent?.includes("registry item"), false);
  assert.equal(document.body.textContent?.includes("Wrong password"), false);
  assert.equal(window.localStorage.getItem("myskills-app:web-session"), null);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function setupDom(url = "http://localhost/") {
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", url);
}

function mockClient(input: {
  adminProviders?: AdminProviderConfig[];
  adminSharing?: AdminSharingSettings;
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
  teamDashboard?: TeamDashboard;
  user?: ReturnType<typeof authUser>;
} = {}) {
  const skills = input.skills ?? [publicSkill()];
  const release = input.release ?? publicRelease();
  const currentUser = input.user ?? authUser();
  let registrationMode: AdminRegistrationMode = "closed";
  let sharingSettings = input.adminSharing ?? defaultSharingSettings();
  let adminUsers = input.adminUsers ?? defaultAdminUsers();
  let adminProviders = input.adminProviders ?? defaultAdminProviders();
  let reviewSubmissions = input.reviewSubmissions ?? defaultReviewSubmissions();
  let teamDashboard = input.teamDashboard ?? defaultTeamDashboard();
  const client: RegistryClient & {
    bundleCalls: number;
    logoutCalls: number;
    mfaCalls: string[];
    providerUpserts: Array<{ key: string; displayName: string; roleMappings?: ProviderRoleMappingInput[] }>;
    registrationInvites: Array<{ email: string; name?: string }>;
    inviteRegistrations: Array<{ email: string; name?: string; inviteToken: string }>;
    registrationUpdates: AdminRegistrationMode[];
    releaseCalls: string[];
    reviewActions: string[];
    roleUpdates: string[];
    searchCalls: string[];
    sharingUpdates: AdminSharingSettings[];
    submitCalls: Array<{ filename: string; contentBase64: string }>;
    teamCreates: string[];
    teamInvites: string[];
    teamInvitationAccepts: string[];
    userActions: string[];
  } = {
    bundleCalls: 0,
    logoutCalls: 0,
    mfaCalls: [],
    providerUpserts: [],
    registrationInvites: [],
    inviteRegistrations: [],
    registrationUpdates: [],
    releaseCalls: [],
    reviewActions: [],
    roleUpdates: [],
    searchCalls: [],
    sharingUpdates: [],
    submitCalls: [],
    teamCreates: [],
    teamInvites: [],
    teamInvitationAccepts: [],
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
    async registerWithInvitation(input) {
      client.inviteRegistrations.push({
        email: input.email,
        name: input.name,
        inviteToken: input.inviteToken,
      });
      return { status: "active" };
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
    async createRegistrationInvitation(input) {
      client.registrationInvites.push(input);
      return {
        email: input.email.toLowerCase(),
        expiresAt: "2026-06-20T00:00:00.000Z",
      };
    },
    async getAdminSharing() {
      return sharingSettings;
    },
    async updateAdminSharing(settings) {
      sharingSettings = settings;
      client.sharingUpdates.push(settings);
      return settings;
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
    async listTeams() {
      return teamDashboard;
    },
    async createTeam(name) {
      client.teamCreates.push(name);
      const team = {
        id: `team-${teamDashboard.teams.length + 1}`,
        name,
        slug: name.toLowerCase().replace(/\s+/g, "-"),
        role: "owner" as const,
        members: [{ id: currentUser.id, email: currentUser.email, name: currentUser.name, role: "owner" as const }],
        invitations: [],
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      };
      teamDashboard = { ...teamDashboard, teams: [...teamDashboard.teams, team] };
      return team;
    },
    async inviteTeamMember(teamId, email) {
      client.teamInvites.push(`${teamId}:${email}`);
      const invitation = {
        id: `invite-${client.teamInvites.length}`,
        teamId,
        teamName: teamDashboard.teams.find((team) => team.id === teamId)?.name ?? "Team",
        email,
        status: "pending" as const,
        createdAt: "2026-06-04T00:00:00.000Z",
      };
      teamDashboard = {
        ...teamDashboard,
        teams: teamDashboard.teams.map((team) => team.id === teamId
          ? { ...team, invitations: [...team.invitations, invitation] }
          : team),
      };
      return invitation;
    },
    async acceptTeamInvitation(invitationId) {
      client.teamInvitationAccepts.push(invitationId);
      const invitation = teamDashboard.invitations.find((item) => item.id === invitationId) ?? defaultTeamDashboard().invitations[0];
      teamDashboard = {
        teams: [...teamDashboard.teams, {
          id: invitation.teamId,
          name: invitation.teamName,
          slug: invitation.teamName.toLowerCase().replace(/\s+/g, "-"),
          role: "member",
          members: [{ id: currentUser.id, email: currentUser.email, name: currentUser.name, role: "member" }],
          invitations: [],
          createdAt: invitation.createdAt,
          updatedAt: invitation.createdAt,
        }],
        invitations: teamDashboard.invitations.filter((item) => item.id !== invitationId),
      };
      return { ...invitation, status: "accepted" };
    },
    async listTeamSharedSkills() {
      return [{
        team: { id: "team-1", name: "Platform", role: "owner" },
        sharingWithTeam: [],
        sharedWithMe: [],
      }];
    },
    async getSkillSharing(slug) {
      return {
        slug,
        title: "Release Notes Helper",
        visibility: "public",
        settings: sharingSettings,
        availableTeams: teamDashboard.teams.map((team) => ({ id: team.id, name: team.name, role: team.role })),
        teamGrants: [],
        userGrants: [],
      };
    },
    async updateSkillSharing(input) {
      return {
        slug: input.slug,
        title: "Release Notes Helper",
        visibility: input.visibility,
        settings: sharingSettings,
        availableTeams: teamDashboard.teams.map((team) => ({ id: team.id, name: team.name, role: team.role })),
        teamGrants: teamDashboard.teams
          .filter((team) => input.teamIds.includes(team.id))
          .map((team) => ({ id: team.id, name: team.name, role: team.role })),
        userGrants: input.userEmails.map((email, index) => ({ id: `user-${index}`, email, name: "" })),
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

function defaultSharingSettings(): AdminSharingSettings {
  return {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
  };
}

function defaultTeamDashboard(): TeamDashboard {
  return {
    teams: [
      {
        id: "team-1",
        name: "Platform",
        slug: "platform",
        role: "owner",
        members: [
          { id: "user-1", email: "reader@example.com", name: "Reader", role: "owner" },
        ],
        invitations: [],
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      },
    ],
    invitations: [
      {
        id: "invite-1",
        teamId: "team-3",
        teamName: "Research",
        email: "reader@example.com",
        status: "pending",
        createdAt: "2026-06-04T00:00:00.000Z",
      },
    ],
  };
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
