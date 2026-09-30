import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb, createPgPool } from "../src/db/client.js";
import { skills, skillVersions, skillArtifacts, users, teams, teamMemberships, skillTeamGrants } from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { discoverTask } from "../src/discovery/service.js";

// Written before ranking. Real database authorization/default-release selection
// must hide private/unsafe history and react to membership removal before return.
// The actor is fixed here; credential/session policy is proved by HTTP journeys.
test("Postgres discovery preserves approved identity and rechecks live membership", { timeout: 60_000 }, async t => {
  const url = process.env.TEST_DATABASE_URL;
  assert.ok(url); assert.match(new URL(url).pathname, /(?:^|[_/-])(test|ci)(?:[_/-]|$)/i);
  const pool = createPgPool(url); t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE"); await pool.query("CREATE SCHEMA public");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) await pool.query(await readFile(`${dir}/${file}`, "utf8"));
  const db = createDb(pool);
  const [owner, reader] = await db.insert(users).values(["owner", "reader"].map(name => ({ email: `${name}@discovery.example.test`, normalizedEmail: `${name}@discovery.example.test`, name, status: "active" as const, emailVerifiedAt: new Date() }))).returning({ id: users.id });
  const [team] = await db.insert(teams).values({ name: "Discovery team", slug: "discovery-team", createdByUserId: owner!.id }).returning({ id: teams.id });
  await db.insert(teamMemberships).values({ teamId: team!.id, userId: reader!.id, role: "member" });
  const rows = await db.insert(skills).values([
    { slug: "public-incident", title: "Incident report", summary: "Write incident recovery report.", lifecycleStatus: "approved", visibility: "public", ownerUserId: owner!.id },
    { slug: "team-incident", title: "Team incident report", summary: "Write incident recovery report.", lifecycleStatus: "approved", visibility: "team", ownerUserId: owner!.id },
    { slug: "hidden-incident", title: "Private incident report", summary: "Write incident recovery report.", lifecycleStatus: "approved", visibility: "private", ownerUserId: owner!.id },
  ]).returning({ id: skills.id, slug: skills.slug });
  const versions = await db.insert(skillVersions).values(rows.map(s => ({ skillId: s.id, version: "1.0.0", lifecycleStatus: "approved" as const, reviewStatus: "approved" as const, securityStatus: "passed" as const, approvedArtifactSha256: "a".repeat(64), publishedAt: new Date() }))).returning({ id: skillVersions.id });
  await db.insert(skillArtifacts).values(versions.map(v => ({ skillVersionId: v.id, storageKey: `discovery/${v.id}`, sha256: "a".repeat(64), byteSize: 10, contentType: "application/vnd.myskills-app.package+json", payload: { files: [] } })));
  await db.insert(skillTeamGrants).values({ skillId: rows.find(r => r.slug === "team-incident")!.id, teamId: team!.id, createdByUserId: owner!.id });
  const repository = new PostgresSkillRepository(db);
  const submissions = new SubmissionService(new PostgresSubmissionStore(db));
  const options = { repository, readRelease: submissions.getPublicRelease.bind(submissions), readActor: async () => reader!.id };
  const found = await discoverTask({ task: "Write incident recovery report", limit: 10 }, options);
  assert.deepEqual(found.results.map(r => r.skill.slug).sort(), ["public-incident", "team-incident"]);
  assert.ok(found.results.every(r => r.release.version === "1.0.0" && r.release.sha256 === "a".repeat(64)));
  const search = repository.searchVisibleSkills.bind(repository);
  repository.searchVisibleSkills = async filters => {
    const stale = await search(filters);
    await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [team!.id, reader!.id]);
    return stale;
  };
  const revoked = await discoverTask({ task: "Write incident recovery report", limit: 10 }, options);
  assert.deepEqual(revoked.results.map(r => r.skill.slug), ["public-incident"]);
  assert.deepEqual((await discoverTask({ task: "Calibrate telescope photometry", limit: 10 }, options)).results, []);
});
