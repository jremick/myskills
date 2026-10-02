// Full-stack Playwright phases. Each phase gets its own fresh disposable
// stack, so the unchanged production login limiter never spans journey groups
// that share the host's single client address.

const CONNECTOR_TITLE = "remote MCP connector";
const CONNECTOR_SPEC = "mcp-oauth-connector.spec.ts";

export function fullstackPhases(forwardedArgs) {
  if (forwardedArgs.some((arg) => arg === "-c" || arg === "--config" || arg.startsWith("--config="))) {
    throw new Error("The full-stack harness owns the Playwright configuration; pass test filters only.");
  }
  if (forwardedArgs.length > 0) {
    return [{ name: "selected", playwrightArgs: [...forwardedArgs] }];
  }
  return [
    // Existing report and results paths stay unchanged for CI evidence collection.
    { name: "registry-journeys", playwrightArgs: ["--grep-invert", `${CONNECTOR_TITLE}|author feedback, immutable publication|registry plan, local CLI evaluation`] },
    // These longer lifecycles must not inherit the registry group's request
    // budget, and their reports/screenshots must survive later fresh phases.
    { name: "operational-journey", playwrightArgs: ["fullstack/operational-journey.spec.ts"], outputDir: "test-results/fullstack-operational", jsonReport: "test-results/fullstack-operational-report.json" },
    { name: "skill-improvement", playwrightArgs: ["fullstack/skill-improvement.spec.ts"], outputDir: "test-results/fullstack-improvement", jsonReport: "test-results/fullstack-improvement-report.json" },
    // Separate artifacts (relative to apps/web), so the second run cannot
    // clean or overwrite the first.
    {
      name: "remote-mcp-connector",
      playwrightArgs: [CONNECTOR_SPEC],
      outputDir: "test-results/fullstack-connector",
      jsonReport: "test-results/fullstack-connector-report.json",
    },
  ];
}
