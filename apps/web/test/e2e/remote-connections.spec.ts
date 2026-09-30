import { expect, test, type Page, type Route } from "@playwright/test";

// Mocked API responses with synthetic values. These checks prove browser
// behavior only; they are not provider, deployment or full-stack evidence.
const HANDLE = "Hq".repeat(21) + "H";
const user = { id: "user-reader", email: "reader@example.test", name: "Reader", status: "active", roles: ["user"], emailVerified: true, mfaVerified: false };
const authorization = {
  client: { id: "msc_synthetic_client_id_0001", name: "ChatGPT", registration: "dynamic", redirectUri: "https://chatgpt.example.test/connector/oauth/cb", redirectOrigin: "https://chatgpt.example.test" },
  scopes: [
    { scope: "skills:read", description: "Find skills you can access and read their release metadata, instructions and supporting text files." },
    { scope: "architectures:read", description: "View skill architectures you can access, including their structure and referenced releases." },
  ],
  resource: "https://skills.example.test/mcp",
  expiresAt: "2027-01-01T00:10:00.000Z",
  account: { email: user.email, mfaVerified: false },
  mfaRequired: false,
};

test("connection consent survives sign-in, shows the client and scopes, and returns only to the registered origin", async ({ page }, info) => {
  const writes = await mockApi(page, {});
  await page.route("https://chatgpt.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Callback</title><p>Synthetic callback reached</p>" }));

  await page.goto(`/connect/authorize#request=${HANDLE}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Connect/);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("");
  await page.getByRole("button", { name: "Sign in to continue" }).click();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("test-only-password-never-a-credential");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/connect\/authorize$/);
  await expect(page.getByRole("heading", { name: "Connect ChatGPT to MySkills" })).toBeVisible();
  await expect(page.getByText("https://chatgpt.example.test", { exact: true })).toBeVisible();
  await expect(page.getByText(/Find skills you can access/)).toBeVisible();
  await expect(page.getByText(/cannot publish, review, change or delete/i)).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain("code=");
  await page.screenshot({ path: info.outputPath("consent-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(page).toHaveURL(/^https:\/\/chatgpt\.example\.test\/connector\/oauth\/cb\?code=/);
  expect(writes.filter((write) => write.path === "/v1/oauth/consent/decision")).toEqual([{ path: "/v1/oauth/consent/decision", method: "POST", body: { request: HANDLE, decision: "approve" } }]);
  expect(writes.find((write) => write.path === "/v1/oauth/consent/inspect")?.body).toEqual({ request: HANDLE });
});

test("MFA-required consent sends the reader through MFA sign-in and back", async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user });
  await mockApi(page, { mfaRequired: true });
  await page.goto(`/connect/authorize#request=${HANDLE}`);
  await expect(page.getByText(/Sign in with MFA to approve/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toBeDisabled();
  await page.getByRole("button", { name: "Sign in with MFA" }).click();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("test-only-password-never-a-credential");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("MFA code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/connect\/authorize$/);
  await expect(page.getByRole("button", { name: "Allow access" })).toBeEnabled();
});

test("invalid and expired connection requests explain how to restart without redirecting", async ({ page }, info) => {
  await mockApi(page, { inspectStatus: 410 });
  await page.goto("/connect/authorize?error=invalid_redirect_uri");
  await expect(page.getByText(/return address/i)).toBeVisible();
  await page.screenshot({ path: info.outputPath("consent-error.png"), fullPage: true });
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user });
  await page.goto(`/connect/authorize#request=${HANDLE}`);
  await expect(page.getByText(/expired/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toHaveCount(0);
});

for (const width of [1280, 390]) test(`settings show connector setup and revoke a connection at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user });
  const writes = await mockApi(page, {});
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Remote connections" });
  await expect(section.getByText("https://skills.example.test/mcp", { exact: true })).toBeVisible();
  await expect(section.getByRole("heading", { name: "ChatGPT" })).toBeVisible();
  await expect(section.getByRole("heading", { name: "Claude" })).toBeVisible();
  await expect(section.getByText("Synthetic host app")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await section.screenshot({ path: info.outputPath(`settings-remote-connections-${width}.png`) });
  await section.getByRole("button", { name: "Revoke Synthetic host app" }).click();
  await page.getByRole("button", { name: "Revoke connection" }).click();
  await expect(section.getByText(/No remote connections/)).toBeVisible();
  expect(writes.some((write) => write.path === "/v1/oauth/connections/grant-1" && write.method === "DELETE")).toBe(true);
});

test("settings show an honest unavailable state when remote connections are not configured", async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user });
  await mockApi(page, { connectorDisabled: true });
  await page.goto("/settings");
  const section = page.getByRole("region", { name: "Remote connections" });
  await expect(section.getByText(/not enabled on this MySkills server/)).toBeVisible();
  await expect(section.locator("code")).toHaveCount(0);
});

// Failure inventory: write consent must never promise read-only access; a cached
// MFA flag must not bypass server step-up; expiry between inspect and approve
// must return through actual sign-in; token scope expansion must not broaden defaults.
test("write consent requires fresh server-confirmed MFA and survives an approval-time step-up", async ({ page }, info) => {
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user: { ...user, mfaVerified: true } });
  const writes = await mockApi(page, { writeScopes: true, expireOnApproval: true });
  await page.route("https://chatgpt.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Callback</title><p>Synthetic callback reached</p>" }));
  await page.goto(`/connect/authorize#request=${HANDLE}`);
  await expect(page.getByText(/can make the changes listed above/i)).toBeVisible();
  await expect(page.getByText(/This connection is read-only/)).toHaveCount(0);
  await expect(page.getByText(/Manage architectures you can edit/)).toBeVisible();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByText(/Verify MFA again to approve/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow access" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Set up MFA in Settings" })).toHaveAttribute("href", "/settings");
  await expect(page.getByRole("link", { name: "Set up MFA in Settings" })).toHaveAttribute("target", "_blank");
  await page.screenshot({ path: info.outputPath("write-consent-step-up.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign in with MFA" }).click();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("test-only-password-never-a-credential");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("MFA code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page).toHaveURL(/\/connect\/authorize$/);
  await expect(page.getByRole("button", { name: "Allow access" })).toBeEnabled();
  await expect(page.getByText(/can make the changes listed above/i)).toBeVisible();
  await page.getByRole("button", { name: "Allow access" }).click();
  await expect(page).toHaveURL(/^https:\/\/chatgpt\.example\.test\//);
  const verificationIndex = writes.findIndex((write) => write.path === "/v1/auth/mfa/verify");
  expect(writes.slice(verificationIndex + 1).some((write) => write.path === "/v1/oauth/consent/inspect")).toBe(true);
  expect(writes.filter((write) => write.path === "/v1/auth/mfa/verify").length).toBe(1);
});

test("API key chooser exposes application scopes and keeps its read-only default", async ({ page }, info) => {
  await page.addInitScript((stored) => localStorage.setItem("myskills-app:web-session", JSON.stringify(stored)), { expiresAt: "2027-01-01T00:00:00.000Z", user });
  const writes = await mockApi(page, {});
  await page.goto("/settings");
  const scopes = page.getByRole("group", { name: "API key scopes" });
  await expect(scopes.getByRole("checkbox")).toHaveCount(32);
  await expect(scopes.locator("input:checked")).toHaveCount(1);
  await expect(scopes.getByRole("checkbox", { name: "Read skills", exact: true })).toBeChecked();
  await scopes.getByRole("checkbox", { name: "Manage architectures", exact: true }).check();
  await scopes.getByRole("checkbox", { name: "Manage organizations", exact: true }).check();
  await scopes.getByRole("checkbox", { name: "Revoke own remote connections", exact: true }).check();
  await expect(scopes.getByRole("checkbox", { name: "Execute target updates", exact: true })).not.toBeChecked();
  await page.getByLabel("Key name").fill("Synthetic scoped client");
  await page.getByRole("button", { name: "Create key", exact: true }).click();
  await expect(page.getByText("synthetic-created-key")).toBeVisible();
  expect(writes.find((write) => write.path === "/v1/auth/api-tokens" && write.method === "POST")?.body).toEqual({
    name: "Synthetic scoped client", scopes: ["skills:read", "architectures:write", "organizations:write", "account:connections:revoke"],
  });
  await scopes.screenshot({ path: info.outputPath("application-token-scopes.png") });
});

async function mockApi(page: Page, options: { mfaRequired?: boolean; inspectStatus?: number; connectorDisabled?: boolean; writeScopes?: boolean; expireOnApproval?: boolean }) {
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  let connections = [{
    id: "grant-1",
    client: { id: "msc_synthetic_client_id_0001", name: "Synthetic host app", registration: "dynamic" },
    scopes: ["skills:read"],
    resource: "https://skills.example.test/mcp",
    createdAt: "2026-09-29T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: "2026-12-28T00:00:00.000Z",
    revokedAt: null,
  }];
  let mfaVerified = false;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const method = request.method();
    if (method !== "GET") writes.push({ path, method, body: request.postDataJSON?.() ?? null });
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/v1/site") return json({ site: { landingPageEnabled: true } });
    if (path === "/v1/branding") return json({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/auth/login") {
      return options.mfaRequired || options.expireOnApproval
        ? json({ mfaRequired: true, challengeToken: "test-only-challenge", expiresAt: "2027-01-01T00:00:00.000Z", user })
        : json({ mfaRequired: false, expiresAt: "2027-01-01T00:00:00.000Z", user });
    }
    if (path === "/v1/auth/mfa/verify") {
      mfaVerified = true;
      return json({ expiresAt: "2027-01-01T00:00:00.000Z", user: { ...user, mfaVerified: true } });
    }
    if (path === "/v1/me") return json({ user: { ...user, mfaVerified } });
    if (path === "/v1/auth/mfa") return json({ mfa: { totpEnabled: Boolean(options.mfaRequired), recoveryCodesRemaining: 8, factors: [] } });
    if (path === "/v1/auth/api-tokens") {
      if (method === "POST") return json({ token: { id: "synthetic-key", name: "Synthetic scoped client", tokenPrefix: "synthetic", scopes: request.postDataJSON().scopes, createdAt: "2026-09-29T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z", lastUsedAt: null, revokedAt: null, token: "synthetic-created-key" } });
      return json({ tokens: [] });
    }
    if (path === "/v1/oauth/connector") {
      return json({ connector: options.connectorDisabled ? { enabled: false, mcpUrl: null } : {
        enabled: true, mcpUrl: "https://skills.example.test/mcp", issuer: "https://skills.example.test", dynamicRegistration: true, scopes: authorization.scopes,
      } });
    }
    if (path === "/v1/oauth/connections" && method === "GET") return json({ connections });
    if (path === "/v1/oauth/connections/grant-1" && method === "DELETE") {
      const revoked = { ...connections[0], revokedAt: "2026-09-29T01:00:00.000Z" };
      connections = [];
      return json({ connection: revoked });
    }
    if (path === "/v1/oauth/consent/inspect") {
      if (options.inspectStatus) return json({ error: { code: "OAUTH_REQUEST_EXPIRED", message: "expired" } }, options.inspectStatus);
      return json({ authorization: { ...authorization, ...(options.writeScopes ? { scopes: [{ scope: "architectures:write", description: "Manage architectures you can edit.", readOnly: false }, { scope: "skills:read", description: "Read skills you can access.", readOnly: true }] } : {}), mfaRequired: Boolean(options.mfaRequired) && !mfaVerified, account: { email: user.email, mfaVerified } } });
    }
    if (path === "/v1/oauth/consent/decision") {
      if (options.expireOnApproval && !mfaVerified) return json({ error: { code: "MFA_VERIFICATION_REQUIRED", message: "Verify again." } }, 403);
      return json({ redirectTo: "https://chatgpt.example.test/connector/oauth/cb?code=myskills_ac.synthetic-browser-code&state=browser-state&iss=https%3A%2F%2Fskills.example.test" });
    }
    if (path.startsWith("/v1/skills") || path.startsWith("/v1/registry") || path.startsWith("/v1/bundles")) return json({ skills: [], nextCursor: null, bundles: [], groups: [] });
    return json({ error: { code: "NOT_FOUND", message: "Not mocked" } }, 404);
  });
  return writes;
}
