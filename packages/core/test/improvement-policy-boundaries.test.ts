import assert from "node:assert/strict";
import test from "node:test";
import {
  composeImprovementPolicies,
  defaultImprovementPolicyLimitsV1,
  defaultImprovementPolicyV1,
  improvementNetworkModes,
  improvementPinKey,
  improvementRunnerMissingCapabilities,
  normalizeImprovementPolicyV1,
  normalizeImprovementTargetProfileV1,
  normalizeOptimizationDeclarationV1,
  optimizationTargetMatchesProfile,
  type EffectiveImprovementPolicyV1,
  type ImprovementConstraintReason,
  type ImprovementPolicyConstraintInput,
  type ImprovementReviewerRole,
  type ImprovementRunSelection,
  type ImprovementRunnerV1,
  type ImprovementScopeRef,
} from "../src/index.js";

// Deterministic boundary coverage for policy composition and declared-target matching. These run
// without providers so every role-set and ceiling combination can be compared exhaustively.

const sha = (character: string) => character.repeat(64);
const reviewer = { slug: "prompt-reviewer", version: "1.0.0", artifactSha256: sha("a") };
const organization: ImprovementScopeRef = { type: "organization", id: "org-1" };
const team: ImprovementScopeRef = { type: "team", id: "team-1" };
const reviewerOwner: ImprovementScopeRef = { type: "organization", id: "org-2" };
const allRoles: readonly ImprovementReviewerRole[] = ["analyze", "evaluate", "propose"];
const roleSets: ImprovementReviewerRole[][] = [];
for (let mask = 1; mask < 1 << allRoles.length; mask += 1) roleSets.push(allRoles.filter((_, index) => mask & (1 << index)));

function constraint(source: ImprovementScopeRef, policy: Record<string, unknown>, reason: ImprovementConstraintReason = "run-context"): ImprovementPolicyConstraintInput {
  return {
    source,
    reason,
    revisionId: `${source.type}-${source.id}-1`,
    revisionNumber: 1,
    policySha256: sha("f"),
    policy: normalizeImprovementPolicyV1({ schemaVersion: 1, ...policy }),
  };
}

function selection(overrides: Partial<ImprovementRunSelection> = {}): ImprovementRunSelection {
  return {
    reviewers: [{ ...reviewer, roles: ["analyze"] }],
    inference: "cloud",
    provider: "openai",
    model: "gpt-5.5",
    resultSharing: "local-only",
    budget: { maxModelCalls: 10, maxTokens: null, maxWallMinutes: 30 },
    expiresInMinutes: 60,
    maxCandidates: 1,
    objectives: [],
    ...overrides,
  };
}

function withBudget(budget: Partial<ImprovementRunSelection["budget"]>, overrides: Partial<ImprovementRunSelection> = {}): ImprovementRunSelection {
  const base = selection(overrides);
  return { ...base, budget: { ...base.budget, ...budget } };
}

function selecting(roles: ImprovementReviewerRole[]): ImprovementRunSelection {
  return selection({ reviewers: [{ ...reviewer, roles }] });
}

function binding(roles: ImprovementReviewerRole[], required = false) {
  return { ...reviewer, roles, required, parameters: {} };
}

function codes(result: EffectiveImprovementPolicyV1): string[] {
  return result.blockers.map((item) => item.code);
}

function sourcesOf(result: EffectiveImprovementPolicyV1, code: string): Array<string | null> {
  return result.blockers
    .filter((item) => item.code === code)
    .map((item) => (item.source ? `${item.source.type}:${item.source.id}` : null))
    .sort();
}

function subset<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.every((item) => right.includes(item));
}

function intersection<T>(left: readonly T[], right: readonly T[]): T[] {
  return left.filter((item) => right.includes(item));
}

function union(left: readonly ImprovementReviewerRole[], right: readonly ImprovementReviewerRole[]): ImprovementReviewerRole[] {
  return [...new Set([...left, ...right])].sort();
}

const label = (roles: readonly string[]) => `[${roles.join(",")}]`;

test("an unstored personal policy keeps product defaults when a resource policy is broader", () => {
  const personal: ImprovementPolicyConstraintInput = {
    source: { type: "user", id: "operator" }, reason: "run-context",
    revisionId: null, revisionNumber: 0, policySha256: null, policy: null,
  };
  const broadResource = constraint(organization, {
    maxDisclosure: "selected-evidence", limits: { maxWallMinutes: 600 },
  }, "subject-resource");
  const result = composeImprovementPolicies([personal, broadResource], selection({
    resultSharing: "selected-evidence", budget: { maxModelCalls: 10, maxTokens: null, maxWallMinutes: 121 },
  }));
  assert.equal(result.maxDisclosure, "summary");
  assert.equal(result.limits.maxWallMinutes, 120);
  assert.deepEqual(codes(result).sort(), ["BUDGET_EXCEEDS_POLICY", "DISCLOSURE_NOT_ALLOWED"]);
});

// ---- B1: token ceilings -------------------------------------------------------------------------

test("policy token ceilings are nullable, default to no ceiling, and keep strict validation", () => {
  assert.equal(defaultImprovementPolicyLimitsV1.maxTokens, null);
  assert.equal(defaultImprovementPolicyV1().limits.maxTokens, null);
  assert.equal(normalizeImprovementPolicyV1({ schemaVersion: 1, limits: {} }).limits.maxTokens, null);
  assert.equal(normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { maxTokens: null } }).limits.maxTokens, null);
  assert.equal(normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { maxTokens: 10_000 } }).limits.maxTokens, 10_000);
  for (const invalid of [0, -1, 1.5, "10000", 1_000_000_001, Number.POSITIVE_INFINITY, false]) {
    assert.throws(() => normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { maxTokens: invalid } }), /policy maxTokens/, String(invalid));
  }
  // Calls and wall time stay finite: only the token ceiling may be absent.
  assert.throws(() => normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { maxModelCalls: null } }), /policy maxModelCalls/);
  assert.throws(() => normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { maxWallMinutes: null } }), /policy maxWallMinutes/);
  assert.throws(() => normalizeImprovementPolicyV1({ schemaVersion: 1, limits: { tokenCeiling: 5 } }), /policy limits field is not accepted: tokenCeiling/);
});

test("without a token ceiling an unknown-token plan stays allowed", () => {
  const noPolicy = composeImprovementPolicies([], selection());
  assert.equal(noPolicy.status, "allowed", JSON.stringify(noPolicy.blockers));
  assert.equal(noPolicy.limits.maxTokens, null);

  const uncapped = composeImprovementPolicies([constraint(organization, { enabled: true })], selection());
  assert.equal(uncapped.status, "allowed", JSON.stringify(uncapped.blockers));
  assert.equal(uncapped.limits.maxTokens, null);

  const finitePlan = composeImprovementPolicies([constraint(organization, {})], withBudget({ maxTokens: 1_000_000_000 }));
  assert.equal(finitePlan.status, "allowed", JSON.stringify(finitePlan.blockers));
});

test("an explicit token ceiling rejects a null plan budget instead of reading it as zero", () => {
  const capped = [constraint(organization, { limits: { maxTokens: 10_000 } })];

  const unbounded = composeImprovementPolicies(capped, withBudget({ maxTokens: null }));
  assert.equal(unbounded.status, "blocked");
  assert.deepEqual(sourcesOf(unbounded, "BUDGET_EXCEEDS_POLICY"), ["organization:org-1"]);
  assert.equal(unbounded.limits.maxTokens, 10_000);

  const atCeiling = composeImprovementPolicies(capped, withBudget({ maxTokens: 10_000 }));
  assert.equal(atCeiling.status, "allowed", JSON.stringify(atCeiling.blockers));
  const smallest = composeImprovementPolicies(capped, withBudget({ maxTokens: 1 }));
  assert.equal(smallest.status, "allowed", JSON.stringify(smallest.blockers));
  const over = composeImprovementPolicies(capped, withBudget({ maxTokens: 10_001 }));
  assert.deepEqual(sourcesOf(over, "BUDGET_EXCEEDS_POLICY"), ["organization:org-1"]);
});

test("token ceilings compose by minimum and a null ceiling never loosens a finite one", () => {
  const cases: Array<{ name: string; policies: Array<[ImprovementScopeRef, number | null]>; ceiling: number | null; binding: string[] }> = [
    { name: "finite then null", policies: [[organization, 10_000], [team, null]], ceiling: 10_000, binding: ["organization:org-1"] },
    { name: "null then finite", policies: [[team, null], [organization, 10_000]], ceiling: 10_000, binding: ["organization:org-1"] },
    { name: "both finite", policies: [[organization, 10_000], [team, 5_000]], ceiling: 5_000, binding: ["team:team-1"] },
    { name: "both null", policies: [[organization, null], [team, null]], ceiling: null, binding: [] },
  ];
  for (const item of cases) {
    const inputs = item.policies.map(([source, maxTokens]) => constraint(source, { limits: { maxTokens } }));
    const unbounded = composeImprovementPolicies(inputs, withBudget({ maxTokens: null }));
    assert.equal(unbounded.limits.maxTokens, item.ceiling, item.name);
    if (item.ceiling === null) {
      assert.equal(unbounded.status, "allowed", `${item.name}: ${JSON.stringify(unbounded.blockers)}`);
      continue;
    }
    // Every finite ceiling that is present must reject the unbounded plan.
    const finiteSources = item.policies.filter(([, maxTokens]) => maxTokens !== null).map(([source]) => `${source.type}:${source.id}`).sort();
    assert.deepEqual(sourcesOf(unbounded, "BUDGET_EXCEEDS_POLICY"), finiteSources, item.name);
    const within = composeImprovementPolicies(inputs, withBudget({ maxTokens: item.ceiling }));
    assert.equal(within.status, "allowed", `${item.name}: ${JSON.stringify(within.blockers)}`);
    const over = composeImprovementPolicies(inputs, withBudget({ maxTokens: item.ceiling + 1 }));
    assert.deepEqual(sourcesOf(over, "BUDGET_EXCEEDS_POLICY"), item.binding, item.name);
  }
});

test("a finite token cap then requires a runner that declares token accounting", () => {
  const runner = (tokenAccounting: boolean): ImprovementRunnerV1 => ({
    adapter: "codex",
    adapterVersion: "1.0.0",
    coordinatorVersion: "1.0.0",
    capabilities: { structuredOutput: true, workspaceIsolation: true, networkRestriction: true, tokenAccounting, cancellation: true, exactModelReadback: false },
  });
  const dataRoute = { inference: "cloud" as const, provider: "openai", model: "gpt-5.5", contextCategories: ["subject-package" as const] };
  const capped = { dataRoute, budget: { maxModelCalls: 10, maxTokens: 10_000, maxWallMinutes: 30 } };
  assert.deepEqual(improvementRunnerMissingCapabilities(runner(false), capped), ["tokenAccounting"]);
  assert.deepEqual(improvementRunnerMissingCapabilities(runner(true), capped), []);
  assert.deepEqual(improvementRunnerMissingCapabilities(runner(false), { ...capped, budget: { ...capped.budget, maxTokens: null } }), []);
});

test("every numeric ceiling is checked against the final composed limits", () => {
  const scenarios: Array<{ name: string; inputs: ImprovementPolicyConstraintInput[] }> = [
    { name: "no policy", inputs: [] },
    { name: "wall time above the product default", inputs: [constraint(organization, { limits: { maxWallMinutes: 600 } })] },
    { name: "calls and plan lifetime", inputs: [constraint(organization, { limits: { maxModelCalls: 500, maxPlanTtlMinutes: 30 } })] },
    {
      name: "two policies with mixed ceilings",
      inputs: [
        constraint(organization, { limits: { maxWallMinutes: 600, maxTokens: 50_000 } }),
        constraint(team, { limits: { maxWallMinutes: 300, maxModelCalls: 50 } }),
      ],
    },
    { name: "token ceiling with an uncapped policy", inputs: [constraint(organization, { limits: { maxTokens: 1_000 } }), constraint(team, {})] },
  ];
  for (const { name, inputs } of scenarios) {
    const { limits } = composeImprovementPolicies(inputs, selection());
    const tokens = limits.maxTokens;
    const within = withBudget(
      { maxModelCalls: limits.maxModelCalls, maxTokens: tokens, maxWallMinutes: limits.maxWallMinutes },
      { expiresInMinutes: limits.maxPlanTtlMinutes, maxCandidates: limits.maxCandidates },
    );
    const atLimits = composeImprovementPolicies(inputs, within);
    assert.equal(atLimits.status, "allowed", `${name} at composed limits: ${JSON.stringify(atLimits.blockers)}`);
    assert.deepEqual(atLimits.limits, limits, name);

    const overruns: Array<[string, ImprovementRunSelection]> = [
      ["maxModelCalls", { ...within, budget: { ...within.budget, maxModelCalls: limits.maxModelCalls + 1 } }],
      ["maxWallMinutes", { ...within, budget: { ...within.budget, maxWallMinutes: limits.maxWallMinutes + 1 } }],
      ["maxPlanTtlMinutes", { ...within, expiresInMinutes: limits.maxPlanTtlMinutes + 1 }],
      ["maxCandidates", { ...within, maxCandidates: limits.maxCandidates + 1 }],
    ];
    if (tokens !== null) {
      overruns.push(["maxTokens", { ...within, budget: { ...within.budget, maxTokens: tokens + 1 } }]);
      overruns.push(["maxTokens null", { ...within, budget: { ...within.budget, maxTokens: null } }]);
    }
    for (const [field, overrun] of overruns) {
      const result = composeImprovementPolicies(inputs, overrun);
      assert.equal(result.status, "blocked", `${name}: ${field} above the composed limit must block`);
      assert.deepEqual([...new Set(codes(result))], ["BUDGET_EXCEEDS_POLICY"], `${name}: ${field}`);
    }
  }
});

test("explicit policy ceilings are reported as composed rather than silently replaced by product defaults", () => {
  const result = composeImprovementPolicies([constraint(organization, { limits: { maxWallMinutes: 600, maxAttempts: 5 } })], selection());
  assert.equal(result.limits.maxWallMinutes, 600);
  assert.equal(result.limits.maxAttempts, 5);
  assert.equal(result.limits.maxModelCalls, defaultImprovementPolicyLimitsV1.maxModelCalls);
  const tighter = composeImprovementPolicies([
    constraint(organization, { limits: { maxWallMinutes: 600, maxAttempts: 5 } }),
    constraint(team, { limits: { maxWallMinutes: 90, maxAttempts: 1 } }),
  ], selection());
  assert.equal(tighter.limits.maxWallMinutes, 90);
  assert.equal(tighter.limits.maxAttempts, 1);
});

// ---- B2: reviewer role authority ---------------------------------------------------------------

test("pin identity stays role-independent while exact pins still differ by artifact", () => {
  const analyzePin = { ...reviewer, roles: ["analyze"] };
  const evaluatePin = { ...reviewer, roles: ["evaluate", "propose"] };
  assert.equal(improvementPinKey(analyzePin), improvementPinKey(evaluatePin));
  assert.notEqual(improvementPinKey(analyzePin), improvementPinKey({ ...reviewer, artifactSha256: sha("b") }));
  assert.throws(
    () => normalizeImprovementPolicyV1({ schemaVersion: 1, reviewers: [binding(["analyze"]), binding(["evaluate"])] }),
    /policy reviewers must be unique/,
  );
  const designated = [constraint(organization, { reviewerAllowlist: "designated", reviewers: [binding(["analyze"])] })];
  const otherArtifact = composeImprovementPolicies(designated, selection({ reviewers: [{ ...reviewer, artifactSha256: sha("b"), roles: ["analyze"] }] }));
  assert.deepEqual(sourcesOf(otherArtifact, "REVIEWER_NOT_ALLOWED"), ["organization:org-1"]);
});

test("the reported reproduction: a designated analyze-only reviewer cannot become the candidate author", () => {
  const designated = [constraint(organization, { reviewerAllowlist: "designated", reviewers: [binding(["analyze"])] })];
  const author = composeImprovementPolicies(designated, selecting(["evaluate", "propose"]));
  assert.equal(author.status, "blocked");
  assert.deepEqual(sourcesOf(author, "REVIEWER_NOT_ALLOWED"), ["organization:org-1"]);

  const required = [constraint(organization, { reviewers: [binding(["evaluate"], true)] })];
  const wrongRole = composeImprovementPolicies(required, selecting(["analyze"]));
  assert.equal(wrongRole.status, "blocked");
  assert.deepEqual(sourcesOf(wrongRole, "REQUIRED_REVIEWER_MISSING"), ["organization:org-1"]);
});

test("designated selection is allowed only for roles within the binding (exhaustive)", () => {
  for (const designatedRoles of roleSets) {
    const inputs = [constraint(organization, { reviewerAllowlist: "designated", reviewers: [binding(designatedRoles)] })];
    for (const selectedRoles of roleSets) {
      const result = composeImprovementPolicies(inputs, selecting(selectedRoles));
      const name = `designated ${label(designatedRoles)} selected ${label(selectedRoles)}`;
      if (subset(selectedRoles, designatedRoles)) {
        assert.equal(result.status, "allowed", `${name}: ${JSON.stringify(result.blockers)}`);
      } else {
        assert.deepEqual(codes(result), ["REVIEWER_NOT_ALLOWED"], name);
      }
      assert.deepEqual(result.allowedReviewers, [{ ...reviewer, roles: designatedRoles }], name);
    }
  }
});

test("allowed roles intersect across designated scopes (exhaustive)", () => {
  for (const organizationRoles of roleSets) {
    for (const teamRoles of roleSets) {
      const inputs = [
        constraint(organization, { reviewerAllowlist: "designated", reviewers: [binding(organizationRoles)] }),
        constraint(team, { reviewerAllowlist: "designated", reviewers: [binding(teamRoles)] }),
      ];
      const allowed = intersection(organizationRoles, teamRoles);
      for (const selectedRoles of roleSets) {
        const name = `org ${label(organizationRoles)} team ${label(teamRoles)} selected ${label(selectedRoles)}`;
        const result = composeImprovementPolicies(inputs, selecting(selectedRoles));
        assert.deepEqual(result.allowedReviewers, allowed.length > 0 ? [{ ...reviewer, roles: allowed }] : [], name);
        const expectedSources = [
          ...(subset(selectedRoles, organizationRoles) ? [] : ["organization:org-1"]),
          ...(subset(selectedRoles, teamRoles) ? [] : ["team:team-1"]),
        ].sort();
        assert.deepEqual(sourcesOf(result, "REVIEWER_NOT_ALLOWED"), expectedSources, name);
        assert.equal(result.status, subset(selectedRoles, allowed) ? "allowed" : "blocked", name);
      }
    }
  }
});

test("required roles must all be selected (exhaustive)", () => {
  for (const requiredRoles of roleSets) {
    const inputs = [constraint(organization, { reviewers: [binding(requiredRoles, true)] })];
    for (const selectedRoles of roleSets) {
      const name = `required ${label(requiredRoles)} selected ${label(selectedRoles)}`;
      const result = composeImprovementPolicies(inputs, selecting(selectedRoles));
      assert.deepEqual(result.requiredReviewers, [{ ...reviewer, roles: requiredRoles }], name);
      if (subset(requiredRoles, selectedRoles)) {
        assert.equal(result.status, "allowed", `${name}: ${JSON.stringify(result.blockers)}`);
      } else {
        assert.deepEqual(codes(result), ["REQUIRED_REVIEWER_MISSING"], name);
      }
    }
  }
  const unselected = composeImprovementPolicies(
    [constraint(organization, { reviewers: [binding(["analyze"], true)] })],
    selection({ reviewers: [{ slug: "other-reviewer", version: "1.0.0", artifactSha256: sha("c"), roles: ["analyze"] }] }),
  );
  assert.deepEqual(codes(unselected), ["REQUIRED_REVIEWER_MISSING"]);
});

test("identical required pins union their roles across scopes (exhaustive)", () => {
  for (const organizationRoles of roleSets) {
    for (const teamRoles of roleSets) {
      const inputs = [
        constraint(organization, { reviewers: [binding(organizationRoles, true)] }),
        constraint(team, { reviewers: [binding(teamRoles, true)] }),
      ];
      const required = union(organizationRoles, teamRoles);
      for (const selectedRoles of roleSets) {
        const name = `org requires ${label(organizationRoles)} team requires ${label(teamRoles)} selected ${label(selectedRoles)}`;
        const result = composeImprovementPolicies(inputs, selecting(selectedRoles));
        assert.deepEqual(result.requiredReviewers, [{ ...reviewer, roles: required }], name);
        const expectedSources = [
          ...(subset(organizationRoles, selectedRoles) ? [] : ["organization:org-1"]),
          ...(subset(teamRoles, selectedRoles) ? [] : ["team:team-1"]),
        ].sort();
        assert.deepEqual(sourcesOf(result, "REQUIRED_REVIEWER_MISSING"), expectedSources, name);
        assert.equal(result.status, subset(required, selectedRoles) ? "allowed" : "blocked", name);
      }
    }
  }
});

test("required roles that designated scopes cannot allow are a policy conflict (exhaustive)", () => {
  for (const organizationRequired of roleSets) {
    for (const teamRequired of roleSets) {
      for (const designatedRoles of roleSets) {
        const inputs = [
          constraint(organization, { reviewers: [binding(organizationRequired, true)] }),
          constraint(team, { reviewers: [binding(teamRequired, true)] }),
          constraint(reviewerOwner, { reviewerAllowlist: "designated", reviewers: [binding(designatedRoles)] }, "reviewer-resource"),
        ];
        const required = union(organizationRequired, teamRequired);
        const name = `required ${label(required)} designated ${label(designatedRoles)}`;
        const result = composeImprovementPolicies(inputs, selecting(required));
        if (subset(required, designatedRoles)) {
          assert.equal(result.status, "allowed", `${name}: ${JSON.stringify(result.blockers)}`);
        } else {
          assert.deepEqual(sourcesOf(result, "POLICY_CONFLICT"), ["organization:org-2"], name);
          assert.equal(result.status, "blocked", name);
        }
      }
    }
  }
});

test("a required pin that a designated scope omits entirely is still a conflict", () => {
  const result = composeImprovementPolicies([
    constraint(organization, { reviewers: [binding(["analyze"], true)] }),
    constraint(reviewerOwner, {
      reviewerAllowlist: "designated",
      reviewers: [{ slug: "other-reviewer", version: "1.0.0", artifactSha256: sha("c"), roles: ["analyze"], required: false, parameters: {} }],
    }, "reviewer-resource"),
  ], selecting(["analyze"]));
  assert.deepEqual(sourcesOf(result, "POLICY_CONFLICT"), ["organization:org-2"]);
  assert.deepEqual(sourcesOf(result, "REVIEWER_NOT_ALLOWED"), ["organization:org-2"]);
});

test("a required binding inside a designated policy conflicts when another designated scope narrows its roles", () => {
  const result = composeImprovementPolicies([
    constraint(organization, { reviewerAllowlist: "designated", reviewers: [binding(["analyze", "evaluate"], true)] }),
    constraint(team, { reviewerAllowlist: "designated", reviewers: [binding(["evaluate", "propose"])] }),
  ], selecting(["analyze", "evaluate"]));
  assert.deepEqual(sourcesOf(result, "POLICY_CONFLICT"), ["team:team-1"]);
  assert.deepEqual(result.allowedReviewers, [{ ...reviewer, roles: ["evaluate"] }]);
  assert.deepEqual(result.requiredReviewers, [{ ...reviewer, roles: ["analyze", "evaluate"] }]);
});

// ---- B4: declared-target matcher ---------------------------------------------------------------

function declaredTarget(target: Record<string, unknown>) {
  const declaration = normalizeOptimizationDeclarationV1({ schemaVersion: 1, intent: "targeted", targets: [{ id: "target-1", ...target }] });
  return declaration.targets[0]!;
}

function profileTarget(environment: Record<string, unknown> = {}, model = { provider: "openai", id: "gpt-5.5" }) {
  return normalizeImprovementTargetProfileV1({
    schemaVersion: 1,
    name: "Profile",
    target: { model, app: { id: "codex", version: "1.0.0" }, environment },
  }).target;
}

test("the reported reproduction: a mismatched network and missing capability do not match a declared target", () => {
  const target = declaredTarget({ models: [{ provider: "openai", id: "gpt-5.5" }], environment: { network: "none", requiredCapabilities: ["shell"] } });
  assert.equal(optimizationTargetMatchesProfile(target, profileTarget({ network: "required" })), false);
  assert.equal(optimizationTargetMatchesProfile(target, profileTarget({ network: "none" })), false);
  assert.equal(optimizationTargetMatchesProfile(target, profileTarget({ network: "required", requiredCapabilities: ["shell"] })), false);
  assert.equal(optimizationTargetMatchesProfile(target, profileTarget({ network: "none", requiredCapabilities: ["shell"] })), true);
});

test("a declared network mode must equal the profile network mode (exhaustive)", () => {
  for (const declared of improvementNetworkModes) {
    for (const tested of improvementNetworkModes) {
      const target = declaredTarget({ environment: { network: declared } });
      assert.equal(optimizationTargetMatchesProfile(target, profileTarget({ network: tested })), declared === tested, `${declared} vs ${tested}`);
    }
  }
  // The profile's default network is optional.
  assert.equal(optimizationTargetMatchesProfile(declaredTarget({ environment: { network: "optional" } }), profileTarget()), true);
  assert.equal(optimizationTargetMatchesProfile(declaredTarget({ environment: { network: "none" } }), profileTarget()), false);
});

test("declared capabilities must be a subset of the profile capabilities (exhaustive)", () => {
  const capabilities = ["git", "shell", "workspace.read"];
  const sets: string[][] = [];
  for (let mask = 0; mask < 1 << capabilities.length; mask += 1) sets.push(capabilities.filter((_, index) => mask & (1 << index)));
  for (const declared of sets) {
    for (const tested of sets) {
      const target = declaredTarget({ environment: { requiredCapabilities: declared } });
      assert.equal(
        optimizationTargetMatchesProfile(target, profileTarget({ requiredCapabilities: tested })),
        subset(declared, tested),
        `declared ${label(declared)} tested ${label(tested)}`,
      );
    }
  }
});

test("absent dimensions do not restrict and existing dimensions still apply together", () => {
  const unconstrained = declaredTarget({});
  assert.equal(optimizationTargetMatchesProfile(unconstrained, profileTarget({ network: "none", requiredCapabilities: ["shell"], os: ["linux"] })), true);
  const osOnly = declaredTarget({ environment: { os: ["linux"] } });
  assert.equal(optimizationTargetMatchesProfile(osOnly, profileTarget({ network: "required", requiredCapabilities: ["shell"], os: ["linux"] })), true);
  assert.equal(optimizationTargetMatchesProfile(osOnly, profileTarget({ os: ["macos"] })), false);
  const tuple = declaredTarget({
    models: [{ provider: "openai", id: "gpt-5.5" }],
    apps: [{ id: "codex" }],
    environment: { os: ["linux"], requiredCapabilities: ["shell"], network: "none" },
  });
  const matching = { os: ["linux"], requiredCapabilities: ["shell", "git"], network: "none" };
  assert.equal(optimizationTargetMatchesProfile(tuple, profileTarget(matching)), true);
  assert.equal(optimizationTargetMatchesProfile(tuple, profileTarget(matching, { provider: "anthropic", id: "gpt-5.5" })), false);
  assert.equal(optimizationTargetMatchesProfile(tuple, profileTarget({ ...matching, os: ["linux", "windows"] })), false);
});
