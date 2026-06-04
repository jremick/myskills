#!/usr/bin/env node

import { createAiSkillsMcpHttpServer } from "./http.js";

const host = process.env.MYSKILLS_MCP_HOST ?? "127.0.0.1";
const port = parsePort(process.env.MYSKILLS_MCP_PORT ?? process.env.PORT ?? "3002");
const endpointPath = process.env.MYSKILLS_MCP_PATH ?? "/mcp";
const allowedHosts = parseCsv(process.env.MYSKILLS_MCP_ALLOWED_HOSTS) ?? defaultAllowedHosts(host, port);
const allowedOrigins = parseCsv(process.env.MYSKILLS_MCP_ALLOWED_ORIGINS) ?? [];

try {
  const server = createAiSkillsMcpHttpServer({
    allowedHosts,
    allowedOrigins,
    apiBaseUrl: process.env.MYSKILLS_API_URL,
    endpointPath,
  });
  server.listen(port, host, () => {
    console.error(`MySkills MCP HTTP listening on http://${host}:${port}${endpointPath}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
    });
  }
} catch {
  console.error("MySkills MCP HTTP server failed to start.");
  process.exit(1);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MYSKILLS_MCP_PORT must be a valid TCP port.");
  }
  return port;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultAllowedHosts(host: string, port: number): string[] {
  if (!isLoopbackHost(host)) {
    throw new Error("MYSKILLS_MCP_ALLOWED_HOSTS is required when MYSKILLS_MCP_HOST is not loopback.");
  }
  return [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
