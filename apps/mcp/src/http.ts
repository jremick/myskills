import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRegistryApiClient, RegistryApiError } from "./api-client.js";
import { createAiSkillsMcpServer } from "./server.js";
import type { FetchLike } from "./api-client.js";

export interface AiSkillsMcpHttpServerOptions {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  apiBaseUrl?: string;
  endpointPath?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_ENDPOINT_PATH = "/mcp";

export function createAiSkillsMcpHttpServer(options: AiSkillsMcpHttpServerOptions = {}): Server {
  const endpointPath = normalizeEndpointPath(options.endpointPath ?? DEFAULT_ENDPOINT_PATH);
  const allowedHosts = normalizeHeaderValues(options.allowedHosts);
  const allowedOrigins = normalizeHeaderValues(options.allowedOrigins);
  return createServer((request, response) => {
    void handleHttpRequest(request, response, { ...options, allowedHosts, allowedOrigins, endpointPath }).catch(() => {
      sendJsonRpcError(response, 500, -32603, "Internal server error.");
    });
  });
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AiSkillsMcpHttpServerOptions & { allowedHosts: string[]; allowedOrigins: string[]; endpointPath: string },
): Promise<void> {
  const path = requestPath(request);
  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true, service: "ai-skills-share-mcp-http" });
    return;
  }
  if (path !== options.endpointPath) {
    sendJsonRpcError(response, 404, -32000, "Not found.");
    return;
  }
  if (request.method !== "POST") {
    sendJsonRpcError(response, 405, -32000, "Method not allowed.");
    return;
  }
  if (!isAllowedHost(request, options.allowedHosts)) {
    sendJsonRpcError(response, 403, -32002, "MCP HTTP host is not allowed.");
    return;
  }
  if (!isAllowedOrigin(request, options.allowedOrigins)) {
    sendJsonRpcError(response, 403, -32003, "MCP HTTP origin is not allowed.");
    return;
  }
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    sendJsonRpcError(response, 401, -32001, "MCP HTTP transport requires a bearer API token.");
    return;
  }
  const authClient = createRegistryApiClient({
    apiBaseUrl: options.apiBaseUrl,
    fetchImpl: options.fetchImpl,
    token,
  });
  try {
    await authClient.authenticateMcp();
  } catch (error) {
    const statusCode = error instanceof RegistryApiError && (error.status === 401 || error.status === 403)
      ? error.status
      : 401;
    sendJsonRpcError(response, statusCode, -32001, "MCP HTTP transport requires a scoped API token.");
    return;
  }

  const server = createAiSkillsMcpServer({
    apiBaseUrl: options.apiBaseUrl,
    fetchImpl: options.fetchImpl,
    token,
  });
  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  let closed = false;
  const closeTransport = () => {
    if (closed) {
      return;
    }
    closed = true;
    void transport.close();
    void server.close();
  };
  response.once("close", closeTransport);

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch {
    sendJsonRpcError(response, 500, -32603, "Internal server error.");
  } finally {
    if (response.writableEnded) {
      closeTransport();
    }
  }
}

function bearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function isAllowedHost(request: IncomingMessage, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) {
    return true;
  }
  const host = request.headers.host?.trim().toLowerCase();
  return Boolean(host && allowedHosts.includes(host));
}

function isAllowedOrigin(request: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin?.trim().toLowerCase();
  if (!origin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

function normalizeEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("MCP HTTP endpoint path must be an absolute path.");
  }
  return trimmed.replace(/\/+$/, "") || "/";
}

function normalizeHeaderValues(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function sendJsonRpcError(response: ServerResponse, statusCode: number, code: number, message: string): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}
