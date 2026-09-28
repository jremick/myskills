import { expect, test, type Page } from "@playwright/test";
import { workspaceTarget } from "../workspace-target-fixture.js";

// Written before the redesign. Existing release-history tests protect exact-version
// history; these cover the newly separated mobile inspector, role navigation,
// account access, consumer-first action order and unchanged install identity.
const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" }, { name: "generic", installTarget: "prompt-pack", status: "supported" }];
const skillRows = [
  { slug: "release-notes-helper", title: "Release Notes Helper", summary: "Turn merged changes into clear release notes.", tags: ["writing", "release"] },
  { slug: "code-review-guide", title: "Code Review Guide", summary: "Inspect correctness and maintainability before approval.", tags: ["review"] },
  { slug: "research-brief", title: "Research Brief", summary: "Gather evidence and write a concise research brief.", tags: ["research"] },
];
const artifact = { sha256: "a".repeat(64), byteSize: 4218, contentType: "application/vnd.myskills-app.package+json" };
const date = "2026-09-26T09:00:00Z";
const target = { ...workspaceTarget(), owner: { type: "user", id: "user-owner" } };

async function fixture(page: Page, options: { role?: string; anonymous?: boolean; mfa?: boolean; listError?: boolean; delayed?: boolean } = {}) {
  const user = { id: "user-owner", email: "owner@example.test", name: "Example owner", status: "active", roles: options.role === "user" ? ["user"] : [options.role ?? "owner"], emailVerified: true, mfaVerified: options.mfa !== false };
  if (!options.anonymous) await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-27T00:00:00Z" })), user);
  const skills = skillRows.map(s => ({ ...s, lifecycleStatus: "approved", visibility: "public", latestVersion: "1.2.0", reviewStatus: "approved", securityStatus: "passed", platforms, access: { canManageSharing: !options.anonymous && user.roles.includes("owner") } }));
  const release = (slug: string, version: string) => ({ ...skills.find(s => s.slug === slug), version, publishedAt: date, artifact: { ...artifact, sha256: (version === "1.0.0" ? "b" : "a").repeat(64) }, releaseNotes: version === "1.0.0" ? "Earlier concise format." : "Adds clear guidance for breaking changes.", changeKind: "feature", findingCount: 0, allowedActions: [] });
  let logoutCount = 0;
  let failList = options.listError === true;
  let releaseList: (() => void) | undefined;
  const ready = options.delayed ? new Promise<void>(resolve => { releaseList = resolve; }) : Promise.resolve();
  const installs: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/auth/logout") { logoutCount++; return reply({}); }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/skills") {
      await ready;
      if (failList) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Registry temporarily unavailable." } }, 503);
      const q = url.searchParams.get("q") ?? "";
      return reply({ skills: skills.filter(s => `${s.title} ${s.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())), nextCursor: null });
    }
    const versions = path.match(/^\/v1\/skills\/([^/]+)\/releases$/);
    if (versions) return reply({ releases: ["1.2.0", "1.0.0"].map(v => ({ ...release(versions[1]!, v), id: `release-${v}` })) });
    const version = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)$/);
    if (version) return ["1.0.0", "1.2.0"].includes(version[2]!) ? reply({ release: release(version[1]!, version[2]!) }) : reply({ error: { code: "NOT_FOUND", message: "Exact release is unavailable." } }, 404);
    const selected = path.match(/^\/v1\/skills\/([^/]+)$/);
    if (selected) return reply({ skill: skills.find(s => s.slug === selected[1]) });
    const managed = path.match(/^\/v1\/manage\/skills\/([^/]+)$/);
    if (managed) {
      const skill = skills.find(s => s.slug === managed[1]);
      if (!skill || !user.roles.includes("owner")) return reply({ error: { code: "SKILL_MANAGEMENT_ROLE_REQUIRED", message: "Skill management requires owner or maintainer permissions." } }, 403);
      return reply({ skill: { slug: skill.slug, title: skill.title, summary: skill.summary, lifecycleStatus: "approved", visibility: "public", tags: skill.tags, allowedActions: ["edit", "archive", "delete"] } });
    }
    if (path.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    if (path.startsWith("/v1/improvements/policies/")) return reply({ revision: null });
    if (path.endsWith("/sharing")) return reply({ sharing: { slug: skills[0]!.slug, title: skills[0]!.title, visibility: "public", settings: { publicVisibilityEnabled: true, authenticatedVisibilityEnabled: true, teamsEnabled: true, teamVisibilityEnabled: true, userVisibilityEnabled: true, organizationVisibilityEnabled: true }, availableTeams: [], teamGrants: [], userGrants: [], availableOrganizations: [], organizationGrants: [] } });
    if (path === "/v1/architecture-targets") return reply({ targets: [target] });
    if (path === `/v1/architecture-targets/${target.id}/operations` && method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      installs.push(body);
      return reply({ operation: { schemaVersion: 1, id: "install-1", targetId: target.id, targetGeneration: 1, action: "install", skillSlug: body.slug, toVersion: body.version, platform: body.platform, artifact, planDigest: "c".repeat(64), state: "queued", fencingToken: 1, createdAt: date, updatedAt: date }, replayed: false });
    }
    if (path === "/v1/auth/mfa") return reply({ mfa: { totpEnabled: true, recoveryCodesRemaining: 8, factors: [] } });
    if (path === "/v1/auth/api-tokens") return reply({ tokens: [] });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/organizations") return reply({ organizations: [] });
    if (path === "/v1/architectures") return reply({ architectures: [] });
    if (path === "/v1/architecture-patterns") return reply({ patterns: [] });
    return reply({ error: { code: "NOT_FOUND", message: `Unmocked ${method} ${path}` } }, 404);
  });
  return { installs, logoutCount: () => logoutCount, recoverList: () => { failList = false; }, releaseList: () => releaseList?.() };
}

const firstRow = (page: Page) => page.getByRole("link", { name: /Release Notes Helper release-notes-helper/ });
const title = (page: Page) => page.getByRole("heading", { name: "Release Notes Helper", exact: true });
const command = (page: Page) => page.getByText(/myskills export 'release-notes-helper' --version/);
const releaseCard = (page: Page) => page.getByRole("region", { name: "Release", exact: true });
const releaseHeading = (page: Page, version: string) => releaseCard(page).getByRole("heading", { name: `Release ${version}`, exact: true });
async function pickVersion(page: Page, version: string) {
  await releaseCard(page).getByRole("button", { name: /^Versions/ }).click();
  await releaseCard(page).getByRole("list", { name: "Published versions" }).getByRole("button", { name: new RegExp(`^${version.replaceAll(".", "\\.")}(\\s|$)`) }).click();
}

for (const width of [1440, 1280]) test(`exact-release workspace keeps selection and use action on screen at ${width}`, async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 900 });
  await page.goto("/registry");
  await expect(firstRow(page)).toBeVisible();
  await expect(title(page)).toBeInViewport();
  if (width === 1440) await expect(command(page)).toBeInViewport();
  const row = await firstRow(page).boundingBox();
  const detail = await title(page).boundingBox();
  expect(detail!.x).toBeGreaterThan(row!.x + row!.width);
  await expect(page.getByRole("button", { name: "Delete skill", exact: true })).toBeHidden();
  await page.screenshot({ path: test.info().outputPath(`registry-${width}.png`), fullPage: true });
});

for (const width of [1440, 390]) test(`Skills navigation is keyboard accessible and preserves legacy deep links at ${width}`, async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/settings");
  const nav = page.locator(width === 1440 ? ".side-nav" : ".mobile-nav");
  if (width === 1440) await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  const skillsLink = nav.getByRole("link", { name: "Skills", exact: true });
  await expect(skillsLink).toHaveAttribute("href", "/registry");
  if (width === 1440) await expect(skillsLink).toHaveAttribute("title", "Skills");
  for (let step = 0; step < 40 && !await skillsLink.evaluate((link) => link === document.activeElement); step++) {
    await page.keyboard.press("Tab");
  }
  await expect(skillsLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Skills", exact: true, level: 1 })).toBeVisible();
  await expect(skillsLink).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Registry", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath(`skills-navigation-${width}.png`), fullPage: true });
  await page.goto("/registry/skills/release-notes-helper?version=1.0.0");
  await expect(title(page)).toBeVisible();
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await expect(command(page)).toContainText("--version '1.0.0'");
});

test("mobile list, exact-version history and Back restore the selected row and focus", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/registry");
  await expect(firstRow(page)).toBeInViewport();
  await page.waitForLoadState("networkidle");
  await expect(title(page)).toBeHidden();
  await firstRow(page).click();
  await expect(title(page)).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper/);
  await pickVersion(page, "1.0.0");
  await expect(command(page)).toContainText("--version '1.0.0'");
  await page.reload();
  await expect(title(page)).toBeInViewport();
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await page.getByRole("button", { name: "Back to skills", exact: true }).click();
  await expect(firstRow(page)).toBeFocused();
  await expect(title(page)).toBeHidden();
  await expect(page).toHaveURL(/\/registry(?:\?|$)/);
  await page.goBack();
  await expect(title(page)).toBeVisible();
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await page.goForward();
  await expect(title(page)).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("registry-mobile-list.png"), fullPage: true });
});

for (const [role, shortcut] of [["owner", "Review"], ["admin", "Review"], ["maintainer", "Review"], ["author", "Submit"], ["user", "Connected targets"]]) test(`mobile ${role} has allowed primary work and grouped keyboard-safe More`, async ({ page }) => {
  await fixture(page, { role });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/registry");
  const nav = page.locator(".mobile-nav");
  await expect(nav.getByRole("link")).toHaveCount(3);
  for (const name of ["Libraries", "Skills", shortcut!]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  const more = page.getByRole("button", { name: "More", exact: true });
  await more.click();
  const overflow = page.locator(".mobile-more-menu");
  await expect(overflow.getByRole("link").first()).toBeFocused();
  await expect(overflow.getByText("Account", { exact: true })).toBeVisible();
  await expect(overflow.getByRole("link", { name: "Admin", exact: true })).toHaveCount(["owner", "admin"].includes(role!) ? 1 : 0);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  await expect(overflow).toBeHidden();
  await more.click();
  await page.getByLabel("Search skills", { exact: true }).click();
  await expect(overflow).toBeHidden();
});

for (const route of ["registry", "targets", "settings"]) test(`mobile account menu signs out once from ${route}`, async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/${route}`);
  const account = page.getByRole("button", { name: "Account menu", exact: true });
  await account.click();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeHidden();
  await account.click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(state.logoutCount).toBe(1);
  await expect(account).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("myskills-app:web-session"))).toBeNull();
});

test("signed-out mobile cannot see private destinations or owner actions", async ({ page }) => {
  await fixture(page, { anonymous: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/skills/release-notes-helper?version=1.0.0&platform=generic");
  await expect(title(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Manage", exact: true })).toHaveCount(0);
  await expect(page.locator(".mobile-nav").getByRole("link", { name: "Libraries", exact: true })).toHaveCount(0);
  await expect(command(page)).toContainText("--version '1.0.0' --platform 'generic'");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("registry-reader-320.png"), fullPage: true });
});

// Owner tools moved from an Overview disclosure to the Manage section; they
// stay secondary (Overview opens first) and locked without MFA.
test("owner tools stay secondary and respect the existing session MFA lock", async ({ page }) => {
  await fixture(page, { mfa: false });
  await page.goto("/skills/release-notes-helper");
  await expect(command(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Delete skill", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(page.getByText(/MFA-verified session is required/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete skill", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Sharing controls", exact: true })).toHaveCount(0);
  await expect(command(page)).toHaveCount(0);
});

test("an unavailable pinned release never becomes a different install or export", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/skills/release-notes-helper?version=9.9.9");
  await expect(releaseHeading(page, "9.9.9")).toBeVisible();
  await expect(releaseCard(page).getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(releaseCard(page).getByText("No other version was substituted.", { exact: false })).toBeVisible();
  await releaseCard(page).getByRole("button", { name: /^Versions/ }).click();
  await expect(releaseCard(page).getByRole("list", { name: "Published versions" }).getByRole("button")).toHaveCount(2);
  await expect(releaseCard(page).getByRole("list", { name: "Published versions" }).locator('[aria-current="true"]')).toHaveCount(0);
  await expect(command(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review install", exact: true })).toHaveCount(0);
  await expect(releaseCard(page).getByText("Released", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Owner controls", exact: true })).toHaveCount(0);
  expect(state.installs).toHaveLength(0);
  await releaseCard(page).getByRole("button", { name: "View latest", exact: true }).click();
  await expect(command(page)).toContainText("--version '1.2.0'");
  await expect(releaseHeading(page, "1.2.0")).toBeFocused();
});

test("platform selection and exact install preserve the selected version and confirmation", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/skills/release-notes-helper?version=1.0.0");
  await expect(command(page)).toContainText("--version '1.0.0'");
  await page.getByRole("button", { name: "generic", exact: true }).click();
  await expect(command(page)).toContainText("--platform 'generic'");
  await expect(page.getByRole("button", { name: "Review install", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "codex", exact: true }).click();
  await expect(command(page)).toContainText("--platform 'codex'");
  await page.setViewportSize({ width: 390, height: 844 });
  // Measure only after the surface has switched to its stacked layout.
  await expect(page.locator(".registry-surface")).toHaveAttribute("data-layout", "stack");
  const installTarget = page.getByRole("combobox", { name: "Target", exact: true });
  const reviewInstall = page.getByRole("button", { name: "Review install", exact: true });
  const targetBox = await installTarget.boundingBox();
  const reviewBox = await reviewInstall.boundingBox();
  expect(reviewBox!.y).toBeGreaterThanOrEqual(targetBox!.y + targetBox!.height);
  expect(reviewBox!.height).toBeGreaterThanOrEqual(44);
  await reviewInstall.click();
  expect(state.installs).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm exact install", exact: true }).click();
  await expect.poll(() => state.installs.length).toBe(1);
  expect(state.installs[0]).toMatchObject({ action: "install", slug: "release-notes-helper", version: "1.0.0", platform: "codex", idempotencyKey: expect.any(String) });
  expect(Object.keys(state.installs[0]!).sort()).toEqual(["action", "idempotencyKey", "platform", "slug", "version"]);
  await expect(page.getByRole("status").filter({ hasText: "Queued exact install" })).toBeVisible();
});

test("loading, failed list retry and empty search retain a usable registry", async ({ page }) => {
  const state = await fixture(page, { listError: true, delayed: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/registry");
  await expect(page.getByLabel("Search skills", { exact: true })).toBeVisible();
  await expect(firstRow(page)).toHaveCount(0);
  state.releaseList();
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  state.recoverList();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(firstRow(page)).toBeVisible();
  await page.getByLabel("Search skills", { exact: true }).fill("no-match");
  await expect(page.getByText("No skills found.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu", exact: true })).toBeVisible();
});
