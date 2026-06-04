import { and, eq, gt, isNull } from "drizzle-orm";
import type { RegistrationMode, Role, UserStatus } from "@ai-skills-share/auth";
import type { Database } from "../db/client.js";
import {
  apiTokens,
  authSessions,
  instanceSettings,
  mfaChallenges,
  mfaFactors,
  mfaRecoveryCodes,
  passwordCredentials,
  roleAssignments,
  users,
} from "../db/schema.js";
import type {
  ApiTokenRecord,
  ApiTokenScope,
  AuthStore,
  AuthUserRecord,
  AuthUserWithApiToken,
  AuthUserWithSession,
  AuthUserWithPassword,
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

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: Database) {}

  async getRegistrationMode(): Promise<RegistrationMode> {
    const [setting] = await this.db
      .select({ value: instanceSettings.value })
      .from(instanceSettings)
      .where(eq(instanceSettings.key, "registration"))
      .limit(1);
    const mode = setting?.value && typeof setting.value === "object" && "mode" in setting.value
      ? String(setting.value.mode)
      : "closed";
    return mode === "open" || mode === "request" ? mode : "closed";
  }

  async setRegistrationMode(mode: RegistrationMode): Promise<RegistrationMode> {
    await this.db
      .insert(instanceSettings)
      .values({
        key: "registration",
        value: { mode },
      })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: {
          value: { mode },
          updatedAt: new Date(),
        },
      });
    return mode;
  }

  async createUserWithPassword(input: CreateUserWithPasswordInput): Promise<CreateUserWithPasswordResult> {
    const [user] = await this.db
      .insert(users)
      .values({
        email: input.email,
        normalizedEmail: input.email,
        name: input.name,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (!user) {
      return { created: false };
    }

    await this.db.insert(passwordCredentials).values({
      userId: user.id,
      passwordHash: input.passwordHash,
    });
    await this.db.insert(roleAssignments).values({
      userId: user.id,
      role: "user",
    }).onConflictDoNothing();

    return { created: true, user: { ...toRecord(user), roles: ["user"] } };
  }

  async listUsers(): Promise<AuthUserRecord[]> {
    const rows = await this.db.select().from(users).orderBy(users.normalizedEmail);
    return Promise.all(rows.map(async (user) => ({
      ...toRecord(user),
      roles: await this.rolesForUser(user.id),
    })));
  }

  async findUserById(userId: string): Promise<AuthUserRecord | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return user ? { ...toRecord(user), roles: await this.rolesForUser(user.id) } : null;
  }

  async updateUserStatus(input: { userId: string; status: UserStatus; emailVerifiedAt?: Date | null }): Promise<AuthUserRecord | null> {
    const set: Partial<typeof users.$inferInsert> = {
      status: input.status,
      updatedAt: new Date(),
    };
    if (input.emailVerifiedAt !== undefined) {
      set.emailVerifiedAt = input.emailVerifiedAt;
    }
    const [user] = await this.db
      .update(users)
      .set(set)
      .where(eq(users.id, input.userId))
      .returning();
    return user ? { ...toRecord(user), roles: await this.rolesForUser(user.id) } : null;
  }

  async countActiveOwnersExcluding(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .where(and(eq(roleAssignments.role, "owner"), eq(users.status, "active")));
    return rows.filter((row) => row.id !== userId).length;
  }

  async findUserByEmailWithPassword(email: string): Promise<AuthUserWithPassword | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.normalizedEmail, email))
      .limit(1);
    if (!user) {
      return null;
    }
    const [credential] = await this.db
      .select({ passwordHash: passwordCredentials.passwordHash })
      .from(passwordCredentials)
      .where(eq(passwordCredentials.userId, user.id))
      .limit(1);
    const roles = await this.rolesForUser(user.id);
    return { ...toRecord(user), roles, passwordHash: credential?.passwordHash ?? null };
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    await this.db.insert(authSessions).values({
      ...input,
      mfaVerifiedAt: input.mfaVerifiedAt ?? null,
    });
  }

  async findUserBySessionTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserWithSession | null> {
    const [row] = await this.db
      .select({
        user: users,
        sessionId: authSessions.id,
        sessionMfaVerifiedAt: authSessions.mfaVerifiedAt,
      })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ))
      .limit(1);
    if (!row) {
      return null;
    }
    await this.db.update(authSessions).set({ lastUsedAt: now }).where(eq(authSessions.id, row.sessionId));
    return { ...toRecord(row.user), roles: await this.rolesForUser(row.user.id), sessionMfaVerifiedAt: row.sessionMfaVerifiedAt };
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
  }

  async revokeUserCredentials(userId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
    await this.db
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  }

  async createApiToken(input: CreateApiTokenInput): Promise<ApiTokenRecord> {
    const [token] = await this.db
      .insert(apiTokens)
      .values({
        userId: input.userId,
        name: input.name,
        tokenPrefix: input.tokenPrefix,
        tokenHash: input.tokenHash,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        mfaVerifiedAt: input.mfaVerifiedAt ?? null,
      })
      .returning();
    if (!token) {
      throw new Error("API token insert failed.");
    }
    return toApiTokenRecord(token);
  }

  async listApiTokensForUser(userId: string): Promise<ApiTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(apiTokens.createdAt);
    return rows.reverse().map(toApiTokenRecord);
  }

  async findUserByApiTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserWithApiToken | null> {
    const [row] = await this.db
      .select({
        user: users,
        tokenId: apiTokens.id,
        scopes: apiTokens.scopes,
        tokenMfaVerifiedAt: apiTokens.mfaVerifiedAt,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(
        eq(apiTokens.tokenHash, tokenHash),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, now),
      ))
      .limit(1);
    if (!row) {
      return null;
    }
    await this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.tokenId));
    return {
      ...toRecord(row.user),
      roles: await this.rolesForUser(row.user.id),
      apiTokenId: row.tokenId,
      apiTokenScopes: parseApiTokenScopes(row.scopes),
      apiTokenMfaVerifiedAt: row.tokenMfaVerifiedAt,
    };
  }

  async revokeApiToken(input: { userId: string; tokenId: string }): Promise<ApiTokenRecord | null> {
    const [token] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, input.userId)))
      .returning();
    return token ? toApiTokenRecord(token) : null;
  }

  async countEnabledMfaFactors(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: mfaFactors.id })
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.status, "enabled")));
    return rows.length;
  }

  async createMfaTotpFactor(input: CreateMfaTotpFactorInput): Promise<MfaTotpFactorRecord> {
    const [factor] = await this.db
      .insert(mfaFactors)
      .values({
        userId: input.userId,
        label: input.label,
        secretCiphertext: input.secretCiphertext,
      })
      .returning();
    if (!factor) {
      throw new Error("MFA factor insert failed.");
    }
    return toMfaTotpFactorRecord(factor);
  }

  async listMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]> {
    const rows = await this.db
      .select()
      .from(mfaFactors)
      .where(eq(mfaFactors.userId, userId))
      .orderBy(mfaFactors.createdAt);
    return rows.filter((factor) => factor.status !== "disabled").map(toMfaTotpFactorRecord);
  }

  async listEnabledMfaTotpFactorsForUser(userId: string): Promise<MfaTotpFactorRecord[]> {
    const rows = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.status, "enabled")))
      .orderBy(mfaFactors.createdAt);
    return rows.map(toMfaTotpFactorRecord);
  }

  async findMfaTotpFactorForUser(input: { userId: string; factorId: string }): Promise<MfaTotpFactorRecord | null> {
    const [factor] = await this.db
      .select()
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, input.userId), eq(mfaFactors.id, input.factorId)))
      .limit(1);
    return factor ? toMfaTotpFactorRecord(factor) : null;
  }

  async enableMfaTotpFactor(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<MfaTotpFactorRecord | null> {
    const now = new Date();
    const [factor] = await this.db
      .update(mfaFactors)
      .set({
        status: "enabled",
        enabledAt: now,
        disabledAt: null,
        lastUsedCounter: input.lastUsedCounter,
        updatedAt: now,
      })
      .where(and(eq(mfaFactors.userId, input.userId), eq(mfaFactors.id, input.factorId)))
      .returning();
    return factor ? toMfaTotpFactorRecord(factor) : null;
  }

  async updateMfaTotpFactorCounter(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<void> {
    await this.db
      .update(mfaFactors)
      .set({
        lastUsedCounter: input.lastUsedCounter,
        updatedAt: new Date(),
      })
      .where(and(eq(mfaFactors.userId, input.userId), eq(mfaFactors.id, input.factorId)));
  }

  async replaceMfaRecoveryCodes(input: { userId: string; codeHashes: string[] }): Promise<void> {
    await this.db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, input.userId));
    if (input.codeHashes.length === 0) {
      return;
    }
    await this.db.insert(mfaRecoveryCodes).values(input.codeHashes.map((codeHash) => ({
      userId: input.userId,
      codeHash,
    })));
  }

  async countUnusedMfaRecoveryCodes(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: mfaRecoveryCodes.id })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    return rows.length;
  }

  async consumeMfaRecoveryCode(input: { userId: string; codeHash: string }): Promise<boolean> {
    const [code] = await this.db
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(
        eq(mfaRecoveryCodes.userId, input.userId),
        eq(mfaRecoveryCodes.codeHash, input.codeHash),
        isNull(mfaRecoveryCodes.usedAt),
      ))
      .returning({ id: mfaRecoveryCodes.id });
    return Boolean(code);
  }

  async createMfaChallenge(input: CreateMfaChallengeInput): Promise<MfaChallengeRecord> {
    const [challenge] = await this.db
      .insert(mfaChallenges)
      .values(input)
      .returning();
    if (!challenge) {
      throw new Error("MFA challenge insert failed.");
    }
    return toMfaChallengeRecord(challenge);
  }

  async findMfaChallengeByTokenHash(tokenHash: string, now = new Date()): Promise<MfaChallengeWithUser | null> {
    const [row] = await this.db
      .select({
        challenge: mfaChallenges,
        user: users,
      })
      .from(mfaChallenges)
      .innerJoin(users, eq(users.id, mfaChallenges.userId))
      .where(and(
        eq(mfaChallenges.tokenHash, tokenHash),
        isNull(mfaChallenges.usedAt),
        gt(mfaChallenges.expiresAt, now),
      ))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      ...toMfaChallengeRecord(row.challenge),
      user: { ...toRecord(row.user), roles: await this.rolesForUser(row.user.id) },
    };
  }

  async markMfaChallengeUsed(input: { challengeId: string; usedAt: Date }): Promise<void> {
    await this.db
      .update(mfaChallenges)
      .set({ usedAt: input.usedAt })
      .where(and(eq(mfaChallenges.id, input.challengeId), isNull(mfaChallenges.usedAt)));
  }

  private async rolesForUser(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId));
    return rows.map((row) => row.role);
  }
}

function toMfaTotpFactorRecord(factor: typeof mfaFactors.$inferSelect): MfaTotpFactorRecord {
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

function toMfaChallengeRecord(challenge: typeof mfaChallenges.$inferSelect): MfaChallengeRecord {
  return {
    id: challenge.id,
    userId: challenge.userId,
    tokenHash: challenge.tokenHash,
    expiresAt: challenge.expiresAt,
    usedAt: challenge.usedAt,
    createdAt: challenge.createdAt,
  };
}

function toRecord(user: typeof users.$inferSelect): Omit<AuthUserRecord, "roles"> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
  };
}

function toApiTokenRecord(token: typeof apiTokens.$inferSelect): ApiTokenRecord {
  return {
    id: token.id,
    userId: token.userId,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: parseApiTokenScopes(token.scopes),
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
    lastUsedAt: token.lastUsedAt,
    createdAt: token.createdAt,
  };
}

function parseApiTokenScopes(input: unknown): ApiTokenScope[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((scope): scope is ApiTokenScope => (
    scope === "profile:read" ||
    scope === "skills:read" ||
    scope === "skills:submit" ||
    scope === "review:read" ||
    scope === "review:write"
  ));
}
