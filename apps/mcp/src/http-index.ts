#!/usr/bin/env node

import { createAiSkillsMcpHttpServer } from "./http.js";

const host = process.env.MYSKILLS_MCP_HOST ?? "127.0.0.1";
const port = parsePort(process.env.MYSKILLS_MCP_PORT ?? process.env.PORT ?? "3002");
const endpointPath = process.env.MYSKILLS_MCP_PATH ?? "/mcp";
const allowedHosts = parseCsv(process.env.MYSKILLS_MCP_ALLOWED_HOSTS) ?? defaultAllowedHosts(host, port);
const allowedOrigins = parseCsv(process.env.MYSKILLS_MCP_ALLOWED_ORIGINS) ?? [];
const trustedProxyHops = parseNonNegativeInteger(process.env.MYSKILLS_MCP_TRUST_PROXY_HOPS ?? "0", "MYSKILLS_MCP_TRUST_PROXY_HOPS");
const oauth = parseOAuthResource(process.env.MYSKILLS_OAUTH_ISSUER, process.env.MYSKILLS_MCP_PUBLIC_URL);
const rateLimitMaxRequests = process.env.MYSKILLS_MCP_RATE_LIMIT_MAX_REQUESTS === undefined
  ? undefined
  : parsePositiveInteger(process.env.MYSKILLS_MCP_RATE_LIMIT_MAX_REQUESTS, "MYSKILLS_MCP_RATE_LIMIT_MAX_REQUESTS");

try {
  const server = createAiSkillsMcpHttpServer({
    allowedHosts,
    allowedOrigins,
    apiBaseUrl: process.env.MYSKILLS_API_URL,
    endpointPath,
    trustedProxyHops,
    ...(oauth ? { oauth } : {}),
    ...(rateLimitMaxRequests ? { rateLimit: { maxRequests: rateLimitMaxRequests } } : {}),
  });
  server.listen(port, host, () => {
    console.error(`MySkills MCP HTTP listening on http://${host}:${port}${endpointPath}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const forceClose = setTimeout(() => {
        server.closeAllConnections();
        process.exit(1);
      }, 35_000);
      forceClose.unref();
      server.closeIdleConnections();
      server.close(() => {
        clearTimeout(forceClose);
        process.exit(0);
      });
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

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d{1,2}$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

/** Remote connector mode needs both values or neither; a partial setup fails closed. */
function parseOAuthResource(issuer: string | undefined, publicUrl: string | undefined) {
  const hasIssuer = Boolean(issuer?.trim());
  const hasPublicUrl = Boolean(publicUrl?.trim());
  if (!hasIssuer && !hasPublicUrl) return undefined;
  if (!hasIssuer || !hasPublicUrl) {
    throw new Error("Set both MYSKILLS_OAUTH_ISSUER and MYSKILLS_MCP_PUBLIC_URL for remote connectors, or neither.");
  }
  return { issuer: issuer!.trim(), resourceUrl: publicUrl!.trim() };
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
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
