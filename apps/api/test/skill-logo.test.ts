import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { buildApp } from "../src/app.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("published logos round trip through artifact storage and retain release access controls", async t => {
  const store = new MemorySubmissionStore();
  const service = new SubmissionService(store);
  const content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  for (const visibility of ["public", "private"] as const) {
    const manifest = parseSkillManifest({ name: `${visibility}-logo`, title: "Logo skill", summary: "A logo test", version: "0.1.0", license: "MIT", visibility, platforms: [{ name: "codex", install_target: "codex-skill" }] });
    const submission = await service.createSubmission({ actor: { id: "author", roles: ["author"] }, manifest,
      files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "assets/logo.png", content }] });
    const actor = { id: "reviewer", roles: ["maintainer" as const] };
    await service.performReviewAction({ actor, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
    await service.performReviewAction({ actor, submissionId: submission.id, action: "publish" });
  }
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), submissionService: service });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/v1/skills/public-logo/releases/0.1.0/logo" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.rawPayload, Buffer.from(content, "base64"));
  for (const url of ["/v1/skills/private-logo/releases/0.1.0/logo", "/v1/skills/public-logo/releases/9.0.0/logo"]) {
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  }
  await service.performSkillAction({ actor: { id: "author", roles: ["author"] }, slug: "public-logo", action: "archive" });
  assert.equal((await app.inject({ method: "GET", url: "/v1/skills/public-logo/releases/0.1.0/logo" })).statusCode, 404);
});
