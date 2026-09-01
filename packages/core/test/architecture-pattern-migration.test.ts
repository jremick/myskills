import test from "node:test";
import assert from "node:assert/strict";
import {
  architecturePatternMigrationLimits,
  architecturePatternMigrationDiffDigest,
  architecturePatternMigrationDigest,
  assertValidArchitecturePatternMigrationInput,
  deriveArchitecturePatternMigration,
  validateArchitecturePatternMigrationInput,
  type ArchitecturePatternMigrationInput,
} from "../src/architecture-pattern-migration.js";
import {
  architectureDigest,
  compileArchitecture,
  createDomainRouterArchitecture,
  createFlatArchitecture,
  createMultiLevelRouterArchitecture,
  resolveArchitectureProfileBinding,
  type ArchitectureSpecV1,
} from "../src/architecture.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const skills = [
  { id: "release-notes", slug: "release-notes", title: "Release notes", version: "1.0.0", digest: digestA, packageVisibility: "private" as const },
  { id: "incident-helper", slug: "incident-helper", title: "Incident helper", version: "2.0.0", digest: digestB, packageVisibility: "team" as const },
];

function sourceFor(pattern: "flat" | "domain-router" | "multi-level-router"): ArchitectureSpecV1 {
  const input = {
    id: "migration-fixture",
    name: "Migration fixture",
    skills,
    profile: { id: "profile-main", name: "Main profile", subject: { type: "user" as const, id: "user-1" } },
    environment: { id: "environment-personal", name: "Personal", kind: "personal" as const },
    domains: [
      { id: "writing", label: "Writing", skillIds: ["release-notes"] },
      { id: "operations", label: "Operations", skillIds: ["incident-helper"] },
    ],
  };
  if (pattern === "flat") return createFlatArchitecture(input);
  if (pattern === "domain-router") return createDomainRouterArchitecture(input);
  return createMultiLevelRouterArchitecture(input);
}

function registryFor(spec: ArchitectureSpecV1) {
  return spec.skills.map((skill) => ({
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    version: skill.version,
    digest: skill.digest,
    packageVisibility: skill.packageVisibility,
  }));
}

test("derives every source/target pattern pair as a valid derive-shell result", () => {
  const patterns = ["flat", "domain-router", "multi-level-router"] as const;
  for (const sourcePattern of patterns) {
    for (const targetPatternId of patterns) {
      const source = sourceFor(sourcePattern);
      const result = deriveArchitecturePatternMigration({ source, targetPatternId });
      assert.equal(result.mode, "derive-shell");
      assert.notEqual(result.mappingStatus, "blocked", `${sourcePattern} -> ${targetPatternId} should be convertible`);
      if (result.mappingStatus === "blocked") continue;
      assert.equal(result.target.patternId, targetPatternId);
      assert.equal(result.target.spec.pattern.id, targetPatternId);
      assert.equal(result.target.spec.id, source.id);
      assert.deepEqual(result.target.spec.skills, source.skills);
      assert.equal(result.target.revisionDigest, architectureDigest(result.target.spec));
      assert.equal(result.issues.length, 0);
      assert.equal(result.migrationDigest, architecturePatternMigrationDigest(result));
      assert.equal(result.diffDigest, architecturePatternMigrationDiffDigest(result.diff));
    }
  }
});

test("preserves exact release refs and uses deterministic fallback topology", () => {
  const source = sourceFor("flat");
  const result = deriveArchitecturePatternMigration({ source, targetPatternId: "multi-level-router" });
  assert.equal(result.mappingStatus, "fallback");
  if (result.mappingStatus === "blocked") return;
  assert.deepEqual(result.target.spec.skills, source.skills);
  assert.deepEqual(
    result.target.spec.nodes.filter((node) => node.kind === "leaf").map((node) => ({ id: node.id, skillRefId: node.skillRefId })),
    source.nodes.map((node) => ({ id: node.id, skillRefId: node.kind === "leaf" ? node.skillRefId : undefined })),
  );
  assert.equal(result.target.spec.nodes.some((node) => node.id === "router-general" && node.kind === "router"), true);
  assert.equal(result.target.spec.edges.some((edge) => edge.from === "router-root" && edge.to === "router-general" && edge.kind === "contains"), true);
  assert.equal(result.diff.addedRouterNodeIds.includes("router-root"), true);
  assert.equal(result.diff.addedRouterNodeIds.includes("router-general"), true);
});

test("mapping groups are optional, bounded, and order-independent", () => {
  const source = sourceFor("flat");
  const mapping = {
    rootRouterId: "router-skills",
    rootLabel: "Skills",
    routerGroups: [
      { id: "router-ops", label: "Operations", leafNodeIds: ["leaf-incident-helper"] },
      { id: "router-writing", label: "Writing", leafNodeIds: ["leaf-release-notes"] },
    ],
  } as const;
  const first = deriveArchitecturePatternMigration({ source, targetPatternId: "multi-level-router", mapping });
  const reorderedSource = structuredClone(source);
  reorderedSource.skills.reverse();
  reorderedSource.nodes.reverse();
  reorderedSource.edges.reverse();
  reorderedSource.profiles[0].bindings.reverse();
  const second = deriveArchitecturePatternMigration({
    source: reorderedSource,
    targetPatternId: "multi-level-router",
    mapping: { ...mapping, routerGroups: [...mapping.routerGroups].reverse() },
  });
  assert.equal(first.mappingStatus, "provided");
  assert.equal(second.mappingStatus, "provided");
  assert.deepEqual(second, first);
  if (first.mappingStatus === "blocked") return;
  assert.equal(first.target.spec.nodes.filter((node) => node.kind === "router").length, 3);
  assert.equal(first.target.spec.edges.filter((edge) => edge.kind === "contains").length, 2);
  assert.equal(first.target.spec.edges.filter((edge) => edge.kind === "routes").length, 2);
});

test("preserves effective leaf exposure when collapsing a disabled ancestor", () => {
  const source = sourceFor("domain-router");
  const workEnvironment = {
    id: "environment-work",
    name: "Work",
    kind: "work" as const,
    profileId: source.profiles[0].id,
    parentId: source.environments[0].id,
  };
  source.environments.push(workEnvironment);
  const rootId = source.entryNodeIds[0];
  source.profiles[0].bindings.push({
    nodeId: rootId,
    environmentIds: [workEnvironment.id],
    enabled: false,
    runtimeExposure: "disabled",
  });
  const result = deriveArchitecturePatternMigration({ source, targetPatternId: "flat" });
  assert.notEqual(result.mappingStatus, "blocked");
  if (result.mappingStatus === "blocked") return;
  const beforePersonal = compileArchitecture(source, { registry: registryFor(source), environmentId: source.environments[0].id });
  const beforeWork = compileArchitecture(source, { registry: registryFor(source), environmentId: workEnvironment.id });
  const afterPersonal = compileArchitecture(result.target.spec, { registry: registryFor(result.target.spec), environmentId: source.environments[0].id });
  const afterWork = compileArchitecture(result.target.spec, { registry: registryFor(result.target.spec), environmentId: workEnvironment.id });
  assert.deepEqual(
    afterPersonal.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
    beforePersonal.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
  );
  assert.deepEqual(
    afterWork.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
    beforeWork.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
  );
  assert.equal(afterPersonal.nodes.some((node) => node.id === "leaf-release-notes"), true);
  assert.equal(afterWork.nodes.some((node) => node.id === "leaf-release-notes"), false);
  assert.equal(result.diff.rewrittenBindingCount > 0, true);
});

test("migration and compiler share deny-first overlay decisions regardless of binding order", () => {
  const source = sourceFor("multi-level-router");
  const profile = source.profiles[0];
  const personal = source.environments[0];
  const work = {
    id: "environment-work",
    name: "Work",
    kind: "work" as const,
    profileId: profile.id,
    parentId: personal.id,
  };
  const team = {
    id: "environment-team",
    name: "Team",
    kind: "team" as const,
    profileId: profile.id,
    parentId: work.id,
  };
  source.environments.push(work, team);

  const globallyDeniedLeafId = "leaf-release-notes";
  const ancestorDeniedLeafId = "leaf-incident-helper";
  profile.bindings = profile.bindings.filter((binding) => ![globallyDeniedLeafId, ancestorDeniedLeafId].includes(binding.nodeId));
  profile.bindings.push(
    // An explicit wildcard deny must beat the more-specific team allow.
    { nodeId: globallyDeniedLeafId, enabled: false, runtimeExposure: "disabled" },
    { nodeId: globallyDeniedLeafId, environmentIds: [team.id], enabled: true, runtimeExposure: "leaf" },
    // An ancestor deny must beat the selected team's allow, while personal
    // remains enabled through its own environment rule.
    { nodeId: ancestorDeniedLeafId, environmentIds: [personal.id], enabled: true, runtimeExposure: "leaf" },
    { nodeId: ancestorDeniedLeafId, environmentIds: [work.id], enabled: false, runtimeExposure: "disabled" },
    { nodeId: ancestorDeniedLeafId, environmentIds: [team.id], enabled: true, runtimeExposure: "leaf" },
  );

  const result = deriveArchitecturePatternMigration({ source, targetPatternId: "flat" });
  assert.notEqual(result.mappingStatus, "blocked");
  if (result.mappingStatus === "blocked") return;

  const reorderedSource = structuredClone(source);
  reorderedSource.profiles[0].bindings.reverse();
  reorderedSource.environments.reverse();
  const reorderedResult = deriveArchitecturePatternMigration({ source: reorderedSource, targetPatternId: "flat" });
  assert.deepEqual(reorderedResult, result);

  const registry = registryFor(source);
  for (const environment of source.environments) {
    const sourceCompiled = compileArchitecture(source, { registry, environmentId: environment.id });
    const targetCompiled = compileArchitecture(result.target.spec, {
      registry: registryFor(result.target.spec),
      environmentId: environment.id,
    });
    assert.deepEqual(
      targetCompiled.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
      sourceCompiled.nodes.filter((node) => node.kind === "leaf").map((node) => node.id),
      `migration must preserve compiled leaf exposure for ${environment.id}`,
    );

    for (const node of source.nodes.filter((candidate) => candidate.kind === "leaf")) {
      const sourceResolution = resolveArchitectureProfileBinding(source, {
        profileId: profile.id,
        environmentId: environment.id,
        nodeId: node.id,
      });
      const targetResolution = resolveArchitectureProfileBinding(result.target.spec, {
        profileId: profile.id,
        environmentId: environment.id,
        nodeId: node.id,
      });
      assert.equal(targetResolution.decision, sourceResolution.decision, `${node.id} decision changed in ${environment.id}`);
      assert.equal(targetResolution.binding?.runtimeExposure, sourceResolution.binding?.runtimeExposure, `${node.id} exposure changed in ${environment.id}`);
    }
  }

  assert.equal(
    resolveArchitectureProfileBinding(source, { profileId: profile.id, environmentId: team.id, nodeId: globallyDeniedLeafId }).provenance.reason,
    "explicit-deny",
  );
  assert.equal(
    resolveArchitectureProfileBinding(source, { profileId: profile.id, environmentId: team.id, nodeId: ancestorDeniedLeafId }).provenance.sourceEnvironmentId,
    work.id,
  );
});

test("invalid mapping and strict unknown fields return a blocked result", () => {
  const source = sourceFor("flat");
  const unknown = validateArchitecturePatternMigrationInput({ source, targetPatternId: "domain-router", mapping: { extra: true } });
  assert.equal(unknown.valid, false);
  if (unknown.valid) return;
  assert.equal(unknown.errors.some((error) => error.code === "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_UNKNOWN_FIELD"), true);
  const blockedUnknown = deriveArchitecturePatternMigration({ source, targetPatternId: "domain-router", mapping: { extra: true } } as never);
  assert.equal(blockedUnknown.mappingStatus, "blocked");

  const duplicate = deriveArchitecturePatternMigration({
    source,
    targetPatternId: "multi-level-router",
    mapping: {
      routerGroups: [
        { id: "router-a", label: "A", leafNodeIds: ["leaf-release-notes"] },
        { id: "router-b", label: "B", leafNodeIds: ["leaf-release-notes"] },
      ],
    },
  });
  assert.equal(duplicate.mappingStatus, "blocked");
  assert.equal(duplicate.issues.some((issue) => issue.code === "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_DUPLICATE"), true);

  const unassigned = deriveArchitecturePatternMigration({
    source,
    targetPatternId: "multi-level-router",
    mapping: { routerGroups: [{ id: "router-a", label: "A", leafNodeIds: ["leaf-release-notes"] }] },
  });
  assert.equal(unassigned.mappingStatus, "blocked");
  assert.equal(unassigned.issues.some((issue) => issue.code === "ARCHITECTURE_PATTERN_MIGRATION_MAPPING_LEAF_UNASSIGNED"), true);
});

test("blocked results bind a valid source revision and their own canonical digest", () => {
  const source = sourceFor("flat");
  const blocked = deriveArchitecturePatternMigration({
    source,
    targetPatternId: "flat",
    mapping: { rootLabel: "Not applicable" },
  });
  assert.equal(blocked.mappingStatus, "blocked");
  assert.equal(blocked.source.revisionDigest, architectureDigest(source));
  assert.equal(blocked.migrationDigest, architecturePatternMigrationDigest(blocked));
});

test("mapping and transformed binding limits block before a partial result", () => {
  const source = sourceFor("flat");
  const tooManyGroups = Array.from({ length: architecturePatternMigrationLimits.mappingGroups + 1 }, (_, index) => ({
    id: `router-${index}`,
    label: `Router ${index}`,
    leafNodeIds: ["leaf-release-notes"],
  }));
  const result = deriveArchitecturePatternMigration({ source, targetPatternId: "multi-level-router", mapping: { routerGroups: tooManyGroups } });
  assert.equal(result.mappingStatus, "blocked");
  assert.equal(result.target, null);
  assert.equal(result.issues.some((issue) => issue.code === "ARCHITECTURE_PATTERN_MIGRATION_LIMIT_EXCEEDED"), true);

  const largeSource = sourceFor("flat");
  largeSource.profiles[0].bindings = new Array(architectureLimitsForTest()).fill(largeSource.profiles[0].bindings[0]).map((binding, index) => ({
    ...binding,
    nodeId: index === 0 ? binding.nodeId : `leaf-extra-${index}`,
  })) as never;
  // The source is intentionally not made valid here; the contract must still
  // return a bounded blocked result instead of throwing or returning a shell.
  const invalidSource = deriveArchitecturePatternMigration({ source: largeSource, targetPatternId: "flat" });
  assert.equal(invalidSource.mappingStatus, "blocked");
});

function architectureLimitsForTest(): number {
  return 501;
}

test("input assertion exposes the normalized server-source contract", () => {
  const source = sourceFor("flat");
  const validated = assertValidArchitecturePatternMigrationInput({
    source,
    targetPatternId: "multi-level-router",
    mapping: {
      routerGroups: [{ id: "router-a", label: "A", leafNodeIds: ["leaf-release-notes", "leaf-incident-helper"] }],
      allowUnassignedLeafFallback: false,
    },
  } satisfies ArchitecturePatternMigrationInput);
  assert.equal(validated.source.id, source.id);
  assert.deepEqual(validated.mapping?.routerGroups?.[0].leafNodeIds, ["leaf-incident-helper", "leaf-release-notes"]);
});
