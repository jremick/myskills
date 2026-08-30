import { expect, test, type Page, type TestInfo } from "@playwright/test";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();
test.use({ launchOptions: browserExecutable ? { executablePath: browserExecutable } : {} });

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
    response.url().endsWith("/api/v1/skills") && response.request().method() === "GET"
  ));

  await page.goto("/registry");
  await expect(page).toHaveTitle(/MySkills/);
  await expect(page.getByRole("heading", { name: "Skill registry" })).toBeVisible();
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
        checks: { postgres: string; artifactStorage: string };
      },
      status: response.status,
    };
  });
  expect(readiness).toEqual({
    body: {
      ok: true,
      service: "myskills-app-api",
      checks: { postgres: "ready", artifactStorage: "ready" },
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

test("owner invites a user through captured email and the invitee registers and logs in", async ({ page }, testInfo) => {
  const inviteeEmail = `beta2-invitee-${testInfo.retry}@example.test`;
  await signInOwner(page, recoveryCode(2, testInfo));

  await page.locator(".side-nav").getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { name: "Admin console" })).toBeVisible();
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
});

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
