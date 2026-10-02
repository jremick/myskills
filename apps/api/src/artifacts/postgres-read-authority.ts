import { sql } from "drizzle-orm";
import { AppError } from "@myskills-app/core";
import type { DatabaseTransaction } from "../db/client.js";
import type { ArtifactDeliveryInput } from "../submissions/types.js";

/** Call inside one read-only authority snapshot. No credential usage write. */
export async function assertRegistryReadCredential(tx: DatabaseTransaction, input: Pick<ArtifactDeliveryInput, "actorId" | "credential">): Promise<void> {
      if (input.credential) {
        const { kind, tokenHash } = input.credential;
        const credential = kind === "session"
          ? sql`SELECT user_id, '[]'::jsonb AS scopes FROM auth_sessions WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > clock_timestamp()`
          : kind === "api_token"
            ? sql`SELECT user_id, scopes FROM api_tokens WHERE token_hash = ${tokenHash} AND revoked_at IS NULL AND expires_at > clock_timestamp()`
            : sql`SELECT g.user_id, t.scopes FROM oauth_access_tokens t JOIN oauth_grants g ON g.id = t.grant_id
                WHERE t.token_hash = ${tokenHash} AND t.revoked_at IS NULL AND g.revoked_at IS NULL
                AND t.expires_at > clock_timestamp() AND g.expires_at > clock_timestamp()
                AND g.resource = ${input.credential.resource ?? ""} AND g.client_id = ${input.credential.clientId ?? ""}`;
        const result = await tx.execute<{ scopes: string[] }>(sql`SELECT c.scopes FROM (${credential}) c JOIN users u ON u.id = c.user_id
          WHERE u.id = ${input.actorId} AND u.status = 'active' AND u.email_verified_at IS NOT NULL`);
        if (!result.rows[0]) throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
        if (kind !== "session" && !result.rows[0].scopes.includes("skills:read")) {
          throw new AppError("API token scope is required.", "API_TOKEN_SCOPE_REQUIRED", 403, { scope: "skills:read" });
        }
      } else if (input.actorId) {
        throw new AppError("Authentication is required.", "AUTHENTICATION_REQUIRED", 401);
      }
}
