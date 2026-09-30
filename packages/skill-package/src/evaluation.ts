import { createHash } from "node:crypto";
import { normalizeImprovementEvaluationSuiteV1, improvementDocumentDigest, packageEvaluationAssertionsDigest, packageEvaluationRubricDigest, type ImprovementEvaluationSuiteV1, type PackageEvaluationResult, type PackageEvaluationTarget, type PackageEvaluationOutcome } from "@myskills-app/core";
import { loadSkillManifestFromPackageFiles, normalizePackageFilePath, scanPackageFiles, validatePackageFiles, type PackageInputFile } from "./package-path.js";

export function defaultPackageEvaluationSuite(): ImprovementEvaluationSuiteV1 {
  const assertions = ["installability", "compatibility", "safety", "behavior"].map(kind => ({ id: kind, kind })) as NonNullable<ImprovementEvaluationSuiteV1["assertions"]>;
  return { schemaVersion: 1, name: "Package static checks", contentSha256: packageEvaluationAssertionsDigest(assertions), rubricSha256: packageEvaluationRubricDigest(), caseCount: assertions.length, protectedCaseCount: 0, holdoutCaseCount: 0, graders: ["deterministic"], repetitions: 1, assertions };
}
/** Same sorted immutable payload as API admission. No filesystem paths in results. */
export function packageEvaluationArtifactDigest(files: PackageInputFile[]): string {
  return createHash("sha256").update(JSON.stringify({ files: files.map(file=>({path:normalizePackageFilePath(file.path),content:file.content})).sort((a,b) => a.path.localeCompare(b.path)) })).digest("hex");
}
/** Pure deterministic evaluation; never executes package code, commands or providers. */
export function evaluatePackageFiles(input: { files: PackageInputFile[]; suite: ImprovementEvaluationSuiteV1; target: PackageEvaluationTarget; provenance: PackageEvaluationResult["provenance"] }): PackageEvaluationResult {
  const suite = normalizeImprovementEvaluationSuiteV1(input.suite);
  if (!suite.assertions) throw new Error("The suite has no package-static assertions.");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.target.platform) || !["local", "submission", "release"].includes(input.target.context)) throw new Error("Invalid evaluation target.");
  let manifest: ReturnType<typeof loadSkillManifestFromPackageFiles> | null = null;
  let valid = false;
  try { validatePackageFiles(input.files); manifest = loadSkillManifestFromPackageFiles(input.files); valid = true; } catch { /* Return bounded failure codes; no raw content/errors. */ }
  const scan = valid ? scanPackageFiles(input.files) : null;
  const assertions: PackageEvaluationResult["assertions"] = suite.assertions.map(assertion => {
    let outcome: PackageEvaluationOutcome = "pass";
    let code = "static_check_passed";
    switch (assertion.kind) {
      case "installability":
        if (!valid || !input.files.some(f => f.path === "SKILL.md" && f.content.trim())) { outcome = "fail"; code = "invalid_package"; }
        break;
      case "compatibility":
        if (!manifest?.platforms.some(p => p.name === input.target.platform && p.status === "supported")) { outcome = "incompatible"; code = "unsupported_platform"; }
        break;
      case "safety":
        if (!scan || scan.findings.some(f => f.severity === "blocking")) { outcome = "fail"; code = "blocking_scan"; }
        else if (scan.findings.length) { outcome = "warning"; code = "scan_warning"; }
        break;
      case "regression": {
        const file = input.files.find(f => f.path === assertion.path);
        if (!file || createHash("sha256").update(file.content).digest("hex") !== assertion.sha256) { outcome = "fail"; code = "file_digest_changed"; }
        break;
      }
      case "behavior": outcome = "skipped"; code = "provider_unconfigured"; break;
    }
    return { id: assertion.id, kind: assertion.kind, scope: assertion.kind === "behavior" ? "provider-behavior" : "static-package", outcome, code };
  });
  const totals = { pass: 0, fail: 0, warning: 0, skipped: 0, incompatible: 0 };
  for (const assertion of assertions) totals[assertion.outcome]++;
  const status = (["fail", "incompatible", "warning", "skipped", "pass"] as const).find(outcome => totals[outcome] > 0)!;
  return { schemaVersion: 1, artifactSha256: packageEvaluationArtifactDigest(input.files), suiteSha256: improvementDocumentDigest("suite", suite), target: input.target, runner: { id: "package-static", version: "1" }, provenance: input.provenance, status, totals, assertions };
}
