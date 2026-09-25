import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService, type AuthActionNotification, type AuthNotificationSink } from "../src/auth/service.js";
import { AuthNotificationWorker, AUTH_NOTIFICATION_LEASE_MS, decryptAuthNotification, encryptAuthNotification, type QueuedAuthNotificationPurpose } from "../src/auth/notification-outbox.js";
import type { AuthStore } from "../src/auth/types.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

export const OUTBOX_TEST_SECRET = "auth-outbox-test-secret-not-a-real-secret";
export interface OutboxFixture {
  store: AuthStore;
  rows(): Promise<Array<{ payloadCiphertext: string | null; status: string; attempts: number }>>;
  counts(): Promise<{ tokens: number; intents: number }>;
  setDisplayEmail(userId: string, email: string): Promise<void>;
  expireToken(tokenHash: string): Promise<void>;
  failIntentInsertion?(): Promise<() => Promise<void>>;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function sinkWith(send: (input: AuthActionNotification) => Promise<void> | void): AuthNotificationSink {
  return { sendPasswordReset: send, sendEmailVerification: send, sendRegistrationInvitation() {}, sendEmailChangeVerification() {} };
}
async function account(store: AuthStore, purpose: QueuedAuthNotificationPurpose = "password_reset") {
  const created = await store.createUserWithPassword({ email: `${randomUUID()}@example.test`, name: "Queue fixture", passwordHash: "password-hash-must-never-be-serialized" });
  assert.ok(created.user);
  const user = await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: purpose === "password_reset" ? new Date() : null });
  assert.ok(user);
  return user;
}
function serviceFor(store: AuthStore, sink: AuthNotificationSink) { return new AuthService(store, { mfaSecretKey: OUTBOX_TEST_SECRET, notificationSink: sink }); }
function workerFor(store: AuthStore, sink: AuthNotificationSink, now?: () => Date) { return new AuthNotificationWorker(store, sink, { secret: OUTBOX_TEST_SECRET, now }); }

export async function authNotificationOutboxCases(t: TestContext, fixture: () => Promise<OutboxFixture>): Promise<void> {
  for (const purpose of ["email_verification", "password_reset"] as const) {
    for (const reject of [false, true]) {
      await t.test(`${purpose}: HTTP 202 is independent of a held ${reject ? "rejecting" : "successful"} provider`, { timeout: 10_000 }, async () => {
        const f = await fixture();
        const user = await account(f.store, purpose);
        const disabled = await account(f.store, purpose);
        const deleted = await account(f.store, purpose);
        await f.store.updateUserStatus({ userId: disabled.id, status: "disabled" });
        await f.store.updateUserStatus({ userId: deleted.id, status: "deleted" });
        const entered = barrier();
        const delivery = barrier();
        const messages: AuthActionNotification[] = [];
        const sink = sinkWith(async (input) => {
          messages.push(input); entered.release(); await delivery.promise;
          if (reject) throw new Error(`synthetic provider error contains ${input.token}`);
        });
        const service = serviceFor(f.store, sink);
        const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: service });
        const worker = workerFor(f.store, sink);
        const request = async (email: string) => {
          const response = await app.inject({ method: "POST", url: `/v1/auth/${purpose === "password_reset" ? "password-reset" : "email-verification"}/request`, payload: { email } });
          assert.equal(response.statusCode, 202); assert.deepEqual(response.json(), { status: "pending" });
        };
        let running: Promise<void> | undefined;
        try {
          await request(user.email);
          assert.equal(messages.length, 0, "request must only enqueue");
          running = worker.runOnce();
          await entered.promise;
          // The provider is still held. Both eligible and ineligible routes must settle.
          await Promise.all([request(user.email), request("absent@example.test"), request(disabled.email), request(deleted.email)]);
          assert.equal(messages.length, 1);
          assert.equal((await f.rows()).length, 1, "requests coalesce while delivery is leased");
          delivery.release(); await running;
          if (!reject) {
            if (purpose === "password_reset") assert.deepEqual(await service.confirmPasswordReset({ token: messages[0].token, password: "new correct horse battery staple" }), { status: "reset" });
            else assert.deepEqual(await service.confirmEmailVerification({ token: messages[0].token }), { status: "verified" });
            await worker.runOnce();
            assert.equal(messages.length, 1, "coalesced requests must not create another delivery");
          }
          assert.equal(JSON.stringify(await f.rows()).includes(messages[0].token), false);
        } finally { delivery.release(); await running; await worker.stop(); await app.close(); }
      });
    }
  }

  for (const purpose of ["email_verification", "password_reset"] as const) {
    await t.test(`${purpose}: concurrent requests coalesce pending and leased admission without replacing the token`, async () => {
      const f = await fixture(); const user = await account(f.store, purpose);
      const service = serviceFor(f.store, sinkWith(() => {}));
      const request = (index: number) => purpose === "password_reset"
        ? service.requestPasswordReset({ email: user.email, ip: `192.0.2.${index}` })
        : service.requestEmailVerification({ email: user.email, ip: `192.0.2.${index}` });
      const pending = await Promise.all(Array.from({ length: 12 }, (_, index) => request(index)));
      assert.ok(pending.every((result) => result.status === "pending"));
      assert.deepEqual(await f.counts(), { tokens: 1, intents: 1 });
      const now = new Date(); const [claim] = await f.store.claimAuthNotifications({ now, limit: 10, leaseId: randomUUID() }); assert.ok(claim);
      const original = decryptAuthNotification(OUTBOX_TEST_SECRET, claim);
      await Promise.all(Array.from({ length: 12 }, (_, index) => request(index + 12)));
      assert.deepEqual(await f.counts(), { tokens: 1, intents: 1 });
      assert.equal((await f.rows())[0].payloadCiphertext, claim.payloadCiphertext);
      assert.equal(await f.store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome: "delivered" }), true);
      await request(30);
      assert.deepEqual(await f.counts(), { tokens: 2, intents: 2 }, "a delivered intent does not suppress future recovery");
      assert.ok(await f.store.consumeAuthActionToken({ tokenHash: hashSessionToken(original.token), purpose }), "the original valid token is preserved");
    });
    for (const leased of [false, true]) {
      await t.test(`${purpose}: expired ${leased ? "leased" : "pending"} intent cannot suppress fresh recovery`, async () => {
        const f = await fixture(); const user = await account(f.store, purpose); const token = randomUUID();
        const original = await f.store.createAuthActionToken({ userId: user.id, purpose, tokenHash: hashSessionToken(token), sentToNormalizedEmail: user.email,
          expiresAt: new Date(Date.now() + 60_000), notification: encryptAuthNotification(OUTBOX_TEST_SECRET, { email: user.email, token, purpose }) });
        assert.ok(original);
        if (leased) assert.equal((await f.store.claimAuthNotifications({ now: new Date(), limit: 1, leaseId: randomUUID() })).length, 1);
        await f.expireToken(original.tokenHash);
        const service = serviceFor(f.store, sinkWith(() => {}));
        if (purpose === "password_reset") await service.requestPasswordReset({ email: user.email });
        else await service.requestEmailVerification({ email: user.email });
        assert.deepEqual(await f.counts(), { tokens: 2, intents: 2 });
        const rows = await f.rows();
        assert.equal(rows.filter((row) => row.status === "pending").length, 1);
        assert.equal(rows.filter((row) => row.status === "expired" && row.payloadCiphertext === null).length, 1);
      });
    }
  }

  for (const mode of ["open", "request"] as const) {
    await t.test(`${mode} registration queues verification and returns while a provider remains held`, { timeout: 15_000 }, async () => {
      const f = await fixture(); await f.store.setRegistrationMode(mode);
      const entered = barrier(); const delivery = barrier(); const messages: AuthActionNotification[] = [];
      const sink = sinkWith(async (message) => { messages.push(message); entered.release(); await delivery.promise; });
      const service = serviceFor(f.store, sink); const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: service });
      const worker = workerFor(f.store, sink); const email = `${randomUUID()}@example.test`;
      const register = async (value: string) => {
        const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: value, password: "correct horse battery staple" } });
        assert.equal(response.statusCode, 202); assert.deepEqual(response.json(), { status: "pending" });
      };
      let running: Promise<void> | undefined;
      try {
        await register(email); assert.equal(messages.length, 0);
        running = worker.runOnce(); await entered.promise;
        await Promise.all([register(email), register(`${randomUUID()}@example.test`)]);
        assert.equal(messages.length, 1); assert.deepEqual(await f.counts(), { tokens: 2, intents: 2 });
        delivery.release(); await running;
        assert.deepEqual(await service.confirmEmailVerification({ token: messages[0].token }), { status: "verified" });
        const user = await f.store.findUserByEmailWithPassword(email); assert.ok(user?.emailVerifiedAt);
        assert.equal(user.status, "pending", "verification must not change registration approval semantics");
      } finally { delivery.release(); await running; await worker.stop(); await app.close(); }
    });
  }

  await t.test("mixed-case email returned by lookup uses normalized R1 snapshots and delivery recipient", async () => {
    const f = await fixture(); const user = await account(f.store);
    await f.setDisplayEmail(user.id, user.email.toUpperCase());
    const messages: AuthActionNotification[] = [];
    const sink = sinkWith((message) => { messages.push(message); });
    sink.sendEmailChangeVerification = (message) => { messages.push(message); };
    const service = serviceFor(f.store, sink);
    await service.requestPasswordReset({ email: user.email });
    await workerFor(f.store, sink).runOnce();
    assert.equal(messages.length, 1); assert.equal(messages[0].email, user.email);
    assert.deepEqual(await service.confirmPasswordReset({ token: messages[0].token, password: "reset correct horse battery staple" }), { status: "reset" });
    const current = await f.store.findUserByEmailWithPassword(user.email); assert.ok(current);
    const actor = { ...current, emailVerified: true, mfaVerified: false };
    assert.deepEqual(await service.changePassword(actor, { currentPassword: "reset correct horse battery staple", password: "changed correct horse battery staple" }), { status: "changed" });
    await service.requestEmailChange(actor, { password: "changed correct horse battery staple", email: `next-${user.email}` });
    assert.equal(messages.length, 2);
    assert.deepEqual(await service.confirmEmailChange({ token: messages[1].token }), { status: "changed" });
  });

  await t.test("two workers claim disjoint bounded batches and a restarted worker fences an expired lease", async () => {
    const f = await fixture(); const user = await account(f.store);
    const sink = sinkWith(() => {}); const service = serviceFor(f.store, sink);
    await service.requestPasswordReset({ email: user.email });
    const now = new Date();
    const batches = await Promise.all([1, 2].map(() => f.store.claimAuthNotifications({ now, limit: 1000, leaseId: randomUUID() })));
    assert.deepEqual(batches.map((v) => v.length).sort(), [0, 1]);
    const original = batches.flat()[0]; assert.ok(original);
    const recoveredAt = new Date(now.getTime() + AUTH_NOTIFICATION_LEASE_MS + 1);
    const [recovered] = await f.store.claimAuthNotifications({ now: recoveredAt, limit: 1, leaseId: randomUUID() });
    assert.ok(recovered); assert.equal(recovered.id, original.id); assert.equal(recovered.tokenHash, original.tokenHash);
    assert.equal(recovered.payloadCiphertext, original.payloadCiphertext); assert.equal(recovered.attempts, 2);
    assert.equal(await f.store.authNotificationRecipient(original, recoveredAt), null);
    assert.equal(await f.store.finishAuthNotification({ id: original.id, leaseId: original.leaseId, now: recoveredAt, outcome: "delivered" }), false);
    assert.ok(await f.store.authNotificationRecipient(recovered, recoveredAt));
    assert.equal(await f.store.finishAuthNotification({ id: recovered.id, leaseId: recovered.leaseId, now: recoveredAt, outcome: "delivered" }), true);
    assert.equal((await f.rows())[0].payloadCiphertext, null);
  });

  await t.test("claims cap each batch at ten and terminal cleanup is bounded", async () => {
    const f = await fixture(); const sink = sinkWith(() => {});
    const service = serviceFor(f.store, sink);
    for (let i = 0; i < 12; i += 1) {
      const user = await account(f.store);
      await service.requestPasswordReset({ email: user.email });
    }
    const now = new Date();
    const batches = await Promise.all([1, 2].map(() => f.store.claimAuthNotifications({ now, limit: 1000, leaseId: randomUUID() })));
    assert.deepEqual(batches.map((batch) => batch.length).sort((a, b) => a - b), [2, 10]);
    assert.equal(new Set(batches.flat().map((claim) => claim.id)).size, 12);
    for (const claim of batches.flat()) await f.store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome: "delivered" });
    const later = new Date(now.getTime() + 25 * 60 * 60_000);
    await f.store.claimAuthNotifications({ now: later, limit: 1000, leaseId: randomUUID() });
    assert.equal((await f.rows()).length, 2);
    await f.store.claimAuthNotifications({ now: later, limit: 1000, leaseId: randomUUID() });
    assert.equal((await f.rows()).length, 0);
  });

  await t.test("provider timeout aborts delivery and records a sanitized retry", { timeout: 5000 }, async () => {
    const f = await fixture(); const user = await account(f.store); let signal: AbortSignal | undefined;
    const sink = sinkWith((message) => { signal = message.signal; return new Promise(() => {}); });
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    const worker = new AuthNotificationWorker(f.store, sink, { secret: OUTBOX_TEST_SECRET, deliveryTimeoutMs: 5 });
    await worker.runOnce();
    assert.equal(signal?.aborted, true);
    assert.equal((await f.rows())[0].status, "pending");
    await worker.stop();
  });

  await t.test("retry count is bounded, retries preserve the token, and terminal payloads are scrubbed", async () => {
    const f = await fixture(); const user = await account(f.store);
    let now = new Date(); const tokens: string[] = []; const keys: Array<string | undefined> = [];
    const sink = sinkWith((message) => { tokens.push(message.token); keys.push(message.idempotencyKey); throw new Error(`failed ${message.token}`); });
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    now = new Date(Date.now() + 100);
    const worker = workerFor(f.store, sink, () => now);
    for (let attempt = 0; attempt < 7; attempt += 1) { await worker.runOnce(); now = new Date(now.getTime() + 16 * 60_000); }
    // TTL is one hour, so the fifth attempt is expired rather than sent.
    assert.equal(tokens.length, 4); assert.equal(new Set(tokens).size, 1);
    assert.equal(new Set(keys).size, 1); assert.match(keys[0] ?? "", /^auth-notification\/[a-f0-9-]{36}$/);
    const [row] = await f.rows(); assert.equal(row.status, "expired"); assert.equal(row.payloadCiphertext, null);
    await worker.stop();
  });

  await t.test("five provider failures exhaust retries before token expiry", async () => {
    const f = await fixture(); const user = await account(f.store); let now = new Date(); let sends = 0;
    const sink = sinkWith(() => { sends += 1; throw new Error("rejected"); });
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    now = new Date(Date.now() + 100); const worker = workerFor(f.store, sink, () => now);
    for (let i = 0; i < 6; i += 1) { await worker.runOnce(); now = new Date(now.getTime() + 5 * 60_000); }
    assert.equal(sends, 5); assert.deepEqual((await f.rows()).map(({ status, payloadCiphertext, attempts }) => ({ status, payloadCiphertext, attempts })), [{ status: "failed", payloadCiphertext: null, attempts: 5 }]);
    await worker.stop();
  });

  for (const mutation of ["password", "email", "disabled", "deleted", "used"] as const) {
    await t.test(`${mutation} before dispatch drops the queued intent`, async () => {
      const f = await fixture(); const user = await account(f.store); let sends = 0;
      const sink = sinkWith(() => { sends += 1; });
      await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
      if (mutation === "password") await f.store.changePasswordAndRevokeCredentials({ userId: user.id, passwordHash: "changed-hash" });
      else if (mutation === "email") await f.store.updateUserEmail({ userId: user.id, email: `changed-${user.email}`, emailVerifiedAt: new Date() });
      else if (mutation === "used") {
        const now = new Date(); const [claim] = await f.store.claimAuthNotifications({ now, limit: 1, leaseId: randomUUID() }); assert.ok(claim);
        await f.store.consumeAuthActionToken({ tokenHash: claim.tokenHash, purpose: claim.purpose });
        await f.store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome: "retry", availableAt: now });
      } else await f.store.updateUserStatus({ userId: user.id, status: mutation });
      await workerFor(f.store, sink).runOnce();
      assert.equal(sends, 0); assert.equal((await f.rows())[0].payloadCiphertext, null);
    });
  }

  await t.test("R1 account change during provider dispatch leaves the delivered link unusable", async () => {
    const f = await fixture(); const user = await account(f.store); const entered = barrier(); const delivery = barrier();
    let token = ""; const sink = sinkWith(async (message) => { token = message.token; entered.release(); await delivery.promise; });
    const service = serviceFor(f.store, sink); await service.requestPasswordReset({ email: user.email });
    const worker = workerFor(f.store, sink); const running = worker.runOnce();
    try {
      await entered.promise;
      await f.store.changePasswordAndRevokeCredentials({ userId: user.id, passwordHash: "changed-after-dispatch" });
      delivery.release(); await running;
      assert.equal(await f.store.completePasswordReset({ tokenHash: hashSessionToken(token), passwordHash: "must-not-replace-change" }), false);
      assert.equal((await f.rows())[0].payloadCiphertext, null);
    } finally { delivery.release(); await running; await worker.stop(); }
  });

  await t.test("encrypted payload has only token and recipient and rejects another job or key", async () => {
    const f = await fixture(); const user = await account(f.store); const sink = sinkWith(() => {});
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    const [claim] = await f.store.claimAuthNotifications({ now: new Date(), limit: 1, leaseId: randomUUID() }); assert.ok(claim);
    const payload = decryptAuthNotification(OUTBOX_TEST_SECRET, claim);
    assert.deepEqual(Object.keys(payload).sort(), ["email", "token"]);
    const stored = JSON.stringify(await f.rows());
    for (const secret of [payload.token, user.email, "passwordHash", "password-hash-must-never-be-serialized"]) assert.equal(stored.includes(secret), false);
    assert.throws(() => decryptAuthNotification("wrong-key", claim));
    assert.throws(() => decryptAuthNotification(OUTBOX_TEST_SECRET, { ...claim, id: randomUUID() }));
    assert.throws(() => decryptAuthNotification(OUTBOX_TEST_SECRET, { ...claim, purpose: "email_verification" }));
    const [version, iv, tag, ciphertext] = claim.payloadCiphertext.split(".");
    for (const length of [4, 8, 12, 15]) {
      const shortened = Buffer.from(tag, "base64url").subarray(0, length).toString("base64url");
      assert.throws(() => decryptAuthNotification(OUTBOX_TEST_SECRET, { ...claim, payloadCiphertext: [version, iv, shortened, ciphertext].join(".") }), /Invalid auth notification payload/);
    }
    for (const malformedIv of [iv + "=", Buffer.alloc(8).toString("base64url"), iv + "!"]) {
      assert.throws(() => decryptAuthNotification(OUTBOX_TEST_SECRET, { ...claim, payloadCiphertext: [version, malformedIv, tag, ciphertext].join(".") }), /Invalid auth notification payload/);
    }
  });

  await t.test("token and intent insertion fail atomically", async () => {
    const f = await fixture(); const user = await account(f.store);
    const intent = encryptAuthNotification(OUTBOX_TEST_SECRET, { email: user.email, token: "first-token", purpose: "password_reset" });
    const input = { userId: user.id, purpose: "password_reset" as const, tokenHash: hashSessionToken("first-token"), sentToNormalizedEmail: user.email, expiresAt: new Date(Date.now() + 60_000), notification: intent };
    assert.ok(await f.store.createAuthActionToken(input));
    const now = new Date(); const [claim] = await f.store.claimAuthNotifications({ now, limit: 1, leaseId: randomUUID() }); assert.ok(claim);
    await f.store.finishAuthNotification({ id: claim.id, leaseId: claim.leaseId, now, outcome: "delivered" });
    const before = await f.counts();
    await assert.rejects(f.store.createAuthActionToken({ ...input, tokenHash: hashSessionToken("rollback-token") }));
    assert.deepEqual(await f.counts(), before);
    assert.equal(await f.store.consumeAuthActionToken({ tokenHash: hashSessionToken("rollback-token"), purpose: "password_reset" }), null);
    if (f.failIntentInsertion) {
      const clear = await f.failIntentInsertion();
      try { await assert.rejects(f.store.createAuthActionToken({ ...input, tokenHash: hashSessionToken("trigger-token"), notification: { ...intent, id: randomUUID() } })); }
      finally { await clear(); }
      assert.deepEqual(await f.counts(), before);
    }
  });

  await t.test("stale account observation cannot issue a queued reset after R1 password change", async () => {
    const f = await fixture(); const user = await account(f.store);
    await f.store.changePasswordAndRevokeCredentials({ userId: user.id, passwordHash: "new-hash" });
    const token = "stale-request";
    assert.equal(await f.store.createAuthActionToken({ userId: user.id, purpose: "password_reset", tokenHash: hashSessionToken(token), sentToNormalizedEmail: user.email, expiresAt: new Date(Date.now() + 60_000), expectedAccount: { email: user.email, passwordHash: "password-hash-must-never-be-serialized" }, notification: encryptAuthNotification(OUTBOX_TEST_SECRET, { email: user.email, token, purpose: "password_reset" }) }), null);
    assert.deepEqual(await f.counts(), { tokens: 0, intents: 0 });
  });

  await t.test("stop blocks a claimed delivery still waiting for recipient validation", { timeout: 5000 }, async () => {
    const f = await fixture(); const user = await account(f.store); let sends = 0; let finishes = 0;
    const sink = sinkWith(() => { sends += 1; });
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    const entered = barrier(); const validation = barrier();
    const recipient = f.store.authNotificationRecipient.bind(f.store);
    const finish = f.store.finishAuthNotification.bind(f.store);
    f.store.authNotificationRecipient = async (claim, now) => {
      const result = await recipient(claim, now); entered.release(); await validation.promise; return result;
    };
    f.store.finishAuthNotification = async (input) => { finishes += 1; return finish(input); };
    const worker = workerFor(f.store, sink); const running = worker.runOnce();
    try {
      await entered.promise; const stopping = worker.stop(1000); validation.release();
      await stopping; await running;
      assert.equal(sends, 0); assert.equal(finishes, 0);
    } finally { validation.release(); await worker.stop(); }
  });

  for (const stopFirst of [false, true]) {
    await t.test(`completed send is recorded when ${stopFirst ? "stop precedes success" : "success precedes stop"}`, { timeout: 5000 }, async () => {
      const f = await fixture(); const user = await account(f.store); const entered = barrier(); const delivery = barrier();
      const sink = sinkWith(async () => { entered.release(); await delivery.promise; });
      await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
      const worker = workerFor(f.store, sink); const running = worker.runOnce();
      let finishCalls = 0; const finish = f.store.finishAuthNotification.bind(f.store);
      f.store.finishAuthNotification = async (input) => { finishCalls += 1; return finish(input); };
      try {
        await entered.promise;
        if (!stopFirst) delivery.release();
        const stopping = worker.stop(1000);
        if (stopFirst) delivery.release();
        await stopping; await running;
        assert.equal(finishCalls, 1);
        assert.equal((await f.rows())[0].status, "delivered"); assert.equal((await f.rows())[0].payloadCiphertext, null);
        await worker.runOnce(); await worker.stop();
        assert.equal(finishCalls, 1, "no completion calls after stop resolves");
      } finally { delivery.release(); await worker.stop(); }
    });
  }

  await t.test("nonoverlapping loop stops with a held provider and makes no later store calls", { timeout: 5000 }, async () => {
    const f = await fixture(); const user = await account(f.store); const entered = barrier(); const delivery = barrier(); let sends = 0;
    const sink = sinkWith(async (message) => { sends += 1; entered.release(); await delivery.promise; assert.equal(message.signal?.aborted, true); });
    await serviceFor(f.store, sink).requestPasswordReset({ email: user.email });
    const worker = workerFor(f.store, sink); const running = worker.runOnce();
    let finishCalls = 0; const finish = f.store.finishAuthNotification.bind(f.store);
    f.store.finishAuthNotification = async (input) => { finishCalls += 1; return finish(input); };
    assert.equal(worker.runOnce(), running);
    try {
      await entered.promise; await worker.stop(50); await running;
      const before = await f.rows();
      delivery.release(); await Promise.resolve(); await worker.runOnce();
      assert.equal(sends, 1); assert.equal(finishCalls, 0, "deadline cancellation must not start a completion store call");
      assert.deepEqual(await f.rows(), before); assert.equal(before[0].status, "leased");
      const recovery = await f.store.claimAuthNotifications({ now: new Date(Date.now() + AUTH_NOTIFICATION_LEASE_MS + 1), limit: 1, leaseId: randomUUID() });
      assert.equal(recovery.length, 1);
    } finally { delivery.release(); await worker.stop(); }
  });
}
