import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultOrganizationPolicyV1,
  type OrganizationPolicyV1,
} from "@myskills-app/core";
import { parseSkillManifest, type PackageInputFile } from "@myskills-app/skill-package";
import { MemorySubmissionStore } from "../src/submissions/memory-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

test("memory organization releases require an exact active member and policy", async () => {
  const store = new MemorySubmissionStore({
    sharingSettings: {
      publicVisibilityEnabled: true,
      authenticatedVisibilityEnabled: true,
      teamsEnabled: true,
      teamVisibilityEnabled: true,
      userVisibilityEnabled: true,
      organizationVisibilityEnabled: true,
    },
    organizations: [
      { id: "org-one" },
      { id: "org-two" },
    ],
    organizationMemberships: [
      { userId: "skill-owner", organizationId: "org-one", role: "owner" },
      { userId: "org-one-member", organizationId: "org-one", role: "member" },
      { userId: "org-two-member", organizationId: "org-two", role: "member" },
    ],
  });
  const service = new SubmissionService(store);
  const packageInput = organizationPackageInput();
  const submitted = await service.createSubmission({
    actor: { id: "skill-owner", roles: ["author"] },
    ...packageInput,
  });

  assert.equal(submitted.visibility, "organization");
  const reviewBundle = await service.getReviewSubmissionBundle({
    actor: { id: "maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
  });
  assert.ok(reviewBundle);
  await service.performReviewAction({
    actor: { id: "maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle.artifact.sha256,
  });
  await service.performReviewAction({
    actor: { id: "maintainer", roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "publish",
  });

  const releaseInput = { slug: "organization-release", version: "1.0.0" };
  assert.ok(await service.getPublicRelease({ ...releaseInput, actorId: "skill-owner" }));
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-two-member" }), null);
  assert.equal(await service.getPublicRelease(releaseInput), null);

  store.addOrganizationGrant("organization-release", "org-one");
  assert.ok(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }));
  assert.ok(await service.getPublicBundle({ ...releaseInput, actorId: "org-one-member", platform: "codex" }));
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-two-member" }), null);
  assert.deepEqual(
    (await service.listSkillReleases({
      slug: releaseInput.slug,
      actor: { id: "org-one-member", roles: ["user"] },
    })).map((release) => release.version),
    ["1.0.0"],
  );

  store.setOrganizationPolicy("org-one", defaultOrganizationPolicyV1, "org-one:policy:2");
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.equal(await service.getPublicBundle({ ...releaseInput, actorId: "org-one-member", platform: "codex" }), null);

  store.addOrganizationGrant("organization-release", "org-one", "org-one:policy:2");
  assert.ok(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }));
  assert.ok(await service.getPublicBundle({ ...releaseInput, actorId: "org-one-member", platform: "codex" }));

  store.setOrganizationStatus("org-one", "suspended");
  assert.equal(await service.getPublicBundle({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.ok(await service.getPublicBundle({ ...releaseInput, actorId: "skill-owner" }));

  store.setOrganizationStatus("org-one", "active");
  store.setOrganizationPolicy("org-one", organizationSkillSharingDisabledPolicy());
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.ok(await service.getPublicRelease({ ...releaseInput, actorId: "skill-owner" }));

  store.setOrganizationPolicy("org-one", defaultOrganizationPolicyV1);
  store.setSharingSettings({ organizationVisibilityEnabled: false });
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.ok(await service.getPublicRelease({ ...releaseInput, actorId: "skill-owner" }));

  store.setSharingSettings({ organizationVisibilityEnabled: true });
  store.removeOrganizationMembership("org-one-member", "org-one");
  assert.equal(await service.getPublicRelease({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.equal(await service.getPublicBundle({ ...releaseInput, actorId: "org-one-member" }), null);
  assert.ok(await service.getPublicBundle({ ...releaseInput, actorId: "skill-owner" }));
});

function organizationPackageInput(): {
  manifest: ReturnType<typeof parseSkillManifest>;
  files: PackageInputFile[];
} {
  const manifest = parseSkillManifest({
    name: "organization-release",
    title: "Organization Release",
    summary: "A release scoped to an organization.",
    version: "1.0.0",
    license: "Apache-2.0",
    visibility: "organization",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["organization"],
  });
  return {
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "Organization-only release." },
    ],
  };
}

function organizationSkillSharingDisabledPolicy(): OrganizationPolicyV1 {
  return {
    ...defaultOrganizationPolicyV1,
    sharing: {
      ...defaultOrganizationPolicyV1.sharing,
      organizationSkillSharingEnabled: false,
    },
  };
}
