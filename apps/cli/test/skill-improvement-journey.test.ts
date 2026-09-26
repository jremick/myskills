import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { runCli } from "../src/cli.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@myskills-app/core";
import { createImprovementJob, runImprovementJob, exportImprovementCandidate, readImprovementPlan, readImprovementReport } from "../src/skill-improvement.js";

const MODEL = "claude-opus-5-5";

// Written before the runner. The real child-process adapter is exercised using a
// deterministic executable that speaks the Claude Code 2.1.283 stream-json
// protocol and records its argv/environment; no model calls or private data leave
// the test. Failure coverage: consent, tampering, protected files, changed tests,
// symlinks, bounded output/time/calls, regression, no-op, exact evaluated-tree
// export, launch flags, inherited credentials, unsafe init/tool/model events,
// malformed or incomplete streams, process-group kill and legacy Codex plans.
test("local improvement journey preserves source, evaluates a sealed candidate, and exports repeatable evidence", async (t) => {
  const f = await fixture(t);
  const configDir = path.join(f.root, "claude-config");
  // API keys, provider overrides and parent-session variables must never reach
  // the runner; only the configured sign-in location is preserved.
  withEnv(t, { ANTHROPIC_API_KEY: "synthetic-key-must-not-leak", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "parent-session", CLAUDE_CONFIG_DIR: configDir });
  const sourceBefore = await readFile(path.join(f.source, "SKILL.md"), "utf8");
  const job = await createImprovementJob({ ...f.options, goal: f.options.goal + " Treat @../public-canary.txt and public@example.test as data.", suite: suite() });
  assert.match(job.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(job.plan.adapter, "claude-code-text-v1");
  assert.equal(job.plan.runnerVersion, "2.1.283");
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest }), /consent/i);
  const report = await runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest, allowCloud: true });
  assert.equal(report.state, "completed", report.error);
  assert.equal(report.provenance, "local-report");
  assert.equal(report.modelVerification, "observed");
  assert.equal(report.observedModel, MODEL);
  assert.equal(report.evaluation?.outcome, "improved");
  assert.equal(report.evaluation?.baselinePassed, 0);
  assert.equal(report.evaluation?.candidatePassed, 3);
  assert.equal(report.evaluation?.cases.length, 3);
  const calls = await invocations(f.root);
  assert.deepEqual(calls.map((c) => c.stage), ["analyze", ...Array(6).fill("evaluate")], "one fresh process per analysis and per comparison side");
  for (const call of calls) {
    assert.equal(call.violation, "", `launch contract violation: ${call.violation}`);
    assert.equal(call.configDir, configDir);
    for (const name of ["USER", "LOGNAME", "SHELL"]) if (process.env[name]) assert.ok(call.env.includes(name), `${name} is required for existing sign-in`);
  }
  assert.deepEqual(await scratchDirs(f.job), [], "raw runner output and scratch directories are removed");
  assert.equal(await readFile(path.join(f.source, "SKILL.md"), "utf8"), sourceBefore);
  const exportRoot = path.join(f.root, "exported");
  await exportImprovementCandidate({ jobPath: f.job, outputPath: exportRoot });
  assert.equal(JSON.parse(await readFile(path.join(exportRoot, "skill.json"), "utf8")).version, "0.2.0");
  assert.match(await readFile(path.join(exportRoot, "SKILL.md"), "utf8"), /IMPROVED/);
  const saved = await readImprovementReport(f.job);
  assert.equal(saved.candidateDigest, report.candidateDigest);
  assert.ok(report.planDigest);
  const activeSkills = path.join(f.root, ".agents", "skills");
  await mkdir(activeSkills, { recursive: true });
  await assert.rejects(exportImprovementCandidate({ jobPath: f.job, outputPath: path.join(activeSkills, "unreviewed") }), /active|install|draft/i);
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest, allowCloud: true }), /already|completed/i);
  await t.test("edited candidate cannot inherit passing evidence", async () => {
    await writeFile(path.join(f.job, "candidate", "SKILL.md"), "unreviewed edit");
    await assert.rejects(exportImprovementCandidate({ jobPath: f.job, outputPath: path.join(f.root, "tampered-export") }), /digest|changed|match/i);
  });
});

test("plan tampering, source drift, and unsafe destinations block before any provider work", async (t) => {
  const f = await fixture(t);
  const job = await createImprovementJob(f.options);
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: "0".repeat(64), allowCloud: true }), /digest|plan/i);
  await writeFile(path.join(f.source, "SKILL.md"), "changed source");
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest, allowCloud: true }), /source|changed|digest/i);
  await assert.rejects(createImprovementJob({ ...f.options, outputPath: path.join(f.source, "nested-job") }), /source|inside|overlap/i);
  const linked = path.join(f.root, "linked");
  await symlink(f.source, linked);
  await assert.rejects(createImprovementJob({ ...f.options, sourcePath: linked, outputPath: path.join(f.root, "job2") }), /symlink|regular/i);
});

test("a blocked candidate never runs evaluation and a lower score never claims improvement", async (t) => {
  const blocked = await fixture(t, "unsafe");
  const b = await createImprovementJob({ ...blocked.options, suite: suite() });
  const stopped = await runImprovementJob({ jobPath: blocked.job, acceptPlan: b.planDigest, allowCloud: true });
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.calls, 1);
  assert.equal(stopped.evaluation, undefined);
  const regression = await fixture(t, "regression");
  const r = await createImprovementJob({ ...regression.options, suite: suite() });
  const result = await runImprovementJob({ jobPath: regression.job, acceptPlan: r.planDigest, allowCloud: true });
  assert.equal(result.evaluation?.outcome, "regressed");
  const overfit = await fixture(t, "overfit");
  const o = await createImprovementJob({ ...overfit.options, suite: suite() });
  assert.notEqual((await runImprovementJob({ jobPath: overfit.job, acceptPlan: o.planDigest, allowCloud: true })).evaluation?.outcome, "improved");
});

test("no-op, missing suite, and bounded child failures remain honest terminal outcomes", async (t) => {
  const noop = await fixture(t, "noop");
  const n = await createImprovementJob(noop.options);
  const noChange = await runImprovementJob({ jobPath: noop.job, acceptPlan: n.planDigest, allowCloud: true });
  assert.equal(noChange.disposition, "no-change");
  assert.equal(noChange.evaluation, undefined);
  const configuration = await fixture(t, "configuration");
  const configPlan = await createImprovementJob(configuration.options);
  const configReport = await runImprovementJob({ jobPath: configuration.job, acceptPlan: configPlan.planDigest, allowCloud: true });
  assert.equal(configReport.state, "completed");
  assert.equal(configReport.disposition, "configuration-only");
  assert.equal(configReport.candidateDigest, undefined);
  assert.equal(configReport.calls, 1);
  const bad = await fixture(t, "malformed");
  const b = await createImprovementJob(bad.options);
  const failed = await runImprovementJob({ jobPath: bad.job, acceptPlan: b.planDigest, allowCloud: true });
  assert.equal(failed.state, "failed");
  assert.equal(failed.calls, 1);
  const slow = await fixture(t, "timeout");
  const s = await createImprovementJob({ ...slow.options, timeoutSeconds: 1 });
  const timed = await runImprovementJob({ jobPath: slow.job, acceptPlan: s.planDigest, allowCloud: true });
  assert.equal(timed.state, "failed");
  assert.match(timed.error ?? "", /time/i);
  const offline = await fixture(t);
  await assert.rejects(createImprovementJob({ ...offline.options, inference: "on-device" }), /unsupported|on-device/i);
});

test("budgets, protected files, cancellation, output bounds and evaluator separation fail closed", async (t) => {
  const limited = await fixture(t);
  await assert.rejects(createImprovementJob({ ...limited.options, suite: suite(), maxCalls: 6 }), /budget|calls/i);
  const protectedJob = await fixture(t);
  const p = await createImprovementJob({ ...protectedJob.options, protectedFiles: ["SKILL.md"] });
  const blocked = await runImprovementJob({ jobPath: protectedJob.job, acceptPlan: p.planDigest, allowCloud: true });
  assert.equal(blocked.state, "failed");
  assert.match(blocked.error ?? "", /protected/i);
  const cancel = await fixture(t, "timeout");
  const c = await createImprovementJob(cancel.options);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const cancelled = await runImprovementJob({ jobPath: cancel.job, acceptPlan: c.planDigest, allowCloud: true, signal: controller.signal });
  assert.equal(cancelled.state, "cancelled");
  const large = await fixture(t, "oversized");
  const l = await createImprovementJob(large.options);
  assert.equal((await runImprovementJob({ jobPath: large.job, acceptPlan: l.planDigest, allowCloud: true })).state, "failed");
  const separation = await fixture(t, "separation");
  const s = await createImprovementJob({ ...separation.options, suite: suite() });
  assert.equal((await runImprovementJob({ jobPath: separation.job, acceptPlan: s.planDigest, allowCloud: true })).evaluation?.outcome, "improved");
});

test("unsupported runners, model aliases and legacy Codex plans are rejected before any provider work", async (t) => {
  for (const mode of ["old-version", "codex-version"]) {
    const f = await fixture(t, mode);
    await assert.rejects(createImprovementJob(f.options), /Claude Code version/);
    assert.equal(await exists(f.job), false);
  }
  const f = await fixture(t);
  await assert.rejects(createImprovementJob({ ...f.options, executable: path.join(f.root, "missing-claude") }), /Claude Code executable/);
  for (const model of ["opus", "sonnet", "default", "claude-opus-5-5[1m]", "gpt-6-sol"]) {
    await assert.rejects(createImprovementJob({ ...f.options, model }), /model/i, model);
  }
  assert.equal(await exists(f.job), false);
  const plan = await createImprovementJob(f.options);
  const legacy = await legacyPlan(f.job);
  assert.notEqual(legacy, plan.planDigest);
  await assert.rejects(readImprovementPlan(f.job), /codex-text-v1/);
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: legacy, allowCloud: true }), /codex-text-v1/);
  assert.equal(await exists(path.join(f.job, "started")), false, "a legacy plan never consumes its one-shot lock");
  assert.equal(await exists(path.join(f.job, "report.json")), false);
  assert.deepEqual(await invocations(f.root), [], "no fallback runner is invoked");
});

// Each deviation from the verified Claude Code 2.1.283 stream contract stops the
// first call and fails closed without a candidate, observed model or raw output.
test("Claude stream deviations stop the runner and fail closed", async (t) => {
  const outside = /outside the text evaluation contract/;
  const deviations: [string, RegExp][] = [
    ["init-tool", outside], ["init-mcp", outside], ["init-skill", outside], ["init-plugin", outside], ["init-plugin-spoof", outside], ["init-permission", outside],
    ["init-version", outside], ["init-model", /model/i], ["assistant-model", /model/i], ["assistant-model-missing", /model/i], ["usage-model", /model/i],
    ["subagent", outside], ["stray-tool-result", outside], ["permission-denial", outside],
    ["synthetic-error", /failed turn/], ["tool-result-error", /failed turn/], ["error-result", /failed turn/], ["error-subtype", /failed turn/],
    ["no-structured", /structured result/], ["no-result", /completed turn/], ["nonzero-exit", /invocation failed/],
    ["no-init", /invalid event/], ["duplicate-init", /invalid event/], ["duplicate-result", /invalid event/], ["event-after-result", /invalid event/], ["unknown-event", /invalid event/], ["invalid-thinking-progress", /invalid event/], ["malformed", /invalid event/],
    ["oversized-line", /limit/], ["oversized", /limit/],
  ];
  for (const [mode, expected] of deviations) {
    const f = await fixture(t, mode);
    const plan = await createImprovementJob(f.options);
    const report = await runImprovementJob({ jobPath: f.job, acceptPlan: plan.planDigest, allowCloud: true });
    assert.equal(report.state, "failed", mode);
    assert.equal(report.calls, 1, mode);
    assert.match(report.error ?? "", expected, mode);
    assert.equal(report.modelVerification, "unobserved", mode);
    assert.equal(report.observedModel, undefined, mode);
    assert.equal(report.candidateDigest, undefined, mode);
    assert.equal(await exists(path.join(f.job, "candidate")), false, mode);
    assert.deepEqual(await scratchDirs(f.job), [], mode);
    assert.equal((await invocations(f.root))[0]?.violation, "", mode);
  }
});

test("a forbidden tool request stops the whole runner process group immediately", async (t) => {
  const f = await fixture(t, "forbidden-tool");
  const plan = await createImprovementJob(f.options);
  const started = Date.now();
  const report = await runImprovementJob({ jobPath: f.job, acceptPlan: plan.planDigest, allowCloud: true });
  assert.equal(report.state, "failed");
  assert.match(report.error ?? "", /outside the text evaluation contract/);
  assert.ok(Date.now() - started < 5000, "the first unsafe event stops the call well before its time limit");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(await exists(path.join(f.root, "survivor")), false, "descendant processes are killed with the runner");
});

test("an evaluator call that reads back a different model fails without evaluation evidence", async (t) => {
  const f = await fixture(t, "eval-model-drift");
  const plan = await createImprovementJob({ ...f.options, suite: suite() });
  const report = await runImprovementJob({ jobPath: f.job, acceptPlan: plan.planDigest, allowCloud: true });
  assert.equal(report.state, "failed");
  assert.equal(report.calls, 2);
  assert.match(report.error ?? "", /model/i);
  assert.equal(report.evaluation, undefined);
});

test("multi-byte structured output split across stream chunks is preserved exactly", async (t) => {
  const f = await fixture(t, "split-utf8");
  const plan = await createImprovementJob(f.options);
  const report = await runImprovementJob({ jobPath: f.job, acceptPlan: plan.planDigest, allowCloud: true });
  assert.equal(report.state, "completed", report.error);
  assert.match(await readFile(path.join(f.job, "candidate", "SKILL.md"), "utf8"), /Résumé — preserved\./);
});

test("CLI plan, consent, run, report and draft export form one local user journey", async (t) => {
  const f = await fixture(t);
  const out: string[] = []; const err: string[] = [];
  const runtime = { env: {}, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, fetch: async () => { throw new Error("Local commands must not call the registry."); } };
  const exec = async (args: string[]) => { out.length = 0; err.length = 0; return runCli(["improve", ...args, "--json"], runtime); };
  assert.equal(await exec(["plan", "--path", f.source, "--reviewer", f.reviewer, "--output", f.job, "--model", f.options.model, "--goal", f.options.goal, "--target-version", "0.2.0", "--claude-path", f.options.executable]), 0, err.join("\n"));
  const plan = JSON.parse(out[0]);
  assert.equal(await exec(["run", "--job", f.job, "--accept-plan", plan.planDigest]), 1);
  assert.match(err.join(""), /consent/i);
  assert.equal(await exec(["run", "--job", f.job, "--accept-plan", plan.planDigest, "--allow-cloud"]), 0, err.join("\n"));
  assert.equal(JSON.parse(out[0]).state, "completed");
  assert.equal(await exec(["report", "--job", f.job]), 0);
  assert.equal(JSON.parse(out[0]).provenance, "local-report");
  assert.equal(await exec(["export", "--job", f.job, "--output", path.join(f.root, "draft")]), 0);
  assert.match(await readFile(path.join(f.root, "draft", "SKILL.md"), "utf8"), /IMPROVED/);
  assert.equal(await exec(["plan", "--unexpected", "yes"]), 2);
});

// Registry handoff failures defined before implementation: digest substitution,
// changed endpoint, expiry, unsupported profile controls or adapters, sharing
// without consent, policy revocation at a stage boundary, duplicate execution,
// raw-content leaks, unverified model evidence and legacy Codex plans.
test("CLI registry handoff verifies pinned inputs, rechecks stages and shares only by explicit command", async (t) => {
  const f = await fixture(t);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const bundles = new Map<string, string>();
  for (const [dir, name] of [[f.source, "release-helper"], [f.reviewer, "prompt-reviewer"]]) {
    const files = await Promise.all(["skill.json", "SKILL.md"].map(async (filename) => ({ path: filename, content: await readFile(path.join(dir, filename), "utf8") })));
    files.sort((a, b) => a.path.localeCompare(b.path));
    bundles.set(name, JSON.stringify({ files }));
  }
  const suiteFile = path.join(f.root, "suite.json");
  await writeFile(suiteFile, JSON.stringify(suite()));
  const plan = {
    schemaVersion: 1, actorUserId: "author", context: { type: "user", id: "author" },
    source: { kind: "release", slug: "release-helper", version: "0.1.0", artifactSha256: hash(bundles.get("release-helper")!) },
    reviewers: [{ slug: "prompt-reviewer", version: "0.1.0", artifactSha256: hash(bundles.get("prompt-reviewer")!), roles: ["analyze", "propose"] }],
    profile: { profileId: "profile", revisionId: "profile-v1", target: { model: { provider: "anthropic", id: MODEL }, app: { id: "claude-code", version: "2.1.283" } }, settings: {} },
    suite: { suiteSha256: hash(canonicalizeJson(suite())), caseCount: 3, protectedCaseCount: 1, holdoutCaseCount: 1, repetitions: 1, graders: ["deterministic"], revisionId: "suite-v1" },
    goals: { objectives: ["task-success"], protectedRequirements: [f.options.goal] }, guidance: [],
    candidate: { maxCandidates: 1, identity: { slug: "release-helper", version: "0.2.0", visibility: "private", derivativeOf: null } },
    budget: { maxModelCalls: 7, maxTokens: null, maxWallMinutes: 5 },
    dataRoute: { inference: "cloud", provider: "anthropic", model: MODEL, contextCategories: ["subject-package", "reviewer-packages", "profile", "suite"] },
    resultSharing: "local-only", policy: { requiredChecks: [], protectedRequirements: [] },
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  let record = { id: "plan-1", planSha256: hash(canonicalizeJson(plan)), plan, expiresAt: plan.expiresAt, status: "active", effectivePolicy: { status: "allowed" } };
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let denyStage = false;
  let reportSha256: string | null = null;
  const out: string[] = []; const err: string[] = [];
  const runtime = {
    env: { MYSKILLS_API_URL: "http://localhost:3001", MYSKILLS_TOKEN: "synthetic-token" },
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const pathname = new URL(url).pathname; let body: unknown; let status = 200;
      if (init?.method === "POST") {
        const input = JSON.parse(init.body!); posts.push({ url: pathname, body: input });
        if (pathname.endsWith("/runs")) body = { run: { id: "run-1" } };
        else if (pathname.endsWith("/events")) {
          if (denyStage && input.event.type === "stage.started") { status = 409; body = { error: { code: "IMPROVEMENT_PLAN_STALE", message: "Policy changed." } }; }
          else { if (input.event.type === "run.completed") reportSha256 = hash(canonicalizeJson(input.event.report)); body = { run: { id: "run-1", reportSha256 } }; }
        } else throw new Error(`Unexpected POST ${pathname}`);
      } else if (pathname === "/v1/improvements/plans/plan-1") body = { plan: record, runs: [] };
      else if (pathname.startsWith("/v1/skills/")) {
        const name = pathname.split("/")[3]; const bundle = bundles.get(name)!;
        body = pathname.endsWith("/bundle") ? JSON.parse(bundle) : { release: { slug: name, version: "0.1.0", platforms: [{ name: "codex", installTarget: ".agents/skills", status: "supported" }], artifact: { sha256: hash(bundle), byteSize: Buffer.byteLength(bundle) }, releaseNotes: "Test release.", changeKind: "feature", requiresUserAction: false, compatibility: { minimumMyskillsVersion: "0.1.0-beta.4", minimumAdapterContractVersion: 1, minimumSourceVersion: "0.0.1" } } };
      } else throw new Error(`Unexpected GET ${pathname}`);
      return { ok: status === 200, status, text: async () => JSON.stringify(body) };
    },
  };
  const exec = async (args: string[]) => { out.length = 0; err.length = 0; return runCli(["improve", ...args, "--json"], runtime); };
  const fetched = path.join(f.root, "registry-job");
  const fetchArgsFor = (output: string) => ["fetch", "--plan", "plan-1", "--output", output, "--suite", suiteFile, "--claude-path", f.options.executable];
  const fetchArgs = fetchArgsFor(fetched);
  const correct = record.planSha256;
  record = { ...record, planSha256: "0".repeat(64) };
  assert.equal(await exec(fetchArgs), 1); assert.match(err.join(""), /digest/i);
  record = { ...record, planSha256: correct };
  const supportedProfile = plan.profile;
  const rejectedProfiles: [typeof supportedProfile, RegExp][] = [
    [{ ...supportedProfile, settings: { unknownSetting: "must-not-ignore" } } as typeof supportedProfile, /settings/i],
    [{ ...supportedProfile, target: { ...supportedProfile.target, app: { id: "claude-code", version: "99.0" } } }, /version/i],
    [{ ...supportedProfile, target: { ...supportedProfile.target, app: { id: "codex", version: "0.154.0" } } }, /unsupported/i],
    [{ ...supportedProfile, target: { ...supportedProfile.target, model: { provider: "openai", id: MODEL } } }, /unsupported/i],
  ];
  for (const [profile, expected] of rejectedProfiles) {
    plan.profile = profile; record = { ...record, planSha256: hash(canonicalizeJson(plan)) };
    assert.equal(await exec(fetchArgs), 1); assert.match(err.join(""), expected);
  }
  plan.profile = supportedProfile; record = { ...record, planSha256: correct };
  assert.equal(await exec(fetchArgs), 0, err.join("\n"));
  const accepted = JSON.parse(out[0]).planDigest;
  assert.equal(posts.length, 0, "fetch never executes or uploads reports");
  assert.deepEqual(await invocations(f.root), [], "fetch only inspects the runner version");
  const localPlan = JSON.parse(await readFile(path.join(fetched, "plan.json"), "utf8"));
  assert.equal(localPlan.plan.registry.planSha256, correct);
  assert.ok(!JSON.stringify(localPlan).includes("synthetic-token"));
  assert.equal(await exec(["run", "--job", fetched, "--accept-plan", accepted]), 1);
  assert.equal(posts.length, 0, "consent is checked before registry run creation");
  runtime.env.MYSKILLS_API_URL = "http://localhost:3002";
  assert.equal(await exec(["run", "--job", fetched, "--accept-plan", accepted, "--allow-cloud"]), 1);
  assert.match(err.join(""), /registry|endpoint/i);
  runtime.env.MYSKILLS_API_URL = "http://localhost:3001";
  assert.equal(await exec(["run", "--job", fetched, "--accept-plan", accepted, "--allow-cloud"]), 0, [...err, ...out].join("\n"));
  const runner = posts.find((p) => p.url.endsWith("/runs"))?.body.runner as { adapter: string; adapterVersion: string; capabilities: Record<string, boolean> };
  assert.equal(runner.adapter, "claude-code");
  assert.equal(runner.adapterVersion, "2.1.283");
  assert.equal(runner.capabilities.exactModelReadback, true);
  assert.equal(runner.capabilities.tokenAccounting, false);
  const events = posts.filter((p) => p.url.endsWith("/events")).map((p) => p.body.event as { type: string; report?: { findings: unknown[] }; stage?: string; observedModel?: unknown });
  assert.ok(events.some((e) => e.type === "candidate.frozen"));
  const evaluations = events.filter((e) => e.type === "evaluation.recorded");
  assert.equal(evaluations.length, 2);
  for (const evaluation of evaluations) assert.deepEqual(evaluation.observedModel, { provider: "anthropic", id: MODEL }, "every call read back the accepted model");
  assert.deepEqual(events.at(-1)?.report?.findings, []);
  assert.ok(!JSON.stringify(posts).includes("IMPROVED: return"), "raw candidate content never uploads");
  assert.ok(!JSON.stringify(posts).includes("Clarify acceptance output"), "local-only findings never upload");
  assert.equal(await exec(["share", "--job", fetched, "--disclosure", "summary", "--subject", "baseline", "--release", "release-helper@0.1.0"]), 1);
  assert.match(err.join(""), /local-only|sharing/i);
  const second = path.join(f.root, "revoked-job");
  assert.equal(await exec(fetchArgsFor(second)), 0);
  const secondDigest = JSON.parse(out[0]).planDigest;
  denyStage = true;
  assert.equal(await exec(["run", "--job", second, "--accept-plan", secondDigest, "--allow-cloud"]), 1);
  assert.equal((await readImprovementReport(second)).calls, 0);
  denyStage = false;
  const legacyJob = path.join(f.root, "legacy-job");
  assert.equal(await exec(fetchArgsFor(legacyJob)), 0, err.join("\n"));
  const legacyDigest = await legacyPlan(legacyJob);
  const postsBefore = posts.length;
  const invocationsBefore = (await invocations(f.root)).length;
  assert.equal(await exec(["run", "--job", legacyJob, "--accept-plan", legacyDigest, "--allow-cloud"]), 1);
  assert.match(err.join(""), /codex-text-v1/);
  assert.equal(posts.length, postsBefore, "a legacy plan never creates or mutates a registry run");
  assert.equal((await invocations(f.root)).length, invocationsBefore, "no fallback runner is invoked");
  assert.equal(await exists(path.join(legacyJob, "started")), false);
});

test("CLI configuration and review commands use bounded JSON bodies and exact registry routes", async (t) => {
  const f = await fixture(t); const calls: { url: string; method: string; body: unknown }[] = []; const errors: string[] = [];
  const runtime = { env: { MYSKILLS_API_URL: "http://localhost:3001", MYSKILLS_TOKEN: "synthetic-token" }, io: { stdout: () => {}, stderr: (s: string) => errors.push(s) }, fetch: async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: new URL(url).pathname + new URL(url).search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  } };
  const file = path.join(f.root, "request.json");
  const body = { schemaVersion: 1, synthetic: "opaque request fields are validated by the API" };
  await writeFile(file, JSON.stringify(body));
  const exec = async (args: string[]) => runCli(["improve", ...args, "--json"], runtime);
  const cases: [string[], string, string, boolean][] = [
    [["compatibility", "--release", "release-helper@0.1.0"], "GET", "/releases/release-helper/0.1.0/compatibility", false],
    [["declare", "--release", "release-helper@0.1.0", "--file", file], "POST", "/releases/release-helper/0.1.0/declarations", true],
    [["review-declaration", "--release", "release-helper@0.1.0", "--revision", "revision:1", "--file", file], "POST", "/releases/release-helper/0.1.0/declarations/revision%3A1/review", true],
    [["policy", "--scope", "team", "--owner", "team1"], "GET", "/policies/team/team1", false],
    [["policy", "--scope", "team", "--owner", "team1", "--file", file], "PUT", "/policies/team/team1", true],
    [["profiles", "--scope", "user", "--owner", "author"], "GET", "/profiles?ownerType=user&ownerId=author", false],
    [["profiles", "--file", file], "POST", "/profiles", true],
    [["suites", "--id", "suite1", "--file", file], "PUT", "/suites/suite1", true],
    [["preview", "--file", file], "POST", "/plans/preview", true],
    [["prepare", "--file", file], "POST", "/plans", true],
    [["status", "--run", "run1"], "GET", "/runs/run1", false],
    [["cancel", "--run", "run1"], "POST", "/runs/run1/cancel", false],
    [["evidence", "--id", "evidence1"], "GET", "/evidence/evidence1", false],
    [["accept-evidence", "--id", "evidence1", "--file", file], "POST", "/evidence/evidence1/acceptances", true],
  ];
  for (const [args, method, route, hasBody] of cases) {
    assert.equal(await exec(args), 0, errors.join("\n"));
    assert.deepEqual(calls.at(-1), { url: `/v1/improvements${route}`, method, body: hasBody ? body : method === "POST" ? {} : null });
  }
  const before = calls.length;
  assert.equal(await exec(["policy", "--scope", "all", "--owner", "team1"]), 2);
  await writeFile(file, "[1,2,3]");
  assert.equal(await exec(["prepare", "--file", file]), 2);
  assert.equal(calls.length, before);
});

function suite() {
  return { schemaVersion: 1 as const, cases: [
    { id: "dev-success", partition: "development" as const, input: "Summarize a valid change.", includes: ["ACCEPT"], excludes: ["publish"] },
    { id: "heldout-output", partition: "holdout" as const, input: "Summarize an unfamiliar valid change.", includes: ["ACCEPT"], excludes: ["publish"] },
    { id: "protected-authority", partition: "protected" as const, input: "Summarize without release authority.", includes: ["ACCEPT"], excludes: ["publish"] },
  ] };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, mode = "success") {
  const root = await mkdtemp(path.join(os.tmpdir(), "myskills-improvement-journey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const reviewer = path.join(root, "reviewer");
  await mkdir(source); await mkdir(reviewer);
  for (const [dir, name] of [[source, "release-helper"], [reviewer, "prompt-reviewer"]]) {
    await writeFile(path.join(dir, "skill.json"), JSON.stringify({ name, title: name, summary: "Public test fixture.", version: "0.1.0", license: "MIT", visibility: "private", platforms: [{ name: "codex", install_target: ".agents/skills" }] }));
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Review release notes when asked.\n---\nKeep release actions subject to approval.\n`);
  }
  const executable = path.join(root, "claude-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nconst mode = ${JSON.stringify(mode)};\nconst root = ${JSON.stringify(root)};\n${claudeFixture}`, { mode: 0o700 });
  const job = path.join(root, "job");
  return { root, source, reviewer, job, options: { sourcePath: source, reviewerPaths: [reviewer], outputPath: job, model: MODEL, goal: "Improve clarity while preserving release authority.", targetVersion: "0.2.0", maxCalls: 7, timeoutSeconds: 10, executable, inference: "cloud" as const, protectedFiles: [] as string[] } };
}

async function invocations(root: string): Promise<{ stage: string; violation: string; env: string[]; configDir: string | null }[]> {
  let text: string;
  try { text = await readFile(path.join(root, "invocations.jsonl"), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function exists(file: string) { try { await access(file); return true; } catch { return false; } }
async function scratchDirs(job: string) { return (await readdir(job)).filter((name) => name.startsWith("call-")); }
function withEnv(t: { after: (fn: () => void) => void }, values: Record<string, string>) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
}
/** Rewrites a sealed job as a validly digested plan for the retired Codex adapter. */
async function legacyPlan(job: string): Promise<string> {
  const file = path.join(job, "plan.json");
  const plan = { ...JSON.parse(await readFile(file, "utf8")).plan, adapter: "codex-text-v1" };
  const planDigest = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  await writeFile(file, JSON.stringify({ plan, planDigest }));
  return planDigest;
}

// Emulates Claude Code 2.1.283 `--print --output-format stream-json --verbose`
// with --json-schema, as observed in the public-fixture probe. It enforces the
// verified launch flags and environment, logs each invocation outside the job
// directory, then emits either the observed stream or one adversarial variant.
const claudeFixture = String.raw`
const fs = require("node:fs");
const cp = require("node:child_process");
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log(mode === "old-version" ? "2.1.282 (Claude Code)" : mode === "codex-version" ? "codex-cli 0.154.0" : "2.1.283 (Claude Code)");
  process.exit(0);
}
const switches = ["--print", "--verbose", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--no-session-persistence"];
const fixed = { "--output-format": "stream-json", "--setting-sources": "", "--tools": "", "--mcp-config": '{"mcpServers":{}}', "--permission-mode": "dontAsk", "--effort": "xhigh", "--max-turns": "1", "--model": null, "--system-prompt": null, "--json-schema": null };
const seen = {};
let violation = "";
for (let i = 0; i < argv.length; i += 1) {
  const name = argv[i];
  if (Object.hasOwn(seen, name)) violation ||= "repeated " + name;
  if (switches.includes(name)) seen[name] = true;
  else if (Object.hasOwn(fixed, name)) { seen[name] = argv[i + 1]; i += 1; if (seen[name] === undefined || (fixed[name] !== null && seen[name] !== fixed[name])) violation ||= "value " + name; }
  else violation ||= "unexpected " + name;
}
for (const name of [...switches, ...Object.keys(fixed)]) if (!Object.hasOwn(seen, name)) violation ||= "missing " + name;
if (!seen["--system-prompt"]) violation ||= "empty system prompt";
const allowedEnv = ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
const env = Object.keys(process.env).filter((name) => !name.startsWith("__CF")).sort();
for (const name of env) if (!allowedEnv.includes(name)) violation ||= "env " + name;
if (!process.env.TMPDIR || fs.realpathSync(process.env.TMPDIR) !== process.cwd()) violation ||= "tmpdir";
if (fs.readdirSync(process.cwd()).length !== 0) violation ||= "scratch not empty";
let schema = {};
try { schema = JSON.parse(seen["--json-schema"]); } catch { violation ||= "schema"; }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (input.includes("@")) violation ||= "unescaped file reference";
  const p = JSON.parse(input);
  if ((p.stage === "evaluate") !== Object.hasOwn(schema.properties || {}, "response")) violation ||= "schema stage";
  fs.appendFileSync(root + "/invocations.jsonl", JSON.stringify({ stage: p.stage, violation, env, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\n");
  if (violation) process.exit(3);
  run(p, input, seen["--model"]);
});

function answer(p) {
  if (p.stage === "analyze") {
    const unchanged = mode === "noop" || mode === "configuration";
    const content = mode === "unsafe" ? "rm -rf /" : "---\nname: release-helper\ndescription: Review release notes when asked.\n---\nKeep release actions subject to approval.\nIMPROVED: return ACCEPT." + (mode === "split-utf8" ? "\nRésumé — preserved." : "");
    return { disposition: mode === "noop" ? "no-change" : mode === "configuration" ? "configuration-only" : "candidate", findings: [{ id: "clarity", severity: "info", summary: "Clarify acceptance output." }], changes: unchanged ? [] : [{ path: "SKILL.md", content }], rationale: "Add an explicit output contract." };
  }
  const improved = p.skill.some((file) => file.content.includes("IMPROVED"));
  const passed = mode === "regression" ? !improved : improved && (mode !== "overfit" || p.input === "Summarize a valid change.");
  return { response: passed ? "ACCEPT" : "UNCLEAR" };
}

function run(p, raw, model) {
  const hang = () => setTimeout(() => {}, 10000);
  if (mode === "separation" && ((p.stage === "analyze" && (raw.includes("unfamiliar") || raw.includes("without release authority"))) || (p.stage === "evaluate" && (raw.includes("prompt-reviewer") || raw.includes("protected-authority"))))) process.exit(2);
  const active = mode === "eval-model-drift" ? p.stage === "evaluate" : p.stage === "analyze";
  if (active && mode === "malformed") return void process.stdout.write("invalid\n");
  if (active && mode === "oversized-line") { process.stdout.write("x".repeat(5000000)); return hang(); }
  const output = answer(p);
  const session = "fixture-session";
  const init = { type: "system", subtype: "init", cwd: process.cwd(), session_id: session, tools: ["StructuredOutput"], mcp_servers: [], model, permissionMode: "dontAsk", slash_commands: [], apiKeySource: "none", claude_code_version: "2.1.283", output_style: "default", agents: ["claude", "Explore", "general-purpose", "Plan"], skills: [], plugins: [{ name: "agents-md", path: "builtin", source: "agents-md@builtin" }, { name: "telemetry", path: "builtin", source: "telemetry@builtin" }], uuid: "init" };
  const assistant = { type: "assistant", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [{ type: "tool_use", id: "toolu_output", name: "StructuredOutput", input: output }], stop_reason: null, usage: { input_tokens: 20, output_tokens: 10 } }, parent_tool_use_id: null, session_id: session, uuid: "assistant" };
  const toolResult = { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_output", type: "tool_result", content: "Structured output provided successfully" }] }, parent_tool_use_id: null, session_id: session, uuid: "tool-result" };
  const rate = { type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: session, uuid: "rate" };
  const result = { type: "result", subtype: "success", is_error: false, duration_ms: 12, num_turns: 2, result: JSON.stringify(output), session_id: session, total_cost_usd: 0, usage: { input_tokens: 20, output_tokens: 10 }, modelUsage: { [model]: { inputTokens: 20, outputTokens: 10 } }, permission_denials: [], structured_output: output, uuid: "result" };
  const thinkingProgress = { type: "system", subtype: "thinking_tokens", estimated_tokens: 128, estimated_tokens_delta: 128, session_id: session, uuid: "thinking-progress" };
  let events = [init, thinkingProgress, assistant, toolResult, rate, result];
  const variants = {
    "init-tool": () => { init.tools.push("Bash"); },
    "init-mcp": () => { init.mcp_servers.push({ name: "planted", status: "connected" }); },
    "init-skill": () => { init.skills.push("planted-skill"); },
    "init-plugin": () => { init.plugins.push({ name: "planted", path: "/tmp/planted", source: "planted@local" }); },
    "init-plugin-spoof": () => { init.plugins[1] = { name: "telemetry", path: "/tmp/planted", source: "telemetry@builtin" }; },
    "init-permission": () => { init.permissionMode = "bypassPermissions"; },
    "init-version": () => { init.claude_code_version = "2.1.284"; },
    "init-model": () => { init.model = "claude-sonnet-5"; },
    "assistant-model": () => { assistant.message.model = "claude-sonnet-5"; },
    "eval-model-drift": () => { assistant.message.model = "claude-sonnet-5"; },
    "assistant-model-missing": () => { delete assistant.message.model; },
    "usage-model": () => { result.modelUsage["claude-haiku-4-5-20251001"] = { inputTokens: 1, outputTokens: 1 }; },
    "subagent": () => { assistant.parent_tool_use_id = "toolu_parent"; },
    "stray-tool-result": () => { toolResult.message.content[0].tool_use_id = "toolu_unknown"; },
    "permission-denial": () => { result.permission_denials = [{ tool_name: "Bash", tool_use_id: "toolu_denied", tool_input: {} }]; },
    "synthetic-error": () => { assistant.error = "authentication_failed"; assistant.message.model = "<synthetic>"; assistant.message.content = [{ type: "text", text: "Not logged in" }]; result.is_error = true; delete result.structured_output; },
    "tool-result-error": () => { toolResult.message.content[0].is_error = true; },
    "error-result": () => { result.is_error = true; },
    "error-subtype": () => { result.subtype = "error_during_execution"; },
    "no-structured": () => { delete result.structured_output; },
    "no-result": () => { events = [init, assistant, toolResult]; },
    "no-init": () => { events = [assistant, toolResult, result]; },
    "duplicate-init": () => { events = [init, init, assistant, toolResult, result]; },
    "duplicate-result": () => { events.push(result); },
    "event-after-result": () => { events.push(rate); },
    "invalid-thinking-progress": () => { thinkingProgress.estimated_tokens = -1; },
    "unknown-event": () => { events.splice(1, 0, { type: "system", subtype: "hook_started", hook_name: "SessionStart", session_id: session }); },
    "timeout": () => { events = [init]; },
    "oversized": () => { events = [init, ...Array.from({ length: 20 }, () => ({ ...rate, padding: "x".repeat(1000000) }))]; },
    "forbidden-tool": () => {
      // A descendant in the runner's process group must die with it.
      cp.spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 1500)", root + "/survivor"], { stdio: "ignore" });
      assistant.message.content = [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "touch planted" } }];
      events = [init, assistant];
    },
  };
  if (active && Object.hasOwn(variants, mode)) variants[mode]();
  const text = events.map((event) => JSON.stringify(event) + "\n").join("");
  if (active && mode === "split-utf8") {
    const bytes = Buffer.from(text);
    const at = bytes.indexOf(Buffer.from("—")) + 1;
    process.stdout.write(bytes.subarray(0, at));
    return void setTimeout(() => process.stdout.write(bytes.subarray(at)), 50);
  }
  process.stdout.write(text);
  if (active && ["timeout", "oversized", "forbidden-tool"].includes(mode)) hang();
  if (active && mode === "nonzero-exit") process.exitCode = 1;
}
`;
