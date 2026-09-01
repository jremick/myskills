import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createFlatArchitecture } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryArchitectureOrganizationGrantStore } from "../src/architectures/memory-organization-grant-store.js";
import { ArchitectureOrganizationGrantService } from "../src/architectures/organization-grant-service.js";
import { MemoryPatternMigrationStore } from "../src/architectures/memory-pattern-migration-store.js";
import { ArchitecturePatternMigrationService } from "../src/architectures/pattern-migration-service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const PASSWORD = "correct horse battery staple";
const ownerId = "advanced-routes-owner";
const ownerEmail = "advanced-routes-owner@example.com";

test("organization grant routes are session-only, manager-gated, MFA-protected, and support disabled-sharing revoke", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const grantStore = new MemoryArchitectureOrganizationGrantStore();
  const architecture = await architectureStore.createArchitecture({
    ownerUserId: ownerId,
    name: "Grant route architecture",
    description: "",
    patternId: "flat",
  });
  const revision = await architectureStore.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial",
    spec: createFlatArchitecture({
      id: architecture.id,
      name: architecture.name,
      skills: [{
        id: "grant-skill",
        slug: "grant-skill",
        version: "1.0.0",
        digest: "a".repeat(64),
        packageVisibility: "public",
      }],
    }),
  });
  assert.ok(revision);
  grantStore.addGrant({
    architectureId: architecture.id,
    organizationId: "organization-to-revoke",
    accessLevel: "read",
    createdUnderPolicyRevisionId: "policy-1",
  });
  const grantService = new ArchitectureOrganizationGrantService({
    architectureStore,
    organizationStore: {
      async getOrganization() { return null; },
      async findMembership() { return null; },
      async getPolicyRevision() { return null; },
    },
    grantStore,
    organizationVisibilityEnabled: false,
    releaseAuthorizer: async () => true,
  });
  const app = buildApp({
    skillRepository: new MemorySkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    architectureOrganizationGrantService: grantService,
  });
  t.after(() => app.close());

  const session = await addUserAndLogin(app, authStore);
  const listed = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().organizationIds, ["organization-to-revoke"]);
  assert.equal(listed.json().currentRevisionId, revision.id);

  const apiToken = await createApiToken(app, session);
  const tokenRead = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${apiToken}` },
  });
  assert.equal(tokenRead.statusCode, 403);
  assert.equal(tokenRead.json().error.code, "SESSION_AUTH_REQUIRED");

  const withoutMfa = await app.inject({
    method: "PUT",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${session}` },
    payload: { expectedCurrentRevisionId: revision.id, organizationIds: [] },
  });
  assert.equal(withoutMfa.statusCode, 403);
  assert.equal(withoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const mfaSession = await verifyMfaForSession(app, session);
  const unknownField = await app.inject({
    method: "PUT",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { expectedCurrentRevisionId: revision.id, organizationIds: [], unexpected: true },
  });
  assert.equal(unknownField.statusCode, 400);

  const stale = await app.inject({
    method: "PUT",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { expectedCurrentRevisionId: "stale-revision", organizationIds: [] },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "ARCHITECTURE_REVISION_CONFLICT");

  const revoked = await app.inject({
    method: "PUT",
    url: `/v1/architectures/${architecture.id}/organization-grants`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: { expectedCurrentRevisionId: revision.id, organizationIds: [] },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.deepEqual(revoked.json().organizationIds, []);
  assert.deepEqual(await grantStore.listGrants(architecture.id), []);
});

test("pattern migration routes enforce session/MFA boundaries, bounded DTOs, blocked previews, and idempotent creates", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const architecture = await architectureStore.createArchitecture({
    ownerUserId: ownerId,
    name: "Pattern route architecture",
    description: "Source",
    patternId: "flat",
  });
  const revision = await architectureStore.createRevision({
    ownerUserId: ownerId,
    architectureId: architecture.id,
    expectedCurrentRevisionId: null,
    message: "Initial",
    spec: createFlatArchitecture({
      id: architecture.id,
      name: architecture.name,
      skills: [{
        id: "skill-alpha",
        slug: "skill-alpha",
        title: "Alpha",
        version: "1.0.0",
        digest: "a".repeat(64),
        packageVisibility: "public",
      }, {
        id: "skill-beta",
        slug: "skill-beta",
        title: "Beta",
        version: "1.0.0",
        digest: "b".repeat(64),
        packageVisibility: "public",
      }],
    }),
  });
  assert.ok(revision);
  const migrationStore = new MemoryPatternMigrationStore();
  const migrationService = new ArchitecturePatternMigrationService(architectureStore, migrationStore, {
    idFactory: (() => {
      let next = 1;
      return () => `route-derived-${next++}`;
    })(),
    releaseAuthorizer: { authorize: async () => true },
  });
  const app = buildApp({
    skillRepository: new MemorySkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    architecturePatternMigrationService: migrationService,
    architectureProjectionLimiter: new MemoryAuthRateLimiter({ maxAttempts: 30, windowMs: 60_000 }),
  });
  t.after(() => app.close());

  const session = await addUserAndLogin(app, authStore);
  const apiToken = await createApiToken(app, session);
  const previewInput = {
    expectedCurrentRevisionId: revision.id,
    targetPatternId: "multi-level-router",
  };
  const tokenPreview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations/preview`,
    headers: { authorization: `Bearer ${apiToken}` },
    payload: previewInput,
  });
  assert.equal(tokenPreview.statusCode, 403);
  assert.equal(tokenPreview.json().error.code, "SESSION_AUTH_REQUIRED");

  const unknownField = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations/preview`,
    headers: { authorization: `Bearer ${session}` },
    payload: { ...previewInput, release: "latest" },
  });
  assert.equal(unknownField.statusCode, 400);

  const blocked = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations/preview`,
    headers: { authorization: `Bearer ${session}` },
    payload: {
      ...previewInput,
      mapping: {
        routerGroups: [{ id: "router-alpha", label: "Alpha", leafNodeIds: ["leaf-skill-alpha"] }],
        allowUnassignedLeafFallback: false,
      },
    },
  });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(blocked.json().migration.mappingStatus, "blocked");
  assert.equal(blocked.json().migration.target, null);

  const createInput = {
    ...previewInput,
    idempotencyKey: "route-pattern-migration-1",
    name: "Derived router",
    description: "Derived description",
    message: "Derived from source",
  };
  const withoutMfa = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations`,
    headers: { authorization: `Bearer ${session}` },
    payload: createInput,
  });
  assert.equal(withoutMfa.statusCode, 403);
  assert.equal(withoutMfa.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const mfaSession = await verifyMfaForSession(app, session);
  const created = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: createInput,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().created, true);
  assert.equal(created.json().replayed, false);
  assert.ok(created.json().persisted.targetArchitecture.id);
  assert.equal(created.json().persisted.targetRevision.spec, undefined);

  const replay = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architecture.id}/pattern-migrations`,
    headers: { authorization: `Bearer ${mfaSession}` },
    payload: createInput,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().created, false);
  assert.equal(replay.json().replayed, true);
  assert.equal(replay.json().persisted.targetArchitecture.id, created.json().persisted.targetArchitecture.id);
});

async function addUserAndLogin(app: ReturnType<typeof buildApp>, authStore: MemoryAuthStore): Promise<string> {
  authStore.addUser({
    id: ownerId,
    email: ownerEmail,
    name: "Advanced routes owner",
    status: "active",
    emailVerifiedAt: new Date(),
    roles: ["author"],
    passwordHash: await hashPassword(PASSWORD),
  });
  const response = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: ownerEmail, password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  return response.json().token;
}

async function createApiToken(app: ReturnType<typeof buildApp>, session: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: { name: "Advanced route read token", scopes: ["architectures:read"] },
  });
  assert.equal(response.statusCode, 201);
  return response.json().token.token;
}

async function verifyMfaForSession(app: ReturnType<typeof buildApp>, session: string): Promise<string> {
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: { password: PASSWORD },
  });
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: ownerEmail, password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return verify.json().token;
}
