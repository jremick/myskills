import { createDb, createPgPool } from "./db/client.js";
import { PostgresSkillRepository } from "./repositories/postgres-skill-repository.js";
import { buildApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const pool = createPgPool();
const db = createDb(pool);
const app = buildApp({
  skillRepository: new PostgresSkillRepository(db),
  logger: process.env.NODE_ENV !== "test",
});

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

