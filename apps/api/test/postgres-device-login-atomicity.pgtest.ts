import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresDeviceLoginStore } from "../src/auth/device-login/postgres-store.js";
import { DEVICE_LOGIN_MAX_REQUESTS, type DeviceLoginRequest, type DeviceLoginStore } from "../src/auth/device-login/types.js";

type Pool = ReturnType<typeof createPgPool>;

test("Postgres device decisions serialize, roll back issuance and recheck time after real lock waits", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(^|[_/-])(test|ci)([_/-]|$)/i);
  const observer = createPgPool(databaseUrl);
  t.after(() => observer.end());
  await observer.query("DROP SCHEMA IF EXISTS public CASCADE");
  await observer.query("CREATE SCHEMA public");
  await runMigrations(observer);
  // Canonical role changes preserve at least one active instance owner.
  const owner = await observer.query<{ id: string }>("INSERT INTO users (email, normalized_email, status, email_verified_at) VALUES ('device-suite-owner@example.test', 'device-suite-owner@example.test', 'active', clock_timestamp()) RETURNING id");
  await observer.query("INSERT INTO role_assignments (user_id, role, scope_type, scope_id) VALUES ($1, 'owner', 'instance', '00000000-0000-0000-0000-000000000000')", [owner.rows[0]!.id]);
  const names = [`device-a-${randomUUID()}`, `device-b-${randomUUID()}`];
  const pools = names.map((name) => {
    const url = new URL(databaseUrl);
    url.searchParams.set("application_name", name);
    return createPgPool(url.href);
  });
  for (const pool of pools) t.after(() => pool.end());
  let now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const stores = pools.map((pool) => new PostgresDeviceLoginStore(createDb(pool), () => now));
  const auth = pools.map((pool) => new PostgresAuthStore(createDb(pool)));
  const fixture = async (scopes: DeviceLoginRequest["scopes"] = ["profile:read", "skills:read"], mfaVerifiedAt: Date | null = null) => {
    const id = randomUUID();
    const user = await observer.query<{ id: string }>("INSERT INTO users (email, normalized_email, status, email_verified_at) VALUES ($1, $1, 'active', $2) RETURNING id", [`${id}@example.test`, now]);
    const userId = user.rows[0]!.id;
    const sessionTokenHash = hashSessionToken(`session-${id}`);
    await auth[0]!.createSession({ userId, tokenHash: sessionTokenHash, expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt });
    const request = requestFor(id, now, scopes);
    assert.equal(await stores[0]!.create(request, now), true);
    const decision = (store = stores[0]!, action: "approve" | "deny" = "approve") => store.decide({ userCodeHash: request.userCodeHash, userId, sessionTokenHash, decision: action, now });
    const poll = (store = stores[0]!, token = tokenFor(randomUUID(), now)) => store.poll({ deviceCodeHash: request.deviceCodeHash, token, now });
    return { userId, sessionTokenHash, request, decision, poll };
  };
  const tokens = async (userId: string) => (await observer.query("SELECT * FROM api_tokens WHERE user_id = $1", [userId])).rows;

  await t.test("two independent stores decide once and consume once with exact scopes", async () => {
    const f = await fixture();
    const decisions = await Promise.all([f.decision(stores[0]), f.decision(stores[1], "deny")]);
    assert.equal(decisions.filter((value) => value === "already_decided").length, 1);
    const winner = decisions.find((value) => value !== "already_decided");
    if (winner === "denied") {
      assert.equal((await f.poll()).status, "denied");
      assert.equal((await tokens(f.userId)).length, 0);
    }
    const approved = await fixture();
    assert.equal(await approved.decision(), "approved");
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => approved.poll(stores[index % 2])));
    assert.equal(results.filter((result) => result.status === "authorized").length, 1);
    assert.equal(results.filter((result) => result.status === "invalid").length, 7);
    const issued = await tokens(approved.userId);
    assert.equal(issued.length, 1);
    assert.deepEqual(issued[0]!.scopes, approved.request.scopes);
    assert.equal((await stores[1]!.find(approved.request.userCodeHash))?.status, "consumed");
    await auth[1]!.revokeApiToken({ userId: approved.userId, tokenId: issued[0]!.id });
    assert.ok((await tokens(approved.userId))[0]!.revoked_at);
  });

  await t.test("failure after token INSERT rolls back token, consumption, polling state and redemption audit", async () => {
    const f = await fixture();
    assert.equal(await f.decision(), "approved");
    await observer.query(`CREATE FUNCTION fail_device_redemption() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'consumed' THEN RAISE EXCEPTION 'synthetic post-insert failure'; END IF; RETURN NEW; END $$`);
    await observer.query("CREATE TRIGGER fail_device_redemption BEFORE UPDATE ON device_login_requests FOR EACH ROW EXECUTE FUNCTION fail_device_redemption()");
    try { await assert.rejects(f.poll()); }
    finally {
      await observer.query("DROP TRIGGER fail_device_redemption ON device_login_requests");
      await observer.query("DROP FUNCTION fail_device_redemption()");
    }
    assert.equal((await tokens(f.userId)).length, 0);
    const request = await stores[1]!.find(f.request.userCodeHash);
    assert.equal(request?.status, "approved");
    assert.equal(request?.lastPolledAt, null);
    assert.equal((await observer.query("SELECT id FROM audit_events WHERE actor_user_id = $1 AND action = 'auth.device.redeemed'", [f.userId])).rowCount, 0);
    assert.equal((await f.poll(stores[1])).status, "authorized");
    assert.equal((await tokens(f.userId)).length, 1);
  });

  for (const change of ["account", "session", "role"] as const) {
    await t.test(`${change} revocation wins while issuance waits on account/session locks`, async () => {
      const f = await fixture();
      assert.equal(await f.decision(), "approved");
      const blocker = await observer.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        if (change === "session") await blocker.query("SELECT id FROM auth_sessions WHERE token_hash = $1 FOR UPDATE", [f.sessionTokenHash]);
        else await blocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.userId]);
        const issuance = f.poll(); pending.push(issuance);
        await waitForLock(observer, names[0]!);
        if (change === "account") await blocker.query("UPDATE users SET status = 'disabled' WHERE id = $1", [f.userId]);
        if (change === "session") await blocker.query("UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE user_id = $1", [f.userId]);
        if (change === "role") await blocker.query("INSERT INTO role_assignments (user_id, role) VALUES ($1, 'admin')", [f.userId]);
        await blocker.query("COMMIT");
        assert.equal((await issuance).status, "denied");
        assert.equal((await tokens(f.userId)).length, 0);
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
    });
  }

  await t.test("canonical MFA factor removal wins the account lock and denies a waiting issuer", async () => {
    const f = await fixture(["skills:submit"], now);
    assert.equal(await f.decision(), "approved");
    await observer.query("INSERT INTO mfa_factors (user_id, type, status, secret_ciphertext) VALUES ($1, 'totp', 'enabled', 'synthetic-unused-ciphertext')", [f.userId]);
    const blocker = await observer.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.userId]);
      const removal = auth[1]!.disableMfaAndRevokeCredentials({ userId: f.userId }); pending.push(removal);
      await waitForLock(observer, names[1]!);
      const issuance = f.poll(); pending.push(issuance);
      await waitForLock(observer, names[0]!);
      await blocker.query("COMMIT");
      assert.equal(await removal, 1);
      assert.equal((await issuance).status, "denied");
      assert.equal((await tokens(f.userId)).length, 0);
      assert.equal((await observer.query("SELECT status FROM mfa_factors WHERE user_id = $1", [f.userId])).rows[0]!.status, "disabled");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
  });

  for (const change of ["account", "session", "role", "mfa"] as const) {
    await t.test(`issuance wins the locks before ${change} revocation and its token is then revoked`, async () => {
      const f = await fixture();
      assert.equal(await f.decision(), "approved");
      if (change === "mfa") await observer.query("INSERT INTO mfa_factors (user_id, type, status, secret_ciphertext) VALUES ($1, 'totp', 'enabled', 'synthetic-unused-ciphertext')", [f.userId]);
      const blocker = await observer.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM device_login_requests WHERE device_code_hash = $1 FOR UPDATE", [f.request.deviceCodeHash]);
        const issuance = f.poll(); pending.push(issuance);
        await waitForLock(observer, names[0]!);
        const revocation = change === "account"
          ? auth[1]!.applyAdminUserStatusChange({ userId: f.userId, status: "disabled", revokeCredentials: true, protectLastActiveOwner: false })
          : change === "session" ? auth[1]!.revokeUserCredentials(f.userId)
            : change === "role" ? auth[1]!.updateUserRolesAndRevokeCredentials({ userId: f.userId, roles: ["admin"] })
              : auth[1]!.disableMfaAndRevokeCredentials({ userId: f.userId });
        pending.push(revocation);
        await waitForLock(observer, names[1]!);
        await blocker.query("COMMIT");
        assert.equal((await issuance).status, "authorized");
        await revocation;
        const issued = await tokens(f.userId);
        assert.equal(issued.length, 1);
        assert.ok(issued[0]!.revoked_at);
        if (change === "mfa") assert.equal((await observer.query("SELECT status FROM mfa_factors WHERE user_id = $1", [f.userId])).rows[0]!.status, "disabled");
      } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
    });
  }

  for (const deadline of ["request", "session", "mfa"] as const) {
    for (const operation of ["approve", "poll"] as const) {
      await t.test(`${operation} rechecks ${deadline} expiry after a request lock wait`, async () => {
        const stamp = new Date(now.getTime() - 15 * 60_000 + 1_000);
        const f = await fixture(deadline === "mfa" ? ["skills:submit"] : ["skills:read"], stamp);
        if (operation === "poll") assert.equal(await f.decision(), "approved");
        if (deadline === "request") await observer.query("UPDATE device_login_requests SET expires_at = $1 WHERE device_code_hash = $2", [new Date(now.getTime() + 1_000), f.request.deviceCodeHash]);
        if (deadline === "session") await observer.query("UPDATE auth_sessions SET expires_at = $1 WHERE token_hash = $2", [new Date(now.getTime() + 1_000), f.sessionTokenHash]);
        const blocker = await observer.connect();
        const pending: Promise<unknown>[] = [];
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM device_login_requests WHERE device_code_hash = $1 FOR UPDATE", [f.request.deviceCodeHash]);
          const result = operation === "poll" ? f.poll() : f.decision(); pending.push(result);
          await waitForLock(observer, names[0]!);
          now = new Date(now.getTime() + 2_000);
          await blocker.query("COMMIT");
          const value = await result;
          assert.equal(typeof value === "string" ? value : value.status,
            operation === "poll" ? deadline === "request" ? "expired" : "denied" : deadline === "request" ? "invalid" : deadline === "session" ? "session_revoked" : "mfa_required");
          assert.equal((await tokens(f.userId)).length, 0);
        } finally { await blocker.query("ROLLBACK"); blocker.release(); await Promise.allSettled(pending); }
      });
    }
  }

  await t.test("shared slowdown is durable, denial needs no MFA and expiry cannot mint", async () => {
    const f = await fixture(["skills:submit"]);
    assert.equal(await f.decision(), "mfa_required");
    assert.equal((await f.poll()).status, "pending");
    assert.deepEqual(await f.poll(stores[1]), { status: "slow_down", interval: 10 });
    assert.equal((await stores[0]!.find(f.request.userCodeHash))?.interval, 10);
    assert.equal(await f.decision(stores[1], "deny"), "denied");
    assert.equal((await f.poll()).status, "denied");
    const expired = await fixture();
    now = new Date(now.getTime() + 301_000);
    assert.equal((await expired.poll()).status, "expired");
    assert.equal((await tokens(f.userId)).length, 0);
  });

  await t.test("admission cap and duplicate identities serialize across independent stores", async () => {
    await observer.query("TRUNCATE device_login_requests");
    const duplicate = requestFor("duplicate", now);
    const created = await Promise.all(stores.map((store) => store.create(duplicate, now)));
    assert.deepEqual(created.sort(), [false, true]);
    await observer.query("TRUNCATE device_login_requests");
    await observer.query(`INSERT INTO device_login_requests (device_code_hash, user_code_hash, scopes, expires_at)
      SELECT 'cap-device-' || n, 'cap-user-' || n, '["skills:read"]'::jsonb, $1 FROM generate_series(1, $2::int) n`, [new Date(now.getTime() + 300_000), DEVICE_LOGIN_MAX_REQUESTS - 1]);
    const admitted = await Promise.all(stores.map((store, index) => store.create(requestFor(`last-${index}`, now), now)));
    assert.deepEqual(admitted.sort(), [false, true]);
    assert.equal(Number((await observer.query("SELECT count(*) FROM device_login_requests")).rows[0]!.count), DEVICE_LOGIN_MAX_REQUESTS);
  });
});

function requestFor(id: string, now: Date, scopes: DeviceLoginRequest["scopes"] = ["skills:read"]): DeviceLoginRequest {
  return { deviceCodeHash: hashSessionToken(`device-${id}`), userCodeHash: hashSessionToken(`user-${id}`), scopes,
    status: "pending", expiresAt: new Date(now.getTime() + 300_000), interval: 5, lastPolledAt: null,
    userId: null, sessionTokenHash: null, mfaVerifiedAt: null };
}
function tokenFor(id: string, now: Date): Parameters<DeviceLoginStore["poll"]>[0]["token"] {
  return { name: "Atomicity fixture", tokenHash: hashSessionToken(`token-${id}`), tokenPrefix: "synthetic", expiresAt: new Date(now.getTime() + 3_600_000) };
}
async function waitForLock(pool: Pool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected a real PostgreSQL lock wait for ${applicationName}.`);
}
