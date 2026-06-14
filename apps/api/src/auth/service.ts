import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AppError } from "@myskills-app/core";
import {
  createApiToken,
  createRecoveryCodes,
  createSessionToken,
  createTotpSecret,
  createTotpUri,
  hashRecoveryCode,
  hashApiToken,
  hashPassword,
  hashSessionToken,
  validatePasswordInput,
  verifyTotpCode,
  verifyPassword,
  canAdmin,
  roles as authRoles,
  type AuthenticatedUser,
  type RegistrationMode,
  type Role,
  type UserStatus,
} from "@myskills-app/auth";
import type { AuthRateLimiter } from "./rate-limit.js";
import {
  apiTokenScopes,
  type AuditDecision,
  type AuditEventRecord,
  type ApiTokenRecord,
  type AdminApiTokenRecord,
  type ApiTokenScope,
  type AuthActionTokenPurpose,
  type AuthResponseUser,
  type AuthStore,
  type AuthUserRecord,
  type MfaTotpFactorRecord,
  providerTypes,
  type ProviderConfigRecord,
  type ProviderMappedRole,
  type ProviderRoleMappingRecord,
  type ProviderType,
} from "./types.js";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_MFA_CHALLENGE_TTL_MS = 1000 * 60 * 5;
const DEFAULT_EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
const DEFAULT_PASSWORD_RESET_TTL_MS = 1000 * 60 * 60;
const DEFAULT_API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const API_TOKEN_PREFIX_LENGTH = 12;
const DEFAULT_TOTP_ISSUER = "MySkills";
const DEV_AUTH_SECRET = "dev-only-myskills-app-auth-secret-change-before-production";

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
  ip?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  ip?: string;
}

export type LoginResult =
  | { mfaRequired: false; token: string; expiresAt: string; user: AuthResponseUser }
  | { mfaRequired: true; challengeToken: string; expiresAt: string; user: AuthResponseUser };

export interface VerifyMfaChallengeInput {
  challengeToken: string;
  code?: string;
  recoveryCode?: string;
  ip?: string;
}

export interface RequestEmailVerificationInput {
  email: string;
  ip?: string;
}

export interface ConfirmEmailVerificationInput {
  token: string;
  ip?: string;
}

export interface RequestPasswordResetInput {
  email: string;
  ip?: string;
}

export interface ConfirmPasswordResetInput {
  token: string;
  password: string;
  ip?: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  password: string;
  ip?: string;
}

export interface RequestEmailChangeInput {
  email: string;
  password: string;
  ip?: string;
}

export interface ConfirmEmailChangeInput {
  token: string;
  ip?: string;
}

export interface AuthActionNotification {
  user: AuthUserRecord;
  email: string;
  token: string;
  expiresAt: Date;
}

export interface AuthNotificationSink {
  sendEmailVerification(input: AuthActionNotification): Promise<void> | void;
  sendPasswordReset(input: AuthActionNotification): Promise<void> | void;
  sendEmailChangeVerification(input: AuthActionNotification): Promise<void> | void;
}

export interface CreateApiTokenRequest {
  name: string;
  scopes: ApiTokenScope[];
  expiresAt?: string;
}

export interface SafeApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiToken extends SafeApiToken {
  token: string;
}

export interface SafeAdminApiToken extends SafeApiToken {
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    roles: string[];
  };
}

export interface MfaStatus {
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  factors: SafeMfaFactor[];
}

export interface SafeMfaFactor {
  id: string;
  type: "totp";
  status: "pending" | "enabled" | "disabled";
  label: string;
  enabledAt: string | null;
  createdAt: string;
}

export interface StartTotpEnrollmentInput {
  password: string;
  label?: string;
}

export interface TotpEnrollment {
  factorId: string;
  label: string;
  secret: string;
  otpauthUrl: string;
}

export interface ConfirmTotpEnrollmentInput {
  factorId: string;
  code: string;
}

export interface ConfirmTotpEnrollmentResult {
  factor: SafeMfaFactor;
  recoveryCodes: string[];
}

export interface DisableTotpMfaInput {
  password: string;
}

export interface AdminRegistrationSettings {
  mode: RegistrationMode;
}

export interface UpdateRegistrationSettingsInput {
  mode: RegistrationMode;
}

export interface ProviderRoleMappingInput {
  claim: string;
  value: string;
  role: string;
}

export interface UpsertProviderConfigRequest {
  key: string;
  type: string;
  displayName: string;
  issuer?: string;
  clientId?: string;
  enabled?: boolean;
  roleMappings?: ProviderRoleMappingInput[];
}

export interface SafeProviderConfig {
  key: string;
  type: ProviderType;
  displayName: string;
  issuer: string | null;
  clientId: string | null;
  enabled: boolean;
  roleMappings: ProviderRoleMappingRecord[];
}

export type AdminUserAction = "approve" | "activate" | "disable" | "delete";

export interface AdminUserActionInput {
  userId: string;
  action: AdminUserAction;
  reason?: string;
}

export interface AdminUserRoleUpdateInput {
  userId: string;
  roles: Role[];
  reason?: string;
}

export interface SafeAdminUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  roles: AuthenticatedUser["roles"];
  emailVerified: boolean;
  mfaEnabled: boolean;
}

export interface SafeAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ListAdminAuditEventsInput {
  limit?: number;
}

export type McpSessionCredentialKind = "none" | "session" | "api";
export type McpSessionAuditReason =
  | "missing_bearer"
  | "invalid_bearer"
  | "api_credential_required"
  | "missing_scope"
  | "authorized";

export interface RecordMcpSessionDecisionInput {
  context: AuthContext | null;
  credentialKind: McpSessionCredentialKind;
  decision: AuditDecision;
  reason: McpSessionAuditReason;
}

export interface AuthContext {
  user: AuthResponseUser;
  credential: {
    kind: "session" | "api_token";
    scopes: ApiTokenScope[];
    tokenId?: string;
  };
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly options: {
      sessionTtlMs?: number;
      mfaChallengeTtlMs?: number;
      mfaSecretKey?: string;
      totpIssuer?: string;
      loginLimiter?: AuthRateLimiter;
      registrationLimiter?: AuthRateLimiter;
      mfaLimiter?: AuthRateLimiter;
      emailVerificationLimiter?: AuthRateLimiter;
      passwordResetLimiter?: AuthRateLimiter;
      authActionTokenLimiter?: AuthRateLimiter;
      emailVerificationTtlMs?: number;
      passwordResetTtlMs?: number;
      notificationSink?: AuthNotificationSink;
    } = {},
  ) {}

  async register(input: RegisterInput): Promise<{ status: "pending" }> {
    const mode = await this.store.getRegistrationMode();
    if (mode === "closed") {
      throw new AppError("Registration is closed.", "REGISTRATION_CLOSED", 403);
    }

    const email = normalizeEmail(input.email);
    assertAllowed(this.options.registrationLimiter, rateLimitKeys("register", email, input.ip));
    const passwordHash = await this.hashNewPassword(input.password);
    const created = await this.store.createUserWithPassword({
      email,
      name: cleanName(input.name),
      passwordHash,
    });
    if (created.user) {
      await this.sendAuthActionToken(created.user, "email_verification");
    }
    return { status: "pending" };
  }

  async requestEmailVerification(input: RequestEmailVerificationInput): Promise<{ status: "pending" }> {
    const email = normalizeEmail(input.email);
    assertAllowed(this.options.emailVerificationLimiter, rateLimitKeys("email-verification", email, input.ip));
    const user = await this.store.findUserByEmailWithPassword(email);
    if (user && shouldIssueEmailVerification(user)) {
      await this.sendAuthActionToken(user, "email_verification");
    }
    return { status: "pending" };
  }

  async confirmEmailVerification(input: ConfirmEmailVerificationInput): Promise<{ status: "verified" }> {
    const token = cleanOpaqueToken(input.token, "token");
    const tokenHash = hashSessionToken(token);
    assertAllowed(
      this.options.authActionTokenLimiter ?? this.options.emailVerificationLimiter,
      tokenRateLimitKeys("email-verification-confirm", tokenHash, input.ip),
    );
    const consumed = await this.store.consumeAuthActionToken({
      tokenHash,
      purpose: "email_verification",
      now: new Date(),
    });
    if (!consumed || consumed.user.status === "disabled" || consumed.user.status === "deleted") {
      throw invalidVerificationToken();
    }
    if (!consumed.user.emailVerifiedAt) {
      const verifiedAt = consumed.usedAt ?? new Date();
      await this.store.updateUserStatus({
        userId: consumed.user.id,
        status: consumed.user.status,
        emailVerifiedAt: verifiedAt,
      });
    }
    return { status: "verified" };
  }

  async requestPasswordReset(input: RequestPasswordResetInput): Promise<{ status: "pending" }> {
    const email = normalizeEmail(input.email);
    assertAllowed(this.options.passwordResetLimiter, rateLimitKeys("password-reset", email, input.ip));
    const user = await this.store.findUserByEmailWithPassword(email);
    if (user?.passwordHash && isUsableAuthenticatedAccount(user)) {
      await this.sendAuthActionToken(user, "password_reset");
    }
    return { status: "pending" };
  }

  async confirmPasswordReset(input: ConfirmPasswordResetInput): Promise<{ status: "reset" }> {
    const token = cleanOpaqueToken(input.token, "token");
    const tokenHash = hashSessionToken(token);
    assertAllowed(
      this.options.authActionTokenLimiter ?? this.options.passwordResetLimiter,
      tokenRateLimitKeys("password-reset-confirm", tokenHash, input.ip),
    );
    const passwordHash = await this.hashNewPassword(input.password);
    const consumed = await this.store.consumeAuthActionToken({
      tokenHash,
      purpose: "password_reset",
      now: new Date(),
    });
    if (!consumed || !isUsableAuthenticatedAccount(consumed.user)) {
      throw invalidResetToken();
    }
    const updated = await this.store.updatePasswordCredential({
      userId: consumed.user.id,
      passwordHash,
      passwordUpdatedAt: consumed.usedAt ?? new Date(),
    });
    if (!updated) {
      throw invalidResetToken();
    }
    await this.store.revokeUserCredentials(consumed.user.id);
    return { status: "reset" };
  }

  async changePassword(actor: AuthResponseUser, input: ChangePasswordInput): Promise<{ status: "changed" }> {
    assertAllowed(this.options.passwordResetLimiter, rateLimitKeys("password-change", actor.email, input.ip));
    await this.assertCanManageAccount(actor, input.currentPassword);
    const passwordHash = await this.hashNewPassword(input.password);
    const updated = await this.store.updatePasswordCredential({
      userId: actor.id,
      passwordHash,
      passwordUpdatedAt: new Date(),
    });
    if (!updated) {
      throw new AppError("Password credential not found.", "PASSWORD_CREDENTIAL_NOT_FOUND", 404);
    }
    await this.store.revokeUserCredentials(actor.id);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "account.password.change",
      decision: "allow",
      resourceType: "user",
      resourceId: actor.id,
      details: {
        credentialsRevoked: true,
      },
    });
    return { status: "changed" };
  }

  async requestEmailChange(actor: AuthResponseUser, input: RequestEmailChangeInput): Promise<{ status: "pending" }> {
    const email = normalizeEmail(input.email);
    assertAllowed(this.options.emailVerificationLimiter, rateLimitKeys("email-change", email, input.ip));
    await this.assertCanManageAccount(actor, input.password);
    if (email === actor.email) {
      throw new AppError("New email address must be different.", "EMAIL_UNCHANGED", 400);
    }
    const existing = await this.store.findUserByEmailWithPassword(email);
    if (existing && existing.id !== actor.id) {
      throw new AppError("Email address is already in use.", "EMAIL_ALREADY_IN_USE", 409);
    }
    await this.sendAuthActionToken(asAuthUserRecord(actor), "email_change", email);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "account.email_change.request",
      decision: "allow",
      resourceType: "user",
      resourceId: actor.id,
      details: {
        targetEmail: email,
      },
    });
    return { status: "pending" };
  }

  async confirmEmailChange(input: ConfirmEmailChangeInput): Promise<{ status: "changed" }> {
    const token = cleanOpaqueToken(input.token, "token");
    const tokenHash = hashSessionToken(token);
    assertAllowed(
      this.options.authActionTokenLimiter ?? this.options.emailVerificationLimiter,
      tokenRateLimitKeys("email-change-confirm", tokenHash, input.ip),
    );
    const consumed = await this.store.consumeAuthActionToken({
      tokenHash,
      purpose: "email_change",
      now: new Date(),
    });
    if (!consumed || !isUsableAuthenticatedAccount(consumed.user)) {
      throw invalidVerificationToken();
    }
    const email = consumed.sentToNormalizedEmail;
    const existing = await this.store.findUserByEmailWithPassword(email);
    if (existing && existing.id !== consumed.user.id) {
      throw new AppError("Email address is already in use.", "EMAIL_ALREADY_IN_USE", 409);
    }
    const changedAt = consumed.usedAt ?? new Date();
    const updated = await this.store.updateUserEmail({
      userId: consumed.user.id,
      email,
      emailVerifiedAt: changedAt,
    });
    if (!updated) {
      throw invalidVerificationToken();
    }
    await this.store.revokeUserCredentials(consumed.user.id);
    await this.store.recordAuditEvent({
      actorUserId: consumed.user.id,
      action: "account.email_change.confirm",
      decision: "allow",
      resourceType: "user",
      resourceId: consumed.user.id,
      details: {
        previousEmail: consumed.user.email,
        newEmail: email,
        credentialsRevoked: true,
      },
    });
    return { status: "changed" };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    assertAllowed(this.options.loginLimiter, rateLimitKeys("login", email, input.ip));
    const user = await this.store.findUserByEmailWithPassword(email);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new AppError("Invalid email or password.", "INVALID_CREDENTIALS", 401);
    }
    if (user.status !== "active" || !user.emailVerifiedAt) {
      throw new AppError("Account is not active.", "ACCOUNT_NOT_ACTIVE", 403);
    }
    if (await this.store.countEnabledMfaFactors(user.id) > 0) {
      const challengeToken = createSessionToken();
      const expiresAt = new Date(Date.now() + (this.options.mfaChallengeTtlMs ?? DEFAULT_MFA_CHALLENGE_TTL_MS));
      await this.store.createMfaChallenge({
        userId: user.id,
        tokenHash: hashSessionToken(challengeToken),
        expiresAt,
      });
      return {
        mfaRequired: true,
        challengeToken,
        expiresAt: expiresAt.toISOString(),
        user: responseUser(user, false),
      };
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + (this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS));
    await this.store.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    return {
      mfaRequired: false,
      token,
      expiresAt: expiresAt.toISOString(),
      user: responseUser(user, false),
    };
  }

  async verifyMfaChallenge(input: VerifyMfaChallengeInput): Promise<{ token: string; expiresAt: string; user: AuthResponseUser }> {
    const challengeToken = cleanOpaqueToken(input.challengeToken, "challengeToken");
    const challengeHash = hashSessionToken(challengeToken);
    assertAllowed(this.options.mfaLimiter, rateLimitKeys("mfa", challengeHash, input.ip));

    const challenge = await this.store.findMfaChallengeByTokenHash(challengeHash);
    if (!challenge || !isUsableAuthenticatedAccount(challenge.user)) {
      throw invalidMfaCode();
    }
    const verifiedAt = new Date();
    const valid = input.recoveryCode
      ? await this.verifyRecoveryCode(challenge.user.id, input.recoveryCode)
      : await this.verifyTotpForUser(challenge.user.id, input.code);
    if (!valid) {
      throw invalidMfaCode();
    }

    await this.store.markMfaChallengeUsed({ challengeId: challenge.id, usedAt: verifiedAt });
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + (this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS));
    await this.store.createSession({
      userId: challenge.user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      mfaVerifiedAt: verifiedAt,
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: responseUser(challenge.user, true),
    };
  }

  async authenticateAuthorizationHeader(header: string | undefined): Promise<AuthResponseUser | null> {
    return (await this.authenticateRequest(header))?.user ?? null;
  }

  async authenticateRequest(header: string | undefined): Promise<AuthContext | null> {
    const token = bearerToken(header);
    if (!token) {
      return null;
    }
    const sessionUser = await this.store.findUserBySessionTokenHash(hashSessionToken(token));
    if (sessionUser && isUsableAuthenticatedAccount(sessionUser)) {
      return {
        user: responseUser(sessionUser, Boolean(sessionUser.sessionMfaVerifiedAt)),
        credential: {
          kind: "session",
          scopes: [...apiTokenScopes],
        },
      };
    }
    const apiTokenUser = await this.store.findUserByApiTokenHash(hashApiToken(token));
    if (apiTokenUser && isUsableAuthenticatedAccount(apiTokenUser)) {
      return {
        user: responseUser(apiTokenUser, Boolean(apiTokenUser.apiTokenMfaVerifiedAt)),
        credential: {
          kind: "api_token",
          tokenId: apiTokenUser.apiTokenId,
          scopes: apiTokenUser.apiTokenScopes,
        },
      };
    }
    return null;
  }

  async authenticateSessionAuthorizationHeader(header: string | undefined): Promise<AuthResponseUser | null> {
    const token = bearerToken(header);
    if (!token) {
      return null;
    }
    const user = await this.store.findUserBySessionTokenHash(hashSessionToken(token));
    return user && isUsableAuthenticatedAccount(user) ? responseUser(user, Boolean(user.sessionMfaVerifiedAt)) : null;
  }

  async logout(header: string | undefined): Promise<void> {
    const token = bearerToken(header);
    if (token) {
      await this.store.revokeSessionByTokenHash(hashSessionToken(token));
    }
  }

  async createApiToken(actor: AuthResponseUser, input: CreateApiTokenRequest): Promise<CreatedApiToken> {
    const token = createApiToken();
    const scopes = normalizeScopes(input.scopes);
    if (requiresVerifiedMfaForApiToken(actor, scopes)) {
      throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
    }
    const expiresAt = parseApiTokenExpiry(input.expiresAt);
    const record = await this.store.createApiToken({
      userId: actor.id,
      name: cleanTokenName(input.name),
      tokenPrefix: token.slice(0, API_TOKEN_PREFIX_LENGTH),
      tokenHash: hashApiToken(token),
      scopes,
      expiresAt,
      mfaVerifiedAt: actor.mfaVerified ? new Date() : null,
    });
    return {
      ...safeApiToken(record),
      token,
    };
  }

  async listApiTokens(actor: AuthResponseUser): Promise<SafeApiToken[]> {
    return (await this.store.listApiTokensForUser(actor.id)).map(safeApiToken);
  }

  async revokeApiToken(actor: AuthResponseUser, tokenId: string): Promise<SafeApiToken> {
    const token = await this.store.revokeApiToken({ userId: actor.id, tokenId });
    if (!token) {
      throw new AppError("API token not found.", "API_TOKEN_NOT_FOUND", 404);
    }
    return safeApiToken(token);
  }

  async listAdminApiTokens(actor: AuthResponseUser): Promise<SafeAdminApiToken[]> {
    assertAdmin(actor);
    return (await this.store.listApiTokensForAdmin()).map(safeAdminApiToken);
  }

  async revokeAdminApiToken(actor: AuthResponseUser, tokenId: string): Promise<SafeAdminApiToken> {
    assertAdmin(actor);
    const token = await this.store.revokeAnyApiToken({ tokenId: cleanId(tokenId, "tokenId") });
    if (!token) {
      throw new AppError("API token not found.", "API_TOKEN_NOT_FOUND", 404);
    }
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "admin.api_token.revoke",
      decision: "allow",
      resourceType: "api_token",
      resourceId: token.id,
      details: {
        targetUserId: token.user.id,
        targetEmail: token.user.email,
        scopes: token.scopes,
      },
    });
    return safeAdminApiToken(token);
  }

  async getMfaStatus(actor: AuthResponseUser): Promise<MfaStatus> {
    const factors = await this.store.listMfaTotpFactorsForUser(actor.id);
    return {
      totpEnabled: factors.some((factor) => factor.status === "enabled"),
      recoveryCodesRemaining: await this.store.countUnusedMfaRecoveryCodes(actor.id),
      factors: factors.map(safeMfaFactor),
    };
  }

  async startTotpEnrollment(actor: AuthResponseUser, input: StartTotpEnrollmentInput): Promise<TotpEnrollment> {
    await this.assertCanManageMfa(actor, input.password);
    const secret = createTotpSecret();
    const label = cleanMfaLabel(input.label);
    const factor = await this.store.createMfaTotpFactor({
      userId: actor.id,
      label,
      secretCiphertext: encryptSecret(secret, this.mfaSecretKey()),
    });
    return {
      factorId: factor.id,
      label: factor.label,
      secret,
      otpauthUrl: createTotpUri({
        issuer: this.options.totpIssuer ?? DEFAULT_TOTP_ISSUER,
        accountName: actor.email,
        secret,
      }),
    };
  }

  async confirmTotpEnrollment(actor: AuthResponseUser, input: ConfirmTotpEnrollmentInput): Promise<ConfirmTotpEnrollmentResult> {
    await this.assertCanUseMfaManagementSession(actor);
    const factor = await this.store.findMfaTotpFactorForUser({ userId: actor.id, factorId: cleanId(input.factorId, "factorId") });
    if (!factor || factor.status !== "pending") {
      throw new AppError("MFA factor not found.", "MFA_FACTOR_NOT_FOUND", 404);
    }
    const secret = decryptSecret(factor.secretCiphertext, this.mfaSecretKey());
    const verification = verifyTotpCode(secret, input.code, { window: 1 });
    if (!verification.valid || verification.counter === undefined) {
      throw invalidMfaCode();
    }
    await this.store.disableOtherMfaTotpFactorsForUser({
      userId: actor.id,
      factorId: factor.id,
      disabledAt: new Date(),
    });
    const enabled = await this.store.enableMfaTotpFactor({
      userId: actor.id,
      factorId: factor.id,
      lastUsedCounter: verification.counter,
    });
    if (!enabled) {
      throw new AppError("MFA factor not found.", "MFA_FACTOR_NOT_FOUND", 404);
    }
    const recoveryCodes = createRecoveryCodes();
    await this.store.replaceMfaRecoveryCodes({
      userId: actor.id,
      codeHashes: recoveryCodes.map(hashRecoveryCode),
    });
    return {
      factor: safeMfaFactor(enabled),
      recoveryCodes,
    };
  }

  async disableTotpMfa(actor: AuthResponseUser, input: DisableTotpMfaInput): Promise<{ status: "disabled"; disabledFactors: number }> {
    await this.assertCanManageMfa(actor, input.password);
    const disabledFactors = await this.store.disableMfaTotpFactorsForUser({
      userId: actor.id,
      disabledAt: new Date(),
    });
    await this.store.replaceMfaRecoveryCodes({ userId: actor.id, codeHashes: [] });
    await this.store.revokeUserCredentials(actor.id);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "account.mfa.disable",
      decision: "allow",
      resourceType: "user",
      resourceId: actor.id,
      details: {
        disabledFactors,
        recoveryCodesRemoved: true,
        credentialsRevoked: true,
      },
    });
    return { status: "disabled", disabledFactors };
  }

  async getRegistrationSettings(actor: AuthResponseUser): Promise<AdminRegistrationSettings> {
    assertAdmin(actor);
    return { mode: await this.store.getRegistrationMode() };
  }

  async updateRegistrationSettings(actor: AuthResponseUser, input: UpdateRegistrationSettingsInput): Promise<AdminRegistrationSettings> {
    assertAdmin(actor);
    const oldMode = await this.store.getRegistrationMode();
    const mode = normalizeRegistrationMode(input.mode);
    const nextMode = await this.store.setRegistrationMode(mode);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "admin.registration.update",
      decision: "allow",
      resourceType: "instance_setting",
      details: {
        setting: "registration",
        oldMode,
        newMode: nextMode,
      },
    });
    return { mode: nextMode };
  }

  async listAdminProviderConfigs(actor: AuthResponseUser): Promise<SafeProviderConfig[]> {
    assertAdmin(actor);
    return (await this.store.listProviderConfigs()).map(safeProviderConfig);
  }

  async upsertAdminProviderConfig(actor: AuthResponseUser, input: UpsertProviderConfigRequest): Promise<SafeProviderConfig> {
    assertAdmin(actor);
    const provider = normalizeProviderConfigInput(input);
    const saved = await this.store.upsertProviderConfig(provider);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "admin.provider.upsert",
      decision: "allow",
      resourceType: "provider_config",
      resourceId: saved.id,
      details: {
        providerKey: saved.key,
        type: saved.type,
        enabled: saved.enabled,
        mappingCount: saved.roleMappings.length,
      },
    });
    return safeProviderConfig(saved);
  }

  async listAdminUsers(actor: AuthResponseUser): Promise<SafeAdminUser[]> {
    assertAdmin(actor);
    const users = await this.store.listUsers();
    return Promise.all(users.map((user) => this.safeAdminUser(user)));
  }

  async performAdminUserAction(actor: AuthResponseUser, input: AdminUserActionInput): Promise<SafeAdminUser> {
    assertAdmin(actor);
    const action = normalizeAdminUserAction(input.action);
    const userId = cleanId(input.userId, "userId");
    const target = await this.store.findUserById(userId);
    if (!target) {
      await this.recordAdminUserDeny(actor, action, userId, "user_not_found", input.reason);
      throw new AppError("User not found.", "USER_NOT_FOUND", 404);
    }
    const blockedReason = adminUserActionBlockedReason(actor, target, action);
    if (blockedReason) {
      await this.recordAdminUserDeny(actor, action, target.id, blockedReason, input.reason, target);
      throw adminUserActionError(blockedReason);
    }
    if ((action === "disable" || action === "delete") && target.roles.includes("owner") && target.status === "active") {
      const otherOwnerCount = await this.store.countActiveOwnersExcluding(target.id);
      if (otherOwnerCount === 0) {
        await this.recordAdminUserDeny(actor, action, target.id, "last_owner_required", input.reason, target);
        throw new AppError("At least one active owner is required.", "LAST_OWNER_REQUIRED", 409);
      }
    }

    const update = adminActionUpdate(action, target);
    const updated = await this.store.updateUserStatus({
      userId: target.id,
      status: update.status,
      emailVerifiedAt: update.emailVerifiedAt,
    });
    if (!updated) {
      throw new AppError("User not found.", "USER_NOT_FOUND", 404);
    }
    if (action === "disable" || action === "delete") {
      await this.store.revokeUserCredentials(target.id);
    }
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: `admin.user.${action}`,
      decision: "allow",
      resourceType: "user",
      resourceId: target.id,
      details: {
        targetUserId: target.id,
        statusBefore: target.status,
        statusAfter: updated.status,
        emailVerifiedBefore: Boolean(target.emailVerifiedAt),
        emailVerifiedAfter: Boolean(updated.emailVerifiedAt),
        credentialsRevoked: action === "disable" || action === "delete",
        reason: input.reason,
      },
    });
    return this.safeAdminUser(updated);
  }

  async updateAdminUserRoles(actor: AuthResponseUser, input: AdminUserRoleUpdateInput): Promise<SafeAdminUser> {
    assertAdmin(actor);
    const userId = cleanId(input.userId, "userId");
    const roles = normalizeAdminUserRoles(input.roles);
    const target = await this.store.findUserById(userId);
    if (!target) {
      await this.recordAdminUserDeny(actor, "roles.update", userId, "user_not_found", input.reason);
      throw new AppError("User not found.", "USER_NOT_FOUND", 404);
    }
    const blockedReason = adminUserRoleUpdateBlockedReason(actor, target, roles);
    if (blockedReason) {
      await this.recordAdminUserDeny(actor, "roles.update", target.id, blockedReason, input.reason, target);
      throw adminUserRoleUpdateError(blockedReason);
    }
    if (target.status === "active" && target.roles.includes("owner") && !roles.includes("owner")) {
      const otherOwnerCount = await this.store.countActiveOwnersExcluding(target.id);
      if (otherOwnerCount === 0) {
        await this.recordAdminUserDeny(actor, "roles.update", target.id, "last_owner_required", input.reason, target);
        throw new AppError("At least one active owner is required.", "LAST_OWNER_REQUIRED", 409);
      }
    }

    const updated = await this.store.updateUserRoles({ userId: target.id, roles });
    if (!updated) {
      throw new AppError("User not found.", "USER_NOT_FOUND", 404);
    }
    await this.store.revokeUserCredentials(target.id);
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: "admin.user.roles.update",
      decision: "allow",
      resourceType: "user",
      resourceId: target.id,
      details: {
        targetUserId: target.id,
        rolesBefore: target.roles,
        rolesAfter: updated.roles,
        credentialsRevoked: true,
        reason: input.reason,
      },
    });
    return this.safeAdminUser(updated);
  }

  async listAdminAuditEvents(actor: AuthResponseUser, input: ListAdminAuditEventsInput = {}): Promise<SafeAuditEvent[]> {
    assertAdmin(actor);
    const events = await this.store.listAuditEvents({ limit: normalizeAuditLimit(input.limit) });
    return events.map(safeAuditEvent);
  }

  async recordMcpSessionDecision(input: RecordMcpSessionDecisionInput): Promise<void> {
    await this.store.recordAuditEvent({
      actorUserId: input.context?.user.id ?? null,
      action: "mcp.session",
      decision: input.decision,
      resourceType: "mcp_session",
      resourceId: input.context?.credential.kind === "api_token" ? input.context.credential.tokenId ?? null : null,
      details: {
        endpoint: "/v1/mcp/session",
        requiredScope: "skills:read",
        credentialKind: input.credentialKind,
        reason: input.reason,
      },
    });
  }

  private async assertCanManageMfa(actor: AuthResponseUser, password: string): Promise<void> {
    await this.assertCanManageAccount(actor, password);
  }

  private async assertCanManageAccount(actor: AuthResponseUser, password: string): Promise<void> {
    await this.assertCanUseMfaManagementSession(actor);
    const user = await this.store.findUserByEmailWithPassword(actor.email);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw new AppError("Invalid email or password.", "INVALID_CREDENTIALS", 401);
    }
  }

  private async assertCanUseMfaManagementSession(actor: AuthResponseUser): Promise<void> {
    const mfaEnabled = await this.store.countEnabledMfaFactors(actor.id);
    if (mfaEnabled > 0 && !actor.mfaVerified) {
      throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
    }
  }

  private async verifyTotpForUser(userId: string, code: string | undefined): Promise<boolean> {
    if (!code) {
      return false;
    }
    const factors = await this.store.listEnabledMfaTotpFactorsForUser(userId);
    for (const factor of factors) {
      const secret = decryptSecret(factor.secretCiphertext, this.mfaSecretKey());
      const verification = verifyTotpCode(secret, code, { window: 1 });
      if (verification.valid && verification.counter !== undefined && verification.counter > (factor.lastUsedCounter ?? -1)) {
        await this.store.updateMfaTotpFactorCounter({
          userId,
          factorId: factor.id,
          lastUsedCounter: verification.counter,
        });
        return true;
      }
    }
    return false;
  }

  private async verifyRecoveryCode(userId: string, recoveryCode: string): Promise<boolean> {
    try {
      return this.store.consumeMfaRecoveryCode({
        userId,
        codeHash: hashRecoveryCode(recoveryCode),
      });
    } catch {
      return false;
    }
  }

  private mfaSecretKey(): string {
    return this.options.mfaSecretKey ?? DEV_AUTH_SECRET;
  }

  private async sendAuthActionToken(user: AuthUserRecord, purpose: AuthActionTokenPurpose, emailOverride?: string): Promise<void> {
    const sink = this.options.notificationSink;
    if (!sink) {
      return;
    }
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + this.authActionTokenTtlMs(purpose));
    const email = emailOverride ?? user.email;
    await this.store.createAuthActionToken({
      userId: user.id,
      purpose,
      tokenHash: hashSessionToken(token),
      sentToNormalizedEmail: email,
      expiresAt,
    });
    if (purpose === "email_verification") {
      try {
        await sink.sendEmailVerification({
          user,
          email,
          token,
          expiresAt,
        });
      } catch {
        // Public auth action request endpoints must not reveal account existence during delivery outages.
      }
      return;
    }
    if (purpose === "email_change") {
      try {
        await sink.sendEmailChangeVerification({
          user,
          email,
          token,
          expiresAt,
        });
      } catch {
        // Account action request endpoints must not leak delivery failures to callers.
      }
      return;
    }
    try {
      await sink.sendPasswordReset({
        user,
        email,
        token,
        expiresAt,
      });
    } catch {
      // Public auth action request endpoints must not reveal account existence during delivery outages.
    }
  }

  private authActionTokenTtlMs(purpose: AuthActionTokenPurpose): number {
    return purpose === "email_verification" || purpose === "email_change"
      ? this.options.emailVerificationTtlMs ?? DEFAULT_EMAIL_VERIFICATION_TTL_MS
      : this.options.passwordResetTtlMs ?? DEFAULT_PASSWORD_RESET_TTL_MS;
  }

  private async hashNewPassword(password: string): Promise<string> {
    try {
      validatePasswordInput(password);
      return await hashPassword(password);
    } catch (error) {
      if (error instanceof Error) {
        throw new AppError(error.message, "INVALID_PASSWORD", 400);
      }
      throw error;
    }
  }

  private async safeAdminUser(user: AuthUserRecord): Promise<SafeAdminUser> {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      roles: user.roles,
      emailVerified: Boolean(user.emailVerifiedAt),
      mfaEnabled: await this.store.countEnabledMfaFactors(user.id) > 0,
    };
  }

  private async recordAdminUserDeny(
    actor: AuthResponseUser,
    action: AdminUserAction | "roles.update",
    targetUserId: string,
    reason: string,
    operatorReason?: string,
    target?: AuthUserRecord,
  ): Promise<void> {
    await this.store.recordAuditEvent({
      actorUserId: actor.id,
      action: `admin.user.${action}`,
      decision: "deny",
      resourceType: "user",
      resourceId: targetUserId,
      details: {
        targetUserId,
        reason,
        statusBefore: target?.status,
        emailVerifiedBefore: target ? Boolean(target.emailVerifiedAt) : undefined,
        operatorReason,
      },
    });
  }
}

function responseUser(user: AuthUserRecord, mfaVerified: boolean): AuthResponseUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    roles: user.roles,
    emailVerified: Boolean(user.emailVerifiedAt),
    mfaVerified,
  };
}

function asAuthUserRecord(user: AuthResponseUser): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    roles: user.roles,
    emailVerifiedAt: user.emailVerified ? new Date() : null,
  };
}

function isUsableAuthenticatedAccount(user: AuthUserRecord): boolean {
  return user.status === "active" && Boolean(user.emailVerifiedAt);
}

function shouldIssueEmailVerification(user: AuthUserRecord): boolean {
  return !user.emailVerifiedAt && user.status !== "disabled" && user.status !== "deleted";
}

function assertAllowed(limiter: AuthRateLimiter | undefined, keys: string[]): void {
  if (!limiter) {
    return;
  }
  for (const key of keys) {
    const result = limiter.consume(key);
    if (!result.allowed) {
      throw new AppError("Too many attempts. Try again later.", "RATE_LIMITED", 429);
    }
  }
}

function rateLimitKeys(kind: string, email: string, ip: string | undefined): string[] {
  const source = ip?.trim() || "unknown";
  return [
    `${kind}:ip:${source}`,
    `${kind}:ip-email:${source}:${email}`,
  ];
}

function tokenRateLimitKeys(kind: string, tokenHash: string, ip: string | undefined): string[] {
  const source = ip?.trim() || "unknown";
  return [
    `${kind}:ip:${source}`,
    `${kind}:ip-token:${source}:${tokenHash}`,
  ];
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeEmail(email: string): string {
  if (typeof email !== "string") {
    throw new AppError("A valid email address is required.", "INVALID_EMAIL", 400);
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AppError("A valid email address is required.", "INVALID_EMAIL", 400);
  }
  return normalized;
}

function cleanName(name: string | undefined): string {
  if (name !== undefined && typeof name !== "string") {
    throw new AppError("Name must be a string.", "INVALID_NAME", 400);
  }
  return (name ?? "").trim().slice(0, 120);
}

function cleanTokenName(name: string): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new AppError("Token name is required.", "INVALID_TOKEN_NAME", 400);
  }
  return name.trim().slice(0, 80);
}

function cleanMfaLabel(label: string | undefined): string {
  if (label !== undefined && typeof label !== "string") {
    throw new AppError("MFA label must be a string.", "INVALID_MFA_LABEL", 400);
  }
  const cleaned = (label ?? "Authenticator app").trim().slice(0, 80);
  return cleaned || "Authenticator app";
}

function cleanId(id: string, field: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new AppError(`${field} is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  return id;
}

function cleanOpaqueToken(token: string, field: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token.trim())) {
    throw new AppError(`${field} is invalid.`, "INVALID_REQUEST_BODY", 400);
  }
  return token.trim();
}

function assertAdmin(actor: AuthResponseUser): void {
  if (!actor.roles.some((role) => role === "owner" || role === "admin")) {
    throw new AppError("Admin privileges are required.", "ADMIN_ROLE_REQUIRED", 403);
  }
  if (!actor.mfaVerified || !canAdmin(asAuthenticatedUser(actor))) {
    throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
  }
}

function adminUserActionBlockedReason(actor: AuthResponseUser, target: AuthUserRecord, action: AdminUserAction): string | null {
  if (target.status === "deleted" && action !== "delete") {
    return "user_deleted";
  }
  if ((action === "disable" || action === "delete") && actor.id === target.id) {
    return "self_lockout_prevented";
  }
  if (target.roles.includes("owner") && !actor.roles.includes("owner")) {
    return "owner_action_requires_owner";
  }
  return null;
}

function adminUserActionError(reason: string): AppError {
  if (reason === "user_deleted") {
    return new AppError("Deleted users cannot be modified.", "USER_DELETED", 409);
  }
  if (reason === "self_lockout_prevented") {
    return new AppError("Admins cannot disable or delete their own account.", "SELF_LOCKOUT_PREVENTED", 409);
  }
  return new AppError("Owner accounts can only be modified by owners.", "OWNER_ACTION_REQUIRES_OWNER", 403);
}

function adminUserRoleUpdateBlockedReason(actor: AuthResponseUser, target: AuthUserRecord, roles: Role[]): string | null {
  if (target.status === "deleted") {
    return "user_deleted";
  }
  if (actor.id === target.id) {
    return "self_role_change_prevented";
  }
  const actorIsOwner = actor.roles.includes("owner");
  const targetHasPrivilegedRole = target.roles.some(isOwnerOrAdminRole);
  const requestedHasPrivilegedRole = roles.some(isOwnerOrAdminRole);
  if ((targetHasPrivilegedRole || requestedHasPrivilegedRole) && !actorIsOwner) {
    return "owner_role_update_requires_owner";
  }
  return null;
}

function adminUserRoleUpdateError(reason: string): AppError {
  if (reason === "user_deleted") {
    return new AppError("Deleted users cannot be modified.", "USER_DELETED", 409);
  }
  if (reason === "self_role_change_prevented") {
    return new AppError("Admins cannot change their own roles.", "SELF_ROLE_CHANGE_PREVENTED", 409);
  }
  return new AppError("Owner and admin role changes require an owner.", "OWNER_ROLE_UPDATE_REQUIRES_OWNER", 403);
}

function adminActionUpdate(action: AdminUserAction, target: AuthUserRecord): { status: UserStatus; emailVerifiedAt?: Date | null } {
  if (action === "approve") {
    return { status: "active" };
  }
  if (action === "activate") {
    return { status: "active" };
  }
  if (action === "disable") {
    return { status: "disabled" };
  }
  return { status: "deleted" };
}

function normalizeRegistrationMode(mode: RegistrationMode): RegistrationMode {
  if (mode === "closed" || mode === "request" || mode === "open") {
    return mode;
  }
  throw new AppError("Registration mode is invalid.", "INVALID_REGISTRATION_MODE", 400);
}

function normalizeProviderConfigInput(input: UpsertProviderConfigRequest): {
  key: string;
  type: ProviderType;
  displayName: string;
  issuer: string | null;
  clientId: string | null;
  enabled: boolean;
  roleMappings: ProviderRoleMappingRecord[];
} {
  return {
    key: normalizeProviderKey(input.key),
    type: normalizeProviderType(input.type),
    displayName: cleanProviderDisplayName(input.displayName),
    issuer: cleanOptionalProviderUrl(input.issuer, "issuer"),
    clientId: cleanOptionalProviderText(input.clientId, "clientId", 160),
    enabled: input.enabled ?? false,
    roleMappings: normalizeProviderRoleMappings(input.roleMappings ?? []),
  };
}

function normalizeProviderKey(key: string): string {
  if (typeof key !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key.trim())) {
    throw new AppError("Provider key is invalid.", "INVALID_PROVIDER_CONFIG", 400);
  }
  return key.trim();
}

function normalizeProviderType(type: string): ProviderType {
  const cleaned = typeof type === "string" ? type.trim() : "";
  if ((providerTypes as readonly string[]).includes(cleaned)) {
    return cleaned as ProviderType;
  }
  throw new AppError("Provider type is invalid.", "INVALID_PROVIDER_CONFIG", 400);
}

function cleanProviderDisplayName(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("Provider display name is required.", "INVALID_PROVIDER_CONFIG", 400);
  }
  return value.trim().slice(0, 80);
}

function cleanOptionalProviderUrl(value: string | undefined, field: string): string | null {
  if (value === undefined || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") {
      throw new Error("Provider URL must use HTTPS.");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new AppError(`${field} must be an HTTPS URL.`, "INVALID_PROVIDER_CONFIG", 400);
  }
}

function cleanOptionalProviderText(value: string | undefined, field: string, maxLength: number): string | null {
  if (value === undefined || !value.trim()) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AppError(`${field} must be a string.`, "INVALID_PROVIDER_CONFIG", 400);
  }
  return value.trim().slice(0, maxLength);
}

function normalizeProviderRoleMappings(input: ProviderRoleMappingInput[]): ProviderRoleMappingRecord[] {
  if (!Array.isArray(input)) {
    throw new AppError("Provider role mappings must be an array.", "INVALID_PROVIDER_ROLE_MAPPING", 400);
  }
  const seen = new Set<string>();
  const mappings: ProviderRoleMappingRecord[] = [];
  for (const [index, mapping] of input.entries()) {
    const claim = cleanProviderClaim(mapping?.claim, index);
    const value = cleanProviderClaimValue(mapping?.value, index);
    const role = normalizeProviderMappedRole(mapping?.role);
    const key = `${claim}:${value}:${role}`;
    if (!seen.has(key)) {
      seen.add(key);
      mappings.push({ claim, value, role });
    }
  }
  return mappings.sort(compareProviderRoleMappings);
}

function cleanProviderClaim(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.trim())) {
    throw new AppError(`Provider role mapping ${index + 1} claim is invalid.`, "INVALID_PROVIDER_ROLE_MAPPING", 400);
  }
  return value.trim();
}

function cleanProviderClaimValue(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`Provider role mapping ${index + 1} value is invalid.`, "INVALID_PROVIDER_ROLE_MAPPING", 400);
  }
  return value.trim().slice(0, 200);
}

function normalizeProviderMappedRole(role: unknown): ProviderMappedRole {
  if (role === "maintainer" || role === "author" || role === "user") {
    return role;
  }
  throw new AppError("Provider role mappings cannot grant admin or owner roles.", "INVALID_PROVIDER_ROLE_MAPPING", 400);
}

function compareProviderRoleMappings(a: ProviderRoleMappingRecord, b: ProviderRoleMappingRecord): number {
  return `${a.claim}:${a.value}:${a.role}`.localeCompare(`${b.claim}:${b.value}:${b.role}`);
}

function normalizeAdminUserAction(action: AdminUserAction): AdminUserAction {
  if (action === "approve" || action === "activate" || action === "disable" || action === "delete") {
    return action;
  }
  throw new AppError("User action is invalid.", "INVALID_ADMIN_USER_ACTION", 400);
}

function normalizeAdminUserRoles(input: unknown): Role[] {
  if (!Array.isArray(input)) {
    throw new AppError("User roles are invalid.", "INVALID_ADMIN_USER_ROLES", 400);
  }
  const seen = new Set<Role>();
  for (const item of input) {
    if (typeof item !== "string" || !isRole(item)) {
      throw new AppError("User roles are invalid.", "INVALID_ADMIN_USER_ROLES", 400);
    }
    seen.add(item);
  }
  if (seen.size === 0) {
    throw new AppError("At least one user role is required.", "INVALID_ADMIN_USER_ROLES", 400);
  }
  return authRoles.filter((role) => seen.has(role));
}

function isRole(input: string): input is Role {
  return (authRoles as readonly string[]).includes(input);
}

function isOwnerOrAdminRole(role: Role): boolean {
  return role === "owner" || role === "admin";
}

function normalizeAuditLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(input), 1), 100);
}

function safeAuditEvent(event: AuditEventRecord): SafeAuditEvent {
  return {
    id: event.id,
    actorUserId: event.actorUserId,
    action: event.action,
    decision: event.decision,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    details: event.details,
    createdAt: event.createdAt.toISOString(),
  };
}

function safeProviderConfig(provider: ProviderConfigRecord): SafeProviderConfig {
  return {
    key: provider.key,
    type: provider.type,
    displayName: provider.displayName,
    issuer: provider.issuer,
    clientId: provider.clientId,
    enabled: provider.enabled,
    roleMappings: [...provider.roleMappings].sort(compareProviderRoleMappings),
  };
}

function normalizeScopes(scopes: ApiTokenScope[]): ApiTokenScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new AppError("At least one token scope is required.", "INVALID_TOKEN_SCOPES", 400);
  }
  const allowed = new Set<ApiTokenScope>(apiTokenScopes);
  const result: ApiTokenScope[] = [];
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new AppError("Unsupported token scope.", "INVALID_TOKEN_SCOPES", 400);
    }
    if (!result.includes(scope)) {
      result.push(scope);
    }
  }
  return result;
}

function parseApiTokenExpiry(input: string | undefined): Date {
  const now = Date.now();
  if (!input) {
    return new Date(now + DEFAULT_API_TOKEN_TTL_MS);
  }
  const expiresAt = new Date(input);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now) {
    throw new AppError("Token expiry must be a future ISO date.", "INVALID_TOKEN_EXPIRY", 400);
  }
  if (expiresAt.getTime() - now > MAX_API_TOKEN_TTL_MS) {
    throw new AppError("Token expiry cannot be more than one year away.", "INVALID_TOKEN_EXPIRY", 400);
  }
  return expiresAt;
}

function safeApiToken(token: ApiTokenRecord): SafeApiToken {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt.toISOString(),
    revokedAt: token.revokedAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

function safeAdminApiToken(token: AdminApiTokenRecord): SafeAdminApiToken {
  return {
    ...safeApiToken(token),
    user: {
      id: token.user.id,
      email: token.user.email,
      name: token.user.name,
      status: token.user.status,
      roles: token.user.roles,
    },
  };
}

function safeMfaFactor(factor: MfaTotpFactorRecord): SafeMfaFactor {
  return {
    id: factor.id,
    type: factor.type,
    status: factor.status,
    label: factor.label,
    enabledAt: factor.enabledAt?.toISOString() ?? null,
    createdAt: factor.createdAt.toISOString(),
  };
}

function requiresVerifiedMfaForApiToken(actor: AuthResponseUser, scopes: ApiTokenScope[]): boolean {
  if (actor.mfaVerified) {
    return false;
  }
  const privilegedRole = actor.roles.some((role) => role === "owner" || role === "admin" || role === "maintainer");
  const privilegedScope = scopes.some((scope) => scope === "review:read" || scope === "review:write");
  return privilegedRole && privilegedScope;
}

function invalidMfaCode(): AppError {
  return new AppError("Invalid MFA challenge or code.", "INVALID_MFA_CODE", 401);
}

function invalidVerificationToken(): AppError {
  return new AppError("Invalid or expired verification token.", "INVALID_VERIFICATION_TOKEN", 401);
}

function invalidResetToken(): AppError {
  return new AppError("Invalid or expired reset token.", "INVALID_RESET_TOKEN", 401);
}

function encryptSecret(plaintext: string, secretKey: string): string {
  const iv = randomBytes(12);
  const key = encryptionKey(secretKey);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptSecret(encrypted: string, secretKey: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new AppError("Stored MFA secret is invalid.", "MFA_SECRET_INVALID", 500);
  }
  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secretKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptionKey(secretKey: string): Buffer {
  if (typeof secretKey !== "string" || Buffer.byteLength(secretKey, "utf8") < 32) {
    throw new AppError("AUTH_SECRET must be at least 32 bytes.", "AUTH_SECRET_REQUIRED", 500);
  }
  return createHash("sha256").update(secretKey, "utf8").digest();
}

export function asAuthenticatedUser(user: AuthResponseUser): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    roles: user.roles,
    mfaVerified: user.mfaVerified,
  };
}
