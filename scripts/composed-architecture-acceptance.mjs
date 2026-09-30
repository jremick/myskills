import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMultiLevelRouterArchitecture, artifactGeneratedName } from "@myskills-app/core";

// Invoked only by the existing explicit disposable operational fixture. Its API
// already requires ready object storage. No provider execution or default root.
export async function runComposedArchitectureAcceptance({ api, cli, actor, workspace, slug, releases, onEnrolled, check }) {
  const call = (path, body, status = body === undefined ? 200 : 201) => api(path, { token: actor.token, ...(body === undefined ? {} : { method: "POST", body }), status });
  const { architecture } = await call("/v1/architectures", { name: "Disposable composed acceptance", description: "Canonical object-backed exact-byte fixture.", patternId: "multi-level-router" });
  const spec = createMultiLevelRouterArchitecture({ id: architecture.id, name: architecture.name,
    profile: { id: "composed-one", subject: { type: "user", id: actor.user.id } }, environment: { id: "workspace-one", kind: "personal" },
    skills: releases.map((release, index) => ({ id: `exact-${index}`, slug, version: release.version, digest: release.sha256, packageVisibility: "public", domainId: "review" })) });
  spec.profiles.push({ ...structuredClone(spec.profiles[0]), id: "composed-two", bindings: spec.profiles[0].bindings.map(binding => binding.nodeId === "leaf-exact-1" ? { ...binding, enabled: false, runtimeExposure: "disabled" } : { ...binding }) });
  spec.environments.push({ id: "workspace-two", name: "Second explicit fixture", kind: "personal", profileId: "composed-two" });
  let { revision } = await call(`/v1/architectures/${architecture.id}/revisions`, { expectedCurrentRevisionId: null, message: "Mixed exact object-backed pins", spec });
  const enrolled = [];
  for (const index of [0, 1]) {
    const root = join(workspace, `composed-workspace-${index}`); await mkdir(root, { mode: 0o700 });
    const profileId = index ? "composed-two" : "composed-one", environmentId = index ? "workspace-two" : "workspace-one";
    const target = await cli(["codex", "enroll", "--workspace", root, "--architecture-id", architecture.id, "--profile-id", profileId, "--environment-id", environmentId], actor, { json: true });
    onEnrolled(target.targetId); await cli(["codex", "observe", "--workspace", root, "--upload"], actor, { json: true });
    const intent = await prepare(target.targetId, revision.id, null); await execute(root, intent);
    enrolled.push({ root, targetId: target.targetId, intent });
  }
  if (enrolled[0].intent.intent.treeDigest === enrolled[1].intent.intent.treeDigest || enrolled[0].targetId === enrolled[1].targetId) throw new Error("Composed fixture target/profile isolation failed.");
  spec.nodes.find(node => node.kind === "router").label = "Updated ordered routing guidance";
  ({ revision } = await call(`/v1/architectures/${architecture.id}/revisions`, { expectedCurrentRevisionId: revision.id, message: "Router update", spec }));
  for (const fixture of enrolled) {
    const next = await prepare(fixture.targetId, revision.id, fixture.intent.run.identity.runId); await execute(fixture.root, next);
    const rolled = await cli(["architecture-artifacts", "rollback", next.run.identity.runId, "--workspace", fixture.root], actor, { json: true });
    if (rolled.run.state !== "rolled_back") throw new Error("Composed explicit rollback receipt is absent.");
    await exactBytes(fixture.root, fixture.intent.intent);
  }
  check("composed.object-backed-two-workspaces-exact-trees-update-rollback", { targetCount: 2, mixedVersions: releases.map(release => release.version), runtimeRecognized: false });

  async function prepare(targetId, revisionId, baselineRunId) {
    const { target } = await call(`/v1/architecture-targets/${targetId}`);
    const { observations } = await call(`/v1/architecture-targets/${targetId}/observations`);
    const observation = observations[0];
    const { run } = await call(`/v1/architecture-targets/${targetId}/plans`, { revisionId, expectedTargetGeneration: target.generation, expectedObservationId: observation.id, expectedObservationDigest: observation.observedDigest, idempotencyKey: crypto.randomUUID() });
    await call(`/v1/architecture-plans/${run.identity.runId}/approve`, { expectedReviewDigest: run.metadata.reviewDigest }, 200);
    return call(`/v1/architecture-targets/${targetId}/artifacts`, { reviewRunId: run.identity.runId, baselineRunId, idempotencyKey: crypto.randomUUID() });
  }
  async function execute(root, candidate) {
    const runId = candidate.run.identity.runId;
    for (const action of ["prepare", "apply", "verify"]) await cli(["architecture-artifacts", action, runId, "--workspace", root], actor, { json: true });
    const { run } = await call(`/v1/architecture-artifacts/${runId}`);
    if (run.state !== "succeeded" || !run.receipts.some(receipt => receipt.code === "artifact.aggregate.verified")) throw new Error("Composed aggregate receipt is absent.");
    await exactBytes(root, candidate.intent);
  }
}
async function exactBytes(root, intent) {
  for (const file of intent.files) {
    const bytes = await readFile(join(root, file.path));
    if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("Composed exact filesystem bytes differ.");
  }
  for (const nodeId of intent.projection.disabledNodeIds) {
    try { await readFile(join(root, ".agents/skills", artifactGeneratedName(intent.projection.architectureId, nodeId), "SKILL.md")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error("Disabled composed node has active discovery bytes.");
  }
}
