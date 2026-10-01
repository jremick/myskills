import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createFlatArchitecture, type ArchitectureTarget, type ArchitectureTargetObservation } from "@myskills-app/core";
import { buildApp } from "../../api/src/app.js";
import { MemoryArchitectureStore } from "../../api/src/architectures/memory-store.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { ArchitectureTargetBindingAuthorizer } from "../../api/src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../../api/src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../../api/src/targets/service.js";
import { runCli, type FetchLike } from "../src/cli.js";
import { canonicalScopeDirectory, planScopeMigration, readScopeState } from "../src/workspace-scopes.js";

// Written before the workspace-scope implementation. Every step drives the
// real CLI entry point against a real loopback API (memory stores, password
// sessions, TOTP MFA, target service). Fault injection sits only at the CLI
// network boundary. No provider home directory is read: every root is a
// synthetic temporary directory.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const PASSWORD = "correct horse battery staple";
const CANARIES = ["DESC-CANARY", "BODY-CANARY", "LINK-CANARY", "SECRET-CANARY", "LEGACY-CANARY"];
const receipts: Array<{ test: string; step: string; args: string[]; exitCode: number }> = [];

after(async () => {
  const evidencePath = process.env.WORKSPACE_SCOPES_EVIDENCE_PATH;
  if (!evidencePath) return;
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({ schema: "myskills.workspace-scopes-journey.v1", receipts }, null, 2)}\n`);
});

interface ApiFixture {
  url: string;
  instanceId: string;
  app: ReturnType<typeof buildApp>;
  architecture: { architectureId: string; environmentId: string; profileId: string };
  session: string;
  plainSession: string;
  otherSession: string;
}

interface Journey {
  name: string;
  base: string;
  aliases: string[];
  configDir: string;
  api: ApiFixture;
  requests: Array<{ origin: string; method: string; path: string; body: string }>;
  faults: Array<{ method: string; path: RegExp; when: "before-send" | "after-send" | "malformed-response" | "hook"; run?: () => Promise<void>; response?: Json }>;
  observationSlugCapability?: boolean | "absent" | "invalid";
  /** Ordered request starts plus markers pushed by concurrent steps. */
  timeline: string[];
}

async function startApi(t: TestContext, instanceId: string): Promise<ApiFixture> {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore({});
  const targetStore = new MemoryArchitectureTargetStore({ teamMemberships: [], organizationMemberships: [] });
  const targetService = new ArchitectureTargetService(targetStore, new ArchitectureTargetBindingAuthorizer(architectureStore));
  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: new AuthService(authStore),
    architectureStore,
    architectureTargetService: targetService,
    registryInstanceId: instanceId,
  });
  const userId = `scope-user-${instanceId.slice(0, 8)}`;
  const otherId = `scope-other-${instanceId.slice(0, 8)}`;
  const plainSession = await addUserAndLogin(app, authStore, userId, `${userId}@example.com`);
  const session = await verifyMfa(app, plainSession, `${userId}@example.com`);
  const otherSession = await verifyMfa(app, await addUserAndLogin(app, authStore, otherId, `${otherId}@example.com`), `${otherId}@example.com`);
  const created = await architectureStore.createArchitecture({ actor: userId, owner: { type: "user", id: userId }, name: "Scope fixture", description: "", patternId: "flat" });
  const environmentId = `environment-${created.id}`;
  const profileId = `profile-${created.id}`;
  const revision = await architectureStore.createRevision({
    actor: userId,
    architectureId: created.id,
    expectedCurrentRevisionId: null,
    message: "scope fixture",
    spec: createFlatArchitecture({
      id: created.id,
      name: created.name,
      profile: { id: profileId, subject: { type: "user", id: userId } },
      environment: { id: environmentId, kind: "personal" },
      skills: [{ id: "scope-fixture-skill", slug: "scope-fixture-skill", title: "Scope fixture skill", version: "1.0.0", digest: "a".repeat(64), packageVisibility: "authenticated" }],
    }),
  });
  assert.ok(revision);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    instanceId,
    app,
    architecture: { architectureId: created.id, environmentId, profileId },
    session,
    plainSession,
    otherSession,
  };
}

async function addUserAndLogin(app: ReturnType<typeof buildApp>, store: MemoryAuthStore, id: string, email: string): Promise<string> {
  store.addUser({ id, email, name: id, status: "active", emailVerifiedAt: new Date(), roles: ["user"], passwordHash: await hashPassword(PASSWORD) });
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}

async function verifyMfa(app: ReturnType<typeof buildApp>, session: string, email: string): Promise<string> {
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${session}` }, payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${session}` },
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
  const verification = await app.inject({
    method: "POST", url: "/v1/auth/mfa/verify",
    payload: { challengeToken: login.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] },
  });
  assert.equal(verification.statusCode, 200, verification.body);
  return verification.json().token as string;
}

async function journey(t: TestContext, name: string): Promise<Journey> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "myskills-scopes-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const configDir = path.join(base, "config");
  return { name, base, aliases: [temporary, base, path.basename(base)], configDir, api: await startApi(t, randomUUID()), requests: [], faults: [], timeline: [] };
}

async function cli(j: Journey, step: string, args: string[], options: { token?: string } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const record = { origin: url.origin, method: init?.method ?? "GET", path: url.pathname, body: init?.body ?? "" };
    j.requests.push(record);
    const index = j.faults.findIndex((fault) => fault.method === record.method && fault.path.test(record.path));
    const fault = index >= 0 ? j.faults.splice(index, 1)[0] : undefined;
    if (fault?.when === "before-send") throw new Error("synthetic network interruption before send");
    if (fault?.when === "malformed-response") {
      return new Response(JSON.stringify(fault.response ?? { targets: { unexpected: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (fault?.when === "hook") await fault.run?.();
    j.timeline.push(`${record.method} ${record.path}`);
    const response = await fetch(input, init as RequestInit);
    if (record.path === "/v1/capabilities" && j.observationSlugCapability !== undefined) {
      const body = await response.json() as Json;
      if (j.observationSlugCapability === "absent") delete body.capabilities.architectureObservationSlugValidation;
      else body.capabilities.architectureObservationSlugValidation = j.observationSlugCapability === "invalid" ? "true" : j.observationSlugCapability;
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    }
    if (fault?.when === "after-send") {
      await response.text();
      throw new Error("synthetic interruption after the server committed");
    }
    return response;
  };
  const code = await runCli([...args, "--json"], {
    workspaceEnrollmentStateDirectory: path.join(j.configDir, "enrollment-state"),
    env: { MYSKILLS_TOKEN: options.token ?? j.api.session, MYSKILLS_API_URL: j.api.url, MYSKILLS_CONFIG_DIR: j.configDir },
    fetch: fetchImpl,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  });
  receipts.push({ test: j.name, step, args: args.map((value, index) => args[index - 1] === "--token" ? "<token>" : redact(j, value)), exitCode: code });
  const out = stdout.join("\n");
  const err = stderr.join("\n");
  return {
    code,
    out,
    err,
    json: () => JSON.parse(out) as Json,
    errorCode: () => (JSON.parse(err) as { error: { code: string } }).error.code,
  };
}

function redact(j: Journey, value: string): string {
  let result = value.replaceAll(j.api.url, "<api>");
  for (const alias of [...j.aliases].sort((left, right) => right.length - left.length)) result = result.replaceAll(alias, "<tmp>");
  return result.replace(/http:\/\/127\.0\.0\.1:\d+/g, "<api-other>");
}

async function ok(j: Journey, step: string, args: string[], options: { token?: string } = {}) {
  const result = await cli(j, step, args, options);
  assert.equal(result.code, 0, `${step}: ${result.err}`);
  return result.json();
}

async function fails(j: Journey, step: string, args: string[], code: string, options: { token?: string } = {}) {
  const result = await cli(j, step, args, options);
  assert.notEqual(result.code, 0, `${step} unexpectedly succeeded: ${result.out}`);
  assert.equal(result.errorCode(), code, `${step}: ${result.err}`);
  return result;
}

async function serverTargets(j: Journey, session = j.api.session): Promise<ArchitectureTarget[]> {
  const response = await j.api.app.inject({ method: "GET", url: "/v1/architecture-targets", headers: { authorization: `Bearer ${session}` } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().targets as ArchitectureTarget[];
}

async function serverObservations(j: Journey, targetId: string): Promise<ArchitectureTargetObservation[]> {
  const response = await j.api.app.inject({ method: "GET", url: `/v1/architecture-targets/${targetId}/observations`, headers: { authorization: `Bearer ${j.api.session}` } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().observations as ArchitectureTargetObservation[];
}

function assertPayloadsPrivate(j: Journey, forbidden: string[]): void {
  for (const request of j.requests) {
    for (const value of [...j.aliases, ...CANARIES, ...forbidden]) {
      assert.equal(request.body.includes(value), false, `${request.method} ${request.path} leaked ${value.startsWith("/") ? "a local path" : value}`);
    }
  }
}

async function writeSkill(directory: string, name: string, marker = name): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: DESC-CANARY guidance for ${marker}.\n---\nBODY-CANARY instructions for ${marker}.\n`);
  await mkdir(path.join(directory, "references"), { recursive: true });
  await writeFile(path.join(directory, "references", "guide.md"), `BODY-CANARY reference for ${marker}\n`);
}

/** Build a synthetic provider root that mixes every entry class. */
async function codexGlobalFixture(base: string): Promise<string> {
  const root = path.join(base, "home", ".codex", "skills");
  await writeSkill(path.join(root, "alpha-helper"), "alpha-helper");
  await writeSkill(path.join(root, "beta-review"), "beta-review");
  await writeSkill(path.join(root, "release-config-helper"), "release-config-helper");
  await writeSkill(path.join(base, "outside", "linked-target"), "linked-skill", "LINK-CANARY");
  await symlink(path.join(base, "outside", "linked-target"), path.join(root, "linked-skill"));
  await writeSkill(path.join(root, "Bad_Name"), "bad-name");
  await mkdir(path.join(root, "no-definition"), { recursive: true });
  await writeFile(path.join(root, "no-definition", "notes.md"), "BODY-CANARY notes\n");
  await writeSkill(path.join(root, "mismatch-name"), "other-name");
  await mkdir(path.join(root, "symlinked-definition"), { recursive: true });
  await writeFile(path.join(base, "outside", "definition.md"), "---\nname: symlinked-definition\ndescription: LINK-CANARY\n---\nLINK-CANARY\n");
  await symlink(path.join(base, "outside", "definition.md"), path.join(root, "symlinked-definition", "SKILL.md"));
  await writeSkill(path.join(root, ".system", "bundled-skill"), "bundled-skill");
  await mkdir(path.join(root, ".myskills-app"), { recursive: true });
  await writeFile(path.join(root, ".myskills-app", "installed.json"), JSON.stringify({ version: 1, installations: { "legacy-installed": { slug: "legacy-installed", note: "LEGACY-CANARY" } } }));
  await writeFile(path.join(root, "README.md"), "BODY-CANARY readme\n");
  await writeFile(path.join(root, "credentials.json"), "{\"token\":\"SECRET-CANARY\"}\n");
  return root;
}

async function claudeGlobalFixture(base: string): Promise<string> {
  const root = path.join(base, "home", ".claude", "skills");
  await writeSkill(path.join(root, "alpha-helper"), "alpha-helper", "claude-alpha");
  await writeSkill(path.join(root, "gamma-writer"), "gamma-writer");
  await writeSkill(path.join(base, "outside", "claude-linked"), "linked-claude", "LINK-CANARY");
  await symlink(path.join(base, "outside", "claude-linked"), path.join(root, "linked-claude"));
  return root;
}

/** Hash names, bytes, modes, and link targets without following links. */
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relative: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const absolute = path.join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        const info = await lstat(absolute);
        hash.update(`${child}\0${info.mode}\0`);
        if (entry.isSymbolicLink()) hash.update(`link:${await readlink(absolute)}\0`);
        else await visit(absolute, child);
      } else {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await handle.stat();
          assert.ok(info.isFile(), "tree digest requires a regular file");
          hash.update(`${child}\0${info.mode}\0`);
          hash.update(await handle.readFile());
        } finally { await handle.close(); }
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

function enrollArgs(j: Journey, provider: string, scope: string, location: string, overrides: Record<string, string> = {}): string[] {
  const ids = { ...j.api.architecture, ...overrides };
  return ["scopes", "enroll", "--provider", provider, "--scope", scope, scope === "global" ? "--root" : "--project", location,
    "--architecture-id", ids.architectureId, "--environment-id", ids.environmentId, "--profile-id", ids.profileId];
}

function count(observation: ArchitectureTargetObservation, code: string): number {
  return observation.configFindings.find((finding) => finding.code === code)?.count ?? 0;
}

test("global Codex and Claude inventories enroll as separate private read-only targets and recover from interruption", async (t) => {
  const j = await journey(t, "global-enrollment");
  const codexRoot = await codexGlobalFixture(j.base);
  const claudeRoot = await claudeGlobalFixture(j.base);
  const before = { codex: await treeDigest(codexRoot), claude: await treeDigest(claudeRoot), outside: await treeDigest(path.join(j.base, "outside")) };

  // A local preview classifies every entry and makes no network call.
  const preview = await ok(j, "inventory preview (local only)", ["scopes", "inventory", "--provider", "codex", "--root", codexRoot]);
  assert.equal(j.requests.length, 0);
  assert.deepEqual(preview.skills.map((skill: { slug: string }) => skill.slug), ["alpha-helper", "beta-review", "release-config-helper"]);
  assert.deepEqual(preview.withheld, []);
  assert.deepEqual(preview.linked, ["linked-skill"]);
  assert.deepEqual(preview.invalid, [
    { name: "Bad_Name", reason: "invalid-name" },
    { name: "mismatch-name", reason: "definition-invalid" },
    { name: "no-definition", reason: "definition-missing" },
    { name: "symlinked-definition", reason: "definition-invalid" },
  ]);
  assert.deepEqual(preview.skipped, [
    { name: ".myskills-app", reason: "managed-install-state" },
    { name: ".system", reason: "hidden" },
    { name: "README.md", reason: "not-a-directory" },
    { name: "credentials.json", reason: "not-a-directory" },
  ]);
  assert.equal(preview.inventoryComplete, false);
  assert.equal(preview.runtimeRecognized, false);
  for (const canary of CANARIES) assert.equal(JSON.stringify(preview).includes(canary), false, canary);

  // Unsafe roots are rejected before any registry contact.
  await symlink(codexRoot, path.join(j.base, "codex-root-link"));
  await fails(j, "reject symlinked global root", enrollArgs(j, "codex", "global", path.join(j.base, "codex-root-link")), "SCOPE_ROOT_INVALID");
  await fails(j, "reject home as global root", enrollArgs(j, "claude", "global", os.homedir()), "SCOPE_ROOT_INVALID");
  await fails(j, "reject filesystem root", enrollArgs(j, "claude", "global", "/"), "SCOPE_ROOT_INVALID");
  assert.equal(j.requests.length, 0);

  // Registration commits on the server but the client dies before reading
  // the response. The retry must find that target, not create a second one.
  j.faults.push({ method: "POST", path: /^\/v1\/architecture-targets$/, when: "after-send" });
  assert.notEqual((await cli(j, "codex enroll interrupted after server commit", enrollArgs(j, "codex", "global", codexRoot))).code, 0);
  assert.equal((await serverTargets(j)).length, 1);
  // Another account on the same registry sees an empty list. It must not
  // resume this pending intent, or it would register a second target.
  const registrationPosts = () => j.requests.filter((request) => request.method === "POST" && request.path === "/v1/architecture-targets").length;
  await fails(j, "another account cannot resume a pending enrollment", enrollArgs(j, "codex", "global", codexRoot), "SCOPE_ACCOUNT_MISMATCH", { token: j.api.otherSession });
  assert.equal(registrationPosts(), 1, "the other account must not attempt a second registration");
  assert.equal((await serverTargets(j, j.api.otherSession)).length, 0);
  assert.equal((await serverTargets(j)).length, 1);
  // A malformed target list is not "no target": reading it as empty would
  // re-register and duplicate the committed target.
  j.faults.push({ method: "GET", path: /^\/v1\/architecture-targets$/, when: "malformed-response" });
  await fails(j, "malformed target list fails closed", enrollArgs(j, "codex", "global", codexRoot), "SCOPE_TARGET_LIST_INVALID");
  assert.equal((await serverTargets(j)).length, 1);
  j.faults.push({ method: "POST", path: /\/consent$/, when: "before-send" });
  assert.notEqual((await cli(j, "codex enroll interrupted before consent", enrollArgs(j, "codex", "global", codexRoot))).code, 0);
  const pending = await ok(j, "list shows registered binding awaiting consent", ["scopes", "list", "--provider", "codex"]);
  assert.equal(pending.providers.codex.global.status, "registered");
  const codexEnrolled = await ok(j, "codex enroll resumes", enrollArgs(j, "codex", "global", codexRoot));
  assert.equal(codexEnrolled.enrolled, true);
  assert.equal(codexEnrolled.resumed, true);
  assert.equal(codexEnrolled.inventoryOnly, true);
  assert.equal(codexEnrolled.nativeInheritance, "unchanged");
  const repeated = await ok(j, "codex enroll repeat is a no-op", enrollArgs(j, "codex", "global", codexRoot));
  assert.equal(repeated.targetId, codexEnrolled.targetId);
  assert.equal(j.requests.filter((request) => request.method === "POST" && request.path === "/v1/architecture-targets").length, 1);
  await fails(j, "changed binding IDs are not silently rebound", enrollArgs(j, "codex", "global", codexRoot, { profileId: "another-profile" }), "SCOPE_BINDING_CONFLICT");

  // A password session without MFA cannot register. The pending intent is kept
  // and the later MFA session resumes it without leaving an orphan.
  await fails(j, "claude enroll without MFA", enrollArgs(j, "claude", "global", claudeRoot), "MFA_VERIFICATION_REQUIRED", { token: j.api.plainSession });
  const claudeEnrolled = await ok(j, "claude enroll with MFA", enrollArgs(j, "claude", "global", claudeRoot));
  const targets = await serverTargets(j);
  assert.equal(targets.length, 2);
  const codexTarget = targets.find((target) => target.id === codexEnrolled.targetId)!;
  const claudeTarget = targets.find((target) => target.id === claudeEnrolled.targetId)!;
  for (const [target, kind] of [[codexTarget, "codex-inventory"], [claudeTarget, "claude-inventory"]] as const) {
    assert.equal(target.adapter.kind, kind);
    assert.equal(target.adapter.contractVersion, 1);
    assert.deepEqual([target.capabilities.apply, target.capabilities.rollback, target.capabilities["sync.write"]], [false, false, false]);
    assert.equal(target.owner.type, "user");
    assert.equal(target.consent.status, "granted");
  }

  const codexObserved = await ok(j, "codex observe upload", ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload"]);
  assert.equal(codexObserved.uploaded, true);
  assert.equal(codexObserved.runtimeRecognized, false);
  assert.equal(codexObserved.inventoryComplete, false);
  assert.deepEqual(codexObserved.local.withheld, []);
  const [codexObservation] = await serverObservations(j, codexTarget.id);
  assert.deepEqual(codexObservation!.skills.map((skill) => skill.slug).sort(), ["alpha-helper", "beta-review", "release-config-helper"]);
  assert.equal(codexObservation!.skills.every((skill) => skill.managed === false), true);
  assert.deepEqual(codexObservation!.metadata, { inventoryComplete: false, provider: "codex", runtimeRecognized: false, scope: "global" });
  assert.deepEqual(
    ["skill-linked", "skill-name-invalid", "skill-definition-missing", "skill-definition-invalid", "skill-name-withheld", "skill-hidden-skipped", "managed-install-state-ignored", "skill-entry-skipped"].map((code) => count(codexObservation!, code)),
    [1, 1, 1, 2, 0, 1, 1, 2],
  );
  const claudeObserved = await ok(j, "claude observe upload", ["scopes", "observe", "--provider", "claude", "--scope", "global", "--upload"]);
  const [claudeObservation] = await serverObservations(j, claudeTarget.id);
  assert.deepEqual(claudeObservation!.skills.map((skill) => skill.slug), ["alpha-helper", "gamma-writer"]);
  assert.equal(claudeObservation!.metadata?.provider, "claude");
  // An unfollowed link may hide a skill, so the inventory cannot claim completeness.
  assert.equal(claudeObserved.inventoryComplete, false);
  assert.equal(claudeObservation!.metadata?.inventoryComplete, false);
  assert.equal(count(claudeObservation!, "skill-linked"), 1);
  assert.notEqual(claudeObservation!.skills[0]!.metadata?.definitionDigest, codexObservation!.skills[0]!.metadata?.definitionDigest);

  // Cross-provider: a Claude binding that points at the Codex target is refused.
  const stateFile = path.join(j.configDir, "scopes", "workspace-scopes.json");
  const stateBytes = await readFile(stateFile, "utf8");
  const tampered = JSON.parse(stateBytes);
  tampered.providers.claude.global.binding.target = tampered.providers.codex.global.binding.target;
  await writeFile(stateFile, JSON.stringify(tampered));
  await fails(j, "claude scope bound to a codex target", ["scopes", "observe", "--provider", "claude", "--scope", "global", "--upload"], "SCOPE_TARGET_PROVIDER_MISMATCH");
  await writeFile(stateFile, stateBytes);
  assert.equal((await serverObservations(j, codexTarget.id)).length, 1);

  // Cross-registry and cross-user: nothing is written to either registry.
  const other = await startApi(t, randomUUID());
  j.aliases.push(other.url);
  const beforeOther = j.requests.length;
  await fails(j, "binding used against another registry", ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload", "--api-url", other.url], "SCOPE_REGISTRY_MISMATCH");
  assert.deepEqual(j.requests.slice(beforeOther).map((request) => request.path), ["/v1/capabilities"]);
  await fails(j, "another user cannot use this binding", ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload"], "SCOPE_TARGET_UNAVAILABLE", { token: j.api.otherSession });
  assert.equal((await serverObservations(j, codexTarget.id)).length, 1);

  // Revocation fails safe and recovery requires an explicit local unbind.
  const revoked = await j.api.app.inject({ method: "DELETE", url: `/v1/architecture-targets/${claudeTarget.id}`, headers: { authorization: `Bearer ${j.api.session}` } });
  assert.equal(revoked.statusCode, 200, revoked.body);
  await fails(j, "observe revoked target", ["scopes", "observe", "--provider", "claude", "--scope", "global", "--upload"], "SCOPE_TARGET_REVOKED");
  await fails(j, "enroll over revoked target", enrollArgs(j, "claude", "global", claudeRoot), "SCOPE_TARGET_REVOKED");
  const unbound = await ok(j, "unbind revoked claude binding", ["scopes", "unbind", "--provider", "claude", "--scope", "global"]);
  assert.equal(unbound.targetId, claudeTarget.id);
  assert.equal(unbound.serverTargetChanged, false);
  const reEnrolled = await ok(j, "claude re-enroll after unbind", enrollArgs(j, "claude", "global", claudeRoot));
  assert.notEqual(reEnrolled.targetId, claudeTarget.id);
  assert.equal((await serverTargets(j)).filter((target) => target.adapter.kind === "claude-inventory").length, 2);

  // A local unbind that starts during an upload must wait for it. An upload can
  // never publish through a binding that was already removed.
  const observationsBeforeRace = (await serverObservations(j, codexTarget.id)).length;
  const raceStart = j.timeline.length;
  let unbinding: Promise<void> | undefined;
  j.faults.push({
    method: "GET", path: /^\/v1\/capabilities$/, when: "hook",
    run: async () => {
      unbinding = cli(j, "unbind starts during an upload", ["scopes", "unbind", "--provider", "codex", "--scope", "global"])
        .then((result) => { j.timeline.push(`unbind-exit-${result.code}`); });
      await new Promise((resolve) => setTimeout(resolve, 250));
    },
  });
  const raced = await cli(j, "observe upload while an unbind starts", ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload"]);
  await unbinding;
  // Only events from this race count; the earlier upload is not evidence.
  const raceEvents = j.timeline.slice(raceStart);
  const uploadAt = raceEvents.indexOf(`POST /v1/architecture-targets/${codexTarget.id}/observations`);
  const unbindAt = raceEvents.indexOf("unbind-exit-0");
  assert.notEqual(unbindAt, -1, "the unbind completes after the upload releases the state");
  if (raced.code === 0) assert.ok(uploadAt !== -1 && uploadAt < unbindAt, "the upload finished before the binding was removed");
  else assert.equal(uploadAt, -1);
  assert.equal((await serverObservations(j, codexTarget.id)).length, observationsBeforeRace + (raced.code === 0 ? 1 : 0));
  assert.equal((await ok(j, "codex global is unbound after the race", ["scopes", "list", "--provider", "codex"])).providers.codex.global, null);

  assertPayloadsPrivate(j, ["linked-skill", "linked-claude", "Bad_Name", "mismatch-name", "legacy-installed", "credentials.json"]);
  const stateInfo = await stat(stateFile);
  assert.equal(stateInfo.mode & 0o077, 0);
  assert.equal((await stat(path.dirname(stateFile))).mode & 0o077, 0);
  assert.deepEqual({ codex: await treeDigest(codexRoot), claude: await treeDigest(claudeRoot), outside: await treeDigest(path.join(j.base, "outside")) }, before);
});

test("workspace scopes resolve deterministically across exclusions, aliases, nesting, providers, and separate project enrollment", async (t) => {
  const j = await journey(t, "scope-resolution");
  const codexRoot = await codexGlobalFixture(j.base);
  const claudeRoot = await claudeGlobalFixture(j.base);
  const foo = path.join(j.base, "code", "foo");
  const foobar = path.join(j.base, "code", "foobar");
  await writeSkill(path.join(foo, ".agents", "skills", "foo-codex-skill"), "foo-codex-skill");
  await writeSkill(path.join(foo, ".claude", "skills", "foo-claude-skill"), "foo-claude-skill");
  // A hidden file cannot hold a skill; a hidden directory might.
  await writeFile(path.join(foo, ".agents", "skills", ".DS_Store"), "finder metadata\n");
  await writeSkill(path.join(foo, ".claude", "skills", ".drafts", "draft-skill"), "draft-skill");
  await mkdir(path.join(foo, "src"), { recursive: true });
  await mkdir(path.join(foo, "nested", "deep"), { recursive: true });
  await mkdir(path.join(foo, "other"), { recursive: true });
  await mkdir(foobar, { recursive: true });
  await symlink(foo, path.join(j.base, "alias-to-foo"));
  const before = { foo: await treeDigest(foo), codex: await treeDigest(codexRoot) };
  const owner = async (provider: string, target: string, step: string) => (await ok(j, step, ["scopes", "resolve", "--provider", provider, "--path", target]));

  assert.equal((await owner("codex", foo, "unowned before any enrollment")).owner, "unowned");
  const codexGlobal = await ok(j, "enroll codex global", enrollArgs(j, "codex", "global", codexRoot));
  await ok(j, "enroll claude global", enrollArgs(j, "claude", "global", claudeRoot));
  const inherited = await owner("codex", foo, "foo inherits global");
  assert.equal(inherited.owner, "global");
  assert.equal(inherited.targetId, codexGlobal.targetId);
  assert.equal(inherited.nativeInheritance, "unchanged");

  assert.equal((await ok(j, "exclude foo from codex", ["scopes", "exclude", "--provider", "codex", "--project", foo])).changed, true);
  assert.equal((await ok(j, "repeat exclusion is idempotent", ["scopes", "exclude", "--provider", "codex", "--project", foo])).changed, false);
  assert.equal((await owner("codex", foo, "excluded root")).owner, "excluded");
  assert.equal((await owner("codex", path.join(foo, "src"), "excluded descendant")).owner, "excluded");
  assert.equal((await owner("codex", path.join(j.base, "alias-to-foo", "src"), "alias resolves canonically")).owner, "excluded");
  assert.equal((await owner("codex", foobar, "sibling prefix is not excluded")).owner, "global");
  assert.equal((await owner("claude", foo, "claude is independent")).owner, "global");

  // Overlap rules are enforced before any registry write.
  const postsBefore = j.requests.filter((request) => request.method === "POST").length;
  await fails(j, "project containing the global root", enrollArgs(j, "codex", "project", path.join(j.base, "home", ".codex")), "SCOPE_OVERLAP");
  await fails(j, "exclude the global root", ["scopes", "exclude", "--provider", "codex", "--project", codexRoot], "SCOPE_OVERLAP");
  await fails(j, "exclude home", ["scopes", "exclude", "--provider", "codex", "--project", os.homedir()], "SCOPE_ROOT_INVALID");
  await fails(j, "exclude through a symlinked final component", ["scopes", "exclude", "--provider", "codex", "--project", path.join(j.base, "alias-to-foo")], "SCOPE_ROOT_INVALID");
  assert.equal(j.requests.filter((request) => request.method === "POST").length, postsBefore);

  // Separate project enrollment wins at the excluded root; a deeper exclusion
  // still stops ownership inside that project.
  const project = await ok(j, "enroll excluded foo as codex project", enrollArgs(j, "codex", "project", foo));
  assert.equal((await ok(j, "repeat project enrollment", enrollArgs(j, "codex", "project", foo))).targetId, project.targetId);
  const projectOwner = await owner("codex", path.join(foo, "src"), "project owns descendants");
  assert.deepEqual([projectOwner.owner, projectOwner.mode, projectOwner.targetId], ["project", "inventory", project.targetId]);
  await ok(j, "nested exclusion inside project", ["scopes", "exclude", "--provider", "codex", "--project", path.join(foo, "nested")]);
  assert.equal((await owner("codex", path.join(foo, "nested", "deep"), "nested exclusion wins")).owner, "excluded");
  assert.equal((await owner("codex", path.join(foo, "other"), "project still owns siblings")).owner, "project");
  assert.equal((await ok(j, "include foo again", ["scopes", "include", "--provider", "codex", "--project", foo])).changed, true);
  assert.equal((await owner("codex", foo, "project remains after include")).owner, "project");
  await fails(j, "include a path that is not excluded", ["scopes", "include", "--provider", "codex", "--project", foobar], "SCOPE_NOT_EXCLUDED");

  const projectObserved = await ok(j, "observe codex project", ["scopes", "observe", "--provider", "codex", "--scope", "project", "--project", foo, "--upload"]);
  const [projectObservation] = await serverObservations(j, project.targetId);
  assert.deepEqual(projectObservation!.skills.map((skill) => skill.slug), ["foo-codex-skill"]);
  assert.equal(projectObservation!.metadata?.scope, "project");
  assert.equal(projectObserved.inventoryComplete, true);
  assert.deepEqual(projectObserved.local.skipped, [{ name: ".DS_Store", reason: "hidden" }]);
  const claudeProject = await ok(j, "enroll foo as claude project", enrollArgs(j, "claude", "project", foo));
  assert.equal((await owner("claude", path.join(foo, "src"), "claude project owner")).targetId, claudeProject.targetId);
  const claudeProjectObserved = await ok(j, "observe claude project locally", ["scopes", "observe", "--provider", "claude", "--scope", "project", "--project", foo]);
  assert.deepEqual(claudeProjectObserved.observation.skills.map((skill: { slug: string }) => skill.slug), ["foo-claude-skill"]);
  assert.deepEqual(claudeProjectObserved.local.skipped, [{ name: ".drafts", reason: "hidden" }]);
  assert.equal(claudeProjectObserved.inventoryComplete, false);
  const kinds = (await serverTargets(j)).map((target) => `${target.adapter.kind}:${target.metadata?.scope}`).sort();
  assert.deepEqual(kinds, ["claude-inventory:global", "claude-inventory:project", "codex-inventory:global", "codex-inventory:project"]);

  // Malformed and newer local state fail closed without being rewritten.
  const stateFile = path.join(j.configDir, "scopes", "workspace-scopes.json");
  const stateBytes = await readFile(stateFile, "utf8");
  for (const [label, bytes, code] of [["malformed", "{not json", "SCOPE_STATE_INVALID"], ["newer", JSON.stringify({ ...JSON.parse(stateBytes), schemaVersion: 99 }), "SCOPE_STATE_UNSUPPORTED"]] as const) {
    await writeFile(stateFile, bytes);
    await fails(j, `${label} state is refused`, ["scopes", "exclude", "--provider", "codex", "--project", foobar], code);
    assert.equal(await readFile(stateFile, "utf8"), bytes);
  }

  // A write that would pass the documented 512 KiB reader limit is refused, so
  // accepted writes always stay readable.
  const limit = 512 * 1024;
  const seeded = JSON.parse(stateBytes);
  const seed = (length: number) => {
    // 200 entries keeps the separate 256-rule limit out of reach of this check.
    seeded.providers.claude.exclusions = Array.from({ length: 200 }, (_, index) => ({
      path: `/synthetic-exclusion/${String(index).padStart(3, "0")}-${"x".repeat(length)}`,
      addedAt: "2026-09-29T00:00:00.000Z",
    }));
    return `${JSON.stringify(seeded, null, 2)}\n`;
  };
  const probe = seed(1);
  const seededText = seed(1 + Math.floor((limit - 2048 - Buffer.byteLength(probe)) / 200));
  assert.ok(Buffer.byteLength(seededText) < limit && Buffer.byteLength(seededText) > limit - 2304);
  await writeFile(stateFile, seededText);
  assert.equal((await cli(j, "near-limit state is readable", ["scopes", "list"])).code, 0);
  let refused = false;
  for (let index = 0; index < 8 && !refused; index += 1) {
    const directory = path.join(j.base, "long", String(index).padEnd(200, "d"), "e".repeat(200), "f".repeat(200));
    await mkdir(directory, { recursive: true });
    const before = await readFile(stateFile, "utf8");
    const result = await cli(j, `exclude long path ${index}`, ["scopes", "exclude", "--provider", "claude", "--project", directory]);
    if (result.code === 0) continue;
    refused = true;
    assert.equal(result.errorCode(), "SCOPE_STATE_LIMIT", result.err);
    assert.equal(await readFile(stateFile, "utf8"), before);
  }
  assert.equal(refused, true, "a write past the reader limit must be refused");
  assert.equal((await cli(j, "state stays readable after the refusal", ["scopes", "list"])).code, 0);
  await writeFile(stateFile, stateBytes);
  assertPayloadsPrivate(j, []);
  assert.deepEqual({ foo: await treeDigest(foo), codex: await treeDigest(codexRoot) }, before);
});

test("migration adopts an existing managed Codex workspace through a previewed, stale-safe, backed-up apply", async (t) => {
  const j = await journey(t, "migration");
  const codexRoot = await codexGlobalFixture(j.base);
  const managed = path.join(j.base, "code", "managed");
  const legacy = path.join(j.base, "code", "legacy");
  const plain = path.join(j.base, "code", "plain");
  for (const directory of [managed, legacy, plain]) await mkdir(directory, { recursive: true });
  await ok(j, "enroll codex global", enrollArgs(j, "codex", "global", codexRoot));
  const globalTarget = (await serverTargets(j))[0]!;

  // The existing managed writer path creates a real pre-scope binding.
  for (const workspace of [managed, legacy]) {
    const result = await cli(j, "existing codex enroll --workspace", ["codex", "enroll", "--workspace", workspace, "--architecture-id", j.api.architecture.architectureId,
      "--environment-id", j.api.architecture.environmentId, "--profile-id", j.api.architecture.profileId]);
    assert.equal(result.code, 0, result.err);
  }
  const bindingFile = path.join(managed, ".agents", "skills", ".myskills-app", "codex-workspace.json");
  const bindingBefore = await readFile(bindingFile);
  const workspaceTarget = JSON.parse(bindingBefore.toString("utf8")).target as ArchitectureTarget;
  await writeFile(path.join(legacy, ".agents", "skills", ".myskills-app", "installed.json"), JSON.stringify({ version: 1, installations: { "old-skill": { slug: "old-skill", version: "0.1.0" } } }));
  const targetCount = (await serverTargets(j)).length;
  assert.equal((await ok(j, "managed workspace inherits global before migration", ["scopes", "resolve", "--provider", "codex", "--path", managed])).owner, "global");
  await fails(j, "inventory enrollment cannot shadow a managed binding", enrollArgs(j, "codex", "project", managed), "SCOPE_BINDING_CONFLICT");

  const stateFile = path.join(j.configDir, "scopes", "workspace-scopes.json");
  const stateBeforePlan = await readFile(stateFile, "utf8");
  const plan = await ok(j, "migration plan", ["scopes", "migrate", "plan", "--provider", "codex", "--project", managed]);
  assert.equal(plan.writes, false);
  assert.equal(plan.currentOwner, "global");
  assert.deepEqual(plan.actions.map((action: { type: string }) => action.type), ["add-exclusion", "adopt-managed-binding"]);
  assert.equal(plan.actions[1].targetId, workspaceTarget.id);
  assert.deepEqual(plan.blockers, []);
  assert.equal(await readFile(stateFile, "utf8"), stateBeforePlan);

  // Any state change after the preview invalidates it.
  await ok(j, "unrelated exclusion changes preconditions", ["scopes", "exclude", "--provider", "codex", "--project", plain]);
  const stateAfterChange = await readFile(stateFile, "utf8");
  await fails(j, "stale plan is rejected", ["scopes", "migrate", "apply", "--provider", "codex", "--project", managed, "--plan-digest", plan.planDigest], "SCOPE_MIGRATION_STALE");
  assert.equal(await readFile(stateFile, "utf8"), stateAfterChange);
  const fresh = await ok(j, "fresh migration plan", ["scopes", "migrate", "plan", "--provider", "codex", "--project", managed]);
  assert.notEqual(fresh.planDigest, plan.planDigest);
  const applied = await ok(j, "migration apply", ["scopes", "migrate", "apply", "--provider", "codex", "--project", managed, "--plan-digest", fresh.planDigest]);
  assert.equal(applied.applied, true);
  const migratedState = JSON.parse(await readFile(stateFile, "utf8"));
  const managedInfo = await stat(managed, { bigint: true });
  assert.equal(migratedState.schemaVersion, 2);
  assert.deepEqual(migratedState.providers.codex.projects[0].rootIdentity, { ino: String(managedInfo.ino), dev: String(managedInfo.dev) });
  assert.equal(await readFile(path.join(j.configDir, "scopes", "backups", applied.backup), "utf8"), stateAfterChange);
  const adopted = await ok(j, "managed workspace resolves to its own target", ["scopes", "resolve", "--provider", "codex", "--path", managed]);
  assert.deepEqual([adopted.owner, adopted.mode, adopted.targetId], ["project", "managed", workspaceTarget.id]);
  const noop = await ok(j, "re-plan after apply is a no-op", ["scopes", "migrate", "plan", "--provider", "codex", "--project", managed]);
  assert.deepEqual(noop.actions, []);

  // Provenance-less installs block adoption instead of being attached.
  const legacyPlan = await ok(j, "legacy install plan", ["scopes", "migrate", "plan", "--provider", "codex", "--project", legacy]);
  assert.deepEqual(legacyPlan.blockers, ["legacy-installations-without-provenance"]);
  await fails(j, "legacy install apply", ["scopes", "migrate", "apply", "--provider", "codex", "--project", legacy, "--plan-digest", legacyPlan.planDigest], "SCOPE_MIGRATION_BLOCKED");
  // A plain project reassigned from global needs only an exclusion.
  const plainPlan = await ok(j, "plain project plan", ["scopes", "migrate", "plan", "--provider", "claude", "--project", plain]);
  assert.equal(plainPlan.currentOwner, "unowned");
  assert.deepEqual(plainPlan.actions.map((action: { type: string }) => action.type), ["add-exclusion"]);

  // No identity rewrite, no new targets, no promotion, and the managed guard remains.
  assert.deepEqual(await readFile(bindingFile), bindingBefore);
  const after = await serverTargets(j);
  assert.equal(after.length, targetCount);
  assert.equal(after.find((target) => target.id === workspaceTarget.id)?.identityDigest, workspaceTarget.identityDigest);
  assert.equal(after.find((target) => target.id === globalTarget.id)?.capabilities["sync.write"], false);
  const bypass = await cli(j, "managed install guard intact", ["install", "any-skill", "--dir", path.join(managed, ".agents", "skills")]);
  assert.equal(bypass.code, 2);
  assert.match(bypass.err, /Use --workspace/);
  assertPayloadsPrivate(j, []);
});


test("validated sensitive-word slugs upload only when the server explicitly supports structural privacy validation", async (t) => {
  const j = await journey(t, "privacy-capability");
  const root = path.join(j.base, "selected-skills");
  const slugs = ["alpha-helper", "codex-config-sync", "path-helper", "token-budget"];
  for (const slug of slugs) await writeSkill(path.join(root, slug), slug);
  const before = await treeDigest(root);
  const local = await ok(j, "local preview includes valid bounded names", ["scopes", "inventory", "--provider", "codex", "--root", root]);
  assert.deepEqual(local.skills.map((skill: { slug: string }) => skill.slug), slugs);
  assert.equal(local.inventoryComplete, true);
  assert.deepEqual(local.withheld, []);
  assert.equal(j.requests.length, 0);
  const enrolled = await ok(j, "enroll privacy fixture", enrollArgs(j, "codex", "global", root));
  const args = ["scopes", "observe", "--provider", "codex", "--scope", "global", "--upload"];
  const supported = await ok(j, "new server accepts validated slugs", args);
  assert.deepEqual(supported.observation.skills.map((skill: { slug: string }) => skill.slug).sort(), slugs);
  assert.deepEqual(supported.local.withheld, []);
  assert.equal(supported.inventoryComplete, true);
  for (const capability of ["absent", false, "invalid"] as const) {
    j.observationSlugCapability = capability;
    const legacy = await ok(j, `legacy fallback with capability ${capability}`, args);
    assert.deepEqual(legacy.observation.skills.map((skill: { slug: string }) => skill.slug), ["alpha-helper"]);
    assert.deepEqual(legacy.local.withheld, slugs.slice(1));
    assert.equal(legacy.inventoryComplete, false);
    assert.deepEqual(legacy.incompleteReasons, ["withheld"]);
    assert.equal(count(legacy.observation, "skill-name-withheld"), 3);
    const posted = JSON.parse(j.requests.filter((request) => request.path.endsWith("/observations") && request.method === "POST").at(-1)!.body);
    assert.deepEqual(posted.skills.map((skill: { slug: string }) => skill.slug), ["alpha-helper"]);
  }
  const observations = await serverObservations(j, enrolled.targetId);
  assert.equal(observations.length, 4);
  assert.equal(observations.filter((observation) => observation.skills.length === 4).length, 1);
  assertPayloadsPrivate(j, []);
  assert.equal(await treeDigest(root), before);
});


// Authored before the device-identity correction. CLI/API scenarios protect
// existing remote IDs and exact local bytes; a focused migration-plan check
// varies only dev because remounting filesystems is outside this test's authority.
async function legacyScopeBytes(j: Journey): Promise<{ file: string; bytes: string; state: Json }> {
  const file = path.join(j.configDir, "scopes", "workspace-scopes.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.schemaVersion = 1;
  for (const provider of ["codex", "claude"]) {
    const scopes = state.providers[provider];
    for (const record of [...(scopes.global ? [scopes.global] : []), ...scopes.projects]) record.rootIdentity = { ino: record.rootIdentity.ino };
  }
  const bytes = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(file, bytes);
  return { file, bytes, state };
}

test("legacy inode-only scopes require explicit acknowledgment and keep both existing target identities", async (t) => {
  const j = await journey(t, "root-identity-legacy");
  const roots = { codex: await codexGlobalFixture(j.base), claude: await claudeGlobalFixture(j.base) };
  for (const provider of ["codex", "claude"] as const) await ok(j, `${provider} original enrollment`, enrollArgs(j, provider, "global", roots[provider]));
  const targetsBefore = await serverTargets(j);
  const legacy = await legacyScopeBytes(j);
  const requestsBefore = j.requests.length;
  const list = await ok(j, "list shows pending identities without upgrading", ["scopes", "list"]);
  for (const provider of ["codex", "claude"] as const) {
    assert.equal(list.providers[provider].global.rootIdentityStatus, "legacy");
    assert.equal((await ok(j, `${provider} legacy resolve`, ["scopes", "resolve", "--provider", provider, "--path", roots[provider]])).rootIdentityStatus, "legacy");
    for (const upload of [false, true]) await fails(j, `${provider} legacy observation refused ${upload}`, ["scopes", "observe", "--provider", provider, "--scope", "global", ...(upload ? ["--upload"] : [])], "SCOPE_ROOT_IDENTITY_LEGACY");
    await fails(j, `${provider} ordinary re-enroll refuses legacy`, enrollArgs(j, provider, "global", roots[provider]), "SCOPE_ROOT_IDENTITY_LEGACY");
  }
  assert.equal(j.requests.length, requestsBefore, "legacy checks fail before API calls");
  assert.equal(await readFile(legacy.file, "utf8"), legacy.bytes);

  const ackArgs = (provider: "codex" | "claude") => [...enrollArgs(j, provider, "global", roots[provider]), "--accept-current-root"];
  await fails(j, "another account cannot acknowledge", ackArgs("codex"), "SCOPE_ACCOUNT_MISMATCH", { token: j.api.otherSession });
  await fails(j, "another architecture profile cannot acknowledge", ackArgs("codex").map((value) => value === j.api.architecture.profileId ? "other-profile" : value), "SCOPE_BINDING_CONFLICT");
  const other = await startApi(t, randomUUID());
  await fails(j, "another registry cannot acknowledge", [...ackArgs("codex"), "--api-url", other.url, "--token", other.session], "SCOPE_REGISTRY_MISMATCH");
  j.faults.push({ method: "GET", path: /^\/v1\/architecture-targets\/[^/]+$/, when: "malformed-response" });
  await fails(j, "unverifiable target cannot acknowledge", ackArgs("codex"), "SCOPE_TARGET_INVALID");
  assert.equal(await readFile(legacy.file, "utf8"), legacy.bytes);
  const writesBefore = j.requests.filter((request) => request.method !== "GET").length;

  for (const provider of ["codex", "claude"] as const) {
    const before = await readFile(legacy.file, "utf8");
    const result = await ok(j, `${provider} explicitly acknowledge same root`, ackArgs(provider));
    assert.equal(result.rootIdentityUpgraded, true);
    assert.equal(result.created, false);
    assert.equal(result.targetId, legacy.state.providers[provider].global.binding.target.id);
    assert.equal(await readFile(path.join(j.configDir, "scopes", "backups", result.backup), "utf8"), before);
    assert.equal((await stat(path.join(j.configDir, "scopes", "backups", result.backup))).mode & 0o077, 0);
    const upgraded = JSON.parse(await readFile(legacy.file, "utf8"));
    assert.equal(upgraded.schemaVersion, 2);
    const info = await stat(roots[provider], { bigint: true });
    assert.deepEqual(upgraded.providers[provider].global.rootIdentity, { ino: String(info.ino), dev: String(info.dev) });
    assert.deepEqual(upgraded.providers[provider].global.binding, legacy.state.providers[provider].global.binding);
    if (provider === "codex") {
      assert.equal(upgraded.providers.claude.global.rootIdentity.dev, null, "unknown historical device remains unknown");
      await fails(j, "other legacy root still cannot upload", ["scopes", "observe", "--provider", "claude", "--scope", "global", "--upload"], "SCOPE_ROOT_IDENTITY_LEGACY");
    }
    const pinnedBytes = await readFile(legacy.file, "utf8");
    const retry = await ok(j, `${provider} acknowledgment retry is no-op`, ackArgs(provider));
    assert.equal(retry.rootIdentityUpgraded, false);
    assert.equal(retry.backup, null);
    assert.equal(await readFile(legacy.file, "utf8"), pinnedBytes);
  }
  assert.equal(j.requests.filter((request) => request.method !== "GET").length, writesBefore, "acknowledgment makes no remote writes");
  assert.deepEqual(await serverTargets(j), targetsBefore);
  for (const provider of ["codex", "claude"] as const) {
    assert.equal((await ok(j, `${provider} pinned listing`, ["scopes", "list", "--provider", provider])).providers[provider].global.rootIdentityStatus, "pinned");
    await ok(j, `${provider} observation works after explicit upgrade`, ["scopes", "observe", "--provider", provider, "--scope", "global", "--upload"]);
  }
  assert.equal((await serverTargets(j)).length, 2);
  assertPayloadsPrivate(j, []);
});

test("device pinning rejects same-inode device changes, malformed identities and roots replaced during acknowledgment", async (t) => {
  const j = await journey(t, "root-identity-device");
  const root = await codexGlobalFixture(j.base);
  const enrolled = await ok(j, "enroll device fixture", enrollArgs(j, "codex", "global", root));
  const file = path.join(j.configDir, "scopes", "workspace-scopes.json");
  const pinnedBytes = await readFile(file, "utf8");
  const pinned = JSON.parse(pinnedBytes);
  const info = await stat(root, { bigint: true });
  assert.equal(pinned.schemaVersion, 2);
  assert.deepEqual(pinned.providers.codex.global.rootIdentity, { ino: String(info.ino), dev: String(info.dev) });
  pinned.providers.codex.global.rootIdentity.dev = String(info.dev + 1n);
  const wrongDevice = `${JSON.stringify(pinned)}\n`;
  await writeFile(file, wrongDevice);
  const requestsBefore = j.requests.length;
  for (const upload of [false, true]) await fails(j, `equal inode wrong device observe ${upload}`, ["scopes", "observe", "--provider", "codex", "--scope", "global", ...(upload ? ["--upload"] : [])], "SCOPE_ROOT_CHANGED");
  for (const accept of [false, true]) await fails(j, `known mismatch cannot enroll ${accept}`, [...enrollArgs(j, "codex", "global", root), ...(accept ? ["--accept-current-root"] : [])], "SCOPE_ROOT_CHANGED");
  assert.equal(j.requests.length, requestsBefore);
  assert.equal(await readFile(file, "utf8"), wrongDevice);
  for (const invalid of [undefined, "bad-device", "-1", 123]) {
    pinned.providers.codex.global.rootIdentity.dev = invalid;
    const bytes = JSON.stringify(pinned);
    await writeFile(file, bytes);
    await fails(j, "malformed device identity is preserved", ["scopes", "list"], "SCOPE_STATE_INVALID");
    assert.equal(await readFile(file, "utf8"), bytes);
  }
  await writeFile(file, pinnedBytes);
  const legacy = await legacyScopeBytes(j);
  j.faults.push({ method: "GET", path: new RegExp(`^/v1/architecture-targets/${enrolled.targetId}$`), when: "hook", run: async () => {
    await rename(root, `${root}-original`);
    await mkdir(root);
  } });
  await fails(j, "replacement during remote validation cannot be acknowledged", [...enrollArgs(j, "codex", "global", root), "--accept-current-root"], "SCOPE_ROOT_CHANGED");
  assert.equal(await readFile(file, "utf8"), legacy.bytes);
  assert.equal((await serverTargets(j)).length, 1);
  assert.equal(j.requests.slice(requestsBefore).some((request) => request.method !== "GET"), false);
});

test("scope migration digest pins the device as well as inode and adopted records preserve that identity", async (t) => {
  const j = await journey(t, "root-identity-migration");
  const projectRoot = path.join(j.base, "project");
  await mkdir(projectRoot);
  const project = await canonicalScopeDirectory(projectRoot);
  const snapshot = await readScopeState(path.join(j.configDir, "scopes"));
  const plan = await planScopeMigration(snapshot, "claude", project);
  const changedDevice = await planScopeMigration(snapshot, "claude", { ...project, identity: { ...project.identity, dev: String((await stat(projectRoot, { bigint: true })).dev + 1n) } });
  assert.notEqual(plan.plan.planDigest, changedDevice.plan.planDigest, "same path and inode on another device must invalidate the plan");
  const result = await cli(j, "old-device migration digest is stale", ["scopes", "migrate", "apply", "--provider", "claude", "--project", projectRoot, "--plan-digest", changedDevice.plan.planDigest]);
  assert.notEqual(result.code, 0);
  assert.equal(result.errorCode(), "SCOPE_MIGRATION_STALE");
  assert.equal((await readScopeState(path.join(j.configDir, "scopes"))).bytes, null);
});


test("legacy pending enrollment acknowledgment preserves its recovery identity without registering or granting consent", async (t) => {
  for (const phase of ["before-register", "after-register", "before-consent"] as const) {
    const j = await journey(t, `root-identity-pending-${phase}`);
    const root = path.join(j.base, "skills");
    await writeSkill(path.join(root, "sample-skill"), "sample-skill");
    const registrationPath = /^\/v1\/architecture-targets$/;
    j.faults.push({ method: "POST", path: phase === "before-consent" ? /^\/v1\/architecture-targets\/[^/]+\/consent$/ : registrationPath,
      when: phase === "after-register" ? "after-send" : "before-send" });
    const interrupted = await cli(j, "interrupt enrollment", enrollArgs(j, "codex", "global", root));
    assert.notEqual(interrupted.code, 0);
    const legacy = await legacyScopeBytes(j);
    const pendingBinding = legacy.state.providers.codex.global.binding;
    assert.equal(pendingBinding.status, phase === "before-consent" ? "registered" : "registering");
    const targetsBefore = await serverTargets(j);
    assert.equal(targetsBefore.length, phase === "before-register" ? 0 : 1);
    const ack = [...enrollArgs(j, "codex", "global", root), "--accept-current-root"];
    const writesBefore = j.requests.filter((request) => request.method !== "GET").length;
    if (phase === "after-register") {
      const target = targetsBefore[0]!;
      const capped = Array.from({ length: 500 }, (_, index) => ({ ...target, id: `target-cap-${index}`, identityDigest: String(index).padStart(64, "0") }));
      const cases = [
        ["capped list cannot prove absence", { targets: capped }, "SCOPE_TARGET_LIST_INCOMPLETE"],
        ["capped list cannot prove unique match", { targets: [target, ...capped.slice(1)] }, "SCOPE_TARGET_LIST_INCOMPLETE"],
        ["malformed target list", { targets: {} }, "SCOPE_TARGET_LIST_INVALID"],
        ["ambiguous target list", { targets: [target, target] }, "SCOPE_TARGET_AMBIGUOUS"],
        ["revoked pending target", { targets: [{ ...target, status: "revoked", consent: { ...target.consent, status: "revoked", revokedAt: new Date().toISOString() } }] }, "SCOPE_TARGET_REVOKED"],
        ["wrong pending owner", { targets: [{ ...target, owner: { type: "user", id: "wrong-owner" } }] }, "SCOPE_TARGET_OWNER_INVALID"],
        ["wrong pending architecture", { targets: [{ ...target, profileId: "wrong-profile" }] }, "SCOPE_BINDING_CONFLICT"],
      ] as const;
      for (const [label, response, code] of cases) {
        j.faults.push({ method: "GET", path: registrationPath, when: "malformed-response", response });
        await fails(j, label, ack, code);
        assert.equal(await readFile(legacy.file, "utf8"), legacy.bytes);
      }
    }
    const result = await ok(j, "explicitly acknowledge pending root", ack);
    assert.equal(result.rootIdentityUpgraded, true);
    assert.equal(result.enrollmentPending, true);
    assert.equal(result.created, false);
    assert.equal(await readFile(path.join(j.configDir, "scopes/backups", result.backup), "utf8"), legacy.bytes);
    const updated = JSON.parse(await readFile(legacy.file, "utf8"));
    assert.deepEqual(updated.providers.codex.global.binding, pendingBinding);
    const retry = await ok(j, "pending acknowledgment retry is no-op", ack);
    assert.equal(retry.rootIdentityUpgraded, false);
    assert.equal(retry.enrollmentPending, true);
    assert.equal(j.requests.filter((request) => request.method !== "GET").length, writesBefore);
    assert.deepEqual(await serverTargets(j), targetsBefore);
    if (phase === "after-register") {
      const capped = Array.from({ length: 500 }, (_, index) => ({ ...targetsBefore[0], id: `target-cap-${index}`, identityDigest: String(index).padStart(64, "0") }));
      const beforeRetry = await readFile(legacy.file, "utf8");
      j.faults.push({ method: "GET", path: registrationPath, when: "malformed-response", response: { targets: capped } });
      await fails(j, "normal pending recovery also refuses capped lists", enrollArgs(j, "codex", "global", root), "SCOPE_TARGET_LIST_INCOMPLETE");
      assert.equal(await readFile(legacy.file, "utf8"), beforeRetry);
      assert.equal(j.requests.filter((request) => request.method !== "GET").length, writesBefore);
    }
    const resumed = await ok(j, "normal enrollment resumes original intent", enrollArgs(j, "codex", "global", root));
    const finalTargets = await serverTargets(j);
    assert.equal(finalTargets.length, 1);
    assert.equal(finalTargets[0]!.identityDigest, pendingBinding.identityDigest);
    assert.equal(resumed.targetId, finalTargets[0]!.id);
    if (targetsBefore[0]) assert.equal(finalTargets[0]!.id, targetsBefore[0].id);
  }
});
