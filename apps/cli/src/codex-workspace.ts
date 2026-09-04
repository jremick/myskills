import { createHash } from "node:crypto";
import { assertValidArchitectureTarget, type ArchitectureTarget } from "@myskills-app/core";
import { parseDocument } from "yaml";

export const codexWorkspaceDescriptor = Object.freeze({ kind: "codex-workspace", version: "1.0.0", contractVersion: 2 as const });
export const codexWorkspaceCapabilities = Object.freeze({
  "inventory.read": true, "health.read": true, "plan.read": true,
  apply: true, rollback: true, "sync.write": true,
});

/** Provider identity is owned by the install registry, never by self-declared skill metadata. */
export function validateCodexSkill(files: readonly { path: string; content: string }[], slug: string): void {
  const skill = files.find((file) => file.path === "SKILL.md")?.content;
  const frontmatter = skill?.match(/^---\r?\n([\s\S]{1,32768}?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error("Codex installation requires SKILL.md with standard name and description frontmatter.");
  let data: unknown;
  try {
    const document = parseDocument(frontmatter, { strict: true, uniqueKeys: true, schema: "core", logLevel: "silent" });
    if (document.errors.length || document.warnings.length) throw new Error("invalid YAML");
    data = document.toJS({ maxAliasCount: 0 });
  } catch { throw new Error("Codex frontmatter must be valid YAML with unique fields and no aliases."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Codex frontmatter must be a YAML mapping.");
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || name !== slug || name.length > 64) throw new Error("Codex frontmatter name must match the package slug and contain at most 64 characters.");
  if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new Error("Codex frontmatter description must be nonempty text of at most 1024 characters.");
}

export function parseWorkspaceTarget(input: unknown): ArchitectureTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("API response is missing a target.");
  const record = input as Record<string, unknown>;
  const fields = ["schemaVersion", "id", "name", "owner", "adapter", "architectureId", "environmentId", "profileId", "status", "consent", "generation", "identityDigest", "capabilities", "metadata", "createdAt", "updatedAt"];
  const target = assertValidArchitectureTarget(Object.fromEntries(fields.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])));
  if (target.adapter.kind !== codexWorkspaceDescriptor.kind || target.adapter.version !== codexWorkspaceDescriptor.version
    || target.adapter.contractVersion !== 2 || target.capabilities["sync.write"] !== true || target.owner.type !== "user") {
    throw new Error("The workspace requires a personal codex-workspace v2 target. Team target execution must use a separately authorized adapter.");
  }
  return target;
}

export function workspaceRootDigest(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}
