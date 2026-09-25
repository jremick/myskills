#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAiSkillsMcpServer } from "./server.js";

try {
  serveStdio(() => createAiSkillsMcpServer({
    apiBaseUrl: process.env.MYSKILLS_API_URL,
    token: process.env.MYSKILLS_TOKEN,
  }), {
    onerror: () => console.error("MySkills MCP transport error."),
  });
} catch {
  console.error("MySkills MCP server failed to start.");
  process.exit(1);
}
