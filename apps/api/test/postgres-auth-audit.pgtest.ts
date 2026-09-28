import { brandingImages } from "./fixtures/branding-images.js";
import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "@myskills-app/auth";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import type { AuthResponseUser } from "../src/auth/types.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("Postgres privileged changes and their audits roll back together on audit failure", { timeout: 60_000 }, async (t) => {
  assert.ok(databaseUrl);
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const store = new PostgresAuthStore(createDb(pool));
  const service = new AuthService(store);
  const passwordHash = await hashPassword("correct horse battery staple");
  const owner = await store.createUserWithPassword({ email: "owner@example.test", name: "Owner", passwordHash });
  assert.ok(owner.user);
  await store.updateUserStatus({ userId: owner.user.id, status: "active", emailVerifiedAt: new Date() });
  const activeOwner = await store.updateUserRoles({ userId: owner.user.id, roles: ["owner"] });
  assert.ok(activeOwner);
  const actor: AuthResponseUser = { ...activeOwner, emailVerified: true, mfaVerified: true };
  await pool.query(`
    CREATE FUNCTION fail_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected admin audit failure';
    END $$;
  `);

  for (const mutation of ["status", "roles", "token", "registration", "site", "branding", "provider"] as const) {
    const created = await store.createUserWithPassword({ email: `${mutation}@example.test`, name: mutation, passwordHash });
    assert.ok(created.user);
    const target = await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
    assert.ok(target);
    const sessionHash = `session-${mutation}`;
    const apiHash = `api-${mutation}`;
    await store.createSession({ userId: target.id, tokenHash: sessionHash, expiresAt: new Date(Date.now() + 60_000) });
    const token = await store.createApiToken({ userId: target.id, name: mutation, tokenHash: apiHash, tokenPrefix: mutation, scopes: ["profile:read"], expiresAt: new Date(Date.now() + 60_000) });
    const auditBefore = await store.listAuditEvents({ limit: 100 });
    const execute = () => {
      switch (mutation) {
        case "status": return service.performAdminUserAction(actor, { userId: target.id, action: "disable", reason: "fixture" });
        case "roles": return service.updateAdminUserRoles(actor, { userId: target.id, roles: ["author"], reason: "fixture" });
        case "token": return service.revokeAdminApiToken(actor, token.id);
        case "registration": return service.updateRegistrationSettings(actor, { mode: "open" });
        case "site": return service.updateSiteSettings(actor, { landingPageEnabled: false });
        case "branding": return service.updateBranding(actor, { text: "Team Skills", showText: false, logoDataUrl: brandingImages.png });
        case "provider": return service.upsertAdminProviderConfig(actor, {
          key: "fixture", type: "oidc", displayName: "Fixture", enabled: false,
          roleMappings: [{ claim: "groups", value: "authors", role: "author" }],
        });
      }
    };
    await pool.query("CREATE TRIGGER fail_admin_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_admin_audit()");
    await assert.rejects(execute());
    await pool.query("DROP TRIGGER fail_admin_audit ON audit_events");
    assert.deepEqual(await store.findUserById(target.id), target, `${mutation}: account changed despite audit failure`);
    assert.ok(await store.findUserBySessionTokenHash(sessionHash), `${mutation}: session was revoked despite audit failure`);
    assert.ok(await store.findUserByApiTokenHash(apiHash), `${mutation}: token was revoked despite audit failure`);
    if (mutation === "registration") assert.equal(await store.getRegistrationMode(), "closed");
    if (mutation === "site") assert.deepEqual(await service.getPublicSiteSettings(), { landingPageEnabled: true });
    if (mutation === "branding") assert.deepEqual(await service.getPublicBranding(), { text: "MySkills", showText: true, logoDataUrl: null });
    if (mutation === "provider") assert.deepEqual(await store.listProviderConfigs(), []);
    assert.deepEqual(await store.listAuditEvents({ limit: 100 }), auditBefore);

    await execute();
    const auditAfter = await store.listAuditEvents({ limit: 100 });
    assert.equal(auditAfter.length, auditBefore.length + 1);
    if (mutation === "status" || mutation === "roles") {
      assert.equal(await store.findUserBySessionTokenHash(sessionHash), null);
      assert.equal(await store.findUserByApiTokenHash(apiHash), null);
    }
    if (mutation === "status") {
      assert.equal((await store.findUserById(target.id))?.status, "disabled");
      assert.equal(auditAfter[0].details.statusBefore, "active");
      assert.equal(auditAfter[0].details.statusAfter, "disabled");
    }
    if (mutation === "roles") assert.deepEqual((await store.findUserById(target.id))?.roles, ["author"]);
    if (mutation === "token") assert.equal(await store.findUserByApiTokenHash(apiHash), null);
    if (mutation === "registration") assert.equal(await store.getRegistrationMode(), "open");
    if (mutation === "site") {
      const restartedService = new AuthService(new PostgresAuthStore(createDb(pool)));
      assert.deepEqual(await restartedService.getPublicSiteSettings(), { landingPageEnabled: false });
      assert.equal(auditAfter[0].details.oldLandingPageEnabled, true);
      assert.equal(auditAfter[0].details.newLandingPageEnabled, false);
    }
    if (mutation === "branding") {
      const restartedService = new AuthService(new PostgresAuthStore(createDb(pool)));
      assert.deepEqual(await restartedService.getPublicBranding(), { text: "Team Skills", showText: false, logoDataUrl: brandingImages.png });
      assert.equal(auditAfter[0].details.oldText, "MySkills");
      assert.equal(auditAfter[0].details.newText, "Team Skills");
      assert.equal(auditAfter[0].details.logoChanged, true);
      assert.ok(!JSON.stringify(auditAfter[0]).includes("data:image"));
      assert.deepEqual(await restartedService.getPublicSiteSettings(), { landingPageEnabled: false });
    }
    if (mutation === "provider") assert.equal((await store.listProviderConfigs())[0].roleMappings.length, 1);
  }

  // Concurrent saves must produce a continuous old/new history, including the
  // first write when there is no settings row to lock.
  await pool.query("DELETE FROM instance_settings WHERE key = 'branding'");
  await pool.query("DELETE FROM audit_events WHERE action = 'admin.branding.update'");
  const secondService = new AuthService(new PostgresAuthStore(createDb(pool)));
  await Promise.all([
    service.updateBranding(actor, { text: "First contender", showText: true, logoDataUrl: brandingImages.jpeg }),
    secondService.updateBranding(actor, { text: "Second contender", showText: false, logoDataUrl: brandingImages.webp }),
  ]);
  const history = (await store.listAuditEvents({ limit: 100 })).filter((event) => event.action === "admin.branding.update");
  assert.equal(history.length, 2);
  const first = history.find((event) => event.details.oldText === "MySkills");
  assert.ok(first);
  const second = history.find((event) => event.id !== first.id);
  assert.ok(second);
  assert.equal(second.details.oldText, first.details.newText);
  assert.equal(second.details.oldLogoSha256, first.details.newLogoSha256);
  const persisted = await secondService.getPublicBranding();
  assert.equal(persisted.text, second.details.newText);
  assert.equal(persisted.showText, second.details.newShowText);
  await secondService.updateBranding(actor, { text: "MySkills", showText: true, logoDataUrl: null });
  assert.deepEqual(await service.getPublicBranding(), { text: "MySkills", showText: true, logoDataUrl: null });
  await pool.query("UPDATE instance_settings SET value = $1::jsonb WHERE key = 'branding'", [JSON.stringify({ text: "Corrupt", showText: true, logoDataUrl: "javascript:alert(1)" })]);
  await assert.rejects(service.getPublicBranding(), /branding|logo|image/i);
});
