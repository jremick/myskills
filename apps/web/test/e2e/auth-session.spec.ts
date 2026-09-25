import { expect, test } from "@playwright/test";

const expiresAt = "2027-06-04T01:00:00.000Z";
const user = {
  id: "user-reader",
  email: "reader@example.com",
  name: "Reader User",
  status: "active",
  roles: ["user"],
  emailVerified: true,
  mfaVerified: false,
};

test("browser login uses the HttpOnly session cookie without storing bearer tokens", async ({ page }) => {
  let sawCookieSessionMode = false;
  let sawMeCookie = false;

  await page.route("**/api/v1/auth/login", async (route) => {
    sawCookieSessionMode = route.request().headers()["x-myskills-session-response"] === "cookie";
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": `myskills_session=e2e-session-token; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`,
      },
      body: JSON.stringify({
        mfaRequired: false,
        expiresAt,
        user,
      }),
    });
  });

  await page.route("**/api/v1/me", async (route) => {
    sawMeCookie = sawMeCookie || (route.request().headers().cookie ?? "").includes("myskills_session=e2e-session-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user }),
    });
  });

  await page.route("**/api/v1/skills", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skills: [publicSkill()] }),
    });
  });
  await page.route("**/api/v1/skills/release-notes-helper", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ skill: publicSkill() }),
    });
  });
  await page.route("**/api/v1/skills/release-notes-helper/releases", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ releases: [{ ...publicRelease(), id: "public-release-0.1.0", findingCount: 0, allowedActions: [] }] }),
    });
  });
  await page.route("**/api/v1/skills/release-notes-helper/releases/0.1.0", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ release: publicRelease() }),
    });
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill("reader@example.com");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByText("Release Notes Helper").first()).toBeVisible();
  await expect.poll(() => sawCookieSessionMode).toBe(true);
  await expect.poll(() => sawMeCookie).toBe(true);

  const stored = await page.evaluate(() => window.localStorage.getItem("myskills-app:web-session"));
  expect(stored).not.toBeNull();
  expect(stored).not.toContain("e2e-session-token");
  expect(JSON.parse(stored ?? "{}")).toEqual({
    expiresAt,
    user,
  });

  await page.getByLabel("Sign out").click();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("myskills-app:web-session"))).toBeNull();
});

function publicSkill() {
  return {
    slug: "release-notes-helper",
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

function publicRelease() {
  return {
    ...publicSkill(),
    version: "0.1.0",
    publishedAt: "2026-06-04T00:00:00.000Z",
    artifact: {
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      byteSize: 1234,
      contentType: "application/vnd.myskills-app.package+json",
    },
  };
}
