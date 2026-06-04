import test from "node:test";
import assert from "node:assert/strict";
import { createSessionToken, hashSessionToken } from "../src/session-token.js";

test("creates opaque session tokens and stable hashes", () => {
  const token = createSessionToken();
  const other = createSessionToken();

  assert.notEqual(token, other);
  assert.equal(hashSessionToken(token), hashSessionToken(token));
  assert.notEqual(hashSessionToken(token), hashSessionToken(other));
});
