#!/usr/bin/env node

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

// These explicit screenshots show synthetic registry content, not login fields or tokens.
// Raw reports, traces, videos, failure screenshots and attachment bodies stay local.
const reviewedScreenshots = new Set([
  "skill-improvement-mobile.png", "skill-improvement-metadata.png", "libraries-mobile.png",
  "normalized-import-mobile.png", "bundles-grouped-1440.png", "bundles-list-1440.png",
  "bundles-outline-1440.png", "library-bundle-reference.png", "bundles-detail-320.png",
  "bundles-detail-375.png", "bundles-detail-390.png", "bundles-grouped-390.png",
  "bundles-outline-320.png", "improvement-evidence-accepted.png", "bundle-fullstack.png",
  "author-review-feedback.png", "consumer-published-package.png", "maintainer-unpublished-history.png",
  "maintainer-archived-inventory.png", "blocked-upgrade-policy.png", "consumer-revoked-package.png",
  "persistent-library-mobile.png",
  "branding-desktop.png", "branding-mobile.png",
]);

const [reportPath, resultsPath, outputPath] = process.argv.slice(2);
if (!reportPath || !resultsPath || !outputPath) {
  console.error("Usage: collect-browser-evidence.mjs REPORT RESULTS_DIRECTORY OUTPUT_DIRECTORY");
  process.exit(1);
}
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const summary = { schemaVersion: 1, reportStatus: "unavailable", tests: [], screenshots: [] };
let report;
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!Array.isArray(report.suites)) throw new Error("Missing suites.");
} catch {
  await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.error("Browser report is missing or invalid; evidence is incomplete.");
  process.exit(1);
}
summary.reportStatus = "available";
summary.globalErrorCount = report.errors?.length ?? 0;
collectSuites(report.suites);
await collectScreenshots(resolve(resultsPath));
summary.screenshots.sort();
await writeFile(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`Retained ${summary.tests.length} browser results and ${summary.screenshots.length} reviewed screenshots.`);

function collectSuites(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        summary.tests.push({
          title: spec.title, file: spec.file, line: spec.line, column: spec.column,
          project: test.projectName, expectedStatus: test.expectedStatus, outcome: test.status,
          attempts: (test.results ?? []).map(result => ({ status: result.status, retry: result.retry, durationMs: result.duration })),
        });
      }
    }
    collectSuites(suite.suites ?? []);
  }
}

async function collectScreenshots(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) await collectScreenshots(source);
    if (!entry.isFile() || !reviewedScreenshots.has(entry.name)) continue;
    const destination = join("screenshots", relative(resolve(resultsPath), source));
    await mkdir(dirname(join(output, destination)), { recursive: true });
    await copyFile(source, join(output, destination));
    summary.screenshots.push(destination.split("\\").join("/"));
  }
}
