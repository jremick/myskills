import assert from "node:assert/strict";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { discoveryFixture } from "./fixtures/task-discovery.js";

// Comparison requires two independent authorized exact-version reads. Reviewer
// privileges cannot substitute for source export authority or a pinned digest.
test("release comparison reads exact private versions through current API authority", async t => {
  const f = await discoveryFixture();
  t.after(() => f.app.close());
  const token = "synthetic-private-comparison-owner";
  f.authStore.addUser({ id: "author", email: "comparison-author@example.test", name: "Author", status: "active", roles: ["author"], emailVerifiedAt: new Date() });
  await f.authStore.createSession({ userId: "author", tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000), mfaVerifiedAt: null });
  const first = await f.submissions.getPublicBundle({ slug: "hidden-review", version: "1.0.0", actorId: "author" });
  assert.ok(first);
  const manifest = parseSkillManifest({ name: "hidden-review", title: first.title, summary: first.summary, visibility: "private", version: "2.0.0", license: "Apache-2.0", tags: [], platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }] });
  const files = first.payload.files.map(file => file.path === "skill.json" ? { ...file, content: JSON.stringify(manifest) } : { ...file, content: file.content + "\nUpdated exact release.\n" });
  const second = await f.submissions.createSubmission({ actor: { id: "author", roles: ["author"] }, manifest, files });
  const reviewer = { id: "reviewer", roles: ["maintainer" as const], mfaVerified: true };
  await f.submissions.performReviewAction({ actor: reviewer, submissionId: second.id, action: "approve", artifactSha256: second.artifact.sha256 });
  await f.submissions.performReviewAction({ actor: reviewer, submissionId: second.id, action: "publish" });
  for (const [version, artifact] of [["1.0.0", first.artifact], ["2.0.0", second.artifact]] as const) {
    const url = `/v1/skills/hidden-review/releases/${version}/bundle?sha256=${artifact.sha256}`;
    const owner = await f.app.inject({ url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(owner.statusCode, 200, owner.body);
    assert.equal(owner.headers["x-myskills-artifact-sha256"], artifact.sha256);
    assert.equal(owner.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(owner.body).files.find((file: { path: string }) => file.path === "skill.json").content, version === "1.0.0" ? first.payload.files.find(file => file.path === "skill.json")!.content : JSON.stringify(manifest));
    assert.equal((await f.app.inject({ url, headers: { authorization: `Bearer ${f.token}` } })).statusCode, 404);
    assert.equal((await f.app.inject({ url })).statusCode, 404);
    assert.equal((await f.app.inject({ url: url.replace(artifact.sha256, "f".repeat(64)), headers: { authorization: `Bearer ${token}` } })).statusCode, 409);
  }
  await f.authStore.revokeSessionByTokenHash(hashSessionToken(token));
  assert.equal((await f.app.inject({ url: `/v1/skills/hidden-review/releases/1.0.0/bundle?sha256=${first.artifact.sha256}`, headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
});
