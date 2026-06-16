#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = repoRoot();
const ignoredFiles = new Set([
  "scripts/check-privacy.mjs",
  "package-lock.json",
]);
const disallowed = [
  /\baxon\b/i,
  /\bjonas\b/i,
  /\bconfluence\b/i,
  /\batlassian\b/i,
  /\bcross-bu-skills\b/i,
  /\bskills\.jonasanz\.ai\b/i,
  /\bjonasanz\b/i,
  /\bjonasaxongroup\b/i,
];

const findings = [];

for (const file of scanCandidates()) {
  scanFile(file);
}

if (findings.length > 0) {
  console.error("Privacy check failed. Remove private-source carryover terms:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.pattern}`);
  }
  process.exit(1);
}

console.log("Privacy check passed.");

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function scanCandidates() {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  );

  return output.split("\0").filter(Boolean).sort();
}

function scanFile(file) {
  if (ignoredFiles.has(file) || isBinaryLike(file)) {
    return;
  }

  const path = join(root, file);
  if (!existsSync(path)) {
    return;
  }

  const stat = statSync(path);
  if (!stat.isFile()) {
    return;
  }

  const text = readFileSync(path, "utf8");
  for (const pattern of disallowed) {
    if (pattern.test(text)) {
      findings.push({ file, pattern: pattern.toString() });
    }
  }
}

function isBinaryLike(name) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?)$/i.test(name);
}
