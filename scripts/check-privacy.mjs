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

walk(root);

if (findings.length > 0) {
  console.error("Privacy check failed. Remove private-source carryover terms:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.pattern}`);
  }
  process.exit(1);
}

console.log("Privacy check passed.");

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
    for (const pattern of disallowed) {
      if (pattern.test(text)) {
        findings.push({ file: rel, pattern: pattern.toString() });
      }
    }
  }
}

function isBinaryLike(name) {
  return /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?)$/i.test(name);
}
