import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { parseSkillManifest, skillSlugSchema, type SkillManifest } from "@myskills-app/skill-package";
import { assertRegularDirectory, errorCode, writeNewPackageTree } from "./install-filesystem.js";

const DEFAULT_VERSION = "0.1.0";
const DEFAULT_LICENSE = "UNLICENSED";
const DEFAULT_SUMMARY = "Describe what this skill does.";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export interface InitSkillPackageOptions {
  name: string;
  output?: string;
  title?: string;
  summary?: string;
  license?: string;
}

export interface InitSkillPackageResult {
  outputPath: string;
  manifest: SkillManifest;
}

export class SkillInitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInitInputError";
  }
}

export class SkillInitDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInitDestinationError";
  }
}

/**
 * Create the smallest valid private Codex skill package on a supported local
 * filesystem. This command deliberately has no registry or network path.
 */
export async function initSkillPackage(options: InitSkillPackageOptions): Promise<InitSkillPackageResult> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new SkillInitDestinationError("Local skill authoring requires macOS or Linux.");
  }

  const manifest = buildManifest(options);
  const files = [
    { path: "skill.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "SKILL.md", content: skillDocument(manifest.name, manifest.summary) },
  ];
  const requestedOutput = path.resolve(options.output ?? path.join(process.cwd(), options.name));
  if (CONTROL_CHARACTER_PATTERN.test(requestedOutput)) {
    throw new SkillInitInputError("Output path must not contain control characters.");
  }

  const requestedParent = path.dirname(requestedOutput);
  try {
    await assertRegularDirectory(requestedParent);
  } catch {
    throw new SkillInitDestinationError(`Output parent must be an existing regular directory: ${requestedParent}.`);
  }

  let parent: string;
  try {
    parent = await realpath(requestedParent);
    await assertRegularDirectory(parent);
  } catch {
    throw new SkillInitDestinationError(`Output parent must be an existing regular directory: ${requestedParent}.`);
  }

  const outputPath = path.join(parent, path.basename(requestedOutput));
  let destinationExists = false;
  try {
    await lstat(outputPath);
    destinationExists = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new SkillInitDestinationError(`Cannot inspect output destination: ${outputPath}.`);
    }
  }
  if (destinationExists) {
    throw new SkillInitDestinationError(`Output destination already exists and will not be overwritten: ${outputPath}.`);
  }

  try {
    await writeNewPackageTree(parent, outputPath, files);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new SkillInitDestinationError(`Output destination appeared or already exists and will not be overwritten: ${outputPath}.`);
    }
    throw new SkillInitDestinationError(error instanceof Error ? error.message : "Could not create the skill package.");
  }

  return { outputPath, manifest };
}

export function buildManifest(options: InitSkillPackageOptions): SkillManifest {
  const nameResult = skillSlugSchema.safeParse(options.name);
  if (!nameResult.success) {
    throw new SkillInitInputError("Skill name must use lowercase letters, numbers, and single hyphens, with no leading or trailing hyphen.");
  }
  const title = options.title ?? options.name;
  const summary = options.summary ?? DEFAULT_SUMMARY;
  const license = options.license ?? DEFAULT_LICENSE;
  if (!isNonBlankText(title) || !isNonBlankText(summary) || !isNonBlankText(license)) {
    throw new SkillInitInputError("Title, summary, and license must contain non-whitespace text.");
  }

  try {
    return parseSkillManifest({
      name: options.name,
      title,
      summary,
      version: DEFAULT_VERSION,
      license,
      visibility: "private",
      platforms: [{ name: "codex", install_target: "codex-skill", status: "supported" }],
      tags: [],
    });
  } catch {
    throw new SkillInitInputError("Skill metadata is invalid. Check the name, title, summary, and license lengths.");
  }
}

function skillDocument(name: string, summary: string): string {
  // JSON string syntax is a safe YAML double-quoted scalar for these two
  // fields and encodes quotes, newlines, and control characters explicitly.
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(summary)}`,
    "---",
    "",
    "# Skill instructions",
    "",
    "Add the instructions for this skill here.",
    "",
  ].join("\n");
}

function isNonBlankText(value: string): boolean {
  return value.length > 0 && value.trim().length > 0;
}
