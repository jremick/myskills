import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { hashSessionToken } from "@myskills-app/auth";
import { discoveryFixture, taskCases } from "./fixtures/task-discovery.js";

// Failure inventory written before implementation:
// - hidden/private/team/revoked/unsafe descriptions enter ranking or a response;
// - revoked membership or credentials survive the final permission check;
// - results name a mutable latest alias instead of an approved digest-bound release;
// - a stopword-only or no-match task invents a useful result;
// - long inputs or large catalogs cause unbounded work or silent truncation;
// - a model, installation, activation or execution is triggered by discovery;
// - normal keyword search regresses while adding the task workflow.
// Real Fastify/AuthService/review-publication service and memory domain stores.
// These local fixtures do not prove Postgres, real provider hosts or deployment.

test("task discovery evaluates a fixed mixed-authority corpus against ordinary search", async t => {
  const f = await discoveryFixture(); t.after(() => f.app.close());
  const evidence = [];
  for (const c of taskCases) {
    const started = performance.now();
    const response = await f.request(c.task);
    const elapsedMs = performance.now() - started;
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.method, "lexical-v1");
    assert.equal(body.provider.status, "disabled");
    assert.equal(body.provider.calls, 0);
    assert.equal(body.provider.reportedCost, 0);
    assert.ok(body.uncertainty.length > 0);
    assert.equal(body.fallback, "ordinary-search-available");
    const slugs = body.results.map((r: { skill: { slug: string } }) => r.skill.slug);
    assert.ok(!slugs.some((s: string) => ["hidden-review", "archived-release", "unsafe-release"].includes(s)));
    if (!c.relevant.length) assert.deepEqual(slugs, []);
    else assert.ok(slugs.some((s: string) => (c.relevant as readonly string[]).includes(s)), c.id);
    for (const result of body.results) {
      const exact = await f.submissions.getPublicRelease({ slug: result.skill.slug, version: result.release.version, actorId: "reader" });
      assert.equal(result.release.sha256, exact?.artifact.sha256);
      assert.equal(result.release.reviewStatus, "approved");
      assert.equal(result.release.securityStatus, "passed");
    }
    const baselineStart = performance.now();
    const ordinary = await f.app.inject({ method: "GET", url: `/v1/skills?q=${encodeURIComponent(c.task)}`, headers: { authorization: `Bearer ${f.token}` } });
    const baselineMs = performance.now() - baselineStart;
    assert.equal(ordinary.statusCode, 200);
    const ordinarySlugs = ordinary.json().skills.map((s: { slug: string }) => s.slug);
    const grade = (list: string[]) => ({ hitAt3: c.relevant.length ? Number(list.slice(0, 3).some(s => (c.relevant as readonly string[]).includes(s))) : null, noMatchCorrect: !c.relevant.length ? list.length === 0 : null, reciprocalRank: c.relevant.length ? 1 / (list.findIndex(s => (c.relevant as readonly string[]).includes(s)) + 1 || Infinity) : null });
    evidence.push({ id: c.id, results: slugs, ordinaryResults: ordinarySlugs, taskDiscovery: { ...grade(slugs), elapsedMs }, ordinarySearch: { ...grade(ordinarySlugs), elapsedMs: baselineMs } });
  }
  const ordinary = await f.app.inject({ method: "GET", url: "/v1/skills?q=release" });
  assert.equal(ordinary.statusCode, 200); assert.ok(ordinary.json().skills.some((s: { slug: string }) => s.slug === "release-notes"));
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/task-discovery-evidence.json", JSON.stringify({ schemaVersion: 1, scope: "synthetic memory-store API journey; not model benefit, Postgres, deployed or real-host proof", recordedAt: new Date().toISOString(), method: "lexical-v1", comparison: "ordinary substring search on the identical full task text", cost: 0, evidence }, null, 2) + "\n");
});

test("anonymous discovery excludes team and private records; revoked access is checked before return", async t => {
  const f = await discoveryFixture(); t.after(() => f.app.close());
  const anonymous = await f.request("meeting incident", false);
  assert.equal(anonymous.statusCode, 200, anonymous.body);
  assert.ok(!anonymous.json().results.some((r: { skill: { slug: string } }) => ["private-notes", "team-incident"].includes(r.skill.slug)));
  const search = f.repository.searchVisibleSkills.bind(f.repository);
  f.repository.searchVisibleSkills = async filters => {
    const stale = await search(filters);
    f.repository.removeTeamMembership("reader", "discovery-team");
    return stale;
  };
  const revoked = await f.request("Prepare a team incident timeline and recovery report");
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.ok(!revoked.json().results.some((r: { skill: { slug: string } }) => r.skill.slug === "team-incident"));
  f.repository.searchVisibleSkills = async filters => {
    const stale = await search(filters);
    await f.authStore.revokeSessionByTokenHash(hashSessionToken(f.token));
    return stale;
  };
  const revokedCredential = await f.request("Review code");
  assert.equal(revokedCredential.statusCode, 401, revokedCredential.body);
  assert.equal(revokedCredential.json().error.code, "AUTHENTICATION_REQUIRED");
  const invalid = await f.app.inject({ method: "POST", url: "/v1/skills/discover", headers: { authorization: "Bearer invalid-credential" }, payload: { task: "review code" } });
  assert.equal(invalid.statusCode, 401);
});

test("task input and catalog bounds are explicit and deterministic", async t => {
  const f = await discoveryFixture(); t.after(() => f.app.close());
  for (const payload of [{ task: "x".repeat(4001) }, { task: "" }, { task: "review", limit: 21 }, { task: "review", provider: "enabled" }, { task: 42 }]) {
    const bad = await f.app.inject({ method: "POST", url: "/v1/skills/discover", payload });
    assert.equal(bad.statusCode, 400, bad.body);
  }
  const a = await f.request("code review code review"); const b = await f.request("code review");
  assert.deepEqual(a.json().results, b.json().results, "duplicate words cannot inflate relevance");
  f.rows.push(...Array.from({ length: 510 }, (_, i) => ({ ...f.rows[0]!, slug: `a-catalog-${String(i).padStart(4, "0")}` })));
  const capped = await f.request("code review");
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.json().catalog.limit, 500);
  assert.equal(capped.json().catalog.truncated, true);
  assert.ok(capped.json().uncertainty.some((v: string) => /catalog/i.test(v)));
});
