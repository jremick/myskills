import type { PublicSkill } from "@myskills-app/core";

export interface ReleaseMetadata {
  slug: string;
  title: string;
  summary: string;
  version: string;
  reviewStatus: "approved";
  securityStatus: "passed";
  publishedAt: string;
  releaseNotes?: string;
  requiresUserAction?: boolean;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  artifact: {
    sha256: string;
    byteSize: number;
    contentType: string;
  };
}

export interface RegistryApiClient {
  readonly baseUrl: string;
  readonly hasToken: boolean;
  authenticateMcp(method?: NativeMcpMethod, signal?: AbortSignal): Promise<McpSession>;
  searchSkills(input: { query?: string; limit?: number }): Promise<PublicSkill[]>;
  getSkill(slug: string): Promise<PublicSkill>;
  getRelease(slug: string, version: string): Promise<ReleaseMetadata>;
  listArchitecturePatterns(): Promise<Record<string, unknown>>;
  listArchitectures(): Promise<Record<string, unknown>>;
  getArchitecture(architectureId: string): Promise<Record<string, unknown>>;
  previewArchitecture(architectureId: string, input: {
    profileId?: string;
    environmentId?: string;
    revisionId?: string;
    organizationId?: string;
  }): Promise<Record<string, unknown>>;
}

export interface McpSession {
  user: {
    id: string;
    email: string;
    name: string;
    roles: string[];
    emailVerified: boolean;
    mfaVerified: boolean;
  };
  credential: {
    kind: "api_token";
    tokenId: string;
    scopes: string[];
  };
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "error" },
) => Promise<{
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface RegistryApiClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
  token?: string;
}

export type NativeMcpMethod = "skills/list" | "skills/get" | "resources/read";
export const NATIVE_API_METADATA_BYTES = 512 * 1024;
export const NATIVE_API_BUNDLE_BYTES = 10 * 1024 * 1024;

/** Each instance belongs to one native operation, including its deadline. */
export function createNativeRegistryApiClient(options: RegistryApiClientOptions, signal: AbortSignal) {
  const client = createRegistryApiClient(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token?.trim();
  return {
    baseUrl: client.baseUrl,
    authenticate: (method: NativeMcpMethod) => client.authenticateMcp(method, signal),
    json: <T>(path: string, maxBytes = NATIVE_API_METADATA_BYTES) => nativeRequestJson<T>(fetchImpl, token, `${client.baseUrl}${path}`, signal, undefined, maxBytes),
    bytes: (path: string, maxBytes: number) => nativeRequestBytes(fetchImpl, token, `${client.baseUrl}${path}`, signal, maxBytes),
  };
}

async function nativeRequestJson<T>(
  fetchImpl: FetchLike, token: string | undefined, url: string,
  signal?: AbortSignal, headers?: Record<string, string>, maxBytes = NATIVE_API_METADATA_BYTES,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > NATIVE_API_BUNDLE_BYTES) {
    throw new RegistryApiError(502, "API_INVALID_RESPONSE_LIMIT");
  }
  const bytes = await nativeRequestBytes(fetchImpl, token, url, signal, maxBytes, headers);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as T;
  } catch {
    throw new RegistryApiError(502, "API_INVALID_JSON");
  }
}

async function nativeRequestBytes(
  fetchImpl: FetchLike, token: string | undefined, url: string, signal: AbortSignal | undefined,
  maxBytes: number, extraHeaders?: Record<string, string>,
): Promise<Uint8Array> {
  // The timeout covers headers AND body. This also bounds stdio clients and is
  // composed with the HTTP adapter's upstream timeout and cancellation policy.
  const requestSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  try {
    requestSignal.throwIfAborted();
    const response = await abortable(fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      signal: requestSignal,
    }), requestSignal);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new RegistryApiError(response.status);
    }
    const length = response.headers?.get("content-length");
    if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new RegistryApiError(502, "API_RESPONSE_TOO_LARGE");
    }
    // Native delivery requires a stream even for injected fetch adapters: an
    // unbounded text() fallback would defeat the byte limit before validation.
    if (!response.body) throw new RegistryApiError(502, "API_RESPONSE_BODY_REQUIRED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), requestSignal);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw new RegistryApiError(502, "API_RESPONSE_TOO_LARGE");
        chunks.push(chunk.value);
      }
      requestSignal.throwIfAborted();
      return Buffer.concat(chunks, total);
    } finally {
      // Do not wait for an uncooperative upstream's cancel() promise.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    throw requestSignal.aborted
      ? new RegistryApiError(504, "API_REQUEST_ABORTED")
      : new RegistryApiError(503, "API_UNAVAILABLE");
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new RegistryApiError(504, "API_REQUEST_ABORTED"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class RegistryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code = "API_ERROR",
  ) {
    super(`Registry API request failed with status ${status}.`);
  }
}

export function createRegistryApiClient(options: RegistryApiClientOptions = {}): RegistryApiClient {
  const baseUrl = normalizeBaseUrl(options.apiBaseUrl ?? "http://localhost:3001");
  const token = options.token?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    baseUrl,
    hasToken: Boolean(token),
    async authenticateMcp(method, signal) {
      if (!token) {
        throw new RegistryApiError(401, "AUTHENTICATION_REQUIRED");
      }
      const body = method
        ? await nativeRequestJson<McpSession>(fetchImpl, token, `${baseUrl}/v1/mcp/session`, signal, {
          "x-myskills-mcp-method": method,
        })
        : await requestJson<McpSession>(fetchImpl, token, `${baseUrl}/v1/mcp/session`);
      return body;
    },
    async searchSkills(input) {
      const params = new URLSearchParams();
      if (input.query?.trim()) {
        params.set("q", input.query.trim());
      }
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      const suffix = params.size > 0 ? `?${params}` : "";
      const body = await requestJson<{ skills: PublicSkill[] }>(fetchImpl, token, `${baseUrl}/v1/skills${suffix}`);
      return body.skills;
    },
    async getSkill(slug) {
      const body = await requestJson<{ skill: PublicSkill }>(
        fetchImpl,
        token,
        `${baseUrl}/v1/skills/${encodeURIComponent(slug)}`,
      );
      return body.skill;
    },
    async getRelease(slug, version) {
      const body = await requestJson<{ release: ReleaseMetadata }>(
        fetchImpl,
        token,
        `${baseUrl}/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
      );
      return body.release;
    },
    async listArchitecturePatterns() {
      return await requestJson<Record<string, unknown>>(
        fetchImpl,
        token,
        `${baseUrl}/v1/architecture-patterns`,
      );
    },
    async listArchitectures() {
      return await requestJson<Record<string, unknown>>(
        fetchImpl,
        token,
        `${baseUrl}/v1/architectures`,
      );
    },
    async getArchitecture(architectureId) {
      return await requestJson<Record<string, unknown>>(
        fetchImpl,
        token,
        `${baseUrl}/v1/architectures/${encodeURIComponent(architectureId)}`,
      );
    },
    async previewArchitecture(architectureId, input) {
      return await requestJson<Record<string, unknown>>(
        fetchImpl,
        token,
        `${baseUrl}/v1/architectures/${encodeURIComponent(architectureId)}/preview`,
        { method: "POST", body: input },
      );
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    // Credentials and query strings must never become part of a shared MCP
    // endpoint or an install/export projection. Tokens belong in headers.
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("credentials and query parameters are not supported");
    }
    return trimmed;
  } catch {
    throw new Error("MCP API URL must be a valid http:// or https:// URL without credentials or query parameters.");
  }
}

async function requestJson<T>(fetchImpl: FetchLike, token: string | undefined, url: string, options: {
  body?: unknown;
  method?: "GET" | "POST";
} = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetchImpl(url, {
    ...(options.method === undefined ? {} : { method: options.method }),
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    const parsed = text ? JSON.parse(text) as unknown : {};
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new RegistryApiError(response.status, "API_INVALID_JSON");
  }
  if (!response.ok) {
    throw new RegistryApiError(response.status, safeResponseCode(body));
  }
  return body as T;
}

function safeResponseCode(body: Record<string, unknown>): string {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return "API_ERROR";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "API_ERROR";
}
