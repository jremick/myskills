import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { AppError, DEFAULT_BRANDING, MAX_BRAND_LOGO_BYTES, MAX_BRAND_TEXT_LENGTH, type BrandSettings } from "@myskills-app/core";

const MAX_LOGO_DIMENSION = 2048;
// Cache only one successfully validated, immutable logo value. Settings still
// come from the database on every read; changed image bytes are fully checked.
let lastValidatedLogo: string | null = null;

function invalid(message = "Choose a valid PNG, JPEG or WebP logo up to 256 KB and 2048 × 2048 pixels."): never {
  throw new AppError(message, "INVALID_BRANDING", 400);
}

export function parseBranding(input: unknown): BrandSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 3 || !("text" in input) || !("showText" in input) || !("logoDataUrl" in input)
    || typeof input.text !== "string" || typeof input.showText !== "boolean"
    || (input.logoDataUrl !== null && typeof input.logoDataUrl !== "string")) {
    invalid("Provide brand text, text visibility and a logo image or null.");
  }
  const text = input.text.trim();
  if (!text || text.length > MAX_BRAND_TEXT_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(input.text)) {
    invalid(`Enter brand text between 1 and ${MAX_BRAND_TEXT_LENGTH} characters on one line.`);
  }
  if (input.logoDataUrl !== null) validateLogo(input.logoDataUrl);
  return { text, showText: input.showText, logoDataUrl: input.logoDataUrl };
}

export function parseStoredBranding(input: unknown): BrandSettings {
  if (input === undefined) return { ...DEFAULT_BRANDING };
  try {
    return parseBranding(input);
  } catch {
    throw new Error("Branding settings are invalid.");
  }
}

export function brandingAuditDetails(old: BrandSettings, next: BrandSettings): Record<string, unknown> {
  const digest = (image: string | null) => image === null ? null
    : createHash("sha256").update(Buffer.from(image.slice(image.indexOf(",") + 1), "base64")).digest("hex");
  return {
    oldText: old.text, newText: next.text,
    oldShowText: old.showText, newShowText: next.showText,
    logoChanged: old.logoDataUrl !== next.logoDataUrl,
    oldLogoSha256: digest(old.logoDataUrl), newLogoSha256: digest(next.logoDataUrl),
  };
}

function validateLogo(dataUrl: string): void {
  if (dataUrl === lastValidatedLogo) return;
  // Bound the encoded string before decoding, and require canonical base64.
  if (dataUrl.length > Math.ceil(MAX_BRAND_LOGO_BYTES / 3) * 4 + 32) invalid();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) invalid();
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > MAX_BRAND_LOGO_BYTES || bytes.toString("base64") !== match[2]) invalid();
  try {
    if (match[1] === "png") validatePng(bytes);
    else if (match[1] === "jpeg") validateJpeg(bytes);
    else validateWebp(bytes);
    lastValidatedLogo = dataUrl;
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid();
  }
}

function dimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) invalid();
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette = false, ended = false, dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (offset === 8 && type !== "IHDR") invalid();
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) invalid();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      dimensions(width, height);
      depth = chunk[8]; color = chunk[9]; interlace = chunk[12];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || chunk[10] !== 0 || chunk[11] !== 0 || interlace > 1) invalid();
    } else if (["acTL", "fcTL", "fdAT"].includes(type)) {
      invalid("Use a still PNG, JPEG or WebP logo.");
    } else if (type === "PLTE") {
      if (palette || compressed.length || !length || length % 3 || length > 768 || color === 0 || color === 4) invalid();
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (color === 3 && !palette)) invalid();
      compressed.push(chunk);
    } else if (type === "IEND") {
      if (length !== 0 || !compressed.length || end !== bytes.length) invalid();
      ended = true;
    } else if (type[0] === type[0].toUpperCase()) invalid();
    if (compressed.length && type !== "IDAT") dataEnded = true;
    offset = end;
  }
  if (!ended) invalid();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx));
    return { count: w ? Math.max(0, Math.ceil((height - y) / dy)) : 0, size: 1 + Math.ceil(w * channels[color] * depth / 8) };
  });
  const expected = rows.reduce((sum, row) => sum + row.count * row.size, 0);
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  if (pixels.length !== expected) invalid();
  let rowOffset = 0;
  for (const row of rows) for (let i = 0; i < row.count; i++) {
    if (pixels[rowOffset] > 4) invalid();
    rowOffset += row.size;
  }
}

function validateJpeg(bytes: Buffer): void {
  if (bytes.readUInt16BE(0) !== 0xffd8) invalid();
  let offset = 2, frame = false, scan = false, quantization = false, huffman = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!frame || !scan || !quantization || !huffman || offset !== bytes.length) invalid();
      return;
    }
    if (marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    const length = bytes.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    const data = bytes.subarray(offset + 2, end);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frame || data.length < 6 || data[0] !== 8 || data[5] < 1 || data[5] > 4 || data.length !== 6 + 3 * data[5]) invalid();
      dimensions(data.readUInt16BE(3), data.readUInt16BE(1));
      frame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    if (marker === 0xdb) {
      let table = 0;
      while (table < data.length) {
        const info = data[table++];
        if ((info >> 4) > 1 || (info & 15) > 3) invalid();
        table += (info >> 4) === 0 ? 64 : 128;
      }
      if (!data.length || table !== data.length) invalid();
      quantization = true;
    }
    if (marker === 0xc4) {
      let table = 0;
      while (table < data.length) {
        if (table + 17 > data.length || data[table] > 0x13 || (data[table] & 15) > 3) invalid();
        table += 17 + data.subarray(table + 1, table + 17).reduce((sum, count) => sum + count, 0);
      }
      if (!data.length || table !== data.length) invalid();
      huffman = true;
    }
    offset = end;
    if (marker === 0xda) {
      if (!frame || data.length < 4 || !data[0] || data.length !== 4 + 2 * data[0]) invalid();
      const start = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        if (bytes[offset + 1] === 0 || (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)) { offset += 2; continue; }
        break;
      }
      if (offset <= start) invalid();
      scan = true;
    }
  }
  invalid();
}

function validateWebp(bytes: Buffer): void {
  if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, image = false;
  let canvas: [number, number] | undefined;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid();
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end + (length % 2) > bytes.length) invalid();
    const data = bytes.subarray(offset + 8, end);
    if (type === "VP8X") {
      if (offset !== 12 || length !== 10 || (data[0] & 0xc3) || data[1] || data[2] || data[3]) invalid();
      canvas = [1 + data.readUIntLE(4, 3), 1 + data.readUIntLE(7, 3)];
      dimensions(...canvas);
    } else if (type === "VP8 " || type === "VP8L") {
      if (image) invalid();
      let width: number, height: number;
      if (type === "VP8 ") {
        if (length < 11 || (data[0] & 1) || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid();
        const firstPartition = data.readUIntLE(0, 3) >>> 5;
        if (!firstPartition || 10 + firstPartition > length) invalid();
        width = data.readUInt16LE(6) & 0x3fff; height = data.readUInt16LE(8) & 0x3fff;
      } else {
        if (length < 6 || data[0] !== 0x2f || (data[4] >> 5)) invalid();
        const bits = data.readUInt32LE(1);
        width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
      }
      dimensions(width, height);
      if (canvas && (canvas[0] !== width || canvas[1] !== height)) invalid();
      image = true;
    } else if (["ANIM", "ANMF"].includes(type)) {
      invalid("Use a still PNG, JPEG or WebP logo.");
    } else if (!["ALPH", "ICCP", "EXIF", "XMP "].includes(type)) invalid();
    offset = end + (length % 2);
  }
  if (!image) invalid();
}
