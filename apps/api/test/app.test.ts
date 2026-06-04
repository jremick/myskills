import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

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
    service: "ai-skills-share-api",
  });
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
  assert.equal(denied.statusCode, 204);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
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
