import { AppError } from "@ai-skills-share/core";
import {
  createApiToken,
  createSessionToken,
  hashApiToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
  type AuthenticatedUser,
} from "@ai-skills-share/auth";
import type { AuthRateLimiter } from "./rate-limit.js";
import {
  apiTokenScopes,
  type ApiTokenRecord,
  type ApiTokenScope,
  type AuthResponseUser,
  type AuthStore,
  type AuthUserRecord,
} from "./types.js";

const DEFAULT_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DEFAULT_API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const MAX_API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const API_TOKEN_PREFIX_LENGTH = 12;

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

export interface CreateApiTokenRequest {
  name: string;
  scopes: ApiTokenScope[];
  expiresAt?: string;
}

export interface SafeApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiToken extends SafeApiToken {
  token: string;
}

export interface AuthContext {
  user: AuthResponseUser;
  credential: {
    kind: "session" | "api_token";
    scopes: ApiTokenScope[];
    tokenId?: string;
  };
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
    return (await this.authenticateRequest(header))?.user ?? null;
  }

  async authenticateRequest(header: string | undefined): Promise<AuthContext | null> {
    const token = bearerToken(header);
    if (!token) {
      return null;
    }
    const sessionUser = await this.store.findUserBySessionTokenHash(hashSessionToken(token));
    if (sessionUser && isUsableAuthenticatedAccount(sessionUser)) {
      return {
        user: responseUser(sessionUser),
        credential: {
          kind: "session",
          scopes: [...apiTokenScopes],
        },
      };
    }
    const apiTokenUser = await this.store.findUserByApiTokenHash(hashApiToken(token));
    if (apiTokenUser && isUsableAuthenticatedAccount(apiTokenUser)) {
      return {
        user: responseUser(apiTokenUser),
        credential: {
          kind: "api_token",
          tokenId: apiTokenUser.apiTokenId,
          scopes: apiTokenUser.apiTokenScopes,
        },
      };
    }
    return null;
  }

  async authenticateSessionAuthorizationHeader(header: string | undefined): Promise<AuthResponseUser | null> {
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

  async createApiToken(actor: AuthResponseUser, input: CreateApiTokenRequest): Promise<CreatedApiToken> {
    const token = createApiToken();
    const expiresAt = parseApiTokenExpiry(input.expiresAt);
    const record = await this.store.createApiToken({
      userId: actor.id,
      name: cleanTokenName(input.name),
      tokenPrefix: token.slice(0, API_TOKEN_PREFIX_LENGTH),
      tokenHash: hashApiToken(token),
      scopes: normalizeScopes(input.scopes),
      expiresAt,
    });
    return {
      ...safeApiToken(record),
      token,
    };
  }

  async listApiTokens(actor: AuthResponseUser): Promise<SafeApiToken[]> {
    return (await this.store.listApiTokensForUser(actor.id)).map(safeApiToken);
  }

  async revokeApiToken(actor: AuthResponseUser, tokenId: string): Promise<SafeApiToken> {
    const token = await this.store.revokeApiToken({ userId: actor.id, tokenId });
    if (!token) {
      throw new AppError("API token not found.", "API_TOKEN_NOT_FOUND", 404);
    }
    return safeApiToken(token);
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

function cleanTokenName(name: string): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new AppError("Token name is required.", "INVALID_TOKEN_NAME", 400);
  }
  return name.trim().slice(0, 80);
}

function normalizeScopes(scopes: ApiTokenScope[]): ApiTokenScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new AppError("At least one token scope is required.", "INVALID_TOKEN_SCOPES", 400);
  }
  const allowed = new Set<ApiTokenScope>(apiTokenScopes);
  const result: ApiTokenScope[] = [];
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new AppError("Unsupported token scope.", "INVALID_TOKEN_SCOPES", 400);
    }
    if (!result.includes(scope)) {
      result.push(scope);
    }
  }
  return result;
}

function parseApiTokenExpiry(input: string | undefined): Date {
  const now = Date.now();
  if (!input) {
    return new Date(now + DEFAULT_API_TOKEN_TTL_MS);
  }
  const expiresAt = new Date(input);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now) {
    throw new AppError("Token expiry must be a future ISO date.", "INVALID_TOKEN_EXPIRY", 400);
  }
  if (expiresAt.getTime() - now > MAX_API_TOKEN_TTL_MS) {
    throw new AppError("Token expiry cannot be more than one year away.", "INVALID_TOKEN_EXPIRY", 400);
  }
  return expiresAt;
}

function safeApiToken(token: ApiTokenRecord): SafeApiToken {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scopes: token.scopes,
    expiresAt: token.expiresAt.toISOString(),
    revokedAt: token.revokedAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
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
