import { isIP } from "node:net";
import { LIBRARY_LIMITS } from "@myskills-app/core";
import { createDb, createPgPool } from "./db/client.js";
import { createArtifactObjectStorageFromEnv } from "./artifacts/storage.js";
import { PostgresAuthRateLimiter } from "./auth/rate-limit.js";
import { createAuthNotificationSinkFromEnv } from "./auth/notification.js";
import { AuthNotificationWorker } from "./auth/notification-outbox.js";
import { AuthService } from "./auth/service.js";
import { PostgresAuthStore } from "./auth/postgres-auth-store.js";
import { PostgresSkillRepository } from "./repositories/postgres-skill-repository.js";
import { buildApp } from "./app.js";
import { SubmissionService } from "./submissions/service.js";
import { PostgresSubmissionStore } from "./submissions/postgres-submission-store.js";
import { TeamService } from "./teams/service.js";
import { PostgresTeamStore } from "./teams/postgres-team-store.js";
import { OrganizationService } from "./organizations/service.js";
import { PostgresOrganizationStore } from "./organizations/postgres-organization-store.js";
import {
  createPostgresArchitectureReadinessProbe,
  PostgresArchitectureStore,
} from "./architectures/postgres-store.js";
import { PostgresArchitectureOrganizationGrantStore } from "./architectures/postgres-organization-grant-store.js";
import { ArchitectureOrganizationGrantService } from "./architectures/organization-grant-service.js";
import { PostgresPatternMigrationStore } from "./architectures/postgres-pattern-migration-store.js";
import { ArchitecturePatternMigrationService } from "./architectures/pattern-migration-service.js";
import { createExactArchitectureReleaseAuthorizer } from "./architectures/exact-release-authorizer.js";
import { ArchitectureTargetBindingAuthorizer } from "./targets/architecture-binding-authorizer.js";
import { PostgresArchitectureTargetStore } from "./targets/postgres-target-store.js";
import { ArchitectureTargetService } from "./targets/service.js";
import { PostgresTargetSkillOperationStore } from "./target-operations/postgres-store.js";
import { TargetSkillOperationService } from "./target-operations/service.js";
import { PostgresSkillUpgradePolicyStore } from "./upgrade-policies/postgres-store.js";
import { SkillUpgradePolicyService } from "./upgrade-policies/service.js";
import { PublicGithubSourceProvider } from "./libraries/github-source.js";
import { PostgresLibraryStore } from "./libraries/postgres-store.js";
import { LibraryService } from "./libraries/service.js";
import { LibrarySourceWorker } from "./libraries/worker.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const pool = createPgPool();
const db = createDb(pool);
const instanceIdentity = await pool.query<{ value: string }>(
  "SELECT value FROM instance_settings WHERE key = 'instance_id'",
);
const registryInstanceId = instanceIdentity.rows[0]?.value;
if (!registryInstanceId || !/^[a-f0-9-]{36}$/.test(registryInstanceId)) {
  throw new Error("Registry instance identity is unavailable. Apply database migrations before starting the API.");
}
const artifactStorage = createArtifactObjectStorageFromEnv(process.env);
const submissionStore = new PostgresSubmissionStore(db, { artifactStorage });
await submissionStore.reconcilePendingArtifactWrites();
const teamStore = new PostgresTeamStore(db);
const teamService = new TeamService(teamStore);
const organizationStore = new PostgresOrganizationStore(db);
const organizationService = new OrganizationService(organizationStore, teamService);
const architectureStore = new PostgresArchitectureStore(db);
const skillRepository = new PostgresSkillRepository(db);
const submissionService = new SubmissionService(submissionStore);
const exactReleaseAuthorizer = createExactArchitectureReleaseAuthorizer({
  skillRepository,
  submissionService,
});
const architectureOrganizationGrantStore = new PostgresArchitectureOrganizationGrantStore(db);
const architectureOrganizationGrantService = new ArchitectureOrganizationGrantService({
  architectureStore,
  organizationStore,
  grantStore: architectureOrganizationGrantStore,
  releaseAuthorizer: exactReleaseAuthorizer,
  sharingSettingsProvider: skillRepository,
  teamStore,
});
const patternMigrationStore = new PostgresPatternMigrationStore(db);
const patternMigrationService = new ArchitecturePatternMigrationService(
  architectureStore,
  patternMigrationStore,
  { releaseAuthorizer: exactReleaseAuthorizer },
);
const architectureTargetStore = new PostgresArchitectureTargetStore(db);
const architectureTargetService = new ArchitectureTargetService(
  architectureTargetStore,
  new ArchitectureTargetBindingAuthorizer(architectureStore, organizationStore),
);
const skillUpgradePolicyService = new SkillUpgradePolicyService(new PostgresSkillUpgradePolicyStore(db));
// Production always uses the fixed-host HTTPS transport; there is no fetch override.
const libraryService = new LibraryService({
  store: new PostgresLibraryStore(db),
  submissions: submissionService,
  skillRepository,
  targets: architectureTargetService,
  sourceProvider: new PublicGithubSourceProvider(),
});
const targetSkillOperationService = new TargetSkillOperationService(
  new PostgresTargetSkillOperationStore(db),
  architectureTargetService,
  submissionService,
  { upgradePolicies: skillUpgradePolicyService, libraryAdoptions: libraryService },
);
const authStore = new PostgresAuthStore(db);
const authSecret = requiredAuthSecret();
const notificationSink = createAuthNotificationSinkFromEnv(process.env);
const app = buildApp({
  skillRepository,
  registryInstanceId,
  authService: new AuthService(authStore, {
    mfaSecretKey: authSecret,
    totpIssuer: process.env.TOTP_ISSUER ?? "MySkills",
    loginLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 10, windowMs: 15 * 60 * 1000 }),
    registrationLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    mfaLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    emailVerificationLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    passwordResetLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 5, windowMs: 15 * 60 * 1000 }),
    authActionTokenLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 10, windowMs: 15 * 60 * 1000 }),
    notificationSink,
  }),
  submissionService,
  teamService,
  organizationService,
  architectureStore,
  architectureOrganizationGrantService,
  architecturePatternMigrationService: patternMigrationService,
  architectureTargetService,
  targetSkillOperationService,
  skillUpgradePolicyService,
  libraryService,
  allowedOrigins: allowedOrigins(),
  trustProxy: trustProxy(),
  requestLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 600, windowMs: 60_000 }),
  architectureProjectionLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: 30, windowMs: 60_000 }),
  librarySourceLimiter: new PostgresAuthRateLimiter(pool, { maxAttempts: LIBRARY_LIMITS.maxSourceOperationsPerHour, windowMs: 60 * 60 * 1000 }),
  readinessProbes: {
    postgres: async () => {
      await pool.query("SELECT 1");
    },
    phase2Architecture: createPostgresArchitectureReadinessProbe(db),
    artifactStorageRequired: Boolean(artifactStorage),
    artifactStorage: artifactStorage ? () => artifactStorage.checkReady() : undefined,
  },
  logger: process.env.NODE_ENV !== "test",
});
const authNotificationWorker = notificationSink ? new AuthNotificationWorker(authStore, notificationSink, {
  secret: authSecret,
  onError: () => app.log.error("Auth notification dispatch failed; pending intents will be retried."),
}) : undefined;
const artifactReconciliationTimer = artifactStorage
  ? setInterval(() => {
      void submissionStore.reconcilePendingArtifactWrites().then(({ retained }) => {
        if (retained > 0) {
          app.log.warn({ retained }, "Artifact recovery intents remain pending.");
        }
      }).catch((error: unknown) => {
        app.log.error({ err: error }, "Artifact recovery reconciliation failed.");
      });
    }, 15 * 60 * 1000)
  : undefined;
artifactReconciliationTimer?.unref();
// Scheduled source checks use Postgres leases, so several API processes may run it.
const librarySourceWorker = process.env.LIBRARY_SOURCE_WORKER?.trim() === "disabled"
  ? undefined
  : new LibrarySourceWorker(libraryService, {
    onError: () => app.log.error("Library source check failed; due checks will be retried."),
  });

try {
  await app.listen({ port, host });
  authNotificationWorker?.start();
  librarySourceWorker?.start();
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

let shutdownPromise: Promise<void> | undefined;
const shutdown = () => shutdownPromise ??= (async () => {
  if (artifactReconciliationTimer) {
    clearInterval(artifactReconciliationTimer);
  }
  await authNotificationWorker?.stop();
  await librarySourceWorker?.stop();
  await app.close();
  await pool.end();
})();

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

function trustProxy(): Parameters<typeof buildApp>[0]["trustProxy"] {
  const configured = process.env.TRUST_PROXY?.trim();
  if (!configured || configured === "false") {
    return undefined;
  }
  if (configured === "true") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TRUST_PROXY=true is too broad for production. Use a proxy address list.");
    }
    return true;
  }
  if (/^[1-9]\d*$/.test(configured)) {
    throw new Error("TRUST_PROXY numeric hop counts are unsafe. Use a comma-separated IP/CIDR proxy address list.");
  }
  const entries = configured.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !isValidProxyAddress(entry))) {
    throw new Error("TRUST_PROXY must be false or a comma-separated IP/CIDR proxy address list.");
  }
  return entries;
}

function isValidProxyAddress(entry: string): boolean {
  const [address, prefix, extra] = entry.split("/");
  if (!address || extra !== undefined) {
    return false;
  }
  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d+$/.test(prefix)) {
    return false;
  }
  const prefixLength = Number.parseInt(prefix, 10);
  return prefixLength >= 0 && prefixLength <= (version === 4 ? 32 : 128);
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
