import path from "node:path";
import { parseSkillManifest, skillManifestFromFrontmatter, type SkillManifest } from "./manifest.js";
import {
  loadSkillManifestFromPackageFiles, PackageManifestFileError, readPackageFilesFromPath,
  scanPackageFiles, validatePackageFiles, type PackageInputFile, type PackageSnapshot,
} from "./package-path.js";

export const GENERATED_MANIFEST_NOTICE = "Generated skill.json from SKILL.md with private visibility for this package; source files unchanged.";

/** Explicit intake repair, separate from strict readers of stored artifacts. */
export function preparePackageManifest(files: PackageInputFile[]): { manifest: SkillManifest; files: PackageInputFile[]; notices: string[] } {
  validatePackageFiles(files);
  try {
    return { manifest: loadSkillManifestFromPackageFiles(files), files, notices: [] };
  } catch (error) {
    if (!(error instanceof PackageManifestFileError) || error.code !== "PACKAGE_MANIFEST_REQUIRED") throw error;
    const skill = files.find(file => file.path === "SKILL.md");
    if (!skill) throw error;
    let manifest: SkillManifest;
    try { manifest = skillManifestFromFrontmatter(skill.content); }
    catch (cause) {
      throw new PackageManifestFileError("INVALID_PACKAGE_MANIFEST", cause instanceof Error ? cause.message : "Invalid SKILL.md frontmatter.");
    }
    const prepared = [...files, { path: "skill.json", content: `${JSON.stringify(manifest, null, 2)}\n` }].sort((a, b) => a.path.localeCompare(b.path));
    validatePackageFiles(prepared);
    return { manifest, files: prepared, notices: [GENERATED_MANIFEST_NOTICE] };
  }
}

export async function readPreparedPackageSnapshot(inputPath: string): Promise<PackageSnapshot & { notices: string[] }> {
  const files = await readPackageFilesFromPath(inputPath);
  // Preserve validation of a directly named JSON manifest with a custom filename.
  const prepared = files.length === 1 && files[0].path === path.basename(inputPath)
    && path.extname(inputPath).toLowerCase() !== ".zip" && files[0].path !== "SKILL.md"
    ? { manifest: parseSkillManifest(JSON.parse(files[0].content)), files, notices: [] }
    : preparePackageManifest(files);
  return { ...prepared, scan: { ...scanPackageFiles(prepared.files), rootPath: path.resolve(inputPath) } };
}
