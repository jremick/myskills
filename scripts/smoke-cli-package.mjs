#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = process.cwd();
const cliRoot = resolve(root, "apps/cli");
const exampleRoot = resolve(root, "examples/skills/release-notes-helper");
const temporaryRoot = await mkdtemp(join(tmpdir(), "myskills-cli-pack-"));
const packRoot = join(temporaryRoot, "pack");
const installRoot = join(temporaryRoot, "install");
const copiedExample = join(installRoot, "release-notes-helper");
const expectedFiles = ["LICENSE", "README.md", "dist/index.js", "package.json"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const cliPackage = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
  const bundle = await readFile(join(cliRoot, "dist/index.js"), "utf8");
  if (bundle.includes("@myskills-app/skill-package")) {
    fail("CLI bundle still contains a runtime import of the private skill-package workspace.");
  }

  await mkdir(packRoot, { recursive: true });

  const packResult = run(npm, ["pack", "--workspace", "@jarel/myskills", "--json", "--pack-destination", packRoot], { capture: true });
  const packed = parsePackResult(packResult.stdout);
  const actualFiles = packed.files.map((file) => file.path).sort();
  assertSameFiles(actualFiles, expectedFiles);

  const tarball = join(packRoot, packed.filename);
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "package.json"), "{\n  \"private\": true\n}\n", { encoding: "utf8", flag: "wx" });
  await cp(exampleRoot, copiedExample, { recursive: true, errorOnExist: true });

  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: installRoot });
  const installedLicense = await readFile(join(installRoot, "node_modules", "@jarel", "myskills", "LICENSE"), "utf8");
  if (installedLicense !== await readFile(join(root, "LICENSE"), "utf8")) {
    fail("Freshly installed CLI does not include the current project license.");
  }
  const executable = join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "myskills.cmd" : "myskills");
  const version = run(executable, ["--version"], { capture: true }).stdout.trim();
  if (version !== cliPackage.version) {
    fail(`Packed CLI reported ${JSON.stringify(version)}; expected ${JSON.stringify(cliPackage.version)}.`);
  }

  run(executable, ["validate", "--path", copiedExample], { cwd: installRoot });
  run(executable, ["scan", "--path", copiedExample], { cwd: installRoot });

  const authored = join(installRoot, "authored-skill");
  run(executable, ["init", "authored-skill", "--output", authored], { cwd: installRoot });
  const archives = [join(installRoot, "first.zip"), join(installRoot, "second.zip")];
  const outputs = [];
  for (const archive of archives) {
    const metadata = JSON.parse(run(executable, ["package", "--path", authored, "--output", archive, "--json"], { cwd: installRoot, capture: true }).stdout);
    const bytes = await readFile(archive);
    if (metadata.sha256 !== createHash("sha256").update(bytes).digest("hex") || metadata.size !== bytes.length) {
      fail("Packed CLI archive metadata does not match the written bytes.");
    }
    outputs.push(bytes);
  }
  if (!outputs[0].equals(outputs[1])) fail("Packed CLI did not produce reproducible archives.");
  run(executable, ["validate", "--path", archives[0]], { cwd: installRoot });
  run(executable, ["scan", "--path", archives[0]], { cwd: installRoot });

  console.log(`CLI package smoke passed for ${basename(tarball)}.`);
  console.log(`Tarball files: ${actualFiles.join(", ")}`);
  console.log(`Clean temporary install, validate/scan, and init/package roundtrip passed for ${cliPackage.version}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parsePackResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    fail("npm pack did not return valid JSON metadata.");
  }
  if (!Array.isArray(value) || value.length !== 1 || !value[0]?.filename || !Array.isArray(value[0]?.files)) {
    fail("npm pack returned an unexpected result shape.");
  }
  return value[0];
}

function assertSameFiles(actual, expected) {
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`CLI tarball files differ from the allowlist. Expected ${wanted.join(", ")}; received ${actual.join(", ")}.`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr);
    fail(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result;
}

function fail(message) {
  throw new Error(message);
}
