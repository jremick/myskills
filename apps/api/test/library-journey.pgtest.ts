/**
 * Libraries first release (1A–1C): HTTP journey against real Postgres.
 *
 * Authored before the production implementation. Every failure scenario
 * below is asserted in the journey and recorded in the evidence file
 * (`LIBRARY_JOURNEY_EVIDENCE_PATH` chooses the parent directory and filename;
 * a private unique subdirectory is always created, default parent: OS temp dir). The evidence
 * contains ids, status codes, error codes and digests only. It never
 * contains session tokens, API tokens, passwords or package bodies.
 *
 * Failure scenarios (F = must fail safely, S = must succeed exactly):
 *
 * Source boundary and SSRF
 * F01 A non-HTTPS, credential-bearing, non-GitHub, port, IP or traversal URL is rejected before any network request.
 * F02 A renamed repository answers with a redirect. The adapter does not follow it and does not leak the Location.
 * F03 Every provider request goes only to api.github.com or raw.githubusercontent.com and carries no authorization header.
 * S04 An unsupported whole-plugin repository saves as a reference and creates no package, submission or candidate.
 *
 * Discovery, preview and held bytes
 * S05 Discovery reports skill roots, supporting-file counts and default-excluded fixture roots with a complete inventory.
 * F06 A skill root with a symlink is blocked for import (no held bytes) without failing the save or other roots.
 * F07 A description that exceeds the strict manifest summary bound is blocked until an explicit reviewed mapping is supplied. It is never truncated.
 * S08 The preview preserves support files and the repository LICENSE byte-for-byte and generates a strict manifest with an opaque lineage slug.
 *     Beta.8 runtime-name normalization (owner-approved, updated 2026-09-26 before the packaging change): the runtime
 *     SKILL.md differs from the upstream file only in its name value, which is the slug; the exact upstream SKILL.md is
 *     held at myskills-source-skill.txt; the import manifest maps the upstream file to that path and records both digests.
 * S09 The preview package digest equals the SHA-256 of the canonical artifact payload computed independently by the test.
 * F10 The upstream branch moves after preview. Import submits the held preview bytes, not the new upstream bytes.
 * F11 Import without release metadata, or with a stale package digest, is rejected.
 * F12 Unclassified imports are recorded as breaking and requiresUserAction, never inherited maintenance.
 * F13 Another user cannot read or import a candidate (generic 404).
 * S14 A replayed import returns the original submission without a second version.
 * F15 An ordinary submission cannot inject provenance or self-review fields.
 *
 * Private self-review (admin controlled)
 * F16 Self-review is disabled by default after migration.
 * F17 A non-admin cannot enable it. An admin without an MFA session cannot enable it.
 * S18 An MFA admin enables it and the change is audited.
 * F19 Another user cannot self-review the owner's candidate. A wrong artifact hash is rejected.
 * S20 The owner self-reviews. The release is published for the owner only, with a distinct attestation, and no maintainer approval is recorded.
 * F21 Widening the sharing of a self-reviewed skill is refused for the owner and for an admin.
 * F22 A self-reviewed release cannot be adopted into a team library.
 * F23 After the admin disables the setting, a new self-review is refused, and the existing private release stays readable by its owner.
 * S24 A reviewer elevates the self-reviewed release with the exact hash after the owner requests it. The owner can then share it.
 *
 * Team curation (1C)
 * F25 A team member without owner role cannot write the team library.
 * F26 A private release cannot be referenced from a team library.
 * F27 An entry whose release becomes unreadable is omitted for a member, returns 404, and is omitted from the member inbox.
 * F28 A removed member loses the library and its inbox items immediately.
 * F29 A token with only libraries:read cannot write, but can resolve an adopted entry.
 *
 * Tracking and inbox (1B)
 * S30 A manual check after upstream movement creates exactly one candidate for the affected lineage and one inbox item.
 * S31 An unrelated upstream change creates no candidate. An unchanged check creates no snapshot or event.
 * F32 An older candidate is superseded by a newer one and cannot be imported.
 * S33 New and removed skills produce discovery findings without silent installation or deletion.
 * F34 A rate-limited check keeps the last successful time, schedules the retry after the provider reset, and alerts once.
 * F35 Two workers running together perform one check for a due track.
 *
 * Adoption and Updates constraint
 * F36 An approved but unadopted release is not offered as an update to a bound target and cannot be scheduled.
 * F37 Conflicting adopted versions for one target/install key block updates.
 * F38 Removing the entry keeps the last adopted pin and never falls back to registry latest; resolution returns 404.
 * S39 Deleting a library leaves registry releases intact.
 *
 * Existing ownership gap
 * F40 An ordinary submission cannot take over an orphaned skill whose owner is null.
 *
 * Byte integrity
 * S41 The owner's submitted bundle and the reviewer's elevation bundle are the held preview bytes: the
 *     SHA-256 of each raw response body equals the immutable candidate package digest, and the served
 *     hash header matches it. The served bundle carries the normalized SKILL.md, the preserved original,
 *     the support file and the LICENSE.
 *
 * Remediation journey (second test; evidence in `LIBRARY_REMEDIATION_EVIDENCE_PATH`).
 * Written before the fixes for the independent backend review, 2026-09-26.
 *
 * Source identity (per entry, never the shared source row)
 * R01 A transferred repository is added by another user under its new name. The first owner's
 *     scheduled check still enters identity review, creates no candidate, fetches no bytes, and
 *     discovery and preview refuse with SOURCE_IDENTITY_CHANGED. The other user's entry is unaffected.
 * R02 Identity review survives tracking off. Daily or weekly without acknowledgement is refused.
 *     An acknowledgement sent with the revision from before detection is refused as stale.
 * R03 The owner's explicit acknowledgement records the new name for that entry only (audited),
 *     tracking resumes and produces the pending candidate. A second acknowledgement with nothing
 *     pending is refused. A third user's entry for the same repository stays in review.
 *
 * Tracking and leases
 * R04 An ignored tracking candidate is not proposed again for the same bytes on later checks and
 *     costs no blob requests. New upstream bytes still create a new candidate.
 * R05 The worker claims one due track at a time: while a check runs, only its entry holds a lease.
 * R06 A check whose lease is taken over mid-check writes no candidate, event, health or last-good
 *     state and reports `lease-lost`. The retry reuses the snapshot for the same commit.
 *
 * Source order and snapshots
 * R07 After a force-push that is ahead of the entry's first snapshot but not of the imported commit,
 *     the candidate is `unverified` and imports only with a recorded acknowledgement.
 * R08 An order acknowledgement on a verified candidate is refused (ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE).
 * R09 Repeated discovery of an unchanged upstream reuses its snapshot and makes no tree request.
 * R10 A check that fails after root-change events and then succeeds emits each removal, rename and
 *     discovery event once.
 *
 * Input bounds
 * R11 A source URL with a long tree path saves with a bounded title instead of failing.
 * R12 A rename between long skill-root paths completes the check with a bounded event path and key.
 * R13 A 230-character directory name without a frontmatter name blocks the candidate as
 *     invalid-native-name. The preview does not fail and the blocked candidate holds no bytes.
 * R14 A tree entry without a reported size blocks the root before any blob is fetched.
 *
 * Provider budget
 * R15 Provider-backed source requests are limited per user. The limited request makes no provider
 *     request, other users are unaffected, and unsupported URLs are still rejected as 400.
 *
 * Lease fencing inside each write (written before the transactional fence, 2026-09-26)
 * Every takeover is a real Postgres write made after the check's final renewal, through a test-only
 * interposition on one store call. Nothing sleeps for the 120 s lease.
 * R16 Another worker claims the entry between the final renewal and the snapshot write. The check
 *     writes no snapshot, event or candidate and reports lease-lost. The winner's lease stays, and
 *     health, schedule, attempts and last good snapshot are unchanged.
 * R17 The candidate write waits on the entry row lock while another worker takes the lease and
 *     commits. No candidate and no candidate event commit. After the winner releases, one retry
 *     creates exactly one candidate with exactly one linked event, and a second retry creates neither.
 * R18 The lease is taken after the snapshot commits and before the root-change events. No event
 *     commits. The retry reuses the snapshot and emits each root-change event once.
 * R19 A winner claims and finishes the entry before the stale check's finishCheck. finishCheck
 *     returns false and the check reports failed/lease-lost. The winner's schedule, last success and
 *     last good snapshot stay. The candidate written while the stale check still held its lease has
 *     exactly one event, and a retry adds no candidate or event.
 * R20 A preview must not reuse a cached licence identifier when the live source reports none.
 *     It requires an explicit reviewed mapping, even if the saved source previously had an identifier.
 * R21 Source path validation keeps boundary-slash semantics and rejects long interior slash runs
 *     promptly before provider I/O. Written before the CodeQL ReDoS correction.
 * Evidence journals must use private directories and owner-only files, without replacing an existing file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import {
  defaultOrganizationPolicyV1,
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  architectureTargetObservationDigest,
  type ArchitectureTargetObservationInput,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import {
  FixtureGithubSource,
  LibraryService,
  LibrarySourceWorker,
  PostgresLibraryStore,
  PublicGithubSourceProvider,
} from "../src/libraries/index.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { SubmissionService } from "../src/submissions/service.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { PostgresTargetSkillOperationStore } from "../src/target-operations/postgres-store.js";
import { TargetSkillOperationService } from "../src/target-operations/service.js";
import { PostgresArchitectureTargetStore } from "../src/targets/postgres-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import type { ArchitectureTargetBindingAuthorizer } from "../src/targets/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const password = "correct horse battery staple";

const ids = {
  alice: "a11ce000-0000-4000-8000-000000000001",
  bob: "b0b00000-0000-4000-8000-000000000002",
  carol: "ca401000-0000-4000-8000-000000000003",
  dana: "da4a0000-0000-4000-8000-000000000004",
  erin: "e4140000-0000-4000-8000-000000000005",
  team: "7ea30000-0000-4000-8000-000000000006",
  architecture: "a4c40000-0000-4000-8000-000000000007",
};
const REPO = "acme/agent-skills";
const CE_PLAN_SKILL = "---\nname: ce-plan\ndescription: Plan engineering work before editing code.\n---\n\n# Plan\n\nRead references/guide.md before planning.\n";
const AGENT_SKILLS_LICENSE = "MIT License\n\nCopyright (c) 2026 Acme\n\nPermission is granted to use, copy and modify this software.\n";
const LONG_DESCRIPTION = `Summarize long threads. ${"Keep every decision, owner and date. ".repeat(20)}`.trim();

// HTTP bodies are asserted field by field; the journey intentionally treats them as untyped JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
interface Evidence { id: string; outcome: "pass"; observed: Json }

test("library first-release journey: import, self-review, curation, tracking and Updates constraint", { timeout: 180_000 }, async (t) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => { await pool.end(); });
  await resetDatabase(pool);
  await applyMigrations(pool);
  const db = createDb(pool);

  const evidence: Evidence[] = [];
  const record = (id: string, observed: Json) => { evidence.push({ id, outcome: "pass", observed }); };

  // Deterministic clock for library scheduling and expiry. Auth uses wall time.
  let nowMs = Date.parse("2026-09-26T00:00:00.000Z");
  const clock = { now: () => new Date(nowMs), advanceHours: (hours: number) => { nowMs += hours * 3_600_000; } };

  const github = new FixtureGithubSource();
  github.createRepository({
    id: 424242,
    owner: "acme",
    name: "agent-skills",
    defaultBranch: "main",
    license: "MIT",
    files: {
      "LICENSE": AGENT_SKILLS_LICENSE,
      "README.md": "# Agent skills\n",
      "skills/ce-plan/SKILL.md": CE_PLAN_SKILL,
      "skills/ce-plan/references/guide.md": "# Guide\n\nKeep plans short.\n",
      "skills/linked-helper/SKILL.md": "---\nname: linked-helper\ndescription: Uses a linked file.\n---\n\n# Linked\n",
      "skills/long-description/SKILL.md": `---\nname: long-description\ndescription: ${LONG_DESCRIPTION}\n---\n\n# Threads\n`,
      "skills/notes/SKILL.md": "---\nname: notes\ndescription: Keep concise meeting notes.\n---\n\n# Notes\n",
      "tests/fixtures/sample-skill/SKILL.md": "---\nname: sample\ndescription: Fixture only.\n---\n",
    },
    symlinks: { "skills/linked-helper/shared.md": "../ce-plan/references/guide.md" },
  });
  github.createRepository({
    id: 515151,
    owner: "acme",
    name: "whole-plugin",
    defaultBranch: "main",
    license: "MIT",
    files: {
      "LICENSE": "MIT License\n",
      ".claude-plugin/plugin.json": "{\"name\":\"whole-plugin\",\"version\":\"1.0.0\"}\n",
      "skills/runner/SKILL.md": "---\nname: runner\ndescription: Runs host hooks.\n---\n",
    },
    binaryFiles: { "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
  });
  github.createRepository({ id: 616161, owner: "acme", name: "renamed-skills", defaultBranch: "main", license: "MIT", files: { "skills/x/SKILL.md": "---\nname: x\ndescription: X.\n---\n" } });
  github.rename("acme/renamed-skills", "acme", "current-skills");

  const authStore = new PostgresAuthStore(db);
  const authService = new AuthService(authStore, {});
  const skillRepository = new PostgresSkillRepository(db);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  const architectureTargetService = new ArchitectureTargetService(new PostgresArchitectureTargetStore(db), allowAuthorizer());
  const libraryStore = new PostgresLibraryStore(db);
  const libraryService = new LibraryService({
    store: libraryStore,
    submissions: submissionService,
    skillRepository,
    targets: architectureTargetService,
    sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
    now: clock.now,
    slugSuffix: (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 10),
  });
  const targetSkillOperationService = new TargetSkillOperationService(
    new PostgresTargetSkillOperationStore(db),
    architectureTargetService,
    submissionService,
    { libraryAdoptions: libraryService },
  );
  const app = buildApp({
    skillRepository,
    authService,
    submissionService,
    architectureTargetService,
    targetSkillOperationService,
    libraryService,
    // The per-user source budget is exercised in the remediation journey (R15).
    librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1_000, windowMs: 3_600_000 }),
  });
  t.after(() => app.close());
  const workerA = new LibrarySourceWorker(libraryService, { pollMs: 60_000 });
  const workerB = new LibrarySourceWorker(libraryService, { pollMs: 60_000 });

  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token?: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
    const text = response.body;
    let body: Json = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 64) }; }
    // rawBody is the exact response bytes, for hashing served artifacts.
    return { status: response.statusCode, body, headers: response.headers, rawBody: response.rawPayload };
  };
  const expectError = (response: { status: number; body: Json }, status: number, code: string) => {
    assert.equal(response.status, status, `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
    assert.equal(response.body.error?.code, code);
  };
  const expectOk = (response: { status: number; body: Json }, status = 200) => {
    assert.equal(response.status, status, `expected ${status}, got ${response.status} ${JSON.stringify(response.body).slice(0, 600)}`);
    return response.body;
  };

  // ---- Accounts: fixed ids keep slugs and digests repeatable across runs.
  await insertUser(pool, ids.alice, "alice@example.com", ["author"]);
  await insertUser(pool, ids.bob, "bob@example.com", ["author"]);
  await insertUser(pool, ids.carol, "carol@example.com", ["maintainer"]);
  await insertUser(pool, ids.dana, "dana@example.com", ["admin"]);
  await insertUser(pool, ids.erin, "erin@example.com", ["admin"]);
  const alice = await loginWithMfa(app, "alice@example.com");
  const bob = await login(app, "bob@example.com");
  const carol = await loginWithMfa(app, "carol@example.com");
  const dana = await loginWithMfa(app, "dana@example.com");
  const erinWithoutMfa = await login(app, "erin@example.com");
  await pool.query("INSERT INTO teams (id, name, slug, created_by_user_id) VALUES ($1, 'Platform', 'platform', $2)", [ids.team, ids.alice]);
  await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')", [ids.team, ids.alice, ids.bob]);

  const capabilities = expectOk(await call("GET", "/v1/capabilities"));
  assert.equal(capabilities.capabilities.libraries, true);

  // ---- Personal library and tenant isolation.
  const personal = expectOk(await call("POST", "/v1/libraries", alice, { name: "Alice skills", owner: { type: "user" }, clientMutationId: "alice-lib-1" }), 201).library;
  assert.equal(personal.owner.type, "user");
  assert.equal(personal.access.canImport, true);
  const personalReplay = expectOk(await call("POST", "/v1/libraries", alice, { name: "Alice skills", owner: { type: "user" }, clientMutationId: "alice-lib-1" }));
  assert.equal(personalReplay.library.id, personal.id);
  assert.equal(personalReplay.replayed, true);
  expectError(await call("POST", "/v1/libraries", alice, { name: "Different", owner: { type: "user" }, clientMutationId: "alice-lib-1" }), 409, "CLIENT_MUTATION_ID_CONFLICT");
  expectError(await call("GET", `/v1/libraries/${personal.id}`, bob), 404, "LIBRARY_NOT_FOUND");
  assert.deepEqual(expectOk(await call("GET", "/v1/libraries", bob)).libraries, []);

  // F01: unsafe URLs are refused before any provider request.
  const requestsBeforeUnsafe = github.requests.length;
  const unsafeUrls = [
    "http://github.com/acme/agent-skills",
    "https://user:pass@github.com/acme/agent-skills",
    "https://github.com:8443/acme/agent-skills",
    "https://evil.example.com/acme/agent-skills",
    "https://140.82.112.3/acme/agent-skills",
    "https://github.com/acme/../agent-skills",
    "https://api.github.com/repos/acme/agent-skills",
    "https://github.com/acme/agent-skills?access_token=abc",
  ];
  for (const url of unsafeUrls) {
    expectError(await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url }), 400, "SOURCE_URL_UNSUPPORTED");
  }
  assert.equal(github.requests.length, requestsBeforeUnsafe);
  record("F01", { rejectedUrlCount: unsafeUrls.length, providerRequests: 0 });

  // F02: redirects are not followed.
  const requestsBeforeRedirect = github.requests.length;
  const redirected = await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url: "https://github.com/acme/renamed-skills" });
  expectError(redirected, 409, "SOURCE_REDIRECT_REJECTED");
  assert.equal(github.requests.length, requestsBeforeRedirect + 1);
  assert.equal(JSON.stringify(redirected.body).includes("repositories/616161"), false);
  record("F02", { status: redirected.status, code: redirected.body.error.code, requestsMade: 1 });

  // S04: whole plugin saved as a reference only.
  const versionsBeforePlugin = await countRows(pool, "skill_versions");
  const pluginEntry = expectOk(await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url: "https://github.com/acme/whole-plugin" }), 201).entry;
  assert.equal(pluginEntry.kind, "source");
  assert.equal(pluginEntry.source.repositoryId, "515151");
  assert.equal(pluginEntry.tracking.mode, "off");
  assert.equal(await countRows(pool, "skill_versions"), versionsBeforePlugin);
  assert.equal(await countRows(pool, "library_import_candidates"), 0);
  record("S04", { entryId: pluginEntry.id, submissions: 0, candidates: 0 });

  // ---- Source entry, discovery.
  const sourceEntry = expectOk(await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url: "https://github.com/acme/agent-skills", ref: { kind: "default-branch" } }), 201).entry;
  assert.equal(sourceEntry.source.repositoryId, "424242");
  assert.equal(sourceEntry.source.fullName, REPO);
  assert.equal(sourceEntry.source.license, "MIT");
  expectError(await call("POST", `/v1/libraries/${personal.id}/entries`, alice, { kind: "source", url: "https://github.com/acme/agent-skills" }), 409, "LIBRARY_ENTRY_DUPLICATE");
  expectError(await call("POST", `/v1/library-entries/${sourceEntry.id}/discoveries`, bob), 404, "LIBRARY_ENTRY_NOT_FOUND");

  const discovery = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/discoveries`, alice)).discovery;
  assert.equal(discovery.complete, true);
  assert.match(discovery.snapshot.commit, /^[0-9a-f]{40}$/);
  const roots = new Map<string, Json>(discovery.skills.map((root: Json) => [root.path, root]));
  assert.deepEqual([...roots.keys()].sort(), ["skills/ce-plan", "skills/linked-helper", "skills/long-description", "skills/notes"]);
  assert.equal(roots.get("skills/ce-plan")!.fileCount, 2);
  assert.ok(roots.get("skills/linked-helper")!.blockers.some((finding: Json) => finding.code === "unsupported-symlink"));
  assert.deepEqual(discovery.excluded.map((root: Json) => [root.path, root.excludedReason]), [["tests/fixtures/sample-skill", "default-excluded"]]);
  record("S05", { commit: discovery.snapshot.commit, roots: [...roots.keys()].sort(), excluded: discovery.excluded.length });

  // F03: provider boundary.
  for (const request of github.requests) {
    const host = new URL(request.url).host;
    assert.ok(host === "api.github.com" || host === "raw.githubusercontent.com", `unexpected host ${host}`);
    assert.equal(Object.keys(request.headers).some((header) => header.toLowerCase() === "authorization"), false);
  }
  record("F03", { requests: github.requests.length, hosts: [...new Set(github.requests.map((request) => new URL(request.url).host))].sort() });

  // ---- Preview.
  const preview = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/previews`, alice, {
    snapshotId: discovery.snapshot.id,
    paths: ["skills/ce-plan", "skills/linked-helper", "skills/long-description"],
  })).preview;
  const byPath = new Map<string, Json>(preview.candidates.map((candidate: Json) => [candidate.sourcePath, candidate]));
  const cePlan = byPath.get("skills/ce-plan")!;
  const linked = byPath.get("skills/linked-helper")!;
  const longBlocked = byPath.get("skills/long-description")!;
  assert.equal(cePlan.state, "ready-for-review");
  assert.equal(linked.state, "blocked");
  assert.equal(linked.packageDigest, null);
  assert.ok(linked.findings.some((finding: Json) => finding.code === "unsupported-symlink" && finding.severity === "blocking"));
  record("F06", { candidateId: linked.id, state: linked.state, findings: linked.findings.map((finding: Json) => finding.code) });
  assert.equal(longBlocked.state, "blocked");
  assert.ok(longBlocked.findings.some((finding: Json) => finding.code === "metadata-mapping-required"));
  const mappedPreview = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/previews`, alice, {
    snapshotId: discovery.snapshot.id,
    paths: ["skills/long-description"],
    mappings: { "skills/long-description": { summary: "Summarize long threads with decisions, owners and dates." } },
  })).preview;
  const longDescription = mappedPreview.candidates[0];
  assert.equal(longDescription.state, "ready-for-review");
  assert.ok(longDescription.mapping.transforms.some((transform: Json) => transform.kind === "reviewed-metadata-mapping"));
  record("F07", { blockedCandidate: longBlocked.id, mappedCandidate: longDescription.id, summaryLength: longDescription.mapping.summary.length });

  const cePlanFull = expectOk(await call("GET", `/v1/library-candidates/${cePlan.id}?includeContent=true`, alice)).candidate;
  const files = new Map<string, Json>(cePlanFull.files.map((file: Json) => [file.path, file]));
  const manifest = JSON.parse(files.get("skill.json")!.content);
  assert.match(manifest.name, /^ce-plan-[a-z0-9]{10}$/);
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.visibility, "private");
  assert.equal(manifest.license, "MIT");
  assert.equal(cePlanFull.mapping.nativeName, "ce-plan");
  const cePlanRuntime = CE_PLAN_SKILL.replace("name: ce-plan\n", `name: ${manifest.name}\n`);
  assert.equal(files.get("SKILL.md")!.content, cePlanRuntime);
  assert.deepEqual([files.get("SKILL.md")!.origin, files.get("SKILL.md")!.gitBlobSha], ["generated", null]);
  assert.equal(files.get("myskills-source-skill.txt")!.content, CE_PLAN_SKILL);
  assert.deepEqual([files.get("myskills-source-skill.txt")!.origin, files.get("myskills-source-skill.txt")!.sourcePath], ["upstream", "skills/ce-plan/SKILL.md"]);
  assert.equal(files.get("references/guide.md")!.content, "# Guide\n\nKeep plans short.\n");
  assert.equal(files.get("references/guide.md")!.origin, "upstream");
  assert.equal(files.get("LICENSE")!.content, AGENT_SKILLS_LICENSE);
  assert.equal(files.get("LICENSE")!.origin, "repository-notice");
  const importManifest = JSON.parse(files.get("myskills-import.json")!.content);
  assert.equal(importManifest.importer, "myskills-library-importer/2");
  assert.equal(importManifest.source.repositoryId, "424242");
  assert.equal(importManifest.source.commit, discovery.snapshot.commit);
  assert.equal(importManifest.source.path, "skills/ce-plan");
  assert.equal(importManifest.files.some((file: Json) => file.path === "SKILL.md"), false);
  const preservedEntry = importManifest.files.find((file: Json) => file.path === "myskills-source-skill.txt");
  assert.deepEqual([preservedEntry.sourcePath, preservedEntry.sha256], ["skills/ce-plan/SKILL.md", sha256(CE_PLAN_SKILL)]);
  assert.equal(importManifest.files.find((file: Json) => file.path === "references/guide.md").sha256, sha256(files.get("references/guide.md")!.content));
  const nameTransform = cePlanFull.mapping.transforms.find((transform: Json) => transform.kind === "normalize-runtime-name");
  assert.deepEqual(
    [nameTransform.path, nameTransform.originalPath, nameTransform.originalSha256, nameTransform.transformedSha256, nameTransform.originalName, nameTransform.runtimeName],
    ["SKILL.md", "myskills-source-skill.txt", sha256(CE_PLAN_SKILL), sha256(cePlanRuntime), "ce-plan", manifest.name],
  );
  assert.deepEqual(importManifest.transforms.find((transform: Json) => transform.kind === "normalize-runtime-name"), nameTransform);
  record("S08", { slug: manifest.name, version: manifest.version, files: [...files.keys()].sort(), originalSha256: nameTransform.originalSha256, transformedSha256: nameTransform.transformedSha256 });

  const canonicalPayload = { files: cePlanFull.files.map((file: Json) => ({ path: file.path, content: file.content })).sort((a: Json, b: Json) => a.path.localeCompare(b.path)) };
  const independentDigest = sha256(JSON.stringify(canonicalPayload));
  assert.equal(cePlanFull.packageDigest, independentDigest);
  record("S09", { packageDigest: independentDigest });

  // F13: another user cannot read or import the candidate.
  expectError(await call("GET", `/v1/library-candidates/${cePlan.id}`, bob), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/import`, bob, { expectedPackageDigest: cePlan.packageDigest, release: { classification: "unclassified" } }), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  record("F13", { read: 404, import: 404 });

  // F10: upstream moves after preview.
  const movedCommit = github.commit(REPO, { files: { "skills/ce-plan/SKILL.md": "---\nname: ce-plan\ndescription: Plan engineering work before editing code.\n---\n\n# Plan v2\n\nRead references/guide.md first.\n" } });
  assert.notEqual(movedCommit, discovery.snapshot.commit);

  // F11: release metadata and digest preconditions.
  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/import`, alice, { expectedPackageDigest: cePlan.packageDigest }), 400, "IMPORT_RELEASE_METADATA_REQUIRED");
  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/import`, alice, { expectedPackageDigest: "0".repeat(64), release: { classification: "unclassified" } }), 409, "PREVIEW_DIGEST_MISMATCH");
  record("F11", { missingRelease: 400, staleDigest: 409 });

  const imported = expectOk(await call("POST", `/v1/library-candidates/${cePlan.id}/import`, alice, {
    expectedPackageDigest: cePlan.packageDigest,
    release: { classification: "unclassified" },
    clientMutationId: "import-ce-plan-1",
  }), 202);
  assert.equal(imported.submission.slug, manifest.name);
  assert.equal(imported.submission.version, "0.0.1");
  assert.equal(imported.candidate.state, "accepted");
  const cePlanSlug: string = imported.submission.slug;
  const cePlanSubmissionId: string = imported.submission.id;
  const cePlanEntry = imported.entry;
  assert.equal(cePlanEntry.kind, "skill");
  assert.equal(cePlanEntry.skill.slug, cePlanSlug);
  const artifactRow = (await pool.query(
    `SELECT a.sha256, v.change_kind, v.requires_user_action, p.commit_sha, p.package_digest
       FROM skill_versions v JOIN skill_artifacts a ON a.skill_version_id = v.id
       JOIN skill_release_provenance p ON p.skill_version_id = v.id WHERE v.id = $1`, [cePlanSubmissionId])).rows[0];
  assert.equal(artifactRow.sha256, cePlan.packageDigest);
  assert.equal(artifactRow.commit_sha, discovery.snapshot.commit);
  assert.equal(artifactRow.package_digest, cePlan.packageDigest);
  record("F10", { previewCommit: discovery.snapshot.commit, upstreamHeadAtImport: movedCommit, submittedArtifact: artifactRow.sha256 });
  assert.equal(artifactRow.change_kind, "breaking");
  assert.equal(artifactRow.requires_user_action, true);
  record("F12", { changeKind: artifactRow.change_kind, requiresUserAction: artifactRow.requires_user_action });

  const versionsBeforeReplay = await countRows(pool, "skill_versions");
  const replay = expectOk(await call("POST", `/v1/library-candidates/${cePlan.id}/import`, alice, {
    expectedPackageDigest: cePlan.packageDigest,
    release: { classification: "unclassified" },
    clientMutationId: "import-ce-plan-1",
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.submission.id, cePlanSubmissionId);
  assert.equal(await countRows(pool, "skill_versions"), versionsBeforeReplay);
  record("S14", { submissionId: cePlanSubmissionId, versionsCreatedOnReplay: 0 });

  // S41 (owner half): the owner's submitted bundle is the held preview, byte for byte.
  const ownerBundle = await call("GET", `/v1/submissions/${cePlanSubmissionId}/bundle`, alice);
  assert.equal(ownerBundle.status, 200);
  const ownerBundleSha256 = sha256(ownerBundle.rawBody);
  assert.equal(ownerBundleSha256, cePlan.packageDigest);
  assert.equal(ownerBundleSha256, independentDigest);
  const ownerBundleHeader = ownerBundle.headers["x-myskills-artifact-sha256"];
  assert.ok(ownerBundleHeader === undefined || ownerBundleHeader === ownerBundleSha256, "a served hash header must match the body");
  const ownerBundleFiles = new Map<string, string>(JSON.parse(Buffer.from(ownerBundle.rawBody).toString("utf8")).files.map((file: Json) => [file.path, file.content]));
  assert.equal(ownerBundleFiles.get("SKILL.md"), cePlanRuntime);
  assert.equal(ownerBundleFiles.get("myskills-source-skill.txt"), CE_PLAN_SKILL);
  assert.equal(ownerBundleFiles.get("references/guide.md"), "# Guide\n\nKeep plans short.\n");
  assert.equal(ownerBundleFiles.get("LICENSE"), AGENT_SKILLS_LICENSE);

  // F15: ordinary submissions cannot inject provenance.
  const injected = await call("POST", "/v1/submissions", alice, {
    manifest: manifestFor("injected-skill", "1.0.0"),
    files: packageFilesFor("injected-skill", "1.0.0"),
    release: { releaseNotes: "", changeKind: "fix", requiresUserAction: false },
    provenance: { commit: "f".repeat(40) },
  });
  expectError(injected, 400, "UNSUPPORTED_SUBMISSION_FIELD");
  record("F15", { status: injected.status, code: injected.body.error.code });

  // ---- Private self-review controls.
  const selfReviewBody = { artifactSha256: cePlan.packageDigest };
  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/self-review`, alice, selfReviewBody), 403, "PRIVATE_SELF_REVIEW_DISABLED");
  assert.equal(expectOk(await call("GET", "/v1/admin/library-settings", dana)).settings.privateSelfReviewEnabled, false);
  record("F16", { defaultEnabled: false });
  expectError(await call("PUT", "/v1/admin/library-settings", alice, { privateSelfReviewEnabled: true }), 403, "ADMIN_ROLE_REQUIRED");
  expectError(await call("PUT", "/v1/admin/library-settings", erinWithoutMfa, { privateSelfReviewEnabled: true }), 403, "MFA_VERIFICATION_REQUIRED");
  record("F17", { nonAdmin: 403, adminWithoutMfa: 403 });
  const enabled = expectOk(await call("PUT", "/v1/admin/library-settings", dana, { privateSelfReviewEnabled: true, reason: "Pilot" }));
  assert.equal(enabled.settings.privateSelfReviewEnabled, true);
  const settingsAudit = await pool.query("SELECT actor_user_id FROM audit_events WHERE action = 'admin.library_settings.update' AND decision = 'allow'");
  assert.equal(settingsAudit.rows.length, 1);
  assert.equal(settingsAudit.rows[0].actor_user_id, ids.dana);
  record("S18", { enabled: true, auditActor: ids.dana });

  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/self-review`, bob, selfReviewBody), 404, "LIBRARY_CANDIDATE_NOT_FOUND");
  expectError(await call("POST", `/v1/library-candidates/${cePlan.id}/self-review`, alice, { artifactSha256: "a".repeat(64) }), 409, "ARTIFACT_HASH_MISMATCH");
  record("F19", { otherUser: 404, wrongHash: 409 });
  const selfReviewed = expectOk(await call("POST", `/v1/library-candidates/${cePlan.id}/self-review`, alice, selfReviewBody));
  assert.equal(selfReviewed.release.attestation, "private-self-reviewed");
  assert.equal(selfReviewed.release.artifactSha256, cePlan.packageDigest);
  expectOk(await call("GET", `/v1/skills/${cePlanSlug}/releases/0.0.1`, alice));
  expectError(await call("GET", `/v1/skills/${cePlanSlug}/releases/0.0.1`, bob), 404, "RELEASE_NOT_FOUND");
  const attestation = (await pool.query("SELECT kind, actor_user_id, artifact_sha256 FROM skill_version_review_attestations WHERE skill_version_id = $1", [cePlanSubmissionId])).rows;
  assert.deepEqual(attestation, [{ kind: "private-self-review", actor_user_id: ids.alice, artifact_sha256: cePlan.packageDigest }]);
  const approvals = await pool.query("SELECT action, actor_user_id FROM audit_events WHERE resource_id = $1 AND decision = 'allow' AND action IN ('review.approve', 'release.publish', 'review.private_self_review')", [cePlanSubmissionId]);
  assert.deepEqual(approvals.rows, [{ action: "review.private_self_review", actor_user_id: ids.alice }]);
  record("S20", { attestation: "private-self-review", actor: ids.alice, maintainerApprovals: 0 });

  expectError(await call("PUT", `/v1/skills/${cePlanSlug}/sharing`, alice, { visibility: "authenticated" }), 409, "SELF_REVIEWED_RELEASE_REQUIRES_INSTANCE_REVIEW");
  expectError(await call("PUT", `/v1/skills/${cePlanSlug}/sharing`, dana, { visibility: "public" }), 409, "SELF_REVIEWED_RELEASE_REQUIRES_INSTANCE_REVIEW");
  assert.equal((await pool.query("SELECT visibility FROM skills WHERE slug = $1", [cePlanSlug])).rows[0].visibility, "private");
  record("F21", { owner: 409, admin: 409, visibility: "private" });

  // Adoption in the personal library.
  expectError(await call("POST", `/v1/library-entries/${cePlanEntry.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: "b".repeat(64), expectedCurrentAdoptionId: null }), 422, "LIBRARY_RELEASE_NOT_ADOPTABLE");
  const personalAdoption = expectOk(await call("POST", `/v1/library-entries/${cePlanEntry.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: cePlan.packageDigest, expectedCurrentAdoptionId: null }), 201).adoption;
  assert.equal(personalAdoption.attestation, "private-self-reviewed");
  const resolution = expectOk(await call("GET", `/v1/library-entries/${cePlanEntry.id}/resolution`, alice)).resolution;
  assert.deepEqual([resolution.state, resolution.version, resolution.artifactSha256], ["adopted", "0.0.1", cePlan.packageDigest]);

  // F22: a self-reviewed release cannot enter a team library.
  const teamLibrary = expectOk(await call("POST", "/v1/libraries", alice, { name: "Platform picks", owner: { type: "team", id: ids.team } }), 201).library;
  assert.equal(teamLibrary.access.role, "curator");
  assert.equal(teamLibrary.access.canImport, false);
  expectError(await call("POST", `/v1/libraries/${teamLibrary.id}/entries`, alice, { kind: "skill", slug: cePlanSlug }), 422, "LIBRARY_RELEASE_NOT_AUTHORIZED");
  record("F22", { status: 422 });

  // F25: members cannot curate.
  expectError(await call("PATCH", `/v1/libraries/${teamLibrary.id}`, bob, { expectedRevision: 1, name: "Bob picks" }), 403, "LIBRARY_WRITE_FORBIDDEN");
  expectError(await call("POST", `/v1/libraries/${teamLibrary.id}/entries`, bob, { kind: "source", url: "https://github.com/acme/agent-skills" }), 403, "LIBRARY_WRITE_FORBIDDEN");
  record("F25", { patch: 403, addEntry: 403 });

  // Import long-description, then disable self-review.
  const longImport = expectOk(await call("POST", `/v1/library-candidates/${longDescription.id}/import`, alice, {
    expectedPackageDigest: longDescription.packageDigest,
    release: { changeKind: "feature", requiresUserAction: false, releaseNotes: "Reviewed initial import." },
  }), 202);
  const longSlug: string = longImport.submission.slug;
  expectOk(await call("PUT", "/v1/admin/library-settings", dana, { privateSelfReviewEnabled: false }));
  expectError(await call("POST", `/v1/library-candidates/${longDescription.id}/self-review`, alice, { artifactSha256: longDescription.packageDigest }), 403, "PRIVATE_SELF_REVIEW_DISABLED");
  expectOk(await call("GET", `/v1/skills/${cePlanSlug}/releases/0.0.1`, alice));
  record("F23", { newSelfReview: 403, existingReleaseReadable: 200 });

  // F26: a private release cannot enter the team library (instance-approved but still private).
  await reviewAndPublish(call, carol, longImport.submission.id);
  expectError(await call("POST", `/v1/libraries/${teamLibrary.id}/entries`, alice, { kind: "skill", slug: longSlug }), 422, "LIBRARY_RELEASE_NOT_AUTHORIZED");
  record("F26", { status: 422 });

  // S24: elevation with exact hash, then sharing succeeds.
  expectOk(await call("POST", `/v1/library-candidates/${cePlan.id}/instance-review-requests`, alice));
  const pending = expectOk(await call("GET", "/v1/review/self-reviewed-releases", carol)).releases;
  assert.deepEqual(pending.map((release: Json) => [release.slug, release.version]), [[cePlanSlug, "0.0.1"]]);
  const elevationBundle = await call("GET", `/v1/review/self-reviewed-releases/${cePlanSubmissionId}/bundle`, carol);
  assert.equal(elevationBundle.status, 200);
  assert.equal(elevationBundle.headers["x-myskills-artifact-sha256"], cePlan.packageDigest);
  // S41 (reviewer half): the elevation body hashes to the same digest the header claims and the candidate holds.
  const elevationBundleSha256 = sha256(elevationBundle.rawBody);
  assert.equal(elevationBundleSha256, cePlan.packageDigest);
  assert.equal(elevationBundleSha256, elevationBundle.headers["x-myskills-artifact-sha256"]);
  const heldCandidateDigest = (await pool.query("SELECT package_digest FROM library_import_candidates WHERE id = $1", [cePlan.id])).rows[0].package_digest as string;
  assert.equal(heldCandidateDigest, cePlan.packageDigest);
  record("S41", {
    candidateDigest: heldCandidateDigest,
    ownerBundleSha256,
    ownerBundleBytes: ownerBundle.rawBody.length,
    ownerBundleHeader: ownerBundleHeader ?? null,
    elevationBundleSha256,
    elevationBundleBytes: elevationBundle.rawBody.length,
    elevationBundleHeader: elevationBundle.headers["x-myskills-artifact-sha256"],
  });
  expectError(await call("POST", `/v1/review/self-reviewed-releases/${cePlanSubmissionId}/elevate`, carol, { artifactSha256: "c".repeat(64) }), 409, "ARTIFACT_HASH_MISMATCH");
  expectError(await call("POST", `/v1/review/self-reviewed-releases/${cePlanSubmissionId}/elevate`, alice, { artifactSha256: cePlan.packageDigest }), 403, "REVIEW_ROLE_REQUIRED");
  const elevated = expectOk(await call("POST", `/v1/review/self-reviewed-releases/${cePlanSubmissionId}/elevate`, carol, { artifactSha256: cePlan.packageDigest }));
  assert.equal(elevated.release.attestation, "instance-reviewed");
  expectOk(await call("PUT", `/v1/skills/${cePlanSlug}/sharing`, alice, { visibility: "team", teamIds: [ids.team] }));
  record("S24", { elevatedBy: ids.carol, sharedWithTeam: true });

  // PR #87 regressions, authored before the write-boundary and inbox fixes.
  // Revoke authority after the complete HTTP preflight, before entering adopt's
  // transaction. No sleeps: the store-call boundary is the deterministic barrier.
  for (const [index, revocation] of ["removed", "demoted", "organization-removed"].entries()) {
    await t.test(`adoption refuses ${revocation} curator after preflight`, async () => {
      const raceLibrary = expectOk(await call("POST", "/v1/libraries", alice, { name: `Race ${revocation}`, owner: { type: "team", id: ids.team } }), 201).library;
      const raceEntry = expectOk(await call("POST", `/v1/libraries/${raceLibrary.id}/entries`, alice, { kind: "skill", slug: cePlanSlug }), 201).entry;
      let organizationId: string | null = null;
      if (revocation === "organization-removed") {
        organizationId = (await pool.query("INSERT INTO organizations (name, slug, created_by_user_id) VALUES ('Race organization', 'race-organization', $1) RETURNING id", [ids.alice])).rows[0].id;
        const policy = JSON.stringify(defaultOrganizationPolicyV1);
        const revision = (await pool.query("INSERT INTO organization_policy_revisions (organization_id, revision_number, policy, policy_sha256, created_by_user_id) VALUES ($1, 1, $2, $3, $4) RETURNING id", [organizationId, policy, createHash("sha256").update(policy).digest("hex"), ids.alice])).rows[0].id;
        await pool.query("UPDATE organizations SET status = 'active', current_policy_revision_id = $2 WHERE id = $1", [organizationId, revision]);
        await pool.query("INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [organizationId, ids.alice]);
        await pool.query("UPDATE teams SET organization_id = $2 WHERE id = $1", [ids.team, organizationId]);
      }
      const originalAdopt = libraryStore.adopt.bind(libraryStore);
      let preflightPassed = false;
      libraryStore.adopt = async (input) => {
        preflightPassed = true;
        if (revocation === "removed") await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.alice]);
        if (revocation === "demoted") await pool.query("UPDATE team_memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2", [ids.team, ids.alice]);
        if (revocation === "organization-removed") await pool.query("UPDATE organization_memberships SET removed_at = now() WHERE organization_id = $1 AND user_id = $2", [organizationId, ids.alice]);
        return originalAdopt(input);
      };
      try {
        const response = await call("POST", `/v1/library-entries/${raceEntry.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: cePlan.packageDigest, expectedCurrentAdoptionId: null });
        assert.equal(preflightPassed, true);
        expectError(response, 403, "LIBRARY_WRITE_FORBIDDEN");
        const state = (await pool.query(`SELECT current_adoption_id, revision,
          (SELECT count(*)::int FROM library_adoptions WHERE entry_id = $1) AS adoptions,
          (SELECT count(*)::int FROM library_events WHERE entry_id = $1 AND kind = 'adoption-changed') AS events,
          (SELECT count(*)::int FROM audit_events WHERE resource_id = $1::uuid AND action = 'library.entry.adopt') AS audits
          FROM library_entries WHERE id = $1`, [raceEntry.id])).rows[0];
        assert.deepEqual(state, { current_adoption_id: null, revision: 1, adoptions: 0, events: 0, audits: 0 });
        record(`F${42 + index}`, { revocation, preflightPassed, status: response.status, ...state });
      } finally {
        libraryStore.adopt = originalAdopt;
        await pool.query("UPDATE teams SET organization_id = NULL WHERE id = $1", [ids.team]);
        await pool.query("INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner'", [ids.team, ids.alice]);
      }
    });
  }

  // Real HTTP pagination with timestamp ties, microseconds, read events and
  // more than one raw-event batch. Hidden newest events cannot hide history.
  for (const [index, hiddenWindow] of [false, true].entries()) {
    await t.test(`inbox traverses history with ${hiddenWindow ? "hidden" : "visible"} newest window`, async () => {
      const inboxLibrary = expectOk(await call("POST", "/v1/libraries", alice, { name: `Inbox ${hiddenWindow}`, owner: { type: "team", id: ids.team } }), 201).library;
      expectOk(await call("PUT", `/v1/libraries/${inboxLibrary.id}/subscription`, bob, { events: ["adoption-changed"] }));
      await pool.query("UPDATE library_subscriptions SET created_at = '2030-01-01T00:00:00Z' WHERE library_id = $1", [inboxLibrary.id]);
      const hiddenEntry = (await pool.query("INSERT INTO library_entries (library_id, kind, title, skill_slug, created_by_user_id) VALUES ($1, 'skill', 'Private release', $2, $3) RETURNING id", [inboxLibrary.id, longSlug, ids.alice])).rows[0].id;
      await pool.query(`INSERT INTO library_events (library_id, kind, audience, semantic_key, created_at)
        SELECT $1::uuid, 'adoption-changed', 'subscribers', $1::uuid::text || ':visible:' || i,
          '2030-01-01T00:00:01Z'::timestamptz + (i / 3) * interval '1 microsecond'
        FROM generate_series(1, 435) i`, [inboxLibrary.id]);
      await pool.query(`INSERT INTO library_inbox_reads (user_id, event_id)
        SELECT $1, id FROM library_events WHERE library_id = $2 ORDER BY created_at DESC, id DESC LIMIT 35`, [ids.bob, inboxLibrary.id]);
      if (hiddenWindow) {
        await pool.query(`INSERT INTO library_events (library_id, entry_id, kind, audience, semantic_key, created_at)
          SELECT $1::uuid, CASE WHEN i % 3 = 0 THEN $2::uuid ELSE NULL END,
            CASE WHEN i % 3 = 2 THEN 'source-health-changed' ELSE 'adoption-changed' END,
            CASE WHEN i % 3 = 1 THEN 'curators' ELSE 'subscribers' END,
            $1::uuid::text || ':hidden:' || i, '2030-01-01T00:00:02Z'::timestamptz + i * interval '1 microsecond'
          FROM generate_series(1, 660) i`, [inboxLibrary.id, hiddenEntry]);
      }
      await pool.query(`INSERT INTO library_events (library_id, kind, audience, semantic_key, created_at)
        VALUES ($1::uuid, 'adoption-changed', 'subscribers', $1::uuid::text || ':before-subscription', '2029-12-31T23:59:59Z')`, [inboxLibrary.id]);
      const expectedRows = (await pool.query("SELECT id FROM library_events WHERE library_id = $1 AND semantic_key LIKE '%:visible:%' ORDER BY created_at DESC, id DESC", [inboxLibrary.id])).rows;
      try {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = expectOk(await call("GET", `/v1/library-inbox?limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, bob));
          assert.equal(page.unreadCount, 400, "unread count includes all visible history, independent of cursor");
          assert.ok(page.items.length > 0 && page.items.length <= 37);
          assert.equal(page.items.every((item: Json) => item.libraryId === inboxLibrary.id), true);
          seen.push(...page.items.map((item: Json) => item.id));
          cursor = page.nextCursor;
          assert.ok(++pages <= 12, "pagination must terminate without repeating a batch");
        } while (cursor);
        assert.deepEqual(seen, expectedRows.map((row) => row.id));
        const unread = expectOk(await call("GET", "/v1/library-inbox?unread=true&limit=37", bob));
        assert.equal(unread.unreadCount, 400);
        assert.deepEqual(unread.items.map((item: Json) => item.id), seen.slice(35, 72));
        expectOk(await call("POST", "/v1/library-inbox/read", bob, { eventIds: [unread.items[0].id] }));
        assert.equal(expectOk(await call("GET", "/v1/library-inbox?unread=true&limit=37", bob)).unreadCount, 399);
        record(`S${45 + index}`, { hiddenWindow, hiddenEvents: hiddenWindow ? 660 : 0, visibleEvents: seen.length, unreadCount: 400, pages, afterMarkRead: 399 });
      } finally {
        expectOk(await call("DELETE", `/v1/libraries/${inboxLibrary.id}/subscription`, bob));
      }
    });
  }

  // ---- Team library curation.
  const teamCePlan = expectOk(await call("POST", `/v1/libraries/${teamLibrary.id}/entries`, alice, { kind: "skill", slug: cePlanSlug }), 201).entry;
  assert.equal(teamCePlan.skill.ownership.isCaller, true);
  const teamAdoption = expectOk(await call("POST", `/v1/library-entries/${teamCePlan.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: cePlan.packageDigest, expectedCurrentAdoptionId: null }), 201).adoption;
  assert.equal(teamAdoption.attestation, "instance-reviewed");
  expectError(await call("POST", `/v1/library-entries/${teamCePlan.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: cePlan.packageDigest, expectedCurrentAdoptionId: null }), 409, "LIBRARY_ADOPTION_CONFLICT");
  expectOk(await call("PUT", `/v1/libraries/${teamLibrary.id}/subscription`, bob, {}));
  const bobTeamView = expectOk(await call("GET", `/v1/libraries/${teamLibrary.id}/entries`, bob)).entries;
  assert.deepEqual(bobTeamView.map((entry: Json) => entry.id), [teamCePlan.id]);
  assert.equal(bobTeamView[0].skill.ownership.isCaller, false);

  // F29: token scopes.
  const readToken = expectOk(await call("POST", "/v1/auth/api-tokens", bob, { name: "library reader", scopes: ["libraries:read", "skills:read"] }), 201).token.token as string;
  expectError(await call("POST", "/v1/libraries", readToken, { name: "Nope", owner: { type: "user" } }), 403, "API_TOKEN_SCOPE_REQUIRED");
  const tokenResolution = expectOk(await call("GET", `/v1/library-entries/${teamCePlan.id}/resolution`, readToken)).resolution;
  assert.deepEqual([tokenResolution.state, tokenResolution.version], ["adopted", "0.0.1"]);
  record("F29", { write: 403, resolution: tokenResolution.state });

  // F27: an entry whose release becomes unreadable disappears for the member.
  const notesPreview = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/previews`, alice, { snapshotId: discovery.snapshot.id, paths: ["skills/notes"] })).preview.candidates[0];
  const notesImport = expectOk(await call("POST", `/v1/library-candidates/${notesPreview.id}/import`, alice, { expectedPackageDigest: notesPreview.packageDigest, release: { classification: "unclassified" } }), 202);
  await reviewAndPublish(call, carol, notesImport.submission.id);
  const notesSlug: string = notesImport.submission.slug;
  expectOk(await call("PUT", `/v1/skills/${notesSlug}/sharing`, alice, { visibility: "team", teamIds: [ids.team] }));
  const teamNotes = expectOk(await call("POST", `/v1/libraries/${teamLibrary.id}/entries`, alice, { kind: "skill", slug: notesSlug }), 201).entry;
  expectOk(await call("POST", `/v1/library-entries/${teamNotes.id}/adoptions`, alice, { version: "0.0.1", artifactSha256: notesPreview.packageDigest, expectedCurrentAdoptionId: null }), 201);
  const bobInboxBefore = expectOk(await call("GET", "/v1/library-inbox", bob));
  assert.ok(bobInboxBefore.items.some((item: Json) => item.entryId === teamNotes.id && item.kind === "adoption-changed"));
  expectOk(await call("PUT", `/v1/skills/${notesSlug}/sharing`, alice, { visibility: "private" }));
  const bobAfterUnshare = expectOk(await call("GET", `/v1/libraries/${teamLibrary.id}/entries`, bob)).entries;
  assert.deepEqual(bobAfterUnshare.map((entry: Json) => entry.id), [teamCePlan.id]);
  expectError(await call("GET", `/v1/library-entries/${teamNotes.id}`, bob), 404, "LIBRARY_ENTRY_NOT_FOUND");
  const bobInboxAfter = expectOk(await call("GET", "/v1/library-inbox", bob));
  assert.equal(bobInboxAfter.items.some((item: Json) => item.entryId === teamNotes.id), false);
  assert.equal(JSON.stringify(bobInboxAfter).includes(notesSlug), false);
  record("F27", { memberEntries: bobAfterUnshare.length, inboxLeak: false });

  // ---- Tracking (1B).
  expectOk(await call("PUT", `/v1/libraries/${personal.id}/subscription`, alice, {}));
  const sourceNow = expectOk(await call("GET", `/v1/library-entries/${sourceEntry.id}`, alice)).entry;
  const tracked = expectOk(await call("PATCH", `/v1/library-entries/${sourceEntry.id}/tracking`, alice, { expectedRevision: sourceNow.revision, mode: "daily" })).entry;
  assert.equal(tracked.tracking.mode, "daily");
  assert.equal(tracked.tracking.nextCheckAt, new Date(nowMs + 24 * 3_600_000).toISOString());

  const firstCheck = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/checks`, alice)).check;
  assert.equal(firstCheck.outcome, "changed");
  assert.equal(firstCheck.snapshot.commit, movedCommit);
  assert.equal(firstCheck.candidateIds.length, 1);
  const trackedCandidate = expectOk(await call("GET", `/v1/library-candidates/${firstCheck.candidateIds[0]}`, alice)).candidate;
  assert.equal(trackedCandidate.lineage.slug, cePlanSlug);
  assert.equal(trackedCandidate.expectedVersion, "0.0.2");
  assert.deepEqual(trackedCandidate.changes.changed, ["SKILL.md"]);
  const aliceInbox1 = expectOk(await call("GET", "/v1/library-inbox?unread=true", alice));
  assert.equal(aliceInbox1.items.filter((item: Json) => item.kind === "candidate-ready").length, 1);
  record("S30", { candidateId: trackedCandidate.id, expectedVersion: "0.0.2", inboxItems: 1 });

  github.commit(REPO, { files: { "README.md": "# Agent skills\n\nUpdated readme.\n" } });
  clock.advanceHours(25);
  await workerA.runOnce();
  const afterUnrelated = expectOk(await call("GET", `/v1/library-entries/${sourceEntry.id}/candidates?state=ready-for-review`, alice)).candidates;
  assert.equal(afterUnrelated.length, 1);
  const snapshotsAfterUnrelated = await countRows(pool, "library_source_snapshots");
  clock.advanceHours(25);
  await workerA.runOnce();
  assert.equal(await countRows(pool, "library_source_snapshots"), snapshotsAfterUnrelated);
  const aliceInbox2 = expectOk(await call("GET", "/v1/library-inbox?unread=true", alice));
  assert.equal(aliceInbox2.unreadCount, aliceInbox1.unreadCount);
  record("S31", { candidatesAfterUnrelated: 1, snapshotsAfterUnchanged: snapshotsAfterUnrelated });

  // F32/S33: support-file change, new skill and removed skill in one commit.
  const supportCommit = github.commit(REPO, {
    files: {
      "skills/ce-plan/references/guide.md": "# Guide\n\nKeep plans short and dated.\n",
      "skills/new-helper/SKILL.md": "---\nname: new-helper\ndescription: New helper.\n---\n",
      "skills/long-description/SKILL.md": null,
    },
  });
  const secondCheck = expectOk(await call("POST", `/v1/library-entries/${sourceEntry.id}/checks`, alice)).check;
  assert.equal(secondCheck.snapshot.commit, supportCommit);
  assert.equal(secondCheck.candidateIds.length, 1);
  const newerCandidate = expectOk(await call("GET", `/v1/library-candidates/${secondCheck.candidateIds[0]}`, alice)).candidate;
  assert.deepEqual([...newerCandidate.changes.changed].sort(), ["SKILL.md", "references/guide.md"]);
  const olderCandidate = expectOk(await call("GET", `/v1/library-candidates/${trackedCandidate.id}`, alice)).candidate;
  assert.equal(olderCandidate.state, "superseded");
  expectError(await call("POST", `/v1/library-candidates/${trackedCandidate.id}/import`, alice, { expectedPackageDigest: trackedCandidate.packageDigest, release: { classification: "unclassified" } }), 409, "CANDIDATE_SUPERSEDED");
  record("F32", { superseded: trackedCandidate.id, current: newerCandidate.id });
  const aliceKinds = expectOk(await call("GET", "/v1/library-inbox", alice)).items.map((item: Json) => item.kind);
  assert.ok(aliceKinds.includes("new-skill-discovered"));
  assert.ok(aliceKinds.includes("skill-removed"));
  expectOk(await call("GET", `/v1/skills/${longSlug}/releases/0.0.1`, alice));
  record("S33", { events: [...new Set(aliceKinds)].sort() });

  const cePlanV2 = expectOk(await call("POST", `/v1/library-candidates/${newerCandidate.id}/import`, alice, {
    expectedPackageDigest: newerCandidate.packageDigest,
    release: { changeKind: "fix", requiresUserAction: false, releaseNotes: "Reviewed: guide and plan wording." },
  }), 202);
  assert.equal(cePlanV2.submission.version, "0.0.2");
  await reviewAndPublish(call, carol, cePlanV2.submission.id);

  // F34: rate limit keeps honest stale state.
  const beforeLimit = expectOk(await call("GET", `/v1/library-entries/${sourceEntry.id}`, alice)).entry.tracking;
  const resetEpoch = Math.floor((nowMs + 50 * 3_600_000) / 1000);
  github.failNext(/api\.github\.com\/repositories\/424242$/, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpoch) } });
  clock.advanceHours(25);
  await workerA.runOnce();
  const limited = expectOk(await call("GET", `/v1/library-entries/${sourceEntry.id}`, alice)).entry.tracking;
  assert.equal(limited.health, "rate-limited");
  assert.equal(limited.lastSuccessfulCheckAt, beforeLimit.lastSuccessfulCheckAt);
  assert.ok(Date.parse(limited.nextCheckAt) >= resetEpoch * 1000);
  const inboxAfterLimit = expectOk(await call("GET", "/v1/library-inbox", alice)).items.filter((item: Json) => item.kind === "source-health-changed");
  assert.equal(inboxAfterLimit.length, 1);
  clock.advanceHours(1);
  await workerA.runOnce();
  assert.equal(expectOk(await call("GET", "/v1/library-inbox", alice)).items.filter((item: Json) => item.kind === "source-health-changed").length, 1);
  record("F34", { health: limited.health, nextCheckAt: limited.nextCheckAt, alerts: 1 });

  // F35: concurrent workers.
  github.commit(REPO, { files: { "skills/ce-plan/references/guide.md": "# Guide\n\nKeep plans short, dated and owned.\n" } });
  clock.advanceHours(60);
  const snapshotsBeforeRace = await countRows(pool, "library_source_snapshots");
  const candidatesBeforeRace = await countRows(pool, "library_import_candidates");
  await Promise.all([workerA.runOnce(), workerB.runOnce()]);
  assert.equal(await countRows(pool, "library_source_snapshots"), snapshotsBeforeRace + 1);
  assert.equal(await countRows(pool, "library_import_candidates"), candidatesBeforeRace + 1);
  const recovered = expectOk(await call("GET", `/v1/library-entries/${sourceEntry.id}`, alice)).entry.tracking;
  assert.equal(recovered.health, "healthy");
  record("F35", { snapshotsCreated: 1, candidatesCreated: 1 });

  // ---- Adoption constraint on connected Updates.
  const target = await registerCompanionTarget(pool, architectureTargetService, ids.alice, cePlanSlug, "0.0.1", cePlan.packageDigest);
  const unbound = expectOk(await call("GET", `/v1/architecture-targets/${target.id}/updates`, alice)).items.find((item: Json) => item.slug === cePlanSlug);
  assert.equal(unbound.evaluation.status, "update-available");
  assert.equal(unbound.evaluation.candidate.version, "0.0.2");
  // Entry authorization comes first: an outsider gets the generic 404 whatever their MFA state.
  expectError(await call("POST", `/v1/library-entries/${cePlanEntry.id}/bindings`, bob, { targetId: target.id }), 404, "LIBRARY_ENTRY_NOT_FOUND");
  // MFA is still required once the entry is readable: Bob is a team member without an MFA session.
  expectError(await call("POST", `/v1/library-entries/${teamCePlan.id}/bindings`, bob, { targetId: target.id }), 403, "MFA_VERIFICATION_REQUIRED");
  const binding =expectOk(await call("POST", `/v1/library-entries/${cePlanEntry.id}/bindings`, alice, { targetId: target.id }), 201).binding;
  const bound = expectOk(await call("GET", `/v1/architecture-targets/${target.id}/updates`, alice)).items.find((item: Json) => item.slug === cePlanSlug);
  assert.equal(bound.evaluation.status, "pinned");
  assert.equal(bound.library.state, "adopted");
  assert.deepEqual(bound.library.adoptedVersions, ["0.0.1"]);
  expectError(await call("POST", `/v1/architecture-targets/${target.id}/operations`, alice, { action: "update", slug: cePlanSlug, version: "0.0.2", idempotencyKey: "lib-update-1" }), 409, "TARGET_OPERATION_LIBRARY_ADOPTION_MISMATCH");
  record("F36", { unboundStatus: unbound.evaluation.status, boundStatus: bound.evaluation.status, schedule: 409, bindingOutsider: 404, bindingMemberWithoutMfa: 403 });

  const teamBinding = expectOk(await call("POST", `/v1/library-entries/${teamCePlan.id}/bindings`, alice, { targetId: target.id }), 201).binding;
  const v2Digest = (await pool.query("SELECT a.sha256 FROM skill_artifacts a WHERE a.skill_version_id = $1", [cePlanV2.submission.id])).rows[0].sha256 as string;
  expectOk(await call("POST", `/v1/library-entries/${cePlanEntry.id}/adoptions`, alice, { version: "0.0.2", artifactSha256: v2Digest, expectedCurrentAdoptionId: personalAdoption.id }), 201);
  const conflicted = expectOk(await call("GET", `/v1/architecture-targets/${target.id}/updates`, alice)).items.find((item: Json) => item.slug === cePlanSlug);
  assert.equal(conflicted.library.state, "binding-version-conflict");
  assert.ok(conflicted.evaluation.blockers.includes("policy-pin-conflict"));
  expectError(await call("POST", `/v1/architecture-targets/${target.id}/operations`, alice, { action: "update", slug: cePlanSlug, version: "0.0.2", idempotencyKey: "lib-update-2" }), 409, "BINDING_VERSION_CONFLICT");
  expectOk(await call("DELETE", `/v1/library-bindings/${teamBinding.id}`, alice));
  const resolved = expectOk(await call("GET", `/v1/architecture-targets/${target.id}/updates`, alice)).items.find((item: Json) => item.slug === cePlanSlug);
  assert.equal(resolved.evaluation.status, "update-available");
  assert.equal(resolved.evaluation.candidate.version, "0.0.2");
  record("F37", { conflict: conflicted.library.state, afterDetach: resolved.evaluation.status });

  // F38: entry removal keeps the pin and ends resolution.
  const removed = expectOk(await call("DELETE", `/v1/library-entries/${cePlanEntry.id}`, alice));
  assert.equal(removed.effects.bindingsMarkedCurationUnavailable, 1);
  const pinned = expectOk(await call("GET", `/v1/architecture-targets/${target.id}/updates`, alice)).items.find((item: Json) => item.slug === cePlanSlug);
  assert.equal(pinned.library.state, "curation-unavailable");
  assert.equal(pinned.evaluation.candidate?.version ?? pinned.evaluation.installedVersion, "0.0.2");
  expectError(await call("GET", `/v1/library-entries/${cePlanEntry.id}/resolution`, alice), 404, "LIBRARY_ENTRY_NOT_FOUND");
  const bindingAfter = expectOk(await call("GET", `/v1/library-entries/${teamCePlan.id}/bindings`, alice)).bindings;
  assert.equal(bindingAfter.every((item: Json) => item.status === "detached"), true);
  assert.equal(binding.status, "active");
  record("F38", { bindingState: "curation-unavailable", pinnedVersion: "0.0.2", resolution: 404 });

  // F28: removed member loses access and inbox items.
  await pool.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [ids.team, ids.bob]);
  expectError(await call("GET", `/v1/libraries/${teamLibrary.id}`, bob), 404, "LIBRARY_NOT_FOUND");
  const bobInboxRemoved = expectOk(await call("GET", "/v1/library-inbox", bob));
  assert.equal(bobInboxRemoved.items.length, 0);
  assert.equal(bobInboxRemoved.unreadCount, 0);
  expectError(await call("GET", `/v1/library-entries/${teamCePlan.id}/resolution`, readToken), 404, "LIBRARY_ENTRY_NOT_FOUND");
  record("F28", { library: 404, inboxItems: 0 });

  // S39: delete the personal library.
  const deleted = expectOk(await call("DELETE", `/v1/libraries/${personal.id}?expectedRevision=${personal.revision}`, alice));
  assert.equal(deleted.library.status, "deleted");
  expectError(await call("GET", `/v1/libraries/${personal.id}`, alice), 404, "LIBRARY_NOT_FOUND");
  expectOk(await call("GET", `/v1/skills/${cePlanSlug}/releases/0.0.2`, alice));
  record("S39", { effects: deleted.effects });

  // F40: orphaned slug.
  await pool.query("INSERT INTO skills (slug, title, summary, lifecycle_status, visibility, owner_user_id) VALUES ('legacy-orphan', 'Legacy', 'Legacy skill.', 'approved', 'private', NULL)");
  const takeover = await call("POST", "/v1/submissions", alice, {
    manifest: manifestFor("legacy-orphan", "9.0.0"),
    files: packageFilesFor("legacy-orphan", "9.0.0"),
    release: { releaseNotes: "", changeKind: "fix", requiresUserAction: false },
  });
  expectError(takeover, 409, "PACKAGE_SLUG_UNAVAILABLE");
  assert.equal((await pool.query("SELECT owner_user_id FROM skills WHERE slug = 'legacy-orphan'")).rows[0].owner_user_id, null);
  record("F40", { status: takeover.status, ownerStillNull: true });

  const evidenceTarget = process.env.LIBRARY_JOURNEY_EVIDENCE_PATH;
  const evidenceDirectory = mkdtempSync(join(evidenceTarget ? dirname(evidenceTarget) : tmpdir(), "myskills-library-journey-"));
  const evidencePath = join(evidenceDirectory, evidenceTarget ? basename(evidenceTarget) : "myskills-library-journey-evidence.json");
  const expected = ["F01", "F02", "F03", "S04", "S05", "F06", "F07", "S08", "S09", "F10", "F11", "F12", "F13", "S14", "F15", "F16", "F17", "S18", "F19", "S20", "F21", "F22", "F23", "S24", "F25", "F26", "F27", "F28", "F29", "S30", "S31", "F32", "S33", "F34", "F35", "F36", "F37", "F38", "S39", "F40", "S41", "F42", "F43", "F44", "S45", "S46"];
  assert.deepEqual([...new Set(evidence.map((item) => item.id))].sort(), [...expected].sort());
  writeFileSync(evidencePath, `${JSON.stringify({ schemaVersion: 1, journey: "library-first-release", scenarios: evidence }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  assert.equal(statSync(dirname(evidencePath)).mode & 0o777, 0o700);
  assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
  assert.throws(() => writeFileSync(evidencePath, "must not replace evidence", { flag: "wx", mode: 0o600 }), { code: "EEXIST" });
  t.diagnostic(`library journey evidence: ${evidencePath}`);
});

test("library remediation journey: per-entry identity, tracking dedup, leases, source order, events, bounds and quota", { timeout: 180_000 }, async (t) => {
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required.");
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(async () => { await pool.end(); });
  await resetDatabase(pool);
  await applyMigrations(pool);
  const db = createDb(pool);

  const evidence: Evidence[] = [];
  const record = (id: string, observed: Json) => { evidence.push({ id, outcome: "pass", observed }); };
  let nowMs = Date.parse("2026-10-01T00:00:00.000Z");
  const clock = { now: () => new Date(nowMs), advanceHours: (hours: number) => { nowMs += hours * 3_600_000; } };

  const TRANSFER = "acme/transfer-skills";
  const MOVED = "mallory/transfer-skills";
  const ORDER = "acme/order-skills";
  const CHURN = "acme/churn-skills";
  const BOUNDS = "acme/bounds-skills";
  const FENCE = "acme/fence-skills";
  const MIT ="MIT License\n\nPermission is granted to use, copy and modify this software.\n";
  const LONG_ROOT_BASE = `skills/${"r".repeat(250)}/${"s".repeat(250)}`;
  const LONG_ROOT_FROM = `${LONG_ROOT_BASE}/from-root`;
  const LONG_ROOT_TO = `${LONG_ROOT_BASE}/to-root`;
  const LONG_ROOT_SKILL = skillMd("long-root", "Deep path skill.", "# Deep");
  const LONG_DIR = "n".repeat(230);
  const EPS_SKILL = skillMd("eps", "Eps helper.", "# Eps\n\nSee notes.md.");
  const EPS_NOTES = "# Notes\n";

  const github = new FixtureGithubSource();
  github.createRepository({ id: 700001, owner: "acme", name: "transfer-skills", files: { LICENSE: MIT, "skills/alpha/SKILL.md": skillMd("alpha", "Alpha helper.", "# Alpha") } });
  github.createRepository({ id: 700002, owner: "acme", name: "order-skills", files: { LICENSE: MIT, "skills/beta/SKILL.md": skillMd("beta", "Beta helper.", "# Beta v1") } });
  github.createRepository({
    id: 700003,
    owner: "acme",
    name: "churn-skills",
    files: {
      LICENSE: MIT,
      "skills/gamma/SKILL.md": skillMd("gamma", "Gamma helper.", "# Gamma v1"),
      "skills/delta/SKILL.md": skillMd("delta", "Delta helper.", "# Delta"),
      "skills/eps/SKILL.md": EPS_SKILL,
      "skills/eps/notes.md": EPS_NOTES,
    },
  });
  github.createRepository({
    id: 700004,
    owner: "acme",
    name: "bounds-skills",
    files: {
      LICENSE: MIT,
      [`${LONG_ROOT_FROM}/SKILL.md`]: LONG_ROOT_SKILL,
      [`skills/${LONG_DIR}/SKILL.md`]: "---\ndescription: Directory-named skill.\n---\n\n# Directory\n",
      "skills/sizeless/SKILL.md": skillMd("sizeless", "Size check.", "# Size\n\nRead guide.md."),
      "skills/sizeless/guide.md": "# Guide\n",
    },
  });
  github.hideTreeSizes(BOUNDS, ["skills/sizeless/guide.md"]);
  github.createRepository({
    id: 700005,
    owner: "acme",
    name: "fence-skills",
    files: { LICENSE: MIT, "skills/zeta/SKILL.md": skillMd("zeta", "Zeta helper.", "# Zeta v1"), "skills/eta/SKILL.md": skillMd("eta", "Eta helper.", "# Eta") },
  });

  const authService = new AuthService(new PostgresAuthStore(db), {});
  const skillRepository = new PostgresSkillRepository(db);
  const submissionService = new SubmissionService(new PostgresSubmissionStore(db));
  // Kept so R16–R19 can interpose on one store call and claim leases through the production path.
  const libraryStore = new PostgresLibraryStore(db);
  const libraryService = new LibraryService({
    store: libraryStore,
    submissions: submissionService,
    skillRepository,
    sourceProvider: new PublicGithubSourceProvider({ transport: github.transport() }),
    now: clock.now,
    slugSuffix: (seed: string) => createHash("sha256").update(seed).digest("hex").slice(0, 10),
  });
  const app = buildApp({ skillRepository, authService, submissionService, libraryService, librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1_000, windowMs: 3_600_000 }) });
  t.after(() => app.close());
  const quotaApp = buildApp({ skillRepository, authService, submissionService, libraryService, librarySourceLimiter: new MemoryAuthRateLimiter({ maxAttempts: 2, windowMs: 3_600_000 }) });
  t.after(() => quotaApp.close());
  const worker = new LibrarySourceWorker(libraryService, { pollMs: 60_000 });
  const { call, expectError, expectOk } = jsonClient(app);

  const users = {
    alice: "a11ce000-0000-4000-8000-0000000000a1",
    bob: "b0b00000-0000-4000-8000-0000000000b2",
    erin: "e4140000-0000-4000-8000-0000000000e5",
  };
  await insertUser(pool, users.alice, "alice@example.com", ["author"]);
  await insertUser(pool, users.bob, "bob@example.com", ["author"]);
  await insertUser(pool, users.erin, "erin@example.com", ["author"]);
  const alice = await login(app, "alice@example.com");
  const bob = await login(app, "bob@example.com");
  const erin = await login(app, "erin@example.com");

  const newLibrary = async (token: string, name: string) => expectOk(await call("POST", "/v1/libraries", token, { name, owner: { type: "user" } }), 201).library;
  const addSource = async (token: string, libraryId: string, url: string) => expectOk(await call("POST", `/v1/libraries/${libraryId}/entries`, token, { kind: "source", url }), 201).entry;
  const entryOf = async (token: string, entryId: string) => expectOk(await call("GET", `/v1/library-entries/${entryId}`, token)).entry;
  const setTracking = (token: string, entryId: string, body: Json) => call("PATCH", `/v1/library-entries/${entryId}/tracking`, token, body);
  const discover = async (token: string, entryId: string) => expectOk(await call("POST", `/v1/library-entries/${entryId}/discoveries`, token)).discovery;
  const previewOne = async (token: string, entryId: string, snapshotId: string, path: string) => (
    expectOk(await call("POST", `/v1/library-entries/${entryId}/previews`, token, { snapshotId, paths: [path] })).preview.candidates[0]
  );
  const importCandidate = (token: string, candidate: Json, extra: Json = {}) => call("POST", `/v1/library-candidates/${candidate.id}/import`, token, {
    expectedPackageDigest: candidate.packageDigest,
    release: { classification: "unclassified" },
    ...extra,
  });
  const checkNow = async (token: string, entryId: string) => expectOk(await call("POST", `/v1/library-entries/${entryId}/checks`, token)).check;
  const count = async (query: string, params: unknown[]) => Number((await pool.query(query, params)).rows[0].count);
  const rawRequests = (fragment: string) => github.requests.filter((request) => request.url.startsWith("https://raw.githubusercontent.com/") && request.url.includes(fragment)).length;
  const treeRequests = () => github.requests.filter((request) => request.url.includes("/git/trees/")).length;
  const snapshotsFor = (entryId: string) => count("SELECT count(*) FROM library_source_snapshots WHERE entry_id = $1", [entryId]);
  const eventsFor = (entryId: string, kind: string) => count("SELECT count(*) FROM library_events WHERE entry_id = $1 AND kind = $2", [entryId, kind]);

  const aliceLibrary = await newLibrary(alice, "Alice remediation");
  const bobLibrary = await newLibrary(bob, "Bob remediation");
  const erinLibrary = await newLibrary(erin, "Erin remediation");

  // ---- R01: another user's save of the transferred name cannot clear Alice's identity review.
  const aliceTransfer = await addSource(alice, aliceLibrary.id, `https://github.com/${TRANSFER}`);
  const erinTransfer = await addSource(erin, erinLibrary.id, `https://github.com/${TRANSFER}`);
  const transferDiscovery = await discover(alice, aliceTransfer.id);
  const alphaV1 = await previewOne(alice, aliceTransfer.id, transferDiscovery.snapshot.id, "skills/alpha");
  assert.deepEqual([alphaV1.state, alphaV1.orderStatus], ["ready-for-review", "initial"]);
  expectOk(await importCandidate(alice, alphaV1), 202);
  const aliceTracked = expectOk(await setTracking(alice, aliceTransfer.id, { expectedRevision: (await entryOf(alice, aliceTransfer.id)).revision, mode: "daily" })).entry;
  expectOk(await setTracking(erin, erinTransfer.id, { expectedRevision: erinTransfer.revision, mode: "daily" }));

  github.rename(TRANSFER, "mallory", "transfer-skills");
  const transferredCommit = github.commit(MOVED, { files: { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha helper.", "# Alpha v2 from the new owner") } });
  const bobTransfer = await addSource(bob, bobLibrary.id, `https://github.com/${MOVED}`);
  assert.equal(bobTransfer.source.fullName, MOVED);
  expectError(await call("POST", `/v1/libraries/${bobLibrary.id}/entries`, bob, { kind: "source", url: `https://github.com/${TRANSFER}` }), 409, "SOURCE_REDIRECT_REJECTED");

  const rawBeforeIdentity = rawRequests("/transfer-skills/");
  const aliceCandidatesBeforeIdentity = await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1", [aliceTransfer.id]);
  clock.advanceHours(25);
  assert.equal(await worker.runOnce(), 2);
  const aliceReview = await entryOf(alice, aliceTransfer.id);
  assert.equal(aliceReview.tracking.health, "identity-change-review");
  assert.deepEqual(aliceReview.tracking.identityChange, { acknowledgedFullName: TRANSFER, observedFullName: MOVED, observedUrl: `https://github.com/${MOVED}` });
  assert.equal(aliceReview.source.fullName, TRANSFER);
  assert.equal(rawRequests("/transfer-skills/"), rawBeforeIdentity);
  assert.equal(await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1", [aliceTransfer.id]), aliceCandidatesBeforeIdentity);
  assert.equal(await eventsFor(aliceTransfer.id, "candidate-ready"), 0);
  assert.equal(await eventsFor(aliceTransfer.id, "source-health-changed"), 1);
  expectError(await call("POST", `/v1/library-entries/${aliceTransfer.id}/discoveries`, alice), 409, "SOURCE_IDENTITY_CHANGED");
  expectError(await call("POST", `/v1/library-entries/${aliceTransfer.id}/previews`, alice, { snapshotId: transferDiscovery.snapshot.id, paths: ["skills/alpha"] }), 409, "SOURCE_IDENTITY_CHANGED");
  const repeatedIdentityCheck = await checkNow(alice, aliceTransfer.id);
  assert.deepEqual([repeatedIdentityCheck.outcome, repeatedIdentityCheck.errorCode, repeatedIdentityCheck.eventKinds], ["failed", "source-identity-changed", []]);
  assert.equal(await eventsFor(aliceTransfer.id, "source-health-changed"), 1);
  const bobView = await entryOf(bob, bobTransfer.id);
  assert.deepEqual([bobView.source.fullName, bobView.tracking.identityChange], [MOVED, null]);
  record("R01", { health: aliceReview.tracking.health, observed: MOVED, candidatesCreated: 0, rawRequests: 0, discover: 409, preview: 409, alerts: 1 });

  // ---- R02: the review is durable across tracking off and cannot be acknowledged from a stale view.
  const detectedRevision = aliceReview.revision;
  assert.equal(detectedRevision, aliceTracked.revision + 1);
  expectError(await setTracking(alice, aliceTransfer.id, { expectedRevision: aliceTracked.revision, mode: "daily", acknowledgeIdentityChange: true }), 409, "LIBRARY_REVISION_CONFLICT");
  const paused = expectOk(await setTracking(alice, aliceTransfer.id, { expectedRevision: detectedRevision, mode: "off" })).entry;
  assert.deepEqual([paused.tracking.mode, paused.tracking.health, paused.tracking.identityChange?.observedFullName], ["off", "identity-change-review", MOVED]);
  expectError(await setTracking(alice, aliceTransfer.id, { expectedRevision: paused.revision, mode: "daily" }), 409, "SOURCE_IDENTITY_CHANGED");
  expectError(await setTracking(alice, aliceTransfer.id, { expectedRevision: paused.revision, mode: "weekly" }), 409, "SOURCE_IDENTITY_CHANGED");
  expectError(await call("POST", `/v1/library-entries/${aliceTransfer.id}/discoveries`, alice), 409, "SOURCE_IDENTITY_CHANGED");
  record("R02", { staleAcknowledgement: 409, offHealth: paused.tracking.health, resumeWithoutAcknowledgement: 409 });

  // ---- R03: explicit acknowledgement is per entry.
  const acknowledged = expectOk(await setTracking(alice, aliceTransfer.id, { expectedRevision: paused.revision, mode: "daily", acknowledgeIdentityChange: true })).entry;
  assert.deepEqual(
    [acknowledged.tracking.health, acknowledged.tracking.identityChange, acknowledged.source.fullName, acknowledged.source.url],
    ["healthy", null, MOVED, `https://github.com/${MOVED}`],
  );
  const acknowledgementAudit = (await pool.query(
    "SELECT details FROM audit_events WHERE action = 'library.entry.tracking.update' AND resource_id = $1 ORDER BY created_at DESC LIMIT 1",
    [aliceTransfer.id],
  )).rows[0].details;
  assert.deepEqual(acknowledgementAudit.identity, { from: TRANSFER, to: MOVED });
  expectError(await setTracking(alice, aliceTransfer.id, { expectedRevision: acknowledged.revision, mode: "daily", acknowledgeIdentityChange: true }), 409, "IDENTITY_ACKNOWLEDGEMENT_NOT_APPLICABLE");
  const afterAcknowledgement = await checkNow(alice, aliceTransfer.id);
  assert.equal(afterAcknowledgement.outcome, "changed");
  assert.equal(afterAcknowledgement.snapshot.commit, transferredCommit);
  assert.equal(afterAcknowledgement.candidateIds.length, 1);
  assert.ok(afterAcknowledgement.eventKinds.includes("candidate-ready"));
  const alphaV2 = expectOk(await call("GET", `/v1/library-candidates/${afterAcknowledgement.candidateIds[0]}`, alice)).candidate;
  assert.deepEqual([alphaV2.expectedVersion, alphaV2.orderStatus, alphaV2.origin], ["0.0.2", "ahead", "tracking"]);
  const erinStill = await entryOf(erin, erinTransfer.id);
  assert.deepEqual([erinStill.tracking.health, erinStill.tracking.identityChange?.observedFullName, erinStill.source.fullName], ["identity-change-review", MOVED, TRANSFER]);
  const erinCheck = await checkNow(erin, erinTransfer.id);
  assert.deepEqual([erinCheck.outcome, erinCheck.errorCode], ["failed", "source-identity-changed"]);
  record("R03", { acknowledgedName: MOVED, audit: acknowledgementAudit.identity, secondAcknowledgement: 409, candidateVersion: alphaV2.expectedVersion, otherEntryHealth: erinStill.tracking.health });

  // ---- R04: an ignored tracking candidate is not proposed again for the same bytes.
  expectOk(await call("POST", `/v1/library-candidates/${alphaV2.id}/ignore`, alice));
  const rawBeforeIgnoredChecks = rawRequests("/transfer-skills/");
  const trackingCandidatesBefore = await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1 AND origin = 'tracking'", [aliceTransfer.id]);
  for (let round = 0; round < 2; round += 1) {
    clock.advanceHours(25);
    assert.equal(await worker.runOnce(), 1);
  }
  const unchangedCheck = await checkNow(alice, aliceTransfer.id);
  assert.deepEqual([unchangedCheck.outcome, unchangedCheck.candidateIds], ["unchanged", []]);
  assert.equal(await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1 AND origin = 'tracking'", [aliceTransfer.id]), trackingCandidatesBefore);
  assert.equal(await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1 AND state = 'ready-for-review'", [aliceTransfer.id]), 0);
  assert.equal(rawRequests("/transfer-skills/"), rawBeforeIgnoredChecks);
  assert.equal(await eventsFor(aliceTransfer.id, "candidate-ready"), 1);
  github.commit(MOVED, { files: { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha helper.", "# Alpha v3") } });
  const newBytesCheck = await checkNow(alice, aliceTransfer.id);
  assert.equal(newBytesCheck.candidateIds.length, 1);
  assert.ok(rawRequests("/transfer-skills/") > rawBeforeIgnoredChecks);
  record("R04", { checksAfterIgnore: 3, candidatesForIgnoredBytes: 0, blobRequestsForIgnoredBytes: 0, candidateForNewBytes: newBytesCheck.candidateIds.length });

  // ---- R05: one claim per check.
  expectOk(await setTracking(bob, bobTransfer.id, { expectedRevision: bobTransfer.revision, mode: "daily" }));
  let leasedDuringCheck = -1;
  github.interceptNext(/api\.github\.com\/repositories\/700001$/, async () => {
    leasedDuringCheck = await count("SELECT count(*) FROM library_entries WHERE lease_id IS NOT NULL", []);
  });
  clock.advanceHours(25);
  assert.equal(await worker.runOnce(), 2);
  assert.equal(leasedDuringCheck, 1);
  record("R05", { dueTracks: 2, checked: 2, leasesHeldDuringFirstCheck: leasedDuringCheck });

  // ---- R06: a check that loses its lease writes nothing and reports lease-lost.
  const alphaV4Commit = github.commit(MOVED, { files: { "skills/alpha/SKILL.md": skillMd("alpha", "Alpha helper.", "# Alpha v4") } });
  const thiefLease = "7e1f0000-0000-4000-8000-000000000099";
  const lastGoodBeforeLoss = (await entryOf(alice, aliceTransfer.id)).tracking.lastGoodSnapshot.id;
  const candidatesBeforeLoss = await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1", [aliceTransfer.id]);
  const readyEventsBeforeLoss = await eventsFor(aliceTransfer.id, "candidate-ready");
  github.interceptNext(/raw\.githubusercontent\.com\/mallory\/transfer-skills\/[0-9a-f]{40}\/skills\/alpha\/SKILL\.md$/, async () => {
    await pool.query("UPDATE library_entries SET lease_id = $2, lease_expires_at = $3 WHERE id = $1", [aliceTransfer.id, thiefLease, new Date(nowMs + 3_600_000).toISOString()]);
  });
  const lost = await checkNow(alice, aliceTransfer.id);
  assert.deepEqual([lost.outcome, lost.errorCode, lost.candidateIds, lost.eventKinds], ["failed", "lease-lost", [], []]);
  const afterLoss = (await pool.query("SELECT lease_id, last_good_snapshot_id, health FROM library_entries WHERE id = $1", [aliceTransfer.id])).rows[0];
  assert.deepEqual([afterLoss.lease_id, afterLoss.last_good_snapshot_id, afterLoss.health], [thiefLease, lastGoodBeforeLoss, "healthy"]);
  assert.equal(await count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1", [aliceTransfer.id]), candidatesBeforeLoss);
  assert.equal(await eventsFor(aliceTransfer.id, "candidate-ready"), readyEventsBeforeLoss);
  const snapshotsAfterLoss = await snapshotsFor(aliceTransfer.id);
  const treesAfterLoss = treeRequests();
  await pool.query("UPDATE library_entries SET lease_id = NULL, lease_expires_at = NULL WHERE id = $1", [aliceTransfer.id]);
  const retried = await checkNow(alice, aliceTransfer.id);
  assert.deepEqual([retried.outcome, retried.snapshot.commit, retried.candidateIds.length], ["changed", alphaV4Commit, 1]);
  assert.equal(await snapshotsFor(aliceTransfer.id), snapshotsAfterLoss);
  assert.equal(treeRequests(), treesAfterLoss);
  record("R06", { lostOutcome: lost.errorCode, thiefLeaseKept: true, candidatesWhileLost: 0, retryCandidates: 1, retrySnapshotReused: true });

  // ---- R07: order is measured against the imported commit, not the entry's first snapshot.
  const baseCommit = github.headCommit(ORDER);
  const orderEntry = await addSource(alice, aliceLibrary.id, `https://github.com/${ORDER}`);
  assert.equal((await discover(alice, orderEntry.id)).snapshot.commit, baseCommit);
  const importedCommit = github.commit(ORDER, { files: { "skills/beta/SKILL.md": skillMd("beta", "Beta helper.", "# Beta v2") } });
  const importedDiscovery = await discover(alice, orderEntry.id);
  assert.equal(importedDiscovery.snapshot.commit, importedCommit);
  const betaFirst = await previewOne(alice, orderEntry.id, importedDiscovery.snapshot.id, "skills/beta");
  assert.equal(betaFirst.orderStatus, "initial");
  expectOk(await importCandidate(alice, betaFirst), 202);
  const forcedCommit = github.commit(ORDER, { parent: baseCommit, files: { "skills/beta/SKILL.md": skillMd("beta", "Beta helper.", "# Beta rewritten history") } });
  const forced = await discover(alice, orderEntry.id);
  assert.deepEqual([forced.snapshot.commit, forced.snapshot.orderStatus], [forcedCommit, "ahead"]);
  const betaForced = await previewOne(alice, orderEntry.id, forced.snapshot.id, "skills/beta");
  assert.deepEqual([betaForced.state, betaForced.orderStatus, betaForced.expectedVersion], ["ready-for-review", "unverified", "0.0.2"]);
  expectError(await importCandidate(alice, betaForced), 409, "CANDIDATE_ORDER_UNVERIFIED");
  const orderReason = "Upstream rewrote history; reviewed the new bytes.";
  const forcedImport = expectOk(await importCandidate(alice, betaForced, { acknowledgeUnverifiedOrder: { reason: orderReason } }), 202);
  const forcedProvenance = (await pool.query("SELECT commit_sha, order_acknowledgement FROM skill_release_provenance WHERE skill_version_id = $1", [forcedImport.submission.id])).rows[0];
  assert.deepEqual(forcedProvenance, { commit_sha: forcedCommit, order_acknowledgement: orderReason });
  record("R07", { snapshotOrderVsFirstSnapshot: forced.snapshot.orderStatus, candidateOrderVsImport: betaForced.orderStatus, withoutAcknowledgement: 409, acknowledgedVersion: forcedImport.submission.version });

  // ---- R08: an acknowledgement is refused when order is verified.
  const linearCommit = github.commit(ORDER, { files: { "skills/beta/SKILL.md": skillMd("beta", "Beta helper.", "# Beta v4") } });
  const linear = await discover(alice, orderEntry.id);
  assert.equal(linear.snapshot.commit, linearCommit);
  const betaLinear = await previewOne(alice, orderEntry.id, linear.snapshot.id, "skills/beta");
  assert.deepEqual([betaLinear.orderStatus, betaLinear.expectedVersion], ["ahead", "0.0.3"]);
  expectError(await importCandidate(alice, betaLinear, { acknowledgeUnverifiedOrder: { reason: "Not needed." } }), 409, "ORDER_ACKNOWLEDGEMENT_NOT_APPLICABLE");
  const linearImport = expectOk(await importCandidate(alice, betaLinear), 202);
  assert.equal((await pool.query("SELECT order_acknowledgement FROM skill_release_provenance WHERE skill_version_id = $1", [linearImport.submission.id])).rows[0].order_acknowledgement, null);
  record("R08", { orderStatus: betaLinear.orderStatus, withAcknowledgement: 409, withoutAcknowledgement: 202 });

  // ---- R09: rediscovery of unchanged upstream reuses the snapshot.
  const orderSnapshots = await snapshotsFor(orderEntry.id);
  const treesBeforeRediscovery = treeRequests();
  const rediscovered = await discover(alice, orderEntry.id);
  assert.equal(rediscovered.snapshot.id, linear.snapshot.id);
  assert.equal(await snapshotsFor(orderEntry.id), orderSnapshots);
  assert.equal(treeRequests(), treesBeforeRediscovery);
  record("R09", { snapshotId: rediscovered.snapshot.id, snapshotsCreated: 0, treeRequests: 0 });

  // ---- R10: a failed then retried check emits each root change once.
  const churnEntry = await addSource(alice, aliceLibrary.id, `https://github.com/${CHURN}`);
  const churnDiscovery = await discover(alice, churnEntry.id);
  assert.deepEqual(churnDiscovery.skills.map((root: Json) => root.path), ["skills/delta", "skills/eps", "skills/gamma"]);
  expectOk(await importCandidate(alice, await previewOne(alice, churnEntry.id, churnDiscovery.snapshot.id, "skills/gamma")), 202);
  const churnCommit = github.commit(CHURN, {
    files: {
      "skills/gamma/SKILL.md": skillMd("gamma", "Gamma helper.", "# Gamma v2"),
      "skills/delta/SKILL.md": null,
      "skills/eps/SKILL.md": null,
      "skills/eps/notes.md": null,
      "skills/eps-renamed/SKILL.md": EPS_SKILL,
      "skills/eps-renamed/notes.md": EPS_NOTES,
    },
  });
  github.failNext(/raw\.githubusercontent\.com\/acme\/churn-skills\/[0-9a-f]{40}\/skills\/gamma\/SKILL\.md$/, { status: 429, headers: { "retry-after": "120" } });
  const churnKinds = ["skill-removed", "skill-renamed-suggested", "new-skill-discovered"];
  const churnEvents = async () => Object.fromEntries(await Promise.all(churnKinds.map(async (kind) => [kind, await eventsFor(churnEntry.id, kind)])));
  const limitedChurn = await checkNow(alice, churnEntry.id);
  assert.deepEqual([limitedChurn.outcome, limitedChurn.errorCode], ["failed", "rate-limited"]);
  const expectedChurnEvents = { "skill-removed": 2, "skill-renamed-suggested": 1, "new-skill-discovered": 1 };
  assert.deepEqual(await churnEvents(), expectedChurnEvents);
  const churnSnapshotsAfterFailure = await snapshotsFor(churnEntry.id);
  const retriedChurn = await checkNow(alice, churnEntry.id);
  assert.deepEqual([retriedChurn.outcome, retriedChurn.snapshot.commit, retriedChurn.candidateIds.length], ["changed", churnCommit, 1]);
  assert.deepEqual(retriedChurn.eventKinds.filter((kind: string) => churnKinds.includes(kind)), []);
  assert.deepEqual(await churnEvents(), expectedChurnEvents);
  assert.equal(await snapshotsFor(churnEntry.id), churnSnapshotsAfterFailure);
  record("R10", { firstAttempt: limitedChurn.errorCode, events: expectedChurnEvents, duplicateEventsOnRetry: 0 });

  // ---- R11: long tree path, bounded title.
  const longUrlPath = `skills/${"p".repeat(240)}/${"q".repeat(60)}`;
  const longTitled = await addSource(alice, aliceLibrary.id, `https://github.com/${BOUNDS}/tree/main/${longUrlPath}`);
  assert.deepEqual([longTitled.title.length, longTitled.title, longTitled.source.path], [200, `${BOUNDS}/${longUrlPath}`.slice(0, 200), longUrlPath]);
  record("R11", { pathLength: longUrlPath.length, titleLength: longTitled.title.length });

  // ---- R13 and R14 use the bounds repository's first snapshot.
  const boundsEntry = await addSource(alice, aliceLibrary.id, `https://github.com/${BOUNDS}`);
  const boundsDiscovery = await discover(alice, boundsEntry.id);
  const boundsRoots = new Map<string, Json>(boundsDiscovery.skills.map((root: Json) => [root.path, root]));
  assert.equal(boundsRoots.get(`skills/${LONG_DIR}`)!.directoryName, LONG_DIR);
  const longDirCandidate = await previewOne(alice, boundsEntry.id, boundsDiscovery.snapshot.id, `skills/${LONG_DIR}`);
  assert.deepEqual([longDirCandidate.state, longDirCandidate.packageDigest], ["blocked", null]);
  assert.ok(longDirCandidate.findings.some((finding: Json) => finding.code === "invalid-native-name" && finding.severity === "blocking"));
  const lineageNativeName = (await pool.query("SELECT native_name FROM library_import_lineages WHERE id = $1", [longDirCandidate.lineage.id])).rows[0].native_name as string;
  assert.ok(lineageNativeName.length <= 200);
  record("R13", { directoryNameLength: LONG_DIR.length, state: longDirCandidate.state, finding: "invalid-native-name", lineageNativeNameLength: lineageNativeName.length });

  const sizeless = boundsRoots.get("skills/sizeless")!;
  assert.ok(sizeless.blockers.some((finding: Json) => finding.code === "inventory-incomplete" && finding.severity === "blocking" && finding.path === "skills/sizeless/guide.md"));
  const sizelessCandidate = await previewOne(alice, boundsEntry.id, boundsDiscovery.snapshot.id, "skills/sizeless");
  assert.deepEqual([sizelessCandidate.state, sizelessCandidate.packageDigest], ["blocked", null]);
  assert.equal(rawRequests("/skills/sizeless/"), 0);
  record("R14", { finding: "inventory-incomplete", state: sizelessCandidate.state, blobRequests: 0 });

  // ---- R12: a rename between long roots completes with bounded event data.
  const renameCommit = github.commit(BOUNDS, { files: { [`${LONG_ROOT_FROM}/SKILL.md`]: null, [`${LONG_ROOT_TO}/SKILL.md`]: LONG_ROOT_SKILL } });
  const renameCheck = await checkNow(alice, boundsEntry.id);
  assert.deepEqual([renameCheck.outcome, renameCheck.snapshot?.commit], ["changed", renameCommit]);
  assert.ok(renameCheck.eventKinds.includes("skill-renamed-suggested"));
  const renameEvents = (await pool.query("SELECT path, semantic_key FROM library_events WHERE entry_id = $1 AND kind = 'skill-renamed-suggested'", [boundsEntry.id])).rows;
  assert.equal(renameEvents.length, 1);
  assert.ok(renameEvents[0].path.length <= 1024);
  assert.ok(renameEvents[0].path.startsWith(`${LONG_ROOT_FROM} -> `));
  assert.ok(renameEvents[0].semantic_key.length <= 400);
  record("R12", { renamePathLength: `${LONG_ROOT_FROM} -> ${LONG_ROOT_TO}`.length, storedPathLength: renameEvents[0].path.length, outcome: renameCheck.outcome });

  // ---- R15: per-user provider budget.
  const quota = jsonClient(quotaApp);
  quota.expectOk(await quota.call("POST", `/v1/library-entries/${bobTransfer.id}/discoveries`, bob));
  quota.expectOk(await quota.call("POST", `/v1/library-entries/${bobTransfer.id}/checks`, bob));
  const requestsBeforeLimited = github.requests.length;
  const limited = await quota.call("POST", `/v1/library-entries/${bobTransfer.id}/discoveries`, bob);
  quota.expectError(limited, 429, "LIBRARY_SOURCE_RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  quota.expectError(await quota.call("POST", `/v1/libraries/${bobLibrary.id}/entries`, bob, { kind: "source", url: `https://github.com/${MOVED}/tree/main/skills` }), 429, "LIBRARY_SOURCE_RATE_LIMITED");
  assert.equal(github.requests.length, requestsBeforeLimited);
  quota.expectError(await quota.call("POST", `/v1/libraries/${bobLibrary.id}/entries`, bob, { kind: "source", url: `http://github.com/${MOVED}` }), 400, "SOURCE_URL_UNSUPPORTED");
  quota.expectOk(await quota.call("POST", `/v1/library-entries/${orderEntry.id}/discoveries`, alice));
  record("R15", { limit: 2, limitedStatus: limited.status, providerRequestsWhileLimited: 0, otherUserAllowed: true });

  // ---- R16–R19: every check-owned write validates the lease inside its own transaction.
  const fenceEntry = await addSource(alice, aliceLibrary.id, `https://github.com/${FENCE}`);
  const fenceId: string = fenceEntry.id;
  const fenceDiscovery = await discover(alice, fenceId);
  expectOk(await importCandidate(alice, await previewOne(alice, fenceId, fenceDiscovery.snapshot.id, "skills/zeta")), 202);
  expectOk(await setTracking(alice, fenceId, { expectedRevision: (await entryOf(alice, fenceId)).revision, mode: "daily" }));
  const trackingState = async () => (await pool.query(
    "SELECT lease_id, health, last_error_code, attempt_count, next_check_at, last_successful_check_at, last_good_snapshot_id FROM library_entries WHERE id = $1",
    [fenceId],
  )).rows[0] as Json;
  const withoutLease = ({ lease_id: _leaseId, ...state }: Json) => state;
  const fenceCandidates = () => count("SELECT count(*) FROM library_import_candidates WHERE source_entry_id = $1", [fenceId]);
  const fenceEvents = () => count("SELECT count(*) FROM library_events WHERE entry_id = $1", [fenceId]);
  const readyEventCandidates = async () => (await pool.query(
    "SELECT candidate_id FROM library_events WHERE entry_id = $1 AND kind = 'candidate-ready'",
    [fenceId],
  )).rows.map((row) => String(row.candidate_id)).sort();
  // Test-only interposition, bounded to one call: `around` replaces the next call of a store method and
  // decides when the real write runs. The override is removed before `around` runs, so every later call,
  // including calls made inside `around`, uses the production method.
  const interposeOnce = (method: "insertSnapshot" | "insertCandidate" | "finishCheck", around: (write: () => Promise<unknown>) => Promise<unknown>) => {
    const target = libraryStore as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[method]!;
    let calls = 0;
    target[method] = (...args: unknown[]) => {
      calls += 1;
      Reflect.deleteProperty(target, method);
      return around(() => original.apply(libraryStore, args));
    };
    return { fired: () => calls === 1 };
  };
  // A second worker claims the entry through the production claim. Expiring the old lease first stands in
  // for a write that stalled past it; nothing sleeps.
  const takeOver = async (): Promise<string> => {
    await pool.query("UPDATE library_entries SET lease_expires_at = $2 WHERE id = $1", [fenceId, new Date(nowMs - 1).toISOString()]);
    const winner = await libraryStore.acquireLease({ entryId: fenceId, now: new Date(nowMs), leaseMs: 120_000 });
    assert.ok(winner, "the second worker must claim the expired lease");
    return winner;
  };
  const releaseLease = (leaseId: string) => pool.query("UPDATE library_entries SET lease_id = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_id = $2", [fenceId, leaseId]);
  // Bounded wait (about 2 s at most) until some backend is blocked by the given one.
  const blockedBy = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid]);
      if (Number(waiting.rows[0].count) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  // R16: takeover between the final renewal and the snapshot write.
  clock.advanceHours(1);
  const zetaV2Commit = github.commit(FENCE, { files: { "skills/zeta/SKILL.md": skillMd("zeta", "Zeta helper.", "# Zeta v2") } });
  const beforeR16 = await trackingState();
  const snapshotsBeforeR16 = await snapshotsFor(fenceId);
  const candidatesBeforeR16 = await fenceCandidates();
  const eventsBeforeR16 = await fenceEvents();
  let r16Winner = "";
  const r16 = interposeOnce("insertSnapshot", async (write) => {
    r16Winner = await takeOver();
    return write();
  });
  const r16Check = await checkNow(alice, fenceId);
  assert.equal(r16.fired(), true);
  assert.deepEqual([r16Check.outcome, r16Check.errorCode, r16Check.snapshot, r16Check.candidateIds, r16Check.eventKinds], ["failed", "lease-lost", null, [], []]);
  assert.equal(await snapshotsFor(fenceId), snapshotsBeforeR16);
  assert.equal(await fenceCandidates(), candidatesBeforeR16);
  assert.equal(await fenceEvents(), eventsBeforeR16);
  const afterR16 = await trackingState();
  assert.equal(afterR16.lease_id, r16Winner);
  assert.deepEqual(withoutLease(afterR16), withoutLease(beforeR16));
  await releaseLease(r16Winner);
  record("R16", { outcome: r16Check.errorCode, snapshotsWritten: 0, candidatesWritten: 0, eventsWritten: 0, winnerLeaseKept: true, trackingStateUnchanged: true });

  // R17: the candidate write waits on the entry row lock while another worker takes the lease and commits.
  const beforeR17 = await trackingState();
  const snapshotsBeforeR17 = await snapshotsFor(fenceId);
  const candidatesBeforeR17 = await fenceCandidates();
  const eventsBeforeR17 = await fenceEvents();
  const r17Winner = "7e1f0000-0000-4000-8000-000000000017";
  let writeWaitedOnEntryLock = false;
  const r17 = interposeOnce("insertCandidate", async (write) => {
    const other = await pool.connect();
    let open = false;
    try {
      await other.query("BEGIN");
      open = true;
      const pid = Number((await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await other.query("SELECT id FROM library_entries WHERE id = $1 FOR UPDATE", [fenceId]);
      const pending = write();
      pending.catch(() => undefined);
      writeWaitedOnEntryLock = await blockedBy(pid);
      await other.query(
        "UPDATE library_entries SET lease_id = $2, lease_expires_at = $3, last_attempt_at = $4, updated_at = now() WHERE id = $1",
        [fenceId, r17Winner, new Date(nowMs + 120_000).toISOString(), new Date(nowMs).toISOString()],
      );
      await other.query("COMMIT");
      open = false;
      return await pending;
    } finally {
      if (open) await other.query("ROLLBACK");
      other.release();
    }
  });
  const r17Check = await checkNow(alice, fenceId);
  assert.equal(r17.fired(), true);
  assert.equal(writeWaitedOnEntryLock, true);
  assert.deepEqual([r17Check.outcome, r17Check.errorCode, r17Check.candidateIds, r17Check.eventKinds], ["failed", "lease-lost", [], []]);
  assert.equal(await fenceCandidates(), candidatesBeforeR17);
  assert.equal(await fenceEvents(), eventsBeforeR17);
  assert.deepEqual(await readyEventCandidates(), []);
  // The snapshot was written while the check still held its lease; the retry reuses it.
  assert.equal(await snapshotsFor(fenceId), snapshotsBeforeR17 + 1);
  const afterR17 = await trackingState();
  assert.equal(afterR17.lease_id, r17Winner);
  assert.deepEqual(withoutLease(afterR17), withoutLease(beforeR17));
  await releaseLease(r17Winner);
  const treesBeforeR17Retry = treeRequests();
  const r17Retry = await checkNow(alice, fenceId);
  assert.deepEqual([r17Retry.outcome, r17Retry.snapshot?.commit, r17Retry.candidateIds.length], ["changed", zetaV2Commit, 1]);
  assert.ok(r17Retry.eventKinds.includes("candidate-ready"));
  assert.equal(treeRequests(), treesBeforeR17Retry);
  const zetaV2Candidate = String(r17Retry.candidateIds[0]);
  assert.equal(await fenceCandidates(), candidatesBeforeR17 + 1);
  assert.deepEqual(await readyEventCandidates(), [zetaV2Candidate]);
  const r17Again = await checkNow(alice, fenceId);
  assert.deepEqual([r17Again.outcome, r17Again.candidateIds, r17Again.eventKinds], ["unchanged", [], []]);
  assert.equal(await fenceCandidates(), candidatesBeforeR17 + 1);
  assert.deepEqual(await readyEventCandidates(), [zetaV2Candidate]);
  record("R17", {
    outcome: r17Check.errorCode,
    writeWaitedOnEntryLock,
    candidatesWritten: 0,
    eventsWritten: 0,
    winnerLeaseKept: true,
    retryCandidates: 1,
    retryEventsForCandidate: 1,
    secondRetryCandidates: 0,
  });

  // R18: takeover after the snapshot commits, before the root-change events.
  clock.advanceHours(1);
  const rootsCommit = github.commit(FENCE, { files: { "skills/eta/SKILL.md": null, "skills/iota/SKILL.md": skillMd("iota", "Iota helper.", "# Iota") } });
  const rootKinds = ["new-skill-discovered", "skill-removed", "skill-renamed-suggested"];
  const rootEvents = async () => Object.fromEntries(await Promise.all(rootKinds.map(async (kind) => [kind, await eventsFor(fenceId, kind)])));
  assert.deepEqual(await rootEvents(), { "new-skill-discovered": 0, "skill-removed": 0, "skill-renamed-suggested": 0 });
  const beforeR18 = await trackingState();
  const snapshotsBeforeR18 = await snapshotsFor(fenceId);
  let r18Winner = "";
  const r18 = interposeOnce("insertSnapshot", async (write) => {
    const snapshot = await write();
    r18Winner = await takeOver();
    return snapshot;
  });
  const r18Check = await checkNow(alice, fenceId);
  assert.equal(r18.fired(), true);
  assert.deepEqual([r18Check.outcome, r18Check.errorCode, r18Check.eventKinds], ["failed", "lease-lost", []]);
  assert.equal(await snapshotsFor(fenceId), snapshotsBeforeR18 + 1);
  assert.deepEqual(await rootEvents(), { "new-skill-discovered": 0, "skill-removed": 0, "skill-renamed-suggested": 0 });
  const afterR18 = await trackingState();
  assert.equal(afterR18.lease_id, r18Winner);
  assert.deepEqual(withoutLease(afterR18), withoutLease(beforeR18));
  await releaseLease(r18Winner);
  const treesBeforeR18Retry = treeRequests();
  const r18Retry = await checkNow(alice, fenceId);
  assert.deepEqual([r18Retry.outcome, r18Retry.snapshot?.commit, r18Retry.candidateIds], ["changed", rootsCommit, []]);
  assert.deepEqual([...r18Retry.eventKinds].sort(), ["new-skill-discovered", "skill-removed"]);
  assert.equal(treeRequests(), treesBeforeR18Retry);
  assert.equal(await snapshotsFor(fenceId), snapshotsBeforeR18 + 1);
  assert.deepEqual(await rootEvents(), { "new-skill-discovered": 1, "skill-removed": 1, "skill-renamed-suggested": 0 });
  record("R18", { outcome: r18Check.errorCode, snapshotKept: true, eventsWhileLost: 0, retryEvents: { "new-skill-discovered": 1, "skill-removed": 1 }, retrySnapshotReused: true });

  // R19: the winner claims and finishes before the stale check's finishCheck.
  clock.advanceHours(1);
  const zetaV3Commit = github.commit(FENCE, { files: { "skills/zeta/SKILL.md": skillMd("zeta", "Zeta helper.", "# Zeta v3") } });
  const lastGoodBeforeR19 = String((await trackingState()).last_good_snapshot_id);
  const candidatesBeforeR19 = await fenceCandidates();
  const winnerNextCheckAt = new Date(nowMs + 72 * 3_600_000);
  const winnerSucceededAt = new Date(nowMs - 60_000);
  let r19Winner = "";
  const r19 = interposeOnce("finishCheck", async (write) => {
    r19Winner = await takeOver();
    const finished = await libraryStore.finishCheck({
      entryId: fenceId,
      leaseId: r19Winner,
      health: "healthy",
      lastErrorCode: null,
      attemptCount: 0,
      nextCheckAt: winnerNextCheckAt,
      succeededAt: winnerSucceededAt,
      lastGoodSnapshotId: null,
    });
    assert.ok(finished, "the winner finishes its own check");
    return write();
  });
  const r19Check = await checkNow(alice, fenceId);
  assert.equal(r19.fired(), true);
  assert.deepEqual([r19Check.outcome, r19Check.errorCode, r19Check.snapshot, r19Check.candidateIds, r19Check.eventKinds], ["failed", "lease-lost", null, [], []]);
  const afterR19 = await trackingState();
  assert.deepEqual(
    [afterR19.lease_id, afterR19.health, new Date(afterR19.next_check_at).toISOString(), new Date(afterR19.last_successful_check_at).toISOString(), String(afterR19.last_good_snapshot_id)],
    [null, "healthy", winnerNextCheckAt.toISOString(), winnerSucceededAt.toISOString(), lastGoodBeforeR19],
  );
  // The candidate the stale check wrote while it held the lease committed together with its event.
  assert.equal(await fenceCandidates(), candidatesBeforeR19 + 1);
  const zetaV3Candidate = String((await pool.query(
    `SELECT c.id FROM library_import_candidates c JOIN library_source_snapshots s ON s.id = c.snapshot_id
      WHERE c.source_entry_id = $1 AND s.commit_sha = $2`,
    [fenceId, zetaV3Commit],
  )).rows[0].id);
  assert.deepEqual(await readyEventCandidates(), [zetaV2Candidate, zetaV3Candidate].sort());
  const r19Retry = await checkNow(alice, fenceId);
  assert.deepEqual([r19Retry.outcome, r19Retry.snapshot?.commit, r19Retry.candidateIds, r19Retry.eventKinds], ["changed", zetaV3Commit, [], []]);
  assert.equal(await fenceCandidates(), candidatesBeforeR19 + 1);
  assert.deepEqual(await readyEventCandidates(), [zetaV2Candidate, zetaV3Candidate].sort());
  record("R19", {
    outcome: r19Check.errorCode,
    winnerNextCheckAt: winnerNextCheckAt.toISOString(),
    winnerSucceededAt: winnerSucceededAt.toISOString(),
    lastGoodKept: lastGoodBeforeR19,
    candidateWithEvent: 1,
    retryCandidates: 0,
    retryEvents: 0,
  });

  // R20: licence metadata in the shared catalogue is not current preview evidence.
  const licenceRepo = "acme/licence-freshness";
  github.createRepository({ id: 565656, owner: "acme", name: "licence-freshness", license: "MIT", files: { LICENSE: MIT, "skills/licence-helper/SKILL.md": skillMd("licence-helper", "Licence review fixture.", "# Licence fixture") } });
  const licenceSource = await addSource(alice, aliceLibrary.id, `https://github.com/${licenceRepo}`);
  const licenceSnapshot = (await discover(alice, licenceSource.id)).snapshot.id;
  const withoutLiveIdentifier = () => github.failNext(/api\.github\.com\/repositories\/565656$/, { status: 200, body: { id: 565656, full_name: licenceRepo, default_branch: "main", private: false, license: null } });
  withoutLiveIdentifier();
  const unknownLicence = await previewOne(alice, licenceSource.id, licenceSnapshot, "skills/licence-helper");
  assert.equal(unknownLicence.state, "blocked");
  assert.ok(unknownLicence.findings.some((finding: Json) => finding.code === "license-review-required"));
  withoutLiveIdentifier();
  const explicitLicence = expectOk(await call("POST", `/v1/library-entries/${licenceSource.id}/previews`, alice, { snapshotId: licenceSnapshot, paths: ["skills/licence-helper"], mappings: { "skills/licence-helper": { license: "MIT" } } })).preview.candidates[0];
  assert.deepEqual([explicitLicence.state, explicitLicence.mapping.license], ["ready-for-review", "MIT"]);
  record("R20", { cachedIdentifierIgnored: true, explicitMappingAccepted: true });

  // R21: boundary slashes remain valid; interior runs fail promptly without provider I/O.
  const normalizedPreview = await previewOne(alice, licenceSource.id, licenceSnapshot, "///skills/licence-helper///");
  assert.equal(normalizedPreview.sourcePath, "skills/licence-helper");
  const longBoundaryPreview = await previewOne(alice, licenceSource.id, licenceSnapshot, `${"/".repeat(100_000)}skills/licence-helper${"/".repeat(100_000)}`);
  assert.equal(longBoundaryPreview.sourcePath, "skills/licence-helper");
  const rootPreview = await previewOne(alice, licenceSource.id, licenceSnapshot, "/".repeat(100_000));
  assert.equal(rootPreview.sourcePath, "");
  const providerRequestsBefore = github.requests.length;
  const hostilePath = `skills/${"/".repeat(200_000)}missing`;
  const started = performance.now();
  expectError(await call("POST", `/v1/library-entries/${licenceSource.id}/previews`, alice, { snapshotId: licenceSnapshot, paths: [hostilePath] }), 400, "LIBRARY_PREVIEW_SELECTION_INVALID");
  const validationMs = performance.now() - started;
  assert.ok(validationMs < 2_000, `A 200k interior slash run took ${Math.round(validationMs)}ms to reject; validation must not backtrack quadratically.`);
  for (const path of ["skills//licence-helper", "skills/../licence-helper", "skills/./licence-helper", "skills/\\licence-helper", "skills/\u0000licence-helper", "a".repeat(1025)]) {
    expectError(await call("POST", `/v1/library-entries/${licenceSource.id}/previews`, alice, { snapshotId: licenceSnapshot, paths: [path] }), 400, "LIBRARY_PREVIEW_SELECTION_INVALID");
  }
  assert.equal(github.requests.length, providerRequestsBefore);
  record("R21", { boundarySlashesTrimmed: true, allSlashesSelectRoot: true, hostilePathLength: hostilePath.length, validationMs: Math.round(validationMs), invalidPathProviderRequests: 0 });

  const evidenceTarget = process.env.LIBRARY_REMEDIATION_EVIDENCE_PATH;
  const evidenceDirectory = mkdtempSync(join(evidenceTarget ? dirname(evidenceTarget) : tmpdir(), "myskills-library-remediation-"));
  const evidencePath = join(evidenceDirectory, evidenceTarget ? basename(evidenceTarget) : "myskills-library-remediation-evidence.json");
  const expected = ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R12", "R13", "R14", "R15", "R16", "R17", "R18", "R19", "R20", "R21"];
  assert.deepEqual([...new Set(evidence.map((item) => item.id))].sort(), expected);
  writeFileSync(evidencePath, `${JSON.stringify({ schemaVersion: 1, journey: "library-remediation", scenarios: evidence }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  assert.equal(statSync(dirname(evidencePath)).mode & 0o777, 0o700);
  assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
  assert.throws(() => writeFileSync(evidencePath, "must not replace evidence", { flag: "wx", mode: 0o600 }), { code: "EEXIST" });
  t.diagnostic(`library remediation evidence: ${evidencePath}`);
});

function jsonClient(app: ReturnType<typeof buildApp>) {
  const call = async (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token?: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });
    let body: Json = {};
    try { body = response.body ? JSON.parse(response.body) : {}; } catch { body = { raw: response.body.slice(0, 64) }; }
    return { status: response.statusCode, body, headers: response.headers as Json };
  };
  const expectError = (response: { status: number; body: Json }, status: number, code: string) => {
    assert.equal(response.status, status, `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
    assert.equal(response.body.error?.code, code);
  };
  const expectOk = (response: { status: number; body: Json }, status = 200) => {
    assert.equal(response.status, status, `expected ${status}, got ${response.status} ${JSON.stringify(response.body).slice(0, 600)}`);
    return response.body;
  };
  return { call, expectError, expectOk };
}

function skillMd(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

async function reviewAndPublish(
  call: (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, token?: string, payload?: unknown) => Promise<{ status: number; body: Json; headers: Json }>,
  reviewer: string,
  submissionId: string,
): Promise<void> {
  const bundle = await call("GET", `/v1/review/submissions/${submissionId}/bundle`, reviewer);
  assert.equal(bundle.status, 200);
  const hash = bundle.headers["x-myskills-artifact-sha256"] as string;
  const approve = await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "approve", artifactSha256: hash });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const publish = await call("POST", `/v1/review/submissions/${submissionId}/actions`, reviewer, { action: "publish" });
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
}

async function registerCompanionTarget(
  pool: ReturnType<typeof createPgPool>,
  service: ArchitectureTargetService,
  ownerId: string,
  slug: string,
  version: string,
  digest: string,
) {
  await pool.query("INSERT INTO skill_architectures (id, owner_user_id, name, description, pattern_id) VALUES ($1, $2, 'Personal', 'Library journey', 'flat')", [ids.architecture, ownerId]);
  const adapter = { kind: "codex-companion", version: "1.0.0", contractVersion: 2 as const };
  const capabilities = { "inventory.read": true, apply: true, rollback: true, "sync.write": true } as const;
  const target = await service.registerTarget({
    actor: ownerId,
    name: "Alice laptop",
    owner: { type: "user", id: ownerId },
    architectureId: ids.architecture,
    environmentId: "personal",
    profileId: "default",
    adapter,
    capabilities,
  });
  await service.grantConsent(ownerId, target.id);
  const observation: ArchitectureTargetObservationInput = {
    schemaVersion: 1,
    id: "observation-11111111-1111-4111-8111-111111111111",
    targetId: target.id,
    targetGeneration: target.generation,
    adapterDigest: architectureTargetAdapterDigest(adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(capabilities, adapter.contractVersion),
    observedAt: new Date().toISOString(),
    skills: [{ slug, version, digest, managed: true }],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
  };
  await service.appendObservation({ actor: ownerId, targetId: target.id, observation: { ...observation, observedDigest: architectureTargetObservationDigest(observation) } });
  return target;
}

function allowAuthorizer(): ArchitectureTargetBindingAuthorizer {
  return {
    authorizeBinding: async (request) => ({
      allowed: true as const,
      binding: { owner: request.requestedOwner, architectureId: request.architectureId, environmentId: request.environmentId, profileId: request.profileId },
      authorization: {
        actorUserId: request.actorUserId,
        owner: request.requestedOwner,
        architectureId: request.architectureId,
        environmentId: request.environmentId,
        profileId: request.profileId,
        currentRevisionId: null,
      },
    }),
  };
}

function manifestFor(name: string, version: string) {
  return {
    name,
    title: "Injected",
    summary: "Checks server-managed submission fields.",
    version,
    license: "MIT",
    visibility: "private",
    platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }],
    tags: [],
  };
}

function packageFilesFor(name: string, version: string) {
  return [
    { path: "SKILL.md", content: `---\nname: ${name}\ndescription: Checks server-managed submission fields.\n---\n# Check\n` },
    { path: "skill.json", content: JSON.stringify(manifestFor(name, version)) },
  ];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function countRows(pool: ReturnType<typeof createPgPool>, table: string): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
  return result.rows[0].count as number;
}

async function insertUser(pool: ReturnType<typeof createPgPool>, id: string, email: string, roles: string[]): Promise<void> {
  await pool.query(
    "INSERT INTO users (id, email, normalized_email, name, status, email_verified_at) VALUES ($1, $2, $2, $3, 'active', now())",
    [id, email, email.split("@")[0]],
  );
  await pool.query("INSERT INTO password_credentials (user_id, password_hash) VALUES ($1, $2)", [id, await hashPassword(password)]);
  for (const role of roles) await pool.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, $2)", [id, role]);
}

async function login(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(response.statusCode, 200, response.body);
  assert.notEqual(response.json().mfaRequired, true);
  return response.json().token as string;
}

async function loginWithMfa(app: ReturnType<typeof buildApp>, email: string): Promise<string> {
  const setupToken = await login(app, email);
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${setupToken}` }, payload: { password } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupToken}` },
    payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password } });
  assert.equal(challenge.json().mfaRequired, true);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token as string;
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}. Use TEST_DATABASE_URL with a test database.`);
  }
}

async function resetDatabase(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

async function applyMigrations(pool: ReturnType<typeof createPgPool>): Promise<void> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    await pool.query("BEGIN");
    try {
      await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
      await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }
}
