import { and, eq, gt, isNull } from "drizzle-orm";
import type { RegistrationMode, Role } from "@ai-skills-share/auth";
import type { Database } from "../db/client.js";
import {
  apiTokens,
  authSessions,
  instanceSettings,
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
  AuthUserWithPassword,
  CreateApiTokenInput,
  CreateSessionInput,
  CreateUserWithPasswordInput,
  CreateUserWithPasswordResult,
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
    await this.db.insert(authSessions).values(input);
  }

  async findUserBySessionTokenHash(tokenHash: string, now = new Date()): Promise<AuthUserRecord | null> {
    const [row] = await this.db
      .select({
        user: users,
        sessionId: authSessions.id,
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
    return { ...toRecord(row.user), roles: await this.rolesForUser(row.user.id) };
  }

  async revokeSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
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

  private async rolesForUser(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: roleAssignments.role })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId));
    return rows.map((row) => row.role);
  }
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
    scope === "skills:submit" ||
    scope === "review:read" ||
    scope === "review:write"
  ));
}
