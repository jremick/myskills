import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

// UI-only contract, written before implementation. Real team authorization,
// persistence, upstream bytes and revocation races are verified by the API and
// full-stack journeys. This browser fixture targets presentation failures:
// - treating a team candidate as a personal import and offering self-review;
// - describing a team-owned skill as contributor-owned;
// - hiding discovery/tracking from authorized curators because of owner type;
// - retaining mutation controls after refreshed capabilities become read-only.
test("team source controls follow capabilities and imports require instance review", async ({ page }, testInfo) => {
  const user = { id: "team-curator", email: "curator@example.test", name: "Engineering curator", status: "active", roles: ["author"], emailVerified: true, mfaVerified: true };
  const libraryId = "engineering-library";
  const sourceId = "engineering-source";
  const stamp = "2026-09-29T00:00:00Z";
  let curator = true;
  let author = true;
  let subscribed = false;
  let mode = "off";
  const imported = new Set<string>();
  const writes: string[] = [];
  const snapshot = { id: "team-snapshot", sequence: 1, commit: "a".repeat(40), treeSha: "b".repeat(40), ref: { kind: "default-branch" }, upstreamLabel: null, orderStatus: "initial", complete: true, observedAt: stamp };
  const roots = ["ce-plan", "ce-code-review"];
  const bundle = JSON.stringify({ files: [{ path: "SKILL.md", content: "Inspect the supplied changes before recommending a plan." }] });
  const digest = createHash("sha256").update(bundle).digest("hex");
  const library = () => ({ id: libraryId, name: "Engineering", description: "Team recommendations", owner: { type: "team", id: "engineering-team", name: "Engineering team" }, status: "active", revision: 1, access: { role: curator ? "curator" : "member", canWrite: curator, canImport: curator && author, canTrackSources: curator }, subscription: subscribed ? { events: ["adoption-changed"], createdAt: stamp } : null, createdAt: stamp, updatedAt: stamp });
  const source = () => ({ id: sourceId, libraryId, kind: "source", status: "active", title: "everyinc/compound-engineering-plugin", revision: 1, source: { provider: "github", repositoryId: "compound-fixture", fullName: "everyinc/compound-engineering-plugin", url: "https://github.com/everyinc/compound-engineering-plugin", path: "", ref: { kind: "default-branch" }, defaultBranch: "main", license: "MIT", archived: false }, tracking: { mode, health: mode === "off" ? "not-tracked" : "healthy", nextCheckAt: null, lastSuccessfulCheckAt: null, workerAvailable: true, identityChange: null }, adoption: null });
  const skill = (name: string) => ({ id: `skill-${name}`, libraryId, kind: "skill", status: "active", title: name, revision: 1, skill: { slug: `${name}-team123`, nativeName: name, sourceEntryId: sourceId, sourcePath: `skills/${name}`, lineageId: `lineage-${name}`, ownership: { type: "team", id: "engineering-team", name: "Engineering team", isCaller: false } }, adoption: null });
  const candidate = (name: string) => ({ id: `candidate-${name}`, sourceEntryId: sourceId, skillEntryId: imported.has(name) ? `skill-${name}` : null, previewId: "team-preview", sourcePath: `skills/${name}`, snapshot, expectedVersion: "0.0.1", state: imported.has(name) ? "accepted" : "ready-for-review", orderStatus: "initial", lineage: { slug: `${name}-team123`, nativeName: name }, mapping: { title: name, summary: "Inspect supplied changes.", license: "MIT", visibility: "team" }, files: [{ path: "SKILL.md", content: "Inspect the supplied changes before recommending a plan.", bytes: 54 }], packageDigest: digest, findings: [], changes: null, expiresAt: "2027-09-29T00:00:00Z", registry: imported.has(name) ? { submissionId: `submission-${name}`, slug: `${name}-team123`, version: "0.0.1", reviewStatus: "unreviewed", securityStatus: "passed", attestation: null } : null });
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-29T00:00:00Z" })), user);
  await page.route("**/api/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname.replace("/api", "");
    const method = route.request().method();
    if (method !== "GET") writes.push(pathname);
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (pathname === "/v1/me") return reply({ user });
    if (pathname === "/v1/teams") return reply({ teams: [{ id: "engineering-team", name: "Engineering team", role: curator ? "owner" : "member" }], invitations: [] });
    if (pathname === "/v1/libraries") return reply({ libraries: [library()], nextCursor: null });
    if (pathname === `/v1/libraries/${libraryId}`) return reply({ library: library() });
    if (pathname === `/v1/libraries/${libraryId}/entries`) return reply({ entries: [source(), ...[...imported].map(skill)], nextCursor: null });
    if (pathname === "/v1/library-inbox") return reply({ items: [], nextCursor: null, unreadCount: 0 });
    if (pathname.endsWith("/subscription")) { subscribed = method === "PUT"; return reply({ subscription: library().subscription }); }
    if (pathname.endsWith("/discoveries")) return reply({ discovery: { snapshot, complete: true, skills: roots.map((name) => ({ path: `skills/${name}`, directoryName: name, fileCount: 1, byteCount: 54, blockers: [], lineage: null })), excluded: [] } });
    if (pathname.endsWith("/candidates")) return reply({ candidates: [...imported].map(candidate), nextCursor: null });
    if (pathname.endsWith("/previews")) {
      expect(route.request().postDataJSON().paths).toEqual(roots.map((name) => `skills/${name}`));
      return reply({ preview: { id: "team-preview", candidates: roots.map(candidate), expiresAt: "2027-09-29T00:00:00Z" } });
    }
    if (pathname.endsWith("/import")) {
      const name = roots.find((name) => pathname === `/v1/library-candidates/candidate-${name}/import`)!;
      imported.add(name); return reply({ candidate: candidate(name), entry: skill(name) }, 202);
    }
    if (pathname.endsWith("/tracking")) { mode = route.request().postDataJSON().mode; return reply({ entry: source() }); }
    if (pathname.startsWith("/v1/submissions/") && pathname.endsWith("/bundle")) return route.fulfill({ contentType: "application/json", body: bundle });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "Engineering", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Discover skills", exact: true }).click();
  for (const name of roots) await page.getByLabel(`Select skills/${name}`).check();
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  for (const name of roots) {
    const preview = page.getByRole("article", { name: `Import skills/${name}`, exact: true });
    await preview.getByRole("button", { name: "Submit import for review", exact: true }).click();
    await expect(preview.getByText("Team imports require instance review before adoption.", { exact: true })).toBeVisible();
    await expect(preview.getByRole("button", { name: "Approve for my private use", exact: true })).toHaveCount(0);
    await expect(preview.getByLabel("I reviewed these files for my private use")).toHaveCount(0);
    await expect(preview.getByRole("button", { name: "Adopt version", exact: true })).toHaveCount(0);
  }
  await page.getByLabel("Check frequency").selectOption("weekly");
  await page.getByRole("button", { name: "Save tracking", exact: true }).click();
  await expect.poll(() => mode).toBe("weekly");
  await page.getByRole("button", { name: "Close import", exact: true }).click();
  await page.getByRole("button", { name: "ce-plan", exact: true }).click();
  await expect(page.getByText("Owned by Engineering team. Curators manage this skill on the team's behalf.", { exact: true })).toBeVisible();
  await expect(page.getByText("This skill remains owned by its contributor.", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("team-owned-import.png"), fullPage: true });

  // Source review remains available to a curator who no longer has author rights.
  author = false;
  await page.reload();
  await page.locator(".library-list").getByRole("button", { name: "everyinc/compound-engineering-plugin", exact: true }).click();
  await page.getByRole("button", { name: "Review candidates", exact: true }).click();
  await expect(page.getByRole("article", { name: "Import skills/ce-plan", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit import for review", exact: true })).toHaveCount(0);

  // The current actor becomes a member. The real API owns enforcement; this
  // verifies the browser refresh removes actions while keeping subscription.
  curator = false;
  await page.reload();
  await page.locator(".library-list").getByRole("button", { name: "everyinc/compound-engineering-plugin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Discover skills", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review candidates", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Check frequency")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove entry", exact: true })).toHaveCount(0);
  await page.getByLabel("Notify me about changes").check();
  await expect.poll(() => subscribed).toBe(true);
  expect(writes.some((path) => path.endsWith("/self-review"))).toBe(false);
  await testInfo.attach("team-library-ui-receipt", { body: JSON.stringify({ boundary: "browser UI with synthetic API responses", selectedRoots: roots, imported: [...imported], privateSelfReviewOffered: false, tracking: mode, memberSubscribed: subscribed, writes }), contentType: "application/json" });
});
