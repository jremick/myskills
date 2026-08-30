import { expect, test, type Page, type Route } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ expiresAt: storedExpiry, user }) => {
    window.localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: storedExpiry, user }));
  }, { expiresAt, user: owner });
});

test("signed-in owner inspects the same profile-filtered nodes in the diagram and accessible outline", async ({ page }) => {
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

  const diagram = page.getByRole("img", { name: "Skill architecture topology" });
  const outline = page.getByRole("list", { name: "Architecture topology outline" });
  await expect(diagram).toBeVisible();
  await expect(outline).toBeVisible();

  const diagramLabels = (await diagram.locator(".architecture-diagram-label").allTextContents()).sort();
  const outlineLabels = (await outline.locator("strong").allTextContents()).sort();
  expect(diagramLabels).toEqual(["Personal review router", "Personal router", "Release Notes Helper"]);
  expect(outlineLabels).toEqual(diagramLabels);
  await expect(outline.locator("li > ol > li > ol > li > span > strong")).toHaveText("Release Notes Helper");
  await expect(page.locator(".architecture-preview-stack")).not.toContainText("Work Deploy Helper");
  await expect(page.getByRole("cell", { name: "0.1.0" })).toBeVisible();
  await expect(page.getByText("No sync plan generated. Provide an observed-state fixture to preview a target dry run.")).toBeVisible();

  const viewBox = await diagram.getAttribute("viewBox");
  const [, , viewBoxWidth, viewBoxHeight] = (viewBox ?? "").split(/\s+/).map(Number);
  expect(viewBoxWidth).toBeGreaterThan(900);
  expect(viewBoxHeight).toBeGreaterThan(400);

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

  await expect(page.getByRole("heading", { name: "Private experiment" })).toBeVisible();
  await expect(page.getByRole("main", { name: "Skill architectures" })).toBeVisible();
  await expect(page.getByText("Create an owner-private draft shell. Add its first immutable revision through the API contract.")).toBeVisible();
  await expect(page.getByText("This draft has no revision yet. Add a validated spec through the architecture revision API before previewing it.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Skill architecture topology" })).toHaveCount(0);
  await expect.poll(() => state.draftPreviewAttempts).toBe(0);
  expect(state.createdBodies).toEqual([{
    name: "Private experiment",
    patternId: "multi-level-router",
  }]);

  const measurements = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".architecture-workspace")!.getBoundingClientRect();
    return {
      bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      workspaceLeft: workspace.left,
      workspaceRight: workspace.right,
    };
  });
  expect(measurements.bodyWidth).toBeLessThanOrEqual(measurements.viewportWidth);
  expect(measurements.documentWidth).toBeLessThanOrEqual(measurements.viewportWidth);
  expect(measurements.workspaceLeft).toBeGreaterThanOrEqual(0);
  expect(measurements.workspaceRight).toBeLessThanOrEqual(375.5);
});

interface MockArchitectureState {
  createdBodies: Array<Record<string, unknown>>;
  draftPreviewAttempts: number;
  fixturePreviewRequests: number;
  previewContexts: Array<{ profileId?: string; environmentId?: string }>;
}

async function installMockArchitectureRoutes(
  page: Page,
  options: { includeExistingArchitecture?: boolean } = {},
): Promise<MockArchitectureState> {
  const state: MockArchitectureState = {
    createdBodies: [],
    draftPreviewAttempts: 0,
    fixturePreviewRequests: 0,
    previewContexts: [],
  };
  const architecture = {
    id: "architecture-1",
    ownerUserId: owner.id,
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

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : {};

    if (path === "/v1/me") return json(route, 200, { user: owner });
    if (path === "/v1/architecture-patterns") {
      return json(route, 200, {
        patterns: [{
          id: "multi-level-router",
          version: 1,
          name: "Multi-level router",
          description: "Nested routers route to other routers and leaf skills.",
          supportsNestedRouters: true,
        }],
      });
    }
    if (path === "/v1/architectures" && method === "GET") {
      return json(route, 200, { architectures: options.includeExistingArchitecture === false ? [] : [architecture] });
    }
    if (path === "/v1/architectures" && method === "POST") {
      state.createdBodies.push(body);
      return json(route, 201, {
        architecture: {
          id: "architecture-draft",
          ownerUserId: owner.id,
          name: body.name,
          description: typeof body.description === "string" ? body.description : "",
          patternId: body.patternId,
          currentRevisionId: null,
          revisionCount: 0,
          createdAt: "2026-08-30T00:10:00.000Z",
          updatedAt: "2026-08-30T00:10:00.000Z",
        },
      });
    }

    const architectureMatch = path.match(/^\/v1\/architectures\/([^/]+)$/);
    if (architectureMatch && method === "GET") {
      if (architectureMatch[1] === "architecture-draft") {
        return json(route, 200, {
          architecture: {
            id: "architecture-draft",
            ownerUserId: owner.id,
            name: "Private experiment",
            description: "",
            patternId: "multi-level-router",
            currentRevisionId: null,
            revisionCount: 0,
            createdAt: "2026-08-30T00:10:00.000Z",
            updatedAt: "2026-08-30T00:10:00.000Z",
          },
          revisions: [],
          latestRevision: null,
        });
      }
      return json(route, 200, { architecture, revisions: [{ id: revision.id, architectureId: revision.architectureId, revisionNumber: revision.revisionNumber, patternId: architecture.patternId }], latestRevision: revision });
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
