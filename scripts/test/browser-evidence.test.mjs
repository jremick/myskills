import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Failure cases: leaking raw errors/stdio/config/attachment bodies, dropping failed
// attempts, copying unreviewed files or symlinks, and silently accepting a missing report.
test("browser evidence retains retry outcomes and reviewed screenshots without raw authentication material", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myskills-browser-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const results = join(root, "results");
  const output = join(root, "output");
  await mkdir(join(results, "journey"), { recursive: true });
  const marker = "synthetic-credential-must-not-be-published";
  const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=", "base64");
  await writeFile(join(results, "journey", "bundle-fullstack.png"), screenshot);
  await writeFile(join(results, "journey", "2026-10-01-utc-local-home-viewport.png"), screenshot);
  await writeFile(join(results, "journey", "test-failed-1.png"), marker);
  await writeFile(join(results, "journey", "trace.zip"), marker);
  await writeFile(join(root, "outside.png"), marker);
  await symlink(join(root, "outside.png"), join(results, "journey", "author-review-feedback.png"));
  const report = join(root, "report.json");
  await writeFile(report, JSON.stringify({
    config: { metadata: { credential: marker } }, errors: [{ message: marker }],
    suites: [{ title: "fullstack", suites: [{ title: "nested", specs: [{
      title: "bundle journey", file: "fullstack/bundles.spec.ts", line: 4, column: 1,
      tests: [{ projectName: "chromium", expectedStatus: "passed", status: "flaky", results: [
        { status: "failed", retry: 0, duration: 10, error: { message: marker }, stdout: [marker], stderr: [marker], attachments: [{ name: "session", body: marker }] },
        { status: "passed", retry: 1, duration: 20 },
      ] }],
    }] }] }],
  }));
  const result = runCollector(report, results, output);
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(join(output, "summary.json"), "utf8");
  assert.equal(text.includes(marker), false);
  const summary = JSON.parse(text);
  assert.equal(summary.globalErrorCount, 1);
  assert.deepEqual(summary.tests, [{
    title: "bundle journey", file: "fullstack/bundles.spec.ts", line: 4, column: 1,
    project: "chromium", expectedStatus: "passed", outcome: "flaky",
    attempts: [{ status: "failed", retry: 0, durationMs: 10 }, { status: "passed", retry: 1, durationMs: 20 }],
  }]);
  assert.deepEqual(summary.screenshots, ["screenshots/journey/2026-10-01-utc-local-home-viewport.png", "screenshots/journey/bundle-fullstack.png"]);
  assert.deepEqual(await readFile(join(output, summary.screenshots[0])), screenshot);
  assert.deepEqual(await readdir(join(output, "screenshots", "journey")), ["2026-10-01-utc-local-home-viewport.png", "bundle-fullstack.png"]);
});

test("missing browser report produces an explicit failure summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "myskills-browser-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = runCollector(join(root, "missing.json"), join(root, "results"), join(root, "output"));
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(await readFile(join(root, "output", "summary.json"), "utf8")), { schemaVersion: 1, reportStatus: "unavailable", tests: [], screenshots: [] });
});

function runCollector(report, results, output) {
  return spawnSync(process.execPath, [resolve("scripts/collect-browser-evidence.mjs"), report, results, output], { encoding: "utf8" });
}
