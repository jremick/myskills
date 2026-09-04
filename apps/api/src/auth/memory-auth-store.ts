import { AppError } from "@myskills-app/core";
import type { RegistrationMode, Role, UserStatus } from "@myskills-app/auth";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type {
  AuditEventRecord,
  ApiTokenRecord,
  AdminApiTokenRecord,
  ApiTokenScope,
  AuthActionTokenRecord,
  AuthActionTokenPurpose,
  AuthActionTokenWithUser,
  AuthStore,
  AuthUserRecord,
  AuthUserWithSession,
  AuthUserWithPassword,
  AuthUserWithApiToken,
  CreateAuditEventInput,
  CreateAuthActionTokenInput,
  CreateApiTokenInput,
  CreateInvitedUserInput,
  CreateInvitedUserResult,
  CreateMfaChallengeInput,
  CreateMfaTotpFactorInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
  ChangePasswordAndRevokeCredentialsInput,
  CompleteEmailChangeInput,
  CompleteEmailChangeResult,
  CompleteRegistrationInvitationInput,
  CompleteRegistrationInvitationResult,
  CompletePasswordResetInput,
  DisableMfaAndRevokeCredentialsInput,
  AdminUserStatusChangeResult,
  ProviderConfigRecord,
  ProviderRoleMappingRecord,
  UpsertProviderConfigInput,
  MfaChallengeRecord,
  MfaChallengeWithUser,
  MfaTotpFactorRecord,
  ListAuditEventsInput,
} from "./types.js";

interface MemoryUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  roles: Role[];
  passwordHash: string | null;
}

interface MemorySession {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  revokedAt: Date | null;
}

interface MemoryApiToken {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: ApiTokenScope[];
  expiresAt: Date;
  mfaVerifiedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface MemoryProviderConfig {
  id: string;
  key: string;
  type: ProviderConfigRecord["type"];
  displayName: string;
  issuer: string | null;
  clientId: string | null;
  enabled: boolean;
  roleMappings: ProviderRoleMappingRecord[];
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryMfaTotpFactor {
  id: string;
  userId: string;
  type: "totp";
  status: "pending" | "enabled" | "disabled";
  label: string;
  secretCiphertext: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  lastUsedCounter: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryMfaRecoveryCode {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

interface MemoryMfaChallenge {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

interface MemoryAuthActionToken {
  id: string;
  userId: string;
  purpose: AuthActionTokenPurpose;
  tokenHash: string;
  sentToNormalizedEmail: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

interface MemoryAuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: "allow" | "deny";
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, MemoryUser>();
  private sessions = new Map<string, MemorySession>();
  private apiTokens = new Map<string, MemoryApiToken>();
  private providerConfigs = new Map<string, MemoryProviderConfig>();
  private mfaFactors = new Map<string, MemoryMfaTotpFactor>();
  private mfaRecoveryCodes = new Map<string, MemoryMfaRecoveryCode>();
  private mfaChallenges = new Map<string, MemoryMfaChallenge>();
  private authActionTokens = new Map<string, MemoryAuthActionToken>();
  private audit = new Map<string, MemoryAuditEvent>();
  private auditSequence = 0;
  private adminMutationTail: Promise<void> = Promise.resolve();

  constructor(private registrationMode: RegistrationMode = "closed") {}

  setUserStatus(email: string, status: UserStatus): void {
    const user = this.users.get(email.toLowerCase());
    if (user) {
      user.status = status;
    }
  }

  addUser(input: {
    id?: string;
    email: string;
    name?: string;
    status?: UserStatus;
    emailVerifiedAt?: Date | null;
    roles?: Role[];
    passwordHash?: string | null;
  }): AuthUserRecord {
    const user: MemoryUser = {
      id: input.id ?? `user-${this.users.size + 1}`,
      email: input.email.toLowerCase(),
      name: input.name ?? "",
      status: input.status ?? "pending",
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      roles: input.roles ?? ["user"],
      passwordHash: input.passwordHash ?? null,
    };
    this.users.set(user.email, user);
    return toRecord(user);
  }

  async getRegistrationMode(): Promise<RegistrationMode> {
    return this.registrationMode;
  }

  async setRegistrationMode(mode: RegistrationMode, audit?: CreateAuditEventInput): Promise<RegistrationMode> {
    return this.commitAdminMutation(() => ({
      audit: audit ? { ...audit, details: { ...audit.details, oldMode: this.registrationMode, newMode: mode } } : undefined,
      commit: () => {
        this.registrationMode = mode;
        return mode;
      },
    }));
  }

  async createUserWithPassword(input: CreateUserWithPasswordInput): Promise<CreateUserWithPasswordResult> {
    const email = input.email.toLowerCase();
    const existing = this.users.get(email);
    if (existing) {
      return { created: false };
    }
    const user = this.addUser({
      email,
      name: input.name,
      status: "pending",
      roles: ["user"],
      passwordHash: input.passwordHash,
    });
    return { created: true, user };
  }

  async createInvitedUser(input: CreateInvitedUserInput): Promise<CreateInvitedUserResult | null> {
    const email = input.email.toLowerCase();
    const existing = this.users.get(email);
    if (existing) {
      if (existing.status !== "pending" || existing.passwordHash !== null) {
        return null;
      }
      return { user: toRecord(existing), created: false };
    }
    return {
      user: this.addUser({
        email,
        name: input.name,
        status: "pending",
        roles: ["user"],
        passwordHash: null,
      }),
      created: true,
    };
  }

  async deletePendingInvitedUser(input: { userId: string; email: string }): Promise<boolean> {
    const email = input.email.toLowerCase();
    const user = this.users.get(email);
    if (!user || user.id !== input.userId || user.status !== "pending" || user.passwordHash !== null) {
      return false;
    }
    this.users.delete(email);
    for (const [tokenHash, token] of this.authActionTokens.entries()) {
      if (token.userId === input.userId) {
        this.authActionTokens.delete(tokenHash);
      }
    }
    return true;
  }

  async completeRegistrationInvitation(input: CompleteRegistrationInvitationInput): Promise<CompleteRegistrationInvitationResult | null> {
    const now = input.now ?? new Date();
    const usedAt = input.usedAt ?? now;
    const email = input.email.toLowerCase();
    const token = this.authActionTokens.get(input.tokenHash);
    if (
      !token ||
      token.purpose !== "registration_invitation" ||
      token.sentToNormalizedEmail !== email ||
      token.usedAt ||
      token.expiresAt <= now
    ) {
      return null;
    }
    const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
    if (!user || user.email !== email || user.status !== "pending" || user.passwordHash !== null) {
      return null;
    }

    if (input.name) {
      user.name = input.name;
    }
    user.status = "active";
    user.emailVerifiedAt = usedAt;
    user.passwordHash = input.passwordHash;
    token.usedAt = usedAt;
    return { user: toRecord(user), usedAt };
  }

  async listUsers(): Promise<AuthUserRecord[]> {
    return [...this.users.values()]
      .sort((a, b) => a.email.localeCompare(b.email))
      .map(toRecord);
  }

  async findUserById(userId: string): Promise<AuthUserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.id === userId);
    return user ? toRecord(user) : null;
  }

  async updateUserEmail(input: { userId: string; email: string; emailVerifiedAt: Date }): Promise<AuthUserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user) {
      return null;
    }
    this.users.delete(user.email);
    user.email = input.email.toLowerCase();
    user.emailVerifiedAt = input.emailVerifiedAt;
    this.users.set(user.email, user);
    return toRecord(user);
  }

  async updateUserStatus(input: { userId: string; status: UserStatus; emailVerifiedAt?: Date | null }): Promise<AuthUserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user) {
      return null;
    }
    user.status = input.status;
    if (input.emailVerifiedAt !== undefined) {
      user.emailVerifiedAt = input.emailVerifiedAt;
    }
    return toRecord(user);
  }

  async applyAdminUserStatusChange(input: {
    userId: string;
    status: UserStatus;
    emailVerifiedAt?: Date | null;
    protectLastActiveOwner: boolean;
    revokeCredentials: boolean;
    audit?: CreateAuditEventInput;
  }): Promise<AdminUserStatusChangeResult> {
    return this.commitAdminMutation<AdminUserStatusChangeResult>(() => {
      const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
      if (!user) {
        return { commit: () => ({ outcome: "not_found" }) };
      }
      if (
        input.protectLastActiveOwner &&
        user.status === "active" &&
        user.roles.includes("owner") &&
        input.status !== "active" &&
        [...this.users.values()].filter((candidate) => candidate.status === "active" && candidate.roles.includes("owner")).length <= 1
      ) {
        return { commit: () => ({ outcome: "last_owner" }) };
      }
      const emailVerifiedAt = input.emailVerifiedAt === undefined ? user.emailVerifiedAt : input.emailVerifiedAt;
      return {
        audit: input.audit ? {
          ...input.audit,
          resourceId: user.id,
          details: {
            ...input.audit.details,
            statusBefore: user.status,
            statusAfter: input.status,
            emailVerifiedBefore: Boolean(user.emailVerifiedAt),
            emailVerifiedAfter: Boolean(emailVerifiedAt),
          },
        } : undefined,
        commit: () => {
          user.status = input.status;
          user.emailVerifiedAt = emailVerifiedAt;
          if (input.revokeCredentials) this.revokeCredentialsInMemory(user.id);
          return { outcome: "updated", user: toRecord(user) };
        },
      };
    });
  }

  async updateUserRoles(input: { userId: string; roles: Role[] }): Promise<AuthUserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user) {
      return null;
    }
    user.roles = input.roles;
    return toRecord(user);
  }

  async updateUserRolesAndRevokeCredentials(input: { userId: string; roles: Role[]; audit?: CreateAuditEventInput }): Promise<AuthUserRecord | null> {
    return this.commitAdminMutation<AuthUserRecord | null>(() => {
      const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
      if (!user) return { commit: () => null };
      if (user.status === "active" && user.roles.includes("owner") && !input.roles.includes("owner") &&
        ![...this.users.values()].some((candidate) => candidate.id !== user.id && candidate.status === "active" && candidate.roles.includes("owner"))) {
        throw new AppError("At least one active owner is required.", "LAST_OWNER_REQUIRED", 409);
      }
      return {
        audit: input.audit ? {
          ...input.audit,
          resourceId: user.id,
          details: { ...input.audit.details, rolesBefore: [...user.roles], rolesAfter: [...input.roles] },
        } : undefined,
        commit: () => {
          user.roles = [...input.roles];
          this.revokeCredentialsInMemory(user.id);
          return toRecord(user);
        },
      };
    });
  }

  async updatePasswordCredential(input: { userId: string; passwordHash: string; passwordUpdatedAt?: Date }): Promise<boolean> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user || user.passwordHash === null) {
      return false;
    }
    user.passwordHash = input.passwordHash;
    return true;
  }

  async changePasswordAndRevokeCredentials(input: ChangePasswordAndRevokeCredentialsInput): Promise<boolean> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user || user.passwordHash === null) {
      return false;
    }
    const previousPasswordHash = user.passwordHash;
    const credentials = this.snapshotCredentialRevocationState(user.id);
    try {
      user.passwordHash = input.passwordHash;
      await this.revokeUserCredentials(user.id);
      return true;
    } catch (error) {
      user.passwordHash = previousPasswordHash;
      this.restoreCredentialRevocationState(credentials);
      throw error;
    }
  }

  async completePasswordReset(input: CompletePasswordResetInput): Promise<boolean> {
    const now = input.now ?? new Date();
    const usedAt = input.usedAt ?? now;
    const token = this.authActionTokens.get(input.tokenHash);
    if (!token || token.purpose !== "password_reset" || token.usedAt || token.expiresAt <= now) {
      return false;
    }
    const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
    if (!user || user.status !== "active" || !user.emailVerifiedAt || user.passwordHash === null) {
      return false;
    }

    const previousPasswordHash = user.passwordHash;
    const resetTokenStates = [...this.authActionTokens.values()]
      .filter((candidate) => candidate.userId === user.id && candidate.purpose === "password_reset")
      .map((candidate) => ({ tokenHash: candidate.tokenHash, usedAt: candidate.usedAt }));
    const credentials = this.snapshotCredentialRevocationState(user.id);
    try {
      user.passwordHash = input.passwordHash;
      for (const candidate of this.authActionTokens.values()) {
        if (candidate.userId === user.id && candidate.purpose === "password_reset" && !candidate.usedAt) {
          candidate.usedAt = usedAt;
        }
      }
      await this.revokeUserCredentials(user.id);
      return true;
    } catch (error) {
      user.passwordHash = previousPasswordHash;
      for (const state of resetTokenStates) {
        const candidate = this.authActionTokens.get(state.tokenHash);
        if (candidate) {
          candidate.usedAt = state.usedAt;
        }
      }
      this.restoreCredentialRevocationState(credentials);
      throw error;
    }
  }

  async createAuthActionToken(input: CreateAuthActionTokenInput): Promise<AuthActionTokenRecord> {
    const token: MemoryAuthActionToken = {
      id: `auth-action-token-${this.authActionTokens.size + 1}`,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      sentToNormalizedEmail: input.sentToNormalizedEmail,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };
    this.authActionTokens.set(token.tokenHash, token);
    return toAuthActionTokenRecord(token);
  }

  async consumeAuthActionToken(input: {
    tokenHash: string;
    purpose: AuthActionTokenPurpose;
    now?: Date;
    usedAt?: Date;
  }): Promise<AuthActionTokenWithUser | null> {
    const now = input.now ?? new Date();
    const token = this.authActionTokens.get(input.tokenHash);
    if (!token || token.purpose !== input.purpose || token.usedAt || token.expiresAt <= now) {
      return null;
    }
    token.usedAt = input.usedAt ?? now;
    const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
    return user ? { ...toAuthActionTokenRecord(token), user: toRecord(user) } : null;
  }

  async completeEmailChangeAndRevokeCredentials(input: CompleteEmailChangeInput): Promise<CompleteEmailChangeResult | null> {
    const now = input.now ?? new Date();
    const usedAt = input.usedAt ?? now;
    const token = this.authActionTokens.get(input.tokenHash);
    if (!token || token.purpose !== "email_change" || token.usedAt || token.expiresAt <= now) {
      return null;
    }
    const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
    if (!user || user.status !== "active" || !user.emailVerifiedAt) {
      return null;
    }
    const nextEmail = token.sentToNormalizedEmail;
    const existing = this.users.get(nextEmail);
    if (existing && existing.id !== user.id) {
      return { outcome: "email_in_use" };
    }

    const previousEmail = user.email;
    const previousEmailVerifiedAt = user.emailVerifiedAt;
    const previousTokenUsedAt = token.usedAt;
    const credentials = this.snapshotCredentialRevocationState(user.id);
    try {
      this.users.delete(previousEmail);
      user.email = nextEmail;
      user.emailVerifiedAt = usedAt;
      this.users.set(nextEmail, user);
      token.usedAt = usedAt;
      await this.revokeUserCredentials(user.id);
      return { outcome: "changed", user: toRecord(user), previousEmail };
    } catch (error) {
      this.users.delete(nextEmail);
      user.email = previousEmail;
      user.emailVerifiedAt = previousEmailVerifiedAt;
      this.users.set(previousEmail, user);
      token.usedAt = previousTokenUsedAt;
      this.restoreCredentialRevocationState(credentials);
      throw error;
    }
  }

  async countActiveOwnersExcluding(userId: string): Promise<number> {
    return [...this.users.values()].filter((user) => (
      user.id !== userId &&
      user.status === "active" &&
      user.roles.includes("owner")
    )).length;
  }

  async findUserByEmailWithPassword(email: string): Promise<AuthUserWithPassword | null> {
    const user = this.users.get(email.toLowerCase());
    return user ? { ...toRecord(user), passwordHash: user.passwordHash } : null;
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    this.sessions.set(input.tokenHash, { ...input, mfaVerifiedAt: input.mfaVerifiedAt ?? null, revokedAt: null });
  }

  async findUserBySessionTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserWithSession | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) {
      return null;
    }
    const user = Array.from(this.users.values()).find((candidate) => candidate.id === session.userId);
    return user ? { ...toRecord(user), sessionMfaVerifiedAt: session.mfaVerifiedAt } : null;
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revokedAt = new Date();
    }
  }

  async revokeUserCredentials(userId: string): Promise<void> {
    this.revokeCredentialsInMemory(userId);
  }

  private revokeCredentialsInMemory(userId: string): void {
    const now = new Date();
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = now;
      }
    }
    for (const token of this.apiTokens.values()) {
      if (token.userId === userId && !token.revokedAt) {
        token.revokedAt = now;
      }
    }
  }

  async createApiToken(input: CreateApiTokenInput): Promise<ApiTokenRecord> {
    const token: MemoryApiToken = {
      id: `api-token-${this.apiTokens.size + 1}`,
      userId: input.userId,
      name: input.name,
      tokenPrefix: input.tokenPrefix,
      tokenHash: input.tokenHash,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      mfaVerifiedAt: input.mfaVerifiedAt ?? null,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    this.apiTokens.set(token.tokenHash, token);
    return toApiTokenRecord(token);
  }

  async listApiTokensForUser(userId: string): Promise<ApiTokenRecord[]> {
    return [...this.apiTokens.values()]
      .filter((token) => token.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toApiTokenRecord);
  }

  async listApiTokensForAdmin(): Promise<AdminApiTokenRecord[]> {
    return [...this.apiTokens.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .flatMap((token) => {
        const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
        return user ? [{ ...toApiTokenRecord(token), user: toRecord(user) }] : [];
      });
  }

  async findUserByApiTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserWithApiToken | null> {
    const token = this.apiTokens.get(tokenHash);
    if (!token || token.revokedAt || token.expiresAt <= now) {
      return null;
    }
    const user = Array.from(this.users.values()).find((candidate) => candidate.id === token.userId);
    if (!user) {
      return null;
    }
    token.lastUsedAt = now;
    return {
      ...toRecord(user),
      apiTokenId: token.id,
      apiTokenScopes: token.scopes,
      apiTokenMfaVerifiedAt: token.mfaVerifiedAt,
    };
  }

  async revokeApiToken(input: { userId: string; tokenId: string }): Promise<ApiTokenRecord | null> {
    const token = [...this.apiTokens.values()].find((candidate) => (
      candidate.id === input.tokenId &&
      candidate.userId === input.userId
    ));
    if (!token) {
      return null;
    }
    if (!token.revokedAt) {
      token.revokedAt = new Date();
    }
    return toApiTokenRecord(token);
  }

  async revokeAnyApiToken(input: { tokenId: string; audit?: CreateAuditEventInput }): Promise<AdminApiTokenRecord | null> {
    return this.commitAdminMutation<AdminApiTokenRecord | null>(() => {
      const token = [...this.apiTokens.values()].find((candidate) => candidate.id === input.tokenId);
      const user = token ? [...this.users.values()].find((candidate) => candidate.id === token.userId) : null;
      if (!token || !user) return { commit: () => null };
      return {
        audit: input.audit ? {
          ...input.audit,
          resourceId: token.id,
          details: { ...input.audit.details, targetUserId: user.id, targetEmail: user.email, scopes: [...token.scopes] },
        } : undefined,
        commit: () => {
          token.revokedAt ??= new Date();
          return { ...toApiTokenRecord(token), user: toRecord(user) };
        },
      };
    });
  }

  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    return [...this.providerConfigs.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(toProviderConfigRecord);
  }

  async upsertProviderConfig(input: UpsertProviderConfigInput): Promise<ProviderConfigRecord> {
    return this.commitAdminMutation(() => {
      const existing = this.providerConfigs.get(input.key);
      const now = new Date();
      const config: MemoryProviderConfig = {
        id: existing?.id ?? `provider-${this.providerConfigs.size + 1}`,
        key: input.key,
        type: input.type,
        displayName: input.displayName,
        issuer: input.issuer ?? null,
        clientId: input.clientId ?? null,
        enabled: input.enabled ?? false,
        roleMappings: [...input.roleMappings].sort(compareProviderRoleMappings),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        audit: input.audit ? { ...input.audit, resourceId: config.id } : undefined,
        commit: () => {
          this.providerConfigs.set(config.key, config);
          return toProviderConfigRecord(config);
        },
      };
    });
  }

  async countEnabledMfaFactors(userId: string): Promise<number> {
    return [...this.mfaFactors.values()].filter((factor) => factor.userId === userId && factor.status === "enabled").length;
  }

  async createMfaTotpFactor(input: CreateMfaTotpFactorInput): Promise<MfaTotpFactorRecord> {
    const now = new Date();
    const factor: MemoryMfaTotpFactor = {
      id: `mfa-factor-${this.mfaFactors.size + 1}`,
      userId: input.userId,
      type: "totp",
      status: "pending",
      label: input.label,
      secretCiphertext: input.secretCiphertext,
      enabledAt: null,
      disabledAt: null,
      lastUsedCounter: null,
      createdAt: now,
      updatedAt: now,
    };
    this.mfaFactors.set(factor.id, factor);
    return toMfaTotpFactorRecord(factor);
  }

  async listMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]> {
    return [...this.mfaFactors.values()]
      .filter((factor) => factor.userId === userId && factor.status !== "disabled")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toMfaTotpFactorRecord);
  }

  async listEnabledMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]> {
    return [...this.mfaFactors.values()]
      .filter((factor) => factor.userId === userId && factor.status === "enabled")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toMfaTotpFactorRecord);
  }

  async findMfaTotpFactorForUser(input: { userId: string; factorId: string }): Promise<MfaTotpFactorRecord | null> {
    const factor = this.mfaFactors.get(input.factorId);
    return factor && factor.userId === input.userId ? toMfaTotpFactorRecord(factor) : null;
  }

  async enableMfaTotpFactor(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<MfaTotpFactorRecord | null> {
    const factor = this.mfaFactors.get(input.factorId);
    if (!factor || factor.userId !== input.userId) {
      return null;
    }
    const now = new Date();
    factor.status = "enabled";
    factor.enabledAt = now;
    factor.disabledAt = null;
    factor.lastUsedCounter = input.lastUsedCounter;
    factor.updatedAt = now;
    return toMfaTotpFactorRecord(factor);
  }

  async disableMfaTotpFactorsForUser(input: { userId: string; disabledAt?: Date }): Promise<number> {
    const disabledAt = input.disabledAt ?? new Date();
    let count = 0;
    for (const factor of this.mfaFactors.values()) {
      if (factor.userId !== input.userId || factor.status === "disabled") {
        continue;
      }
      factor.status = "disabled";
      factor.disabledAt = disabledAt;
      factor.updatedAt = disabledAt;
      count += 1;
    }
    return count;
  }

  async disableMfaAndRevokeCredentials(input: DisableMfaAndRevokeCredentialsInput): Promise<number> {
    const factors = [...this.mfaFactors.entries()]
      .filter(([, factor]) => factor.userId === input.userId)
      .map(([id, factor]) => [id, { ...factor }] as const);
    const recoveryCodes = [...this.mfaRecoveryCodes.entries()]
      .filter(([, code]) => code.userId === input.userId)
      .map(([id, code]) => [id, { ...code }] as const);
    const credentials = this.snapshotCredentialRevocationState(input.userId);
    try {
      const disabledFactors = await this.disableMfaTotpFactorsForUser(input);
      await this.replaceMfaRecoveryCodes({ userId: input.userId, codeHashes: [] });
      await this.revokeUserCredentials(input.userId);
      return disabledFactors;
    } catch (error) {
      for (const [id, factor] of this.mfaFactors) {
        if (factor.userId === input.userId) {
          this.mfaFactors.delete(id);
        }
      }
      for (const [id, factor] of factors) {
        this.mfaFactors.set(id, factor);
      }
      for (const [id, code] of this.mfaRecoveryCodes) {
        if (code.userId === input.userId) {
          this.mfaRecoveryCodes.delete(id);
        }
      }
      for (const [id, code] of recoveryCodes) {
        this.mfaRecoveryCodes.set(id, code);
      }
      this.restoreCredentialRevocationState(credentials);
      throw error;
    }
  }

  async disableOtherMfaTotpFactorsForUser(input: { userId: string; factorId: string; disabledAt?: Date }): Promise<number> {
    const disabledAt = input.disabledAt ?? new Date();
    let count = 0;
    for (const factor of this.mfaFactors.values()) {
      if (factor.userId !== input.userId || factor.id === input.factorId || factor.status === "disabled") {
        continue;
      }
      factor.status = "disabled";
      factor.disabledAt = disabledAt;
      factor.updatedAt = disabledAt;
      count += 1;
    }
    return count;
  }

  async updateMfaTotpFactorCounter(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<boolean> {
    const factor = this.mfaFactors.get(input.factorId);
    if (!factor || factor.userId !== input.userId) {
      return false;
    }
    if (factor.lastUsedCounter !== null && factor.lastUsedCounter >= input.lastUsedCounter) {
      return false;
    }
    factor.lastUsedCounter = input.lastUsedCounter;
    factor.updatedAt = new Date();
    return true;
  }

  async replaceMfaRecoveryCodes(input: { userId: string; codeHashes: string[] }): Promise<void> {
    for (const [id, code] of this.mfaRecoveryCodes) {
      if (code.userId === input.userId) {
        this.mfaRecoveryCodes.delete(id);
      }
    }
    const now = new Date();
    for (const codeHash of input.codeHashes) {
      const code: MemoryMfaRecoveryCode = {
        id: `mfa-recovery-${this.mfaRecoveryCodes.size + 1}`,
        userId: input.userId,
        codeHash,
        usedAt: null,
        createdAt: now,
      };
      this.mfaRecoveryCodes.set(code.id, code);
    }
  }

  async countUnusedMfaRecoveryCodes(userId: string): Promise<number> {
    return [...this.mfaRecoveryCodes.values()].filter((code) => code.userId === userId && !code.usedAt).length;
  }

  async consumeMfaRecoveryCode(input: { userId: string; codeHash: string }): Promise<boolean> {
    const code = [...this.mfaRecoveryCodes.values()].find((candidate) => (
      candidate.userId === input.userId &&
      candidate.codeHash === input.codeHash &&
      !candidate.usedAt
    ));
    if (!code) {
      return false;
    }
    code.usedAt = new Date();
    return true;
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord> {
    const challenge: MemoryMfaChallenge = {
      id: `mfa-challenge-${this.mfaChallenges.size + 1}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };
    this.mfaChallenges.set(challenge.tokenHash, challenge);
    return toMfaChallengeRecord(challenge);
  }

  async findMfaChallengeByTokenHash(tokenHash: string, now = new Date()): Promise<MfaChallengeWithUser | null> {
    const challenge = this.mfaChallenges.get(tokenHash);
    if (!challenge || challenge.usedAt || challenge.expiresAt <= now) {
      return null;
    }
    const user = Array.from(this.users.values()).find((candidate) => candidate.id === challenge.userId);
    return user ? { ...toMfaChallengeRecord(challenge), user: toRecord(user) } : null;
  }

  async markMfaChallengeUsed(input: { challengeId: string; usedAt: Date }): Promise<boolean> {
    const challenge = [...this.mfaChallenges.values()].find((candidate) => candidate.id === input.challengeId);
    if (!challenge || challenge.usedAt) {
      return false;
    }
    challenge.usedAt = input.usedAt;
    return true;
  }

  async recordAuditEvent(input: CreateAuditEventInput): Promise<void> {
    const event = await this.prepareAuditEvent(input);
    this.audit.set(event.id, event);
  }

  protected async prepareAuditEvent(input: CreateAuditEventInput): Promise<MemoryAuditEvent> {
    return {
      id: `audit-${++this.auditSequence}`,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      decision: input.decision,
      resourceType: input.resourceType ?? "",
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
      createdAt: new Date(),
    };
  }

  // Prepare a fallible audit write first, then commit the in-memory state and
  // event without another await. Serialize privileged changes for owner parity.
  private async commitAdminMutation<T>(prepare: () => { audit?: CreateAuditEventInput; commit: () => T }): Promise<T> {
    const previous = this.adminMutationTail;
    let release!: () => void;
    this.adminMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const prepared = prepare();
      const event = prepared.audit ? await this.prepareAuditEvent(prepared.audit) : null;
      const result = prepared.commit();
      if (event) this.audit.set(event.id, event);
      return result;
    } finally {
      release();
    }
  }

  async listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventRecord[]> {
    return [...this.audit.values()]
      .sort((a, b) => {
        const time = b.createdAt.getTime() - a.createdAt.getTime();
        return time === 0 ? Number(b.id.slice(6)) - Number(a.id.slice(6)) : time;
      })
      .slice(0, input.limit)
      .map(toAuditEventRecord);
  }

  private snapshotCredentialRevocationState(userId: string): {
    sessions: Array<{ tokenHash: string; revokedAt: Date | null }>;
    apiTokens: Array<{ tokenHash: string; revokedAt: Date | null }>;
  } {
    return {
      sessions: [...this.sessions.entries()]
        .filter(([, session]) => session.userId === userId)
        .map(([tokenHash, session]) => ({ tokenHash, revokedAt: session.revokedAt })),
      apiTokens: [...this.apiTokens.entries()]
        .filter(([, token]) => token.userId === userId)
        .map(([tokenHash, token]) => ({ tokenHash, revokedAt: token.revokedAt })),
    };
  }

  private restoreCredentialRevocationState(snapshot: {
    sessions: Array<{ tokenHash: string; revokedAt: Date | null }>;
    apiTokens: Array<{ tokenHash: string; revokedAt: Date | null }>;
  }): void {
    for (const state of snapshot.sessions) {
      const session = this.sessions.get(state.tokenHash);
      if (session) {
        session.revokedAt = state.revokedAt;
      }
    }
    for (const state of snapshot.apiTokens) {
      const token = this.apiTokens.get(state.tokenHash);
      if (token) {
        token.revokedAt = state.revokedAt;
      }
    }
  }
}

function toRecord(user: MemoryUser): AuthUserRecord {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    roles: user.roles,
  };
}

function toApiTokenRecord(token: MemoryApiToken): ApiTokenRecord {
  return {
    id: token.id,
    userId: token.userId,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
  };
}

function toProviderConfigRecord(config: MemoryProviderConfig): ProviderConfigRecord {
  return {
    id: config.id,
    key: config.key,
    type: config.type,
    displayName: config.displayName,
    issuer: config.issuer,
    clientId: config.clientId,
    enabled: config.enabled,
    roleMappings: [...config.roleMappings].sort(compareProviderRoleMappings),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function compareProviderRoleMappings(a: ProviderRoleMappingRecord, b: ProviderRoleMappingRecord): number {
  return `${a.claim}:${a.value}:${a.role}`.localeCompare(`${b.claim}:${b.value}:${b.role}`);
}

function toMfaTotpFactorRecord(factor: MemoryMfaTotpFactor): MfaTotpFactorRecord {
  return {
    id: factor.id,
    userId: factor.userId,
    type: factor.type,
    status: factor.status,
    label: factor.label,
    secretCiphertext: factor.secretCiphertext,
    enabledAt: factor.enabledAt,
    disabledAt: factor.disabledAt,
    lastUsedCounter: factor.lastUsedCounter,
    createdAt: factor.createdAt,
    updatedAt: factor.updatedAt,
  };
}

function toMfaChallengeRecord(challenge: MemoryMfaChallenge): MfaChallengeRecord {
  return {
    id: challenge.id,
    userId: challenge.userId,
    tokenHash: challenge.tokenHash,
    expiresAt: challenge.expiresAt,
    usedAt: challenge.usedAt,
    createdAt: challenge.createdAt,
  };
}

function toAuthActionTokenRecord(token: MemoryAuthActionToken): AuthActionTokenRecord {
  return {
    id: token.id,
    userId: token.userId,
    purpose: token.purpose,
    tokenHash: token.tokenHash,
    sentToNormalizedEmail: token.sentToNormalizedEmail,
    expiresAt: token.expiresAt,
    usedAt: token.usedAt,
    createdAt: token.createdAt,
  };
}

function toAuditEventRecord(event: MemoryAuditEvent): AuditEventRecord {
  return {
    id: event.id,
    actorUserId: event.actorUserId,
    action: event.action,
    decision: event.decision,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    details: event.details,
    createdAt: event.createdAt,
  };
}
