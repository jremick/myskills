import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest } from "../src/manifest.js";

test("validates a portable skill manifest", () => {
  const manifest = parseSkillManifest({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    visibility: "public",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["writing", "release"],
  });

  assert.equal(manifest.name, "release-notes-helper");
  assert.equal(manifest.platforms[0]?.status, "supported");
});

test("rejects invalid skill slugs", () => {
  assert.throws(() => parseSkillManifest({
    name: "Bad--Slug",
    title: "Bad Slug",
    summary: "Invalid package.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
  }));
});

test("rejects unsafe platform names", () => {
  for (const name of ["codex skill", "codex;rm", "$(codex)", "codex|sh", "codex/skill", "-codex", "codex-"]) {
    assert.throws(() => parseSkillManifest({
      name: "release-notes-helper",
      title: "Release Notes Helper",
      summary: "Turns merged changes into concise release notes.",
      version: "0.1.0",
      license: "Apache-2.0",
      platforms: [{ name, install_target: "codex-skill" }],
    }));
  }
});

test("rejects unknown manifest fields", () => {
  assert.throws(() => parseSkillManifest({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill", hidden: true }],
  }));
  assert.throws(() => parseSkillManifest({
    name: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    version: "0.1.0",
    license: "Apache-2.0",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    hidden: true,
  }));
});
