import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import {
  architectureTargetAdapterDigest,
  architectureTargetCapabilitiesDigest,
  createFlatArchitecture,
  type ArchitectureSpecV1,
  type ArchitectureTargetObservationInput,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { ArchitectureTargetBindingAuthorizer } from "../src/targets/architecture-binding-authorizer.js";
import { MemoryArchitectureTargetStore } from "../src/targets/memory-target-store.js";
import { ArchitectureTargetService } from "../src/targets/service.js";
import type { SubmissionService } from "../src/submissions/service.js";
import type { ArchitectureTargetRecord } from "../src/targets/types.js";

const fixtureSkill = {
  id: "target-fixture-skill",
  slug: "target-fixture-skill",
  version: "1.0.0",
  digest: "a".repeat(64),
} as const;

const adapter = { kind: "codex", version: "1.0.0", contractVersion: 1 as const };
const capabilities = {
  "inventory.read": true,
  "health.read": true,
  "plan.read": true,
  apply: false,
  rollback: false,
} as const;

test("architecture target routes bind targets, protect credentials, and gate observations", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());
  const { architectureId } = await createArchitectureWithRevision(fixture, "target-owner");

  const capabilitiesResponse = await fixture.app.inject({
    method: "GET",
    url: "/v1/capabilities",
  });
  assert.equal(capabilitiesResponse.statusCode, 200);
  assert.equal(capabilitiesResponse.json().capabilities.architectureTargets, true);

  const unauthenticated = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "AUTHENTICATION_REQUIRED");

  const apiToken = await createApiToken(fixture.app, fixture.session, ["architectures:read"]);
  const tokenRead = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(tokenRead.statusCode, 403);
  assert.equal(tokenRead.json().error.code, "SESSION_AUTH_REQUIRED");

  const mfaRequired = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.sessionWithoutMfa}` },
    payload: {
      name: "MFA required target",
      architectureId,
      environmentId: "personal-mac",
      profileId: "personal",
      adapter,
      capabilities,
    },
  });
  assert.equal(mfaRequired.statusCode, 403);
  assert.equal(mfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const registered = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: {
      name: "Personal Codex",
      architectureId,
      environmentId: "personal-mac",
      profileId: "personal",
      adapter,
      capabilities,
      credentialReference: "keychain-target-route-1",
      metadata: { label: "Personal" },
    },
  });
  assert.equal(registered.statusCode, 201);
  const target = registered.json().target as ArchitectureTargetRecord;
  assert.equal("credentialReference" in target, false);
  assert.deepEqual(target.owner, { type: "user", id: "target-owner" });
  assert.equal(target.architectureId, architectureId);
  assert.equal(target.environmentId, "personal-mac");
  assert.equal(target.profileId, "personal");
  assert.equal(target.consent.status, "pending");

  const listed = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().targets.map((item: { id: string }) => item.id), [target.id]);

  const detail = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${fixture.session}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().target.id, target.id);
  assert.equal("credentialReference" in detail.json().target, false);

  const beforeConsent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: observationPayload(target),
  });
  assert.equal(beforeConsent.statusCode, 409);
  assert.equal(beforeConsent.json().error.code, "ARCHITECTURE_TARGET_CONSENT_REQUIRED");

  const consentMfaRequired = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${fixture.sessionWithoutMfa}` },
    payload: { decision: "grant" },
  });
  assert.equal(consentMfaRequired.statusCode, 403);
  assert.equal(consentMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const consent = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/consent`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: { decision: "grant" },
  });
  assert.equal(consent.statusCode, 200);
  assert.equal(consent.json().target.consent.status, "granted");

  const health = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/health`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: { status: "healthy", checkedAt: "2026-08-30T00:02:00.000Z" },
  });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().target.status, "connected");
  assert.equal(health.json().target.health.status, "healthy");

  const appended = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: observationPayload(target),
  });
  assert.equal(appended.statusCode, 201);
  assert.equal(appended.json().observation.targetId, target.id);
  assert.equal(appended.json().observation.observedDigest.length, 64);

  const observations = await fixture.app.inject({
    method: "GET",
    url: `/v1/architecture-targets/${target.id}/observations?limit=1`,
    headers: { authorization: `Bearer ${fixture.session}` },
  });
  assert.equal(observations.statusCode, 200);
  assert.equal(observations.json().observations.length, 1);
  assert.equal(observations.json().observations[0].targetId, target.id);

  const revokeMfaRequired = await fixture.app.inject({
    method: "DELETE",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${fixture.sessionWithoutMfa}` },
  });
  assert.equal(revokeMfaRequired.statusCode, 403);
  assert.equal(revokeMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const revoked = await fixture.app.inject({
    method: "DELETE",
    url: `/v1/architecture-targets/${target.id}`,
    headers: { authorization: `Bearer ${fixture.session}` },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.json().target.status, "revoked");
  assert.equal(revoked.json().target.consent.status, "revoked");

  const afterRevoke = await fixture.app.inject({
    method: "POST",
    url: `/v1/architecture-targets/${target.id}/observations`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: observationPayload(target),
  });
  assert.equal(afterRevoke.statusCode, 410);
  assert.equal(afterRevoke.json().error.code, "ARCHITECTURE_TARGET_REVOKED");
});

test("architecture target registration denies mismatched owners and unsafe payloads", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());
  const { architectureId } = await createArchitectureWithRevision(fixture, "target-owner");

  const mismatchedOwner = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: {
      name: "Wrong owner",
      owner: { type: "user", id: "other-owner" },
      architectureId,
      environmentId: "personal-mac",
      profileId: "personal",
      adapter,
      capabilities,
    },
  });
  assert.equal(mismatchedOwner.statusCode, 403);
  assert.equal(mismatchedOwner.json().error.code, "ARCHITECTURE_TARGET_BINDING_FORBIDDEN");
  assert.equal(mismatchedOwner.json().error.details.reason, "owner-mismatch");

  const mutationCapability = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: {
      name: "Write target",
      architectureId,
      environmentId: "personal-mac",
      profileId: "personal",
      adapter,
      capabilities: { ...capabilities, apply: true },
    },
  });
  assert.equal(mutationCapability.statusCode, 400);
  assert.equal(mutationCapability.json().error.code, "INVALID_ARCHITECTURE_TARGET");

  const credentialEchoProbe = await fixture.app.inject({
    method: "POST",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: {
      name: "Bad metadata",
      architectureId,
      environmentId: "personal-mac",
      profileId: "personal",
      adapter,
      capabilities,
      metadata: { secret: "do-not-echo-this-value" },
    },
  });
  assert.equal(credentialEchoProbe.statusCode, 400);
  assert.equal(credentialEchoProbe.json().error.code, "INVALID_ARCHITECTURE_TARGET");
  assert.equal(JSON.stringify(credentialEchoProbe.json()).includes("do-not-echo-this-value"), false);

  const listed = await fixture.app.inject({
    method: "GET",
    url: "/v1/architecture-targets",
    headers: { authorization: `Bearer ${fixture.session}` },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().targets, []);
});

async function createFixture(): Promise<{
  app: ReturnType<typeof buildApp>;
  architectureStore: MemoryArchitectureStore;
  session: string;
  sessionWithoutMfa: string;
}> {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const targetStore = new MemoryArchitectureTargetStore({
    now: () => new Date("2026-08-30T00:00:00.000Z"),
  });
  let nextId = 0;
  const architectureTargetService = new ArchitectureTargetService(
    targetStore,
    new ArchitectureTargetBindingAuthorizer(architectureStore),
    {
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      idFactory: () => `target-route-${++nextId}`,
    },
  );
  const app = buildApp({
    skillRepository: new MemorySkillRepository([{
      slug: fixtureSkill.slug,
      title: "Target fixture skill",
      summary: "Public-safe test fixture.",
      lifecycleStatus: "approved",
      visibility: "private",
      latestVersion: fixtureSkill.version,
      reviewStatus: "approved",
      securityStatus: "passed",
      platforms: [],
      tags: [],
      ownerUserId: "target-owner",
    }]),
    authService: new AuthService(authStore),
    architectureStore,
    architectureTargetService,
    submissionService: releaseResolver(),
  });
  const sessionWithoutMfa = await addUserAndLogin(app, authStore, "target-owner", "target-owner@example.com");
  const session = await addUserAndLoginWithMfa(app, authStore, "target-owner", "target-owner@example.com");
  return { app, architectureStore, session, sessionWithoutMfa };
}

async function createArchitectureWithRevision(
  fixture: { app: ReturnType<typeof buildApp>; session: string },
  ownerId: string,
): Promise<{ architectureId: string; revisionId: string }> {
  const created = await fixture.app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: { name: "Target architecture", patternId: "flat" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  const revision = await fixture.app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${fixture.session}` },
    payload: {
      expectedCurrentRevisionId: null,
      spec: targetSpec(architectureId, ownerId),
    },
  });
  assert.equal(revision.statusCode, 201, revision.body);
  return { architectureId, revisionId: revision.json().revision.id as string };
}

function targetSpec(architectureId: string, ownerId: string): ArchitectureSpecV1 {
  return createFlatArchitecture({
    id: architectureId,
    name: "Target architecture",
    profile: { id: "personal", subject: { type: "user", id: ownerId } },
    environment: { id: "personal-mac", kind: "personal" },
    skills: [fixtureSkill],
  });
}

function observationPayload(target: ArchitectureTargetRecord): ArchitectureTargetObservationInput {
  return {
    schemaVersion: 1,
    targetGeneration: target.generation,
    adapterDigest: architectureTargetAdapterDigest(target.adapter),
    capabilitiesDigest: architectureTargetCapabilitiesDigest(target.capabilities),
    observedAt: "2026-08-30T00:01:00.000Z",
    skills: [],
    configFindings: [],
    promptAwareness: { detected: false, count: 0, redacted: true },
  } as ArchitectureTargetObservationInput;
}

async function addUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  id: string,
  email: string,
): Promise<string> {
  authStore.addUser({
    id,
    email,
    name: id,
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["author"],
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200);
  return response.json().token as string;
}

async function addUserAndLoginWithMfa(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  id: string,
  email: string,
): Promise<string> {
  const setupSession = await addUserAndLogin(app, authStore, id, email);
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: { password: "correct horse battery staple" },
  });
  assert.equal(enrollment.statusCode, 201);
  const confirmed = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirmed.statusCode, 200);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirmed.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verified.statusCode, 200);
  assert.equal(verified.json().user.mfaVerified, true);
  return verified.json().token as string;
}

async function createApiToken(
  app: ReturnType<typeof buildApp>,
  session: string,
  scopes: string[],
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: { name: `Target route ${scopes.join(",")}`, scopes },
  });
  assert.equal(response.statusCode, 201);
  return response.json().token.token as string;
}

function releaseResolver(): SubmissionService {
  return {
    getPublicRelease: async ({ slug, version }: { slug: string; version: string }) => {
      if (slug !== fixtureSkill.slug || version !== fixtureSkill.version) return null;
      return {
        slug,
        title: "Target fixture skill",
        summary: "Public-safe test fixture.",
        version,
        artifact: { sha256: fixtureSkill.digest },
      };
    },
  } as unknown as SubmissionService;
}
