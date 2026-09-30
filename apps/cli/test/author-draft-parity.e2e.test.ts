import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCli, type CliRuntime } from "../src/cli.js";

// Failure inventory written before production code. The real dispatcher and HTTP
// transport must not lose multi-file UTF-8 bytes, revision guards, release fields,
// or queued scan status. They must reject malformed input before HTTP and refuse
// export overwrite. API tests cannot detect those adapter regressions. This API
// socket is a contract fixture: it provides no persistence or provider evidence.
const files = [
  { path: "skill.json", content: '{"name":"incomplete"}\n' },
  { path: "SKILL.md", content: "# Workflow\nTabs\tand quotes \" stay exact.\n" },
  { path: "references/attribution.md", content: "License: Apache-2.0\n作者 ☕\n" },
  { path: "references/large.md", content: "large text\n".repeat(60_000) },
];

test("CLI drafts preserve files, source identity, exact revisions, release metadata and API scan states", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.ok(["drafts", "list"])).drafts, [{ id: "draft-1", revision: 7 }]);
  const create = { title: "Incomplete package", files };
  await f.ok(["drafts", "create", "--input", await f.input("create", create)]);
  assert.deepEqual(f.requests.at(-1), { method: "POST", url: "/v1/drafts", body: create });
  for (const source of [
    { kind: "release", slug: "workflow", version: "1.2.3", platform: "codex" },
    { kind: "submission", submissionId: "submission-1" },
  ]) {
    await f.ok(["drafts", "create", "--input", await f.input(source.kind, { source })]);
    assert.deepEqual(f.requests.at(-1)?.body, { source });
  }
  const saved = { expectedRevision: 7, title: "Corrected package", files };
  await f.ok(["drafts", "save", "draft-1", "--input", await f.input("save", saved)]);
  assert.deepEqual(f.requests.at(-1), { method: "PUT", url: "/v1/drafts/draft-1", body: saved });
  const output = path.join(f.directory, "snapshot.json");
  await f.ok(["drafts", "show", "draft-1", "--revision", "7", "--output", output]);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).draft.files, files);
  assert.equal(f.requests.at(-1)?.url, "/v1/drafts/draft-1/revisions/7");
  await f.fail(["drafts", "show", "draft-1", "--output", output], /OUTPUT_EXISTS/);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")).draft.files, files);
  await f.ok(["drafts", "show", "draft-1"]);
  assert.equal(f.requests.at(-1)?.url, "/v1/drafts/draft-1");
  await f.ok(["drafts", "history", "draft-1"]);
  assert.equal(f.requests.at(-1)?.url, "/v1/drafts/draft-1/history");
  for (const body of [{ files }, { archive: { filename: "package.zip", contentBase64: "UEsDBA==" } }]) {
    await f.ok(["drafts", "preview", "--input", await f.input("preview", body)]);
    assert.deepEqual(f.requests.at(-1), { method: "POST", url: "/v1/drafts/preview", body });
  }
  await f.ok(["drafts", "validate", "draft-1", "--revision", "7"]);
  assert.deepEqual(f.requests.at(-1), { method: "POST", url: "/v1/drafts/draft-1/validate", body: { expectedRevision: 7 } });
  const submission = { expectedRevision: 7, release: { releaseNotes: "Correct setup.\nPreserve attribution.", changeKind: "fix", requiresUserAction: true, compatibility: { minimumMyskillsVersion: "0.1.0", minimumAdapterContractVersion: 2, minimumSourceVersion: "1.0.0" } } };
  const result = await f.ok(["drafts", "submit", "draft-1", "--input", await f.input("submit", submission)]);
  assert.deepEqual(f.requests.at(-1), { method: "POST", url: "/v1/drafts/draft-1/submit", body: submission });
  assert.equal(result.submission.securityStatus, "not-run");
  assert.equal(result.submission.scan.status, "queued");
  await f.ok(["drafts", "submit", "draft-1", "--revision", "7"]);
  assert.deepEqual(f.requests.at(-1)?.body, { expectedRevision: 7 });
});

test("CLI drafts reject invented fields, malformed revisions and unsafe paths before HTTP; API denial stays safe", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { title: "One", files: [], owner: { type: "team", id: "other" } },
    { title: "One", files: [{ path: "SKILL.md", content: "text", encoding: "base64" }] },
    { title: "One", files: [{ path: "../outside", content: "text" }] },
    { title: "One", files: [{ path: "SKILL.md", content: "é".repeat(600_000) }] },
    { source: { kind: "release", slug: "workflow", version: "1.0.0", artifactSha256: "invented" } },
    { source: { kind: "submission", submissionId: "one", visibility: "public" } },
    { title: "One", files: [], source: { kind: "submission", submissionId: "one" } },
  ]) {
    const before = f.requests.length;
    await f.fail(["drafts", "create", "--input", await f.input("invalid", body)]);
    assert.equal(f.requests.length, before);
  }
  for (const body of [{ files, archive: { contentBase64: "UEsDBA==" } }, { archive: { contentBase64: "%%%=" } }, { files, source: {} }]) {
    const before = f.requests.length;
    await f.fail(["drafts", "preview", "--input", await f.input("invalid-preview", body)]);
    assert.equal(f.requests.length, before);
  }
  for (const args of [
    ["show", "../escape"], ["history", "draft-1", "extra"], ["list", "--limit", "5"],
    ...["0", "-1", "1.1", "1e2", "9007199254740992"].map(value => ["validate", "draft-1", "--revision", value]),
    ["submit", "draft-1", "--revision", "7", "--input", "ambiguous.json"],
  ]) {
    const before = f.requests.length;
    await f.fail(["drafts", ...args]);
    assert.equal(f.requests.length, before);
  }
  const regular = await f.input("regular", { title: "One", files: [] });
  const link = path.join(f.directory, "symlink.json");
  await symlink(regular, link);
  const before = f.requests.length;
  await f.fail(["drafts", "create", "--input", link]);
  assert.equal(f.requests.length, before);
  for (const [id, code, status] of [["foreign", "DRAFT_NOT_FOUND", 404], ["stale", "DRAFT_REVISION_CONFLICT", 409], ["denied", "SUBMISSION_ROLE_REQUIRED", 403]] as const) {
    const error = await f.fail(["drafts", "validate", id, "--revision", "7"], new RegExp(code));
    assert.equal(JSON.parse(error).error.status, status);
    assert.equal(error.includes("synthetic-sensitive-content"), false);
  }
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myskills-cli-draft-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: request.method!, url: request.url!, body });
    response.setHeader("content-type", "application/json");
    const error = request.url?.match(/\/(foreign|stale|denied)\//)?.[1];
    if (error) {
      response.statusCode = error === "foreign" ? 404 : error === "stale" ? 409 : 403;
      response.end(JSON.stringify({ error: { code: error === "foreign" ? "DRAFT_NOT_FOUND" : error === "stale" ? "DRAFT_REVISION_CONFLICT" : "SUBMISSION_ROLE_REQUIRED", message: "synthetic-sensitive-content", details: { content: "synthetic-sensitive-content" } } }));
    } else if (request.url === "/v1/drafts" && request.method === "GET") response.end(JSON.stringify({ drafts: [{ id: "draft-1", revision: 7 }] }));
    else response.end(JSON.stringify({ draft: { id: "draft-1", revision: 7, files }, submission: { id: "submission-1", reviewStatus: "pending", securityStatus: "not-run", scan: { status: "queued", findings: [], findingCount: 0 } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const runtime: CliRuntime = { env: { MYSKILLS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, MYSKILLS_TOKEN: "synthetic-draft-token" }, fetch, io: { stdout: () => {}, stderr: () => {} } };
  const call = async (args: string[]) => {
    const output: string[] = []; const errors: string[] = [];
    const code = await runCli([...args, "--json"], { ...runtime, io: { stdout: text => output.push(text), stderr: text => errors.push(text) } });
    return { code, output: output.join("\n"), error: errors.join("\n") };
  };
  return { directory, requests,
    async input(name: string, body: unknown) { const filename = path.join(directory, `${name}.json`); await writeFile(filename, JSON.stringify(body)); return filename; },
    async ok(args: string[]) { const result = await call(args); assert.equal(result.code, 0, result.error); return JSON.parse(result.output); },
    async fail(args: string[], pattern?: RegExp) { const result = await call(args); assert.notEqual(result.code, 0, result.output); if (pattern) assert.match(result.error, pattern); return result.error; },
  };
}
