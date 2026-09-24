import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPackageSnapshot } from "@myskills-app/skill-package";
import { runCli, type CliRuntime } from "../src/cli.js";

const supportsLocalAuthoring = process.platform === "darwin" || process.platform === "linux";

test("init creates a valid private Codex package and leaves validation local", { skip: !supportsLocalAuthoring }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "myskills-init-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outputPath = path.join(parent, "quoted-skill's-$()-`tick`");
  const stdout: string[] = [];
  const stderr: string[] = [];
  let networkCalls = 0;
  const runtime = testRuntime(stdout, stderr, () => { networkCalls += 1; });
  const title = "Quoted \"skill\"\nTitle";
  const summary = "Use a colon: and a newline\nwithout changing the frontmatter mapping.";

  const code = await runCli([
    "init", "quoted-skill", "--output", outputPath, "--title", title, "--summary", summary, "--json",
  ], runtime);

  assert.equal(code, 0);
  assert.equal(networkCalls, 0);
  const result = JSON.parse(stdout[0] ?? "{}");
  assert.equal(result.output, await realpath(outputPath));
  assert.equal(result.manifest.name, "quoted-skill");
  assert.equal(result.manifest.title, title);
  assert.equal(result.manifest.summary, summary);
  assert.equal(result.manifest.version, "0.1.0");
  assert.equal(result.manifest.license, "UNLICENSED");
  assert.equal(result.manifest.visibility, "private");
  assert.deepEqual(result.manifest.platforms, [{ name: "codex", install_target: "codex-skill", status: "supported" }]);
  assert.equal(result.next.validate, `myskills validate --path ${posixQuote(result.output)}`);
  assert.equal(result.next.submit, `myskills submit --path ${posixQuote(result.output)}`);

  const snapshot = await readPackageSnapshot(outputPath);
  assert.deepEqual(snapshot.manifest, result.manifest);
  const skillDocument = snapshot.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  assert.match(skillDocument, /name: "quoted-skill"/);
  assert.match(skillDocument, /description: "Use a colon: and a newline\\nwithout changing the frontmatter mapping\."/);

  stdout.length = 0;
  assert.equal(await runCli(["validate", outputPath], runtime), 0);
  assert.deepEqual(stdout, ["valid quoted-skill@0.1.0"]);
  stdout.length = 0;
  assert.equal(await runCli(["scan", outputPath], runtime), 0);
  assert.match(stdout[0] ?? "", /^clean files=2 bytes=\d+$/);

  const plainPath = path.join(parent, "plain-skill");
  stdout.length = 0;
  assert.equal(await runCli(["init", "plain-skill", "--output", plainPath, "--json"], runtime), 0);
  const plain = JSON.parse(stdout[0] ?? "{}");
  assert.equal(plain.manifest.title, "plain-skill");
  assert.equal(plain.manifest.summary, "Describe what this skill does.");
  assert.equal(plain.manifest.license, "UNLICENSED");
  assert.equal((await readPackageSnapshot(plainPath)).files.length, 2);
});

test("init refuses existing directories, files, and symlinks without changing them", { skip: !supportsLocalAuthoring }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "myskills-init-existing-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runtime = testRuntime([], [], () => assert.fail("init must not use the network"));

  const existingDirectory = path.join(parent, "existing-directory");
  await mkdir(existingDirectory);
  await writeFile(path.join(existingDirectory, "keep.txt"), "keep");
  assert.equal(await runCli(["init", "existing-directory", "--output", existingDirectory], runtime), 1);
  assert.equal(await readFile(path.join(existingDirectory, "keep.txt"), "utf8"), "keep");

  const emptyDirectory = path.join(parent, "empty-directory");
  await mkdir(emptyDirectory);
  assert.equal(await runCli(["init", "empty-directory", "--output", emptyDirectory], runtime), 1);
  assert.deepEqual(await readdir(emptyDirectory), []);

  const existingFile = path.join(parent, "existing-file");
  await writeFile(existingFile, "keep");
  assert.equal(await runCli(["init", "existing-file", "--output", existingFile], runtime), 1);
  assert.equal(await readFile(existingFile, "utf8"), "keep");

  const linkTarget = path.join(parent, "link-target");
  const link = path.join(parent, "existing-link");
  await mkdir(linkTarget);
  await writeFile(path.join(linkTarget, "keep.txt"), "keep");
  await symlink(linkTarget, link);
  assert.equal(await runCli(["init", "existing-link", "--output", link], runtime), 1);
  assert.equal(await readFile(path.join(linkTarget, "keep.txt"), "utf8"), "keep");
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test("init rejects invalid names and malformed options before touching the filesystem", { skip: !supportsLocalAuthoring }, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "myskills-init-invalid-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runtime = testRuntime([], [], () => assert.fail("init must not use the network"));

  assert.equal(await runCli(["init", "--output", path.join(parent, "missing")], runtime), 2);
  assert.equal(await runCli(["init", "Bad_Name", "--output", path.join(parent, "invalid")], runtime), 2);
  assert.equal(await runCli(["init", "valid-name", "--output", path.join(parent, "unknown"), "--unknown", "value"], runtime), 2);
  assert.equal(await runCli(["init", "valid-name", "--output", path.join(parent, "duplicate"), "--title", "one", "--title", "two"], runtime), 2);
  await assert.rejects(realpath(path.join(parent, "invalid")));
  await assert.rejects(realpath(path.join(parent, "unknown")));
  await assert.rejects(realpath(path.join(parent, "duplicate")));
});

function testRuntime(stdout: string[], stderr: string[], onFetch: () => void): CliRuntime {
  return {
    env: {},
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    fetch: async () => {
      onFetch();
      throw new Error("unexpected network request");
    },
  };
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
