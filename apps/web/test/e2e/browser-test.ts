import { test as base, type BrowserContext } from "@playwright/test";

export * from "@playwright/test";

// An unavailable external stylesheet blocks page load and new-tab navigation.
// Browser tests use system fallback fonts; application assets and APIs stay live.
export async function isolateBrowserFonts(context: BrowserContext): Promise<void> {
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await isolateBrowserFonts(context);
    await use(context);
  },
});
