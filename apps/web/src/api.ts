import type { PublicSkill } from "@ai-skills-share/core";

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

export interface WebAuthUser {
  id: string;
  email: string;
  name: string;
  status: string;
  roles: string[];
  emailVerified: boolean;
  mfaVerified: boolean;
}

export type LoginResult =
  | { mfaRequired: false; token: string; expiresAt: string; user: WebAuthUser }
  | { mfaRequired: true; challengeToken: string; expiresAt: string; user: WebAuthUser };

export interface SessionResult {
  token: string;
  expiresAt: string;
  user: WebAuthUser;
}

export interface RegistryClient {
  searchSkills(query: string): Promise<PublicSkill[]>;
  getSkill(slug: string): Promise<PublicSkill>;
  getRelease(slug: string, version: string): Promise<ReleaseMetadata>;
  login(input: { email: string; password: string }): Promise<LoginResult>;
  verifyMfa(input: { challengeToken: string; codeOrRecoveryCode: string }): Promise<SessionResult>;
  getMe(token?: string): Promise<WebAuthUser>;
  logout(token?: string): Promise<void>;
}

export interface SafeApiError extends Error {
  status: number;
  code: string;
}

export function createRegistryClient(baseUrl = defaultApiBaseUrl(), fetchImpl: typeof fetch = fetch, token?: string): RegistryClient {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    async searchSkills(query: string) {
      const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const body = await requestJson<{ skills: PublicSkill[] }>(fetchImpl, `${root}/v1/skills${params}`, {
        token,
      });
      return body.skills;
    },
    async getSkill(slug: string) {
      const body = await requestJson<{ skill: PublicSkill }>(fetchImpl, `${root}/v1/skills/${encodeURIComponent(slug)}`, {
        token,
      });
      return body.skill;
    },
    async getRelease(slug: string, version: string) {
      const body = await requestJson<{ release: ReleaseMetadata }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
        { token },
      );
      return body.release;
    },
    async login(input) {
      return requestJson<LoginResult>(fetchImpl, `${root}/v1/auth/login`, {
        method: "POST",
        body: input,
      });
    },
    async verifyMfa(input) {
      const body = /^[0-9]{6}$/.test(input.codeOrRecoveryCode.trim())
        ? { challengeToken: input.challengeToken, code: input.codeOrRecoveryCode.trim() }
        : { challengeToken: input.challengeToken, recoveryCode: input.codeOrRecoveryCode.trim() };
      return requestJson<SessionResult>(fetchImpl, `${root}/v1/auth/mfa/verify`, {
        method: "POST",
        body,
      });
    },
    async getMe(overrideToken) {
      const body = await requestJson<{ user: WebAuthUser }>(fetchImpl, `${root}/v1/me`, {
        token: overrideToken ?? token,
      });
      return body.user;
    },
    async logout(overrideToken) {
      await requestJson<Record<string, never>>(fetchImpl, `${root}/v1/auth/logout`, {
        method: "POST",
        body: {},
        token: overrideToken ?? token,
      });
    },
  };
}

export function exportCommand(slug: string, version: string, platform: string): string {
  return `ai-skills export ${slug} --version ${version} --platform ${platform} --output ./skills/${slug}`;
}

export function safeErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.status === 404) {
    return "Skill or release not found.";
  }
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "You do not have access to that registry item.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "The registry request could not be completed.";
  }
  return "The registry is not available.";
}

export function safeAuthErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && error.status === 429) {
    return "Too many sign-in attempts. Try again later.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Sign in could not be completed.";
  }
  return "Authentication is not available.";
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, options: {
  body?: unknown;
  method?: "GET" | "POST";
  token?: string;
} = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const response = await fetchImpl(url, {
    method: options.method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    const error = new Error(safeResponseMessage(body, response.status)) as SafeApiError;
    error.status = response.status;
    error.code = safeResponseCode(body);
    throw error;
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

function safeResponseMessage(body: Record<string, unknown>, status: number): string {
  const error = body.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return `Registry request failed with ${status}.`;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : `Registry request failed with ${status}.`;
}

function isSafeApiError(error: unknown): error is SafeApiError {
  return Boolean(error && typeof error === "object" && "status" in error);
}

function defaultApiBaseUrl(): string {
  return import.meta.env?.VITE_API_BASE_URL ?? "http://localhost:3001";
}
