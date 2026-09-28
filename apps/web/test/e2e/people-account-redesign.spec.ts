import { expect, test, type Page } from "@playwright/test";

const date = "2026-09-27T00:00:00Z";
async function fixture(page: Page, mfaVerified = true, mfaEnabled = true) {
  const user = { id: "owner-1", name: "Example owner", email: "owner@example.test", status: "active", roles: ["owner"], emailVerified: true, mfaVerified, mfaEnabled };
  const teams = ["Writing team", "Release engineering team", "Research and evidence team with a long name"].map((name, i) => ({ id: `team-${i + 1}`, name, slug: `team-${i + 1}`, role: i === 2 ? "member" : "owner", createdAt: date, members: [{ id: `member-${i + 1}`, name: `Reviewer ${i + 1}`, email: `reviewer${i + 1}@example.test`, role: "member" }], invitations: [] }));
  const invitations = [1, 2].map(i => ({ id: `invite-${i}`, teamId: `external-${i}`, teamName: `Invited team ${i}`, email: user.email, status: "pending", createdAt: date }));
  const orgs = ["Release organization", "Read-only organization"].map((name, i) => ({ id: `org-${i + 1}`, name, slug: `org-${i + 1}`, status: "active", role: i ? "member" : "owner", currentPolicy: null, currentPolicyRevisionId: null, createdByUserId: user.id, createdAt: date, updatedAt: date }));
  let members = [{ id: "membership-1", userId: "reviewer-1", name: "Example reviewer", email: "reviewer@example.test", role: "member", status: "active", createdAt: date }];
  const token = { id: "token-1", name: "Personal CLI", tokenPrefix: "msk_example", scopes: ["skills:read"], expiresAt: null, revokedAt: null, lastUsedAt: date, createdAt: date };
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  const missing: string[] = [];
  await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-27T00:00:00Z" })), user);
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown) => route.fulfill({ json });
    if (method !== "GET") {
      const body = route.request().postData() ? route.request().postDataJSON() as Record<string, unknown> : null;
      writes.push({ path, method, body });
      if (path === "/v1/teams") { const team = { ...teams[0]!, id: "team-new", name: String(body?.name) }; teams.push(team); return reply({ team }); }
      if (/^\/v1\/teams\/team-\d\/invitations$/.test(path)) return reply({ invitation: { id: "sent-1", status: "pending", email: body?.email, createdAt: date } });
      if (path === "/v1/teams/invitations/invite-1/accept") { invitations.shift(); return reply({ invitation: { id: "invite-1", status: "accepted" } }); }
      if (path === "/v1/organizations/org-1/members/reviewer-1" && method === "DELETE") { const member = members[0]; members = []; return reply({ member }); }
      if (path === "/v1/organizations/org-1/invitations") return reply({ invitation: { id: "org-invite", ...body, status: "pending", createdAt: date } });
      if (path === "/v1/admin/registration") return reply({ registration: { mode: body?.mode } });
      if (path === "/v1/admin/api-tokens/token-1") return reply({ token: { ...token, user, revokedAt: date } });
    }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/branding" || path === "/v1/admin/branding") return reply({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/site" || path === "/v1/admin/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/teams") return reply({ teams, invitations });
    if (path === "/v1/teams/shared-skills") return reply({ teams: teams.slice(0, 2).map((team, i) => ({ team, sharingWithTeam: [{ slug: `skill-${i}`, title: `Shared skill ${i + 1}`, summary: "Reviewed team skill", latestVersion: "1.0.0", tags: [], visibility: "team", lifecycleStatus: "approved", platforms: [] }], sharedWithMe: [] })) });
    if (path === "/v1/organizations") return reply({ organizations: orgs });
    if (/^\/v1\/organizations\/org-\d$/.test(path)) return reply({ organization: orgs.find(org => path.endsWith(org.id)) });
    if (path.endsWith("/members")) return reply({ members });
    if (path.endsWith("/invitations")) return reply({ invitations: [] });
    if (path.endsWith("/policy-revisions")) return reply({ revisions: [] });
    if (path.endsWith("/teams")) return reply({ teams: [] });
    if (path === "/v1/admin/registration") return reply({ registration: { mode: "request" } });
    if (path === "/v1/admin/users") return reply({ users: [user, { ...user, id: "reviewer-1", email: "reviewer@example.test", roles: ["maintainer"] }] });
    if (path === "/v1/admin/api-tokens") return reply({ tokens: [{ ...token, user }] });
    if (path === "/v1/admin/providers") return reply({ providers: [] });
    if (path === "/v1/admin/audit") return reply({ events: [], nextCursor: null });
    if (path === "/v1/admin/sharing") return reply({ sharing: { publicVisibilityEnabled: true, authenticatedVisibilityEnabled: true, teamsEnabled: true, teamVisibilityEnabled: true, userVisibilityEnabled: true, organizationVisibilityEnabled: true } });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null }, worker: { configured: true, overdueTrackCount: 0 } });
    if (path === "/v1/auth/mfa") return reply({ mfa: { totpEnabled: mfaEnabled, recoveryCodesRemaining: mfaEnabled ? 8 : 0, factors: [] } });
    if (path === "/v1/auth/api-tokens") return reply({ tokens: [token] });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    missing.push(`${method} ${path}`);
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return { writes, missing };
}

for (const enabled of [true, false]) test(`sidebar MFA warning links to ${enabled ? "verification" : "setup"} from collapsed navigation`, async ({ page }, info) => {
  const state = await fixture(page, false, enabled);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/teams");
  const sidebar = page.getByRole("complementary", { name: "Primary navigation" });
  const warning = sidebar.getByRole("link", { name: "Set up or verify MFA", exact: true });
  await expect(warning).toHaveAttribute("href", "/settings");
  await expect(warning.getByRole("img", { name: "MFA not verified", exact: true })).toBeVisible();
  await expect(warning.getByText("MFA unverified", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("img", { name: "MFA verified", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("sidebar-mfa-warning.png") });
  await sidebar.locator(".sidebar-account").screenshot({ path: info.outputPath("mfa-warning-account.png") });
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await expect(warning).toBeVisible();
  await expect(warning.getByText("MFA unverified", { exact: true })).toBeHidden();
  await warning.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Security and access", exact: true })).toBeVisible();
  if (enabled) {
    await expect(page.getByRole("button", { name: "Sign in with MFA", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("region", { name: "MFA setup", exact: true }).getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  }
  expect(state.writes).toHaveLength(0);
  expect(state.missing).toEqual([]);
  await page.screenshot({ path: info.outputPath("mfa-destination.png") });
});

for (const width of [1280, 390]) test(`team selection keeps the correct members, sharing and invite destination at ${width}`, async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/teams");
  const row = page.getByRole("button", { name: /Release engineering team/ });
  await expect(row).toBeInViewport();
  await expect(page.getByLabel("Team name", { exact: true })).toBeHidden();
  await row.click();
  await expect(page.getByRole("heading", { name: "Release engineering team", level: 2 })).toBeFocused();
  await expect(page.getByText("Reviewer 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Reviewer 1", { exact: true })).toBeHidden();
  await expect(page.getByText("Shared skill 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  await page.getByLabel("Invite user to Release engineering team").fill("new-reviewer@example.test");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ path: "/v1/teams/team-2/invitations", body: { email: "new-reviewer@example.test" } });
  if (width === 390) { await page.getByRole("button", { name: "Back to teams", exact: true }).click(); await expect(row).toBeFocused(); }
  await page.getByRole("button", { name: "New team", exact: true }).click();
  await page.getByLabel("Team name", { exact: true }).fill("Delivery team");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]?.body).toEqual({ name: "Delivery team" });
  expect(state.missing).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("team-workspace.png"), fullPage: true });
  await info.attach("people-writes", { body: JSON.stringify(state.writes, null, 2), contentType: "application/json" });
});

test("organization phone workflow keeps invitations usable and makes member removal cancellable", async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organizations");
  const row = page.getByRole("button", { name: /Release organization/ });
  await expect(row).toBeInViewport();
  await row.click();
  await expect(page.getByRole("heading", { name: "Release organization", level: 2 })).toBeFocused();
  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  const email = page.getByLabel("Organization member email");
  await email.fill("invited@example.test");
  const bounds = await email.boundingBox();
  expect(bounds!.width).toBeGreaterThan(190);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]?.body).toEqual({ email: "invited@example.test", role: "member" });
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("reviewer@example.test");
  await expect(dialog).toContainText("Release organization");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(1);
  await expect(remove).toBeFocused();
  await remove.click();
  await dialog.getByRole("button", { name: /Remove/ }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]).toMatchObject({ method: "DELETE", path: "/v1/organizations/org-1/members/reviewer-1" });
  await page.getByRole("button", { name: "Back to organizations", exact: true }).click();
  await expect(row).toBeFocused();
  await page.getByRole("button", { name: /Read-only organization/ }).click();
  await expect(page.getByRole("button", { name: "Invite member", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeHidden();
  expect(state.missing).toEqual([]);
  await info.attach("organization-writes", { body: JSON.stringify(state.writes, null, 2), contentType: "application/json" });
});

for (const width of [1440, 390]) test(`admin sections preserve unsaved settings and guard opening registration at ${width}`, async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/admin");
  const tabs = page.getByRole("tablist");
  await expect(tabs.getByRole("tab", { name: "People", exact: true })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Instance", exact: true }).click();
  const landing = page.getByRole("switch", { name: "Show landing page", exact: true });
  await landing.click();
  await tabs.getByRole("tab", { name: "Audit", exact: true }).click();
  await tabs.getByRole("tab", { name: "Instance", exact: true }).click();
  await expect(landing).toHaveAttribute("aria-checked", "false");
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await dialog.getByRole("button", { name: /open/i }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toMatchObject({ path: "/v1/admin/registration", body: { mode: "open" } });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open", exact: true })).toBeFocused();
  await tabs.getByRole("tab", { name: "People", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(tabs.getByRole("tab", { name: "Audit", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(state.missing).toEqual([]);
  await page.screenshot({ path: info.outputPath("admin-sections.png"), fullPage: true });
});

test("settings shows local password validation without exposing an unrelated account error", async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const password = page.getByRole("region", { name: "Password", exact: true });
  await expect(password).toBeVisible();
  await password.getByLabel("Current password", { exact: true }).fill("test-current");
  await password.getByLabel("New password", { exact: true }).fill("test-new-password");
  await password.getByLabel("Confirm new password", { exact: true }).fill("different-password");
  await password.getByRole("button", { name: /change password/i }).click();
  await expect(password.getByText("Passwords do not match.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Email", exact: true })).not.toContainText("Passwords do not match.");
  expect(state.writes).toHaveLength(0);
  expect(state.missing).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("settings-local-validation.png"), fullPage: true });
});
