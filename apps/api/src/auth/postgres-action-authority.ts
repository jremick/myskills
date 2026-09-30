import { sql } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import { hashSessionToken } from "@myskills-app/auth";
import type { AuthContext } from "./service.js";
import type { ApiTokenScope } from "./types.js";
import type { DatabaseTransaction } from "../db/client.js";
import type { SubmissionActor, ArtifactDeliveryInput } from "../submissions/types.js";

export function actionCredential(context: AuthContext, authorization: string): NonNullable<ArtifactDeliveryInput["credential"]> {
  return { kind: context.credential.kind, tokenHash: hashSessionToken(authorization.slice(7).trim()),
    ...(context.credential.kind === "oauth" ? { resource: context.credential.resource, clientId: context.credential.clientId } : {}) };
}

/** Retain account, credential and role authority. Recheck actual time after every lock wait. */
export async function assertActionAuthority(tx: DatabaseTransaction, actor: SubmissionActor, scopes: ApiTokenScope[], action: "author" | "review" | "read", options: { requireMfa?: boolean } = {}): Promise<void> {
  const account = await tx.execute(sql`SELECT id FROM users WHERE id=${actor.id}::uuid AND status='active' AND email_verified_at IS NOT NULL FOR SHARE`);
  if (!account.rows.length) throw unauthenticated();
  const identity = actor.credential;
  if (!identity) throw unauthenticated();
  const { kind, tokenHash } = identity;
  const record = kind === "session"
    ? sql`SELECT expires_at, revoked_at, mfa_verified_at, NULL AS assurance_expires_at, '[]'::jsonb AS scopes FROM auth_sessions WHERE user_id=${actor.id}::uuid AND token_hash=${tokenHash} FOR SHARE`
    : kind === "api_token"
      ? sql`SELECT expires_at, revoked_at, mfa_verified_at, NULL AS assurance_expires_at, scopes FROM api_tokens WHERE user_id=${actor.id}::uuid AND token_hash=${tokenHash} FOR SHARE`
      : sql`SELECT LEAST(t.expires_at,g.expires_at) AS expires_at, COALESCE(t.revoked_at,g.revoked_at) AS revoked_at, g.mfa_verified_at, g.assurance_expires_at, t.scopes
        FROM oauth_access_tokens t JOIN oauth_grants g ON g.id=t.grant_id WHERE g.user_id=${actor.id}::uuid AND t.token_hash=${tokenHash}
        AND g.resource=${identity.resource ?? ""} AND g.client_id=${identity.clientId ?? ""} FOR SHARE OF t,g`;
  const credentials = await tx.execute(record);
  const c = credentials.rows[0];
  if (!c || c.revoked_at || !Number.isFinite(timestamp(c.expires_at)) || timestamp(c.expires_at) <= Date.now()) throw unauthenticated();
  if (kind !== "session") for (const scope of scopes) {
    if (!(c.scopes as string[]).includes(scope)) throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope });
  }
  const roles = await tx.execute(sql`SELECT role FROM role_assignments WHERE user_id=${actor.id}::uuid AND scope_type='instance'
    AND scope_id='00000000-0000-0000-0000-000000000000'::uuid FOR SHARE`);
  const elevated = roles.rows.some(r => ["maintainer", "admin", "owner"].includes(String(r.role)));
  if (action === "author" && !elevated && !roles.rows.some(r => r.role === "author")) throw new AppError("Submission requires author permissions.", "SUBMISSION_ROLE_REQUIRED", 403);
  if (action === "review" && !elevated) throw new AppError("Review permissions are required.", "REVIEW_ROLE_REQUIRED", 403);
  // Existing author action contract requires MFA for elevated roles only.
  if (options.requireMfa || (action !== "read" && elevated)) {
    const verifiedAt = c.mfa_verified_at ? timestamp(c.mfa_verified_at) : NaN;
    const expiry = c.assurance_expires_at ? timestamp(c.assurance_expires_at) : NaN;
    if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() || (kind === "oauth" && (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > verifiedAt + 900_000))) {
      throw new AppError("MFA verification is required.", "MFA_VERIFICATION_REQUIRED", 403);
    }
  }
  if (timestamp(c.expires_at) <= Date.now()) throw unauthenticated();
}
function unauthenticated() { return new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401); }

function timestamp(value: unknown): number { return value instanceof Date ? value.getTime() : new Date(String(value)).getTime(); }
