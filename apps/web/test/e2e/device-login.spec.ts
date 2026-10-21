import { expect, test } from "./browser-test.js";

test("device consent keeps Approve off until approval is open and still permits denial", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-01-01T00:00:00Z", user: { id: "device-user", email: "device@example.com", name: "Device User", status: "active", roles: ["user"], emailVerified: true, mfaVerified: true } })));
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me")) return route.fulfill({ json: { user: { id: "device-user", email: "device@example.com", name: "Device User", status: "active", roles: ["user"], mfaVerified: true, emailVerified: true } } });
    if (path.endsWith("/auth/device/inspect")) return route.fulfill({ json: { scopes: ["profile:read", "skills:submit"], expiresAt: "2027-01-01T00:00:00Z", account: { email: "ada@example.com" }, approval: "verify" } });
    if (path.endsWith("/auth/device/decision")) {
      const input = route.request().postDataJSON();
      expect(input.userCode).toBe("ABCDE-FGHJK");
      expect(input.decision).toBe("deny");
      return route.fulfill({ json: { status: "denied" } });
    }
    if (path.endsWith("/branding")) return route.fulfill({ json: { branding: { text: "MySkills", showText: true, logoDataUrl: null } } });
    return route.fulfill({ json: { settings: { landingPageEnabled: true } } });
  });
  await page.goto("/auth/device");
  await page.getByLabel("Device code").fill("ABCDE-FGHJK");
  await page.getByRole("button", { name: "Review permissions" }).click();
  await expect(page.getByText("Submit skills")).toBeVisible();
  await expect(page.getByText("Profile")).toBeVisible();
  await expect(page.getByText("skills:submit", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ada@example.com")).toBeVisible();
  await expect(page.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
  await expect(page.getByRole("button", { name: "Approve CLI access" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByRole("status")).toContainText("denied");
  expect(page.url()).not.toContain("ABCDE");
  await test.info().attach("device-consent-denial", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
