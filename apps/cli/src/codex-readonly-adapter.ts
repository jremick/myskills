import { constants as fsConstants } from "node:fs";
import { open, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetLimits,
  architectureTargetObservationDigest,
  assertValidArchitectureTargetAdapterContext,
  assertValidArchitectureTargetObservation,
  type ArchitectureTargetAdapterContext,
  type ArchitectureTargetConfigFinding,
  type ArchitectureTargetHealth,
  type ArchitectureTargetMetadata,
  type ArchitectureTargetObservedSkill,
  type ArchitectureTargetObservation,
  type ArchitectureTargetCapabilitySet,
  type ReadOnlyArchitectureTargetAdapter,
  type RuntimeExposureMode,
} from "@myskills-app/core";

/** Profiles are selected by the caller. The adapter never discovers one. */
export const codexAdapterProfiles = ["personal", "work", "shared"] as const;
export type CodexAdapterProfile = (typeof codexAdapterProfiles)[number];

export const codexAdapterDescriptor = Object.freeze({
  kind: "codex",
  version: "1.0.0",
  contractVersion: 1 as const,
});

/**
 * This adapter can inspect inventory and produce a plan input, but it cannot
 * write a target. Mutation capabilities are deliberately false and the class
 * has no mutation methods.
 */
export const codexAdapterCapabilities: ArchitectureTargetCapabilitySet = Object.freeze({
  "inventory.read": true,
  "health.read": true,
  "plan.read": true,
  apply: false,
  rollback: false,
  "sync.write": false,
});

export const codexAdapterDigest = architectureTargetAdapterDigest(codexAdapterDescriptor);
export const codexAdapterCapabilitiesDigest = architectureTargetCapabilitiesDigest(codexAdapterCapabilities);

export interface CodexReadOnlyArchitectureTargetAdapterOptions {
  /** Explicit, already-consented process-local root. It is never emitted. */
  root: string;
  profile: CodexAdapterProfile;
  /** Injectable only for deterministic tests; it does not affect filesystem reads. */
  clock?: () => Date;
}

interface ProfileResolution {
  slug: string;
  enabled?: boolean;
  runtimeExposure?: RuntimeExposureMode;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
}

interface RouterPolicyEntry {
  slug: string;
  configurationDigest?: string;
  configured?: boolean;
  managed?: boolean;
  supported?: boolean;
}

interface ParsedFrontmatter {
  fields: Map<string, string | boolean>;
  sensitiveFieldCount: number;
  unsupportedFieldCount: number;
  duplicateFieldCount: number;
}

interface FrontmatterReadResult {
  status: "ok" | "missing" | "invalid";
  parsed?: ParsedFrontmatter;
}

interface ScanResult {
  skills: ArchitectureTargetObservedSkill[];
  findings: ArchitectureTargetConfigFinding[];
  rootAvailable: boolean;
}

interface MetadataFileResult {
  status: "ok" | "missing" | "invalid";
  value?: unknown;
}

const MAX_METADATA_BYTES = 32 * 1024;
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const MAX_FRONTMATTER_LINE_BYTES = 4 * 1024;
const MAX_METADATA_SKILLS = 500;
const PROFILE_METADATA_FILE = "profile.json";
const ROUTER_POLICY_FILE = "router-policy.json";
const SKILLS_DIRECTORY = "skills";
const SAFE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SAFE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SAFE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|authorization|cookie|credential|password|private[-_ ]?key|secret|token|prompt|path|endpoint|url|package|content|body|remote|repo|config)/i;

const FRONTMATTER_FIELDS = [
  "name",
  "slug",
  "version",
  "digest",
  "kind",
  "enabled",
  "runtimeExposure",
  "configurationDigest",
  "configured",
  "managed",
  "supported",
] as const;

const PROFILE_FIELDS = [
  "schemaVersion",
  "profile",
  "skills",
] as const;

const PROFILE_SKILL_FIELDS = [
  "slug",
  "enabled",
  "runtimeExposure",
  "configurationDigest",
  "configured",
  "managed",
  "supported",
] as const;

const ROUTER_POLICY_FIELDS = [
  "schemaVersion",
  "routers",
] as const;

const ROUTER_FIELDS = [
  "slug",
  "configurationDigest",
  "configured",
  "managed",
  "supported",
] as const;

const FINDING_SEVERITIES: Record<string, ArchitectureTargetConfigFinding["severity"]> = {
  "root-unavailable": "error",
  "skills-directory-missing": "warning",
  "skills-directory-unavailable": "warning",
  "profile-metadata-missing": "warning",
  "profile-metadata-invalid": "warning",
  "profile-metadata-sensitive-field": "warning",
  "profile-metadata-mismatch": "warning",
  "profile-metadata-duplicate": "warning",
  "router-policy-missing": "warning",
  "router-policy-invalid": "warning",
  "router-policy-sensitive-field": "warning",
  "router-policy-duplicate": "warning",
  "skill-cap-exceeded": "warning",
  "invalid-skill-directory": "warning",
  "skill-directory-symlink": "warning",
  "skill-frontmatter-missing": "warning",
  "skill-frontmatter-invalid": "warning",
  "skill-frontmatter-sensitive-field": "warning",
  "skill-frontmatter-unsupported-field": "warning",
  "skill-frontmatter-duplicate-field": "warning",
  "skill-slug-mismatch": "warning",
  "skill-version-missing": "warning",
  "skill-version-invalid": "warning",
  "skill-digest-missing": "warning",
  "skill-digest-invalid": "warning",
  "skill-read-failed": "warning",
  "skill-policy-conflict": "warning",
  "duplicate-slug": "warning",
  "duplicate-slug-digest-conflict": "error",
};

class FindingCollector {
  #findings = new Map<string, ArchitectureTargetConfigFinding>();

  add(code: keyof typeof FINDING_SEVERITIES, count = 1): void {
    if (count <= 0) return;
    const existing = this.#findings.get(code);
    if (existing) {
      existing.count += count;
      return;
    }
    this.#findings.set(code, {
      code,
      severity: FINDING_SEVERITIES[code],
      count,
    });
  }

  toArray(): ArchitectureTargetConfigFinding[] {
    return [...this.#findings.values()]
      .map((finding) => ({ ...finding }))
      .sort((left, right) => `${left.code}\u0000${left.severity}`.localeCompare(`${right.code}\u0000${right.severity}`));
  }
}

/**
 * Read-only adapter for a caller-supplied Codex profile root.
 *
 * The supported local projection is intentionally small:
 *
 *   <root>/profile.json
 *   <root>/router-policy.json
 *   <root>/skills/<slug>/SKILL.md
 *
 * Nothing else is traversed. In particular, the adapter never searches a
 * home directory, follows a profile pointer, reads a config file, or uploads
 * anything to the API.
 */
export class CodexReadOnlyArchitectureTargetAdapter implements ReadOnlyArchitectureTargetAdapter {
  readonly kind = codexAdapterDescriptor.kind;
  readonly version = codexAdapterDescriptor.version;
  readonly contractVersion = codexAdapterDescriptor.contractVersion;

  #root: string;
  #profile: CodexAdapterProfile;
  #clock: () => Date;

  constructor(options: CodexReadOnlyArchitectureTargetAdapterOptions);
  constructor(root: string, profile: CodexAdapterProfile, clock?: () => Date);
  constructor(
    optionsOrRoot: CodexReadOnlyArchitectureTargetAdapterOptions | string,
    profile?: CodexAdapterProfile,
    clock?: () => Date,
  ) {
    const options = typeof optionsOrRoot === "string"
      ? { root: optionsOrRoot, profile, clock }
      : optionsOrRoot;
    if (typeof options.root !== "string" || !options.root || !path.isAbsolute(options.root)) {
      throw new TypeError("A consented absolute target root is required.");
    }
    if (!isCodexAdapterProfile(options.profile)) {
      throw new TypeError("A supported Codex target profile is required.");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new TypeError("The adapter clock must be a function.");
    }
    this.#root = path.resolve(options.root);
    this.#profile = options.profile;
    this.#clock = options.clock ?? (() => new Date());
  }

  async observe(context: ArchitectureTargetAdapterContext): Promise<ArchitectureTargetObservation> {
    const safeContext = assertValidArchitectureTargetAdapterContext(context);
    const scan = await this.#scan();
    const observedAt = this.#timestamp();
    const observation = {
      schemaVersion: 1 as const,
      targetId: safeContext.targetId,
      targetGeneration: safeContext.targetGeneration,
      adapterDigest: safeContext.adapterDigest,
      capabilitiesDigest: safeContext.capabilitiesDigest,
      observedAt,
      skills: scan.skills,
      configFindings: scan.findings,
      promptAwareness: { detected: false, count: 0, redacted: true },
      metadata: {
        architectureId: safeContext.architectureId,
        profile: this.#profile,
      } satisfies ArchitectureTargetMetadata,
    };
    return assertValidArchitectureTargetObservation({
      ...observation,
      observedDigest: architectureTargetObservationDigest(observation),
    });
  }

  async health(context: ArchitectureTargetAdapterContext): Promise<ArchitectureTargetHealth> {
    const safeContext = assertValidArchitectureTargetAdapterContext(context);
    const scan = await this.#scan();
    const checkedAt = this.#timestamp();
    const hasError = scan.findings.some((finding) => finding.severity === "error");
    const status = !scan.rootAvailable
      ? "unavailable"
      : hasError || scan.findings.length > 0
        ? "degraded"
        : "healthy";
    return {
      status,
      checkedAt,
      metadata: {
        architectureId: safeContext.architectureId,
        profile: this.#profile,
        skillCount: scan.skills.length,
        findingCount: scan.findings.reduce((total, finding) => total + finding.count, 0),
      },
    };
  }

  async #scan(): Promise<ScanResult> {
    const findings = new FindingCollector();
    const rootAvailable = await this.#isDirectory(this.#root);
    if (!rootAvailable) {
      findings.add("root-unavailable");
      return { skills: [], findings: findings.toArray(), rootAvailable: false };
    }

    const profileResolutions = await this.#readProfileResolutions(findings);
    const routerPolicy = await this.#readRouterPolicy(findings);
    const skills = await this.#readSkills(profileResolutions, routerPolicy, findings);
    this.#addDuplicateFindings(skills, findings);
    return { skills, findings: findings.toArray(), rootAvailable: true };
  }

  async #isDirectory(target: string): Promise<boolean> {
    try {
      const entry = await lstat(target);
      return entry.isDirectory() && !entry.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async #readProfileResolutions(findings: FindingCollector): Promise<Map<string, ProfileResolution>> {
    const result = new Map<string, ProfileResolution>();
    const file = await this.#readMetadataFile(PROFILE_METADATA_FILE);
    if (file.status === "missing") {
      findings.add("profile-metadata-missing");
      return result;
    }
    if (file.status !== "ok") {
      findings.add("profile-metadata-invalid");
      return result;
    }
    if (!isRecord(file.value) || hasUnknownKey(file.value, PROFILE_FIELDS, findings, "profile-metadata-sensitive-field")) {
      findings.add("profile-metadata-invalid");
      return result;
    }
    if (file.value.schemaVersion !== 1 || file.value.profile !== this.#profile || !Array.isArray(file.value.skills)) {
      if (file.value.profile !== undefined && file.value.profile !== this.#profile) findings.add("profile-metadata-mismatch");
      else findings.add("profile-metadata-invalid");
      return result;
    }
    if (file.value.skills.length > MAX_METADATA_SKILLS) {
      findings.add("profile-metadata-invalid");
    }
    for (const item of file.value.skills.slice(0, MAX_METADATA_SKILLS)) {
      const resolution = parseProfileResolution(item, findings);
      if (!resolution) continue;
      if (result.has(resolution.slug)) {
        findings.add("profile-metadata-duplicate");
        continue;
      }
      result.set(resolution.slug, resolution);
    }
    return result;
  }

  async #readRouterPolicy(findings: FindingCollector): Promise<Map<string, RouterPolicyEntry>> {
    const result = new Map<string, RouterPolicyEntry>();
    const file = await this.#readMetadataFile(ROUTER_POLICY_FILE);
    if (file.status === "missing") {
      findings.add("router-policy-missing");
      return result;
    }
    if (file.status !== "ok") {
      findings.add("router-policy-invalid");
      return result;
    }
    if (!isRecord(file.value) || hasUnknownKey(file.value, ROUTER_POLICY_FIELDS, findings, "router-policy-sensitive-field")) {
      findings.add("router-policy-invalid");
      return result;
    }
    if (file.value.schemaVersion !== 1 || !Array.isArray(file.value.routers)) {
      findings.add("router-policy-invalid");
      return result;
    }
    for (const item of file.value.routers.slice(0, MAX_METADATA_SKILLS)) {
      const router = parseRouterPolicyEntry(item, findings);
      if (!router) continue;
      if (result.has(router.slug)) {
        findings.add("router-policy-duplicate");
        continue;
      }
      result.set(router.slug, router);
    }
    return result;
  }

  async #readMetadataFile(relativeName: string): Promise<MetadataFileResult> {
    const filePath = path.join(this.#root, relativeName);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const entry = await handle.stat();
      if (!entry.isFile()) return { status: "invalid" };
      const { buffer, bytesRead } = await readBounded(handle, MAX_METADATA_BYTES);
      if (bytesRead > MAX_METADATA_BYTES) return { status: "invalid" };
      const text = buffer.toString("utf8", 0, bytesRead);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { status: "invalid" };
      }
      return { status: "ok", value };
    } catch (error) {
      if (isMissingFileError(error)) return { status: "missing" };
      return { status: "invalid" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #readSkills(
    profileResolutions: Map<string, ProfileResolution>,
    routerPolicy: Map<string, RouterPolicyEntry>,
    findings: FindingCollector,
  ): Promise<ArchitectureTargetObservedSkill[]> {
    const skillsDirectory = path.join(this.#root, SKILLS_DIRECTORY);
    let entries: import("node:fs").Dirent[];
    try {
      const directory = await lstat(skillsDirectory);
      if (directory.isSymbolicLink() || !directory.isDirectory()) {
        findings.add("skills-directory-unavailable");
        return [];
      }
      entries = await readdir(skillsDirectory, { withFileTypes: true });
    } catch {
      findings.add("skills-directory-missing");
      return [];
    }

    const candidates = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    if (candidates.length > architectureTargetLimits.skills) {
      findings.add("skill-cap-exceeded", candidates.length - architectureTargetLimits.skills);
    }

    const skills: ArchitectureTargetObservedSkill[] = [];
    for (const entry of candidates.slice(0, architectureTargetLimits.skills)) {
      if (!SAFE_SLUG_PATTERN.test(entry.name)) {
        findings.add("invalid-skill-directory");
        continue;
      }
      if (entry.isSymbolicLink()) {
        findings.add("skill-directory-symlink");
        continue;
      }
      const skill = await this.#readSkill(entry.name, profileResolutions, routerPolicy, findings);
      if (skill) skills.push(skill);
    }
    return skills.sort(compareSkills);
  }

  async #readSkill(
    directorySlug: string,
    profileResolutions: Map<string, ProfileResolution>,
    routerPolicy: Map<string, RouterPolicyEntry>,
    findings: FindingCollector,
  ): Promise<ArchitectureTargetObservedSkill> {
    const skillPath = path.join(this.#root, SKILLS_DIRECTORY, directorySlug, "SKILL.md");
    const frontmatter = await readFrontmatter(skillPath);
    if (frontmatter.status === "missing") findings.add("skill-frontmatter-missing");
    if (frontmatter.status === "invalid") findings.add("skill-frontmatter-invalid");
    const parsed = frontmatter.parsed;
    if (parsed) {
      if (parsed.sensitiveFieldCount > 0) findings.add("skill-frontmatter-sensitive-field", parsed.sensitiveFieldCount);
      if (parsed.unsupportedFieldCount > 0) findings.add("skill-frontmatter-unsupported-field", parsed.unsupportedFieldCount);
      if (parsed.duplicateFieldCount > 0) findings.add("skill-frontmatter-duplicate-field", parsed.duplicateFieldCount);
    }

    const fields = parsed?.fields ?? new Map<string, string | boolean>();
    const explicitSlug = stringField(fields, "slug");
    const explicitName = stringField(fields, "name");
    const frontmatterSlug = explicitSlug ?? explicitName;
    const slug = frontmatterSlug && SAFE_SLUG_PATTERN.test(frontmatterSlug) ? frontmatterSlug : directorySlug;
    if (frontmatterSlug && frontmatterSlug !== directorySlug) findings.add("skill-slug-mismatch");
    if (fields.has("slug") && (!explicitSlug || !SAFE_SLUG_PATTERN.test(explicitSlug))) findings.add("skill-frontmatter-invalid");
    if (fields.has("name") && (!explicitName || !SAFE_SLUG_PATTERN.test(explicitName))) findings.add("skill-frontmatter-invalid");
    const profileResolution = profileResolutions.get(slug) ?? profileResolutions.get(directorySlug);

    const versionValue = stringField(fields, "version");
    const version = versionValue && SAFE_VERSION_PATTERN.test(versionValue) ? versionValue : undefined;
    if (!versionValue) findings.add("skill-version-missing");
    else if (!version) findings.add("skill-version-invalid");

    const digestValue = stringField(fields, "digest");
    const digest = digestValue && SAFE_DIGEST_PATTERN.test(digestValue) ? digestValue : undefined;
    if (!digestValue) findings.add("skill-digest-missing");
    else if (!digest) findings.add("skill-digest-invalid");

    const policyRouter = routerPolicy.get(slug);
    const frontmatterKind = stringField(fields, "kind");
    const kind = frontmatterKind === "router" || frontmatterKind === "leaf"
      ? frontmatterKind
      : policyRouter
        ? "router"
        : "leaf";
    if (frontmatterKind && frontmatterKind !== "router" && frontmatterKind !== "leaf") findings.add("skill-frontmatter-invalid");
    if (frontmatterKind && policyRouter && frontmatterKind !== "router") findings.add("skill-policy-conflict");
    if (fields.has("enabled") && booleanField(fields, "enabled") === undefined) findings.add("skill-frontmatter-invalid");
    if (fields.has("runtimeExposure") && stringRuntimeExposure(fields, "runtimeExposure") === undefined) findings.add("skill-frontmatter-invalid");
    if (fields.has("configurationDigest") && digestField(fields, "configurationDigest") === undefined) findings.add("skill-frontmatter-invalid");
    for (const key of ["configured", "managed", "supported"] as const) {
      if (fields.has(key) && booleanField(fields, key) === undefined) findings.add("skill-frontmatter-invalid");
    }

    const profile = profileResolution;
    const enabled = profile?.enabled ?? booleanField(fields, "enabled") ?? true;
    const runtimeExposure = profile?.runtimeExposure
      ?? stringRuntimeExposure(fields, "runtimeExposure")
      ?? (enabled ? kind : "disabled");
    const configurationDigest = profile?.configurationDigest
      ?? policyRouter?.configurationDigest
      ?? digestField(fields, "configurationDigest");
    const configured = profile?.configured
      ?? policyRouter?.configured
      ?? booleanField(fields, "configured")
      ?? (configurationDigest !== undefined ? true : undefined);
    const resolved = version !== undefined && digest !== undefined;
    const managed = resolved
      ? profile?.managed ?? policyRouter?.managed ?? booleanField(fields, "managed") ?? false
      : false;
    const supported = resolved ? profile?.supported ?? policyRouter?.supported ?? booleanField(fields, "supported") ?? true : false;
    const classification = frontmatterKind === "router"
      ? "frontmatter"
      : policyRouter
        ? "router-policy"
        : "default-leaf";

    return {
      slug,
      ...(version ? { version } : {}),
      ...(digest ? { digest } : {}),
      kind,
      enabled,
      runtimeExposure,
      ...(configurationDigest ? { configurationDigest } : {}),
      ...(configured === undefined ? {} : { configured }),
      managed,
      supported,
      metadata: {
        profile: this.#profile,
        resolution: resolved ? "resolved" : "unresolved",
        classification,
      },
    };
  }

  #addDuplicateFindings(skills: ArchitectureTargetObservedSkill[], findings: FindingCollector): void {
    const bySlug = new Map<string, ArchitectureTargetObservedSkill[]>();
    for (const skill of skills) bySlug.set(skill.slug, [...(bySlug.get(skill.slug) ?? []), skill]);
    for (const entries of bySlug.values()) {
      if (entries.length < 2) continue;
      const digests = new Set(entries.map((entry) => entry.digest ?? ""));
      if (digests.size > 1) findings.add("duplicate-slug-digest-conflict");
      else findings.add("duplicate-slug");
    }
  }

  #timestamp(): string {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("The adapter clock returned an invalid date.");
    return now.toISOString();
  }
}

export function createCodexReadOnlyArchitectureTargetAdapter(
  options: CodexReadOnlyArchitectureTargetAdapterOptions,
): CodexReadOnlyArchitectureTargetAdapter {
  return new CodexReadOnlyArchitectureTargetAdapter(options);
}

function isCodexAdapterProfile(value: unknown): value is CodexAdapterProfile {
  return typeof value === "string" && (codexAdapterProfiles as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
  findings: FindingCollector,
  sensitiveCode: keyof typeof FINDING_SEVERITIES,
): boolean {
  let unknown = false;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    unknown = true;
    if (SENSITIVE_KEY_PATTERN.test(key)) findings.add(sensitiveCode);
  }
  return unknown;
}

function parseProfileResolution(value: unknown, findings: FindingCollector): ProfileResolution | undefined {
  if (!isRecord(value) || hasUnknownKey(value, PROFILE_SKILL_FIELDS, findings, "profile-metadata-sensitive-field")) {
    findings.add("profile-metadata-invalid");
    return undefined;
  }
  const slug = value.slug;
  if (typeof slug !== "string" || !SAFE_SLUG_PATTERN.test(slug)) {
    findings.add("profile-metadata-invalid");
    return undefined;
  }
  const enabled = optionalBoolean(value.enabled);
  const configured = optionalBoolean(value.configured);
  const managed = optionalBoolean(value.managed);
  const supported = optionalBoolean(value.supported);
  const runtimeExposure = optionalRuntimeExposure(value.runtimeExposure);
  const configurationDigest = optionalDigest(value.configurationDigest);
  if (value.enabled !== undefined && enabled === undefined) findings.add("profile-metadata-invalid");
  if (value.configured !== undefined && configured === undefined) findings.add("profile-metadata-invalid");
  if (value.managed !== undefined && managed === undefined) findings.add("profile-metadata-invalid");
  if (value.supported !== undefined && supported === undefined) findings.add("profile-metadata-invalid");
  if (value.runtimeExposure !== undefined && runtimeExposure === undefined) findings.add("profile-metadata-invalid");
  if (value.configurationDigest !== undefined && configurationDigest === undefined) findings.add("profile-metadata-invalid");
  return {
    slug,
    ...(enabled === undefined ? {} : { enabled }),
    ...(runtimeExposure === undefined ? {} : { runtimeExposure }),
    ...(configurationDigest === undefined ? {} : { configurationDigest }),
    ...(configured === undefined ? {} : { configured }),
    ...(managed === undefined ? {} : { managed }),
    ...(supported === undefined ? {} : { supported }),
  };
}

function parseRouterPolicyEntry(value: unknown, findings: FindingCollector): RouterPolicyEntry | undefined {
  if (!isRecord(value) || hasUnknownKey(value, ROUTER_FIELDS, findings, "router-policy-sensitive-field")) {
    findings.add("router-policy-invalid");
    return undefined;
  }
  const slug = value.slug;
  if (typeof slug !== "string" || !SAFE_SLUG_PATTERN.test(slug)) {
    findings.add("router-policy-invalid");
    return undefined;
  }
  const configurationDigest = optionalDigest(value.configurationDigest);
  const configured = optionalBoolean(value.configured);
  const managed = optionalBoolean(value.managed);
  const supported = optionalBoolean(value.supported);
  if (value.configurationDigest !== undefined && configurationDigest === undefined) findings.add("router-policy-invalid");
  if (value.configured !== undefined && configured === undefined) findings.add("router-policy-invalid");
  if (value.managed !== undefined && managed === undefined) findings.add("router-policy-invalid");
  if (value.supported !== undefined && supported === undefined) findings.add("router-policy-invalid");
  return {
    slug,
    ...(configurationDigest === undefined ? {} : { configurationDigest }),
    ...(configured === undefined ? {} : { configured }),
    ...(managed === undefined ? {} : { managed }),
    ...(supported === undefined ? {} : { supported }),
  };
}

async function readFrontmatter(filePath: string): Promise<FrontmatterReadResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const entry = await handle.stat();
    if (!entry.isFile()) return { status: "invalid" };
    const openingDelimiter = await readOpeningDelimiter(handle);
    if (!openingDelimiter.valid) return { status: "missing" };
    const lines: string[] = [];
    let totalBytes = openingDelimiter.bytes;
    for (;;) {
      const next = await readLine(handle, MAX_FRONTMATTER_LINE_BYTES);
      totalBytes += next.bytes;
      if (totalBytes > MAX_FRONTMATTER_BYTES || next.overflow) return { status: "invalid" };
      if (next.line === null) return { status: "invalid" };
      if (next.line === "---") return { status: "ok", parsed: parseFrontmatter(lines) };
      lines.push(next.line);
    }
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    return { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<{ buffer: Buffer; bytesRead: number }> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }
  return { buffer, bytesRead };
}

/** Read only the delimiter before accepting any frontmatter bytes. */
async function readOpeningDelimiter(handle: Awaited<ReturnType<typeof open>>): Promise<{ valid: boolean; bytes: number }> {
  const buffer = Buffer.alloc(4);
  const result = await handle.read(buffer, 0, buffer.length, null);
  if (result.bytesRead < 4 || buffer[0] !== 45 || buffer[1] !== 45 || buffer[2] !== 45) {
    return { valid: false, bytes: result.bytesRead };
  }
  if (buffer[3] === 10) return { valid: true, bytes: 4 };
  if (buffer[3] !== 13) return { valid: false, bytes: result.bytesRead };
  const newline = Buffer.alloc(1);
  const newlineResult = await handle.read(newline, 0, 1, null);
  if (newlineResult.bytesRead < 1 || newline[0] !== 10) return { valid: false, bytes: result.bytesRead + newlineResult.bytesRead };
  return { valid: true, bytes: 5 };
}

async function readLine(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<{ line: string | null; bytes: number; eof: boolean; overflow: boolean }> {
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  let bytesRead = 0;
  for (;;) {
    const result = await handle.read(buffer, 0, 1, null);
    if (result.bytesRead === 0) {
      if (bytes.length === 0) return { line: null, bytes: bytesRead, eof: true, overflow: false };
      return { line: decodeLine(bytes), bytes: bytesRead, eof: true, overflow: bytes.length > maximumBytes };
    }
    bytesRead += result.bytesRead;
    if (buffer[0] === 10) return { line: decodeLine(bytes), bytes: bytesRead, eof: false, overflow: bytes.length > maximumBytes };
    if (bytes.length <= maximumBytes) bytes.push(buffer[0] as number);
    if (bytes.length > maximumBytes) return { line: null, bytes: bytesRead, eof: false, overflow: true };
  }
}

function decodeLine(bytes: number[]): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  return decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded;
}

function parseFrontmatter(lines: string[]): ParsedFrontmatter {
  const fields = new Map<string, string | boolean>();
  let sensitiveFieldCount = 0;
  let unsupportedFieldCount = 0;
  let duplicateFieldCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      unsupportedFieldCount += 1;
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    // Codex uses `description` as a prompt-facing field. It is recognized so
    // standard files remain readable, but its value is intentionally discarded.
    if (key === "description") continue;
    const isAllowedField = SAFE_KEY_PATTERN.test(key) && (FRONTMATTER_FIELDS as readonly string[]).includes(key);
    if (!isAllowedField && SENSITIVE_KEY_PATTERN.test(key)) {
      sensitiveFieldCount += 1;
      continue;
    }
    if (!isAllowedField) {
      unsupportedFieldCount += 1;
      continue;
    }
    if (fields.has(key)) {
      duplicateFieldCount += 1;
      continue;
    }
    const parsed = parseScalar(trimmed.slice(separator + 1).trim());
    if (parsed === undefined) {
      unsupportedFieldCount += 1;
      continue;
    }
    fields.set(key, parsed);
  }
  return { fields, sensitiveFieldCount, unsupportedFieldCount, duplicateFieldCount };
}

function parseScalar(value: string): string | boolean | undefined {
  if (!value || CONTROL_CHARACTER_PATTERN.test(value)) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    const unquoted = value.slice(1, -1);
    if (!unquoted || CONTROL_CHARACTER_PATTERN.test(unquoted) || unquoted.length > 256) return undefined;
    return unquoted;
  }
  if (value.length > 256 || /[{}[\],]/u.test(value)) return undefined;
  return value;
}

function stringField(fields: Map<string, string | boolean>, key: string): string | undefined {
  const value = fields.get(key);
  return typeof value === "string" ? value : undefined;
}

function booleanField(fields: Map<string, string | boolean>, key: string): boolean | undefined {
  const value = fields.get(key);
  return typeof value === "boolean" ? value : undefined;
}

function stringRuntimeExposure(fields: Map<string, string | boolean>, key: string): RuntimeExposureMode | undefined {
  return optionalRuntimeExposure(stringField(fields, key));
}

function digestField(fields: Map<string, string | boolean>, key: string): string | undefined {
  return optionalDigest(stringField(fields, key));
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalRuntimeExposure(value: unknown): RuntimeExposureMode | undefined {
  return value === "disabled" || value === "router" || value === "leaf" ? value : undefined;
}

function optionalDigest(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_DIGEST_PATTERN.test(value) ? value : undefined;
}

function compareSkills(left: ArchitectureTargetObservedSkill, right: ArchitectureTargetObservedSkill): number {
  return `${left.slug}\u0000${left.version ?? ""}\u0000${left.digest ?? ""}`.localeCompare(`${right.slug}\u0000${right.version ?? ""}\u0000${right.digest ?? ""}`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
