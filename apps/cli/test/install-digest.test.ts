import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { InstallFaultPoint } from "../src/cli.js";

const execute = promisify(execFile);
const processFixture = fileURLToPath(new URL("./helpers/install-digest-process.ts", import.meta.url));
const slug = "digest-example";
const algorithm = "sha256-json-ordinal-v1";
const en = "en_US.UTF-8";
const sv = "sv_SE.UTF-8";
const supported = { skip: process.platform !== "darwin" && process.platform !== "linux" ? "Local package filesystems require macOS or Linux." : false };
interface Result { code: number; stdout: string[]; stderr: string[]; locale: string }
interface StoredRecord {
  version: string; contentDigest: string; contentDigestAlgorithm?: unknown; snapshotPath: string; history: StoredRecord[];
}

async function temporary(t: TestContext): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "myskills-digest-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, ".agents", "skills");
  await mkdir(root, { recursive: true });
  return root;
}
async function processRun(root: string, locale: string, options: { args?: string[]; fault?: InstallFaultPoint; legacy?: boolean }): Promise<Result> {
  const result = await execute(process.execPath, ["--import", "tsx", processFixture, JSON.stringify({ root, ...options })], {
    env: { ...process.env, LANG: locale, LC_ALL: locale, LANGUAGE: locale }, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout) as Result;
  assert.equal(parsed.locale, locale === en ? "en-US" : "sv-SE", "the child must use the requested locale");
  return parsed;
}
async function invoke(root: string, locale: string, args: string[], fault?: InstallFaultPoint): Promise<Result> {
  const enrolled = await access(path.join(root, ".myskills-app", "codex-workspace.json")).then(() => true, () => false);
  const flags = args.includes("--workspace") ? [] : enrolled ? ["--workspace", path.resolve(root, "../..")] : ["--dir", root];
  return processRun(root, locale, { args: [...args, ...flags], fault });
}
function successful(result: Result): Result { assert.equal(result.code, 0, result.stderr.join("\n")); return result; }
async function install(root: string, locale: string, version: string, fault?: InstallFaultPoint): Promise<Result> {
  return invoke(root, locale, ["install", slug, "--version", version], fault);
}
function registryPath(root: string): string { return path.join(root, ".myskills-app", "installed.json"); }
async function registry(root: string): Promise<{ version: number; installations: Record<string, StoredRecord> }> {
  return JSON.parse(await readFile(registryPath(root), "utf8"));
}
async function installed(root: string): Promise<StoredRecord> { return (await registry(root)).installations[slug]!; }
async function journalPath(root: string): Promise<string> {
  const directory = path.join(root, ".myskills-app", "transactions");
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  return path.join(directory, names[0]!);
}
async function legacy(root: string, locale: string): Promise<void> { successful(await processRun(root, locale, { legacy: true })); }
function payload(root: string): string { return path.join(root, slug, "references", "ä.md"); }
async function observe(root: string, locale: string): Promise<{ skills: unknown[]; configFindings: Array<{ code: string }> }> {
  const result = successful(await invoke(root, locale, ["codex", "observe", "--workspace", path.resolve(root, "../..")]));
  return JSON.parse(result.stdout.join("\n")).observation;
}
async function enroll(root: string, locale: string): Promise<void> {
  successful(await invoke(root, locale, ["codex", "enroll", "--workspace", path.resolve(root, "../.."),
    "--architecture-id", "architecture-1", "--environment-id", "environment-1", "--profile-id", "profile-1"]));
}

test("ordinal installation, update, rollback, and observation work across process locales", supported, async (t) => {
  const root = await temporary(t);
  const other = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  successful(await install(other, sv, "0.1.0"));
  const first = await installed(root);
  assert.equal(first.contentDigestAlgorithm, algorithm);
  assert.equal(first.contentDigest, (await installed(other)).contentDigest);
  const updates = successful(await invoke(root, sv, ["updates", slug, "--json"]));
  assert.equal(JSON.parse(updates.stdout.join("\n")).updates[0].evaluation.status, "update-available");
  successful(await invoke(root, sv, ["update", slug, "--version", "0.2.0"]));
  const updated = await installed(root);
  assert.equal(updated.contentDigestAlgorithm, algorithm);
  assert.equal(updated.history[0]!.contentDigestAlgorithm, algorithm);
  assert.equal(updated.history[0]!.contentDigest, first.contentDigest);
  successful(await invoke(root, en, ["rollback", slug]));
  assert.equal((await installed(root)).contentDigest, first.contentDigest);
  await enroll(root, en);
  const observation = await observe(root, sv);
  assert.equal(observation.skills.length, 1);
  assert.deepEqual(observation.configFindings, []);

  await writeFile(payload(root), "tampered active bytes");
  const drift = successful(await invoke(root, sv, ["updates", slug, "--json"]));
  assert.equal(JSON.parse(drift.stdout.join("\n")).updates[0].evaluation.status, "drifted");
  assert.deepEqual((await observe(root, en)).configFindings.map((finding) => finding.code), ["managed-skill-drift"]);
  assert.equal((await install(root, sv, "0.2.0")).code, 1);
  assert.equal(await readFile(payload(root), "utf8"), "tampered active bytes");
});

test("ordinal journals recover across locales at each transaction checkpoint", supported, async (t) => {
  for (const fault of ["prepared", "previous-staged", "installed", "registry-committed"] as const) {
    const root = await temporary(t);
    successful(await install(root, en, "0.1.0"));
    assert.equal((await install(root, en, "0.2.0", fault)).code, 1);
    const journal = JSON.parse(await readFile(await journalPath(root), "utf8"));
    assert.equal(journal.targetContentDigestAlgorithm, algorithm);
    assert.equal(journal.previous.contentDigestAlgorithm, algorithm);
    successful(await invoke(root, sv, ["list", "--json"]));
    const version = fault === "registry-committed" ? "0.2.0" : "0.1.0";
    assert.equal((await installed(root)).version, version);
    assert.equal(await readFile(payload(root), "utf8"), `ä: ${version}`);
    assert.deepEqual(await readdir(path.join(root, ".myskills-app", "transactions")), []);
  }
});

test("cross-locale rollback and recovery still reject tampered bytes", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  successful(await install(root, en, "0.2.0"));
  const snapshot = (await installed(root)).history[0]!.snapshotPath;
  await writeFile(path.join(snapshot, "references", "ä.md"), "tampered snapshot");
  const rollback = await invoke(root, sv, ["rollback", slug]);
  assert.equal(rollback.code, 1);
  assert.match(rollback.stderr.join("\n"), /snapshot was modified/);
  assert.equal(await readFile(payload(root), "utf8"), "ä: 0.2.0");

  const interrupted = await temporary(t);
  successful(await install(interrupted, en, "0.1.0"));
  assert.equal((await install(interrupted, en, "0.2.0", "installed")).code, 1);
  await writeFile(payload(interrupted), "tampered promotion");
  const recovery = await invoke(interrupted, sv, ["list"]);
  assert.equal(recovery.code, 1);
  assert.match(recovery.stderr.join("\n"), /neither the previous nor staged/);
  await journalPath(interrupted);
  assert.equal(await readFile(payload(interrupted), "utf8"), "tampered promotion");
});

test("interrupted ordinal rollback verifies recovery and committed targets across locales", supported, async (t) => {
  for (const fault of ["installed", "registry-committed"] as const) {
    const root = await temporary(t);
    successful(await install(root, en, "0.1.0"));
    successful(await install(root, en, "0.2.0"));
    assert.equal((await invoke(root, sv, ["rollback", slug], fault)).code, 1);
    const journal = JSON.parse(await readFile(await journalPath(root), "utf8"));
    assert.equal(journal.targetContentDigestAlgorithm, algorithm);
    assert.equal(journal.previous.contentDigestAlgorithm, algorithm);
    successful(await invoke(root, en, ["list"]));
    const version = fault === "registry-committed" ? "0.1.0" : "0.2.0";
    assert.equal((await installed(root)).version, version);
    assert.equal(await readFile(payload(root), "utf8"), `ä: ${version}`);
    assert.equal((await installed(root)).history.length, fault === "registry-committed" ? 0 : 1);
    assert.deepEqual(await readdir(path.join(root, ".myskills-app", "transactions")), []);
  }
});

test("legacy installations require their verification locale before trusted migration", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  await legacy(root, en);
  const before = await readFile(registryPath(root), "utf8");
  const first = await installed(root);
  assert.equal(first.contentDigestAlgorithm, undefined);
  await enroll(root, en);
  assert.equal((await observe(root, en)).skills.length, 1);
  assert.equal((await observe(root, sv)).skills.length, 0);
  const drift = successful(await invoke(root, sv, ["updates", slug, "--json"]));
  assert.equal(JSON.parse(drift.stdout.join("\n")).updates[0].evaluation.status, "drifted");
  assert.equal((await install(root, sv, "0.2.0")).code, 1);
  assert.equal(await readFile(registryPath(root), "utf8"), before);
  successful(await install(root, en, "0.2.0"));
  const migrated = await installed(root);
  assert.equal(migrated.contentDigestAlgorithm, algorithm);
  assert.equal(migrated.history[0]!.contentDigestAlgorithm, algorithm);
  assert.notEqual(migrated.history[0]!.contentDigest, first.contentDigest, "migration must rehash verified bytes, not relabel a legacy hash");
  successful(await invoke(root, sv, ["rollback", slug]));
  assert.equal(await readFile(payload(root), "utf8"), "ä: 0.1.0");
});

test("legacy snapshots verify with their recorded scheme before ordinal rollback", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  successful(await install(root, en, "0.2.0"));
  await legacy(root, en);
  // Keep the active record ordinal so the negative control reaches the legacy snapshot.
  const state = await registry(root);
  const ordinalRoot = await temporary(t);
  successful(await install(ordinalRoot, sv, "0.2.0"));
  state.installations[slug]!.contentDigest = (await installed(ordinalRoot)).contentDigest;
  state.installations[slug]!.contentDigestAlgorithm = algorithm;
  await writeFile(registryPath(root), JSON.stringify(state));
  const rejected = await invoke(root, sv, ["rollback", slug]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.join("\n"), /snapshot was modified/);
  assert.equal((await installed(root)).version, "0.2.0");
  successful(await invoke(root, en, ["rollback", slug]));
  assert.equal((await installed(root)).contentDigestAlgorithm, algorithm);
  const updates = successful(await invoke(root, sv, ["updates", slug, "--json"]));
  assert.equal(JSON.parse(updates.stdout.join("\n")).updates[0].evaluation.status, "update-available");
});

test("verified legacy bytes in a new journal recover with ordinal semantics", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  await legacy(root, en);
  assert.equal((await install(root, en, "0.2.0", "installed")).code, 1);
  // The registry is still legacy, while the journal carries verified rehashed bytes.
  assert.equal((await installed(root)).contentDigestAlgorithm, undefined);
  const journal = JSON.parse(await readFile(await journalPath(root), "utf8"));
  assert.equal(journal.previous.contentDigestAlgorithm, algorithm);
  successful(await invoke(root, sv, ["list"]));
  assert.equal((await installed(root)).version, "0.1.0");
  assert.equal((await installed(root)).contentDigestAlgorithm, algorithm);
  assert.equal(await readFile(payload(root), "utf8"), "ä: 0.1.0");
});

test("legacy journals recover only with their original verification semantics", supported, async (t) => {
  for (const fault of ["prepared", "previous-staged", "installed", "registry-committed"] as const) {
    const root = await temporary(t);
    successful(await install(root, en, "0.1.0"));
    assert.equal((await install(root, en, "0.2.0", fault)).code, 1);
    await legacy(root, en);
    const journalFile = await journalPath(root);
    const journal = await readFile(journalFile, "utf8");
    assert.equal(JSON.parse(journal).targetContentDigestAlgorithm, undefined);
    assert.equal((await invoke(root, sv, ["list"])).code, 1);
    assert.equal(await readFile(journalFile, "utf8"), journal);
    successful(await invoke(root, en, ["list"]));
    const expected = fault === "registry-committed" ? "0.2.0" : "0.1.0";
    assert.equal((await installed(root)).version, expected);
    assert.equal((await installed(root)).contentDigestAlgorithm, undefined);
    assert.equal(await readFile(payload(root), "utf8"), `ä: ${expected}`);
  }
});

test("legacy byte tampering cannot be migrated to a trusted ordinal record", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  await legacy(root, en);
  const before = await readFile(registryPath(root), "utf8");
  await writeFile(payload(root), "untrusted local edit");
  const result = await install(root, en, "0.2.0");
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /local drift/);
  assert.equal(await readFile(registryPath(root), "utf8"), before);
  assert.equal(await readFile(payload(root), "utf8"), "untrusted local edit");
});

test("unknown algorithms in installations, snapshots, and journals fail closed", supported, async (t) => {
  const root = await temporary(t);
  successful(await install(root, en, "0.1.0"));
  successful(await install(root, en, "0.2.0"));
  const original = await readFile(registryPath(root), "utf8");
  for (const field of ["installation", "snapshot"] as const) {
    for (const unknown of ["sha256-json-future-v2", null, 1]) {
      const state = JSON.parse(original);
      const record = field === "installation" ? state.installations[slug] : state.installations[slug].history[0];
      record.contentDigestAlgorithm = unknown;
      const changed = JSON.stringify(state);
      await writeFile(registryPath(root), changed);
      const result = await invoke(root, sv, ["list"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr.join("\n"), /Unsupported content digest algorithm/);
      assert.equal(await readFile(registryPath(root), "utf8"), changed);
      assert.equal(await readFile(payload(root), "utf8"), "ä: 0.2.0");
    }
  }
  await writeFile(registryPath(root), original);

  const interrupted = await temporary(t);
  successful(await install(interrupted, en, "0.1.0"));
  assert.equal((await install(interrupted, en, "0.2.0", "installed")).code, 1);
  const file = await journalPath(interrupted);
  const originalJournal = await readFile(file, "utf8");
  for (const field of ["target", "previous"] as const) {
    const journal = JSON.parse(originalJournal);
    if (field === "target") journal.targetContentDigestAlgorithm = "sha256-json-future-v2";
    else journal.previous.contentDigestAlgorithm = "sha256-json-future-v2";
    const changed = JSON.stringify(journal);
    await writeFile(file, changed);
    const result = await invoke(interrupted, sv, ["list"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr.join("\n"), /Unsupported content digest algorithm/);
    assert.equal(await readFile(file, "utf8"), changed);
    assert.equal(await readFile(payload(interrupted), "utf8"), "ä: 0.2.0");
  }
});
