import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAuthStore } from "../src/auth/memory-auth-store.js";
import { AuthService } from "../src/auth/service.js";
import type { AuthResponseUser, CreateAuditEventInput } from "../src/auth/types.js";

test("registration rejects oversized new credentials with the byte-limit message before creating an account", async () => {
  const store = new MemoryAuthStore("open");
  const service = new AuthService(store);
  for (const password of ["a".repeat(73), "é".repeat(37)]) {
    await assert.rejects(service.register({ email: "length@example.test", password }), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "INVALID_PASSWORD");
      assert.match(error.message, /at most 72 UTF-8 bytes/);
      return true;
    });
  }
  assert.deepEqual(await store.listUsers(), []);
});

for (const mutation of ["status", "roles", "token", "registration", "provider"] as const) {
  test(`admin ${mutation} mutation is unchanged when the audit cannot be written`, async () => {
    const store = new FailingAuditStore();
    const service = new AuthService(store);
    const owner = store.addUser({ id: "owner", email: "owner@example.test", roles: ["owner"], status: "active", emailVerifiedAt: new Date() });
    const actor: AuthResponseUser = { ...owner, emailVerified: true, mfaVerified: true };
    const target = store.addUser({ id: "target", email: "target@example.test", roles: ["user"], status: "active", emailVerifiedAt: new Date() });
    await store.createSession({ userId: target.id, tokenHash: "session-test-hash", expiresAt: new Date(Date.now() + 60_000) });
    const token = await store.createApiToken({ userId: target.id, name: "fixture", tokenHash: "api-test-hash", tokenPrefix: "fixture", scopes: ["profile:read"], expiresAt: new Date(Date.now() + 60_000) });
    const provider = { key: "fixture", type: "oidc" as const, displayName: "Fixture", enabled: false, roleMappings: [] };
    const execute = () => {
      switch (mutation) {
        case "status": return service.performAdminUserAction(actor, { userId: target.id, action: "disable", reason: "fixture" });
        case "roles": return service.updateAdminUserRoles(actor, { userId: target.id, roles: ["author"], reason: "fixture" });
        case "token": return service.revokeAdminApiToken(actor, token.id);
        case "registration": return service.updateRegistrationSettings(actor, { mode: "open" });
        case "provider": return service.upsertAdminProviderConfig(actor, provider);
      }
    };

    store.failAudit = true;
    await assert.rejects(execute(), /Injected audit failure/);
    assert.deepEqual(await store.findUserById(target.id), target);
    assert.ok(await store.findUserBySessionTokenHash("session-test-hash"));
    assert.ok(await store.findUserByApiTokenHash("api-test-hash"));
    assert.equal(await store.getRegistrationMode(), "closed");
    assert.deepEqual(await store.listProviderConfigs(), []);
    assert.deepEqual(await store.listAuditEvents({ limit: 100 }), []);

    store.failAudit = false;
    await execute();
    assert.equal((await store.listAuditEvents({ limit: 100 })).length, 1);
    if (mutation === "status" || mutation === "roles") {
      assert.equal(await store.findUserBySessionTokenHash("session-test-hash"), null);
      assert.equal(await store.findUserByApiTokenHash("api-test-hash"), null);
    }
  });
}

test("concurrent owner removal keeps an active owner and only audits the committed change", async () => {
  const store = new MemoryAuthStore();
  for (const id of ["owner-a", "owner-b"]) {
    store.addUser({ id, email: `${id}@example.test`, roles: ["owner"], status: "active" });
  }
  const results = await Promise.all(["owner-a", "owner-b"].map((userId) => store.applyAdminUserStatusChange({
    userId, status: "disabled", protectLastActiveOwner: true, revokeCredentials: true,
    audit: { action: "admin.user.disable", decision: "allow", resourceType: "user", resourceId: userId },
  })));
  assert.deepEqual(results.map((result) => result.outcome).sort(), ["last_owner", "updated"]);
  assert.equal((await store.listUsers()).filter((user) => user.status === "active").length, 1);
  assert.equal((await store.listAuditEvents({ limit: 100 })).length, 1);
});

class FailingAuditStore extends MemoryAuthStore {
  failAudit = false;

  protected override async prepareAuditEvent(input: CreateAuditEventInput) {
    const event = await super.prepareAuditEvent(input);
    if (this.failAudit) throw new Error("Injected audit failure.");
    return event;
  }
}
