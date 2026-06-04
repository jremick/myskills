import type { AuthenticatedUser, RegistrationMode, UserStatus } from "@ai-skills-share/auth";

export const apiTokenScopes = ["profile:read", "skills:read", "skills:submit", "review:read", "review:write"] as const;
export const authActionTokenPurposes = ["email_verification", "password_reset"] as const;

export type ApiTokenScope = (typeof apiTokenScopes)[number];
export type AuthActionTokenPurpose = (typeof authActionTokenPurposes)[number];
export type AuditDecision = "allow" | "deny";

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

export interface AuthUserWithSession extends AuthUserRecord {
  sessionMfaVerifiedAt: Date | null;
}

export interface AuthUserWithApiToken extends AuthUserRecord {
  apiTokenId: string;
  apiTokenScopes: ApiTokenScope[];
  apiTokenMfaVerifiedAt: Date | null;
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

export interface CreateAuthActionTokenInput {
  userId: string;
  purpose: AuthActionTokenPurpose;
  tokenHash: string;
  sentToNormalizedEmail: string;
  expiresAt: Date;
}

export interface AuthActionTokenRecord {
  id: string;
  userId: string;
  purpose: AuthActionTokenPurpose;
  tokenHash: string;
  sentToNormalizedEmail: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface AuthActionTokenWithUser extends AuthActionTokenRecord {
  user: AuthUserRecord;
}

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  mfaVerifiedAt?: Date | null;
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
  mfaVerifiedAt?: Date | null;
}

export type MfaFactorStatus = "pending" | "enabled" | "disabled";

export interface MfaTotpFactorRecord {
  id: string;
  userId: string;
  type: "totp";
  status: MfaFactorStatus;
  label: string;
  secretCiphertext: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  lastUsedCounter: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMfaTotpFactorInput {
  userId: string;
  label: string;
  secretCiphertext: string;
}

export interface CreateMfaChallengeInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface MfaChallengeRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MfaChallengeWithUser extends MfaChallengeRecord {
  user: AuthUserRecord;
}

export interface AuditEventRecord {
  id: string;
  actorUserId: string | null;
  action: string;
  decision: AuditDecision;
  resourceType: string;
  resourceId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateAuditEventInput {
  actorUserId?: string | null;
  action: string;
  decision: AuditDecision;
  resourceType?: string;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}

export interface ListAuditEventsInput {
  limit: number;
}

export interface AuthStore {
  getRegistrationMode(): Promise<RegistrationMode>;
  setRegistrationMode(mode: RegistrationMode): Promise<RegistrationMode>;
  createUserWithPassword(input: CreateUserWithPasswordInput): Promise<CreateUserWithPasswordResult>;
  listUsers(): Promise<AuthUserRecord[]>;
  findUserById(userId: string): Promise<AuthUserRecord | null>;
  updateUserStatus(input: { userId: string; status: UserStatus; emailVerifiedAt?: Date | null }): Promise<AuthUserRecord | null>;
  updatePasswordCredential(input: { userId: string; passwordHash: string; passwordUpdatedAt?: Date }): Promise<boolean>;
  createAuthActionToken(input: CreateAuthActionTokenInput): Promise<AuthActionTokenRecord>;
  consumeAuthActionToken(input: {
    tokenHash: string;
    purpose: AuthActionTokenPurpose;
    now?: Date;
    usedAt?: Date;
  }): Promise<AuthActionTokenWithUser | null>;
  countActiveOwnersExcluding(userId: string): Promise<number>;
  findUserByEmailWithPassword(email: string): Promise<AuthUserWithPassword | null>;
  createSession(input: CreateSessionInput): Promise<void>;
  findUserBySessionTokenHash(tokenHash: string, now?: Date): Promise<AuthUserWithSession | null>;
  revokeSessionByTokenHash(tokenHash: string): Promise<void>;
  revokeUserCredentials(userId: string): Promise<void>;
  createApiToken(input: CreateApiTokenInput): Promise<ApiTokenRecord>;
  listApiTokensForUser(userId: string): Promise<ApiTokenRecord[]>;
  findUserByApiTokenHash(tokenHash: string, now?: Date): Promise<AuthUserWithApiToken | null>;
  revokeApiToken(input: { userId: string; tokenId: string }): Promise<ApiTokenRecord | null>;
  countEnabledMfaFactors(userId: string): Promise<number>;
  createMfaTotpFactor(input: CreateMfaTotpFactorInput): Promise<MfaTotpFactorRecord>;
  listMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]>;
  listEnabledMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]>;
  findMfaTotpFactorForUser(input: { userId: string; factorId: string }): Promise<MfaTotpFactorRecord | null>;
  enableMfaTotpFactor(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<MfaTotpFactorRecord | null>;
  updateMfaTotpFactorCounter(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<void>;
  replaceMfaRecoveryCodes(input: { userId: string; codeHashes: string[] }): Promise<void>;
  countUnusedMfaRecoveryCodes(userId: string): Promise<number>;
  consumeMfaRecoveryCode(input: { userId: string; codeHash: string }): Promise<boolean>;
  createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord>;
  findMfaChallengeByTokenHash(tokenHash: string, now?: Date): Promise<MfaChallengeWithUser | null>;
  markMfaChallengeUsed(input: { challengeId: string; usedAt: Date }): Promise<void>;
  recordAuditEvent(input: CreateAuditEventInput): Promise<void>;
  listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventRecord[]>;
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
