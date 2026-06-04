import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseSkillManifest, type SkillManifest } from "./manifest.js";
import { scanTextForPackageRisks, type ScanFinding } from "./scan.js";

export const DEFAULT_MANIFEST_NAMES = ["skill.json", "skill-manifest.json", "ai-skill.json"] as const;
export const MAX_PACKAGE_FILES = 500;
export const MAX_PACKAGE_TEXT_BYTES = 1024 * 1024;

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

interface PackageFile {
  absolutePath: string;
  relativePath: string;
}

export async function loadSkillManifestFromPath(inputPath: string): Promise<SkillManifest> {
  const manifestPath = await resolveManifestPath(inputPath);
  const raw = await readFile(manifestPath, "utf8");
  return parseSkillManifest(JSON.parse(raw));
}

export async function scanPackagePath(inputPath: string): Promise<PackageScanResult> {
  const rootPath = path.resolve(inputPath);
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
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(inputPath)) {
    throw new Error(`Package file path cannot be a URL: ${inputPath}`);
  }
  if (inputPath.includes("\\")) {
    throw new Error(`Package file path must use forward slashes: ${inputPath}`);
  }
  if (path.posix.isAbsolute(inputPath) || /^[A-Za-z]:\//.test(inputPath)) {
    throw new Error(`Package file path cannot be absolute: ${inputPath}`);
  }
  const normalized = path.posix.normalize(inputPath);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Package file path cannot traverse directories: ${inputPath}`);
  }
  return normalized;
}
