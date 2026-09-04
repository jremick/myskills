import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type PublicSkill } from "@myskills-app/core";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { parseSkillPageQuery, searchVisibleSkillPage } from "../src/repositories/skill-pagination.js";
import { buildApp } from "../src/app.js";

test("registry HTTP continuation preserves a direct skill URL outside the first page", async (t) => {
  const repository = new MemorySkillRepository(Array.from({ length: 65 }, (_, index) => skill(`page-${String(index).padStart(2, "0")}`)));
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());
  const first = await app.inject({ method: "GET", url: "/v1/skills?limit=50" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().skills.length, 50);
  assert.ok(first.json().nextCursor);
  const direct = await app.inject({ method: "GET", url: "/v1/skills/page-64" });
  assert.equal(direct.json().skill.slug, "page-64");
  const second = await app.inject({ method: "GET", url: `/v1/skills?limit=50&cursor=${first.json().nextCursor}` });
  assert.equal(second.json().skills.length, 15);
  assert.equal(second.json().nextCursor, null);
  assert.equal(second.json().skills.at(-1).slug, direct.json().skill.slug);
});

test("registry pages reach every authorized skill once and only advertise a real continuation", async () => {
  const visible = Array.from({ length: 65 }, (_, index) => skill(`page-${String(index).padStart(2, "0")}`));
  const repository = new MemorySkillRepository([
    ...[...visible].reverse(),
    ...Array.from({ length: 300 }, () => skill("page-00")),
    { ...skill("page-hidden"), visibility: "private", ownerUserId: "other" },
    { ...skill("page-archived"), lifecycleStatus: "archived" },
  ]);
  const seen: string[] = [];
  let cursor: string | undefined;
  const pageSizes: number[] = [];
  do {
    const page = await searchVisibleSkillPage(repository, { query: "page", limit: 13, cursor, actorId: "reader" });
    pageSizes.push(page.skills.length);
    seen.push(...page.skills.map((entry) => entry.slug));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual(pageSizes, [13, 13, 13, 13, 13]);
  assert.deepEqual(seen, visible.map((entry) => entry.slug));
  assert.equal(new Set(seen).size, 65);
});

test("cursor seeks survive deletion and reject a different search or actor", async () => {
  const skills = [skill("a-helper"), skill("ahelper"), skill("b-helper")];
  const repository = new MemorySkillRepository(skills);
  const first = await searchVisibleSkillPage(repository, { limit: 1, actorId: "reader" });
  assert.equal(first.skills[0]?.slug, "a-helper");
  assert.ok(first.nextCursor);
  skills.splice(0, 1);
  const next = await searchVisibleSkillPage(repository, { limit: 1, actorId: "reader", cursor: first.nextCursor });
  assert.equal(next.skills[0]?.slug, "ahelper");
  for (const changed of [{ query: "different", actorId: "reader" }, { actorId: "other" }]) {
    await assert.rejects(searchVisibleSkillPage(repository, { ...changed, cursor: first.nextCursor }),
      (error) => error instanceof AppError && error.code === "INVALID_SKILL_CURSOR");
  }
  await assert.rejects(searchVisibleSkillPage(repository, { cursor: "%%%" }),
    (error) => error instanceof AppError && error.code === "INVALID_SKILL_CURSOR");
});

test("search uses literal text and validates page sizes", async () => {
  const repository = new MemorySkillRepository([skill("a-helper")]);
  assert.deepEqual(await searchVisibleSkillPage(repository, { query: "%" }), { skills: [], nextCursor: null });
  for (const limit of ["0", "101", "2x", "1.5"]) {
    assert.throws(() => parseSkillPageQuery({ limit }),
      (error) => error instanceof AppError && error.code === "INVALID_SKILL_PAGE_SIZE");
  }
});

function skill(slug: string): PublicSkill {
  return {
    slug, title: slug, summary: "A registry fixture.", lifecycleStatus: "approved", visibility: "public",
    latestVersion: "1.0.0", reviewStatus: "approved", securityStatus: "passed", platforms: [], tags: [],
  };
}
