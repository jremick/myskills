#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { secretPatterns as patterns } from "./lib/secret-patterns.mjs";

const root = repoRoot();

const findings = [];
for (const file of scanCandidates()) {
  scanFile(file);
}

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.name}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");

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
  if (isBinaryLike(file)) {
    return;
  }

  const path = join(root, file);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP") return;
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return;
    const text = readFileSync(descriptor, "utf8");
    for (const { name, pattern } of patterns) {
      if (pattern.test(text)) {
        findings.push({ file, name });
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

function isBinaryLike(name) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?)$/i.test(name);
}
