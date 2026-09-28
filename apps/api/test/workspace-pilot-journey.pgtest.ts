/**
 * Two-user pilot acceptance, through the CLI, loopback HTTP and real Postgres.
 *
 * Failure cases recorded before this test was written:
 * P01 Inventory enrollment or upload leaks another user's target, local paths or skill bodies.
 * P02 A second non-admin user can read, append observations, change consent or revoke a private target.
 * P03 Inventory silently mutates provider files or installs unselected private skills.
 * P04 An author can approve their submission, or an unreviewed release reaches a team member.
 * P05 Reviewed registry latest bypasses team adoption, or the member can curate the team library.
 * P06 Migrating an existing managed project replaces its binding, install state or installed bytes.
 * P07 Membership removal permits fresh install/update or destroys the already installed version.
 *
 * Existing scope tests own path/locking/fault matrices; existing library tests own import parsing.
 * This test owns the handoff between private inventories, separate review, current team authority,
 * adopted versions and the existing Codex project writer. Global and Claude scopes stay read-only.
 * Synthetic users only. No host provider directory or third-party service is contacted.
 * WORKSPACE_PILOT_EVIDENCE_PATH chooses the receipt's parent/name; a fresh private directory is
 * always retained. The receipt contains scenario ids, synthetic ids, digests and exit/status codes,
 * never credentials, package bodies or local paths. It does not prove native model activation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createFlatArchitecture } from "@myskills-app/core";
import { runCli, type CliRuntime } from "../../cli/src/cli.js";
import { buildApp } from "../src/app.js";
import { PostgresArchitectureStore } from "../src/architectures/postgres-store.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { FixtureGithubSource, LibraryService, PostgresLibraryStore, PublicGithubSourceProvider } from "../src/libraries/index.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import { PostgresTeamStore } from "../src/teams/postgres-team-store.js";
import { TeamService } from "../src/teams/service.js";

// HTTP bodies are asserted at their public boundary, matching the existing PG journeys.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Method = "GET" | "POST" | "PUT" | "DELETE";
interface Actor { id: string; email: string; token: string; configDir: string }
const password = "correct horse battery staple";
const slug = "pilot-work-planner";
const instanceId = "91707000-0000-4000-8000-000000000001";
const userIds = ["91707000-0000-4000-8000-000000000002", "91707000-0000-4000-8000-000000000003", "91707000-0000-4000-8000-000000000004"];
const privateCanary = "PILOT-UNSELECTED-PRIVATE-CONTENT";

test("two-user workspace pilot: private inventory to separately reviewed team adoption, update and access loss", { timeout: 180_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assert.match(new URL(databaseUrl).pathname, /(^|[/_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyMigrations(pool);
  const db = createDb(pool);
  const skillRepository = new PostgresSkillRepository(db);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const architectureStore = new PostgresArchitectureStore(db);
  const targetService = new ArchitectureTargetService(new PostgresArchitectureTargetStore(db), new ArchitectureTargetBindingAuthorizer(architectureStore));
  const github = new FixtureGithubSource();
  const app = buildApp({
    authService: new AuthService(new PostgresAuthStore(db)),
    skillRepository, submissionService, architectureStore,
    architectureTargetService: targetService,
    teamService: new TeamService(new PostgresTeamStore(db)),
    libraryService: new LibraryService({
      store: new PostgresLibraryStore(db), submissions: submissionService, skillRepository, targets: targetService,
      sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
    }),
    registryInstanceId: instanceId,
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const temporary = await mkdtemp(join(tmpdir(), "myskills-pilot-files-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary);
  const scenarios: Array<{ id: string; observed: Json }> = [];
  const receipts: Array<{ actor: string; step: string; exitCode: number }> = [];
  const uploads: Json[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const record = (id: string, observed: Json) => scenarios.push({ id, observed });
  const call = async (method: Method, url: string, actor: Actor, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${actor.token}` }, ...(payload === undefined ? {} : { payload: payload as Json }) });
    return { status: response.statusCode, body: response.json() as Json, headers: response.headers, bytes: response.rawPayload };
  };
  const ok = (response: { status: number; body: Json }, status = 200) => {
    assert.equal(response.status, status, `expected ${status}, received ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`);
    return response.body;
  };
  const denied = (response: { status: number; body: Json }, status: number, code: string) => {
    assert.equal(response.status, status);
    assert.equal(response.body.error?.code, code);
  };
  const cli = async (actor: Actor, step: string, args: string[]) => {
    const stdout: string[] = [], stderr: string[] = [];
    const runtime: CliRuntime = {
      env: { MYSKILLS_TOKEN: actor.token, MYSKILLS_API_URL: apiUrl, MYSKILLS_CONFIG_DIR: actor.configDir },
      fetch: async (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, apiUrl, "the pilot must not contact an external registry");
        requests.push({ method: init?.method ?? "GET", path: url.pathname });
        if (init?.body && url.pathname.endsWith("/observations")) uploads.push(JSON.parse(init.body));
        return fetch(input, init);
      },
      io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    };
    const exitCode = await runCli([...args, "--json"], runtime);
    receipts.push({ actor: actor.id, step, exitCode });
    return { exitCode, out: stdout.join("\n"), err: stderr.join("\n") };
  };
  const cliOk = async (actor: Actor, step: string, args: string[]) => {
    const result = await cli(actor, step, args);
    assert.equal(result.exitCode, 0, `${step}: ${result.err}`);
    return args[0] === "install" ? {} : JSON.parse(result.out) as Json;
  };
  const actors: Actor[] = [];
  for (const [index, name] of ["alice", "bob", "reviewer"].entries()) {
    const id = userIds[index]!;
    const email = `${name}@example.com`;
    const roles = index === 2 ? ["maintainer"] : ["author"];
    await pool.query("INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())", [id, email, name]);
    await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [id, await hashPassword(password)]);
    for (const role of roles) await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, $2)", [id, role]);
    actors.push({ id, email, token: await loginWithMfa(app, email), configDir: join(base, name, "config") });
  }
  const [alice, bob, reviewer] = actors as [Actor, Actor, Actor];
  const actualRoles = (await pool.query("SELECT user_id, role FROM role_assignments ORDER BY user_id, role")).rows;
  assert.deepEqual(actualRoles, userIds.map((id, index) => ({ user_id: id, role: index === 2 ? "maintainer" : "author" })));

  const review = async (submissionId: string, expectedFiles: Array<{ path: string; content: string }>) => {
    const bundle = await call("GET", `/v1/review/submissions/${submissionId}/bundle`, reviewer);
    ok(bundle);
    const digest = sha256(bundle.bytes);
    assert.equal(bundle.headers["x-myskills-artifact-sha256"], digest);
    assert.deepEqual(bundle.body.files, [...expectedFiles].sort((a, b) => a.path.localeCompare(b.path)));
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "approve", artifactSha256: digest }));
    ok(await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "publish" }));
    return digest;
  };

  // A real reviewed seed gives each private architecture a valid registry reference.
  // This is setup, not the selected pilot skill or a permissive binding-authorizer fixture.
  const seed = packageFiles("pilot-baseline", "1.0.0", "authenticated", skillText("pilot-baseline", "Read the team guide."));
  const seedSubmission = ok(await call("POST", "/v1/submissions", alice, { manifest: seed.manifest, files: seed.files }), 202).submission;
  const seedDigest = await review(seedSubmission.id, seed.files);
  const bindings = new Map<string, { architectureId: string; environmentId: string; profileId: string }>();
  for (const actor of [alice, bob]) {
    const architecture = ok(await call("POST", "/v1/architectures", actor, { name: "Private pilot", description: "Synthetic pilot", patternId: "flat" }), 201).architecture;
    const environmentId = "pilot-work", profileId = "pilot-user";
    const spec = createFlatArchitecture({
      id: architecture.id, name: architecture.name,
      environment: { id: environmentId, kind: "personal" }, profile: { id: profileId, subject: { type: "user", id: actor.id } },
      skills: [{ id: "pilot-baseline", slug: "pilot-baseline", version: "1.0.0", digest: seedDigest, packageVisibility: "authenticated" }],
    });
    ok(await call("POST", `/v1/architectures/${architecture.id}/revisions`, actor, { expectedCurrentRevisionId: null, message: "Pilot setup", spec }), 201);
    bindings.set(actor.id, { architectureId: architecture.id, environmentId, profileId });
  }
  const bindingArgs = (actor: Actor) => Object.entries(bindings.get(actor.id)!).flatMap(([key, value]) => [
    `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value,
  ]);

  const roots: Array<{ actor: Actor; provider: string; root: string; digest: string; targetId: string }> = [];
  const inventoryTargets = new Map<string, string[]>();
  for (const actor of [alice, bob]) {
    const targetIds: string[] = [];
    for (const provider of ["codex", "claude"]) {
      const root = join(base, actor.id, `.${provider}`, "skills");
      const privateSlug = actor === alice ? "personal-journal" : "private-notes";
      await writeSkill(join(root, privateSlug), privateSlug, privateCanary);
      if (actor === alice && provider === "codex") await writeSkill(join(root, slug), slug, "Plan work in small reviewed steps.");
      const digest = await treeDigest(root);
      const enrollment = await cliOk(actor, `${provider} global enroll`, ["scopes", "enroll", "--provider", provider, "--scope", "global", "--root", root, ...bindingArgs(actor)]);
      assert.equal(enrollment.inventoryOnly, true);
      const observed = await cliOk(actor, `${provider} inventory upload`, ["scopes", "observe", "--provider", provider, "--scope", "global", "--upload"]);
      assert.equal(observed.uploaded, true);
      const target = ok(await call("GET", `/v1/architecture-targets/${enrollment.targetId}`, actor)).target;
      assert.deepEqual(target.owner, { type: "user", id: actor.id });
      assert.equal(target.adapter.kind, `${provider}-inventory`);
      assert.deepEqual([target.capabilities.apply, target.capabilities.rollback, target.capabilities["sync.write"]], [false, false, false]);
      assert.equal(target.consent.status, "granted");
      const observations = ok(await call("GET", `/v1/architecture-targets/${target.id}/observations`, actor)).observations;
      assert.equal(observations.length, 1);
      assert.deepEqual(observations[0].skills.map((skill: Json) => skill.slug).sort(), actor === alice && provider === "codex" ? [privateSlug, slug].sort() : [privateSlug]);
      assert.equal(observations[0].skills.every((skill: Json) => skill.managed === false), true);
      assert.equal(JSON.stringify(observations).includes(privateCanary), false);
      assert.equal(JSON.stringify(observations).includes(base), false);
      roots.push({ actor, provider, root, digest, targetId: target.id });
      targetIds.push(target.id);
    }
    inventoryTargets.set(actor.id, targetIds);
  }
  assert.equal(uploads.length, 4);
  for (const upload of uploads) for (const forbidden of [base, temporary, privateCanary, "Plan work in small reviewed steps."]) {
    assert.equal(JSON.stringify(upload).includes(forbidden), false, "inventory upload contains private local content");
  }
  record("P01", { users: [alice.id, bob.id], inventoryTargets: roots.map((root) => root.targetId), uploads: 4 });

  // Reuse a valid observation body: rejection must come from ownership, not malformed input.
  for (const owner of [alice, bob]) {
    const other = owner === alice ? bob : alice;
    const ownTargets = ok(await call("GET", "/v1/architecture-targets", owner)).targets;
    assert.deepEqual(ownTargets.map((target: Json) => target.id).sort(), [...inventoryTargets.get(owner.id)!].sort());
    for (const targetId of inventoryTargets.get(owner.id)!) {
      const before = ok(await call("GET", `/v1/architecture-targets/${targetId}`, owner)).target;
      const beforeObservations = ok(await call("GET", `/v1/architecture-targets/${targetId}/observations`, owner)).observations;
      const upload = uploads.find((body) => body.targetId === targetId);
      assert.ok(upload, "a valid CLI-produced observation must exist for the denied upload");
      for (const [method, suffix, payload] of [
        ["GET", "", undefined], ["GET", "/observations", undefined], ["POST", "/observations", upload],
        ["POST", "/consent", { decision: "deny" }], ["DELETE", "", undefined],
      ] as const) denied(await call(method, `/v1/architecture-targets/${targetId}${suffix}`, other, payload), 404, "ARCHITECTURE_TARGET_NOT_FOUND");
      assert.deepEqual(ok(await call("GET", `/v1/architecture-targets/${targetId}`, owner)).target, before);
      assert.deepEqual(ok(await call("GET", `/v1/architecture-targets/${targetId}/observations`, owner)).observations, beforeObservations);
    }
  }
  record("P02", { deniedRequests: 20, status: 404, targetStateAndHistoryPreserved: true });

  const team = ok(await call("POST", "/v1/teams", alice, { name: "Synthetic pilot team" }), 201).team;
  const invitation = ok(await call("POST", `/v1/teams/${team.id}/invitations`, alice, { email: bob.email }), 201).invitation;
  assert.ok(ok(await call("GET", "/v1/teams", bob)).invitations.some((row: Json) => row.id === invitation.id));
  ok(await call("POST", `/v1/teams/invitations/${invitation.id}/accept`, bob));
  const bobTeam = ok(await call("GET", "/v1/teams", bob)).teams.find((row: Json) => row.id === team.id);
  assert.equal(bobTeam.role, "member");
  const library = ok(await call("POST", "/v1/libraries", alice, { name: "Pilot reviewed skills", owner: { type: "team", id: team.id } }), 201).library;

  const selectedRoot = roots.find((root) => root.actor === alice && root.provider === "codex")!.root;
  const selectedText = await readFile(join(selectedRoot, slug, "SKILL.md"), "utf8");
  const v1 = packageFiles(slug, "1.0.0", "private", selectedText);
  const submissionPath = join(base, "selected-work-package");
  const submit = async (version: ReturnType<typeof packageFiles>) => {
    await mkdir(submissionPath, { recursive: true });
    for (const file of version.files) await writeFile(join(submissionPath, file.path), file.content);
    return (await cliOk(alice, `submit ${version.manifest.version}`, ["submit", "--path", submissionPath, "--change-kind", "fix"])).submission;
  };
  const submittedV1 = await submit(v1);
  denied(await call("POST", `/v1/review/submissions/${submittedV1.id}/actions`, alice, { action: "approve", artifactSha256: "a".repeat(64) }), 403, "REVIEW_ROLE_REQUIRED");
  assert.equal(ok(await call("GET", `/v1/submissions/${submittedV1.id}`, alice)).submission.reviewStatus, "unreviewed");
  assert.equal((await call("GET", `/v1/skills/${slug}/releases/1.0.0/bundle?platform=codex`, bob)).status, 404);
  const digestV1 = await review(submittedV1.id, v1.files);
  record("P04", { author: alice.id, reviewer: reviewer.id, submissionId: submittedV1.id, artifactSha256: digestV1, authorApprovalStatus: 403 });
  ok(await call("PUT", `/v1/skills/${slug}/sharing`, alice, { visibility: "team", teamIds: [team.id] }));
  const entry = ok(await call("POST", `/v1/libraries/${library.id}/entries`, alice, { kind: "skill", slug }), 201).entry;
  const adoptionV1 = ok(await call("POST", `/v1/library-entries/${entry.id}/adoptions`, alice, { version: "1.0.0", artifactSha256: digestV1, expectedCurrentAdoptionId: null }), 201).adoption;
  assert.equal(adoptionV1.attestation, "instance-reviewed");

  const project = join(base, "bob-managed-project");
  await mkdir(project);
  const enrolled = await cliOk(bob, "enroll managed Codex project", ["codex", "enroll", "--workspace", project, ...bindingArgs(bob)]);
  await cliOk(bob, "install adopted version 1", ["install", slug, "--library-entry", entry.id, "--workspace", project, "--accept-user-action"]);
  const managedRoot = join(project, ".agents", "skills");
  const installedRoot = join(managedRoot, slug);
  assert.equal(await readFile(join(installedRoot, "SKILL.md"), "utf8"), selectedText);
  assert.deepEqual((await readdir(managedRoot)).filter((name) => name !== ".myskills-app"), [slug]);
  const beforeMigration = await treeDigest(managedRoot);
  const plan = await cliOk(bob, "plan managed-project migration", ["scopes", "migrate", "plan", "--provider", "codex", "--project", project]);
  assert.deepEqual(plan.actions.map((action: Json) => action.type), ["add-exclusion", "adopt-managed-binding"]);
  assert.equal(plan.actions[1].targetId, enrolled.targetId);
  await cliOk(bob, "apply managed-project migration", ["scopes", "migrate", "apply", "--provider", "codex", "--project", project, "--plan-digest", plan.planDigest]);
  assert.equal(await treeDigest(managedRoot), beforeMigration, "migration must preserve binding, installation state and installed bytes");
  const resolution = await cliOk(bob, "resolve managed project", ["scopes", "resolve", "--provider", "codex", "--path", project]);
  assert.deepEqual([resolution.owner, resolution.mode, resolution.targetId], ["project", "managed", enrolled.targetId]);
  record("P06", { targetId: enrolled.targetId, managedTreeSha256: beforeMigration, preserved: true });

  const v2Text = selectedText.replace("small reviewed steps.", "small reviewed steps with an explicit acceptance check.");
  const v2 = packageFiles(slug, "1.0.1", "team", v2Text);
  const submittedV2 = await submit(v2);
  const digestV2 = await review(submittedV2.id, v2.files);
  const installedBeforeAdoption = await treeDigest(managedRoot);
  await cliOk(bob, "approved version is not yet adopted", ["update", slug, "--workspace", project]);
  assert.equal(await treeDigest(managedRoot), installedBeforeAdoption);
  const memberAdoption = await call("POST", `/v1/library-entries/${entry.id}/adoptions`, bob, { version: "1.0.1", artifactSha256: digestV2, expectedCurrentAdoptionId: adoptionV1.id });
  denied(memberAdoption, 403, "LIBRARY_WRITE_FORBIDDEN");
  assert.equal(ok(await call("GET", `/v1/library-entries/${entry.id}/resolution`, bob)).resolution.version, "1.0.0");
  ok(await call("POST", `/v1/library-entries/${entry.id}/adoptions`, alice, { version: "1.0.1", artifactSha256: digestV2, expectedCurrentAdoptionId: adoptionV1.id }), 201);
  await cliOk(bob, "update adopted version 2", ["update", slug, "--workspace", project]);
  assert.equal(await readFile(join(installedRoot, "SKILL.md"), "utf8"), v2Text);
  const installed = (await cliOk(bob, "read installed version 2", ["list", "--workspace", project])).installations;
  assert.deepEqual(installed.map((row: Json) => [row.slug, row.version, row.artifact.sha256, row.libraryEntryId]), [[slug, "1.0.1", digestV2, entry.id]]);
  const managedObservation = await cliOk(bob, "upload managed-project installation", ["codex", "observe", "--workspace", project, "--upload"]);
  assert.deepEqual(managedObservation.observation.skills.map((skill: Json) => [skill.slug, skill.version, skill.digest]), [[slug, "1.0.1", digestV2]]);
  record("P05", { entryId: entry.id, initialAdoptionId: adoptionV1.id, fromVersion: "1.0.0", toVersion: "1.0.1", artifactSha256: digestV2, memberAdoptionStatus: 403 });

  ok(await call("DELETE", `/v1/teams/${team.id}/members/${bob.id}`, alice));
  denied(await call("GET", `/v1/libraries/${library.id}`, bob), 404, "LIBRARY_NOT_FOUND");
  denied(await call("GET", `/v1/library-entries/${entry.id}/resolution`, bob), 404, "LIBRARY_ENTRY_NOT_FOUND");
  const preserved = await treeDigest(managedRoot);
  const beforeRefusalRequests = requests.length;
  for (const action of ["update", "install"]) {
    const result = await cli(bob, `${action} after access loss`, [action, slug, "--workspace", project, ...(action === "install" ? ["--library-entry", entry.id] : [])]);
    assert.notEqual(result.exitCode, 0, `${action} must refuse after membership removal`);
    if (action === "update") {
      const [update] = JSON.parse(result.out).updates;
      assert.equal(update.library.state, "curation-unavailable");
      assert.equal(update.appliedVersion, undefined);
    } else assert.equal(JSON.parse(result.err).error.code, "LIBRARY_CURATION_UNAVAILABLE");
    assert.equal(await treeDigest(managedRoot), preserved);
  }
  assert.equal(requests.slice(beforeRefusalRequests).some((request) => request.path.endsWith("/bundle")), false, "loss of access must not download a replacement");
  record("P07", { removedMember: bob.id, refusalCount: 2, bundleDownloads: 0, managedTreeSha256: preserved });
  for (const root of roots) assert.equal(await treeDigest(root.root), root.digest, "provider inventories must stay byte-for-byte unchanged");
  assert.equal(github.requests.length, 0);
  record("P03", { unchangedProviderRoots: roots.length, selectedSkillsInstalled: 1, externalSourceRequests: 0 });
  assert.deepEqual(scenarios.map((row) => row.id).sort(), ["P01", "P02", "P03", "P04", "P05", "P06", "P07"]);

  const evidenceTarget = process.env.WORKSPACE_PILOT_EVIDENCE_PATH;
  const evidenceDirectory = await mkdtemp(join(evidenceTarget ? dirname(evidenceTarget) : tmpdir(), "myskills-workspace-pilot-"));
  const evidencePath = join(evidenceDirectory, evidenceTarget ? basename(evidenceTarget) : "workspace-pilot-evidence.json");
  const receipt = JSON.stringify({ schemaVersion: 1, journey: "two-user-workspace-pilot", verification: "real-api-postgres-cli-filesystem", nativeActivation: "not-observed", scenarios, cli: receipts }, null, 2);
  for (const forbidden of [base, temporary, password, privateCanary, ...actors.map((actor) => actor.token)]) assert.equal(receipt.includes(forbidden), false);
  await writeFile(evidencePath, `${receipt}\n`, { flag: "wx", mode: 0o600 });
  assert.equal((await stat(evidenceDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), JSON.parse(receipt));
  t.diagnostic(`workspace pilot evidence: ${evidencePath}`);
});

function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function skillText(name: string, body: string): string { return `---\nname: ${name}\ndescription: Support reviewed work planning.\n---\n\n${body}\n`; }
async function writeSkill(directory: string, name: string, body: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), skillText(name, body));
}
function packageFiles(name: string, version: string, visibility: string, content: string) {
  const manifest = { name, title: "Pilot work planner", summary: "Plan reviewed work and its acceptance checks.", version, license: "MIT", visibility, platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["planning"] };
  return { manifest, files: [{ path: "SKILL.md", content }, { path: "skill.json", content: JSON.stringify(manifest) }] };
}
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relative: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), child = `${relative}/${name}`, entry = await lstat(file);
      hash.update(`${child}\0${entry.mode}\0`);
      if (entry.isSymbolicLink()) hash.update(await readlink(file));
      else if (entry.isDirectory()) await visit(file, child);
      else hash.update(await readFile(file));
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}
async function loginWithMfa(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { authorization: `Bearer ${login.json().token}` };
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers, payload: { password } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirmed = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers, payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const verified = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirmed.json().mfa.recoveryCodes[0] } });
  assert.equal(verified.statusCode, 200, verified.body);
  return verified.json().token as string;
}
async function applyMigrations(pool: ReturnType<typeof createPgPool>): Promise<void> {
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  await pool.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await pool.query("BEGIN");
    try {
      await pool.query(readFileSync(join(migrations, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file.replace(/\.sql$/, "")]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
