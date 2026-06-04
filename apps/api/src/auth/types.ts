import type { AuthenticatedUser, RegistrationMode, UserStatus } from "@ai-skills-share/auth";

export const apiTokenScopes = ["profile:read", "skills:read", "skills:submit", "review:read", "review:write"] as const;

export type ApiTokenScope = (typeof apiTokenScopes)[number];

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

export interface AuthUserWithApiToken extends AuthUserRecord {
  apiTokenId: string;
  apiTokenScopes: ApiTokenScope[];
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

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface CreateApiTokenInput {
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scopes: ApiTokenScope[];
  expiresAt: Date;
}

export interface AuthStore {
  getRegistrationMode(): Promise<RegistrationMode>;
  createUserWithPassword(input: CreateUserWithPasswordInput): Promise<CreateUserWithPasswordResult>;
  findUserByEmailWithPassword(email: string): Promise<AuthUserWithPassword | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  findUserBySessionTokenHash(tokenHash: string, now?: Date): Promise<AuthUserRecord | null>;
  revokeSessionByTokenHash(tokenHash: string): Promise<void>;
  createApiToken(input: CreateApiTokenInput): Promise<ApiTokenRecord>;
  listApiTokensForUser(userId: string): Promise<ApiTokenRecord[]>;
  findUserByApiTokenHash(tokenHash: string, now?: Date): Promise<AuthUserWithApiToken | null>;
  revokeApiToken(input: { userId: string; tokenId: string }): Promise<ApiTokenRecord | null>;
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
