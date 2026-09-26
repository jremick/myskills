import { expect, test } from "@playwright/test";

// Journey specified before the UI implementation. API/permission behavior is
// independently exercised by the memory and Postgres lifecycle journeys.
test("skill optimisation distinguishes declarations from evidence, rejects a blocked plan, and gives an explicit local handoff", async ({ page }) => {
  const user = { id: "user-owner", name: "Owner", email: "owner@example.com", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  const platform = { name: "codex", installTarget: ".agents/skills", status: "supported" };
  const skill = { slug: "notes-helper", title: "Notes Helper", summary: "Summarize release notes.", visibility: "public", lifecycleStatus: "approved", latestVersion: "1.0.0", reviewStatus: "approved", securityStatus: "passed", platforms: [platform], tags: [], access: { canManageSharing: true } };
  const release = { ...skill, version: "1.0.0", publishedAt: "2026-09-25T00:00:00Z", artifact: { sha256: "a".repeat(64), byteSize: 1000, contentType: "application/json" } };
  const reviewer = { ...skill, slug: "prompt-reviewer", title: "Prompt Reviewer", access: { canManageSharing: false } };
  let blocked = true; let savedPolicy = false; let savedDeclaration = false; let profileWrites = 0;
  await page.addInitScript(({ user }) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-01-01T00:00:00Z", user })), { user });
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname; const method = route.request().method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/me") return reply({ user });
    if (p === "/api/v1/skills") return reply({ skills: [skill, reviewer], nextCursor: null });
    if (p === "/api/v1/skills/notes-helper") return reply({ skill });
    if (p === "/api/v1/skills/notes-helper/releases") return reply({ releases: [{ ...release, id: "r1", findingCount: 0, allowedActions: [] }] });
    if (p === "/api/v1/skills/notes-helper/releases/1.0.0") return reply({ release });
    if (p === "/api/v1/skills/prompt-reviewer/releases/1.0.0") return reply({ release: { ...release, slug: reviewer.slug, artifact: { ...release.artifact, sha256: "b".repeat(64) } } });
    if (p.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, release: { slug: skill.slug, version: release.version, artifactSha256: release.artifact.sha256, published: true }, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    if (p.endsWith("/declarations") && method === "POST") { savedDeclaration = true; return reply({ revision: { id: "decl1", revisionNumber: 1, review: null } }, 201); }
    if (p.includes("/policies/")) { if (method === "PUT") savedPolicy = true; return reply({ revision: savedPolicy ? { revisionNumber: 1, policy: { enabled: true, reviewers: [] } } : null }); }
    if (p === "/api/v1/improvements/profiles" && method === "POST") { profileWrites += 1; return reply({ profile: { id: "profile1", latest: { id: "profile-revision1", revisionNumber: 1 } } }, 201); }
    if (p === "/api/v1/improvements/plans/preview") return reply({ plan: null, planSha256: null, effectivePolicy: { status: blocked ? "blocked" : "allowed", blockers: blocked ? [{ code: "INFERENCE_ROUTE_BLOCKED", message: "Organization policy prohibits this cloud route." }] : [], warnings: [] } });
    if (p === "/api/v1/improvements/plans") return reply({ plan: { id: "plan1", planSha256: "c".repeat(64), expiresAt: "2027-01-01T00:00:00Z" } }, 201);
    if (p === "/api/v1/teams") return reply({ teams: [], invitations: [] });
    if (p === "/api/v1/organizations") return reply({ organizations: [] });
    if (p.includes("/targets")) return reply({ targets: [] });
    return reply({ error: { code: "NOT_FOUND", message: "Unavailable fixture endpoint." } }, 404);
  });
  await page.goto("/skills/notes-helper");
  const panel = page.getByRole("region", { name: "Skill improvement" });
  await expect(panel.getByText("No optimisation targets declared.")).toBeVisible();
  await expect(panel.getByText("No accepted evaluation evidence.")).toBeVisible();
  await panel.getByRole("button", { name: "Plan an improvement" }).click();
  await panel.getByLabel("Reviewer skill").selectOption("prompt-reviewer");
  await panel.getByLabel("Target model").fill("claude-opus-5-5");
  await panel.getByLabel("Installed app version").fill("2.1.283");
  await panel.getByLabel("Candidate version").fill("1.1.0");
  await panel.getByLabel("Improvement goal").fill("Clarify output while preserving approval requirements.");
  await panel.getByRole("button", { name: "Preview policy" }).click();
  await expect(panel.getByText("Organization policy prohibits this cloud route.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Prepare local run" })).toBeDisabled();
  blocked = false;
  await panel.getByRole("button", { name: "Preview policy" }).click();
  await panel.getByRole("button", { name: "Prepare local run" }).click();
  await expect(panel.getByText(/myskills improve fetch.*plan1/)).toBeVisible();
  await expect(panel.getByText(/Runs use Claude Code 2.1.283 or newer with cloud inference/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("skill-improvement-mobile.png"), fullPage: true });
  expect(savedDeclaration).toBe(false); expect(savedPolicy).toBe(false);
  expect(profileWrites).toBe(1);
});

test("metadata edits preserve multiple model, app and environment targets and bind the reviewed revision", async ({ page }) => {
  const user = { id: "owner", name: "Owner", email: "owner@example.com", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  const skill = { slug: "notes-helper", title: "Notes Helper", summary: "Summarize release notes.", visibility: "public", lifecycleStatus: "approved", latestVersion: "1.0.0", reviewStatus: "approved", securityStatus: "passed", platforms: [], tags: [], access: { canManageSharing: true } };
  const release = { ...skill, version: "1.0.0", publishedAt: "2026-09-25T00:00:00Z", artifact: { sha256: "a".repeat(64), byteSize: 1000, contentType: "application/json" } };
  const declaration = { schemaVersion: 1, intent: "targeted", targets: [
    { id: "primary", models: [{ provider: "anthropic", id: "claude-opus-5-5" }], apps: [{ id: "claude-code", version: "2.1.283" }], environment: { os: ["windows"], requiredCapabilities: ["workspace.read"], network: "optional" } },
    { id: "secondary", models: [{ provider: "openai", id: "gpt-5.5" }], apps: [{ id: "codex" }] },
  ], objectives: ["task-success", "token-efficiency"], limitations: ["Text-only evaluation."] };
  const revision = { id: "decl1", revisionNumber: 1, kind: "attestation", declaration, declarationSha256: "d".repeat(64), review: { decision: "approve" } };
  let pending: typeof revision | null = null; let submitted: Record<string, unknown> | null = null; let reviewBody: Record<string, unknown> | null = null;
  await page.addInitScript(({ user }) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-01-01T00:00:00Z", user })), { user });
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/v1/me") return reply({ user });
    if (p === "/api/v1/skills") return reply({ skills: [skill] });
    if (p === "/api/v1/skills/notes-helper") return reply({ skill });
    if (p.endsWith("/releases")) return reply({ releases: [{ ...release, id: "r1", findingCount: 0, allowedActions: [] }] });
    if (p === "/api/v1/skills/notes-helper/releases/1.0.0") return reply({ release });
    if (p.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "approved", revision }, evidence: [], manage: { pendingRevisions: pending ? [pending] : [], evidenceProposals: [] } } });
    if (p.endsWith("/declarations")) { submitted = route.request().postDataJSON(); pending = { ...revision, id: "decl2", revisionNumber: 2, declaration: submitted!.declaration as typeof declaration, review: null as unknown as typeof revision.review }; return reply({ revision: pending }, 201); }
    if (p.endsWith("/declarations/decl2/review")) { reviewBody = route.request().postDataJSON(); pending = null; return reply({ revision }); }
    return reply({ error: { code: "NOT_FOUND", message: "Unavailable fixture endpoint." } }, 404);
  });
  await page.goto("/skills/notes-helper");
  const panel = page.getByRole("region", { name: "Skill improvement" });
  await expect(panel.getByText("Environments: windows")).toBeVisible();
  await panel.getByText("Manage optimisation metadata").click();
  await expect(panel.getByLabel("Designed-for model", { exact: true }).first()).toHaveValue("claude-opus-5-5");
  await panel.getByLabel("Limitations").fill("Text-only evaluation on Windows and macOS.");
  await panel.getByRole("button", { name: "Submit metadata for review" }).click();
  await expect(panel.getByText("Metadata submitted for review.")).toBeVisible();
  expect(submitted).toEqual({ declaration: { ...declaration, limitations: ["Text-only evaluation on Windows and macOS."] }, expectedRevisionNumber: 1 });
  await panel.getByRole("button", { name: "Approve metadata" }).click();
  await expect(panel.getByText("Metadata approved.")).toBeVisible();
  expect(reviewBody).toEqual({ decision: "approve", artifactSha256: release.artifact.sha256, declarationSha256: revision.declarationSha256 });
  await page.screenshot({ path: test.info().outputPath("skill-improvement-metadata.png"), fullPage: true });
});
