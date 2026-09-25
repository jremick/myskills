import assert from "node:assert/strict";
import test from "node:test";
import { chronologicalKey, chronologicalPagePosition, chronologicalPageResult, parseChronologicalPageQuery } from "../src/repositories/chronological-pagination.js";

test("chronological cursors preserve microseconds and bind to endpoint and actor", () => {
  const position = chronologicalPagePosition({ limit: 1 }, "review:user-1");
  const rows = [{ id: "submission-2", createdAt: "2026-09-25T00:00:00.123456Z" }, { id: "submission-1", createdAt: "2026-09-25T00:00:00.123455Z" }];
  const page = chronologicalPageResult(rows, position, chronologicalKey);
  assert.ok(page.nextCursor);
  assert.deepEqual(chronologicalPagePosition({ cursor: page.nextCursor }, "review:user-1").before, rows[0]);
  assert.deepEqual(chronologicalKey({ id: "a", createdAt: new Date("2026-09-25T00:00:00.123Z") }), { id: "a", createdAt: "2026-09-25T00:00:00.123000Z" });
  for (const scope of ["review:user-2", "audit:user-1"]) assert.throws(() => chronologicalPagePosition({ cursor: page.nextCursor! }, scope), { code: "INVALID_PAGE_CURSOR" });
  for (const cursor of ["", "bad!", "a".repeat(1025), Buffer.from("{}").toString("base64url"), `${page.nextCursor}=`]) assert.throws(() => chronologicalPagePosition({ cursor }, "review:user-1"), { code: "INVALID_PAGE_CURSOR" });
  const payload = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString());
  for (const change of [{ createdAt: "2026-02-30T00:00:00.123456Z" }, { id: "bad/path" }, { v: 2 }]) {
    const cursor = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
    assert.throws(() => chronologicalPagePosition({ cursor }, "review:user-1"), { code: "INVALID_PAGE_CURSOR" });
  }
});

test("page queries bound sizes and reject structured cursors", () => {
  for (const input of [{ limit: "0" }, { limit: "101" }, { limit: "2.5" }, { limit: "10bad" }, { limit: ["5"] }]) assert.throws(() => parseChronologicalPageQuery(input), { code: "INVALID_PAGE_SIZE" });
  assert.throws(() => parseChronologicalPageQuery({ cursor: ["a", "b"] }), { code: "INVALID_PAGE_CURSOR" });
  assert.deepEqual(parseChronologicalPageQuery({ limit: "37" }), { limit: 37, cursor: undefined });
});
