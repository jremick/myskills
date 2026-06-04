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

export interface RegistryClient {
  searchSkills(query: string): Promise<PublicSkill[]>;
  getSkill(slug: string): Promise<PublicSkill>;
  getRelease(slug: string, version: string): Promise<ReleaseMetadata>;
}

export interface SafeApiError extends Error {
  status: number;
  code: string;
}

export function createRegistryClient(baseUrl = defaultApiBaseUrl(), fetchImpl: typeof fetch = fetch): RegistryClient {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    async searchSkills(query: string) {
      const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      const body = await requestJson<{ skills: PublicSkill[] }>(fetchImpl, `${root}/v1/skills${params}`);
      return body.skills;
    },
    async getSkill(slug: string) {
      const body = await requestJson<{ skill: PublicSkill }>(fetchImpl, `${root}/v1/skills/${encodeURIComponent(slug)}`);
      return body.skill;
    },
    async getRelease(slug: string, version: string) {
      const body = await requestJson<{ release: ReleaseMetadata }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/releases/${encodeURIComponent(version)}`,
      );
      return body.release;
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

async function requestJson<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
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
