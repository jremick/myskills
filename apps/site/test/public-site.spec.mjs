/* global innerWidth, document, getComputedStyle */
import { expect, test } from "@playwright/test";
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repo = new URL("../../../", import.meta.url);
const github = "https://github.com/jremick/myskills";
const routes = ["/", "/setup/", "/docs/", "/examples/", "/downloads/", "/security/"];
const evidenceDate = new Date().toISOString().slice(0, 10);

test("newcomer follows a truthful example into the local evaluation setup", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("MySkills");
  await expect(page.getByText("Public beta", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".hero-promise")).toHaveText("Compose your AI’s skill set.Govern its lifecycle.");
  await expect(page.locator(".hero-summary")).toContainText("profiles and environments");
  await expect(page.getByText(/Composed workspace rollout is still being verified/)).toBeVisible();
  await expect(page.getByText(/Live host recognition and consent need separate acceptance/)).toBeVisible();
  await expect(page.getByText("Excerpt from a public example package", { exact: true })).toBeVisible();
  const source = await readFile(new URL("examples/skills/release-notes-helper/SKILL.md", repo), "utf8");
  const excerpt = await page.locator("#skill-excerpt").innerText();
  expect(source).toContain(excerpt.trim());
  await page.getByRole("link", { name: "Run the local demo", exact: true }).first().click();
  await expect(page).toHaveURL(/\/setup\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run MySkills locally.");
  await expect(page.getByText(/Docker with Compose/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Canonical getting started guide" })).toHaveAttribute("href", `${github}/blob/main/docs/GETTING_STARTED.md`);
  await expect(page.getByText(/Do not reuse local seed credentials/)).toBeVisible();
  const clone = page.locator("#clone-commands");
  await page.getByRole("button", { name: "Copy clone commands" }).click();
  await expect(page.getByRole("status")).toHaveText("Clone commands copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await clone.innerText());
  await expect(page.getByRole("link", { name: "Production deployment guide", exact: true })).toBeVisible();
});

test("navigation is usable by keyboard, including menu focus and skip link", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (testInfo.project.name === "mobile") {
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Enter");
  }
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Docs", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/docs\/$/);
  if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("aria-current", "page");
});

test("six static surfaces resolve their local links and canonical source references without app requests", async ({ page }) => {
  const network = [];
  const errors = [];
  page.on("request", (request) => network.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  const checked = new Set();
  for (const path of routes) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")));
    for (const href of links) {
      if (href.startsWith("/") || href.startsWith("#")) {
        const url = new URL(href, page.url());
        if (!checked.has(url.pathname)) {
          expect((await page.request.get(url.pathname)).status(), url.pathname).toBe(200);
          checked.add(url.pathname);
        }
        if (url.hash && url.pathname === path) {
          await expect(page.locator(`[id="${decodeURIComponent(url.hash.slice(1))}"]`)).toHaveCount(1);
        }
      }
      if (href.startsWith(`${github}/blob/main/`) || href.startsWith(`${github}/tree/main/`)) {
        const relative = href.split("/main/")[1].split("#")[0];
        await access(fileURLToPath(new URL(relative, repo)));
      }
    }
  }
  expect(errors).toEqual([]);
  expect(network.every((url) => new URL(url).hostname === "127.0.0.1")).toBe(true);
  expect(network.some((url) => /\/api\/|\/v1\//.test(url))).toBe(false);
});

test("gallery presents real public examples and exact source references", async ({ page }) => {
  await page.goto("/examples/");
  for (const slug of ["release-notes-helper", "app-environment-reviewer", "model-guidance-reviewer"]) {
    const manifest = JSON.parse(await readFile(new URL(`examples/skills/${slug}/skill.json`, repo), "utf8"));
    const section = page.locator(`#${slug}`);
    await expect(section.getByRole("heading")).toHaveText(manifest.title);
    await expect(section).toContainText(manifest.summary);
    await expect(section).toContainText(manifest.version);
    await expect(section).toContainText("Codex");
    await expect(section.getByRole("link", { name: "Read SKILL.md" })).toHaveAttribute("href", `${github}/blob/main/examples/skills/${slug}/SKILL.md`);
    await expect(section.getByRole("link", { name: "View package" })).toHaveAttribute("href", `${github}/tree/main/examples/skills/${slug}`);
    await section.getByText("Preview the instructions", { exact: true }).click();
    const instructions = await readFile(new URL(`examples/skills/${slug}/SKILL.md`, repo), "utf8");
    expect(await section.locator("details pre").innerText()).toBe(instructions.replace(/^---\n[\s\S]*?\n---\n\s*/, "").trim());
  }
});

test("release status separates verified prerelease, source version, and deployment", async ({ page }) => {
  const sourceVersion = JSON.parse(await readFile(new URL("package.json", repo), "utf8")).version;
  await page.goto("/downloads/");
  await expect(page.getByText("v0.1.0-beta.17", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(sourceVersion, { exact: true })).toBeVisible();
  await expect(page.getByText(/2026-09-29/).first()).toBeVisible();
  await expect(page.getByText(/does not confirm a running instance/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open verified GitHub release" })).toHaveAttribute("href", `${github}/releases/tag/v0.1.0-beta.17`);
  await page.getByRole("link", { name: "Security and reporting", exact: true }).click();
  await expect(page.getByRole("link", { name: "Report a vulnerability privately" })).toHaveAttribute("href", `${github}/security/advisories/new`);
  await expect(page.getByText(/Do not open a public issue/)).toBeVisible();
});

test("desktop and mobile rendering has readable contrast, fitting layout, and dated evidence", async ({ page }, testInfo) => {
  const receipts = [];
  for (const path of routes) {
    await page.goto(path);
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    expect(layout.width, path).toBeLessThanOrEqual(layout.viewport);
    const contrast = await page.locator("main").evaluate((main) => {
      const rgb = (color) => color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      const luminance = (channels) => channels.map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      return [...main.querySelectorAll("h1,h2,h3,p,li,a,code,button,dt,dd,summary,figcaption")].filter((element) => element.getClientRects().length && element.textContent.trim()).map((element) => {
        const style = getComputedStyle(element);
        let parent = element;
        let background;
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") { background = rgb(color); break; }
          parent = parent.parentElement;
        }
        const foreground = rgb(style.color);
        const a = luminance(foreground), b = luminance(background ?? [255, 255, 255]);
        return { text: element.textContent.trim().slice(0, 50), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
    });
    expect(contrast.filter((item) => item.ratio < 4.5), path).toEqual([]);
    const firstAction = page.locator("main a").first();
    await firstAction.focus();
    expect(await firstAction.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    const name = path === "/" ? "home" : path.replaceAll("/", "");
    await page.screenshot({ path: testInfo.outputPath(`${evidenceDate}-utc-local-${name}-viewport.png`) });
    await page.screenshot({ path: testInfo.outputPath(`${evidenceDate}-utc-local-${name}-full.png`), fullPage: true });
    receipts.push({ route: path, layout, minTextContrast: Math.min(...contrast.map((item) => item.ratio)) });
  }
  const evidencePath = testInfo.outputPath(`${evidenceDate}-utc-local-site-evidence.json`);
  const build = JSON.parse(await readFile(new URL("../dist/site-build.json", import.meta.url), "utf8"));
  await writeFile(evidencePath, JSON.stringify({ capturedAt: new Date().toISOString(), scope: "Local static site rendering only; no application, release, package-registry, provider, or deployment proof.", project: testInfo.project.name, build, receipts }, null, 2));
  await testInfo.attach("local-static-site-evidence", { path: evidencePath, contentType: "application/json" });
});
