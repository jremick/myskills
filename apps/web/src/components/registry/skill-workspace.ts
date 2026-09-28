import type { SkillReleaseSummary } from "../../api.js";

/** All skills reads the catalog; Can manage reads the authorised management inventory. */
export type SkillScope = "all" | "manage";
/** Detail sections. Overview is the default and is omitted from URLs. */
export type SkillTab = "overview" | "versions" | "manage";

export function sectionTabId(baseId: string, tab: SkillTab): string {
  return `${baseId}-tab-${tab}`;
}

export function sectionPanelId(baseId: string): string {
  return `${baseId}-panel`;
}

export function parseSkillScope(value: string | null): SkillScope {
  return value === "manage" ? "manage" : "all";
}

export function parseSkillTab(value: string | null): SkillTab {
  return value === "versions" || value === "manage" ? value : "overview";
}

/**
 * Libraries links carry their own location so a reader can return to the same
 * library, entry and candidate. Only a same-origin /libraries path is accepted;
 * anything else would be an open redirect.
 */
export function safeLibraryReturn(value: string | null, origin: string): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== "/libraries") return null;
  return `${url.pathname}${url.search}`;
}

export function isPublishedRelease(release: Pick<SkillReleaseSummary, "lifecycleStatus" | "reviewStatus" | "securityStatus" | "publishedAt">): boolean {
  return (release.lifecycleStatus === "approved" || release.lifecycleStatus === "deprecated")
    && release.reviewStatus === "approved"
    && release.securityStatus === "passed"
    && typeof release.publishedAt === "string"
    && Number.isFinite(Date.parse(release.publishedAt));
}
