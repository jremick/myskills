/**
 * Authored before the GitHub integration implementation.
 * Observable boundary: real HTTP routes, real sessions and real Postgres; only
 * the external GitHub transport is deterministic. Existing library/auth tests
 * do not connect a separate GitHub identity or exercise token rotation.
 *
 * Failure inventory / journey gates:
 * G01 Anonymous, API-token, ordinary-user and non-MFA admin configuration denied.
 * G02 Secrets never occur in API views/audit rows and are encrypted in storage.
 * G03 OAuth uses PKCE, single-use expiring state bound to user AND session.
 * G04 Another user's session, another session of the same user, expired/replayed
 *     state and redirects from GitHub cannot connect an account.
 * G05 Alice's connection never becomes Bob's credential. Two concurrent expired
 *     token resolves rotate once, and revocation requires reconnect without fallback.
 * G06 Configuration replacement and disconnect fence pending authorization.
 * G07 Installation auth takes precedence, uses signed JWT, requests only read
 *     access and caches until expiry. Invalid app credentials fail closed.
 * G08 Save and sanitized audit are atomic. Upstream errors never include secrets.
 * G09 A stale rejected credential must not invalidate a newly refreshed token.
 * G10 Disabled accounts and revoked sessions cannot complete an OAuth flow.
 * G11 A streamed oversized upstream body is rejected; request time is bounded.
 * G12 A 401 during commit comparison propagates source-auth failure, persists
 *     reconnect state, and a later check propagates the credential failure.
 * Evidence contains outcomes only, written to a private temporary directory.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hashSessionToken } from "@myskills-app/auth";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { createDb, createPgPool } from "../src/db/client.js";
import { GithubIntegrationService } from "../src/github/service.js";
import { PublicGithubSourceProvider } from "../src/libraries/github-source.js";
import { MemorySkillRepository } from "../src/repositories/memory-skill-repository.js";

test("GitHub integration journey: sessions, OAuth, rotation, installation and storage", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required");
  assert.match(new URL(databaseUrl).pathname, /test|ci/);
  const pool = createPgPool(databaseUrl);
  t.after(() => pool.end());
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    await pool.query(readFileSync(join(migrations, file), "utf8"));
  }
  const users = { admin: randomUUID(), alice: randomUUID(), bob: randomUUID() };
  const sessions = { admin: "a".repeat(48), nonMfa: "n".repeat(48), alice: "x".repeat(48), alice2: "y".repeat(48), bob: "z".repeat(48) };
  for (const [name, id] of Object.entries(users)) {
    await pool.query("INSERT INTO users(id,email,normalized_email,name,status,email_verified_at) VALUES($1,$2,$2,$3,'active',now())", [id, `${name}@example.test`, name]);
    await pool.query("INSERT INTO role_assignments(user_id,role) VALUES($1,$2)", [id, name === "admin" ? "owner" : "user"]);
  }
  for (const [name, token] of Object.entries(sessions)) {
    const userId = name === "nonMfa" ? users.admin : name === "alice2" ? users.alice : users[name as keyof typeof users];
    await pool.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,mfa_verified_at) VALUES($1,$2,now()+interval '1 day',$3)", [userId, hashSessionToken(token), name === "nonMfa" ? null : new Date()]);
  }
  const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const clientSecret = "github-client-test-value-never-echo";
  let nowMs = Date.now();
  let refreshCalls = 0;
  let installationCalls = 0;
  let failRefresh = false;
  let upstreamMode: "normal" | "redirect" | "oversized" | "unavailable" = "normal";
  let beforeExchange: (() => Promise<void>) | undefined;
  const exchanges: Record<string, string>[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal, "Network requests have a deadline");
    assert.ok(url.startsWith("https://api.github.com/") || url === "https://github.com/login/oauth/access_token");
    if (upstreamMode === "redirect") return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/" } });
    if (upstreamMode === "oversized") return new Response("x".repeat(300_000), { status: 200 });
    if (upstreamMode === "unavailable") return new Response(null, { status: 503 });
    if (url.endsWith("/login/oauth/access_token")) {
      await beforeExchange?.();
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      exchanges.push(body);
      if (body.grant_type === "refresh_token") {
        refreshCalls += 1;
        if (failRefresh) return Response.json({ error: "bad_refresh_token", error_description: clientSecret });
      }
      return Response.json({ access_token: `ghu_test_${exchanges.length}`, refresh_token: `ghr_test_${exchanges.length}`, token_type: "bearer", expires_in: 3600, refresh_token_expires_in: 86400 });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "alice-github" });
    if (url === "https://api.github.com/app") {
      const jwt = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      const [header, payload, signature] = jwt.split(".");
      assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), signingKeys.publicKey, Buffer.from(signature, "base64url")), true);
      assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
      assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { iat: Math.floor(nowMs / 1000) - 60, exp: Math.floor(nowMs / 1000) + 540, iss: "Iv1.test" });
      return Response.json({ id: 123, client_id: "Iv1.test", slug: "myskills-test" });
    }
    if (url === "https://api.github.com/app/installations/789") return Response.json({ id: 789, app_id: 123, target_type: "Organization", account: { login: "test-org" }, permissions: { contents: "read", metadata: "read" } });
    if (url === "https://api.github.com/app/installations/789/access_tokens") {
      installationCalls += 1;
      assert.deepEqual(JSON.parse(String(init?.body)), { permissions: { contents: "read", metadata: "read" } });
      // GitHub's stateless installation token format has periods and exceeds 512
      // bytes; it remains an opaque bearer credential to MySkills.
      return Response.json({ token: `ghs_123_eyJhbGciOiJSUzI1NiJ9.eyJpZCI6${installationCalls}fQ.${"s".repeat(900)}`, expires_at: new Date(nowMs + 3_600_000).toISOString(), permissions: { contents: "read", metadata: "read" } });
    }
    throw new Error("Unexpected upstream request");
  };
  const db = createDb(pool);
  const service = new GithubIntegrationService({ db, secret: "test-auth-secret-that-is-at-least-32-bytes", apiBaseUrl: "http://localhost:3100", webBaseUrl: "http://localhost:5173", transport, now: () => new Date(nowMs) });
  const app = buildApp({ skillRepository: new MemorySkillRepository([]), authService: new AuthService(new PostgresAuthStore(db), {}), githubService: service, allowedOrigins: ["http://localhost:5173"] });
  t.after(() => app.close());
  const request = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, token?: string, payload?: object) => app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload ? { payload } : {}) });
  const config = { enabled: true, appId: "123", clientId: "Iv1.test", clientSecret, privateKey, installationId: null, installationEnabled: false };
  assert.equal((await request("GET", "/v1/account/github")).statusCode, 401);
  const apiToken = await request("POST", "/v1/auth/api-tokens", sessions.admin, { name: "GitHub boundary", scopes: ["profile:read"] });
  assert.equal(apiToken.statusCode, 201, apiToken.body);
  const rejectedToken = await request("PUT", "/v1/admin/github", apiToken.json().token.token, config);
  assert.equal(rejectedToken.statusCode, 403);
  assert.equal(rejectedToken.json().error.code, "SESSION_AUTH_REQUIRED");
  assert.equal((await request("PUT", "/v1/admin/github", sessions.alice, config)).statusCode, 403);
  assert.equal((await request("PUT", "/v1/admin/github", sessions.nonMfa, config)).statusCode, 403);
  const { privateKey: _privateKey, ...userOnlyConfig } = config;
  const savedUserOnly = await request("PUT", "/v1/admin/github", sessions.admin, userOnlyConfig);
  assert.equal(savedUserOnly.statusCode, 200, savedUserOnly.body);
  assert.equal(savedUserOnly.json().github.hasPrivateKey, false);
  const userOnlyTest = await request("POST", "/v1/admin/github/test", sessions.admin);
  assert.equal(userOnlyTest.json().github.status, "configured", "An OAuth-only app is not claimed verified before a user authorizes it");
  const saved = await request("PUT", "/v1/admin/github", sessions.admin, config);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(!saved.body.includes(clientSecret) && !saved.body.includes(privateKey));
  // Delegated adapters preserve the real service's role/MFA checks and expose
  // safe metadata only. Credential configuration/linking stays session-only.
  const adminDelegate = await request("POST", "/v1/auth/api-tokens", sessions.admin, { name: "GitHub safe admin", scopes: ["admin:read", "admin:settings"] });
  assert.equal(adminDelegate.statusCode, 201, adminDelegate.body);
  for (const [method, url] of [["GET", "/v1/admin/github"], ["POST", "/v1/admin/github/test"]] as const) {
    const response = await request(method, url, adminDelegate.json().token.token);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(clientSecret) || response.body.includes(privateKey), false);
  }
  assert.equal((await request("PUT", "/v1/admin/github", adminDelegate.json().token.token, config)).statusCode, 403);
  const aliceDelegate = await request("POST", "/v1/auth/api-tokens", sessions.alice, { name: "GitHub account metadata", scopes: ["account:read", "account:connections:revoke"] });
  assert.equal(aliceDelegate.statusCode, 201, aliceDelegate.body);
  const aliceToken = aliceDelegate.json().token.token;
  assert.equal((await request("POST", "/v1/account/github/connect", aliceToken)).statusCode, 403);
  assert.equal((await request("GET", "/v1/admin/github", aliceToken)).statusCode, 403);
  const configBeforeAuditFailure = (await pool.query("SELECT generation,client_id FROM github_app_config")).rows[0];
  await pool.query("CREATE FUNCTION reject_github_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.github.update' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER github_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_github_audit()");
  const failedSave = await request("PUT", "/v1/admin/github", sessions.admin, { ...config, clientId: "Iv1.changed" });
  assert.equal(failedSave.statusCode, 500);
  assert.deepEqual((await pool.query("SELECT generation,client_id FROM github_app_config")).rows[0], configBeforeAuditFailure);
  await pool.query("DROP TRIGGER github_audit_failure ON audit_events; DROP FUNCTION reject_github_audit()");
  const begin = async (token = sessions.alice) => {
    const response = await request("POST", "/v1/account/github/connect", token);
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().authorizationUrl);
    assert.equal(url.origin, "https://github.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3100/v1/account/github/callback");
    return url;
  };
  const finish = (state: string, token = sessions.alice) => request("GET", `/v1/account/github/callback?state=${state}&code=fixture-code`, token);
  const initial = await begin();
  const state = initial.searchParams.get("state")!;
  assert.notEqual((await finish(state, sessions.bob)).headers.location, "http://localhost:5173/settings?github=connected");
  assert.notEqual((await finish(state, sessions.alice2)).headers.location, "http://localhost:5173/settings?github=connected");
  const connected = await finish(state);
  assert.equal(connected.headers.location, "http://localhost:5173/settings?github=connected");
  assert.equal(createHash("sha256").update(exchanges[0].code_verifier).digest("base64url"), initial.searchParams.get("code_challenge"));
  assert.notEqual((await finish(state)).headers.location, connected.headers.location);
  assert.equal((await request("GET", "/v1/account/github", sessions.alice)).json().github.login, "alice-github");
  assert.equal((await request("GET", "/v1/account/github", aliceToken)).json().github.login, "alice-github");
  assert.equal((await request("GET", "/v1/account/github", sessions.bob)).json().github.status, "disconnected");
  assert.equal((await service.resolve(users.bob)).kind, "anonymous");
  const old = await service.resolve(users.alice);
  const bobConnection = await begin(sessions.bob);
  assert.equal((await finish(bobConnection.searchParams.get("state")!, sessions.bob)).headers.location, connected.headers.location);
  const bobCredential = await service.resolve(users.bob);
  assert.equal(bobCredential.key, old.key, "Two MySkills connections to the same GitHub user share the quota bucket");
  assert.notEqual(bobCredential.token, old.token, "Each connection keeps its own token");
  const bobCipher = (await pool.query("SELECT access_ciphertext FROM github_user_connections WHERE user_id=$1", [users.bob])).rows[0].access_ciphertext;
  await pool.query("UPDATE github_user_connections SET access_ciphertext=(SELECT access_ciphertext FROM github_user_connections WHERE user_id=$1) WHERE user_id=$2", [users.alice, users.bob]);
  await assert.rejects(service.resolve(users.bob), { code: "GITHUB_CREDENTIAL_UNAVAILABLE" });
  await pool.query("UPDATE github_user_connections SET access_ciphertext=$1 WHERE user_id=$2", [bobCipher, users.bob]);
  nowMs += 3_700_000;
  const rotated = await Promise.all([service.resolve(users.alice), service.resolve(users.alice)]);
  assert.equal(refreshCalls, 1);
  assert.equal(rotated[0].token, rotated[1].token);
  await service.markInvalid(old);
  assert.equal((await service.resolve(users.alice)).token, rotated[0].token);
  const cipherRows = await pool.query("SELECT access_ciphertext,refresh_ciphertext FROM github_user_connections");
  assert.ok(!JSON.stringify(cipherRows.rows).includes("ghu_test_") && !JSON.stringify(cipherRows.rows).includes("ghr_test_"));
  failRefresh = true;
  nowMs += 3_700_000;
  await assert.rejects(service.resolve(users.alice), { code: "GITHUB_RECONNECT_REQUIRED" });
  assert.equal((await request("GET", "/v1/account/github", sessions.alice)).json().github.status, "reconnect_required");
  await assert.rejects(service.resolve(users.alice), { code: "GITHUB_RECONNECT_REQUIRED" });
  failRefresh = false;
  const beforeDisconnect = await begin();
  await request("DELETE", "/v1/account/github", sessions.alice);
  assert.notEqual((await finish(beforeDisconnect.searchParams.get("state")!)).headers.location, connected.headers.location);
  const beforeConfig = await begin();
  const installConfig = { ...config, installationEnabled: true, installationId: "789" };
  assert.equal((await request("PUT", "/v1/admin/github", sessions.admin, installConfig)).statusCode, 200);
  assert.notEqual((await finish(beforeConfig.searchParams.get("state")!)).headers.location, connected.headers.location);
  const checked = await request("POST", "/v1/admin/github/test", sessions.admin);
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().github.status, "connected");
  const installs = await Promise.all([service.resolve(users.alice), service.resolve(users.bob)]);
  assert.equal(installs[0].kind, "installation");
  assert.equal(installs[0].key, installs[1].key);
  assert.equal(installationCalls, 1);
  upstreamMode = "unavailable";
  const transientTest = await request("POST", "/v1/admin/github/test", sessions.admin);
  assert.equal(transientTest.json().github.lastErrorCode, "GITHUB_UPSTREAM_UNAVAILABLE");
  upstreamMode = "normal";
  assert.equal((await service.resolve(users.alice)).token, installs[0].token, "A transient admin connectivity check must preserve an existing installation credential");
  assert.equal(installationCalls, 1);
  await service.markInvalid(installs[0]);
  await assert.rejects(service.resolve(users.bob), { code: "GITHUB_APP_AUTH_FAILED" });
  const audit = await pool.query("SELECT details FROM audit_events WHERE action LIKE '%github%'");
  assert.ok(audit.rowCount! > 0);
  assert.ok(!JSON.stringify(audit.rows).includes(clientSecret) && !JSON.stringify(audit.rows).includes("ghu_") && !JSON.stringify(audit.rows).includes(privateKey));
  await request("PUT", "/v1/admin/github", sessions.admin, config);
  const expired = await begin();
  nowMs += 11 * 60_000;
  assert.notEqual((await finish(expired.searchParams.get("state")!)).headers.location, connected.headers.location);
  upstreamMode = "redirect";
  const redirected = await begin();
  assert.equal((await finish(redirected.searchParams.get("state")!)).headers.location, "http://localhost:5173/settings?github=error");
  upstreamMode = "oversized";
  const oversized = await begin();
  assert.equal((await finish(oversized.searchParams.get("state")!)).headers.location, "http://localhost:5173/settings?github=error");
  upstreamMode = "normal";
  const beforeCompare = await begin();
  assert.equal((await finish(beforeCompare.searchParams.get("state")!)).headers.location, connected.headers.location);
  const compareProvider = new PublicGithubSourceProvider({ credentials: service, transport: { get: async (outbound) => {
    assert.ok(outbound.headers.authorization?.startsWith("Bearer ghu_"));
    assert.match(outbound.url.pathname, /\/compare\//);
    return { status: 401, headers: {}, body: Buffer.from("{}") };
  } } });
  const compareRepo = { id: "99", fullName: "acme/public-skills", owner: "acme", name: "public-skills", htmlUrl: "https://github.com/acme/public-skills", defaultBranch: "main", private: false, archived: false, licenseSpdx: "MIT" };
  const compareContext = { userId: users.alice, deadline: Date.now() + 60_000 };
  await assert.rejects(compareProvider.compareCommits(compareRepo, "a".repeat(40), "b".repeat(40), compareContext), { code: "SOURCE_AUTH_REQUIRED" });
  assert.equal((await request("GET", "/v1/account/github", sessions.alice)).json().github.status, "reconnect_required");
  await assert.rejects(compareProvider.compareCommits(compareRepo, "a".repeat(40), "b".repeat(40), compareContext), { code: "GITHUB_RECONNECT_REQUIRED" });
  const revokedDuringExchange = await begin(sessions.alice2);
  beforeExchange = async () => { await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1", [hashSessionToken(sessions.alice2)]); };
  assert.equal((await finish(revokedDuringExchange.searchParams.get("state")!, sessions.alice2)).headers.location, "http://localhost:5173/settings?github=error");
  beforeExchange = undefined;
  const disabledDuringExchange = await begin();
  beforeExchange = async () => { await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [users.alice]); };
  assert.equal((await finish(disabledDuringExchange.searchParams.get("state")!)).headers.location, "http://localhost:5173/settings?github=error");
  beforeExchange = undefined;
  await pool.query("UPDATE users SET status='active' WHERE id=$1", [users.alice]);
  const revoked = await begin();
  await pool.query("UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1", [hashSessionToken(sessions.alice)]);
  assert.notEqual((await finish(revoked.searchParams.get("state")!)).headers.location, connected.headers.location);
  const evidencePath = join(mkdtempSync(join(tmpdir(), "myskills-github-journey-")), "evidence.json");
  writeFileSync(evidencePath, JSON.stringify({ outcome: "pass", covered: ["G01", "G02", "G03", "G04", "G05", "G06", "G07 stateless installation credentials", "G08 atomicity/sanitization", "G09", "G10 session revocation and account disabling during exchange", "G11 size/deadline present", "G12 source compare authentication propagation"] }, null, 2), { mode: 0o600 });
  t.diagnostic(`Evidence: ${evidencePath}`);
});
