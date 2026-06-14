import { and, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { roles as authRoles, type RegistrationMode, type Role, type UserStatus } from "@myskills-app/auth";
import { sanitizeAuditDetails } from "../audit/sanitize.js";
import type { Database } from "../db/client.js";
import {
  authActionTokens,
  apiTokens,
  authSessions,
  auditEvents,
  instanceSettings,
  mfaChallenges,
  mfaFactors,
  mfaRecoveryCodes,
  passwordCredentials,
  providerConfigs,
  providerRoleMappings,
  roleAssignments,
  users,
} from "../db/schema.js";
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
  AuthUserWithApiToken,
  AuthUserWithSession,
  AuthUserWithPassword,
  CreateAuditEventInput,
  CreateAuthActionTokenInput,
  CreateApiTokenInput,
  CreateMfaChallengeInput,
  CreateMfaTotpFactorInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
  ProviderConfigRecord,
  ProviderMappedRole,
  ProviderRoleMappingRecord,
  ProviderType,
  UpsertProviderConfigInput,
  MfaChallengeRecord,
  MfaChallengeWithUser,
  MfaTotpFactorRecord,
  ListAuditEventsInput,
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

  async updateUserEmail(input: { userId: string; email: string; emailVerifiedAt: Date }): Promise<AuthUserRecord | null> {
    const [user] = await this.db
      .update(users)
      .set({
        email: input.email,
        normalizedEmail: input.email,
        emailVerifiedAt: input.emailVerifiedAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId))
      .returning();
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

  async updateUserRoles(input: { userId: string; roles: Role[] }): Promise<AuthUserRecord | null> {
    return this.db.transaction(async (tx) => {
      if (!input.roles.includes("owner")) {
        await tx.execute(sql`
          select ${users.id}
          from ${users}
          inner join ${roleAssignments} on ${roleAssignments.userId} = ${users.id}
          where ${roleAssignments.role} = 'owner'
            and ${users.status} = 'active'
          order by ${users.id}
          for update
        `);
      }
      const [user] = await tx
        .update(users)
        .set({ updatedAt: new Date() })
        .where(eq(users.id, input.userId))
        .returning();
      if (!user) {
        return null;
      }
      await tx.delete(roleAssignments).where(eq(roleAssignments.userId, input.userId));
      if (input.roles.length > 0) {
        await tx.insert(roleAssignments).values(input.roles.map((role) => ({
          userId: input.userId,
          role,
        }))).onConflictDoNothing();
      }
      if (!input.roles.includes("owner")) {
        const activeOwners = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(roleAssignments, eq(roleAssignments.userId, users.id))
          .where(and(eq(roleAssignments.role, "owner"), eq(users.status, "active")));
        if (activeOwners.length === 0) {
          throw new AppError("At least one active owner is required.", "LAST_OWNER_REQUIRED", 409);
        }
      }
      return { ...toRecord(user), roles: input.roles };
    });
  }

  async updatePasswordCredential(input: { userId: string; passwordHash: string; passwordUpdatedAt?: Date }): Promise<boolean> {
    const [credential] = await this.db
      .update(passwordCredentials)
      .set({
        passwordHash: input.passwordHash,
        passwordUpdatedAt: input.passwordUpdatedAt ?? new Date(),
      })
      .where(eq(passwordCredentials.userId, input.userId))
      .returning({ userId: passwordCredentials.userId });
    return Boolean(credential);
  }

  async createAuthActionToken(input: CreateAuthActionTokenInput): Promise<AuthActionTokenRecord> {
    const [token] = await this.db
      .insert(authActionTokens)
      .values(input)
      .returning();
    if (!token) {
      throw new Error("Auth action token insert failed.");
    }
    return toAuthActionTokenRecord(token);
  }

  async consumeAuthActionToken(input: {
    tokenHash: string;
    purpose: AuthActionTokenPurpose;
    now?: Date;
    usedAt?: Date;
  }): Promise<AuthActionTokenWithUser | null> {
    const now = input.now ?? new Date();
    const [token] = await this.db
      .update(authActionTokens)
      .set({ usedAt: input.usedAt ?? now })
      .where(and(
        eq(authActionTokens.tokenHash, input.tokenHash),
        eq(authActionTokens.purpose, input.purpose),
        isNull(authActionTokens.usedAt),
        gt(authActionTokens.expiresAt, now),
      ))
      .returning();
    if (!token) {
      return null;
    }
    const user = await this.findUserById(token.userId);
    return user ? { ...toAuthActionTokenRecord(token), user } : null;
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

  async listApiTokensForAdmin(): Promise<AdminApiTokenRecord[]> {
    const rows = await this.db
      .select({
        token: apiTokens,
        user: users,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .orderBy(apiTokens.createdAt);
    return Promise.all(rows.reverse().map(async (row) => ({
      ...toApiTokenRecord(row.token),
      user: {
        ...toRecord(row.user),
        roles: await this.rolesForUser(row.user.id),
      },
    })));
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

  async revokeAnyApiToken(input: { tokenId: string }): Promise<AdminApiTokenRecord | null> {
    const [token] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(apiTokens.id, input.tokenId))
      .returning();
    if (!token) {
      return null;
    }
    const user = await this.findUserById(token.userId);
    return user ? { ...toApiTokenRecord(token), user } : null;
  }

  async listProviderConfigs(): Promise<ProviderConfigRecord[]> {
    const rows = await this.db
      .select()
      .from(providerConfigs)
      .orderBy(providerConfigs.key);
    return Promise.all(rows.map(async (config) => ({
      ...toProviderConfigRecord(config),
      roleMappings: await this.providerRoleMappingsForConfig(config.id),
    })));
  }

  async upsertProviderConfig(input: UpsertProviderConfigInput): Promise<ProviderConfigRecord> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [config] = await tx
        .insert(providerConfigs)
        .values({
          key: input.key,
          type: input.type,
          displayName: input.displayName,
          issuer: input.issuer ?? null,
          clientId: input.clientId ?? null,
          enabled: input.enabled ?? false,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: providerConfigs.key,
          set: {
            type: input.type,
            displayName: input.displayName,
            issuer: input.issuer ?? null,
            clientId: input.clientId ?? null,
            enabled: input.enabled ?? false,
            updatedAt: now,
          },
        })
        .returning();
      if (!config) {
        throw new Error("Provider config upsert failed.");
      }

      await tx.delete(providerRoleMappings).where(eq(providerRoleMappings.providerConfigId, config.id));
      if (input.roleMappings.length > 0) {
        await tx.insert(providerRoleMappings).values(input.roleMappings.map((mapping) => ({
          providerConfigId: config.id,
          claim: mapping.claim,
          value: mapping.value,
          role: mapping.role,
        })));
      }
      return {
        ...toProviderConfigRecord(config),
        roleMappings: [...input.roleMappings].sort(compareProviderRoleMappings),
      };
    });
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

  async disableMfaTotpFactorsForUser(input: { userId: string; disabledAt?: Date }): Promise<number> {
    const disabledAt = input.disabledAt ?? new Date();
    const rows = await this.db
      .update(mfaFactors)
      .set({
        status: "disabled",
        disabledAt,
        updatedAt: disabledAt,
      })
      .where(and(eq(mfaFactors.userId, input.userId), ne(mfaFactors.status, "disabled")))
      .returning({ id: mfaFactors.id });
    return rows.length;
  }

  async disableOtherMfaTotpFactorsForUser(input: { userId: string; factorId: string; disabledAt?: Date }): Promise<number> {
    const disabledAt = input.disabledAt ?? new Date();
    const rows = await this.db
      .update(mfaFactors)
      .set({
        status: "disabled",
        disabledAt,
        updatedAt: disabledAt,
      })
      .where(and(
        eq(mfaFactors.userId, input.userId),
        ne(mfaFactors.id, input.factorId),
        ne(mfaFactors.status, "disabled"),
      ))
      .returning({ id: mfaFactors.id });
    return rows.length;
  }

  async updateMfaTotpFactorCounter(input: { userId: string; factorId: string; lastUsedCounter: number }): Promise<boolean> {
    const [factor] = await this.db
      .update(mfaFactors)
      .set({
        lastUsedCounter: input.lastUsedCounter,
        updatedAt: new Date(),
      })
      .where(and(
        eq(mfaFactors.userId, input.userId),
        eq(mfaFactors.id, input.factorId),
        or(isNull(mfaFactors.lastUsedCounter), sql`${mfaFactors.lastUsedCounter} < ${input.lastUsedCounter}`),
      ))
      .returning({ id: mfaFactors.id });
    return Boolean(factor);
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

  async markMfaChallengeUsed(input: { challengeId: string; usedAt: Date }): Promise<boolean> {
    const [challenge] = await this.db
      .update(mfaChallenges)
      .set({ usedAt: input.usedAt })
      .where(and(eq(mfaChallenges.id, input.challengeId), isNull(mfaChallenges.usedAt)))
      .returning({ id: mfaChallenges.id });
    return Boolean(challenge);
  }

  async recordAuditEvent(input: CreateAuditEventInput): Promise<void> {
    await this.db.insert(auditEvents).values({
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      decision: input.decision,
      resourceType: input.resourceType ?? "",
      resourceId: input.resourceId && isUuid(input.resourceId) ? input.resourceId : null,
      details: sanitizeAuditDetails(input.details ?? {}),
    });
  }

  async listAuditEvents(input: ListAuditEventsInput): Promise<AuditEventRecord[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
      .limit(input.limit);
    return rows.map(toAuditEventRecord);
  }

  private async rolesForUser(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId));
    const assignedRoles = new Set(rows.map((row) => row.role));
    return authRoles.filter((role) => assignedRoles.has(role));
  }

  private async providerRoleMappingsForConfig(providerConfigId: string): Promise<ProviderRoleMappingRecord[]> {
    const rows = await this.db
      .select({
        claim: providerRoleMappings.claim,
        value: providerRoleMappings.value,
        role: providerRoleMappings.role,
      })
      .from(providerRoleMappings)
      .where(eq(providerRoleMappings.providerConfigId, providerConfigId));
    return rows
      .map((row) => ({
        claim: row.claim,
        value: row.value,
        role: parseProviderMappedRole(row.role),
      }))
      .sort(compareProviderRoleMappings);
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

function toAuthActionTokenRecord(token: typeof authActionTokens.$inferSelect): AuthActionTokenRecord {
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

function toAuditEventRecord(event: typeof auditEvents.$inferSelect): AuditEventRecord {
  return {
    id: event.id,
    actorUserId: event.actorUserId,
    action: event.action,
    decision: event.decision === "allow" ? "allow" : "deny",
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    details: parseAuditDetails(event.details),
    createdAt: event.createdAt,
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

function toProviderConfigRecord(config: typeof providerConfigs.$inferSelect): Omit<ProviderConfigRecord, "roleMappings"> {
  return {
    id: config.id,
    key: config.key,
    type: parseProviderType(config.type),
    displayName: config.displayName,
    issuer: config.issuer,
    clientId: config.clientId,
    enabled: config.enabled,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function parseProviderType(input: string): ProviderType {
  if (
    input === "oidc" ||
    input === "saml" ||
    input === "cloudflare_access" ||
    input === "github" ||
    input === "google"
  ) {
    return input;
  }
  return "oidc";
}

function parseProviderMappedRole(input: Role): ProviderMappedRole {
  if (input === "maintainer" || input === "author" || input === "user") {
    return input;
  }
  return "user";
}

function compareProviderRoleMappings(a: ProviderRoleMappingRecord, b: ProviderRoleMappingRecord): number {
  return `${a.claim}:${a.value}:${a.role}`.localeCompare(`${b.claim}:${b.value}:${b.role}`);
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

function parseAuditDetails(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function isUuid(input: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input);
}
