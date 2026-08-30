import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureLimits,
  architectureDigest,
  architectureOutline,
  assertValidArchitectureSpec,
  canonicalArchitectureJson,
  compileArchitecture,
  createAccessibleArchitectureOutline,
  createArchitectureFromPattern,
  createFlatArchitecture,
  createMultiLevelRouterArchitecture,
  mermaidArchitecture,
  planArchitectureSync,
  sha256Hex,
  validateArchitectureSpec,
  type ArchitectureFactoryInput,
  type ArchitectureSpecV1,
  type AuthorizedRegistrySnapshot,
} from "../src/index.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

const factoryInput: ArchitectureFactoryInput = {
  id: "assistant-skills",
  name: "Assistant Skills",
  skills: [
    { id: "release-notes", slug: "release-notes", title: "Release notes", version: "1.0.0", digest: digestA, domainId: "writing", packageVisibility: "private" },
    { id: "incident-helper", slug: "incident-helper", title: "Incident helper", version: "2.0.0", digest: digestB, domainId: "operations", packageVisibility: "team" },
  ],
};

function registryFor(spec: ArchitectureSpecV1): AuthorizedRegistrySnapshot {
  return spec.skills.map((skill) => ({
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    version: skill.version,
    digest: skill.digest,
    packageVisibility: skill.packageVisibility,
    tags: skill.tags,
    metadata: skill.metadata,
  }));
}

test("built-in factories produce flat, domain-router, and explicit nested router topologies", () => {
  const flat = createFlatArchitecture(factoryInput);
  assert.equal(flat.pattern.id, "flat");
  assert.equal(flat.nodes.every((node) => node.kind === "leaf"), true);
  assert.equal(flat.edges.length, 0);

  const domain = createArchitectureFromPattern("domain-router", factoryInput);
  assert.equal(domain.pattern.id, "domain-router");
  assert.equal(domain.nodes.filter((node) => node.kind === "router").length, 1);
  assert.equal(domain.edges.every((edge) => edge.kind === "routes"), true);

  const nested = createMultiLevelRouterArchitecture(factoryInput);
  assert.equal(nested.pattern.id, "multi-level-router");
  assert.equal(nested.nodes.filter((node) => node.kind === "router").length, 3);
  assert.equal(nested.edges.some((edge) => edge.kind === "contains"), true);
  assert.equal(nested.edges.some((edge) => edge.kind === "routes"), true);
  assert.deepEqual(nested.entryNodeIds, ["router-root"]);
});

test("validation rejects cycles, orphans, and non-metadata payloads with stable codes", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const cyclic = structuredClone(spec);
  cyclic.edges.push({ from: "router-writing", to: "router-root", kind: "contains" });
  const cycleResult = validateArchitectureSpec(cyclic);
  assert.equal(cycleResult.valid, false);
  if (cycleResult.valid) return;
  assert.equal(cycleResult.errors.some((error) => error.code === "ARCHITECTURE_CYCLE"), true);

  const orphaned = structuredClone(spec);
  orphaned.nodes.push({ id: "orphan", kind: "leaf", label: "Orphan", skillRefId: "release-notes" });
  const orphanResult = validateArchitectureSpec(orphaned);
  assert.equal(orphanResult.valid, false);
  if (orphanResult.valid) return;
  assert.equal(orphanResult.errors.some((error) => error.code === "ARCHITECTURE_ORPHAN_NODE"), true);

  const unsafe = structuredClone(spec);
  unsafe.metadata = { prompt: "must not be package content" };
  const unsafeResult = validateArchitectureSpec(unsafe);
  assert.equal(unsafeResult.valid, false);
  if (unsafeResult.valid) return;
  assert.equal(unsafeResult.errors.some((error) => error.code === "ARCHITECTURE_METADATA_NOT_METADATA"), true);
});

test("validation rejects oversized collections before traversing their entries", () => {
  const spec = createFlatArchitecture({
    id: "limits-fixture",
    name: "Limits fixture",
    skills: [{ id: "one", slug: "one", version: "1.0.0", digest: digestA }],
  });
  const tooManyNodes = structuredClone(spec);
  tooManyNodes.nodes = new Array(architectureLimits.nodes + 1).fill({ bad: true }) as never;
  const nodeResult = validateArchitectureSpec(tooManyNodes);
  assert.equal(nodeResult.valid, false);
  if (nodeResult.valid) return;
  assert.deepEqual(nodeResult.errors.map((error) => error.code), ["ARCHITECTURE_LIMIT_EXCEEDED"]);

  const tooManyBindings = structuredClone(spec);
  tooManyBindings.profiles[0].bindings = new Array(architectureLimits.bindingsPerProfile + 1).fill({ bad: true }) as never;
  const bindingResult = validateArchitectureSpec(tooManyBindings);
  assert.equal(bindingResult.valid, false);
  if (bindingResult.valid) return;
  assert.equal(bindingResult.errors.some((error) => error.code === "ARCHITECTURE_LIMIT_EXCEEDED"), true);
  assert.equal(bindingResult.errors.some((error) => error.code === "ARCHITECTURE_PROFILE_BINDING_INVALID"), false);

  const tooManyEntries = structuredClone(spec);
  tooManyEntries.entryNodeIds = new Array(architectureLimits.entryNodeIds + 1).fill("leaf-one");
  const entryResult = validateArchitectureSpec(tooManyEntries);
  assert.equal(entryResult.valid, false);
  if (entryResult.valid) return;
  assert.deepEqual(entryResult.errors.map((error) => error.code), ["ARCHITECTURE_LIMIT_EXCEEDED"]);
});

test("multi-level patterns require a nested-router-to-leaf path", () => {
  const malformed = createMultiLevelRouterArchitecture(factoryInput);
  malformed.edges = [
    ...malformed.edges.filter((edge) => edge.kind !== "routes"),
    { from: "router-root", to: "leaf-release-notes", kind: "routes" },
    { from: "router-root", to: "leaf-incident-helper", kind: "routes" },
  ];
  const result = validateArchitectureSpec(malformed);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_PATTERN_SHAPE_INVALID"), true);
});

test("profile binding precedence is deterministic and fail-closed", () => {
  const spec = createFlatArchitecture(factoryInput);
  const workEnvironment = { id: "assistant-skills-work", name: "Work", kind: "work" as const, profileId: spec.profiles[0].id };
  spec.environments.push(workEnvironment);
  const targetNodeId = "leaf-release-notes";
  spec.profiles[0].bindings.push({ nodeId: targetNodeId, environmentIds: [workEnvironment.id], enabled: false, runtimeExposure: "disabled" });

  const personal = compileArchitecture(spec, { registry: registryFor(spec), environmentId: spec.environments[0].id });
  const work = compileArchitecture(spec, { registry: registryFor(spec), environmentId: workEnvironment.id });
  assert.equal(personal.nodes.some((node) => node.id === targetNodeId), true);
  assert.equal(work.nodes.some((node) => node.id === targetNodeId), false);

  const reordered = structuredClone(spec);
  reordered.profiles[0].bindings.reverse();
  const reorderedWork = compileArchitecture(reordered, { registry: registryFor(reordered), environmentId: workEnvironment.id });
  assert.deepEqual(reorderedWork.nodes, work.nodes);
  assert.deepEqual(reorderedWork.disabledNodeIds, work.disabledNodeIds);

  const globalDeny = structuredClone(spec);
  globalDeny.profiles[0].bindings = globalDeny.profiles[0].bindings.filter((binding) => binding.nodeId !== targetNodeId);
  globalDeny.profiles[0].bindings.push(
    { nodeId: targetNodeId, enabled: false, runtimeExposure: "disabled" },
    { nodeId: targetNodeId, environmentIds: [workEnvironment.id], enabled: true, runtimeExposure: "leaf" },
  );
  const globalDenyWork = compileArchitecture(globalDeny, { registry: registryFor(globalDeny), environmentId: workEnvironment.id });
  assert.equal(globalDenyWork.nodes.some((node) => node.id === targetNodeId), false);
});

test("metadata deny-list matching is case-insensitive", () => {
  const spec = createFlatArchitecture({
    id: "metadata-case",
    name: "Metadata case",
    skills: [{ id: "one", slug: "one", version: "1.0.0", digest: digestA }],
  });
  spec.metadata = { PrOmPt: "not package metadata" };
  const result = validateArchitectureSpec(spec);
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_METADATA_NOT_METADATA" && error.path === "metadata.PrOmPt"), true);
});

test("known optional fields reject wrong JSON types instead of being dropped", () => {
  const base = createFlatArchitecture({
    id: "optional-field-types",
    name: "Optional field types",
    skills: [{ id: "one", slug: "one", version: "1.0.0", digest: digestA }],
  });

  const badDescription = structuredClone(base) as unknown as Record<string, unknown>;
  badDescription.description = 42;
  const descriptionResult = validateArchitectureSpec(badDescription);
  assert.equal(descriptionResult.valid, false);
  if (descriptionResult.valid) return;
  assert.equal(descriptionResult.errors.some((error) => error.code === "ARCHITECTURE_FIELD_TYPE_INVALID" && error.path === "description"), true);

  const badTitle = structuredClone(base);
  (badTitle.skills[0] as unknown as Record<string, unknown>).title = true;
  const titleResult = validateArchitectureSpec(badTitle);
  assert.equal(titleResult.valid, false);
  if (titleResult.valid) return;
  assert.equal(titleResult.errors.some((error) => error.code === "ARCHITECTURE_FIELD_TYPE_INVALID" && error.path === "skills[0].title"), true);

  const badSummary = structuredClone(base);
  (badSummary.skills[0] as unknown as Record<string, unknown>).summary = { text: "not a scalar" };
  const summaryResult = validateArchitectureSpec(badSummary);
  assert.equal(summaryResult.valid, false);
  if (summaryResult.valid) return;
  assert.equal(summaryResult.errors.some((error) => error.code === "ARCHITECTURE_FIELD_TYPE_INVALID" && error.path === "skills[0].summary"), true);
});

test("enabled runtime exposure must match the bound node kind", () => {
  const leafSpec = createFlatArchitecture(factoryInput);
  const leafBinding = leafSpec.profiles[0].bindings.find((binding) => binding.nodeId === "leaf-release-notes");
  assert.ok(leafBinding);
  leafBinding.runtimeExposure = "router";
  const leafResult = validateArchitectureSpec(leafSpec);
  assert.equal(leafResult.valid, false);
  if (leafResult.valid) return;
  assert.equal(leafResult.errors.some((error) => error.code === "ARCHITECTURE_PROFILE_BINDING_INVALID" && error.path.endsWith(".runtimeExposure")), true);

  const routerSpec = createArchitectureFromPattern("domain-router", factoryInput);
  const routerBinding = routerSpec.profiles[0].bindings.find((binding) => binding.nodeId === "router-root");
  assert.ok(routerBinding);
  routerBinding.runtimeExposure = "leaf";
  const routerResult = validateArchitectureSpec(routerSpec);
  assert.equal(routerResult.valid, false);
  if (routerResult.valid) return;
  assert.equal(routerResult.errors.some((error) => error.code === "ARCHITECTURE_PROFILE_BINDING_INVALID" && error.path.endsWith(".runtimeExposure")), true);
});

test("canonical JSON and SHA-256 digest are stable across object and set ordering", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const reordered = structuredClone(spec);
  reordered.skills.reverse();
  reordered.nodes.reverse();
  reordered.edges.reverse();
  reordered.entryNodeIds.reverse();
  assert.equal(canonicalArchitectureJson(spec), canonicalArchitectureJson(reordered));
  assert.equal(architectureDigest(spec), architectureDigest(reordered));
  assert.equal(assertValidArchitectureSpec(spec).schemaVersion, 1);
});

test("compiler requires an authorized exact registry snapshot and fails closed for missing bindings", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const compiled = compileArchitecture(spec, registryFor(spec));
  assert.equal(compiled.nodes.some((node) => node.id === "router-root"), true);
  assert.equal(compiled.nodes.some((node) => node.id === "router-writing"), true);
  assert.equal(compiled.nodes.some((node) => node.id === "leaf-release-notes"), true);
  assert.equal(compiled.skills.length, 2);

  const missing = registryFor(spec).slice(0, 1);
  assert.throws(() => compileArchitecture(spec, missing), (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_REGISTRY_SNAPSHOT_MISSING");

  const failClosed = structuredClone(spec);
  failClosed.profiles[0].bindings = failClosed.profiles[0].bindings.filter((binding) => binding.nodeId !== "leaf-release-notes");
  const failClosedCompiled = compileArchitecture(failClosed, registryFor(failClosed));
  assert.equal(failClosedCompiled.disabledNodeIds.includes("leaf-release-notes"), true);
  assert.equal(failClosedCompiled.nodes.some((node) => node.id === "leaf-release-notes"), false);
  // The package is team-visible while runtime exposure is profile-controlled.
  assert.equal(spec.skills.find((skill) => skill.id === "incident-helper")?.packageVisibility, "team");
  assert.equal(compiled.nodes.find((node) => node.id === "leaf-incident-helper")?.runtimeExposure, "leaf");
});

test("Mermaid and accessible outline projections preserve nested topology", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const mermaid = mermaidArchitecture(spec);
  assert.match(mermaid, /flowchart TD/);
  assert.match(mermaid, /contains/);
  assert.match(mermaid, /routes/);
  assert.match(mermaid, /router-root/);

  const outline = createAccessibleArchitectureOutline(spec);
  assert.match(outline.text, /Assistant Skills/);
  assert.match(outline.text, /Incident helper/);
  assert.match(outline.html, /role="tree"/);
  assert.match(outline.html, /role="treeitem"/);
  assert.equal(architectureOutline(spec), outline.text);
});

test("Mermaid projection avoids sanitized id collisions and escapes labels", () => {
  const spec = createFlatArchitecture({
    id: "mermaid-fixture",
    name: "Mermaid fixture",
    skills: [
      { id: "alpha-beta", slug: "alpha-one", title: 'Quote " & <tag>\nline', version: "1.0.0", digest: digestA },
      { id: "alpha_beta", slug: "alpha-two", title: "Second", version: "1.0.0", digest: digestB },
    ],
  });
  const mermaid = mermaidArchitecture(spec);
  const collisionSafeIds = mermaid.match(/node_leaf_alpha_beta_[a-f0-9]{12}/g) ?? [];
  assert.equal(new Set(collisionSafeIds).size, 2);
  assert.match(mermaid, /&quot;/);
  assert.match(mermaid, /&amp;/);
  assert.match(mermaid, /&lt;tag&gt;/);
  assert.doesNotMatch(mermaid, /\nline/);
});

test("dry-run planner emits deterministic lifecycle actions and never enables apply", () => {
  const spec = createFlatArchitecture({
    id: "sync-fixture",
    name: "Sync fixture",
    skills: [{ id: "sync-skill", slug: "sync-skill", version: "1.0.0", digest: digestA }],
  });
  const compiled = compileArchitecture(spec, registryFor(spec));
  const leafId = "leaf-sync-skill";
  const common = { nodeId: leafId, skillRefId: "sync-skill", slug: "sync-skill", enabled: true, managed: true, runtimeExposure: "leaf" as const };
  const plan = planArchitectureSync(compiled, { targetId: "fixture-target", skills: [{ ...common, version: "1.0.0", digest: digestA }] });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.canApply, false);
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.items.find((item) => item.nodeId === leafId)?.action, "noop");

  const actions = [
    ["install", { targetId: "install", skills: [] }],
    ["enable", { targetId: "enable", skills: [{ ...common, version: "1.0.0", digest: digestA, enabled: false }] }],
    ["update", { targetId: "update", skills: [{ ...common, version: "0.9.0", digest: digestA }] }],
    ["downgrade", { targetId: "downgrade", skills: [{ ...common, version: "1.1.0", digest: digestA }] }],
    ["conflict", { targetId: "conflict", skills: [{ ...common, version: "1.0.0", digest: digestB }] }],
    ["unsupported", { targetId: "unsupported", skills: [{ ...common, version: "1.0.0", digest: digestA, supported: false }] }],
    ["remove", { targetId: "remove", skills: [{ ...common, version: "1.0.0", digest: digestA }, { ...common, nodeId: "leaf-old", skillRefId: "old", slug: "old", version: "1.0.0", digest: digestA }] }],
  ] as const;
  for (const [expected, observed] of actions) {
    const action = planArchitectureSync(compiled, observed).items.find((item) => item.nodeId === (expected === "remove" ? "leaf-old" : leafId))?.action;
    assert.equal(action, expected);
  }

  const disabledSpec = structuredClone(spec);
  disabledSpec.profiles[0].bindings = [{ nodeId: leafId, enabled: false, runtimeExposure: "disabled" }];
  const disabledCompiled = compileArchitecture(disabledSpec, registryFor(disabledSpec));
  const disabledAction = planArchitectureSync(disabledCompiled, { targetId: "disable", skills: [{ ...common, version: "1.0.0", digest: digestA }] }).items.find((item) => item.nodeId === leafId)?.action;
  assert.equal(disabledAction, "disable");

  const disabledSlugPlan = planArchitectureSync(disabledCompiled, {
    targetId: "disabled-slug",
    skills: [{ slug: "sync-skill", version: "1.0.0", digest: digestA, enabled: false, runtimeExposure: "disabled", managed: true }],
  });
  assert.equal(disabledSlugPlan.items.find((item) => item.nodeId === leafId)?.action, "noop");
  assert.equal(disabledSlugPlan.items.some((item) => item.action === "remove"), false);
});

test("generic observed nodes with incomplete active state fail closed", () => {
  const spec = createFlatArchitecture({
    id: "incomplete-observed-state",
    name: "Incomplete observed state",
    skills: [{ id: "incomplete-skill", slug: "incomplete-skill", version: "1.0.0", digest: digestA }],
  });
  const compiled = compileArchitecture(spec, registryFor(spec));
  const leafId = "leaf-incomplete-skill";
  const commonNode = {
    nodeId: leafId,
    kind: "leaf" as const,
    skillRefId: "incomplete-skill",
    slug: "incomplete-skill",
    version: "1.0.0",
    digest: digestA,
    managed: true,
  };

  const missingEnabled = planArchitectureSync(compiled, {
    targetId: "missing-enabled",
    nodes: [{ ...commonNode, runtimeExposure: "leaf" }],
  });
  assert.equal(missingEnabled.items.find((item) => item.nodeId === leafId)?.action, "unsupported");

  const missingRuntimeExposure = planArchitectureSync(compiled, {
    targetId: "missing-runtime-exposure",
    nodes: [{ ...commonNode, enabled: true }],
  });
  assert.equal(missingRuntimeExposure.items.find((item) => item.nodeId === leafId)?.action, "unsupported");

  const wrongKind = planArchitectureSync(compiled, {
    targetId: "router-for-leaf",
    nodes: [{ ...commonNode, kind: "router", enabled: true, runtimeExposure: "leaf" }],
  });
  assert.equal(wrongKind.items.find((item) => item.nodeId === leafId)?.action, "unsupported");

  const strictSkillFixture = planArchitectureSync(compiled, {
    targetId: "strict-skill-fixture",
    skills: [{ nodeId: leafId, slug: "incomplete-skill", version: "1.0.0", digest: digestA, enabled: true, managed: true }],
  });
  assert.equal(strictSkillFixture.items.find((item) => item.nodeId === leafId)?.action, "unsupported");

  const completeSkillFixture = planArchitectureSync(compiled, {
    targetId: "complete-skill-fixture",
    skills: [{ nodeId: leafId, slug: "incomplete-skill", version: "1.0.0", digest: digestA, enabled: true, runtimeExposure: "leaf", managed: true }],
  });
  assert.equal(completeSkillFixture.items.find((item) => item.nodeId === leafId)?.action, "noop");
});

test("dry-run planner uses SemVer prerelease precedence", () => {
  const spec = createFlatArchitecture({
    id: "semver-fixture",
    name: "SemVer fixture",
    skills: [{ id: "semver-skill", slug: "semver-skill", version: "1.0.0-rc.10", digest: digestA }],
  });
  const compiled = compileArchitecture(spec, registryFor(spec));
  const action = planArchitectureSync(compiled, {
    targetId: "semver-target",
    skills: [{ nodeId: "leaf-semver-skill", skillRefId: "semver-skill", slug: "semver-skill", version: "1.0.0-rc.2", digest: digestA, enabled: true, runtimeExposure: "leaf", managed: true }],
  }).items.find((item) => item.nodeId === "leaf-semver-skill")?.action;
  assert.equal(action, "update");

  const stableSpec = createFlatArchitecture({
    id: "stable-fixture",
    name: "Stable fixture",
    skills: [{ id: "stable-skill", slug: "stable-skill", version: "1.0.0", digest: digestA }],
  });
  const stableCompiled = compileArchitecture(stableSpec, registryFor(stableSpec));
  const stableAction = planArchitectureSync(stableCompiled, {
    targetId: "stable-target",
    skills: [{ nodeId: "leaf-stable-skill", skillRefId: "stable-skill", slug: "stable-skill", version: "1.0.0-rc.10", digest: digestA, enabled: true, runtimeExposure: "leaf", managed: true }],
  }).items.find((item) => item.nodeId === "leaf-stable-skill")?.action;
  assert.equal(stableAction, "update");

  assert.throws(
    () => createFlatArchitecture({
      id: "invalid-prerelease",
      name: "Invalid prerelease",
      skills: [{ id: "invalid-skill", slug: "invalid-skill", version: "1.0.0-rc.01", digest: digestA }],
    }),
    /ARCHITECTURE_SKILL_VERSION_INVALID/,
  );
});

test("unmanaged observed state never produces a mutation action", () => {
  const spec = createFlatArchitecture({
    id: "managed-fixture",
    name: "Managed fixture",
    skills: [{ id: "managed-skill", slug: "managed-skill", version: "1.0.0", digest: digestA }],
  });
  const compiled = compileArchitecture(spec, registryFor(spec));
  const items = planArchitectureSync(compiled, {
    targetId: "unmanaged-target",
    skills: [
      { nodeId: "leaf-managed-skill", skillRefId: "managed-skill", slug: "managed-skill", version: "0.9.0", digest: digestA, enabled: true, managed: false },
      { nodeId: "unmanaged-extra", slug: "unmanaged-extra", version: "1.0.0", digest: digestA, enabled: true, managed: false },
    ],
  }).items;
  assert.equal(items.find((item) => item.nodeId === "leaf-managed-skill")?.action, "unsupported");
  assert.equal(items.find((item) => item.nodeId === "unmanaged-extra")?.action, "unsupported");
  assert.equal(items.some((item) => ["update", "downgrade", "enable", "disable", "remove", "configure-router"].includes(item.action)), false);
});

test("environment mismatch and observed identity conflicts fail closed", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const compiled = compileArchitecture(spec, registryFor(spec));
  assert.throws(
    () => planArchitectureSync(compiled, { targetId: "wrong-env", environmentId: "other", skills: [] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_ENVIRONMENT_MISMATCH",
  );
  assert.throws(
    () => compileArchitecture(spec, { registry: registryFor(spec), profileId: "other-profile", environmentId: spec.environments[0].id }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_PROFILE_ENVIRONMENT_MISMATCH",
  );

  assert.throws(
    () => planArchitectureSync(compiled, {
      targetId: "duplicate-node",
      skills: [
        { nodeId: "leaf-release-notes", skillRefId: "release-notes", slug: "release-notes", version: "1.0.0", digest: digestA, enabled: true, managed: true },
        { nodeId: "leaf-release-notes", skillRefId: "incident-helper", slug: "incident-helper", version: "2.0.0", digest: digestB, enabled: true, managed: true },
      ],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
  );
  assert.throws(
    () => planArchitectureSync(compiled, {
      targetId: "cross-identity",
      skills: [{ nodeId: "leaf-release-notes", skillRefId: "incident-helper", slug: "incident-helper", version: "2.0.0", digest: digestB, enabled: true, managed: true }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
  );
  assert.throws(
    () => planArchitectureSync(compiled, {
      targetId: "cross-record-identity",
      skills: [
        { nodeId: "leaf-release-notes", skillRefId: "release-notes", slug: "release-notes", version: "1.0.0", digest: digestA, enabled: true, managed: true },
        { nodeId: "another-node", skillRefId: "release-notes", slug: "release-notes", version: "1.0.0", digest: digestA, enabled: true, managed: true },
      ],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
  );

  const duplicateSlug = createFlatArchitecture({
    id: "duplicate-slug",
    name: "Duplicate slug",
    skills: [
      { id: "skill-a", slug: "shared-slug", version: "1.0.0", digest: digestA },
      { id: "skill-b", slug: "shared-slug", version: "1.0.0", digest: digestB },
    ],
  });
  const duplicateSlugCompiled = compileArchitecture(duplicateSlug, registryFor(duplicateSlug));
  assert.throws(
    () => planArchitectureSync(duplicateSlugCompiled, { targetId: "duplicate-slug-target", skills: [{ slug: "shared-slug", version: "1.0.0", digest: digestA, enabled: true, managed: true }] }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
  );
});

test("router-only observed state receives configure-router when topology is missing or changed", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  const compiled = compileArchitecture(spec, registryFor(spec));
  const rootRouter = compiled.routers.find((router) => router.nodeId === "router-root");
  assert.ok(rootRouter);
  const plan = planArchitectureSync(compiled, {
    targetId: "router-target",
    routers: [{ nodeId: "router-root", configured: true, managed: true, configurationDigest: "0".repeat(64) }],
    skills: [],
  });
  assert.equal(plan.items.find((item) => item.nodeId === "router-root")?.action, "configure-router");

  const wrongKind = planArchitectureSync(compiled, {
    targetId: "leaf-for-router",
    nodes: [{ nodeId: "router-root", kind: "leaf", enabled: true, runtimeExposure: "leaf" }],
  });
  assert.equal(wrongKind.items.find((item) => item.nodeId === "router-root")?.action, "unsupported");
});

test("skill-backed routers reconcile package lifecycle and router configuration together", () => {
  const spec = createArchitectureFromPattern("domain-router", {
    id: "skill-backed-router",
    name: "Skill-backed router",
    skills: [
      { id: "router-skill", slug: "router-skill", title: "Router skill", version: "1.0.0", digest: digestA },
      { id: "leaf-skill", slug: "leaf-skill", title: "Leaf skill", version: "1.0.0", digest: digestB },
    ],
  });
  const root = spec.nodes.find((node) => node.id === "router-root");
  assert.ok(root);
  root.skillRefId = "router-skill";
  const compiled = compileArchitecture(spec, registryFor(spec));
  const desiredRouter = compiled.routers.find((router) => router.nodeId === "router-root");
  assert.ok(desiredRouter);
  const packageObservation = {
    nodeId: "router-root",
    skillRefId: "router-skill",
    slug: "router-skill",
    version: "1.0.0",
    digest: digestA,
    enabled: true,
    runtimeExposure: "router" as const,
    managed: true,
  };
  const configurationObservation = {
    nodeId: "router-root",
    configurationDigest: desiredRouter.digest,
    configured: true,
    managed: true,
  };

  const converged = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-converged",
    skills: [packageObservation],
    routers: [configurationObservation],
  });
  assert.equal(converged.items.find((item) => item.nodeId === "router-root")?.action, "noop");

  const lifecycleDrift = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-update",
    skills: [{ ...packageObservation, version: "0.9.0" }],
    routers: [configurationObservation],
  });
  assert.equal(lifecycleDrift.items.find((item) => item.nodeId === "router-root")?.action, "update");

  const combinedDrift = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-combined-drift",
    skills: [{ ...packageObservation, version: "0.9.0" }],
    routers: [{ ...configurationObservation, configurationDigest: "0".repeat(64) }],
  });
  assert.deepEqual(
    combinedDrift.items.filter((item) => item.nodeId === "router-root").map((item) => item.action),
    ["update", "configure-router"],
  );

  const configurationDrift = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-configure",
    skills: [packageObservation],
    routers: [{ ...configurationObservation, configurationDigest: "0".repeat(64) }],
  });
  assert.equal(configurationDrift.items.find((item) => item.nodeId === "router-root")?.action, "configure-router");

  const missingConfiguration = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-missing-config",
    skills: [packageObservation],
  });
  assert.equal(missingConfiguration.items.find((item) => item.nodeId === "router-root")?.action, "configure-router");

  const absentPackageAndConfiguration = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-absent",
    skills: [],
    routers: [],
  });
  assert.deepEqual(
    absentPackageAndConfiguration.items.filter((item) => item.nodeId === "router-root").map((item) => item.action),
    ["install", "configure-router"],
  );

  const unmanagedConfiguration = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-unmanaged-config",
    skills: [packageObservation],
    routers: [{ ...configurationObservation, configurationDigest: "0".repeat(64), managed: false }],
  });
  assert.equal(unmanagedConfiguration.items.find((item) => item.nodeId === "router-root")?.action, "unsupported");

  const unsupportedConfiguration = planArchitectureSync(compiled, {
    targetId: "skill-backed-router-unsupported-config",
    skills: [packageObservation],
    routers: [{ ...configurationObservation, configurationDigest: "0".repeat(64), supported: false }],
  });
  assert.equal(unsupportedConfiguration.items.find((item) => item.nodeId === "router-root")?.action, "unsupported");
});
