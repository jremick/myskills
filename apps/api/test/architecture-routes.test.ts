import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "@myskills-app/auth";
import { AppError, type ArchitectureSpecV1 } from "@myskills-app/core";
import { buildApp } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
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
    packageVisibility: "private",
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

const flatRevisionSpec = {
  ...revisionSpec,
  id: "flat-architecture",
  name: "Flat architecture",
  pattern: { id: "flat", version: 1 },
  nodes: [{
    id: "release-notes",
    kind: "leaf",
    label: "Release notes",
    skillRefId: "release-notes",
  }],
  edges: [],
  entryNodeIds: ["release-notes"],
  profiles: [{
    id: "personal",
    name: "Personal",
    subject: { type: "user", id: "author-user" },
    defaultExposure: "disabled",
    bindings: [{ nodeId: "release-notes", enabled: true, runtimeExposure: "leaf" }],
  }],
  environments: [{ id: "personal-mac", name: "Personal Mac", kind: "personal", profileId: "personal" }],
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

  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { message: "Initial topology", spec: revisionSpec },
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

test("architecture resolution matches a managed target through the read-scoped API without applying", async (t) => {
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
    id: "author-user",
    email: "resolution@example.com",
    roles: ["author"],
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/architectures",
    headers: { authorization: `Bearer ${session}` },
    payload: { name: "Resolved architecture", patternId: "multi-level-router" },
  });
  const architectureId = created.json().architecture.id as string;
  const revision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${session}` },
    payload: { spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);
  const readToken = await createApiToken(app, session, ["architectures:read"]);
  const resolved = await app.inject({
    method: "POST",
    url: "/v1/architecture-resolutions",
    headers: { authorization: `Bearer ${readToken.token}` },
    payload: {
      observation: targetObservation(),
      environmentKind: "personal",
    },
  });

  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().resolution.status, "resolved");
  assert.equal(resolved.json().resolution.confidence, "high");
  assert.equal(resolved.json().resolution.selected.architectureId, architectureId);
  assert.equal(resolved.json().resolution.selected.environmentId, "personal-mac");
  assert.equal(resolved.json().resolution.selected.plan.dryRun, true);
  assert.equal(resolved.json().resolution.selected.plan.canApply, false);
  assert.equal(resolved.json().resolution.selected.canConfigure, false);
  assert.deepEqual(resolved.json().resolution.selected.blockers, ["capability:canConfigureRouters"]);
  assert.equal(resolved.json().resolution.candidates[0].plan, undefined);
  assert.equal(resolved.json().excluded.length, 0);
  assert.equal((await architectureStore.listAuditEvents())[0]?.action, "architecture.resolve");
});

test("architecture resolution fails closed on equally strong candidates and unsafe observations", async (t) => {
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
    id: "author-user",
    email: "ambiguous@example.com",
    roles: ["author"],
  });
  for (const name of ["Flat one", "Flat two"]) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/architectures",
      headers: { authorization: `Bearer ${session}` },
      payload: { name, patternId: "flat" },
    });
    const architectureId = created.json().architecture.id as string;
    const revision = await app.inject({
      method: "POST",
      url: `/v1/architectures/${architectureId}/revisions`,
      headers: { authorization: `Bearer ${session}` },
      payload: { spec: flatRevisionSpec },
    });
    assert.equal(revision.statusCode, 201);
  }

  const ambiguous = await app.inject({
    method: "POST",
    url: "/v1/architecture-resolutions",
    headers: { authorization: `Bearer ${session}` },
    payload: { observation: targetObservation(), environmentKind: "personal" },
  });
  assert.equal(ambiguous.statusCode, 200);
  assert.equal(ambiguous.json().resolution.status, "ambiguous");
  assert.equal(ambiguous.json().resolution.selected, null);
  assert.equal(ambiguous.json().resolution.candidates.length, 2);
  assert.equal(ambiguous.json().resolution.candidates[0].score, ambiguous.json().resolution.candidates[1].score);

  const unsafe = await app.inject({
    method: "POST",
    url: "/v1/architecture-resolutions",
    headers: { authorization: `Bearer ${session}` },
    payload: {
      observation: {
        ...targetObservation(),
        target: { ...targetObservation().target, path: "/private/codex" },
      },
    },
  });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(unsafe.json().error.code, "UNSUPPORTED_ARCHITECTURE_FIELD");
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
    payload: { spec: revisionSpec },
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
      payload: { spec: revisionSpec },
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
  const releaseGate = new Promise<void>((resolve) => {
    releaseResolver = resolve;
  });
  const resolverStarted = new Promise<void>((resolve) => {
    startedResolver = resolve;
  });
  const baseResolver = architectureReleaseResolver();
  const submissionService = {
    async getPublicRelease(input: { slug: string; version: string; actorId?: string | null }) {
      startedResolver();
      await releaseGate;
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
    payload: { spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);
  const revisionId = revision.json().revision.id as string;
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

test("owner organization-visible releases are rejected from architecture projections", async (t) => {
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
    payload: { spec: revisionSpec },
  });
  assert.equal(revision.statusCode, 201);

  const preview = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/preview`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      revisionId: revision.json().revision.id,
      profileId: "personal",
      environmentId: "personal-mac",
    },
  });
  assert.equal(preview.statusCode, 422);
  assert.equal(preview.json().error.code, "ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE");
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
    payload: { spec: cycle },
  });
  assert.equal(rejectedCycle.statusCode, 422);
  assert.equal(rejectedCycle.json().error.code, "ARCHITECTURE_CYCLE");

  const nonPrivate = structuredClone(revisionSpec);
  (nonPrivate.profiles[0] as { defaultExposure: string }).defaultExposure = "leaf";
  const rejectedVisibility = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { spec: nonPrivate },
  });
  assert.equal(rejectedVisibility.statusCode, 422);
  assert.equal(rejectedVisibility.json().error.code, "ARCHITECTURE_DEFAULT_EXPOSURE_INVALID");

  const validRevision = await app.inject({
    method: "POST",
    url: `/v1/architectures/${architectureId}/revisions`,
    headers: { authorization: `Bearer ${token}` },
    payload: { spec: revisionSpec },
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
    payload: { spec },
  });
  assert.equal(revision.statusCode, 201);
  const revisionId = revision.json().revision.id as string;

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

  for (let index = 0; index < 50; index += 1) {
    await store.createRevision({
      ownerUserId,
      architectureId: first.id,
      message: `Revision ${index + 1}`,
      spec: structuredClone(revisionSpec) as unknown as ArchitectureSpecV1,
    });
  }
  assert.equal((await store.listRevisions(ownerUserId, first.id))?.length, 50);
  await assert.rejects(
    store.createRevision({
      ownerUserId,
      architectureId: first.id,
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
      message: "Oversized specification",
      spec: oversized,
    }),
    (error) => error instanceof AppError && error.code === "ARCHITECTURE_SPEC_TOO_LARGE" && error.statusCode === 413,
  );
});

test("skill visibility updates use the sharing boundary and reject organization visibility", async (t) => {
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
  assert.equal(metadata.statusCode, 400);
  assert.equal(metadata.json().error.code, "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE");

  const metadataOrganization = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper",
    headers: { authorization: `Bearer ${token}` },
    payload: { visibility: "organization" },
  });
  assert.equal(metadataOrganization.statusCode, 400);
  assert.equal(metadataOrganization.json().error.code, "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE");

  const organization = await app.inject({
    method: "PUT",
    url: "/v1/skills/private-helper/sharing",
    headers: { authorization: `Bearer ${token}` },
    payload: { visibility: "organization", teamIds: [], userEmails: [] },
  });
  assert.equal(organization.statusCode, 400);
  assert.equal(organization.json().error.code, "ORGANIZATION_VISIBILITY_UNSUPPORTED");
});

function targetObservation() {
  return {
    schemaVersion: "myskills.target-observation.v1",
    target: {
      id: "codex-local",
      toolKind: "codex",
      adapterVersion: "test-managed-registry.v1",
      capabilities: {
        canInspectManagedSkills: true,
        canInspectRouters: false,
        canInstall: true,
        canUpdate: true,
        canRemove: false,
        canEnable: false,
        canConfigureRouters: false,
        canRollback: true,
      },
    },
    observedState: {
      targetId: "codex-local",
      nodes: [{
        nodeId: "release-notes",
        kind: "leaf",
        slug: "release-notes-helper",
        version: "1.0.0",
        digest: "a".repeat(64),
        enabled: true,
        runtimeExposure: "leaf",
        managed: true,
        supported: true,
      }],
    },
  };
}

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

class RecordingSkillRepository extends MemorySkillRepository {
  readonly actorIds: string[] = [];

  override async getVisibleSkillBySlug(slug: string, actorId?: string | null) {
    this.actorIds.push(actorId ?? "");
    return super.getVisibleSkillBySlug(slug, actorId);
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
