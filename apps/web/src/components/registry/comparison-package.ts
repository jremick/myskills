import type { SkillPackageBundle, SkillReleaseSummary } from "../../api.js";

const MAX_FILES = 500;
const MAX_PACKAGE_CHARACTERS = 1_048_576;
const MANIFEST_NAMES = ["skill.json", "skill-manifest.json", "ai-skill.json"];
export type FileChange = { path: string; kind: "Added" | "Removed" | "Modified" | "Unchanged"; base: string | undefined; target: string | undefined };

export class ComparisonValidationError extends Error {}

export async function verifyBundle(bundle: SkillPackageBundle, release: Pick<SkillReleaseSummary, "slug" | "version"> & { artifact: { sha256: string } }): Promise<void> {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length === 0 || bundle.files.length > MAX_FILES) {
    throw new ComparisonValidationError("This package cannot be compared safely.");
  }
  const paths = new Set<string>();
  let characters = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== "string" || !file.path || file.path.length > 1_024 || /[\\\u0000-\u001f]/.test(file.path)
      || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path) || typeof file.content !== "string") {
      throw new ComparisonValidationError("This package contains invalid or duplicate file paths.");
    }
    paths.add(file.path);
    characters += file.content.length;
    if (characters > MAX_PACKAGE_CHARACTERS) throw new ComparisonValidationError("This package exceeds the text comparison limit.");
  }
  // Hash the received immutable payload BEFORE display sorting. The existing
  // exact bundle API returns parsed JSON; its artifact bytes use JSON.stringify.
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(bundle)));
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== release.artifact.sha256) throw new ComparisonValidationError("Package SHA-256 does not match the selected exact release. Refresh release history and try again.");
  const manifests = bundle.files.filter(file => MANIFEST_NAMES.includes(file.path));
  let manifest: { name?: unknown; version?: unknown } | null = null;
  try { if (manifests.length === 1) manifest = JSON.parse(manifests[0].content); } catch { /* Reject below without exposing package text. */ }
  if (!manifest || manifest.name !== release.slug || manifest.version !== release.version) {
    throw new ComparisonValidationError("Package identity does not match the selected skill and exact version. Refresh release history and try again.");
  }
}

export function compareFiles(base: SkillPackageBundle, target: SkillPackageBundle): FileChange[] {
  const before = new Map(base.files.map(file => [file.path, file.content]));
  const after = new Map(target.files.map(file => [file.path, file.content]));
  // Codepoint order is stable across browser locale. Content stays untouched.
  return [...new Set([...before.keys(), ...after.keys()])].sort().map(path => ({ path, base: before.get(path), target: after.get(path),
    kind: !before.has(path) ? "Added" : !after.has(path) ? "Removed" : before.get(path) === after.get(path) ? "Unchanged" : "Modified" }));
}
