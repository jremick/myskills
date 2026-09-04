import assert from "node:assert/strict";
import test from "node:test";
import { validateCodexSkill } from "../src/codex-workspace.js";

function skill(description: string, extra = "") {
  return [{ path: "SKILL.md", content: `---\nname: synthetic-skill\ndescription: ${description}\n${extra}---\nSynthetic instructions.\n` }];
}

test("workspace validation accepts standard string and multiline descriptions", () => {
  for (const description of ["Use supplied inputs.", '"Use JSON: safely."', "'Use YAML: safely.'", "|\n  Use supplied inputs.\n  Return a concise result."]) {
    assert.doesNotThrow(() => validateCodexSkill(skill(description), "synthetic-skill"));
  }
});

test("workspace validation rejects malformed or non-string YAML descriptions", () => {
  for (const description of ["[one, two]", "{text: hello}", "true", "123", "null", "'unterminated", "\"\"", "|", '"' + "x".repeat(1025) + '"']) {
    assert.throws(() => validateCodexSkill(skill(description), "synthetic-skill"), undefined, description);
  }
});

test("workspace validation rejects duplicate fields, aliases, and a different skill identity", () => {
  assert.throws(() => validateCodexSkill(skill("Safe text", "name: different-skill\n"), "synthetic-skill"), /unique/);
  assert.throws(() => validateCodexSkill(skill("Safe text"), "another-skill"), /match/);
  assert.throws(() => validateCodexSkill(skill("&text Safe text", "other: *text\n"), "synthetic-skill"), /aliases/);
});
