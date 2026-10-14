import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readPackageFilesFromPath, readPackageFilesFromZipBuffer, scanPackageFiles, validatePackageFiles } from "../src/package-path.js";
import { writeStoredZip } from "../../../test-support/zip-fixture.js";

// Failure inventory: directory/ZIP intake keeps the old cap, UTF-8 bytes are
// mistaken for characters, scanning rejects accepted text, or overflow is lost.
test("five MiB UTF-8 package survives directory, ZIP, scan and normalized intake with exact overflow rejection", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "myskills-text-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const maximum = 5 * 1024 * 1024;
  const content = "é".repeat(maximum / 2);
  const files = [{ path: "SKILL.md", content }];
  await writeFile(path.join(root, "SKILL.md"), content);
  assert.deepEqual(await readPackageFilesFromPath(root), files);
  const zipPath = path.join(root, "package.zip");
  await writeStoredZip(zipPath, files);
  assert.deepEqual(await readPackageFilesFromZipBuffer(await readFile(zipPath)), files);
  assert.equal(validatePackageFiles(files).bytesScanned, maximum);
  assert.deepEqual(scanPackageFiles(files).findings, []);
  assert.throws(() => validatePackageFiles([{ path: "SKILL.md", content: `${content}x` }]), /5242880 bytes/);
  await writeFile(path.join(root, "SKILL.md"), `${content}x`);
  await assert.rejects(readPackageFilesFromPath(path.join(root, "SKILL.md")), /5242880 bytes/);
});
