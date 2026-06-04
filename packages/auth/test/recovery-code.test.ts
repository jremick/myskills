import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryCodes, hashRecoveryCode, verifyRecoveryCodeHash } from "../src/recovery-code.js";

test("creates human-typable recovery codes", () => {
  const codes = createRecoveryCodes();

  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
  }
});

test("hashes recovery codes without exposing plaintext", () => {
  const code = "abcd-1234-efgh-5678";
  const hash = hashRecoveryCode(code);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash.includes("abcd"), false);
  assert.equal(verifyRecoveryCodeHash("ABCD 1234 EFGH 5678", hash), true);
  assert.equal(verifyRecoveryCodeHash("abcd-1234-efgh-0000", hash), false);
});
