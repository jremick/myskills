import test from "node:test";
import assert from "node:assert/strict";
import { createNativeSkillsHandlers } from "../src/skills.js";
import type { FetchLike } from "../src/api-client.js";
import { nativeFixture, hash } from "./native-fixture.js";

const token = "aiss_native_test";
const unavailable = (error: unknown) => {
  assert.equal((error as { code: number }).code, -32602);
  assert.equal(String(error).includes("Résumé"), false);
  assert.equal(String(error).includes(token), false);
  return true;
};

test("read_skill_file returns one verified file with the release manifest", async () => {
  const fixture = nativeFixture();
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const instructions = await handlers.readFile({ slug: "native-test", version: "1.0.0+build.4" });
  assert.deepEqual(instructions.skill, { slug: "native-test", version: "1.0.0+build.4", name: "author-label", description: "Read café notes" });
  const skillFile = fixture.files.find((file) => file.path === "SKILL.md")!;
  assert.deepEqual(instructions.file, { path: "SKILL.md", sha256: hash(skillFile.content), size: Buffer.byteLength(skillFile.content), mimeType: "text/markdown" });
  assert.equal(instructions.content, skillFile.content);
  assert.deepEqual(instructions.files, fixture.files
    .map((file) => ({ path: file.path, sha256: hash(file.content), size: Buffer.byteLength(file.content) }))
    .sort((a, b) => a.path < b.path ? -1 : 1));
  const supporting = await handlers.readFile({ slug: "native-test", version: "1.0.0+build.4", path: "references/café.md" });
  assert.equal(supporting.content, "Résumé — 你好\n");
  assert.equal(supporting.file.mimeType, "text/markdown");
  assert.deepEqual(fixture.calls.filter((call) => call.method).map((call) => call.method), ["resources/read", "resources/read"]);
});

test("read_skill_file fails closed on tampered, hidden, revoked, unscoped or malformed requests", async () => {
  for (const path of ["../SKILL.md", "/SKILL.md", "references\\café.md", "references//café.md", "missing.md", ""]) {
    const fixture = nativeFixture();
    const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
    await assert.rejects(handlers.readFile({ slug: "native-test", version: "1.0.0+build.4", path }), unavailable, path);
  }
  for (const mutate of [
    (state: ReturnType<typeof nativeFixture>["state"]) => { state.tamper = true; },
    (state: ReturnType<typeof nativeFixture>["state"]) => { state.hidden = true; },
    (state: ReturnType<typeof nativeFixture>["state"]) => { state.revoked = true; },
    (state: ReturnType<typeof nativeFixture>["state"]) => { state.scopes = ["architectures:read"]; },
  ]) {
    const fixture = nativeFixture();
    mutate(fixture.state);
    const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
    await assert.rejects(handlers.readFile({ slug: "native-test", version: "1.0.0+build.4" }), unavailable);
  }
  const fixture = nativeFixture();
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  await assert.rejects(handlers.readFile({ slug: "Not A Slug", version: "1.0.0" }), unavailable);
  await assert.rejects(handlers.readFile({ slug: "native-test", version: "not-semver" }), unavailable);
  assert.equal(fixture.calls.some((call) => call.url.includes("/bundle")), false, "malformed input never reaches artifact delivery");
});

test("read_skill_file and native delivery accept OAuth connector sessions with skills:read", async () => {
  const fixture = nativeFixture();
  const oauthFetch: FetchLike = async (url, init) => {
    const response = await fixture.fetchImpl(url, init);
    if (!new URL(url).pathname.endsWith("/v1/mcp/session") || !response.ok) return response;
    const body = JSON.parse(await response.text());
    body.credential = { kind: "oauth", grantId: "grant-1", clientId: "msc_fixture", scopes: body.credential.scopes, resource: "https://skills.example.test/mcp" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: oauthFetch });
  assert.equal((await handlers.readFile({ slug: "native-test", version: "1.0.0+build.4" })).file.path, "SKILL.md");
  assert.equal((await handlers.list()).skills.length, 1);
});
