import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { parseOAuthConfig } from "../src/oauth/config.js";
import { PostgresOAuthStore } from "../src/oauth/postgres-store.js";
import { OAuthService } from "../src/oauth/service.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://skills.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://chatgpt.example.test/connector/oauth/pg";
const PASSWORD = "correct horse battery staple";

test("Postgres OAuth connections persist hashed secrets, enforce single use under concurrency and cascade revocation", { timeout: 120_000 }, async (t) => {
  assert.ok(databaseUrl);
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  assert.match(databaseName, /(^|[_-])(test|ci)([_-]|$)/i, "Refusing to reset a non-test database.");
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);

  const build = () => {
    const db = createDb(pool);
    const authStore = new PostgresAuthStore(db);
    const config = parseOAuthConfig({
      NODE_ENV: "production",
      MYSKILLS_OAUTH_ENABLED: "true",
      MYSKILLS_OAUTH_ISSUER: ORIGIN,
      MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
      APP_BASE_URL: ORIGIN,
      MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true",
      MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test",
    });
    assert.ok(config);
    const oauthStore = new PostgresOAuthStore(db);
    const oauthService = new OAuthService({ store: oauthStore, authStore, config });
    const app = buildApp({
      skillRepository: new MemorySkillRepository([]),
      authService: new AuthService(authStore, { oauthAccessTokens: oauthService }),
      oauthService,
      allowedOrigins: [ORIGIN],
    });
    return { app, authStore, oauthStore };
  };
  const first = build();
  t.after(() => first.app.close());
  const { app, authStore } = first;

  const created = await authStore.createUserWithPassword({ email: "reader@example.test", name: "Reader", passwordHash: await hashPassword(PASSWORD) });
  assert.ok(created.user);
  await authStore.updateUserStatus({ userId: created.user.id, status: "active", emailVerifiedAt: new Date() });
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "reader@example.test", password: PASSWORD } });
  const session = login.json().token as string;

  const registered = await app.inject({ method: "POST", url: "/oauth/register", payload: { client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" } });
  assert.equal(registered.statusCode, 201);
  const client = registered.json() as { client_id: string; client_secret: string };
  const basic = { authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}` };

  const approve = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "pg-state", resource: RESOURCE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })}` });
    const handle = new URLSearchParams(new URL(String(authorize.headers.location)).hash.slice(1)).get("request")!;
    return { verifier, handle };
  };
  const decide = (handle: string) => app.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: { authorization: `Bearer ${session}` }, payload: { request: handle, decision: "approve" } });
  const token = (fields: Record<string, string>) => app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded", ...basic }, payload: new URLSearchParams(fields).toString() });
  const mcpSession = (accessToken: string) => app.inject({ method: "GET", url: "/v1/mcp/session", headers: { authorization: `Bearer ${accessToken}` } });

  // Concurrent consent decisions: exactly one approval.
  const decisionRace = await approve();
  const decisions = await Promise.all(Array.from({ length: 6 }, () => decide(decisionRace.handle)));
  assert.deepEqual(decisions.map((response) => response.statusCode).sort(), [200, 409, 409, 409, 409, 409]);
  const code = new URL(decisions.find((response) => response.statusCode === 200)!.json().redirectTo).searchParams.get("code")!;

  // Concurrent code exchange: redemption is one transaction on the locked code
  // row, so exactly one request is issued tokens; the replays that follow it
  // revoke that connection (RFC 6749 section 4.1.2).
  const exchanges = await Promise.all(Array.from({ length: 8 }, () => token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: decisionRace.verifier })));
  assert.equal(exchanges.filter((response) => response.statusCode === 200).length, 1);
  assert.ok(exchanges.filter((response) => response.statusCode !== 200).every((response) => response.json().error === "invalid_grant"));
  const raced = exchanges.find((response) => response.statusCode === 200)!.json();
  assert.equal((await mcpSession(raced.access_token)).statusCode, 401, "code replay revoked the connection");
  const replayRow = await pool.query("SELECT revoked_reason FROM oauth_grants ORDER BY created_at LIMIT 1");
  assert.equal(replayRow.rows[0]?.revoked_reason, "code_replay");

  // Concurrent refresh: one rotation succeeds; reuse revokes the connection.
  const fresh = await approve();
  const freshCode = new URL((await decide(fresh.handle)).json().redirectTo).searchParams.get("code")!;
  const connected = (await token({ grant_type: "authorization_code", code: freshCode, redirect_uri: REDIRECT, code_verifier: fresh.verifier })).json();
  const refreshes = await Promise.all(Array.from({ length: 8 }, () => token({ grant_type: "refresh_token", refresh_token: connected.refresh_token })));
  assert.equal(refreshes.filter((response) => response.statusCode === 200).length, 1);
  const rotated = refreshes.find((response) => response.statusCode === 200)!.json();
  assert.equal((await mcpSession(rotated.access_token)).statusCode, 401, "refresh reuse revoked the rotated connection");

  // Persistence across a new store/service instance.
  const stable = await approve();
  const stableCode = new URL((await decide(stable.handle)).json().redirectTo).searchParams.get("code")!;
  const stableTokens = (await token({ grant_type: "authorization_code", code: stableCode, redirect_uri: REDIRECT, code_verifier: stable.verifier })).json();
  const restarted = build();
  t.after(() => restarted.app.close());
  const restartedSession = await restarted.app.inject({ method: "GET", url: "/v1/mcp/session", headers: { authorization: `Bearer ${stableTokens.access_token}` } });
  assert.equal(restartedSession.statusCode, 200);
  const listed = await restarted.app.inject({ method: "GET", url: "/v1/oauth/connections", headers: { authorization: `Bearer ${session}` } });
  assert.equal(listed.json().connections.length, 1);

  // Secrets are stored only as digests.
  const secrets = [client.client_secret, code, freshCode, stableCode, stable.handle, connected.access_token, connected.refresh_token, stableTokens.access_token, stableTokens.refresh_token, stable.verifier];
  for (const table of ["oauth_clients", "oauth_authorization_requests", "oauth_authorization_codes", "oauth_grants", "oauth_access_tokens", "oauth_refresh_tokens", "audit_events"]) {
    const dump = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    for (const secret of secrets) assert.equal(dump.includes(secret), false, `${table} contains a raw secret`);
  }

  // Account-level revocation cascades to connector grants and unredeemed codes.
  const unredeemed = await approve();
  const unredeemedCode = new URL((await decide(unredeemed.handle)).json().redirectTo).searchParams.get("code")!;
  const changed = await restarted.authStore.changePasswordAndRevokeCredentials({ userId: created.user.id, passwordHash: await hashPassword("another correct horse battery staple") });
  assert.equal(changed, true);
  assert.equal((await mcpSession(stableTokens.access_token)).statusCode, 401);
  const active = await pool.query("SELECT count(*)::int AS count FROM oauth_grants WHERE revoked_at IS NULL");
  assert.equal(active.rows[0]?.count, 0);
  const lateExchange = await token({ grant_type: "authorization_code", code: unredeemedCode, redirect_uri: REDIRECT, code_verifier: unredeemed.verifier });
  assert.equal(lateExchange.json().error, "invalid_grant");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM oauth_grants WHERE revoked_at IS NULL")).rows[0]?.count, 0);

  // The connection cap also applies when approved codes are redeemed later.
  const relogin = await restarted.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "reader@example.test", password: "another correct horse battery staple" } });
  const cappedSession = relogin.json().token as string;
  const cappedConfig = parseOAuthConfig({
    NODE_ENV: "production", MYSKILLS_OAUTH_ENABLED: "true", MYSKILLS_OAUTH_ISSUER: ORIGIN, MYSKILLS_MCP_PUBLIC_URL: RESOURCE,
    APP_BASE_URL: ORIGIN, MYSKILLS_OAUTH_DYNAMIC_REGISTRATION: "true", MYSKILLS_OAUTH_REDIRECT_HOSTS: "chatgpt.example.test",
  })!;
  const cappedAuthStore = new PostgresAuthStore(createDb(pool));
  const cappedService = new OAuthService({ store: new PostgresOAuthStore(createDb(pool)), authStore: cappedAuthStore, config: { ...cappedConfig, maxConnectionsPerUser: 1 } });
  const capped = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(cappedAuthStore, { oauthAccessTokens: cappedService }), oauthService: cappedService, allowedOrigins: [ORIGIN] });
  t.after(() => capped.close());
  const cappedCodes = [];
  for (let index = 0; index < 3; index += 1) {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await capped.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })}` });
    const handle = new URLSearchParams(new URL(String(authorize.headers.location)).hash.slice(1)).get("request")!;
    const decided = await capped.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: { authorization: `Bearer ${cappedSession}` }, payload: { request: handle, decision: "approve" } });
    assert.equal(decided.statusCode, 200);
    cappedCodes.push({ verifier, code: new URL(decided.json().redirectTo).searchParams.get("code")! });
  }
  const cappedExchanges = await Promise.all(cappedCodes.map(({ code: cappedCode, verifier }) => capped.inject({
    method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded", ...basic },
    payload: new URLSearchParams({ grant_type: "authorization_code", code: cappedCode, redirect_uri: REDIRECT, code_verifier: verifier }).toString(),
  })));
  assert.equal(cappedExchanges.filter((response) => response.statusCode === 200).length, 1, "per-account cap holds under concurrent redemption");

  // Bounded account-revocation race. Redemption, consent decisions and two
  // revocation paths overlap. Every path locks the account row before codes
  // and grants, so none deadlocks, and no connector authority survives.
  const racePassword = await hashPassword("race correct horse battery staple");
  const raceCreated = await restarted.authStore.createUserWithPassword({ email: "race@example.test", name: "Race", passwordHash: await hashPassword(PASSWORD) });
  assert.ok(raceCreated.user);
  const raceUserId = raceCreated.user.id;
  await restarted.authStore.updateUserStatus({ userId: raceUserId, status: "active", emailVerifiedAt: new Date() });
  const raceSession = (await restarted.app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "race@example.test", password: PASSWORD } })).json().token as string;
  const raceAuthorize = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const authorize = await restarted.app.inject({ method: "GET", url: `/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })}` });
    return { verifier, handle: new URLSearchParams(new URL(String(authorize.headers.location)).hash.slice(1)).get("request")! };
  };
  const raceDecide = (handle: string) => restarted.app.inject({ method: "POST", url: "/v1/oauth/consent/decision", headers: { authorization: `Bearer ${raceSession}` }, payload: { request: handle, decision: "approve" } });
  const raceCodes = [];
  for (let index = 0; index < 4; index += 1) {
    const started = await raceAuthorize();
    const decided = await raceDecide(started.handle);
    assert.equal(decided.statusCode, 200);
    raceCodes.push({ verifier: started.verifier, code: new URL(decided.json().redirectTo).searchParams.get("code")! });
  }
  const undecided = await Promise.all([raceAuthorize(), raceAuthorize(), raceAuthorize()]);
  const raceToken = (fields: Record<string, string>) => restarted.app.inject({ method: "POST", url: "/oauth/token", headers: { "content-type": "application/x-www-form-urlencoded", ...basic }, payload: new URLSearchParams(fields).toString() });
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("account-revocation race did not settle")), 20_000).unref());
  const settled = await Promise.race([deadline, Promise.all([
    ...raceCodes.map(({ code: raceCode, verifier }) => raceToken({ grant_type: "authorization_code", code: raceCode, redirect_uri: REDIRECT, code_verifier: verifier })),
    ...undecided.map(({ handle }) => raceDecide(handle)),
    restarted.authStore.changePasswordAndRevokeCredentials({ userId: raceUserId, passwordHash: racePassword }).then(() => null),
    restarted.authStore.revokeUserCredentials(raceUserId).then(() => null),
  ])]);
  for (const response of settled) {
    if (response) assert.ok([200, 400, 401].includes(response.statusCode), `unexpected ${response.statusCode}: ${response.body}`);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM oauth_grants WHERE user_id = $1 AND revoked_at IS NULL", [raceUserId])).rows[0]?.count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM oauth_authorization_codes WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL", [raceUserId])).rows[0]?.count, 0);
  for (const response of settled) {
    if (response?.statusCode === 200 && response.json().access_token) {
      assert.equal((await restarted.app.inject({ method: "GET", url: "/v1/mcp/session", headers: { authorization: `Bearer ${response.json().access_token}` } })).statusCode, 401);
    }
  }
  // A decision after the revocation cannot create new code authority from the old session.
  assert.equal((await raceDecide((await raceAuthorize()).handle)).statusCode, 401);

  // Expired single-use records are pruned.
  await pool.query("UPDATE oauth_authorization_requests SET expires_at = now() - interval '2 days'");
  await pool.query("UPDATE oauth_authorization_codes SET expires_at = now() - interval '2 days'");
  await restarted.oauthStore.cleanup(new Date());
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM oauth_authorization_requests")).rows[0]?.count, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM oauth_authorization_codes")).rows[0]?.count, 0);
});
