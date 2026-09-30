import { expect, type Locator, type Page } from "@playwright/test";
import type { ArchitectureSpecV1 } from "@myskills-app/core";

/**
 * Shared browser contract for the Architecture Structure explorer, used by
 * both mocked architecture specs. Selectors follow the approved DOM contract
 * (roles and names first, `data-node-*` rows, explorer test ids) so a label
 * change is adjusted here once.
 */

type SectionTab = "Structure" | "Skills" | "History" | "Sharing";
type ExposureChoice = "All nodes" | "Exposed only";

/**
 * Smallest effective label size, in CSS pixels, accepted in the map. Fitting
 * a whole large tree into the canvas yields labels of about 1-4 px; a fit
 * that stops at a readable zoom stays above this floor.
 */
export const MIN_LEGIBLE_LABEL_PX = 9;

// Hidden copies (for example the Workbench draft preview while the overview
// is shown) are excluded.
const explorerOf = (page: Page): Locator => page.getByTestId("architecture-explorer").filter({ visible: true });
const inspectorOf = (page: Page): Locator => page.getByTestId("architecture-inspector").filter({ visible: true });
const tabPanelOf = (page: Page, name: SectionTab): Locator => page.getByRole("tabpanel", { name: new RegExp(`^${name}`) });

export const architectureUi = {
  tab: (page: Page, name: SectionTab): Locator => page.getByRole("tablist", { name: "Architecture sections" }).getByRole("tab", { name: new RegExp(`^${name}`) }),
  tabPanel: tabPanelOf,
  changePattern: (page: Page): Locator => page.getByRole("button", { name: "Change pattern" }),

  // Structure explorer.
  explorer: explorerOf,
  row: (page: Page, nodeId: string): Locator => explorerOf(page).locator(`li[data-node-id="${nodeId}"]`),
  rows: (page: Page): Locator => explorerOf(page).locator("li[data-node-id]").filter({ visible: true }),
  leafRows: (page: Page): Locator => explorerOf(page).locator('li[data-node-kind="leaf"]').filter({ visible: true }),
  /** A row's own select button: its first button that is not a branch toggle. */
  rowSelect: (row: Locator): Locator => row.locator("button:not([aria-expanded])").first(),
  toggle: (page: Page, action: "Expand" | "Collapse", label: string): Locator => explorerOf(page).getByRole("button", { name: `${action} ${label}`, exact: true }),
  expandAll: (page: Page): Locator => explorerOf(page).getByRole("button", { name: "Expand all", exact: true }),
  collapseAll: (page: Page): Locator => explorerOf(page).getByRole("button", { name: "Collapse all", exact: true }),
  search: (page: Page): Locator => explorerOf(page).getByRole("searchbox", { name: "Search structure" }),
  /** Offered in the no-results state; with matches, the reader edits the search box. */
  clearSearch: (page: Page): Locator => explorerOf(page).getByRole("button", { name: "Clear search" }).first(),
  noResults: (page: Page): Locator => explorerOf(page).getByText(/No nodes match/),
  summary: (routers: number, skills: number): string => `${routers} routers · ${skills} skills`,
  skillCount: (skills: number): string => `${skills} skills`,
  view: (page: Page, name: "List" | "Map"): Locator => explorerOf(page).getByRole("group", { name: "Structure view" }).getByRole("button", { name, exact: true }),
  map: (page: Page): Locator => page.getByTestId("architecture-explorer-map").filter({ visible: true }),
  allBranches: (page: Page): Locator => explorerOf(page).getByRole("button", { name: "All branches" }),
  inspector: inspectorOf,
  focusBranch: (page: Page): Locator => inspectorOf(page).getByRole("button", { name: "Focus branch" }),
  editInWorkbench: (page: Page): Locator => inspectorOf(page).getByRole("link", { name: "Edit in Workbench" })
    .or(inspectorOf(page).getByRole("button", { name: "Edit in Workbench" })),
  closeDetails: (page: Page): Locator => page.getByRole("button", { name: "Close details" }),

  // Skills tab.
  skillsPanel: (page: Page): Locator => tabPanelOf(page, "Skills"),
  skillsSearch: (page: Page): Locator => tabPanelOf(page, "Skills").getByRole("searchbox", { name: "Search skills" }),
  skillsExposure: (page: Page): Locator => tabPanelOf(page, "Skills").getByLabel("Exposure"),
  skillsTable: (page: Page): Locator => tabPanelOf(page, "Skills").getByRole("table"),
  skillRows: (page: Page): Locator => tabPanelOf(page, "Skills").locator("tbody tr"),
  skillsExposureOption: { all: "All exposures", leaf: "Direct leaf", router: "Router only" },
  readableLeafExposure: "Direct leaf",

  // Workbench named changes.
  draftChanges: (page: Page): Locator => page.getByTestId("architecture-draft-changes").filter({ visible: true }),
};

const quoted = (value: string) => `“${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}”`;

/** Readable change summaries shown in the Workbench before saving. */
export const draftChange = {
  renamed: (before: string, after: string) => new RegExp(`Renamed ${quoted(before)} → ${quoted(after)}`),
  added: (kind: "router" | "skill", label: string, parent: string) => new RegExp(`Added ${kind} ${quoted(label)} under ${quoted(parent)}`),
  removed: (kind: "router" | "skill", label: string) => new RegExp(`Removed ${kind} ${quoted(label)}`),
  moved: (label: string, from: string, to: string) => new RegExp(`Moved ${quoted(label)} from ${quoted(from)} to ${quoted(to)}`),
};

/** Lists every change when the panel collapses a long list to one line. */
export async function showAllDraftChanges(page: Page): Promise<void> {
  const toggle = architectureUi.draftChanges(page).getByRole("button", { name: /^Show all/ });
  if (await toggle.count() > 0) await toggle.click();
}

/** Expands every branch of a rendered list; a tree without routers has no control. */
export async function expandAllNodes(page: Page): Promise<void> {
  await expect(architectureUi.rows(page).first()).toBeVisible();
  const button = architectureUi.expandAll(page);
  if (await button.count() > 0 && await button.isEnabled()) await button.click();
}

/** Sorted ids of the explorer rows currently shown. */
export async function visibleNodeIds(page: Page): Promise<string[]> {
  const ids = await architectureUi.rows(page).evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.nodeId ?? ""));
  return ids.sort();
}

/**
 * Chooses an exposure filter option. The filter may be absent when the
 * reader's projection has only exposed nodes; the caller then keeps asserting
 * the projection it already sees.
 */
export async function chooseExposure(page: Page, choice: ExposureChoice): Promise<boolean> {
  const explorer = architectureUi.explorer(page);
  await expect(explorer).toBeVisible();
  const option = explorer.getByRole("button", { name: choice, exact: true }).or(explorer.getByRole("radio", { name: choice, exact: true }));
  if (await option.count() > 0) {
    await option.first().click();
    return true;
  }
  const select = explorer.getByRole("combobox").filter({ has: page.getByRole("option", { name: choice, exact: true }) });
  if (await select.count() > 0) {
    await select.first().selectOption({ label: choice });
    return true;
  }
  return false;
}

/** Rendered label size after the map's zoom transform. */
export async function effectiveFontSize(label: Locator): Promise<number> {
  return label.evaluate((element) => {
    const html = element as HTMLElement;
    const scale = html.offsetWidth > 0 ? html.getBoundingClientRect().width / html.offsetWidth : 1;
    return Number.parseFloat(getComputedStyle(html).fontSize) * scale;
  });
}

/**
 * Compares the architecture URL. Context parameters must match exactly; the
 * optional `node` and `view` parameters are compared only when given, where
 * `null` means absent.
 */
export async function expectArchitectureUrl(page: Page, expected: {
  id: string;
  surface?: "overview" | "workbench";
  context?: Record<string, string>;
  node?: string | null;
  view?: "map" | null;
}): Promise<void> {
  await expect.poll(() => {
    const url = new URL(page.url());
    const { node, view, ...context } = Object.fromEntries(url.searchParams);
    return {
      path: url.pathname,
      context,
      ...(expected.node !== undefined ? { node: node ?? null } : {}),
      ...(expected.view !== undefined ? { view: view ?? null } : {}),
    };
  }).toEqual({
    path: `/architectures/${expected.id}${expected.surface === "workbench" ? "/workbench" : ""}`,
    context: expected.context ?? {},
    ...(expected.node !== undefined ? { node: expected.node } : {}),
    ...(expected.view !== undefined ? { view: expected.view } : {}),
  });
}

export async function noDocumentOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function fixtureDigest(index: number): string {
  return (index + 1).toString(16).padStart(4, "0").repeat(16);
}

type SpecNode = ArchitectureSpecV1["nodes"][number];

/**
 * Product-limit fixture: exactly 500 nodes (61 routers, 439 skills). Ten
 * domains each hold four team routers of 10-11 skills, and one chain reaches
 * the 12-level topology limit.
 */
export const SCALE_LIBRARY = (() => {
  const domainIds = Array.from({ length: 10 }, (_, index) => `domain-${pad(index + 1)}`);
  const chainIds = Array.from({ length: 10 }, (_, index) => `depth-${pad(index + 2)}`);
  return {
    id: "arch-scale",
    name: "Synthetic scale library",
    description: "Synthetic library at the 500-node product limit.",
    routers: 61,
    skills: 439,
    rootId: "scale-root",
    rootLabel: "Scale root",
    domainIds,
    chainIds,
    rootChildIds: [...domainIds, chainIds[0]!],
    deepLeafId: "deepest-skill",
    deepLeafLabel: "Deepest skill",
    profileId: "personal",
    environmentId: "scale-laptop",
  };
})();

export function scaleLibrarySpec(ownerId: string): ArchitectureSpecV1 {
  const skills: ArchitectureSpecV1["skills"] = [];
  const nodes: ArchitectureSpecV1["nodes"] = [{ id: SCALE_LIBRARY.rootId, kind: "router", label: SCALE_LIBRARY.rootLabel }];
  const edges: ArchitectureSpecV1["edges"] = [];
  const addLeaf = (id: string, label: string, parent: string) => {
    skills.push({ id, slug: `scale-${id}`, title: label, version: "1.0.0", digest: fixtureDigest(500 + skills.length), packageVisibility: "private" });
    nodes.push({ id, kind: "leaf", label, skillRefId: id });
    edges.push({ from: parent, to: id, kind: "routes" });
  };
  let team = 0;
  for (const [domainIndex, domainId] of SCALE_LIBRARY.domainIds.entries()) {
    const domainLabel = `Domain ${pad(domainIndex + 1)}`;
    nodes.push({ id: domainId, kind: "router", label: domainLabel });
    edges.push({ from: SCALE_LIBRARY.rootId, to: domainId, kind: "contains" });
    for (let teamIndex = 1; teamIndex <= 4; teamIndex += 1) {
      team += 1;
      const teamId = `${domainId}-team-${teamIndex}`;
      const teamLabel = `${domainLabel} team ${teamIndex}`;
      nodes.push({ id: teamId, kind: "router", label: teamLabel });
      edges.push({ from: domainId, to: teamId, kind: "contains" });
      const leaves = team <= 38 ? 11 : 10;
      for (let leaf = 1; leaf <= leaves; leaf += 1) addLeaf(`${teamId}-${pad(leaf)}`, `${teamLabel} skill ${pad(leaf)}`, teamId);
    }
  }
  let parent = SCALE_LIBRARY.rootId;
  for (const [index, id] of SCALE_LIBRARY.chainIds.entries()) {
    nodes.push({ id, kind: "router", label: `Depth ${pad(index + 2)}` });
    edges.push({ from: parent, to: id, kind: "contains" });
    parent = id;
  }
  addLeaf(SCALE_LIBRARY.deepLeafId, SCALE_LIBRARY.deepLeafLabel, parent);
  const binding = (node: SpecNode) => ({ nodeId: node.id, enabled: true, runtimeExposure: node.kind === "router" ? "router" as const : "leaf" as const });
  return {
    schemaVersion: 1,
    id: SCALE_LIBRARY.id,
    name: SCALE_LIBRARY.name,
    pattern: { id: "multi-level-router", version: 1 },
    skills,
    nodes,
    edges,
    entryNodeIds: [SCALE_LIBRARY.rootId],
    profiles: [{ id: SCALE_LIBRARY.profileId, name: "Personal", subject: { type: "user", id: ownerId }, defaultExposure: "disabled", bindings: nodes.map(binding) }],
    environments: [{ id: SCALE_LIBRARY.environmentId, name: "Scale laptop", kind: "personal", profileId: SCALE_LIBRARY.profileId }],
  };
}

/**
 * Organization-only reader fixture. Its single profile exposes four nodes;
 * the API still returns the other two in `compiled.allNodes`, as it does for
 * every preview reader.
 */
export const ORGANIZATION_LIBRARY = {
  id: "arch-org",
  name: "Organization shared library",
  description: "Shared with one organization through a safe projection.",
  publisherId: "user-publisher",
  organizationId: "org-alpha",
  exposedIds: ["org-root", "shared-01", "shared-02", "shared-guidance"],
  hiddenIds: ["payroll-export", "payroll-router"],
  hiddenLabels: ["Confidential payroll", "Payroll export skill"],
};

export function organizationLibrarySpec(): ArchitectureSpecV1 {
  const skills: ArchitectureSpecV1["skills"] = [
    { id: "shared-01", slug: "org-shared-01", title: "Shared skill 01", version: "2.1.0", digest: fixtureDigest(300), packageVisibility: "organization" },
    { id: "shared-02", slug: "org-shared-02", title: "Shared skill 02", version: "2.1.0", digest: fixtureDigest(301), packageVisibility: "organization" },
    { id: "payroll-export", slug: "org-payroll-export", title: "Payroll export skill", version: "1.0.0", digest: fixtureDigest(302), packageVisibility: "private" },
  ];
  const nodes: ArchitectureSpecV1["nodes"] = [
    { id: "org-root", kind: "router", label: "Shared root" },
    { id: "shared-guidance", kind: "router", label: "Shared guidance" },
    { id: "shared-01", kind: "leaf", label: "Shared skill 01", skillRefId: "shared-01" },
    { id: "shared-02", kind: "leaf", label: "Shared skill 02", skillRefId: "shared-02" },
    { id: "payroll-router", kind: "router", label: "Confidential payroll" },
    { id: "payroll-export", kind: "leaf", label: "Payroll export skill", skillRefId: "payroll-export" },
  ];
  const exposed = new Set(ORGANIZATION_LIBRARY.exposedIds);
  return {
    schemaVersion: 1,
    id: ORGANIZATION_LIBRARY.id,
    name: ORGANIZATION_LIBRARY.name,
    pattern: { id: "multi-level-router", version: 1 },
    skills,
    nodes,
    edges: [
      { from: "org-root", to: "shared-guidance", kind: "contains" },
      { from: "shared-guidance", to: "shared-01", kind: "routes" },
      { from: "shared-guidance", to: "shared-02", kind: "routes" },
      { from: "org-root", to: "payroll-router", kind: "contains" },
      { from: "payroll-router", to: "payroll-export", kind: "routes" },
    ],
    entryNodeIds: ["org-root"],
    profiles: [{
      id: "org-shared",
      name: "Organization shared",
      subject: { type: "user", id: ORGANIZATION_LIBRARY.publisherId },
      defaultExposure: "disabled",
      bindings: nodes.map((node) => exposed.has(node.id)
        ? { nodeId: node.id, enabled: true, runtimeExposure: node.kind === "router" ? "router" as const : "leaf" as const }
        : { nodeId: node.id, enabled: false, runtimeExposure: "disabled" as const }),
    }],
    environments: [{ id: "org-env", name: "Organization workspace", kind: "work", profileId: "org-shared" }],
  };
}
