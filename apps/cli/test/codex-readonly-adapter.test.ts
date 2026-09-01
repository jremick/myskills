import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertValidArchitectureTargetObservation,
  validateReadOnlyArchitectureTargetAdapter,
  type ArchitectureTargetAdapterContext,
} from "@myskills-app/core";
import {
  CodexReadOnlyArchitectureTargetAdapter,
  codexAdapterCapabilitiesDigest,
  codexAdapterDigest,
} from "../src/codex-readonly-adapter.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/codex-target", import.meta.url));
const fixedClock = () => new Date("2026-08-30T00:00:00.000Z");

function context(profile: "personal" | "work" | "shared", targetId = `target-${profile}`): ArchitectureTargetAdapterContext {
  return {
    targetId,
    targetGeneration: 1,
    architectureId: "architecture-1",
    environmentId: `${profile}-local`,
    profileId: profile,
    adapterDigest: codexAdapterDigest,
    capabilitiesDigest: codexAdapterCapabilitiesDigest,
  };
}

function adapter(root: string, profile: "personal" | "work" | "shared") {
  return new CodexReadOnlyArchitectureTargetAdapter({ root, profile, clock: fixedClock });
}

async function temporaryCopy(source: string, t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const destination = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-target-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await cp(source, destination, { recursive: true });
  return destination;
}

test("reads personal and work inventories independently with explicit router classification", async () => {
  const personal = await adapter(path.join(fixtureRoot, "personal"), "personal");
  const work = await adapter(path.join(fixtureRoot, "work"), "work");
  const personalObservation = await personal.observe(context("personal"));
  const workObservation = await work.observe(context("work"));

  assert.deepEqual(personalObservation.skills.map((skill) => skill.slug), ["personal-only", "personal-router", "shared-tool"]);
  assert.deepEqual(workObservation.skills.map((skill) => skill.slug), ["work-only", "work-router"]);
  assert.equal(personalObservation.skills.find((skill) => skill.slug === "personal-router")?.kind, "router");
  assert.equal(workObservation.skills.find((skill) => skill.slug === "work-router")?.kind, "router");
  assert.equal(personalObservation.skills.find((skill) => skill.slug === "shared-tool")?.enabled, false);
  assert.equal(personalObservation.metadata?.architectureId, "architecture-1");
  assert.equal(personalObservation.metadata?.profile, "personal");

  const serialized = JSON.stringify({ personalObservation, workObservation });
  for (const forbidden of [
    path.join(fixtureRoot, "personal"),
    path.join(fixtureRoot, "work"),
    "THIS_BODY_MUST_NOT_BE_READ_OR_EMITTED",
    "THIS_WORK_BODY_MUST_NOT_BE_READ_OR_EMITTED",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `projection leaked ${forbidden}`);
  }
});

test("honors router-policy managed state when profile metadata omits it", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  const profilePath = path.join(root, "profile.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
    skills: Array<Record<string, unknown>>;
  };
  const router = profile.skills.find((skill) => skill.slug === "personal-router");
  assert.ok(router);
  delete router.managed;
  await writeFile(profilePath, JSON.stringify(profile));

  const observation = await adapter(root, "personal").observe(context("personal", "target-router-policy-managed"));
  assert.equal(observation.skills.find((skill) => skill.slug === "personal-router")?.managed, true);
});

test("does not follow or recover outside the explicit root when optional metadata is missing", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  await rm(path.join(root, "profile.json"));
  await rm(path.join(root, "router-policy.json"));

  const target = adapter(root, "personal");
  const observation = await target.observe(context("personal", "target-missing-metadata"));
  const health = await target.health(context("personal", "target-missing-metadata"));
  const codes = observation.configFindings.map((finding) => finding.code);

  assert.equal(codes.includes("profile-metadata-missing"), true);
  assert.equal(codes.includes("router-policy-missing"), true);
  assert.equal(health.status, "degraded");
  assert.equal(health.metadata?.findingCount, 2);
  assert.equal(JSON.stringify({ observation, health }).includes(root), false);
});

test("rejects symlinked metadata and skill frontmatter without following them", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-target-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideProfile = path.join(outside, "profile.json");
  const outsideSkill = path.join(outside, "SKILL.md");
  const marker = "SYMLINKED_CONTENT_MUST_NOT_BE_READ_OR_EMITTED";
  await writeFile(outsideProfile, JSON.stringify({
    schemaVersion: 1,
    profile: "personal",
    skills: [{ slug: "outside-skill", enabled: true }],
    marker,
  }));
  await writeFile(outsideSkill, [
    "---",
    "slug: outside-skill",
    "version: 1.0.0",
    `digest: ${"a".repeat(64)}`,
    "kind: leaf",
    "---",
    marker,
    "",
  ].join("\n"));
  await rm(path.join(root, "profile.json"));
  await symlink(outsideProfile, path.join(root, "profile.json"));
  const skillPath = path.join(root, "skills", "personal-only", "SKILL.md");
  await rm(skillPath);
  await symlink(outsideSkill, skillPath);

  const observation = await adapter(root, "personal").observe(context("personal", "target-symlinked-files"));
  const codes = observation.configFindings.map((finding) => finding.code);

  assert.equal(codes.includes("profile-metadata-invalid"), true);
  assert.equal(codes.includes("skill-frontmatter-invalid"), true);
  assert.equal(JSON.stringify(observation).includes(marker), false);
});

test("rejects oversized metadata after a bounded descriptor read", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  const marker = "OVERSIZED_METADATA_MUST_NOT_BE_EMITTED";
  await writeFile(path.join(root, "profile.json"), JSON.stringify({
    schemaVersion: 1,
    profile: "personal",
    skills: [],
    padding: marker.repeat(2_000),
  }));

  const observation = await adapter(root, "personal").observe(context("personal", "target-oversized-metadata"));

  assert.deepEqual(observation.configFindings.find((finding) => finding.code === "profile-metadata-invalid"), {
    code: "profile-metadata-invalid",
    severity: "warning",
    count: 1,
  });
  assert.equal(JSON.stringify(observation).includes(marker), false);
});

test("keeps the observed digest stable across directory order and file timestamps", async (t) => {
  const source = path.join(fixtureRoot, "personal");
  const firstRoot = await temporaryCopy(source, t);
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-codex-target-reordered-"));
  t.after(() => rm(secondRoot, { recursive: true, force: true }));
  const second = path.join(secondRoot, "personal");
  await mkdir(path.join(second, "skills"), { recursive: true });
  for (const metadataFile of ["profile.json", "router-policy.json"]) {
    await writeFile(path.join(second, metadataFile), await readFile(path.join(source, metadataFile)));
  }
  for (const slug of ["shared-tool", "personal-router", "personal-only"]) {
    await mkdir(path.join(second, "skills", slug), { recursive: true });
    await writeFile(
      path.join(second, "skills", slug, "SKILL.md"),
      await readFile(path.join(source, "skills", slug, "SKILL.md")),
    );
  }
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  const newTime = new Date("2030-01-01T00:00:00.000Z");
  await utimes(path.join(firstRoot, "skills", "personal-only", "SKILL.md"), oldTime, oldTime);
  await utimes(path.join(second, "skills", "personal-only", "SKILL.md"), newTime, newTime);

  const firstObservation = await adapter(firstRoot, "personal").observe(context("personal", "target-stable"));
  const secondObservation = await adapter(second, "personal").observe(context("personal", "target-stable"));

  assert.equal(firstObservation.observedDigest, secondObservation.observedDigest);
  assert.deepEqual(firstObservation.skills, secondObservation.skills);
});

test("surfaces duplicate slug digest conflicts without selecting a winner", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  for (const [directory, digest] of [["duplicate-a", "1"], ["duplicate-b", "2"]] as const) {
    await mkdir(path.join(root, "skills", directory), { recursive: true });
    await writeFile(path.join(root, "skills", directory, "SKILL.md"), [
      "---",
      "slug: duplicate-skill",
      "version: 1.0.0",
      `digest: ${digest.repeat(64)}`,
      "kind: leaf",
      "---",
      "DUPLICATE_BODY_MUST_NOT_BE_EMITTED",
      "",
    ].join("\n"));
  }

  const observation = await adapter(root, "personal").observe(context("personal", "target-duplicate"));
  const conflict = observation.configFindings.find((finding) => finding.code === "duplicate-slug-digest-conflict");

  assert.deepEqual(observation.skills.filter((skill) => skill.slug === "duplicate-skill").map((skill) => skill.digest), [
    "1".repeat(64),
    "2".repeat(64),
  ]);
  assert.deepEqual(conflict, { code: "duplicate-slug-digest-conflict", severity: "error", count: 1 });
  assert.equal(JSON.stringify(observation).includes("DUPLICATE_BODY_MUST_NOT_BE_EMITTED"), false);
});

test("enforces the bounded 500-skill inventory cap deterministically", async (t) => {
  const root = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  await rm(path.join(root, "skills"), { recursive: true, force: true });
  await mkdir(path.join(root, "skills"), { recursive: true });
  for (let index = 0; index < 505; index += 1) {
    const slug = `cap-${String(index).padStart(3, "0")}`;
    const directory = path.join(root, "skills", slug);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), [
      "---",
      `slug: ${slug}`,
      "version: 1.0.0",
      `digest: ${String(index % 10).repeat(64)}`,
      "kind: leaf",
      "---",
      "CAP_BODY_MUST_NOT_BE_EMITTED",
      "",
    ].join("\n"));
  }

  const observation = await adapter(root, "personal").observe(context("personal", "target-cap"));
  const capFinding = observation.configFindings.find((finding) => finding.code === "skill-cap-exceeded");

  assert.equal(observation.skills.length, 500);
  assert.equal(observation.skills[0]?.slug, "cap-000");
  assert.equal(observation.skills.at(-1)?.slug, "cap-499");
  assert.deepEqual(capFinding, { code: "skill-cap-exceeded", severity: "warning", count: 5 });
  assert.equal(JSON.stringify(observation).includes("CAP_BODY_MUST_NOT_BE_EMITTED"), false);
});

test("excludes sensitive frontmatter and marks unresolved skills unmanaged", async (t) => {
  const sensitiveTarget = adapter(path.join(fixtureRoot, "sensitive"), "personal");
  const sensitiveObservation = await sensitiveTarget.observe(context("personal", "target-sensitive"));
  const sensitiveSkill = sensitiveObservation.skills.find((skill) => skill.slug === "safe-skill");
  const sensitiveSerialized = JSON.stringify(sensitiveObservation);
  assert.equal(sensitiveSkill?.slug, "safe-skill");
  assert.equal(sensitiveSkill?.managed, true);
  assert.equal(sensitiveObservation.configFindings.find((finding) => finding.code === "skill-frontmatter-sensitive-field")?.count, 2);
  for (const forbidden of ["apiToken", "do-not-emit", "path", "never-emit-this-field", "THIS_SENSITIVE_BODY_MUST_NOT_BE_READ_OR_EMITTED"]) {
    assert.equal(sensitiveSerialized.includes(forbidden), false, `sensitive frontmatter leaked ${forbidden}`);
  }

  const unresolvedRoot = await temporaryCopy(path.join(fixtureRoot, "personal"), t);
  const unresolvedDirectory = path.join(unresolvedRoot, "skills", "unresolved");
  await mkdir(unresolvedDirectory, { recursive: true });
  await writeFile(path.join(unresolvedDirectory, "SKILL.md"), "UNRESOLVED_BODY_MUST_NOT_BE_EMITTED\n");
  const unresolvedObservation = await adapter(unresolvedRoot, "personal").observe(context("personal", "target-unresolved"));
  const unresolved = unresolvedObservation.skills.find((skill) => skill.slug === "unresolved");
  assert.equal(unresolved?.managed, false);
  assert.equal(unresolved?.supported, false);
  assert.equal(unresolved?.version, undefined);
  assert.equal(unresolved?.digest, undefined);
  assert.equal(JSON.stringify(unresolvedObservation).includes("UNRESOLVED_BODY_MUST_NOT_BE_EMITTED"), false);
});

test("returns a core-valid observation and exposes no mutation method", async () => {
  const target = adapter(path.join(fixtureRoot, "personal"), "personal");
  const conformance = validateReadOnlyArchitectureTargetAdapter(target);
  assert.equal(conformance.valid, true);
  const observation = await target.observe(context("personal", "target-conformance"));
  assert.deepEqual(assertValidArchitectureTargetObservation(observation), observation);
  assert.equal("apply" in target, false);
  assert.equal("rollback" in target, false);

  const mutable = Object.assign(target, { apply: async () => undefined });
  const rejected = validateReadOnlyArchitectureTargetAdapter(mutable);
  assert.equal(rejected.valid, false);
  if (!rejected.valid) assert.equal(rejected.errors.some((error) => error.code === "ARCHITECTURE_TARGET_ADAPTER_MUTATION_METHOD"), true);
});
