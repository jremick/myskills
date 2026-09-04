import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maximumResponseBytes = 16 * 1024 * 1024;
export const feedbackReason = "Explain the expected input and remove the unused dependency hook example.";

/** Validate the destination before fixture creation. No network or writes. */
export function acceptanceConfiguration(env = process.env) {
  const apiUrl = checkedUrl(env.MYSKILLS_ACCEPTANCE_API_URL
    ?? `${required(env, "MYSKILLS_E2E_BASE_URL")}/api`);
  const environment = env.MYSKILLS_ACCEPTANCE_ENVIRONMENT ?? "local";
  if (!["local", "staging"].includes(environment)) throw new Error("Acceptance fixture writes require local or staging mode.");
  if (environment === "local" && !isLoopback(apiUrl.hostname)) throw new Error("Local acceptance requires a loopback API.");
  if (environment === "staging" && !env.MYSKILLS_ACCEPTANCE_INSTANCE_ID) {
    throw new Error("Staging acceptance requires the independently verified MYSKILLS_ACCEPTANCE_INSTANCE_ID.");
  }
  return {
    apiUrl: apiUrl.href.replace(/\/$/, ""),
    environment,
    expectedInstanceId: env.MYSKILLS_ACCEPTANCE_INSTANCE_ID,
    cliPath: resolve(env.MYSKILLS_ACCEPTANCE_CLI_PATH ?? join(root, "apps/cli/dist/index.js")),
  };
}

/** The callbacks keep browser assertions in Playwright while CLI/API work shares one fixture. */
export async function runOperationalAcceptance({ env = process.env, callbacks = {}, onCheck = () => {} } = {}) {
  const config = acceptanceConfiguration(env);
  await access(config.cliPath);
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const slug = `acceptance-${suffix}`;
  const workspace = await mkdtemp(join(tmpdir(), "myskills-acceptance-"));
  const checks = [];
  const artifacts = [];
  const secrets = [];
  const sessions = [];
  const executionTokens = [];
  const enrolledTargets = [];
  let actors;
  let report;
  let failure;
  let failedTokenRevocations = 0;
  const check = (name, detail = {}) => {
    const result = { name, passed: true, ...detail };
    checks.push(result);
    onCheck(result);
  };
  const api = async (path, { token, method = "GET", body, status = 200, raw = false } = {}) => {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => { throw new Error(`Acceptance API ${method} request could not complete.`); });
    if (response.status !== status) {
      await response.body?.cancel();
      throw new Error(`Acceptance API ${method} ${path.split("?")[0]} returned ${response.status}; expected ${status}.`);
    }
    const text = await boundedResponse(response);
    if (raw) return { text, headers: response.headers };
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw new Error("Acceptance API returned malformed JSON."); }
  };
  const cli = async (args, actor, { expectFailure = false, json = false } = {}) => {
    const result = await capturedProcess(process.execPath, [config.cliPath, ...args, "--api-url", config.apiUrl, ...(json ? ["--json"] : [])], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        MYSKILLS_TOKEN: actor?.token ?? "",
        MYSKILLS_TOKEN_STORE: "file",
        MYSKILLS_TOKEN_FILE: join(workspace, "unused-tokens.json"),
      },
    });
    if (expectFailure) {
      if (result.code === 0) throw new Error(`CLI ${args[0]} unexpectedly succeeded.`);
      return null;
    }
    if (result.code !== 0) throw new Error(`CLI ${args[0]} failed with exit code ${result.code}.`);
    if (!json || !result.stdout.trim()) return result.stdout.trim();
    try { return JSON.parse(result.stdout); } catch { throw new Error(`CLI ${args[0]} returned malformed JSON.`); }
  };

  try {
    const capabilities = await api("/v1/capabilities");
    if (config.expectedInstanceId && capabilities.instanceId !== config.expectedInstanceId) {
      throw new Error("Acceptance API instance identity does not match the verified destination.");
    }
    const ready = await api("/ready");
    if (!ready.ok || ready.checks?.artifactStorage !== "ready") throw new Error("Acceptance requires ready object storage.");
    check("destination.identity-and-readiness", { version: capabilities.version, ...(capabilities.instanceId ? { instanceId: capabilities.instanceId } : {}) });

    actors = await loadActors();
    if (new Set(Object.values(actors).map((actor) => actor.user.id)).size !== 3) throw new Error("Author, reviewer, and consumer must be different users.");
    if (!actors.author.user.roles.includes("author") || !actors.reviewer.user.roles.includes("maintainer")
      || actors.consumer.user.roles.some((role) => ["owner", "admin", "maintainer", "author"].includes(role))) {
      throw new Error("Acceptance requires a separate author, maintainer, and unprivileged consumer.");
    }
    if (!actors.reviewer.user.mfaVerified) throw new Error("Maintainer acceptance session must be MFA verified.");
    check("actors.distinct-author-maintainer-consumer");

    const first = await submit("0.1.0", true);
    await api(`/v1/review/submissions/${first.id}/actions`, {
      token: actors.author.token, method: "POST", body: { action: "request-changes", reason: feedbackReason }, status: 403,
    });
    await api(`/v1/review/submissions/${first.id}/actions`, {
      token: actors.reviewer.token, method: "POST", body: { action: "request-changes", reason: feedbackReason },
    });
    const detail = await api(`/v1/submissions/${first.id}`, { token: actors.author.token });
    if (detail.submission.changeRequestReason !== feedbackReason
      || !detail.submission.scanRuns.some((run) => run.findings.some((finding) => finding.category === "install-hook"))) {
      throw new Error("Author feedback did not include the exact change request and scan finding.");
    }
    await api(`/v1/submissions/${first.id}`, { token: actors.consumer.token, status: 404 });
    check("author.feedback-and-private-scan-evidence");
    await callbacks.afterFeedback?.({ slug, submission: first, actor: actors.author, reason: feedbackReason });

    await cli(["submit", "--path", first.directory], actors.author, { expectFailure: true });
    await api("/v1/submissions", { token: actors.author.token, method: "POST", status: 409, body: {
      manifest: JSON.parse(first.files["skill.json"]),
      files: Object.entries(first.files).map(([path, content]) => ({ path, content })),
    } });
    check("intake.existing-version-cannot-be-overwritten");
    const corrected = await submit("0.1.1", false);
    const initialArtifact = await publish(corrected);
    await callbacks.afterPublish?.({ slug, version: corrected.version, actor: actors.consumer, artifact: initialArtifact });

    await cli(["releases", "unpublish", `${slug}@0.1.1`, "--reason", "Operational acceptance historical release check"], actors.reviewer);
    await api(`/v1/skills/${slug}/releases/0.1.1/bundle?platform=codex`, { token: actors.consumer.token, status: 404 });
    const hiddenInventory = await api(`/v1/manage/skills?q=${encodeURIComponent(slug)}`, { token: actors.reviewer.token });
    const history = await api(`/v1/skills/${slug}/releases`, { token: actors.reviewer.token });
    if (!hiddenInventory.skills.some((skill) => skill.slug === slug)
      || !history.releases.some((release) => release.version === "0.1.1" && release.lifecycleStatus === "unpublished")) {
      throw new Error("Maintainer inventory lost an unpublished release.");
    }
    await callbacks.afterUnpublish?.({ slug, version: "0.1.1", actor: actors.reviewer });
    await cli(["releases", "restore", `${slug}@0.1.1`, "--reason", "Operational acceptance restore"], actors.reviewer);
    await cli(["skills", "archive", slug, "--reason", "Operational acceptance archived inventory check"], actors.reviewer);
    await api(`/v1/skills/${slug}`, { token: actors.consumer.token, status: 404 });
    const archivedInventory = await api(`/v1/manage/skills?q=${encodeURIComponent(slug)}`, { token: actors.reviewer.token });
    if (!archivedInventory.skills.some((skill) => skill.slug === slug && skill.lifecycleStatus === "archived")) {
      throw new Error("Maintainer inventory lost an archived skill.");
    }
    await callbacks.afterArchive?.({ slug, actor: actors.reviewer });
    await cli(["skills", "restore", slug, "--reason", "Operational acceptance restore"], actors.reviewer);
    const restoredBundle = await api(`/v1/skills/${slug}/releases/0.1.1/bundle?platform=codex`, { token: actors.consumer.token, raw: true });
    if (digest(restoredBundle.text) !== initialArtifact.sha256) throw new Error("Lifecycle restoration changed immutable artifact bytes.");
    check("lifecycle.unpublished-and-archived-resources-remain-manageable");

    const search = await api(`/v1/skills?q=${encodeURIComponent(slug)}`, { token: actors.consumer.token });
    if (!search.skills.some((skill) => skill.slug === slug)) throw new Error("Published skill was absent from consumer discovery.");
    await cli(["search", slug], actors.consumer);
    const installRoot = join(workspace, "consumer-skills");
    await cli(["install", slug, "--version", "0.1.1", "--platform", "codex", "--dir", installRoot], actors.consumer);
    await assertInstalled(installRoot, "0.1.1", initialArtifact);
    check("consumer.built-cli-install-and-exact-files", { artifactSha256: initialArtifact.sha256 });

    const intermediate = await submit("0.1.2", false, "breaking");
    const intermediateArtifact = await publish(intermediate);
    const next = await submit("0.2.0", false, "fix");
    const nextArtifact = await publish(next);
    await verifyCodexWorkspace(initialArtifact, intermediateArtifact, nextArtifact);
    await cli(["update", slug, "--dry-run", "--dir", installRoot], actors.consumer);
    await assertInstalled(installRoot, "0.1.1", initialArtifact);
    await cli(["update", slug, "--dir", installRoot], actors.consumer);
    await assertInstalled(installRoot, "0.2.0", nextArtifact);
    check("consumer.update-dry-run-and-verified-promotion", { artifactSha256: nextArtifact.sha256 });
    await cli(["rollback", slug, "--dir", installRoot], actors.consumer);
    await assertInstalled(installRoot, "0.1.1", initialArtifact);
    check("consumer.rollback-restores-verified-original-files");

    await callbacks.beforeRevocation?.({ slug, version: "0.2.0", actor: actors.consumer, actors, cli, api, workspace });
    for (const version of ["0.1.1", "0.1.2", "0.2.0"]) {
      await cli(["releases", "revoke", `${slug}@${version}`, "--reason", "Operational acceptance revocation check"], actors.reviewer);
      await api(`/v1/skills/${slug}/releases/${version}`, { token: actors.consumer.token, status: 404 });
      await api(`/v1/skills/${slug}/releases/${version}/bundle?platform=codex`, { token: actors.consumer.token, status: 404 });
    }
    const revokedSearch = await api(`/v1/skills?q=${encodeURIComponent(slug)}`, { token: actors.consumer.token });
    if (revokedSearch.skills.some((skill) => skill.slug === slug)) throw new Error("Revoked releases remain discoverable by the consumer.");
    const deniedRoot = join(workspace, "denied-install");
    await cli(["install", slug, "--version", "0.2.0", "--platform", "codex", "--dir", deniedRoot], actors.consumer, { expectFailure: true });
    await assertMissing(join(deniedRoot, slug));
    await assertInstalled(installRoot, "0.1.1", initialArtifact);
    check("revocation.denies-discovery-delivery-and-new-install");
    await callbacks.afterRevocation?.({ slug, actor: actors.consumer });
    report = { schemaVersion: 1, passed: true, environment: config.environment, slug, checks, artifacts, runtimeRecognition: "not-tested" };
  } catch (error) {
    let message = error instanceof Error ? error.message : "Operational acceptance failed.";
    for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
    // A raw cause can retain actor credentials or captured HTTP bodies.
    failure = new Error(message);
  } finally {
    // These resources were created by this run and cannot be left authorized after a failed assertion.
    for (const targetId of enrolledTargets) await api(`/v1/architecture-targets/${targetId}`, { token: actors.reviewer.token, method: "DELETE" }).catch(() => {});
    for (const tokenId of executionTokens) await api(`/v1/auth/api-tokens/${tokenId}`, { token: actors.reviewer.token, method: "DELETE" }).catch(() => { failedTokenRevocations += 1; });
    // Revoke only sessions created by this run. Existing supplied credentials belong to the operator.
    for (const token of sessions) await api("/v1/auth/logout", { token, method: "POST", status: 204 }).catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
  if (failedTokenRevocations) throw new Error(`${failure?.message ?? "Acceptance cleanup failed."} A temporary executor token could not be revoked; it expires within fifteen minutes.`);
  if (failure) throw failure;
  return report;

  async function verifyCodexWorkspace(initialArtifact, intermediateArtifact, nextArtifact) {
    const { createFlatArchitecture } = await import("@myskills-app/core");
    const actor = actors.reviewer;
    const codexWorkspace = join(workspace, "codex-project");
    await mkdir(codexWorkspace, { mode: 0o700 });
    const installRoot = join(codexWorkspace, ".agents", "skills");
    const { architecture } = await api("/v1/architectures", { token: actor.token, method: "POST", status: 201, body: {
      name: `Acceptance ${suffix}`, description: "Disposable Codex workspace acceptance fixture.", patternId: "flat",
    } });
    const profileId = "acceptance-profile";
    const environmentId = "acceptance-workspace";
    const spec = createFlatArchitecture({
      id: architecture.id, name: architecture.name,
      profile: { id: profileId, subject: { type: "user", id: actor.user.id } },
      environment: { id: environmentId, kind: "personal" },
      skills: [{ id: slug, slug, version: initialArtifact.version, digest: initialArtifact.sha256, packageVisibility: "public" }],
    });
    await api(`/v1/architectures/${architecture.id}/revisions`, { token: actor.token, method: "POST", status: 201, body: {
      expectedCurrentRevisionId: null, message: "Operational acceptance fixture", spec,
    } });
    const enrolled = await cli(["codex", "enroll", "--workspace", codexWorkspace, "--architecture-id", architecture.id,
      "--environment-id", environmentId, "--profile-id", profileId, "--name", `Acceptance ${suffix}`], actor, { json: true });
    if (!enrolled.enrolled || !enrolled.targetId || enrolled.adapter?.contractVersion !== 2 || enrolled.runtimeRecognized !== false) {
      throw new Error("Codex workspace enrollment did not produce the supported v2 target.");
    }
    const targetId = enrolled.targetId;
    enrolledTargets.push(targetId);
    await api(`/v1/architecture-targets/${targetId}`, { token: actors.consumer.token, status: 404 });
    await cli(["install", slug, "--version", initialArtifact.version, "--workspace", codexWorkspace], actor);
    await assertInstalled(installRoot, initialArtifact.version, initialArtifact);
    await assertObservation(initialArtifact);
    check("codex.enrolled-standard-frontmatter-and-authoritative-observation", { targetId, artifactSha256: initialArtifact.sha256 });
    await callbacks.afterWorkspaceInstall?.({ workspace: codexWorkspace, slug, version: initialArtifact.version, targetId, actor });

    const { token } = await api("/v1/auth/api-tokens", { token: actor.token, method: "POST", status: 201, body: {
      name: `Acceptance ${suffix}`, scopes: ["targets:execute", "skills:read"], expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    } });
    if (!token.id || !token.token) throw new Error("Executor token creation did not produce the expected scoped token.");
    secrets.push(token.token);
    executionTokens.push(token.id);
    const executor = { token: token.token };
    const companionArgs = ["companion", "run-once", "--workspace", codexWorkspace, "--holder", `acceptance-${suffix}`];

    await verifyUpgradePolicy();

    // Deliberately modify only this isolated fixture to prove that local drift is not overwritten.
    const readmePath = join(installRoot, slug, "README.md");
    const originalReadme = await readFile(readmePath, "utf8");
    const driftedReadme = `${originalReadme}\nLocal acceptance edit that must survive refusal.\n`;
    const driftOperation = await schedule("update", nextArtifact.version, "local-drift");
    await writeFile(readmePath, driftedReadme);
    await cli(companionArgs, executor, { expectFailure: true });
    const failed = await api(`/v1/target-operations/${driftOperation.id}`, { token: actor.token });
    if (failed.operation.state !== "failed" || failed.operation.result?.status !== "failed"
      || await readFile(readmePath, "utf8") !== driftedReadme
      || JSON.parse(await readFile(join(installRoot, slug, "skill.json"), "utf8")).version !== initialArtifact.version) {
      throw new Error("Companion did not retain the installed package and report refusal of local drift.");
    }
    await writeFile(readmePath, originalReadme);
    await assertInstalled(installRoot, initialArtifact.version, initialArtifact);
    check("codex.failed-operation-preserves-local-edits-and-installed-version");

    const update = await schedule("update", nextArtifact.version, "update");
    await cli(companionArgs, executor);
    await assertReceipt(update.id, nextArtifact);
    const replay = await schedule("update", nextArtifact.version, "update", 200);
    if (replay.id !== update.id || replay.state !== "succeeded") throw new Error("Completed operation replay created a new operation or lost its receipt.");
    await assertObservation(nextArtifact);
    check("codex.companion-update-exact-receipt-and-idempotent-replay", { artifactSha256: nextArtifact.sha256 });

    const rollback = await schedule("rollback", initialArtifact.version, "rollback");
    await cli(companionArgs, executor);
    await assertReceipt(rollback.id, initialArtifact);
    await assertObservation(initialArtifact);
    check("codex.companion-rollback-restores-verified-original-files");

    await schedule("update", nextArtifact.version, "revoked-target");
    await api(`/v1/architecture-targets/${targetId}`, { token: actor.token, method: "DELETE" });
    enrolledTargets.splice(enrolledTargets.indexOf(targetId), 1);
    await cli(companionArgs, executor, { expectFailure: true });
    await assertInstalled(installRoot, initialArtifact.version, initialArtifact);
    check("codex.revoked-target-cannot-execute-queued-operation");
    await api(`/v1/auth/api-tokens/${token.id}`, { token: actor.token, method: "DELETE" });
    executionTokens.splice(executionTokens.indexOf(token.id), 1);

    async function verifyUpgradePolicy() {
      const initial = await api(`/v1/architecture-targets/${targetId}/updates`, { token: actor.token });
      const originalPolicy = initial.policy?.policy;
      const initialEvaluation = initial.items.find((item) => item.slug === slug)?.evaluation;
      if (!originalPolicy || initial.policy.source !== "default" || originalPolicy.pins[slug]
        || initialEvaluation?.status !== "update-available" || initialEvaluation.candidate?.version !== nextArtifact.version) {
        throw new Error("The isolated target did not begin with an unpinned default upgrade policy.");
      }
      let policyRevision = initial.policy.revision?.revisionNumber ?? 0;
      const crossedOperation = await schedule("update", nextArtifact.version, "before-policy-restriction");
      await savePolicy({ ...originalPolicy, allowedChangeKinds: ["fix"] });
      const blocked = (await api(`/v1/architecture-targets/${targetId}/updates`, { token: actor.token }))
        .items.find((item) => item.slug === slug)?.evaluation;
      if (blocked?.status !== "no-compatible-release" || blocked.candidate
        || !blocked.blockers.includes("change-kind-not-allowed") || blocked.includedReleases.length !== 2
        || [intermediateArtifact, nextArtifact].some((artifact, index) => {
          const release = blocked.includedReleases[index];
          return release.version !== artifact.version || release.changeKind !== artifact.changeKind || release.releaseNotes !== artifact.releaseNotes;
        })) {
        throw new Error("Fix-only policy did not retain and block the complete crossed release range.");
      }
      const denied = await api(`/v1/architecture-targets/${targetId}/operations`, { token: actor.token, method: "POST", status: 409, body: {
        action: "update", slug, version: nextArtifact.version, platform: "codex", idempotencyKey: `${suffix}-policy-denied`,
      } });
      if (denied.error?.code !== "TARGET_OPERATION_POLICY_CHANGE_KIND_BLOCKED") throw new Error("An update crossing a breaking release was not rejected for the expected policy reason.");
      const { claim } = await api("/v1/target-operations/claim", { token: executor.token, method: "POST", body: {
        targetId, targetGeneration: enrolled.generation, holderId: `acceptance-${suffix}`,
      } });
      const { operations } = await api(`/v1/architecture-targets/${targetId}/operations`, { token: actor.token });
      if (claim !== null || operations.length !== 1 || operations[0].id !== crossedOperation.id || operations[0].state !== "queued") {
        throw new Error("The new policy did not prevent a previously queued update from being claimed without creating another operation.");
      }
      await cancel(crossedOperation.id);
      await assertInstalled(installRoot, initialArtifact.version, initialArtifact);
      check("codex.policy-blocks-crossed-breaking-release-at-preview-schedule-and-claim", {
        installedVersion: initialArtifact.version, crossedVersions: blocked.includedReleases.map((release) => release.version),
      });
      await callbacks.afterPolicyBlocked?.({ slug, actor, targetName: `Acceptance ${suffix}`, releases: [intermediateArtifact, nextArtifact] });

      await savePolicy({ ...originalPolicy, pins: { [slug]: intermediateArtifact.version } });
      const pinned = (await api(`/v1/architecture-targets/${targetId}/updates`, { token: actor.token }))
        .items.find((item) => item.slug === slug)?.evaluation;
      if (pinned?.status !== "update-available" || pinned.candidate?.version !== intermediateArtifact.version
        || pinned.candidate.artifact.sha256 !== intermediateArtifact.sha256
        || pinned.includedReleases.length !== 1 || pinned.includedReleases[0].version !== intermediateArtifact.version) {
        throw new Error("An exact newer pin selected the wrong version or included a release beyond the pin.");
      }
      const pinnedOperation = await schedule("update", intermediateArtifact.version, "exact-newer-pin");
      if (pinnedOperation.state !== "queued" || pinnedOperation.fromVersion !== initialArtifact.version
        || pinnedOperation.toVersion !== intermediateArtifact.version || pinnedOperation.artifact.sha256 !== intermediateArtifact.sha256) {
        throw new Error("The pinned operation plan did not bind the exact requested version and artifact.");
      }
      await cancel(pinnedOperation.id);
      await assertInstalled(installRoot, initialArtifact.version, initialArtifact);
      check("codex.exact-newer-pin-selects-and-queues-requested-artifact", { pinnedVersion: intermediateArtifact.version, newerVersion: nextArtifact.version });

      await savePolicy(originalPolicy);
      const restored = await api(`/v1/architecture-targets/${targetId}/updates`, { token: actor.token });
      const restoredEvaluation = restored.items.find((item) => item.slug === slug)?.evaluation;
      if (restored.policy.policy.mode !== originalPolicy.mode || restored.policy.policy.includePrerelease !== originalPolicy.includePrerelease
        || restored.policy.policy.pins[slug] || restored.policy.policy.allowedChangeKinds.length !== originalPolicy.allowedChangeKinds.length
        || originalPolicy.allowedChangeKinds.some((kind) => !restored.policy.policy.allowedChangeKinds.includes(kind))
        || restoredEvaluation?.status !== "update-available" || restoredEvaluation.candidate?.version !== nextArtifact.version) {
        throw new Error("The original upgrade policy values were not restored before normal companion execution.");
      }
      check("codex.original-policy-values-restored-before-update-and-rollback");

      async function savePolicy(policy) {
        const { revision } = await api(`/v1/architecture-targets/${targetId}/update-policy`, { token: actor.token, method: "PUT", status: 201, body: {
          expectedRevisionNumber: policyRevision, policy, reason: "Isolated operational acceptance policy check",
        } });
        if (revision?.revisionNumber !== policyRevision + 1) throw new Error("The acceptance upgrade policy revision was not persisted.");
        policyRevision = revision.revisionNumber;
      }
      async function cancel(operationId) {
        await api(`/v1/target-operations/${operationId}/cancel`, { token: actor.token, method: "POST" });
        const { operation } = await api(`/v1/target-operations/${operationId}`, { token: actor.token });
        if (operation.state !== "cancelled") throw new Error("The policy acceptance operation was not cancelled before execution resumed.");
      }
    }

    async function schedule(action, version, key, status = 202) {
      return (await api(`/v1/architecture-targets/${targetId}/operations`, { token: actor.token, method: "POST", status, body: {
        action, slug, version, platform: "codex", idempotencyKey: `${suffix}-${key}`,
      } })).operation;
    }
    async function assertReceipt(operationId, artifact) {
      const { operation } = await api(`/v1/target-operations/${operationId}`, { token: actor.token });
      if (operation.state !== "succeeded" || operation.result?.status !== "succeeded"
        || operation.result.installedVersion !== artifact.version || operation.result.artifactSha256 !== artifact.sha256
        || !/^[a-f0-9]{64}$/.test(operation.result.contentDigest ?? "")) {
        throw new Error("Companion receipt does not verify the planned installed version and artifact.");
      }
      await assertInstalled(installRoot, artifact.version, artifact);
    }
    async function assertObservation(artifact) {
      const observed = await cli(["codex", "observe", "--workspace", codexWorkspace, "--upload"], actor, { json: true });
      const { observations } = await api(`/v1/architecture-targets/${targetId}/observations?limit=1`, { token: actor.token });
      const skill = observations[0]?.skills?.find((item) => item.slug === slug);
      if (!observed.uploaded || observed.runtimeRecognized !== false || skill?.version !== artifact.version || skill.digest !== artifact.sha256
        || observations[0].metadata?.runtimeRecognized !== false) {
        throw new Error("Persisted Codex observation does not match verified workspace files.");
      }
    }
  }

  async function loadActors() {
    const supplied = ["AUTHOR", "REVIEWER", "CONSUMER"].map((role) => env[`MYSKILLS_ACCEPTANCE_${role}_TOKEN`]);
    if (supplied.some(Boolean)) {
      if (!supplied.every(Boolean)) throw new Error("Supply all three acceptance actor session tokens together.");
      const result = {};
      for (const [index, role] of ["author", "reviewer", "consumer"].entries()) {
        secrets.push(supplied[index]);
        const { user } = await api("/v1/me", { token: supplied[index] });
        result[role] = { token: supplied[index], user, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() };
      }
      return result;
    }
    // Fixture onboarding only uses a private capture mailbox explicitly configured by the runner.
    const mailpit = checkedUrl(required(env, "MYSKILLS_E2E_MAILPIT_URL"));
    if (config.environment === "local" && !isLoopback(mailpit.hostname)) throw new Error("Local capture mailbox must use loopback.");
    let ownerToken = env.MYSKILLS_ACCEPTANCE_OWNER_TOKEN;
    if (!ownerToken) {
      const codes = JSON.parse(required(env, "MYSKILLS_E2E_OWNER_RECOVERY_CODES"));
      if (!Array.isArray(codes) || typeof codes[6] !== "string") throw new Error("Owner recovery code index 6 is required for acceptance provisioning.");
      ownerToken = (await login(required(env, "MYSKILLS_E2E_OWNER_EMAIL"), required(env, "MYSKILLS_E2E_OWNER_PASSWORD"), codes[6])).token;
    }
    secrets.push(ownerToken);
    const result = {};
    for (const [role, assignedRole] of [["author", "author"], ["reviewer", "maintainer"], ["consumer", "user"]]) {
      const email = `${slug}-${role}@example.test`;
      const password = randomBytes(24).toString("base64url");
      secrets.push(password);
      await api("/v1/admin/registration/invitations", { token: ownerToken, method: "POST", status: 201, body: { email, name: `Acceptance ${role}` } });
      const inviteToken = await invitationToken(mailpit, email);
      secrets.push(inviteToken);
      await api("/v1/auth/register", { method: "POST", status: 202, body: { email, password, name: `Acceptance ${role}`, inviteToken } });
      const { users } = await api("/v1/admin/users", { token: ownerToken });
      const user = users.find((candidate) => candidate.email === email);
      if (!user) throw new Error("Acceptance invitee was not created.");
      if (assignedRole !== "user") await api(`/v1/admin/users/${user.id}/roles`, { token: ownerToken, method: "PUT", body: { roles: [assignedRole], reason: "Isolated operational acceptance fixture" } });
      let session = await login(email, password);
      if (role === "reviewer") {
        const { enrollment } = await api("/v1/auth/mfa/totp/enroll", { token: session.token, method: "POST", status: 201, body: { password, label: "Operational acceptance" } });
        secrets.push(enrollment.secret);
        const { mfa } = await api("/v1/auth/mfa/totp/confirm", { token: session.token, method: "POST", body: { factorId: enrollment.factorId, code: totp(enrollment.secret) } });
        secrets.push(...mfa.recoveryCodes);
        session = await login(email, password, mfa.recoveryCodes[0]);
      }
      result[role] = session;
    }
    return result;
  }

  async function login(email, password, recoveryCode) {
    const response = await api("/v1/auth/login", { method: "POST", body: { email, password } });
    const session = response.mfaRequired
      ? await api("/v1/auth/mfa/verify", { method: "POST", body: { challengeToken: response.challengeToken, recoveryCode } })
      : response;
    if (!session.token || !session.user) throw new Error("Acceptance login did not produce a session.");
    secrets.push(session.token);
    sessions.push(session.token);
    return session;
  }

  async function submit(version, warning, changeKind = "feature") {
    const directory = join(workspace, `package-${version}`);
    await mkdir(directory);
    const files = {
      "skill.json": JSON.stringify({ name: slug, title: `Acceptance ${suffix}`, summary: "Produces a deterministic acceptance summary from supplied input.", version, license: "Apache-2.0", visibility: "public", platforms: [{ name: "codex", install_target: "codex-skill" }], tags: ["acceptance"] }, null, 2),
      "README.md": `# Operational acceptance\n\nVersion ${version}. Input: a short list of changes. Output: a concise summary.\n`,
      "SKILL.md": `---\nname: ${slug}\ndescription: Summarize the supplied changes for the operational acceptance check.\n---\n\nRead the supplied changes and produce a concise summary. Version ${version}.\n`,
      ...(warning ? { "review-example.json": JSON.stringify({ postinstall: "echo unused-example" }) } : {}),
    };
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content, { mode: 0o600 });
    const releaseNotes = `Operational acceptance ${version}: ${changeKind} release.`;
    const releaseNotesFile = join(workspace, `release-notes-${version}.md`);
    await writeFile(releaseNotesFile, releaseNotes, { mode: 0o600 });
    const result = await cli(["submit", "--path", directory, "--change-kind", changeKind, "--release-notes-file", releaseNotesFile], actors.author, { json: true });
    if (!result.submission?.id || result.submission.securityStatus === "blocked") throw new Error("Acceptance submission did not pass intake.");
    return { id: result.submission.id, version, directory, files, changeKind, releaseNotes };
  }

  async function publish(submission) {
    const preview = await api(`/v1/review/submissions/${submission.id}/bundle?platform=codex`, { token: actors.reviewer.token, raw: true });
    const sha256 = digest(preview.text);
    if (preview.headers.get("x-myskills-artifact-sha256") !== sha256) throw new Error("Review digest differs from actual package bytes.");
    await api(`/v1/review/submissions/${submission.id}/actions`, { token: actors.reviewer.token, method: "POST", status: 409, body: { action: "approve", artifactSha256: "0".repeat(64) } });
    await cli(["review", "action", submission.id, "--action", "approve", "--artifact-sha256", sha256, "--reason", "Reviewed exact operational fixture bytes"], actors.reviewer);
    await cli(["review", "action", submission.id, "--action", "publish"], actors.reviewer);
    const { release } = await api(`/v1/skills/${slug}/releases/${submission.version}`, { token: actors.consumer.token });
    const delivered = await api(`/v1/skills/${slug}/releases/${submission.version}/bundle?platform=codex`, { token: actors.consumer.token, raw: true });
    if (digest(delivered.text) !== sha256 || release.artifact.sha256 !== sha256 || release.artifact.byteSize !== Buffer.byteLength(delivered.text)
      || release.changeKind !== submission.changeKind || release.releaseNotes !== submission.releaseNotes) {
      throw new Error("Published metadata and delivered bytes differ from the reviewed artifact.");
    }
    const files = JSON.parse(delivered.text).files;
    if (files.length !== Object.keys(submission.files).length || files.some((file) => submission.files[file.path] !== file.content)) throw new Error("Delivered package files differ from the author's package.");
    const artifact = { version: submission.version, sha256, byteSize: Buffer.byteLength(delivered.text), files,
      changeKind: release.changeKind, releaseNotes: release.releaseNotes };
    artifacts.push({ version: artifact.version, sha256, byteSize: artifact.byteSize });
    check("publication.reviewed-and-delivered-artifact-match", { version: submission.version, sha256 });
    return artifact;
  }

  async function assertInstalled(directory, version, artifact) {
    for (const file of artifact.files) if (await readFile(join(directory, slug, file.path), "utf8") !== file.content) throw new Error("Installed files differ from verified package bytes.");
    const installed = JSON.parse(await readFile(join(directory, slug, "skill.json"), "utf8"));
    if (installed.version !== version) throw new Error("Installed version differs from the expected release.");
  }
}

async function invitationToken(base, email) {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; attempt < 12 && Date.now() < deadline; attempt++) {
    const url = new URL("/view/latest.txt", base);
    url.searchParams.set("query", `to:${email}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))), redirect: "error" }).catch(() => null);
    if (response?.ok) {
      const text = await boundedResponse(response);
      const token = text.match(/\/auth\/register#token=([^\s<>]+)/)?.[1];
      if (token) return decodeURIComponent(token);
    } else await response?.body?.cancel();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("Captured acceptance invitation was not delivered within the bounded one-minute polling window.");
}

export async function capturedProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let bytes = 0;
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill("SIGKILL"); }, 60_000);
    const collect = (chunk, keep) => {
      bytes += chunk.length;
      if (bytes > maximumResponseBytes) { exceeded = true; child.kill("SIGKILL"); }
      else if (keep) stdout += chunk;
    };
    child.stdout.on("data", (chunk) => collect(chunk, true));
    child.stderr.on("data", (chunk) => collect(chunk, false));
    child.once("error", () => { clearTimeout(timer); reject(new Error("Acceptance subprocess could not start.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) reject(new Error("Acceptance subprocess exceeded its time or output limit."));
      else resolvePromise({ code, stdout });
    });
  });
}

async function boundedResponse(response) {
  if (!response.body) return "";
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximumResponseBytes) throw new Error("Acceptance response exceeded its size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertMissing(path) {
  try { await access(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Denied installation wrote a skill directory.");
}

function checkedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Acceptance endpoint URL is invalid."); }
  if (url.username || url.password || url.search || url.hash || (!isLoopback(url.hostname) && url.protocol !== "https:") || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Acceptance endpoints must use HTTPS outside loopback and cannot contain credentials, query, or fragment.");
  }
  return url;
}

function isLoopback(host) { return ["localhost", "127.0.0.1", "[::1]"].includes(host); }
function required(env, key) { const value = env[key]?.trim(); if (!value) throw new Error(`${key} is required.`); return value; }
function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret.toUpperCase().replace(/[=\s]/g, "")) {
    const next = alphabet.indexOf(character);
    if (next < 0) throw new Error("Enrollment returned an invalid TOTP secret.");
    value = (value << 5) | next;
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
