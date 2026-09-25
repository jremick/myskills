import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { hashPassword, hashSessionToken, verifyPassword } from "@myskills-app/auth";
import { AuthNotificationWorker } from "../src/auth/notification-outbox.js";
import { AuthService, type AuthActionNotification } from "../src/auth/service.js";
import type { AuthStore, AuthResponseUser, AuthActionTokenPurpose } from "../src/auth/types.js";

const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "new correct horse battery staple";
const INVALID_RESET = { code: "INVALID_RESET_TOKEN", statusCode: 401 };
const INVALID_EMAIL = { code: "INVALID_VERIFICATION_TOKEN", statusCode: 401 };

export async function authActionLifecycleCases(t: TestContext, store: AuthStore): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  const nextPasswordHash = await hashPassword(NEXT_PASSWORD);
  let sequence = 0;
  async function fixture() {
    const email = `lifecycle-${++sequence}@example.test`;
    const created = await store.createUserWithPassword({ email, name: "Lifecycle", passwordHash });
    assert.ok(created.user);
    const user = await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
    assert.ok(user);
    const actor: AuthResponseUser = { ...user, emailVerified: true, mfaVerified: false };
    const resets: AuthActionNotification[] = [];
    const changes: AuthActionNotification[] = [];
    const failures = { reset: false, email: false };
    const sink = {
      sendEmailVerification() {},
      sendRegistrationInvitation() {},
      sendPasswordReset(value: AuthActionNotification) {
        if (failures.reset) throw new Error("Injected delivery failure");
        resets.push(value);
      },
      sendEmailChangeVerification(value: AuthActionNotification) {
        if (failures.email) throw new Error("Injected delivery failure");
        changes.push(value);
      },
    };
    const service = new AuthService(store, { notificationSink: sink });
    const worker = new AuthNotificationWorker(store, sink, { secret: "dev-only-myskills-app-auth-secret-change-before-production" });
    const expectedAccount = { email, passwordHash };
    async function createAction(purpose: AuthActionTokenPurpose, destination = email) {
      const tokenHash = hashSessionToken(`fixture-${++sequence}-${purpose}`);
      const token = await store.createAuthActionToken({
        userId: user.id, purpose, tokenHash, sentToNormalizedEmail: destination,
        expiresAt: new Date(Date.now() + 60_000), expectedAccount,
      });
      assert.ok(token);
      return tokenHash;
    }
    return { user, actor, service, worker, resets, changes, failures, expectedAccount, createAction };
  }

  await t.test("newest email-change request supersedes older links before and after confirmation", async () => {
    const f = await fixture();
    await f.service.requestEmailChange(f.actor, { email: `b-${f.user.email}`, password: PASSWORD });
    await f.service.requestEmailChange(f.actor, { email: `c-${f.user.email}`, password: PASSWORD });
    await assert.rejects(f.service.confirmEmailChange({ token: f.changes[0].token }), INVALID_EMAIL);
    assert.deepEqual(await f.service.confirmEmailChange({ token: f.changes[1].token }), { status: "changed" });
    for (const notification of f.changes) {
      await assert.rejects(f.service.confirmEmailChange({ token: notification.token }), INVALID_EMAIL);
    }
    assert.equal((await store.findUserById(f.user.id))?.email, `c-${f.user.email}`);
    assert.equal((await f.service.login({ email: `c-${f.user.email}`, password: PASSWORD })).mfaRequired, false);
  });

  await t.test("email completion invalidates old resets and fresh reset links still work", async () => {
    const f = await fixture();
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    await f.service.requestEmailChange(f.actor, { email: `new-${f.user.email}`, password: PASSWORD });
    await f.service.confirmEmailChange({ token: f.changes[0].token });
    await assert.rejects(f.service.confirmPasswordReset({ token: f.resets[0].token, password: NEXT_PASSWORD }), INVALID_RESET);
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    assert.equal(f.resets.length, 1);
    await f.service.requestPasswordReset({ email: `new-${f.user.email}` });
    await f.worker.runOnce();
    assert.deepEqual(await f.service.confirmPasswordReset({ token: f.resets[1].token, password: NEXT_PASSWORD }), { status: "reset" });
    await assert.rejects(f.service.confirmPasswordReset({ token: f.resets[1].token, password: PASSWORD }), INVALID_RESET);
    assert.equal((await f.service.login({ email: `new-${f.user.email}`, password: NEXT_PASSWORD })).mfaRequired, false);
  });

  await t.test("authenticated password change invalidates pending reset and email-change links", async () => {
    const f = await fixture();
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    await f.service.requestEmailChange(f.actor, { email: `pending-${f.user.email}`, password: PASSWORD });
    assert.deepEqual(await f.service.changePassword(f.actor, { currentPassword: PASSWORD, password: NEXT_PASSWORD }), { status: "changed" });
    await assert.rejects(f.service.confirmPasswordReset({ token: f.resets[0].token, password: PASSWORD }), INVALID_RESET);
    await assert.rejects(f.service.confirmEmailChange({ token: f.changes[0].token }), INVALID_EMAIL);
    assert.equal((await store.findUserById(f.user.id))?.email, f.user.email);
    assert.equal((await f.service.login({ email: f.user.email, password: NEXT_PASSWORD })).mfaRequired, false);
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    assert.deepEqual(await f.service.confirmPasswordReset({ token: f.resets[1].token, password: PASSWORD }), { status: "reset" });
  });

  await t.test("public reset requests preserve existing links until a successful reset consumes siblings", async () => {
    const f = await fixture();
    await f.service.requestEmailChange(f.actor, { email: `pending-${f.user.email}`, password: PASSWORD });
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    await f.service.requestPasswordReset({ email: f.user.email });
    await f.worker.runOnce();
    await assert.rejects(f.service.confirmPasswordReset({ token: "invalid-reset-token".repeat(3), password: NEXT_PASSWORD }), INVALID_RESET);
    assert.deepEqual(await f.service.confirmPasswordReset({ token: f.resets[0].token, password: NEXT_PASSWORD }), { status: "reset" });
    for (const reset of f.resets) {
      await assert.rejects(f.service.confirmPasswordReset({ token: reset.token, password: PASSWORD }), INVALID_RESET);
    }
    await assert.rejects(f.service.confirmEmailChange({ token: f.changes[0].token }), INVALID_EMAIL);

    const other = await fixture();
    await other.service.requestEmailChange(other.actor, { email: `valid-${other.user.email}`, password: PASSWORD });
    await other.service.requestPasswordReset({ email: other.user.email });
    await other.worker.runOnce();
    assert.deepEqual(await other.service.confirmEmailChange({ token: other.changes[0].token }), { status: "changed" });
  });

  await t.test("reset recipients must match the current email even without prior token invalidation", async () => {
    const f = await fixture();
    const tokenHash = await f.createAction("password_reset");
    await store.updateUserEmail({ userId: f.user.id, email: `external-${f.user.email}`, emailVerifiedAt: new Date() });
    assert.equal(await store.completePasswordReset({ tokenHash, passwordHash: nextPasswordHash }), false);
    assert.equal((await store.findUserByEmailWithPassword(`external-${f.user.email}`))?.passwordHash, passwordHash);
    assert.equal(await store.createAuthActionToken({
      userId: f.user.id, purpose: "password_reset", tokenHash: `stale-${tokenHash}`,
      sentToNormalizedEmail: f.user.email, expiresAt: new Date(Date.now() + 60_000),
    }), null);
  });

  await t.test("stale account snapshots cannot issue actions or overwrite a completed security change", async () => {
    for (const change of ["password", "email"] as const) {
      const f = await fixture();
      if (change === "password") {
        assert.equal(await store.changePasswordAndRevokeCredentials({ userId: f.user.id, passwordHash: nextPasswordHash }), true);
      } else {
        const tokenHash = await f.createAction("email_change", `changed-${f.user.email}`);
        assert.equal((await store.completeEmailChangeAndRevokeCredentials({ tokenHash }))?.outcome, "changed");
      }
      for (const purpose of ["password_reset", "email_change"] as const) {
        assert.equal(await store.createAuthActionToken({
          userId: f.user.id, purpose, tokenHash: `stale-${change}-${purpose}`,
          sentToNormalizedEmail: purpose === "password_reset" ? f.user.email : `stale-${f.user.email}`,
          expiresAt: new Date(Date.now() + 60_000), expectedAccount: f.expectedAccount,
        }), null);
      }
      assert.equal(await store.changePasswordAndRevokeCredentials({
        userId: f.user.id, passwordHash: "must-not-be-written", expectedAccount: f.expectedAccount,
      }), false);
      const current = await store.findUserById(f.user.id);
      assert.ok(current);
      assert.equal((await store.findUserByEmailWithPassword(current.email))?.passwordHash,
        change === "password" ? nextPasswordHash : passwordHash);
    }
  });

  await t.test("disabled and deleted accounts cannot create or complete security actions", async () => {
    for (const status of ["disabled", "deleted"] as const) {
      const f = await fixture();
      const resetHash = await f.createAction("password_reset");
      const emailHash = await f.createAction("email_change", `unusable-${f.user.email}`);
      await store.updateUserStatus({ userId: f.user.id, status });
      assert.equal(await store.completePasswordReset({ tokenHash: resetHash, passwordHash: nextPasswordHash }), false);
      assert.equal(await store.completeEmailChangeAndRevokeCredentials({ tokenHash: emailHash }), null);
      assert.equal(await store.changePasswordAndRevokeCredentials({ userId: f.user.id, passwordHash: nextPasswordHash }), false);
      for (const purpose of ["password_reset", "email_change"] as const) {
        assert.equal(await store.createAuthActionToken({
          userId: f.user.id, purpose, tokenHash: `${status}-${purpose}`,
          sentToNormalizedEmail: f.user.email, expiresAt: new Date(Date.now() + 60_000),
        }), null);
      }
    }
  });

  await t.test("concurrent reset and email completion allow only one security change", async () => {
    const f = await fixture();
    const resetHash = await f.createAction("password_reset");
    const emailHash = await f.createAction("email_change", `race-${f.user.email}`);
    const [reset, email] = await Promise.all([
      store.completePasswordReset({ tokenHash: resetHash, passwordHash: nextPasswordHash }),
      store.completeEmailChangeAndRevokeCredentials({ tokenHash: emailHash }),
    ]);
    assert.equal(Number(reset) + Number(email?.outcome === "changed"), 1);
    const current = await store.findUserById(f.user.id);
    assert.ok(current);
    assert.equal(current.email, reset ? f.user.email : `race-${f.user.email}`);
    assert.equal((await store.findUserByEmailWithPassword(current.email))?.passwordHash, reset ? nextPasswordHash : passwordHash);
    assert.equal(await store.completePasswordReset({ tokenHash: resetHash, passwordHash }), false);
    assert.equal(await store.completeEmailChangeAndRevokeCredentials({ tokenHash: emailHash }), null);
  });

  await t.test("concurrent issuance cannot leave a stale reset after password change", async () => {
    const f = await fixture();
    const tokenHash = `concurrent-${f.user.id}`;
    const [, changed] = await Promise.all([
      store.createAuthActionToken({
        userId: f.user.id, purpose: "password_reset", tokenHash,
        sentToNormalizedEmail: f.user.email, expiresAt: new Date(Date.now() + 60_000),
        expectedAccount: f.expectedAccount,
      }),
      store.changePasswordAndRevokeCredentials({ userId: f.user.id, passwordHash: nextPasswordHash }),
    ]);
    assert.equal(changed, true);
    assert.equal(await store.completePasswordReset({ tokenHash, passwordHash }), false);
  });

  await t.test("concurrent email-change requests leave exactly one usable link", async () => {
    const f = await fixture();
    const tokenHashes = [`parallel-first-${f.user.id}`, `parallel-second-${f.user.id}`];
    const issued = await Promise.all(tokenHashes.map((tokenHash, index) => store.createAuthActionToken({
      userId: f.user.id, purpose: "email_change", tokenHash,
      sentToNormalizedEmail: `parallel-${index}-${f.user.email}`, expiresAt: new Date(Date.now() + 60_000),
      expectedAccount: f.expectedAccount,
    })));
    assert.ok(issued.every(Boolean));
    // Consume without a security change so sibling invalidation on completion
    // cannot hide two requests that accidentally remained usable after issuance.
    const consumed = await Promise.all(tokenHashes.map((tokenHash) => store.consumeAuthActionToken({ tokenHash, purpose: "email_change" })));
    assert.equal(consumed.filter(Boolean).length, 1);
  });

  await t.test("delivery failures do not restore superseded links or invalidate existing resets", async () => {
    const f = await fixture();
    await f.service.requestEmailChange(f.actor, { email: `first-${f.user.email}`, password: PASSWORD });
    f.failures.email = true;
    assert.deepEqual(await f.service.requestEmailChange(f.actor, { email: `failed-${f.user.email}`, password: PASSWORD }), { status: "pending" });
    await assert.rejects(f.service.confirmEmailChange({ token: f.changes[0].token }), INVALID_EMAIL);
    assert.equal((await store.findUserById(f.user.id))?.email, f.user.email);
    f.failures.email = false;
    await f.service.requestEmailChange(f.actor, { email: `retry-${f.user.email}`, password: PASSWORD });
    assert.deepEqual(await f.service.confirmEmailChange({ token: f.changes[1].token }), { status: "changed" });

    const other = await fixture();
    await other.service.requestPasswordReset({ email: other.user.email });
    await other.worker.runOnce();
    other.failures.reset = true;
    assert.deepEqual(await other.service.requestPasswordReset({ email: other.user.email }), { status: "pending" });
    await other.worker.runOnce();
    assert.deepEqual(await other.service.confirmPasswordReset({ token: other.resets[0].token, password: NEXT_PASSWORD }), { status: "reset" });
    assert.equal(await verifyPassword((await store.findUserByEmailWithPassword(other.user.email))?.passwordHash ?? "", NEXT_PASSWORD), true);
  });
}

export async function authActionRollbackCases(
  t: TestContext,
  store: AuthStore,
  injectFailure: () => void | Promise<void>,
  clearFailure: () => void | Promise<void>,
): Promise<void> {
  for (const change of ["password", "reset", "email"] as const) {
    await t.test(`${change} failure restores all pending actions and credentials`, async () => {
      const created = await store.createUserWithPassword({
        email: `rollback-${change}@example.test`, name: "Rollback", passwordHash: "original-hash",
      });
      assert.ok(created.user);
      const user = await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
      assert.ok(user);
      const tokens = [
        { purpose: "password_reset" as const, tokenHash: `${change}-reset-one`, email: user.email },
        { purpose: "password_reset" as const, tokenHash: `${change}-reset-two`, email: user.email },
        { purpose: "email_change" as const, tokenHash: `${change}-email`, email: `next-${user.email}` },
      ];
      for (const token of tokens) {
        assert.ok(await store.createAuthActionToken({
          userId: user.id, purpose: token.purpose, tokenHash: token.tokenHash,
          sentToNormalizedEmail: token.email, expiresAt: new Date(Date.now() + 60_000),
        }));
      }
      await store.createSession({ userId: user.id, tokenHash: `${change}-session`, expiresAt: new Date(Date.now() + 60_000) });
      await injectFailure();
      try {
        const mutation = change === "password"
          ? store.changePasswordAndRevokeCredentials({ userId: user.id, passwordHash: "new-hash" })
          : change === "reset"
            ? store.completePasswordReset({ tokenHash: tokens[0].tokenHash, passwordHash: "new-hash" })
            : store.completeEmailChangeAndRevokeCredentials({ tokenHash: tokens[2].tokenHash });
        await assert.rejects(mutation);
      } finally {
        await clearFailure();
      }
      assert.deepEqual(await store.findUserById(user.id), user);
      assert.equal((await store.findUserByEmailWithPassword(user.email))?.passwordHash, "original-hash");
      assert.ok(await store.findUserBySessionTokenHash(`${change}-session`));
      // Read each pending action through its one-use contract: none was consumed
      // by the rolled-back security change, including sibling reset actions.
      for (const token of tokens) {
        assert.ok(await store.consumeAuthActionToken({ tokenHash: token.tokenHash, purpose: token.purpose }));
      }
    });
  }
}
