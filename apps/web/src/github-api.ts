import { requestJson } from "./api.js";

export interface GithubAccountConnection {
  available: boolean;
  status: "disconnected" | "connected" | "reconnect_required";
  login: string | null;
  connectedAt: string | null;
  credentialSource: "anonymous" | "user" | "installation";
}
export interface GithubAdminSettings {
  enabled: boolean;
  appId: string;
  clientId: string;
  installationId: string | null;
  installationEnabled: boolean;
  hasClientSecret: boolean;
  hasPrivateKey: boolean;
  callbackUrl: string;
  status: "not_configured" | "configured" | "connected" | "error";
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
}
export interface GithubSettingsInput {
  enabled: boolean;
  appId: string;
  clientId: string;
  installationId: string | null;
  installationEnabled: boolean;
  clientSecret?: string;
  privateKey?: string;
}

export function createGithubClient(root: string, fetchImpl: typeof fetch, token?: string) {
  const request = <T>(path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown) => requestJson<T>(fetchImpl, `${root}/v1${path}`, { token, method, ...(body === undefined ? {} : { body }) });
  return {
    account: async () => (await request<{ github: GithubAccountConnection }>("/account/github")).github,
    connect: () => request<{ authorizationUrl: string }>("/account/github/connect", "POST"),
    disconnect: async () => (await request<{ github: GithubAccountConnection }>("/account/github", "DELETE")).github,
    settings: async () => (await request<{ github: GithubAdminSettings }>("/admin/github")).github,
    saveSettings: async (body: GithubSettingsInput) => (await request<{ github: GithubAdminSettings }>("/admin/github", "PUT", body)).github,
    testConnection: async () => (await request<{ github: GithubAdminSettings }>("/admin/github/test", "POST")).github,
  };
}
export type GithubClient = ReturnType<typeof createGithubClient>;

export function githubError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "MFA_VERIFICATION_REQUIRED" || code === "ADMIN_MFA_REQUIRED") return "Use an MFA-verified admin session to change GitHub settings.";
  if (code === "GITHUB_NOT_CONFIGURED" || code === "GITHUB_INTEGRATION_DISABLED") return "GitHub connections are not configured. Ask your instance administrator.";
  if (code === "GITHUB_AUTH_REQUIRED" || code === "GITHUB_RECONNECT_REQUIRED") return "Reconnect your GitHub account to resume authenticated checks.";
  if (code === "GITHUB_APP_AUTH_FAILED") return "Ask your instance administrator to check the GitHub App credentials and installation.";
  if (code === "GITHUB_CREDENTIAL_UNAVAILABLE") return "GitHub credentials are unavailable. Ask your instance administrator to check the server configuration.";
  if (code === "GITHUB_UPSTREAM_UNAVAILABLE") return "GitHub is temporarily unavailable. Try again later.";
  return "Couldn’t complete the GitHub request. Your changes are still here. Try again.";
}
