import { z } from "zod";
import { parseDocument } from "yaml";
import { parseSemanticVersion } from "@myskills-app/core";

export const skillSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers, and single hyphens.")
  .refine((value) => !value.includes("--"), "Consecutive hyphens are not allowed.");

export const platformNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Use lowercase letters, numbers, dots, underscores, and hyphens.");

export const platformVariantSchema = z.object({
  name: platformNameSchema,
  install_target: z.string().min(1).max(96),
  status: z.enum(["supported", "planned", "deprecated"]).default("supported"),
}).strict();

export const skillManifestSchema = z.object({
  name: skillSlugSchema,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  version: z.string().refine((value) => parseSemanticVersion(value) !== null, "Use semantic versioning."),
  license: z.string().min(1).max(80),
  visibility: z.enum(["public", "authenticated", "organization", "team", "private", "explicit-users"]).default("private"),
  platforms: z.array(platformVariantSchema).min(1),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
}).strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export function parseSkillManifest(input: unknown): SkillManifest {
  return skillManifestSchema.parse(input);
}

/** Synthesize intake metadata only; retain the original SKILL.md in the package. */
export function skillManifestFromFrontmatter(content: string): SkillManifest {
  const frontmatter = content.match(/^---\r?\n([\s\S]{1,32768}?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || Buffer.byteLength(frontmatter, "utf8") > 32768) {
    throw new Error("SKILL.md requires YAML frontmatter of at most 32768 bytes with name and description.");
  }
  let data: unknown;
  try {
    const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true, schema: "core", logLevel: "silent" });
    if (document.errors.length || document.warnings.length) throw new Error("invalid YAML");
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("SKILL.md frontmatter must be valid YAML with unique fields and no aliases.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("SKILL.md frontmatter must be a YAML mapping.");
  const fields = data as Record<string, unknown>;
  if (typeof fields.name !== "string" || typeof fields.description !== "string" || !fields.description.trim()) {
    throw new Error("SKILL.md frontmatter requires a text name and nonempty description.");
  }
  const metadata = fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata)
    ? fields.metadata as Record<string, unknown> : {};
  return parseSkillManifest({
    name: fields.name,
    title: fields.title ?? fields.name.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
    summary: fields.description.trim().slice(0, 500),
    version: fields.version ?? metadata.version ?? "0.1.0",
    license: fields.license ?? "UNLICENSED",
    // Generating a manifest must never broaden the package's audience.
    visibility: "private",
    platforms: fields.platforms ?? [{ name: "codex", install_target: "codex-skill" }],
    tags: fields.tags ?? [],
  });
}

// Decode immutable artifacts created before canonical SemVer intake was enforced.
// This reader must not be used to validate a new submission.
const storedSkillManifestSchema = skillManifestSchema.extend({
  version: z.string().refine((value) => parseSemanticVersion(value) !== null
    || /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value), "Use semantic versioning."),
});

export function parseStoredSkillManifest(input: unknown): SkillManifest {
  return storedSkillManifestSchema.parse(input);
}
