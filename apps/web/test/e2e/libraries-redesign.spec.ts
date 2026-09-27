import { expect, test, type Page } from "@playwright/test";

// Written before the composition change. Exercise the actual app through its
// HTTP boundary; fixtures contain synthetic content and never call a service.
const stamp = "2026-09-27T00:00:00Z";
const digest = "a".repeat(64);

async function libraryScene(page: Page, options: { empty?: boolean; reader?: boolean; failCreate?: boolean; failDelete?: boolean } = {}) {
  const user = { id: "design-owner", email: "owner@example.test", name: "Library owner", status: "active", roles: options.reader ? ["member"] : ["owner"], emailVerified: true, mfaVerified: true };
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-27T00:00:00Z", user })), user);
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let created = !options.empty;
  let createAttempts = 0;
  let deleteAttempts = 0;
  let deleted = false;
  let name = "My skills";
  let subscribed = true;
  let paged = false;
  const library = (id = "personal") => ({ id, name: id === "personal" ? name : "Support team", description: id === "personal" ? "The skills I reach for every day." : "Reviewed instructions for our support team.", owner: id === "personal" ? { type: "user", id: user.id } : { type: "team", id: "team-support", name: "Support team" }, status: "active", revision: 1, access: { canWrite: !options.reader, canImport: !options.reader, canTrackSources: !options.reader, role: options.reader ? "member" : "owner" }, subscription: subscribed ? { events: ["candidate-ready"], createdAt: stamp } : null, createdAt: stamp, updatedAt: stamp });
  const skill = (id: string, title: string, version: string | null, owner = true) => ({ id, libraryId: "personal", kind: "skill", status: "active", title, revision: 1, skill: { slug: id, nativeName: id, sourceEntryId: null, sourcePath: null, lineageId: null, ownership: { type: "user", isCaller: owner } }, adoption: version ? { id: "adopt-" + id, entryId: id, slug: id, version, artifactSha256: digest, predecessorAdoptionId: null, attestation: "instance-reviewed", adoptedBy: { id: user.id }, reason: "Reviewed for our everyday workflow.", adoptedAt: stamp } : null, createdAt: stamp, updatedAt: stamp });
  const entries = [skill("meeting-notes", "Meeting notes to actions", "1.3.0"), skill("project-brief", "Project brief writer", "0.9.2"), skill("code-review", "Code review checklist", "2.1.0", false), skill("release-notes", "Release notes helper", null), { id: "team-source", libraryId: "personal", kind: "source", status: "active", title: "example/team-skills", revision: 1, source: { provider: "github", repositoryId: "1234", fullName: "example/team-skills", url: "https://github.com/example/team-skills", path: "skills", ref: { kind: "default-branch" }, defaultBranch: "main", license: "MIT", archived: false }, tracking: { mode: "weekly", health: "healthy", nextCheckAt: "2026-10-04T00:00:00Z", lastAttemptAt: stamp, lastSuccessfulCheckAt: stamp, lastErrorCode: null, attemptCount: 0, lastGoodSnapshot: null, workerAvailable: true, identityChange: null }, adoption: null, createdAt: stamp, updatedAt: stamp }];
  const extra = skill("incident-summary", "Incident summary and follow-up for customer escalations", "1.0.4");
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api", "");
    const method = route.request().method();
    const body = method === "GET" ? {} : route.request().postDataJSON() ?? {};
    if (method !== "GET") writes.push({ path, body });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/skills") return reply({ skills: [] });
    if (path === "/v1/teams") return reply({ teams: options.reader ? [] : [{ id: "team-support", name: "Support team", role: "owner" }], invitations: [] });
    if (path === "/v1/libraries") {
      if (method === "POST") {
        createAttempts++;
        if (options.failCreate && createAttempts === 1) return reply({ error: { code: "LIBRARY_SERVICE_UNAVAILABLE" } }, 503);
        created = true; name = String(body.name); return reply({ library: library() }, 201);
      }
      return reply({ libraries: created ? [...(!deleted ? [library()] : []), ...(!options.empty ? [library("support")] : [])] : [], nextCursor: null });
    }
    if (path === "/v1/libraries/personal" && method === "DELETE") {
      deleteAttempts++;
      if (options.failDelete && deleteAttempts === 1) return reply({ error: { code: "LIBRARY_SERVICE_UNAVAILABLE" } }, 503);
      deleted = true; return reply({ removed: true });
    }
    if (path === "/v1/libraries/personal" || path === "/v1/libraries/support") return reply({ library: library(path.split("/").at(-1)) });
    if (path.endsWith("/entries")) {
      if (options.empty) return reply({ entries: [], nextCursor: null });
      if (url.searchParams.has("cursor")) { paged = true; return reply({ entries: [extra], nextCursor: null }); }
      return reply({ entries, nextCursor: "next-entries" });
    }
    if (path.endsWith("/subscription")) { subscribed = method === "PUT"; return reply({ subscription: library().subscription }); }
    if (path.includes("/releases/")) {
      const slug = path.split("/")[3]!;
      const entry = [...entries, extra].find((entry) => entry.id === slug);
      const summaries: Record<string, string> = {
        "meeting-notes": "Turn rough meeting notes into decisions, actions with owners and due dates, and questions to follow up.",
        "project-brief": "Draft a clear project brief with the goal, audience, scope, risks and open questions.",
        "code-review": "Review changes against a consistent checklist for correctness, tests and maintainability.",
        "incident-summary": "Turn incident notes into a concise account of impact, resolution and next steps.",
      };
      return reply({ release: { slug, title: entry?.title ?? slug, summary: summaries[slug] ?? "Reusable instructions for everyday work.", version: path.split("/").at(-1), lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-20T00:00:00Z", platforms: [{ name: "codex", installTarget: ".agents/skills", status: "supported" }, { name: "claude-code", installTarget: ".claude/skills", status: "supported" }], releaseNotes: "Clarified the output format and added an explicit check for missing owners.", requiresUserAction: false, artifact: { sha256: digest, byteSize: 1024, contentType: "application/json" } } });
    }
    if (path.endsWith("/candidates")) return reply({ candidates: [], nextCursor: null });
    if (path.endsWith("/bindings")) return reply({ bindings: [] });
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null } });
    if (path === "/v1/review/self-reviewed-releases") return reply({ releases: [] });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  return { writes, paged: () => paged };
}

async function fitsPage(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test("empty library workspace gives a clear first action and preserves a failed creation draft", async ({ page }, testInfo) => {
  const state = await libraryScene(page, { empty: true, failCreate: true });
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "Libraries", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await fitsPage(page);
    await page.screenshot({ path: testInfo.outputPath(`empty-${width}.png`), fullPage: true });
  }
  await expect(page.getByLabel("Library name")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Create library", exact: true })).toBeInViewport();
  await page.getByLabel("Library name").fill("Research and writing");
  await page.getByRole("button", { name: "Create library", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Library name")).toHaveValue("Research and writing");
  await page.getByRole("button", { name: "Create library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Research and writing", exact: true })).toBeVisible();
  expect(state.writes.filter((write) => write.path === "/v1/libraries")).toHaveLength(2);
  expect(state.writes[0]!.body).toEqual(state.writes[1]!.body);
  await page.screenshot({ path: testInfo.outputPath("selected-empty-390.png"), fullPage: true });
  await testInfo.attach("creation-receipt", { body: JSON.stringify(state.writes, null, 2), contentType: "application/json" });
});

test("populated library stays scanable and exposes entries and pagination without administrative clutter", async ({ page }, testInfo) => {
  const state = await libraryScene(page);
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "My skills", exact: true })).toBeVisible();
  await expect(page.locator(".library-command")).toContainText("--library-entry meeting-notes");
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    if (width < 600) {
      await expect(page.locator(".library-surface[data-layout]")).toHaveAttribute("data-layout", "stack");
      const back = page.getByRole("button", { name: "Back to entries", exact: true });
      await expect(back).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Meeting notes to actions", exact: true })).not.toHaveAttribute("aria-current", "true");
      await expect(page.getByRole("navigation", { name: "Your libraries" }).getByRole("button", { name: /Support team.*team library/ })).toBeVisible();
    }
    await fitsPage(page);
    await page.screenshot({ path: testInfo.outputPath(`populated-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByLabel("GitHub source URL")).not.toBeVisible();
  await expect(page.getByLabel("Allow private import self-review")).not.toBeVisible();
  const first = page.getByRole("button", { name: "Meeting notes to actions", exact: true });
  await expect(first).toHaveAttribute("aria-current", "true");
  const details = page.getByRole("complementary", { name: "Meeting notes to actions", exact: true });
  await expect(details.locator(".library-command")).toContainText("--library-entry meeting-notes");
  await page.getByRole("searchbox", { name: "Filter entries", exact: true }).fill("Incident");
  await expect(page.getByText(/No loaded entries match/)).toBeVisible();
  await page.getByRole("button", { name: "Load more entries", exact: true }).click();
  await expect.poll(state.paged).toBe(true);
  await expect(page.getByText("Incident summary and follow-up for customer escalations", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  const add = page.getByRole("button", { name: "Add source", exact: true });
  await add.click();
  await page.getByLabel("GitHub source URL").fill("https://github.com/example/draft");
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await expect(page.getByLabel("GitHub source URL")).not.toBeVisible();
  await add.click();
  await expect(page.getByLabel("GitHub source URL")).toHaveValue("https://github.com/example/draft");
  await page.keyboard.press("Escape");
  const create = page.getByRole("button", { name: "New library", exact: true });
  await create.click();
  await page.getByLabel("Library name").fill("A draft library");
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  // An explicit selection survives narrowing; an automatic desktop selection
  // above does not replace the mobile entry list.
  await page.getByRole("button", { name: "Project brief writer", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Project brief writer", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to entries", exact: true }).click();
  await expect(page.getByRole("button", { name: "Project brief writer", exact: true })).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await testInfo.attach("browse-receipt", { body: JSON.stringify({ pageLoaded: state.paged(), writes: state.writes }), contentType: "application/json" });
});

test("reader can inspect the adopted version on mobile without receiving edit controls", async ({ page }, testInfo) => {
  const state = await libraryScene(page, { reader: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "My skills", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add source", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add skill", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Allow private import self-review")).toHaveCount(0);
  const first = page.getByRole("button", { name: "Meeting notes to actions", exact: true });
  await expect(first).toBeInViewport();
  await first.click();
  const heading = page.getByRole("heading", { name: "Meeting notes to actions", exact: true });
  await expect(heading).toBeFocused();
  await expect(page.locator(".library-command")).toContainText("--library-entry meeting-notes");
  await expect(page.getByRole("button", { name: "Remove entry", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Adopt registry release", exact: true })).toHaveCount(0);
  await fitsPage(page);
  await page.screenshot({ path: testInfo.outputPath("reader-detail-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to entries", exact: true }).click();
  await expect(first).toBeFocused();
  expect(state.writes).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("reader-390.png"), fullPage: true });
});

// A composition change introduces a confirmation boundary for existing deletion.
// Protect its cancel, recoverable failure and next-library selection behaviour.
test("library deletion is cancelable, retryable and selects the remaining library", async ({ page }, testInfo) => {
  const state = await libraryScene(page, { failDelete: true });
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "My skills", exact: true })).toBeVisible();
  const openDelete = async () => {
    await page.getByRole("button", { name: "Library settings", exact: true }).click();
    if (!(await page.getByRole("dialog").isVisible())) await page.getByRole("button", { name: "Delete this library", exact: true }).click();
  };
  await openDelete();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("My skills");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  await openDelete();
  await dialog.getByRole("button", { name: "Delete library", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("delete-retry-1440.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Delete library", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Support team", exact: true })).toBeVisible();
  expect(state.writes.map((w) => w.path)).toEqual(["/v1/libraries/personal", "/v1/libraries/personal"]);
  await testInfo.attach("delete-receipt", { body: JSON.stringify(state.writes), contentType: "application/json" });
});
