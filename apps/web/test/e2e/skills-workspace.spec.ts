import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Written before the Skills workspace consolidation. Synthetic route fixtures
// only. These journeys protect one exact skill/version identity across scope,
// section, reload and history; one Manage lifecycle surface driven by the
// management record; authorised management-only detail for archived records;
// stale responses during fast selection; returnTo safety; and outcome links.
const date = "2026-09-20T00:00:00Z";
const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" }];
const artifact = (fill: string) => ({ sha256: fill.repeat(64), byteSize: 2048, contentType: "application/vnd.myskills-app.package+json" });
type SkillRow = { slug: string; title: string; summary: string; tags: string[]; latestVersion: string | null; owned: boolean };
const betaSkill: SkillRow = { slug: "beta-helper", title: "Beta Helper", summary: "Only a published prerelease exists.", tags: ["beta"], latestVersion: null, owned: true };
const skillRows: SkillRow[] = [
  { slug: "release-notes-helper", title: "Release Notes Helper", summary: "Turn merged changes into release notes.", tags: ["writing"], latestVersion: "1.2.0", owned: true },
  { slug: "code-review-guide", title: "Code Review Guide", summary: "Check correctness before release.", tags: ["review"], latestVersion: "2.0.0", owned: false },
];
const archived = { slug: "archived-helper", title: "Archived Helper", summary: "Kept for recovery only.", lifecycleStatus: "archived", visibility: "private", tags: [], allowedActions: ["edit", "restore", "delete"] };
type Release = { slug: string; version: string; lifecycleStatus: string; reviewStatus: string; securityStatus: string; publishedAt: string | null; sha: string; allowedActions: string[] };

interface Options { role?: "owner" | "user" | "author"; anonymous?: boolean; mfa?: boolean; slow?: string; sharingOnly?: boolean; slowManaged?: boolean; managedUnavailable?: boolean; prereleaseOnly?: boolean }

async function fixture(page: Page, options: Options = {}) {
  const role = options.role ?? "owner";
  const user = { id: "user-1", email: `${role}@example.test`, name: "Example person", status: "active", roles: [role], emailVerified: true, mfaVerified: options.mfa !== false };
  if (!options.anonymous) await page.addInitScript(u => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user: u, expiresAt: "2027-09-27T00:00:00Z" })), user);
  const manager = !options.anonymous && role === "owner";
  let releases: Release[] = [
    { slug: "release-notes-helper", version: "1.3.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: null, sha: "d", allowedActions: ["delete"] },
    { slug: "release-notes-helper", version: "1.2.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-18T00:00:00Z", sha: "a", allowedActions: ["deprecate", "unpublish", "revoke"] },
    { slug: "release-notes-helper", version: "1.0.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-08-01T00:00:00Z", sha: "b", allowedActions: ["deprecate", "unpublish", "revoke"] },
    { slug: "code-review-guide", version: "2.0.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: date, sha: "c", allowedActions: ["deprecate", "unpublish", "revoke"] },
    { slug: "archived-helper", version: "1.0.0", lifecycleStatus: "unpublished", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-07-01T00:00:00Z", sha: "e", allowedActions: ["restore", "delete"] },
    { slug: betaSkill.slug, version: "2.0.0-beta.1", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: date, sha: "9", allowedActions: ["deprecate", "unpublish", "revoke"] },
  ];
  let skills = [...skillRows, ...(options.prereleaseOnly ? [betaSkill] : [])].map(s => ({ ...s }));
  let archivedRecord = { ...archived };
  let review = { id: "sub-1", slug: "code-review-guide", title: "Code Review Guide", summary: "Check correctness before release.", version: "2.1.0", visibility: "public", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", approvedArtifactSha256: "f".repeat(64), platforms, artifact: artifact("f"), findingCount: 0, createdAt: date, publishedAt: null as string | null, allowedActions: ["publish"] };
  const published = (release: Release) => release.publishedAt !== null && ["approved", "deprecated"].includes(release.lifecycleStatus);
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const reads: string[] = [];
  // Fails every management read until recovered: the dev server's StrictMode
  // repeats mount effects, so a one-shot failure would be consumed silently.
  let managedUnavailable = options.managedUnavailable === true;
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  const managed = (slug: string) => {
    if (slug === archived.slug) return archivedRecord;
    const row = skills.find(s => s.slug === slug);
    return row ? { slug: row.slug, title: row.title, summary: row.summary, lifecycleStatus: "approved", visibility: "public", tags: row.tags, allowedActions: ["edit", "archive", "delete"] } : null;
  };
  const publicSkill = (row: typeof skills[number]) => ({ slug: row.slug, title: row.title, summary: row.summary, tags: row.tags, lifecycleStatus: "approved", visibility: "public", latestVersion: row.latestVersion, reviewStatus: "approved", securityStatus: "passed", platforms, access: { canManageSharing: !options.anonymous && (options.sharingOnly === true || (manager && row.owned)), reasons: ["public"] } });
  const summary = (release: Release, canManage: boolean) => ({ id: `${release.slug}-${release.version}`, slug: release.slug, version: release.version, lifecycleStatus: release.lifecycleStatus, reviewStatus: release.reviewStatus, securityStatus: release.securityStatus, publishedAt: release.publishedAt, platforms, releaseNotes: `Exact notes for ${release.version}.`, changeKind: "feature", artifact: artifact(release.sha), findingCount: 0, allowedActions: canManage ? release.allowedActions : [] });
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (method === "GET") reads.push(`${path}${url.search}`);
    if (options.slow && (path === `/v1/skills/${options.slow}` || path === `/v1/manage/skills/${options.slow}` || path.startsWith(`/v1/skills/${options.slow}/releases`))) await gate;
    if (method !== "GET") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ method, path, body });
      const releaseAction = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)\/actions$/);
      if (releaseAction) {
        const next = body.action === "unpublish" ? { lifecycleStatus: "unpublished", allowedActions: ["restore", "delete"] } : body.action === "restore" ? { lifecycleStatus: "approved", allowedActions: ["deprecate", "unpublish", "revoke"] } : { lifecycleStatus: String(body.action), allowedActions: [] };
        releases = releases.map(r => r.slug === releaseAction[1] && r.version === releaseAction[2] ? { ...r, ...next } : r);
        return reply({ release: summary(releases.find(r => r.slug === releaseAction[1] && r.version === releaseAction[2])!, true) });
      }
      const skillAction = path.match(/^\/v1\/skills\/([^/]+)\/actions$/);
      if (skillAction?.[1] === archived.slug && body.action === "restore") {
        archivedRecord = { ...archivedRecord, lifecycleStatus: "approved", allowedActions: ["edit", "archive", "delete"] };
        return reply({ skill: archivedRecord });
      }
      const reviewAction = path.match(/^\/v1\/review\/submissions\/([^/]+)\/actions$/);
      if (reviewAction && body.action === "publish") {
        review = { ...review, publishedAt: date, allowedActions: [] };
        releases = [{ slug: review.slug, version: review.version, lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: date, sha: "f", allowedActions: ["deprecate", "unpublish", "revoke"] }, ...releases];
        skills = skills.map(s => s.slug === review.slug ? { ...s, latestVersion: review.version } : s);
        return reply({ submission: review });
      }
      return reply({ error: { code: "NOT_FOUND", message: `Unmocked ${method} ${path}` } }, 404);
    }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/branding") return reply({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/skills") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return reply({ skills: skills.filter(s => `${s.title} ${s.slug}`.toLowerCase().includes(q)).map(publicSkill), nextCursor: null });
    }
    if (path === "/v1/manage/skills") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const rows = manager ? [...skills.map(s => managed(s.slug)!), archivedRecord] : [];
      return reply({ skills: rows.filter(s => `${s.title} ${s.slug}`.toLowerCase().includes(q)), nextCursor: null });
    }
    const managedDetail = path.match(/^\/v1\/manage\/skills\/([^/]+)$/);
    if (managedDetail) {
      if (options.slowManaged) await gate;
      if (managedUnavailable) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Management is temporarily unavailable." } }, 503);
      const record = managed(managedDetail[1]!);
      if (!record) return reply({ error: { code: "SKILL_NOT_FOUND", message: "Skill not found." } }, 404);
      if (!manager) return reply({ error: { code: "SKILL_MANAGEMENT_ROLE_REQUIRED", message: "Skill management requires owner or maintainer permissions." } }, 403);
      return reply({ skill: record });
    }
    const history = path.match(/^\/v1\/skills\/([^/]+)\/releases$/);
    if (history) {
      const canManage = manager && managed(history[1]!) !== null;
      // A sharing-only fixture deliberately leaks allowedActions: the UI must still require the management record.
      return reply({ releases: releases.filter(r => r.slug === history[1] && (canManage || published(r))).map(r => summary(r, canManage || options.sharingOnly === true)) });
    }
    const exact = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)$/);
    if (exact) {
      const release = releases.find(r => r.slug === exact[1] && r.version === exact[2] && published(r));
      const row = skills.find(s => s.slug === exact[1]);
      if (!release || !row) return reply({ error: { code: "NOT_FOUND", message: "Exact release is unavailable." } }, 404);
      return reply({ release: { ...summary(release, false), title: row.title, summary: row.summary } });
    }
    if (path.endsWith("/sharing")) {
      const slug = path.split("/")[3]!;
      return reply({ sharing: { slug, title: slug, visibility: "public", settings: { publicVisibilityEnabled: true, authenticatedVisibilityEnabled: true, teamsEnabled: true, teamVisibilityEnabled: true, userVisibilityEnabled: true, organizationVisibilityEnabled: true }, availableTeams: [], teamGrants: [], userGrants: [], availableOrganizations: [], organizationGrants: [] } });
    }
    if (path.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    const selected = path.match(/^\/v1\/skills\/([^/]+)$/);
    if (selected) {
      const row = skills.find(s => s.slug === selected[1]);
      return row ? reply({ skill: publicSkill(row) }) : reply({ error: { code: "SKILL_NOT_FOUND", message: "Skill not found." } }, 404);
    }
    if (path === "/v1/review/submissions") return reply({ submissions: review.publishedAt ? [] : [review], nextCursor: null });
    if (path === "/v1/submissions/mine") return reply({ submissions: [{ ...review, id: "mine-1", slug: "release-notes-helper", title: "Release Notes Helper", version: "1.3.0", reviewStatus: "pending", allowedActions: ["withdraw"] }, { ...review, id: "mine-2", slug: "release-notes-helper", title: "Release Notes Helper", version: "1.2.0", publishedAt: "2026-09-18T00:00:00Z", allowedActions: [] }] });
    if (path === "/v1/architecture-targets") return reply({ targets: [] });
    if (path.startsWith("/v1/improvements/policies/")) return reply({ revision: null });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    return reply({ error: { code: "NOT_FOUND", message: `Unmocked ${method} ${path}` } }, 404);
  });
  return { writes, reads, openGate, recoverManaged: () => { managedUnavailable = false; } };
}

const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true, level: 2 });
// Readable skills choose versions in the Overview release card; a management-only
// record (no readable release) keeps a header select.
const managedVersionSelect = (page: Page) => page.getByRole("combobox", { name: "Release version", exact: true });
const releaseCard = (page: Page) => page.getByRole("region", { name: "Release", exact: true });
const releaseHeading = (page: Page, version: string) => releaseCard(page).getByRole("heading", { name: `Release ${version}`, exact: true });
const publishedVersions = (page: Page) => releaseCard(page).getByRole("list", { name: "Published versions" });
const versionsHistoryRow = (page: Page, version: string) => page.getByRole("tabpanel", { name: "Versions" }).getByRole("link", { name: new RegExp(`^${version.replaceAll(".", "\\.")}\\b`) });
const tabs = (page: Page) => page.getByRole("tablist", { name: "Skill sections" });
const tab = (page: Page, name: "Overview" | "Versions" | "Manage") => tabs(page).getByRole("tab", { name, exact: true });
const scope = (page: Page) => page.getByRole("navigation", { name: "Skill scope" });
const command = (page: Page) => page.getByText(/myskills export '[a-z-]+' --version/);
const lifecycleButtons = (page: Page) => page.getByRole("button", { name: /^(Archive skill|Restore skill|Delete skill|(Deprecate|Unpublish|Revoke|Restore|Delete) \S+)$/ });

async function evidence(page: Page, info: TestInfo, name: string, receipt: unknown) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  await info.attach(`${name}-receipt`, { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
}

test("exact published skill and version survive scope, section, reload and history", async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/skills/release-notes-helper?q=release&version=1.0.0");
  await expect(heading(page, "Release Notes Helper")).toBeVisible();
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await expect(command(page)).toContainText("--version '1.0.0'");
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".side-nav").getByRole("link", { name: "Manage skills", exact: true })).toHaveCount(0);

  await tab(page, "Versions").click();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=release&version=1\.0\.0&tab=versions$/);
  const history = page.getByRole("tabpanel", { name: "Versions" });
  await expect(history.getByRole("link", { name: /^1\.0\.0\b/ })).toHaveAttribute("aria-current", "true");
  await expect(history.getByRole("link", { name: /^1\.3\.0\b/ })).toContainText("Not published");

  await expect(scope(page).getByRole("link", { name: "All skills", exact: true })).toHaveAttribute("aria-current", "page");
  await scope(page).getByRole("link", { name: "Can manage", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=release&version=1\.0\.0&scope=manage&tab=versions$/);
  await expect(scope(page).getByRole("link", { name: "Can manage", exact: true })).toHaveAttribute("aria-current", "page");
  const inventory = page.getByRole("region", { name: "Managed skills" });
  await expect(inventory.getByRole("link", { name: /Release Notes Helper/ })).toHaveAttribute("aria-current", "true");
  await expect(heading(page, "Release Notes Helper")).toBeVisible();
  await expect(versionsHistoryRow(page, "1.0.0")).toHaveAttribute("aria-current", "true");

  await tab(page, "Manage").click();
  await expect(page).toHaveURL(/version=1\.0\.0&scope=manage&tab=manage$/);
  await expect(page.getByRole("button", { name: "Unpublish 1.0.0", exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=release&version=1\.0\.0&scope=manage&tab=manage$/);
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Unpublish 1.0.0", exact: true })).toBeVisible();

  await page.goBack();
  await expect(tab(page, "Versions")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/scope=manage&tab=versions$/);
  await page.goBack();
  await expect(scope(page).getByRole("link", { name: "All skills", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=release&version=1\.0\.0&tab=versions$/);
  await expect(versionsHistoryRow(page, "1.0.0")).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?q=release&version=1\.0\.0$/);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await expect(command(page)).toContainText("--version '1.0.0'");
  expect(state.writes).toEqual([]);
  await evidence(page, info, "exact-identity-desktop", { reads: state.reads, writes: state.writes });
});

test("a manager deep link to an archived unpublished record survives reload without invented release content", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/skills/archived-helper?scope=manage&tab=manage");
  await expect(heading(page, "Archived Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");
  await expect(managedVersionSelect(page)).toHaveValue("1.0.0");
  await expect(page.getByRole("button", { name: "Restore skill", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Restore 1.0.0", exact: true })).toBeEnabled();
  await expect(command(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review install", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(heading(page, "Archived Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");

  await tab(page, "Overview").click();
  const overview = page.getByRole("tabpanel", { name: "Overview" });
  await expect(overview).toContainText("No readable published release");
  await expect(command(page)).toHaveCount(0);
  await scope(page).getByRole("link", { name: "All skills", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/archived-helper$/);
  await expect(heading(page, "Archived Helper")).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Overview" })).toContainText("No readable published release");

  await tab(page, "Manage").click();
  await page.getByRole("button", { name: "Restore skill", exact: true }).click();
  const confirm = page.getByRole("region", { name: "Confirm lifecycle change" });
  await expect(confirm).toContainText("archived-helper");
  await confirm.getByRole("button", { name: "Confirm restore", exact: true }).click();
  await expect(page.getByText(/Lifecycle change saved/)).toBeVisible();
  expect(state.writes).toEqual([{ method: "POST", path: "/v1/skills/archived-helper/actions", body: { action: "restore" } }]);
  expect(state.reads.some(read => read.startsWith("/v1/skills/archived-helper/releases/"))).toBe(false);
  await evidence(page, info, "archived-manager", { reads: state.reads, writes: state.writes });
});

test("a reader cannot see an archived record or management controls from any alias", async ({ page }, info) => {
  const state = await fixture(page, { role: "user" });
  await page.goto("/skills/archived-helper?scope=manage&tab=manage");
  await expect(page.getByText("You can't manage this skill.", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived Helper")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(0);
  await page.goto("/skills/archived-helper");
  await expect(page.getByText("Skill or release not found.", { exact: true })).toBeVisible();
  await expect(page.getByText("Archived Helper")).toHaveCount(0);
  await page.goto("/manage/skills");
  await expect(scope(page).getByRole("link", { name: "Can manage", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("You don't manage any skills yet.", { exact: false })).toBeVisible();
  await page.goto("/skills/release-notes-helper?version=1.0.0&tab=manage");
  await expect(heading(page, "Release Notes Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toHaveCount(0);
  await expect(tab(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await expect(lifecycleButtons(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /add to library/i })).toBeVisible();
  expect(state.writes).toEqual([]);
  await evidence(page, info, "reader-denied", { reads: state.reads, writes: state.writes });
});

test("anonymous readers keep exact detail without management or library actions and manage aliases require sign-in", async ({ page }) => {
  await fixture(page, { anonymous: true });
  await page.goto("/registry/skills/release-notes-helper?version=1.0.0");
  await expect(heading(page, "Release Notes Helper")).toBeVisible();
  await expect(releaseHeading(page, "1.0.0")).toBeVisible();
  await expect(scope(page)).toHaveCount(0);
  await expect(tab(page, "Manage")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /add to library/i })).toHaveCount(0);
  await page.goto("/manage/skills");
  await expect(page).toHaveURL(/\/login$/);
});

test("canManageSharing alone never exposes lifecycle controls", async ({ page }, info) => {
  const state = await fixture(page, { role: "author", sharingOnly: true });
  await page.goto("/skills/release-notes-helper?version=1.0.0&tab=manage");
  await expect(heading(page, "Release Notes Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Sharing controls" })).toBeVisible();
  await expect(lifecycleButtons(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  await evidence(page, info, "sharing-only", { reads: state.reads });
});

for (const mfa of [true, false]) test(`Manage is the only lifecycle surface and keeps exact confirmation with MFA ${mfa}`, async ({ page }, info) => {
  const state = await fixture(page, { mfa });
  await page.goto("/skills/release-notes-helper?version=1.0.0");
  await expect(command(page)).toContainText("--version '1.0.0'");
  await expect(page.getByRole("button", { name: "Owner controls", exact: true })).toHaveCount(0);
  await expect(lifecycleButtons(page)).toHaveCount(0);
  await tab(page, "Manage").click();
  const panel = page.getByRole("tabpanel", { name: "Manage" });
  const unpublish = panel.getByRole("button", { name: "Unpublish 1.0.0", exact: true });
  await expect(lifecycleButtons(page).filter({ hasText: /Unpublish/ })).toHaveCount(1);
  if (!mfa) {
    await expect(panel.getByText(/MFA-verified session is required/)).toBeVisible();
    await expect(unpublish).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Archive skill", exact: true })).toBeDisabled();
    await expect(panel.getByRole("region", { name: "Sharing controls" })).toHaveCount(0);
    expect(state.reads.some(read => read.endsWith("/sharing"))).toBe(false);
  } else {
    await expect(panel.getByRole("region", { name: "Sharing controls" })).toBeVisible();
    await unpublish.click();
    const confirm = panel.getByRole("region", { name: "Confirm lifecycle change" });
    await expect(confirm).toContainText("release-notes-helper 1.0.0");
    await expect(confirm).toContainText("b".repeat(64));
    await expect(confirm.getByRole("button", { name: "Confirm unpublish", exact: true })).toBeDisabled();
    await confirm.getByRole("textbox", { name: "Lifecycle reason", exact: true }).fill("Replaced by 1.2.0.");
    await confirm.getByRole("button", { name: "Confirm unpublish", exact: true }).click();
    await expect(panel.getByText(/Lifecycle change saved/)).toBeVisible();
    expect(state.writes).toEqual([{ method: "POST", path: "/v1/skills/release-notes-helper/releases/1.0.0/actions", body: { action: "unpublish", reason: "Replaced by 1.2.0." } }]);
    await expect(page).toHaveURL(/\/skills\/release-notes-helper\?version=1\.0\.0&tab=manage$/);
    await expect(panel.getByRole("button", { name: "Restore 1.0.0", exact: true })).toBeVisible();
    await tab(page, "Overview").click();
    await expect(page.getByText("This exact release is unavailable.", { exact: true })).toBeVisible();
    await expect(command(page)).toHaveCount(0);
  }
  if (!mfa) expect(state.writes).toEqual([]);
  await evidence(page, info, `manage-mfa-${mfa}`, { writes: state.writes });
});

// Added after parent review, before the fix: the Manage section can open while
// the management read is still pending, so metadata must prefill when the
// record arrives, and an unsaved draft must survive the in-place reload that
// follows a saved lifecycle change.
test("a delayed management read still prefills metadata and keeps drafts across a saved change", async ({ page }, info) => {
  const state = await fixture(page, { slowManaged: true });
  await page.goto("/skills/release-notes-helper?tab=manage");
  const panel = page.getByRole("tabpanel", { name: "Manage" });
  await expect(panel.getByText("Loading management record…", { exact: true })).toBeVisible();
  state.openGate();
  const titleField = panel.getByRole("textbox", { name: "Title", exact: true });
  await expect(titleField).toHaveValue("Release Notes Helper");
  await expect(panel.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue("Turn merged changes into release notes.");
  await titleField.fill("Release Notes Helper draft");
  const managedReads = () => state.reads.filter(read => read === "/v1/manage/skills/release-notes-helper").length;
  const readsBeforeChange = managedReads();
  await panel.getByRole("button", { name: "Deprecate 1.2.0", exact: true }).click();
  await panel.getByRole("textbox", { name: "Lifecycle reason", exact: true }).fill("Superseded soon.");
  await panel.getByRole("button", { name: "Confirm deprecate", exact: true }).click();
  await expect(panel.getByText(/Lifecycle change saved/)).toBeVisible();
  // The saved change re-read the management record in place.
  await expect.poll(managedReads).toBeGreaterThan(readsBeforeChange);
  await page.waitForLoadState("networkidle");
  await expect(titleField).toHaveValue("Release Notes Helper draft");
  expect(state.writes).toEqual([{ method: "POST", path: "/v1/skills/release-notes-helper/releases/1.2.0/actions", body: { action: "deprecate", reason: "Superseded soon." } }]);
  // Added before the App fix: the saved change leaves 1.2.0 with no lifecycle
  // action, yet Manage must still name the exact release its facts describe.
  await expect(panel.getByRole("button", { name: /^(Deprecate|Unpublish|Revoke|Restore|Delete) 1\.2\.0$/ })).toHaveCount(0);
  const releaseFacts = panel.locator("dl").filter({ has: page.locator("dt", { hasText: /^Review$/ }) });
  await expect(releaseFacts.locator("div").filter({ has: page.locator("dt", { hasText: /^Exact version$/ }) }).locator("dd")).toHaveText("1.2.0");
  await evidence(page, info, "delayed-management-prefill", { reads: state.reads, writes: state.writes });
});

test("a failed management read offers a retry instead of a denial", async ({ page }, info) => {
  const state = await fixture(page, { managedUnavailable: true });
  await page.goto("/skills/release-notes-helper?scope=manage&tab=manage");
  await expect(page.getByText("Management access couldn't be checked.", { exact: true })).toBeVisible();
  await expect(page.getByText("You can't manage this skill.", { exact: true })).toHaveCount(0);
  await expect(lifecycleButtons(page)).toHaveCount(0);
  state.recoverManaged();
  await page.getByRole("button", { name: "Retry management check", exact: true }).click();
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Unpublish 1.2.0", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await evidence(page, info, "management-retry", { reads: state.reads });
});

// Added after integration review, before the fix: management authority must not
// turn a readable skill with no default stable release into an implicit pin.
test("a manager's readable prerelease-only skill stays unselected until an exact version is chosen", async ({ page }, info) => {
  const state = await fixture(page, { prereleaseOnly: true });
  await page.goto("/skills/beta-helper");
  await expect(heading(page, "Beta Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No default stable release", exact: true })).toBeVisible();
  expect(state.reads.some(read => read.startsWith("/v1/skills/beta-helper/releases/"))).toBe(false);
  // Choose the exact version from the Release region's published versions.
  await releaseCard(page).getByRole("button", { name: /^Versions\b/ }).click();
  await expect(publishedVersions(page).getByRole("button")).toHaveCount(1);
  await expect(publishedVersions(page).locator("[aria-current='true']")).toHaveCount(0);
  await publishedVersions(page).getByRole("button", { name: /^2\.0\.0-beta\.1\b/ }).click();
  await expect(page).toHaveURL(/\/skills\/beta-helper\?version=2\.0\.0-beta\.1$/);
  await expect(releaseHeading(page, "2.0.0-beta.1")).toBeVisible();
  await expect(command(page)).toContainText("--version '2.0.0-beta.1'");
  await tab(page, "Manage").click();
  await expect(page.getByRole("button", { name: "Deprecate 2.0.0-beta.1", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await evidence(page, info, "prerelease-manager", { reads: state.reads });
});

test("a slow earlier selection cannot replace the skill chosen afterwards", async ({ page }, info) => {
  const state = await fixture(page, { slow: "release-notes-helper" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/registry?scope=manage");
  const inventory = page.getByRole("region", { name: "Managed skills" });
  await inventory.getByRole("link", { name: /Release Notes Helper/ }).click();
  await inventory.getByRole("link", { name: /Code Review Guide/ }).click();
  await expect(heading(page, "Code Review Guide")).toBeVisible();
  await expect(page).toHaveURL(/\/skills\/code-review-guide\?scope=manage$/);
  state.openGate();
  await page.waitForLoadState("networkidle");
  await expect(heading(page, "Code Review Guide")).toBeVisible();
  await expect(heading(page, "Release Notes Helper")).toHaveCount(0);
  await tab(page, "Manage").click();
  await expect(page.getByRole("button", { name: "Unpublish 2.0.0", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Sharing controls" })).toHaveCount(0);
  await evidence(page, info, "stale-selection", { reads: state.reads });
});

test("mobile Can manage alias keeps focus, tabs and no horizontal overflow", async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage/skills");
  await expect(scope(page).getByRole("link", { name: "Can manage", exact: true })).toHaveAttribute("aria-current", "page");
  const row = page.getByRole("region", { name: "Managed skills" }).getByRole("link", { name: /Archived Helper/ });
  await expect(row).toContainText("Archived");
  await row.click();
  await expect(heading(page, "Archived Helper")).toBeFocused();
  await expect(tabs(page)).toBeInViewport();
  await tab(page, "Manage").click();
  await expect(page.getByRole("button", { name: "Restore skill", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Back to skills", exact: true }).click();
  await expect(row).toBeFocused();
  await expect(page).toHaveURL(/\/registry\?scope=manage$/);
  await page.goBack();
  await expect(heading(page, "Archived Helper")).toBeVisible();
  await expect(tab(page, "Manage")).toHaveAttribute("aria-selected", "true");
  await evidence(page, info, "mobile-manage-390", { reads: state.reads, writes: state.writes });
});

test("returnTo offers only a safe internal Libraries return and survives section changes", async ({ page }) => {
  await fixture(page);
  const target = "/libraries?library=lib-1&entry=entry-1&candidate=cand-1";
  await page.goto(`/skills/release-notes-helper?version=1.0.0&returnTo=${encodeURIComponent(target)}`);
  const back = page.getByRole("link", { name: "Return to library", exact: true });
  await expect(back).toHaveAttribute("href", target);
  await tab(page, "Versions").click();
  await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "versions" && url.searchParams.get("returnTo") === target);
  await expect(back).toHaveAttribute("href", target);
  await back.click();
  await expect(page).toHaveURL(target);
  for (const unsafe of ["https://evil.example/libraries?library=lib-1", "//evil.example/libraries", "/admin", "/libraries/../admin", "javascript:alert(1)"]) {
    await page.goto(`/skills/release-notes-helper?returnTo=${encodeURIComponent(unsafe)}`);
    await expect(heading(page, "Release Notes Helper")).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to library", exact: true })).toHaveCount(0);
  }
});

test("review and submission outcomes open the exact release in Skills", async ({ page }, info) => {
  const state = await fixture(page);
  await page.goto("/submit");
  await expect(page.getByRole("link", { name: "release-notes-helper@1.3.0", exact: true })).toHaveAttribute("href", "/skills/release-notes-helper?version=1.3.0&scope=manage&tab=versions");
  await expect(page.getByRole("link", { name: "release-notes-helper@1.2.0", exact: true })).toHaveAttribute("href", "/skills/release-notes-helper?version=1.2.0");
  await page.goto("/review");
  const decision = page.getByRole("region", { name: "Review decision", exact: true });
  await decision.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Publish this release?" });
  await dialog.getByRole("textbox").fill("Reviewed and ready.");
  await dialog.getByRole("button", { name: "Publish release", exact: true }).click();
  const open = page.getByRole("link", { name: "Open code-review-guide@2.1.0 in Skills", exact: true });
  await expect(open).toHaveAttribute("href", "/skills/code-review-guide?version=2.1.0");
  await open.click();
  await expect(page).toHaveURL(/\/skills\/code-review-guide\?version=2\.1\.0$/);
  await expect(heading(page, "Code Review Guide")).toBeVisible();
  await expect(command(page)).toContainText("--version '2.1.0'");
  expect(state.writes).toEqual([{ method: "POST", path: "/v1/review/submissions/sub-1/actions", body: { action: "publish", reason: "Reviewed and ready." } }]);
  await evidence(page, info, "outcome-links", { writes: state.writes });
});
