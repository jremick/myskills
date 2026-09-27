import type { ArchitectureTargetOwnerReference } from "@myskills-app/core";
import { chipTone, humanize, type Tone } from "../registry/status-display.js";

// Display vocabulary for Connected targets, Architectures and Updates. Raw
// tokens never reach the page: known values use these maps and unknown values
// fall back to humanize(). Fixtures already send tokens outside the core lists.
export { changeKindLabel, chipTone, humanize } from "../registry/status-display.js";
export type { Tone } from "../registry/status-display.js";

type Label = { label: string; tone: Tone };

function lookup(map: Record<string, readonly [string, Tone]>, value: string | null | undefined, fallback = "Unknown"): Label {
  const known = value && Object.hasOwn(map, value) ? map[value] : undefined;
  return known ? { label: known[0], tone: known[1] } : { label: value ? humanize(value) : fallback, tone: "neutral" };
}

/** Attributes for a .cp-chip; neutral chips carry no tone. */
export const toneOf = (label: Label) => chipTone(label.tone);

const targetStatuses: Record<string, readonly [string, Tone]> = {
  connected: ["Connected", "teal"],
  degraded: ["Degraded", "amber"],
  revoked: ["Revoked", "danger"],
};
export const targetStatusLabel = (value: string) => lookup(targetStatuses, value);

const consents: Record<string, readonly [string, Tone]> = {
  pending: ["Consent pending", "amber"],
  granted: ["Consent granted", "teal"],
  denied: ["Consent denied", "amber"],
  revoked: ["Consent revoked", "danger"],
};
export const consentLabel = (value: string) => {
  const known = lookup(consents, value);
  return Object.hasOwn(consents, value) ? known : { label: `Consent ${known.label.toLowerCase()}`, tone: known.tone };
};

const healths: Record<string, readonly [string, Tone]> = {
  healthy: ["Healthy", "teal"],
  degraded: ["Degraded", "amber"],
  unavailable: ["Unavailable", "danger"],
};
export const healthLabel = (value: string | null | undefined) => lookup(healths, value, "Not checked");

const adapters: Record<string, string> = {
  "codex-workspace": "Codex workspace",
  "codex-readonly": "Codex read-only adapter",
  "codex-companion": "Codex companion",
};
export const adapterLabel = (kind: string) => (Object.hasOwn(adapters, kind) ? adapters[kind]! : humanize(kind));

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** "You" for the signed-in user; otherwise the owner type with a short ID or a known organization name. */
export function ownerLabel(owner: ArchitectureTargetOwnerReference, currentUserId: string, organizationNames: ReadonlyMap<string, string> = new Map()): string {
  if (owner.type === "user") return owner.id === currentUserId ? "You" : `User ${shortId(owner.id)}`;
  if (owner.type === "team") return `Team ${shortId(owner.id)}`;
  return organizationNames.get(owner.id) ?? `Organization ${shortId(owner.id)}`;
}

const updateStatuses: Record<string, readonly [string, Tone]> = {
  current: ["Up to date", "neutral"],
  "up-to-date": ["Up to date", "neutral"],
  "update-available": ["Update available", "teal"],
  pinned: ["Pinned", "neutral"],
  drifted: ["Drifted", "danger"],
  "installed-newer": ["Newer than registry", "amber"],
  "no-compatible-release": ["No compatible release", "amber"],
  "invalid-installed-version": ["Invalid installed version", "danger"],
};
export const updateStatusLabel = (value: string) => lookup(updateStatuses, value);

/** Update-available first, then blocked, drifted and other states, then up to date. */
export function updateStatusRank(value: string): number {
  if (value === "update-available") return 0;
  if (value === "current" || value === "up-to-date") return 2;
  return 1;
}

const operationStates: Record<string, readonly [string, Tone]> = {
  queued: ["Queued", "neutral"],
  claimed: ["Claimed", "neutral"],
  applying: ["Applying", "neutral"],
  verifying: ["Verifying", "neutral"],
  succeeded: ["Succeeded", "teal"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
  expired: ["Expired", "amber"],
};
export const operationStateLabel = (value: string) => lookup(operationStates, value);

export const ACTIVE_OPERATION_STATES: readonly string[] = ["queued", "claimed", "applying", "verifying"];
export const isActiveOperationState = (value: string) => ACTIVE_OPERATION_STATES.includes(value);

const operationActions: Record<string, readonly [string, Tone]> = {
  install: ["Install", "neutral"],
  update: ["Update", "neutral"],
  rollback: ["Rollback", "neutral"],
};
export const operationActionLabel = (value: string) => lookup(operationActions, value).label;

export const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;
