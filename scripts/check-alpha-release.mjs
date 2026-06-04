#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  hasBlockingFindings,
  parseSkillManifest,
  scanTextForPackageRisks,
} from "../packages/skill-package/dist/index.js";

const root = process.cwd();

const requiredPaths = [
  "LICENSE",
  "SECURITY.md",
  "docs/ALPHA_RELEASE_GOAL.md",
  "docs/BUSINESS_SAFE_RELEASE_GOAL.md",
  "docs/RELEASE.md",
  "docs/THREAT_MODEL.md",
  "examples/skills/release-notes-helper/skill.json",
  "examples/skills/release-notes-helper/README.md",
  "examples/skills/release-notes-helper/SKILL.md",
];

const policyFiles = [
  "README.md",
  "SECURITY.md",
  "docs/ALPHA_RELEASE_GOAL.md",
  "docs/BUSINESS_SAFE_RELEASE_GOAL.md",
  "docs/RELEASE.md",
  "docs/ROADMAP.md",
  "docs/THREAT_MODEL.md",
];

const forbiddenPolicyPhrases = [
  /not public yet/i,
  /private while the core architecture/i,
  /will be finalized before public release/i,
  /repo is not ready for a public release/i,
];

const forbiddenExamplePhrases = [
  [0x61, 0x78, 0x6f, 0x6e],
  [0x6a, 0x6f, 0x6e, 0x61, 0x73],
  [0x63, 0x6f, 0x6e, 0x66, 0x6c, 0x75, 0x65, 0x6e, 0x63, 0x65],
].map((codes) => new RegExp(`\\b${String.fromCharCode(...codes)}\\b`, "i"));

const failures = [];

for (const path of requiredPaths) {
  assertFile(path);
}

for (const path of policyFiles) {
  const text = readFileSync(resolve(root, path), "utf8");
  for (const phrase of forbiddenPolicyPhrases) {
    if (phrase.test(text)) {
      failures.push(`${path} contains pre-public release language matching ${phrase}.`);
    }
  }
}

const exampleRoot = resolve(root, "examples/skills");
const exampleDirs = readdirSync(exampleRoot)
  .map((name) => resolve(exampleRoot, name))
  .filter((path) => statSync(path).isDirectory());

if (exampleDirs.length === 0) {
  failures.push("No public example skill packages found under examples/skills.");
}

for (const dir of exampleDirs) {
  validateExampleSkill(dir);
}

if (failures.length > 0) {
  console.error("Alpha release check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Alpha release check passed.");

function assertFile(path) {
  const absolute = resolve(root, path);
  try {
    if (!statSync(absolute).isFile()) {
      failures.push(`${path} is not a file.`);
    }
  } catch {
    failures.push(`${path} is missing.`);
  }
}

function validateExampleSkill(dir) {
  const manifestPath = join(dir, "skill.json");
  let manifest;
  try {
    manifest = parseSkillManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    failures.push(`${relative(root, manifestPath)} has an invalid manifest: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (manifest.visibility !== "public") {
    failures.push(`${relative(root, manifestPath)} must be public.`);
  }

  for (const file of listFiles(dir)) {
    const text = readFileSync(file, "utf8");
    const relativePath = relative(root, file);
    for (const phrase of forbiddenExamplePhrases) {
      if (phrase.test(text)) {
        failures.push(`${relativePath} contains private-source carryover matching ${phrase}.`);
      }
    }
    const findings = scanTextForPackageRisks(text);
    if (hasBlockingFindings(findings)) {
      failures.push(`${relativePath} contains blocking package scan findings.`);
    }
  }
}

function listFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}
