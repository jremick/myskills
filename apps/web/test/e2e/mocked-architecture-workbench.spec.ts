import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import {
  compileArchitecture,
  createArchitectureDiagramArtifact,
  mermaidArchitecture,
  type ArchitectureSpecV1,
  type CompiledArchitecture,
} from "@myskills-app/core";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();
test.use({ launchOptions: browserExecutable ? { executablePath: browserExecutable } : {} });

// Acceptance scenarios for the full-page architecture Workbench, written
// before the implementation. The mock compiles every preview with the shared
// core compiler, so counts and labels come from the same model as the API.
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

const BRANCHES = [
  { id: "engineering", label: "Engineering", leaves: 14 },
  { id: "research", label: "Research", leaves: 12 },
  { id: "writing", label: "Writing", leaves: 12 },
  { id: "product", label: "Product", leaves: 14 },
  { id: "integrations", label: "Integrations", leaves: 10 },
  { id: "files", label: "Files and media", leaves: 13 },
] as const;
const RESEARCH_BRANCHES = new Set(["research", "writing"]);
const LARGE_ID = "arch-large";
const LARGE_NAME = "Synthetic routing library";

type Revision = {
  id: string;
  architectureId: string;
  revisionNumber: number;
  message: string;
  createdByUserId: string;
  createdAt: string;
  spec: ArchitectureSpecV1;
};

type ArchitectureRecord = {
  summary: Record<string, unknown>;
  revisions: Revision[];
};

interface WorkbenchMockState {
  records: Map<string, ArchitectureRecord>;
  listOrder: string[];
  listRequests: number;
  detailRequests: string[];
  previewRequests: Array<{ architectureId: string; profileId?: string; environmentId?: string; organizationId?: string; revisionId?: string }>;
  completedPreviews: string[];
  draftPreviewRequests: Array<{ architectureId: string; profileId?: string; environmentId?: string; expectedCurrentRevisionId: unknown; routerLabels: string[] }>;
  completedDraftPreviews: string[];
  revisionCreates: Array<{ architectureId: string; expectedCurrentRevisionId: unknown; message?: unknown; routerLabels: string[]; skillSlugs: string[] }>;
  completedSaves: string[];
  saveResponses: number[];
  gates: Map<string, { promise: Promise<void>; release: () => void }>;
}

function hexDigest(index: number): string {
  return (index + 1).toString(16).padStart(4, "0").repeat(16);
}

function largeSpec(researchLabel: string): ArchitectureSpecV1 {
  const skills: ArchitectureSpecV1["skills"] = [];
  const nodes: ArchitectureSpecV1["nodes"] = [{ id: "library-root", kind: "router", label: "Library root" }];
  const edges: ArchitectureSpecV1["edges"] = [];
  const parentOf = new Map<string, string>();
  let skillIndex = 0;
  for (const branch of BRANCHES) {
    nodes.push({ id: branch.id, kind: "router", label: branch.id === "research" ? researchLabel : branch.label });
    edges.push({ from: "library-root", to: branch.id, kind: "contains" });
    for (let index = 1; index <= branch.leaves; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const id = `${branch.id}-${suffix}`;
      const label = `${branch.label} skill ${suffix}`;
      skills.push({ id, slug: `synthetic-${id}`, title: label, version: "1.0.0", digest: hexDigest(skillIndex), packageVisibility: "private" });
      nodes.push({ id, kind: "leaf", label, skillRefId: id });
      edges.push({ from: branch.id, to: id, kind: "routes" });
      parentOf.set(id, branch.id);
      skillIndex += 1;
    }
  }
  const binding = (node: ArchitectureSpecV1["nodes"][number]) => ({
    nodeId: node.id,
    enabled: true,
    runtimeExposure: node.kind === "router" ? "router" as const : "leaf" as const,
  });
  const inResearch = (node: ArchitectureSpecV1["nodes"][number]) => node.id === "library-root"
    || RESEARCH_BRANCHES.has(node.id)
    || RESEARCH_BRANCHES.has(parentOf.get(node.id) ?? "");
  return {
    schemaVersion: 1,
    id: LARGE_ID,
    name: LARGE_NAME,
    pattern: { id: "multi-level-router", version: 1 },
    skills,
    nodes,
    edges,
    entryNodeIds: ["library-root"],
    profiles: [
      { id: "personal", name: "Personal", subject: { type: "user", id: owner.id }, defaultExposure: "disabled", bindings: nodes.map(binding) },
      { id: "research", name: "Research", subject: { type: "user", id: owner.id }, defaultExposure: "disabled", bindings: nodes.filter(inResearch).map(binding) },
    ],
    environments: [
      { id: "personal-laptop", name: "Personal laptop", kind: "personal", profileId: "personal" },
      { id: "personal-cloud", name: "Personal cloud", kind: "personal", profileId: "personal" },
      { id: "research-lab", name: "Research lab", kind: "work", profileId: "research" },
    ],
  };
}

function smallSpec(id: string, name: string, subject: { type: "user" | "team"; id: string }, kind: "personal" | "team"): ArchitectureSpecV1 {
  const skills: ArchitectureSpecV1["skills"] = [
    { id: "ops-01", slug: "synthetic-ops-01", title: "Operations skill 01", version: "1.0.0", digest: hexDigest(200), packageVisibility: "private" },
    { id: "ops-02", slug: "synthetic-ops-02", title: "Operations skill 02", version: "1.0.0", digest: hexDigest(201), packageVisibility: "private" },
  ];
  const nodes: ArchitectureSpecV1["nodes"] = [
    { id: "ops-root", kind: "router", label: `${name} root` },
    { id: "operations", kind: "router", label: "Operations" },
    { id: "ops-01", kind: "leaf", label: "Operations skill 01", skillRefId: "ops-01" },
    { id: "ops-02", kind: "leaf", label: "Operations skill 02", skillRefId: "ops-02" },
  ];
  return {
    schemaVersion: 1,
    id,
    name,
    pattern: { id: "multi-level-router", version: 1 },
    skills,
    nodes,
    edges: [
      { from: "ops-root", to: "operations", kind: "contains" },
      { from: "operations", to: "ops-01", kind: "routes" },
      { from: "operations", to: "ops-02", kind: "routes" },
    ],
    entryNodeIds: ["ops-root"],
    profiles: [{
      id: "default",
      name: kind === "team" ? "Team default" : "Personal",
      subject,
      defaultExposure: "disabled",
      bindings: nodes.map((node) => ({ nodeId: node.id, enabled: true, runtimeExposure: node.kind === "router" ? "router" as const : "leaf" as const })),
    }],
    environments: [{ id: kind === "team" ? "team-env" : "ops-laptop", name: kind === "team" ? "Team environment" : "Operations laptop", kind, profileId: "default" }],
  };
}

function accessFor(kind: "owner" | "member", ownerRef: { type: "user" | "team"; id: string }, allowedOrganizationIds: string[] = []) {
  return {
    allowedOrganizationIds,
    owner: ownerRef,
    ownerType: ownerRef.type,
    ownerId: ownerRef.id,
    policyVersion: 1,
    accessPolicyVersion: 1,
    role: kind,
    canList: true,
    canRead: true,
    canPreview: true,
    canCreate: kind === "owner",
    canAppend: kind === "owner",
    canManage: kind === "owner",
    reasons: [kind === "owner" ? "owner" : "team-member"],
  };
}

function summaryFor(id: string, name: string, description: string, kind: "owner" | "member", revisions: Revision[], allowedOrganizationIds: string[] = []) {
  const ownerRef = kind === "owner" ? { type: "user" as const, id: owner.id } : { type: "team" as const, id: "team-synthetic" };
  return {
    id,
    ownerUserId: ownerRef.type === "user" ? ownerRef.id : null,
    ownerTeamId: ownerRef.type === "team" ? ownerRef.id : null,
    owner: ownerRef,
    ownerType: ownerRef.type,
    ownerId: ownerRef.id,
    accessPolicyVersion: 1,
    access: accessFor(kind, ownerRef, allowedOrganizationIds),
    name,
    description,
    patternId: "multi-level-router",
    scope: kind === "owner" ? "personal" : "team",
    currentRevisionId: revisions.at(-1)?.id ?? null,
    revisionCount: revisions.length,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

function revisionFor(architectureId: string, revisionNumber: number, message: string, spec: ArchitectureSpecV1): Revision {
  return {
    id: `${architectureId}-revision-${revisionNumber}`,
    architectureId,
    revisionNumber,
    message,
    createdByUserId: owner.id,
    createdAt: `2026-09-0${revisionNumber}T00:00:00.000Z`,
    spec,
  };
}

function compileFor(spec: ArchitectureSpecV1, profileId?: string, environmentId?: string): CompiledArchitecture {
  return compileArchitecture(spec, {
    registry: spec.skills.map((skill) => ({ skillRefId: skill.id, slug: skill.slug, title: skill.title, version: skill.version, digest: skill.digest, packageVisibility: skill.packageVisibility })),
    ...(profileId ? { profileId } : {}),
    ...(environmentId ? { environmentId } : {}),
  });
}

// Mirrors the API's deterministic depth layout and outline projection.
function previewProjection(compiled: CompiledArchitecture) {
  const children = new Map<string, string[]>();
  for (const edge of compiled.edges) children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to].sort());
  const roots = compiled.nodes.filter((node) => !compiled.edges.some((edge) => edge.to === node.id)).map((node) => node.id).sort();
  const depth = new Map<string, number>();
  const queue = [...roots];
  for (const root of roots) depth.set(root, 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (!depth.has(child)) {
        depth.set(child, (depth.get(current) ?? 0) + 1);
        queue.push(child);
      }
    }
  }
  const byDepth = new Map<number, string[]>();
  for (const node of compiled.nodes) byDepth.set(depth.get(node.id) ?? 0, [...(byDepth.get(depth.get(node.id) ?? 0) ?? []), node.id].sort());
  const nodeById = new Map(compiled.nodes.map((node) => [node.id, node]));
  const lines = [`Architecture ${compiled.architectureId}`];
  const outlineNode = (id: string, level: number): { id: string; label: string; kind: string; children: unknown[] } => {
    const node = nodeById.get(id)!;
    lines.push(`${"  ".repeat(level)}- ${node.label} (${node.kind})`);
    return { id, label: node.label, kind: node.kind, children: (children.get(id) ?? []).map((child) => outlineNode(child, level + 1)) };
  };
  const tree = roots.map((root) => outlineNode(root, 0));
  return {
    compiled,
    graph: {
      digest: compiled.revisionDigest,
      nodes: compiled.nodes.slice().sort((left, right) => left.id.localeCompare(right.id)).map((node) => {
        const nodeDepth = depth.get(node.id) ?? 0;
        return {
          id: node.id,
          kind: node.kind,
          label: node.label,
          depth: nodeDepth,
          x: (byDepth.get(nodeDepth) ?? []).indexOf(node.id) * 260,
          y: nodeDepth * 140,
          ...(node.skillRefId ? { skillRefId: node.skillRefId } : {}),
        };
      }),
      edges: compiled.edges,
      mermaid: mermaidArchitecture(compiled),
    },
    outline: { title: `Architecture ${compiled.architectureId}`, text: lines.join("\n"), tree },
    diagram: createArchitectureDiagramArtifact(compiled),
  };
}

function routerLabels(spec: ArchitectureSpecV1): string[] {
  return spec.nodes.filter((node) => node.kind === "router").map((node) => node.label);
}

function hold(state: WorkbenchMockState, key: string): () => void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  state.gates.set(key, { promise, release });
  return () => {
    state.gates.delete(key);
    release();
  };
}

async function installWorkbenchMock(context: BrowserContext): Promise<WorkbenchMockState> {
  const largeRevisions = [
    revisionFor(LARGE_ID, 1, "Initial import", largeSpec("Research archive")),
    revisionFor(LARGE_ID, 2, "Rename research branch", largeSpec("Research")),
  ];
  const secondRevisions = [revisionFor("arch-second", 1, "Operations shell", smallSpec("arch-second", "Second routing library", { type: "user", id: owner.id }, "personal"))];
  const memberRevisions = [revisionFor("arch-member", 1, "Team shell", smallSpec("arch-member", "Shared team library", { type: "team", id: "team-synthetic" }, "team"))];
  const sharedRevisions = [revisionFor("arch-shared", 1, "Shared shell", smallSpec("arch-shared", "Organization routing library", { type: "user", id: owner.id }, "personal"))];
  const state: WorkbenchMockState = {
    records: new Map([
      [LARGE_ID, { summary: summaryFor(LARGE_ID, LARGE_NAME, "Synthetic library with six router branches.", "owner", largeRevisions), revisions: largeRevisions }],
      ["arch-second", { summary: summaryFor("arch-second", "Second routing library", "A second shell for selection guards.", "owner", secondRevisions), revisions: secondRevisions }],
      ["arch-member", { summary: summaryFor("arch-member", "Shared team library", "Team-owned architecture shared with members.", "member", memberRevisions), revisions: memberRevisions }],
      ["arch-member-empty", { summary: summaryFor("arch-member-empty", "Pending team library", "Team-owned shell without a revision.", "member", []), revisions: [] }],
      ["arch-shared", { summary: summaryFor("arch-shared", "Organization routing library", "Owner architecture shared with two organizations.", "owner", sharedRevisions, ["org-alpha", "org-beta"]), revisions: sharedRevisions }],
    ]),
    listOrder: [LARGE_ID, "arch-second", "arch-member", "arch-member-empty", "arch-shared"],
    listRequests: 0,
    detailRequests: [],
    previewRequests: [],
    completedPreviews: [],
    draftPreviewRequests: [],
    completedDraftPreviews: [],
    revisionCreates: [],
    completedSaves: [],
    saveResponses: [],
    gates: new Map(),
  };

  await context.addInitScript(({ expiresAt: storedExpiry, user }) => {
    if (location.origin !== "null") window.localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: storedExpiry, user }));
  }, { expiresAt, user: owner });

  await context.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, "");
    const body = request.postData() ? JSON.parse(request.postData()!) as Record<string, unknown> : {};

    if (path === "/v1/me") return json(route, 200, { user: owner });
    if (path === "/v1/architecture-patterns") {
      return json(route, 200, { patterns: [
        { id: "multi-level-router", version: 1, name: "Multi-level router", description: "Nested routers route to other routers and leaf skills.", supportsNestedRouters: true },
        { id: "domain-router", version: 1, name: "Domain router", description: "Route requests through a domain branch before a leaf.", supportsNestedRouters: false },
        { id: "flat", version: 1, name: "Flat library", description: "Expose a curated set of skills from one entry point.", supportsNestedRouters: false },
      ] });
    }
    if (path === "/v1/teams" && method === "GET") return json(route, 200, { teams: [], invitations: [] });
    if (path === "/v1/organizations" && method === "GET") return json(route, 200, { organizations: [] });
    if (path === "/v1/architectures" && method === "GET") {
      state.listRequests += 1;
      return json(route, 200, { architectures: state.listOrder.map((id) => state.records.get(id)!.summary) });
    }
    if (path === "/v1/architectures" && method === "POST") {
      const id = "arch-new";
      const summary = { ...summaryFor(id, String(body.name), "", "owner", []), patternId: body.patternId };
      state.records.set(id, { summary, revisions: [] });
      state.listOrder.unshift(id);
      return json(route, 201, { architecture: summary });
    }

    const detailMatch = path.match(/^\/v1\/architectures\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const id = decodeURIComponent(detailMatch[1]!);
      state.detailRequests.push(id);
      await state.gates.get(`detail:${id}`)?.promise;
      const record = state.records.get(id);
      if (!record) return json(route, 403, { error: { code: "ARCHITECTURE_FORBIDDEN", message: "Architecture access denied." } });
      return json(route, 200, {
        architecture: record.summary,
        revisions: record.revisions.map(({ spec: _spec, ...summary }) => ({ ...summary, patternId: "multi-level-router" })),
        latestRevision: record.revisions.at(-1) ?? null,
      });
    }

    const grantsMatch = path.match(/^\/v1\/architectures\/([^/]+)\/organization-grants$/);
    if (grantsMatch && method === "GET") {
      const record = state.records.get(decodeURIComponent(grantsMatch[1]!));
      return json(route, 200, { architectureId: grantsMatch[1], currentRevisionId: record?.revisions.at(-1)?.id ?? null, grants: [], organizationIds: [] });
    }

    const revisionMatch = path.match(/^\/v1\/architectures\/([^/]+)\/revisions\/([^/]+)$/);
    if (revisionMatch && method === "GET") {
      const record = state.records.get(decodeURIComponent(revisionMatch[1]!));
      const revision = record?.revisions.find((candidate) => candidate.id === decodeURIComponent(revisionMatch[2]!));
      return revision ? json(route, 200, { revision }) : json(route, 404, { error: { code: "ARCHITECTURE_REVISION_NOT_FOUND", message: "Revision not found." } });
    }

    const createRevisionMatch = path.match(/^\/v1\/architectures\/([^/]+)\/revisions$/);
    if (createRevisionMatch && method === "POST") {
      const id = decodeURIComponent(createRevisionMatch[1]!);
      const record = state.records.get(id)!;
      const spec = body.spec as ArchitectureSpecV1;
      state.revisionCreates.push({
        architectureId: id,
        expectedCurrentRevisionId: body.expectedCurrentRevisionId,
        message: body.message,
        routerLabels: routerLabels(spec),
        skillSlugs: spec.skills.map((skill) => skill.slug),
      });
      await state.gates.get(`save:${id}`)?.promise;
      state.completedSaves.push(id);
      const status = state.saveResponses.shift() ?? 201;
      if (status === 500) return json(route, 500, { error: { code: "INTERNAL_ERROR", message: "Temporary storage failure." } });
      if (status === 409) return json(route, 409, { error: { code: "ARCHITECTURE_REVISION_CONFLICT", message: "The architecture changed after this draft was opened." } });
      const revision = revisionFor(id, record.revisions.length + 1, typeof body.message === "string" ? body.message : "", spec);
      record.revisions.push(revision);
      record.summary = { ...record.summary, currentRevisionId: revision.id, revisionCount: record.revisions.length };
      return json(route, 201, { revision });
    }

    const previewMatch = path.match(/^\/v1\/architectures\/([^/]+)\/preview$/);
    if (previewMatch && method === "POST") {
      const id = decodeURIComponent(previewMatch[1]!);
      const record = state.records.get(id);
      const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
      const environmentId = typeof body.environmentId === "string" ? body.environmentId : undefined;
      const revisionId = typeof body.revisionId === "string" ? body.revisionId : undefined;
      state.previewRequests.push({ architectureId: id, profileId, environmentId, revisionId, ...(typeof body.organizationId === "string" ? { organizationId: body.organizationId } : {}) });
      const key = `preview:${id}:${profileId ?? ""}`;
      await state.gates.get(key)?.promise;
      const revision = record?.revisions.find((candidate) => candidate.id === revisionId) ?? record?.revisions.at(-1);
      if (!revision) return json(route, 404, { error: { code: "ARCHITECTURE_REVISION_NOT_FOUND", message: "Revision not found." } });
      const projection = previewProjection(compileFor(revision.spec, profileId, environmentId));
      state.completedPreviews.push(key);
      return json(route, 200, { revision, ...projection });
    }

    const draftPreviewMatch = path.match(/^\/v1\/architectures\/([^/]+)\/draft-preview$/);
    if (draftPreviewMatch && method === "POST") {
      const id = decodeURIComponent(draftPreviewMatch[1]!);
      const spec = body.spec as ArchitectureSpecV1;
      const profileId = typeof body.profileId === "string" ? body.profileId : undefined;
      const environmentId = typeof body.environmentId === "string" ? body.environmentId : undefined;
      state.draftPreviewRequests.push({ architectureId: id, profileId, environmentId, expectedCurrentRevisionId: body.expectedCurrentRevisionId, routerLabels: routerLabels(spec) });
      const key = `draft:${id}:${profileId ?? ""}`;
      await state.gates.get(key)?.promise;
      const projection = previewProjection(compileFor(spec, profileId, environmentId));
      state.completedDraftPreviews.push(key);
      return json(route, 200, { draft: { expectedCurrentRevisionId: body.expectedCurrentRevisionId ?? null, spec }, ...projection });
    }

    // Exact-release picker metadata for the bootstrap scenario.
    if (path === "/v1/skills" && method === "GET") {
      return json(route, 200, { skills: [{
        slug: "synthetic-audit-helper",
        title: "Synthetic audit helper",
        summary: "Checks synthetic architecture changes.",
        lifecycleStatus: "approved",
        visibility: "private",
        latestVersion: "1.2.0",
        reviewStatus: "approved",
        securityStatus: "passed",
        platforms: [],
        tags: [],
      }] });
    }
    if (path === "/v1/skills/synthetic-audit-helper/releases" && method === "GET") {
      return json(route, 200, { releases: [{ id: "release-audit-120", slug: "synthetic-audit-helper", version: "1.2.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-01T00:00:00.000Z", platforms: [], findingCount: 0, allowedActions: [] }] });
    }
    if (path === "/v1/skills/synthetic-audit-helper/releases/1.2.0" && method === "GET") {
      return json(route, 200, { release: {
        slug: "synthetic-audit-helper",
        title: "Synthetic audit helper",
        summary: "Checks synthetic architecture changes.",
        version: "1.2.0",
        lifecycleStatus: "approved",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: "2026-09-01T00:00:00.000Z",
        platforms: [],
        artifact: { sha256: "ab".repeat(32), byteSize: 1024, contentType: "application/zip" },
      } });
    }

    return json(route, 404, { error: { code: "MOCK_ROUTE_MISSING", message: `${method} ${path} is not mocked.` } });
  });
  return state;
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function trackDialogs(page: Page) {
  const tracker = { policy: "dismiss" as "accept" | "dismiss", messages: [] as string[] };
  page.on("dialog", async (dialog) => {
    tracker.messages.push(dialog.message());
    if (tracker.policy === "accept") await dialog.accept();
    else await dialog.dismiss();
  });
  return tracker;
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
}

async function isWithin(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!a || !b) return false;
  return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

// React Flow exposes each node wrapper as an image; the inner view repeats the
// same label, so the first match is the positioned node.
function flowNode(canvas: Locator, name: string): Locator {
  return canvas.getByRole("img", { name, exact: true }).first();
}

function treeRow(page: Page, label: string): Locator {
  return page.getByRole("tree", { name: "Semantic architecture nodes" }).getByRole("treeitem").filter({ has: page.getByText(label, { exact: true }) });
}

function overviewOutline(page: Page): Locator {
  return page.getByRole("list", { name: "Architecture topology outline" });
}

test("deep links select the requested architecture and context, and the launcher opens a full-width Workbench that survives reload", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}?profile=research&environment=research-lab`);

  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(LARGE_NAME) })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Preview profile")).toHaveValue("research");
  await expect(page.getByLabel("Preview environment")).toHaveValue("research-lab");
  await expect.poll(() => state.previewRequests.at(-1)).toMatchObject({ architectureId: LARGE_ID, profileId: "research", environmentId: "research-lab" });
  expect(state.previewRequests.some((request) => request.profileId === "personal")).toBe(false);
  await expect(page.getByText("Effective result returned by API")).toHaveCount(0);

  // The saved result comes from the API for the research context only.
  await expect(overviewOutline(page)).toContainText("Writing skill 12");
  await expect(overviewOutline(page)).not.toContainText("Engineering skill 01");
  await expect(page.getByText("27 nodes · 26 links", { exact: true })).toBeVisible();
  const outlineRegion = page.getByRole("region", { name: "Accessible outline" });
  await outlineRegion.focus();
  await expect(outlineRegion).toBeFocused();
  expect(await outlineRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await outlineRegion.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(420);

  const launcher = page.getByRole("link", { name: "Open workbench", exact: true });
  await expect(launcher).toHaveAttribute("href", `/architectures/${LARGE_ID}/workbench?profile=research&environment=research-lab`);
  await launcher.click();
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  const workbenchTitle = page.getByRole("heading", { name: LARGE_NAME, level: 1 });
  await expect(workbenchTitle).toBeFocused();
  await expect(page.getByRole("heading", { name: "Edit the current revision" })).toBeVisible();
  await expect(page.getByText("Based on Revision 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill architectures", level: 1 })).toBeHidden();
  await expect(page.getByRole("list", { name: "Saved architectures" })).toBeHidden();
  await expect(page.getByText("Effective result returned by API")).toHaveCount(0);

  // The 82-node draft is navigable: the tree scrolls in its own pane and the
  // fitted canvas shows the root beside a visible minimap.
  const canvas = page.getByTestId("architecture-canvas");
  expect((await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(480);
  await expect(canvas.locator("[aria-roledescription=\"node\"]")).toHaveCount(82);
  await expect(canvas.locator(".react-flow__minimap")).toBeVisible();
  await expect.poll(() => isWithin(flowNode(canvas, "Router: Library root"), canvas)).toBe(true);
  // Readability, not just presence: the oriented node renders near full size
  // and the minimap stays a small navigation aid.
  const canvasBox = (await canvas.boundingBox())!;
  expect((await flowNode(canvas, "Router: Library root").boundingBox())!.width).toBeGreaterThanOrEqual(160);
  const minimapBox = (await canvas.locator(".react-flow__minimap").boundingBox())!;
  expect(minimapBox.width * minimapBox.height).toBeLessThan(canvasBox.width * canvasBox.height * 0.06);
  await expect(page.getByText("82 nodes", { exact: true })).toBeVisible();
  const tree = page.getByRole("tree", { name: "Semantic architecture nodes" });
  await expect(tree.getByRole("treeitem")).toHaveCount(82);
  expect(await tree.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await treeRow(page, "Files and media skill 13").scrollIntoViewIfNeeded();
  await treeRow(page, "Files and media skill 13").click();
  await expect(page.getByRole("button", { name: "Save revision" })).toBeInViewport();
  // The outline heading and the selected-node inspector stay in view together.
  await expect(page.getByRole("heading", { name: "Outline", exact: true })).toBeInViewport();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Files and media skill 13");
  await expect(page.getByLabel("Selected node label")).toBeInViewport();
  await expect.poll(() => isWithin(flowNode(canvas, "Leaf: Files and media skill 13"), canvas)).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByLabel("Preview profile")).toHaveValue("research");
  await expect(page.getByLabel("Preview environment")).toHaveValue("research-lab");

  // Only the Workbench drops the page width cap.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const workspace = page.getByRole("main", { name: "Skill architectures" });
  await expect.poll(() => workspace.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(1500);
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  expect(await workspace.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1420);
});

test("Back and Forward between the overview and Workbench keep the draft, message and fitted canvas while the overview keeps the saved result", async ({ page }, info) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await expect(overviewOutline(page)).toContainText("Engineering skill 01");

  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Research").click();
  const label = page.getByLabel("Selected node label");
  await expect(label).toHaveValue("Research");
  await label.fill("Research and discovery");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Rename the research branch");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  // At desktop width the draft actions share one row beside the title.
  const actionTops = await Promise.all(["Discard", "Preview draft", "Save revision"].map(async (name) => (await page.getByRole("button", { name, exact: true }).boundingBox())!.y));
  expect(Math.max(...actionTops) - Math.min(...actionTops)).toBeLessThanOrEqual(2);
  const titleBox = (await page.getByRole("heading", { name: LARGE_NAME, level: 1 }).boundingBox())!;
  expect(titleBox.y).toBeLessThan((await page.getByRole("button", { name: "Save revision" }).boundingBox())!.y + 40);
  const canvas = page.getByTestId("architecture-canvas");
  await expect(flowNode(canvas, "Router: Research and discovery")).toBeAttached();

  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect(page.getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  expect(state.draftPreviewRequests.at(-1)).toMatchObject({
    architectureId: LARGE_ID,
    profileId: "personal",
    environmentId: "personal-laptop",
    expectedCurrentRevisionId: `${LARGE_ID}-revision-2`,
  });
  expect(state.draftPreviewRequests.at(-1)?.routerLabels).toContain("Research and discovery");
  await page.screenshot({ path: info.outputPath("workbench-draft-preview.png") });

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  const resume = page.getByRole("link", { name: "Resume draft", exact: true });
  await expect(resume).toBeVisible();
  await expect(page.getByText("You have an unsaved draft in the workbench.")).toBeVisible();
  // The overview shows the saved revision, never the unsaved draft.
  await expect(overviewOutline(page)).toContainText("Research skill 01");
  await expect(overviewOutline(page)).not.toContainText("Research and discovery");
  await page.screenshot({ path: info.outputPath("overview-resume-draft.png") });

  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=personal&environment=personal-laptop$`));
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  await page.getByRole("tab", { name: "Design" }).click();
  await expect(label).toHaveValue("Research and discovery");
  await expect(message).toHaveValue("Rename the research branch");
  // The re-shown canvas is oriented on the selected node at a readable scale.
  await expect.poll(() => isWithin(flowNode(canvas, "Router: Research and discovery"), canvas)).toBe(true);

  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(resume).toBeFocused();
  await resume.click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeFocused();
  await expect(label).toHaveValue("Research and discovery");
  expect(dialogs.messages).toEqual([]);
  await page.screenshot({ path: info.outputPath("workbench-restored.png") });

  const evidence = {
    scenario: "same-architecture overview/workbench round trip",
    viewport: page.viewportSize(),
    finalUrl: new URL(page.url()).pathname + new URL(page.url()).search,
    dialogs: dialogs.messages.length,
    draftPreviewRequest: state.draftPreviewRequests.at(-1),
    savedPreviewContexts: state.previewRequests.map(({ profileId, environmentId, revisionId }) => ({ profileId, environmentId, revisionId })),
    revisionCreates: state.revisionCreates.length,
  };
  await writeFile(info.outputPath("workbench-round-trip.json"), JSON.stringify(evidence, null, 2));
  await info.attach("workbench-round-trip", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});

test("message-only changes guard other architectures and outside links; cancelled transitions restore the URL and draft without double prompts", async ({ page }) => {
  await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/architectures/arch-second");
  await expect(page.getByRole("heading", { name: "Second routing library", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(LARGE_NAME) }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  const message = page.getByLabel("Draft revision message");
  await message.fill("Only the message changed");
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save revision" })).toBeDisabled();
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  // Same architecture: no prompt.
  await page.evaluate(() => history.back());
  await expect(page.getByRole("link", { name: "Resume draft", exact: true })).toBeVisible();
  expect(dialogs.messages).toHaveLength(0);
  const overviewUrl = page.url();

  // Browser Back to a different architecture: one prompt, and cancel restores.
  await page.evaluate(() => history.back());
  await expect.poll(() => dialogs.messages.length).toBe(1);
  await expect(page).toHaveURL(overviewUrl);
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resume draft", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Second routing library/ }).click();
  await expect.poll(() => dialogs.messages.length).toBe(2);
  await expect(page).toHaveURL(overviewUrl);

  await page.locator(".side-nav").getByRole("link", { name: "Registry" }).click();
  await expect.poll(() => dialogs.messages.length).toBe(3);
  await expect(page).toHaveURL(overviewUrl);

  // The section root keeps the current architecture and draft.
  await page.locator(".side-nav").getByRole("link", { name: "Architectures" }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  await page.getByRole("link", { name: "Resume draft", exact: true }).click();
  await expect(message).toHaveValue("Only the message changed");
  expect(dialogs.messages).toHaveLength(3);

  // Accepting a different architecture discards once and loads it.
  await page.getByRole("link", { name: "Architecture overview" }).click();
  dialogs.policy = "accept";
  await page.getByRole("button", { name: /Second routing library/ }).click();
  await expect(page.getByRole("heading", { name: "Second routing library", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/architectures\/arch-second(\?|$)/);
  expect(dialogs.messages).toHaveLength(4);

  // Accepting an outside link leaves the section once.
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await message.fill("Leaving with a message");
  await page.locator(".side-nav").getByRole("link", { name: "Registry" }).click();
  await expect(page).toHaveURL(/\/registry/);
  expect(dialogs.messages).toHaveLength(5);
});

test("a history draft saves against the latest revision token and keeps spec and message after failed and conflicting saves", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  state.saveResponses.push(500, 409);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);

  await page.getByRole("tab", { name: "History" }).click();
  await page.getByTestId("architecture-history-panel").getByRole("button", { name: /Revision 1/ }).click();
  await page.getByRole("button", { name: "Use as new draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?`));
  await expect(page.getByRole("heading", { name: "Draft from Revision 1" })).toBeVisible();
  await expect(page.getByText("Draft from Revision 1 · saves after Revision 2", { exact: true })).toBeVisible();
  await treeRow(page, "Research archive").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Research restored");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Restore the research branch");

  // Replacing a dirty draft from history asks first; dismiss keeps it.
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByTestId("architecture-history-panel").getByRole("button", { name: /Revision 1/ }).click();
  await page.getByRole("button", { name: "Use as new draft" }).click();
  await expect.poll(() => dialogs.messages.length).toBe(1);
  await page.getByRole("link", { name: "Resume draft", exact: true }).click();
  await expect(label).toHaveValue("Research restored");

  const save = page.getByRole("button", { name: "Save revision" });
  await save.click();
  await expect(page.getByText("Architecture data is not available.")).toBeVisible();
  await expect(label).toHaveValue("Research restored");
  await expect(message).toHaveValue("Restore the research branch");

  await save.click();
  await expect(page.getByText("This architecture changed elsewhere. Refresh before saving another revision.")).toBeVisible();
  await expect(label).toHaveValue("Research restored");
  await expect(message).toHaveValue("Restore the research branch");

  await save.click();
  await expect(page.getByText("Revision 3 saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit the current revision" })).toBeVisible();
  await expect(page.getByText("Based on Revision 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Draft revision message")).toHaveValue("");
  await expect(page.getByText("No unsaved changes", { exact: true })).toBeVisible();

  expect(state.revisionCreates).toHaveLength(3);
  for (const create of state.revisionCreates) {
    expect(create).toMatchObject({ architectureId: LARGE_ID, expectedCurrentRevisionId: `${LARGE_ID}-revision-2`, message: "Restore the research branch" });
    expect(create.routerLabels).toContain("Research restored");
  }
  expect(dialogs.messages).toHaveLength(1);
});

test("a new architecture opens its bootstrap Workbench and the first save becomes Revision 1", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/architectures");
  await page.getByRole("button", { name: "New architecture", exact: true }).click();
  await page.locator(".architecture-create-form").getByLabel("Architecture name", { exact: true }).fill("Synthetic bootstrap library");
  await page.getByRole("button", { name: "Create architecture" }).click();

  await expect(page).toHaveURL(/\/architectures\/arch-new\/workbench$/);
  await expect(page.getByRole("heading", { name: "Synthetic bootstrap library", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build the first revision" })).toBeVisible();
  await expect(page.getByText("No saved revision yet", { exact: true })).toBeVisible();

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/architectures\/arch-new$/);
  await expect(page.getByText("No revision yet. Build and save the first revision in the workbench.")).toBeVisible();
  await page.getByRole("link", { name: "Build first revision", exact: true }).click();
  await expect(page).toHaveURL(/\/architectures\/arch-new\/workbench$/);

  const editor = page.getByTestId("architecture-editor");
  await editor.getByLabel("Search registry skills").fill("audit");
  await editor.getByRole("button", { name: "Search", exact: true }).click();
  await editor.getByLabel("Registry skill", { exact: true }).selectOption("synthetic-audit-helper");
  await editor.getByLabel("Exact release", { exact: true }).selectOption("release-audit-120");
  await editor.getByLabel("Release parent router").selectOption({ label: "Domain router" });
  await editor.getByRole("button", { name: "Add selected exact release" }).click();
  await page.getByLabel("Draft revision message").fill("First synthetic revision");
  await expect(editor.getByRole("button", { name: "Save revision" })).toBeEnabled();
  await editor.getByRole("button", { name: "Save revision" }).click();

  await expect(page.getByText("Revision 1 saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit the current revision" })).toBeVisible();
  await expect(page.getByText("Based on Revision 1", { exact: true })).toBeVisible();
  expect(state.revisionCreates).toEqual([expect.objectContaining({
    architectureId: "arch-new",
    expectedCurrentRevisionId: null,
    message: "First synthetic revision",
    skillSlugs: ["synthetic-audit-helper"],
  })]);
  expect(dialogs.messages).toEqual([]);
});

test("read-only members inspect without write controls and unavailable or invalid explicit targets never widen the selection", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/architectures/arch-member");
  await expect(page.getByRole("heading", { name: "Shared team library", level: 2 })).toBeVisible();
  await expect(page.getByTestId("architecture-access-note")).toContainText("Read-only access");
  await expect(page.getByRole("link", { name: "Open workbench", exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Inspect in workbench", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inspect this architecture" })).toBeVisible();
  const editor = page.getByTestId("architecture-editor");
  await expect(editor.getByRole("button", { name: "Save revision" })).toHaveCount(0);
  await expect(page.getByLabel("Draft revision message")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Advanced" })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Preview draft" })).toBeDisabled();
  await page.getByText("Architecture details", { exact: true }).click();
  await expect(editor.getByLabel("Architecture name")).toBeDisabled();

  await page.goto("/architectures/arch-member-empty/workbench");
  await expect(page.getByText("This architecture has no saved revision to inspect yet.")).toBeVisible();
  await expect(page.getByTestId("architecture-editor")).toHaveCount(0);

  for (const target of ["/architectures/arch-hidden", "/architectures/arch-hidden/workbench"]) {
    state.detailRequests.length = 0;
    state.previewRequests.length = 0;
    await page.goto(target);
    await expect(page.getByText("This architecture isn't available to your account.")).toBeVisible();
    await expect(page.getByRole("link", { name: "View all architectures" })).toHaveAttribute("href", "/architectures");
    await expect(page.locator(".cp-list [aria-pressed=\"true\"]")).toHaveCount(0);
    expect(state.detailRequests.filter((id) => id !== "arch-hidden")).toEqual([]);
    expect(state.previewRequests).toEqual([]);
  }

  state.previewRequests.length = 0;
  await page.goto(`/architectures/${LARGE_ID}?profile=unknown-profile&environment=research-lab`);
  const historyLength = await page.evaluate(() => history.length);
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await expect(page.getByText("The requested preview context isn't available for this architecture. Showing the default context.")).toBeVisible();
  await expect(page.getByLabel("Preview profile")).toHaveValue("personal");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  expect(state.previewRequests.some((request) => request.profileId === "unknown-profile")).toBe(false);
});

test("stale saved and draft previews never replace the current context, and edits clear an older draft preview", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(overviewOutline(page)).toContainText("Engineering skill 01");

  const releaseResearch = hold(state, `preview:${LARGE_ID}:research`);
  await page.getByLabel("Preview profile").selectOption("research");
  await expect.poll(() => state.previewRequests.at(-1)?.profileId).toBe("research");
  await page.getByLabel("Preview profile").selectOption("personal");
  await expect.poll(() => state.completedPreviews.filter((key) => key === `preview:${LARGE_ID}:personal`).length).toBeGreaterThanOrEqual(2);
  releaseResearch();
  await expect.poll(() => state.completedPreviews.includes(`preview:${LARGE_ID}:research`)).toBe(true);
  await expect(overviewOutline(page)).toContainText("Engineering skill 01");
  await expect(page.getByLabel("Preview profile")).toHaveValue("personal");

  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Writing").click();
  await page.getByLabel("Selected node label").fill("Writing and editing");
  const releaseDraft = hold(state, `draft:${LARGE_ID}:personal`);
  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect.poll(() => state.draftPreviewRequests.length).toBe(1);
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Preview profile").selectOption("research");
  await expect(page).toHaveURL(/profile=research&environment=research-lab/);
  releaseDraft();
  await expect.poll(() => state.completedDraftPreviews.includes(`draft:${LARGE_ID}:personal`)).toBe(true);
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toHaveCount(0);

  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  expect(state.draftPreviewRequests.at(-1)).toMatchObject({ profileId: "research", environmentId: "research-lab" });
  expect(state.draftPreviewRequests.at(-1)?.routerLabels).toContain("Writing and editing");

  await page.getByRole("tab", { name: "Design" }).click();
  await treeRow(page, "Writing and editing").click();
  await page.getByLabel("Selected node label").fill("Writing studio");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toHaveCount(0);
});

for (const width of [1024, 390, 320]) test(`the Workbench stays usable without horizontal overflow at ${width}`, async ({ page }, info) => {
  await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 844 });
  await page.goto("/architectures");
  await page.getByRole("button", { name: new RegExp(LARGE_NAME) }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);

  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeFocused();
  await expect(page.getByRole("button", { name: "Save revision" })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const canvas = page.getByTestId("architecture-canvas");
  const tree = page.getByRole("tree", { name: "Semantic architecture nodes" });
  if (width < 700) {
    const outlineToggle = page.getByRole("button", { name: "Outline & details" });
    const canvasToggle = page.getByRole("button", { name: "Canvas", exact: true });
    await expect(canvasToggle).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toBeVisible();
    await expect(tree).toBeHidden();
    await outlineToggle.click();
    await expect(outlineToggle).toHaveAttribute("aria-pressed", "true");
    await expect(tree).toBeVisible();
    await expect(canvas).toBeHidden();
    await treeRow(page, "Product").click();
    await page.getByLabel("Selected node label").fill("Product planning");
    await canvasToggle.click();
    await expect(canvas).toBeVisible();
    await expect.poll(() => isWithin(flowNode(canvas, "Router: Product planning"), canvas)).toBe(true);
  } else {
    await expect(canvas).toBeVisible();
    await expect(tree).toBeVisible();
    await expect(page.getByRole("button", { name: "Outline & details" })).toBeHidden();
    await treeRow(page, "Product").click();
    await page.getByLabel("Selected node label").fill("Product planning");
    const actionTops = await Promise.all(["Discard", "Preview draft", "Save revision"].map(async (name) => (await page.getByRole("button", { name, exact: true }).boundingBox())!.y));
    expect(Math.max(...actionTops) - Math.min(...actionTops)).toBeLessThanOrEqual(2);
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath(`workbench-${width}.png`) });

  await page.getByRole("link", { name: "Architecture overview" }).click();
  const resume = page.getByRole("link", { name: "Resume draft", exact: true });
  await expect(resume).toBeFocused();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await resume.click();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Product planning");
  expect(dialogs.messages).toEqual([]);
});

test("a modified click on the launcher opens a separate tab without prompting or disturbing the draft", async ({ page, context }) => {
  await installWorkbenchMock(context);
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await page.getByLabel("Draft revision message").fill("Stay in the first tab");
  await page.getByRole("link", { name: "Architecture overview" }).click();

  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Resume draft", exact: true }).click({ modifiers: ["ControlOrMeta"] }),
  ]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=personal&environment=personal-laptop$`));
  await expect(popup.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeVisible();
  await expect(popup.getByLabel("Draft revision message")).toHaveValue("");
  await popup.close();

  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?`));
  await page.getByRole("link", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Draft revision message")).toHaveValue("Stay in the first tab");
  expect(dialogs.messages).toEqual([]);
});

// Parent review regressions: same-architecture history entries keep their own
// context, and an in-flight save cannot disturb a newer draft session.
test("Back and Forward within one architecture restore each entry's preview context, never widen an organization, and keep the draft", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Writing").click();
  await page.getByLabel("Selected node label").fill("Writing desk");
  await page.getByLabel("Draft revision message").fill("Context round trip");
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Preview profile").selectOption("research");
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  await expect.poll(() => state.previewRequests.at(-1)?.profileId).toBe("research");
  const personalRequests = state.previewRequests.filter((request) => request.profileId === "personal").length;

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await expect(page.getByLabel("Preview profile")).toHaveValue("personal");
  await expect(page.getByLabel("Preview environment")).toHaveValue("personal-laptop");
  await expect.poll(() => state.previewRequests.filter((request) => request.profileId === "personal").length).toBeGreaterThan(personalRequests);
  await expect(overviewOutline(page)).toContainText("Engineering skill 01");
  await expect(page.getByRole("link", { name: "Resume draft", exact: true })).toBeVisible();

  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  await expect(page.getByLabel("Preview profile")).toHaveValue("research");
  await expect.poll(() => state.previewRequests.at(-1)?.profileId).toBe("research");
  await page.getByRole("tab", { name: "Design" }).click();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Writing desk");
  await expect(page.getByLabel("Draft revision message")).toHaveValue("Context round trip");

  expect(dialogs.messages).toEqual([]);

  // Organization context on one owner architecture shared with two organizations.
  dialogs.policy = "accept";
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("No unsaved changes", { exact: true })).toBeVisible();
  dialogs.messages.length = 0;
  await page.goto("/architectures/arch-shared?profile=default&environment=ops-laptop&organization=org-alpha");
  await expect(page.getByLabel("Preview organization")).toHaveValue("org-alpha");
  await expect.poll(() => state.previewRequests.at(-1)).toMatchObject({ architectureId: "arch-shared", organizationId: "org-alpha" });
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await page.getByLabel("Draft revision message").fill("Organization round trip");
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Preview organization").selectOption("");
  await expect(page).toHaveURL(/\/architectures\/arch-shared\/workbench\?profile=default&environment=ops-laptop$/);

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/\/architectures\/arch-shared\?profile=default&environment=ops-laptop&organization=org-alpha$/);
  await expect(page.getByLabel("Preview organization")).toHaveValue("org-alpha");
  await expect.poll(() => state.previewRequests.at(-1)?.organizationId).toBe("org-alpha");

  // A same-architecture entry naming an organization outside the grant is never applied.
  await page.evaluate(() => {
    history.pushState(null, "", "/architectures/arch-shared?profile=default&environment=ops-laptop&organization=org-forbidden");
    history.back();
  });
  await expect(page).toHaveURL(/organization=org-alpha$/);
  await page.evaluate(() => history.forward());
  await expect(page.getByText("The requested preview context isn't available for this architecture. Showing the default context.")).toBeVisible();
  await expect(page).toHaveURL(/\/architectures\/arch-shared\?profile=default&environment=ops-laptop$/);
  await expect(page.getByLabel("Preview organization")).toHaveValue("");
  expect(state.previewRequests.some((request) => request.organizationId === "org-forbidden")).toBe(false);
  await page.getByRole("link", { name: "Resume draft", exact: true }).click();
  await expect(page.getByLabel("Draft revision message")).toHaveValue("Organization round trip");
  expect(dialogs.messages).toEqual([]);
});

test("a save that finishes after switching architectures never refreshes or replaces the newer draft", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  dialogs.policy = "accept";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Writing").click();
  await page.getByLabel("Selected node label").fill("Writing pending save");
  await page.getByLabel("Draft revision message").fill("Pending save");
  const releaseSave = hold(state, `save:${LARGE_ID}`);
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect.poll(() => state.revisionCreates.length).toBe(1);

  await page.getByRole("link", { name: "Architecture overview" }).click();
  await page.getByRole("button", { name: /Second routing library/ }).click();
  await expect(page.getByRole("heading", { name: "Second routing library", level: 2 })).toBeVisible();
  expect(dialogs.messages).toHaveLength(1);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Operations").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Operations desk");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Newer draft");
  const listRequests = state.listRequests;

  releaseSave();
  await expect.poll(() => state.completedSaves).toContain(LARGE_ID);
  // A later round trip proves the stale save response has been handled.
  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  expect(state.draftPreviewRequests.at(-1)).toMatchObject({ architectureId: "arch-second" });
  expect(state.listRequests).toBe(listRequests);
  await expect(page.getByText(/Revision \d+ saved\./)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Second routing library", level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: "Design" }).click();
  await expect(label).toHaveValue("Operations desk");
  await expect(message).toHaveValue("Newer draft");
  expect(dialogs.messages).toHaveLength(1);
});

test("an accepted refresh starts a new draft session that a pending save of the same architecture cannot refresh away", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  dialogs.policy = "accept";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Writing").click();
  await page.getByLabel("Selected node label").fill("Writing pending save");
  const releaseSave = hold(state, `save:${LARGE_ID}`);
  await page.getByRole("button", { name: "Save revision" }).click();
  await expect.poll(() => state.revisionCreates.length).toBe(1);

  await page.getByRole("link", { name: "Architecture overview" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => dialogs.messages.length).toBe(1);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Product").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Product after refresh");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Draft after refresh");
  const listRequests = state.listRequests;

  releaseSave();
  await expect.poll(() => state.completedSaves).toContain(LARGE_ID);
  await page.getByRole("button", { name: "Preview draft" }).click();
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  expect(state.listRequests).toBe(listRequests);
  await expect(page.getByText(/Revision \d+ saved\./)).toHaveCount(0);
  await page.getByRole("tab", { name: "Design" }).click();
  await expect(label).toHaveValue("Product after refresh");
  await expect(message).toHaveValue("Draft after refresh");
  expect(dialogs.messages).toHaveLength(1);
});

test("using the same historical revision again after editing it resets the draft spec and message", async ({ page }) => {
  await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  const history = page.getByTestId("architecture-history-panel");
  await page.getByRole("tab", { name: "History" }).click();
  await history.getByRole("button", { name: /Revision 1/ }).click();
  await page.getByRole("button", { name: "Use as new draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft from Revision 1" })).toBeVisible();
  await treeRow(page, "Research archive").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Edited archive");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Edited from history");

  await page.getByRole("link", { name: "Architecture overview" }).click();
  await page.getByRole("tab", { name: "History" }).click();
  await history.getByRole("button", { name: /Revision 1/ }).click();
  dialogs.policy = "accept";
  await page.getByRole("button", { name: "Use as new draft" }).click();
  await expect.poll(() => dialogs.messages.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Draft from Revision 1" })).toBeVisible();
  await expect(message).toHaveValue("");
  await expect(page.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await expect(treeRow(page, "Research archive")).toHaveCount(1);
  await expect(treeRow(page, "Edited archive")).toHaveCount(0);
});

// Final completion pass: nothing typed during a pending save can be lost, and
// a slow detail reload cannot overwrite the context of a Back/Forward entry.
test("semantic editing pauses while a save is pending, resumes after a failure, and the saved edit is retained", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await treeRow(page, "Writing").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Writing held");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Held save");
  const editor = page.getByTestId("architecture-editor");
  state.saveResponses.push(500);

  let releaseSave = hold(state, `save:${LARGE_ID}`);
  await editor.getByRole("button", { name: "Save revision" }).click();
  await expect.poll(() => state.revisionCreates.length).toBe(1);
  await expect(editor.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(label).toBeDisabled();
  await expect(message).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Router", exact: true })).toBeDisabled();
  await expect(editor.getByLabel("Move selected node")).toBeDisabled();
  await page.getByText("Architecture details", { exact: true }).click();
  await expect(editor.getByLabel("Architecture name")).toBeDisabled();
  await page.getByRole("tab", { name: "Profiles & environments" }).click();
  await expect(editor.getByLabel("Profile name")).toBeDisabled();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByText("Add immutable revision", { exact: true }).click();
  await expect(editor.getByLabel("Architecture spec JSON")).toBeDisabled();
  await page.getByRole("tab", { name: "Design" }).click();

  releaseSave();
  await expect(page.getByText("Architecture data is not available.")).toBeVisible();
  await expect(label).toBeEnabled();
  await expect(label).toHaveValue("Writing held");
  await expect(message).toBeEnabled();
  await expect(message).toHaveValue("Held save");
  await label.fill("Writing held twice");

  releaseSave = hold(state, `save:${LARGE_ID}`);
  await editor.getByRole("button", { name: "Save revision" }).click();
  await expect.poll(() => state.revisionCreates.length).toBe(2);
  await expect(label).toBeDisabled();
  releaseSave();
  await expect(page.getByText("Revision 3 saved.", { exact: true })).toBeVisible();
  expect(state.revisionCreates[1]?.routerLabels).toContain("Writing held twice");
  await expect(treeRow(page, "Writing held twice")).toHaveCount(1);
  await expect(page.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Selected node label")).toBeEnabled();
});

test("a Back or Forward move during a slow detail reload keeps the destination entry's validated context", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByLabel("Preview profile").selectOption("research");
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  await page.evaluate(() => history.back());
  await expect(page.getByLabel("Preview profile")).toHaveValue("personal");

  // Reload the same architecture slowly, then move Forward before it returns.
  let releaseDetail = hold(state, `detail:${LARGE_ID}`);
  const detailRequests = state.detailRequests.length;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => state.detailRequests.length).toBeGreaterThan(detailRequests);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  releaseDetail();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeVisible();
  await expect.poll(() => state.previewRequests.at(-1)).toMatchObject({ architectureId: LARGE_ID, profileId: "research", environmentId: "research-lab" });
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=research&environment=research-lab$`));
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByLabel("Preview profile")).toHaveValue("research");

  // An organization outside the grant stays unapplied even while loading.
  await page.goto("/architectures/arch-shared?profile=default&environment=ops-laptop&organization=org-alpha");
  await expect(page.getByLabel("Preview organization")).toHaveValue("org-alpha");
  releaseDetail = hold(state, "detail:arch-shared");
  const sharedRequests = state.detailRequests.length;
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => state.detailRequests.length).toBeGreaterThan(sharedRequests);
  await page.evaluate(() => {
    history.pushState(null, "", "/architectures/arch-shared?profile=default&environment=ops-laptop&organization=org-forbidden");
    history.back();
  });
  await expect(page).toHaveURL(/organization=org-alpha$/);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/organization=org-forbidden$/);
  releaseDetail();
  await expect(page.getByText("The requested preview context isn't available for this architecture. Showing the default context.")).toBeVisible();
  await expect(page).toHaveURL(/\/architectures\/arch-shared\?profile=default&environment=ops-laptop$/);
  await expect(page.getByLabel("Preview organization")).toHaveValue("");
  expect(state.previewRequests.some((request) => request.organizationId === "org-forbidden")).toBe(false);
  expect(dialogs.messages).toEqual([]);
});
