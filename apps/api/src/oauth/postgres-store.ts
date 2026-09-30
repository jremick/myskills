import { sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../db/client.js";
import {
  OAUTH_SCOPES,
  OAUTH_ASSURANCE_WINDOW_MS,
  type DecideAuthorizationOutcome,
  type OAuthAccessTokenRecord,
  type OAuthAuthorizationCodeRecord,
  type OAuthAuthorizationRequestRecord,
  type OAuthClientAuthMethod,
  type OAuthClientRecord,
  type OAuthGrantRecord,
  type OAuthGrantRevocationReason,
  type OAuthRefreshTokenRecord,
  type OAuthScope,
  type OAuthStore,
  type RedeemCodeOutcome,
  type RotateRefreshOutcome,
} from "./types.js";

type Executor = Database | DatabaseTransaction;
type Row = Record<string, unknown>;

const CLEANUP_BATCH = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Postgres connector authorization. Single-use transitions lock the row they
 * consume, and grant issuance serializes per account so the connection cap
 * holds under concurrent redemption.
 */
export class PostgresOAuthStore implements OAuthStore {
  constructor(private readonly db: Database) {}

  async createDynamicClient(input: Parameters<OAuthStore["createDynamicClient"]>[0]): Promise<OAuthClientRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('myskills-oauth-client-registration'))`);
      const count = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM oauth_clients`);
      if ((count.rows[0]?.count ?? 0) >= input.maxClients) return null;
      const inserted = await tx.execute<Row>(sql`
        INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash, created_at)
        VALUES (${input.client.clientId}, ${input.client.clientName}, ${JSON.stringify(input.client.redirectUris)}::jsonb,
          ${input.client.tokenEndpointAuthMethod}, ${input.client.clientSecretHash}, ${input.now})
        RETURNING *
      `);
      return toClient(inserted.rows[0]!);
    });
  }

  async findDynamicClient(clientId: string): Promise<OAuthClientRecord | null> {
    const result = await this.db.execute<Row>(sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`);
    return result.rows[0] ? toClient(result.rows[0]) : null;
  }

  async createAuthorizationRequest(input: Parameters<OAuthStore["createAuthorizationRequest"]>[0]): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO oauth_authorization_requests (handle_hash, client_id, redirect_uri, scopes, resource, state, code_challenge, created_at, expires_at)
      VALUES (${input.handleHash}, ${input.clientId}, ${input.redirectUri}, ${JSON.stringify(input.scopes)}::jsonb,
        ${input.resource}, ${input.state}, ${input.codeChallenge}, ${input.now}, ${input.expiresAt})
    `);
  }

  async findAuthorizationRequest(handleHash: string): Promise<OAuthAuthorizationRequestRecord | null> {
    const result = await this.db.execute<Row>(sql`SELECT * FROM oauth_authorization_requests WHERE handle_hash = ${handleHash}`);
    return result.rows[0] ? toRequest(result.rows[0]) : null;
  }

  async decideAuthorizationRequest(input: Parameters<OAuthStore["decideAuthorizationRequest"]>[0]): Promise<DecideAuthorizationOutcome> {
    if (!UUID_PATTERN.test(input.userId)) return { outcome: "session_revoked" };
    return this.db.transaction(async (tx): Promise<DecideAuthorizationOutcome> => {
      // Account before request and code, as in the auth store's revocation paths.
      if (!await lockUsableAccount(tx, input.userId)) return { outcome: "session_revoked" };
      const session = await tx.execute<Row>(sql`
        SELECT mfa_verified_at FROM auth_sessions
        WHERE token_hash = ${input.sessionTokenHash} AND user_id = ${input.userId} AND revoked_at IS NULL AND expires_at > ${input.now}
        FOR UPDATE
      `);
      if (session.rows.length === 0) return { outcome: "session_revoked" };
      const locked = await tx.execute<Row>(sql`SELECT * FROM oauth_authorization_requests WHERE handle_hash = ${input.handleHash} FOR UPDATE`);
      const row = locked.rows[0];
      if (!row) return { outcome: "not_found" };
      const request = toRequest(row);
      if (request.status !== "pending") return { outcome: "already_decided" };
      if (request.expiresAt <= input.now) return { outcome: "expired" };
      const stamp = toNullableDate(session.rows[0]!.mfa_verified_at);
      const mfaVerifiedAt = stamp && Number.isFinite(stamp.getTime()) && stamp <= input.now ? stamp : null;
      const assuranceExpiresAt = mfaVerifiedAt ? new Date(mfaVerifiedAt.getTime() + OAUTH_ASSURANCE_WINDOW_MS) : null;
      if (input.decision === "approve" && ((input.requireMfa && !mfaVerifiedAt)
        || (input.requireFreshMfa && (!assuranceExpiresAt || assuranceExpiresAt <= input.now)))) {
        return { outcome: "mfa_required" };
      }
      if (input.decision === "approve" && await countActiveGrants(tx, input.userId, input.now) >= input.maxActiveGrantsPerUser) {
        return { outcome: "connection_limit" };
      }
      const status = input.decision === "approve" ? "approved" : "denied";
      const updated = await tx.execute<Row>(sql`
        UPDATE oauth_authorization_requests SET status = ${status}, user_id = ${input.userId}, decided_at = ${input.now}
        WHERE id = ${request.id} RETURNING *
      `);
      if (input.decision === "approve" && input.code) {
        await tx.execute(sql`
          INSERT INTO oauth_authorization_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, scopes, created_at, expires_at, mfa_verified_at, assurance_expires_at)
          VALUES (${input.code.codeHash}, ${input.userId}, ${request.clientId}, ${request.redirectUri}, ${request.codeChallenge},
            ${request.resource}, ${JSON.stringify(request.scopes)}::jsonb, ${input.now}, ${input.code.expiresAt}, ${mfaVerifiedAt}, ${assuranceExpiresAt})
        `);
      }
      return { outcome: "decided", request: toRequest(updated.rows[0]!) };
    });
  }

  async redeemAuthorizationCode(input: Parameters<OAuthStore["redeemAuthorizationCode"]>[0]): Promise<RedeemCodeOutcome> {
    return this.db.transaction(async (tx): Promise<RedeemCodeOutcome> => {
      // Lock order matches the auth store: account first, then the code. The
      // grant insert's foreign-key lock on users is then already held, so an
      // overlapping password, MFA, role or status revocation cannot deadlock.
      const owner = await tx.execute<{ user_id: string }>(sql`SELECT user_id FROM oauth_authorization_codes WHERE code_hash = ${input.codeHash}`);
      const userId = owner.rows[0]?.user_id;
      if (!userId) return { outcome: "invalid" } as const;
      const usable = await lockUsableAccount(tx, userId);
      // The account lock also makes a concurrent replay wait for the winner to
      // commit, then observe its grant and revoke it.
      const locked = await tx.execute<Row>(sql`SELECT * FROM oauth_authorization_codes WHERE code_hash = ${input.codeHash} FOR UPDATE`);
      const row = locked.rows[0];
      if (!row || row.revoked_at || row.user_id !== userId) return { outcome: "invalid" } as const;
      if (row.consumed_at) {
        await tx.execute(sql`UPDATE oauth_authorization_codes SET replayed_at = coalesce(replayed_at, ${input.now}) WHERE id = ${row.id}`);
        if (!row.grant_id) return { outcome: "replayed", revokedGrant: null } as const;
        const revoked = await tx.execute<Row>(sql`
          UPDATE oauth_grants SET revoked_at = ${input.now}, revoked_reason = 'code_replay'
          WHERE id = ${row.grant_id} AND revoked_at IS NULL RETURNING *
        `);
        return { outcome: "replayed", revokedGrant: revoked.rows[0] ? toGrant(revoked.rows[0]) : null } as const;
      }
      await tx.execute(sql`UPDATE oauth_authorization_codes SET consumed_at = ${input.now} WHERE id = ${row.id}`);
      const code = toCode(row);
      if (!input.verify(code)) return { outcome: "rejected" } as const;
      if (!usable) return { outcome: "invalid" } as const;
      if (await countActiveGrants(tx, code.userId, input.now) >= input.maxActiveGrantsPerUser) return { outcome: "connection_limit" } as const;
      const issued = input.issue(code);
      const grantRow = await tx.execute<Row>(sql`
        INSERT INTO oauth_grants (user_id, client_id, client_name, client_registration, scopes, resource, created_at, expires_at, mfa_verified_at, assurance_expires_at)
        VALUES (${issued.grant.userId}, ${issued.grant.clientId}, ${issued.grant.clientName}, ${issued.grant.registration},
          ${JSON.stringify(issued.grant.scopes)}::jsonb, ${issued.grant.resource}, ${issued.grant.createdAt}, ${issued.grant.expiresAt}, ${code.mfaVerifiedAt}, ${code.assuranceExpiresAt})
        RETURNING *
      `);
      const grant = toGrant(grantRow.rows[0]!);
      await insertTokenPair(tx, grant.id, input.now, issued.accessToken, issued.refreshToken);
      await tx.execute(sql`UPDATE oauth_authorization_codes SET grant_id = ${grant.id} WHERE id = ${row.id}`);
      return { outcome: "issued", grant, code } as const;
    });
  }

  async findAccessToken(tokenHash: string): Promise<{ token: OAuthAccessTokenRecord; grant: OAuthGrantRecord } | null> {
    const result = await this.db.execute<Row>(sql`
      SELECT t.id AS token_id, t.grant_id AS token_grant_id, t.scopes AS token_scopes, t.expires_at AS token_expires_at,
        t.revoked_at AS token_revoked_at, g.*
      FROM oauth_access_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ${tokenHash}
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      token: {
        id: String(row.token_id),
        grantId: String(row.token_grant_id),
        scopes: toScopes(row.token_scopes),
        expiresAt: toDate(row.token_expires_at),
        revokedAt: toNullableDate(row.token_revoked_at),
      },
      grant: toGrant(row),
    };
  }

  async findRefreshToken(tokenHash: string): Promise<{ token: OAuthRefreshTokenRecord; grant: OAuthGrantRecord } | null> {
    const result = await this.db.execute<Row>(sql`
      SELECT t.id AS token_id, t.grant_id AS token_grant_id, t.expires_at AS token_expires_at, t.used_at AS token_used_at,
        t.revoked_at AS token_revoked_at, g.*
      FROM oauth_refresh_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = ${tokenHash}
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      token: {
        id: String(row.token_id),
        grantId: String(row.token_grant_id),
        expiresAt: toDate(row.token_expires_at),
        usedAt: toNullableDate(row.token_used_at),
        revokedAt: toNullableDate(row.token_revoked_at),
      },
      grant: toGrant(row),
    };
  }

  async rotateRefreshToken(input: Parameters<OAuthStore["rotateRefreshToken"]>[0]): Promise<RotateRefreshOutcome> {
    return this.db.transaction(async (tx): Promise<RotateRefreshOutcome> => {
      const locked = await tx.execute<Row>(sql`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ${input.tokenHash} FOR UPDATE`);
      const token = locked.rows[0];
      if (!token) return { outcome: "invalid" } as const;
      if (token.used_at) return { outcome: "reused", grantId: String(token.grant_id) } as const;
      const grantResult = await tx.execute<Row>(sql`SELECT * FROM oauth_grants WHERE id = ${token.grant_id} FOR SHARE`);
      const grantRow = grantResult.rows[0];
      if (!grantRow || token.revoked_at || toDate(token.expires_at) <= input.now || grantRow.revoked_at || toDate(grantRow.expires_at) <= input.now) {
        return { outcome: "invalid" } as const;
      }
      await tx.execute(sql`UPDATE oauth_refresh_tokens SET used_at = ${input.now} WHERE id = ${token.id}`);
      const grant = toGrant(grantRow);
      await insertTokenPair(tx, grant.id, input.now, input.accessToken, input.refreshToken);
      return { outcome: "rotated", grant } as const;
    });
  }

  async touchGrant(input: { grantId: string; now: Date }): Promise<void> {
    if (!UUID_PATTERN.test(input.grantId)) return;
    await this.db.execute(sql`UPDATE oauth_grants SET last_used_at = ${input.now} WHERE id = ${input.grantId} AND revoked_at IS NULL`);
  }

  async revokeGrant(input: { grantId: string; reason: OAuthGrantRevocationReason; now: Date; userId?: string; clientId?: string }): Promise<OAuthGrantRecord | null> {
    if (!UUID_PATTERN.test(input.grantId)) return null;
    const result = await this.db.execute<Row>(sql`
      UPDATE oauth_grants SET revoked_at = ${input.now}, revoked_reason = ${input.reason}
      WHERE id = ${input.grantId} AND revoked_at IS NULL
        ${input.userId ? sql`AND user_id = ${input.userId}` : sql``}
        ${input.clientId ? sql`AND client_id = ${input.clientId}` : sql``}
      RETURNING *
    `);
    return result.rows[0] ? toGrant(result.rows[0]) : null;
  }

  async revokeAccessToken(input: { tokenHash: string; clientId: string; now: Date }): Promise<boolean> {
    const result = await this.db.execute<Row>(sql`
      UPDATE oauth_access_tokens t SET revoked_at = ${input.now}
      FROM oauth_grants g
      WHERE t.grant_id = g.id AND t.token_hash = ${input.tokenHash} AND g.client_id = ${input.clientId} AND t.revoked_at IS NULL
      RETURNING t.id
    `);
    return result.rows.length > 0;
  }

  async listActiveGrants(input: { userId: string; now: Date }): Promise<OAuthGrantRecord[]> {
    if (!UUID_PATTERN.test(input.userId)) return [];
    const result = await this.db.execute<Row>(sql`
      SELECT * FROM oauth_grants
      WHERE user_id = ${input.userId} AND revoked_at IS NULL AND expires_at > ${input.now}
      ORDER BY created_at DESC, id DESC
      LIMIT 200
    `);
    return result.rows.map(toGrant);
  }

  async cleanup(now: Date): Promise<void> {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await this.db.execute(sql`
      DELETE FROM oauth_authorization_requests WHERE id IN (
        SELECT id FROM oauth_authorization_requests
        WHERE expires_at <= ${dayAgo} OR (status = 'pending' AND expires_at <= ${now}) LIMIT ${CLEANUP_BATCH})
    `);
    await this.db.execute(sql`
      DELETE FROM oauth_authorization_codes WHERE id IN (
        SELECT id FROM oauth_authorization_codes
        WHERE expires_at <= ${now} AND (consumed_at IS NULL OR expires_at <= ${dayAgo}) LIMIT ${CLEANUP_BATCH})
    `);
    await this.db.execute(sql`DELETE FROM oauth_access_tokens WHERE id IN (SELECT id FROM oauth_access_tokens WHERE expires_at <= ${now} LIMIT ${CLEANUP_BATCH})`);
    await this.db.execute(sql`DELETE FROM oauth_refresh_tokens WHERE id IN (SELECT id FROM oauth_refresh_tokens WHERE expires_at <= ${now} LIMIT ${CLEANUP_BATCH})`);
    await this.db.execute(sql`
      DELETE FROM oauth_grants WHERE id IN (
        SELECT id FROM oauth_grants WHERE revoked_at <= ${monthAgo} OR expires_at <= ${monthAgo} LIMIT ${CLEANUP_BATCH})
    `);
    await this.db.execute(sql`
      DELETE FROM oauth_clients c WHERE c.client_id IN (
        SELECT client_id FROM oauth_clients
        WHERE created_at <= ${dayAgo}
          AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
          AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes a WHERE a.client_id = oauth_clients.client_id AND a.consumed_at IS NULL AND a.expires_at > ${now})
        LIMIT ${CLEANUP_BATCH})
    `);
  }
}

/**
 * Account-level revocation for connector authority, run inside the auth
 * store's credential-revocation transaction. It takes the account row lock
 * first (a no-op when the caller already holds it), so consent decisions and
 * code redemption, which lock the account first too, are fully ordered with
 * revocation: each either commits before it, and its code or grant is revoked
 * here, or runs after it and sees the revoked session or account.
 */
export async function revokeConnectorAuthority(db: Executor, userId: string, revokedAt: Date): Promise<void> {
  await db.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  await db.execute(sql`
    UPDATE oauth_authorization_codes SET revoked_at = ${revokedAt}
    WHERE user_id = ${userId} AND consumed_at IS NULL AND revoked_at IS NULL
  `);
  await db.execute(sql`
    UPDATE oauth_grants SET revoked_at = ${revokedAt}, revoked_reason = 'account'
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `);
}

/** Locks the account row and reports whether it may authorize connectors. */
async function lockUsableAccount(tx: Executor, userId: string): Promise<boolean> {
  const result = await tx.execute<{ status: string; email_verified_at: unknown }>(sql`
    SELECT status, email_verified_at FROM users WHERE id = ${userId} FOR UPDATE
  `);
  const row = result.rows[0];
  return Boolean(row && row.status === "active" && row.email_verified_at);
}

async function countActiveGrants(tx: Executor, userId: string, now: Date): Promise<number> {
  const result = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM oauth_grants WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now}
  `);
  return result.rows[0]?.count ?? 0;
}

async function insertTokenPair(
  tx: Executor,
  grantId: string,
  now: Date,
  accessToken: { tokenHash: string; expiresAt: Date; scopes: OAuthScope[] },
  refreshToken: { tokenHash: string; expiresAt: Date },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO oauth_access_tokens (token_hash, grant_id, scopes, created_at, expires_at)
    VALUES (${accessToken.tokenHash}, ${grantId}, ${JSON.stringify(accessToken.scopes)}::jsonb, ${now}, ${accessToken.expiresAt})
  `);
  await tx.execute(sql`
    INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at)
    VALUES (${refreshToken.tokenHash}, ${grantId}, ${now}, ${refreshToken.expiresAt})
  `);
}

function toClient(row: Row): OAuthClientRecord {
  return {
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    redirectUris: Array.isArray(row.redirect_uris) ? row.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [],
    tokenEndpointAuthMethod: String(row.token_endpoint_auth_method) as OAuthClientAuthMethod,
    clientSecretHash: typeof row.client_secret_hash === "string" ? row.client_secret_hash : null,
    registration: "dynamic",
    createdAt: toDate(row.created_at),
  };
}

function toRequest(row: Row): OAuthAuthorizationRequestRecord {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    scopes: toScopes(row.scopes),
    resource: String(row.resource),
    state: typeof row.state === "string" ? row.state : null,
    codeChallenge: String(row.code_challenge),
    status: row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : "pending",
    userId: typeof row.user_id === "string" ? row.user_id : null,
    createdAt: toDate(row.created_at),
    expiresAt: toDate(row.expires_at),
  };
}

function toCode(row: Row): OAuthAuthorizationCodeRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    resource: String(row.resource),
    scopes: toScopes(row.scopes),
    expiresAt: toDate(row.expires_at),
    mfaVerifiedAt: toNullableDate(row.mfa_verified_at),
    assuranceExpiresAt: toNullableDate(row.assurance_expires_at),
  };
}

function toGrant(row: Row): OAuthGrantRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    clientId: String(row.client_id),
    clientName: String(row.client_name),
    registration: row.client_registration === "configured" ? "configured" : "dynamic",
    scopes: toScopes(row.scopes),
    resource: String(row.resource),
    createdAt: toDate(row.created_at),
    lastUsedAt: toNullableDate(row.last_used_at),
    expiresAt: toDate(row.expires_at),
    revokedAt: toNullableDate(row.revoked_at),
    revokedReason: typeof row.revoked_reason === "string" ? row.revoked_reason as OAuthGrantRevocationReason : null,
    mfaVerifiedAt: toNullableDate(row.mfa_verified_at),
    assuranceExpiresAt: toNullableDate(row.assurance_expires_at),
  };
}

function toScopes(value: unknown): OAuthScope[] {
  const scopes = Array.isArray(value) ? value : [];
  return OAUTH_SCOPES.filter((scope) => scopes.includes(scope));
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}
