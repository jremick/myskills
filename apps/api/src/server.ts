import { createDb, createPgPool } from "./db/client.js";
import { createArtifactObjectStorageFromEnv } from "./artifacts/storage.js";
import { PostgresAuthRateLimiter } from "./auth/rate-limit.js";
import { createAuthNotificationSinkFromEnv } from "./auth/notification.js";
import { AuthService } from "./auth/service.js";
import { PostgresAuthStore } from "./auth/postgres-auth-store.js";
import { PostgresSkillRepository } from "./repositories/postgres-skill-repository.js";
import { buildApp } from "./app.js";
import { SubmissionService } from "./submissions/service.js";
import { PostgresSubmissionStore } from "./submissions/postgres-submission-store.js";
import { TeamService } from "./teams/service.js";
import { PostgresTeamStore } from "./teams/postgres-team-store.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const pool = createPgPool();
const db = createDb(pool);
const app = buildApp({
  skillRepository: new PostgresSkillRepository(db),
  authService: new AuthService(new PostgresAuthStore(db), {
    mfaSecretKey: requiredAuthSecret(),
    totpIssuer: process.env.TOTP_ISSUER ?? "MySkills",
    loginLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 10, windowMs: 15 * 60 * 1000 }),
    registrationLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    mfaLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    emailVerificationLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    passwordResetLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    authActionTokenLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 10, windowMs: 15 * 60 * 1000 }),
    notificationSink: createAuthNotificationSinkFromEnv(process.env),
  }),
  submissionService: new SubmissionService(new PostgresSubmissionStore(db, {
    artifactStorage: createArtifactObjectStorageFromEnv(process.env),
  })),
  teamService: new TeamService(new PostgresTeamStore(db)),
  allowedOrigins: allowedOrigins(),
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

function allowedOrigins(): string[] {
  const configured = process.env.ALLOWED_WEB_ORIGINS ?? process.env.APP_BASE_URL;
  return configured
    ? configured.split(",").map((origin) => origin.trim()).filter(Boolean)
    : ["http://localhost:3000", "http://127.0.0.1:3000"];
}

function requiredAuthSecret(): string {
  const value = process.env.AUTH_SECRET;
  if (value && Buffer.byteLength(value, "utf8") >= 32) {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be set to at least 32 bytes in production.");
  }
  return "dev-only-myskills-app-auth-secret-change-before-production";
}
