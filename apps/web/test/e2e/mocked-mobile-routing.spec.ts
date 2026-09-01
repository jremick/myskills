import { expect, test, type Page } from "@playwright/test";

const expiresAt = "2027-06-04T01:00:00.000Z";
const owner = {
  id: "user-owner",
  email: "owner@example.com",
  name: "Owner User",
  status: "active",
  roles: ["owner"],
  emailVerified: true,
  mfaVerified: true,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ expiresAt: storedExpiry, user }) => {
    window.localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: storedExpiry, user }));
  }, { expiresAt, user: owner });
  await installMockedRegistryRoutes(page);
});

test("route-mocked owner registry fits 320, 375, and 390 px with safe mobile overflow navigation", async ({ page }) => {
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/skills/release-notes-helper");
    await expect(page.getByRole("heading", { name: "Release Notes Helper" })).toBeVisible();
    await expect(page.locator(".mobile-nav").getByRole("link", { name: "Architectures" })).toContainText("Build");
    await expect(page.locator(".mobile-nav").getByRole("link", { name: "Connected targets" })).toContainText("Targets");

    const measurements = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>(".mobile-nav")!.getBoundingClientRect();
      return {
        bodyWidth: document.body.scrollWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        navLeft: nav.left,
        navRight: nav.right,
      };
    });
    expect(measurements.bodyWidth, `${width}px body overflow`).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.navLeft).toBeGreaterThanOrEqual(0);
    expect(measurements.navRight).toBeLessThanOrEqual(width);

    const detailBox = await page.locator(".registry-detail-panel").boundingBox();
    expect(detailBox).not.toBeNull();
    expect(detailBox!.x).toBeGreaterThanOrEqual(0);
    expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(width + 0.5);

    const more = page.getByRole("button", { name: "More" });
    await expect(more).toBeVisible();
    await more.click();
    const mobileMoreNavigation = page.locator(".mobile-more-menu");
    const firstOverflowItem = mobileMoreNavigation.getByRole("link").first();
    const adminMenuItem = mobileMoreNavigation.getByRole("link", { name: "Admin" });
    await expect(firstOverflowItem).toBeVisible();
    await expect(firstOverflowItem).toBeFocused();
    await expect(adminMenuItem).toBeVisible();
    await expect(mobileMoreNavigation.getByRole("link", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(adminMenuItem).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await expect(adminMenuItem).toBeVisible();
    await page.getByLabel("Search skills").click();
    await expect(adminMenuItem).toBeHidden();
  }
});

test("route-mocked registry uses push navigation and restores URL-backed state with Back and Forward", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/skills/release-notes-helper?q=release&platform=generic");

  await expect(page.getByLabel("Search skills")).toHaveValue("release");
  await expect(page.getByText(/--platform 'generic'/)).toBeVisible();
  await expect(page.locator(".side-nav-label")).toHaveText(["Library", "Build", "Govern", "Observe", "Account"]);
  await expect(page.locator(".side-nav").getByRole("link", { name: "Registry" })).toHaveAttribute("aria-current", "page");

  await page.getByLabel("Search skills").fill("smoke");
  await expect(page).toHaveURL(/\/skills\/smoke-skill\?q=smoke&platform=generic$/);
  await expect(page.getByRole("heading", { name: "Smoke Skill" })).toBeVisible();

  await page.locator(".side-nav").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Security and access" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/smoke-skill\?q=smoke&platform=generic$/);
  await expect(page.getByLabel("Search skills")).toHaveValue("smoke");
  await expect(page.getByRole("heading", { name: "Smoke Skill" })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Security and access" })).toBeVisible();
});

async function installMockedRegistryRoutes(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/v1/me") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: owner }) });
    }
    if (path === "/v1/skills") {
      const query = url.searchParams.get("q") ?? "";
      const skills = query === "smoke" ? [publicSkill("smoke-skill")] : [publicSkill("release-notes-helper")];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ skills }) });
    }
    const releaseMatch = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)$/);
    if (releaseMatch) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ release: publicRelease(releaseMatch[1]!) }),
      });
    }
    const skillMatch = path.match(/^\/v1\/skills\/([^/]+)$/);
    if (skillMatch) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skill: publicSkill(skillMatch[1]!) }),
      });
    }
    if (path === "/v1/auth/mfa") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mfa: { totpEnabled: true, recoveryCodesRemaining: 8, factors: [] } }),
      });
    }
    if (path === "/v1/auth/api-tokens") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tokens: [] }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "mock route missing" }) });
  });
}

function publicSkill(slug: string) {
  const smoke = slug === "smoke-skill";
  return {
    slug,
    title: smoke ? "Smoke Skill" : "Release Notes Helper",
    summary: smoke ? "Exercises browser routing history." : "Turns merged changes into concise release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [
      { name: "codex", installTarget: "codex-skill", status: "supported" },
      { name: "generic", installTarget: "prompt-pack", status: "supported" },
    ],
    tags: smoke ? ["testing"] : ["writing", "release"],
  };
}

function publicRelease(slug: string) {
  return {
    ...publicSkill(slug),
    version: "0.1.0",
    publishedAt: "2026-06-04T00:00:00.000Z",
    artifact: {
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      byteSize: 1234,
      contentType: "application/vnd.myskills-app.package+json",
    },
  };
}
