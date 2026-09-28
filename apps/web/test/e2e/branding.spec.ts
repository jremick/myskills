import { expect, test, type Page } from "@playwright/test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../../../api/dist/app.js";
import { AuthService } from "../../../api/dist/auth/service.js";
import { MemoryAuthStore } from "../../../api/dist/auth/memory-auth-store.js";
import { PostgresAuthStore } from "../../../api/dist/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../../../api/dist/db/client.js";
import { runMigrations } from "../../../api/dist/db/migrate.js";
import { MemorySkillRepository } from "../../../api/dist/repositories/memory-skill-repository.js";

// Real API handlers and auth/store implementations. The browser's same-origin
// proxy is supplied by the fixture; branding reaches the real API except for
// explicit outage injection.
// TEST_DATABASE_URL selects a disposable Postgres database for durable proof.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkaPjPwMDAxAAGABEfAYP1piHtAAAAAElFTkSuQmCC", "base64");
const defaults = { text: "MySkills", showText: true, logoDataUrl: null };
let app: ReturnType<typeof buildApp>;
let pool: ReturnType<typeof createPgPool> | undefined;
let owner: { token: string; expiresAt: string; user: Record<string, unknown> };
let failSave = false;
let failRead = false;
let saveGate: Promise<void> | undefined;
let saveArrived: (() => void) | undefined;

test.beforeAll(async () => {
  test.setTimeout(60_000);
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    expect(new URL(url).pathname).toMatch(/(?:_|\/)(?:test|ci)(?:_|$)|_test$/);
    pool = createPgPool(url);
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  }
  const store = pool ? new PostgresAuthStore(createDb(pool)) : new MemoryAuthStore("closed");
  const created = await store.createUserWithPassword({ email: "branding-owner@example.test", name: "Branding owner", passwordHash: await hashPassword("branding test password only") });
  if (!created.user) throw new Error("Fixture owner was not created");
  await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
  await store.updateUserRoles({ userId: created.user.id, roles: ["owner"] });
  app = buildApp({ authService: new AuthService(store), skillRepository: new MemorySkillRepository([]), allowedOrigins: [`http://127.0.0.1:${process.env.MYSKILLS_E2E_PORT ?? 4174}`] });
  const call = async (url: string, payload: Record<string, unknown>, token?: string) => {
    const response = await app.inject({ method: "POST", url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.statusCode).toBeLessThan(300);
    return response.json();
  };
  const login = { email: "branding-owner@example.test", password: "branding test password only" };
  const setup = await call("/v1/auth/login", login);
  const { enrollment } = await call("/v1/auth/mfa/totp/enroll", { password: login.password }, setup.token);
  const { mfa } = await call("/v1/auth/mfa/totp/confirm", { factorId: enrollment.factorId, code: generateTotpCode(enrollment.secret) }, setup.token);
  const challenge = await call("/v1/auth/login", login);
  owner = await call("/v1/auth/mfa/verify", { challengeToken: challenge.challengeToken, recoveryCode: mfa.recoveryCodes[0] });
});

test.afterAll(async () => { await app?.close(); await pool?.end(); });

async function proxy(page: Page) {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (failRead && url.pathname === "/api/v1/branding") {
      return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Injected outage" } } });
    }
    if (failSave && url.pathname === "/api/v1/admin/branding" && request.method() === "PUT") {
      return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Injected outage" } } });
    }
    if (saveGate && url.pathname === "/api/v1/admin/branding" && request.method() === "PUT") { saveArrived?.(); await saveGate; }
    const response = await app.inject({ method: request.method() as "GET" | "POST" | "PUT", url: url.pathname.replace(/^\/api/, "") + url.search, headers: request.headers(), payload: request.postData() ?? undefined });
    const headers = Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]));
    await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
  });
}

async function signIn(page: Page) {
  await page.goto("/favicon.svg");
  await page.context().addCookies([{ name: "myskills_session", value: owner.token, url: new URL(page.url()).origin, httpOnly: true, sameSite: "Lax" }]);
  await page.evaluate(session => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user: owner.user, expiresAt: owner.expiresAt });
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Branding", exact: true }).click({ timeout: 10_000 });
}

const defaultTitle = "MySkills — Your AI skills, kept in order";
async function expectBrowserBranding(page: Page, title: string, logo?: string, mimeType = "image/png") {
  await expect(page).toHaveTitle(title);
  const icons = page.locator('head link[rel~="icon"]');
  if (logo) {
    await expect(icons).toHaveCount(1);
    await expect(icons).toHaveAttribute("href", `data:${mimeType};base64,${logo}`);
    expect(await icons.evaluate(async (element: HTMLLinkElement) => {
      const image = new Image(); image.src = element.href; await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    })).toBe(true);
  } else {
    await expect(icons).toHaveCount(4);
    await expect(page.locator('head link[rel="icon"][href="/favicon.svg"]')).toHaveCount(1);
    await expect(page.locator('head link[rel="icon"][href^="data:"]')).toHaveCount(0);
  }
}

test("admin branding survives reload, navigation and anonymous reads; drafts, errors and reset stay safe", async ({ page }, info) => {
  test.setTimeout(90_000);
  await proxy(page);
  await signIn(page);
  const panel = page.getByRole("tabpanel", { name: "Branding", exact: true });
  const text = panel.getByLabel("Brand text", { exact: true });
  await expect(text).toHaveValue("MySkills");
  await expectBrowserBranding(page, defaultTitle);
  await text.fill("Research & Delivery");
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  const preview = panel.getByRole("region", { name: "Brand preview", exact: true });
  await expect(preview.getByText("Research & Delivery", { exact: true })).toBeVisible();
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await expect(page.locator(".app-sidebar")).toContainText("MySkills");
  await expectBrowserBranding(page, defaultTitle);
  await page.getByRole("tab", { name: "Instance", exact: true }).click();
  await page.getByRole("tab", { name: "Branding", exact: true }).click();
  await expect(text).toHaveValue("Research & Delivery");
  failSave = true;
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Couldn’t save");
  await expect(text).toHaveValue("Research & Delivery");
  failSave = false;
  await expectBrowserBranding(page, defaultTitle);
  let releaseSave!: () => void;
  saveGate = new Promise(resolve => { releaseSave = resolve; });
  const requested = new Promise<void>(resolve => { saveArrived = resolve; });
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await requested;
  await page.locator(".app-sidebar").getByRole("link", { name: "Registry", exact: true }).click();
  releaseSave(); saveGate = undefined;
  await expect(page.locator(".app-sidebar")).toContainText("Research & Delivery");
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  await page.locator(".app-sidebar").getByRole("link", { name: "Admin", exact: true }).click();
  await page.reload();
  await page.getByRole("tab", { name: "Branding", exact: true }).click();
  await expect(text).toHaveValue("Research & Delivery");
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  await panel.getByLabel("Show brand text", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  const sidebarBrand = page.locator(".app-sidebar .brand");
  await expect(sidebarBrand.getByText("Research & Delivery", { exact: true })).toBeHidden();
  await expect(sidebarBrand).toHaveAccessibleName("Research & Delivery");
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  for (const mimeType of ["image/jpeg", "image/webp"]) {
    const encoded = await page.evaluate(type => {
      const canvas = document.createElement("canvas"); canvas.width = 16; canvas.height = 16;
      const context = canvas.getContext("2d")!; context.fillStyle = "#007f75"; context.fillRect(0, 0, 16, 16);
      return canvas.toDataURL(type).split(",")[1]!;
    }, mimeType);
    await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: `logo.${mimeType.split("/")[1]}`, mimeType, buffer: Buffer.from(encoded, "base64") });
    await panel.getByRole("button", { name: "Save branding", exact: true }).click();
    await expect(panel.getByRole("status")).toContainText("Branding saved");
    await expectBrowserBranding(page, "Research & Delivery", encoded, mimeType);
  }
  const wideLogo = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 16;
    const context = canvas.getContext("2d")!; context.fillStyle = "#007f75"; context.fillRect(0, 0, 128, 16);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(wideLogo, "base64") });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 128);
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await expectBrowserBranding(page, "Research & Delivery", wideLogo);
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await expect(sidebarBrand.locator("img")).toBeVisible();
  expect((await sidebarBrand.locator("img").boundingBox())!.width).toBeLessThanOrEqual(24);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await panel.getByRole("button", { name: "Remove custom logo", exact: true }).click();
  await panel.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  await panel.getByRole("button", { name: "Remove custom logo", exact: true }).click();
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await expectBrowserBranding(page, "Research & Delivery");
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 2);
  await panel.getByLabel("Logo image", { exact: true }).setInputFiles({ name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(262145) });
  await expect(panel.getByRole("alert")).toContainText("256 KB");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(text).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".mobile-brand")).toHaveAccessibleName("Research & Delivery");
  await expect(page.locator(".mobile-brand img")).toHaveJSProperty("naturalWidth", 2);
  await panel.getByLabel("Show brand text", { exact: true }).check();
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await expect(page.locator(".mobile-brand")).toContainText("Research & Delivery");
  await page.screenshot({ path: info.outputPath("branding-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: info.outputPath("branding-desktop.png"), fullPage: true });
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  for (const path of ["/", "/login", "/auth/register", "/auth/reset-password", "/auth/verify-email", "/auth/change-email", "/registry"]) {
    await page.goto(path);
    const brand = page.locator(path === "/" ? ".site-header .brand" : path === "/registry" ? ".app-sidebar .brand" : ".landing-brand").first();
    await expect(brand).toContainText("Research & Delivery");
    await expect(brand.locator("img")).toHaveJSProperty("naturalWidth", 2);
    await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  }
  failRead = true;
  const failedRead = page.waitForResponse(response => response.url().endsWith("/api/v1/branding") && response.status() === 503);
  await page.goto("/login");
  await failedRead;
  await expect(page.locator(".landing-brand").first().getByRole("img", { name: "MySkills", exact: true })).toBeVisible();
  await expectBrowserBranding(page, defaultTitle);
  failRead = false;
  await page.reload();
  await expectBrowserBranding(page, "Research & Delivery", png.toString("base64"));
  await signIn(page);
  await text.fill("Research and delivery ".repeat(4).slice(0, 80));
  await panel.getByRole("button", { name: "Save branding", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  const sidebarBounds = (await page.locator(".app-sidebar").boundingBox())!;
  const collapseBounds = (await page.getByRole("button", { name: "Collapse navigation", exact: true }).boundingBox())!;
  expect(collapseBounds.x + collapseBounds.width).toBeLessThanOrEqual(sidebarBounds.x + sidebarBounds.width);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".mobile-brand")).toHaveAccessibleName("Research and delivery ".repeat(4).slice(0, 80).trim());
  await expectBrowserBranding(page, "Research and delivery ".repeat(4).slice(0, 80).trim(), png.toString("base64"));
  await panel.getByRole("button", { name: "Restore MySkills defaults", exact: true }).click();
  await expect(text).toHaveValue("MySkills");
  await panel.getByRole("button", { name: "Save branding", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("status")).toContainText("Branding saved");
  await expectBrowserBranding(page, defaultTitle);
  await page.reload();
  await expectBrowserBranding(page, defaultTitle);
  expect((await app.inject({ method: "GET", url: "/v1/branding" })).json()).toEqual({ branding: defaults });
  expect((await app.inject({ method: "GET", url: "/v1/site" })).json()).toEqual({ site: { landingPageEnabled: true } });
  await info.attach("branding-verification", { body: JSON.stringify({ database: pool ? "PostgreSQL" : "memory", checks: ["save and reload", "public surfaces", "draft retention", "failed save", "hide text", "collapsed sidebar", "invalid uploads", "discard", "reset", "mobile overflow", "keyboard save", "tab title", "decoded favicon", "favicon replacement and removal", "branding read outage"] }), contentType: "application/json" });
});
