import type { AuthenticatedUser, RegistrationMode, UserStatus } from "@ai-skills-share/auth";

export interface AuthUserRecord {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  roles: AuthenticatedUser["roles"];
}

export interface AuthUserWithPassword extends AuthUserRecord {
  passwordHash: string | null;
}

export interface CreateUserWithPasswordInput {
  email: string;
  name: string;
  passwordHash: string;
}

export interface CreateUserWithPasswordResult {
  created: boolean;
  user?: AuthUserRecord;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface AuthStore {
  getRegistrationMode(): Promise<RegistrationMode>;
  createUserWithPassword(input: CreateUserWithPasswordInput): Promise<CreateUserWithPasswordResult>;
  findUserByEmailWithPassword(email: string): Promise<AuthUserWithPassword | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  findUserBySessionTokenHash(tokenHash: string, now?: Date): Promise<AuthUserRecord | null>;
  revokeSessionByTokenHash(tokenHash: string): Promise<void>;
}

export interface AuthResponseUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  roles: AuthenticatedUser["roles"];
  emailVerified: boolean;
  mfaVerified: boolean;
}
