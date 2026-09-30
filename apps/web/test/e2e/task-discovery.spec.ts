import { expect, test } from "@playwright/test";

// Before implementation: keyboard/mobile task search, exact-release link,
// method/uncertainty, no-match and retained ordinary search; no mutation.
// Synthetic route fixture proves browser interaction, not API authorization.
const skill = { slug: "release-notes", title: "Release notes", summary: "Write release notes from merged changes.", visibility: "public", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", latestVersion: "1.0.0", platforms: [], tags: [] };
const discovery = { schemaVersion: 1, method: "lexical-v1", fallback: "ordinary-search-available", provider: { status: "disabled", calls: 0, reportedCost: 0 }, catalog: { limit: 500, truncated: false }, taskTermsTruncated: false, uncertainty: ["Word overlap does not establish quality, trust, permission to execute or task success."], results: [{ skill, release: { slug: skill.slug, version: "1.0.0", sha256: "a".repeat(64), reviewStatus: "approved", securityStatus: "passed" }, relevance: { score: 0.8, matchedTerms: ["release", "notes"], label: "strong-word-overlap" } }] };

for (const width of [1440, 390]) test(`task discovery keeps exact releases and ordinary search at ${width}`, async ({ page }, info) => {
  const mutations: string[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() !== "GET" && path !== "/v1/skills/discover") mutations.push(path);
    if (path === "/v1/skills/discover") {
      expect(request.method()).toBe("POST");
      return reply(request.postDataJSON().task.includes("telescope") ? { ...discovery, results: [] } : discovery);
    }
    if (path === "/v1/auth/session") return reply({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: false } });
    if (path === "/v1/branding") return reply({ branding: { mode: "default", text: "MySkills", image: null } });
    if (path === "/v1/capabilities") return reply({});
    if (path === "/v1/skills") return reply({ skills: [skill], nextCursor: null });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.setViewportSize({ width, height: 900 }); await page.goto("/registry");
  await page.getByText("Find skills for a task", { exact: true }).click();
  const input = page.getByRole("textbox", { name: "Task description" });
  await input.focus(); await page.keyboard.type("Write release notes from merged changes");
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "Find relevant skills" })).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Task discovery results" });
  await expect(panel.getByRole("link", { name: "Release notes · 1.0.0" })).toHaveAttribute("href", "/skills/release-notes?version=1.0.0");
  await expect(panel).toContainText("Word overlap"); await expect(panel).toContainText("lexical-v1");
  await expect(panel).toContainText("No model calls");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`task-discovery-${width}.png`), fullPage: true });
  await input.fill("Calibrate a telescope");
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Find relevant skills" }).click();
  await expect(panel).toContainText("No useful word matches");
  await expect(page.getByRole("textbox", { name: "Search skills", exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
  await info.attach("task-discovery-browser-proof", { body: JSON.stringify({ width, scope: "synthetic browser fixture", mutations, method: "lexical-v1", exactRelease: "release-notes@1.0.0" }, null, 2), contentType: "application/json" });
});
