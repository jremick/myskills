import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { runOperationalAcceptance } from "../../../../../scripts/operational-acceptance.mjs";

// Failure ledger, written before production code:
// - A fixture-only editor hides missing persistence: use real API/Postgres and reload.
// - Invalid JSON disappears on save: save incomplete metadata, reload, then repair.
// - A stale tab overwrites newer bytes: independently open two tabs and resolve 409.
// - Unsaved recovery silently replaces newer work: require explicit recovery/rebase.
// - Imports alter source bytes or licenses: compare exact held multi-file content.
// - Corrections mutate reviewed bytes: fork server submission and compare old export.
// - Unsafe preview executes package content: inspect literal HTML and page errors.
// - History restore rewrites a snapshot: restore as a new revision and reread old one.
// Existing operational acceptance proves archive/CLI submission; it cannot prove
// browser edits, recovery or draft persistence. No mocked routes or test-only seam.
type Actor = { token: string; expiresAt: string; user: { id: string; email: string; roles: string[]; mfaVerified: boolean } };
type Draft = { id: string; revision: number; title: string; files: Array<{ path: string; content: string }>; submission: { id: string; artifactSha256: string } | null };

test("private browser drafts persist, reject stale edits, recover work, and correct immutable submissions", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const baseURL = process.env.MYSKILLS_E2E_BASE_URL;
  if (!baseURL) throw new Error("The disposable full-stack base URL is required.");
  // The maintained runtime exposes this actor callback; its older declaration
  // omits it. Extend the existing callback type locally without a runtime seam.
  const callbacks: NonNullable<NonNullable<Parameters<typeof runOperationalAcceptance>[0]>["callbacks"]> & {
    beforeRevocation: (context: { actors: { author: Actor; reviewer: Actor; consumer: Actor } }) => Promise<void>;
  } = {
    async beforeRevocation({ actors }: { actors: { author: Actor; reviewer: Actor; consumer: Actor } }) {
      await exerciseDrafts(page, testInfo, baseURL, actors);
    },
  };
  const report = await runOperationalAcceptance({ callbacks });
  expect(report.passed).toBe(true);
});

async function exerciseDrafts(page: Page, testInfo: TestInfo, baseURL: string, actors: { author: Actor; reviewer: Actor; consumer: Actor }) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  const authorHeaders = { authorization: `Bearer ${actors.author.token}` };
  const slug = `draft-journey-${randomUUID().slice(0, 8)}`;
  await page.context().clearCookies();
  await page.context().addCookies([{ name: "myskills_session", value: actors.author.token, url: baseURL, httpOnly: true, secure: true, sameSite: "Lax" }]);
  await page.goto("/");
  await page.evaluate((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user: actors.author.user, expiresAt: actors.author.expiresAt });
  await page.goto("/submit");
  const workspace = page.getByRole("region", { name: "Private package drafts", exact: true });
  await workspace.getByRole("button", { name: "New draft", exact: true }).click();
  await workspace.getByLabel("New skill name", { exact: true }).fill(slug);
  const createdResponse = page.waitForResponse((r) => r.url().endsWith("/v1/drafts") && r.request().method() === "POST");
  await workspace.getByRole("button", { name: "Create draft", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const initial = (await created.json()).draft as Draft;
  await workspace.getByLabel("Draft file", { exact: true }).selectOption("skill.json");
  await workspace.getByLabel("File contents", { exact: true }).fill('{"incomplete":');
  await workspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(workspace.getByText("Saved revision 2.", { exact: true })).toBeVisible();
  await page.reload();
  await workspace.getByLabel("Draft file", { exact: true }).selectOption("skill.json");
  await expect(workspace.getByLabel("File contents", { exact: true })).toHaveValue('{"incomplete":');
  await workspace.getByRole("button", { name: "Validate saved draft", exact: true }).click();
  await expect(workspace.getByText("Package needs changes", { exact: true })).toBeVisible();
  const manifest = initial.files.find((file) => file.path === "skill.json")!.content;
  await workspace.getByLabel("File contents", { exact: true }).fill(manifest);
  const heldText = "\uFEFF# Review checklist\r\n\r\nUnicode: café 中文\r\n<script>window.packageExecuted = true</script>\r\n";
  await workspace.getByLabel("Text files", { exact: true }).setInputFiles([
    { name: "skill.json", mimeType: "application/json", buffer: Buffer.from(manifest) },
    { name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(initial.files.find((file) => file.path === "SKILL.md")!.content) },
    { name: "review.md", mimeType: "text/markdown", buffer: Buffer.from(heldText) },
    { name: "invalid-utf8.txt", mimeType: "text/plain", buffer: Buffer.from([0xff, 0xfe]) },
  ]);
  await expect(workspace.getByText(/Invalid UTF-8 or binary content; this file cannot be imported/)).toBeVisible();
  await workspace.getByRole("button", { name: "Preview import", exact: true }).click();
  await workspace.getByRole("button", { name: "Use imported files", exact: true }).click();
  await workspace.getByLabel("Draft file", { exact: true }).selectOption("review.md");
  await workspace.getByRole("button", { name: "Preview text", exact: true }).click();
  await expect(workspace.getByLabel("Safe file preview", { exact: true })).toContainText("<script>");
  expect(await page.evaluate(() => (window as unknown as { packageExecuted?: boolean }).packageExecuted)).toBeUndefined();
  await workspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(workspace.getByText("Saved revision 3.", { exact: true })).toBeVisible();
  const secondTab = await page.context().newPage();
  await secondTab.goto(`/submit?draft=${initial.id}`);
  const secondWorkspace = secondTab.getByRole("region", { name: "Private package drafts", exact: true });
  await expect(secondWorkspace.getByLabel("Draft title", { exact: true })).toBeVisible();
  await secondWorkspace.getByLabel("Draft title", { exact: true }).fill("Stale tab edits");
  await workspace.getByLabel("Draft title", { exact: true }).fill("Current saved title");
  await workspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(workspace.getByText("Saved revision 4.", { exact: true })).toBeVisible();
  await secondWorkspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(secondWorkspace.getByText(/A newer revision is saved/)).toBeVisible();
  await secondWorkspace.getByRole("button", { name: "Load latest saved revision", exact: true }).click();
  await expect(secondWorkspace.getByLabel("Draft title", { exact: true })).toHaveValue("Current saved title");
  await secondWorkspace.getByLabel("Draft title", { exact: true }).fill("Stale recovered edits");
  const latestResponse = await page.request.get(`${baseURL}/api/v1/drafts/${initial.id}`, { headers: authorHeaders });
  const latest = (await latestResponse.json()).draft as Draft;
  const advanced = await page.request.put(`${baseURL}/api/v1/drafts/${initial.id}`, { headers: authorHeaders, data: { expectedRevision: latest.revision, title: "Independent saved title", files: latest.files } });
  expect(advanced.status()).toBe(200);
  secondTab.once("dialog", (dialog) => dialog.accept());
  await secondTab.reload();
  await expect(secondWorkspace.getByText(/Recovery was based on revision 4. The server is at revision 5/)).toBeVisible();
  await secondWorkspace.getByRole("button", { name: "Recover unsaved edits", exact: true }).click();
  await expect(secondWorkspace.getByLabel("Draft title", { exact: true })).toHaveValue("Stale recovered edits");
  await secondWorkspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(secondWorkspace.getByText("Saved revision 6.", { exact: true })).toBeVisible();
  await secondTab.close();
  await page.reload();
  await expect(workspace.getByLabel("Draft title", { exact: true })).toHaveValue("Stale recovered edits");
  await workspace.getByLabel("Draft title", { exact: true }).fill("Recovered title");
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(workspace.getByRole("button", { name: "Recover unsaved edits", exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "Recover unsaved edits", exact: true }).click();
  await expect(workspace.getByLabel("Draft title", { exact: true })).toHaveValue("Recovered title");
  await workspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(workspace.getByText("Saved revision 7.", { exact: true })).toBeVisible();
  await workspace.getByRole("button", { name: "Validate saved draft", exact: true }).click();
  await expect(workspace.getByText("Package is valid", { exact: true })).toBeVisible();
  const submittedResponse = page.waitForResponse((r) => r.url().endsWith(`/drafts/${initial.id}/submit`) && r.request().method() === "POST");
  await workspace.getByRole("button", { name: "Submit saved revision", exact: true }).click();
  const submitted = await submittedResponse;
  expect(submitted.ok()).toBe(true);
  const first = (await submitted.json()).submission;
  const oldExportResponse = await page.request.get(`${baseURL}/api/v1/submissions/${first.id}/bundle`, { headers: authorHeaders });
  expect(oldExportResponse.status()).toBe(200);
  const oldExport = await oldExportResponse.json();
  const decision = await page.request.post(`${baseURL}/api/v1/review/submissions/${first.id}/actions`, { headers: { authorization: `Bearer ${actors.reviewer.token}` }, data: { action: "request-changes", reason: "Add a concrete correction example." } });
  expect(decision.ok()).toBe(true);
  await page.reload();
  const row = page.locator(".submission-row").filter({ hasText: `${slug}@0.1.0` });
  await row.getByRole("button", { name: /View feedback/ }).click();
  await expect(page.getByRole("region", { name: "Submission feedback" }).getByText("Add a concrete correction example.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose corrected package", exact: true }).click();
  await expect(workspace.getByText(/Source: submission/)).toBeVisible();
  await workspace.getByLabel("Draft file", { exact: true }).selectOption("skill.json");
  const correctedManifest = JSON.parse(await workspace.getByLabel("File contents", { exact: true }).inputValue());
  expect(correctedManifest.license).toBe("UNLICENSED");
  expect(correctedManifest.visibility).toBe("private");
  correctedManifest.version = "0.1.1";
  await workspace.getByLabel("File contents", { exact: true }).fill(`${JSON.stringify(correctedManifest, null, 2)}\n`);
  await workspace.getByLabel("Draft file", { exact: true }).selectOption("review.md");
  // The textarea displays normalized line endings; it must not rewrite held bytes
  // until the author actually edits this file.
  expect((await page.request.get(`${baseURL}/api/v1/drafts/${initial.id}/revisions/3`, { headers: authorHeaders }).then((r) => r.json())).draft.files.find((file: { path: string }) => file.path === "review.md").content).toBe(heldText);
  await workspace.getByLabel("File contents", { exact: true }).fill(`${heldText}\nConcrete correction example.\n`);
  await workspace.getByRole("button", { name: "Save draft", exact: true }).click();
  await workspace.getByRole("button", { name: "Submit saved revision", exact: true }).click();
  await expect(workspace.getByText(/Submitted .*0.1.1/)).toBeVisible();
  const unchanged = await page.request.get(`${baseURL}/api/v1/submissions/${first.id}/bundle`, { headers: authorHeaders });
  expect(await unchanged.json()).toEqual(oldExport);
  const snapshot = await page.request.get(`${baseURL}/api/v1/drafts/${initial.id}/revisions/3`, { headers: authorHeaders });
  const savedSnapshot = (await snapshot.json()).draft as Draft;
  expect(savedSnapshot.files.find((file) => file.path === "review.md")?.content).toBe(heldText);
  expect(savedSnapshot.files.some((file) => file.path === "invalid-utf8.txt")).toBe(false);
  const foreign = await page.request.get(`${baseURL}/api/v1/drafts/${initial.id}`, { headers: { authorization: `Bearer ${actors.consumer.token}` } });
  expect(foreign.status()).toBe(404);
  await workspace.getByRole("button", { name: "Saved history", exact: true }).click();
  await expect(workspace.getByLabel("Compare saved revision", { exact: true })).toBeVisible();
  await workspace.getByLabel("Compare saved revision", { exact: true }).selectOption("1");
  await expect(workspace.getByText(/changed files/).first()).toBeVisible();
  const correctionURL = page.url();
  await page.goto(`/submit?draft=${initial.id}`);
  await workspace.getByRole("button", { name: "Saved history", exact: true }).click();
  await workspace.getByLabel("Compare saved revision", { exact: true }).selectOption("3");
  await workspace.getByRole("button", { name: "Restore as new revision", exact: true }).click();
  await expect(workspace.getByText("Saved revision 8.", { exact: true })).toBeVisible();
  const preserved = await page.request.get(`${baseURL}/api/v1/drafts/${initial.id}/revisions/7`, { headers: authorHeaders });
  expect((await preserved.json()).draft.submission.id).toBe(first.id);
  await page.goto(correctionURL);
  await workspace.getByRole("button", { name: "Saved history", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("author-private-draft-history.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("author-private-draft-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
  await testInfo.attach("author-draft-persistence", { body: JSON.stringify({ outcome: "pass", draftId: initial.id, preservedRevision: 3, firstSubmissionId: first.id, firstArtifactSha256: first.artifactSha256, foreignReadStatus: foreign.status(), originalExportUnchanged: true }), contentType: "application/json" });
}
