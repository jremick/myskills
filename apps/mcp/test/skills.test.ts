import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { createNativeSkillsHandlers } from "../src/skills.js";
import { NATIVE_API_METADATA_BYTES, type FetchLike } from "../src/api-client.js";
import { nativeFixture, hash, json } from "./native-fixture.js";

const token = "aiss_native_test";
const unavailable = (error: unknown) => {
  assert.equal((error as { code: number }).code, -32602);
  assert.equal(String(error).includes(token), false);
  assert.equal(String(error).includes("Résumé"), false);
  return true;
};

test("Skills return complete private manifests and preserve BOM, YAML fields and exact UTF-8 bytes", async () => {
  const fixture = nativeFixture();
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const list = await handlers.list();
  assert.equal(list.resultType, "complete");
  assert.equal(list.cacheScope, "private");
  assert.equal(list.ttlMs, 0);
  assert.equal(list.skills.length, 1);
  const skill = list.skills[0];
  assert.deepEqual(skill.frontmatter, { name: "author-label", description: "Read café notes", license: "MIT", metadata: { count: "2", enabled: "true" } });
  assert.match(skill.uri, /\/native-test\/1\.0\.0%2Bbuild\.4\/[a-f0-9]{64}\/author-label\/SKILL.md$/);
  assert.equal(skill.resources.length, fixture.files.length);
  assert.equal(fixture.calls.filter((call) => call.url.endsWith("/bundle?platform=codex")).length, 1);
  for (const file of fixture.files) {
    const uri = skill.uri.replace(/SKILL.md$/, file.path.split("/").map(encodeURIComponent).join("/"));
    const resource = skill.resources.find((item) => item.uri === uri);
    assert.deepEqual(resource, { uri, digest: `sha256:${hash(file.content)}`, size: Buffer.byteLength(file.content) });
    assert.deepEqual((await handlers.read({ uri })).contents, [{ uri, mimeType: file.path.endsWith(".md") ? "text/markdown" : "text/plain", text: file.content }]);
  }
  const get = await handlers.get({ uri: skill.uri });
  assert.deepEqual(get.skill, skill);
  assert.equal(get.cacheScope, "private");
  assert.equal(get.ttlMs, 0);
  assert.equal("nextCursor" in get, false);
  assert.deepEqual(fixture.calls.filter((call) => call.method).map((call) => call.method), ["skills/list", "resources/read", "resources/read", "resources/read", "skills/get"]);
});

test("Native pagination preserves actor-scoped API cursors and bounds one request's candidate count", async () => {
  const fixture = nativeFixture();
  fixture.state.nextCursor = "cursor-reader";
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const first = await handlers.list();
  assert.ok(first.nextCursor);
  assert.equal(fixture.calls[1].url, "/v1/skills?limit=5");
  assert.equal((await handlers.list({ cursor: first.nextCursor })).skills.length, 0);
  fixture.state.actor = "another-reader";
  await assert.rejects(handlers.list({ cursor: first.nextCursor }), unavailable);
  await assert.rejects(handlers.list({ cursor: "invalid" }), unavailable);
  const otherRegistry = createNativeSkillsHandlers({ apiBaseUrl: "https://other.example.test", token, fetchImpl: fixture.fetchImpl });
  await assert.rejects(otherRegistry.list({ cursor: first.nextCursor }), unavailable);
});

test("Frontmatter preserves authored JSON property names without granting prototype properties", async () => {
  const fixture = nativeFixture({ instructions: "---\nname: native-test\ndescription: Test\n__proto__:\n  injected: true\nconstructor: authored-label\n---\nInstructions\n" });
  const skill = (await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills[0];
  assert.ok(skill);
  assert.equal(Object.hasOwn(skill.frontmatter, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(skill.frontmatter), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(skill.frontmatter)), JSON.parse('{"name":"native-test","description":"Test","__proto__":{"injected":true},"constructor":"authored-label"}'));
});

test("Valid optional frontmatter is preserved, including reserved metadata with no adapter semantics", async () => {
  const fixture = nativeFixture({ instructions: "---\nname: native-test\ndescription: Test\nlicense: MIT\ncompatibility: Requires Node.js\nallowed-tools: Read Bash(git:*)\nmetadata:\n  io.modelcontextprotocol/future: ignored\n  author: Example\ncustom-field:\n  enabled: true\n---\nInstructions\n" });
  const skill = (await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills[0];
  assert.deepEqual(skill.frontmatter, {
    name: "native-test", description: "Test", license: "MIT", compatibility: "Requires Node.js",
    "allowed-tools": "Read Bash(git:*)", metadata: { "io.modelcontextprotocol/future": "ignored", author: "Example" },
    "custom-field": { enabled: true },
  });
});

test("Registry origins isolate identical immutable packages", async () => {
  const fixture = nativeFixture();
  const first = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const second = createNativeSkillsHandlers({ apiBaseUrl: "https://registry.example.test", token, fetchImpl: fixture.fetchImpl });
  const a = (await first.list()).skills[0];
  const b = (await second.list()).skills[0];
  assert.notEqual(a.uri, b.uri);
  await assert.rejects(second.get({ uri: a.uri }), unavailable);
});

test("Native discovery lists stable approved defaults and excludes hidden or prerelease candidates", async () => {
  for (const field of ["lifecycleStatus", "reviewStatus", "securityStatus"] as const) {
    const fixture = nativeFixture();
    fixture.skill[field] = "unapproved";
    assert.deepEqual((await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills, []);
    assert.equal(fixture.calls.length, 2);
  }
  const fixture = nativeFixture({ version: "1.1.0-rc.1" });
  assert.deepEqual((await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills, []);
});

test("An incompatible bounded release projection does not discard compatible neighbors", async () => {
  const before = nativeFixture({ slug: "a-native" });
  const incompatible = nativeFixture({ slug: "m-native" });
  const after = nativeFixture({ slug: "z-native" });
  incompatible.release.platforms = Array.from({ length: 101 }, (_, index) => ({
    name: `platform-${index}`, installTarget: "codex-skill", status: "supported",
  }));
  // This is valid registry input: the package contract has no platform-count
  // maximum. Native delivery's narrower projection must skip only this entry.
  const manifest = parseSkillManifest({
    ...JSON.parse(incompatible.files[0].content),
    platforms: incompatible.release.platforms.map((platform) => ({
      name: platform.name, install_target: platform.installTarget, status: platform.status,
    })),
  });
  assert.equal(manifest.platforms.length, 101);
  const fixtures = [before, incompatible, after];
  const fetchImpl: FetchLike = (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/v1/skills") return Promise.resolve(json(200, { skills: fixtures.map((fixture) => fixture.skill), nextCursor: null }));
    const fixture = fixtures.find((candidate) => path.includes(`/skills/${candidate.skill.slug}/`)) ?? before;
    return fixture.fetchImpl(url, init);
  };
  const listed = await createNativeSkillsHandlers({ token, fetchImpl }).list();
  assert.equal(listed.skills.length, 2);
  assert.match(listed.skills[0].uri, /\/a-native\//);
  assert.match(listed.skills[1].uri, /\/z-native\//);
  assert.equal(incompatible.calls.some((call) => call.url.includes("/bundle?")), false);
});

for (const [label, instructions] of [
  ["missing", "No frontmatter"],
  ["missing name", "---\ndescription: A description\n---\n"],
  ["duplicate", "---\nname: one\nname: two\ndescription: A description\n---\n"],
  ["alias", "---\nname: native-test\ndescription: &desc A description\nmetadata:\n  copy: *desc\n---\n"],
  ["unknown tag", "---\nname: native-test\ndescription: !unsafe A description\n---\n"],
  ["invalid name", "---\nname: ../outside\ndescription: A description\n---\n"],
  ["nonfinite", "---\nname: native-test\ndescription: Description\nmetadata:\n  bad: .inf\n---\n"],
  ["oversized frontmatter", `---\nname: native-test\ndescription: Short\nmetadata:\n  text: ${"x".repeat(33 * 1024)}\n---\n`],
  ["numeric metadata", "---\nname: native-test\ndescription: Test\nmetadata:\n  version: 2\n---\n"],
  ["nested metadata", "---\nname: native-test\ndescription: Test\nmetadata:\n  nested: { enabled: 'true' }\n---\n"],
  ["metadata array", "---\nname: native-test\ndescription: Test\nmetadata: [one, two]\n---\n"],
  ["nonstring license", "---\nname: native-test\ndescription: Test\nlicense: 2\n---\n"],
  ["empty compatibility", "---\nname: native-test\ndescription: Test\ncompatibility: ''\n---\n"],
  ["oversized compatibility", `---\nname: native-test\ndescription: Test\ncompatibility: ${"x".repeat(501)}\n---\n`],
  ["allowed tools array", "---\nname: native-test\ndescription: Test\nallowed-tools: [Read, Write]\n---\n"],
] as const) {
  test(`Native discovery excludes ${label} frontmatter`, async () => {
    const fixture = nativeFixture({ instructions });
    assert.deepEqual((await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills, []);
  });
}

test("Native delivery rejects invalid files, UTF-8 strings and package limits", async () => {
  for (const extra of [
    [{ path: "../outside", content: "private" }],
    [{ path: "skill.md", content: "case collision" }],
    [{ path: "invalid.txt", content: "\ud800" }],
    [{ path: "invalid.txt", content: "NUL\0" }],
    [{ path: "large.txt", content: "x".repeat(1024 * 1024) }],
    Array.from({ length: 500 }, (_, index) => ({ path: `extra-${index}.txt`, content: "x" })),
  ]) {
    const fixture = nativeFixture({ extra });
    assert.deepEqual((await createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl }).list()).skills, []);
  }
});

test("Each read reauthorizes token, release and bundle, even after a successful list and read", async () => {
  const fixture = nativeFixture();
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const uri = (await handlers.list()).skills[0].uri;
  await handlers.read({ uri });
  fixture.state.revoked = true;
  const before = fixture.calls.length;
  await assert.rejects(handlers.read({ uri }), unavailable);
  assert.equal(fixture.calls.length, before + 1);
  fixture.state.revoked = false;
  fixture.state.scopes = ["architectures:read"];
  await assert.rejects(handlers.get({ uri }), unavailable);
  fixture.state.scopes = ["skills:read"];
  fixture.state.hidden = true;
  await assert.rejects(handlers.read({ uri }), unavailable);
  fixture.state.hidden = false;
  fixture.state.tamper = true;
  await assert.rejects(handlers.read({ uri }), (error) => {
    assert.ok([-32602, -32603].includes((error as { code: number }).code));
    return true;
  });
});

test("Read and get fail closed for URI tampering, exact-version mismatches and undeclared files", async () => {
  const fixture = nativeFixture();
  const handlers = createNativeSkillsHandlers({ token, fetchImpl: fixture.fetchImpl });
  const uri = (await handlers.list()).skills[0].uri;
  for (const changed of [
    uri.replace(fixture.release.artifact.sha256, "0".repeat(64)),
    uri.replace("%2Bbuild.4", "+build.4"),
    uri.replace("author-label", "another-label"),
    uri.replace("SKILL.md", "../SKILL.md"),
    uri.replace("SKILL.md", "%2e%2e/SKILL.md"),
    uri.replace("SKILL.md", "references%2Fcaf%C3%A9.md"),
    uri.replace("SKILL.md", "unknown.txt"),
    `${uri}?token=${token}`,
    "https://external.example.test/SKILL.md",
  ]) await assert.rejects(handlers.read({ uri: changed }), unavailable);
  await assert.rejects(handlers.get({ uri: uri.replace("SKILL.md", "references/caf%C3%A9.md") }), unavailable);
  fixture.release.version = "1.0.0+other";
  await assert.rejects(handlers.get({ uri }), unavailable);
});

test("Native body reading caps streamed metadata and cancels the stream without text()", async () => {
  let cancelled = false;
  const fetchImpl: FetchLike = async () => ({
    ok: true, status: 200,
    body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(NATIVE_API_METADATA_BYTES + 1)); }, cancel() { cancelled = true; } }),
    async text() { throw new Error("Unbounded text() must not run"); },
  });
  await assert.rejects(createNativeSkillsHandlers({ token, fetchImpl }).list(), { code: -32603 });
  assert.equal(cancelled, true);
});

test("Native response declared sizes and tokenless requests fail before consuming content", async () => {
  let requests = 0;
  let cancelled = false;
  const fetchImpl: FetchLike = async () => {
    requests += 1;
    return { ok: true, status: 200,
      headers: { get: () => String(NATIVE_API_METADATA_BYTES + 1) },
      body: new ReadableStream({ cancel() { cancelled = true; } }),
      async text() { throw new Error("must not consume text"); },
    };
  };
  await assert.rejects(createNativeSkillsHandlers({ fetchImpl }).list(), unavailable);
  assert.equal(requests, 0);
  await assert.rejects(createNativeSkillsHandlers({ token, fetchImpl }).list(), { code: -32603 });
  assert.equal(cancelled, true);
});

test("Native body deadline honors caller abort even when an upstream read never resolves", async () => {
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let cancelled = false;
  const fetchImpl: FetchLike = async (_url, init) => {
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    return { ok: true, status: 200, body: new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } }), async text() { throw new Error(); } };
  };
  const pending = createNativeSkillsHandlers({ token, fetchImpl }).list({}, abort.signal);
  await ready;
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, { code: -32603 });
  assert.equal(cancelled, true);
});

test("Native list never turns upstream outage into a successful empty listing", async () => {
  const fixture = nativeFixture();
  const fetchImpl: FetchLike = (url, init) => url.includes("/releases/") ? Promise.resolve(json(503, { internal: "private detail" })) : fixture.fetchImpl(url, init);
  await assert.rejects(createNativeSkillsHandlers({ token, fetchImpl }).list(), { code: -32603 });
});
