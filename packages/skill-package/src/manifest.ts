import { z } from "zod";

export const skillSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Use lowercase letters, numbers, and single hyphens.")
  .refine((value) => !value.includes("--"), "Consecutive hyphens are not allowed.");

export const platformVariantSchema = z.object({
  name: z.string().min(1).max(64),
  install_target: z.string().min(1).max(96),
  status: z.enum(["supported", "planned", "deprecated"]).default("supported"),
});

export const skillManifestSchema = z.object({
  name: skillSlugSchema,
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(500),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Use semantic versioning."),
  license: z.string().min(1).max(80),
  visibility: z.enum(["public", "authenticated", "organization", "team", "private", "explicit-users"]).default("private"),
  platforms: z.array(platformVariantSchema).min(1),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export function parseSkillManifest(input: unknown): SkillManifest {
  return skillManifestSchema.parse(input);
}

