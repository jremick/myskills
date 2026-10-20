import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportPackageTree } from "../src/install-filesystem.js";

test("CLI exports image assets as their original bytes, not the JSON transport encoding", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-export-image-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  await exportPackageTree([{ path: "assets/logo.png", content }, { path: "SKILL.md", content: "Instructions" }], path.join(root, "out"));
  assert.deepEqual(await readFile(path.join(root, "out/assets/logo.png")), Buffer.from(content, "base64"));
  assert.equal(await readFile(path.join(root, "out/SKILL.md"), "utf8"), "Instructions");
});
