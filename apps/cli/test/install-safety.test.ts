import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { targetSkillOperationPlanDigest, type ArchitectureTarget, type SkillReleaseMetadata, type TargetSkillOperation } from "@myskills-app/core";
import { runCli, type CliRuntime, type FetchLike } from "../src/cli.js";
import { codexWorkspaceCapabilities, codexWorkspaceDescriptor } from "../src/codex-workspace.js";

const slug = "safe-example";
const firstInstance = "00000000-0000-4000-8000-000000000001";
const secondInstance = "00000000-0000-4000-8000-000000000002";
const frontmatter = "---\nname: safe-example\ndescription: Use the supplied synthetic fixture.\n---\nReturn the supplied fixture text.\n";

class RegistryFixture {
  instanceId: string | undefined = firstInstance;
  releases = new Map<string, { bundle: string; metadata: SkillReleaseMetadata }>();
  calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  observations: Record<string, unknown>[] = [];
  operation?: TargetSkillOperation;
  renewalCount = 0;
  denyRenewalAt?: number;
  target: ArchitectureTarget = {
    schemaVersion: 1, id: "workspace-1", name: "Synthetic workspace", owner: { type: "user", id: "user-1" },
    adapter: codexWorkspaceDescriptor, capabilities: codexWorkspaceCapabilities,
    architectureId: "architecture-1", environmentId: "environment-1", profileId: "profile-1",
    status: "degraded", consent: { status: "pending", requestedAt: "2026-09-05T00:00:00.000Z" },
    generation: 1, identityDigest: "a".repeat(64),
  };

  add(version: string, metadata: Partial<SkillReleaseMetadata> = {}, skillText = frontmatter): void {
    const manifest = {
      name: slug, title: "Safe example", summary: "A synthetic test skill.", version, license: "Apache-2.0",
      platforms: [{ name: "codex", install_target: "codex-skill" }],
    };
    const bundle = JSON.stringify({ files: [
      { path: "README.md", content: version }, { path: "SKILL.md", content: skillText },
      { path: "skill.json", content: JSON.stringify(manifest) },
    ] });
    this.releases.set(version, { bundle, metadata: { releaseNotes: "Synthetic change", changeKind: "fix", requiresUserAction: false, compatibility: {}, ...metadata } });
  }

  release(version: string) {
    const value = this.releases.get(version)!;
    return {
      slug, version, lifecycleStatus: "approved", publishedAt: "2026-09-05T00:00:00.000Z",
      platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
      artifact: { sha256: sha(value.bundle), byteSize: Buffer.byteLength(value.bundle), contentType: "application/vnd.myskills-app.package+json" },
      ...value.metadata,
    };
  }

  plan(action: "install" | "update" | "rollback", toVersion: string, fromVersion?: string): void {
    const plan = { targetId: this.target.id, targetGeneration: this.target.generation, action, skillSlug: slug,
      toVersion, ...(fromVersion ? { fromVersion } : {}), platform: "codex", artifact: this.release(toVersion).artifact };
    this.operation = { schemaVersion: 1, id: "operation-1", ...plan, planDigest: targetSkillOperationPlanDigest(plan),
      state: "claimed", fencingToken: 1, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z" };
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    this.calls.push({ path: url.pathname, body });
    if (url.pathname === "/v1/capabilities") return response({ instanceId: this.instanceId });
    if (url.pathname === "/v1/architecture-targets" && init?.method === "POST") {
      this.target.identityDigest = String(body.identityDigest);
      return response({ target: this.target });
    }
    if (url.pathname === `/v1/architecture-targets/${this.target.id}`) return response({ target: this.target });
    if (url.pathname.endsWith("/consent")) {
      this.target.consent = { ...this.target.consent, status: "granted", grantedAt: "2026-09-05T00:00:00.000Z" };
      return response({ target: this.target });
    }
    if (url.pathname.endsWith("/observations")) { this.observations.push(body); return response({ observation: body }); }
    if (url.pathname.endsWith("/health")) { this.target.status = body.status === "healthy" ? "connected" : "degraded"; return response({ target: this.target }); }
    if (url.pathname === "/v1/target-operations/claim") return response({ claim: this.operation ? { operation: this.operation, claimToken: "synthetic-claim-token-with-at-least-32-characters" } : null });
    if (url.pathname.endsWith("/state")) {
      this.renewalCount += 1;
      if (this.renewalCount === this.denyRenewalAt) return response({ error: { code: "TARGET_OPERATION_CLAIM_CONFLICT", message: "Consent was revoked" } }, 409);
      return response({ operation: { ...this.operation, state: body.state, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() } });
    }
    if (url.pathname.endsWith("/receipt")) return response({ operation: this.operation });
    if (url.pathname === `/v1/skills/${slug}/releases`) return response({ releases: [...this.releases.keys()].map((version) => this.release(version)) });
    const match = url.pathname.match(/\/releases\/([^/]+)(\/bundle)?$/);
    if (match && this.releases.has(match[1]!)) {
      return match[2] ? raw(this.releases.get(match[1]!)!.bundle) : response({ release: this.release(match[1]!) });
    }
    throw new Error(`Unexpected fixture request: ${url.pathname}`);
  };
}

function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function raw(value: string) { return { ok: true, status: 200, text: async () => value }; }
function response(value: unknown, status = 200) { return { ...raw(JSON.stringify(value)), ok: status < 400, status }; }
async function temp(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-install-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function runtime(api: RegistryFixture) {
  const output = { stdout: [] as string[], stderr: [] as string[] };
  const context: CliRuntime = { env: { MYSKILLS_TOKEN: "synthetic-test-token" }, fetch: api.fetch,
    io: { stdout: (value) => output.stdout.push(value), stderr: (value) => output.stderr.push(value) } };
  return { context, output };
}
async function invoke(api: RegistryFixture, args: string[], context?: CliRuntime) {
  const fixture = runtime(api);
  const code = await runCli([...args, "--api-url", "http://api.test"], context ?? fixture.context);
  return { code, ...fixture.output };
}
function installArgs(root: string, version: string): string[] { return ["install", slug, "--dir", root, "--version", version]; }
async function installed(root: string) {
  return JSON.parse(await readFile(path.join(root, ".myskills-app", "installed.json"), "utf8")).installations[slug] as {
    version: string; path: string; contentDigest: string; provenance?: unknown; history: Array<{ snapshotPath: string }>;
  };
}
async function enroll(api: RegistryFixture, workspace: string): Promise<void> {
  const result = await invoke(api, ["codex", "enroll", "--workspace", workspace, "--architecture-id", "architecture-1", "--environment-id", "environment-1", "--profile-id", "profile-1"]);
  assert.equal(result.code, 0, result.stderr.join("\n"));
}

test("install cannot bypass update compatibility, user action, downgrade, or drift guards", async (t) => {
  const root = await temp(t);
  const api = new RegistryFixture();
  api.add("0.1.0");
  api.add("0.2.0", { requiresUserAction: true });
  assert.equal((await invoke(api, installArgs(root, "0.1.0"))).code, 0);
  const rejected = await invoke(api, installArgs(root, "0.2.0"));
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.join("\n"), /user action/);
  assert.equal((await installed(root)).version, "0.1.0");
  api.add("0.3.0");
  const intervening = await invoke(api, installArgs(root, "0.3.0"));
  assert.equal(intervening.code, 1);
  assert.match(intervening.stderr.join("\n"), /intervening release/);
  assert.equal((await invoke(api, [...installArgs(root, "0.2.0"), "--accept-user-action"])).code, 0);
  assert.equal((await invoke(api, installArgs(root, "0.1.0"))).code, 1);
  await writeFile(path.join(root, slug, "README.md"), "local work");
  const drift = await invoke(api, installArgs(root, "0.3.0"));
  assert.equal(drift.code, 1);
  assert.match(drift.stderr.join("\n"), /local drift/);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "local work");
  const update = await invoke(api, ["update", slug, "--dir", root, "--json"]);
  assert.equal(update.code, 1);
  assert.equal(JSON.parse(update.stdout.join("\n")).updates[0].evaluation.status, "drifted");
});

test("initial install checks compatibility and latest selection skips incompatible versions", async (t) => {
  for (const metadata of [
    { compatibility: { minimumMyskillsVersion: "99.0.0" } },
    { compatibility: { minimumAdapterContractVersion: 3 } },
    { compatibility: { minimumSourceVersion: "0.5.0" } },
  ]) {
    const root = await temp(t);
    const api = new RegistryFixture();
    api.add("0.1.0"); api.add("0.2.0", metadata);
    assert.equal((await invoke(api, installArgs(root, "0.2.0"))).code, 1);
    assert.equal((await invoke(api, ["install", slug, "--dir", root])).code, 0);
    assert.equal((await installed(root)).version, "0.1.0");
  }
  const api = new RegistryFixture(); api.add("0.1.0-beta.1");
  const root = await temp(t);
  assert.equal((await invoke(api, installArgs(root, "0.1.0-beta.1"))).code, 1);
  assert.equal((await invoke(api, [...installArgs(root, "0.1.0-beta.1"), "--include-prerelease"])).code, 0);
});

test("immutable origin and instance provenance refuse switching or adopting legacy installs", async (t) => {
  const root = await temp(t);
  const api = new RegistryFixture(); api.add("0.1.0"); api.add("0.2.0");
  assert.equal((await invoke(api, installArgs(root, "0.1.0"))).code, 0);
  const otherOrigin = runtime(api);
  assert.equal(await runCli([...installArgs(root, "0.2.0"), "--api-url", "http://other.test"], otherOrigin.context), 1);
  assert.match(otherOrigin.output.stderr.join("\n"), /different registry/);
  api.instanceId = secondInstance;
  assert.match((await invoke(api, installArgs(root, "0.2.0"))).stderr.join("\n"), /different registry/);
  api.instanceId = firstInstance;
  const registryPath = path.join(root, ".myskills-app", "installed.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  delete registry.installations[slug].provenance;
  await writeFile(registryPath, JSON.stringify(registry));
  assert.match((await invoke(api, installArgs(root, "0.2.0"))).stderr.join("\n"), /Legacy installation/);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "0.1.0");
});

test("rollback verifies source bytes and retains recovery copies until promoted bytes pass", async (t) => {
  const root = await temp(t);
  const api = new RegistryFixture(); api.add("0.1.0"); api.add("0.2.0");
  assert.equal((await invoke(api, installArgs(root, "0.1.0"))).code, 0);
  assert.equal((await invoke(api, installArgs(root, "0.2.0"))).code, 0);
  const snapshot = (await installed(root)).history[0]!.snapshotPath;
  await writeFile(path.join(snapshot, "README.md"), "tampered snapshot");
  const rejected = await invoke(api, ["rollback", slug, "--dir", root]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr.join("\n"), /snapshot was modified/);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "0.2.0");
  await writeFile(path.join(snapshot, "README.md"), "0.1.0");
  const fault = runtime(api);
  fault.context.installFault = async (point) => {
    if (point === "installed") await writeFile(path.join(root, slug, "README.md"), "tampered promotion");
  };
  assert.equal((await invoke(api, ["rollback", slug, "--dir", root], fault.context)).code, 1);
  assert.equal((await readdir(path.join(root, ".myskills-app", "history", slug))).length, 2);
  assert.equal((await invoke(api, ["list", "--dir", root])).code, 1);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "tampered promotion");
  // Once the operator preserves and repairs the unknown bytes, retrying can
  // recover from the still-retained verified previous installation.
  await writeFile(path.join(root, "preserved-edits.txt"), "tampered promotion");
  await writeFile(path.join(root, slug, "README.md"), "0.1.0");
  assert.equal((await invoke(api, ["list", "--dir", root])).code, 0);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "0.2.0");
  assert.equal(await readFile(path.join(snapshot, "README.md"), "utf8"), "0.1.0");
});

test("all local readers wait for the active install transaction before recovery", async (t) => {
  const root = await temp(t);
  const api = new RegistryFixture(); api.add("0.1.0");
  let ready!: () => void; let release!: () => void;
  const prepared = new Promise<void>((resolve) => { ready = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  const fault = runtime(api);
  fault.context.installFault = async (point) => { if (point === "prepared") { ready(); await resume; } };
  const installing = invoke(api, installArgs(root, "0.1.0"), fault.context);
  await prepared;
  let readerReturned = false;
  const reading = invoke(api, ["list", "--dir", root]).then((result) => { readerReturned = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(readerReturned, false);
  assert.equal((await readdir(path.join(root, ".myskills-app", "transactions"))).length, 1);
  release();
  assert.equal((await installing).code, 0);
  assert.equal((await reading).code, 0);
  assert.equal((await installed(root)).version, "0.1.0");
});

test("recovery can repeat after previous files were restored before metadata commit", async (t) => {
  const root = await temp(t);
  const api = new RegistryFixture(); api.add("0.1.0"); api.add("0.2.0");
  assert.equal((await invoke(api, installArgs(root, "0.1.0"))).code, 0);
  const fault = runtime(api);
  fault.context.installFault = (point) => { if (point === "installed") throw new Error("interrupted"); };
  assert.equal((await invoke(api, installArgs(root, "0.2.0"), fault.context)).code, 1);
  const journalName = (await readdir(path.join(root, ".myskills-app", "transactions")))[0]!;
  const journal = JSON.parse(await readFile(path.join(root, ".myskills-app", "transactions", journalName), "utf8"));
  const snapshot = path.join(root, ".myskills-app", "history", slug, `${journal.id}-0.1.0`);
  await rm(path.join(root, slug), { recursive: true });
  await rename(snapshot, path.join(root, slug));
  assert.equal((await invoke(api, ["list", "--dir", root])).code, 0);
  assert.equal((await installed(root)).version, "0.1.0");
  assert.deepEqual(await readdir(path.join(root, ".myskills-app", "transactions")), []);
});

test("recovery preserves unrelated files created after an interrupted initial install", async (t) => {
  const root = await temp(t); const api = new RegistryFixture(); api.add("0.1.0");
  const fault = runtime(api);
  fault.context.installFault = (point) => { if (point === "prepared") throw new Error("interrupted"); };
  assert.equal((await invoke(api, installArgs(root, "0.1.0"), fault.context)).code, 1);
  await mkdir(path.join(root, slug));
  await writeFile(path.join(root, slug, "user-created.txt"), "preserve this work");
  const recovery = await invoke(api, ["list", "--dir", root]);
  assert.equal(recovery.code, 1);
  assert.match(recovery.stderr.join("\n"), /neither the previous nor staged/);
  assert.equal(await readFile(path.join(root, slug, "user-created.txt"), "utf8"), "preserve this work");
});

test("Codex enrollment uses an explicit workspace and reports owned standard-frontmatter skills without prompt content", async (t) => {
  const workspace = await temp(t);
  const root = path.join(workspace, ".agents", "skills");
  const api = new RegistryFixture(); api.add("0.1.0");
  await enroll(api, workspace);
  assert.equal((await invoke(api, ["install", slug, "--workspace", workspace, "--version", "0.1.0"])).code, 0);
  const result = await invoke(api, ["codex", "observe", "--workspace", workspace, "--upload"]);
  assert.equal(result.code, 0, result.stderr.join("\n"));
  const report = JSON.parse(result.stdout.join("\n"));
  assert.equal(report.runtimeRecognized, false);
  assert.equal(report.observation.skills[0].digest, api.release("0.1.0").artifact.sha256);
  assert.equal(report.observation.skills[0].version, "0.1.0");
  assert.equal(report.observation.skills[0].managed, true);
  assert.equal(JSON.stringify(api.calls).includes(workspace), false);
  assert.equal(JSON.stringify(api.observations).includes("Return the supplied"), false);
  assert.equal(api.target.status, "connected");
  assert.equal((await installed(root)).path, path.join(await realpath(root), slug));
  const bypass = await invoke(api, ["install", slug, "--dir", root, "--version", "0.1.0"]);
  assert.equal(bypass.code, 2);
  assert.match(bypass.stderr.join("\n"), /Use --workspace/);
  await writeFile(path.join(root, slug, "README.md"), "edited");
  const drift = await invoke(api, ["codex", "observe", "--workspace", workspace]);
  const observation = JSON.parse(drift.stdout.join("\n")).observation;
  assert.equal(observation.skills.length, 0);
  assert.equal(observation.configFindings[0].code, "managed-skill-drift");
});

test("workspace writes fail closed for wrong ownership, stale target identity, invalid frontmatter, and symlink roots", async (t) => {
  const workspace = await temp(t);
  const api = new RegistryFixture(); api.add("0.1.0", {}, "# Missing frontmatter");
  await enroll(api, workspace);
  const invalid = await invoke(api, ["install", slug, "--workspace", workspace, "--version", "0.1.0"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr.join("\n"), /standard name and description/);
  api.add("0.1.0"); api.target.generation += 1;
  assert.equal((await invoke(api, ["install", slug, "--workspace", workspace, "--version", "0.1.0"])).code, 1);
  const other = await temp(t);
  const duplicateTarget = await invoke(api, ["codex", "enroll", "--workspace", other, "--target-id", "workspace-1"]);
  assert.equal(duplicateTarget.code, 2);
  assert.match(duplicateTarget.stderr.join("\n"), /register its own target/);
  api.target.owner = { type: "team", id: "team-1" };
  const wrongOwner = await invoke(api, ["codex", "enroll", "--workspace", workspace]);
  assert.equal(wrongOwner.code, 1);
  assert.match(wrongOwner.stderr.join("\n"), /personal codex-workspace/);
  const linked = await temp(t); const outside = await temp(t);
  await symlink(outside, path.join(linked, ".agents"));
  assert.equal((await invoke(api, ["list", "--workspace", linked])).code, 1);
  assert.deepEqual(await readdir(outside), []);
});

test("a denied companion renewal immediately before promotion leaves the current version intact", async (t) => {
  const workspace = await temp(t);
  const root = path.join(workspace, ".agents", "skills");
  const api = new RegistryFixture(); api.add("0.1.0"); api.add("0.2.0");
  await enroll(api, workspace);
  assert.equal((await invoke(api, ["install", slug, "--workspace", workspace, "--version", "0.1.0"])).code, 0);
  api.plan("update", "0.2.0", "0.1.0");
  api.denyRenewalAt = 2;
  const result = await invoke(api, ["companion", "run-once", "--workspace", workspace, "--holder", "test-holder"]);
  assert.equal(result.code, 1);
  assert.equal(api.renewalCount, 2);
  assert.equal(await readFile(path.join(root, slug, "README.md"), "utf8"), "0.1.0");
  assert.equal(api.calls.filter((call) => call.path.endsWith("/receipt")).some((call) => (call.body.result as { status: string }).status === "succeeded"), false);
  assert.equal((await invoke(api, ["list", "--workspace", workspace])).code, 0);
  assert.equal((await installed(root)).version, "0.1.0");
});

test("companion refuses a changed source version before staging any package", async (t) => {
  const workspace = await temp(t); const api = new RegistryFixture(); api.add("0.1.0"); api.add("0.2.0");
  await enroll(api, workspace);
  assert.equal((await invoke(api, ["install", slug, "--workspace", workspace, "--version", "0.1.0"])).code, 0);
  api.plan("update", "0.2.0", "0.0.9");
  const result = await invoke(api, ["companion", "run-once", "--workspace", workspace, "--holder", "test-holder"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr.join("\n"), /source version changed/);
  assert.equal((await installed(path.join(workspace, ".agents", "skills"))).version, "0.1.0");
});

test("doctor uses the root lock and cannot overwrite the old fixed test-file destination", async (t) => {
  const root = await temp(t); const api = new RegistryFixture();
  await mkdir(path.join(root, ".myskills-app"));
  const outside = path.join(root, "preserve.txt");
  await writeFile(outside, "preserve");
  await symlink(outside, path.join(root, ".myskills-app", "doctor-write-test"));
  await invoke(api, ["doctor", "--dir", root]);
  assert.equal(await readFile(outside, "utf8"), "preserve");
  assert.deepEqual(await readdir(path.join(root, ".myskills-app")), ["doctor-write-test"]);
});
