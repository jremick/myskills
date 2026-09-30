import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { bundleRequest } from "@myskills-app/core";
import { RegistryApiError, type RegistryApiClient, type McpSession } from "./api-client.js";

export function registerBundleTools(
  server: McpServer,
  client: RegistryApiClient,
  options: { session?: McpSession } = {},
) {
  const execute = async (
    action: string,
    id: string | undefined,
    options: Record<string, unknown>,
    input?: Record<string, unknown>,
  ) => {
    try {
      const session = await client.authenticateMcp("skills/list");
      const scopes = [
        "skills:read",
        ...(input?.kind === "source" ? ["libraries:read"] : []),
        ...(action === "save"
          ? ["libraries:write"]
          : ["create", "edit"].includes(action)
            ? ["skills:submit"]
            : action === "sources"
              ? ["libraries:read"]
              : []),
      ];
      if (scopes.some((scope) => !session.credential.scopes.includes(scope)))
        throw new RegistryApiError(403, "API_TOKEN_SCOPE_REQUIRED");
      if (!client.bundleRequest)
        throw new RegistryApiError(503, "BUNDLE_SERVICE_UNAVAILABLE");
      const result = await client.bundleRequest(
        bundleRequest(action, id, options, input),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const code =
        error instanceof RegistryApiError
          ? error.code
          : "INVALID_BUNDLE_REQUEST";
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: {
                code,
                message:
                  "The bundle operation could not complete. Check access, input and the current revision before retrying.",
              },
            }),
          },
        ],
      };
    }
  };
  server.registerTool(
    "browse_bundles",
    {
      scopeChallenge: ({ request }) => {
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const scopes = ["skills:read", ...(args.action === "sources" ? ["libraries:read"] : [])];
        return options.session?.credential.kind === "oauth" && scopes.some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: scopes as [string, ...string[]] } : undefined;
      },
      title: "Browse Skill Bundles",
      description:
        "Discover related skill collections, their authorized members, memberships and reviewed source selections. Does not install or adopt skills.",
      inputSchema: z.object({
        action: z.enum([
          "catalog",
          "show",
          "members",
          "memberships",
          "sources",
        ]),
        id: z.string().max(128).optional(),
        query: z.string().max(200).optional(),
        view: z.enum(["grouped", "list", "outline"]).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ action, id, ...options }) =>
      execute(action === "catalog" ? "list" : action, id, options),
  );

  server.registerTool(
    "curate_bundle",
    {
      scopeChallenge: ({ request }) => {
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const body = (args.input ?? {}) as Record<string, unknown>;
        const scopes = ["skills:read", ...(args.action === "save" ? ["libraries:write"] : ["skills:submit"]), ...(body.kind === "source" ? ["libraries:read"] : [])];
        return options.session?.credential.kind === "oauth" && scopes.some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: scopes as [string, ...string[]] } : undefined;
      },
      title: "Curate Skill Bundle",
      description:
        "Create or edit an explicitly reviewed collection, or save its reference to a library. Use edit with the current expectedRevision. Saving does not adopt, install or follow skills. Read the collection and obtain the user's intent before changes.",
      inputSchema: z.object({
        action: z.enum(["create", "edit", "save"]),
        id: z.string().max(128).optional(),
        input: z.record(z.string(), z.unknown()),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, id, input }) => execute(action, id, {}, input),
  );
}
