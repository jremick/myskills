import assert from "node:assert/strict";
import test from "node:test";
import { fullstackPhases } from "../lib/fullstack-phases.mjs";

// Each phase runs on its own fresh disposable stack, so production auth rate
// limits (unchanged) never carry over between journey groups.

test("default full-stack run isolates operational, improvement and connector budgets without losing any journey", () => {
  assert.deepEqual(fullstackPhases([]), [
    // Existing report and results paths stay unchanged for CI evidence collection.
    { name: "registry-journeys", playwrightArgs: ["--grep-invert", "remote MCP connector|author feedback, immutable publication|registry plan, local CLI evaluation"] },
    { name: "operational-journey", playwrightArgs: ["fullstack/operational-journey.spec.ts"], outputDir: "test-results/fullstack-operational", jsonReport: "test-results/fullstack-operational-report.json" },
    { name: "skill-improvement", playwrightArgs: ["fullstack/skill-improvement.spec.ts"], outputDir: "test-results/fullstack-improvement", jsonReport: "test-results/fullstack-improvement-report.json" },
    // Separate artifacts (relative to apps/web), so the second run cannot clean
    // or overwrite the first.
    {
      name: "remote-mcp-connector",
      playwrightArgs: ["mcp-oauth-connector.spec.ts"],
      outputDir: "test-results/fullstack-connector",
      jsonReport: "test-results/fullstack-connector-report.json",
    },
  ]);
});

test("explicit Playwright filters run once on one fresh stack", () => {
  assert.deepEqual(fullstackPhases(["mcp-oauth-connector.spec.ts"]), [
    { name: "selected", playwrightArgs: ["mcp-oauth-connector.spec.ts"] },
  ]);
  assert.deepEqual(fullstackPhases(["--grep", "bundle", "--retries", "0"]), [
    { name: "selected", playwrightArgs: ["--grep", "bundle", "--retries", "0"] },
  ]);
});

test("forwarded arguments cannot replace the harness Playwright configuration", () => {
  for (const args of [["--config", "other.ts"], ["-c", "other.ts"], ["--config=other.ts"]]) {
    assert.throws(() => fullstackPhases(args), /configuration/, args.join(" "));
  }
});
