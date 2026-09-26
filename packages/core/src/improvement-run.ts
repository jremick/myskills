import { canonicalizeJson, sha256Hex } from "./architecture-canonical.js";
import {
  improvementObjectives,
  normalizeImprovementModelRef,
  type ImprovementModelRefV1,
  type ImprovementObjective,
  type OptimizationDeclarationV1,
  type OptimizationTargetV1,
} from "./improvement-declaration.js";
import {
  improvementDisclosures,
  improvementInferenceRoutes,
  improvementPinKey,
  improvementProvenanceRank,
  normalizeImprovementReviewerPinV1,
  normalizeImprovementScopeRef,
  type EffectiveImprovementPolicyV1,
  type ImprovementDisclosure,
  type ImprovementGrader,
  type ImprovementInferenceRoute,
  type ImprovementPolicyConstraintV1,
  type ImprovementProfileTargetV1,
  type ImprovementProvenance,
  type ImprovementReviewerPinV1,
  type ImprovementScopeRef,
} from "./improvement-policy.js";
import {
  arrayField,
  booleanField,
  enumValue,
  fail,
  identifier,
  improvementDigest,
  integerField,
  isoTimestamp,
  objectInput,
  safeText,
  schemaVersionOne,
  sha256Field,
  skillSlug,
  skillVersion,
  textArray,
  uniqueEnumArray,
} from "./improvement-shared.js";

export const improvementRunStates = ["running", "completed", "failed", "cancelled", "expired"] as const;
export const improvementRunStages = ["analyze", "propose", "evaluate"] as const;
export const improvementRunnerAdapters = ["codex", "claude-code"] as const;
export const improvementContextCategories = ["subject-package", "reviewer-packages", "profile", "guidance", "suite"] as const;
export const improvementReportDispositions = [
  "no-change", "configuration-only", "recommend", "candidate", "blocked", "incompatible", "insufficient-evidence",
] as const;
export const improvementFindingSeverities = ["info", "low", "medium", "high"] as const;
export const improvementFindingCategories = ["routing", "instructions", "tools", "safety", "output", "configuration", "compatibility", "other"] as const;
export const improvementFindingDispositions = ["addressed", "rejected", "deferred", "open"] as const;
export const improvementRunFailureReasons = ["runner_failed", "budget_exhausted", "validation_failed", "adapter_unavailable"] as const;
export const improvementCandidateVisibilities = ["public", "authenticated", "organization", "team", "private", "explicit-users"] as const;
export const improvementEvidenceClaims = [
  "static-findings-only", "tested-baseline", "inconclusive", "regression", "no-improvement", "locally-reported-improvement", "measured-improvement",
] as const;

export type ImprovementRunState = (typeof improvementRunStates)[number];
export type ImprovementRunStage = (typeof improvementRunStages)[number];
export type ImprovementRunnerAdapter = (typeof improvementRunnerAdapters)[number];
export type ImprovementContextCategory = (typeof improvementContextCategories)[number];
export type ImprovementReportDisposition = (typeof improvementReportDispositions)[number];
export type ImprovementRunFailureReason = (typeof improvementRunFailureReasons)[number];
export type ImprovementEvidenceClaim = (typeof improvementEvidenceClaims)[number];
export type ImprovementRunTerminalReason =
  | "completed" | "cancelled_by_actor" | "plan_expired" | "plan_stale" | "authorization_revoked" | "policy_blocked" | ImprovementRunFailureReason;

export interface ImprovementReleaseSourceV1 {
  kind: "release";
  slug: string;
  version: string;
  artifactSha256: string;
}

export interface ImprovementReleasePinV1 {
  slug: string;
  version: string;
  artifactSha256: string;
}

export interface ImprovementLocalSourceV1 {
  kind: "local";
  treeSha256: string;
  parent: ImprovementReleasePinV1 | null;
}

export interface ImprovementCandidateIdentityV1 {
  slug: string;
  version: string;
  visibility: (typeof improvementCandidateVisibilities)[number];
  derivativeOf: { slug: string; version: string } | null;
}

export interface ImprovementGuidanceRefV1 {
  publisher: string;
  url: string;
  retrievedAt: string;
  sha256: string;
}

export interface ImprovementPlanRequestV1 {
  schemaVersion: 1;
  context: ImprovementScopeRef;
  source: ImprovementReleaseSourceV1 | ImprovementLocalSourceV1;
  reviewers: ImprovementReviewerPinV1[];
  profileRevisionId: string;
  suiteRevisionId: string | null;
  goals: { objectives: ImprovementObjective[]; protectedRequirements: string[] };
  guidance: ImprovementGuidanceRefV1[];
  candidate: { maxCandidates: 1; identity: ImprovementCandidateIdentityV1 | null };
  budget: { maxModelCalls: number; maxTokens: number | null; maxWallMinutes: number };
  dataRoute: { inference: ImprovementInferenceRoute; provider: string; model: string; contextCategories: ImprovementContextCategory[] };
  resultSharing: ImprovementDisclosure;
  expiresInMinutes: number;
}

export function normalizeImprovementPlanRequestV1(input: unknown): ImprovementPlanRequestV1 {
  const record = objectInput(input, "plan request", [
    "schemaVersion", "context", "source", "reviewers", "profileRevisionId", "suiteRevisionId", "goals", "guidance",
    "candidate", "budget", "dataRoute", "resultSharing", "expiresInMinutes",
  ]);
  schemaVersionOne(record.schemaVersion, "plan request");
  const reviewers = arrayField(record.reviewers, "plan reviewers", 8, { minItems: 1 }).map((item, index) => normalizeImprovementReviewerPinV1(item, `plan reviewer ${index + 1}`));
  if (new Set(reviewers.map(improvementPinKey)).size !== reviewers.length) fail("plan reviewers must be unique.");
  const goals = objectInput(record.goals ?? {}, "plan goals", ["objectives", "protectedRequirements"]);
  const candidate = objectInput(record.candidate ?? {}, "plan candidate", ["maxCandidates", "identity"]);
  const budget = objectInput(record.budget, "plan budget", ["maxModelCalls", "maxTokens", "maxWallMinutes"]);
  const dataRoute = objectInput(record.dataRoute, "plan dataRoute", ["inference", "provider", "model", "contextCategories"]);
  const guidance = arrayField(record.guidance ?? [], "plan guidance", 16).map(normalizeGuidance);
  return {
    schemaVersion: 1,
    context: normalizeImprovementScopeRef(record.context, "plan context"),
    source: normalizeSource(record.source),
    reviewers,
    profileRevisionId: identifier(record.profileRevisionId, "plan profileRevisionId"),
    suiteRevisionId: record.suiteRevisionId === undefined || record.suiteRevisionId === null ? null : identifier(record.suiteRevisionId, "plan suiteRevisionId"),
    goals: {
      objectives: uniqueEnumArray(goals.objectives ?? [], "plan objectives", improvementObjectives, 8, { sort: false }),
      protectedRequirements: textArray(goals.protectedRequirements ?? [], "plan protectedRequirements", 32, 300),
    },
    guidance,
    candidate: {
      maxCandidates: candidate.maxCandidates === undefined ? 1 : integerField(candidate.maxCandidates, "plan maxCandidates", 1, 1) as 1,
      identity: candidate.identity === undefined || candidate.identity === null ? null : normalizeCandidateIdentity(candidate.identity),
    },
    budget: {
      maxModelCalls: integerField(budget.maxModelCalls, "plan maxModelCalls", 1, 100_000),
      maxTokens: budget.maxTokens === undefined || budget.maxTokens === null ? null : integerField(budget.maxTokens, "plan maxTokens", 1, 1_000_000_000),
      maxWallMinutes: integerField(budget.maxWallMinutes, "plan maxWallMinutes", 1, 1_440),
    },
    dataRoute: {
      inference: enumValue(dataRoute.inference, "plan inference", improvementInferenceRoutes),
      provider: identifier(dataRoute.provider, "plan provider"),
      model: identifier(dataRoute.model, "plan model"),
      contextCategories: uniqueEnumArray(dataRoute.contextCategories, "plan contextCategories", improvementContextCategories, 5, { minItems: 1 }),
    },
    resultSharing: enumValue(record.resultSharing, "plan resultSharing", improvementDisclosures),
    expiresInMinutes: integerField(record.expiresInMinutes, "plan expiresInMinutes", 5, 1_440),
  };
}

export interface ImprovementPlanSuiteV1 {
  suiteId: string;
  revisionId: string;
  revisionNumber: number;
  documentSha256: string;
  /** The suite's local content digest; evaluation events must report exactly this value. */
  suiteSha256: string;
  rubricSha256: string;
  caseCount: number;
  protectedCaseCount: number;
  holdoutCaseCount: number;
  graders: ImprovementGrader[];
  repetitions: number;
}

/** Server-bound, immutable plan. Every reference is resolved to an exact identity and digest. */
export interface ImprovementPlanV1 {
  schemaVersion: 1;
  id: string;
  actorUserId: string;
  context: ImprovementScopeRef;
  source:
    | (ImprovementReleaseSourceV1 & { releaseId: string })
    | (Omit<ImprovementLocalSourceV1, "parent"> & { parent: (ImprovementReleasePinV1 & { releaseId: string }) | null });
  reviewers: Array<ImprovementReviewerPinV1 & { releaseId: string }>;
  profile: {
    profileId: string;
    revisionId: string;
    revisionNumber: number;
    profileSha256: string;
    target: ImprovementProfileTargetV1;
    settings: Record<string, string | number | boolean>;
  };
  suite: ImprovementPlanSuiteV1 | null;
  goals: ImprovementPlanRequestV1["goals"];
  guidance: ImprovementGuidanceRefV1[];
  candidate: ImprovementPlanRequestV1["candidate"];
  budget: ImprovementPlanRequestV1["budget"];
  dataRoute: ImprovementPlanRequestV1["dataRoute"];
  resultSharing: ImprovementDisclosure;
  policy: {
    effectiveSha256: string;
    constraints: ImprovementPolicyConstraintV1[];
    requiredChecks: string[];
    maxDisclosure: ImprovementDisclosure;
    minimumProvenance: ImprovementProvenance;
    maxAttempts: number;
  };
  localExecution: { consent: "required-local"; enforcement: "cooperative-local-coordinator" };
  createdAt: string;
  expiresAt: string;
}

export function improvementPlanDigest(plan: ImprovementPlanV1): string {
  return improvementDigest(plan);
}

export function improvementEffectivePolicyDigest(policy: EffectiveImprovementPolicyV1): string {
  return improvementDigest(policy);
}

export function improvementPlanSourceTreeSha256(plan: Pick<ImprovementPlanV1, "source">): string {
  return plan.source.kind === "release" ? plan.source.artifactSha256 : plan.source.treeSha256;
}

export interface ImprovementRunnerCapabilitiesV1 {
  structuredOutput: boolean;
  workspaceIsolation: boolean;
  networkRestriction: boolean;
  tokenAccounting: boolean;
  cancellation: boolean;
  exactModelReadback: boolean;
}

/** Caller-declared runner facts. They can block an honest coordinator; they never attest execution. */
export interface ImprovementRunnerV1 {
  adapter: ImprovementRunnerAdapter;
  adapterVersion: string;
  coordinatorVersion: string;
  capabilities: ImprovementRunnerCapabilitiesV1;
}

const capabilityKeys = ["structuredOutput", "workspaceIsolation", "networkRestriction", "tokenAccounting", "cancellation", "exactModelReadback"] as const;

export function normalizeImprovementRunnerV1(input: unknown): ImprovementRunnerV1 {
  const record = objectInput(input, "runner", ["adapter", "adapterVersion", "coordinatorVersion", "capabilities"]);
  const capabilities = objectInput(record.capabilities, "runner capabilities", capabilityKeys);
  const normalized = {} as ImprovementRunnerCapabilitiesV1;
  for (const key of capabilityKeys) normalized[key] = booleanField(capabilities[key], `runner capability ${key}`);
  return {
    adapter: enumValue(record.adapter, "runner adapter", improvementRunnerAdapters),
    adapterVersion: identifier(record.adapterVersion, "runner adapterVersion"),
    coordinatorVersion: identifier(record.coordinatorVersion, "runner coordinatorVersion"),
    capabilities: normalized,
  };
}

/** Declared controls a plan needs before any execution may start. */
export function improvementRunnerMissingCapabilities(runner: ImprovementRunnerV1, plan: Pick<ImprovementPlanV1, "dataRoute" | "budget">): string[] {
  const missing: string[] = [];
  if (!runner.capabilities.workspaceIsolation) missing.push("workspaceIsolation");
  if (!runner.capabilities.structuredOutput) missing.push("structuredOutput");
  if (plan.dataRoute.inference === "on-device" && !runner.capabilities.networkRestriction) missing.push("networkRestriction");
  if (plan.budget.maxTokens !== null && !runner.capabilities.tokenAccounting) missing.push("tokenAccounting");
  return missing;
}

export interface ImprovementGuaranteeV1 {
  control: string;
  enforcedBy: "api-acceptance" | "local-coordinator" | "host-isolation" | "user-assertion";
}

/** Labels who enforces each control. Caller declarations are never labelled host isolation. */
export function improvementRunGuarantees(runner: ImprovementRunnerV1): ImprovementGuaranteeV1[] {
  return [
    { control: "plan-digest-binding", enforcedBy: "api-acceptance" },
    { control: "plan-expiry-and-policy-recheck", enforcedBy: "api-acceptance" },
    { control: "resource-access-recheck", enforcedBy: "api-acceptance" },
    { control: "event-sequence-fencing", enforcedBy: "api-acceptance" },
    { control: "workspace-isolation", enforcedBy: runner.capabilities.workspaceIsolation ? "local-coordinator" : "user-assertion" },
    { control: "candidate-validation-and-tree-digest", enforcedBy: "local-coordinator" },
    { control: "budget-limits", enforcedBy: "local-coordinator" },
    { control: "network-restriction", enforcedBy: "user-assertion" },
    { control: "model-identity", enforcedBy: "user-assertion" },
  ];
}

export interface ImprovementCaseCountsV1 {
  total: number;
  passed: number;
  failed: number;
  errored: number;
}

export interface ImprovementEvaluationV1 {
  subject: "baseline" | "candidate";
  treeSha256: string;
  suiteSha256: string;
  observedModel: ImprovementModelRefV1 | null;
  cases: ImprovementCaseCountsV1;
  protectedCases: { total: number; failed: number };
  holdoutCases: { total: number; passed: number };
  repetitions: number;
}

export interface ImprovementFindingV1 {
  id: string;
  reviewer: { slug: string; version: string };
  severity: (typeof improvementFindingSeverities)[number];
  category: (typeof improvementFindingCategories)[number];
  summary: string;
  disposition: (typeof improvementFindingDispositions)[number];
  reason?: string;
}

export interface ImprovementReportV1 {
  schemaVersion: 1;
  disposition: ImprovementReportDisposition;
  findings: ImprovementFindingV1[];
  configurationChanges: Array<{ key: string; from: string | number | boolean | null; to: string | number | boolean | null }>;
  resources: { modelCalls: number | null; tokens: number | null; wallMs: number | null; cost: "unknown" };
}

export interface ImprovementFrozenCandidateV1 {
  treeSha256: string;
  fileCount: number;
  identity: ImprovementCandidateIdentityV1;
}

export type ImprovementRunEventV1 =
  | { type: "stage.started"; stage: ImprovementRunStage }
  | { type: "stage.completed"; stage: ImprovementRunStage; findingCount: number }
  | ({ type: "candidate.frozen"; validation: { packageValid: boolean; scanBlocking: boolean; protectedDiffClean: boolean } } & ImprovementFrozenCandidateV1)
  | ({ type: "evaluation.recorded" } & ImprovementEvaluationV1)
  | { type: "run.completed"; report: ImprovementReportV1 }
  | { type: "run.failed"; reason: ImprovementRunFailureReason; detail?: string };

export function normalizeImprovementRunEventV1(input: unknown): ImprovementRunEventV1 {
  const type = (input && typeof input === "object" && !Array.isArray(input)) ? (input as Record<string, unknown>).type : undefined;
  switch (type) {
    case "stage.started": {
      const record = objectInput(input, "event", ["type", "stage"]);
      return { type: "stage.started", stage: enumValue(record.stage, "event stage", improvementRunStages) };
    }
    case "stage.completed": {
      const record = objectInput(input, "event", ["type", "stage", "findingCount"]);
      return {
        type: "stage.completed",
        stage: enumValue(record.stage, "event stage", improvementRunStages),
        findingCount: integerField(record.findingCount, "event findingCount", 0, 1_000),
      };
    }
    case "candidate.frozen": {
      const record = objectInput(input, "event", ["type", "treeSha256", "fileCount", "identity", "validation"]);
      const validation = objectInput(record.validation, "candidate validation", ["packageValid", "scanBlocking", "protectedDiffClean"]);
      return {
        type: "candidate.frozen",
        treeSha256: sha256Field(record.treeSha256, "candidate treeSha256"),
        fileCount: integerField(record.fileCount, "candidate fileCount", 1, 2_000),
        identity: normalizeCandidateIdentity(record.identity),
        validation: {
          packageValid: booleanField(validation.packageValid, "candidate packageValid"),
          scanBlocking: booleanField(validation.scanBlocking, "candidate scanBlocking"),
          protectedDiffClean: booleanField(validation.protectedDiffClean, "candidate protectedDiffClean"),
        },
      };
    }
    case "evaluation.recorded": {
      const record = objectInput(input, "event", ["type", "subject", "treeSha256", "suiteSha256", "observedModel", "cases", "protectedCases", "holdoutCases", "repetitions"]);
      return { type: "evaluation.recorded", ...normalizeEvaluation(record) };
    }
    case "run.completed": {
      const record = objectInput(input, "event", ["type", "report"]);
      return { type: "run.completed", report: normalizeImprovementReportV1(record.report) };
    }
    case "run.failed": {
      const record = objectInput(input, "event", ["type", "reason", "detail"]);
      return {
        type: "run.failed",
        reason: enumValue(record.reason, "event failure reason", improvementRunFailureReasons),
        ...(record.detail === undefined ? {} : { detail: safeText(record.detail, "event failure detail", 200) }),
      };
    }
    default:
      return fail("event type is invalid.");
  }
}

export function normalizeImprovementReportV1(input: unknown): ImprovementReportV1 {
  const record = objectInput(input, "report", ["schemaVersion", "disposition", "findings", "configurationChanges", "resources"]);
  schemaVersionOne(record.schemaVersion, "report");
  const findings = arrayField(record.findings ?? [], "report findings", 64).map((item, index) => {
    const finding = objectInput(item, `report finding ${index + 1}`, ["id", "reviewer", "severity", "category", "summary", "disposition", "reason"]);
    const reviewer = objectInput(finding.reviewer, "finding reviewer", ["slug", "version"]);
    const disposition = enumValue(finding.disposition, "finding disposition", improvementFindingDispositions);
    const reason = finding.reason === undefined ? undefined : safeText(finding.reason, "finding reason", 300);
    if (disposition === "rejected" && !reason) fail("A rejected finding requires a reason.");
    return {
      id: identifier(finding.id, "finding id"),
      reviewer: { slug: skillSlug(reviewer.slug, "finding reviewer slug"), version: skillVersion(reviewer.version, "finding reviewer version") },
      severity: enumValue(finding.severity, "finding severity", improvementFindingSeverities),
      category: enumValue(finding.category, "finding category", improvementFindingCategories),
      summary: safeText(finding.summary, "finding summary", 500),
      disposition,
      ...(reason ? { reason } : {}),
    };
  });
  if (new Set(findings.map((finding) => finding.id)).size !== findings.length) fail("report finding ids must be unique.");
  const configurationChanges = arrayField(record.configurationChanges ?? [], "report configurationChanges", 32).map((item) => {
    const change = objectInput(item, "configuration change", ["key", "from", "to"]);
    return { key: identifier(change.key, "configuration key"), from: scalarOrNull(change.from, "configuration from"), to: scalarOrNull(change.to, "configuration to") };
  });
  const resources = objectInput(record.resources ?? {}, "report resources", ["modelCalls", "tokens", "wallMs", "cost"]);
  if (resources.cost !== undefined && resources.cost !== "unknown") fail("report cost must be unknown until billing telemetry is supported.");
  return {
    schemaVersion: 1,
    disposition: enumValue(record.disposition, "report disposition", improvementReportDispositions),
    findings,
    configurationChanges,
    resources: {
      modelCalls: nullableInteger(resources.modelCalls, "report modelCalls", 1_000_000),
      tokens: nullableInteger(resources.tokens, "report tokens", 10_000_000_000),
      wallMs: nullableInteger(resources.wallMs, "report wallMs", 7 * 24 * 60 * 60 * 1_000),
      cost: "unknown",
    },
  };
}

export class ImprovementRunRejection extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number, readonly details?: unknown) {
    super(message);
  }
}

export interface ImprovementRunProgressV1 {
  state: ImprovementRunState;
  openStage: ImprovementRunStage | null;
  completedStages: ImprovementRunStage[];
  candidate: ImprovementFrozenCandidateV1 | null;
  evaluations: { baseline: ImprovementEvaluationV1 | null; candidate: ImprovementEvaluationV1 | null };
  report: ImprovementReportV1 | null;
  reportSha256: string | null;
  terminalReason: ImprovementRunTerminalReason | null;
}

export function initialImprovementRunProgress(): ImprovementRunProgressV1 {
  return {
    state: "running",
    openStage: null,
    completedStages: [],
    candidate: null,
    evaluations: { baseline: null, candidate: null },
    report: null,
    reportSha256: null,
    terminalReason: null,
  };
}

/**
 * Deterministic run state machine. It checks immutable bindings and allowed transitions; it does
 * not infer that any local execution actually happened.
 */
export function applyImprovementRunEvent(
  current: ImprovementRunProgressV1,
  event: ImprovementRunEventV1,
  context: { plan: Pick<ImprovementPlanV1, "source" | "suite" | "candidate" | "reviewers" | "resultSharing">; runner: ImprovementRunnerV1 },
): ImprovementRunProgressV1 {
  if (current.state !== "running") throw rejection("The run is no longer running.", "IMPROVEMENT_RUN_TERMINAL", 409, { state: current.state });
  const next: ImprovementRunProgressV1 = structuredClone(current);
  const plan = context.plan;
  switch (event.type) {
    case "stage.started": {
      if (next.openStage) throw invalidTransition(`Stage ${next.openStage} is still open.`);
      if (next.completedStages.length === 0 && event.stage !== "analyze") throw invalidTransition("The analyze stage must run first.");
      const lastIndex = Math.max(-1, ...next.completedStages.map((stage) => improvementRunStages.indexOf(stage)));
      if (improvementRunStages.indexOf(event.stage) <= lastIndex) throw invalidTransition("Stages run once, in order.");
      if (event.stage === "evaluate" && !plan.suite) throw invalidTransition("Evaluation requires a plan suite.");
      next.openStage = event.stage;
      return next;
    }
    case "stage.completed": {
      if (next.openStage !== event.stage) throw invalidTransition("Only the open stage can complete.");
      next.openStage = null;
      next.completedStages.push(event.stage);
      return next;
    }
    case "candidate.frozen": {
      if (!plan.candidate.identity) throw invalidTransition("This plan is analysis-only and cannot freeze a candidate.");
      if (next.candidate) throw invalidTransition("A candidate is already frozen for this run.");
      const inPropose = next.openStage === "propose"
        || (next.openStage === null && next.completedStages[next.completedStages.length - 1] === "propose");
      if (!inPropose) throw invalidTransition("Candidates freeze during or directly after the propose stage.");
      if (!event.validation.packageValid || event.validation.scanBlocking || !event.validation.protectedDiffClean) {
        throw rejection("The candidate failed validation, scanning, or protected-content checks.", "IMPROVEMENT_CANDIDATE_UNSAFE", 422);
      }
      if (canonicalizeJson(event.identity) !== canonicalizeJson(plan.candidate.identity)) {
        throw bindingMismatch("The candidate identity differs from the planned release identity.");
      }
      if (event.treeSha256 === improvementPlanSourceTreeSha256(plan)) throw bindingMismatch("The candidate tree equals the source tree.");
      next.candidate = { treeSha256: event.treeSha256, fileCount: event.fileCount, identity: event.identity };
      return next;
    }
    case "evaluation.recorded": {
      if (next.openStage !== "evaluate" || !plan.suite) throw invalidTransition("Evaluations are recorded during the evaluate stage.");
      if (next.evaluations[event.subject]) throw invalidTransition(`A ${event.subject} evaluation is already recorded.`);
      const suite = plan.suite;
      if (event.suiteSha256 !== suite.suiteSha256) throw bindingMismatch("The evaluation suite digest differs from the plan.");
      if (event.cases.total !== suite.caseCount || event.protectedCases.total !== suite.protectedCaseCount
        || event.holdoutCases.total !== suite.holdoutCaseCount || event.repetitions !== suite.repetitions) {
        throw bindingMismatch("Evaluation case counts differ from the plan suite.");
      }
      if (event.observedModel !== null && !context.runner.capabilities.exactModelReadback) {
        throw rejection("The runner declared no exact model readback, so observedModel must be null.", "IMPROVEMENT_RUNNER_CAPABILITY_MISSING", 422, { missing: ["exactModelReadback"] });
      }
      if (event.subject === "baseline" && event.treeSha256 !== improvementPlanSourceTreeSha256(plan)) throw bindingMismatch("The baseline tree differs from the plan source.");
      if (event.subject === "candidate") {
        if (!next.candidate) throw invalidTransition("A candidate evaluation needs a frozen candidate.");
        if (event.treeSha256 !== next.candidate.treeSha256) throw bindingMismatch("The candidate evaluation tree differs from the frozen candidate.");
      }
      const { type: _type, ...evaluation } = event;
      next.evaluations[event.subject] = evaluation;
      return next;
    }
    case "run.completed": {
      if (next.openStage) throw invalidTransition("Close the open stage before completing the run.");
      if (!next.completedStages.includes("analyze")) throw invalidTransition("The analyze stage must complete first.");
      if (event.report.disposition === "candidate" && !next.candidate) throw invalidTransition("A candidate disposition needs a frozen candidate.");
      if (plan.resultSharing === "local-only" && (event.report.findings.length > 0 || event.report.configurationChanges.length > 0)) {
        throw rejection("Local-only plans keep findings and configuration changes on the device.", "IMPROVEMENT_DISCLOSURE_NOT_ALLOWED", 422);
      }
      const reviewerKeys = new Set(plan.reviewers.map((reviewer) => `${reviewer.slug}@${reviewer.version}`));
      if (event.report.findings.some((finding) => !reviewerKeys.has(`${finding.reviewer.slug}@${finding.reviewer.version}`))) {
        throw bindingMismatch("A finding cites a reviewer outside the plan.");
      }
      if (event.report.disposition === "candidate" && event.report.findings.some((finding) => finding.disposition === "open")) {
        throw rejection("Every finding needs a disposition when a candidate is reported.", "IMPROVEMENT_REPORT_INCOMPLETE", 422);
      }
      next.report = event.report;
      next.reportSha256 = improvementDigest(event.report);
      next.state = "completed";
      next.terminalReason = "completed";
      return next;
    }
    case "run.failed": {
      next.state = "failed";
      next.terminalReason = event.reason;
      next.openStage = null;
      return next;
    }
  }
}

export interface ImprovementEvaluationSummaryV1 {
  observedModel: ImprovementModelRefV1 | null;
  cases: ImprovementCaseCountsV1;
  protectedCases: { total: number; failed: number };
  holdoutCases: { total: number; passed: number };
  repetitions: number;
}

/** Shared, bounded result projection. No prompts, transcripts, file contents, or scores. */
export interface ImprovementEvidenceSummaryV1 {
  schemaVersion: 1;
  disclosure: Exclude<ImprovementDisclosure, "local-only">;
  profile: { profileId: string; revisionId: string; revisionNumber: number; target: ImprovementProfileTargetV1 };
  requestedModel: ImprovementModelRefV1;
  source: { treeSha256: string };
  candidate: ImprovementFrozenCandidateV1 | null;
  reviewers: ImprovementReviewerPinV1[];
  suite: Pick<ImprovementPlanSuiteV1, "suiteSha256" | "caseCount" | "protectedCaseCount" | "holdoutCaseCount" | "graders" | "repetitions"> | null;
  evaluations: { baseline: ImprovementEvaluationSummaryV1 | null; candidate: ImprovementEvaluationSummaryV1 | null };
  disposition: ImprovementReportDisposition;
  findingCounts: Record<(typeof improvementFindingSeverities)[number], number>;
  findings?: Array<Omit<ImprovementFindingV1, "reason">>;
  resources: ImprovementReportV1["resources"];
  minimumProvenance: ImprovementProvenance;
  completedAt: string;
}

export function buildImprovementEvidenceSummaryV1(input: {
  plan: ImprovementPlanV1;
  progress: ImprovementRunProgressV1;
  report: ImprovementReportV1;
  disclosure: Exclude<ImprovementDisclosure, "local-only">;
  completedAt: string;
}): ImprovementEvidenceSummaryV1 {
  const { plan, progress, report } = input;
  const findingCounts = { info: 0, low: 0, medium: 0, high: 0 };
  for (const finding of report.findings) findingCounts[finding.severity] += 1;
  const evaluation = (item: ImprovementEvaluationV1 | null): ImprovementEvaluationSummaryV1 | null => item
    ? { observedModel: item.observedModel, cases: item.cases, protectedCases: item.protectedCases, holdoutCases: item.holdoutCases, repetitions: item.repetitions }
    : null;
  return {
    schemaVersion: 1,
    disclosure: input.disclosure,
    profile: { profileId: plan.profile.profileId, revisionId: plan.profile.revisionId, revisionNumber: plan.profile.revisionNumber, target: plan.profile.target },
    requestedModel: { provider: plan.dataRoute.provider, id: plan.dataRoute.model },
    source: { treeSha256: improvementPlanSourceTreeSha256(plan) },
    candidate: progress.candidate,
    reviewers: plan.reviewers.map(({ slug, version, artifactSha256, roles }) => ({ slug, version, artifactSha256, roles })),
    suite: plan.suite
      ? {
        suiteSha256: plan.suite.suiteSha256,
        caseCount: plan.suite.caseCount,
        protectedCaseCount: plan.suite.protectedCaseCount,
        holdoutCaseCount: plan.suite.holdoutCaseCount,
        graders: plan.suite.graders,
        repetitions: plan.suite.repetitions,
      }
      : null,
    evaluations: { baseline: evaluation(progress.evaluations.baseline), candidate: evaluation(progress.evaluations.candidate) },
    disposition: report.disposition,
    findingCounts,
    ...(input.disclosure === "selected-evidence"
      ? { findings: report.findings.map(({ reason: _reason, ...finding }) => finding) }
      : {}),
    resources: report.resources,
    minimumProvenance: plan.policy.minimumProvenance,
    completedAt: input.completedAt,
  };
}

const MEASURED_PROVENANCE_FLOOR: ImprovementProvenance = "trusted-runner";

/**
 * Claims derive only from server-recorded evaluation events plus acceptance and provenance.
 * Holdout gains with zero protected failures are required before any improvement label.
 */
export function deriveImprovementEvidenceClaim(input: {
  subject: "baseline" | "candidate";
  summary: ImprovementEvidenceSummaryV1;
  provenance: ImprovementProvenance;
  accepted: boolean;
  relevance: "current" | "stale";
}): { claim: ImprovementEvidenceClaim; unmetConditions: string[] } {
  const { baseline, candidate } = input.summary.evaluations;
  if (input.subject === "baseline") {
    if (!baseline) return { claim: "static-findings-only", unmetConditions: ["evaluation-missing"] };
    if (baseline.cases.errored > 0) return { claim: "inconclusive", unmetConditions: ["errored-cases"] };
    return { claim: "tested-baseline", unmetConditions: [] };
  }
  if (!baseline && !candidate) return { claim: "static-findings-only", unmetConditions: ["evaluation-missing"] };
  if (!baseline || !candidate) return { claim: "inconclusive", unmetConditions: ["paired-baseline-missing"] };
  if (baseline.cases.errored > 0 || candidate.cases.errored > 0) return { claim: "inconclusive", unmetConditions: ["errored-cases"] };
  if (candidate.protectedCases.failed > baseline.protectedCases.failed
    || candidate.holdoutCases.passed < baseline.holdoutCases.passed
    || candidate.cases.passed < baseline.cases.passed) {
    return { claim: "regression", unmetConditions: [] };
  }
  if (candidate.protectedCases.failed > 0) return { claim: "inconclusive", unmetConditions: ["protected-failure"] };
  if (candidate.holdoutCases.total === 0) return { claim: "inconclusive", unmetConditions: ["holdout-missing"] };
  if (candidate.holdoutCases.passed <= baseline.holdoutCases.passed) return { claim: "no-improvement", unmetConditions: [] };

  const unmet: string[] = [];
  if (!input.accepted) unmet.push("evidence-not-accepted");
  if (improvementProvenanceRank(input.provenance) < improvementProvenanceRank(input.summary.minimumProvenance)) unmet.push("provenance-below-policy-minimum");
  if (improvementProvenanceRank(input.provenance) < improvementProvenanceRank(MEASURED_PROVENANCE_FLOOR)) unmet.push("provenance-below-measured-floor");
  if (input.relevance !== "current") unmet.push("evidence-stale");
  const requested = input.summary.requestedModel;
  const matches = (model: ImprovementModelRefV1 | null) => model !== null && model.provider === requested.provider && model.id === requested.id;
  if (!matches(baseline.observedModel) || !matches(candidate.observedModel)) unmet.push("model-identity-unverified");
  if (input.summary.suite?.graders.includes("model") && !hasIndependentEvaluator(input.summary.reviewers)) unmet.push("independent-evaluator-missing");
  return { claim: unmet.length === 0 ? "measured-improvement" : "locally-reported-improvement", unmetConditions: unmet };
}

/** Model grading needs an evaluate reviewer that is not also a candidate author. */
export function hasIndependentEvaluator(reviewers: readonly ImprovementReviewerPinV1[]): boolean {
  const proposers = new Set(reviewers.filter((pin) => pin.roles.includes("propose")).map(improvementPinKey));
  return reviewers.some((pin) => pin.roles.includes("evaluate") && !proposers.has(improvementPinKey(pin)));
}

/**
 * Canonical file-tree digest matching the MySkills artifact convention: SHA-256 of
 * JSON.stringify({ files }) with { path, content } entries sorted by path.localeCompare.
 * Paths must already be normalized relative POSIX paths.
 */
export function improvementTreeSha256(files: ReadonlyArray<{ path: string; content: string }>): string {
  const seen = new Set<string>();
  const normalized = files.map((file) => {
    if (typeof file.path !== "string" || typeof file.content !== "string") fail("Tree entries need string path and content.");
    if (file.path.length === 0 || file.path.startsWith("/") || file.path.includes("\\") || file.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail(`Tree path is not a normalized relative path: ${file.path}`);
    }
    if (seen.has(file.path)) fail(`Tree path collision: ${file.path}`);
    seen.add(file.path);
    return { path: file.path, content: file.content };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return sha256Hex(JSON.stringify({ files: normalized }));
}

export interface ReleaseCompatibilityRevisionV1 {
  id: string;
  revisionNumber: number;
  kind: "declaration" | "attestation";
  declaration: OptimizationDeclarationV1;
  declarationSha256: string;
  approvedAt: string;
  approvalBindingSha256: string;
  issuerUserId?: string;
  createdAt: string;
}

export interface ReleaseCompatibilityProjectionV1 {
  schemaVersion: 1;
  release: { slug: string; version: string; artifactSha256: string; published: boolean };
  declaration: {
    status: "unspecified" | "approved";
    revision: ReleaseCompatibilityRevisionV1 | null;
    targets: Array<{ target: OptimizationTargetV1; status: "designed-for-untested" | "tested" }>;
  };
  attestation: { status: "none" | "approved"; revision: ReleaseCompatibilityRevisionV1 | null };
  evidence: Array<{
    evidenceId: string;
    subject: "baseline" | "candidate";
    acceptedAt: string;
    provenance: ImprovementProvenance;
    profile: { profileId: string; revisionNumber: number; target: ImprovementProfileTargetV1 };
    relevance: "current" | "stale";
    suite: { caseCount: number; protectedCaseCount: number; holdoutCaseCount: number } | null;
    evaluation: { baseline: ImprovementEvaluationSummaryV1 | null; candidate: ImprovementEvaluationSummaryV1 | null };
    claim: ImprovementEvidenceClaim;
    unmetConditions: string[];
  }>;
  manage?: {
    pendingRevisions: Array<Record<string, unknown>>;
    evidenceProposals: Array<{ evidenceId: string; subject: "baseline" | "candidate"; createdAt: string }>;
  };
}

function normalizeSource(input: unknown): ImprovementReleaseSourceV1 | ImprovementLocalSourceV1 {
  const kind = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).kind : undefined;
  if (kind === "release") {
    const record = objectInput(input, "plan source", ["kind", "slug", "version", "artifactSha256"]);
    return { kind: "release", ...normalizeReleasePin(record, "plan source") };
  }
  if (kind === "local") {
    const record = objectInput(input, "plan source", ["kind", "treeSha256", "parent"]);
    return {
      kind: "local",
      treeSha256: sha256Field(record.treeSha256, "plan source treeSha256"),
      parent: record.parent === undefined || record.parent === null
        ? null
        : normalizeReleasePin(objectInput(record.parent, "plan source parent", ["slug", "version", "artifactSha256"]), "plan source parent"),
    };
  }
  return fail("plan source kind must be release or local.");
}

function normalizeReleasePin(record: Record<string, unknown>, field: string): ImprovementReleasePinV1 {
  return {
    slug: skillSlug(record.slug, `${field} slug`),
    version: skillVersion(record.version, `${field} version`),
    artifactSha256: sha256Field(record.artifactSha256, `${field} artifactSha256`),
  };
}

function normalizeCandidateIdentity(input: unknown): ImprovementCandidateIdentityV1 {
  const record = objectInput(input, "candidate identity", ["slug", "version", "visibility", "derivativeOf"]);
  const derivative = record.derivativeOf === undefined || record.derivativeOf === null
    ? null
    : objectInput(record.derivativeOf, "candidate derivativeOf", ["slug", "version"]);
  return {
    slug: skillSlug(record.slug, "candidate slug"),
    version: skillVersion(record.version, "candidate version"),
    visibility: enumValue(record.visibility, "candidate visibility", improvementCandidateVisibilities),
    derivativeOf: derivative
      ? { slug: skillSlug(derivative.slug, "candidate derivative slug"), version: skillVersion(derivative.version, "candidate derivative version") }
      : null,
  };
}

function normalizeGuidance(input: unknown, index: number): ImprovementGuidanceRefV1 {
  const record = objectInput(input, `plan guidance ${index + 1}`, ["publisher", "url", "retrievedAt", "sha256"]);
  if (typeof record.url !== "string" || record.url.length > 500 || !/^https:\/\/[^\s\u0000-\u001f\u007f]+$/.test(record.url)) {
    fail("guidance url must be an https URL of at most 500 characters.");
  }
  return {
    publisher: identifier(record.publisher, "guidance publisher"),
    url: record.url,
    retrievedAt: isoTimestamp(record.retrievedAt, "guidance retrievedAt"),
    sha256: sha256Field(record.sha256, "guidance sha256"),
  };
}

function normalizeEvaluation(record: Record<string, unknown>): ImprovementEvaluationV1 {
  const cases = objectInput(record.cases, "evaluation cases", ["total", "passed", "failed", "errored"]);
  const protectedCases = objectInput(record.protectedCases, "evaluation protectedCases", ["total", "failed"]);
  const holdoutCases = objectInput(record.holdoutCases, "evaluation holdoutCases", ["total", "passed"]);
  const counts: ImprovementCaseCountsV1 = {
    total: integerField(cases.total, "cases total", 0, 1_000),
    passed: integerField(cases.passed, "cases passed", 0, 1_000),
    failed: integerField(cases.failed, "cases failed", 0, 1_000),
    errored: integerField(cases.errored, "cases errored", 0, 1_000),
  };
  if (counts.passed + counts.failed + counts.errored !== counts.total) fail("evaluation case outcomes must sum to the total.");
  const protectedCounts = { total: integerField(protectedCases.total, "protected total", 0, 1_000), failed: integerField(protectedCases.failed, "protected failed", 0, 1_000) };
  const holdoutCounts = { total: integerField(holdoutCases.total, "holdout total", 0, 1_000), passed: integerField(holdoutCases.passed, "holdout passed", 0, 1_000) };
  if (protectedCounts.failed > protectedCounts.total || holdoutCounts.passed > holdoutCounts.total) fail("evaluation subset counts are inconsistent.");
  return {
    subject: enumValue(record.subject, "evaluation subject", ["baseline", "candidate"] as const),
    treeSha256: sha256Field(record.treeSha256, "evaluation treeSha256"),
    suiteSha256: sha256Field(record.suiteSha256, "evaluation suiteSha256"),
    observedModel: record.observedModel === null || record.observedModel === undefined ? null : normalizeImprovementModelRef(record.observedModel, "evaluation observedModel"),
    cases: counts,
    protectedCases: protectedCounts,
    holdoutCases: holdoutCounts,
    repetitions: integerField(record.repetitions, "evaluation repetitions", 1, 10),
  };
}

function scalarOrNull(value: unknown, field: string): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return safeText(value, field, 200, { allowEmpty: true });
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return fail(`${field} must be a scalar.`);
}

function nullableInteger(value: unknown, field: string, max: number): number | null {
  return value === undefined || value === null ? null : integerField(value, field, 0, max);
}

function rejection(message: string, code: string, statusCode: number, details?: unknown): ImprovementRunRejection {
  return new ImprovementRunRejection(message, code, statusCode, details);
}

function invalidTransition(message: string): ImprovementRunRejection {
  return rejection(message, "IMPROVEMENT_EVENT_INVALID_TRANSITION", 409);
}

function bindingMismatch(message: string): ImprovementRunRejection {
  return rejection(message, "IMPROVEMENT_BINDING_MISMATCH", 422);
}
