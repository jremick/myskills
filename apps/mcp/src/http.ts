import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createRegistryApiClient, RegistryApiError } from "./api-client.js";
import { createAiSkillsMcpServer } from "./server.js";
import type { FetchLike } from "./api-client.js";

export interface AiSkillsMcpHttpServerOptions {
  allowedHosts?: string[];
  allowedOrigins?: string[];
  apiBaseUrl?: string;
  endpointPath?: string;
  fetchImpl?: FetchLike;
  trustedProxyHops?: number;
  rateLimit?: {
    maxRequests?: number;
    windowMs?: number;
    maxBuckets?: number;
  };
  maxRequestBodyBytes?: number;
  maxHeaderBytes?: number;
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  socketTimeoutMs?: number;
  upstreamRequestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  maxHeadersCount?: number;
  maxRequestsPerSocket?: number;
  maxConnections?: number;
}

const DEFAULT_ENDPOINT_PATH = "/mcp";
const MAX_AUTHORIZATION_HEADER_CHARS = 512;
const MAX_BEARER_TOKEN_CHARS = 256;
const DEFAULT_MAX_REQUEST_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;
const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_HEADERS_COUNT = 64;
const DEFAULT_MAX_REQUESTS_PER_SOCKET = 100;
const DEFAULT_MAX_CONNECTIONS = 1_024;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 10_000;
const OVERFLOW_RATE_LIMIT_BUCKET = "__overflow__";

interface HttpPolicy {
  trustedProxyHops: number;
  maxRequestBodyBytes: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  socketTimeoutMs: number;
  upstreamRequestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxHeadersCount: number;
  maxRequestsPerSocket: number;
  maxConnections: number;
  rateLimit: {
    maxRequests: number;
    windowMs: number;
    maxBuckets: number;
  };
}

export function createAiSkillsMcpHttpServer(options: AiSkillsMcpHttpServerOptions = {}): Server {
  const endpointPath = normalizeEndpointPath(options.endpointPath ?? DEFAULT_ENDPOINT_PATH);
  const allowedHosts = normalizeHeaderValues(options.allowedHosts);
  const allowedOrigins = normalizeHeaderValues(options.allowedOrigins);
  const policy = normalizeHttpPolicy(options);
  const rateLimiter = new BoundedIpRateLimiter(policy.rateLimit);
  const server = createServer({
    insecureHTTPParser: false,
    joinDuplicateHeaders: false,
    maxHeaderSize: policy.maxHeaderBytes,
  }, (request, response) => {
    response.setTimeout(policy.socketTimeoutMs, () => response.destroy());
    void handleHttpRequest(request, response, {
      ...options,
      allowedHosts,
      allowedOrigins,
      endpointPath,
      policy,
      rateLimiter,
    }).catch(() => {
      sendJsonRpcError(response, 500, -32603, "Internal server error.");
    });
  });
  server.requestTimeout = policy.requestTimeoutMs;
  server.headersTimeout = policy.headersTimeoutMs;
  server.timeout = policy.socketTimeoutMs;
  server.keepAliveTimeout = policy.keepAliveTimeoutMs;
  server.maxHeadersCount = policy.maxHeadersCount;
  server.maxRequestsPerSocket = policy.maxRequestsPerSocket;
  server.maxConnections = policy.maxConnections;
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (socket.writable) {
      const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } else {
      socket.destroy();
    }
  });
  return server;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AiSkillsMcpHttpServerOptions & {
    allowedHosts: string[];
    allowedOrigins: string[];
    endpointPath: string;
    policy: HttpPolicy;
    rateLimiter: BoundedIpRateLimiter;
  },
): Promise<void> {
  const path = requestPath(request);
  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true, service: "myskills-app-mcp-http" });
    return;
  }
  const rateLimit = options.rateLimiter.consume(clientIp(request, options.policy.trustedProxyHops));
  if (!rateLimit.allowed) {
    sendPreBodyJsonRpcError(request, response, 429, -32004, "Too many MCP HTTP requests.", {
      "retry-after": String(rateLimit.retryAfterSeconds),
    });
    return;
  }
  if (path !== options.endpointPath) {
    sendPreBodyJsonRpcError(request, response, 404, -32000, "Not found.");
    return;
  }
  if (request.method !== "POST") {
    sendPreBodyJsonRpcError(request, response, 405, -32000, "Method not allowed.");
    return;
  }
  if (!isAllowedHost(request, options.allowedHosts)) {
    sendPreBodyJsonRpcError(request, response, 403, -32002, "MCP HTTP host is not allowed.");
    return;
  }
  if (!isAllowedOrigin(request, options.allowedOrigins)) {
    sendPreBodyJsonRpcError(request, response, 403, -32003, "MCP HTTP origin is not allowed.");
    return;
  }
  const declaredBodyError = validateDeclaredBodyLength(request, options.policy.maxRequestBodyBytes);
  if (declaredBodyError) {
    sendRequestError(request, response, declaredBodyError);
    return;
  }
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    sendPreBodyJsonRpcError(request, response, 401, -32001, "MCP HTTP transport requires a bearer API token.");
    return;
  }
  const fetchImpl = withRequestTimeout(options.fetchImpl ?? fetch, options.policy.upstreamRequestTimeoutMs);
  const authClient = createRegistryApiClient({
    apiBaseUrl: options.apiBaseUrl,
    fetchImpl,
    token,
  });
  try {
    await authClient.authenticateMcp();
  } catch (error) {
    const isAuthDenial = error instanceof RegistryApiError && (error.status === 401 || error.status === 403);
    sendPreBodyJsonRpcError(
      request,
      response,
      isAuthDenial ? error.status : 503,
      isAuthDenial ? -32001 : -32603,
      isAuthDenial
        ? "MCP HTTP transport requires a scoped API token."
        : "MCP HTTP authentication service is temporarily unavailable.",
    );
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(request, options.policy.maxRequestBodyBytes);
  } catch (error) {
    sendRequestError(request, response, requestError(error));
    return;
  }

  const createServer = () => createAiSkillsMcpServer({
    apiBaseUrl: options.apiBaseUrl,
    fetchImpl,
    token,
  });
  const handler = createMcpHandler(createServer, {
    legacy: "reject",
    responseMode: "json",
    maxRequestBodySize: options.policy.maxRequestBodyBytes,
  });
  let legacyServer: ReturnType<typeof createServer> | undefined;
  let legacyTransport: WebStandardStreamableHTTPServerTransport | undefined;
  const handleMcp = toNodeHandler({
    async fetch(webRequest, context) {
      // Use the SDK's classifier: malformed modern envelopes must not enter the legacy path.
      if (await isLegacyRequest(webRequest, context?.parsedBody, {
        maxRequestBodySize: options.policy.maxRequestBodyBytes,
      })) {
        legacyServer = createServer();
        legacyTransport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          sessionIdGenerator: undefined,
          maxRequestBodySize: options.policy.maxRequestBodyBytes,
        });
        await legacyServer.connect(legacyTransport);
        return legacyTransport.handleRequest(webRequest, context);
      }
      return handler.fetch(webRequest, context);
    },
  }, { maxRequestBodySize: options.policy.maxRequestBodyBytes });

  let closePromise: Promise<void> | null = null;
  const closeResources = () => {
    closePromise ??= (async () => {
      await handler.close();
      if (legacyServer && legacyTransport) {
        await closeMcpResources(legacyServer, legacyTransport);
      }
    })();
    return closePromise;
  };
  const closeOnDisconnect = () => {
    void closeResources();
  };
  response.once("close", closeOnDisconnect);

  try {
    await handleMcp(request, response, parsedBody);
  } catch {
    sendJsonRpcError(response, 500, -32603, "Internal server error.");
  } finally {
    response.off("close", closeOnDisconnect);
    await closeResources();
  }
}

class HttpRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly rpcCode: number,
    message: string,
    readonly closeConnection = false,
  ) {
    super(message);
  }
}

class BoundedIpRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private consumeCount = 0;

  constructor(private readonly options: HttpPolicy["rateLimit"]) {}

  consume(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.consumeCount += 1;
    if (this.consumeCount % 64 === 0) {
      this.cleanupExpired(now, 256);
    }
    const bucketKey = this.buckets.has(ip) || this.buckets.size < this.options.maxBuckets - 1
      ? ip
      : OVERFLOW_RATE_LIMIT_BUCKET;
    const existing = this.buckets.get(bucketKey);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(bucketKey, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (existing.count >= this.options.maxRequests) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1_000)),
      };
    }
    existing.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private cleanupExpired(now: number, limit: number): void {
    let deleted = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
        deleted += 1;
        if (deleted >= limit) {
          return;
        }
      }
    }
  }
}

function normalizeHttpPolicy(options: AiSkillsMcpHttpServerOptions): HttpPolicy {
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
  const headersTimeoutMs = positiveInteger(options.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS, "headersTimeoutMs");
  const socketTimeoutMs = positiveInteger(options.socketTimeoutMs, DEFAULT_SOCKET_TIMEOUT_MS, "socketTimeoutMs");
  const upstreamRequestTimeoutMs = positiveInteger(
    options.upstreamRequestTimeoutMs,
    Math.min(DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS, socketTimeoutMs),
    "upstreamRequestTimeoutMs",
  );
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error("headersTimeoutMs cannot exceed requestTimeoutMs.");
  }
  if (upstreamRequestTimeoutMs > socketTimeoutMs) {
    throw new Error("upstreamRequestTimeoutMs cannot exceed socketTimeoutMs.");
  }
  return {
    trustedProxyHops: nonNegativeInteger(options.trustedProxyHops, 0, "trustedProxyHops", 10),
    maxRequestBodyBytes: positiveInteger(options.maxRequestBodyBytes, DEFAULT_MAX_REQUEST_BODY_BYTES, "maxRequestBodyBytes"),
    maxHeaderBytes: positiveInteger(options.maxHeaderBytes, DEFAULT_MAX_HEADER_BYTES, "maxHeaderBytes"),
    requestTimeoutMs,
    headersTimeoutMs,
    socketTimeoutMs,
    upstreamRequestTimeoutMs,
    keepAliveTimeoutMs: positiveInteger(options.keepAliveTimeoutMs, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, "keepAliveTimeoutMs"),
    maxHeadersCount: positiveInteger(options.maxHeadersCount, DEFAULT_MAX_HEADERS_COUNT, "maxHeadersCount"),
    maxRequestsPerSocket: positiveInteger(options.maxRequestsPerSocket, DEFAULT_MAX_REQUESTS_PER_SOCKET, "maxRequestsPerSocket"),
    maxConnections: positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS, "maxConnections"),
    rateLimit: {
      maxRequests: positiveInteger(options.rateLimit?.maxRequests, DEFAULT_RATE_LIMIT_MAX_REQUESTS, "rateLimit.maxRequests"),
      windowMs: positiveInteger(options.rateLimit?.windowMs, DEFAULT_RATE_LIMIT_WINDOW_MS, "rateLimit.windowMs"),
      maxBuckets: positiveInteger(options.rateLimit?.maxBuckets, DEFAULT_RATE_LIMIT_MAX_BUCKETS, "rateLimit.maxBuckets", 2),
    },
  };
}

export function withRequestTimeout(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    return fetchImpl(input, { ...init, signal });
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  minimum = 1,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}.`);
  }
  return normalized;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    throw new Error(`${field} must be an integer from 0 to ${maximum}.`);
  }
  return normalized;
}

function clientIp(request: IncomingMessage, trustedProxyHops: number): string {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  if (trustedProxyHops === 0) {
    return remoteAddress;
  }
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") {
    return remoteAddress;
  }
  const entries = forwarded.split(",").map((entry) => entry.trim());
  if (entries.length === 0 || entries.length > 32 || entries.some((entry) => isIP(entry) === 0)) {
    return remoteAddress;
  }
  const chain = [...entries, remoteAddress];
  const clientIndex = chain.length - 1 - trustedProxyHops;
  return clientIndex >= 0 ? chain[clientIndex]! : remoteAddress;
}

function validateDeclaredBodyLength(request: IncomingMessage, maxBytes: number): HttpRequestError | null {
  const value = request.headers["content-length"];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) {
    return new HttpRequestError(400, -32700, "Invalid Content-Length header.", true);
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) {
    return new HttpRequestError(400, -32700, "Invalid Content-Length header.", true);
  }
  return bytes > maxBytes
    ? new HttpRequestError(413, -32005, "MCP HTTP request body is too large.", true)
    : null;
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        cleanup();
        request.pause();
        reject(new HttpRequestError(413, -32005, "MCP HTTP request body is too large.", true));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
      } catch {
        reject(new HttpRequestError(400, -32700, "Parse error: Invalid JSON"));
      }
    };
    const onAborted = () => {
      cleanup();
      reject(new HttpRequestError(400, -32700, "MCP HTTP request was aborted.", true));
    };
    const onError = () => {
      cleanup();
      reject(new HttpRequestError(400, -32700, "MCP HTTP request could not be read.", true));
    };
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function requestError(error: unknown): HttpRequestError {
  return error instanceof HttpRequestError
    ? error
    : new HttpRequestError(400, -32700, "MCP HTTP request could not be read.", true);
}

function sendRequestError(request: IncomingMessage, response: ServerResponse, error: HttpRequestError): void {
  if (error.closeConnection) {
    response.shouldKeepAlive = false;
    request.resume();
  }
  sendJsonRpcError(response, error.statusCode, error.rpcCode, error.message, error.closeConnection
    ? { connection: "close" }
    : undefined);
}

function sendPreBodyJsonRpcError(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  response.shouldKeepAlive = false;
  request.resume();
  sendJsonRpcError(response, statusCode, code, message, { ...headers, connection: "close" });
}

async function closeMcpResources(
  server: ReturnType<typeof createAiSkillsMcpServer>,
  transport: WebStandardStreamableHTTPServerTransport,
): Promise<void> {
  try {
    await server.close();
  } catch {
    try {
      await transport.close();
    } catch {
      // The request and response timeout policy bounds any remaining socket lifetime.
    }
  }
}

function bearerToken(value: string | undefined): string | null {
  if (!value || value.length > MAX_AUTHORIZATION_HEADER_CHARS) {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 8 ||
    trimmed.slice(0, 6).toLowerCase() !== "bearer" ||
    !isHttpWhitespace(trimmed.charCodeAt(6))
  ) {
    return null;
  }
  let tokenStart = 6;
  while (tokenStart < trimmed.length && isHttpWhitespace(trimmed.charCodeAt(tokenStart))) {
    tokenStart += 1;
  }
  const tokenLength = trimmed.length - tokenStart;
  if (tokenLength < 1 || tokenLength > MAX_BEARER_TOKEN_CHARS) {
    return null;
  }
  for (let index = tokenStart; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return null;
    }
  }
  return trimmed.slice(tokenStart);
}

function isHttpWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
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

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  }, headers);
}
