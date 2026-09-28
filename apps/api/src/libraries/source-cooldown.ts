import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { SourceCooldownStore } from "./github-source.js";

/** Shared across workers and restarts; bucket names contain no credentials. */
export class PostgresSourceCooldownStore implements SourceCooldownStore {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<Date | null> {
    const result = await this.db.execute(sql`SELECT retry_available_at FROM github_source_cooldowns WHERE bucket = ${key}`);
    const value = result.rows[0]?.retry_available_at;
    return value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  }

  async extend(key: string, until: Date): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO github_source_cooldowns (bucket, retry_available_at) VALUES (${key}, ${until.toISOString()}::timestamptz)
      ON CONFLICT (bucket) DO UPDATE SET retry_available_at = greatest(github_source_cooldowns.retry_available_at, excluded.retry_available_at)
    `);
  }
}
