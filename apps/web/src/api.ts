import type {
  PublicSkill,
  SharingSettings,
  SkillSharingDetails,
  TeamSharedSkillGroup,
  VisibilityScope,
} from "@myskills-app/core";

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

export interface RegistrationInvitation {
  email: string;
  expiresAt: string;
}

export type AdminSharingSettings = SharingSettings;

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

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "owner" | "member";
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  email: string;
  status: "pending" | "accepted" | "revoked";
  createdAt: string;
}

export interface TeamRecord {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
  members: TeamMember[];
  invitations: TeamInvitation[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamDashboard {
  teams: TeamRecord[];
  invitations: TeamInvitation[];
}

export interface ReviewSubmissionSummary {
  id: string;
  slug: string;
  title: string;
  version: string;
  visibility: string;
  reviewStatus: string;
  securityStatus: string;
  platforms: Array<{ name: string; installTarget: string; status: string }>;
  findingCount: number;
  createdAt: string;
}

export interface ReviewActionResult {
  id: string;
  slug: string;
  version: string;
  visibility: string;
  lifecycleStatus: string;
  reviewStatus: string;
  securityStatus: string;
  publishedAt: string | null;
}

export interface SubmissionScanFinding {
  category: string;
  severity: "warning" | "blocking";
  message: string;
  path?: string;
}

export interface SubmitArchiveInput {
  filename: string;
  contentBase64: string;
}

export interface SubmitSkillResult {
  submission: {
    id: string;
    slug: string;
    version: string;
    reviewStatus: string;
    securityStatus: string;
  };
  scan: {
    status: string;
    findingCount: number;
    findings: SubmissionScanFinding[];
  };
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
  registerWithInvitation(input: { email: string; password: string; name?: string; inviteToken: string }): Promise<{ status: "pending" | "active" }>;
  verifyMfa(input: { challengeToken: string; codeOrRecoveryCode: string }): Promise<SessionResult>;
  getMe(token?: string): Promise<WebAuthUser>;
  logout(token?: string): Promise<void>;
  getAdminRegistration(token?: string): Promise<AdminRegistrationSettings>;
  updateAdminRegistration(mode: AdminRegistrationMode, token?: string): Promise<AdminRegistrationSettings>;
  createRegistrationInvitation(input: { email: string; name?: string }, token?: string): Promise<RegistrationInvitation>;
  getAdminSharing(token?: string): Promise<AdminSharingSettings>;
  updateAdminSharing(settings: AdminSharingSettings, token?: string): Promise<AdminSharingSettings>;
  listAdminUsers(token?: string): Promise<AdminUser[]>;
  performAdminUserAction(userId: string, action: "approve" | "activate" | "disable" | "delete", token?: string): Promise<AdminUser>;
  updateAdminUserRoles(userId: string, roles: string[], token?: string): Promise<AdminUser>;
  listAdminProviders(token?: string): Promise<AdminProviderConfig[]>;
  upsertAdminProvider(key: string, input: UpsertAdminProviderInput, token?: string): Promise<AdminProviderConfig>;
  listAdminAudit(limit?: number, token?: string): Promise<AdminAuditEvent[]>;
  submitArchive(input: SubmitArchiveInput, token?: string): Promise<SubmitSkillResult>;
  listReviewSubmissions(token?: string): Promise<ReviewSubmissionSummary[]>;
  performReviewAction(submissionId: string, action: "approve" | "publish", reason?: string, token?: string): Promise<ReviewActionResult>;
  listTeams(token?: string): Promise<TeamDashboard>;
  createTeam(name: string, token?: string): Promise<TeamRecord>;
  inviteTeamMember(teamId: string, email: string, token?: string): Promise<TeamInvitation>;
  acceptTeamInvitation(invitationId: string, token?: string): Promise<TeamInvitation>;
  listTeamSharedSkills(token?: string): Promise<TeamSharedSkillGroup[]>;
  getSkillSharing(slug: string, token?: string): Promise<SkillSharingDetails>;
  updateSkillSharing(input: {
    slug: string;
    visibility: VisibilityScope;
    teamIds: string[];
    userEmails: string[];
  }, token?: string): Promise<SkillSharingDetails>;
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
    async registerWithInvitation(input) {
      return requestJson<{ status: "pending" | "active" }>(fetchImpl, `${root}/v1/auth/register`, {
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
    async createRegistrationInvitation(input, overrideToken) {
      const body = await requestJson<{ invitation: RegistrationInvitation }>(
        fetchImpl,
        `${root}/v1/admin/registration/invitations`,
        { method: "POST", body: input, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async getAdminSharing(overrideToken) {
      const body = await requestJson<{ sharing: AdminSharingSettings }>(
        fetchImpl,
        `${root}/v1/admin/sharing`,
        { token: overrideToken ?? token },
      );
      return body.sharing;
    },
    async updateAdminSharing(settings, overrideToken) {
      const body = await requestJson<{ sharing: AdminSharingSettings }>(
        fetchImpl,
        `${root}/v1/admin/sharing`,
        { method: "PUT", body: settings, token: overrideToken ?? token },
      );
      return body.sharing;
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
    async updateAdminUserRoles(userId, roles, overrideToken) {
      const body = await requestJson<{ user: AdminUser }>(
        fetchImpl,
        `${root}/v1/admin/users/${encodeURIComponent(userId)}/roles`,
        { method: "PUT", body: { roles }, token: overrideToken ?? token },
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
    async submitArchive(input, overrideToken) {
      return requestJson<SubmitSkillResult>(fetchImpl, `${root}/v1/submissions`, {
        method: "POST",
        body: {
          archive: {
            filename: input.filename,
            contentBase64: input.contentBase64,
          },
        },
        token: overrideToken ?? token,
      });
    },
    async listReviewSubmissions(overrideToken) {
      const body = await requestJson<{ submissions: ReviewSubmissionSummary[] }>(
        fetchImpl,
        `${root}/v1/review/submissions`,
        { token: overrideToken ?? token },
      );
      return body.submissions;
    },
    async performReviewAction(submissionId, action, reason, overrideToken) {
      const body = await requestJson<{ submission: ReviewActionResult }>(
        fetchImpl,
        `${root}/v1/review/submissions/${encodeURIComponent(submissionId)}/actions`,
        {
          method: "POST",
          body: {
            action,
            ...(reason?.trim() ? { reason: reason.trim() } : {}),
          },
          token: overrideToken ?? token,
        },
      );
      return body.submission;
    },
    async listTeams(overrideToken) {
      return requestJson<TeamDashboard>(fetchImpl, `${root}/v1/teams`, {
        token: overrideToken ?? token,
      });
    },
    async createTeam(name, overrideToken) {
      const body = await requestJson<{ team: TeamRecord }>(fetchImpl, `${root}/v1/teams`, {
        method: "POST",
        body: { name },
        token: overrideToken ?? token,
      });
      return body.team;
    },
    async inviteTeamMember(teamId, email, overrideToken) {
      const body = await requestJson<{ invitation: TeamInvitation }>(
        fetchImpl,
        `${root}/v1/teams/${encodeURIComponent(teamId)}/invitations`,
        { method: "POST", body: { email }, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async acceptTeamInvitation(invitationId, overrideToken) {
      const body = await requestJson<{ invitation: TeamInvitation }>(
        fetchImpl,
        `${root}/v1/teams/invitations/${encodeURIComponent(invitationId)}/accept`,
        { method: "POST", body: {}, token: overrideToken ?? token },
      );
      return body.invitation;
    },
    async listTeamSharedSkills(overrideToken) {
      const body = await requestJson<{ teams: TeamSharedSkillGroup[] }>(
        fetchImpl,
        `${root}/v1/teams/shared-skills`,
        { token: overrideToken ?? token },
      );
      return body.teams;
    },
    async getSkillSharing(slug, overrideToken) {
      const body = await requestJson<{ sharing: SkillSharingDetails }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(slug)}/sharing`,
        { token: overrideToken ?? token },
      );
      return body.sharing;
    },
    async updateSkillSharing(input, overrideToken) {
      const body = await requestJson<{ sharing: SkillSharingDetails }>(
        fetchImpl,
        `${root}/v1/skills/${encodeURIComponent(input.slug)}/sharing`,
        {
          method: "PUT",
          body: {
            visibility: input.visibility,
            teamIds: input.teamIds,
            userEmails: input.userEmails,
          },
          token: overrideToken ?? token,
        },
      );
      return body.sharing;
    },
  };
}

export function exportCommand(slug: string, version: string, platform: string): string {
  return `myskills export ${slug} --version ${version} --platform ${platform} --output ./skills/${slug}`;
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

export function safeSubmitErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Submission requires an authorized author session. Privileged roles must complete MFA.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Submission could not be accepted.";
  }
  return "Submission service is not available.";
}

export function safeReviewErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Review access requires an MFA-verified maintainer session.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Review action could not be completed.";
  }
  return "Review queue is not available.";
}

export function safeTeamErrorMessage(error: unknown): string {
  if (isSafeApiError(error) && (error.status === 401 || error.status === 403)) {
    return "Team access requires a signed-in session with team sharing enabled.";
  }
  if (isSafeApiError(error) && error.status >= 400 && error.status < 500) {
    return "Team change could not be saved.";
  }
  return "Team data is not available.";
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
