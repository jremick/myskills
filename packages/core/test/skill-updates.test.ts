import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemanticVersions,
  evaluateSkillUpdate,
  isPrereleaseVersion,
  parseSemanticVersion,
  parseSkillReleaseMetadata,
  type SkillReleaseUpdateCandidate,
} from "../src/index.js";

test("semantic version parsing and precedence follow SemVer 2", () => {
  assert.equal(parseSemanticVersion("1.0.0-01"), null);
  assert.equal(parseSemanticVersion("01.0.0"), null);
  assert.equal(isPrereleaseVersion("1.0.0-rc.1"), true);
  assert.equal(compareSemanticVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  const ordered = [
    "1.0.0",
    "1.0.0-rc.1",
    "1.0.0-beta.11",
    "1.0.0-beta.2",
    "1.0.0-beta",
    "1.0.0-alpha.beta",
    "1.0.0-alpha.1",
    "1.0.0-alpha",
  ].sort(compareSemanticVersions);
  assert.deepEqual(ordered, [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ]);
});

test("update evaluation selects the newest compatible approved release and includes skipped notes", () => {
  const evaluation = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex", artifactSha256: digest("1.0.0") },
    releases: [release("1.0.0"), release("1.1.0"), release("1.2.0")],
    client: { myskillsVersion: "1.2.0", adapterContractVersion: 1 },
  });
  assert.equal(evaluation.status, "update-available");
  assert.equal(evaluation.candidate?.version, "1.2.0");
  assert.deepEqual(evaluation.includedReleases.map((item) => item.version), ["1.1.0", "1.2.0"]);
});

test("release metadata parsing applies safe defaults and rejects malformed compatibility", () => {
  assert.deepEqual(parseSkillReleaseMetadata(undefined), {
    releaseNotes: "",
    changeKind: "maintenance",
    requiresUserAction: false,
    compatibility: {},
  });
  assert.deepEqual(parseSkillReleaseMetadata({
    releaseNotes: "Requires a new environment variable.\n",
    changeKind: "breaking",
    requiresUserAction: true,
    compatibility: {
      minimumMyskillsVersion: "1.2.0",
      minimumAdapterContractVersion: 2,
      minimumSourceVersion: "1.0.0",
    },
  }), {
    releaseNotes: "Requires a new environment variable.\n",
    changeKind: "breaking",
    requiresUserAction: true,
    compatibility: {
      minimumMyskillsVersion: "1.2.0",
      minimumAdapterContractVersion: 2,
      minimumSourceVersion: "1.0.0",
    },
  });
  assert.throws(
    () => parseSkillReleaseMetadata({ compatibility: { minimumMyskillsVersion: "latest" } }),
    /valid semantic version/,
  );
  assert.throws(
    () => parseSkillReleaseMetadata({ releaseNotes: "bad\u0000notes" }),
    /control characters/,
  );
});

test("update evaluation fails closed for prerelease and compatibility requirements", () => {
  const evaluation = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [
      release("1.1.0", { minimumMyskillsVersion: "2.0.0" }),
      release("1.2.0", { minimumAdapterContractVersion: 2 }),
      release("1.3.0-beta.1"),
    ],
    client: { myskillsVersion: "1.5.0", adapterContractVersion: 1 },
  });
  assert.equal(evaluation.status, "no-compatible-release");
  assert.deepEqual(evaluation.blockers, [
    "minimum-adapter-contract-version",
    "minimum-myskills-version",
    "prerelease-not-selected",
  ]);
});

test("update evaluation reports pins, drift, and installed-newer state", () => {
  const pinned = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [release("1.0.0"), release("1.1.0")],
    policy: { pinnedVersion: "1.0.0" },
  });
  assert.equal(pinned.status, "pinned");
  assert.equal(pinned.candidate?.version, "1.1.0");

  const drifted = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex", artifactSha256: digest("different") },
    releases: [release("1.0.0"), release("1.1.0")],
  });
  assert.equal(drifted.status, "drifted");

  const newer = evaluateSkillUpdate({
    installed: { version: "2.0.0", platform: "codex" },
    releases: [release("1.0.0"), release("1.1.0")],
  });
  assert.equal(newer.status, "installed-newer");
});

function release(
  version: string,
  compatibility: SkillReleaseUpdateCandidate["compatibility"] = {},
): SkillReleaseUpdateCandidate {
  return {
    version,
    lifecycleStatus: "approved",
    publishedAt: "2026-09-02T00:00:00.000Z",
    platforms: [{ name: "codex", installTarget: "codex-skill", status: "supported" }],
    artifact: { sha256: digest(version), byteSize: 100, contentType: "application/json" },
    releaseNotes: `Changes in ${version}`,
    changeKind: "feature",
    requiresUserAction: false,
    compatibility,
  };
}

function digest(value: string): string {
  return value.padEnd(64, "0").slice(0, 64);
}
