import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
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

test("new passwords respect the 72-byte bcrypt boundary", async () => {
  for (const password of ["a".repeat(72), "é".repeat(36), "🦉".repeat(18)]) {
    const hash = await hashPassword(password);
    assert.equal(await verifyPassword(hash, password), true);
    await assert.rejects(() => hashPassword(`${password}x`), /at most 72 UTF-8 bytes/);
  }
  await assert.rejects(() => hashPassword("é".repeat(37)), /at most 72 UTF-8 bytes/);
});

test("existing bcrypt credentials still verify legacy passwords longer than 72 bytes", async () => {
  const password = `${"a".repeat(72)}legacy suffix`;
  const legacyHash = await bcrypt.hash(password, 4);
  assert.equal(await verifyPassword(legacyHash, password), true);
  assert.equal(await verifyPassword(legacyHash, "b".repeat(72)), false);
});
