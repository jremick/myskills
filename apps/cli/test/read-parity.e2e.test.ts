import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { buildApp } from "../../api/src/app.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { type PublicSkill } from "@myskills-app/core";
import { runCli, type CliRuntime } from "../src/cli.js";

// Failure inventory, before implementation:
// - CLI drops pagination and silently strands authorized results after page one.
// - Cursor is reused with a different query, bypassing the API's cursor binding.
// - Exact release info silently reports the latest release instead.
// - Review queue or library filters are ignored while a successful exit is shown.
// - Invalid limits/repeated flags reach the API; API errors lose their code/status.
// Existing API pagination tests do not exercise CLI parsing/transport/output.
test("CLI search walks real API pages, excludes hidden skills and preserves cursor binding", async (t) => {
  const skills: PublicSkill[] = Array.from({ length: 65 }, (_, i) => ({
    slug: `page-${String(i).padStart(2, "0")}`, title: `Page ${i}`, summary: "Pagination fixture",
    lifecycleStatus: "approved", visibility: "public", latestVersion: "1.0.0",
    reviewStatus: "approved", securityStatus: "passed", platforms: [], tags: [],
  }));
  const repository = new MemorySkillRepository([...skills, { ...skills[0]!, slug: "page-hidden", visibility: "private", ownerUserId: "another-user" }]);
  const app = buildApp({ skillRepository: repository });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const stdout: string[] = [], stderr: string[] = [];
  const runtime: CliRuntime = { env: { MYSKILLS_API_URL: url }, fetch, io: { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) } };
  const seen: string[] = []; let cursor: string | null = null; let firstCursor = "";
  do {
    stdout.length = 0;
    assert.equal(await runCli(["search", "page", "--limit", "17", "--json", ...(cursor ? ["--cursor", cursor] : [])], runtime), 0, stderr.join("\n"));
    const result = JSON.parse(stdout[0]!);
    assert.equal(result.skills.length, seen.length < 51 ? 17 : 14);
    seen.push(...result.skills.map((s: PublicSkill) => s.slug));
    cursor = result.nextCursor; firstCursor ||= cursor ?? "";
  } while (cursor);
  assert.deepEqual(seen, skills.map((s) => s.slug));
  assert.notEqual(await runCli(["search", "other", "--cursor", firstCursor, "--json"], runtime), 0);
  assert.equal(JSON.parse(stderr.at(-1)!).error.code, "INVALID_SKILL_CURSOR");
});

test("CLI exact-release info, reviewer pagination and library filters cross the HTTP boundary", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost"); requests.push(request.url!);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/skills/example/releases/1.0.0") response.end(JSON.stringify({ release: { slug: "example", title: "untrusted\u009btext", version: "1.0.0", releaseNotes: "Exact older release", artifact: { sha256: "a".repeat(64) } } }));
    else if (url.pathname === "/v1/review/submissions") response.end(JSON.stringify({ submissions: [], nextCursor: "next-review-page" }));
    else if (url.pathname === "/v1/libraries/library-id/entries" || url.pathname === "/v1/library-entries/entry-id/candidates" || url.pathname === "/v1/library-inbox") response.end(JSON.stringify({ items: [] }));
    else { response.statusCode = 404; response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "No such resource" } })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const stdout: string[] = [], stderr: string[] = [];
  const runtime: CliRuntime = { env: { MYSKILLS_API_URL: `http://127.0.0.1:${address.port}`, MYSKILLS_TOKEN: "fixture-read-token" }, fetch, io: { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) } };
  assert.equal(await runCli(["info", "example", "--version", "1.0.0", "--json"], runtime), 0, stderr.join("\n"));
  assert.equal(JSON.parse(stdout.at(-1)!).release.version, "1.0.0");
  assert.equal(await runCli(["review", "submissions", "--limit", "12", "--cursor", "current-page", "--json"], runtime), 0);
  assert.equal(JSON.parse(stdout.at(-1)!).nextCursor, "next-review-page");
  assert.equal(await runCli(["libraries", "entries", "library-id", "--kind", "source", "--json"], runtime), 0);
  assert.equal(await runCli(["libraries", "candidates", "entry-id", "--state", "ready-for-review", "--json"], runtime), 0);
  assert.equal(await runCli(["libraries", "inbox", "--unread", "true", "--json"], runtime), 0);
  assert.deepEqual(requests, ["/v1/skills/example/releases/1.0.0", "/v1/review/submissions?limit=12&cursor=current-page", "/v1/libraries/library-id/entries?kind=source", "/v1/library-entries/entry-id/candidates?state=ready-for-review", "/v1/library-inbox?unread=true"]);
  const before = requests.length;
  for (const args of [["search", "--limit", "101"], ["search", "--limit", "2", "--limit", "3"], ["info", "example", "--version", "../secret"], ["libraries", "entries", "library-id", "--kind", "invalid"], ["libraries", "inbox", "--unread", "invalid"], ["libraries", "entries", "library-id", "--unread", "true"]]) assert.notEqual(await runCli([...args, "--json"], runtime), 0);
  assert.equal(requests.length, before);
  assert.equal(await runCli(["info", "example", "--version", "1.0.0"], runtime), 0);
  assert.equal(stdout.at(-1)!.includes("\u009b"), false, "Human output must remove terminal control characters from release metadata.");
});

test("CLI parity mutations reject repeated credential and host options instead of using defaults", async () => {
  let calls = 0;
  const runtime: CliRuntime = {
    env: { MYSKILLS_API_URL: "https://configured.example.test", MYSKILLS_TOKEN: "stored-owner-session" },
    fetch: async () => { calls += 1; return new Response(JSON.stringify({ status: "archived" }), { headers: { "content-type": "application/json" } }); },
    io: { stdout: () => {}, stderr: () => {} },
  };
  for (const flags of [["--token", "first", "--token", "second"], ["--api-url", "https://first.example.test", "--api-url", "https://second.example.test"]]) {
    assert.notEqual(await runCli(["organizations", "archive", "safe-id", ...flags, "--json"], runtime), 0);
  }
  assert.equal(calls, 0, "Ambiguous authority must fail before any request.");
});
