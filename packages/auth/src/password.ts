import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;
const MAX_NEW_PASSWORD_BYTES = 72;

export async function hashPassword(password: string): Promise<string> {
  validatePasswordInput(password);
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (typeof passwordHash !== "string" || !passwordHash) {
    return false;
  }
  if (typeof password !== "string" || password.length > 1024) {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}

export function validatePasswordInput(password: string): void {
  if (typeof password !== "string") {
    throw new Error("Password must be a string.");
  }
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }
  if (Buffer.byteLength(password, "utf8") > MAX_NEW_PASSWORD_BYTES) {
    throw new Error("Password must be at most 72 UTF-8 bytes. Non-ASCII characters can use more than one byte.");
  }
}
