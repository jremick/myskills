import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Persistent journey, with no route mocks. Failure targets: lost state on reload,
// unintended self-review default, unauthorized resolution, stale adoption after
// removal, accidental deletion of a referenced registry release, and a curator
// note omitted from the adopted release or lost after reload.
test("owner curates a persistent library, changes private-import policy, and removes the reference safely", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const token = process.env.MYSKILLS_ACCEPTANCE_OWNER_TOKEN;
  const baseURL = process.env.MYSKILLS_E2E_BASE_URL;
  if (!token || !baseURL) throw new Error("The disposable full-stack owner session is required.");
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.name));
  await page.context().addCookies([{ name: "myskills_session", value: token, url: baseURL, httpOnly: true, secure: true, sameSite: "Lax" }]);
  const meResponse = await page.request.get(`${baseURL}/api/v1/me`);
  expect(meResponse.status()).toBe(200);
  const { user } = await meResponse.json();
  expect(user.mfaVerified).toBe(true);
  await page.addInitScript((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user, expiresAt: new Date(Date.now() + 300_000).toISOString() });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Libraries", exact: true })).toBeVisible();
  const policy = page.getByLabel("Allow private import self-review");
  await expect(policy).toBeEnabled();
  await expect(policy).not.toBeChecked();
  await policy.check();
  await expect.poll(async () => (await (await page.request.get(`${baseURL}/api/v1/admin/library-settings`)).json()).settings.privateSelfReviewEnabled).toBe(true);
  await page.reload();
  await expect(policy).toBeChecked();
  await policy.uncheck();
  await expect.poll(async () => (await (await page.request.get(`${baseURL}/api/v1/admin/library-settings`)).json()).settings.privateSelfReviewEnabled).toBe(false);

  const name = `Release library ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("Library name").fill(name);
  await page.getByRole("button", { name: "Create library", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByLabel("Registry skill slug").fill("release-notes-helper");
  await page.getByRole("button", { name: "Save registry skill", exact: true }).click();
  await page.getByLabel("Reviewed release version").fill("0.1.0");
  const note = "Reviewed for the release preparation workflow.";
  await page.getByLabel("Curator note (optional)").fill(note);
  await page.getByRole("button", { name: "Adopt registry release", exact: true }).click();
  await expect(page.locator(".library-command")).toContainText("--library-entry");
  const command = await page.locator(".library-command").textContent();
  const entryId = command?.match(/--library-entry ([a-f0-9-]{36})/)?.[1];
  expect(entryId).toBeTruthy();
  await page.getByLabel("Notify me about changes").check();
  await expect(page.getByLabel("Notify me about changes")).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByLabel("Notify me about changes")).toBeChecked();
  await expect(page.locator(".library-command")).toHaveText(command!);
  await expect(page.getByText(`Curator note: ${note}`, { exact: true })).toBeVisible();
  const savedEntry = await (await page.request.get(`${baseURL}/api/v1/library-entries/${entryId}`)).json();
  expect(savedEntry.entry.adoption.reason).toBe(note);
  const resolutionResponse = await page.request.get(`${baseURL}/api/v1/library-entries/${entryId}/resolution`);
  expect(resolutionResponse.status()).toBe(200);
  const resolution = await resolutionResponse.json();
  expect(resolution.resolution).toMatchObject({ state: "adopted", slug: "release-notes-helper", version: "0.1.0" });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("persistent-library-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Remove entry", exact: true }).click();
  await page.getByRole("button", { name: "Confirm remove", exact: true }).click();
  await expect(page.locator(".library-command")).toHaveCount(0);
  expect((await page.request.get(`${baseURL}/api/v1/library-entries/${entryId}/resolution`)).status()).toBe(404);
  expect((await page.request.get(`${baseURL}/api/v1/skills/release-notes-helper/releases/0.1.0`)).status()).toBe(200);
  await page.context().clearCookies();
  expect((await page.request.get(`${baseURL}/api/v1/libraries`)).status()).toBe(401);
  expect(browserErrors).toEqual([]);
  await testInfo.attach("persistent-library-receipt", {
    body: JSON.stringify({ outcome: "pass", entryId, adoptedVersion: "0.1.0", policyEnabledThenDisabled: true, persistedAcrossReload: true, removedResolutionStatus: 404, referencedReleaseStatus: 200, anonymousLibraryStatus: 401 }),
    contentType: "application/json",
  });
});
