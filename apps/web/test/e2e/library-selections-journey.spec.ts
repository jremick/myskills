import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

async function receipt(testInfo: TestInfo, name: string, value: Record<string, unknown>) {
  const path = testInfo.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path, contentType: "application/json" });
}

// Written before the UI. This is presentation/transport evidence using a
// synthetic API. API/Postgres journeys own permission and persistence proof.
// Failure targets: second-page skills or members disappear; overlapping groups
// overwrite each other; stale edits retry blindly; denied writes lose input;
// readers retain mutation controls; a library switch retains selected members.
async function setup(page: Page) {
  const stamp = "2026-09-30T00:00:00Z";
  const user = { id: "curator", email: "curator@example.test", name: "Curator", status: "active", roles: ["author"], emailVerified: true, mfaVerified: true };
  const state = { writable: true, rejectMfa: false, conflict: false, failList: false, serial: 0 };
  const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const library = (id = "engineering") => ({ id, name: id === "engineering" ? "Engineering" : "Personal picks", description: "", owner: { type: "team", id: "team", name: "Engineering team" }, status: "active", revision: 1, access: { role: state.writable ? "curator" : "member", canWrite: state.writable, canImport: state.writable, canTrackSources: state.writable }, subscription: null, createdAt: stamp, updatedAt: stamp });
  const sources = ["acme/skills", "other/skills"].map((name, i) => ({ id: `source-${i}`, libraryId: "engineering", kind: "source", status: "active", title: name, revision: 1, source: { provider: "github", fullName: name, url: `https://github.com/${name}`, path: "", ref: { kind: "default-branch" }, license: "MIT" }, tracking: { mode: "weekly", health: "healthy", nextCheckAt: stamp, lastSuccessfulCheckAt: stamp, identityChange: null }, adoption: null }));
  const skills = Array.from({ length: 52 }, (_, i) => ({ id: `skill-${i + 1}`, libraryId: "engineering", kind: "skill", status: "active", title: `Skill ${String(i + 1).padStart(2, "0")}`, revision: 1, skill: { slug: `skill-${i + 1}`, sourceEntryId: sources[i % 2]!.id, sourcePath: `skills/${i + 1}`, lineageId: `lineage-${i + 1}` }, adoption: null }));
  const entries = [...skills, ...sources];
  type Selection = { id: string; libraryId: string; name: string; description: string; status: string; revision: number; memberEntryIds: string[]; createdAt: string; updatedAt: string };
  const selections: { collections: Selection[]; groups: Selection[] } = { collections: [], groups: [] };
  const summary = (item: Selection, kind: "collections" | "groups") => ({ ...item, memberCount: item.memberEntryIds.length, ...(kind === "collections" ? { tracking: { sourceEntryIds: ["source-0", "source-1"], health: "healthy", pendingCandidateCount: state.writable ? 2 : 0, lastSuccessfulCheckAt: stamp, nextCheckAt: stamp } } : {}) });
  await page.addInitScript((user) => localStorage.setItem("myskills-app:web-session", JSON.stringify({ user, expiresAt: "2027-09-30T00:00:00Z" })), user);
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api", "");
    const method = route.request().method();
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (method !== "GET") writes.push({ path, method, body });
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [], invitations: [] });
    if (path === "/v1/library-inbox") return reply({ items: [], nextCursor: null });
    if (path === "/v1/libraries") return reply({ libraries: [library(), library("personal")], nextCursor: null });
    if (path === "/v1/libraries/engineering" || path === "/v1/libraries/personal") return reply({ library: library(path.split("/").at(-1)) });
    if (path.endsWith("/entries")) return reply({ entries: path.includes("personal") ? [] : url.searchParams.has("cursor") ? entries.slice(50) : entries.slice(0, 50), nextCursor: path.includes("personal") || url.searchParams.has("cursor") ? null : "next-entries" });
    if (path.startsWith("/v1/library-entries/")) {
      if (path.endsWith("/candidates")) return reply({ candidates: [], nextCursor: null });
      return reply({ entry: entries.find((entry) => path.endsWith(`/${entry.id}`)) });
    }
    const list = path.match(/^\/v1\/libraries\/([^/]+)\/(collections|groups)$/);
    const detail = path.match(/^\/v1\/library-(collections|groups)\/([^/]+)(\/members)?$/);
    if (list || detail) {
      const kind = (list?.[2] ?? detail?.[1]) as "collections" | "groups";
      const singular = kind === "collections" ? "collection" : "group";
      if (method !== "GET" && state.rejectMfa) return reply({ error: { code: "MFA_VERIFICATION_REQUIRED" } }, 403);
      if (method !== "GET" && !state.writable) return reply({ error: { code: "LIBRARY_WRITE_FORBIDDEN" } }, 403);
      if (list) {
        if (method === "GET") {
          if (state.failList) return reply({ error: { code: "UNAVAILABLE" } }, 503);
          const rows = selections[kind].filter((item) => item.libraryId === list[1]);
          const offset = url.searchParams.has("cursor") ? 1 : 0;
          return reply({ [kind]: rows.slice(offset, offset ? undefined : 1).map((item) => summary(item, kind)), nextCursor: !offset && rows.length > 1 ? "next-selections" : null });
        }
        const created = { id: `${singular}-${++state.serial}`, libraryId: list[1]!, name: String(body.name), description: String(body.description ?? ""), memberEntryIds: body.memberEntryIds as string[], revision: 1, status: "active", createdAt: stamp, updatedAt: stamp };
        selections[kind].push(created);
        return reply({ [singular]: summary(created, kind), replayed: false }, 201);
      }
      const item = selections[kind].find((item) => item.id === detail![2]);
      if (!item) return reply({ error: { code: `LIBRARY_${singular.toUpperCase()}_NOT_FOUND` } }, 404);
      if (detail![3]) {
        const offset = url.searchParams.has("cursor") ? 1 : 0;
        return reply({ members: item.memberEntryIds.slice(offset, offset ? undefined : 1).map((id, index) => ({ entry: entries.find((entry) => entry.id === id), position: offset + index })), nextCursor: !offset && item.memberEntryIds.length > 1 ? "next-members" : null });
      }
      if (method === "GET") return reply({ [singular]: summary(item, kind) });
      const revision = method === "DELETE" ? Number(url.searchParams.get("expectedRevision")) : body.expectedRevision;
      if (state.conflict) { state.conflict = false; item.name = "Updated by teammate"; item.revision++; }
      if (revision !== item.revision) return reply({ error: { code: `LIBRARY_${singular.toUpperCase()}_REVISION_CONFLICT` } }, 409);
      if (method === "DELETE") { selections[kind] = selections[kind].filter((row) => row !== item); return reply({ [singular]: { id: item.id, status: "deleted" } }); }
      Object.assign(item, { name: body.name, description: body.description, memberEntryIds: body.memberEntryIds, revision: item.revision + 1 });
      return reply({ [singular]: summary(item, kind) });
    }
    return reply({ error: { code: "NOT_FOUND" } }, 404);
  });
  return { state, writes, selections, entries };
}

test("collections and overlapping groups retain all members, recover stale edits, and delete only the set", async ({ page }, testInfo) => {
  const fixture = await setup(page);
  await page.goto("/libraries");
  await page.getByRole("button", { name: "Collections", exact: true }).click();
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await expect(page.getByLabel("Collection name", { exact: true })).toBeFocused();
  await page.getByLabel("Collection name", { exact: true }).fill("Release toolkit");
  await page.getByLabel("Select Skill 01", { exact: true }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Load more skills", exact: true }).click();
  await page.getByLabel("Select Skill 52", { exact: true }).check();
  await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release toolkit", exact: true })).toBeVisible();
  await expect(page.getByText("2 pending changes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more members", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Skill 52", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View source: acme/skills", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("collection-tracking-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "View source: acme/skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "acme/skills", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review candidates", exact: true })).toBeVisible();
  for (const [name, second] of [["Reviews", "Skill 02"], ["Delivery", "Skill 03"]]) {
    await page.getByRole("button", { name: "Groups", exact: true }).click();
    await page.getByRole("button", { name: "New group", exact: true }).click();
    await page.getByLabel("Group name", { exact: true }).fill(name!);
    await page.getByLabel("Select Skill 01", { exact: true }).check();
    await page.getByLabel(`Select ${second}`, { exact: true }).check();
    await page.getByRole("button", { name: "Create group", exact: true }).click();
    await expect(page.getByRole("heading", { name: name!, exact: true })).toBeVisible();
  }
  expect(fixture.selections.groups.map((item) => item.memberEntryIds)).toEqual([["skill-1", "skill-2"], ["skill-1", "skill-3"]]);
  await page.getByRole("button", { name: "Back to groups", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Reviews", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View Delivery", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load more groups", exact: true }).click();
  await page.getByRole("button", { name: "View Delivery", exact: true }).click();
  await page.getByRole("button", { name: "Edit group", exact: true }).click();
  // Editing must walk all member pages before replacement can be saved.
  await expect(page.getByLabel("Select Skill 03", { exact: true })).toBeChecked();
  await page.getByLabel("Group name", { exact: true }).fill("Stale change");
  fixture.state.conflict = true;
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await expect(page.getByRole("button", { name: "Save group", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh group", exact: true }).click();
  await page.getByRole("button", { name: "Edit group", exact: true }).click();
  await expect(page.getByLabel("Group name", { exact: true })).toHaveValue("Updated by teammate");
  await page.getByLabel("Group name", { exact: true }).fill("Delivery revised");
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Delivery revised", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("group-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Delete group", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete group", exact: true }).click();
  await expect(page.getByRole("button", { name: "View Reviews", exact: true })).toBeVisible();
  expect(fixture.selections.collections).toHaveLength(1);
  expect(fixture.selections.groups).toHaveLength(1);
  expect(fixture.entries).toHaveLength(54);
  expect(fixture.writes.every((item) => /library-(collections|groups)|libraries\/engineering\/(collections|groups)/.test(item.path))).toBe(true);
  await receipt(testInfo, "selection-ui-receipt", { boundary: "synthetic API browser journey", allMemberPagesPreserved: true, staleEditRecovered: true, writes: fixture.writes });
});

test("selection errors preserve inputs, reader refresh removes writes, and switching libraries clears selection", async ({ page }, testInfo) => {
  const fixture = await setup(page);
  fixture.state.failList = true;
  await page.goto("/libraries?library=engineering&view=collections");
  await expect(page.getByRole("alert")).toBeVisible();
  fixture.state.failList = false;
  await page.getByRole("button", { name: "Refresh collections", exact: true }).click();
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await page.getByLabel("Collection name", { exact: true }).fill("Careful picks");
  await page.getByLabel("Select Skill 01", { exact: true }).check();
  fixture.state.rejectMfa = true;
  await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Verify MFA");
  await expect(page.getByLabel("Collection name", { exact: true })).toHaveValue("Careful picks");
  fixture.state.rejectMfa = false;
  await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Careful picks", exact: true })).toBeVisible();
  expect(fixture.writes[0]!.body.clientMutationId).toBe(fixture.writes[1]!.body.clientMutationId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Careful picks", exact: true })).toBeVisible();
  fixture.state.writable = false;
  await page.getByRole("button", { name: "Refresh collection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit collection", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete collection", exact: true })).toHaveCount(0);
  await expect(page.getByText("2 pending changes", { exact: true })).toHaveCount(0);
  fixture.state.writable = true;
  await page.getByRole("button", { name: "Personal picks", exact: false }).click();
  await page.getByRole("button", { name: "Groups", exact: true }).click();
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await expect(page.getByLabel("Group name", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Select Skill 01", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await page.getByLabel("Group name", { exact: true }).fill("Permission changed");
  fixture.state.writable = false;
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Only the library owner or a team curator");
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New group", exact: true })).toHaveCount(0);
  await receipt(testInfo, "selection-recovery-receipt", { boundary: "synthetic API browser journey", deniedWritePreserved: true, mutationIdRetried: true, readerRefresh: true, librarySwitchCleared: true, revokedCreateControlsRemoved: true });
});
