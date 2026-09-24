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
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  const selector = page.getByRole("combobox", { name: "Release version" });
  await expect(selector).toHaveValue("0.2.0");
  await expect(page.getByRole("option", { name: /0\.3\.0/ })).toHaveCount(0);

  await selector.selectOption("0.1.0");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(page.getByText("SHA-256").locator("..")).toContainText("bbbbbbbbbb…bbbbbbbb");
  await expect(page.getByText(/myskills export 'release-notes-helper' --version '0\.1\.0' --platform 'generic'/)).toBeVisible();

  await page.reload();
  await expect(selector).toHaveValue("0.1.0");
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing$/);
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goBack();
  await expect(page.getByText(latest.releaseNotes)).toBeVisible();
  await selector.scrollIntoViewIfNeeded();
  await expect(selector).toBeVisible();
  await expect(selector).toBeInViewport();
  await selector.focus();
  await expect(selector).toBeFocused();
  await selector.press("ArrowDown");
  await expect(selector).toHaveValue("0.1.0");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=writing&platform=generic&version=0\.1\.0$/);
  await expect(page.getByText(older.releaseNotes)).toBeVisible();
  await expect(page.getByText("SHA-256").locator("..")).toContainText("bbbbbbbbbb…bbbbbbbb");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
