import { and, eq, gt, isNull } from "drizzle-orm";
import type { RegistrationMode, Role } from "@ai-skills-share/auth";
import type { Database } from "../db/client.js";
import {
  authSessions,
  instanceSettings,
  passwordCredentials,
  roleAssignments,
  users,
} from "../db/schema.js";
import type {
  AuthStore,
  AuthUserRecord,
  AuthUserWithPassword,
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
