import type { ReviewStatus, SecurityStatus, VisibilityScope } from "./index.js";
import type { SkillReleaseChangeKind, SkillReleaseMetadata, SkillUpdateEvaluation } from "./skill-updates.js";
import { skillReleaseChangeKinds, MAX_SKILL_RELEASE_NOTES_LENGTH } from "./skill-updates.js";

/**
 * Libraries: shared contracts for collecting, importing, tracking and
 * adopting skills. The API/Postgres records are canonical; these types are
 * the wire shapes consumed by the web app, CLI and tests.
 */

export const libraryOwnerTypes = ["user", "team"] as const;
export const libraryEntryKinds = ["source", "skill"] as const;
export const librarySourceRefKinds = ["default-branch", "branch", "tag", "commit", "latest-release", "tag-prefix"] as const;
export const libraryTrackingModes = ["off", "manual", "daily", "weekly"] as const;
export const librarySourceHealthStates = [
  "not-tracked",
  "healthy",
  "checking",
  "rate-limited",
  "access-lost",
  "unavailable",
  "archived",
  "identity-change-review",
  "paused",
] as const;
export const libraryCandidateStates = ["ready-for-review", "blocked", "accepted", "ignored", "superseded", "expired"] as const;
export const libraryEventKinds = [
  "candidate-ready",
  "candidate-blocked",
  "new-skill-discovered",
  "skill-removed",
  "skill-renamed-suggested",
  "source-health-changed",
  "adoption-changed",
] as const;
/** Events delivered only to current curators; the rest reach any entitled subscriber. */
export const libraryCuratorEventKinds = [
  "candidate-ready",
  "candidate-blocked",
  "new-skill-discovered",
  "skill-removed",
  "skill-renamed-suggested",
  "source-health-changed",
] as const;
export const libraryFindingCodes = [
  "unsupported-symlink",
  "unsupported-submodule",
  "unsupported-lfs-pointer",
  "unsupported-binary",
  "limit-exceeded",
  "unresolved-dependency",
  "cross-root-dependency",
  "license-review-required",
  "metadata-mapping-required",
  "manifest-path-collision",
  "nested-skill-root",
  "plugin-package-unsupported",
  "invalid-native-name",
  "external-reference",
  "host-capability-review",
  "inventory-incomplete",
  "skill-root-missing",
  "package-scan-blocking",
  "package-scan-warning",
  "unsupported-path",
  "native-frontmatter-unsupported",
] as const;
export const libraryTransformKinds = [
  "generated-manifest",
  "generated-import-manifest",
  "include-repository-notice",
  "reviewed-metadata-mapping",
  "platform-mapping",
  "normalize-runtime-name",
] as const;
/** Package root path that holds the exact upstream SKILL.md. It is never a second skill. */
export const LIBRARY_ORIGINAL_SKILL_PATH = "myskills-source-skill.txt";
export const libraryAttestationKinds = ["private-self-reviewed", "instance-reviewed"] as const;

export const LIBRARY_LIMITS = {
  maxLibrariesPerOwner: 100,
  maxEntriesPerLibrary: 500,
  maxInventoryPaths: 10_000,
  maxPreviewPaths: 20,
  maxDiscoveredRoots: 200,
  previewTtlHours: 24,
  trackingCandidateTtlDays: 7,
  checkDeadlineMs: 60_000,
  maxCheckAttempts: 5,
  /** Provider-backed source requests (add source, discover, preview, check now) per user per hour. */
  maxSourceOperationsPerHour: 10,
} as const;

/** Directories left out of default discovery. They remain explicitly selectable. */
export const LIBRARY_DEFAULT_EXCLUDED_SEGMENTS = [
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "example",
  "examples",
  "testdata",
  "node_modules",
  "dist",
  "build",
  ".github",
  "vendor",
] as const;

export type LibraryOwnerType = (typeof libraryOwnerTypes)[number];
export type LibraryEntryKind = (typeof libraryEntryKinds)[number];
export type LibrarySourceRefKind = (typeof librarySourceRefKinds)[number];
export type LibraryTrackingMode = (typeof libraryTrackingModes)[number];
export type LibrarySourceHealth = (typeof librarySourceHealthStates)[number];
export type LibraryCandidateState = (typeof libraryCandidateStates)[number];
export type LibraryEventKind = (typeof libraryEventKinds)[number];
export type LibraryFindingCode = (typeof libraryFindingCodes)[number];
export type LibraryTransformKind = (typeof libraryTransformKinds)[number];
export type LibraryAttestation = (typeof libraryAttestationKinds)[number];

export type LibraryOwnerReference = { type: "user"; id: string } | { type: "team"; id: string; name: string };

export interface LibrarySourceRef {
  kind: LibrarySourceRefKind;
  value?: string;
}

export interface LibrarySubscription {
  events: LibraryEventKind[];
  createdAt: string;
}

export interface LibrarySummary {
  id: string;
  name: string;
  description: string;
  owner: LibraryOwnerReference;
  status: "active";
  revision: number;
  access: {
    role: "owner" | "curator" | "member";
    canWrite: boolean;
    canTrackSources: boolean;
    canImport: boolean;
  };
  subscription: LibrarySubscription | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryEntrySource {
  provider: "github";
  repositoryId: string;
  fullName: string;
  url: string;
  path: string;
  ref: LibrarySourceRef;
  defaultBranch: string | null;
  license: string | null;
  archived: boolean;
}

export interface SourceSnapshotSummary {
  id: string;
  sequence: number;
  commit: string;
  treeSha: string;
  ref: LibrarySourceRef;
  upstreamLabel: string | null;
  orderStatus: "initial" | "ahead" | "identical" | "unverified";
  complete: boolean;
  observedAt: string;
}

export interface LibraryEntryTracking {
  mode: LibraryTrackingMode;
  health: LibrarySourceHealth;
  nextCheckAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastErrorCode: string | null;
  attemptCount: number;
  lastGoodSnapshot: { id: string; commit: string; upstreamLabel: string | null; observedAt: string } | null;
  workerAvailable: boolean;
  /**
   * Rename or transfer detected for this entry and not yet acknowledged. Confirm it with
   * `PATCH .../tracking` and `acknowledgeIdentityChange: true`; until then discovery, preview,
   * checks and daily/weekly tracking are refused.
   */
  identityChange: { acknowledgedFullName: string; observedFullName: string; observedUrl: string } | null;
}

export interface LibraryEntrySkill {
  slug: string;
  nativeName: string | null;
  sourceEntryId: string | null;
  sourcePath: string | null;
  lineageId: string | null;
  ownership: { type: "user"; isCaller: boolean };
}

export interface LibraryAdoption {
  id: string;
  entryId: string;
  slug: string;
  version: string;
  artifactSha256: string;
  predecessorAdoptionId: string | null;
  attestation: LibraryAttestation;
  adoptedBy: { id: string };
  reason: string;
  adoptedAt: string;
}

export interface LibraryEntry {
  id: string;
  libraryId: string;
  kind: LibraryEntryKind;
  status: "active";
  revision: number;
  title: string;
  source?: LibraryEntrySource;
  tracking?: LibraryEntryTracking;
  skill?: LibraryEntrySkill;
  adoption: LibraryAdoption | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFinding {
  code: LibraryFindingCode;
  severity: "blocking" | "warning" | "info";
  message: string;
  path?: string;
}

export interface LibraryTransform {
  kind: LibraryTransformKind;
  path?: string;
  detail?: string;
  /** `normalize-runtime-name` only: where the exact upstream SKILL.md is held in the package. */
  originalPath?: string;
  /** `normalize-runtime-name` only: SHA-256 of the upstream SKILL.md bytes. */
  originalSha256?: string;
  /** `normalize-runtime-name` only: SHA-256 of the packaged runtime SKILL.md bytes. */
  transformedSha256?: string;
  /** `normalize-runtime-name` only: the upstream frontmatter name, or null when none was declared. */
  originalName?: string | null;
  /** `normalize-runtime-name` only: the runtime name, equal to the registry slug. */
  runtimeName?: string;
}

export interface LibraryCandidateFile {
  path: string;
  sha256: string;
  bytes: number;
  origin: "upstream" | "repository-notice" | "generated";
  sourcePath: string | null;
  gitBlobSha: string | null;
  content?: string;
}

export interface LibraryCandidateMapping {
  slug: string;
  title: string;
  summary: string;
  license: string;
  visibility: VisibilityScope;
  platforms: Array<{ name: string; installTarget: string; status: "supported" }>;
  nativeName: string | null;
  transforms: LibraryTransform[];
}

export interface LibraryCandidate {
  id: string;
  sourceEntryId: string;
  skillEntryId: string | null;
  previewId: string | null;
  lineage: { id: string; slug: string; nativeName: string | null };
  state: LibraryCandidateState;
  origin: "preview" | "tracking";
  sourcePath: string;
  snapshot: SourceSnapshotSummary;
  /**
   * Order of `snapshot.commit` against the commit this lineage last imported (`initial` before the
   * first import). Only `unverified` accepts, and requires, `acknowledgeUnverifiedOrder`.
   */
  orderStatus: SourceSnapshotSummary["orderStatus"];
  expectedVersion: string;
  expectedPriorRevision: number;
  sourceDigest: string;
  packageDigest: string | null;
  files: LibraryCandidateFile[];
  mapping: LibraryCandidateMapping;
  release: { suggested: { classification: "unclassified"; changeKind: "breaking"; requiresUserAction: true; releaseNotes: string } };
  findings: LibraryFinding[];
  changes: { added: string[]; changed: string[]; removed: string[] } | null;
  registry: {
    submissionId: string;
    slug: string;
    version: string;
    reviewStatus: ReviewStatus;
    securityStatus: SecurityStatus;
    publishedAt: string | null;
    attestation: LibraryAttestation | null;
    elevationRequestedAt: string | null;
  } | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface DiscoveredSkillRoot {
  path: string;
  directoryName: string;
  fileCount: number;
  byteCount: number;
  blockers: LibraryFinding[];
  lineage: { id: string; slug: string; latestVersion: string | null } | null;
  excludedReason?: "default-excluded";
}

export interface SourceDiscovery {
  snapshot: SourceSnapshotSummary;
  complete: boolean;
  skills: DiscoveredSkillRoot[];
  excluded: DiscoveredSkillRoot[];
  limits: { maxInventoryPaths: number; maxPackageFiles: number; maxPackageTextBytes: number };
}

export interface SourceCheckResult {
  outcome: "unchanged" | "changed" | "failed";
  health: LibrarySourceHealth;
  snapshot: SourceSnapshotSummary | null;
  candidateIds: string[];
  eventKinds: LibraryEventKind[];
  errorCode: string | null;
  retryAfterSeconds: number | null;
  nextCheckAt: string | null;
}

export type LibraryEntryResolution =
  | { state: "adopted"; entryId: string; libraryId: string; slug: string; version: string; artifactSha256: string; adoptionId: string; adoptedAt: string }
  | { state: "no-adoption"; entryId: string; libraryId: string; slug: string }
  | { state: "adoption-unavailable"; entryId: string; libraryId: string; slug: string; version: string };

export interface LibraryBinding {
  id: string;
  entryId: string;
  libraryId: string;
  targetId: string;
  slug: string;
  status: "active" | "curation-unavailable" | "detached";
  pinnedVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryInboxItem {
  id: string;
  kind: LibraryEventKind;
  libraryId: string;
  libraryName: string;
  entryId: string | null;
  entryTitle: string | null;
  candidateId: string | null;
  version: string | null;
  path: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface LibraryAdminSettings {
  privateSelfReviewEnabled: boolean;
  updatedAt: string | null;
}

/** Library constraint attached to a connected-target Updates item. */
export interface LibraryUpdateItemLibraryState {
  state: "adopted" | "curation-unavailable" | "binding-version-conflict";
  entryIds: string[];
  adoptedVersions: string[];
}

export interface LibraryUpdateItem {
  slug: string;
  platform: string;
  evaluation: SkillUpdateEvaluation;
  library?: LibraryUpdateItemLibraryState;
}

export type LibraryImportReleaseInput =
  | { classification: "unclassified" }
  | { changeKind: SkillReleaseChangeKind; requiresUserAction: boolean; releaseNotes: string };

export type LibraryParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ParsedGithubSourceUrl {
  owner: string;
  repo: string;
  /** Ref named by a `/tree/<ref>` or `/blob/<ref>` URL. One path segment only. */
  ref: string | null;
  /** Repository-relative directory selection; "" for the repository root. */
  path: string;
}

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_REF_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const SAFE_PATH_SEGMENT = /^[^\u0000-\u001f\u007f\\/:*?"<>|]{1,255}$/u;

/**
 * Map a pasted GitHub URL to a repository selection. Only HTTPS github.com
 * URLs without credentials, ports, queries or dot segments are accepted.
 * The caller never fetches the pasted URL itself; it uses fixed provider hosts.
 */
export function parseGithubSourceUrl(input: unknown): LibraryParseResult<ParsedGithubSourceUrl> {
  if (typeof input !== "string" || input.length === 0 || input.length > 2_000 || /[\s\u0000-\u001f\u007f\\]/u.test(input)) {
    return { ok: false, reason: "URL must be a single HTTPS GitHub URL." };
  }
  // WHATWG URL parsing silently resolves dot segments; reject them first.
  if (/(^|\/)\.{1,2}(\/|$|[?#])/.test(input.replace(/^https:\/\//i, "/")) || /%2e|%2f|%5c/i.test(input)) {
    return { ok: false, reason: "URL must not contain dot or encoded separator segments." };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "URL is invalid." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Only HTTPS GitHub URLs are supported." };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not accepted." };
  if (url.port) return { ok: false, reason: "URLs with ports are not accepted." };
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return { ok: false, reason: "Only github.com repository URLs are supported." };
  }
  if (url.search) return { ok: false, reason: "URLs with query strings are not accepted." };
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return { ok: false, reason: "URL must name an owner and repository." };
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/, "");
  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    return { ok: false, reason: "Repository owner or name is invalid." };
  }
  if (segments.length === 2) return { ok: true, value: { owner, repo, ref: null, path: "" } };
  const mode = segments[2];
  if ((mode !== "tree" && mode !== "blob") || segments.length < 4) {
    return { ok: false, reason: "Only repository, tree and SKILL.md blob URLs are supported." };
  }
  const ref = segments[3]!;
  if (!GITHUB_REF_PATTERN.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    return { ok: false, reason: "The URL ref is invalid." };
  }
  let pathSegments: string[];
  try {
    pathSegments = segments.slice(4).map((segment) => decodeURIComponent(segment));
  } catch {
    return { ok: false, reason: "URL path encoding is invalid." };
  }
  if (pathSegments.some((segment) => !SAFE_PATH_SEGMENT.test(segment) || segment === "." || segment === "..")) {
    return { ok: false, reason: "URL path is invalid." };
  }
  if (mode === "blob") {
    if (pathSegments.at(-1) !== "SKILL.md") return { ok: false, reason: "Blob URLs must point to a SKILL.md file." };
    pathSegments = pathSegments.slice(0, -1);
  }
  return { ok: true, value: { owner, repo, ref, path: pathSegments.join("/") } };
}

export function isDefaultExcludedSourcePath(path: string): boolean {
  return path.split("/").some((segment) => (LIBRARY_DEFAULT_EXCLUDED_SEGMENTS as readonly string[]).includes(segment.toLowerCase()));
}

const IMPORTED_SLUG_SUFFIX_PATTERN = /^[a-z0-9]{10}$/;
const SKILL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Every imported lineage receives a readable prefix plus an opaque suffix.
 * The result fits the existing 64-character registry slug limit.
 */
export function allocateImportedSkillSlug(nativeName: string, suffix: string): string {
  if (!IMPORTED_SLUG_SUFFIX_PATTERN.test(suffix)) throw new Error("Imported slug suffix must be 10 lowercase alphanumeric characters.");
  const prefix = nativeName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64 - suffix.length - 1)
    .replace(/-+$/g, "") || "skill";
  const slug = `${prefix}-${suffix}`;
  if (!SKILL_SLUG_PATTERN.test(slug) || slug.includes("--") || slug.length > 64) {
    throw new Error("Imported slug allocation failed.");
  }
  return slug;
}

/** Monotonic importer revision, visibly distinct from upstream version labels. */
export function importRevisionVersion(revision: number): string {
  if (!Number.isInteger(revision) || revision < 1) throw new Error("Import revision must be a positive integer.");
  return `0.0.${revision}`;
}

/**
 * Import release metadata is mandatory. Unclassified imports are mapped
 * conservatively and never inherit the registry default of maintenance.
 */
export function libraryImportReleaseMetadata(
  input: unknown,
  context: { repository: string; commit: string; path: string; upstreamLabel?: string | null },
): LibraryParseResult<SkillReleaseMetadata & { classification: "unclassified" | "reviewed" }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "Import release metadata is required." };
  }
  const record = input as Record<string, unknown>;
  if (record.classification !== undefined) {
    if (record.classification !== "unclassified" || Object.keys(record).length !== 1) {
      return { ok: false, reason: "Use either { classification: \"unclassified\" } or an explicit reviewed classification." };
    }
    return {
      ok: true,
      value: {
        classification: "unclassified",
        releaseNotes: conservativeImportReleaseNotes(context),
        changeKind: "breaking",
        requiresUserAction: true,
        compatibility: {},
      },
    };
  }
  const unknownField = Object.keys(record).find((field) => field !== "changeKind" && field !== "requiresUserAction" && field !== "releaseNotes");
  if (unknownField) return { ok: false, reason: `Import release field is not accepted: ${unknownField}` };
  if (typeof record.changeKind !== "string" || !skillReleaseChangeKinds.includes(record.changeKind as SkillReleaseChangeKind)) {
    return { ok: false, reason: `Release changeKind must be one of: ${skillReleaseChangeKinds.join(", ")}.` };
  }
  if (typeof record.requiresUserAction !== "boolean") return { ok: false, reason: "Release requiresUserAction must be a boolean." };
  if (typeof record.releaseNotes !== "string" || !record.releaseNotes.trim() || record.releaseNotes.length > MAX_SKILL_RELEASE_NOTES_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(record.releaseNotes)) {
    return { ok: false, reason: "Reviewed release notes are required and must be plain text." };
  }
  return {
    ok: true,
    value: {
      classification: "reviewed",
      releaseNotes: record.releaseNotes,
      changeKind: record.changeKind as SkillReleaseChangeKind,
      requiresUserAction: record.requiresUserAction,
      compatibility: {},
    },
  };
}

export function conservativeImportReleaseNotes(context: { repository: string; commit: string; path: string; upstreamLabel?: string | null }): string {
  const label = context.upstreamLabel ? ` (${context.upstreamLabel})` : "";
  return `Imported from ${context.repository}@${context.commit.slice(0, 12)}${label}, path ${context.path || "."}. Change classification unknown until reviewed.`;
}
