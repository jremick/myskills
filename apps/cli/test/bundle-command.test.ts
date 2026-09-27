// Authored before the bundle CLI adapter: real HTTP round trips, reviewed file
// payloads and current API denial. No new local installation state is created.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli, type CliRuntime } from "../src/cli.js";
test("bundle CLI browses pages, creates a reviewed set, saves only a reference and reports conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bundle-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let conflict = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    calls.push({
      url: req.url!,
      method: req.method!,
      body: body ? JSON.parse(body) : null,
    });
    res.setHeader("content-type", "application/json");
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    res.statusCode = conflict ? 409 : 200;
    res.end(
      JSON.stringify(
        conflict
          ? {
              error: {
                code: "BUNDLE_REVISION_CONFLICT",
                message: "Refresh the bundle",
              },
            }
          : {
              bundle: {
                id: "11111111-1111-4111-8111-111111111111",
                revision: 1,
              },
              entry: { kind: "bundle", adoption: null },
              nextCursor: "page-two",
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const output: string[] = [];
  const runtime: CliRuntime = {
    env: { MYSKILLS_TOKEN: "fixture-token" },
    fetch: (i, n) => fetch(i, n),
    io: { stdout: (s) => output.push(s), stderr: (s) => output.push(s) },
  };
  const run = (args: string[]) =>
    runCli(
      ["bundles", ...args, "--api-url", `http://127.0.0.1:${addr.port}`],
      runtime,
    );
  assert.equal(
    await run([
      "list",
      "--query",
      "engineering",
      "--view",
      "outline",
      "--limit",
      "2",
      "--cursor",
      "page-two",
    ]),
    0,
  );
  assert.match(calls[0]!.url, /query=engineering/);
  assert.match(calls[0]!.url, /view=outline/);
  const input = join(root, "reviewed.json");
  const body = {
    kind: "curated",
    name: "Engineering",
    purpose: "Ship safely",
    owner: { type: "user" },
    visibility: "public",
    memberSlugs: ["planner"],
  };
  await writeFile(input, JSON.stringify(body));
  assert.equal(await run(["create", "--input", input]), 0);
  assert.deepEqual(calls[1]!.body, body);
  await writeFile(
    input,
    JSON.stringify({
      libraryId: "22222222-2222-4222-8222-222222222222",
      expectedRevision: 1,
    }),
  );
  assert.equal(
    await run([
      "save",
      "11111111-1111-4111-8111-111111111111",
      "--input",
      input,
    ]),
    0,
  );
  assert.match(calls[2]!.url, /library-references$/);
  conflict = true;
  assert.notEqual(
    await run([
      "save",
      "11111111-1111-4111-8111-111111111111",
      "--input",
      input,
    ]),
    0,
  );
  assert.ok(!calls.some((c) => /adoptions|install|targets/.test(c.url)));
  const prior = calls.length;
  assert.notEqual(await run(["show", "../auth"]), 0);
  assert.equal(calls.length, prior);
});
