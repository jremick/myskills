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
 */
export type ArchitectureSurface = "overview" | "workbench";

export interface ArchitectureContextParams {
  profile?: string;
  environment?: string;
  organization?: string;
}

export interface ArchitectureRoute {
  architectureId: string | null;
  surface: ArchitectureSurface;
  context: ArchitectureContextParams;
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
  return {
    architectureId,
    surface: architectureId !== null && segments.length === 2 ? "workbench" : "overview",
    context: parseContext(search),
  };
}

export function isArchitecturePath(pathname: string): boolean {
  return parseArchitectureRoute(pathname) !== null;
}

export function architectureUrl(architectureId: string | null, surface: ArchitectureSurface, context: ArchitectureContextParams = {}): string {
  if (architectureId === null) return SECTION_PATH;
  const params = new URLSearchParams();
  if (context.profile) params.set("profile", context.profile);
  if (context.environment) params.set("environment", context.environment);
  if (context.organization) params.set("organization", context.organization);
  const query = params.toString();
  return `${SECTION_PATH}/${encodeURIComponent(architectureId)}${surface === "workbench" ? "/workbench" : ""}${query ? `?${query}` : ""}`;
}

export function architectureContextKey(context: ArchitectureContextParams): string {
  return [context.profile ?? "", context.environment ?? "", context.organization ?? ""].join("\u0000");
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
