import assert from "node:assert/strict";
import test from "node:test";
import { createApiToken, createSessionToken, hashApiToken, hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import { deviceApproval } from "../src/auth/device-login/approval.js";
import { MemoryDeviceLoginStore } from "../src/auth/device-login/memory-store.js";
import { DeviceLoginService } from "../src/auth/device-login/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const now = new Date("2026-10-15T12:00:00.000Z");
const stale = new Date(now.getTime() - 15 * 60_000);

test("deviceApproval opens without a policy or with a fresh stamp, otherwise enrolls or verifies", () => {
  assert.equal(deviceApproval({ scopes: ["profile:read", "skills:read"], roles: ["user"], mfaVerifiedAt: null, factorCount: 0, now }), "open");
  assert.equal(deviceApproval({ scopes: ["skills:submit"], roles: ["user"], mfaVerifiedAt: null, factorCount: 0, now }), "enroll");
  assert.equal(deviceApproval({ scopes: ["targets:execute"], roles: ["user"], mfaVerifiedAt: null, factorCount: 0, now }), "enroll");
  assert.equal(deviceApproval({ scopes: ["skills:submit"], roles: ["user"], mfaVerifiedAt: null, factorCount: 1, now }), "verify");
  assert.equal(deviceApproval({ scopes: ["profile:read"], roles: ["owner"], mfaVerifiedAt: null, factorCount: 2, now }), "verify");
  assert.equal(deviceApproval({ scopes: ["skills:submit"], roles: ["user"], mfaVerifiedAt: now, factorCount: 0, now }), "open");
  assert.equal(deviceApproval({ scopes: ["profile:read"], roles: ["admin"], mfaVerifiedAt: new Date(now.getTime() - 14 * 60_000), factorCount: 0, now }), "open");
  assert.equal(deviceApproval({ scopes: ["skills:submit"], roles: ["maintainer"], mfaVerifiedAt: stale, factorCount: 1, now }), "verify");
});

test("inspect returns enroll, verify, or open from the session stamp and omits mfaRequired", async () => {
  const auth = new MemoryAuthStore();
  const user = (await auth.createUserWithPassword({ email: "device@example.com", name: "Device fixture", passwordHash: "unused-fixture-hash" })).user!;
  await auth.updateUserStatus({ userId: user.id, status: "active", emailVerifiedAt: now });
  const plain = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(plain), expiresAt: new Date(now.getTime() + 3_600_000) });
  const service = new AuthService(auth);
  const facts = await service.browserSessionFacts(hashSessionToken(plain));
  assert.deepEqual(facts, { userId: user.id, email: "device@example.com", roles: ["user"], mfaVerifiedAt: null, factorCount: 0 });
  assert.equal(await service.browserSessionFacts(hashSessionToken("missing-session")), null);

  const app = buildApp({
    skillRepository: new MemorySkillRepository([]),
    authService: service,
    deviceLoginService: new DeviceLoginService(new MemoryDeviceLoginStore(auth), { verificationUri: "http://127.0.0.1:3000/auth/device", clock: () => now }),
  });
  const call = (url: string, payload: unknown, token?: string) => app.inject({
    method: "POST",
    url: `/v1/auth/device/${url}`,
    payload: payload as Record<string, unknown>,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  try {
    const apiToken = createApiToken();
    await auth.createApiToken({ userId: user.id, name: "Cannot inspect", scopes: ["profile:read"], tokenHash: hashApiToken(apiToken), tokenPrefix: apiToken.slice(0, 12), expiresAt: new Date(now.getTime() + 3_600_000) });
    const started = await call("start", { scopes: ["skills:submit"] });
    assert.equal(started.statusCode, 200);
    const userCode = started.json().userCode as string;
    assert.equal((await call("inspect", { userCode }, apiToken)).statusCode, 403);

    const enroll = await call("inspect", { userCode }, plain);
    assert.equal(enroll.statusCode, 200);
    assert.equal(enroll.json().approval, "enroll");
    assert.deepEqual(enroll.json().account, { email: "device@example.com" });
    assert.equal(Object.hasOwn(enroll.json(), "mfaRequired"), false);

    const factor = await auth.createMfaTotpFactor({ userId: user.id, label: "phone", secretCiphertext: "cipher" });
    assert.ok(await auth.enableMfaTotpFactor({ userId: user.id, factorId: factor.id, lastUsedCounter: 1 }));
    const verify = await call("inspect", { userCode }, plain);
    assert.equal(verify.json().approval, "verify");
    assert.equal(Object.hasOwn(verify.json(), "mfaRequired"), false);

    const aged = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(aged), expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: stale });
    assert.equal((await call("inspect", { userCode }, aged)).json().approval, "verify");

    const fresh = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(fresh), expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: now });
    const open = await call("inspect", { userCode }, fresh);
    assert.equal(open.json().approval, "open");
    assert.equal(Object.hasOwn(open.json(), "mfaRequired"), false);
    const stamped = await service.browserSessionFacts(hashSessionToken(fresh));
    assert.equal(stamped?.mfaVerifiedAt?.toISOString(), now.toISOString());
    assert.equal(stamped?.factorCount, 1);

    const reads = await call("start", { scopes: ["profile:read", "skills:read"] });
    assert.equal((await call("inspect", { userCode: reads.json().userCode }, plain)).json().approval, "open");
  } finally {
    await app.close();
  }
});
