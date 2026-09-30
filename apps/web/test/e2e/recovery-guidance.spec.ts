import { expect, test, type Page } from "@playwright/test";

// Test-first browser boundary: receipt imports are local evidence, never a
// deployment command or a promise that an old backup is restorable.
const now = "2026-10-01T10:00:00.000Z";
const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const image = (name: string, health = "healthy") => ({ expectedRef: `ghcr.io/example/myskills-${name}@sha256:${digest}`, actualRef: `ghcr.io/example/myskills-${name}@sha256:${digest}`, health });
const receipt = () => ({
  schemaVersion: 1,
  kind: "myskills-operator-status",
  capturedAt: "2026-10-01T09:55:00.000Z",
  source: { commit: "c".repeat(40), version: "0.1.0-beta.18" },
  images: { api: image("api"), web: image("web"), mcp: { ...image("mcp", "disabled"), actualRef: null }, ops: { ...image("ops", "tool"), actualRef: null }, minio: image("minio"), postgres: image("postgres") },
  backup: { state: "current", capturedAt: "2026-10-01T09:30:00.000Z", runId: "2026-10-01T09-30-00.000Z_0123456789abcdef" },
});

async function fixture(page: Page, role = "owner") {
  const user = { id: "operator-1", name: "Example operator", email: "operator@example.test", status: "active", roles: [role], emailVerified: true, mfaVerified: true };
  await page.clock.install({ time: new Date(now) });
  await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-10-01T00:00:00Z" })), user);
  const writes: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (route.request().method() !== "GET") writes.push(path);
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/branding" || path === "/v1/admin/branding") return reply({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/site" || path === "/v1/admin/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/admin/registration") return reply({ registration: { mode: "closed" } });
    if (path === "/v1/admin/users") return reply({ users: [user] });
    if (path === "/v1/admin/api-tokens") return reply({ tokens: [] });
    if (path === "/v1/admin/providers") return reply({ providers: [] });
    if (path === "/v1/admin/audit") return reply({ events: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null }, worker: { configured: false, overdueTrackCount: 0 } });
    if (path === "/v1/admin/sharing") return reply({ sharing: { publicVisibilityEnabled: true, authenticatedVisibilityEnabled: true, teamsEnabled: true, teamVisibilityEnabled: true, userVisibilityEnabled: true, organizationVisibilityEnabled: true } });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path === "/v1/skills") return reply({ skills: [], nextCursor: null });
    if (path === "/v1/account/github") return reply({ github: { available: false, status: "disconnected", login: null, connectedAt: null, credentialSource: "anonymous" } });
    if (path === "/v1/admin/github") return reply({ github: { enabled: false, appId: "", clientId: "", installationId: null, installationEnabled: false, hasClientSecret: false, hasPrivateKey: false, callbackUrl: "https://api.example.test/v1/account/github/callback", status: "not_configured", lastCheckedAt: null, lastErrorCode: null } });
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return writes;
}

async function openRecovery(page: Page) {
  await page.goto("/admin#recovery");
  const tab = page.getByRole("tab", { name: "Recovery", exact: true });
  await tab.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Recovery guidance", exact: true })).toBeVisible();
}

async function importReceipt(page: Page, value: unknown, name = "operator-status.json") {
  await page.getByLabel("Operator status receipt", { exact: true }).setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
}

for (const [width, role] of [[1280, "owner"], [390, "admin"]] as const) test(`operator imports an offline snapshot and reviews isolated recovery at ${width}`, async ({ page }, info) => {
  const writes = await fixture(page, role);
  await page.setViewportSize({ width, height: 900 });
  await openRecovery(page);
  await expect(page.getByText("No receipt imported.", { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }));
  const value = receipt();
  value.images.api.actualRef = `ghcr.io/example/myskills-api@sha256:${otherDigest}`;
  value.images.web.health = "unhealthy";
  await importReceipt(page, value);
  await expect(page.getByRole("region", { name: "Imported operator snapshot" })).toContainText("2026-10-01T09:55:00.000Z");
  await expect(page.getByRole("region", { name: "Imported operator snapshot" })).toContainText("Offline snapshot");
  await expect(page.getByRole("region", { name: "Source snapshot" })).toContainText("0.1.0-beta.18");
  const rows = page.getByRole("table", { name: "Image snapshot" });
  await expect(rows.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "API", exact: true }) })).toContainText(`@sha256:${otherDigest}`);
  await expect(rows).toContainText("Unhealthy");
  await expect(page.getByRole("region", { name: "Readiness snapshot" })).toContainText("Needs attention in this snapshot");
  await expect(page.getByRole("region", { name: "Backup snapshot" })).toContainText("Within 26-hour backup window");
  const handoff = page.getByRole("region", { name: "Isolated restore handoff" });
  await expect(handoff).toContainText("new empty");
  await expect(handoff).toContainText("Owner sign-in, MFA, revoked access, and artifact delivery");
  await expect(handoff.getByLabel("Isolated restore commands")).toContainText("./myskills.sh recover plan");
  await expect(handoff.getByLabel("Isolated restore commands")).not.toContainText(value.backup.runId);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage) }))).toEqual(stored);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("offline-recovery-guidance.png"), fullPage: true });
  await info.attach("sanitized-import-fixture", { body: JSON.stringify(value, null, 2), contentType: "application/json" });
  await page.getByRole("button", { name: "Clear imported receipt", exact: true }).click();
  await expect(page.getByText("No receipt imported.", { exact: true })).toBeVisible();
});

test("ordinary user cannot reach the recovery importer through the admin URL", async ({ page }) => {
  const writes = await fixture(page, "user");
  await page.goto("/admin#recovery");
  await expect(page.getByRole("heading", { name: "Recovery guidance", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Operator status receipt", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Recovery", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("old and future snapshots cannot turn reported current backups into current recovery evidence", async ({ page }, info) => {
  const writes = await fixture(page);
  await openRecovery(page);
  const old = receipt();
  old.capturedAt = "2026-09-29T10:00:00.000Z";
  old.backup.capturedAt = "2026-09-29T09:30:00.000Z";
  await importReceipt(page, old);
  await expect(page.getByRole("region", { name: "Imported operator snapshot" })).toContainText("Stale snapshot");
  await expect(page.getByRole("region", { name: "Backup snapshot" })).toContainText("Outside 26-hour backup window");
  await expect(page.getByRole("region", { name: "Backup snapshot" })).toContainText("Helper reported: Current");
  await expect(page.getByRole("region", { name: "Readiness snapshot" })).toContainText("Current readiness unknown");
  const future = receipt();
  future.capturedAt = "2026-10-02T10:00:00.000Z";
  future.backup.capturedAt = "2026-10-02T09:30:00.000Z";
  await importReceipt(page, future);
  await expect(page.getByRole("region", { name: "Imported operator snapshot" })).toContainText("Clock mismatch");
  await expect(page.getByRole("region", { name: "Backup snapshot" })).toContainText("Backup freshness unknown");
  await expect(page.getByRole("region", { name: "Readiness snapshot" })).toContainText("Current readiness unknown");
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("future-receipt-warning.png"), fullPage: true });
});

test("invalid receipts replace prior evidence without exposing their fields", async ({ page }, info) => {
  const writes = await fixture(page);
  await openRecovery(page);
  await importReceipt(page, receipt());
  await expect(page.getByRole("region", { name: "Source snapshot" })).toBeVisible();
  const privateValue = "test-only-private-value-never-a-credential";
  const invalid: unknown[] = [
    { ...receipt(), accessToken: privateValue },
    { ...receipt(), source: { ...receipt().source, password: privateValue } },
    { ...receipt(), images: { ...receipt().images, api: { ...image("api"), expectedRef: `https://user:${privateValue}@registry.example.test/api@sha256:${digest}` } } },
    { ...receipt(), images: { ...receipt().images, api: { ...image("api"), expectedRef: `ghcr.io/example/../api@sha256:${digest}` } } },
    { ...receipt(), source: { ...receipt().source, commit: "not-a-source-commit" } },
    { ...receipt(), backup: { ...receipt().backup, runId: "../../private/backup" } },
    { ...receipt(), capturedAt: "2026-02-30T10:00:00.000Z" },
  ];
  for (const value of invalid) {
    await importReceipt(page, value);
    await expect(page.getByRole("alert")).toContainText("Receipt rejected");
    await expect(page.getByRole("region", { name: "Source snapshot" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(privateValue);
  }
  await page.getByLabel("Operator status receipt", { exact: true }).setInputFiles({ name: "oversized.json", mimeType: "application/json", buffer: Buffer.alloc(65_537, " ") });
  await expect(page.getByRole("alert")).toContainText("64 KiB");
  await page.getByLabel("Operator status receipt", { exact: true }).setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{broken") });
  await expect(page.getByRole("alert")).toContainText("Receipt rejected");
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("receipt-rejected.png"), fullPage: true });
});

test("a delayed file selection cannot overwrite a newer rejection or a cleared snapshot", async ({ page }) => {
  const writes = await fixture(page);
  await page.addInitScript(() => {
    const read = File.prototype.text;
    File.prototype.text = async function () {
      if (this.name.startsWith("delayed")) await new Promise(resolve => setTimeout(resolve, 500));
      return read.call(this);
    };
  });
  await openRecovery(page);
  await importReceipt(page, receipt(), "delayed-first.json");
  await expect(page.getByRole("status").filter({ hasText: "Reading receipt" })).toBeVisible();
  await importReceipt(page, { ...receipt(), password: "test-only-private-value" });
  await expect(page.getByRole("alert")).toContainText("Receipt rejected");
  await page.waitForTimeout(600);
  await expect(page.getByRole("region", { name: "Source snapshot" })).toHaveCount(0);
  await importReceipt(page, receipt(), "delayed-second.json");
  await page.getByRole("button", { name: "Clear imported receipt", exact: true }).click();
  await page.waitForTimeout(600);
  await expect(page.getByText("No receipt imported.", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Source snapshot" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
