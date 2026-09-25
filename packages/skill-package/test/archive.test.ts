import assert from "node:assert/strict";
import test from "node:test";
import { encodePackageArchive, PackageArchiveScanError } from "../src/archive.js";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES, readPackageFilesFromZipBuffer } from "../src/package-path.js";

const manifest = { path: "skill.json", content: JSON.stringify({
  name: "archive-test", title: "Archive Test", summary: "Tests portable packaging.", version: "1.0.0", license: "MIT",
  platforms: [{ name: "codex", install_target: "codex-skill" }],
}) };

test("ZIP STORE bytes preserve UTF-8 BOM, empty files, line endings and non-ASCII names", async () => {
  const files = [manifest, { path: "文書/é.md", content: "\ufeffCafé 🐈\r\n" }, { path: "empty.txt", content: "" }];
  const bytes = encodePackageArchive(files);
  const decoded = await readPackageFilesFromZipBuffer(bytes);
  assert.deepEqual(new Map(decoded.map((file) => [file.path, file.content])), new Map(files.map((file) => [file.path, file.content])));
  assert.deepEqual(bytes, encodePackageArchive([...files].reverse()));
  assert.equal(bytes.readUInt16LE(6), 0x0800);
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.equal(bytes.readUInt16LE(10), 0);
  assert.equal(bytes.readUInt16LE(12), 0x0021);
});

test("archive entry order uses ordinal UTF-8 bytes, independent of localeCompare", (t) => {
  const files = [manifest, { path: "Z.txt", content: "123456789" }, { path: "a.txt", content: "lowercase" }, { path: "é.txt", content: "accent" }];
  const expected = encodePackageArchive(files);
  t.mock.method(String.prototype, "localeCompare", () => { throw new Error("locale-sensitive order"); });
  assert.deepEqual(encodePackageArchive([...files].reverse()), expected);
  const nameLength = expected.readUInt16LE(26);
  assert.equal(expected.subarray(30, 30 + nameLength).toString("utf8"), "Z.txt");
  assert.equal(expected.readUInt32LE(14), 0xcbf43926); // Independent standard CRC32 check vector.
});

test("archive rejects invalid manifests, non-canonical and colliding paths, invalid text and blocked content", () => {
  for (const files of [
    [], [{ path: "skill.json", content: "{}" }],
    [manifest, { path: "../escape.txt", content: "text" }],
    [manifest, { path: "folder/../escape.txt", content: "text" }],
    [manifest, { path: "folder//file.txt", content: "text" }],
    [manifest, { path: "CON.txt", content: "text" }],
    [manifest, { path: "Skill.JSON", content: "text" }],
    [manifest, { path: "bad.txt", content: "\ud800" }],
    [manifest, { path: "bad.txt", content: "nul\0" }],
  ]) assert.throws(() => encodePackageArchive(files));
  assert.throws(() => encodePackageArchive([manifest, { path: "secret.txt", content: `token: ATATT${"a".repeat(30)}` }]), PackageArchiveScanError);
});

test("archive enforces text, file, path and total archive byte limits", () => {
  assert.throws(() => encodePackageArchive([manifest, { path: "large.txt", content: "x".repeat(MAX_PACKAGE_TEXT_BYTES) }]), /blocking scan/);
  assert.throws(() => encodePackageArchive([manifest, ...Array.from({ length: MAX_PACKAGE_FILES }, (_, i) => ({ path: `file-${i}`, content: "" }))]), /more than/);
  assert.throws(() => encodePackageArchive([manifest, { path: "x".repeat(65_490), content: "" }]), /name limit/);
  assert.throws(() => encodePackageArchive([manifest, ...Array.from({ length: 100 }, (_, i) => ({ path: `${i}-${"x".repeat(60_000)}`, content: "" }))]), /archive exceeds/);
});

test("warnings do not prevent archive creation", async () => {
  const files = [manifest, { path: "package.json", content: '{"scripts":{"install":"echo review"}}' }];
  assert.equal((await readPackageFilesFromZipBuffer(encodePackageArchive(files))).length, 2);
});
