import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { hashPassword } from "@myskills-app/auth";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresOAuthStore } from "../src/oauth/postgres-store.js";
import type { OAuthAuthorizationCodeRecord } from "../src/oauth/types.js";
import { secretDigest } from "../src/oauth/tokens.js";

// Failure inventory before implementation: nullable legacy rows acquire invented
// assurance; unlocked consent snapshots a session being revoked; timestamps are
// recaptured at exchange/refresh; failed transactions leave usable authority;
// account/session lock ordering deadlocks with credential revocation.
test("Postgres OAuth preserves session assurance atomically, survives restart and fails closed on races", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname.replace(/^\//, ""), /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  const auth = new PostgresAuthStore(createDb(pool));
  const store = new PostgresOAuthStore(createDb(pool));
  const created = await auth.createUserWithPassword({ email: "assurance@example.test", name: "Assurance", passwordHash: await hashPassword("synthetic correct horse battery staple") });
  assert.ok(created.user);
  const userId = created.user.id;
  const now = new Date();
  const verifiedAt = new Date(now.getTime() - 120_000);
  const expiresAt = new Date(now.getTime() + 86_400_000);
  await auth.updateUserStatus({ userId, status: "active", emailVerifiedAt: now });
  const sessionHash = digest();
  await auth.createSession({ userId, tokenHash: sessionHash, expiresAt, mfaVerifiedAt: verifiedAt });

  const request = async (selectedSession = sessionHash) => {
    const handleHash = digest();
    const codeHash = digest();
    await store.createAuthorizationRequest({ handleHash, clientId: "assurance-test", redirectUri: "https://chatgpt.example.test/cb", scopes: ["architectures:write"], resource: "https://skills.example.test/mcp", state: null, codeChallenge: randomBytes(32).toString("base64url"), now, expiresAt });
    const decide = () => store.decideAuthorizationRequest({ handleHash, userId, sessionTokenHash: selectedSession, decision: "approve", now, code: { codeHash, expiresAt }, maxActiveGrantsPerUser: 100, requireMfa: true, requireFreshMfa: true });
    return { handleHash, codeHash, decide };
  };
  const issue = (code: OAuthAuthorizationCodeRecord) => ({
    grant: { userId, clientId: code.clientId, clientName: "Assurance test", registration: "configured" as const, scopes: code.scopes, resource: code.resource, createdAt: now, expiresAt, mfaVerifiedAt: code.mfaVerifiedAt, assuranceExpiresAt: code.assuranceExpiresAt },
    accessToken: { tokenHash: digest(), expiresAt, scopes: code.scopes }, refreshToken: { tokenHash: digest(), expiresAt },
  });
  const first = await request();
  assert.equal((await first.decide()).outcome, "decided");
  const codeRow = (await pool.query("SELECT mfa_verified_at, assurance_expires_at FROM oauth_authorization_codes WHERE code_hash=$1", [first.codeHash])).rows[0];
  assert.equal(codeRow.mfa_verified_at.toISOString(), verifiedAt.toISOString());
  assert.equal(codeRow.assurance_expires_at.getTime(), verifiedAt.getTime() + 900_000);
  const redeemed = await store.redeemAuthorizationCode({ codeHash: first.codeHash, now: new Date(now.getTime() + 30_000), verify: () => true, issue, maxActiveGrantsPerUser: 100 });
  assert.equal(redeemed.outcome, "issued");
  if (redeemed.outcome !== "issued") throw new Error("Expected issued grant");
  assert.equal(redeemed.grant.mfaVerifiedAt?.toISOString(), verifiedAt.toISOString());
  const restarted = new PostgresOAuthStore(createDb(pool));
  const persisted = (await restarted.listActiveGrants({ userId, now }))[0]!;
  assert.equal(persisted.assuranceExpiresAt?.getTime(), verifiedAt.getTime() + 900_000);
  const existingRefresh = (await pool.query("SELECT token_hash FROM oauth_refresh_tokens WHERE grant_id=$1", [persisted.id])).rows[0].token_hash as string;
  const nextAccessHash = digest();
  const rotated = await restarted.rotateRefreshToken({ tokenHash: existingRefresh, now: new Date(now.getTime() + 1_000_000), accessToken: { tokenHash: nextAccessHash, scopes: ["architectures:write"], expiresAt }, refreshToken: { tokenHash: digest(), expiresAt } });
  assert.equal(rotated.outcome, "rotated");
  assert.equal((await restarted.findAccessToken(nextAccessHash))?.grant.assuranceExpiresAt?.getTime(), verifiedAt.getTime() + 900_000);

  // A row created using the old insert contract remains explicitly unassured.
  const legacy = await pool.query("INSERT INTO oauth_grants (user_id,client_id,client_name,client_registration,scopes,resource,created_at,expires_at) VALUES ($1,'legacy','Legacy','configured','[\"skills:read\"]','https://skills.example.test/mcp',$2,$3) RETURNING id", [userId, now, expiresAt]);
  const legacyGrant = (await restarted.listActiveGrants({ userId, now })).find((grant) => grant.id === legacy.rows[0].id)!;
  assert.equal(legacyGrant.mfaVerifiedAt, null);
  assert.equal(legacyGrant.assuranceExpiresAt, null);

  // Hold a session revocation uncommitted. Consent must wait for its row lock,
  // then observe revocation, not capture the preceding verified timestamp.
  const race = await request();
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("UPDATE auth_sessions SET revoked_at=$1 WHERE token_hash=$2", [now, sessionHash]);
    let completed = false;
    const pending = race.decide().finally(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(completed, false, "consent must serialize with session revocation");
    await locker.query("COMMIT");
    assert.equal((await pending).outcome, "session_revoked");
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  assert.equal((await store.findAuthorizationRequest(race.handleHash))?.status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM oauth_authorization_codes WHERE code_hash=$1", [race.codeHash])).rows[0].n, 0);

  const liveSessionHash = digest();
  await auth.createSession({ userId, tokenHash: liveSessionHash, expiresAt, mfaVerifiedAt: verifiedAt });
  const accountRace = await request(liveSessionHash);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("assurance account race timed out")), 10_000).unref());
  await Promise.race([timeout, Promise.all([accountRace.decide(), auth.revokeUserCredentials(userId)])]);
  const late = await store.redeemAuthorizationCode({ codeHash: accountRace.codeHash, now, verify: () => true, issue, maxActiveGrantsPerUser: 100 });
  assert.equal(late.outcome, "invalid");
  assert.equal((await store.listActiveGrants({ userId, now })).length, 0);
});

function digest() { return secretDigest(randomBytes(32).toString("base64url")); }
