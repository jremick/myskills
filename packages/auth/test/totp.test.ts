import test from "node:test";
import assert from "node:assert/strict";
import { createTotpSecret, createTotpUri, generateTotpCode, verifyTotpCode } from "../src/totp.js";

const RFC_6238_SHA1_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("generates RFC 6238 compatible TOTP codes", () => {
  assert.equal(generateTotpCode(RFC_6238_SHA1_SECRET, { now: 59_000, digits: 8 }), "94287082");
  assert.equal(generateTotpCode(RFC_6238_SHA1_SECRET, { now: 1_111_111_109_000, digits: 8 }), "07081804");
  assert.equal(generateTotpCode(RFC_6238_SHA1_SECRET, { now: 2_000_000_000_000, digits: 8 }), "69279037");
});

test("verifies current and adjacent TOTP windows explicitly", () => {
  const code = generateTotpCode(RFC_6238_SHA1_SECRET, { now: 60_000 });

  assert.deepEqual(verifyTotpCode(RFC_6238_SHA1_SECRET, code, { now: 60_000, window: 0 }), {
    valid: true,
    counter: 2,
  });
  assert.equal(verifyTotpCode(RFC_6238_SHA1_SECRET, code, { now: 90_000, window: 1 }).valid, true);
  assert.equal(verifyTotpCode(RFC_6238_SHA1_SECRET, code, { now: 120_000, window: 0 }).valid, false);
});

test("rejects malformed TOTP codes", () => {
  assert.equal(verifyTotpCode(RFC_6238_SHA1_SECRET, "12345", { now: 60_000 }).valid, false);
  assert.equal(verifyTotpCode(RFC_6238_SHA1_SECRET, "1234567", { now: 60_000 }).valid, false);
  assert.equal(verifyTotpCode(RFC_6238_SHA1_SECRET, "abcdef", { now: 60_000 }).valid, false);
});

test("creates authenticator app bootstrap material", () => {
  const secret = createTotpSecret();
  const uri = createTotpUri({
    issuer: "MySkills",
    accountName: "owner@example.com",
    secret,
  });

  assert.match(secret, /^[A-Z2-7]{26,}$/);
  assert.equal(uri.startsWith("otpauth://totp/MySkills:owner%40example.com?"), true);
  assert.equal(uri.includes(`secret=${secret}`), true);
});
