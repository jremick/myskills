import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("build metadata requires an exact revision and preserves unknown local source", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "myskills-build-identity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: "0.1.0-beta.5" }));
  const script = resolve("scripts/write-build-info.mjs");
  for (const revision of ["", "a".repeat(40)]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: directory, env: { ...process.env, MYSKILLS_BUILD_REVISION: revision }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8")), {
      version: "0.1.0-beta.5", revision: revision || null,
    });
  }
  const marker = "untrusted-input-must-not-be-printed";
  const rejected = spawnSync(process.execPath, [script], {
    cwd: directory, env: { ...process.env, MYSKILLS_BUILD_REVISION: marker }, encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(rejected.stdout + rejected.stderr, new RegExp(marker));
});
