import assert from "node:assert/strict";
import test from "node:test";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import { createArchitectureDiagramArtifact, createFlatArchitecture, type ArchitectureSpecV1, type CompiledArchitecture } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import type { SubmissionService } from "../src/submissions/service.js";

const safeSlug = "draft-safe-skill";
const privateSlug = "draft-private-skill";
const safeDigest = "a".repeat(64);
const privateDigest = "b".repeat(64);

test("owner draft preview returns authoritative noncanonical projections and only audits a fixture plan", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    authService: new AuthService(authStore),
    architectureStore,
    skillRepository: new MemorySkillRepository([releasedSkill(safeSlug, "private", "draft-owner")]),
    submissionService: releaseResolver(),
  });
  t.after(() => app.close());

  const session = await addUserAndLogin(app, authStore, "draft-owner", "draft-owner@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      name: "Authoritative architecture",
      description: "Shell description",
      patternId: "flat",
    },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const draftSpec = createFlatArchitecture({
    id: "client-supplied-id",
    name: "Client supplied name",
    description: "Client supplied description",
    skills: [{
      id: safeSlug,
      slug: safeSlug,
      title: "Draft-safe skill",
      version: "1.0.0",
      digest: safeDigest,
      packageVisibility: "private",
    }],
  });
  const response = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/draft-preview`,
    headers: { authorization: `Bearer ${session}` },
    payload: {
      expectedCurrentRevisionId: null,
      profileId: "client-supplied-id-profile",
      environmentId: "client-supplied-id-personal",
      spec: draftSpec,
      fixture: { targetId: "draft-target", skills: [] },
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    draft: { expectedCurrentRevisionId: string | null; spec: ArchitectureSpecV1 };
    compiled: CompiledArchitecture;
    graph: { digest: string };
    outline: { title: string };
    diagram: {
      architectureId: string;
      revisionDigest: string;
      profileId?: string;
      environmentId?: string;
      accessibleOutline: string;
      mermaid: string;
      artifactDigest: string;
    };
    plan?: { dryRun: boolean; items: Array<{ action: string }> };
    revision?: unknown;
  };
  assert.equal(body.revision, undefined);
  assert.equal(body.draft.expectedCurrentRevisionId, null);
  assert.equal(body.draft.spec.id, architectureId);
  assert.equal(body.draft.spec.name, "Authoritative architecture");
  assert.equal(body.draft.spec.description, "Shell description");
  assert.deepEqual(body.draft.spec.pattern, { id: "flat", version: 1 });
  assert.equal(body.compiled.architectureId, architectureId);
  assert.equal(body.compiled.profileId, "client-supplied-id-profile");
  assert.equal(body.compiled.environmentId, "client-supplied-id-personal");
  assert.equal(body.graph.digest, body.compiled.revisionDigest);
  assert.equal(body.outline.title, `Architecture ${architectureId}`);
  assert.equal(body.diagram.architectureId, architectureId);
  assert.equal(body.diagram.revisionDigest, body.compiled.revisionDigest);
  assert.equal(body.diagram.profileId, body.compiled.profileId);
  assert.equal(body.diagram.environmentId, body.compiled.environmentId);
  assert.equal(body.diagram.artifactDigest, createArchitectureDiagramArtifact(body.compiled).artifactDigest);
  assert.match(body.diagram.mermaid, /^accTitle:/m);
  assert.match(body.diagram.accessibleOutline, /Draft-safe skill/);
  assert.doesNotMatch(JSON.stringify(body.diagram), /(?:\/Users\/|draft-owner@example\.com|credential|password)/i);
  assert.equal(body.plan?.dryRun, true);
  assert.equal(body.plan?.items.filter((item) => item.action === "install").length, 1);

  assert.deepEqual(await architectureStore.listRevisions("draft-owner", architectureId), []);
  const events = await architectureStore.listAuditEvents();
  assert.equal(events[0]?.action, "architecture.draft_preview.dry_run");
  assert.equal(events[0]?.details.expectedCurrentRevisionId, null);
  assert.equal(events[0]?.details.profileId, "client-supplied-id-profile");
  assert.equal(events[0]?.details.environmentId, "client-supplied-id-personal");
  assert.equal(events[0]?.details.revisionId, undefined);
  assert.equal(events[0]?.details.spec, undefined);
});

test("draft preview rejects a stale base without persisting a revision", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    authService: new AuthService(authStore),
    architectureStore,
    skillRepository: new MemorySkillRepository([releasedSkill(safeSlug, "private", "stale-owner")]),
    submissionService: releaseResolver(),
  });
  t.after(() => app.close());

  const session = await addUserAndLogin(app, authStore, "stale-owner", "stale-owner@example.com");
  const created = await createArchitecture(app, session, "Stale draft architecture");
  const firstRevision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${created.id}/revisions`,
    headers: { authorization: `Bearer ${session}` },
    payload: {
      expectedCurrentRevisionId: null,
      spec: flatSpec("client-revision-id", safeSlug, "private"),
    },
  });
  assert.equal(firstRevision.statusCode, 201);
  const currentRevisionId = firstRevision.json().revision.id as string;

  const stale = await app.inject({
    method: "POST",
    url: `/v1/architectures/${created.id}/draft-preview`,
    headers: { authorization: `Bearer ${session}` },
    payload: {
      expectedCurrentRevisionId: null,
      spec: flatSpec("client-draft-id", safeSlug, "private"),
    },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "ARCHITECTURE_REVISION_CONFLICT");
  assert.equal(stale.json().error.details.currentRevisionId, currentRevisionId);
  assert.equal((await architectureStore.listRevisions("stale-owner", created.id))?.length, 1);
});

test("team draft preview is owner-only, session-only, and rejects exact team-private references", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const teamId = "draft-team";
  const architectureStore = new MemoryArchitectureStore({
    teamMemberships: [
      { userId: "draft-team-owner", teamId, role: "owner" },
      { userId: "draft-team-member", teamId, role: "member" },
    ],
  });
  const skillRepository = new MemorySkillRepository([
    releasedSkill(safeSlug, "team", "draft-team-owner"),
    releasedSkill(privateSlug, "private", "draft-team-owner"),
  ]);
  skillRepository.addTeamGrant(safeSlug, teamId);
  const app = buildApp({
    authService: new AuthService(authStore),
    architectureStore,
    skillRepository,
    submissionService: releaseResolver(),
  });
  t.after(() => app.close());

  const ownerSession = await addUserAndLoginWithMfa(app, authStore, "draft-team-owner", "draft-team-owner@example.com");
  const memberSession = await addUserAndLogin(app, authStore, "draft-team-member", "draft-team-member@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { name: "Team draft architecture", patternId: "flat", owner: { type: "team", id: teamId } },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const memberDenied = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/draft-preview`,
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec("client-member-id", safeSlug) },
  });
  assert.equal(memberDenied.statusCode, 403);
  assert.equal(memberDenied.json().error.code, "TEAM_OWNER_REQUIRED");

  const privateDenied = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/draft-preview`,
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec("client-private-id", privateSlug) },
  });
  assert.equal(privateDenied.statusCode, 422);
  assert.equal(privateDenied.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
  assert.deepEqual(await architectureStore.listRevisions("draft-team-owner", architectureId), []);

  const tokenResponse = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${memberSession}` },
    payload: { name: "Draft preview reader", scopes: ["architectures:read"] },
  });
  assert.equal(tokenResponse.statusCode, 201);
  const apiToken = tokenResponse.json().token.token as string;
  const tokenDenied = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/draft-preview`,
    headers: { authorization: `Bearer ${apiToken}` },
    payload: { expectedCurrentRevisionId: null, spec: flatSpec("client-token-id", safeSlug) },
  });
  assert.equal(tokenDenied.statusCode, 403);
  assert.equal(tokenDenied.json().error.code, "SESSION_AUTH_REQUIRED");
});

function flatSpec(
  id: string,
  slug: string,
  packageVisibility: "team" | "private" = slug === safeSlug ? "team" : "private",
): ArchitectureSpecV1 {
  return createFlatArchitecture({
    id,
    name: "Client draft",
    skills: [{
      id: slug,
      slug,
      title: slug,
      version: "1.0.0",
      digest: slug === safeSlug ? safeDigest : privateDigest,
      packageVisibility,
    }],
  });
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
      artifact: { sha256: slug === safeSlug ? safeDigest : privateDigest },
    }),
  } as unknown as SubmissionService;
}

async function createArchitecture(
  app: ReturnType<typeof buildApp>,
  session: string,
  name: string,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${session}` },
    payload: { name, patternId: "flat" },
  });
  assert.equal(response.statusCode, 201);
  return { id: response.json().architecture.id as string };
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
