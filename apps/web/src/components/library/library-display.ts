import type { LibraryAttestation, LibraryBinding, LibraryCandidateState, LibraryEventKind, LibraryFinding, LibrarySourceHealth, LibrarySourceRef, LibraryTrackingMode, LibrarySummary, ReviewStatus, SecurityStatus } from "@myskills-app/core";

// Display vocabulary for Libraries. Raw enum strings never reach the page:
// known values use these maps and unknown values fall back to humanize().
export type Tone = "neutral" | "teal" | "amber" | "danger" | "coral";
export type TileTone = "teal" | "amber" | "navy";

const tileTones: TileTone[] = ["teal", "amber", "navy"];
export const tileTone = (key: string): TileTone => tileTones[[...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 3]!;

export const humanize = (value: string) => {
  const text = value.replaceAll(/[-_]+/g, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : "Unknown";
};

function lookup<K extends string>(map: Record<K, readonly [string, Tone]>, value: string | null | undefined): { label: string; tone: Tone } {
  const known = value ? (map as Record<string, readonly [string, Tone]>)[value] : undefined;
  return known ? { label: known[0], tone: known[1] } : { label: value ? humanize(value) : "Unknown", tone: "neutral" };
}

const health: Record<LibrarySourceHealth, readonly [string, Tone]> = {
  "not-tracked": ["Not tracked", "neutral"],
  healthy: ["Healthy", "teal"],
  checking: ["Checking", "neutral"],
  "rate-limited": ["Rate limited", "amber"],
  "access-lost": ["Access lost", "danger"],
  unavailable: ["Unavailable", "danger"],
  archived: ["Archived upstream", "amber"],
  "identity-change-review": ["Identity review needed", "amber"],
  paused: ["Paused", "neutral"],
};
export const healthLabel = (value: string | null | undefined) => lookup(health, value ?? "not-tracked");

const modes: Record<LibraryTrackingMode, readonly [string, Tone]> = {
  off: ["Checks off", "neutral"],
  manual: ["Manual checks", "neutral"],
  daily: ["Daily checks", "neutral"],
  weekly: ["Weekly checks", "neutral"],
};
export const trackingModeLabel = (value: string | null | undefined) => lookup(modes, value ?? "off");

const candidateStates: Record<LibraryCandidateState, readonly [string, Tone]> = {
  "ready-for-review": ["Preview ready to submit", "coral"],
  blocked: ["Blocked", "danger"],
  accepted: ["Imported", "teal"],
  ignored: ["Ignored", "neutral"],
  superseded: ["Superseded", "neutral"],
  expired: ["Expired", "neutral"],
};
export const candidateStateLabel = (value: string) => lookup(candidateStates, value);

const attestations: Record<LibraryAttestation, readonly [string, Tone]> = {
  "private-self-reviewed": ["Private self-review", "amber"],
  "instance-reviewed": ["Instance reviewed", "teal"],
};
export const attestationLabel = (value: string | null | undefined) => lookup(attestations, value);

const reviews: Record<ReviewStatus, readonly [string, Tone]> = {
  unreviewed: ["Awaiting review", "amber"],
  "changes-requested": ["Changes requested", "amber"],
  approved: ["Approved", "teal"],
  rejected: ["Rejected", "danger"],
};
export const reviewStatusLabel = (value: string) => lookup(reviews, value);

const scans: Record<SecurityStatus, readonly [string, Tone]> = {
  "not-run": ["Scan not run", "neutral"],
  passed: ["Scan passed", "teal"],
  warning: ["Scan warning", "amber"],
  failed: ["Scan failed", "danger"],
};
export const securityStatusLabel = (value: string) => lookup(scans, value);

const events: Record<LibraryEventKind, readonly [string, Tone]> = {
  "candidate-ready": ["Change to review", "coral"],
  "candidate-blocked": ["Change blocked", "danger"],
  "new-skill-discovered": ["New skill found", "neutral"],
  "skill-removed": ["Skill removed upstream", "amber"],
  "skill-renamed-suggested": ["Rename suggested", "neutral"],
  "source-health-changed": ["Source health changed", "amber"],
  "adoption-changed": ["Adopted version changed", "neutral"],
};
export const eventLabel = (value: string) => lookup(events, value);

const severities: Record<LibraryFinding["severity"], readonly [string, Tone]> = {
  blocking: ["Blocking", "danger"],
  warning: ["Warning", "amber"],
  info: ["Note", "neutral"],
};
export const severityLabel = (value: string) => lookup(severities, value);

const bindings: Record<LibraryBinding["status"], readonly [string, Tone]> = {
  active: ["Following this library", "teal"],
  "curation-unavailable": ["Curation unavailable", "amber"],
  detached: ["Detached", "neutral"],
};
export const bindingStatusLabel = (value: string) => lookup(bindings, value);

const roles: Record<LibrarySummary["access"]["role"], string> = { owner: "Owner", curator: "Curator", member: "Member" };
export const roleLabel = (value: string) => (roles as Record<string, string>)[value] ?? humanize(value);

export function refLabel(ref: LibrarySourceRef | null | undefined): string {
  if (!ref) return "Ref from URL";
  const value = ref.value?.trim();
  switch (ref.kind) {
    case "default-branch": return "Default branch";
    case "latest-release": return "Latest stable release";
    case "branch": return value ? `Branch ${value}` : "Named branch";
    case "tag": return value ? `Tag ${value}` : "Exact tag";
    case "tag-prefix": return value ? `Tags starting ${value}` : "Release tag prefix";
    case "commit": return value ? `Commit ${value.slice(0, 12)}` : "Exact commit";
    default: return humanize(String(ref.kind));
  }
}

export const shortDate = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export const dateTime = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};

export const repositoryLabel =(url: string | null | undefined) => url?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "";

export const platformLabel = (name: string) => ({ codex: "Codex", "claude-code": "Claude Code" } as Record<string, string>)[name] ?? name;
