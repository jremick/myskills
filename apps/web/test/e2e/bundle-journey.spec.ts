import { expect, test as base, type Locator, type Page, type Route } from "@playwright/test";

// Authored before the bundle UI, from .private/bundles/contract.md and
// failure-cases.md. Browser fixtures pin UI behaviour: unique server totals,
// overlap, lazy member pages, URL state, reference saving and focus. The HTTP
// suite against Postgres proves authorization; nothing here stands in for it.

// Every journey fails on an uncaught page exception, so a render that looks
// right cannot hide a runtime error.
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [async ({ page }, provide) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await provide(errors);
    expect(errors, "uncaught page exceptions").toEqual([]);
  }, { auto: true }],
});

type Visibility = "public" | "authenticated" | "team" | "private";
type Kind = "curated" | "source";
interface FixtureBundle {
  id: string;
  kind: Kind;
  name: string;
  purpose: string;
  visibility: Visibility;
  revision: number;
  owner: { type: "user" | "team"; id: string; name: string };
  source: { entryId: string; repositoryId: string; fullName: string; path: string } | null;
  members: string[];
  canEdit: boolean;
  partial: boolean;
}
interface Write { method: string; path: string; body: Record<string, unknown> }

const platforms = [{ name: "codex", installTarget: "codex-skill", status: "supported" }];
const user = { id: "user-sam", email: "sam@example.test", name: "Sam Rivera", status: "active", roles: ["author"], emailVerified: true, mfaVerified: true };
const docsTeam = { id: "team-docs", name: "Docs guild", slug: "docs-guild", role: "owner", members: [], invitations: [], createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };

function publicSkill(slug: string, title: string, summary: string, visibility: Visibility = "public") {
  return { slug, title, summary, lifecycleStatus: "approved", visibility, latestVersion: "1.2.0" as string | null, reviewStatus: "approved", securityStatus: "passed", platforms, tags: [] as string[] };
}
type FixtureSkill = ReturnType<typeof publicSkill>;

function release(skill: FixtureSkill, version: string, publishedAt: string) {
  return { slug: skill.slug, title: skill.title, summary: skill.summary, version, lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt, platforms, releaseNotes: `Release notes for ${skill.title} ${version}.`, changeKind: "feature", artifact: { sha256: "c".repeat(64), byteSize: 1024, contentType: "application/vnd.myskills-app.package+json" } };
}

function seed() {
  const skills = new Map<string, FixtureSkill>();
  const add = (...items: FixtureSkill[]) => items.map((item) => { skills.set(item.slug, item); return item.slug; });
  const engineering = add(
    publicSkill("code-review-checklist", "Code review checklist", "Walks a diff against a shared review bar and flags risky changes."),
    publicSkill("pr-description-writer", "PR description writer", "Turns a branch into a reviewer-ready summary with test notes."),
    publicSkill("test-plan-builder", "Test plan builder", "Drafts a test plan from acceptance criteria, edge cases included."),
    publicSkill("commit-message-style", "Commit message style", "Keeps commit subjects short, imperative and linked to a ticket."),
    publicSkill("release-notes-helper", "Release notes helper", "Groups merged changes into user-facing release notes."),
  );
  const writing = [...add(
    publicSkill("project-brief-writer", "Project brief writer", "Shapes an idea into a one-page brief with goals and non-goals."),
    publicSkill("plain-language-editor", "Plain language editor", "Rewrites dense passages at a readable level without losing meaning.", "authenticated"),
    publicSkill("onboarding-writer", "Onboarding guide writer", "Builds a first-week guide from team docs and checklists."),
  ), "release-notes-helper"];
  const runbooks = add(...Array.from({ length: 31 }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return publicSkill(`incident-runbook-${n}`, `Incident runbook ${n}`, `Restores service component ${n} after an alert.`);
  }));
  add(publicSkill("sql-style-guide", "SQL style guide", "Formats queries to a shared style and explains each change."));
  const bundles: FixtureBundle[] = [
    { id: "eng", kind: "source", name: "Engineering toolkit", purpose: "Review, test and ship code changes against one shared bar.", visibility: "public", revision: 3, owner: { type: "team", id: "team-platform", name: "Platform team" }, source: { entryId: "src-eng", repositoryId: "repo_4821", fullName: "example-org/eng-skills", path: "skills/engineering" }, members: engineering, canEdit: false, partial: false },
    { id: "writing", kind: "curated", name: "Clear writing kit", purpose: "Draft, tighten and announce work in plain, readable language.", visibility: "authenticated", revision: 7, owner: { type: "user", id: user.id, name: "Sam Rivera" }, source: null, members: writing, canEdit: true, partial: false },
    { id: "runbooks", kind: "source", name: "Incident runbooks", purpose: "Respond to production alerts with reviewed recovery steps.", visibility: "team", revision: 12, owner: { type: "team", id: "team-platform", name: "Platform team" }, source: { entryId: "src-ops", repositoryId: "repo_7710", fullName: "example-org/ops-runbooks", path: "runbooks" }, members: runbooks, canEdit: true, partial: true },
  ];
  return { skills, bundles };
}

async function installBundleFixture(page: Page, options: { catalogAvailable?: boolean; longDescription?: boolean } = {}) {
  const { skills, bundles } = seed();
  if (options.longDescription) {
    const skill = skills.get("code-review-checklist")!;
    skill.latestVersion = null;
    skill.summary = "Review a substantial change across its user flows, API contracts, data handling and failure paths. Check that permissions remain enforced and that unavailable releases never become a different version. Follow each affected caller and explain what users will observe. Record concrete evidence for every finding, distinguish blockers from optional improvements, and include a repeatable verification path. Finish with the release decision and the remaining risks so that the next reviewer can understand the change without reconstructing the entire investigation.";
  }
  const state = {
    writes: [] as Write[],
    catalogRequests: [] as Array<{ q: string; view: string; cursor: string | null }>,
    memberRequests: [] as Array<{ id: string; q: string; cursor: string | null }>,
    releaseFetches: [] as string[],
    legacySearches: 0,
    unhandled: [] as string[],
    revoked: new Set<string>(),
    failGet: new Set<string>(),
    failCatalog: false,
    changeOnCursor: false,
    failCatalogCursor: null as null | { status: number; code: string },
    failMembersCursor: null as null | { status: number; code: string },
    conflictNextPatch: false,
    hold: null as null | ((q: string) => boolean),
    held: [] as Array<() => void>,
    failMemberships: false,
    holdMemberships: false,
    heldMemberships: [] as Array<() => void>,
    savedEntry: null as null | Record<string, unknown>,
  };
  await page.addInitScript((session) => { if (location.origin !== "null") localStorage.setItem("myskills-app:web-session", JSON.stringify(session)); }, { expiresAt: "2027-09-26T00:00:00.000Z", user });

  const visible = () => bundles.filter((bundle) => !state.revoked.has(bundle.id));
  const membershipsOf = (slug: string) => visible().filter((bundle) => bundle.members.includes(slug)).map(({ id, name, kind }) => ({ id, name, kind }));
  const search = (raw: string) => {
    const q = raw.trim().toLowerCase();
    const hit = (text: string) => text.toLowerCase().includes(q);
    const direct = new Set([...skills.values()].filter((skill) => !q || hit(skill.title) || hit(skill.slug) || hit(skill.summary)).map((skill) => skill.slug));
    const groups = visible().flatMap((bundle) => {
      const title = Boolean(q) && [bundle.name, bundle.purpose, bundle.owner.name, bundle.source?.fullName ?? ""].some(hit);
      const hits = bundle.members.filter((slug) => direct.has(slug));
      if (q && !title && hits.length === 0) return [];
      const match = !q ? "all" : title && hits.length ? "all" : title ? "bundle" : "members";
      return [{ bundle, match, members: !q || title ? bundle.members : hits }];
    });
    const bundled = new Set(visible().flatMap((bundle) => bundle.members));
    const loose = [...direct].filter((slug) => !bundled.has(slug));
    const unique = new Set([...groups.flatMap((group) => group.members), ...loose]);
    return { groups, loose, unique, direct };
  };
  const summary = (bundle: FixtureBundle, match = "all") => ({
    id: bundle.id, name: bundle.name, kind: bundle.kind, purpose: bundle.purpose, visibility: bundle.visibility, revision: bundle.revision,
    owner: bundle.owner, source: bundle.source, memberCount: bundle.members.length, preview: bundle.members.slice(0, 4).map((slug) => ({ slug })), canEdit: bundle.canEdit, partial: bundle.partial, match, updatedAt: "2026-09-20T00:00:00Z",
  });
  const page_ = <T,>(items: T[], url: URL, scope: string) => {
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor ? Number(cursor.split("|")[1]) : 0;
    if (cursor && cursor.split("|")[0] !== scope) return null;
    const next = offset + limit < items.length ? `${scope}|${offset + limit}` : null;
    return { items: items.slice(offset, offset + limit), next };
  };
  const skillRow = (slug: string, direct: Set<string>) => ({ kind: "skill", skill: skills.get(slug)!, memberships: membershipsOf(slug), match: direct.has(slug) ? "skill" : "bundle" });

  await page.route("**/api/v1/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = route.request().method();
    const body: Record<string, unknown> = method === "GET" ? {} : route.request().postDataJSON() ?? {};
    if (method !== "GET") state.writes.push({ method, path, body });
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json }).catch(() => undefined);
    const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";

    if (path === "/v1/me") return reply({ user });
    if (path === "/v1/branding") return reply({ branding: { text: "MySkills", showText: true, logoDataUrl: null } });
    if (path === "/v1/teams") return reply({ teams: [docsTeam], invitations: [] });
    if (path === "/v1/skills") {
      state.legacySearches++;
      const found = search(q);
      return reply({ skills: [...found.direct].map((slug) => skills.get(slug)), nextCursor: null });
    }
    if (path === "/v1/registry/catalog") {
      if (options.catalogAvailable === false) return reply({ error: { code: "NOT_FOUND", message: "Not found." } }, 404);
      const view = url.searchParams.get("view") ?? "grouped";
      const cursor = url.searchParams.get("cursor");
      state.catalogRequests.push({ q, view, cursor });
      if (state.hold?.(q)) {
        await new Promise<void>((resolve) => state.held.push(resolve));
        const stale = { id: "stale", kind: "curated", name: "Stale bundle", purpose: "Must never render.", visibility: "public", revision: 1, owner: { type: "user", id: "x", name: "Nobody" }, source: null, memberCount: 1, canEdit: false, partial: false, match: "all", updatedAt: "2026-09-20T00:00:00Z" };
        return reply({ rows: [{ kind: "bundle", bundle: stale }], totalSkills: 99, totalBundles: 1, nextCursor: null, snapshot: "stale" });
      }
      if (state.failCatalog) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Catalog unavailable." } }, 503);
      if (cursor && state.changeOnCursor) return reply({ error: { code: "CATALOG_CHANGED", message: "The catalog changed." } }, 409);
      if (cursor && state.failCatalogCursor) return reply({ error: { code: state.failCatalogCursor.code, message: "Page unavailable." } }, state.failCatalogCursor.status);
      const found = search(q);
      // Bundle and skill rows share one page, as in the contract's catalog union.
      const rows: Array<Record<string, unknown>> = view === "list"
        ? [...found.unique].sort((a, b) => skills.get(a)!.title.localeCompare(skills.get(b)!.title)).map((slug) => skillRow(slug, found.direct))
        : [...found.groups.map((group) => ({ kind: "bundle", bundle: summary(group.bundle, group.match) })), ...found.loose.map((slug) => ({ kind: "skill", skill: skills.get(slug)!, memberships: [] }))];
      const paged = page_(rows, url, `${view}:${q}`);
      if (!paged) return reply({ error: { code: "INVALID_PAGE_CURSOR" } }, 400);
      return reply({ rows: paged.items, totalSkills: found.unique.size, totalBundles: found.groups.length, nextCursor: paged.next, snapshot: "snapshot-1" });
    }
    if (path === "/v1/bundle-sources") {
      return reply({ sources: [{ entryId: "src-docs", title: "docs-guild/handbook", repositoryId: "repo_3354", path: "skills", skills: ["onboarding-writer", "project-brief-writer"].map((slug) => skills.get(slug)) }] });
    }
    if (path === "/v1/bundles" && method === "POST") {
      const created: FixtureBundle = { id: `bundle-new-${bundles.length - 2}`, kind: body.kind as Kind, name: String(body.name), purpose: String(body.purpose), visibility: body.visibility as Visibility, revision: 1, owner: (body.owner as { type: string }).type === "team" ? { type: "team", id: docsTeam.id, name: docsTeam.name } : { type: "user", id: user.id, name: user.name }, source: body.kind === "source" ? { entryId: "src-docs", repositoryId: "repo_3354", fullName: "docs-guild/handbook", path: "skills" } : null, members: body.memberSlugs as string[], canEdit: true, partial: false };
      bundles.push(created);
      return reply({ bundle: summary(created) }, 201);
    }
    const bundleMatch = path.match(/^\/v1\/bundles\/([^/]+)(\/members|\/library-references)?$/);
    if (bundleMatch) {
      const bundle = visible().find((item) => item.id === bundleMatch[1]);
      if (!bundle) return reply({ error: { code: "BUNDLE_NOT_FOUND", message: "Bundle not found." } }, 404);
      if (bundleMatch[2] === "/members") {
        state.memberRequests.push({ id: bundle.id, q, cursor: url.searchParams.get("cursor") });
        if (url.searchParams.get("cursor") && state.failMembersCursor) return reply({ error: { code: state.failMembersCursor.code, message: "Page unavailable." } }, state.failMembersCursor.status);
        const found = search(q);
        const group = found.groups.find((item) => item.bundle.id === bundle.id);
        const members = (group?.members ?? []).map((slug) => ({ skill: skills.get(slug)!, memberships: membershipsOf(slug) }));
        const paged = page_(members, url, `members:${bundle.id}:${q}`)!;
        return reply({ skills: paged.items, total: members.length, nextCursor: paged.next, match: group?.match ?? "all" });
      }
      if (bundleMatch[2] === "/library-references") {
        const entry = { id: "entry-bundle-1", libraryId: body.libraryId, kind: "bundle", status: "active", revision: 1, title: bundle.name, bundle: { id: bundle.id, revisionSaved: bundle.revision, revision: bundle.revision, state: "available", memberCount: bundle.members.length }, adoption: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" };
        state.savedEntry = entry;
        return reply({ entry, replayed: false }, 201);
      }
      if (method === "PATCH") {
        if (state.conflictNextPatch) {
          state.conflictNextPatch = false;
          bundle.revision += 1;
          bundle.purpose = "Draft and tighten work in plain language.";
          return reply({ error: { code: "BUNDLE_REVISION_CONFLICT", message: "Bundle changed." } }, 409);
        }
        if (body.expectedRevision !== bundle.revision) return reply({ error: { code: "BUNDLE_REVISION_CONFLICT", message: "Bundle changed." } }, 409);
        Object.assign(bundle, { name: body.name ?? bundle.name, purpose: body.purpose ?? bundle.purpose, visibility: body.visibility ?? bundle.visibility, members: body.memberSlugs ?? bundle.members, revision: bundle.revision + 1 });
        return reply({ bundle: summary(bundle) });
      }
      if (state.failGet.has(bundle.id)) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable." } }, 503);
      return reply({ bundle: summary(bundle) });
    }
    const skillMatch = path.match(/^\/v1\/skills\/([^/]+)(\/bundles|\/releases(?:\/([^/]+))?)?$/);
    if (skillMatch && skills.has(skillMatch[1])) {
      const skill = skills.get(skillMatch[1])!;
      const releases = [release(skill, "1.2.0", "2026-09-10T00:00:00Z"), release(skill, "1.1.0", "2026-08-01T00:00:00Z")];
      if (skillMatch[2] === "/bundles") {
        if (state.holdMemberships) await new Promise<void>((resolve) => state.heldMemberships.push(resolve));
        if (state.failMemberships) return reply({ error: { code: "SERVICE_UNAVAILABLE", message: "Unavailable." } }, 503);
        return reply({ bundles: membershipsOf(skill.slug) });
      }
      if (skillMatch[3]) {
        state.releaseFetches.push(`${skill.slug}@${skillMatch[3]}`);
        const found = releases.find((item) => item.version === skillMatch[3]);
        return found ? reply({ release: found }) : reply({ error: { code: "NOT_FOUND" } }, 404);
      }
      if (skillMatch[2]) return reply({ releases: releases.map((item) => ({ ...item, id: `release-${item.version}`, findingCount: 0, allowedActions: [] })) });
      return reply({ skill });
    }
    if (path === "/v1/libraries") {
      // Two pages, so the save dialog must page instead of silently stopping.
      if (url.searchParams.get("cursor") === "libraries|1") {
        return reply({ libraries: [
          { id: "lib-support", name: "Support team", description: "", owner: { type: "team", id: "team-support" }, status: "active", revision: 1, access: { role: "member", canWrite: false, canImport: false, canTrackSources: false }, subscription: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ], nextCursor: null });
      }
      return reply({ libraries: [
        { id: "lib-planning", name: "Planning tools", description: "", owner: { type: "user", id: user.id }, status: "active", revision: 1, access: { role: "owner", canWrite: true, canImport: true, canTrackSources: true }, subscription: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: "libraries|1" });
    }
    if (path === "/v1/libraries/lib-planning") return reply({ library: { id: "lib-planning", name: "Planning tools", description: "", owner: { type: "user", id: user.id }, status: "active", revision: 1, access: { role: "owner", canWrite: true, canImport: true, canTrackSources: true }, subscription: null } });
    if (path === "/v1/libraries/lib-planning/entries") {
      const unavailable = { id: "entry-bundle-gone", libraryId: "lib-planning", kind: "bundle", status: "active", revision: 1, title: "Unavailable bundle", bundle: { id: "bundle-gone", revisionSaved: 2, revision: null, state: "unavailable", memberCount: null }, adoption: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
      const saved = state.savedEntry ? [{ ...state.savedEntry, bundle: { ...(state.savedEntry.bundle as object), revision: 8 } }] : [];
      return reply({ entries: [...saved, unavailable], nextCursor: null });
    }
    if (path === "/v1/library-inbox") return reply({ items: [], unreadCount: 0, nextCursor: null });
    state.unhandled.push(`${method} ${path}`);
    return reply({ error: { code: "NOT_FOUND", message: `Unimplemented bundle fixture: ${method} ${path}` } }, 404);
  });
  return state;
}

const summaryText = (page: Page) => page.getByText(/unique skills? ·|Nothing matches/).first();
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const disclosure = (page: Page, name: string) => region(page, name).getByRole("button", { name, exact: true });

async function pickVersion(scope: Locator, version: string) {
  const card = scope.getByRole("region", { name: "Release", exact: true });
  await card.getByRole("button", { name: /^Versions/ }).click();
  await card.getByRole("list", { name: "Published versions" }).getByRole("button", { name: new RegExp(`^${version.replaceAll(".", "\\.")}(\\s|$)`) }).click();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test("overlapping bundles keep one unique count across Grouped, List and Outline", async ({ page }, testInfo) => {
  const api = await installBundleFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/registry");
  await expect(page.getByRole("heading", { name: "Skills", exact: true, level: 1 })).toBeVisible();
  await expect(summaryText(page)).toContainText("40 unique skills · 3 bundles");
  const views = page.getByRole("group", { name: "Catalog view" });
  await expect(views.getByRole("button", { name: "Grouped", exact: true })).toHaveAttribute("aria-pressed", "true");

  const engineering = region(page, "Engineering toolkit");
  const writing = region(page, "Clear writing kit");
  await expect(engineering.getByText("Source group", { exact: true })).toBeVisible();
  await expect(engineering.getByText("From example-org/eng-skills · skills/engineering")).toBeVisible();
  await expect(engineering.getByText("5 skills", { exact: true })).toBeVisible();
  await expect(writing.getByText("Curated", { exact: true })).toBeVisible();
  await expect(writing.getByText("Curated by Sam Rivera · revision 7")).toBeVisible();

  // The name is a disclosure; Details is a separate control.
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "true");
  await expect(engineering.getByRole("link", { name: "Release notes helper", exact: true })).toBeVisible();
  await expect(engineering.getByText("Also in Clear writing kit")).toBeVisible();
  const writingToggle = disclosure(page, "Clear writing kit");
  await expect(writingToggle).toHaveAttribute("aria-expanded", "false");
  await writingToggle.focus();
  await page.keyboard.press("Enter");
  await expect(writingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(writing.getByRole("link", { name: "Release notes helper", exact: true })).toBeVisible();
  await expect(writing.getByText("Also in Engineering toolkit")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(writingToggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(writingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(writing.getByRole("button", { name: "Details for Clear writing kit", exact: true })).toBeVisible();

  // A large source group pages its members separately from the top-level rows.
  const runbooks = region(page, "Incident runbooks");
  await expect(runbooks.getByText("31 skills shown", { exact: true })).toBeVisible();
  await expect(runbooks.getByText("Some skills in this bundle aren’t available to your account, so they aren’t listed.")).toBeVisible();
  await disclosure(page, "Incident runbooks").click();
  const runbookLinks = runbooks.getByRole("link", { name: /^Incident runbook \d\d$/ });
  await expect(runbookLinks).toHaveCount(25);
  await expect(runbooks.getByText("Showing 25 of 31")).toBeVisible();
  await runbooks.getByRole("button", { name: "Show more members in Incident runbooks", exact: true }).click();
  await expect(runbookLinks).toHaveCount(31);
  await expect(runbooks.getByRole("button", { name: /Show more members/ })).toHaveCount(0);
  expect(api.memberRequests.filter((item) => item.id === "runbooks").map((item) => item.cursor)).toEqual([null, "members:runbooks:|25"]);

  await expect(page.getByRole("heading", { name: "Not in a bundle", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "SQL style guide", exact: true })).toBeVisible();
  expect(api.releaseFetches).toEqual([]);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("bundles-grouped-1440.png"), fullPage: true });

  await views.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?view=list$/);
  await expect(summaryText(page)).toContainText("40 unique skills · 3 bundles");
  const rows = page.getByRole("list", { name: "Skills", exact: true }).getByRole("listitem");
  await expect(rows).toHaveCount(25);
  await expect(page.getByText("Showing 25 of 40 skills")).toBeVisible();
  await page.getByRole("button", { name: "Load more results", exact: true }).click();
  await expect(rows).toHaveCount(40);
  const releaseRow = rows.filter({ has: page.getByRole("link", { name: "Release notes helper", exact: true }) });
  await expect(releaseRow).toHaveCount(1);
  await expect(releaseRow.getByRole("link", { name: /Engineering toolkit/ })).toHaveAttribute("href", "/registry?view=list&bundle=eng");
  await expect(releaseRow.getByRole("link", { name: /Clear writing kit/ })).toBeVisible();
  await expect(rows.filter({ hasText: "SQL style guide" }).getByText("No bundle", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("bundles-list-1440.png"), fullPage: true });

  await views.getByRole("button", { name: "Outline", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?view=outline$/);
  await expect(summaryText(page)).toContainText("40 unique skills · 3 bundles");
  await expect(page.getByRole("button", { name: /^Source groups/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^Curated bundles/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^Not in a bundle/ })).toBeVisible();
  // Expansion is shared with Grouped.
  await expect(page.getByRole("button", { name: /^Clear writing kit/ })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: /^Engineering toolkit/ })).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: testInfo.outputPath("bundles-outline-1440.png"), fullPage: true });

  await page.goBack();
  await expect(views.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/registry$/);
  await expect(views.getByRole("button", { name: "Grouped", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(views.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(api.legacySearches).toBe(0);
  await testInfo.attach("bundle-views-receipt", { body: JSON.stringify({ catalogRequests: api.catalogRequests, memberRequests: api.memberRequests, unhandled: api.unhandled }, null, 2), contentType: "application/json" });
});

test("search opens member matches, labels title matches and clearing restores expansion", async ({ page }) => {
  const api = await installBundleFixture(page);
  await page.goto("/registry");
  const search = page.getByLabel("Search skills and bundles");
  const engineering = region(page, "Engineering toolkit");
  const writing = region(page, "Clear writing kit");
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "true");
  // The reader's own choices before searching.
  await disclosure(page, "Engineering toolkit").click();
  await disclosure(page, "Clear writing kit").click();
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "false");
  await expect(disclosure(page, "Clear writing kit")).toHaveAttribute("aria-expanded", "true");

  await search.fill("release");
  await expect(page).toHaveURL(/\/registry\?q=release$/);
  await expect(summaryText(page)).toContainText("Matches for “release”: 1 unique skill · 2 bundles");
  await expect(summaryText(page)).toContainText("counted once");
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "true");
  await expect(engineering.getByText("1 of 5 skills match")).toBeVisible();
  await expect(engineering.getByRole("link", { name: "Release notes helper", exact: true })).toBeVisible();
  await expect(engineering.getByRole("link", { name: "Code review checklist", exact: true })).toHaveCount(0);
  await expect(region(page, "Incident runbooks")).toHaveCount(0);
  // A search-time override, dropped when the query clears.
  await disclosure(page, "Clear writing kit").click();
  await expect(disclosure(page, "Clear writing kit")).toHaveAttribute("aria-expanded", "false");

  const views = page.getByRole("group", { name: "Catalog view" });
  await views.getByRole("button", { name: "List", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?q=release&view=list$/);
  await expect(search).toHaveValue("release");
  await expect(summaryText(page)).toContainText("1 unique skill · 2 bundles");
  await search.fill("announce");
  const rows = page.getByRole("list", { name: "Skills", exact: true }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: "Listed because its bundle matches" })).toHaveCount(4);
  await views.getByRole("button", { name: "Grouped", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?q=announce$/);
  await expect(writing.getByText("Bundle name or purpose matches · all skills shown")).toBeVisible();
  await expect(writing.getByRole("link", { name: "Onboarding guide writer", exact: true })).toBeVisible();

  await search.fill("zzz");
  await expect(page.getByText("Nothing matches “zzz”.")).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(page).toHaveURL(/\/registry$/);
  await expect(summaryText(page)).toContainText("40 unique skills · 3 bundles");
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "false");
  await expect(disclosure(page, "Clear writing kit")).toHaveAttribute("aria-expanded", "true");
  expect(api.catalogRequests.map((item) => item.q)).toEqual(expect.arrayContaining(["release", "announce", "zzz"]));
  expect(api.legacySearches).toBe(0);
});

test("bundle detail links both ways and saving a reference adopts nothing", async ({ page }, testInfo) => {
  const api = await installBundleFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/registry");
  await region(page, "Clear writing kit").getByRole("button", { name: "Details for Clear writing kit", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?bundle=writing$/);
  const inspector = page.getByRole("complementary", { name: "Clear writing kit", exact: true });
  await expect(inspector.getByRole("heading", { name: "Clear writing kit", level: 2 })).toBeVisible();
  await expect(inspector.getByText("Curated by Sam Rivera")).toBeVisible();
  await expect(inspector.getByRole("heading", { name: /^Skills in this bundle/ })).toBeVisible();
  await expect(inspector.getByRole("link", { name: "Release notes helper", exact: true })).toBeVisible();
  // Selecting a bundle never loads skill release metadata.
  expect(api.releaseFetches).toEqual([]);

  const save = inspector.getByRole("button", { name: "Save bundle to library", exact: true });
  await save.click();
  const dialog = page.getByRole("dialog", { name: "Save “Clear writing kit” to a library" });
  await expect(dialog.getByRole("radio", { name: /Planning tools/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Load more libraries", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Load more libraries", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /Support team/ })).toHaveCount(0);
  await expect(dialog).toContainText("Saving does not adopt, install or follow updates.");
  await dialog.getByRole("radio", { name: /Planning tools/ }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();
  expect(api.writes).toEqual([]);
  await save.press("Enter");
  await dialog.getByRole("button", { name: "Save reference", exact: true }).click();
  await expect(inspector.getByText("Saved to Planning tools as a reference. Nothing was adopted, installed or set to follow updates.")).toBeVisible();
  expect(api.writes).toEqual([{ method: "POST", path: "/v1/bundles/writing/library-references", body: { libraryId: "lib-planning", expectedRevision: 7 } }]);

  await inspector.getByRole("link", { name: "Release notes helper", exact: true }).click();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper$/);
  const skillPanel = page.getByRole("complementary", { name: "Selected skill detail" });
  await expect(skillPanel.getByRole("heading", { name: "Release notes helper", exact: true })).toBeVisible();
  await expect(skillPanel.getByText(/myskills export 'release-notes-helper' --version '1\.2\.0'/)).toBeVisible();
  const backlinks = skillPanel.getByRole("region", { name: "Bundles containing this skill" });
  await expect(backlinks.getByRole("link", { name: /Engineering toolkit/ })).toHaveAttribute("href", "/registry?bundle=eng");
  await expect(backlinks.getByRole("link", { name: /Clear writing kit/ })).toBeVisible();
  await pickVersion(skillPanel, "1.1.0");
  await expect(page).toHaveURL(/\/skills\/release-notes-helper\?version=1\.1\.0$/);
  await skillPanel.getByRole("button", { name: "Release notes", exact: true }).click();
  await expect(skillPanel.getByText("Release notes for Release notes helper 1.1.0.")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/release-notes-helper$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/registry\?bundle=writing$/);
  await expect(page.getByRole("complementary", { name: "Clear writing kit", exact: true })).toBeVisible();

  await page.goto("/libraries");
  await page.getByRole("button", { name: "Clear writing kit", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open in Skills", exact: true })).toHaveAttribute("href", "/registry?bundle=writing");
  await expect(page.getByText("Saved at revision 7 · now revision 8")).toBeVisible();
  await page.getByRole("button", { name: "Unavailable bundle", exact: true }).click();
  await expect(page.getByText(/^You no longer have access to this bundle, or it was removed\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /adopt/i })).toHaveCount(0);
  await expect(page.getByText("Connect an existing target")).toHaveCount(0);
  expect(api.writes.filter((write) => /adoption|binding/.test(write.path))).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("library-bundle-reference.png"), fullPage: true });
  await testInfo.attach("bundle-save-receipt", { body: JSON.stringify({ writes: api.writes, releaseFetches: api.releaseFetches, unhandled: api.unhandled }, null, 2), contentType: "application/json" });
});

// Written before the second skill pane: backlinks move below the release card
// and an empty answer must not claim the skill stands alone.
test("skill backlinks keep none, loading, failure and retry distinct below the release", async ({ page }, testInfo) => {
  const api = await installBundleFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  api.holdMemberships = true;
  await page.goto("/skills/sql-style-guide");
  const skillPanel = page.getByRole("complementary", { name: "Selected skill detail" });
  const backlinks = skillPanel.getByRole("region", { name: "Bundles containing this skill" });
  await expect(backlinks.getByText("Checking bundles…")).toBeVisible();
  // The exact release does not wait for bundle membership.
  await expect(skillPanel.getByText(/myskills export 'sql-style-guide' --version '1\.2\.0'/)).toBeVisible();
  api.holdMemberships = false;
  api.heldMemberships.splice(0).forEach((resume) => resume());
  await expect(backlinks).toContainText("None visible to you");
  await expect(skillPanel.getByText(/on its own|Not in any bundle/)).toHaveCount(0);
  const card = (await skillPanel.getByRole("region", { name: "Release", exact: true }).boundingBox())!;
  expect((await backlinks.boundingBox())!.y).toBeGreaterThanOrEqual(card.y + card.height);

  api.failMemberships = true;
  await page.goto("/skills/release-notes-helper");
  await expect(backlinks.getByText("Bundles couldn’t load.")).toBeVisible();
  await expect(backlinks.getByRole("link")).toHaveCount(0);
  await expect(backlinks).not.toContainText("None visible to you");
  api.failMemberships = false;
  await backlinks.getByRole("button", { name: "Retry bundles", exact: true }).click();
  await expect(backlinks.getByRole("link", { name: "Engineering toolkit", exact: true })).toHaveAttribute("href", "/registry?bundle=eng");
  await expect(backlinks.getByRole("listitem").filter({ hasText: "Engineering toolkit" })).toContainText("Source group");
  await expect(backlinks.getByRole("listitem").filter({ hasText: "Clear writing kit" })).toContainText("Curated");
  await page.screenshot({ path: testInfo.outputPath("skill-backlinks.png"), fullPage: true });
  await backlinks.getByRole("link", { name: "Clear writing kit", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?bundle=writing$/);
  await expect(page.getByRole("complementary", { name: "Clear writing kit", exact: true })).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("curator creates reviewed bundles and resolves an edit conflict", async ({ page }) => {
  const api = await installBundleFixture(page);
  await page.goto("/registry");
  await page.getByRole("button", { name: "New bundle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New bundle" });
  await dialog.getByLabel("Name", { exact: true }).fill("Docs launch kit");
  await dialog.getByLabel("Purpose", { exact: true }).fill("Write and announce documentation changes.");
  await dialog.getByLabel("Owner", { exact: true }).selectOption({ label: "Docs guild" });
  await dialog.getByLabel("Audience", { exact: true }).selectOption("public");
  await dialog.getByLabel("Find skills to add").fill("plain");
  await dialog.getByRole("checkbox", { name: "Plain language editor", exact: true }).check();
  await dialog.getByLabel("Find skills to add").fill("brief");
  await dialog.getByRole("checkbox", { name: "Project brief writer", exact: true }).check();
  await expect(dialog.getByRole("list", { name: "Selected skills" }).getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByText("Public bundles can only include public skills.")).toBeVisible();
  const reviewed = dialog.getByLabel("I reviewed the audience and selected skills");
  await reviewed.check();
  await expect(dialog.getByRole("button", { name: "Create bundle", exact: true })).toBeDisabled();
  await dialog.getByLabel("Audience", { exact: true }).selectOption("team");
  await expect(reviewed).not.toBeChecked();
  await reviewed.check();
  await dialog.getByRole("button", { name: "Create bundle", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/registry\?bundle=bundle-new-1$/);
  await expect(page.getByRole("complementary", { name: "Docs launch kit", exact: true })).toBeVisible();
  expect(api.writes[0]).toEqual({ method: "POST", path: "/v1/bundles", body: { kind: "curated", name: "Docs launch kit", purpose: "Write and announce documentation changes.", owner: { type: "team", id: "team-docs" }, visibility: "team", memberSlugs: ["plain-language-editor", "project-brief-writer"] } });

  await page.getByRole("button", { name: "New bundle", exact: true }).click();
  await dialog.getByRole("radio", { name: "Source group", exact: true }).check();
  await dialog.getByLabel("Reviewed source").selectOption({ label: "docs-guild/handbook · skills" });
  await dialog.getByRole("checkbox", { name: "Onboarding guide writer", exact: true }).check();
  await dialog.getByLabel("Name", { exact: true }).fill("Handbook guides");
  await dialog.getByLabel("Purpose", { exact: true }).fill("Guides declared by the docs handbook.");
  await dialog.getByLabel("Audience", { exact: true }).selectOption("authenticated");
  await dialog.getByLabel("I reviewed the audience and selected skills").check();
  await dialog.getByRole("button", { name: "Create bundle", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.writes[1]).toMatchObject({ method: "POST", path: "/v1/bundles", body: { kind: "source", sourceEntryId: "src-docs", memberSlugs: ["onboarding-writer"], visibility: "authenticated" } });

  await page.goto("/registry?bundle=writing");
  const inspector = page.getByRole("complementary", { name: "Clear writing kit", exact: true });
  await inspector.getByRole("button", { name: "Edit bundle", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit Clear writing kit" });
  await expect(edit.getByLabel("Purpose", { exact: true })).toHaveValue("Draft, tighten and announce work in plain, readable language.");
  const selected = edit.getByRole("list", { name: "Selected skills" }).getByRole("listitem");
  await expect(selected).toHaveCount(4);
  await edit.getByRole("button", { name: "Remove Onboarding guide writer", exact: true }).click();
  await expect(selected).toHaveCount(3);
  api.conflictNextPatch = true;
  await edit.getByLabel("I reviewed the audience and selected skills").check();
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit.getByRole("alert")).toContainText("This bundle changed since you opened it");
  await edit.getByRole("button", { name: "Load current version", exact: true }).click();
  await expect(edit.getByLabel("Purpose", { exact: true })).toHaveValue("Draft and tighten work in plain language.");
  await expect(selected).toHaveCount(4);
  await edit.getByRole("button", { name: "Remove Onboarding guide writer", exact: true }).click();
  await edit.getByLabel("I reviewed the audience and selected skills").check();
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit).toBeHidden();
  const patches = api.writes.filter((write) => write.method === "PATCH");
  expect(patches.map((write) => write.body.expectedRevision)).toEqual([7, 8]);
  expect(patches[1].body).toMatchObject({ memberSlugs: ["project-brief-writer", "plain-language-editor", "release-notes-helper"] });
});

test("late responses and lost access never leave stale results or detail", async ({ page }) => {
  const api = await installBundleFixture(page);
  await page.goto("/registry");
  const search = page.getByLabel("Search skills and bundles");
  api.hold = (q) => q === "rel";
  await search.fill("rel");
  await expect.poll(() => api.held.length).toBe(1);
  await search.fill("writing");
  await expect(summaryText(page)).toContainText("Matches for “writing”");
  api.held.shift()!();
  await expect(region(page, "Clear writing kit")).toBeVisible();
  await expect(page.getByText("Stale bundle")).toHaveCount(0);
  await expect(summaryText(page)).not.toContainText("99");
  api.hold = null;

  await search.fill("");
  await region(page, "Clear writing kit").getByRole("button", { name: "Details for Clear writing kit", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Clear writing kit", exact: true })).toBeVisible();
  api.failGet.add("eng");
  await region(page, "Engineering toolkit").getByRole("button", { name: "Details for Engineering toolkit", exact: true }).click();
  await expect(page).toHaveURL(/\/registry\?bundle=eng$/);
  const failed = page.getByRole("complementary", { name: "Bundle detail", exact: true });
  await expect(failed).toContainText("This bundle couldn’t load.");
  await expect(failed).not.toContainText("Sam Rivera");
  api.failGet.delete("eng");
  await page.getByRole("button", { name: "Retry bundle", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Engineering toolkit", exact: true })).toBeVisible();

  api.revoked.add("writing");
  await page.goto("/registry?bundle=writing");
  await expect(page.getByRole("heading", { name: "Bundle unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Clear writing kit")).toHaveCount(0);
  // Its members stay visible as ordinary skills; the unique total is unchanged.
  await expect(summaryText(page)).toContainText("40 unique skills · 2 bundles");

  api.failCatalog = true;
  await search.fill("runbook");
  await expect(page.getByRole("alert")).toContainText("The catalog couldn’t load.");
  await expect(region(page, "Incident runbooks")).toHaveCount(0);
  api.failCatalog = false;
  await page.getByRole("button", { name: "Retry catalog", exact: true }).click();
  await expect(region(page, "Incident runbooks")).toBeVisible();

  // A changed snapshot can include revoked access, so loaded rows, totals and
  // bundle member pages must not survive it.
  const runbookMemberReads = () => api.memberRequests.filter((item) => item.id === "runbooks" && item.q === "runbook" && item.cursor === null).length;
  await expect(region(page, "Incident runbooks").getByRole("link", { name: /^Incident runbook \d\d$/ })).toHaveCount(25);
  const membersBefore = runbookMemberReads();
  expect(membersBefore).toBeGreaterThan(0);
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "List", exact: true }).click();
  const listRows = page.getByRole("list", { name: "Skills", exact: true }).getByRole("listitem");
  await expect(listRows).toHaveCount(25);
  api.changeOnCursor = true;
  await page.getByRole("button", { name: "Load more results", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The catalog changed while you were browsing.");
  await expect(listRows).toHaveCount(0);
  await expect(page.getByText(/unique skills? ·/)).toHaveCount(0);
  await expect(page.getByText("Incident runbook 01")).toHaveCount(0);
  api.changeOnCursor = false;
  await page.getByRole("button", { name: "Refresh results", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(listRows).toHaveCount(25);
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Grouped", exact: true }).click();
  await expect(region(page, "Incident runbooks").getByRole("link", { name: /^Incident runbook \d\d$/ })).toHaveCount(25);
  await expect.poll(runbookMemberReads).toBeGreaterThan(membersBefore);
});

// Written before the fix: a failed member or catalog page must not leave names
// the reader may no longer be allowed to see, and must offer a way forward.
test("member and page access failures clear names that may no longer be visible", async ({ page }) => {
  const api = await installBundleFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/registry");
  const runbooks = region(page, "Incident runbooks");
  const railLinks = runbooks.getByRole("link", { name: /^Incident runbook \d\d$/ });
  await disclosure(page, "Incident runbooks").click();
  await expect(railLinks).toHaveCount(25);

  api.failMembersCursor = { status: 409, code: "CATALOG_CHANGED" };
  await runbooks.getByRole("button", { name: "Show more members in Incident runbooks", exact: true }).click();
  await expect(runbooks.getByRole("alert")).toContainText("This bundle changed while you were browsing.");
  await expect(railLinks).toHaveCount(0);
  api.failMembersCursor = null;
  await runbooks.getByRole("button", { name: "Refresh skills in Incident runbooks", exact: true }).click();
  await expect(railLinks).toHaveCount(25);

  api.failMembersCursor = { status: 403, code: "BUNDLE_ACCESS_DENIED" };
  await runbooks.getByRole("button", { name: "Show more members in Incident runbooks", exact: true }).click();
  await expect(runbooks.getByRole("alert")).toContainText("You no longer have access to this bundle’s skills.");
  await expect(railLinks).toHaveCount(0);
  await expect(page.getByText("Incident runbook 01")).toHaveCount(0);
  api.failMembersCursor = null;
  api.revoked.add("runbooks");
  await runbooks.getByRole("button", { name: "Refresh results", exact: true }).click();
  await expect(region(page, "Incident runbooks")).toHaveCount(0);
  api.revoked.delete("runbooks");

  await page.goto("/registry?bundle=runbooks");
  const detail = page.getByRole("complementary", { name: "Incident runbooks", exact: true });
  const detailLinks = detail.getByRole("link", { name: /^Incident runbook \d\d$/ });
  await expect(detailLinks).toHaveCount(25);
  api.failMembersCursor = { status: 409, code: "CATALOG_CHANGED" };
  await detail.getByRole("button", { name: "Show more members in Incident runbooks", exact: true }).click();
  await expect(detail.getByRole("alert")).toContainText("This bundle changed while you were browsing.");
  await expect(detailLinks).toHaveCount(0);
  api.failMembersCursor = null;
  await detail.getByRole("button", { name: "Refresh bundle", exact: true }).click();
  await expect(detailLinks).toHaveCount(25);
  api.failMembersCursor = { status: 404, code: "BUNDLE_NOT_FOUND" };
  await detail.getByRole("button", { name: "Show more members in Incident runbooks", exact: true }).click();
  const denied = page.getByRole("complementary", { name: "Bundle unavailable", exact: true });
  await expect(denied.getByRole("heading", { name: "Bundle unavailable", exact: true })).toBeVisible();
  await expect(denied).not.toContainText("Respond to production alerts");
  await expect(denied).not.toContainText("Incident runbook");
  api.failMembersCursor = null;

  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "List", exact: true }).click();
  const rows = page.getByRole("list", { name: "Skills", exact: true }).getByRole("listitem");
  await expect(rows).toHaveCount(25);
  api.failCatalogCursor = { status: 403, code: "CATALOG_ACCESS_DENIED" };
  await page.getByRole("button", { name: "Load more results", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your access changed");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Code review checklist")).toHaveCount(0);
  api.failCatalogCursor = null;
  await page.getByRole("button", { name: "Retry catalog", exact: true }).click();
  await expect(rows).toHaveCount(25);
});

test("narrow screens show list then detail with Back focus restore and no overflow", async ({ page }, testInfo) => {
  await installBundleFixture(page);
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/registry?bundle=writing");
    await expect(page.getByRole("complementary", { name: "Clear writing kit", exact: true })).toBeVisible();
    await expect(region(page, "Engineering toolkit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to skills" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`bundles-detail-${width}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/registry");
  await expect(region(page, "Clear writing kit")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inspect before you save" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("bundles-grouped-390.png"), fullPage: true });
  const details = region(page, "Clear writing kit").getByRole("button", { name: "Details for Clear writing kit", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Clear writing kit", level: 2 })).toBeFocused();
  await expect(region(page, "Engineering toolkit")).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("bundles-detail-390.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to skills", exact: true }).click();
  await expect(details).toBeFocused();

  const member = region(page, "Engineering toolkit").getByRole("link", { name: "Release notes helper", exact: true });
  await member.click();
  await expect(page.getByRole("complementary", { name: "Selected skill detail" }).getByRole("heading", { name: "Release notes helper", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to skills", exact: true }).click();
  await expect(member).toBeFocused();

  await page.setViewportSize({ width: 320, height: 720 });
  await expectNoHorizontalOverflow(page);
  await page.getByRole("group", { name: "Catalog view" }).getByRole("button", { name: "Outline", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("bundles-outline-320.png"), fullPage: true });
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search skills and bundles")).toBeFocused();
});

test("a server without the bundle catalog keeps the flat registry", async ({ page }) => {
  const api = await installBundleFixture(page, { catalogAvailable: false });
  await page.goto("/skills/release-notes-helper");
  await expect(page.getByRole("heading", { name: "Release notes helper", exact: true })).toBeVisible();
  await expect(page.getByLabel("Search skills", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Catalog view" })).toHaveCount(0);
  await expect.poll(() => api.legacySearches).toBeGreaterThan(0);
  expect(api.writes).toEqual([]);
});

// Follow-up acceptance written before implementation: the previous bundle grid
// leaves release metadata in a separate column and cancels inspector spacing.
for (const width of [1440, 390]) test(`skill row refinements preserve descriptions and exact releases at ${width}`, async ({ page }, info) => {
  const state = await installBundleFixture(page, { longDescription: true });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/registry");
  await expect(disclosure(page, "Engineering toolkit")).toHaveAttribute("aria-expanded", "true");
  const row = region(page, "Engineering toolkit").locator(".bundle-member").filter({ has: page.getByRole("link", { name: "Code review checklist", exact: true }) });
  await expect(row).toBeVisible();
  await page.screenshot({ path: info.outputPath("registry-grouped.png"), fullPage: true });
  const name = row.locator(".bundle-skill-name");
  const version = row.getByText("No release", { exact: true });
  const titleBox = (await name.boundingBox())!;
  const versionBox = (await version.boundingBox())!;
  expect(versionBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
  expect(Math.abs(versionBox.x - titleBox.x)).toBeLessThanOrEqual(2);
  const more = row.getByRole("button", { name: /Show more/ });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  const description = page.locator(`[id="${await more.getAttribute("aria-controls")}"]`);
  const collapsedHeight = (await description.boundingBox())!.height;
  const lineHeight = await description.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
  expect(Math.abs(collapsedHeight - lineHeight * 3)).toBeLessThanOrEqual(2);
  await more.focus();
  await page.keyboard.press("Enter");
  const less = row.getByRole("button", { name: /Show less/ });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(collapsedHeight);
  await expect(less).toBeFocused();
  await expect(page).toHaveURL(/\/registry/);
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => (await description.boundingBox())!.height).toBe(collapsedHeight);
  await expect(page.locator(".bundle-member").filter({ has: page.getByRole("link", { name: "SQL style guide", exact: true }) }).getByRole("button", { name: /Show more/ })).toHaveCount(0);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const listRow = page.locator(".bundle-list-row").filter({ has: page.getByRole("link", { name: "Code review checklist", exact: true }) });
  await expect(listRow.getByRole("button", { name: /Show more/ })).toBeVisible();
  const listName = (await listRow.locator(".bundle-skill-name").boundingBox())!;
  const listVersion = (await listRow.getByText("No release", { exact: true }).boundingBox())!;
  expect(listVersion.y).toBeGreaterThanOrEqual(listName.y + listName.height);
  expect(Math.abs(listVersion.x - listName.x)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath("registry-list.png"), fullPage: true });
  await listRow.getByRole("link", { name: "Code review checklist", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Selected skill detail" });
  await expect(inspector.getByRole("heading", { name: "No default stable release" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("registry-no-release.png"), fullPage: true });
  await pickVersion(inspector, "1.1.0");
  await expect(page.getByText(/myskills export 'code-review-checklist' --version '1.1.0'/)).toBeVisible();
  expect(state.releaseFetches).toContain("code-review-checklist@1.1.0");
  expect(state.writes).toEqual([]);
  await expectNoHorizontalOverflow(page);
});

for (const width of [1440, 1280, 390, 320]) test(`skill inspector spacing separates the no-release state at ${width}`, async ({ page }, info) => {
  await installBundleFixture(page, { longDescription: true });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/skills/code-review-checklist");
  const inspector = page.getByRole("complementary", { name: "Selected skill detail" });
  await expect(inspector.getByRole("heading", { name: "No default stable release" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("registry-inspector-spacing.png"), fullPage: true });
  const header = (await inspector.locator(".registry-inspector-head").boundingBox())!;
  const notice = (await inspector.locator(".registry-inspector-state").boundingBox())!;
  const panel = (await inspector.boundingBox())!;
  expect(header.x - panel.x).toBeGreaterThanOrEqual(15);
  expect(notice.y - header.y - header.height).toBeGreaterThanOrEqual(16);
  if (width === 1280) {
    const row = region(page, "Engineering toolkit").locator(".bundle-member").filter({ has: page.getByRole("link", { name: "Code review checklist", exact: true }) });
    const name = (await row.locator(".bundle-member-name").boundingBox())!;
    const description = (await row.locator(".bundle-description").boundingBox())!;
    expect(description.y).toBeGreaterThanOrEqual(name.y + name.height);
    expect(description.width).toBeGreaterThanOrEqual((await row.boundingBox())!.width - 22);
  }
});
