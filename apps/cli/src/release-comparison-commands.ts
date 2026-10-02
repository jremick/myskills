import { compareAuthorizedReleases, compareAuthorizedReviewCandidate } from "@myskills-app/skill-package";
import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";
export const releaseComparisonHelp = ["  skills compare <slug> <base-version> <target-version> --base-sha256 <digest> --target-sha256 <digest> [--json]", "  review compare <submission-id> <slug> <base-version> <candidate-version> --base-sha256 <digest> --target-sha256 <digest> [--json]"];
export async function runReleaseComparisonCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  if (!["skills", "review"].includes(input.command ?? "") || input.args[0] !== "compare") return false;
  const review = input.command === "review";
  const [slug, baseVersion, targetVersion] = input.args.slice(review ? 2 : 1);
  const allowed = new Set(["base-sha256", "target-sha256", "api-url", "token", "json"]);
  if (input.args.length !== (review ? 5 : 4) || Object.keys(input.options).some(key => !allowed.has(key)) || typeof input.options["base-sha256"] !== "string" || typeof input.options["target-sha256"] !== "string") throw new Error("Comparison requires a skill, two exact versions and both SHA-256 pins.");
  const pins = { base: { slug: slug!, version: baseVersion!, artifactSha256: input.options["base-sha256"] }, target: { slug: slug!, version: targetVersion!, artifactSha256: input.options["target-sha256"] } };
  const read = (kind: string, pin: typeof pins.base & { submissionId?: string }) => {
    if (kind === "review" || kind === "review-bundle") return context.request("GET", `/v1/review/submissions/${encodeURIComponent(pin.submissionId!)}${kind === "review-bundle" ? "/bundle" : ""}`, undefined, "required");
    const root = `/v1/skills/${encodeURIComponent(pin.slug)}/releases/${encodeURIComponent(pin.version)}`;
    return context.request("GET", kind === "release" ? root : `${root}/bundle?sha256=${pin.artifactSha256}`, undefined, "required");
  };
  const result = review ? await compareAuthorizedReviewCandidate({ ...pins, target: { ...pins.target, submissionId: input.args[1]! } }, read) : await compareAuthorizedReleases(pins, read);
  context.output(result); return true;
}
