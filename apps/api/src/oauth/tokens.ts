import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// A '.' never occurs in base64url session tokens or aiss_ API tokens, so the
// prefix alone identifies a connector credential without a database lookup.
export const ACCESS_TOKEN_PREFIX = "myskills_at.";
export const REFRESH_TOKEN_PREFIX = "myskills_rt.";
export const AUTHORIZATION_CODE_PREFIX = "myskills_ac.";
export const CLIENT_SECRET_PREFIX = "myskills_cs.";
export const DYNAMIC_CLIENT_PREFIX = "msc_";

const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const REQUEST_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function randomSecret(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function randomClientId(): string {
  return `${DYNAMIC_CLIENT_PREFIX}${randomBytes(18).toString("base64url")}`;
}

/** Indexed lookup digest for 256-bit random values; not password hashing. */
export function secretDigest(value: string): string {
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hasTokenShape(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && TOKEN_BODY_PATTERN.test(value.slice(prefix.length));
}

export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER_PATTERN.test(verifier) || !PKCE_CHALLENGE_PATTERN.test(challenge)) return false;
  return digestsEqual(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);
}

export function isPkceVerifier(value: string): boolean {
  return PKCE_VERIFIER_PATTERN.test(value);
}
