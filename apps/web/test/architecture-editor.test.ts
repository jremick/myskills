import test from "node:test";
import assert from "node:assert/strict";
import {
  createFlatArchitecture,
  createMultiLevelRouterArchitecture,
  type ArchitectureSpecV1,
} from "@myskills-app/core";
import {
  addArchitectureEnvironment,
  addArchitectureNode,
  addArchitectureProfile,
  architectureSpecKey,
  cloneArchitectureSpec,
  createArchitectureTree,
  descendantsOf,
  environmentParentOptions,
  flattenArchitectureTree,
  moveArchitectureNode,
  moveTargetsForNode,
  parentNodeId,
  profileBinding,
  removeArchitectureEnvironment,
  removeArchitectureNode,
  removeArchitectureProfile,
  updateArchitectureProfileBinding,
  updateArchitectureEnvironment,
  validationIssues,
} from "../src/components/architecture/editor/draft.js";
import {
  layoutArchitectureGraph,
  projectArchitectureToFlow,
} from "../src/components/architecture/editor/layout.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);

function fixture(): ArchitectureSpecV1 {
  return createMultiLevelRouterArchitecture({
    id: "editor-fixture",
    name: "Editor fixture",
    skills: [
      { id: "release-notes", slug: "release-notes", title: "Release notes", version: "1.0.0", digest: digestA, domainId: "writing" },
      { id: "incident-helper", slug: "incident-helper", title: "Incident helper", version: "1.0.0", digest: digestB, domainId: "operations" },
    ],
  });
}

test("outline projection preserves nested topology and supports keyboard-order flattening", () => {
  const spec = fixture();
  const tree = createArchitectureTree(spec);
  assert.deepEqual(tree.map((item) => item.node.id), ["router-root"]);
  const domainIds = spec.edges.filter((edge) => edge.from === "router-root").map((edge) => edge.to);
  assert.deepEqual(tree[0]?.children.map((item) => item.node.id), domainIds);
  const collapsed = flattenArchitectureTree(tree, new Set(["router-root"]));
  assert.deepEqual(collapsed.map((item) => item.node.id), ["router-root", ...domainIds]);
  const expanded = flattenArchitectureTree(tree, new Set(spec.nodes.filter((node) => node.kind === "router").map((node) => node.id)));
  assert.deepEqual(expanded.map((item) => item.node.id), ["router-root", ...tree[0]!.children.flatMap((item) => [item.node.id, ...item.children.map((child) => child.node.id)])]);
});

test("Dagre layout is deterministic and flow projection carries no draft position fields", () => {
  const spec = fixture();
  const first = layoutArchitectureGraph(spec);
  const second = layoutArchitectureGraph(spec);
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first).length, spec.nodes.length);
  const projection = projectArchitectureToFlow(spec, "router-writing", first);
  assert.equal(projection.nodes.length, spec.nodes.length);
  assert.equal(projection.edges.length, spec.edges.length);
  assert.equal(projection.nodes.find((node) => node.id === "router-writing")?.data.selected, true);
  assert.equal("position" in spec.nodes[0]!, false);
  assert.match(projection.nodes[0]?.ariaLabel ?? "", /Router|Leaf/);
});

test("node mutations are immutable, add explicit disabled bindings, and move by semantic parent", () => {
  const original = fixture();
  const originalKey = architectureSpecKey(original);
  const added = addArchitectureNode(original, "leaf", "router-writing", "release-notes");
  assert.equal(architectureSpecKey(original), originalKey);
  const newNode = added.nodes[added.nodes.length - 1]!;
  assert.equal(newNode.kind, "leaf");
  assert.equal(parentNodeId(added, newNode.id), "router-writing");
  assert.equal(added.edges.some((edge) => edge.from === "router-writing" && edge.to === newNode.id && edge.kind === "routes"), true);
  assert.equal(added.profiles[0]?.bindings.find((binding) => binding.nodeId === newNode.id)?.enabled, false);
  assert.equal(moveTargetsForNode(added, newNode.id).some((target) => target.id === "router-operations"), true);

  const moved = moveArchitectureNode(added, newNode.id, "router-operations");
  assert.equal(parentNodeId(moved, newNode.id), "router-operations");
  assert.equal(moved.entryNodeIds.includes(newNode.id), false);
  const rooted = moveArchitectureNode(moved, newNode.id, null);
  assert.equal(parentNodeId(rooted, newNode.id), null);
  assert.equal(rooted.entryNodeIds.includes(newNode.id), true);
});

test("remove removes a subtree and its bindings but keeps the skill catalogue", () => {
  const spec = fixture();
  const removed = removeArchitectureNode(spec, "router-writing");
  assert.equal(removed.nodes.some((node) => node.id === "router-writing"), false);
  assert.equal(removed.nodes.some((node) => node.id === "leaf-release-notes"), false);
  assert.equal(removed.profiles.every((profile) => profile.bindings.every((binding) => !binding.nodeId.includes("writing") && binding.nodeId !== "leaf-release-notes")), true);
  assert.equal(removed.skills.some((skill) => skill.id === "release-notes"), true);
  assert.equal(descendantsOf(spec, "router-writing").has("leaf-release-notes"), true);
});

test("profile and environment controls preserve valid references and explicit exposure scope", () => {
  const spec = fixture();
  const withProfile = addArchitectureProfile(spec);
  const newProfile = withProfile.profiles[withProfile.profiles.length - 1]!;
  const withEnvironment = addArchitectureEnvironment(withProfile, newProfile.id, "team");
  const newEnvironment = withEnvironment.environments[withEnvironment.environments.length - 1]!;
  assert.equal(newEnvironment.profileId, newProfile.id);
  assert.equal(newEnvironment.kind, "team");

  const targetNode = withEnvironment.nodes.find((node) => node.kind === "leaf")!;
  const bound = updateArchitectureProfileBinding(withEnvironment, newProfile.id, targetNode.id, {
    enabled: true,
    runtimeExposure: "leaf",
    environmentIds: [newEnvironment.id],
  });
  const binding = profileBinding(bound, newProfile.id, targetNode.id);
  assert.deepEqual(binding.environmentIds, [newEnvironment.id]);
  assert.equal(binding.enabled, true);
  assert.equal(validationIssues(bound).length, 0);

  const removedEnvironment = removeArchitectureEnvironment(bound, newEnvironment.id);
  assert.equal(removedEnvironment.environments.some((environment) => environment.id === newEnvironment.id), false);
  // Removing a profile rehomes its environments to the remaining profile.
  const removedProfile = removeArchitectureProfile(removedEnvironment, newProfile.id);
  assert.equal(removedProfile.profiles.some((profile) => profile.id === newProfile.id), false);
  assert.equal(removedProfile.environments.every((environment) => removedProfile.profiles.some((profile) => profile.id === environment.profileId)), true);
});

test("environment editing keeps kinds explicit and excludes self and descendants from parent choices", () => {
  const spec = fixture();
  const profileId = spec.profiles[0]!.id;
  const [root, child, grandchild] = [
    { id: "environment-root", name: "Root", kind: "personal" as const, profileId },
    { id: "environment-child", name: "Child", kind: "work" as const, profileId, parentId: "environment-root" },
    { id: "environment-grandchild", name: "Grandchild", kind: "team" as const, profileId, parentId: "environment-child" },
  ];
  const withEnvironments = { ...spec, environments: [root, child, grandchild] };
  const options = environmentParentOptions(withEnvironments, root.id);
  assert.equal(options.some((option) => option.id === root.id), false);
  assert.equal(options.some((option) => option.id === child.id), false);
  assert.equal(options.some((option) => option.id === grandchild.id), false);
  assert.equal(options[0]?.id, null);

  const withKindAndParent = updateArchitectureEnvironment(withEnvironments, root.id, { kind: "team", parentId: null });
  assert.equal(withKindAndParent.environments.find((environment) => environment.id === root.id)?.kind, "team");
  const reparented = updateArchitectureEnvironment(withEnvironments, grandchild.id, { parentId: null });
  assert.equal(reparented.environments.find((environment) => environment.id === grandchild.id)?.parentId, null);
});

test("removing an environment reparents children and removes stale scoped bindings", () => {
  const spec = fixture();
  const profileId = spec.profiles[0]!.id;
  const withEnvironments = {
    ...spec,
    environments: [
      { id: "environment-root", name: "Root", kind: "personal" as const, profileId },
      { id: "environment-child", name: "Child", kind: "work" as const, profileId, parentId: "environment-root" },
      { id: "environment-grandchild", name: "Grandchild", kind: "team" as const, profileId, parentId: "environment-child" },
    ],
    profiles: spec.profiles.map((profile) => ({
      ...profile,
      bindings: profile.bindings.map((binding) => ({ ...binding, environmentIds: ["environment-child", "environment-grandchild"] })),
    })),
  };
  const removed = removeArchitectureEnvironment(withEnvironments, "environment-child");
  assert.equal(removed.environments.find((environment) => environment.id === "environment-grandchild")?.parentId, "environment-root");
  assert.equal(removed.profiles[0]?.bindings.every((binding) => !binding.environmentIds?.includes("environment-child")), true);
});

test("flat pattern move targets stay top-level and cloning protects the caller's revision", () => {
  const spec = createFlatArchitecture({
    id: "flat-editor-fixture",
    name: "Flat editor fixture",
    skills: [{ id: "one", slug: "one", title: "One", version: "1.0.0", digest: digestA }],
  });
  const clone = cloneArchitectureSpec(spec);
  clone.name = "Changed draft";
  assert.equal(spec.name, "Flat editor fixture");
  assert.deepEqual(moveTargetsForNode(spec, "leaf-one").map((target) => target.id), [null]);
  assert.equal(validationIssues(spec).length, 0);
});
