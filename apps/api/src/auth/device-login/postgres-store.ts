import { sql } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../db/client.js";
import { DEVICE_LOGIN_MAX_REQUESTS, deviceRequiresMfa, freshDeviceMfa, pollDeviceRequest, type DeviceLoginRequest, type DeviceLoginStore, type DeviceDecision, type DevicePoll } from "./types.js";

type Row = Record<string, unknown>;
export class PostgresDeviceLoginStore implements DeviceLoginStore {
  constructor(private readonly db: Database) {}
  async create(request: DeviceLoginRequest, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('myskills-device-login-admission'))`);
      await tx.execute(sql`DELETE FROM device_login_requests WHERE id IN (SELECT id FROM device_login_requests WHERE expires_at <= ${now} ORDER BY expires_at LIMIT 1000)`);
      const count = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM device_login_requests`);
      if (count.rows[0]!.count >= DEVICE_LOGIN_MAX_REQUESTS) return false;
      const result = await tx.execute(sql`INSERT INTO device_login_requests (device_code_hash, user_code_hash, scopes, expires_at, created_at)
        VALUES (${request.deviceCodeHash}, ${request.userCodeHash}, ${JSON.stringify(request.scopes)}::jsonb, ${request.expiresAt}, ${now}) ON CONFLICT DO NOTHING RETURNING id`);
      return result.rows.length === 1;
    });
  }
  async find(userCodeHash: string): Promise<DeviceLoginRequest | null> {
    const result = await this.db.execute<Row>(sql`SELECT * FROM device_login_requests WHERE user_code_hash = ${userCodeHash}`);
    return result.rows[0] ? toRequest(result.rows[0]) : null;
  }
  async decide(input: Parameters<DeviceLoginStore["decide"]>[0]): Promise<DeviceDecision> {
    return this.db.transaction(async (tx) => {
      // Match existing security actions: account → credential → request.
      const account = await lockAccount(tx, input.userId);
      if (!account || !await activeSession(tx, input.sessionTokenHash, input.userId, input.now)) return "session_revoked";
      const result = await tx.execute<Row>(sql`SELECT * FROM device_login_requests WHERE user_code_hash = ${input.userCodeHash} FOR UPDATE`);
      if (!result.rows[0]) return "invalid";
      const request = toRequest(result.rows[0]);
      if (request.expiresAt <= input.now) return "invalid";
      if (request.status !== "pending") return "already_decided";
      const session = await activeSession(tx, input.sessionTokenHash, input.userId, input.now);
      const stamp = session?.mfa_verified_at ? new Date(String(session.mfa_verified_at)) : null;
      if (input.decision === "approve" && deviceRequiresMfa(request.scopes, account.roles) && !freshDeviceMfa(stamp, input.now)) return "mfa_required";
      const status = input.decision === "approve" ? "approved" : "denied";
      await tx.execute(sql`UPDATE device_login_requests SET status = ${status}, user_id = ${input.userId}, session_token_hash = ${input.sessionTokenHash}, mfa_verified_at = ${freshDeviceMfa(stamp, input.now) ? stamp : null} WHERE user_code_hash = ${input.userCodeHash}`);
      await audit(tx, input.userId, status);
      return status;
    });
  }
  async poll(input: Parameters<DeviceLoginStore["poll"]>[0]): Promise<DevicePoll> {
    // This first read selects lock order only; the locked row below decides.
    const initial = await this.db.execute<Row>(sql`SELECT user_id, session_token_hash FROM device_login_requests WHERE device_code_hash = ${input.deviceCodeHash}`);
    const userId = initial.rows[0]?.user_id as string | undefined;
    return this.db.transaction(async (tx) => {
      const account = userId ? await lockAccount(tx, userId) : null;
      const sessionHash = initial.rows[0]?.session_token_hash as string | undefined;
      const session = account && sessionHash ? await activeSession(tx, sessionHash, userId!, input.now) : null;
      const result = await tx.execute<Row>(sql`SELECT * FROM device_login_requests WHERE device_code_hash = ${input.deviceCodeHash} FOR UPDATE`);
      if (!result.rows[0]) return { status: "invalid" };
      const request = toRequest(result.rows[0]);
      // Approval may have won after the initial read. Retry on the next poll
      // rather than acquiring account locks behind a locked request.
      if (request.status === "approved" && request.userId !== (userId ?? null)) return { status: "pending", interval: request.interval };
      const transition = pollDeviceRequest(request, input.now);
      await tx.execute(sql`UPDATE device_login_requests SET last_polled_at = ${request.lastPolledAt}, interval_seconds = ${request.interval} WHERE device_code_hash = ${input.deviceCodeHash}`);
      if (transition) return transition;
      if (!account || !session || (deviceRequiresMfa(request.scopes, account.roles) && !freshDeviceMfa(request.mfaVerifiedAt, input.now))) {
        await tx.execute(sql`UPDATE device_login_requests SET status = 'denied' WHERE device_code_hash = ${input.deviceCodeHash}`);
        return { status: "denied" };
      }
      const token = await tx.execute<{ id: string }>(sql`INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at, mfa_verified_at)
        VALUES (${userId!}, ${input.token.name}, ${input.token.tokenPrefix}, ${input.token.tokenHash}, ${JSON.stringify(request.scopes)}::jsonb, ${input.token.expiresAt}, ${request.mfaVerifiedAt}) RETURNING id`);
      await tx.execute(sql`UPDATE device_login_requests SET status = 'consumed' WHERE device_code_hash = ${input.deviceCodeHash}`);
      await audit(tx, userId!, "redeemed");
      return { status: "authorized", tokenId: token.rows[0]!.id, email: account.email, expiresAt: input.token.expiresAt };
    });
  }
}
async function lockAccount(tx: DatabaseTransaction, id: string): Promise<{ email: string; roles: string[] } | null> {
  const result = await tx.execute<Row>(sql`SELECT email, status, email_verified_at FROM users WHERE id = ${id} FOR UPDATE`);
  const row = result.rows[0];
  if (!row || row.status !== "active" || !row.email_verified_at) return null;
  const roles = await tx.execute<{ role: string }>(sql`SELECT role FROM role_assignments WHERE user_id = ${id} AND scope_type = 'instance'`);
  return { email: String(row.email), roles: roles.rows.map((r) => r.role) };
}
async function activeSession(tx: DatabaseTransaction, hash: string, userId: string, now: Date) {
  const result = await tx.execute<Row>(sql`SELECT mfa_verified_at FROM auth_sessions WHERE token_hash = ${hash} AND user_id = ${userId} AND revoked_at IS NULL AND expires_at > ${now} FOR UPDATE`);
  return result.rows[0] ?? null;
}
async function audit(tx: DatabaseTransaction, userId: string, action: string) {
  await tx.execute(sql`INSERT INTO audit_events (actor_user_id, action, decision, resource_type, details) VALUES (${userId}, ${`auth.device.${action}`}, 'allow', 'device_login', '{}'::jsonb)`);
}
function toRequest(row: Row): DeviceLoginRequest {
  return { deviceCodeHash: String(row.device_code_hash), userCodeHash: String(row.user_code_hash), scopes: row.scopes as DeviceLoginRequest["scopes"], status: row.status as DeviceLoginRequest["status"],
    expiresAt: new Date(String(row.expires_at)), interval: Number(row.interval_seconds), lastPolledAt: row.last_polled_at ? new Date(String(row.last_polled_at)) : null,
    userId: row.user_id ? String(row.user_id) : null, sessionTokenHash: row.session_token_hash ? String(row.session_token_hash) : null, mfaVerifiedAt: row.mfa_verified_at ? new Date(String(row.mfa_verified_at)) : null };
}
