import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compareAuthorizedReleases, type ReleaseComparisonInput } from "@myskills-app/skill-package";
import { RegistryApiError, type RegistryApiClient, type McpSession } from "./api-client.js";
const pin = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().min(1).max(64), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function compareReleasePackages(client: RegistryApiClient, input: ReleaseComparisonInput, signal?: AbortSignal) {
  const session = await client.authenticateMcp(undefined, signal);
  if (!session.credential.scopes.includes("skills:read")) throw new RegistryApiError(403, "API_TOKEN_SCOPE_REQUIRED");
  if (!client.applicationRequest) throw new RegistryApiError(503, "API_UNAVAILABLE");
  return compareAuthorizedReleases(input, (kind, exact) => client.applicationRequest!(kind === "release" ? "skills.releases.get" : "skills.releases.export", {
    path: { slug: exact.slug, version: exact.version }, ...(kind === "bundle" ? { query: { sha256: exact.artifactSha256 } } : {}),
  }, signal));
}
export function registerReleaseComparisonTool(server: McpServer, client: RegistryApiClient, options: { session?: McpSession }) {
  server.registerTool("skills_releases_compare", {
    title: "Compare Exact Release Packages",
    description: "Compare two exact readable published releases using live API permission checks and both immutable SHA-256 pins. Reports added, removed, modified and unchanged files with byte identities and bounded previews. Management access alone cannot read unpublished packages. No code executes.",
    inputSchema: z.object({ base: pin, target: pin }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { capabilityId: "HIST-01", securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
    scopeChallenge: () => options.session?.credential.kind === "oauth" && !options.session.credential.scopes.includes("skills:read") ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
  }, async (input, ctx) => {
    try {
      const result = await compareReleasePackages(client, input, ctx.mcpReq.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const code = error instanceof RegistryApiError ? error.code : "RELEASE_COMPARISON_INVALID";
      return { isError: true, content: [{ type: "text" as const, text: `Comparison unavailable (${code}). Verify current read access and both exact release pins.` }] };
    }
  });
}
