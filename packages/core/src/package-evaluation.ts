import { arrayField, enumValue, fail, identifier, improvementDigest, objectInput, sha256Field } from "./improvement-shared.js";

export const packageEvaluationOutcomes = ["pass", "fail", "warning", "skipped", "incompatible"] as const;
export type PackageEvaluationOutcome = (typeof packageEvaluationOutcomes)[number];
export type PackageEvaluationAssertion =
  | { id: string; kind: "installability" | "compatibility" | "safety" | "behavior" }
  | { id: string; kind: "regression"; path: string; sha256: string };
export interface PackageEvaluationTarget { platform: string; context: "local" | "submission" | "release" }
export interface PackageEvaluationResult {
  schemaVersion: 1;
  artifactSha256: string;
  suiteSha256: string;
  target: PackageEvaluationTarget;
  runner: { id: "package-static"; version: "1" };
  provenance: "api-owned" | "self-reported";
  status: PackageEvaluationOutcome;
  totals: Record<PackageEvaluationOutcome, number>;
  assertions: Array<{ id: string; kind: PackageEvaluationAssertion["kind"]; scope: "static-package" | "provider-behavior"; outcome: PackageEvaluationOutcome; code: string }>;
}
export function normalizePackageEvaluationAssertions(input: unknown): PackageEvaluationAssertion[] {
  const assertions = arrayField(input, "suite assertions", 100, { minItems: 1 }).map(item => {
    const r = objectInput(item, "assertion", ["id", "kind", "path", "sha256"]);
    const id = identifier(r.id, "assertion id");
    const kind = enumValue(r.kind, "assertion kind", ["installability", "compatibility", "safety", "regression", "behavior"] as const);
    if (kind !== "regression") {
      if (r.path !== undefined || r.sha256 !== undefined) fail("Only regression assertions accept a file binding.");
      return { id, kind };
    }
    if (typeof r.path !== "string" || r.path.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(r.path)
      || r.path.split("/").some(p => !p || p === "." || p === "..")) fail("Regression path must be a bounded relative package path.");
    return { id, kind, path: r.path, sha256: sha256Field(r.sha256, "regression digest") };
  });
  if (new Set(assertions.map(a => a.id)).size !== assertions.length) fail("Assertion IDs must be unique.");
  return assertions;
}
export function packageEvaluationAssertionsDigest(assertions: PackageEvaluationAssertion[]) { return improvementDigest(normalizePackageEvaluationAssertions(assertions)); }
export function packageEvaluationRubricDigest() { return improvementDigest({ schemaVersion: 1, runner: "package-static/1", outcomes: packageEvaluationOutcomes }); }
/** Allow-list projection; callers cannot publish paths, task text, prompts or findings. */
export function packageEvaluationSummary(result: PackageEvaluationResult): Omit<PackageEvaluationResult, "assertions"> {
  return { schemaVersion: 1, artifactSha256: result.artifactSha256, suiteSha256: result.suiteSha256,
    target: { platform: result.target.platform, context: result.target.context }, runner: { id: result.runner.id, version: result.runner.version },
    provenance: result.provenance, status: result.status, totals: { pass: result.totals.pass, fail: result.totals.fail, warning: result.totals.warning, skipped: result.totals.skipped, incompatible: result.totals.incompatible } };
}
