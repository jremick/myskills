import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { runCli } from "../src/cli.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@myskills-app/core";
import { createImprovementJob, runImprovementJob, exportImprovementCandidate, readImprovementReport } from "../src/skill-improvement.js";

// Written before the runner. The real child-process adapter is exercised using a
// deterministic executable fixture; no model calls or private data leave the test.
// Failure coverage: consent, tampering, protected files, changed tests, symlinks,
// bounded output/time/calls, regression, no-op, and exact evaluated-tree export.
test("local improvement journey preserves source, evaluates a sealed candidate, and exports repeatable evidence", async (t) => {
  const f = await fixture(t);
  const sourceBefore = await readFile(path.join(f.source, "SKILL.md"), "utf8");
  const job = await createImprovementJob({ ...f.options, suite: suite() });
  assert.match(job.planDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest }), /consent/i);
  const report = await runImprovementJob({ jobPath: f.job, acceptPlan: job.planDigest, allowCloud: true });
  assert.equal(report.state, "completed");
  assert.equal(report.provenance, "local-report");
  assert.equal(report.modelVerification, "unobserved");
  assert.equal(report.evaluation?.outcome, "improved");
  assert.equal(report.evaluation?.baselinePassed, 0);
  assert.equal(report.evaluation?.candidatePassed, 3);
  assert.equal(report.evaluation?.cases.length, 3);
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

test("CLI plan, consent, run, report and draft export form one local user journey", async (t) => {
  const f = await fixture(t);
  const out: string[] = []; const err: string[] = [];
  const runtime = { env: {}, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, fetch: async () => { throw new Error("Local commands must not call the registry."); } };
  const exec = async (args: string[]) => { out.length = 0; err.length = 0; return runCli(["improve", ...args, "--json"], runtime); };
  assert.equal(await exec(["plan", "--path", f.source, "--reviewer", f.reviewer, "--output", f.job, "--model", f.options.model, "--goal", f.options.goal, "--target-version", "0.2.0", "--codex-path", f.options.executable]), 0, err.join("\n"));
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
// changed endpoint, expiry, unsupported profile controls, sharing without consent,
// policy revocation at a stage boundary, duplicate execution and raw-content leaks.
test("CLI registry handoff verifies pinned inputs, rechecks stages and shares only by explicit command", async (t) => {
  const f = await fixture(t);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const bundles = new Map<string, string>();
  for (const [dir, name] of [[f.source, "release-helper"], [f.reviewer, "prompt-reviewer"]]) {
    const files = await Promise.all(["skill.json", "SKILL.md"].map(async (filename) => ({ path: filename, content: await readFile(path.join(dir, filename), "utf8") })));
    files.sort((a, b) => a.path.localeCompare(b.path));
    bundles.set(name, JSON.stringify({ files }));
  }
  const plan = {
    schemaVersion: 1, actorUserId: "author", context: { type: "user", id: "author" },
    source: { kind: "release", slug: "release-helper", version: "0.1.0", artifactSha256: hash(bundles.get("release-helper")!) },
    reviewers: [{ slug: "prompt-reviewer", version: "0.1.0", artifactSha256: hash(bundles.get("prompt-reviewer")!), roles: ["analyze", "propose"] }],
    profile: { profileId: "profile", revisionId: "profile-v1", target: { model: { provider: "openai", id: f.options.model }, app: { id: "codex", version: "0.154.0" } }, settings: {} },
    suite: null, goals: { objectives: ["task-success"], protectedRequirements: [f.options.goal] }, guidance: [],
    candidate: { maxCandidates: 1, identity: { slug: "release-helper", version: "0.2.0", visibility: "private", derivativeOf: null } },
    budget: { maxModelCalls: 7, maxTokens: null, maxWallMinutes: 5 },
    dataRoute: { inference: "cloud", provider: "openai", model: f.options.model, contextCategories: ["subject-package", "reviewer-packages", "profile"] },
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
  const fetchArgs = ["fetch", "--plan", "plan-1", "--output", fetched, "--codex-path", f.options.executable];
  const correct = record.planSha256;
  record = { ...record, planSha256: "0".repeat(64) };
  assert.equal(await exec(fetchArgs), 1); assert.match(err.join(""), /digest/i);
  record = { ...record, planSha256: correct };
  const supportedProfile = plan.profile;
  plan.profile = { ...supportedProfile, settings: { unknownSetting: "must-not-ignore" } };
  record = { ...record, planSha256: hash(canonicalizeJson(plan)) };
  assert.equal(await exec(fetchArgs), 1); assert.match(err.join(""), /settings/i);
  plan.profile = { ...supportedProfile, target: { ...supportedProfile.target, app: { id: "codex", version: "99.0" } } } as typeof supportedProfile;
  record = { ...record, planSha256: hash(canonicalizeJson(plan)) };
  assert.equal(await exec(fetchArgs), 1); assert.match(err.join(""), /version/i);
  plan.profile = supportedProfile; record = { ...record, planSha256: correct };
  assert.equal(await exec(fetchArgs), 0, err.join("\n"));
  const accepted = JSON.parse(out[0]).planDigest;
  assert.equal(posts.length, 0, "fetch never executes or uploads reports");
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
  const events = posts.filter((p) => p.url.endsWith("/events")).map((p) => p.body.event as { type: string; report?: { findings: unknown[] }; stage?: string });
  assert.ok(events.some((e) => e.type === "candidate.frozen"));
  assert.deepEqual(events.at(-1)?.report?.findings, []);
  assert.ok(!JSON.stringify(posts).includes("IMPROVED: return"), "raw candidate content never uploads");
  assert.ok(!JSON.stringify(posts).includes("Clarify acceptance output"), "local-only findings never upload");
  assert.equal(await exec(["share", "--job", fetched, "--disclosure", "summary", "--subject", "baseline", "--release", "release-helper@0.1.0"]), 1);
  assert.match(err.join(""), /local-only|sharing/i);
  const second = path.join(f.root, "revoked-job");
  assert.equal(await exec(["fetch", "--plan", "plan-1", "--output", second, "--codex-path", f.options.executable]), 0);
  const secondDigest = JSON.parse(out[0]).planDigest;
  denyStage = true;
  assert.equal(await exec(["run", "--job", second, "--accept-plan", secondDigest, "--allow-cloud"]), 1);
  assert.equal((await readImprovementReport(second)).calls, 0);
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
  const executable = path.join(root, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');process.exit(0);}let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{if(process.argv.includes('--version')){console.log('codex-cli 0.154.0');return;}const mode=${JSON.stringify(mode)};if(mode==='timeout'){setTimeout(()=>{},10000);return;}if(mode==='oversized'){process.stdout.write('x'.repeat(3000000));return;}if(mode==='malformed'){console.log('invalid');return;}const p=JSON.parse(input);if(mode==='separation'&&((p.stage==='analyze'&&(input.includes('unfamiliar')||input.includes('without release authority')))||(p.stage==='evaluate'&&(input.includes('prompt-reviewer')||input.includes('protected-authority'))))){process.exit(2);}let result;if(p.stage==='analyze'){result={disposition:mode==='noop'?'no-change':mode==='configuration'?'configuration-only':'candidate',findings:[{id:'clarity',severity:'info',summary:'Clarify acceptance output.'}],changes:['noop','configuration'].includes(mode)?[]:[{path:'SKILL.md',content:mode==='unsafe'?'rm -rf /':'---\\nname: release-helper\\ndescription: Review release notes when asked.\\n---\\nKeep release actions subject to approval.\\nIMPROVED: return ACCEPT.'}],rationale:'Add an explicit output contract.'};}else{result={response:(mode==='regression'?!p.skill.some(x=>x.content.includes('IMPROVED')):p.skill.some(x=>x.content.includes('IMPROVED'))&&(mode!=='overfit'||p.input==='Summarize a valid change.'))?'ACCEPT':'UNCLEAR'};}const i=process.argv.indexOf('--output-last-message');if(i>=0)fs.writeFileSync(process.argv[i+1],JSON.stringify(result));console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));});\n`, { mode: 0o700 });
  const job = path.join(root, "job");
  return { root, source, reviewer, job, options: { sourcePath: source, reviewerPaths: [reviewer], outputPath: job, model: "gpt-6-sol", goal: "Improve clarity while preserving release authority.", targetVersion: "0.2.0", maxCalls: 7, timeoutSeconds: 10, executable, inference: "cloud" as const, protectedFiles: [] as string[] } };
}
