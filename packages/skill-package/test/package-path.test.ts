import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizePackageFilePath,
  loadSkillManifestFromPath,
  readPackageFilesFromPath,
  scanPackageFiles,
  scanPackagePath,
} from "../src/package-path.js";
import { hasBlockingFindings } from "../src/scan.js";

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

test("reads package files from disk in stable relative-path order", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "skill.json"), "{}");
  await writeFile(path.join(dir, "README.md"), "readme");

  const files = await readPackageFilesFromPath(dir);

  assert.deepEqual(files.map((file) => file.path), ["README.md", "skill.json"]);
});

test("rejects symlinks in package directories", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "target.txt"), "ordinary text");
  await symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"));

  await assert.rejects(() => scanPackagePath(dir), /symlinks/);
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

test("rejects unsafe package payload paths", () => {
  assert.throws(() => normalizePackageFilePath("../secret.txt"), /traverse/);
  assert.throws(() => normalizePackageFilePath("/secret.txt"), /absolute/);
  assert.throws(() => normalizePackageFilePath("C:/secret.txt"), /absolute/);
  assert.throws(() => normalizePackageFilePath("dir\\secret.txt"), /forward slashes/);
  assert.throws(() => normalizePackageFilePath("https://example.test/skill.json"), /URL/);
  assert.throws(() => normalizePackageFilePath("bad\0path.txt"), /NUL/);
});

test("rejects duplicate package payload paths", () => {
  assert.throws(() => scanPackageFiles([
    { path: "README.md", content: "one" },
    { path: "./README.md", content: "two" },
  ]), /duplicate/);
});

async function makeTempPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ai-skills-package-"));
}
