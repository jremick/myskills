import { expect, test } from "@playwright/test";

// Test first: rendered plan review must bind the selected saved revision and
// observation. Approval is a distinct click with the complete review digest;
// stale approval preserves inspectable history and never requests target apply.
const user = { id: "plan-owner", email: "plan@example.test", name: "Plan owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
const digest = "a".repeat(64);
const reviewDigest = "b".repeat(64);
const target = {
  schemaVersion: 1, id: "plan-target", name: "Review workspace", owner: { type: "user", id: user.id },
  architectureId: "plan-architecture", profileId: "personal", environmentId: "personal-machine",
  adapter: { kind: "codex", version: "1.0.0", contractVersion: 1 }, status: "connected", generation: 3,
  capabilities: { "inventory.read": true, "health.read": true, "plan.read": true },
  consent: { status: "granted" }, metadata: {}, health: { status: "healthy", checkedAt: "2026-09-30T01:00:00Z" },
};
const observation = { schemaVersion: 1, id: "observation-3", targetId: target.id, targetGeneration: 3, observedDigest: digest, adapterDigest: digest, capabilitiesDigest: digest, observedAt: "2026-09-30T01:00:00Z", skills: [], configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true } };
const run = {
  schemaVersion: 1, identity: { schemaVersion: 1, runId: "review-run", targetId: target.id, targetGeneration: 3, architectureId: target.architectureId, revisionId: "revision-1", profileId: "personal", environmentId: "personal-machine" },
  state: "drafted", digests: { desiredDigest: digest, compiledDigest: digest, observedDigest: digest, planDigest: "c".repeat(64) },
  steps: [
    { id: "step-router", ordinal: 0, nodeId: "root-router", action: "configure-router", state: "planned", targetGeneration: 3 },
    { id: "step-leaf", ordinal: 1, nodeId: "review-skill", action: "update", state: "planned", targetGeneration: 3 },
    { id: "step-denied", ordinal: 2, nodeId: "work-leaf", action: "disable", state: "planned", targetGeneration: 3 },
  ], receipts: [], capabilities: { "plan.read": true, apply: false, "sync.write": false },
  metadata: { source: "architecture-plan", reviewOnly: true, dryRun: true, canApply: false, reviewDigest, observationId: observation.id, observationDigest: digest, revisionDigest: digest, adapterDigest: digest, capabilitiesDigest: digest, consentDigest: digest, policyDigest: digest },
  createdAt: "2026-09-30T01:00:00Z", updatedAt: "2026-09-30T01:00:00Z",
};

for (const width of [1280, 390]) test(`architecture plan inspection preserves stale review at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(user => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-01-01T00:00:00Z", user })), user);
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  let created = false;
  await page.route("**/api/v1/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "POST") {
      bodies.push({ path, body: request.postDataJSON() });
      if (path.endsWith("/plans")) { created = true; return json({ run, replayed: false }, 201); }
      if (path.endsWith("/approve")) return json({ error: { code: "ARCHITECTURE_PLAN_FENCE_STALE", message: "Current policy changed" } }, 409);
      return json({ error: { code: "UNEXPECTED_WRITE" } }, 400);
    }
    if (path === "/v1/me") return json({ user });
    if (path === "/v1/architecture-targets") return json({ targets: [target] });
    if (path === `/v1/architecture-targets/${target.id}`) return json({ target });
    if (path.endsWith("/observations")) return json({ observations: [observation] });
    if (path.endsWith("/plans")) return json({ runs: created ? [run] : [] });
    if (path === "/v1/architecture-plans/review-run") return json({ run });
    if (path === `/v1/architectures/${target.architectureId}`) return json({ architecture: { id: target.architectureId, name: "Router architecture", patternId: "multi-level-router", currentRevisionId: "revision-2", access: { canRead: true, canAppend: true }, revisions: [{ id: "revision-2", revisionNumber: 2, digest }, { id: "revision-1", revisionNumber: 1, digest }], latestRevision: { id: "revision-2", revisionNumber: 2, digest } } });
    if (path === "/v1/architectures") return json({ architectures: [] });
    if (path === "/v1/architecture-patterns") return json({ patterns: [] });
    if (path === "/v1/teams") return json({ teams: [], invitations: [] });
    if (path === "/v1/organizations") return json({ organizations: [] });
    if (path === "/v1/capabilities") return json({ capabilities: { architectureTargets: true, architecturePlans: true } });
    if (path === "/v1/skills") return json({ skills: [] });
    if (path === "/v1/branding") return json({ branding: { appName: "MySkills" } });
    return json({});
  });
  await page.goto("/targets");
  await page.getByRole("button", { name: /Review workspace/ }).click();
  const panel = page.getByRole("region", { name: "Architecture review plans" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Saved revision").selectOption("revision-1");
  await panel.getByRole("button", { name: "Create dry-run plan" }).click();
  await expect(panel.getByText("review-skill", { exact: true })).toBeVisible();
  expect(bodies[0].body).toMatchObject({ revisionId: "revision-1", expectedTargetGeneration: 3, expectedObservationId: observation.id, expectedObservationDigest: digest });
  await expect(panel).toContainText("Review approval only");
  await panel.getByRole("button", { name: "Approve this review" }).click();
  await expect(panel.getByRole("alert")).toContainText("changed");
  expect(bodies[1].body).toEqual({ expectedReviewDigest: reviewDigest });
  await expect(panel).toContainText("revision-1");
  await expect(panel).toContainText("drafted");
  expect(bodies.every(item => item.path.endsWith("/plans") || item.path.endsWith("/approve"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath(`architecture-review-${width}.png`), fullPage: true });
  await info.attach("review-evidence", { body: JSON.stringify({ width, selectedRevision: "revision-1", staleReviewPreserved: true, targetWriteRequests: 0 }), contentType: "application/json" });
});
