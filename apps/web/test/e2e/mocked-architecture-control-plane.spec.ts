import { expect, test, type Page, type Route } from "@playwright/test";
import {
  architectureUi as ui,
  chooseExposure,
  effectiveFontSize,
  expandAllNodes,
  expectArchitectureUrl,
  MIN_LEGIBLE_LABEL_PX,
  noDocumentOverflow,
  visibleNodeIds,
} from "./architecture-explorer-support.js";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();
test.use({ launchOptions: browserExecutable ? { executablePath: browserExecutable } : {} });

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

interface MockArchitectureOptions {
  includeExistingArchitecture?: boolean;
  includeSecondArchitecture?: boolean;
  includeTeamOwner?: boolean;
  failFirstMigrationCreate?: boolean;
  scopeInventoryTarget?: boolean;
  authorOnly?: boolean;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ expiresAt: storedExpiry, user }) => {
    if (location.origin !== "null") window.localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: storedExpiry, user }));
  }, { expiresAt, user: owner });
});

test("signed-in owner inspects the same profile-filtered nodes in the Structure list and map, and exports stay the exact API artifact", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const state = await installMockArchitectureRoutes(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/architectures");

  await expect(page.getByRole("complementary", { name: "Primary navigation" })).toBeVisible();
  await expect(page.locator(".side-nav").getByRole("link", { name: "Architectures" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main", { name: "Skill architectures" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill architectures", level: 1 })).toBeVisible();

  const architectureRow = page.getByRole("button", { name: /Review assistant/ });
  await architectureRow.focus();
  await expect(architectureRow).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Review assistant" })).toBeVisible();

  const profile = page.getByLabel("Preview profile");
  const environment = page.getByLabel("Preview environment");
  await profile.selectOption("personal");
  await environment.selectOption("personal-laptop");
  await expect(profile).toHaveValue("personal");
  await expect(environment).toHaveValue("personal-laptop");
  await expect.poll(() => state.previewContexts.some((context) => (
    context.profileId === "personal" && context.environmentId === "personal-laptop"
  ))).toBe(true);

  // Structure is the default tab. With exposed nodes shown, the list holds
  // exactly the server's graph and outline for this context.
  await expect(ui.tab(page, "Structure")).toHaveAttribute("aria-selected", "true");
  const explorer = ui.explorer(page);
  await expect(ui.row(page, "personal-root")).toBeVisible();
  await chooseExposure(page, "Exposed only");
  await expandAllNodes(page);
  await expect.poll(() => visibleNodeIds(page)).toEqual(["personal-domain", "personal-root", "release-notes"]);
  await expect(explorer).not.toContainText("Work Deploy Helper");
  await expect(explorer).not.toContainText("Work review router");
  // The owner may also list the revision's disabled nodes, never others.
  if (await chooseExposure(page, "All nodes")) {
    await expandAllNodes(page);
    const allIds = await visibleNodeIds(page);
    expect(allIds).toEqual(expect.arrayContaining(["personal-domain", "personal-root", "release-notes"]));
    expect(["personal-domain", "personal-root", "release-notes", "work-deploy", "work-domain"]).toEqual(expect.arrayContaining(allIds));
    await chooseExposure(page, "Exposed only");
  }

  // Nesting follows the outline: the leaf's path names both routers.
  const leafSelect = ui.rowSelect(ui.row(page, "release-notes"));
  await leafSelect.click();
  await expect(leafSelect).toHaveAttribute("aria-current", "true");
  const inspector = ui.inspector(page);
  await expect(inspector).toContainText("Release Notes Helper");
  await expect(inspector).toContainText("Personal router");
  await expect(inspector).toContainText("Personal review router");
  await expect(inspector).toContainText("0.1.0");
  await expect(ui.editInWorkbench(page)).toBeVisible();
  await expectArchitectureUrl(page, { id: "architecture-1", context: { profile: "personal", environment: "personal-laptop" }, node: "release-notes" });

  // The map is complementary: same selection, readable labels, same projection.
  await ui.view(page, "Map").click();
  await expect(ui.view(page, "Map")).toHaveAttribute("aria-pressed", "true");
  const map = ui.map(page);
  await expect(map).toBeVisible();
  await expect(inspector).toContainText("Release Notes Helper");
  const routerLabel = map.getByText("Personal review router", { exact: true }).first();
  await expect(routerLabel).toBeVisible();
  expect(await effectiveFontSize(routerLabel)).toBeGreaterThanOrEqual(MIN_LEGIBLE_LABEL_PX);
  await expect(map).not.toContainText("Work Deploy Helper");
  await expectArchitectureUrl(page, { id: "architecture-1", context: { profile: "personal", environment: "personal-laptop" }, node: "release-notes", view: "map" });
  await ui.view(page, "List").click();
  await expect(leafSelect).toHaveAttribute("aria-current", "true");

  // After list, map, filter and selection changes, exports are still the
  // exact artifact the API returned for this context.
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy canonical diagram JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download canonical diagram JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Mermaid architecture export" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Mermaid architecture export" })).toBeVisible();
  await expect(page.getByText("Plain-text outline fallback")).toBeVisible();
  const apiDiagram = state.previewDiagrams.filter((diagram) => diagram.profileId === "personal").at(-1)!;
  const { artifactDigest: _artifactDigest, ...semanticDiagram } = apiDiagram;
  const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());
  await page.getByRole("button", { name: "Copy Mermaid architecture export" }).click();
  await expect.poll(readClipboard).toBe(apiDiagram.mermaid);
  await page.getByRole("button", { name: "Copy canonical diagram JSON" }).click();
  await expect.poll(readClipboard).toMatch(/^\{/);
  expect(JSON.parse(await readClipboard())).toEqual(semanticDiagram);

  // Skills search and filters never reveal skills outside the context.
  await ui.tab(page, "Skills").click();
  await expect(ui.skillsPanel(page).getByRole("cell", { name: "0.1.0" })).toBeVisible();
  await expect(ui.skillsTable(page)).toContainText(ui.readableLeafExposure);
  await expect(ui.skillsTable(page)).not.toContainText("personal-laptop");
  await ui.skillsSearch(page).fill("deploy");
  await expect(ui.skillRows(page)).toHaveCount(0);
  await ui.skillsSearch(page).fill("release");
  await expect(ui.skillRows(page)).toHaveCount(1);
  await ui.tab(page, "Structure").click();
  await expect(page.getByText("No sync plan generated. Provide an observed-state fixture to preview a target dry run.")).toBeVisible();


  await page.getByText("Compare observed-state fixture").click();
  await page.getByLabel("Observed-state fixture JSON").fill('{"targetId":"codex-personal","nodes":[]}');
  await page.getByRole("button", { name: "Generate dry-run plan" }).click();
  await expect(page.getByText("Dry-run plan generated from the supplied observed state. No target was changed.")).toBeVisible();
  await expect(page.getByText("Target already matches the selected desired state.")).toBeVisible();
  await expect.poll(() => state.fixturePreviewRequests).toBe(1);
});

test("owner creates a private draft without a preview and the narrow layout remains usable", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { includeExistingArchitecture: false });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/architectures");

  const name = page.getByLabel("Architecture name");
  await name.focus();
  await page.keyboard.type("Private experiment");
  const create = page.getByRole("button", { name: "Create architecture" });
  await create.focus();
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");

  // Creating a shell opens its bootstrap Workbench; the overview keeps the empty state.
  await expect(page.getByRole("heading", { name: "Private experiment" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Skill architectures" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build the first revision" })).toBeVisible();
  const measure = () => page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".architecture-workspace")!.getBoundingClientRect();
    return {
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      workspaceLeft: workspace.left,
      workspaceRight: workspace.right,
    };
  });
  const workbenchMeasurements = await measure();
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(page.getByText("No revision yet. Build and save the first revision in the workbench.")).toBeVisible();
  await expect(ui.explorer(page)).toHaveCount(0);
  await expect.poll(() => state.draftPreviewAttempts).toBe(0);
  expect(state.createdBodies).toEqual([{
    name: "Private experiment",
    patternId: "multi-level-router",
    owner: { type: "user" },
  }]);

  for (const measurements of [workbenchMeasurements, await measure()]) {
    expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewportWidth);
    expect(measurements.workspaceLeft).toBeGreaterThanOrEqual(0);
    expect(measurements.workspaceRight).toBeLessThanOrEqual(375.5);
  }
});

test("owner saves and confirms organization access revocation in Sharing, then retries a migration from Change pattern with the same idempotency key", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { failFirstMigrationCreate: true });
  await page.goto("/architectures");

  await expect(page.getByRole("heading", { name: "Review assistant", level: 2 })).toBeVisible();
  // Sharing is the last section tab and is reachable from the keyboard.
  await expect(ui.tab(page, "Sharing")).toBeVisible();
  await ui.tab(page, "Structure").focus();
  await page.keyboard.press("End");
  await expect(ui.tab(page, "Sharing")).toHaveAttribute("aria-selected", "true");
  await expect(ui.tab(page, "Sharing")).toBeFocused();
  const sharing = ui.tabPanel(page, "Sharing");
  // Pattern migration no longer lives in Sharing.
  await expect(sharing.getByLabel("Target pattern")).toHaveCount(0);
  const organizationCheckbox = page.getByRole("checkbox", { name: "Share with Phase 2 UAT Organization" });
  await expect(organizationCheckbox).toBeVisible();
  await organizationCheckbox.check();
  await page.getByRole("button", { name: "Save organization access" }).click();
  await expect.poll(() => state.organizationGrantBodies.length).toBe(1);
  expect(state.organizationGrantBodies[0]?.organizationIds).toEqual(["org-phase2"]);
  await expect(page.getByRole("button", { name: "Revoke all" })).toBeEnabled();

  await page.getByRole("button", { name: "Revoke all" }).click();
  await expect(page.getByRole("button", { name: "Confirm revoke all" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm revoke all" }).click();
  await expect.poll(() => state.organizationGrantBodies.length).toBe(2);
  expect(state.organizationGrantBodies[1]?.organizationIds).toEqual([]);

  const changePattern = ui.changePattern(page);
  await expect(changePattern).toHaveAttribute("aria-expanded", "false");
  await changePattern.click();
  await expect(changePattern).toHaveAttribute("aria-expanded", "true");
  await page.getByLabel("Target pattern").selectOption("domain-router");
  await page.getByRole("button", { name: "Preview migration" }).click();
  await expect(page.getByText("Migration preview ready. The source architecture is unchanged.")).toBeVisible();
  await expect.poll(() => state.migrationPreviewBodies.length).toBe(1);
  expect(state.migrationPreviewBodies[0]?.targetPatternId).toBe("domain-router");
  await page.getByLabel("Derived architecture name").fill("Domain review assistant");
  await page.getByRole("button", { name: "Review create" }).click();
  await page.getByRole("button", { name: "Confirm create derived shell" }).click();
  const retry = page.getByRole("button", { name: "Retry create" });
  await expect(retry).toBeVisible();
  // Closing and reopening the disclosure keeps the pending retry and its key.
  await changePattern.click();
  await expect(changePattern).toHaveAttribute("aria-expanded", "false");
  await expect(retry).toBeHidden();
  await changePattern.click();
  await retry.click();
  await expect.poll(() => state.migrationCreateBodies.length).toBe(2);
  expect(state.migrationCreateBodies[0]?.idempotencyKey).toBeTruthy();
  expect(state.migrationCreateBodies[1]?.idempotencyKey).toBe(state.migrationCreateBodies[0]?.idempotencyKey);
  expect(state.migrationCreateReplayed).toBe(true);
});

test("owner can create a team-owned shell and unsaved editor changes guard unload and architecture selection", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { includeSecondArchitecture: true, includeTeamOwner: true });
  await page.goto("/architectures");

  await page.getByRole("button", { name: "New architecture", exact: true }).click();
  await page.getByLabel("Architecture owner").selectOption("team:team-review");
  await page.getByLabel("Architecture name").first().fill("Team review routing");
  await page.getByRole("button", { name: "Create architecture" }).click();
  await expect.poll(() => state.createdBodies.length).toBe(1);
  expect(state.createdBodies[0]?.owner).toEqual({ type: "team", id: "team-review" });
  await expect(page.getByRole("heading", { name: "Team review routing", level: 1 })).toBeVisible();
  await expect(page.getByTestId("architecture-editor")).toBeVisible();

  await page.getByLabel("Selected node label").fill("Unsaved team router");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  const beforeUnloadPrevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(beforeUnloadPrevented).toBe(true);

  let acceptDiscard = false;
  page.on("dialog", async (dialog) => {
    if (acceptDiscard) await dialog.accept();
    else await dialog.dismiss();
  });
  // Returning to the same architecture's overview keeps the draft without a prompt.
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(page.getByRole("link", { name: "Resume draft", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Review assistant/ }).click();
  await expect(page.getByRole("heading", { name: "Team review routing", level: 2 })).toBeVisible();
  acceptDiscard = true;
  await page.getByRole("button", { name: /Review assistant/ }).click();
  await expect(page.getByRole("heading", { name: "Review assistant", level: 2 })).toBeVisible();
});

test("owner registers a guided read-only target and confirms permanent revocation", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page);
  await page.goto("/targets");

  await expect(page.getByRole("heading", { name: "Connected targets", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Register read-only target", exact: true }).click();
  await expect(page.getByLabel("Authorized target owner")).toHaveValue("user:user-owner");
  await expect(page.getByLabel("Target architecture")).toHaveValue("architecture-1");
  await page.getByLabel("Target profile").selectOption("personal");
  await expect(page.getByLabel("Target profile")).toHaveValue("personal");
  await page.getByLabel("Target logical environment").selectOption("personal-laptop");
  await expect(page.getByLabel("Target logical environment")).toHaveValue("personal-laptop");

  await page.getByLabel("Target name").fill("Phase 2 UAT Codex");
  await page.getByRole("button", { name: "Register target" }).click();
  await expect.poll(() => state.targetRegistrationBodies.length).toBe(1);
  expect(state.targetRegistrationBodies[0]?.owner).toEqual({ type: "user", id: "user-owner" });
  expect(state.targetRegistrationBodies[0]?.architectureId).toBe("architecture-1");
  expect(state.targetRegistrationBodies[0]?.profileId).toBe("personal");
  expect(state.targetRegistrationBodies[0]?.environmentId).toBe("personal-laptop");
  await expect(page.getByRole("heading", { name: "Phase 2 UAT Codex", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Revoke target" }).click();
  await expect(page.getByRole("button", { name: "Confirm revoke" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm revoke" }).click();
  await expect.poll(() => state.targetRevokeRequests).toBe(1);
  await expect(page.getByText("Revoked", { exact: true }).first()).toBeVisible();
});

// Test-first Wave 3: work is visible before setup, and mobile navigation
// retains focus and the unsaved-draft boundary exercised above.
for (const width of [1280, 390]) test(`architecture workspace puts saved work first and restores list focus at ${width}`, async ({ page }, info) => {
  await installMockArchitectureRoutes(page, { includeSecondArchitecture: true });
  await page.setViewportSize({ width, height: width === 1280 ? 720 : 844 });
  await page.goto("/architectures");
  const row = page.getByRole("button", { name: /Review assistant/ });
  await expect(row).toBeInViewport();
  await expect(page.locator(".architecture-create-form").getByLabel("Architecture name", { exact: true })).toBeHidden();
  await row.click();
  const title = page.getByRole("heading", { name: "Review assistant", level: 2 });
  await expect(title).toBeInViewport();
  if (width === 390) {
    await expect(title).toBeFocused();
    await expect(row).toBeHidden();
    await page.getByRole("button", { name: "Back to architectures", exact: true }).click();
    await expect(row).toBeFocused();
  } else await expect(row).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("architecture-work-first.png") });
});

for (const width of [1280, 390]) test(`architecture draft survives New and mobile Back without weakening discard protection at ${width}`, async ({ page }, info) => {
  await installMockArchitectureRoutes(page, { includeSecondArchitecture: true });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/architectures");
  const row = page.getByRole("button", { name: /Review assistant/ });
  await row.click();
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  // Phones show the canvas first; node details sit behind the pane switch.
  if (width === 390) await page.getByRole("button", { name: "Outline & details" }).click();
  await page.getByLabel("Selected node label").fill("Uncommitted review router");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  const resume = page.getByRole("link", { name: "Resume draft", exact: true });
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(resume).toBeVisible();
  await page.getByRole("button", { name: "New architecture", exact: true }).click();
  await expect(page.locator(".architecture-create-form").getByLabel("Architecture name", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await resume.click();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Uncommitted review router");
  let dialogs = 0;
  page.on("dialog", async dialog => { dialogs += 1; await dialog.dismiss(); });
  await page.getByRole("link", { name: "Architecture overview" }).click();
  if (width === 390) {
    await page.getByRole("button", { name: "Back to architectures", exact: true }).click();
    await expect(row).toBeFocused();
    await row.click();
    await resume.click();
    await expect(page.getByLabel("Selected node label")).toHaveValue("Uncommitted review router");
    expect(dialogs).toBe(0);
    await page.getByRole("link", { name: "Architecture overview" }).click();
    await page.getByRole("button", { name: "Back to architectures", exact: true }).click();
  }
  await page.getByRole("button", { name: /Operations assistant/ }).click();
  await expect.poll(() => dialogs).toBe(1);
  if (width === 390) await row.click();
  await resume.click();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Uncommitted review router");
  await info.attach("draft-safety", { body: JSON.stringify({ width, rejectedDiscard: dialogs, preservedLabel: "Uncommitted review router" }), contentType: "application/json" });
});

for (const width of [1280, 390]) test(`target registration is on demand and preserves the binding draft at ${width}`, async ({ page }, info) => {
  const state = await installMockArchitectureRoutes(page);
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/targets");
  await expect(page.getByRole("heading", { name: "Connect your skills" })).toBeVisible();
  const name = page.getByLabel("Target name", { exact: true });
  await expect(name).toBeHidden();
  const opener = page.getByRole("button", { name: "Register read-only target", exact: true }).first();
  await opener.click();
  await expect(name).toBeFocused();
  await name.fill("Draft workstation");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(name).toHaveValue("Draft workstation");
  await page.getByLabel("Target profile").selectOption("personal");
  await page.getByLabel("Target logical environment").selectOption("personal-laptop");
  await page.getByRole("button", { name: "Register target", exact: true }).click();
  const heading = page.getByRole("heading", { name: "Draft workstation", level: 2 });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  expect(state.targetRegistrationBodies).toHaveLength(1);
  expect(state.targetRegistrationBodies[0]).toMatchObject({ owner: { type: "user", id: "user-owner" }, architectureId: "architecture-1", profileId: "personal", environmentId: "personal-laptop" });
  await expect(page.getByText("Review assistant", { exact: true })).toBeVisible();
  if (width === 390) {
    await page.getByRole("button", { name: "Back to targets", exact: true }).click();
    await expect(page.getByRole("button", { name: /Draft workstation/ })).toBeFocused();
  }
  await info.attach("registered-binding", { body: JSON.stringify(state.targetRegistrationBodies, null, 2), contentType: "application/json" });
});

// Work-pilot contract: the browser generates local CLI instructions from real
// architecture bindings; changing scope must not create a target or leak paths.
for (const width of [1280, 390]) test(`scope setup generates bound Claude project commands and preserves managed Codex at ${width}`, async ({ page, context }, info) => {
  const state = await installMockArchitectureRoutes(page, { includeSecondArchitecture: true, authorOnly: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/targets");
  const guide = page.getByRole("region", { name: "Connect your skills" });
  await expect(guide).toBeVisible();
  await guide.getByLabel("Provider", { exact: true }).selectOption("claude");
  await guide.getByLabel("Connection type").selectOption("project");
  await guide.getByLabel("CLI configuration profile").fill("work");
  await guide.getByLabel("Setup architecture", { exact: true }).selectOption("architecture-1");
  await guide.getByLabel("Architecture profile", { exact: true }).selectOption("personal");
  await guide.getByLabel("Logical environment").selectOption("personal-laptop");
  await guide.getByLabel("Setup architecture", { exact: true }).selectOption("architecture-2");
  await guide.getByLabel("Architecture profile", { exact: true }).selectOption("work");
  await expect(guide.getByLabel("Logical environment")).toHaveValue("codex-work");
  await expect(guide.getByLabel("Logical environment").locator("option")).toHaveCount(1);
  const commands = guide.getByLabel("Enrollment commands", { exact: true });
  await expect(commands).toContainText('npm install -g @jarel/myskills@beta');
  await expect(commands).toContainText(`scopes enroll --provider claude --scope project --project '/absolute/existing/project with spaces'`);
  await expect(commands).toContainText(`--architecture-id 'architecture-2' --environment-id 'codex-work' --profile-id 'work'`);
  await expect(commands).toContainText("--config-profile 'work'");
  await expect(commands).not.toContainText("ARCHITECTURE_ID");
  await expect(commands).toContainText(`scopes inventory --provider claude --root '/absolute/existing/project with spaces/.claude/skills'`);
  await guide.getByRole("button", { name: "Copy enrollment commands" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await commands.textContent());
  await guide.getByLabel("Connection type").selectOption("global");
  await expect(commands).toContainText(`scopes enroll --provider claude --scope global --root '/absolute/existing/skills'`);
  await expect(commands).not.toContainText("--project");
  await guide.getByLabel("Provider", { exact: true }).selectOption("codex");
  await guide.getByLabel("Connection type").selectOption("managed");
  await expect(commands).toContainText(`codex enroll --workspace '/absolute/existing/workspace'`);
  await expect(commands).not.toContainText("scopes enroll");
  await expect(guide.getByText("Install, update, and recover managed skills", { exact: true })).toBeVisible();
  await guide.getByLabel("CLI configuration profile").fill('work; touch /tmp/unwanted');
  await expect(guide.getByRole("button", { name: "Copy enrollment commands" })).toBeDisabled();
  await expect(commands).toHaveCount(0);
  await guide.getByLabel("CLI configuration profile").fill("");
  await expect(commands).not.toContainText("--config-profile");
  await guide.getByLabel("CLI configuration profile").fill("work");
  await page.getByRole("heading", { name: "Connect your skills" }).focus();
  expect(state.targetRegistrationBodies).toEqual([]);
  expect(state.createdBodies).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`scope-guide-${width}.png`), fullPage: true });
  await info.attach("scope-commands", { body: await commands.textContent() ?? "", contentType: "text/plain" });
});

test("scope setup with no owned architecture offers the existing creation flow without fabricated IDs", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { includeExistingArchitecture: false });
  await page.goto("/targets");
  const guide = page.getByRole("region", { name: "Connect your skills" });
  await expect(guide.getByText("Create a personal architecture and save a revision before enrollment.", { exact: true })).toBeVisible();
  await expect(guide).toContainText("choose at least one reviewed skill from Skills");
  await expect(guide.getByRole("link", { name: "Create or edit an architecture" })).toHaveAttribute("href", "/architectures");
  await expect(guide.getByLabel("Enrollment commands", { exact: true })).toHaveCount(0);
  expect(state.targetRegistrationBodies).toEqual([]);
});

test("an incomplete connected inventory explains omissions using bounded findings without rendering raw metadata", async ({ page }, info) => {
  await installMockArchitectureRoutes(page, { scopeInventoryTarget: true });
  await page.goto("/targets");
  const detail = page.getByRole("article", { name: "Work Claude inventory" });
  await expect(detail).toBeVisible();
  await expect(detail.getByText("Claude", { exact: true })).toBeVisible();
  await expect(detail.getByText("Project inventory", { exact: true })).toBeVisible();
  await expect(detail.getByText("Connected", { exact: true })).toBeVisible();
  await expect(detail.getByText("Inventory incomplete", { exact: true })).toBeVisible();
  await expect(detail.getByText("Last observed", { exact: true })).toBeVisible();
  await expect(detail.getByText("skill-linked", { exact: true })).toBeVisible();
  await expect(detail.getByText("Linked skill directories were not followed.", { exact: true })).toBeVisible();
  await expect(detail.getByText("2", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("inventory-truncated", { exact: true })).toBeVisible();
  await expect(detail.getByText("The inventory limit was reached; some entries were not listed.", { exact: true })).toBeVisible();
  await expect(detail).not.toContainText("DO_NOT_RENDER_LOCAL_METADATA");
  await expect(detail).not.toContainText("Connection failed");
  await expect(detail.getByText("Inventory does not confirm that Claude recognizes or loads these skills.", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("incomplete-inventory.png"), fullPage: true });
});

interface MockArchitectureState {
  createdBodies: Array<Record<string, unknown>>;
  draftPreviewAttempts: number;
  fixturePreviewRequests: number;
  previewContexts: Array<{ profileId?: string; environmentId?: string }>;
  /** Diagram artifacts exactly as returned by each preview response. */
  previewDiagrams: Array<Record<string, unknown>>;
  organizationGrantBodies: Array<Record<string, unknown>>;
  migrationPreviewBodies: Array<Record<string, unknown>>;
  migrationCreateBodies: Array<Record<string, unknown>>;
  migrationCreateReplayed: boolean;
  targetRegistrationBodies: Array<Record<string, unknown>>;
  targetRevokeRequests: number;
}

async function installMockArchitectureRoutes(
  page: Page,
  options: MockArchitectureOptions = {},
): Promise<MockArchitectureState> {
  const account = options.authorOnly ? { ...owner, roles: ["author"] } : owner;
  if (options.authorOnly) await page.addInitScript(({ expiresAt: expiry, user }) => {
    if (location.origin !== "null") window.localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: expiry, user }));
  }, { expiresAt, user: account });
  const state: MockArchitectureState = {
    createdBodies: [],
    draftPreviewAttempts: 0,
    fixturePreviewRequests: 0,
    previewContexts: [],
    previewDiagrams: [],
    organizationGrantBodies: [],
    migrationPreviewBodies: [],
    migrationCreateBodies: [],
    migrationCreateReplayed: false,
    targetRegistrationBodies: [],
    targetRevokeRequests: 0,
  };
  const architecture = {
    id: "architecture-1",
    ownerUserId: owner.id,
    ownerTeamId: null,
    owner: { type: "user", id: owner.id },
    ownerType: "user",
    ownerId: owner.id,
    accessPolicyVersion: 1,
    access: {
      owner: { type: "user", id: owner.id },
      ownerType: "user",
      ownerId: owner.id,
      policyVersion: 1,
      accessPolicyVersion: 1,
      role: "owner",
      canList: true,
      canRead: true,
      canPreview: true,
      canCreate: true,
      canAppend: true,
      canManage: true,
      reasons: ["owner"],
    },
    name: "Review assistant",
    description: "Routes review work to the right personal skills.",
    patternId: "multi-level-router",
    currentRevisionId: "revision-1",
    revisionCount: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
  const revision = {
    id: "revision-1",
    architectureId: architecture.id,
    revisionNumber: 1,
    message: "Personal profile",
    createdByUserId: owner.id,
    createdAt: "2026-08-30T00:00:00.000Z",
    spec: {
      schemaVersion: 1,
      id: architecture.id,
      name: architecture.name,
      pattern: { id: "multi-level-router", version: 1 },
      skills: [
        { id: "release-notes", slug: "release-notes-helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" },
        { id: "work-deploy", slug: "work-deploy-helper", version: "1.0.0", digest: "b".repeat(64), packageVisibility: "private" },
      ],
      nodes: [
        { id: "personal-root", kind: "router", label: "Personal router" },
        { id: "personal-domain", kind: "router", label: "Personal review router" },
        { id: "work-domain", kind: "router", label: "Work review router" },
        { id: "release-notes", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-notes" },
        { id: "work-deploy", kind: "leaf", label: "Work Deploy Helper", skillRefId: "work-deploy" },
      ],
      edges: [
        { from: "personal-root", to: "personal-domain", kind: "contains" },
        { from: "personal-domain", to: "release-notes", kind: "routes" },
        { from: "personal-root", to: "work-domain", kind: "contains" },
        { from: "work-domain", to: "work-deploy", kind: "routes" },
      ],
      entryNodeIds: ["personal-root"],
      profiles: [
        {
          id: "work",
          name: "Work",
          subject: { type: "user", id: owner.id },
          defaultExposure: "disabled",
          bindings: [
            { nodeId: "personal-root", enabled: true, runtimeExposure: "router" },
            { nodeId: "work-domain", enabled: true, runtimeExposure: "router" },
            { nodeId: "work-deploy", enabled: true, runtimeExposure: "leaf" },
          ],
        },
        {
          id: "personal",
          name: "Personal",
          subject: { type: "user", id: owner.id },
          defaultExposure: "disabled",
          bindings: [
            { nodeId: "personal-root", enabled: true, runtimeExposure: "router" },
            { nodeId: "personal-domain", enabled: true, runtimeExposure: "router" },
            { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
          ],
        },
      ],
      environments: [
        { id: "codex-work", name: "Codex work", kind: "work", profileId: "work" },
        { id: "local", name: "Local development", kind: "personal", profileId: "personal" },
        { id: "personal-laptop", name: "Personal laptop", kind: "personal", profileId: "personal" },
      ],
    },
  };
  const secondArchitecture = {
    ...architecture,
    id: "architecture-2",
    name: "Operations assistant",
    description: "A second shell used to verify selection guards.",
    currentRevisionId: "revision-2",
    revisionCount: 1,
  };
  const secondRevision = {
    ...revision,
    id: "revision-2",
    architectureId: secondArchitecture.id,
    spec: {
      ...revision.spec,
      id: secondArchitecture.id,
      name: secondArchitecture.name,
    },
  };
  const organization = {
    id: "org-phase2",
    name: "Phase 2 UAT Organization",
    slug: "phase-2-uat",
    status: "active",
    currentPolicyRevisionId: "policy-phase2",
    createdByUserId: owner.id,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    role: "owner",
  };
  const team = {
    id: "team-review",
    name: "Review team",
    slug: "review-team",
    organizationId: null,
    role: "owner",
    members: [],
    invitations: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
  let createdArchitecture: Record<string, unknown> | null = null;
  let createdTarget: Record<string, unknown> | null = options.scopeInventoryTarget ? {
    schemaVersion: 1, id: "target-scope", name: "Work Claude inventory",
    owner: { type: "user", id: owner.id }, adapter: { kind: "claude-inventory", version: "1.0.0", contractVersion: 1 },
    architectureId: architecture.id, environmentId: "codex-work", profileId: "work", status: "connected",
    consent: { status: "granted" }, generation: 1, identityDigest: "f".repeat(64),
    capabilities: { "inventory.read": true, "health.read": true, "plan.read": false },
    metadata: { provider: "claude", scope: "project" }, health: { status: "degraded", checkedAt: "2026-09-29T01:00:00.000Z" },
  } : null;
  const scopeObservations = options.scopeInventoryTarget ? [{
    schemaVersion: 1, id: "observation-scope", targetId: "target-scope", targetGeneration: 1,
    adapterDigest: "a".repeat(64), capabilitiesDigest: "b".repeat(64), observedDigest: "c".repeat(64),
    observedAt: "2026-09-29T01:00:00.000Z", skills: [{ slug: "review-helper" }],
    configFindings: [{ code: "skill-linked", severity: "warning", count: 2 }, { code: "inventory-truncated", severity: "error", count: 1 }],
    promptAwareness: { detected: false, count: 0, redacted: true },
    metadata: { provider: "claude", scope: "project", inventoryComplete: false, runtimeRecognized: false, extra: "DO_NOT_RENDER_LOCAL_METADATA" },
  }] : [];
  let organizationGrantIds: string[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : {};

    if (path === "/v1/me") return json(route, 200, { user: account });
    if (path === "/v1/architecture-patterns") {
      return json(route, 200, {
        patterns: [
          {
            id: "multi-level-router",
            version: 1,
            name: "Multi-level router",
            description: "Nested routers route to other routers and leaf skills.",
            supportsNestedRouters: true,
          },
          {
            id: "domain-router",
            version: 1,
            name: "Domain router",
            description: "Route requests through a domain branch before a leaf.",
            supportsNestedRouters: false,
          },
          {
            id: "flat",
            version: 1,
            name: "Flat library",
            description: "Expose a curated set of skills from one entry point.",
            supportsNestedRouters: false,
          },
        ],
      });
    }
    if (path === "/v1/teams" && method === "GET") {
      return json(route, 200, { teams: options.includeTeamOwner ? [team] : [], invitations: [] });
    }
    if (path === "/v1/organizations" && method === "GET") {
      return json(route, 200, { organizations: [organization] });
    }
    if (path === "/v1/architectures" && method === "GET") {
      const rows = options.includeExistingArchitecture === false
        ? []
        : [architecture, ...(options.includeSecondArchitecture ? [secondArchitecture] : []), ...(createdArchitecture ? [createdArchitecture] : [])];
      return json(route, 200, { architectures: rows });
    }
    if (path === "/v1/architectures" && method === "POST") {
      state.createdBodies.push(body);
      const requestedOwner = body.owner && typeof body.owner === "object"
        ? body.owner as Record<string, unknown>
        : { type: "user" };
      const isTeamOwned = requestedOwner.type === "team";
      createdArchitecture = {
        id: isTeamOwned ? "team-architecture" : "architecture-draft",
        ownerUserId: isTeamOwned ? null : owner.id,
        ownerTeamId: isTeamOwned ? "team-review" : null,
        owner: isTeamOwned ? { type: "team", id: "team-review" } : { type: "user", id: owner.id },
        ownerType: isTeamOwned ? "team" : "user",
        ownerId: isTeamOwned ? "team-review" : owner.id,
        accessPolicyVersion: 1,
        access: {
          owner: isTeamOwned ? { type: "team", id: "team-review" } : { type: "user", id: owner.id },
          ownerType: isTeamOwned ? "team" : "user",
          ownerId: isTeamOwned ? "team-review" : owner.id,
          policyVersion: 1,
          accessPolicyVersion: 1,
          role: "owner",
          canList: true,
          canRead: true,
          canPreview: true,
          canCreate: true,
          canAppend: true,
          canManage: true,
          reasons: ["owner"],
        },
        name: body.name,
        description: typeof body.description === "string" ? body.description : "",
        patternId: body.patternId,
        currentRevisionId: null,
        revisionCount: 0,
        createdAt: "2026-08-30T00:10:00.000Z",
        updatedAt: "2026-08-30T00:10:00.000Z",
      };
      return json(route, 201, { architecture: createdArchitecture });
    }

    const architectureMatch = path.match(/^\/v1\/architectures\/([^/]+)$/);
    if (architectureMatch && method === "GET") {
      if (architectureMatch[1] === "architecture-draft" || (architectureMatch[1] === "team-architecture" && createdArchitecture)) {
        const draft = createdArchitecture?.id === architectureMatch[1] ? createdArchitecture : {
          id: "architecture-draft",
          ownerUserId: owner.id,
          ownerTeamId: null,
          owner: { type: "user", id: owner.id },
          ownerType: "user",
          ownerId: owner.id,
          accessPolicyVersion: 1,
          access: {
            owner: { type: "user", id: owner.id },
            ownerType: "user",
            ownerId: owner.id,
            policyVersion: 1,
            accessPolicyVersion: 1,
            role: "owner",
            canList: true,
            canRead: true,
            canPreview: true,
            canCreate: true,
            canAppend: true,
            canManage: true,
            reasons: ["owner"],
          },
          name: "Private experiment",
          description: "",
          patternId: "multi-level-router",
          currentRevisionId: null,
          revisionCount: 0,
          createdAt: "2026-08-30T00:10:00.000Z",
          updatedAt: "2026-08-30T00:10:00.000Z",
        };
        return json(route, 200, {
          architecture: draft,
          revisions: [],
          latestRevision: null,
        });
      }
      if (architectureMatch[1] === secondArchitecture.id) {
        return json(route, 200, {
          architecture: secondArchitecture,
          revisions: [{ id: secondRevision.id, architectureId: secondRevision.architectureId, revisionNumber: secondRevision.revisionNumber, patternId: secondArchitecture.patternId }],
          latestRevision: secondRevision,
        });
      }
      if (createdArchitecture?.id === architectureMatch[1]) {
        return json(route, 200, { architecture: createdArchitecture, revisions: [], latestRevision: null });
      }
      return json(route, 200, { architecture, revisions: [{ id: revision.id, architectureId: revision.architectureId, revisionNumber: revision.revisionNumber, patternId: architecture.patternId }], latestRevision: revision });
    }

    const organizationGrantMatch = path.match(/^\/v1\/architectures\/([^/]+)\/organization-grants$/);
    if (organizationGrantMatch) {
      const architectureId = organizationGrantMatch[1];
      if (method === "GET") {
        return json(route, 200, {
          architectureId,
          currentRevisionId: architectureId === architecture.id ? revision.id : null,
          grants: organizationGrantIds.map((organizationId) => ({ architectureId, organizationId })),
          organizationIds: organizationGrantIds,
          addedOrganizationIds: [],
          removedOrganizationIds: [],
          changed: false,
        });
      }
      if (method === "PUT") {
        const previousIds = organizationGrantIds;
        const nextIds = Array.isArray(body.organizationIds)
          ? [...new Set(body.organizationIds.filter((id): id is string => typeof id === "string"))].sort((left, right) => left.localeCompare(right))
          : [];
        state.organizationGrantBodies.push(body);
        organizationGrantIds = nextIds;
        return json(route, 200, {
          architectureId,
          currentRevisionId: architectureId === architecture.id ? revision.id : null,
          grants: nextIds.map((organizationId) => ({ architectureId, organizationId })),
          organizationIds: nextIds,
          addedOrganizationIds: nextIds.filter((id) => !previousIds.includes(id)),
          removedOrganizationIds: previousIds.filter((id) => !nextIds.includes(id)),
          changed: previousIds.join("\u0000") !== nextIds.join("\u0000"),
        });
      }
    }

    const migrationPreviewMatch = path.match(/^\/v1\/architectures\/([^/]+)\/pattern-migrations\/preview$/);
    if (migrationPreviewMatch && method === "POST") {
      state.migrationPreviewBodies.push(body);
      const targetPatternId = typeof body.targetPatternId === "string" ? body.targetPatternId : "domain-router";
      const targetSpec = {
        ...revision.spec,
        pattern: { id: targetPatternId, version: 1 },
      };
      const migration = {
        schemaVersion: 1,
        mode: "derive-shell",
        source: {
          architectureId: migrationPreviewMatch[1],
          patternId: revision.spec.pattern.id,
          revisionDigest: "c".repeat(64),
        },
        mappingStatus: body.mapping ? "provided" : "deterministic",
        target: {
          patternId: targetPatternId,
          spec: targetSpec,
          revisionDigest: "f".repeat(64),
        },
        diff: {
          preservedSkillRefIds: ["release-notes", "work-deploy"],
          preservedLeafNodeIds: ["release-notes", "work-deploy"],
          addedRouterNodeIds: [],
          droppedRouterNodeIds: [],
          addedEdgeCount: 0,
          removedEdgeCount: 0,
          rewrittenBindingCount: 0,
        },
        issues: [],
        migrationDigest: "1".repeat(64),
        diffDigest: "2".repeat(64),
      };
      return json(route, 200, {
        sourceArchitectureId: migrationPreviewMatch[1],
        sourceRevisionId: revision.id,
        expectedCurrentRevisionId: body.expectedCurrentRevisionId,
        migration,
      });
    }

    const migrationCreateMatch = path.match(/^\/v1\/architectures\/([^/]+)\/pattern-migrations$/);
    if (migrationCreateMatch && method === "POST") {
      state.migrationCreateBodies.push(body);
      if (options.failFirstMigrationCreate && state.migrationCreateBodies.length === 1) {
        return json(route, 503, { error: { code: "MIGRATION_TEMPORARY_FAILURE", message: "The migration request is temporarily unavailable." } });
      }
      state.migrationCreateReplayed = state.migrationCreateBodies.length > 1;
      const targetPatternId = typeof body.targetPatternId === "string" ? body.targetPatternId : "domain-router";
      const targetSpec = { ...revision.spec, pattern: { id: targetPatternId, version: 1 } };
      return json(route, 201, {
        sourceArchitectureId: migrationCreateMatch[1],
        sourceRevisionId: revision.id,
        expectedCurrentRevisionId: body.expectedCurrentRevisionId,
        migration: {
          schemaVersion: 1,
          mode: "derive-shell",
          source: { architectureId: migrationCreateMatch[1], patternId: revision.spec.pattern.id, revisionDigest: "c".repeat(64) },
          mappingStatus: body.mapping ? "provided" : "deterministic",
          target: { patternId: targetPatternId, spec: targetSpec, revisionDigest: "f".repeat(64) },
          diff: { preservedSkillRefIds: ["release-notes", "work-deploy"], preservedLeafNodeIds: ["release-notes", "work-deploy"], addedRouterNodeIds: [], droppedRouterNodeIds: [], addedEdgeCount: 0, removedEdgeCount: 0, rewrittenBindingCount: 0 },
          issues: [],
          migrationDigest: "1".repeat(64),
          diffDigest: "2".repeat(64),
        },
        created: true,
        replayed: state.migrationCreateReplayed,
      });
    }

    if (path === "/v1/architecture-targets" && method === "GET") {
      return json(route, 200, { targets: createdTarget ? [createdTarget] : [] });
    }
    if (path === "/v1/architecture-targets" && method === "POST") {
      state.targetRegistrationBodies.push(body);
      createdTarget = {
        schemaVersion: 1,
        id: "target-phase2",
        name: typeof body.name === "string" ? body.name : "Phase 2 UAT Codex",
        owner: body.owner,
        adapter: body.adapter,
        architectureId: body.architectureId,
        environmentId: body.environmentId,
        profileId: body.profileId,
        status: "connected",
        consent: { status: "pending", requestedAt: "2026-08-30T00:15:00.000Z", grantedAt: null, deniedAt: null, revokedAt: null },
        generation: 1,
        identityDigest: "f".repeat(64),
        capabilities: body.capabilities ?? { "inventory.read": true, "health.read": true, "plan.read": true },
        metadata: { label: "phase2-uat" },
        createdAt: "2026-08-30T00:15:00.000Z",
        updatedAt: "2026-08-30T00:15:00.000Z",
      };
      return json(route, 201, { target: createdTarget });
    }
    const targetObservationMatch = path.match(/^\/v1\/architecture-targets\/([^/]+)\/observations$/);
    if (targetObservationMatch && method === "GET") {
      return json(route, 200, { observations: scopeObservations });
    }
    const targetMatch = path.match(/^\/v1\/architecture-targets\/([^/]+)$/);
    if (targetMatch && method === "GET") {
      if (!createdTarget || targetMatch[1] !== createdTarget.id) return json(route, 404, { error: { code: "TARGET_NOT_FOUND", message: "Target not found." } });
      return json(route, 200, { target: createdTarget });
    }
    if (targetMatch && method === "DELETE") {
      if (!createdTarget || targetMatch[1] !== createdTarget.id) return json(route, 404, { error: { code: "TARGET_NOT_FOUND", message: "Target not found." } });
      state.targetRevokeRequests += 1;
      createdTarget = { ...createdTarget, status: "revoked", consent: { ...(createdTarget.consent as Record<string, unknown>), status: "revoked", revokedAt: "2026-08-30T00:20:00.000Z" } };
      return json(route, 200, { target: createdTarget });
    }

    const previewMatch = path.match(/^\/v1\/architectures\/([^/]+)\/preview$/);
    if (previewMatch?.[1] === "architecture-draft") {
      state.draftPreviewAttempts += 1;
      return json(route, 404, { error: { code: "ARCHITECTURE_NOT_FOUND", message: "Architecture not found." } });
    }
    if (previewMatch) {
      const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
      const environmentId = typeof body.environmentId === "string" ? body.environmentId : undefined;
      state.previewContexts.push({ profileId, environmentId });
      const personal = profileId === "personal";
      const branch = personal
        ? { id: "personal-domain", kind: "router" as const, label: "Personal review router", depth: 1, x: 286, y: 124 }
        : { id: "work-domain", kind: "router" as const, label: "Work review router", depth: 1, x: 286, y: 124 };
      const leaf = personal
        ? { id: "release-notes", kind: "leaf" as const, label: "Release Notes Helper", depth: 2, x: 900, y: 380, skillRefId: "release-notes" }
        : { id: "work-deploy", kind: "leaf" as const, label: "Work Deploy Helper", depth: 2, x: 900, y: 380, skillRefId: "work-deploy" };
      const skill = personal
        ? { skillRefId: "release-notes", slug: "release-notes-helper", title: "Release Notes Helper", version: "0.1.0", digest: "a".repeat(64), packageVisibility: "private" }
        : { skillRefId: "work-deploy", slug: "work-deploy-helper", title: "Work Deploy Helper", version: "1.0.0", digest: "b".repeat(64), packageVisibility: "private" };
      const profile = profileId ?? "work";
      const environment = environmentId ?? "codex-work";
      const rootEdge = { from: "personal-root", to: branch.id, kind: "contains" as const };
      const leafEdge = { from: branch.id, to: leaf.id, kind: "routes" as const };
      if (body.fixture !== undefined) {
        state.fixturePreviewRequests += 1;
      }
      const diagram = {
        schemaVersion: 1,
        architectureId: architecture.id,
        revisionDigest: "c".repeat(64),
        profileId: profile,
        environmentId: environment,
        accessibleTitle: `Architecture ${architecture.id}`,
        accessibleDescription: "A deterministic topology projection.",
        mermaid: `flowchart TD\naccTitle: Architecture ${architecture.id}\naccDescr: A deterministic topology projection.\n  personal_root[Personal router] --> ${branch.id}[${branch.label}]\n  ${branch.id} --> ${leaf.id}[${leaf.label}]`,
        mermaidSha256: "d".repeat(64),
        accessibleOutline: `Architecture ${architecture.id}\n- Personal router (router)\n  - ${branch.label} (router)\n    - ${leaf.label} (leaf)`,
        artifactDigest: "e".repeat(64),
      };
      state.previewDiagrams.push(diagram);
      return json(route, 200, {
        revision,
        compiled: {
          schemaVersion: 1,
          architectureId: architecture.id,
          revisionDigest: "c".repeat(64),
          pattern: { id: "multi-level-router", version: 1 },
          profileId: profile,
          environmentId: environment,
          nodes: [
            { id: "personal-root", kind: "router", label: "Personal router", runtimeExposure: "router", childNodeIds: [branch.id] },
            { id: branch.id, kind: "router", label: branch.label, runtimeExposure: "router", childNodeIds: [leaf.id] },
            { id: leaf.id, kind: "leaf", label: leaf.label, skillRefId: leaf.skillRefId, runtimeExposure: "leaf", childNodeIds: [] },
          ],
          allNodes: [
            { id: "personal-root", kind: "router", label: "Personal router" },
            { id: "personal-domain", kind: "router", label: "Personal review router" },
            { id: "work-domain", kind: "router", label: "Work review router" },
            { id: "release-notes", kind: "leaf", label: "Release Notes Helper", skillRefId: "release-notes" },
            { id: "work-deploy", kind: "leaf", label: "Work Deploy Helper", skillRefId: "work-deploy" },
          ],
          disabledNodeIds: personal ? ["work-deploy", "work-domain"] : ["release-notes", "personal-domain"],
          edges: [rootEdge, leafEdge],
          skills: [skill],
          routers: [
            { nodeId: "personal-root", childNodeIds: [branch.id], routes: [rootEdge], digest: "c".repeat(64) },
            { nodeId: branch.id, childNodeIds: [leaf.id], routes: [leafEdge], digest: "c".repeat(64) },
          ],
        },
        graph: {
          digest: "c".repeat(64),
          nodes: [
            { id: "personal-root", kind: "router", label: "Personal router", depth: 0, x: 40, y: 22 },
            branch,
            leaf,
          ],
          edges: [rootEdge, leafEdge],
          mermaid: `flowchart TD\n  personal_root[Personal router] --> ${branch.id}[${branch.label}]\n  ${branch.id} --> ${leaf.id}[${leaf.label}]`,
        },
        outline: {
          title: `Architecture ${architecture.id}`,
          text: `Architecture ${architecture.id}\n- Personal router (router)\n  - ${branch.label} (router)\n    - ${leaf.label} (leaf)`,
          tree: [{ id: "personal-root", label: "Personal router", kind: "router", children: [{ id: branch.id, label: branch.label, kind: "router", children: [{ id: leaf.id, label: leaf.label, kind: "leaf", children: [] }] }] }],
        },
        diagram,
        ...(body.fixture !== undefined ? {
          plan: {
            dryRun: true,
            canApply: false,
            requiresApproval: true,
            targetId: typeof body.fixture === "object" && body.fixture && typeof (body.fixture as Record<string, unknown>).targetId === "string"
              ? (body.fixture as Record<string, unknown>).targetId
              : "codex-personal",
            environmentId: environment,
            architectureId: architecture.id,
            revisionDigest: "c".repeat(64),
            items: [{
              action: "noop",
              nodeId: "personal-root",
              kind: "router",
              reason: "Target already matches the desired router state.",
            }],
          },
        } : {}),
      });
    }

    return json(route, 404, { error: { code: "MOCK_ROUTE_MISSING", message: `${method} ${path} is not mocked.` } });
  });
  return state;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// Replaces the full-screen SVG overlay test: the static diagram and its
// "Expand diagram" dialog are no longer rendered anywhere. At the same widths,
// the accessible list, the inspector's keyboard return and the map must stay
// reachable without document overflow.
for (const width of [1440, 390, 320]) test(`the Structure list, inspector and map stay reachable and keyboard-operable at ${width}`, async ({ page }, info) => {
  await installMockArchitectureRoutes(page);
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/architectures");
  await page.getByRole("button", { name: /Review assistant/ }).click();
  await page.getByLabel("Preview profile").selectOption("personal");
  await page.getByLabel("Preview environment").selectOption("personal-laptop");
  const routerSelect = ui.rowSelect(ui.row(page, "personal-domain"));
  await expect(routerSelect).toBeVisible();
  await expect(ui.row(page, "release-notes")).toBeVisible();
  await page.screenshot({ path: info.outputPath("architecture-structure.png") });

  // Rows are real buttons: Enter selects and shows details. Narrow screens
  // use a sheet that Escape closes, returning focus to the row.
  await routerSelect.focus();
  await page.keyboard.press("Enter");
  await expect(routerSelect).toHaveAttribute("aria-current", "true");
  await expect(ui.inspector(page)).toContainText("Personal review router");
  if (width <= 900) {
    const close = ui.closeDetails(page);
    await expect(close).toBeVisible();
    await close.focus();
    await page.keyboard.press("Escape");
    await expect(close).toBeHidden();
    await expect(routerSelect).toBeFocused();
  }
  expect(await noDocumentOverflow(page)).toBe(true);

  // The map is reachable from the keyboard, fits the viewport width and keeps
  // the selection in the URL and on return to the list.
  const mapButton = ui.view(page, "Map");
  await mapButton.focus();
  await page.keyboard.press("Enter");
  await expect(mapButton).toHaveAttribute("aria-pressed", "true");
  const map = ui.map(page);
  await expect(map).toBeVisible();
  await expect(map).toContainText("Personal review router");
  const mapBox = (await map.boundingBox())!;
  expect(mapBox.x).toBeGreaterThanOrEqual(-1);
  expect(mapBox.x + mapBox.width).toBeLessThanOrEqual(width + 1);
  expect(await noDocumentOverflow(page)).toBe(true);
  await expectArchitectureUrl(page, { id: "architecture-1", context: { profile: "personal", environment: "personal-laptop" }, node: "personal-domain", view: "map" });
  await page.screenshot({ path: info.outputPath("architecture-map.png") });
  const listButton = ui.view(page, "List");
  await listButton.focus();
  await page.keyboard.press("Enter");
  await expect(listButton).toHaveAttribute("aria-pressed", "true");
  await expect(routerSelect).toHaveAttribute("aria-current", "true");
  expect(await noDocumentOverflow(page)).toBe(true);
});
