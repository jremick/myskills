import { registerReleaseComparisonTool } from "./release-comparison.js";
import { registerTaskDiscoveryTool } from "./task-discovery.js";
import { registerApplicationHandoffTools } from "./application-handoffs.js";
import { registerApplicationTools } from "./application-tools.js";
import type { McpSession } from "./api-client.js";
import { registerBundleTools } from "./bundles.js";
import { McpServer, ProtocolError, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createRegistryApiClient, type RegistryApiClientOptions } from "./api-client.js";
import { createAiSkillsMcpHandlers } from "./tools.js";
import { createNativeSkillsHandlers, NATIVE_RESOURCE_URI_CHARS, SKILLS_EXTENSION } from "./skills.js";

export interface AiSkillsMcpServerOptions extends RegistryApiClientOptions {
  name?: string;
  version?: string;
  /** Verified current HTTP session, used only for incremental scope challenges. */
  session?: McpSession;
  trustedAppBaseUrl?: string;
}

export function createAiSkillsMcpServer(options: AiSkillsMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "myskills-app",
    version: options.version ?? "0.1.0",
  });
  const client = createRegistryApiClient(options);
  const handlers = createAiSkillsMcpHandlers(client);
  registerBundleTools(server, client, { session: options.session });
  registerReleaseComparisonTool(server, client, { session: options.session });
  registerTaskDiscoveryTool(server, client, { session: options.session });
  registerApplicationTools(server, client, { session: options.session });
  registerApplicationHandoffTools(server, { appBaseUrl: options.trustedAppBaseUrl });
  const skills = createNativeSkillsHandlers(options);
  server.server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION]: {} } });
  const requireSkills = (ctx: ServerContext) => {
    // SDK 2.1 deliberately hides wire-only envelope keys from public types.
    // Read the reserved key explicitly and validate the extension map locally.
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const capabilities = envelope
      ? envelope["io.modelcontextprotocol/clientCapabilities"]
      : server.server.getClientCapabilities();
    const parsed = z.object({ extensions: z.record(z.string(), z.unknown()).optional() }).safeParse(capabilities);
    const extension = parsed.success ? parsed.data.extensions?.[SKILLS_EXTENSION] : undefined;
    if (!extension || typeof extension !== "object" || Array.isArray(extension)) {
      throw new ProtocolError(-32602, "Declare the io.modelcontextprotocol/skills client extension before using Skills methods.");
    }
  };
  server.server.setRequestHandler("skills/list", {
    params: z.object({ cursor: z.string().max(2048).optional() }).default({}),
  }, (input, ctx) => {
    requireSkills(ctx);
    return skills.list(input, ctx.mcpReq.signal);
  });
  server.server.setRequestHandler("skills/get", {
    params: z.object({ uri: z.string().min(1).max(NATIVE_RESOURCE_URI_CHARS) }),
  }, (input, ctx) => {
    requireSkills(ctx);
    return skills.get(input, ctx.mcpReq.signal);
  });
  // Resources are ordinary base-protocol data for older clients too. They are
  // authorized on every read and never activate a skill or execute its files.
  server.server.setRequestHandler("resources/read", (request, ctx) => skills.read(request.params, ctx.mcpReq.signal));
  server.server.setRequestHandler("resources/list", async () => ({ resources: [], ttlMs: 0, cacheScope: "private" as const }));
  server.server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [], ttlMs: 0, cacheScope: "private" as const }));

  server.registerTool(
    "search_skills",
    {
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["skills:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
      title: "Search Skills",
      description: "Search approved MySkills registry entries visible to this connection; return the nextCursor for pagination.",
      inputSchema: z.object({
        query: z.string().trim().max(14 * 1024 * 1024).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(2048).optional(),
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
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["skills:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
      title: "Get Skill Info",
      description: "Return safe skill and release metadata for one authorized registry entry.",
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(120),
        version: z.string().trim().min(1).max(80).optional(),
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
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["skills:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
      title: "Get Install Instructions",
      description: "Return CLI/API export guidance for an authorized release without returning package contents.",
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(120),
        version: z.string().trim().min(1).max(80).optional(),
        platform: z.string().trim().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/).optional(),
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

  server.registerTool(
    "read_skill_file",
    {
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["skills:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["skills:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["skills:read"] as [string, ...string[]] } : undefined,
      title: "Read Skill File",
      description: "Read one text file from an approved skill release you can access: SKILL.md by default, or a supporting file listed in the returned manifest. The release bundle's digest and path are verified on every call. Reading does not install, enable or execute the skill.",
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(120),
        version: z.string().trim().min(1).max(80).optional(),
        path: z.string().min(1).max(1024).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      try {
        const result = await skills.readFile(input, ctx.mcpReq.signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const message = error instanceof ProtocolError && error.code === -32603
          ? "Skill delivery is temporarily unavailable."
          : "Skill or file is unavailable for this request. Check the slug, version and path from the manifest, and that the connection has skills:read.";
        return { isError: true, content: [{ type: "text" as const, text: message }], structuredContent: { error: message } };
      }
    },
  );

  server.registerTool(
    "list_architecture_patterns",
    {
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["architectures:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["architectures:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["architectures:read"] as [string, ...string[]] } : undefined,
      title: "List Architecture Patterns",
      description: "List the server-defined skill architecture patterns available to the authenticated workspace.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => handlers.listArchitecturePatterns(),
  );

  server.registerTool(
    "list_architectures",
    {
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["architectures:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["architectures:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["architectures:read"] as [string, ...string[]] } : undefined,
      title: "List Architectures",
      description: "List skill architectures visible to the authenticated owner without returning package contents or local paths.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => handlers.listArchitectures(),
  );

  server.registerTool(
    "get_architecture_projection",
    {
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["architectures:read"] }] },
      scopeChallenge: () => options.session?.credential.kind === "oauth" && ["architectures:read"].some(scope => !options.session!.credential.scopes.includes(scope)) ? { scopes: ["architectures:read"] as [string, ...string[]] } : undefined,
      title: "Get Architecture Projection",
      description: "Inspect one authorized skill architecture and its compiled topology projection without package contents, local paths, or sync writes.",
      inputSchema: z.object({
        id: z.string().trim().min(1).max(120),
        organizationId: z.string().trim().min(1).max(120).optional(),
        profileId: z.string().trim().min(1).max(120).optional(),
        environmentId: z.string().trim().min(1).max(120).optional(),
        revisionId: z.string().trim().min(1).max(120).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => handlers.getArchitectureProjection(input),
  );

  return server;
}
