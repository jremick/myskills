import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { captureMfaEvidence, decodeEnrollmentQr, enrollmentCode, observeEnrollmentPrivacy } from "./mfa-test-support.js";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();
// This file handles credentials and one-time enrollment data. Artifact options
// are worker-scoped, so disable automatic recording for the whole file.
test.use({ launchOptions: browserExecutable ? { executablePath: browserExecutable } : {}, trace: "off", video: "off", screenshot: "off" });

const ownerEmail = requiredEnvironment("MYSKILLS_E2E_OWNER_EMAIL");
const ownerPassword = requiredEnvironment("MYSKILLS_E2E_OWNER_PASSWORD");
const ownerRecoveryCodes = requiredStringArrayEnvironment("MYSKILLS_E2E_OWNER_RECOVERY_CODES");
const inviteePassword = requiredEnvironment("MYSKILLS_E2E_INVITEE_PASSWORD");
const mailpitUrl = requiredEnvironment("MYSKILLS_E2E_MAILPIT_URL");

test("anonymous visitor browses the seeded registry through the production proxy", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  const skillsResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/v1/registry/catalog" && response.request().method() === "GET"
  ));

  await page.goto("/registry");
  await expect(page).toHaveTitle(/MySkills/);
  await expect(page.getByRole("heading", { name: "Skills", exact: true, level: 1 })).toBeVisible();
  const skillResult = page.getByRole("link", { name: /Release Notes Helper/ }).first();
  await expect(skillResult).toBeVisible();

  const response = await skillsResponse;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).port).toBe(new URL(page.url()).port);

  await skillResult.click();
  await expect(page.getByRole("heading", { name: "Release Notes Helper" })).toBeVisible();
  await expect(page.getByText("0.1.0", { exact: true }).first()).toBeVisible();

  const readiness = await page.evaluate(async () => {
    const response = await fetch("/api/ready");
    return {
      body: await response.json() as {
        ok: boolean;
        checks: { postgres: string; artifactStorage: string; phase2Architecture: string; architectureObservationPrivacy: string };
      },
      status: response.status,
    };
  });
  expect(readiness).toEqual({
    body: {
      ok: true,
      service: "myskills-app-api",
      checks: { postgres: "ready", artifactStorage: "ready", phase2Architecture: "ready", architectureObservationPrivacy: "ready" },
    },
    status: 200,
  });
  expect(browserErrors).toEqual([]);
});

test("owner uses a real HttpOnly cookie session and exports a real seeded bundle", async ({ context, page }, testInfo) => {
  await signInOwner(page, recoveryCode(0, testInfo));

  await expect(page).toHaveURL(/\/(?:registry|skills\/release-notes-helper)$/);
  await expect(page.getByRole("link", { name: "Account settings" })).toHaveAttribute("title", ownerEmail);

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "myskills_session");
  expect(sessionCookie).toMatchObject({
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
  });

  const storedSession = await page.evaluate(() => window.localStorage.getItem("myskills-app:web-session"));
  expect(storedSession).not.toBeNull();
  expect(storedSession).not.toContain(sessionCookie?.value ?? "__missing_cookie__");
  expect(JSON.parse(storedSession ?? "{}").user.email).toBe(ownerEmail);

  const authenticatedExport = await page.evaluate(async () => {
    const meResponse = await fetch("/api/v1/me");
    const me = await meResponse.json() as { user?: { email?: string } };
    const bundleResponse = await fetch("/api/v1/skills/release-notes-helper/releases/0.1.0/bundle?platform=codex");
    const bundle = await bundleResponse.json() as { files?: Array<{ path: string; content: string }> };
    return {
      bundle,
      bundleContentType: bundleResponse.headers.get("content-type"),
      bundleStatus: bundleResponse.status,
      me,
      meStatus: meResponse.status,
    };
  });

  expect(authenticatedExport.meStatus).toBe(200);
  expect(authenticatedExport.me.user?.email).toBe(ownerEmail);
  expect(authenticatedExport.bundleStatus).toBe(200);
  expect(authenticatedExport.bundleContentType).toContain("application/vnd.myskills-app.package+json");
  expect(authenticatedExport.bundle.files?.map((file) => file.path)).toEqual(expect.arrayContaining(["README.md", "skill.json"]));
  const manifest = authenticatedExport.bundle.files?.find((file) => file.path === "skill.json");
  expect(JSON.parse(manifest?.content ?? "{}")).toMatchObject({
    name: "release-notes-helper",
    version: "0.1.0",
  });

  await page.getByLabel("Sign out").click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect.poll(async () => (await context.cookies()).some((cookie) => cookie.name === "myskills_session")).toBe(false);
});

test("owner creates and reads a real architecture revision from a seeded release", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await useOwnerSession(page);
  await page.locator(".side-nav").getByRole("link", { name: "Architectures" }).click();
  await expect(page.getByRole("heading", { name: "Skill architectures" })).toBeVisible();

  const architectureName = `Full-stack architecture ${testInfo.retry}`;
  const createCard = page.getByRole("region", { name: "New architecture", exact: true });
  if (!await createCard.isVisible()) await page.getByRole("button", { name: "New architecture", exact: true }).click();
  await createCard.getByLabel("Architecture name").fill(architectureName);
  await createCard.getByLabel("Architecture pattern").selectOption("flat");

  const createResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith("/api/v1/architectures") && response.request().method() === "POST"
  ));
  await createCard.getByRole("button", { name: "Create architecture", exact: true }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const createBody = await createResponse.json() as { architecture?: { id?: string; name?: string } };
  const architectureId = createBody.architecture?.id;
  expect(architectureId).toBeTruthy();
  expect(createBody.architecture?.name).toBe(architectureName);

  await expect(page.getByRole("heading", { name: architectureName, exact: true })).toBeVisible();
  const editor = page.getByTestId("architecture-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build the first revision" })).toBeVisible();

  await editor.getByLabel("Search skills").fill("release-notes-helper");
  await editor.getByRole("button", { name: "Search", exact: true }).click();
  await expect(editor.getByLabel("Skill", { exact: true })).toBeVisible();
  await editor.getByLabel("Skill", { exact: true }).selectOption("release-notes-helper");
  const releaseSelect = editor.getByLabel("Exact release", { exact: true });
  await expect(releaseSelect).toBeVisible();
  await expect(releaseSelect.locator("option").nth(1)).toBeAttached();
  await releaseSelect.selectOption({ index: 1 });
  await editor.getByRole("button", { name: "Add selected exact release", exact: true }).click();
  await expect(editor.getByText(/added as an exact release draft/)).toBeVisible();

  const saveResponsePromise = page.waitForResponse((response) => (
    response.url().includes(`/api/v1/architectures/${architectureId}/revisions`)
      && response.request().method() === "POST"
  ));
  await expect(editor.getByRole("button", { name: "Save revision", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Save revision", exact: true }).click();
  const saveResponse = await saveResponsePromise;
  expect(saveResponse.status()).toBe(201);
  const saveBody = await saveResponse.json() as { revision?: { id?: string; revisionNumber?: number } };
  const revisionId = saveBody.revision?.id;
  expect(revisionId).toBeTruthy();
  expect(saveBody.revision?.revisionNumber).toBe(1);

  await page.locator("summary").filter({ hasText: /^Revision history/ }).click();
  await expect(page.getByRole("region", { name: "Revision history" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Current · Revision 1/ })).toBeVisible();
  await expect(page.getByText("Current revision selected")).toBeVisible();

  const readback = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/architectures/${encodeURIComponent(id)}`);
    const body = await response.json() as {
      architecture?: { id?: string; name?: string; currentRevisionId?: string | null };
      latestRevision?: { id?: string; revisionNumber?: number; spec?: { skills?: Array<{ slug?: string; version?: string; digest?: string }> } } | null;
    };
    return {
      status: response.status,
      architecture: {
        id: body.architecture?.id,
        name: body.architecture?.name,
        currentRevisionId: body.architecture?.currentRevisionId ?? null,
      },
      latestRevision: {
        id: body.latestRevision?.id,
        revisionNumber: body.latestRevision?.revisionNumber,
        skills: body.latestRevision?.spec?.skills?.map((skill) => ({
          slug: skill.slug,
          version: skill.version,
          digestLength: skill.digest?.length ?? 0,
        })) ?? [],
      },
    };
  }, architectureId!);
  expect(readback).toEqual({
    status: 200,
    architecture: {
      id: architectureId,
      name: architectureName,
      currentRevisionId: revisionId,
    },
    latestRevision: {
      id: revisionId,
      revisionNumber: 1,
      skills: [{ slug: "release-notes-helper", version: "0.1.0", digestLength: 64 }],
    },
  });
  expect(browserErrors).toEqual([]);
});

test("owner invites a user who registers, logs in and enrolls MFA from the rendered QR", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const inviteeEmail = `beta2-invitee-${testInfo.retry}@example.test`;
  await signInOwner(page, recoveryCode(2, testInfo));

  await page.locator(".side-nav").getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin console" })).toBeVisible();
  await page.getByRole("button", { name: "Invite user", exact: true }).click();
  const inviteForm = page.getByRole("form", { name: "Invite user" });
  await inviteForm.getByLabel("Email").fill(inviteeEmail);
  await inviteForm.getByLabel(/Name/).fill("Beta 2 Invitee");
  await inviteForm.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${inviteeEmail}.`, { exact: false })).toBeVisible();

  const emailText = await waitForCapturedInvitation(inviteeEmail);
  const link = emailText.match(/https:\/\/e2e\.example\.test\/auth\/register#token=[^\s]+/)?.[0];
  expect(link).toBeTruthy();
  const invitationUrl = new URL(link!);

  await page.getByLabel("Sign out").click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.goto(`${invitationUrl.pathname}${invitationUrl.hash}`);
  await expect(page.getByRole("heading", { name: "Complete registration" })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/register$/);

  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel(/Name/).fill("Beta 2 Invitee");
  await page.getByLabel("Password", { exact: true }).fill(inviteePassword);
  await page.getByLabel("Confirm password").fill(inviteePassword);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Registration complete. You can now log in.")).toBeVisible();

  await page.getByRole("link", { name: "Continue to login" }).click();
  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel("Password").fill(inviteePassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("link", { name: "Account settings" })).toHaveAttribute("title", inviteeEmail);

  const assertPrivacy = observeEnrollmentPrivacy(page);
  await page.getByRole("link", { name: "Account settings" }).click();
  const panel = page.getByRole("region", { name: "MFA setup", exact: true });
  const qr = panel.getByRole("img", { name: "Authenticator setup QR code", exact: true });
  await expect(panel.getByLabel("Current password", { exact: true })).toBeVisible();
  await expect(qr).toHaveCount(0);
  await panel.getByLabel("Current password", { exact: true }).fill("incorrect-fixture-password");
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(panel.getByRole("status")).toBeVisible();
  await expect(qr).toHaveCount(0);

  const enrollmentResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/auth/mfa/totp/enroll" && response.status() === 201);
  await panel.getByLabel("Current password", { exact: true }).fill(inviteePassword);
  await panel.getByRole("button", { name: "Continue", exact: true }).click();
  const { enrollment } = await (await enrollmentResponse).json() as { enrollment: { secret: string; otpauthUrl: string } };
  const decodedUri = await decodeEnrollmentQr(qr);
  expect(decodedUri === enrollment.otpauthUrl, "Rendered QR must match the real API enrollment URI").toBe(true);
  expect((await panel.locator(".mfa-secret").textContent())?.includes(enrollment.secret), "Manual secret remains available").toBe(true);
  expect((await panel.locator(".mfa-secret").textContent())?.includes(enrollment.otpauthUrl), "Setup URL remains available").toBe(true);
  await captureMfaEvidence(page, testInfo, "fullstack-mfa-setup");

  await panel.getByLabel("MFA setup code", { exact: true }).fill("123");
  await panel.getByRole("button", { name: "Enable MFA", exact: true }).click();
  await expect(panel.getByRole("status")).toBeVisible();
  await expect(qr).toBeVisible();
  const confirmationResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/auth/mfa/totp/confirm" && response.status() === 200);
  const code = enrollmentCode(decodedUri);
  expect(/^\d{6}$/.test(code), "Authenticator confirmation must use six digits").toBe(true);
  await panel.getByLabel("MFA setup code", { exact: true }).fill(code);
  await panel.getByRole("button", { name: "Enable MFA", exact: true }).click();
  const { mfa } = await (await confirmationResponse).json() as { mfa: { recoveryCodes: string[] } };
  await expect(page.getByText("Authenticator app MFA is enabled.", { exact: true })).toBeVisible();
  const displayedCodes = await panel.locator(".mfa-recovery code").textContent();
  expect(mfa.recoveryCodes.length).toBe(10);
  expect(mfa.recoveryCodes.every(value => displayedCodes?.includes(value)), "All recovery codes must be displayed once").toBe(true);
  await expect(qr).toHaveCount(0);
  await captureMfaEvidence(page, testInfo, "fullstack-mfa-enabled");
  await page.reload();
  await expect(page.getByText("Authenticator app MFA is enabled.", { exact: true })).toBeVisible();
  await expect(page.getByText("10 recovery codes left.", { exact: true })).toBeVisible();
  await expect(page.locator(".mfa-recovery")).toHaveCount(0);
  await expect(page.locator(".mfa-secret")).toHaveCount(0);
  const privacy = await assertPrivacy([enrollment.secret, enrollment.otpauthUrl, ...mfa.recoveryCodes]);
  await testInfo.attach("mfa-fullstack-acceptance", { body: JSON.stringify({ realApi: true, qrRoundTrip: true, sixDigitConfirmation: true, persistedEnabledState: true, recoveryCodes: mfa.recoveryCodes.length, oneTimeRecoveryDisplay: true, ...privacy, physicalAuthenticatorScans: "not performed" }), contentType: "application/json" });
});

// The architecture journey reuses the runner's verified session so its retries
// do not consume later journeys' login and MFA budgets. Logout flows need their own session.
async function useOwnerSession(page: Page) {
  const token = requiredEnvironment("MYSKILLS_ACCEPTANCE_OWNER_TOKEN");
  const baseURL = requiredEnvironment("MYSKILLS_E2E_BASE_URL");
  await page.context().addCookies([{ name: "myskills_session", value: token, url: baseURL, httpOnly: true, secure: true, sameSite: "Lax" }]);
  const response = await page.request.get(`${baseURL}/api/v1/me`);
  expect(response.status()).toBe(200);
  const { user } = await response.json();
  expect(user).toMatchObject({ email: ownerEmail, mfaVerified: true });
  await page.addInitScript((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await page.goto("/registry");
  await expect(page.getByRole("link", { name: "Account settings" })).toHaveAttribute("title", ownerEmail);
}

async function signInOwner(page: Page, codeOrRecoveryCode: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(ownerPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("MFA required.")).toBeVisible();
  await page.getByLabel("MFA code").fill(codeOrRecoveryCode);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/(?:registry|skills\/release-notes-helper)$/);
}

function recoveryCode(baseIndex: number, testInfo: TestInfo): string {
  const code = ownerRecoveryCodes[baseIndex + testInfo.retry];
  if (!code) {
    throw new Error(`No owner recovery code is available for retry ${testInfo.retry}.`);
  }
  return code;
}

async function waitForCapturedInvitation(email: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  const query = encodeURIComponent(`to:${email}`);
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitUrl}/view/latest.txt?query=${query}`);
    if (response.ok) {
      const text = await response.text();
      if (text.includes("/auth/register#token=")) {
        return text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for the captured invitation to ${email}.`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Run this spec through scripts/run-fullstack-e2e.mjs.`);
  }
  return value;
}

function requiredStringArrayEnvironment(name: string): string[] {
  const raw = requiredEnvironment(name);
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must contain a JSON string array.`);
  }
  return value;
}
