import { createHash } from "node:crypto";
import { DELEGATED_ACTIONS, type PublicSkill } from "@myskills-app/core";

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
  bundleRequest?(request: import("@myskills-app/core").BundleRequest): Promise<Record<string, unknown>>;
  authenticateMcp(method?: NativeMcpMethod, signal?: AbortSignal): Promise<McpSession>;
  searchSkills(input: { query?: string; limit?: number; cursor?: string }): Promise<PublicSkill[]>;
  searchSkillPage?(input: { query?: string; limit?: number; cursor?: string }): Promise<{ skills: PublicSkill[]; nextCursor?: string | null }>;
  applicationRequest?(actionId: string, input: ApplicationRequestInput, signal?: AbortSignal): Promise<Record<string, unknown>>;
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

export interface ApplicationRequestInput {
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

export interface McpSession {
  /** OAuth returns the profile only when profile:read was explicitly granted. */
  user?: {
    id: string;
    email: string;
    name: string;
    roles: string[];
    emailVerified: boolean;
    mfaVerified: boolean;
  };
  credential:
    | { kind: "api_token"; tokenId: string; scopes: string[] }
    /** A remote MCP connector token bound to one resource (see API src/oauth). */
    | { kind: "oauth"; grantId: string; clientId: string; scopes: string[]; resource: string };
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
/** Match the existing API package JSON body limit (ZIP base64 has overhead). */
export const APPLICATION_API_REQUEST_BYTES = 14 * 1024 * 1024;

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
    bundleRequest: request => requestJson<Record<string, unknown>>(fetchImpl, token, `${baseUrl}${request.pathname}`, { method: request.method, ...(request.payload ? {body: request.payload} : {}) }),
    async authenticateMcp(method, signal) {
      if (!token) {
        throw new RegistryApiError(401, "AUTHENTICATION_REQUIRED");
      }
      const body = method
        ? await nativeRequestJson<McpSession>(fetchImpl, token, `${baseUrl}/v1/mcp/session`, signal, {
          "x-myskills-mcp-method": method,
        })
        : await requestJson<McpSession>(fetchImpl, token, `${baseUrl}/v1/mcp/session`, { signal });
      return body;
    },
    async applicationRequest(actionId, input, signal) {
      const action = DELEGATED_ACTIONS.find((item) => item.id === actionId);
      if (!action) throw new RegistryApiError(400, "INVALID_APPLICATION_ACTION");
      const path = action.route.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
        const value = input.path?.[name];
        if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/.test(value)) throw new RegistryApiError(400, "INVALID_APPLICATION_INPUT");
        return encodeURIComponent(value);
      });
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input.query ?? {})) params.set(key, String(value));
      return requestJson<Record<string, unknown>>(fetchImpl, token, `${baseUrl}${path}${params.size ? `?${params}` : ""}`, {
        method: action.method, body: input.body, signal,
        maxBytes: action.id.endsWith(".export") ? NATIVE_API_BUNDLE_BYTES : NATIVE_API_METADATA_BYTES,
        ...(action.id.endsWith(".export") ? { artifactDigest: action.id.startsWith("review.") ? "required" as const : "computed" as const } : {}),
      });
    },
    async searchSkills(input) {
      return (await this.searchSkillPage!(input)).skills;
    },
    async searchSkillPage(input) {
      const params = new URLSearchParams();
      if (input.query?.trim()) {
        params.set("q", input.query.trim());
      }
      if (input.limit !== undefined) {
        params.set("limit", String(input.limit));
      }
      if (input.cursor !== undefined) params.set("cursor", input.cursor);
      const suffix = params.size > 0 ? `?${params}` : "";
      const body = await requestJson<{ skills: PublicSkill[]; nextCursor?: string | null }>(fetchImpl, token, `${baseUrl}/v1/skills${suffix}`);
      return body;
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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  signal?: AbortSignal;
  maxBytes?: number;
  artifactDigest?: "required" | "computed";
} = {}): Promise<T> {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const serialized = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (serialized !== undefined) {
    if (Buffer.byteLength(serialized) > APPLICATION_API_REQUEST_BYTES) throw new RegistryApiError(413, "API_REQUEST_TOO_LARGE");
    headers["content-type"] = "application/json";
  }
  try {
    signal.throwIfAborted();
    const response = await abortable(fetchImpl(url, { method: options.method ?? "GET", headers, redirect: "error", signal, ...(serialized === undefined ? {} : { body: serialized }) }), signal);
    const maxBytes = response.ok ? options.maxBytes ?? NATIVE_API_METADATA_BYTES : 16_384;
    const length = response.headers?.get("content-length");
    if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw new RegistryApiError(502, "API_RESPONSE_TOO_LARGE");
    }
    if (!response.body) throw new RegistryApiError(502, "API_RESPONSE_BODY_REQUIRED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) throw new RegistryApiError(502, "API_RESPONSE_TOO_LARGE");
        chunks.push(chunk.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let body: Record<string, unknown>;
    try {
      const parsed = total ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch { throw new RegistryApiError(response.status, "API_INVALID_JSON"); }
    if (!response.ok) throw new RegistryApiError(response.status, safeResponseCode(body));
    if (options.artifactDigest) {
      const sha256 = createHash("sha256").update(Buffer.concat(chunks, total)).digest("hex");
      const expected = response.headers?.get("x-myskills-artifact-sha256");
      if (options.artifactDigest === "required" && (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== sha256)) throw new RegistryApiError(502, "ARTIFACT_SHA256_MISMATCH");
      return { artifact: { sha256, byteSize: total, verification: options.artifactDigest === "required" ? "response_header" : "computed" }, bundle: body } as T;
    }
    return body as T;
  } catch (error) {
    if (error instanceof RegistryApiError) throw error;
    throw new RegistryApiError(signal.aborted ? 504 : 503, signal.aborted ? "API_REQUEST_ABORTED" : "API_UNAVAILABLE");
  }
}

// An upstream error is untrusted. Only these source-known codes may reach model
// output; never echo its message, details, headers or arbitrary code strings.
const SAFE_ERROR_CODES = new Set([
  "API_TOKEN_SCOPE_REQUIRED", "AUTHENTICATION_REQUIRED", "MFA_VERIFICATION_REQUIRED", "OAUTH_TOKEN_NOT_ALLOWED",
  "TEAM_OWNER_REQUIRED", "TEAM_MEMBER_REQUIRED", "ADMIN_ROLE_REQUIRED", "REVIEW_ROLE_REQUIRED", "AUTHOR_ROLE_REQUIRED",
  "SKILL_NOT_FOUND", "ARCHITECTURE_NOT_FOUND", "SUBMISSION_NOT_FOUND", "LIBRARY_NOT_FOUND", "IMPROVEMENT_NOT_FOUND",
  "INVALID_REQUEST_BODY", "INVALID_APPLICATION_INPUT", "INVALID_APPLICATION_ACTION", "INVALID_REVIEW_ACTION", "INVALID_PAGE_CURSOR",
  "ARCHITECTURE_REVISION_CONFLICT", "LIBRARY_REVISION_CONFLICT", "BUNDLE_REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT",
  "LIBRARY_COLLECTION_NOT_FOUND", "LIBRARY_GROUP_NOT_FOUND", "LIBRARY_COLLECTION_REVISION_CONFLICT", "LIBRARY_GROUP_REVISION_CONFLICT",
  "LIBRARY_SELECTION_MEMBER_INVALID", "LIBRARY_SELECTION_LIMIT_EXCEEDED", "LIBRARY_WRITE_FORBIDDEN", "CLIENT_MUTATION_ID_CONFLICT",
  "TARGET_OPERATION_IDEMPOTENCY_CONFLICT", "TARGET_CONSENT_REQUIRED", "ARCHITECTURE_TARGET_CONSENT_REQUIRED",
  "ARTIFACT_HASH_MISMATCH", "ARTIFACT_SHA256_MISMATCH", "IMPROVEMENT_BINDING_MISMATCH",
  "FEATURE_DISABLED", "BUNDLES_DISABLED", "SHARING_DISABLED", "TEAMS_DISABLED", "RATE_LIMITED",
]);
function safeResponseCode(body: Record<string, unknown>): string {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "API_ERROR";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODES.has(code) ? code : "API_ERROR";
}
