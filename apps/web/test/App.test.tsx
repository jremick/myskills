import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  ArchitecturePattern,
  ArchitectureObservedFixture,
  ArchitecturePreview,
  ArchitectureRevisionSummary,
  ArchitectureSummary,
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

test("landing page explains public beta status and opens the login page", async () => {
  setupDom("http://localhost/");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "MySkills" });
  assert.equal(document.body.textContent?.includes("Public beta. Hosted signups are owner-gated."), true);
  assert.equal(client.searchCalls.length, 0);

  fireEvent.click(view.getAllByRole("link", { name: "Login" })[0]!);

  await view.findByRole("heading", { name: "Login" });
  assert.deepEqual(client.searchCalls, []);
  assert.equal(document.body.textContent?.includes("Release Notes Helper"), false);
  assert.equal(window.location.pathname, "/login");
});

test("invited users complete registration without leaving the token in browser history", async () => {
  setupDom("http://localhost/auth/register#token=invitation-token");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "Complete registration" });
  await waitFor(() => assert.equal(window.location.hash, ""));
  assert.equal(window.location.pathname, "/auth/register");

  fireEvent.input(view.getByLabelText("Email"), { target: { value: "Invited@Example.com" } });
  fireEvent.input(view.getByLabelText(/Name/), { target: { value: "Invited User" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.input(view.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: "Create account" }));

  await view.findByText("Registration complete. You can now log in.");
  assert.deepEqual(client.registrationCalls, [{
    email: "Invited@Example.com",
    name: "Invited User",
    password: "correct horse battery staple",
    inviteToken: "invitation-token",
  }]);
  assert.equal(document.body.textContent?.includes("invitation-token"), false);

  fireEvent.click(view.getByRole("link", { name: "Continue to login" }));
  await view.findByRole("heading", { name: "Login" });
  assert.equal(window.location.pathname, "/login");
});

test("registration invitation pages handle missing and expired links safely", async () => {
  setupDom("http://localhost/auth/register");
  const missingView = render(<RegistryApp client={mockClient()} />);

  await missingView.findByText("This invitation link is missing its token.");
  assert.equal(missingView.queryByRole("button", { name: "Create account" }), null);
  cleanup();

  setupDom("http://localhost/auth/register#token=expired-token");
  const client = mockClient({
    registrationError: safeApiError(401, "INVALID_INVITATION_TOKEN", "Expired token hash and account details."),
  });
  const expiredView = render(<RegistryApp client={client} />);

  await waitFor(() => assert.equal(window.location.hash, ""));
  fireEvent.input(expiredView.getByLabelText("Email"), { target: { value: "invited@example.com" } });
  fireEvent.input(expiredView.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.input(expiredView.getByLabelText("Confirm password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(expiredView.getByRole("button", { name: "Create account" }));

  await expiredView.findByText("This link is invalid or expired.");
  assert.equal(expiredView.queryByRole("button", { name: "Create account" }), null);
  assert.equal(document.body.textContent?.includes("Expired token hash"), false);
  assert.equal(document.body.textContent?.includes("expired-token"), false);
});

test("anonymous registry routes load approved public skills without a session", async () => {
  setupDom("http://localhost/registry");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Release Notes Helper");
  assert.deepEqual(client.searchCalls, [""]);
  assert.equal(document.body.textContent?.includes("owner@example.com"), false);
  assert.equal(window.location.pathname, "/skills/release-notes-helper");
});

test("browse page requests skills with query and renders API-returned skills", async () => {
  setupAuthenticatedDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Release Notes Helper");
  fireEvent.input(view.getByLabelText("Search skills"), { target: { value: "release" } });

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

  fireEvent.input(view.getByLabelText("Search skills"), { target: { value: "release" } });

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
  assert.equal(view.getByText("Approved").textContent, "Approved");
  assert.equal(view.getByText("Passed").textContent, "Passed");
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
  assert.equal(client.bundleCalls, 0);
});

test("privileged skill controls stay locked without an MFA-verified session and do not request management data", async () => {
  const owner = authUser({ email: "owner@example.com", roles: ["owner"], mfaVerified: false });
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper", owner);
  const managedSkill: PublicSkill = { ...publicSkill(), access: { canManageSharing: true, reasons: ["owner", "public"] } };
  const client = mockClient({ skills: [managedSkill], user: owner });

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "Lifecycle and sharing controls are locked", level: 2 });
  assert.equal(view.queryByRole("region", { name: "Skill lifecycle controls" }), null);
  assert.equal(view.queryByRole("region", { name: "Sharing controls" }), null);
  assert.equal(client.releaseManagementCalls, 0);
  assert.equal(client.sharingDetailCalls, 0);
});

test("MFA-verified managers can load lifecycle and sharing controls", async () => {
  const owner = authUser({ email: "owner@example.com", roles: ["owner"], mfaVerified: true });
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper", owner);
  const managedSkill: PublicSkill = { ...publicSkill(), access: { canManageSharing: true, reasons: ["owner", "public"] } };
  const client = mockClient({ skills: [managedSkill], user: owner });

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("region", { name: "Skill lifecycle controls" });
  await view.findByRole("region", { name: "Sharing controls" });
  assert.equal(client.releaseManagementCalls, 1);
  assert.equal(client.sharingDetailCalls, 1);
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
  assert.equal(window.location.search, "?platform=generic");
  assert.equal(client.releaseCalls.length, 1);
  assert.equal(client.bundleCalls, 0);
});

test("URL state and popstate restore search, selection, platform, and active navigation", async () => {
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper?q=release&platform=generic");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByText(/--platform 'generic'/);
  assert.equal((view.getByLabelText("Search skills") as HTMLInputElement).value, "release");
  const selectedResult = view.getByRole("link", { name: /Release Notes Helper/ });
  assert.equal(selectedResult.getAttribute("aria-current"), "true");
  assert.equal(selectedResult.getAttribute("href"), "/skills/release-notes-helper?q=release&platform=generic");
  const modifiedClick = new window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
  selectedResult.dispatchEvent(modifiedClick);
  assert.equal(modifiedClick.defaultPrevented, false);
  assert.equal(view.getAllByRole("link", { name: "Registry" })[0]?.getAttribute("aria-current"), "page");

  fireEvent.click(view.getAllByRole("link", { name: "Settings" })[0]!);
  await view.findByRole("heading", { name: "Security and access", level: 1 });
  assert.equal(window.location.pathname, "/settings");

  window.history.replaceState({}, "", "/skills/release-notes-helper?q=release&platform=generic");
  window.dispatchEvent(new window.PopStateEvent("popstate"));

  await view.findByText(/--platform 'generic'/);
  assert.equal((view.getByLabelText("Search skills") as HTMLInputElement).value, "release");
  assert.equal(window.location.pathname, "/skills/release-notes-helper");
});

test("unknown routes render an explicit not-found view", async () => {
  setupDom("http://localhost/missing-page");

  const view = render(<RegistryApp client={mockClient()} />);

  await view.findByRole("heading", { name: "Page not found", level: 1 });
  assert.equal(view.getByRole("link", { name: "Return home" }).getAttribute("href"), "/");
});

test("copy actions announce success to assistive technology", async (t) => {
  setupAuthenticatedDom("http://localhost/skills/release-notes-helper");
  const writes: string[] = [];
  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { writes.push(value); } },
  });
  t.after(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard }));

  const view = render(<RegistryApp client={mockClient()} />);
  await view.findByText(/myskills export/);
  fireEvent.click(view.getByRole("button", { name: "Copy" }));

  await view.findByText("Copied to clipboard.");
  assert.equal(writes[0]?.includes("myskills export"), true);
});

test("login stores session metadata without persisting bearer tokens and logout clears it", async () => {
  setupDom();
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("reader@example.com");
  await view.findByText("Release Notes Helper");
  assert.equal(window.location.pathname, "/skills/release-notes-helper");
  assert.equal(document.body.textContent?.includes("web-session-token"), false);
  const stored = JSON.parse(window.localStorage.getItem("myskills-app:web-session") ?? "{}") as Record<string, unknown>;
  assert.equal("token" in stored, false);
  assert.equal(stored.expiresAt, "2026-06-04T01:00:00.000Z");

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
  const stored = JSON.parse(window.localStorage.getItem("myskills-app:web-session") ?? "{}") as Record<string, unknown>;
  assert.equal("token" in stored, false);
  assert.equal(stored.expiresAt, "2026-06-04T01:00:00.000Z");
});

test("signed-in users can set up MFA and save recovery codes", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"], mfaVerified: false }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("owner@example.com");
  fireEvent.click(view.getAllByRole("link", { name: "Settings" })[0]!);
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
  await view.findByRole("heading", { name: "Security and access", level: 1 });
  await view.findByText("Authenticator app MFA is enabled.");
  assert.equal(document.body.textContent?.includes("Authenticator setup"), false);

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
  fireEvent.click(await view.findByRole("button", { name: "Revoke key" }));
  await waitFor(() => assert.deepEqual(client.apiTokenRevokes, ["api-token-1"]));
});

test("API key expiry rejects past dates before sending a request", async () => {
  setupAuthenticatedDom("http://localhost/settings", authUser({ email: "owner@example.com", roles: ["owner"] }));
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"] }) });
  const view = render(<RegistryApp client={client} />);
  await view.findByText("API keys");

  fireEvent.input(view.getByLabelText("Key name"), { target: { value: "Expired key" } });
  fireEvent.input(view.getByLabelText("Expires at"), { target: { value: "2020-01-01T00:00" } });
  fireEvent.click(view.getByRole("button", { name: /create key/i }));

  await view.findByText("Choose a valid future date and time.");
  assert.deepEqual(client.apiTokenCreates, []);
});

test("non-admin sessions do not render the admin entry point", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ roles: ["author"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "reader@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("reader@example.com");
  assert.equal(view.queryByRole("link", { name: /admin/i }), null);
  assert.equal(view.queryByRole("link", { name: /review/i }), null);
});

test("role-gated deep links normalize to the public registry when access is denied", async () => {
  setupAuthenticatedDom("http://localhost/admin", authUser({ roles: ["author"] }));
  const client = mockClient({ user: authUser({ roles: ["author"] }) });

  const view = render(<RegistryApp client={client} />);

  await view.findByText("Release Notes Helper");
  await waitFor(() => assert.equal(window.location.pathname, "/skills/release-notes-helper"));
  assert.equal(view.queryByRole("heading", { name: "Admin console" }), null);
});

test("signed-in users can open the teams workspace", async () => {
  setupAuthenticatedDom("http://localhost/teams");
  const client = mockClient();

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "Teams", level: 1 });
  assert.equal((await view.findAllByText("Platform Team")).length >= 1, true);
  await view.findAllByText("reader@example.com");
  await view.findByText("Release Notes Helper");
  assert.equal(client.listTeamCalls, 1);
  assert.equal(client.searchCalls.length, 0);
  assert.equal(window.location.pathname, "/teams");
});

test("signed-in users can create and inspect a multi-level skill architecture", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architectures: [],
    architecturePatterns: defaultArchitecturePatterns(),
    architecturePreview: defaultArchitecturePreview(),
  });

  const view = render(<RegistryApp client={client} />);

  await view.findByRole("heading", { name: "Skill architectures", level: 1 });
  await view.findByRole("heading", { name: "Multi-level router", level: 3 });
  await view.findByText("No architectures yet.");

  fireEvent.input(view.getByLabelText("Architecture name"), { target: { value: "Work assistant" } });
  fireEvent.click(view.getByRole("button", { name: "Create architecture" }));

  await view.findByRole("heading", { name: "Work assistant" });
  await view.findByText(/This draft has no revision yet/);
  assert.equal(client.architectureCreates.length, 1);
  assert.equal(client.architecturePreviewCalls.length, 0);
  assert.equal(client.searchCalls.length, 0);
  assert.equal(document.body.textContent?.includes("No target is changed by this preview."), false);
});

test("architecture context selectors request a new API preview without compiling grants in the browser", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
    architecturePreview: defaultArchitecturePreview(),
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  const initialCount = client.architecturePreviewCalls.length;
  fireEvent.change(view.getByLabelText("Preview profile"), { target: { value: "work" } });
  fireEvent.change(view.getByLabelText("Preview environment"), { target: { value: "codex-work" } });

  await waitFor(() => assert.equal(client.architecturePreviewCalls.length > initialCount, true));
  const lastPreview = client.architecturePreviewCalls.at(-1);
  assert.deepEqual(lastPreview, {
    architectureId: "architecture-1",
    profileId: "work",
    environmentId: "codex-work",
    revisionId: "revision-1",
  });
  assert.equal(document.body.textContent?.includes("Authorization is resolved server-side."), true);
  assert.equal(document.body.textContent?.includes("No sync plan generated. Provide an observed-state fixture to preview a target dry run."), true);
});

test("observed fixture submission rejects unsupported fields before the API", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  const before = client.architecturePreviewCalls.length;
  fireEvent.click(view.getByText("Compare observed-state fixture"));
  fireEvent.input(view.getByLabelText("Observed-state fixture JSON"), { target: { value: '{"targetId":"codex-personal","secret":"not-allowed"}' } });
  fireEvent.click(view.getByRole("button", { name: "Generate dry-run plan" }));

  await view.findByText("The observed-state fixture must use targetId and only allowlisted metadata fields.");
  assert.equal(client.architecturePreviewCalls.length, before);
});

test("observed fixture submission requests and renders the returned dry-run plan", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  fireEvent.click(view.getByText("Compare observed-state fixture"));
  fireEvent.input(view.getByLabelText("Observed-state fixture JSON"), { target: { value: '{"targetId":"codex-personal","nodes":[]}' } });
  fireEvent.click(view.getByRole("button", { name: "Generate dry-run plan" }));

  await view.findByText("Dry-run plan generated from the supplied observed state. No target was changed.");
  const lastPreview = client.architecturePreviewCalls.at(-1);
  assert.equal(lastPreview?.revisionId, "revision-1");
  assert.deepEqual(lastPreview?.fixture, { targetId: "codex-personal", nodes: [] });
  await view.findByText("Target already matches the selected desired state.");
  assert.equal(document.body.textContent?.includes("noop"), false);
});

test("stale observed fixture responses cannot replace a newer preview context", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  let resolveFixturePreview: ((preview: ArchitecturePreview) => void) | undefined;
  const delayedFixturePreview = new Promise<ArchitecturePreview>((resolve) => {
    resolveFixturePreview = resolve;
  });
  const stalePreview = defaultArchitecturePreview({
    graph: {
      ...defaultArchitecturePreview().graph,
      nodes: [{ id: "stale", kind: "router", label: "Stale fixture result", depth: 0, x: 40, y: 22 }],
      edges: [],
      mermaid: "flowchart TD\n  stale[Stale fixture result]",
    },
    outline: {
      ...defaultArchitecturePreview().outline,
      text: "Stale fixture result",
      tree: [{ id: "stale", label: "Stale fixture result", kind: "router", children: [] }],
    },
  });
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
    architecturePreview: defaultArchitecturePreview(),
    architectureFixturePreview: delayedFixturePreview,
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  fireEvent.click(view.getByText("Compare observed-state fixture"));
  fireEvent.input(view.getByLabelText("Observed-state fixture JSON"), { target: { value: '{"targetId":"codex-personal","nodes":[]}' } });
  fireEvent.click(view.getByRole("button", { name: "Generate dry-run plan" }));
  await waitFor(() => assert.equal(client.architecturePreviewCalls.some((call) => call.fixture !== undefined), true));

  fireEvent.change(view.getByLabelText("Preview profile"), { target: { value: "work" } });
  await waitFor(() => assert.equal(client.architecturePreviewCalls.at(-1)?.profileId, "work"));
  resolveFixturePreview?.(stalePreview);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(document.body.textContent?.includes("Stale fixture result"), false);
});

test("architecture revisions parse JSON before the API and refresh after a valid immutable save", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
    architecturePreview: defaultArchitecturePreview(),
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  fireEvent.click(view.getByText("Add immutable revision"));
  fireEvent.input(view.getByLabelText("Revision message"), { target: { value: "Bind the work context" } });
  const validSpec = defaultArchitecturePreview().revision.spec;
  fireEvent.input(view.getByLabelText("Architecture spec JSON"), { target: { value: JSON.stringify(validSpec) } });
  fireEvent.click(view.getByRole("button", { name: "Save immutable revision" }));

  await waitFor(() => assert.equal(client.architectureRevisionCreates.length, 1));
  assert.deepEqual(client.architectureRevisionCreates[0], {
    architectureId: "architecture-1",
    spec: validSpec,
    message: "Bind the work context",
  });
  await view.findByText("Revision 2");
});

test("architecture revision form rejects invalid JSON without calling the API", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
    architecturePreview: defaultArchitecturePreview(),
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  fireEvent.click(view.getByText("Add immutable revision"));
  fireEvent.input(view.getByLabelText("Architecture spec JSON"), { target: { value: "{not-json" } });
  fireEvent.click(view.getByRole("button", { name: "Save immutable revision" }));

  await view.findByText("Enter valid JSON before saving the revision.");
  assert.equal(client.architectureRevisionCreates.length, 0);
});

test("architecture selection clears stale detail before previewing a new draft", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [
      defaultArchitectureSummary(),
      defaultArchitectureSummary({ id: "architecture-2", name: "Draft assistant", latestRevision: null, currentRevisionId: null, revisionCount: 0, status: "draft" }),
    ],
    architecturePreview: defaultArchitecturePreview(),
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Skills available in this context");
  fireEvent.click(view.getByRole("button", { name: /Draft assistant/ }));

  await view.findByRole("heading", { name: "Draft assistant", level: 2 });
  await view.findByText(/This draft has no revision yet/);
  assert.equal(client.architecturePreviewCalls.some((call) => call.architectureId === "architecture-2"), false);
});

test("architecture conflicts and unsupported target changes remain visible as safe read-only states", async () => {
  setupAuthenticatedDom("http://localhost/architectures");
  const conflictPreview = defaultArchitecturePreview({
    plan: {
      dryRun: true,
      canApply: false,
      requiresApproval: true,
      targetId: "codex-personal",
      environmentId: "codex-personal",
      architectureId: "architecture-1",
      revisionDigest: "a".repeat(64),
      items: [{
        action: "conflict",
        nodeId: "quality",
        kind: "router",
        reason: "Observed target revision differs.",
      }],
    },
  });
  const client = mockClient({
    architecturePatterns: defaultArchitecturePatterns(),
    architectures: [defaultArchitectureSummary()],
    architecturePreview: conflictPreview,
  });
  const view = render(<RegistryApp client={client} />);

  await view.findByText("Conflict needs review");
  await view.findByText("Observed target revision differs.");
  assert.equal(view.queryByRole("button", { name: /apply/i }), null);
  assert.equal(document.body.textContent?.includes("Observed target revision differs."), true);
});

test("admin sessions can manage registration, users, and provider metadata", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "owner@example.com", roles: ["owner"] }) });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("owner@example.com");
  fireEvent.click(view.getAllByRole("link", { name: "Admin" })[0]!);

  await view.findByRole("heading", { name: "Admin console", level: 1 });
  await view.findByRole("button", { name: "Refresh" });
  await waitFor(() => assert.equal(view.getAllByText("Cloudflare Access").length >= 1, true));
  await view.findByText("API keys");
  assert.equal(document.body.textContent?.includes("clientSecret"), false);
  assert.equal(document.body.textContent?.includes("private_key"), false);
  assert.equal((view.getByLabelText("Set author@example.com author role") as HTMLInputElement).disabled, true);

  fireEvent.input(view.getByLabelText("Email", { selector: "input[name='invitation-email']" }), { target: { value: "new-author@example.com" } });
  fireEvent.input(view.getByLabelText(/Name/, { selector: "input[name='invitation-name']" }), { target: { value: "New Author" } });
  fireEvent.click(view.getByRole("button", { name: "Send invitation" }));
  await view.findByText(/Invitation sent to new-author@example\.com\./);
  assert.deepEqual(client.registrationInvitations, [{ email: "new-author@example.com", name: "New Author" }]);

  fireEvent.click(view.getByLabelText("Revoke CLI"));
  fireEvent.click(await view.findByRole("button", { name: "Revoke key" }));
  await waitFor(() => assert.deepEqual(client.adminTokenRevokes, ["api-token-1"]));

  fireEvent.click(view.getByRole("button", { name: "Request" }));
  await waitFor(() => assert.deepEqual(client.registrationUpdates, ["request"]));

  fireEvent.click(view.getByRole("button", { name: "Open" }));
  assert.deepEqual(client.registrationUpdates, ["request"]);
  fireEvent.click(await view.findByRole("button", { name: "Cancel" }));

  fireEvent.click(view.getByRole("button", { name: "Open" }));
  fireEvent.click(await view.findByRole("button", { name: "Open registration" }));
  await waitFor(() => assert.deepEqual(client.registrationUpdates, ["request", "open"]));

  fireEvent.click(view.getByLabelText("Disable user"));
  fireEvent.input(view.getByLabelText("Reason (required)"), { target: { value: "Access review failed" } });
  fireEvent.click((await view.findAllByRole("button", { name: "Disable user" })).at(-1)!);
  await waitFor(() => assert.deepEqual(client.userActions, ["user-2:disable:Access review failed"]));

  fireEvent.click(view.getByLabelText("Set author@example.com maintainer role"));
  fireEvent.input(view.getByLabelText("Reason (required)"), { target: { value: "Maintainer promotion approved" } });
  fireEvent.click(await view.findByRole("button", { name: "Save role change" }));
  await waitFor(() => assert.deepEqual(client.roleUpdates, ["user-2:maintainer,author:Maintainer promotion approved"]));
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
  fireEvent.click(view.getAllByRole("link", { name: "Admin" })[0]!);

  await view.findByRole("button", { name: "Refresh" });
  assert.equal((view.getByLabelText("Set owner@example.com maintainer role") as HTMLInputElement).disabled, true);
  assert.equal((view.getByLabelText("Set author@example.com maintainer role") as HTMLInputElement).disabled, false);
});

test("admin invitation controls stay unavailable without an MFA-verified session", async () => {
  const owner = authUser({ email: "owner@example.com", roles: ["owner"], mfaVerified: false });
  setupAuthenticatedDom("http://localhost/admin", owner);
  const view = render(<RegistryApp client={mockClient({ user: owner })} />);

  await view.findByRole("heading", { name: "Admin console" });
  await view.findByText("Sign in with MFA before sending registration invitations.");
  assert.equal(view.queryByRole("form", { name: "Invite user" }), null);
});

test("maintainer sessions download an artifact hash before approving review submissions", async (t) => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "maintainer@example.com", roles: ["maintainer"] }) });
  const expectedArtifactHash = artifactPayloadSha256(defaultReviewBundlePayload());
  let downloadedBlob: Blob | null = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      downloadedBlob = blob;
      return "blob:review-artifact";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: () => undefined,
  });
  t.after(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "maintainer@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("maintainer@example.com");
  assert.equal(view.queryByRole("link", { name: /admin/i }), null);
  fireEvent.click(view.getAllByRole("link", { name: "Review" })[0]!);

  await view.findByText("Review dashboard");
  await waitFor(() => assert.equal(view.getAllByText("release-notes-helper@0.1.0").length >= 1, true));
  assert.equal(document.body.textContent?.includes("storageKey"), false);
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
  assert.equal(client.bundleCalls, 0);
  assert.equal((view.getByRole("button", { name: /approve/i }) as HTMLButtonElement).disabled, true);

  fireEvent.input(view.getByLabelText("Reason"), { target: { value: "checked" } });
  fireEvent.click(view.getByRole("button", { name: /download artifact/i }));
  await waitFor(() => assert.deepEqual(client.reviewBundleCalls, ["submission-1"]));
  assert.equal(document.body.textContent?.includes("Summarize release notes."), false);
  assert.notEqual(downloadedBlob, null);
  const downloadedText = await downloadedBlob!.text();
  assert.equal(artifactTextSha256(downloadedText), expectedArtifactHash);
  fireEvent.click(view.getByRole("button", { name: /approve/i }));
  fireEvent.click(await view.findByRole("button", { name: "Approve submission" }));
  await waitFor(() => assert.deepEqual(client.reviewActions, [`submission-1:approve:checked:${expectedArtifactHash}`]));

  fireEvent.click(view.getByRole("button", { name: /publish/i }));
  fireEvent.input(view.getAllByRole("textbox").at(-1)!, { target: { value: "release ready" } });
  fireEvent.click(view.getByRole("button", { name: "Publish release" }));
  await waitFor(() => assert.deepEqual(client.reviewActions, [`submission-1:approve:checked:${expectedArtifactHash}`, "submission-1:publish:release ready:"]));
  await view.findByText("Review queue is clear.");
});

test("review confirmations require a meaningful reason and recover from API errors", async () => {
  setupAuthenticatedDom("http://localhost/review", authUser({ email: "maintainer@example.com", roles: ["maintainer"] }));
  const client = mockClient({ user: authUser({ email: "maintainer@example.com", roles: ["maintainer"] }) });
  client.performReviewAction = async () => new Promise((_, reject) => {
    setTimeout(() => reject(safeApiError(409, "REVIEW_FAILED", "database secret")), 50);
  });

  const view = render(<RegistryApp client={client} />);
  await view.findByText("Review dashboard");
  const rejectTrigger = await view.findByRole("button", { name: "Reject" });
  rejectTrigger.focus();
  fireEvent.click(rejectTrigger);

  const confirm = view.getByRole("button", { name: "Reject submission" }) as HTMLButtonElement;
  await waitFor(() => assert.equal(document.activeElement, view.getByRole("heading", { name: "Reject this submission?" })));
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  assert.equal(document.activeElement, view.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(window, { key: "Tab" });
  assert.equal(document.activeElement, view.getByLabelText("Reason (required)"));
  assert.equal(confirm.disabled, true);
  fireEvent.input(view.getByLabelText("Reason (required)"), { target: { value: "no" } });
  assert.equal(confirm.disabled, true);
  fireEvent.input(view.getByLabelText("Reason (required)"), { target: { value: "unsafe package" } });
  assert.equal(confirm.disabled, false);
  fireEvent.click(confirm);
  await view.findByRole("button", { name: "Working…" });

  assert.equal((await view.findByRole("alert")).textContent, "Review action could not be completed.");
  assert.equal((view.getByRole("button", { name: "Reject submission" }) as HTMLButtonElement).disabled, false);
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  assert.equal(document.activeElement, view.getByRole("button", { name: "Reject" }));
});

test("author sessions can submit a package archive without rendering package content", async () => {
  setupDom();
  const client = mockClient({ user: authUser({ email: "author@example.com", roles: ["author"] }), userSubmissions: [] });

  const view = render(<RegistryApp client={client} />);
  fireEvent.input(view.getByLabelText("Email"), { target: { value: "author@example.com" } });
  fireEvent.input(view.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
  fireEvent.click(view.getByRole("button", { name: /sign in/i }));

  await view.findByText("author@example.com");
  fireEvent.click(view.getAllByRole("link", { name: "Submit" })[0]!);

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
  fireEvent.click(view.getAllByRole("link", { name: "Submit" })[0]!);
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

test("legacy token-bearing stored sessions are purged before signed-in render", async () => {
  setupDom();
  window.localStorage.setItem("myskills-app:web-session", JSON.stringify({
    token: "stored-session-token",
    expiresAt: "2026-06-04T01:00:00.000Z",
    user: authUser(),
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

function setupDom(url = "http://localhost/login") {
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", url);
}

function setupAuthenticatedDom(url = "http://localhost/registry", user = authUser()) {
  setupDom(url);
  window.localStorage.setItem("myskills-app:web-session", JSON.stringify({
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
  registrationError?: SafeApiError;
  mfaRequired?: boolean;
  mfaStatus?: MfaStatus;
  searchResults?: (query: string) => PublicSkill[];
  sharingDetails?: SkillSharingDetails;
  submitError?: SafeApiError;
  submitResult?: SubmitSkillResult;
  architecturePatterns?: ArchitecturePattern[];
  architectures?: ArchitectureSummary[];
  architecturePreview?: ArchitecturePreview;
  architectureFixturePreview?: Promise<ArchitecturePreview>;
  architectureError?: SafeApiError;
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
  let architectureSummaries = input.architectures ?? [defaultArchitectureSummary()];
  const client: RegistryClient & {
    adminTokenRevokes: string[];
    apiTokenCreates: Array<{ name: string; scopes: ApiTokenScope[] }>;
    apiTokenRevokes: string[];
    architectureCreates: Array<{ name: string; patternId: string; scope?: string; profileId?: string; environmentId?: string }>;
    architecturePreviewCalls: Array<{ architectureId: string; profileId?: string; environmentId?: string; revisionId?: string; fixture?: ArchitectureObservedFixture }>;
    architectureRevisionCreates: Array<{ architectureId: string; spec: unknown; message?: string }>;
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
    registrationCalls: Array<{ email: string; password: string; name?: string; inviteToken: string }>;
    registrationInvitations: Array<{ email: string; name?: string }>;
    registrationUpdates: AdminRegistrationMode[];
    releaseCalls: string[];
    releaseManagementCalls: number;
    reviewActions: string[];
    reviewBundleCalls: string[];
    roleUpdates: string[];
    searchCalls: string[];
    submitCalls: Array<{ filename: string; contentBase64: string }>;
    submissionExports: string[];
    userActions: string[];
    teamCreates: string[];
    teamInvites: string[];
    teamInvitationAccepts: string[];
    sharingUpdates: Array<{ slug: string; visibility: string; teamIds: string[]; userEmails: string[] }>;
    sharingDetailCalls: number;
  } = {
    adminTokenRevokes: [],
    apiTokenCreates: [],
    apiTokenRevokes: [],
    architectureCreates: [],
    architecturePreviewCalls: [],
    architectureRevisionCreates: [],
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
    registrationCalls: [],
    registrationInvitations: [],
    registrationUpdates: [],
    releaseCalls: [],
    releaseManagementCalls: 0,
    reviewActions: [],
    reviewBundleCalls: [],
    roleUpdates: [],
    searchCalls: [],
    submitCalls: [],
    submissionExports: [],
    userActions: [],
    teamCreates: [],
    teamInvites: [],
    teamInvitationAccepts: [],
    sharingUpdates: [],
    sharingDetailCalls: 0,
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
          expiresAt: "2026-06-04T01:00:00.000Z",
          user: currentUser,
        };
    },
    async registerWithInvitation(registrationInput) {
      client.registrationCalls.push(registrationInput);
      if (input.registrationError) {
        throw input.registrationError;
      }
      return { status: "active" };
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
    async createRegistrationInvitation(invitationInput) {
      client.registrationInvitations.push(invitationInput);
      return {
        email: invitationInput.email.toLowerCase(),
        expiresAt: "2026-06-21T00:00:00.000Z",
      };
    },
    async getAdminSharing() {
      throw new Error("Admin sharing is not used by this web mock.");
    },
    async updateAdminSharing() {
      throw new Error("Admin sharing is not used by this web mock.");
    },
    async listAdminUsers() {
      return adminUsers;
    },
    async performAdminUserAction(userId, action, reason) {
      client.userActions.push(`${userId}:${action}:${reason ?? ""}`);
      adminUsers = adminUsers.map((user) => user.id === userId ? {
        ...user,
        status: action === "disable" ? "disabled" : action === "delete" ? "deleted" : "active",
      } : user);
      return adminUsers.find((user) => user.id === userId) ?? defaultAdminUsers()[0];
    },
    async updateAdminUserRoles(userId, roles, reason) {
      client.roleUpdates.push(`${userId}:${roles.join(",")}:${reason}`);
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
    async performSubmissionAction() {
      throw new Error("Submission lifecycle is not used by this web mock.");
    },
    async listReviewSubmissions() {
      return reviewSubmissions;
    },
    async getReviewSubmissionBundle(submissionId) {
      client.reviewBundleCalls.push(submissionId);
      const payload = defaultReviewBundlePayload();
      return {
        artifactSha256: artifactPayloadSha256(payload),
        payload,
      };
    },
    async performReviewAction({ submissionId, action, reason, artifactSha256 }) {
      client.reviewActions.push(`${submissionId}:${action}:${reason ?? ""}:${artifactSha256 ?? ""}`);
      if (action === "approve") {
        reviewSubmissions = reviewSubmissions.map((submission) => (
          submission.id === submissionId ? { ...submission, approvedArtifactSha256: artifactSha256 ?? null, allowedActions: ["publish"], reviewStatus: "approved" } : submission
        ));
        return {
          id: submissionId,
          slug: "release-notes-helper",
          version: "0.1.0",
          visibility: "public",
          lifecycleStatus: "review",
          reviewStatus: "approved",
          securityStatus: "passed",
          approvedArtifactSha256: artifactSha256 ?? null,
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
        approvedArtifactSha256: null,
        publishedAt: "2026-06-04T00:00:00.000Z",
      };
    },
    async listSkillReleases() {
      client.releaseManagementCalls += 1;
      return [];
    },
    async updateSkillMetadata() {
      throw new Error("Skill metadata is not used by this web mock.");
    },
    async performSkillAction() {
      throw new Error("Skill lifecycle is not used by this web mock.");
    },
    async performReleaseAction() {
      throw new Error("Release lifecycle is not used by this web mock.");
    },
    async listArchitecturePatterns() {
      if (input.architectureError) {
        throw input.architectureError;
      }
      return input.architecturePatterns ?? defaultArchitecturePatterns();
    },
    async listArchitectures() {
      if (input.architectureError) {
        throw input.architectureError;
      }
      return architectureSummaries;
    },
    async getArchitecture(architectureId) {
      if (input.architectureError) {
        throw input.architectureError;
      }
      const summary = architectureSummaries.find((item) => item.id === architectureId) ?? defaultArchitectureSummary({ id: architectureId });
      const latestRevision = summary.latestRevision
        ? {
          ...summary.latestRevision,
          message: summary.latestRevision.message ?? "Current revision",
          spec: summary.latestRevision.spec ?? defaultArchitectureSummary({ id: architectureId }).latestRevision!.spec!,
          createdByUserId: summary.latestRevision.createdByUserId ?? "user-1",
        }
        : null;
      return { ...summary, latestRevision, revisions: latestRevision ? [latestRevision] : [] };
    },
    async createArchitecture(createInput) {
      if (input.architectureError) {
        throw input.architectureError;
      }
      client.architectureCreates.push(createInput);
      const created = defaultArchitectureSummary({ name: createInput.name, patternId: createInput.patternId, latestRevision: null, currentRevisionId: null, revisionCount: 0, status: "draft" });
      architectureSummaries = [created, ...architectureSummaries];
      return { ...created, latestRevision: null, revisions: [] };
    },
    async createArchitectureRevision(architectureId, revisionInput) {
      if (input.architectureError) {
        throw input.architectureError;
      }
      client.architectureRevisionCreates.push({ architectureId, ...revisionInput });
      const previous = architectureSummaries.find((item) => item.id === architectureId);
      const revisionNumber = (previous?.revisionCount ?? 0) + 1;
      const revision = {
        id: `revision-${revisionNumber}`,
        architectureId,
        revision: revisionNumber,
        revisionNumber,
        patternId: previous?.patternId ?? "multi-level-router",
        createdAt: "2026-06-14T00:00:00.000Z",
        status: "published" as const,
        spec: revisionInput.spec as NonNullable<ArchitectureRevisionSummary["spec"]>,
        message: revisionInput.message ?? "",
        createdByUserId: "user-1",
      };
      architectureSummaries = architectureSummaries.map((item) => item.id === architectureId ? {
        ...item,
        latestRevision: revision,
        currentRevisionId: revision.id,
        revisionCount: revisionNumber,
        status: "active" as const,
      } : item);
      return revision;
    },
    async previewArchitecture(architectureId, previewInput) {
      if (input.architectureError) {
        throw input.architectureError;
      }
      client.architecturePreviewCalls.push({ architectureId, ...previewInput });
      if (previewInput.fixture && input.architectureFixturePreview) {
        return input.architectureFixturePreview;
      }
      if (previewInput.fixture) {
        return defaultArchitecturePreview({
          plan: {
            dryRun: true,
            canApply: false,
            requiresApproval: true,
            targetId: previewInput.fixture.targetId,
            environmentId: previewInput.environmentId ?? "codex-personal",
            architectureId,
            revisionDigest: "a".repeat(64),
            items: [{
              action: "noop",
              nodeId: "root",
              kind: "router",
              reason: "Target already matches the desired router state.",
            }],
          },
        });
      }
      return input.architecturePreview ?? defaultArchitecturePreview();
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
      client.sharingDetailCalls += 1;
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

function defaultArchitecturePatterns(): ArchitecturePattern[] {
  return [
    { id: "flat", name: "Flat library", description: "A predictable entry point.", supportsNestedRouters: false, status: "available" },
    { id: "domain-router", name: "Domain router", description: "Route through one domain branch.", supportsNestedRouters: false, status: "available" },
    { id: "multi-level-router", name: "Multi-level router", description: "Compose nested routers and leaf skills.", supportsNestedRouters: true, status: "available" },
  ];
}

function defaultArchitectureSummary(input: Partial<ArchitectureSummary> = {}): ArchitectureSummary {
  const hasLatestRevision = Object.prototype.hasOwnProperty.call(input, "latestRevision");
  const architectureId = input.id ?? "architecture-1";
  const patternId = input.patternId ?? "multi-level-router";
  return {
    id: architectureId,
    name: input.name ?? "Review assistant",
    description: input.description ?? "Routes review work to the right leaf skills.",
    patternId,
    scope: input.scope ?? "personal",
    latestRevision: hasLatestRevision ? input.latestRevision : {
      id: "revision-1",
      architectureId,
      revision: 3,
      revisionNumber: 3,
      patternId,
      createdAt: "2026-06-14T00:00:00.000Z",
      nodeCount: 4,
      skillCount: 2,
      status: "published",
      spec: {
        schemaVersion: 1,
        id: architectureId,
        name: input.name ?? "Review assistant",
        pattern: { id: patternId as "flat" | "domain-router" | "multi-level-router", version: 1 },
        skills: [],
        nodes: [],
        edges: [],
        entryNodeIds: [],
        profiles: [
          { id: "personal", name: "Personal", subject: { type: "user", id: "user-1" }, defaultExposure: "disabled", bindings: [] },
          { id: "work", name: "Work", subject: { type: "user", id: "user-1" }, defaultExposure: "disabled", bindings: [] },
        ],
        environments: [
          { id: "codex-personal", name: "Codex personal", kind: "personal", profileId: "personal" },
          { id: "codex-work", name: "Codex work", kind: "work", profileId: "work" },
        ],
      },
    },
    currentRevisionId: input.currentRevisionId ?? (hasLatestRevision && !input.latestRevision ? null : "revision-1"),
    revisionCount: input.revisionCount ?? (hasLatestRevision && !input.latestRevision ? 0 : 1),
    updatedAt: input.updatedAt ?? "2026-06-14T00:00:00.000Z",
    status: input.status ?? "active",
  };
}

function defaultArchitecturePreview(input: Partial<ArchitecturePreview> = {}): ArchitecturePreview {
  const revision: ArchitecturePreview["revision"] = input.revision ?? {
    id: "revision-1",
    architectureId: "architecture-1",
    revisionNumber: 3,
    message: "Initial review architecture",
    createdByUserId: "user-1",
    createdAt: "2026-06-14T00:00:00.000Z",
    spec: {
      schemaVersion: 1,
      id: "architecture-1",
      name: "Review assistant",
      pattern: { id: "multi-level-router", version: 1 },
      skills: [
        { id: "release-skill", slug: "release-notes-helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" },
        { id: "risk-skill", slug: "risk-reviewer", version: "0.1.0", digest: "b".repeat(64), packageVisibility: "private" },
      ],
      nodes: [
        { id: "root", kind: "router", label: "Review router" },
        { id: "quality", kind: "router", label: "Quality branch" },
        { id: "release", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-skill" },
        { id: "risk", kind: "leaf", label: "Risk Reviewer", skillRefId: "risk-skill" },
      ],
      edges: [
        { from: "root", to: "quality", kind: "contains" },
        { from: "quality", to: "release", kind: "routes" },
        { from: "quality", to: "risk", kind: "routes" },
      ],
      entryNodeIds: ["root"],
      profiles: [
        {
          id: "personal",
          name: "Personal",
          subject: { type: "user", id: "user-1" },
          defaultExposure: "disabled",
          bindings: [
            { nodeId: "root", enabled: true, runtimeExposure: "router" },
            { nodeId: "quality", enabled: true, runtimeExposure: "router" },
            { nodeId: "release", enabled: true, runtimeExposure: "leaf" },
          ],
        },
        {
          id: "work",
          name: "Work",
          subject: { type: "user", id: "user-1" },
          defaultExposure: "disabled",
          bindings: [
            { nodeId: "root", enabled: true, runtimeExposure: "router" },
            { nodeId: "quality", enabled: true, runtimeExposure: "router" },
            { nodeId: "risk", enabled: true, runtimeExposure: "leaf" },
          ],
        },
      ],
      environments: [
        { id: "codex-personal", name: "Codex personal", kind: "personal", profileId: "personal" },
        { id: "codex-work", name: "Codex work", kind: "work", profileId: "work" },
      ],
    },
  };
  const compiled: ArchitecturePreview["compiled"] = input.compiled ?? {
    schemaVersion: 1,
    architectureId: "architecture-1",
    revisionDigest: "a".repeat(64),
    pattern: { id: "multi-level-router", version: 1 },
    profileId: "personal",
    environmentId: "codex-personal",
    nodes: [
      { id: "root", kind: "router", label: "Review router", runtimeExposure: "router", childNodeIds: ["quality"] },
      { id: "quality", kind: "router", label: "Quality branch", runtimeExposure: "router", childNodeIds: ["release"] },
      { id: "release", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-skill", runtimeExposure: "leaf", childNodeIds: [] },
    ],
    allNodes: [
      { id: "root", kind: "router", label: "Review router" },
      { id: "quality", kind: "router", label: "Quality branch" },
      { id: "release", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-skill" },
      { id: "risk", kind: "leaf", label: "Risk Reviewer", skillRefId: "risk-skill" },
    ],
    disabledNodeIds: ["risk"],
    edges: [
      { from: "root", to: "quality", kind: "contains" },
      { from: "quality", to: "release", kind: "routes" },
    ],
    skills: [{ skillRefId: "release-skill", slug: "release-notes-helper", title: "Release Notes Helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" }],
    routers: [
      { nodeId: "root", childNodeIds: ["quality"], routes: [{ from: "root", to: "quality", kind: "contains" }], digest: "a".repeat(64) },
      { nodeId: "quality", childNodeIds: ["release"], routes: [{ from: "quality", to: "release", kind: "routes" }], digest: "a".repeat(64) },
    ],
  };
  const graph: ArchitecturePreview["graph"] = input.graph ?? {
    digest: compiled.revisionDigest,
    nodes: [
      { id: "root", kind: "router", label: "Review router", depth: 0, x: 40, y: 22 },
      { id: "quality", kind: "router", label: "Quality branch", depth: 1, x: 286, y: 124 },
      { id: "release", kind: "leaf", label: "Release Notes Helper", depth: 2, x: 532, y: 226, skillRefId: "release-skill" },
    ],
    edges: compiled.edges,
    mermaid: "flowchart TD\n  root[Review router] --> quality[Quality branch]\n  quality --> release[Release Notes Helper]",
  };
  const outline: ArchitecturePreview["outline"] = input.outline ?? {
    title: "Architecture architecture-1",
    text: "Architecture architecture-1\n- Review router (router)\n  - Quality branch (router)\n    - Release Notes Helper (leaf)",
    tree: [{
      id: "root",
      label: "Review router",
      kind: "router",
      children: [{
        id: "quality",
        label: "Quality branch",
        kind: "router",
        children: [{ id: "release", label: "Release Notes Helper", kind: "leaf", children: [] }],
      }],
    }],
  };
  return {
    revision,
    compiled,
    graph,
    outline,
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
  };
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
    lifecycleStatus: input.lifecycleStatus ?? "approved",
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
    allowedActions: input.allowedActions ?? ["export"],
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

function defaultReviewBundlePayload() {
  return {
    files: [
      { path: "skill.json", content: "{\"name\":\"release-notes-helper\"}" },
      { path: "README.md", content: "Summarize release notes." },
    ],
  };
}

function artifactPayloadSha256(payload: unknown): string {
  return artifactTextSha256(JSON.stringify(payload));
}

function artifactTextSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
      lifecycleStatus: "review",
      reviewStatus: "unreviewed",
      securityStatus: "passed",
      approvedArtifactSha256: null,
      platforms: [
        { name: "codex", installTarget: "codex-skill", status: "supported" },
        { name: "generic", installTarget: "prompt-pack", status: "supported" },
      ],
      findingCount: 0,
      createdAt: "2026-06-04T00:00:00.000Z",
      allowedActions: ["approve", "request-changes", "reject"],
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
    lifecycleStatus: "approved",
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
