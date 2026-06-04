import type { RegistrationMode, Role, UserStatus } from "@ai-skills-share/auth";
import type {
  AuthStore,
  AuthUserRecord,
  AuthUserWithPassword,
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

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, MemoryUser>();
  private sessions = new Map<string, MemorySession>();

  constructor(private registrationMode: RegistrationMode = "closed") {}

  setRegistrationMode(mode: RegistrationMode): void {
    this.registrationMode = mode;
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
