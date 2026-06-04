import { writeFile } from "node:fs/promises";

export interface ZipFixtureEntry {
  path: string;
  content?: string | Buffer;
  mode?: number;
  directory?: boolean;
  compressionMethod?: number;
  encrypted?: boolean;
}

export async function writeStoredZip(zipPath: string, entries: ZipFixtureEntry[]): Promise<void> {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const content = entry.directory ? Buffer.alloc(0) : Buffer.from(entry.content ?? "");
    const storedContent = entry.encrypted ? Buffer.concat([Buffer.alloc(12), content]) : content;
    const crc = crc32(content);
    const compressionMethod = entry.compressionMethod ?? 0;
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const mode = entry.mode ?? (entry.directory ? 0o040775 : 0o100664);
    const externalAttributes = (mode << 16) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(storedContent.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(storedContent.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, name, storedContent);
    centralParts.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + storedContent.byteLength;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(zipPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  const table = crc32Table();
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let cachedCrc32Table: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (cachedCrc32Table) {
    return cachedCrc32Table;
  }
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  cachedCrc32Table = table;
  return table;
}
