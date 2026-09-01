import assert from "node:assert/strict";
import test from "node:test";
import {
  AppError,
  createFlatArchitecture,
  type ArchitecturePackageVisibility,
  type ArchitectureSkillRef,
  type PublicSkill,
} from "@myskills-app/core";
import {
  createExactArchitectureReleaseAuthorizer,
  resolveAuthorizedArchitectureRegistry,
  type ArchitectureResolutionScope,
  type ExactReleaseResolutionDependencies,
} from "../src/architectures/exact-release-authorizer.js";
import type { PublicReleaseMetadata } from "../src/submissions/types.js";

const actorId = "release-actor";
const organizationId = "release-org";
const teamId = "release-team";

test("registry resolution supports every package visibility through the matching server scope", async () => {
  const cases: Array<{
    visibility: ArchitecturePackageVisibility;
    scope?: ArchitectureResolutionScope;
    expectedLookup: "actor" | "team" | "organization";
  }> = [
    { visibility: "public", expectedLookup: "actor" },
    { visibility: "authenticated", expectedLookup: "actor" },
    { visibility: "team", scope: { teamId }, expectedLookup: "team" },
    { visibility: "organization", scope: { organizationIds: [organizationId] }, expectedLookup: "organization" },
    { visibility: "private", expectedLookup: "actor" },
    { visibility: "explicit-users", expectedLookup: "actor" },
  ];

  for (const testCase of cases) {
    const reference = referenceFor(testCase.visibility);
    const lookups: string[] = [];
    const dependencies = dependenciesFor(reference, {
      onActorLookup: () => lookups.push("actor"),
      onTeamLookup: () => lookups.push("team"),
      onOrganizationLookup: () => lookups.push("organization"),
    });

    let resolved: Awaited<ReturnType<typeof resolveAuthorizedArchitectureRegistry>>[number];
    try {
      [resolved] = await resolveAuthorizedArchitectureRegistry(
        dependencies,
        actorId,
        architectureFor(reference),
        testCase.scope,
      );
    } catch (error) {
      throw new Error(`${testCase.visibility}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    assert.equal(resolved?.slug, reference.slug);
    assert.equal(resolved?.version, reference.version);
    assert.equal(resolved?.digest, reference.digest);
    assert.equal(resolved?.packageVisibility, testCase.visibility);
    assert.deepEqual(lookups, [testCase.expectedLookup]);
  }
});

test("organization grant authorization accepts only registry visibilities allowed by the organization boundary", async () => {
  const cases: Array<{ visibility: ArchitecturePackageVisibility; allowed: boolean; code?: string }> = [
    { visibility: "public", allowed: true },
    { visibility: "authenticated", allowed: true },
    { visibility: "organization", allowed: true },
    { visibility: "team", allowed: false, code: "release_visibility_not_allowed" },
    { visibility: "private", allowed: false, code: "release_visibility_not_allowed" },
    { visibility: "explicit-users", allowed: false, code: "release_visibility_not_allowed" },
  ];

  for (const testCase of cases) {
    const reference = referenceFor(testCase.visibility);
    const authorizer = createExactArchitectureReleaseAuthorizer(dependenciesFor(reference));
    const decision = await authorizer.authorizeRelease({
      actorUserId: actorId,
      organizationId,
      organizationPolicyRevisionId: "policy-revision-1",
      organizationPolicySha256: "p".repeat(64),
      release: reference,
    });
    assert.equal(decision.allowed, testCase.allowed, testCase.visibility);
    assert.equal(decision.code, testCase.code, testCase.visibility);
    if (testCase.allowed) {
      assert.deepEqual(decision.release, {
        slug: reference.slug,
        version: reference.version,
        digest: reference.digest,
        packageVisibility: testCase.visibility,
      });
    }
  }
});

test("registry resolution fails closed for exact slug, version, and digest mismatches", async () => {
  const base = referenceFor("public");
  const cases: Array<{
    name: string;
    skill?: PublicSkill | null;
    release?: PublicReleaseMetadata | null;
  }> = [
    { name: "missing skill", skill: null },
    { name: "organization skill widened into a non-organization reference", skill: skillFor({ ...base, packageVisibility: "organization" }) },
    { name: "missing release", release: null },
    { name: "release slug mismatch", release: releaseFor(base, { slug: "other-slug" }) },
    { name: "release version mismatch", release: releaseFor(base, { version: "2.0.0" }) },
    { name: "release digest mismatch", release: releaseFor(base, { digest: "b".repeat(64) }) },
  ];

  for (const testCase of cases) {
    const dependencies = dependenciesFor(base, {
      skill: testCase.skill,
      release: testCase.release,
    });
    await assert.rejects(
      resolveAuthorizedArchitectureRegistry(dependencies, actorId, architectureFor(base)),
      errorWithCode("ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE"),
      testCase.name,
    );
  }
});

test("registry resolution rejects a resolved skill whose visibility differs from the reference", async () => {
  const reference = referenceFor("public");
  const resolvedSkill = skillFor({ ...reference, packageVisibility: "private" });

  await assert.rejects(
    resolveAuthorizedArchitectureRegistry(
      dependenciesFor(reference, { skill: resolvedSkill }),
      actorId,
      architectureFor(reference),
    ),
    errorWithCode("ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE"),
  );
});

test("organization resolution never widens a server-derived organization context", async () => {
  const reference = referenceFor("organization");
  const requestedOrganizations: string[] = [];
  const dependencies = dependenciesFor(reference, {
    onOrganizationLookup: (_slug, requestedOrganizationId) => {
      requestedOrganizations.push(requestedOrganizationId);
    },
    organizationResult: null,
  });

  await assert.rejects(
    resolveAuthorizedArchitectureRegistry(
      dependencies,
      actorId,
      architectureFor(reference),
      { organizationIds: [organizationId] },
    ),
    errorWithCode("ARCHITECTURE_SKILL_RELEASE_UNAVAILABLE"),
  );
  assert.deepEqual(requestedOrganizations, [organizationId]);
});

test("provider and repository failures are normalized and fail closed", async () => {
  const reference = referenceFor("public");
  const repositoryFailure = dependenciesFor(reference, {
    onActorLookup: () => {
      throw new AppError("registry connection details must not escape", "DB_CONNECTION_FAILURE", 500);
    },
  });
  await assert.rejects(
    resolveAuthorizedArchitectureRegistry(repositoryFailure, actorId, architectureFor(reference)),
    (error: unknown) => errorWithCode("ARCHITECTURE_REGISTRY_RESOLVER_UNAVAILABLE")(error)
      && error instanceof Error
      && error.message.includes("temporarily unavailable")
      && !error.message.includes("registry connection details"),
  );

  const providerFailure = dependenciesFor(reference, {
    onReleaseLookup: () => {
      throw new Error("submission provider details must not escape");
    },
  });
  const decision = await createExactArchitectureReleaseAuthorizer(providerFailure).authorizeRelease({
    actorUserId: actorId,
    organizationId,
    organizationPolicyRevisionId: "policy-revision-1",
    organizationPolicySha256: "p".repeat(64),
    release: reference,
  });
  assert.deepEqual(decision, { allowed: false, code: "release_authorizer_unavailable" });
});

function architectureFor(reference: ArchitectureSkillRef) {
  return createFlatArchitecture({
    id: "architecture-release-test",
    name: "Release test architecture",
    skills: [reference],
  });
}

function referenceFor(visibility: ArchitecturePackageVisibility): ArchitectureSkillRef {
  return {
    id: `skill-${visibility}`,
    slug: `skill-${visibility}`,
    title: `${visibility} skill`,
    summary: `${visibility} release`,
    version: "1.0.0",
    digest: "a".repeat(64),
    packageVisibility: visibility,
  };
}

function skillFor(reference: ArchitectureSkillRef): PublicSkill {
  return {
    slug: reference.slug,
    title: reference.title ?? reference.slug,
    summary: reference.summary ?? "",
    lifecycleStatus: "approved",
    visibility: reference.packageVisibility,
    latestVersion: reference.version,
    reviewStatus: "approved",
    securityStatus: "passed",
    platforms: [],
    tags: [],
  };
}

function releaseFor(
  reference: ArchitectureSkillRef,
  overrides: Partial<Pick<PublicReleaseMetadata, "slug" | "version">> & { digest?: string } = {},
): PublicReleaseMetadata {
  return {
    slug: overrides.slug ?? reference.slug,
    title: reference.title ?? reference.slug,
    summary: reference.summary ?? "",
    version: overrides.version ?? reference.version,
    lifecycleStatus: "approved",
    reviewStatus: "approved",
    securityStatus: "passed",
    publishedAt: "2026-08-30T00:00:00.000Z",
    platforms: [],
    artifact: {
      sha256: overrides.digest ?? reference.digest,
      byteSize: 1,
      contentType: "application/octet-stream",
    },
  };
}

function dependenciesFor(
  reference: ArchitectureSkillRef,
  options: {
    skill?: PublicSkill | null;
    release?: PublicReleaseMetadata | null;
    onActorLookup?: (slug: string, actor: string) => void;
    onTeamLookup?: (slug: string, team: string) => void;
    onOrganizationLookup?: (slug: string, organization: string) => void;
    organizationResult?: PublicSkill | null;
    onReleaseLookup?: (slug: string, version: string) => void;
  } = {},
): ExactReleaseResolutionDependencies {
  const skill = options.skill === undefined ? skillFor(reference) : options.skill;
  const release = options.release === undefined ? releaseFor(reference) : options.release;
  return {
    skillRepository: {
      getVisibleSkillBySlug: async (slug, requestedActorId) => {
        options.onActorLookup?.(slug, requestedActorId ?? "");
        return skill;
      },
      getSkillVisibleToTeamBySlug: async (slug, requestedTeamId) => {
        options.onTeamLookup?.(slug, requestedTeamId);
        return skill;
      },
      getSkillVisibleToOrganizationBySlug: async (slug, requestedOrganizationId) => {
        options.onOrganizationLookup?.(slug, requestedOrganizationId);
        return options.organizationResult === undefined ? skill : options.organizationResult;
      },
    },
    submissionService: {
      getPublicRelease: async ({ slug, version }) => {
        options.onReleaseLookup?.(slug, version);
        return release;
      },
    },
  };
}

function errorWithCode(code: string) {
  return (error: unknown): boolean => (
    error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === code
  );
}
