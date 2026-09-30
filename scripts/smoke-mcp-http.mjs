#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";

// Run inside the isolated image after its default command starts. No API or
// credentials are needed: verify health, platform PORT and the anonymous boundary.
const port = Number(process.env.PORT ?? "3002");
const origin = `http://127.0.0.1:${port}`;

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP smoke PORT is invalid.");
  const deadline = Date.now() + 10_000;
  let health;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      break;
    } catch {
      await delay(100);
    }
  }
  if (!health) throw new Error("MCP server did not become ready.");
  const body = await health.json();
  if (health.status !== 200 || body.ok !== true || body.service !== "myskills-app-mcp-http") throw new Error("MCP health check failed.");
  const anonymous = await fetch(`${origin}/mcp`, { method: "POST", signal: AbortSignal.timeout(1_000) });
  if (anonymous.status !== 401) throw new Error("MCP anonymous request check failed.");
  console.log(JSON.stringify({ service: body.service, health: "passed", anonymousMcp: "denied", port }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "MCP smoke failed.");
  process.exitCode = 1;
}
