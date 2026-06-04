import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { PublicSkill } from "@ai-skills-share/core";
import { RegistryApp } from "../src/App.js";
import type {
  AdminAuditEvent,
  AdminProviderConfig,
  AdminRegistrationMode,
  AdminUser,
  ProviderRoleMappingInput,
  RegistryClient,
  ReleaseMetadata,
  SafeApiError,
} from "../src/api.js";

test("browse page requests skills with query and renders API-returned skills", async () => {
  setupDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Release Notes Helper");
  fireEvent.input(view.getByPlaceholderText("Search skills..."), { target: { value: "release" } });

  await waitFor(() => assert.equal(client.searchCalls.includes("release"), true));
  assert.equal(view.getAllByText("release-notes-helper").length, 2);
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
  await view.findByText(/ai-skills export release-notes-helper --version 0\.1\.0 --platform codex/);

  fireEvent.click(view.getByRole("button", { name: "generic" }));

  await view.findByText(/ai-skills export release-notes-helper --version 0\.1\.0 --platform generic/);
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
  assert.equal(JSON.parse(window.localStorage.getItem("ai-skills-share:web-session") ?? "{}").token, "web-session-token");

  fireEvent.click(view.getByLabelText("Sign out"));

	  await view.findByRole("button", { name: /sign in/i });
	  assert.equal((view.getByLabelText("Password") as HTMLInputElement).value, "");
	  assert.equal(window.localStorage.getItem("ai-skills-share:web-session"), null);
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
  assert.equal(JSON.parse(window.localStorage.getItem("ai-skills-share:web-session") ?? "{}").token, "mfa-session-token");
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

  fireEvent.click(view.getByRole("button", { name: "Request" }));
  await waitFor(() => assert.deepEqual(client.registrationUpdates, ["request"]));

  fireEvent.click(view.getByLabelText("Disable user"));
  await waitFor(() => assert.deepEqual(client.userActions, ["user-2:disable"]));

  fireEvent.input(view.getByLabelText("Display name"), { target: { value: "Cloudflare Main" } });
  fireEvent.click(view.getByRole("button", { name: /save provider/i }));

  await waitFor(() => assert.equal(client.providerUpserts[0]?.displayName, "Cloudflare Main"));
  assert.equal(client.providerUpserts[0]?.roleMappings?.[0]?.role, "maintainer");
});

test("malformed stored sessions are ignored before signed-in render", async () => {
  setupDom();
  window.localStorage.setItem("ai-skills-share:web-session", JSON.stringify({
    token: "stored-session-token",
    expiresAt: "2026-06-04T01:00:00.000Z",
    user: {},
  }));
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("button", { name: /sign in/i });
  assert.equal(window.localStorage.getItem("ai-skills-share:web-session"), null);
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
  assert.equal(window.localStorage.getItem("ai-skills-share:web-session"), null);
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
  adminUsers?: AdminUser[];
  skills?: PublicSkill[];
  release?: ReleaseMetadata;
  getSkillError?: SafeApiError;
  loginError?: SafeApiError;
  mfaRequired?: boolean;
  searchResults?: (query: string) => PublicSkill[];
  user?: ReturnType<typeof authUser>;
} = {}) {
  const skills = input.skills ?? [publicSkill()];
  const release = input.release ?? publicRelease();
  const currentUser = input.user ?? authUser();
  let registrationMode: AdminRegistrationMode = "closed";
  let adminUsers = input.adminUsers ?? defaultAdminUsers();
  let adminProviders = input.adminProviders ?? defaultAdminProviders();
  const client: RegistryClient & {
    bundleCalls: number;
    logoutCalls: number;
    mfaCalls: string[];
    providerUpserts: Array<{ key: string; displayName: string; roleMappings?: ProviderRoleMappingInput[] }>;
    registrationUpdates: AdminRegistrationMode[];
    releaseCalls: string[];
    searchCalls: string[];
    userActions: string[];
  } = {
    bundleCalls: 0,
    logoutCalls: 0,
    mfaCalls: [],
    providerUpserts: [],
    registrationUpdates: [],
    releaseCalls: [],
    searchCalls: [],
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
  };
  return client;
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
      contentType: "application/vnd.ai-skills-share.package+json",
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
