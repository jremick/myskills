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

export type AdminRegistrationMode = "closed" | "request" | "open";

export interface AdminRegistrationSettings {
  mode: AdminRegistrationMode;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: "pending" | "active" | "disabled" | "deleted";
  roles: string[];
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export interface ProviderRoleMappingInput {
  claim: string;
  value: string;
  role: string;
}

export interface AdminProviderConfig {
  key: string;
  type: "oidc" | "saml" | "cloudflare_access" | "github" | "google";
  displayName: string;
  issuer: string | null;
  clientId: string | null;
  enabled: boolean;
  roleMappings: ProviderRoleMappingInput[];
}

export interface UpsertAdminProviderInput {
  type: AdminProviderConfig["type"];
  displayName: string;
  issuer?: string;
  clientId?: string;
  enabled?: boolean;
  roleMappings?: ProviderRoleMappingInput[];
}

export interface AdminAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
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
  getAdminRegistration(token?: string): Promise<AdminRegistrationSettings>;
  updateAdminRegistration(mode: AdminRegistrationMode, token?: string): Promise<AdminRegistrationSettings>;
  listAdminUsers(token?: string): Promise<AdminUser[]>;
  performAdminUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete", token?: string): Promise<AdminUser>;
  listAdminProviders(token?: string): Promise<AdminProviderConfig[]>;
  upsertAdminProvider(key: string, input: UpsertAdminProviderInput, token?: string): Promise<AdminProviderConfig>;
  listAdminAudit(limit?: number, token?: string): Promise<AdminAuditEvent[]>;
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
    async getAdminRegistration(overrideToken) {
      const body = await requestJson<{ registration: AdminRegistrationSettings }>(
        fetchImpl,
        `${root}/v1/admin/registration`,
        { token: overrideToken ?? token },
      );
      return body.registration;
    },
    async updateAdminRegistration(mode, overrideToken) {
      const body = await requestJson<{ registration: AdminRegistrationSettings }>(
        fetchImpl,
        `${root}/v1/admin/registration`,
        { method: "PUT", body: { mode }, token: overrideToken ?? token },
      );
      return body.registration;
    },
    async listAdminUsers(overrideToken) {
      const body = await requestJson<{ users: AdminUser[] }>(fetchImpl, `${root}/v1/admin/users`, {
        token: overrideToken ?? token,
      });
      return body.users;
    },
    async performAdminUserAction(userId, action, overrideToken) {
      const body = await requestJson<{ user: AdminUser }>(
        fetchImpl,
        `${root}/v1/admin/users/${encodeURIComponent(userId)}/actions`,
        { method: "POST", body: { action }, token: overrideToken ?? token },
      );
      return body.user;
    },
    async listAdminProviders(overrideToken) {
      const body = await requestJson<{ providers: AdminProviderConfig[] }>(
        fetchImpl,
        `${root}/v1/admin/providers`,
        { token: overrideToken ?? token },
      );
      return body.providers;
    },
    async upsertAdminProvider(key, input, overrideToken) {
      const body = await requestJson<{ provider: AdminProviderConfig }>(
        fetchImpl,
        `${root}/v1/admin/providers/${encodeURIComponent(key)}`,
        { method: "PUT", body: input, token: overrideToken ?? token },
      );
      return body.provider;
    },
    async listAdminAudit(limit = 25, overrideToken) {
      const body = await requestJson<{ events: AdminAuditEvent[] }>(
        fetchImpl,
        `${root}/v1/admin/audit?limit=${encodeURIComponent(String(limit))}`,
        { token: overrideToken ?? token },
      );
      return body.events;
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

export function safeAdminErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Admin access requires an MFA-verified owner or admin session.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Admin change could not be saved.";
  }
  return "Admin data is not available.";
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, options: {
  body?: unknown;
  method?: "GET" | "POST" | "PUT" | "DELETE";
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
