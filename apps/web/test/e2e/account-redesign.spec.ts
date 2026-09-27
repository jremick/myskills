import { expect, test } from "@playwright/test";

// Test-first acceptance for the heading that follows each authentication step.
// This fixture never authenticates or stores a real session.
for (const width of [1280, 390]) test(`login headings follow reset and MFA steps without storing a challenge at ${width}`, async ({ page }, info) => {
  const writes: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (route.request().method() === "POST") writes.push({ path, body: route.request().postDataJSON() });
    if (path === "/v1/site") return route.fulfill({ json: { site: { landingPageEnabled: true } } });
    if (path === "/v1/auth/password-reset/request") return route.fulfill({ json: { status: "pending" } });
    if (path === "/v1/auth/login") return route.fulfill({ json: { mfaRequired: true, challengeToken: "test-only-challenge", expiresAt: "2027-09-27T00:00:00Z", user: { email: "reader@example.test" } } });
    return route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED" } } });
  });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByRole("button", { name: /forgot password/i }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/reset/i);
  await expect(page.getByLabel("Reset email", { exact: true })).toHaveValue("reader@example.test");
  await page.getByRole("button", { name: "Back to login", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/login|sign in/i);
  await page.getByRole("button", { name: /forgot password/i }).click();
  await page.getByRole("button", { name: "Send reset email", exact: true }).click();
  await expect(page.getByText("If that account exists, a password reset email has been sent.")).toBeVisible();
  expect(writes).toEqual([{ path: "/v1/auth/password-reset/request", body: { email: "reader@example.test" } }]);
  await page.getByLabel("Password", { exact: true }).fill("test-only-password-never-a-credential");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("MFA code", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/verif|authenticat/i);
  expect(await page.evaluate(() => localStorage.getItem("myskills-app:web-session"))).toBeNull();
  expect(writes).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("mfa-step-heading.png"), fullPage: true });
});
