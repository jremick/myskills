import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemanticVersions,
  evaluateSkillUpdate,
  isPrereleaseVersion,
  parseSemanticVersion,
  parseSkillReleaseMetadata,
  skillReleaseUpdateBlockers,
  skillReleaseUpgradeRange,
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

test("SemVer compares arbitrary-length numeric core and prerelease identifiers exactly", () => {
  const low = "9007199254740992";
  const middle = "9007199254740993";
  const high = "9007199254740994";
  for (const version of [
    (value: string) => `1.0.0-rc.${value}`,
    (value: string) => `${value}.0.0`,
    (value: string) => `1.${value}.0`,
    (value: string) => `1.0.${value}`,
  ]) {
    assert.equal(compareSemanticVersions(version(low), version(middle)), -1);
    assert.equal(compareSemanticVersions(version(middle), version(low)), 1);
    assert.equal(compareSemanticVersions(version(low), version(high)), -1);
    assert.deepEqual([version(high), version(middle), version(low)].sort(compareSemanticVersions), [version(low), version(middle), version(high)]);
    assert.equal(compareSemanticVersions(`${version(middle)}+build.1`, `${version(middle)}+build.2`), 0);
    const hundredsOfDigits = "9".repeat(400);
    assert.equal(compareSemanticVersions(version(hundredsOfDigits), version(`1${"0".repeat(400)}`)), -1);
  }
  assert.equal(parseSemanticVersion(`1.0.0-0${middle}`), null);
  assert.equal(parseSemanticVersion(`0${middle}.0.0`), null);
  assert.equal(compareSemanticVersions(`1.0.0-${middle}`, "1.0.0-alpha"), -1);
});

test("upgrade ranges exclude the installed source and retain sorted full records through the destination", () => {
  const source = { ...release("1.0.0"), privateTestMarker: "source" };
  const first = { ...release("1.1.0"), privateTestMarker: "first" };
  const destination = { ...release("1.2.0"), privateTestMarker: "destination" };
  const releases = [release("2.0.0"), destination, source, release("invalid"), first];
  assert.deepEqual(skillReleaseUpgradeRange(releases, "1.0.0", "1.2.0"), [first, destination]);
  assert.equal(skillReleaseUpgradeRange(releases, "1.0.0", "1.2.0")[0], first);
  assert.deepEqual(skillReleaseUpgradeRange(releases, "1.2.0", "1.0.0"), []);
  assert.deepEqual(skillReleaseUpgradeRange(releases, "1.0.0", "1.0.0"), []);
  assert.equal(releases[0].version, "2.0.0", "range evaluation must not mutate caller order");
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

test("explicit rollback eligibility still checks the destination compatibility", () => {
  const destination = release("1.0.0", { minimumMyskillsVersion: "2.0.0", minimumAdapterContractVersion: 3 });
  assert.deepEqual(skillReleaseUpdateBlockers(destination, {
    installed: { version: "1.1.0", platform: "codex" },
    releases: [destination],
    client: { myskillsVersion: "1.0.0", adapterContractVersion: 2 },
  }).sort(), ["minimum-adapter-contract-version", "minimum-myskills-version"]);
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

test("a newer configured pin selects exactly that release and its complete upgrade notes", () => {
  const evaluation = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [release("2.0.0"), release("1.2.0"), release("1.0.0"), release("1.1.0")],
    policy: { pinnedVersion: "1.2.0" },
  });
  assert.equal(evaluation.status, "update-available");
  assert.equal(evaluation.candidate?.version, "1.2.0");
  assert.deepEqual(evaluation.includedReleases.map((item) => item.releaseNotes), ["Changes in 1.1.0", "Changes in 1.2.0"]);
});

test("an unavailable pin is blocked even when another newer compatible release exists or no newer release exists", () => {
  for (const releases of [
    [release("1.0.0"), release("1.1.0"), release("2.0.0")],
    [release("1.0.0")],
  ]) {
    const evaluation = evaluateSkillUpdate({
      installed: { version: "1.0.0", platform: "codex" }, releases,
      policy: { pinnedVersion: "1.2.0" },
    });
    assert.equal(evaluation.status, "no-compatible-release");
    assert.equal(evaluation.candidate, undefined);
    assert.deepEqual(evaluation.blockers, ["pinned-release-unavailable"]);
    assert.deepEqual(evaluation.includedReleases.map((item) => item.version), releases.length > 1 ? ["1.1.0"] : []);
  }
});

test("an incompatible pin never substitutes an earlier or later compatible candidate", () => {
  const evaluation = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [release("1.0.0"), release("1.1.0"), release("1.2.0", { minimumMyskillsVersion: "2.0.0" }), release("1.3.0")],
    policy: { pinnedVersion: "1.2.0" }, client: { myskillsVersion: "1.0.0" },
  });
  assert.equal(evaluation.status, "no-compatible-release");
  assert.equal(evaluation.candidate, undefined);
  assert.deepEqual(evaluation.blockers, ["minimum-myskills-version"]);
  assert.deepEqual(evaluation.includedReleases.map((item) => item.version), ["1.1.0", "1.2.0"]);
});

test("invalid or older pins fail closed and build metadata does not silently change an exact pin", () => {
  for (const pinnedVersion of ["invalid", "0.9.0", "1.1.0+absent"]) {
    const evaluation = evaluateSkillUpdate({
      installed: { version: "1.0.0", platform: "codex" },
      releases: [release("0.9.0"), release("1.0.0"), release("1.1.0+published"), release("2.0.0")],
      policy: { pinnedVersion },
    });
    assert.equal(evaluation.status, "no-compatible-release");
    assert.equal(evaluation.candidate, undefined);
    assert.deepEqual(evaluation.blockers, ["pinned-release-unavailable"]);
  }
});

test("a fix-only policy cannot skip a breaking release and retains both releases' notes when blocked", () => {
  const breaking = { ...release("1.1.0"), changeKind: "breaking" as const, requiresUserAction: true };
  const fix = { ...release("1.1.1"), changeKind: "fix" as const };
  for (const pinnedVersion of [undefined, "1.1.1"]) {
    const evaluation = evaluateSkillUpdate({
      installed: { version: "1.0.0", platform: "codex" },
      releases: [release("1.0.0"), fix, breaking],
      policy: { allowedChangeKinds: ["fix"], ...(pinnedVersion ? { pinnedVersion } : {}) },
    });
    assert.equal(evaluation.status, "no-compatible-release");
    assert.equal(evaluation.candidate, undefined);
    assert.deepEqual(evaluation.blockers, ["change-kind-not-allowed"]);
    assert.deepEqual(evaluation.includedReleases, [breaking, fix]);
    assert.equal(evaluation.includedReleases[0].requiresUserAction, true);
  }
});

test("range policy permits the newest safe earlier release but never falls back from a blocked pin", () => {
  const releases = [
    { ...release("1.0.0"), changeKind: "breaking" as const },
    { ...release("1.1.0"), changeKind: "fix" as const },
    { ...release("1.2.0"), changeKind: "breaking" as const, lifecycleStatus: "deprecated" as const },
    { ...release("1.3.0"), changeKind: "fix" as const },
  ];
  const input = { installed: { version: "1.0.0", platform: "codex" }, releases };
  const evaluation = evaluateSkillUpdate({ ...input, policy: { allowedChangeKinds: ["fix"] } });
  assert.equal(evaluation.status, "update-available");
  assert.equal(evaluation.candidate?.version, "1.1.0");
  assert.deepEqual(evaluation.includedReleases, [releases[1]]);
  const pinned = evaluateSkillUpdate({ ...input, policy: { allowedChangeKinds: ["fix"], pinnedVersion: "1.3.0" } });
  assert.equal(pinned.status, "no-compatible-release");
  assert.equal(pinned.candidate, undefined);
  assert.deepEqual(pinned.includedReleases, releases.slice(1));
});

test("range policy covers releases with equal SemVer precedence and ignores later releases beyond a pin", () => {
  const installed = { version: "1.0.0", platform: "codex" };
  const fix = { ...release("1.1.0+one"), changeKind: "fix" as const };
  const breaking = { ...release("1.1.0+two"), changeKind: "breaking" as const };
  const blocked = evaluateSkillUpdate({ installed, releases: [fix, breaking], policy: { allowedChangeKinds: ["fix"], pinnedVersion: fix.version } });
  assert.equal(blocked.status, "no-compatible-release");
  assert.deepEqual(blocked.includedReleases, [fix, breaking]);
  const allowed = evaluateSkillUpdate({ installed, releases: [fix, { ...breaking, version: "2.0.0" }], policy: { allowedChangeKinds: ["fix"], pinnedVersion: fix.version } });
  assert.equal(allowed.status, "update-available");
  assert.equal(allowed.candidate?.version, fix.version);
});

test("hidden intermediate change history blocks an upgrade without returning its version or metadata", () => {
  const installed = release("1.0.0");
  const hiddenBreaking = { ...release("1.1.0"), changeKind: "breaking" as const, releaseNotes: "WITHDRAWN_NOTES_MUST_NOT_BE_RETURNED" };
  const visibleFix = { ...release("1.1.1"), changeKind: "fix" as const };
  const evaluation = evaluateSkillUpdate({
    installed: { version: installed.version, platform: "codex" },
    releases: [installed, visibleFix],
    changeHistory: [visibleFix, hiddenBreaking, installed],
    policy: { allowedChangeKinds: ["fix"] },
  });
  assert.equal(evaluation.status, "no-compatible-release");
  assert.equal(evaluation.candidate, undefined);
  assert.deepEqual(evaluation.blockers, ["change-kind-not-allowed"]);
  assert.deepEqual(evaluation.includedReleases, [visibleFix]);
  assert.equal(evaluation.currentRelease, installed);
  assert.equal(JSON.stringify(evaluation).includes(hiddenBreaking.releaseNotes), false);
  assert.equal(JSON.stringify(evaluation).includes('"version":"1.1.0"'), false);
});

test("internal history excludes the source and releases beyond the selected pin", () => {
  const visibleFix = { ...release("1.1.0"), changeKind: "fix" as const };
  const evaluation = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [visibleFix, { ...release("3.0.0"), changeKind: "fix" as const }],
    changeHistory: [
      { version: "1.0.0", changeKind: "breaking" },
      { version: "1.1.0", changeKind: "fix" },
      { version: "2.0.0", changeKind: "breaking" },
    ],
    policy: { allowedChangeKinds: ["fix"], pinnedVersion: "1.1.0" },
  });
  assert.equal(evaluation.status, "update-available");
  assert.equal(evaluation.candidate, visibleFix);
  assert.deepEqual(evaluation.includedReleases, [visibleFix]);
});

test("empty, incomplete, or conflicting internal history cannot erase a visible breaking restriction", () => {
  const breaking = { ...release("1.1.0"), changeKind: "breaking" as const };
  const fix = { ...release("1.1.1"), changeKind: "fix" as const };
  for (const changeHistory of [
    [],
    [{ version: "1.1.1", changeKind: "fix" as const }],
    [{ version: "1.1.0", changeKind: "fix" as const }],
  ]) {
    const evaluation = evaluateSkillUpdate({
      installed: { version: "1.0.0", platform: "codex" },
      releases: [breaking, fix], changeHistory,
      policy: { allowedChangeKinds: ["fix"] },
    });
    assert.equal(evaluation.status, "no-compatible-release");
    assert.equal(evaluation.candidate, undefined);
    assert.deepEqual(evaluation.blockers, ["change-kind-not-allowed"]);
    assert.deepEqual(evaluation.includedReleases, [breaking, fix]);
  }
  const visibleFix = { ...breaking, changeKind: "fix" as const };
  const hiddenRestriction = evaluateSkillUpdate({
    installed: { version: "1.0.0", platform: "codex" },
    releases: [visibleFix, fix],
    changeHistory: [{ version: breaking.version, changeKind: "breaking" }],
    policy: { allowedChangeKinds: ["fix"] },
  });
  assert.equal(hiddenRestriction.status, "no-compatible-release");
  assert.deepEqual(hiddenRestriction.blockers, ["change-kind-not-allowed"]);
  assert.deepEqual(hiddenRestriction.includedReleases, [visibleFix, fix]);
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
