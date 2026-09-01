import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createFlatArchitecture, type ArchitectureSpecV1 } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { SubmissionService } from "../src/submissions/service.js";

const teamId = "team-architecture";
const safeSlug = "team-safe-skill";
const privateSlug = "writer-private-skill";

test("team architecture routes enforce owner writes, member reads, and exact team-safe skill references", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore({
    teamMemberships: [
      { userId: "team-owner", teamId, role: "owner" },
      { userId: "team-member", teamId, role: "member" },
    ],
  });
  const skillRepository = new MemorySkillRepository([
    releasedSkill(safeSlug, "team", "team-owner"),
    releasedSkill(privateSlug, "private", "team-owner"),
  ]);
  skillRepository.addTeamGrant(safeSlug, teamId);
  const app = buildApp({
    authService: new AuthService(authStore),
    architectureStore,
    skillRepository,
    submissionService: releaseResolver(),
  });
  t.after(() => app.close());

  const ownerSessionWithoutMfa = await addUserAndLogin(app, authStore, "team-owner", "owner@example.com");
  const ownerSession = await addUserAndLoginWithMfa(app, authStore, "team-owner", "owner@example.com");
  const memberSession = await addUserAndLogin(app, authStore, "team-member", "member@example.com");
  const outsiderSession = await addUserAndLogin(app, authStore, "outsider", "outsider@example.com");

  const ownerMfaRequired = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${ownerSessionWithoutMfa}` },
    payload: {
      name: "MFA required team architecture",
      patternId: "flat",
      owner: { type: "team", id: teamId },
    },
  });
  assert.equal(ownerMfaRequired.statusCode, 403);
  assert.equal(ownerMfaRequired.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      name: "Team routing",
      patternId: "flat",
      owner: { type: "team", id: teamId },
    },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().architecture.owner, { type: "team", id: teamId });
  assert.equal(created.json().architecture.access.canAppend, true);
  const architectureId = created.json().architecture.id as string;

  const deniedPrivateReference = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec(architectureId, privateSlug) },
  });
  assert.equal(deniedPrivateReference.statusCode, 422);
  assert.equal(deniedPrivateReference.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
  assert.deepEqual(await architectureStore.listRevisions("team-owner", architectureId), []);

  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      message: "Team-safe first revision",
      expectedCurrentRevisionId: null,
      spec: { ...flatSpec(architectureId, safeSlug), name: "Client cannot rename the shell" },
    },
  });
  assert.equal(revision.statusCode, 201);
  assert.equal(revision.json().revision.spec.name, "Team routing");
  assert.equal(revision.json().revision.spec.pattern.id, "flat");
  const revisionId = revision.json().revision.id as string;

  const staleDraft = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: {
      expectedCurrentRevisionId: null,
      spec: flatSpec(architectureId, safeSlug),
    },
  });
  assert.equal(staleDraft.statusCode, 409);
  assert.equal(staleDraft.json().error.code, "ARCHITECTURE_REVISION_CONFLICT");
  assert.equal(staleDraft.json().error.details.currentRevisionId, revisionId);

  const memberList = await app.inject({
    method: "GET",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${memberSession}` },
  });
  assert.equal(memberList.statusCode, 200);
  assert.deepEqual(memberList.json().architectures.map((item: { id: string }) => item.id), [architectureId]);
  assert.equal(memberList.json().architectures[0].access.canAppend, false);

  const tokenResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { name: "Team architecture reader", scopes: ["architectures:read"] },
  });
  assert.equal(tokenResponse.statusCode, 201);
  const memberApiToken = tokenResponse.json().token.token as string;
  const tokenRead = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${memberApiToken}` },
  });
  assert.equal(tokenRead.statusCode, 200);
  const tokenWrite = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${memberApiToken}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec(architectureId, safeSlug) },
  });
  assert.equal(tokenWrite.statusCode, 403);
  assert.equal(tokenWrite.json().error.code, "SESSION_AUTH_REQUIRED");

  const memberPreview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { revisionId, profileId: "default", environmentId: "default" },
  });
  assert.equal(memberPreview.statusCode, 200);
  assert.equal(memberPreview.json().compiled.skills[0].slug, safeSlug);

  const deniedMemberWrite = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec(architectureId, safeSlug) },
  });
  assert.equal(deniedMemberWrite.statusCode, 403);
  assert.equal(deniedMemberWrite.json().error.code, "TEAM_OWNER_REQUIRED");

  const outsiderRead = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${outsiderSession}` },
  });
  assert.equal(outsiderRead.statusCode, 404);
  assert.equal(outsiderRead.json().error.code, "ARCHITECTURE_NOT_FOUND");
});

test("architecture owner input cannot select another user or an unsupported tenant type", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    authService: new AuthService(authStore),
    architectureStore: new MemoryArchitectureStore(),
    skillRepository: new MemorySkillRepository([]),
    submissionService: releaseResolver(),
  });
  t.after(() => app.close());
  const session = await addUserAndLogin(app, authStore, "author-user", "author@example.com");

  for (const owner of [
    { type: "user", id: "other-user" },
    { type: "organization", id: "org-one" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/architectures",
      headers: { authorization: `Bearer ${session}` },
      payload: { name: "Denied owner", patternId: "flat", owner },
    });
    assert.equal(response.statusCode, 400);
  }
});

function flatSpec(architectureId: string, slug: string): ArchitectureSpecV1 {
  const spec = createFlatArchitecture({
    id: architectureId,
    name: "Team routing",
    skills: [{
      id: slug,
      slug,
      version: "1.0.0",
      digest: digestForSlug(slug),
      packageVisibility: slug === safeSlug ? "team" : "private",
    }],
  });
  spec.profiles[0]!.id = "default";
  spec.environments[0]!.id = "default";
  spec.environments[0]!.profileId = "default";
  return spec;
}

function releasedSkill(slug: string, visibility: "team" | "private", ownerUserId: string) {
  return {
    slug,
    title: slug,
    summary: "Fixture skill",
    lifecycleStatus: "approved" as const,
    visibility,
    latestVersion: "1.0.0",
    reviewStatus: "approved" as const,
    securityStatus: "passed" as const,
    platforms: [],
    tags: [],
    ownerUserId,
  };
}

function releaseResolver(): SubmissionService {
  return {
    getPublicRelease: async ({ slug, version }: { slug: string; version: string }) => ({
      slug,
      title: slug,
      summary: "Fixture release",
      version,
      artifact: { sha256: digestForSlug(slug) },
    }),
  } as unknown as SubmissionService;
}

function digestForSlug(slug: string): string {
  return (slug === safeSlug ? "a" : "b").repeat(64);
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
  return response.json().token;
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
  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${setupSession}` },
    payload: {
      factorId: enrollment.json().enrollment.factorId,
      code: generateTotpCode(enrollment.json().enrollment.secret),
    },
  });
  assert.equal(confirm.statusCode, 200);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  return verify.json().token;
}
