import { expect, test } from "@playwright/test";

// Authored before Libraries UI implementation. API fixtures isolate browser
// interaction; the persistent API and production-like tests prove enforcement.
test("owner imports a pinned preview, handles revoked self-review, adopts and follows a source", async ({ page }, testInfo) => {
  const { createHash } = await import("node:crypto");
  const submittedBundle = JSON.stringify({ files: [{ path: "SKILL.md", content: "Plan carefully." }, { path: "LICENSE", content: "MIT fixture" }] });
  const submittedDigest = createHash("sha256").update(submittedBundle).digest("hex");
  const user = { id: "owner-library", email: "library-owner@example.test", name: "Library owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-26T00:00:00.000Z", user })), user);
  const writes: Array<{ path: string; body: unknown }> = [];
  let allowPrivateSelfReview = true;
  let imported = false;
  let adopted = false;
  let tracking = "manual";
  let subscribed = false;
  let libraries: unknown[] = [];
  const libraryId = "11111111-1111-4111-8111-111111111111";
  const entryId = "22222222-2222-4222-8222-222222222222";
  const previewId = "33333333-3333-4333-8333-333333333333";
  const commit = "a".repeat(40);
  const skillEntryId = "44444444-4444-4444-8444-444444444444";
  const candidateId = "55555555-5555-4555-8555-555555555555";
  let saved = false;
  let reviewed = false;
  const library = () => ({ id: libraryId, name: "Planning tools", description: "", owner: { type: "user", id: user.id }, revision: 1, access: { canWrite: true, canImport: true, canTrackSources: true, role: "owner" }, subscription: subscribed ? { events: ["candidate-ready"], createdAt: "2026-09-26T00:00:00Z" } : null });
  const snapshot = { id: "snapshot-1", commit, treeSha: commit, sequence: 1, complete: true, orderStatus: "initial", ref: { kind: "default-branch" }, upstreamLabel: null, observedAt: "2026-09-26T00:00:00Z" };
  const source = () => ({ id: entryId, libraryId, kind: "source", title: "example/skills", revision: 1, source: { url: "https://github.com/example/skills", fullName: "example/skills", path: "skills", ref: { kind: "default-branch" }, license: "MIT" }, tracking: { mode: tracking, health: "not-tracked", lastSuccessfulCheckAt: null, nextCheckAt: null, workerAvailable: true }, adoption: null });
  const adoption = { id: "adoption-1", entryId: skillEntryId, slug: "planner-ab12cd", version: "0.0.1", artifactSha256: submittedDigest, attestation: "private-self-reviewed" };
  const skill = () => ({ id: skillEntryId, libraryId, title: "Source planner", kind: "skill", revision: 1, skill: { slug: "planner-ab12cd", nativeName: "planner", sourceEntryId: entryId, sourcePath: "skills/planner", ownership: { type: "user", isCaller: true } }, adoption: adopted ? adoption : null });
  const candidate = () => ({ id: candidateId, sourceEntryId: entryId, skillEntryId: imported ? skillEntryId : null, previewId, sourcePath: "skills/planner", snapshot, expectedVersion: "0.0.1", state: imported ? "accepted" : "ready-for-review", lineage: { slug: "planner-ab12cd", nativeName: "planner" }, mapping: { title: "Source planner", summary: "Plan work.", license: "MIT", visibility: "private" }, files: [{ path: "SKILL.md", content: "Plan carefully.", bytes: 15 }, { path: "LICENSE", content: "MIT fixture", bytes: 11 }], packageDigest: submittedDigest, findings: [], changes: null, expiresAt: "2027-09-26T00:00:00Z", registry: imported ? { submissionId: "submission-library", slug: "planner-ab12cd", version: "0.0.1", reviewStatus: reviewed ? "approved" : "unreviewed", securityStatus: "passed", attestation: reviewed ? "private-self-reviewed" : null } : null });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const method = route.request().method();
    const body = method === "GET" ? undefined : route.request().postDataJSON();
    if (method !== "GET") writes.push({ path, body });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/skills") return reply({ skills: [] });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/admin/library-settings") {
      if (method === "PUT") allowPrivateSelfReview = body.privateSelfReviewEnabled;
      return reply({ settings: { privateSelfReviewEnabled: allowPrivateSelfReview, updatedAt: null }, worker: { configured: true, overdueTrackCount: 0 } });
    }
    if (path === "/v1/libraries") {
      if (method === "POST") { libraries = [library()]; return reply({ library: library() }, 201); }
      return reply({ libraries: libraries.length ? [library()] : [], nextCursor: null });
    }
    if (path === `/v1/libraries/${libraryId}`) return reply({ library: library() });
    if (path === `/v1/libraries/${libraryId}/entries`) {
      if (method === "POST") { saved = true; return reply({ entry: source() }, 201); }
      return reply({ entries: [...(saved ? [source()] : []), ...(imported ? [skill()] : [])], nextCursor: null });
    }
    if (path === "/v1/submissions/submission-library/bundle") return route.fulfill({ contentType: "application/json", body: submittedBundle });
    if (path === `/v1/library-entries/${skillEntryId}`) return reply({ entry: skill() });
    if (path.endsWith("/releases/0.0.1")) return reply({ release: { requiresUserAction: true, artifact: { sha256: submittedDigest } } });
    if (path.endsWith("/discoveries")) return reply({ discovery: { snapshot, complete: true, skills: [{ path: "skills/planner", directoryName: "planner", fileCount: 2, byteCount: 26, blockers: [], lineage: null }], excluded: [] } });
    if (path.endsWith("/previews")) return reply({ preview: { id: previewId, snapshot, expiresAt: "2027-09-26T00:00:00Z", candidates: [candidate()] } });
    if (path === `/v1/library-candidates/${candidateId}`) return reply({ candidate: candidate() });
    if (path.endsWith("/candidates")) return reply({ candidates: saved ? [candidate()] : [], nextCursor: null });
    if (path.endsWith("/import")) { imported = true; return reply({ candidate: candidate(), entry: skill(), submission: candidate().registry, scan: { status: "passed", findings: [] } }, 202); }
    if (path.endsWith("/self-review")) {
      if (!allowPrivateSelfReview) return reply({ error: { code: "PRIVATE_SELF_REVIEW_DISABLED", message: "Private self-review is disabled. Ask an instance reviewer to review this import." } }, 403);
      reviewed = true; return reply({ candidate: candidate(), release: adoption });
    }
    if (path.endsWith("/adoptions")) { adopted = true; return reply({ adoption, entry: skill() }, 201); }
    if (path.endsWith("/tracking")) { tracking = body.mode; return reply({ entry: source() }); }
    if (path.endsWith("/subscription")) { subscribed = method === "PUT"; return reply({ subscription: library().subscription }); }
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null, unreadCount: 0 });
    return reply({ error: { code: "NOT_FOUND", message: `Unimplemented browser fixture: ${method} ${path}` } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Libraries", exact: true })).toBeVisible();
  await page.getByLabel("Library name").fill("Planning tools");
  await page.getByRole("button", { name: "Create library", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Planning tools", exact: true })).toBeVisible();
  await page.getByLabel("GitHub source URL").fill("https://github.com/example/skills");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await page.getByRole("button", { name: "Discover skills", exact: true }).click();
  await page.getByLabel("Select skills/planner").focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Preview import", exact: true }).press("Enter");
  await expect(page.getByText(commit, { exact: true })).toBeVisible();
  await expect(page.getByText("LICENSE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Submit import for review", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Inspect submitted artifact", exact: true }).click();
  // Simulate the administrator switching policy after preview, before attestation.
  allowPrivateSelfReview = false;
  await page.getByLabel("I reviewed these files for my private use").check();
  await page.getByRole("button", { name: "Approve for my private use", exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Private self-review is disabled");
  allowPrivateSelfReview = true;
  await page.getByRole("button", { name: "Approve for my private use", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Adopt version", exact: true }).press("Enter");
  await expect(page.getByText("0.0.1", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Check frequency").selectOption("weekly");
  await page.getByRole("button", { name: "Save tracking", exact: true }).press("Enter");
  await page.getByLabel("Notify me about changes").check();
  await expect.poll(() => subscribed).toBe(true);
  expect(tracking).toBe("weekly");
  expect(writes.filter((w) => w.path.endsWith("/self-review"))).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Planning tools", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await testInfo.attach("library-journey-receipt", { body: JSON.stringify({ imported, adopted, tracking, subscribed, writes: writes.map((w) => w.path) }, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("libraries-mobile.png"), fullPage: true });
});

test("reviewer inspects the exact private artifact before approving it for sharing", async ({ page }) => {
  const { createHash } = await import("node:crypto");
  const user = { id: "review-owner", email: "reviewer@example.test", name: "Reviewer", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  const bundle = JSON.stringify({ files: [{ path: "SKILL.md", content: "Read the supplied example carefully." }] });
  const digest = createHash("sha256").update(bundle).digest("hex");
  let elevated = false;
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-26T00:00:00Z", user })), user);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (json: unknown) => route.fulfill({ json });
    if (path.endsWith("/me")) return reply({ user });
    if (path.endsWith("/teams")) return reply({ teams: [], invitations: [] });
    if (path.endsWith("/libraries")) return reply({ libraries: [], nextCursor: null });
    if (path.endsWith("/library-inbox")) return reply({ items: [], unreadCount: 0, nextCursor: null });
    if (path.endsWith("/library-settings")) return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null } });
    if (path.endsWith("/self-reviewed-releases")) return reply({ releases: elevated ? [] : [{ submissionId: "sub-review-1", slug: "planner-ab12cd", version: "0.0.1", artifactSha256: digest, selfReviewedAt: "2026-09-26T00:00:00Z", elevationRequestedAt: "2026-09-26T00:00:00Z" }] });
    if (path.endsWith("/bundle")) return route.fulfill({ contentType: "application/json", body: bundle, headers: { "x-myskills-artifact-sha256": digest } });
    if (path.endsWith("/elevate")) { expect(route.request().postDataJSON()).toEqual({ artifactSha256: digest }); elevated = true; return reply({ release: { attestation: "instance-reviewed" } }); }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  await page.goto("/libraries");
  await page.getByRole("button", { name: "Review sharing requests", exact: true }).click();
  const approve = page.getByRole("button", { name: "Approve artifact for sharing", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole("button", { name: "Inspect private artifact", exact: true }).click();
  await expect(page.getByLabel("Contents of SKILL.md")).toContainText("Read the supplied example carefully.");
  await page.getByLabel("I reviewed this artifact for shared use").check();
  await approve.click();
  await expect.poll(() => elevated).toBe(true);
  await expect(page.getByText("No sharing reviews requested.")).toBeVisible();
});

// Regression scenarios recorded before review fixes: preserve pasted refs;
// ignore mappings for deselected roots; refresh after a successful DELETE;
// inspect held candidates without contacting an unavailable provider; require
// exact artifact inspection before attestation; use the current adoption even
// when its entry is outside the loaded page; explicitly resolve target bindings.
test("source selection preserves a pasted ref, drops deselected mappings, and removes the saved entry", async ({ page }, testInfo) => {
  const libraryId = "regression-library";
  const entryId = "regression-source";
  const user = await libraryRegressionSession(page);
  let saved = false;
  let sourceBody: Record<string, unknown> | null = null;
  let previewBody: Record<string, unknown> | null = null;
  const library = regressionLibrary(user.id, libraryId);
  const source = { id: entryId, libraryId, kind: "source", title: "example/skills", revision: 1, source: { url: "https://github.com/example/skills", fullName: "example/skills", path: "skills", ref: { kind: "branch", value: "feature-plan" } }, tracking: { mode: "off", health: "not-tracked" }, adoption: null };
  const snapshot = { id: "snapshot-regression", commit: "a".repeat(40), orderStatus: "initial", complete: true };
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api", "");
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${libraryId}`) return reply({ library });
    if (path.endsWith("/entries")) {
      if (method === "POST") { sourceBody = route.request().postDataJSON(); saved = true; return reply({ entry: source }, 201); }
      if (url.searchParams.has("cursor")) return reply({ error: { code: "INVALID_PAGE_CURSOR" } }, 400);
      return reply({ entries: saved ? [source] : [], nextCursor: null });
    }
    if (path === `/v1/library-entries/${entryId}` && method === "DELETE") { saved = false; return reply({ removed: true }); }
    if (path.endsWith("/discoveries")) return reply({ discovery: { snapshot, complete: true, excluded: [], skills: ["planner", "notes"].map((name) => ({ path: `skills/${name}`, directoryName: name, fileCount: 1, byteCount: 30, blockers: [] })) } });
    if (path.endsWith("/candidates")) return reply({ candidates: [], nextCursor: null });
    if (path.endsWith("/previews")) { previewBody = route.request().postDataJSON(); return reply({ preview: { id: "preview-regression", candidates: [] } }); }
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: false } });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("GitHub source URL").fill("https://github.com/example/skills/tree/feature-plan/skills");
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await expect(page.getByLabel("Select skills/notes")).toBeVisible();
  expect(sourceBody).not.toHaveProperty("ref");
  const notes = page.locator(".library-inset").filter({ has: page.getByLabel("Select skills/notes") });
  await notes.getByLabel("Select skills/notes").check();
  await notes.getByText("Metadata mapping", { exact: true }).click();
  await notes.getByLabel("Short summary").fill("Mapped notes summary");
  await notes.getByLabel("Select skills/notes").uncheck();
  await page.getByLabel("Select skills/planner").check();
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await expect.poll(() => previewBody).not.toBeNull();
  expect(previewBody).toMatchObject({ paths: ["skills/planner"] });
  expect((previewBody as Record<string, unknown> | null)?.mappings ?? {}).not.toHaveProperty("skills/notes");
  await page.getByRole("button", { name: "Close import", exact: true }).click();
  await page.getByRole("button", { name: "Remove entry", exact: true }).click();
  await page.getByRole("button", { name: "Confirm remove", exact: true }).click();
  await expect(page.getByText("No entries yet. Save a source to discover its skills.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await testInfo.attach("source-selection-receipt", { body: JSON.stringify({ sourceBody, previewBody, removed: !saved }), contentType: "application/json" });
});

test("saved candidates remain reviewable offline and attestation requires the exact submitted artifact", async ({ page }, testInfo) => {
  const { createHash } = await import("node:crypto");
  const user = await libraryRegressionSession(page);
  const libraryId = "offline-library";
  const entryId = "offline-source";
  const skillEntryId = "older-skill-entry";
  const candidateId = "held-candidate";
  const bundle = JSON.stringify({ files: [{ path: "SKILL.md", content: "Review this saved artifact.\n" }] });
  const digest = createHash("sha256").update(bundle).digest("hex");
  let approved = false;
  let adopted = false;
  let providerCalls = 0;
  let inspected = false;
  let tampered = true;
  let moreLoaded = false;
  const library = regressionLibrary(user.id, libraryId);
  const candidate = () => ({ id: candidateId, sourceEntryId: entryId, skillEntryId, lineage: { slug: "planner-1234567890", nativeName: "planner" }, state: "accepted", sourcePath: "skills/planner", snapshot: { orderStatus: "initial" }, mapping: { title: "Saved planner", license: "MIT" }, expectedVersion: "0.0.2", packageDigest: digest, files: [{ path: "SKILL.md", bytes: 27 }], findings: [], expiresAt: "2020-01-01T00:00:00Z", registry: { submissionId: "saved-submission", version: "0.0.2", reviewStatus: approved ? "approved" : "unreviewed", securityStatus: "passed", attestation: approved ? "private-self-reviewed" : null } });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname.replace("/api", "");
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${libraryId}`) return reply({ library });
    if (path.endsWith("/entries")) return reply({ entries: [{ id: entryId, libraryId, kind: "source", title: "example/offline", source: { url: "https://github.com/example/offline", fullName: "example/offline", ref: { kind: "default-branch" } }, tracking: { health: "unavailable", mode: "manual" } }], nextCursor: null });
    if (path.endsWith("/discoveries")) { providerCalls++; return reply({ error: { code: "SOURCE_UNAVAILABLE" } }, 503); }
    if (path.endsWith("/candidates")) { if (url.searchParams.has("cursor")) { moreLoaded = true; return reply({ candidates: [], nextCursor: null }); } return reply({ candidates: [candidate()], nextCursor: "next-page" }); }
    if (path === "/v1/submissions/saved-submission/bundle") { if (!tampered) inspected = true; return route.fulfill({ contentType: "application/json", body: tampered ? bundle.replace("Review", "Forged") : bundle }); }
    if (path.endsWith("/self-review")) { expect(inspected).toBe(true); approved = true; return reply({ candidate: candidate() }); }
    if (path === `/v1/library-entries/${skillEntryId}`) return reply({ entry: { id: skillEntryId, adoption: { id: "prior-adoption", version: "0.0.1" } } });
    if (path.endsWith("/adoptions")) { expect(route.request().postDataJSON()).toMatchObject({ expectedCurrentAdoptionId: "prior-adoption", version: "0.0.2" }); adopted = true; return reply({ adoption: { id: "next-adoption" } }, 201); }
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true } });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Review candidates", exact: true }).click();
  const attestation = page.getByLabel("I reviewed these files for my private use");
  await expect(attestation).toBeDisabled();
  await page.getByRole("button", { name: "Inspect submitted artifact", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(attestation).toBeDisabled();
  tampered = false;
  await page.getByRole("button", { name: "Inspect submitted artifact", exact: true }).click();
  await expect(page.getByLabel("Contents of SKILL.md")).toContainText("Review this saved artifact.");
  await attestation.check();
  await page.getByRole("button", { name: "Approve for my private use", exact: true }).click();
  await page.getByRole("button", { name: "Adopt version", exact: true }).click();
  await expect.poll(() => adopted).toBe(true);
  await page.getByRole("button", { name: "More candidates", exact: true }).click();
  await expect.poll(() => moreLoaded).toBe(true);
  expect(providerCalls).toBe(0);
  await testInfo.attach("offline-review-receipt", { body: JSON.stringify({ providerCalls, inspected, approved, adopted, moreLoaded }), contentType: "application/json" });
});

test("adopted release guidance and target binding conflicts can be resolved explicitly", async ({ page }, testInfo) => {
  const user = await libraryRegressionSession(page);
  const libraryId = "binding-library"; const entryId = "binding-entry";
  const library = regressionLibrary(user.id, libraryId);
  let replaced = false; let detached = false;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", ""); const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${libraryId}`) return reply({ library });
    if (path.endsWith("/entries")) return reply({ entries: [{ id: entryId, libraryId, kind: "skill", title: "Planner", skill: { slug: "planner-1234567890", ownership: { isCaller: true } }, adoption: { id: "adoption-1", version: "0.0.1", artifactSha256: "a".repeat(64), attestation: "private-self-reviewed" } }], nextCursor: null });
    if (path.endsWith("/releases/0.0.1")) return reply({ release: { requiresUserAction: true, artifact: { sha256: "a".repeat(64) } } });
    if (path.endsWith("/bindings")) {
      if (method === "POST") { const body = route.request().postDataJSON(); if (!body.replaceConflicting) return reply({ error: { code: "BINDING_VERSION_CONFLICT" } }, 409); replaced = true; return reply({ binding: { id: "new-binding" } }); }
      return reply({ bindings: replaced && !detached ? [{ id: "new-binding", targetId: "personal-target", status: "active", pinnedVersion: "0.0.1" }] : [] });
    }
    if (path === "/v1/library-bindings/new-binding" && method === "DELETE") { detached = true; return reply({ detached: true }); }
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true } });
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(".library-command")).toContainText("--accept-user-action");
  await page.getByText("Connect an existing target", { exact: true }).click();
  await page.getByLabel("Target ID").fill("personal-target");
  await page.getByRole("button", { name: "Bind target", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("different library version");
  expect(replaced).toBe(false);
  await page.getByRole("button", { name: "Replace conflicting binding", exact: true }).click();
  await expect(page.getByText("personal-target", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Detach binding", exact: true }).click();
  expect(detached).toBe(false);
  await page.getByRole("button", { name: "Confirm detach binding", exact: true }).click();
  await expect.poll(() => detached).toBe(true);
  await testInfo.attach("binding-receipt", { body: JSON.stringify({ replaced, detached }), contentType: "application/json" });
});

async function libraryRegressionSession(page: import("@playwright/test").Page) {
  const user = { id: "regression-owner", email: "regression@example.test", name: "Regression owner", status: "active", roles: ["owner"], emailVerified: true, mfaVerified: true };
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-26T00:00:00Z", user })), user);
  return user;
}

function regressionLibrary(ownerId: string, id: string) {
  return { id, name: "Regression tools", description: "", owner: { type: "user", id: ownerId }, revision: 1, access: { canWrite: true, canImport: true, canTrackSources: true, role: "owner" }, subscription: null };
}

// Failure targets recorded before identity acknowledgement UI: an off/on toggle
// bypasses review, a stale acknowledgement survives a newer transfer, or checks
// resume before explicit confirmation of the observed repository.
test("source identity review survives pausing and requires fresh acknowledgement after a conflict", async ({ page }, testInfo) => {
  const user = { id: "identity-owner", email: "identity@example.test", name: "Identity owner", status: "active", roles: ["author"], emailVerified: true, mfaVerified: true };
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ expiresAt: "2027-09-26T00:00:00Z", user })), user);
  const library = { id: "identity-library", name: "Source trust", description: "", owner: { type: "user", id: user.id }, revision: 1, access: { canWrite: true, canImport: true, canTrackSources: true, role: "owner" }, subscription: null };
  let revision = 2;
  let mode = "weekly";
  let observed = "new-owner/skills";
  let pending = true;
  let conflict = true;
  const writes: unknown[] = [];
  const entry = () => ({ id: "identity-source", libraryId: library.id, kind: "source", title: "original/skills", revision, adoption: null, source: { fullName: observed, url: `https://github.com/${observed}`, path: "", ref: { kind: "default-branch" } }, tracking: { mode, health: pending ? "identity-change-review" : "healthy", workerAvailable: true, lastSuccessfulCheckAt: null, nextCheckAt: null, identityChange: pending ? { acknowledgedFullName: "original/skills", observedFullName: observed, observedUrl: `https://github.com/${observed}` } : null } });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${library.id}`) return reply({ library });
    if (path === `/v1/libraries/${library.id}/entries`) return reply({ entries: [entry()], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null, unreadCount: 0 });
    if (path.endsWith("/tracking")) {
      const body = route.request().postDataJSON(); writes.push(body);
      expect(body.expectedRevision).toBe(revision);
      if (body.mode === "off") { expect(body.acknowledgeIdentityChange).toBeUndefined(); mode = "off"; revision++; return reply({ entry: entry() }); }
      expect(body.acknowledgeIdentityChange).toBe(true);
      if (conflict) { conflict = false; observed = "final-owner/skills"; revision++; return reply({ error: { code: "LIBRARY_REVISION_CONFLICT", message: "Entry changed." } }, 409); }
      mode = body.mode; pending = false; revision++; return reply({ entry: entry() });
    }
    return reply({ error: { code: "NOT_FOUND", message: `Unimplemented fixture: ${path}` } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  const reviewed = page.getByLabel("I reviewed the repository identity change");
  await expect(reviewed).toBeVisible();
  await expect(page.getByText("Previously trusted: original/skills", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review new-owner/skills", exact: true })).toHaveAttribute("href", "https://github.com/new-owner/skills");
  await expect(page.getByRole("button", { name: "Check now", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save tracking", exact: true })).toBeDisabled();
  await page.getByLabel("Check frequency").selectOption("off");
  await page.getByRole("button", { name: "Save tracking", exact: true }).click();
  await expect.poll(() => mode).toBe("off");
  await expect(page.getByRole("button", { name: "Save tracking", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Check frequency")).toHaveValue("off");
  await expect(reviewed).not.toBeChecked();
  await page.getByLabel("Check frequency").selectOption("weekly");
  await expect(page.getByRole("button", { name: "Save tracking", exact: true })).toBeDisabled();
  await reviewed.check();
  await page.getByRole("button", { name: "Save tracking", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Refresh");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review final-owner/skills", exact: true })).toBeVisible();
  await expect(reviewed).not.toBeChecked();
  await page.getByLabel("Check frequency").selectOption("weekly");
  await reviewed.check();
  await page.getByRole("button", { name: "Save tracking", exact: true }).click();
  await expect(reviewed).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check now", exact: true })).toBeEnabled();
  expect(pending).toBe(false); expect(mode).toBe("weekly"); expect(writes).toHaveLength(3);
  await testInfo.attach("identity-review-receipt", { body: JSON.stringify({ outcome: "pass", staleAcknowledgementRejected: true, observed, writes }), contentType: "application/json" });
});

// A shared observation's order is not the same as each imported lineage's order.
// Failure targets: missing required acknowledgement or sending it when inapplicable.
test("import acknowledgement follows each candidate's lineage order", async ({ page }, testInfo) => {
  const user = await libraryRegressionSession(page);
  const library = regressionLibrary(user.id, "order-library");
  const source = { id: "order-source", libraryId: library.id, kind: "source", title: "example/skills", revision: 1, source: { url: "https://github.com/example/skills", fullName: "example/skills", path: "skills", ref: { kind: "default-branch" } }, tracking: { mode: "manual", health: "healthy", identityChange: null }, adoption: null };
  const candidates = ["uncertain", "forward"].map((name) => ({ id: name, sourceEntryId: source.id, skillEntryId: null, lineage: { slug: `${name}-1234567890`, nativeName: name }, state: "ready-for-review", sourcePath: `skills/${name}`, snapshot: { orderStatus: name === "uncertain" ? "ahead" : "unverified" }, orderStatus: name === "uncertain" ? "unverified" : "ahead", mapping: { title: name, license: "MIT" }, expectedVersion: "0.0.2", packageDigest: "a".repeat(64), files: [], findings: [], expiresAt: "2027-09-26T00:00:00Z", registry: null }));
  const imports: Array<{ id: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${library.id}`) return reply({ library });
    if (path.endsWith("/entries")) return reply({ entries: [source], nextCursor: null });
    if (path.endsWith("/candidates")) return reply({ candidates, nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: false } });
    if (path.endsWith("/import")) {
      const candidate = candidates.find((item) => path.includes(`/${item.id}/`))!;
      const body = route.request().postDataJSON(); imports.push({ id: candidate.id, body });
      if (candidate.id === "uncertain") expect(body.acknowledgeUnverifiedOrder).toEqual({ reason: "Reviewed the source history and selected this revision." });
      else expect(body).not.toHaveProperty("acknowledgeUnverifiedOrder");
      return reply({ candidate: { ...candidate, state: "accepted" } });
    }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Review candidates", exact: true }).click();
  const uncertain = page.getByRole("article", { name: "Import skills/uncertain", exact: true });
  const forward = page.getByRole("article", { name: "Import skills/forward", exact: true });
  await expect(uncertain.getByRole("button", { name: "Submit import for review", exact: true })).toBeDisabled();
  await expect(forward.getByLabel("Reason for accepting unverified source order")).toHaveCount(0);
  await uncertain.getByLabel("Reason for accepting unverified source order").fill("Reviewed the source history and selected this revision.");
  await uncertain.getByRole("button", { name: "Submit import for review", exact: true }).click();
  await forward.getByRole("button", { name: "Submit import for review", exact: true }).click();
  await expect.poll(() => imports.length).toBe(2);
  await testInfo.attach("lineage-order-receipt", { body: JSON.stringify({ outcome: "pass", imports }), contentType: "application/json" });
});

// Failure targets before the policy-toggle fix: the checkbox reverses while a
// save is pending, or a lost response leaves a stale security-policy display.
test("private-import policy keeps a pending choice and rereads an uncertain write", async ({ page }, testInfo) => {
  const user = await libraryRegressionSession(page);
  let enabled = false;
  let first = true;
  let release: (() => void) | undefined;
  testInfo.setTimeout(30_000);
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/review/self-reviewed-releases") return reply({ releases: [] });
    if (path === "/v1/admin/library-settings") {
      if (route.request().method() === "PUT") {
        enabled = route.request().postDataJSON().privateSelfReviewEnabled;
        if (first) { first = false; await new Promise<void>((resolve) => { release = resolve; }); return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Response unavailable after policy save." } }, 503); }
      }
      return reply({ settings: { privateSelfReviewEnabled: enabled } });
    }
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  const policy = page.getByLabel("Allow private import self-review");
  await expect(policy).not.toBeChecked();
  const attempt = policy.check().then(() => null, (error: unknown) => error);
  await expect.poll(() => Boolean(release)).toBe(true);
  try { await expect(policy).toBeChecked(); await expect(policy).toBeDisabled(); } finally { release!(); }
  expect(await attempt).toBeNull();
  await expect(page.getByRole("alert")).toContainText("The current policy was reloaded and matches your choice.");
  await expect(policy).toBeEnabled();
  await expect(policy).toBeChecked();
  await policy.uncheck();
  await expect(policy).toBeEnabled();
  await expect(policy).not.toBeChecked();
  expect(enabled).toBe(false);
  await testInfo.attach("policy-toggle-receipt", { body: JSON.stringify({ outcome: "pass", uncertainWriteReread: true, finalPrivateSelfReviewEnabled: enabled }), contentType: "application/json" });
});

// Written before the normalization UI: import must not conceal a runtime rename,
// confuse the source and installed digests, or hide the preserved original file.
test("import preview explains the installed name and preserves inspectable source evidence", async ({ page }, testInfo) => {
  const { createHash } = await import("node:crypto");
  const user = await libraryRegressionSession(page);
  const library = regressionLibrary(user.id, "normalized-library");
  const source = { id: "normalized-source", libraryId: library.id, kind: "source", title: "example/skills", revision: 1, source: { url: "https://github.com/example/skills", fullName: "example/skills", path: "skills", ref: { kind: "default-branch" } }, tracking: { mode: "manual", health: "healthy", identityChange: null }, adoption: null };
  const original = "---\r\nname: planner\r\ndescription: Plan carefully.\r\n---\r\nKeep this body.\r\n";
  const runtimeName = "planner-ab12cd34ef";
  const installed = original.replace("name: planner\r\n", `name: ${runtimeName}\r\n`);
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const transform = { kind: "normalize-runtime-name", path: "SKILL.md", originalPath: "myskills-source-skill.txt", originalSha256: digest(original), transformedSha256: digest(installed), originalName: "planner", runtimeName };
  const files = [{ path: "SKILL.md", content: installed }, { path: transform.originalPath, content: original }].map((file) => ({ ...file, bytes: Buffer.byteLength(file.content), sha256: digest(file.content) }));
  const candidate = { id: "normalized-candidate", sourceEntryId: source.id, skillEntryId: null, lineage: { slug: runtimeName, nativeName: "planner" }, state: "ready-for-review", sourcePath: "skills/planner", snapshot: { orderStatus: "initial" }, orderStatus: "initial", mapping: { title: "Planner", slug: runtimeName, license: "MIT", transforms: [transform] }, expectedVersion: "0.0.1", packageDigest: digest(JSON.stringify({ files })), files, findings: [], expiresAt: "2027-09-26T00:00:00Z", registry: null };
  let submittedDigest: string | null = null;
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api", "");
    const reply = (json: unknown) => route.fulfill({ json });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/libraries") return reply({ libraries: [library], nextCursor: null });
    if (path === `/v1/libraries/${library.id}`) return reply({ library });
    if (path.endsWith("/entries")) return reply({ entries: [source], nextCursor: null });
    if (path.endsWith("/candidates")) return reply({ candidates: [candidate], nextCursor: null });
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: false } });
    if (path.endsWith("/import")) {
      submittedDigest = route.request().postDataJSON().expectedPackageDigest;
      return reply({ candidate: { ...candidate, state: "accepted" } });
    }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  await page.goto("/libraries");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Review candidates", exact: true }).click();
  const preview = page.getByRole("article", { name: "Import skills/planner", exact: true });
  const normalization = preview.getByRole("region", { name: "Installed skill name", exact: true });
  await expect(normalization.getByText(runtimeName, { exact: true })).toBeVisible();
  await expect(normalization.getByText("planner", { exact: true })).toBeVisible();
  await expect(normalization.getByText(transform.originalPath, { exact: true })).toBeVisible();
  await normalization.getByText("Original and installed file digests", { exact: true }).click();
  await expect(normalization.getByText(transform.originalSha256, { exact: true })).toBeVisible();
  await expect(normalization.getByText(transform.transformedSha256, { exact: true })).toBeVisible();
  const preservedFile = preview.locator(".library-files > li").filter({ hasText: transform.originalPath });
  await preservedFile.locator("summary").click();
  await expect(preservedFile.locator("pre")).toHaveText(original);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("normalized-import-mobile.png"), fullPage: true });
  await preview.getByRole("button", { name: "Submit import for review", exact: true }).click();
  await expect.poll(() => submittedDigest).toBe(candidate.packageDigest);
  await testInfo.attach("normalized-import-receipt", { body: JSON.stringify({ outcome: "pass", transform, submittedDigest, originalInspectable: true }), contentType: "application/json" });
});
