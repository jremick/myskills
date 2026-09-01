import test from "node:test";
import assert from "node:assert/strict";
import {
  architectureLimits,
  architectureDigest,
  architectureDiagramArtifactDigest,
  architectureDiagramLimits,
  architectureOutline,
  assertValidArchitectureSpec,
  accessibleMermaidArchitecture,
  canonicalArchitectureJson,
  canonicalArchitectureDiagramArtifactJson,
  compileArchitecture,
  createArchitectureDiagramArtifact,
  createAccessibleArchitectureOutline,
  createArchitectureFromPattern,
  createFlatArchitecture,
  createMultiLevelRouterArchitecture,
  environmentAncestors,
  mermaidArchitecture,
  planArchitectureSync,
  resolveArchitectureEnvironment,
  resolveArchitectureProfileBinding,
  sha256Hex,
  verifyArchitectureDiagramArtifact,
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
  assert.equal(unsafeResult.errors.some((error) => error.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD"), true);
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

test("environment resolution selects one context and returns the ordered parent chain", () => {
  const spec = createFlatArchitecture(factoryInput);
  const profileId = spec.profiles[0].id;
  const personal = spec.environments[0];
  const work = { id: "overlay-work", name: "Work", kind: "work" as const, profileId, parentId: personal.id };
  const team = { id: "overlay-team", name: "Team", kind: "team" as const, profileId, parentId: work.id };
  spec.environments.push(work, team);

  const resolved = resolveArchitectureEnvironment(spec, { environmentId: team.id, profileId });
  assert.equal(resolved.environment.id, team.id);
  assert.equal(resolved.profile.id, profileId);
  assert.deepEqual(resolved.ancestorIds, [team.id, work.id, personal.id]);
  assert.equal(resolveArchitectureEnvironment(spec, { environmentId: personal.id }).environment.kind, "personal");
  assert.equal(resolveArchitectureEnvironment(spec, { environmentId: work.id }).environment.kind, "work");
  assert.equal(resolveArchitectureEnvironment(spec, { environmentId: team.id }).environment.kind, "team");
  assert.deepEqual(environmentAncestors(spec, team.id), resolved.ancestorIds);

  assert.throws(
    () => resolveArchitectureEnvironment(spec, { environmentId: team.id, profileId: "other-profile" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_PROFILE_ENVIRONMENT_MISMATCH",
  );
  assert.throws(
    () => resolveArchitectureEnvironment(spec, { environmentId: "missing-environment" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_ENVIRONMENT_REQUIRED",
  );
  assert.throws(
    () => resolveArchitectureEnvironment(spec, {}),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_ENVIRONMENT_REQUIRED",
  );

  const cyclic = structuredClone(spec);
  cyclic.environments.find((environment) => environment.id === personal.id)!.parentId = team.id;
  assert.throws(
    () => resolveArchitectureEnvironment(cyclic, { environmentId: team.id }),
    (error: unknown) => error instanceof Error
      && "errors" in error
      && Array.isArray(error.errors)
      && error.errors.some((issue: unknown) => isRecordWithCode(issue, "ARCHITECTURE_ENVIRONMENT_PARENT_CYCLE")),
  );
});

test("profile binding resolution exposes deterministic environment provenance", () => {
  const spec = createFlatArchitecture(factoryInput);
  const profile = spec.profiles[0];
  const personal = spec.environments[0];
  const work = { id: "binding-work", name: "Work", kind: "work" as const, profileId: profile.id, parentId: personal.id };
  const team = { id: "binding-team", name: "Team", kind: "team" as const, profileId: profile.id, parentId: work.id };
  spec.environments.push(work, team);
  const nodeId = "leaf-release-notes";

  profile.bindings = [
    { nodeId, environmentIds: [personal.id], enabled: true, runtimeExposure: "leaf" },
    { nodeId, environmentIds: [work.id], enabled: true, runtimeExposure: "leaf" },
  ];
  const inherited = resolveArchitectureProfileBinding(spec, { profileId: profile.id, environmentId: team.id, nodeId });
  assert.equal(inherited.decision, "enabled");
  assert.equal(inherited.denied, false);
  assert.equal(inherited.specificity, 1);
  assert.equal(inherited.sourceEnvironmentId, work.id);
  assert.equal(inherited.wildcard, false);
  assert.deepEqual(inherited.provenance, {
    kind: "binding",
    reason: "ancestor-environment",
    sourceEnvironmentId: work.id,
    wildcard: false,
    specificity: 1,
    scopeKey: work.id,
  });

  profile.bindings = [{ nodeId, enabled: true, runtimeExposure: "leaf" }];
  const wildcard = resolveArchitectureProfileBinding(spec, { profileId: profile.id, environmentId: team.id, nodeId });
  assert.equal(wildcard.decision, "enabled");
  assert.equal(wildcard.denied, false);
  assert.equal(wildcard.specificity, Number.POSITIVE_INFINITY);
  assert.equal(wildcard.sourceEnvironmentId, undefined);
  assert.equal(wildcard.wildcard, true);
  assert.equal(wildcard.provenance.reason, "wildcard");

  profile.bindings = [];
  const missing = resolveArchitectureProfileBinding(spec, { profileId: profile.id, environmentId: team.id, nodeId });
  assert.equal(missing.decision, "disabled");
  assert.equal(missing.denied, false);
  assert.equal(missing.binding, undefined);
  assert.equal(missing.specificity, Number.POSITIVE_INFINITY);
  assert.equal(missing.wildcard, false);
  assert.deepEqual(missing.provenance, {
    kind: "missing",
    reason: "missing",
    wildcard: false,
    specificity: Number.POSITIVE_INFINITY,
    scopeKey: "none",
  });

  profile.bindings = [
    { nodeId, environmentIds: [work.id], enabled: false, runtimeExposure: "disabled" },
    { nodeId, environmentIds: [team.id], enabled: true, runtimeExposure: "leaf" },
  ];
  const ancestorDeny = resolveArchitectureProfileBinding(spec, { profileId: profile.id, environmentId: team.id, nodeId });
  assert.equal(ancestorDeny.decision, "disabled");
  assert.equal(ancestorDeny.denied, true);
  assert.equal(ancestorDeny.sourceEnvironmentId, work.id);
  assert.equal(ancestorDeny.specificity, 1);
  assert.equal(ancestorDeny.provenance.reason, "explicit-deny");

  profile.bindings = [
    { nodeId, enabled: false, runtimeExposure: "disabled" },
    { nodeId, environmentIds: [team.id], enabled: true, runtimeExposure: "leaf" },
  ];
  const globalDeny = resolveArchitectureProfileBinding(spec, { profileId: profile.id, environmentId: team.id, nodeId });
  assert.equal(globalDeny.decision, "disabled");
  assert.equal(globalDeny.denied, true);
  assert.equal(globalDeny.wildcard, true);
  assert.equal(globalDeny.provenance.reason, "explicit-deny");

  const reordered = structuredClone(spec);
  reordered.profiles[0].bindings.reverse();
  assert.deepEqual(
    resolveArchitectureProfileBinding(reordered, { profileId: profile.id, environmentId: team.id, nodeId }),
    globalDeny,
  );
});

test("package visibility does not change profile/environment runtime exposure", () => {
  const privateSpec = createFlatArchitecture(factoryInput);
  const publicSpec = structuredClone(privateSpec);
  publicSpec.skills[0].packageVisibility = "public";
  const environmentId = privateSpec.environments[0].id;
  const nodeId = "leaf-release-notes";
  const options = { profileId: privateSpec.profiles[0].id, environmentId, nodeId };
  const privateResolution = resolveArchitectureProfileBinding(privateSpec, options);
  const publicResolution = resolveArchitectureProfileBinding(publicSpec, options);
  assert.equal(privateResolution.decision, "enabled");
  assert.equal(publicResolution.decision, "enabled");
  assert.equal(privateResolution.denied, publicResolution.denied);
  assert.equal(privateResolution.provenance.reason, publicResolution.provenance.reason);
  assert.equal(privateResolution.binding?.runtimeExposure, publicResolution.binding?.runtimeExposure);
  assert.deepEqual(
    compileArchitecture(privateSpec, registryFor(privateSpec)).nodes,
    compileArchitecture(publicSpec, registryFor(publicSpec)).nodes,
  );
});

function isRecordWithCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

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
  assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD" && error.path === "metadata.PrOmPt"), true);
});

test("metadata privacy guard covers every architecture metadata location", () => {
  const locations: Array<[string, (spec: ArchitectureSpecV1) => void]> = [
    ["metadata", (spec) => { spec.metadata = { accessToken: "opaque" }; }],
    ["skills[0].metadata", (spec) => { spec.skills[0].metadata = { accessToken: "opaque" }; }],
    ["nodes[0].metadata", (spec) => { spec.nodes[0].metadata = { accessToken: "opaque" }; }],
    ["edges[0].metadata", (spec) => { spec.edges[0].metadata = { accessToken: "opaque" }; }],
    ["profiles[0].metadata", (spec) => { spec.profiles[0].metadata = { accessToken: "opaque" }; }],
    ["profiles[0].bindings[0].metadata", (spec) => { spec.profiles[0].bindings[0].metadata = { accessToken: "opaque" }; }],
    ["environments[0].metadata", (spec) => { spec.environments[0].metadata = { accessToken: "opaque" }; }],
  ];

  for (const [path, apply] of locations) {
    const spec = createMultiLevelRouterArchitecture(factoryInput);
    apply(spec);
    const result = validateArchitectureSpec(spec);
    assert.equal(result.valid, false, path);
    if (result.valid) continue;
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD" && error.path?.startsWith(path)), true, path);
  }
});

test("metadata privacy guard rejects nested sensitive fields, paths, URLs, controls, and oversized values without leakage", () => {
  const nested = createMultiLevelRouterArchitecture(factoryInput);
  const nestedSecret = "nested-secret-value-that-must-not-appear";
  nested.profiles[0].bindings[0].metadata = {
    display: { token: nestedSecret },
  } as never;
  const nestedResult = validateArchitectureSpec(nested);
  assert.equal(nestedResult.valid, false);
  if (!nestedResult.valid) {
    assert.equal(nestedResult.errors.some((error) => error.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD" && error.path?.endsWith(".display.token")), true);
    assert.equal(JSON.stringify(nestedResult.errors).includes(nestedSecret), false);
    assert.equal(nestedResult.errors.every((error) => !error.message.includes(nestedSecret)), true);
  }

  for (const key of ["secret", "token", "credential", "auth", "privateKey", "prompt", "content", "body", "packageBytes", "url", "endpoint", "path"]) {
    const spec = createFlatArchitecture(factoryInput);
    spec.metadata = { [key]: "opaque" };
    const result = validateArchitectureSpec(spec);
    assert.equal(result.valid, false, key);
    if (result.valid) continue;
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD" && error.path === `metadata.${key}`), true, key);
  }

  const unsafeValues = [
    "https://example.invalid/private-endpoint",
    "/Users/jarel/.codex/skills/private-skill",
    "line\u0000break",
    "token: do-not-store-this-value",
    "package bytes: AQIDBAUG",
  ];
  for (const value of unsafeValues) {
    const spec = createFlatArchitecture(factoryInput);
    spec.metadata = { note: value };
    const result = validateArchitectureSpec(spec);
    assert.equal(result.valid, false, value);
    if (result.valid) continue;
    assert.equal(result.errors.some((error) => error.code === "ARCHITECTURE_METADATA_UNSAFE_VALUE" && error.path === "metadata.note"), true, value);
    assert.equal(JSON.stringify(result.errors).includes(value), false, value);
  }

  const oversized = createFlatArchitecture(factoryInput);
  const oversizedValue = "x".repeat(architectureLimits.metadataStringLength + 1);
  oversized.metadata = { note: oversizedValue };
  const oversizedResult = validateArchitectureSpec(oversized);
  assert.equal(oversizedResult.valid, false);
  if (!oversizedResult.valid) {
    assert.equal(oversizedResult.errors.some((error) => error.code === "ARCHITECTURE_LIMIT_EXCEEDED" && error.path === "metadata.note"), true);
    assert.equal(JSON.stringify(oversizedResult.errors).includes(oversizedValue), false);
  }
});

test("safe scalar metadata remains available to compiled skills and diagram artifacts", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  spec.metadata = {
    label: "assistant-skills",
    count: 2,
    digest: digestA,
    enabled: true,
    note: null,
    diagramTitle: "Nested routing",
  };
  spec.skills[0].metadata = { label: "release-notes", count: 1, digest: digestA };
  spec.nodes[0].metadata = { label: "root-router", count: 3 };
  spec.edges[0].metadata = { label: "routes", count: 1 };
  spec.profiles[0].metadata = { label: "personal", enabled: true };
  spec.profiles[0].bindings[0].metadata = { label: "enabled", count: 1 };
  spec.environments[0].metadata = { label: "personal", count: 1 };

  const validation = validateArchitectureSpec(spec);
  assert.equal(validation.valid, true);
  if (!validation.valid) return;
  assert.deepEqual(validation.value.metadata, {
    count: 2,
    digest: digestA,
    diagramTitle: "Nested routing",
    enabled: true,
    label: "assistant-skills",
    note: null,
  });

  const registry = registryFor(spec).map((skill) => ({
    ...skill,
    metadata: { label: skill.slug, count: 1, digest: skill.digest },
  }));
  const compiled = compileArchitecture(spec, registry);
  assert.equal(compiled.skills.every((skill) => skill.metadata?.label === skill.slug), true);
  assert.equal(compiled.skills.every((skill) => skill.metadata?.digest === skill.digest), true);

  const artifact = createArchitectureDiagramArtifact(spec);
  assert.equal(verifyArchitectureDiagramArtifact(artifact), true);
  assert.match(artifact.mermaid, /Nested routing/);
  assert.doesNotMatch(artifact.mermaid, /package|token|secret|path|endpoint/i);
  assert.doesNotMatch(artifact.accessibleOutline, /package|token|secret|path|endpoint/i);
});

test("compiled output rejects unsafe authorized registry metadata before carrying it forward", () => {
  const spec = createFlatArchitecture(factoryInput);
  const registry = registryFor(spec).map((skill, index) => index === 0
    ? { ...skill, metadata: { token: "registry-secret-that-must-not-leak" } }
    : skill);
  assert.throws(
    () => compileArchitecture(spec, registry),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      if (!(error instanceof Error)) return false;
      assert.equal("code" in error && error.code, "ARCHITECTURE_REGISTRY_METADATA_INVALID");
      assert.equal("errors" in error, true);
      const errors = "errors" in error && Array.isArray(error.errors) ? error.errors : [];
      assert.equal(errors.some((issue) => issue.code === "ARCHITECTURE_METADATA_SENSITIVE_FIELD" && issue.path === "registry[0].metadata.token"), true);
      assert.equal(error.message.includes("registry-secret-that-must-not-leak"), false);
      assert.equal(JSON.stringify(errors).includes("registry-secret-that-must-not-leak"), false);
      return true;
    },
  );
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

test("compiler rejects ambiguous matching registry rows and remains order-independent otherwise", () => {
  const spec = createFlatArchitecture(factoryInput);
  const registry = registryFor(spec);
  const compiled = compileArchitecture(spec, registry);
  const reordered = compileArchitecture(spec, registry.slice().reverse());
  assert.deepEqual(reordered, compiled);

  const duplicate = [
    { ...registry[0], title: "First duplicate" },
    { ...registry[0], title: "Second duplicate" },
    ...registry.slice(1),
  ];
  for (const candidateSnapshot of [duplicate, duplicate.slice().reverse()]) {
    assert.throws(
      () => compileArchitecture(spec, candidateSnapshot),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_REGISTRY_SNAPSHOT_AMBIGUOUS",
    );
  }
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

test("accessible Mermaid projection is opt-in, bounded, metadata-aware, and escaped", () => {
  const spec = createFlatArchitecture({
    id: "accessible-mermaid-fixture",
    name: "Fallback architecture",
    skills: [{ id: "one", slug: "one", version: "1.0.0", digest: digestA }],
  });
  spec.description = "Fallback description";
  spec.metadata = {
    diagramTitle: 'Metadata "title"',
    diagramDescription: "Metadata & description",
  };

  const defaultMermaid = mermaidArchitecture(spec);
  assert.doesNotMatch(defaultMermaid, /accTitle|accDescr/);

  const metadataMermaid = mermaidArchitecture(spec, { accessible: true });
  assert.match(metadataMermaid, /accTitle: Metadata &quot;title&quot;/);
  assert.match(metadataMermaid, /accDescr: Metadata &amp; description/);
  assert.match(metadataMermaid, /accDescr:[^\n]*\n    /);

  const callerMermaid = accessibleMermaidArchitecture(spec, {
    title: 'Caller <title> & "quoted"\\line\nnext',
    description: "Caller <description> & details\r\nnext",
  });
  assert.match(callerMermaid, /accTitle: Caller &lt;title&gt; &amp; &quot;quoted&quot;\\\\line next/);
  assert.match(callerMermaid, /accDescr: Caller &lt;description&gt; &amp; details next/);
  assert.doesNotMatch(callerMermaid, /\nnext/);

  const boundedMermaid = accessibleMermaidArchitecture(spec, {
    title: "t".repeat(architectureDiagramLimits.titleLength + 20),
    description: "d".repeat(architectureDiagramLimits.descriptionLength + 20),
  });
  const titleLine = boundedMermaid.split("\n")[1] ?? "";
  const descriptionLine = boundedMermaid.split("\n")[2] ?? "";
  assert.equal(titleLine.length, "accTitle: ".length + architectureDiagramLimits.titleLength);
  assert.equal(descriptionLine.length, "accDescr: ".length + architectureDiagramLimits.descriptionLength);
});

test("diagram artifacts bind source, accessible projections, context, and only semantic content", () => {
  const spec = createMultiLevelRouterArchitecture(factoryInput);
  spec.description = "Nested router architecture";
  spec.metadata = { diagramTitle: "Nested routing" };
  const artifact = createArchitectureDiagramArtifact(spec, {
    description: "A bounded caller description",
  });
  const reordered = structuredClone(spec);
  reordered.skills.reverse();
  reordered.nodes.reverse();
  reordered.edges.reverse();
  reordered.entryNodeIds.reverse();
  reordered.profiles.reverse();
  reordered.environments.reverse();
  assert.deepEqual(createArchitectureDiagramArtifact(reordered, { description: "A bounded caller description" }), artifact);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.architectureId, spec.id);
  assert.equal(artifact.revisionDigest, architectureDigest(spec));
  assert.equal(artifact.mermaidSha256, sha256Hex(artifact.mermaid));
  assert.equal(artifact.artifactDigest, architectureDiagramArtifactDigest(artifact));
  assert.equal(artifact.artifactDigest, sha256Hex(canonicalArchitectureDiagramArtifactJson(artifact)));
  assert.equal(verifyArchitectureDiagramArtifact(artifact), true);
  assert.match(artifact.mermaid, /accTitle:/);
  assert.match(artifact.mermaid, /accDescr:/);
  assert.match(artifact.accessibleOutline, /Nested routing/);
  assert.match(artifact.accessibleOutline, /Incident helper/);
  assert.doesNotMatch(artifact.mermaid, /position|canvas|x:\s*\d|y:\s*\d/i);
  assert.doesNotMatch(artifact.accessibleOutline, /position|canvas|x:\s*\d|y:\s*\d/i);

  const changed = structuredClone(spec);
  changed.nodes.find((node) => node.id === "router-root")!.label = "Changed root";
  const changedArtifact = createArchitectureDiagramArtifact(changed, { description: "A bounded caller description" });
  assert.notEqual(changedArtifact.revisionDigest, artifact.revisionDigest);
  assert.notEqual(changedArtifact.artifactDigest, artifact.artifactDigest);

  const compiled = compileArchitecture(spec, registryFor(spec));
  const compiledArtifact = createArchitectureDiagramArtifact(compiled);
  assert.equal(compiledArtifact.revisionDigest, compiled.revisionDigest);
  assert.equal(compiledArtifact.profileId, compiled.profileId);
  assert.equal(compiledArtifact.environmentId, compiled.environmentId);
  assert.equal(verifyArchitectureDiagramArtifact(compiledArtifact), true);
  const positioned = structuredClone(compiled) as typeof compiled & { nodes: Array<typeof compiled.nodes[number] & { position: { x: number; y: number } }> };
  positioned.nodes = positioned.nodes.map((node, index) => ({ ...node, position: { x: index * 100, y: index * 200 } }));
  assert.deepEqual(createArchitectureDiagramArtifact(positioned), compiledArtifact);

  const otherContext = structuredClone(compiled);
  otherContext.profileId = "other-profile";
  const contextArtifact = createArchitectureDiagramArtifact(otherContext);
  assert.notEqual(contextArtifact.artifactDigest, compiledArtifact.artifactDigest);

  const tampered = { ...artifact, accessibleOutline: `${artifact.accessibleOutline} altered` };
  assert.equal(verifyArchitectureDiagramArtifact(tampered), false);
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
      targetId: "unknown-alias",
      skills: [{ nodeId: "leaf-release-notes", skillRefId: "missing-skill", slug: "release-notes", version: "1.0.0", digest: digestA, enabled: true, managed: true }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ARCHITECTURE_OBSERVED_IDENTITY_CONFLICT",
  );
  assert.throws(
    () => planArchitectureSync(compiled, {
      targetId: "unknown-explicit-node",
      skills: [{ nodeId: "unknown-node", skillRefId: "release-notes", slug: "release-notes", version: "1.0.0", digest: digestA, enabled: true, managed: true }],
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

  const unmanagedGenericRouter = planArchitectureSync(compiled, {
    targetId: "unmanaged-generic-router",
    nodes: [{ nodeId: "router-root", enabled: true, managed: false, runtimeExposure: "router" }],
  });
  assert.equal(unmanagedGenericRouter.items.find((item) => item.nodeId === "router-root")?.action, "unsupported");

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
