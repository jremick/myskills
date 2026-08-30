import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { eq } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { hashApiToken, hashPassword, hashSessionToken, verifyPassword } from "@myskills-app/auth";
import { parseSkillManifest, type PackageInputFile } from "@myskills-app/skill-package";
import type { ArtifactObject, ArtifactObjectStorage } from "../src/artifacts/storage.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { artifactWriteIntents, authActionTokens, authSessions, roleAssignments, skillArtifacts, skillVersions, skills } from "../src/db/schema.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("scoped role assignments do not grant global roles or get erased by instance updates", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresAuthStore(db);
  const passwordHash = await hashPassword("correct horse battery staple");
  const globalOwner = await createActiveUser(store, "scoped-role-owner@example.com", passwordHash, ["owner"]);
  const scopedUser = await createActiveUser(store, "scoped-role-user@example.com", passwordHash);
  const scopeId = "11111111-1111-4111-8111-111111111111";
  const malformedInstanceScopeId = "22222222-2222-4222-8222-222222222222";

  await db.insert(roleAssignments).values([
    { userId: scopedUser.id, role: "owner", scopeType: "instance", scopeId: malformedInstanceScopeId },
    { userId: scopedUser.id, role: "maintainer", scopeType: "project", scopeId },
  ]);

  assert.deepEqual((await store.findUserById(scopedUser.id))?.roles, ["user"]);
  assert.equal(await store.countActiveOwnersExcluding(globalOwner.id), 0);
  assert.deepEqual(
    (await store.applyAdminUserStatusChange({
      userId: globalOwner.id,
      status: "disabled",
      protectLastActiveOwner: true,
      revokeCredentials: false,
    })).outcome,
    "last_owner",
  );

  assert.deepEqual((await store.updateUserRoles({ userId: scopedUser.id, roles: ["author"] }))?.roles, ["author"]);
  const preserved = await db
    .select({ role: roleAssignments.role, scopeType: roleAssignments.scopeType, scopeId: roleAssignments.scopeId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, scopedUser.id));
  assert.deepEqual(
    preserved.sort((a, b) => `${a.scopeType}:${a.role}`.localeCompare(`${b.scopeType}:${b.role}`)),
    [
      { role: "author", scopeType: "instance", scopeId: "00000000-0000-0000-0000-000000000000" },
      { role: "owner", scopeType: "instance", scopeId: malformedInstanceScopeId },
      { role: "maintainer", scopeType: "project", scopeId },
    ],
  );
  assert.deepEqual((await store.findUserById(scopedUser.id))?.roles, ["author"]);
});

test("organization visibility is excluded from non-owner discovery and public release access", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const authStore = new PostgresAuthStore(db);
  const submissionStore = new PostgresSubmissionStore(db);
  const service = new SubmissionService(submissionStore);
  const skillRepository = new PostgresSkillRepository(db);
  const passwordHash = await hashPassword("correct horse battery staple");
  await createActiveUser(authStore, "organization-instance-owner@example.com", passwordHash, ["owner"]);
  const owner = await createActiveUser(authStore, "organization-owner@example.com", passwordHash, ["author"]);
  const maintainer = await createActiveUser(authStore, "organization-maintainer@example.com", passwordHash, ["maintainer"]);
  const outsider = await createActiveUser(authStore, "organization-outsider@example.com", passwordHash);
  const packageInput = cleanPackageInput();
  const submitted = await service.createSubmission({ actor: { id: owner.id, roles: ["author"] }, ...packageInput });
  const reviewBundle = await service.getReviewSubmissionBundle({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
  });
  assert.ok(reviewBundle);
  await service.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: reviewBundle.artifact.sha256,
  });
  await service.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "publish",
  });

  await db.update(skills).set({ visibility: "organization" }).where(eq(skills.slug, packageInput.manifest.name));

  await assert.rejects(
    skillRepository.updateSkillSharing({
      actor: { id: owner.id, roles: ["author"] },
      slug: packageInput.manifest.name,
      visibility: "organization",
      teamIds: [],
      userEmails: [],
    }),
    (error) => error instanceof AppError && error.code === "ORGANIZATION_VISIBILITY_UNSUPPORTED",
  );

  const legacyUpdate = { visibility: "public" } as never;
  await assert.rejects(
    service.updateSkillMetadata({
      actor: { id: owner.id, roles: ["author"] },
      slug: packageInput.manifest.name,
      update: legacyUpdate,
    }),
    (error) => error instanceof AppError && error.code === "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE",
  );
  await assert.rejects(
    submissionStore.updateSkillMetadata({
      actor: { id: owner.id, roles: ["author"] },
      slug: packageInput.manifest.name,
      update: legacyUpdate,
    }),
    (error) => error instanceof AppError && error.code === "VISIBILITY_UPDATE_REQUIRES_SHARING_ROUTE",
  );
  assert.equal((await service.getSkillManagement({ actor: { id: owner.id, roles: ["author"] }, slug: packageInput.manifest.name }))?.visibility, "organization");

  assert.deepEqual(await skillRepository.searchVisibleSkills({ actorId: outsider.id }), []);
  assert.equal(await skillRepository.getVisibleSkillBySlug(packageInput.manifest.name, outsider.id), null);
  const ownerSearch = await skillRepository.searchVisibleSkills({ actorId: owner.id });
  assert.equal(ownerSearch.length, 1);
  assert.deepEqual(ownerSearch[0]?.access?.reasons, ["owner"]);

  assert.equal(await service.getPublicRelease({
    slug: packageInput.manifest.name,
    version: packageInput.manifest.version,
    actorId: outsider.id,
  }), null);
  assert.ok(await service.getPublicRelease({
    slug: packageInput.manifest.name,
    version: packageInput.manifest.version,
    actorId: owner.id,
  }));
  assert.equal(await service.getPublicBundle({
    slug: packageInput.manifest.name,
    version: packageInput.manifest.version,
    actorId: outsider.id,
  }), null);
  assert.ok(await service.getPublicBundle({
    slug: packageInput.manifest.name,
    version: packageInput.manifest.version,
    actorId: owner.id,
  }));
});

test("password reset atomically invalidates sibling links and rolls back injected failures", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresAuthStore(db);
  const oldPasswordHash = await hashPassword("correct horse battery staple");
  const user = await createActiveUser(store, "reset-atomic@example.com", oldPasswordHash);
  const firstToken = "a".repeat(43);
  const siblingToken = "b".repeat(43);
  for (const token of [firstToken, siblingToken]) {
    await store.createAuthActionToken({
      userId: user.id,
      purpose: "password_reset",
      tokenHash: hashSessionToken(token),
      sentToNormalizedEmail: user.email,
      expiresAt: new Date(Date.now() + 60_000),
    });
  }
  await store.createSession({
    userId: user.id,
    tokenHash: hashSessionToken("s".repeat(43)),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await store.createApiToken({
    userId: user.id,
    name: "Reset atomicity",
    tokenPrefix: "aiss_atomic",
    tokenHash: hashApiToken(`aiss_${"t".repeat(43)}`),
    scopes: ["profile:read"],
    expiresAt: new Date(Date.now() + 60_000),
  });

  await pool.query(`
    CREATE FUNCTION fail_reset_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected reset failure';
    END $$;
    CREATE TRIGGER fail_reset_revocation
      BEFORE UPDATE ON auth_sessions
      FOR EACH ROW EXECUTE FUNCTION fail_reset_revocation();
  `);
  const newPasswordHash = await hashPassword("new correct horse battery staple");
  await assert.rejects(store.completePasswordReset({
    tokenHash: hashSessionToken(firstToken),
    passwordHash: newPasswordHash,
  }));
  await pool.query("DROP TRIGGER fail_reset_revocation ON auth_sessions; DROP FUNCTION fail_reset_revocation()");

  const unchanged = await store.findUserByEmailWithPassword(user.email);
  assert.equal(await verifyPassword(unchanged?.passwordHash ?? "", "correct horse battery staple"), true);
  assert.deepEqual((await db.select({ usedAt: authActionTokens.usedAt }).from(authActionTokens)).map((row) => row.usedAt), [null, null]);

  assert.equal(await store.completePasswordReset({
    tokenHash: hashSessionToken(firstToken),
    passwordHash: newPasswordHash,
  }), true);
  assert.equal(await store.completePasswordReset({
    tokenHash: hashSessionToken(siblingToken),
    passwordHash: await hashPassword("sibling correct horse battery staple"),
  }), false);
  assert.equal((await db.select().from(authActionTokens)).every((row) => row.usedAt instanceof Date), true);
  assert.equal((await db.select().from(authSessions)).every((row) => row.revokedAt instanceof Date), true);
  assert.equal((await store.listApiTokensForUser(user.id)).every((row) => row.revokedAt instanceof Date), true);
});

test("concurrent owner disable and delete transitions cannot remove the final active owner", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const store = new PostgresAuthStore(createDb(pool));
  const passwordHash = await hashPassword("correct horse battery staple");
  const first = await createActiveUser(store, "owner-one@example.com", passwordHash, ["owner"]);
  const second = await createActiveUser(store, "owner-two@example.com", passwordHash, ["owner"]);

  for (const status of ["disabled", "deleted"] as const) {
    await store.updateUserStatus({ userId: first.id, status: "active" });
    await store.updateUserStatus({ userId: second.id, status: "active" });
    const results = await Promise.all([
      store.applyAdminUserStatusChange({
        userId: first.id,
        status,
        protectLastActiveOwner: true,
        revokeCredentials: true,
      }),
      store.applyAdminUserStatusChange({
        userId: second.id,
        status,
        protectLastActiveOwner: true,
        revokeCredentials: true,
      }),
    ]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["last_owner", "updated"]);
    const activeOwners = (await store.listUsers()).filter((user) => user.status === "active" && user.roles.includes("owner"));
    assert.equal(activeOwners.length, 1);
  }
});

test("role changes and credential revocation roll back together on failure", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const store = new PostgresAuthStore(createDb(pool));
  const passwordHash = await hashPassword("correct horse battery staple");
  await createActiveUser(store, "role-owner@example.com", passwordHash, ["owner"]);
  const target = await createActiveUser(store, "role-target@example.com", passwordHash);
  await store.createSession({
    userId: target.id,
    tokenHash: hashSessionToken("r".repeat(43)),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await store.createApiToken({
    userId: target.id,
    name: "Role rollback",
    tokenPrefix: "aiss_roles",
    tokenHash: hashApiToken(`aiss_${"r".repeat(43)}`),
    scopes: ["profile:read"],
    expiresAt: new Date(Date.now() + 60_000),
  });
  await pool.query(`
    CREATE FUNCTION fail_role_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected role revocation failure';
    END $$;
    CREATE TRIGGER fail_role_revocation
      BEFORE UPDATE ON api_tokens
      FOR EACH ROW EXECUTE FUNCTION fail_role_revocation();
  `);

  await assert.rejects(store.updateUserRolesAndRevokeCredentials({ userId: target.id, roles: ["author"] }));
  await pool.query("DROP TRIGGER fail_role_revocation ON api_tokens; DROP FUNCTION fail_role_revocation()");
  assert.deepEqual((await store.findUserById(target.id))?.roles, ["user"]);
  assert.equal((await store.listApiTokensForUser(target.id))[0].revokedAt, null);
  assert.equal((await createDb(pool).select().from(authSessions))[0].revokedAt, null);

  assert.deepEqual((await store.updateUserRolesAndRevokeCredentials({ userId: target.id, roles: ["author"] }))?.roles, ["author"]);
  assert.equal((await store.listApiTokensForUser(target.id))[0].revokedAt instanceof Date, true);
  assert.equal((await createDb(pool).select().from(authSessions))[0].revokedAt instanceof Date, true);
});

test("account security mutations and credential revocation commit or roll back together", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const store = new PostgresAuthStore(db);
  const passwordHash = await hashPassword("correct horse battery staple");

  const passwordUser = await createActiveUser(store, "password-atomic@example.com", passwordHash);
  await createCredentials(store, passwordUser.id, "password");
  await installRevocationFailure(pool, "fail_password_revocation");
  const nextPasswordHash = await hashPassword("new correct horse battery staple");
  await assert.rejects(store.changePasswordAndRevokeCredentials({
    userId: passwordUser.id,
    passwordHash: nextPasswordHash,
  }));
  await removeRevocationFailure(pool, "fail_password_revocation");
  assert.equal(await verifyPassword((await store.findUserByEmailWithPassword(passwordUser.email))?.passwordHash ?? "", "correct horse battery staple"), true);
  assert.deepEqual(await credentialRevocationState(db, passwordUser.id), [null, null]);
  assert.equal(await store.changePasswordAndRevokeCredentials({ userId: passwordUser.id, passwordHash: nextPasswordHash }), true);
  assert.equal(await verifyPassword((await store.findUserByEmailWithPassword(passwordUser.email))?.passwordHash ?? "", "new correct horse battery staple"), true);
  assert.equal((await credentialRevocationState(db, passwordUser.id)).every((value) => value instanceof Date), true);

  const emailUser = await createActiveUser(store, "email-before@example.com", passwordHash);
  await createCredentials(store, emailUser.id, "email");
  const emailToken = "e".repeat(43);
  await store.createAuthActionToken({
    userId: emailUser.id,
    purpose: "email_change",
    tokenHash: hashSessionToken(emailToken),
    sentToNormalizedEmail: "email-after@example.com",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await installRevocationFailure(pool, "fail_email_revocation");
  await assert.rejects(store.completeEmailChangeAndRevokeCredentials({ tokenHash: hashSessionToken(emailToken) }));
  await removeRevocationFailure(pool, "fail_email_revocation");
  assert.ok(await store.findUserByEmailWithPassword("email-before@example.com"));
  assert.equal(await store.findUserByEmailWithPassword("email-after@example.com"), null);
  assert.equal((await db.select().from(authActionTokens)).find((token) => token.tokenHash === hashSessionToken(emailToken))?.usedAt, null);
  assert.deepEqual(await credentialRevocationState(db, emailUser.id), [null, null]);
  assert.equal((await store.completeEmailChangeAndRevokeCredentials({ tokenHash: hashSessionToken(emailToken) }))?.outcome, "changed");
  assert.ok(await store.findUserByEmailWithPassword("email-after@example.com"));
  assert.equal((await credentialRevocationState(db, emailUser.id)).every((value) => value instanceof Date), true);

  const mfaUser = await createActiveUser(store, "mfa-atomic@example.com", passwordHash);
  const factor = await store.createMfaTotpFactor({
    userId: mfaUser.id,
    label: "Atomic factor",
    secretCiphertext: "test-ciphertext",
  });
  await store.enableMfaTotpFactor({ userId: mfaUser.id, factorId: factor.id, lastUsedCounter: 1 });
  await store.replaceMfaRecoveryCodes({ userId: mfaUser.id, codeHashes: ["f".repeat(64)] });
  await createCredentials(store, mfaUser.id, "mfa", true);
  await installRevocationFailure(pool, "fail_mfa_revocation");
  await assert.rejects(store.disableMfaAndRevokeCredentials({ userId: mfaUser.id }));
  await removeRevocationFailure(pool, "fail_mfa_revocation");
  assert.equal(await store.countEnabledMfaFactors(mfaUser.id), 1);
  assert.equal(await store.countUnusedMfaRecoveryCodes(mfaUser.id), 1);
  assert.deepEqual(await credentialRevocationState(db, mfaUser.id), [null, null]);
  assert.equal(await store.disableMfaAndRevokeCredentials({ userId: mfaUser.id }), 1);
  assert.equal(await store.countEnabledMfaFactors(mfaUser.id), 0);
  assert.equal(await store.countUnusedMfaRecoveryCodes(mfaUser.id), 0);
  assert.equal((await credentialRevocationState(db, mfaUser.id)).every((value) => value instanceof Date), true);
});

test("Postgres revoked release restore enforces privilege and persisted artifact-scan safety", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const service = new SubmissionService(new PostgresSubmissionStore(db));
  const authStore = new PostgresAuthStore(db);
  const passwordHash = await hashPassword("correct horse battery staple");
  const author = await createActiveUser(authStore, "restore-author@example.com", passwordHash);
  const maintainer = await createActiveUser(authStore, "restore-maintainer@example.com", passwordHash);
  const authorActor = { id: author.id, roles: ["author" as const] };
  const maintainerActor = { id: maintainer.id, roles: ["maintainer" as const] };
  const submitted = await service.createSubmission({ actor: authorActor, ...cleanPackageInput() });
  const bundle = await service.getReviewSubmissionBundle({ actor: maintainerActor, submissionId: submitted.id });
  assert.ok(bundle);
  await service.performReviewAction({
    actor: maintainerActor,
    submissionId: submitted.id,
    action: "approve",
    artifactSha256: bundle.artifact.sha256,
  });
  await service.performReviewAction({ actor: maintainerActor, submissionId: submitted.id, action: "publish" });
  await service.performReleaseAction({
    actor: maintainerActor,
    slug: submitted.skillSlug,
    version: submitted.version,
    action: "revoke",
  });

  await assert.rejects(service.performReleaseAction({
    actor: authorActor,
    slug: submitted.skillSlug,
    version: submitted.version,
    action: "restore",
  }), (error) => error instanceof AppError && error.code === "RELEASE_RESTORE_ROLE_REQUIRED");
  assert.equal((await service.performReleaseAction({
    actor: maintainerActor,
    slug: submitted.skillSlug,
    version: submitted.version,
    action: "restore",
  })).lifecycleStatus, "approved");

  await service.performReleaseAction({
    actor: maintainerActor,
    slug: submitted.skillSlug,
    version: submitted.version,
    action: "revoke",
  });
  await pool.query("UPDATE skill_versions SET approved_artifact_sha256 = $2 WHERE id = $1", [submitted.id, "0".repeat(64)]);
  await assert.rejects(service.performReleaseAction({
    actor: maintainerActor,
    slug: submitted.skillSlug,
    version: submitted.version,
    action: "restore",
  }), (error) => error instanceof AppError && error.code === "RELEASE_RESTORE_UNSAFE");
});

test("migration runner serializes concurrent migrators and rolls failed files back", { timeout: 60_000 }, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  const migrationsDir = await mkdtemp(path.join(os.tmpdir(), "myskills-migrations-"));
  t.after(async () => {
    await pool.end();
    await rm(migrationsDir, { recursive: true, force: true });
  });
  await resetDatabase(pool);
  await writeFile(path.join(migrationsDir, "0001_once.sql"), `
    CREATE TABLE migration_once (id integer PRIMARY KEY);
    INSERT INTO migration_once (id) VALUES (1);
    SELECT pg_sleep(0.1);
  `);

  await Promise.all([
    runMigrations(pool, { migrationsDir }),
    runMigrations(pool, { migrationsDir }),
  ]);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM migration_once")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE id = '0001_once'")).rows[0].count, 1);

  await writeFile(path.join(migrationsDir, "0002_broken.sql"), `
    CREATE TABLE migration_rollback_probe (id integer);
    SELECT definitely_missing_function();
  `);
  await assert.rejects(runMigrations(pool, { migrationsDir }));
  assert.equal((await pool.query("SELECT to_regclass('migration_rollback_probe') AS relation")).rows[0].relation, null);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE id = '0002_broken'")).rows[0].count, 0);
});

test("deny audits survive rollback with a single-connection saturated pool", { timeout: 60_000 }, async (t) => {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1_000 });
  t.after(() => pool.end());
  await resetDatabase(pool);
  await runMigrations(pool);
  const db = createDb(pool);
  const store = new PostgresSubmissionStore(db);
  const service = new SubmissionService(store);
  const authStore = new PostgresAuthStore(db);
  const passwordHash = await hashPassword("correct horse battery staple");
  const author = await createActiveUser(authStore, "deny-author@example.com", passwordHash);
  const maintainer = await createActiveUser(authStore, "deny-maintainer@example.com", passwordHash);
  const submitted = await service.createSubmission({ actor: { id: author.id, roles: ["author"] }, ...cleanPackageInput() });
  await pool.query("UPDATE skill_versions SET lifecycle_status = 'archived', deleted_at = now() WHERE id = $1", [submitted.id]);

  await assert.rejects(service.performReviewAction({
    actor: { id: maintainer.id, roles: ["maintainer"] },
    submissionId: submitted.id,
    action: "request-changes",
  }), (error) => error instanceof AppError && error.code === "SUBMISSION_NOT_REVIEWABLE");
  const audit = await pool.query(`
    SELECT count(*)::int AS count
    FROM audit_events
    WHERE action = 'review.request_changes'
      AND decision = 'deny'
      AND resource_id = $1
      AND details->>'reason' = 'not_reviewable'
  `, [submitted.id]);
  assert.equal(audit.rows[0].count, 1);
});

test("artifact uniqueness and durable recovery intents prevent unrecoverable DB-failure orphans", { timeout: 60_000 }, async (t) => {
  const pool = await freshPool(t);
  const db = createDb(pool);
  const storage = new RecoverableArtifactStorage();
  const store = new PostgresSubmissionStore(db, { artifactStorage: storage });
  const service = new SubmissionService(store);
  const authStore = new PostgresAuthStore(db);
  const author = await createActiveUser(authStore, "artifact-author@example.com", await hashPassword("correct horse battery staple"));
  const input = { actor: { id: author.id, roles: ["author" as const] }, ...cleanPackageInput() };
  storage.failPutAfterWrite = true;
  await assert.rejects(service.createSubmission(input), /Injected indeterminate put failure/);
  assert.equal((await db.select().from(artifactWriteIntents)).length, 0);
  assert.equal(storage.size, 0);

  storage.failPutAfterWrite = false;
  const submitted = await service.createSubmission(input);

  await assert.rejects(db.insert(skillArtifacts).values({
    skillVersionId: submitted.id,
    storageKey: "duplicate/version.json",
    sha256: "0".repeat(64),
    byteSize: 2,
    contentType: "application/json",
    payload: { files: [] },
  }));

  storage.failDeletes = true;
  await assert.rejects(service.createSubmission(input), AggregateError);
  assert.equal((await db.select().from(skillVersions)).length, 1);
  assert.equal((await db.select().from(skillArtifacts)).length, 1);
  assert.equal((await db.select().from(artifactWriteIntents)).length, 1);
  assert.equal(storage.size, 2);

  storage.failDeletes = false;
  assert.deepEqual(await store.reconcilePendingArtifactWrites({ staleIntentMs: 0 }), { recovered: 1, retained: 0 });
  assert.equal((await db.select().from(artifactWriteIntents)).length, 0);
  assert.equal(storage.size, 1);
});

async function freshPool(t: TestContext) {
  assert.ok(databaseUrl);
  assertSafeTestDatabaseUrl(databaseUrl);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await resetDatabase(pool);
  await runMigrations(pool);
  return pool;
}

async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

function assertSafeTestDatabaseUrl(value: string): void {
  const databaseName = new URL(value).pathname.replace(/^\//, "");
  if (!/(^|[_-])(test|ci)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing to reset non-test database ${databaseName}.`);
  }
}

async function createActiveUser(
  store: PostgresAuthStore,
  email: string,
  passwordHash: string,
  roles: Array<"owner" | "admin" | "maintainer" | "author" | "user"> = ["user"],
) {
  const created = await store.createUserWithPassword({ email, name: email, passwordHash });
  assert.ok(created.user);
  await store.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
  if (roles.length !== 1 || roles[0] !== "user") {
    await store.updateUserRoles({ userId: created.user.id, roles });
  }
  return { ...created.user, roles, emailVerifiedAt: new Date() };
}

async function createCredentials(
  store: PostgresAuthStore,
  userId: string,
  suffix: string,
  mfaVerified = false,
): Promise<void> {
  await store.createSession({
    userId,
    tokenHash: hashSessionToken(`${suffix.slice(0, 1) || "s"}`.repeat(43)),
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: mfaVerified ? new Date() : null,
  });
  await store.createApiToken({
    userId,
    name: `${suffix} atomicity`,
    tokenPrefix: `aiss_${suffix}`,
    tokenHash: hashApiToken(`aiss_${suffix.slice(0, 1) || "t"}`.repeat(8)),
    scopes: mfaVerified ? ["review:read"] : ["profile:read"],
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: mfaVerified ? new Date() : null,
  });
}

async function credentialRevocationState(db: ReturnType<typeof createDb>, userId: string): Promise<Array<Date | null>> {
  const sessions = (await db.select().from(authSessions)).filter((session) => session.userId === userId);
  const tokens = await new PostgresAuthStore(db).listApiTokensForUser(userId);
  assert.equal(sessions.length, 1);
  assert.equal(tokens.length, 1);
  return [sessions[0].revokedAt, tokens[0].revokedAt];
}

async function installRevocationFailure(pool: pg.Pool, name: string): Promise<void> {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid trigger name.");
  await pool.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected credential revocation failure';
    END $$;
    CREATE TRIGGER ${name}
      BEFORE UPDATE ON api_tokens
      FOR EACH ROW EXECUTE FUNCTION ${name}();
  `);
}

async function removeRevocationFailure(pool: pg.Pool, name: string): Promise<void> {
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid trigger name.");
  await pool.query(`DROP TRIGGER ${name} ON api_tokens; DROP FUNCTION ${name}()`);
}

function cleanPackageInput(): { manifest: ReturnType<typeof parseSkillManifest>; files: PackageInputFile[] } {
  const manifest = parseSkillManifest({
    name: "hardening-helper",
    title: "Hardening Helper",
    summary: "Exercises security invariants.",
    version: "0.1.0",
    license: "Apache-2.0",
    visibility: "public",
    platforms: [{ name: "codex", install_target: "codex-skill" }],
    tags: ["security"],
  });
  return {
    manifest,
    files: [
      { path: "skill.json", content: JSON.stringify(manifest) },
      { path: "README.md", content: "Security invariants." },
    ],
  };
}

class RecoverableArtifactStorage implements ArtifactObjectStorage {
  failDeletes = false;
  failPutAfterWrite = false;
  private readonly objects = new Map<string, ArtifactObject>();

  get size(): number {
    return this.objects.size;
  }

  async putObject(input: { key: string; body: string; contentType: string; sha256: string }): Promise<void> {
    if (this.objects.has(input.key)) {
      throw new Error("Artifact object already exists.");
    }
    this.objects.set(input.key, { body: input.body, contentType: input.contentType, sha256: input.sha256 });
    if (this.failPutAfterWrite) {
      throw new Error("Injected indeterminate put failure.");
    }
  }

  async getObject(key: string): Promise<ArtifactObject> {
    const object = this.objects.get(key);
    if (!object) throw new Error("Artifact object not found.");
    return object;
  }

  async deleteObject(key: string): Promise<void> {
    if (this.failDeletes) throw new Error("Injected delete failure.");
    this.objects.delete(key);
  }

  async checkReady(): Promise<void> {}
}
