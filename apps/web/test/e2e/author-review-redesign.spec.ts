import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Test-first Wave 2 acceptance. Existing DOM tests cover API fallbacks/epochs.
// These browser journeys protect composition, mobile selection/focus, exact hash
// approval, reason confirmation, feedback placement and exact lifecycle identity.
const date = "2026-09-27T00:00:00Z";
const hash = "b".repeat(64);
const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" }];
const artifact = { sha256: hash, byteSize: 2048, contentType: "application/json" };
const base = { visibility: "private", platforms, artifact, createdAt: date, publishedAt: null, approvedArtifactSha256: null, findingCount: 0 };
const pending = { ...base, id: "pending", slug: "release-notes-helper", title: "Release Notes Helper", summary: "Write concise release notes.", version: "1.3.0", lifecycleStatus: "submitted", reviewStatus: "pending", securityStatus: "passed", allowedActions: ["approve", "request-changes", "reject"] };
const approved = { ...base, id: "approved", slug: "code-review-guide", title: "Code Review Guide", summary: "Check correctness before release.", version: "2.1.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", approvedArtifactSha256: "a".repeat(64), allowedActions: ["publish"] };
const blocked = { ...base, id: "blocked", slug: "research-brief", title: "Research Brief", summary: "Gather cited evidence.", version: "0.8.0", lifecycleStatus: "quarantined", reviewStatus: "pending", securityStatus: "failed", findingCount: 3, allowedActions: ["request-changes", "reject"] };
const managed = [pending, approved, blocked].map((s, i) => ({ ...s, lifecycleStatus: i === 2 ? "archived" : "approved", latestVersion: s.version, allowedActions: i === 2 ? ["restore"] : ["edit", "archive"] }));

async function fixture(page: Page, options: { mfa?: boolean; partial?: boolean; failReview?: boolean; bootstrap?: boolean; teamImport?: boolean } = {}) {
  const user = { id: "owner-1", email: "owner@example.test", name: "Example owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: options.mfa !== false };
  await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-27T00:00:00Z" })), user);
  let rows = structuredClone([pending, approved, blocked]);
  let failReview = options.failReview === true;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const misses: string[] = [];
  const release = (slug: string, version: string) => ({ ...base, id: `${slug}-${version}`, slug, version, lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", releaseNotes: `Exact release ${version}.`, allowedActions: ["unpublish"] });
  await page.route("**/api/v1/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (method === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      const review = path.match(/^\/v1\/review\/submissions\/([^/]+)\/actions$/);
      if (review) {
        const row = rows.find(s => s.id === review[1])!;
        const updated = { ...row, reviewStatus: body.action === "approve" ? "approved" : row.reviewStatus, approvedArtifactSha256: body.action === "approve" ? String(body.artifactSha256) : row.approvedArtifactSha256, allowedActions: body.action === "approve" ? ["publish"] : [], publishedAt: body.action === "publish" ? date : null };
        rows = body.action === "publish" ? rows.filter(s => s.id !== row.id) : rows.map(s => s.id === row.id ? { ...updated, publishedAt: null } : s);
        return reply({ submission: updated });
      }
      const action = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)\/actions$/);
      if (action) return reply({ release: release(action[1]!, action[2]!) });
      if (path.endsWith("/actions")) return reply({ skill: managed[0], submission: pending });
    }
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/site") return reply({ site: { landingPageEnabled: true } });
    if (path === "/v1/branding") return reply({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/review/submissions") {
      if (failReview) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Review queue temporarily unavailable." } }, 503);
      return reply({ submissions: options.partial && !url.searchParams.has("cursor") ? rows.slice(0, 2) : rows, nextCursor: options.partial && !url.searchParams.has("cursor") ? "page-2" : null });
    }
    if (path === "/v1/submissions/mine") return reply({ submissions: rows.map(s => ({ ...s, ...(options.teamImport && s.id === "blocked" ? { owner: { type: "team", id: "engineering-team" } } : {}), reviewStatus: s.id === "blocked" ? "changes-requested" : s.reviewStatus, allowedActions: ["withdraw"] })), nextCursor: null });
    if (/^\/v1\/(review\/)?submissions\/[^/]+\/bundle$/.test(path)) return route.fulfill({ json: { files: [{ path: "SKILL.md", content: "# Reviewed exact artifact\nUse verified release evidence." }] }, headers: { "x-myskills-artifact-sha256": hash } });
    const detail = path.match(/^\/v1\/(?:review\/)?submissions\/([^/]+)$/);
    if (detail) return reply({ submission: { ...rows.find(s => s.id === detail[1]), ...(options.teamImport && detail[1] === "blocked" ? { owner: { type: "team", id: "engineering-team" } } : {}), reviewStatus: detail[1] === "blocked" ? "changes-requested" : rows.find(s => s.id === detail[1])?.reviewStatus, changeRequestReason: detail[1] === "blocked" ? "Cite the original research sources." : null, reviewHistory: [], scanRuns: [], correction: { requiresNewVersion: true, canSubmitNewVersion: !options.teamImport } } });
    if (path === "/v1/manage/skills") return reply({ skills: managed.filter(s => s.title.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())), nextCursor: null });
    const releases = path.match(/^\/v1\/skills\/([^/]+)\/releases$/);
    if (releases) return reply({ releases: [release(releases[1]!, "1.3.0"), release(releases[1]!, options.bootstrap ? "0.0.0-bootstrap.118b105a185" : "1.0.0")] });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    misses.push(`${method} ${path}`);
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  return { writes, misses, recover: () => { failReview = false; } };
}

async function evidence(page: Page, info: TestInfo, writes: unknown) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("verified-workspace.png"), fullPage: true });
  await info.attach("action-receipt", { body: JSON.stringify(writes, null, 2), contentType: "application/json" });
}

for (const width of [1280, 390]) test(`review presents one next action and preserves exact approval at ${width}`, async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
  await page.goto("/review");
  const queue = page.getByLabel("Review queue", { exact: true });
  const row = queue.getByRole("button", { name: /Release Notes Helper/ });
  await row.click();
  const detail = page.getByLabel("Selected submission review", { exact: true });
  await expect(detail.getByRole("heading", { name: "Release Notes Helper", exact: true })).toBeInViewport();
  if (width === 1280) await expect(queue).toBeInViewport();
  else await expect(queue).toBeHidden();
  const actions = detail.getByRole("region", { name: "Review decision", exact: true });
  await expect(actions.locator('[data-variant="default"]')).toHaveCount(1);
  await expect(detail.getByRole("textbox", { name: "Reason", exact: true })).toHaveCount(0);
  await actions.getByRole("button", { name: "Inspect artifact", exact: true }).click();
  await expect(actions.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await actions.getByRole("button", { name: "Approve", exact: true }).click();
  const approve = page.getByRole("dialog", { name: "Approve this submission?" });
  await expect(approve).toContainText("release-notes-helper@1.3.0");
  await expect(approve).toContainText(hash);
  await approve.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await actions.getByRole("button", { name: "Approve", exact: true }).click();
  await approve.getByRole("button", { name: "Approve submission", exact: true }).click();
  await expect(actions).toContainText("was approved");
  await expect(actions.locator('[data-variant="default"]')).toHaveCount(1);
  expect(state.writes).toEqual([{ path: "/v1/review/submissions/pending/actions", body: { action: "approve", artifactSha256: hash } }]);
  await actions.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.getByRole("dialog", { name: "Publish this release?" });
  await expect(publish.getByRole("button", { name: "Publish release", exact: true })).toBeDisabled();
  await publish.getByRole("textbox").fill("Ready for the release.");
  await publish.getByRole("button", { name: "Publish release", exact: true }).click();
  await expect(page.getByText("Release Notes Helper was published.", { exact: true })).toBeFocused();
  expect(state.writes[1]).toEqual({ path: "/v1/review/submissions/pending/actions", body: { action: "publish", reason: "Ready for the release." } });
  expect(state.misses).toEqual([]);
  await evidence(page, info, state.writes);
});

test("blocked mobile review keeps allowed decisions and returns focus to its queue row", async ({ page }, info) => {
  const state = await fixture(page, { partial: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/review");
  await page.getByRole("button", { name: "Load more submissions", exact: true }).click();
  const queue = page.getByLabel("Review queue", { exact: true });
  const row = queue.getByRole("button", { name: /Research Brief/ });
  await row.click();
  const detail = page.getByLabel("Selected submission review", { exact: true });
  await expect(detail.getByRole("heading", { name: "Research Brief", exact: true })).toBeFocused();
  await expect(detail.getByRole("button", { name: /^(Approve|Publish)$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to queue", exact: true }).click();
  await expect(row).toBeFocused();
  await row.click();
  await detail.getByRole("button", { name: "Request changes", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Request changes?" });
  await expect(dialog.getByRole("button", { name: "Request changes", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox").fill("Cite original sources.");
  await dialog.getByRole("button", { name: "Request changes", exact: true }).click();
  expect(state.writes).toEqual([{ path: "/v1/review/submissions/blocked/actions", body: { action: "request-changes", reason: "Cite original sources." } }]);
  await expect(page.getByText("Research Brief was returned for changes.", { exact: true })).toBeFocused();
  await expect(queue).toBeVisible();
  await evidence(page, info, state.writes);
});

test("submission feedback opens beside its context and returns focus without an empty result panel", async ({ page }, info) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/submit");
  await expect(page.getByText("No submission yet", { exact: true })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "View feedback for 0.8.0", exact: true });
  await trigger.click();
  const heading = page.getByRole("heading", { name: "Submission feedback", exact: true });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await expect(page.getByText("Cite the original research sources.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close feedback", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("button", { name: "Choose corrected package", exact: true }).click();
  await expect(page.locator('#package-archive')).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await evidence(page, info, state.writes);
});

for (const mfa of [true, false]) test(`managed mobile exact release lifecycle respects MFA ${mfa}`, async ({ page }, info) => {
  const state = await fixture(page, { mfa });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/manage/skills");
  const row = page.getByRole("button", { name: /Release Notes Helper/ });
  await row.click();
  await expect(page.getByRole("heading", { name: "Release Notes Helper", exact: true })).toBeFocused();
  await page.getByRole("combobox", { name: "Managed release version", exact: true }).selectOption("1.0.0");
  const unpublish = page.getByRole("button", { name: "Unpublish 1.0.0", exact: true });
  if (!mfa) await expect(unpublish).toBeDisabled();
  else {
    await unpublish.click();
    await expect(page.getByRole("button", { name: "Confirm unpublish", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Lifecycle reason", exact: true }).fill("Replaced by reviewed release.");
    await page.getByRole("button", { name: "Confirm unpublish", exact: true }).click();
    await expect(page.getByText(/Lifecycle change saved/)).toBeVisible();
    expect(state.writes).toEqual([{ path: "/v1/skills/release-notes-helper/releases/1.0.0/actions", body: { action: "unpublish", reason: "Replaced by reviewed release." } }]);
  }
  await page.getByRole("button", { name: "Back to skills", exact: true }).click();
  await expect(row).toBeFocused();
  if (!mfa) expect(state.writes).toHaveLength(0);
  await evidence(page, info, state.writes);
});

// Error recovery stays within the queue instead of stranding the page.
test("review queue retries its local error without duplicating alerts", async ({ page }, info) => {
  const state = await fixture(page, { failReview: true });
  await page.goto("/review");
  const queue = page.getByLabel("Review queue", { exact: true });
  await expect(queue.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(1);
  state.recover();
  await queue.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(queue.getByRole("button", { name: /Research Brief/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await evidence(page, info, state.writes);
});

// The friendly label must never enter a lifecycle request or conceal its pin.
test("managed bootstrap label keeps the exact lifecycle target", async ({ page }, info) => {
  const state = await fixture(page, { bootstrap: true });
  const version = "0.0.0-bootstrap.118b105a185";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/manage/skills");
  await page.getByRole("button", { name: /Release Notes Helper/ }).click();
  const selector = page.getByRole("combobox", { name: "Managed release version", exact: true });
  await expect(selector.locator(`option[value="${version}"]`)).toHaveText("Initial import · Approved");
  await selector.selectOption(version);
  await expect(page.getByText("Exact version", { exact: true }).locator("..")).toContainText(version);
  await page.getByRole("button", { name: "Unpublish Initial import", exact: true }).click();
  await expect(page.getByRole("region", { name: "Confirm lifecycle change" })).toContainText(version);
  await page.getByRole("textbox", { name: "Lifecycle reason", exact: true }).fill("Replaced by a reviewed release.");
  await page.getByRole("button", { name: "Confirm unpublish", exact: true }).click();
  await expect(page.getByText(/Lifecycle change saved/)).toBeVisible();
  expect(state.writes).toEqual([{ path: `/v1/skills/release-notes-helper/releases/${version}/actions`, body: { action: "unpublish", reason: "Replaced by a reviewed release." } }]);
  expect(state.misses).toEqual([]);
  await evidence(page, info, state.writes);
});

// Team ownership expands the existing submission list. It must not misdirect a
// curator to the personal upload path when a reviewer requests source changes.
test("team import feedback identifies ownership and routes corrections through Libraries", async ({ page }, info) => {
  const state = await fixture(page, { teamImport: true });
  await page.goto("/submit");
  const row = page.locator(".submit-item").filter({ hasText: "Research Brief" });
  await expect(row.getByText("Team-owned", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "View feedback for 0.8.0", exact: true }).click();
  await expect(row.getByText("Review the corrected upstream source in Libraries, then submit a new candidate. Submitting requires an author role. The previous artifact and review history remain unchanged.", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Choose corrected package", exact: true })).toHaveCount(0);
  await expect(row.getByText("Author permission is required to submit the correction.", { exact: false })).toHaveCount(0);
  await row.getByRole("link", { name: "Open Libraries", exact: true }).click();
  await expect(page).toHaveURL(/\/libraries$/);
  expect(state.writes).toHaveLength(0);
  await info.attach("team-submission-feedback-receipt", { body: JSON.stringify({ ownershipVisible: true, correctionRoute: "/libraries", mutations: 0 }), contentType: "application/json" });
});
