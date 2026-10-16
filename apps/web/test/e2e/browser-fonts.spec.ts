import { expect, test } from "@playwright/test";
import { isolateBrowserFonts } from "./browser-test.js";

test("the application and a second page load when the font service is unavailable", async ({ browser, baseURL }, info) => {
  const context = await browser.newContext();
  let releaseFont: () => void = () => {};
  const unavailable = new Promise<void>((resolve) => { releaseFont = resolve; });
  let upstreamRequests = 0;
  await context.route("https://fonts.googleapis.com/**", async (route) => {
    upstreamRequests += 1;
    await unavailable;
    await route.abort();
  });
  await isolateBrowserFonts(context);
  const loaded: string[] = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const page = await context.newPage();
      const response = await page.goto(`${baseURL}/login`, { timeout: 5_000 });
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Login", exact: true })).toBeVisible();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      loaded.push(page.url());
    }
    expect(upstreamRequests).toBe(0);
    await info.attach("font-isolation.json", {
      body: JSON.stringify({ loaded, upstreamRequests }), contentType: "application/json",
    });
  } finally {
    releaseFont();
    await context.close();
  }
});
