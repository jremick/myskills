import assert from "node:assert/strict";
import { createApiToken, createSessionToken, hashApiToken, hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import type { AuthStore } from "../src/auth/types.js";
import { DeviceLoginService } from "../src/auth/device-login/service.js";
import type { DeviceLoginStore } from "../src/auth/device-login/types.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

// First written before production code. These exercise consent and token use at
// the actual API boundary, with a second API instance and a recreated service.
export async function deviceLoginJourney(auth: AuthStore, storeInput: DeviceLoginStore | ((clock: () => Date) => DeviceLoginStore)) {
  let now = new Date();
  const store = typeof storeInput === "function" ? storeInput(() => now) : storeInput;
  const user = (await auth.createUserWithPassword({ email: "device@example.com", name: "Device fixture", passwordHash: "unused-fixture-hash" })).user!;
  await auth.updateUserStatus({ userId: user.id, status: "active", emailVerifiedAt: now });
  let session = createSessionToken();
  await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(now.getTime() + 3_600_000) });
  const options = { verificationUri: "http://127.0.0.1:3000/auth/device", clock: () => now };
  const app = () => buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(auth), deviceLoginService: new DeviceLoginService(store, options) });
  const first = app();
  const second = app();
  const call = (url: string, payload: unknown, token?: string, target = first) => target.inject({ method: "POST", url: `/v1/auth/device/${url}`, payload: payload as Record<string, unknown>, headers: token ? { authorization: `Bearer ${token}` } : {} });
  try {
    assert.equal((await call("start", { scopes: ["admin:invented"] })).statusCode, 400);
    const started = await call("start", { scopes: ["profile:read", "skills:read"] });
    assert.equal(started.statusCode, 200);
    const request = started.json();
    assert.equal(request.verificationUri, options.verificationUri);
    assert.equal(new URL(request.verificationUri).search, "");
    assert.equal((await call("inspect", { userCode: request.userCode })).statusCode, 401);
    const apiToken = createApiToken();
    await auth.createApiToken({ userId: user.id, name: "Cannot approve", scopes: ["profile:read"], tokenHash: hashApiToken(apiToken), tokenPrefix: apiToken.slice(0, 12), expiresAt: new Date(now.getTime() + 3_600_000) });
    assert.equal((await call("decision", { userCode: request.userCode, decision: "approve" }, apiToken)).statusCode, 403);
    assert.equal((await call("poll", { deviceCode: request.deviceCode })).json().status, "pending");
    const fast = (await call("poll", { deviceCode: request.deviceCode }, undefined, second)).json();
    assert.equal(fast.status, "slow_down");
    assert.equal(fast.interval, request.interval + 5);
    const inspect = await call("inspect", { userCode: request.userCode }, session);
    assert.equal(inspect.statusCode, 200);
    assert.deepEqual(inspect.json().scopes, ["profile:read", "skills:read"]);
    assert.equal((await call("decision", { userCode: request.userCode, decision: "approve" }, session)).statusCode, 200);
    assert.equal((await call("decision", { userCode: request.userCode, decision: "approve" }, session)).statusCode, 409);
    now = new Date(now.getTime() + 10_001);
    const polls = await Promise.all([call("poll", { deviceCode: request.deviceCode }), call("poll", { deviceCode: request.deviceCode }, undefined, second)]);
    assert.equal(polls.filter((r) => r.json().status === "authorized").length, 1);
    const granted = polls.find((r) => r.json().status === "authorized")!.json();
    assert.equal((await first.inject({ url: "/v1/me", headers: { authorization: `Bearer ${granted.token}` } })).statusCode, 200);
    assert.equal((await first.inject({ url: "/v1/admin/users", headers: { authorization: `Bearer ${granted.token}` } })).statusCode, 403);
    assert.equal((await call("poll", { deviceCode: request.deviceCode })).json().status, "invalid");
    await auth.revokeApiToken({ userId: user.id, tokenId: granted.tokenId });
    assert.equal((await first.inject({ url: "/v1/me", headers: { authorization: `Bearer ${granted.token}` } })).statusCode, 401);

    const denied = (await call("start", {})).json();
    await call("decision", { userCode: denied.userCode, decision: "deny" }, session);
    assert.equal((await call("poll", { deviceCode: denied.deviceCode })).json().status, "denied");
    const expired = (await call("start", {})).json();
    now = new Date(now.getTime() + 301_000);
    assert.equal((await call("poll", { deviceCode: expired.deviceCode })).json().status, "expired");

    const mfa = (await call("start", { scopes: ["skills:submit"] })).json();
    assert.equal((await call("decision", { userCode: mfa.userCode, decision: "approve" }, session)).json().error.code, "MFA_VERIFICATION_REQUIRED");
    session = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: new Date(now.getTime() - 901_000) });
    assert.equal((await call("decision", { userCode: mfa.userCode, decision: "approve" }, session)).json().error.code, "MFA_VERIFICATION_REQUIRED");
    session = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: now });
    assert.equal((await call("decision", { userCode: mfa.userCode, decision: "approve" }, session)).statusCode, 200);
    await auth.revokeSessionByTokenHash(hashSessionToken(session));
    assert.equal((await call("poll", { deviceCode: mfa.deviceCode })).json().status, "denied");

    const freshSession = createSessionToken();
    await auth.createSession({ userId: user.id, tokenHash: hashSessionToken(freshSession), expiresAt: new Date(now.getTime() + 3_600_000) });
    const disabled = (await call("start", {})).json();
    await call("decision", { userCode: disabled.userCode, decision: "approve" }, freshSession);
    await auth.updateUserStatus({ userId: user.id, status: "disabled" });
    assert.equal((await call("poll", { deviceCode: disabled.deviceCode })).json().status, "denied");
    return { assertions: "scopes, session-only consent, shared polling, replay, expiry, denial, fresh MFA, account/session revocation and token scope/revocation", replicas: 2 };
  } finally { await Promise.all([first.close(), second.close()]); }
}
