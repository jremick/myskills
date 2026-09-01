import { defineConfig, devices } from "@playwright/test";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();

export default defineConfig({
  testDir: "./test/e2e",
  testIgnore: "full-stack.spec.ts",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4174",
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4174 --strictPort",
    env: {
      ...process.env,
      VITE_API_BASE_URL: "/api",
    },
    url: "http://127.0.0.1:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
