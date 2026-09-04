import type { SkillLifecycleStatus, SkillPlatformVariant } from "./index.js";

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const skillReleaseChangeKinds = ["fix", "feature", "breaking", "security", "maintenance"] as const;
export type SkillReleaseChangeKind = (typeof skillReleaseChangeKinds)[number];

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export interface SkillReleaseCompatibility {
  minimumMyskillsVersion?: string;
  minimumAdapterContractVersion?: number;
  minimumSourceVersion?: string;
}

export interface SkillReleaseMetadata {
  releaseNotes: string;
  changeKind: SkillReleaseChangeKind;
  requiresUserAction: boolean;
  compatibility: SkillReleaseCompatibility;
}

export const DEFAULT_SKILL_RELEASE_METADATA: SkillReleaseMetadata = {
  releaseNotes: "",
  changeKind: "maintenance",
  requiresUserAction: false,
  compatibility: {},
};

export const MAX_SKILL_RELEASE_NOTES_LENGTH = 20_000;

export interface SkillReleaseUpdateCandidate {
  version: string;
  lifecycleStatus: Extract<SkillLifecycleStatus, "approved" | "deprecated">;
  publishedAt: string;
  platforms: SkillPlatformVariant[];
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
  releaseNotes: string;
  changeKind: SkillReleaseChangeKind;
  requiresUserAction: boolean;
  compatibility: SkillReleaseCompatibility;
}

export const skillUpdateStatuses = [
  "current",
  "update-available",
  "pinned",
  "drifted",
  "installed-newer",
  "no-compatible-release",
  "invalid-installed-version",
] as const;
export type SkillUpdateStatus = (typeof skillUpdateStatuses)[number];

export const skillUpdateBlockerCodes = [
  "release-deprecated",
  "platform-unsupported",
  "prerelease-not-selected",
  "minimum-myskills-version",
  "minimum-adapter-contract-version",
  "minimum-source-version",
] as const;
export type SkillUpdateBlockerCode = (typeof skillUpdateBlockerCodes)[number];

export interface SkillUpdateEvaluationInput {
  installed: {
    version: string;
    platform: string;
    artifactSha256?: string;
  };
  releases: readonly SkillReleaseUpdateCandidate[];
  policy?: {
    includePrerelease?: boolean;
    pinnedVersion?: string;
  };
  client?: {
    myskillsVersion?: string;
    adapterContractVersion?: number;
  };
}

export interface SkillUpdateEvaluation {
  status: SkillUpdateStatus;
  installedVersion: string;
  currentRelease?: SkillReleaseUpdateCandidate;
  candidate?: SkillReleaseUpdateCandidate;
  includedReleases: SkillReleaseUpdateCandidate[];
  blockers: SkillUpdateBlockerCode[];
}

export function parseSemanticVersion(input: string): SemanticVersion | null {
  const match = semanticVersionPattern.exec(input);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    build: match[5]?.split(".") ?? [],
  };
}

export function compareSemanticVersions(left: string, right: string): number {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error(`Cannot compare invalid semantic versions: ${JSON.stringify(left)} and ${JSON.stringify(right)}.`);
  }
  for (const field of ["major", "minor", "patch"] as const) {
    if (parsedLeft[field] !== parsedRight[field]) return parsedLeft[field] < parsedRight[field] ? -1 : 1;
  }
  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return Number(leftIdentifier) < Number(rightIdentifier) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function isPrereleaseVersion(input: string): boolean {
  return (parseSemanticVersion(input)?.prerelease.length ?? 0) > 0;
}

export function parseSkillReleaseMetadata(input: unknown): SkillReleaseMetadata {
  if (input === undefined) return { ...DEFAULT_SKILL_RELEASE_METADATA, compatibility: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Release metadata must be an object.");
  }
  const record = input as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => (
    field !== "releaseNotes"
    && field !== "changeKind"
    && field !== "requiresUserAction"
    && field !== "compatibility"
  ));
  if (unknownField) throw new Error(`Release metadata field is not accepted: ${unknownField}`);

  const releaseNotes = record.releaseNotes ?? "";
  if (typeof releaseNotes !== "string" || releaseNotes.length > MAX_SKILL_RELEASE_NOTES_LENGTH) {
    throw new Error(`Release notes must be a string of at most ${MAX_SKILL_RELEASE_NOTES_LENGTH} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(releaseNotes)) {
    throw new Error("Release notes contain unsupported control characters.");
  }

  const changeKind = record.changeKind ?? "maintenance";
  if (typeof changeKind !== "string" || !skillReleaseChangeKinds.includes(changeKind as SkillReleaseChangeKind)) {
    throw new Error(`Release change kind must be one of: ${skillReleaseChangeKinds.join(", ")}.`);
  }
  const requiresUserAction = record.requiresUserAction ?? false;
  if (typeof requiresUserAction !== "boolean") {
    throw new Error("Release requiresUserAction must be a boolean.");
  }

  return {
    releaseNotes,
    changeKind: changeKind as SkillReleaseChangeKind,
    requiresUserAction,
    compatibility: parseReleaseCompatibility(record.compatibility),
  };
}

function parseReleaseCompatibility(input: unknown): SkillReleaseCompatibility {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Release compatibility must be an object.");
  }
  const record = input as Record<string, unknown>;
  const unknownField = Object.keys(record).find((field) => (
    field !== "minimumMyskillsVersion"
    && field !== "minimumAdapterContractVersion"
    && field !== "minimumSourceVersion"
  ));
  if (unknownField) throw new Error(`Release compatibility field is not accepted: ${unknownField}`);
  const result: SkillReleaseCompatibility = {};
  for (const field of ["minimumMyskillsVersion", "minimumSourceVersion"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !parseSemanticVersion(value)) {
      throw new Error(`Release compatibility ${field} must be a valid semantic version.`);
    }
    result[field] = value;
  }
  const adapterVersion = record.minimumAdapterContractVersion;
  if (adapterVersion !== undefined) {
    if (!Number.isInteger(adapterVersion) || Number(adapterVersion) < 1 || Number(adapterVersion) > 1_000) {
      throw new Error("Release compatibility minimumAdapterContractVersion must be an integer from 1 to 1000.");
    }
    result.minimumAdapterContractVersion = Number(adapterVersion);
  }
  return result;
}

export function evaluateSkillUpdate(input: SkillUpdateEvaluationInput): SkillUpdateEvaluation {
  const installedVersion = parseSemanticVersion(input.installed.version);
  if (!installedVersion) {
    return {
      status: "invalid-installed-version",
      installedVersion: input.installed.version,
      includedReleases: [],
      blockers: [],
    };
  }

  const releases = input.releases
    .filter((release) => parseSemanticVersion(release.version))
    .sort((left, right) => compareSemanticVersions(left.version, right.version));
  const currentRelease = [...releases]
    .reverse()
    .find((release) => compareSemanticVersions(release.version, input.installed.version) === 0);
  if (
    currentRelease
    && input.installed.artifactSha256
    && currentRelease.artifact.sha256 !== input.installed.artifactSha256
  ) {
    return {
      status: "drifted",
      installedVersion: input.installed.version,
      currentRelease,
      includedReleases: [],
      blockers: [],
    };
  }

  const newer = releases.filter((release) => compareSemanticVersions(release.version, input.installed.version) > 0);
  if (newer.length === 0) {
    const newest = releases.at(-1);
    return {
      status: newest && compareSemanticVersions(input.installed.version, newest.version) > 0 ? "installed-newer" : "current",
      installedVersion: input.installed.version,
      ...(currentRelease ? { currentRelease } : {}),
      includedReleases: [],
      blockers: [],
    };
  }

  const blockerSet = new Set<SkillUpdateBlockerCode>();
  const compatible = newer.filter((release) => {
    const blockers = skillReleaseUpdateBlockers(release, input);
    for (const blocker of blockers) blockerSet.add(blocker);
    return blockers.length === 0;
  });
  const candidate = compatible.at(-1);
  if (!candidate) {
    return {
      status: "no-compatible-release",
      installedVersion: input.installed.version,
      ...(currentRelease ? { currentRelease } : {}),
      includedReleases: [],
      blockers: [...blockerSet].sort(),
    };
  }

  const includedReleases = newer.filter((release) => compareSemanticVersions(release.version, candidate.version) <= 0);
  if (input.policy?.pinnedVersion && compareSemanticVersions(input.policy.pinnedVersion, input.installed.version) === 0) {
    return {
      status: "pinned",
      installedVersion: input.installed.version,
      ...(currentRelease ? { currentRelease } : {}),
      candidate,
      includedReleases,
      blockers: [],
    };
  }
  return {
    status: "update-available",
    installedVersion: input.installed.version,
    ...(currentRelease ? { currentRelease } : {}),
    candidate,
    includedReleases,
    blockers: [],
  };
}

export function skillReleaseUpdateBlockers(
  release: SkillReleaseUpdateCandidate,
  input: SkillUpdateEvaluationInput,
): SkillUpdateBlockerCode[] {
  const blockers: SkillUpdateBlockerCode[] = [];
  if (release.lifecycleStatus !== "approved") blockers.push("release-deprecated");
  if (!release.platforms.some((platform) => platform.name === input.installed.platform && platform.status === "supported")) {
    blockers.push("platform-unsupported");
  }
  if (isPrereleaseVersion(release.version) && input.policy?.includePrerelease !== true) {
    blockers.push("prerelease-not-selected");
  }
  const compatibility = release.compatibility;
  if (
    compatibility.minimumMyskillsVersion
    && (!input.client?.myskillsVersion
      || !parseSemanticVersion(input.client.myskillsVersion)
      || compareSemanticVersions(input.client.myskillsVersion, compatibility.minimumMyskillsVersion) < 0)
  ) {
    blockers.push("minimum-myskills-version");
  }
  if (
    compatibility.minimumAdapterContractVersion !== undefined
    && (input.client?.adapterContractVersion === undefined
      || input.client.adapterContractVersion < compatibility.minimumAdapterContractVersion)
  ) {
    blockers.push("minimum-adapter-contract-version");
  }
  if (
    compatibility.minimumSourceVersion
    && compareSemanticVersions(input.installed.version, compatibility.minimumSourceVersion) < 0
  ) {
    blockers.push("minimum-source-version");
  }
  return blockers;
}
