import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "@myskills-app/core";
import { parseSkillManifest } from "@myskills-app/skill-package";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import type { SubmissionActor } from "../src/submissions/types.js";

const author: SubmissionActor = { id: "author", roles: ["author"] };
const maintainer: SubmissionActor = { id: "maintainer", roles: ["maintainer"] };
const outsider: SubmissionActor = { id: "outsider", roles: ["author"] };

test("authors receive change reasons and scan findings, then correct through an immutable next version", async () => {
  const service = new SubmissionService(new MemorySubmissionStore());
  const input = packageInput("correction-helper", "1.0.0");
  input.files.push({ path: "package.json", content: JSON.stringify({ scripts: { postinstall: "node setup.js" } }) });
  const original = await service.createSubmission({ actor: author, ...input });
  await service.performReviewAction({ actor: maintainer, submissionId: original.id, action: "request-changes", reason: "Remove the installation hook and explain setup." });
  const detail = await service.getUserSubmissionDetail({ actor: author, submissionId: original.id });
  assert.equal(detail?.changeRequestReason, "Remove the installation hook and explain setup.");
  assert.equal(detail?.reviewHistory[0]?.action, "request-changes");
  assert.equal(detail?.scanRuns[0]?.findings[0]?.path, "package.json");
  assert.equal(detail?.scanRuns[0]?.findings[0]?.category, "install-hook");
  assert.deepEqual(detail?.correction, { requiresNewVersion: true, canSubmitNewVersion: true });
  assert.equal(JSON.stringify(detail).includes("storageKey"), false);
  assert.equal(await service.getUserSubmissionDetail({ actor: outsider, submissionId: original.id }), null);
  await assert.rejects(service.getReviewSubmissionDetail({ actor: outsider, submissionId: original.id }),
    (error) => error instanceof AppError && error.code === "REVIEW_ROLE_REQUIRED");
  await assert.rejects(service.createSubmission({ actor: author, ...packageInput("correction-helper", "1.0.0") }),
    (error) => error instanceof AppError && error.code === "PACKAGE_VERSION_EXISTS");
  const corrected = await service.createSubmission({ actor: author, ...packageInput("correction-helper", "1.0.1") });
  await service.performReviewAction({ actor: maintainer, submissionId: corrected.id, action: "approve", artifactSha256: corrected.artifact.sha256 });
  await service.performReviewAction({ actor: maintainer, submissionId: corrected.id, action: "publish" });
  const published = await service.getReviewSubmissionDetail({ actor: maintainer, submissionId: corrected.id });
  assert.deepEqual(published?.reviewHistory.map((event) => event.action), ["approve", "publish"]);
  assert.deepEqual(published?.scanRuns[0]?.findings, []);
  assert.equal((await service.getUserSubmissionDetail({ actor: author, submissionId: original.id }))?.changeRequestReason, detail?.changeRequestReason);
});

test("authorized inventory and historical releases remain usable after archive and final unpublish", async () => {
  const service = new SubmissionService(new MemorySubmissionStore());
  for (const slug of ["archived-helper", "unpublished-helper"]) {
    for (const version of ["1.0.0", "1.0.1"]) {
      const submission = await service.createSubmission({ actor: author, ...packageInput(slug, version) });
      await service.performReviewAction({ actor: maintainer, submissionId: submission.id, action: "approve", artifactSha256: submission.artifact.sha256 });
      await service.performReviewAction({ actor: maintainer, submissionId: submission.id, action: "publish" });
      await service.performReleaseAction({ actor: author, slug, version, action: "unpublish" });
    }
  }
  await service.performSkillAction({ actor: author, slug: "archived-helper", action: "archive" });
  const first = await service.listManagedSkills({ actor: author, limit: 1 });
  assert.equal(first.skills[0]?.slug, "archived-helper");
  assert.equal(first.skills[0]?.lifecycleStatus, "archived");
  assert.ok(first.nextCursor);
  const second = await service.listManagedSkills({ actor: author, limit: 1, cursor: first.nextCursor });
  assert.equal(second.skills[0]?.slug, "unpublished-helper");
  assert.equal(second.nextCursor, null);
  assert.deepEqual((await service.listManagedSkills({ actor: outsider })).skills, []);
  assert.equal((await service.listManagedSkills({ actor: maintainer })).skills.length, 2);
  assert.deepEqual(first.skills[0]?.tags, ["workflow"]);
  assert.equal((await service.listSkillReleases({ actor: author, slug: "archived-helper" })).length, 2);
  assert.deepEqual(await service.listSkillReleases({ actor: outsider, slug: "archived-helper" }), []);
  await service.performReleaseAction({ actor: author, slug: "archived-helper", version: "1.0.0", action: "restore" });
  await service.performSkillAction({ actor: author, slug: "archived-helper", action: "restore" });
  const visible = await service.listSkillReleases({ actor: outsider, slug: "archived-helper" });
  assert.equal(visible[0]?.version, "1.0.0");
  assert.deepEqual(visible[0]?.allowedActions, []);
});

test("new versions cannot claim another author's inventory", async () => {
  const service = new SubmissionService(new MemorySubmissionStore());
  await service.createSubmission({ actor: author, ...packageInput("owned-helper", "1.0.0") });
  await assert.rejects(service.createSubmission({ actor: outsider, ...packageInput("owned-helper", "1.0.1") }),
    (error) => error instanceof AppError && error.code === "PACKAGE_SLUG_UNAVAILABLE");
  assert.deepEqual((await service.listManagedSkills({ actor: outsider })).skills, []);
});

function packageInput(slug: string, version: string) {
  const manifest = parseSkillManifest({
    name: slug, title: slug, summary: "A useful correction and recovery fixture.", version, license: "Apache-2.0",
    visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["workflow"],
  });
  return { manifest, files: [{ path: "skill.json", content: JSON.stringify(manifest) }, { path: "README.md", content: "Document setup and use." }] };
}
