import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const DEFAULT_DEV_DATABASE_URL = "postgres://ai_skills_share:ai_skills_share_dev@localhost:5432/ai_skills_share";

export function createPgPool(databaseUrl = requiredDatabaseUrl()): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export function createDb(pool = createPgPool()) {
  return drizzle(pool, { schema });
}

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value) {
    return value;
  }
  if (process.env.NODE_ENV !== "production") {
    return DEFAULT_DEV_DATABASE_URL;
  }
  throw new Error("DATABASE_URL is required.");
}

export type Database = ReturnType<typeof createDb>;
