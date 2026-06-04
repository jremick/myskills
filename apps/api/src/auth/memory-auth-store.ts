import type { RegistrationMode, Role, UserStatus } from "@ai-skills-share/auth";
import type {
  ApiTokenRecord,
  ApiTokenScope,
  AuthStore,
  AuthUserRecord,
  AuthUserWithSession,
  AuthUserWithPassword,
  AuthUserWithApiToken,
  CreateApiTokenInput,
  CreateMfaChallengeInput,
  CreateMfaTotpFactorInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
  MfaChallengeRecord,
  MfaChallengeWithUser,
  MfaTotpFactorRecord,
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

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, MemoryUser>();
  private sessions = new Map<string, MemorySession>();
  private apiTokens = new Map<string, MemoryApiToken>();
  private mfaFactors = new Map<string, MemoryMfaTotpFactor>();
  private mfaRecoveryCodes = new Map<string, MemoryMfaRecoveryCode>();
  private mfaChallenges = new Map<string, MemoryMfaChallenge>();

  constructor(private registrationMode: RegistrationMode = "closed") {}

  setRegistrationMode(mode: RegistrationMode): void {
    this.registrationMode = mode;
  }

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

  async updateMfaTotpFactorCounter(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<void> {
    const factor = this.mfaFactors.get(input.factorId);
    if (factor && factor.userId === input.userId) {
      factor.lastUsedCounter = input.lastUsedCounter;
      factor.updatedAt = new Date();
    }
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

  async markMfaChallengeUsed(input: { challengeId: string; usedAt: Date }): Promise<void> {
    const challenge = [...this.mfaChallenges.values()].find((candidate) => candidate.id === input.challengeId);
    if (challenge && !challenge.usedAt) {
      challenge.usedAt = input.usedAt;
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
