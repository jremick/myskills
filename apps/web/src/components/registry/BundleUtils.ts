import type { MouseEvent } from "react";
import type { BundleSummary, BundleVisibility } from "@myskills-app/core";

export type Selection = { kind: "skill"; slug: string } | { kind: "bundle"; id: string } | null;

const TONES = ["teal", "amber", "navy"] as const;

/** Identity colour for a slug or id. Decorative only; never carries meaning. */
export function tileTone(key: string): (typeof TONES)[number] {
  return TONES[[...key].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 7) % 3];
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export const VISIBILITY_LABELS: Record<BundleVisibility, string> = {
  public: "Public",
  authenticated: "Signed-in users",
  team: "Team",
  private: "Only the owner",
};

export const countLabel = (bundle: BundleSummary) => `${plural(bundle.memberCount, "skill")}${bundle.partial ? " shown" : ""}`;

export const PARTIAL_NOTICE = "Some skills in this bundle aren’t available to your account, so they aren’t listed.";

/** Headings the workspace moves focus to when detail opens. */
export const DETAIL_HEADING = "data-detail-heading";

export const bundleKey = (id: string) => `b:${id}`;

export const revealsMembers = (bundle: BundleSummary, query: string) => Boolean(query) && (bundle.match === "members" || bundle.match === "all");

/** Plain left clicks stay in the app; modified clicks keep native link behaviour. */
export function inAppClick(event: MouseEvent<HTMLAnchorElement>, open: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  open();
}

export function domId(...parts: string[]) {
  return parts.join("-").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function errorStatus(error: unknown): number | null {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : null;
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

const BUNDLE_MESSAGES: Record<string, string> = {
  BUNDLE_REVISION_CONFLICT: "This bundle changed since you opened it.",
  BUNDLE_NOT_FOUND: "This bundle doesn’t exist or you no longer have access to it.",
  BUNDLE_AUDIENCE_DISABLED: "This audience is disabled in the registry. Choose another audience.",
  BUNDLE_MEMBER_NOT_AUTHORIZED: "One or more selected skills are unavailable to this audience. Review the members and audience.",
  BUNDLE_SOURCE_SELECTION_INVALID: "Choose an available source and skills from its reviewed imports.",
  BUNDLE_SOURCE_DUPLICATE: "This source already has a bundle. Open that bundle to review its members.",
  BUNDLE_IDENTITY_IMMUTABLE: "A bundle’s kind, owner and source cannot change. Keep those values or create a new bundle.",
  BUNDLE_LIMIT_EXCEEDED: "You have reached the bundle limit for this owner.",
  SUBMISSION_ROLE_REQUIRED: "An author role is required to create or edit bundles.",
  TEAM_OWNER_REQUIRED: "Only a current team owner can change this bundle or team library.",
  LIBRARY_LIMIT_EXCEEDED: "This library has reached its entry limit. Choose another library.",
  LIBRARY_NOT_FOUND: "This library is unavailable or you no longer have access.",
  LIBRARY_ENTRY_DUPLICATE: "This bundle is already saved in that library.",
  API_TOKEN_SCOPE_REQUIRED: "This session needs permission to change libraries and bundles.",
  MFA_VERIFICATION_REQUIRED: "Verify MFA in your account before continuing.",
  CATALOG_CHANGED: "The catalog changed while you were browsing.",
  INVALID_PAGE_CURSOR: "The catalog changed while you were browsing.",
};

export function bundleError(error: unknown, fallback: string): string {
  const message = BUNDLE_MESSAGES[errorCode(error)];
  if (message) return message;
  const status = errorStatus(error);
  if (status === 401 || status === 403) return "You don’t have access to do that.";
  return fallback;
}

export function isCatalogChanged(error: unknown) {
  const code = errorCode(error);
  return code === "CATALOG_CHANGED" || code === "INVALID_PAGE_CURSOR" || errorStatus(error) === 409;
}

/**
 * Why a page request failed. "access" and "changed" mean anything already
 * loaded may no longer be visible to this reader, so callers must drop it.
 */
export function failureKind(error: unknown): "access" | "changed" | "failed" {
  const status = errorStatus(error);
  if (status === 401 || status === 403 || status === 404) return "access";
  if (isCatalogChanged(error)) return "changed";
  return "failed";
}
