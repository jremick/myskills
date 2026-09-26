import {
  improvementObjectives,
  improvementNetworkModes,
  improvementOperatingSystems,
  normalizeImprovementModelRef,
  type ImprovementModelRefV1,
  type ImprovementNetworkMode,
  type ImprovementObjective,
  type ImprovementOperatingSystem,
} from "./improvement-declaration.js";
import {
  arrayField,
  booleanField,
  enumValue,
  fail,
  identifier,
  improvementDigest,
  integerField,
  objectInput,
  safeText,
  scalarRecord,
  schemaVersionOne,
  sha256Field,
  skillSlug,
  skillVersion,
  textArray,
  uniqueEnumArray,
  uniqueIdentifierArray,
} from "./improvement-shared.js";

export const improvementScopeTypes = ["user", "team", "organization"] as const;
export const improvementReviewerRoles = ["analyze", "propose", "evaluate"] as const;
export const improvementInferenceRoutes = ["cloud", "on-device"] as const;
export const improvementDisclosures = ["local-only", "summary", "selected-evidence"] as const;
export const improvementProvenances = ["local-report", "trusted-runner", "independently-reproduced"] as const;
export const improvementGraders = ["deterministic", "model", "human"] as const;
export const improvementConstraintReasons = [
  "run-context",
  "parent-organization",
  "subject-resource",
  "reviewer-resource",
  "profile-resource",
  "suite-resource",
] as const;

export type ImprovementScopeType = (typeof improvementScopeTypes)[number];
export type ImprovementReviewerRole = (typeof improvementReviewerRoles)[number];
export type ImprovementInferenceRoute = (typeof improvementInferenceRoutes)[number];
export type ImprovementDisclosure = (typeof improvementDisclosures)[number];
export type ImprovementProvenance = (typeof improvementProvenances)[number];
export type ImprovementGrader = (typeof improvementGraders)[number];
export type ImprovementConstraintReason = (typeof improvementConstraintReasons)[number];

export interface ImprovementScopeRef {
  type: ImprovementScopeType;
  id: string;
}

export interface ImprovementReviewerPinV1 {
  slug: string;
  version: string;
  artifactSha256: string;
  roles: ImprovementReviewerRole[];
}

export interface ImprovementReviewerBindingV1 extends ImprovementReviewerPinV1 {
  required: boolean;
  parameters: Record<string, string | number | boolean>;
}

export interface ImprovementInferenceRulesV1 {
  routes: ImprovementInferenceRoute[] | null;
  providers: string[] | null;
  models: string[] | null;
}

export interface ImprovementPolicyLimitsV1 {
  maxCandidates: 1;
  maxModelCalls: number;
  /** Null imposes no token ceiling. A finite ceiling requires every plan to name a finite token cap within it. */
  maxTokens: number | null;
  maxWallMinutes: number;
  maxPlanTtlMinutes: number;
  maxAttempts: number;
}

export interface ImprovementPolicyV1 {
  schemaVersion: 1;
  enabled: boolean;
  reviewers: ImprovementReviewerBindingV1[];
  reviewerAllowlist: "designated" | "any";
  inference: ImprovementInferenceRulesV1;
  requiredChecks: string[];
  protectedRequirements: string[];
  maxDisclosure: ImprovementDisclosure;
  limits: ImprovementPolicyLimitsV1;
  evidence: { minimumProvenance: ImprovementProvenance };
  defaults: { objectives: ImprovementObjective[] };
}

export const defaultImprovementPolicyLimitsV1: Readonly<ImprovementPolicyLimitsV1> = Object.freeze({
  maxCandidates: 1,
  maxModelCalls: 200,
  maxTokens: null,
  maxWallMinutes: 120,
  maxPlanTtlMinutes: 1_440,
  maxAttempts: 2,
});

export function defaultImprovementPolicyV1(): ImprovementPolicyV1 {
  return normalizeImprovementPolicyV1({ schemaVersion: 1 });
}

export function normalizeImprovementScopeRef(input: unknown, field = "scope"): ImprovementScopeRef {
  const record = objectInput(input, field, ["type", "id"]);
  return { type: enumValue(record.type, `${field} type`, improvementScopeTypes), id: identifier(record.id, `${field} id`) };
}

export function normalizeImprovementReviewerPinV1(input: unknown, field = "reviewer"): ImprovementReviewerPinV1 {
  const record = objectInput(input, field, ["slug", "version", "artifactSha256", "roles"]);
  return {
    slug: skillSlug(record.slug, `${field} slug`),
    version: skillVersion(record.version, `${field} version`),
    artifactSha256: sha256Field(record.artifactSha256, `${field} artifactSha256`),
    roles: uniqueEnumArray(record.roles, `${field} roles`, improvementReviewerRoles, 3, { minItems: 1 }),
  };
}

export function improvementPinKey(pin: Pick<ImprovementReviewerPinV1, "slug" | "version" | "artifactSha256">): string {
  return `${pin.slug}@${pin.version}#${pin.artifactSha256}`;
}

export function normalizeImprovementPolicyV1(input: unknown): ImprovementPolicyV1 {
  const record = objectInput(input, "policy", [
    "schemaVersion", "enabled", "reviewers", "reviewerAllowlist", "inference", "requiredChecks",
    "protectedRequirements", "maxDisclosure", "limits", "evidence", "defaults",
  ]);
  schemaVersionOne(record.schemaVersion, "policy");
  const reviewers = arrayField(record.reviewers ?? [], "policy reviewers", 16).map((item, index) => {
    const binding = objectInput(item, `policy reviewer ${index + 1}`, ["slug", "version", "artifactSha256", "roles", "required", "parameters"]);
    const { required, parameters, ...pinInput } = binding;
    return {
      ...normalizeImprovementReviewerPinV1(pinInput, `policy reviewer ${index + 1}`),
      required: required === undefined ? false : booleanField(required, "policy reviewer required"),
      parameters: scalarRecord(parameters ?? {}, "policy reviewer parameters", 16),
    };
  });
  if (new Set(reviewers.map(improvementPinKey)).size !== reviewers.length) fail("policy reviewers must be unique.");
  const inferenceInput = objectInput(record.inference ?? {}, "policy inference", ["routes", "providers", "models"]);
  const limitsInput = objectInput(record.limits ?? {}, "policy limits", Object.keys(defaultImprovementPolicyLimitsV1));
  const limits: ImprovementPolicyLimitsV1 = {
    maxCandidates: limitsInput.maxCandidates === undefined ? 1 : integerField(limitsInput.maxCandidates, "policy maxCandidates", 1, 1) as 1,
    maxModelCalls: optionalInteger(limitsInput.maxModelCalls, "policy maxModelCalls", 1, 100_000, defaultImprovementPolicyLimitsV1.maxModelCalls),
    maxTokens: limitsInput.maxTokens === undefined || limitsInput.maxTokens === null
      ? null
      : integerField(limitsInput.maxTokens, "policy maxTokens", 1, 1_000_000_000),
    maxWallMinutes: optionalInteger(limitsInput.maxWallMinutes, "policy maxWallMinutes", 1, 1_440, defaultImprovementPolicyLimitsV1.maxWallMinutes),
    maxPlanTtlMinutes: optionalInteger(limitsInput.maxPlanTtlMinutes, "policy maxPlanTtlMinutes", 5, 1_440, defaultImprovementPolicyLimitsV1.maxPlanTtlMinutes),
    maxAttempts: optionalInteger(limitsInput.maxAttempts, "policy maxAttempts", 1, 5, defaultImprovementPolicyLimitsV1.maxAttempts),
  };
  const evidenceInput = objectInput(record.evidence ?? {}, "policy evidence", ["minimumProvenance"]);
  const defaultsInput = objectInput(record.defaults ?? {}, "policy defaults", ["objectives"]);
  return {
    schemaVersion: 1,
    enabled: record.enabled === undefined ? true : booleanField(record.enabled, "policy enabled"),
    reviewers,
    reviewerAllowlist: record.reviewerAllowlist === undefined ? "any" : enumValue(record.reviewerAllowlist, "policy reviewerAllowlist", ["designated", "any"] as const),
    inference: {
      routes: nullableList(inferenceInput.routes, (value) => uniqueEnumArray(value, "policy inference routes", improvementInferenceRoutes, 2)),
      providers: nullableList(inferenceInput.providers, (value) => uniqueIdentifierArray(value, "policy inference providers", 32)),
      models: nullableList(inferenceInput.models, (value) => uniqueIdentifierArray(value, "policy inference models", 64)),
    },
    requiredChecks: uniqueIdentifierArray(record.requiredChecks ?? [], "policy requiredChecks", 32),
    protectedRequirements: textArray(record.protectedRequirements ?? [], "policy protectedRequirements", 32, 300),
    maxDisclosure: record.maxDisclosure === undefined ? "summary" : enumValue(record.maxDisclosure, "policy maxDisclosure", improvementDisclosures),
    limits,
    evidence: {
      minimumProvenance: evidenceInput.minimumProvenance === undefined
        ? "trusted-runner"
        : enumValue(evidenceInput.minimumProvenance, "policy minimumProvenance", improvementProvenances),
    },
    defaults: {
      objectives: uniqueEnumArray(defaultsInput.objectives ?? [], "policy default objectives", improvementObjectives, 8, { sort: false }),
    },
  };
}

export function improvementPolicyDigest(input: unknown): string {
  return improvementDigest(normalizeImprovementPolicyV1(input));
}

export interface ImprovementProfileTargetV1 {
  model: ImprovementModelRefV1;
  app: { id: string; version: string };
  environment: { os: ImprovementOperatingSystem[]; requiredCapabilities: string[]; network: ImprovementNetworkMode };
}

export interface ImprovementTargetProfileV1 {
  schemaVersion: 1;
  name: string;
  target: ImprovementProfileTargetV1;
  settings: Record<string, string | number | boolean>;
  objectives: ImprovementObjective[];
  protectedRequirements: string[];
}

export function normalizeImprovementTargetProfileV1(input: unknown): ImprovementTargetProfileV1 {
  const record = objectInput(input, "profile", ["schemaVersion", "name", "target", "settings", "objectives", "protectedRequirements"]);
  schemaVersionOne(record.schemaVersion, "profile");
  const target = objectInput(record.target, "profile target", ["model", "app", "environment"]);
  const app = objectInput(target.app, "profile app", ["id", "version"]);
  const environment = objectInput(target.environment ?? {}, "profile environment", ["os", "requiredCapabilities", "network"]);
  return {
    schemaVersion: 1,
    name: safeText(record.name, "profile name", 80),
    target: {
      model: normalizeImprovementModelRef(target.model, "profile model"),
      app: { id: identifier(app.id, "profile app id"), version: identifier(app.version, "profile app version") },
      environment: {
        os: uniqueEnumArray(environment.os ?? [], "profile os", improvementOperatingSystems, 3),
        requiredCapabilities: uniqueIdentifierArray(environment.requiredCapabilities ?? [], "profile requiredCapabilities", 32),
        network: environment.network === undefined ? "optional" : enumValue(environment.network, "profile network", improvementNetworkModes),
      },
    },
    settings: scalarRecord(record.settings ?? {}, "profile settings", 32),
    objectives: uniqueEnumArray(record.objectives ?? ["task-success"], "profile objectives", improvementObjectives, 8, { minItems: 1, sort: false }),
    protectedRequirements: textArray(record.protectedRequirements ?? [], "profile protectedRequirements", 32, 300),
  };
}

export interface ImprovementEvaluationSuiteV1 {
  schemaVersion: 1;
  name: string;
  contentSha256: string;
  rubricSha256: string;
  caseCount: number;
  protectedCaseCount: number;
  holdoutCaseCount: number;
  graders: ImprovementGrader[];
  repetitions: number;
}

export function normalizeImprovementEvaluationSuiteV1(input: unknown): ImprovementEvaluationSuiteV1 {
  const record = objectInput(input, "suite", [
    "schemaVersion", "name", "contentSha256", "rubricSha256", "caseCount", "protectedCaseCount", "holdoutCaseCount", "graders", "repetitions",
  ]);
  schemaVersionOne(record.schemaVersion, "suite");
  const caseCount = integerField(record.caseCount, "suite caseCount", 1, 1_000);
  const protectedCaseCount = integerField(record.protectedCaseCount ?? 0, "suite protectedCaseCount", 0, 1_000);
  const holdoutCaseCount = integerField(record.holdoutCaseCount ?? 0, "suite holdoutCaseCount", 0, 1_000);
  if (protectedCaseCount + holdoutCaseCount > caseCount) fail("suite protected and holdout cases cannot exceed caseCount.");
  return {
    schemaVersion: 1,
    name: safeText(record.name, "suite name", 80),
    contentSha256: sha256Field(record.contentSha256, "suite contentSha256"),
    rubricSha256: sha256Field(record.rubricSha256, "suite rubricSha256"),
    caseCount,
    protectedCaseCount,
    holdoutCaseCount,
    graders: uniqueEnumArray(record.graders, "suite graders", improvementGraders, 3, { minItems: 1 }),
    repetitions: integerField(record.repetitions ?? 1, "suite repetitions", 1, 10),
  };
}

export function improvementDocumentDigest(kind: "profile" | "suite", body: unknown): string {
  return improvementDigest(kind === "profile" ? normalizeImprovementTargetProfileV1(body) : normalizeImprovementEvaluationSuiteV1(body));
}

export interface ImprovementPolicyBlocker {
  code: string;
  source: ImprovementScopeRef | null;
  message: string;
}

export interface ImprovementPolicyConstraintV1 {
  source: ImprovementScopeRef;
  reason: ImprovementConstraintReason;
  revisionId: string | null;
  revisionNumber: number;
  policySha256: string | null;
}

export interface EffectiveImprovementPolicyV1 {
  schemaVersion: 1;
  status: "allowed" | "blocked";
  blockers: ImprovementPolicyBlocker[];
  warnings: ImprovementPolicyBlocker[];
  constraints: ImprovementPolicyConstraintV1[];
  requiredReviewers: ImprovementReviewerPinV1[];
  allowedReviewers: ImprovementReviewerPinV1[] | null;
  inference: ImprovementInferenceRulesV1;
  requiredChecks: string[];
  protectedRequirements: string[];
  maxDisclosure: ImprovementDisclosure;
  limits: ImprovementPolicyLimitsV1;
  minimumProvenance: ImprovementProvenance;
  defaults: { objectives: ImprovementObjective[] };
  localConsent: "required";
}

export interface ImprovementPolicyConstraintInput extends ImprovementPolicyConstraintV1 {
  /** Null when the scope has no stored policy. */
  policy: ImprovementPolicyV1 | null;
}

export interface ImprovementRunSelection {
  reviewers: ImprovementReviewerPinV1[];
  inference: ImprovementInferenceRoute;
  provider: string;
  model: string;
  resultSharing: ImprovementDisclosure;
  budget: { maxModelCalls: number; maxTokens: number | null; maxWallMinutes: number };
  expiresInMinutes: number;
  maxCandidates: number;
  objectives: ImprovementObjective[];
}

const reasonPriority: Record<ImprovementConstraintReason, number> = {
  "run-context": 0,
  "parent-organization": 1,
  "subject-resource": 2,
  "reviewer-resource": 3,
  "profile-resource": 4,
  "suite-resource": 5,
};

/**
 * Compose every applicable hard policy restrictively. Allowlists intersect, requirements union,
 * ceilings take the minimum, and any contradiction blocks instead of merging permissions.
 * Reviewer pins match by exact identity; their roles compose separately (allowed roles intersect,
 * required roles union). A null token ceiling imposes none; any finite one binds.
 * User-context scopes without a stored policy contribute the product default; every other scope
 * without an enabled policy blocks.
 */
export function composeImprovementPolicies(
  inputs: readonly ImprovementPolicyConstraintInput[],
  selection: ImprovementRunSelection,
  extraBlockers: readonly ImprovementPolicyBlocker[] = [],
): EffectiveImprovementPolicyV1 {
  const constraints = dedupeConstraints(inputs);
  const blockers: ImprovementPolicyBlocker[] = [...extraBlockers];
  const warnings: ImprovementPolicyBlocker[] = [];
  const policies: Array<{ source: ImprovementScopeRef; policy: ImprovementPolicyV1 }> = [];
  for (const constraint of constraints) {
    if (!constraint.policy) {
      if (constraint.source.type === "user" && constraint.reason === "run-context") {
        policies.push({ source: constraint.source, policy: defaultImprovementPolicyV1() });
        continue;
      }
      const resource = constraint.reason !== "run-context" && constraint.reason !== "parent-organization";
      blockers.push({
        code: resource ? "RESOURCE_POLICY_MISSING" : "POLICY_MISSING",
        source: constraint.source,
        message: resource
          ? "A resource owner has not designated an improvement policy for this input."
          : "This context has no designated improvement policy.",
      });
      continue;
    }
    if (!constraint.policy.enabled) {
      blockers.push({ code: "POLICY_DISABLED", source: constraint.source, message: "Improvement runs are disabled by this policy." });
    }
    policies.push({ source: constraint.source, policy: constraint.policy });
  }

  const selected = new Map(selection.reviewers.map((pin) => [improvementPinKey(pin), pin]));
  const designatedPolicies = policies.filter(({ policy }) => policy.reviewerAllowlist === "designated");
  let allowedReviewers: ImprovementReviewerPinV1[] | null = null;
  for (const { source, policy } of designatedPolicies) {
    const designated = new Map(policy.reviewers.map((item) => [improvementPinKey(item), item]));
    allowedReviewers = (allowedReviewers ?? policy.reviewers.map(pinOnly))
      .map((pin) => ({ ...pin, roles: pin.roles.filter((role) => designated.get(improvementPinKey(pin))?.roles.includes(role)) }))
      .filter((pin) => pin.roles.length > 0);
    if (selection.reviewers.some((pin) => !designated.has(improvementPinKey(pin)))) {
      blockers.push({ code: "REVIEWER_NOT_ALLOWED", source, message: "A selected reviewer is not designated by this policy." });
    }
    for (const pin of selection.reviewers) {
      const allowed = designated.get(improvementPinKey(pin));
      if (allowed && !includesAll(allowed.roles, pin.roles)) {
        blockers.push({ code: "REVIEWER_NOT_ALLOWED", source, message: `Reviewer ${pin.slug}@${pin.version} is selected for a role this policy does not designate.` });
      }
    }
  }
  const requiredReviewers: ImprovementReviewerPinV1[] = [];
  for (const { source, policy } of policies) {
    for (const binding of policy.reviewers.filter((item) => item.required)) {
      const existing = requiredReviewers.find((pin) => improvementPinKey(pin) === improvementPinKey(binding));
      if (existing) existing.roles = unionRoles(existing.roles, binding.roles);
      else requiredReviewers.push(pinOnly(binding));
      const chosen = selected.get(improvementPinKey(binding));
      if (!chosen) {
        blockers.push({ code: "REQUIRED_REVIEWER_MISSING", source, message: `Required reviewer ${binding.slug}@${binding.version} is missing.` });
      } else if (!includesAll(chosen.roles, binding.roles)) {
        blockers.push({
          code: "REQUIRED_REVIEWER_MISSING",
          source,
          message: `Required reviewer ${binding.slug}@${binding.version} must be selected with roles ${binding.roles.join(", ")}.`,
        });
      }
    }
  }
  for (const required of requiredReviewers) {
    for (const { source, policy } of designatedPolicies) {
      const allowed = policy.reviewers.find((item) => improvementPinKey(item) === improvementPinKey(required));
      if (!allowed) {
        blockers.push({ code: "POLICY_CONFLICT", source, message: `Required reviewer ${required.slug}@${required.version} is not allowed by this policy.` });
      } else if (!includesAll(allowed.roles, required.roles)) {
        blockers.push({ code: "POLICY_CONFLICT", source, message: `Required roles for reviewer ${required.slug}@${required.version} are not all allowed by this policy.` });
      }
    }
  }

  const inference: ImprovementInferenceRulesV1 = { routes: null, providers: null, models: null };
  for (const { source, policy } of policies) {
    inference.routes = intersect(inference.routes, policy.inference.routes);
    inference.providers = intersect(inference.providers, policy.inference.providers);
    inference.models = intersect(inference.models, policy.inference.models);
    const routeAllowed = !policy.inference.routes || policy.inference.routes.includes(selection.inference);
    const providerAllowed = !policy.inference.providers || policy.inference.providers.includes(selection.provider);
    const modelAllowed = !policy.inference.models || policy.inference.models.includes(selection.model);
    if (!routeAllowed || !providerAllowed || !modelAllowed) {
      blockers.push({ code: "INFERENCE_ROUTE_BLOCKED", source, message: "The selected inference route, provider, or model is not allowed by this policy." });
    }
  }

  const defaults = defaultImprovementPolicyV1();
  let maxDisclosure: ImprovementDisclosure = policies.length === 0 ? defaults.maxDisclosure : "selected-evidence";
  let minimumProvenance: ImprovementProvenance = policies.length === 0 ? defaults.evidence.minimumProvenance : "local-report";
  const limits = composeLimits(policies.map(({ policy }) => policy.limits));
  const requiredChecks = new Set<string>();
  const protectedRequirements = new Set<string>();
  for (const { source, policy } of policies) {
    maxDisclosure = minRank(improvementDisclosures, maxDisclosure, policy.maxDisclosure);
    minimumProvenance = maxRank(improvementProvenances, minimumProvenance, policy.evidence.minimumProvenance);
    for (const check of policy.requiredChecks) requiredChecks.add(check);
    for (const requirement of policy.protectedRequirements) protectedRequirements.add(requirement);
    if (rank(improvementDisclosures, selection.resultSharing) > rank(improvementDisclosures, policy.maxDisclosure)) {
      blockers.push({ code: "DISCLOSURE_NOT_ALLOWED", source, message: "The selected result sharing exceeds this policy's disclosure ceiling." });
    }
  }
  if (policies.length === 0 && rank(improvementDisclosures, selection.resultSharing) > rank(improvementDisclosures, maxDisclosure)) {
    blockers.push({ code: "DISCLOSURE_NOT_ALLOWED", source: null, message: "The selected result sharing exceeds the product default." });
  }
  // One check against the final composed ceilings; each policy that sets an exceeded ceiling is named.
  if (exceedsLimits(selection, limits)) {
    const exceeded = policies.filter(({ policy }) => exceedsLimits(selection, policy.limits));
    if (exceeded.length === 0) {
      blockers.push({ code: "BUDGET_EXCEEDS_POLICY", source: null, message: "The selected budget exceeds the product default limits." });
    }
    for (const { source } of exceeded) {
      blockers.push({
        code: "BUDGET_EXCEEDS_POLICY",
        source,
        message: "The selected budget or plan lifetime exceeds this policy's limits, or leaves tokens uncapped under its token ceiling.",
      });
    }
  }

  const objectives = selection.objectives.length > 0 ? selection.objectives : defaultObjectives(constraints);
  return {
    schemaVersion: 1,
    status: blockers.length > 0 ? "blocked" : "allowed",
    blockers: sortIssues(blockers),
    warnings: sortIssues(warnings),
    constraints: constraints.map(({ policy: _policy, ...constraint }) => constraint),
    requiredReviewers,
    allowedReviewers,
    inference,
    requiredChecks: [...requiredChecks].sort(),
    protectedRequirements: [...protectedRequirements].sort(),
    maxDisclosure,
    limits,
    minimumProvenance,
    defaults: { objectives },
    localConsent: "required",
  };
}

export function improvementProvenanceRank(value: ImprovementProvenance): number {
  return rank(improvementProvenances, value);
}

export function improvementDisclosureRank(value: ImprovementDisclosure): number {
  return rank(improvementDisclosures, value);
}

function defaultObjectives(constraints: ImprovementPolicyConstraintInput[]): ImprovementObjective[] {
  // Run choice first (handled by caller), then selected team, organization, user, product default.
  const order: ImprovementScopeType[] = ["team", "organization", "user"];
  for (const type of order) {
    const match = constraints.find((item) => item.source.type === type && (item.reason === "run-context" || item.reason === "parent-organization")
      && item.policy && item.policy.defaults.objectives.length > 0);
    if (match?.policy) return match.policy.defaults.objectives;
  }
  return ["task-success"];
}

function dedupeConstraints(inputs: readonly ImprovementPolicyConstraintInput[]): ImprovementPolicyConstraintInput[] {
  const byScope = new Map<string, ImprovementPolicyConstraintInput>();
  for (const input of inputs) {
    const key = `${input.source.type}:${input.source.id}`;
    const existing = byScope.get(key);
    if (!existing || reasonPriority[input.reason] < reasonPriority[existing.reason]) byScope.set(key, input);
  }
  return [...byScope.values()].sort((left, right) => `${left.source.type}:${left.source.id}`.localeCompare(`${right.source.type}:${right.source.id}`));
}

function pinOnly(binding: ImprovementReviewerPinV1): ImprovementReviewerPinV1 {
  return { slug: binding.slug, version: binding.version, artifactSha256: binding.artifactSha256, roles: [...binding.roles] };
}

function includesAll<T>(available: readonly T[], wanted: readonly T[]): boolean {
  return wanted.every((item) => available.includes(item));
}

function unionRoles(left: readonly ImprovementReviewerRole[], right: readonly ImprovementReviewerRole[]): ImprovementReviewerRole[] {
  return [...new Set([...left, ...right])].sort();
}

/**
 * Most restrictive ceilings across the applicable policies. Each normalized policy already carries
 * the product default for any limit it leaves unset, so product defaults apply directly only when
 * no policy does. A null token ceiling imposes none.
 */
function composeLimits(all: readonly ImprovementPolicyLimitsV1[]): ImprovementPolicyLimitsV1 {
  if (all.length === 0) return { ...defaultImprovementPolicyLimitsV1 };
  const finiteTokens = all.map((item) => item.maxTokens).filter((value): value is number => value !== null);
  return {
    maxCandidates: 1,
    maxModelCalls: Math.min(...all.map((item) => item.maxModelCalls)),
    maxTokens: finiteTokens.length === 0 ? null : Math.min(...finiteTokens),
    maxWallMinutes: Math.min(...all.map((item) => item.maxWallMinutes)),
    maxPlanTtlMinutes: Math.min(...all.map((item) => item.maxPlanTtlMinutes)),
    maxAttempts: Math.min(...all.map((item) => item.maxAttempts)),
  };
}

function exceedsLimits(selection: ImprovementRunSelection, limits: ImprovementPolicyLimitsV1): boolean {
  return selection.budget.maxModelCalls > limits.maxModelCalls
    || !withinTokenCeiling(selection.budget.maxTokens, limits.maxTokens)
    || selection.budget.maxWallMinutes > limits.maxWallMinutes
    || selection.expiresInMinutes > limits.maxPlanTtlMinutes
    || selection.maxCandidates > limits.maxCandidates;
}

/** A null plan cap means unbounded, never zero, so it fits only when there is no ceiling. */
function withinTokenCeiling(requested: number | null, ceiling: number | null): boolean {
  return ceiling === null || (requested !== null && requested <= ceiling);
}

function intersect<T extends string>(current: T[] | null, next: T[] | null): T[] | null {
  if (next === null) return current;
  if (current === null) return [...next];
  return current.filter((item) => next.includes(item));
}

function nullableList<T>(value: unknown, parse: (value: unknown) => T[]): T[] | null {
  return value === undefined || value === null ? null : parse(value);
}

function optionalInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : integerField(value, field, min, max);
}

function rank<T extends string>(values: readonly T[], value: T): number {
  return values.indexOf(value);
}

function minRank<T extends string>(values: readonly T[], left: T, right: T): T {
  return rank(values, left) <= rank(values, right) ? left : right;
}

function maxRank<T extends string>(values: readonly T[], left: T, right: T): T {
  return rank(values, left) >= rank(values, right) ? left : right;
}

function sortIssues(issues: ImprovementPolicyBlocker[]): ImprovementPolicyBlocker[] {
  const seen = new Set<string>();
  return issues
    .filter((issue) => {
      const key = `${issue.code}:${issue.source?.type ?? ""}:${issue.source?.id ?? ""}:${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.code.localeCompare(right.code)
      || `${left.source?.type ?? ""}:${left.source?.id ?? ""}`.localeCompare(`${right.source?.type ?? ""}:${right.source?.id ?? ""}`));
}
