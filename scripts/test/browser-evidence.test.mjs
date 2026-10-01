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

test("direct GitHub fullstack caller exports all four sanitized reports and requires each new phase", async t => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const browserJob = workflow.split("  web-e2e-supported-node:\n")[1].split("\n  # Preserve the protected-branch context")[0];
  const steps = browserJob.split("      - name: ").slice(1);
  const collectors = steps.filter(step => step.includes("run: node scripts/collect-browser-evidence.mjs apps/web/test-results/fullstack"));
  const phases = ["fullstack", "fullstack-operational", "fullstack-improvement", "fullstack-connector"];
  assert.equal(collectors.length, 4);
  for (const [index, phase] of phases.entries()) {
    const step = collectors[index];
    assert.match(step, /if: always\(\) && steps\.fullstack-browser\.outcome != 'skipped'/);
    assert.equal(step.includes("continue-on-error"), false);
    assert.ok(step.includes(`run: node scripts/collect-browser-evidence.mjs apps/web/test-results/${phase}-report.json apps/web/test-results dist/browser-evidence/${phase}\n`));
    assert.ok(browserJob.indexOf(step) < browserJob.indexOf("Build product and documentation site"));
  }
  assert.match(steps.find(step => step.startsWith("Upload reviewed browser evidence")), /if: always\(\)[\s\S]*path: dist\/browser-evidence\/[\s\S]*if-no-files-found: error/);
  assert.match(steps.find(step => step.startsWith("Collect reviewed product-site evidence")), /if: always\(\) && steps\.product-site-browser\.outcome != 'skipped'/);

  // Execute the checked workflow commands against synthetic reports. Registry
  // evidence must not conceal either absent isolated-phase report.
  for (const omitted of [null, "fullstack-operational", "fullstack-improvement"]) {
    const root = await mkdtemp(join(tmpdir(), "myskills-github-browser-evidence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const results = join(root, "apps/web/test-results"); await mkdir(results, { recursive: true });
    for (const phase of phases) {
      if (phase === omitted) continue;
      await writeFile(join(results, `${phase}-report.json`), JSON.stringify({ suites: [{ specs: [{ title: phase, file: `${phase}.spec.ts`, tests: [{ status: "expected", results: [{ status: "passed", stderr: ["private-auth-marker"] }] }] }] }] }));
    }
    for (const [index, step] of collectors.entries()) {
      const args = step.match(/run: node (.+)\n/)[1].split(" ");
      const result = spawnSync(process.execPath, [resolve(args[0]), ...args.slice(1).map(path => join(root, path))], { encoding: "utf8", timeout: 5_000 });
      const phase = phases[index];
      assert.equal(result.status, phase === omitted ? 1 : 0, result.stderr);
      const text = await readFile(join(root, `dist/browser-evidence/${phase}/summary.json`), "utf8");
      assert.equal(text.includes("private-auth-marker"), false);
      const summary = JSON.parse(text);
      assert.equal(summary.reportStatus, phase === omitted ? "unavailable" : "available");
      assert.deepEqual(summary.tests.map(test => test.title), phase === omitted ? [] : [phase]);
    }
  }
});
