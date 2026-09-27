import { expect, test, type Page } from "@playwright/test";
import { workspaceTarget } from "../workspace-target-fixture.js";

// Written before the first design-foundations implementation. Credible failures:
// immediate rollback, hidden archive consequences, duplicate submissions on retry,
// loss of modal focus, role leakage, cramped page edges and undersized touch controls.
// These browser fixtures prove client behaviour; the API retains authorization.
const target = { ...workspaceTarget(), name: "Personal workspace for release engineering" };
const operation = {
  schemaVersion: 1, id: "operation-succeeded", targetId: target.id, targetGeneration: 1,
  action: "update", skillSlug: "release-notes-helper", fromVersion: "1.0.0", toVersion: "1.2.0", platform: "codex",
  artifact: { sha256: "c".repeat(64), byteSize: 120, contentType: "application/json" },
  planDigest: "8".repeat(64), state: "succeeded", fencingToken: 1,
  createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:01:00Z",
};
const organization = { id: "org-1", name: "Release engineering and documentation", slug: "release-engineering", status: "active", role: "owner", currentPolicy: null, currentPolicyRevisionId: null, createdByUserId: "user-1", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };

async function fixture(page: Page, restricted = false, polling = false) {
  const user = { id: "user-1", email: "owner@example.test", name: "Example owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-27T00:00:00Z", user })), user);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let attempts = 0;
  let archived = false;
  let queued = false;
  let releaseWrite: (() => void) | undefined;
  let delayed = false;
  let observedVersion = "1.2.0";
  let revoked = restricted;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (method === "POST") {
      writes.push({ path, body: route.request().postDataJSON() });
      attempts += 1;
      if (delayed) await new Promise<void>((resolve) => { releaseWrite = resolve; });
      if (attempts === 1) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Try again" } }, 503);
      if (path.endsWith("/operations")) { queued = true; return reply({ operation: { ...operation, id: "rollback-queued", action: "rollback", fromVersion: "1.2.0", toVersion: "1.0.0", state: "queued" }, replayed: false }); }
      if (path.endsWith("/actions")) { archived = true; return reply({ organization: { ...organization, status: "archived" } }); }
    }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/skills") return reply({ skills: [] });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/architecture-targets") return reply({ targets: [{ ...target, ...(revoked ? { status: "revoked" } : {}) }] });
    if (path.endsWith("/updates")) return reply({ targetId: target.id, observedAt: "2026-09-27T00:00:00Z", policy: null, items: [{ slug: operation.skillSlug, platform: "codex", evaluation: { status: "up-to-date", installedVersion: observedVersion, includedReleases: [], blockers: [] } }] });
    if (path.endsWith("/operations")) return reply({ operations: queued ? [{ ...operation, id: "rollback-queued", action: "rollback", fromVersion: "1.2.0", toVersion: "1.0.0", state: "queued" }] : [operation, ...(polling ? [{ ...operation, id: "operation-active", skillSlug: "another-skill", state: "queued" }] : [])] });
    if (path.endsWith("/update-policy")) return reply({ revision: null });
    if (path === "/v1/organizations") return reply({ organizations: archived ? [] : [{ ...organization, role: restricted ? "member" : "owner" }] });
    if (path === "/v1/organizations/org-1" && archived) return reply({ error: { code: "NOT_FOUND" } }, 404);
    if (path === "/v1/organizations/org-1") return reply({ organization: { ...organization, role: restricted ? "member" : "owner" } });
    if (path.endsWith("/members")) return reply({ members: [] });
    if (path.endsWith("/invitations")) return reply({ invitations: [] });
    if (path.endsWith("/policy-revisions")) return reply({ revisions: [] });
    if (path.endsWith("/teams")) return reply({ teams: [] });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null }, worker: { configured: true, overdueTrackCount: 0 } });
    return reply({ error: { code: "NOT_FOUND", message: `Missing fixture ${method} ${path}` } }, 404);
  });
  return { writes, observe: (version: string) => { observedVersion = version; }, revoke: () => { revoked = true; observedVersion = "1.4.0"; }, delay: () => { delayed = true; }, release: () => { delayed = false; releaseWrite?.(); } };
}

test("rollback confirms exact target and version, traps focus, cancels, and retries without duplicate intent", async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.goto("/updates");
  const rollback = page.getByRole("button", { name: "Rollback", exact: true });
  await rollback.click();
  const dialog = page.getByRole("dialog", { name: "Queue rollback for release-notes-helper?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(target.name);
  await expect(dialog).toContainText(operation.skillSlug);
  await expect(dialog).toContainText("1.2.0");
  await expect(dialog).toContainText("1.0.0");
  expect(state.writes).toHaveLength(0);
  await expect(dialog.getByRole("heading")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Queue rollback" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(rollback).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await rollback.click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(state.writes).toHaveLength(0);
  await rollback.click();
  state.delay();
  await dialog.getByRole("button", { name: "Queue rollback" }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Working…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  state.release();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rollback-recoverable-error.png") });
  await dialog.getByRole("button", { name: "Queue rollback" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0]).toEqual(state.writes[1]);
  expect(state.writes[1]?.body).toMatchObject({ action: "rollback", slug: "release-notes-helper", version: "1.0.0", platform: "codex" });
  expect(state.writes[1]?.path).toBe(`/v1/architecture-targets/${target.id}/operations`);
  await expect(page.getByRole("region", { name: `Operation history for ${target.name}` })).toContainText(/queued/i);
  await testInfo.attach("rollback-write-receipt", { body: JSON.stringify(state.writes, null, 2), contentType: "application/json" });
});

test("archive presents a visible named consequence, preserves cancellation and recovers after failure", async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organizations");
  await page.getByRole("button", { name: new RegExp(organization.name) }).click();
  const archive = page.getByRole("button", { name: "Archive", exact: true });
  await archive.click();
  const dialog = page.getByRole("dialog", { name: `Archive ${organization.name}?` });
  await expect(dialog).toBeVisible();
  const description = dialog.locator("#archive-org-1-description");
  await expect(description).toContainText(organization.name);
  await expect(description).toContainText("sharing");
  expect(await description.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(20);
  expect(state.writes).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(archive).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await archive.click();
  state.delay();
  await dialog.getByRole("button", { name: "Archive organization", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "Working…" })).toBeDisabled();
  state.release();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("archive-mobile-error.png") });
  await dialog.getByRole("button", { name: "Archive organization", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: organization.name, exact: true })).toHaveCount(0);
  expect(state.writes.map((write) => write.body)).toEqual([{ action: "archive" }, { action: "archive" }]);
  await testInfo.attach("archive-write-receipt", { body: JSON.stringify(state.writes, null, 2), contentType: "application/json" });
});

test("restricted targets and organization members do not gain consequential actions", async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto("/updates");
  await expect(page.getByRole("button", { name: "Rollback", exact: true })).toBeDisabled();
  await page.goto("/organizations");
  await expect(page.getByRole("heading", { name: organization.name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test("shared page foundations keep readable gutters, control borders and headings across screen sizes", async ({ page }, testInfo) => {
  await fixture(page);
  const geometry = [];
  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["/libraries", "/updates", "/organizations"]) {
      await page.goto(route);
      const main = page.getByRole("main");
      const heading = main.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      const metrics = await main.evaluate((element) => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, padding: parseFloat(getComputedStyle(element).paddingLeft), title: getComputedStyle(element.querySelector("h1")!).fontSize }));
      geometry.push({ route, ...metrics });
      expect(metrics.overflow, `${route} at ${width}px`).toBe(false);
      expect(metrics.padding).toBeGreaterThanOrEqual(16);
      expect(metrics.title).toBe("20px");
      if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`${route.slice(1)}-${width}.png`), fullPage: true });
    }
  }
  await page.goto("/libraries");
  await expect(page.getByLabel("Library name")).toHaveCSS("border-color", "rgb(123, 135, 148)");
  await page.getByLabel("Library name").focus();
  await expect(page.getByLabel("Library name")).toHaveCSS("outline-width", "3px");
  await testInfo.attach("responsive-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
});

test.describe("coarse pointer", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("small action controls retain a 44px touch target", async ({ page }, testInfo) => {
    await fixture(page);
    await page.goto("/updates");
    const rollback = page.getByRole("button", { name: "Rollback", exact: true });
    await expect(rollback).toBeVisible();
    await testInfo.attach("touch-geometry", { body: JSON.stringify(await rollback.evaluate((element) => ({ coarse: matchMedia("(pointer: coarse)").matches, touchPoints: navigator.maxTouchPoints, minHeight: getComputedStyle(element).minHeight, height: element.getBoundingClientRect().height }))), contentType: "application/json" });
    expect(await rollback.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await rollback.click();
    expect(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  });
});

test("public landing and login retain their visual baseline", async ({ page }, testInfo) => {
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/site") ? { site: { landingPageEnabled: true } } : { providers: [] } }));
  const metrics = [];
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    await expect(page.locator(path === "/" ? ".marketing-landing" : ".login-page")).toBeVisible();
    metrics.push(await page.locator(path === "/" ? ".marketing-landing" : ".login-page").evaluate((root) => [root, ...root.querySelectorAll("h1, h2, button, input, a")].map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, text: element.textContent?.trim().slice(0, 80), color: style.color, background: style.backgroundColor, font: style.font, border: style.border, width: rect.width, height: rect.height };
    })));
  }
  await testInfo.attach("public-style-baseline", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
});

// Regression added before correcting stale observation text found in design review.
test("an open rollback review follows inventory refreshes and rechecks revoked consent", async ({ page }) => {
  const state = await fixture(page, false, true);
  await page.goto("/updates");
  await page.getByRole("button", { name: "Rollback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Queue rollback for release-notes-helper?" });
  const observation = dialog.locator(".confirmation-details > div").filter({ has: page.getByText("Currently observed", { exact: true }) });
  await expect(observation).toContainText("1.2.0");
  const confirm = dialog.getByRole("button", { name: "Queue rollback", exact: true });
  await confirm.focus();
  state.observe("1.3.0");
  await expect(observation).toContainText("1.3.0", { timeout: 10_000 });
  await expect(confirm).toBeFocused();
  await expect(dialog.locator(".confirmation-details > div").filter({ has: page.getByText("Roll back to", { exact: true }) })).toContainText("1.0.0");
  state.revoke();
  await expect(observation).toContainText("1.4.0", { timeout: 10_000 });
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText("can no longer accept the rollback");
  expect(state.writes).toHaveLength(0);
});
