import type { PublicSkill } from "@myskills-app/core";

export interface ReleaseMetadata {
  slug: string;
  title: string;
  summary: string;
  version: string;
  reviewStatus: "approved";
  securityStatus: "passed";
  publishedAt: string;
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
  authenticateMcp(): Promise<McpSession>;
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
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface RegistryApiClientOptions {
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
  token?: string;
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
    async authenticateMcp() {
      if (!token) {
        throw new RegistryApiError(401, "AUTHENTICATION_REQUIRED");
      }
      const body = await requestJson<McpSession>(fetchImpl, token, `${baseUrl}/v1/mcp/session`);
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
