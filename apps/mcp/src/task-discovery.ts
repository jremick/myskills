import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { taskDiscoveryLimits } from "@myskills-app/core";
import type { RegistryApiClient, McpSession } from "./api-client.js";

export function registerTaskDiscoveryTool(server: McpServer, client: RegistryApiClient, options: { session?: McpSession }) {
  server.registerTool("discover_skills", {
    title: "Find Skills for a Task",
    description: "Find currently authorized approved releases using bounded word overlap. Returns exact version/digest, method and uncertainty. No model calls, activation, install or execution.",
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
    scopeChallenge: () => options.session?.credential.kind === "oauth" && !options.session.credential.scopes.includes("skills:read") ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
    inputSchema: z.object({ task: z.string().min(1).max(taskDiscoveryLimits.taskCharacters), limit: z.number().int().min(1).max(taskDiscoveryLimits.results).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => {
    try {
      const session = await client.authenticateMcp();
      if (!session.credential.scopes.includes("skills:read")) throw new Error("scope");
      if (!client.discoverTask) throw new Error("unavailable");
      const response = await client.discoverTask(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(response) }], structuredContent: { ...response } };
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: "Task discovery is unavailable or this connection lacks skills:read access. Reconnect or use ordinary search." }] };
    }
  });
}
