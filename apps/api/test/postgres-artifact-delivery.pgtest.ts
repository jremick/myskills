import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createApiToken, createSessionToken, hashApiToken, hashSessionToken } from "@myskills-app/auth";
import { createDb, createPgPool } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { users, teams, teamMemberships, skills, skillVersions, skillTeamGrants, skillArtifacts, skillPlatformVariants } from "../src/db/schema.js";
import { AuthService } from "../src/auth/service.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth-store.js";
import { PostgresSkillRepository } from "../src/repositories/postgres-skill-repository.js";
import { PostgresSubmissionStore } from "../src/submissions/postgres-submission-store.js";
import { SubmissionService } from "../src/submissions/service.js";
import { MemoryArtifactObjectStorage } from "../src/artifacts/storage.js";
import { buildApp } from "../src/app.js";

test("Postgres artifact delivery fences stale credentials and post-storage policy changes in one snapshot", { timeout: 120_000 }, async (t) => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  assert.match(new URL(databaseUrl).pathname, /(^|[_/-])(test|ci)([_/-]|$)/i);
  const observer = createPgPool(databaseUrl);
  t.after(() => observer.end());
  await observer.query("DROP SCHEMA IF EXISTS public CASCADE");
  await observer.query("CREATE SCHEMA public");
  await runMigrations(observer);
  const workerName = `artifact-delivery-${randomUUID()}`;
  const workerUrl = new URL(databaseUrl);
  workerUrl.searchParams.set("application_name", workerName);
  const pool = createPgPool(workerUrl.href);
  t.after(() => pool.end());
  const db = createDb(pool);
  const fixture = async (context: TestContext) => {
    await observer.query("DELETE FROM instance_settings WHERE key = 'sharing'");
    const id = randomUUID();
    const [owner, reader] = await db.insert(users).values(["owner", "reader"].map((role) => ({
      email: `${role}-${id}@example.test`, normalizedEmail: `${role}-${id}@example.test`, status: "active" as const, emailVerifiedAt: new Date(),
    }))).returning();
    assert.ok(owner && reader);
    const [team] = await db.insert(teams).values({ name: "Delivery team", slug: `delivery-${id}`, createdByUserId: owner.id }).returning();
    assert.ok(team);
    await db.insert(teamMemberships).values({ teamId: team.id, userId: reader.id });
    const slug = `delivery-${id}`;
    const [skill] = await db.insert(skills).values({ slug, title: "Delivery fixture", summary: "Synthetic fixture.", ownerUserId: owner.id, lifecycleStatus: "approved", visibility: "team" }).returning();
    assert.ok(skill);
    await db.insert(skillTeamGrants).values({ skillId: skill.id, teamId: team.id });
    const [release] = await db.insert(skillVersions).values({ skillId: skill.id, version: "1.0.0", lifecycleStatus: "approved", reviewStatus: "approved", securityStatus: "passed", publishedAt: new Date() }).returning();
    assert.ok(release);
    await db.insert(skillPlatformVariants).values({ skillVersionId: release.id, name: "codex", installTarget: "codex-skill", status: "supported" });
    const payload = { files: [{ path: "SKILL.md", content: "Synthetic protected package bytes." }] };
    const body = JSON.stringify(payload);
    const artifact = { sha256: createHash("sha256").update(body).digest("hex"), byteSize: Buffer.byteLength(body), contentType: "application/vnd.myskills-app.package+json" };
    const key = `delivery/${id}`;
    await db.insert(skillArtifacts).values({ ...artifact, skillVersionId: release.id, storageKey: key, payload: { files: [] } });
    const storage = new MemoryArtifactObjectStorage();
    await storage.putObject({ key, body, contentType: artifact.contentType, sha256: artifact.sha256 });
    const authStore = new PostgresAuthStore(db);
    const token = createApiToken();
    const tokenRecord = await authStore.createApiToken({ userId: reader.id, name: "Delivery fixture", tokenHash: hashApiToken(token), tokenPrefix: token.slice(0, 12), scopes: ["skills:read"], expiresAt: new Date(Date.now() + 3_600_000) });
    const auth = new AuthService(authStore);
    const store = new PostgresSubmissionStore(db, { artifactStorage: storage });
    const app = buildApp({ authService: auth, skillRepository: new PostgresSkillRepository(db), submissionService: new SubmissionService(store) });
    context.after(() => app.close());
    const request = () => app.inject({ url: `/v1/skills/${slug}/releases/1.0.0/bundle?platform=codex&sha256=${artifact.sha256}`, headers: { authorization: `Bearer ${token}` } });
    return { auth, authStore, token, tokenRecord, reader, team, release, artifact, body, key, slug, storage, store, request };
  };

  await t.test("exact bytes pass and the production gate performs no later usage UPDATE", async (context) => {
    const f = await fixture(context);
    const response = await f.request();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body, f.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-myskills-artifact-sha256"], f.artifact.sha256);
    assert.equal(Number(response.headers["content-length"]), f.artifact.byteSize);
    const stale = await f.auth.authenticateRequest(`Bearer ${f.token}`);
    assert.ok(stale);
    context.mock.method(f.auth, "authenticateRequest", async () => stale);
    const read = f.storage.getObject.bind(f.storage);
    const blocker = await observer.connect();
    try {
      // Any credential touch after storage would block behind this real lock.
      context.mock.method(f.storage, "getObject", async (...args: Parameters<typeof read>) => {
        const object = await read(...args);
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE", [f.tokenRecord.id]);
        return object;
      });
      assert.equal((await f.request()).statusCode, 200);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  for (const change of ["token", "account", "scope", "membership", "policy", "lifecycle", "digest", "size", "content-type"] as const) {
    await t.test(`committed ${change} change after object read denies even with stale authentication`, async (context) => {
      const f = await fixture(context);
      const stale = await f.auth.authenticateRequest(`Bearer ${f.token}`);
      assert.ok(stale);
      // Model the auth store's earlier SELECT result surviving a later usage
      // UPDATE. Only the real PostgreSQL delivery decision may authorize bytes.
      context.mock.method(f.auth, "authenticateRequest", async () => stale);
      const read = f.storage.getObject.bind(f.storage);
      context.mock.method(f.storage, "getObject", async (...args: Parameters<typeof read>) => {
        const object = await read(...args);
        if (change === "token") await observer.query("UPDATE api_tokens SET revoked_at = clock_timestamp() WHERE id = $1", [f.tokenRecord.id]);
        if (change === "account") await observer.query("UPDATE users SET status = 'disabled' WHERE id = $1", [f.reader.id]);
        if (change === "scope") await observer.query("UPDATE api_tokens SET scopes = '[\"architectures:read\"]'::jsonb WHERE id = $1", [f.tokenRecord.id]);
        if (change === "membership") await observer.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [f.team.id, f.reader.id]);
        if (change === "policy") await observer.query("INSERT INTO instance_settings (key, value) VALUES ('sharing', '{\"teamVisibilityEnabled\":false}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
        if (change === "lifecycle") await observer.query("UPDATE skill_versions SET lifecycle_status = 'revoked' WHERE id = $1", [f.release.id]);
        if (change === "digest") await observer.query("UPDATE skill_artifacts SET sha256 = $1 WHERE skill_version_id = $2", ["0".repeat(64), f.release.id]);
        if (change === "size") await observer.query("UPDATE skill_artifacts SET byte_size = byte_size + 1 WHERE skill_version_id = $1", [f.release.id]);
        if (change === "content-type") await observer.query("UPDATE skill_artifacts SET content_type = 'application/json' WHERE skill_version_id = $1", [f.release.id]);
        return object;
      });
      const response = await f.request();
      assert.equal(response.statusCode, change === "token" || change === "account" ? 401 : change === "scope" ? 403 : ["digest", "size", "content-type"].includes(change) ? 409 : 404, response.body);
      assert.equal(response.body.includes("Synthetic protected package bytes."), false);
      assert.equal(response.headers["cache-control"], "no-store");
    });
  }

  await t.test("revocation between the credential SELECT and usage UPDATE cannot authorize bytes", async (context) => {
    const f = await fixture(context);
    const blocker = await observer.connect();
    let staleRead: ReturnType<PostgresAuthStore["findUserByApiTokenHash"]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM api_tokens WHERE id = $1 FOR UPDATE", [f.tokenRecord.id]);
      staleRead = f.authStore.findUserByApiTokenHash(hashApiToken(f.token));
      const deadline = Date.now() + 5_000;
      while (true) {
        if ((await observer.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [workerName])).rowCount) break;
        assert.ok(Date.now() < deadline, "credential usage UPDATE must wait on the token lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocker.query("UPDATE api_tokens SET revoked_at = clock_timestamp() WHERE id = $1", [f.tokenRecord.id]);
      await blocker.query("COMMIT");
      const stale = await staleRead;
      assert.ok(stale, "fixture reproduces the inherited auth snapshot race");
      context.mock.method(f.auth, "authenticateRequest", async () => ({ user: { ...stale, mfaVerified: false, mfaEnabled: false }, credential: { kind: "api_token", tokenId: stale.apiTokenId, scopes: stale.apiTokenScopes } }));
      const response = await f.request();
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.body.includes("Synthetic protected package bytes."), false);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); if (staleRead) await Promise.allSettled([staleRead]); }
  });

  await t.test("snapshot gate rechecks session and OAuth token/grant identity, expiry, scopes and revocation", async (context) => {
    const f = await fixture(context);
    const input = { slug: f.slug, version: "1.0.0", actorId: f.reader.id };
    const sessionHash = hashSessionToken(createSessionToken());
    await f.authStore.createSession({ userId: f.reader.id, tokenHash: sessionHash, expiresAt: new Date(Date.now() + 3_600_000) });
    const session = { ...input, credential: { kind: "session" as const, tokenHash: sessionHash } };
    assert.equal((await f.store.authorizeArtifactDelivery(session))?.artifact.sha256, f.artifact.sha256);
    await f.authStore.revokeSessionByTokenHash(sessionHash);
    await assert.rejects(f.store.authorizeArtifactDelivery(session), { code: "AUTHENTICATION_REQUIRED" });
    const oauthHash = hashSessionToken("synthetic-oauth-access-token");
    const resource = "https://fixture.example.test/mcp";
    const grant = await observer.query<{ id: string }>(`INSERT INTO oauth_grants
      (user_id, client_id, client_name, client_registration, scopes, resource, created_at, expires_at)
      VALUES ($1, 'fixture-client', 'Fixture client', 'configured', '["skills:read"]'::jsonb, $2, clock_timestamp(), clock_timestamp() + interval '1 hour') RETURNING id`, [f.reader.id, resource]);
    await observer.query(`INSERT INTO oauth_access_tokens (token_hash, grant_id, scopes, created_at, expires_at)
      VALUES ($1, $2, '["skills:read"]'::jsonb, clock_timestamp(), clock_timestamp() + interval '1 hour')`, [oauthHash, grant.rows[0]!.id]);
    const oauth = { ...input, credential: { kind: "oauth" as const, tokenHash: oauthHash, resource, clientId: "fixture-client" } };
    assert.equal((await f.store.authorizeArtifactDelivery(oauth))?.artifact.sha256, f.artifact.sha256);
    await assert.rejects(f.store.authorizeArtifactDelivery({ ...oauth, credential: { ...oauth.credential, resource: "https://other.example.test/mcp" } }), { code: "AUTHENTICATION_REQUIRED" });
    await observer.query("UPDATE oauth_access_tokens SET scopes = '[]'::jsonb WHERE token_hash = $1", [oauthHash]);
    await assert.rejects(f.store.authorizeArtifactDelivery(oauth), { code: "API_TOKEN_SCOPE_REQUIRED" });
    await observer.query("UPDATE oauth_access_tokens SET scopes = '[\"skills:read\"]'::jsonb, expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1", [oauthHash]);
    await assert.rejects(f.store.authorizeArtifactDelivery(oauth), { code: "AUTHENTICATION_REQUIRED" });
    await observer.query("UPDATE oauth_access_tokens SET expires_at = clock_timestamp() + interval '1 hour' WHERE token_hash = $1", [oauthHash]);
    await observer.query("UPDATE oauth_grants SET revoked_at = clock_timestamp(), revoked_reason = 'user' WHERE id = $1", [grant.rows[0]!.id]);
    await assert.rejects(f.store.authorizeArtifactDelivery(oauth), { code: "AUTHENTICATION_REQUIRED" });
  });

  await t.test("credential and membership reads cannot combine two separately unauthorized database states", async (context) => {
    const f = await fixture(context);
    await observer.query("DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2", [f.team.id, f.reader.id]);
    let credentialSelected!: () => void;
    let resume!: () => void;
    const selected = new Promise<void>((resolve) => { credentialSelected = resolve; });
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const transaction = db.transaction.bind(db);
    context.mock.method(db, "transaction", async (callback: Parameters<typeof db.transaction>[0], options: Parameters<typeof db.transaction>[1]) => transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      let first = true;
      context.mock.method(tx, "execute", async (...args: Parameters<typeof tx.execute>) => {
        const result = await execute(...args);
        if (first) {
          first = false;
          credentialSelected();
          await barrier(resumed);
        }
        return result;
      });
      return callback(tx);
    }, options));
    const decision = f.store.authorizeArtifactDelivery({ slug: f.slug, version: "1.0.0", actorId: f.reader.id,
      credential: { kind: "api_token", tokenHash: hashApiToken(f.token) } });
    // State A has a live credential but no membership. State B has membership
    // but a revoked credential. READ COMMITTED would combine A's credential
    // with B's membership and authorize a state that never existed.
    try {
      await barrier(selected);
      const mutation = await observer.connect();
      try {
        await mutation.query("BEGIN");
        await mutation.query("UPDATE api_tokens SET revoked_at = clock_timestamp() WHERE id = $1", [f.tokenRecord.id]);
        await mutation.query("INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2)", [f.team.id, f.reader.id]);
        await mutation.query("COMMIT");
      } finally { await mutation.query("ROLLBACK"); mutation.release(); }
      resume();
      assert.equal(await decision, null);
    } finally { resume(); await Promise.allSettled([decision]); }
  });
});

async function barrier(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Postgres snapshot barrier timed out.")), 5_000); })]);
  } finally { clearTimeout(timer); }
}
