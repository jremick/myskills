import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizePackageFilePath } from "@myskills-app/skill-package";

interface LockOwner { pid: number; token: string }
const activeLocks = new Set<string>();

// Safety boundary: locks serialize cooperating MySkills processes. Private
// staging, no-follow payload IO, and byte checks prevent package-driven escapes
// and detect drift. Node's path-based mkdir/rename on macOS cannot isolate these
// transactions from a hostile process running as the same OS user that swaps
// directory ancestry during a mutation; that requires native dirfd primitives.

/** Every reader and writer uses the same root lock, including crash recovery. */
export async function withInstallRootLock<T>(inputRoot: string, work: (root: string) => Promise<T>): Promise<T> {
  const root = await prepareInstallRoot(inputRoot);
  const lockPath = path.join(root, ".myskills-app", "write.lock");
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const handle = await openWithoutSymlinks(path.join(lockPath, "owner.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(JSON.stringify(owner), "utf8"); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      await reclaimDeadLock(lockPath);
      if (Date.now() >= deadline) throw new Error("The installation root is busy or has an ambiguous lock. Retry after the other command exits; preserve an ambiguous lock for operator recovery.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  activeLocks.add(root);
  try {
    return await work(root);
  } finally {
    activeLocks.delete(root);
    const current = await readLockOwner(lockPath);
    if (current?.token === owner.token) await rm(lockPath, { recursive: true });
  }
}

export function assertInstallRootLocked(root: string): void {
  if (!activeLocks.has(root)) throw new Error("Installation state requires an exclusive root lock.");
}

async function reclaimDeadLock(lockPath: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (!owner || processExists(owner.pid)) return;
  // Only one contender may reap a dead owner. A crashed reaper deliberately
  // leaves an ambiguous lock, rather than risk deleting a new live owner's lock.
  const claimPath = path.join(lockPath, "reaping");
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOENT") return;
    throw error;
  }
  const current = await readLockOwner(lockPath);
  if (current?.token === owner.token && !processExists(current.pid)) {
    await rm(lockPath, { recursive: true });
  } else {
    await rmdir(claimPath);
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const entry = await lstat(lockPath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Installation lock is not a regular directory.");
    const value = JSON.parse(await readRegularText(path.join(lockPath, "owner.json"), 1024)) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/.test(value.token)) {
      throw new Error("Installation lock owner is invalid.");
    }
    return value as LockOwner;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) !== "ESRCH"; }
}

export async function prepareInstallRoot(inputRoot: string): Promise<string> {
  const requested = path.resolve(inputRoot);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(requested);
  const root = await realpath(requested);
  await ensureSafeDirectory(root, path.join(root, ".myskills-app"));
  return root;
}

/** Descendants of the selected real root may never be symlinks. */
export async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Filesystem destination escapes the selected root.");
  await assertRegularDirectory(root);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    await assertRegularDirectory(current);
  }
}

export async function assertRegularDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Filesystem directory must not be a symlink or special file.");
}

export async function readRegularText(filePath: string, maximumBytes = 8 * 1024 * 1024): Promise<string> {
  const handle = await openWithoutSymlinks(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error("Local state must be a bounded regular file.");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(filePath);
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw new Error("Local state changed while it was read.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
  } finally { await handle.close(); }
}

export async function atomicPrivateWrite(root: string, filePath: string, content: string): Promise<void> {
  await ensureSafeDirectory(root, path.dirname(filePath));
  try {
    const current = await lstat(filePath);
    if (!current.isFile() || current.isSymbolicLink()) throw new Error("Local state destination must be a regular file.");
  } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await openWithoutSymlinks(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await ensureSafeDirectory(root, path.dirname(filePath));
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }); }
}

export function validatePortableFilePaths(files: readonly { path: string; content: string }[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    const normalized = normalizePackageFilePath(file.path);
    const folded = normalized.normalize("NFC").toLowerCase();
    if (paths.has(folded)) throw new Error("Package has paths that collide on a supported filesystem.");
    for (const component of normalized.split("/")) {
      if (/[<>:"|?*\u0000-\u001f]/u.test(component) || /[. ]$/.test(component)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw new Error("Package contains a non-portable filename.");
    }
    paths.add(folded);
  }
  for (const file of paths) {
    const components = file.split("/");
    while (components.length > 1) {
      components.pop();
      if (paths.has(components.join("/"))) throw new Error("Package contains a file/directory collision.");
    }
  }
}

export async function writeNewPackageTree(root: string, directory: string, files: readonly { path: string; content: string }[]): Promise<void> {
  validatePortableFilePaths(files);
  await ensureSafeDirectory(root, path.dirname(directory));
  await mkdir(directory, { mode: 0o700 });
  for (const file of files) {
    const destination = path.join(directory, normalizePackageFilePath(file.path));
    await ensureSafeDirectory(directory, path.dirname(destination));
    const handle = await openWithoutSymlinks(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(file.content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  }
  await verifyWrittenTree(directory, files);
}

async function verifyWrittenTree(directory: string, files: readonly { path: string; content: string }[]): Promise<void> {
  const expectedFiles = new Map(files.map((file) => [normalizePackageFilePath(file.path), file.content]));
  let count = 0;
  async function visit(current: string, relative: string): Promise<void> {
    await assertRegularDirectory(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile() && expectedFiles.has(childRelative)) {
        const content = expectedFiles.get(childRelative)!;
        if ((await lstat(child)).nlink !== 1 || await readRegularText(child, Buffer.byteLength(content)) !== content) throw new Error("Staged export bytes changed before verification.");
        count += 1;
      } else throw new Error("Staged package contains an unexpected file or symlink.");
    }
  }
  await visit(directory, "");
  if (count !== files.length) throw new Error("Staged package is incomplete.");
}

/** Reject ancestor substitution at open time, not only during prior inspection. */
async function openWithoutSymlinks(filePath: string, flags: number, mode?: number): Promise<FileHandle> {
  if (process.platform === "darwin") {
    // O_NOFOLLOW_ANY is defined by Darwin fcntl.h but is not exposed by Node.
    // It must not be combined with O_NOFOLLOW (Darwin returns EINVAL).
    return open(filePath, flags | 0x20000000, mode);
  }
  if (process.platform !== "linux") throw new Error("Safe local skill filesystem operations require macOS or Linux.");
  const components = path.resolve(filePath).split(path.sep).filter(Boolean);
  const leaf = components.pop();
  if (!leaf) throw new Error("A regular file path is required.");
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(`/proc/self/fd/${parent.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close();
      parent = next;
    }
    return await open(`/proc/self/fd/${parent.fd}/${leaf}`, flags | constants.O_NOFOLLOW, mode);
  } finally { await parent.close(); }
}

/** Exports replace only an absent or empty directory, after staging all bytes. */
export async function exportPackageTree(files: readonly { path: string; content: string }[], outputRoot: string): Promise<void> {
  const requested = path.resolve(outputRoot);
  await mkdir(path.dirname(requested), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(requested));
  const destination = path.join(parent, path.basename(requested));
  const staging = path.join(parent, `.myskills-export-${randomUUID()}`);
  try {
    await writeNewPackageTree(parent, staging, files);
    try {
      await assertRegularDirectory(destination);
      if ((await readdir(destination)).length !== 0) throw new Error("Export requires a new or empty output directory.");
      await rmdir(destination); // Fails if another actor added a file.
    } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    await rename(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
