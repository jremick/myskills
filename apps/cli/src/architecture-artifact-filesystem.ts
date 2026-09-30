import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { assertRegularDirectory, ensureSafeDirectory, errorCode } from "./install-filesystem.js";

export type ArtifactDurabilityEvent = { phase: "before-sync" | "after-sync"; directory: string };
export type ArtifactDurabilityObserver = (event: ArtifactDurabilityEvent) => void | Promise<void>;

export async function syncArtifactDirectory(directory: string, observe?: ArtifactDurabilityObserver): Promise<void> {
  await assertRegularDirectory(directory);
  await observe?.({ phase: "before-sync", directory });
  const handle = await open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const named = await lstat(directory);
    if (!opened.isDirectory() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) throw new Error("Artifact directory changed before durability sync.");
    await handle.sync();
  } finally { await handle.close(); }
  await observe?.({ phase: "after-sync", directory });
}

/** Sync every link to the workspace, including entries left by a failed retry. */
export async function durableArtifactDirectory(root: string, directory: string, observe?: ArtifactDurabilityObserver): Promise<void> {
  await ensureSafeDirectory(root, directory);
  for (let current = directory; ; current = path.dirname(current)) {
    await syncArtifactDirectory(current, observe);
    if (current === root) break;
  }
}

/** Files were synced by writeNewPackageTree; commit nested directory entries too. */
export async function syncArtifactTree(root: string, stage: string, observe?: ArtifactDurabilityObserver): Promise<void> {
  let directories = 0;
  async function visit(directory: string): Promise<void> {
    if (++directories > 10_000) throw new Error("Artifact staging directory limit exceeded.");
    await assertRegularDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else if (!entry.isFile()) throw new Error("Artifact staging contains a link or special file.");
    }
    await syncArtifactDirectory(directory, observe);
  }
  await visit(stage);
  await durableArtifactDirectory(root, path.dirname(stage), observe);
}

/** Managed roots must be disjoint. Only inspect directory names and binding presence. */
export async function assertIsolatedArtifactWorkspace(workspace: string): Promise<void> {
  const components = workspace.split(path.sep);
  if (components.some((part, index) => [".agents", ".claude"].includes(part) && components[index + 1] === "skills")) throw new Error("A managed workspace cannot be inside a provider discovery tree.");
  const binding = (directory: string) => path.join(directory, ".agents", "skills", ".myskills-app", "codex-workspace.json");
  async function enrolled(directory: string): Promise<boolean> {
    try { await lstat(binding(directory)); return true; }
    catch (error) { if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false; throw error; }
  }
  for (let ancestor = path.dirname(workspace); ; ancestor = path.dirname(ancestor)) {
    if (await enrolled(ancestor)) throw new Error("Managed workspace roots overlap an enrolled ancestor.");
    if (ancestor === path.dirname(ancestor)) break;
  }
  let directories = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (++directories > 10_000 || depth > 64) throw new Error("Managed workspace isolation cannot be proved within directory bounds.");
    await assertRegularDirectory(directory);
    if (directory !== workspace && await enrolled(directory)) throw new Error("Managed workspace roots overlap an enrolled descendant.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Symlinks cannot be enrolled roots; never follow them during discovery.
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
    }
  }
  await visit(workspace, 0);
}
