import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCli, type CliRuntime } from "../src/cli.js";

// Written before the library client implementation. This drives the CLI over
// real HTTP and verifies real managed files. Backend authorization has its own
// PostgreSQL journey; this fixture exercises the client/installer boundary.
test("library adoption constrains install and updates, survives revocation, and preserves local edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-journey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slug = "source-helper-a1b2c3";
  const entryId = "11111111-1111-4111-8111-111111111111";
  let adoptedVersion = "0.0.1";
  let unavailable = false;
  let changeDuringDownload = false;
  const requests: string[] = [];
  const receipts: Array<{ step: string; exitCode: number }> = [];
  const releases = ["0.0.1", "0.0.2", "0.0.3"].map((version) => {
    const bundle = JSON.stringify({ files: [
      { path: "SKILL.md", content: `---\nname: source-helper\ndescription: A synthetic imported helper.\n---\nVersion ${version}\n` },
      { path: "references/guide.md", content: `Supporting material ${version}\n` },
      { path: "LICENSE", content: "Synthetic test license notice\n" },
      { path: "skill.json", content: JSON.stringify({ name: slug, title: "Source helper", summary: "A synthetic imported helper.", version, license: "MIT", visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill" }] }) },
    ] });
    return { bundle, metadata: { slug, version, lifecycleStatus: "approved", publishedAt: "2026-09-26T00:00:00.000Z", platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }], artifact: { sha256: createHash("sha256").update(bundle).digest("hex"), byteSize: Buffer.byteLength(bundle) }, releaseNotes: "Synthetic approved change", changeKind: "fix", requiresUserAction: false, compatibility: {} } };
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(url.pathname);
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== "Bearer fixture-library-token") return send({ error: { code: "UNAUTHORIZED", message: "Sign in" } }, 401);
    if (url.pathname === "/v1/capabilities") return send({ instanceId: "22222222-2222-4222-8222-222222222222" });
    if (url.pathname === `/v1/library-entries/${entryId}/resolution`) {
      if (unavailable) return send({ error: { code: "LIBRARY_ENTRY_UNAVAILABLE", message: "Library entry is unavailable" } }, 404);
      return send({ resolution: { state: "adopted", entryId, libraryId: "33333333-3333-4333-8333-333333333333", slug, version: adoptedVersion, artifactSha256: releases.find((r) => r.metadata.version === adoptedVersion)!.metadata.artifact.sha256, adoptionId: `adoption-${adoptedVersion}` } });
    }
    if (url.pathname === `/v1/skills/${slug}/releases`) return send({ releases: releases.map((r) => r.metadata) });
    const release = releases.find((r) => url.pathname.startsWith(`/v1/skills/${slug}/releases/${r.metadata.version}`));
    if (release && url.pathname.endsWith("/bundle")) {
      if (changeDuringDownload) { adoptedVersion = "0.0.3"; changeDuringDownload = false; }
      res.end(release.bundle); return;
    }
    if (release) return send({ release: release.metadata });
    send({ error: { code: "NOT_FOUND", message: "Unknown fixture route" } }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  let output: string[] = [];
  const runtime: CliRuntime = { env: { MYSKILLS_TOKEN: "fixture-library-token" }, fetch: (input, init) => fetch(input, init), io: { stdout: (s) => output.push(s), stderr: (s) => output.push(s) } };
  async function command(step: string, args: string[]) {
    output = [];
    const code = await runCli([...args, "--dir", root, "--api-url", apiUrl], runtime);
    receipts.push({ step, exitCode: code });
    return code;
  }
  const skillPath = path.join(root, slug, "SKILL.md");
  assert.equal(await command("install adopted version", ["install", slug, "--library-entry", entryId]), 0, output.join("\n"));
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.1/);
  assert.equal(await command("ignore newer unadopted release", ["update", slug]), 0, output.join("\n"));
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.1/);
  assert.notEqual(await command("reject explicit version bypass", ["install", slug, "--version", "0.0.3"]), 0);
  adoptedVersion = "0.0.2";
  changeDuringDownload = true;
  assert.notEqual(await command("reject adoption change before promotion", ["update", slug]), 0);
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.1/);
  adoptedVersion = "0.0.2";
  assert.equal(await command("apply new adoption", ["update", slug]), 0, output.join("\n"));
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.2/);
  unavailable = true;
  assert.notEqual(await command("retain pin when entry disappears", ["update", slug]), 0);
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.2/);
  unavailable = false;
  adoptedVersion = "0.0.3";
  await writeFile(skillPath, "My local customization\n");
  assert.notEqual(await command("preserve local drift", ["update", slug]), 0);
  assert.equal(await readFile(skillPath, "utf8"), "My local customization\n");
  assert.equal(await command("explicitly detach local binding", ["libraries", "unbind-local", slug]), 0, output.join("\n"));
  assert.equal(await readFile(skillPath, "utf8"), "My local customization\n");
  assert.equal(await command("read retained local install", ["list", "--json"]), 0);
  assert.equal(JSON.parse(output[0]).installations[0].libraryEntryId, undefined);
  assert.ok(requests.some((r) => r.endsWith("/resolution")));
  // TAP diagnostic is retained by the verification log and is repeatable.
  t.diagnostic(JSON.stringify({ journey: "library-cli", receipts, preservedLocalContent: true }));
});

test("library management commands carry reviewed JSON over authenticated HTTP with stable mutation IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-api-journey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const received: Array<{ path: string; method: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-library-token");
    let text = ""; for await (const chunk of req) text += chunk;
    received.push({ path: req.url!, method: req.method!, body: text ? JSON.parse(text) : null });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const output: string[] = [];
  const runtime: CliRuntime = { env: { MYSKILLS_TOKEN: "fixture-library-token" }, fetch: (input, init) => fetch(input, init), io: { stdout: (s) => output.push(s), stderr: (s) => output.push(s) } };
  const journeys = [
    { action: "create", id: null, method: "POST", path: "/v1/libraries", body: { name: "Planning", owner: { type: "user" }, clientMutationId: "retry-library-1" } },
    { action: "add-source", id: "lib-1", method: "POST", path: "/v1/libraries/lib-1/entries", body: { kind: "source", url: "https://github.com/example/skills", clientMutationId: "retry-source-1" } },
    { action: "discover", id: "entry-1", method: "POST", path: "/v1/library-entries/entry-1/discoveries", body: null },
    { action: "preview", id: "entry-1", method: "POST", path: "/v1/library-entries/entry-1/previews", body: { snapshotId: "snapshot-1", paths: ["skills/planner"] } },
    { action: "import", id: "candidate-1", method: "POST", path: "/v1/library-candidates/candidate-1/import", body: { expectedPackageDigest: "a".repeat(64), release: { classification: "unclassified" }, clientMutationId: "retry-import-1" } },
    { action: "self-review", id: "candidate-1", method: "POST", path: "/v1/library-candidates/candidate-1/self-review", body: { artifactSha256: "a".repeat(64) } },
    { action: "adopt", id: "entry-2", method: "POST", path: "/v1/library-entries/entry-2/adoptions", body: { version: "0.0.1", artifactSha256: "a".repeat(64), expectedCurrentAdoptionId: null } },
    { action: "tracking", id: "entry-1", method: "PATCH", path: "/v1/library-entries/entry-1/tracking", body: { expectedRevision: 2, mode: "weekly" } },
    { action: "subscribe", id: "lib-1", method: "PUT", path: "/v1/libraries/lib-1/subscription", body: { events: ["candidate-ready", "adoption-changed"] } },
  ];
  for (const journey of journeys) {
    const inputPath = path.join(root, "request.json");
    if (journey.body) await writeFile(inputPath, JSON.stringify(journey.body));
    const args = ["libraries", journey.action, ...(journey.id ? [journey.id] : []), ...(journey.body ? ["--input", inputPath] : []), "--api-url", `http://127.0.0.1:${address.port}`, "--json"];
    assert.equal(await runCli(args, runtime), 0, output.join("\n"));
    assert.deepEqual(received.at(-1), { path: journey.path, method: journey.method, body: journey.body });
  }
  const before = received.length;
  assert.notEqual(await runCli(["libraries", "import", "candidate-1", "--api-url", `http://127.0.0.1:${address.port}`], runtime), 0);
  assert.equal(received.length, before, "missing reviewed payload must fail before network mutation");
  t.diagnostic(JSON.stringify({ journey: "library-cli-management", verifiedActions: journeys.map((row) => row.action), missingPayloadBlocked: true }));
});

// Review fixes M3, M8, L6 and L7 (2026-09-26), with M2 coverage. This failure
// list was written before the CLI changes. Each journey names the failures it
// must prove absent.
// M3  F1  `updates` stops at one unavailable entry, so other skills get no report.
//     F2  `update` without a slug stops before later bound and unbound skills.
//     F3  An unavailable skill falls back to the newest registry release.
//     F4  An unavailable skill loses its files or its local library binding.
//     F5  `update` exits 0 although a bound skill could not be checked.
//     F6  A revoked adoption or a missing adoption is handled differently from a 404.
//     F7  A malformed or mismatched resolution is reported as "unavailable".
//     F8  `install` of an unavailable binding succeeds or picks another release.
//     F9  The JSON report is missing or not parseable after a partial batch.
// M8  F10 A token without libraries:read gets a generic scope error, or a
//         curation-unavailable result instead of an actionable error.
// M2  F11 A release that requires user action installs or updates without
//         --accept-user-action.
//     F12 The refused attempt leaves files or a registry record.
//     F13 With --accept-user-action, a library-bound install or update is refused.
// L6  F14 An older adoption is reported only as pinned-release-unavailable.
//     F15 update or install silently downgrades to the older adoption.
//     F16 Rollback is advised when the last snapshot is a different version.
//     F17 Rollback drops the local library binding.
// L7  F18 review-bundle prints bytes that do not match x-myskills-artifact-sha256.
//     F19 A missing digest header is accepted.
//     F20 Output is written before verification, or differs from the served bytes.
//     F21 An existing output file is overwritten.

type EntryMode = "adopted" | "not-found" | "no-adoption" | "adoption-unavailable" | "malformed" | "scope-denied";
interface FixtureEntry { slug: string; version: string; mode: EntryMode }
interface UpdateRow {
  slug: string;
  evaluation: { status: string; installedVersion: string; candidate?: { version: string; requiresUserAction: boolean }; blockers: string[] };
  library?: { state: string; entryId: string; adoptedVersion?: string; reason?: string; recovery?: string; message?: string };
  appliedVersion?: string;
}
type FixtureRelease = ReturnType<typeof fixtureRelease>;

function fixtureRelease(slug: string, version: string, requiresUserAction = false) {
  const bundle = JSON.stringify({ files: [
    { path: "SKILL.md", content: `---\nname: ${slug}\ndescription: A synthetic library helper.\n---\nVersion ${version}\n` },
    { path: "references/guide.md", content: `Supporting material ${version}\n` },
    { path: "LICENSE", content: "Synthetic test license notice\n" },
    { path: "skill.json", content: JSON.stringify({ name: slug, title: "Library helper", summary: "A synthetic library helper.", version, license: "MIT", visibility: "private", platforms: [{ name: "codex", install_target: "codex-skill" }] }) },
  ] });
  return { bundle, metadata: { slug, version, lifecycleStatus: "approved", publishedAt: "2026-09-26T00:00:00.000Z", platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }], artifact: { sha256: createHash("sha256").update(bundle).digest("hex"), byteSize: Buffer.byteLength(bundle) }, releaseNotes: `Synthetic reviewed change ${version}`, changeKind: "fix", requiresUserAction, compatibility: {} } };
}

async function startLibraryRegistry(t: TestContext, releases: Map<string, FixtureRelease[]>, entries: Map<string, FixtureEntry>) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    requests.push(url.pathname);
    res.setHeader("content-type", "application/json");
    const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== "Bearer fixture-library-token") return send({ error: { code: "UNAUTHORIZED", message: "Sign in" } }, 401);
    if (url.pathname === "/v1/capabilities") return send({ instanceId: "22222222-2222-4222-8222-222222222222" });
    const resolution = /^\/v1\/library-entries\/([^/]+)\/resolution$/.exec(url.pathname);
    if (resolution) {
      const entryId = decodeURIComponent(resolution[1]);
      const entry = entries.get(entryId);
      // A deleted entry and lost access share one generic 404 (API contract §4.8).
      if (!entry || entry.mode === "not-found") return send({ error: { code: "LIBRARY_ENTRY_NOT_FOUND", message: "Library entry not found." } }, 404);
      if (entry.mode === "scope-denied") return send({ error: { code: "API_TOKEN_SCOPE_REQUIRED", message: "API token scope is required.", details: { scope: "libraries:read" } } }, 403);
      const base = { entryId, libraryId: "33333333-3333-4333-8333-333333333333", slug: entry.slug };
      if (entry.mode === "no-adoption") return send({ resolution: { state: "no-adoption", ...base } });
      if (entry.mode === "adoption-unavailable") return send({ resolution: { state: "adoption-unavailable", ...base, version: entry.version } });
      const adopted = releases.get(entry.slug)!.find((r) => r.metadata.version === entry.version)!;
      return send({ resolution: { state: "adopted", ...base, ...(entry.mode === "malformed" ? { slug: "different-helper" } : {}), version: entry.version, artifactSha256: adopted.metadata.artifact.sha256, adoptionId: `adoption-${entry.slug}-${entry.version}`, adoptedAt: "2026-09-26T00:00:00.000Z" } });
    }
    const skill = /^\/v1\/skills\/([^/]+)\/releases(?:\/([^/]+)(\/bundle)?)?$/.exec(url.pathname);
    const list = skill ? releases.get(decodeURIComponent(skill[1])) : undefined;
    if (skill && list) {
      if (!skill[2]) return send({ releases: list.map((r) => r.metadata) });
      const release = list.find((r) => r.metadata.version === decodeURIComponent(skill[2]));
      if (release && skill[3]) { res.end(release.bundle); return; }
      if (release) return send({ release: release.metadata });
    }
    send({ error: { code: "NOT_FOUND", message: "Unknown fixture route" } }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { apiUrl: `http://127.0.0.1:${address.port}`, requests, bundles: () => requests.filter((pathname) => pathname.endsWith("/bundle")) };
}

function fixtureCli(apiUrl: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const receipts: Array<{ step: string; exitCode: number }> = [];
  const runtime: CliRuntime = { env: { MYSKILLS_TOKEN: "fixture-library-token" }, fetch: (input, init) => fetch(input, init), io: { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s) } };
  return {
    stdout,
    stderr,
    receipts,
    async run(step: string, args: string[]) {
      stdout.length = 0;
      stderr.length = 0;
      const exitCode = await runCli([...args, "--api-url", apiUrl], runtime);
      receipts.push({ step, exitCode });
      return exitCode;
    },
    text: () => [...stdout, ...stderr].join("\n"),
    json: () => JSON.parse(stdout.join("\n")),
    error: () => JSON.parse(stderr.join("\n")).error as { code: string; message: string; status?: number },
  };
}

function updateRows(value: unknown): Map<string, UpdateRow> {
  return new Map((value as { updates: UpdateRow[] }).updates.map((row) => [row.slug, row]));
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch { return false; }
}

test("updates and update report unavailable library curation per skill and continue with unrelated skills", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = {
    alpha: "aaaaaaaa-1111-4111-8111-111111111111",
    bravo: "bbbbbbbb-1111-4111-8111-111111111111",
    charlie: "cccccccc-1111-4111-8111-111111111111",
    delta: "dddddddd-1111-4111-8111-111111111111",
  };
  const bound: Array<[string, string]> = [["alpha-helper", ids.alpha], ["bravo-helper", ids.bravo], ["charlie-helper", ids.charlie], ["delta-helper", ids.delta]];
  const releases = new Map(["alpha-helper", "bravo-helper", "charlie-helper", "delta-helper", "echo-helper"]
    .map((slug): [string, FixtureRelease[]] => [slug, ["0.0.1", "0.0.2", "0.0.3"].map((version) => fixtureRelease(slug, version))]));
  const entries = new Map(bound.map(([slug, entryId]): [string, FixtureEntry] => [entryId, { slug, version: "0.0.1", mode: "adopted" }]));
  const registry = await startLibraryRegistry(t, releases, entries);
  const cli = fixtureCli(registry.apiUrl);
  const skillText = (slug: string) => readFile(path.join(root, slug, "SKILL.md"), "utf8");
  for (const [slug, entryId] of bound) {
    assert.equal(await cli.run(`install ${slug}`, ["install", slug, "--library-entry", entryId, "--dir", root]), 0, cli.text());
  }
  assert.equal(await cli.run("install unbound echo-helper", ["install", "echo-helper", "--version", "0.0.1", "--dir", root]), 0, cli.text());

  // The entry is deleted (or access is lost), the adopted release is revoked,
  // the adoption is cleared, and an unrelated bound entry adopts 0.0.2.
  entries.get(ids.alpha)!.mode = "not-found";
  entries.get(ids.bravo)!.mode = "adoption-unavailable";
  entries.get(ids.charlie)!.mode = "no-adoption";
  entries.get(ids.delta)!.version = "0.0.2";

  // F1, F6: the read-only report covers every skill, in sorted order.
  assert.equal(await cli.run("readable report", ["updates", "--dir", root]), 0, cli.text());
  const readable = cli.stdout.join("\n");
  assert.match(readable, /^alpha-helper@0\.0\.1\tcuration-unavailable\tplatform=codex\tlibraryEntry=aaaaaaaa-[^\t]+\treason=LIBRARY_ENTRY_NOT_FOUND$/m);
  assert.match(readable, /^library\t.*unbind-local alpha-helper/m);
  assert.match(readable, /^bravo-helper@0\.0\.1\tcuration-unavailable\t.*\treason=adoption-unavailable$/m);
  assert.match(readable, /^charlie-helper@0\.0\.1\tcuration-unavailable\t.*\treason=no-adoption$/m);
  assert.match(readable, /^delta-helper@0\.0\.1\tupdate-available\tplatform=codex\tcandidate=0\.0\.2$/m);
  assert.match(readable, /^echo-helper@0\.0\.1\tupdate-available\tplatform=codex\tcandidate=0\.0\.3$/m);

  assert.equal(await cli.run("JSON report", ["updates", "--dir", root, "--json"]), 0, cli.text());
  let rows = updateRows(cli.json());
  assert.equal(rows.size, 5);
  for (const [slug, reason] of [["alpha-helper", "LIBRARY_ENTRY_NOT_FOUND"], ["bravo-helper", "adoption-unavailable"], ["charlie-helper", "no-adoption"]]) {
    const row = rows.get(slug)!;
    assert.equal(row.library?.state, "curation-unavailable", slug);
    assert.equal(row.library?.reason, reason, slug);
    assert.equal(row.evaluation.status, "pinned", slug);
    assert.equal(row.evaluation.installedVersion, "0.0.1", slug);
    assert.equal(row.evaluation.candidate, undefined, slug);
  }
  assert.equal(rows.get("delta-helper")!.library?.state, "adopted");
  assert.equal(rows.get("delta-helper")!.library?.adoptedVersion, "0.0.2");
  assert.equal(rows.get("delta-helper")!.evaluation.candidate?.version, "0.0.2");
  assert.equal(rows.get("echo-helper")!.library, undefined);

  // F2, F3, F5, F9: the blocked batch still applies later skills and reports JSON.
  const bundlesBefore = registry.bundles().length;
  assert.equal(await cli.run("partial batch update", ["update", "--dir", root, "--json"]), 1, cli.text());
  rows = updateRows(cli.json());
  assert.equal(rows.get("delta-helper")!.appliedVersion, "0.0.2");
  assert.equal(rows.get("echo-helper")!.appliedVersion, "0.0.3");
  for (const slug of ["alpha-helper", "bravo-helper", "charlie-helper"]) {
    assert.equal(rows.get(slug)!.library?.state, "curation-unavailable", slug);
    assert.equal(rows.get(slug)!.appliedVersion, undefined, slug);
    assert.match(await skillText(slug), /Version 0\.0\.1/);
  }
  assert.match(await skillText("delta-helper"), /Version 0\.0\.2/);
  assert.match(await skillText("echo-helper"), /Version 0\.0\.3/);
  assert.deepEqual(registry.bundles().slice(bundlesBefore).sort(), ["/v1/skills/delta-helper/releases/0.0.2/bundle", "/v1/skills/echo-helper/releases/0.0.3/bundle"]);

  // F4: local bindings survive the unavailable curation.
  assert.equal(await cli.run("bindings retained", ["list", "--dir", root, "--json"]), 0, cli.text());
  const installed = new Map((cli.json().installations as Array<{ slug: string; libraryEntryId?: string }>).map((row) => [row.slug, row.libraryEntryId]));
  for (const [slug, entryId] of bound) assert.equal(installed.get(slug), entryId, slug);
  assert.equal(installed.get("echo-helper"), undefined);

  // F8: install stays fail closed and downloads nothing.
  const bundlesBeforeInstall = registry.bundles().length;
  assert.notEqual(await cli.run("install stays fail closed", ["install", "alpha-helper", "--dir", root, "--json"]), 0);
  assert.equal(cli.error().code, "LIBRARY_CURATION_UNAVAILABLE");
  assert.equal(registry.bundles().length, bundlesBeforeInstall);
  assert.match(await skillText("alpha-helper"), /Version 0\.0\.1/);

  // F7: an integrity failure is not an expected unavailable state; the batch stops.
  entries.get(ids.alpha)!.mode = "malformed";
  entries.get(ids.delta)!.version = "0.0.3";
  assert.notEqual(await cli.run("mismatched resolution fails closed", ["update", "--dir", root, "--json"]), 0);
  assert.equal(cli.stdout.length, 0);
  assert.equal(cli.error().code, "LIBRARY_RESOLUTION_INVALID");
  assert.match(await skillText("delta-helper"), /Version 0\.0\.2/);

  // F10: a token without libraries:read gets an actionable error.
  entries.get(ids.alpha)!.mode = "scope-denied";
  assert.notEqual(await cli.run("token without libraries:read", ["updates", "--dir", root]), 0);
  assert.equal(cli.stdout.length, 0);
  assert.match(cli.stderr.join("\n"), /libraries:read/);
  assert.match(cli.stderr.join("\n"), /targets:execute/);
  assert.notEqual(await cli.run("token scope error as JSON", ["updates", "--dir", root, "--json"]), 0);
  assert.equal(cli.error().code, "API_TOKEN_SCOPE_REQUIRED");
  assert.equal(cli.error().status, 403);
  t.diagnostic(JSON.stringify({ journey: "library-cli-partial-curation", receipts: cli.receipts, retainedPins: ["alpha-helper", "bravo-helper", "charlie-helper"], applied: { "delta-helper": "0.0.2", "echo-helper": "0.0.3" } }));
});

test("a reviewed library release that requires user action installs and updates only with explicit acceptance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-user-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const slug = "review-needed-helper";
  const entryId = "eeeeeeee-2222-4222-8222-222222222222";
  // Web imports send classification "unclassified", which requires user action.
  const releases = new Map([[slug, [fixtureRelease(slug, "0.0.1", true), fixtureRelease(slug, "0.0.2", true)]]]);
  const entries = new Map<string, FixtureEntry>([[entryId, { slug, version: "0.0.1", mode: "adopted" }]]);
  const registry = await startLibraryRegistry(t, releases, entries);
  const cli = fixtureCli(registry.apiUrl);
  const skillPath = path.join(root, slug, "SKILL.md");

  // F11, F12
  assert.notEqual(await cli.run("install without acceptance", ["install", slug, "--library-entry", entryId, "--dir", root]), 0);
  assert.match(cli.text(), /--accept-user-action/);
  assert.equal(await exists(path.join(root, slug)), false);
  assert.equal(await cli.run("no registry record", ["list", "--dir", root, "--json"]), 0, cli.text());
  assert.deepEqual(cli.json().installations, []);

  // F13
  assert.equal(await cli.run("install with acceptance", ["install", slug, "--library-entry", entryId, "--accept-user-action", "--dir", root]), 0, cli.text());
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.1/);
  entries.get(entryId)!.version = "0.0.2";
  assert.equal(await cli.run("report required action", ["updates", slug, "--dir", root, "--json"]), 0, cli.text());
  const row = updateRows(cli.json()).get(slug)!;
  assert.equal(row.evaluation.status, "update-available");
  assert.equal(row.evaluation.candidate?.version, "0.0.2");
  assert.equal(row.evaluation.candidate?.requiresUserAction, true);
  assert.equal(row.library?.state, "adopted");
  assert.notEqual(await cli.run("update without acceptance", ["update", slug, "--dir", root]), 0);
  assert.match(cli.text(), /--accept-user-action/);
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.1/);
  assert.equal(await cli.run("update with acceptance", ["update", slug, "--accept-user-action", "--dir", root]), 0, cli.text());
  assert.match(await readFile(skillPath, "utf8"), /Version 0\.0\.2/);
  assert.equal(await cli.run("binding retained", ["list", "--dir", root, "--json"]), 0, cli.text());
  assert.equal(cli.json().installations[0].libraryEntryId, entryId);
  t.diagnostic(JSON.stringify({ journey: "library-cli-user-action", receipts: cli.receipts }));
});

test("an older library adoption is explained without a downgrade and points to rollback or a new root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-older-"));
  const newRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-library-older-new-root-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(newRoot, { recursive: true, force: true })]).then(() => undefined));
  const slug = "older-pin-helper";
  const entryId = "ffffffff-3333-4333-8333-333333333333";
  const releases = new Map([[slug, ["0.0.1", "0.0.2", "0.0.3"].map((version) => fixtureRelease(slug, version))]]);
  const entries = new Map<string, FixtureEntry>([[entryId, { slug, version: "0.0.1", mode: "adopted" }]]);
  const registry = await startLibraryRegistry(t, releases, entries);
  const cli = fixtureCli(registry.apiUrl);
  const skillText = () => readFile(path.join(root, slug, "SKILL.md"), "utf8");
  assert.equal(await cli.run("install adopted 0.0.1", ["install", slug, "--library-entry", entryId, "--dir", root]), 0, cli.text());
  for (const version of ["0.0.2", "0.0.3"]) {
    entries.get(entryId)!.version = version;
    assert.equal(await cli.run(`apply adoption ${version}`, ["update", slug, "--dir", root]), 0, cli.text());
  }
  assert.match(await skillText(), /Version 0\.0\.3/);

  // F14, F16: the last snapshot is 0.0.2, so rollback cannot restore 0.0.1.
  entries.get(entryId)!.version = "0.0.1";
  assert.equal(await cli.run("readable older adoption", ["updates", slug, "--dir", root]), 0, cli.text());
  const readable = cli.stdout.join("\n");
  assert.match(readable, /^older-pin-helper@0\.0\.3\tlibrary-adopts-older\tplatform=codex\tadopted=0\.0\.1\tlibraryEntry=ffffffff-/m);
  assert.match(readable, /--dir <new-root>/);
  assert.doesNotMatch(readable, /pinned-release-unavailable|myskills rollback/);
  assert.equal(await cli.run("JSON older adoption", ["updates", slug, "--dir", root, "--json"]), 0, cli.text());
  let row = updateRows(cli.json()).get(slug)!;
  assert.equal(row.library?.state, "adoption-older-than-installed");
  assert.equal(row.library?.adoptedVersion, "0.0.1");
  assert.equal(row.library?.recovery, "new-root");
  assert.equal(row.evaluation.installedVersion, "0.0.3");

  // F15: neither update nor install downgrades or downloads the older release.
  const bundlesBefore = registry.bundles().length;
  assert.equal(await cli.run("update never downgrades", ["update", slug, "--dir", root]), 1, cli.text());
  assert.match(cli.stdout.join("\n"), /library-adopts-older/);
  assert.notEqual(await cli.run("install never downgrades", ["install", slug, "--dir", root, "--json"]), 0);
  assert.equal(cli.error().code, "LIBRARY_ADOPTION_OLDER_THAN_INSTALLED");
  assert.match(cli.error().message, /--dir <new-root>/);
  assert.equal(registry.bundles().length, bundlesBefore);
  assert.match(await skillText(), /Version 0\.0\.3/);

  // F16, F17: the last snapshot is the adopted release, so rollback is advised
  // and restores it with the binding intact.
  entries.get(entryId)!.version = "0.0.2";
  assert.equal(await cli.run("rollback advised", ["updates", slug, "--dir", root, "--json"]), 0, cli.text());
  row = updateRows(cli.json()).get(slug)!;
  assert.equal(row.library?.recovery, "rollback");
  assert.match(row.library?.message ?? "", /myskills rollback older-pin-helper/);
  assert.equal(await cli.run("explicit rollback", ["rollback", slug, "--dir", root]), 0, cli.text());
  assert.match(await skillText(), /Version 0\.0\.2/);
  assert.equal(await cli.run("pinned after rollback", ["updates", slug, "--dir", root, "--json"]), 0, cli.text());
  row = updateRows(cli.json()).get(slug)!;
  assert.equal(row.evaluation.status, "pinned");
  assert.equal(row.library?.state, "adopted");
  assert.equal(await cli.run("binding retained", ["list", "--dir", root, "--json"]), 0, cli.text());
  assert.equal(cli.json().installations[0].libraryEntryId, entryId);

  // The new-root guidance works as printed.
  entries.get(entryId)!.version = "0.0.1";
  assert.equal(await cli.run("install older adoption in a new root", ["install", slug, "--library-entry", entryId, "--dir", newRoot]), 0, cli.text());
  assert.match(await readFile(path.join(newRoot, slug, "SKILL.md"), "utf8"), /Version 0\.0\.1/);
  assert.match(await skillText(), /Version 0\.0\.2/);
  t.diagnostic(JSON.stringify({ journey: "library-cli-older-adoption", receipts: cli.receipts, downgradeRefused: true }));
});

test("libraries review-bundle releases only bytes that match the artifact digest header", async (t) => {
  // F22: a self-consistent replacement body/header must still fail when the
  // reviewer supplies the immutable digest from the review request.
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-library-review-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Multi-byte UTF-8 content proves byte-exact handling, not a re-serialisation.
  const body = JSON.stringify({ files: [
    { path: "SKILL.md", content: "---\nname: reviewed-helper\ndescription: Résumé checks ✓\n---\nReviewed body\n" },
    { path: "LICENSE", content: "Synthetic test license notice\n" },
  ] });
  const digest = createHash("sha256").update(body).digest("hex");
  const tampered = body.replace("Reviewed body", "Tampered body");
  const server = createServer((req, res) => {
    const id = /^\/v1\/review\/self-reviewed-releases\/([^/]+)\/bundle$/.exec(new URL(req.url!, "http://localhost").pathname)?.[1];
    res.setHeader("content-type", "application/vnd.myskills-app.package+json");
    if (req.headers.authorization !== "Bearer fixture-library-token" || !id) { res.statusCode = 404; res.end(JSON.stringify({ error: { code: "SUBMISSION_NOT_FOUND", message: "Submission not found." } })); return; }
    if (id !== "sub-missing-header") res.setHeader("x-myskills-artifact-sha256", digest);
    res.end(id === "sub-tampered" ? tampered : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const cli = fixtureCli(`http://127.0.0.1:${address.port}`);
  const exact = path.join(root, "bundle.json");

  assert.equal(await cli.run("verified bundle", ["libraries", "review-bundle", "sub-verified", "--output", exact]), 0, cli.text());
  const printed = cli.json();
  assert.equal(printed.artifactSha256, digest);
  assert.equal(printed.byteSize, Buffer.byteLength(body));
  assert.equal(printed.digestVerified, true);
  assert.equal(printed.output, path.resolve(exact));
  assert.equal(printed.payloadForm, "parsed-for-inspection");
  assert.equal(printed.payload.files.length, 2);
  const written = await readFile(exact);
  assert.ok(written.equals(Buffer.from(body, "utf8")), "the output keeps the served bytes");
  assert.equal(createHash("sha256").update(written).digest("hex"), digest);

  assert.equal(await cli.run("match review request digest", ["libraries", "review-bundle", "sub-verified", "--artifact-sha256", digest, "--json"]), 0, cli.text());
  assert.equal(cli.json().expectedDigestVerified, true);
  const unexpected = path.join(root, "unexpected.json");
  assert.notEqual(await cli.run("deny different review request digest", ["libraries", "review-bundle", "sub-verified", "--artifact-sha256", "0".repeat(64), "--output", unexpected, "--json"]), 0);
  assert.equal(cli.error().code, "ARTIFACT_HASH_MISMATCH");
  assert.equal(cli.stdout.length, 0);
  assert.equal(await exists(unexpected), false);
  assert.notEqual(await cli.run("deny malformed review request digest", ["libraries", "review-bundle", "sub-verified", "--artifact-sha256", "invalid", "--json"]), 0);
  assert.equal(cli.error().code, "CLI_ARGUMENTS_INVALID");

  // F18, F20
  const denied = path.join(root, "tampered.json");
  assert.notEqual(await cli.run("tampered bundle", ["libraries", "review-bundle", "sub-tampered", "--output", denied]), 0);
  assert.equal(cli.stdout.length, 0);
  assert.match(cli.stderr.join("\n"), /digest/i);
  assert.equal(await exists(denied), false);
  // F19
  assert.notEqual(await cli.run("missing digest header", ["libraries", "review-bundle", "sub-missing-header", "--json"]), 0);
  assert.equal(cli.stdout.length, 0);
  assert.equal(cli.error().code, "ARTIFACT_HASH_MISSING");
  // F21
  assert.notEqual(await cli.run("existing output kept", ["libraries", "review-bundle", "sub-verified", "--output", exact]), 0);
  assert.equal(cli.stdout.length, 0);
  assert.ok((await readFile(exact)).equals(Buffer.from(body, "utf8")));
  t.diagnostic(JSON.stringify({ journey: "library-cli-review-bundle", receipts: cli.receipts, verifiedDigest: digest, tamperedDenied: true }));
});
