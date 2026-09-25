import assert from "node:assert/strict";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { AppError } from "@myskills-app/core";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { MemoryAuthRateLimiter } from "../src/auth/rate-limit.js";
import { AuthService } from "../src/auth/service.js";

test("valid challenges share an account MFA budget across rotating IPs and tokens", async () => {
  const store = new MemoryAuthStore();
  const first = store.addUser({ email: "first@example.test", status: "active", emailVerifiedAt: new Date() });
  const second = store.addUser({ email: "second@example.test", status: "active", emailVerifiedAt: new Date() });
  const limiter = new MemoryAuthRateLimiter({ maxAttempts: 5, windowMs: 900_000 });
  let now = new Date();
  const charged: string[] = [];
  const service = new AuthService(store, { mfaLimiter: { consume(key) { charged.push(key); return limiter.consume(key, now); } } });
  const codeIs = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
  await assert.rejects(service.verifyMfaChallenge({ challengeToken: "unknown-token-with-sufficient-length", code: "000000", ip: "203.0.113.100" }), codeIs("INVALID_MFA_CODE"));
  assert.equal(charged.some((key) => key.startsWith("mfa:account:")), false);
  async function attempt(userId: string, index: number) {
    const token = `challenge-token-with-sufficient-length-${index}`;
    await store.createMfaChallenge({ userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 300_000) });
    return service.verifyMfaChallenge({ challengeToken: token, code: "000000", ip: `203.0.113.${index}` });
  }
  const outcomes = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => attempt(first.id, index + 1)));
  assert.equal(outcomes.filter((result) => result.status === "rejected" && codeIs("INVALID_MFA_CODE")(result.reason)).length, 5);
  assert.equal(outcomes.filter((result) => result.status === "rejected" && codeIs("RATE_LIMITED")(result.reason)).length, 1);
  await assert.rejects(attempt(second.id, 7), codeIs("INVALID_MFA_CODE"));
  now = new Date(now.getTime() + 900_000);
  await assert.rejects(attempt(first.id, 8), codeIs("INVALID_MFA_CODE"));
});
