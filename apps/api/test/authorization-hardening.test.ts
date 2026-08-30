import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type PublicSkill } from "@myskills-app/core";
import { parseSkillManifest, type PackageInputFile } from "@myskills-app/skill-package";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("organization visibility is not treated as authenticated in the memory skill repository", async () => {
  const skill: PublicSkill & { ownerUserId: string } = {
    slug: "organization-only",
    title: "Organization Only",
    summary: "A legacy organization-scoped skill.",
    lifecycleStatus: "approved",
    visibility: "organization",
    latestVersion: "1.0.0",
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
    ownerUserId: "owner-1",
  };
  const repository = new MemorySkillRepository([skill]);

  await assert.rejects(
    repository.updateSkillSharing({
      actor: { id: skill.ownerUserId, roles: ["author"] },
      slug: skill.slug,
      visibility: "organization",
      teamIds: [],
      userEmails: [],
    }),
    (error) => error instanceof AppError && error.code === "ORGANIZATION_VISIBILITY_UNSUPPORTED",
  );
  assert.deepEqual(await repository.searchVisibleSkills({ actorId: "member-1" }), []);
  assert.equal((await repository.getVisibleSkillBySlug(skill.slug, "member-1")), null);

  const ownerResult = await repository.getVisibleSkillBySlug(skill.slug, skill.ownerUserId);
  assert.equal(ownerResult?.slug, skill.slug);
  assert.deepEqual(ownerResult?.access?.reasons, ["owner"]);
});

test("new organization-visible submissions fail closed and metadata cannot change visibility", async () => {
  const store = new MemorySubmissionStore();
  const service = new SubmissionService(store);
  const organizationPackage = packageInput("organization-only", "organization");

  await assert.rejects(
    service.createSubmission({
      actor: { id: "author-1", roles: ["author"] },
      ...organizationPackage,
    }),
    (error) => error instanceof AppError &&
      error.code === "ORGANIZATION_VISIBILITY_UNSUPPORTED" &&
      error.statusCode === 422,
  );
  assert.equal(store.count(), 0);

  const publicPackage = packageInput("public-helper", "public");
  await service.createSubmission({
    actor: { id: "author-1", roles: ["author"] },
    ...publicPackage,
  });

  const legacyUpdate = { visibility: "organization" } as never;
  await assert.rejects(
    service.updateSkillMetadata({
      actor: { id: "author-1", roles: ["author"] },
      slug: "public-helper",
      update: legacyUpdate,
    }),
    (error) => error instanceof AppError && error.code === "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE",
  );
  await assert.rejects(
    store.updateSkillMetadata({
      actor: { id: "author-1", roles: ["author"] },
      slug: "public-helper",
      update: legacyUpdate,
    }),
    (error) => error instanceof AppError && error.code === "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE",
  );

  const management = await store.getSkillManagement({
    actor: { id: "author-1", roles: ["author"] },
    slug: "public-helper",
  });
  assert.equal(management?.visibility, "public");
});

function packageInput(name: string, visibility: "public" | "organization"): {
  manifest: ReturnType<typeof parseSkillManifest>;
  files: PackageInputFile[];
} {
  const manifest = parseSkillManifest({
    name,
    title: name,
    summary: "A test skill.",
    version: "0.1.0",
    license: "Apache-2.0",
    visibility,
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["test"],
  });
  return {
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "A test skill." },
    ],
  };
}
