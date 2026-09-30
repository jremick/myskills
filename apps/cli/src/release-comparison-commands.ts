import { compareAuthorizedReleases } from "@myskills-app/skill-package";
import type { ParityCommandContext, ParityCommandInput } from "./parity-types.js";
export const releaseComparisonHelp = ["  skills compare <slug> <base-version> <target-version> --base-sha256 <digest> --target-sha256 <digest> [--json]"];
export async function runReleaseComparisonCommand(input: ParityCommandInput, context: ParityCommandContext): Promise<boolean> {
  if (input.command !== "skills" || input.args[0] !== "compare") return false;
  const [, slug, baseVersion, targetVersion] = input.args;
  const allowed = new Set(["base-sha256", "target-sha256", "api-url", "token", "json"]);
  if (input.args.length !== 4 || Object.keys(input.options).some(key => !allowed.has(key)) || typeof input.options["base-sha256"] !== "string" || typeof input.options["target-sha256"] !== "string") throw new Error("Comparison requires a skill, two exact versions and both SHA-256 pins.");
  const result = await compareAuthorizedReleases({ base: { slug: slug!, version: baseVersion!, artifactSha256: input.options["base-sha256"] }, target: { slug: slug!, version: targetVersion!, artifactSha256: input.options["target-sha256"] } }, (kind, pin) => {
    const root = `/v1/skills/${encodeURIComponent(pin.slug)}/releases/${encodeURIComponent(pin.version)}`;
    return context.request("GET", kind === "release" ? root : `${root}/bundle?sha256=${pin.artifactSha256}`, undefined, "required");
  });
  context.output(result); return true;
}
