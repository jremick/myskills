import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

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
  if (password.length > 1024) {
    throw new Error("Password is too long.");
  }
}
