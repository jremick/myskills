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
  await page.getByText("Release notes for 0.2.0", { exact: true }).click();
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  const selector = page.getByRole("combobox", { name: "Release version" });
  await expect(selector).toHaveValue("0.2.0");
  await expect(page.getByRole("option", { name: /0\.3\.0/ })).toHaveCount(0);

  await selector.selectOption("0.1.0");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(page.getByText("SHA-256").locator("..")).toContainText("b".repeat(64));
  await expect(page.getByText(/myskills export 'release-notes-helper' --version '0\.1\.0' --platform 'generic'/)).toBeVisible();

  await page.reload();
  await page.getByText("Release notes for 0.1.0", { exact: true }).click();
  await expect(selector).toHaveValue("0.1.0");
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing$/);
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();

  await page.goBack();
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await selector.focus();
  await expect(selector).toBeFocused();
  await selector.press("ArrowDown");
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(selector).toBeFocused();
  await selector.press("ArrowUp");
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(selector).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.2\.0$/);

  await page.setViewportSize({ width: 375, height: 812 });
  await selector.scrollIntoViewIfNeeded();
  await expect(selector).toBeVisible();
  await expect(selector).toBeInViewport();
  await selector.focus();
  await expect(selector).toBeFocused();
  await selector.press("ArrowDown");
  await expect(selector).toHaveValue("0.1.0");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(selector).toBeFocused();
  await expect(page.getByText("SHA-256").locator("..")).toContainText("b".repeat(64));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await selector.press("ArrowUp");
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await expect(selector).toBeFocused();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.2\.0$/);
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
  const selector = page.getByRole("combobox", { name: "Release version", exact: true });
  await expect(selector.locator(`option[value="${versions[0]}"]`)).toHaveText("Initial import · 118b105a185a (latest)");
  await expect(selector.locator(`option[value="${versions[1]}"]`)).toHaveText("Initial import · 118b105a185b");
  await expect(page.locator(".registry-version-chip").first()).toHaveText("Initial import");
  await selector.selectOption(versions[1]);
  await expect(page).toHaveURL(new RegExp(`version=${versions[1].replaceAll(".", "\\.")}$`));
  await expect(page.getByText("Exact version", { exact: true }).locator("..")).toContainText(versions[1]);
  await expect(page.getByText(`Release notes for Initial import`, { exact: true })).toBeVisible();
  await expect(page.locator(".registry-command-row code")).toContainText(`--version '${versions[1]}'`);
  await page.reload();
  await expect(selector).toHaveValue(versions[1]);
  await page.setViewportSize({ width: 390, height: 844 });
  await selector.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("bootstrap-release-mobile.png"), fullPage: true });
  await selector.selectOption("0.2.0");
  await expect(selector.locator('option[value="0.2.0"]')).toHaveText("0.2.0");
  await expect(page.getByText("Release notes for 0.2.0", { exact: true })).toBeVisible();
  await expect(page.getByText("Exact version", { exact: true })).toHaveCount(0);
});
