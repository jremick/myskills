import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Written before the component. These fixtures exercise the real browser and
// exact bundle client, not persistence or full-stack release acceptance.
const slug = "comparison-helper";
const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" }];
const before = "Café 🧭\r\n<script>window.packageExecuted = true</script>\r\nOld guidance\r\n";
const after = "Café 🧭\r\n<script>window.packageExecuted = true</script>\r\nNew guidance\r\n";
const large = "x".repeat(140_000);
const filesFor = (version: string) => [
  { path: "skill.json", content: JSON.stringify({ name: slug, title: "Comparison Helper", summary: "Compare exact package releases.", version, license: "MIT", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }], tags: [] }) },
  { path: "SKILL.md", content: "# Comparison helper\nUse the supporting files.\n" },
  { path: "docs/shared.txt", content: version === "1.0.0" ? before : after },
  { path: "examples/shared.txt", content: "Same basename, separate complete path.\n" },
  { path: "docs/line-endings.txt", content: version === "1.0.0" ? "Identical words\r\n" : "Identical words\n" },
  { path: "docs/large.txt", content: `${large}${version === "1.0.0" ? "OLD TAIL" : "NEW TAIL"}` },
  version === "1.0.0" ? { path: "docs/retired.md", content: "Retired example\n" } : { path: "scripts/new.sh", content: "echo 'New supporting file'\n" },
].sort((a, b) => a.path.localeCompare(b.path));
type Bundle = { files: ReturnType<typeof filesFor> };
const bundleFor = (version: string): Bundle => ({ files: filesFor(version) });
const artifactFor = (bundle: Bundle) => ({ sha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex"), byteSize: Buffer.byteLength(JSON.stringify(bundle)), contentType: "application/vnd.myskills-app.package+json" });
const releaseFor = (version: string, bundle = bundleFor(version)) => ({ id: `${slug}-${version}`, slug, title: "Comparison Helper", summary: "Compare exact package releases.", version, lifecycleStatus: version === "1.0.0" ? "deprecated" : "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-20T00:00:00Z", platforms, artifact: artifactFor(bundle), findingCount: 0, allowedActions: [], releaseNotes: `Notes for ${version}.` });

async function fixture(page: Page, options: { manager?: boolean; identityMismatch?: boolean; digestMismatch?: boolean; delayTarget?: boolean } = {}) {
  const reads: string[] = [];
  const user = { id: "comparison-owner", email: "owner@example.test", name: "Comparison Owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  if (options.manager) await page.addInitScript(u => {
    if (sessionStorage.getItem("comparison-session-initialized")) return;
    localStorage.setItem("myskills-app:web-session", JSON.stringify({ user: u, expiresAt: "2027-09-27T00:00:00Z" }));
    sessionStorage.setItem("comparison-session-initialized", "true");
  }, user);
  const bundles = new Map(["1.0.0", "2.0.0", "3.0.0"].map(version => [version, bundleFor(version)]));
  if (options.identityMismatch) bundles.get("2.0.0")!.files.find(file => file.path === "skill.json")!.content = JSON.stringify({ name: "other-skill", version: "2.0.0" });
  const releases = [...bundles].map(([version, bundle]) => releaseFor(version, bundle));
  const draft = { ...releaseFor("4.0.0"), lifecycleStatus: "draft", publishedAt: null };
  const skill = { slug, title: "Comparison Helper", summary: "Compare exact package releases.", lifecycleStatus: "approved", visibility: "public", latestVersion: "2.0.0", reviewStatus: "approved", securityStatus: "passed", platforms, tags: [], access: { canManageSharing: options.manager === true, reasons: ["public"] } };
  const otherSkill = { ...skill, slug: "another-helper", title: "Another Helper", access: { canManageSharing: false, reasons: ["public"] } };
  const otherReleases = releases.map(release => ({ ...release, id: `another-${release.version}`, slug: otherSkill.slug, title: otherSkill.title }));
  let failTarget = false;
  let unblock: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  await page.route("**/api/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    reads.push(path);
    if (path === "/api/v1/me") return route.fulfill({ json: { user } });
    if (path === "/api/v1/auth/logout") return route.fulfill({ json: { ok: true } });
    if (path === "/api/v1/skills") return route.fulfill({ json: { skills: [skill, otherSkill], nextCursor: null } });
    if (path === `/api/v1/skills/${slug}`) return route.fulfill({ json: { skill } });
    if (path === `/api/v1/manage/skills/${slug}`) return route.fulfill({ json: { skill: { ...skill, allowedActions: ["edit"] } } });
    if (path === `/api/v1/skills/${slug}/releases`) return route.fulfill({ json: { releases: options.manager ? [...releases, draft] : releases } });
    if (path === `/api/v1/skills/${otherSkill.slug}`) return route.fulfill({ json: { skill: otherSkill } });
    if (path === `/api/v1/skills/${otherSkill.slug}/releases`) return route.fulfill({ json: { releases: otherReleases } });
    const version = path.split("/")[6];
    if (path === `/api/v1/skills/${otherSkill.slug}/releases/${version}`) return route.fulfill({ json: { release: otherReleases.find(item => item.version === version) } });
    const release = releases.find(item => item.version === version);
    if (path === `/api/v1/skills/${slug}/releases/${version}` && release) return route.fulfill({ json: { release } });
    if (path === `/api/v1/skills/${slug}/releases/${version}/bundle` && release) {
      if (version === "2.0.0" && options.delayTarget) await gate;
      if (version === "2.0.0" && failTarget) return route.fulfill({ status: 404, json: { error: { code: "RELEASE_NOT_FOUND", message: "Release is no longer readable." } } });
      const bundle = structuredClone(bundles.get(version)!);
      if (options.digestMismatch && version === "2.0.0") bundle.files.find(file => file.path === "docs/shared.txt")!.content = "Wrong bytes";
      return route.fulfill({ body: JSON.stringify(bundle), contentType: "application/json" });
    }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Fixture route is unavailable." } } });
  });
  return { reads, releases, fail: () => { failTarget = true; }, unblock };
}

const comparison = (page: Page) => page.getByRole("region", { name: "Release comparison", exact: true });
async function choose(page: Page, target = "2.0.0") {
  const panel = comparison(page);
  await panel.getByLabel("Base version", { exact: true }).selectOption("1.0.0");
  await panel.getByLabel("Target version", { exact: true }).selectOption(target);
  await panel.getByRole("button", { name: "Compare releases", exact: true }).click();
}

test("compares full exact text and supporting file changes without changing the pinned URL", async ({ page }, info) => {
  const f = await fixture(page);
  await page.goto(`/skills/${slug}?tab=versions&version=1.0.0`);
  await expect(comparison(page)).toBeVisible();
  expect(f.reads.filter(path => path.endsWith("/bundle"))).toEqual([]);
  await choose(page);
  const panel = comparison(page);
  await expect(panel.getByRole("status")).toContainText("1 added · 1 removed · 4 modified · 2 unchanged");
  await expect(page).toHaveURL(`/skills/${slug}?tab=versions&version=1.0.0`);
  for (const release of f.releases.slice(0, 2)) await expect(panel).toContainText(release.artifact.sha256);
  await panel.getByLabel("Compared file", { exact: true }).selectOption("docs/shared.txt");
  expect(await panel.getByLabel("Base contents of docs/shared.txt").textContent()).toBe(before);
  expect(await panel.getByLabel("Target contents of docs/shared.txt").textContent()).toBe(after);
  expect(await page.evaluate(() => (window as Window & { packageExecuted?: boolean }).packageExecuted)).toBeUndefined();
  await expect(panel.getByLabel("Compared file").locator("option[value='examples/shared.txt']")).toHaveText("examples/shared.txt · Unchanged");
  await panel.getByLabel("Compared file").selectOption("docs/retired.md");
  await expect(panel.getByText("Absent in target release.")).toBeVisible();
  await panel.getByLabel("Compared file").selectOption("scripts/new.sh");
  await expect(panel.getByText("Absent in base release.")).toBeVisible();
  await panel.getByLabel("Compared file").selectOption("docs/large.txt");
  await expect(panel.getByText(/Preview limited/)).toHaveCount(2);
  await expect(panel.getByLabel("Compared file").locator("option[value='docs/large.txt']")).toHaveText("docs/large.txt · Modified");
  await panel.getByLabel("Compared file").selectOption("docs/shared.txt");
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("release-comparison-mobile.png"), fullPage: true });
  await page.reload();
  await expect(panel.getByLabel("Base version")).toHaveValue("");
  await expect(panel.getByLabel("Compared file")).toHaveCount(0);
  expect(f.reads.filter(path => path.endsWith("/bundle"))).toHaveLength(2);
});

for (const kind of ["identityMismatch", "digestMismatch"] as const) {
  test(`rejects ${kind === "identityMismatch" ? "a different package identity" : "mismatched package bytes"}`, async ({ page }) => {
    await fixture(page, { [kind]: true });
    await page.goto(`/skills/${slug}?tab=versions`);
    await choose(page);
    await expect(comparison(page).getByRole("alert")).toContainText(kind === "identityMismatch" ? "Package identity" : "SHA-256");
    await expect(comparison(page).getByLabel("Compared file")).toHaveCount(0);
    await expect(comparison(page).getByText(after, { exact: true })).toHaveCount(0);
  });
}

test("clears held comparison when a repeated exact fetch loses current visibility", async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/skills/${slug}?tab=versions`);
  await choose(page);
  await expect(comparison(page).getByLabel("Compared file")).toBeVisible();
  f.fail();
  await comparison(page).getByRole("button", { name: "Compare releases", exact: true }).click();
  await expect(comparison(page).getByRole("alert")).toContainText("no longer readable");
  await expect(comparison(page).getByLabel("Compared file")).toHaveCount(0);
  await expect(comparison(page).getByLabel(/contents of/)).toHaveCount(0);
});

test("ignores an old delayed target after a new exact selection", async ({ page }) => {
  const f = await fixture(page, { delayTarget: true });
  await page.goto(`/skills/${slug}?tab=versions`);
  await choose(page);
  await expect.poll(() => f.reads.filter(path => path.endsWith("/2.0.0/bundle")).length).toBe(1);
  await comparison(page).getByLabel("Target version").selectOption("3.0.0");
  await comparison(page).getByRole("button", { name: "Compare releases", exact: true }).click();
  await expect(comparison(page).getByRole("heading", { name: "Target · 3.0.0", exact: true })).toBeVisible();
  f.unblock();
  await expect(comparison(page).getByRole("heading", { name: "Target · 2.0.0", exact: true })).toHaveCount(0);
  await expect(comparison(page).getByRole("heading", { name: "Target · 3.0.0", exact: true })).toBeVisible();
});

test("changing the pinned release or selected skill discards an old delayed comparison", async ({ page }) => {
  const f = await fixture(page, { delayTarget: true });
  await page.goto(`/skills/${slug}?tab=versions&version=1.0.0`);
  await choose(page);
  await expect.poll(() => f.reads.filter(path => path.endsWith("/2.0.0/bundle")).length).toBe(1);
  await page.getByRole("list", { name: "Release history" }).getByRole("link", { name: /^3\.0\.0 / }).click();
  await expect(page).toHaveURL(/version=3\.0\.0/);
  await expect(comparison(page).getByLabel("Base version")).toHaveValue("");
  await expect(comparison(page).getByLabel("Compared file")).toHaveCount(0);
  await choose(page);
  await expect.poll(() => f.reads.filter(path => path.endsWith("/2.0.0/bundle")).length).toBe(2);
  await page.getByRole("link", { name: /^Another Helper another-helper/ }).click();
  await expect(page.getByRole("heading", { name: "Another Helper", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  f.unblock();
  await expect(comparison(page).getByLabel("Base version")).toHaveValue("");
  await expect(comparison(page).getByLabel("Compared file")).toHaveCount(0);
  await expect(comparison(page).getByRole("heading", { name: /Target ·/ })).toHaveCount(0);
});

test("signing out fences a delayed package response before returning to release history", async ({ page }) => {
  const f = await fixture(page, { manager: true, delayTarget: true });
  await page.goto(`/skills/${slug}?tab=versions`);
  await choose(page);
  await expect.poll(() => f.reads.filter(path => path.endsWith("/2.0.0/bundle")).length).toBe(1);
  await page.getByLabel("Sign out").click();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  f.unblock();
  await page.goBack();
  await expect(comparison(page).getByLabel("Base version")).toHaveValue("");
  await expect(comparison(page).getByLabel("Compared file")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("myskills-app:web-session"))).toBeNull();
});

test("management history cannot make an unpublished package comparable and signing out clears held content", async ({ page }) => {
  const f = await fixture(page, { manager: true });
  await page.goto(`/skills/${slug}?tab=versions`);
  const panel = comparison(page);
  await expect(panel.getByLabel("Target version").locator("option[value='4.0.0']")).toBeDisabled();
  await expect(panel).toContainText("Unpublished and unavailable releases cannot be compared with the existing package reader.");
  await choose(page);
  await expect(panel.getByLabel("Compared file")).toBeVisible();
  await page.getByLabel("Sign out").click();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  await page.goto(`/skills/${slug}?tab=versions`);
  await expect(panel.getByLabel("Compared file")).toHaveCount(0);
  expect(f.reads.filter(path => path.endsWith("/4.0.0/bundle"))).toEqual([]);
});
