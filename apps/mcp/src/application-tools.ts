import type { McpServer } from "@modelcontextprotocol/server";
import { DELEGATED_ACTIONS, type DelegatedAction } from "@myskills-app/core";
import { applicationInputSchema } from "./application-schemas.js";
import { RegistryApiError, type ApplicationRequestInput, type McpSession, type RegistryApiClient } from "./api-client.js";

// Discovery is independent of granted scopes. A host must see an operation and
// its exact scope requirement before it can request incremental user consent.
// API authorization still runs on every call, including ownership and assurance.
export function registerApplicationTools(server: McpServer, client: RegistryApiClient, options: { session?: McpSession } = {}) {
  for (const action of DELEGATED_ACTIONS) {
    const name = action.id.replaceAll(".", "_");
    const readOnly = action.method === "GET" || ["skills.discover", "draft.preview", "draft.validate", "architectures.preview", "architectures.draft.preview", "architectures.pattern_migration.preview", "improvements.plans.preview"].includes(action.id);
    server.registerTool(name, {
      title: action.id.replaceAll("_", " ").replaceAll(".", " · "),
      description: description(action),
      inputSchema: applicationInputSchema(action),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
      _meta: { actionId: action.id, capabilityId: action.capabilityId, securitySchemes: action.requiredScopes.length ? [{ type: "oauth2", scopes: [...action.requiredScopes] }] : [{ type: "noauth" }] },
      scopeChallenge: ({ request }) => {
        const scopes = requiredScopes(action, request.params?.arguments as ApplicationRequestInput | undefined);
        if (options.session?.credential.kind !== "oauth" || !scopes.some((scope) => !options.session!.credential.scopes.includes(scope))) return undefined;
        return { scopes: scopes as [string, ...string[]], errorDescription: "Reconnect and approve the scopes needed for this action." };
      },
    }, async (raw, ctx) => {
      const input = raw as ApplicationRequestInput;
      const scopes = requiredScopes(action, input);
      try {
        if (!client.applicationRequest) throw new RegistryApiError(503, "API_UNAVAILABLE");
        if (action.requiredScopes.length) {
          const session = await client.authenticateMcp(undefined, ctx.mcpReq.signal);
          if (scopes.some((scope) => !session.credential.scopes.includes(scope))) throw new RegistryApiError(403, "API_TOKEN_SCOPE_REQUIRED");
        }
        const result = await client.applicationRequest(action.id, input, ctx.mcpReq.signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const known = error instanceof RegistryApiError;
        const code = known ? error.code : "INVALID_APPLICATION_INPUT";
        const message = code === "MFA_VERIFICATION_REQUIRED"
          ? "Sign in and complete MFA in the trusted MySkills application, then reconnect and approve this action. Refreshing the connection does not renew MFA assurance."
          : code === "API_TOKEN_SCOPE_REQUIRED"
            ? "This connection lacks the action's required scope. Reconnect and approve the listed scopes."
            : "The operation could not be confirmed. Check permission, input, the current revision and any required digest. After a transport failure, read back the resource before retrying because the API may have completed the action.";
        const result = { error: { code, status: known ? error.status : 400, message }, actionId: action.id, requiredScopes: scopes };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
}

function requiredScopes(action: DelegatedAction, input: ApplicationRequestInput | undefined): string[] {
  const scopes: string[] = [...action.requiredScopes];
  if (action.id === "draft.create" && input?.body && typeof input.body === "object" && "source" in input.body) {
    const source = input.body.source as { kind?: string };
    scopes.push(source?.kind === "release" ? "skills:read" : "submissions:read");
  }
  // These are additive API policies, never substitutes for server permission checks.
  if (action.id === "skills.metadata.update" && input?.body && typeof input.body === "object" && "visibility" in input.body) scopes.push("sharing:write");
  if (["bundles.create", "bundles.update"].includes(action.id) && input?.body && typeof input.body === "object" && "kind" in input.body && input.body.kind === "source") scopes.push("libraries:read");
  return [...new Set(scopes)];
}

function description(action: DelegatedAction): string {
  const verb = action.id.replaceAll("_", " ").replaceAll(".", " ");
  const conditional = action.id === "draft.create" ? "Release forks additionally require skills:read; submission forks require submissions:read." : action.id === "skills.metadata.update" ? "Changing visibility also requires sharing:write." : ["bundles.create", "bundles.update"].includes(action.id) ? "Source bundles also require libraries:read." : "";
  return `${verb}. Calls the existing MySkills ${action.method} ${action.route} operation with the connected user's live permissions. ${action.requiredScopes.length ? `Requires all scopes: ${action.requiredScopes.join(", ")}.` : "Returns public instance metadata."} ${action.assurance.includes("mfa") ? "MFA assurance is required where the API's role/resource policy applies; reconnect through the trusted application when it expires." : "The API enforces ownership, membership and lifecycle policy."} ${conditional} Read the current resource first for revision/digest-sensitive writes. This operation does not perform local installation or target execution.`;
}
