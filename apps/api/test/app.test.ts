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

