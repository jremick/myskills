import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { runCli, type CliRuntime } from "../../../../cli/dist/cli.js";
import { startTeamLibraryHarness, type TeamLibraryActor } from "./team-library-harness.js";

// Written before production changes. Real browser -> HTTP -> production services
// -> disposable Postgres, including persisted artifact bytes. Only GitHub's
// transport is deterministic; no browser/API route is mocked. Test-only setup
// seeds accounts, then signs in and manages membership through the real API.
// Failure targets: personal-only controls, wrong release owner, self-review,
// contributor departure breaking held candidate/import continuity, early adoption,
// unauthorized member mutation, automatic adoption/install on source change, and
// revoked membership silently falling back to a registry release on CLI update.
test("Engineering curators source, review and adopt team-owned skills across curator departure", async ({ browser }, info) => {
  const fixture = await startTeamLibraryHarness();
  const workspace = await mkdtemp(join(tmpdir(), "myskills-team-library-browser-"));
  const checks: string[] = [];
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const api = fixture.api;
  async function actorPage(actor: TeamLibraryActor): Promise<Page> {
    const context = await browser.newContext(); contexts.push(context);
    await context.addCookies([{ name: "myskills_session", value: actor.token, url: fixture.baseURL, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user: actor.user, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const page = await context.newPage();
    await page.goto(`${fixture.baseURL}/libraries`);
    return page;
  }
  try {
    const alice = fixture.actors.alice, bob = fixture.actors.bob, member = fixture.actors.member, reviewer = fixture.actors.reviewer;
    const page = await actorPage(alice);
    await page.getByLabel("Library name").fill("Engineering");
    await page.getByLabel("Library owner").selectOption(fixture.teamId);
    await page.getByRole("button", { name: "Create library", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Engineering", exact: true })).toBeVisible();
    await page.getByLabel("GitHub source URL").fill(fixture.sourceURL);
    await page.getByRole("button", { name: "Save source", exact: true }).click();
    await page.getByRole("button", { name: "Discover skills", exact: true }).click();
    for (const name of ["ce-plan", "ce-code-review"]) await page.getByLabel(`Select skills/${name}`).check();
    await page.getByRole("button", { name: "Preview import", exact: true }).click();
    const first = page.getByRole("article", { name: "Import skills/ce-plan", exact: true });
    await first.getByRole("button", { name: "Submit import for review", exact: true }).click();
    await expect(first.getByText("Team imports require instance review before adoption.", { exact: true })).toBeVisible();
    await expect(first.getByRole("button", { name: "Approve for my private use", exact: true })).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Adopt version", exact: true })).toHaveCount(0);
    const { libraries } = await api(alice, "/v1/libraries");
    const libraryId = libraries[0].id;
    const { entries } = await api(alice, `/v1/libraries/${libraryId}/entries`);
    const source = entries.find((entry: { kind: string }) => entry.kind === "source");
    const plan = entries.find((entry: { kind: string }) => entry.kind === "skill");
    expect(plan.skill.ownership).toMatchObject({ type: "team", id: fixture.teamId });
    const { candidates } = await api(alice, `/v1/library-entries/${source.id}/candidates`);
    const pendingPlan = candidates.find((candidate: { sourcePath: string }) => candidate.sourcePath === "skills/ce-plan");
    const pendingReview = candidates.find((candidate: { sourcePath: string }) => candidate.sourcePath === "skills/ce-code-review");
    await api(alice, `/v1/library-candidates/${pendingPlan.id}/self-review`, { artifactSha256: pendingPlan.packageDigest }, "POST", 409);
    await api(alice, `/v1/library-entries/${plan.id}/adoptions`, { version: pendingPlan.expectedVersion, artifactSha256: pendingPlan.packageDigest, expectedCurrentAdoptionId: null }, "POST", 422);
    checks.push("browser selects two pinned roots; first import is team-owned and cannot self-review or adopt before publication");

    await api(bob, `/v1/teams/${fixture.teamId}/members/${alice.user.id}`, undefined, "DELETE");
    await api(alice, `/v1/library-candidates/${pendingReview.id}/import`, { expectedPackageDigest: pendingReview.packageDigest, release: { classification: "unclassified" }, clientMutationId: "departed-curator-import" }, "POST", 404);
    const successor = await actorPage(bob);
    await successor.locator(".library-list").getByRole("button", { name: "everyinc/compound-engineering-plugin", exact: true }).click();
    await successor.getByRole("button", { name: "Review candidates", exact: true }).click();
    const second = successor.getByRole("article", { name: "Import skills/ce-code-review", exact: true });
    await second.getByRole("button", { name: "Submit import for review", exact: true }).click();
    await expect(second.getByText("Team imports require instance review before adoption.", { exact: true })).toBeVisible();
    const { candidates: imported } = await api(bob, `/v1/library-entries/${source.id}/candidates`);
    const digests: Record<string, string> = {};
    for (const candidate of imported) {
      const bundle = await fixture.raw(reviewer, `/v1/review/submissions/${candidate.registry.submissionId}/bundle?platform=codex`);
      const digest = createHash("sha256").update(bundle).digest("hex");
      expect(digest).toBe(candidate.packageDigest);
      digests[candidate.sourcePath] = digest;
      await api(reviewer, `/v1/review/submissions/${candidate.registry.submissionId}/actions`, { action: "approve", artifactSha256: digest });
      await api(reviewer, `/v1/review/submissions/${candidate.registry.submissionId}/actions`, { action: "publish" });
    }
    checks.push("departed curator loses access; successor imports the original held candidate; independent reviewer publishes exact bytes");

    await successor.reload();
    await successor.locator(".library-list").getByRole("button", { name: "everyinc/compound-engineering-plugin", exact: true }).click();
    await successor.getByRole("button", { name: "Review candidates", exact: true }).click();
    for (const name of ["ce-plan", "ce-code-review"]) {
      const candidate = successor.getByRole("article", { name: `Import skills/${name}`, exact: true });
      await candidate.getByRole("button", { name: "Adopt version", exact: true }).click();
      await expect(candidate.getByRole("status")).toHaveText("Version adopted. Installed copies change only when you update them.");
    }
    await successor.getByLabel("Check frequency").selectOption("weekly");
    await successor.getByRole("button", { name: "Save tracking", exact: true }).click();
    await expect.poll(async () => (await api(bob, `/v1/library-entries/${source.id}`)).entry.tracking.mode).toBe("weekly");
    await successor.getByLabel("Notify me about changes").check();
    await expect.poll(async () => Boolean((await api(bob, `/v1/libraries/${libraryId}`)).library.subscription)).toBe(true);
    await successor.getByRole("button", { name: "Close import", exact: true }).click();
    await successor.reload();
    const memberPage = await actorPage(member);
    await memberPage.getByRole("button", { name: "ce-plan", exact: true }).click();
    await expect(memberPage.locator(".library-command")).toContainText(`--library-entry ${plan.id}`);
    await expect(memberPage.getByText("Owned by Engineering team. Curators manage this skill on the team's behalf.", { exact: true })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Adopt registry release", exact: true })).toHaveCount(0);
    await memberPage.getByLabel("Notify me about changes").check();
    await expect.poll(async () => Boolean((await api(member, `/v1/libraries/${libraryId}`)).library.subscription)).toBe(true);
    await api(member, `/v1/library-entries/${source.id}/discoveries`, undefined, "POST", 403);
    await api(member, `/v1/library-entries/${plan.id}/adoptions`, { version: pendingPlan.expectedVersion, artifactSha256: pendingPlan.packageDigest, expectedCurrentAdoptionId: null }, "POST", 403);
    checks.push("adoption and weekly tracking persist across reload; member can read and subscribe but cannot curate");

    const output: string[] = [];
    const runtime: CliRuntime = { env: { MYSKILLS_TOKEN: member.token, MYSKILLS_CONFIG_DIR: join(workspace, "config"), MYSKILLS_TOKEN_STORE: "file" }, fetch, io: { stdout: (line) => output.push(line), stderr: (line) => output.push(line) } };
    const cliArgs = ["--api-url", `${fixture.baseURL}/api`, "--dir", join(workspace, "installed")];
    expect(await runCli(["install", plan.skill.slug, "--library-entry", plan.id, "--accept-user-action", ...cliArgs], runtime), output.join("\n")).toBe(0);
    const installedPath = join(workspace, "installed", plan.skill.slug, "SKILL.md");
    const installed = await readFile(installedPath, "utf8");
    const adoptedBefore = (await api(bob, `/v1/library-entries/${plan.id}`)).entry.adoption;
    fixture.changeGuide();
    await api(bob, `/v1/library-entries/${source.id}/checks`, undefined, "POST");
    const afterCheck = (await api(bob, `/v1/library-entries/${plan.id}`)).entry.adoption;
    expect(afterCheck.id).toBe(adoptedBefore.id);
    expect(await readFile(installedPath, "utf8")).toBe(installed);
    expect((await api(bob, `/v1/library-entries/${source.id}/candidates`)).candidates.some((candidate: { state: string; sourcePath: string }) => candidate.state === "ready-for-review" && candidate.sourcePath === "skills/ce-plan")).toBe(true);
    await memberPage.screenshot({ path: info.outputPath("team-library-member.png"), fullPage: true });
    await api(bob, `/v1/teams/${fixture.teamId}/members/${member.user.id}`, undefined, "DELETE");
    expect(await runCli(["update", plan.skill.slug, ...cliArgs], runtime)).not.toBe(0);
    expect(await readFile(installedPath, "utf8")).toBe(installed);
    await api(member, `/v1/library-entries/${plan.id}/resolution`, undefined, "GET", 404);
    await api(member, `/v1/skills/${plan.skill.slug}/releases/${pendingPlan.expectedVersion}`, undefined, "GET", 404);
    checks.push("source change creates a review candidate without adopting/installing; revoked member update fails with installed bytes preserved");
    await successor.screenshot({ path: info.outputPath("team-library-adopted.png"), fullPage: true });
    await memberPage.reload();
    await expect(memberPage.getByRole("heading", { name: "Create your first library", exact: true })).toBeVisible();
    await expect(memberPage.getByRole("heading", { name: "Engineering", exact: true })).toHaveCount(0);
    await expect(memberPage.getByText("Owned by Engineering team. Curators manage this skill on the team's behalf.", { exact: true })).toHaveCount(0);
    await memberPage.screenshot({ path: info.outputPath("team-library-membership-revoked.png"), fullPage: true });
    await info.attach("team-library-fullstack-receipt", { body: JSON.stringify({ boundary: "real browser, HTTP, Postgres artifacts and CLI files; deterministic GitHub transport", libraryId, teamId: fixture.teamId, fixtureSourceCommit: fixture.initialCommit, digests, installedFileSha256: createHash("sha256").update(installed).digest("hex"), checks }), contentType: "application/json" });
  } finally {
    for (const context of contexts) await context.close();
    await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
