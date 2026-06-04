#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseName = `${packageJson.name}-${version}`;
const outputDir = resolve(root, args.outputDir);

assertGitWorktree();
const dirtyEntries = git(["status", "--porcelain", "--untracked-files=all"]).trim();
if (dirtyEntries && !args.allowDirty) {
  fail("Release artifacts require a clean git worktree. Commit or stash changes before release.");
}

const commitSha = git(["rev-parse", "HEAD"]).trim();
const commitTime = git(["show", "-s", "--format=%cI", "HEAD"]).trim();
const tags = git(["tag", "--points-at", "HEAD"])
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter(Boolean)
  .sort();
const packageTag = `v${version}`;
const expectedTag = args.expectedTag ?? packageTag;

if (expectedTag !== packageTag) {
  fail(`Release tag ${expectedTag} does not match package version ${version}. Expected ${packageTag}.`);
}

if (args.requireTag && !tags.includes(expectedTag)) {
  fail(`Release tag ${expectedTag} must point at HEAD.`);
}

prepareOutputDir(outputDir);

const sourceArchive = `${releaseName}-source.tar`;
const sourceArchivePath = resolve(outputDir, sourceArchive);
git([
  "archive",
  "--format=tar",
  `--prefix=${releaseName}/`,
  "-o",
  sourceArchivePath,
  "HEAD",
]);

const sourceArtifact = artifactRecord(sourceArchivePath);
const metadataPath = resolve(outputDir, "release-metadata.json");
const metadata = {
  name: packageJson.name,
  version,
  expectedTag,
  tags,
  commitSha,
  commitTime,
  dirty: Boolean(dirtyEntries),
  packageManager: packageJson.packageManager,
  nodeEngine: packageJson.engines?.node,
  artifacts: [sourceArtifact],
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

const artifactRecords = [
  sourceArtifact,
  artifactRecord(metadataPath),
];
writeFileSync(resolve(outputDir, "SHA256SUMS"), sha256Sums(artifactRecords));

console.log(`Release artifacts written to ${outputDir}`);
for (const artifact of artifactRecords) {
  console.log(`${artifact.sha256}  ${artifact.file}`);
}

function parseArgs(input) {
  const parsed = {
    outputDir: "dist/release",
    allowDirty: false,
    requireTag: false,
    expectedTag: null,
  };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg === "--out") {
      const value = input[index + 1];
      if (!value) {
        fail("--out requires a directory.");
      }
      parsed.outputDir = value;
      index += 1;
      continue;
    }
    if (arg === "--allow-dirty") {
      parsed.allowDirty = true;
      continue;
    }
    if (arg === "--require-tag") {
      parsed.requireTag = true;
      continue;
    }
    if (arg === "--expected-tag") {
      const value = input[index + 1];
      if (!value) {
        fail("--expected-tag requires a tag name.");
      }
      parsed.expectedTag = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/create-release-artifacts.mjs [--out dist/release] [--require-tag] [--expected-tag v0.1.0] [--allow-dirty]");
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function assertGitWorktree() {
  const value = git(["rev-parse", "--is-inside-work-tree"]).trim();
  if (value !== "true") {
    fail("Release artifacts must be created from a git worktree.");
  }
}

function prepareOutputDir(dir) {
  const releaseRoot = resolve(root, "dist");
  const relativeDir = relative(releaseRoot, dir);
  if (
    !relativeDir ||
    relativeDir.startsWith("..") ||
    isAbsolute(relativeDir) ||
    relativeDir.split(/[\\/]+/).some((part) => part.startsWith("."))
  ) {
    fail(`Release output directory must be a non-hidden subdirectory of ${releaseRoot}.`);
  }
  if (existsSync(dir) && !lstatSync(dir).isDirectory()) {
    fail(`Release output path exists and is not a directory: ${dir}`);
  }
  const trackedEntries = git(["ls-files", "--", relative(root, dir)]).trim();
  if (trackedEntries) {
    fail(`Release output directory contains tracked files and cannot be cleaned: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function artifactRecord(path) {
  return {
    file: basename(path),
    byteSize: statSync(path).size,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  };
}

function sha256Sums(artifacts) {
  return artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.file}`)
    .join("\n") + "\n";
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
