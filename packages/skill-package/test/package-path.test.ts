import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_TEXT_BYTES,
  loadSkillManifestFromPackageFiles,
  normalizePackageFilePath,
  loadSkillManifestFromPath,
  readPackageFilesFromZipBuffer,
  readPackageFilesFromPath,
  scanPackageFiles,
  scanPackagePath,
} from "../src/package-path.js";
import { hasBlockingFindings } from "../src/scan.js";
import { writeStoredZip } from "../../../test-support/zip-fixture.js";

test("loads a skill manifest from a package directory", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "skill.json"), JSON.stringify({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  }));

  const manifest = await loadSkillManifestFromPath(dir);

  assert.equal(manifest.name, "release-notes-helper");
  assert.equal(manifest.platforms[0]?.status, "supported");
});

test("loads a skill manifest from a package zip", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, [{
    path: "skill.json",
    content: manifestJson(),
  }]);

  const manifest = await loadSkillManifestFromPath(zipPath);

  assert.equal(manifest.name, "release-notes-helper");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.platforms[0]?.status, "supported");
});

test("scans package files and attaches relative paths to findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  await writeFile(path.join(dir, "skill.json"), JSON.stringify({
    name: "unsafe-skill",
    title: "Unsafe Skill",
    summary: "Contains a secret fixture.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  }));
  await writeFile(path.join(dir, "README.md"), `token: ${token}`);

  const result = await scanPackagePath(dir);

  assert.equal(result.filesScanned, 2);
  assert.equal(hasBlockingFindings(result.findings), true);
  assert.deepEqual(result.findings.map((finding) => finding.path), ["README.md"]);
});

test("scans zip entries and attaches archive-relative paths to findings", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "unsafe.zip");
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "docs/README.md", content: `token: ${token}` },
  ]);

  const result = await scanPackagePath(zipPath);

  assert.equal(result.filesScanned, 2);
  assert.equal(hasBlockingFindings(result.findings), true);
  assert.deepEqual(result.findings.map((finding) => finding.path), ["docs/README.md"]);
});

test("reads package files from disk in stable relative-path order", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "skill.json"), "{}");
  await writeFile(path.join(dir, "README.md"), "readme");

  const files = await readPackageFilesFromPath(dir);

  assert.deepEqual(files.map((file) => file.path), ["README.md", "skill.json"]);
});

test("reads package files from a zip in stable relative-path order", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "commands/install.md", content: "Install the skill." },
    { path: "README.md", content: "Package readme." },
  ]);

  const files = await readPackageFilesFromPath(zipPath);

  assert.deepEqual(files.map((file) => file.path), ["commands/install.md", "README.md", "skill.json"]);
  assert.equal(files[1]?.content, "Package readme.");
});

test("reads package files from an uploaded zip buffer", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "package.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "README.md", content: "Package readme." },
  ]);

  const files = await readPackageFilesFromZipBuffer(await readFile(zipPath));

  assert.deepEqual(files.map((file) => file.path), ["README.md", "skill.json"]);
  assert.equal(files[0]?.content, "Package readme.");
});

test("rejects symlinks in package directories", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "target.txt"), "ordinary text");
  await symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"));

  await assert.rejects(() => scanPackagePath(dir), /symlinks/);
});

test("rejects unsafe zip entry paths", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    { entryPath: "../secret.txt", pattern: /invalid relative|traverse/ },
    { entryPath: "/secret.txt", pattern: /absolute/ },
    { entryPath: "C:/secret.txt", pattern: /absolute/ },
    { entryPath: "dir\\secret.txt", pattern: /invalid characters|forward slashes/ },
  ];

  for (const item of cases) {
    const zipPath = path.join(dir, `${item.entryPath.replace(/[^A-Za-z0-9]/g, "-")}.zip`);
    await writeStoredZip(zipPath, [
      { path: "skill.json", content: manifestJson() },
      { path: item.entryPath, content: "nope" },
    ]);
    await assert.rejects(() => readPackageFilesFromPath(zipPath), item.pattern);
  }
});

test("rejects duplicate normalized zip entry paths", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "duplicate.zip");
  await writeStoredZip(zipPath, [
    { path: "README.md", content: "one" },
    { path: "./README.md", content: "two" },
  ]);

  await assert.rejects(() => readPackageFilesFromPath(zipPath), /duplicate/);
});

test("rejects symlink zip entries", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "symlink.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "link.txt", content: "target.txt", mode: 0o120777 },
  ]);

  await assert.rejects(() => readPackageFilesFromPath(zipPath), /symlinks/);
});

test("rejects encrypted and unsupported zip entries", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const encryptedZip = path.join(dir, "encrypted.zip");
  await writeStoredZip(encryptedZip, [
    { path: "skill.json", content: manifestJson() },
    { path: "secret.txt", content: "secret", encrypted: true },
  ]);
  const unsupportedZip = path.join(dir, "unsupported.zip");
  await writeStoredZip(unsupportedZip, [
    { path: "skill.json", content: manifestJson() },
    { path: "compressed.txt", content: "content", compressionMethod: 99 },
  ]);

  await assert.rejects(() => readPackageFilesFromPath(encryptedZip), /encrypted/);
  await assert.rejects(() => readPackageFilesFromPath(unsupportedZip), /unsupported compression/);
});

test("enforces zip package file and text limits", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tooManyFilesZip = path.join(dir, "too-many-files.zip");
  await writeStoredZip(tooManyFilesZip, Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, index) => ({
    path: `file-${index}.txt`,
    content: "x",
  })));
  const tooMuchTextZip = path.join(dir, "too-much-text.zip");
  await writeStoredZip(tooMuchTextZip, [{
    path: "README.md",
    content: "x".repeat(MAX_PACKAGE_TEXT_BYTES + 1),
  }]);

  await assert.rejects(() => readPackageFilesFromPath(tooManyFilesZip), /more than 500 files/);
  const scan = await scanPackagePath(tooMuchTextZip);
  assert.equal(hasBlockingFindings(scan.findings), true);
  assert.equal(scan.findings[0]?.path, "README.md");
  assert.match(scan.findings[0]?.message ?? "", /exceeds/);
  await assert.rejects(() => readPackageFilesFromPath(tooMuchTextZip), /exceeds/);
});

test("rejects zip file content that is not strict UTF-8 text", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, "binary.zip");
  await writeStoredZip(zipPath, [
    { path: "skill.json", content: manifestJson() },
    { path: "binary.bin", content: Buffer.from([0xff]) },
  ]);

  await assert.rejects(() => readPackageFilesFromPath(zipPath), /valid UTF-8/);
  await assert.rejects(readPackageFilesFromZipBuffer(await readFile(zipPath)), /valid UTF-8/);
});

test("scans in-memory package files", () => {
  const token = `ATATT${"abcdefghijklmnopqrstuvwxyz1234567890"}`;
  const result = scanPackageFiles([
    { path: "skill.json", content: "{}" },
    { path: "README.md", content: `token: ${token}` },
  ]);

  assert.equal(result.filesScanned, 2);
  assert.equal(hasBlockingFindings(result.findings), true);
  assert.equal(result.findings[0]?.path, "README.md");
});

test("loads a skill manifest from normalized package file entries", () => {
  const manifest = loadSkillManifestFromPackageFiles([
    { path: "./ai-skill.json", content: manifestJson({ name: "alternate-helper" }) },
    { path: "README.md", content: "readme" },
  ]);

  assert.equal(manifest.name, "alternate-helper");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.visibility, "private");
});

test("rejects missing, invalid, and ambiguous package manifest file entries", () => {
  assert.throws(() => loadSkillManifestFromPackageFiles([
    { path: "README.md", content: "readme" },
  ]), /required/);
  assert.throws(() => loadSkillManifestFromPackageFiles([
    { path: "skill.json", content: "{}" },
  ]), /invalid/);
  assert.throws(() => loadSkillManifestFromPackageFiles([
    { path: "skill.json", content: manifestJson() },
    { path: "skill-manifest.json", content: manifestJson() },
  ]), /multiple/);
});

test("rejects unsafe package payload paths", () => {
  assert.throws(() => normalizePackageFilePath("../secret.txt"), /traverse/);
  assert.throws(() => normalizePackageFilePath("dir/../secret.txt"), /traverse/);
  assert.throws(() => normalizePackageFilePath("/secret.txt"), /absolute/);
  assert.throws(() => normalizePackageFilePath("C:/secret.txt"), /absolute/);
  assert.throws(() => normalizePackageFilePath("C:secret.txt"), /absolute/);
  assert.throws(() => normalizePackageFilePath("dir\\secret.txt"), /forward slashes/);
  assert.throws(() => normalizePackageFilePath("https://example.test/skill.json"), /URL/);
  assert.throws(() => normalizePackageFilePath("mailto:security@example.test"), /URL/);
  assert.throws(() => normalizePackageFilePath("bad\0path.txt"), /NUL/);
});

test("rejects duplicate package payload paths", () => {
  assert.throws(() => scanPackageFiles([
    { path: "README.md", content: "one" },
    { path: "./README.md", content: "two" },
  ]), /duplicate/);
});

async function makeTempPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "myskills-package-"));
}

function manifestJson(overrides: Partial<{
  name: string;
  version: string;
}> = {}): string {
  return JSON.stringify({
    name: overrides.name ?? "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: overrides.version ?? "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  });
}
