import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.MYSKILLS_SITE_TEST_PORT ?? 4188);
const executablePath = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `node scripts/build.mjs && node scripts/serve.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
