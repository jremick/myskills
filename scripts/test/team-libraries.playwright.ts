import { defineConfig, devices } from "@playwright/test";

// Dedicated database journey; intentionally outside the deployed-compose suite.
// Build with VITE_API_BASE_URL=/api, then supply a disposable TEST_DATABASE_URL.
// The fixture resets this database. Run after the API, CLI and web builds.
export default defineConfig({
  testDir: "../../apps/web/test/e2e/fullstack",
  testMatch: "team-library-sources.pg-e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: "../../test-results/team-libraries",
  reporter: [["line"], ["json", { outputFile: "../../test-results/team-libraries-report.json" }]],
  use: {
    ...devices["Desktop Chrome"],
    ...(process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE } } : {}),
    actionTimeout: 15_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
