import { generateKeyPairSync } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { buildApp } from "../../../api/dist/app.js";
import { AuthService } from "../../../api/dist/auth/service.js";
import { PostgresAuthStore } from "../../../api/dist/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../../../api/dist/db/client.js";
import { runMigrations } from "../../../api/dist/db/migrate.js";
import { MemorySkillRepository } from "../../../api/dist/repositories/memory-skill-repository.js";

// Authored before UI implementation. Failure inventory at the browser/API boundary:
// - admin drafts disappear after a failed save, or secrets return after success;
// - OAuth cannot return to the same signed-in user, or another user sees the link;
// - callback errors expose upstream text; disconnect fails to persist;
// - admin controls appear without MFA; installation selection is not reflected.
// Existing account/branding journeys do not exercise GitHub. Real auth, routes,
// encryption and Postgres storage remain in use; only external GitHub is faked.
const origin = `http://127.0.0.1:${process.env.MYSKILLS_E2E_PORT ?? 4174}`;
const secret = "synthetic-browser-client-secret";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let app: ReturnType<typeof buildApp>;
let pool: ReturnType<typeof createPgPool>;
let owner: { token: string; expiresAt: string; user: Record<string, unknown> };
let member: typeof owner;
let unverifiedOwner: typeof owner;
let failSave = false;

test.beforeAll(async () => {
  test.skip(!process.env.TEST_DATABASE_URL, "A disposable Postgres database is required for GitHub browser integration.");
  test.setTimeout(60_000);
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  expect(new URL(databaseUrl).pathname).toMatch(/(?:_|\/)(?:test|ci)(?:_|$)|_test$/);
  pool = createPgPool(databaseUrl);
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const store = new PostgresAuthStore(createDb(pool));
  const { GithubIntegrationService } = await import("../../../api/dist/github/service.js");
  const transport = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/login/oauth/access_token") return Response.json({ access_token: "synthetic-user-access", refresh_token: "synthetic-user-refresh", expires_in: 28800, refresh_token_expires_in: 15_552_000, token_type: "bearer", scope: "" });
    if (url.pathname === "/user") return Response.json({ id: 1234, login: "browser-skill-author" });
    if (url.pathname === "/app") return Response.json({ id: 123456, client_id: "Iv1.browser-test", slug: "browser-test-app", owner: { login: "example-org" } });
    if (url.pathname === "/app/installations/77") return Response.json({ id: 77, app_id: 123456, target_type: "Organization", account: { login: "example-org", type: "Organization" }, suspended_at: null, permissions: { contents: "read", metadata: "read" } });
    if (url.pathname === "/app/installations/77/access_tokens") return Response.json({ token: "synthetic-installation-access", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: "read" } });
    return Response.json({ message: "Unexpected fixture request" }, { status: 404 });
  }) as typeof fetch;
  app = buildApp({ authService: new AuthService(store), skillRepository: new MemorySkillRepository([]), allowedOrigins: [origin], githubService: new GithubIntegrationService({ db: createDb(pool), secret: "synthetic-github-encryption-key-for-browser-tests", apiBaseUrl: `${origin}/api`, webBaseUrl: origin, transport }) });
  const createSession = async (email: string, roles: Array<"owner" | "user">) => {
    const created = await store.createUserWithPassword({ email, name: email.split("@")[0]!, passwordHash: await hashPassword("synthetic browser password only") });
    if (!created.user) throw new Error("Browser fixture user creation failed");
    await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
    await store.updateUserRoles({ userId: created.user.id, roles });
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "synthetic browser password only" } });
    expect(login.statusCode).toBe(200);
    return login.json();
  };
  unverifiedOwner = await createSession("github-owner@example.test", ["owner"]);
  const enroll = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${unverifiedOwner.token}` }, payload: { password: "synthetic browser password only" } });
  const { enrollment } = enroll.json();
  const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${unverifiedOwner.token}` }, payload: { factorId: enrollment.factorId, code: generateTotpCode(enrollment.secret) } });
  const { mfa } = confirm.json();
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "github-owner@example.test", password: "synthetic browser password only" } });
  const verified = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: mfa.recoveryCodes[0] } });
  expect(verified.statusCode).toBe(200);
  owner = verified.json();
  member = await createSession("github-member@example.test", ["user"]);
});
test.afterAll(async () => { await app?.close(); await pool?.end(); });

async function proxy(page: Page) {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (failSave && url.pathname === "/api/v1/admin/github" && request.method() === "PUT") return route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
    const response = await app.inject({ method: request.method() as "GET" | "POST" | "PUT" | "DELETE", url: url.pathname.replace(/^\/api/, "") + url.search, headers: request.headers(), payload: request.postData() ?? undefined });
    const headers = Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]));
    await route.fulfill({ status: response.statusCode, headers, body: response.rawPayload });
  });
  await page.route("https://github.com/login/oauth/authorize**", async route => {
    const url = new URL(route.request().url());
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "synthetic-browser-code");
    // Playwright only routes the first URL of an HTTP redirect chain. Start a
    // new browser navigation so the callback reaches the real API proxy above.
    await route.fulfill({ contentType: "text/html", body: `<script>window.location.replace(${JSON.stringify(callback.href)})</script>` });
  });
}
async function signIn(page: Page, session: typeof owner, path: string) {
  await page.goto("/favicon.svg");
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "myskills_session", value: session.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await page.evaluate(value => localStorage.setItem("myskills-app:web-session", JSON.stringify(value)), { user: session.user, expiresAt: session.expiresAt });
  await page.goto(path);
}

test("GitHub app settings, browser connection and disconnect persist with user isolation", async ({ page }, info) => {
  test.setTimeout(90_000);
  await proxy(page);
  await signIn(page, owner, "/admin");
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  const admin = page.getByRole("tabpanel", { name: "GitHub", exact: true });
  await admin.getByLabel("Enable GitHub connections", { exact: true }).check();
  await admin.getByLabel("App ID", { exact: true }).fill("123456");
  await admin.getByLabel("Client ID", { exact: true }).fill("Iv1.browser-test");
  await admin.getByLabel("Client secret", { exact: true }).fill(secret);
  await admin.getByLabel("Private key", { exact: true }).fill(privateKey);
  await admin.getByLabel("Installation ID", { exact: true }).fill("77");
  await admin.getByLabel("Use installation for shared source checks", { exact: true }).check();
  failSave = true;
  await admin.getByRole("button", { name: "Save GitHub settings", exact: true }).click();
  await expect(admin.getByRole("alert")).toBeVisible();
  await expect(admin.getByLabel("Client secret", { exact: true })).toHaveValue(secret);
  failSave = false;
  await admin.getByRole("button", { name: "Save GitHub settings", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("GitHub settings saved");
  await expect(admin.getByLabel("Client secret", { exact: true })).toHaveValue("");
  await expect(admin.getByLabel("Private key", { exact: true })).toHaveValue("");
  await admin.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("Installation connection verified");
  await page.reload();
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await expect(admin.getByLabel("App ID", { exact: true })).toHaveValue("123456");
  await expect(admin.getByLabel("Client secret", { exact: true })).toHaveValue("");
  await expect(admin.getByLabel("Private key", { exact: true })).toHaveValue("");
  await admin.screenshot({ path: info.outputPath("github-admin-saved.png") });
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(secret);
  await page.goto("/settings");
  const account = page.getByRole("region", { name: "GitHub connection", exact: true });
  await expect(account).toContainText("Organization installation");
  await account.getByRole("button", { name: "Connect through GitHub", exact: true }).click();
  await expect(page).toHaveURL(/\/settings(?:\?github=connected)?$/);
  await expect(account).toContainText("browser-skill-author");
  await page.reload();
  await expect(account).toContainText("browser-skill-author");
  await signIn(page, member, "/settings");
  await expect(account.getByRole("button", { name: "Connect through GitHub", exact: true })).toBeVisible();
  await expect(account).not.toContainText("browser-skill-author");
  await signIn(page, owner, "/settings?github=error");
  await expect(account.getByRole("alert")).toContainText("GitHub connection could not be completed");
  await account.getByRole("button", { name: "Disconnect GitHub", exact: true }).click();
  await expect(account.getByRole("button", { name: "Connect through GitHub", exact: true })).toBeVisible();
  await page.reload();
  await expect(account.getByRole("button", { name: "Connect through GitHub", exact: true })).toBeVisible();
  await expect(account).not.toContainText("browser-skill-author");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await account.screenshot({ path: info.outputPath("github-account-mobile.png") });
  await signIn(page, owner, "/admin");
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await admin.getByLabel("Enable GitHub connections", { exact: true }).uncheck();
  await admin.getByRole("button", { name: "Save GitHub settings", exact: true }).click();
  await expect(admin.getByRole("status")).toContainText("GitHub settings saved");
  await page.reload();
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await expect(admin.getByLabel("Enable GitHub connections", { exact: true })).not.toBeChecked();
  await expect(admin.getByLabel("Use installation for shared source checks", { exact: true })).not.toBeChecked();
  await signIn(page, unverifiedOwner, "/admin");
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await expect(admin).toContainText("MFA-verified");
  await expect(admin.getByRole("button", { name: "Save GitHub settings", exact: true })).toHaveCount(0);
  await info.attach("github-browser-receipt", { body: JSON.stringify({ realApi: true, realPostgres: true, externalGithub: "fixture", settingsPersisted: true, secretsWriteOnly: true, userIsolation: true, callbackAndDisconnect: true, mfaGuard: true, globalDisable: true }), contentType: "application/json" });
});
