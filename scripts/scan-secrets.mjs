#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = repoRoot();
const patterns = [
  { name: "Vendor API token", pattern: /\bATATT[0-9A-Za-z_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{30,}\b/ },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

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
  if (!existsSync(path)) {
    return;
  }

  const stat = statSync(path);
  if (!stat.isFile()) {
    return;
  }

  const text = readFileSync(path, "utf8");
  for (const { name, pattern } of patterns) {
    if (pattern.test(text)) {
      findings.push({ file, name });
    }
  }
}

function isBinaryLike(name) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?)$/i.test(name);
}
