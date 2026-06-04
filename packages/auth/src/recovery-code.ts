import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_COUNT = 10;

export function createRecoveryCode(): string {
  const raw = randomBytes(RECOVERY_CODE_BYTES).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const code = raw.padEnd(16, "0").slice(0, 16);
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function createRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Recovery code count must be between 1 and 20.");
  }
  return Array.from({ length: count }, createRecoveryCode);
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

export function verifyRecoveryCodeHash(code: string, hash: string): boolean {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    return false;
  }
  const actual = Buffer.from(hashRecoveryCode(code), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalizeRecoveryCode(code: string): string {
  if (typeof code !== "string") {
    throw new Error("Recovery code must be a string.");
  }
  const normalized = code.trim().toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z0-9]{12,32}$/.test(normalized)) {
    throw new Error("Recovery code is invalid.");
  }
  return normalized;
}
