import type { SkillLifecycleStatus, SkillReleaseChangeKind, VisibilityScope } from "@myskills-app/core";
import type { ReviewActionName } from "../../api.js";
import { humanize, type Tone } from "../library/library-display.js";

// Display vocabulary for Submit, Review and Manage. Review, scan and severity
// wording is shared with Libraries; unknown values fall back to humanize().
export { humanize, reviewStatusLabel, securityStatusLabel, severityLabel, shortDate, tileTone } from "../library/library-display.js";
export type { Tone } from "../library/library-display.js";

type Label = { label: string; tone: Tone };

function lookup(map: Record<string, readonly [string, Tone]>, value: string | null | undefined): Label {
  const known = value ? map[value] : undefined;
  return known ? { label: known[0], tone: known[1] } : { label: value ? humanize(value) : "Unknown", tone: "neutral" };
}

const lifecycles: Record<SkillLifecycleStatus, readonly [string, Tone]> = {
  draft: ["Draft", "neutral"],
  private: ["Private", "neutral"],
  submitted: ["Submitted", "neutral"],
  review: ["In review", "neutral"],
  approved: ["Approved", "teal"],
  deprecated: ["Deprecated", "amber"],
  unpublished: ["Unpublished", "amber"],
  revoked: ["Revoked", "danger"],
  archived: ["Archived", "amber"],
};
export const lifecycleLabel = (value: string) => lookup(lifecycles, value);

// Matches the Sharing panel's scope names.
const visibilities: Record<VisibilityScope, readonly [string, Tone]> = {
  public: ["Public", "neutral"],
  authenticated: ["Signed-in users", "neutral"],
  organization: ["Organizations", "neutral"],
  private: ["Private", "neutral"],
  team: ["Teams", "neutral"],
  "explicit-users": ["Individual users", "neutral"],
};
export const visibilityLabel = (value: string) => lookup(visibilities, value).label;

const reviewEvents: Record<ReviewActionName, readonly [string, Tone]> = {
  approve: ["Approved", "teal"],
  "request-changes": ["Changes requested", "amber"],
  reject: ["Rejected", "danger"],
  publish: ["Published", "teal"],
};
export const reviewEventLabel = (value: string) => lookup(reviewEvents, value).label;

const changeKinds: Record<SkillReleaseChangeKind, readonly [string, Tone]> = {
  fix: ["Fix", "neutral"],
  feature: ["Feature", "neutral"],
  breaking: ["Breaking change", "amber"],
  security: ["Security fix", "amber"],
  maintenance: ["Maintenance", "neutral"],
};
export const changeKindLabel = (value: string) => lookup(changeKinds, value).label;

export const findingsLabel = (count: number): Label => ({
  label: count === 0 ? "No findings" : count === 1 ? "1 finding" : `${count} findings`,
  tone: count === 0 ? "neutral" : "amber",
});

/** registry-chip tone attribute; neutral chips carry none. */
export const chipTone = (tone: Tone) => (tone === "neutral" ? undefined : tone);

/** Display only: keep the stored version for requests, pins and confirmations. */
export function isBootstrapVersion(version: string): boolean {
  return /^0\.0\.0-bootstrap\.[0-9a-f]+$/.test(version);
}

export function releaseVersionLabel(version: string, releases: readonly { version: string }[] = []): string {
  if (!isBootstrapVersion(version)) return version;
  // Use the full import suffix when more than one import is selectable.
  // Truncating again can make distinct imports look identical.
  return releases.filter((release) => isBootstrapVersion(release.version)).length > 1
    ? `Initial import · ${version.slice("0.0.0-bootstrap.".length)}`
    : "Initial import";
}
