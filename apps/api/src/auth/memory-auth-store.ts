import type { RegistrationMode, Role, UserStatus } from "@ai-skills-share/auth";
import type {
  ApiTokenRecord,
  ApiTokenScope,
  AuthStore,
  AuthUserRecord,
  AuthUserWithPassword,
  AuthUserWithApiToken,
  CreateApiTokenInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
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
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, MemoryUser>();
  private sessions = new Map<string, MemorySession>();
  private apiTokens = new Map<string, MemoryApiToken>();

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
    this.sessions.set(input.tokenHash, { ...input, revokedAt: null });
  }

  async findUserBySessionTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) {
      return null;
    }
    const user = Array.from(this.users.values()).find((candidate) => candidate.id === session.userId);
    return user ? toRecord(user) : null;
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
