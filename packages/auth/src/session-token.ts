import { createHash, randomBytes } from "node:crypto";

export const SESSION_TOKEN_BYTES = 32;
export const API_TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createApiToken(): string {
  return `aiss_${randomBytes(API_TOKEN_BYTES).toString("base64url")}`;
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
