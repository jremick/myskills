import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/password.js";

test("hashes and verifies a bcrypt password", async () => {
  const passwordHash = await hashPassword("correct horse battery staple");

  assert.match(passwordHash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword(passwordHash, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(passwordHash, "wrong horse battery staple"), false);
  assert.equal(await verifyPassword(passwordHash, "short"), false);
});

test("rejects short passwords before hashing", async () => {
  await assert.rejects(() => hashPassword("too-short"));
});
