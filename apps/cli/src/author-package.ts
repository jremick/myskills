import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { encodePackageArchive, readPackageDirectorySnapshot, type PackageSnapshot } from "@myskills-app/skill-package";
import { errorCode } from "./install-filesystem.js";

export interface PackageSkillResult {
  output: string;
  sha256: string;
  size: number;
  manifest: PackageSnapshot["manifest"];
  scan: PackageSnapshot["scan"];
}

export class SkillPackageDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillPackageDestinationError";
  }
}

/** Local only. All validation and encoding complete before the exclusive write. */
export async function packageSkill(
  options: { path: string; output: string },
  /** Internal fault seam for deterministic snapshot and destination race tests. */
  fault?: (point: "inspected" | "checked" | "created") => void | Promise<void>,
): Promise<PackageSkillResult> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Local skill packaging requires macOS or Linux.");
  const inputPath = await systemAliasPath(path.resolve(options.path));
  const outputPath = await systemAliasPath(path.resolve(options.output));
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(inputPath + outputPath)) throw new Error("Package paths must not contain control characters.");
  if (path.extname(outputPath).toLowerCase() !== ".zip") throw new SkillPackageDestinationError("Output must name a .zip file.");
  const source = await lstat(inputPath, { bigint: true });
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("Package input must be a regular directory.");
  const sourcePath = await realpath(inputPath);
  const parentPath = path.dirname(outputPath);
  assertOutsideSource(sourcePath, parentPath);
  const parent = await openDirectoryWithoutSymlinks(parentPath);
  try {
    const parentIdentity = await parent.stat({ bigint: true });
    await assertDestinationParent(parentPath, parent, parentIdentity, sourcePath);
    await fault?.("inspected");
    const snapshot = await readPackageDirectorySnapshot(inputPath);
    const bytes = encodePackageArchive(snapshot.files);
    await fault?.("checked");
    assertIdentity(source, await lstat(inputPath, { bigint: true }));
    await assertDestinationParent(parentPath, parent, parentIdentity, sourcePath);
    const destination = process.platform === "linux" ? `/proc/self/fd/${parent.fd}/${path.basename(outputPath)}` : outputPath;
    const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
    let output: FileHandle;
    try {
      output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new SkillPackageDestinationError("Output destination exists or appeared during packaging and will not be overwritten.");
      throw error;
    }
    try {
      await fault?.("created");
      await output.writeFile(bytes);
      await output.sync();
      const actual = await output.stat({ bigint: true });
      if (!actual.isFile() || actual.size !== BigInt(bytes.byteLength) || actual.nlink !== 1n) throw new Error("Archive output changed during creation.");
      assertIdentity(actual, await lstat(destination, { bigint: true }));
      await assertDestinationParent(parentPath, parent, parentIdentity, sourcePath);
    } catch {
      // Never unlink by name after a failure: another process may have replaced
      // that entry. Keep the partial file for explicit inspection/removal.
      throw new SkillPackageDestinationError("Archive creation failed after opening the output. A partial file may remain; inspect it before removing it or choosing a new destination.");
    } finally { await output.close(); }
    return {
      output: outputPath, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength,
      manifest: snapshot.manifest, scan: snapshot.scan,
    };
  } finally { await parent.close(); }
}

function assertOutsideSource(sourcePath: string, directory: string): void {
  const relative = path.relative(sourcePath, directory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new SkillPackageDestinationError("Output parent must be outside the source package directory.");
  }
}

function assertIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.mode !== actual.mode || actual.isSymbolicLink()) {
    throw new SkillPackageDestinationError("A package or output directory changed during packaging.");
  }
}

async function assertDestinationParent(directory: string, handle: FileHandle, expected: BigIntStats, source: string): Promise<void> {
  assertIdentity(expected, await handle.stat({ bigint: true }));
  assertIdentity(expected, await lstat(directory, { bigint: true }));
  assertOutsideSource(source, await realpath(directory));
}

async function openDirectoryWithoutSymlinks(directory: string): Promise<FileHandle> {
  try {
    if (process.platform === "darwin") return await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const component of directory.split("/").filter(Boolean)) {
        const child = await open(`/proc/self/fd/${handle.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close();
        handle = child;
      }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } catch {
    throw new SkillPackageDestinationError("Output parent must be an existing directory with no symlink ancestors.");
  }
}

async function systemAliasPath(requested: string): Promise<string> {
  if (process.platform !== "darwin") return requested;
  const alias = ["/var", "/tmp", "/etc"].find((prefix) => requested === prefix || requested.startsWith(`${prefix}/`));
  if (!alias) return requested;
  const resolved = await realpath(alias);
  if (resolved !== `/private${alias}`) throw new Error("Package system path alias has an unexpected destination.");
  return path.join(resolved, path.relative(alias, requested));
}
