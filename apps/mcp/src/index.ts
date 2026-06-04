#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAiSkillsMcpServer } from "./server.js";

const server = createAiSkillsMcpServer({
  apiBaseUrl: process.env.MYSKILLS_API_URL,
  token: process.env.MYSKILLS_TOKEN,
});

try {
  await server.connect(new StdioServerTransport());
} catch {
  console.error("MySkills MCP server failed to start.");
  process.exit(1);
}
