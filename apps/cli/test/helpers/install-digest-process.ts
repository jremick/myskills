import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArchitectureTarget } from "@myskills-app/core";
import { readPackageSnapshot } from "@myskills-app/skill-package";
import { runCli, type CliRuntime, type FetchLike, type InstallFaultPoint } from "../../src/cli.js";
import { codexWorkspaceCapabilities, codexWorkspaceDescriptor } from "../../src/codex-workspace.js";

// Invoked in separate processes so Intl uses the requested process locale.
const request = JSON.parse(process.argv[2]!) as { root: string; args?: string[]; fault?: InstallFaultPoint; legacy?: boolean };
const slug = "digest-example";
const releases = ["0.1.0", "0.2.0"].map((version) => {
  const files = [
    { path: "SKILL.md", content: "---\nname: digest-example\ndescription: Inspect the synthetic fixture.\n---\nReturn the fixture text.\n" },
    { path: "skill.json", content: JSON.stringify({ name: slug, title: "Digest example", summary: "Synthetic fixture.", version,
      license: "Apache-2.0", platforms: [{ name: "codex", install_target: "codex-skill" }] }) },
    ...["a", "aa", "ab", "z", "å", "ä", "é"].map((name) => ({ path: `references/${name}.md`, content: `${name}: ${version}` })),
  ];
  const bundle = JSON.stringify({ files });
  return { bundle, release: { slug, version, lifecycleStatus: "approved", publishedAt: "2026-09-25T00:00:00.000Z",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    artifact: { sha256: sha(bundle), byteSize: Buffer.byteLength(bundle), contentType: "application/vnd.myskills-app.package+json" },
    releaseNotes: "Synthetic fixture change.", changeKind: "fix", requiresUserAction: false, compatibility: {} } };
});
const stdout: string[] = [];
const stderr: string[] = [];
let target: ArchitectureTarget = { schemaVersion: 1, id: "digest-target", name: "Digest fixture", owner: { type: "user", id: "user-1" },
  adapter: codexWorkspaceDescriptor, capabilities: codexWorkspaceCapabilities,
  architectureId: "architecture-1", environmentId: "environment-1", profileId: "profile-1", status: "degraded",
  consent: { status: "pending", requestedAt: "2026-09-25T00:00:00.000Z" }, generation: 1, identityDigest: "a".repeat(64) };
const fetch: FetchLike = async (input, init) => {
  const url = new URL(input);
  if (url.pathname === "/v1/capabilities") return response({ instanceId: "00000000-0000-4000-8000-000000000001" });
  if (url.pathname === "/v1/architecture-targets" && init?.method === "POST") {
    target.identityDigest = String(JSON.parse(init.body!).identityDigest);
    return response({ target });
  }
  if (url.pathname === `/v1/architecture-targets/${target.id}`) {
    const binding = JSON.parse(await readFile(path.join(request.root, ".myskills-app", "codex-workspace.json"), "utf8"));
    return response({ target: binding.target });
  }
  if (url.pathname.endsWith("/consent")) {
    target = { ...target, consent: { ...target.consent, status: "granted", grantedAt: "2026-09-25T00:00:00.000Z" } };
    return response({ target });
  }
  if (url.pathname === `/v1/skills/${slug}/releases`) return response({ releases: releases.map((entry) => entry.release) });
  for (const entry of releases) {
    if (url.pathname === `/v1/skills/${slug}/releases/${entry.release.version}`) return response({ release: entry.release });
    if (url.pathname === `/v1/skills/${slug}/releases/${entry.release.version}/bundle`) return raw(entry.bundle);
  }
  throw new Error(`Unexpected digest fixture request: ${url.pathname}`);
};
const runtime: CliRuntime = { env: { MYSKILLS_TOKEN: "synthetic-digest-fixture-token" }, fetch,
  io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
  installFault: (point) => { if (point === request.fault) throw new Error(`Interrupted at ${point}`); } };

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function raw(value: string) { return { ok: true, status: 200, text: async () => value }; }
function response(value: unknown) { return raw(JSON.stringify(value)); }

// Recreate pre-versioning records from actual fixture bytes with the original
// digest formula. This is test setup, not a production migration fallback.
interface LegacyRecord { path?: string; snapshotPath?: string; contentDigest: string; contentDigestAlgorithm?: string; history?: LegacyRecord[] }
async function legacyRecord(record: LegacyRecord, directory: string): Promise<void> {
  record.contentDigest = await legacyDigest(directory);
  delete record.contentDigestAlgorithm;
  for (const entry of record.history ?? []) await legacyRecord(entry, entry.snapshotPath!);
}
async function legacyDigest(directory: string): Promise<string> {
  const files = (await readPackageSnapshot(directory)).files
    .map(({ path: filePath, content }) => ({ path: filePath, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha(JSON.stringify(files));
}
async function exists(directory: string): Promise<boolean> { return access(directory).then(() => true, () => false); }
async function writeLegacyFixtures(): Promise<void> {
  const stateRoot = path.join(request.root, ".myskills-app");
  const registryPath = path.join(stateRoot, "installed.json");
  const registry = await exists(registryPath) ? JSON.parse(await readFile(registryPath, "utf8")) : null;
  const transactions = path.join(stateRoot, "transactions");
  const journalNames = await exists(transactions) ? await readdir(transactions) : [];
  for (const name of journalNames) {
    const journalPath = path.join(transactions, name);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const output = path.join(request.root, journal.slug);
    const stage = path.join(stateRoot, "staging", journal.id);
    const previousPath = journal.previous && path.join(stateRoot, "history", journal.slug, `${journal.id}-${journal.previous.version}`);
    journal.targetContentDigest = await legacyDigest(await exists(stage) ? stage : output);
    delete journal.targetContentDigestAlgorithm;
    if (journal.previous) await legacyRecord(journal.previous, await exists(previousPath) ? previousPath : output);
    const installed = registry?.installations[journal.slug];
    if (installed) await legacyRecord(installed, installed.version === journal.targetVersion ? output : await exists(previousPath) ? previousPath : output);
    await writeFile(journalPath, JSON.stringify(journal));
  }
  if (registry) {
    if (journalNames.length === 0) for (const installed of Object.values(registry.installations) as LegacyRecord[]) await legacyRecord(installed, installed.path!);
    await writeFile(registryPath, JSON.stringify(registry));
  }
}

const code = request.legacy ? (await writeLegacyFixtures(), 0)
  : await runCli([...request.args!, "--api-url", "http://api.test"], runtime);
process.stdout.write(JSON.stringify({ code, stdout, stderr, locale: Intl.DateTimeFormat().resolvedOptions().locale }));
