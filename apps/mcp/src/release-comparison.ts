import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { compareAuthorizedReleases, compareAuthorizedReviewCandidate, type ReleaseComparisonInput, type ReviewComparisonInput, type ReleaseComparisonPin } from "@myskills-app/skill-package";
import { RegistryApiError, type RegistryApiClient, type McpSession } from "./api-client.js";
const pin = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), version: z.string().min(1).max(64), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function compareReleasePackages(client: RegistryApiClient, input: ReleaseComparisonInput, signal?: AbortSignal) {
  const session = await client.authenticateMcp(undefined, signal);
  if (!session.credential.scopes.includes("skills:read")) throw new RegistryApiError(403, "API_TOKEN_SCOPE_REQUIRED");
  if (!client.applicationRequest) throw new RegistryApiError(503, "API_UNAVAILABLE");
  return compareAuthorizedReleases(input, async (kind, exact) => {
    const response = await client.applicationRequest!(kind === "release" ? "skills.releases.get" : "skills.releases.export", {
      path: { slug: exact.slug, version: exact.version }, ...(kind === "bundle" ? { query: { sha256: exact.artifactSha256 } } : {}),
    }, signal);
    if (kind === "release") return response;
    return verifiedBundle(response, exact);
  });
}
function verifiedBundle(response: unknown, exact: ReleaseComparisonPin): Record<string, unknown> {
  const exported = response as { artifact?: { sha256?: string; verification?: string }; bundle?: Record<string, unknown> };
  if (exported.artifact?.sha256 !== exact.artifactSha256 || exported.artifact.verification !== "response_header" || !exported.bundle || typeof exported.bundle !== "object" || Array.isArray(exported.bundle)) throw new RegistryApiError(502, "ARTIFACT_SHA256_MISMATCH");
  return exported.bundle;
}
export async function compareReviewCandidate(client: RegistryApiClient, input: ReviewComparisonInput, signal?: AbortSignal) {
  const session = await client.authenticateMcp(undefined, signal);
  if (!(["skills:read", "review:read"] as const).every(scope => session.credential.scopes.includes(scope))) throw new RegistryApiError(403, "API_TOKEN_SCOPE_REQUIRED");
  if (!client.applicationRequest) throw new RegistryApiError(503, "API_UNAVAILABLE");
  return compareAuthorizedReviewCandidate(input, async (kind, exact) => {
    const review = kind === "review" || kind === "review-bundle";
    const bundle = kind === "bundle" || kind === "review-bundle";
    const response = await client.applicationRequest!(review ? (bundle ? "review.submissions.export" : "review.submissions.get") : (bundle ? "skills.releases.export" : "skills.releases.get"), {
      path: review ? { id: exact.submissionId! } : { slug: exact.slug, version: exact.version }, ...(!review && bundle ? { query: { sha256: exact.artifactSha256 } } : {}),
    }, signal);
    return bundle ? verifiedBundle(response, exact) : response;
  });
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
  server.registerTool("review_submissions_compare", {
    title: "Compare Review Candidate",
    description: "Before approval, compare an exact authorized review candidate with a separately readable published release. Requires current reviewer role/MFA and both read scopes. Full content determines changes; previews are bounded. No approval or package code execution.",
    inputSchema: z.object({ base: pin, target: pin.extend({ submissionId: z.string().uuid() }).strict() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: { capabilityId: "PUB-08", securitySchemes: [{ type: "oauth2", scopes: ["skills:read", "review:read"] }] },
    scopeChallenge: () => options.session?.credential.kind === "oauth" && (!options.session.credential.scopes.includes("skills:read") || !options.session.credential.scopes.includes("review:read")) ? { scopes: ["skills:read", "review:read"] as [string, ...string[]] } : undefined,
  }, async (input, ctx) => {
    try {
      const result = await compareReviewCandidate(client, input, ctx.mcpReq.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const code = error instanceof RegistryApiError ? error.code : "RELEASE_COMPARISON_INVALID";
      return { isError: true, content: [{ type: "text" as const, text: `Review comparison unavailable (${code}). Recheck reviewer authority, readable baseline and exact pins.` }] };
    }
  });
}
