import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_PACKAGE_FILES, MAX_PACKAGE_TEXT_BYTES, readPackageDirectorySnapshot, readPackageSnapshot } from "@myskills-app/skill-package";
import { packageSkill } from "../src/author-package.js";
import { runCli, type CliRuntime } from "../src/cli.js";

const supported = process.platform === "darwin" || process.platform === "linux";
const manifest = JSON.stringify({ name: "archive-test", title: "Archive Test", summary: "Tests local authoring.", version: "1.0.0", license: "MIT", platforms: [{ name: "codex", install_target: "codex-skill" }] });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input");
  await mkdir(input);
  await writeFile(path.join(input, "skill.json"), manifest);
  await writeFile(path.join(input, "SKILL.md"), "\ufeff# Café 🐈\r\n");
  return { root, input, output: path.join(root, "archive.zip") };
}

function runtime(stdout: string[] = [], stderr: string[] = []): CliRuntime {
  return { env: {}, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, fetch: async () => { throw new Error("Local packaging called the network"); } };
}

test("package produces a private deterministic ZIP and a safely quoted submit command without network access", { skip: !supported }, async (t) => {
  const { root, input } = await fixture(t);
  const output = path.join(root, "quoted's-$()-`tick`.zip");
  const stdout: string[] = [], stderr: string[] = [];
  assert.equal(await runCli(["package", "--path", input, "--output", output, "--json"], runtime(stdout, stderr)), 0);
  assert.deepEqual(stderr, []);
  const result = JSON.parse(stdout[0]!);
  const bytes = await readFile(output);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.size, bytes.length);
  assert.equal(result.manifest.name, "archive-test");
  assert.equal(result.scan.filesScanned, 2);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  assert.equal(execFileSync("sh", ["-c", `myskills() { printf '%s\\n' "$@"; }\n${result.next.submit}`], { encoding: "utf8" }), `submit\n--path\n${result.output}\n`);

  const held = await readPackageSnapshot(output);
  await writeFile(path.join(input, "SKILL.md"), "Changed after packaging.");
  const payloads: Array<Record<string, unknown>> = [];
  const submitRuntime = runtime();
  submitRuntime.env.MYSKILLS_TOKEN = "test-token";
  submitRuntime.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body ?? "{}"));
    return { ok: true, status: 201, text: async () => JSON.stringify({ submission: { slug: "archive-test", version: "1.0.0", reviewStatus: "pending", securityStatus: "clean" }, scan: { findingCount: 0 } }) };
  };
  assert.equal(await runCli(["submit", "--path", output], submitRuntime), 0);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0]?.files, held.files);
  assert.equal(held.files.find((file) => file.path === "SKILL.md")?.content, "\ufeff# Café 🐈\r\n");
});

test("package bytes ignore creation order and source mtimes", { skip: !supported }, async (t) => {
  const { root, input, output } = await fixture(t);
  await mkdir(path.join(input, "docs"));
  await writeFile(path.join(input, "docs", "é.txt"), "one");
  const first = await packageSkill({ path: input, output });
  await utimes(path.join(input, "skill.json"), new Date("2000-01-01"), new Date("2000-01-01"));
  await rm(path.join(input, "SKILL.md"));
  await writeFile(path.join(input, "SKILL.md"), "\ufeff# Café 🐈\r\n");
  const second = await packageSkill({ path: input, output: path.join(root, "second.zip") });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.output), await readFile(second.output));
});

test("package encodes the held snapshot even if source files change after checking", { skip: !supported }, async (t) => {
  const { input, output } = await fixture(t);
  await packageSkill({ path: input, output }, async (point) => {
    if (point === "checked") await writeFile(path.join(input, "SKILL.md"), `token: ATATT${"a".repeat(30)}`);
  });
  const archive = await readPackageSnapshot(output);
  assert.equal(archive.files.find((file) => file.path === "SKILL.md")?.content, "\ufeff# Café 🐈\r\n");
});

test("directory-only snapshot rejects a directory swapped to a file before the checked read", { skip: !supported }, async (t) => {
  const { input, output } = await fixture(t);
  await assert.rejects(packageSkill({ path: input, output }, async (point) => {
    if (point === "inspected") { await rename(input, `${input}-saved`); await writeFile(input, manifest); }
  }), /directory/);
  await assert.rejects(readPackageDirectorySnapshot(input), /directory/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("package refuses an existing or racing destination without changing it", { skip: !supported }, async (t) => {
  const { root, input, output } = await fixture(t);
  await writeFile(output, "keep");
  await assert.rejects(packageSkill({ path: input, output }), /will not be overwritten/);
  assert.equal(await readFile(output, "utf8"), "keep");
  await rm(output);
  await assert.rejects(packageSkill({ path: input, output }, async (point) => {
    if (point === "checked") await writeFile(output, "racing writer");
  }), /will not be overwritten/);
  assert.equal(await readFile(output, "utf8"), "racing writer");
  await rm(output);
  await mkdir(output);
  await assert.rejects(packageSkill({ path: input, output }), /will not be overwritten/);
  assert.deepEqual(await readdir(output), []);
  await rm(output, { recursive: true });
  const target = path.join(root, "target.txt");
  await writeFile(target, "target");
  await symlink(target, output);
  await assert.rejects(packageSkill({ path: input, output }), /will not be overwritten/);
  assert.equal(await readFile(target, "utf8"), "target");
  assert.equal((await lstat(output)).isSymbolicLink(), true);
});

test("a failed write never deletes another writer's replacement", { skip: !supported }, async (t) => {
  const { input, output } = await fixture(t);
  await assert.rejects(packageSkill({ path: input, output }, async (point) => {
    if (point === "created") { await rm(output); await writeFile(output, "replacement"); throw new Error("write failure"); }
  }), /partial file may remain/);
  assert.equal(await readFile(output, "utf8"), "replacement");
});

test("package refuses output in the source tree, missing parents and symlink ancestry", { skip: !supported }, async (t) => {
  const { root, input } = await fixture(t);
  await mkdir(path.join(input, "nested"));
  for (const output of [path.join(input, "in.zip"), path.join(input, "nested", "in.zip"), path.join(root, "missing", "out.zip")]) {
    await assert.rejects(packageSkill({ path: input, output }));
    await assert.rejects(lstat(output), { code: "ENOENT" });
  }
  await symlink(input, path.join(root, "linked-source"));
  await assert.rejects(packageSkill({ path: path.join(root, "linked-source"), output: path.join(root, "out.zip") }));
  await mkdir(path.join(root, "real-parent"));
  await symlink(path.join(root, "real-parent"), path.join(root, "linked-parent"));
  await assert.rejects(packageSkill({ path: input, output: path.join(root, "linked-parent", "out.zip") }), /no symlink ancestors/);
  assert.deepEqual(await readdir(path.join(root, "real-parent")), []);
});

test("package rejects an output parent replaced after the snapshot", { skip: !supported }, async (t) => {
  const { root, input } = await fixture(t);
  const parent = path.join(root, "parent");
  await mkdir(parent);
  await assert.rejects(packageSkill({ path: input, output: path.join(parent, "out.zip") }, async (point) => {
    if (point === "checked") { await rename(parent, `${parent}-saved`); await symlink(input, parent); }
  }), /changed/);
  assert.deepEqual(await readdir(`${parent}-saved`), []);
  await assert.rejects(lstat(path.join(input, "out.zip")), { code: "ENOENT" });
});

test("invalid manifest, paths, text, secrets and bounds reject before creating output", { skip: !supported }, async (t) => {
  const cases: Array<[string, (input: string) => Promise<unknown>]> = [
    ["manifest", (input) => writeFile(path.join(input, "skill.json"), "{}")],
    ["secret", (input) => writeFile(path.join(input, "secret.txt"), `ATATT${"a".repeat(30)}`)],
    ["portable path", (input) => writeFile(path.join(input, "CON.txt"), "bad filename")],
    ["text bytes", (input) => writeFile(path.join(input, "large.txt"), "x".repeat(MAX_PACKAGE_TEXT_BYTES))],
    ["invalid UTF-8", (input) => writeFile(path.join(input, "binary.txt"), Buffer.from([0xff]))],
    ["symlink", (input) => symlink(path.join(input, "SKILL.md"), path.join(input, "link.txt"))],
    ["file count", (input) => Promise.all(Array.from({ length: MAX_PACKAGE_FILES }, (_, i) => writeFile(path.join(input, `file-${i}`), "")))],
    ["special file", async (input) => { execFileSync("mkfifo", [path.join(input, "pipe")]); }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async (sub) => {
    const { input, output } = await fixture(sub);
    await mutate(input);
    assert.equal(await runCli(["package", "--path", input, "--output", output, "--json"], runtime()), 1);
    await assert.rejects(lstat(output), { code: "ENOENT" });
  });
});

test("package exposes warnings and blocking findings without including file contents", { skip: !supported }, async (t) => {
  const { root, input, output } = await fixture(t);
  await writeFile(path.join(input, "package.json"), '{"scripts":{"install":"echo review"}}');
  const stdout: string[] = [], stderr: string[] = [];
  assert.equal(await runCli(["package", "--path", input, "--output", output], runtime(stdout, stderr)), 0);
  assert.match(stdout.join("\n"), /warning\s+install-hook/);
  assert.match(stdout.join("\n"), /submit for review:/);
  stdout.length = 0;
  assert.equal(await runCli(["package", "--path", input, "--output", path.join(root, "warning.zip"), "--json"], runtime(stdout, stderr)), 0);
  assert.equal(JSON.parse(stdout[0]!).scan.findings[0].severity, "warning");
  const secret = `ATATT${"a".repeat(30)}`;
  await writeFile(path.join(input, "secret.txt"), secret);
  stdout.length = 0;
  assert.equal(await runCli(["package", "--path", input, "--output", path.join(root, "blocked.zip"), "--json"], runtime(stdout, stderr)), 1);
  assert.deepEqual(stdout, []);
  assert.equal(JSON.parse(stderr[0]!).error.code, "PACKAGE_SCAN_BLOCKED");
  assert.equal(stderr.join("\n").includes(secret), false);
});

test("package validates command options before filesystem access", async () => {
  for (const args of [[], ["source"], ["--path", "source"], ["--path", "source", "--output", "out.zip", "--json=false"], ["--path", "source", "--output", "out.zip", "--force"], ["--path", "a", "--path", "b", "--output", "out.zip"]]) {
    assert.equal(await runCli(["package", ...args], runtime()), 2);
  }
});
