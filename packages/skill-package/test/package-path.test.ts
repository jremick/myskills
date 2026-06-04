import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkillManifestFromPath, scanPackagePath } from "../src/package-path.js";
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

test("rejects symlinks in package directories", async (t) => {
  const dir = await makeTempPackage();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "target.txt"), "ordinary text");
  await symlink(path.join(dir, "target.txt"), path.join(dir, "link.txt"));

  await assert.rejects(() => scanPackagePath(dir), /symlinks/);
});

async function makeTempPackage(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ai-skills-package-"));
}
