import { lstat, readdir, readFile } from "node:fs/promises";
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

interface PackageFile {
  absolutePath: string;
  relativePath: string;
}

export async function loadSkillManifestFromPath(inputPath: string): Promise<SkillManifest> {
  if (await isZipPackageFile(inputPath)) {
    const raw = await readManifestFromZip(path.resolve(inputPath));
    return parseSkillManifest(JSON.parse(raw));
  }
  const manifestPath = await resolveManifestPath(inputPath);
  const raw = await readFile(manifestPath, "utf8");
  return parseSkillManifest(JSON.parse(raw));
}

export async function scanPackagePath(inputPath: string): Promise<PackageScanResult> {
  const rootPath = path.resolve(inputPath);
  if (await isZipPackageFile(rootPath)) {
    return scanZipPackage(rootPath);
  }
  const files = await collectPackageFiles(rootPath);
  const findings: ScanFinding[] = [];
  let bytesScanned = 0;

  for (const file of files) {
    const raw = await readFile(file.absolutePath);
    bytesScanned += raw.byteLength;
    if (bytesScanned > MAX_PACKAGE_TEXT_BYTES) {
      findings.push({
        category: "package-structure",
        severity: "blocking",
        message: `Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`,
        path: file.relativePath,
      });
      break;
    }
    for (const finding of scanTextForPackageRisks(raw.toString("utf8"))) {
      findings.push({ ...finding, path: file.relativePath });
    }
  }

  return {
    rootPath,
    filesScanned: files.length,
    bytesScanned,
    findings,
  };
}

export async function readPackageFilesFromPath(inputPath: string): Promise<PackageInputFile[]> {
  const rootPath = path.resolve(inputPath);
  if (await isZipPackageFile(rootPath)) {
    return readZipPackageFiles(rootPath);
  }
  const files = await collectPackageFiles(rootPath);
  const result: PackageInputFile[] = [];
  for (const file of files) {
    result.push({
      path: file.relativePath,
      content: await readFile(file.absolutePath, "utf8"),
    });
  }
  return result;
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

async function resolveManifestPath(inputPath: string): Promise<string> {
  const rootPath = path.resolve(inputPath);
  const stat = await lstat(rootPath);
  if (stat.isSymbolicLink()) {
    throw new Error("Package input cannot be a symlink.");
  }
  if (stat.isFile()) {
    return rootPath;
  }
  if (!stat.isDirectory()) {
    throw new Error("Package input must be a manifest file or directory.");
  }

  for (const name of DEFAULT_MANIFEST_NAMES) {
    const candidate = path.join(rootPath, name);
    try {
      const candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new Error(`Manifest file cannot be a symlink: ${name}`);
      }
      if (candidateStat.isFile()) {
        return candidate;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(`No skill manifest found. Expected one of: ${DEFAULT_MANIFEST_NAMES.join(", ")}`);
}

async function collectPackageFiles(rootPath: string): Promise<PackageFile[]> {
  const stat = await lstat(rootPath);
  if (stat.isSymbolicLink()) {
    throw new Error("Package input cannot be a symlink.");
  }
  if (stat.isFile()) {
    return [{ absolutePath: rootPath, relativePath: path.basename(rootPath) }];
  }
  if (!stat.isDirectory()) {
    throw new Error("Package input must be a file or directory.");
  }

  const files: PackageFile[] = [];
  await collectDirectoryFiles(rootPath, rootPath, files);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectDirectoryFiles(rootPath: string, currentPath: string, files: PackageFile[]): Promise<void> {
  if (files.length > MAX_PACKAGE_FILES) {
    return;
  }
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = normalizeRelativePath(path.relative(rootPath, absolutePath));
    if (entry.isSymbolicLink()) {
      throw new Error(`Package cannot contain symlinks: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await collectDirectoryFiles(rootPath, absolutePath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push({ absolutePath, relativePath });
      if (files.length > MAX_PACKAGE_FILES) {
        throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files.`);
      }
    }
  }
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
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
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Package file path cannot traverse directories: ${inputPath}`);
  }
  return normalized;
}

async function isZipPackageFile(inputPath: string): Promise<boolean> {
  const rootPath = path.resolve(inputPath);
  const stat = await lstat(rootPath);
  if (stat.isSymbolicLink()) {
    throw new Error("Package input cannot be a symlink.");
  }
  if (!stat.isFile() || path.extname(rootPath).toLowerCase() !== ".zip") {
    return false;
  }
  if (stat.size > MAX_PACKAGE_ARCHIVE_BYTES) {
    throw new Error(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`);
  }
  return true;
}

async function readManifestFromZip(zipPath: string): Promise<string> {
  const manifests = new Map<string, string>();
  await walkZipPackage(zipPath, async (entry, relativePath, zipfile) => {
    if (!DEFAULT_MANIFEST_NAMES.includes(relativePath as (typeof DEFAULT_MANIFEST_NAMES)[number])) {
      return;
    }
    manifests.set(relativePath, decodePackageText(await readZipEntryBuffer(zipfile, entry, MAX_PACKAGE_TEXT_BYTES), relativePath));
  });

  const orderedManifests = DEFAULT_MANIFEST_NAMES.filter((name) => manifests.has(name));
  if (orderedManifests.length === 0) {
    throw new Error(`No skill manifest found. Expected one of: ${DEFAULT_MANIFEST_NAMES.join(", ")}`);
  }
  if (orderedManifests.length > 1) {
    throw new Error(`Package archive contains multiple root manifests: ${orderedManifests.join(", ")}`);
  }
  return manifests.get(orderedManifests[0]) ?? "";
}

async function scanZipPackage(zipPath: string): Promise<PackageScanResult> {
  const findings: ScanFinding[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let textLimitReached = false;

  await walkZipPackage(zipPath, async (entry, relativePath, zipfile) => {
    filesScanned += 1;
    if (textLimitReached) {
      return;
    }
    if (entry.uncompressedSize > MAX_PACKAGE_TEXT_BYTES || bytesScanned + entry.uncompressedSize > MAX_PACKAGE_TEXT_BYTES) {
      bytesScanned += entry.uncompressedSize;
      findings.push({
        category: "package-structure",
        severity: "blocking",
        message: `Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`,
        path: relativePath,
      });
      textLimitReached = true;
      return;
    }
    const raw = await readZipEntryBuffer(zipfile, entry, entry.uncompressedSize);
    bytesScanned += raw.byteLength;
    const content = decodePackageText(raw, relativePath);
    for (const finding of scanTextForPackageRisks(content)) {
      findings.push({ ...finding, path: relativePath });
    }
  });

  return {
    rootPath: zipPath,
    filesScanned,
    bytesScanned,
    findings,
  };
}

async function readZipPackageFiles(zipPath: string): Promise<PackageInputFile[]> {
  const files: PackageInputFile[] = [];
  let bytesRead = 0;

  await walkZipPackage(zipPath, async (entry, relativePath, zipfile) => {
    const remainingBytes = MAX_PACKAGE_TEXT_BYTES - bytesRead;
    if (entry.uncompressedSize > remainingBytes) {
      throw new Error(`Package text exceeds ${MAX_PACKAGE_TEXT_BYTES} bytes.`);
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
  zipPath: string,
  onFile: (entry: Entry, relativePath: string, zipfile: ZipFile) => Promise<void>,
): Promise<void> {
  const zipfile = await openZipFile(zipPath);
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
            if (seenFiles.has(validated.relativePath)) {
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

function openZipFile(zipPath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zipfile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipfile);
    });
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
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Package file must be valid UTF-8 text: ${relativePath}`);
  }
  if (content.includes("\0")) {
    throw new Error(`Package file must be text without NUL bytes: ${relativePath}`);
  }
  return content;
}
