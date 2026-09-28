import { randomBytes } from "node:crypto";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetLimits,
  architectureTargetObservationDigest,
  assertValidArchitectureTarget,
  assertValidArchitectureTargetObservation,
  canonicalizeJson,
  sha256Hex,
  type ArchitectureTarget,
  type ArchitectureTargetConfigFinding,
  type ArchitectureTargetHealth,
  type ArchitectureTargetObservation,
} from "@myskills-app/core";
import { parseWorkspaceTarget, validateCodexSkill, workspaceRootDigest } from "./codex-workspace.js";
import { atomicPrivateWrite, errorCode, readRegularText, withInstallRootLock } from "./install-filesystem.js";

/**
 * MySkills workspace scopes: which enrolled inventory target owns a local
 * directory for one provider. This is MySkills ownership bookkeeping only. It
 * never changes how Codex or Claude discover or inherit skills at runtime.
 *
 * Absolute roots and exclusion paths live only in the private local state file.
 * The registry receives slugs, counts, digests, and provider/scope labels.
 */

export const scopeProviders = ["codex", "claude"] as const;
export type ScopeProvider = (typeof scopeProviders)[number];
export type ScopeKind = "global" | "project";
export type ScopeBindingStatus = "registering" | "registered" | "active";

export const SCOPE_STATE_SCHEMA_VERSION = 1 as const;
const SCOPE_STATE_KIND = "myskills.workspace-scopes";
const SCOPE_STATE_FILE = "workspace-scopes.json";
const SCOPE_MIGRATION_SCHEMA = "myskills.workspace-scopes-migration.v1";
const MAX_STATE_BYTES = 512 * 1024;
const MAX_RULES_PER_PROVIDER = 256;
const MAX_ROOT_ENTRIES = 10_000;
const MAX_DEFINITION_BYTES = 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
// Older servers scan the whole observation, including otherwise valid slugs.
// Use this compatibility guard only when the server has not explicitly
// advertised structural slug validation. Local inventory is unaffected.
const LEGACY_SERVER_PRIVACY_WORD_PATTERN = /(^|[^a-z])(api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key|prompt|path|endpoint|url|package|content|config|body|source|raw|snapshot|payload|file|filename|directory|home|host|machine)([^a-z]|$)/i;

/** The project-relative skill location MySkills inventories for each provider. */
export const projectSkillsLocation: Readonly<Record<ScopeProvider, readonly string[]>> = Object.freeze({
  codex: Object.freeze([".agents", "skills"]),
  claude: Object.freeze([".claude", "skills"]),
});

export const scopeInventoryCapabilities = Object.freeze({
  "inventory.read": true,
  "health.read": true,
  "plan.read": false,
  apply: false,
  rollback: false,
  "sync.write": false,
});

export function scopeAdapterDescriptor(provider: ScopeProvider): { kind: string; version: string; contractVersion: 1 } {
  return { kind: `${provider}-inventory`, version: "1.0.0", contractVersion: 1 };
}

export class ScopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "ScopeError";
  }
}

export interface ScopeProvenance { origin: string; instanceId: string }
export interface ScopeRootIdentity { ino: string }

export interface ScopeBinding {
  status: ScopeBindingStatus;
  identityDigest: string;
  provenance: ScopeProvenance;
  /** The authenticated account that created the intent; only it may resume or use it. */
  actorId: string;
  architectureId: string;
  environmentId: string;
  profileId: string;
  name: string;
  target?: ArchitectureTarget;
}

export interface ManagedWorkspaceReference {
  adapterKind: "codex-workspace";
  targetId: string;
  identityDigest: string;
  generation: number;
  ownerId: string;
  provenance: ScopeProvenance;
  bindingDigest: string;
  adoptedAt: string;
}

export interface GlobalScopeRecord { root: string; rootIdentity: ScopeRootIdentity; binding: ScopeBinding }
export interface ProjectScopeRecord {
  root: string;
  rootIdentity: ScopeRootIdentity;
  mode: "inventory" | "managed";
  binding?: ScopeBinding;
  managed?: ManagedWorkspaceReference;
}
export interface ScopeExclusion { path: string; addedAt: string }
export interface ProviderScopes { global: GlobalScopeRecord | null; projects: ProjectScopeRecord[]; exclusions: ScopeExclusion[] }
export interface ScopeState {
  schemaVersion: typeof SCOPE_STATE_SCHEMA_VERSION;
  kind: typeof SCOPE_STATE_KIND;
  providers: Record<ScopeProvider, ProviderScopes>;
}

export interface ScopeStateSnapshot { state: ScopeState; bytes: string | null }

export function emptyScopeState(): ScopeState {
  return {
    schemaVersion: SCOPE_STATE_SCHEMA_VERSION,
    kind: SCOPE_STATE_KIND,
    providers: { codex: emptyProviderScopes(), claude: emptyProviderScopes() },
  };
}

function emptyProviderScopes(): ProviderScopes {
  return { global: null, projects: [], exclusions: [] };
}

export function isScopeProvider(value: unknown): value is ScopeProvider {
  return typeof value === "string" && (scopeProviders as readonly string[]).includes(value);
}

export function newScopeIdentityDigest(): string {
  return sha256Hex(randomBytes(32).toString("hex"));
}

// ---------------------------------------------------------------------------
// Paths

export function scopeStateDirectory(env: Record<string, string | undefined>): string {
  if (env.MYSKILLS_CONFIG_DIR) return path.join(path.resolve(env.MYSKILLS_CONFIG_DIR), "scopes");
  const base = env.XDG_CONFIG_HOME
    ? path.join(path.resolve(env.XDG_CONFIG_HOME), "myskills-app")
    : path.join(os.homedir(), ".config", "myskills-app");
  return path.join(base, "scopes");
}

/** Segment-aware containment: `/a/foo` contains `/a/foo/x`, never `/a/foobar`. */
export function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathDepth(value: string): number {
  return value.split(path.sep).filter(Boolean).length;
}

async function broadPaths(): Promise<Set<string>> {
  const home = os.homedir();
  const values = new Set([path.parse(home).root, path.resolve(home)]);
  try { values.add(await realpath(home)); } catch { /* The lexical home remains denied. */ }
  return values;
}

/**
 * Canonicalize a caller-selected directory. Stored roots must not be a symlink
 * at the final component (callers pass the real directory), and never the
 * filesystem root or the home directory. Symlinked ancestors are resolved so
 * one directory has one identity.
 */
export async function canonicalScopeDirectory(
  input: unknown,
  options: { allowFinalSymlink?: boolean; allowBroad?: boolean; label?: string } = {},
): Promise<{ path: string; identity: ScopeRootIdentity }> {
  const label = options.label ?? "The directory";
  if (typeof input !== "string" || !input || CONTROL_CHARACTER_PATTERN.test(input) || !path.isAbsolute(input)) {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} must be an absolute directory path.`, 2);
  }
  const lexical = path.resolve(input);
  const denied = options.allowBroad ? new Set<string>() : await broadPaths();
  if (denied.has(lexical)) {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} cannot be the filesystem root or your home directory. Select a specific skills directory or project.`, 2);
  }
  let entry;
  try {
    entry = await lstat(lexical);
  } catch {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} does not exist or cannot be inspected.`, 2);
  }
  if (entry.isSymbolicLink() && !options.allowFinalSymlink) {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} is a symlink. Pass the real directory path instead.`, 2);
  }
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} cannot be resolved.`, 2);
  }
  if (denied.has(canonical)) {
    throw new ScopeError("SCOPE_ROOT_INVALID", `${label} cannot be the filesystem root or your home directory. Select a specific skills directory or project.`, 2);
  }
  const resolved = await lstat(canonical, { bigint: true });
  if (!resolved.isDirectory()) throw new ScopeError("SCOPE_ROOT_INVALID", `${label} must be a directory.`, 2);
  return { path: canonical, identity: { ino: String(resolved.ino) } };
}

/** Recheck a stored root before reading it. */
export async function assertScopeRootUnchanged(root: string, identity: ScopeRootIdentity): Promise<void> {
  let current: { path: string; identity: ScopeRootIdentity };
  try {
    current = await canonicalScopeDirectory(root, { allowBroad: true });
  } catch {
    throw new ScopeError("SCOPE_ROOT_CHANGED", "The enrolled directory is missing, replaced by a symlink, or unreadable. Run scopes unbind, then enroll the directory again.");
  }
  if (current.path !== root || current.identity.ino !== identity.ino) {
    throw new ScopeError("SCOPE_ROOT_CHANGED", "The enrolled directory was replaced since enrollment. Run scopes unbind, then enroll the directory again.");
  }
}

// ---------------------------------------------------------------------------
// Local state

export async function readScopeState(directory: string): Promise<ScopeStateSnapshot> {
  let realDirectory: string;
  try {
    realDirectory = await realpath(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: emptyScopeState(), bytes: null };
    throw new ScopeError("SCOPE_STATE_INVALID", "The workspace scope state directory cannot be read.");
  }
  await assertPrivateStateDirectory(realDirectory);
  let text: string;
  try {
    text = await readRegularText(path.join(realDirectory, SCOPE_STATE_FILE), MAX_STATE_BYTES);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: emptyScopeState(), bytes: null };
    throw new ScopeError("SCOPE_STATE_INVALID", malformedStateMessage());
  }
  return { state: parseScopeState(text), bytes: text };
}

/** Run a state transaction under the MySkills root lock for the state directory. */
export async function withScopeStateLock<T>(
  directory: string,
  work: (context: { snapshot: ScopeStateSnapshot; write: (state: ScopeState) => Promise<string>; backup: (name: string, bytes: string) => Promise<string> }) => Promise<T>,
): Promise<T> {
  return withInstallRootLock(directory, async (root) => {
    await assertPrivateStateDirectory(root);
    const snapshot = await readScopeState(root);
    return work({
      snapshot,
      write: async (state) => {
        const text = serializeScopeState(state);
        // Never accept a write the reader would refuse; the state stays readable.
        if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
          throw new ScopeError("SCOPE_STATE_LIMIT", `The workspace scope state would exceed ${MAX_STATE_BYTES / 1024} KiB. Nothing was changed; remove unused exclusions or scopes first.`);
        }
        parseScopeState(text);
        await atomicPrivateWrite(root, path.join(root, SCOPE_STATE_FILE), text);
        return text;
      },
      backup: async (name, bytes) => {
        await atomicPrivateWrite(root, path.join(root, "backups", name), bytes);
        return name;
      },
    });
  });
}

async function assertPrivateStateDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) {
    throw new ScopeError("SCOPE_STATE_UNSAFE", "The workspace scope state directory must be a private directory owned by you (mode 700).");
  }
}

export function serializeScopeState(state: ScopeState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function malformedStateMessage(): string {
  return "The workspace scope state is malformed and was not changed. Move it aside, then restore a copy from the backups directory or re-enroll.";
}

export function parseScopeState(text: string): ScopeState {
  const invalid = (): never => { throw new ScopeError("SCOPE_STATE_INVALID", malformedStateMessage()); };
  let value: unknown;
  try { value = JSON.parse(text); } catch { invalid(); }
  if (!isRecord(value)) invalid();
  const record = value as Record<string, unknown>;
  if (typeof record.schemaVersion === "number" && record.schemaVersion > SCOPE_STATE_SCHEMA_VERSION) {
    throw new ScopeError("SCOPE_STATE_UNSUPPORTED", "The workspace scope state was written by a newer MySkills CLI and was not changed. Upgrade the CLI.");
  }
  if (record.schemaVersion !== SCOPE_STATE_SCHEMA_VERSION || record.kind !== SCOPE_STATE_KIND || !exactKeys(record, ["schemaVersion", "kind", "providers"])) invalid();
  const providersInput = record.providers;
  if (!isRecord(providersInput) || Object.keys(providersInput).some((key) => !isScopeProvider(key))) invalid();
  const state = emptyScopeState();
  for (const provider of scopeProviders) {
    const input = (providersInput as Record<string, unknown>)[provider];
    if (input === undefined) continue;
    const parsed = parseProviderScopes(input);
    if (!parsed) invalid();
    state.providers[provider] = parsed as ProviderScopes;
  }
  return state;
}

function parseProviderScopes(input: unknown): ProviderScopes | undefined {
  if (!isRecord(input) || !exactKeys(input, ["global", "projects", "exclusions"])) return undefined;
  if (!Array.isArray(input.projects) || !Array.isArray(input.exclusions)) return undefined;
  if (input.projects.length > MAX_RULES_PER_PROVIDER || input.exclusions.length > MAX_RULES_PER_PROVIDER) return undefined;
  let global: GlobalScopeRecord | null = null;
  if (input.global !== null) {
    if (!isRecord(input.global) || !exactKeys(input.global, ["root", "rootIdentity", "binding"])) return undefined;
    const root = storedPath(input.global.root);
    const rootIdentity = storedIdentity(input.global.rootIdentity);
    const binding = parseBinding(input.global.binding);
    if (!root || !rootIdentity || !binding) return undefined;
    global = { root, rootIdentity, binding };
  }
  const projects: ProjectScopeRecord[] = [];
  for (const item of input.projects) {
    if (!isRecord(item)) return undefined;
    const root = storedPath(item.root);
    const rootIdentity = storedIdentity(item.rootIdentity);
    if (!root || !rootIdentity || projects.some((project) => project.root === root)) return undefined;
    if (item.mode === "inventory" && exactKeys(item, ["root", "rootIdentity", "mode", "binding"])) {
      const binding = parseBinding(item.binding);
      if (!binding) return undefined;
      projects.push({ root, rootIdentity, mode: "inventory", binding });
    } else if (item.mode === "managed" && exactKeys(item, ["root", "rootIdentity", "mode", "managed"])) {
      const managed = parseManagedReference(item.managed);
      if (!managed) return undefined;
      projects.push({ root, rootIdentity, mode: "managed", managed });
    } else {
      return undefined;
    }
  }
  const exclusions: ScopeExclusion[] = [];
  for (const item of input.exclusions) {
    if (!isRecord(item) || !exactKeys(item, ["path", "addedAt"])) return undefined;
    const exclusionPath = storedPath(item.path);
    if (!exclusionPath || !isTimestamp(item.addedAt) || exclusions.some((exclusion) => exclusion.path === exclusionPath)) return undefined;
    exclusions.push({ path: exclusionPath, addedAt: item.addedAt });
  }
  return { global, projects, exclusions };
}

function parseBinding(input: unknown): ScopeBinding | undefined {
  if (!isRecord(input)) return undefined;
  const allowed = ["status", "identityDigest", "provenance", "actorId", "architectureId", "environmentId", "profileId", "name", "target"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return undefined;
  const status = input.status;
  if (status !== "registering" && status !== "registered" && status !== "active") return undefined;
  const provenance = parseScopeProvenance(input.provenance);
  if (!DIGEST_PATTERN.test(String(input.identityDigest)) || !provenance) return undefined;
  for (const key of ["actorId", "architectureId", "environmentId", "profileId"] as const) {
    if (typeof input[key] !== "string" || !IDENTIFIER_PATTERN.test(input[key] as string)) return undefined;
  }
  if (typeof input.name !== "string" || !input.name || input.name.length > 120 || CONTROL_CHARACTER_PATTERN.test(input.name)) return undefined;
  let target: ArchitectureTarget | undefined;
  if (status === "registering") {
    if (input.target !== undefined) return undefined;
  } else {
    try { target = assertValidArchitectureTarget(input.target); } catch { return undefined; }
  }
  return {
    status,
    identityDigest: input.identityDigest as string,
    provenance,
    actorId: input.actorId as string,
    architectureId: input.architectureId as string,
    environmentId: input.environmentId as string,
    profileId: input.profileId as string,
    name: input.name,
    ...(target ? { target } : {}),
  };
}

function parseManagedReference(input: unknown): ManagedWorkspaceReference | undefined {
  if (!isRecord(input) || !exactKeys(input, ["adapterKind", "targetId", "identityDigest", "generation", "ownerId", "provenance", "bindingDigest", "adoptedAt"])) return undefined;
  const provenance = parseScopeProvenance(input.provenance);
  if (input.adapterKind !== "codex-workspace" || !provenance
    || typeof input.targetId !== "string" || !IDENTIFIER_PATTERN.test(input.targetId)
    || typeof input.ownerId !== "string" || !IDENTIFIER_PATTERN.test(input.ownerId)
    || !DIGEST_PATTERN.test(String(input.identityDigest)) || !DIGEST_PATTERN.test(String(input.bindingDigest))
    || typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 1
    || !isTimestamp(input.adoptedAt)) return undefined;
  return {
    adapterKind: "codex-workspace",
    targetId: input.targetId,
    identityDigest: input.identityDigest as string,
    generation: input.generation,
    ownerId: input.ownerId,
    provenance,
    bindingDigest: input.bindingDigest as string,
    adoptedAt: input.adoptedAt as string,
  };
}

export function parseScopeProvenance(input: unknown): ScopeProvenance | undefined {
  if (!isRecord(input) || !exactKeys(input, ["origin", "instanceId"])) return undefined;
  if (typeof input.origin !== "string" || typeof input.instanceId !== "string" || !INSTANCE_PATTERN.test(input.instanceId)) return undefined;
  try {
    const url = new URL(input.origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
  } catch {
    return undefined;
  }
  return { origin: input.origin, instanceId: input.instanceId };
}

function storedPath(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value && !CONTROL_CHARACTER_PATTERN.test(value) ? value : undefined;
}

function storedIdentity(value: unknown): ScopeRootIdentity | undefined {
  return isRecord(value) && exactKeys(value, ["ino"]) && typeof value.ino === "string" && /^\d{1,24}$/.test(value.ino) ? { ino: value.ino } : undefined;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Resolution and overlap rules

export interface ScopeResolution {
  owner: "global" | "project" | "excluded" | "unowned";
  matchedRoot?: string;
  mode?: "inventory" | "managed";
  targetId?: string;
  status?: ScopeBindingStatus | "managed";
}

/**
 * Deepest canonical match wins among project scopes and exclusions. A project
 * scope beats an exclusion at the same root. An exclusion is terminal: it never
 * falls back to an enclosing project or to the global scope. With no match the
 * provider's global scope owns the path when one is enrolled.
 */
export function resolveScopeOwner(state: ScopeState, provider: ScopeProvider, canonicalPath: string): ScopeResolution {
  const scopes = state.providers[provider];
  let best: { depth: number; project?: ProjectScopeRecord; exclusion?: ScopeExclusion } | undefined;
  for (const project of scopes.projects) {
    if (!pathContains(project.root, canonicalPath)) continue;
    const depth = pathDepth(project.root);
    if (!best || depth > best.depth) best = { depth, project };
  }
  // Strictly deeper only: at an equal root the project scope keeps ownership.
  for (const exclusion of scopes.exclusions) {
    if (!pathContains(exclusion.path, canonicalPath)) continue;
    const depth = pathDepth(exclusion.path);
    if (!best || depth > best.depth) best = { depth, exclusion };
  }
  if (best?.exclusion) return { owner: "excluded", matchedRoot: best.exclusion.path };
  if (best?.project) {
    const project = best.project;
    const targetId = project.mode === "managed" ? project.managed?.targetId : project.binding?.target?.id;
    return {
      owner: "project",
      matchedRoot: project.root,
      mode: project.mode,
      ...(targetId ? { targetId } : {}),
      status: project.mode === "managed" ? "managed" : project.binding!.status,
    };
  }
  if (scopes.global) {
    const targetId = scopes.global.binding.target?.id;
    return { owner: "global", matchedRoot: scopes.global.root, ...(targetId ? { targetId } : {}), status: scopes.global.binding.status };
  }
  return { owner: "unowned" };
}

export function assertGlobalRootAllowed(scopes: ProviderScopes, root: string): void {
  if (scopes.projects.some((project) => pathsOverlap(project.root, root)) || scopes.exclusions.some((exclusion) => pathsOverlap(exclusion.path, root))) {
    throw new ScopeError("SCOPE_OVERLAP", "The global skills directory overlaps an enrolled project or an exclusion for this provider.", 2);
  }
}

export function assertProjectRootAllowed(scopes: ProviderScopes, root: string): void {
  if (scopes.global && pathsOverlap(scopes.global.root, root)) {
    throw new ScopeError("SCOPE_OVERLAP", "A project cannot contain, equal, or sit inside the provider's global skills directory.", 2);
  }
  if (scopes.projects.length >= MAX_RULES_PER_PROVIDER && !scopes.projects.some((project) => project.root === root)) {
    throw new ScopeError("SCOPE_STATE_LIMIT", `A provider can have at most ${MAX_RULES_PER_PROVIDER} project scopes.`, 2);
  }
}

export function assertExclusionAllowed(scopes: ProviderScopes, exclusionPath: string): void {
  if (scopes.global && pathsOverlap(scopes.global.root, exclusionPath)) {
    throw new ScopeError("SCOPE_OVERLAP", "An exclusion cannot contain, equal, or sit inside the provider's global skills directory.", 2);
  }
  if (scopes.exclusions.length >= MAX_RULES_PER_PROVIDER && !scopes.exclusions.some((exclusion) => exclusion.path === exclusionPath)) {
    throw new ScopeError("SCOPE_STATE_LIMIT", `A provider can have at most ${MAX_RULES_PER_PROVIDER} exclusions.`, 2);
  }
}

export function sortProviderScopes(scopes: ProviderScopes): void {
  scopes.projects.sort((left, right) => compareOrdinal(left.root, right.root));
  scopes.exclusions.sort((left, right) => compareOrdinal(left.path, right.path));
}

// ---------------------------------------------------------------------------
// Registry target contract

export function parseScopeTarget(input: unknown, provider: ScopeProvider, scope?: ScopeKind): ArchitectureTarget {
  if (!isRecord(input)) throw new ScopeError("SCOPE_TARGET_INVALID", "The registry did not return a valid target.");
  const fields = ["schemaVersion", "id", "name", "owner", "adapter", "architectureId", "environmentId", "profileId", "status", "consent", "generation", "identityDigest", "capabilities", "metadata", "createdAt", "updatedAt"];
  let target: ArchitectureTarget;
  try {
    target = assertValidArchitectureTarget(Object.fromEntries(fields.filter((key) => input[key] !== undefined).map((key) => [key, input[key]])));
  } catch {
    throw new ScopeError("SCOPE_TARGET_INVALID", "The registry did not return a valid target.");
  }
  const expected = scopeAdapterDescriptor(provider);
  const metadataProvider = target.metadata?.provider;
  const metadataScope = target.metadata?.scope;
  if (target.adapter.kind !== expected.kind || (metadataProvider !== undefined && metadataProvider !== provider)) {
    throw new ScopeError("SCOPE_TARGET_PROVIDER_MISMATCH", `The registry target is not a ${provider} inventory target. Do not reuse a binding across providers.`);
  }
  if (scope !== undefined && metadataScope !== undefined && metadataScope !== scope) {
    throw new ScopeError("SCOPE_TARGET_PROVIDER_MISMATCH", `The registry target does not belong to the ${scope} scope.`);
  }
  if (target.adapter.version !== expected.version || target.adapter.contractVersion !== expected.contractVersion
    || target.capabilities.apply === true || target.capabilities.rollback === true || target.capabilities["sync.write"] === true
    || target.capabilities["inventory.read"] !== true) {
    throw new ScopeError("SCOPE_TARGET_CONTRACT_MISMATCH", "The registry target is not a read-only inventory target.");
  }
  if (target.owner.type !== "user") {
    throw new ScopeError("SCOPE_TARGET_OWNER_INVALID", "Workspace scopes require a personal, user-owned target.");
  }
  return target;
}

// ---------------------------------------------------------------------------
// Inventory

export type ScopeInvalidReason = "invalid-name" | "definition-missing" | "definition-invalid";
export type ScopeSkippedReason = "hidden" | "not-a-directory" | "managed-install-state";

export interface ScopeInventory {
  location: "present" | "absent" | "linked" | "unavailable";
  skills: Array<{ slug: string; definitionDigest: string }>;
  withheld: string[];
  linked: string[];
  invalid: Array<{ name: string; reason: ScopeInvalidReason }>;
  skipped: Array<{ name: string; reason: ScopeSkippedReason }>;
  truncated: { entriesNotExamined: boolean; skillsNotListed: string[] };
  findings: ArchitectureTargetConfigFinding[];
  /**
   * True only when every immediate entry was examined and every entry that
   * could hold a skill (a directory, link, or hidden directory) was listed.
   * Regular files and MySkills' own `.myskills-app` state do not affect it.
   */
  complete: boolean;
  incompleteReasons: string[];
}

const FINDING_SEVERITY: Record<string, ArchitectureTargetConfigFinding["severity"]> = {
  "skills-location-absent": "info",
  "skills-location-linked": "warning",
  "skills-location-unavailable": "error",
  "skill-linked": "warning",
  "skill-name-invalid": "warning",
  "skill-definition-missing": "warning",
  "skill-definition-invalid": "warning",
  "skill-name-withheld": "warning",
  "skill-hidden-skipped": "info",
  "skill-entry-skipped": "info",
  "managed-install-state-ignored": "info",
  "inventory-truncated": "error",
};

/** Locate a project's provider skills directory without following links. */
export async function projectSkillsDirectory(projectRoot: string, provider: ScopeProvider): Promise<{ path: string; location: ScopeInventory["location"] }> {
  let current = projectRoot;
  for (const component of projectSkillsLocation[provider]) {
    current = path.join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return { path: current, location: "linked" };
      if (!entry.isDirectory()) return { path: current, location: "unavailable" };
    } catch (error) {
      return { path: current, location: errorCode(error) === "ENOENT" ? "absent" : "unavailable" };
    }
  }
  return { path: current, location: "present" };
}

/**
 * Read one explicitly selected skills directory: its immediate entries and each
 * candidate's SKILL.md. Nothing else is opened. Links are reported, never
 * followed. Skill bodies stay local; only a SHA-256 of SKILL.md is kept.
 */
export async function inventorySkillsDirectory(root: string, location: ScopeInventory["location"] = "present"): Promise<ScopeInventory> {
  const inventory: ScopeInventory = {
    location,
    skills: [],
    withheld: [],
    linked: [],
    invalid: [],
    skipped: [],
    truncated: { entriesNotExamined: false, skillsNotListed: [] },
    findings: [],
    complete: false,
    incompleteReasons: [],
  };
  const counts = new Map<string, number>();
  const add = (code: string, count = 1) => { if (count > 0) counts.set(code, (counts.get(code) ?? 0) + count); };
  let hiddenDirectories = 0;
  if (location === "absent") add("skills-location-absent");
  if (location === "linked") add("skills-location-linked");
  if (location === "unavailable") add("skills-location-unavailable");
  if (location !== "present") return finishInventory(inventory, counts, hiddenDirectories);

  const names: string[] = [];
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (names.length >= MAX_ROOT_ENTRIES) {
        inventory.truncated.entriesNotExamined = true;
        break;
      }
      names.push(entry.name);
    }
  } catch {
    inventory.location = "unavailable";
    add("skills-location-unavailable");
    return finishInventory(inventory, counts, hiddenDirectories);
  }
  names.sort(compareOrdinal);
  const valid: Array<{ slug: string; definitionDigest: string }> = [];
  for (const name of names) {
    const entryPath = path.join(root, name);
    if (name === ".myskills-app") {
      inventory.skipped.push({ name, reason: "managed-install-state" });
      continue;
    }
    if (name.startsWith(".")) {
      inventory.skipped.push({ name, reason: "hidden" });
      // Hidden directories (for example a bundled `.system` set) are never
      // read, so they may hold skills this inventory does not list.
      try {
        const hidden = await lstat(entryPath);
        if (hidden.isDirectory() || hidden.isSymbolicLink()) hiddenDirectories += 1;
      } catch {
        hiddenDirectories += 1;
      }
      continue;
    }
    let entry;
    try {
      entry = await lstat(entryPath);
    } catch {
      inventory.invalid.push({ name, reason: "definition-invalid" });
      continue;
    }
    if (entry.isSymbolicLink()) {
      inventory.linked.push(name);
      continue;
    }
    if (!entry.isDirectory()) {
      inventory.skipped.push({ name, reason: "not-a-directory" });
      continue;
    }
    if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
      inventory.invalid.push({ name, reason: "invalid-name" });
      continue;
    }
    const definition = await readSkillDefinition(entryPath, name);
    if (definition.status !== "valid") {
      inventory.invalid.push({ name, reason: definition.status });
      continue;
    }
    valid.push({ slug: name, definitionDigest: definition.digest });
  }
  inventory.skills = valid.slice(0, architectureTargetLimits.skills);
  inventory.truncated.skillsNotListed = valid.slice(architectureTargetLimits.skills).map((skill) => skill.slug);
  add("skill-linked", inventory.linked.length);
  add("skill-name-withheld", inventory.withheld.length);
  for (const item of inventory.invalid) {
    add(item.reason === "invalid-name" ? "skill-name-invalid" : item.reason === "definition-missing" ? "skill-definition-missing" : "skill-definition-invalid");
  }
  for (const item of inventory.skipped) {
    add(item.reason === "hidden" ? "skill-hidden-skipped" : item.reason === "not-a-directory" ? "skill-entry-skipped" : "managed-install-state-ignored");
  }
  add("inventory-truncated", inventory.truncated.skillsNotListed.length + (inventory.truncated.entriesNotExamined ? 1 : 0));
  return finishInventory(inventory, counts, hiddenDirectories);
}

/** Derive an explicit partial upload for a server without the new capability. */
export function inventoryForObservationServer(inventory: ScopeInventory, supportsValidatedSlugs: boolean): ScopeInventory {
  if (supportsValidatedSlugs) return inventory;
  const withheld = inventory.skills.filter((skill) => LEGACY_SERVER_PRIVACY_WORD_PATTERN.test(skill.slug)).map((skill) => skill.slug);
  if (withheld.length === 0) return inventory;
  return {
    ...inventory,
    skills: inventory.skills.filter((skill) => !LEGACY_SERVER_PRIVACY_WORD_PATTERN.test(skill.slug)),
    withheld: [...inventory.withheld, ...withheld].sort(compareOrdinal),
    findings: [
      ...inventory.findings.filter((finding) => finding.code !== "skill-name-withheld"),
      { code: "skill-name-withheld", severity: "warning" as const, count: inventory.withheld.length + withheld.length },
    ].sort((left, right) => compareOrdinal(left.code, right.code)),
    complete: false,
    incompleteReasons: [...new Set([...inventory.incompleteReasons, "withheld"])],
  };
}

function finishInventory(inventory: ScopeInventory, counts: Map<string, number>, hiddenDirectories: number): ScopeInventory {
  inventory.findings = [...counts.entries()]
    .map(([code, count]) => ({ code, severity: FINDING_SEVERITY[code] ?? "warning", count }))
    .sort((left, right) => compareOrdinal(left.code, right.code));
  const reasons: Array<[boolean, string]> = [
    [inventory.location === "linked", "location-linked"],
    [inventory.location === "unavailable", "location-unavailable"],
    [inventory.truncated.entriesNotExamined || inventory.truncated.skillsNotListed.length > 0, "truncated"],
    [inventory.withheld.length > 0, "withheld"],
    [inventory.linked.length > 0, "linked"],
    [inventory.invalid.length > 0, "invalid"],
    [hiddenDirectories > 0, "hidden-directory"],
  ];
  inventory.incompleteReasons = reasons.filter(([applies]) => applies).map(([, reason]) => reason);
  inventory.complete = inventory.incompleteReasons.length === 0;
  return inventory;
}

async function readSkillDefinition(directory: string, name: string): Promise<{ status: "valid"; digest: string } | { status: "definition-missing" | "definition-invalid" }> {
  let content: string;
  try {
    content = await readRegularText(path.join(directory, "SKILL.md"), MAX_DEFINITION_BYTES);
  } catch (error) {
    return { status: errorCode(error) === "ENOENT" ? "definition-missing" : "definition-invalid" };
  }
  try {
    // Codex and Claude share the SKILL.md frontmatter rule MySkills checks:
    // YAML `name` equal to the directory name and a nonempty `description`.
    validateCodexSkill([{ path: "SKILL.md", content }], name);
  } catch {
    return { status: "definition-invalid" };
  }
  return { status: "valid", digest: sha256Hex(content) };
}

export function inventoryHealth(inventory: ScopeInventory, provider: ScopeProvider, scope: ScopeKind, now: Date): ArchitectureTargetHealth {
  const status = inventory.location === "linked" || inventory.location === "unavailable"
    ? "unavailable"
    : inventory.findings.some((finding) => finding.severity !== "info") ? "degraded" : "healthy";
  return {
    status,
    checkedAt: now.toISOString(),
    metadata: { provider, scope, runtimeRecognized: false, inventoryComplete: inventory.complete, skillCount: inventory.skills.length },
  };
}

export function buildScopeObservation(
  target: ArchitectureTarget,
  inventory: ScopeInventory,
  provider: ScopeProvider,
  scope: ScopeKind,
  now: Date,
): ArchitectureTargetObservation {
  const observation = {
    schemaVersion: 1 as const,
    targetId: target.id,
    targetGeneration: target.generation,
    adapterDigest: architectureTargetAdapterDigest(target.adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities, target.adapter.contractVersion),
    observedAt: now.toISOString(),
    skills: inventory.skills.map((skill) => ({ slug: skill.slug, managed: false, metadata: { definitionDigest: skill.definitionDigest } })),
    configFindings: inventory.findings,
    promptAwareness: { detected: false, count: 0, redacted: true },
    metadata: { provider, scope, runtimeRecognized: false, inventoryComplete: inventory.complete },
  };
  const validated = assertValidArchitectureTargetObservation({ ...observation, observedDigest: architectureTargetObservationDigest(observation) });
  return validated;
}

// ---------------------------------------------------------------------------
// Existing managed Codex workspace bindings (pre-scope local format)

export function managedWorkspaceBindingPath(projectRoot: string): string {
  return path.join(projectRoot, ...projectSkillsLocation.codex, ".myskills-app", "codex-workspace.json");
}

export async function managedWorkspaceBindingPresent(projectRoot: string): Promise<boolean> {
  try {
    await lstat(managedWorkspaceBindingPath(projectRoot));
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    return true;
  }
}

interface LegacyWorkspaceInspection {
  binding: { state: "absent" } | { state: "invalid" } | { state: "valid"; target: ArchitectureTarget; provenance: ScopeProvenance; digest: string };
  bindingDigest: string;
  installRegistry: { digest: string; unreadable: boolean; withoutProvenance: number };
}

async function inspectLegacyWorkspace(projectRoot: string): Promise<LegacyWorkspaceInspection> {
  const skillsRoot = path.join(projectRoot, ...projectSkillsLocation.codex);
  const inspection: LegacyWorkspaceInspection = {
    binding: { state: "absent" },
    bindingDigest: "absent",
    installRegistry: { digest: "absent", unreadable: false, withoutProvenance: 0 },
  };
  let text: string | undefined;
  try {
    text = await readRegularText(managedWorkspaceBindingPath(projectRoot), 32 * 1024);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
      inspection.binding = { state: "invalid" };
      inspection.bindingDigest = "unreadable";
    }
  }
  if (text !== undefined) {
    inspection.bindingDigest = sha256Hex(text);
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const provenance = normalizeLegacyProvenance(value.provenance);
      if (!isRecord(value) || value.schemaVersion !== 1 || value.rootDigest !== workspaceRootDigest(skillsRoot) || !provenance) throw new Error("binding");
      inspection.binding = { state: "valid", target: parseWorkspaceTarget(value.target), provenance, digest: inspection.bindingDigest };
    } catch {
      inspection.binding = { state: "invalid" };
    }
  }
  try {
    const registryText = await readRegularText(path.join(skillsRoot, ".myskills-app", "installed.json"));
    inspection.installRegistry.digest = sha256Hex(registryText);
    const registry = JSON.parse(registryText) as unknown;
    if (!isRecord(registry) || !isRecord(registry.installations)) throw new Error("registry");
    inspection.installRegistry.withoutProvenance = Object.values(registry.installations)
      .filter((installation) => !isRecord(installation) || !isRecord(installation.provenance)).length;
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") {
      inspection.installRegistry.unreadable = true;
      if (inspection.installRegistry.digest === "absent") inspection.installRegistry.digest = "unreadable";
    }
  }
  return inspection;
}

/** The pre-scope binding stored origin with the same normalization as the CLI. */
function normalizeLegacyProvenance(input: unknown): ScopeProvenance | undefined {
  if (!isRecord(input) || typeof input.origin !== "string" || typeof input.instanceId !== "string") return undefined;
  try {
    return parseScopeProvenance({ origin: new URL(input.origin.trim().replace(/\/+$/, "")).href.replace(/\/+$/, ""), instanceId: input.instanceId.toLowerCase() });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Migration planning

export type ScopeMigrationAction =
  | { type: "add-exclusion" }
  | { type: "adopt-managed-binding"; targetId: string; adapter: "codex-workspace"; generation: number };

export interface ScopeMigrationPlan {
  schema: typeof SCOPE_MIGRATION_SCHEMA;
  provider: ScopeProvider;
  project: string;
  currentOwner: ScopeResolution["owner"];
  actions: ScopeMigrationAction[];
  blockers: string[];
  preconditions: { stateDigest: string; bindingDigest: string; installRegistryDigest: string; projectIdentity: string };
  planDigest: string;
  writes: false;
  nativeInheritance: "unchanged";
}

/**
 * Compute a reviewable, read-only migration for one project. The digest binds
 * the exact local state bytes, the existing binding bytes, and the install
 * registry bytes, so any intervening change makes the preview stale.
 */
export async function planScopeMigration(snapshot: ScopeStateSnapshot, provider: ScopeProvider, project: { path: string; identity: ScopeRootIdentity }): Promise<{ plan: ScopeMigrationPlan; adoption?: ManagedWorkspaceReference }> {
  const scopes = snapshot.state.providers[provider];
  const actions: ScopeMigrationAction[] = [];
  const blockers: string[] = [];
  const currentOwner = resolveScopeOwner(snapshot.state, provider, project.path).owner;
  if (scopes.global && pathsOverlap(scopes.global.root, project.path)) blockers.push("project-overlaps-global-location");
  if (!scopes.exclusions.some((exclusion) => exclusion.path === project.path)) actions.push({ type: "add-exclusion" });
  let bindingDigest = "absent";
  let installRegistryDigest = "absent";
  let adoption: ManagedWorkspaceReference | undefined;
  if (provider === "codex") {
    const legacy = await inspectLegacyWorkspace(project.path);
    bindingDigest = legacy.bindingDigest;
    installRegistryDigest = legacy.installRegistry.digest;
    const existing = scopes.projects.find((record) => record.root === project.path);
    if (legacy.binding.state === "invalid") blockers.push("workspace-binding-invalid");
    if (legacy.binding.state === "valid") {
      const target = legacy.binding.target;
      if (legacy.installRegistry.unreadable) blockers.push("install-registry-unreadable");
      if (legacy.installRegistry.withoutProvenance > 0) blockers.push("legacy-installations-without-provenance");
      if (!existing) {
        actions.push({ type: "adopt-managed-binding", targetId: target.id, adapter: "codex-workspace", generation: target.generation });
        adoption = {
          adapterKind: "codex-workspace",
          targetId: target.id,
          identityDigest: target.identityDigest,
          generation: target.generation,
          ownerId: target.owner.id,
          provenance: legacy.binding.provenance,
          bindingDigest: legacy.binding.digest,
          adoptedAt: new Date().toISOString(),
        };
      } else if (existing.mode === "inventory") {
        blockers.push("inventory-scope-present");
      } else if (existing.managed?.targetId !== target.id || existing.managed.identityDigest !== target.identityDigest) {
        blockers.push("managed-binding-changed");
      }
    }
  }
  const preconditions = {
    stateDigest: snapshot.bytes === null ? "absent" : sha256Hex(snapshot.bytes),
    bindingDigest,
    installRegistryDigest,
    projectIdentity: project.identity.ino,
  };
  const sortedBlockers = [...new Set(blockers)].sort(compareOrdinal);
  const planDigest = sha256Hex(canonicalizeJson({ schema: SCOPE_MIGRATION_SCHEMA, provider, project: project.path, preconditions, actions, blockers: sortedBlockers }));
  return {
    plan: {
      schema: SCOPE_MIGRATION_SCHEMA,
      provider,
      project: project.path,
      currentOwner,
      actions,
      blockers: sortedBlockers,
      preconditions,
      planDigest,
      writes: false,
      nativeInheritance: "unchanged",
    },
    ...(adoption ? { adoption } : {}),
  };
}

export function applyScopeMigration(state: ScopeState, provider: ScopeProvider, project: { path: string; identity: ScopeRootIdentity }, plan: ScopeMigrationPlan, adoption?: ManagedWorkspaceReference): ScopeState {
  const next = JSON.parse(JSON.stringify(state)) as ScopeState;
  const scopes = next.providers[provider];
  for (const action of plan.actions) {
    if (action.type === "add-exclusion") scopes.exclusions.push({ path: project.path, addedAt: new Date().toISOString() });
    if (action.type === "adopt-managed-binding") {
      if (!adoption || adoption.targetId !== action.targetId) throw new ScopeError("SCOPE_MIGRATION_STALE", "The migration preview no longer matches the workspace binding.");
      scopes.projects.push({ root: project.path, rootIdentity: project.identity, mode: "managed", managed: adoption });
    }
  }
  sortProviderScopes(scopes);
  return next;
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
