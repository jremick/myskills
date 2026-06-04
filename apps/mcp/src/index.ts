#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAiSkillsMcpServer } from "./server.js";

const server = createAiSkillsMcpServer({
  apiBaseUrl: process.env.AI_SKILLS_API_URL,
  token: process.env.AI_SKILLS_TOKEN,
});

try {
  await server.connect(new StdioServerTransport());
} catch {
  console.error("AI Skills Share MCP server failed to start.");
  process.exit(1);
}
