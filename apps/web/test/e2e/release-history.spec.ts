import { expect, test } from "@playwright/test";

const codex = { name: "codex", installTarget: "codex-skill", status: "supported" };
const generic = { name: "generic", installTarget: "prompt-pack", status: "supported" };
const skill = {
  slug: "release-notes-helper",
  title: "Release Notes Helper",
  summary: "Turns merged changes into concise release notes.",
  lifecycleStatus: "approved",
  visibility: "public",
  latestVersion: "0.2.0",
  reviewStatus: "approved",
  securityStatus: "passed",
  platforms: [codex, generic],
  tags: ["writing", "release"],
};
const latest = {
  slug: skill.slug,
  title: skill.title,
  summary: skill.summary,
  version: "0.2.0",
  lifecycleStatus: "approved",
  reviewStatus: "approved",
  securityStatus: "passed",
  publishedAt: "2026-08-12T00:00:00.000Z",
  platforms: skill.platforms,
  releaseNotes: "Current browser release notes.",
  changeKind: "feature",
  artifact: { sha256: "a".repeat(64), byteSize: 2048, contentType: "application/vnd.myskills-app.package+json" },
};
const older = {
  ...latest,
  version: "0.1.0",
  lifecycleStatus: "deprecated",
  publishedAt: "2026-05-02T00:00:00.000Z",
  platforms: [generic],
  releaseNotes: "Earlier browser release notes.",
  changeKind: "fix",
  artifact: { ...latest.artifact, sha256: "b".repeat(64), byteSize: 513 },
};

function summary(release: typeof latest) {
  return { ...release, id: `release-${release.version}`, findingCount: 0, allowedActions: [] };
}

test("selecting an older release survives its exact URL and browser history", async ({ page }) => {
  await page.route(/\/api\/v1\/skills(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ skills: [skill], nextCursor: null }) });
  });
  await page.route("**/api/v1/skills/release-notes-helper", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ skill }) });
  });
  await page.route("**/api/v1/skills/release-notes-helper/releases", async (route) => {
    const hidden = { ...summary(latest), id: "manager-only", version: "0.3.0", lifecycleStatus: "draft", reviewStatus: "pending", securityStatus: "pending", publishedAt: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ releases: [summary(older), hidden, summary(latest)] }) });
  });
  await page.route("**/api/v1/skills/release-notes-helper/releases/0.2.0", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ release: latest }) });
  });
  await page.route("**/api/v1/skills/release-notes-helper/releases/0.1.0", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ release: older }) });
  });

  await page.goto("/skills/release-notes-helper?q=writing");
  const card = page.getByRole("region", { name: "Release", exact: true });
  const heading = (version: string) => card.getByRole("heading", { name: `Release ${version}`, exact: true });
  const toggle = card.getByRole("button", { name: /^Versions/ });
  const list = card.getByRole("list", { name: "Published versions" });
  const row = (version: string) => list.getByRole("button", { name: new RegExp(`^${version.replaceAll(".", "\\.")}(\\s|$)`) });
  const command = page.locator(".command-panel code");
  const exported = (version: string, platform: string) => `myskills export 'release-notes-helper' --version '${version}' --platform '${platform}' --output './skills/release-notes-helper'`;
  await card.getByRole("button", { name: "Release notes", exact: true }).click();
  await card.getByRole("button", { name: "Package details", exact: true }).click();
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(heading("0.2.0")).toBeVisible();
  await expect(card.getByText(/^Pinned/)).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(list.getByRole("button")).toHaveCount(2);
  await expect(row("0.3.0")).toHaveCount(0);
  await expect(row("0.2.0")).toHaveAttribute("aria-current", "true");
  await expect(row("0.2.0")).toContainText("Latest");
  await expect(row("0.1.0")).toContainText("Deprecated");

  await row("0.1.0").click();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  // Disclosure preferences carry to the newly selected release.
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(card.getByText("SHA-256").locator("..")).toContainText("b".repeat(64));
  await expect(card.getByText("Pinned to an older release", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "View latest", exact: true })).toBeVisible();
  await expect(card.getByText("Deprecated", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(command).toHaveText(exported("0.1.0", "generic"));
  await expect(card.getByRole("button", { name: "codex", exact: true })).toHaveCount(0);

  await page.reload();
  await expect(heading("0.1.0")).toBeVisible();
  await card.getByRole("button", { name: "Release notes", exact: true }).click();
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing$/);
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(heading("0.2.0")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();

  // Keyboard: Escape closes without a change, arrows move between rows, and
  // picking the latest pins it without claiming it follows later releases.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(row("0.2.0")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page).toHaveURL(/version=0\.1\.0$/);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await expect(row("0.1.0")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row("0.2.0")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.2\.0$/);
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(card.getByText("Pinned to this version", { exact: true })).toBeVisible();
  await expect(card.getByText("Latest", { exact: true }).filter({ visible: true })).toBeVisible();
  await card.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic$/);
  await expect(heading("0.2.0")).toBeFocused();
  await expect(card.getByText(/^Pinned/)).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeInViewport();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await expect(row("0.1.0")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(card.getByText("SHA-256").locator("..")).toContainText("b".repeat(64));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await card.getByRole("button", { name: "View latest", exact: true }).click();
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(heading("0.2.0")).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic$/);
});

// Protect readable imported versions without changing exact URL/export identity.
// Two imports deliberately share their first six hash characters.
test("bootstrap releases have distinct display labels and retain exact pins", async ({ page }, info) => {
  const versions = ["0.0.0-bootstrap.118b105a185a", "0.0.0-bootstrap.118b105a185b"];
  const imports = versions.map((version, i) => ({ ...latest, version, publishedAt: `2026-08-${31 - i}T00:00:00.000Z` }));
  const importedSkill = { ...skill, latestVersion: versions[0] };
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/skills") return route.fulfill({ json: { skills: [importedSkill], nextCursor: null } });
    if (path === `/api/v1/skills/${skill.slug}`) return route.fulfill({ json: { skill: importedSkill } });
    if (path === `/api/v1/skills/${skill.slug}/releases`) return route.fulfill({ json: { releases: [...imports.map(summary), summary(latest)] } });
    const release = [...imports, latest].find(item => path === `/api/v1/skills/${skill.slug}/releases/${item.version}`);
    if (release) return route.fulfill({ json: { release } });
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  await page.goto(`/skills/${skill.slug}`);
  const card = page.getByRole("region", { name: "Release", exact: true });
  const toggle = card.getByRole("button", { name: /^Versions/ });
  const list = card.getByRole("list", { name: "Published versions" });
  await toggle.click();
  const firstImport = list.getByRole("button", { name: /^Initial import · 118b105a185a/ });
  const secondImport = list.getByRole("button", { name: /^Initial import · 118b105a185b/ });
  await expect(firstImport).toContainText("Latest");
  await expect(secondImport).toBeVisible();
  await expect(page.locator(".registry-version-chip").first()).toHaveText("Initial import");
  await secondImport.click();
  await expect(page).toHaveURL(new RegExp(`version=${versions[1].replaceAll(".", "\\.")}$`));
  await card.getByRole("button", { name: "Package details", exact: true }).click();
  await expect(card.getByText("Exact version", { exact: true }).locator("..")).toContainText(versions[1]);
  await expect(card.getByRole("heading", { name: "Release Initial import", exact: true })).toHaveAttribute("title", versions[1]);
  await expect(page.locator(".registry-command code")).toContainText(`--version '${versions[1]}'`);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { document.body.dataset.copiedVersion = text; } } }));
  await card.getByRole("button", { name: "Copy version", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-copied-version", versions[1]);
  await page.reload();
  await toggle.click();
  await expect(secondImport).toHaveAttribute("aria-current", "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("bootstrap-release-mobile.png"), fullPage: true });
  await list.getByRole("button", { name: /^0\.2\.0/ }).click();
  await expect(card.getByRole("heading", { name: "Release 0.2.0", exact: true })).toBeVisible();
  await expect(card.getByText("Exact version", { exact: true })).toHaveCount(0);
});
