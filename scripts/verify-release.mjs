#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is required and must point to a disposable database whose name includes test or ci.");
  process.exit(1);
}

run(["run", "check"]);
run(["run", "test:e2e", "-w", "@myskills-app/web"]);
run(["run", "test:e2e:fullstack"]);
run(["run", "test:postgres"]);

const artifactArgs = ["run", "release:artifacts", "--"];
mkdirSync(resolve("dist"), { recursive: true });
const releaseOutputRoot = mkdtempSync(resolve("dist", "release-verify-"));
const releaseOutput = join(releaseOutputRoot, "artifacts");
artifactArgs.push("--out", relative(process.cwd(), releaseOutput));
if (process.env.RELEASE_REQUIRE_TAG === "true") artifactArgs.push("--require-tag");
if (process.env.RELEASE_EXPECTED_TAG) artifactArgs.push("--expected-tag", process.env.RELEASE_EXPECTED_TAG);
run(artifactArgs);

// Exact source/archive/lockfile verification stays unsigned until a signing
// authority and publication target are explicitly selected.
const provenance = spawnSync(process.execPath, [
  "scripts/create-trust-provenance.mjs", "--release", relative(process.cwd(), releaseOutput),
  "--out", relative(process.cwd(), join(releaseOutputRoot, "provenance")),
], { stdio: "inherit" });
if (provenance.status !== 0) process.exit(provenance.status ?? 1);

console.log(`Canonical release verification passed. Artifacts: ${releaseOutput}`);

function run(args) {
  console.log(`> npm ${args.join(" ")}`);
  const result = spawnSync(npm, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
