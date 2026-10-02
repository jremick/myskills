import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// A child-only builtin preload changes real files at exact syscall boundaries.
// Production code has no test hook, alternate reader or injected filesystem.
const preloadSource = `
import fs from 'node:fs';
import { dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const target = process.env.READ_TARGET, mode = process.env.READ_MODE;
const directoryTarget = process.env.READ_DIRECTORY;
const original = { ...fs };
const log = row => original.appendFileSync(process.env.READ_EVENTS, JSON.stringify(row) + '\\n');
let changed = false;
function mutate(stage) {
  if (changed) return;
  if (stage === 'open' && mode === 'symlink') {
    original.renameSync(target, target + '.original');
    original.symlinkSync(target + '.original', target); changed = true;
  } else if (stage === 'opened' && mode === 'replace-after-open') {
    original.renameSync(target, target + '.original');
    original.writeFileSync(target, 'substituted path bytes'); changed = true;
  } else if (stage === 'opened' && mode === 'ancestor-symlink') {
    const parent = dirname(target);
    original.renameSync(parent, parent + '.original');
    original.symlinkSync(parent + '.original', parent); changed = true;
  } else if (stage === 'read' && ['replace-before-read', 'link-before-read'].includes(mode)) {
    original.renameSync(target, target + '.original');
    original.writeFileSync(target + '.replacement', 'substituted path bytes');
    if (mode === 'link-before-read') original.symlinkSync(target + '.replacement', target);
    else original.renameSync(target + '.replacement', target);
    changed = true;
  } else if (stage === 'read' && ['grow', 'shrink'].includes(mode)) {
    original.truncateSync(target, mode === 'grow' ? Number(process.env.READ_CAP) + 50 : 0); changed = true;
  }
}
const descriptors = new Set();
fs.openSync = (path, ...args) => {
  if (path !== target) return original.openSync(path, ...args);
  mutate('open');
  const fd = original.openSync(path, ...args); descriptors.add(fd); log({ event: 'open' });
  mutate('opened'); return fd;
};
fs.fstatSync = (fd, ...args) => {
  if (descriptors.has(fd) && mode === 'stat-error') throw new Error('Synthetic descriptor stat failure');
  return original.fstatSync(fd, ...args);
};
fs.readSync = (fd, buffer, offset, length, position) => {
  if (!descriptors.has(fd)) return original.readSync(fd, buffer, offset, length, position);
  mutate('read'); log({ event: 'read', length, position });
  if (mode === 'read-error') throw new Error('Synthetic descriptor read failure');
  return original.readSync(fd, buffer, offset, mode === 'short-read' ? Math.min(length, 7) : length, position);
};
fs.closeSync = (fd, ...args) => {
  if (descriptors.delete(fd)) log({ event: 'close' });
  return original.closeSync(fd, ...args);
};
const open = fs.promises.open;
fs.promises.open = async (path, ...args) => {
  if (path !== target && path !== directoryTarget) return open(path, ...args);
  const kind = path === directoryTarget ? 'directory' : 'file';
  if (kind === 'file') mutate('open');
  const handle = await open(path, ...args); log({ event: 'open', kind });
  if (kind === 'file') mutate('opened');
  const stat = handle.stat.bind(handle), read = handle.read.bind(handle), close = handle.close.bind(handle);
  handle.stat = async (...args) => {
    if (kind === 'file' && mode === 'stat-error') throw new Error('Synthetic descriptor stat failure');
    const info = await stat(...args);
    if (kind === 'directory' && mode.endsWith('directory-substitution') && !changed) {
      original.renameSync(path, path + '.original');
      original.mkdirSync(path);
      original.writeFileSync(target, '<h1>substituted directory preview</h1>');
      changed = true; log({ event: 'directory-substitution', inspected: info.isDirectory() });
    }
    return info;
  };
  handle.read = async (buffer, offset, length, position) => {
    mutate('read'); log({ event: 'read', length, position });
    if (mode === 'read-error') throw new Error('Synthetic descriptor read failure');
    return read(buffer, offset, mode === 'short-read' ? Math.min(length, 7) : length, position);
  };
  handle.close = async () => { log({ event: 'close', kind }); return close(); };
  return handle;
};
syncBuiltinESMExports();
`;

function fixture(t, adapter, mode) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "myskills-bounded-read-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "source"); mkdirSync(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", packageManager: "npm@11.12.1" }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ version: "1.0.0", lockfileVersion: 3, packages: {} }));
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Synthetic read control", "-c", "user.email=fixture@example.test", "commit", "-qm", "source");
  const commit = git("rev-parse", "HEAD").toString().trim();
  mkdirSync(join(root, "dist/release"), { recursive: true });
  const archive = git("archive", "--format=tar", "--prefix=fixture-1.0.0/", "HEAD");
  writeFileSync(join(root, "dist/release/source.tar"), archive);
  writeFileSync(join(root, "dist/release/release-metadata.json"), JSON.stringify({ name: "fixture", version: "1.0.0", commitSha: commit, dirty: false,
    artifacts: [{ file: "source.tar", byteSize: archive.length, sha256: hash(archive) }] }));
  mkdirSync(join(base, "site/scripts"), { recursive: true });
  mkdirSync(join(base, "site/dist/guide"), { recursive: true });
  copyFileSync(join(repo, "apps/site/scripts/serve.mjs"), join(base, "site/scripts/serve.mjs"));
  writeFileSync(join(base, "site/dist/index.html"), "<h1>root preview</h1>");
  writeFileSync(join(base, "site/dist/guide/index.html"), "<h1>directory preview</h1>");
  const target = adapter === "release" ? join(root, "package.json") : adapter === "provenance" ? join(root, "dist/release/source.tar") : join(base, mode === "root-directory-substitution" ? "site/dist/index.html" : "site/dist/guide/index.html");
  let expected = readFileSync(target);
  const cap = adapter === "release" ? 1024 * 1024 : adapter === "provenance" ? 128 * 1024 * 1024 : 16 * 1024 * 1024;
  if (mode === "exact-cap") {
    if (adapter === "release") writeFileSync(target, Buffer.concat([expected, Buffer.alloc(cap - expected.length, 32)]));
    else execFileSync(process.execPath, ["-e", "require('fs').truncateSync(process.argv[1], Number(process.argv[2]))", target, String(cap)]);
    expected = readFileSync(target);
    if (adapter === "provenance") {
      const path = join(root, "dist/release/release-metadata.json"), metadata = JSON.parse(readFileSync(path));
      metadata.artifacts[0].byteSize = cap; metadata.artifacts[0].sha256 = hash(expected);
      writeFileSync(path, JSON.stringify(metadata));
    }
  }
  if (mode === "oversize") execFileSync(process.execPath, ["-e", "require('fs').truncateSync(process.argv[1], Number(process.argv[2]))", target, String(cap + 1)]);
  if (mode === "directory" || mode === "fifo") {
    rmSync(target);
    if (mode === "directory") mkdirSync(target); else execFileSync("mkfifo", [target]);
  }
  const preload = join(base, "read-control.mjs"), events = join(base, "events.jsonl");
  writeFileSync(preload, preloadSource);
  const env = { ...process.env, READ_TARGET: target, READ_DIRECTORY: adapter === "site" ? dirname(target) : "", READ_MODE: mode, READ_EVENTS: events, READ_CAP: String(cap) };
  const rows = () => existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { base, root, commit, target, expected, cap, preload, env, rows };
}

const modes = ["normal", "exact-cap", "short-read", "replace-before-read", "link-before-read", "replace-after-open", "symlink", "ancestor-symlink", "oversize", "grow", "shrink", "directory", "fifo", "stat-error", "read-error"];
const succeeds = (adapter, mode) => ["normal", "short-read", "replace-before-read", "link-before-read"].includes(mode) || (mode === "exact-cap" && adapter !== "provenance");
function assertReads(f, mode) {
  const rows = f.rows(), opened = rows.filter(row => row.event === "open").length;
  assert.equal(rows.filter(row => row.event === "close").length, opened, "every opened descriptor must close, including failed stat/read/validation");
  const leafOpened = f.env.READ_DIRECTORY ? rows.filter(row => row.event === "open" && row.kind === "file").length : opened;
  if (!["symlink"].includes(mode)) assert.ok(leafOpened > 0, "control must reach the real leaf descriptor");
  if (f.env.READ_DIRECTORY) for (const kind of ["directory", "file"]) {
    assert.equal(rows.filter(row => row.event === "close" && row.kind === kind).length, rows.filter(row => row.event === "open" && row.kind === kind).length, `every ${kind} handle must close`);
  }
  for (const row of rows.filter(row => row.event === "read")) {
    assert.ok(row.position + row.length <= Math.min(f.expected.length, f.cap) + 1, "growth must never expand the original bounded read");
  }
  if (["replace-after-open", "ancestor-symlink", "oversize", "directory", "fifo", "stat-error"].includes(mode)) assert.equal(rows.some(row => row.event === "read"), false, "invalid opened objects must be rejected before reading");
  if (["grow", "shrink", "read-error"].includes(mode)) assert.ok(rows.some(row => row.event === "read"), "failure control must reach the read boundary");
  if (mode.endsWith("directory-substitution")) {
    assert.deepEqual(rows.filter(row => row.event === "directory-substitution"), [{ event: "directory-substitution", inspected: true }], "control must replace a real inspected directory");
    for (const kind of ["directory", "file"]) {
      assert.equal(rows.filter(row => row.event === "open" && row.kind === kind).length, 1, `the ${kind} handle must open`);
      assert.equal(rows.filter(row => row.event === "close" && row.kind === kind).length, 1, `the ${kind} handle must close`);
    }
    assert.ok(rows.findIndex(row => row.event === "close" && row.kind === "directory") > rows.findIndex(row => row.event === "open" && row.kind === "file"), "the inspected directory handle must remain open through index selection");
    assert.equal(rows.some(row => row.event === "read"), false, "directory substitution must fail before consuming the selected index");
  }
}

for (const adapter of ["release", "provenance"]) for (const mode of modes) {
  test(`${adapter} descriptor reader: ${mode}`, { timeout: 15_000 }, t => {
    const f = fixture(t, adapter, mode);
    const args = adapter === "release" ? ["--input-type=module", "-e", `import { sourceIdentity } from ${JSON.stringify(join(repo, "scripts/lib/self-host-release.mjs"))}; console.log(JSON.stringify(sourceIdentity(process.cwd(), ${JSON.stringify(f.commit)})));`] :
      [join(repo, "scripts/create-trust-provenance.mjs"), "--release", "dist/release", "--out", "dist/provenance"];
    const result = spawnSync(process.execPath, ["--import", f.preload, ...args], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.signal, null, "non-regular objects must not block open");
    assert.equal(result.status, succeeds(adapter, mode) ? 0 : 1, result.stderr);
    assertReads(f, mode);
    if (adapter === "release" && succeeds(adapter, mode)) assert.deepEqual(JSON.parse(result.stdout), { commit: f.commit, version: "1.0.0" });
    if (adapter === "provenance") {
      assert.equal(existsSync(join(f.root, "dist/provenance")), succeeds(adapter, mode), "denied input must not create output");
      if (mode === "exact-cap") {
        assert.match(result.stderr, /Source archive does not reproduce from this exact revision/, "exactly128MiB passes the bounded reader/digest, then must fail exact-source reproduction");
        assert.ok(f.rows().some(row => row.event === "read" && row.length === f.cap + 1));
      }
      if (succeeds(adapter, mode)) {
        const proof = JSON.parse(readFileSync(join(f.root, "dist/provenance/provenance.json")));
        assert.equal(proof.release.artifacts[0].sha256, hash(f.expected));
        assert.equal(proof.release.sourceArchiveReproduced, true);
      }
    }
  });
}

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve)); return port;
}

for (const mode of [...modes, "directory-substitution", "root-directory-substitution"]) test(`site preview descriptor reader: ${mode}`, { timeout: 15_000 }, async t => {
  const f = fixture(t, "site", mode), port = await availablePort();
  const child = spawn(process.execPath, ["--import", f.preload, join(f.base, "site/scripts/serve.mjs"), "--port", String(port)], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  // Always stop the owned child, including failed HTTP or startup assertions.
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); } });
  await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => reject(new Error(`Preview exited before listen: ${code}`)));
    child.stdout.once("data", resolve);
  });
  const url = `http://127.0.0.1:${port}`;
  const response = await fetch(`${url}${mode === "root-directory-substitution" ? "/" : "/guide/"}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, succeeds("site", mode) ? 200 : 404);
  const body = Buffer.from(await response.arrayBuffer());
  if (succeeds("site", mode)) { assert.equal(body.length, f.expected.length); assert.equal(hash(body), hash(f.expected)); }
  else assert.equal(body.toString(), "Not found");
  assertReads(f, mode);
  if (mode === "normal") {
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const head = await fetch(`${url}/guide/`, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal(await (await fetch(`${url}/`)).text(), "<h1>root preview</h1>");
    const rootHead = await fetch(`${url}/`, { method: "HEAD" }); assert.equal(rootHead.status, 200); assert.equal(await rootHead.text(), "");
    const denied = await fetch(`${url}/guide/`, { method: "POST" }); assert.equal(denied.status, 405); assert.equal(denied.headers.get("allow"), "GET, HEAD");
    for (const path of ["/missing", "/%ZZ", "/..%2f..%2fsource/package.json"]) assert.equal((await fetch(`${url}${path}`)).status, 404);
    assertReads(f, mode);
  }
});
