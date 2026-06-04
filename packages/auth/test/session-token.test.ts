import test from "node:test";
import assert from "node:assert/strict";
import { createApiToken, createSessionToken, hashApiToken, hashSessionToken } from "../src/session-token.js";

test("creates opaque session tokens and stable hashes", () => {
  const token = createSessionToken();
  const other = createSessionToken();

  assert.notEqual(token, other);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), hashSessionToken(other));
});

test("creates opaque API tokens and stable hashes", () => {
  const token = createApiToken();
  const other = createApiToken();

  assert.equal(token.startsWith("aiss_"), true);
  assert.notEqual(token, other);
  assert.equal(hashApiToken(token), hashApiToken(token));
  assert.notEqual(hashApiToken(token), hashApiToken(other));
  assert.notEqual(hashApiToken(token), hashApiToken(`${token.slice(0, 12)}wrong-secret`));
});
