import { expect, test, type Page } from "@playwright/test";
import { runOperationalAcceptance } from "../../../../../scripts/operational-acceptance.mjs";
import { proveCodexRecognition } from "../../../../../scripts/prove-codex-recognition.mjs";

type BrowserActor = {
  token: string;
  expiresAt: string;
  user: { id: string; email: string; name: string; status: string; roles: string[]; emailVerified: boolean; mfaVerified: boolean };
};

test.describe.configure({ retries: 0 });

test("author feedback, immutable publication, upgrade policy, real CLI install/update/rollback, and revocation", async ({ page }, testInfo) => {
  test.setTimeout(process.env.MYSKILLS_ACCEPTANCE_ENVIRONMENT === "staging" ? 600_000 : 180_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.name));
  const report = await runOperationalAcceptance({
    callbacks: {
      async afterWorkspaceInstall({ workspace, slug }) {
        if (process.env.MYSKILLS_ACCEPTANCE_RUNTIME_PROOF !== "codex") return;
        const recognition = await proveCodexRecognition({ workspace, slug });
        await testInfo.attach("codex-runtime-recognition", { body: JSON.stringify(recognition), contentType: "application/json" });
      },
      async afterFeedback({ slug, actor, reason }: { slug: string; actor: BrowserActor; reason: string }) {
        await useSession(page, actor, "/submit");
        const row = page.locator(".submission-row").filter({ hasText: `${slug}@0.1.0` });
        await expect(row).toBeVisible();
        await row.getByRole("button", { name: /feedback|details|review/i }).click();
        await expect(page.getByRole("region", { name: "Submission feedback" }).getByText(reason, { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Dependency install hook requires maintainer review.", { exact: true }).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("author-review-feedback.png"), fullPage: true });
      },
      async afterPublish({ slug, actor }: { slug: string; actor: BrowserActor }) {
        await useSession(page, actor, `/skills/${slug}`);
        await expect(page.getByRole("heading", { name: /^Acceptance / })).toBeVisible();
        await expect(page.getByText("0.1.1", { exact: true }).first()).toBeVisible();
        const files = page.getByRole("region", { name: "Package files" });
        await files.getByRole("button", { name: "Inspect package files" }).click();
        await files.getByLabel("Package file", { exact: true }).selectOption("SKILL.md");
        await expect(files.getByLabel("Contents of SKILL.md", { exact: true })).toContainText(`name: ${slug}`);
        await expect(files.getByLabel("Contents of SKILL.md", { exact: true })).toContainText("Version 0.1.1.");
        await page.screenshot({ path: testInfo.outputPath("consumer-published-package.png"), fullPage: true });
      },
      async afterUnpublish({ slug, actor, version }) {
        await useSession(page, actor, "/manage/skills");
        await page.getByRole("textbox", { name: "Search managed skills" }).fill(slug);
        const row = page.locator(".managed-skill-row").filter({ hasText: slug });
        await expect(row).toBeVisible();
        await row.click();
        await page.getByLabel("Managed release version").selectOption(version);
        await expect(page.getByLabel("Managed release version").locator("option:checked")).toHaveText(`${version} · unpublished`);
        await expect(page.getByRole("button", { name: `Restore ${version}`, exact: true })).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath("maintainer-unpublished-history.png"), fullPage: true });
      },
      async afterArchive({ slug, actor }) {
        await useSession(page, actor, "/manage/skills");
        await page.getByRole("textbox", { name: "Search managed skills" }).fill(slug);
        const row = page.locator(".managed-skill-row").filter({ hasText: slug });
        await expect(row).toContainText("archived");
        await row.click();
        await expect(page.getByRole("button", { name: "Restore skill", exact: true })).toBeEnabled();
        await page.screenshot({ path: testInfo.outputPath("maintainer-archived-inventory.png"), fullPage: true });
      },
      async afterPolicyBlocked({ slug, actor, targetName, releases }) {
        await useSession(page, actor, "/updates");
        await expect(page.getByRole("heading", { name: "System update centre", exact: true })).toBeVisible();
        const target = page.locator(".target-update-card").filter({ has: page.getByRole("heading", { name: targetName, exact: true }) });
        const update = target.locator(".target-update-row").filter({ hasText: slug });
        await expect(update.getByText("The upgrade crosses a release change kind that your policy does not allow.", { exact: true })).toBeVisible();
        await expect(update.getByRole("checkbox")).toBeDisabled();
        await update.getByRole("button", { name: "Review", exact: true }).click();
        const review = page.locator(".update-review-card");
        await expect(review.getByRole("heading", { name: `Review blocked update for ${slug}`, exact: true })).toBeVisible();
        for (const release of releases) {
          const included = review.locator("article").filter({ has: page.getByText(release.version, { exact: true }) });
          await expect(included.getByText(release.changeKind, { exact: true })).toBeVisible();
          await expect(included.getByText(release.releaseNotes, { exact: true })).toBeVisible();
        }
        await expect(review.getByRole("button", { name: "Queue exact update", exact: true })).toBeDisabled();
        await page.screenshot({ path: testInfo.outputPath("blocked-upgrade-policy.png"), fullPage: true });
      },
      async afterRevocation({ slug, actor }: { slug: string; actor: BrowserActor }) {
        await useSession(page, actor, `/skills/${slug}`);
        await expect(page.getByText(/not found|unavailable|not available/i).first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("consumer-revoked-package.png"), fullPage: true });
      },
    },
  });
  expect(report.passed).toBe(true);
  expect(browserErrors).toEqual([]);
  await testInfo.attach("operational-acceptance", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
});

async function useSession(page: Page, actor: BrowserActor, path: string) {
  const baseUrl = process.env.MYSKILLS_E2E_BASE_URL;
  if (!baseUrl) throw new Error("MYSKILLS_E2E_BASE_URL is required.");
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "myskills_session", value: actor.token, url: baseUrl, httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto("/");
  await page.evaluate((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user: actor.user, expiresAt: actor.expiresAt });
  await page.goto(path);
  await expect(page.getByRole("link", { name: "Account settings" })).toHaveAttribute("title", actor.user.email);
}
