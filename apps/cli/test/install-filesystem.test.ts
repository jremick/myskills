import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportPackageTree, validatePortableFilePaths, withInstallRootLock } from "../src/install-filesystem.js";

test("root lock excludes a second process and recovers only after the owner dies", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/install-filesystem.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { withInstallRootLock } from ${JSON.stringify(moduleUrl)};
    await withInstallRootLock(process.argv[1], async () => {
      process.stdout.write("locked");
      await new Promise(resolve => process.stdin.once("data", resolve));
    });
  `, root], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  const [message] = await once(child.stdout, "data");
  assert.equal(String(message), "locked");
  let entered = false;
  const contender = withInstallRootLock(root, async () => { entered = true; });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(entered, false, "a live process still owns the root");
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  await contender;
  assert.equal(entered, true);
});

test("root lock refuses a symlinked state directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-lock-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "myskills-lock-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, path.join(root, ".myskills-app"));
  await assert.rejects(withInstallRootLock(root, async () => assert.fail("must not enter")), /symlink/);
});

test("export does not follow an existing output symlink or overwrite a populated directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-export-safe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "README.md"), "preserve");
  await symlink(outside, path.join(root, "linked"));
  const files = [{ path: "README.md", content: "replacement" }];
  await assert.rejects(exportPackageTree(files, path.join(root, "linked")), /symlink/);
  await assert.rejects(exportPackageTree(files, outside), /new or empty/);
  assert.equal(await readFile(path.join(outside, "README.md"), "utf8"), "preserve");
  await exportPackageTree(files, path.join(root, "new"));
  assert.equal(await readFile(path.join(root, "new", "README.md"), "utf8"), "replacement");
  await exportPackageTree([{ path: "README.md", content: "\ufeffUTF-8 BOM is part of the package bytes.\n" }], path.join(root, "bom"));
  assert.equal(await readFile(path.join(root, "bom", "README.md"), "utf8"), "\ufeffUTF-8 BOM is part of the package bytes.\n");
});

test("package writers reject filesystem collisions before staging bytes", () => {
  for (const paths of [["README.md", "readme.md"], ["a", "a/file"], ["NUL.txt"], ["file:stream"], ["trailing."]]) {
    assert.throws(() => validatePortableFilePaths(paths.map((file) => ({ path: file, content: "x" }))));
  }
});

test("an ancestor swapped during file creation cannot receive exported package bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-export-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = path.join(root, "selected"); const outside = path.join(root, "outside");
  await mkdir(selected); await mkdir(outside);
  const originalOpen = fs.open;
  let swapped = false;
  fs.open = (async (filePath, flags, mode) => {
    if (String(filePath).endsWith("/payload.txt") && !swapped) {
      swapped = true;
      const stage = (await readdir(selected)).find((name) => name.startsWith(".myskills-export-"))!;
      const nested = path.join(selected, stage, "nested");
      await rename(nested, path.join(root, "moved"));
      await symlink(outside, nested);
    }
    return originalOpen(filePath, flags, mode);
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(exportPackageTree([{ path: "nested/payload.txt", content: "synthetic package bytes" }], path.join(selected, "output")));
    assert.equal(swapped, true);
    assert.deepEqual(await readdir(outside), []);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});

test("a failed lock-owner write removes only this attempt's files and preserves the original error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-lock-owner-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalOpen = fs.open;
  const failure = new Error("synthetic owner write failed");
  fs.open = (async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (String(filePath).endsWith("/owner.json")) {
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = async () => { await originalWrite("partial", "utf8"); throw failure; };
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(withInstallRootLock(root, async () => assert.fail("must not enter")), (error) => error === failure);
    assert.deepEqual(await readdir(path.join(root, ".myskills-app")), []);
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
  let entered = false;
  await withInstallRootLock(root, async () => { entered = true; });
  assert.equal(entered, true);
});

test("failed lock acquisition preserves an owner file that this attempt did not open", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-lock-unknown-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalOpen = fs.open;
  const failure = new Error("synthetic owner open failed");
  fs.open = (async (filePath, flags, mode) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (String(filePath).endsWith("/owner.json")) {
      await handle.writeFile("unknown owner", "utf8");
      await handle.close();
      throw failure;
    }
    return handle;
  }) as typeof fs.open;
  syncBuiltinESMExports();
  try {
    await assert.rejects(withInstallRootLock(root, async () => assert.fail("must not enter")), (error) => error === failure);
    assert.equal(await readFile(path.join(root, ".myskills-app", "write.lock", "owner.json"), "utf8"), "unknown owner");
  } finally { fs.open = originalOpen; syncBuiltinESMExports(); }
});
