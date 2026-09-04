import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.MYSKILLS_E2E_BASE_URL ?? "http://127.0.0.1:43100";
const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: ["full-stack.spec.ts", "fullstack/**/*.spec.ts"],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["line"],
    ["json", { outputFile: "test-results/fullstack-report.json" }],
    ...(process.env.CI ? [["html", { open: "never" }] as ["html", { open: "never" }]] : []),
  ],
  use: {
    baseURL,
    ...(browserExecutable ? { launchOptions: { executablePath: browserExecutable } } : {}),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "full-stack-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
