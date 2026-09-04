import { canonicalizeJson, sha256Hex } from "./architecture-canonical.js";
import { parseSemanticVersion, skillReleaseChangeKinds, type SkillReleaseChangeKind } from "./skill-updates.js";

export const skillUpgradePolicyModes = ["manual", "maintenance-window"] as const;
export type SkillUpgradePolicyMode = (typeof skillUpgradePolicyModes)[number];

export interface SkillUpgradeMaintenanceWindow {
  timeZone: string;
  daysOfWeek: number[];
  startMinute: number;
  durationMinutes: number;
}

export interface SkillUpgradePolicyV1 {
  schemaVersion: 1;
  mode: SkillUpgradePolicyMode;
  includePrerelease: boolean;
  allowedChangeKinds: SkillReleaseChangeKind[];
  pins: Record<string, string>;
  maintenanceWindow?: SkillUpgradeMaintenanceWindow;
}

export const defaultSkillUpgradePolicyV1: SkillUpgradePolicyV1 = Object.freeze({
  schemaVersion: 1,
  mode: "manual",
  includePrerelease: false,
  allowedChangeKinds: Object.freeze([...skillReleaseChangeKinds]) as unknown as SkillReleaseChangeKind[],
  pins: Object.freeze({}),
});

const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const timeZonePattern = /^[A-Za-z0-9_+/-]{1,64}$/;

export function normalizeSkillUpgradePolicyV1(input: unknown): SkillUpgradePolicyV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill upgrade policy must be an object.");
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !["schemaVersion", "mode", "includePrerelease", "allowedChangeKinds", "pins", "maintenanceWindow"].includes(key));
  if (unknown) throw new Error(`Skill upgrade policy field is not accepted: ${unknown}`);
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) throw new Error("Skill upgrade policy schemaVersion must be 1.");
  const mode = record.mode ?? "manual";
  if (typeof mode !== "string" || !skillUpgradePolicyModes.includes(mode as SkillUpgradePolicyMode)) throw new Error("Skill upgrade policy mode is invalid.");
  const includePrerelease = record.includePrerelease ?? false;
  if (typeof includePrerelease !== "boolean") throw new Error("Skill upgrade includePrerelease must be boolean.");
  const kinds = record.allowedChangeKinds ?? skillReleaseChangeKinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > skillReleaseChangeKinds.length) throw new Error("Skill upgrade allowedChangeKinds is invalid.");
  const allowedChangeKinds = [...new Set(kinds.map((kind) => {
    if (typeof kind !== "string" || !skillReleaseChangeKinds.includes(kind as SkillReleaseChangeKind)) throw new Error("Skill upgrade change kind is invalid.");
    return kind as SkillReleaseChangeKind;
  }))].sort();
  const pinsInput = record.pins ?? {};
  if (!pinsInput || typeof pinsInput !== "object" || Array.isArray(pinsInput)) throw new Error("Skill upgrade pins must be an object.");
  const entries = Object.entries(pinsInput as Record<string, unknown>);
  if (entries.length > 500) throw new Error("Skill upgrade pins exceed the 500-skill limit.");
  const pins: Record<string, string> = {};
  for (const [slug, version] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!slugPattern.test(slug) || typeof version !== "string" || !parseSemanticVersion(version)) throw new Error("Skill upgrade pin is invalid.");
    pins[slug] = version;
  }
  const maintenanceWindow = normalizeMaintenanceWindow(record.maintenanceWindow, mode as SkillUpgradePolicyMode);
  return {
    schemaVersion: 1,
    mode: mode as SkillUpgradePolicyMode,
    includePrerelease,
    allowedChangeKinds,
    pins,
    ...(maintenanceWindow ? { maintenanceWindow } : {}),
  };
}

export function skillUpgradePolicyDigest(input: unknown): string {
  return sha256Hex(canonicalizeJson(normalizeSkillUpgradePolicyV1(input)));
}

export function isWithinSkillUpgradeMaintenanceWindow(policyInput: unknown, date = new Date()): boolean {
  const policy = normalizeSkillUpgradePolicyV1(policyInput);
  if (policy.mode !== "maintenance-window" || !policy.maintenanceWindow) return false;
  const window = policy.maintenanceWindow;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: window.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((part) => part.type === "weekday")?.value ?? "");
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? -1);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? -1);
  const localMinute = hour * 60 + minute;
  return window.daysOfWeek.includes(weekday)
    && localMinute >= window.startMinute
    && localMinute < window.startMinute + window.durationMinutes;
}

function normalizeMaintenanceWindow(input: unknown, mode: SkillUpgradePolicyMode): SkillUpgradeMaintenanceWindow | undefined {
  if (input === undefined) {
    if (mode === "maintenance-window") throw new Error("A maintenance window is required for maintenance-window mode.");
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Skill upgrade maintenanceWindow must be an object.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["timeZone", "daysOfWeek", "startMinute", "durationMinutes"].includes(key))) throw new Error("Skill upgrade maintenanceWindow has an unknown field.");
  if (typeof record.timeZone !== "string" || !timeZonePattern.test(record.timeZone)) throw new Error("Skill upgrade maintenance timeZone is invalid.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: record.timeZone }).format(new Date(0));
  } catch {
    throw new Error("Skill upgrade maintenance timeZone is unsupported.");
  }
  if (!Array.isArray(record.daysOfWeek) || record.daysOfWeek.length === 0 || record.daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) throw new Error("Skill upgrade maintenance daysOfWeek is invalid.");
  if (!Number.isInteger(record.startMinute) || Number(record.startMinute) < 0 || Number(record.startMinute) > 1439) throw new Error("Skill upgrade maintenance startMinute is invalid.");
  if (!Number.isInteger(record.durationMinutes) || Number(record.durationMinutes) < 15 || Number(record.durationMinutes) > 1440 || Number(record.startMinute) + Number(record.durationMinutes) > 1440) throw new Error("Skill upgrade maintenance durationMinutes is invalid.");
  return {
    timeZone: record.timeZone,
    daysOfWeek: [...new Set(record.daysOfWeek.map(Number))].sort((left, right) => left - right),
    startMinute: Number(record.startMinute),
    durationMinutes: Number(record.durationMinutes),
  };
}
