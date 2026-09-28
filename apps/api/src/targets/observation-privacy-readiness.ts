import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

/** Keep slug capability disabled until its forward migration is recorded. */
export function createPostgresObservationPrivacyReadinessProbe(db: Pick<Database, "execute">): () => Promise<void> {
  return async () => {
    const result = await db.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM schema_migrations WHERE id = '0034_observation_slug_privacy'
      ) AS present
    `);
    if (result.rows[0]?.present !== true) throw new Error("Observation privacy migration is missing.");
  };
}
