#!/usr/bin/env node
import { createSelfHostBundle, parseOptions } from "./lib/self-host-release.mjs";

try {
  const options = parseOptions(process.argv.slice(2), ["--input", "--out"]);
  if (options.help) console.log("Usage: node scripts/create-self-host-bundle.mjs --input <image-evidence.json> --out <absent-directory>\nValidates supplied receipts; does not build, run or publish images.");
  else {
    if (!options.input || !options.out) throw new Error("--input and --out are required.");
    console.log(JSON.stringify(createSelfHostBundle({ root: process.cwd(), inputFile: options.input, outputDir: options.out }), null, 2));
  }
} catch (error) {
  console.error(`Self-host release: ${error.code ? "Filesystem operation failed." : error.message}`);
  process.exitCode = 1;
}
