import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEX_BOOTSTRAP_CONTRACT_VERSIONS,
  CodexBootstrapError,
  CODEX_BOOTSTRAP_REPORT_SCHEMA,
  calculateCodexBootstrapReportChecksum,
  createCodexBootstrapDryRun,
  readCodexBootstrapContextFile,
  type CodexBootstrapPaths,
} from "../src/codex-bootstrap.js";
import { SKILL_PACKAGE_MANIFEST_CONTRACT_ID, SKILL_PACKAGE_SCANNER_CONTRACT_ID } from "@myskills-app/skill-package";
import { runCli, type FetchLike } from "../src/cli.js";

test("work canary is explicitly selected, privately reported, and never mutates source or target", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const beforeSource = await fileTree(fixture.paths.workSourceRoot);
  const beforeLive = await fileTree(fixture.paths.liveSkillsRoot);

  const result = await createCodexBootstrapDryRun({
    paths: fixture.paths,
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(result.report.status, "ready");
  assert.deepEqual(result.report.candidates.map((candidate) => candidate.slug), ["work-canary"]);
  assert.equal(result.report.candidates[0]?.sourceType, "work");
  assert.equal(result.report.candidates[0]?.ready, true);
  assert.equal(result.report.candidates[0]?.candidateIdentity, result.report.candidates[0]?.contentIdentity);
  assert.match(result.report.candidates[0]?.executionIdentity ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.report.target, {
    profile: "work",
    targetOrigin: "https://team-target.example",
    instanceId: fixture.context.instanceId,
    tenantOrWorkspaceId: fixture.context.workspaceId,
    actorId: fixture.context.actorId,
    sourceTrustCompartment: fixture.context.sourceTrustCompartment,
    targetTrustCompartment: fixture.context.targetTrustCompartment,
    approvedSourceRoots: [...fixture.context.approvedSourceRoots].sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : 0),
    approvedTargetRootIdentityDigest: fixture.context.approvedTargetRootIdentityDigest,
  });
  assert.deepEqual(await fileTree(fixture.paths.workSourceRoot), beforeSource);
  assert.deepEqual(await fileTree(fixture.paths.liveSkillsRoot), beforeLive);
  assert.deepEqual(await readdir(fixture.reportDir), ["canary.json"]);
  const reportHandle = await open(result.reportPath, "r");
  let reportText: string;
  try {
    assert.equal((await reportHandle.stat()).mode & 0o777, 0o600);
    reportText = await reportHandle.readFile("utf8");
  } finally {
    await reportHandle.close();
  }
  const persisted = JSON.parse(reportText) as typeof result.report;
  assert.equal(JSON.stringify(persisted).includes(fixture.root), false);
  assert.equal(calculateCodexBootstrapReportChecksum(persisted), persisted.reportChecksum);
  assert.equal(calculateCodexBootstrapReportChecksum(result.report), result.report.reportChecksum);
  const persistedCandidate = persisted.candidates[0];
  assert.ok(persistedCandidate);
  assert.deepEqual(persistedCandidate.artifact, persistedArtifactIdentity(persistedCandidate.snapshot));
  assert.equal(persistedCandidate.bytesScanned, persistedCandidate.artifact.byteSize);
  assert.equal(result.report.mutations.networkCalls, false);
  assert.equal(result.report.mutations.registryWrites, false);
  assert.equal(result.report.mutations.sourceWrites, false);
  assert.equal(result.report.mutations.liveWrites, false);
  assert.equal(result.report.contracts.current.scanner, SKILL_PACKAGE_SCANNER_CONTRACT_ID);
  assert.equal(result.report.contracts.current.manifest, SKILL_PACKAGE_MANIFEST_CONTRACT_ID);
});

test("a selected source can be planned when its target skill is not yet present", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await rm(path.join(fixture.paths.liveSkillsRoot, "work-canary"), { recursive: true, force: true });

  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "new-target.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });

  assert.equal(report.status, "ready");
  assert.equal(report.candidates[0]?.ready, true);
});

test("target presence is a bound precondition in the plan and execution identity", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  await rm(targetCandidate, { recursive: true, force: true });

  const absent = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "target-absent.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  const absentCandidate = absent.report.candidates[0];
  assert.ok(absentCandidate);
  assert.deepEqual(absentCandidate.targetObservation, { state: "absent", expectedArtifact: null });
  assert.deepEqual(absent.report.selection.results[0]?.targetObservation, absentCandidate.targetObservation);

  await cp(path.join(fixture.paths.workSourceRoot, "work-canary"), targetCandidate, { recursive: true });
  const present = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "target-present.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  const presentCandidate = present.report.candidates[0];
  assert.ok(presentCandidate);
  assert.equal(presentCandidate.targetObservation.state, "present-identical");
  assert.match(presentCandidate.targetObservation.expectedArtifact?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.ok((presentCandidate.targetObservation.expectedArtifact?.byteSize ?? 0) > 0);
  assert.deepEqual(present.report.selection.results[0]?.targetObservation, presentCandidate.targetObservation);
  assert.notEqual(absent.report.planIdentity, present.report.planIdentity);
  assert.notEqual(absentCandidate.executionIdentity, presentCandidate.executionIdentity);
  assert.equal(absentCandidate.contentIdentity, presentCandidate.contentIdentity);
});

test("a target created after an absent-target observation fails closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  await rm(targetCandidate, { recursive: true, force: true });
  let created = false;
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "target-created-after-absence.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (!created && relativePath === "SKILL.md") {
          created = true;
          await cp(sourceCandidate, targetCandidate, { recursive: true });
        }
      },
    },
  });
  assert.equal(created, true);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "TARGET_UNAVAILABLE");
});

test("explicit shared candidate is allowed with a generated team manifest", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "shared.json") },
    context: fixture.context,
    candidateAllowlist: [{ slug: "shared-candidate", sourceType: "shared" }],
  });

  const candidate = report.candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.sourceType, "shared");
  assert.equal(candidate.ownership, "shared");
  assert.equal(candidate.visibility, "team");
  assert.equal(candidate.manifestDecision, "generated-skill-json");
  assert.deepEqual(candidate.snapshot.map((file) => file.path), ["SKILL.md", "skill.json"]);
});

test("a late source file replacement with an outside symlink fails closed", async (t) => {
  const fixture = await makeFixture();
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-bootstrap-outside-"));
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  const sourceFile = path.join(fixture.paths.workSourceRoot, "work-canary", "SKILL.md");
  const displacedFile = path.join(fixture.root, "displaced-SKILL.md");
  const outsideFile = path.join(outsideRoot, "outside.md");
  await writeFile(outsideFile, "outside-only-content\n");
  let swapped = false;
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "late-swap.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (!swapped && relativePath === "SKILL.md") {
          swapped = true;
          await rename(sourceFile, displacedFile);
          await symlink(outsideFile, sourceFile);
        }
      },
    },
  });
  assert.equal(swapped, true);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "SOURCE_UNAVAILABLE");
  assert.equal(JSON.stringify(report).includes("outside-only-content"), false);
});

test("an earlier source file mutation during a later read fails closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  await writeFile(path.join(sourceCandidate, "later.md"), "later\n");
  await writeFile(path.join(targetCandidate, "later.md"), "later\n");
  let laterReads = 0;
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "source-prior-file-changed.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (relativePath === "later.md") {
          laterReads += 1;
          if (laterReads === 1) await writeFile(path.join(sourceCandidate, "SKILL.md"), "mutated source\n");
        }
      },
    },
  });
  assert.equal(laterReads, 1);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "SOURCE_UNAVAILABLE");
  assert.equal(JSON.stringify(report).includes("mutated source"), false);
});

test("an earlier target file mutation during a later read fails closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  await writeFile(path.join(sourceCandidate, "later.md"), "later\n");
  await writeFile(path.join(targetCandidate, "later.md"), "later\n");
  let laterReads = 0;
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "target-prior-file-changed.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (relativePath === "later.md") {
          laterReads += 1;
          if (laterReads === 2) await writeFile(path.join(targetCandidate, "SKILL.md"), "mutated target\n");
        }
      },
    },
  });
  assert.equal(laterReads, 2);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "TARGET_UNAVAILABLE");
  assert.equal(JSON.stringify(report).includes("mutated target"), false);
});

test("a nested directory addition after traversal fails closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const nestedDirectory = path.join(sourceCandidate, "aaa");
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(path.join(nestedDirectory, "first.md"), "first\n");
  await writeFile(path.join(sourceCandidate, "zz-later.md"), "later\n");
  const blockedContent = "DATABASE_URL=postgres://unrecognised-user:unrecognised-password@db.internal/team\n";
  let added = false;
  const reportPath = path.join(fixture.reportDir, "nested-directory-added.json");
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (!added && relativePath === "zz-later.md") {
          added = true;
          await writeFile(path.join(nestedDirectory, ".env"), blockedContent);
        }
      },
    },
  });
  assert.equal(added, true);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "SOURCE_UNAVAILABLE");
  assert.equal(JSON.stringify(report).includes(blockedContent), false);
  assert.equal((await readFile(reportPath, "utf8")).includes(blockedContent), false);
});

test("source and target snapshots reject invalid UTF-8 and NUL bytes", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  const cases = [
    { name: "source-invalid-utf8", file: path.join(sourceCandidate, "payload.bin"), bytes: Buffer.from([0xc3, 0x28]), reason: "SOURCE_UNAVAILABLE" },
    { name: "source-nul", file: path.join(sourceCandidate, "payload.bin"), bytes: Buffer.from("safe\0content", "utf8"), reason: "SOURCE_UNAVAILABLE" },
    { name: "target-invalid-utf8", file: path.join(targetCandidate, "payload.bin"), bytes: Buffer.from([0xc3, 0x28]), reason: "TARGET_UNAVAILABLE" },
    { name: "target-nul", file: path.join(targetCandidate, "payload.bin"), bytes: Buffer.from("safe\0content", "utf8"), reason: "TARGET_UNAVAILABLE" },
  ] as const;
  for (const current of cases) {
    await rm(path.join(sourceCandidate, "payload.bin"), { force: true });
    await rm(path.join(targetCandidate, "payload.bin"), { force: true });
    await writeFile(current.file, current.bytes);
    const { report } = await createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, `${current.name}.json`) },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
    });
    assert.equal(report.status, "blocked");
    assert.equal(report.exclusions[0]?.reason, current.reason);
    assert.equal(JSON.stringify(report).includes("\ufffd"), false);
    assert.equal(JSON.stringify(report).includes("\0"), false);
  }
});

test("sensitive filenames are rejected before secret content enters the report", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceCandidate = path.join(fixture.paths.workSourceRoot, "work-canary");
  const cases = [
    {
      relativePath: ".env",
      content: "DATABASE_URL=postgres://unrecognised-user:unrecognised-password@db.internal/team\n",
    },
    {
      relativePath: ".git-credentials",
      content: "https://unrecognised-user:unrecognised-password@git.example\n",
    },
    {
      relativePath: ".npmrc",
      content: "//registry.example/:_authToken=unrecognised-registry-token\n",
    },
    {
      relativePath: ".docker/config.json",
      content: '{"auths":{"registry.example":{"auth":"unrecognised-docker-auth"}}}\n',
    },
    {
      relativePath: ".kube/config",
      content: "users:\n- name: unrecognised-user\n  user:\n    token: unrecognised-kubernetes-token\n",
    },
    {
      relativePath: ".aws/credentials",
      content: "[default]\naws_access_key_id=UNRECOGNISED_ACCESS_KEY\naws_secret_access_key=unrecognised-secret-key\n",
    },
    {
      relativePath: ".azure/accessTokens.json",
      content: '{"unrecognised-resource":{"accessToken":"unrecognised-azure-token"}}\n',
    },
    {
      relativePath: ".config/gcloud/application_default_credentials.json",
      content: '{"client_id":"unrecognised-client","client_secret":"unrecognised-client-secret"}\n',
    },
    {
      relativePath: ".oci/config",
      content: "[DEFAULT]\nuser=unrecognised-user\nfingerprint=unrecognised-fingerprint\nkey_file=unrecognised-key-file\n",
    },
    {
      relativePath: "application_default_credentials.json",
      content: '{"client_id":"unrecognised-client","client_secret":"unrecognised-client-secret"}\n',
    },
    {
      relativePath: "nested/credentials.json",
      content: '{"username":"unrecognised-user","password":"unrecognised-password"}\n',
    },
    {
      relativePath: ".ssh/authorized_keys",
      content: "ssh-ed25519 AAAAunrecognised-key-material test@example\n",
    },
    {
      relativePath: "keys/deploy.pem",
      content: ["-----BEGIN", "PRIVATE KEY-----\nunrecognised-private-key\n-----END PRIVATE KEY-----\n"].join(" "),
    },
  ];
  for (const [index, current] of cases.entries()) {
    const filePath = path.join(sourceCandidate, current.relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, current.content);
    const reportPath = path.join(fixture.reportDir, `sensitive-${index}.json`);
    const { report } = await createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
    });
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.candidates, []);
    assert.equal(report.exclusions[0]?.reason, "SOURCE_UNAVAILABLE");
    const persisted = await readFile(reportPath, "utf8");
    assert.equal(persisted.includes(current.content), false);
    assert.equal(persisted.includes(current.relativePath), false);
    await rm(filePath, { force: true });
    if (path.dirname(filePath) !== sourceCandidate) await rm(path.dirname(filePath), { recursive: true, force: true });
  }
});

test("a target deletion after a target file read is unavailable, not an absent target", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const targetCandidate = path.join(fixture.paths.liveSkillsRoot, "work-canary");
  const movedTarget = path.join(fixture.root, "moved-target");
  // This file exists only in the target tree so the hook cannot fire during
  // the source snapshot. The hook runs after the secure handle read.
  await writeFile(path.join(targetCandidate, "target-only.md"), "target-only\n");
  let moved = false;
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "target-disappeared.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    testHooks: {
      afterSnapshotFileRead: async (relativePath) => {
        if (!moved && relativePath === "target-only.md") {
          moved = true;
          await rename(targetCandidate, movedTarget);
        }
      },
    },
  });
  assert.equal(moved, true);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.candidates, []);
  assert.equal(report.exclusions[0]?.reason, "TARGET_UNAVAILABLE");
});

test("reserved manifests fail closed and Codex support is required", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceDir = path.join(fixture.paths.workSourceRoot, "work-canary");
  await rm(path.join(fixture.paths.liveSkillsRoot, "work-canary"), { recursive: true, force: true });

  await writeFile(path.join(sourceDir, "skill.json"), "{ malformed\n");
  const invalid = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "invalid-manifest.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  assert.equal(invalid.report.status, "blocked");
  assert.equal(invalid.report.exclusions[0]?.reason, "MANIFEST_INVALID");

  await writeJson(path.join(sourceDir, "skill.json"), validManifest("work-canary"));
  await writeJson(path.join(sourceDir, "skill-manifest.json"), validManifest("work-canary"));
  const multiple = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "multiple-manifest.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  assert.equal(multiple.report.status, "blocked");
  assert.equal(multiple.report.exclusions[0]?.reason, "MANIFEST_INVALID");

  await rm(path.join(sourceDir, "skill-manifest.json"));
  await writeJson(path.join(sourceDir, "skill.json"), validManifest("work-canary", {
    platforms: [{ name: "claude", install_target: "claude-skill", status: "supported" }],
  }));
  const unsupported = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "unsupported-platform.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  assert.equal(unsupported.report.status, "blocked");
  assert.equal(unsupported.report.exclusions[0]?.reason, "MANIFEST_INVALID");
});

test("bounded YAML frontmatter handles block chomping, folding, quotes, and duplicate keys", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sourceFile = path.join(fixture.paths.workSourceRoot, "work-canary", "SKILL.md");
  await rm(path.join(fixture.paths.liveSkillsRoot, "work-canary"), { recursive: true, force: true });
  const cases = [
    [">-", "one two"],
    [">+", "one two\n"],
    ["|-", "one\ntwo"],
    ["|+", "one\ntwo\n"],
  ] as const;
  for (const [header, expectedSummary] of cases) {
    await writeFile(sourceFile, `---\nname: "work-canary" # canonical name\ndescription: ${header} # bounded block\n  one\n  two\n---\n\n# work-canary\n`);
    const { report } = await createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, `${header.slice(0, 1)}${header.slice(1) || "clip"}.json`) },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
    });
    const manifestFile = report.candidates[0]?.snapshot.find((file) => file.path === "skill.json");
    assert.ok(manifestFile);
    assert.equal(JSON.parse(manifestFile.content).summary, expectedSummary);
  }
  await writeFile(sourceFile, "---\nname: work-canary\nname: duplicate\ndescription: duplicate\n---\n\n# work-canary\n");
  const duplicate = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "duplicate-frontmatter.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  assert.equal(duplicate.report.status, "blocked");
  assert.equal(duplicate.report.exclusions[0]?.reason, "MANIFEST_INVALID");
});

test("personal and unclassified sources are rejected before any report write", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    createCodexBootstrapDryRun({ paths: fixture.paths, candidateAllowlist: ["work-canary"] }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_CONTEXT_REQUIRED" && !error.message.includes(fixture.root),
  );

  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: {
        ...fixture.paths,
        sourceRoots: [{ type: "personal", root: fixture.paths.workSourceRoot }] as never,
        reportPath: path.join(fixture.reportDir, "personal.json"),
      },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_SOURCE_ROOT_INVALID" && !error.message.includes(fixture.root),
  );
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: {
        ...fixture.paths,
        sourceRoots: [{ root: fixture.paths.workSourceRoot } as never],
        reportPath: path.join(fixture.reportDir, "unclassified.json"),
      },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_SOURCE_ROOT_INVALID" && !error.message.includes(fixture.root),
  );
  assert.deepEqual(await readdir(fixture.reportDir), []);
});

test("trust compartments are exact canonical work/team types", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  for (const sourceTrustCompartment of ["public", "consumer", "personal", "unclassified", "unknown"]) {
    await assert.rejects(
      createCodexBootstrapDryRun({
        paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, `${sourceTrustCompartment}.json`) },
        context: { ...fixture.context, sourceTrustCompartment },
        candidateAllowlist: ["work-canary"],
      }),
      (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_TRUST_COMPARTMENT_INVALID" && !error.message.includes(sourceTrustCompartment),
    );
  }
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "wrong-target-compartment.json") },
      context: { ...fixture.context, targetTrustCompartment: "team" },
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_TRUST_COMPARTMENT_INVALID" && !error.message.includes("team"),
  );
});

test("empty and implicit-all allowlists are rejected", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  for (const allowlist of [[], ["all"], ["*"]] as string[][]) {
    await assert.rejects(
      createCodexBootstrapDryRun({ paths: fixture.paths, context: fixture.context, candidateAllowlist: allowlist }),
      (error: unknown) => error instanceof CodexBootstrapError && error.code.startsWith("BOOTSTRAP_ALLOWLIST") && !error.message.includes(fixture.root),
    );
  }
});

test("resolved duplicate selectors are rejected and terminal outcomes bind the plan", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "duplicate-selector.json") },
      context: fixture.context,
      candidateAllowlist: ["work-canary", { slug: "work-canary", sourceType: "work" }],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_ALLOWLIST_DUPLICATE",
  );
  const missing = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "missing-selector.json") },
    context: fixture.context,
    candidateAllowlist: [{ slug: "missing-skill", sourceType: "work" }],
  });
  assert.deepEqual(missing.report.selection.results, [{
    selector: { slug: "missing-skill", sourceType: "work" },
    terminal: "excluded",
    reason: "CANDIDATE_NOT_FOUND",
  }]);
  const missingAgain = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "missing-selector-again.json") },
    context: fixture.context,
    candidateAllowlist: [{ slug: "missing-skill", sourceType: "work" }],
  });
  assert.equal(missing.report.planIdentity, missingAgain.report.planIdentity);
  const targetMismatch = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "mismatch-selector.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T04:00:00.000Z",
  });
  await writeFile(path.join(fixture.paths.liveSkillsRoot, "work-canary", "SKILL.md"), "different\n");
  const mismatch = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "mismatch-selector-actual.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T04:00:00.000Z",
  });
  assert.notEqual(targetMismatch.report.planIdentity, mismatch.report.planIdentity);
  assert.equal(mismatch.report.selection.results[0]?.reason, "SOURCE_TARGET_MISMATCH");
});

test("target/context binding changes stable plan identity and personal context is rejected", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "first.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T01:00:00.000Z",
  });
  const changedTarget = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "changed.json") },
    context: { ...fixture.context, targetOrigin: "https://another-target.example/" },
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T01:00:00.000Z",
  });
  assert.notEqual(first.report.planIdentity, changedTarget.report.planIdentity);
  assert.equal(first.report.candidates[0]?.contentIdentity, changedTarget.report.candidates[0]?.contentIdentity);
  assert.notEqual(first.report.candidates[0]?.executionIdentity, changedTarget.report.candidates[0]?.executionIdentity);
  const changedActor = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "changed-actor.json") },
    context: { ...fixture.context, actorId: "actor-work-2" },
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T01:00:00.000Z",
  });
  assert.notEqual(first.report.candidates[0]?.executionIdentity, changedActor.report.candidates[0]?.executionIdentity);
  const changedWorkspace = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "changed-workspace.json") },
    context: { ...fixture.context, workspaceId: "workspace-team-2" },
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T01:00:00.000Z",
  });
  assert.notEqual(first.report.candidates[0]?.executionIdentity, changedWorkspace.report.candidates[0]?.executionIdentity);
  const changedContract = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "changed-contract.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    contractVersions: { scanner: "stale-scanner" },
    now: "2026-09-03T01:00:00.000Z",
  });
  assert.notEqual(first.report.candidates[0]?.executionIdentity, changedContract.report.candidates[0]?.executionIdentity);
  const alternateWorkRoot = path.join(fixture.root, "alternate-work-source");
  await mkdir(alternateWorkRoot, { recursive: true });
  await cp(path.join(fixture.paths.workSourceRoot, "work-canary"), path.join(alternateWorkRoot, "work-canary"), { recursive: true });
  const alternateWorkDigest = rootDigest(await realpath(alternateWorkRoot));
  const changedRoot = await createCodexBootstrapDryRun({
    paths: {
      ...fixture.paths,
      workSourceRoot: alternateWorkRoot,
      sourceRoots: [{ type: "work", root: alternateWorkRoot }, { type: "shared", root: fixture.paths.sharedSourceRoot }],
      reportPath: path.join(fixture.reportDir, "changed-root.json"),
    },
    context: {
      ...fixture.context,
      approvedSourceRoots: [
        { type: "work", identityDigest: alternateWorkDigest },
        fixture.context.approvedSourceRoots[1]!,
      ],
    },
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T01:00:00.000Z",
  });
  assert.notEqual(first.report.candidates[0]?.executionIdentity, changedRoot.report.candidates[0]?.executionIdentity);
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "wrong-root-binding.json") },
      context: {
        ...fixture.context,
        approvedTargetRootIdentityDigest: "0".repeat(64),
      },
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_TARGET_ROOT_BINDING_INVALID",
  );
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "personal-context.json") },
      context: { ...fixture.context, profile: "personal" },
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_WORK_CONTEXT_REQUIRED" && !error.message.includes("personal"),
  );
});

test("timestamp regeneration changes exact report checksum but keeps plan and candidate identity", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "timestamp-a.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T02:00:00.000Z",
  });
  const second = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "timestamp-b.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T02:01:00.000Z",
  });
  assert.equal(first.report.planIdentity, second.report.planIdentity);
  assert.equal(first.report.candidates[0]?.candidateIdentity, second.report.candidates[0]?.candidateIdentity);
  assert.equal(first.report.candidates[0]?.contentIdentity, second.report.candidates[0]?.contentIdentity);
  assert.equal(first.report.candidates[0]?.executionIdentity, second.report.candidates[0]?.executionIdentity);
  assert.notEqual(first.report.reportChecksum, second.report.reportChecksum);
  assert.notEqual(first.report.createdAt, second.report.createdAt);
});

test("expanding the batch preserves the canary identity while changing the plan identity", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const canaryOnly = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "canary-only.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    now: "2026-09-03T03:00:00.000Z",
  });
  const expanded = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "expanded.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary", { slug: "shared-candidate", sourceType: "shared" }],
    now: "2026-09-03T03:00:00.000Z",
  });
  assert.notEqual(canaryOnly.report.planIdentity, expanded.report.planIdentity);
  assert.equal(canaryOnly.report.candidates[0]?.candidateIdentity, expanded.report.candidates.find((candidate) => candidate.slug === "work-canary")?.candidateIdentity);
  assert.equal(canaryOnly.report.candidates[0]?.executionIdentity, expanded.report.candidates.find((candidate) => candidate.slug === "work-canary")?.executionIdentity);
});

test("stale planner, scanner, and manifest contracts are represented and fail closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const current = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "current-contract.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
  });
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "stale.json") },
    context: fixture.context,
    candidateAllowlist: ["work-canary"],
    contractVersions: { planner: "0.0.0", scanner: "0.0.0", manifest: "0.0.0" },
  });
  assert.deepEqual(report.contracts.current, CODEX_BOOTSTRAP_CONTRACT_VERSIONS);
  assert.deepEqual(report.contracts.stale, ["STALE_MANIFEST_CONTRACT", "STALE_PLANNER_CONTRACT", "STALE_SCANNER_CONTRACT"]);
  assert.equal(report.status, "blocked");
  assert.equal(report.candidates[0]?.ready, false);
  assert.ok(report.blockers.includes("STALE_MANIFEST_CONTRACT"));
  assert.ok(report.blockers.includes("STALE_PLANNER_CONTRACT"));
  assert.ok(report.blockers.includes("STALE_SCANNER_CONTRACT"));
  assert.notEqual(current.report.candidates[0]?.executionIdentity, report.candidates[0]?.executionIdentity);
});

test("CLI performs no network call and emits only a redacted stdout DTO", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const contextPath = path.join(fixture.root, "work-context.json");
  await writeJson(contextPath, fixture.context);
  const output = { stdout: [] as string[], stderr: [] as string[] };
  let fetchCalls = 0;
  const code = await runCli([
    "bootstrap", "codex", "--dry-run", "--profile", "work", "--context", contextPath,
    "--work-source-root", fixture.paths.workSourceRoot, "--shared-source-root", fixture.paths.sharedSourceRoot,
    "--live-root", fixture.paths.liveSkillsRoot, "--include-slug", "work-canary",
    "--output", path.join(fixture.reportDir, "cli.json"), "--json",
  ], cliRuntime(output, async () => {
    fetchCalls += 1;
    throw new Error("network must not be called");
  }));

  assert.equal(code, 0);
  assert.equal(fetchCalls, 0);
  const rendered = output.stdout.join("\n");
  assert.equal(rendered.includes(fixture.root), false);
  assert.equal(rendered.includes("work-canary"), false);
  assert.equal(rendered.includes(fixture.context.instanceId), false);
  assert.equal(rendered.includes(fixture.context.workspaceId), false);
  const dto = JSON.parse(output.stdout[0] ?? "{}") as Record<string, unknown>;
  assert.equal(dto.schemaVersion, CODEX_BOOTSTRAP_REPORT_SCHEMA);
  assert.deepEqual(Object.keys(dto).sort(), [
    "blockerCount", "candidateCount", "dryRun", "exclusionCount", "mode", "planIdentity", "readyCandidateCount", "reportChecksum", "reportWritten", "schemaVersion", "status",
  ]);
  assert.equal(dto.reportWritten, true);
});

test("CLI rejects unsupported execution options without writing a report", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const contextPath = path.join(fixture.root, "work-context.json");
  await writeJson(contextPath, fixture.context);
  const output = { stdout: [] as string[], stderr: [] as string[] };
  const unsupportedExecutionOption = `--${"apply"}`;
  const code = await runCli([
    "bootstrap", "codex", "--dry-run", unsupportedExecutionOption, "true", "--profile", "work", "--context", contextPath,
    "--work-source-root", fixture.paths.workSourceRoot, "--live-root", fixture.paths.liveSkillsRoot,
    "--include-slug", "work-canary", "--output", path.join(fixture.reportDir, "unsupported.json"), "--json",
  ], cliRuntime(output, async () => {
    throw new Error("network must not be called");
  }));

  assert.equal(code, 2);
  assert.equal(output.stdout.length, 0);
  assert.equal(output.stderr.join("\n").includes(fixture.root), false);
  assert.deepEqual(await readdir(fixture.reportDir), []);
});

test("report creation is exclusive and fails closed for pre-existing, concurrent, and swapped destinations", async (t) => {
  const fixture = await makeFixture();
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "myskills-bootstrap-report-outside-"));
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  await chmod(fixture.reportDir, 0o755);
  await assert.rejects(
    createCodexBootstrapDryRun({ paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "permissive-parent.json") }, context: fixture.context, candidateAllowlist: ["work-canary"] }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_OUTPUT_UNSAFE",
  );
  await chmod(fixture.reportDir, 0o700);
  const preExisting = path.join(fixture.reportDir, "pre-existing.json");
  await writeFile(preExisting, "keep-me\n");
  await chmod(preExisting, 0o644);
  await assert.rejects(
    createCodexBootstrapDryRun({ paths: { ...fixture.paths, reportPath: preExisting }, context: fixture.context, candidateAllowlist: ["work-canary"] }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_OUTPUT_EXISTS" && !error.message.includes(fixture.root),
  );
  assert.equal(await readFile(preExisting, "utf8"), "keep-me\n");

  const concurrent = path.join(fixture.reportDir, "concurrent.json");
  let created = false;
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: concurrent },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
      testHooks: {
        beforeReportOpen: async () => {
          if (!created) {
            created = true;
            await writeFile(concurrent, "concurrent-writer\n");
          }
        },
      },
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_REPORT_WRITE_FAILED" && !error.message.includes(fixture.root),
  );
  assert.equal(await readFile(concurrent, "utf8"), "concurrent-writer\n");

  const swapped = path.join(fixture.reportDir, "swapped.json");
  const moved = path.join(fixture.reportDir, "swapped-original.json");
  const outside = path.join(outsideRoot, "outside-report.json");
  await writeFile(outside, "outside-report\n");
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: swapped },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
      testHooks: {
        afterReportOpen: async () => {
          await rename(swapped, moved);
          await symlink(outside, swapped);
        },
      },
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_REPORT_WRITE_FAILED" && !error.message.includes(fixture.root),
  );
  assert.equal(await readFile(outside, "utf8"), "outside-report\n");
  assert.equal(await readFile(moved, "utf8"), "");

  const parentSwap = path.join(fixture.reportDir, "parent-swap.json");
  const movedParent = path.join(fixture.root, "reports-moved");
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: parentSwap },
      context: fixture.context,
      candidateAllowlist: ["work-canary"],
      testHooks: {
        beforeReportOpen: async () => {
          await rename(fixture.reportDir, movedParent);
          await symlink(outsideRoot, fixture.reportDir);
        },
      },
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_REPORT_WRITE_FAILED" && !error.message.includes(fixture.root),
  );
  await assert.rejects(readFile(path.join(outsideRoot, "parent-swap.json"), "utf8"), { code: "ENOENT" });
});

test("unsafe HTTP, output containment, and error redaction fail closed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    createCodexBootstrapDryRun({
      paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "http.json") },
      context: { ...fixture.context, targetOrigin: "http://not-loopback.example/" },
      candidateAllowlist: ["work-canary"],
    }),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_TARGET_ORIGIN_UNSAFE" && !error.message.includes("not-loopback"),
  );
  for (const reportPath of [
    path.join(fixture.paths.workSourceRoot, "report.json"),
    path.join(fixture.paths.liveSkillsRoot, "report.json"),
  ]) {
    await assert.rejects(
      createCodexBootstrapDryRun({ paths: { ...fixture.paths, reportPath }, context: fixture.context, candidateAllowlist: ["work-canary"] }),
      (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_OUTPUT_UNSAFE" && !error.message.includes(fixture.root),
    );
  }
});

test("loopback HTTP is accepted only when explicitly enabled", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const { report } = await createCodexBootstrapDryRun({
    paths: { ...fixture.paths, reportPath: path.join(fixture.reportDir, "loopback.json") },
    context: { ...fixture.context, targetOrigin: "http://127.0.0.1:3001/" },
    candidateAllowlist: ["work-canary"],
    allowLoopbackHttp: true,
  });
  assert.equal(report.target.targetOrigin, "http://127.0.0.1:3001");
});

test("context file errors are redacted", async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const contextPath = path.join(fixture.root, "private-context.json");
  await writeFile(contextPath, "not json\n");
  await assert.rejects(
    readCodexBootstrapContextFile(contextPath),
    (error: unknown) => error instanceof CodexBootstrapError && error.code === "BOOTSTRAP_CONTEXT_INVALID" && !error.message.includes(fixture.root),
  );
});

test("CLI argument parse errors are stable and redacted in text and JSON modes", async () => {
  const textOutput = { stdout: [] as string[], stderr: [] as string[] };
  const textCode = await runCli(["bootstrap", "codex", "--dry-run", "--output"], cliRuntime(textOutput, async () => {
    throw new Error("network must not be called");
  }));
  assert.equal(textCode, 2);
  assert.deepEqual(textOutput.stdout, []);
  assert.deepEqual(textOutput.stderr, ["Invalid command options."]);

  const jsonOutput = { stdout: [] as string[], stderr: [] as string[] };
  const jsonCode = await runCli(["bootstrap", "codex", "--dry-run", "--output", "--json", "--json"], cliRuntime(jsonOutput, async () => {
    throw new Error("network must not be called");
  }));
  assert.equal(jsonCode, 2);
  assert.deepEqual(JSON.parse(jsonOutput.stderr[0] ?? "{}"), {
    error: { code: "CLI_ARGUMENTS_INVALID", message: "Invalid command options." },
  });
  assert.equal(jsonOutput.stderr.join("\n").includes("/"), false);
});

interface Fixture {
  root: string;
  reportDir: string;
  context: {
    profile: "work";
    targetOrigin: string;
    instanceId: string;
    workspaceId: string;
    actorId: string;
    sourceTrustCompartment: "work" | "shared" | "work+shared";
    targetTrustCompartment: "work-team";
    approvedSourceRoots: Array<{ type: "work" | "shared"; identityDigest: string }>;
    approvedTargetRootIdentityDigest: string;
  };
  paths: CodexBootstrapPaths & { workSourceRoot: string; sharedSourceRoot: string };
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-work-bootstrap-"));
  const workSourceRoot = path.join(root, "work-source");
  const sharedSourceRoot = path.join(root, "shared-source");
  const liveSkillsRoot = path.join(root, "team-target");
  const reportDir = path.join(root, "reports");
  await Promise.all([mkdir(workSourceRoot, { recursive: true }), mkdir(sharedSourceRoot, { recursive: true }), mkdir(liveSkillsRoot, { recursive: true }), mkdir(reportDir, { recursive: true })]);
  const canary = skillText("work-canary", "A work-owned canary skill.");
  const shared = skillText("shared-candidate", "An explicitly selected shared skill.");
  await writeSkill(workSourceRoot, "work-canary", canary);
  await writeSkill(sharedSourceRoot, "shared-candidate", shared);
  await cp(path.join(workSourceRoot, "work-canary"), path.join(liveSkillsRoot, "work-canary"), { recursive: true });
  await cp(path.join(sharedSourceRoot, "shared-candidate"), path.join(liveSkillsRoot, "shared-candidate"), { recursive: true });
  await chmod(reportDir, 0o700);
  const [workRootReal, sharedRootReal, liveRootReal] = await Promise.all([
    realpath(workSourceRoot),
    realpath(sharedSourceRoot),
    realpath(liveSkillsRoot),
  ]);
  const context = {
    profile: "work" as const,
    targetOrigin: "https://team-target.example/",
    instanceId: "instance-work-1",
    workspaceId: "workspace-team-1",
    actorId: "actor-work-1",
    sourceTrustCompartment: "work+shared",
    targetTrustCompartment: "work-team",
    approvedSourceRoots: [
      { type: "work" as const, identityDigest: rootDigest(workRootReal) },
      { type: "shared" as const, identityDigest: rootDigest(sharedRootReal) },
    ],
    approvedTargetRootIdentityDigest: rootDigest(liveRootReal),
  };
  return {
    root,
    reportDir,
    context,
    paths: {
      workSourceRoot,
      sharedSourceRoot,
      sourceRoots: [{ type: "work", root: workSourceRoot }, { type: "shared", root: sharedSourceRoot }],
      liveSkillsRoot,
      reportPath: path.join(reportDir, "canary.json"),
    },
  };
}

function rootDigest(root: string): string {
  return createHash("sha256").update(JSON.stringify([root]), "utf8").digest("hex");
}

function persistedArtifactIdentity(snapshot: Array<{ path: string; content: string }>): { sha256: string; byteSize: number } {
  const hash = createHash("sha256");
  let byteSize = 0;
  for (const file of [...snapshot].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const pathBytes = Buffer.from(file.path, "utf8");
    const contentBytes = Buffer.from(file.content, "utf8");
    hash.update(Buffer.from(`${pathBytes.byteLength}:`, "ascii"));
    hash.update(pathBytes);
    hash.update(Buffer.from(`${contentBytes.byteLength}:`, "ascii"));
    hash.update(contentBytes);
    byteSize += contentBytes.byteLength;
  }
  return { sha256: hash.digest("hex"), byteSize };
}

function skillText(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse this skill for a bounded work task.\n`;
}

function validManifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    title: name,
    summary: "A valid test skill.",
    version: "1.0.0",
    license: "UNLICENSED",
    visibility: "private",
    platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }],
    tags: [],
    ...overrides,
  };
}

async function writeSkill(root: string, slug: string, content: string): Promise<void> {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileTree(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else files.push(relative);
    }
  }
  await visit(root);
  return files.sort();
}

function cliRuntime(output: { stdout: string[]; stderr: string[] }, fetch: FetchLike) {
  return {
    env: {},
    fetch,
    io: {
      stdout: (line: string) => output.stdout.push(line),
      stderr: (line: string) => output.stderr.push(line),
    },
  };
}
