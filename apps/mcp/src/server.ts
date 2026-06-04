import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRegistryApiClient, type RegistryApiClientOptions } from "./api-client.js";
import { createAiSkillsMcpHandlers } from "./tools.js";

export interface AiSkillsMcpServerOptions extends RegistryApiClientOptions {
  name?: string;
  version?: string;
}

export function createAiSkillsMcpServer(options: AiSkillsMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "ai-skills-share",
    version: options.version ?? "0.1.0",
  });
  const handlers = createAiSkillsMcpHandlers(createRegistryApiClient(options));

  server.registerTool(
    "search_skills",
    {
      title: "Search Skills",
      description: "Search approved AI Skills Share registry entries visible to the configured API token.",
      inputSchema: z.object({
        query: z.string().trim().max(120).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => handlers.searchSkills(input),
  );

  server.registerTool(
    "get_skill_info",
    {
      title: "Get Skill Info",
      description: "Return safe skill and release metadata for one authorized registry entry.",
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(120),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => handlers.getSkillInfo(input),
  );

  server.registerTool(
    "get_install_instructions",
    {
      title: "Get Install Instructions",
      description: "Return CLI/API export guidance for an authorized release without returning package contents.",
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(120),
        version: z.string().trim().min(1).max(80).optional(),
        platform: z.string().trim().min(1).max(64).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => handlers.getInstallInstructions(input),
  );

  return server;
}
