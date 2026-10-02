import assert from "node:assert/strict";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { compareAuthorizedReleases, parseSkillManifest } from "@myskills-app/skill-package";
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
  let reads = 0;
  await assert.rejects(compareAuthorizedReleases({
    base: { slug: "hidden-review", version: "1.0.0", artifactSha256: first.artifact.sha256 },
    target: { slug: "hidden-review", version: "2.0.0", artifactSha256: second.artifact.sha256 },
  }, async (kind, pin) => {
    if (++reads === 5) await f.authStore.revokeSessionByTokenHash(hashSessionToken(token));
    const response = await f.app.inject({ url: `/v1/skills/${pin.slug}/releases/${pin.version}${kind === "bundle" ? `/bundle?sha256=${pin.artifactSha256}` : ""}`, headers: { authorization: `Bearer ${token}` } });
    if (response.statusCode !== 200) throw new Error(`Current API denial ${response.statusCode}`);
    return response.json() as Record<string, unknown>;
  }), /Current API denial 404/);
  assert.equal(reads, 5, "revocation rejects the final metadata read after both authorized metadata/bundle pairs");
  const metadata = await f.app.inject({ url: "/v1/skills/hidden-review/releases/1.0.0", headers: { authorization: `Bearer ${token}` } });
  assert.equal(metadata.statusCode, 404);
  assert.deepEqual(metadata.json(), { error: { code: "RELEASE_NOT_FOUND", message: "Release not found." } });
  const bundle = await f.app.inject({ url: `/v1/skills/hidden-review/releases/1.0.0/bundle?sha256=${first.artifact.sha256}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(bundle.statusCode, 401);
  assert.deepEqual(bundle.json(), { error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } }, "revoked supplied credentials must not expose private bundle bytes");
});
