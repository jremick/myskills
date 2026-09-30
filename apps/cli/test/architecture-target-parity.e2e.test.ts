import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest, createFlatArchitecture } from "@myskills-app/core";
import { runCli } from "../src/cli.js";
import { buildApp } from "../../api/src/app.js";
import { MemoryAuthStore } from "../../api/src/auth/memory-auth-store.js";
import { AuthService } from "../../api/src/auth/service.js";
import { MemoryArchitectureStore } from "../../api/src/architectures/memory-store.js";
import { MemoryArchitectureOrganizationGrantStore } from "../../api/src/architectures/memory-organization-grant-store.js";
import { ArchitectureOrganizationGrantService } from "../../api/src/architectures/organization-grant-service.js";
import { MemoryPatternMigrationStore } from "../../api/src/architectures/memory-pattern-migration-store.js";
import { ArchitecturePatternMigrationService } from "../../api/src/architectures/pattern-migration-service.js";
import { MemoryOrganizationStore } from "../../api/src/organizations/memory-organization-store.js";
import { MemorySkillRepository } from "../../api/src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../api/src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../api/src/submissions/service.js";
import { ArchitectureTargetBindingAuthorizer } from "../../api/src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../../api/src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../../api/src/targets/service.js";
import { MemoryTargetSkillOperationStore } from "../../api/src/target-operations/memory-store.js";
import { TargetSkillOperationService } from "../../api/src/target-operations/service.js";
import { MemorySkillUpgradePolicyStore } from "../../api/src/upgrade-policies/memory-store.js";
import { SkillUpgradePolicyService } from "../../api/src/upgrade-policies/service.js";

// Failure inventory written before the CLI implementation. These journeys run
// the public CLI through HTTP into the real API, authorization and memory stores.
// Existing route tests do not prove CLI dispatch, payload fidelity or error exits.
// F1 New commands do not reach their API operations or lose JSON result fields.
// F2 Stale revision/policy tokens are omitted or silently refreshed and overwrite work.
// F3 Non-MFA sessions or another user can mutate/read a private target.
// F4 Caller idempotency keys change on retry, creating duplicate operations/migrations.
// F5 Observation generation/digests or target consent are lost during transport.
// F6 Missing input, malformed IDs, extra arguments/options cause a network mutation.
// F7 Batch target IDs cannot pass the API parser or failures masquerade as success.
// F8 Revocation is bypassed, or queued/cancelled state is hidden from CLI readback.
// F9 Privileged session-only commands silently fall back to broad API-token authority.

const PASSWORD = "synthetic architecture target test password";
const OWNER = "cli-parity-owner";
const SLUG = "cli-parity-helper";

test("architecture CLI preserves revision conflicts, grant revocation and migration replay through the API", async (t) => {
  const fixture = await createFixture(t);
  const { command, owner, plain, outsider, grantStore } = fixture;
  const created = await command(["architectures", "create"], { name: "CLI parity architecture", patternId: "flat" });
  assert.equal(created.code, 0, created.error);
  const id = created.data.architecture.id;
  const spec = fixture.spec(id);
  const first = await command(["architectures", "revise", id], { expectedCurrentRevisionId: null, spec, message: "Initial revision" });
  assert.equal(first.code, 0, first.error);
  const revisionId = first.data.revision.id;
  const preview = await command(["architectures", "draft-preview", id], { expectedCurrentRevisionId: revisionId, spec });
  assert.equal(preview.code, 0, preview.error);
  assert.equal(preview.data.draft.expectedCurrentRevisionId, revisionId);
  assert.equal(preview.data.compiled.nodes.length, 1);
  const second = await command(["architectures", "revise", id], { expectedCurrentRevisionId: revisionId, spec, message: "Second revision" });
  assert.equal(second.code, 0, second.error);
  const current = second.data.revision.id;
  assert.notEqual(current, revisionId);
  const conflict = await command(["architectures", "revise", id], { expectedCurrentRevisionId: revisionId, spec });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.error, /ARCHITECTURE_REVISION_CONFLICT/);
  const revisions = await command(["architectures", "revisions", id]);
  assert.equal(revisions.code, 0, revisions.error);
  assert.equal(revisions.data.revisions.length, 2);
  const unauthorized = await command(["architectures", "grants", id], undefined, outsider);
  assert.notEqual(unauthorized.code, 0);

  grantStore.addGrant({ architectureId: id, organizationId: "former-organization", accessLevel: "read", createdUnderPolicyRevisionId: "former-policy" });
  const grants = await command(["architectures", "grants", id]);
  assert.deepEqual(grants.data.organizationIds, ["former-organization"]);
  const noMfa = await command(["architectures", "set-grants", id], { expectedCurrentRevisionId: current, organizationIds: [] }, plain);
  assert.notEqual(noMfa.code, 0);
  assert.match(noMfa.error, /MFA_VERIFICATION_REQUIRED/);
  const revoked = await command(["architectures", "set-grants", id], { expectedCurrentRevisionId: current, organizationIds: [] }, owner);
  assert.equal(revoked.code, 0, revoked.error);
  assert.deepEqual((await command(["architectures", "grants", id])).data.organizationIds, []);

  const migrationInput = { expectedCurrentRevisionId: current, targetPatternId: "multi-level-router" };
  const migrationPreview = await command(["architectures", "migration-preview", id], migrationInput);
  assert.equal(migrationPreview.code, 0, migrationPreview.error);
  assert.ok(migrationPreview.data.migration.target);
  const migration = { ...migrationInput, idempotencyKey: "cli-migration-retry", name: "Derived CLI router" };
  const migrated = await command(["architectures", "migrate", id], migration);
  assert.equal(migrated.code, 0, migrated.error);
  assert.equal(migrated.data.created, true);
  const replay = await command(["architectures", "migrate", id], migration);
  assert.equal(replay.code, 0, replay.error);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.persisted.targetArchitecture.id, migrated.data.persisted.targetArchitecture.id);
  t.diagnostic(JSON.stringify({ journey: "architecture-cli-parity", revisionCount: 2, staleRevisionRejected: true, grantRevoked: true, migrationReplayed: true }));
});

test("target CLI enforces consent, MFA, ownership, generation, policies and idempotent queued operations", async (t) => {
  const fixture = await createFixture(t);
  const { command, owner, plain, outsider } = fixture;
  const created = await command(["architectures", "create"], { name: "Connected CLI target", patternId: "flat" });
  assert.equal(created.code, 0, created.error);
  const architectureId = created.data.architecture.id;
  const revised = await command(["architectures", "revise", architectureId], { expectedCurrentRevisionId: null, spec: fixture.spec(architectureId) });
  assert.equal(revised.code, 0, revised.error);
  const register = {
    name: "Parity target", owner: { type: "user", id: OWNER }, architectureId,
    profileId: "personal", environmentId: "personal-machine",
    adapter: { kind: "codex-companion", version: "1.0.0", contractVersion: 2 },
    capabilities: { "inventory.read": true, "health.read": true, "plan.read": true, apply: true, rollback: true, "sync.write": true },
  };
  const denied = await command(["targets", "register"], register, plain);
  assert.notEqual(denied.code, 0);
  assert.match(denied.error, /MFA_VERIFICATION_REQUIRED/);
  const registered = await command(["targets", "register"], register);
  assert.equal(registered.code, 0, registered.error);
  const target = registered.data.target;
  assert.equal(target.consent.status, "pending");
  assert.equal((await command(["targets", "list"])).data.targets.length, 1);
  const missing = await command(["targets", "show", target.id], undefined, outsider);
  assert.notEqual(missing.code, 0);
  assert.match(missing.error, /ARCHITECTURE_TARGET_NOT_FOUND/);
  const apiToken = await fixture.app.inject({ method: "POST", url: "/v1/auth/api-tokens", headers: { authorization: `Bearer ${owner}` }, payload: { name: "Scoped parity token", scopes: ["architectures:read"] } });
  assert.equal(apiToken.statusCode, 201, apiToken.body);
  const tokenDenied = await command(["targets", "show", target.id], undefined, apiToken.json().token.token);
  assert.match(tokenDenied.error, /API_TOKEN_SCOPE_REQUIRED/);
  const consent = await command(["targets", "consent", target.id], { decision: "grant" });
  assert.equal(consent.code, 0, consent.error);
  assert.equal(consent.data.target.consent.status, "granted");
  const observation = {
    schemaVersion: 1, targetId: target.id, targetGeneration: target.generation,
    adapterDigest: architectureTargetAdapterDigest(target.adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities, target.adapter.contractVersion),
    observedAt: new Date().toISOString(),
    skills: [{ slug: SLUG, version: "1.0.0", digest: fixture.digest, managed: true }],
    configFindings: [], promptAwareness: { detected: false, count: 0, redacted: true },
  };
  const observed = await command(["targets", "observe", target.id], observation);
  assert.equal(observed.code, 0, observed.error);
  assert.equal((await command(["targets", "observations", target.id, "--limit", "1"])).data.observations[0].skills[0].version, "1.0.0");
  const wrongGeneration = await command(["targets", "observe", target.id], { ...observation, targetGeneration: target.generation + 1 });
  assert.notEqual(wrongGeneration.code, 0);
  assert.match(wrongGeneration.error, /GENERATION/);
  const health = await command(["targets", "health", target.id], { status: "healthy", checkedAt: new Date().toISOString() });
  assert.equal(health.code, 0, health.error);
  assert.equal((await command(["targets", "show", target.id])).data.target.health.status, "healthy");

  const policy = { expectedRevisionNumber: 0, policy: { schemaVersion: 1, mode: "manual", includePrerelease: false, allowedChangeKinds: ["feature", "fix", "security"], pins: {} } };
  const policySaved = await command(["targets", "set-update-policy", target.id], policy);
  assert.equal(policySaved.code, 0, policySaved.error);
  assert.equal((await command(["targets", "update-policy", target.id])).data.revision.revisionNumber, 1);
  const policyConflict = await command(["targets", "set-update-policy", target.id], { ...policy, policy: { ...policy.policy, pins: { [SLUG]: "1.0.0" } } });
  assert.notEqual(policyConflict.code, 0);
  assert.match(policyConflict.error, /CONFLICT/);
  const updates = await command(["targets", "updates", target.id]);
  assert.equal(updates.code, 0, updates.error);
  assert.equal(updates.data.items[0].evaluation.candidate.version, "1.1.0");
  const schedule = { action: "update", slug: SLUG, version: "1.1.0", platform: "codex", idempotencyKey: "cli-update-retry" };
  const notMfa = await command(["targets", "schedule", target.id], schedule, plain);
  assert.notEqual(notMfa.code, 0);
  assert.match(notMfa.error, /MFA_VERIFICATION_REQUIRED/);
  const scheduled = await command(["targets", "schedule", target.id], schedule);
  assert.equal(scheduled.code, 0, scheduled.error);
  assert.equal(scheduled.data.operation.state, "queued");
  const replay = await command(["targets", "schedule", target.id], schedule);
  assert.equal(replay.code, 0, replay.error);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.operation.id, scheduled.data.operation.id);
  const batch = await command(["operations", "batch"], { operations: [{ ...schedule, targetId: target.id, idempotencyKey: "cli-update-batch" }] });
  assert.equal(batch.code, 0, batch.error);
  assert.equal(batch.data.results.length, 1);
  const operationId = scheduled.data.operation.id;
  assert.equal((await command(["operations", "show", operationId])).data.operation.state, "queued");
  assert.equal((await command(["targets", "operations", target.id])).data.operations.length, 2);
  const cancelled = await command(["operations", "cancel", operationId]);
  assert.equal(cancelled.code, 0, cancelled.error);
  assert.equal((await command(["operations", "show", operationId])).data.operation.state, "cancelled");
  const revoked = await command(["targets", "revoke", target.id]);
  assert.equal(revoked.code, 0, revoked.error);
  assert.equal(revoked.data.target.status, "revoked");
  const afterRevocation = await command(["targets", "consent", target.id], { decision: "grant" });
  assert.notEqual(afterRevocation.code, 0);
  assert.match(afterRevocation.error, /ARCHITECTURE_TARGET_REVOKED/);
  t.diagnostic(JSON.stringify({ journey: "target-cli-parity", privateTargetHidden: true, mfaAndSessionEnforced: true, generationChecked: true, policyConflictRejected: true, operationReplayed: true, batchSize: 1, cancelled: true, revoked: true }));
});

test("architecture and target commands reject ambiguous input before sending a request", async () => {
  let requests = 0;
  const invalid = [
    ["architectures", "create"],
    ["architectures", "revise", "safe-id"],
    ["architectures", "grants", "../admin"],
    ["targets", "register"],
    ["targets", "show", "https://example.com/target"],
    ["targets", "show", "safe-id", "extra"],
    ["targets", "list", "--unexpected", "yes"],
    ["targets", "observations", "safe-id", "--limit", "1.5"],
    ["targets", "observations", "safe-id", "--limit", "0"],
    ["operations", "batch"],
    ["operations", "cancel", "safe-id", "--input", "irrelevant.json"],
  ];
  for (const args of invalid) {
    const code = await runCli([...args, "--json"], {
      env: { MYSKILLS_TOKEN: "synthetic-token" },
      io: { stdout() {}, stderr() {} },
      fetch: async () => { requests += 1; throw new Error("Unexpected network call"); },
    });
    assert.notEqual(code, 0, args.join(" "));
  }
  assert.equal(requests, 0);
});

async function createFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-cli-target-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const grantStore = new MemoryArchitectureOrganizationGrantStore();
  const submissions = new SubmissionService(new MemorySubmissionStore());
  const targetService = new ArchitectureTargetService(new MemoryArchitectureTargetStore(), new ArchitectureTargetBindingAuthorizer(architectureStore));
  const upgradePolicies = new SkillUpgradePolicyService(new MemorySkillUpgradePolicyStore());
  const app = buildApp({
    skillRepository: new MemorySkillRepository([{ slug: SLUG, title: "CLI parity helper", summary: "A synthetic parity test package.", lifecycleStatus: "approved", visibility: "public", latestVersion: "1.1.0", reviewStatus: "approved", securityStatus: "passed", platforms: [], tags: [] }]),
    authService: new AuthService(authStore), architectureStore,
    submissionService: submissions, architectureTargetService: targetService,
    skillUpgradePolicyService: upgradePolicies,
    targetSkillOperationService: new TargetSkillOperationService(new MemoryTargetSkillOperationStore(), targetService, submissions, { upgradePolicies }),
    architectureOrganizationGrantService: new ArchitectureOrganizationGrantService({ architectureStore, grantStore, organizationStore: new MemoryOrganizationStore(), organizationVisibilityEnabled: false, releaseAuthorizer: async () => false }),
    architecturePatternMigrationService: new ArchitecturePatternMigrationService(architectureStore, new MemoryPatternMigrationStore(), {
      releaseAuthorizer: { authorize: async ({ actorId, targetSpec }) => {
        for (const skill of targetSpec.skills) {
          const release = await submissions.getPublicRelease({ actorId, slug: skill.slug, version: skill.version });
          if (!release || release.artifact.sha256 !== skill.digest) return false;
        }
        return true;
      } },
    }),
  });
  t.after(() => app.close());
  const plain = await login(app, authStore, OWNER);
  const outsider = await login(app, authStore, "cli-parity-outsider");
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${plain}` }, payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${plain}` }, payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: `${OWNER}@example.com`, password: PASSWORD } });
  const verify = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirm.json().mfa.recoveryCodes[0] } });
  assert.equal(verify.statusCode, 200, verify.body);
  const owner = verify.json().token as string;
  let digest = "";
  for (const version of ["1.0.0", "1.1.0"]) {
    const manifest = { name: SLUG, title: "CLI parity helper", summary: "A synthetic parity test package.", version, license: "MIT", visibility: "public" as const, tags: [], platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" as const }] };
    const submission = await submissions.createSubmission({ actor: { id: OWNER, roles: ["author"] }, manifest, release: { releaseNotes: "Synthetic parity release.", changeKind: "feature", requiresUserAction: false, compatibility: {} }, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "SKILL.md", content: "Synthetic CLI parity test skill." }] });
    await submissions.performReviewAction({ actor: { id: "fixture-maintainer", roles: ["maintainer"] }, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await submissions.performReviewAction({ actor: { id: "fixture-maintainer", roles: ["maintainer"] }, submissionId: submission.id, action: "publish" });
    if (version === "1.0.0") digest = submission.artifact.sha256;
  }
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  let inputNumber = 0;
  async function command(args: string[], body?: Record<string, unknown>, token = owner) {
    const stdout: string[] = []; const stderr: string[] = [];
    const inputPath = path.join(root, `input-${++inputNumber}.json`);
    if (body) await writeFile(inputPath, JSON.stringify(body));
    const code = await runCli([...args, ...(body ? ["--input", inputPath] : []), "--api-url", apiUrl, "--json"], { env: { MYSKILLS_TOKEN: token }, fetch: (input, init) => fetch(input, init), io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) } });
    return { code, data: stdout.length ? JSON.parse(stdout.join("\n")) : {}, error: stderr.join("\n") };
  }
  return { app, owner, plain, outsider, grantStore, command, digest, spec: (id: string) => createFlatArchitecture({ id, name: "CLI parity architecture", profile: { id: "personal", subject: { type: "user", id: OWNER } }, environment: { id: "personal-machine", kind: "personal" }, skills: [{ id: SLUG, slug: SLUG, version: "1.0.0", digest, packageVisibility: "public" }] }) };
}

async function login(app: ReturnType<typeof buildApp>, authStore: MemoryAuthStore, id: string) {
  authStore.addUser({ id, email: `${id}@example.com`, name: id, status: "active", emailVerifiedAt: new Date(), roles: ["author"], passwordHash: await hashPassword(PASSWORD) });
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: `${id}@example.com`, password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}
