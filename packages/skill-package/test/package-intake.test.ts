import test from "node:test";
import assert from "node:assert/strict";
import { preparePackageManifest } from "../src/package-intake.js";

const skill = (frontmatter: string) => [{ path: "SKILL.md", content: `---\n${frontmatter}\n---\nUse supplied information.\n` }];
const required = "name: summary-helper\ndescription: Summarize supplied information.";

test("manifest synthesis preserves supported YAML metadata and defaults visibility to private", () => {
  const files = skill(`${required}\ntitle: 'Summary: Helper'\nversion: 1.2.3\nlicense: MIT\nvisibility: public\ntags: [writing]\nplatforms:\n  - name: claude\n    install_target: claude-skill\nmetadata:\n  arbitrary: ignored`);
  const result = preparePackageManifest(files);
  assert.deepEqual(result.manifest, {
    name: "summary-helper", title: "Summary: Helper", summary: "Summarize supplied information.",
    version: "1.2.3", license: "MIT", visibility: "private", tags: ["writing"],
    platforms: [{ name: "claude", install_target: "claude-skill", status: "supported" }],
  });
  assert.equal(files.length, 1);
  assert.deepEqual(result.files.find(file => file.path === "SKILL.md"), files[0]);
  assert.deepEqual(JSON.parse(result.files.find(file => file.path === "skill.json")!.content), result.manifest);
  assert.equal(result.notices.length, 1);
  const second = preparePackageManifest(result.files);
  assert.deepEqual(second.files, result.files);
  assert.deepEqual(second.notices, []);
});

test("manifest synthesis supports CRLF, quoted scalars, folded descriptions and metadata versions", () => {
  const result = preparePackageManifest(skill("name: 'summary-helper'\ndescription: >-\n  Summarize supplied\n  information.\nmetadata:\n  version: 2.0.0").map(file => ({ ...file, content: file.content.replaceAll("\n", "\r\n") })));
  assert.equal(result.manifest.summary, "Summarize supplied information.");
  assert.equal(result.manifest.version, "2.0.0");
  assert.equal(result.manifest.license, "UNLICENSED");
  assert.equal(result.manifest.title, "Summary Helper");
  assert.deepEqual(result.manifest.platforms, [{ name: "codex", install_target: "codex-skill", status: "supported" }]);
});

test("manifest synthesis bounds the summary without modifying longer source descriptions", () => {
  const files = skill(`name: summary-helper\ndescription: ${"a".repeat(700)}`);
  const result = preparePackageManifest(files);
  assert.equal(result.manifest.summary.length, 500);
  assert.equal(result.files.find(file => file.path === "SKILL.md")!.content, files[0].content);
});

test("manifest synthesis rejects malformed, ambiguous, unsafe and incomplete frontmatter", () => {
  for (const text of [
    "No frontmatter.",
    `---\n${required}\n`,
    "---\nname: summary-helper\n---\n",
    "---\nname: Bad--Name\ndescription: Test.\n---\n",
    `---\n${required}\nname: other-name\n---\n`,
    "---\nname: &name summary-helper\ndescription: *name\n---\n",
    "---\nname: summary-helper\ndescription: !unsafe hello\n---\n",
    "---\nname: summary-helper\ndescription: [not, text]\n---\n",
    `---\n${required}\nversion: 01.2.3\n---\n`,
    `---\n${required}\nnotes: ${"a".repeat(32768)}\n---\n`,
  ]) {
    assert.throws(() => preparePackageManifest([{ path: "SKILL.md", content: text }]), /SKILL\.md|manifest/i);
  }
});

test("manifest synthesis keeps strict existing-manifest, root path, collision and count validation", () => {
  assert.throws(() => preparePackageManifest([{ path: "nested/SKILL.md", content: skill(required)[0].content }]), /manifest.*required/i);
  assert.throws(() => preparePackageManifest([...skill(required), { path: "skill.json", content: "{}" }]), /manifest.*invalid/i);
  assert.throws(() => preparePackageManifest([...skill(required), { path: "Skill.json", content: "unrelated" }]), /collid|manifest/i);
  assert.throws(() => preparePackageManifest([...skill(required), ...Array.from({ length: 499 }, (_, i) => ({ path: `references/${i}.md`, content: "Text." }))]), /500/);
});
