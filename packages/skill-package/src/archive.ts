import { crc32 } from "node:zlib";
import {
  MAX_PACKAGE_ARCHIVE_BYTES, MAX_PACKAGE_FILES, loadSkillManifestFromPackageFiles, normalizePackageFilePath,
  scanPackageFiles, type PackageInputFile, type PackageScanResult,
} from "./package-path.js";
import { hasBlockingFindings } from "./scan.js";

export class PackageArchiveScanError extends Error {
  constructor(readonly scan: PackageScanResult) {
    super("Package has blocking scan findings; no archive was created.");
    this.name = "PackageArchiveScanError";
  }
}

/**
 * Encode the held, checked text snapshot with ZIP STORE. No filesystem reads,
 * compression variability, locale sorting, timestamps, or platform metadata.
 * Format: PKWARE APPNOTE 6.3.10, sections 4.3 and 4.4.
 * https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
export function encodePackageArchive(files: readonly PackageInputFile[]): Buffer {
  if (files.length > MAX_PACKAGE_FILES) throw new Error(`Package contains more than ${MAX_PACKAGE_FILES} files.`);
  if (files.some((file) => typeof file.path !== "string" || file.path.length > 65_489)) throw new Error("Archive filename exceeds the ZIP UTF-8 name limit.");
  const snapshot = files.map((file) => ({ path: file.path, content: file.content }));
  loadSkillManifestFromPackageFiles(snapshot);
  const scan = scanPackageFiles(snapshot);
  if (hasBlockingFindings(scan.findings)) throw new PackageArchiveScanError(scan);
  const entries = snapshot.map((file) => {
    if (normalizePackageFilePath(file.path) !== file.path) throw new Error("Archive paths must be canonical relative paths.");
    const name = Buffer.from(file.path, "utf8");
    if (name.toString("utf8") !== file.path || name.byteLength > 65_489) throw new Error("Archive filename exceeds the ZIP UTF-8 name limit.");
    return { name, content: Buffer.from(file.content, "utf8") };
  }).sort((a, b) => Buffer.compare(a.name, b.name));
  const byteLength = entries.reduce((total, entry) => total + 76 + entry.name.byteLength * 2 + entry.content.byteLength, 22);
  if (byteLength > MAX_PACKAGE_ARCHIVE_BYTES) throw new Error(`Package archive exceeds ${MAX_PACKAGE_ARCHIVE_BYTES} bytes.`);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    // crc32(Buffer) is available on every supported Node runtime (since 22.2).
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names; uncompressed, unencrypted.
    local.writeUInt16LE(0x0021, 12); // 1980-01-01 00:00:00, valid DOS date.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Fixed Unix creator.
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.byteLength, 20);
    central.writeUInt32LE(content.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, content);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + content.byteLength;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end], byteLength);
}
