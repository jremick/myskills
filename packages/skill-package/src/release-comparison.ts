import { createHash } from "node:crypto";
import { parseSemanticVersion } from "@myskills-app/core";
import { DEFAULT_MANIFEST_NAMES, validatePackageFiles } from "./package-path.js";
import type { PackageInputFile } from "./package-path.js";

export interface ReleaseComparisonPin { slug: string; version: string; artifactSha256: string }
export interface ReleaseComparisonInput { base: ReleaseComparisonPin; target: ReleaseComparisonPin }
export interface ReviewComparisonInput { base: ReleaseComparisonPin; target: ReleaseComparisonPin & { submissionId: string } }
export type ReviewComparisonRead = (kind: "release" | "bundle" | "review" | "review-bundle", pin: ReleaseComparisonPin & { submissionId?: string }) => Promise<Record<string, unknown>>;
export type ReleaseComparisonRead = (kind: "release" | "bundle", pin: ReleaseComparisonPin) => Promise<Record<string, unknown>>;
const invalid = () => new Error("Release comparison requires two readable published exact releases with matching identities and SHA-256 bytes.");
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

export function validateReleaseComparisonInput(input: ReleaseComparisonInput): void {
  for (const pin of [input.base, input.target]) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pin.slug) || pin.version.length > 64 || !parseSemanticVersion(pin.version) || !/^[a-f0-9]{64}$/.test(pin.artifactSha256)) throw invalid();
  }
  if (input.base.slug !== input.target.slug || input.base.version === input.target.version) throw invalid();
}
function releaseBytes(value: Record<string, unknown>, pin: ReleaseComparisonPin): number {
  const release = value.release as Record<string, unknown> | undefined;
  const artifact = release?.artifact as Record<string, unknown> | undefined;
  if (!release || release.slug !== pin.slug || release.version !== pin.version || release.reviewStatus !== "approved"
    || !["approved", "deprecated"].includes(String(release.lifecycleStatus)) || typeof release.publishedAt !== "string" || !Number.isFinite(Date.parse(release.publishedAt))
    || artifact?.sha256 !== pin.artifactSha256 || !Number.isSafeInteger(artifact?.byteSize) || Number(artifact?.byteSize) < 1) throw invalid();
  return Number(artifact.byteSize);
}
function files(value: Record<string, unknown>, pin: ReleaseComparisonPin, byteSize: number): PackageInputFile[] {
  if (Object.keys(value).length !== 1 || !Array.isArray(value.files)) throw invalid();
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) !== byteSize || digest(body) !== pin.artifactSha256) throw invalid();
  try { validatePackageFiles(value.files as PackageInputFile[]); } catch { throw invalid(); }
  const list = value.files as PackageInputFile[];
  // Identity is checked separately from integrity: a correctly hashed foreign package is still invalid.
  const manifests = list.filter(file => (DEFAULT_MANIFEST_NAMES as readonly string[]).includes(file.path));
  let manifest: Record<string, unknown> | null = null;
  try { if (manifests.length === 1) manifest = JSON.parse(manifests[0]!.content); } catch { /* Reject without echoing content. */ }
  if (!manifest || manifest.name !== pin.slug || manifest.version !== pin.version) throw invalid();
  return list;
}
/** Compose existing API reads. Full content determines status; bounded previews never determine equality. */
export async function compareAuthorizedReleases(input: ReleaseComparisonInput, read: ReleaseComparisonRead) {
  validateReleaseComparisonInput(input);
  const baseBytes = releaseBytes(await read("release", input.base), input.base);
  const targetBytes = releaseBytes(await read("release", input.target), input.target);
  const baseFiles = files(await read("bundle", input.base), input.base, baseBytes);
  const targetFiles = files(await read("bundle", input.target), input.target, targetBytes);
  // Every call uses API-owned authorization. A management metadata read never replaces bundle access.
  if (releaseBytes(await read("release", input.base), input.base) !== baseBytes || releaseBytes(await read("release", input.target), input.target) !== targetBytes) throw invalid();
  return comparisonResult(input, baseFiles, targetFiles, baseBytes, targetBytes);
}

/** Review authority applies only to the candidate; the baseline still needs published-release read access. */
export async function compareAuthorizedReviewCandidate(input: ReviewComparisonInput, read: ReviewComparisonRead) {
  validateReleaseComparisonInput(input);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.target.submissionId)) throw invalid();
  const review = (value: Record<string, unknown>) => {
    const row = value.submission as Record<string, unknown> | undefined;
    if (!row || row.id !== input.target.submissionId || row.slug !== input.target.slug || row.version !== input.target.version) throw invalid();
  };
  const baseBytes = releaseBytes(await read("release", input.base), input.base);
  review(await read("review", input.target));
  const baseFiles = files(await read("bundle", input.base), input.base, baseBytes);
  const candidate = await read("review-bundle", input.target);
  const targetBytes = Buffer.byteLength(JSON.stringify(candidate));
  const targetFiles = files(candidate, input.target, targetBytes);
  if (releaseBytes(await read("release", input.base), input.base) !== baseBytes) throw invalid();
  review(await read("review", input.target));
  // The final verified export also rechecks current reviewer credential/role/MFA authority.
  files(await read("review-bundle", input.target), input.target, targetBytes);
  return { ...comparisonResult(input, baseFiles, targetFiles, baseBytes, targetBytes), context: "review-candidate", submissionId: input.target.submissionId };
}

function comparisonResult(input: ReleaseComparisonInput, baseFiles: PackageInputFile[], targetFiles: PackageInputFile[], baseBytes: number, targetBytes: number) {
  const before = new Map(baseFiles.map(file => [file.path, file.content]));
  const after = new Map(targetFiles.map(file => [file.path, file.content]));
  const totals = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  let remaining = 32_768;
  const side = (content: string | undefined, unchanged: boolean) => {
    if (content === undefined) return null;
    const binary = content.includes("\0");
    const preview = binary || unchanged ? "" : content.slice(0, Math.min(1024, remaining));
    remaining -= preview.length;
    return { sha256: digest(content), byteSize: Buffer.byteLength(content), preview, previewTruncated: preview.length < content.length, previewOmitted: binary ? "binary" as const : unchanged ? "unchanged" as const : null };
  };
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().map(path => {
    const status = !before.has(path) ? "added" : !after.has(path) ? "removed" : before.get(path) === after.get(path) ? "unchanged" : "modified";
    totals[status]++;
    return { path, status, base: side(before.get(path), status === "unchanged"), target: side(after.get(path), status === "unchanged") };
  });
  return { schemaVersion: 1, base: { ...input.base, byteSize: baseBytes }, target: { ...input.target, byteSize: targetBytes }, totals, changes, previewLimitCharacters: 32_768, notice: "Compared complete content. Previews are bounded and may be omitted or truncated. No package code was executed." };
}
