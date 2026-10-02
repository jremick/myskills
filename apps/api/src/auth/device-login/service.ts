import { randomBytes } from "node:crypto";
import { createApiToken, hashApiToken, hashSessionToken } from "@myskills-app/auth";
import { AppError } from "@myskills-app/core";
import { apiTokenScopes, type ApiTokenScope } from "../types.js";
import { DEVICE_LOGIN_TTL_MS, DEVICE_LOGIN_TOKEN_TTL_MS, deviceRequiresMfa, type DeviceLoginStore } from "./types.js";

export class DeviceLoginService {
  readonly verificationUri: string;
  constructor(private readonly store: DeviceLoginStore, private readonly options: { verificationUri: string; clock?: () => Date }) {
    const url = new URL(options.verificationUri);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/auth/device") {
      throw new Error("Device verification URL must be an HTTPS /auth/device URL (HTTP permitted only on loopback).");
    }
    this.verificationUri = url.href;
  }
  private now(): Date { return this.options.clock?.() ?? new Date(); }
  async start(input: { scopes?: unknown }) {
    const scopes = input.scopes ?? ["profile:read", "skills:read", "architectures:read"];
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > apiTokenScopes.length || scopes.some((s) => typeof s !== "string" || !(apiTokenScopes as readonly string[]).includes(s))) {
      throw new AppError("Valid token scopes are required.", "INVALID_TOKEN_SCOPES", 400);
    }
    const deviceCode = randomBytes(32).toString("base64url");
    // Ten symbols, 32 choices each: 50 bits with no ambiguous 0/1/I/O.
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    const code = [...randomBytes(10)].map((b) => alphabet[b & 31]).join("");
    const userCode = `${code.slice(0, 5)}-${code.slice(5)}`;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + DEVICE_LOGIN_TTL_MS);
    if (!await this.store.create({ deviceCodeHash: hashSessionToken(deviceCode), userCodeHash: hashSessionToken(code), scopes: [...new Set(scopes)] as ApiTokenScope[],
      expiresAt, interval: 5, lastPolledAt: null, status: "pending", userId: null, sessionTokenHash: null, mfaVerifiedAt: null }, now)) {
      throw new AppError("Device login is busy. Try again later.", "DEVICE_LOGIN_LIMIT", 429);
    }
    return { deviceCode, userCode, verificationUri: this.verificationUri, expiresAt: expiresAt.toISOString(), expiresIn: DEVICE_LOGIN_TTL_MS / 1000, interval: 5 };
  }
  async inspect(userCode: unknown, roles: string[]) {
    const request = await this.store.find(userCodeHash(userCode));
    if (!request || request.expiresAt <= this.now() || request.status !== "pending") throw invalidCode();
    return { scopes: request.scopes, expiresAt: request.expiresAt.toISOString(), mfaRequired: deviceRequiresMfa(request.scopes, roles) };
  }
  async decide(input: { userCode: unknown; decision: unknown; userId: string; sessionTokenHash: string }) {
    if (input.decision !== "approve" && input.decision !== "deny") throw new AppError("Choose approve or deny.", "INVALID_DEVICE_DECISION", 400);
    const result = await this.store.decide({ userCodeHash: userCodeHash(input.userCode), decision: input.decision, userId: input.userId, sessionTokenHash: input.sessionTokenHash, now: this.now() });
    if (result === "mfa_required") throw new AppError("Sign in again with MFA to approve these permissions.", "MFA_VERIFICATION_REQUIRED", 403);
    if (result === "session_revoked") throw new AppError("Sign in again to authorize CLI access.", "AUTHENTICATION_REQUIRED", 401);
    if (result === "already_decided") throw new AppError("This device request was already decided.", "DEVICE_ALREADY_DECIDED", 409);
    if (result === "invalid") throw invalidCode();
    return { status: result };
  }
  async poll(deviceCode: unknown) {
    if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(deviceCode)) throw invalidCode();
    const now = this.now();
    const token = createApiToken();
    const result = await this.store.poll({ deviceCodeHash: hashSessionToken(deviceCode), now, token: { name: "CLI browser login", tokenHash: hashApiToken(token), tokenPrefix: token.slice(0, 12), expiresAt: new Date(now.getTime() + DEVICE_LOGIN_TOKEN_TTL_MS) } });
    return result.status === "authorized" ? { ...result, expiresAt: result.expiresAt.toISOString(), token } : result;
  }
}
function userCodeHash(input: unknown): string {
  if (typeof input !== "string" || input.length > 32) throw invalidCode();
  const code = input.replace(/[ -]/g, "").toUpperCase();
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/.test(code)) throw invalidCode();
  return hashSessionToken(code);
}
function invalidCode() { return new AppError("Invalid or expired device code.", "INVALID_DEVICE_CODE", 400); }
