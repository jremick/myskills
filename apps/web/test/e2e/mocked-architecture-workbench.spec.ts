import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import {
  compileArchitecture,
  createArchitectureDiagramArtifact,
  mermaidArchitecture,
  type ArchitectureSpecV1,
  type CompiledArchitecture,
} from "@myskills-app/core";
import {
  architectureUi as ui,
  chooseExposure,
  draftChange,
  effectiveFontSize,
  expandAllNodes,
  expectArchitectureUrl,
  MIN_LEGIBLE_LABEL_PX,
  ORGANIZATION_LIBRARY,
  organizationLibrarySpec,
  SCALE_LIBRARY,
  scaleLibrarySpec,
  showAllDraftChanges,
  visibleNodeIds,
} from "./architecture-explorer-support.js";

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
const PERSONAL = { profile: "personal", environment: "personal-laptop" };
const RESEARCH = { profile: "research", environment: "research-lab" };

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
  /** Mirrors the API for readers whose only access reason is an organization grant. */
  organizationOnly?: boolean;
};

interface WorkbenchMockState {
  records: Map<string, ArchitectureRecord>;
  listOrder: string[];
  listRequests: number;
  detailRequests: string[];
  revisionRequests: string[];
  previewRequests: Array<{ architectureId: string; profileId?: string; environmentId?: string; organizationId?: string; revisionId?: string }>;
  completedPreviews: string[];
  draftPreviewRequests: Array<{ architectureId: string; profileId?: string; environmentId?: string; expectedCurrentRevisionId: unknown; routerLabels: string[] }>;
  completedDraftPreviews: string[];
  revisionCreates: Array<{ architectureId: string; expectedCurrentRevisionId: unknown; message?: unknown; routerLabels: string[]; skillSlugs: string[]; nodeIds: string[]; parentOf: Record<string, string> }>;
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

// The signed-in user reads this architecture only through an organization grant.
function organizationSummaryFor(revisions: Revision[]) {
  const ownerRef = { type: "user" as const, id: ORGANIZATION_LIBRARY.publisherId };
  return {
    id: ORGANIZATION_LIBRARY.id,
    ownerUserId: ownerRef.id,
    ownerTeamId: null,
    owner: ownerRef,
    ownerType: ownerRef.type,
    ownerId: ownerRef.id,
    accessPolicyVersion: 1,
    access: {
      allowedOrganizationIds: [ORGANIZATION_LIBRARY.organizationId],
      owner: ownerRef,
      ownerType: ownerRef.type,
      ownerId: ownerRef.id,
      policyVersion: 1,
      accessPolicyVersion: 1,
      role: "none",
      canList: true,
      canRead: true,
      canPreview: true,
      canCreate: false,
      canAppend: false,
      canManage: false,
      reasons: ["organization"],
    },
    name: ORGANIZATION_LIBRARY.name,
    description: ORGANIZATION_LIBRARY.description,
    patternId: "multi-level-router",
    scope: "work",
    currentRevisionId: revisions.at(-1)?.id ?? null,
    revisionCount: revisions.length,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

function addScaleLibrary(state: WorkbenchMockState) {
  const revisions = [revisionFor(SCALE_LIBRARY.id, 1, "Scale import", scaleLibrarySpec(owner.id))];
  state.records.set(SCALE_LIBRARY.id, { summary: summaryFor(SCALE_LIBRARY.id, SCALE_LIBRARY.name, SCALE_LIBRARY.description, "owner", revisions), revisions });
  state.listOrder.push(SCALE_LIBRARY.id);
}

function addOrganizationLibrary(state: WorkbenchMockState) {
  const revisions = [revisionFor(ORGANIZATION_LIBRARY.id, 1, "Organization shell", organizationLibrarySpec())];
  state.records.set(ORGANIZATION_LIBRARY.id, { summary: organizationSummaryFor(revisions), revisions, organizationOnly: true });
  state.listOrder.push(ORGANIZATION_LIBRARY.id);
}

function compiledNodeIds(spec: ArchitectureSpecV1, profileId?: string, environmentId?: string): string[] {
  return compileFor(spec, profileId, environmentId).nodes.map((node) => node.id).sort();
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
    revisionRequests: [],
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
        // Organization-only readers never receive a revision spec.
        latestRevision: record.organizationOnly ? null : record.revisions.at(-1) ?? null,
      });
    }

    const grantsMatch = path.match(/^\/v1\/architectures\/([^/]+)\/organization-grants$/);
    if (grantsMatch && method === "GET") {
      const record = state.records.get(decodeURIComponent(grantsMatch[1]!));
      return json(route, 200, { architectureId: grantsMatch[1], currentRevisionId: record?.revisions.at(-1)?.id ?? null, grants: [], organizationIds: [] });
    }

    const revisionMatch = path.match(/^\/v1\/architectures\/([^/]+)\/revisions\/([^/]+)$/);
    if (revisionMatch && method === "GET") {
      state.revisionRequests.push(decodeURIComponent(revisionMatch[2]!));
      const record = state.records.get(decodeURIComponent(revisionMatch[1]!));
      if (record?.organizationOnly) return json(route, 404, { error: { code: "ARCHITECTURE_NOT_FOUND", message: "Architecture not found." } });
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
        nodeIds: spec.nodes.map((node) => node.id),
        parentOf: Object.fromEntries(spec.edges.map((edge) => [edge.to, edge.from])),
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
      // As in the API, an organization-only preview needs a granted
      // organization and returns no revision, only the compiled projection.
      if (record?.organizationOnly && body.organizationId !== ORGANIZATION_LIBRARY.organizationId) {
        return json(route, 404, { error: { code: "ARCHITECTURE_ORGANIZATION_CONTEXT_NOT_AVAILABLE", message: "The organization context is unavailable for this architecture." } });
      }
      const revision = record?.revisions.find((candidate) => candidate.id === revisionId) ?? record?.revisions.at(-1);
      if (!revision) return json(route, 404, { error: { code: "ARCHITECTURE_REVISION_NOT_FOUND", message: "Revision not found." } });
      const projection = previewProjection(compileFor(revision.spec, profileId, environmentId));
      state.completedPreviews.push(key);
      return json(route, 200, record?.organizationOnly ? projection : { revision, ...projection });
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

  // Structure opens by default on the API result for the research context:
  // the list holds exactly that context's compiled nodes, never another's.
  await expect(ui.tab(page, "Structure")).toHaveAttribute("aria-selected", "true");
  await expect(ui.tab(page, "Skills")).toContainText("24");
  const researchIds = compiledNodeIds(largeSpec("Research"), "research", "research-lab");
  expect(researchIds).toHaveLength(27);
  await chooseExposure(page, "Exposed only");
  await expandAllNodes(page);
  await expect.poll(() => visibleNodeIds(page)).toEqual(researchIds);
  // An owner may also list the revision's other nodes, never nodes outside it.
  if (await chooseExposure(page, "All nodes")) {
    await expandAllNodes(page);
    const allIds = await visibleNodeIds(page);
    expect(allIds).toEqual(expect.arrayContaining(researchIds));
    expect(largeSpec("Research").nodes.map((node) => node.id)).toEqual(expect.arrayContaining(allIds));
    await chooseExposure(page, "Exposed only");
  }

  // Search keeps each match's branch and says when nothing matches.
  await ui.search(page).fill("Writing skill 12");
  await expect.poll(() => visibleNodeIds(page)).toEqual(["library-root", "writing", "writing-12"]);
  await ui.search(page).fill("Engineering skill 01");
  await expect(ui.noResults(page)).toBeVisible();
  await expect(ui.rows(page)).toHaveCount(0);
  await ui.clearSearch(page).click();
  await expect(ui.search(page)).toHaveValue("");
  await expect(ui.row(page, "research")).toBeVisible();
  await expect(ui.row(page, "writing")).toBeVisible();

  // Skills lists only this context's skills, with search, an exposure filter
  // and readable exposure, and hands a row to Structure.
  await ui.tab(page, "Skills").click();
  await expect(ui.skillRows(page)).toHaveCount(24);
  await expect(ui.skillsTable(page)).toContainText(ui.readableLeafExposure);
  await expect(ui.skillsTable(page)).not.toContainText("research-lab");
  await ui.skillsSearch(page).fill("Writing skill 1");
  await expect(ui.skillRows(page)).toHaveCount(3);
  await ui.skillsSearch(page).fill("Engineering");
  await expect(ui.skillRows(page)).toHaveCount(0);
  await ui.skillsSearch(page).fill("");
  await ui.skillsExposure(page).selectOption({ label: ui.skillsExposureOption.router });
  await expect(ui.skillRows(page)).toHaveCount(0);
  await ui.skillsPanel(page).getByRole("button", { name: "Clear filters" }).click();
  await expect(ui.skillRows(page)).toHaveCount(24);
  await ui.skillsExposure(page).selectOption({ label: ui.skillsExposureOption.leaf });
  await expect(ui.skillRows(page)).toHaveCount(24);
  await ui.skillsSearch(page).fill("Writing skill 12");
  await expect(ui.skillRows(page)).toHaveCount(1);
  await ui.skillsPanel(page).getByRole("button", { name: /Show in structure/ }).click();
  await expect(ui.tab(page, "Structure")).toHaveAttribute("aria-selected", "true");
  await expect(ui.rowSelect(ui.row(page, "writing-12"))).toHaveAttribute("aria-current", "true");
  await expect(ui.inspector(page)).toContainText("Writing skill 12");
  await expect(ui.inspector(page)).toContainText("Library root");
  await expect(ui.inspector(page)).toContainText("1.0.0");
  await expectArchitectureUrl(page, { id: LARGE_ID, context: RESEARCH, node: "writing-12" });

  // The launcher carries the selected node and context into the Workbench.
  const launcher = page.getByRole("link", { name: "Open workbench", exact: true });
  await expect(launcher).toHaveAttribute("href", `/architectures/${LARGE_ID}/workbench?profile=research&environment=research-lab&node=writing-12`);
  await launcher.click();
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: RESEARCH, node: "writing-12" });
  const workbenchTitle = page.getByRole("heading", { name: LARGE_NAME, level: 1 });
  await expect(workbenchTitle).toBeFocused();
  await expect(page.getByRole("heading", { name: "Edit the current revision" })).toBeVisible();
  await expect(page.getByText("Based on Revision 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Skill architectures", level: 1 })).toBeHidden();
  await expect(page.getByRole("list", { name: "Saved architectures" })).toBeHidden();
  await expect(page.getByText("Effective result returned by API")).toHaveCount(0);
  await expect(page.getByLabel("Selected node label")).toHaveValue("Writing skill 12");
  await expect(treeRow(page, "Writing skill 12")).toHaveAttribute("aria-selected", "true");

  // The 82-node draft is navigable: the tree scrolls in its own pane and the
  // oriented canvas shows the handed-off node beside a visible minimap.
  const canvas = page.getByTestId("architecture-canvas");
  expect((await canvas.boundingBox())!.height).toBeGreaterThanOrEqual(480);
  await expect(canvas.locator("[aria-roledescription=\"node\"]")).toHaveCount(82);
  await expect(canvas.locator(".react-flow__minimap")).toBeVisible();
  await expect.poll(() => isWithin(flowNode(canvas, "Leaf: Writing skill 12"), canvas)).toBe(true);
  // Readability, not just presence: the oriented node renders near full size
  // and the minimap stays a small navigation aid.
  const canvasBox = (await canvas.boundingBox())!;
  expect((await flowNode(canvas, "Leaf: Writing skill 12").boundingBox())!.width).toBeGreaterThanOrEqual(160);
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

  // The Workbench selection is part of the URL, so a reload keeps it.
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: RESEARCH, node: "files-13" });
  await page.reload();
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: RESEARCH, node: "files-13" });
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeVisible();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Files and media skill 13");
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

test("Structure selection hands off to the Workbench with its context; Back and Forward keep the draft, named change and fitted canvas while the overview keeps the saved result", async ({ page }, info) => {
  const state = await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));

  // 82 nodes open with the root and its six routers only; routers count
  // their leaf skills, never other routers.
  await expect(ui.explorer(page)).toContainText(ui.summary(7, 75));
  await expect(ui.rows(page)).toHaveCount(7);
  await expect(ui.leafRows(page)).toHaveCount(0);
  for (const branch of BRANCHES) {
    await expect(ui.toggle(page, "Expand", branch.label)).toHaveAttribute("aria-expanded", "false");
    await expect(ui.row(page, branch.id)).toContainText(ui.skillCount(branch.leaves));
  }
  await expect(ui.row(page, "library-root")).toContainText(ui.skillCount(75));
  await expect(ui.row(page, "library-root")).not.toContainText(ui.skillCount(81));
  await ui.toggle(page, "Expand", "Engineering").click();
  await expect(ui.row(page, "engineering-01")).toBeVisible();
  await expect(ui.leafRows(page)).toHaveCount(14);
  await ui.toggle(page, "Collapse", "Engineering").click();
  await expect(ui.leafRows(page)).toHaveCount(0);

  // Rows are real buttons: keyboard selection updates the URL and inspector.
  const researchSelect = ui.rowSelect(ui.row(page, "research"));
  await researchSelect.focus();
  await page.keyboard.press("Enter");
  await expect(researchSelect).toHaveAttribute("aria-current", "true");
  await expectArchitectureUrl(page, { id: LARGE_ID, context: PERSONAL, node: "research" });
  await expect(ui.inspector(page)).toContainText("Research");
  await expect(ui.inspector(page)).toContainText("Library root");

  // Edit in Workbench keeps the node and the context.
  await ui.editInWorkbench(page).click();
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: PERSONAL, node: "research" });
  const label = page.getByLabel("Selected node label");
  await expect(label).toHaveValue("Research");
  await expect(treeRow(page, "Research")).toHaveAttribute("aria-selected", "true");
  const changes = ui.draftChanges(page);
  await expect(changes).toContainText("No changes in this draft yet");
  await label.fill("Research and discovery");
  await expect(changes).toContainText(draftChange.renamed("Research", "Research and discovery"));
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
  await expectArchitectureUrl(page, { id: LARGE_ID, context: PERSONAL, node: "research" });
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  const resume = page.getByRole("link", { name: "Resume draft", exact: true });
  await expect(resume).toBeVisible();
  await expect(page.getByText("You have an unsaved draft in the workbench.")).toBeVisible();
  // The overview restores the same selection and shows the saved revision,
  // never the unsaved draft.
  await expect(researchSelect).toHaveAttribute("aria-current", "true");
  await expect(ui.row(page, "research")).toContainText("Research");
  await expect(ui.row(page, "research")).not.toContainText("Research and discovery");
  await expect(ui.row(page, "research")).toContainText(ui.skillCount(12));
  await page.screenshot({ path: info.outputPath("overview-resume-draft.png") });

  await page.evaluate(() => history.forward());
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: PERSONAL, node: "research" });
  await expect(page.getByText("Unsaved draft preview · noncanonical")).toBeVisible();
  await page.getByRole("tab", { name: "Design" }).click();
  await expect(label).toHaveValue("Research and discovery");
  await expect(message).toHaveValue("Rename the research branch");
  await expect(changes).toContainText(draftChange.renamed("Research", "Research and discovery"));
  // The re-shown canvas is oriented on the selected node at a readable scale.
  await expect.poll(() => isWithin(flowNode(canvas, "Router: Research and discovery"), canvas)).toBe(true);

  await page.getByRole("link", { name: "Architecture overview" }).click();
  await expect(resume).toBeFocused();
  await expectArchitectureUrl(page, { id: LARGE_ID, context: PERSONAL, node: "research" });
  await expect(researchSelect).toHaveAttribute("aria-current", "true");
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

  await page.locator(".side-nav").getByRole("link", { name: "Skills", exact: true }).click();
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
  await page.locator(".side-nav").getByRole("link", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/\/registry/);
  expect(dialogs.messages).toHaveLength(5);
});

test("a history draft names its changes and saves against the latest revision token, keeping spec, message and named changes after failed and conflicting saves", async ({ page }) => {
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
  // Changes are named against the revision the draft started from.
  const changes = ui.draftChanges(page);
  await expect(changes).toContainText("No changes in this draft yet");
  await treeRow(page, "Research archive").click();
  const label = page.getByLabel("Selected node label");
  await label.fill("Research restored");
  const message = page.getByLabel("Draft revision message");
  await message.fill("Restore the research branch");
  await expect(changes).toContainText(draftChange.renamed("Research archive", "Research restored"));

  // Move, add and remove are named too, not only renames.
  const editor = page.getByTestId("architecture-editor");
  await treeRow(page, "Engineering skill 01").click();
  await editor.getByLabel("Move selected node").selectOption({ label: "Under Writing" });
  await expect(changes).toContainText(draftChange.moved("Engineering skill 01", "Engineering", "Writing"));
  await treeRow(page, "Product").click();
  await editor.getByRole("button", { name: "Router", exact: true }).click();
  await expect(label).toHaveValue("New router");
  await expect(changes).toContainText(draftChange.added("router", "New router", "Product"));
  dialogs.policy = "accept";
  await treeRow(page, "Files and media skill 13").click();
  await editor.getByRole("button", { name: "Remove leaf", exact: true }).click();
  await expect.poll(() => dialogs.messages.length).toBe(1);
  expect(dialogs.messages[0]).toMatch(/^Remove Files and media skill 13/);
  dialogs.policy = "dismiss";
  await treeRow(page, "Research restored").click();
  await expect(label).toHaveValue("Research restored");
  const namedChanges = [
    draftChange.renamed("Research archive", "Research restored"),
    draftChange.moved("Engineering skill 01", "Engineering", "Writing"),
    draftChange.added("router", "New router", "Product"),
    draftChange.removed("skill", "Files and media skill 13"),
  ];
  const expectNamedChanges = async () => {
    for (const change of namedChanges) await expect(changes).toContainText(change);
    await expect(changes).not.toContainText("Other changes");
  };
  await showAllDraftChanges(page);
  await expectNamedChanges();

  // Replacing a dirty draft from history asks first; dismiss keeps it.
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await page.getByRole("tab", { name: "History" }).click();
  await page.getByTestId("architecture-history-panel").getByRole("button", { name: /Revision 1/ }).click();
  await page.getByRole("button", { name: "Use as new draft" }).click();
  await expect.poll(() => dialogs.messages.length).toBe(2);
  await page.getByRole("link", { name: "Resume draft", exact: true }).click();
  await expect(label).toHaveValue("Research restored");
  await expectNamedChanges();

  const save = page.getByRole("button", { name: "Save revision" });
  await save.click();
  await expect(page.getByText("Architecture data is not available.")).toBeVisible();
  await expect(label).toHaveValue("Research restored");
  await expect(message).toHaveValue("Restore the research branch");
  await expectNamedChanges();

  await save.click();
  await expect(page.getByText("This architecture changed elsewhere. Refresh before saving another revision.")).toBeVisible();
  await expect(label).toHaveValue("Research restored");
  await expect(message).toHaveValue("Restore the research branch");
  await expectNamedChanges();

  await save.click();
  await expect(page.getByText("Revision 3 saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Edit the current revision" })).toBeVisible();
  await expect(page.getByText("Based on Revision 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Draft revision message")).toHaveValue("");
  await expect(page.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await expect(changes).toContainText("No changes in this draft yet");

  // Every attempt carried the whole named draft and the same revision token.
  const revisionTwoIds = new Set(largeSpec("Research").nodes.map((node) => node.id));
  expect(state.revisionCreates).toHaveLength(3);
  for (const create of state.revisionCreates) {
    expect(create).toMatchObject({ architectureId: LARGE_ID, expectedCurrentRevisionId: `${LARGE_ID}-revision-2`, message: "Restore the research branch" });
    expect(create.routerLabels).toContain("Research restored");
    expect(create.parentOf["engineering-01"]).toBe("writing");
    expect(create.nodeIds).not.toContain("files-13");
    const added = create.nodeIds.filter((id) => !revisionTwoIds.has(id));
    expect(added).toHaveLength(1);
    expect(create.parentOf[added[0]!]).toBe("product");
  }
  expect(dialogs.messages).toHaveLength(2);

  // The overview now shows the saved revision from the API.
  await page.getByRole("link", { name: "Architecture overview" }).click();
  await ui.tab(page, "Structure").click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  await ui.search(page).fill("Research restored");
  await expect.poll(() => visibleNodeIds(page)).toEqual(["library-root", "research"]);
  await ui.search(page).fill("Files and media skill 13");
  await expect(ui.noResults(page)).toBeVisible();
  await ui.search(page).fill("Engineering skill 01");
  await ui.rowSelect(ui.row(page, "engineering-01")).click();
  await expect(ui.inspector(page)).toContainText("Writing");
  expect(dialogs.messages).toHaveLength(2);
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
  await editor.getByLabel("Search skills").fill("audit");
  await editor.getByRole("button", { name: "Search", exact: true }).click();
  await editor.getByLabel("Skill", { exact: true }).selectOption("synthetic-audit-helper");
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
  // A reader inspects nodes but gets no edit, sharing or pattern action.
  await expect(ui.tab(page, "Sharing")).toHaveCount(0);
  await expect(ui.changePattern(page)).toHaveCount(0);
  await ui.rowSelect(ui.row(page, "operations")).click();
  await expect(ui.inspector(page)).toContainText("Operations");
  await expect(ui.editInWorkbench(page)).toHaveCount(0);
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

  // A requested node applies only inside the loaded projection: an id from
  // another architecture is dropped without a selection or any extra request,
  // while a valid map view is kept.
  state.detailRequests.length = 0;
  state.previewRequests.length = 0;
  state.revisionRequests.length = 0;
  await page.goto(`/architectures/${LARGE_ID}?node=ops-01&view=map`);
  await expectArchitectureUrl(page, { id: LARGE_ID, context: PERSONAL, node: null, view: "map" });
  await expect(ui.view(page, "Map")).toHaveAttribute("aria-pressed", "true");
  await expect(ui.map(page)).toBeVisible();
  await expect(ui.explorer(page).locator("[aria-current=\"true\"]")).toHaveCount(0);
  expect(new Set(state.detailRequests)).toEqual(new Set([LARGE_ID]));
  expect(state.revisionRequests).toEqual([]);
  expect(state.previewRequests.every((request) => request.architectureId === LARGE_ID && request.profileId === "personal")).toBe(true);

  await page.goto(`/architectures/${LARGE_ID}/workbench?node=ops-01`);
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).not.toBe("ops-01");
  expect(new Set(state.detailRequests)).toEqual(new Set([LARGE_ID]));
  expect(state.revisionRequests).toEqual([]);
});

test("stale saved and draft previews never replace the current architecture or context, and edits clear an older draft preview", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });

  // A late preview of the previously chosen architecture never replaces the
  // current Structure, and a node chosen elsewhere is not carried across.
  await page.goto("/architectures/arch-second");
  await ui.rowSelect(ui.row(page, "operations")).click();
  await expectArchitectureUrl(page, { id: "arch-second", context: { profile: "default", environment: "ops-laptop" }, node: "operations" });
  const releaseLarge = hold(state, `preview:${LARGE_ID}:personal`);
  await page.getByRole("button", { name: new RegExp(LARGE_NAME) }).click();
  await expect.poll(() => state.previewRequests.some((request) => request.architectureId === LARGE_ID)).toBe(true);
  await expectArchitectureUrl(page, { id: LARGE_ID, context: PERSONAL, node: null });
  await page.getByRole("button", { name: /Second routing library/ }).click();
  await expect(page.getByRole("heading", { name: "Second routing library", level: 2 })).toBeVisible();
  await expect(ui.row(page, "ops-root")).toBeVisible();
  releaseLarge();
  await expect.poll(() => state.completedPreviews.includes(`preview:${LARGE_ID}:personal`)).toBe(true);
  await expect(ui.row(page, "operations")).toBeVisible();
  await expect(ui.row(page, "library-root")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Second routing library", level: 2 })).toBeVisible();

  await page.goto(`/architectures/${LARGE_ID}`);
  await expect(ui.tab(page, "Skills")).toContainText("75");
  await expect(ui.row(page, "engineering")).toBeVisible();

  const personalPreviews = () => state.completedPreviews.filter((key) => key === `preview:${LARGE_ID}:personal`).length;
  const personalBefore = personalPreviews();
  const releaseResearch = hold(state, `preview:${LARGE_ID}:research`);
  await page.getByLabel("Preview profile").selectOption("research");
  await expect.poll(() => state.previewRequests.at(-1)?.profileId).toBe("research");
  await page.getByLabel("Preview profile").selectOption("personal");
  await expect.poll(personalPreviews).toBeGreaterThan(personalBefore);
  releaseResearch();
  await expect.poll(() => state.completedPreviews.includes(`preview:${LARGE_ID}:research`)).toBe(true);
  // The newer personal result stays: 75 skills, not the research context's 24.
  await expect(ui.tab(page, "Skills")).toContainText("75");
  await expect(ui.row(page, "engineering")).toBeVisible();
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

for (const width of [1024, 390, 320]) test(`the Structure explorer and Workbench stay usable without horizontal overflow at ${width}`, async ({ page }, info) => {
  await installWorkbenchMock(page.context());
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 844 });
  await page.goto("/architectures");
  await page.getByRole("button", { name: new RegExp(LARGE_NAME) }).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 2 })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);

  // The collapsed list stays inside the viewport and opens details.
  const productSelect = ui.rowSelect(ui.row(page, "product"));
  await expect(productSelect).toBeVisible();
  const rowBox = (await productSelect.boundingBox())!;
  expect(rowBox.x).toBeGreaterThanOrEqual(0);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(width + 1);
  await productSelect.click();
  await expect(ui.inspector(page)).toContainText("Product");
  if (width <= 900) {
    // Narrow screens show details in a sheet; Escape closes it and returns
    // focus to the row that opened it.
    const close = ui.closeDetails(page);
    await expect(close).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await close.focus();
    await page.keyboard.press("Escape");
    await expect(close).toBeHidden();
    await expect(productSelect).toBeFocused();
    await productSelect.click();
    await expect(close).toBeVisible();
  }
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.screenshot({ path: info.outputPath(`structure-${width}.png`) });

  await ui.editInWorkbench(page).click();
  await expect(page.getByRole("heading", { name: LARGE_NAME, level: 1 })).toBeFocused();
  await expect(page.getByRole("button", { name: "Save revision" })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const canvas = page.getByTestId("architecture-canvas");
  const tree = page.getByRole("tree", { name: "Semantic architecture nodes" });
  const label = page.getByLabel("Selected node label");
  if (width < 700) {
    // Narrow Workbench opens on the outline with the handed-off node selected.
    const outlineToggle = page.getByRole("button", { name: "Outline & details" });
    const canvasToggle = page.getByRole("button", { name: "Canvas", exact: true });
    await expect(outlineToggle).toHaveAttribute("aria-pressed", "true");
    await expect(tree).toBeVisible();
    await expect(canvas).toBeHidden();
    await expect(treeRow(page, "Product")).toHaveAttribute("aria-selected", "true");
    await expect(label).toHaveValue("Product");
    await label.fill("Product planning");
    await canvasToggle.click();
    await expect(canvasToggle).toHaveAttribute("aria-pressed", "true");
    await expect(canvas).toBeVisible();
    await expect(tree).toBeHidden();
    await expect.poll(() => isWithin(flowNode(canvas, "Router: Product planning"), canvas)).toBe(true);
  } else {
    await expect(canvas).toBeVisible();
    await expect(tree).toBeVisible();
    await expect(page.getByRole("button", { name: "Outline & details" })).toBeHidden();
    await expect(label).toHaveValue("Product");
    await label.fill("Product planning");
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

// Use the full browser for a native tab interaction. The headless shell can
// leave Ctrl-click tabs at about:blank on Linux after their HTML completes.
// https://playwright.dev/docs/browsers#chromium-new-headless-mode
const nativeTabTest = test.extend({ channel: browserExecutable ? undefined : "chromium" });

nativeTabTest("a modified click on the launcher opens a separate tab without prompting or disturbing the draft", async ({ page, context }) => {
  await installWorkbenchMock(context);
  // This navigation check does not need web fonts. A pending external stylesheet
  // also blocks DOMContentLoaded in the new tab, even after its HTML has arrived.
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  const dialogs = trackDialogs(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/architectures/${LARGE_ID}`);
  await page.getByRole("link", { name: "Open workbench", exact: true }).click();
  await page.getByLabel("Draft revision message").fill("Stay in the first tab");
  await page.getByRole("link", { name: "Architecture overview" }).click();

  const navigationEvents: Array<Record<string, unknown>> = [];
  const pendingRequests = new Set<string>();
  context.on("request", (request) => {
    pendingRequests.add(request.url());
    navigationEvents.push({ event: "request", type: request.resourceType(), url: request.url() });
  });
  context.on("response", (response) => {
    if (response.request().isNavigationRequest()) navigationEvents.push({ event: "response", url: response.url(), status: response.status(), contentType: response.headers()["content-type"] });
  });
  context.on("requestfinished", (request) => {
    pendingRequests.delete(request.url());
    if (request.isNavigationRequest()) navigationEvents.push({ event: "finished", url: request.url() });
  });
  context.on("requestfailed", (request) => {
    pendingRequests.delete(request.url());
    navigationEvents.push({ event: "failed", url: request.url(), failure: request.failure()?.errorText });
  });
  context.on("page", (tab) => {
    tab.on("framenavigated", (frame) => navigationEvents.push({ event: "navigated", url: frame.url() }));
    tab.on("domcontentloaded", () => navigationEvents.push({ event: "domcontentloaded", url: tab.url() }));
    tab.on("pageerror", (error) => navigationEvents.push({ event: "pageerror", error: error.message }));
    tab.on("close", () => navigationEvents.push({ event: "close", url: tab.url() }));
    tab.on("crash", () => navigationEvents.push({ event: "crash", url: tab.url() }));
  });
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("link", { name: "Resume draft", exact: true }).click({ modifiers: ["ControlOrMeta"] }),
  ]);
  // A background tab can still have its initial document when the page event fires.
  // Activate it and wait for the link destination, not that document's load event.
  await popup.bringToFront();
  const workbenchUrl = new RegExp(`/architectures/${LARGE_ID}/workbench\\?profile=personal&environment=personal-laptop$`);
  try {
    await popup.waitForURL(workbenchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (error) {
    console.error("Workbench popup navigation", JSON.stringify({
      node: process.version,
      browser: context.browser()?.version(),
      pages: context.pages().map((tab) => ({ url: tab.url(), closed: tab.isClosed() })),
      pendingRequests: [...pendingRequests].slice(-30),
      navigationEvents: navigationEvents.slice(-40),
    }));
    throw error;
  }
  await expect(popup).toHaveURL(workbenchUrl);
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
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: RESEARCH, node: "writing" });
  await expect.poll(() => state.previewRequests.at(-1)?.profileId).toBe("research");
  const personalRequests = state.previewRequests.filter((request) => request.profileId === "personal").length;

  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(new RegExp(`/architectures/${LARGE_ID}\\?profile=personal&environment=personal-laptop$`));
  await expect(page.getByLabel("Preview profile")).toHaveValue("personal");
  await expect(page.getByLabel("Preview environment")).toHaveValue("personal-laptop");
  await expect.poll(() => state.previewRequests.filter((request) => request.profileId === "personal").length).toBeGreaterThan(personalRequests);
  await expect(ui.tab(page, "Skills")).toContainText("75");
  await expect(ui.row(page, "engineering")).toBeVisible();
  await expect(page.getByRole("link", { name: "Resume draft", exact: true })).toBeVisible();

  await page.evaluate(() => history.forward());
  await expectArchitectureUrl(page, { id: LARGE_ID, surface: "workbench", context: RESEARCH, node: "writing" });
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

// Product-limit scenario: 500 nodes (61 routers, 439 skills) with a chain at
// the 12-level depth limit. Browsing must stay readable, count only skills,
// keep search context at full depth and never write a revision or layout.
test("the 500-node library opens collapsed, counts only skills, finds deep matches with their ancestors and keeps one selection across List and Map", async ({ page }, info) => {
  const state = await installWorkbenchMock(page.context());
  addScaleLibrary(state);
  const spec = scaleLibrarySpec(owner.id);
  expect(spec.nodes).toHaveLength(500);
  const scaleContext = { profile: SCALE_LIBRARY.profileId, environment: SCALE_LIBRARY.environmentId };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${SCALE_LIBRARY.id}`);
  await expect(page.getByRole("heading", { name: SCALE_LIBRARY.name, level: 2 })).toBeVisible();
  await expectArchitectureUrl(page, { id: SCALE_LIBRARY.id, context: scaleContext, node: null });

  // Only the root and its routers are shown, every branch collapsed.
  await expect(ui.explorer(page)).toContainText(ui.summary(SCALE_LIBRARY.routers, SCALE_LIBRARY.skills));
  await expect.poll(() => visibleNodeIds(page)).toEqual([SCALE_LIBRARY.rootId, ...SCALE_LIBRARY.rootChildIds].sort());
  await expect(ui.leafRows(page)).toHaveCount(0);
  for (const [index, id] of SCALE_LIBRARY.domainIds.entries()) {
    await expect(ui.toggle(page, "Expand", `Domain ${String(index + 1).padStart(2, "0")}`)).toHaveAttribute("aria-expanded", "false");
    // Four team routers hold 10-11 skills each; routers are never counted.
    await expect(ui.row(page, id)).toContainText(ui.skillCount(id === "domain-10" ? 42 : 44));
  }
  await expect(ui.toggle(page, "Expand", "Depth 02")).toHaveAttribute("aria-expanded", "false");
  await expect(ui.row(page, SCALE_LIBRARY.rootId)).toContainText(ui.skillCount(SCALE_LIBRARY.skills));
  await expect(ui.row(page, SCALE_LIBRARY.rootId)).not.toContainText(ui.skillCount(499));
  expect(await noHorizontalOverflow(page)).toBe(true);

  await ui.explorer(page).screenshot({ path: info.outputPath("scale-500-collapsed.png") });

  // Expand all shows exactly the server projection; Collapse all returns to browsing.
  await expandAllNodes(page);
  await expect.poll(() => visibleNodeIds(page)).toEqual(compiledNodeIds(spec, SCALE_LIBRARY.profileId, SCALE_LIBRARY.environmentId));
  await ui.collapseAll(page).click();
  await expect(ui.leafRows(page)).toHaveCount(0);
  expect(await ui.rows(page).count()).toBeLessThanOrEqual(SCALE_LIBRARY.rootChildIds.length + 1);

  // A match at the depth limit keeps all eleven ancestors and nothing else.
  await ui.search(page).fill(SCALE_LIBRARY.deepLeafLabel);
  await expect.poll(() => visibleNodeIds(page)).toEqual([SCALE_LIBRARY.rootId, ...SCALE_LIBRARY.chainIds, SCALE_LIBRARY.deepLeafId].sort());
  const deepSelect = ui.rowSelect(ui.row(page, SCALE_LIBRARY.deepLeafId));
  await deepSelect.click();
  await expect(deepSelect).toHaveAttribute("aria-current", "true");
  await expectArchitectureUrl(page, { id: SCALE_LIBRARY.id, context: scaleContext, node: SCALE_LIBRARY.deepLeafId });
  const inspector = ui.inspector(page);
  await expect(inspector).toContainText(SCALE_LIBRARY.deepLeafLabel);
  await expect(inspector).toContainText("Depth 11");
  await expect(inspector).toContainText(SCALE_LIBRARY.rootLabel);
  await expect(inspector).toContainText("1.0.0");
  await ui.search(page).fill("");
  await expect(inspector).toContainText(SCALE_LIBRARY.deepLeafLabel);
  await expectArchitectureUrl(page, { id: SCALE_LIBRARY.id, context: scaleContext, node: SCALE_LIBRARY.deepLeafId });

  // The map shares the selection; focusing a router's branch shows its
  // skills at a readable size and All branches returns to routers only.
  await ui.search(page).fill("Domain 03 team 2");
  const teamSelect = ui.rowSelect(ui.row(page, "domain-03-team-2"));
  await teamSelect.click();
  await expect(teamSelect).toHaveAttribute("aria-current", "true");
  await ui.search(page).fill("");
  await ui.view(page, "Map").click();
  await expect(ui.view(page, "Map")).toHaveAttribute("aria-pressed", "true");
  const map = ui.map(page);
  await expect(map).toBeVisible();
  await expectArchitectureUrl(page, { id: SCALE_LIBRARY.id, context: scaleContext, node: "domain-03-team-2", view: "map" });
  await expect(inspector).toContainText("Domain 03 team 2");
  const focusBranch = ui.focusBranch(page);
  if (await focusBranch.isVisible()) await focusBranch.click();
  await map.scrollIntoViewIfNeeded();
  const leafInMap = map.getByText("Domain 03 team 2 skill 01", { exact: true }).first();
  await expect(leafInMap).toBeVisible();
  await expect(leafInMap).toBeInViewport({ ratio: 0.9 });
  await expect(map.getByText("Domain 03 team 2", { exact: true }).first()).toBeInViewport({ ratio: 0.9 });
  expect(await effectiveFontSize(leafInMap)).toBeGreaterThanOrEqual(MIN_LEGIBLE_LABEL_PX);
  await ui.explorer(page).screenshot({ path: info.outputPath("scale-500-focused-map.png") });
  await ui.allBranches(page).click();
  await expect(map.getByText("Domain 03 team 2 skill 01", { exact: true })).toHaveCount(0);
  await expect(map.getByText("Domain 03 team 2", { exact: true }).first()).toBeVisible();
  await ui.view(page, "List").click();
  await expect(ui.view(page, "List")).toHaveAttribute("aria-pressed", "true");
  await expect(teamSelect).toHaveAttribute("aria-current", "true");
  await expectArchitectureUrl(page, { id: SCALE_LIBRARY.id, context: scaleContext, node: "domain-03-team-2", view: null });
  expect(await noHorizontalOverflow(page)).toBe(true);

  // Browsing never writes a revision, a layout or a draft preview.
  expect(state.revisionCreates).toEqual([]);
  expect(state.draftPreviewRequests).toEqual([]);
});

// The API returns `compiled.allNodes` to every preview reader, including an
// organization-only reader who never receives the revision spec. The browser
// must show only the compiled projection and request nothing more.
test("an organization-only reader sees only the safe projection: no hidden nodes, edit affordance, node widening or extra spec requests", async ({ page }) => {
  const state = await installWorkbenchMock(page.context());
  addOrganizationLibrary(state);
  const organization = { organization: ORGANIZATION_LIBRARY.organizationId };
  await page.setViewportSize({ width: 1440, height: 900 });
  // A hidden node id in the URL is neither selected nor kept.
  await page.goto(`/architectures/${ORGANIZATION_LIBRARY.id}?organization=${ORGANIZATION_LIBRARY.organizationId}&node=payroll-router`);
  await expect(page.getByRole("heading", { name: ORGANIZATION_LIBRARY.name, level: 2 })).toBeVisible();
  await expect(page.getByLabel("Preview organization")).toHaveValue(ORGANIZATION_LIBRARY.organizationId);
  await expect(ui.row(page, "shared-guidance")).toBeVisible();
  await expectArchitectureUrl(page, { id: ORGANIZATION_LIBRARY.id, context: organization, node: null });
  await expect(ui.explorer(page).locator("[aria-current=\"true\"]")).toHaveCount(0);

  // Every exposure option lists exactly the server's safe projection.
  const expected = [...ORGANIZATION_LIBRARY.exposedIds].sort();
  for (const choice of ["All nodes", "Exposed only"] as const) {
    await chooseExposure(page, choice);
    await expandAllNodes(page);
    await expect.poll(() => visibleNodeIds(page)).toEqual(expected);
  }
  const main = page.getByRole("main", { name: "Skill architectures" });
  for (const hidden of ORGANIZATION_LIBRARY.hiddenLabels) await expect(main).not.toContainText(hidden);
  await ui.search(page).fill("payroll");
  await expect(ui.noResults(page)).toBeVisible();
  await ui.clearSearch(page).click();

  // The map shows the same projection.
  await ui.view(page, "Map").click();
  await expect(ui.map(page)).toBeVisible();
  await expect(ui.map(page)).toContainText("Shared guidance");
  for (const hidden of ORGANIZATION_LIBRARY.hiddenLabels) await expect(ui.map(page)).not.toContainText(hidden);
  await ui.view(page, "List").click();

  // Readable nodes can be inspected; nothing offers editing or management.
  const skillSelect = ui.rowSelect(ui.row(page, "shared-01"));
  await skillSelect.click();
  await expect(skillSelect).toHaveAttribute("aria-current", "true");
  await expect(ui.inspector(page)).toContainText("Shared skill 01");
  await expect(ui.inspector(page)).toContainText("2.1.0");
  await expect(ui.editInWorkbench(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /workbench/i })).toHaveCount(0);
  await expect(ui.tab(page, "Sharing")).toHaveCount(0);
  await expect(ui.changePattern(page)).toHaveCount(0);
  await ui.tab(page, "Skills").click();
  await expect(ui.skillRows(page)).toHaveCount(2);
  await expect(ui.skillsPanel(page)).not.toContainText("Payroll export skill");

  // Only organization-scoped previews were requested: no revision spec,
  // draft preview or other architecture.
  expect(state.revisionRequests).toEqual([]);
  expect(state.draftPreviewRequests).toEqual([]);
  expect(new Set(state.detailRequests)).toEqual(new Set([ORGANIZATION_LIBRARY.id]));
  expect(state.previewRequests.length).toBeGreaterThan(0);
  for (const request of state.previewRequests) {
    expect(request).toMatchObject({ architectureId: ORGANIZATION_LIBRARY.id, organizationId: ORGANIZATION_LIBRARY.organizationId });
    expect(request.profileId).toBeUndefined();
    expect(request.environmentId).toBeUndefined();
    expect(request.revisionId).toBeUndefined();
  }
});

// A flat, multi-entry architecture has no routers or parent edges. This
// protects the independent browse/map contract and a named exposure edit
// through the real editor, revision request and saved preview.
test("a flat four-entry architecture keeps independent skills and names an exposure change through save", async ({ page }, info) => {
  const state = await installWorkbenchMock(page.context());
  const id = "arch-flat";
  const name = "Flat guidance library";
  const labels = ["Alpha guidance", "Beta guidance", "Gamma guidance", "Delta guidance"];
  const ids = ["flat-alpha", "flat-beta", "flat-gamma", "flat-delta"];
  const spec: ArchitectureSpecV1 = {
    schemaVersion: 1,
    id,
    name,
    pattern: { id: "flat", version: 1 },
    skills: ids.map((skillId, index) => ({ id: skillId, slug: `synthetic-${skillId}`, title: labels[index]!, version: "1.2.0", digest: hexDigest(400 + index), packageVisibility: "private" })),
    nodes: ids.map((nodeId, index) => ({ id: nodeId, kind: "leaf", label: labels[index]!, skillRefId: nodeId })),
    edges: [],
    entryNodeIds: ids,
    profiles: [{ id: "default", name: "Personal", subject: { type: "user", id: owner.id }, defaultExposure: "disabled", bindings: ids.map((nodeId, index) => ({ nodeId, enabled: index < 2, runtimeExposure: index < 2 ? "leaf" : "disabled" })) }],
    environments: [{ id: "flat-laptop", name: "Personal laptop", kind: "personal", profileId: "default" }],
  };
  const revisions = [revisionFor(id, 1, "Flat baseline", spec)];
  state.records.set(id, { summary: { ...summaryFor(id, name, "Four independent skills.", "owner", revisions), patternId: "flat" }, revisions });
  state.listOrder.unshift(id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/architectures/${id}`);
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  await expect.poll(() => visibleNodeIds(page)).toEqual([...ids].sort());
  await expect(ui.explorer(page)).toContainText("4 skills");
  await expect(ui.explorer(page).locator('li[data-node-kind="router"]')).toHaveCount(0);
  await ui.search(page).fill("Gamma guidance");
  await expect.poll(() => visibleNodeIds(page)).toEqual(["flat-gamma"]);
  await ui.search(page).fill("");
  await page.screenshot({ path: info.outputPath("flat-four-entry-list.png"), fullPage: true });
  await ui.view(page, "Map").click();
  const map = ui.map(page);
  await expect(map.locator(".react-flow__node")).toHaveCount(4);
  await expect(map.locator(".react-flow__edge")).toHaveCount(0);
  await ui.view(page, "List").click();
  await chooseExposure(page, "Exposed only");
  await expect.poll(() => visibleNodeIds(page)).toEqual(["flat-alpha", "flat-beta"]);
  await ui.rowSelect(ui.row(page, "flat-beta")).click();
  await expect(ui.inspector(page)).toContainText("1.2.0");
  await ui.editInWorkbench(page).click();
  await expect(page.getByLabel("Selected node label")).toHaveValue("Beta guidance");
  await page.getByRole("tab", { name: "Profiles & environments" }).click();
  await page.getByRole("checkbox", { name: "Enable Beta guidance in Personal", exact: true }).uncheck();
  const changes = ui.draftChanges(page);
  await expect(changes).toContainText("Exposure for “Beta guidance” in “Personal”: Leaf · all environments → Disabled");
  await expect(changes).toHaveAttribute("data-count", "1");
  await page.screenshot({ path: info.outputPath("flat-exposure-draft.png"), fullPage: true });
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByText("Revision 2 saved.", { exact: true })).toBeVisible();
  await expect(changes).toHaveAttribute("data-count", "0");
  expect(state.revisionCreates).toHaveLength(1);
  expect(state.revisionCreates[0]).toMatchObject({ architectureId: id, expectedCurrentRevisionId: `${id}-revision-1` });
  expect(state.records.get(id)!.revisions.at(-1)!.spec.profiles[0]!.bindings.find((binding) => binding.nodeId === "flat-beta")?.enabled).toBe(false);
  await page.getByRole("link", { name: "Architecture overview", exact: true }).click();
  await chooseExposure(page, "Exposed only");
  await expect.poll(() => visibleNodeIds(page)).toEqual(["flat-alpha"]);
  expect(await noHorizontalOverflow(page)).toBe(true);
});
