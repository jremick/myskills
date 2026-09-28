import { expect, test } from "@playwright/test";
import { captureMfaEvidence, decodeEnrollmentQr, observeEnrollmentPrivacy } from "./mfa-test-support.js";

// Assertions deliberately report booleans/counts instead of sensitive values.
test.use({ trace: "off", video: "off", screenshot: "off" });

for (const width of [1280, 390]) {
  test(`MFA QR preserves the server URI, manual setup, retry and recovery flow at ${width}`, async ({ page }, info) => {
    const secret = "JBSWY3DPEHPK3PXP";
    const uri = `otpauth://totp/MySkills%20%26%20Research%20%E2%9C%93:reader%2Bphone%40example.test?secret=${secret}&issuer=MySkills+%26+Research+%E2%9C%93&algorithm=SHA1&digits=6&period=30`;
    const codes = ["fixture-recovery-first", "fixture-recovery-second"];
    const user = { id: "qr-reader", email: "reader+phone@example.test", name: "QR reader", status: "active", roles: ["user"], emailVerified: true, mfaVerified: false };
    const factor = { id: "qr-factor", type: "totp", status: "enabled", label: "Authenticator", enabledAt: "2026-09-28T00:00:00Z", createdAt: "2026-09-28T00:00:00Z" };
    let enabled = false;
    let enrollmentRequests = 0;
    let confirmationRequests = 0;
    const unexpected: string[] = [];
    const assertPrivacy = observeEnrollmentPrivacy(page);
    await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2099-01-01T00:00:00Z" })), user);
    await page.route("**/api/v1/**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/api/, "");
      if (path === "/v1/me") return route.fulfill({ json: { user } });
      if (path === "/v1/site") return route.fulfill({ json: { site: { landingPageEnabled: true } } });
      if (path === "/v1/auth/api-tokens") return route.fulfill({ json: { tokens: [] } });
      if (path === "/v1/auth/mfa") return route.fulfill({ json: { mfa: { totpEnabled: enabled, recoveryCodesRemaining: enabled ? codes.length : 0, factors: enabled ? [factor] : [] } } });
      if (path === "/v1/auth/mfa/totp/enroll") {
        enrollmentRequests += 1;
        if (request.postDataJSON().password !== "fixture-current-password") return route.fulfill({ status: 401, json: { error: { code: "INVALID_PASSWORD", message: "Current password is incorrect." } } });
        return route.fulfill({ status: 201, json: { enrollment: { factorId: factor.id, label: factor.label, secret, otpauthUrl: uri } } });
      }
      if (path === "/v1/auth/mfa/totp/confirm") {
        confirmationRequests += 1;
        const body = request.postDataJSON();
        if (body.code !== "123456" || body.factorId !== factor.id) return route.fulfill({ status: 400, json: { error: { code: "INVALID_MFA_CODE", message: "Invalid MFA code." } } });
        enabled = true;
        return route.fulfill({ json: { mfa: { factor, recoveryCodes: codes } } });
      }
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings");
    const panel = page.getByRole("region", { name: "MFA setup", exact: true });
    const qr = panel.getByRole("img", { name: "Authenticator setup QR code", exact: true });
    await expect(panel.getByLabel("Current password", { exact: true })).toBeVisible();
    await expect(qr).toHaveCount(0);
    await panel.getByLabel("Current password", { exact: true }).fill("fixture-wrong-password");
    await panel.getByLabel("Current password", { exact: true }).press("Enter");
    await expect(panel.getByRole("status")).toBeVisible();
    await expect(qr).toHaveCount(0);
    await panel.getByLabel("Current password", { exact: true }).fill("fixture-current-password");
    await panel.getByLabel("Current password", { exact: true }).press("Enter");
    expect(await decodeEnrollmentQr(qr) === uri, "QR must encode the complete server-issued URI unchanged").toBe(true);
    await expect(qr).toHaveAccessibleDescription(/scan.*authenticator.*six-digit/i);
    expect((await panel.locator(".mfa-secret").textContent())?.includes(secret), "Manual secret remains available").toBe(true);
    expect((await panel.locator(".mfa-secret").textContent())?.includes(uri), "Manual setup URL remains available").toBe(true);
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await captureMfaEvidence(page, info, `mfa-setup-${width}`);
    await panel.getByLabel("MFA setup code", { exact: true }).fill("000000");
    await panel.getByLabel("MFA setup code", { exact: true }).press("Enter");
    await expect(panel.getByRole("status")).toBeVisible();
    expect(await decodeEnrollmentQr(qr) === uri, "A rejected code must preserve the current QR").toBe(true);
    await panel.getByLabel("MFA setup code", { exact: true }).fill("123456");
    await panel.getByLabel("MFA setup code", { exact: true }).press("Enter");
    await expect(page.getByText("Authenticator app MFA is enabled.", { exact: true })).toBeVisible();
    await expect(qr).toHaveCount(0);
    const displayedCodes = await panel.locator(".mfa-recovery code").textContent();
    expect(codes.every(code => displayedCodes?.includes(code)), "One-time recovery codes must be displayed after confirmation").toBe(true);
    await captureMfaEvidence(page, info, `mfa-enabled-${width}`);
    await page.reload();
    await expect(page.getByText("Authenticator app MFA is enabled.", { exact: true })).toBeVisible();
    await expect(page.locator(".mfa-recovery")).toHaveCount(0);
    await expect(page.locator(".mfa-secret")).toHaveCount(0);
    const privacy = await assertPrivacy([uri, secret, ...codes]);
    expect(enrollmentRequests).toBe(2);
    expect(confirmationRequests).toBe(2);
    expect(unexpected).toEqual([]);
    await info.attach("mfa-acceptance", { body: JSON.stringify({ width, uriRoundTrip: true, manualFallbacks: true, keyboardSubmission: true, passwordRetry: true, codeRetry: true, oneTimeRecoveryDisplay: true, ...privacy }), contentType: "application/json" });
  });
}
