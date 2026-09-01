import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpCode, hashPassword } from "@myskills-app/auth";
import {
  AppError,
  createArchitectureDiagramArtifact,
  createFlatArchitecture,
  defaultOrganizationPolicyV1,
  organizationPolicyDigest,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemoryOrganizationStore } from "../src/organizations/memory-organization-store.js";
import { OrganizationService } from "../src/organizations/service.js";
import { MemoryTeamStore } from "../src/teams/memory-team-store.js";
import { TeamService } from "../src/teams/service.js";
import type {
  ArchitectureActorInput,
  ArchitectureRevisionRecord,
  CreateArchitectureRevisionInput,
} from "../src/architectures/types.js";
import type { SubmissionService } from "../src/submissions/service.js";

const revisionSpec = {
  schemaVersion: "1",
  id: "my-routing-architecture",
  name: "My routing architecture",
  description: "Private profile-aware routing.",
  pattern: { id: "multi-level-router", version: 1 },
  skills: [{
    id: "release-notes",
    slug: "release-notes-helper",
    title: "Release notes",
    version: "1.0.0",
    digest: "a".repeat(64),
    packageVisibility: "public",
  }],
  nodes: [
    { id: "root", kind: "router", label: "All skills" },
    { id: "delivery", kind: "router", label: "Delivery" },
    {
      id: "release-notes",
      kind: "leaf",
      label: "Release notes",
      skillRefId: "release-notes",
    },
  ],
  edges: [
    { from: "root", to: "delivery", kind: "contains" },
    { from: "delivery", to: "release-notes", kind: "routes" },
  ],
  entryNodeIds: ["root"],
  profiles: [
    {
      id: "personal",
      name: "Personal",
      subject: { type: "user", id: "author-user" },
      defaultExposure: "disabled",
      bindings: [
        { nodeId: "root", enabled: true, runtimeExposure: "router" },
        { nodeId: "delivery", enabled: true, runtimeExposure: "router" },
        { nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" },
      ],
    },
    {
      id: "work",
      name: "Work",
      subject: { type: "user", id: "author-user" },
      defaultExposure: "disabled",
      bindings: [
        { nodeId: "root", enabled: true, runtimeExposure: "router" },
        { nodeId: "delivery", enabled: true, runtimeExposure: "router" },
      ],
    },
  ],
  environments: [
    { id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" },
    { id: "work-mac", name: "Work Mac", kind: "work", profileId: "work" },
  ],
} as const;

test("architecture routes expose patterns, private revisions, deterministic previews, and fixture-backed plans", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const patterns = await app.inject({ method: "GET", url: "/v1/architecture-patterns" });
  assert.equal(patterns.statusCode, 200);
  assert.deepEqual(patterns.json().patterns.map((pattern: { id: string }) => pattern.id), ["flat", "domain-router", "multi-level-router"]);

  const unauthenticated = await app.inject({ method: "GET", url: "/v1/architectures" });
  assert.equal(unauthenticated.statusCode, 401);

  const token = await addUserAndLogin(app, authStore, {
    id: "author-user",
    email: "author@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "My routing architecture",
      description: "Private profile-aware routing.",
      patternId: "multi-level-router",
    },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const missingRevisionToken = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { spec: revisionSpec },
  });
  assert.equal(missingRevisionToken.statusCode, 400);
  assert.equal(missingRevisionToken.json().error.code, "INVALID_REQUEST_BODY");

  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "Initial topology", expectedCurrentRevisionId: null, spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);
  assert.equal(revision.json().revision.revisionNumber, 1);
  const revisionId = revision.json().revision.id as string;

  const detail = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().revisions.length, 1);
  assert.equal(detail.json().revisions[0].spec, undefined);
  assert.equal(detail.json().latestRevision.spec.id, architectureId);

  const revisionSummaries = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(revisionSummaries.statusCode, 200);
  assert.equal(revisionSummaries.json().revisions[0].spec, undefined);
  assert.equal(revisionSummaries.json().revisions[0].patternId, "multi-level-router");

  const fullRevision = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}/revisions/${revisionId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(fullRevision.statusCode, 200);
  assert.equal(fullRevision.json().revision.spec.id, architectureId);

  const compiled = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });
  assert.equal(compiled.statusCode, 200);
  assert.equal(compiled.json().compiled.nodes.length, 3);
  assert.equal(compiled.json().plan, undefined);
  assert.equal(compiled.json().compiled.revisionDigest, (await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  })).json().compiled.revisionDigest);

  assert.equal(compiled.json().graph.nodes.find((node: { id: string }) => node.id === "delivery").y, 140);
  assert.match(compiled.json().outline.text, /All skills \(router\)/);
  assert.match(compiled.json().outline.text, /Release notes \(leaf\)/);
  assert.equal(compiled.json().diagram.revisionDigest, compiled.json().compiled.revisionDigest);
  assert.equal(compiled.json().diagram.artifactDigest, createArchitectureDiagramArtifact(compiled.json().compiled).artifactDigest);
  assert.match(compiled.json().diagram.mermaid, /^flowchart TD/m);
  assert.match(compiled.json().diagram.accessibleOutline, /All skills \(router\)/);

  const preview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      revisionId,
      profileId: "personal",
      environmentId: "personal-mac",
      fixture: { targetId: "preview-target", skills: [] },
    },
  });
  assert.equal(preview.statusCode, 200);
  assert.ok(preview.json().revision);
  assert.ok(preview.json().compiled);
  assert.ok(preview.json().graph);
  assert.ok(preview.json().outline);
  assert.ok(preview.json().plan);
  assert.equal(preview.json().plan.dryRun, true);
  assert.equal(preview.json().plan.items.filter((item: { action: string }) => item.action === "install").length, 1);
  assert.equal(preview.json().plan.items.filter((item: { action: string }) => item.action === "review").length, 0);
  assert.equal(preview.json().graph.digest, preview.json().compiled.revisionDigest);
  assert.equal(preview.json().plan.revisionDigest, preview.json().compiled.revisionDigest);
  assert.deepEqual(preview.json().diagram, compiled.json().diagram);
  assert.equal("spec" in preview.json().diagram, false);
  assert.equal("createdByUserId" in preview.json().diagram, false);
  assert.doesNotMatch(JSON.stringify(preview.json().diagram), /(?:\/Users\/|author@example\.com|credential|password)/i);

  const workPreview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "work", environmentId: "work-mac" },
  });
  assert.equal(workPreview.statusCode, 200);
  assert.deepEqual(workPreview.json().compiled.nodes.map((node: { id: string }) => node.id), ["delivery", "root"]);
  assert.deepEqual(workPreview.json().graph.nodes.map((node: { id: string }) => node.id), ["delivery", "root"]);
  assert.match(workPreview.json().outline.text, /Delivery \(router\)/);
  assert.doesNotMatch(workPreview.json().outline.text, /Release notes \(leaf\)/);
  assert.equal(workPreview.json().graph.digest, workPreview.json().compiled.revisionDigest);

  const events = await architectureStore.listAuditEvents();
  assert.deepEqual(events.map((event) => event.action), [
    "architecture.preview.dry_run",
    "architecture.revision.create",
    "architecture.create",
  ]);
});

test("architecture resources are owner-private and privileged mutations require MFA", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const ownerToken = await addUserAndLogin(app, authStore, {
    id: "owner-user",
    email: "owner@example.com",
    roles: ["owner"],
  });
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${ownerToken}` },
    payload: { name: "Blocked", patternId: "flat" },
  });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const authorToken = await addUserAndLogin(app, authStore, {
    id: "other-user",
    email: "other@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${authorToken}` },
    payload: { name: "Private", patternId: "multi-level-router" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;

  const forbidden = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(forbidden.statusCode, 404);
  assert.equal(forbidden.json().error.code, "ARCHITECTURE_NOT_FOUND");
});

test("architecture reads accept the scoped API token while mutations remain session-only", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const session = await addUserAndLogin(app, authStore, {
    id: "api-token-user",
    email: "api-token@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${session}` },
    payload: { name: "API token architecture", patternId: "multi-level-router" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${session}` },
    payload: { expectedCurrentRevisionId: null, spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);
  const revisionId = revision.json().revision.id as string;

  const readToken = await createApiToken(app, session, ["architectures:read"]);
  const readable = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${readToken.token}` },
  });
  assert.equal(readable.statusCode, 200);
  const preview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${readToken.token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });
  assert.equal(preview.statusCode, 200);

  const skillsOnlyToken = await createApiToken(app, session, ["skills:read"]);
  const missingArchitectureScope = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${skillsOnlyToken.token}` },
  });
  assert.equal(missingArchitectureScope.statusCode, 403);
  assert.equal(missingArchitectureScope.json().error.code, "API_TOKEN_SCOPE_REQUIRED");
  assert.equal(missingArchitectureScope.json().error.details.scope, "architectures:read");

  const mutationWithApiToken = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${readToken.token}` },
    payload: { name: "Must remain session-only", patternId: "multi-level-router" },
  });
  assert.equal(mutationWithApiToken.statusCode, 403);
  assert.equal(mutationWithApiToken.json().error.code, "SESSION_AUTH_REQUIRED");
});

test("architecture projection limiting is keyed per authenticated principal", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
    architectureProjectionLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
  });
  t.after(() => app.close());

  const userA = await addUserAndLogin(app, authStore, {
    id: "projection-user-a",
    email: "projection-a@example.com",
    roles: ["author"],
  });
  const userB = await addUserAndLogin(app, authStore, {
    id: "projection-user-b",
    email: "projection-b@example.com",
    roles: ["author"],
  });
  const createArchitecture = async (token: string): Promise<{ id: string; revisionId: string }> => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/architectures",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Projection limit", patternId: "multi-level-router" },
    });
    assert.equal(created.statusCode, 201);
    const id = created.json().architecture.id as string;
    const revision = await app.inject({
      method: "POST",
      url: `/v1/architectures/${id}/revisions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { expectedCurrentRevisionId: null, spec: revisionSpec },
    });
    assert.equal(revision.statusCode, 201);
    return { id, revisionId: revision.json().revision.id as string };
  };
  const architectureA = await createArchitecture(userA);
  const architectureB = await createArchitecture(userB);
  const previewInput = (architecture: { id: string; revisionId: string }) => ({
    method: "POST" as const,
    url: `/v1/architectures/${architecture.id}/preview`,
    payload: { revisionId: architecture.revisionId, profileId: "personal", environmentId: "personal-mac" },
  });

  const firstA = await app.inject({ ...previewInput(architectureA), headers: { authorization: `Bearer ${userA}` } });
  assert.equal(firstA.statusCode, 200);
  const limitedA = await app.inject({ ...previewInput(architectureA), headers: { authorization: `Bearer ${userA}` } });
  assert.equal(limitedA.statusCode, 429);
  assert.equal(limitedA.json().error.code, "ARCHITECTURE_RATE_LIMITED");
  assert.equal(limitedA.headers["retry-after"], "60");
  const firstB = await app.inject({ ...previewInput(architectureB), headers: { authorization: `Bearer ${userB}` } });
  assert.equal(firstB.statusCode, 200);
});

test("in-flight projection limiting rejects overlap and releases the slot after completion", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  let releaseResolver!: () => void;
  let startedResolver!: () => void;
  let gateEnabled = false;
  const releaseGate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const resolverStarted = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });
  const baseResolver = architectureReleaseResolver();
  const submissionService = {
    async getPublicRelease(input: { slug: string; version: string; actorId?: string | null }) {
      if (gateEnabled) {
        startedResolver();
        await releaseGate;
      }
      return baseResolver.getPublicRelease(input);
    },
  } as unknown as SubmissionService;
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService,
    architectureProjectionMaxInFlight: 1,
  });
  t.after(() => app.close());

  const token = await addUserAndLogin(app, authStore, {
    id: "in-flight-user",
    email: "in-flight@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "In-flight architecture", patternId: "multi-level-router" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);
  const revisionId = revision.json().revision.id as string;
  gateEnabled = true;
  const previewRequest = () => app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });

  const firstRequest = previewRequest();
  await resolverStarted;
  const overlap = await previewRequest();
  assert.equal(overlap.statusCode, 429);
  assert.equal(overlap.json().error.code, "ARCHITECTURE_CONCURRENCY_LIMITED");
  releaseResolver();
  const first = await firstRequest;
  assert.equal(first.statusCode, 200);

  const afterRelease = await previewRequest();
  assert.equal(afterRelease.statusCode, 200);
});

test("organization-visible architecture references require explicit organization authorization", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: new MemorySkillRepository([{
      slug: "release-notes-helper",
      title: "Release notes",
      summary: "Prepare release notes.",
      lifecycleStatus: "approved",
      visibility: "organization",
      latestVersion: "1.0.0",
      reviewStatus: "approved",
      securityStatus: "passed",
      platforms: [],
      tags: ["delivery"],
      ownerUserId: "organization-owner",
    }]),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());

  const token = await addUserAndLogin(app, authStore, {
    id: "organization-owner",
    email: "organization-owner@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Organization visibility", patternId: "multi-level-router" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 422);
  assert.equal(revision.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
  assert.deepEqual(await architectureStore.listRevisions("organization-owner", architectureId), []);
});

test("organization-granted architecture previews resolve an exact organization skill without exposing its spec", async (t) => {
  const organizationId = "org-preview";
  const ownerId = "organization-architecture-owner";
  const readerId = "organization-architecture-reader";
  const ownerEmail = "organization-architecture-owner@example.com";
  const readerEmail = "organization-architecture-reader@example.com";
  const policy = defaultOrganizationPolicyV1;
  const policySha256 = organizationPolicyDigest(policy);
  const authStore = new MemoryAuthStore("closed");
  const organizationStore = new MemoryOrganizationStore();
  organizationStore.addKnownUser({ id: readerId, email: readerEmail, name: "Organization reader" });
  const createdOrganization = await organizationStore.createOrganization({
    id: organizationId,
    name: "Preview Organization",
    slug: "preview-organization",
    createdByUserId: ownerId,
    creatorEmail: ownerEmail,
    creatorName: "Architecture owner",
    policy,
    policySha256,
    reason: "route test",
  });
  const invitation = await organizationStore.createInvitation({
    organizationId,
    email: readerEmail,
    normalizedEmail: readerEmail,
    role: "member",
    invitedByUserId: ownerId,
  });
  await organizationStore.acceptInvitation({
    invitationId: invitation.id,
    userId: readerId,
    email: readerEmail,
    name: "Organization reader",
  });

  const skillRepository = new RecordingOrganizationSkillRepository([{
    slug: "organization-release",
    title: "Organization release",
    summary: "Organization-scoped release.",
    lifecycleStatus: "approved",
    visibility: "organization",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    ownerUserId: "skill-owner",
  }]);
  skillRepository.addOrganization({
    id: organizationId,
    name: "Preview Organization",
    slug: "preview-organization",
    policy,
    currentPolicyRevisionId: createdOrganization.policyRevision.id,
  });
  skillRepository.addOrganizationMembership(ownerId, organizationId, "owner");
  skillRepository.addOrganizationMembership(readerId, organizationId, "member");
  skillRepository.addOrganizationGrant("organization-release", organizationId, createdOrganization.policyRevision.id);
  await skillRepository.updateSharingSettings({ id: "instance-owner", roles: ["owner"] }, {
    publicVisibilityEnabled: true,
    authenticatedVisibilityEnabled: true,
    teamsEnabled: true,
    teamVisibilityEnabled: true,
    userVisibilityEnabled: true,
    organizationVisibilityEnabled: true,
  });
  const architectureStore = new OrganizationPreviewArchitectureStore({
    organizationVisibilityEnabled: true,
    organizations: [{
      id: organizationId,
      status: "active",
      currentPolicyRevisionId: createdOrganization.policyRevision.id,
      policy,
    }],
    organizationMemberships: [
      { userId: ownerId, organizationId, role: "owner" },
      { userId: readerId, organizationId, role: "member" },
    ],
  });
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
    architectureStore,
    organizationService: new OrganizationService(organizationStore, new TeamService(new MemoryTeamStore({ organizationStore }))),
    submissionService: {
      async getPublicRelease(input: { slug: string; version: string }) {
        if (input.slug !== "organization-release" || input.version !== "1.0.0") return null;
        return {
          slug: input.slug,
          title: "Organization release",
          summary: "Organization-scoped release.",
          version: input.version,
          lifecycleStatus: "approved",
          reviewStatus: "approved",
          securityStatus: "passed",
          publishedAt: "2026-08-30T00:00:00.000Z",
          platforms: [],
          artifact: { sha256: "c".repeat(64), byteSize: 128, contentType: "application/zip" },
        };
      },
    } as unknown as SubmissionService,
  });
  t.after(() => app.close());

  const ownerSession = await addUserAndLogin(app, authStore, {
    id: ownerId,
    email: ownerEmail,
    roles: ["author"],
  });
  const readerSession = await addUserAndLogin(app, authStore, {
    id: readerId,
    email: readerEmail,
    roles: ["user"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { name: "Organization preview architecture", patternId: "flat" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  architectureStore.addOrganizationGrant({
    architectureId,
    organizationId,
    policyRevisionId: createdOrganization.policyRevision.id,
  });

  const spec = createFlatArchitecture({
    id: architectureId,
    name: "Organization preview architecture",
    skills: [{
      id: "organization-release-ref",
      slug: "organization-release",
      version: "1.0.0",
      digest: "c".repeat(64),
      packageVisibility: "organization",
    }],
  });
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${ownerSession}` },
    payload: { expectedCurrentRevisionId: null, spec },
  });
  assert.equal(revision.statusCode, 201);
  skillRepository.organizationLookupIds.length = 0;
  skillRepository.broadLookupIds.length = 0;

  const missingOrganization = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${readerSession}` },
    payload: { revisionId: revision.json().revision.id },
  });
  assert.equal(missingOrganization.statusCode, 400);
  assert.equal(missingOrganization.json().error.code, "ARCHITECTURE_ORGANIZATION_CONTEXT_REQUIRED");

  const wrongOrganization = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${readerSession}` },
    payload: { revisionId: revision.json().revision.id, organizationId: "different-organization" },
  });
  assert.equal(wrongOrganization.statusCode, 404);
  assert.equal(wrongOrganization.json().error.code, "ARCHITECTURE_ORGANIZATION_CONTEXT_NOT_AVAILABLE");

  const preview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${readerSession}` },
    payload: { revisionId: revision.json().revision.id, organizationId },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().revision, undefined);
  assert.equal(preview.json().compiled.skills[0].slug, "organization-release");
  assert.equal(preview.json().diagram.revisionDigest, preview.json().compiled.revisionDigest);
  assert.equal(preview.json().diagram.profileId, preview.json().compiled.profileId);
  assert.equal(preview.json().diagram.environmentId, preview.json().compiled.environmentId);
  assert.equal("spec" in preview.json().diagram, false);
  assert.equal("createdByUserId" in preview.json().diagram, false);
  assert.doesNotMatch(JSON.stringify(preview.json().diagram), /(?:\/Users\/|organization-architecture-owner@example\.com|credential|password)/i);
  assert.deepEqual(skillRepository.organizationLookupIds, [organizationId]);
  assert.deepEqual(skillRepository.broadLookupIds, []);

  const detail = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}`,
    headers: { authorization: `Bearer ${readerSession}` },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().latestRevision, null);
  assert.equal(detail.json().revisions[0].spec, undefined);

  const rawRevision = await app.inject({
    method: "GET",
    url: `/v1/architectures/${architectureId}/revisions/${revision.json().revision.id}`,
    headers: { authorization: `Bearer ${readerSession}` },
  });
  assert.equal(rawRevision.statusCode, 404);
  assert.equal(rawRevision.json().error.code, "ARCHITECTURE_NOT_FOUND");
});

test("architecture validation rejects cycles, non-private profiles, and target-bearing fixture fields", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository: architectureSkillRepository(),
    authService: new AuthService(authStore),
    architectureStore,
    submissionService: architectureReleaseResolver(),
  });
  t.after(() => app.close());
  const token = await addUserAndLogin(app, authStore, {
    id: "validation-user",
    email: "validation@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Validation", patternId: "multi-level-router" },
  });
  const architectureId = created.json().architecture.id as string;
  const cycle = structuredClone(revisionSpec);
  (cycle.edges as Array<{ from: string; to: string; kind: string }>).push({ from: "delivery", to: "root", kind: "routes" });
  const rejectedCycle = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec: cycle },
  });
  assert.equal(rejectedCycle.statusCode, 422);
  assert.equal(rejectedCycle.json().error.code, "ARCHITECTURE_CYCLE");

  const nonPrivate = structuredClone(revisionSpec);
  (nonPrivate.profiles[0] as { defaultExposure: string }).defaultExposure = "leaf";
  const rejectedVisibility = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec: nonPrivate },
  });
  assert.equal(rejectedVisibility.statusCode, 422);
  assert.equal(rejectedVisibility.json().error.code, "ARCHITECTURE_DEFAULT_EXPOSURE_INVALID");

  const validRevision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec: revisionSpec },
  });
  assert.equal(validRevision.statusCode, 201);

  const rejectedFixture = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      revisionId: validRevision.json().revision.id,
      profileId: "personal",
      environmentId: "personal-mac",
      fixture: { targetId: "fixture-target", nodes: [], targetPath: "/tmp/fixture" },
    },
  });
  assert.equal(rejectedFixture.statusCode, 400);
  assert.equal(rejectedFixture.json().error.code, "UNSUPPORTED_ARCHITECTURE_FIELD");

  const invalidFixtureIdentifiers = [
    { fixture: { targetId: "fixture/target" }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture\u0000target" }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", environmentId: "work/environment" }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", environmentId: "work\u0000environment" }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", routers: [{ nodeId: "router/node" }] }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", routers: [{ nodeId: "router\u0000node" }] }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", nodes: [{ nodeId: "node", skillRefId: "skill/ref" }] }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", nodes: [{ nodeId: "node", skillRefId: "skill\u0000ref" }] }, code: "INVALID_ARCHITECTURE_IDENTIFIER" },
    { fixture: { targetId: "fixture-target", skills: [{ slug: "../bad", version: "1.0.0", digest: "a".repeat(64), enabled: true }] }, code: "INVALID_SKILL_SLUG" },
    { fixture: { targetId: "fixture-target", skills: [{ slug: "Bad-slug", version: "1.0.0", digest: "a".repeat(64), enabled: true }] }, code: "INVALID_SKILL_SLUG" },
    { fixture: { targetId: "fixture-target", skills: [{ slug: "bad--slug", version: "1.0.0", digest: "a".repeat(64), enabled: true }] }, code: "INVALID_SKILL_SLUG" },
    { fixture: { targetId: "fixture-target", skills: [{ slug: "bad\u0000slug", version: "1.0.0", digest: "a".repeat(64), enabled: true }] }, code: "INVALID_SKILL_SLUG" },
  ] as const;
  for (const { fixture, code } of invalidFixtureIdentifiers) {
    const rejectedIdentifier = await app.inject({
      method: "POST",
      url: `/v1/architectures/${architectureId}/preview`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        revisionId: validRevision.json().revision.id,
        profileId: "personal",
        environmentId: "personal-mac",
        fixture,
      },
    });
    assert.equal(rejectedIdentifier.statusCode, 400);
    assert.equal(rejectedIdentifier.json().error.code, code);
  }

  const environmentMismatch = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      revisionId: validRevision.json().revision.id,
      profileId: "personal",
      environmentId: "personal-mac",
      fixture: { targetId: "fixture-target", environmentId: "work-mac", skills: [] },
    },
  });
  assert.equal(environmentMismatch.statusCode, 422);
  assert.equal(environmentMismatch.json().error.code, "ARCHITECTURE_ENVIRONMENT_MISMATCH");

  const observedIdentityConflict = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      revisionId: validRevision.json().revision.id,
      profileId: "personal",
      environmentId: "personal-mac",
      fixture: {
        targetId: "fixture-target",
        nodes: [
          { nodeId: "duplicate-node", kind: "leaf" },
          { nodeId: "duplicate-node", kind: "leaf" },
        ],
      },
    },
  });
  assert.equal(observedIdentityConflict.statusCode, 422);
  assert.equal(observedIdentityConflict.json().error.code, "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT");
});

test("preview resolves visible exact releases with an ordered registry snapshot capped at eight concurrent lookups", async (t) => {
  const { spec, skills } = multiSkillArchitectureFixture(12);
  const skillRepository = new RecordingSkillRepository(skills);
  const releaseCalls: string[] = [];
  let activeReleaseLookups = 0;
  let maxActiveReleaseLookups = 0;
  let releaseMode: "exact" | "wrong-digest" | "missing" = "exact";
  const submissionService = {
    async getPublicRelease(input: { slug: string; version: string }) {
      releaseCalls.push(`${input.slug}@${input.version}`);
      activeReleaseLookups += 1;
      maxActiveReleaseLookups = Math.max(maxActiveReleaseLookups, activeReleaseLookups);
      await new Promise((resolve) => setTimeout(resolve, 3));
      activeReleaseLookups -= 1;
      if (releaseMode === "missing") return null;
      const skill = skills.find((candidate) => candidate.slug === input.slug);
      if (!skill) return null;
      return {
        slug: skill.slug,
        title: skill.title,
        summary: skill.summary,
        version: input.version,
        lifecycleStatus: "approved" as const,
        reviewStatus: "approved" as const,
        securityStatus: "passed" as const,
        publishedAt: "2026-08-30T00:00:00.000Z",
        platforms: [],
        artifact: {
          sha256: releaseMode === "wrong-digest" ? "b".repeat(64) : skill.digest,
          byteSize: 128,
          contentType: "application/zip",
        },
      };
    },
  } as unknown as SubmissionService;
  const authStore = new MemoryAuthStore("closed");
  const architectureStore = new MemoryArchitectureStore();
  const app = buildApp({
    skillRepository,
    authService: new AuthService(authStore),
    architectureStore,
    submissionService,
  });
  t.after(() => app.close());

  const token = await addUserAndLogin(app, authStore, {
    id: "resolution-user",
    email: "resolution@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "Resolution architecture", patternId: "multi-level-router" },
  });
  assert.equal(created.statusCode, 201);
  const architectureId = created.json().architecture.id as string;
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { expectedCurrentRevisionId: null, spec },
  });
  assert.equal(revision.statusCode, 201);
  const revisionId = revision.json().revision.id as string;
  releaseCalls.length = 0;
  skillRepository.actorIds.length = 0;
  maxActiveReleaseLookups = 0;

  const preview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });
  assert.equal(preview.statusCode, 200);
  assert.ok(maxActiveReleaseLookups <= 8);
  assert.equal(releaseCalls.length, skills.length);
  assert.equal(skillRepository.actorIds.length, skills.length);
  assert.ok(skillRepository.actorIds.every((actorId) => actorId === "resolution-user"));
  assert.deepEqual(
    preview.json().compiled.skills.map((skill: { slug: string }) => skill.slug),
    skills.map((skill) => skill.slug),
  );

  releaseMode = "wrong-digest";
  const mismatchedRelease = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });
  assert.equal(mismatchedRelease.statusCode, 422);
  assert.equal(mismatchedRelease.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");

  releaseMode = "missing";
  const unavailableRelease = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: { revisionId, profileId: "personal", environmentId: "personal-mac" },
  });
  assert.equal(unavailableRelease.statusCode, 422);
  assert.equal(unavailableRelease.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
});

test("memory architecture storage enforces bounded owner, revision, and canonical-spec quotas", async () => {
  const store = new MemoryArchitectureStore();
  const ownerUserId = "quota-user";
  const first = await store.createArchitecture({
    ownerUserId,
    name: "Quota architecture",
    description: "",
    patternId: "multi-level-router",
  });
  for (let index = 1; index < 25; index += 1) {
    await store.createArchitecture({
      ownerUserId,
      name: `Quota architecture ${index + 1}`,
      description: "",
      patternId: "multi-level-router",
    });
  }
  assert.equal((await store.listArchitectures(ownerUserId)).length, 25);
  await assert.rejects(
    store.createArchitecture({ ownerUserId, name: "Quota overflow", description: "", patternId: "multi-level-router" }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_QUOTA_EXCEEDED" && error.statusCode === 409,
  );

  let expectedCurrentRevisionId: string | null = null;
  for (let index = 0; index < 50; index += 1) {
    const revision: ArchitectureRevisionRecord | null = await store.createRevision({
      ownerUserId,
      architectureId: first.id,
      expectedCurrentRevisionId,
      message: `Revision ${index + 1}`,
      spec: structuredClone(revisionSpec) as unknown as ArchitectureSpecV1,
    });
    assert.ok(revision);
    expectedCurrentRevisionId = revision.id;
  }
  assert.equal((await store.listRevisions(ownerUserId, first.id))?.length, 50);
  await assert.rejects(
    store.createRevision({
      ownerUserId,
      architectureId: first.id,
      expectedCurrentRevisionId,
      message: "Revision overflow",
      spec: structuredClone(revisionSpec) as unknown as ArchitectureSpecV1,
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_REVISION_QUOTA_EXCEEDED" && error.statusCode === 409,
  );

  const oversizedArchitecture = await store.createArchitecture({
    ownerUserId: "oversized-user",
    name: "Oversized",
    description: "",
    patternId: "multi-level-router",
  });
  const oversized = multiSkillArchitectureFixture(250).spec;
  oversized.skills = oversized.skills.map((skill) => ({ ...skill, summary: "x".repeat(500) }));
  await assert.rejects(
    store.createRevision({
      ownerUserId: "oversized-user",
      architectureId: oversizedArchitecture.id,
      expectedCurrentRevisionId: null,
      message: "Oversized specification",
      spec: oversized,
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_SPEC_TOO_LARGE" && error.statusCode === 413,
  );
});

test("legacy skill visibility updates delegate to sharing and still gate organization visibility", async (t) => {
  const authStore = new MemoryAuthStore("closed");
  const app = buildApp({
    skillRepository: new MemorySkillRepository([{
      slug: "private-helper",
      title: "Private helper",
      summary: "Private",
      lifecycleStatus: "approved",
      visibility: "private",
      latestVersion: "1.0.0",
      reviewStatus: "approved",
      securityStatus: "passed",
      platforms: [],
      tags: [],
      ownerUserId: "visibility-user",
    }]),
    authService: new AuthService(authStore),
    submissionService: {
      getSkillManagement: async () => ({
        slug: "private-helper",
        title: "Private helper",
        summary: "Private",
        lifecycleStatus: "approved",
        visibility: "private",
        tags: [],
        allowedActions: ["edit"],
      }),
    } as unknown as SubmissionService,
  });
  t.after(() => app.close());
  const token = await addUserAndLogin(app, authStore, {
    id: "visibility-user",
    email: "visibility@example.com",
    roles: ["author"],
  });

  const metadata = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${token}` },
    payload: { visibility: "public" },
  });
  assert.equal(metadata.statusCode, 403);
  assert.equal(metadata.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const mfaToken = await verifyMfaForSession(app, token, "visibility@example.com");
  const verifiedMetadata = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${mfaToken}` },
    payload: { visibility: "public" },
  });
  assert.equal(verifiedMetadata.statusCode, 200, verifiedMetadata.body);
  assert.equal(verifiedMetadata.json().skill.visibility, "public");

  const metadataOrganization = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${mfaToken}` },
    payload: { visibility: "organization" },
  });
  assert.equal(metadataOrganization.statusCode, 403);
  assert.equal(metadataOrganization.json().error.code, "ORGANIZATION_SHARING_DISABLED");

  const organization = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${token}` },
    payload: { visibility: "organization", teamIds: [], userEmails: [] },
  });
  assert.equal(organization.statusCode, 403);
  assert.equal(organization.json().error.code, "MFA_VERIFICATION_REQUIRED");

  const gatedOrganization = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${mfaToken}` },
    payload: { visibility: "organization", teamIds: [], userEmails: [] },
  });
  assert.equal(gatedOrganization.statusCode, 403);
  assert.equal(gatedOrganization.json().error.code, "ORGANIZATION_SHARING_DISABLED");
});

async function addUserAndLogin(
  app: ReturnType<typeof buildApp>,
  authStore: MemoryAuthStore,
  input: { id: string; email: string; roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> },
): Promise<string> {
  authStore.addUser({
    id: input.id,
    email: input.email,
    name: input.email.split("@")[0],
    status: "active",
    emailVerifiedAt: new Date(),
    roles: input.roles,
    passwordHash: await hashPassword("correct horse battery staple"),
  });
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: input.email, password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200);
  return login.json().token;
}

async function createApiToken(
  app: ReturnType<typeof buildApp>,
  session: string,
  scopes: string[],
): Promise<{ id: string; token: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/api-tokens",
    headers: { authorization: `Bearer ${session}` },
    payload: { name: `Architecture test ${scopes.join(",")}`, scopes },
  });
  assert.equal(response.statusCode, 201);
  return {
    id: response.json().token.id,
    token: response.json().token.token,
  };
}

async function verifyMfaForSession(
  app: ReturnType<typeof buildApp>,
  session: string,
  email: string,
): Promise<string> {
  const enrollment = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/enroll",
    headers: { authorization: `Bearer ${session}` },
    payload: { password: "correct horse battery staple" },
  });
  assert.equal(enrollment.statusCode, 201);

  const confirm = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/totp/confirm",
    headers: { authorization: `Bearer ${session}` },
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
  assert.equal(login.json().mfaRequired, true);

  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    payload: {
      challengeToken: login.json().challengeToken,
      recoveryCode: confirm.json().mfa.recoveryCodes[0],
    },
  });
  assert.equal(verify.statusCode, 200);
  assert.equal(verify.json().user.mfaVerified, true);
  return verify.json().token as string;
}

class RecordingSkillRepository extends MemorySkillRepository {
  readonly actorIds: string[] = [];

  override async getVisibleSkillBySlug(slug: string, actorId?: string | null) {
    this.actorIds.push(actorId ?? "");
    return super.getVisibleSkillBySlug(slug, actorId);
  }
}

class RecordingOrganizationSkillRepository extends MemorySkillRepository {
  readonly organizationLookupIds: string[] = [];
  readonly broadLookupIds: string[] = [];

  override async getSkillVisibleToOrganizationBySlug(slug: string, organizationId: string) {
    this.organizationLookupIds.push(organizationId);
    return super.getSkillVisibleToOrganizationBySlug(slug, organizationId);
  }

  override async getVisibleSkillBySlug(slug: string, actorId?: string | null) {
    this.broadLookupIds.push(actorId ?? "");
    return super.getVisibleSkillBySlug(slug, actorId);
  }
}

/**
 * Keep organization-reference coverage focused on the HTTP resolver while the
 * persistence guard is being migrated to accept those references. Internally
 * store a public projection so the memory store can materialize the grant,
 * then return the submitted organization reference at the read boundary.
 */
class OrganizationPreviewArchitectureStore extends MemoryArchitectureStore {
  private readonly organizationRevisionRecords = new Map<string, ArchitectureRevisionRecord>();

  override async createRevision(input: CreateArchitectureRevisionInput): Promise<ArchitectureRevisionRecord | null>;
  override async createRevision(
    actor: ArchitectureActorInput,
    input: CreateArchitectureRevisionInput,
  ): Promise<ArchitectureRevisionRecord | null>;
  override async createRevision(
    first: CreateArchitectureRevisionInput | ArchitectureActorInput,
    second?: CreateArchitectureRevisionInput,
  ): Promise<ArchitectureRevisionRecord | null> {
    const input = second ?? first as CreateArchitectureRevisionInput;
    const hasOrganizationReference = input.spec.skills.some((skill) => skill.packageVisibility === "organization");
    const storageInput = hasOrganizationReference
    ? {
        ...input,
        // This fixture intentionally stores an organization reference as a
        // public projection in the memory-only adapter. The production route
        // still creates and passes the exact server-owned intent; omit it
        // from this projection so the fixture does not compare the original
        // organization visibility with its rewritten public storage shape.
        authorizationSnapshot: undefined,
        spec: {
          ...input.spec,
          skills: input.spec.skills.map((skill) => skill.packageVisibility === "organization"
            ? { ...skill, packageVisibility: "public" as const }
            : skill),
        },
      }
      : input;
    const revision = second === undefined
      ? await super.createRevision(storageInput)
      : await super.createRevision(first as ArchitectureActorInput, storageInput);
    if (!revision || !hasOrganizationReference) return revision;
    const organizationRevision = { ...revision, spec: structuredClone(input.spec) };
    this.organizationRevisionRecords.set(revision.id, organizationRevision);
    return organizationRevision;
  }

  override async getRevision(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
  ): Promise<ArchitectureRevisionRecord | null> {
    const organizationRevision = revisionId ? this.organizationRevisionRecords.get(revisionId) : undefined;
    if (organizationRevision) {
      return { ...organizationRevision, spec: structuredClone(organizationRevision.spec) };
    }
    const revision = await super.getRevision(actorInput, architectureId, revisionId);
    return revision;
  }

  override async getRevisionForPreview(
    actorInput: ArchitectureActorInput,
    architectureId: string,
    revisionId?: string,
    organizationId?: string,
  ): Promise<ArchitectureRevisionRecord | null> {
    const authorizedRevision = await super.getRevisionForPreview(
      actorInput,
      architectureId,
      revisionId,
      organizationId,
    );
    if (!authorizedRevision) return null;
    const organizationRevision = this.organizationRevisionRecords.get(authorizedRevision.id);
    return organizationRevision
      ? { ...organizationRevision, spec: structuredClone(organizationRevision.spec) }
      : authorizedRevision;
  }
}

function multiSkillArchitectureFixture(count: number): {
  spec: ArchitectureSpecV1;
  skills: Array<{
    slug: string;
    title: string;
    summary: string;
    digest: string;
    lifecycleStatus: "approved";
    visibility: "public";
    latestVersion: "1.0.0";
    reviewStatus: "approved";
    securityStatus: "passed";
    platforms: [];
    tags: string[];
  }>;
} {
  const spec = structuredClone(revisionSpec) as unknown as ArchitectureSpecV1;
  const skills = Array.from({ length: count }, (_, index) => {
    const number = String(index).padStart(2, "0");
    const digestSeed = index.toString(16).padStart(2, "0");
    return {
      slug: `resolution-skill-${number}`,
      title: `Resolution skill ${number}`,
      summary: `Resolution fixture ${number}.`,
      digest: digestSeed.repeat(32),
      lifecycleStatus: "approved" as const,
      visibility: "public" as const,
      latestVersion: "1.0.0" as const,
      reviewStatus: "approved" as const,
      securityStatus: "passed" as const,
      platforms: [],
      tags: ["resolution"],
    };
  });
  spec.name = "Resolution fixture";
  spec.skills = skills.map((skill, index) => ({
    id: `skill-${String(index).padStart(2, "0")}`,
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    version: "1.0.0",
    digest: skill.digest,
    packageVisibility: "public",
  }));
  spec.nodes = [
    { id: "root", kind: "router", label: "All skills" },
    { id: "delivery", kind: "router", label: "Delivery" },
    ...spec.skills.map((skill) => ({
      id: `leaf-${skill.id}`,
      kind: "leaf" as const,
      label: skill.title ?? skill.slug,
      skillRefId: skill.id,
    })),
  ];
  spec.edges = [
    { from: "root", to: "delivery", kind: "contains" },
    ...spec.skills.map((skill) => ({ from: "delivery", to: `leaf-${skill.id}`, kind: "routes" as const })),
  ];
  const bindings = [
    { nodeId: "root", enabled: true, runtimeExposure: "router" as const },
    { nodeId: "delivery", enabled: true, runtimeExposure: "router" as const },
    ...spec.skills.map((skill) => ({
      nodeId: `leaf-${skill.id}`,
      enabled: true,
      runtimeExposure: "leaf" as const,
    })),
  ];
  spec.profiles = spec.profiles.map((profile) => ({ ...profile, bindings }));
  return { spec, skills };
}

function architectureReleaseResolver(): SubmissionService {
  return {
    async getPublicRelease(input: { slug: string; version: string }) {
      if (input.slug !== "release-notes-helper" || input.version !== "1.0.0") return null;
      return {
        slug: input.slug,
        title: "Release notes",
        summary: "Prepare release notes.",
        version: input.version,
        lifecycleStatus: "approved",
        reviewStatus: "approved",
        securityStatus: "passed",
        publishedAt: "2026-08-30T00:00:00.000Z",
        platforms: [],
        artifact: { sha256: "a".repeat(64), byteSize: 128, contentType: "application/zip" },
      };
    },
  } as unknown as SubmissionService;
}

function architectureSkillRepository(): MemorySkillRepository {
  return new MemorySkillRepository([{
    slug: "release-notes-helper",
    title: "Release notes",
    summary: "Prepare release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: ["delivery"],
  }]);
}
