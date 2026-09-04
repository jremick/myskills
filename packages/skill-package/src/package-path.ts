import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { parseSkillManifest, type SkillManifest } from "./manifest.js";
import { scanTextForPackageRisks, type ScanFinding } from "./scan.js";

export const DEFAULT_MANIFEST_NAMES = ["skill.json", "skill-manifest.json", "ai-skill.json"] as const;
export const MAX_PACKAGE_FILES = 500;
export const MAX_PACKAGE_TEXT_BYTES = 1024 * 1024;
export const MAX_PACKAGE_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_PACKAGE_ARCHIVE_ENTRIES = MAX_PACKAGE_FILES * 2;

export interface PackageScanResult {
  rootPath: string;
  filesScanned: number;
  bytesScanned: number;
  findings: ScanFinding[];
}

export interface PackageInputFile {
  path: string;
  content: string;
}

export type PackageManifestFileErrorCode =
  | "PACKAGE_MANIFEST_REQUIRED"
  | "PACKAGE_MANIFEST_AMBIGUOUS"
  | "INVALID_PACKAGE_MANIFEST"
  | "INVALID_PACKAGE_PAYLOAD";

export class PackageManifestFileError extends Error {
  constructor(
    readonly code: PackageManifestFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackageManifestFileError";
  }
}

export interface PackageSnapshot {
  manifest: SkillManifest;
  files: PackageInputFile[];
  scan: PackageScanResult;
}

export async function readPackageSnapshot(inputPath: string): Promise<PackageSnapshot> {
  const files = await readPackageFilesFromPath(inputPath);
  return {
    manifest: manifestForInput(files, inputPath),
    files,
    scan: { ...scanPackageFiles(files), rootPath: path.resolve(inputPath) },
  };
}

export async function loadSkillManifestFromPath(inputPath: string): Promise<SkillManifest> {
  const files = await readPackageFilesFromPath(inputPath);
  return manifestForInput(files, inputPath);
}

function manifestForInput(files: PackageInputFile[], inputPath: string): SkillManifest {
  // Keep support for a directly named manifest file with a custom filename.
  if (files.length === 1 && files[0].path === path.basename(inputPath) && path.extname(inputPath).toLowerCase() !== ".zip") {
    return parseSkillManifest(JSON.parse(files[0].content));
  }
  return loadSkillManifestFromPackageFiles(files);
}

export async function scanPackagePath(inputPath: string): Promise<PackageScanResult> {
  const rootPath = path.resolve(inputPath);
  try {
    return { ...scanPackageFiles(await readPackageFilesFromPath(inputPath)), rootPath };
  } catch (error) {
    if (!(error instanceof PackageTextLimitError)) throw error;
    return {
      rootPath,
      filesScanned: error.filesScanned,
      bytesScanned: error.bytesScanned,
      findings: [{ category: "package-structure", severity: "blocking", message: error.message, path: error.relativePath }],
    };
  }
}

export async function readPackageFilesFromPath(inputPath: string): Promise<PackageInputFile[]> {
  assertSafePackagePlatform();
  const { rootPath, expected, handle } = await openPackageRoot(path.resolve(inputPath));
  try {
    if (expected.isFile()) {
      if (path.extname(rootPath).toLowerCase() === ".zip") {
        return readZipPackageFiles(await readBoundedFile(handle, expected, MAX_PACKAGE_ARCHIVE_BYTES, path.basename(rootPath), true));
      }
      const relativePath = normalizePackageFilePath(path.basename(rootPath));
      const raw = await readBoundedFile(handle, expected, MAX_PACKAGE_TEXT_BYTES, relativePath);
      return [{ path: relativePath, content: decodePackageText(raw, relativePath) }];
    }
    const files: PackageInputFile[] = [];
    const budget = { entries: 0, bytes: 0 };
    await readDirectorySnapshot(rootPath, "", handle, expected, files, budget);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  } finally {
    await handle.close();
  }
}

class PackageTextLimitError extends Error {
  constructor(readonly relativePath: string, readonly bytesScanned: number, readonly filesScanned = 0) {
    super(`Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`);
  }
}

function assertSafePackagePlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Safe local package reads require macOS or Linux. Use ZIP upload in the web app on this operating system.");
  }
}

async function openPackageRoot(requestedPath: string): Promise<{ rootPath: string; expected: BigIntStats; handle: FileHandle }> {
  let rootPath = requestedPath;
  if (process.platform === "darwin") {
    // macOS system aliases are the only permitted symlink prefixes. Resolve just
    // that prefix so user-created ancestor symlinks still fail O_NOFOLLOW_ANY.
    const alias = ["/var", "/tmp", "/etc"].find((prefix) => rootPath === prefix || rootPath.startsWith(`${prefix}/`));
    if (alias) {
      const resolved = await realpath(alias);
      if (resolved !== `/private${alias}`) throw new Error("Package system path alias has an unexpected destination.");
      rootPath = path.join(resolved, path.relative(alias, rootPath));
    }
    const expected = await checkedStat(rootPath);
    return { rootPath, expected, handle: await openCheckedPath(rootPath, expected) };
  }
  // Resolve each Linux component from a pinned directory, never by following an
  // untrusted intermediate symlink in the original absolute path.
  const rootStat = await checkedStat("/");
  let handle = await openCheckedPath("/", rootStat);
  let expected = rootStat;
  try {
    const components = rootPath.split("/").filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const childPath = `/proc/self/fd/${handle.fd}/${components[index]}`;
      expected = await checkedStat(childPath);
      if (index < components.length - 1 && !expected.isDirectory()) throw new Error("Package ancestor must be a directory.");
      const child = await openCheckedPath(childPath, expected);
      await handle.close();
      handle = child;
    }
    return { rootPath, expected, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function checkedStat(filePath: string): Promise<BigIntStats> {
  const stat = await lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error("Package input and entries cannot contain symlinks.");
  if (!stat.isDirectory() && !stat.isFile()) throw new Error("Package entries must be regular files or directories.");
  return stat;
}

async function openCheckedPath(filePath: string, expected: BigIntStats): Promise<FileHandle> {
  // Darwin exposes O_NOFOLLOW_ANY in sys/fcntl.h, but Node does not export it.
  // Unlike O_NOFOLLOW it rejects symlinks in every path component.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
  const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow | constants.O_NONBLOCK |
      (expected.isDirectory() ? constants.O_DIRECTORY : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("Package input and entries cannot contain symlinks.");
    throw error;
  }
  try {
    assertUnchanged(expected, await handle.stat({ bigint: true }));
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readDirectorySnapshot(
  directoryPath: string,
  relativeDirectory: string,
  handle: FileHandle,
  expected: BigIntStats,
  files: PackageInputFile[],
  budget: { entries: number; bytes: number },
): Promise<void> {
  // Linux can resolve each child against the pinned parent descriptor. macOS
  // rejects intermediate symlinks with O_NOFOLLOW_ANY and checks directory identity.
  const traversalPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : directoryPath;
  const directory = await opendir(traversalPath);
  for await (const entry of directory) {
    budget.entries += 1;
    if (budget.entries > MAX_PACKAGE_ARCHIVE_ENTRIES) throw new Error(`Package contains more than ${MAX_PACKAGE_ARCHIVE_ENTRIES} entries.`);
    const relativePath = normalizePackageFilePath(path.posix.join(relativeDirectory, entry.name));
    const childPath = path.join(traversalPath, entry.name);
    const childStat = await checkedStat(childPath);
    const child = await openCheckedPath(childPath, childStat);
    try {
      if (childStat.isDirectory()) {
        await readDirectorySnapshot(path.join(directoryPath, entry.name), relativePath, child, childStat, files, budget);
      } else {
        if (files.length >= MAX_PACKAGE_FILES) throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files.`);
        if (childStat.size > BigInt(MAX_PACKAGE_TEXT_BYTES - budget.bytes)) {
          throw new PackageTextLimitError(relativePath, budget.bytes + Number(childStat.size), files.length);
        }
        const raw = await readBoundedFile(child, childStat, MAX_PACKAGE_TEXT_BYTES - budget.bytes, relativePath);
        budget.bytes += raw.byteLength;
        files.push({ path: relativePath, content: decodePackageText(raw, relativePath) });
      }
    } finally {
      await child.close();
    }
    assertUnchanged(expected, await handle.stat({ bigint: true }));
  }
  assertUnchanged(expected, await handle.stat({ bigint: true }));
  assertUnchanged(expected, await checkedStat(directoryPath));
}

async function readBoundedFile(
  handle: FileHandle,
  expected: BigIntStats,
  maxBytes: number,
  relativePath: string,
  archive = false,
): Promise<Buffer> {
  const exceeded = () => archive
    ? new Error(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`)
    : new PackageTextLimitError(relativePath, Number(expected.size));
  if (expected.size > BigInt(maxBytes)) throw exceeded();
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytesRead + 1));
    const read = await handle.read(chunk, 0, chunk.byteLength, null);
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
    if (bytesRead > maxBytes) throw exceeded();
    chunks.push(chunk.subarray(0, read.bytesRead));
  }
  assertUnchanged(expected, await handle.stat({ bigint: true }));
  return Buffer.concat(chunks, bytesRead);
}

function assertUnchanged(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.mode !== actual.mode ||
    expected.size !== actual.size || expected.mtimeNs !== actual.mtimeNs || expected.ctimeNs !== actual.ctimeNs) {
    throw new Error("Package changed while it was being read. Retry with an unchanged package.");
  }
}

export async function readPackageFilesFromZipBuffer(buffer: Buffer): Promise<PackageInputFile[]> {
  if (buffer.byteLength > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`);
  }
  return readZipPackageFiles(Buffer.from(buffer));
}

export function scanPackageFiles(files: PackageInputFile[]): PackageScanResult {
  if (files.length > MAX_PACKAGE_FILES) {
    throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files.`);
  }

  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  let bytesScanned = 0;

  for (const file of files) {
    const relativePath = normalizePackageFilePath(file.path);
    if (seen.has(relativePath)) {
      throw new Error(`Package contains duplicate file path: ${relativePath}`);
    }
    assertNoFileCollision(relativePath, seen);
    seen.add(relativePath);
    if (typeof file.content !== "string") {
      throw new Error(`Package file content must be text: ${relativePath}`);
    }
    const byteLength = Buffer.byteLength(file.content);
    bytesScanned += byteLength;
    if (bytesScanned > MAX_PACKAGE_TEXT_BYTES) {
      findings.push({
        category: "package-structure",
        severity: "blocking",
        message: `Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`,
        path: relativePath,
      });
      break;
    }
    if (decodePackageText(Buffer.from(file.content, "utf8"), relativePath) !== file.content) {
      throw new Error(`Package file must be valid UTF-8 text: ${relativePath}`);
    }
    for (const finding of scanTextForPackageRisks(file.content)) {
      findings.push({ ...finding, path: relativePath });
    }
  }

  return {
    rootPath: "package-payload",
    filesScanned: files.length,
    bytesScanned,
    findings,
  };
}

export function loadSkillManifestFromPackageFiles(files: PackageInputFile[]): SkillManifest {
  const manifests: Array<{ path: string; manifest: SkillManifest }> = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relativePath = normalizePackageFilePath(file.path);
    if (seen.has(relativePath)) {
      throw new PackageManifestFileError("INVALID_PACKAGE_PAYLOAD", `Package contains duplicate file path: ${relativePath}`);
    }
    seen.add(relativePath);
    if (!DEFAULT_MANIFEST_NAMES.includes(relativePath as (typeof DEFAULT_MANIFEST_NAMES)[number])) {
      continue;
    }
    if (typeof file.content !== "string") {
      throw new PackageManifestFileError("INVALID_PACKAGE_PAYLOAD", `Package file content must be text: ${relativePath}`);
    }
    try {
      manifests.push({
        path: relativePath,
        manifest: parseSkillManifest(JSON.parse(file.content)),
      });
    } catch {
      throw new PackageManifestFileError("INVALID_PACKAGE_MANIFEST", `Package manifest file is invalid: ${relativePath}`);
    }
  }

  if (manifests.length === 0) {
    throw new PackageManifestFileError(
      "PACKAGE_MANIFEST_REQUIRED",
      `Package manifest file is required. Expected one of: ${DEFAULT_MANIFEST_NAMES.join(", ")}`,
    );
  }
  if (manifests.length > 1) {
    throw new PackageManifestFileError(
      "PACKAGE_MANIFEST_AMBIGUOUS",
      `Package contains multiple root manifests: ${manifests.map((manifest) => manifest.path).join(", ")}`,
    );
  }
  return manifests[0].manifest;
}

export function normalizePackageFilePath(inputPath: string): string {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error("Package file path is required.");
  }
  if (inputPath.includes("\0")) {
    throw new Error("Package file path cannot contain NUL bytes.");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(inputPath)) {
    if (/^[A-Za-z]:/.test(inputPath)) {
      throw new Error(`Package file path cannot be absolute: ${inputPath}`);
    }
    throw new Error(`Package file path cannot be a URL: ${inputPath}`);
  }
  if (inputPath.includes("\\")) {
    throw new Error(`Package file path must use forward slashes: ${inputPath}`);
  }
  if (path.posix.isAbsolute(inputPath)) {
    throw new Error(`Package file path cannot be absolute: ${inputPath}`);
  }
  if (inputPath.split("/").includes("..")) {
    throw new Error(`Package file path cannot traverse directories: ${inputPath}`);
  }
  const normalized = path.posix.normalize(inputPath);
  if (normalized.split("/").length > 32) throw new Error("Package directory nesting exceeds 32 levels.");
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Package file path cannot traverse directories: ${inputPath}`);
  }
  return normalized;
}

async function readZipPackageFiles(zipInput: Buffer): Promise<PackageInputFile[]> {
  const files: PackageInputFile[] = [];
  let bytesRead = 0;

  await walkZipPackage(zipInput, async (entry, relativePath, zipfile) => {
    const remainingBytes = MAX_PACKAGE_TEXT_BYTES - bytesRead;
    if (entry.uncompressedSize > remainingBytes) {
      throw new PackageTextLimitError(relativePath, bytesRead + entry.uncompressedSize, files.length);
    }
    const raw = await readZipEntryBuffer(zipfile, entry, remainingBytes);
    bytesRead += raw.byteLength;
    if (bytesRead > MAX_PACKAGE_TEXT_BYTES) {
      throw new Error(`Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`);
    }
    files.push({
      path: relativePath,
      content: decodePackageText(raw, relativePath),
    });
  });

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walkZipPackage(
  zipInput: Buffer,
  onFile: (entry: Entry, relativePath: string, zipfile: ZipFile) => Promise<void>,
): Promise<void> {
  const zipfile = await openZipFile(zipInput);
  if (zipfile.entryCount > MAX_PACKAGE_ARCHIVE_ENTRIES) {
    zipfile.close();
    throw new Error(`Package archive contains more than ${MAX_PACKAGE_ARCHIVE_ENTRIES} entries.`);
  }

  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  let filesSeen = 0;
  let entriesSeen = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (zipfile.isOpen) {
        zipfile.close();
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    zipfile.on("error", fail);
    zipfile.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    });
    zipfile.on("entry", (entry) => {
      void (async () => {
        try {
          entriesSeen += 1;
          if (entriesSeen > MAX_PACKAGE_ARCHIVE_ENTRIES) {
            throw new Error(`Package archive contains more than ${MAX_PACKAGE_ARCHIVE_ENTRIES} entries.`);
          }
          const validated = validateZipEntry(entry);
          if (validated.kind === "directory") {
            if (seenFiles.has(validated.relativePath) || [...seenFiles].some((file) => validated.relativePath.startsWith(`${file}/`))) {
              throw new Error(`Package archive contains a directory/file collision: ${validated.relativePath}`);
            }
            seenDirectories.add(validated.relativePath);
            zipfile.readEntry();
            return;
          }

          filesSeen += 1;
          if (filesSeen > MAX_PACKAGE_FILES) {
            throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files.`);
          }
          if (seenFiles.has(validated.relativePath)) {
            throw new Error(`Package contains duplicate file path: ${validated.relativePath}`);
          }
          if (seenDirectories.has(validated.relativePath)) {
            throw new Error(`Package archive contains a directory/file collision: ${validated.relativePath}`);
          }
          assertNoFileCollision(validated.relativePath, seenFiles);
          if ([...seenDirectories].some((directory) => directory.startsWith(`${validated.relativePath}/`))) {
            throw new Error(`Package archive contains a directory/file collision: ${validated.relativePath}`);
          }
          seenFiles.add(validated.relativePath);
          await onFile(entry, validated.relativePath, zipfile);
          zipfile.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });

    zipfile.readEntry();
  });
}

function assertNoFileCollision(relativePath: string, seen: Set<string>): void {
  if ([...seen].some((file) => relativePath.startsWith(`${file}/`) || file.startsWith(`${relativePath}/`))) {
    throw new Error(`Package contains a directory/file collision: ${relativePath}`);
  }
}

function openZipFile(zipInput: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    const options = {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    };
    const callback = (error: Error | null, zipfile: ZipFile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    };
    yauzl.fromBuffer(zipInput, options, callback);
  });
}

function validateZipEntry(entry: Entry): { kind: "directory"; relativePath: string } | { kind: "file"; relativePath: string } {
  if (typeof entry.fileName !== "string" || !entry.fileName) {
    throw new Error("Package archive entry path is required.");
  }
  const pathError = yauzl.validateFileName(entry.fileName);
  if (pathError !== null) {
    throw new Error(`Package archive entry has an unsafe path: ${pathError}`);
  }
  if (entry.isEncrypted()) {
    throw new Error(`Package archive cannot contain encrypted entries: ${entry.fileName}`);
  }

  const isDirectory = entry.fileName.endsWith("/");
  validateZipEntryMode(entry, isDirectory);
  if (isDirectory) {
    return {
      kind: "directory",
      relativePath: normalizePackageFilePath(entry.fileName.replace(/\/+$/, "")),
    };
  }

  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Package archive entry uses an unsupported compression method: ${entry.fileName}`);
  }
  const relativePath = normalizePackageFilePath(entry.fileName);
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new Error(`Package archive entry has an invalid size: ${relativePath}`);
  }
  return {
    kind: "file",
    relativePath,
  };
}

function validateZipEntryMode(entry: Entry, isDirectory: boolean): void {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0) {
    return;
  }
  if (fileType === 0o120000) {
    throw new Error(`Package archive cannot contain symlinks: ${entry.fileName}`);
  }
  if (isDirectory && fileType !== 0o040000) {
    throw new Error(`Package archive directory entry is not a directory: ${entry.fileName}`);
  }
  if (!isDirectory && fileType !== 0o100000) {
    throw new Error(`Package archive entry is not a regular file: ${entry.fileName}`);
  }
}

function readZipEntryBuffer(zipfile: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, readStream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      let settled = false;

      const fail = (streamError: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(streamError);
      };

      readStream.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBytes) {
          const limitError = new Error(`Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`);
          readStream.destroy(limitError);
          fail(limitError);
          return;
        }
        chunks.push(chunk);
      });
      readStream.on("error", fail);
      readStream.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks, bytesRead));
      });
    });
  });
}

function decodePackageText(buffer: Buffer, relativePath: string): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(`Package file must be valid UTF-8 text: ${relativePath}`);
  }
  if (content.includes("\0")) {
    throw new Error(`Package file must be text without NUL bytes: ${relativePath}`);
  }
  return content;
}
