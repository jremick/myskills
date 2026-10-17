import { SaxesParser } from "saxes";

export const MAX_PACKAGE_IMAGE_BYTES = 1024 * 1024;
export const MAX_PACKAGE_IMAGES_BYTES = 5 * 1024 * 1024;
const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

export function packageImageType(path: string): string | undefined {
  return types[path.split(".").at(-1)?.toLowerCase() ?? ""];
}

/** Raster content uses canonical base64 in JSON artifacts; SVG remains UTF-8. */
export function packageFileBytes(file: { path: string; content: string }): Buffer {
  const type = packageImageType(file.path);
  if (!type) return Buffer.from(file.content, "utf8");
  const invalid = () => { throw new Error(`Invalid or oversized image asset: ${file.path}`); };
  if (typeof file.content !== "string" || file.content.length > Math.ceil(MAX_PACKAGE_IMAGE_BYTES / 3) * 4) invalid();
  const bytes = Buffer.from(file.content, type === "image/svg+xml" ? "utf8" : "base64");
  if (!bytes.length || bytes.length > MAX_PACKAGE_IMAGE_BYTES) invalid();
  if (type !== "image/svg+xml" && bytes.toString("base64") !== file.content) invalid();
  if (type === "image/png" && (bytes.length < 45
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1
    || bytes.readUInt32BE(16) > 8192 || bytes.readUInt32BE(20) > 8192
    || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND")) invalid();
  if (type === "image/jpeg" && (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9)) invalid();
  if (type === "image/webp" && (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString("ascii", 8, 12) !== "WEBP"
    || !["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
    || bytes.readUInt32LE(16) > bytes.length - 20)) invalid();
  if (type === "image/svg+xml") validateSvg(file.content);
  return bytes;
}

export function packageImageFromBytes(path: string, bytes: Buffer): { path: string; content: string } {
  const content = packageImageType(path) === "image/svg+xml"
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) : bytes.toString("base64");
  const file = { path, content };
  packageFileBytes(file);
  return file;
}

export function findPackageLogo(files: readonly { path: string; content: string }[]): { bytes: Buffer; contentType: string } | null {
  for (const directory of ["", "assets/"]) {
    for (const extension of ["png", "jpg", "jpeg", "webp", "svg"]) {
      const file = files.find(file => file.path === `${directory}logo.${extension}`);
      if (file) return { bytes: packageFileBytes(file), contentType: types[extension] };
    }
  }
  return null;
}

function validateSvg(content: string): void {
  const invalid = () => { throw new Error("SVG assets must contain only inert vector shapes and local references."); };
  const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "title", "desc", "text", "tspan"]);
  const attributes = new Set(["id", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "fx", "fy", "clip-path", "clip-rule", "clipPathUnits", "mask", "maskUnits", "maskContentUnits", "preserveAspectRatio", "font-family", "font-size", "font-weight", "text-anchor", "dx", "dy", "role", "aria-label"]);
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, count = 0;
  parser.on("error", invalid);
  parser.on("doctype", invalid);
  parser.on("processinginstruction", invalid);
  parser.on("opentag", tag => {
    if (++count > 10_000 || ++depth > 32 || (count === 1 && tag.name !== "svg")
      || !tags.has(tag.name) || (tag.uri && tag.uri !== "http://www.w3.org/2000/svg")) invalid();
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.name === "xmlns" && attribute.value === "http://www.w3.org/2000/svg") continue;
      if (!attributes.has(attribute.name) || attribute.prefix) invalid();
      // No CSS escapes, schemes, entities hiding URLs, or external paint servers.
      const value = attribute.value;
      if (/[\\\u0000-\u001f\u007f]/u.test(value) || /(?:https?:|data:|javascript:|\/\/|@)/i.test(value)) invalid();
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)) invalid();
    }
  });
  parser.on("closetag", () => { depth -= 1; });
  parser.write(content).close();
  if (!count) invalid();
}
