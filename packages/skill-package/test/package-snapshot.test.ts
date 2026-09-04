import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  MAX_PACKAGE_TEXT_BYTES,
  readPackageFilesFromPath,
  readPackageFilesFromZipBuffer,
  readPackageSnapshot,
  scanPackageFiles,
} from "../src/package-path.js";
import { writeStoredZip } from "../../../test-support/zip-fixture.js";

const manifest = JSON.stringify({
  name: "snapshot-helper", title: "Snapshot helper", summary: "Checks package snapshots.",
  version: "0.1.0", license: "Apache-2.0", platforms: [{ name: "codex", install_target: "codex-skill" }],
});

test("directory and ZIP snapshots hold the same checked bytes after the source changes", async (t) => {
  const dir = await fixture(t);
  const source = path.join(dir, "source");
  await fs.mkdir(source);
  const files = [{ path: "skill.json", content: manifest }, { path: "README.md", content: "\ufeffRead these café instructions.\n" }];
  for (const file of files) await fs.writeFile(path.join(source, file.path), file.content);
  const zipPath = path.join(dir, "source.zip");
  await writeStoredZip(zipPath, files);
  const directory = await readPackageSnapshot(source);
  const archive = await readPackageSnapshot(zipPath);
  assert.deepEqual(directory.files, archive.files);
  assert.deepEqual(directory.manifest, archive.manifest);
  assert.deepEqual(directory.scan.findings, archive.scan.findings);
  assert.equal(directory.scan.bytesScanned, files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0));
  await fs.writeFile(path.join(source, "README.md"), "Changed after scan.");
  await fs.writeFile(zipPath, "Changed after scan.");
  assert.equal(directory.files.find((file) => file.path === "README.md")?.content, files[1].content);
  assert.deepEqual(directory.files, archive.files);
});

test("ZIP buffer reads take ownership of a copy before asynchronous decompression", async (t) => {
  const dir = await fixture(t);
  const zipPath = path.join(dir, "snapshot.zip");
  await writeStoredZip(zipPath, [{ path: "skill.json", content: manifest }]);
  const bytes = await fs.readFile(zipPath);
  const reading = readPackageFilesFromZipBuffer(bytes);
  bytes.fill(0);
  assert.equal((await reading)[0].content, manifest);
});

test("invalid ZIP rejection stays handled while the source file closes asynchronously", async (t) => {
  const dir = await fixture(t);
  const archive = path.join(dir, "invalid.zip");
  await fs.writeFile(archive, "invalid archive");
  const originalOpen = fs.open;
  let closed = false;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (String(filePath).endsWith("/invalid.zip")) {
      const originalClose = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        // Keep cleanup pending across event-loop turns after yauzl rejects.
        await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));
        await originalClose();
        closed = true;
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readPackageFilesFromPath(archive), /end of central directory/i);
  assert.equal(closed, true);
});

test("Linux ancestor directory changes outside the package do not invalidate its snapshot", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await fixture(t);
  const ancestor = path.join(dir, "ancestor");
  const source = path.join(ancestor, "source");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "skill.json"), manifest);
  const originalOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/ancestor") && !changed) {
      changed = true;
      await fs.writeFile(path.join(ancestor, "unrelated.txt"), "outside package");
      await fs.utimes(ancestor, new Date(0), new Date(0));
    }
    return originalOpen(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await readPackageSnapshot(source)).files[0].content, manifest);
  assert.equal(changed, true);
});

test("Linux ancestor replacement after inspection still fails identity verification", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await fixture(t);
  const ancestor = path.join(dir, "ancestor");
  const source = path.join(ancestor, "source");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "skill.json"), manifest);
  const originalOpen = fs.open;
  let replaced = false;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/ancestor") && !replaced) {
      replaced = true;
      await fs.rename(ancestor, path.join(dir, "original"));
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(source, "skill.json"), manifest);
    }
    return originalOpen(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readPackageSnapshot(source), /changed/);
  assert.equal(replaced, true);
});

test("package directory contents changing after inspection still invalidate the snapshot", async (t) => {
  const dir = await fixture(t);
  const source = path.join(dir, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "skill.json"), manifest);
  const originalOpen = fs.open;
  let changed = false;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/source") && !changed) {
      changed = true;
      await fs.writeFile(path.join(source, "new.txt"), "added during read");
      await fs.utimes(source, new Date(0), new Date(0));
    }
    return originalOpen(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readPackageSnapshot(source), /changed/);
  assert.equal(changed, true);
});

test("direct manifest snapshots remain supported and ambiguous directory manifests fail", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "custom.json"), manifest);
  assert.equal((await readPackageSnapshot(path.join(dir, "custom.json"))).manifest.name, "snapshot-helper");
  await fs.writeFile(path.join(dir, "skill.json"), manifest);
  await fs.writeFile(path.join(dir, "ai-skill.json"), manifest);
  await assert.rejects(readPackageSnapshot(dir), /multiple root manifests/);
});

test("directory reads enforce total byte limits before allocating oversized files", async (t) => {
  const dir = await fixture(t);
  const large = path.join(dir, "large.txt");
  await fs.writeFile(large, "");
  await fs.truncate(large, MAX_PACKAGE_TEXT_BYTES * 100);
  await assert.rejects(readPackageFilesFromPath(dir), /Package text exceeds/);
  await fs.writeFile(large, "a".repeat(MAX_PACKAGE_TEXT_BYTES / 2 + 1));
  await fs.writeFile(path.join(dir, "second.txt"), "b".repeat(MAX_PACKAGE_TEXT_BYTES / 2));
  await assert.rejects(readPackageFilesFromPath(dir), /Package text exceeds/);
});

test("directory, ZIP, and normalized payloads reject invalid text and file collisions", async (t) => {
  const dir = await fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0x61, 0])]) {
    const input = path.join(dir, "bad.txt");
    await fs.writeFile(input, bytes);
    await assert.rejects(readPackageFilesFromPath(input), /UTF-8|NUL/);
    const archive = path.join(dir, "bad.zip");
    await writeStoredZip(archive, [{ path: "bad.txt", content: bytes }]);
    await assert.rejects(readPackageFilesFromPath(archive), /UTF-8|NUL/);
  }
  assert.throws(() => scanPackageFiles([{ path: "bad.txt", content: "\ud800" }]), /UTF-8/);
  assert.throws(() => scanPackageFiles([{ path: "bad.txt", content: "\0" }]), /NUL/);
  const collision = [{ path: "docs", content: "file" }, { path: "docs/readme.txt", content: "child" }];
  assert.throws(() => scanPackageFiles(collision), /collision/);
  const archive = path.join(dir, "collision.zip");
  await writeStoredZip(archive, collision);
  await assert.rejects(readPackageFilesFromPath(archive), /collision/);
});

test("local input rejects a pre-existing symlink ancestor", async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, "real"));
  await fs.writeFile(path.join(dir, "real", "skill.json"), manifest);
  await fs.symlink(path.join(dir, "real"), path.join(dir, "alias"));
  await assert.rejects(readPackageSnapshot(path.join(dir, "alias", "skill.json")), /symlinks/);
});

test("a file changed to a symlink after inspection is rejected at open", async (t) => {
  const dir = await fixture(t);
  const target = path.join(dir, "race.txt");
  await fs.writeFile(target, "safe bytes");
  await fs.writeFile(path.join(dir, "outside.txt"), "outside fixture");
  let swapped = false;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/race.txt") && !swapped) {
      swapped = true;
      await fs.unlink(target);
      await fs.symlink(path.join(dir, "outside.txt"), target);
    }
    return originalOpen(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readPackageFilesFromPath(target), /symlinks/);
  assert.equal(swapped, true);
});

test("an ancestor swapped during a package read cannot supply outside bytes", async (t) => {
  const dir = await fixture(t);
  const source = path.join(dir, "source");
  const nested = path.join(source, "nested");
  const outside = path.join(dir, "outside");
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(source, "skill.json"), manifest);
  await fs.writeFile(path.join(nested, "race-fixture.md"), "safe bytes");
  await fs.writeFile(path.join(outside, "race-fixture.md"), "outside fixture");
  let swapped = false;
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/race-fixture.md") && !swapped) {
      swapped = true;
      await fs.rename(nested, path.join(dir, "moved"));
      await fs.symlink(outside, nested);
    }
    return originalOpen(filePath, flags, mode);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(readPackageSnapshot(source), /symlinks|changed/);
  assert.equal(swapped, true);
});

test("unsupported local platforms fail closed while ZIP-buffer intake remains available", async (t) => {
  const dir = await fixture(t);
  const archive = path.join(dir, "portable.zip");
  await writeStoredZip(archive, [{ path: "skill.json", content: manifest }]);
  const bytes = await fs.readFile(archive);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await assert.rejects(readPackageSnapshot(archive), /require macOS or Linux/);
    assert.equal((await readPackageFilesFromZipBuffer(bytes))[0].content, manifest);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

async function fixture(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "myskills-snapshot-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
