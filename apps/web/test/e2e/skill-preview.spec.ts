import { expect, test as base, type Page } from "@playwright/test";

// Synthetic public registry fixtures follow registry-redesign.spec.ts. These
// browser checks cover the preview interaction; API authorization is tested
// separately and is not established by a mocked bundle response.
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await provide(errors);
    expect(errors, "uncaught page exceptions").toEqual([]);
  }, { auto: true }],
});

const slug = "release-notes-helper";
const title = "Release Notes Helper";
const platforms = [
  { name: "codex", installTarget: "codex-skill", status: "supported" },
  { name: "generic", installTarget: "prompt-pack", status: "supported" },
];
const skill = {
  slug, title, summary: "Turn merged changes into clear release notes.",
  tags: ["writing", "release"], lifecycleStatus: "approved", visibility: "public",
  latestVersion: "1.2.0", reviewStatus: "approved", securityStatus: "passed", platforms,
  access: { canManageSharing: false },
};
const markdown = [
  "---", "name: release-notes-helper", "description: Write release notes from verified changes", "---", "",
  "# Release notes workflow", "", "Read the changes and write **clear release notes**.", "",
  "## Check the evidence", "", "- Review merged changes", "- Call out breaking changes", "",
  "```sh", "myskills export release-notes-helper --version 1.0.0", "```", "",
  "| Change | Audience |", "| --- | --- |", "| Fixed export | Skill authors |", "",
  "[Public guide](https://example.test/guide)", "",
  "[Package reference](references/checklist.md)", "",
  "[Unsafe link](javascript:window.__previewUnsafe=true)", "",
  "![Tracking illustration](https://preview-image.example.test/markdown.png)", "",
  '<img src="https://preview-image.example.test/raw.png" onerror="window.__previewUnsafe=true">', "",
  '<script>window.__previewUnsafe=true</script>', "",
  '<iframe src="https://preview-image.example.test/frame"></iframe>',
].join("\n");

interface BundleResponse {
  files: Array<{ path: string; content: string }>;
  status?: number;
  hold?: boolean;
}

async function fixture(page: Page) {
  const state = {
    bundleRequests: [] as string[],
    delivered: [] as number[],
    mutations: [] as string[],
    blockedImageRequests: [] as string[],
    next: { files: [{ path: "SKILL.md", content: markdown }] } as BundleResponse,
    held: new Map<number, () => void>(),
  };
  await page.route("https://preview-image.example.test/**", async route => {
    state.blockedImageRequests.push(route.request().url());
    await route.abort();
  });
  const release = (version: string) => ({
    ...skill, version, publishedAt: "2026-09-26T09:00:00Z",
    artifact: { sha256: (version === "1.0.0" ? "b" : "a").repeat(64), byteSize: 4218, contentType: "application/vnd.myskills-app.package+json" },
    releaseNotes: `Verified release notes for ${version}.`, changeKind: "feature", findingCount: 0, allowedActions: [],
  });
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (method !== "GET") state.mutations.push(`${method} ${path}`);
    if (path === "/v1/me") return reply({ error: { code: "UNAUTHENTICATED" } }, 401);
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/skills") return reply({ skills: [skill], nextCursor: null });
    if (path === `/v1/skills/${slug}`) return reply({ skill });
    if (path === `/v1/skills/${slug}/releases`) return reply({ releases: ["1.2.0", "1.0.0"].map(version => ({ ...release(version), id: `release-${version}` })) });
    const exact = path.match(/^\/v1\/skills\/[^/]+\/releases\/([^/]+)$/);
    if (exact) return ["1.0.0", "1.2.0"].includes(exact[1]!)
      ? reply({ release: release(exact[1]!) })
      : reply({ error: { code: "NOT_FOUND", message: "Exact release is unavailable." } }, 404);
    if (/\/releases\/[^/]+\/bundle$/.test(path)) {
      const requestIndex = state.bundleRequests.push(`${path}${url.search}`);
      // Snapshot each response before waiting so an old request cannot silently
      // receive the newer payload and make the race test pass accidentally.
      const response = { ...state.next, files: state.next.files.map(file => ({ ...file })) };
      if (response.hold) await new Promise<void>(resolve => state.held.set(requestIndex, resolve));
      await (response.status
        ? reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Skill instructions are temporarily unavailable." } }, response.status)
        : reply({ files: response.files }));
      state.delivered.push(requestIndex);
      return;
    }
    if (path.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    if (path.startsWith("/v1/improvements/policies/")) return reply({ revision: null });
    if (path === "/v1/architecture-targets") return reply({ targets: [] });
    if (path === "/v1/oauth/connector") return reply({ connector: { enabled: false, mcpUrl: null } });
    return reply({ error: { code: "NOT_FOUND", message: `Unmocked ${method} ${path}` } }, 404);
  });
  return state;
}

const card = (page: Page) => page.getByRole("region", { name: "Release", exact: true });
const trigger = (page: Page) => card(page).getByRole("button", { name: "View Skill", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: title, exact: true });
const bundlePath = (version: string, platform: string) => `/v1/skills/${slug}/releases/${version}/bundle?platform=${platform}`;
async function pickVersion(page: Page, version: string) {
  await card(page).getByRole("button", { name: /^Versions/ }).click();
  await card(page).getByRole("list", { name: "Published versions" }).getByRole("button", { name: new RegExp(`^${version.replaceAll(".", "\\.")}(\\s|$)`) }).click();
}

for (const width of [1440, 390]) test(`exact-release Markdown preview is safe and usable at ${width}`, async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
  await page.goto(`/skills/${slug}?version=1.0.0&platform=generic`);
  await expect(trigger(page)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(state.bundleRequests, "opening a release must not eagerly download its package").toEqual([]);
  await expect(card(page).locator(".registry-use-actions").getByRole("button", { name: "View Skill", exact: true })).toBeVisible();
  await trigger(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
  expect(await dialog(page).evaluate(element => element instanceof HTMLDialogElement && element.matches(":modal"))).toBe(true);
  await expect(dialog(page)).toHaveAccessibleDescription("SKILL.md · 1.0.0 · generic");
  await expect(dialog(page).getByRole("heading", { name: title, exact: true })).toBeFocused();
  await expect(dialog(page).getByRole("heading", { name: "Release notes workflow", exact: true, level: 1 })).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Check the evidence", exact: true, level: 2 })).toBeVisible();
  await expect(dialog(page).locator("pre code").filter({ hasText: "myskills export" })).toHaveText("myskills export release-notes-helper --version 1.0.0\n");
  await expect(dialog(page).getByRole("table")).toContainText("Fixed export");
  await expect(dialog(page).locator("strong")).toHaveText("clear release notes");
  expect(state.bundleRequests).toEqual([bundlePath("1.0.0", "generic")]);
  await expect(dialog(page).locator("img, iframe, script")).toHaveCount(0);
  await expect(dialog(page).getByRole("link", { name: "Package reference" })).toHaveCount(0);
  await expect(dialog(page).getByRole("link", { name: "Unsafe link" })).toHaveCount(0);
  const publicGuide = dialog(page).getByRole("link", { name: "Public guide", exact: true });
  await expect(publicGuide).toHaveAttribute("href", "https://example.test/guide");
  await expect(publicGuide).toHaveAttribute("target", "_blank");
  await expect(publicGuide).toHaveAttribute("rel", "noopener noreferrer");
  await expect(publicGuide).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(await page.evaluate(() => (window as Window & { __previewUnsafe?: boolean }).__previewUnsafe)).toBeUndefined();
  expect(state.blockedImageRequests).toEqual([]);
  await dialog(page).getByText("Skill metadata", { exact: true }).click();
  await expect(dialog(page).locator("details pre code")).toContainText("name: release-notes-helper");
  await dialog(page).getByText("Skill metadata", { exact: true }).click();

  // Native modal focus is contained while the underlying release stays inert.
  const close = dialog(page).getByRole("button", { name: "Close skill preview", exact: true });
  await close.focus();
  await trigger(page).evaluate(element => element.focus());
  await expect(close).toBeFocused();
  const tabStops = await dialog(page).locator("button, [tabindex='0'], summary, a[href]").count();
  for (let step = 0; step < tabStops + 2; step++) {
    await page.keyboard.press("Tab");
    // Native dialogs may let Tab visit browser chrome, represented by body as
    // activeElement. Background page controls must never receive that focus.
    expect(await dialog(page).evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), "Tab never reaches background page controls").toBe(true);
  }
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog(page).evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), "Shift+Tab never reaches background page controls").toBe(true);
  const bounds = (await dialog(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(width === 1440 ? 900 : 844);
  expect(await dialog(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await dialog(page).locator(".skill-preview-body").evaluate(element => { element.scrollTop = 0; });
  const screenshot = info.outputPath(`skill-preview-${width}.png`);
  await page.screenshot({ path: screenshot });
  await info.attach(`skill-preview-${width}`, { path: screenshot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Release notes workflow", exact: true })).toBeVisible();
  await dialog(page).getByRole("button", { name: "Close skill preview", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(state.mutations).toEqual([]);
});

test("selecting a historical release and another platform previews only that exact package", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/skills/${slug}`);
  await expect(trigger(page)).toBeVisible();
  await pickVersion(page, "1.0.0");
  await card(page).getByRole("button", { name: "generic", exact: true }).click();
  await page.waitForLoadState("networkidle");
  expect(state.bundleRequests).toEqual([]);
  await trigger(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Release notes workflow", exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveAccessibleDescription("SKILL.md · 1.0.0 · generic");
  expect(state.bundleRequests).toEqual([bundlePath("1.0.0", "generic")]);
  await page.keyboard.press("Escape");
  await card(page).getByRole("button", { name: "codex", exact: true }).click();
  await trigger(page).click();
  await expect(dialog(page)).toHaveAccessibleDescription("SKILL.md · 1.0.0 · codex");
  await expect.poll(() => state.bundleRequests).toEqual([bundlePath("1.0.0", "generic"), bundlePath("1.0.0", "codex")]);
});

test("closing during loading and reopening ignores the late first response", async ({ page }) => {
  const state = await fixture(page);
  state.next = { files: [{ path: "SKILL.md", content: "# Stale response" }], hold: true };
  await page.goto(`/skills/${slug}?version=1.0.0&platform=generic`);
  await trigger(page).click();
  await expect(dialog(page).getByRole("status")).toHaveText("Loading skill instructions…");
  await expect.poll(() => state.held.has(1)).toBe(true);
  await dialog(page).getByRole("button", { name: "Close skill preview", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  state.next = { files: [{ path: "SKILL.md", content: "# Current response" }] };
  await trigger(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Current response", exact: true })).toBeVisible();
  const lateResponse = page.waitForResponse(response => response.url().endsWith(bundlePath("1.0.0", "generic")));
  state.held.get(1)!();
  await (await lateResponse).finished();
  await expect.poll(() => state.delivered).toContain(1);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(dialog(page).getByRole("heading", { name: "Current response", exact: true })).toBeVisible();
  await expect(dialog(page).getByText("Stale response", { exact: true })).toHaveCount(0);
  expect(state.bundleRequests).toEqual([bundlePath("1.0.0", "generic"), bundlePath("1.0.0", "generic")]);
});

test("failed bundle fetch can be retried without changing the selected release", async ({ page }) => {
  const state = await fixture(page);
  state.next = { files: [], status: 503 };
  await page.goto(`/skills/${slug}?version=1.0.0&platform=generic`);
  await trigger(page).click();
  await expect(dialog(page).getByRole("alert")).toHaveText("Skills are not available.");
  state.next = { files: [{ path: "SKILL.md", content: "# Recovered instructions" }] };
  await dialog(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "Recovered instructions", exact: true })).toBeVisible();
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
  expect(state.bundleRequests).toEqual([bundlePath("1.0.0", "generic"), bundlePath("1.0.0", "generic")]);
  await expect(page).toHaveURL(new RegExp(`/skills/${slug}\\?version=1\\.0\\.0&platform=generic$`));
});

for (const variant of ["missing", "empty"] as const) test(`a root SKILL.md that is ${variant} has an explicit state without a fallback`, async ({ page }) => {
  const state = await fixture(page);
  state.next = { files: [
    { path: "README.md", content: "# Do not substitute README" },
    { path: "nested/SKILL.md", content: "# Do not substitute nested instructions" },
    ...(variant === "empty" ? [{ path: "SKILL.md", content: " \n\t" }] : []),
  ] };
  await page.goto(`/skills/${slug}?version=1.0.0&platform=generic`);
  await trigger(page).click();
  await expect(dialog(page).getByRole("status")).toContainText(variant === "missing" ? "does not include a root SKILL.md file" : "SKILL.md file in this release is empty");
  await expect(dialog(page).getByText(/Do not substitute/)).toHaveCount(0);
  await dialog(page).getByRole("button", { name: "Close skill preview", exact: true }).click();
  await expect(trigger(page)).toBeFocused();
});

test("Back and Forward dismiss the modal before changing the exact release", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/skills/${slug}?platform=generic`);
  await expect(trigger(page)).toBeVisible();
  await pickVersion(page, "1.0.0");
  await trigger(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Release notes workflow", exact: true })).toBeVisible();
  await page.goBack();
  await expect(card(page).getByRole("heading", { name: "Release 1.2.0", exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger(page).click();
  await expect(dialog(page)).toHaveAccessibleDescription("SKILL.md · 1.2.0 · generic");
  await expect.poll(() => state.bundleRequests).toHaveLength(2);
  await page.goForward();
  await expect(card(page).getByRole("heading", { name: "Release 1.0.0", exact: true })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  expect(state.bundleRequests).toEqual([bundlePath("1.0.0", "generic"), bundlePath("1.2.0", "generic")]);
});

test("an unavailable exact release cannot preview a substituted package", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/skills/${slug}?version=9.9.9`);
  await expect(card(page).getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.bundleRequests).toEqual([]);
});
