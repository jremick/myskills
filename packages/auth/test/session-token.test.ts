import test from "node:test";
import assert from "node:assert/strict";
import {
  createApiToken,
  createSessionToken,
  hashApiToken,
  hashSessionToken,
} from "../src/session-token.js";

test("creates opaque session tokens and stable hashes", () => {
  const token = createSessionToken();
  const other = createSessionToken();

  assert.notEqual(token, other);
  assert.equal(Buffer.from(token, "base64url").byteLength, 32);
  assert.equal(hashSessionToken("fixed-session-token"), "3ad00d19eda1e38e0bfbfd4c483b9c7d626b60e0d2699115670e3b323a4fa5e8");
  assert.notEqual(hashSessionToken(token), token);
  assert.notEqual(hashSessionToken(token), hashSessionToken(other));
});

test("creates opaque API tokens and stable hashes", () => {
  const token = createApiToken();
  const other = createApiToken();

  assert.equal(token.startsWith("aiss_"), true);
  assert.equal(Buffer.from(token.slice("aiss_".length), "base64url").byteLength, 32);
  assert.notEqual(token, other);
  assert.equal(hashApiToken("aiss_fixed-api-token"), "65e1dc8fce7652d76166aa70aae7b13123909e9b8b30418d1ba550acb8464a59");
  assert.notEqual(hashApiToken(token), token);
  assert.notEqual(hashApiToken(token), hashApiToken(other));
  assert.notEqual(hashApiToken(token), hashApiToken(`${token.slice(0, 12)}wrong-secret`));
});
