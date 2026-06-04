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
  init?: { method?: string; headers?: Record<string, string> },
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
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function requestJson<T>(fetchImpl: FetchLike, token: string | undefined, url: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(url, { headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
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
