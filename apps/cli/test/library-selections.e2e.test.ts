import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli, type CliRuntime } from "../src/cli.js";

// Authoring ledger, before implementation: existing API journeys cannot detect
// missing CLI actions, dropped retry/revision fields, changed membership order,
// lost opaque cursors, unsafe delete revisions, or swallowed server errors.
// This real HTTP fixture verifies transport contracts only, not persistence.
test("CLI collection and group commands preserve ordered replacement, retry keys, pages and API failures", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-selection-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: Array<{ method: string; pathname: string; query: Record<string, string>; body: unknown }> = [];
  let failure: { code: string; status: number } | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method!, pathname: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : null });
    res.setHeader("content-type", "application/json");
    if (failure) { res.statusCode = failure.status; res.end(JSON.stringify({ error: { code: failure.code, message: "Selection request rejected." } })); return; }
    res.end(JSON.stringify({ accepted: true, nextCursor: "opaque+/cursor=", replayed: req.method === "POST", tracking: { pendingCandidateCount: 3 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const apiBaseUrl = `http://127.0.0.1:${address.port}`;
  const call = async (args: string[], payload?: Record<string, unknown>) => {
    const stdout: string[] = [], stderr: string[] = [];
    const input = path.join(directory, "request.json");
    if (payload) await writeFile(input, JSON.stringify(payload));
    const runtime: CliRuntime = { env: {}, fetch: (url, init) => fetch(url, init), io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } };
    const exit = await runCli(["libraries", ...args, ...(payload ? ["--input", input] : []), "--api-url", apiBaseUrl, "--token", "synthetic-selection-token", "--json"], runtime);
    return { exit, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  };
  for (const entity of ["collection", "group"]) {
    const plural = `${entity}s`, id = `${entity}-a`;
    const create = { name: `Reviewed ${entity}`, description: "Two ordered members", memberEntryIds: ["entry-b", "entry-a"], clientMutationId: `_${entity}:retry-1` };
    const update = { expectedRevision: 7, name: "Reordered", memberEntryIds: ["entry-a", "entry-b"] };
    const cases: Array<{ args: string[]; method: string; pathname: string; payload?: Record<string, unknown>; query?: Record<string, string> }> = [
      { args: [plural, "library-a", "--limit", "1", "--cursor", "opaque+/cursor="], method: "GET", pathname: `/v1/libraries/library-a/${plural}`, query: { limit: "1", cursor: "opaque+/cursor=" } },
      { args: [entity, id], method: "GET", pathname: `/v1/library-${plural}/${id}` },
      { args: [`${entity}-members`, id, "--limit", "100", "--cursor", "opaque+/members="], method: "GET", pathname: `/v1/library-${plural}/${id}/members`, query: { limit: "100", cursor: "opaque+/members=" } },
      { args: [`create-${entity}`, "library-a"], method: "POST", pathname: `/v1/libraries/library-a/${plural}`, payload: create },
      { args: [`create-${entity}`, "library-a"], method: "POST", pathname: `/v1/libraries/library-a/${plural}`, payload: create },
      { args: [`edit-${entity}`, id], method: "PATCH", pathname: `/v1/library-${plural}/${id}`, payload: update },
      { args: [`edit-${entity}`, id], method: "PATCH", pathname: `/v1/library-${plural}/${id}`, payload: { expectedRevision: 8, memberEntryIds: [] } },
      { args: [`remove-${entity}`, id, "--revision", "9"], method: "DELETE", pathname: `/v1/library-${plural}/${id}`, query: { expectedRevision: "9" } },
    ];
    for (const step of cases) {
      const result = await call(step.args, step.payload);
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).nextCursor, "opaque+/cursor=");
      assert.deepEqual(requests.at(-1), { method: step.method, pathname: step.pathname, query: step.query ?? {}, body: step.payload ?? null });
    }
    const before = requests.length;
    for (const revision of [undefined, "0", "-1", "1.5", "9007199254740992"]) {
      const result = await call([`remove-${entity}`, id, ...(revision ? ["--revision", revision] : [])]);
      assert.equal(result.exit, 2);
      assert.match(result.stderr, /revision/i);
    }
    for (const args of [[plural, "library-a", "--limit", "101"], [`create-${entity}`, "library-a"], [entity, "../foreign"]]) assert.equal((await call(args)).exit, 2);
    assert.equal(requests.length, before, "invalid input must not reach the API");
    for (const code of [`LIBRARY_${entity.toUpperCase()}_REVISION_CONFLICT`, "CLIENT_MUTATION_ID_CONFLICT", "LIBRARY_SELECTION_MEMBER_INVALID", "LIBRARY_WRITE_FORBIDDEN", "MFA_VERIFICATION_REQUIRED"]) {
      failure = { code, status: code.includes("CONFLICT") ? 409 : 403 };
      const result = await call([`edit-${entity}`, id], update);
      assert.equal(result.exit, 1);
      assert.match(result.stderr, new RegExp(code));
    }
    failure = undefined;
  }
  t.diagnostic("Repeat: node --import tsx --test apps/cli/test/library-selections.e2e.test.ts; verifies adapter transport only.");
});
