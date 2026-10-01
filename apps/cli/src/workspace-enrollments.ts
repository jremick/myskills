import { lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { atomicPrivateWrite, errorCode, readRegularText, withInstallRootLock } from "./install-filesystem.js";
import { parseWorkspaceTarget, workspaceRootDigest } from "./codex-workspace.js";
import { parseScopeProvenance, pathContains } from "./workspace-scopes.js";

interface BindingIdentity { rootDigest: string; targetId: string; targetIdentityDigest: string; origin: string; instanceId: string }
interface Enrollment { root: string; dev: string; ino: string; binding: BindingIdentity | null }
interface Index { schemaVersion: 1; enrollments: Enrollment[] }
const maximumBytes = 1024 * 1024;
const ambiguous = () => new Error("Workspace enrollment ownership is ambiguous. Preserve bindings and the enrollment index for explicit recovery.");
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === keys.sort().join(",");

/** Actual OS account authority; HOME, XDG and registry profiles cannot split it. */
export function workspaceEnrollmentDirectory(_env: Record<string, string | undefined>): string {
  return path.join(os.userInfo().homedir, ".config", "myskills-app", "workspace-enrollments");
}
/** Read-only migration source for reservations written by the previous client. */
export function legacyWorkspaceEnrollmentDirectory(env: Record<string, string | undefined>): string {
  const base = env.XDG_CONFIG_HOME ? path.join(path.resolve(env.XDG_CONFIG_HOME), "myskills-app") : path.join(os.homedir(), ".config", "myskills-app");
  return path.join(base, "workspace-enrollments");
}
export function assertOutsideDiscovery(workspace: string): void {
  const components = workspace.split(path.sep);
  if (components.some((part, index) => [".agents", ".claude"].includes(part) && components[index + 1] === "skills")) throw new Error("A managed workspace cannot be inside a provider discovery tree.");
}
async function bindingIdentity(workspace: string, discovery = false): Promise<BindingIdentity | null> {
  const root = path.join(workspace, ".agents", "skills");
  let text: string;
  try { text = await readRegularText(path.join(root, ".myskills-app", "codex-workspace.json"), 32 * 1024); }
  catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" || discovery && ["EACCES", "EPERM"].includes(errorCode(error) ?? "")) return null; throw ambiguous(); }
  try {
    let value;
    try { value = JSON.parse(text); } catch { if (discovery) return null; throw ambiguous(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) { if (discovery) return null; throw ambiguous(); }
    const provenance = parseScopeProvenance(value.provenance);
    // A malformed arbitrary marker is not an enrollment. A well-formed
    // binding with a changed canonical root remains ambiguous ownership.
    if (!exactKeys(value, ["schemaVersion", "rootDigest", "provenance", "target"]) || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.rootDigest) || !provenance) { if (discovery) return null; throw ambiguous(); }
    let target;
    try { target = parseWorkspaceTarget(value.target); } catch { if (discovery) return null; throw ambiguous(); }
    if (value.rootDigest !== workspaceRootDigest(root) || await realpath(root) !== root) throw ambiguous();
    return { rootDigest: value.rootDigest, targetId: target.id, targetIdentityDigest: target.identityDigest, ...provenance };
  } catch { throw ambiguous(); }
}
async function rootIdentity(root: string) {
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw ambiguous();
  return { dev: String(info.dev), ino: String(info.ino) };
}
function parseIndex(text: string): Index {
  try {
    const value = JSON.parse(text);
    if (!exactKeys(value, ["schemaVersion", "enrollments"]) || value.schemaVersion !== 1 || !Array.isArray(value.enrollments) || value.enrollments.length > 2048) throw ambiguous();
    const roots = new Set<string>();
    for (const entry of value.enrollments) {
      if (!exactKeys(entry, ["root", "dev", "ino", "binding"]) || typeof entry.root !== "string" || !path.isAbsolute(entry.root) || path.resolve(entry.root) !== entry.root || /[\u0000-\u001f]/.test(entry.root)
        || ![entry.dev, entry.ino].every(id => typeof id === "string" && /^\d{1,24}$/.test(id)) || roots.has(entry.root)) throw ambiguous();
      roots.add(entry.root);
      if (entry.binding !== null && (!exactKeys(entry.binding, ["rootDigest", "targetId", "targetIdentityDigest", "origin", "instanceId"])
        || !/^[a-f0-9]{64}$/.test(entry.binding.rootDigest) || !/^[a-f0-9]{64}$/.test(entry.binding.targetIdentityDigest)
        || typeof entry.binding.targetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry.binding.targetId) || !parseScopeProvenance({ origin: entry.binding.origin, instanceId: entry.binding.instanceId }))) throw ambiguous();
    }
    return value;
  } catch { throw ambiguous(); }
}

/** One protected index lock spans validation, registration, durable binding and index writes. */
export async function withWorkspaceEnrollment<T>(workspace: string, directory: string, enrolling: boolean, work: () => Promise<T>, options: { legacyDirectory?: string; onAuthorityWait?: () => void } = {}): Promise<T> {
  assertOutsideDiscovery(workspace);
  return withInstallRootLock(directory, async stateRoot => {
    const info = await lstat(stateRoot);
    if ((info.mode & 0o077) !== 0 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw ambiguous();
    const indexPath = path.join(stateRoot, "enrollments.json");
    let index: Index = { schemaVersion: 1, enrollments: [] };
    try { index = parseIndex(await readRegularText(indexPath, maximumBytes)); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    let migrated = false;
    if (options.legacyDirectory && path.resolve(options.legacyDirectory) !== stateRoot) {
      try {
        const legacy = await lstat(options.legacyDirectory);
        if (!legacy.isDirectory() || legacy.isSymbolicLink() || (legacy.mode & 0o077) !== 0 || typeof process.getuid === "function" && legacy.uid !== process.getuid()) throw ambiguous();
        const previous = parseIndex(await readRegularText(path.join(await realpath(options.legacyDirectory), "enrollments.json"), maximumBytes));
        for (const row of previous.enrollments) {
          const existing = index.enrollments.find(value => value.root === row.root);
          if (existing && (existing.dev !== row.dev || existing.ino !== row.ino || existing.binding && row.binding && JSON.stringify(existing.binding) !== JSON.stringify(row.binding))) throw ambiguous();
          if (existing && !existing.binding && row.binding) { existing.binding = row.binding; migrated = true; }
          if (!existing) { index.enrollments.push(row); migrated = true; }
        }
        if (index.enrollments.length > 2048) throw ambiguous();
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
    const current = await rootIdentity(workspace);
    for (const entry of index.enrollments) {
      const overlap = pathContains(entry.root, workspace) || pathContains(workspace, entry.root);
      if (!overlap) continue; // Preserve stale disjoint reservations without disabling other roots.
      if (entry.root !== workspace) throw new Error("Managed workspace roots overlap an enrolled ancestor or descendant. A missing root reservation requires explicit recovery.");
      let identity;
      try { identity = await rootIdentity(entry.root); } catch { throw ambiguous(); }
      if (identity.dev !== entry.dev || identity.ino !== entry.ino) throw ambiguous();
      const actual = await bindingIdentity(entry.root);
      if (entry.binding && JSON.stringify(actual) !== JSON.stringify(entry.binding)) throw ambiguous();
    }
    for (let ancestor = path.dirname(workspace); ; ancestor = path.dirname(ancestor)) {
      if (await bindingIdentity(ancestor, true)) throw new Error("Managed workspace roots overlap an enrolled ancestor.");
      if (ancestor === path.dirname(ancestor)) break;
    }
    // New enrollment is the explicit migration boundary for pre-index roots.
    // Ordinary install/update/rollback/companion operations never walk projects.
    // Validate legacy bindings, not marker presence. Do not follow symlinks or
    // enter provider payload/configuration trees. Unreadable unrelated trees
    // cannot host a currently usable binding and are left untouched.
    if (enrolling && !index.enrollments.some(entry => entry.root === workspace && entry.binding)) {
      const pending = [workspace];
      while (pending.length) {
        const directory = pending.pop()!;
        if (directory !== workspace && await bindingIdentity(directory, true)) throw new Error("Managed workspace roots overlap an enrolled descendant.");
        let children;
        try { children = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if (["EACCES", "EPERM"].includes(errorCode(error) ?? "")) continue; throw error; }
        for (const child of children) {
          // Only the actual provider discovery trees are forbidden roots.
          // A legacy .agents/project or .claude/project remains a valid root.
          const discovery = [".agents", ".claude"].includes(path.basename(directory)) && child.name === "skills";
          if (child.isDirectory() && !discovery) pending.push(path.join(directory, child.name));
        }
      }
    }
    const actual = await bindingIdentity(workspace);
    let entry = index.enrollments.find(row => row.root === workspace);
    if (!entry && (actual || enrolling)) {
      if (index.enrollments.length >= 2048) throw new Error("Workspace enrollment index is full. Preserve it for explicit recovery.");
      entry = { root: workspace, ...current, binding: actual };
      index.enrollments.push(entry);
    }
    const persist = async () => {
      const text = JSON.stringify(index, null, 2) + "\n";
      if (Buffer.byteLength(text) > maximumBytes) throw ambiguous();
      await atomicPrivateWrite(stateRoot, indexPath, text);
      const { syncArtifactDirectory } = await import("./architecture-artifact-filesystem.js");
      await syncArtifactDirectory(stateRoot);
    };
    if (entry || migrated) await persist(); // Reserve before an API target or local binding can be created.
    try { return await work(); }
    finally {
      if (entry) {
        const identity = await rootIdentity(workspace);
        if (identity.dev !== entry.dev || identity.ino !== entry.ino) throw ambiguous();
        const next = await bindingIdentity(workspace);
        if (entry.binding && JSON.stringify(next) !== JSON.stringify(entry.binding)) throw ambiguous();
        entry.binding = next;
        await persist();
      }
    }
  }, options.onAuthorityWait);
}
