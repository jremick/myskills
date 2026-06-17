#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = repoRoot();
const disallowed = [
  wordPattern([0x61, 0x78, 0x6f, 0x6e]),
  wordPattern([0x6a, 0x6f, 0x6e, 0x61, 0x73]),
  wordPattern([0x63, 0x6f, 0x6e, 0x66, 0x6c, 0x75, 0x65, 0x6e, 0x63, 0x65]),
  wordPattern([0x61, 0x74, 0x6c, 0x61, 0x73, 0x73, 0x69, 0x61, 0x6e]),
  wordPattern([0x63, 0x72, 0x6f, 0x73, 0x73, 0x2d, 0x62, 0x75, 0x2d, 0x73, 0x6b, 0x69, 0x6c, 0x6c, 0x73]),
  wordPattern([0x73, 0x6b, 0x69, 0x6c, 0x6c, 0x73, 0x2e, 0x6a, 0x6f, 0x6e, 0x61, 0x73, 0x61, 0x6e, 0x7a, 0x2e, 0x61, 0x69]),
  wordPattern([0x6a, 0x6f, 0x6e, 0x61, 0x73, 0x61, 0x6e, 0x7a]),
  wordPattern([0x6a, 0x6f, 0x6e, 0x61, 0x73, 0x61, 0x78, 0x6f, 0x6e, 0x67, 0x72, 0x6f, 0x75, 0x70]),
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
  if (isBinaryLike(file)) {
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

function wordPattern(codes) {
  return new RegExp(`\\b${escapeRegExp(String.fromCharCode(...codes))}\\b`, "i");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
