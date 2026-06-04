import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_SECRET_BYTES = 20;
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;

export interface TotpOptions {
  now?: Date | number;
  periodSeconds?: number;
  digits?: number;
}

export interface TotpVerifyOptions extends TotpOptions {
  window?: number;
}

export interface TotpVerificationResult {
  valid: boolean;
  counter?: number;
}

export function createTotpSecret(byteLength = DEFAULT_SECRET_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new Error("TOTP secret byte length must be between 16 and 64.");
  }
  return base32Encode(randomBytes(byteLength));
}

export function createTotpUri(input: {
  issuer: string;
  accountName: string;
  secret: string;
  periodSeconds?: number;
  digits?: number;
}): string {
  const issuer = cleanTotpLabelPart(input.issuer, "issuer");
  const accountName = cleanTotpLabelPart(input.accountName, "accountName");
  const secret = normalizeBase32Secret(input.secret);
  const period = input.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const digits = input.digits ?? DEFAULT_DIGITS;
  validateTotpOptions(period, digits);

  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateTotpCode(secret: string, options: TotpOptions = {}): string {
  const period = options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  validateTotpOptions(period, digits);
  const counter = totpCounter(options.now ?? Date.now(), period);
  return generateTotpCodeForCounter(secret, counter, digits);
}

export function verifyTotpCode(secret: string, code: string, options: TotpVerifyOptions = {}): TotpVerificationResult {
  const period = options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const digits = options.digits ?? DEFAULT_DIGITS;
  const window = options.window ?? DEFAULT_WINDOW;
  validateTotpOptions(period, digits);
  if (!Number.isInteger(window) || window < 0 || window > 10) {
    throw new Error("TOTP verification window must be between 0 and 10.");
  }
  const normalizedCode = normalizeTotpCode(code, digits);
  if (!normalizedCode) {
    return { valid: false };
  }

  const currentCounter = totpCounter(options.now ?? Date.now(), period);
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = currentCounter + offset;
    if (counter < 0) {
      continue;
    }
    const expected = generateTotpCodeForCounter(secret, counter, digits);
    if (timingSafeStringEqual(normalizedCode, expected)) {
      return { valid: true, counter };
    }
  }
  return { valid: false };
}

function generateTotpCodeForCounter(secret: string, counter: number, digits: number): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  );
  return String(binary % (10 ** digits)).padStart(digits, "0");
}

function totpCounter(now: Date | number, periodSeconds: number): number {
  const ms = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("TOTP timestamp must be a non-negative time.");
  }
  return Math.floor(Math.floor(ms / 1000) / periodSeconds);
}

function base32Encode(input: Buffer): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = normalizeBase32Secret(input);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("TOTP secret must be base32 encoded.");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function normalizeBase32Secret(secret: string): string {
  if (typeof secret !== "string") {
    throw new Error("TOTP secret must be a string.");
  }
  const normalized = secret.replace(/[\s=]/g, "").toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("TOTP secret must be base32 encoded.");
  }
  return normalized;
}

function normalizeTotpCode(code: string, digits: number): string | null {
  if (typeof code !== "string") {
    return null;
  }
  const normalized = code.trim().replace(/\s/g, "");
  return new RegExp(`^\\d{${digits}}$`).test(normalized) ? normalized : null;
}

function validateTotpOptions(periodSeconds: number, digits: number): void {
  if (!Number.isInteger(periodSeconds) || periodSeconds < 15 || periodSeconds > 300) {
    throw new Error("TOTP period must be between 15 and 300 seconds.");
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP digits must be between 6 and 8.");
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanTotpLabelPart(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim().slice(0, 120);
}
