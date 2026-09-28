import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// Contract journeys written before the Library workflow implementation. They drive
// the actual app through its HTTP boundary with synthetic fixtures only. Failure
// targets are listed in .private/skills-workspace/library-failure-cases.md: typed
// identifiers, first-page-only pickers, stale responses, UI-only release authority,
// save causing adoption, and deep links that silently fall back to the first item.
const stamp = "2026-09-27T00:00:00Z";
const sha = (c: string) => c.repeat(64);
const platforms = [{ name: "codex", installTarget: ".agents/skills", status: "supported" }];
const user = { id: "curator-1", email: "curator@example.test", name: "Library curator", status: "active", roles: ["author"], emailVerified: true, mfaVerified: true };
const writer = { role: "owner", canWrite: true, canImport: true, canTrackSources: true };
const curator = { role: "curator", canWrite: true, canImport: false, canTrackSources: false };
const member = { role: "member", canWrite: false, canImport: false, canTrackSources: false };

// Raw request JSON as sent; the named fields are the ones these journeys read.
interface RequestBody { [field: string]: unknown; kind?: string; slug?: string; clientMutationId?: string; version?: string; artifactSha256?: string; expectedCurrentAdoptionId?: string | null; reason?: string; eventIds?: string[] }
interface Write { method: string; path: string; body: RequestBody }
interface Hold { hit: boolean; served: boolean; release: () => void }
interface WorldOptions { seedTeamPlanner?: boolean; failFirstSave?: boolean; failLibraryList?: number; failLibraryPageTwoOnce?: boolean; forbidPersonalSave?: boolean; denyTeamSave?: boolean }
interface Artifact { sha256: string; byteSize: number; contentType: string }
interface FixtureOwner { type: "user" | "team"; id: string; name?: string }
type FixtureAccess = typeof writer;
type FixtureAdoption = ReturnType<typeof adoption>;
interface FixtureEntry {
  id: string; libraryId: string; kind: "skill" | "source"; status: string; revision: number; title: string;
  skill?: { slug: string; nativeName: string; sourceEntryId: null; sourcePath: null; lineageId: null; ownership: { type: "user"; isCaller: boolean } };
  source?: Record<string, unknown>; tracking?: Record<string, unknown>;
  adoption: FixtureAdoption | null; createdAt: string; updatedAt: string;
}
interface FixtureRelease { id: string; slug: string; version: string; lifecycleStatus: string; reviewStatus: string; securityStatus: string; publishedAt: string | null; platforms: typeof platforms; findingCount: number; allowedActions: string[]; artifact?: Artifact }

const library = (id: string, name: string, owner: FixtureOwner, access: FixtureAccess) => ({ id, name, description: "", owner, status: "active", revision: 1, access, subscription: null, createdAt: stamp, updatedAt: stamp });
type FixtureLibrary = ReturnType<typeof library>;
function adoption(entryId: string, slug: string, version: string, digest: string, id = `adopt-${entryId}`) { return { id, entryId, slug, version, artifactSha256: digest, predecessorAdoptionId: null, attestation: "instance-reviewed", adoptedBy: { id: user.id }, reason: "", adoptedAt: stamp }; }
const skillEntry = (id: string, libraryId: string, slug: string, title: string, adopted: FixtureAdoption | null = null): FixtureEntry => ({ id, libraryId, kind: "skill", status: "active", revision: 1, title, skill: { slug, nativeName: slug, sourceEntryId: null, sourcePath: null, lineageId: null, ownership: { type: "user", isCaller: false } }, adoption: adopted, createdAt: stamp, updatedAt: stamp });
const sourceEntry: FixtureEntry = { id: "src-1", libraryId: "lib-personal", kind: "source", status: "active", revision: 1, title: "example/skills", source: { provider: "github", repositoryId: "1", fullName: "example/skills", url: "https://github.com/example/skills", path: "skills", ref: { kind: "default-branch" }, defaultBranch: "main", license: "MIT", archived: false }, tracking: { mode: "manual", health: "healthy", nextCheckAt: null, lastAttemptAt: stamp, lastSuccessfulCheckAt: stamp, lastErrorCode: null, attemptCount: 0, lastGoodSnapshot: null, workerAvailable: true, identityChange: null }, adoption: null, createdAt: stamp, updatedAt: stamp };
const candidate = (id: string, name: string, sourceEntryId = "src-1") => ({ id, sourceEntryId, skillEntryId: null, previewId: null, lineage: { id: `lineage-${name}`, slug: `${name}-a1b2c3`, nativeName: name }, state: "ready-for-review", origin: "tracking", sourcePath: `skills/${name}`, snapshot: { id: "snap-2", sequence: 2, commit: sha("7").slice(0, 40), treeSha: sha("8").slice(0, 40), ref: { kind: "default-branch" }, upstreamLabel: null, orderStatus: "ahead", complete: true, observedAt: stamp }, orderStatus: "ahead", expectedVersion: "0.0.3", expectedPriorRevision: 1, sourceDigest: sha("5"), packageDigest: sha("6"), files: [{ path: "SKILL.md", sha256: sha("6"), bytes: 18, origin: "upstream", sourcePath: `skills/${name}/SKILL.md`, gitBlobSha: null, content: `Use ${name} well.` }], mapping: { slug: `${name}-a1b2c3`, title: `Imported ${name}`, summary: "Synthetic candidate.", license: "MIT", visibility: "private", platforms, nativeName: name, transforms: [] }, release: { suggested: { classification: "unclassified", changeKind: "breaking", requiresUserAction: true, releaseNotes: "" } }, findings: [], changes: null, registry: null, expiresAt: "2027-09-27T00:00:00Z", createdAt: stamp, decidedAt: null });

// Release summaries as a skill manager sees them: ineligible rows are present.
function releasesFor(slug: string): FixtureRelease[] {
  const row = (version: string, fields: Partial<FixtureRelease>): FixtureRelease => ({ id: `rel-${slug}-${version}`, slug, version, lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: "2026-09-20T00:00:00Z", platforms, findingCount: 0, allowedActions: [], ...fields });
  if (slug === "planner") return [
    row("1.3.0", { lifecycleStatus: "pending", reviewStatus: "unreviewed", publishedAt: null, artifact: { sha256: sha("e"), byteSize: 10, contentType: "application/json" } }),
    row("1.2.0", { artifact: { sha256: sha("b"), byteSize: 10, contentType: "application/json" } }), // private self-reviewed by its owner
    row("1.1.0", { lifecycleStatus: "deprecated", publishedAt: "2026-08-01T00:00:00Z", artifact: { sha256: sha("c"), byteSize: 10, contentType: "application/json" } }),
    row("1.0.5", { securityStatus: "failed", artifact: { sha256: sha("f"), byteSize: 10, contentType: "application/json" } }),
    row("1.0.4", { lifecycleStatus: "revoked", artifact: { sha256: sha("9"), byteSize: 10, contentType: "application/json" } }),
    row("1.0.0", { publishedAt: "2026-07-01T00:00:00Z", artifact: { sha256: sha("d"), byteSize: 10, contentType: "application/json" } }),
    row("0.9.0", {}),
  ];
  if (slug === "planner-notes") return [
    row("1.1.0", { artifact: { sha256: sha("a"), byteSize: 10, contentType: "application/json" } }),
    row("1.0.0", { publishedAt: "2026-07-01T00:00:00Z", artifact: { sha256: sha("d"), byteSize: 10, contentType: "application/json" } }),
  ];
  return [row("1.0.0", { artifact: { sha256: sha("d"), byteSize: 10, contentType: "application/json" } })];
}
const eligible = (release: FixtureRelease): release is FixtureRelease & { artifact: Artifact } => Boolean(release.publishedAt && release.artifact && release.reviewStatus === "approved" && release.securityStatus === "passed" && ["approved", "deprecated"].includes(release.lifecycleStatus));

const catalogue = [
  ["incident-summary", "Incident summary"], ["plan-budget", "Plan budget helper"], ["planner", "Release planner"], ["planner-notes", "Planner notes"], ["project-brief", "Project brief writer"],
  ...Array.from({ length: 24 }, (_, index) => [`skill-${String(index + 1).padStart(2, "0")}`, `Checklist ${String(index + 1).padStart(2, "0")}`]),
  ["support-faq", "Support FAQ"], ["support-guide", "Support guide"], ["support-macro", "Reply macros"],
].map(([slug, title]) => ({ slug: slug!, title: title!, summary: `${title} for everyday work.`, lifecycleStatus: "approved", visibility: "authenticated", latestVersion: "1.0.0", reviewStatus: "approved", securityStatus: "passed", platforms, tags: [], access: { canManageSharing: false, reasons: [] } }));

async function libraryWorld(page: Page, options: WorldOptions = {}) {
  await page.addInitScript((session) => localStorage.setItem("myskills-app:web-session", JSON.stringify(session)), { user, expiresAt: "2027-09-27T00:00:00Z" });
  const libraries = new Map<string, FixtureLibrary>([
    ["lib-guild", library("lib-guild", "Design guild", { type: "team", id: "team-design", name: "Design guild" }, member)],
    ["lib-personal", library("lib-personal", "Planning tools", { type: "user", id: user.id }, writer)],
    ["lib-team", library("lib-team", "Support team", { type: "team", id: "team-support", name: "Support team" }, curator)],
    ["lib-archive", library("lib-archive", "Old experiments", { type: "team", id: "team-design", name: "Design guild" }, member)],
  ]);
  const listPages: string[][] = [["lib-guild", "lib-personal"], ["lib-team", "lib-archive"]];
  const entries = new Map<string, FixtureEntry[]>([
    ["lib-personal", [sourceEntry, skillEntry("entry-notes", "lib-personal", "planner-notes", "Planner notes", adoption("entry-notes", "planner-notes", "1.0.0", sha("d"), "adopt-notes")), skillEntry("entry-brief", "lib-personal", "project-brief", "Project brief writer"), skillEntry("entry-deep", "lib-personal", "incident-summary", "Incident summary")]],
    ["lib-team", [skillEntry("entry-team-guide", "lib-team", "support-guide", "Support guide"), skillEntry("entry-team-faq", "lib-team", "support-faq", "Support FAQ"), skillEntry("entry-team-macro", "lib-team", "support-macro", "Reply macros"), ...(options.seedTeamPlanner ? [skillEntry("entry-team-planner", "lib-team", "planner", "Release planner")] : [])]],
    ["lib-guild", [skillEntry("entry-guild-tokens", "lib-guild", "skill-01", "Checklist 01")]],
    ["lib-archive", []],
  ]);
  const candidates = [candidate("cand-a", "alpha"), candidate("cand-b", "beta"), candidate("cand-linked", "linked")];
  const inbox = [
    { id: "inbox-cand", kind: "candidate-ready", libraryId: "lib-personal", libraryName: "Planning tools", entryId: "src-1", entryTitle: "example/skills", candidateId: "cand-linked", version: "0.0.3", path: "skills/linked", createdAt: "2026-09-28T00:00:00Z", readAt: null },
    { id: "inbox-stale", kind: "candidate-ready", libraryId: "lib-personal", libraryName: "Planning tools", entryId: "src-1", entryTitle: "example/skills", candidateId: "cand-stale", version: "0.0.2", path: "skills/stale", createdAt: "2026-09-27T12:00:00Z", readAt: null },
    { id: "inbox-gone", kind: "adoption-changed", libraryId: "lib-gone", libraryName: "Retired library", entryId: "entry-gone", entryTitle: "Old planner", candidateId: null, version: "2.0.0", path: null, createdAt: "2026-09-27T00:00:00Z", readAt: null },
  ];
  const writes: Write[] = [];
  const reads: string[] = [];
  const unhandled: string[] = [];
  const adoptions: Array<{ entryId: string; status: number; body: RequestBody }> = [];
  const mutations = new Map<string, { slug: string; entryId: string }>();
  const holds: Array<Hold & { match: (path: string, url: URL, method: string) => boolean; gate: Promise<void> }> = [];
  const tampered = new Set<string>();
  const revokedEntries = new Set<string>();
  let failedSave = false;
  let listFailures = options.failLibraryList ?? 0;
  let pageTwoFailure = options.failLibraryPageTwoOnce ?? false;
  let writesRevoked = false;
  const findEntry = (id: string) => [...entries.values()].flat().find((entry) => entry.id === id);
  const visibleLibrary = (id: string) => { const found = libraries.get(id); return found && writesRevoked ? { ...found, access: member } : found; };

  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const body = (method === "GET" ? {} : route.request().postDataJSON() ?? {}) as RequestBody;
    if (method === "GET") reads.push(`${path}${url.search}`); else writes.push({ method, path, body });
    const held = holds.find((item) => !item.hit && item.match(path, url, method));
    if (held) { held.hit = true; await held.gate; }
    const reply = async (json: unknown, status = 200) => { await route.fulfill({ json, status }); if (held) held.served = true; };
    const fail = (status: number, code: string, message = code, details?: Record<string, string>) => reply({ error: { code, message, ...(details ? { details } : {}) } }, status);

    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/teams") return reply({ teams: [{ id: "team-support", name: "Support team", role: "member" }], invitations: [] });
    if (path === "/v1/libraries" && method === "GET") {
      const cursor = url.searchParams.get("cursor");
      if (!cursor && listFailures > 0) { listFailures--; return fail(503, "SERVICE_UNAVAILABLE"); }
      if (cursor === "libs-2" && pageTwoFailure) { pageTwoFailure = false; return fail(503, "SERVICE_UNAVAILABLE"); }
      const index = cursor === "libs-2" ? 1 : 0;
      return reply({ libraries: listPages[index]!.map((id) => visibleLibrary(id)), nextCursor: index === 0 ? "libs-2" : null });
    }
    const libraryMatch = path.match(/^\/v1\/libraries\/([^/]+)$/);
    if (libraryMatch && method === "GET") { const found = visibleLibrary(libraryMatch[1]!); return found ? reply({ library: found }) : fail(404, "LIBRARY_NOT_FOUND"); }
    const entriesMatch = path.match(/^\/v1\/libraries\/([^/]+)\/entries$/);
    if (entriesMatch) {
      const libraryId = entriesMatch[1]!;
      const target = visibleLibrary(libraryId);
      if (!target) return fail(404, "LIBRARY_NOT_FOUND");
      const rows = entries.get(libraryId)!;
      if (method === "GET") {
        const offset = Number(url.searchParams.get("cursor")?.replace("e:", "") ?? 0);
        return reply({ entries: rows.slice(offset, offset + 3), nextCursor: offset + 3 < rows.length ? `e:${offset + 3}` : null });
      }
      const key = `${libraryId}:${body.clientMutationId}`;
      const prior = mutations.get(key);
      if (prior) return prior.slug === body.slug ? reply({ entry: findEntry(prior.entryId) }) : fail(409, "CLIENT_MUTATION_ID_CONFLICT");
      if (!target.access.canWrite || (libraryId === "lib-personal" && options.forbidPersonalSave)) return fail(403, "LIBRARY_WRITE_FORBIDDEN");
      const skill = catalogue.find((item) => item.slug === body.slug);
      if (body.kind !== "skill" || !skill) return fail(404, "SKILL_NOT_FOUND");
      if (target.owner.type === "team" && options.denyTeamSave) return fail(422, "LIBRARY_RELEASE_NOT_AUTHORIZED", "The team cannot read this skill release. Share it with the team first.");
      const duplicate = rows.find((row) => row.skill?.slug === body.slug);
      if (duplicate) return fail(409, "LIBRARY_ENTRY_DUPLICATE", "The library already contains this entry.", { entryId: duplicate.id });
      const created = skillEntry(`entry-${libraryId}-${skill.slug}`, libraryId, skill.slug, skill.title);
      rows.push(created);
      mutations.set(key, { slug: skill.slug, entryId: created.id });
      if (options.failFirstSave && !failedSave) { failedSave = true; return fail(503, "SERVICE_UNAVAILABLE", "The response was lost after the write."); }
      return reply({ entry: created }, 201);
    }
    const entryMatch = path.match(/^\/v1\/library-entries\/([^/]+)$/);
    if (entryMatch && method === "GET") { const found = revokedEntries.has(entryMatch[1]!) ? undefined : findEntry(entryMatch[1]!); return found ? reply({ entry: found }) : fail(404, "LIBRARY_ENTRY_NOT_FOUND"); }
    const adoptMatch = path.match(/^\/v1\/library-entries\/([^/]+)\/adoptions$/);
    if (adoptMatch && method === "POST") {
      const entry = findEntry(adoptMatch[1]!);
      const slug = entry?.skill?.slug;
      const release = slug ? releasesFor(slug).find((item) => item.version === body.version) : undefined;
      const record = (status: number) => adoptions.push({ entryId: adoptMatch[1]!, status, body });
      if (!entry || !slug || !release || !eligible(release) || release.artifact.sha256 !== body.artifactSha256) { record(422); return fail(422, "LIBRARY_RELEASE_NOT_ADOPTABLE"); }
      if (libraries.get(entry.libraryId)!.owner.type === "team" && slug === "planner" && release.version === "1.2.0") { record(422); return fail(422, "LIBRARY_RELEASE_NOT_AUTHORIZED", "The team cannot read this release."); }
      if ((entry.adoption?.id ?? null) !== body.expectedCurrentAdoptionId) { record(409); return fail(409, "LIBRARY_ADOPTION_CONFLICT"); }
      entry.adoption = { ...adoption(entry.id, slug, release.version, release.artifact.sha256, `adopt-${entry.id}-${release.version}`), reason: body.reason ?? "" };
      record(201);
      return reply({ adoption: entry.adoption, entry }, 201);
    }
    if (path === "/v1/library-entries/src-1/candidates") {
      const second = url.searchParams.get("cursor") === "c:2";
      return reply({ candidates: second ? candidates.slice(2) : candidates.slice(0, 2), nextCursor: second ? null : "c:2" });
    }
    const candidateMatch = path.match(/^\/v1\/library-candidates\/([^/]+)$/);
    if (candidateMatch) {
      if (candidateMatch[1] === "cand-foreign") return reply({ candidate: candidate("cand-foreign", "foreign", "src-elsewhere") });
      const found = candidates.find((item) => item.id === candidateMatch[1]);
      return found ? reply({ candidate: found }) : fail(404, "LIBRARY_CANDIDATE_NOT_FOUND");
    }
    if (path.endsWith("/bindings")) return reply({ bindings: [] });
    if (path.endsWith("/subscription")) return reply({ subscription: null });
    if (path === "/v1/library-inbox") return reply({ items: inbox, unreadCount: inbox.filter((item) => !item.readAt).length, nextCursor: null });
    if (path === "/v1/library-inbox/read") return reply({ read: body.eventIds });
    if (path === "/v1/admin/library-settings") return reply({ settings: { privateSelfReviewEnabled: true, updatedAt: null } });
    if (path === "/v1/review/self-reviewed-releases") return reply({ releases: [] });

    if (path === "/v1/skills") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number(url.searchParams.get("cursor")?.replace("s:", "") ?? 0);
      const matches = catalogue.filter((skill) => `${skill.slug} ${skill.title}`.toLowerCase().includes(q));
      return reply({ skills: matches.slice(offset, offset + limit), nextCursor: offset + limit < matches.length ? `s:${offset + limit}` : null });
    }
    const releaseMatch = path.match(/^\/v1\/skills\/([^/]+)\/releases\/([^/]+)$/);
    if (releaseMatch) {
      const [, slug, version] = releaseMatch;
      const summary = releasesFor(slug!).find((item) => item.version === version);
      if (!summary || !eligible(summary)) return fail(404, "RELEASE_NOT_FOUND");
      const skill = catalogue.find((item) => item.slug === slug)!;
      return reply({ release: { slug, title: skill.title, summary: skill.summary, version, lifecycleStatus: summary.lifecycleStatus, reviewStatus: "approved", securityStatus: "passed", publishedAt: summary.publishedAt, platforms, requiresUserAction: false, artifact: tampered.has(`${slug}@${version}`) ? { ...summary.artifact, sha256: sha("0") } : summary.artifact } });
    }
    const releasesMatch = path.match(/^\/v1\/skills\/([^/]+)\/releases$/);
    if (releasesMatch) return reply({ releases: releasesFor(releasesMatch[1]!) });
    if (/^\/v1\/skills\/[^/]+\/bundles$/.test(path)) return reply({ bundles: [] });
    const skillMatch = path.match(/^\/v1\/skills\/([^/]+)$/);
    if (skillMatch) { const found = catalogue.find((item) => item.slug === skillMatch[1]); return found ? reply({ skill: found }) : fail(404, "SKILL_NOT_FOUND"); }
    if (path.endsWith("/compatibility")) return reply({ compatibility: { schemaVersion: 1, declaration: { status: "unspecified", revision: null, targets: [] }, attestation: { status: "none", revision: null }, evidence: [], manage: { pendingRevisions: [], evidenceProposals: [] } } });
    if (path.startsWith("/v1/improvements/policies/")) return reply({ revision: null });
    if (path === "/v1/bundles") return reply({ bundles: [], nextCursor: null });
    if (path === "/v1/manage/skills") return reply({ skills: [], nextCursor: null });
    if (path === "/v1/architecture-targets") return reply({ targets: [] });
    unhandled.push(`${method} ${path}`);
    return fail(404, "NOT_FOUND", `Unimplemented library workflow fixture: ${method} ${path}`);
  });

  return {
    writes, reads, unhandled, adoptions,
    hold(match: (path: string, url: URL, method: string) => boolean): Hold {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const item = { match, gate, release, hit: false, served: false };
      holds.push(item);
      return item;
    },
    tamper: (slug: string, version: string) => tampered.add(`${slug}@${version}`),
    restore: (slug: string, version: string) => tampered.delete(`${slug}@${version}`),
    revokeWrites: () => { writesRevoked = true; },
    revokeEntry: (entryId: string) => revokedEntries.add(entryId),
    restoreEntry: (entryId: string) => revokedEntries.delete(entryId),
    replaceAdoption: (entryId: string, version: string, digest: string) => { const entry = findEntry(entryId)!; entry.adoption = adoption(entryId, entry.skill!.slug, version, digest, `adopt-${entryId}-other`); },
  };
}

type World = Awaited<ReturnType<typeof libraryWorld>>;
const params = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);
// App.tsx numbers its history entries; Library pushes must go through that index.
const historyIndex = (page: Page) => page.evaluate(() => (window.history.state as Record<string, unknown> | null)?.__myskillsAppHistoryIndex ?? null);
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function fitsPage(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
async function receipt(testInfo: TestInfo, name: string, value: unknown) {
  await writeFile(testInfo.outputPath(`${name}.json`), JSON.stringify(value, null, 2));
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
}
const nonGetPaths = (world: World) => world.writes.map((write) => `${write.method} ${write.path}`);

// Needs the workspace lead to mount AddToLibraryButton in authenticated skill detail.
test("add to library pages every authorised library, saves only a reference, retries idempotently and links the exact entry", async ({ page }, testInfo) => {
  const world = await libraryWorld(page, { seedTeamPlanner: true, failFirstSave: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/skills/planner");
  const trigger = page.getByRole("button", { name: "Add to library", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add “Release planner” to a library" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  // Writable libraries come from both list pages. The first listed library is read-only.
  await expect(dialog.getByRole("radio", { name: /^Support team/ })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /^Planning tools/ })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  await expect(dialog.getByText(/Design guild|Old experiments/)).toHaveCount(0);
  expect(world.reads.filter((read) => read.startsWith("/v1/libraries?"))).toEqual(["/v1/libraries?limit=50", "/v1/libraries?limit=50&cursor=libs-2"]);
  const save = dialog.getByRole("button", { name: "Save to library", exact: true });
  await expect(save).toBeDisabled();
  await expect(dialog.getByText("Saving adds a reference only. It does not adopt, install or follow updates.")).toBeVisible();
  await dialog.getByRole("radio", { name: /^Planning tools/ }).check();
  await save.click();
  // The first write succeeded but its response was lost; the retry must replay it.
  await expect(dialog.getByRole("alert")).toContainText("Try again");
  await expect(dialog.getByRole("radio", { name: /^Planning tools/ })).toBeChecked();
  const pending = world.hold((path, _url, method) => method === "POST" && path.endsWith("/entries"));
  await save.click();
  await expect.poll(() => pending.hit).toBe(true);
  await expect(dialog.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: /^Support team/ })).toBeDisabled();
  pending.release();
  const opened = dialog.getByRole("link", { name: "Open in Planning tools", exact: true });
  await expect(opened).toHaveAttribute("href", "/libraries?library=lib-personal&entry=entry-lib-personal-planner");
  await expect(dialog.getByRole("status").filter({ hasText: "Saved to Planning tools." })).toBeVisible();
  await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  const personalSaves = world.writes.filter((write) => write.path === "/v1/libraries/lib-personal/entries");
  expect(personalSaves).toHaveLength(2);
  expect(personalSaves[0]!.body).toEqual(personalSaves[1]!.body);
  expect(personalSaves[0]!.body).toMatchObject({ kind: "skill", slug: "planner" });
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // A second opening rereads authority. The team already holds this skill beyond
  // its first entry page, so recovery pages entries instead of retrying the save.
  await trigger.click();
  await dialog.getByRole("radio", { name: /^Support team/ }).check();
  await dialog.getByRole("button", { name: "Save to library", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Already saved in Support team." })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open in Support team", exact: true })).toHaveAttribute("href", "/libraries?library=lib-team&entry=entry-team-planner");
  expect(world.writes.filter((write) => write.path === "/v1/libraries/lib-team/entries")).toHaveLength(1);
  expect(world.reads).toContain("/v1/libraries/lib-team/entries?limit=50&cursor=e%3A3");
  expect(nonGetPaths(world)).toEqual(["POST /v1/libraries/lib-personal/entries", "POST /v1/libraries/lib-personal/entries", "POST /v1/libraries/lib-team/entries"]);

  await page.setViewportSize({ width: 390, height: 844 });
  await fitsPage(page);
  await page.screenshot({ path: testInfo.outputPath("add-to-library-duplicate-390.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await fitsPage(page);

  // The success link opens the exact entry even though it sits beyond page one.
  await page.goto("/libraries?library=lib-personal&entry=entry-lib-personal-planner");
  await expect(page.getByRole("heading", { name: "Release planner", exact: true })).toBeVisible();
  expect(world.reads).toContain("/v1/library-entries/entry-lib-personal-planner");
  expect(world.adoptions).toEqual([]);
  await receipt(testInfo, "add-to-library-receipt", { outcome: "pass", writes: world.writes, libraryListReads: world.reads.filter((read) => read.startsWith("/v1/libraries")), unhandled: world.unhandled });
});

test("add to library explains list failures, partial pages, denials and having no writable library without saving", async ({ page }, testInfo) => {
  const world = await libraryWorld(page, { failLibraryList: 1, failLibraryPageTwoOnce: true, forbidPersonalSave: true, denyTeamSave: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/skills/planner");
  const trigger = page.getByRole("button", { name: "Add to library", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add “Release planner” to a library" });
  await expect(dialog.getByRole("alert")).toContainText("Your libraries couldn’t load.");
  await expect(dialog.getByRole("button", { name: "Save to library", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry libraries", exact: true }).click();
  // Page one arrives, page two fails: loaded choices stay and the gap is explicit.
  await expect(dialog.getByRole("radio", { name: /^Planning tools/ })).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("Some libraries couldn’t load.");
  await dialog.getByRole("button", { name: "Retry libraries", exact: true }).click();
  await expect(dialog.getByRole("radio", { name: /^Support team/ })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(world.reads.filter((read) => read.startsWith("/v1/libraries?")).slice(-1)).toEqual(["/v1/libraries?limit=50&cursor=libs-2"]);
  await dialog.getByRole("radio", { name: /^Planning tools/ }).check();
  await dialog.getByRole("button", { name: "Save to library", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Only the library owner or a team curator can change this library.");
  await dialog.getByRole("radio", { name: /^Support team/ }).check();
  await dialog.getByRole("button", { name: "Save to library", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Share it with the team first");
  await expect(dialog.getByRole("radio", { name: /^Support team/ })).toBeChecked();
  await expect(dialog.getByRole("link", { name: /^Open in/ })).toHaveCount(0);
  await fitsPage(page);
  await page.screenshot({ path: testInfo.outputPath("add-to-library-denied-390.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(trigger).toBeFocused();

  world.revokeWrites();
  await trigger.click();
  await expect(dialog.getByText("You don’t have a library you can add to.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Create one in Libraries", exact: true })).toHaveAttribute("href", "/libraries");
  await expect(dialog.getByRole("radio")).toHaveCount(0);
  expect(nonGetPaths(world)).toEqual(["POST /v1/libraries/lib-personal/entries", "POST /v1/libraries/lib-team/entries"]);
  await receipt(testInfo, "add-to-library-states-receipt", { outcome: "pass", writes: world.writes, created: false });
});

test("two libraries save and adopt the same skill at different exact versions through authorised pickers", async ({ page }, testInfo) => {
  const world = await libraryWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/libraries?library=lib-personal");
  await expect(page.getByRole("heading", { name: "Planning tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  const picker = page.getByRole("form", { name: "Save a skill" });
  const search = picker.getByRole("searchbox", { name: "Search skills", exact: true });
  await expect(search).toBeFocused();
  await expect(picker.getByLabel("Skill slug")).toHaveCount(0);
  await expect(picker.getByRole("radio")).toHaveCount(20);
  await expect(picker.getByRole("radio", { name: /^Release planner.*planner/ })).toBeVisible();

  // A page for an earlier query must not join a newer query's results.
  const stalePage = world.hold((path, url) => path === "/v1/skills" && url.searchParams.get("cursor") === "s:20" && !url.searchParams.get("q"));
  await picker.getByRole("button", { name: "Load more skills", exact: true }).click();
  await expect.poll(() => stalePage.hit).toBe(true);
  await search.fill("support");
  await expect(picker.getByRole("radio")).toHaveCount(3);
  stalePage.release();
  await expect.poll(() => stalePage.served).toBe(true);
  await settle(page);
  await expect(picker.getByRole("radio")).toHaveCount(3);
  await expect(picker.getByRole("radio", { name: /^Checklist 16/ })).toHaveCount(0);
  await search.fill("");
  await expect(picker.getByRole("radio")).toHaveCount(20);
  await picker.getByRole("button", { name: "Load more skills", exact: true }).click();
  await expect(picker.getByRole("radio")).toHaveCount(32);
  await expect(picker.getByRole("button", { name: "Load more skills", exact: true })).toHaveCount(0);

  // An older search response arriving last must not replace the newer one.
  const staleSearch = world.hold((path, url) => path === "/v1/skills" && url.searchParams.get("q") === "plan");
  await search.fill("plan");
  await expect.poll(() => staleSearch.hit).toBe(true);
  await search.fill("planner");
  await expect(picker.getByRole("radio")).toHaveCount(2);
  staleSearch.release();
  await expect.poll(() => staleSearch.served).toBe(true);
  await settle(page);
  await expect(picker.getByRole("radio", { name: /^Plan budget helper/ })).toHaveCount(0);
  await expect(picker.getByRole("radio")).toHaveCount(2);
  const saveSkill = picker.getByRole("button", { name: "Save skill", exact: true });
  await expect(saveSkill).toBeDisabled();
  await search.press("Enter");
  await settle(page);
  expect(world.writes).toEqual([]);
  await search.fill("zz-no-match");
  await expect(picker.getByText("No skills match “zz-no-match”.")).toBeVisible();
  await search.fill("planner");
  await picker.getByRole("radio", { name: /^Release planner/ }).check();
  await expect(saveSkill).toBeEnabled();
  await saveSkill.click();
  const personal = page.getByRole("complementary", { name: "Release planner", exact: true });
  await expect(personal).toBeVisible();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-lib-personal-planner" });

  // Only approved, scan-passed, published releases with an artifact are offered.
  const personalRelease = personal.getByLabel("Reviewed release", { exact: true });
  await expect(personalRelease.locator("option")).toHaveText(["Choose a release", /^1\.2\.0/, /^1\.1\.0.*Deprecated/, /^1\.0\.0/]);
  await expect(personal.getByRole("button", { name: "Adopt skill release", exact: true })).toBeDisabled();
  await personalRelease.selectOption("1.2.0");
  await personal.getByLabel("Curator note (optional)").fill("Personal pick");
  await personal.getByRole("button", { name: "Adopt skill release", exact: true }).click();
  await expect(personal.getByText("Adopted 1.2.0", { exact: true }).first()).toBeVisible();

  // The team library is on the second library page.
  const switcher = page.getByRole("navigation", { name: "Your libraries" });
  await switcher.getByRole("button", { name: "Load more libraries", exact: true }).click();
  await switcher.getByRole("button", { name: /^Support team/ }).click();
  await expect(page.getByRole("heading", { name: "Support team", exact: true })).toBeVisible();
  await expect.poll(() => params(page)).toEqual({ library: "lib-team" });
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  const teamPicker = page.getByRole("form", { name: "Save a skill" });
  await teamPicker.getByRole("searchbox", { name: "Search skills", exact: true }).fill("planner");
  await teamPicker.getByRole("radio", { name: /^Release planner/ }).check();
  await teamPicker.getByRole("button", { name: "Save skill", exact: true }).click();
  const team = page.getByRole("complementary", { name: "Release planner", exact: true });
  await expect.poll(() => params(page)).toEqual({ library: "lib-team", entry: "entry-lib-team-planner" });
  const teamRelease = team.getByLabel("Reviewed release", { exact: true });
  // The private self-reviewed release is offered; the backend decides the team cannot use it.
  await teamRelease.selectOption("1.2.0");
  await team.getByRole("button", { name: "Adopt skill release", exact: true }).click();
  await expect(team.getByRole("alert")).toContainText("This release is not authorized for this library.");
  await expect(team.getByText(/^Adopted /)).toHaveCount(0);
  await teamRelease.selectOption("1.1.0");
  await team.getByRole("button", { name: "Adopt skill release", exact: true }).click();
  await expect(team.getByText("Adopted 1.1.0", { exact: true }).first()).toBeVisible();

  await page.goBack();
  await page.goBack();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-lib-personal-planner" });
  await expect(page.getByRole("heading", { name: "Planning tools", exact: true })).toBeVisible();
  await expect(personal.getByText("Adopted 1.2.0", { exact: true }).first()).toBeVisible();

  expect(world.adoptions.map(({ entryId, status, body }) => ({ entryId, status, version: body.version, digest: body.artifactSha256, expected: body.expectedCurrentAdoptionId }))).toEqual([
    { entryId: "entry-lib-personal-planner", status: 201, version: "1.2.0", digest: sha("b"), expected: null },
    { entryId: "entry-lib-team-planner", status: 422, version: "1.2.0", digest: sha("b"), expected: null },
    { entryId: "entry-lib-team-planner", status: 201, version: "1.1.0", digest: sha("c"), expected: null },
  ]);
  expect(world.adoptions[0]!.body.reason).toBe("Personal pick");
  expect(nonGetPaths(world)).toEqual([
    "POST /v1/libraries/lib-personal/entries",
    "POST /v1/library-entries/entry-lib-personal-planner/adoptions",
    "POST /v1/libraries/lib-team/entries",
    "POST /v1/library-entries/entry-lib-team-planner/adoptions",
    "POST /v1/library-entries/entry-lib-team-planner/adoptions",
  ]);
  const exactReads = world.reads.filter((read) => /\/releases\/[^/]+$/.test(read));
  expect(exactReads).toEqual(expect.arrayContaining(["/v1/skills/planner/releases/1.2.0", "/v1/skills/planner/releases/1.1.0"]));
  await page.screenshot({ path: testInfo.outputPath("two-library-adoption-1440.png"), fullPage: true, animations: "disabled" });
  await receipt(testInfo, "two-library-adoption-receipt", { outcome: "pass", adoptions: world.adoptions, writes: world.writes, searches: world.reads.filter((read) => read.startsWith("/v1/skills?")) });
});

test("an inbox change opens its exact library, source and candidate and survives reload, back and forward", async ({ page }, testInfo) => {
  const world = await libraryWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/libraries");
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  const start = await historyIndex(page);
  expect(typeof start).toBe("number");
  const at = (step: number) => (start as number) + step;
  await page.getByRole("button", { name: "Changes, 3 unread", exact: true }).click();
  await page.getByRole("button", { name: /Planning tools.*Change to review · example\/skills 0\.0\.3/ }).click();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1", candidate: "cand-linked" });
  await expect.poll(() => historyIndex(page)).toBe(at(1));
  const linked = page.getByRole("article", { name: "Import skills/linked", exact: true });
  await expect(linked).toBeVisible();
  await expect(linked).toHaveAttribute("data-linked", "true");
  await expect(page.getByRole("article", { name: "Import skills/alpha", exact: true })).toBeVisible();
  await expect.poll(() => world.writes.map((write) => write.body.eventIds)).toEqual([["inbox-cand"]]);
  expect(world.reads).toContain("/v1/library-candidates/cand-linked?includeContent=true");

  await page.reload();
  await expect(linked).toBeVisible();
  await expect(linked).toHaveAttribute("data-linked", "true");
  expect(await historyIndex(page)).toBe(at(1));
  await page.getByRole("button", { name: "Close import", exact: true }).click();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1" });
  await expect.poll(() => historyIndex(page)).toBe(at(2));
  await page.getByRole("button", { name: "Planner notes", exact: true }).click();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-notes" });
  await expect.poll(() => historyIndex(page)).toBe(at(3));
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1" });
  expect(await historyIndex(page)).toBe(at(2));
  await expect(page.getByRole("heading", { name: "example/skills", exact: true })).toBeVisible();
  await expect(linked).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1", candidate: "cand-linked" });
  expect(await historyIndex(page)).toBe(at(1));
  await expect(linked).toBeVisible();
  await expect(linked).toHaveAttribute("data-linked", "true");
  await page.goBack();
  await expect.poll(() => params(page)).toEqual({});
  expect(await historyIndex(page)).toBe(at(0));
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  await expect(linked).toHaveCount(0);
  await page.goForward();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1", candidate: "cand-linked" });
  await expect(linked).toHaveAttribute("data-linked", "true");
  await page.goForward();
  await page.goForward();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-notes" });
  expect(await historyIndex(page)).toBe(at(3));
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toBeVisible();

  // A replaced candidate fails clearly under its still-valid source.
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: /Planning tools.*Change to review · example\/skills 0\.0\.2/ }).click();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "src-1", candidate: "cand-stale" });
  await expect.poll(() => historyIndex(page)).toBe(at(4));
  await expect(page.getByRole("alert").filter({ hasText: "This change is unavailable or was replaced." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "example/skills", exact: true })).toBeVisible();
  await expect(page.locator("[data-linked='true']")).toHaveCount(0);

  // A notification for a library the reader lost fails instead of showing another library.
  await page.getByRole("button", { name: /^Changes/ }).click();
  await page.getByRole("button", { name: /Retired library/ }).click();
  await expect.poll(() => params(page)).toEqual({ library: "lib-gone", entry: "entry-gone" });
  await expect.poll(() => historyIndex(page)).toBe(at(5));
  await expect(page.getByRole("heading", { name: "Library unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("This library is unavailable or you no longer have access.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^(Design guild|Planning tools)$/ })).toHaveCount(0);
  await expect.poll(() => world.writes.map((write) => write.body.eventIds)).toEqual([["inbox-cand"], ["inbox-stale"], ["inbox-gone"]]);
  expect(world.writes.every((write) => write.path === "/v1/library-inbox/read")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("inbox-unavailable-1440.png"), fullPage: true, animations: "disabled" });

  // Same-view App navigation: the sidebar Libraries link while already on
  // Libraries must reset to the default library as one new history entry.
  const unavailable = page.getByRole("heading", { name: "Library unavailable", exact: true });
  const sidebarLibraries = page.getByRole("complementary", { name: "Primary navigation" }).getByRole("link", { name: "Libraries", exact: true });
  await sidebarLibraries.click();
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search).toBe("/libraries");
  await expect.poll(() => historyIndex(page)).toBe(at(6));
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  await expect(unavailable).toHaveCount(0);
  await expect(page.getByText("This library is unavailable or you no longer have access.")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "This change is unavailable or was replaced." })).toHaveCount(0);
  await expect(page.locator("[data-linked='true']")).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Planner notes", exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("inbox-nav-reset-1440.png"), fullPage: true, animations: "disabled" });
  const navReset: Record<string, unknown> = { reset: { url: "/libraries", historyIndex: await historyIndex(page) } };
  await page.goBack();
  await expect.poll(() => params(page)).toEqual({ library: "lib-gone", entry: "entry-gone" });
  expect(await historyIndex(page)).toBe(at(5));
  await expect(unavailable).toBeVisible();
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toHaveCount(0);
  navReset.back = { params: params(page), historyIndex: await historyIndex(page) };
  await page.goForward();
  await expect.poll(() => params(page)).toEqual({});
  expect(await historyIndex(page)).toBe(at(6));
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  await expect(unavailable).toHaveCount(0);
  navReset.forward = { params: params(page), historyIndex: await historyIndex(page) };
  expect(world.writes.every((write) => write.path === "/v1/library-inbox/read")).toBe(true);
  await receipt(testInfo, "inbox-deep-link-receipt", { outcome: "pass", writes: world.writes, candidateReads: world.reads.filter((read) => read.startsWith("/v1/library-candidates")), historyStart: start, navReset });
});

test("deep links outside loaded pages resolve exactly, while stale, foreign and denied identities fail without fallback", async ({ page }, testInfo) => {
  const world = await libraryWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A library on the second list page resolves directly.
  await page.goto("/libraries?library=lib-team");
  await expect(page.getByRole("heading", { name: "Support team", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Your libraries" }).getByRole("button", { name: /^Support team/ })).toHaveAttribute("aria-current", "true");
  expect(world.reads).toContain("/v1/libraries/lib-team");

  // An entry on the second entry page resolves directly and is not replaced by the first row.
  await page.goto("/libraries?library=lib-personal&entry=entry-deep");
  await expect(page.getByRole("complementary", { name: "Incident summary", exact: true })).toBeVisible();
  expect(world.reads).toContain("/v1/library-entries/entry-deep");

  // Access to that out-of-page entry is lost; a refresh must fail clearly, not spin or fall back.
  world.revokeEntry("entry-deep");
  const directReads = world.reads.filter((read) => read === "/v1/library-entries/entry-deep").length;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => world.reads.filter((read) => read === "/v1/library-entries/entry-deep").length).toBeGreaterThan(directReads);
  await expect(page.getByRole("alert").filter({ hasText: "This entry is unavailable or you no longer have access." })).toBeVisible();
  await expect(page.getByText("Loading entry…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Incident summary", exact: true })).toHaveCount(0);
  await expect(page.locator(".library-entry[aria-current='true']")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toHaveCount(0);
  expect(params(page)).toEqual({ library: "lib-personal", entry: "entry-deep" });
  await page.screenshot({ path: testInfo.outputPath("revoked-entry-refresh-1440.png"), fullPage: true, animations: "disabled" });
  world.restoreEntry("entry-deep");

  // An entry from another library is refused under the requested library.
  await page.goto("/libraries?library=lib-personal&entry=entry-team-guide");
  await expect(page.getByRole("heading", { name: "Planning tools", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "This entry is unavailable or you no longer have access." })).toBeVisible();
  await expect(page.getByText("Support guide", { exact: true })).toHaveCount(0);
  await expect(page.locator(".library-entry[aria-current='true']")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toHaveCount(0);

  // A candidate from another source is refused under the requested source.
  await page.goto("/libraries?library=lib-personal&entry=src-1&candidate=cand-foreign");
  await expect(page.getByRole("alert").filter({ hasText: "This change is unavailable or was replaced." })).toBeVisible();
  await expect(page.getByRole("article", { name: "Import skills/foreign", exact: true })).toHaveCount(0);

  // A missing library never falls back to the first library.
  await page.goto("/libraries?library=lib-missing");
  await expect(page.getByRole("heading", { name: "Library unavailable", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show your libraries", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  await expect.poll(() => params(page)).toEqual({});

  // A slow direct entry read for the previous library must not reach the next one.
  const slowEntry = world.hold((path) => path === "/v1/library-entries/entry-deep");
  await page.goto("/libraries?library=lib-personal&entry=entry-deep");
  await expect.poll(() => slowEntry.hit).toBe(true);
  await page.getByRole("navigation", { name: "Your libraries" }).getByRole("button", { name: /^Design guild/ }).click();
  await expect(page.getByRole("heading", { name: "Design guild", exact: true })).toBeVisible();
  slowEntry.release();
  await expect.poll(() => slowEntry.served).toBe(true);
  await settle(page);
  await expect(page.getByRole("heading", { name: "Incident summary", exact: true })).toHaveCount(0);
  await expect.poll(() => params(page)).toEqual({ library: "lib-guild" });

  // Adoption re-reads the exact release and keeps optimistic concurrency.
  await page.goto("/libraries?library=lib-personal&entry=entry-notes");
  const notes = page.getByRole("complementary", { name: "Planner notes", exact: true });
  await notes.getByText("Change adopted version", { exact: true }).click();
  const change = notes.getByLabel("Reviewed release", { exact: true });
  await expect(change.locator("option")).toHaveText(["Choose a release", /^1\.1\.0/, /^1\.0\.0.*adopted/i]);
  await expect(change.locator("option", { hasText: /^1\.0\.0/ })).toBeDisabled();
  world.tamper("planner-notes", "1.1.0");
  await change.selectOption("1.1.0");
  await notes.getByRole("button", { name: "Adopt skill release", exact: true }).click();
  await expect(notes.getByRole("alert")).toContainText("The release changed");
  expect(world.adoptions).toEqual([]);
  world.restore("planner-notes", "1.1.0");
  world.replaceAdoption("entry-notes", "1.1.0", sha("a"));
  await notes.getByRole("button", { name: "Adopt skill release", exact: true }).click();
  await expect(notes.getByRole("alert")).toContainText("The adopted version changed. Refresh and review it before retrying.");
  expect(world.adoptions.map((item) => [item.status, item.body.expectedCurrentAdoptionId, item.body.artifactSha256])).toEqual([[409, "adopt-notes", sha("a")]]);
  await page.screenshot({ path: testInfo.outputPath("adoption-conflict-1440.png"), fullPage: true, animations: "disabled" });
  expect(nonGetPaths(world)).toEqual(["POST /v1/library-entries/entry-notes/adoptions"]);
  await receipt(testInfo, "deep-link-authority-receipt", { outcome: "pass", reads: world.reads.filter((read) => /library-(entries|candidates)\/|libraries\/lib-/.test(read)), adoptions: world.adoptions });
});

test("skill links carry the exact library return context, and mobile keyboard flows keep focus and fit", async ({ page }, testInfo) => {
  const world = await libraryWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/libraries?library=lib-personal&entry=entry-notes");
  const notes = page.getByRole("complementary", { name: "Planner notes", exact: true });
  await expect(notes).toBeVisible();
  await page.getByRole("searchbox", { name: "Filter entries", exact: true }).fill("notes");
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-notes", filter: "notes" });
  const view = notes.getByRole("link", { name: "View in Skills", exact: true });
  const href = new URL((await view.getAttribute("href"))!, "http://local.test");
  expect(href.pathname).toBe("/skills/planner-notes");
  expect(href.searchParams.get("version")).toBe("1.0.0");
  const returnTo = href.searchParams.get("returnTo")!;
  expect(returnTo).toBe("/libraries?library=lib-personal&entry=entry-notes&filter=notes");
  await view.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/skills/planner-notes");
  await page.goBack();
  await expect(page.getByRole("complementary", { name: "Planner notes", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Filter entries", exact: true })).toHaveValue("notes");
  await page.goto(returnTo);
  await expect(page.getByRole("complementary", { name: "Planner notes", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Filter entries", exact: true })).toHaveValue("notes");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/libraries?library=lib-personal&entry=entry-notes");
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toBeVisible();
  await fitsPage(page);
  await page.screenshot({ path: testInfo.outputPath("deep-entry-390.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Back to entries", exact: true }).click();
  await expect(page.getByRole("button", { name: "Planner notes", exact: true })).toBeFocused();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal" });
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Planner notes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to entries", exact: true }).click();

  // Keyboard only: search, Enter does not submit, choose with the keyboard, then save.
  await page.getByRole("button", { name: "Add skill", exact: true }).click();
  const picker = page.getByRole("form", { name: "Save a skill" });
  const search = picker.getByRole("searchbox", { name: "Search skills", exact: true });
  await expect(search).toBeFocused();
  await page.keyboard.type("planner");
  await page.keyboard.press("Enter");
  await expect(picker.getByRole("radio")).toHaveCount(2);
  expect(world.writes).toEqual([]);
  await page.keyboard.press("Tab");
  await expect(picker.getByRole("radio").first()).toBeFocused();
  await page.keyboard.press("Space");
  await expect(picker.getByRole("radio").first()).toBeChecked();
  await fitsPage(page);
  // On a phone the Save action must be reachable by scrolling and not sit under
  // the fixed bottom navigation or outside the viewport.
  const saveButton = picker.getByRole("button", { name: "Save skill", exact: true });
  const reachable = () => saveButton.evaluate((button) => {
    button.scrollIntoView({ block: "center" });
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: window.innerHeight, unobscured: Boolean(hit && button.contains(hit)), hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : null };
  });
  await expect.poll(async () => { const state = await reachable(); return state.unobscured && state.top >= 0 && state.bottom <= state.viewport; }).toBe(true);
  await saveButton.click({ trial: true });
  const saveReach = await reachable();
  await page.screenshot({ path: testInfo.outputPath("skill-picker-390.png"), animations: "disabled" });
  await saveButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Release planner", exact: true })).toBeFocused();
  await expect.poll(() => params(page)).toEqual({ library: "lib-personal", entry: "entry-lib-personal-planner" });
  const releasePicker = page.getByLabel("Reviewed release", { exact: true });
  await releasePicker.focus();
  await releasePicker.selectOption("1.0.0");
  await fitsPage(page);
  await page.screenshot({ path: testInfo.outputPath("release-picker-390.png"), fullPage: true, animations: "disabled" });
  expect(nonGetPaths(world)).toEqual(["POST /v1/libraries/lib-personal/entries"]);
  expect(world.writes[0]!.body).toMatchObject({ kind: "skill", slug: "planner" });
  await receipt(testInfo, "return-context-receipt", { outcome: "pass", returnTo, saveReach, writes: world.writes });
});
