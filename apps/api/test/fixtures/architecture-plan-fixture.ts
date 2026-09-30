import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { architectureTargetAdapterDigest, architectureTargetCapabilitiesDigest, createMultiLevelRouterArchitecture, type ArchitectureTargetObservationInput } from "@myskills-app/core";
import { buildApp } from "../../src/app.js";
import { MemoryAuthStore } from "../../src/auth/memory-auth-store.js";
import { AuthService } from "../../src/auth/service.js";
import { MemoryArchitectureStore } from "../../src/architectures/memory-store.js";
import { ArchitectureTargetBindingAuthorizer } from "../../src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../../src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../../src/targets/service.js";
import { MemorySkillRepository } from "../../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../../src/submissions/service.js";
import { MemoryArchitectureSyncStore } from "../../src/architecture-sync/memory-store.js";
import { ArchitecturePlanService } from "../../src/architecture-sync/plan-service.js";

const PASSWORD = "synthetic correct horse battery staple";
const ownerId = "plan-fixture-owner";
const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };
const capabilities = { "inventory.read": true, "health.read": true, "plan.read": true, apply: false, rollback: false, "sync.write": false } as const;

/** Real domain services and memory authorities. Never connects to a host target. */
export async function createArchitecturePlanFixture(t: Pick<TestContext, "after">, composed = false) {
  const authStore = new MemoryAuthStore("closed");
  const authService = new AuthService(authStore);
  const architectureStore = new MemoryArchitectureStore();
  const targetStore = new MemoryArchitectureTargetStore();
  const targetService = new ArchitectureTargetService(targetStore, new ArchitectureTargetBindingAuthorizer(architectureStore));
  const submissionService = new SubmissionService(new MemorySubmissionStore());
  const references = [];
  for (const [slug, version, domainId] of [["plan-alpha", "2.0.0", "build"], ["plan-beta", "1.0.0", "build"], ["plan-denied", "1.0.0", "review"]]) {
    const manifest = { name: slug, title: slug, summary: "Synthetic architecture journey", version, license: "Apache-2.0", visibility: "public" as const, platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" as const }], tags: ["fixture"] };
    const submitted = await submissionService.createSubmission({ actor: { id: ownerId, roles: ["author"] }, manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "README.md", content: "Synthetic architecture fixture." }, ...(composed ? [{path:"SKILL.md",content:`---\nname: ${slug}\ndescription: Synthetic composed instructions\n---\nExact ${slug}@${version} bytes.\n`},{path:"references/context.txt",content:`Asset ${slug}@${version}\n`}] : [])] });
    await submissionService.performReviewAction({ actor: { id: "plan-fixture-maintainer", roles: ["maintainer"] }, submissionId: submitted.id, action: "approve", artifactSha256: submitted.artifact.sha256 });
    await submissionService.performReviewAction({ actor: { id: "plan-fixture-maintainer", roles: ["maintainer"] }, submissionId: submitted.id, action: "publish" });
    references.push({ id: slug, slug, title: slug, version, digest: submitted.artifact.sha256, packageVisibility: "public" as const, domainId });
  }
  const skillRepository = new MemorySkillRepository(references.map(reference => ({ slug: reference.slug, title: reference.slug, summary: "Synthetic architecture journey", lifecycleStatus: "approved" as const, visibility: "public" as const, latestVersion: reference.version, reviewStatus: "approved" as const, securityStatus: "passed" as const, platforms: [], tags: [], ownerUserId: ownerId })));
  const architecture = await architectureStore.createArchitecture({ actor: ownerId, owner: { type: "user", id: ownerId }, name: "Plan journey", description: "", patternId: "multi-level-router" });
  const spec = createMultiLevelRouterArchitecture({ id: architecture.id, name: architecture.name, skills: references, profile: { id: "plan-personal", subject: { type: "user", id: ownerId } }, environment: { id: "plan-workspace", kind: "personal" } });
  spec.description = "Synthetic review context. ".repeat(10);
  spec.profiles[0].bindings = spec.profiles[0].bindings.map(binding => binding.nodeId === "leaf-plan-denied" ? { ...binding, enabled: false, runtimeExposure: "disabled" as const } : binding);
  const revision = await architectureStore.createRevision({ actor: ownerId, architectureId: architecture.id, expectedCurrentRevisionId: null, message: "Mixed exact releases and profile denial", spec });
  assert.ok(revision);
  const registered = await targetService.registerTarget({ actor: ownerId, name: "Synthetic Codex target", architectureId: architecture.id, profileId: "plan-personal", environmentId: "plan-workspace", adapter: composed ? {kind:"codex-workspace",version:"1.0.0",contractVersion:2} : adapter, capabilities: composed ? {...capabilities,apply:true,rollback:true,"sync.write":true} : capabilities });
  const target = await targetService.setConsent({ actor: ownerId, targetId: registered.id, decision: "grant" });
  let sequence = 0;
  async function appendObservation(overrides: Partial<ArchitectureTargetObservationInput> = {}) {
    const current = await targetService.getTarget(ownerId, target.id);
    assert.ok(current);
    return targetService.appendObservation({ actor: ownerId, targetId: target.id, observation: { schemaVersion: 1, id: `plan-observation-${++sequence}`, targetId: target.id, targetGeneration: current.generation, adapterDigest: architectureTargetAdapterDigest(current.adapter), capabilitiesDigest: architectureTargetCapabilitiesDigest(current.capabilities, current.adapter.contractVersion), observedAt: new Date(Date.parse("2026-09-30T00:00:00Z") + sequence * 1000).toISOString(), skills: [{ slug: "plan-alpha", version: "1.0.0", digest: "a".repeat(64), enabled: true, runtimeExposure: "leaf", managed: true }, { slug: "plan-beta", version: "2.0.0", digest: "b".repeat(64), enabled: true, runtimeExposure: "leaf", managed: true }, { slug: "plan-denied", version: "1.0.0", digest: references[2].digest, enabled: true, runtimeExposure: "leaf", managed: true }], configFindings: [], promptAwareness: { detected: true, count: 2, redacted: true }, ...overrides } });
  }
  const observation = await appendObservation();
  const syncStore = new MemoryArchitectureSyncStore();
  const planService = new ArchitecturePlanService(syncStore, { architectureStore, targetStore, releaseDependencies: { skillRepository, submissionService } });
  const app = buildApp({ authService, architectureStore, architectureTargetService: targetService, submissionService, skillRepository, architecturePlanService: planService });
  t.after(() => app.close());
  async function login(id: string, email: string) {
    authStore.addUser({ id, email, name: id, status: "active", emailVerifiedAt: new Date(), roles: ["user"], passwordHash: await hashPassword(PASSWORD) });
    const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: PASSWORD } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().token as string;
  }
  const ownerEmail = "plan-fixture-owner@example.com";
  const plain = await login(ownerId, ownerEmail);
  const enrollment = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { authorization: `Bearer ${plain}` }, payload: { password: PASSWORD } });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirmed = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { authorization: `Bearer ${plain}` }, payload: { factorId: enrollment.json().enrollment.factorId, code: generateTotpCode(enrollment.json().enrollment.secret) } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const challenge = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: ownerEmail, password: PASSWORD } });
  const verified = await app.inject({ method: "POST", url: "/v1/auth/mfa/verify", payload: { challengeToken: challenge.json().challengeToken, recoveryCode: confirmed.json().mfa.recoveryCodes[0] } });
  assert.equal(verified.statusCode, 200, verified.body);
  const owner = verified.json().token as string;
  const outsider = await login("plan-fixture-outsider", "plan-fixture-outsider@example.com");
  const request = { revisionId: revision.id, expectedTargetGeneration: target.generation, expectedObservationId: observation.id!, expectedObservationDigest: observation.observedDigest, idempotencyKey: "plan-fixture-request" };
  return { app, authService, authStore, architectureStore, targetStore, targetService, submissionService, skillRepository, syncStore, planService, target, revision, spec, request, sessions: { owner, plain, outsider }, ownerId, appendObservation, references };
}
