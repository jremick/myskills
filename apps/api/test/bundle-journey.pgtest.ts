/** Authored before implementation. HTTP + real Postgres proof for overlap,
 * pagination, current access, optimistic revision, source evidence and references.
 * The fixture has 31 members so no first-page grouping can accidentally pass. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createDb, createPgPool } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { BundleService } from "../src/bundles/service.js";
import {
  LibraryService,
  PostgresLibraryStore,
  PublicGithubSourceProvider,
} from "../src/libraries/index.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
// HTTP response shapes are deliberately verified independently of production types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

test(
  "bundles HTTP journey: overlapping pages, audience changes, revisions and reference-only saves",
  { timeout: 90_000 },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL;
    assert.ok(url);
    assert.match(new URL(url).pathname, /(?:_|\/)(?:test|ci)(?:_|$)/i);
    const pool = createPgPool(url);
    t.after(() => pool.end());
    await pool.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public",
    );
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pool.query(readFileSync(`${dir}/${file}`, "utf8"));
    const db = createDb(pool);
    const owner = randomUUID(),
      reader = randomUUID(),
      team = randomUUID();
    for (const [id, name] of [
      [owner, "curator"],
      [reader, "reader"],
    ]) {
      await pool.query(
        "INSERT INTO users (id,email,normalized_email,name,status,email_verified_at) VALUES ($1,$2,$2,$3,'active',now())",
        [id, `${name}@example.test`, name],
      );
      await pool.query(
        "INSERT INTO password_credentials (user_id,password_hash) VALUES ($1,$2)",
        [id, await hashPassword("bundle fixture password")],
      );
      await pool.query(
        "INSERT INTO role_assignments (user_id,role) VALUES ($1,'author')",
        [id],
      );
    }
    await pool.query(
      "INSERT INTO teams (id,name,slug,created_by_user_id) VALUES ($1,'Build team','build-team',$2)",
      [team, owner],
    );
    await pool.query(
      "INSERT INTO team_memberships(team_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')",
      [team, owner, reader],
    );
    const slugs = Array.from(
      { length: 31 },
      (_, i) => `bundle-skill-${String(i).padStart(2, "0")}`,
    );
    for (const slug of [...slugs, "secret-member", "standalone"]) {
      const skillId = randomUUID(),
        versionId = randomUUID();
      await pool.query(
        "INSERT INTO skills(id,slug,title,summary,lifecycle_status,visibility,owner_user_id) VALUES ($1,$2,$2,'Useful engineering skill','approved',$3,$4)",
        [skillId, slug, slug === "secret-member" ? "private" : "public", owner],
      );
      await pool.query(
        "INSERT INTO skill_versions(id,skill_id,version,lifecycle_status,review_status,security_status,published_at) VALUES ($1,$2,'1.0.0','approved','approved','passed',now())",
        [versionId, skillId],
      );
      await pool.query(
        "INSERT INTO skill_artifacts(skill_version_id,storage_key,sha256,byte_size,content_type,payload) VALUES ($1,$2,$3,12,'application/json','{\"files\":[]}')",
        [versionId, `fixture/${versionId}`, "a".repeat(64)],
      );
    }
    const repository = new PostgresSkillRepository(db);
    const bundles = new BundleService(db);
    const submissions = new SubmissionService(new PostgresSubmissionStore(db));
    const libraries = new LibraryService({
      store: new PostgresLibraryStore(db),
      submissions,
      skillRepository: repository,
      sourceProvider: new PublicGithubSourceProvider(),
      bundles,
    });
    const app = buildApp({
      skillRepository: repository,
      authService: new AuthService(new PostgresAuthStore(db), {}),
      submissionService: submissions,
      libraryService: libraries,
      bundleService: bundles,
    });
    t.after(() => app.close());
    async function login(name: string) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        payload: {
          email: `${name}@example.test`,
          password: "bundle fixture password",
        },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json().token as string;
    }
    const a = await login("curator"),
      b = await login("reader");
    const evidence: Array<{ method: string; path: string; status: number }> =
      [];
    async function call(
      method: "GET" | "POST" | "PATCH",
      path: string,
      token?: string,
      payload?: Json,
      status = 200,
    ): Promise<Json> {
      const r = await app.inject({
        method,
        url: path,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(payload ? { payload } : {}),
      });
      evidence.push({ method, path, status: r.statusCode });
      assert.equal(r.statusCode, status, r.body);
      return r.json();
    }
    for (const malformed of ["null", "[]", "{}", "not-json"]) {
      await call(
        "GET",
        `/v1/registry/catalog?cursor=${Buffer.from(malformed).toString("base64url")}`,
        undefined,
        undefined,
        400,
      );
    }
    const input = {
      kind: "curated",
      name: "Engineering collection",
      purpose: "Ship reliable software",
      owner: { type: "user" },
      visibility: "public",
      memberSlugs: slugs,
    };
    await call("POST", "/v1/bundles", undefined, input, 401);
    await call(
      "POST",
      "/v1/bundles",
      a,
      { ...input, memberSlugs: ["secret-member"] },
      422,
    );
    const first = (await call("POST", "/v1/bundles", a, input, 201)).bundle;
    // An owner can still see their public skill after public sharing is disabled.
    // That exception must not allow publishing it to an authenticated audience.
    await pool.query("UPDATE instance_settings SET value=jsonb_set(value,'{publicVisibilityEnabled}','false') WHERE key='sharing'");
    try {
      assert.equal((await call("GET", `/v1/skills/${slugs[0]}`, a)).skill.visibility, "public");
      const denied = await call("POST", "/v1/bundles", a, { ...input, visibility: "authenticated" }, 422);
      assert.equal(denied.error.code, "BUNDLE_MEMBER_NOT_AUTHORIZED");
      await call("PATCH", `/v1/bundles/${first.id}`, a, { ...input, visibility: "authenticated", expectedRevision: 1 }, 422);
      assert.equal((await call("GET", `/v1/bundles/${first.id}`, a)).bundle.revision, 1);
    } finally {
      await pool.query("UPDATE instance_settings SET value=jsonb_set(value,'{publicVisibilityEnabled}','true') WHERE key='sharing'");
    }
    const second = (
      await call(
        "POST",
        "/v1/bundles",
        a,
        {
          ...input,
          name: "Release collection",
          memberSlugs: slugs.slice(0, 2),
        },
        201,
      )
    ).bundle;
    for (const view of ["grouped", "list", "outline"]) {
      const all: Json[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(
          "GET",
          `/v1/registry/catalog?view=${view}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        assert.equal(page.totalSkills, 32);
        assert.equal(page.totalBundles, 2);
        all.push(...page.rows);
        cursor = page.nextCursor;
        assert.ok(all.length < 50);
      } while (cursor);
      assert.equal(all.length, view === "list" ? 32 : 3);
    }
    let members: Json[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(
        "GET",
        `/v1/bundles/${first.id}/members?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      assert.equal(page.total, 31);
      members = members.concat(page.skills);
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(members.map((x) => x.skill.slug)).size, 31);
    assert.equal(members[0]!.memberships.length, 2);
    assert.equal(
      (await call("GET", `/v1/skills/${slugs[0]}/bundles`)).bundles.length,
      2,
    );
    const search = await call(
      "GET",
      "/v1/registry/catalog?query=bundle-skill-30",
    );
    assert.equal(search.totalSkills, 1);
    assert.equal(search.totalBundles, 1);
    assert.equal(
      (
        await call(
          "GET",
          "/v1/registry/catalog?query=Engineering%20collection&view=list",
        )
      ).totalSkills,
      31,
    );
    await call(
      "PATCH",
      `/v1/bundles/${first.id}`,
      b,
      { ...input, expectedRevision: 1 },
      404,
    );
    await call(
      "PATCH",
      `/v1/bundles/${first.id}`,
      a,
      { ...input, expectedRevision: 7 },
      409,
    );
    const library = (
      await call(
        "POST",
        "/v1/libraries",
        a,
        {
          name: "Toolbox",
          owner: { type: "user" },
          clientMutationId: randomUUID(),
        },
        201,
      )
    ).library;
    const existing = (
      await call(
        "POST",
        `/v1/libraries/${library.id}/entries`,
        a,
        { kind: "skill", slug: slugs[0], clientMutationId: randomUUID() },
        201,
      )
    ).entry;
    const adoption = (
      await call(
        "POST",
        `/v1/library-entries/${existing.id}/adoptions`,
        a,
        {
          version: "1.0.0",
          artifactSha256: "a".repeat(64),
          expectedCurrentAdoptionId: null,
        },
        201,
      )
    ).adoption;
    const saved = (
      await call(
        "POST",
        `/v1/bundles/${first.id}/library-references`,
        a,
        { libraryId: library.id, expectedRevision: 1 },
        201,
      )
    ).entry;
    assert.equal(saved.kind, "bundle");
    assert.equal(saved.adoption, null);
    assert.equal(saved.bundle.revisionSaved, 1);
    const replay = await call(
      "POST",
      `/v1/bundles/${first.id}/library-references`,
      a,
      { libraryId: library.id, expectedRevision: 1 },
    );
    assert.equal(replay.entry.id, saved.id);
    assert.deepEqual(
      (await call("GET", `/v1/library-entries/${existing.id}`, a)).entry
        .adoption,
      adoption,
    );
    const oldPage = await call("GET", "/v1/registry/catalog?view=list&limit=2");
    await pool.query("UPDATE skills SET visibility='private' WHERE slug=$1", [
      slugs[0],
    ]);
    const outsider = await call("GET", `/v1/bundles/${first.id}`);
    assert.equal(outsider.bundle.memberCount, 30);
    assert.equal(outsider.bundle.partial, false);
    assert.equal(
      (await call("GET", `/v1/bundles/${first.id}`, a)).bundle.memberCount,
      31,
    );
    assert.equal(
      (await call("GET", `/v1/registry/catalog?query=${slugs[0]}`)).totalSkills,
      0,
    );
    await call(
      "GET",
      `/v1/registry/catalog?view=list&limit=2&cursor=${encodeURIComponent(oldPage.nextCursor)}`,
      undefined,
      undefined,
      409,
    );
    await call("PATCH", `/v1/bundles/${first.id}`, a, {
      ...input,
      visibility: "private",
      expectedRevision: 1,
    });
    await call("GET", `/v1/bundles/${first.id}`, b, undefined, 404);
    await call(
      "POST",
      `/v1/bundles/${first.id}/library-references`,
      b,
      { libraryId: library.id, expectedRevision: 2 },
      404,
    );
    assert.equal(
      (await call("GET", `/v1/bundles/${second.id}`, a)).bundle.revision,
      1,
      "curated collection must not change automatically",
    );
    await call(
      "POST",
      "/v1/bundles",
      a,
      { ...input, kind: "source", sourceEntryId: existing.id },
      422,
    );
    await call(
      "POST",
      "/v1/bundles",
      a,
      { ...input, memberSlugs: [slugs[1], slugs[1]] },
      400,
    );
    // Source identity is grounded in a saved selection, imported lineage and
    // immutable reviewed release provenance, never inferred from author/repo.
    const sourceId = randomUUID(),
      sourceEntryId = randomUUID();
    await pool.query(
      "INSERT INTO library_sources(id,provider,repository_id,full_name,html_url) VALUES ($1,'github','123456','example/skills','https://github.com/example/skills')",
      [sourceId],
    );
    await pool.query(
      "INSERT INTO library_entries(id,library_id,kind,title,source_id,source_path,ref_kind,acknowledged_full_name) VALUES ($1,$2,'source','example/skills',$3,'skills/engineering','default-branch','example/skills')",
      [sourceEntryId, library.id, sourceId],
    );
    async function reviewedImport(slug: string) {
      const lineage = randomUUID();
      await pool.query(
        "INSERT INTO library_import_lineages(id,owner_user_id,source_id,source_path,ref_kind,slug) VALUES ($1,$2,$3,$4,'default-branch',$5)",
        [lineage, owner, sourceId, `skills/engineering/${slug}`, slug],
      );
      await pool.query(
        "INSERT INTO library_entries(library_id,kind,title,skill_slug,lineage_id,source_entry_id) VALUES ($1,'skill',$2,$2,$3,$4)",
        [library.id, slug, lineage, sourceEntryId],
      );
      await pool.query(
        `INSERT INTO skill_release_provenance(skill_version_id,lineage_id,candidate_id,owner_user_id,imported_by_user_id,provider,repository_id,repository_full_name,repository_url,ref_kind,commit_sha,tree_sha,source_path,source_digest,package_digest,files,notices,transforms,importer_version,import_profile_digest,release_classification,retrieved_at)
      SELECT v.id,$1,$2,$3,$3,'github','123456','example/skills','https://github.com/example/skills','default-branch',$4,$4,$5,$6,$6,'[]','[]','[]','fixture',$6,'reviewed',now() FROM skill_versions v JOIN skills s ON s.id=v.skill_id WHERE s.slug=$7`,
        [
          lineage,
          randomUUID(),
          owner,
          "a".repeat(40),
          `skills/engineering/${slug}`,
          "a".repeat(64),
          slug,
        ],
      );
    }
    await reviewedImport(slugs[1]!);
    await reviewedImport(slugs[2]!);
    const selections = (await call("GET", "/v1/bundle-sources", a)).sources;
    assert.equal(selections[0].skills.length, 2);
    const sourceInput = {
      ...input,
      kind: "source",
      name: "Engineering source",
      sourceEntryId,
      memberSlugs: slugs.slice(1, 3),
    };
    await call(
      "POST",
      "/v1/bundles",
      a,
      { ...sourceInput, memberSlugs: ["standalone"] },
      422,
    );
    const sourceBundle = (
      await call("POST", "/v1/bundles", a, sourceInput, 201)
    ).bundle;
    assert.equal(sourceBundle.source.repositoryId, "123456");
    await reviewedImport(slugs[3]!);
    assert.equal(
      (await call("GET", `/v1/bundles/${sourceBundle.id}`, a)).bundle
        .memberCount,
      2,
      "new imports require explicit membership acceptance",
    );
    await pool.query(
      "UPDATE library_sources SET full_name='example/renamed',html_url='https://github.com/example/renamed' WHERE id=$1",
      [sourceId],
    );
    assert.equal(
      (await call("GET", `/v1/bundles/${sourceBundle.id}`, a)).bundle.source
        .fullName,
      "example/skills",
      "shared source rename is not acknowledgement",
    );
    await pool.query(
      "UPDATE library_entries SET acknowledged_full_name='example/renamed' WHERE id=$1",
      [sourceEntryId],
    );
    const revised = (
      await call("PATCH", `/v1/bundles/${sourceBundle.id}`, a, {
        ...sourceInput,
        memberSlugs: slugs.slice(1, 4),
        expectedRevision: 1,
      })
    ).bundle;
    assert.equal(revised.id, sourceBundle.id);
    assert.equal(revised.revision, 2);
    assert.equal(revised.source.fullName, "example/renamed");
    assert.equal(revised.memberCount, 3);
    assert.equal(
      (await call("GET", `/v1/bundles/${second.id}`, a)).bundle.revision,
      1,
    );
    const writerToken = (
      await call(
        "POST",
        "/v1/auth/api-tokens",
        a,
        {
          name: "bundle author without Library reads",
          scopes: ["skills:read", "skills:submit"],
        },
        201,
      )
    ).token.token;
    await call("GET", "/v1/bundle-sources", writerToken, undefined, 403);
    await call("POST", "/v1/bundles", writerToken, sourceInput, 403);
    const readToken = (
      await call(
        "POST",
        "/v1/auth/api-tokens",
        b,
        { name: "bundle reader", scopes: ["skills:read", "libraries:read"] },
        201,
      )
    ).token.token;
    await call("POST", "/v1/bundles", readToken, input, 403);
    await call(
      "POST",
      `/v1/bundles/${second.id}/library-references`,
      readToken,
      { libraryId: library.id, expectedRevision: 1 },
      403,
    );
    const teamInput = {
      ...input,
      name: "Team collection",
      owner: { type: "team", id: team },
      visibility: "team",
      memberSlugs: ["secret-member"],
    };
    // Team curation and team Library writes keep the existing MFA boundary.
    await call("POST", "/v1/bundles", a, teamInput, 403);
    const enrollment = await call(
      "POST",
      "/v1/auth/mfa/totp/enroll",
      a,
      { password: "bundle fixture password" },
      201,
    );
    const confirmed = await call("POST", "/v1/auth/mfa/totp/confirm", a, {
      factorId: enrollment.enrollment.factorId,
      code: generateTotpCode(enrollment.enrollment.secret),
    });
    const challenge = await call("POST", "/v1/auth/login", undefined, {
      email: "curator@example.test",
      password: "bundle fixture password",
    });
    assert.equal(challenge.mfaRequired, true);
    const verified = await call("POST", "/v1/auth/mfa/verify", undefined, {
      challengeToken: challenge.challengeToken,
      recoveryCode: confirmed.mfa.recoveryCodes[0],
    });
    assert.equal(verified.user.mfaVerified, true);
    const teamToken = verified.token as string;
    await call("POST", "/v1/bundles", teamToken, teamInput, 422);
    await call(
      "POST",
      "/v1/bundles",
      teamToken,
      { ...teamInput, visibility: "private" },
      422,
    );
    await pool.query(
      "UPDATE skills SET visibility='team' WHERE slug='secret-member'",
    );
    await pool.query(
      "INSERT INTO skill_team_grants(skill_id,team_id) SELECT id,$1 FROM skills WHERE slug='secret-member'",
      [team],
    );
    const teamBundle = (
      await call("POST", "/v1/bundles", teamToken, teamInput, 201)
    ).bundle;
    assert.equal(
      (await call("GET", `/v1/bundles/${teamBundle.id}`, b)).bundle.memberCount,
      1,
    );
    const teamLibraryId = randomUUID();
    await pool.query(
      "INSERT INTO libraries(id,name,owner_team_id,created_by_user_id) VALUES ($1,'Team saved',$2,$3)",
      [teamLibraryId, team, owner],
    );
    const noMfa = await login("reader");
    // A current team owner without MFA cannot use bundle saves to bypass Library writes.
    await pool.query(
      "UPDATE team_memberships SET role='owner' WHERE team_id=$1 AND user_id=$2",
      [team, reader],
    );
    await call(
      "POST",
      `/v1/bundles/${teamBundle.id}/library-references`,
      noMfa,
      { libraryId: teamLibraryId, expectedRevision: 1 },
      403,
    );
    await call(
      "POST",
      `/v1/bundles/${teamBundle.id}/library-references`,
      teamToken,
      { libraryId: teamLibraryId, expectedRevision: 1 },
      201,
    );
    await pool.query(
      "UPDATE team_memberships SET role='member' WHERE team_id=$1 AND user_id=$2",
      [team, reader],
    );
    const readerLibrary = (
      await call(
        "POST",
        "/v1/libraries",
        b,
        {
          name: "Reader saved",
          owner: { type: "user" },
          clientMutationId: randomUUID(),
        },
        201,
      )
    ).library;
    const readerSave = (
      await call(
        "POST",
        `/v1/bundles/${teamBundle.id}/library-references`,
        b,
        { libraryId: readerLibrary.id, expectedRevision: 1 },
        201,
      )
    ).entry;
    const raceLibrary = (
      await call(
        "POST",
        "/v1/libraries",
        b,
        {
          name: "Race saved",
          owner: { type: "user" },
          clientMutationId: randomUUID(),
        },
        201,
      )
    ).library;
    const revoker = await pool.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        "DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2",
        [team, reader],
      );
      const pending = app
        .inject({
          method: "POST",
          url: `/v1/bundles/${teamBundle.id}/library-references`,
          headers: { authorization: `Bearer ${b}` },
          payload: { libraryId: raceLibrary.id, expectedRevision: 1 },
        })
        .then((r) => r);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const waiters = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%team_memberships%' ",
        );
        if (waiters.rows.length) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        waiting,
        true,
        "save must lock current membership before commit",
      );
      await revoker.query("COMMIT");
      const denied = await pending;
      assert.equal(denied.statusCode, 404, denied.body);
    } finally {
      await revoker.query("ROLLBACK");
      revoker.release();
    }
    const unavailable = (
      await call("GET", `/v1/library-entries/${readerSave.id}`, b)
    ).entry;
    assert.equal(unavailable.title, "Unavailable bundle");
    assert.equal(unavailable.bundle.state, "unavailable");
    assert.equal(unavailable.bundle.memberCount, null);
    assert.equal(unavailable.adoption, null);
    assert.equal(
      (await call("GET", `/v1/libraries/${raceLibrary.id}/entries`, b)).entries
        .length,
      0,
    );
    const hidden = await call(
      "GET",
      "/v1/registry/catalog?query=secret-member",
      b,
    );
    assert.equal(hidden.totalSkills, 0);
    assert.equal(hidden.totalBundles, 0);
    // Rollback retains reference readers while disabling new bundle discovery/writes.
    const disabled = buildApp({
      skillRepository: repository,
      bundleService: bundles,
      bundlesEnabled: false,
    });
    try {
      assert.equal(
        (await disabled.inject({ method: "GET", url: "/v1/registry/catalog" }))
          .statusCode,
        404,
      );
      assert.equal(
        (await disabled.inject({ method: "GET", url: "/v1/skills" }))
          .statusCode,
        200,
      );
    } finally {
      await disabled.close();
    }
    mkdirSync(".private/bundles", { recursive: true });
    writeFileSync(
      ".private/bundles/api-journey.json",
      JSON.stringify({ status: "passed", evidence }, null, 2),
    );
  },
);
