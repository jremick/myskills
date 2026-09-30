import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Authored before the selection implementation. Real browser, API and Postgres;
// no intercepted responses. Detect lost membership on reload, overlap damage,
// stale overwrite, deletion of underlying entries, and changed adoption pins.
test("Library collections and overlapping groups persist without changing adopted skills", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const token = process.env.MYSKILLS_ACCEPTANCE_OWNER_TOKEN;
  const baseURL = process.env.MYSKILLS_E2E_BASE_URL;
  if (!token || !baseURL) throw new Error("The disposable full-stack owner session is required.");
  // APIRequestContext does not add the Origin sent by browser fetch. Keep the
  // real cookie/CSRF boundary for fixture writes and the stale-write probe.
  const mutationHeaders = { origin: new URL(baseURL).origin };
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.name));
  await page.context().addCookies([{ name: "myskills_session", value: token, url: baseURL, httpOnly: true, secure: true, sameSite: "Lax" }]);
  const me = await page.request.get(`${baseURL}/api/v1/me`);
  expect(me.status()).toBe(200);
  const { user } = await me.json();
  await page.addInitScript((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user, expiresAt: new Date(Date.now() + 300_000).toISOString() });

  const suffix = randomUUID().slice(0, 8);
  const releaseResponse = await page.request.get(`${baseURL}/api/v1/skills/release-notes-helper/releases/0.1.0`);
  expect(releaseResponse.status()).toBe(200);
  const { release } = await releaseResponse.json();
  const libraries: { id: string; entry: { id: string; title: string; adoption: unknown } }[] = [];
  for (const name of [`Organized skills ${suffix}`, `Independent skills ${suffix}`]) {
    const created = await page.request.post(`${baseURL}/api/v1/libraries`, { headers: mutationHeaders, data: { name, owner: { type: "user" }, clientMutationId: randomUUID() } });
    expect(created.status()).toBe(201);
    const { library } = await created.json();
    const saved = await page.request.post(`${baseURL}/api/v1/libraries/${library.id}/entries`, { headers: mutationHeaders, data: { kind: "skill", slug: "release-notes-helper", clientMutationId: randomUUID() } });
    expect(saved.status()).toBe(201);
    const { entry } = await saved.json();
    const adopted = await page.request.post(`${baseURL}/api/v1/library-entries/${entry.id}/adoptions`, { headers: mutationHeaders, data: { version: "0.1.0", artifactSha256: release.artifact.sha256, expectedCurrentAdoptionId: null, reason: "Retain this pin while organizing skills." } });
    expect(adopted.status()).toBe(201);
    const readback = await page.request.get(`${baseURL}/api/v1/library-entries/${entry.id}`);
    expect(readback.status()).toBe(200);
    libraries.push({ id: library.id, entry: (await readback.json()).entry });
  }
  const [library, independent] = libraries;
  await page.goto(`/libraries?library=${library.id}`);
  await expect(page.getByRole("heading", { name: `Organized skills ${suffix}`, exact: true })).toBeVisible();

  const selectionIds: Record<string, string> = {};
  for (const [kind, name] of [["collection", `Release work ${suffix}`], ["group", `Writing ${suffix}`], ["group", `Launch ${suffix}`]] as const) {
    await page.getByRole("button", { name: kind === "collection" ? "Collections" : "Groups", exact: true }).click();
    await page.getByRole("button", { name: `New ${kind}`, exact: true }).click();
    await page.getByLabel(kind === "collection" ? "Collection name" : "Group name", { exact: true }).fill(name);
    await page.getByRole("checkbox", { name: `Select ${library.entry.title}`, exact: true }).check();
    const response = page.waitForResponse((item) => item.url().includes(`/libraries/${library.id}/${kind}s`) && item.request().method() === "POST");
    await page.getByRole("button", { name: `Create ${kind}`, exact: true }).click();
    const created = await response;
    expect(created.status()).toBe(201);
    selectionIds[name] = (await created.json())[kind].id;
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }

  const collectionId = selectionIds[`Release work ${suffix}`];
  const writingId = selectionIds[`Writing ${suffix}`];
  const launchId = selectionIds[`Launch ${suffix}`];
  await expect(page).toHaveURL(new RegExp(`group=${launchId}`));
  await page.reload();
  await expect(page.getByRole("heading", { name: `Launch ${suffix}`, exact: true })).toBeVisible();
  await expect(page.getByText(library.entry.title, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit group", exact: true }).click();
  await page.getByLabel("Group name", { exact: true }).fill(`Launch ready ${suffix}`);
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Launch ready ${suffix}`, exact: true })).toBeVisible();
  const stale = await page.request.patch(`${baseURL}/api/v1/library-groups/${launchId}`, { headers: mutationHeaders, data: { expectedRevision: 1, name: "Stale overwrite", memberEntryIds: [] } });
  expect(stale.status()).toBe(409);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("persistent-group-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const [kind, id] of [["collection", collectionId], ["group", writingId]] as const) {
    await page.goto(`/libraries?library=${library.id}&view=${kind}s&${kind}=${id}`);
    await page.getByRole("button", { name: `Delete ${kind}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: `Delete ${kind}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => (await page.request.get(`${baseURL}/api/v1/library-${kind}s/${id}`)).status()).toBe(404);
  }
  const membersResponse = await page.request.get(`${baseURL}/api/v1/library-groups/${launchId}/members`);
  expect(membersResponse.status()).toBe(200);
  const { members } = await membersResponse.json();
  expect(members.map((member: { entry: { id: string }; position: number }) => ({ id: member.entry.id, position: member.position }))).toEqual([{ id: library.entry.id, position: 0 }]);
  for (const saved of [library, independent]) {
    const entriesResponse = await page.request.get(`${baseURL}/api/v1/libraries/${saved.id}/entries`);
    expect(entriesResponse.status()).toBe(200);
    const { entries } = await entriesResponse.json();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: saved.entry.id, adoption: saved.entry.adoption });
  }
  await page.goto(`/libraries?library=${library.id}&view=groups&group=${launchId}`);
  await expect(page.getByRole("heading", { name: `Launch ready ${suffix}`, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("persistent-group-desktop.png"), fullPage: true });
  await page.context().clearCookies();
  expect((await page.request.get(`${baseURL}/api/v1/library-groups/${launchId}/members`)).status()).toBe(401);
  expect(browserErrors).toEqual([]);
  await testInfo.attach("library-selection-persistence", {
    body: JSON.stringify({ outcome: "pass", libraryId: library.id, independentLibraryId: independent.id, collectionId, deletedGroupId: writingId, retainedGroupId: launchId, retainedMemberEntryId: library.entry.id, adoptedVersion: "0.1.0", staleWriteStatus: 409, deletedSelectionStatus: 404, anonymousStatus: 401 }),
    contentType: "application/json",
  });
});
