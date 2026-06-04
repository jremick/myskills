import { AppError } from "@ai-skills-share/core";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
  type AuthenticatedUser,
} from "@ai-skills-share/auth";
import type { AuthRateLimiter } from "./rate-limit.js";
import type { AuthResponseUser, AuthStore, AuthUserRecord } from "./types.js";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface RegisterInput {
  email: string;
  password: string;
  name?: string;
  ip?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  ip?: string;
}

export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly options: {
      sessionTtlMs?: number;
      loginLimiter?: AuthRateLimiter;
      registrationLimiter?: AuthRateLimiter;
    } = {},
  ) {}

  async register(input: RegisterInput): Promise<{ status: "pending" }> {
    const mode = await this.store.getRegistrationMode();
    if (mode === "closed") {
      throw new AppError("Registration is closed.", "REGISTRATION_CLOSED", 403);
    }

    const email = normalizeEmail(input.email);
    assertAllowed(this.options.registrationLimiter, rateLimitKeys("register", email, input.ip));
    const passwordHash = await hashPassword(input.password);
    await this.store.createUserWithPassword({
      email,
      name: cleanName(input.name),
      passwordHash,
    });
    return { status: "pending" };
  }

  async login(input: LoginInput): Promise<{ token: string; expiresAt: string; user: AuthResponseUser }> {
    const email = normalizeEmail(input.email);
    assertAllowed(this.options.loginLimiter, rateLimitKeys("login", email, input.ip));
    const user = await this.store.findUserByEmailWithPassword(email);
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new AppError("Invalid email or password.", "INVALID_CREDENTIALS", 401);
    }
    if (user.status !== "active" || !user.emailVerifiedAt) {
      throw new AppError("Account is not active.", "ACCOUNT_NOT_ACTIVE", 403);
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + (this.options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS));
    await this.store.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: responseUser(user),
    };
  }

  async authenticateAuthorizationHeader(header: string | undefined): Promise<AuthResponseUser | null> {
    const token = bearerToken(header);
    if (!token) {
      return null;
    }
    const user = await this.store.findUserBySessionTokenHash(hashSessionToken(token));
    return user && isUsableAuthenticatedAccount(user) ? responseUser(user) : null;
  }

  async logout(header: string | undefined): Promise<void> {
    const token = bearerToken(header);
    if (token) {
      await this.store.revokeSessionByTokenHash(hashSessionToken(token));
    }
  }
}

function responseUser(user: AuthUserRecord): AuthResponseUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    roles: user.roles,
    emailVerified: Boolean(user.emailVerifiedAt),
    mfaVerified: false,
  };
}

function isUsableAuthenticatedAccount(user: AuthUserRecord): boolean {
  return user.status === "active" && Boolean(user.emailVerifiedAt);
}

function assertAllowed(limiter: AuthRateLimiter | undefined, keys: string[]): void {
  if (!limiter) {
    return;
  }
  for (const key of keys) {
    const result = limiter.consume(key);
    if (!result.allowed) {
      throw new AppError("Too many attempts. Try again later.", "RATE_LIMITED", 429);
    }
  }
}

function rateLimitKeys(kind: string, email: string, ip: string | undefined): string[] {
  const source = ip?.trim() || "unknown";
  return [
    `${kind}:ip:${source}`,
    `${kind}:ip-email:${source}:${email}`,
  ];
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeEmail(email: string): string {
  if (typeof email !== "string") {
    throw new AppError("A valid email address is required.", "INVALID_EMAIL", 400);
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AppError("A valid email address is required.", "INVALID_EMAIL", 400);
  }
  return normalized;
}

function cleanName(name: string | undefined): string {
  if (name !== undefined && typeof name !== "string") {
    throw new AppError("Name must be a string.", "INVALID_NAME", 400);
  }
  return (name ?? "").trim().slice(0, 120);
}

export function asAuthenticatedUser(user: AuthResponseUser): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    roles: user.roles,
    mfaVerified: user.mfaVerified,
  };
}
