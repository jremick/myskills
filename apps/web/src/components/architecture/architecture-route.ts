/**
 * URL contract for the architecture section.
 *
 *   /architectures                     overview; keeps the current or first architecture
 *   /architectures/:id                 overview of one architecture
 *   /architectures/:id/workbench       full-page Workbench
 *
 * `profile`, `environment` and `organization` query parameters request a
 * preview context. They are requests only: the dashboard validates them
 * against the architecture before use and never widens access from them.
 *
 * `node` requests a selected node and `view=map` the Structure map. Both are
 * presentation requests: the dashboard keeps a node only when the loaded,
 * authorized projection contains it, and neither triggers another request.
 */
export type ArchitectureSurface = "overview" | "workbench";

export interface ArchitectureContextParams {
  profile?: string;
  environment?: string;
  organization?: string;
}

export interface ArchitectureSelectionParams {
  node?: string;
  /** Overview only; the list is the default and is never written. */
  view?: "map";
}

export interface ArchitectureRoute {
  architectureId: string | null;
  surface: ArchitectureSurface;
  context: ArchitectureContextParams;
  selection: ArchitectureSelectionParams;
}

const SECTION_PATH = "/architectures";
const MAX_SEGMENT_LENGTH = 200;
// Decoded IDs are bounded and cannot smuggle path, query or control characters.
const SEGMENT_PATTERN = /^[^\s/\\?#\u0000-\u001f\u007f]+$/u;

export function parseArchitectureRoute(pathname: string, search = ""): ArchitectureRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path !== SECTION_PATH && !path.startsWith(`${SECTION_PATH}/`)) return null;
  const segments = path === SECTION_PATH ? [] : path.slice(SECTION_PATH.length + 1).split("/");
  if (segments.length > 2 || (segments.length === 2 && segments[1] !== "workbench")) return null;
  let architectureId: string | null = null;
  if (segments.length > 0) {
    const decoded = decodeSegment(segments[0] ?? "");
    if (decoded === null) return null;
    architectureId = decoded;
  }
  const surface: ArchitectureSurface = architectureId !== null && segments.length === 2 ? "workbench" : "overview";
  return {
    architectureId,
    surface,
    context: parseContext(search),
    selection: architectureId === null ? {} : parseSelection(search, surface),
  };
}

export function isArchitecturePath(pathname: string): boolean {
  return parseArchitectureRoute(pathname) !== null;
}

export function architectureUrl(
  architectureId: string | null,
  surface: ArchitectureSurface,
  context: ArchitectureContextParams = {},
  selection: ArchitectureSelectionParams = {},
): string {
  if (architectureId === null) return SECTION_PATH;
  const params = new URLSearchParams();
  if (context.profile) params.set("profile", context.profile);
  if (context.environment) params.set("environment", context.environment);
  if (context.organization) params.set("organization", context.organization);
  if (selection.node && isBoundedValue(selection.node)) params.set("node", selection.node);
  if (surface === "overview" && selection.view === "map") params.set("view", "map");
  const query = params.toString();
  return `${SECTION_PATH}/${encodeURIComponent(architectureId)}${surface === "workbench" ? "/workbench" : ""}${query ? `?${query}` : ""}`;
}

export function architectureContextKey(context: ArchitectureContextParams): string {
  return [context.profile ?? "", context.environment ?? "", context.organization ?? ""].join("\u0000");
}

export function architectureSelectionKey(selection: ArchitectureSelectionParams): string {
  return [selection.node ?? "", selection.view ?? ""].join("\u0000");
}

/** The selection exactly as architectureUrl writes it and parseArchitectureRoute reads it back. */
export function normalizeArchitectureSelection(selection: ArchitectureSelectionParams, surface: ArchitectureSurface): ArchitectureSelectionParams {
  return {
    ...(selection.node && isBoundedValue(selection.node) ? { node: selection.node } : {}),
    ...(surface === "overview" && selection.view === "map" ? { view: "map" as const } : {}),
  };
}

export function hasRequestedContext(context: ArchitectureContextParams): boolean {
  return Boolean(context.profile || context.environment || context.organization);
}

function decodeSegment(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return decoded.length > 0 && decoded.length <= MAX_SEGMENT_LENGTH && SEGMENT_PATTERN.test(decoded) ? decoded : null;
}

function parseContext(search: string): ArchitectureContextParams {
  const params = new URLSearchParams(search);
  const context: ArchitectureContextParams = {};
  for (const key of ["profile", "environment", "organization"] as const) {
    const value = params.get(key)?.trim();
    if (value && value.length <= MAX_SEGMENT_LENGTH) context[key] = value;
  }
  return context;
}

function parseSelection(search: string, surface: ArchitectureSurface): ArchitectureSelectionParams {
  const params = new URLSearchParams(search);
  const selection: ArchitectureSelectionParams = {};
  const node = params.get("node")?.trim();
  if (node && isBoundedValue(node)) selection.node = node;
  if (surface === "overview" && params.get("view") === "map") selection.view = "map";
  return selection;
}

function isBoundedValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SEGMENT_LENGTH && SEGMENT_PATTERN.test(value);
}
