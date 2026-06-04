#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const cwd = process.cwd();
const config = parseArgs(process.argv.slice(2));
const testFiles = collectTests(join(cwd, "test"), config.extensions)
  .map((path) => relative(cwd, path))
  .sort();

if (testFiles.length === 0) {
  console.log("No test files found.");
  process.exit(0);
}

const nodeArgs = [];
for (const specifier of config.imports) {
  nodeArgs.push("--import", specifier);
}
nodeArgs.push("--test");
if (config.testConcurrency !== null) {
  nodeArgs.push(`--test-concurrency=${config.testConcurrency}`);
}
nodeArgs.push(...testFiles);

const result = spawnSync(process.execPath, nodeArgs, {
  cwd,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function parseArgs(args) {
  const config = {
    extensions: [".test.ts"],
    imports: [],
    testConcurrency: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--import") {
      config.imports.push(readValue(args, index));
      index += 1;
      continue;
    }
    if (arg === "--extensions") {
      config.extensions = readValue(args, index).split(",").map(normalizeExtension);
      index += 1;
      continue;
    }
    if (arg === "--test-concurrency") {
      config.testConcurrency = readValue(args, index);
      index += 1;
      continue;
    }
    if (arg.startsWith("--test-concurrency=")) {
      config.testConcurrency = arg.slice("--test-concurrency=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return config;
}

function readValue(args, index) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${args[index]} requires a value.`);
  }
  return value;
}

function normalizeExtension(extension) {
  return extension.startsWith(".") ? extension : `.${extension}`;
}

function collectTests(directory, extensions) {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(path, extensions));
      continue;
    }
    if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}
