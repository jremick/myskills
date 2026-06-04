#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".private",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
]);
const ignoredFiles = new Set(["package-lock.json"]);
const patterns = [
  { name: "Vendor API token", pattern: /\bATATT[0-9A-Za-z_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z_]{30,}\b/ },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { name: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

const findings = [];
walk(root);

if (findings.length > 0) {
  console.error("Secret scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.name}`);
  }
  process.exit(1);
}

console.log("Secret scan passed.");

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const rel = relative(root, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!ignoredDirectories.has(entry)) {
        walk(path);
      }
      continue;
    }
    if (!stat.isFile() || ignoredFiles.has(rel) || isBinaryLike(entry)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    for (const { name, pattern } of patterns) {
      if (pattern.test(text)) {
        findings.push({ file: rel, name });
      }
    }
  }
}

function isBinaryLike(name) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?)$/i.test(name);
}
