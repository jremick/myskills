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
  CreateMfaChallengeInput,
  CreateMfaTotpFactorInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
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

  async setRegistrationMode(mode: RegistrationMode): Promise<RegistrationMode> {
    this.registrationMode = mode;
    return this.registrationMode;
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

  async updateUserRoles(input: { userId: string; roles: Role[] }): Promise<AuthUserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user) {
      return null;
    }
    user.roles = input.roles;
    return toRecord(user);
  }

  async updatePasswordCredential(input: { userId: string; passwordHash: string; passwordUpdatedAt?: Date }): Promise<boolean> {
    const user = [...this.users.values()].find((candidate) => candidate.id === input.userId);
    if (!user || user.passwordHash === null) {
      return false;
    }
    user.passwordHash = input.passwordHash;
    return true;
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

  async revokeAnyApiToken(input: { tokenId: string }): Promise<AdminApiTokenRecord | null> {
    const token = [...this.apiTokens.values()].find((candidate) => candidate.id === input.tokenId);
    if (!token) {
      return null;
    }
    const user = [...this.users.values()].find((candidate) => candidate.id === token.userId);
    if (!user) {
      return null;
    }
    if (!token.revokedAt) {
      token.revokedAt = new Date();
    }
    return { ...toApiTokenRecord(token), user: toRecord(user) };
  }

  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    return [...this.providerConfigs.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(toProviderConfigRecord);
  }

  async upsertProviderConfig(input: UpsertProviderConfigInput): Promise<ProviderConfigRecord> {
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
    this.providerConfigs.set(config.key, config);
    return toProviderConfigRecord(config);
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
    const event: MemoryAuditEvent = {
      id: `audit-${this.audit.size + 1}`,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      decision: input.decision,
      resourceType: input.resourceType ?? "",
      resourceId: input.resourceId ?? null,
      details: sanitizeAuditDetails(input.details ?? {}),
      createdAt: new Date(),
    };
    this.audit.set(event.id, event);
  }

  async listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventRecord[]> {
    return [...this.audit.values()]
      .sort((a, b) => {
        const time = b.createdAt.getTime() - a.createdAt.getTime();
        return time === 0 ? b.id.localeCompare(a.id) : time;
      })
      .slice(0, input.limit)
      .map(toAuditEventRecord);
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
