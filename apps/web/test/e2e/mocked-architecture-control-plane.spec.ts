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

interface MockArchitectureOptions {
  includeExistingArchitecture?: boolean;
  includeSecondArchitecture?: boolean;
  includeTeamOwner?: boolean;
  failFirstMigrationCreate?: boolean;
}

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
  await expect(page.getByRole("button", { name: "Copy canonical diagram JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download canonical diagram JSON" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Mermaid architecture export" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Mermaid architecture export" })).toBeVisible();
  await expect(page.getByText("Plain-text outline fallback")).toBeVisible();

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
  await expect(page.getByText("Create a personal or team-owned draft shell. Add its first immutable revision through the API contract.")).toBeVisible();
  await expect(page.getByText("This draft has no revision yet. Add a validated spec through the architecture revision API before previewing it.")).toBeVisible();
  await expect(page.getByRole("img", { name: "Skill architecture topology" })).toHaveCount(0);
  await expect.poll(() => state.draftPreviewAttempts).toBe(0);
  expect(state.createdBodies).toEqual([{
    name: "Private experiment",
    patternId: "multi-level-router",
    owner: { type: "user" },
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

test("owner saves and confirms organization access revocation, then retries a migration with the same idempotency key", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { failFirstMigrationCreate: true });
  await page.goto("/architectures");

  await expect(page.getByRole("heading", { name: "Review assistant", level: 2 })).toBeVisible();
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

  await page.getByLabel("Target pattern").selectOption("domain-router");
  await page.getByRole("button", { name: "Preview migration" }).click();
  await expect(page.getByText("Migration preview ready. The source architecture is unchanged.")).toBeVisible();
  await expect.poll(() => state.migrationPreviewBodies.length).toBe(1);
  expect(state.migrationPreviewBodies[0]?.targetPatternId).toBe("domain-router");
  await page.getByLabel("Derived architecture name").fill("Domain review assistant");
  await page.getByRole("button", { name: "Review create" }).click();
  await page.getByRole("button", { name: "Confirm create derived shell" }).click();
  await expect(page.getByRole("button", { name: "Retry create" })).toBeVisible();
  await page.getByRole("button", { name: "Retry create" }).click();
  await expect.poll(() => state.migrationCreateBodies.length).toBe(2);
  expect(state.migrationCreateBodies[0]?.idempotencyKey).toBeTruthy();
  expect(state.migrationCreateBodies[1]?.idempotencyKey).toBe(state.migrationCreateBodies[0]?.idempotencyKey);
  expect(state.migrationCreateReplayed).toBe(true);
});

test("owner can create a team-owned shell and unsaved editor changes guard unload and architecture selection", async ({ page }) => {
  const state = await installMockArchitectureRoutes(page, { includeSecondArchitecture: true, includeTeamOwner: true });
  await page.goto("/architectures");

  await page.getByLabel("Architecture owner").selectOption("team:team-review");
  await page.getByLabel("Architecture name").first().fill("Team review routing");
  await page.getByRole("button", { name: "Create architecture" }).click();
  await expect.poll(() => state.createdBodies.length).toBe(1);
  expect(state.createdBodies[0]?.owner).toEqual({ type: "team", id: "team-review" });
  await expect(page.getByRole("heading", { name: "Team review routing", level: 2 })).toBeVisible();
  await expect(page.getByTestId("architecture-editor")).toBeVisible();

  await page.getByLabel("Selected node label").fill("Unsaved team router");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
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

interface MockArchitectureState {
  createdBodies: Array<Record<string, unknown>>;
  draftPreviewAttempts: number;
  fixturePreviewRequests: number;
  previewContexts: Array<{ profileId?: string; environmentId?: string }>;
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
  const state: MockArchitectureState = {
    createdBodies: [],
    draftPreviewAttempts: 0,
    fixturePreviewRequests: 0,
    previewContexts: [],
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
  let createdTarget: Record<string, unknown> | null = null;
  let organizationGrantIds: string[] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : {};

    if (path === "/v1/me") return json(route, 200, { user: owner });
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
      return json(route, 200, { observations: [] });
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
        diagram: {
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
