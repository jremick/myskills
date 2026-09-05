import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readFile, realpath, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  DEFAULT_MANIFEST_NAMES,
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_TEXT_BYTES,
  parseSkillManifest,
  scanPackageFiles,
  SKILL_PACKAGE_MANIFEST_CONTRACT_ID,
  SKILL_PACKAGE_SCANNER_CONTRACT_ID,
  type PackageInputFile,
  type ScanFinding,
  type SkillManifest,
} from "@myskills-app/skill-package";

export const CODEX_BOOTSTRAP_REPORT_SCHEMA = "myskills.codex-bootstrap-dry-run.v3" as const;

export const CODEX_BOOTSTRAP_CONTRACT_VERSIONS = Object.freeze({
  planner: "myskills.codex-bootstrap.planner.v3",
  scanner: SKILL_PACKAGE_SCANNER_CONTRACT_ID,
  manifest: SKILL_PACKAGE_MANIFEST_CONTRACT_ID,
}) as {
  readonly planner: string;
  readonly scanner: string;
  readonly manifest: string;
};

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SOURCE_TYPES = ["work", "shared"] as const;
const SOURCE_TRUST_COMPARTMENTS = ["work", "shared", "work+shared"] as const;
const TARGET_TRUST_COMPARTMENTS = ["work-team"] as const;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_FRONTMATTER_LINES = 4096;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW_FLAG = fsConstants.O_NOFOLLOW;
const DIRECTORY_FLAG = fsConstants.O_DIRECTORY;
// These names are never copied into a persisted candidate snapshot. A clean
// heuristic scan cannot establish that a configuration or credential file is
// safe for a later executor to apply.
const SENSITIVE_FILE_NAME_PATTERN = /^(?:\.env(?:\..*)?|\.git-credentials|\.npmrc|\.pypirc|\.netrc|application_default_credentials\.json|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdb))$/iu;
const SENSITIVE_DIRECTORY_NAME_PATTERN = /^(?:\.ssh|\.aws|\.azure|\.docker|\.gcloud|\.kube|\.oci|\.gnupg|credentials?|secrets?)$/iu;
const SENSITIVE_DIRECTORY_PATH_PATTERN = /(?:^|\/)\.config\/(?:azure|gcloud|gsutil|oci)(?:\/|$)/iu;

export type CodexBootstrapSourceType = (typeof SOURCE_TYPES)[number];
export type CodexBootstrapSourceTrustCompartment = (typeof SOURCE_TRUST_COMPARTMENTS)[number];
export type CodexBootstrapTargetTrustCompartment = (typeof TARGET_TRUST_COMPARTMENTS)[number];
export type CodexBootstrapCandidateSelector = string | {
  slug: string;
  sourceType?: CodexBootstrapSourceType;
};

/** Explicit roots are caller-provided trust-boundary declarations. */
export interface CodexBootstrapSourceRoot {
  type: CodexBootstrapSourceType;
  root: string;
}

/** Paths are process-local planner inputs. No path is written to the report. */
export interface CodexBootstrapPaths {
  liveSkillsRoot: string;
  reportPath?: string;
  outputRoot?: string;
  sourceRoots?: CodexBootstrapSourceRoot[];
  workSourceRoot?: string;
  sharedSourceRoot?: string;
}

export interface CodexBootstrapContext {
  profile: string;
  targetOrigin: string;
  instanceId: string;
  tenantId?: string;
  workspaceId?: string;
  actorId: string;
  sourceTrustCompartment: CodexBootstrapSourceTrustCompartment;
  targetTrustCompartment: CodexBootstrapTargetTrustCompartment;
  approvedSourceRoots: Array<{
    type: CodexBootstrapSourceType;
    identityDigest: string;
  }>;
  approvedTargetRootIdentityDigest: string;
}

export interface CodexBootstrapContractVersions {
  planner?: string;
  scanner?: string;
  manifest?: string;
}

export interface CodexBootstrapFinding {
  category: string;
  severity: "warning" | "blocking";
  path?: string;
}

export interface CodexBootstrapCandidate {
  slug: string;
  sourceType: CodexBootstrapSourceType;
  ownership: CodexBootstrapSourceType;
  /** Stable artifact/content identity. It is independent of target context. */
  candidateIdentity: string;
  contentIdentity: string;
  /** Per-candidate execution identity bound to this target and contract set. */
  executionIdentity: string;
  visibility: "private" | "team";
  version: string;
  manifestDecision: "reused" | "generated-skill-json" | "generated-skill-manifest-json";
  manifestPath: string;
  manifestSummaryTruncated: boolean;
  filesScanned: number;
  bytesScanned: number;
  artifact: {
    sha256: string;
    byteSize: number;
  };
  /** Exact target precondition held by the dry-run and required by a future CAS. */
  targetObservation: {
    state: "absent" | "present-identical";
    expectedArtifact: { sha256: string; byteSize: number } | null;
  };
  ready: boolean;
  findingCounts: Record<string, number>;
  findings: CodexBootstrapFinding[];
  /** Private report content. It is never included in the stdout DTO. */
  snapshot: PackageInputFile[];
}

export interface CodexBootstrapExclusion {
  slug?: string;
  sourceType?: CodexBootstrapSourceType;
  reason: string;
}

export interface CodexBootstrapSelectorResult {
  selector: { slug: string; sourceType?: CodexBootstrapSourceType };
  terminal: "ready" | "blocked" | "excluded";
  candidateIdentity?: string;
  executionIdentity?: string;
  targetObservation?: CodexBootstrapCandidate["targetObservation"];
  reason?: string;
}

export interface CodexBootstrapReport {
  schemaVersion: typeof CODEX_BOOTSTRAP_REPORT_SCHEMA;
  mode: "work-team";
  dryRun: true;
  createdAt: string;
  reportChecksum: string;
  planIdentity: string;
  target: {
    profile: "work";
    targetOrigin: string;
    instanceId: string;
    tenantOrWorkspaceId: string;
    actorId: string;
    sourceTrustCompartment: CodexBootstrapSourceTrustCompartment;
    targetTrustCompartment: CodexBootstrapTargetTrustCompartment;
    approvedSourceRoots: Array<{ type: CodexBootstrapSourceType; identityDigest: string }>;
    approvedTargetRootIdentityDigest: string;
  };
  roots: {
    identityDigest: string;
    sourceRootIdentityDigests: Record<CodexBootstrapSourceType, string>;
    targetRootIdentityDigest: string;
  };
  contracts: {
    requested: {
      planner: string;
      scanner: string;
      manifest: string;
    };
    current: typeof CODEX_BOOTSTRAP_CONTRACT_VERSIONS;
    stale: string[];
  };
  selection: {
    candidateAllowlist: Array<{ slug: string; sourceType?: CodexBootstrapSourceType }>;
    allowlistDigest: string;
    results: CodexBootstrapSelectorResult[];
  };
  candidateCount: number;
  readyCandidateCount: number;
  totalFiles: number;
  totalBytes: number;
  exclusions: CodexBootstrapExclusion[];
  blockers: string[];
  status: "ready" | "blocked";
  candidates: CodexBootstrapCandidate[];
  mutations: {
    networkCalls: false;
    remoteWrites: false;
    registryWrites: false;
    sourceWrites: false;
    liveWrites: false;
    reportWrite: true;
  };
}

export interface CodexBootstrapStdoutDto {
  schemaVersion: typeof CODEX_BOOTSTRAP_REPORT_SCHEMA;
  mode: "work-team";
  dryRun: true;
  status: CodexBootstrapReport["status"];
  candidateCount: number;
  readyCandidateCount: number;
  exclusionCount: number;
  blockerCount: number;
  planIdentity: string;
  reportChecksum: string;
  reportWritten: true;
}

export class CodexBootstrapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexBootstrapError";
  }
}

/** Test-only seams used to deterministically reproduce filesystem races. */
export interface CodexBootstrapTestHooks {
  afterSnapshotFileRead?: (relativePath: string) => void | Promise<void>;
  beforeReportOpen?: () => void | Promise<void>;
  afterReportOpen?: () => void | Promise<void>;
}

interface NormalizedPaths {
  liveSkillsRoot: string;
  reportPath: string;
  reportParent: string;
  reportParentIdentity: string;
  sourceRoots: Array<{ type: CodexBootstrapSourceType; root: string; realRoot: string }>;
  realLiveRoot: string;
  rootIdentityDigest: string;
  sourceRootIdentityDigests: Record<CodexBootstrapSourceType, string>;
  targetRootIdentityDigest: string;
}

interface NormalizedContext {
  profile: "work";
  targetOrigin: string;
  instanceId: string;
  tenantOrWorkspaceId: string;
  actorId: string;
  sourceTrustCompartment: CodexBootstrapSourceTrustCompartment;
  targetTrustCompartment: CodexBootstrapTargetTrustCompartment;
  approvedSourceRoots: Array<{ type: CodexBootstrapSourceType; identityDigest: string }>;
  approvedTargetRootIdentityDigest: string;
}

interface NormalizedSelector {
  slug: string;
  sourceType?: CodexBootstrapSourceType;
}

interface SelectedSource {
  slug: string;
  sourceType: CodexBootstrapSourceType;
  sourceRoot: string;
  sourceDir: string;
  liveDir: string;
  liveRoot: string;
  sourceRootIdentityDigest: string;
}

interface BootstrapFileIdentity {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly stats: BigIntStats;
}

interface BootstrapDirectoryIdentity {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly realPath: string;
  readonly stats: BigIntStats;
}

interface BootstrapSnapshotIdentity {
  readonly rootPath: string;
  readonly boundaryRoot: string;
  readonly rootRealPath: string;
  readonly rootStats: BigIntStats;
  readonly directories: readonly BootstrapDirectoryIdentity[];
  readonly files: readonly BootstrapFileIdentity[];
}

interface BootstrapTargetAbsence {
  readonly targetPath: string;
  readonly boundaryRoot: string;
  readonly parentPath: string;
  readonly parentRealPath: string;
  readonly parentStats: BigIntStats;
}

type BootstrapTargetObservation = {
  kind: "present";
  liveDir: string;
  liveRoot: string;
  snapshot?: BootstrapSnapshot;
} | {
  kind: "absent";
  absence: BootstrapTargetAbsence;
};

interface BootstrapManifestResult {
  snapshot: BootstrapSnapshot;
  manifest: SkillManifest;
  decision: CodexBootstrapCandidate["manifestDecision"];
  path: string;
  summaryTruncated: boolean;
}

interface BootstrapSnapshotFile {
  readonly path: string;
  readonly content: string;
  readonly bytes: Buffer;
}

interface BootstrapFileReadResult {
  readonly file: BootstrapSnapshotFile;
  readonly identity: BootstrapFileIdentity;
}

interface BootstrapSnapshot {
  readonly files: readonly BootstrapSnapshotFile[];
  readonly totalBytes: number;
  readonly identity: BootstrapSnapshotIdentity;
}

/**
 * Build a work/team dry-run report. The planner reads each selected source
 * once, scans an immutable in-memory snapshot, and writes only the requested
 * report file. It has no network, registry, publishing, or target mutation
 * path.
 */
export async function createCodexBootstrapDryRun(input: {
  paths: CodexBootstrapPaths;
  context?: Partial<CodexBootstrapContext>;
  profile?: string;
  targetOrigin?: string;
  targetInstanceId?: string;
  instanceId?: string;
  tenantId?: string;
  workspaceId?: string;
  actorId?: string;
  sourceTrustCompartment?: CodexBootstrapSourceTrustCompartment;
  targetTrustCompartment?: CodexBootstrapTargetTrustCompartment;
  candidateAllowlist?: CodexBootstrapCandidateSelector[];
  includeSlugs?: CodexBootstrapCandidateSelector[];
  include?: CodexBootstrapCandidateSelector[];
  allowLoopbackHttp?: boolean;
  contractVersions?: CodexBootstrapContractVersions;
  plannerVersion?: string;
  scannerVersion?: string;
  manifestVersion?: string;
  now?: string;
  testHooks?: CodexBootstrapTestHooks;
}): Promise<{ report: CodexBootstrapReport; reportPath: string }> {
  const selectors = normalizeCandidateAllowlist(input);
  const requestedContracts = normalizeContractVersions(input);
  const staleContracts = staleContractCodes(requestedContracts);
  const paths = await normalizePaths(input.paths);
  const context = normalizeContext(input, paths);
  const canonicalSelectors = rejectResolvedSelectorDuplicates(selectors, paths);
  const exclusions: CodexBootstrapExclusion[] = [];
  const selectedSources = await selectSources(paths, canonicalSelectors, exclusions);
  const candidates: CodexBootstrapCandidate[] = [];

  for (const source of selectedSources) {
    const candidate = await planCandidate(source, staleContracts, requestedContracts, context, paths, exclusions, input.testHooks);
    if (candidate) candidates.push(candidate);
  }

  const blockers = [...staleContracts];
  if (exclusions.length > 0) blockers.push("SELECTED_CANDIDATE_NOT_RESOLVED");
  if (candidates.some((candidate) => !candidate.ready)) blockers.push("SELECTED_CANDIDATE_NOT_SCAN_CLEAN");
  if (candidates.filter((candidate) => candidate.ready).length === 0) blockers.push("NO_READY_CANDIDATES");
  const uniqueBlockers = [...new Set(blockers)].sort(compareOrdinal);
  const selectorResults = buildSelectorResults(canonicalSelectors, selectedSources, candidates, exclusions);
  const allowlistDigest = sha256(canonicalJson(canonicalSelectors));
  const stablePlan = {
    schemaVersion: CODEX_BOOTSTRAP_REPORT_SCHEMA,
    mode: "work-team",
    target: context,
    roots: {
      identityDigest: paths.rootIdentityDigest,
      sourceRootIdentityDigests: paths.sourceRootIdentityDigests,
      targetRootIdentityDigest: paths.targetRootIdentityDigest,
    },
    contracts: {
      requested: requestedContracts,
      owned: CODEX_BOOTSTRAP_CONTRACT_VERSIONS,
    },
    candidateAllowlist: canonicalSelectors,
    allowlistDigest,
    terminalResults: selectorResults,
    blockers: uniqueBlockers,
  };
  const planIdentity = sha256(canonicalJson(stablePlan));
  const reportWithoutChecksum: Omit<CodexBootstrapReport, "reportChecksum"> = {
    schemaVersion: CODEX_BOOTSTRAP_REPORT_SCHEMA,
    mode: "work-team",
    dryRun: true,
    createdAt: normalizeTimestamp(input.now),
    planIdentity,
    target: context,
    roots: {
      identityDigest: paths.rootIdentityDigest,
      sourceRootIdentityDigests: paths.sourceRootIdentityDigests,
      targetRootIdentityDigest: paths.targetRootIdentityDigest,
    },
    contracts: {
      requested: requestedContracts,
      current: CODEX_BOOTSTRAP_CONTRACT_VERSIONS,
      stale: staleContracts,
    },
    selection: {
      candidateAllowlist: canonicalSelectors,
      allowlistDigest,
      results: selectorResults,
    },
    candidateCount: candidates.length,
    readyCandidateCount: candidates.filter((candidate) => candidate.ready).length,
    totalFiles: candidates.reduce((total, candidate) => total + candidate.filesScanned, 0),
    totalBytes: candidates.reduce((total, candidate) => total + candidate.bytesScanned, 0),
    exclusions,
    blockers: uniqueBlockers,
    status: uniqueBlockers.length === 0 ? "ready" : "blocked",
    candidates,
    mutations: {
      networkCalls: false,
      remoteWrites: false,
      registryWrites: false,
      sourceWrites: false,
      liveWrites: false,
      reportWrite: true,
    },
  };
  const report: CodexBootstrapReport = {
    ...reportWithoutChecksum,
    reportChecksum: sha256(canonicalJson(reportWithoutChecksum)),
  };
  await writePrivateReport(paths, report, input.testHooks);
  return { report, reportPath: paths.reportPath };
}

/** Return a privacy-safe, deliberately redacted DTO for terminal output. */
export function codexBootstrapStdoutDto(report: CodexBootstrapReport): CodexBootstrapStdoutDto {
  return {
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    dryRun: true,
    status: report.status,
    candidateCount: report.candidateCount,
    readyCandidateCount: report.readyCandidateCount,
    exclusionCount: report.exclusions.length,
    blockerCount: report.blockers.length,
    planIdentity: report.planIdentity,
    reportChecksum: report.reportChecksum,
    reportWritten: true,
  };
}

/** Parse a caller-supplied context file without echoing its path or contents. */
export async function readCodexBootstrapContextFile(contextPath: string): Promise<Record<string, unknown>> {
  if (typeof contextPath !== "string" || !contextPath.trim() || contextPath.includes("\0") || /[\u0000-\u001f\u007f]/u.test(contextPath)) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work context file is invalid.");
  }
  let text: string;
  try {
    text = await readFile(path.resolve(contextPath), "utf8");
  } catch {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work context file could not be read.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CONTEXT_BYTES) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work context file is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work context file is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work context file must contain one object.");
  }
  return parsed;
}

export function calculateCodexBootstrapReportChecksum(report: CodexBootstrapReport): string {
  const { reportChecksum: _ignored, ...body } = report;
  return sha256(canonicalJson(body));
}

function normalizeCandidateAllowlist(input: {
  candidateAllowlist?: CodexBootstrapCandidateSelector[];
  includeSlugs?: CodexBootstrapCandidateSelector[];
  include?: CodexBootstrapCandidateSelector[];
}): NormalizedSelector[] {
  const values = input.candidateAllowlist ?? input.includeSlugs ?? input.include;
  if (!Array.isArray(values) || values.length === 0) {
    throw new CodexBootstrapError("BOOTSTRAP_ALLOWLIST_REQUIRED", "A positive candidate include allowlist is required.");
  }
  const selectors: NormalizedSelector[] = [];
  for (const value of values) {
    const record = typeof value === "string" ? undefined : value;
    const slug = typeof value === "string" ? value : record?.slug;
    const rawSourceType = typeof value === "string" ? undefined : (record?.sourceType as unknown);
    const sourceType = rawSourceType as CodexBootstrapSourceType | undefined;
    if (typeof slug !== "string" || slug.length > 64 || slug.includes("--") || !SAFE_SLUG_PATTERN.test(slug) || slug === "all" || slug === "*" || rawSourceType === "personal" || rawSourceType === "unclassified") {
      throw new CodexBootstrapError("BOOTSTRAP_ALLOWLIST_INVALID", "The candidate include allowlist contains an invalid or disallowed entry.");
    }
    if (rawSourceType !== undefined && (typeof rawSourceType !== "string" || !SOURCE_TYPES.includes(rawSourceType as CodexBootstrapSourceType))) {
      throw new CodexBootstrapError("BOOTSTRAP_ALLOWLIST_INVALID", "The candidate include allowlist contains an invalid source type.");
    }
    selectors.push({ slug, ...(sourceType ? { sourceType } : {}) });
  }
  return selectors.sort(compareSelector);
}

function rejectResolvedSelectorDuplicates(selectors: NormalizedSelector[], paths: NormalizedPaths): NormalizedSelector[] {
  const seen = new Set<string>();
  const seenBySlug = new Map<string, Set<string>>();
  for (const selector of selectors) {
    const sourceTypes = seenBySlug.get(selector.slug) ?? new Set<string>();
    const selectorType = selector.sourceType ?? "";
    if (sourceTypes.has(selectorType) || (selectorType === "" && sourceTypes.size > 0) || (selectorType !== "" && sourceTypes.has(""))) {
      throw new CodexBootstrapError("BOOTSTRAP_ALLOWLIST_DUPLICATE", "The candidate include allowlist contains duplicate resolved selectors.");
    }
    sourceTypes.add(selectorType);
    seenBySlug.set(selector.slug, sourceTypes);
    const roots = paths.sourceRoots.filter((source) => selector.sourceType === undefined || source.type === selector.sourceType);
    if (roots.length !== 1) continue;
    const source = roots[0];
    const key = `${source.type}\0${source.realRoot}\0${selector.slug}`;
    if (seen.has(key)) {
      throw new CodexBootstrapError("BOOTSTRAP_ALLOWLIST_DUPLICATE", "The candidate include allowlist contains duplicate resolved selectors.");
    }
    seen.add(key);
  }
  return selectors;
}

function compareSelector(left: NormalizedSelector, right: NormalizedSelector): number {
  return compareOrdinal(left.slug, right.slug) || compareOrdinal(left.sourceType ?? "", right.sourceType ?? "");
}

function buildSelectorResults(
  selectors: NormalizedSelector[],
  selectedSources: SelectedSource[],
  candidates: CodexBootstrapCandidate[],
  exclusions: CodexBootstrapExclusion[],
): CodexBootstrapSelectorResult[] {
  return selectors.map((selector): CodexBootstrapSelectorResult => {
    const selected = selectedSources.find((source) => source.slug === selector.slug && (selector.sourceType === undefined || source.sourceType === selector.sourceType));
    const candidate = candidates.find((entry) => entry.slug === selector.slug && (selector.sourceType === undefined || entry.sourceType === selector.sourceType));
    const exclusion = exclusions.find((entry) => entry.slug === selector.slug && (selector.sourceType === undefined || entry.sourceType === selector.sourceType));
    if (exclusion) {
      return {
        selector,
        terminal: "excluded",
        reason: exclusion.reason,
      };
    }
    if (candidate) {
      return {
        selector,
        terminal: candidate.ready ? "ready" : "blocked",
        candidateIdentity: candidate.candidateIdentity,
        executionIdentity: candidate.executionIdentity,
        targetObservation: candidate.targetObservation,
        ...(!candidate.ready ? { reason: "CANDIDATE_NOT_READY" } : {}),
      };
    }
    return {
      selector,
      terminal: selected ? "blocked" : "excluded",
      reason: selected ? "CANDIDATE_NOT_PLANNED" : "CANDIDATE_NOT_RESOLVED",
    };
  }).sort((left, right) => compareSelector(left.selector, right.selector));
}

function normalizeContext(input: {
  context?: Partial<CodexBootstrapContext>;
  profile?: string;
  targetOrigin?: string;
  targetInstanceId?: string;
  instanceId?: string;
  tenantId?: string;
  workspaceId?: string;
  actorId?: string;
  sourceTrustCompartment?: string;
  targetTrustCompartment?: string;
  allowLoopbackHttp?: boolean;
}, paths: NormalizedPaths): NormalizedContext {
  if (!input.context || !isRecord(input.context)) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_REQUIRED", "An explicit work context is required.");
  }
  const context = input.context;
  if (input.profile !== undefined && context.profile !== undefined && input.profile !== context.profile) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work profile context is inconsistent.");
  }
  const profile = input.profile ?? context.profile;
  if (profile !== "work") {
    throw new CodexBootstrapError("BOOTSTRAP_WORK_CONTEXT_REQUIRED", "An explicit work profile and context are required.");
  }
  const normalizedInputOrigin = input.targetOrigin === undefined ? undefined : normalizeTargetOrigin(input.targetOrigin, input.allowLoopbackHttp === true);
  const normalizedContextOrigin = context.targetOrigin === undefined ? undefined : normalizeTargetOrigin(context.targetOrigin, input.allowLoopbackHttp === true);
  if (normalizedInputOrigin !== undefined && normalizedContextOrigin !== undefined && normalizedInputOrigin !== normalizedContextOrigin) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work target context is inconsistent.");
  }
  const targetOrigin = normalizedInputOrigin ?? normalizedContextOrigin;
  const explicitInstanceId = coalesceContextValue(input.targetInstanceId, input.instanceId);
  const instanceId = coalesceContextValue(explicitInstanceId, context.instanceId);
  const tenantId = coalesceContextValue(input.tenantId, context.tenantId);
  const workspaceId = coalesceContextValue(input.workspaceId, context.workspaceId);
  const tenantOrWorkspaceId = resolveOneContextId(tenantId, workspaceId);
  const actorId = coalesceContextValue(input.actorId, context.actorId);
  const sourceTrustCompartment = coalesceContextValue(input.sourceTrustCompartment, context.sourceTrustCompartment);
  const targetTrustCompartment = coalesceContextValue(input.targetTrustCompartment, context.targetTrustCompartment);
  if (!targetOrigin) {
    throw new CodexBootstrapError("BOOTSTRAP_TARGET_ORIGIN_REQUIRED", "A target origin is required in the work context.");
  }
  if (!isSafeIdentifier(instanceId) || !isSafeIdentifier(tenantOrWorkspaceId) || !isSafeIdentifier(actorId)) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work target context must declare stable instance, workspace, and actor identifiers.");
  }
  if (!isExactSourceTrustCompartment(sourceTrustCompartment) || !isExactTargetTrustCompartment(targetTrustCompartment)) {
    throw new CodexBootstrapError("BOOTSTRAP_TRUST_COMPARTMENT_INVALID", "Explicit source and target trust compartments are required.");
  }
  const approvedSourceRoots = normalizeApprovedSourceRoots(context.approvedSourceRoots);
  const expectedSourceRoots = paths.sourceRoots
    .map((source) => ({ type: source.type, identityDigest: paths.sourceRootIdentityDigests[source.type] }))
    .filter((binding, index, values) => values.findIndex((other) => other.type === binding.type) === index)
    .sort(compareSourceRootBinding);
  if (canonicalJson(approvedSourceRoots) !== canonicalJson(expectedSourceRoots)) {
    throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_BINDING_INVALID", "The work context does not approve the selected source roots.");
  }
  if (context.approvedTargetRootIdentityDigest !== paths.targetRootIdentityDigest) {
    throw new CodexBootstrapError("BOOTSTRAP_TARGET_ROOT_BINDING_INVALID", "The work context does not approve the selected target root.");
  }
  const expectedSourceTrust = expectedSourceTrustCompartment(paths);
  if (sourceTrustCompartment !== expectedSourceTrust || targetTrustCompartment !== "work-team") {
    throw new CodexBootstrapError("BOOTSTRAP_TRUST_COMPARTMENT_INVALID", "The work context trust compartments are not canonical for this target.");
  }
  return {
    profile: "work",
    targetOrigin,
    instanceId: instanceId as string,
    tenantOrWorkspaceId: tenantOrWorkspaceId as string,
    actorId: actorId as string,
    sourceTrustCompartment,
    targetTrustCompartment,
    approvedSourceRoots,
    approvedTargetRootIdentityDigest: context.approvedTargetRootIdentityDigest,
  };
}

function coalesceContextValue<T>(explicit: T | undefined, contextual: T | undefined): T | undefined {
  if (explicit !== undefined && contextual !== undefined && explicit !== contextual) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The work target context is inconsistent.");
  }
  return explicit ?? contextual;
}

function resolveOneContextId(tenantId: unknown, workspaceId: unknown): string | undefined {
  if (tenantId !== undefined && workspaceId !== undefined && tenantId !== workspaceId) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTEXT_INVALID", "The tenant and workspace context identifiers must agree when both are supplied.");
  }
  return typeof tenantId === "string" ? tenantId : typeof workspaceId === "string" ? workspaceId : undefined;
}

function normalizeApprovedSourceRoots(value: unknown): Array<{ type: CodexBootstrapSourceType; identityDigest: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_BINDING_INVALID", "The work context must approve each selected source root.");
  }
  const bindings: Array<{ type: CodexBootstrapSourceType; identityDigest: string }> = [];
  for (const binding of value) {
    if (!isRecord(binding) || !SOURCE_TYPES.includes(binding.type as CodexBootstrapSourceType) || !isSha256(binding.identityDigest)) {
      throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_BINDING_INVALID", "The work context source-root approvals are invalid.");
    }
    bindings.push({ type: binding.type as CodexBootstrapSourceType, identityDigest: binding.identityDigest as string });
  }
  const sorted = [...bindings].sort(compareSourceRootBinding);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.type === sorted[index]?.type) {
      throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_BINDING_INVALID", "The work context source-root approvals contain duplicates.");
    }
  }
  return sorted;
}

function expectedSourceTrustCompartment(paths: NormalizedPaths): CodexBootstrapSourceTrustCompartment {
  const types = new Set(paths.sourceRoots.map((source) => source.type));
  const value = SOURCE_TYPES.filter((type) => types.has(type)).join("+");
  if (!SOURCE_TRUST_COMPARTMENTS.includes(value as CodexBootstrapSourceTrustCompartment)) {
    throw new CodexBootstrapError("BOOTSTRAP_TRUST_COMPARTMENT_INVALID", "The configured source roots do not form a canonical work trust compartment.");
  }
  return value as CodexBootstrapSourceTrustCompartment;
}

function isExactSourceTrustCompartment(value: unknown): value is CodexBootstrapSourceTrustCompartment {
  return typeof value === "string" && SOURCE_TRUST_COMPARTMENTS.includes(value as CodexBootstrapSourceTrustCompartment);
}

function isExactTargetTrustCompartment(value: unknown): value is CodexBootstrapTargetTrustCompartment {
  return typeof value === "string" && TARGET_TRUST_COMPARTMENTS.includes(value as CodexBootstrapTargetTrustCompartment);
}

function compareSourceRootBinding(
  left: { type: CodexBootstrapSourceType; identityDigest: string },
  right: { type: CodexBootstrapSourceType; identityDigest: string },
): number {
  return compareOrdinal(left.type, right.type) || compareOrdinal(left.identityDigest, right.identityDigest);
}

function normalizeTargetOrigin(value: unknown, allowLoopbackHttp: boolean): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexBootstrapError("BOOTSTRAP_TARGET_ORIGIN_REQUIRED", "A target origin is required in the work context.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CodexBootstrapError("BOOTSTRAP_TARGET_ORIGIN_INVALID", "The target origin is invalid.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new CodexBootstrapError("BOOTSTRAP_TARGET_ORIGIN_INVALID", "The target origin must not contain credentials, paths, queries, or fragments.");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowLoopbackHttp && isLoopbackHost(url.hostname)) return url.origin;
  throw new CodexBootstrapError("BOOTSTRAP_TARGET_ORIGIN_UNSAFE", "The target origin must use HTTPS.");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeContractVersions(input: {
  contractVersions?: CodexBootstrapContractVersions;
  plannerVersion?: string;
  scannerVersion?: string;
  manifestVersion?: string;
}): { planner: string; scanner: string; manifest: string } {
  const requested = {
    planner: input.plannerVersion ?? input.contractVersions?.planner ?? CODEX_BOOTSTRAP_CONTRACT_VERSIONS.planner,
    scanner: input.scannerVersion ?? input.contractVersions?.scanner ?? CODEX_BOOTSTRAP_CONTRACT_VERSIONS.scanner,
    manifest: input.manifestVersion ?? input.contractVersions?.manifest ?? CODEX_BOOTSTRAP_CONTRACT_VERSIONS.manifest,
  };
  if (![requested.planner, requested.scanner, requested.manifest].every(isSafeContractIdentifier)) {
    throw new CodexBootstrapError("BOOTSTRAP_CONTRACT_INVALID", "The planner, scanner, and manifest contracts are invalid.");
  }
  return requested;
}

function staleContractCodes(versions: { planner: string; scanner: string; manifest: string }): string[] {
  return [
    ...(versions.planner !== CODEX_BOOTSTRAP_CONTRACT_VERSIONS.planner ? ["STALE_PLANNER_CONTRACT"] : []),
    ...(versions.scanner !== CODEX_BOOTSTRAP_CONTRACT_VERSIONS.scanner ? ["STALE_SCANNER_CONTRACT"] : []),
    ...(versions.manifest !== CODEX_BOOTSTRAP_CONTRACT_VERSIONS.manifest ? ["STALE_MANIFEST_CONTRACT"] : []),
  ].sort(compareOrdinal);
}

async function normalizePaths(input: CodexBootstrapPaths): Promise<NormalizedPaths> {
  if (!input || typeof input !== "object" || !isAbsolutePath(input.liveSkillsRoot)) {
    throw new CodexBootstrapError("BOOTSTRAP_ROOT_INVALID", "The target root must be an absolute directory.");
  }
  const sourceRoots = rawSourceRoots(input);
  if (sourceRoots.length === 0) {
    throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_REQUIRED", "At least one typed work or shared source root is required.");
  }
  const liveSkillsRoot = path.resolve(input.liveSkillsRoot);
  const realLiveRoot = await existingDirectoryRealpath(liveSkillsRoot, "BOOTSTRAP_ROOT_INVALID");
  const normalizedSourceRoots: NormalizedPaths["sourceRoots"] = [];
  for (const source of sourceRoots) {
    if (!SOURCE_TYPES.includes(source.type as CodexBootstrapSourceType) || !isAbsolutePath(source.root)) {
      throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_INVALID", "Every source root must be an absolute, typed work or shared directory.");
    }
    const root = path.resolve(source.root);
    const realRoot = await existingDirectoryRealpath(root, "BOOTSTRAP_SOURCE_ROOT_INVALID");
    if (pathsOverlap(realRoot, realLiveRoot) || normalizedSourceRoots.some((existing) => pathsOverlap(existing.realRoot, realRoot))) {
      throw new CodexBootstrapError("BOOTSTRAP_ROOT_OVERLAP", "Source and target roots must be separate trust compartments.");
    }
    normalizedSourceRoots.push({ type: source.type as CodexBootstrapSourceType, root, realRoot });
  }
  const requestedReportPath = await resolveReportPath(input);
  const reportParent = await secureReportParent(path.dirname(requestedReportPath));
  const reportPath = path.join(reportParent, path.basename(requestedReportPath));
  if (isContained(realLiveRoot, reportParent) || normalizedSourceRoots.some((source) => isContained(source.realRoot, reportParent))) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_UNSAFE", "The report location must be outside source and target roots.");
  }
  await ensureReportDestinationNew(reportPath);
  const sourceRootIdentityDigests = {
    work: rootIdentityFor(normalizedSourceRoots.filter((source) => source.type === "work").map((source) => source.realRoot)),
    shared: rootIdentityFor(normalizedSourceRoots.filter((source) => source.type === "shared").map((source) => source.realRoot)),
  } satisfies Record<CodexBootstrapSourceType, string>;
  const targetRootIdentityDigest = rootIdentityFor(realLiveRoot);
  const rootIdentityDigest = sha256(canonicalJson({ sourceRootIdentityDigests, targetRootIdentityDigest }));
  return {
    liveSkillsRoot,
    reportPath,
    reportParent,
    reportParentIdentity: directoryIdentity(await lstat(reportParent, { bigint: true })),
    sourceRoots: normalizedSourceRoots,
    realLiveRoot,
    rootIdentityDigest,
    sourceRootIdentityDigests,
    targetRootIdentityDigest,
  };
}

function rawSourceRoots(input: CodexBootstrapPaths): CodexBootstrapSourceRoot[] {
  const roots: CodexBootstrapSourceRoot[] = [];
  if (input.sourceRoots !== undefined) {
    if (!Array.isArray(input.sourceRoots)) {
      throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_INVALID", "Source roots must be a typed list.");
    }
    for (const source of input.sourceRoots) {
      if (!isRecord(source) || typeof source.root !== "string") {
        throw new CodexBootstrapError("BOOTSTRAP_SOURCE_ROOT_INVALID", "Source roots must be a typed list.");
      }
      roots.push({ type: source.type, root: source.root });
    }
  }
  if (input.workSourceRoot !== undefined) roots.push({ type: "work", root: input.workSourceRoot });
  if (input.sharedSourceRoot !== undefined) roots.push({ type: "shared", root: input.sharedSourceRoot });
  const unique = new Map<string, CodexBootstrapSourceRoot>();
  for (const source of roots) {
    const normalizedRoot = typeof source.root === "string" ? path.resolve(source.root) : String(source.root);
    unique.set(`${String(source.type)}\0${normalizedRoot}`, source);
  }
  return [...unique.values()];
}

async function resolveReportPath(input: CodexBootstrapPaths): Promise<string> {
  const requested = input.reportPath ?? input.outputRoot;
  if (!isAbsolutePath(requested)) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_REQUIRED", "An absolute report path is required.");
  }
  const absolute = path.resolve(requested);
  let requestedStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    requestedStat = await lstat(absolute);
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_INVALID", "The report location is unavailable.");
  }
  if (requestedStat?.isSymbolicLink()) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_UNSAFE", "The report location must not be a symlink.");
  }
  if (requestedStat?.isDirectory() || requested.endsWith(path.sep)) return path.join(absolute, "dry-run-report.json");
  if (requestedStat && !requestedStat.isFile()) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_INVALID", "The report location must be a regular file.");
  }
  return absolute;
}

async function secureReportParent(parentPath: string): Promise<string> {
  const lexicalParent = path.resolve(parentPath);
  const realParent = await existingDirectoryRealpath(lexicalParent, "BOOTSTRAP_OUTPUT_INVALID");
  let parentStats: BigIntStats;
  try {
    parentStats = await stat(realParent, { bigint: true });
  } catch {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_INVALID", "The report parent is unavailable or unsafe.");
  }
  if (!parentStats.isDirectory() || (parentStats.mode & 0o077n) !== 0n) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_UNSAFE", "The report parent must be a private directory.");
  }
  const processUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (processUid !== undefined && parentStats.uid !== processUid) {
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_UNSAFE", "The report parent must be controlled by the current user.");
  }
  return realParent;
}

async function existingDirectoryRealpath(directory: string, code: string): Promise<string> {
  try {
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("not a directory");
    return await realpath(directory);
  } catch {
    throw new CodexBootstrapError(code, "A required local directory is unavailable or unsafe.");
  }
}

async function ensureReportDestinationNew(reportPath: string): Promise<void> {
  try {
    const entry = await lstat(reportPath);
    if (entry) throw new Error("report already exists");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw new CodexBootstrapError("BOOTSTRAP_OUTPUT_EXISTS", "The requested report destination must be new.");
  }
}

async function selectSources(
  paths: NormalizedPaths,
  selectors: NormalizedSelector[],
  exclusions: CodexBootstrapExclusion[],
): Promise<SelectedSource[]> {
  const selected: SelectedSource[] = [];
  for (const selector of selectors) {
    const roots = paths.sourceRoots.filter((source) => selector.sourceType === undefined || source.type === selector.sourceType);
    const matches: SelectedSource[] = [];
    for (const source of roots) {
      const sourceDir = path.join(source.realRoot, selector.slug);
      try {
        const entry = await lstat(sourceDir);
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const realSourceDir = await realpath(sourceDir);
        if (!isContained(source.realRoot, realSourceDir)) throw new Error("source path escape");
        const liveDir = path.join(paths.realLiveRoot, selector.slug);
        matches.push({
          slug: selector.slug,
          sourceType: source.type,
          sourceRoot: source.realRoot,
          sourceDir: realSourceDir,
          liveDir,
          liveRoot: paths.realLiveRoot,
          sourceRootIdentityDigest: paths.sourceRootIdentityDigests[source.type],
        });
      } catch {
        // Missing or unsafe candidates are represented in the private report.
      }
    }
    if (matches.length !== 1) {
      exclusions.push({
        slug: selector.slug,
        ...(selector.sourceType ? { sourceType: selector.sourceType } : {}),
        reason: matches.length === 0 ? "CANDIDATE_NOT_FOUND" : "CANDIDATE_SOURCE_AMBIGUOUS",
      });
      continue;
    }
    selected.push(matches[0]);
  }
  return selected;
}

async function planCandidate(
  source: SelectedSource,
  staleContracts: string[],
  requestedContracts: { planner: string; scanner: string; manifest: string },
  context: NormalizedContext,
  paths: NormalizedPaths,
  exclusions: CodexBootstrapExclusion[],
  testHooks?: CodexBootstrapTestHooks,
): Promise<CodexBootstrapCandidate | null> {
  // Capture target presence before reading source content. An absent target
  // is a held observation with a parent identity, not an assumption that can
  // remain valid without revalidation.
  let targetObservation: BootstrapTargetObservation;
  try {
    const liveEntry = await lstat(source.liveDir);
    if (liveEntry.isSymbolicLink() || !liveEntry.isDirectory()) throw new Error("live candidate unavailable");
    targetObservation = { kind: "present", liveDir: source.liveDir, liveRoot: source.liveRoot };
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "TARGET_UNAVAILABLE" });
      return null;
    }
    try {
      targetObservation = {
        kind: "absent",
        absence: await captureTargetAbsence(source.liveDir, source.liveRoot),
      };
    } catch {
      exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "TARGET_UNAVAILABLE" });
      return null;
    }
  }

  let sourceSnapshot: BootstrapSnapshot;
  try {
    sourceSnapshot = await readBootstrapSnapshot(source.sourceDir, source.sourceRoot, testHooks);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "SOURCE_UNAVAILABLE" });
    return null;
  }

  let targetObservationSummary: CodexBootstrapCandidate["targetObservation"];
  if (targetObservation.kind === "present") {
    try {
      const liveReal = await realpath(targetObservation.liveDir);
      if (!isContained(source.liveRoot, liveReal)) throw new Error("live path escape");
      const liveSnapshot = await readBootstrapSnapshot(liveReal, source.liveRoot, testHooks);
      const sourceArtifact = snapshotArtifactIdentity(sourceSnapshot);
      const liveArtifact = snapshotArtifactIdentity(liveSnapshot);
      if (sourceArtifact.sha256 !== liveArtifact.sha256 || sourceArtifact.byteSize !== liveArtifact.byteSize) {
        exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "SOURCE_TARGET_MISMATCH" });
        return null;
      }
      targetObservation = { ...targetObservation, snapshot: liveSnapshot };
      targetObservationSummary = { state: "present-identical", expectedArtifact: liveArtifact };
    } catch {
      exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "TARGET_UNAVAILABLE" });
      return null;
    }
  } else {
    targetObservationSummary = { state: "absent", expectedArtifact: null };
  }

  try {
    await revalidateBootstrapSnapshot(sourceSnapshot);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "SOURCE_UNAVAILABLE" });
    return null;
  }
  try {
    await revalidateTargetObservation(targetObservation);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "TARGET_UNAVAILABLE" });
    return null;
  }

  let manifestResult: BootstrapManifestResult;
  try {
    manifestResult = ensureBootstrapManifest(sourceSnapshot, source.slug, source.sourceType);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "MANIFEST_INVALID" });
    return null;
  }
  const snapshot = manifestResult.snapshot;
  const packageFiles = snapshotToPackageFiles(snapshot);
  let scan;
  try {
    scan = scanPackageFiles(packageFiles);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "PACKAGE_SCAN_FAILED" });
    return null;
  }
  const findings = scan.findings.map((finding) => safeFinding(finding));
  const findingCounts = findings.reduce<Record<string, number>>((counts, finding) => {
    const key = `${finding.severity}:${finding.category}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  // This is the dry-run observation boundary only. A future executor must
  // revalidate these retained identities immediately before its first write
  // (CAS) and require explicit content review; this planner has no write path.
  try {
    await revalidateBootstrapSnapshot(sourceSnapshot);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "SOURCE_UNAVAILABLE" });
    return null;
  }
  try {
    await revalidateTargetObservation(targetObservation);
  } catch {
    exclusions.push({ slug: source.slug, sourceType: source.sourceType, reason: "TARGET_UNAVAILABLE" });
    return null;
  }

  const artifact = snapshotArtifactIdentity(snapshot);
  const contentIdentity = sha256(canonicalJson({
    slug: source.slug,
    sourceType: source.sourceType,
    artifact,
    version: manifestResult.manifest.version,
    manifestDecision: manifestResult.decision,
    manifestPath: manifestResult.path,
    findingCounts,
  }));
  const executionIdentity = sha256(canonicalJson({
    schemaVersion: CODEX_BOOTSTRAP_REPORT_SCHEMA,
    target: {
      profile: context.profile,
      targetOrigin: context.targetOrigin,
      instanceId: context.instanceId,
      tenantOrWorkspaceId: context.tenantOrWorkspaceId,
      actorId: context.actorId,
      sourceTrustCompartment: context.sourceTrustCompartment,
      targetTrustCompartment: context.targetTrustCompartment,
    },
    sourceRoot: {
      type: source.sourceType,
      identityDigest: source.sourceRootIdentityDigest,
    },
    targetRootIdentityDigest: paths.targetRootIdentityDigest,
    contracts: {
      owned: CODEX_BOOTSTRAP_CONTRACT_VERSIONS,
      requested: requestedContracts,
    },
    contentIdentity,
    targetObservation: targetObservationSummary,
  }));
  return {
    slug: source.slug,
    sourceType: source.sourceType,
    ownership: source.sourceType,
    candidateIdentity: contentIdentity,
    contentIdentity,
    executionIdentity,
    visibility: manifestResult.manifest.visibility === "team" ? "team" : "private",
    version: manifestResult.manifest.version,
    manifestDecision: manifestResult.decision,
    manifestPath: manifestResult.path,
    manifestSummaryTruncated: manifestResult.summaryTruncated,
    filesScanned: snapshot.files.length,
    bytesScanned: snapshot.totalBytes,
    artifact,
    targetObservation: targetObservationSummary,
    ready: findings.length === 0 && staleContracts.length === 0,
    findingCounts,
    findings,
    snapshot: packageFiles,
  };
}

function ensureBootstrapManifest(snapshot: BootstrapSnapshot, slug: string, sourceType: CodexBootstrapSourceType): BootstrapManifestResult {
  const rootManifests = snapshot.files.filter((file) => DEFAULT_MANIFEST_NAMES.includes(file.path as (typeof DEFAULT_MANIFEST_NAMES)[number]));
  if (rootManifests.length > 1) throw new Error("multiple reserved manifests");
  if (rootManifests.length === 1) {
    const file = rootManifests[0];
    let manifest: SkillManifest;
    try {
      manifest = parseSkillManifest(JSON.parse(file.content));
    } catch {
      throw new Error("reserved manifest invalid");
    }
    if (manifest.name !== slug || !["private", "team"].includes(manifest.visibility) || !hasSupportedCodexPlatform(manifest)) {
      throw new Error("reserved manifest binding invalid");
    }
    return {
      snapshot,
      manifest,
      decision: "reused",
      path: file.path,
      summaryTruncated: false,
    };
  }
  const sourceDigest = snapshotArtifactIdentity(snapshot);
  const skillText = snapshot.files.find((file) => file.path === "SKILL.md")?.content;
  const frontmatter = skillText ? parseSkillFrontmatter(skillText) : undefined;
  const description = frontmatter?.description ?? null;
  const name = frontmatter?.name ?? null;
  if (name !== slug || !description) throw new Error("frontmatter invalid");
  const summary = boundedSummary(description);
  const manifest = parseSkillManifest({
    name: slug,
    title: titleFromSlug(slug),
    summary: summary.value,
    version: `0.0.0-bootstrap.${sourceDigest.sha256.slice(0, 12)}`,
    license: "UNLICENSED",
    visibility: sourceType === "shared" ? "team" : "private",
    platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }],
    tags: [],
  });
  const manifestFile = snapshotFile("skill.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return {
    // The generated manifest is in-memory only, so retain the identities of
    // the source files rather than pretending that skill.json was read from
    // disk.
    snapshot: immutableSnapshot([...snapshot.files, manifestFile], snapshot.identity),
    manifest,
    decision: "generated-skill-json",
    path: "skill.json",
    summaryTruncated: summary.truncated,
  };
}

function safeFinding(finding: ScanFinding): CodexBootstrapFinding {
  return { category: finding.category, severity: finding.severity, ...(finding.path ? { path: finding.path } : {}) };
}

async function captureTargetAbsence(targetPath: string, boundaryRoot: string): Promise<BootstrapTargetAbsence> {
  const absoluteTargetPath = path.resolve(targetPath);
  const parentPath = path.dirname(absoluteTargetPath);
  const parentStats = await lstat(parentPath, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new Error("target absence parent is not regular");
  const parentRealPath = await realpath(parentPath);
  if (parentRealPath !== parentPath || !isContained(boundaryRoot, parentRealPath)) throw new Error("target absence parent escapes boundary");
  try {
    await lstat(absoluteTargetPath, { bigint: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return {
        targetPath: absoluteTargetPath,
        boundaryRoot: path.resolve(boundaryRoot),
        parentPath,
        parentRealPath,
        parentStats,
      };
    }
    throw error;
  }
  throw new Error("target is present");
}

async function revalidateTargetObservation(observation: BootstrapTargetObservation): Promise<void> {
  if (observation.kind === "present") {
    if (!observation.snapshot) throw new Error("target snapshot is incomplete");
    await revalidateBootstrapSnapshot(observation.snapshot);
    return;
  }
  await revalidateTargetAbsence(observation.absence);
}

async function revalidateTargetAbsence(absence: BootstrapTargetAbsence): Promise<void> {
  const parentStats = await lstat(absence.parentPath, { bigint: true });
  const parentRealPath = await realpath(absence.parentPath);
  if (
    parentStats.isSymbolicLink()
    || !parentStats.isDirectory()
    || !sameDirectoryIdentity(absence.parentStats, parentStats)
    || parentRealPath !== absence.parentRealPath
    || !isContained(absence.boundaryRoot, parentRealPath)
  ) {
    throw new Error("target absence parent changed");
  }
  try {
    await lstat(absence.targetPath, { bigint: true });
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error("target appeared after absence observation");
}

async function readBootstrapSnapshot(
  rootPath: string,
  boundaryRoot: string,
  testHooks?: CodexBootstrapTestHooks,
): Promise<BootstrapSnapshot> {
  if (typeof NO_FOLLOW_FLAG !== "number" || NO_FOLLOW_FLAG === 0 || typeof DIRECTORY_FLAG !== "number" || DIRECTORY_FLAG === 0) {
    throw new Error("secure filesystem flags unavailable");
  }
  const absoluteRoot = path.resolve(rootPath);
  const absoluteBoundaryRoot = path.resolve(boundaryRoot);
  const state: SnapshotReadState = { directories: [], files: [], identities: [], totalBytes: 0 };
  await readBootstrapDirectory(absoluteRoot, absoluteBoundaryRoot, "", state, testHooks);
  if (!state.rootPath || !state.rootRealPath || !state.rootStats || state.directories.length === 0 || state.files.length !== state.identities.length) {
    throw new Error("snapshot identity ledger is incomplete");
  }
  const snapshot = immutableSnapshot(state.files, {
    rootPath: state.rootPath,
    boundaryRoot: absoluteBoundaryRoot,
    rootRealPath: state.rootRealPath,
    rootStats: state.rootStats,
    directories: state.directories,
    files: state.identities,
  });
  // Revalidate once after the complete traversal. Directory metadata does not
  // change for an in-place file edit, so every retained file identity matters.
  await revalidateBootstrapSnapshot(snapshot);
  return snapshot;
}

interface SnapshotReadState {
  directories: BootstrapDirectoryIdentity[];
  files: BootstrapSnapshotFile[];
  identities: BootstrapFileIdentity[];
  totalBytes: number;
  rootPath?: string;
  rootRealPath?: string;
  rootStats?: BigIntStats;
}

async function readBootstrapDirectory(
  directoryPath: string,
  boundaryRoot: string,
  relativePrefix: string,
  state: SnapshotReadState,
  testHooks?: CodexBootstrapTestHooks,
): Promise<void> {
  const directoryHandle = await open(directoryPath, fsConstants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW_FLAG);
  try {
    const opened = await directoryHandle.stat({ bigint: true });
    const openedPath = await lstat(directoryPath, { bigint: true });
    const openedReal = await realpath(directoryPath);
    if (
      !opened.isDirectory()
      || openedPath.isSymbolicLink()
      || !openedPath.isDirectory()
      || !sameDirectoryIdentity(opened, openedPath)
    ) {
      throw new Error("snapshot directory changed before read");
    }
    if (!isContained(boundaryRoot, openedReal)) throw new Error("snapshot directory escapes boundary");
    state.directories.push({
      relativePath: relativePrefix,
      absolutePath: directoryPath,
      realPath: openedReal,
      stats: opened,
    });
    if (relativePrefix === "") {
      state.rootPath = directoryPath;
      state.rootRealPath = openedReal;
      state.rootStats = opened;
    }
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("snapshot symlink is not allowed");
      if (isSensitiveSnapshotPath(relativePath)) throw new Error("snapshot sensitive path is not allowed");
      if (entry.isDirectory()) {
        await readBootstrapDirectory(entryPath, boundaryRoot, relativePath, state, testHooks);
      } else if (entry.isFile()) {
        if (state.files.length >= MAX_PACKAGE_FILES) throw new Error("snapshot file count exceeded");
        const readResult = await readBootstrapFile(entryPath, boundaryRoot, relativePath, MAX_PACKAGE_TEXT_BYTES - state.totalBytes, testHooks);
        state.files.push(readResult.file);
        state.identities.push(readResult.identity);
        state.totalBytes += readResult.file.bytes.byteLength;
      } else {
        throw new Error("snapshot special file is not allowed");
      }
    }
    const afterHandle = await directoryHandle.stat({ bigint: true });
    const afterPath = await lstat(directoryPath, { bigint: true });
    const afterReal = await realpath(directoryPath);
    if (
      !afterHandle.isDirectory()
      || afterPath.isSymbolicLink()
      || !afterPath.isDirectory()
      || !sameDirectoryIdentity(opened, afterHandle)
      || !sameDirectoryIdentity(opened, afterPath)
      || openedReal !== afterReal
      || !isContained(boundaryRoot, afterReal)
    ) {
      throw new Error("snapshot directory changed during read");
    }
  } finally {
    await directoryHandle.close();
  }
}

async function readBootstrapFile(
  filePath: string,
  boundaryRoot: string,
  relativePath: string,
  remainingBytes: number,
  testHooks?: CodexBootstrapTestHooks,
): Promise<BootstrapFileReadResult> {
  const fileHandle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW_FLAG);
  try {
    const opened = await fileHandle.stat({ bigint: true });
    const openedPath = await lstat(filePath, { bigint: true });
    const openedReal = await realpath(filePath);
    if (
      !opened.isFile()
      || opened.nlink !== 1n
      || openedPath.isSymbolicLink()
      || !openedPath.isFile()
      || openedPath.nlink !== 1n
      || !sameFileIdentity(opened, openedPath)
    ) {
      throw new Error("snapshot file changed before read");
    }
    if (!isContained(boundaryRoot, openedReal)) throw new Error("snapshot file escapes boundary");
    const openedSize = safeBigIntToNumber(opened.size);
    if (openedSize > remainingBytes) throw new Error("snapshot byte bound exceeded");
    const bytes = await readHandleBytes(fileHandle, openedSize);
    await testHooks?.afterSnapshotFileRead?.(relativePath);
    const afterHandle = await fileHandle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    const afterReal = await realpath(filePath);
    if (
      !afterHandle.isFile()
      || afterHandle.nlink !== 1n
      || afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.nlink !== 1n
      || !sameFileIdentity(opened, afterHandle)
      || !sameFileIdentity(opened, afterPath)
      || openedReal !== afterReal
      || !isContained(boundaryRoot, afterReal)
    ) {
      throw new Error("snapshot file changed during read");
    }
    return {
      file: snapshotFile(relativePath, bytes),
      identity: {
        relativePath,
        absolutePath: filePath,
        realPath: openedReal,
        stats: opened,
      },
    };
  } finally {
    await fileHandle.close();
  }
}

async function readHandleBytes(fileHandle: Awaited<ReturnType<typeof open>>, byteLength: number): Promise<Buffer> {
  const output = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const chunkLength = Math.min(SNAPSHOT_CHUNK_BYTES, byteLength - offset);
    const result = await fileHandle.read(output, offset, chunkLength, offset);
    if (result.bytesRead <= 0) throw new Error("snapshot file ended before fstat size");
    offset += result.bytesRead;
  }
  return output;
}

function snapshotFile(relativePath: string, bytes: Buffer): BootstrapSnapshotFile {
  const content = decodeSnapshotUtf8(bytes);
  return {
    path: relativePath,
    content,
    bytes: Buffer.from(bytes),
  };
}

function decodeSnapshotUtf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("snapshot file contains a NUL byte");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("snapshot file is not valid UTF-8");
  }
  const canonicalBytes = Buffer.from(content, "utf8");
  if (!canonicalBytes.equals(bytes)) throw new Error("snapshot UTF-8 bytes are not canonical");
  return content;
}

async function revalidateBootstrapSnapshot(snapshot: BootstrapSnapshot): Promise<void> {
  const identity = snapshot.identity;
  const rootStats = await lstat(identity.rootPath, { bigint: true });
  const rootRealPath = await realpath(identity.rootPath);
  if (
    rootStats.isSymbolicLink()
    || !rootStats.isDirectory()
    || !sameDirectoryIdentity(identity.rootStats, rootStats)
    || rootRealPath !== identity.rootRealPath
    || !isContained(identity.boundaryRoot, rootRealPath)
  ) {
    throw new Error("snapshot root changed");
  }
  for (const directory of identity.directories) {
    const directoryStats = await lstat(directory.absolutePath, { bigint: true });
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory() || !sameDirectoryIdentity(directory.stats, directoryStats)) {
      throw new Error("snapshot directory changed");
    }
    const directoryRealPath = await realpath(directory.absolutePath);
    if (directoryRealPath !== directory.realPath || !isContained(identity.boundaryRoot, directoryRealPath)) {
      throw new Error("snapshot directory path changed");
    }
  }
  for (const file of identity.files) {
    const fileStats = await lstat(file.absolutePath, { bigint: true });
    if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.nlink !== 1n || !sameFileIdentity(file.stats, fileStats)) {
      throw new Error("snapshot file changed");
    }
    const fileRealPath = await realpath(file.absolutePath);
    if (fileRealPath !== file.realPath || !isContained(identity.boundaryRoot, fileRealPath)) {
      throw new Error("snapshot file path changed");
    }
  }
}

function immutableSnapshot(files: readonly BootstrapSnapshotFile[], identity: BootstrapSnapshotIdentity): BootstrapSnapshot {
  const ordered = [...files]
    .map((file) => Object.freeze({ path: file.path, content: file.content, bytes: Buffer.from(file.bytes) }))
    .sort((left, right) => compareOrdinal(left.path, right.path));
  const identityDirectories = identity.directories.map((directory) => Object.freeze({ ...directory }));
  const identityFiles = identity.files.map((file) => Object.freeze({ ...file }));
  return Object.freeze({
    files: Object.freeze(ordered),
    totalBytes: ordered.reduce((total, file) => total + file.bytes.byteLength, 0),
    identity: Object.freeze({ ...identity, directories: Object.freeze(identityDirectories), files: Object.freeze(identityFiles) }),
  });
}

function snapshotToPackageFiles(snapshot: BootstrapSnapshot): PackageInputFile[] {
  return Object.freeze(snapshot.files.map((file) => Object.freeze({ path: file.path, content: file.content }))) as unknown as PackageInputFile[];
}

function snapshotArtifactIdentity(snapshot: BootstrapSnapshot): { sha256: string; byteSize: number } {
  const hash = createHash("sha256");
  for (const file of snapshot.files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const contentBytes = Buffer.from(file.content, "utf8");
    if (file.content.includes("\0") || !contentBytes.equals(file.bytes)) throw new Error("snapshot content bytes changed");
    hash.update(Buffer.from(`${pathBytes.byteLength}:`, "ascii"));
    hash.update(pathBytes);
    hash.update(Buffer.from(`${contentBytes.byteLength}:`, "ascii"));
    hash.update(contentBytes);
  }
  return { sha256: hash.digest("hex"), byteSize: snapshot.totalBytes };
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameNodeIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function directoryIdentity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.mode}`;
}

function safeBigIntToNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("snapshot size is invalid");
  return Number(value);
}

function rootIdentityFor(root: string | string[] | undefined): string {
  const roots = root === undefined ? [] : Array.isArray(root) ? root : [root];
  return roots.length > 0 ? sha256(canonicalJson([...roots].sort(compareOrdinal))) : "unconfigured";
}

function hasSupportedCodexPlatform(manifest: SkillManifest): boolean {
  return manifest.platforms.some((platform) => platform.name === "codex" && platform.install_target === "codex-skill" && platform.status === "supported");
}

function parseSkillFrontmatter(text: string): { name: string | null; description: string | null } {
  const firstDelimiter = text.indexOf("\n");
  if (firstDelimiter < 0 || text.slice(0, firstDelimiter).replace(/\r$/, "") !== "---") throw new Error("frontmatter opening delimiter missing");
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > MAX_FRONTMATTER_LINES) throw new Error("frontmatter line bound exceeded");
  const values = new Map<string, string | null>();
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) throw new Error("frontmatter closing delimiter missing");
  const frontmatterBytes = Buffer.byteLength(lines.slice(0, closingIndex + 1).join("\n"), "utf8");
  if (frontmatterBytes > MAX_FRONTMATTER_BYTES) throw new Error("frontmatter byte bound exceeded");
  for (let index = 1; index < closingIndex;) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      index += 1;
      continue;
    }
    if (/^[ \t]/u.test(line)) throw new Error("unexpected frontmatter indentation");
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]*(.*))?$/u);
    if (!match) throw new Error("frontmatter mapping is invalid");
    const key = match[1] as string;
    if (values.has(key)) throw new Error("duplicate frontmatter key");
    const rawValue = match[2] ?? "";
    const blockHeader = rawValue.trim().match(/^([>|][+-]?)(?:[ \t]+#.*)?$/u)?.[1];
    if (blockHeader) {
      const block = parseFrontmatterBlock(lines, index + 1, closingIndex, blockHeader);
      values.set(key, block.value);
      index = block.nextIndex;
      continue;
    }
    if (!rawValue.trim()) {
      values.set(key, null);
      index += 1;
      while (index < closingIndex && (lines[index] ?? "").trim() === "") index += 1;
      while (index < closingIndex && /^[ \t]/u.test(lines[index] ?? "")) index += 1;
      continue;
    }
    values.set(key, parseYamlScalar(rawValue));
    index += 1;
  }
  return { name: values.get("name") ?? null, description: values.get("description") ?? null };
}

function parseFrontmatterBlock(
  lines: string[],
  startIndex: number,
  closingIndex: number,
  header: string,
): { value: string; nextIndex: number } {
  const blockLines: string[] = [];
  let index = startIndex;
  while (index < closingIndex) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && !/^[ \t]/u.test(line)) break;
    blockLines.push(line);
    index += 1;
  }
  const nonEmptyIndent = blockLines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^[ ]*/u)?.[0].length ?? 0);
  const indent = nonEmptyIndent.length > 0 ? Math.min(...nonEmptyIndent) : 0;
  if (blockLines.some((line) => line.includes("\t"))) throw new Error("frontmatter block indentation is invalid");
  const contentLines = blockLines.map((line) => line.slice(Math.min(indent, line.length)));
  const rawValue = header.startsWith(">") ? foldYamlLines(contentLines) : contentLines.join("\n");
  const withTerminalBreak = blockLines.length > 0 ? `${rawValue}\n` : "";
  const chomp = header.slice(1);
  if (chomp === "-") return { value: withTerminalBreak.replace(/\n+$/u, ""), nextIndex: index };
  if (chomp === "+") return { value: withTerminalBreak, nextIndex: index };
  return { value: withTerminalBreak.replace(/\n+$/u, "") + (withTerminalBreak ? "\n" : ""), nextIndex: index };
}

function foldYamlLines(lines: string[]): string {
  let value = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    value += line;
    if (index < lines.length - 1) {
      const next = lines[index + 1] ?? "";
      value += line !== "" && next !== "" ? " " : "\n";
    }
  }
  return value;
}

function parseYamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("\"")) {
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        const suffix = value.slice(index + 1).trim();
        if (suffix && !suffix.startsWith("#")) throw new Error("quoted frontmatter scalar is invalid");
        const parsed = JSON.parse(value.slice(0, index + 1)) as unknown;
        if (typeof parsed !== "string") throw new Error("quoted frontmatter scalar is invalid");
        return parsed;
      }
    }
    throw new Error("quoted frontmatter scalar is invalid");
  }
  if (value.startsWith("'")) {
    for (let index = 1; index < value.length; index += 1) {
      if (value[index] !== "'") continue;
      if (value[index + 1] === "'") {
        index += 1;
        continue;
      }
      const suffix = value.slice(index + 1).trim();
      if (suffix && !suffix.startsWith("#")) throw new Error("quoted frontmatter scalar is invalid");
      return value.slice(1, index).replace(/''/gu, "'");
    }
    throw new Error("quoted frontmatter scalar is invalid");
  }
  return value.replace(/[ \t]+#.*$/u, "").trim() || null;
}

function boundedSummary(summary: string): { value: string; truncated: boolean } {
  if (summary.length <= 500) return { value: summary, truncated: false };
  return { value: `${summary.slice(0, 499).trimEnd()}…`, truncated: true };
}

function titleFromSlug(slug: string): string {
  return slug.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareOrdinal).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function compareOrdinal(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeTimestamp(value: string | undefined): string {
  const timestamp = value ?? new Date().toISOString();
  if (typeof timestamp !== "string" || timestamp.length === 0 || timestamp.length > MAX_TIMESTAMP_LENGTH || Number.isNaN(Date.parse(timestamp))) {
    throw new CodexBootstrapError("BOOTSTRAP_TIMESTAMP_INVALID", "The planner timestamp is invalid.");
  }
  return timestamp;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeContractIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function writePrivateReport(
  paths: NormalizedPaths,
  report: CodexBootstrapReport,
  testHooks?: CodexBootstrapTestHooks,
): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const serializedBytes = Buffer.from(serialized, "utf8");
  if (serializedBytes.byteLength > MAX_REPORT_BYTES) {
    throw new CodexBootstrapError("BOOTSTRAP_REPORT_WRITE_FAILED", "The private dry-run report is too large.");
  }
  if (typeof NO_FOLLOW_FLAG !== "number" || NO_FOLLOW_FLAG === 0) {
    throw new CodexBootstrapError("BOOTSTRAP_REPORT_WRITE_FAILED", "The private dry-run report cannot be opened securely.");
  }
  let reportHandle: Awaited<ReturnType<typeof open>> | undefined;
  let openedIdentity: BigIntStats | undefined;
  let failed = true;
  try {
    const parentBefore = await secureReportParentStats(paths.reportParent, paths.reportParentIdentity);
    await testHooks?.beforeReportOpen?.();
    // Revalidate the canonical parent after the last testable/pre-open race
    // window. The exclusive open below must never follow a replaced parent.
    await secureReportParentStats(paths.reportParent, paths.reportParentIdentity);
    reportHandle = await open(
      paths.reportPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW_FLAG,
      0o600,
    );
    openedIdentity = await reportHandle.stat({ bigint: true });
    if (!openedIdentity.isFile() || openedIdentity.nlink !== 1n || (openedIdentity.mode & 0o777n) !== 0o600n) throw new Error("report handle is unsafe");
    await testHooks?.afterReportOpen?.();
    await verifyReportPathBeforeWrite(paths, parentBefore, openedIdentity);
    await reportHandle.writeFile(serializedBytes);
    await reportHandle.sync();
    await verifyReportPathAfterWrite(paths, reportHandle, parentBefore, openedIdentity, serializedBytes.byteLength);
    const readBack = await readHandleBytes(reportHandle, serializedBytes.byteLength);
    if (!readBack.equals(serializedBytes)) throw new Error("report read-back mismatch");
    failed = false;
  } catch {
    throw new CodexBootstrapError("BOOTSTRAP_REPORT_WRITE_FAILED", "The private dry-run report could not be written.");
  } finally {
    if (reportHandle) {
      try {
        await reportHandle.close();
      } catch {
        // Preserve the stable report-write error below.
      }
    }
    if (failed) await cleanupReportDestination(paths.reportPath, openedIdentity);
  }
}

async function secureReportParentStats(parentPath: string, expectedIdentity: string): Promise<BigIntStats> {
  const parentStats = await stat(parentPath, { bigint: true });
  if (!parentStats.isDirectory() || directoryIdentity(parentStats) !== expectedIdentity || (parentStats.mode & 0o077n) !== 0n) {
    throw new Error("report parent changed");
  }
  const parentReal = await realpath(parentPath);
  if (parentReal !== parentPath) throw new Error("report parent is not canonical");
  const processUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  if (processUid !== undefined && parentStats.uid !== processUid) throw new Error("report parent ownership changed");
  return parentStats;
}

async function verifyReportPathBeforeWrite(paths: NormalizedPaths, parentBefore: BigIntStats, openedIdentity: BigIntStats): Promise<void> {
  const parentAfter = await secureReportParentStats(paths.reportParent, paths.reportParentIdentity);
  if (directoryIdentity(parentAfter) !== directoryIdentity(parentBefore)) throw new Error("report parent changed");
  const pathStats = await lstat(paths.reportPath, { bigint: true });
  if (pathStats.isSymbolicLink() || !sameNodeIdentity(openedIdentity, pathStats)) throw new Error("report path changed");
  const pathReal = await realpath(paths.reportPath);
  if (pathReal !== paths.reportPath || !isContained(paths.reportParent, pathReal)) throw new Error("report path escapes parent");
}

async function verifyReportPathAfterWrite(
  paths: NormalizedPaths,
  reportHandle: Awaited<ReturnType<typeof open>>,
  parentBefore: BigIntStats,
  openedIdentity: BigIntStats,
  expectedBytes: number,
): Promise<void> {
  await verifyReportPathBeforeWrite(paths, parentBefore, openedIdentity);
  const handleStats = await reportHandle.stat({ bigint: true });
  if (!handleStats.isFile() || handleStats.size !== BigInt(expectedBytes) || (handleStats.mode & 0o777n) !== 0o600n) throw new Error("report verification failed");
}

async function cleanupReportDestination(reportPath: string, openedIdentity: BigIntStats | undefined): Promise<void> {
  if (!openedIdentity) return;
  try {
    const parentPath = path.dirname(reportPath);
    const parentReal = await realpath(parentPath);
    const reportReal = await realpath(reportPath);
    // Cleanup is allowed only while the canonical parent and destination are
    // still the ones that were opened. Never follow a swapped symlink while
    // trying to remove a failed report.
    if (parentReal !== parentPath || reportReal !== reportPath) return;
    const current = await lstat(reportPath, { bigint: true });
    if (!current.isSymbolicLink() && current.isFile() && sameNodeIdentity(openedIdentity, current)) await unlink(reportPath);
  } catch {
    // Never follow or remove an unrelated path while cleaning up a failed write.
  }
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) && !value.includes("\0");
}

function isSensitiveSnapshotPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return SENSITIVE_DIRECTORY_PATH_PATTERN.test(relativePath) || segments.some((segment, index) => (
    SENSITIVE_FILE_NAME_PATTERN.test(segment)
    || (index < segments.length - 1 && SENSITIVE_DIRECTORY_NAME_PATTERN.test(segment))
  ));
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}
