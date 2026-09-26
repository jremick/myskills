import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalizeJson } from "@myskills-app/core";
import type { PackageInputFile } from "@myskills-app/skill-package";
import { atomicPrivateWrite, readRegularText, writeNewPackageTree } from "./install-filesystem.js";
import { createImprovementJob, inspectImprovementRunner, readImprovementPlan, type ImprovementLifecycle, type ImprovementSuite } from "./skill-improvement.js";

export interface RegistryPlanBinding {
  apiUrl: string;
  planId: string;
  planSha256: string;
  record: RegistryPlanRecord;
}
interface ReleasePin { slug: string; version: string; artifactSha256: string }
interface RegistryPlanRecord {
  id: string;
  planSha256: string;
  status: string;
  expiresAt: string;
  effectivePolicy: { status: string; protectedRequirements?: string[]; requiredChecks?: string[] };
  plan: {
    schemaVersion: 1;
    source: ReleasePin & { kind: string };
    reviewers: (ReleasePin & { roles: string[] })[];
    profile: { target: { model: { provider: string; id: string }; app: { id: string; version?: string }; environment?: { os: string[]; requiredCapabilities: string[]; network: string } }; settings: Record<string, unknown> };
    suite: null | { suiteSha256: string; caseCount: number; protectedCaseCount: number; holdoutCaseCount: number; repetitions?: number; graders?: string[]; revisionId: string };
    goals: { objectives: string[]; protectedRequirements: string[] };
    guidance: unknown[];
    candidate: { identity: null | { slug: string; version: string; visibility: string; derivativeOf: unknown } };
    budget: { maxModelCalls: number; maxTokens: number | null; maxWallMinutes: number };
    dataRoute: { inference: string; provider: string; model: string; contextCategories: string[] };
    resultSharing: "local-only" | "summary" | "selected-evidence";
    policy: { requiredChecks: string[]; protectedRequirements?: string[] };
  };
}
export interface ImprovementRegistryApi {
  apiUrl: string;
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  bundle(pin: ReleasePin): Promise<{ files: PackageInputFile[]; artifact: { sha256: string } }>;
}
const hash = (value: unknown) => createHash("sha256").update(canonicalizeJson(value)).digest("hex");
const base = "/v1/improvements";

export async function fetchImprovementJob(api: ImprovementRegistryApi, input: { planId: string; outputPath: string; executable?: string; suite?: ImprovementSuite }) {
  const response = await api.get(`${base}/plans/${encodeURIComponent(input.planId)}`);
  const record = checkedRecord(response.plan, input.planId);
  const plan = record.plan;
  if (plan.source.kind !== "release") throw new Error("Fetch requires a registry release source. Prepare local sources with improve plan.");
  if (plan.dataRoute.inference !== "cloud" || plan.budget.maxTokens !== null) throw new Error("This adapter cannot enforce the plan's inference route or token budget.");
  // Claude Code is the only enabled local runner. Codex plans are refused, never
  // rerouted, until that adapter passes its own isolation gate.
  const target = plan.profile.target;
  if (target.app.id !== "claude-code" || plan.dataRoute.provider !== "anthropic" || target.model.provider !== "anthropic" || target.model.id !== plan.dataRoute.model) throw new Error("The prepared target requires an unsupported local adapter.");
  if (Object.keys(plan.profile.settings).length > 0) throw new Error("This adapter does not yet support the prepared profile settings.");
  const environment = plan.profile.target.environment;
  const currentOs = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
  if (environment?.os.length && !environment.os.includes(currentOs)) throw new Error("The local operating system does not match the prepared target.");
  if (environment?.requiredCapabilities.length || environment?.network === "none") throw new Error("The prepared environment requires capabilities this text adapter cannot enforce.");
  const categories = ["subject-package", "reviewer-packages", "profile", ...(plan.suite ? ["suite"] : [])];
  if (categories.some((category) => !plan.dataRoute.contextCategories.includes(category))) throw new Error("The accepted data route does not include every input this adapter needs.");
  if (plan.guidance.length > 0) throw new Error("This adapter requires guidance to be packaged in a pinned reviewer skill.");
  if (plan.reviewers.some((r) => r.roles.includes("evaluate") && !r.roles.includes("analyze") && !r.roles.includes("propose"))) throw new Error("Model grader skills are unsupported by this text-contract adapter.");
  const checks = plan.policy.requiredChecks;
  if (checks.some((check) => !["protected-cases", "holdout-cases"].includes(check))) throw new Error("The prepared plan requires checks that this adapter cannot perform.");
  if (plan.suite) {
    if (!input.suite || hash(input.suite) !== plan.suite.suiteSha256) throw new Error("Provide the exact local evaluation suite matching the prepared suite digest.");
    if (input.suite.cases.length !== plan.suite.caseCount || input.suite.cases.filter((c) => c.partition === "protected").length !== plan.suite.protectedCaseCount || input.suite.cases.filter((c) => c.partition === "holdout").length !== plan.suite.holdoutCaseCount) throw new Error("Evaluation suite counts differ from the prepared plan.");
    if ((plan.suite.repetitions ?? 1) !== 1) throw new Error("This adapter currently supports one paired repetition per case.");
    if (plan.suite.graders?.some((g) => g !== "deterministic")) throw new Error("This adapter supports deterministic text grading only.");
  } else if (input.suite) throw new Error("A local suite cannot be added after the registry plan was prepared.");
  if (checks.includes("protected-cases") && !input.suite?.cases.some((c) => c.partition === "protected")) throw new Error("Policy requires protected evaluation cases.");
  if (checks.includes("holdout-cases") && !input.suite?.cases.some((c) => c.partition === "holdout")) throw new Error("Policy requires holdout evaluation cases.");
  const runner = await inspectImprovementRunner(input.executable);
  if (plan.profile.target.app.version !== runner.runnerVersion) throw new Error("Installed app version differs from the prepared target version.");
  const snapshots = await Promise.all([plan.source, ...plan.reviewers].map(async (pin) => {
    const snapshot = await api.bundle(pin);
    if (snapshot.artifact.sha256 !== pin.artifactSha256) throw new Error("A downloaded release differs from the prepared artifact digest.");
    return snapshot;
  }));
  const output = path.join(await realpath(path.dirname(path.resolve(input.outputPath))), path.basename(input.outputPath));
  // Sibling input storage leaves source snapshots outside the mutable job tree.
  // Exclusive directory creation preserves existing inputs on every retry.
  const inputs = `${output}.inputs`;
  await mkdir(inputs, { mode: 0o700 });
  const sourcePath = path.join(inputs, "source");
  await writeNewPackageTree(inputs, sourcePath, snapshots[0].files);
  const reviewerPaths: string[] = [];
  for (let i = 1; i < snapshots.length; i += 1) {
    const dir = path.join(inputs, `reviewer-${i}`);
    await writeNewPackageTree(inputs, dir, snapshots[i].files); reviewerPaths.push(dir);
  }
  const identity = plan.candidate.identity;
  const registry: RegistryPlanBinding = { apiUrl: api.apiUrl, planId: record.id, planSha256: record.planSha256, record };
  return createImprovementJob({ sourcePath, reviewerPaths, outputPath: output, model: plan.dataRoute.model,
    goal: [...plan.goals.objectives, ...plan.goals.protectedRequirements, ...(record.effectivePolicy.protectedRequirements ?? [])].join("\n"),
    targetVersion: identity?.version ?? plan.source.version, analysisOnly: identity === null,
    maxCalls: Math.min(101, plan.budget.maxModelCalls), timeoutSeconds: Math.min(600, plan.budget.maxWallMinutes * 60), maxWallMinutes: plan.budget.maxWallMinutes,
    inference: "cloud", executable: input.executable, suite: input.suite, registry,
    expectedIdentity: identity ? { name: identity.slug, visibility: identity.visibility } : undefined,
    expectedAppVersion: plan.profile.target.app.version,
  });
}

export async function registryLifecycle(api: ImprovementRegistryApi, jobPath: string, coordinatorVersion: string): Promise<ImprovementLifecycle | undefined> {
  const { plan, planDigest } = await readImprovementPlan(jobPath);
  if (!plan.registry) return undefined;
  const binding = plan.registry;
  if (api.apiUrl !== binding.apiUrl) throw new Error("Registry endpoint differs from the accepted plan. Use the original API URL.");
  checkedRecord(binding.record, binding.planId);
  if (binding.planSha256 !== binding.record.planSha256) throw new Error("Registry binding digest differs from its plan.");
  const remotePlan = binding.record.plan;
  let runId: string | undefined; let sequence = 0;
  const jobRoot = await realpath(jobPath);
  const statePath = path.join(jobRoot, "registry-run.json");
  const save = async (reportSha256?: string | null) => atomicPrivateWrite(jobRoot, statePath, JSON.stringify({ planDigest, planId: binding.planId, runId, sequence, reportSha256: reportSha256 ?? null }, null, 2));
  const event = async (value: unknown) => {
    if (!runId) throw new Error("The registry run has not started.");
    const response = await api.post(`${base}/runs/${encodeURIComponent(runId)}/events`, { planSha256: binding.planSha256, sequence: sequence + 1, event: value });
    sequence += 1;
    const run = response.run as { reportSha256?: string } | undefined;
    await save(run?.reportSha256);
  };
  return {
    async start() {
      const response = await api.post(`${base}/plans/${encodeURIComponent(binding.planId)}/runs`, {
        planSha256: binding.planSha256, idempotencyKey: `local-${planDigest}`, runner: { adapter: "claude-code", adapterVersion: plan.runnerVersion, coordinatorVersion,
          // Model readback is mandatory on every call. No OS sandbox restricts the
          // network, and token use is not accounted.
          capabilities: { structuredOutput: true, workspaceIsolation: true, networkRestriction: false, tokenAccounting: false, cancellation: true, exactModelReadback: true } },
      });
      const run = response.run as { id?: string } | undefined;
      if (!run?.id) throw new Error("Registry did not return a run identifier.");
      runId = run.id; await save();
    },
    async stage(stage, state, findingCount = 0) { await event({ type: `stage.${state}`, stage, ...(state === "completed" ? { findingCount } : {}) }); },
    async candidate(treeSha256, files) { await event({ type: "candidate.frozen", treeSha256, fileCount: files.length, identity: remotePlan.candidate.identity, validation: { packageValid: true, scanBlocking: false, protectedDiffClean: true } }); },
    async finish(report) {
      if (report.state !== "completed") {
        if (runId) {
          if (report.state === "cancelled") await api.post(`${base}/runs/${encodeURIComponent(runId)}/cancel`, {});
          else await event({ type: "run.failed", reason: "runner_failed" });
        }
        return;
      }
      if (report.evaluation && remotePlan.suite) {
        // A completed report is observed only when every call read back the
        // same accepted model; anything else stays unverified.
        const observedModel = report.modelVerification === "observed" && report.observedModel === remotePlan.dataRoute.model ? { provider: remotePlan.dataRoute.provider, id: report.observedModel } : null;
        for (const subject of ["baseline", "candidate"] as const) {
          const cases = report.evaluation.cases;
          const passed = (c: typeof cases[number]) => subject === "baseline" ? c.baselinePassed : c.candidatePassed;
          await event({ type: "evaluation.recorded", subject, treeSha256: subject === "baseline" ? report.sourceDigest : report.candidateDigest,
            suiteSha256: remotePlan.suite.suiteSha256, observedModel,
            cases: { total: cases.length, passed: cases.filter(passed).length, failed: cases.filter((c) => !passed(c)).length, errored: 0 },
            protectedCases: { total: cases.filter((c) => c.partition === "protected").length, failed: cases.filter((c) => c.partition === "protected" && !passed(c)).length },
            holdoutCases: { total: cases.filter((c) => c.partition === "holdout").length, passed: cases.filter((c) => c.partition === "holdout" && passed(c)).length }, repetitions: 1 });
        }
        await event({ type: "stage.completed", stage: "evaluate", findingCount: 0 });
      }
      // Findings stay local. Sharing summaries is a separate explicit command;
      // none can be attributed to one reviewer when several jointly generated it.
      await event({ type: "run.completed", report: { schemaVersion: 1, disposition: report.disposition, findings: [], configurationChanges: [],
        resources: { modelCalls: report.calls, tokens: null, wallMs: report.wallMs ?? null, cost: "unknown" } } });
    },
  };
}

export async function shareImprovementEvidence(api: ImprovementRegistryApi, input: { jobPath: string; disclosure: string; subject: string; slug: string; version: string }) {
  const { plan, planDigest } = await readImprovementPlan(input.jobPath);
  if (!plan.registry || plan.registry.apiUrl !== api.apiUrl) throw new Error("Evidence sharing requires the original registry endpoint and plan.");
  if (plan.registry.record.plan.resultSharing === "local-only") throw new Error("This plan is local-only; evidence sharing was not authorized.");
  if (input.disclosure !== "summary") throw new Error("This adapter shares summary evidence only. Raw findings stay local.");
  if (!["baseline", "candidate"].includes(input.subject)) throw new Error("Evidence subject must be baseline or candidate.");
  const state = JSON.parse(await readRegularText(path.join(await realpath(input.jobPath), "registry-run.json"), 64_000));
  if (state.planDigest !== planDigest || !state.runId || !state.reportSha256) throw new Error("No confirmed registry completion is available to share.");
  const body = { reportSha256: state.reportSha256, disclosure: input.disclosure, proposals: [{ subject: input.subject, slug: input.slug, version: input.version }], idempotencyKey: `share-${hash({ planDigest, subject: input.subject, slug: input.slug, version: input.version })}` };
  return api.post(`${base}/runs/${encodeURIComponent(state.runId)}/evidence`, body);
}

function checkedRecord(input: unknown, id: string): RegistryPlanRecord {
  const record = input as RegistryPlanRecord | undefined;
  if (!record || record.id !== id || !record.plan || record.planSha256 !== hash(record.plan)) throw new Error("Prepared registry plan digest or identity does not match.");
  if (record.status !== "active" || record.effectivePolicy?.status !== "allowed" || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) throw new Error("Prepared plan is expired or blocked. Create a new preview.");
  return record;
}
