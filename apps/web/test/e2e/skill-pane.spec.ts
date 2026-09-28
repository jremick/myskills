import { expect, test as base, type Locator, type Page } from "@playwright/test";

// Written before the second skill pane, from .private/skill-info-pane/test-plan.md.
// release-history.spec.ts covers exact-version URL history and keyboard picks;
// these cover long versions, missing and loading releases, copying and the use
// paths the design mockup does not show. Fixtures are synthetic.

const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await provide(errors);
    expect(errors, "uncaught page exceptions").toEqual([]);
  }, { auto: true }],
});

const LONG = "0.0.0-bootstrap.20260926t0830z.4f1c2d9e7a3b5c60d1e2f3a4";
const MIDDLE = "0.0.0-bootstrap.20260910t1200z.a12b34c56d78";
const OLDEST = "0.0.0-bootstrap.20260902t0900z.3f9e0d21b7c4";
const VERSIONS = [LONG, MIDDLE, OLDEST];
const slug = "detail-level-writer";
const codex = { name: "codex", installTarget: "codex-skill", status: "supported" };
const generic = { name: "generic", installTarget: "prompt-pack", status: "supported" };
const owner = { id: "user-owner", email: "owner@example.test", name: "Example owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: false };

interface FixtureOptions {
  latestVersion?: string | null;
  signedIn?: boolean;
  failHistory?: number;
  holdOnce?: string[];
  multiPlatform?: boolean;
}

function release(version: string, options: FixtureOptions) {
  const index = VERSIONS.indexOf(version);
  return {
    slug,
    title: "Detail Level Writer",
    summary: "Rewrites a passage at a chosen level of detail, from a short overview to a worked example.",
    version,
    lifecycleStatus: version === OLDEST ? "deprecated" : "approved",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: ["2026-09-26T08:30:00Z", "2026-09-10T12:00:00Z", "2026-09-02T09:00:00Z"][index],
    platforms: version === OLDEST ? [{ ...generic, status: "planned" }] : version === LONG && options.multiPlatform ? [codex, generic] : [codex],
    releaseNotes: `Synthetic notes for ${version}.`,
    changeKind: ["feature", "fix", "maintenance"][index],
    ...(version === LONG && options.multiPlatform ? { requiresUserAction: true } : {}),
    artifact: { sha256: ["c", "d", "e"][index]!.repeat(64), byteSize: [17300, 16900, 15200][index], contentType: "application/vnd.myskills-app.package+json" },
  };
}

async function installFixture(page: Page, options: FixtureOptions = {}) {
  const latestVersion = options.latestVersion === undefined ? LONG : options.latestVersion;
  const skill = {
    slug, title: "Detail Level Writer", summary: release(LONG, options).summary, lifecycleStatus: "approved", visibility: "public", latestVersion,
    reviewStatus: "approved", securityStatus: "passed", platforms: [codex, generic], tags: ["writing", "editing"],
    access: { canManageSharing: options.signedIn === true },
  };
  const state = {
    releaseCalls: [] as string[],
    delivered: [] as string[],
    failHistory: options.failHistory ?? 0,
    holdOnce: new Set(options.holdOnce ?? []),
    held: new Map<string, () => void>(),
  };
  if (options.signedIn) await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-27T00:00:00Z" })), owner);
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status }).catch(() => undefined);
    if (path === "/v1/me") return options.signedIn ? reply({ user: owner }) : reply({ error: { code: "UNAUTHENTICATED" } }, 401);
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/skills") return reply({ skills: [skill], nextCursor: null });
    if (path === `/v1/skills/${slug}`) return reply({ skill });
    if (path === `/v1/skills/${slug}/releases`) {
      if (state.failHistory > 0) {
        state.failHistory -= 1;
        return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable." } }, 503);
      }
      return reply({ releases: VERSIONS.map((version) => ({ ...release(version, options), id: `release-${version}`, findingCount: 0, allowedActions: [] })) });
    }
    const exact = path.match(/^\/v1\/skills\/[^/]+\/releases\/([^/]+)$/);
    if (exact) {
      const version = decodeURIComponent(exact[1]!);
      state.releaseCalls.push(version);
      if (state.holdOnce.delete(version)) await new Promise<void>((resolve) => state.held.set(version, resolve));
      await (VERSIONS.includes(version) ? reply({ release: release(version, options) }) : reply({ error: { code: "NOT_FOUND", message: "Not found." } }, 404));
      state.delivered.push(version);
      return;
    }
    if (path.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    if (path.startsWith("/v1/improvements/policies/")) return reply({ revision: null });
    if (path === "/v1/architecture-targets") return reply({ targets: [] });
    return reply({ error: { code: "NOT_FOUND", message: `Unmocked ${path}` } }, 404);
  });
  return { ...state, release: (version: string) => state.held.get(version)?.() };
}

const exportCommand = (version: string, platform: string) => `myskills export '${slug}' --version '${version}' --platform '${platform}' --output './skills/${slug}'`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const card = (page: Page) => page.getByRole("region", { name: "Release", exact: true });
const versionsToggle = (page: Page) => card(page).getByRole("button", { name: /^Versions/ });
const versionsList = (page: Page) => card(page).getByRole("list", { name: "Published versions" });
const versionRow = (page: Page, version: string) => versionsList(page).getByRole("button", { name: new RegExp(`^${escape(version)}(\\s|$)`) });
const releaseHeading = (page: Page, version: string) => card(page).getByRole("heading", { name: `Release ${version}`, exact: true });
const commandCode = (page: Page) => page.locator(".command-panel code");

async function expectNoPageOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectWhole(locator: Locator, text: string, container: Locator) {
  await expect(locator).toContainText(text);
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth), "no clipped overflow").toBeLessThanOrEqual(1);
  const [box, outer] = [(await locator.boundingBox())!, (await container.boundingBox())!];
  expect(box.x).toBeGreaterThanOrEqual(outer.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
}

test("a long exact version stays whole and its command leads technical detail at desktop and mobile widths", async ({ page }, info) => {
  await installFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/skills/${slug}`);
  await expect(releaseHeading(page, LONG)).toBeVisible();
  await expect(card(page).getByText("Latest", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(card(page).getByText(/^Pinned/)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Copy version", exact: true })).toBeVisible();
  await expect(commandCode(page)).toHaveText(exportCommand(LONG, "codex"));
  await expect(page).toHaveURL(new RegExp(`/skills/${slug}$`));

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const toggle = versionsToggle(page);
    // Default pane first (Versions collapsed), for comparison with the approved design.
    if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
    await expect(versionsList(page)).toBeHidden();
    await expectWhole(releaseHeading(page, LONG), LONG, card(page));
    await expectNoPageOverflow(page);
    await page.screenshot({ path: info.outputPath(`skill-pane-default-${width}.png`), fullPage: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(versionsList(page).getByRole("button")).toHaveCount(3);
    await expect(versionRow(page, LONG)).toHaveAttribute("aria-current", "true");
    await expect(versionRow(page, OLDEST)).toContainText("Deprecated");
    await expectWhole(releaseHeading(page, LONG), LONG, card(page));
    for (const version of VERSIONS) await expectWhole(versionRow(page, version), version, card(page));
    await expectWhole(commandCode(page), `--version '${LONG}'`, card(page));
    const command = (await commandCode(page).boundingBox())!;
    for (const name of ["Release notes", "Package details"]) {
      const detail = (await card(page).getByRole("button", { name, exact: true }).boundingBox())!;
      expect(command.y + command.height, `command precedes ${name}`).toBeLessThanOrEqual(detail.y);
    }
    await expectNoPageOverflow(page);
    await page.screenshot({ path: info.outputPath(`skill-pane-versions-open-${width}.png`), fullPage: true });
  }
});

test("unavailable pins, a missing default, history retry and stale responses never substitute a release", async ({ page }) => {
  const state = await installFixture(page, { latestVersion: null, failHistory: 1, holdOnce: [OLDEST] });
  await page.goto(`/skills/${slug}?version=9.9.9`);
  await expect(releaseHeading(page, "9.9.9")).toBeVisible();
  await expect(card(page).getByText("Unavailable", { exact: true })).toBeVisible();
  await expect(card(page).getByText("This exact release is unavailable.")).toBeVisible();
  await expect(card(page).getByText("Release history is unavailable.")).toBeVisible();
  // Without a default stable release, clearing the pin must not promise a latest one.
  await expect(card(page).getByRole("button", { name: "View latest", exact: true })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await expect(commandCode(page)).toHaveCount(0);
  await expect(card(page).getByText("Released", { exact: true })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Package details", exact: true })).toHaveCount(0);
  expect(state.releaseCalls.every((version) => version === "9.9.9")).toBe(true);

  await card(page).getByRole("button", { name: "Retry release history", exact: true }).click();
  await expect(versionsToggle(page)).toBeVisible();
  await expect(releaseHeading(page, "9.9.9")).toBeVisible();
  await expect(page).toHaveURL(/\?version=9\.9\.9$/);
  await versionsToggle(page).click();
  await expect(versionsList(page).locator('[aria-current="true"]')).toHaveCount(0);
  await expect(versionsList(page).getByText("Latest", { exact: true })).toHaveCount(0);

  // The oldest release stays loading: no trust facts, chips or actions appear for it.
  await versionRow(page, OLDEST).click();
  await expect(versionsToggle(page)).toBeFocused();
  await expect(releaseHeading(page, OLDEST)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`version=${escape(OLDEST)}$`));
  await expect.poll(() => state.held.has(OLDEST)).toBe(true);
  await expect(commandCode(page)).toHaveCount(0);
  await expect(card(page).getByText("Released", { exact: true })).toHaveCount(0);
  await expect(card(page).getByText("Deprecated", { exact: true }).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText("No supported export platform", { exact: false })).toHaveCount(0);

  // Version navigation stays available while a release loads.
  await page.keyboard.press("Enter");
  await expect(versionsList(page)).toBeVisible();
  await versionRow(page, MIDDLE).click();
  await expect(commandCode(page)).toHaveText(exportCommand(MIDDLE, "codex"));
  state.release(OLDEST);
  await expect.poll(() => state.delivered.includes(OLDEST)).toBe(true);
  await expect(releaseHeading(page, MIDDLE)).toBeVisible();
  await expect(commandCode(page)).toHaveText(exportCommand(MIDDLE, "codex"));
  await expect(page).toHaveURL(new RegExp(`version=${escape(MIDDLE)}$`));
  await expect(card(page).getByText("Pinned to this version", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "View latest", exact: true })).toHaveCount(0);
  await expect(card(page).getByText("Latest", { exact: true }).filter({ visible: true })).toHaveCount(0);

  await card(page).getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/skills/${slug}$`));
  const noDefault = card(page).getByRole("heading", { name: "No default stable release" });
  await expect(noDefault).toBeVisible();
  await expect(noDefault).toBeFocused();
  await expect(commandCode(page)).toHaveCount(0);
  await expect(versionsToggle(page)).toBeVisible();
});

test("copying is exact and honest, and platform, user-action, unsupported and owner paths keep their rules", async ({ page }, info) => {
  await installFixture(page, { signedIn: true, multiPlatform: true });
  await page.addInitScript(() => {
    const target = window as unknown as { __copied: string[]; __failCopy: boolean };
    target.__copied = [];
    target.__failCopy = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { if (target.__failCopy) throw new Error("Clipboard denied"); target.__copied.push(text); } },
    });
  });
  const copied = () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/skills/${slug}`);
  const use = page.getByRole("region", { name: "Use this release" });
  await expect(use.getByText(/requires a user action/)).toBeVisible();
  const platforms = use.getByRole("group", { name: "Platform" });
  await expect(platforms.getByRole("button", { name: "codex", exact: true })).toHaveAttribute("aria-pressed", "true");
  await platforms.getByRole("button", { name: "generic", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/skills/${slug}\\?platform=generic$`));
  const expected = exportCommand(LONG, "generic");
  await expect(commandCode(page)).toHaveText(expected);

  await use.getByRole("button", { name: "Copy command", exact: true }).click();
  await expect.poll(copied).toEqual([expected]);
  await expect(use.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Copy version", exact: true }).click();
  await expect.poll(copied).toEqual([expected, LONG]);

  await page.evaluate(() => { (window as unknown as { __failCopy: boolean }).__failCopy = true; });
  await use.getByRole("button", { name: "Copied", exact: true }).click();
  await expect(use.getByText(/^Copy failed\. The command is selected/)).toBeVisible();
  await expect(use.getByRole("status").filter({ hasText: "Copy failed." })).toHaveCount(1);
  await expect(use.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(expected);
  expect(await copied()).toEqual([expected, LONG]);
  await page.screenshot({ path: info.outputPath("skill-pane-copy-failure.png"), fullPage: true });

  // Owner tools live in the Skills Manage section: Overview opens first, and
  // Manage stays locked without MFA.
  const overviewTab = page.getByRole("tab", { name: "Overview", exact: true });
  const manageTab = page.getByRole("tab", { name: "Manage", exact: true });
  await expect(overviewTab).toHaveAttribute("aria-selected", "true");
  await manageTab.click();
  await expect(page.getByText(/MFA-verified session is required/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete skill", exact: true })).toHaveCount(0);
  await overviewTab.click();

  await versionsToggle(page).click();
  await versionRow(page, OLDEST).click();
  await expect(page).toHaveURL(new RegExp(`\\?platform=generic&version=${escape(OLDEST)}$`));
  await expect(page.getByText("No supported export platform is available for this release. Export and install are unavailable.")).toBeVisible();
  await expect(commandCode(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Copy command/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Install this exact release" })).toHaveCount(0);
  await expect(card(page).getByText("Pinned to an older release", { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "View latest", exact: true })).toBeVisible();
  await expect(card(page).getByText("Deprecated", { exact: true }).filter({ visible: true })).toBeVisible();
  const details = card(page).getByRole("button", { name: "Package details", exact: true });
  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(card(page).getByText("generic · planned")).toBeVisible();
  await expect(card(page).getByText("SHA-256").locator("..")).toContainText("e".repeat(64));
  await expect(manageTab).toBeVisible();
});
