import { defineConfig, devices } from "@playwright/test";

const browserExecutable = process.env.MYSKILLS_E2E_BROWSER_EXECUTABLE?.trim();
const port = Number(process.env.MYSKILLS_E2E_PORT ?? 4174);

export default defineConfig({
  testDir: "./test/e2e",
  testIgnore: ["full-stack.spec.ts", "**/fullstack/**"],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : {},
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run ${process.env.MYSKILLS_E2E_PREVIEW === "1" ? "preview" : "dev"} -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: {
      ...process.env,
      VITE_API_BASE_URL: "/api",
    },
    url: `http://127.0.0.1:${port}`,
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
