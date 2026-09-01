import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PACKAGE_ARCHIVE_BYTES } from "@myskills-app/skill-package";
import { buildApp } from "../src/app.js";
import { SUBMISSION_BODY_LIMIT_BYTES } from "../src/app.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryArchitectureStore } from "../src/architectures/memory-store.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { API_VERSION } from "../src/version.js";

const repository = new MemorySkillRepository([
  {
    slug: "release-notes-helper",
    title: "Release Notes Helper",
    summary: "Turns merged changes into concise release notes.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "0.1.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    tags: ["writing", "release"],
  },
  {
    slug: "private-risk-reviewer",
    title: "Private Risk Reviewer",
    summary: "Restricted draft.",
    lifecycleStatus: "private",
    visibility: "private",
    latestVersion: null,
    reviewStatus: "unreviewed",
    securityStatus: "not-run",
    platforms: [],
    tags: ["risk"],
  },
  {
    slug: "failed-public-skill",
    title: "Failed Public Skill",
    summary: "Public skill with no safe release.",
    lifecycleStatus: "approved",
    visibility: "public",
    latestVersion: "0.2.0",
    reviewStatus: "approved",
    securityStatus: "failed",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    tags: ["risk"],
  },
]);

test("GET /health returns service status", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    service: "myskills-app-api",
  });
  assert.equal(response.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=(), payment=()");
});

test("GET /v1/capabilities describes enabled server features", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/capabilities" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    version: API_VERSION,
    capabilities: {
      auth: false,
      search: true,
      export: false,
      install: false,
      review: false,
      lifecycle: false,
      tokens: false,
      teams: false,
      organizations: false,
      sharing: false,
      architectures: false,
      architectureTargets: false,
      architectureOrganizationGrants: false,
      architecturePatternMigrations: false,
    },
  });
});

test("capabilities version cannot drift behind root package metadata", async (t) => {
  const previous = process.env.MYSKILLS_API_VERSION;
  process.env.MYSKILLS_API_VERSION = "0.1.0-beta.1";
  t.after(() => {
    if (previous === undefined) delete process.env.MYSKILLS_API_VERSION;
    else process.env.MYSKILLS_API_VERSION = previous;
  });
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/capabilities" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().version, API_VERSION);
  assert.notEqual(response.json().version, "0.1.0-beta.1");
});

test("GET /ready checks Postgres and required artifact storage without weakening /health", async (t) => {
  const readyApp = buildApp({
    skillRepository: repository,
    readinessProbes: {
      postgres: async () => {},
      artifactStorageRequired: true,
      artifactStorage: async () => {},
    },
  });
  const unreadyApp = buildApp({
    skillRepository: repository,
    readinessProbes: {
      postgres: async () => {},
      artifactStorageRequired: true,
      artifactStorage: async () => {
        throw new Error("storage unavailable");
      },
    },
  });
  t.after(() => Promise.all([readyApp.close(), unreadyApp.close()]));

  const ready = await readyApp.inject({ method: "GET", url: "/ready" });
  const unready = await unreadyApp.inject({ method: "GET", url: "/ready" });
  const shallowHealth = await unreadyApp.inject({ method: "GET", url: "/health" });

  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json().checks, { postgres: "ready", artifactStorage: "ready" });
  assert.equal(unready.statusCode, 503);
  assert.deepEqual(unready.json().checks, { postgres: "ready", artifactStorage: "unready" });
  assert.equal(shallowHealth.statusCode, 200);
  assert.equal(shallowHealth.json().ok, true);
});

test("GET /ready bounds dependency probes with a timeout", async (t) => {
  const app = buildApp({
    skillRepository: repository,
    readinessTimeoutMs: 50,
    readinessProbes: {
      postgres: () => new Promise<void>(() => {}),
    },
  });
  t.after(() => app.close());

  const startedAt = Date.now();
  const response = await app.inject({ method: "GET", url: "/ready" });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().checks.postgres, "unready");
  assert.ok(Date.now() - startedAt < 1_000);
});

test("configured Phase 2 architecture server fails readiness and hides capabilities when migrations are incomplete", async (t) => {
  const app = buildApp({
    skillRepository: repository,
    authService: new AuthService(new MemoryAuthStore("closed")),
    submissionService: new SubmissionService(new MemorySubmissionStore()),
    architectureStore: new MemoryArchitectureStore(),
    readinessProbes: {
      postgres: async () => {},
      phase2Architecture: async () => {
        throw new Error("Phase 2 migrations are incomplete.");
      },
    },
  });
  t.after(() => app.close());

  const ready = await app.inject({ method: "GET", url: "/ready" });
  const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });

  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json().checks, {
    postgres: "ready",
    artifactStorage: "not-required",
    phase2Architecture: "unready",
  });
  assert.equal(capabilities.statusCode, 200);
  assert.equal(capabilities.json().capabilities.architectures, false);
});

test("API request limiting is shared across routes while health probes remain independent", async (t) => {
  const app = buildApp({
    skillRepository: repository,
    requestLimiter: new MemoryAuthRateLimiter({ maxAttempts: 1, windowMs: 60_000 }),
  });
  t.after(() => app.close());

  const first = await app.inject({ method: "GET", url: "/v1/skills" });
  const limited = await app.inject({ method: "GET", url: "/v1/capabilities" });
  const health = await app.inject({ method: "GET", url: "/health" });

  assert.equal(first.statusCode, 200);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "API_RATE_LIMITED");
  assert.equal(limited.headers["retry-after"], "60");
  assert.equal(health.statusCode, 200);
});

test("submission route accepts 10 MiB base64 JSON overhead and returns a specific route limit error", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());
  const packageBoundary = Buffer.alloc(MAX_PACKAGE_ARCHIVE_BYTES).toString("base64");

  const acceptedByBodyParser = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    payload: { archive: { filename: "package.zip", contentBase64: packageBoundary } },
  });
  const routeTooLarge = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    payload: { archive: { filename: "package.zip", contentBase64: "A".repeat(SUBMISSION_BODY_LIMIT_BYTES) } },
  });

  assert.equal(acceptedByBodyParser.statusCode, 503);
  assert.equal(acceptedByBodyParser.json().error.code, "AUTH_SERVICE_UNAVAILABLE");
  assert.equal(routeTooLarge.statusCode, 413);
  assert.equal(routeTooLarge.json().error.code, "SUBMISSION_BODY_TOO_LARGE");
});

test("CORS allows configured web origins only", async (t) => {
  const app = buildApp({
    skillRepository: repository,
    allowedOrigins: ["http://localhost:3000"],
  });
  t.after(() => app.close());

  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/v1/skills",
    headers: { origin: "http://localhost:3000" },
  });
  const denied = await app.inject({
    method: "OPTIONS",
    url: "/v1/skills",
    headers: { origin: "https://example.invalid" },
  });

  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");
  assert.match(String(allowed.headers["access-control-allow-headers"]), /x-myskills-session-response/);
  assert.match(String(allowed.headers["access-control-expose-headers"]), /x-myskills-artifact-sha256/);
  assert.equal(denied.statusCode, 204);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  assert.equal(denied.headers["access-control-expose-headers"], undefined);
});

test("cookie-authenticated mutations require an allowed Origin", async (t) => {
  const app = buildApp({
    skillRepository: repository,
    allowedOrigins: ["https://skills.example.test"],
  });
  t.after(() => app.close());

  const missingOrigin = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { cookie: "myskills_session=untrusted-cookie" },
  });
  const deniedOrigin = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      cookie: "myskills_session=untrusted-cookie",
      origin: "https://attacker.example.test",
    },
  });
  const allowedOrigin = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      cookie: "myskills_session=untrusted-cookie",
      origin: "https://skills.example.test",
    },
  });
  const bearerRequest = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      authorization: "Bearer api-client-token",
      cookie: "myskills_session=untrusted-cookie",
    },
  });

  assert.equal(missingOrigin.statusCode, 403);
  assert.equal(missingOrigin.json().error.code, "COOKIE_ORIGIN_REJECTED");
  assert.equal(deniedOrigin.statusCode, 403);
  assert.equal(deniedOrigin.json().error.code, "COOKIE_ORIGIN_REJECTED");
  assert.equal(allowedOrigin.statusCode, 204);
  assert.equal(bearerRequest.statusCode, 204);
});

test("GET /v1/me requires authentication", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/me" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
});

test("GET /v1/skills returns only public approved skills", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/skills?q=release" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().skills.map((skill: { slug: string }) => skill.slug), ["release-notes-helper"]);
});

test("GET /v1/skills hides public skills without a safe release", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/skills?q=failed" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().skills, []);
});

test("GET /v1/skills/:slug returns public approved skill detail", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/skills/release-notes-helper" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().skill.slug, "release-notes-helper");
  assert.deepEqual(response.json().skill.tags, ["writing", "release"]);
});

test("GET /v1/skills/:slug hides private or missing skills", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const privateResponse = await app.inject({ method: "GET", url: "/v1/skills/private-risk-reviewer" });
  const missingResponse = await app.inject({ method: "GET", url: "/v1/skills/missing-skill" });
  const failedResponse = await app.inject({ method: "GET", url: "/v1/skills/failed-public-skill" });

  assert.equal(privateResponse.statusCode, 404);
  assert.equal(privateResponse.json().error.code, "SKILL_NOT_FOUND");
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missingResponse.json().error.code, "SKILL_NOT_FOUND");
  assert.equal(failedResponse.statusCode, 404);
  assert.equal(failedResponse.json().error.code, "SKILL_NOT_FOUND");
});

test("GET /v1/skills/:slug rejects invalid slugs", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/skills/Bad--Slug" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_SKILL_SLUG");
});

test("malformed JSON requests return a client error", async (t) => {
  const app = buildApp({ skillRepository: repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: { "content-type": "application/json" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "INVALID_REQUEST");
});
