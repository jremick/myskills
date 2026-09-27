import { expect, test, type Page } from "@playwright/test";
import { workspaceTarget } from "../workspace-target-fixture.js";

// Authored before Wave 3. Four targets make misplaced review, stale selection,
// cross-target queueing and lost batch selection observable in a browser.
const date = "2026-09-27T00:00:00Z";
const targets = ["Writing workstation", "Review workstation", "Release workstation", "Retired workstation"].map((name, i) => ({ ...workspaceTarget(), id: `target-${i + 1}`, name, ...(i === 3 ? { status: "revoked" } : {}) }));
const release = (version: string) => ({ version, lifecycleStatus: "approved", publishedAt: date, platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }], changeKind: "fix", requiresUserAction: false, compatibility: {}, releaseNotes: `Reviewed changes for ${version}.`, artifact: { sha256: "c".repeat(64), byteSize: 512, contentType: "application/json" } });
async function fixture(page: Page) {
  const user = { id: "user-1", name: "Example owner", email: "owner@example.test", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-27T00:00:00Z" })), user);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const operations: Record<string, Array<Record<string, unknown>>> = {};
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const reply = (json: unknown) => route.fulfill({ json });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      const targetId = path.split("/")[3]!;
      const operation = { schemaVersion: 1, id: `operation-${writes.length}`, targetId, targetGeneration: 1, action: body.action, skillSlug: body.slug, fromVersion: "1.0.0", toVersion: body.version, platform: body.platform, artifact: release("1.2.0").artifact, planDigest: "d".repeat(64), state: "queued", fencingToken: 1, createdAt: date, updatedAt: date };
      if (path.endsWith("/operations")) { operations[targetId] = [operation]; return reply({ operation, replayed: false }); }
      if (path === "/v1/target-operations/batch") return reply({ results: (body.operations as unknown[]).map(() => ({ operation, replayed: false })) });
    }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/architecture-targets") return reply({ targets });
    if (path.endsWith("/updates")) return reply({ targetId: path.split("/")[3], observedAt: date, policy: null, items: [{ slug: "release-notes-helper", platform: "codex", evaluation: { status: "update-available", installedVersion: "1.0.0", candidate: release("1.2.0"), includedReleases: [release("1.1.0"), release("1.2.0")], blockers: [] } }] });
    if (path.endsWith("/operations")) return reply({ operations: operations[path.split("/")[3]!] ?? [] });
    if (path.endsWith("/update-policy")) return reply({ revision: null });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return writes;
}

for (const width of [1280, 390]) test(`third-target update review stays in context and queues the exact target at ${width}`, async ({ page }, info) => {
  const writes = await fixture(page);
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
  await page.goto("/updates");
  const select = page.getByRole("button", { name: /Release workstation/ });
  await select.click();
  await expect(page.getByRole("heading", { name: "Release workstation", exact: true })).toBeInViewport();
  const review = page.getByRole("button", { name: "Review", exact: true });
  await review.click();
  const panel = page.getByLabel("Update review", { exact: true });
  await expect(panel.getByRole("heading")).toBeFocused();
  await expect(panel.getByRole("heading")).toBeInViewport();
  await expect(panel).toContainText("Reviewed changes for 1.1.0.");
  await expect(panel).toContainText("Reviewed changes for 1.2.0.");
  expect(writes).toHaveLength(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toBeFocused();
  await review.click();
  await panel.getByRole("button", { name: "Queue exact update", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.path).toBe("/v1/architecture-targets/target-3/operations");
  expect(writes[0]?.body).toMatchObject({ action: "update", slug: "release-notes-helper", version: "1.2.0", platform: "codex" });
  expect(writes[0]?.body.idempotencyKey).toEqual(expect.any(String));
  await expect(page.getByLabel("Operation history for Release workstation")).toContainText(/Queued|queued/);
  if (width === 390) {
    await page.getByRole("button", { name: "Back to targets", exact: true }).click();
    await expect(select).toBeFocused();
  }
  await page.getByRole("button", { name: /Retired workstation/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("button", { name: "Queue exact update", exact: true })).toBeDisabled();
  expect(writes).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("four-target-exact-review.png"), fullPage: true });
  await info.attach("exact-target-receipt", { body: JSON.stringify(writes, null, 2), contentType: "application/json" });
});

for (const width of [1280, 390]) test(`batch selection survives target navigation and reviews both identities at ${width}`, async ({ page }, info) => {
  const writes = await fixture(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/updates");
  const choose = async (name: string) => page.getByRole("button", { name: new RegExp(name) }).click();
  await choose("Writing workstation");
  await page.getByRole("checkbox", { name: /release-notes-helper/ }).check();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  if (width === 390) await page.getByRole("button", { name: "Back to targets", exact: true }).click();
  await choose("Review workstation");
  await expect(page.getByLabel("Update review", { exact: true })).toBeHidden();
  await page.getByRole("checkbox", { name: /release-notes-helper/ }).check();
  await expect(page.getByText("2 selected across 2 targets", { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Review batch", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Confirm batch", exact: true });
  await expect(confirm).toBeVisible();
  expect(writes).toHaveLength(0);
  await confirm.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]?.path).toBe("/v1/target-operations/batch");
  const operations = writes[0]?.body.operations as Array<Record<string, unknown>>;
  expect(operations.map(item => item.targetId).sort()).toEqual(["target-1", "target-2"]);
  expect(operations.every(item => item.slug === "release-notes-helper" && item.version === "1.2.0" && item.platform === "codex")).toBe(true);
  expect(new Set(operations.map(item => item.idempotencyKey)).size).toBe(2);
  await expect(page.getByText("2 selected across 2 targets", { exact: true })).toBeHidden();
  if (width === 390) await page.getByRole("button", { name: "Back to targets", exact: true }).click();
  await choose("Retired workstation");
  await expect(page.getByRole("checkbox", { name: /release-notes-helper/ })).toBeDisabled();
  await info.attach("batch-identities", { body: JSON.stringify(writes, null, 2), contentType: "application/json" });
});
